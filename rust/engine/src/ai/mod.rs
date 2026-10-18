//! 探索 AI 等（TypeScript 版 src/ai の移植）。同じ局面・同じ乱数なら同じ手を選ぶ（ゴールデンテストの ai-* で確かめる）。
//!
//! 浮動小数点の足し算の順番、Map の挿入順、安定な並べ替え、厳密な `>` の比較まで TypeScript 版に合わせて移した。
//! テストは tests/（`cargo test --release`）。

pub mod aidata;
pub mod converging;
pub mod damage_bound;
pub mod determinize;
pub mod eval;
pub mod exact_lethal;
pub mod greedy;
pub mod keys;
pub mod lethal;
pub mod lethal_hint;
pub mod mulligan;
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

/// AI の共通インターフェース（src/ai/types.ts の Agent）
pub trait Agent {
    fn choose_action(&mut self, state: &GameState, legal: &[Action], rng: &mut Rng) -> Action;

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
