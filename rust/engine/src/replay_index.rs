//! リプレイ検索（開発サーバーの「リプレイ検索」タブ。src/replays）のための、試合のターンごとのまとめ。
//!
//! 記録した試合（デッキ・シード・行動の列）を打ち直し、ターンごとに、始めと終わりの両者の様子（体力・PP・手札・場など）と、
//! そのターンに起きたこと（プレイ・進化・攻撃・場に出た／場から離れたカードなど）を JSON にする。
//! 形は src/replays/types.ts の GameIndex と同じ（変えたら両方を直す）。
//!
//! - ターンの始め: そのターンで最初に行動する直前の局面（ドローとターン開始時の能力の後）
//! - ターンの終わり: ターン終了を選んだ局面で、ターン終了時の能力だけを解決した局面（相手のターンには進めない）。
//!   決着したターンは決着した局面
//! - ターン終了の後、相手のターンの始めに起きたこと（ドロー・ターン開始時の能力で場に出た・離れたカード）は、相手のターンの出来事にする
//! - 出来事の "at" は、その出来事を起こした行動の添字（リプレイで局面 at が行動の直前）

use crate::data::CardIdx;
use crate::game::{acting_player, apply_legal, create_game, is_legal, resolve_turn_end};
use crate::json::Json;
use crate::state::{card, Action, Evolve, GameState, OnBoard, Phase, PlayerIndex};
use crate::state_json::action_to_json;

fn num(x: impl Into<f64>) -> Json {
    Json::Num(x.into())
}

fn id(c: CardIdx) -> Json {
    Json::Str(card(c).id.clone())
}

fn obj(items: Vec<(&str, Json)>) -> Json {
    Json::Obj(items.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn evolve_num(e: Evolve) -> i32 {
    match e {
        Evolve::None => 0,
        Evolve::Evolved => 1,
        Evolve::SuperEvolved => 2,
    }
}

/// 場のカード。フォロワーは攻撃力・体力・進化（0: なし、1: 進化、2: 超進化）、アミュレットはカウントダウン
fn board_json(c: &OnBoard) -> Json {
    if c.is_follower {
        obj(vec![
            ("c", id(c.card)),
            ("i", num(c.iid)),
            ("a", num(c.attack_value())),
            ("d", num(c.defense)),
            ("e", num(evolve_num(c.evolve))),
        ])
    } else {
        obj(vec![
            ("c", id(c.card)),
            ("i", num(c.iid)),
            ("cd", c.countdown.map_or(Json::Null, num)),
        ])
    }
}

/// プレイヤー p の様子
fn side_json(s: &GameState, p: PlayerIndex) -> Json {
    let pl = &s.players[p];
    obj(vec![
        ("hp", num(pl.leader_hp)),
        ("maxHp", num(pl.leader_max_hp)),
        ("maxPp", num(pl.max_pp)),
        ("pp", num(pl.pp)),
        ("ep", num(pl.ep)),
        ("sep", num(pl.sep)),
        ("xpp", Json::Bool(pl.extra_pp_available)),
        ("deck", num(pl.deck.len() as u32)),
        ("grave", num(pl.graveyard)),
        (
            "hand",
            Json::Arr(pl.hand.iter().map(|h| id(h.card)).collect()),
        ),
        (
            "board",
            Json::Arr(pl.board.iter().map(board_json).collect()),
        ),
    ])
}

fn snapshot(s: &GameState) -> Json {
    Json::Arr(vec![side_json(s, 0), side_json(s, 1)])
}

fn event(kind: &str, p: PlayerIndex, at: usize, c: CardIdx, iid: i32) -> Json {
    obj(vec![
        ("k", Json::Str(kind.into())),
        ("p", num(p as u32)),
        ("at", num(at as u32)),
        ("c", id(c)),
        ("i", num(iid)),
    ])
}

/// 行動 a（添字 at）そのものの出来事（プレイ・攻撃・アクト・融合・エクストラPP）
fn action_events(prev: &GameState, a: &Action, at: usize, out: &mut Vec<Json>) {
    let actor = acting_player(prev);
    match a {
        Action::Play(iid) => {
            if let Some(h) = prev.hand_card(*iid) {
                out.push(event("play", actor, at, h.card, *iid));
            }
        }
        Action::Attack { attacker, target } => {
            if let Some(c) = prev.board_card(*attacker) {
                let mut e = event("attack", actor, at, c.card, *attacker);
                match target.and_then(|t| prev.board_card(t)) {
                    Some(t) => {
                        e.set("t", id(t.card));
                        e.set("ti", num(t.iid));
                    }
                    None => e.set("t", Json::Str("leader".into())),
                }
                out.push(e);
            }
        }
        Action::Act(iid) => {
            if let Some(c) = prev.board_card(*iid) {
                out.push(event("act", actor, at, c.card, *iid));
            }
        }
        Action::Fuse { host, materials } => {
            if let Some(h) = prev.hand_card(*host) {
                let mut e = event("fuse", actor, at, h.card, *host);
                e.set(
                    "m",
                    Json::Arr(
                        materials
                            .iter()
                            .filter_map(|m| prev.hand_card(*m).map(|x| id(x.card)))
                            .collect(),
                    ),
                );
                out.push(e);
            }
        }
        Action::ExtraPp => out.push(obj(vec![
            ("k", Json::Str("extraPp".into())),
            ("p", num(actor as u32)),
            ("at", num(at as u32)),
        ])),
        _ => {}
    }
}

/// prev から next までに場で起きたこと（場に出た・場から離れた・進化した。持ち主のプレイヤーの出来事にする）
fn board_events(prev: &GameState, next: &GameState, at: usize, out: &mut Vec<Json>) {
    for p in 0..2 {
        let before = &prev.players[p].board;
        let after = &next.players[p].board;
        for c in before.iter() {
            if !after.iter().any(|x| x.iid == c.iid) {
                out.push(event("leave", p, at, c.card, c.iid));
            }
        }
        for c in after.iter() {
            match before.iter().find(|x| x.iid == c.iid) {
                None => out.push(event("enter", p, at, c.card, c.iid)),
                Some(b) if c.is_follower && evolve_num(c.evolve) > evolve_num(b.evolve) => {
                    let kind = if c.evolve == Evolve::SuperEvolved {
                        "superEvolve"
                    } else {
                        "evolve"
                    };
                    out.push(event(kind, p, at, c.card, c.iid));
                }
                Some(_) => {}
            }
        }
    }
}

/// 作りかけのターン
struct Turn {
    n: i32,
    p: PlayerIndex,
    tc: i32,
    start_step: usize,
    start: Json,
    end_step: usize,
    end: Option<Json>,
    events: Vec<Json>,
}

impl Turn {
    fn finish(self, last: &GameState, steps: usize) -> Json {
        let (end_step, end) = match self.end {
            Some(e) => (self.end_step, e),
            None => (steps, snapshot(last)),
        };
        obj(vec![
            ("n", num(self.n)),
            ("p", num(self.p as u32)),
            ("tc", num(self.tc)),
            ("s", num(self.start_step as u32)),
            ("e", num(end_step as u32)),
            ("start", self.start),
            ("end", end),
            ("ev", Json::Arr(self.events)),
        ])
    }
}

/// 試合を打ち直して、ターンごとのまとめを作る。打てない行動があれば（エンジンの版が違う等）その添字を書いたエラー
pub fn replay_index(decks: [&[CardIdx]; 2], seed: u32, actions: &[Action]) -> Result<Json, String> {
    let mut s = create_game(decks, seed);
    let mut turns: Vec<Json> = Vec::new();
    let mut cur: Option<Turn> = None;
    // ターン終了の後、相手のターンの始めに起きたこと（次のターンの出来事にする）
    let mut carry: Vec<Json> = Vec::new();
    for (i, a) in actions.iter().enumerate() {
        if s.phase == Phase::Ended {
            return Err(format!(
                "{i} 手目: 決着した後にも行動があります（全 {} 手）",
                actions.len()
            ));
        }
        if !is_legal(&s, a) {
            return Err(format!(
                "{i} 手目の {} が打てません（記録したときとエンジンの版が違う可能性があります）",
                action_to_json(a).stringify()
            ));
        }
        if s.phase == Phase::Main && cur.as_ref().is_none_or(|t| t.n != s.turn) {
            if let Some(t) = cur.take() {
                turns.push(t.finish(&s, i));
            }
            cur = Some(Turn {
                n: s.turn,
                p: s.active,
                tc: s.players[s.active].turn_count,
                start_step: i,
                start: snapshot(&s),
                end_step: i,
                end: None,
                events: std::mem::take(&mut carry),
            });
        }
        let next = apply_legal(&s, a);
        if let Some(t) = cur.as_mut() {
            let turn_end = matches!(a, Action::EndTurn) && s.pending.is_none();
            if turn_end {
                // ターン終了時の能力までをこのターンに、相手のターンの始めの出来事を次のターンにする
                let mid = resolve_turn_end(&s);
                let mid = mid.as_ref().unwrap_or(&s);
                board_events(&s, mid, i, &mut t.events);
                t.end = Some(snapshot(if next.phase == Phase::Ended {
                    &next
                } else {
                    mid
                }));
                t.end_step = i + 1;
                if next.turn != t.n {
                    board_events(mid, &next, i, &mut carry);
                } else {
                    board_events(mid, &next, i, &mut t.events);
                }
            } else {
                action_events(&s, a, i, &mut t.events);
                board_events(&s, &next, i, &mut t.events);
                if t.end.is_some() {
                    // ターン終了時の能力の選択など、ターン終了の後に同じターンの行動が続いた
                    t.end = Some(snapshot(&next));
                    t.end_step = i + 1;
                }
            }
        }
        s = next;
    }
    if let Some(t) = cur.take() {
        turns.push(t.finish(&s, actions.len()));
    }
    Ok(obj(vec![
        ("first", num(s.first as u32)),
        ("winner", s.winner.map_or(Json::Null, |w| num(w as u32))),
        ("ended", Json::Bool(s.phase == Phase::Ended)),
        ("steps", num(actions.len() as u32)),
        ("turns", Json::Arr(turns)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{Agent, RandomAgent, Rng};
    use crate::data::data;
    use crate::game::legal_actions;

    /// ランダムな手で 1 試合打った行動の列
    fn random_game(seed: u32) -> (Vec<CardIdx>, Vec<CardIdx>, Vec<Action>) {
        let decks = &data().decks;
        let (a, b) = (decks[0].cards.clone(), decks[1].cards.clone());
        let mut s = create_game([&a, &b], seed);
        let mut agent = RandomAgent;
        let mut rng = Rng::new(seed);
        let mut actions = Vec::new();
        while s.phase != Phase::Ended && actions.len() < 3000 {
            let legal = legal_actions(&s);
            let act = agent.choose_action(&s, &legal, &mut rng);
            s = apply_legal(&s, &act);
            actions.push(act);
        }
        (a, b, actions)
    }

    fn arr(v: &Json) -> &[Json] {
        match v {
            Json::Arr(x) => x,
            _ => panic!("配列ではありません: {}", v.stringify()),
        }
    }

    fn n(v: &Json, k: &str) -> f64 {
        match v.get(k) {
            Some(Json::Num(x)) => *x,
            x => panic!("{k} が数ではありません: {x:?}"),
        }
    }

    #[test]
    fn turns_cover_the_game_in_order() {
        for seed in 1..6 {
            let (a, b, actions) = random_game(seed);
            let idx = replay_index([&a, &b], seed, &actions).expect("打ち直せる");
            let turns = arr(idx.get("turns").unwrap());
            assert!(!turns.is_empty());
            let mut prev_end = 0.0;
            for (k, t) in turns.iter().enumerate() {
                // ターン番号は 1 から順に、手番は交互
                assert_eq!(n(t, "n"), (k + 1) as f64);
                assert!(n(t, "s") >= prev_end, "ターンが重なっています");
                assert!(n(t, "e") > n(t, "s"));
                prev_end = n(t, "e");
                assert_eq!(arr(t.get("start").unwrap()).len(), 2);
                assert_eq!(arr(t.get("end").unwrap()).len(), 2);
                if k > 0 {
                    assert_ne!(n(t, "p"), n(&turns[k - 1], "p"));
                }
                // 出来事の添字はそのターンの中か、ターンの始めの出来事なら前のターンの最後の行動
                for e in arr(t.get("ev").unwrap()) {
                    let at = n(e, "at");
                    assert!(at < n(t, "e"), "出来事がターンの後にあります");
                }
            }
            assert_eq!(n(turns.last().unwrap(), "e"), actions.len() as f64);
            assert_eq!(idx.get("ended"), Some(&Json::Bool(true)));
        }
    }

    #[test]
    fn plays_match_the_actions() {
        let (a, b, actions) = random_game(11);
        let idx = replay_index([&a, &b], 11, &actions).expect("打ち直せる");
        let plays: usize = arr(idx.get("turns").unwrap())
            .iter()
            .flat_map(|t| arr(t.get("ev").unwrap()))
            .filter(|e| e.get("k") == Some(&Json::Str("play".into())))
            .count();
        let expected = actions
            .iter()
            .filter(|x| matches!(x, Action::Play(_)))
            .count();
        assert_eq!(plays, expected);
    }

    #[test]
    fn illegal_action_is_an_error() {
        let (a, b, mut actions) = random_game(3);
        actions.insert(5, Action::Play(999_999));
        let err = replay_index([&a, &b], 3, &actions).unwrap_err();
        assert!(err.starts_with("5 手目"), "{err}");
    }
}
