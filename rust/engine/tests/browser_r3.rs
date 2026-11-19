//! ブラウザのアズヴォルト環境のページの AI が、コマンドの R3 と同じ手を選ぶか（ユーザーの依頼 2026-11-19）。
//!
//! ページの AI は、WASM の探索 AI（`search`）に、ページが読み込んだ補正と見込み（data/pools/azvaldt/ の JSON を詰めたもの。
//! scripts/pack-nets.ts、src/engine/wasm.ts）を既定として入れたもの。コマンドの R3 は、compare・misses の
//! `--opts '{"valueNet":"rust/engine/yardstick/pool-r3-net.json","potentialNet":"rust/engine/yardstick/pool-r3-potential.json"}'`。
//!
//! ここではコマンドの R3 が決まった局面（新しいプールの問題集 misses/azvaldt/ の 12 問と、代表 10 型のデッキのマリガン）から打つ手を求め、
//! tests/fixtures/browser-r3.json と比べる。問の局面からは、1 つの AI でそのターンの終わりまで打つ（並びを覚えて使い回す経路も通る。
//! 判断ごとの乱数は「局面のシード + 何手目か」）。マリガンは最初の 1 回だけ。
//! 同じファイルを、ブラウザの経路（WASM）で tests/nets-azvaldt.test.ts が比べる。
//! 両方が通れば、ブラウザの R3 はこれらの局面でコマンドの R3 と同じ手を選ぶ。
//! ファイルを書き直すのは、R3 の手が意図して変わったとき（探索 AI の既定を変えた等）だけ: `SVWB_WRITE_FIXTURE=1 cargo test --release --test browser_r3`

use std::fs;
use svwb_engine::ai::{Agent, Rng};
use svwb_engine::data::data;
use svwb_engine::json::Json;
use svwb_engine::legal_actions;
use svwb_engine::runner::options::compare_options;
use svwb_engine::runner::yardstick::pool_decks;
use svwb_engine::state_json::{action_to_json, state_from_json};
use svwb_engine::GameState;
use svwb_engine::{acting_player, apply_action, create_game, Action, Phase};

/// 1 つの局面から打つ手の上限
const MAX_STEPS: u32 = 60;

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

/// 決まった局面と、AI に渡す乱数のシード
struct Position {
    /// 局面の出どころ（問のファイル、またはデッキとシードから作ったマリガン）
    from: Json,
    state: GameState,
    seed: u32,
}

fn positions() -> Vec<Position> {
    let dir = format!("{}/misses/azvaldt", root());
    let mut files: Vec<String> = fs::read_dir(&dir)
        .expect("misses/azvaldt")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    files.sort();
    let mut out = Vec::new();
    for (i, name) in files.iter().enumerate() {
        let text = fs::read_to_string(format!("{dir}/{name}")).expect("問のファイル");
        let problem = Json::parse(&text).expect("問の JSON");
        let state = state_from_json(problem.get("state").expect("state")).expect("問の局面");
        out.push(Position {
            from: Json::Obj(vec![(
                "problem".into(),
                Json::Str(format!("misses/azvaldt/{name}")),
            )]),
            state,
            seed: 1000 + i as u32,
        });
    }
    // マリガン（代表 10 型のデッキの 2 組。マリガンも補正で採点する）
    let decks = pool_decks();
    for (k, (a, b, seed)) in [(0usize, 1usize, 11u32), (6, 9, 23)]
        .into_iter()
        .enumerate()
    {
        let ids = |d: usize| -> Json {
            Json::Arr(
                decks[d]
                    .cards
                    .iter()
                    .map(|&c| Json::Str(data().cards[c as usize].id.clone()))
                    .collect(),
            )
        };
        out.push(Position {
            from: Json::Obj(vec![
                ("decks".into(), Json::Arr(vec![ids(a), ids(b)])),
                ("gameSeed".into(), Json::Num(seed as f64)),
            ]),
            state: create_game([&decks[a].cards, &decks[b].cards], seed),
            seed: 2000 + k as u32,
        });
    }
    out
}

#[test]
fn browser_r3_matches_command_r3() {
    let dir = format!("{}/rust/engine/yardstick", root());
    let opts = compare_options(&format!(
        r#"{{"valueNet":"{dir}/pool-r3-net.json","potentialNet":"{dir}/pool-r3-potential.json"}}"#
    ))
    .expect("R3 の設定");
    let mut rows = Vec::new();
    for p in positions() {
        let mut agent = svwb_engine::ai::search::SearchAgent::new(opts.clone());
        let mut s = p.state.clone();
        let player = acting_player(&s);
        let mulligan = s.phase == Phase::Mulligan;
        let mut actions = Vec::new();
        for k in 0..MAX_STEPS {
            if s.phase == Phase::Ended || acting_player(&s) != player {
                break;
            }
            let legal = legal_actions(&s);
            if legal.is_empty() {
                break;
            }
            let a = agent.choose_action(&s, &legal, &mut Rng::new(p.seed + k));
            s = apply_action(&s, &a);
            actions.push(action_to_json(&a));
            if mulligan
                || matches!(a, Action::EndTurn)
                || (s.phase != Phase::Ended && s.active != player)
            {
                break;
            }
        }
        let mut row = match p.from {
            Json::Obj(items) => items,
            _ => unreachable!(),
        };
        row.push(("seed".into(), Json::Num(p.seed as f64)));
        row.push(("actions".into(), Json::Arr(actions)));
        rows.push(Json::Obj(row));
    }
    let path = format!("{}/tests/fixtures/browser-r3.json", root());
    // 1 行に 1 局面
    let text = format!(
        "[\n{}\n]\n",
        rows.iter()
            .map(|r| r.stringify())
            .collect::<Vec<_>>()
            .join(",\n")
    );
    if std::env::var("SVWB_WRITE_FIXTURE").is_ok_and(|v| v == "1") {
        fs::create_dir_all(format!("{}/tests/fixtures", root())).expect("tests/fixtures");
        fs::write(&path, &text).expect("書き出し");
        return;
    }
    let saved = fs::read_to_string(&path).expect("tests/fixtures/browser-r3.json");
    let saved = Json::parse(&saved).expect("JSON");
    let Json::Arr(saved) = saved else {
        panic!("tests/fixtures/browser-r3.json は配列")
    };
    assert_eq!(saved.len(), rows.len(), "局面の数が違います");
    for (i, (s, r)) in saved.iter().zip(&rows).enumerate() {
        assert_eq!(
            s.get("actions").map(|a| a.stringify()),
            r.get("actions").map(|a| a.stringify()),
            "局面 {i}（{}）でコマンドの R3 の手が変わりました",
            r.get("problem")
                .map(|x| x.stringify())
                .unwrap_or_else(|| "マリガン".into())
        );
    }
}
