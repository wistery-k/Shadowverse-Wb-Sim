//! 実際の試合でクレストの能力が誘発した回数の記録（`svwb profile` が数える。runner/profile.rs）。
//!
//! `start` から `take` までの間に、クレストの能力が誘発して解決を待つ列に入るたびに 1 件残す。profile は実際の試合の
//! 手を打つ（apply_action）前後だけで呼ぶので、AI の読みの中で打った手は数えない。記録はスレッドごと。
//! 数えるだけで、試合（状態・乱数）は変えない。`start` していないときは、誘発のたびにスレッドの旗を 1 回見るだけ。

use crate::data::CrestIdx;
use crate::state::PlayerIndex;
use std::cell::{Cell, RefCell};

/// 誘発した 1 件
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fired {
    /// クレストを持つプレイヤー
    pub player: PlayerIndex,
    pub crest: CrestIdx,
    /// そのクレストの能力の何番目か（能力の定義の順、0 から）
    pub ability: u8,
    /// 誘発したのが、クレストを持つプレイヤーのターンか
    pub own_turn: bool,
}

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static LOG: RefCell<Vec<Fired>> = const { RefCell::new(Vec::new()) };
}

/// 記録を始める（前の記録は消す）
pub fn start() {
    LOG.with_borrow_mut(|v| v.clear());
    ON.set(true);
}

/// 記録をやめて、`start` からの分を取り出す
pub fn take() -> Vec<Fired> {
    ON.set(false);
    LOG.take()
}

/// クレストの能力が誘発した（effects.rs の fire_side が呼ぶ）
pub fn note(player: PlayerIndex, crest: CrestIdx, ability: usize, own_turn: bool) {
    if ON.get() {
        LOG.with_borrow_mut(|v| {
            v.push(Fired {
                player,
                crest,
                ability: ability as u8,
                own_turn,
            })
        });
    }
}
