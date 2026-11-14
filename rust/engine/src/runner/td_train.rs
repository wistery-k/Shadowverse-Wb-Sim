//! 補正の学習 `svwb td train` と間引き `svwb td prune`（TypeScript 版 scripts/td-main.ts の train・prune を移したもの）。
//!
//!   svwb td train --model m0.json --data d0.jsonl[,d1.jsonl.gz] --out m1.json [--lambda 0.7] [--epochs 2] [--lr 0.001] [--l2 0.0001]
//!     [--batch 128] [--holdout 0.1] [--fitA 1] [--seed 1] [--ivWeight 1] [--imaginedWeight 1] [--ivRes 1] [--best 0] [--bestOn end,after]
//!     [--base default|zero|search] [--excludeDecks <デッキ>,…|--onlyDecks <デッキ>,…] [--dropInputs <入力>,…]
//!   svwb td prune --model m.json --data d0.jsonl[,…] --out mp.json [--excludeDecks …|--onlyDecks …]
//!
//! 移したのは学び直しの流れ（night/relearn-b.txt）が使う引数だけ。実験用の引数（--attr・--cmpWeight・--v1Only・--searchTarget・--seat・--exclude 等）と
//! 場のカードのネットワークを持つモデルは扱わず、エラーにする（TypeScript 版 `npm run td -- train` で）。属性の分（attr）を持つモデルの間引きも TypeScript 版で。
//!
//! **TypeScript 版と同じ重みになる**ように書いてある（同じデータ・同じ引数で、書き出すモデルのファイルが同じになる。docs/ai-notes/13-2026-11-13.md
//! 「補正の学習を Rust に移す」）: 足し算の順番は TypeScript 版のまま、`exp`・`log`・`**` は V8 と同じ値を返すもの（crate::jsmath）、
//! ミニバッチの並べ替えの乱数も同じ、書き出す数の丸め（`toPrecision(6)`）と書き方も同じ。
//!
//! 速くするための作りで、結果は変わらない:
//! - ミニバッチの局面ごとの前向きの計算と、出力から最初の隠れ層までの逆伝播（勾配を足す前まで）を、スレッドに分けて並べる
//! - 勾配を足して Adam で更新するのは、重みの行ごとにスレッドに分ける（1 つの重みの勾配は、局面の順に足す。TypeScript 版と同じ順）
//! - 最初の層の行（入力ごと）の Adam は、その行がミニバッチに出たときと、全局面の予測の前にまとめて行う。出ないミニバッチでは勾配が 0 で、
//!   TypeScript 版も更新の式を毎回当てているので、その回の分を同じ式・同じ順で後から当てる（重みの値は同じ。メモリを読む量が減り、行ごとに並べられる）

use super::fixed;
use super::parallel::{parallel_map, thread_count};
use super::td_data::{
    js_to_uint32, load_data, used_inputs, Dataset, IvPair, IvZone, Layer, LoadOptions, NetModel,
    SSource, F_EXPLORED, F_HOLDOUT, F_IV,
};
use crate::ai::aidata::AI_DATA_JSON;
use crate::data::data;
use crate::jsmath;
use crate::jsnum::round_precision;
use crate::json::Json;
use crate::state::next_random;
use std::sync::{Barrier, RwLock};
use std::time::Instant;

type Args = [(String, String)];

/// Rust 版の td train が扱う引数（学び直しの流れが使うものと、学習の基本の --batch・--fitA）
const TRAIN_ARGS: [&str; 20] = [
    "model",
    "data",
    "out",
    "lambda",
    "epochs",
    "lr",
    "l2",
    "batch",
    "holdout",
    "fitA",
    "seed",
    "ivWeight",
    "imaginedWeight",
    "ivRes",
    "best",
    "bestOn",
    "base",
    "excludeDecks",
    "onlyDecks",
    "dropInputs",
];

const PRUNE_ARGS: [&str; 5] = ["model", "data", "out", "excludeDecks", "onlyDecks"];

const BETA1: f64 = 0.9;
const BETA2: f64 = 0.999;

fn arg<'a>(args: &'a Args, k: &str) -> Option<&'a str> {
    // 同じ引数が 2 回あれば後のもの（TypeScript 版の Map）
    args.iter()
        .rev()
        .find(|(x, _)| x == k)
        .map(|(_, v)| v.as_str())
}

fn need<'a>(args: &'a Args, k: &str) -> Result<&'a str, String> {
    arg(args, k).ok_or_else(|| format!("--{k} がありません"))
}

fn num_arg(args: &Args, k: &str, def: f64) -> Result<f64, String> {
    match arg(args, k) {
        None => Ok(def),
        Some(v) => v
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|x| x.is_finite())
            .ok_or_else(|| format!("--{k} は数: {v}")),
    }
}

/// 0 以上（min 以上）の整数の引数
fn int_arg(args: &Args, k: &str, def: usize, min: usize) -> Result<usize, String> {
    let x = num_arg(args, k, def as f64)?;
    if x.fract() != 0.0 || x < min as f64 {
        return Err(format!("--{k} は {min} 以上の整数: {x}"));
    }
    Ok(x as usize)
}

/// 知らない引数（実験用の引数は TypeScript 版に残した）をエラーにする
fn check_known(args: &Args, known: &[&str], cmd: &str) -> Result<(), String> {
    for (k, _) in args {
        if !known.contains(&k.as_str()) {
            return Err(format!(
                "--{k} は Rust 版の td {cmd} にありません（Rust 版は学び直しの流れが使う引数だけ。ほかは TypeScript 版の npm run td -- {cmd} で）"
            ));
        }
    }
    Ok(())
}

// ---- 出発点の評価（baseWeights） ----

/// DEFAULT_WEIGHTS（src/ai/data.ts。項目の順番も同じ）
fn default_weights() -> Json {
    Json::parse(AI_DATA_JSON)
        .ok()
        .and_then(|j| j.get("defaultWeights").cloned())
        .expect("ai-data.json の defaultWeights")
}

/// train --base default の baseWeights（td-main.ts の DEFAULT_BASE）
fn default_base() -> Json {
    default_weights().spread(&Json::Obj(vec![("hold".into(), Json::Obj(vec![]))]))
}

/// train --base zero の baseWeights（td-main.ts の ZERO_BASE）
fn zero_base() -> Json {
    match default_weights() {
        Json::Obj(items) => Json::Obj(
            items
                .into_iter()
                .map(|(k, v)| {
                    (
                        k,
                        if matches!(v, Json::Num(_)) {
                            Json::Num(0.0)
                        } else {
                            Json::Obj(vec![])
                        },
                    )
                })
                .collect(),
        ),
        _ => panic!("defaultWeights がオブジェクトではありません"),
    }
}

/// 2 つの重みの JSON が同じ項目・同じ値か（td-main.ts の sameWeights）
fn same_weights(a: &Json, b: &Json) -> bool {
    let (Json::Obj(ia), Json::Obj(ib)) = (a, b) else {
        return false;
    };
    let mut ka: Vec<&String> = ia.iter().map(|(k, _)| k).collect();
    let mut kb: Vec<&String> = ib.iter().map(|(k, _)| k).collect();
    ka.sort();
    kb.sort();
    ka == kb
        && ka
            .iter()
            .all(|k| a.get(k).map(Json::stringify) == b.get(k).map(Json::stringify))
}

/// 出発点の評価 S をどこから読むか（td-main.ts の sSourceOf）
fn s_source_of(base_weights: &Json) -> SSource {
    if same_weights(base_weights, &zero_base()) {
        SSource::Zero
    } else if same_weights(base_weights, &default_base()) {
        SSource::Sd
    } else {
        SSource::S
    }
}

// ---- デッキで試合を選ぶ ----

type SkipGame = Box<dyn Fn(&[String; 2]) -> bool + Sync>;

/// --excludeDecks・--onlyDecks（td-main.ts の deckFilter）
fn deck_filter(args: &Args) -> Result<Option<SkipGame>, String> {
    let list = |k: &str| -> Result<Option<Vec<String>>, String> {
        let Some(v) = arg(args, k) else {
            return Ok(None);
        };
        let names: Vec<String> = v
            .split(',')
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect();
        let known: Vec<&str> = data().decks.iter().map(|d| d.name.as_str()).collect();
        let bad: Vec<&str> = names
            .iter()
            .filter(|x| !known.contains(&x.as_str()))
            .map(|x| x.as_str())
            .collect();
        if names.is_empty() || !bad.is_empty() {
            let shown = if bad.is_empty() {
                v.to_string()
            } else {
                bad.join(", ")
            };
            return Err(format!(
                "--{k} はデフォルトデッキの名前をカンマで並べます: {shown}"
            ));
        }
        Ok(Some(names))
    };
    let ex = list("excludeDecks")?;
    let only = list("onlyDecks")?;
    match (ex, only) {
        (Some(_), Some(_)) => Err("--excludeDecks と --onlyDecks は一緒に使えません".into()),
        (Some(ex), None) => Ok(Some(Box::new(move |d: &[String; 2]| {
            d.iter().any(|x| ex.contains(x))
        }))),
        (None, Some(only)) => Ok(Some(Box::new(move |d: &[String; 2]| {
            !d.iter().any(|x| only.contains(x))
        }))),
        (None, None) => Ok(None),
    }
}

// ---- 数の計算（TypeScript 版と同じ式・同じ順） ----

#[inline]
fn sigmoid(z: f64) -> f64 {
    1.0 / (1.0 + jsmath::exp(-z))
}

fn bce(p: f64, y: f64) -> f64 {
    let q = (1.0 - 1e-9f64).min(1e-9f64.max(p));
    -(y * jsmath::log(q) + (1.0 - y) * jsmath::log(1.0 - q))
}

/// Adam の 1 回の更新（重みは減衰させる。td-main.ts の train の Adam の式のまま）
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn adam1(
    p: &mut f64,
    m1: &mut f64,
    m2: &mut f64,
    g: f64,
    decay_coef: f64,
    lr: f64,
    c1: f64,
    c2: f64,
) {
    *m1 = BETA1 * *m1 + (1.0 - BETA1) * g;
    *m2 = BETA2 * *m2 + (1.0 - BETA2) * g * g;
    let decay = decay_coef * *p;
    *p -= lr * ((*m1 / c1) / ((*m2 / c2).sqrt() + 1e-8) + decay);
}

/// 重みの行の集まり（幅 w の行を local の番号で並べたもの。p は重み、g は勾配）
struct Rows {
    w: usize,
    p: Vec<f64>,
    m1: Vec<f64>,
    m2: Vec<f64>,
    g: Vec<f64>,
}

impl Rows {
    fn new(w: usize, n: usize) -> Rows {
        Rows {
            w,
            p: vec![0.0; w * n],
            m1: vec![0.0; w * n],
            m2: vec![0.0; w * n],
            g: vec![0.0; w * n],
        }
    }

    /// 行 l を勾配 g で 1 回更新し、勾配を 0 に戻す
    fn adam_row(&mut self, l: usize, decay: f64, lr: f64, c: (f64, f64)) {
        let r = l * self.w..(l + 1) * self.w;
        let (p, m1, m2, g) = (
            &mut self.p[r.clone()],
            &mut self.m1[r.clone()],
            &mut self.m2[r.clone()],
            &mut self.g[r],
        );
        for j in 0..p.len() {
            adam1(&mut p[j], &mut m1[j], &mut m2[j], g[j], decay, lr, c.0, c.1);
            g[j] = 0.0;
        }
    }

    /// 行 l に、勾配 0 の更新を from+1〜to 回目の分だけ当てる（その回のミニバッチに出なかった行）
    fn replay_row(&mut self, l: usize, from: u32, to: u32, decay: f64, lr: f64, cs: &[(f64, f64)]) {
        let r = l * self.w..(l + 1) * self.w;
        let (p, m1, m2) = (
            &mut self.p[r.clone()],
            &mut self.m1[r.clone()],
            &mut self.m2[r],
        );
        for &(c1, c2) in &cs[from as usize + 1..=to as usize] {
            for j in 0..p.len() {
                adam1(&mut p[j], &mut m1[j], &mut m2[j], 0.0, decay, lr, c1, c2);
            }
        }
    }
}

/// スレッド 1 つが受け持つ重み: 最初の層の行（入力 r = tid + T × l）と、足した層の行（その層の入力 i = tid + T × l）
struct Part {
    w1: Rows,
    /// 最初の層の行に当てた更新の回数（ミニバッチの通し番号）
    last: Vec<u32>,
    stamp: Vec<u32>,
    touched: Vec<usize>,
    /// 読んだ局面に出た行（学ぶ行）
    seen: Vec<usize>,
    layers: Vec<Rows>,
}

/// 毎回更新する重み: [b1 | 足した層の b… | w2 | b2 | c | a]（スレッド 0 が受け持つ）
struct Dense {
    r: Rows,
    decay: Vec<f64>,
}

/// ミニバッチの局面ごとの値（前向きの各層の値と逆伝播の値、出力の勾配など）
struct Slot<'a> {
    acts: &'a [f64],
    dacts: &'a [f64],
    dz: f64,
    s: f64,
    loss: f64,
}

/// ネットワークの形と、重みの場所
struct Shape {
    t: usize,
    h: usize,
    sizes: Vec<usize>,
    /// acts・dacts の中の各層の始まり
    act_off: Vec<usize>,
    act_len: usize,
    /// Dense の中の場所
    o_lb: Vec<usize>,
    o_w2: usize,
    o_b2: usize,
    o_c: usize,
    o_a: usize,
}

impl Shape {
    fn slot_len(&self) -> usize {
        2 * self.act_len + 3
    }
}

/// 読むための重み（全部のスレッドの受け持ちの読み取りの鍵）
struct View<'a> {
    shape: &'a Shape,
    parts: Vec<std::sync::RwLockReadGuard<'a, Part>>,
    dense: std::sync::RwLockReadGuard<'a, Dense>,
}

impl View<'_> {
    #[inline]
    fn w1_row(&self, r: usize) -> &[f64] {
        let (t, h) = (self.shape.t, self.shape.h);
        let l = r / t;
        &self.parts[r % t].w1.p[l * h..(l + 1) * h]
    }

    #[inline]
    fn layer_row(&self, k: usize, i: usize) -> &[f64] {
        let t = self.shape.t;
        let rows = &self.parts[i % t].layers[k];
        let l = i / t;
        &rows.p[l * rows.w..(l + 1) * rows.w]
    }

    fn d(&self, o: usize) -> f64 {
        self.dense.r.p[o]
    }

    /// 前向きの計算（td-main.ts の forwardAt・forwardRest）。acts に各隠れ層の値（ReLU の後）を書き、NN の出力を返す
    fn forward(&self, inputs: &[(usize, f64)], acts: &mut [f64]) -> f64 {
        let sh = self.shape;
        let h = sh.h;
        {
            let h0 = &mut acts[..h];
            h0.copy_from_slice(&self.dense.r.p[..h]);
            for &(r, x) in inputs {
                let row = self.w1_row(r);
                for j in 0..h {
                    h0[j] += x * row[j];
                }
            }
            for v in h0.iter_mut() {
                if *v < 0.0 {
                    *v = 0.0;
                }
            }
        }
        for k in 1..sh.sizes.len() {
            let (lo, hi) = acts.split_at_mut(sh.act_off[k]);
            let hin = &lo[sh.act_off[k - 1]..];
            let m = sh.sizes[k];
            let out = &mut hi[..m];
            out.copy_from_slice(&self.dense.r.p[sh.o_lb[k - 1]..sh.o_lb[k - 1] + m]);
            for (i, &x) in hin.iter().enumerate() {
                if x == 0.0 {
                    continue;
                }
                let row = self.layer_row(k - 1, i);
                for j in 0..m {
                    out[j] += x * row[j];
                }
            }
            for v in out.iter_mut() {
                if *v < 0.0 {
                    *v = 0.0;
                }
            }
        }
        let last = sh.sizes.len() - 1;
        let hl = &acts[sh.act_off[last]..sh.act_off[last] + sh.sizes[last]];
        let mut z = self.d(sh.o_b2);
        for (j, &x) in hl.iter().enumerate() {
            z += x * self.d(sh.o_w2 + j);
        }
        z
    }

    /// 出力の勾配 dz から、各隠れ層の値の勾配を dacts に書く（td-main.ts の backward の、勾配を足す前の分）
    fn deltas(&self, dz: f64, acts: &[f64], dacts: &mut [f64]) {
        let sh = self.shape;
        let l = sh.sizes.len() - 1;
        {
            let (o, m) = (sh.act_off[l], sh.sizes[l]);
            for j in 0..m {
                dacts[o + j] = if acts[o + j] > 0.0 {
                    dz * self.d(sh.o_w2 + j)
                } else {
                    0.0
                };
            }
        }
        for k in (1..sh.sizes.len()).rev() {
            let m = sh.sizes[k];
            let (lo, hi) = dacts.split_at_mut(sh.act_off[k]);
            let dout = &hi[..m];
            let din = &mut lo[sh.act_off[k - 1]..];
            let hin = &acts[sh.act_off[k - 1]..sh.act_off[k - 1] + sh.sizes[k - 1]];
            for (r, &x) in hin.iter().enumerate() {
                if x <= 0.0 {
                    din[r] = 0.0;
                    continue;
                }
                let row = self.layer_row(k - 1, r);
                let mut back = 0.0;
                for j in 0..m {
                    back += row[j] * dout[j];
                }
                din[r] = back;
            }
        }
    }
}

/// 学習の状態（重みをスレッドの受け持ちに分けて持つ）
struct Learner {
    shape: Shape,
    parts: Vec<RwLock<Part>>,
    dense: RwLock<Dense>,
    l2: f64,
    lr: f64,
    fit_a: bool,
}

impl Learner {
    fn new(model: &NetModel, seen_rows: &[bool], l2: f64, lr: f64, fit_a: bool) -> Learner {
        let t = thread_count().max(1);
        let h = model.hidden;
        let sizes = model.layer_sizes();
        let mut act_off = Vec::new();
        let mut o = 0;
        for &s in &sizes {
            act_off.push(o);
            o += s;
        }
        let act_len = o;
        let n_in = model.input_size();
        // Dense: [b1 | 足した層の b… | w2 | b2 | c | a]
        let mut o_lb = Vec::new();
        let mut o = h;
        for &s in &sizes[1..] {
            o_lb.push(o);
            o += s;
        }
        let o_w2 = o;
        let o_b2 = o_w2 + sizes[sizes.len() - 1];
        let (o_c, o_a) = (o_b2 + 1, o_b2 + 2);
        let mut dense = Dense {
            r: Rows::new(o_a + 1, 1),
            decay: vec![0.0; o_a + 1],
        };
        dense.r.p[..h].copy_from_slice(&model.b1);
        for (k, l) in model.layers.iter().enumerate() {
            dense.r.p[o_lb[k]..o_lb[k] + l.b.len()].copy_from_slice(&l.b);
        }
        dense.r.p[o_w2..o_b2].copy_from_slice(&model.w2);
        dense.r.p[o_b2] = model.b2;
        dense.r.p[o_c] = model.c;
        dense.r.p[o_a] = model.a;
        dense.decay[o_w2..o_b2].fill(l2);
        let parts = (0..t)
            .map(|tid| {
                let n_local = if n_in > tid {
                    (n_in - tid).div_ceil(t)
                } else {
                    0
                };
                let mut w1 = Rows::new(h, n_local);
                for l in 0..n_local {
                    let r = tid + t * l;
                    w1.p[l * h..(l + 1) * h].copy_from_slice(&model.w1[r * h..(r + 1) * h]);
                }
                let seen = (0..n_local).filter(|&l| seen_rows[tid + t * l]).collect();
                let layers = model
                    .layers
                    .iter()
                    .enumerate()
                    .map(|(k, layer)| {
                        let (n_rows, m) = (sizes[k], sizes[k + 1]);
                        let n_l = if n_rows > tid {
                            (n_rows - tid).div_ceil(t)
                        } else {
                            0
                        };
                        let mut rows = Rows::new(m, n_l);
                        for l in 0..n_l {
                            let i = tid + t * l;
                            rows.p[l * m..(l + 1) * m]
                                .copy_from_slice(&layer.w[i * m..(i + 1) * m]);
                        }
                        rows
                    })
                    .collect();
                RwLock::new(Part {
                    w1,
                    last: vec![0; n_local],
                    stamp: vec![0; n_local],
                    touched: Vec::new(),
                    seen,
                    layers,
                })
            })
            .collect();
        Learner {
            shape: Shape {
                t,
                h,
                sizes,
                act_off,
                act_len,
                o_lb,
                o_w2,
                o_b2,
                o_c,
                o_a,
            },
            parts,
            dense: RwLock::new(dense),
            l2,
            lr,
            fit_a,
        }
    }

    fn view(&self) -> View<'_> {
        View {
            shape: &self.shape,
            parts: self.parts.iter().map(|p| p.read().expect("重み")).collect(),
            dense: self.dense.read().expect("重み"),
        }
    }

    fn a(&self) -> f64 {
        self.dense.read().expect("重み").r.p[self.shape.o_a]
    }

    fn c(&self) -> f64 {
        self.dense.read().expect("重み").r.p[self.shape.o_c]
    }

    /// 学ぶ行に、step 回目までの更新を全部当てる（全局面の予測と書き出しの前）
    fn flush(&self, step: u32, cs: &[(f64, f64)]) {
        std::thread::scope(|sc| {
            for part in &self.parts {
                sc.spawn(move || {
                    let mut p = part.write().expect("重み");
                    let p = &mut *p;
                    for &l in &p.seen {
                        if p.last[l] < step {
                            p.w1.replay_row(l, p.last[l], step, self.l2, self.lr, cs);
                            p.last[l] = step;
                        }
                    }
                });
            }
        });
    }

    /// 全局面の勝つ確率の予測と、補正 (c + L) / a の絶対値の和（td-main.ts の predictAll。和は局面の順に足す）
    fn predict_all(&self, d: &Dataset) -> (Vec<f64>, f64) {
        let n = d.len();
        let t = self.shape.t;
        let chunk = n.div_ceil(t).max(1);
        let ranges: Vec<(usize, usize)> = (0..n)
            .step_by(chunk)
            .map(|a| (a, (a + chunk).min(n)))
            .collect();
        let parts = parallel_map(
            &ranges,
            |&(a, b), _| {
                let view = self.view();
                let (ma, mc) = (view.d(self.shape.o_a), view.d(self.shape.o_c));
                let mut acts = vec![0.0; self.shape.act_len];
                let mut buf = Vec::new();
                let mut v = Vec::with_capacity(b - a);
                let mut abs = Vec::with_capacity(b - a);
                for i in a..b {
                    d.inputs(i, &mut buf);
                    let z = view.forward(&buf, &mut acts);
                    v.push(sigmoid(ma * d.s_at(i) + mc + z));
                    abs.push(((mc + z) / ma).abs());
                }
                (v, abs)
            },
            |_, _, _, _| {},
        );
        let mut v = Vec::with_capacity(n);
        let mut sum = 0.0;
        for (pv, pa) in parts {
            v.extend(pv);
            for x in pa {
                sum += x;
            }
        }
        (v, sum)
    }

    /// 1 エポック分のミニバッチを学ぶ。返すのは学習の TD（交差エントロピー）の和
    #[allow(clippy::too_many_arguments)]
    fn epoch(
        &self,
        d: &Dataset,
        order: &[u32],
        batch: usize,
        targets: &[f64],
        weight: &(dyn Fn(usize) -> f64 + Sync),
        step0: u32,
        cs: &[(f64, f64)],
    ) -> f64 {
        let sh = &self.shape;
        let t = sh.t;
        let batches: Vec<&[u32]> = order.chunks(batch).collect();
        let slot_len = sh.slot_len();
        let max_b = batch.min(order.len()).max(1);
        let chunk = max_b.div_ceil(t);
        // 局面ごとの値（スレッド k がミニバッチの k 番目の塊の局面を書く）
        let slots: Vec<RwLock<Vec<f64>>> = (0..t)
            .map(|_| RwLock::new(vec![0.0; chunk * slot_len]))
            .collect();
        let barrier = Barrier::new(t);
        let run = |tid: usize| -> f64 {
            let mut buf: Vec<(usize, f64)> = Vec::new();
            let mut loss_sum = 0.0;
            for (b, idx) in batches.iter().enumerate() {
                let step = step0 + b as u32 + 1;
                let nb = idx.len();
                let chunk = nb.div_ceil(t);
                // 1. 前向きの計算と、各層の値の勾配（局面ごと）
                {
                    let view = self.view();
                    let mut out = slots[tid].write().expect("局面の値");
                    let (ma, mc) = (view.d(sh.o_a), view.d(sh.o_c));
                    for k in tid * chunk..((tid + 1) * chunk).min(nb) {
                        let i = idx[k] as usize;
                        let o = (k - tid * chunk) * slot_len;
                        let slot = &mut out[o..o + slot_len];
                        let (acts, rest) = slot.split_at_mut(sh.act_len);
                        let (dacts, rest) = rest.split_at_mut(sh.act_len);
                        d.inputs(i, &mut buf);
                        let z = view.forward(&buf, acts);
                        let s = d.s_at(i);
                        let p = sigmoid(ma * s + mc + z);
                        let loss = bce(p, targets[i]);
                        let dz = (weight(i) * (p - targets[i])) / nb as f64;
                        view.deltas(dz, acts, dacts);
                        rest[0] = dz;
                        rest[1] = s;
                        rest[2] = loss;
                    }
                }
                barrier.wait();
                // 2. 勾配を局面の順に足して Adam（受け持ちの行ごと）。次のミニバッチに出る行には、出なかった回の更新を当てる
                {
                    let outs: Vec<_> = slots.iter().map(|s| s.read().expect("局面の値")).collect();
                    let slot = |k: usize| -> Slot<'_> {
                        let (w, l) = (k / chunk, k % chunk);
                        let s = &outs[w][l * slot_len..(l + 1) * slot_len];
                        Slot {
                            acts: &s[..sh.act_len],
                            dacts: &s[sh.act_len..2 * sh.act_len],
                            dz: s[2 * sh.act_len],
                            s: s[2 * sh.act_len + 1],
                            loss: s[2 * sh.act_len + 2],
                        }
                    };
                    let c = cs[step as usize];
                    let mut guard = self.parts[tid].write().expect("重み");
                    let part = &mut *guard;
                    let h = sh.h;
                    // 最初の層の行
                    for k in 0..nb {
                        let sl = slot(k);
                        let dh = &sl.dacts[..h];
                        d.inputs(idx[k] as usize, &mut buf);
                        for &(r, x) in &buf {
                            if r % t != tid {
                                continue;
                            }
                            let l = r / t;
                            if part.stamp[l] != step {
                                part.stamp[l] = step;
                                part.touched.push(l);
                            }
                            let g = &mut part.w1.g[l * h..(l + 1) * h];
                            for j in 0..h {
                                g[j] += dh[j] * x;
                            }
                        }
                    }
                    let touched = std::mem::take(&mut part.touched);
                    for &l in &touched {
                        debug_assert_eq!(part.last[l] + 1, step);
                        part.w1.adam_row(l, self.l2, self.lr, c);
                        part.last[l] = step;
                    }
                    part.touched = touched;
                    part.touched.clear();
                    // 足した層の行（受け持ちの入力 i の行）
                    for (kl, rows) in part.layers.iter_mut().enumerate() {
                        let m = rows.w;
                        let n_l = rows.p.len() / m;
                        for k in 0..nb {
                            let sl = slot(k);
                            let hin = &sl.acts[sh.act_off[kl]..sh.act_off[kl] + sh.sizes[kl]];
                            let dout = &sl.dacts[sh.act_off[kl + 1]..sh.act_off[kl + 1] + m];
                            for l in 0..n_l {
                                let x = hin[tid + t * l];
                                if x <= 0.0 {
                                    continue;
                                }
                                let g = &mut rows.g[l * m..(l + 1) * m];
                                for j in 0..m {
                                    g[j] += x * dout[j];
                                }
                            }
                        }
                        for l in 0..n_l {
                            rows.adam_row(l, self.l2, self.lr, c);
                        }
                    }
                    // 毎回更新する重み（スレッド 0）
                    if tid == 0 {
                        let mut dg = self.dense.write().expect("重み");
                        let dense = &mut *dg;
                        let g = &mut dense.r.g;
                        let last = sh.sizes.len() - 1;
                        for k in 0..nb {
                            let sl = slot(k);
                            g[sh.o_c] += sl.dz;
                            if self.fit_a {
                                g[sh.o_a] += sl.dz * sl.s;
                            }
                            g[sh.o_b2] += sl.dz;
                            let hl = &sl.acts[sh.act_off[last]..sh.act_off[last] + sh.sizes[last]];
                            for (j, &x) in hl.iter().enumerate() {
                                g[sh.o_w2 + j] += sl.dz * x;
                            }
                            for kk in (1..sh.sizes.len()).rev() {
                                let dout = &sl.dacts[sh.act_off[kk]..sh.act_off[kk] + sh.sizes[kk]];
                                let ob = sh.o_lb[kk - 1];
                                for (j, &x) in dout.iter().enumerate() {
                                    g[ob + j] += x;
                                }
                            }
                            for (gj, &x) in g[..h].iter_mut().zip(&sl.dacts[..h]) {
                                *gj += x;
                            }
                            loss_sum += sl.loss;
                        }
                        let r = &mut dense.r;
                        for q in 0..r.p.len() {
                            adam1(
                                &mut r.p[q],
                                &mut r.m1[q],
                                &mut r.m2[q],
                                r.g[q],
                                dense.decay[q],
                                self.lr,
                                c.0,
                                c.1,
                            );
                            r.g[q] = 0.0;
                        }
                        // a が 0 に近いと補正 (c + L) / a が発散するので下限を置く
                        if r.p[sh.o_a] < 0.005 {
                            r.p[sh.o_a] = 0.005;
                        }
                    }
                    // 次のミニバッチに出る行を、この回の分まで進めておく
                    if let Some(next) = batches.get(b + 1) {
                        for &i in next.iter() {
                            d.inputs(i as usize, &mut buf);
                            for &(r, _) in &buf {
                                if r % t != tid {
                                    continue;
                                }
                                let l = r / t;
                                if part.last[l] < step {
                                    part.w1
                                        .replay_row(l, part.last[l], step, self.l2, self.lr, cs);
                                    part.last[l] = step;
                                }
                            }
                        }
                    }
                }
                barrier.wait();
            }
            loss_sum
        };
        std::thread::scope(|sc| {
            let run = &run;
            let handles: Vec<_> = (1..t).map(|tid| sc.spawn(move || run(tid))).collect();
            let loss = run(0);
            for h in handles {
                h.join().expect("学習のスレッドが止まりました");
            }
            loss
        })
    }

    /// 今の重み（td-main.ts の params。最初の層・足した層は元の並び）
    fn snapshot(&self) -> (Vec<f64>, Vec<Vec<f64>>, Vec<f64>) {
        let sh = &self.shape;
        let (t, h) = (sh.t, sh.h);
        let n_in = self
            .parts
            .iter()
            .map(|p| p.read().expect("重み").w1.p.len() / h)
            .sum::<usize>();
        let mut w1 = vec![0.0; n_in * h];
        let mut layers: Vec<Vec<f64>> = (1..sh.sizes.len())
            .map(|k| vec![0.0; sh.sizes[k - 1] * sh.sizes[k]])
            .collect();
        for (tid, part) in self.parts.iter().enumerate() {
            let p = part.read().expect("重み");
            for l in 0..p.w1.p.len() / h {
                let r = tid + t * l;
                w1[r * h..(r + 1) * h].copy_from_slice(&p.w1.p[l * h..(l + 1) * h]);
            }
            for (k, rows) in p.layers.iter().enumerate() {
                let m = rows.w;
                for l in 0..rows.p.len() / m {
                    let i = tid + t * l;
                    layers[k][i * m..(i + 1) * m].copy_from_slice(&rows.p[l * m..(l + 1) * m]);
                }
            }
        }
        let dense = self.dense.read().expect("重み").r.p.clone();
        (w1, layers, dense)
    }

    /// snapshot の重みに戻す（--best。Adam の状態は戻さない。書き出すだけ）
    fn restore(&self, snap: &(Vec<f64>, Vec<Vec<f64>>, Vec<f64>)) {
        let sh = &self.shape;
        let (t, h) = (sh.t, sh.h);
        for (tid, part) in self.parts.iter().enumerate() {
            let mut p = part.write().expect("重み");
            for l in 0..p.w1.p.len() / h {
                let r = tid + t * l;
                p.w1.p[l * h..(l + 1) * h].copy_from_slice(&snap.0[r * h..(r + 1) * h]);
            }
            for (k, rows) in p.layers.iter_mut().enumerate() {
                let m = rows.w;
                for l in 0..rows.p.len() / m {
                    let i = tid + t * l;
                    rows.p[l * m..(l + 1) * m].copy_from_slice(&snap.1[k][i * m..(i + 1) * m]);
                }
            }
        }
        self.dense
            .write()
            .expect("重み")
            .r
            .p
            .copy_from_slice(&snap.2);
    }
}

// ---- 報告（td-main.ts と同じ文） ----

/// λ 収益（td-main.ts の lambdaReturns。--searchTarget は扱わない）
fn lambda_returns(d: &Dataset, v: &[f64], lambda: f64) -> Vec<f64> {
    let n = v.len();
    let mut g = vec![0.0; n];
    for i in (0..n).rev() {
        if d.anchor[i] >= 0 {
            continue;
        }
        let j = d.next[i];
        if j < 0 {
            g[i] = d.outcome(i);
        } else if d.has(j as usize, F_EXPLORED) {
            g[i] = v[j as usize];
        } else {
            g[i] = (1.0 - lambda) * v[j as usize] + lambda * g[j as usize];
        }
    }
    for i in 0..n {
        let a = d.anchor[i];
        if a >= 0 {
            g[i] = g[a as usize];
        }
    }
    g
}

/// 勝敗に対する AUC（td-main.ts の auc。並べ替えは同じ値なら元の順のまま）
fn auc(pred: &[f64], y: &[f64]) -> f64 {
    let mut order: Vec<usize> = (0..pred.len()).collect();
    order.sort_by(|&a, &b| pred[a].partial_cmp(&pred[b]).expect("予測が NaN"));
    let (mut pos, mut rank_sum) = (0.0f64, 0.0f64);
    for (r, &i) in order.iter().enumerate() {
        if y[i] == 1.0 {
            pos += 1.0;
            rank_sum += (r + 1) as f64;
        }
    }
    let neg = y.len() as f64 - pos;
    if pos == 0.0 || neg == 0.0 {
        0.5
    } else {
        (rank_sum - (pos * (pos + 1.0)) / 2.0) / (pos * neg)
    }
}

/// 確かめ用の局面（ランダムに打った局面を除く）のうち phases の種類の、勝敗に対する交差エントロピー（td-main.ts の holdoutLoss）
fn holdout_loss(d: &Dataset, v: &[f64], phases: &[u8]) -> f64 {
    let (mut sum, mut n) = (0.0, 0usize);
    for (i, &vi) in v.iter().enumerate() {
        if !d.has(i, F_HOLDOUT) || d.has(i, F_EXPLORED) || !phases.contains(&d.phase(i)) {
            continue;
        }
        sum += bce(vi, d.outcome(i));
        n += 1;
    }
    sum / n.max(1) as f64
}

fn signed_pct(x: f64, digits: usize) -> String {
    format!(
        "{}{}%",
        if x >= 0.0 { "+" } else { "" },
        fixed(x * 100.0, digits)
    )
}

/// td-main.ts の searchReport
fn search_report(d: &Dataset, v: &[f64]) -> Option<String> {
    let mut parts = Vec::new();
    for (name, ph) in [("end", 0u8), ("after", 1u8)] {
        let (mut n, mut lq, mut lv, mut diff) = (0usize, 0.0, 0.0, 0.0);
        for (i, &vi) in v.iter().enumerate() {
            if !d.has(i, F_HOLDOUT) || d.has(i, F_EXPLORED) || d.phase(i) != ph || d.q[i].is_nan() {
                continue;
            }
            n += 1;
            lq += bce(d.q[i], d.outcome(i));
            lv += bce(vi, d.outcome(i));
            diff += d.q[i] - vi;
        }
        if n == 0 {
            continue;
        }
        let nf = n as f64;
        parts.push(format!(
            "{name}({n}) 勝敗の交差エントロピー 探索の値 {}・予測 {}、探索の値 − 予測 {}",
            fixed(lq / nf, 4),
            fixed(lv / nf, 4),
            signed_pct(diff / nf, 2)
        ));
    }
    let all = d.q.iter().filter(|x| !x.is_nan()).count();
    if parts.is_empty() {
        None
    } else {
        Some(format!("探索の値のある局面 {all} / {}", parts.join(" / ")))
    }
}

const RES_KEYS: [(&str, &str); 4] = [
    ("ep", "EP"),
    ("sep", "SEP"),
    ("hp", "体力"),
    ("maxPp", "PP 最大値"),
];

fn iv_zone_name(z: IvZone) -> &'static str {
    match z {
        IvZone::Hand => "",
        IvZone::Drawn => "引いたとき",
        IvZone::Board => "自分の場",
        IvZone::OppBoard => "相手の場",
        IvZone::Res => "自分の",
        IvZone::OppRes => "相手の",
    }
}

/// 持ち主から見た向き（td-main.ts の ivSign）
fn iv_sign(q: &IvPair) -> f64 {
    let s = if matches!(q.zone, IvZone::OppBoard | IvZone::OppRes) {
        -1.0
    } else {
        1.0
    };
    s * if q.zone.is_res() { -q.d } else { 1.0 }
}

/// 介入の対の、測った価値とモデルが見ている価値（td-main.ts の ivSummary）
fn iv_summary(d: &Dataset, v: &[f64], holdout_only: bool) -> Option<String> {
    // (名前, 並べる順, 数, 測った価値, 予測の差)。名前は最初に現れた順
    let mut groups: Vec<(String, i32, usize, f64, f64)> = Vec::new();
    for q in &d.pairs {
        if holdout_only && !d.has(q.base as usize, F_HOLDOUT) {
            continue;
        }
        let key = if q.zone.is_res() {
            let name = RES_KEYS
                .iter()
                .find(|(k, _)| *k == q.card)
                .map(|(_, n)| *n)
                .unwrap_or(q.card.as_str());
            format!("{}{name}（1 あたり）", iv_zone_name(q.zone))
        } else {
            iv_zone_name(q.zone).to_string()
        };
        let order = q.zone.order() * 10
            + if q.zone.is_res() {
                RES_KEYS
                    .iter()
                    .position(|(k, _)| *k == q.card)
                    .map_or(0, |p| p as i32 + 1)
            } else {
                0
            };
        let pos = match groups.iter().position(|g| g.0 == key) {
            Some(p) => p,
            None => {
                groups.push((key, order, 0, 0.0, 0.0));
                groups.len() - 1
            }
        };
        let g = &mut groups[pos];
        g.2 += 1;
        g.3 += iv_sign(q) * (d.outcome(q.base as usize) - d.outcome(q.variant as usize));
        g.4 += iv_sign(q) * (v[q.base as usize] - v[q.variant as usize]);
    }
    groups.sort_by_key(|g| g.1);
    if groups.is_empty() {
        return None;
    }
    let parts: Vec<String> = groups
        .iter()
        .map(|(key, _, n, measured, predicted)| {
            let pct = |x: f64| {
                format!(
                    "{}{}%",
                    if x >= 0.0 { "+" } else { "" },
                    fixed((x / *n as f64) * 100.0, 1)
                )
            };
            format!(
                "介入{key}({n}) 測った価値 {} 予測の差 {}",
                pct(*measured),
                pct(*predicted)
            )
        })
        .collect();
    Some(parts.join(" / "))
}

/// 確かめ用の局面での、勝敗に対する交差エントロピーと AUC（td-main.ts の report）
fn report(label: &str, d: &Dataset, v: &[f64], targets: &[f64]) {
    let mut parts = Vec::new();
    for (name, ph) in [("全体", -1i32), ("end", 0), ("after", 1), ("imagined", 2)] {
        let (mut pred, mut y) = (Vec::new(), Vec::new());
        let (mut td, mut bias) = (0.0, 0.0);
        for i in 0..v.len() {
            let phase = d.phase(i) as i32;
            if !d.has(i, F_HOLDOUT)
                || d.has(i, F_EXPLORED)
                || (if ph >= 0 { phase != ph } else { phase == 2 })
            {
                continue;
            }
            pred.push(v[i]);
            y.push(d.outcome(i));
            td += bce(v[i], targets[i]);
            bias += v[i] - targets[i];
        }
        let n = pred.len();
        if ph == 2 && n == 0 {
            continue;
        }
        let nf = n.max(1) as f64;
        let mut ll = 0.0;
        for (k, &p) in pred.iter().enumerate() {
            ll += bce(p, y[k]);
        }
        let ll = ll / nf;
        let extra = if ph == 2 {
            format!(
                " 予測の平均 − 目標の平均 {}{}%",
                if bias / nf >= 0.0 { "+" } else { "" },
                fixed((bias / nf) * 100.0, 1)
            )
        } else {
            String::new()
        };
        parts.push(format!(
            "{name}({n}) 勝敗の交差エントロピー {} AUC {} TD {}{extra}",
            fixed(ll, 4),
            fixed(auc(&pred, &y), 3),
            fixed(td / nf, 4)
        ));
    }
    if let Some(iv) = iv_summary(d, v, true) {
        parts.push(iv);
    }
    println!("{label}: {}", parts.join(" / "));
}

// ---- 書き出し ----

fn write_json(path: &str, j: &Json) -> Result<(), String> {
    std::fs::write(path, j.stringify()).map_err(|e| format!("{path} に書けません: {e}"))
}

// ---- train ----

/// --bestOn の局面の種類
const PHASE_NAMES: [&str; 3] = ["end", "after", "imagined"];

pub fn train(args: &Args) -> Result<(), String> {
    check_known(args, &TRAIN_ARGS, "train")?;
    let model0 = NetModel::load(need(args, "model")?)?;
    // --dropInputs: 出発点のモデルからその入力（zones・scalars の名前）を外して学ぶ
    let drop_text = arg(args, "dropInputs");
    let model = match drop_text {
        None => model0.clone(),
        Some(t) => model0.drop_inputs(&t.split(',').collect::<Vec<_>>())?,
    };
    if let Some(t) = drop_text {
        println!(
            "入力 {t} を外して学ぶ（入力 {} → {}）",
            model0.input_size(),
            model.input_size()
        );
    }
    let files: Vec<String> = need(args, "data")?.split(',').map(str::to_string).collect();
    let out = need(args, "out")?;
    let lambda = num_arg(args, "lambda", 0.7)?;
    let epochs = int_arg(args, "epochs", 2, 0)?;
    let lr = num_arg(args, "lr", 0.001)?;
    let l2 = num_arg(args, "l2", 0.0001)?;
    let batch = int_arg(args, "batch", 128, 1)?;
    let holdout = num_arg(args, "holdout", 0.1)?;
    let fit_a = num_arg(args, "fitA", 1.0)? != 0.0;
    let mut rng = js_to_uint32(num_arg(args, "seed", 1.0)?);
    let iv_weight = num_arg(args, "ivWeight", 1.0)?;
    let imagined_weight = num_arg(args, "imaginedWeight", 1.0)?;
    let iv_res = num_arg(args, "ivRes", 1.0)? != 0.0;
    let keep_best = num_arg(args, "best", 0.0)? != 0.0;
    // --bestOn end,imagined: --best の判定に使う局面の種類（既定 end,after）
    let mut best_on: Vec<u8> = Vec::new();
    for x in arg(args, "bestOn").unwrap_or("end,after").split(',') {
        let ph = PHASE_NAMES
            .iter()
            .position(|n| *n == x.trim())
            .ok_or_else(|| format!("--bestOn は end・after・imagined をカンマで並べます: {x}"))?
            as u8;
        if !best_on.contains(&ph) {
            best_on.push(ph);
        }
    }
    let base_arg = arg(args, "base");
    let base_weights = match base_arg {
        None => model.base_weights.clone(),
        Some("default") => default_base(),
        Some("zero") => zero_base(),
        Some("search") => Json::Obj(vec![]),
        Some(b) => return Err(format!("--base は default・zero・search: {b}")),
    };

    let t0 = Instant::now();
    let skip = deck_filter(args)?;
    let s_source = s_source_of(&base_weights);
    let layout = model.layout();
    let fallback = model0.layout();
    let d = load_data(
        &files,
        &LoadOptions {
            holdout,
            iv_weight,
            imagined_weight,
            iv_res,
            search_mix: 0.5,
            s_source,
            skip_game: skip.as_deref(),
            layout: &layout,
            fallback: &fallback,
        },
    )?;
    if d.is_empty() {
        return Err("学ぶ局面がありません（--data・--onlyDecks・--excludeDecks を見る）".into());
    }
    if let Some(b) = base_arg {
        let s = match s_source {
            SSource::S => "\"s\"",
            SSource::Sd => "\"sd\"",
            SSource::Zero => "0",
        };
        println!("出発点の評価: {b}（S は {s}）");
    }
    let n = d.len();
    let count = |f: u8| (0..n).filter(|&i| d.has(i, f)).count();
    println!(
        "{}: 局面 {n}（確かめ用 {}、ランダムに打った {}、想像の局面 {}、介入の対 {}（うち資源 {}））、読み込み {}s",
        files.join(", "),
        count(F_HOLDOUT),
        count(F_EXPLORED),
        d.anchor.iter().filter(|&&a| a >= 0).count(),
        d.pairs.len(),
        d.pairs.iter().filter(|q| q.zone.is_res()).count(),
        fixed(t0.elapsed().as_secs_f64(), 1)
    );
    eprintln!(
        "（詰めたデータ {:.0}MB、入力の値 {} 種類）",
        d.bytes() as f64 / 1e6,
        d.table.len()
    );

    // 読んだ局面に一度も出ない入力の行は勾配が常に 0 で、TypeScript 版も Adam から外している（その行は動かさない）
    let n_b = model.input_size();
    let mut seen = vec![false; n_b];
    for &r in &d.idx {
        seen[r as usize] = true;
    }
    let rows = seen.iter().filter(|&&x| x).count();
    println!(
        "入力 {n_b} のうち、読んだ局面に出た {rows} 個の行の重みを学ぶ（出ない行は動かさない）"
    );

    let learner = Learner::new(&model, &seen, l2, lr, fit_a);
    let mut order: Vec<u32> = (0..n as u32)
        .filter(|&i| !d.has(i as usize, F_HOLDOUT) && !d.has(i as usize, F_EXPLORED))
        .collect();
    let steps_per_epoch = order.len().div_ceil(batch);
    let total_steps = steps_per_epoch * epochs;
    if total_steps >= u32::MAX as usize {
        return Err("ミニバッチの数が多すぎます".into());
    }
    // 回ごとの Adam の補正（1 - β^step）
    let cs: Vec<(f64, f64)> = (0..=total_steps)
        .map(|s| {
            (
                1.0 - jsmath::pow(BETA1, s as f64),
                1.0 - jsmath::pow(BETA2, s as f64),
            )
        })
        .collect();
    let weight = |i: usize| -> f64 {
        let w = if d.has(i, F_IV) { iv_weight } else { 1.0 };
        if d.phase(i) == 2 {
            w * imagined_weight
        } else {
            w
        }
    };

    let (v0, abs0) = learner.predict_all(&d);
    if d.q.iter().any(|x| !x.is_nan()) {
        if let Some(line) = search_report(&d, &v0) {
            println!("探索の値（--searchTarget 0、--searchMix 0.5）: {line}");
        }
    }
    report("学習前", &d, &v0, &lambda_returns(&d, &v0, lambda));
    // --best 1: 確かめ用の局面の勝敗の交差エントロピーが一番小さかったエポックの重み
    let mut best_loss = holdout_loss(&d, &v0, &best_on);
    let mut best_epoch = 0;
    let mut best_abs = abs0;
    let mut best_params = if keep_best {
        Some(learner.snapshot())
    } else {
        None
    };
    let mut last = (v0, abs0);
    let mut step = 0u32;
    for epoch in 0..epochs {
        let targets = lambda_returns(&d, &last.0, lambda);
        // 並べ替え（Fisher-Yates）
        for i in (1..order.len()).rev() {
            let (x, next) = next_random(rng);
            rng = next;
            let j = (x * (i + 1) as f64).floor() as usize;
            order.swap(i, j);
        }
        let loss_sum = learner.epoch(&d, &order, batch, &targets, &weight, step, &cs);
        step += steps_per_epoch as u32;
        learner.flush(step, &cs);
        let (v, abs) = learner.predict_all(&d);
        report(
            &format!(
                "エポック {}（学習の TD {}、a {}、c {}）",
                epoch + 1,
                fixed(loss_sum / order.len() as f64, 4),
                fixed(learner.a(), 4),
                fixed(learner.c(), 3)
            ),
            &d,
            &v,
            &lambda_returns(&d, &v, lambda),
        );
        let loss = holdout_loss(&d, &v, &best_on);
        if keep_best && loss < best_loss {
            best_loss = loss;
            best_epoch = epoch + 1;
            best_abs = abs;
            best_params = Some(learner.snapshot());
        }
        last = (v, abs);
    }
    if keep_best {
        learner.restore(best_params.as_ref().expect("重み"));
        let on: Vec<&str> = best_on.iter().map(|&p| PHASE_NAMES[p as usize]).collect();
        let at = if best_epoch == 0 {
            "学習前".to_string()
        } else {
            format!("エポック {best_epoch}")
        };
        println!(
            "確かめ用の局面（{}）の勝敗の交差エントロピーが一番小さい {at}（{}）の重みを書き出す",
            on.join("・"),
            fixed(best_loss, 4)
        );
    }
    // 補正の大きさ（評価の点数の単位。書き出す重みの予測のときに足した値）
    let abs_sum = if keep_best { best_abs } else { last.1 };
    println!(
        "補正 (c + L) / a の絶対値の平均 {} 点、{}s",
        fixed(abs_sum / n as f64, 2),
        fixed(t0.elapsed().as_secs_f64(), 1)
    );

    let (w1, layers, dense) = learner.snapshot();
    let sh = &learner.shape;
    let mut m = model.clone();
    m.base_weights = base_weights;
    m.w1 = w1;
    m.b1 = dense[..sh.h].to_vec();
    if sh.sizes.len() > 1 {
        m.layers_present = true;
        m.layers = layers
            .into_iter()
            .enumerate()
            .map(|(k, w)| Layer {
                w,
                b: dense[sh.o_lb[k]..sh.o_lb[k] + sh.sizes[k + 1]].to_vec(),
            })
            .collect();
    }
    m.w2 = dense[sh.o_w2..sh.o_b2].to_vec();
    m.b2 = dense[sh.o_b2];
    m.c = dense[sh.o_c];
    m.a = dense[sh.o_a];
    // 書き出す重みは 6 桁に丸める（td-main.ts の round(x, 6)。属性の分 attr は読んだまま）
    let j = m.to_json(|x| Json::Num(round_precision(x, 6)));
    write_json(out, &j)?;
    println!("{out} に書き出しました");
    Ok(())
}

// ---- prune ----

/// 学習データに一度も現れなかった入力の重みを 0 にする（td-main.ts の prune。属性の分・場のカードのネットワークを持つモデルは扱わない）
pub fn prune(args: &Args) -> Result<(), String> {
    check_known(args, &PRUNE_ARGS, "prune")?;
    let model = NetModel::load(need(args, "model")?)?;
    if model.attr.is_some() {
        return Err(
            "属性の分（attr）を持つモデルの間引きは、TypeScript 版の npm run td -- prune で".into(),
        );
    }
    let files: Vec<String> = need(args, "data")?.split(',').map(str::to_string).collect();
    let out = need(args, "out")?;
    let skip = deck_filter(args)?;
    let used = used_inputs(&files, &model.layout(), skip.as_deref())?;
    let h = model.hidden;
    let n = model.input_size();
    let w1: Vec<f64> = model
        .w1
        .iter()
        .enumerate()
        .map(|(k, &w)| if used[k / h] { w } else { 0.0 })
        .collect();
    let n_used = used.iter().filter(|&&x| x).count();
    println!(
        "{out}: 入力 {n} のうち、データに現れた {n_used} 個の重みを残し、{} 個を 0 にしました",
        n - n_used
    );
    let mut m = model.without_attr();
    m.w1 = w1;
    write_json(out, &m.to_json(Json::Num))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_weights_sources() {
        assert!(s_source_of(&zero_base()) == SSource::Zero);
        assert!(s_source_of(&default_base()) == SSource::Sd);
        assert!(s_source_of(&Json::Obj(vec![])) == SSource::S);
        // 項目の順番が違っても同じ重み
        let Json::Obj(mut items) = zero_base() else {
            panic!()
        };
        items.reverse();
        assert!(s_source_of(&Json::Obj(items)) == SSource::Zero);
    }

    #[test]
    fn auc_ties_keep_order() {
        // 同じ予測は元の順のまま（JavaScript の安定な並べ替え）
        assert_eq!(auc(&[0.5, 0.5], &[1.0, 0.0]), 0.0);
        assert_eq!(auc(&[0.5, 0.5], &[0.0, 1.0]), 1.0);
        assert_eq!(auc(&[0.1, 0.9, 0.4], &[0.0, 1.0, 0.0]), 1.0);
        assert_eq!(auc(&[0.1], &[1.0]), 0.5);
    }

    #[test]
    fn unknown_args_are_refused() {
        let args = vec![("attr".to_string(), "1".to_string())];
        assert!(check_known(&args, &TRAIN_ARGS, "train")
            .unwrap_err()
            .contains("TypeScript"));
    }

    #[test]
    fn replay_equals_eager_zero_updates() {
        // 出なかった回の更新を後から当てても、毎回当てたのと同じ値になる
        let cs: Vec<(f64, f64)> = (0..=6)
            .map(|s| {
                (
                    1.0 - jsmath::pow(BETA1, s as f64),
                    1.0 - jsmath::pow(BETA2, s as f64),
                )
            })
            .collect();
        let (mut a, mut b) = (Rows::new(3, 1), Rows::new(3, 1));
        a.p.copy_from_slice(&[0.3, -0.2, 0.0]);
        b.p.copy_from_slice(&[0.3, -0.2, 0.0]);
        for (step, g) in [(1, [0.1, -0.5, 0.0]), (4, [0.2, 0.0, -1.0])] {
            let last = if step == 1 { 0 } else { 1 };
            // 毎回
            for s in last + 1..step {
                a.adam_row(0, 0.01, 0.001, cs[s as usize]);
            }
            a.g.copy_from_slice(&g);
            a.adam_row(0, 0.01, 0.001, cs[step as usize]);
            // 後から
            b.replay_row(0, last, step - 1, 0.01, 0.001, &cs);
            b.g.copy_from_slice(&g);
            b.adam_row(0, 0.01, 0.001, cs[step as usize]);
        }
        assert_eq!(a.p, b.p);
        assert_eq!(a.m1, b.m1);
        assert_eq!(a.m2, b.m2);
    }
}
