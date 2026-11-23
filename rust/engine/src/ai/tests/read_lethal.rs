//! 補正のリーサルの出力が線以上の終局面だけ、読みの中の相手にリーサル探索を先にさせる（readLethal）

use super::pool::pool_deck;
use super::*;
use crate::ai::exact_lethal::with_fresh_exact_cache;
use crate::ai::search::{take_read_lethal_stats, SearchAgent, SearchOptions, DANGER};
use crate::game::try_apply_action;
use crate::runner::options::compare_options;

/// 新しいプールの R6 の補正（リーサルの出力がある）で、ビームを小さくした設定。read_lethal は呼び出し側で足す
fn r6(extra: &str) -> SearchOptions {
    let path = format!("{}/yardstick/pool-r6-net.json", env!("CARGO_MANIFEST_DIR"));
    let o = compare_options(&format!(r#"{{"valueNet":"{path}"{extra}}}"#)).expect("設定");
    SearchOptions {
        beam_width: 32,
        max_depth: 8,
        ..o
    }
}

fn decks() -> [Vec<CardIdx>; 2] {
    [
        pool_deck(include_str!(
            "../../../../../data/pools/azvaldt/decks/ps26-27-08b/VL_ナイトメア.txt"
        )),
        pool_deck(include_str!(
            "../../../../../data/pools/azvaldt/decks/ps26-27-08b/CR_ウィッチ.txt"
        )),
    ]
}

/// 貪欲法どうしの試合の、ターン終了を打つ直前の局面（turn 以上）と、自分のターンの最初の局面（手を選べるもの）
fn positions(min_turn: i32) -> (Vec<GameState>, Vec<GameState>) {
    let [x, y] = decks();
    let mut ends = Vec::new();
    let mut starts = Vec::new();
    for seed in [5u32, 6] {
        let mut s = new_game(&x, &y, seed);
        let mut greedy = greedy_base();
        let mut rng = Rng::new(seed);
        let mut last_turn = -1;
        while s.phase != Phase::Ended {
            let legal = legal_actions(&s);
            if s.turn != last_turn
                && s.pending.is_none()
                && legal.len() > 1
                && s.turn >= min_turn
                && !matches!(legal[0], Action::Mulligan { .. })
            {
                starts.push(s.clone());
                last_turn = s.turn;
            }
            let a = greedy.choose_action(&s, &legal, &mut rng);
            if matches!(a, Action::EndTurn) && s.pending.is_none() && s.turn >= min_turn {
                ends.push(s.clone());
            }
            s = apply(&s, &a);
        }
    }
    (ends, starts)
}

#[test]
fn read_lethal_above_one_keeps_plans() {
    // 線が 1 より大きければ、どの終局面にもリーサル探索をさせないので、読み直した手と点数は readLethal なしと同じ。q の分かれ方だけを数える
    let plain = SearchAgent::new(r6(""));
    let counted = SearchAgent::new(r6(r#","readLethal":2"#));
    let (_, starts) = positions(4);
    assert!(starts.len() >= 6);
    let _ = take_read_lethal_stats();
    for (k, s) in starts.iter().take(6).enumerate() {
        let p = acting_player(s);
        let run = |a: &SearchAgent| -> Vec<(Action, f64)> {
            fresh();
            a.ranked_plans(s, p, &mut Rng::new(k as u32 * 11 + 3))
                .into_iter()
                .map(|x| (x.action, x.value))
                .collect()
        };
        assert_eq!(run(&plain), run(&counted), "局面 {k}");
    }
    let st = take_read_lethal_stats();
    assert!(st.starts.iter().sum::<u64>() > 0);
    assert!(st.reads.iter().sum::<u64>() > 0);
    assert_eq!(st.searched.iter().sum::<u64>(), 0);
}

#[test]
fn read_lethal_matches_kifu_opp_lethal() {
    // 線 0（全部の終局面）なら、引き直しごとに、読みと同じ決定化の局面でターンを終えて相手の番でリーサル探索が見つけたもの
    // （svwb kifu values --opp-lethal 1 の印と同じ）は負けの点数になり、見つけなかったものは readLethal なしと同じ点数
    let plain = SearchAgent::new(r6(""));
    let gated = SearchAgent::new(r6(r#","readLethal":0"#));
    let (ends, _) = positions(6);
    assert!(!ends.is_empty());
    let seeds: Vec<u32> = (0..4).map(|k| 1000 + k).collect();
    let (mut found_n, mut missed_n) = (0, 0);
    let _ = take_read_lethal_stats();
    for (k, end) in ends.iter().enumerate() {
        let p = end.active;
        let q = 1 - p;
        fresh();
        let a = plain.read_values(end, p, &seeds);
        fresh();
        let b = gated.read_values(end, p, &seeds);
        for (j, &seed) in seeds.iter().enumerate() {
            let view = gated.read_view(end, p, seed);
            let found = match try_apply_action(&view, &Action::EndTurn) {
                Some(after) if after.phase != Phase::Ended && after.active == q => {
                    with_fresh_exact_cache(|| gated.finds_lethal(&after, q))
                }
                _ => false,
            };
            if found {
                found_n += 1;
                assert!(b[j] <= DANGER, "局面 {k}・引き直し {j}: {}", b[j]);
            } else {
                missed_n += 1;
                assert_eq!(a[j], b[j], "局面 {k}・引き直し {j}");
            }
        }
    }
    assert!(
        found_n > 0 && missed_n > 0,
        "見つけた {found_n}・見つけない {missed_n}"
    );
    let st = take_read_lethal_stats();
    assert_eq!(st.found.iter().sum::<u64>(), found_n);
    assert_eq!(st.replay_failed, 0);
}

#[test]
fn read_lethal_option_needs_lethal_head() {
    // スターターの既定の補正にはリーサルの出力が無い
    assert!(compare_options(r#"{"readLethal":0.1}"#).is_err());
    assert!(compare_options(r#"{"readLethal":-1}"#).is_err());
    assert!(compare_options(r#"{"readLethal":null}"#)
        .expect("設定")
        .read_lethal
        .is_none());
    let o = r6(r#","readLethal":0.2"#);
    assert_eq!(o.read_lethal.expect("readLethal").threshold, 0.2);
}
