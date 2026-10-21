//! rhino_turn_damage_bound（リノセウスの全探索の打ち切りに使う、リノセウスエルフ専用の上限）が、全探索の最大ダメージを下回らないこと

use super::*;
use crate::ai::exact_lethal::{exact_max_damage, ExactLethalOptions, DEFAULT_EXACT_LETHAL_OPTIONS};
use crate::ai::registry::create_agent;
use crate::ai::rhino::rhino_turn_damage_bound;

/// 打ち切りを使わない全探索（上限と比べる正解）
fn exact(s: &GameState, p: PlayerIndex, max_states: i64) -> Option<i32> {
    let o = ExactLethalOptions {
        max_states,
        damage_bound: false,
        ..DEFAULT_EXACT_LETHAL_OPTIONS
    };
    exact_max_damage(s, p, &o)
}

/// エルフのカードを手札・場にランダムに置いた小さな局面で比べる（相手は体力 99 のロイヤル）
#[test]
fn bound_is_not_below_exact_damage_in_random_states() {
    let hand_pool = [
        "殺戮のリノセウス",
        "殺戮のリノセウス",
        "聖樹の杖",
        "燐光の岩",
        "森の神秘",
        "虫の知らせ",
        "ベビーカーバンクル",
        "煌撃の戦士・ベイル",
        "フェアリーテイマー",
        "純粋なるウォーターフェアリー",
        "妖精の招集",
        "アドベンチャーエルフ・メイ",
        "フェアリー",
        "ピュアクリスタリア・リリィ",
    ];
    let board_pool = [
        "殺戮のリノセウス",
        "聖樹の杖",
        "燐光の岩",
        "ベビーカーバンクル",
        "フェアリー",
        "煌撃の戦士・ベイル",
        "純粋なるウォーターフェアリー",
    ];
    let opp_pool = [
        "ナイト",
        "勇猛のルミナスランサー",
        "王家の御者",
        "異端の侍",
        "スティールナイト",
        "王断の天宮・スタチウム",
    ];
    let mut rng = Rng::new(1);
    let mut checked = 0;
    for it in 0..200 {
        let mut s = skip_mulligan(new_game(
            class_deck(ClassId::Elf),
            class_deck(ClassId::Royal),
            1 + it,
        ));
        s.active = 0;
        let hand: Vec<HandCard> = (0..rng.int(7))
            .map(|_| {
                let mut h = hand_card(&mut s, hand_pool[rng.int(hand_pool.len())]);
                if name_of(h.card) == "煌撃の戦士・ベイル" {
                    h.cost_mod = -(rng.int(9) as i32);
                }
                h
            })
            .collect();
        let board: Vec<OnBoard> = (0..rng.int(5))
            .map(|_| {
                let mut c = board_card(&mut s, board_pool[rng.int(board_pool.len())]);
                if c.is_follower {
                    if rng.int(2) == 0 {
                        c.entered_turn = 0;
                    }
                    if rng.int(3) == 0 {
                        c.attacks_this_turn = c.max_attacks;
                    }
                    if name_of(c.card) == "殺戮のリノセウス" {
                        c.attack = rng.int(7) as i32;
                    }
                    if rng.int(5) == 0 {
                        c.evolve = Evolve::SuperEvolved;
                        c.attack += 3;
                        c.defense += 3;
                    }
                }
                c
            })
            .collect();
        let opp: Vec<OnBoard> = (0..rng.int(4))
            .map(|_| {
                let mut c = old_follower(&mut s, opp_pool[rng.int(opp_pool.len())]);
                c.defense = 1 + rng.int(c.defense.max(1) as usize) as i32;
                c
            })
            .collect();
        let me = &mut s.players[0];
        me.hand = hand.into();
        me.board = board.into();
        me.pp = rng.int(11) as i32;
        me.max_pp = me.pp.max(1 + rng.int(10) as i32);
        me.turn_count = 3 + rng.int(8) as i32;
        me.ep = rng.int(3) as i32;
        me.sep = rng.int(3) as i32;
        me.evolved_this_turn = rng.int(4) == 0;
        me.combo = rng.int(5) as i32;
        me.extra_pp_available = rng.int(4) == 0;
        s.players[1].board = opp.into();
        s.players[1].leader_hp = 99;
        let Some(bound) = rhino_turn_damage_bound(&s, 0) else {
            continue;
        };
        fresh();
        let Some(e) = exact(&s, 0, 20_000) else {
            continue;
        };
        assert!(e <= bound, "{it}: 全探索 {e} 上限 {bound}");
        checked += 1;
    }
    assert!(checked > 150, "調べた局面 {checked}");
}

/// 少しランダムに打つ greedy どうしの試合（リノセウスエルフと各デッキ）の、エルフの手番の局面で比べる
#[test]
fn bound_is_not_below_exact_damage_in_games() {
    let d = &data().decks;
    let elf = d.iter().position(|x| x.name == "リノセウスエルフ").unwrap();
    let mut checked = 0;
    for (g, opp) in (0..3).flat_map(|g| (0..d.len()).filter(|&i| i != elf).map(move |i| (g, i))) {
        let seat = (opp + g) % 2;
        let decks: [&[CardIdx]; 2] = if seat == 0 {
            [&d[elf].cards, &d[opp].cards]
        } else {
            [&d[opp].cards, &d[elf].cards]
        };
        fresh();
        let mut s = create_game(decks, 200 + 100 * g as u32 + opp as u32);
        let mut agents = [
            create_agent("greedy").unwrap(),
            create_agent("greedy").unwrap(),
        ];
        let mut rng = Rng::new((100 * g + opp) as u32 ^ 0x77);
        let mut steps = 0;
        while s.phase != Phase::Ended && steps < 2000 {
            steps += 1;
            if s.turn > 0
                && s.active == seat
                && s.pending.is_none()
                && s.stack.is_empty()
                && s.queue.is_empty()
            {
                if let Some(bound) = rhino_turn_damage_bound(&s, seat) {
                    if let Some(e) = exact(&s, seat, 5000) {
                        assert!(
                            e <= bound,
                            "{} T{}: 全探索 {e} 上限 {bound}",
                            d[opp].name,
                            s.turn
                        );
                        checked += 1;
                    }
                }
            }
            let legal = legal_actions(&s);
            let actor = acting_player(&s);
            let a = if rng.int(4) == 0 {
                legal[rng.int(legal.len())].clone()
            } else {
                agents[actor].choose_action(&s, &legal, &mut rng)
            };
            s = apply_action(&s, &a);
        }
    }
    assert!(checked > 200, "調べた局面 {checked}");
}
