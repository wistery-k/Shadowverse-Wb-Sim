//! Shadowverse: Worlds Beyond 非公式対戦シミュレータのエンジンと AI。ブラウザでは WASM（rust/wasm）にして使う。
//!
//! 同じシード＋同じ行動列なら同じ結果になる。振る舞いが変わっていないかはゴールデンテスト（src/golden.rs）で確かめる。
//! カードのデータと能力の定義は TypeScript 側（src/cards）から `npm run rust-data` で書き出したものを埋め込む。
//!
//! もとは TypeScript で書いたエンジン（src/engine）と AI（src/ai）を移したもので、段階 4 で TypeScript 版を消した
//! （main の d0dd121 までにある）。コメントの「TypeScript 版」や `src/ai/search.ts` 等の名前はその版を指す。
//! 処理の順番・乱数を引く順・浮動小数の足し算の順番などがその版に合わせてあることの説明として残している。

pub mod ai;
pub mod canonical;
pub mod data;
pub mod effects;
pub mod fasthash;
pub mod game;
pub mod golden;
pub mod jsnum;
pub mod json;
pub mod runner;
pub mod sim;
pub mod state;
pub mod state_json;

pub use game::{
    acting_player, apply_action, apply_in_place, apply_legal, create_game, is_legal, legal_actions,
    resolve_turn_end, try_apply_action,
};
pub use state::{Action, GameState, Phase};
