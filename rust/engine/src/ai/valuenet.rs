//! 学習した評価の補正（src/ai/valueNet.ts の encodeState・forwardValueNet・valueNetExtraEval）。

use super::aidata::ai_data;
use crate::state::*;
use std::cell::RefCell;

const ZONES: [&str; 10] = [
    "myHand",
    "myHandBoost",
    "myBoard",
    "myBoardCountdown",
    "myBoardEvolved",
    "myCrest",
    "oppBoard",
    "oppBoardEvolved",
    "oppCrest",
    "oppHandRevealed",
];
const SCALARS: [&str; 21] = [
    "myHp",
    "oppHp",
    "myMaxPp",
    "oppMaxPp",
    "myTurn",
    "oppTurn",
    "myPp",
    "myEp",
    "mySep",
    "oppEp",
    "oppSep",
    "myExtraPp",
    "oppExtraPp",
    "myHandSize",
    "oppHandSize",
    "myDeck",
    "oppDeck",
    "myGraveyard",
    "oppGraveyard",
    "after",
    "first",
];

/// 評価する局面の種類（end: 自分のターン末、after: 相手のターンを読んだ後）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ValuePhase {
    End,
    After,
}

fn check() {
    let vn = &ai_data().value_net;
    assert!(
        vn.kind == "td-value-net" && vn.version == 1,
        "ValueNetModel の kind・version が違います"
    );
    assert!(
        vn.zones.iter().map(|s| s.as_str()).eq(ZONES)
            && vn.scalars.iter().map(|s| s.as_str()).eq(SCALARS),
        "ValueNetModel の入力の並びが今のコードと違います"
    );
    let n = ZONES.len() * vn.vocab.len() + SCALARS.len();
    assert!(
        vn.w1.len() == n * vn.hidden && vn.b1.len() == vn.hidden && vn.w2.len() == vn.hidden,
        "ValueNetModel の重みの大きさが合いません"
    );
    assert!(
        vn.base_weights.is_empty(),
        "data/value-net.json は baseWeights なしのモデルの想定です"
    );
}

/// 疎な入力（添字と値。TypeScript 版の Map と同じく、最初に現れた順）
struct Acc(Vec<(usize, f64)>);

impl Acc {
    #[inline]
    fn add(&mut self, i: usize, v: f64) {
        match self.0.iter_mut().find(|(k, _)| *k == i) {
            Some(e) => e.1 += v,
            None => self.0.push((i, v)),
        }
    }
    #[inline]
    fn set(&mut self, i: usize, v: f64) {
        match self.0.iter_mut().find(|(k, _)| *k == i) {
            Some(e) => e.1 = v,
            None => self.0.push((i, v)),
        }
    }
}

fn encode(s: &GameState, p: PlayerIndex, phase: ValuePhase, acc: &mut Acc) {
    let ad = ai_data();
    let v = ad.value_net.vocab.len();
    let card_k = |c: crate::data::CardIdx| ad.vocab_card[c as usize];
    let mut add = |zone: usize, k: Option<usize>, x: f64| {
        if let Some(k) = k {
            if x != 0.0 {
                acc.add(zone * v + k, x);
            }
        }
    };
    let me = &s.players[p];
    let opp = &s.players[opponent(p)];
    for h in &me.hand {
        add(0, card_k(h.card), 1.0);
        add(1, card_k(h.card), h.boosts.min(10) as f64 / 5.0);
    }
    for c in &me.board {
        add(2, card_k(c.card), 1.0);
        if !c.is_follower {
            if let Some(cd) = c.countdown {
                add(3, card_k(c.card), cd as f64 / 3.0);
            }
        }
        if c.is_follower && c.evolve != Evolve::None {
            add(4, card_k(c.card), 1.0);
        }
    }
    for c in &me.crests {
        add(5, ad.vocab_crest[c.crest as usize], 1.0);
    }
    for c in &opp.board {
        add(6, card_k(c.card), 1.0);
        if c.is_follower && c.evolve != Evolve::None {
            add(7, card_k(c.card), 1.0);
        }
    }
    for c in &opp.crests {
        add(8, ad.vocab_crest[c.crest as usize], 1.0);
    }
    for h in &opp.hand {
        if h.revealed {
            add(9, card_k(h.card), 1.0);
        }
    }
    let base = ZONES.len() * v;
    let b = |x: bool| if x { 1.0 } else { 0.0 };
    let scalars: [f64; 21] = [
        me.leader_hp as f64 / 20.0,
        opp.leader_hp as f64 / 20.0,
        me.max_pp as f64 / 10.0,
        opp.max_pp as f64 / 10.0,
        me.turn_count as f64 / 10.0,
        opp.turn_count as f64 / 10.0,
        me.pp as f64 / 10.0,
        me.ep as f64 / 3.0,
        me.sep as f64 / 2.0,
        opp.ep as f64 / 3.0,
        opp.sep as f64 / 2.0,
        b(me.extra_pp_available),
        b(opp.extra_pp_available),
        me.hand.len() as f64 / 9.0,
        opp.hand.len() as f64 / 9.0,
        me.deck.len() as f64 / 40.0,
        opp.deck.len() as f64 / 40.0,
        me.graveyard.min(30) as f64 / 20.0,
        opp.graveyard.min(30) as f64 / 20.0,
        b(phase == ValuePhase::After),
        b(s.first == p),
    ];
    for (j, &x) in scalars.iter().enumerate() {
        if x != 0.0 {
            acc.set(base + j, x);
        }
    }
}

thread_local! {
    static BUF: RefCell<(Acc, Vec<f64>)> = const { RefCell::new((Acc(Vec::new()), Vec::new())) };
}

/// 探索の extraEval（評価の点数の単位の補正）
pub fn value_net_eval(s: &GameState, p: PlayerIndex, phase: ValuePhase) -> f64 {
    if s.phase == Phase::Ended {
        return 0.0;
    }
    static CHECKED: std::sync::Once = std::sync::Once::new();
    CHECKED.call_once(check);
    let vn = &ai_data().value_net;
    let hn = vn.hidden;
    BUF.with(|buf| {
        let (acc, h) = &mut *buf.borrow_mut();
        acc.0.clear();
        encode(s, p, phase, acc);
        h.clear();
        h.extend_from_slice(&vn.b1);
        for &(i, x) in &acc.0 {
            let row = &vn.w1[i * hn..i * hn + hn];
            for (hj, &r) in h.iter_mut().zip(row) {
                *hj += x * r;
            }
        }
        let mut z = vn.b2;
        for (hj, &w2) in h.iter_mut().zip(&vn.w2) {
            if *hj < 0.0 {
                *hj = 0.0;
            }
            z += *hj * w2;
        }
        (vn.c + z) / vn.a
    })
}
