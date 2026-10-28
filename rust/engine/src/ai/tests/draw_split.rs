//! 引く手の直前で区切って引きを作り直す（SearchOptions.drawSplit。docs/ai-notes.md「引く手の直前で区切って引きを作り直す」）

use super::*;
use crate::ai::search::{
    first_chance_step, is_chance_step, stratify_top, DrawSplit, SearchAgent, SearchOptions,
};

/// スペルウィッチ（0）の turn ターン目。場と手札は空、相手は体力 20 で場も空
fn position(turn: i32) -> GameState {
    let s = new_game(deck("スペルウィッチ"), deck_at(1), 1);
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

fn split_options() -> SearchOptions {
    SearchOptions {
        draw_split: Some(DrawSplit {
            samples: 4,
            beam_width: 32,
            max_depth: 8,
            root_draws: 2,
            stratify: false,
            enumerate: false,
        }),
        ..SearchOptions::default()
    }
}

fn iid_of(s: &GameState, name: &str) -> Iid {
    s.players[0]
        .hand
        .iter()
        .find(|h| h.card == id(name))
        .unwrap_or_else(|| panic!("手札に {name} がありません"))
        .iid
}

#[test]
fn chance_steps_are_draws_and_random() {
    let mut s = position(3);
    s.players[0].pp = 2;
    s.players[0].hand = hand_cards(&mut s, &["ゴブリン", "知恵の輝き"]).into();
    let goblin = Action::Play(iid_of(&s, "ゴブリン"));
    let wisdom = Action::Play(iid_of(&s, "知恵の輝き"));
    // カードを引く手は区切る手、乱数を使わずに場に出すだけの手は区切らない
    let after_goblin = apply(&s, &goblin);
    let after_wisdom = apply(&after_goblin, &wisdom);
    assert!(!is_chance_step(&s, &after_goblin, 0));
    assert!(is_chance_step(&after_goblin, &after_wisdom, 0));
    let steps = vec![
        (goblin, std::rc::Rc::new(after_goblin)),
        (wisdom, std::rc::Rc::new(after_wisdom)),
    ];
    assert_eq!(first_chance_step(&s, &steps, 0), Some(1));
    assert_eq!(first_chance_step(&s, &steps[..1], 0), None);
}

#[test]
fn split_plan_stops_at_the_draw() {
    // 知恵の輝きを含む並びは、知恵の輝きまでで区切る（その先は引いたカードを見て考え直す）。
    // 今打てる引く手（知恵の輝きから）は、ターン末の点数で上位に無くても読み直す
    let mut s = position(3);
    s.players[0].pp = 2;
    s.players[0].hand = hand_cards(&mut s, &["ゴブリン", "知恵の輝き"]).into();
    let wisdom = Action::Play(iid_of(&s, "知恵の輝き"));
    let legal = legal_actions(&s);
    let agent = SearchAgent::new(split_options());
    let thought = agent
        .think_with(&s, &legal, &mut Rng::new(3), Some(None))
        .expect("考え");
    let first = thought
        .candidates
        .iter()
        .find(|c| c.action == wisdom)
        .expect("知恵の輝きから");
    assert!(first.read.is_some(), "知恵の輝きからを読み直していない");
    assert_eq!(first.steps, vec![wisdom.clone()]);
    for c in &thought.candidates {
        if c.read.is_none() {
            continue;
        }
        if let Some(k) = c.steps.iter().position(|a| *a == wisdom) {
            assert_eq!(
                k + 1,
                c.steps.len(),
                "引いた後の手が残っている: {:?}",
                c.steps
            );
        }
    }
}

#[test]
fn split_value_does_not_depend_on_the_drawn_card() {
    // 決定化で山札の上に来たカードが違っても（山札の中身は同じ）、知恵の輝きから打つ手の点数は同じ
    let mut s = position(3);
    s.players[0].pp = 1;
    s.players[0].hand = hand_cards(&mut s, &["知恵の輝き"]).into();
    let mut t = s.clone();
    t.players[0].deck.make_mut().reverse();
    assert_ne!(s.players[0].deck, t.players[0].deck);
    let wisdom = Action::Play(iid_of(&s, "知恵の輝き"));
    let value = |opts: SearchOptions, x: &GameState| -> f64 {
        let legal = legal_actions(x);
        SearchAgent::new(opts)
            .think_with(x, &legal, &mut Rng::new(5), Some(None))
            .expect("考え")
            .candidates
            .iter()
            .find(|c| c.action == wisdom)
            .and_then(|c| c.value)
            .expect("知恵の輝きの点数")
    };
    assert_eq!(value(split_options(), &s), value(split_options(), &t));
    // 一番上のカードを種類ごとに全部試すときも同じ
    let mut o = split_options();
    if let Some(ds) = o.draw_split.as_mut() {
        ds.enumerate = true;
    }
    assert_eq!(value(o.clone(), &s), value(o, &t));
}

#[test]
fn stratified_top_covers_each_card_once() {
    // 位置 x を山札の枚数で等間隔に動かすと、どのカードもちょうど 1 回ずつ一番上に来る（層別に選んでも、1 枚ごとの一番上に来る確率は同じ）。
    // 一番上に置く以外は山札を動かさない
    let s = position(3);
    let n = s.players[0].deck.len();
    assert!(n >= 2);
    let mut tops: Vec<Iid> = Vec::new();
    for i in 0..n {
        let mut t = s.clone();
        stratify_top(&mut t, 0, (i as f64 + 0.5) / n as f64);
        let deck = &t.players[0].deck;
        assert_eq!(deck.len(), n);
        let rest: Vec<Iid> = deck.iter().skip(1).map(|r| r.iid).collect();
        let orig: Vec<Iid> = s.players[0]
            .deck
            .iter()
            .map(|r| r.iid)
            .filter(|x| *x != deck[0].iid)
            .collect();
        assert_eq!(rest, orig);
        tops.push(deck[0].iid);
    }
    tops.sort();
    tops.dedup();
    assert_eq!(tops.len(), n);
}
