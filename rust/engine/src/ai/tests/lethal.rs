//! リーサルの探索（tests/ai.test.ts の「リーサルの探索」）

use super::*;
use crate::ai::lethal::{
    find_lethal, search_lethal, DEFAULT_LETHAL_OPTIONS, GUARDED_LETHAL_OPTIONS,
};
use crate::ai::lethal_hint::lethal_hint;
use crate::ai::rhino::RhinoAgent;
use crate::ai::search::{SearchAgent, SearchOptions};

/// コンボを稼いでからリノセウスで倒せる局面（相手の体力 3）。手番のプレイヤーとリノセウスの iid
fn rhinoceus_position() -> (GameState, PlayerIndex, Iid) {
    let s = new_game(deck_at(0), deck_at(1), 4);
    let s = apply(&s, &legal_actions(&s)[0]);
    let mut s = apply(&s, &legal_actions(&s)[0]);
    let me = s.active;
    let hand = hand_cards(&mut s, &["殺戮のリノセウス", "森の神秘", "森の神秘"]);
    let rhino = hand[0].iid;
    let pl = &mut s.players[me];
    pl.hand = hand.into();
    pl.pp = 3;
    pl.max_pp = 3;
    s.players[opponent(me)].leader_hp = 3;
    (s, me, rhino)
}

#[test]
fn finds_combo_then_rhinoceus() {
    let (s, me, rhino) = rhinoceus_position();
    let seq = search_lethal(&s, me, &DEFAULT_LETHAL_OPTIONS).expect("リーサル");
    // リノセウスを先に出すと 1 点しか出ないので、最初の手は森の神秘
    assert_ne!(seq[0], Action::Play(rhino));
    assert!(wins(&s, Some(&seq), me));
}

#[test]
fn returns_none_without_lethal() {
    let (mut s, me, _) = rhinoceus_position();
    s.players[opponent(me)].leader_hp = 4;
    assert!(search_lethal(&s, me, &DEFAULT_LETHAL_OPTIONS).is_none());
    assert!(find_lethal(&s, me, &mut Rng::new(1), &DEFAULT_LETHAL_OPTIONS, None).is_none());
}

/// ユーザーの指摘（リノセウスエルフ vs スペルウィッチ、seed 2120563865 の 8 ターン目）を元にした局面。
/// フェアリー2体をウィリアム（守護なし）に当てて煌撃の戦士・ベイルを 0 コストにし、コンボを溜めてリノセウスで殴り、
/// 聖樹の杖のアクトでリノセウスを手札に戻して出し直し、超進化して殴ると 4 + 8 = 12 点
fn bail_position() -> GameState {
    let s = new_game(class_deck(ClassId::Elf), class_deck(ClassId::Witch), 1);
    let mut s = skip_mulligan(s);
    s.active = 0;
    let mut bail = hand_card(&mut s, "煌撃の戦士・ベイル");
    bail.cost_mod = -6;
    let fairies = hand_cards(&mut s, &["フェアリー", "フェアリー"]);
    let rhino = hand_card(&mut s, "殺戮のリノセウス");
    let rod = board_card(&mut s, "聖樹の杖");
    let william = board_card(&mut s, "マナリアの学徒・ウィリアム");
    let me = &mut s.players[0];
    me.hand = vec![fairies[0].clone(), fairies[1].clone(), bail, rhino].into();
    me.board = vec![rod].into();
    me.pp = 8;
    me.max_pp = 8;
    me.turn_count = 8;
    me.ep = 0;
    me.sep = 1;
    me.combo = 0;
    s.players[1].board = vec![william].into();
    s.players[1].leader_hp = 11;
    s
}

#[test]
fn finds_line_through_non_ward_follower_and_replayed_rhinoceus() {
    // 守護でないフォロワーに当てて安くし、リノセウスを出し直す並びを見つける
    let s = bail_position();
    let seq = search_lethal(&s, 0, &DEFAULT_LETHAL_OPTIONS);
    assert!(wins(&s, seq.as_deref(), 0));
}

#[test]
fn plays_found_lethal_to_the_end() {
    // 見つけたリーサルの手順を途中で探し直さずに最後まで打つ
    let mut rng = Rng::new(2);
    let mut search = SearchAgent::new(SearchOptions::default());
    let mut rhino = RhinoAgent::new(true);
    let agents: [&mut dyn Agent; 2] = [&mut search, &mut rhino];
    for agent in agents {
        let (_, end) = play_while(bail_position(), agent, &mut rng, |t| t.active == 0);
        assert_eq!(end.winner, Some(0));
    }
}

#[test]
fn search_agent_does_not_miss_lethal() {
    let (s, me, _) = rhinoceus_position();
    let mut agent = SearchAgent::new(SearchOptions::default());
    let mut s = s;
    while s.phase != Phase::Ended && s.active == me {
        let a = agent.choose_action(&s, &legal_actions(&s), &mut Rng::new(2));
        s = apply(&s, &a);
    }
    assert_eq!(s.winner, Some(me));
}

/// 人間の対戦記録（スペルウィッチ 2 回目）と同じ配りの AI どうしの試合（AFネメシス g1 の 18 ターン目）を元にした局面。
/// 鬼呼びの術で出した式神・暴鬼でシルヴィアに当てて（破壊された式神が 1 体増える）、エクストラ PP でエンハンス 10 のクオンを出し、
/// 超進化で 13/13 の式神・貴人に疾走を付けて顔に 13 点
fn kuon_enhance_position() -> GameState {
    let s = new_game(class_deck(ClassId::Witch), class_deck(ClassId::Nemesis), 1);
    let mut s = skip_mulligan(s);
    s.active = 0;
    // スペルブーストで 0 コストになった鬼呼びの術
    let mut call = hand_card(&mut s, "鬼呼びの術");
    call.boosts = 16;
    call.cost_mod = -7;
    let kuon = hand_card(&mut s, "五行の果て・クオン");
    let others = hand_cards(
        &mut s,
        &[
            "マナリアフレンズ・アン＆グレア",
            "マナリアフレンズ・アン＆グレア",
            "熾天使の福音",
            "最果ての罪・サタン",
            "マナリアの学徒・ウィリアム",
            "知恵の輝き",
        ],
    );
    let cauldron = board_card(&mut s, "魔女の錬金釜");
    let mut silvia = old_follower(&mut s, "箱庭の断罪者・シルヴィア");
    silvia.attack = 8;
    silvia.defense = 8;
    silvia.max_defense = 8;
    silvia.evolve = Evolve::SuperEvolved;
    let me = &mut s.players[0];
    me.hand = vec![call, kuon].into();
    me.hand.make_mut().extend(others);
    me.board = vec![cauldron].into();
    me.pp = 9;
    me.max_pp = 9;
    me.turn_count = 9;
    me.extra_pp_available = true;
    me.ep = 0;
    me.sep = 1;
    s.players[1].board = vec![silvia].into();
    s.players[1].leader_hp = 13;
    s.players[1].turn_count = 9;
    s.turn = 18;
    s
}

#[test]
fn lethal_hint_finds_enhanced_kuon_line() {
    let s = kuon_enhance_position();
    // ビームの途中の点数では貴人の大きさが見えず見つからないが、全探索で見つける
    assert!(search_lethal(&s, 0, &GUARDED_LETHAL_OPTIONS).is_none());
    let seq = lethal_hint(&s, 0, 1);
    assert!(wins(&s, seq.as_deref(), 0));
}

#[test]
fn damage_bound_keeps_enhanced_kuon_lethal() {
    let s = kuon_enhance_position();
    // 上限で打ち切っても、エンハンスのクオンの手順は残る
    let b = crate::ai::damage_bound::damage_bound(&s, 0, false).expect("上限");
    assert!(b >= 13, "上限 {b}");
    fresh();
    let opts = crate::ai::exact_lethal::sure_lethal_options(20_000);
    let seq = crate::ai::exact_lethal::search_exact_lethal(&s, 0, &opts);
    assert!(wins(&s, seq.as_deref(), 0));
}

#[test]
fn damage_bound_cuts_seven_cost_kuon() {
    // PP 7 でクオンを出しても（エンハンスできない）、顔に届くのは場の古い形代と超進化で疾走を与えた式神くらい
    let mut s = kuon_enhance_position();
    let kuon = s.players[0].hand[1].clone();
    let old = old_follower(&mut s, "式神・形代");
    let me = &mut s.players[0];
    me.hand = vec![kuon].into();
    me.board.make_mut().push(old);
    me.pp = 7;
    me.extra_pp_available = false;
    let b = crate::ai::damage_bound::damage_bound(&s, 0, false).expect("上限");
    let opts = crate::ai::exact_lethal::ExactLethalOptions {
        deterministic_only: true,
        damage_bound: false,
        ..crate::ai::exact_lethal::DEFAULT_EXACT_LETHAL_OPTIONS
    };
    let exact = crate::ai::exact_lethal::exact_max_damage(&s, 0, &opts).expect("全探索");
    assert!(exact <= b, "全探索 {exact} 上限 {b}");
    assert!(b < 13, "上限 {b}");
}
