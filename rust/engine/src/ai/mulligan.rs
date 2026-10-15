//! マリガン（src/ai/mulligan.ts の weightedMulliganSwap、src/ai/mulliganModel.ts の modelMulliganSwap）。

use super::aidata::{ai_data, MulliganDeckModel};
use crate::data::{data, CardIdx};
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
    let name = default_deck_name_of(s, p)?;
    let table = ai_data().mulligan_weights.get(name)?;
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
    Some(swap)
}

/// 残したカード（重複あり）と後攻かどうかから特徴を作る
fn hand_features(kept: &[CardIdx], roles: &HashMap<CardIdx, Vec<usize>>, second: bool) -> Vec<f64> {
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
    let ad = ai_data();
    assert_eq!(
        ad.model_features.len(),
        2 * ad.roles.len() + 9,
        "マリガンの特徴の数が合いません"
    );
    let name = default_deck_name_of(s, p)?;
    let deck = ad.mulligan_model.get(name)?;
    let roles = ad.mulligan_roles.get(name)?;
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
    Some(best)
}
