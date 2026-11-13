//! 情報集合の determinization（src/ai/determinize.ts）。視点のプレイヤーから見て矛盾しない「ありうる局面」を作る。

use super::Rng;
use crate::data::CardIdx;
use crate::state::*;

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
    let _p = crate::prof::scope(crate::prof::Sec::Determinize);
    let mut s = state.clone();
    rng.shuffle(s.players[viewer].deck.make_mut());
    redeal_hidden(&mut s, viewer, rng, peek_opp_hand);
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
    let _p = crate::prof::scope(crate::prof::Sec::Determinize);
    let own = rng.int(u32::MAX as usize) as u32;
    let mut s = state.clone();
    redeal_hidden(&mut s, viewer, rng, peek_opp_hand);
    Rng::new(own).shuffle(s.players[viewer].deck.make_mut());
    s
}

/// 相手の伏せた手札・山札の中身と順番、相手が捨てたカード、局面の乱数を rng で作り直す（determinize の viewer の山札の後の部分）
fn redeal_hidden(s: &mut GameState, viewer: PlayerIndex, rng: &mut Rng, peek_opp_hand: bool) {
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
