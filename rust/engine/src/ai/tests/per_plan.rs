//! 手の組ごとにビームの枠を設ける（SearchOptions.perPlan。2026-10-26、ユーザーの見立て「攻撃先・攻撃順・融合の組み合わせが枠を埋める」から）

use super::*;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::sim::play_match;

/// 手の組ごとの枠を使っても、合法手だけで試合を最後まで打てる（play_match が合法手か確かめる）
#[test]
fn per_plan_plays_full_games() {
    let small = SearchOptions {
        beam_width: 16,
        rescore_top: 2,
        opp_hand_samples: 2,
        ..SearchOptions::default()
    };
    for (seed, per_plan) in [(11u32, 1usize), (12, 2)] {
        let mut capped = SearchAgent::new(SearchOptions {
            per_plan,
            ..small.clone()
        });
        let mut plain = SearchAgent::new(small.clone());
        let mut plays = 0;
        let end = play_match(
            &mut [&mut capped, &mut plain],
            [deck_at(1), deck_at(2)],
            seed,
            |s, a| {
                if s.active == 0 && matches!(a, Action::Play(_)) {
                    plays += 1;
                }
            },
        );
        assert_eq!(end.phase, Phase::Ended, "シード {seed}");
        assert!(
            plays > 0,
            "シード {seed}: 枠を設けた側が一度もカードを出さない"
        );
    }
}

/// 幅が十分なら、枠を設けても候補（最初の手ごとの最善のターン末）の点数は変わらない（枠は捨てる局面を選ぶときだけ効く）
#[test]
fn per_plan_is_inert_when_the_beam_is_wide() {
    let wide = SearchOptions {
        beam_width: 100_000,
        max_depth: 3,
        ..SearchOptions::default()
    };
    let capped = SearchAgent::new(SearchOptions {
        per_plan: 1,
        ..wide.clone()
    });
    let plain = SearchAgent::new(wide);
    let mut s = crate::game::create_game([deck_at(1), deck_at(2)], 5);
    let mut rng = crate::ai::Rng::new(3);
    // 数ターン進めて、場と手札のある局面にする
    let mut a0 = SearchAgent::new(SearchOptions {
        beam_width: 8,
        rescore_top: 1,
        opp_hand_samples: 1,
        ..SearchOptions::default()
    });
    while s.phase != Phase::Ended && s.turn < 8 {
        let legal = crate::game::legal_actions(&s);
        let a = crate::ai::Agent::choose_action(&mut a0, &s, &legal, &mut rng);
        s = crate::game::apply_legal(&s, &a);
    }
    assert_ne!(s.phase, Phase::Ended);
    let p = s.active;
    let best = |ag: &SearchAgent| {
        ag.turn_end_candidates(&s, p)
            .iter()
            .map(|x| x.1)
            .fold(f64::NEG_INFINITY, f64::max)
    };
    assert_eq!(best(&capped), best(&plain));
}
