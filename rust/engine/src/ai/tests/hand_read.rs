//! 持っていればリーサルだったカードを、相手の手札の読みから外す（lethalRead。ai/hand_read.rs）

use super::*;
use crate::ai::determinize::{determinize, determinize_read};
use crate::ai::hand_read::{HandReading, OppHandTracker};
use crate::ai::search::{SearchAgent, SearchOptions};

const ALBERT: &str = "レヴィオンの迅雷・アルベール";
const CENTAUR: &str = "ケンタウロスの騎士";

fn lethal_read_agent() -> SearchAgent {
    SearchAgent::new(SearchOptions {
        lethal_read: true,
        ..SearchOptions::default()
    })
}

/// アマリアロイヤル（席 0）の、マリガンの後の最初のターンの始め。agent があれば席 1 のマリガンを選ばせる（lethalRead に席を覚えさせる）。
/// 相手（席 1）の体力 3・場は空、席 0 の PP は 5
fn royal_turn_start(agent: Option<&mut SearchAgent>) -> GameState {
    let mut s = new_game(deck("アマリアロイヤル"), deck("疾走ドラゴン"), 5);
    let mut agent = agent;
    while s.phase == Phase::Mulligan {
        let p = acting_player(&s);
        let legal = legal_actions(&s);
        let a = match (&mut agent, p) {
            (Some(ag), 1) => ag.choose_action(&s, &legal, &mut Rng::new(1)),
            _ => Action::Mulligan {
                player: p,
                swap: vec![],
            },
        };
        s = apply(&s, &a);
    }
    if s.active != 0 {
        s = apply(&s, &Action::EndTurn);
    }
    assert_eq!((s.active, s.phase), (0, Phase::Main));
    assert!(s.pending.is_none());
    assert!(s.players[0].board.is_empty() && s.players[1].board.is_empty());
    s.players[1].leader_hp = 3;
    s.players[0].max_pp = 5;
    s.players[0].pp = 5;
    s
}

#[test]
fn finds_cards_that_would_have_been_lethal() {
    let s = royal_turn_start(None);
    let ag = SearchAgent::new(SearchOptions::default());
    let threats = ag.opp_lethal_threats(&s, 1);
    // 疾走 3 点のアルベール（5 コスト）なら体力 3 を倒せる。ケンタウロスの騎士は 8 コストで出せない
    assert!(threats.contains(&id(ALBERT)), "{threats:?}");
    assert!(!threats.contains(&id(CENTAUR)), "{threats:?}");
    // 体力が多ければ無い
    let mut t = s.clone();
    t.players[1].leader_hp = 20;
    assert!(ag.opp_lethal_threats(&t, 1).is_empty());
}

#[test]
fn determinize_read_without_reading_is_the_same() {
    let s = royal_turn_start(None);
    for seed in 0..5 {
        assert_eq!(
            canon(&determinize_read(&s, 1, &mut Rng::new(seed), false, None)),
            canon(&determinize(&s, 1, &mut Rng::new(seed), false))
        );
    }
}

#[test]
fn determinize_read_keeps_excluded_cards_out_of_the_slots() {
    let s = royal_turn_start(None);
    let albert = id(ALBERT);
    let hidden: Vec<Iid> = s.players[0].hand.iter().map(|h| h.iid).collect();
    assert!(hidden.len() >= 4);
    // 前の 3 枠だけアルベールを外す
    let reading = HandReading {
        excluded: hidden[..3].iter().map(|&i| (i, vec![albert])).collect(),
    };
    let pool = |st: &GameState| {
        let pl = &st.players[0];
        let mut v: Vec<CardIdx> = pl
            .hand
            .iter()
            .map(|h| h.card)
            .chain(pl.deck.iter().map(|r| r.card))
            .collect();
        v.sort();
        v
    };
    let mut free_albert = 0;
    for seed in 0..300 {
        let d = determinize_read(&s, 1, &mut Rng::new(seed), false, Some(&reading));
        assert_eq!(pool(&d), pool(&s));
        for h in d.players[0].hand.iter() {
            if h.card == albert {
                assert!(
                    !hidden[..3].contains(&h.iid),
                    "外した枠にアルベール（seed {seed}）"
                );
                free_albert += 1;
            }
        }
    }
    // 外していない枠には配られる
    assert!(free_albert > 0);
}

#[test]
fn tracker_drops_the_oldest_slots_when_hidden_cards_leave() {
    let s = royal_turn_start(None);
    let albert = id(ALBERT);
    let mut tr = OppHandTracker::default();
    tr.observe(&s, 1, |_| vec![albert]);
    let n = s.players[0].hand.len();
    let rd = tr.reading(&s, 1).expect("読み");
    assert_eq!(rd.excluded.len(), n);
    assert!(rd.excluded.iter().all(|(_, e)| e == &vec![albert]));
    // 同じターンにもう一度見ても調べ直さない
    tr.observe(&s, 1, |_| panic!("同じターンに調べ直した"));
    // 伏せたカードを 1 枚出し（どれを出したかは分からない）、1 枚引く
    let mut t = s.clone();
    let last = t.players[0].hand.len() - 1;
    t.players[0].hand.make_mut().remove(last);
    let h = t.new_hand_card(id(CENTAUR), None);
    let new_iid = h.iid;
    t.players[0].hand.make_mut().push(h);
    tr.observe(&t, 1, |_| panic!("同じターンに調べ直した"));
    let rd = tr.reading(&t, 1).expect("読み");
    // 外せるのは n - 1 枠（出たのは古い枠だったものとして数える）。引いたカードの枠は外さない
    assert_eq!(rd.excluded.len(), n - 1);
    assert!(rd.excluded.iter().all(|&(i, _)| i != new_iid));
}

#[test]
fn search_agent_reads_the_opponent_turn_through_observe() {
    let mut agent = lethal_read_agent();
    let s = royal_turn_start(Some(&mut agent));
    let albert = id(ALBERT);
    let opp_hidden: Vec<Iid> = s.players[0].hand.iter().map(|h| h.iid).collect();
    // 相手（席 0）のターンの始めを見せる。アルベールを出さずにターンを終えたので、そのとき手札にあったカードはアルベールではない
    agent.observe(&s);
    let t = apply(&s, &Action::EndTurn);
    assert_eq!(t.active, 1);
    let legal = legal_actions(&t);
    agent.choose_action(&t, &legal, &mut Rng::new(2));
    let rd = agent.opts.hand_reading.clone().expect("読み");
    assert_eq!(rd.excluded.len(), opp_hidden.len());
    for (i, e) in &rd.excluded {
        assert!(opp_hidden.contains(i));
        assert!(e.contains(&albert));
    }
    // lethalRead でない AI は読まない
    let mut plain = SearchAgent::new(SearchOptions::default());
    plain.observe(&s);
    plain.choose_action(&t, &legal, &mut Rng::new(2));
    assert!(plain.opts.hand_reading.is_none());
}
