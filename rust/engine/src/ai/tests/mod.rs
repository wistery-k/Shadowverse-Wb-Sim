//! AI の単体テスト（TypeScript 版の tests/ai.test.ts・rhino.test.ts 等を移したもの）。
//! 局面は TypeScript 版のテストと同じ作り方（同じデッキ・シード・カード）で作り、同じ乱数のシードで AI に打たせる。
//! 探索を含むので `cargo test --release` で走らせる。
//!
//! 実験用の設定（reanimateGuard・turn1ExtraPp の never/keepTurn2・マリガンの evoBonus 等）は Rust 版に移していないので、
//! そのテストも移していない。

mod beam;
mod converging;
mod damage_bound;
mod determinize;
mod dominance;
mod doomed;
mod eval;
mod keys;
mod lethal;
mod mulligan;
mod rhino;
mod rhino_bound;
mod rhino_puzzles;
mod search;
mod think;
mod valuenet;

use super::aidata::ai_data;
use super::eval::EvalWeights;
use super::exact_lethal::reset_exact_lethal_cache;
use super::greedy::GreedyAgent;
use super::lethal::reset_lethal;
use super::{Agent, Rng};
use crate::data::{data, CardIdx, ClassId};
use crate::game::{acting_player, apply_action, create_game, legal_actions};
use crate::json::Json;
use crate::state::*;
use crate::state_json::{action_from_json, state_to_json};

/// 名前のカード（同じ名前が複数あれば最初のもの）
pub fn id(name: &str) -> CardIdx {
    data()
        .cards
        .iter()
        .position(|c| c.name == name)
        .unwrap_or_else(|| panic!("未知のカード: {name}")) as CardIdx
}

pub fn name_of(c: CardIdx) -> &'static str {
    &card(c).name
}

/// 名前のデフォルトデッキ
pub fn deck(name: &str) -> &'static [CardIdx] {
    &data()
        .decks
        .iter()
        .find(|d| d.name == name)
        .unwrap_or_else(|| panic!("未知のデッキ: {name}"))
        .cards
}

/// 並び順で i 番目のデフォルトデッキ（TypeScript 版の DEFAULT_DECKS[i]）
pub fn deck_at(i: usize) -> &'static [CardIdx] {
    &data().decks[i].cards
}

/// クラスの最初のデフォルトデッキ（DEFAULT_DECKS.find((d) => d.class === ...)）
pub fn class_deck(cls: ClassId) -> &'static [CardIdx] {
    let class_of = |cards: &[CardIdx]| {
        cards
            .iter()
            .map(|&c| card(c).class)
            .find(|&c| c != ClassId::Neutral)
    };
    &data()
        .decks
        .iter()
        .find(|d| class_of(&d.cards) == Some(cls))
        .unwrap_or_else(|| panic!("{} のデッキがありません", cls.name()))
        .cards
}

/// スレッドごとの AI のメモ（実行中のリーサルの手順・全探索のメモ）を捨てる
pub fn fresh() {
    reset_lethal();
    reset_exact_lethal_cache();
}

/// 新しい対戦（AI のメモも捨てる）
pub fn new_game(d0: &[CardIdx], d1: &[CardIdx], seed: u32) -> GameState {
    fresh();
    create_game([d0, d1], seed)
}

pub fn apply(s: &GameState, a: &Action) -> GameState {
    apply_action(s, a)
}

/// 手順を打った局面
pub fn apply_all(s: &GameState, seq: &[Action]) -> GameState {
    seq.iter().fold(s.clone(), |t, a| apply(&t, a))
}

/// 手順を打つと p が勝つか
pub fn wins(s: &GameState, seq: Option<&[Action]>, p: PlayerIndex) -> bool {
    seq.is_some_and(|seq| apply_all(s, seq).winner == Some(p))
}

/// 最初の合法手でマリガンを済ませる
pub fn skip_mulligan(mut s: GameState) -> GameState {
    while s.phase == Phase::Mulligan {
        s = apply(&s, &legal_actions(&s)[0]);
    }
    s
}

/// 先攻・後攻の順に、何も入れ替えずにマリガンを済ませる
pub fn keep_hands(s: GameState) -> GameState {
    let first = s.first;
    let s = apply(
        &s,
        &Action::Mulligan {
            player: first,
            swap: vec![],
        },
    );
    apply(
        &s,
        &Action::Mulligan {
            player: opponent(first),
            swap: vec![],
        },
    )
}

pub fn hand_card(s: &mut GameState, name: &str) -> HandCard {
    s.new_hand_card(id(name), None)
}

pub fn hand_cards(s: &mut GameState, names: &[&str]) -> Vec<HandCard> {
    names.iter().map(|n| hand_card(s, n)).collect()
}

pub fn board_card(s: &mut GameState, name: &str) -> OnBoard {
    s.new_board_card(id(name), None)
}

/// 前のターンから場にいるフォロワー
pub fn old_follower(s: &mut GameState, name: &str) -> OnBoard {
    let mut c = board_card(s, name);
    assert!(c.is_follower, "フォロワーではありません: {name}");
    c.entered_turn = 0;
    c
}

/// 場のカード（変更用）
pub fn board_mut(s: &mut GameState, iid: Iid) -> &mut OnBoard {
    s.board_card_mut(iid).expect("場のカード")
}

/// 行動の列の JSON（TypeScript 版のテストに書いた手順）
pub fn actions(json: &str) -> Vec<Action> {
    match Json::parse(json).expect("JSON") {
        Json::Arr(items) => items
            .iter()
            .map(|a| action_from_json(a).expect("行動"))
            .collect(),
        _ => panic!("行動の配列ではありません"),
    }
}

/// 局面の JSON（項目を名前順。TypeScript 版の局面を JSON にしたものと同じ形）
pub fn canon(s: &GameState) -> String {
    state_to_json(s).canonical()
}

/// プレイヤー p の項目 key の JSON
pub fn player_part(s: &GameState, p: PlayerIndex, key: &str) -> String {
    let j = state_to_json(s);
    match j.get("players") {
        Some(Json::Arr(pl)) => pl[p].get(key).expect("項目").canonical(),
        _ => panic!("players がありません"),
    }
}

/// 基準の重みの貪欲法 AI（TypeScript 版の greedyAgent）
pub fn greedy_base() -> GreedyAgent {
    GreedyAgent {
        omniscient: false,
        weights: default_weights(),
        fuse_follow_up: false,
    }
}

pub fn default_weights() -> EvalWeights {
    EvalWeights::new(ai_data().default_weights.clone())
}

pub fn search_weights() -> EvalWeights {
    EvalWeights::new(ai_data().search_weights.clone())
}

/// cond が成り立つ間 agent で打ち続ける。打った手（打つ前の局面つき）と最後の局面
pub fn play_while(
    mut s: GameState,
    agent: &mut dyn Agent,
    rng: &mut Rng,
    cond: impl Fn(&GameState) -> bool,
) -> (Vec<(GameState, Action)>, GameState) {
    let mut moves = Vec::new();
    while s.phase != Phase::Ended && cond(&s) {
        let a = agent.choose_action(&s, &legal_actions(&s), rng);
        let next = apply(&s, &a);
        moves.push((s, a));
        s = next;
        assert!(moves.len() < 200, "手番が終わりません");
    }
    (moves, s)
}

/// p の手番（選択待ちを含む）が終わるまで打つ
pub fn play_turn(
    s: GameState,
    p: PlayerIndex,
    agent: &mut dyn Agent,
    rng: &mut Rng,
) -> (Vec<(GameState, Action)>, GameState) {
    play_while(s, agent, rng, |t| {
        t.phase == Phase::Main && acting_player(t) == p
    })
}

/// 打った手のうち、ターン終了の前までの手（TypeScript 版の playTurn はターン終了を返して打たない）
pub fn moves_of(moves: &[(GameState, Action)]) -> Vec<Action> {
    let mut out = Vec::new();
    for (_, a) in moves {
        out.push(a.clone());
        if *a == Action::EndTurn {
            break;
        }
    }
    out
}

/// 並べ替えた iid
pub fn sorted(mut v: Vec<Iid>) -> Vec<Iid> {
    v.sort();
    v
}

/// 小数第 2 位まで同じ（vitest の toBeCloseTo の既定）
#[track_caller]
pub fn assert_close(a: f64, b: f64) {
    assert!((a - b).abs() < 5e-3, "{a} と {b} が違います");
}
