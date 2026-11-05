//! ターン途中の局面の、そこで終えた点数の予想と伸びしろの上側を 1 つで出す小さなネットワーク（`boundsNet`、2026-11-05）。
//!
//! 木の探索の案 A'（ai/search/tree.rs の `lazy`）が、子の局面を正確に採点する（合流する相打ち・ターン終了時の処理・評価の補正）代わりに、
//! これで点数を予想して広げる順番を決め、正確な点数はその局面を広げるときに初めて計算する。
//! 入力は見込みのネットワーク（ai/potential.rs）と同じ。隠れ層 1 つ（ReLU）から 2 つの出力:
//! 終えた点数の予想 v̂ = scale × o1 と、伸びしろ（届く最善 − 終えた点数）の tau 分位点の予想 û = scale × softplus(o2)。
//! 学習は `npm run potential -- bounds`（scripts/potential-main.ts）、データは `svwb beam-gap --sample k --inputs`。

use super::potential::{PotentialEncoder, P_SCALARS, P_ZONES};
use crate::state::{GameState, PlayerIndex};
use serde::Deserialize;
use std::cell::RefCell;

/// モデルのファイルの形（scripts/potential-main.ts の bounds が書く）
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RawBoundsNet {
    kind: String,
    version: u32,
    vocab: Vec<String>,
    zones: Vec<String>,
    scalars: Vec<String>,
    hidden: usize,
    w1: Vec<f64>,
    b1: Vec<f64>,
    wv: Vec<f64>,
    bv: f64,
    wu: Vec<f64>,
    bu: f64,
    scale: f64,
    tau: f64,
}

pub struct BoundsNet {
    enc: PotentialEncoder,
    hidden: usize,
    w1: Vec<f64>,
    b1: Vec<f64>,
    wv: Vec<f64>,
    bv: f64,
    wu: Vec<f64>,
    bu: f64,
    scale: f64,
    pub tau: f64,
}

type Buf = (Vec<(usize, f64)>, Vec<f64>);

thread_local! {
    static BUF: RefCell<Buf> = const { RefCell::new((Vec::new(), Vec::new())) };
}

impl BoundsNet {
    pub fn load(path: &str) -> Result<BoundsNet, String> {
        let text =
            std::fs::read_to_string(path).map_err(|e| format!("{path} を読めません: {e}"))?;
        let raw: RawBoundsNet = serde_json::from_str(&text)
            .map_err(|e| format!("{path} は下限と上限のネットワークではありません: {e}"))?;
        if raw.kind != "bounds-net" || raw.version != 1 {
            return Err(format!("{path}: kind・version が違います"));
        }
        if raw.zones != P_ZONES || raw.scalars != P_SCALARS {
            return Err(format!("{path}: 入力の並びが今のコードと違います"));
        }
        let enc = PotentialEncoder::new(&raw.vocab);
        let n = enc.n_inputs();
        let h = raw.hidden;
        if raw.w1.len() != n * h || raw.b1.len() != h || raw.wv.len() != h || raw.wu.len() != h {
            return Err(format!("{path}: 重みの大きさが合いません"));
        }
        Ok(BoundsNet {
            enc,
            hidden: h,
            w1: raw.w1,
            b1: raw.b1,
            wv: raw.wv,
            bv: raw.bv,
            wu: raw.wu,
            bu: raw.bu,
            scale: raw.scale,
            tau: raw.tau,
        })
    }

    /// 局面 s（p の手番の途中）の、そこで終えた点数の予想と伸びしろの上側の予想
    pub fn eval(&self, s: &GameState, p: PlayerIndex) -> (f64, f64) {
        let hn = self.hidden;
        BUF.with(|buf| {
            let (x, h) = &mut *buf.borrow_mut();
            self.enc.encode(s, p, x);
            h.clear();
            h.extend_from_slice(&self.b1);
            for &(i, v) in x.iter() {
                for (hj, &w) in h.iter_mut().zip(&self.w1[i * hn..i * hn + hn]) {
                    *hj += v * w;
                }
            }
            let (mut ov, mut ou) = (self.bv, self.bu);
            for ((&hj, &a), &b) in h.iter().zip(&self.wv).zip(&self.wu) {
                if hj > 0.0 {
                    ov += hj * a;
                    ou += hj * b;
                }
            }
            let softplus = if ou > 20.0 { ou } else { ou.exp().ln_1p() };
            (self.scale * ov, self.scale * softplus)
        })
    }
}
