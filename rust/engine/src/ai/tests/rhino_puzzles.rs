//! リノセウスのリーサル問題集（tests/rhinoPuzzles.test.ts）。
//! ユーザーの Scala 製リーサル問題集（wb-lethal の puzzles/リノセウス.scala）をこちらの局面に移したもの（tests/rhinoPuzzles.ts と同じ）。
//! 問題集の expected は「出せる最大ダメージ」。相手の体力を expected にすればリーサルがあり、expected + 1 なら無い。
//! 全探索（このエンジンのルールで、ターン終了以外のすべての手を試す）では 4 問とも expected 点ちょうどが最大だった

use super::*;
use crate::ai::determinize::determinize;
use crate::ai::rhino::{
    rhino_damage_bound, rhino_lethal_bound, rhino_three_damage_bound, search_lethal_for_rhino_turn,
};
use crate::ai::rhino_lethal::{search_rhino_lethal, RhinoLethalOptions};
use crate::data::{Kw, RUSH, WARD};

/// 問題集の略称 → カード名
fn full_name(short: &str) -> &'static str {
    match short {
        "リノ" => "殺戮のリノセウス",
        "杖" => "聖樹の杖",
        "岩" => "燐光の岩",
        "招集" => "妖精の招集",
        "鞄" => "ベビーカーバンクル",
        "神秘" => "森の神秘",
        "フェアリー" => "フェアリー",
        _ => panic!("未知の略称: {short}"),
    }
}

struct Puzzle {
    name: &'static str,
    pp: i32,
    my_board: &'static [&'static str],
    opp_board: &'static [&'static str],
    hand: &'static [&'static str],
    ep: i32,
    sep: i32,
    expected: i32,
}

const PUZZLES: [Puzzle; 4] = [
    Puzzle {
        name: "リノセウス1（リノリノ）",
        pp: 8,
        my_board: &["杖", "岩"],
        opp_board: &[],
        hand: &["リノ", "招集"],
        ep: 1,
        sep: 0,
        expected: 10,
    },
    Puzzle {
        name: "リノセウス2（鞄リノリノ）",
        pp: 8,
        my_board: &["杖", "岩"],
        opp_board: &["フェアリー"],
        hand: &["リノ", "招集", "鞄", "神秘", "神秘"],
        ep: 1,
        sep: 1,
        expected: 17,
    },
    Puzzle {
        name: "リノセウス3（あて先無し）",
        pp: 8,
        my_board: &["杖", "岩"],
        opp_board: &[],
        hand: &["リノ", "招集", "鞄", "神秘", "神秘"],
        ep: 1,
        sep: 1,
        expected: 16,
    },
    Puzzle {
        name: "リノセウス4（リノリノリノ）",
        pp: 10,
        my_board: &["杖"],
        opp_board: &[],
        hand: &["リノ", "リノ", "招集", "招集", "神秘", "神秘", "神秘"],
        ep: 0,
        sep: 0,
        expected: 18,
    },
];

/// 問題の局面（相手の体力 opp_hp。AI のメモも捨てる。問題はどれも同じターン番号なので、ターンごとのメモと局面数の上限を問題ごとに戻す）
fn puzzle_state(pz: &Puzzle, opp_hp: i32) -> GameState {
    let s = new_game(class_deck(ClassId::Elf), class_deck(ClassId::Royal), 1);
    let mut s = skip_mulligan(s);
    s.active = 0;
    let hand: Vec<HandCard> = pz
        .hand
        .iter()
        .map(|n| hand_card(&mut s, full_name(n)))
        .collect();
    let board: Vec<OnBoard> = pz
        .my_board
        .iter()
        .map(|n| board_card(&mut s, full_name(n)))
        .collect();
    let me = &mut s.players[0];
    me.hand = hand.into();
    me.board = board.into();
    me.pp = pz.pp;
    me.max_pp = pz.pp;
    me.turn_count = pz.pp;
    me.ep = pz.ep;
    me.sep = pz.sep;
    me.combo = 0;
    me.extra_pp_available = false;
    let opp: Vec<OnBoard> = pz
        .opp_board
        .iter()
        .map(|n| board_card(&mut s, full_name(n)))
        .collect();
    s.players[1].board = opp.into();
    s.players[1].leader_hp = opp_hp;
    s
}

fn solves(i: usize) {
    let pz = &PUZZLES[i];
    let s = puzzle_state(pz, pz.expected);
    assert!(
        wins(&s, search_lethal_for_rhino_turn(&s, 0).as_deref(), 0),
        "{}",
        pz.name
    );
    // 相手の体力が 1 多ければ見つからない
    let s = puzzle_state(pz, pz.expected + 1);
    assert!(search_lethal_for_rhino_turn(&s, 0).is_none(), "{}", pz.name);
}

#[test]
fn puzzle1() {
    solves(0);
}

#[test]
fn puzzle2() {
    solves(1);
}

#[test]
fn puzzle3() {
    solves(2);
}

#[test]
fn puzzle4() {
    solves(3);
}

#[test]
fn wider_setup_beam_finds_puzzles_2_and_3() {
    // リノセウス2・3 は準備のビーム幅を広げれば見つかる（既定の 16 では切られる）
    for (i, beam_width) in [(1, 128), (2, 64)] {
        let pz = &PUZZLES[i];
        let s = puzzle_state(pz, pz.expected);
        let seq = search_rhino_lethal(
            &s,
            0,
            &RhinoLethalOptions {
                beam_width,
                max_depth: 10,
            },
        );
        assert!(wins(&s, seq.as_deref(), 0), "{}", pz.name);
    }
}

#[test]
fn damage_bounds() {
    // ダメージの上限の式（ユーザーの式）: 1〜3 問目は正解以上、4 問目はリノセウス 3 回なので式の外
    let bounds: Vec<i32> = PUZZLES
        .iter()
        .map(|pz| rhino_damage_bound(&puzzle_state(pz, pz.expected), 0))
        .collect();
    assert_eq!(bounds, vec![10, 17, 17, 17]);
    // リノセウス 3 回の上限の式（ユーザーの式）: 4 問目は正解以上で、足切りに使う上限もすべて正解以上
    let three: Vec<i32> = PUZZLES
        .iter()
        .map(|pz| rhino_three_damage_bound(&puzzle_state(pz, pz.expected), 0))
        .collect();
    assert_eq!(three, vec![6, 13, 13, 18]);
    for pz in &PUZZLES {
        assert!(rhino_lethal_bound(&puzzle_state(pz, pz.expected), 0) >= pz.expected);
    }
}

/// rhino-compare の seed 900234（リノセウスエルフ後攻 vs アマリアロイヤル）、エルフ 7 ターン目。
/// 全探索が最初に見つけた手順は虫の知らせのランダムダメージで守護を倒す運頼みで、findLethal の確認で捨てられていた。
/// 虫の知らせを使わない確実なリーサル（招集・フェアリー・カーバンクル・杖でコンボを稼ぎ、守護を削ってベイル → リノセウス 9 点）がある
#[test]
fn lethal_without_luck() {
    let s = new_game(deck("リノセウスエルフ"), deck("アマリアロイヤル"), 1);
    let mut s = skip_mulligan(s);
    s.turn = 14;
    s.first = 0;
    s.active = 0;
    let mut hand = hand_cards(
        &mut s,
        &[
            "虫の知らせ",
            "殺戮のリノセウス",
            "ベビーカーバンクル",
            "煌撃の戦士・ベイル",
            "妖精の招集",
            "ピュアクリスタリア・リリィ",
            "フェアリー",
            "聖樹の杖",
        ],
    );
    hand[3].cost_mod = -4;
    let rod = board_card(&mut s, "聖樹の杖");
    {
        let me = &mut s.players[0];
        me.hand = hand.into();
        me.board = vec![rod].into();
        me.leader_hp = 19;
        me.pp = 7;
        me.max_pp = 7;
        me.ep = 0;
        me.sep = 1;
        me.extra_pp_available = true;
        me.turn_count = 7;
        me.combo = 0;
    }
    let follower = |s: &mut GameState, name: &str, attack: i32, defense: i32| {
        let mut c = board_card(s, name);
        c.max_defense = defense.max(c.max_defense);
        c.attack = attack;
        c.defense = defense;
        c.entered_turn = 13;
        c
    };
    let knight = |s: &mut GameState, attack: i32, defense: i32| {
        let mut c = follower(s, "スティールナイト", attack, defense);
        c.keywords = Kw::EMPTY.with(RUSH).with(WARD);
        c.max_defense = 2;
        c
    };
    let lancer = follower(&mut s, "勇猛のルミナスランサー", 1, 2);
    let mage = follower(&mut s, "卓越のルミナスメイジ", 1, 3);
    let mut big = knight(&mut s, 5, 5);
    big.max_defense = 5;
    big.evolve = Evolve::SuperEvolved;
    big.attacks_this_turn = 1;
    let mut small = knight(&mut s, 2, 1);
    small.attacks_this_turn = 1;
    let fresh_knight = knight(&mut s, 2, 2);
    s.players[1].board = vec![lancer, mage, big, small, fresh_knight].into();
    s.players[1].leader_hp = 10;

    // 乱数や相手の手札を決め直しても勝てる手順を返す
    let seq = search_lethal_for_rhino_turn(&s, 0).expect("リーサル");
    assert!(wins(&s, Some(&seq), 0));
    for k in 0..5 {
        let d = determinize(&s, 0, &mut Rng::new(100 + k), false);
        assert!(wins(&d, Some(&seq), 0), "決め直し {k}");
    }
}
