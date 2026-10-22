//! TD 学習の評価の補正（tests/valueNet.test.ts）。
//! モデルの JSON の読み込みは TypeScript 側（tests/ai.test.ts。学習は scripts/valueNet.ts）でも確かめる

use super::*;
use crate::ai::aidata::{RawValueNet, RawValueNetLayer};
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
