//! 補正の学習（`svwb td train`・`svwb td prune`、runner/td_train.rs）が読むモデルと自己対戦のデータ。
//! TypeScript 版 scripts/td-main.ts の loadData・dataRecords・layoutMap・dropInputs と、scripts/valueNet.ts の parseValueNetModel を移したもの。
//!
//! データは詰めた配列に入れる（docs/ai-notes/13-2026-11-13.md「補正の学習を Rust に移す」）: 入力の添字は 16 ビット、値は出てきた値の表への
//! 8 ビットの番号（256 種類を越えたら 16 ビットに広げる）、局面ごとの印は 1 バイト。TypeScript 版は入力 1 つに 8 バイト（添字と値が 32 ビットずつ）で、
//! 伸びる配列が倍々に増える分も山に乗る。値は TypeScript 版と同じく 32 ビットの小数に丸めたもの（表に入れるのは丸めた値）なので、計算は同じになる。
//!
//! 自己対戦のファイル（.gz は gzip -dc で展開する）は行ごとに読み、まとめた行を並列に読み取ってから、ファイルの順に積む（結果は並列数によらない）。

use super::parallel::{parallel_map, thread_count};
use crate::ai::valuenet::{SCALARS, ZONES};
use crate::fasthash::FastMap;
use crate::json::Json;
use serde::de::IgnoredAny;
use serde::Deserialize;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};

// ---- モデル ----

/// 足した隠れ層（w は前の層 × この層）
#[derive(Clone)]
pub struct Layer {
    pub w: Vec<f64>,
    pub b: Vec<f64>,
}

/// 補正のモデル（scripts/valueNet.ts の ValueNetModel）。書き出すときは parseValueNetModel が作るのと同じ項目の順番にする（to_json）
#[derive(Clone)]
pub struct NetModel {
    pub vocab: Vec<String>,
    pub zones: Vec<String>,
    pub scalars: Vec<String>,
    pub hidden: usize,
    pub w1: Vec<f64>,
    pub b1: Vec<f64>,
    /// 読んだファイルに "layers" があったか（空の配列でも書き出す）
    pub layers_present: bool,
    pub layers: Vec<Layer>,
    pub w2: Vec<f64>,
    pub b2: f64,
    pub a: f64,
    pub c: f64,
    pub base_weights: Json,
    /// 場のカードのネットワーク（Rust 版の学習は扱わない）
    pub has_board: bool,
    /// 属性の分（{names, a}。学習はそのまま書き出し、間引きは扱わない）
    pub attr: Option<Json>,
}

fn json_nums(v: Option<&Json>, k: &str) -> Result<Vec<f64>, String> {
    match v {
        Some(Json::Arr(xs)) => xs
            .iter()
            .map(|x| match x {
                Json::Num(n) if n.is_finite() => Ok(*n),
                _ => Err(format!("ValueNetModel の {k} が数の配列ではありません")),
            })
            .collect(),
        _ => Err(format!("ValueNetModel の {k} が数の配列ではありません")),
    }
}

fn json_strs(v: Option<&Json>, k: &str) -> Result<Vec<String>, String> {
    match v {
        Some(Json::Arr(xs)) => xs
            .iter()
            .map(|x| match x {
                Json::Str(s) => Ok(s.clone()),
                _ => Err(format!("ValueNetModel の {k} が文字列の配列ではありません")),
            })
            .collect(),
        _ => Err(format!("ValueNetModel の {k} が文字列の配列ではありません")),
    }
}

fn json_num(v: Option<&Json>, k: &str) -> Result<f64, String> {
    match v {
        Some(Json::Num(n)) if n.is_finite() => Ok(*n),
        _ => Err(format!("ValueNetModel の {k} が数ではありません")),
    }
}

/// names が all の部分列か（順番を保つ。valueNet.ts の isSubsequence）
fn is_subsequence(names: &[String], all: &[&str]) -> bool {
    let mut j = 0;
    for n in names {
        while j < all.len() && all[j] != n {
            j += 1;
        }
        if j == all.len() {
            return false;
        }
        j += 1;
    }
    true
}

impl NetModel {
    /// 補正のモデルのファイルを読む（valueNet.ts の loadValueNet と compileValueNet の検査）
    pub fn load(path: &str) -> Result<NetModel, String> {
        let text =
            std::fs::read_to_string(path).map_err(|e| format!("{path} が読めません: {e}"))?;
        let json = Json::parse(&text).map_err(|e| format!("{path}: {e}"))?;
        NetModel::from_json(json).map_err(|e| format!("{path}: {e}"))
    }

    pub fn from_json(json: Json) -> Result<NetModel, String> {
        if !json.is_obj() {
            return Err("ValueNetModel がオブジェクトではありません".into());
        }
        if json.get("kind") != Some(&Json::Str("td-value-net".into()))
            || json.get("version") != Some(&Json::Num(1.0))
        {
            return Err("ValueNetModel の kind・version が違います".into());
        }
        let base_weights = match json.get("baseWeights") {
            Some(b @ Json::Obj(_)) => b.clone(),
            _ => return Err("ValueNetModel の baseWeights がオブジェクトではありません".into()),
        };
        let layers = match json.get("layers") {
            None => Vec::new(),
            Some(Json::Arr(ls)) => ls
                .iter()
                .enumerate()
                .map(|(i, l)| {
                    if !l.is_obj() {
                        return Err(format!(
                            "ValueNetModel の layers[{i}] がオブジェクトではありません"
                        ));
                    }
                    Ok(Layer {
                        w: json_nums(l.get("w"), &format!("layers[{i}].w"))?,
                        b: json_nums(l.get("b"), &format!("layers[{i}].b"))?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?,
            Some(_) => return Err("ValueNetModel の layers が配列ではありません".into()),
        };
        let hidden = json_num(json.get("hidden"), "hidden")?;
        if hidden < 1.0 || hidden.fract() != 0.0 {
            return Err("ValueNetModel の hidden が 1 以上の整数ではありません".into());
        }
        let attr = match json.get("attr") {
            None => None,
            Some(a @ Json::Obj(_)) => Some(Json::Obj(vec![
                (
                    "names".into(),
                    Json::Arr(
                        json_strs(a.get("names"), "attr.names")?
                            .into_iter()
                            .map(Json::Str)
                            .collect(),
                    ),
                ),
                (
                    "a".into(),
                    Json::Arr(
                        json_nums(a.get("a"), "attr.a")?
                            .into_iter()
                            .map(Json::Num)
                            .collect(),
                    ),
                ),
            ])),
            Some(_) => return Err("ValueNetModel の attr がオブジェクトではありません".into()),
        };
        let m = NetModel {
            vocab: json_strs(json.get("vocab"), "vocab")?,
            zones: json_strs(json.get("zones"), "zones")?,
            scalars: json_strs(json.get("scalars"), "scalars")?,
            hidden: hidden as usize,
            w1: json_nums(json.get("w1"), "w1")?,
            b1: json_nums(json.get("b1"), "b1")?,
            layers_present: json.get("layers").is_some(),
            layers,
            w2: json_nums(json.get("w2"), "w2")?,
            b2: json_num(json.get("b2"), "b2")?,
            a: json_num(json.get("a"), "a")?,
            c: json_num(json.get("c"), "c")?,
            base_weights,
            has_board: json.get("board").is_some(),
            attr,
        };
        if !is_subsequence(&m.zones, &ZONES) || !is_subsequence(&m.scalars, &SCALARS) {
            return Err("ValueNetModel の入力の並びが今のコードと違います".into());
        }
        if m.has_board {
            return Err("場のカードのネットワーク（board）を持つモデルは、Rust 版の td train・td prune では扱いません（npm run td -- で）".into());
        }
        let sizes = m.layer_sizes();
        let layers_ok = m
            .layers
            .iter()
            .enumerate()
            .all(|(i, l)| !l.b.is_empty() && l.w.len() == sizes[i] * l.b.len());
        if m.w1.len() != m.input_size() * m.hidden
            || m.b1.len() != m.hidden
            || !layers_ok
            || m.w2.len() != *sizes.last().expect("層")
        {
            return Err("ValueNetModel の重みの大きさが合いません".into());
        }
        Ok(m)
    }

    /// 局面から作る入力の数（ゾーン × vocab ＋ 数値の入力。場のカードのネットワークは扱わないので、最初の層の入力の数と同じ）
    pub fn input_size(&self) -> usize {
        self.zones.len() * self.vocab.len() + self.scalars.len()
    }

    /// 隠れ層の大きさ（最初の層から順に）
    pub fn layer_sizes(&self) -> Vec<usize> {
        std::iter::once(self.hidden)
            .chain(self.layers.iter().map(|l| l.b.len()))
            .collect()
    }

    pub fn layout(&self) -> Layout {
        Layout {
            vocab: self.vocab.clone(),
            zones: self.zones.clone(),
            scalars: self.scalars.clone(),
        }
    }

    /// 属性の分を外したもの（td-main.ts の withoutAttr）
    pub fn without_attr(&self) -> NetModel {
        let mut m = self.clone();
        m.attr = None;
        m
    }

    /// JSON（parseValueNetModel の項目の順番: kind・version・vocab・zones・scalars・hidden・w1・b1・layers・w2・b2・a・c・baseWeights・attr）
    pub fn to_json(&self, num: impl Fn(f64) -> Json) -> Json {
        let strs = |xs: &[String]| Json::Arr(xs.iter().map(|x| Json::Str(x.clone())).collect());
        let arr = |xs: &[f64]| Json::Arr(xs.iter().map(|&x| num(x)).collect());
        let mut items: Vec<(String, Json)> = vec![
            ("kind".into(), Json::Str("td-value-net".into())),
            ("version".into(), Json::Num(1.0)),
            ("vocab".into(), strs(&self.vocab)),
            ("zones".into(), strs(&self.zones)),
            ("scalars".into(), strs(&self.scalars)),
            ("hidden".into(), Json::Num(self.hidden as f64)),
            ("w1".into(), arr(&self.w1)),
            ("b1".into(), arr(&self.b1)),
        ];
        if self.layers_present {
            let ls = self
                .layers
                .iter()
                .map(|l| Json::Obj(vec![("w".into(), arr(&l.w)), ("b".into(), arr(&l.b))]))
                .collect();
            items.push(("layers".into(), Json::Arr(ls)));
        }
        items.push(("w2".into(), arr(&self.w2)));
        items.push(("b2".into(), num(self.b2)));
        items.push(("a".into(), num(self.a)));
        items.push(("c".into(), num(self.c)));
        items.push(("baseWeights".into(), self.base_weights.clone()));
        if let Some(a) = &self.attr {
            items.push(("attr".into(), a.clone()));
        }
        Json::Obj(items)
    }

    /// 入力（zones・scalars の名前）を外したもの（td-main.ts の dropInputs。w1 の行を除き、属性の分は外す）
    pub fn drop_inputs(&self, names: &[&str]) -> Result<NetModel, String> {
        let drop: Vec<&str> = names
            .iter()
            .map(|x| x.trim())
            .filter(|x| !x.is_empty())
            .collect();
        for x in &drop {
            if !self.zones.iter().any(|z| z == x) && !self.scalars.iter().any(|s| s == x) {
                return Err(format!("--dropInputs: このモデルの入力にありません: {x}"));
            }
        }
        let (v, h, z) = (self.vocab.len(), self.hidden, self.zones.len());
        let mut w1 = Vec::with_capacity(self.w1.len());
        let mut copy =
            |row: usize, n: usize| w1.extend_from_slice(&self.w1[row * h..(row + n) * h]);
        for (k, zone) in self.zones.iter().enumerate() {
            if !drop.contains(&zone.as_str()) {
                copy(k * v, v);
            }
        }
        for (j, sc) in self.scalars.iter().enumerate() {
            if !drop.contains(&sc.as_str()) {
                copy(z * v + j, 1);
            }
        }
        let mut m = self.without_attr();
        m.zones.retain(|x| !drop.contains(&x.as_str()));
        m.scalars.retain(|x| !drop.contains(&x.as_str()));
        m.w1 = w1;
        Ok(m)
    }
}

// ---- 入力の並び ----

/// 入力の並び（自己対戦の "x" の添字の意味）
#[derive(Clone, Deserialize, PartialEq)]
pub struct Layout {
    pub vocab: Vec<String>,
    pub zones: Vec<String>,
    pub scalars: Vec<String>,
}

/// データの並び from の入力の添字 → 並び to の添字（to に無い入力は -1）。同じ並びなら None（td-main.ts の layoutMap）
pub fn layout_map(from: &Layout, to: &Layout) -> Option<Vec<i32>> {
    if from == to {
        return None;
    }
    let (vf, vt) = (from.vocab.len(), to.vocab.len());
    let vocab_to: FastMap<&str, usize> = to
        .vocab
        .iter()
        .enumerate()
        .map(|(k, id)| (id.as_str(), k))
        .collect();
    let mut map = vec![-1i32; from.zones.len() * vf + from.scalars.len()];
    for (zf, z) in from.zones.iter().enumerate() {
        let Some(zt) = to.zones.iter().position(|x| x == z) else {
            continue;
        };
        for (k, id) in from.vocab.iter().enumerate() {
            if let Some(&kt) = vocab_to.get(id.as_str()) {
                map[zf * vf + k] = (zt * vt + kt) as i32;
            }
        }
    }
    for (j, sc) in from.scalars.iter().enumerate() {
        if let Some(jt) = to.scalars.iter().position(|x| x == sc) {
            map[from.zones.len() * vf + j] = (to.zones.len() * vt + jt) as i32;
        }
    }
    Some(map)
}

// ---- 自己対戦のファイルを行ごとに読む ----

/// 自己対戦のファイルの行を読むもの（.gz なら gzip -dc の出力）
struct Lines {
    file: String,
    reader: BufReader<Box<dyn Read + Send>>,
    child: Option<Child>,
}

impl Lines {
    fn open(file: &str) -> Result<Lines, String> {
        if file.ends_with(".gz") {
            let mut child = Command::new("gzip")
                .arg("-dc")
                .arg("--")
                .arg(file)
                .stdout(Stdio::piped())
                .spawn()
                .map_err(|e| {
                    format!("{file}: gzip が動きません（.gz を展開するのに gzip -dc を使う）: {e}")
                })?;
            let out = child.stdout.take().expect("gzip の出力");
            Ok(Lines {
                file: file.to_string(),
                reader: BufReader::with_capacity(1 << 20, Box::new(out)),
                child: Some(child),
            })
        } else {
            let f = std::fs::File::open(file).map_err(|e| format!("{file} が読めません: {e}"))?;
            Ok(Lines {
                file: file.to_string(),
                reader: BufReader::with_capacity(1 << 20, Box::new(f)),
                child: None,
            })
        }
    }

    /// 次の空でない行（改行を除く）。終わりなら None
    fn next_line(&mut self) -> Result<Option<Vec<u8>>, String> {
        loop {
            let mut buf = Vec::new();
            let n = self
                .reader
                .read_until(b'\n', &mut buf)
                .map_err(|e| format!("{}: 読めません: {e}", self.file))?;
            if n == 0 {
                return Ok(None);
            }
            if buf.last() == Some(&b'\n') {
                buf.pop();
            }
            if buf.iter().any(|c| !c.is_ascii_whitespace()) {
                return Ok(Some(buf));
            }
        }
    }

    /// 読み終えた（gzip が失敗していればエラー）
    fn finish(mut self) -> Result<(), String> {
        if let Some(mut c) = self.child.take() {
            let st = c
                .wait()
                .map_err(|e| format!("{}: gzip を待てません: {e}", self.file))?;
            if !st.success() {
                return Err(format!("{}: gzip -dc が失敗しました（{st}）", self.file));
            }
        }
        Ok(())
    }
}

/// 一度に並列に読み取る行の数
const BATCH_LINES: usize = 256;

/// ファイルの先頭の入力の並びの行（{"tdLayout": …}。無ければ None）から入力の読み替えを作り（make_map）、残りの行をまとまりごとに渡す。
/// 行は読む側のスレッドで読み、on_batch は呼び出し元のスレッドで順に呼ぶ
fn read_file<F>(
    file: &str,
    make_map: impl FnOnce(Option<Layout>) -> Option<Vec<i32>>,
    mut on_batch: F,
) -> Result<(), String>
where
    F: FnMut(Vec<Vec<u8>>, Option<&[i32]>) -> Result<(), String>,
{
    let mut lines = Lines::open(file)?;
    let first = lines.next_line()?;
    let mut pending = Vec::new();
    let map = match first {
        None => make_map(None),
        Some(line) => {
            #[derive(Deserialize)]
            struct Head {
                #[serde(rename = "tdLayout")]
                td_layout: Option<Layout>,
            }
            let head: Head = serde_json::from_slice(&line)
                .map_err(|e| format!("{file}: 1 行目が JSON として読めません: {e}"))?;
            match head.td_layout {
                Some(l) => make_map(Some(l)),
                None => {
                    pending.push(line);
                    make_map(None)
                }
            }
        }
    };
    std::thread::scope(|sc| -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<Vec<Vec<u8>>, String>>(2);
        let reader = sc.spawn(move || -> Result<(), String> {
            let mut batch = pending;
            loop {
                match lines.next_line() {
                    Ok(Some(l)) => {
                        batch.push(l);
                        if batch.len() >= BATCH_LINES
                            && tx.send(Ok(std::mem::take(&mut batch))).is_err()
                        {
                            return Ok(());
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        let _ = tx.send(Err(e));
                        return Ok(());
                    }
                }
            }
            if !batch.is_empty() && tx.send(Ok(batch)).is_err() {
                return Ok(());
            }
            drop(tx);
            lines.finish()
        });
        let mut result = Ok(());
        for b in rx.iter() {
            match b.and_then(|b| on_batch(b, map.as_deref())) {
                Ok(()) => {}
                Err(e) => {
                    result = Err(e);
                    break;
                }
            }
        }
        drop(rx);
        let finished = reader
            .join()
            .map_err(|_| format!("{file}: 読むスレッドが止まりました"))?;
        result.and(finished)
    })
}

// ---- 自己対戦の行 ----

#[derive(Deserialize)]
struct RawIv {
    p: u8,
    k: usize,
    #[serde(default)]
    card: Option<String>,
    #[serde(default)]
    zone: Option<String>,
    #[serde(default)]
    res: Option<String>,
    #[serde(default)]
    d: Option<f64>,
}

#[derive(Deserialize)]
struct RawSample {
    ph: u8,
    s: f64,
    #[serde(default)]
    sd: Option<f64>,
    x: Vec<u32>,
    v: Vec<f64>,
    #[serde(default)]
    ex: Option<f64>,
    #[serde(default)]
    qe: Option<f64>,
    #[serde(default)]
    qr: Option<f64>,
}

#[derive(Deserialize)]
struct RawLine {
    #[serde(rename = "tdLayout", default)]
    td_layout: Option<IgnoredAny>,
    #[serde(default)]
    cmp: Option<IgnoredAny>,
    #[serde(default)]
    g: Option<f64>,
    #[serde(default)]
    decks: Option<Vec<String>>,
    #[serde(default)]
    winner: Option<f64>,
    #[serde(default)]
    iv: Option<RawIv>,
    #[serde(default)]
    samples: Option<Vec<Vec<RawSample>>>,
}

/// 間引き（td prune）が読む所だけの行
#[derive(Deserialize)]
struct RawLineX {
    #[serde(rename = "tdLayout", default)]
    td_layout: Option<IgnoredAny>,
    #[serde(default)]
    cmp: Option<IgnoredAny>,
    #[serde(default)]
    decks: Option<Vec<String>>,
    #[serde(default)]
    samples: Option<Vec<Vec<RawSampleX>>>,
}

#[derive(Deserialize)]
struct RawSampleX {
    x: Vec<u32>,
}

/// 介入の場所（td-main.ts の IvZone）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IvZone {
    Hand,
    Drawn,
    Board,
    OppBoard,
    Res,
    OppRes,
}

impl IvZone {
    fn parse(s: Option<&str>) -> Result<IvZone, String> {
        Ok(match s.unwrap_or("hand") {
            "hand" => IvZone::Hand,
            "drawn" => IvZone::Drawn,
            "board" => IvZone::Board,
            "oppBoard" => IvZone::OppBoard,
            "res" => IvZone::Res,
            "oppRes" => IvZone::OppRes,
            z => return Err(format!("知らない介入の場所: {z}")),
        })
    }

    pub fn is_res(self) -> bool {
        matches!(self, IvZone::Res | IvZone::OppRes)
    }

    /// 並べる順の番号（td-main.ts の ivSummary の order の場所の分）
    pub fn order(self) -> i32 {
        self as i32
    }
}

/// 読み取った局面（入力はモデルの並びに読み替え済み）
struct PSample {
    ph: u8,
    s: f64,
    sd: Option<f64>,
    ex: bool,
    qe: Option<f64>,
    qr: Option<f64>,
    x: Vec<(u16, f32)>,
}

struct PIv {
    p: usize,
    k: usize,
    card: String,
    zone: IvZone,
    d: f64,
}

/// 読み取った行（試合）
struct PGame {
    cmp: bool,
    g: f64,
    decks: [String; 2],
    winner: f64,
    iv: Option<PIv>,
    samples: [Vec<PSample>; 2],
}

/// 入力の添字を map で読み替える（-1 の入力は捨てる）。n 以上の添字はエラー
fn remap(x: &[u32], v: &[f64], map: Option<&[i32]>, n: usize) -> Result<Vec<(u16, f32)>, String> {
    if x.len() != v.len() {
        return Err("局面の \"x\" と \"v\" の長さが違います".into());
    }
    let mut out = Vec::with_capacity(x.len());
    for (&i, &val) in x.iter().zip(v) {
        let j = match map {
            Some(m) => match m.get(i as usize) {
                Some(&j) if j >= 0 => j as usize,
                _ => continue,
            },
            None => i as usize,
        };
        if j >= n {
            return Err(format!("入力の添字 {j} がモデルの入力の数 {n} を越えています（自己対戦の入力の並びとモデルが合いません）"));
        }
        out.push((j as u16, val as f32));
    }
    Ok(out)
}

fn parse_game(line: &[u8], map: Option<&[i32]>, n: usize) -> Result<PGame, String> {
    let r: RawLine = serde_json::from_slice(line).map_err(|e| format!("行が読めません: {e}"))?;
    if r.td_layout.is_some() {
        return Err("入力の並びの行が途中にあります".into());
    }
    let empty = || PGame {
        cmp: true,
        g: 0.0,
        decks: [String::new(), String::new()],
        winner: 0.0,
        iv: None,
        samples: [Vec::new(), Vec::new()],
    };
    if r.cmp.is_some() {
        return Ok(empty());
    }
    let decks = match r.decks {
        Some(d) if d.len() == 2 => {
            let mut it = d.into_iter();
            [it.next().expect("デッキ"), it.next().expect("デッキ")]
        }
        _ => return Err("試合の行の \"decks\" が 2 つのデッキ名ではありません".into()),
    };
    let samples = match r.samples {
        Some(s) if s.len() == 2 => s,
        _ => return Err("試合の行の \"samples\" が 2 つの列ではありません".into()),
    };
    let mut out: [Vec<PSample>; 2] = [Vec::new(), Vec::new()];
    for (p, seq) in samples.into_iter().enumerate() {
        out[p] = seq
            .into_iter()
            .map(|x| {
                Ok(PSample {
                    ph: x.ph,
                    s: x.s,
                    sd: x.sd,
                    ex: x.ex.is_some_and(|e| e != 0.0 && !e.is_nan()),
                    qe: x.qe,
                    qr: x.qr,
                    x: remap(&x.x, &x.v, map, n)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        if out[p].iter().any(|x| x.ph > 2) {
            return Err("局面の \"ph\" は 0・1・2".into());
        }
    }
    let iv = match r.iv {
        None => None,
        Some(iv) => Some(PIv {
            p: iv.p as usize,
            k: iv.k,
            card: iv.card.or(iv.res).unwrap_or_default(),
            zone: IvZone::parse(iv.zone.as_deref())?,
            d: iv.d.unwrap_or(0.0),
        }),
    };
    if iv.as_ref().is_some_and(|iv| iv.p > 1) {
        return Err("介入の \"p\" は 0・1".into());
    }
    Ok(PGame {
        cmp: false,
        g: r.g.ok_or("試合の行に \"g\" がありません")?,
        decks,
        winner: r.winner.ok_or("試合の行に \"winner\" がありません")?,
        iv,
        samples: out,
    })
}

// ---- 詰めた局面のデータ ----

/// 入力の値の番号（出てきた値の表 Dataset::table の添字）
pub enum Codes {
    U8(Vec<u8>),
    U16(Vec<u16>),
}

impl Codes {
    #[inline]
    pub fn get(&self, q: usize) -> usize {
        match self {
            Codes::U8(c) => c[q] as usize,
            Codes::U16(c) => c[q] as usize,
        }
    }

    fn push(&mut self, code: usize) {
        if let Codes::U8(c) = self {
            if code > u8::MAX as usize {
                *self = Codes::U16(c.iter().map(|&x| x as u16).collect());
            }
        }
        match self {
            Codes::U8(c) => c.push(code as u8),
            Codes::U16(c) => c.push(code as u16),
        }
    }

    fn shrink(&mut self) {
        match self {
            Codes::U8(c) => c.shrink_to_fit(),
            Codes::U16(c) => c.shrink_to_fit(),
        }
    }

    fn bytes(&self) -> usize {
        match self {
            Codes::U8(c) => c.len(),
            Codes::U16(c) => c.len() * 2,
        }
    }
}

/// 局面の印（Dataset::flags）
pub const F_EXPLORED: u8 = 1;
pub const F_HOLDOUT: u8 = 2;
pub const F_WIN: u8 = 4;
pub const F_IV: u8 = 8;
pub const PHASE_SHIFT: u8 = 4;

/// 介入の対（td-main.ts の IvPair のうち、学習の報告で使う所）
pub struct IvPair {
    pub base: u32,
    pub variant: u32,
    /// 消したカードの ID（資源の介入なら資源の名前）
    pub card: String,
    pub zone: IvZone,
    pub d: f64,
}

/// 出発点の評価 S をどこから読むか（td-main.ts の sSourceOf）
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SSource {
    S,
    Sd,
    Zero,
}

/// 学習用にまとめた局面（td-main.ts の Dataset）
pub struct Dataset {
    /// 局面 i の入力は idx・val の off[i]〜off[i+1]
    pub off: Vec<u32>,
    pub idx: Vec<u16>,
    pub val: Codes,
    /// 入力の値の表（32 ビットの小数。TypeScript 版の Float32Array と同じ値）
    pub table: Vec<f32>,
    /// 出発点の評価 S（SSource::Zero なら空）
    pub s: Vec<f64>,
    pub next: Vec<i32>,
    pub anchor: Vec<i32>,
    pub flags: Vec<u8>,
    /// 探索の値（無ければ NaN。報告だけに使う）
    pub q: Vec<f64>,
    pub pairs: Vec<IvPair>,
}

impl Dataset {
    pub fn len(&self) -> usize {
        self.flags.len()
    }

    pub fn is_empty(&self) -> bool {
        self.flags.is_empty()
    }

    #[inline]
    pub fn s_at(&self, i: usize) -> f64 {
        if self.s.is_empty() {
            0.0
        } else {
            self.s[i]
        }
    }

    #[inline]
    pub fn phase(&self, i: usize) -> u8 {
        self.flags[i] >> PHASE_SHIFT
    }

    #[inline]
    pub fn has(&self, i: usize, f: u8) -> bool {
        self.flags[i] & f != 0
    }

    #[inline]
    pub fn outcome(&self, i: usize) -> f64 {
        if self.has(i, F_WIN) {
            1.0
        } else {
            0.0
        }
    }

    /// 局面 i の入力（行の番号と値）を out に書く
    #[inline]
    pub fn inputs(&self, i: usize, out: &mut Vec<(usize, f64)>) {
        out.clear();
        for q in self.off[i] as usize..self.off[i + 1] as usize {
            out.push((self.idx[q] as usize, self.table[self.val.get(q)] as f64));
        }
    }

    /// 詰めた配列の大きさ（バイト）
    pub fn bytes(&self) -> usize {
        self.off.len() * 4
            + self.idx.len() * 2
            + self.val.bytes()
            + self.s.len() * 8
            + self.next.len() * 4
            + self.anchor.len() * 4
            + self.flags.len()
            + self.q.len() * 8
    }
}

/// 試合（両方の席のデッキの名前）を読まないかを決める関数（--excludeDecks・--onlyDecks）
pub type SkipFn<'a> = dyn Fn(&[String; 2]) -> bool + Sync + 'a;

/// loadData の読み方
pub struct LoadOptions<'a> {
    pub holdout: f64,
    pub iv_weight: f64,
    pub imagined_weight: f64,
    pub iv_res: bool,
    pub search_mix: f64,
    pub s_source: SSource,
    /// 真を返した試合（デッキの組）は読まない（--excludeDecks・--onlyDecks）
    pub skip_game: Option<&'a SkipFn<'a>>,
    /// 入力をこの並び（学ぶモデルの並び）に読み替える
    pub layout: &'a Layout,
    /// 並びの行の無いファイルの並び
    pub fallback: &'a Layout,
}

/// 試合番号で決める確かめ用の試合か（td-main.ts の isHold。ファイルを足しても同じ試合は同じ側）
pub fn is_holdout(g: f64, holdout: f64) -> bool {
    // Math.imul(r.g, 2654435761) >>> 0（r.g は整数）
    let gi = js_to_uint32(g);
    let h = gi.wrapping_mul(2654435761u32);
    ((h % 1000) as f64) / 1000.0 < holdout
}

/// JavaScript の ToUint32
pub fn js_to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    (t.rem_euclid(4294967296.0)) as u32
}

/// ファイルの入力の読み替え。並びの行が無ければ fallback で書いたものとみなす
fn file_map(layout_line: Option<Layout>, to: &Layout, fallback: &Layout) -> Option<Vec<i32>> {
    match layout_line {
        Some(from) => layout_map(&from, to),
        None => layout_map(fallback, to),
    }
}

/// 自己対戦のファイルを読んで詰める（td-main.ts の loadData。--exclude・--seat・場のカードは扱わない）
pub fn load_data(files: &[String], opts: &LoadOptions) -> Result<Dataset, String> {
    let n_in = opts.layout.zones.len() * opts.layout.vocab.len() + opts.layout.scalars.len();
    if n_in > u16::MAX as usize + 1 {
        return Err(format!("入力の数 {n_in} が 65536 を越えています（Rust 版の td train は入力の添字を 16 ビットで持つ）"));
    }
    let mut d = Dataset {
        off: vec![0],
        idx: Vec::new(),
        val: Codes::U8(Vec::new()),
        table: Vec::new(),
        s: Vec::new(),
        next: Vec::new(),
        anchor: Vec::new(),
        flags: Vec::new(),
        q: Vec::new(),
        pairs: Vec::new(),
    };
    let mut code_of: FastMap<u32, usize> = FastMap::default();
    let mut games = 0usize;
    for file in files {
        // もとの試合の各プレイヤーの局面の、試合の中の位置 → 添字（介入の対を作る）。介入の試合はもとの試合のすぐ後の行にある
        let mut pos_of: FastMap<u64, [Vec<i64>; 2]> = FastMap::default();
        read_file(
            file,
            |layout_line| file_map(layout_line, opts.layout, opts.fallback),
            |batch, m| {
                let parsed =
                    parallel_map(&batch, |line, _| parse_game(line, m, n_in), |_, _, _, _| {});
                for r in parsed {
                    let r = r.map_err(|e| format!("{file}: {e}"))?;
                    add_game(&mut d, &mut code_of, &mut pos_of, &mut games, r, opts)?;
                }
                Ok(())
            },
        )?;
    }
    if d.off.len() > 1 && *d.off.last().expect("off") as usize != d.idx.len() {
        return Err("入力の数が 2^32 を越えました（データが大きすぎます）".into());
    }
    d.off.shrink_to_fit();
    d.idx.shrink_to_fit();
    d.val.shrink();
    d.s.shrink_to_fit();
    d.next.shrink_to_fit();
    d.anchor.shrink_to_fit();
    d.flags.shrink_to_fit();
    d.q.shrink_to_fit();
    d.pairs.shrink_to_fit();
    Ok(d)
}

fn add_game(
    d: &mut Dataset,
    code_of: &mut FastMap<u32, usize>,
    pos_of: &mut FastMap<u64, [Vec<i64>; 2]>,
    games: &mut usize,
    r: PGame,
    opts: &LoadOptions,
) -> Result<(), String> {
    if r.cmp {
        return Ok(());
    }
    if let Some(iv) = &r.iv {
        if opts.iv_weight == 0.0 || (iv.zone.is_res() && !opts.iv_res) {
            return Ok(());
        }
    }
    if opts.skip_game.is_some_and(|f| f(&r.decks)) {
        return Ok(());
    }
    *games += 1;
    let hold = if is_holdout(r.g, opts.holdout) {
        F_HOLDOUT
    } else {
        0
    };
    let iv_flag = if r.iv.is_some() { F_IV } else { 0 };
    let mut pos: [Vec<i64>; 2] = [Vec::new(), Vec::new()];
    for (p, seq) in r.samples.iter().enumerate() {
        // 同じプレイヤーの 1 つ前の（想像の局面でない）局面
        let mut prev: i64 = -1;
        for x in seq {
            if x.ph == 2 && (opts.imagined_weight == 0.0 || prev < 0) {
                pos[p].push(-1);
                continue;
            }
            let i = d.flags.len();
            pos[p].push(i as i64);
            for &(j, v) in &x.x {
                d.idx.push(j);
                let bits = v.to_bits();
                let code = match code_of.get(&bits) {
                    Some(&c) => c,
                    None => {
                        let c = d.table.len();
                        if c > u16::MAX as usize {
                            return Err("入力の値の種類が 65536 を越えました".into());
                        }
                        d.table.push(v);
                        code_of.insert(bits, c);
                        c
                    }
                };
                d.val.push(code);
            }
            let end = d.idx.len();
            if end > u32::MAX as usize {
                return Err("入力の数が 2^32 を越えました（データが大きすぎます）".into());
            }
            d.off.push(end as u32);
            match opts.s_source {
                SSource::S => d.s.push(x.s),
                SSource::Sd => match x.sd {
                    Some(sd) => d.s.push(sd),
                    None => {
                        return Err(
                            "出発点が基準の重み（baseWeights が DEFAULT_WEIGHTS）のモデルには、\"sd\" のある自己対戦（svwb td selfplay --sDefault 1）が要ります".into(),
                        )
                    }
                },
                SSource::Zero => {}
            }
            d.next.push(-1);
            let win = if r.winner == p as f64 { F_WIN } else { 0 };
            let ex = if x.ex { F_EXPLORED } else { 0 };
            d.flags
                .push(ex | hold | win | iv_flag | (x.ph << PHASE_SHIFT));
            // 探索の値。ターンの最初の局面には、同じターンのターン末の局面のものを入れる（ランダムに打った局面は除く）
            let qv = match (x.ph, x.qe, x.qr) {
                (0, Some(qe), Some(qr)) => (1.0 - opts.search_mix) * qr + opts.search_mix * qe,
                _ => f64::NAN,
            };
            d.q.push(qv);
            if x.ph == 2 {
                d.anchor.push(prev as i32);
            } else {
                d.anchor.push(-1);
                if prev >= 0 {
                    let pv = prev as usize;
                    d.next[pv] = i as i32;
                    if x.ph == 0 && d.phase(pv) == 1 && !d.has(pv, F_EXPLORED) {
                        d.q[pv] = qv;
                    }
                }
                prev = i as i64;
            }
            if i >= i32::MAX as usize {
                return Err("局面の数が 2^31 を越えました（データが大きすぎます）".into());
            }
        }
    }
    let gk = r.g.to_bits();
    match &r.iv {
        Some(iv) => {
            let base = pos_of.get(&gk).and_then(|ps| ps[iv.p].get(iv.k).copied());
            let variant = pos[iv.p].first().copied();
            if let (Some(base), Some(variant)) = (base, variant) {
                if base >= 0 && variant >= 0 {
                    d.pairs.push(IvPair {
                        base: base as u32,
                        variant: variant as u32,
                        card: iv.card.clone(),
                        zone: iv.zone,
                        d: iv.d,
                    });
                }
            }
        }
        None => {
            pos_of.insert(gk, pos);
        }
    }
    Ok(())
}

/// データに現れた入力（td-main.ts の prune の used。--exclude・--seat は扱わない）。返すのは添字ごとの印
pub fn used_inputs(
    files: &[String],
    layout: &Layout,
    skip_game: Option<&SkipFn<'_>>,
) -> Result<Vec<bool>, String> {
    let n_in = layout.zones.len() * layout.vocab.len() + layout.scalars.len();
    let threads = thread_count();
    let mut used = vec![false; n_in];
    for file in files {
        read_file(
            file,
            |layout_line| file_map(layout_line, layout, layout),
            |batch, m| {
                // 行をスレッドの数に分け、それぞれ現れた入力の印を作ってから合わせる（印の和なので順番によらない）
                let chunks: Vec<&[Vec<u8>]> =
                    batch.chunks(batch.len().div_ceil(threads).max(1)).collect();
                let marks = parallel_map(
                    &chunks,
                    |lines, _| -> Result<Vec<u32>, String> {
                        let mut seen = Vec::new();
                        for line in lines.iter() {
                            let r: RawLineX = serde_json::from_slice(line)
                                .map_err(|e| format!("{file}: 行が読めません: {e}"))?;
                            if r.td_layout.is_some() {
                                return Err(format!("{file}: 入力の並びの行が途中にあります"));
                            }
                            if r.cmp.is_some() {
                                continue;
                            }
                            let decks = match r.decks {
                                Some(d) if d.len() == 2 => [d[0].clone(), d[1].clone()],
                                _ => {
                                    return Err(format!(
                                    "{file}: 試合の行の \"decks\" が 2 つのデッキ名ではありません"
                                ))
                                }
                            };
                            if skip_game.is_some_and(|f| f(&decks)) {
                                continue;
                            }
                            for seq in r.samples.unwrap_or_default() {
                                for x in seq {
                                    for i in x.x {
                                        let j = match m {
                                            Some(m) => match m.get(i as usize) {
                                                Some(&j) if j >= 0 => j as u32,
                                                _ => continue,
                                            },
                                            None => i,
                                        };
                                        seen.push(j);
                                    }
                                }
                            }
                        }
                        Ok(seen)
                    },
                    |_, _, _, _| {},
                );
                for s in marks {
                    for j in s? {
                        match used.get_mut(j as usize) {
                            Some(u) => *u = true,
                            None => {
                                return Err(format!(
                                    "{file}: 入力の添字 {j} がモデルの入力の数 {n_in} を越えています（自己対戦の入力の並びとモデルが合いません）"
                                ))
                            }
                        }
                    }
                }
                Ok(())
            },
        )?;
    }
    Ok(used)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holdout_matches_typescript() {
        // ((Math.imul(g, 2654435761) >>> 0) % 1000) / 1000（Node で出した値）
        assert!(!is_holdout(6390001.0, 0.1)); // 0.609
        assert!(!is_holdout(6390004.0, 0.1)); // 0.3
        assert!(is_holdout(6390002.0, 0.1)); // 0.074
        assert!(!is_holdout(6390002.0, 0.074)); // ちょうど 0.074 は確かめ用にしない（<）
        assert_eq!(js_to_uint32(-1.0), 4294967295);
        assert_eq!(js_to_uint32(4294967297.0), 1);
    }

    #[test]
    fn layout_map_drops_missing() {
        let from = Layout {
            vocab: vec!["a".into(), "b".into()],
            zones: vec!["myHand".into(), "myBoard".into()],
            scalars: vec!["myHp".into(), "oppHp".into()],
        };
        let to = Layout {
            vocab: vec!["b".into(), "c".into(), "a".into()],
            zones: vec!["myBoard".into()],
            scalars: vec!["oppHp".into()],
        };
        assert_eq!(layout_map(&from, &from), None);
        // from: myHand a=0 b=1, myBoard a=2 b=3, myHp 4, oppHp 5 → to: myBoard b=0 c=1 a=2, oppHp 3
        assert_eq!(layout_map(&from, &to), Some(vec![-1, -1, 2, 0, -1, 3]));
    }
}
