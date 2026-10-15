//! ゴールデンテスト・計測用の対戦（ランダムな手で打つ試合と、AI どうしの試合）。

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

/// 探索 AI どうしの試合 g の組み合わせとシード
pub fn ai_game_setup(g: u32, elf: bool) -> ([Vec<CardIdx>; 2], u32) {
    let decks: Vec<&crate::data::Deck> = data()
        .decks
        .iter()
        .filter(|d| d.name != "ランプドラゴン")
        .collect();
    let seed = g * 7 + 1;
    if elf {
        // 試合ごとに席を入れ替えてリノセウスエルフと、それ以外のデッキ（2 試合ごとに次のデッキ）を当てる
        let others: Vec<&crate::data::Deck> = decks
            .iter()
            .copied()
            .filter(|d| d.name != "リノセウスエルフ")
            .collect();
        let elf_cards = decks
            .iter()
            .find(|d| d.name == "リノセウスエルフ")
            .expect("リノセウスエルフのデッキ")
            .cards
            .clone();
        let other = others[(g / 2) as usize % others.len()].cards.clone();
        return if g.is_multiple_of(2) {
            ([elf_cards, other], seed)
        } else {
            ([other, elf_cards], seed)
        };
    }
    let i = (g % 7) as usize;
    let j = ((g * 3 + 1 + g / 7) % 7) as usize;
    ([decks[i].cards.clone(), decks[j].cards.clone()], seed)
}

/// 2 つの AI で試合 g を最後まで打つ（AI の乱数は playMatch と同じくシードから作る）。各手で visit を呼ぶ
pub fn play_ai(
    g: u32,
    elf: bool,
    agents: &mut [&mut dyn crate::ai::Agent; 2],
    visit: impl FnMut(&GameState, &Action),
) -> GameState {
    let (decks, seed) = ai_game_setup(g, elf);
    play_match(agents, [&decks[0], &decks[1]], seed, visit)
}

/// 2 つの AI で 1 試合を最後まで打つ（TypeScript 版 src/sim/match.ts の playMatch。AI の乱数は seed から作る）。
/// 各手で、打つ前の局面と選んだ手で visit を呼ぶ（勝者がいない終わり方は呼び出し側で確かめる）
pub fn play_match(
    agents: &mut [&mut dyn crate::ai::Agent; 2],
    decks: [&[CardIdx]; 2],
    seed: u32,
    mut visit: impl FnMut(&GameState, &Action),
) -> GameState {
    let mut s = create_game(decks, seed);
    let mut rng = crate::ai::Rng::new(seed ^ 0x9e3779b9);
    let mut actions = 0;
    while s.phase != Phase::Ended {
        actions += 1;
        assert!(
            actions <= 10000,
            "アクション数が上限 10000 を超えました（シード {seed}）"
        );
        let legal = legal_actions(&s);
        let actor = crate::game::acting_player(&s);
        let a = agents[actor].choose_action(&s, &legal, &mut rng);
        visit(&s, &a);
        s = apply_action(&s, &a);
    }
    s
}
