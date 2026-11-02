//! lethal-read: 探索 AI どうしの試合で、相手のターンの始めごとに「持っていればリーサル」のカード（ai/hand_read.rs）を数え、
//! その後の自分のターンの決定化で外せる量を書き出す（docs/ai-notes.md「見逃したリーサルから相手の手札を絞る」。測るだけで、打つ手は変えない）。
//!
//!   svwb lethal-read --out 記録.jsonl [--games 49] [--start 0] [--opts '<設定JSON>'] [--decide]
//!
//! - 試合は read-log と同じ（compare と同じデッキの組で、試合番号ごとに席とデッキを入れ替えて 2 試合。両方の席が同じ設定）
//! - 1 行が 1 回の調べ（"type":"check"）か 1 試合の結果（"type":"game"）。調べの行は、手番 q のターンの始め（選択待ちでない最初の手番）に、
//!   相手（見る側 v）から見て「持っていればリーサル」のカード（"threats"）と、その枚数（q の伏せた手札・山札・相手に分からない捨てたカードの中。"m"）、
//!   伏せた手札の枚数（"h"）・並べ直す候補の枚数（"n"）、本当の手札にあった枚数（"actual"）、持っていたとき本当の局面で同じリーサル探索が見つけるか（"realFound"）、
//!   q がそのターンに勝ったか（"won"）、調べた時間（"secs"）。
//!   q が勝たずに v の次のターンが来たら、その最初の手番での q の伏せた手札の枚数（"next.h"）、そのうち調べたときから手札にあったもの（"next.old"）、
//!   調べた後に手札に入った伏せたカードの数（"next.entered"）、そのときの候補の枚数（"next.n"）と threats の枚数（"next.m"）
//! - 調べるリーサル探索は、その設定の探索 AI が自分の手番で使うものと同じ（ビーム → 全探索）
//! - --decide: 両方の席を lethalRead にして打ち（相手の手番の局面を observe で見せる）、各ターンの最初の手番で読みが効いているとき、
//!   lethalRead なしの同じ設定の AI（新しく作ったもの・同じ乱数）が選ぶ手と比べた行（"type":"decide"。"changed" は最初の手、"planChanged" は選んだ並びが変わったか。
//!   "planR"・"plan0" は読みあり・なしの並び、"valsR"・"vals0" は読み直した候補ごとの [最初の手, 選ぶときの値, 読んだ点数]）も書く

use super::compare::compare_setup;
use super::compare_decks;
use super::fixed;
use super::human_plan::step_text;
use super::options::compare_options;
use super::parallel::{parallel_map, thread_count};
use crate::ai::exact_lethal::{search_exact_lethal, sure_lethal_options, with_isolated_cache};
use crate::ai::hand_read::lethal_threats;
use crate::ai::lethal::{find_lethal_line, search_lethal, LethalOptions, DEFAULT_LETHAL_OPTIONS};
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::{Agent, Rng};
use crate::data::{CardIdx, Deck};
use crate::game::{acting_player, apply_action, create_game, legal_actions};
use crate::state::{card, opponent, GameState, Iid, Phase, PlayerIndex};
use serde_json::{json, Value};
use std::io::Write;
use std::time::Instant;

/// q の伏せた手札の iid
fn hidden_iids(s: &GameState, q: PlayerIndex) -> Vec<Iid> {
    s.players[q]
        .hand
        .iter()
        .filter(|h| !h.revealed)
        .map(|h| h.iid)
        .collect()
}

/// q の並べ直す候補（伏せた手札・山札・相手に分からない捨てたカード）の枚数と、そのうち cards に含まれる枚数
fn pool_counts(s: &GameState, q: PlayerIndex, cards: &[CardIdx]) -> (usize, usize) {
    let pl = &s.players[q];
    let all: Vec<CardIdx> = pl
        .hand
        .iter()
        .filter(|h| !h.revealed)
        .map(|h| h.card)
        .chain(pl.deck.iter().map(|c| c.card))
        .chain(pl.hidden_discards.iter().copied())
        .collect();
    (all.len(), all.iter().filter(|c| cards.contains(c)).count())
}

struct Open {
    row: Value,
    q: PlayerIndex,
    turn: i32,
    threats: Vec<CardIdx>,
    /// 調べたときの伏せた手札
    old: Vec<Iid>,
    /// 調べた後に手札に入った伏せたカード
    entered: Vec<Iid>,
    /// 直前に見た伏せた手札
    last: Vec<Iid>,
    done_turn: bool,
}

fn play_logged(
    opts: &SearchOptions,
    decks: &[&'static Deck],
    g: u32,
    swap: bool,
    decide: bool,
) -> Vec<Value> {
    let (_, seats, seed) = compare_setup(decks, g, swap, false);
    let play_opts = SearchOptions {
        lethal_read: decide,
        ..opts.clone()
    };
    let mut agents = [
        SearchAgent::new(play_opts.clone()),
        SearchAgent::new(play_opts),
    ];
    let mut first_of_turn = [-1i32; 2];
    let lo = LethalOptions {
        ward_blocked: opts.lethal_ward_blocked,
        expand_choices: opts.lethal_expand_choices,
        ..DEFAULT_LETHAL_OPTIONS
    };
    let exact_states = opts.lethal_exact_states;
    let search = |root: &GameState, q: PlayerIndex| {
        search_lethal(root, q, &lo).or_else(|| {
            (exact_states > 0)
                .then(|| search_exact_lethal(root, q, &sure_lethal_options(exact_states)))
                .flatten()
        })
    };
    let mut s = create_game([&seats[0].cards, &seats[1].cards], seed);
    let mut rng = Rng::new(seed ^ 0x9e3779b9);
    let mut out: Vec<Value> = Vec::new();
    let mut open: Vec<Open> = Vec::new();
    let mut checked_turn = -1;
    let mut actions = 0u32;
    while s.phase != Phase::Ended {
        actions += 1;
        assert!(actions <= 10000, "アクション数が上限 10000 を超えました");
        // 開いている調べの、伏せた手札の出入りを追う
        for o in open.iter_mut() {
            let now = hidden_iids(&s, o.q);
            for &i in &now {
                if !o.last.contains(&i) && !o.old.contains(&i) && !o.entered.contains(&i) {
                    o.entered.push(i);
                }
            }
            o.last = now;
            if !o.done_turn && s.turn != o.turn {
                o.done_turn = true;
                o.row["won"] = json!(false);
            }
        }
        // v の次のターンの最初の手番で、外せる量を書いて閉じる
        let mut k = 0;
        while k < open.len() {
            let o = &open[k];
            let v = opponent(o.q);
            if s.turn > o.turn
                && s.active == v
                && s.phase == Phase::Main
                && s.pending.is_none()
                && acting_player(&s) == v
            {
                let mut o = open.remove(k);
                let now = hidden_iids(&s, o.q);
                let old = now.iter().filter(|i| o.old.contains(i)).count();
                let (n, m) = pool_counts(&s, o.q, &o.threats);
                o.row["next"] = json!({
                    "h": now.len(),
                    "old": old,
                    "entered": o.entered.len(),
                    "n": n,
                    "m": m,
                    "vHp": s.players[v].leader_hp,
                });
                out.push(o.row);
                continue;
            }
            k += 1;
        }
        let actor = acting_player(&s);
        if s.phase == Phase::Main
            && s.pending.is_none()
            && actor == s.active
            && s.turn != checked_turn
        {
            checked_turn = s.turn;
            let q = s.active;
            let v = opponent(q);
            let t = Instant::now();
            let threats = lethal_threats(
                &s,
                v,
                seed ^ (s.turn as u32).wrapping_mul(0x9e37),
                lo.samples,
                &search,
            );
            let secs = t.elapsed().as_secs_f64();
            if !threats.is_empty() {
                let (n, m) = pool_counts(&s, q, &threats);
                let hid = hidden_iids(&s, q);
                let actual = s.players[q]
                    .hand
                    .iter()
                    .filter(|h| !h.revealed && threats.contains(&h.card))
                    .count();
                // 本当の手札で、q の AI と同じリーサル探索が見つけるか（持っていたのに勝たなかったときの理由を見る用）
                let real_found = (actual > 0).then(|| {
                    with_isolated_cache(|| {
                        find_lethal_line(&s, q, &mut Rng::new(seed ^ 0x51ed), lo.samples, &search)
                            .is_some()
                    })
                });
                let row = json!({
                    "type": "check",
                    "g": g,
                    "swap": swap,
                    "turn": s.turn,
                    "q": q,
                    "qDeck": seats[q].name,
                    "vDeck": seats[v].name,
                    "vHp": s.players[v].leader_hp,
                    "threats": threats.iter().map(|&c| card(c).name.clone()).collect::<Vec<_>>(),
                    "h": hid.len(),
                    "n": n,
                    "m": m,
                    "actual": actual,
                    "realFound": real_found,
                    "secs": secs,
                });
                open.push(Open {
                    row,
                    q,
                    turn: s.turn,
                    threats,
                    old: hid.clone(),
                    entered: Vec::new(),
                    last: hid,
                    done_turn: false,
                });
            } else {
                out.push(json!({"type": "none", "secs": secs, "qDeck": seats[q].name}));
            }
        }
        let legal = legal_actions(&s);
        agents[1 - actor].observe(&s);
        let rng0 = rng.state;
        let a = agents[actor].choose_action(&s, &legal, &mut rng);
        let turn_first = decide
            && s.phase == Phase::Main
            && s.pending.is_none()
            && actor == s.active
            && first_of_turn[actor] != s.turn;
        if turn_first {
            first_of_turn[actor] = s.turn;
        }
        if turn_first && legal.len() > 1 {
            if let Some(rd) = agents[actor].opts.hand_reading.clone() {
                let mut twin = SearchAgent::new(opts.clone());
                let b = with_isolated_cache(|| twin.choose_action(&s, &legal, &mut Rng::new(rng0)));
                // 並び全体（選んだ手の、読み直した点数が最も高かった決定化の並び）も比べる
                // 読み直した候補の [最初の手, 選ぶときの値, 読んだ点数]（選ぶときの値の高い順）
                let plan_of = |o: SearchOptions| -> (Vec<String>, Value) {
                    let ag = SearchAgent::new(o);
                    with_isolated_cache(|| {
                        ag.think_with(&s, &legal, &mut Rng::new(rng0), None)
                            .map(|t| {
                                let plan = t
                                    .candidates
                                    .iter()
                                    .find(|c| c.action == t.chosen)
                                    .map(|c| {
                                        c.steps.iter().map(|x| step_text(&s, x, actor)).collect()
                                    })
                                    .unwrap_or_else(|| vec![step_text(&s, &t.chosen, actor)]);
                                let vals: Vec<Value> = t
                                    .candidates
                                    .iter()
                                    .filter_map(|c| {
                                        let v = c.value?;
                                        Some(json!([
                                            step_text(&s, &c.action, actor),
                                            v,
                                            c.read.map(|r| r.total)
                                        ]))
                                    })
                                    .collect();
                                (plan, Value::Array(vals))
                            })
                            .unwrap_or_default()
                    })
                };
                let (plan_r, vals_r) = plan_of(SearchOptions {
                    hand_reading: Some(rd.clone()),
                    ..opts.clone()
                });
                let (plan_0, vals_0) = plan_of(opts.clone());
                let q = opponent(actor);
                let ex: Vec<String> = rd
                    .excluded
                    .first()
                    .map(|(_, e)| e.iter().map(|&c| card(c).name.clone()).collect())
                    .unwrap_or_default();
                out.push(json!({
                    "type": "decide",
                    "g": g,
                    "swap": swap,
                    "turn": s.turn,
                    "p": actor,
                    "deck": seats[actor].name,
                    "oppDeck": seats[q].name,
                    "hp": s.players[actor].leader_hp,
                    "oppHp": s.players[q].leader_hp,
                    "slots": rd.excluded.len(),
                    "hidden": s.players[q].hand.iter().filter(|h| !h.revealed).count(),
                    "excluded": ex,
                    "changed": a != b,
                    "planChanged": plan_r != plan_0,
                    "planR": plan_r,
                    "plan0": plan_0,
                    "valsR": vals_r,
                    "vals0": vals_0,
                    "chosen": step_text(&s, &a, actor),
                    "twin": step_text(&s, &b, actor),
                }));
            }
        }
        s = apply_action(&s, &a);
    }
    for mut o in open {
        if !o.done_turn {
            o.row["won"] = json!(s.winner == Some(o.q));
        }
        out.push(o.row);
    }
    out.push(json!({
        "type": "game",
        "g": g,
        "swap": swap,
        "decks": [seats[0].name, seats[1].name],
        "winner": s.winner,
        "turns": s.turn,
    }));
    out
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mut games: u32 = 49;
    let mut start: u32 = 0;
    let mut opts_text = "{}".to_string();
    let mut out_path: Option<String> = None;
    let mut decide = false;
    let mut it = argv.iter();
    while let Some(key) = it.next() {
        if key == "--decide" {
            decide = true;
            continue;
        }
        let v = it.next().ok_or_else(|| format!("{key} の値がありません"))?;
        let int = || -> Result<u32, String> {
            v.parse::<u32>()
                .map_err(|_| format!("{key} は 0 以上の整数: {v}"))
        };
        match key.as_str() {
            "--games" => games = int()?,
            "--start" => start = int()?,
            "--opts" => opts_text = v.clone(),
            "--out" => out_path = Some(v.clone()),
            _ => return Err(format!("知らないオプション: {key}")),
        }
    }
    let out_path = out_path.ok_or("--out で書き出すファイルを指定します")?;
    let opts = compare_options(&opts_text).map_err(|e| format!("--opts: {e}"))?;
    let decks = compare_decks();
    let tasks: Vec<(u32, bool)> = (0..games)
        .flat_map(|k| [(start + k, false), (start + k, true)])
        .collect();
    let mut file = std::io::BufWriter::new(
        std::fs::File::create(&out_path).map_err(|e| format!("{out_path}: {e}"))?,
    );
    eprintln!("{} 試合（並列 {}）", tasks.len(), thread_count());
    let t0 = Instant::now();
    let mut write_err: Option<String> = None;
    parallel_map(
        &tasks,
        |&(g, swap), _| play_logged(&opts, &decks, g, swap, decide),
        |done, total, lines, _| {
            for l in lines {
                if let Err(e) = writeln!(file, "{l}") {
                    write_err.get_or_insert(e.to_string());
                }
            }
            eprint!("\r{done}/{total}");
        },
    );
    file.flush().map_err(|e| e.to_string())?;
    if let Some(e) = write_err {
        return Err(format!("{out_path}: {e}"));
    }
    eprintln!(
        "（{} 秒）→ {out_path}",
        fixed(t0.elapsed().as_secs_f64(), 1)
    );
    Ok(())
}
