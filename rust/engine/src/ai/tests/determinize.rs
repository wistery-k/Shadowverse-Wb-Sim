//! determinization（tests/ai.test.ts の「determinization」）

use super::*;
use crate::ai::determinize::{
    determinize, determinize_apart, determinize_with, replay_hand_slots, HandSlot,
};
use crate::data::{CardFilter, CardType};

/// 両者がマリガンを済ませた局面
fn after_mulligan() -> GameState {
    let s = new_game(deck_at(0), deck_at(1), 3);
    let s = apply(&s, &legal_actions(&s)[0]);
    apply(&s, &legal_actions(&s)[0])
}

#[test]
fn keeps_own_cards_and_shuffles_hidden_ones() {
    let mut s = after_mulligan();
    let viewer = s.active;
    let opp = opponent(viewer);
    let fairy = id("フェアリー");
    // 効果で手札に加えたトークンは中身が公開されている
    let mut h = s.new_hand_card(fairy, None);
    h.revealed = true;
    s.players[opp].hand.make_mut().push(h);
    let hidden = |st: &GameState| {
        let pl = &st.players[opp];
        let mut v: Vec<CardIdx> = pl
            .hand
            .iter()
            .filter(|h| h.card != fairy)
            .map(|h| h.card)
            .chain(pl.deck.iter().map(|r| r.card))
            .collect();
        v.sort();
        v
    };
    let deck_cards = |st: &GameState| {
        let mut v: Vec<CardIdx> = st.players[viewer].deck.iter().map(|r| r.card).collect();
        v.sort();
        v
    };

    let d = determinize(&s, viewer, &mut Rng::new(1), false);
    assert_eq!(
        player_part(&d, viewer, "hand"),
        player_part(&s, viewer, "hand")
    );
    assert_eq!(
        player_part(&d, viewer, "board"),
        player_part(&s, viewer, "board")
    );
    assert_eq!(deck_cards(&d), deck_cards(&s));
    let iids = |st: &GameState| {
        st.players[opp]
            .hand
            .iter()
            .map(|h| h.iid)
            .collect::<Vec<_>>()
    };
    assert_eq!(iids(&d), iids(&s));
    assert_eq!(d.players[opp].hand.last().map(|h| h.card), Some(fairy));
    assert_eq!(hidden(&d), hidden(&s));
    assert_ne!(d.rng, s.rng);
    // 元の局面は変更しない（同じ乱数なら同じ局面）
    assert_eq!(
        canon(&determinize(&s, viewer, &mut Rng::new(1), false)),
        canon(&d)
    );
}

#[test]
fn keeps_revealed_cards_and_respects_draw_conditions() {
    let mut s = after_mulligan();
    let viewer = s.active;
    let opp = opponent(viewer);
    let spell: &'static CardFilter = Box::leak(Box::new(CardFilter {
        ctype: Some(CardType::Spell),
        ..CardFilter::default()
    }));
    let any: &'static CardFilter = Box::leak(Box::new(CardFilter::default()));
    {
        let hand = &mut s.players[opp].hand;
        hand.make_mut()[0].revealed = true;
        hand.make_mut()[1].drawn_by = Some(DrawHint {
            filter: spell,
            cost_eq: None,
        });
        hand.make_mut()[2].drawn_by = Some(DrawHint {
            filter: any,
            cost_eq: Some(1),
        });
    }
    let pl = &s.players[opp];
    let rest: Vec<CardIdx> = pl.hand[1..]
        .iter()
        .map(|h| h.card)
        .chain(pl.deck.iter().map(|r| r.card))
        .collect();
    let has_spell = rest.iter().any(|&c| card(c).ctype == CardType::Spell);
    let has_cost1 = rest.iter().any(|&c| card(c).cost == 1);
    let opp_hand: Vec<CardIdx> = pl.hand.iter().map(|h| h.card).collect();
    let mut rng = Rng::new(5);
    for _ in 0..20 {
        let d = determinize(&s, viewer, &mut rng, false);
        let h = &d.players[opp].hand;
        assert_eq!(h[0].card, opp_hand[0]);
        if has_spell {
            assert_eq!(card(h[1].card).ctype, CardType::Spell);
        }
        if has_cost1 {
            assert_eq!(card(h[2].card).cost, 1);
        }
        // 実験用の設定では相手の手札を実際のまま残す
        let peek = determinize(&s, viewer, &mut rng, true);
        let cards: Vec<CardIdx> = peek.players[opp].hand.iter().map(|h| h.card).collect();
        assert_eq!(cards, opp_hand);
    }
}

/// 山札に戻ったカードの手札での状態を、山札の iid の i 枚目に付ける
fn keep_state(s: &mut GameState, p: PlayerIndex, i: usize, boosts: i32) -> Iid {
    let r = s.players[p].deck[i];
    let mut h = s.new_hand_card(r.card, Some(r.iid));
    h.boosts = boosts;
    s.players[p].deck_kept.push(h);
    r.iid
}

#[test]
fn keeps_own_deck_states_and_drops_hidden_ones() {
    // 自分の山札に戻ったカードの状態はそのカードに付けたまま並べ直す。相手の山札のものは伏せた手札と同じく作り直す
    let mut s = after_mulligan();
    let viewer = s.active;
    let opp = opponent(viewer);
    let mine = keep_state(&mut s, viewer, 3, 2);
    let card = s.players[viewer].deck[3].card;
    keep_state(&mut s, opp, 0, 4);
    let mut rng = Rng::new(7);
    for _ in 0..10 {
        let d = determinize(&s, viewer, &mut rng, false);
        let kept = &d.players[viewer].deck_kept;
        assert_eq!(kept.len(), 1);
        assert_eq!((kept[0].iid, kept[0].card, kept[0].boosts), (mine, card, 2));
        assert!(d.players[viewer]
            .deck
            .iter()
            .any(|r| r.iid == mine && r.card == card));
        assert!(d.players[opp].deck_kept.is_empty());
    }
}

#[test]
fn shuffles_hidden_discards_with_hidden_cards() {
    // 相手がどのカードを捨てたかは分からないので、伏せた手札・山札と合わせて並べ直し、残りを捨てたカードとする
    let mut s = after_mulligan();
    let viewer = s.active;
    let opp = opponent(viewer);
    let fairy = id("フェアリー");
    s.players[opp].hidden_discards = vec![fairy, fairy].into();
    let all = |st: &GameState| {
        let pl = &st.players[opp];
        let mut v: Vec<CardIdx> = pl
            .hand
            .iter()
            .map(|h| h.card)
            .chain(pl.deck.iter().map(|r| r.card))
            .chain(pl.hidden_discards.iter().copied())
            .collect();
        v.sort();
        v
    };
    let mut rng = Rng::new(11);
    let mut fairy_moved = false;
    for _ in 0..20 {
        let d = determinize(&s, viewer, &mut rng, false);
        assert_eq!(all(&d), all(&s));
        assert_eq!(d.players[opp].hidden_discards.len(), 2);
        assert_eq!(d.players[opp].hand.len(), s.players[opp].hand.len());
        assert_eq!(d.players[opp].deck.len(), s.players[opp].deck.len());
        fairy_moved |= d.players[opp].hidden_discards.iter().any(|&c| c != fairy);
        // 自分が捨てたカードは自分には分かっている
        assert_eq!(
            d.players[viewer].hidden_discards,
            s.players[viewer].hidden_discards
        );
    }
    assert!(fairy_moved);
}

#[test]
fn hidden_token_in_hand_is_shuffled() {
    // 公開の印のないトークン（山札から引いた、捨てる・戻すカードの候補だった）は伏せたカードと同じく並べ直す
    let mut s = after_mulligan();
    let viewer = s.active;
    let opp = opponent(viewer);
    let fairy = id("フェアリー");
    let h = s.new_hand_card(fairy, None);
    s.players[opp].hand.make_mut().push(h);
    let mut rng = Rng::new(3);
    let moved = (0..20).any(|_| {
        let d = determinize(&s, viewer, &mut rng, false);
        d.players[opp].hand.last().map(|h| h.card) != Some(fairy)
    });
    assert!(moved);
}

/// determinize_apart: 自分の山札の枚数が違う局面どうしでも、同じ種なら相手の手札・山札と局面の乱数が同じになる
/// （determinize は自分の山札を先に並べ直すので、枚数が違うと相手の分が変わる）。自分の山札の中身は変えない
#[test]
fn apart_keeps_opponent_deal_when_own_deck_size_differs() {
    let s = after_mulligan();
    let viewer = s.active;
    let opp = opponent(viewer);
    let mut t = s.clone();
    let drawn = t.players[viewer].deck.make_mut().remove(0);
    let h = t.new_hand_card(drawn.card, Some(drawn.iid));
    t.players[viewer].hand.make_mut().push(h);
    let opp_part = |st: &GameState| {
        let pl = &st.players[opp];
        (
            pl.hand.iter().map(|h| h.card).collect::<Vec<_>>(),
            pl.deck.iter().map(|r| r.card).collect::<Vec<_>>(),
            st.rng,
        )
    };
    let mut same = 0;
    for seed in 1..=20 {
        let a = determinize_apart(&s, viewer, &mut Rng::new(seed), false);
        let b = determinize_apart(&t, viewer, &mut Rng::new(seed), false);
        assert_eq!(opp_part(&a), opp_part(&b));
        let own = |st: &GameState| {
            let mut v: Vec<Iid> = st.players[viewer].deck.iter().map(|r| r.iid).collect();
            v.sort();
            v
        };
        assert_eq!(own(&a), own(&s));
        assert_eq!(own(&b), own(&t));
        if opp_part(&determinize(&s, viewer, &mut Rng::new(seed), false))
            == opp_part(&determinize(&t, viewer, &mut Rng::new(seed), false))
        {
            same += 1;
        }
    }
    // 前の決定化は、枚数が 1 枚違うと相手の手札が変わる
    assert!(same < 20, "{same}");
}

// ---- 伏せた手札のスペルブーストの見込み（oppHandBoosts） ----

/// 手札の記録の伏せた枠の数（入った − 出た）
fn log_balance(s: &GameState, p: PlayerIndex) -> i64 {
    s.players[p]
        .hand_log
        .to_vec()
        .iter()
        .map(|e| match e {
            HandEv::In { .. } | HandEv::InWith { .. } => 1,
            HandEv::Out { .. } | HandEv::OutUnknown | HandEv::ToDeck => -1,
            _ => 0,
        })
        .sum()
}

fn hidden_count(s: &GameState, p: PlayerIndex) -> i64 {
    s.players[p].hand.iter().filter(|h| !h.revealed).count() as i64
}

/// どのデッキどうしでも、手札の記録の伏せた枠の数がいつも伏せた手札の枚数と合い、記録をなぞれる。記録は JSON で行き来できる
#[test]
fn hand_log_matches_hidden_hand() {
    let n = data().decks.len();
    let mut boosted = 0;
    for g in 0..(n * n) {
        let mut s = new_game(deck_at(g % n), deck_at(g / n), g as u32 + 1);
        let mut rng = Rng::new(g as u32 + 7);
        let mut steps = 0;
        while s.phase != Phase::Ended && steps < 2000 {
            let legal = legal_actions(&s);
            s = apply(&s, &legal[rng.int(legal.len())]);
            steps += 1;
            for p in 0..2 {
                assert_eq!(
                    log_balance(&s, p),
                    hidden_count(&s, p),
                    "試合 {g} 手 {steps} プレイヤー {p}"
                );
            }
            if s.phase != Phase::Ended && steps % 5 == 0 {
                let viewer = s.active;
                let o = opponent(viewer);
                if replay_hand_slots(&s, o, &mut Rng::new(steps as u32)).is_some() {
                    boosted += 1;
                }
                let d = determinize_with(&s, viewer, &mut Rng::new(steps as u32), false, true);
                assert_eq!(hidden_count(&d, o), hidden_count(&s, o));
            }
        }
        let back = crate::state_json::state_from_json(&state_to_json(&s)).expect("読み込み");
        assert_eq!(back.players[0].hand_log, s.players[0].hand_log);
        assert_eq!(canon(&back), canon(&s));
    }
    // スペルブーストのあるデッキで、記録から回数が見込める局面が出てくる
    assert!(boosted > 0);
}

/// 伏せた手札の記録をなぞって、出したカードの見えたコストから、どの枠が出たかを絞る
#[test]
fn replays_spellboosts_onto_redealt_hand() {
    let mut s = after_mulligan();
    let viewer = s.active;
    let o = opponent(viewer);
    let oni = id("鬼呼びの術");
    let base = card(oni).cost;
    assert!(base > 3);
    // 伏せた枠 4 つ（2 回 + 3 回 = 5 回）と、後から入った 1 つ（3 回）。3 回の枠から鬼呼びの術（コスト base - 3）を出した
    let mut log = HandLog::default();
    for _ in 0..4 {
        log.push(HandEv::In { deck: 0 });
    }
    log.push(HandEv::Boost { times: 2 });
    log.push(HandEv::In { deck: 0 });
    log.push(HandEv::Boost { times: 3 });
    let mut played = s.new_hand_card(oni, None);
    played.cost_mod = -3;
    played.boosts = 3;
    log.push(HandEv::out_of(&played, false));
    let hand: Vec<HandCard> = (0..4).map(|_| s.new_hand_card(oni, None)).collect();
    s.players[o].hand = hand.into();
    s.players[o].hand_log = log;
    let slots = replay_hand_slots(&s, o, &mut Rng::new(3)).expect("記録が手札と合う");
    assert!(slots.iter().all(|x| x.b == 5), "{slots:?}");
    for seed in 0..5 {
        let d = determinize_with(&s, viewer, &mut Rng::new(seed), false, true);
        for h in d.players[o].hand.iter() {
            assert_eq!(h.boosts, 5);
            if h.card == oni {
                assert_eq!(hand_cost(h), (base - 5).max(0));
            }
        }
        // 切ってあれば今までどおり 0 回
        let plain = determinize(&s, viewer, &mut Rng::new(seed), false);
        assert!(plain.players[o].hand.iter().all(|h| h.boosts == 0));
    }
    // 記録が手札と合わなければ（記録の無い局面等）かけ直さない
    s.players[o].hand_log = HandLog::default();
    assert!(replay_hand_slots(&s, o, &mut Rng::new(3)).is_none());
}

/// 変身した後の姿（宿題やるですぅ！ → 成長したですぅ！）を出したら、変身するだけの回数を受けた枠から出たとみなす
#[test]
fn transformed_card_comes_from_boosted_slot() {
    let mut s = after_mulligan();
    let viewer = s.active;
    let o = opponent(viewer);
    let grown = id("成長したですぅ！");
    let mut log = HandLog::default();
    log.push(HandEv::In { deck: 0 });
    log.push(HandEv::Boost { times: 5 });
    log.push(HandEv::In { deck: 0 });
    log.push(HandEv::Boost { times: 1 });
    let played = s.new_hand_card(grown, None);
    log.push(HandEv::out_of(
        &played,
        crate::state_json::card_shows_x(grown),
    ));
    let h = s.new_hand_card(grown, None);
    s.players[o].hand = vec![h].into();
    s.players[o].hand_log = log;
    for seed in 0..8 {
        let slots = replay_hand_slots(&s, o, &mut Rng::new(seed)).expect("記録が手札と合う");
        assert_eq!(slots, vec![HandSlot { b: 1, a: 0 }]);
    }
}
