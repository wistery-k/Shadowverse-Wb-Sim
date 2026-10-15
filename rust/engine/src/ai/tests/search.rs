//! 探索 AI（tests/ai.test.ts の「探索 AI」「turn1ExtraPp」）

use super::*;
use crate::ai::search::{simulate_opponent_turn, SearchAgent, SearchOptions};
use crate::sim::play_match;

#[test]
fn finishes_games_with_opp_hand_samples_and_peek() {
    // 相手の手札を引き直して読む設定（oppHandSamples）と、実験用の相手の手札を見る設定（peekOppHand）でも最後まで打てる
    let mut search = SearchAgent::new(SearchOptions {
        opp_hand_samples: 2,
        peek_opp_hand: true,
        ..SearchOptions::default()
    });
    let mut greedy = greedy_base();
    fresh();
    let end = play_match(
        &mut [&mut search, &mut greedy],
        [deck_at(3), deck_at(1)],
        6,
        |_, _| {},
    );
    assert!(end.winner.is_some());
}

#[test]
fn reads_opponent_turn_from_pending_choice() {
    // 能力の選択待ちの途中の局面からも、選択を済ませて相手のターンまで読む
    let policy = default_weights();
    let mut found = false;
    for seed in 1..=20u32 {
        let mut state = new_game(deck_at(0), deck_at(1), seed);
        let mut rng = Rng::new(seed);
        let mut greedy = greedy_base();
        while state.phase != Phase::Ended {
            let p = state.active;
            if state.phase == Phase::Main && state.pending.as_ref().map(|x| x.player()) == Some(p) {
                let after = simulate_opponent_turn(&state, p, &mut Rng::new(seed), &policy, false);
                if after.phase != Phase::Ended {
                    assert!(after.pending.is_none());
                    assert_eq!(after.active, p);
                    assert_eq!(after.turn, state.turn + 2);
                }
                found = true;
                break;
            }
            let a = greedy.choose_action(&state, &legal_actions(&state), &mut rng);
            state = apply(&state, &a);
        }
        if found {
            break;
        }
    }
    assert!(found);
}

/// ロイヤルの 8 ターン目（PP 8・SEP 2）。相手は体力 20 で場に opp を置く
fn geno_turn(geno_in_hand: bool, opp: &[&str]) -> GameState {
    let s = new_game(deck("アマリアロイヤル"), deck("ランプドラゴン"), 1);
    let mut s = keep_hands(s);
    while !(s.active == 0 && s.players[0].turn_count >= 8) {
        s = apply(&s, &Action::EndTurn);
    }
    s.players[0].board.clear();
    s.players[1].board.clear();
    s.players[0].hand.clear();
    if geno_in_hand {
        let h = hand_card(&mut s, "レヴィオンアックス・ジェノ");
        s.players[0].hand.push(h);
    } else {
        let f = old_follower(&mut s, "レヴィオンアックス・ジェノ");
        s.players[0].board.push(f);
    }
    for name in opp {
        let f = old_follower(&mut s, name);
        s.players[1].board.push(f);
    }
    s
}

/// 探索 AI でターンの終わりまで打ち、打った手を返す。
/// SEP の重みの効き目を見るので、相手のターンは貪欲法で読む
/// （相手のターンをビームサーチで読むと、乱数によっては超進化しない。12 通り中 4 回）
fn sep_turn(s: GameState) -> Vec<Action> {
    let mut agent = SearchAgent::new(SearchOptions {
        opponent_search: None,
        ..SearchOptions::default()
    });
    let (moves, _) = play_turn(s, 0, &mut agent, &mut Rng::new(7));
    moves_of(&moves)
}

#[test]
fn geno_does_not_super_evolve_when_not_needed() {
    // ジェノ（7/6、2 回攻撃）で激震のゴリアテ（4/5）と異端の侍を倒せる
    let actions = sep_turn(geno_turn(true, &["激震のゴリアテ", "異端の侍"]));
    let attacks = actions
        .iter()
        .filter(|a| matches!(a, Action::Attack { .. }))
        .count();
    assert_eq!(attacks, 2, "{actions:?}");
    assert!(!actions.iter().any(|a| matches!(a, Action::SuperEvolve(_))));
}

#[test]
fn geno_super_evolves_to_kill_big_follower() {
    // 守護の激震のゴリアテを倒した後、キャラバンマンモス（10/10）は超進化した 10 点でないと倒せない
    let actions = sep_turn(geno_turn(false, &["激震のゴリアテ", "キャラバンマンモス"]));
    assert!(
        actions.iter().any(|a| matches!(a, Action::SuperEvolve(_))),
        "{actions:?}"
    );
}

#[test]
fn uses_extra_pp_on_turn_1() {
    // 後攻の 1 ターン目でも、2 コストが手札にあればエクストラPP を使う（turn1ExtraPp の既定 always）
    let mut s = new_game(deck_at(0), deck_at(1), 5);
    while s.phase == Phase::Mulligan {
        let a = legal_actions(&s)
            .into_iter()
            .find(|a| matches!(a, Action::Mulligan { swap, .. } if swap.is_empty()))
            .expect("入れ替えないマリガン");
        s = apply(&s, &a);
    }
    s = apply(&s, &Action::EndTurn);
    let p = s.active;
    assert_eq!(s.players[p].turn_count, 1);
    assert!(s.players[p].extra_pp_available);
    let h = hand_card(&mut s, "竜育の少女");
    s.players[p].hand.push(h);
    let mut agent = SearchAgent::new(SearchOptions::default());
    let a = agent.choose_action(&s, &legal_actions(&s), &mut Rng::new(1));
    assert_eq!(a, Action::ExtraPp);
}
