//! 人間の対戦記録の各ターンで、人間の手順と今の AI の手順を、同じ局面から最後まで打たせて比べる
//! （TypeScript 版 scripts/human-plan-value-main.ts の移植。2026-10-22）。
//!
//!   svwb human-plan-value --out 結果.jsonl [--m 32] [--turns 0-30] [--games 0-11] <人間の記録.jsonl>...
//!   svwb human-plan-value report 結果.jsonl... [--top 30]
//!
//! 人間と AI の勝率の差が、どのターンのどの選択から、どの段階の判断（ビームが届かない・ターン末の点数・相手のターンを読んだ後の点数）から
//! 来ているかを調べる（docs/ai-notes.md「人間の手順と AI の手順を打ち比べる」）。人間の記録（web の「人間との比較」の書き出し）を再生し、
//! 人間の自分のターンの最初の局面ごとに、(1) 人間が実際に打ったターン末、(2) 同じ局面から比べるデッキの既定の AI
//! （リノセウスエルフはリノセウス用 AI、他は探索 AI）が打つターン末、を作る。それぞれのターンを終え、同じ M 個のシードで
//! 人間側から見た決定化をしてから、今の AI どうし（比べるデッキは既定の AI、相手は今の探索 AI）に最後まで打たせて勝率を比べる。
//! マリガンも 0 ターン目として比べる（同じ決定化の後に、人間の返し方と AI の返し方をそれぞれ打つ）。
//! 人間の手順と AI の手順が同じ局面になったターンは打たない。
//!
//! あわせて、今の探索 AI の点数で両方のターン末を採点する（`SearchAgent::turn_end_value`・`read_value`）。
//! リノセウスエルフでも探索 AI の点数で採点する（リノセウス用 AI が足す評価は入らない）。
//! 続きは AI が打つので、次のターン以降に向けた人間の狙いは低めに出る（下限）。
//!
//! 出力は 1 局面 1 行の JSON。出力ファイルに既にある局面は飛ばす（同じ引数で再開できる）。

use super::fixed;
use super::parallel::parallel_map;
use super::rhino_compare::SUBJECTS;
use crate::ai::converging::settle_converging_trades;
use crate::ai::determinize::determinize;
use crate::ai::keys::turn_order_eq;
use crate::ai::registry::create_agent;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::{Agent, Rng};
use crate::data::data;
use crate::game::{acting_player, apply_legal, create_game, is_legal, legal_actions};
use crate::json::Json;
use crate::state::{card, next_random, opponent, Action, GameState, Iid, Phase, PlayerIndex};
use crate::state_json::action_from_json;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

type Subject = (&'static str, &'static str, &'static str, u32);

/// 人間の記録 1 試合
struct Record {
    subject: Subject,
    deck: String,
    g: u32,
    seat: PlayerIndex,
    won: bool,
    /// 同じ試合を打ち直した記録を分けるため（対戦を終えた日時）
    played_at: String,
    actions: Vec<Action>,
}

impl Record {
    fn key(&self) -> String {
        format!(
            "{}/{}/{}/{}/{}",
            self.subject.0, self.deck, self.g, self.seat, self.played_at
        )
    }

    /// 試合の初期局面（src/sim/humanCompare.ts の compareMatch と同じ: シードは基準 + g × 13 + 席）
    fn initial(&self) -> Result<(GameState, u32), String> {
        let decks = &data().decks;
        let me = decks
            .iter()
            .find(|d| d.name == self.subject.1)
            .ok_or_else(|| format!("デッキがありません: {}", self.subject.1))?;
        let opp = decks
            .iter()
            .find(|d| d.name == self.deck)
            .ok_or_else(|| format!("相手デッキがありません: {}", self.deck))?;
        let seed = self.subject.3 + self.g * 13 + self.seat as u32;
        let cards = if self.seat == 0 {
            [&me.cards[..], &opp.cards[..]]
        } else {
            [&opp.cards[..], &me.cards[..]]
        };
        Ok((create_game(cards, seed), seed))
    }
}

/// 人間の記録の 1 行（version 2 の "human-compare" と、リノセウスエルフだけの頃の version 1 "rhino-compare-human"）
fn parse_record(line: &str) -> Result<Record, String> {
    let v = Json::parse(line)?;
    let kind = match v.get("kind") {
        Some(Json::Str(k)) => k.as_str(),
        _ => "",
    };
    let (subject_id, seat_key) = match kind {
        "human-compare" => match v.get("subject") {
            Some(Json::Str(s)) => (s.clone(), "seat"),
            _ => return Err("subject がありません".into()),
        },
        "rhino-compare-human" => ("rhino".to_string(), "elfSeat"),
        _ => return Err(format!("人間の記録ではありません（kind {kind}）")),
    };
    let subject = *SUBJECTS
        .iter()
        .find(|s| s.0 == subject_id)
        .ok_or_else(|| format!("不明な subject: {subject_id}"))?;
    let num = |k: &str| match v.get(k) {
        Some(Json::Num(x)) if *x >= 0.0 && x.fract() == 0.0 => Ok(*x as u32),
        _ => Err(format!("{k} がありません")),
    };
    let deck = match v.get("deck") {
        Some(Json::Str(s)) => s.clone(),
        _ => return Err("deck がありません".into()),
    };
    let seat = num(seat_key)? as usize;
    if seat > 1 {
        return Err(format!("席が 0・1 ではありません: {seat}"));
    }
    let won = matches!(v.get("won"), Some(Json::Bool(true)));
    let played_at = match v.get("playedAt") {
        Some(Json::Str(s)) => s.clone(),
        _ => String::new(),
    };
    let actions = match v.get("actions") {
        Some(Json::Arr(items)) => items
            .iter()
            .map(action_from_json)
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err("actions がありません".into()),
    };
    Ok(Record {
        subject,
        deck,
        g: num("g")?,
        seat,
        won,
        played_at,
        actions,
    })
}

/// シードに番号を混ぜる（TypeScript 版の mix と同じ）
fn mix(seed: u32, x: u32) -> u32 {
    next_random(seed ^ x.wrapping_add(1).wrapping_mul(0x9e3779b1)).1
}

fn is_start_of_turn(s: &GameState) -> bool {
    s.phase == Phase::Main && s.pending.is_none() && s.stack.is_empty() && s.queue.is_empty()
}

/// カードの名前（どの場所にも無ければ番号）
fn name_of(s: &GameState, iid: Iid, viewer: PlayerIndex) -> String {
    if iid < 0 {
        let owner = (-iid - 1) as usize;
        return if owner == viewer {
            "自分のリーダー".into()
        } else {
            "相手のリーダー".into()
        };
    }
    for pl in &s.players {
        if let Some(h) = pl.hand.iter().find(|h| h.iid == iid) {
            return card(h.card).name.clone();
        }
        if let Some(b) = pl.board.iter().find(|b| b.iid == iid) {
            return card(b.card).name.clone();
        }
    }
    format!("#{iid}")
}

fn names(s: &GameState, ids: &[Iid], viewer: PlayerIndex) -> String {
    ids.iter()
        .map(|&i| name_of(s, i, viewer))
        .collect::<Vec<_>>()
        .join("・")
}

/// 手の短い説明（局面 s で打つ前に作る）
fn step_text(s: &GameState, a: &Action, viewer: PlayerIndex) -> String {
    let who = if acting_player(s) == viewer {
        ""
    } else {
        "相手: "
    };
    let body = match a {
        Action::Mulligan { player, swap } => {
            let hand = &s.players[*player].hand;
            let pick = |keep: bool| {
                let v: Vec<String> = hand
                    .iter()
                    .filter(|h| swap.contains(&h.iid) != keep)
                    .map(|h| card(h.card).name.clone())
                    .collect();
                if v.is_empty() {
                    "なし".to_string()
                } else {
                    v.join("、")
                }
            };
            format!("残す: {} / 返す: {}", pick(true), pick(false))
        }
        Action::Play(i) => format!("{}をプレイ", name_of(s, *i, viewer)),
        Action::Evolve(i) => format!("{}を進化", name_of(s, *i, viewer)),
        Action::SuperEvolve(i) => format!("{}を超進化", name_of(s, *i, viewer)),
        Action::Act(i) => format!("{}の能力を使う", name_of(s, *i, viewer)),
        Action::Attack { attacker, target } => format!(
            "{}で{}を攻撃",
            name_of(s, *attacker, viewer),
            match target {
                Some(t) => name_of(s, *t, viewer),
                None => "リーダー".into(),
            }
        ),
        Action::Fuse { host, materials } => format!(
            "{}に{}を融合",
            name_of(s, *host, viewer),
            names(s, materials, viewer)
        ),
        Action::Choose(ids) => format!("選ぶ: {}", names(s, ids, viewer)),
        Action::Mode(i) => format!("{} 番目の効果を選ぶ", i + 1),
        Action::ExtraPp => "エクストラPP".into(),
        Action::EndTurn => "ターン終了".into(),
    };
    format!("{who}{body}")
}

/// 比べる局面 1 つ（記録の何手目から始まるか。局面は並列の仕事の中で再生し直す。GameState はスレッドをまたげないため）
struct Position {
    rec: usize,
    own_turn: i32,
    /// 人間のターン（かマリガン）の最初の手の番号
    index: usize,
    mulligan: bool,
}

/// 局面を再生する: 始めの局面と、人間のターン末（ターン終了を打つ前。マリガンなら None）と、人間の手順
fn replay_position(
    rec: &Record,
    pos: &Position,
) -> Result<(GameState, Option<GameState>, Vec<String>), String> {
    let (mut s, _) = rec.initial()?;
    for a in &rec.actions[..pos.index] {
        s = apply_legal(&s, a);
    }
    let p = rec.seat;
    if pos.mulligan {
        let steps = vec![step_text(&s, &rec.actions[pos.index], p)];
        return Ok((s, None, steps));
    }
    let (h, steps) =
        human_turn(rec, &s, pos.index).ok_or("人間のターンが最後まで再生できません")?;
    Ok((s, Some(h), steps))
}

/// 記録を index 手目から、人間がターンを終える手の直前まで再生する（試合が終わればそこまで）。打てない手があれば None
fn human_turn(rec: &Record, start: &GameState, index: usize) -> Option<(GameState, Vec<String>)> {
    let p = rec.seat;
    let mut h = start.clone();
    let mut steps = Vec::new();
    for b in &rec.actions[index..] {
        if !is_legal(&h, b) {
            return None;
        }
        if acting_player(&h) == p && matches!(b, Action::EndTurn) {
            return Some((h, steps));
        }
        steps.push(step_text(&h, b, p));
        h = apply_legal(&h, b);
        if h.phase == Phase::Ended {
            return Some((h, steps));
        }
    }
    None
}

/// 記録の再生の様子
#[derive(Debug, PartialEq)]
enum Replay {
    /// 最後まで打て、勝敗も記録と同じ
    Ok,
    /// この番号の手が打てなかった（そこまでの局面だけを使う）
    Stopped(usize),
    /// 最後まで打てたが、試合が終わらないか勝敗が記録と違う
    Differs,
}

/// 記録を再生し、人間の自分のターンの最初の局面（とマリガン）を集める。記録の手が打てなくなったら、そこで止める
fn positions_of(
    rec: &Record,
    index: usize,
    turns: (i32, i32),
) -> Result<(Vec<Position>, Replay), String> {
    let (mut s, _) = rec.initial()?;
    let p = rec.seat;
    let mut out = Vec::new();
    let mut last_turn = -1;
    for (i, a) in rec.actions.iter().enumerate() {
        if s.phase == Phase::Ended {
            break;
        }
        if !is_legal(&s, a) {
            return Ok((out, Replay::Stopped(i)));
        }
        let actor = acting_player(&s);
        let is_mulligan = actor == p && matches!(a, Action::Mulligan { .. });
        let is_turn_start = actor == p
            && s.active == p
            && is_start_of_turn(&s)
            && s.players[p].turn_count != last_turn
            && !is_mulligan;
        if is_turn_start {
            last_turn = s.players[p].turn_count;
        }
        let own_turn = if is_mulligan {
            0
        } else {
            s.players[p].turn_count
        };
        if (is_mulligan || is_turn_start)
            && own_turn >= turns.0
            && own_turn <= turns.1
            && (is_mulligan || human_turn(rec, &s, i).is_some())
        {
            out.push(Position {
                rec: index,
                own_turn,
                index: i,
                mulligan: is_mulligan,
            });
        }
        s = apply_legal(&s, a);
    }
    let same = s.phase == Phase::Ended && (s.winner == Some(rec.seat)) == rec.won;
    Ok((out, if same { Replay::Ok } else { Replay::Differs }))
}

/// 比べるデッキの席 p に既定の AI、相手に今の探索 AI。続きを打つたびに作り直す（並びを持ち越さないため）
fn make_agents(subject: Subject, p: PlayerIndex) -> [Box<dyn Agent>; 2] {
    let me = create_agent(subject.2).expect("比べるデッキの AI");
    let opp: Box<dyn Agent> = Box::new(SearchAgent::new(SearchOptions::default()));
    if p == 0 {
        [me, opp]
    } else {
        [opp, me]
    }
}

/// 局面 start から、席 p の AI がターンを終える直前まで打つ（相手の選択待ちは相手の AI が選ぶ）
fn ai_turn(
    start: &GameState,
    p: PlayerIndex,
    agents: &mut [Box<dyn Agent>; 2],
    seed: u32,
) -> Result<(GameState, Vec<String>), String> {
    let mut rng = Rng::new(seed);
    let mut steps = Vec::new();
    let mut t = start.clone();
    for _ in 0..500 {
        if t.phase == Phase::Ended {
            return Ok((t, steps));
        }
        let actor = acting_player(&t);
        let a = agents[actor].choose_action(&t, &legal_actions(&t), &mut rng);
        if actor == p && matches!(a, Action::EndTurn) {
            return Ok((t, steps));
        }
        steps.push(step_text(&t, &a, p));
        t = apply_legal(&t, &a);
        if t.phase != Phase::Ended && t.active != p {
            return Err("ターンを終える手を打たずに相手の番になりました".into());
        }
    }
    Err("AI がターンを終えません".into())
}

/// 局面 after から M 回最後まで打たせ、席 p が勝ったか。r 番目は手順によらず同じシード。
/// prepare があれば、決定化した局面にまずその手を打つ（マリガン）。打てなかった・途中で止まったら None
fn rollouts(
    after: &GameState,
    subject: Subject,
    p: PlayerIndex,
    m: u32,
    seed: u32,
    prepare: Option<&Action>,
) -> Vec<Option<bool>> {
    (0..m)
        .map(|r| {
            if after.phase == Phase::Ended {
                return Some(after.winner == Some(p));
            }
            catch_unwind(AssertUnwindSafe(|| {
                let mut det = determinize(after, p, &mut Rng::new(mix(seed, 1000 + r)), false);
                if let Some(a) = prepare {
                    if !is_legal(&det, a) {
                        return None;
                    }
                    det = apply_legal(&det, a);
                }
                let mut agents = make_agents(subject, p);
                let mut rng = Rng::new(mix(seed, 2000 + r));
                let mut s = det;
                for _ in 0..10000 {
                    if s.phase == Phase::Ended {
                        return Some(s.winner == Some(p));
                    }
                    let actor = acting_player(&s);
                    let a = agents[actor].choose_action(&s, &legal_actions(&s), &mut rng);
                    s = apply_legal(&s, &a);
                }
                None
            }))
            .unwrap_or(None)
        })
        .collect()
}

fn round2(x: f64) -> Value {
    json!((x * 100.0).round() / 100.0)
}

fn summarize_start(s: &GameState, p: PlayerIndex) -> Value {
    let (me, opp) = (&s.players[p], &s.players[opponent(p)]);
    json!({
        "hp": me.leader_hp, "oppHp": opp.leader_hp, "maxPp": me.max_pp,
        "hand": me.hand.len(), "oppHand": opp.hand.len(), "ep": me.ep, "sep": me.sep,
        "board": me.board.len(), "oppBoard": opp.board.len(),
    })
}

/// 局面 1 つを比べた結果の行
fn compare_position(pos: &Position, rec: &Record, m: u32) -> Result<Value, String> {
    let p = rec.seat;
    let (_, game_seed) = rec.initial()?;
    let (start, human_end, human_steps) = replay_position(rec, pos)?;
    let start = &start;
    let scorer = SearchAgent::new(SearchOptions::default());
    let pos_seed = mix(game_seed, 100 + pos.own_turn as u32);
    let base = json!({
        "subject": rec.subject.0, "deck": rec.deck, "g": rec.g, "seat": p, "playedAt": rec.played_at,
        "won": rec.won, "first": start.first == p, "ownTurn": pos.own_turn,
        "start": summarize_start(start, p),
    });
    let mut row = base;
    let obj = row.as_object_mut().expect("オブジェクト");
    if pos.mulligan {
        let hm = &rec.actions[pos.index];
        let mut agents = make_agents(rec.subject, p);
        let mut rng = Rng::new(mix(pos_seed, 1));
        let am = agents[p].choose_action(start, &legal_actions(start), &mut rng);
        let sorted = |a: &Action| match a {
            Action::Mulligan { swap, .. } => {
                let mut v = swap.clone();
                v.sort();
                v
            }
            _ => Vec::new(),
        };
        let same = matches!(am, Action::Mulligan { .. }) && sorted(&am) == sorted(hm);
        let side = |a: &Action, steps: Vec<String>| {
            let wins = if same {
                Vec::new()
            } else {
                rollouts(start, rec.subject, p, m, pos_seed, Some(a))
            };
            json!({ "steps": steps, "value": null, "read": null, "ended": false, "wins": wins })
        };
        obj.insert("same".into(), json!(same));
        obj.insert("human".into(), side(hm, human_steps));
        obj.insert("ai".into(), side(&am, vec![step_text(start, &am, p)]));
        return Ok(row);
    }
    let h = human_end.as_ref().expect("人間のターン末");
    let mut agents = make_agents(rec.subject, p);
    let (a_end, a_steps) = ai_turn(start, p, &mut agents, mix(pos_seed, 1))?;
    let ended = |s: &GameState| s.phase == Phase::Ended;
    let same = if ended(h) && ended(&a_end) {
        h.winner == a_end.winner
    } else {
        !ended(h) && !ended(&a_end) && turn_order_eq(h, &a_end)
    };
    // 相手のターンを読み直す引き直しのシード（探索 AI と同じ数。人間と AI で同じ）
    let read_seeds: Vec<u32> = (0..scorer.opts.opp_hand_samples.max(1) as u32)
        .map(|k| mix(pos_seed, 10 + k))
        .collect();
    let side = |end: &GameState, steps: &[String]| {
        let e = ended(end);
        let after = if e {
            end.clone()
        } else {
            apply_legal(end, &Action::EndTurn)
        };
        json!({
            "steps": steps,
            "value": if e { Value::Null } else { round2(scorer.turn_end_value(end, p)) },
            "read": if e || same { Value::Null } else { round2(scorer.read_value(end, p, &read_seeds)) },
            "ended": e,
            "wins": if same { Vec::new() } else { rollouts(&after, rec.subject, p, m, pos_seed, None) },
        })
    };
    let human = side(h, &human_steps);
    let ai = side(&a_end, &a_steps);
    // ビームの候補（最初の手ごとのターン末の最善）との比べ
    let mut beam = Value::Null;
    if !same && !ended(h) {
        let cands = scorer.turn_end_candidates(start, p);
        let settled = |s: &GameState| settle_converging_trades(s, p).unwrap_or_else(|| s.clone());
        let hk = settled(h);
        let values: Vec<f64> = cands.iter().map(|c| c.1).collect();
        let rank_of = |v: Option<f64>| v.map(|v| values.iter().filter(|&&x| x > v + 1e-9).count());
        let hv = human["value"].as_f64();
        let av = ai["value"].as_f64();
        beam = json!({
            "count": cands.len(),
            "best": values.iter().cloned().fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v)))).map(|x| (x * 100.0).round() / 100.0),
            "humanRank": rank_of(hv),
            "aiRank": rank_of(av),
            "humanInCandidates": cands.iter().any(|c| c.2.phase != Phase::Ended && turn_order_eq(&settled(&c.2), &hk)),
            "rescoreTop": scorer.opts.rescore_top,
        });
    }
    obj.insert("same".into(), json!(same));
    obj.insert("human".into(), human);
    obj.insert("ai".into(), ai);
    obj.insert("beam".into(), beam);
    Ok(row)
}

fn parse_range(v: &str) -> Result<(i32, i32), String> {
    let (a, b) = v
        .split_once('-')
        .ok_or_else(|| format!("範囲は a-b の形で: {v}"))?;
    let n = |x: &str| {
        x.parse::<i32>()
            .map_err(|_| format!("数ではありません: {x}"))
    };
    Ok((n(a)?, n(b)?))
}

pub fn main(argv: &[String]) -> Result<(), String> {
    if argv.first().map(|s| s.as_str()) == Some("report") {
        return report(&argv[1..]);
    }
    let mut out = "human-plan-value.jsonl".to_string();
    let mut m: u32 = 32;
    let mut turns = (0, 30);
    let mut games: Option<(i32, i32)> = None;
    let mut files = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let k = argv[i].as_str();
        if !k.starts_with("--") {
            files.push(k.to_string());
            i += 1;
            continue;
        }
        let v = argv
            .get(i + 1)
            .ok_or_else(|| format!("{k} の値がありません"))?;
        match k {
            "--out" => out = v.clone(),
            "--m" => m = v.parse().map_err(|_| format!("--m は整数: {v}"))?,
            "--turns" => turns = parse_range(v)?,
            "--games" => games = Some(parse_range(v)?),
            _ => return Err(format!("不明な引数: {k}")),
        }
        i += 2;
    }
    if files.is_empty() {
        return Err("人間の記録（jsonl）を 1 つ以上渡してください".into());
    }
    let mut records = Vec::new();
    for f in &files {
        let text = std::fs::read_to_string(f).map_err(|e| format!("{f} を読めません: {e}"))?;
        for (n, line) in text
            .lines()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
        {
            let r = parse_record(line).map_err(|e| format!("{f} の {} 行目: {e}", n + 1))?;
            if games.is_some_and(|(a, b)| (r.g as i32) < a || (r.g as i32) > b) {
                continue;
            }
            records.push(r);
        }
    }
    // 出力に既にある局面（試合と自分のターン）は飛ばす
    let mut done: HashSet<String> = HashSet::new();
    if let Ok(text) = std::fs::read_to_string(&out) {
        for line in text.lines() {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                done.insert(row_key(&v));
            }
        }
    }
    let mut positions = Vec::new();
    let mut diverged = 0;
    for (k, r) in records.iter().enumerate() {
        let (ps, replay) = positions_of(r, k, turns)?;
        match replay {
            Replay::Ok => {}
            Replay::Stopped(at) => {
                diverged += 1;
                eprintln!(
                    "注意: {} の記録の {at} 手目が今のエンジンでは打てません（そこまでの局面だけを比べる）",
                    r.key()
                );
            }
            Replay::Differs => {
                diverged += 1;
                eprintln!(
                    "注意: {} の記録を最後まで再生すると、勝敗が記録と違います",
                    r.key()
                );
            }
        }
        positions.extend(
            ps.into_iter()
                .filter(|p| !done.contains(&format!("{}/{}", r.key(), p.own_turn))),
        );
    }
    println!(
        "試合 {}（今のエンジンで再生すると記録と違う試合 {diverged}）、局面 {}（済み {}）、M {m}、ターン {}〜{}",
        records.len(),
        positions.len(),
        done.len(),
        turns.0,
        turns.1
    );
    let t0 = Instant::now();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&out)
        .map_err(|e| format!("{out} に書けません: {e}"))?;
    let mut compared = 0;
    let results = parallel_map(
        &positions,
        |pos, _| {
            let rec = &records[pos.rec];
            compare_position(pos, rec, m)
                .map_err(|e| format!("{} 自分の {} ターン目: {e}", rec.key(), pos.own_turn))
        },
        |n, total, r, _| {
            match r {
                Ok(v) => {
                    if v["same"] == json!(false) {
                        compared += 1;
                    }
                    let _ = writeln!(file, "{v}");
                }
                Err(e) => eprintln!("{e}"),
            }
            if n % 10 == 0 || n == total {
                let sec = t0.elapsed().as_secs_f64();
                eprintln!(
                    "局面 {n}/{total}（{} 秒、残り約 {} 分）",
                    fixed(sec, 0),
                    fixed(sec / n as f64 * (total - n) as f64 / 60.0, 0)
                );
            }
        },
    );
    let errors = results.iter().filter(|r| r.is_err()).count();
    println!(
        "完了: 局面 {}（打ち比べ {compared}、失敗 {errors}）、{} 秒",
        results.len(),
        fixed(t0.elapsed().as_secs_f64(), 0)
    );
    Ok(())
}

/// 出力の行の局面の名前（試合と自分のターン）
fn row_key(v: &Value) -> String {
    format!(
        "{}/{}/{}/{}/{}/{}",
        v["subject"].as_str().unwrap_or(""),
        v["deck"].as_str().unwrap_or(""),
        v["g"],
        v["seat"],
        v["playedAt"].as_str().unwrap_or(""),
        v["ownTurn"]
    )
}

/// 勝った割合（打てなかった回は除く）
fn win_rate(wins: &Value) -> Option<f64> {
    let v: Vec<bool> = wins
        .as_array()?
        .iter()
        .filter_map(|x| x.as_bool())
        .collect();
    if v.is_empty() {
        None
    } else {
        Some(v.iter().filter(|&&w| w).count() as f64 / v.len() as f64)
    }
}

/// 平均と標準誤差
fn mean_se(xs: &[f64]) -> (f64, f64) {
    let n = xs.len() as f64;
    if xs.is_empty() {
        return (f64::NAN, f64::NAN);
    }
    let mean = xs.iter().sum::<f64>() / n;
    if xs.len() < 2 {
        return (mean, f64::NAN);
    }
    let var = xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0);
    (mean, (var / n).sqrt())
}

fn pct(x: f64) -> String {
    format!("{}%", fixed(x * 100.0, 1))
}

/// 局面の型（差の内訳）
fn category(v: &Value) -> &'static str {
    if v["ownTurn"] == json!(0) {
        return "マリガン";
    }
    if v["human"]["ended"] == json!(true) || v["ai"]["ended"] == json!(true) {
        return "そのターンで試合が終わった";
    }
    let beam = &v["beam"];
    let (Some(hv), Some(best)) = (v["human"]["value"].as_f64(), beam["best"].as_f64()) else {
        return "その他";
    };
    if hv > best + 1e-6 {
        return "ビームが届かなかった（人間の手順のターン末の点数が候補の最善より高い）";
    }
    let top = beam["rescoreTop"].as_u64().unwrap_or(4);
    match beam["humanRank"].as_u64() {
        Some(r) if r >= top => "ターン末の点数で読み直しの候補から外れた",
        _ => match (v["human"]["read"].as_f64(), v["ai"]["read"].as_f64()) {
            (Some(hr), Some(ar)) if hr < ar => "相手のターンを読んだ後の点数で AI の手順が上",
            _ => "読んだ後の点数でも人間の手順が上（決定化の違い等）",
        },
    }
}

/// svwb human-plan-value report 結果.jsonl... [--top 30]
fn report(argv: &[String]) -> Result<(), String> {
    let mut top = 30usize;
    let mut rows: Vec<Value> = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        if argv[i] == "--top" {
            top = argv
                .get(i + 1)
                .and_then(|v| v.parse().ok())
                .ok_or("--top は整数")?;
            i += 2;
            continue;
        }
        let f = &argv[i];
        let text = std::fs::read_to_string(f).map_err(|e| format!("{f} を読めません: {e}"))?;
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            rows.push(serde_json::from_str(line).map_err(|e| format!("{f}: {e}"))?);
        }
        i += 1;
    }
    let games: HashSet<String> = rows
        .iter()
        .map(|v| {
            let k = row_key(v);
            k[..k.rfind('/').unwrap_or(k.len())].to_string()
        })
        .collect();
    // 打ち比べた局面と差（人間の手順の勝率 − AI の手順の勝率）
    let diffs: Vec<(&Value, f64)> = rows
        .iter()
        .filter(|v| v["same"] == json!(false))
        .filter_map(|v| {
            Some((
                v,
                win_rate(&v["human"]["wins"])? - win_rate(&v["ai"]["wins"])?,
            ))
        })
        .collect();
    let all: Vec<f64> = diffs.iter().map(|x| x.1).collect();
    let (mean, se) = mean_se(&all);
    let total: f64 = all.iter().sum();
    println!("# 人間の手順と AI の手順の打ち比べ（human-plan-value）\n");
    println!(
        "- 試合 {}、局面 {}（同じ局面に着いた {}、打ち比べ {}）",
        games.len(),
        rows.len(),
        rows.iter().filter(|v| v["same"] == json!(true)).count(),
        diffs.len()
    );
    println!(
        "- 差（人間 − AI）の平均 {} ± {}、1 試合あたりの合計 {}\n",
        pct(mean),
        pct(se),
        pct(total / games.len().max(1) as f64)
    );
    let table = |title: &str, key: &dyn Fn(&Value) -> String| {
        let mut groups: BTreeMap<String, Vec<f64>> = BTreeMap::new();
        for (v, d) in &diffs {
            groups.entry(key(v)).or_default().push(*d);
        }
        println!("## {title}\n");
        println!("| | 局面 | 差の平均 | 合計に占める割合 |\n| --- | ---: | ---: | ---: |");
        for (k, xs) in &groups {
            let (m, s) = mean_se(xs);
            let sum: f64 = xs.iter().sum();
            println!(
                "| {k} | {} | {} ± {} | {} |",
                xs.len(),
                pct(m),
                pct(s),
                if total.abs() > 1e-9 {
                    format!("{}%", fixed(sum / total * 100.0, 0))
                } else {
                    "-".into()
                }
            );
        }
        println!();
    };
    table(
        "差の内訳（どの段階で AI が人間の手順を選ばなかったか）",
        &|v| category(v).to_string(),
    );
    table("デッキ別", &|v| {
        v["subject"].as_str().unwrap_or("").to_string()
    });
    table("自分のターン別", &|v| {
        format!("{:02}", v["ownTurn"].as_i64().unwrap_or(-1))
    });
    let mut sorted = diffs.clone();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    println!("## 差の大きい局面（上位 {top}）\n");
    for (v, d) in sorted.iter().take(top) {
        let steps = |s: &Value| {
            s["steps"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join("、")
                })
                .unwrap_or_default()
        };
        println!(
            "- **{}** {} vs {} g{} 席{} 自分の {} ターン目（{}）: 人間 {}・AI {}",
            pct(*d),
            v["subject"].as_str().unwrap_or(""),
            v["deck"].as_str().unwrap_or(""),
            v["g"],
            v["seat"],
            v["ownTurn"],
            category(v),
            pct(win_rate(&v["human"]["wins"]).unwrap_or(f64::NAN)),
            pct(win_rate(&v["ai"]["wins"]).unwrap_or(f64::NAN)),
        );
        println!("  - 人間: {}", steps(&v["human"]));
        println!("  - AI: {}", steps(&v["ai"]));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::RandomAgent;
    use crate::state_json::action_to_json;

    /// 比べるデッキ af の試合 g3・席 1 をランダムに最後まで打った記録（人間の記録の形の 1 行）
    fn random_record_line() -> (String, usize) {
        let subject = *SUBJECTS.iter().find(|s| s.0 == "af").unwrap();
        let rec = Record {
            subject,
            deck: "アマリアロイヤル".into(),
            g: 3,
            seat: 1,
            won: false,
            played_at: String::new(),
            actions: Vec::new(),
        };
        let (mut s, _) = rec.initial().unwrap();
        let mut rng = Rng::new(5);
        let mut agent = RandomAgent;
        let mut actions = Vec::new();
        while s.phase != Phase::Ended {
            let a = agent.choose_action(&s, &legal_actions(&s), &mut rng);
            s = apply_legal(&s, &a);
            actions.push(a);
        }
        let won = s.winner == Some(1);
        let body: Vec<String> = actions
            .iter()
            .map(|a| action_to_json(a).stringify())
            .collect();
        let line = format!(
            r#"{{"kind":"human-compare","version":2,"subject":"af","deck":"アマリアロイヤル","g":3,"seat":1,"won":{won},"playedAt":"t","actions":[{}]}}"#,
            body.join(",")
        );
        (line, actions.len())
    }

    #[test]
    fn replays_a_record_and_finds_own_turns() {
        let (line, n) = random_record_line();
        let rec = parse_record(&line).unwrap();
        assert_eq!(rec.actions.len(), n);
        assert_eq!((rec.subject.0, rec.seat, rec.g), ("af", 1, 3));
        let (ps, replay) = positions_of(&rec, 0, (0, 30)).unwrap();
        assert_eq!(replay, Replay::Ok);
        // マリガンが 1 つ、自分のターンは 1 ターン目から順に 1 つずつ
        assert!(ps[0].mulligan && ps[0].own_turn == 0);
        assert!(ps.len() >= 3);
        for (k, pos) in ps.iter().enumerate().skip(1) {
            assert!(!pos.mulligan);
            assert_eq!(pos.own_turn, k as i32);
            let (start, end, steps) = replay_position(&rec, pos).unwrap();
            assert_eq!(acting_player(&start), 1);
            assert!(end.is_some());
            assert_eq!(
                steps.is_empty(),
                turn_order_eq(&start, end.as_ref().unwrap())
            );
        }
        // 範囲の外のターンは集めない
        let (few, _) = positions_of(&rec, 0, (2, 3)).unwrap();
        assert_eq!(
            few.iter().map(|p| p.own_turn).collect::<Vec<_>>(),
            vec![2, 3]
        );
    }

    #[test]
    fn reads_version_1_records() {
        let line = r#"{"kind":"rhino-compare-human","version":1,"deck":"AFネメシス","g":0,"elfSeat":1,"won":true,"actions":[]}"#;
        let rec = parse_record(line).unwrap();
        assert_eq!((rec.subject.0, rec.seat, rec.won), ("rhino", 1, true));
        assert!(parse_record(r#"{"kind":"other"}"#).is_err());
    }
}
