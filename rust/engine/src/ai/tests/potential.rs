//! ターン途中の見込みのネットワーク（potentialNet）。学習は scripts/potential-main.ts（tests/potential.test.ts）

use super::*;
use crate::ai::potential::{default_vocab, PotentialEncoder, PotentialNet, P_SCALARS, P_ZONES};
use crate::ai::search::{SearchAgent, SearchOptions};
use std::sync::Arc;

/// 先攻の最初のターンのメインフェイズ
fn main_phase() -> GameState {
    let s = keep_hands(new_game(deck_at(0), deck_at(1), 5));
    assert_eq!(s.phase, Phase::Main);
    s
}

/// 数値の入力 name の添字
fn scalar(name: &str) -> usize {
    P_ZONES.len() * default_vocab().len()
        + P_SCALARS
            .iter()
            .position(|&n| n == name)
            .expect("数値の入力")
}

/// モデルの JSON を一時ファイルに書いてパスを返す
fn write_model(name: &str, json: &serde_json::Value) -> String {
    let path =
        std::env::temp_dir().join(format!("svwb-potential-{}-{name}.json", std::process::id()));
    std::fs::write(&path, json.to_string()).expect("書き込み");
    path.to_string_lossy().into_owned()
}

/// 隠れ層 2 つで、残り PP だけを見るモデル（見込み = 0.5 + 3 × 残り PP / 10）
fn pp_model() -> serde_json::Value {
    let n = P_ZONES.len() * default_vocab().len() + P_SCALARS.len();
    let mut w1 = vec![0.0; n * 2];
    w1[scalar("pp") * 2] = 1.0;
    w1[scalar("pp") * 2 + 1] = -1.0;
    serde_json::json!({
        "kind": "potential-net", "version": 1, "vocab": default_vocab(), "zones": P_ZONES, "scalars": P_SCALARS,
        "hidden": 2, "w1": w1, "b1": [0.0, 0.0], "w2": [3.0, 5.0], "b2": 0.5
    })
}

#[test]
fn encodes_hand_and_pp_of_the_active_player() {
    let s = main_phase();
    let p = s.active;
    let enc = PotentialEncoder::new(&default_vocab());
    let mut x = Vec::new();
    enc.encode(&s, p, &mut x);
    let v = default_vocab().len();
    let hand: f64 = x.iter().filter(|(i, _)| *i < v).map(|(_, x)| x).sum();
    assert_eq!(hand, s.players[p].hand.len() as f64);
    let pp = x
        .iter()
        .find(|(i, _)| *i == scalar("pp"))
        .map_or(0.0, |e| e.1);
    assert_close(pp, s.players[p].pp as f64 / 10.0);
    // 同じ添字は 1 つにまとめる
    let mut ids: Vec<usize> = x.iter().map(|e| e.0).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), x.len());
    // メインフェイズでない側は空
    enc.encode(&s, opponent(p), &mut x);
    assert!(x.is_empty());
}

#[test]
fn reads_model_and_evaluates_like_the_weights() {
    let s = main_phase();
    let p = s.active;
    let path = write_model("eval", &pp_model());
    let net = PotentialNet::load(&path).expect("モデル");
    let _ = std::fs::remove_file(&path);
    let pp = s.players[p].pp as f64 / 10.0;
    assert!(pp > 0.0);
    assert_close(net.eval(&s, p), 0.5 + 3.0 * pp);
    assert_eq!(net.eval(&s, opponent(p)), 0.0);
}

#[test]
fn rejects_model_with_other_inputs_or_sizes() {
    let mut m = pp_model();
    m["zones"] = serde_json::json!(["board", "hand"]);
    let path = write_model("zones", &m);
    assert!(PotentialNet::load(&path).is_err());
    let mut m = pp_model();
    m["hidden"] = serde_json::json!(3);
    let path2 = write_model("sizes", &m);
    assert!(PotentialNet::load(&path2).is_err());
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(&path2);
}

#[test]
fn search_with_potential_chooses_a_legal_action() {
    let s = main_phase();
    let path = write_model("search", &pp_model());
    let net = Arc::new(PotentialNet::load(&path).expect("モデル"));
    let _ = std::fs::remove_file(&path);
    let mut agent = SearchAgent::new(SearchOptions {
        potential: Some(net),
        beam_width: 16,
        ..SearchOptions::default()
    });
    let legal = legal_actions(&s);
    let a = agent.choose_action(&s, &legal, &mut Rng::new(3));
    assert!(legal.contains(&a));
}
