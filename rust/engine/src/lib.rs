//! Shadowverse: Worlds Beyond 非公式対戦シミュレータのエンジン（TypeScript 版 src/engine の Rust 移植）。
//!
//! 同じシード＋同じ行動列で TypeScript 版と同じ結果になる（`svwb diff` で確かめる）。
//! カードのデータと能力の定義は TypeScript 側から `npm run rust-data` で書き出したものを埋め込む。

pub mod ai;
pub mod canonical;
pub mod data;
pub mod effects;
pub mod game;
pub mod runner;
pub mod sim;
pub mod state;

pub use game::{
    acting_player, apply_action, apply_in_place, apply_legal, create_game, is_legal, legal_actions,
    resolve_turn_end, try_apply_action,
};
pub use state::{Action, GameState, Phase};
