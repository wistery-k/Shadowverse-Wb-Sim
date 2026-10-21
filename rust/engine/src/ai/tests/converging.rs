//! 合流する相打ち（tests/convergingTrade.test.ts）

use super::*;
use crate::ai::converging::{converging_attacks, settle_converging_trades};
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::data::{AMBUSH, INTIMIDATE, WARD};

/// プレイヤー0 の手番（PP 0）で、場が空の局面
fn empty_boards() -> GameState {
    let s = new_game(class_deck(ClassId::Elf), class_deck(ClassId::Royal), 1);
    let mut s = skip_mulligan(s);
    s.active = 0;
    s.turn = 9;
    for pl in s.players.iter_mut() {
        pl.board.make_mut().clear();
        pl.pp = 0;
    }
    s
}

/// 前のターンから場にいるフォロワーを置く
fn put(s: &mut GameState, p: PlayerIndex, name: &str, attack: i32, defense: i32) -> Iid {
    let mut f = board_card(s, name);
    f.attack = attack;
    f.defense = defense;
    f.max_defense = defense;
    f.entered_turn = s.turn - 1;
    let iid = f.iid;
    s.players[p].board.make_mut().push(f);
    iid
}

fn attack(a: Iid, b: Iid) -> Action {
    Action::Attack {
        attacker: a,
        target: Some(b),
    }
}

#[test]
fn converges_when_target_dies() {
    // 5/5 守護で 5/2 を攻撃して倒せるなら合流する（攻撃した側が倒れるかは問わない）
    let mut s = empty_boards();
    let a = put(&mut s, 0, "ガーディアンゴーレム", 5, 5);
    let b = put(&mut s, 1, "ゴブリン", 5, 2);
    assert_eq!(converging_attacks(&s, 0), vec![attack(a, b)]);
    let settled = settle_converging_trades(&s, 0).expect("合流する攻撃");
    assert!(settled.players[1].board.is_empty());
    assert!(settled.players[0].board.is_empty());
    // 攻撃した側が残る場合も合流する
    board_mut(&mut s, a).defense = 6;
    assert_eq!(converging_attacks(&s, 0), vec![attack(a, b)]);
}

#[test]
fn does_not_converge_when_target_survives() {
    let mut s = empty_boards();
    put(&mut s, 0, "ゴブリン", 2, 5);
    put(&mut s, 1, "ゴブリン", 5, 3);
    assert!(converging_attacks(&s, 0).is_empty());
}

#[test]
fn does_not_converge_behind_other_ward() {
    // 攻撃した側が守護でなく、自分の場に他の守護がいると、相手は攻撃し返せないので合流しない
    let mut s = empty_boards();
    let a = put(&mut s, 0, "ゴブリン", 5, 5);
    let b = put(&mut s, 1, "ゴブリン", 5, 2);
    put(&mut s, 0, "ガーディアンゴーレム", 0, 9);
    assert!(converging_attacks(&s, 0).is_empty());
    // 守護どうしなら他の守護がいても合流する
    let f = board_mut(&mut s, a);
    f.keywords = f.keywords.with(WARD);
    assert_eq!(converging_attacks(&s, 0), vec![attack(a, b)]);
}

#[test]
fn ambush_and_intimidate_do_not_converge() {
    // 潜伏・威圧のフォロワーは攻撃し返されないので合流しない
    for kw in [AMBUSH, INTIMIDATE] {
        let mut s = empty_boards();
        let a = put(&mut s, 0, "ゴブリン", 5, 5);
        put(&mut s, 1, "ゴブリン", 5, 2);
        let f = board_mut(&mut s, a);
        f.keywords = f.keywords.with(kw);
        assert!(converging_attacks(&s, 0).is_empty());
    }
}

#[test]
fn target_last_words_on_board_blocks_converging() {
    // 攻撃先が場に関わるラストワードを持つときだけ合流しない（攻撃する側のラストワードは見ない）。
    // TypeScript 版のテストが選んでいたカード（場に関わるラストワードは王家の御者、関わらないものはバトルマーチャント）
    let (board, plain) = ("王家の御者", "バトルマーチャント");
    let mut s = empty_boards();
    put(&mut s, 0, "ゴブリン", 5, 5);
    put(&mut s, 1, board, 5, 2);
    assert!(converging_attacks(&s, 0).is_empty());

    let mut s2 = empty_boards();
    let a2 = put(&mut s2, 0, "ゴブリン", 5, 5);
    let b2 = put(&mut s2, 1, plain, 5, 2);
    assert_eq!(converging_attacks(&s2, 0), vec![attack(a2, b2)]);

    let mut s3 = empty_boards();
    let a3 = put(&mut s3, 0, board, 5, 5);
    let b3 = put(&mut s3, 1, "ゴブリン", 5, 2);
    assert_eq!(converging_attacks(&s3, 0), vec![attack(a3, b3)]);
}

#[test]
fn temporary_attack_does_not_count() {
    // ターン終了までの攻撃力で倒せるだけなら合流しない
    let mut s = empty_boards();
    let a = put(&mut s, 0, "ゴブリン", 1, 5);
    put(&mut s, 1, "ゴブリン", 5, 2);
    board_mut(&mut s, a).temp_attack = 4;
    assert!(converging_attacks(&s, 0).is_empty());
}

#[test]
fn search_agent_settles_trades_before_ending_turn() {
    // 探索 AI（settleTrades）は合流する攻撃をせずにターンを終えない
    let mut s = empty_boards();
    let a = put(&mut s, 0, "ガーディアンゴーレム", 5, 5);
    let b = put(&mut s, 1, "ゴブリン", 5, 2);
    // 攻撃先はこれだけ（リーダーは攻撃できない）
    let f = board_mut(&mut s, b);
    f.keywords = f.keywords.with(WARD);
    let mut agent = SearchAgent::new(SearchOptions {
        settle_trades: true,
        lethal: false,
        ..SearchOptions::default()
    });
    let chosen = agent.choose_action(&s, &legal_actions(&s), &mut Rng::new(1));
    assert_eq!(chosen, attack(a, b));
}
