//! 自分のターンのビームが、広いビームの見つけるターン末の最善にどれだけ届くかを、ビームの形（幅・並べ替え）ごとに測る（2026-10-30）。
//!
//!   svwb beam-gap [--games 50] [--from 0] [--ref '{"beamWidth":4096}'] [--variants '{"名前":{設定},…}']
//!                 [--every 1] [--sample 0] [--nodes 局面.jsonl] [--out 結果.jsonl]
//!                 [--positions 局面の集まり.jsonl] [--savePositions 局面の集まり.jsonl]
//!
//! 今の既定どうしの自己対戦（`sim::play_ai`、比較用の 7 デッキ）の、自分のターンの最初の局面（`--every k` なら k 局面に 1 つ）を集め、
//! 視点のプレイヤーから決定化した局面で、基準の設定（`--ref`）と比べる設定（`--variants`）のビームを 1 回ずつ打つ（相手のターンは読まない）。
//! 設定ごとに、ターン末の点数の最大が基準より低い局面の割合・平均の差・最善の最初の手が違う割合・採点した局面の数・時間を出す。
//! 勝ち負けの点（絶対値 1e5 以上）が付く局面は数えない。
//!
//! `--sample k` なら、基準のビームが残した局面から局面ごとに k 個（と最善の並びの途中の局面すべて）を、そこでターンを終えた点数・
//! その先で届いた最善（伸びしろ = 届いた最善 − 終えた点数）・伸びしろの項（ai/beam_key.rs）と一緒に `--nodes` に書く。
//! 伸びしろの項の重み（`beamKey`）を決めるのに使う。
//!
//! 自己対戦は時間がかかるので、`--savePositions` で集めた局面を書いておき、次からは `--positions` で読める。
//! docs/ai-notes.md「ターン途中の評価の見直し」

use super::human_plan::{is_start_of_turn, mean_se};
use super::options::compare_options;
use super::parallel::parallel_map;
use super::{fixed, seconds_since};
use crate::ai::beam_key::{beam_features, BEAM_FEATURES};
use crate::ai::determinize::determinize;
use crate::ai::search::{is_chance_step, BeamProbe, SearchAgent, SearchOptions};
use crate::ai::{Agent, Rng};
use crate::data::data;
use crate::game::{acting_player, apply_legal};
use crate::json::Json;
use crate::sim::{ai_game_setup, play_ai};
use crate::state::{Action, GameState, PlayerIndex};
use crate::state_json::{action_to_json, state_from_json, state_to_json};
use std::io::{BufRead, Write};
use std::time::Instant;

/// 勝ち負けの点が付いた局面とみなす点数の大きさ
const DECIDED: f64 = 1e5;

/// 集めた局面 1 つ（JSON の 1 行）
struct Position {
    game: u32,
    k: usize,
    p: PlayerIndex,
    deck: String,
    state: String,
}

/// 設定 1 つで打った結果（スレッドの間で受け渡すので局面は持たない）
#[derive(Clone)]
struct Probe {
    best: f64,
    first: String,
    actions: Vec<Action>,
    scored: u64,
    terminals: usize,
    dup: usize,
    secs: f64,
}

struct Row {
    game: u32,
    k: usize,
    deck: String,
    turn: i32,
    chance: bool,
    reference: Probe,
    variants: Vec<Probe>,
    nodes: Vec<String>,
}

fn deck_names(g: u32) -> [String; 2] {
    let (decks, _) = ai_game_setup(g, false);
    let name = |cs: &[crate::data::CardIdx]| {
        data()
            .decks
            .iter()
            .find(|d| d.cards == cs)
            .map_or("?".to_string(), |d| d.name.clone())
    };
    [name(&decks[0]), name(&decks[1])]
}

/// 試合 g を今の既定どうしで打ち、自分のターンの最初の局面を集める（every 局面に 1 つ）
fn collect(g: u32, every: usize) -> Vec<Position> {
    let names = deck_names(g);
    let mut a0 = SearchAgent::new(SearchOptions::default());
    let mut a1 = SearchAgent::new(SearchOptions::default());
    let mut agents: [&mut dyn Agent; 2] = [&mut a0, &mut a1];
    let mut last_turn = -1;
    let mut n = 0usize;
    let mut out = Vec::new();
    play_ai(g, false, &mut agents, |s, _| {
        if is_start_of_turn(s) && acting_player(s) == s.active && s.turn != last_turn {
            last_turn = s.turn;
            if n.is_multiple_of(every.max(1)) {
                out.push(Position {
                    game: g,
                    k: n,
                    p: s.active,
                    deck: names[s.active].clone(),
                    state: state_to_json(s).stringify(),
                });
            }
            n += 1;
        }
    });
    out
}

fn position_json(p: &Position) -> String {
    Json::Obj(vec![
        ("game".into(), Json::Num(p.game as f64)),
        ("k".into(), Json::Num(p.k as f64)),
        ("p".into(), Json::Num(p.p as f64)),
        ("deck".into(), Json::Str(p.deck.clone())),
        ("state".into(), Json::parse(&p.state).unwrap_or(Json::Null)),
    ])
    .stringify()
}

fn position_from_json(line: &str) -> Result<Position, String> {
    let v = Json::parse(line)?;
    let num = |k: &str| match v.get(k) {
        Some(Json::Num(x)) => Ok(*x),
        _ => Err(format!("局面の行に {k} がありません")),
    };
    Ok(Position {
        game: num("game")? as u32,
        k: num("k")? as usize,
        p: num("p")? as PlayerIndex,
        deck: match v.get("deck") {
            Some(Json::Str(s)) => s.clone(),
            _ => "?".into(),
        },
        state: v
            .get("state")
            .ok_or("局面の行に state がありません")?
            .stringify(),
    })
}

fn probe(
    agent: &SearchAgent,
    s: &GameState,
    p: PlayerIndex,
    sample: usize,
    rng: &mut Rng,
) -> (Probe, Option<BeamProbe>) {
    let t0 = Instant::now();
    let r = agent
        .beam_probe(s, p, sample, rng)
        .expect("ターンの最初の局面に並びがありません");
    let secs = seconds_since(t0);
    let first = r
        .best_actions
        .first()
        .map_or("EndTurn".to_string(), |a| action_to_json(a).stringify());
    (
        Probe {
            best: r.best,
            first,
            actions: r.best_actions.clone(),
            scored: r.scored,
            terminals: r.terminals,
            dup: r.dup_states,
            secs,
        },
        Some(r),
    )
}

/// 並びに引く手・ランダムな手があるか
fn has_chance(root: &GameState, actions: &[Action], p: PlayerIndex) -> bool {
    let mut s = root.clone();
    for a in actions {
        let next = apply_legal(&s, a);
        if is_chance_step(&s, &next, p) {
            return true;
        }
        s = next;
    }
    false
}

fn node_line(pos: &Position, turn: i32, n: &crate::ai::search::ProbeNode) -> String {
    let f = beam_features(&n.state, pos.p);
    let me = &n.state.players[pos.p];
    let mut items: Vec<(String, Json)> = vec![
        ("game".into(), Json::Num(pos.game as f64)),
        ("k".into(), Json::Num(pos.k as f64)),
        ("deck".into(), Json::Str(pos.deck.clone())),
        ("turn".into(), Json::Num(turn as f64)),
        ("depth".into(), Json::Num(n.depth as f64)),
        ("value".into(), Json::Num(n.value)),
        ("bestAfter".into(), Json::Num(n.best_after)),
        ("onBest".into(), Json::Bool(n.on_best)),
        ("rank".into(), Json::Num(n.rank as f64)),
        ("layer".into(), Json::Num(n.layer as f64)),
        ("maxPp".into(), Json::Num(me.max_pp as f64)),
        ("hand".into(), Json::Num(me.hand.len() as f64)),
        ("board".into(), Json::Num(me.board.len() as f64)),
    ];
    for (name, x) in BEAM_FEATURES.iter().zip(f) {
        items.push(((*name).into(), Json::Num(x)));
    }
    Json::Obj(items).stringify()
}

fn probe_json(r: &Probe) -> Json {
    Json::Obj(vec![
        ("best".into(), Json::Num(r.best)),
        ("first".into(), Json::Str(r.first.clone())),
        ("len".into(), Json::Num(r.actions.len() as f64)),
        ("scored".into(), Json::Num(r.scored as f64)),
        ("terminals".into(), Json::Num(r.terminals as f64)),
        ("dup".into(), Json::Num(r.dup as f64)),
        ("secs".into(), Json::Num(r.secs)),
    ])
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mut games = 50u32;
    let mut from = 0u32;
    let mut every = 1usize;
    let mut ref_text = r#"{"beamWidth":4096}"#.to_string();
    let mut variants_text = r#"{"w128":{"beamWidth":128},"w512":{}}"#.to_string();
    let mut sample = 0usize;
    let mut nodes_path: Option<String> = None;
    let mut out_path: Option<String> = None;
    let mut positions_path: Option<String> = None;
    let mut save_path: Option<String> = None;
    let mut i = 0;
    while i < argv.len() {
        let v = argv.get(i + 1).cloned().ok_or("引数の値がありません")?;
        match argv[i].as_str() {
            "--games" => games = v.parse().map_err(|_| "--games は数")?,
            "--from" => from = v.parse().map_err(|_| "--from は数")?,
            "--every" => every = v.parse().map_err(|_| "--every は数")?,
            "--ref" => ref_text = v,
            "--variants" => variants_text = v,
            "--sample" => sample = v.parse().map_err(|_| "--sample は数")?,
            "--nodes" => nodes_path = Some(v),
            "--out" => out_path = Some(v),
            "--positions" => positions_path = Some(v),
            "--savePositions" => save_path = Some(v),
            k => return Err(format!("不明な引数: {k}（runner/beam_gap.rs）")),
        }
        i += 2;
    }
    let ref_opts = compare_options(&ref_text)?;
    let Json::Obj(vs) = Json::parse(&variants_text)? else {
        return Err("--variants は名前から設定へのオブジェクト".into());
    };
    let mut variants: Vec<(String, SearchOptions, String)> = Vec::new();
    for (name, v) in vs {
        let text = v.stringify();
        variants.push((name, compare_options(&text)?, text));
    }
    let t0 = Instant::now();
    // 局面を集める
    let positions: Vec<Position> = match &positions_path {
        Some(path) => {
            let f = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
            let mut out = Vec::new();
            for line in std::io::BufReader::new(f).lines() {
                let line = line.map_err(|e| e.to_string())?;
                if !line.trim().is_empty() {
                    out.push(position_from_json(&line)?);
                }
            }
            out
        }
        None => {
            let items: Vec<u32> = (from..from + games).collect();
            let per_game = parallel_map(
                &items,
                |&g, _| collect(g, every),
                |done, total, _, _| {
                    if done % 10 == 0 || done == total {
                        eprintln!(
                            "自己対戦 {done}/{total} 試合 {}s",
                            fixed(seconds_since(t0), 0)
                        );
                    }
                },
            );
            per_game.into_iter().flatten().collect()
        }
    };
    if let Some(path) = &save_path {
        let mut w = std::fs::File::create(path).map_err(|e| format!("{path}: {e}"))?;
        for p in &positions {
            writeln!(w, "{}", position_json(p)).map_err(|e| e.to_string())?;
        }
    }
    eprintln!("{} 局面 {}s", positions.len(), fixed(seconds_since(t0), 0));
    let t1 = Instant::now();
    let rows: Vec<Result<Row, String>> = parallel_map(
        &positions,
        |pos, _| -> Result<Row, String> {
            let s = state_from_json(&Json::parse(&pos.state)?)?;
            let p = pos.p;
            let mut r = Rng::new(pos.game.wrapping_mul(1000).wrapping_add(pos.k as u32));
            let det = determinize(&s, p, &mut r, false);
            let mut rng = Rng::new(7 + pos.k as u32);
            let (reference, full) = probe(
                &SearchAgent::new(ref_opts.clone()),
                &det,
                p,
                sample,
                &mut rng,
            );
            let turn = det.players[p].turn_count;
            let nodes = match full {
                Some(f) => f.nodes.iter().map(|n| node_line(pos, turn, n)).collect(),
                None => Vec::new(),
            };
            let chance = has_chance(&det, &reference.actions, p);
            let variants = variants
                .iter()
                .map(|(_, o, _)| probe(&SearchAgent::new(o.clone()), &det, p, 0, &mut rng).0)
                .collect();
            Ok(Row {
                game: pos.game,
                k: pos.k,
                deck: pos.deck.clone(),
                turn,
                chance,
                reference,
                variants,
                nodes,
            })
        },
        |done, total, _, _| {
            if done % 200 == 0 || done == total {
                eprintln!("{done}/{total} 局面 {}s", fixed(seconds_since(t1), 0));
            }
        },
    );
    let rows: Vec<Row> = rows.into_iter().collect::<Result<_, _>>()?;
    if let Some(path) = &nodes_path {
        let mut w = std::fs::File::create(path).map_err(|e| format!("{path}: {e}"))?;
        for r in &rows {
            for l in &r.nodes {
                writeln!(w, "{l}").map_err(|e| e.to_string())?;
            }
        }
    }
    if let Some(path) = &out_path {
        let mut w = std::fs::File::create(path).map_err(|e| format!("{path}: {e}"))?;
        for r in &rows {
            let line = Json::Obj(vec![
                ("game".into(), Json::Num(r.game as f64)),
                ("k".into(), Json::Num(r.k as f64)),
                ("deck".into(), Json::Str(r.deck.clone())),
                ("turn".into(), Json::Num(r.turn as f64)),
                ("chance".into(), Json::Bool(r.chance)),
                ("ref".into(), probe_json(&r.reference)),
                (
                    "variants".into(),
                    Json::Obj(
                        variants
                            .iter()
                            .zip(&r.variants)
                            .map(|((n, _, _), v)| (n.clone(), probe_json(v)))
                            .collect(),
                    ),
                ),
            ]);
            writeln!(w, "{}", line.stringify()).map_err(|e| e.to_string())?;
        }
    }
    // まとめ
    let counted: Vec<&Row> = rows
        .iter()
        .filter(|r| r.reference.best.abs() < DECIDED)
        .collect();
    println!(
        "基準 {ref_text}、{} 局面（勝ち負けの点の付く {} 局面を除く）、{}s",
        counted.len(),
        rows.len() - counted.len(),
        fixed(seconds_since(t0), 0)
    );
    let mean = |xs: &[f64]| xs.iter().sum::<f64>() / xs.len().max(1) as f64;
    let line = |label: &str, rs: &[&Row], get: &dyn Fn(&Row) -> &Probe, is_ref: bool| {
        if rs.is_empty() {
            return;
        }
        let gaps: Vec<f64> = rs
            .iter()
            .map(|r| {
                let v = get(r).best;
                if v.abs() >= DECIDED {
                    // 基準は決まらず、こちらだけ勝ち負けの点（基準より良い・悪い）は差 0 として数える
                    0.0
                } else {
                    r.reference.best - v
                }
            })
            .collect();
        let n = rs.len() as f64;
        let worse = gaps.iter().filter(|&&g| g > 1e-6).count();
        let worse3 = gaps.iter().filter(|&&g| g >= 3.0).count();
        let better = gaps.iter().filter(|&&g| g < -1e-6).count();
        let (m, se) = mean_se(&gaps.iter().map(|g| g.max(0.0)).collect::<Vec<_>>());
        let first = rs
            .iter()
            .filter(|r| get(r).first != r.reference.first)
            .count();
        let scored: Vec<f64> = rs.iter().map(|r| get(r).scored as f64).collect();
        let secs: Vec<f64> = rs.iter().map(|r| get(r).secs).collect();
        let dup: Vec<f64> = rs
            .iter()
            .map(|r| get(r).dup as f64 / get(r).terminals.max(1) as f64)
            .collect();
        if is_ref {
            println!(
                "  {label}: 採点 {} 局面・{}ms、段をまたいで同じ局面 {}%",
                fixed(mean(&scored), 0),
                fixed(1000.0 * mean(&secs), 1),
                fixed(100.0 * mean(&dup), 1),
            );
        } else {
            println!(
                "  {label}: 劣る {}%・3 点以上劣る {}%・上回る {}%、差の平均 {} ± {}、最善の最初の手が違う {}%、採点 {} 局面・{}ms、段をまたいで同じ局面 {}%",
                fixed(100.0 * worse as f64 / n, 1),
                fixed(100.0 * worse3 as f64 / n, 1),
                fixed(100.0 * better as f64 / n, 1),
                fixed(m, 3),
                fixed(se, 3),
                fixed(100.0 * first as f64 / n, 1),
                fixed(mean(&scored), 0),
                fixed(1000.0 * mean(&secs), 1),
                fixed(100.0 * mean(&dup), 1),
            );
        }
    };
    let section = |title: &str, rs: Vec<&Row>| {
        println!("{title}（{} 局面）", rs.len());
        line("基準", &rs, &|r| &r.reference, true);
        for (j, (name, _, text)) in variants.iter().enumerate() {
            line(&format!("{name} {text}"), &rs, &|r| &r.variants[j], false);
        }
    };
    section("全部", counted.clone());
    section(
        "基準の最善の並びに引く手・ランダムな手が無い",
        counted.iter().copied().filter(|r| !r.chance).collect(),
    );
    // デッキごとの差の平均
    let mut decks: Vec<String> = Vec::new();
    for r in &counted {
        if !decks.contains(&r.deck) {
            decks.push(r.deck.clone());
        }
    }
    println!("デッキごとの差の平均（基準 − 設定、0 未満は 0）");
    for d in &decks {
        let rs: Vec<&Row> = counted.iter().copied().filter(|r| &r.deck == d).collect();
        let parts: Vec<String> = variants
            .iter()
            .enumerate()
            .map(|(j, (name, _, _))| {
                let gaps: Vec<f64> = rs
                    .iter()
                    .map(|r| {
                        let v = r.variants[j].best;
                        if v.abs() >= DECIDED {
                            0.0
                        } else {
                            (r.reference.best - v).max(0.0)
                        }
                    })
                    .collect();
                format!("{name} {}", fixed(mean(&gaps), 3))
            })
            .collect();
        println!("  {d}（{}）: {}", rs.len(), parts.join("、"));
    }
    Ok(())
}
