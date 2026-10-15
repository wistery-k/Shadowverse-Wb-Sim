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

/// 探索 AI どうしの試合 g の組み合わせとシード（scripts/rust-ai-diff-main.ts・bench-main.ts と同じ）
pub fn ai_game_setup(g: u32) -> ([Vec<CardIdx>; 2], u32) {
    let decks: Vec<&crate::data::Deck> = data()
        .decks
        .iter()
        .filter(|d| d.name != "ランプドラゴン")
        .collect();
    let i = (g % 7) as usize;
    let j = ((g * 3 + 1 + g / 7) % 7) as usize;
    ([decks[i].cards.clone(), decks[j].cards.clone()], g * 7 + 1)
}

/// 2 つの AI で試合 g を最後まで打つ（AI の乱数は playMatch と同じくシードから作る）。各手で visit を呼ぶ
pub fn play_ai(
    g: u32,
    agents: &mut [&mut dyn crate::ai::Agent; 2],
    mut visit: impl FnMut(&GameState, &Action),
) -> GameState {
    let (decks, seed) = ai_game_setup(g);
    let mut s = create_game([&decks[0], &decks[1]], seed);
    let mut rng = crate::ai::Rng::new(seed ^ 0x9e3779b9);
    let mut actions = 0;
    while s.phase != Phase::Ended {
        actions += 1;
        assert!(actions <= 10000, "アクション数が上限を超えました");
        let legal = legal_actions(&s);
        let actor = crate::game::acting_player(&s);
        let a = agents[actor].choose_action(&s, &legal, &mut rng);
        visit(&s, &a);
        s = apply_action(&s, &a);
    }
    s
}
