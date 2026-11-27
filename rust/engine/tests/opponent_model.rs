//! 読みの中の相手の採点を別のモデルにする設定（opponentSearch の `"valueNet"`・`"potentialNet"`。2026-11-27、測り用。
//! docs/ai-notes/15-2026-11-22.md「読みの中の相手を物差しの相手 v0 の評価にした付け込み」）を確かめる。
//!
//! 1. 読みの中の相手のモデルに自分と同じ補正（R6）を書くと、`"ownWeights": true`（新しいプールの既定）と同じ考えになる
//!    （候補ごとの読み直した点数と選ぶときの値が、最後の桁まで同じ）
//! 2. v0 の補正を書くと、読み直した点数が変わる（設定が効いている）
//!
//! 局面は新しいプールの問題集（misses/azvaldt/）の初めの 4 問の最初の判断。

use std::fs;
use svwb_engine::ai::search::SearchAgent;
use svwb_engine::ai::think::Thought;
use svwb_engine::ai::Rng;
use svwb_engine::json::Json;
use svwb_engine::legal_actions;
use svwb_engine::runner::options::compare_options;
use svwb_engine::state_json::state_from_json;
use svwb_engine::GameState;

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn dir() -> String {
    format!("{}/rust/engine/yardstick", root())
}

/// 新しいプールの既定の探索 AI（補正 R6・見込み R4）の --opts に、opponentSearch を書いたもの
fn options(opponent_search: &str) -> String {
    let d = dir();
    format!(
        r#"{{"valueNet":"{d}/pool-r6-net.json","potentialNet":"{d}/pool-r4-potential.json","opponentSearch":{opponent_search},"imaginedInput":false}}"#
    )
}

fn problems() -> Vec<GameState> {
    let dir = format!("{}/misses/azvaldt", root());
    let mut files: Vec<String> = fs::read_dir(&dir)
        .expect("misses/azvaldt")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    files.sort();
    files
        .iter()
        .take(4)
        .map(|name| {
            let text = fs::read_to_string(format!("{dir}/{name}")).expect("問のファイル");
            let problem = Json::parse(&text).expect("問の JSON");
            state_from_json(problem.get("state").expect("state")).expect("問の局面")
        })
        .collect()
}

/// 候補ごとの（手、読み直した点数、選ぶときの値）。点数はビットで比べる
fn reads(t: &Thought) -> Vec<(String, Option<u64>, Option<u64>)> {
    t.candidates
        .iter()
        .map(|c| {
            (
                format!("{:?}", c.action),
                c.read.as_ref().map(|r| r.total.to_bits()),
                c.value.map(f64::to_bits),
            )
        })
        .collect()
}

fn think(opts: &str, s: &GameState, seed: u32) -> Option<Thought> {
    let agent = SearchAgent::new(compare_options(opts).expect("設定"));
    agent.think_with(s, &legal_actions(s), &mut Rng::new(seed), None)
}

#[test]
fn opponent_model_same_net_equals_own_weights_and_v0_changes_reads() {
    let d = dir();
    let own = options(r#"{"beamWidth":8,"maxDepth":8,"extraEval":true,"ownWeights":true}"#);
    let same = options(&format!(
        r#"{{"beamWidth":8,"maxDepth":8,"extraEval":true,"valueNet":"{d}/pool-r6-net.json"}}"#
    ));
    let v0 = options(&format!(
        r#"{{"beamWidth":8,"maxDepth":8,"extraEval":true,"valueNet":"{d}/pool-v0-net.json"}}"#
    ));
    let mut read_somewhere = false;
    let mut changed = false;
    for (i, s) in problems().iter().enumerate() {
        let seed = 1000 + i as u32;
        let a = think(&own, s, seed);
        let b = think(&same, s, seed);
        let (Some(a), Some(b)) = (a, b) else {
            continue;
        };
        assert_eq!(
            reads(&a),
            reads(&b),
            "問 {i}: 読みの中の相手に自分と同じ補正を書くと ownWeights と同じ考えになるはず"
        );
        read_somewhere |= a.candidates.iter().any(|c| c.read.is_some());
        let c = think(&v0, s, seed).expect("考え");
        changed |= reads(&a) != reads(&c);
    }
    assert!(read_somewhere, "読み直した候補が 1 つもありません");
    assert!(
        changed,
        "読みの中の相手を v0 の補正にしても読み直した点数が変わりません"
    );
}

#[test]
fn opponent_model_options_are_checked() {
    let d = dir();
    for bad in [
        // extraEval を書かない
        format!(r#"{{"beamWidth":8,"maxDepth":8,"valueNet":"{d}/pool-v0-net.json"}}"#),
        // ownWeights と一緒
        format!(
            r#"{{"beamWidth":8,"maxDepth":8,"extraEval":true,"ownWeights":true,"valueNet":"{d}/pool-v0-net.json"}}"#
        ),
        // potential を書かない
        format!(r#"{{"beamWidth":8,"maxDepth":8,"potentialNet":"{d}/pool-v0-potential.json"}}"#),
        // ファイルの場所でない
        r#"{"beamWidth":8,"maxDepth":8,"extraEval":true,"valueNet":true}"#.to_string(),
        r#"{"beamWidth":8,"maxDepth":8,"potential":true,"potentialNet":1}"#.to_string(),
    ] {
        assert!(compare_options(&options(&bad)).is_err(), "{bad}");
    }
    let o = compare_options(&options(&format!(
        r#"{{"beamWidth":8,"maxDepth":8,"extraEval":true,"valueNet":"{d}/pool-v0-net.json","potential":true,"potentialNet":"{d}/pool-v0-potential.json"}}"#
    )))
    .expect("設定");
    assert!(o.opp_extra_eval.is_some() && o.opp_weights.is_some() && o.opp_potential.is_some());
    // v0 の出発点の重み（baseWeights の 39 項目）は全部 0 で hold は空（S = 0）なので、読みの中の相手の手で作った評価も 0
    let w = &o.opp_weights.as_ref().expect("重み").w;
    assert_eq!((w.my_hp, w.attack, w.my_hand), (0.0, 0.0, 0.0));
    assert_eq!(w.doomed, 0.0);
    assert!(
        w.hold.iter().all(|&x| x == 0.0),
        "hold も 0（v0 の baseWeights の hold は空）"
    );
    // 書かなければ使わない（今までどおり自分と同じ）
    let d0 = compare_options(&options(
        r#"{"beamWidth":8,"maxDepth":8,"extraEval":true,"ownWeights":true}"#,
    ))
    .expect("設定");
    assert!(d0.opp_extra_eval.is_none() && d0.opp_weights.is_none() && d0.opp_potential.is_none());
}
