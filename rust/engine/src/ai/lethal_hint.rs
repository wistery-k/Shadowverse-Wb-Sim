//! 対戦画面の「リーサル」表示と「リーサルを取る」ボタン用（src/ai/lethalHint.ts）: 人間のプレイヤーから見て、このターンに確実に勝てる手順を探す。
//! AI と同じく実際の局面は先読みせず、決定化した局面で探して、別のサンプルでも勝てるかを確かめる。
//! 探索は守護の奥の打点を数える汎用のビームサーチ（GUARDED_LETHAL_OPTIONS）→ リノセウス用 AI と同じ探索（汎用のビームサーチ → リノセウス専用 → 全探索。リノセウスが無いデッキでは汎用のものだけ）
//! → 乱数に依らない手だけの全探索（局面数 HINT_EXACT_STATES まで。エンハンス 10 のクオンで貴人を大きくする手順など、ビームの途中の点数では見えないもの）。

use super::exact_lethal::{search_exact_lethal, sure_lethal_options, HINT_EXACT_STATES};
use super::lethal::{
    find_lethal_line, search_lethal, DEFAULT_LETHAL_OPTIONS, GUARDED_LETHAL_OPTIONS,
};
use super::rhino::search_lethal_for_rhino_turn;
use super::Rng;
use crate::state::{Action, GameState, Phase, PlayerIndex};

pub fn lethal_hint(real: &GameState, p: PlayerIndex, seed: u32) -> Option<Vec<Action>> {
    if real.phase != Phase::Main || real.active != p {
        return None;
    }
    let mut rng = Rng::new(seed);
    find_lethal_line(
        real,
        p,
        &mut rng,
        DEFAULT_LETHAL_OPTIONS.samples,
        &|s: &GameState, q: PlayerIndex| {
            search_lethal(s, q, &GUARDED_LETHAL_OPTIONS)
                .or_else(|| search_lethal_for_rhino_turn(s, q))
                .or_else(|| search_exact_lethal(s, q, &sure_lethal_options(HINT_EXACT_STATES)))
        },
    )
    .map(|l| l.steps)
}
