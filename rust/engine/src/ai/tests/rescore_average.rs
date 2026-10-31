//! 読み直しで引き直しごとの点数をまとめる方法（rescoreAverage）

use crate::ai::aidata::ai_data;
use crate::ai::search::{average_reads, RescoreAverage};

fn sigmoid(a: f64, x: f64) -> f64 {
    1.0 / (1.0 + (-a * x).exp())
}

#[test]
fn score_is_the_weighted_mean() {
    let xs = [(1.0, 10.0), (1.0, 30.0), (2.0, -5.0)];
    let want = (10.0 + 30.0 - 10.0) / 4.0 - 3.0;
    assert_eq!(average_reads(&xs, 3.0, RescoreAverage::Score), want);
    // 決着した引き直しが無ければ、DecidedWinProb は Score とビット単位で同じ
    assert_eq!(
        average_reads(&xs, 3.0, RescoreAverage::DecidedWinProb).to_bits(),
        want.to_bits()
    );
}

#[test]
fn win_prob_averages_probabilities() {
    let a = ai_data().value_net.a;
    let xs = [(1.0, 100.0), (3.0, -50.0)];
    let v = average_reads(&xs, 20.0, RescoreAverage::WinProb);
    let p = (sigmoid(a, 80.0) + 3.0 * sigmoid(a, -70.0)) / 4.0;
    assert!((sigmoid(a, v) - p).abs() < 1e-12, "{v}");
    // 同じ点数だけなら、その点数（から offset を引いたもの）のまま
    let same = average_reads(&[(1.0, 42.0), (2.0, 42.0)], 2.0, RescoreAverage::WinProb);
    assert!((same - 40.0).abs() < 1e-9, "{same}");
}

#[test]
fn opponent_lethal_counts_as_one_lost_draw() {
    // 12 通りのうち 1 通りで相手のリーサルを受ける終局面と、リーサルは無いがどの引き直しも 200 点低い終局面
    let mut risky = vec![(1.0, 300.0); 11];
    risky.push((1.0, -1e6));
    let safe = vec![(1.0, 100.0); 12];
    let score = |xs: &[(f64, f64)]| average_reads(xs, 0.0, RescoreAverage::Score);
    let prob = |xs: &[(f64, f64)]| average_reads(xs, 0.0, RescoreAverage::WinProb);
    let decided = |xs: &[(f64, f64)]| average_reads(xs, 0.0, RescoreAverage::DecidedWinProb);
    // 点数のまま平均すると、リーサルの 1 通りで大きく負ける
    assert!(score(&risky) < -8e4 && score(&risky) < score(&safe));
    // 勝率にすると 11/12 × σ(a·300) で、どの引き直しも 100 点の終局面と比べられる
    let a = ai_data().value_net.a;
    let p = 11.0 / 12.0 * sigmoid(a, 300.0);
    assert!((sigmoid(a, prob(&risky)) - p).abs() < 1e-12);
    assert_eq!(prob(&risky) > prob(&safe), p > sigmoid(a, 100.0));
    // DecidedWinProb は、決着した引き直しのある終局面だけ勝率で、ほかは点数のまま
    assert_eq!(decided(&risky).to_bits(), prob(&risky).to_bits());
    assert_eq!(decided(&safe).to_bits(), score(&safe).to_bits());
}

#[test]
fn all_lost_or_all_won_keep_the_decided_scores() {
    let lost = vec![(1.0, -1e6); 12];
    let won = vec![(1.0, 1e6); 3];
    for how in [RescoreAverage::WinProb, RescoreAverage::DecidedWinProb] {
        assert_eq!(average_reads(&lost, 0.0, how), -1e6);
        assert_eq!(average_reads(&won, 0.0, how), 1e6);
    }
}

mod search {
    use super::super::*;
    use crate::ai::search::{RescoreAverage, SearchAgent, SearchOptions};

    /// 貪欲法どうしの試合の、自分のターンの最初の局面（手を選べるもの。中盤以降）
    fn positions() -> Vec<GameState> {
        let mut out = Vec::new();
        for (k, seed) in [5u32, 13].into_iter().enumerate() {
            let mut s = new_game(deck_at(k + 1), deck_at(k + 4), seed);
            let mut greedy = greedy_base();
            let mut rng = Rng::new(seed);
            let mut last_turn = -1;
            while s.phase != Phase::Ended && s.turn <= 16 {
                let legal = legal_actions(&s);
                if s.turn != last_turn
                    && s.pending.is_none()
                    && legal.len() > 1
                    && s.turn >= 6
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

    #[test]
    fn decided_win_prob_keeps_undecided_values() {
        // 決着した引き直しの無い終局面の点数は、DecidedWinProb でも Score と同じ（同じ乱数で）
        let mut same = 0;
        for (k, s) in positions().iter().enumerate() {
            let p = acting_player(s);
            let run = |how: RescoreAverage| -> Vec<(Action, f64)> {
                fresh();
                let o = SearchOptions {
                    beam_width: 32,
                    max_depth: 8,
                    rescore_average: how,
                    ..SearchOptions::default()
                };
                SearchAgent::new(o)
                    .ranked_plans(s, p, &mut Rng::new(k as u32 * 11 + 3))
                    .into_iter()
                    .map(|x| (x.action, x.value))
                    .collect()
            };
            let score = run(RescoreAverage::Score);
            let decided = run(RescoreAverage::DecidedWinProb);
            let prob = run(RescoreAverage::WinProb);
            assert!(!decided.is_empty() && !prob.is_empty());
            for (a, v) in &score {
                if v.abs() < 1e4 {
                    if let Some((_, w)) = decided.iter().find(|(b, _)| b == a) {
                        assert_eq!(v.to_bits(), w.to_bits(), "{a:?}");
                        same += 1;
                    }
                }
            }
        }
        assert!(same > 0);
    }
}
