//! 探索 AI（tests/ai.test.ts の「探索 AI」「turn1ExtraPp」）

use super::*;
use crate::ai::search::{simulate_opponent_turn, SearchAgent, SearchOptions};
use crate::sim::play_match;

#[test]
fn finishes_games_with_opp_hand_samples_and_peek() {
    // 相手の手札を引き直して読む設定（oppHandSamples）と、実験用の相手の手札を見る設定（peekOppHand）でも最後まで打てる
    let mut search = SearchAgent::new(SearchOptions {
        opp_hand_samples: 2,
        peek_opp_hand: true,
        ..SearchOptions::default()
    });
    let mut greedy = greedy_base();
    fresh();
    let end = play_match(
        &mut [&mut search, &mut greedy],
        [deck_at(3), deck_at(1)],
        6,
        |_, _| {},
    );
    assert!(end.winner.is_some());
}

#[test]
fn reads_opponent_turn_from_pending_choice() {
    // 能力の選択待ちの途中の局面からも、選択を済ませて相手のターンまで読む
    let policy = default_weights();
    let mut found = false;
    for seed in 1..=20u32 {
        let mut state = new_game(deck_at(0), deck_at(1), seed);
        let mut rng = Rng::new(seed);
        let mut greedy = greedy_base();
        while state.phase != Phase::Ended {
            let p = state.active;
            if state.phase == Phase::Main && state.pending.as_ref().map(|x| x.player()) == Some(p) {
                let after = simulate_opponent_turn(&state, p, &mut Rng::new(seed), &policy, false);
                if after.phase != Phase::Ended {
                    assert!(after.pending.is_none());
                    assert_eq!(after.active, p);
                    assert_eq!(after.turn, state.turn + 2);
                }
                found = true;
                break;
            }
            let a = greedy.choose_action(&state, &legal_actions(&state), &mut rng);
            state = apply(&state, &a);
        }
        if found {
            break;
        }
    }
    assert!(found);
}

/// ロイヤルの 8 ターン目（PP 8・SEP 2）。相手は体力 20 で場に opp を置く
fn geno_turn(geno_in_hand: bool, opp: &[&str]) -> GameState {
    let s = new_game(deck("アマリアロイヤル"), deck("ランプドラゴン"), 1);
    let mut s = keep_hands(s);
    while !(s.active == 0 && s.players[0].turn_count >= 8) {
        s = apply(&s, &Action::EndTurn);
    }
    s.players[0].board.make_mut().clear();
    s.players[1].board.make_mut().clear();
    s.players[0].hand.make_mut().clear();
    if geno_in_hand {
        let h = hand_card(&mut s, "レヴィオンアックス・ジェノ");
        s.players[0].hand.make_mut().push(h);
    } else {
        let f = old_follower(&mut s, "レヴィオンアックス・ジェノ");
        s.players[0].board.make_mut().push(f);
    }
    for name in opp {
        let f = old_follower(&mut s, name);
        s.players[1].board.make_mut().push(f);
    }
    s
}

/// 探索 AI でターンの終わりまで打ち、打った手を返す。
/// SEP の重みの効き目を見るので、相手のターンは貪欲法で読む
/// （相手のターンをビームサーチで読むと、乱数によっては超進化しない。12 通り中 4 回）。
/// learned が false なら学習した評価の補正（data/value-net.json）を足さない
fn sep_turn(s: GameState, learned: bool) -> Vec<Action> {
    let d = SearchOptions::default();
    let mut agent = SearchAgent::new(SearchOptions {
        opponent_search: None,
        extra_eval: if learned { d.extra_eval.clone() } else { None },
        ..d
    });
    let (moves, _) = play_turn(s, 0, &mut agent, &mut Rng::new(7));
    moves_of(&moves)
}

#[test]
fn geno_does_not_super_evolve_when_not_needed() {
    // ジェノ（7/6、2 回攻撃）で激震のゴリアテ（4/5）と異端の侍を倒せる。
    // 手札にはこのターンに出せない最果ての罪・サタン（10 コスト）も持たせる。手札がジェノだけだと、ジェノを出すと手札が 0 枚になり、
    // 学習した補正はこの作りものの局面でそれを大きく嫌って（相手の手札は 9 枚）、乱数によってはジェノを出さずにターンを終える
    // （qlp で 24 通り中 3 回、p60p で 2 回。サタンを 1 枚持たせると、どの補正でも 24 回とも 2 回攻撃して超進化しない）
    let mut s = geno_turn(true, &["激震のゴリアテ", "異端の侍"]);
    let filler = hand_card(&mut s, "最果ての罪・サタン");
    s.players[0].hand.make_mut().push(filler);
    let actions = sep_turn(s, true);
    let attacks = actions
        .iter()
        .filter(|a| matches!(a, Action::Attack { .. }))
        .count();
    assert_eq!(attacks, 2, "{actions:?}");
    assert!(!actions.iter().any(|a| matches!(a, Action::SuperEvolve(_))));
}

#[test]
fn geno_super_evolves_to_kill_big_follower() {
    // 守護の激震のゴリアテを倒した後、キャラバンマンモス（10/10）は超進化した 10 点でないと倒せない。
    // 手で作った評価の SEP の重みで超進化を選ぶか見る。場の介入を混ぜて学んだ補正（2026-10-17 の既定）を足すと、
    // 手札も場も作りもののこの局面では、乱数 24 通り中 2 回しか超進化せず、マンモスを残して進化してリーダーを攻撃する
    // （前の補正では 24 回とも超進化した。分かっている弱点。docs/ai-notes.md「場のカードを消す介入を混ぜる」）
    let actions = sep_turn(
        geno_turn(false, &["激震のゴリアテ", "キャラバンマンモス"]),
        false,
    );
    assert!(
        actions.iter().any(|a| matches!(a, Action::SuperEvolve(_))),
        "{actions:?}"
    );
}

#[test]
fn uses_extra_pp_on_turn_1() {
    // 後攻の 1 ターン目でも、2 コストが手札にあればエクストラPP を使う（turn1ExtraPp の既定 always）
    let mut s = new_game(deck_at(0), deck_at(1), 5);
    while s.phase == Phase::Mulligan {
        let a = legal_actions(&s)
            .into_iter()
            .find(|a| matches!(a, Action::Mulligan { swap, .. } if swap.is_empty()))
            .expect("入れ替えないマリガン");
        s = apply(&s, &a);
    }
    s = apply(&s, &Action::EndTurn);
    let p = s.active;
    assert_eq!(s.players[p].turn_count, 1);
    assert!(s.players[p].extra_pp_available);
    let h = hand_card(&mut s, "竜育の少女");
    s.players[p].hand.make_mut().push(h);
    let mut agent = SearchAgent::new(SearchOptions::default());
    let a = agent.choose_action(&s, &legal_actions(&s), &mut Rng::new(1));
    assert_eq!(a, Action::ExtraPp);
}

#[test]
fn resampled_draws_carry_deck_states() {
    // このターンに引いたカードを並べ直すとき、山札に戻って状態を持っていたカードは状態ごと動き、
    // 引いてから受けたスペルブーストだけをかけ直す
    use crate::ai::search::resample_own_draws;
    let blaze = id("ブレイズデストロイヤー");
    let s0 = new_game(deck_at(0), deck_at(1), 3);
    let s0 = apply(&s0, &legal_actions(&s0)[0]);
    let mut root = apply(&s0, &legal_actions(&s0)[0]);
    let p = root.active;
    let iid = root.players[p].deck[0].iid;
    root.players[p].deck.make_mut()[0].card = blaze;
    let mut h = root.new_hand_card(blaze, Some(iid));
    h.boosts = 2;
    h.cost_mod = -2;
    root.players[p].deck_kept.push(h);
    let mut s = root.clone();
    let drawn = s.draw_cards(p, 1, None, None);
    assert_eq!(drawn, vec![iid]);
    crate::effects::fire_spellboost(&mut s, p, iid, 1);
    crate::effects::run(&mut s);
    let i = s.players[p].hand.iter().position(|h| h.iid == iid).unwrap();
    assert_eq!(
        (s.players[p].hand[i].boosts, s.players[p].hand[i].cost_mod),
        (3, -3)
    );

    let (mut kept_in_hand, mut kept_in_deck) = (false, false);
    let mut rng = Rng::new(11);
    for _ in 0..40 {
        let mut t = s.clone();
        resample_own_draws(&mut t, &root, p, &mut rng);
        let pl = &t.players[p];
        let h = &pl.hand[i];
        assert_eq!(h.iid, iid);
        let in_deck: Vec<&HandCard> = pl.deck_kept.iter().collect();
        if h.card == blaze && in_deck.is_empty() {
            // 状態を持ったブレイズデストロイヤーを引いた並び
            assert_eq!((h.boosts, h.cost_mod), (3, -3));
            kept_in_hand = true;
        } else {
            assert_eq!(h.boosts, 1);
            assert_eq!(in_deck.len(), 1);
            let k = in_deck[0];
            assert_eq!((k.card, k.boosts, k.cost_mod), (blaze, 2, -2));
            assert!(pl.deck.iter().any(|r| r.iid == k.iid && r.card == blaze));
            kept_in_deck = true;
        }
    }
    assert!(kept_in_hand && kept_in_deck);
}

#[test]
fn record_reads_does_not_change_moves() {
    // 想像の局面を残しても（TD 学習の自己対戦の --imagined）打つ手は同じ。残すのは、選んだ並びを相手のターンまで読んだ後の
    // 自分のターンの最初の局面（相手の手札の引き直しごとに 1 つ）
    let mut plain = SearchAgent::new(SearchOptions::default());
    let mut rec = SearchAgent::new(SearchOptions {
        record_reads: true,
        ..SearchOptions::default()
    });
    fresh();
    let mut state = new_game(deck_at(0), deck_at(1), 11);
    let (mut r1, mut r2) = (Rng::new(5), Rng::new(5));
    let mut seen = 0;
    while state.phase != Phase::Ended && state.turn <= 8 {
        let legal = legal_actions(&state);
        let p = acting_player(&state);
        let a = plain.choose_action(&state, &legal, &mut r1);
        let b = rec.choose_action(&state, &legal, &mut r2);
        assert_eq!(a, b);
        assert!(plain.take_reads(p).is_empty());
        let reads = rec.take_reads(p);
        assert!(reads.len() <= SearchOptions::default().opp_hand_samples);
        for r in &reads {
            assert!(
                r.phase == Phase::Ended
                    || (r.active == p && r.pending.is_none() && r.turn > state.turn)
            );
        }
        seen += reads.len();
        state = apply(&state, &a);
    }
    assert!(seen > 0);
}
