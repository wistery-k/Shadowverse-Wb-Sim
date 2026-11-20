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
//!   （相手のターンの始めに決着したときは、最後のターンの出来事にする）
//! - 出来事の "at" は、その出来事を起こした行動の添字（リプレイで局面 at が行動の直前）
//! - 出来事（形は docs/kifu.md「出来事」）: 行動そのもの（play・attack・act・fuse・extraPp と、進化ポイントを使った evolve・superEvolve）、エンジンが打ち直しの間に残したこと
//!   （trace.rs。trigger・draw・addHand・damage・heal・destroy・banish・bounce）、前後の局面の違い（enter・leave・evolve・superEvolve・
//!   crestIn・crestOut・pp・maxPp）、ターンを終えたときの様子（turnEnd）。1 つの行動の中では、この順に並べる
//! - 最初のターンの前（始めから持っているクレストと、マリガンの間）に起きたことは "pre" に入れる
//! - 棋譜を数えるコマンド（`svwb kifu`。runner/kifu_cmd.rs）も、profile の仕組みの表も、開発サーバーのリプレイ検索も、この出来事の列を使う

use crate::data::{data, CardIdx, CardType, CrestIdx};
use crate::game::{
    acting_player, apply_legal, create_game, is_legal, legal_actions, play_as, play_cost,
    resolve_turn_end,
};
use crate::json::Json;
use crate::state::{card, Action, Evolve, GameState, Iid, OnBoard, Phase, PlayerIndex};
use crate::state_json::action_to_json;
use crate::trace::{self, Ev, Leave, Src};

fn num(x: impl Into<f64>) -> Json {
    Json::Num(x.into())
}

fn id(c: CardIdx) -> Json {
    Json::Str(card(c).id.clone())
}

fn obj(items: Vec<(&str, Json)>) -> Json {
    Json::Obj(items.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn crest_id(c: CrestIdx) -> Json {
    Json::Str(data().crests[c as usize].id.clone())
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
                let mut e = event("play", actor, at, h.card, *iid);
                let pl = &prev.players[actor];
                let c = card(h.card);
                // プレイの仕方: アクセラレート・結晶はプレイしたときの姿が違うもの、エンハンスはエンハンスのコストを払ったもの
                match play_as(h, pl.pp) {
                    Some(f) if f != h.card => {
                        e.set("as", id(f));
                        let mode = if card(f).ctype == CardType::Spell {
                            "accelerate"
                        } else {
                            "crystal"
                        };
                        e.set("mode", Json::Str(mode.into()));
                    }
                    _ if c.enhance.is_some_and(|x| play_cost(c, pl.pp, Some(h)) == x) => {
                        e.set("mode", Json::Str("enhance".into()))
                    }
                    _ => {}
                }
                // 【奥義】を持つカードを、奥義ゲージ 10 以上（1。奥義）・15 以上（2。解放奥義）でプレイした（効果が奥義の条件を見るかによらない）
                if c.ougi {
                    let gauge = pl.turn_count + h.ougi;
                    if gauge >= 15 {
                        e.set("ougi", num(2));
                    } else if gauge >= 10 {
                        e.set("ougi", num(1));
                    }
                }
                out.push(e);
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
        // 進化ポイント・超進化ポイントを使った進化（ep）。効果で進化したものは、場の違い（board_events）で ep を付けずに出す
        Action::Evolve(iid) | Action::SuperEvolve(iid) => {
            if let Some(c) = prev.board_card(*iid) {
                let kind = if matches!(a, Action::SuperEvolve(_)) {
                    "superEvolve"
                } else {
                    "evolve"
                };
                let mut e = event(kind, actor, at, c.card, *iid);
                e.set("ep", Json::Bool(true));
                out.push(e);
            }
        }
        _ => {}
    }
}

/// 行動 a で進化させたフォロワー（場の違いの進化は action_events が出したので、board_events では出さない）
fn evolved_by(a: &Action) -> Option<Iid> {
    match a {
        Action::Evolve(iid) | Action::SuperEvolve(iid) => Some(*iid),
        _ => None,
    }
}

/// prev から next までに場で起きたこと（場に出た・場から離れた・進化した。持ち主のプレイヤーの出来事にする）。
/// skip は行動で進化させたフォロワー（その進化は action_events が出した）
fn board_events(
    prev: &GameState,
    next: &GameState,
    at: usize,
    skip: Option<Iid>,
    out: &mut Vec<Json>,
) {
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
                Some(b)
                    if c.is_follower
                        && evolve_num(c.evolve) > evolve_num(b.evolve)
                        && skip != Some(c.iid) =>
                {
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

/// 打ち直しの間にエンジンが残したこと（trace.rs）を出来事にする。p は、誘発は能力を持つプレイヤー、引いた・手札に加えたは手札の持ち主、
/// ダメージ・回復・場を離れたは受けた側（カードの持ち主）
fn trace_events(evs: &[Ev], at: usize, out: &mut Vec<Json>) {
    let head = |k: &str, p: PlayerIndex| {
        obj(vec![
            ("k", Json::Str(k.into())),
            ("p", num(p as u32)),
            ("at", num(at as u32)),
        ])
    };
    let target = |e: &mut Json, c: Option<CardIdx>, i: Option<i32>| {
        e.set("c", c.map_or(Json::Str("leader".into()), id));
        if let Some(i) = i {
            e.set("i", num(i));
        }
    };
    for ev in evs {
        let e = match *ev {
            Ev::Trigger {
                p,
                src,
                iid,
                ability,
                own_turn,
            } => {
                let mut e = head("trigger", p);
                match src {
                    Src::Card(c) => e.set("c", id(c)),
                    Src::Crest(c) => {
                        e.set("c", crest_id(c));
                        e.set("crest", Json::Bool(true));
                    }
                }
                e.set("i", num(iid));
                // 能力の番号は 1 から（profile の表と同じ）。ほかのカードから得た能力は無い
                if let Some(a) = ability {
                    e.set("ab", num(a as u32 + 1));
                }
                e.set("own", Json::Bool(own_turn));
                e
            }
            Ev::Draw {
                p,
                card: c,
                filtered,
                burned,
            } => {
                let mut e = head("draw", p);
                e.set("c", id(c));
                if filtered {
                    e.set("search", Json::Bool(true));
                }
                if burned {
                    e.set("burned", Json::Bool(true));
                }
                e
            }
            Ev::AddHand { p, card: c, burned } => {
                let mut e = head("addHand", p);
                e.set("c", id(c));
                if burned {
                    e.set("burned", Json::Bool(true));
                }
                e
            }
            Ev::Damage {
                p,
                card: c,
                iid,
                amount,
            } => {
                let mut e = head("damage", p);
                target(&mut e, c, iid);
                e.set("n", num(amount));
                e
            }
            Ev::Heal {
                p,
                card: c,
                iid,
                amount,
            } => {
                let mut e = head("heal", p);
                target(&mut e, c, iid);
                e.set("n", num(amount));
                e
            }
            Ev::Left {
                p,
                card: c,
                iid,
                why,
            } => {
                let k = match why {
                    Leave::Destroy => "destroy",
                    Leave::Banish => "banish",
                    Leave::Bounce => "bounce",
                };
                let mut e = head(k, p);
                target(&mut e, Some(c), Some(iid));
                e
            }
        };
        out.push(e);
    }
}

/// prev から next までの、クレスト（信仰を含む）の出入りと PP・PP の最大値の増減（持ち主のプレイヤーの出来事にする）
fn side_events(prev: &GameState, next: &GameState, at: usize, out: &mut Vec<Json>) {
    for p in 0..2 {
        let (a, b) = (&prev.players[p], &next.players[p]);
        for c in a.crests.iter() {
            if !b.crests.iter().any(|x| x.iid == c.iid) {
                let mut e = obj(vec![
                    ("k", Json::Str("crestOut".into())),
                    ("p", num(p as u32)),
                    ("at", num(at as u32)),
                ]);
                e.set("c", crest_id(c.crest));
                e.set("i", num(c.iid));
                out.push(e);
            }
        }
        for c in b.crests.iter() {
            if !a.crests.iter().any(|x| x.iid == c.iid) {
                let mut e = obj(vec![
                    ("k", Json::Str("crestIn".into())),
                    ("p", num(p as u32)),
                    ("at", num(at as u32)),
                ]);
                e.set("c", crest_id(c.crest));
                e.set("i", num(c.iid));
                out.push(e);
            }
        }
        for (k, d) in [("pp", b.pp - a.pp), ("maxPp", b.max_pp - a.max_pp)] {
            if d != 0 {
                out.push(obj(vec![
                    ("k", Json::Str(k.into())),
                    ("p", num(p as u32)),
                    ("at", num(at as u32)),
                    ("n", num(d)),
                ]));
            }
        }
    }
}

/// ターンを終えたとき（ターン終了を選ぶ直前の局面 s）の様子: 残した PP と、手札からプレイできたカード（同じカードは 1 回）、
/// そのターンのコンボの数と、持っているクレスト（信仰を含む。2026-11-20、ダストデイズの調べ）
fn turn_end_event(s: &GameState, at: usize) -> Json {
    let p = acting_player(s);
    let pl = &s.players[p];
    let mut cards: Vec<CardIdx> = legal_actions(s)
        .iter()
        .filter_map(|a| match a {
            Action::Play(iid) => pl.hand.iter().find(|h| h.iid == *iid).map(|h| h.card),
            _ => None,
        })
        .collect();
    cards.sort_unstable();
    cards.dedup();
    obj(vec![
        ("k", Json::Str("turnEnd".into())),
        ("p", num(p as u32)),
        ("at", num(at as u32)),
        ("pp", num(pl.pp)),
        ("playable", Json::Arr(cards.into_iter().map(id).collect())),
        ("combo", num(pl.combo)),
        (
            "crests",
            Json::Arr(pl.crests.iter().map(|c| crest_id(c.crest)).collect()),
        ),
    ])
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
    // 最初のターンの前に起きたこと: 始めから持っているクレスト（デッキに入れると置かれる信仰）と、マリガンの間に起きたこと
    let mut pre: Vec<Json> = Vec::new();
    for (p, pl) in s.players.iter().enumerate() {
        for c in pl.crests.iter() {
            let mut e = obj(vec![
                ("k", Json::Str("crestIn".into())),
                ("p", num(p as u32)),
                ("at", num(0)),
            ]);
            e.set("c", crest_id(c.crest));
            e.set("i", num(c.iid));
            pre.push(e);
        }
    }
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
        trace::start();
        let next = apply_legal(&s, a);
        let traced = trace::take();
        if let Some(t) = cur.as_mut() {
            let turn_end = matches!(a, Action::EndTurn) && s.pending.is_none();
            if turn_end {
                // ターン終了時の能力までをこのターンに、相手のターンの始めの出来事を次のターンにする。
                // エンジンが残したことは、ターン終了時の処理だけを打ったときの分（apply_legal の初めの同じ並び）で分ける
                t.events.push(turn_end_event(&s, i));
                trace::start();
                let mid = resolve_turn_end(&s);
                let n_mid = trace::take().len().min(traced.len());
                let mid = mid.as_ref().unwrap_or(&s);
                let (this, rest) = traced.split_at(n_mid);
                trace_events(this, i, &mut t.events);
                board_events(&s, mid, i, None, &mut t.events);
                side_events(&s, mid, i, &mut t.events);
                t.end = Some(snapshot(if next.phase == Phase::Ended {
                    &next
                } else {
                    mid
                }));
                t.end_step = i + 1;
                let to = if next.turn != t.n {
                    &mut carry
                } else {
                    &mut t.events
                };
                trace_events(rest, i, to);
                board_events(mid, &next, i, None, to);
                side_events(mid, &next, i, to);
            } else {
                step_events(&s, &next, a, i, &traced, &mut t.events);
                if t.end.is_some() {
                    // ターン終了時の能力の選択など、ターン終了の後に同じターンの行動が続いた
                    t.end = Some(snapshot(&next));
                    t.end_step = i + 1;
                }
            }
        } else {
            // 最初のターンの前（マリガン）
            step_events(&s, &next, a, i, &traced, &mut pre);
        }
        s = next;
    }
    if let Some(mut t) = cur.take() {
        // 相手のターンの始めに決着した（山札が無くて引けなかった 等）ときの出来事は、最後のターンに入れる
        t.events.append(&mut carry);
        turns.push(t.finish(&s, actions.len()));
    }
    Ok(obj(vec![
        ("first", num(s.first as u32)),
        ("winner", s.winner.map_or(Json::Null, |w| num(w as u32))),
        ("ended", Json::Bool(s.phase == Phase::Ended)),
        ("steps", num(actions.len() as u32)),
        ("pre", Json::Arr(pre)),
        ("turns", Json::Arr(turns)),
    ]))
}

/// ターン終了でない行動 a（局面 s から next）の出来事を、行動・エンジンが残したこと・局面の違いの順に out に足す
fn step_events(
    s: &GameState,
    next: &GameState,
    a: &Action,
    at: usize,
    traced: &[Ev],
    out: &mut Vec<Json>,
) {
    action_events(s, a, at, out);
    trace_events(traced, at, out);
    board_events(s, next, at, evolved_by(a), out);
    side_events(s, next, at, out);
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

    /// 進化ポイント・超進化ポイントを使った進化（ep）は、進化・超進化の行動と同じ数で、同じフォロワー
    #[test]
    fn evolves_with_points_match_the_actions() {
        let mut seen = 0;
        for seed in 1..8 {
            let (a, b, actions) = random_game(seed);
            let idx = replay_index([&a, &b], seed, &actions).expect("打ち直せる");
            let mut got: Vec<(String, f64, f64)> = Vec::new();
            for t in arr(idx.get("turns").unwrap()) {
                for e in arr(t.get("ev").unwrap()) {
                    if e.get("ep") == Some(&Json::Bool(true)) {
                        let k = match e.get("k") {
                            Some(Json::Str(k)) => k.clone(),
                            _ => panic!("k が無い"),
                        };
                        got.push((k, n(e, "at"), n(e, "i")));
                    }
                }
            }
            let expected: Vec<(String, f64, f64)> = actions
                .iter()
                .enumerate()
                .filter_map(|(at, x)| match x {
                    Action::Evolve(i) => Some(("evolve".to_string(), at as f64, *i as f64)),
                    Action::SuperEvolve(i) => {
                        Some(("superEvolve".to_string(), at as f64, *i as f64))
                    }
                    _ => None,
                })
                .collect();
            assert_eq!(got, expected, "seed {seed}");
            seen += got.len();
        }
        assert!(seen > 0, "進化した試合がありません");
    }

    /// ターン終了の出来事は、ターン終了時の処理だけを打った分（resolve_turn_end）が、ターン終了を打った分（apply_legal）の初めと同じ並び
    #[test]
    fn turn_end_trace_is_a_prefix() {
        let mut ends = 0;
        for seed in 1..8 {
            let (a, b, actions) = random_game(seed);
            let mut s = create_game([&a, &b], seed);
            for act in &actions {
                if matches!(act, Action::EndTurn) && s.pending.is_none() {
                    trace::start();
                    let _ = resolve_turn_end(&s);
                    let mid = trace::take();
                    trace::start();
                    let _ = apply_legal(&s, act);
                    let all = trace::take();
                    assert!(all.len() >= mid.len());
                    assert_eq!(&all[..mid.len()], &mid[..]);
                    ends += 1;
                }
                s = apply_legal(&s, act);
            }
        }
        assert!(ends > 50);
    }

    /// リーダーへのダメージと回復の出来事を足すと、試合の初めと終わりの体力の差になる。引いたカードは山札の減りと合う
    #[test]
    fn damage_heal_and_draws_add_up() {
        let mut draws_seen = 0;
        for seed in 1..8 {
            let (a, b, actions) = random_game(seed);
            let idx = replay_index([&a, &b], seed, &actions).expect("打ち直せる");
            let turns = arr(idx.get("turns").unwrap());
            for p in 0..2 {
                let side = |t: &Json, k: &str| arr(t.get(k).unwrap())[p].clone();
                let hp0 = n(&side(&turns[0], "start"), "hp");
                let hp1 = n(&side(turns.last().unwrap(), "end"), "hp");
                let deck0 = n(&side(&turns[0], "start"), "deck");
                let deck1 = n(&side(turns.last().unwrap(), "end"), "deck");
                let mut dmg = 0.0;
                let mut heal = 0.0;
                let mut drawn = 0.0;
                for t in turns {
                    for e in arr(t.get("ev").unwrap()) {
                        if n(e, "p") != p as f64 {
                            continue;
                        }
                        let k = e.get("k").unwrap();
                        let leader = e.get("c") == Some(&Json::Str("leader".into()));
                        if *k == Json::Str("damage".into()) && leader {
                            dmg += n(e, "n");
                        } else if *k == Json::Str("heal".into()) && leader {
                            heal += n(e, "n");
                        } else if *k == Json::Str("draw".into()) {
                            drawn += 1.0;
                        }
                    }
                }
                assert_eq!(hp0 - dmg + heal, hp1, "seed {seed} 席 {p}");
                // 山札から手札に引いた以外で山札が減ることもある（直接召喚など）ので、引いた数は減った数以下
                assert!(
                    drawn <= deck0 - deck1 + 1e-9,
                    "seed {seed} 席 {p}: {drawn} > {deck0} - {deck1}"
                );
                draws_seen += drawn as u32;
            }
        }
        assert!(draws_seen > 50);
    }

    #[test]
    fn illegal_action_is_an_error() {
        let (a, b, mut actions) = random_game(3);
        actions.insert(5, Action::Play(999_999));
        let err = replay_index([&a, &b], 3, &actions).unwrap_err();
        assert!(err.starts_with("5 手目"), "{err}");
    }
}
