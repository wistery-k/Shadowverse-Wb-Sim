//! 相手のターン終了時に自壊するフォロワー（tests/doomed.test.ts）

use super::*;
use crate::ai::eval::evaluate_with;
use crate::ai::search::{SearchAgent, SearchOptions};

/// 自分（0）の turn ターン目。場も手札も空、相手は体力 20 で場も空
fn position(turn: i32) -> GameState {
    let s = new_game(class_deck(ClassId::Nemesis), deck_at(1), 1);
    let mut s = keep_hands(s);
    while !(s.active == 0 && s.players[0].turn_count >= turn) {
        s = apply(&s, &Action::EndTurn);
    }
    s.players[0].board.make_mut().clear();
    s.players[0].hand.make_mut().clear();
    s.players[1].board.make_mut().clear();
    s.players[1].leader_hp = 20;
    s
}

/// 探索 AI でターンの終わりまで打った手。
/// 評価関数の doomed の効き目を見るので、学習した評価の補正（data/value-net.json）を足さない探索 AI で打つ
/// （補正を足すと、手札も場も空にした作りものの局面では攻撃しないことがある）
fn turn_moves(s: GameState) -> Vec<(GameState, Action)> {
    let mut agent = SearchAgent::new(SearchOptions {
        extra_eval: None,
        ..SearchOptions::default()
    });
    play_turn(s, 0, &mut agent, &mut Rng::new(7)).0
}

#[test]
fn doomed_followers_count_less() {
    // 探索 AI の重みでは、普通のフォロワーより安く数える
    let mut s = position(3);
    let sw = search_weights();
    let empty = evaluate_with(&s, 0, &sw);
    let puppet = board_card(&mut s, "改良型・操り人形");
    s.players[0].board = vec![puppet].into();
    let value = evaluate_with(&s, 0, &sw) - empty;
    let mut full = sw.w.clone();
    full.doomed = 1.0;
    let full_value = evaluate_with(&s, 0, &EvalWeights::new(full)) - empty;
    assert_close(value, full_value * sw.w.doomed);
}

#[test]
fn puppet_attacks_unkillable_follower() {
    // 改良型・操り人形を出したら、倒せない相手のフォロワーにも攻撃する（相手のターンの終わりに消えるので）
    let mut s = position(3);
    s.players[0].pp = 1;
    s.players[0].hand = hand_cards(&mut s, &["改良型・操り人形"]).into();
    let target = old_follower(&mut s, "激震のゴリアテ");
    s.players[1].board = vec![target].into();
    let moves = turn_moves(s);
    assert!(
        moves
            .iter()
            .any(|(_, a)| matches!(a, Action::Attack { .. })),
        "{:?}",
        moves.iter().map(|(_, a)| a).collect::<Vec<_>>()
    );
}

#[test]
fn super_evolves_the_follower_that_stays() {
    // アン＆グレアと一緒に出たアンの大英霊ではなく、場に残るアン＆グレアを超進化する
    let mut s = position(6);
    s.players[0].pp = 5;
    s.players[0].hand = hand_cards(&mut s, &["マナリアフレンズ・アン＆グレア"]).into();
    // シャークソルジャー（6/6）は、どちらかを超進化すれば倒せる。残るアン＆グレアを超進化する
    let shark = old_follower(&mut s, "シャークソルジャー");
    s.players[1].board = vec![shark].into();
    let moves = turn_moves(s);
    let before_end = moves
        .iter()
        .find(|(_, a)| *a == Action::EndTurn)
        .map(|(t, _)| t.clone())
        .expect("ターン終了");
    let spirit = before_end.players[0]
        .board
        .iter()
        .find(|c| c.card == id("アンの大英霊"))
        .expect("アンの大英霊")
        .iid;
    assert!(!moves
        .iter()
        .any(|(_, a)| matches!(a, Action::Evolve(i) | Action::SuperEvolve(i) if *i == spirit)));
}
