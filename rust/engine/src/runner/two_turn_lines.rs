//! 問題集の問と打ち比べ調査の局面で、2 つの並び（AI の手と、比べる手）に、今の選ぶときの値・次の自分のターン末まで読んだ値・
//! 2 ターン読みの値を付け、どちらが上に来るかを数える（2026-11-28、測定のみ。打つ手は変えない。docs/ai-notes/15「2 ターン読みを新しいプールで測る」）。
//!
//!   svwb two-turn lines --out t.jsonl (--dir misses/azvaldt | --survey <調査.jsonl(.gz)> [--clear 3] [--minDiff 15])
//!                       [--opts '<設定>'] [--m 32] [--reads 12] [--twos 2] [--nextBeam 256] [--seed 1] [--only <名前,…>] [--limit N]
//!   svwb two-turn lines-report t.jsonl… [--group <名前>=<問,…>]… [--gate 10]
//!
//! - **並び**: `--dir` は問（`<dir>/*.json`）と書き添えた調査の並び（`<dir>/lines/<問>.json` の `ai` と `good` の `steps`）。
//!   `--survey` は調査の局面の行のうち、AI の選んだ候補が、AI が読み直す候補（読み直しを打ち切った候補も）のどれかに、
//!   一段目の同じ回どうしの差で `--minDiff` ポイント以上かつ標準誤差の `--clear` 倍以上勝った局面（AI の手が打ち比べではっきり良かった局面）。
//!   比べる手は、その中でターン末の点数の順位がいちばん上の候補（AI がいちばん選びそうな、はっきり悪い手）
//! - **打ち方**: 局面を手番の側から決定化し（`--m` 通り。r 通り目はどの並びも同じ決定化）、並びを、調査の打ち比べと同じく
//!   AI がその並びを選んだものとして打つ（最初の手を打ち、局面が予想どおりなら続きを打つ。並びは最初の引く手・ランダムな手までで、
//!   その先と並びの後は `--opts` の AI が考え直してターン末まで打つ）。ターンを終える手で終わる並びは、そのまま打ってターンを終える（`misses duel` と同じ）。
//!   決定化してから打つので、このターンの引きは知らない（問の局面の山札の順番は使わない）
//! - **値**（引き直しごとの点数を σ(a·点数) で勝率にしてから平均する。a は `--opts` の補正のもの）:
//!   - `pick` 今の選ぶときの値（相手の手札の引き直し `--reads` 通りで読んだ点数とターン末の点数を `rescoreMix` で混ぜる。kifu values の pickWin と同じ形）
//!   - `read` 相手のターンを読んだ後の点数だけ
//!   - `own`・`two` 次の自分のターン末・さらに相手の次のターンを読んだ後（`SearchAgent::two_turn_read`、引き直し `--twos` 通り。次のターンは幅 `--nextBeam`）
//!   - `ownB`・`twoB` その、引きを知らない版（次のターンの最善の並びの最初の引く手の直前で山札と乱数を作り直して組み直す。two_turn_read の own_blind・two_blind）
//! - 局面は問題集と調査の出力からだけ取る（シミュレータの中の試合。CLAUDE.md「ソフト打ち」）

use super::deep_gap::{
    check_flags, ends_cleanly, flag, num_flag, open_append, parse_flags, read_rows,
};
use super::fixed;
use super::human_plan::{mix, step_text};
use super::kifu_cmd::read_text;
use super::options::compare_options;
use super::parallel::parallel_map;
use super::survey::win_of;
use crate::ai::determinize::determinize;
use crate::ai::exact_lethal::reset_exact_lethal_cache;
use crate::ai::lethal::reset_lethal;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::Rng;
use crate::canonical::fnv;
use crate::game::{acting_player, apply_legal, is_legal, legal_actions};
use crate::json::Json;
use crate::sim::MatchRng;
use crate::state::{Action, GameState, Phase, PlayerIndex};
use crate::state_json::{action_from_json, state_from_json};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::time::Instant;

/// 比べる並び 1 つ
struct LineSpec {
    name: String,
    steps: Vec<Action>,
    /// ターンを終える手で終わる並び（そのまま打ってターンを終える）
    fixed: bool,
}

/// 局面 1 つと、比べる並び（最初が AI の手）
struct Task {
    id: String,
    /// 局面（状態の JSON の文字列。局面はスレッドをまたげないので、打つスレッドで読む）
    state: String,
    p: PlayerIndex,
    lines: Vec<LineSpec>,
    /// 出どころの数（打ち比べの勝ち等。報告に出す）
    info: Value,
}

struct Cfg {
    opts: SearchOptions,
    m: u32,
    reads: u32,
    twos: u32,
    next_beam: usize,
    seed: u32,
}

fn steps_of_json(v: &Value) -> Result<Vec<Action>, String> {
    let arr = v.as_array().ok_or("steps が配列ではありません")?;
    arr.iter()
        .map(|a| action_from_json(&Json::parse(&a.to_string())?))
        .collect()
}

fn line_spec(name: &str, steps: Vec<Action>) -> LineSpec {
    let fixed = matches!(steps.last(), Some(Action::EndTurn));
    LineSpec {
        name: name.to_string(),
        steps,
        fixed,
    }
}

/// 問題集の問と、書き添えた調査の並び（ai・good）
fn tasks_of_dir(dir: &str, only: Option<&HashSet<String>>) -> Result<Vec<Task>, String> {
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| format!("{dir} が読めません: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    files.sort();
    let mut out = Vec::new();
    for f in files {
        let v: Value = serde_json::from_str(&read_text(&f)?).map_err(|e| format!("{f}: {e}"))?;
        let id = v["id"]
            .as_str()
            .ok_or(format!("{f}: id がありません"))?
            .to_string();
        if only.is_some_and(|o| !o.contains(&id)) {
            continue;
        }
        let p = v["player"]
            .as_u64()
            .ok_or(format!("{f}: player がありません"))? as PlayerIndex;
        let state = v["state"].to_string();
        let lf = format!("{dir}/lines/{id}.json");
        let lv: Value = serde_json::from_str(&read_text(&lf)?).map_err(|e| format!("{lf}: {e}"))?;
        let ls = lv["lines"]
            .as_array()
            .ok_or(format!("{lf}: lines がありません"))?;
        let find = |kind: &str| ls.iter().find(|l| l["kind"] == kind);
        let (Some(ai), Some(good)) = (find("ai"), find("good")) else {
            return Err(format!("{lf}: ai と good の並びが要ります"));
        };
        let lines = vec![
            line_spec(
                "AI",
                steps_of_json(&ai["steps"]).map_err(|e| format!("{lf}: {e}"))?,
            ),
            line_spec(
                "正解",
                steps_of_json(&good["steps"]).map_err(|e| format!("{lf}: {e}"))?,
            ),
        ];
        out.push(Task {
            id,
            state,
            p,
            lines,
            info: json!({"kind": "misses", "second": [ai["second"].clone(), good["second"].clone()],
                         "hand": [ai.get("hand").is_some(), good.get("hand").is_some()]}),
        });
    }
    Ok(out)
}

/// 同じ回どうしの差 a − b の平均と標準誤差（ポイント）と回の数（どちらかが打てなかった回は外す）
fn paired_chars(a: &str, b: &str) -> Option<(f64, f64, usize)> {
    let d: Vec<f64> = a
        .chars()
        .zip(b.chars())
        .filter_map(|(x, y)| Some(win_of(x)? - win_of(y)?))
        .collect();
    let n = d.len();
    if n < 2 {
        return None;
    }
    let m = d.iter().sum::<f64>() / n as f64;
    let var = d.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / (n - 1) as f64;
    Some((m * 100.0, (var / n as f64).sqrt() * 100.0, n))
}

/// 調査の局面のうち、AI の手が、AI が読み直す候補のどれかに一段目ではっきり勝った局面と、その中で順位のいちばん上の候補
fn tasks_of_survey(
    path: &str,
    clear: f64,
    min_diff: f64,
    only: Option<&HashSet<String>>,
) -> Result<Vec<Task>, String> {
    let mut out = Vec::new();
    for l in read_text(path)?.lines().filter(|l| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(l).map_err(|e| format!("{path}: {e}"))?;
        let Some(plans) = v["plans"].as_array() else {
            continue;
        };
        if !v["skip"].is_null() {
            continue;
        }
        let id = format!("g{}-i{}", v["g"], v["i"]);
        if only.is_some_and(|o| !o.contains(&id)) {
            continue;
        }
        let ai = v["ai"].as_u64().ok_or(format!("{id}: ai がありません"))? as usize;
        let w: Vec<&str> = v["w"]
            .as_array()
            .ok_or(format!("{id}: w がありません"))?
            .iter()
            .map(|x| x.as_str().unwrap_or(""))
            .collect();
        let mut best: Option<(usize, i64, f64, f64)> = None;
        for (k, pl) in plans.iter().enumerate() {
            let readable = pl["top"].as_bool() == Some(true) || pl["cut"].as_bool() == Some(true);
            if k == ai || !readable {
                continue;
            }
            let Some((d, se, _)) = paired_chars(w[ai], w[k]) else {
                continue;
            };
            if d < min_diff || se <= 0.0 || d < clear * se {
                continue;
            }
            let rank = pl["rank"].as_i64().unwrap_or(i64::MAX);
            if best.is_none_or(|b| rank < b.1) {
                best = Some((k, rank, d, se));
            }
        }
        let Some((k, rank, d, se)) = best else {
            continue;
        };
        let p = v["p"].as_u64().ok_or(format!("{id}: p がありません"))? as PlayerIndex;
        let lines = vec![
            line_spec("AI", steps_of_json(&plans[ai]["steps"])?),
            line_spec("比べる手", steps_of_json(&plans[k]["steps"])?),
        ];
        out.push(Task {
            id,
            state: v["state"].to_string(),
            p,
            lines,
            info: json!({"kind": "survey", "d1": d, "se1": se, "k": k, "rank": rank,
                         "cut": plans[k]["cut"], "deck": v["deck"], "opp": v["opp"], "own": v["own"],
                         "value": [plans[ai]["value"], plans[k]["value"]],
                         "turnEnd": [plans[ai]["turnEnd"], plans[k]["turnEnd"]]}),
        });
    }
    Ok(out)
}

/// 決定化した局面 det から、p が並び line を選んだとして、ターンを終える手の直前まで打つ（ターンの途中で決着したらその局面）。
/// 調査の打ち比べ（survey.rs の playout_ends_with）の始めのターンと同じ打ち方
fn play_line(
    det: &GameState,
    p: PlayerIndex,
    line: &LineSpec,
    opts: &SearchOptions,
    seed: u32,
) -> Result<(GameState, Vec<Action>), String> {
    reset_lethal();
    reset_exact_lethal_cache();
    let mut rng = MatchRng::with_shared(seed, seed);
    let mut me = SearchAgent::new(opts.clone());
    let mut other = SearchAgent::new(opts.clone());
    let mut done = Vec::new();
    let mut s;
    if line.fixed {
        s = det.clone();
        for a in &line.steps {
            if s.phase == Phase::Ended {
                return Ok((s, done));
            }
            if matches!(a, Action::EndTurn) {
                return Ok((s, done));
            }
            if !is_legal(&s, a) {
                return Err("決定化した局面で並びの手が打てません".into());
            }
            s = apply_legal(&s, a);
            done.push(a.clone());
        }
    } else {
        let first = line.steps.first().ok_or("並びが空です")?;
        if !is_legal(det, first) {
            return Err("決定化した局面で並びの最初の手が打てません".into());
        }
        if matches!(first, Action::EndTurn) {
            return Ok((det.clone(), done));
        }
        let mut steps: Vec<(Action, Rc<GameState>)> = Vec::new();
        let mut t = det.clone();
        for a in &line.steps {
            if matches!(a, Action::EndTurn) || !is_legal(&t, a) {
                break;
            }
            t = apply_legal(&t, a);
            steps.push((a.clone(), Rc::new(t.clone())));
        }
        rng.next(det, p, false);
        me.follow_plan(p, steps);
        s = apply_legal(det, first);
        done.push(first.clone());
    }
    for _ in 0..500 {
        if s.phase == Phase::Ended {
            return Ok((s, done));
        }
        if s.active != p {
            return Err("ターンを終える手を打たずに相手の番になりました".into());
        }
        let legal = legal_actions(&s);
        let a = if acting_player(&s) == p {
            rng.choose(&mut me, &s, &legal)
        } else {
            rng.choose(&mut other, &s, &legal)
        };
        if matches!(a, Action::EndTurn) {
            return Ok((s, done));
        }
        s = apply_legal(&s, &a);
        done.push(a);
    }
    Err("AI がターンを終えません".into())
}

fn round2(x: f64) -> f64 {
    if x.abs() >= 1e5 {
        x.signum() * 1e6
    } else {
        (x * 100.0).round() / 100.0
    }
}

/// 局面 t の r 通り目（決定化 1 つ）で、並びごとに値を付ける
fn run_unit(t: &Task, r: u32, cfg: &Cfg) -> Result<Value, String> {
    let t0 = Instant::now();
    let start = state_from_json(&Json::parse(&t.state)?)?;
    let p = t.p;
    let base = mix(cfg.seed, u32::from_str_radix(&fnv(&t.id), 16).unwrap_or(0));
    let det = determinize(&start, p, &mut Rng::new(mix(base, 100 + r)), false);
    let scorer = SearchAgent::new(cfg.opts.clone());
    let mix_w = scorer.opts.rescore_mix;
    let read_seeds: Vec<u32> = (0..cfg.reads)
        .map(|j| mix(base, 10_000 + r * 64 + j))
        .collect();
    let mut out = Vec::new();
    for line in &t.lines {
        let res = catch_unwind(AssertUnwindSafe(|| {
            play_line(&det, p, line, &cfg.opts, mix(base, 200 + r))
        }))
        .unwrap_or_else(|_| Err("途中で止まりました（panic）".into()));
        let (end, acts) = match res {
            Ok(x) => x,
            Err(e) => {
                out.push(json!({"name": line.name, "err": e}));
                continue;
            }
        };
        let mut row = json!({"name": line.name, "ended": end.phase == Phase::Ended});
        if end.phase == Phase::Ended {
            let v = if end.winner == Some(p) { 1e6 } else { -1e6 };
            row["won"] = json!(end.winner == Some(p));
            for k in ["pick", "read", "own", "two", "ownB", "twoB"] {
                row[k] = json!([v]);
            }
        } else {
            let scored = catch_unwind(AssertUnwindSafe(|| {
                reset_lethal();
                reset_exact_lethal_cache();
                let reads = scorer.read_values(&end, p, &read_seeds);
                let te = scorer.turn_end_value(&end, p);
                let pick: Vec<f64> = reads
                    .iter()
                    .map(|&x| round2((1.0 - mix_w) * x + mix_w * te))
                    .collect();
                let mut cols: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
                let (mut lethal2, mut chance2) = (0, 0);
                for j in 0..cfg.twos {
                    let tr = scorer.two_turn_read(
                        &end,
                        p,
                        mix(base, 20_000 + r * 64 + j),
                        cfg.next_beam,
                    );
                    cols.entry("read").or_default().push(round2(tr.read));
                    cols.entry("own").or_default().push(round2(tr.own));
                    cols.entry("two").or_default().push(round2(tr.two));
                    cols.entry("ownB").or_default().push(round2(tr.own_blind));
                    cols.entry("twoB").or_default().push(round2(tr.two_blind));
                    lethal2 += tr.next_lethal as u32;
                    chance2 += tr.next_chance as u32;
                }
                (te, pick, cols, lethal2, chance2)
            }));
            let Ok((te, pick, cols, lethal2, chance2)) = scored else {
                out.push(
                    json!({"name": line.name, "err": "値を付ける途中で止まりました（panic）"}),
                );
                continue;
            };
            row["te"] = json!(round2(te));
            row["pick"] = json!(pick);
            for (k, v) in cols {
                row[k] = json!(v);
            }
            row["lethal2"] = json!(lethal2);
            row["chance2"] = json!(chance2);
        }
        if r < 2 {
            let mut s = det.clone();
            let texts: Vec<String> = acts
                .iter()
                .map(|a| {
                    let x = step_text(&s, a, p);
                    s = apply_legal(&s, a);
                    x
                })
                .collect();
            row["steps"] = json!(texts);
        }
        out.push(row);
    }
    Ok(json!({
        "id": t.id, "r": r, "lines": out,
        "sec": (t0.elapsed().as_secs_f64() * 100.0).round() / 100.0,
    }))
}

/// 補正の a（σ(a·点数) の a。設定の valueNet。無ければ既定の補正）
fn scale_of(opts_text: &str) -> Result<f64, String> {
    Ok(match Json::parse(opts_text)?.get("valueNet") {
        Some(Json::Str(path)) => crate::ai::valuenet::ValueNet::load(path)?.a(),
        _ => crate::ai::valuenet::default_value_net().a(),
    })
}

/// svwb two-turn lines
pub fn run(argv: &[String]) -> Result<(), String> {
    let (flags, rest) = parse_flags(argv)?;
    if !rest.is_empty() {
        return Err(format!("不明な引数: {}", rest.join(" ")));
    }
    check_flags(
        &flags,
        &[
            "out", "dir", "survey", "clear", "minDiff", "opts", "m", "reads", "twos", "nextBeam",
            "seed", "only", "limit",
        ],
    )?;
    let out = flag(&flags, "out").ok_or("--out を渡してください")?;
    let opts_text = flag(&flags, "opts").unwrap_or("{}").to_string();
    let cfg = Cfg {
        opts: compare_options(&opts_text)?,
        m: num_flag(&flags, "m", 32)?.max(1),
        reads: num_flag(&flags, "reads", 12)?.max(1),
        twos: num_flag(&flags, "twos", 2)?.max(1),
        next_beam: num_flag(&flags, "nextBeam", 256)?.max(1) as usize,
        seed: num_flag(&flags, "seed", 1)?,
    };
    let only: Option<HashSet<String>> =
        flag(&flags, "only").map(|x| x.split(',').map(str::to_string).collect());
    let float = |k: &str, def: f64| -> Result<f64, String> {
        flag(&flags, k).map_or(Ok(def), |x| {
            x.parse::<f64>().map_err(|_| format!("--{k} は数: {x}"))
        })
    };
    let mut tasks = match (flag(&flags, "dir"), flag(&flags, "survey")) {
        (Some(d), None) => tasks_of_dir(d, only.as_ref())?,
        (None, Some(s)) => tasks_of_survey(
            s,
            float("clear", 3.0)?,
            float("minDiff", 15.0)?,
            only.as_ref(),
        )?,
        _ => return Err("--dir か --survey のどちらか 1 つを渡してください".into()),
    };
    if let Some(n) = flag(&flags, "limit") {
        let n: usize = n.parse().map_err(|_| format!("--limit は整数: {n}"))?;
        tasks.truncate(n);
    }
    if tasks.is_empty() {
        return Err("比べる局面がありません".into());
    }
    let mut done: HashSet<(String, u64)> = HashSet::new();
    if std::path::Path::new(out).exists() {
        let rows = read_rows(out)?;
        for v in &rows {
            if let (Some(s), Some(r)) = (v["id"].as_str(), v["r"].as_u64()) {
                done.insert((s.to_string(), r));
            }
        }
        if !ends_cleanly(out) {
            let text: String = rows.iter().map(|v| format!("{v}\n")).collect();
            std::fs::write(out, text).map_err(|e| format!("{out} に書けません: {e}"))?;
        }
    }
    let mut items: Vec<(usize, u32)> = Vec::new();
    for (i, t) in tasks.iter().enumerate() {
        for r in 0..cfg.m {
            if !done.contains(&(t.id.clone(), r as u64)) {
                items.push((i, r));
            }
        }
    }
    let mut file = open_append(out)?;
    if done.is_empty() {
        let header = json!({
            "config": {"m": cfg.m, "reads": cfg.reads, "twos": cfg.twos, "nextBeam": cfg.next_beam,
                       "seed": cfg.seed, "opts": opts_text, "dir": flag(&flags, "dir"),
                       "survey": flag(&flags, "survey"), "clear": flag(&flags, "clear"), "minDiff": flag(&flags, "minDiff")},
            "a": scale_of(&opts_text)?,
            "tasks": tasks.iter().map(|t| json!({"id": t.id, "p": t.p, "info": t.info,
                "lines": t.lines.iter().map(|l| json!({"name": l.name, "fixed": l.fixed})).collect::<Vec<_>>()})).collect::<Vec<_>>(),
        });
        let _ = writeln!(file, "{header}");
    }
    eprintln!(
        "局面 {}、仕事 {}（済み {}）",
        tasks.len(),
        items.len(),
        done.len()
    );
    let t1 = Instant::now();
    let results = parallel_map(
        &items,
        |&(i, r), _| run_unit(&tasks[i], r, &cfg),
        |n, total, res, _| {
            match res {
                Ok(v) => {
                    let _ = writeln!(file, "{v}");
                }
                Err(e) => eprintln!("{e}"),
            }
            if n % 16 == 0 || n == total {
                let sec = t1.elapsed().as_secs_f64();
                eprintln!(
                    "{n}/{total}（{} 秒、残り約 {} 分）",
                    fixed(sec, 0),
                    fixed(sec / n as f64 * (total - n) as f64 / 60.0, 0)
                );
            }
        },
    );
    let errors = results.iter().filter(|r| r.is_err()).count();
    println!(
        "完了: 仕事 {}（失敗 {errors}）、{} 秒",
        results.len(),
        fixed(t1.elapsed().as_secs_f64(), 0)
    );
    Ok(())
}

// ---------------------------------------------------------------- 報告

/// 値の列（引き直しごとの点数）を勝率（0〜1）の平均に
fn win_mean(v: &Value, a: f64) -> Option<f64> {
    let xs: Vec<f64> = v.as_array()?.iter().filter_map(|x| x.as_f64()).collect();
    if xs.is_empty() {
        return None;
    }
    Some(
        xs.iter()
            .map(|&x| 1.0 / (1.0 + (-a * x).exp()))
            .sum::<f64>()
            / xs.len() as f64,
    )
}

/// 平均と標準誤差
fn mean_se(xs: &[f64]) -> (f64, f64) {
    let n = xs.len() as f64;
    if xs.is_empty() {
        return (f64::NAN, f64::NAN);
    }
    let m = xs.iter().sum::<f64>() / n;
    if xs.len() < 2 {
        return (m, f64::NAN);
    }
    let var = xs.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / (n - 1.0);
    (m, (var / n).sqrt())
}

const KEYS: [(&str, &str); 6] = [
    ("pick", "選ぶときの値"),
    ("read", "読み直し"),
    ("own", "次のターン末"),
    ("ownB", "次のターン末（引きを知らない）"),
    ("two", "2 ターン読み"),
    ("twoB", "2 ターン読み（引きを知らない）"),
];

/// 局面ごとの、指標ごとの差（2 つ目の並び − AI の手。ポイント）の平均と標準誤差と回の数、並びごとの割合
struct Agg {
    id: String,
    diffs: BTreeMap<&'static str, (f64, f64, usize)>,
    /// 並びごとの [次のターンのリーサルの割合, 次のターンの並びに引く手のある割合, 相手のターンの読みで負ける割合, ターンの途中で勝った割合]（%）
    rates: Vec<[f64; 4]>,
    info: Value,
}

fn aggregate(rows: &[Value], tasks: &BTreeMap<String, Value>, a: f64) -> Vec<Agg> {
    let mut by: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for v in rows {
        if let Some(id) = v["id"].as_str() {
            by.entry(id.to_string()).or_default().push(v);
        }
    }
    let mut out = Vec::new();
    for (id, us) in by {
        let mut diffs = BTreeMap::new();
        for (k, _) in KEYS {
            let mut d = Vec::new();
            for u in &us {
                let ls = u["lines"].as_array();
                let (Some(x), Some(y)) = (
                    ls.and_then(|l| l.first()).and_then(|l| win_mean(&l[k], a)),
                    ls.and_then(|l| l.get(1)).and_then(|l| win_mean(&l[k], a)),
                ) else {
                    continue;
                };
                d.push((y - x) * 100.0);
            }
            let (m, se) = mean_se(&d);
            diffs.insert(k, (m, se, d.len()));
        }
        let mut rates = Vec::new();
        for li in 0..2 {
            let (mut leth, mut ch, mut loss, mut won, mut n2, mut n1, mut nu) =
                (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
            for u in &us {
                let Some(l) = u["lines"].as_array().and_then(|l| l.get(li)) else {
                    continue;
                };
                if l.get("err").is_some() {
                    continue;
                }
                nu += 1.0;
                if l["won"].as_bool() == Some(true) {
                    won += 1.0;
                }
                if l["ended"].as_bool() == Some(true) {
                    continue;
                }
                let nt = l["two"].as_array().map_or(0, |x| x.len()) as f64;
                n2 += nt;
                leth += l["lethal2"].as_f64().unwrap_or(0.0);
                ch += l["chance2"].as_f64().unwrap_or(0.0);
                for x in l["read"].as_array().into_iter().flatten() {
                    n1 += 1.0;
                    if x.as_f64().unwrap_or(0.0) <= -1e5 {
                        loss += 1.0;
                    }
                }
            }
            let pct = |x: f64, n: f64| if n > 0.0 { 100.0 * x / n } else { f64::NAN };
            rates.push([pct(leth, n2), pct(ch, n2), pct(loss, n1), pct(won, nu)]);
        }
        out.push(Agg {
            info: tasks.get(&id).cloned().unwrap_or(Value::Null),
            id,
            diffs,
            rates,
        });
    }
    out
}

fn pm(m: f64, se: f64) -> String {
    if m.is_nan() {
        "—".into()
    } else if se.is_nan() {
        format!("{:+.1}", m)
    } else {
        format!("{:+.1} ± {:.1}", m, se)
    }
}

/// 打ち比べの差（2 つ目の並び − AI の手。ポイント）: 問は書き添えた二段目の勝ち、調査は一段目の差（AI − 比べる手）の符号を変えたもの
fn playout_diff(info: &Value) -> Option<f64> {
    match info["kind"].as_str()? {
        "misses" => {
            let s = info["second"].as_array()?;
            let rate = |x: &Value| Some(x["wins"].as_f64()? / x["games"].as_f64()?);
            Some((rate(&s[1])? - rate(&s[0])?) * 100.0)
        }
        "survey" => Some(-info["d1"].as_f64()?),
        _ => None,
    }
}

/// svwb two-turn lines-report
pub fn report(argv: &[String]) -> Result<(), String> {
    let mut groups: Vec<(String, HashSet<String>)> = Vec::new();
    let mut gate = 10.0;
    let mut files = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--group" => {
                let g = argv.get(i + 1).ok_or("--group の値がありません")?;
                let (name, ids) = g.split_once('=').ok_or("--group は <名前>=<問,…>")?;
                groups.push((
                    name.to_string(),
                    ids.split(',').map(str::to_string).collect(),
                ));
                i += 2;
            }
            "--gate" => {
                let g = argv.get(i + 1).ok_or("--gate の値がありません")?;
                gate = g.parse().map_err(|_| format!("--gate は数: {g}"))?;
                i += 2;
            }
            x if x.starts_with("--") => return Err(format!("不明な引数: {x}")),
            x => {
                files.push(x.to_string());
                i += 1;
            }
        }
    }
    if files.is_empty() {
        return Err("結果のファイルを渡してください".into());
    }
    let mut rows = Vec::new();
    let mut tasks: BTreeMap<String, Value> = BTreeMap::new();
    let mut a: Option<f64> = None;
    let mut config = Value::Null;
    for f in &files {
        for v in read_rows(f)? {
            if v.get("tasks").is_some() {
                let x = v["a"].as_f64();
                if a.is_some_and(|y| Some(y) != x) {
                    return Err("補正の違う結果が混ざっています".into());
                }
                a = x;
                config = v["config"].clone();
                for t in v["tasks"].as_array().into_iter().flatten() {
                    if let Some(id) = t["id"].as_str() {
                        tasks.insert(id.to_string(), t["info"].clone());
                    }
                }
            } else {
                rows.push(v);
            }
        }
    }
    let a = a.ok_or("見出しの行（a）がありません")?;
    let aggs = aggregate(&rows, &tasks, a);
    let errors = rows
        .iter()
        .flat_map(|v| v["lines"].as_array().into_iter().flatten())
        .filter(|l| l.get("err").is_some())
        .count();
    println!("# 2 ターン読みで並びを比べる");
    println!();
    println!("設定: `{config}`、a = {a}。打てなかった並び {errors}");
    println!();
    println!("差は 2 つ目の並び（問は正解、調査は比べる手）− AI の手の勝率（ポイント。決定化ごとの差の平均 ± 標準誤差）。");
    println!(
        "割合は AI の手 / 2 つ目の並び（%）。打ち比べは、問は書き添えた二段目、調査は一段目の差"
    );
    println!();
    let mut head = String::from("| 局面 | 回 | 打ち比べ |");
    let mut sep = String::from("| --- | ---: | ---: |");
    for (_, name) in KEYS {
        head += &format!(" {name} |");
        sep += " ---: |";
    }
    head += " 次のターンのリーサル | 次のターンに引く | 読みで負ける | このターンに勝つ |";
    sep += " ---: | ---: | ---: | ---: |";
    println!("{head}");
    println!("{sep}");
    for g in &aggs {
        let n = g.diffs.get("pick").map_or(0, |x| x.2);
        let mut line = format!(
            "| `{}` | {} | {} |",
            g.id,
            n,
            playout_diff(&g.info).map_or("—".into(), |x| format!("{x:+.1}"))
        );
        for (k, _) in KEYS {
            let (m, se, _) = g.diffs[k];
            line += &format!(" {} |", pm(m, se));
        }
        for j in 0..4 {
            line += &format!(
                " {} / {} |",
                fixed(g.rates[0][j], 0),
                fixed(g.rates[1][j], 0)
            );
        }
        println!("{line}");
    }
    println!();
    // まとめ（全部と、グループごと）
    let mut sets: Vec<(String, Option<&HashSet<String>>)> = vec![("全部".into(), None)];
    for (name, ids) in &groups {
        sets.push((name.clone(), Some(ids)));
    }
    println!(
        "2 つ目の並びが上に来た局面の数（差 > 0 / 差 > 標準誤差の 2 倍 / 差 > {gate}、局面の数）:"
    );
    println!();
    let mut head = String::from("| まとめ | 局面 |");
    let mut sep = String::from("| --- | ---: |");
    for (_, name) in KEYS {
        head += &format!(" {name} |");
        sep += " ---: |";
    }
    println!("{head}");
    println!("{sep}");
    for (name, ids) in &sets {
        let gs: Vec<&Agg> = aggs
            .iter()
            .filter(|g| ids.is_none_or(|s| s.contains(&g.id)))
            .collect();
        let mut line = format!("| {name} | {} |", gs.len());
        for (k, _) in KEYS {
            let ds: Vec<(f64, f64)> = gs.iter().map(|g| (g.diffs[k].0, g.diffs[k].1)).collect();
            let pos = ds.iter().filter(|(m, _)| *m > 0.0).count();
            let clear = ds
                .iter()
                .filter(|(m, se)| *m > 0.0 && *m > 2.0 * se.max(0.0))
                .count();
            let over = ds.iter().filter(|(m, _)| *m > gate).count();
            line += &format!(" {pos} / {clear} / {over} |");
        }
        println!("{line}");
    }
    println!();
    println!("差の平均（局面ごとの差の、局面どうしの平均 ± 標準誤差）:");
    println!();
    let mut head = String::from("| まとめ |");
    let mut sep = String::from("| --- |");
    for (_, name) in KEYS {
        head += &format!(" {name} |");
        sep += " ---: |";
    }
    println!("{head}");
    println!("{sep}");
    for (name, ids) in &sets {
        let gs: Vec<&Agg> = aggs
            .iter()
            .filter(|g| ids.is_none_or(|s| s.contains(&g.id)))
            .collect();
        let mut line = format!("| {name} |");
        for (k, _) in KEYS {
            let ds: Vec<f64> = gs
                .iter()
                .map(|g| g.diffs[k].0)
                .filter(|x| !x.is_nan())
                .collect();
            let (m, se) = mean_se(&ds);
            line += &format!(" {} |", pm(m, se));
        }
        println!("{line}");
    }
    Ok(())
}
