//! 攻撃を後にまとめるビーム（SearchOptions.attackLater。2026-10-26、ユーザーの提案から）

use super::*;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::sim::play_match;

/// 攻撃を後にまとめるビームを足しても、合法手だけで試合を最後まで打てる（play_match が合法手か確かめる）。
/// 攻撃を後にまとめる側は、試合のどこかで攻撃を手順の最後にまとめて打つ（攻撃の後に攻撃以外の手を打たないターンがある）
#[test]
fn attack_later_plays_full_games() {
    let small = SearchOptions {
        beam_width: 16,
        rescore_top: 2,
        opp_hand_samples: 2,
        ..SearchOptions::default()
    };
    for seed in [11u32, 12] {
        let mut later = SearchAgent::new(SearchOptions {
            attack_later: 16,
            ..small.clone()
        });
        let mut plain = SearchAgent::new(small.clone());
        let mut attacks = 0;
        let end = play_match(
            &mut [&mut later, &mut plain],
            [deck_at(1), deck_at(2)],
            seed,
            |s, a| {
                if s.active == 0 && matches!(a, Action::Attack { .. }) {
                    attacks += 1;
                }
            },
        );
        assert_eq!(end.phase, Phase::Ended, "シード {seed}");
        assert!(
            attacks > 0,
            "シード {seed}: 攻撃を後にまとめる側が一度も攻撃しない"
        );
    }
}
