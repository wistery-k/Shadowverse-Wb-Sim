//! 見込みのない終局面の読みを途中で打ち切る（rescoreRace）

use super::*;
use crate::ai::search::{RescoreRace, SearchAgent, SearchOptions};

/// 貪欲法どうしの試合の、自分のターンの最初の局面（手を選べるもの）
fn positions() -> Vec<GameState> {
    let mut out = Vec::new();
    for (k, seed) in [3u32, 8, 21].into_iter().enumerate() {
        let mut s = new_game(deck_at(k), deck_at(k + 2), seed);
        let mut greedy = greedy_base();
        let mut rng = Rng::new(seed);
        let mut last_turn = -1;
        while s.phase != Phase::Ended && s.turn <= 14 {
            let legal = legal_actions(&s);
            if s.turn != last_turn
                && s.pending.is_none()
                && legal.len() > 1
                && s.turn >= 3
                && !matches!(legal[0], Action::Mulligan { .. })
            {
                out.push(s.clone());
                last_turn = s.turn;
            }
            let a = greedy.choose_action(&s, &legal, &mut rng);
            s = apply(&s, &a);
        }
    }
    out
}

fn small(race: Option<RescoreRace>) -> SearchOptions {
    SearchOptions {
        beam_width: 32,
        max_depth: 8,
        rescore_race: race,
        ..SearchOptions::default()
    }
}

/// 読み直した手と点数
type Values = Vec<(Action, f64)>;

/// 局面ごとに、全部読んだときと打ち切ったときの、読み直した手と点数（同じ乱数で）
fn both(race: RescoreRace) -> Vec<(Values, Values)> {
    positions()
        .iter()
        .enumerate()
        .map(|(k, s)| {
            let p = acting_player(s);
            let run = |o: SearchOptions| -> Values {
                fresh();
                SearchAgent::new(o)
                    .ranked_plans(s, p, &mut Rng::new(k as u32 * 7 + 1))
                    .into_iter()
                    .map(|x| (x.action, x.value))
                    .collect()
            };
            (run(small(None)), run(small(Some(race))))
        })
        .collect()
}

#[test]
fn race_keeps_values_of_the_rest() {
    // 打ち切っても、残った終局面の点数は全部読んだときと同じ（先に読んだ分を使い回す）。落とすのは読み直した手の一部
    let race = RescoreRace {
        first: 4,
        step: 4,
        z: 0.0,
        delta: 0.0,
        reentry: None,
    };
    let mut dropped = 0;
    for (full, raced) in both(race) {
        assert!(!raced.is_empty());
        for (a, v) in &raced {
            let w = full
                .iter()
                .find(|(b, _)| b == a)
                .map(|(_, w)| *w)
                .expect("全部読んだときにもある手");
            assert_eq!(*v, w);
        }
        dropped += full.len() - raced.len();
    }
    assert!(dropped > 0);
}

#[test]
fn race_with_huge_margin_changes_nothing() {
    // 差の許しを大きくすれば何も落とさず、読み直した手も点数も全部読んだときと同じ
    let race = RescoreRace {
        first: 2,
        step: 3,
        z: 0.0,
        delta: 1e12,
        reentry: Some(0.0),
    };
    for (full, raced) in both(race) {
        assert_eq!(full, raced);
    }
}
