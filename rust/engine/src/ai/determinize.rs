//! 情報集合の determinization（src/ai/determinize.ts）。視点のプレイヤーから見て矛盾しない「ありうる局面」を作る。

use super::Rng;
use crate::data::{CardIdx, On};
use crate::effects::{hand_feature_seq, has_hand_trigger, reapply_in_hand, HAND_SEQ_LEN};
use crate::state::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::OnceLock;

/// 相手にも中身が分かっている手札のカード。効果で加えたトークンは revealed を持つ。
/// 山札から引いたトークンや、捨てる・山札に戻すカードを選んだときの候補だったトークンは分からない
fn is_public(h: &HandCard) -> bool {
    h.revealed
}

/// viewer から見えない情報（相手の手札・山札の中身と、相手がどのカードを捨てたか、山札の順番、乱数の状態）を並べ直した局面。
/// peek_opp_hand なら相手の手札は実際のまま（実験用）
pub fn determinize(
    state: &GameState,
    viewer: PlayerIndex,
    rng: &mut Rng,
    peek_opp_hand: bool,
) -> GameState {
    determinize_with(state, viewer, rng, peek_opp_hand, false)
}

/// determinize と同じ。hand_boosts なら、配り直した相手の伏せた手札に、手札の記録から見込んだスペルブースト等の回数をかけ直す
/// （探索の設定 oppHandBoosts。docs/ai-notes/13-2026-11-13.md「伏せた相手の手札のスペルブーストを決定化で見込む」）
pub fn determinize_with(
    state: &GameState,
    viewer: PlayerIndex,
    rng: &mut Rng,
    peek_opp_hand: bool,
    hand_boosts: bool,
) -> GameState {
    let _p = crate::prof::scope(crate::prof::Sec::Determinize);
    let mut s = state.clone();
    rng.shuffle(s.players[viewer].deck.make_mut());
    redeal_hidden(&mut s, viewer, rng, peek_opp_hand, hand_boosts);
    s
}

/// determinize と同じ並べ直しを、viewer の山札だけ別の乱数で行う（読み直しの readOwnDeckApart）。
/// 最初に rng から 1 つ取った種で viewer の山札を並べ直し、相手の分と局面の乱数は rng の続きで作る。
/// rng の進み方が viewer の山札の枚数によらないので、同じ種なら、山札の枚数が違う局面どうし（引いた手と引かない手の終局面）でも
/// 相手の手札・山札と局面の乱数が同じになる（determinize は viewer の山札を先に並べ直すので、枚数が 1 枚違うと相手の手札が全部変わる。
/// docs/ai-notes.md「錬金釜を置くと点数が下がる理由」）
pub fn determinize_apart(
    state: &GameState,
    viewer: PlayerIndex,
    rng: &mut Rng,
    peek_opp_hand: bool,
) -> GameState {
    determinize_apart_with(state, viewer, rng, peek_opp_hand, false)
}

/// determinize_apart と同じ。hand_boosts は determinize_with と同じ
pub fn determinize_apart_with(
    state: &GameState,
    viewer: PlayerIndex,
    rng: &mut Rng,
    peek_opp_hand: bool,
    hand_boosts: bool,
) -> GameState {
    let _p = crate::prof::scope(crate::prof::Sec::Determinize);
    let own = rng.int(u32::MAX as usize) as u32;
    let mut s = state.clone();
    redeal_hidden(&mut s, viewer, rng, peek_opp_hand, hand_boosts);
    Rng::new(own).shuffle(s.players[viewer].deck.make_mut());
    s
}

/// 相手の伏せた手札・山札の中身と順番、相手が捨てたカード、局面の乱数を rng で作り直す（determinize の viewer の山札の後の部分）
fn redeal_hidden(
    s: &mut GameState,
    viewer: PlayerIndex,
    rng: &mut Rng,
    peek_opp_hand: bool,
    hand_boosts: bool,
) {
    let o = opponent(viewer);
    let hidden: Vec<usize> = if peek_opp_hand {
        Vec::new()
    } else {
        (0..s.players[o].hand.len())
            .filter(|&i| !is_public(&s.players[o].hand[i]))
            .collect()
    };
    let opp = &s.players[o];
    let mut pool: Vec<CardIdx> = hidden
        .iter()
        .map(|&i| opp.hand[i].card)
        .chain(opp.deck.iter().map(|r| r.card))
        .chain(opp.hidden_discards.iter().copied())
        .collect();
    rng.shuffle(&mut pool);
    // 条件付きで引いたカードから先に、条件に合うカードを取る
    let mut assigned: Vec<(Iid, CardIdx)> = Vec::new();
    for &i in &hidden {
        let h = &opp.hand[i];
        let Some(hint) = &h.drawn_by else { continue };
        if let Some(idx) = pool.iter().position(|&c| hint_matches(c, hint)) {
            assigned.push((h.iid, pool.remove(idx)));
        }
    }
    let mut k = 0;
    for &i in &hidden {
        let iid = opp.hand[i].iid;
        if !assigned.iter().any(|(x, _)| *x == iid) {
            assigned.push((iid, pool[k]));
            k += 1;
        }
    }
    for i in 0..s.players[o].hand.len() {
        let iid = s.players[o].hand[i].iid;
        if let Some(&(_, c)) = assigned.iter().find(|(x, _)| *x == iid) {
            let h = s.new_hand_card(c, Some(iid));
            s.players[o].hand.make_mut()[i] = h;
        }
    }
    if hand_boosts && !hidden.is_empty() {
        reapply_hidden_counts(s, o, &hidden, rng);
    }
    for r in s.players[o].deck.make_mut().iter_mut() {
        r.card = pool[k];
        k += 1;
    }
    // 残りは、相手にはどれか分からない捨てたカード
    if !s.players[o].hidden_discards.is_empty() {
        s.players[o].hidden_discards = pool[k..].to_vec().into();
    }
    // 山札に戻った相手のカードの状態も、伏せた手札と同じく作り直したものとみなす
    s.players[o].deck_kept.clear();
    let a = rng.int(1 << 30) as f64;
    let b = rng.int(4) as f64;
    s.rng = (a * 4.0 + b).floor() as u32;
}

// ---- 伏せた手札のスペルブースト等の見込み ----

/// 手札の記録をなぞった伏せた枠: スペルブーストを受けた回数（b）と、手札にある間に味方のフォロワーが場を離れた回数（a）
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct HandSlot {
    pub b: u16,
    pub a: u16,
}

/// 記録に、伏せた枠の回数を変える出来事があるか（無ければ全部の枠が 0 回なので、なぞらない）
fn log_has_counts(evs: &[HandEv]) -> bool {
    evs.iter().any(|e| match *e {
        HandEv::Boost { times } | HandEv::BoostOne { times } | HandEv::AllyLeft { times } => {
            times > 0
        }
        HandEv::InWith { boosts } | HandEv::ToDeckWith { boosts } => boosts > 0,
        _ => false,
    })
}

/// 手札で働く能力を持つカード（スペルブースト・味方が場を離れた）。出したカードがその j 回後の姿か（変身した後の姿も含む）を見るのに使う
fn hand_trigger_cards(on: On) -> &'static [CardIdx] {
    static SB: OnceLock<Vec<CardIdx>> = OnceLock::new();
    static AL: OnceLock<Vec<CardIdx>> = OnceLock::new();
    let cell = if on == On::Spellboost { &SB } else { &AL };
    cell.get_or_init(|| {
        (0..crate::data::data().cards.len() as CardIdx)
            .filter(|&c| has_hand_trigger(c, on))
            .collect()
    })
}

/// 出したカードの見えた中身 obs から分かる、その枠が受けた回数の候補（j 回なら [j] が true。HAND_SEQ_LEN 以上はまとめて最後）。
/// 手札で働く能力を持つカード（変身した後の姿を含む）のどの j 回後の姿にも合わなければ None（回数は分からない）
fn counts_seen(template: &GameState, obs: HandEv, on: On) -> Option<Vec<bool>> {
    let HandEv::Out { card, .. } = obs else {
        return None;
    };
    let mut ok = vec![false; HAND_SEQ_LEN + 1];
    let mut any = false;
    for &d in hand_trigger_cards(on) {
        let seq = hand_feature_seq(template, d, on);
        // 出したカードにならないカードは見ない（変身しないなら d == card のときだけ合う）
        if d != card
            && !seq
                .iter()
                .any(|e| matches!(e, HandEv::Out { card: c, .. } if *c == card))
        {
            continue;
        }
        for (j, e) in seq.iter().enumerate() {
            if *e == obs {
                ok[j] = true;
                any = true;
            }
        }
        // 作った回数より先は最後と同じとみなす
        if seq.len() <= HAND_SEQ_LEN && seq.last() == Some(&obs) {
            for x in ok.iter_mut().skip(seq.len()) {
                *x = true;
            }
        }
    }
    any.then_some(ok)
}

/// 回数の候補（counts_seen）。スペルブーストと、味方が場を離れた回数
type Seen = (Option<Rc<Vec<bool>>>, Option<Rc<Vec<bool>>>);

/// Out の出来事に合う枠か（スペルブーストと味方が離れた回数のそれぞれで、分かる候補に入るか）。覚えておく
fn slot_filter(template: &GameState, obs: HandEv) -> Seen {
    thread_local! {
        static MEMO: RefCell<HashMap<HandEv, Seen>> = RefCell::new(HashMap::new());
    }
    if let Some(v) = MEMO.with(|m| m.borrow().get(&obs).cloned()) {
        return v;
    }
    let v = (
        counts_seen(template, obs, On::Spellboost).map(Rc::new),
        counts_seen(template, obs, On::AllyLeaveInHand).map(Rc::new),
    );
    MEMO.with(|m| m.borrow_mut().insert(obs, v.clone()));
    v
}

fn fits(seen: &Option<Rc<Vec<bool>>>, n: u16) -> bool {
    seen.as_ref()
        .is_none_or(|v| v[(n as usize).min(HAND_SEQ_LEN)])
}

/// 相手 o の手札の記録を頭からなぞって、伏せた枠ごとの回数を作る（どの枠を出したか・山札に戻した枠を引いたかは rng で決める）。
/// 記録が伏せた手札の枚数と合わなければ None（記録の無い局面等）
pub fn replay_hand_slots(s: &GameState, o: PlayerIndex, rng: &mut Rng) -> Option<Vec<HandSlot>> {
    let evs = s.players[o].hand_log.to_vec();
    let hidden = s.players[o].hand.iter().filter(|h| !h.revealed).count();
    if !log_has_counts(&evs) {
        return None;
    }
    let mut slots: Vec<HandSlot> = Vec::new();
    // 山札に戻った、回数が 0 でない枠
    let mut back: Vec<HandSlot> = Vec::new();
    for e in evs {
        match e {
            HandEv::In { deck } => {
                let d = deck as usize;
                if d > 0 && !back.is_empty() && rng.int(d) < back.len() {
                    let k = rng.int(back.len());
                    slots.push(back.swap_remove(k));
                } else {
                    slots.push(HandSlot::default());
                }
            }
            HandEv::InWith { boosts } => slots.push(HandSlot { b: boosts, a: 0 }),
            HandEv::Out { .. } | HandEv::OutUnknown => {
                if slots.is_empty() {
                    return None;
                }
                let fit: Vec<usize> = if let HandEv::Out { .. } = e {
                    let (sb, al) = slot_filter(s, e);
                    (0..slots.len())
                        .filter(|&i| fits(&sb, slots[i].b) && fits(&al, slots[i].a))
                        .collect()
                } else {
                    Vec::new()
                };
                let k = if fit.is_empty() {
                    rng.int(slots.len())
                } else {
                    fit[rng.int(fit.len())]
                };
                slots.swap_remove(k);
            }
            HandEv::ToDeck => {
                if slots.is_empty() {
                    return None;
                }
                let k = rng.int(slots.len());
                let x = slots.swap_remove(k);
                if x != HandSlot::default() {
                    back.push(x);
                }
            }
            HandEv::ToDeckWith { boosts } => {
                if boosts > 0 {
                    back.push(HandSlot { b: boosts, a: 0 });
                }
            }
            HandEv::Boost { times } => {
                for x in slots.iter_mut() {
                    x.b = x.b.saturating_add(times);
                }
            }
            HandEv::BoostOne { times } => {
                if !slots.is_empty() {
                    let k = rng.int(slots.len());
                    slots[k].b = slots[k].b.saturating_add(times);
                }
            }
            HandEv::AllyLeft { times } => {
                for x in slots.iter_mut() {
                    x.a = x.a.saturating_add(times);
                }
            }
        }
    }
    (slots.len() == hidden).then_some(slots)
}

/// 配り直した相手 o の伏せた手札（hidden は手札の位置）に、手札の記録から見込んだ回数をかけ直す
fn reapply_hidden_counts(s: &mut GameState, o: PlayerIndex, hidden: &[usize], rng: &mut Rng) {
    let Some(mut slots) = replay_hand_slots(s, o, rng) else {
        return;
    };
    if slots.iter().all(|x| *x == HandSlot::default()) {
        return;
    }
    rng.shuffle(&mut slots);
    let items: Vec<(Iid, u16, u16)> = hidden
        .iter()
        .zip(&slots)
        .filter(|(_, x)| **x != HandSlot::default())
        .map(|(&i, x)| (s.players[o].hand[i].iid, x.b, x.a))
        .collect();
    reapply_in_hand(s, o, &items);
}
