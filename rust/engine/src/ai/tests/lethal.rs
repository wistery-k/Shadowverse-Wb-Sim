//! リーサルの探索（tests/ai.test.ts の「リーサルの探索」）

use super::*;
use crate::ai::lethal::{find_lethal, search_lethal, DEFAULT_LETHAL_OPTIONS};
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
    pl.hand = hand;
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
    me.hand = vec![fairies[0].clone(), fairies[1].clone(), bail, rhino];
    me.board = vec![rod];
    me.pp = 8;
    me.max_pp = 8;
    me.turn_count = 8;
    me.ep = 0;
    me.sep = 1;
    me.combo = 0;
    s.players[1].board = vec![william];
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
