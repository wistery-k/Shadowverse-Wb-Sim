//! 差分テスト・計測用のランダムな対戦（scripts/rust-diff-main.ts と同じ組み方・同じ手の選び方）。

use crate::data::{data, CardIdx, ClassId};
use crate::game::{apply_action, create_game, legal_actions};
use crate::state::*;

pub const MAX_STEPS: usize = 5000;

const CLASSES: [ClassId; 7] = [
    ClassId::Elf,
    ClassId::Royal,
    ClassId::Witch,
    ClassId::Dragon,
    ClassId::Nightmare,
    ClassId::Bishop,
    ClassId::Nemesis,
];

/// ランダムなデッキ（クラスとニュートラルのトークン以外のカードから 40 枚）
fn random_deck(g: u32, i: u32) -> Vec<CardIdx> {
    let cls = CLASSES[((g + i * 3) % 7) as usize];
    let pool: Vec<CardIdx> = data()
        .cards
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.token && (c.class == cls || c.class == ClassId::Neutral))
        .map(|(i, _)| i as CardIdx)
        .collect();
    let mut pick = Chooser::new((g * 2 + i + 1).wrapping_mul(40503));
    (0..40).map(|_| pool[pick.pick(pool.len())]).collect()
}

/// 試合 g の組み合わせとシード（random_decks ならランダムなデッキ）
pub fn game_setup(g: u32, random_decks: bool) -> ([Vec<CardIdx>; 2], u32) {
    let seed = (g + 1).wrapping_mul(2654435761);
    if random_decks {
        return ([random_deck(g, 0), random_deck(g, 1)], seed);
    }
    let decks = &data().decks;
    let n = decks.len() as u32;
    let d0 = decks[(g % n) as usize].cards.clone();
    let d1 = decks[((g / n) % n) as usize].cards.clone();
    ([d0, d1], seed)
}

/// 行動の選び方（LCG）
pub struct Chooser(u32);

impl Chooser {
    pub fn new(seed: u32) -> Chooser {
        Chooser(seed ^ 0x9e3779b9)
    }
    pub fn pick(&mut self, len: usize) -> usize {
        self.0 = self.0.wrapping_mul(1103515245).wrapping_add(12345);
        (self.0 >> 8) as usize % len
    }
}

/// 試合 g をランダムな手で打ち、各手番で visit を呼ぶ（最後は決着した局面で legal が空）
pub fn play_random(
    g: u32,
    random_decks: bool,
    mut visit: impl FnMut(usize, &GameState, &[Action]),
) -> GameState {
    let (decks, seed) = game_setup(g, random_decks);
    let mut pick = Chooser::new(seed);
    let mut s = create_game([&decks[0], &decks[1]], seed);
    let mut step = 0;
    loop {
        let legal = if s.phase == Phase::Ended || step >= MAX_STEPS {
            Vec::new()
        } else {
            legal_actions(&s)
        };
        visit(step, &s, &legal);
        if legal.is_empty() {
            return s;
        }
        let a = &legal[pick.pick(legal.len())];
        s = apply_action(&s, a);
        step += 1;
    }
}
