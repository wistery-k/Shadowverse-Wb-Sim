//! damage_bound（リーサルの全探索の打ち切りに使う上限）が、全探索の最大ダメージを下回らないこと

use super::*;
use crate::ai::damage_bound::damage_bound;
use crate::ai::exact_lethal::{exact_max_damage, ExactLethalOptions, DEFAULT_EXACT_LETHAL_OPTIONS};
use crate::ai::registry::create_agent;

/// 少しランダムに打つ greedy どうしの試合の途中のすべての局面で、上限が全探索の最大ダメージ以上か
fn check_games(d0: usize, d1: usize, seed: u32) -> usize {
    let d = &data().decks;
    let mut s = create_game([&d[d0].cards, &d[d1].cards], seed);
    let mut agents = [
        create_agent("greedy").unwrap(),
        create_agent("greedy").unwrap(),
    ];
    let mut rng = Rng::new(seed ^ 0x51ed);
    let mut checked = 0;
    let mut steps = 0;
    while s.phase != Phase::Ended && steps < 2000 {
        steps += 1;
        if s.turn > 0 && s.pending.is_none() && s.stack.is_empty() && s.queue.is_empty() {
            let p = s.active;
            for det in [false, true] {
                let o = ExactLethalOptions {
                    deterministic_only: det,
                    max_states: 1000,
                    damage_bound: false,
                    ..DEFAULT_EXACT_LETHAL_OPTIONS
                };
                let (Some(exact), Some(bound)) =
                    (exact_max_damage(&s, p, &o), damage_bound(&s, p, !det))
                else {
                    continue;
                };
                assert!(
                    exact <= bound,
                    "{} vs {} T{} 席{p} det={det}: 全探索 {exact} 上限 {bound}",
                    d[d0].name,
                    d[d1].name,
                    s.turn
                );
                checked += 1;
            }
        }
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        let a = if rng.int(5) == 0 {
            legal[rng.int(legal.len())].clone()
        } else {
            agents[actor].choose_action(&s, &legal, &mut rng)
        };
        s = apply_action(&s, &a);
    }
    checked
}

#[test]
fn damage_bound_is_not_below_exact_damage() {
    fresh();
    let n = data().decks.len();
    let mut checked = 0;
    for i in 0..n {
        checked += check_games(i, (i + 1) % n, 100 + i as u32);
    }
    assert!(checked > 100, "調べた局面 {checked}");
}
