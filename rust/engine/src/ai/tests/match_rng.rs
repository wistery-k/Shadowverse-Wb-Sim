//! AI の思考用の乱数を用途から作る（ai/mod.rs の seed_of・with_purpose_rng、sim.rs の MatchRng）

use super::*;
use crate::ai::registry::create_agent;
use crate::ai::{seed_of, Agent, Rng};
use crate::sim::play_match;

#[test]
fn seed_of_is_fixed() {
    // src/engine/rng.ts の seedOf と同じ値（tests/engine.test.ts でも同じ値を確かめる）。変えると AI の手が変わる
    assert_eq!(seed_of(&[]), SEED_OF_EMPTY);
    assert_eq!(seed_of(&[1, 2, 3]), SEED_OF_123);
    // 負のターン等は u32 にしたもの（TypeScript 版は >>> 0）
    assert_eq!(seed_of(&[1, -1i32 as u32, 0, 7, 2]), 1_785_051_801);
    assert_ne!(seed_of(&[1, 2, 3]), seed_of(&[1, 3, 2]));
    assert_ne!(seed_of(&[1, 2]), seed_of(&[1, 2, 0]));
}

const SEED_OF_EMPTY: u32 = 1_947_474_976;
const SEED_OF_123: u32 = 756_444_049;

/// 渡された乱数から 1 つ取って手を選び、さらに extra 個取る AI。受け取った乱数の状態を残す
struct Recorder {
    extra: usize,
    sequential: bool,
    seen: Vec<u32>,
}

impl Recorder {
    fn new(extra: usize, sequential: bool) -> Recorder {
        Recorder {
            extra,
            sequential,
            seen: Vec::new(),
        }
    }
}

impl Agent for Recorder {
    fn choose_action(&mut self, _s: &GameState, legal: &[Action], rng: &mut Rng) -> Action {
        self.seen.push(rng.state);
        let a = legal[rng.int(legal.len())].clone();
        for _ in 0..self.extra {
            rng.int(2);
        }
        a
    }
    fn sequential_rng(&self) -> bool {
        self.sequential
    }
}

/// 席 1 の AI が判断ごとに extra 個多く乱数を使ったときの、席 0 の AI が受け取った乱数の状態の列と勝者
fn seat0_view(extra: usize, sequential: bool) -> (Vec<u32>, Option<PlayerIndex>) {
    let mut a = Recorder::new(0, sequential);
    let mut b = Recorder::new(extra, sequential);
    let end = play_match(
        &mut [&mut a, &mut b],
        [deck_at(0), deck_at(1)],
        3,
        |_, _| {},
    );
    (a.seen, end.winner)
}

#[test]
fn other_seat_using_more_random_numbers_does_not_change_mine() {
    // 判断ごとに作るので、相手の席が乱数を使う数を変えても、自分の席の乱数は変わらない（試合の展開も同じ）
    let base = seat0_view(0, false);
    assert!(base.0.len() > 10);
    assert_eq!(seat0_view(3, false), base);
    // 古い取り方（1 試合に 1 本を両方の席が順に使う）では変わる
    let old = seat0_view(0, true);
    assert_ne!(seat0_view(3, true).0, old.0);
}

#[test]
fn decisions_get_different_random_numbers() {
    // 同じ席でも判断ごとに別の乱数（同じ状態から始まる判断が並ばない）
    let (seen, _) = seat0_view(0, false);
    let mut sorted = seen.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), seen.len());
}

#[test]
fn only_yardstick_references_use_the_old_way() {
    // 物差しの相手だけが古い取り方（相手の手を変えないため。runner/yardstick.rs の指紋）
    for (name, _) in crate::ai::registry::AGENTS {
        let agent = create_agent(name).expect("AI");
        assert_eq!(agent.sequential_rng(), name == "yardstick", "{name}");
    }
    assert!(crate::runner::yardstick::strong_reference_options().sequential_rng);
}
