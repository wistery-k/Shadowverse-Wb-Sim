//! TD 学習の評価の補正（tests/valueNet.test.ts）。
//! モデルの JSON の読み込みは TypeScript 側（tests/ai.test.ts。学習は scripts/valueNet.ts）でも確かめる

use super::*;
use crate::ai::aidata::RawValueNet;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::valuenet::{ValueNet, ValuePhase};
use std::sync::Arc;

/// 今のカード・クレストの一覧を語彙にしたモデル（valueNet.ts の defaultVocab）
fn model(hidden: usize, fill: impl Fn(usize) -> f64, w2: f64) -> RawValueNet {
    let d = data();
    let vocab: Vec<String> = d
        .cards
        .iter()
        .map(|c| c.id.clone())
        .chain(d.crests.iter().map(|c| format!("crest:{}", c.id)))
        .collect();
    let base = &ai_data().value_net;
    let n = base.zones.len() * vocab.len() + base.scalars.len();
    RawValueNet {
        kind: "td-value-net".into(),
        version: 1,
        vocab,
        zones: base.zones.clone(),
        scalars: base.scalars.clone(),
        hidden,
        w1: (0..n * hidden).map(fill).collect(),
        b1: vec![0.1; hidden],
        w2: vec![w2; hidden],
        b2: 0.0,
        a: 0.08,
        c: 0.0,
        base_weights: serde_json::Map::new(),
    }
}

/// 両者が何ターンか打った局面（最初のターン終了以外の合法手を打つ）
fn mid_game() -> GameState {
    let mut s = new_game(deck_at(0), deck_at(1), 5);
    for _ in 0..40 {
        if s.phase == Phase::Ended {
            break;
        }
        let legal = legal_actions(&s);
        let a = legal
            .iter()
            .find(|a| **a != Action::EndTurn)
            .unwrap_or(&legal[0])
            .clone();
        s = apply(&s, &a);
    }
    s
}

#[test]
fn input_ignores_hidden_information() {
    // 入力は相手の未公開の手札の中身と山札の順番を見ない
    let net = ValueNet::new(model(4, |i| (i as f64).sin(), 1.0)).expect("モデル");
    let s = mid_game();
    let p = s.active;
    let q = opponent(p);
    let mut t = s.clone();
    // 相手の未公開の手札と山札の中身を入れ替え、山札を逆順にする
    let opp = &mut t.players[q];
    let hidden: Vec<usize> = (0..opp.hand.len())
        .filter(|&i| !opp.hand[i].revealed)
        .collect();
    assert!(!hidden.is_empty());
    for (k, &i) in hidden.iter().enumerate() {
        std::mem::swap(&mut opp.hand[i].card, &mut opp.deck[k].card);
    }
    opp.deck.reverse();
    t.players[p].deck.reverse();
    assert_eq!(
        net.encode(&t, p, ValuePhase::End),
        net.encode(&s, p, ValuePhase::End)
    );
    assert!((net.eval(&t, p, ValuePhase::End) - net.eval(&s, p, ValuePhase::End)).abs() < 1e-12);
    // 自分の手札は見る
    assert_ne!(
        net.encode(&s, q, ValuePhase::End),
        net.encode(&t, q, ValuePhase::End)
    );
}

#[test]
fn zero_output_does_not_change_search() {
    // 出力の重みが 0 のモデルは補正 0 で、探索 AI の手を変えない
    let net = Arc::new(ValueNet::new(model(4, |i| (i as f64).cos(), 0.0)).expect("モデル"));
    let s = mid_game();
    assert_eq!(net.eval(&s, 0, ValuePhase::End), 0.0);
    assert_eq!(net.eval(&s, 1, ValuePhase::After), 0.0);
    let n = net.clone();
    let mut plain = SearchAgent::new(SearchOptions {
        extra_eval: None,
        ..SearchOptions::default()
    });
    let mut with_net = SearchAgent::new(SearchOptions {
        extra_eval: Some(Arc::new(
            move |s: &GameState, p: PlayerIndex, phase: ValuePhase| n.eval(s, p, phase),
        )),
        ..SearchOptions::default()
    });
    let legal = legal_actions(&s);
    assert_eq!(
        with_net.choose_action(&s, &legal, &mut Rng::new(9)),
        plain.choose_action(&s, &legal, &mut Rng::new(9))
    );
}

#[test]
fn reads_model_json_and_checks_sizes() {
    // モデルの JSON（npm run td が書き出す形）を読め、大きさが合わなければ止める
    let m = model(2, |i| (i % 7) as f64 / 10.0, 0.5);
    let json = serde_json::json!({
        "kind": m.kind, "version": m.version, "vocab": m.vocab, "zones": m.zones, "scalars": m.scalars,
        "hidden": m.hidden, "w1": m.w1, "b1": m.b1, "w2": m.w2, "b2": m.b2, "a": m.a, "c": m.c, "baseWeights": {}
    });
    let back: RawValueNet = serde_json::from_value(json.clone()).expect("モデルの JSON");
    let s = mid_game();
    let direct = ValueNet::new(m.clone()).expect("モデル");
    let read = ValueNet::new(back).expect("モデル");
    assert_eq!(
        read.eval(&s, 0, ValuePhase::End),
        direct.eval(&s, 0, ValuePhase::End)
    );
    let mut short = m.clone();
    short.w1.pop();
    assert!(ValueNet::new(short).is_err());
    let mut reversed = m.clone();
    reversed.zones.reverse();
    assert!(ValueNet::new(reversed).is_err());
    let mut bad = json;
    bad["w2"] = serde_json::json!(["x"]);
    assert!(serde_json::from_value::<RawValueNet>(bad).is_err());
}
