//! 選択できる AI の一覧（src/ai/registry.ts と同じ名前）。ブラウザ（WASM）と CLI で共通に使う。

use super::aidata::ai_data;
use super::eval::EvalWeights;
use super::greedy::{GreedyAgent, TunedGreedyAgent};
use super::rhino::RhinoAgent;
use super::search::{SearchAgent, SearchOptions};
use super::{Agent, RandomAgent};

/// AI の名前と表示名（画面の選択肢の順）
pub const AGENTS: [(&str, &str); 8] = [
    ("search", "探索"),
    ("search-classic", "探索（学習した補正なし）"),
    ("yardstick", "物差し（凍結した探索）"),
    ("rhino", "探索＋リノセウス用の評価・リーサル"),
    ("rhino-lethal", "探索＋リノセウス用リーサル"),
    ("greedy", "貪欲法"),
    ("greedy-base", "貪欲法（基準の重み）"),
    ("random", "ランダム"),
];

/// 学習した評価の補正と相手のターンのビームサーチ、相手の手札を引き直す読み直しを入れる前の探索 AI（人間との比較の相手）
pub fn search_classic_options() -> SearchOptions {
    SearchOptions {
        extra_eval: None,
        opponent_search: None,
        // 人間との比較・rhino-compare の相手が変わらないよう、リーサル探索は前のまま
        lethal_ward_blocked: 0.0,
        lethal_expand_choices: false,
        lethal_exact_states: 0,
        ..SearchOptions::default()
    }
    .with_classic_sampling()
}

/// 名前から AI を作る（知らない名前なら None）
pub fn create_agent(name: &str) -> Option<Box<dyn Agent>> {
    Some(match name {
        "search" => Box::new(SearchAgent::new(SearchOptions::default())),
        "search-classic" => Box::new(SearchAgent::new(search_classic_options())),
        // 強さの物差しの相手（runner/yardstick.rs）。既定や重みを変えても動かない。人間との比較の相手にも使う
        "yardstick" => Box::new(SearchAgent::new(
            crate::runner::yardstick::reference_options(),
        )),
        "rhino" => Box::new(RhinoAgent::new(true)),
        "rhino-lethal" => Box::new(RhinoAgent::new(false)),
        "greedy" => Box::new(TunedGreedyAgent::default()),
        "greedy-base" => Box::new(GreedyAgent {
            omniscient: false,
            weights: EvalWeights::new(ai_data().default_weights.clone()),
            fuse_follow_up: false,
        }),
        "random" => Box::new(RandomAgent),
        _ => return None,
    })
}
