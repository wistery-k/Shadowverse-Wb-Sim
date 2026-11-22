//! TD 学習の評価の補正（tests/valueNet.test.ts）。
//! モデルの JSON の読み込みは TypeScript 側（tests/ai.test.ts。学習は scripts/valueNet.ts）でも確かめる

use super::*;
use crate::ai::aidata::{RawLethalHead, RawValueNet, RawValueNetLayer};
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::valuenet::{default_value_net, ValueNet, ValuePhase};
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
        layers: Vec::new(),
        w2: vec![w2; hidden],
        b2: 0.0,
        a: 0.08,
        c: 0.0,
        base_weights: serde_json::Map::new(),
        board: None,
        lethal_head: None,
        win_head: None,
        read_head: None,
        win_form: None,
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
        std::mem::swap(
            &mut opp.hand.make_mut()[i].card,
            &mut opp.deck.make_mut()[k].card,
        );
    }
    opp.deck.make_mut().reverse();
    t.players[p].deck.make_mut().reverse();
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

#[test]
fn widened_model_with_zero_rows_matches_old_layout() {
    // 場の攻撃力・体力等を足す前の並びのモデルも読め、足した入力の重みを 0 にして広げたモデルと同じ補正になる（npm run td -- extend）
    use crate::ai::valuenet::{SCALARS, ZONES};
    // 足す前の並び（入力の場所 10・数値 21）のモデル
    let base = model(4, |_| 0.0, 0.7);
    let zones: Vec<String> = ZONES[..10].iter().map(|s| s.to_string()).collect();
    let scalars: Vec<String> = SCALARS[..21].iter().map(|s| s.to_string()).collect();
    let n = zones.len() * base.vocab.len() + scalars.len();
    let old = RawValueNet {
        w1: (0..n * base.hidden)
            .map(|i| ((i * 7919) % 13) as f64 / 20.0 - 0.3)
            .collect(),
        zones,
        scalars,
        ..base
    };
    assert_eq!(old.zones.len(), 10);
    assert_eq!(old.scalars.len(), 21);
    let v = old.vocab.len();
    let h = old.hidden;
    let mut w1 = Vec::new();
    for z in ZONES {
        let k = old.zones.iter().position(|x| x == z);
        for i in 0..v {
            for j in 0..h {
                w1.push(k.map_or(0.0, |k| old.w1[(k * v + i) * h + j]));
            }
        }
    }
    for sc in SCALARS {
        let k = old.scalars.iter().position(|x| x == sc);
        for j in 0..h {
            w1.push(k.map_or(0.0, |k| old.w1[(old.zones.len() * v + k) * h + j]));
        }
    }
    let wide = RawValueNet {
        zones: ZONES.iter().map(|s| s.to_string()).collect(),
        scalars: SCALARS.iter().map(|s| s.to_string()).collect(),
        w1,
        ..old.clone()
    };
    let (old, wide) = (
        ValueNet::new(old).expect("モデル"),
        ValueNet::new(wide).expect("モデル"),
    );
    let s = mid_game();
    assert!(s
        .players
        .iter()
        .any(|p| p.board.iter().any(|c| c.is_follower)));
    for p in 0..2 {
        for phase in [ValuePhase::End, ValuePhase::After] {
            assert_eq!(wide.eval(&s, p, phase), old.eval(&s, p, phase));
        }
        // 広げたモデルは攻撃力・体力も入力にする
        assert!(
            wide.encode(&s, p, ValuePhase::End).len() > old.encode(&s, p, ValuePhase::End).len()
        );
    }
}

#[test]
fn stacked_layers() {
    // 隠れ層を重ねたモデル（npm run td -- init --hidden 4,4）: 単位行列の層を挟んでも補正は同じ（ReLU を 2 回かけても同じ）。
    // 大きさが合わなければ止める
    let one = model(4, |i| ((i * 31) % 11) as f64 / 10.0 - 0.5, 0.7);
    let identity = RawValueNetLayer {
        w: (0..16)
            .map(|k| if k % 5 == 0 { 1.0 } else { 0.0 })
            .collect(),
        b: vec![0.0; 4],
    };
    let two = RawValueNet {
        layers: vec![identity.clone()],
        ..one.clone()
    };
    let s = mid_game();
    let (a, b) = (
        ValueNet::new(one.clone()).expect("モデル"),
        ValueNet::new(two.clone()).expect("モデル"),
    );
    for p in 0..2 {
        assert_ne!(a.eval(&s, p, ValuePhase::End), 0.0);
        assert_eq!(
            a.eval(&s, p, ValuePhase::End),
            b.eval(&s, p, ValuePhase::End)
        );
    }
    // 2 つ目の層を 2 倍にすると出力の重みに掛かる分も 2 倍
    let doubled = RawValueNet {
        layers: vec![RawValueNetLayer {
            w: identity.w.iter().map(|x| x * 2.0).collect(),
            b: vec![0.0; 4],
        }],
        ..one.clone()
    };
    let d = ValueNet::new(doubled).expect("モデル");
    let z1 = a.eval(&s, 0, ValuePhase::End) * one.a - one.c - one.b2;
    let z2 = d.eval(&s, 0, ValuePhase::End) * one.a - one.c - one.b2;
    assert!((z2 - 2.0 * z1).abs() < 1e-9);
    // 大きさ違い（3 → 出力の重み 4）・JSON の layers を読む
    let bad = RawValueNet {
        layers: vec![RawValueNetLayer {
            w: vec![0.0; 12],
            b: vec![0.0; 3],
        }],
        ..one.clone()
    };
    assert!(ValueNet::new(bad).is_err());
    let json = serde_json::json!({
        "kind": two.kind, "version": two.version, "vocab": two.vocab, "zones": two.zones, "scalars": two.scalars,
        "hidden": two.hidden, "w1": two.w1, "b1": two.b1, "layers": [{"w": identity.w, "b": identity.b}],
        "w2": two.w2, "b2": two.b2, "a": two.a, "c": two.c, "baseWeights": {}
    });
    let read = ValueNet::new(serde_json::from_value(json).expect("モデルの JSON")).expect("モデル");
    assert_eq!(
        read.eval(&s, 1, ValuePhase::After),
        b.eval(&s, 1, ValuePhase::After)
    );
}

/// 狂気の創造者・リーアムが人形に付与する能力（ラストワード: 相手のリーダーに 2 ダメージ）の JSON。
/// TypeScript 側の boardGrantKeys（tests/ai.test.ts）も同じ文字列を作る
const DOLL_LAST_WORDS: &str = r#"{"trigger":{"on":"lastWords"},"effects":[{"op":"damage","target":{"kind":"leader","side":"opponent"},"amount":2}]}"#;

/// 局面の players[q].board[i] に能力（JSON）を付与した局面
fn with_granted(s: &GameState, q: usize, i: usize, ability: &str) -> GameState {
    let mut j = state_to_json(s);
    let mut players = j.take("players").expect("players");
    let Json::Arr(ps) = &mut players else {
        panic!("players")
    };
    let mut board = ps[q].take("board").expect("board");
    let Json::Arr(cards) = &mut board else {
        panic!("board")
    };
    let mut granted = cards[i].take("granted").expect("granted");
    let Json::Arr(list) = &mut granted else {
        panic!("granted")
    };
    list.push(Json::parse(ability).expect("能力の JSON"));
    cards[i].set("granted", granted);
    ps[q].set("board", board);
    j.set("players", players);
    crate::state_json::state_from_json(&j).expect("局面")
}

#[test]
fn board_network() {
    // 場のカードのネットワーク（npm run td -- board）: 出力を受ける最初の層の重み（入力の末尾 2K 個）が 0 なら、
    // 無いモデルと同じ補正。付与された能力を grants の文字列で見分ける。大きさが合わなければ止める
    use crate::ai::aidata::RawValueNetBoard;
    use crate::ai::valuenet::BOARD_FEATURES;
    let base = model(4, |i| ((i * 31) % 11) as f64 / 10.0 - 0.5, 0.7);
    let (v, h) = (base.vocab.len(), base.hidden);
    let n_in = v + 1 + BOARD_FEATURES.len();
    let mut w0: Vec<f64> = (0..n_in * 3)
        .map(|i| ((i * 7) % 5) as f64 / 10.0 - 0.1)
        .collect();
    // 付与された能力（grants の 0 番）の行
    w0[v * 3..v * 3 + 3].copy_from_slice(&[0.5, 0.4, 0.3]);
    let board = RawValueNetBoard {
        features: BOARD_FEATURES.iter().map(|s| s.to_string()).collect(),
        grants: vec![DOLL_LAST_WORDS.into()],
        layers: vec![
            RawValueNetLayer {
                w: w0.clone(),
                b: vec![0.05; 3],
            },
            RawValueNetLayer {
                w: vec![0.3, -0.2, 0.5, 0.1, 0.4, 0.2],
                b: vec![0.0, 0.1],
            },
        ],
    };
    let k = 2;
    let with_board = |board: &RawValueNetBoard, row: &dyn Fn(usize) -> f64| RawValueNet {
        w1: base
            .w1
            .iter()
            .copied()
            .chain((0..2 * k * h).map(row))
            .collect(),
        board: Some(board.clone()),
        ..base.clone()
    };
    let rows = |j: usize| (j as f64 * 0.37).sin();
    let s = mid_game();
    assert!(s.players.iter().all(|p| !p.board.is_empty()));
    let plain = ValueNet::new(base.clone()).expect("モデル");
    let zero = ValueNet::new(with_board(&board, &|_| 0.0)).expect("モデル");
    let net = ValueNet::new(with_board(&board, &rows)).expect("モデル");
    for p in 0..2 {
        for phase in [ValuePhase::End, ValuePhase::After] {
            assert_eq!(zero.eval(&s, p, phase), plain.eval(&s, p, phase));
            assert_ne!(net.eval(&s, p, phase), plain.eval(&s, p, phase));
            // 書き出す入力（encode）は場のカードのネットワークの出力を含まない
            assert_eq!(net.encode(&s, p, phase), plain.encode(&s, p, phase));
        }
    }
    // 付与された能力: Rust 版の能力の JSON の文字列にあり、その行の重みの分だけ補正が変わる
    assert!(ability_json_texts_has(DOLL_LAST_WORDS));
    let (q, i) = (0..2)
        .find_map(|q| {
            s.players[q]
                .board
                .iter()
                .position(|c| c.is_follower)
                .map(|i| (q, i))
        })
        .expect("場のフォロワー");
    let t = with_granted(&s, q, i, DOLL_LAST_WORDS);
    assert_eq!(t.players[q].board[i].granted.len(), 1);
    let mut no_row = board.clone();
    no_row.layers[0].w[v * 3..v * 3 + 3].copy_from_slice(&[0.0; 3]);
    let no_row = ValueNet::new(with_board(&no_row, &rows)).expect("モデル");
    for p in 0..2 {
        assert_ne!(
            net.eval(&t, p, ValuePhase::End),
            net.eval(&s, p, ValuePhase::End)
        );
        assert_eq!(
            no_row.eval(&t, p, ValuePhase::End),
            no_row.eval(&s, p, ValuePhase::End)
        );
    }
    // 大きさ違い（w1 の末尾が足りない・層の重みが足りない）・features の並び違い・JSON の board を読む
    let mut short = with_board(&board, &rows);
    short.w1.pop();
    assert!(ValueNet::new(short).is_err());
    let mut bad = board.clone();
    bad.layers[0].w.pop();
    assert!(ValueNet::new(with_board(&bad, &rows)).is_err());
    let mut reversed = board.clone();
    reversed.features.reverse();
    assert!(ValueNet::new(with_board(&reversed, &rows)).is_err());
    let m = with_board(&board, &rows);
    let layers = |ls: &[RawValueNetLayer]| {
        ls.iter()
            .map(|l| serde_json::json!({"w": l.w, "b": l.b}))
            .collect::<Vec<_>>()
    };
    let json = serde_json::json!({
        "kind": m.kind, "version": m.version, "vocab": m.vocab, "zones": m.zones, "scalars": m.scalars,
        "hidden": m.hidden, "w1": m.w1, "b1": m.b1, "w2": m.w2, "b2": m.b2, "a": m.a, "c": m.c, "baseWeights": {},
        "board": {"features": board.features, "grants": board.grants, "layers": layers(&board.layers)}
    });
    let read = ValueNet::new(serde_json::from_value(json).expect("モデルの JSON")).expect("モデル");
    assert_eq!(
        read.eval(&t, 1, ValuePhase::After),
        net.eval(&t, 1, ValuePhase::After)
    );
}

fn ability_json_texts_has(text: &str) -> bool {
    crate::state_json::ability_json_texts()
        .iter()
        .any(|(_, t)| t == text)
}

#[test]
fn imagined_input() {
    // 想像の局面（探索が相手のターンを読んだ後）は、"imagined" の無いモデルでは After と同じ。
    // 足したモデルでは "imagined" の重みの分だけ変わり、重みが 0 なら同じ（npm run td -- extend）
    let mut old = model(4, |i| ((i * 13) % 7) as f64 / 10.0 - 0.3, 0.5);
    // 今の既定（model の入力の並び）には "imagined" があるので外す（場のカードのネットワークが無いので、最後の数値の入力の行は w1 の末尾）
    if old.scalars.last().is_some_and(|x| x == "imagined") {
        old.scalars.pop();
        let n = old.w1.len() - old.hidden;
        old.w1.truncate(n);
    }
    assert!(!old.scalars.iter().any(|x| x == "imagined"));
    let with_row = |row: f64| {
        let mut m = old.clone();
        m.scalars.push("imagined".into());
        // 場のカードのネットワークの無いモデルなので、最後の数値の入力の行は w1 の末尾
        m.w1.extend((0..m.hidden).map(|j| row * (j as f64 + 1.0)));
        ValueNet::new(m).expect("モデル")
    };
    let (zero, learned) = (with_row(0.0), with_row(0.2));
    let old = ValueNet::new(old).expect("モデル");
    assert!(!old.has_scalar("imagined"));
    assert!(zero.has_scalar("imagined") && learned.has_scalar("imagined"));
    let s = mid_game();
    for p in 0..2 {
        let after = old.eval(&s, p, ValuePhase::After);
        assert_eq!(old.eval(&s, p, ValuePhase::Imagined), after);
        assert_eq!(
            old.encode(&s, p, ValuePhase::Imagined),
            old.encode(&s, p, ValuePhase::After)
        );
        assert_eq!(zero.eval(&s, p, ValuePhase::Imagined), after);
        assert_eq!(
            zero.encode(&s, p, ValuePhase::Imagined).len(),
            zero.encode(&s, p, ValuePhase::After).len() + 1
        );
        assert_eq!(learned.eval(&s, p, ValuePhase::After), after);
        assert_ne!(learned.eval(&s, p, ValuePhase::Imagined), after);
    }
    // 今の既定の補正（s2b）は想像の局面を学んでいる
    let net = default_value_net();
    assert!(net.has_scalar("imagined"));
    assert_ne!(
        net.eval(&s, 0, ValuePhase::Imagined),
        net.eval(&s, 0, ValuePhase::After)
    );
}

#[test]
fn base_weights_model_keeps_policy_weights() {
    // 出発点の重みを変えたモデル（baseWeights）を compare の設定で使うと、自分の評価だけがその重みになり、
    // 読みの中の相手の重み（policyWeights）は探索の既定の重みのまま（docs/ai-notes.md「評価関数の手作りの項を外す」）
    use crate::runner::options::{compare_options, zero_weights_json};
    let m = model(2, |i| (i % 7) as f64 / 10.0, 0.5);
    let zero = zero_weights_json().to_value();
    let json = serde_json::json!({
        "kind": m.kind, "version": m.version, "vocab": m.vocab, "zones": m.zones, "scalars": m.scalars,
        "hidden": m.hidden, "w1": m.w1, "b1": m.b1, "w2": m.w2, "b2": m.b2, "a": m.a, "c": m.c, "baseWeights": zero
    });
    let path = std::env::temp_dir().join(format!("svwb-base-weights-{}.json", std::process::id()));
    std::fs::write(&path, json.to_string()).expect("モデルを書く");
    let path = path.to_str().expect("パス").replace('\\', "/");
    let search = &ai_data().search_weights;
    let o = compare_options(&format!(r#"{{"valueNet":"{path}"}}"#)).expect("設定");
    let w = o.weights.as_ref().expect("重み");
    assert_eq!(
        (w.my_hp, w.attack, w.my_hand, w.max_pp),
        (0.0, 0.0, 0.0, 0.0)
    );
    let pw = o.policy_weights.as_ref().expect("方策の重み");
    assert_eq!(
        (pw.my_hand, pw.max_pp, pw.sep),
        (search.my_hand, search.max_pp, search.sep)
    );
    assert!(o.extra_eval.is_some());
    // policyWeights を書けばそちら
    let o = compare_options(&format!(
        r#"{{"valueNet":"{path}","policyWeights":"default"}}"#
    ))
    .expect("設定");
    assert_eq!(o.policy_weights.expect("方策の重み").max_pp, 0.0);
    // 補正のファイルなしなら、weights の文字列の指定で基準の重み・全部 0 にし、方策の重みは書かなければ既定のまま
    // （既定の補正に baseWeights が無ければ無し＝weights と同じ。S = 0 の補正が既定なら探索 AI の既定の重み）
    let o = compare_options(r#"{"weights":"zero"}"#).expect("設定");
    assert_eq!(o.weights.expect("重み").my_hp, 0.0);
    assert_eq!(
        o.policy_weights.map(|w| w.max_pp),
        SearchOptions::default().policy_weights.map(|w| w.max_pp)
    );
    let o = compare_options(r#"{"weights":"default","policyWeights":"search"}"#).expect("設定");
    assert_eq!(o.weights.expect("重み").max_pp, 0.0);
    assert_eq!(o.policy_weights.expect("方策の重み").max_pp, search.max_pp);
    assert!(compare_options(r#"{"weights":"nope"}"#).is_err());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn search_weights_follow_net_base_weights() {
    // 探索の自分の評価の重みは補正の出発点の重み（baseWeights）に合わせ、読みの中の相手などの方策は探索の既定の重みのまま。
    // S = 0 の補正（baseWeights が全部 0）を既定にしても、探索は補正だけで点数を付ける（docs/ai-notes.md「評価関数の手作りの項を外す」）
    use crate::ai::valuenet::base_weight_options;
    use crate::json::Json;
    use crate::runner::options::{search_options, zero_weights_json};
    let search = &ai_data().search_weights;
    let (w, pw) = base_weight_options(&serde_json::Map::new()).expect("空");
    assert!(w.is_none() && pw.is_none());
    let serde_json::Value::Object(zero) = zero_weights_json().to_value() else {
        panic!("重みはオブジェクト");
    };
    let (w, pw) = base_weight_options(&zero).expect("全部 0");
    let (w, pw) = (w.expect("重み"), pw.expect("方策の重み"));
    assert_eq!(
        (w.my_hp, w.attack, w.my_hand, w.max_pp),
        (0.0, 0.0, 0.0, 0.0)
    );
    assert_eq!(
        (pw.my_hand, pw.max_pp, pw.sep),
        (search.my_hand, search.max_pp, search.sep)
    );
    // 今の既定の補正に baseWeights が無ければ、既定の設定は探索の既定の重み（None）
    assert_eq!(
        default_value_net().base_weights.is_empty(),
        SearchOptions::default().weights.is_none()
    );
    // S = 0 の補正が既定のときの設定を作り、補正を替えた・外した（"extraEval"）ときは、その重みを使わないことを確かめる
    let zero_default = SearchOptions {
        weights: Some(w.clone()),
        policy_weights: Some(pw.clone()),
        ..SearchOptions::default()
    };
    let kept = search_options(
        &Json::parse("{}").expect("JSON"),
        None,
        zero_default.clone(),
        &[],
    )
    .expect("設定");
    assert_eq!(kept.weights.expect("重み").my_hp, 0.0);
    let off = search_options(
        &Json::parse(r#"{"extraEval":null}"#).expect("JSON"),
        None,
        zero_default.clone(),
        &[],
    )
    .expect("設定");
    assert!(off.extra_eval.is_none() && off.weights.is_none() && off.policy_weights.is_none());
    // 替えた補正の重み（apply_value_net が書く "weights"）は入る
    let raw = format!(
        r#"{{"extraEval":null,"weights":{}}}"#,
        zero_weights_json().stringify()
    );
    let own =
        search_options(&Json::parse(&raw).expect("JSON"), None, zero_default, &[]).expect("設定");
    assert_eq!(own.weights.expect("重み").my_hp, 0.0);
    assert!(own.policy_weights.is_none());
}

/// 全部の入力（ZONES・SCALARS）を持ち、重みが 0 でないモデル
fn full_model(hidden: usize) -> ValueNet {
    use crate::ai::valuenet::{SCALARS, ZONES};
    let base = model(hidden, |_| 0.0, 0.7);
    let n = ZONES.len() * base.vocab.len() + SCALARS.len();
    ValueNet::new(RawValueNet {
        zones: ZONES.iter().map(|s| s.to_string()).collect(),
        scalars: SCALARS.iter().map(|s| s.to_string()).collect(),
        w1: (0..n * hidden)
            .map(|i| ((i * 7919) % 23) as f64 / 40.0 - 0.27)
            .collect(),
        ..base
    })
    .expect("モデル")
}

/// 貪欲法で打った試合の途中の局面（デッキの組と種ごとに、いくつかの手数の後）
fn played_states() -> Vec<GameState> {
    let mut out = Vec::new();
    let n = data().decks.len();
    for (k, seed) in [11u32, 23, 37, 41, 59, 73].into_iter().enumerate() {
        let mut s = new_game(deck_at(k % n), deck_at((k * 3 + 1) % n), seed);
        let mut agent = greedy_base();
        let mut rng = Rng::new(seed);
        for step in 0..400 {
            if s.phase == Phase::Ended {
                break;
            }
            if step % 9 == 4 {
                out.push(s.clone());
            }
            let a = agent.choose_action(&s, &legal_actions(&s), &mut rng);
            s = apply(&s, &a);
        }
    }
    out
}

#[test]
fn deck_inputs_do_not_change_with_determinize() {
    // 山札の中身の入力（自分の山札に残っているカード・相手のまだ見えていないカード）は、決定化で並べ直しても同じ。
    // 入力の並びも同じなので、補正の値もビットまで同じ（docs/value-net.md「入力」）
    use crate::ai::determinize::{determinize, determinize_apart, determinize_with};
    use crate::ai::valuenet::ZONES;
    let net = full_model(6);
    let v = net.layout_json().matches("\"crest:").count() + data().cards.len();
    let zone = |name: &str| ZONES.iter().position(|z| *z == name).unwrap() * v;
    let (my_deck, opp_unseen) = (zone("myDeckCards"), zone("oppUnseen"));
    let sum_in = |x: &[(usize, f64)], from: usize| -> f64 {
        x.iter()
            .filter(|(i, _)| (from..from + v).contains(i))
            .map(|(_, x)| x)
            .sum()
    };
    let states = played_states();
    assert!(states.len() > 30, "局面 {}", states.len());
    let mut rng = Rng::new(3);
    let mut with_hidden_hand = 0;
    for s in &states {
        for p in 0..2 {
            let x = net.encode(s, p, ValuePhase::End);
            let me = &s.players[p];
            let opp = &s.players[opponent(p)];
            assert_eq!(sum_in(&x, my_deck), me.deck.len() as f64);
            let hidden = opp.hand.iter().filter(|h| !h.revealed).count();
            with_hidden_hand += usize::from(hidden > 0);
            assert_eq!(
                sum_in(&x, opp_unseen),
                (hidden + opp.deck.len() + opp.hidden_discards.len()) as f64
            );
            let z = net.eval(s, p, ValuePhase::End);
            for t in [
                determinize(s, p, &mut rng, false),
                determinize_apart(s, p, &mut rng, false),
            ] {
                assert_eq!(net.encode(&t, p, ValuePhase::End), x);
                assert_eq!(net.eval(&t, p, ValuePhase::End).to_bits(), z.to_bits());
            }
            // 伏せた手札のスペルブーストを見込む決定化（oppHandBoosts。既定では切る）は、かけ直したスペルブーストで変身したカードの分だけ
            // 相手のまだ見えていないカードが変わることがある。自分の山札の入力は同じ
            let t = determinize_with(s, p, &mut rng, false, true);
            let mine = |x: &[(usize, f64)]| -> Vec<(usize, f64)> {
                x.iter()
                    .copied()
                    .filter(|(i, _)| (my_deck..my_deck + v).contains(i))
                    .collect()
            };
            assert_eq!(mine(&net.encode(&t, p, ValuePhase::End)), mine(&x));
        }
    }
    assert!(with_hidden_hand > 20);
    // 自分の山札を入れ替えると変わる（山札の中身を見ている）
    let s = &states[states.len() / 2];
    let p = s.active;
    let mut t = s.clone();
    let deck = t.players[p].deck.make_mut();
    let other = deck
        .iter()
        .position(|r| r.card != deck[0].card)
        .expect("違うカード");
    deck[0].card = deck[other].card;
    assert_ne!(
        net.encode(&t, p, ValuePhase::End),
        net.encode(s, p, ValuePhase::End)
    );
}

#[test]
fn deck_and_hand_buffs_are_inputs() {
    // 自分の山札のフォロワーに付いた攻撃力・体力の変化の合計（ダストデイズのクレストの山札の強化）は数値の入力に、
    // 手札のカードに付いた変化はカードごとの入力に出て、決定化で並べ直しても変わらない（docs/value-net.md「入力」）
    use crate::ai::determinize::determinize;
    use crate::ai::valuenet::{SCALARS, ZONES};
    use crate::data::CardType;
    let net = full_model(6);
    let v = net.layout_json().matches("\"crest:").count() + data().cards.len();
    let scalar = |x: &[(usize, f64)], name: &str| -> f64 {
        let at = ZONES.len() * v + SCALARS.iter().position(|z| *z == name).unwrap();
        x.iter().find(|(i, _)| *i == at).map_or(0.0, |(_, x)| *x)
    };
    // カードごとの入力 name の値（カードの添字と値）
    let zone = |x: &[(usize, f64)], name: &str| -> Vec<(usize, f64)> {
        let from = ZONES.iter().position(|z| *z == name).unwrap() * v;
        x.iter()
            .filter(|(i, _)| (from..from + v).contains(i))
            .map(|&(i, x)| (i - from, x))
            .collect()
    };
    let follower = |c: crate::data::CardIdx| card(c).ctype == CardType::Follower;
    let states = played_states();
    let s = states
        .iter()
        .find(|s| {
            let me = &s.players[s.active];
            s.phase == Phase::Main
                && me.hand.iter().any(|h| follower(h.card))
                && me.deck.iter().filter(|r| follower(r.card)).count() >= 5
        })
        .expect("手札と山札にフォロワーがある局面");
    let p = s.active;
    let x = net.encode(s, p, ValuePhase::End);
    for name in ["myDeckAtkMod", "myDeckDefMod"] {
        assert_eq!(scalar(&x, name), 0.0, "{name}");
    }
    for name in ["myHandAtkMod", "myHandDefMod"] {
        assert!(zone(&x, name).is_empty(), "{name}");
    }
    // 山札のフォロワーを全部 +1/+2（buffDeck と同じく deck_kept に持つ）、手札のフォロワー 1 枚を +3/+0
    let mut t = s.clone();
    let picked: Vec<_> = t.players[p]
        .deck
        .iter()
        .filter(|r| follower(r.card))
        .map(|r| (r.iid, r.card))
        .collect();
    for &(iid, c) in &picked {
        let mut h = t
            .take_kept(p, iid)
            .unwrap_or_else(|| t.new_hand_card(c, Some(iid)));
        h.attack_mod += 1;
        h.defense_mod += 2;
        t.players[p].deck_kept.push(h);
    }
    let i = t.players[p]
        .hand
        .iter()
        .position(|h| follower(h.card))
        .unwrap();
    t.players[p].hand.make_mut()[i].attack_mod += 3;
    let y = net.encode(&t, p, ValuePhase::End);
    let n = picked.len() as f64;
    assert_eq!(scalar(&y, "myDeckAtkMod"), n / 20.0);
    assert_eq!(scalar(&y, "myDeckDefMod"), 2.0 * n / 20.0);
    // 変えた 1 枚の分だけが、手札の入力（myHand）と同じカードの添字に出る
    let got = zone(&y, "myHandAtkMod");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].1, 3.0 / 5.0);
    assert!(zone(&y, "myHand").iter().any(|&(c, _)| c == got[0].0));
    assert!(zone(&y, "myHandDefMod").is_empty());
    assert_ne!(
        net.eval(&t, p, ValuePhase::End).to_bits(),
        net.eval(s, p, ValuePhase::End).to_bits()
    );
    // 相手から見た入力は変わらない（相手の山札・手札の変化は入れない）
    let q = opponent(p);
    assert_eq!(
        net.encode(&t, q, ValuePhase::End),
        net.encode(s, q, ValuePhase::End)
    );
    // 自分の山札の順番を並べ直しても同じ
    let mut rng = Rng::new(5);
    for _ in 0..4 {
        assert_eq!(
            net.encode(&determinize(&t, p, &mut rng, false), p, ValuePhase::End),
            y
        );
    }
}

#[test]
fn amulet_and_crest_counts_are_inputs() {
    // 相手の場のアミュレットのカウントと、両方のクレストのカウント・信仰値・信仰に付いた能力の数（2026-11-22）は
    // クレスト・カードごとの入力に出て、決定化で並べ直しても変わらない（docs/value-net.md「入力」）
    use crate::ai::determinize::determinize;
    use crate::ai::valuenet::ZONES;
    use crate::data::CardType;
    let net = full_model(6);
    let v = net.layout_json().matches("\"crest:").count() + data().cards.len();
    let zone = |x: &[(usize, f64)], name: &str| -> Vec<(usize, f64)> {
        let from = ZONES.iter().position(|z| *z == name).unwrap() * v;
        x.iter()
            .filter(|(i, _)| (from..from + v).contains(i))
            .map(|&(i, x)| (i - from, x))
            .collect()
    };
    let added = [
        "oppBoardCountdown",
        "myCrestCountdown",
        "oppCrestCountdown",
        "myCrestFaith",
        "oppCrestFaith",
        "myCrestStacks",
        "oppCrestStacks",
    ];
    let amulet = data()
        .cards
        .iter()
        .position(|c| c.ctype == CardType::Amulet && c.countdown.is_some())
        .expect("カウントダウンを持つアミュレット") as crate::data::CardIdx;
    let states = played_states();
    let s = states
        .iter()
        .find(|s| {
            s.phase == Phase::Main
                && s.players.iter().all(|pl| pl.crests.is_empty())
                && s.players[opponent(s.active)].board.len() < 5
        })
        .expect("クレストが無く、相手の場が空いている局面");
    let p = s.active;
    let q = opponent(p);
    for name in added {
        assert!(
            zone(&net.encode(s, p, ValuePhase::End), name).is_empty(),
            "{name}"
        );
    }
    // 相手の場にカウント 2 のアミュレット、自分にカウント 2・信仰値 7・能力 2 つのクレスト、相手にカウント 1 のクレスト
    let mut t = s.clone();
    let mut b = t.new_board_card(amulet, None);
    b.countdown = Some(2);
    t.players[q].board.make_mut().push(b);
    let crest = |t: &mut GameState, countdown, faith, stacks| CrestInstance {
        iid: t.new_iid(),
        crest: 0,
        countdown,
        order: 0,
        used_once: Vec::new(),
        faith,
        stacks,
    };
    let mine = crest(&mut t, Some(2), Some(7), 2);
    t.players[p].crests.make_mut().push(mine);
    let theirs = crest(&mut t, Some(1), None, 0);
    t.players[q].crests.make_mut().push(theirs);
    let y = net.encode(&t, p, ValuePhase::End);
    let one = |name: &str| {
        let z = zone(&y, name);
        assert_eq!(z.len(), 1, "{name}");
        z[0]
    };
    let k = one("myCrest").0;
    assert_eq!(one("myCrestCountdown"), (k, 2.0 / 3.0));
    assert_eq!(one("myCrestFaith"), (k, 0.7));
    assert_eq!(one("myCrestStacks"), (k, 2.0));
    assert_eq!(one("oppCrestCountdown"), (k, 1.0 / 3.0));
    assert!(zone(&y, "oppCrestFaith").is_empty());
    assert!(zone(&y, "oppCrestStacks").is_empty());
    let (c, x) = one("oppBoardCountdown");
    assert_eq!(x, 2.0 / 3.0);
    assert!(zone(&y, "oppBoard").iter().any(|&(i, _)| i == c));
    assert_ne!(
        net.eval(&t, p, ValuePhase::End).to_bits(),
        net.eval(s, p, ValuePhase::End).to_bits()
    );
    // 相手から見ると、アミュレットは自分の側の入力（myBoardCountdown）に、クレストは逆の側に出る
    let z = net.encode(&t, q, ValuePhase::End);
    assert!(zone(&z, "myBoardCountdown").contains(&(c, 2.0 / 3.0)));
    assert!(zone(&z, "oppBoardCountdown").is_empty());
    assert_eq!(zone(&z, "oppCrestFaith"), vec![(k, 0.7)]);
    assert_eq!(zone(&z, "myCrestCountdown"), vec![(k, 1.0 / 3.0)]);
    // 決定化で並べ直しても同じ
    let mut rng = Rng::new(7);
    for _ in 0..4 {
        assert_eq!(
            net.encode(&determinize(&t, p, &mut rng, false), p, ValuePhase::End),
            y
        );
    }
}

#[test]
fn extended_model_keeps_values_and_layout() {
    // 山札の中身の入力を重み 0 で足したモデル（npm run td -- extend）は、足す前のモデルと同じ値を出す。入力の並びは先頭の行に書く形で出す
    use crate::ai::valuenet::ZONES;
    let mut base = model(4, |i| ((i * 31) % 17) as f64 / 30.0 - 0.25, 0.6);
    let v = base.vocab.len();
    let h = base.hidden;
    // 今の既定の補正（B、2026-11-15）は山札の中身の入力を持つので、それを外した形から始める
    base.zones
        .retain(|z| z != "myDeckCards" && z != "oppUnseen");
    base.w1
        .truncate((base.zones.len() * v + base.scalars.len()) * h);
    let n_old = base.zones.len() * v;
    let mut zones = base.zones.clone();
    zones.extend(["myDeckCards".to_string(), "oppUnseen".to_string()]);
    assert!(zones.iter().all(|z| ZONES.contains(&z.as_str())));
    let mut w1 = base.w1[..n_old * h].to_vec();
    w1.extend(std::iter::repeat_n(0.0, 2 * v * h));
    w1.extend_from_slice(&base.w1[n_old * h..]);
    let wide = ValueNet::new(RawValueNet {
        zones,
        w1,
        ..base.clone()
    })
    .expect("モデル");
    let old = ValueNet::new(base).expect("モデル");
    assert!(wide.has_zone("myDeckCards") && !old.has_zone("myDeckCards"));
    for s in played_states().iter().step_by(5) {
        for p in 0..2 {
            for phase in [ValuePhase::End, ValuePhase::After] {
                assert_eq!(
                    wide.eval(s, p, phase).to_bits(),
                    old.eval(s, p, phase).to_bits()
                );
            }
            assert!(
                wide.encode(s, p, ValuePhase::End).len() > old.encode(s, p, ValuePhase::End).len()
            );
        }
    }
    let layout: serde_json::Value = serde_json::from_str(&wide.layout_json()).expect("JSON");
    assert_eq!(layout["vocab"].as_array().map(|a| a.len()), Some(v));
    assert_eq!(layout["zones"][14], "myDeckCards");
    assert_eq!(layout["scalars"][0], "myHp");
}

/// 層の計算（add_rows）は、行ごとに h 全体へ足す元の形とビットまで同じ値になる（隠れ層の大きさがまとめる数で割り切れないときも。
/// 同じ行を 2 度足す・負の値・0 も）。AVX2 の形と、それの無いときの形の両方
#[test]
fn add_rows_matches_row_by_row_bitwise() {
    use crate::ai::valuenet::{add_rows, add_rows_in};
    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut rnd = move || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((seed >> 11) as f64 / (1u64 << 53) as f64 - 0.5) * 3.0
    };
    for m in [1usize, 3, 15, 16, 17, 31, 32, 33, 64, 100, 256] {
        let n = 40;
        let w: Vec<f64> = (0..n * m).map(|_| rnd()).collect();
        let b: Vec<f64> = (0..m).map(|_| rnd()).collect();
        let mut rows: Vec<(usize, f64)> = (0..25).map(|k| ((k * 7 % n) * m, rnd())).collect();
        rows.push((3 * m, 0.0));
        rows.push((rows[0].0, -rows[0].1));
        let mut want = b.clone();
        for &(o, x) in &rows {
            for (hj, &r) in want.iter_mut().zip(&w[o..o + m]) {
                *hj += x * r;
            }
        }
        let bits = |h: &[f64]| h.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        let mut got = b.clone();
        add_rows(&w, &rows, &mut got);
        assert_eq!(bits(&got), bits(&want), "add_rows（隠れ層 {m}）");
        let mut got = b.clone();
        add_rows_in::<16>(&w, &rows, &mut got);
        assert_eq!(bits(&got), bits(&want), "add_rows_in::<16>（隠れ層 {m}）");
        let mut got = b.clone();
        add_rows_in::<32>(&w, &rows, &mut got);
        assert_eq!(bits(&got), bits(&want), "add_rows_in::<32>（隠れ層 {m}）");
    }
}

#[test]
fn lethal_head_does_not_change_the_value_unless_survival() {
    // リーサルの出力を足したモデル（実験 X。winForm なし）は、出力を足す前と同じ補正をビットまで同じに返す。
    // リーサルの確率は出力があるときだけ出す（docs/value-net.md「リーサルの出力（実験）」）
    let c = model(4, |i| ((i * 31) % 11) as f64 / 10.0 - 0.5, 0.7);
    let x = RawValueNet {
        lethal_head: Some(RawLethalHead {
            w: vec![0.3, -0.2, 0.5, 0.1],
            b: -1.0,
        }),
        ..c.clone()
    };
    let s = mid_game();
    let (nc, nx) = (
        ValueNet::new(c.clone()).expect("モデル"),
        ValueNet::new(x).expect("モデル"),
    );
    assert!(!nc.has_lethal_head() && nx.has_lethal_head());
    for p in 0..2 {
        for phase in [ValuePhase::End, ValuePhase::After, ValuePhase::Imagined] {
            assert_ne!(nc.eval(&s, p, phase), 0.0);
            assert_eq!(
                nc.eval(&s, p, phase).to_bits(),
                nx.eval(&s, p, phase).to_bits()
            );
            assert_eq!(nc.lethal_prob(&s, p, phase), None);
            let q = nx.lethal_prob(&s, p, phase).expect("リーサルの確率");
            assert!(q > 0.0 && q < 1.0);
        }
    }
    // 大きさの合わない出力は読まない
    let bad = RawValueNet {
        lethal_head: Some(RawLethalHead {
            w: vec![0.0; 3],
            b: 0.0,
        }),
        ..c
    };
    assert!(ValueNet::new(bad).is_err());
}

#[test]
fn survival_form_multiplies_the_survival_probability() {
    // winForm "survival"（実験 Z）: 勝つ確率 = (1 − リーサルの確率) × σ(c + z)。補正はそのロジットを a で割ったもの
    let c = model(4, |i| ((i * 31) % 11) as f64 / 10.0 - 0.5, 0.7);
    let with = |w: Vec<f64>, b: f64| RawValueNet {
        lethal_head: Some(RawLethalHead { w, b }),
        win_form: Some("survival".into()),
        ..c.clone()
    };
    let s = mid_game();
    let nc = ValueNet::new(c.clone()).expect("モデル");
    // リーサルの確率がほぼ 0 なら、今までの形と同じ値（ロジットを行き来する丸めの分だけ違う）
    let near = ValueNet::new(with(vec![0.0; 4], -40.0)).expect("モデル");
    // リーサルの確率が 1/2 なら、勝つ確率が半分
    let half = ValueNet::new(with(vec![0.0; 4], 0.0)).expect("モデル");
    let sig = |x: f64| 1.0 / (1.0 + (-x).exp());
    for p in 0..2 {
        for phase in [ValuePhase::End, ValuePhase::Imagined] {
            let v = nc.eval(&s, p, phase);
            assert!((near.eval(&s, p, phase) - v).abs() < 1e-6 * v.abs().max(1.0));
            let win = sig(c.a * half.eval(&s, p, phase));
            assert!((win - 0.5 * sig(c.a * v)).abs() < 1e-12);
            assert_eq!(half.lethal_prob(&s, p, phase), Some(0.5));
        }
    }
    // リーサルの出力が無い・出発点の評価が 0 でない・知らない形は読まない
    let no_head = RawValueNet {
        win_form: Some("survival".into()),
        ..c.clone()
    };
    assert!(ValueNet::new(no_head).is_err());
    let mut base = serde_json::Map::new();
    base.insert("myHp".into(), serde_json::json!(1.0));
    let with_base = RawValueNet {
        base_weights: base,
        ..with(vec![0.0; 4], 0.0)
    };
    assert!(ValueNet::new(with_base).is_err());
    let unknown = RawValueNet {
        win_form: Some("product".into()),
        ..with(vec![0.0; 4], 0.0)
    };
    assert!(ValueNet::new(unknown).is_err());
    // JSON の lethalHead・winForm を読む
    let json = serde_json::json!({
        "kind": c.kind, "version": c.version, "vocab": c.vocab, "zones": c.zones, "scalars": c.scalars,
        "hidden": c.hidden, "w1": c.w1, "b1": c.b1, "w2": c.w2, "b2": c.b2, "a": c.a, "c": c.c, "baseWeights": {},
        "lethalHead": {"w": [0.0, 0.0, 0.0, 0.0], "b": 0.0}, "winForm": "survival"
    });
    let read = ValueNet::new(serde_json::from_value(json).expect("モデルの JSON")).expect("モデル");
    assert_eq!(
        read.eval(&s, 0, ValuePhase::End),
        half.eval(&s, 0, ValuePhase::End)
    );
}

#[test]
fn survival_win_form_adds_the_win_probability() {
    // winForm "survivalWin"（2026-11-22、R6 の候補）: 勝つ確率 = (1 − q) × (w + (1 − w) × σ(c + z))。
    // 勝ちの出力 w が 0 に近ければ survival と同じ値、w が 1/2 なら生き延びたときの勝率が (1 + σ(c + z)) / 2。
    // 勝ちの出力・読みの出力を足しても、winForm が survival のままなら補正はビットまで同じ
    let c = model(4, |i| ((i * 31) % 11) as f64 / 10.0 - 0.5, 0.7);
    let head = |b: f64| Some(RawLethalHead { w: vec![0.0; 4], b });
    let z = RawValueNet {
        lethal_head: head(0.0),
        win_form: Some("survival".into()),
        ..c.clone()
    };
    let with = |b: f64| RawValueNet {
        win_head: head(b),
        win_form: Some("survivalWin".into()),
        ..z.clone()
    };
    let aux = RawValueNet {
        win_head: Some(RawLethalHead {
            w: vec![0.3, -0.2, 0.5, 0.1],
            b: -1.0,
        }),
        read_head: Some(RawLethalHead {
            w: vec![-0.1, 0.4, 0.0, 0.2],
            b: 0.5,
        }),
        ..z.clone()
    };
    let s = mid_game();
    let nz = ValueNet::new(z.clone()).expect("モデル");
    let near = ValueNet::new(with(-40.0)).expect("モデル");
    let half = ValueNet::new(with(0.0)).expect("モデル");
    let na = ValueNet::new(aux).expect("モデル");
    assert!(!nz.has_win_head() && half.has_win_head() && na.has_read_head());
    let sig = |x: f64| 1.0 / (1.0 + (-x).exp());
    let nc = ValueNet::new(c.clone()).expect("モデル");
    for p in 0..2 {
        for phase in [ValuePhase::End, ValuePhase::Imagined] {
            let v = nz.eval(&s, p, phase);
            assert!((near.eval(&s, p, phase) - v).abs() < 1e-6 * v.abs().max(1.0));
            // 生き延びたときの勝率 σ(c + z) は、出力の無いモデルの勝つ確率
            let sv = sig(c.a * nc.eval(&s, p, phase));
            let win = sig(c.a * half.eval(&s, p, phase));
            assert!((win - 0.5 * (0.5 + 0.5 * sv)).abs() < 1e-12);
            assert_eq!(
                na.eval(&s, p, phase).to_bits(),
                v.to_bits(),
                "補助の出力は値を変えない"
            );
            assert_eq!(half.head_probs(&s, p, phase), [Some(0.5), Some(0.5), None]);
            let [q, w, r] = na.head_probs(&s, p, phase);
            assert_eq!(q, Some(0.5));
            assert!(w.is_some_and(|w| w > 0.0 && w < 1.0));
            assert!(r.is_some_and(|r| r > 0.0 && r < 1.0));
            assert_eq!(nc.head_probs(&s, p, phase), [None; 3]);
        }
    }
    // 勝ちの出力が無い survivalWin・大きさの合わない出力は読まない
    let no_win = RawValueNet {
        win_form: Some("survivalWin".into()),
        ..z.clone()
    };
    assert!(ValueNet::new(no_win).is_err());
    let bad = RawValueNet {
        read_head: Some(RawLethalHead {
            w: vec![0.0; 3],
            b: 0.0,
        }),
        ..z
    };
    assert!(ValueNet::new(bad).is_err());
}
