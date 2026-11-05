//! 相手が持っていればリーサルだったカードを、相手の手札の読みから外す（lethalRead。
//! docs/ai-notes.md「見逃したリーサルから相手の手札を絞る」）。
//!
//! 相手 q のターンの始め（ターン開始に引いた後の最初の手番）に、q の伏せた手札をカード x 1 枚だけにした局面で、
//! q がそのターンに確実に勝てる（q の AI と同じリーサル探索が見つける）なら、x は「持っていればリーサル」のカード。
//! q がそのターンに勝たなかったなら、そのとき q の手札にあったカードはどれも x ではない（手札が多いほどできることは増えるので、
//! 伏せたカードを外した局面で勝てるなら、本当の手札でも勝てる）。その後に引いたカードは x でありうる。

use super::damage_bound::damage_bound;
use super::determinize::determinize;
use super::exact_lethal::with_isolated_cache;
use super::lethal::{find_lethal_line, LethalSearch};
use super::Rng;
use crate::data::CardIdx;
use crate::state::*;

/// 局面 s（q = opponent(viewer) の手番。選択待ちでないメインフェイズ）で、q の伏せた手札をカード x 1 枚だけにしたとき
/// q がこのターンに確実に勝てる x の一覧（カードの番号の昇順）。viewer から見える情報だけを使う（伏せた手札・山札は seed で並べ直す）。
/// search は q の AI と同じリーサル探索（ビーム → 全探索）。samples は find_lethal_line と同じ（並べ直した山札で確かめる数）。
/// 伏せた手札が無くても勝てる局面では空
pub fn lethal_threats(
    s: &GameState,
    viewer: PlayerIndex,
    seed: u32,
    samples: usize,
    search: LethalSearch,
) -> Vec<CardIdx> {
    let q = opponent(viewer);
    if s.phase != Phase::Main || s.active != q || s.pending.is_some() {
        return Vec::new();
    }
    let mut r = Rng::new(seed);
    let det = determinize(s, viewer, &mut r, false);
    let opp = &det.players[q];
    let mut cands: Vec<CardIdx> = opp
        .hand
        .iter()
        .filter(|h| !h.revealed)
        .map(|h| h.card)
        .chain(opp.deck.iter().map(|c| c.card))
        .chain(opp.hidden_discards.iter().copied())
        .collect();
    cands.sort_unstable();
    cands.dedup();
    let mut base = det;
    base.players[q].hand.make_mut().retain(|h| h.revealed);
    if base.players[q].hand.len() >= HAND_LIMIT {
        return Vec::new();
    }
    let hp = base.players[viewer].leader_hp;
    // 全探索は、本当の手番のメモ・上限とは別に、この調べ全体で 1 ターン分の上限（sure_lethal_options の 2 倍）まで
    with_isolated_cache(|| {
        // 伏せたカードが無くても勝てるなら、どのカードについても分からない
        if find_lethal_line(&base, q, &mut r, samples, search).is_some() {
            return Vec::new();
        }
        let mut out = Vec::new();
        for x in cands {
            let mut t = base.clone();
            let h = t.new_hand_card(x, None);
            t.players[q].hand.make_mut().push(h);
            if damage_bound(&t, q, true).is_some_and(|b| b < hp) {
                continue;
            }
            if find_lethal_line(&t, q, &mut r, samples, search).is_some() {
                out.push(x);
            }
        }
        out
    })
}

/// 決定化で、相手の伏せた手札の枠（iid）ごとに配らないカード（lethalRead。determinize_read）。
/// 外すカードの多い枠から先に並べる
#[derive(Clone, Debug, Default)]
pub struct HandReading {
    pub excluded: Vec<(Iid, Vec<CardIdx>)>,
}

/// 相手の伏せた手札の読みを、見た局面ごとに更新する（見る側 1 人分）。
///
/// 伏せた手札を古い順に並べ、枠ごとに「持っていればリーサル」で外したカードの集まりを持つ。相手のターンの始めに調べたカードを、
/// そのとき手札にある枠すべてに足し、後から手札に入った枠は空から始める（古い枠ほど集まりが大きい）。
/// 相手が手札の何枚目を出したかは分からないので、伏せたカードが手札から出たら、出たのは集まりの最も大きい（古い）枠だったものとして外す
/// （外せるカードを少なく見るほうに倒す。手札に入った・出た枚数は相手にも分かる）
#[derive(Clone, Debug)]
pub struct OppHandTracker {
    /// 古い順の、枠ごとの外したカード（昇順）
    bag: Vec<Vec<CardIdx>>,
    /// 最後に見た局面の、相手の伏せた手札の iid（出入りの枚数を数える用）
    last: Vec<Iid>,
    /// 最後に調べたターン
    checked_turn: i32,
}

impl Default for OppHandTracker {
    fn default() -> Self {
        OppHandTracker {
            bag: Vec::new(),
            last: Vec::new(),
            checked_turn: -1,
        }
    }
}

fn hidden_iids(s: &GameState, q: PlayerIndex) -> Vec<Iid> {
    s.players[q]
        .hand
        .iter()
        .filter(|h| !h.revealed)
        .map(|h| h.iid)
        .collect()
}

impl OppHandTracker {
    /// 局面 s を viewer から見て、相手の伏せた手札の出入りを数える。s が相手のターンの始め（選択待ちでない最初の相手の手番）で、
    /// まだ調べていないターンなら、threats（lethal_threats）で調べたカードを、今の伏せた手札の枠すべてに足す
    pub fn observe(
        &mut self,
        s: &GameState,
        viewer: PlayerIndex,
        threats: impl FnOnce(&GameState) -> Vec<CardIdx>,
    ) {
        let q = opponent(viewer);
        let now = hidden_iids(s, q);
        let left = self.last.iter().filter(|i| !now.contains(i)).count();
        let entered = now.iter().filter(|i| !self.last.contains(i)).count();
        self.bag.drain(..left.min(self.bag.len()));
        self.bag.extend((0..entered).map(|_| Vec::new()));
        // 見ていない間の出入りで数が合わなくなったら、古い枠から外す・空の枠を足す
        if self.bag.len() > now.len() {
            let extra = self.bag.len() - now.len();
            self.bag.drain(..extra);
        }
        while self.bag.len() < now.len() {
            self.bag.push(Vec::new());
        }
        self.last = now;
        if s.phase == Phase::Main
            && s.active == q
            && s.pending.is_none()
            && s.turn != self.checked_turn
        {
            self.checked_turn = s.turn;
            let found = threats(s);
            if !found.is_empty() {
                for e in self.bag.iter_mut() {
                    e.extend(found.iter().copied());
                    e.sort_unstable();
                    e.dedup();
                }
            }
        }
    }

    /// 局面 s（最後に observe した局面）の決定化に使う読み。外すカードのある枠が無ければ None。
    /// 古い枠の集まりを、伏せた手札の並び（手札に入った順）の前から当てる
    pub fn reading(&self, s: &GameState, viewer: PlayerIndex) -> Option<HandReading> {
        let q = opponent(viewer);
        let excluded: Vec<(Iid, Vec<CardIdx>)> = s.players[q]
            .hand
            .iter()
            .filter(|h| !h.revealed)
            .zip(&self.bag)
            .filter(|(_, e)| !e.is_empty())
            .map(|(h, e)| (h.iid, e.clone()))
            .collect();
        (!excluded.is_empty()).then_some(HandReading { excluded })
    }
}
