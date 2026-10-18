//! マリガン（src/ai/mulligan.ts の weightedMulliganSwap、src/ai/mulliganModel.ts の modelMulliganSwap）。

use super::aidata::{ai_data, MulliganDeckModel};
use super::determinize::determinize;
use super::Rng;
use crate::data::{data, CardIdx};
use crate::game::try_apply_action;
use crate::state::*;
use std::collections::HashMap;
use std::sync::OnceLock;

/// マリガン時のプレイヤーのデッキ（手札＋山札）がデフォルトデッキのどれか
pub fn default_deck_name_of(s: &GameState, p: PlayerIndex) -> Option<&'static str> {
    static BY_CARDS: OnceLock<Vec<(Vec<&'static str>, &'static str)>> = OnceLock::new();
    let decks = BY_CARDS.get_or_init(|| {
        let mut v: Vec<(Vec<&'static str>, &'static str)> = Vec::new();
        for d in &data().decks {
            let mut ids: Vec<&'static str> = d.cards.iter().map(|&c| card(c).id.as_str()).collect();
            ids.sort();
            // 同じカードの並びのデッキが複数あれば後のもの（TypeScript 版の Map と同じ）
            v.retain(|(k, _)| *k != ids);
            v.push((ids, d.name.as_str()));
        }
        v
    });
    let pl = &s.players[p];
    let mut ids: Vec<&str> = pl
        .hand
        .iter()
        .map(|h| card(h.card).id.as_str())
        .chain(pl.deck.iter().map(|r| card(r.card).id.as_str()))
        .collect();
    ids.sort();
    decks.iter().find(|(k, _)| *k == ids).map(|(_, n)| *n)
}

/// 重みでマリガンする（evoBonus・oneCopy・maxHighCost は既定のまま）。デッキの重みが無ければ None
pub fn weighted_mulligan_swap(s: &GameState, p: PlayerIndex) -> Option<Vec<Iid>> {
    weighted_mulligan_swap_as(s, p, default_deck_name_of(s, p)?)
}

/// デフォルトデッキ name の重みでマリガンする（デッキのカードが違っても name の表を使う）
pub fn weighted_mulligan_swap_as(s: &GameState, p: PlayerIndex, name: &str) -> Option<Vec<Iid>> {
    let table = ai_data().mulligan_weights.get(name)?;
    Some(weighted_swap(s, p, table))
}

/// 返すカード swap に当たるマリガンの手
pub fn mulligan_action<'a>(legal: &'a [Action], swap: &[Iid]) -> Option<&'a Action> {
    legal.iter().find(|a| match a {
        Action::Mulligan { swap: x, .. } => {
            x.len() == swap.len() && x.iter().all(|i| swap.contains(i))
        }
        _ => false,
    })
}

/// カード → [1 枚目を残す重み, 2 枚目も残す重み] の表でマリガンする（表に無いカードはコスト 4 以上を返す）
pub(crate) fn weighted_swap(
    s: &GameState,
    p: PlayerIndex,
    table: &HashMap<CardIdx, [f64; 2]>,
) -> Vec<Iid> {
    let mut seen: Vec<(CardIdx, u32)> = Vec::new();
    let mut swap = Vec::new();
    for h in &s.players[p].hand {
        let copy = match seen.iter_mut().find(|(c, _)| *c == h.card) {
            Some(e) => {
                e.1 += 1;
                e.1 - 1
            }
            None => {
                seen.push((h.card, 1));
                0
            }
        };
        let Some(w) = table.get(&h.card) else {
            if card(h.card).cost >= 4 {
                swap.push(h.iid);
            }
            continue;
        };
        let keep = if copy == 0 {
            w[0] > 0.0
        } else {
            w[0] > 0.0 && w[1] > 0.0
        };
        if !keep {
            swap.push(h.iid);
        }
    }
    swap
}

/// 残したカード（重複あり）と後攻かどうかから特徴を作る
pub(crate) fn hand_features(
    kept: &[CardIdx],
    roles: &HashMap<CardIdx, Vec<usize>>,
    second: bool,
) -> Vec<f64> {
    let n_roles = ai_data().roles.len();
    let mut count = vec![0i32; n_roles];
    for id in kept {
        if let Some(rs) = roles.get(id) {
            for &r in rs {
                count[r] += 1;
            }
        }
    }
    let role = |name: &str| {
        ai_data()
            .roles
            .iter()
            .position(|x| x == name)
            .expect("役割")
    };
    let n = |name: &str| count[role(name)];
    let b = |x: bool| if x { 1.0 } else { 0.0 };
    let s = b(second);
    let high = kept.iter().filter(|&&c| card(c).cost >= 6).count();
    let mut distinct: Vec<CardIdx> = Vec::new();
    for &c in kept {
        if !distinct.contains(&c) {
            distinct.push(c);
        }
    }
    let mut f = Vec::new();
    for &c in &count {
        f.push(b(c >= 1));
        f.push(b(c >= 2));
    }
    f.push(b(high >= 1));
    f.push(b(high >= 2));
    f.push((kept.len() - distinct.len()) as f64);
    f.push(kept.len() as f64);
    f.push(b(n("1PP") >= 1) * n("リソース") as f64);
    f.push(b(n("シナジー与") >= 1 && n("シナジー受") >= 1));
    f.push(b(n("1PP") >= 1) * s);
    f.push(b(n("2PP") >= 1) * s);
    f.push(b(n("3PP") >= 1) * s);
    f
}

fn predict_keep(
    kept: &[CardIdx],
    deck: &MulliganDeckModel,
    roles: &HashMap<CardIdx, Vec<usize>>,
    second: bool,
) -> f64 {
    let f = hand_features(kept, roles, second);
    let mut v = 0.0;
    for (i, coef) in deck.features.iter().enumerate() {
        v += coef.unwrap_or(0.0) * f[i];
    }
    let mut seen: Vec<CardIdx> = Vec::new();
    for &c in kept {
        if seen.contains(&c) {
            continue;
        }
        seen.push(c);
        v += deck.cards.get(&c).copied().unwrap_or(0.0);
    }
    v
}

/// 手札の形でマリガンする。デッキの係数か役割が無ければ None
pub fn model_mulligan_swap(s: &GameState, p: PlayerIndex) -> Option<Vec<Iid>> {
    model_mulligan_swap_as(s, p, default_deck_name_of(s, p)?)
}

/// デフォルトデッキ name の係数と役割で手札の形からマリガンする（表に無いカードは役割なし・係数 0）
pub fn model_mulligan_swap_as(s: &GameState, p: PlayerIndex, name: &str) -> Option<Vec<Iid>> {
    let ad = ai_data();
    assert_eq!(
        ad.model_features.len(),
        2 * ad.roles.len() + 9,
        "マリガンの特徴の数が合いません"
    );
    let deck = ad.mulligan_model.get(name)?;
    let roles = ad.mulligan_roles.get(name)?;
    Some(model_swap(s, p, deck, roles))
}

/// デッキの係数と役割の表でマリガンする（予測が最も高い残し方）
pub(crate) fn model_swap(
    s: &GameState,
    p: PlayerIndex,
    deck: &MulliganDeckModel,
    roles: &HashMap<CardIdx, Vec<usize>>,
) -> Vec<Iid> {
    let hand = &s.players[p].hand;
    let second = s.first != p;
    let mut best: Vec<Iid> = Vec::new();
    let mut best_v = f64::NEG_INFINITY;
    for mask in 0u32..(1 << hand.len()) {
        let kept: Vec<CardIdx> = hand
            .iter()
            .enumerate()
            .filter(|(i, _)| mask & (1 << i) != 0)
            .map(|(_, h)| h.card)
            .collect();
        let v = predict_keep(&kept, deck, roles, second);
        if v > best_v + 1e-12 {
            best_v = v;
            best = hand
                .iter()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) == 0)
                .map(|(_, h)| h.iid)
                .collect();
        }
    }
    best
}

/// 返し方ごとに引き直しを n 回ずつ試し、引き直した後の局面の評価の平均が最も高い返し方を選ぶ。
/// 自分の山札の順番と相手の手札・山札は determinize で並べ直し、n 通りの並べ方を全ての返し方で共通に使う
/// （返し方どうしの差のぶれを減らすため）。乱数は rng を進めずに、その状態から作った別の乱数を使う
/// （判断が今のマリガンと同じなら、その後の試合も同じになるように）
pub(crate) fn sampled_mulligan(
    real: &GameState,
    legal: &[Action],
    p: PlayerIndex,
    n: usize,
    rng: &Rng,
    eval: impl Fn(&GameState) -> f64,
) -> Action {
    let mut local = Rng::new(rng.state ^ 0x6d75_6c6c);
    let dets: Vec<GameState> = (0..n.max(1))
        .map(|_| determinize(real, p, &mut local, false))
        .collect();
    let mut best = &legal[0];
    let mut best_v = f64::NEG_INFINITY;
    for a in legal {
        let sum: f64 = dets
            .iter()
            .map(|d| eval(&try_apply_action(d, a).expect("マリガンの合法手")))
            .sum();
        if sum > best_v {
            best_v = sum;
            best = a;
        }
    }
    best.clone()
}
