//! 探索 AI 等（TypeScript 版 src/ai の移植）。同じ局面・同じ乱数なら同じ手を選ぶ（ゴールデンテストの ai-* で確かめる）。
//!
//! 浮動小数点の足し算の順番、Map の挿入順、安定な並べ替え、厳密な `>` の比較まで TypeScript 版に合わせて移した。
//! テストは tests/（`cargo test --release`）。

pub mod aidata;
pub mod beam_key;
pub mod converging;
pub mod damage_bound;
pub mod determinize;
pub mod eval;
pub mod exact_lethal;
pub mod fusion;
pub mod greedy;
pub mod keys;
pub mod lethal;
pub mod lethal_hint;
pub mod mulligan;
pub mod potential;
pub mod registry;
pub mod rhino;
pub mod rhino_lethal;
pub mod search;
pub mod think;
pub mod valuenet;

#[cfg(test)]
mod tests;

use crate::state::{next_random, Action, GameState};

/// AI の乱数（TypeScript 版の rngFrom と同じ mulberry32）
pub struct Rng {
    pub state: u32,
}

impl Rng {
    pub fn new(seed: u32) -> Rng {
        Rng { state: seed }
    }
    /// [0, n) の整数
    #[inline]
    pub fn int(&mut self, n: usize) -> usize {
        let (v, next) = next_random(self.state);
        self.state = next;
        (v * n as f64).floor() as usize
    }
    /// Fisher-Yates でその場でシャッフルする
    pub fn shuffle<T>(&mut self, arr: &mut [T]) {
        let mut i = arr.len();
        while i > 1 {
            i -= 1;
            let j = self.int(i + 1);
            arr.swap(i, j);
        }
    }
}

/// 32 ビットの値をよく混ぜる（lowbias32）
#[inline]
fn mix32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

/// いくつかの値から乱数の種を作る（同じ値の並びなら同じ種。並びのどれかが違えば別の種）。
/// AI の思考用の乱数を、取った順番でなく用途から作るのに使う（2026-11-10 から。src/engine/rng.ts の seedOf と同じ）
pub fn seed_of(parts: &[u32]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &x in parts {
        h = mix32(h ^ x).wrapping_add(0x9e37_79b9);
    }
    mix32(h)
}

/// AI の思考用の乱数の用途（seed_of の並びの先頭か 2 つ目に入れる）。番号は変えない（変えると AI の手が変わる）
pub mod purpose {
    /// 試合の中の判断（試合のシード・席・ターン・そのターンで何回目の判断か。sim.rs の MatchRng）
    pub const DECISION: u32 = 1;
    /// リーサル探索の決定化
    pub const LETHAL: u32 = 2;
    /// 自分のターンを探索する前の決定化（何番目の決定化か）
    pub const DETERMINIZE: u32 = 3;
    /// 決定化した局面の探索（plan_turn。何番目の決定化か）
    pub const PLAN: u32 = 4;
    /// 探索で手が選べなかったときの貪欲法
    pub const GREEDY: u32 = 5;
    /// マリガン
    pub const MULLIGAN: u32 = 6;
    /// 読み直しの相手の手札の引き直し（oppHandCommon。何番目の引き直しか）
    pub const OPP_HAND: u32 = 7;
    /// drawSplit で引きを作り直す種（何番目か）
    pub const SPLIT: u32 = 8;
    /// drawSplit の enumerate で山札の残りを並べ直す種の元
    pub const SPLIT_ENUM: u32 = 9;
    /// 終局面ごとに引き直す読み直し（oppHandCommon でないとき・引き直し 1 回のとき。終局面の番号と何番目か）
    pub const READ: u32 = 10;
}

/// 用途 purpose の i 番目に使う乱数（base はその判断・その探索で 1 つ取った種）
pub fn purpose_rng(base: u32, purpose: u32, i: u32) -> Rng {
    Rng::new(seed_of(&[base, purpose, i]))
}

/// 用途 purpose の i 番目に使う乱数で f を呼ぶ。base が None なら古い取り方（2026-11-10 より前。物差しの相手）で、rng をそのまま順に使う
pub fn with_purpose_rng<T>(
    rng: &mut Rng,
    base: Option<u32>,
    purpose: u32,
    i: u32,
    f: impl FnOnce(&mut Rng) -> T,
) -> T {
    match base {
        Some(b) => f(&mut purpose_rng(b, purpose, i)),
        None => f(rng),
    }
}

/// AI の共通インターフェース（src/ai/types.ts の Agent）
pub trait Agent {
    fn choose_action(&mut self, state: &GameState, legal: &[Action], rng: &mut Rng) -> Action;

    /// 試合の中で、AI の思考用の乱数を 1 試合に 1 本、両方の席が順に使う古い取り方にするか（2026-11-10 より前。
    /// 物差しの相手の手を変えないため。sim.rs の MatchRng）。false なら判断ごとに試合のシード・席・ターン・そのターンで何回目の判断かから作る
    fn sequential_rng(&self) -> bool {
        false
    }

    /// この局面での考え（比べた手と点数の内訳。think.rs）。choose_action と同じ乱数の使い方で同じ手を選ぶ。
    /// 考えを示せない AI・局面（マリガン、打てる手が 1 つ）は None
    fn think(
        &mut self,
        _state: &GameState,
        _legal: &[Action],
        _rng: &mut Rng,
    ) -> Option<think::Thought> {
        None
    }
}

/// 合法手から一様ランダムに選ぶ
pub struct RandomAgent;

impl Agent for RandomAgent {
    fn choose_action(&mut self, _state: &GameState, legal: &[Action], rng: &mut Rng) -> Action {
        legal[rng.int(legal.len())].clone()
    }
}
