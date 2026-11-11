//! 候補の打ち比べ調査（2026-11-11。審査の文書「AI の設計の審査と今後の方針」課題点 3「先にやること」、docs/survey.md）。
//!
//!   svwb survey run --out 結果.jsonl --games a-b [--rate 0.1] [--m 32] [--extra 4] [--confirm 96] [--flag 10] [--batch 8]
//!   svwb survey report 結果.jsonl… [--label 名前] [--no-ledger] [--top 20] [--states <フォルダ>]
//!
//! **run**: 今の既定の AI どうしの自己対戦（試合 g のデッキ・席・シードは `svwb ai-play`・`deep-gap` と同じ）を打ち、
//! 両方の席の自分のターンの最初の局面から、試合番号と手の番号で決まる乱数で `--rate` の割合を無作為に選ぶ（差の大きさでは選ばない）。
//! 選んだ局面ごとに:
//! 1. 試合でその局面を考えたときと同じ乱数で今の AI に考えさせ（試合で打った手と同じ手を選ぶ。違えば行に `match: false`）、候補を作る。
//!    AI が読み直した候補（上位 4 と、drawSplit が足す引く手。AI はこの中から選ぶ）と、同じ決定化のビームの終局面から
//!    ターン末の点数の高い順に、使うカードの組（手札から出すカード・融合の素材）がそれまでの候補のどれとも違う並びを `--extra` 個
//!    （`SearchAgent::survey_plans`）
//! 2. 候補ごとに、同じ乱数で `--m` 回最後まで打つ（r 回目は、手番の側から見た決定化と AI の乱数がどの候補でも同じ）。
//!    候補は、AI がその並びを選んだものとして打つ: 最初の手を打ち、次の判断からは局面が予想どおりなら並びの続きを打つ
//!    （並びは最初の引く手・ランダムな手まで。その先と、並びを打ち終えた後は AI が考え直す）。続きは両方の席とも今の既定の AI
//! 3. 二段目（確かめ）: 一段目で、AI の選んだ候補との勝率の差が最も大きい候補の差が `--flag` ポイント以上なら、
//!    その候補と AI の選んだ候補だけを、一段目と重ならない乱数でさらに `--confirm` 回打つ。見落としの判定は二段目の回だけで行う
//!    （一段目で差の大きいものを選んだ偏りが入らない）
//!
//! 出力は JSON Lines。局面の行（局面の状態の JSON・候補・勝ち負け）と、試合の行（`"game": true`。自分のターンの最初の局面の数）。
//! `--batch` 試合ごとにまとめて書き、出力に既にある試合は飛ばす（同じ引数で再開できる。試合の行の無い局面の行は、再開のときに消す）。
//! 勝ち負けは 1 文字ずつ（`1` 勝ち・`0` 負け・`d` 引き分け・`x` 打てなかった・途中で止まった）。
//!
//! **report**: 決まり（docs/survey.md「決まり」。回す前に決めたもの）で、打ち比べで選び直す得（1 試合あたり）、はっきりした見落としの回数、
//! デッキ・ターン・手の種類ごとの内訳、問題集に足す局面の候補を Markdown で出し、台帳に 1 行足す（`kind` は `survey`。`--no-ledger` で書かない）。
//! `--states` を渡すと、問題集に足す候補の局面を 1 つずつ状態の JSON で書く（`npm run misses -- add --state` に渡せる）。
//!
//! 実際の対戦の局面を入れる口は無い（自己対戦の局面だけを扱う。CLAUDE.md「ソフト打ち」）。

use super::deep_gap::{
    check_flags, describe, ends_cleanly, flag, multiset_minus, num_flag, open_append, parse_flags,
    read_rows, used_of,
};
use super::fixed;
use super::human_plan::{is_start_of_turn, mean_se, mix, parse_range, round2, step_text};
use super::ledger;
use super::parallel::{parallel_map, thread_count};
use crate::ai::determinize::determinize;
use crate::ai::exact_lethal::reset_exact_lethal_cache;
use crate::ai::lethal::reset_lethal;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::{seed_of, Rng};
use crate::data::{data, CardIdx};
use crate::game::{
    acting_player, apply_legal, create_game, is_legal, legal_actions, try_apply_action,
};
use crate::json::Json;
use crate::sim::{ai_game_setup, play_match, MatchRng};
use crate::state::{Action, GameState, Phase, PlayerIndex};
use crate::state_json::{action_to_json, state_to_json};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::time::Instant;

/// 局面を選ぶ乱数・局面ごとの乱数に混ぜる印（"SURV"）
const TAG: u32 = 0x5355_5256;
/// はっきりした見落とし（と問題集に足す候補）の線: 二段目の差がこのポイント以上で、標準誤差の MISS_Z 倍以上
pub const MISS_POINTS: f64 = 15.0;
pub const MISS_Z: f64 = 3.0;

/// run の設定
#[derive(Clone)]
struct Cfg {
    rate: f64,
    m: u32,
    extra: usize,
    confirm: u32,
    flag: f64,
}

/// 試合のデッキの名前
fn deck_name(cards: &[CardIdx]) -> String {
    data()
        .decks
        .iter()
        .find(|d| d.cards == cards)
        .map_or("?".to_string(), |d| d.name.clone())
}

/// 打った自己対戦 1 試合
struct GameRec {
    g: u32,
    decks: [Vec<CardIdx>; 2],
    seed: u32,
    actions: Vec<Action>,
    /// 自分のターンの最初の局面（手の番号と席）
    starts: Vec<(usize, PlayerIndex)>,
    winner: Option<PlayerIndex>,
    sec: f64,
}

/// 試合 g の自己対戦（今の既定の AI どうし。svwb ai-play と同じ試合）
fn play_game(g: u32) -> GameRec {
    let t = Instant::now();
    let (decks, seed) = ai_game_setup(g, false);
    reset_lethal();
    reset_exact_lethal_cache();
    let mut a0 = SearchAgent::new(SearchOptions::default());
    let mut a1 = SearchAgent::new(SearchOptions::default());
    let mut actions = Vec::new();
    let mut starts = Vec::new();
    let mut last = [i32::MIN; 2];
    let end = play_match(
        &mut [&mut a0, &mut a1],
        [&decks[0], &decks[1]],
        seed,
        |s, a| {
            let actor = acting_player(s);
            if s.active == actor
                && is_start_of_turn(s)
                && s.players[actor].turn_count != last[actor]
            {
                last[actor] = s.players[actor].turn_count;
                starts.push((actions.len(), actor));
            }
            actions.push(a.clone());
        },
    );
    GameRec {
        g,
        decks,
        seed,
        actions,
        starts,
        winner: end.winner,
        sec: t.elapsed().as_secs_f64(),
    }
}

/// 局面 (g, i) を選ぶか（試合番号と手の番号で決まる乱数が rate 未満）
fn sampled(g: u32, i: usize, rate: f64) -> bool {
    (seed_of(&[TAG, g, i as u32]) as f64) / 4_294_967_296.0 < rate
}

/// 局面ごとの乱数の元
fn pos_seed(rec: &GameRec, i: usize) -> u32 {
    seed_of(&[TAG, rec.seed, i as u32])
}

/// 試合の i 手目の前の局面と、試合でその局面を考えたときの AI の乱数（play_match の MatchRng と同じ）
fn rebuild(rec: &GameRec, i: usize) -> (GameState, Rng) {
    let mut s = create_game([&rec.decks[0], &rec.decks[1]], rec.seed);
    let mut mrng = MatchRng::new(rec.seed);
    for a in &rec.actions[..i] {
        let actor = acting_player(&s);
        mrng.next(&s, actor, false);
        s = apply_legal(&s, a);
    }
    let actor = acting_player(&s);
    let r = mrng.next(&s, actor, false);
    let rng = Rng { state: r.state };
    (s, rng)
}

/// 候補 1 つ（スレッドをまたいで渡す形）
#[derive(Clone)]
struct PlanData {
    chosen: bool,
    steps: Vec<Action>,
    value: Value,
}

/// 調べる局面 1 つ
struct Prep {
    rec: usize,
    i: usize,
    p: PlayerIndex,
    seed: u32,
    /// 打ち比べない理由（lethal・one-action・one-plan・no-chosen）
    skip: Option<&'static str>,
    plans: Vec<PlanData>,
    /// AI が選んだ候補の添字
    ai: usize,
    row: Value,
    sec: f64,
}

fn actions_json(acts: &[Action]) -> Value {
    Value::Array(
        acts.iter()
            .map(|a| serde_json::from_str(&action_to_json(a).stringify()).unwrap_or(Value::Null))
            .collect(),
    )
}

/// 局面 start から手の列 acts の説明（打てない手が来たらそこまで）
fn texts(start: &GameState, acts: &[Action], p: PlayerIndex) -> Vec<String> {
    let mut t = start.clone();
    let mut out = Vec::new();
    for a in acts {
        out.push(step_text(&t, a, p));
        if matches!(a, Action::EndTurn) {
            break;
        }
        match try_apply_action(&t, a) {
            Some(n) => t = n,
            None => {
                out.push("…（この先は打てない）".into());
                break;
            }
        }
    }
    out
}

/// 局面を作り、候補を作る
fn prepare(recs: &[GameRec], rec_i: usize, i: usize, p: PlayerIndex, cfg: &Cfg) -> Prep {
    let t = Instant::now();
    let rec = &recs[rec_i];
    let (s, mut rng) = rebuild(rec, i);
    let names = [deck_name(&rec.decks[0]), deck_name(&rec.decks[1])];
    let me = &s.players[p];
    let mut row = json!({
        "g": rec.g, "i": i, "p": p, "turn": s.turn, "own": me.turn_count,
        "first": s.first == p, "deck": names[p], "opp": names[1 - p],
        "maxPp": me.max_pp, "hp": me.leader_hp, "oppHp": s.players[1 - p].leader_hp,
        "view": describe(&s, p, &names),
        "state": serde_json::from_str::<Value>(&state_to_json(&s).stringify()).unwrap_or(Value::Null),
    });
    let mut prep = Prep {
        rec: rec_i,
        i,
        p,
        seed: pos_seed(rec, i),
        skip: None,
        plans: Vec::new(),
        ai: 0,
        row: Value::Null,
        sec: 0.0,
    };
    let legal = legal_actions(&s);
    reset_lethal();
    reset_exact_lethal_cache();
    let agent = SearchAgent::new(SearchOptions::default());
    let survey = if legal.len() <= 1 {
        None
    } else {
        agent.survey_plans(&s, &legal, &mut rng, cfg.extra)
    };
    match survey {
        None => prep.skip = Some("one-action"),
        Some(sv) if sv.lethal => prep.skip = Some("lethal"),
        Some(sv) => {
            let root = sv.root.as_ref().unwrap_or(&s);
            for pl in &sv.plans {
                prep.plans.push(PlanData {
                    chosen: pl.chosen,
                    steps: pl.steps.clone(),
                    value: json!({
                        "top": pl.top, "chosen": pl.chosen, "rank": pl.rank,
                        "turnEnd": round2(pl.turn_end), "value": pl.value.map(round2),
                        "steps": actions_json(&pl.steps),
                        "text": texts(root, &pl.steps, p),
                        "full": texts(root, &pl.full, p),
                        "used": used_of(root, &pl.full),
                    }),
                });
            }
            row["terminals"] = json!(sv.terminals);
            match prep.plans.iter().position(|x| x.chosen) {
                None => prep.skip = Some("no-chosen"),
                Some(k) => {
                    prep.ai = k;
                    row["match"] = json!(prep.plans[k].steps.first() == rec.actions.get(i));
                    if prep.plans.len() < 2 {
                        prep.skip = Some("one-plan");
                    }
                }
            }
        }
    }
    row["skip"] = json!(prep.skip);
    row["plans"] = Value::Array(prep.plans.iter().map(|x| x.value.clone()).collect());
    prep.row = row;
    prep.sec = t.elapsed().as_secs_f64();
    prep
}

/// 局面 start（p の自分のターンの最初）から、p が並び plan を選んだとして r 回目の乱数で最後まで打った結果の 1 文字
fn playout(start: &GameState, p: PlayerIndex, plan: &[Action], seed: u32, r: u32) -> char {
    catch_unwind(AssertUnwindSafe(|| {
        reset_lethal();
        reset_exact_lethal_cache();
        let det = determinize(start, p, &mut Rng::new(mix(seed, 1_000_000 + r)), false);
        let first = plan.first()?;
        if !is_legal(&det, first) {
            return None;
        }
        // 並びの各手の後の予想の局面（AI が並びを選んだときと同じく、局面が予想どおりなら続きを打つため）
        let mut steps: Vec<(Action, Rc<GameState>)> = Vec::new();
        let mut t = det.clone();
        for a in plan {
            if matches!(a, Action::EndTurn) || !is_legal(&t, a) {
                break;
            }
            t = apply_legal(&t, a);
            steps.push((a.clone(), Rc::new(t.clone())));
        }
        let x = mix(seed, 2_000_000 + r);
        let mut rng = MatchRng::with_shared(x, x);
        // 最初の判断（候補を選んだ判断）の分を使っておく（後の判断の乱数を、試合で AI が選んだときと同じ並びにする）
        rng.next(&det, p, false);
        let mut me = SearchAgent::new(SearchOptions::default());
        let mut other = SearchAgent::new(SearchOptions::default());
        let mut s = apply_legal(&det, first);
        me.follow_plan(p, steps);
        for _ in 0..10000 {
            if s.phase == Phase::Ended {
                return Some(match s.winner {
                    Some(w) if w == p => '1',
                    Some(_) => '0',
                    None => 'd',
                });
            }
            let legal = legal_actions(&s);
            let a = if acting_player(&s) == p {
                rng.choose(&mut me, &s, &legal)
            } else {
                rng.choose(&mut other, &s, &legal)
            };
            s = apply_legal(&s, &a);
        }
        None
    }))
    .ok()
    .flatten()
    .unwrap_or('x')
}

/// 勝ち負けの 1 文字を勝ちの数に（打てなかったものは None）
fn win_of(c: char) -> Option<f64> {
    match c {
        '1' => Some(1.0),
        '0' => Some(0.0),
        'd' => Some(0.5),
        _ => None,
    }
}

/// 2 つの勝ち負けの列の、両方が打てた回の差（a − b）
fn paired(a: &[char], b: &[char], keep: impl Fn(usize) -> bool) -> Vec<f64> {
    a.iter()
        .zip(b)
        .enumerate()
        .filter(|(r, _)| keep(*r))
        .filter_map(|(_, (x, y))| Some(win_of(*x)? - win_of(*y)?))
        .collect()
}

fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        f64::NAN
    } else {
        xs.iter().sum::<f64>() / xs.len() as f64
    }
}

/// 一段目で、AI の選んだ候補 ai との差（ポイント）が最も大きい候補とその差（同じなら先の候補）
fn best_alt(w: &[Vec<char>], ai: usize) -> Option<(usize, f64)> {
    let mut best: Option<(usize, f64)> = None;
    for (c, wc) in w.iter().enumerate() {
        if c == ai {
            continue;
        }
        let d = mean(&paired(wc, &w[ai], |_| true)) * 100.0;
        if d.is_finite() && best.is_none_or(|(_, b)| d > b) {
            best = Some((c, d));
        }
    }
    best
}

/// 1 試合分の行を作る（局面を選び、候補を作り、一段目・二段目を打つ）
fn run_batch(games: &[u32], cfg: &Cfg) -> Vec<Value> {
    let recs: Vec<GameRec> = parallel_map(games, |&g, _| play_game(g), |_, _, _, _| {});
    let mut picks: Vec<(usize, usize, PlayerIndex)> = Vec::new();
    for (k, rec) in recs.iter().enumerate() {
        for &(i, p) in &rec.starts {
            if sampled(rec.g, i, cfg.rate) {
                picks.push((k, i, p));
            }
        }
    }
    let mut preps: Vec<Prep> = parallel_map(
        &picks,
        |&(k, i, p), _| prepare(&recs, k, i, p, cfg),
        |_, _, _, _| {},
    );
    // 一段目: 候補ごとに m 回（どの候補も r 回目は同じ乱数）
    let items: Vec<(usize, u32)> = preps
        .iter()
        .enumerate()
        .filter(|(_, x)| x.skip.is_none())
        .flat_map(|(k, _)| (0..cfg.m).map(move |r| (k, r)))
        .collect();
    let plans: Vec<Vec<Vec<Action>>> = preps
        .iter()
        .map(|x| x.plans.iter().map(|pl| pl.steps.clone()).collect())
        .collect();
    let meta: Vec<(usize, usize, PlayerIndex, u32)> =
        preps.iter().map(|x| (x.rec, x.i, x.p, x.seed)).collect();
    let res1: Vec<(Vec<char>, f64)> = parallel_map(
        &items,
        |&(k, r), _| {
            let t = Instant::now();
            let (rec, i, p, seed) = meta[k];
            let (s, _) = rebuild(&recs[rec], i);
            let out = plans[k]
                .iter()
                .map(|pl| playout(&s, p, pl, seed, r))
                .collect();
            (out, t.elapsed().as_secs_f64())
        },
        |_, _, _, _| {},
    );
    let mut w1: Vec<Vec<Vec<char>>> = preps
        .iter()
        .map(|x| vec![Vec::new(); x.plans.len()])
        .collect();
    let mut rollouts = vec![0u32; preps.len()];
    for (&(k, _), (out, sec)) in items.iter().zip(&res1) {
        for (c, ch) in out.iter().enumerate() {
            w1[k][c].push(*ch);
        }
        preps[k].sec += sec;
        rollouts[k] += out.len() as u32;
    }
    // 二段目: 一段目で差が --flag 以上の候補と、AI の選んだ候補を、別の乱数で --confirm 回
    let mut flagged: Vec<(usize, usize, f64)> = Vec::new();
    for (k, x) in preps.iter().enumerate() {
        if x.skip.is_some() {
            continue;
        }
        if let Some((c, d)) = best_alt(&w1[k], x.ai) {
            if d >= cfg.flag {
                flagged.push((k, c, d));
            }
        }
    }
    let items2: Vec<(usize, usize, u32)> = flagged
        .iter()
        .flat_map(|&(k, c, _)| (cfg.m..cfg.m + cfg.confirm).map(move |r| (k, c, r)))
        .collect();
    let ais: Vec<usize> = preps.iter().map(|x| x.ai).collect();
    let res2: Vec<([char; 2], f64)> = parallel_map(
        &items2,
        |&(k, c, r), _| {
            let t = Instant::now();
            let (rec, i, p, seed) = meta[k];
            let (s, _) = rebuild(&recs[rec], i);
            let a = playout(&s, p, &plans[k][ais[k]], seed, r);
            let b = playout(&s, p, &plans[k][c], seed, r);
            ([a, b], t.elapsed().as_secs_f64())
        },
        |_, _, _, _| {},
    );
    let mut w2: BTreeMap<usize, (usize, f64, String, String)> = BTreeMap::new();
    for &(k, c, d) in &flagged {
        w2.insert(k, (c, d, String::new(), String::new()));
    }
    for (&(k, _, _), (pair, sec)) in items2.iter().zip(&res2) {
        let e = w2.get_mut(&k).expect("二段目の局面");
        e.2.push(pair[0]);
        e.3.push(pair[1]);
        preps[k].sec += sec;
        rollouts[k] += 2;
    }
    let mut rows = Vec::new();
    for (k, x) in preps.into_iter().enumerate() {
        let mut row = x.row;
        if x.skip.is_none() {
            row["ai"] = json!(x.ai);
            row["m"] = json!(cfg.m);
            row["w"] = json!(w1[k]
                .iter()
                .map(|v| v.iter().collect::<String>())
                .collect::<Vec<_>>());
            row["confirm"] = match w2.get(&k) {
                Some((c, d, a, b)) => {
                    json!({ "c": c, "d1": round2(*d), "n": cfg.confirm, "ai": a, "alt": b })
                }
                None => Value::Null,
            };
        }
        row["rollouts"] = json!(rollouts[k]);
        row["sec"] = round2(x.sec);
        rows.push(row);
    }
    let (_, _, commit, _) = ledger::context();
    for rec in &recs {
        let n = |q: PlayerIndex| rec.starts.iter().filter(|x| x.1 == q).count();
        rows.push(json!({
            "game": true, "g": rec.g, "seed": rec.seed,
            "decks": [deck_name(&rec.decks[0]), deck_name(&rec.decks[1])],
            "turnStarts": [n(0), n(1)],
            "sampled": picks.iter().filter(|x| recs[x.0].g == rec.g).count(),
            "winner": rec.winner, "actions": rec.actions.len(), "sec": round2(rec.sec),
            "rate": cfg.rate, "m": cfg.m, "extra": cfg.extra, "confirm": cfg.confirm, "flag": cfg.flag,
            "commit": commit, "machine": ledger::machine(), "threads": thread_count(),
        }));
    }
    rows
}

fn float_flag(flags: &[(String, String)], k: &str, def: f64) -> Result<f64, String> {
    match flag(flags, k) {
        None => Ok(def),
        Some(v) => v
            .parse::<f64>()
            .ok()
            .filter(|x| x.is_finite() && *x >= 0.0)
            .ok_or_else(|| format!("--{k} は 0 以上の数: {v}")),
    }
}

/// svwb survey run
fn run(argv: &[String]) -> Result<(), String> {
    let (flags, rest) = parse_flags(argv)?;
    if !rest.is_empty() {
        return Err(format!("不明な引数: {}", rest.join(" ")));
    }
    check_flags(
        &flags,
        &[
            "out", "games", "rate", "m", "extra", "confirm", "flag", "batch",
        ],
    )?;
    let out = flag(&flags, "out").ok_or("--out を渡してください")?;
    let (a, b) = parse_range(flag(&flags, "games").ok_or("--games a-b を渡してください")?)?;
    if a < 0 || b < a {
        return Err("--games は 0 以上の a-b（a ≤ b）".into());
    }
    let cfg = Cfg {
        rate: float_flag(&flags, "rate", 0.1)?.min(1.0),
        m: num_flag(&flags, "m", 32)?.max(2),
        extra: num_flag(&flags, "extra", 4)? as usize,
        confirm: num_flag(&flags, "confirm", 96)?,
        flag: float_flag(&flags, "flag", 10.0)?,
    };
    let batch = num_flag(&flags, "batch", 8)?.max(1) as usize;
    let mut done: HashSet<u64> = HashSet::new();
    if std::path::Path::new(out).exists() {
        let rows = read_rows(out)?;
        for v in rows.iter().filter(|v| v["game"] == json!(true)) {
            done.insert(v["g"].as_u64().unwrap_or(u64::MAX));
        }
        let keep: Vec<&Value> = rows
            .iter()
            .filter(|v| done.contains(&v["g"].as_u64().unwrap_or(u64::MAX)))
            .collect();
        if keep.len() != rows.len() || !ends_cleanly(out) {
            let text: String = keep.iter().map(|v| format!("{v}\n")).collect();
            std::fs::write(out, text).map_err(|e| format!("{out} に書けません: {e}"))?;
        }
    }
    let games: Vec<u32> = (a as u32..=b as u32)
        .filter(|g| !done.contains(&(*g as u64)))
        .collect();
    println!(
        "試合 g{a}〜{b} のうち残り {}（済み {}）、局面の割合 {}、一段目 {} 回・候補の足し {}・二段目 {} 回（差 {} ポイント以上）、{} スレッド",
        games.len(),
        done.len(),
        cfg.rate,
        cfg.m,
        cfg.extra,
        cfg.confirm,
        cfg.flag,
        thread_count()
    );
    let mut file = open_append(out)?;
    let t0 = Instant::now();
    let mut positions = 0;
    // まとめる試合の数をそろえる（17 試合を 8・8・1 でなく 6・6・5 に。端の小さなまとまりでスレッドが余らないように）
    let size = games
        .len()
        .div_ceil(games.len().div_ceil(batch).max(1))
        .max(1);
    for (n, chunk) in games.chunks(size).enumerate() {
        let rows = run_batch(chunk, &cfg);
        positions += rows.iter().filter(|v| v["game"] != json!(true)).count();
        let text: String = rows.iter().map(|v| format!("{v}\n")).collect();
        file.write_all(text.as_bytes())
            .and_then(|_| file.flush())
            .map_err(|e| format!("{out} に書けません: {e}"))?;
        let finished = ((n + 1) * size).min(games.len());
        let sec = t0.elapsed().as_secs_f64();
        eprintln!(
            "試合 {finished}/{}・局面 {positions}（{} 秒、残り約 {} 分）",
            games.len(),
            fixed(sec, 0),
            fixed(
                sec / finished as f64 * (games.len() - finished) as f64 / 60.0,
                0
            )
        );
    }
    println!(
        "完了: 試合 {}・局面 {positions}、{} 秒",
        games.len(),
        fixed(t0.elapsed().as_secs_f64(), 0)
    );
    Ok(())
}

// ---------------------------------------------------------------- report

/// 局面の行を読んだもの
struct PosRow {
    v: Value,
    skip: bool,
    ai: usize,
    top: Vec<bool>,
    w: Vec<Vec<char>>,
    /// 二段目の差（ポイント）と標準誤差、候補
    confirm: Option<(usize, f64, f64)>,
}

fn chars(v: &Value) -> Vec<char> {
    v.as_str().unwrap_or("").chars().collect()
}

fn pos_row(v: Value) -> PosRow {
    let plans = v["plans"].as_array().cloned().unwrap_or_default();
    let top = plans.iter().map(|x| x["top"] == json!(true)).collect();
    let w: Vec<Vec<char>> = v["w"]
        .as_array()
        .map(|a| a.iter().map(chars).collect())
        .unwrap_or_default();
    let skip = !v["skip"].is_null() || w.len() < 2;
    let ai = v["ai"].as_u64().unwrap_or(0) as usize;
    let confirm = (!v["confirm"].is_null()).then(|| {
        let c = &v["confirm"];
        let d = paired(&chars(&c["alt"]), &chars(&c["ai"]), |_| true);
        let (m, se) = mean_se(&d);
        (c["c"].as_u64().unwrap_or(0) as usize, m * 100.0, se * 100.0)
    });
    PosRow {
        v,
        skip,
        ai,
        top,
        w,
        confirm,
    }
}

/// 回を半分に分け、片方で選んで（勝ちの多い候補。同じなら AI の選んだ候補、次に先の候補）もう片方で測った、AI の選んだ候補との差（0〜1）。
/// 偶数回で選んで奇数回で測ったものと、その逆の平均。set は選べる候補（AI の選んだ候補を含む）
pub(crate) fn split_gain(w: &[Vec<char>], ai: usize, set: &[usize]) -> f64 {
    let mut gains = Vec::new();
    for parity in 0..2 {
        let pick = |r: usize| r % 2 == parity;
        let measure = |r: usize| r % 2 != parity;
        let score = |c: usize| {
            let xs: Vec<f64> = w[c]
                .iter()
                .enumerate()
                .filter(|(r, _)| pick(*r))
                .filter_map(|(_, ch)| win_of(*ch))
                .collect();
            mean(&xs)
        };
        let mut sel = ai;
        let mut best = score(ai);
        for &c in set {
            let s = score(c);
            if s.is_finite() && (!best.is_finite() || s > best + 1e-12) {
                sel = c;
                best = s;
            }
        }
        let d = mean(&paired(&w[sel], &w[ai], measure));
        gains.push(if d.is_finite() { d } else { 0.0 });
    }
    mean(&gains)
}

/// 手の種類（AI の選んだ並びと比べた候補の並びの違い。ビームの終局面までの並びで使ったもので見る）
fn kind_of(ai_used: &[String], alt_used: &[String]) -> &'static str {
    let only = |xs: &[String], pre: &[&str]| -> Vec<String> {
        xs.iter()
            .filter(|x| pre.iter().any(|p| x.starts_with(p)))
            .cloned()
            .collect()
    };
    let differ = |pre: &[&str]| {
        let (a, b) = (only(ai_used, pre), only(alt_used, pre));
        !multiset_minus(&a, &b).is_empty() || !multiset_minus(&b, &a).is_empty()
    };
    if differ(&["プレイ "]) {
        "出すカードが違う"
    } else if differ(&["進化 ", "超進化 "]) {
        "進化・超進化が違う"
    } else if differ(&["融合 ", "能力 ", "エクストラPP"]) {
        "融合・能力・エクストラPPが違う"
    } else {
        "攻撃先・手の順番だけが違う"
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn pm(m: f64, se: f64, f: usize) -> String {
    if m.is_nan() {
        "-".into()
    } else if se.is_nan() {
        fixed(m, f)
    } else {
        format!("{} ± {}", fixed(m, f), fixed(se, f))
    }
}

/// 局面の行 r が、はっきりした見落とし（二段目の差が MISS_POINTS 以上で、標準誤差の MISS_Z 倍以上）か
fn is_miss(r: &PosRow) -> bool {
    matches!(r.confirm, Some((_, d, se)) if d >= MISS_POINTS && (se.is_nan() || d >= MISS_Z * se))
}

/// svwb survey report
fn report(argv: &[String]) -> Result<(), String> {
    let mut args = argv.to_vec();
    let no_ledger = ledger::take_no_ledger(&mut args);
    let (flags, files) = parse_flags(&args)?;
    check_flags(&flags, &["label", "top", "states"])?;
    if files.is_empty() {
        return Err("調査の結果（jsonl）を 1 つ以上渡してください".into());
    }
    let label = flag(&flags, "label").unwrap_or("").to_string();
    let top_n = num_flag(&flags, "top", 20)? as usize;
    let mut games: BTreeMap<u64, Value> = BTreeMap::new();
    let mut pos: BTreeMap<(u64, u64), Value> = BTreeMap::new();
    for f in &files {
        for v in read_rows(f)? {
            let g = v["g"].as_u64().unwrap_or(u64::MAX);
            if v["game"] == json!(true) {
                games.insert(g, v);
            } else {
                pos.insert((g, v["i"].as_u64().unwrap_or(u64::MAX)), v);
            }
        }
    }
    // 試合の行の無い局面（途中で止めたもの）は数えない
    let rows: Vec<PosRow> = pos
        .into_iter()
        .filter(|((g, _), _)| games.contains_key(g))
        .map(|(_, v)| pos_row(v))
        .collect();
    let n_games = games.len();
    if n_games == 0 {
        return Err("試合の行がありません".into());
    }
    let turn_starts: u64 = games
        .values()
        .map(|g| strs_u(&g["turnStarts"]).iter().sum::<u64>())
        .sum();
    let per_seat = turn_starts as f64 / (2.0 * n_games as f64);
    let n = rows.len();
    let gains = |set_of: &dyn Fn(&PosRow) -> Vec<usize>| -> Vec<f64> {
        rows.iter()
            .map(|r| {
                if r.skip {
                    0.0
                } else {
                    split_gain(&r.w, r.ai, &set_of(r)) * 100.0
                }
            })
            .collect()
    };
    let top_set = |r: &PosRow| -> Vec<usize> { (0..r.w.len()).filter(|&c| r.top[c]).collect() };
    let all_set = |r: &PosRow| -> Vec<usize> { (0..r.w.len()).collect() };
    let g4 = gains(&top_set);
    let g8 = gains(&all_set);
    let (m4, se4) = mean_se(&g4);
    let (m8, se8) = mean_se(&g8);
    // 二段目で測る得（試しの後、本番の前に足した決まり。docs/survey.md）: 一段目の回の全部で選び（AI の選んだ候補との差が
    // 最も大きい候補の差が --flag 以上ならその候補、でなければ AI の選んだ候補）、選ぶのに使っていない二段目の回で測る。二段目に回らない局面は 0
    let stage2 = |extra_only: bool| -> Vec<f64> {
        rows.iter()
            .map(|r| match r.confirm {
                Some((c, d, _))
                    if d.is_finite() && (!extra_only || !r.top.get(c).copied().unwrap_or(true)) =>
                {
                    d
                }
                _ => 0.0,
            })
            .collect()
    };
    let (m2, se2) = mean_se(&stage2(false));
    let (m2x, se2x) = mean_se(&stage2(true));
    let compared: Vec<&PosRow> = rows.iter().filter(|r| !r.skip).collect();
    let misses: Vec<&PosRow> = rows.iter().filter(|r| is_miss(r)).collect();
    let flagged = rows.iter().filter(|r| r.confirm.is_some()).count();
    let miss_rate = misses.len() as f64 / n.max(1) as f64;
    let miss_se = (miss_rate * (1.0 - miss_rate) / n.max(1) as f64).sqrt();
    // 候補どうしで勝ち負けが割れる割合と、1 局面の差（AI の選んだ候補と別の候補 1 つ）の標準誤差
    let mut split_any = Vec::new();
    let mut split_pair = Vec::new();
    let mut pair_se = Vec::new();
    for r in &compared {
        let m = r.w[r.ai].len();
        for t in 0..m {
            let vals: Vec<f64> = r.w.iter().filter_map(|w| win_of(*w.get(t)?)).collect();
            if vals.len() >= 2 {
                split_any.push(if vals.iter().any(|x| (x - vals[0]).abs() > 1e-9) {
                    1.0
                } else {
                    0.0
                });
            }
        }
        for c in 0..r.w.len() {
            if c == r.ai {
                continue;
            }
            let d = paired(&r.w[c], &r.w[r.ai], |_| true);
            split_pair.extend(d.iter().map(|x| if x.abs() > 1e-9 { 1.0 } else { 0.0 }));
            let (_, se) = mean_se(&d);
            if se.is_finite() {
                pair_se.push(se * 100.0);
            }
        }
    }
    let sec: f64 = rows
        .iter()
        .map(|r| r.v["sec"].as_f64().unwrap_or(0.0))
        .sum();
    let n_roll: f64 = rows
        .iter()
        .map(|r| r.v["rollouts"].as_f64().unwrap_or(0.0))
        .sum();
    let skips = |k: &str| rows.iter().filter(|r| r.v["skip"] == json!(k)).count();
    let mism = rows.iter().filter(|r| r.v["match"] == json!(false)).count();
    let illegal: usize = compared
        .iter()
        .map(|r| r.w.iter().flatten().filter(|c| **c == 'x').count())
        .sum();
    let first_game = *games.keys().next().unwrap_or(&0);
    let last_game = *games.keys().last().unwrap_or(&0);
    let cfg0 = games.values().next().cloned().unwrap_or(Value::Null);

    let mut out = String::new();
    let mut line = |s: String| {
        out.push_str(&s);
        out.push('\n');
    };
    line("# 候補の打ち比べ調査".into());
    line(String::new());
    line(format!(
        "試合 {n_games}（g{first_game}〜{last_game}）、自分のターンの最初の局面 {turn_starts}（1 試合 1 席あたり {}）、選んだ局面 {n}（割合 {}）。一段目 {} 回・二段目 {} 回（差 {} ポイント以上）",
        fixed(per_seat, 2),
        cfg0["rate"],
        cfg0["m"],
        cfg0["confirm"],
        cfg0["flag"],
    ));
    line(format!(
        "打ち比べた局面 {}（リーサル {}、打てる手が 1 つ {}、候補が 1 つ {}、AI の手が候補に無い {}）。試合で打った手と違う手を選んだ局面 {mism}、打てなかった・途中で止まった回 {illegal}",
        compared.len(),
        skips("lethal"),
        skips("one-action"),
        skips("one-plan"),
        skips("no-chosen"),
    ));
    line(String::new());
    line("## 打ち比べで選び直す得".into());
    line(String::new());
    line("AI の選んだ候補との勝率の差（ポイント）。打ち比べなかった局面は 0。1 試合あたりは、1 局面あたり × 1 試合 1 席の局面の数（片方の席が全部の自分のターンで選び直したときの見積もり。局面どうしの重なりは見ない）".into());
    line(String::new());
    line(format!(
        "二段目で測る得（試しの後に足した決まり）: 一段目の {} 回で、差の最も大きい候補の差が {} ポイント以上なら選び直し、二段目の {} 回で測る",
        cfg0["m"], cfg0["flag"], cfg0["confirm"]
    ));
    line(String::new());
    line("| 選び直し | 1 局面あたり | 1 試合あたり |".into());
    line("| --- | ---: | ---: |".into());
    line(format!(
        "| 全部の候補から（二段目で測る） | {} | {} |",
        pm(m2, se2, 2),
        pm(m2 * per_seat, se2 * per_seat, 2)
    ));
    line(format!(
        "| うち足した候補を選んだ局面の分 | {} | {} |",
        pm(m2x, se2x, 2),
        pm(m2x * per_seat, se2x * per_seat, 2)
    ));
    line(String::new());
    line(format!(
        "半分の回で選ぶ得（回す前に決めた決まり）: 一段目の {} 回を偶数回と奇数回に分け、片方で勝ちの最も多い候補を選び、もう片方で測る",
        cfg0["m"]
    ));
    line(String::new());
    line("| 候補 | 1 局面あたり | 1 試合あたり |".into());
    line("| --- | ---: | ---: |".into());
    line(format!(
        "| AI が読み直す候補だけ | {} | {} |",
        pm(m4, se4, 2),
        pm(m4 * per_seat, se4 * per_seat, 2)
    ));
    line(format!(
        "| ＋ 使うカードの組が違う並び | {} | {} |",
        pm(m8, se8, 2),
        pm(m8 * per_seat, se8 * per_seat, 2)
    ));
    let d84: Vec<f64> = g8.iter().zip(&g4).map(|(a, b)| a - b).collect();
    let (md, sed) = mean_se(&d84);
    line(format!(
        "| 差（足した候補の分） | {} | {} |",
        pm(md, sed, 2),
        pm(md * per_seat, sed * per_seat, 2)
    ));
    line(String::new());
    line("## はっきりした見落とし".into());
    line(String::new());
    line(format!(
        "二段目の差が {MISS_POINTS} ポイント以上で、標準誤差の {MISS_Z} 倍以上の局面: {}（選んだ局面の {}、1 試合 1 席あたり {}）。一段目で二段目に回した局面 {flagged}",
        misses.len(),
        pm(miss_rate * 100.0, miss_se * 100.0, 1) + "%",
        pm(miss_rate * per_seat, miss_se * per_seat, 3),
    ));
    let conf: Vec<f64> = rows.iter().filter_map(|r| r.confirm.map(|x| x.1)).collect();
    let (mc, sec_c) = mean_se(&conf);
    line(format!(
        "二段目に回した局面の、二段目の差の平均: {} ポイント（一段目の差の平均 {}）",
        pm(mc, sec_c, 1),
        fixed(
            mean(
                &rows
                    .iter()
                    .filter_map(|r| r.v["confirm"]["d1"].as_f64())
                    .collect::<Vec<_>>()
            ),
            1
        )
    ));
    line(String::new());
    line("## ぶれと時間".into());
    line(String::new());
    line(format!(
        "- 同じ回で候補どうしの勝ち負けが割れる割合: どれか 1 組でも {}、AI の選んだ候補と別の候補 1 つで {}",
        pct_of(&split_any),
        pct_of(&split_pair)
    ));
    line(format!(
        "- 1 局面の差（AI の選んだ候補と別の候補 1 つ、一段目の {} 回）の標準誤差: 平均 {} ポイント",
        cfg0["m"],
        fixed(mean(&pair_se), 1)
    ));
    line(format!(
        "- 続き 1 試合 {} 秒（スレッド 1 本の秒。{} 回）、1 局面 {} 秒（候補を作る時間を含む）",
        fixed(sec / n_roll.max(1.0), 2),
        n_roll,
        fixed(sec / n.max(1) as f64, 1)
    ));
    line(String::new());
    // 内訳
    let breakdown = |title: &str, key: &dyn Fn(&PosRow) -> String, line: &mut dyn FnMut(String)| {
        let mut groups: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for (k, r) in rows.iter().enumerate() {
            groups.entry(key(r)).or_default().push(k);
        }
        line(format!("### {title}"));
        line(String::new());
        line("| | 局面 | 打ち比べた | 得（全部の候補、1 局面） | AI が読み直す候補だけ | はっきりした見落とし |".into());
        line("| --- | ---: | ---: | ---: | ---: | ---: |".into());
        for (name, ks) in groups {
            let a: Vec<f64> = ks.iter().map(|&k| g8[k]).collect();
            let b: Vec<f64> = ks.iter().map(|&k| g4[k]).collect();
            let (ma, sa) = mean_se(&a);
            let (mb, sb) = mean_se(&b);
            line(format!(
                "| {name} | {} | {} | {} | {} | {} |",
                ks.len(),
                ks.iter().filter(|&&k| !rows[k].skip).count(),
                pm(ma, sa, 2),
                pm(mb, sb, 2),
                ks.iter().filter(|&&k| is_miss(&rows[k])).count()
            ));
        }
        line(String::new());
    };
    let mut body = String::new();
    {
        let mut l = |s: String| {
            body.push_str(&s);
            body.push('\n');
        };
        l("## 内訳".into());
        l(String::new());
        breakdown(
            "デッキ（手番の側）",
            &|r| r.v["deck"].as_str().unwrap_or("?").to_string(),
            &mut l,
        );
        breakdown(
            "自分のターン",
            &|r| {
                let t = r.v["own"].as_i64().unwrap_or(0);
                match t {
                    ..=3 => "a: 1〜3".into(),
                    4..=6 => "b: 4〜6".into(),
                    7..=9 => "c: 7〜9".into(),
                    _ => "d: 10〜".into(),
                }
            },
            &mut l,
        );
        breakdown(
            "手の種類（全部の回で勝ちが最も多い候補と AI の選んだ候補の違い）",
            &|r| best_kind(r),
            &mut l,
        );
    }
    out.push_str(&body);
    // 問題集に足す候補
    let mut list: Vec<&PosRow> = misses.clone();
    list.sort_by(|a, b| {
        let d = |r: &PosRow| r.confirm.map_or(0.0, |x| x.1);
        d(b).partial_cmp(&d(a)).unwrap_or(std::cmp::Ordering::Equal)
    });
    out.push_str(&format!(
        "## 問題集に足す局面の候補（はっきりした見落とし、差の大きい順に {} まで）\n\n",
        top_n
    ));
    if let Some(dir) = flag(&flags, "states") {
        std::fs::create_dir_all(dir).map_err(|e| format!("{dir} を作れません: {e}"))?;
    }
    for r in list.iter().take(top_n) {
        let (c, d, se) = r.confirm.expect("二段目");
        let plans = r.v["plans"].as_array().cloned().unwrap_or_default();
        let (ai, alt) = (&plans[r.ai], &plans[c]);
        let g = r.v["g"].as_u64().unwrap_or(0);
        let i = r.v["i"].as_u64().unwrap_or(0);
        out.push_str(&format!(
            "### 試合 {g} の {i} 手目（{}、自分のターン {}、{}）: 差 {} ポイント\n\n",
            r.v["deck"].as_str().unwrap_or("?"),
            r.v["own"],
            if alt["top"] == json!(true) {
                "AI が読み直した候補"
            } else {
                "足した候補"
            },
            pm(d, se, 1)
        ));
        for l in strs(&r.v["view"]) {
            out.push_str(&format!("- {l}\n"));
        }
        out.push_str(&format!(
            "- AI の手（ターン末 {}・順位 {}）: {}\n",
            ai["turnEnd"],
            ai["rank"],
            strs(&ai["full"]).join(" → ")
        ));
        out.push_str(&format!(
            "- 打ち比べで良い手（ターン末 {}・順位 {}）: {}\n",
            alt["turnEnd"],
            alt["rank"],
            strs(&alt["full"]).join(" → ")
        ));
        let (au, bu) = (strs(&ai["used"]), strs(&alt["used"]));
        out.push_str(&format!(
            "- 違い: 良い手だけ {}／AI の手だけ {}\n\n",
            join_or(&multiset_minus(&bu, &au)),
            join_or(&multiset_minus(&au, &bu))
        ));
        if let Some(dir) = flag(&flags, "states") {
            let f = format!("{dir}/g{g}-i{i}.json");
            std::fs::write(&f, r.v["state"].to_string() + "\n")
                .map_err(|e| format!("{f} に書けません: {e}"))?;
        }
    }
    print!("{out}");
    if !no_ledger {
        let mut cmd = vec!["survey".to_string(), "report".to_string()];
        cmd.extend(argv.iter().filter(|a| *a != "--no-ledger").cloned());
        let machines: Vec<String> = games
            .values()
            .filter_map(|g| g["machine"].as_str().map(String::from))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let commits: Vec<String> = games
            .values()
            .filter_map(|g| g["commit"].as_str().map(String::from))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let num = Json::Num;
        let r6 = |x: f64| {
            if x.is_finite() {
                num((x * 1e4).round() / 1e4)
            } else {
                Json::Null
            }
        };
        let pair = |m: f64, se: f64| Json::Arr(vec![r6(m), r6(se)]);
        ledger::append_survey(
            &label,
            vec![
                ("a".into(), Json::Obj(Vec::new())),
                (
                    "g".into(),
                    Json::Arr(vec![num(first_game as f64), num(last_game as f64)]),
                ),
                ("games".into(), num(n_games as f64)),
                ("rate".into(), r6(cfg0["rate"].as_f64().unwrap_or(f64::NAN))),
                ("m".into(), r6(cfg0["m"].as_f64().unwrap_or(f64::NAN))),
                (
                    "extra".into(),
                    r6(cfg0["extra"].as_f64().unwrap_or(f64::NAN)),
                ),
                (
                    "confirm".into(),
                    r6(cfg0["confirm"].as_f64().unwrap_or(f64::NAN)),
                ),
                ("flag".into(), r6(cfg0["flag"].as_f64().unwrap_or(f64::NAN))),
                ("turnStarts".into(), num(turn_starts as f64)),
                ("positions".into(), num(n as f64)),
                ("compared".into(), num(compared.len() as f64)),
                ("gain4".into(), pair(m4 * per_seat, se4 * per_seat)),
                ("gain8".into(), pair(m8 * per_seat, se8 * per_seat)),
                ("gain2".into(), pair(m2 * per_seat, se2 * per_seat)),
                ("gain2Extra".into(), pair(m2x * per_seat, se2x * per_seat)),
                ("flagged".into(), num(flagged as f64)),
                ("misses".into(), num(misses.len() as f64)),
                (
                    "missesPerGame".into(),
                    pair(miss_rate * per_seat, miss_se * per_seat),
                ),
                ("splitAny".into(), r6(mean(&split_any))),
                ("splitPair".into(), r6(mean(&split_pair))),
                ("pairSe".into(), r6(mean(&pair_se))),
                ("perRollout".into(), r6(sec / n_roll.max(1.0))),
                ("seconds".into(), r6((sec * 10.0).round() / 10.0)),
                (
                    "machines".into(),
                    Json::Arr(machines.into_iter().map(Json::Str).collect()),
                ),
                (
                    "commits".into(),
                    Json::Arr(commits.into_iter().map(Json::Str).collect()),
                ),
                ("cmd".into(), Json::Str(ledger::shell_line(&cmd))),
            ],
        );
    }
    Ok(())
}

fn strs_u(v: &Value) -> Vec<u64> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_u64()).collect())
        .unwrap_or_default()
}

fn pct_of(xs: &[f64]) -> String {
    if xs.is_empty() {
        "-".into()
    } else {
        format!("{}%", fixed(mean(xs) * 100.0, 1))
    }
}

fn join_or(v: &[String]) -> String {
    if v.is_empty() {
        "なし".into()
    } else {
        v.join("、")
    }
}

/// 全部の回で勝ちが最も多い候補（同じなら AI の選んだ候補）と、AI の選んだ候補の違いの種類
fn best_kind(r: &PosRow) -> String {
    if r.skip {
        return "z: 打ち比べていない".into();
    }
    let score = |c: usize| mean(&r.w[c].iter().filter_map(|x| win_of(*x)).collect::<Vec<_>>());
    let mut best = r.ai;
    for c in 0..r.w.len() {
        if score(c) > score(best) + 1e-12 {
            best = c;
        }
    }
    if best == r.ai {
        return "y: AI の選んだ候補が最も多く勝つ".into();
    }
    let plans = r.v["plans"].as_array().cloned().unwrap_or_default();
    let kind = kind_of(&strs(&plans[r.ai]["used"]), &strs(&plans[best]["used"]));
    format!(
        "{}（{}）",
        kind,
        if r.top[best] {
            "読み直した候補"
        } else {
            "足した候補"
        }
    )
}

pub fn main(argv: &[String]) -> Result<(), String> {
    match argv.first().map(|s| s.as_str()) {
        Some("run") => run(&argv[1..]),
        Some("report") => report(&argv[1..]),
        _ => Err("使い方: svwb survey run --out <結果.jsonl> --games a-b [--rate 0.1] [--m 32] [--extra 4] [--confirm 96] [--flag 10] [--batch 8] | survey report <結果.jsonl>… [--label 名前] [--no-ledger] [--top 20] [--states <フォルダ>]".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(rows: &[&str]) -> Vec<Vec<char>> {
        rows.iter().map(|r| r.chars().collect()).collect()
    }

    #[test]
    fn split_gain_selects_on_one_half_and_measures_on_the_other() {
        // 候補 1 は偶数回だけ勝ち、奇数回は負ける。偶数回で選ぶと候補 1 を選ぶが、奇数回で測ると AI の候補 0 より 0.5 悪い。
        // 奇数回で選ぶと AI の候補（同じなら AI）を選び、差は 0
        let ws = w(&["01010101", "10101010"]);
        let g = split_gain(&ws, 0, &[0, 1]);
        assert!((g - (-0.5)).abs() < 1e-9, "{g}");
        // どの回でも勝つ候補は、どちらの半分でも選ばれて差は 1
        let ws = w(&["0000", "1111"]);
        assert!((split_gain(&ws, 0, &[0, 1]) - 1.0).abs() < 1e-9);
        // 選べる候補に入っていなければ選ばない
        assert_eq!(split_gain(&ws, 0, &[0]), 0.0);
        // 打てなかった回（x）は除く
        let ws = w(&["0x00", "1x11"]);
        assert!((split_gain(&ws, 0, &[0, 1]) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn kinds_compare_used_cards() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            kind_of(&s(&["プレイ A", "進化 B"]), &s(&["プレイ C", "進化 B"])),
            "出すカードが違う"
        );
        assert_eq!(
            kind_of(&s(&["プレイ A", "進化 B"]), &s(&["プレイ A"])),
            "進化・超進化が違う"
        );
        assert_eq!(
            kind_of(&s(&["プレイ A"]), &s(&["プレイ A", "エクストラPP"])),
            "融合・能力・エクストラPPが違う"
        );
        assert_eq!(
            kind_of(&s(&["プレイ A"]), &s(&["プレイ A"])),
            "攻撃先・手の順番だけが違う"
        );
    }

    #[test]
    fn misses_need_both_points_and_z() {
        let row = |d: f64, se: f64| PosRow {
            v: Value::Null,
            skip: false,
            ai: 0,
            top: vec![true, true],
            w: Vec::new(),
            confirm: Some((1, d, se)),
        };
        assert!(is_miss(&row(16.0, 5.0)));
        assert!(!is_miss(&row(14.0, 3.0)));
        assert!(!is_miss(&row(16.0, 6.0)));
    }

    /// 自己対戦の局面を作り直すと試合で打った手を選び、候補は AI の選ぶ手を 1 つだけ含み、打つ手がどれも違う。
    /// 同じ乱数の続きは同じ結果になる
    #[test]
    fn prepares_candidates_from_a_self_play_position() {
        let rec = play_game(3);
        let cfg = Cfg {
            rate: 1.0,
            m: 2,
            extra: 4,
            confirm: 0,
            flag: 10.0,
        };
        let recs = [rec];
        let (i, p) = *recs[0]
            .starts
            .iter()
            .find(|(i, p)| {
                let (s, _) = rebuild(&recs[0], *i);
                s.players[*p].turn_count >= 4 && legal_actions(&s).len() > 3
            })
            .expect("手の多い局面");
        let prep = prepare(&recs, 0, i, p, &cfg);
        assert_eq!(prep.row["match"], json!(true), "{}", prep.row["skip"]);
        assert!(prep.skip.is_none());
        assert_eq!(prep.plans.iter().filter(|x| x.chosen).count(), 1);
        for (a, x) in prep.plans.iter().enumerate() {
            for y in &prep.plans[a + 1..] {
                assert_ne!(x.steps, y.steps);
            }
        }
        let (s, _) = rebuild(&recs[0], i);
        let first = playout(&s, p, &prep.plans[prep.ai].steps, prep.seed, 0);
        assert!(matches!(first, '0' | '1' | 'd'), "{first}");
        assert_eq!(
            playout(&s, p, &prep.plans[prep.ai].steps, prep.seed, 0),
            first
        );
    }
}
