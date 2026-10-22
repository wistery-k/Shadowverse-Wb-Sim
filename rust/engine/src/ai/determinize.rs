//! 情報集合の determinization（src/ai/determinize.ts）。視点のプレイヤーから見て矛盾しない「ありうる局面」を作る。

use super::Rng;
use crate::data::CardIdx;
use crate::state::*;

/// 相手にも中身が分かっている手札のカード。効果で加えたトークンは revealed を持つ。
/// 山札から引いたトークンや、捨てる・山札に戻すカードを選んだときの候補だったトークンは分からない
fn is_public(h: &HandCard) -> bool {
    h.revealed
}

fn matches_hint(c: CardIdx, hint: &DrawHint) -> bool {
    let cd = card(c);
    let f = hint.filter;
    if let Some(t) = f.ctype {
        if cd.ctype != t {
            return false;
        }
    }
    if let Some(t) = f.tribe {
        if !cd.tribes.contains(&t) {
            return false;
        }
    }
    if let Some(cl) = f.class {
        if cd.class != cl {
            return false;
        }
    }
    if let Some(ids) = &f.ids {
        if !ids.contains(&c) {
            return false;
        }
    }
    if let Some(m) = f.cost_max {
        if cd.cost > m {
            return false;
        }
    }
    if let Some(e) = hint.cost_eq {
        if cd.cost != e {
            return false;
        }
    }
    true
}

/// viewer から見えない情報（相手の手札・山札の中身と、相手がどのカードを捨てたか、山札の順番、乱数の状態）を並べ直した局面。
/// peek_opp_hand なら相手の手札は実際のまま（実験用）
pub fn determinize(
    state: &GameState,
    viewer: PlayerIndex,
    rng: &mut Rng,
    peek_opp_hand: bool,
) -> GameState {
    let mut s = state.clone();
    let o = opponent(viewer);
    rng.shuffle(s.players[viewer].deck.make_mut());

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
        if let Some(idx) = pool.iter().position(|&c| matches_hint(c, hint)) {
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
    s
}
