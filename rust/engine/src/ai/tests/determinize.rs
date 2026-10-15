//! determinization（tests/ai.test.ts の「determinization」）

use super::*;
use crate::ai::determinize::determinize;
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
    let h = s.new_hand_card(fairy, None);
    s.players[opp].hand.push(h);
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
    assert_eq!(player_part(&d, viewer, "hand"), player_part(&s, viewer, "hand"));
    assert_eq!(player_part(&d, viewer, "board"), player_part(&s, viewer, "board"));
    assert_eq!(deck_cards(&d), deck_cards(&s));
    let iids = |st: &GameState| st.players[opp].hand.iter().map(|h| h.iid).collect::<Vec<_>>();
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
        hand[0].revealed = true;
        hand[1].drawn_by = Some(DrawHint {
            filter: spell,
            cost_eq: None,
        });
        hand[2].drawn_by = Some(DrawHint {
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
