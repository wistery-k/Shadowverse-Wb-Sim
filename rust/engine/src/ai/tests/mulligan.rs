//! マリガン（tests/mulligan.test.ts・mulliganModel.test.ts）。
//! 表のデータがデフォルトデッキに合っていることは TypeScript 側（tests/ai.test.ts）で確かめる

use super::*;
use crate::ai::aidata::MulliganDeckModel;
use crate::ai::mulligan::{
    default_deck_name_of, hand_features, model_mulligan_swap, model_swap, weighted_swap,
};
use std::collections::HashMap;

const DECK: &str = "AFネメシス";
const OTHER: &str = "アマリアロイヤル";

fn weights_state() -> (GameState, PlayerIndex) {
    let s = new_game(deck(DECK), deck(OTHER), 12345);
    let p = s.first;
    (s, p)
}

#[test]
fn finds_default_deck_from_hand_and_deck() {
    let (s, p) = weights_state();
    let expected = if s.first == 0 { DECK } else { OTHER };
    assert_eq!(default_deck_name_of(&s, p), Some(expected));
}

#[test]
fn keeps_positive_and_swaps_negative() {
    // 重みが正のカードは残し、負のカードは返す
    let (s, p) = weights_state();
    let hand = &s.players[p].hand;
    let keep = hand[0].card;
    let mut table: HashMap<CardIdx, [f64; 2]> = HashMap::new();
    for h in &hand[1..] {
        table.insert(h.card, [-0.01, -0.01]);
    }
    table.insert(keep, [0.01, -0.01]);
    // 同じカードが 2 枚あれば、2 枚目は 2 枚目の重み（負）で返す
    let same_as_keep: Vec<Iid> = hand
        .iter()
        .filter(|h| h.card == keep)
        .skip(1)
        .map(|h| h.iid)
        .collect();
    let mut expected: Vec<Iid> = hand[1..]
        .iter()
        .filter(|h| h.card != keep)
        .map(|h| h.iid)
        .collect();
    expected.extend(same_as_keep);
    assert_eq!(sorted(weighted_swap(&s, p, &table)), sorted(expected));
}

#[test]
fn cards_without_weights_follow_cost() {
    // 重みの無いカードはコストで決める（コスト 4 以上を返す）
    let (s, p) = weights_state();
    let cost: Vec<Iid> = s.players[p]
        .hand
        .iter()
        .filter(|h| card(h.card).cost >= 4)
        .map(|h| h.iid)
        .collect();
    assert_eq!(sorted(weighted_swap(&s, p, &HashMap::new())), sorted(cost));
}

/// 役割の名前の添字
fn role(name: &str) -> usize {
    ai_data()
        .roles
        .iter()
        .position(|r| r == name)
        .unwrap_or_else(|| panic!("未知の役割: {name}"))
}

#[test]
fn hand_features_count_roles_duplicates_and_kept() {
    // 特徴は役割の枚数（1 枚以上・2 枚以上）、重複、残した枚数
    let (a, b) = (id("フェアリー"), id("ゴブリン"));
    let roles: HashMap<CardIdx, Vec<usize>> = HashMap::from([
        (a, vec![role("2PP"), role("リソース")]),
        (b, vec![role("除去"), role("除去")]),
    ]);
    let f = hand_features(&[a, a, b], &roles, true);
    let names = &ai_data().model_features;
    assert_eq!(f.len(), names.len());
    let get = |n: &str| f[names.iter().position(|x| x == n).expect(n)];
    // 除去を 2 つ書いたカードは 1 枚で 2 枚分
    let counts: Vec<f64> = [
        "2PP>=1",
        "2PP>=2",
        "リソース>=2",
        "除去>=1",
        "除去>=2",
        "展開>=1",
    ]
    .iter()
    .map(|n| get(n))
    .collect();
    assert_eq!(counts, vec![1.0, 1.0, 1.0, 1.0, 1.0, 0.0]);
    let rest: Vec<f64> = ["dup", "kept", "2PPxSecond", "1PPxRes"]
        .iter()
        .map(|n| get(n))
        .collect();
    assert_eq!(rest, vec![1.0, 3.0, 1.0, 0.0]);
}

#[test]
fn model_picks_best_predicted_keep() {
    // 予測が最も高い残し方を選ぶ（例: 重複を嫌えば 2 枚目を返す）
    let d = deck(OTHER);
    let distinct = |s: &GameState| {
        let hand = &s.players[s.first].hand;
        let mut cards: Vec<CardIdx> = hand.iter().map(|h| h.card).collect();
        cards.sort();
        cards.dedup();
        cards.len() == hand.len()
    };
    let mut s = new_game(d, d, 1);
    let mut seed = 2;
    while distinct(&s) {
        s = new_game(d, d, seed);
        seed += 1;
    }
    let hand = &s.players[s.first].hand;
    // どのカードも残すと +1、重複は −5
    let names = &ai_data().model_features;
    let model = MulliganDeckModel {
        features: names
            .iter()
            .map(|n| if n == "dup" { Some(-5.0) } else { None })
            .collect(),
        cards: hand.iter().map(|h| (h.card, 1.0)).collect(),
    };
    let roles = &ai_data().mulligan_roles[OTHER];
    let swap = model_swap(&s, s.first, &model, roles);
    let second: Vec<Iid> = hand
        .iter()
        .enumerate()
        .filter(|(i, h)| hand[..*i].iter().any(|x| x.card == h.card))
        .map(|(_, h)| h.iid)
        .collect();
    assert_eq!(sorted(swap), sorted(second));
    // 既定の係数のあるデッキなら既定の係数で選ぶ
    assert!(model_mulligan_swap(&s, s.first).is_some());
}

fn sample_agent(n: usize) -> crate::ai::search::SearchAgent {
    crate::ai::search::SearchAgent::new(crate::ai::search::SearchOptions {
        mulligan: crate::ai::search::MulliganMode::Sample,
        mulligan_samples: n,
        ..Default::default()
    })
}

#[test]
fn sampled_mulligan_is_deterministic_and_keeps_rng() {
    // 引き直しを試すマリガンは、同じ局面・同じ乱数なら同じ手を選び、試合の乱数を進めない
    let (s, _) = weights_state();
    let legal = legal_actions(&s);
    assert_eq!(legal.len(), 16);
    let mut rng = Rng::new(777);
    let a = sample_agent(20).choose_action(&s, &legal, &mut rng);
    assert_eq!(rng.state, 777);
    let b = sample_agent(20).choose_action(&s, &legal, &mut rng);
    assert_eq!(a, b);
    assert!(legal.contains(&a));
}

/// 速さの確認（cargo test --release -- --ignored --nocapture sampled_mulligan_speed）
#[test]
#[ignore]
fn sampled_mulligan_speed() {
    for n in [100usize, 1000] {
        let mut agent = sample_agent(n);
        let t0 = std::time::Instant::now();
        let games = 50u32;
        for g in 0..games {
            let s = new_game(deck(DECK), deck(OTHER), g);
            let legal = legal_actions(&s);
            agent.choose_action(&s, &legal, &mut Rng::new(g));
        }
        println!(
            "引き直し {n} 回: 1 回のマリガン {:.1} ミリ秒",
            t0.elapsed().as_secs_f64() * 1000.0 / games as f64
        );
    }
}
