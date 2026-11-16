//! 実際の試合で起きたことの記録（棋譜を打ち直して出来事の列にする replay_index.rs が使う。形は docs/kifu.md「出来事」）。
//!
//! `start` から `take` までの間に、エンジンの決まった所（effects.rs・state.rs）で起きたことを 1 件ずつ残す。
//! 打ち直しは実際の試合の手を 1 手ずつ打つ（apply_action）前後だけで呼ぶので、AI の読みの中で打った手は入らない。記録はスレッドごと。
//! 残すだけで、試合（状態・乱数）は変えない。`start` していないときは、残す所でスレッドの旗を 1 回見るだけ。
//! エンジンの中の数える口はここだけにする（調べ物は棋譜を打ち直して数える。runner/kifu_cmd.rs）。

use crate::data::{CardIdx, CrestIdx};
use crate::state::{Iid, PlayerIndex};
use std::cell::{Cell, RefCell};

/// 能力の元
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Src {
    Card(CardIdx),
    Crest(CrestIdx),
}

/// 場を離れた理由
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Leave {
    Destroy,
    Banish,
    Bounce,
}

/// 起きたこと 1 件
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ev {
    /// 能力が誘発して、解決を待つ列に入った（クレスト・場・手札の能力、ラストワード、場に出たとき・進化したとき・捨てられたとき 等）。
    /// ファンファーレ・スペル・アクト・融合など、プレイや行動そのものの能力は入らない（行動の出来事で分かる）。
    /// 誘発は能力の条件（引いたカードのコストなど）に合って列に入った数で、効果の中の条件（「自分のターンなら」など）は見ない
    Trigger {
        /// 能力を持つプレイヤー
        p: PlayerIndex,
        src: Src,
        /// 元の場のカード・手札・クレストの iid
        iid: Iid,
        /// 元の能力の定義の何番目か（0 から。ほかのカードから得た能力は None）
        ability: Option<u8>,
        /// 誘発したのが p のターンか
        own_turn: bool,
    },
    /// 山札から手札に引いた（filtered は条件付きで山札から探して引いたもの。burned は手札が上限で墓場に行ったもの）
    Draw {
        p: PlayerIndex,
        card: CardIdx,
        filtered: bool,
        burned: bool,
    },
    /// 引く以外で手札に加えた（作った・場から戻った 等。burned は手札が上限で墓場に行ったもの）
    AddHand {
        p: PlayerIndex,
        card: CardIdx,
        burned: bool,
    },
    /// ダメージ（実際に減った量。0 は残さない）。card が None ならリーダー。p は受けた側
    Damage {
        p: PlayerIndex,
        card: Option<CardIdx>,
        iid: Option<Iid>,
        amount: i32,
    },
    /// 回復（実際に増えた量。0 も残す。リーダーの「回復したとき」は 0 でも働くので）。card が None ならリーダー
    Heal {
        p: PlayerIndex,
        card: Option<CardIdx>,
        iid: Option<Iid>,
        amount: i32,
    },
    /// 場を離れた（理由つき。p は持ち主）
    Left {
        p: PlayerIndex,
        card: CardIdx,
        iid: Iid,
        why: Leave,
    },
}

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static LOG: RefCell<Vec<Ev>> = const { RefCell::new(Vec::new()) };
}

/// 記録を始める（前の記録は消す）
pub fn start() {
    LOG.with_borrow_mut(|v| v.clear());
    ON.set(true);
}

/// 記録をやめて、`start` からの分を取り出す
pub fn take() -> Vec<Ev> {
    ON.set(false);
    LOG.take()
}

/// 記録しているか（残す値を作るのに手間がかかる所で先に見る）
#[inline]
pub fn on() -> bool {
    ON.get()
}

/// 1 件残す
#[inline]
pub fn note(ev: Ev) {
    if ON.get() {
        LOG.with_borrow_mut(|v| v.push(ev));
    }
}
