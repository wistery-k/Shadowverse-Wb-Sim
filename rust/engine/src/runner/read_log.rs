//! read-log: 探索 AI どうしの試合で、考え直すたびに、相手のターンまで読み直した終局面と、引き直しごとの読みの点数を書き出す
//! （相手のターンの読み直しを軽くする実験用。docs/ai-notes.md「読み直しの記録で、見込みのない候補を途中で打ち切る」）。
//!
//!   svwb read-log --out 記録.jsonl [--games 49] [--start 0] [--opts '<設定JSON>'] [--b 12]
//!                 [--alt-opp '{"beamWidth":8,"maxDepth":8}']
//!
//! - 試合は profile と同じ（compare と同じデッキの組で、試合番号ごとに席とデッキを入れ替えて 2 試合。両方の席が同じ設定）
//! - 打つ手は記録しないときと同じ（記録のための読みは、選ぶ値にも乱数にも使わない）
//! - --b N: 選ぶのに使った相手の手札の引き直し（oppHandCommon）とは別の乱数で N 回読んだ点数も書く（確かめ用の独立な読み。0 なら書かない）
//! - --alt-opp: 選ぶのに使ったのと同じ引き直しを、相手のターンを読むビームをこの設定にして読んだ点数も書く
//!
//! 1 行が 1 回の考え直し（"type":"think"）か 1 試合の結果（"type":"game"）。考え直しの行の "rescores" は plan_turn の読み直しごとに、
//! 読み直した順の終局面（"rows"）を持つ。各終局面は最初の手（"a"）、選んだ理由（"origin": top・draw・passLethal・danger）、
//! 決着した終局面か（"ended"）、drawSplit で作り直した引きの数（"kinds"、区切らなければ 0）、混ぜたターン末の点数（"te"）、
//! 選ぶときの値（"value"）と、読んだ点数の列（"reads"・"b"・"alt"。どれも [重み, 点数]。区切らなければ引き直しごとに重み 1）

use super::compare::compare_setup;
use super::compare_decks;
use super::fixed;
use super::human_plan::step_text;
use super::options::compare_options;
use super::parallel::{parallel_map, thread_count};
use crate::ai::search::{
    record_rescores, take_rescores, OpponentSearch, RescoreLogConfig, RescoreOrigin, RescoreRow,
    SearchAgent, SearchOptions,
};
use crate::ai::{Agent, Rng};
use crate::data::Deck;
use crate::game::{acting_player, apply_action, create_game, legal_actions};
use crate::state::Phase;
use serde_json::{json, Value};
use std::io::Write;
use std::time::Instant;

fn origin_name(o: RescoreOrigin) -> &'static str {
    match o {
        RescoreOrigin::Top => "top",
        RescoreOrigin::Draw => "draw",
        RescoreOrigin::PassLethal => "passLethal",
        RescoreOrigin::Danger => "danger",
    }
}

fn pairs(xs: &[(f64, f64)]) -> Value {
    Value::Array(xs.iter().map(|&(w, v)| json!([w, v])).collect())
}

fn row_json(s: &crate::state::GameState, p: usize, r: &RescoreRow) -> Value {
    json!({
        "a": step_text(s, &r.action, p),
        "origin": origin_name(r.origin),
        "ended": r.ended,
        "kinds": r.split_kinds,
        "te": r.turn_end,
        "value": r.value,
        "reads": pairs(&r.reads),
        "b": pairs(&r.b_reads),
        "alt": pairs(&r.alt_reads),
    })
}

/// 試合番号 g（swap で席とデッキを入れ替えた方）を打ち、書き出す行（考え直しごとと、最後に試合の結果）を返す
fn play_logged(
    opts: &SearchOptions,
    cfg: RescoreLogConfig,
    decks: &[&'static Deck],
    g: u32,
    swap: bool,
) -> Vec<Value> {
    let (_, seats, seed) = compare_setup(decks, g, swap, false);
    let mut agents = [
        SearchAgent::new(opts.clone()),
        SearchAgent::new(opts.clone()),
    ];
    record_rescores(Some(cfg));
    let mut s = create_game([&seats[0].cards, &seats[1].cards], seed);
    let mut rng = Rng::new(seed ^ 0x9e3779b9);
    let mut out: Vec<Value> = Vec::new();
    let mut actions = 0u32;
    let mut decision = [0u32; 2];
    while s.phase != Phase::Ended {
        actions += 1;
        assert!(
            actions <= 10000,
            "アクション数が上限 10000 を超えました（シード {seed}）"
        );
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        let t = Instant::now();
        let a = agents[actor].choose_action(&s, &legal, &mut rng);
        let secs = t.elapsed().as_secs_f64();
        decision[actor] += 1;
        let recs = take_rescores();
        if !recs.is_empty() {
            let rescores: Vec<Value> = recs
                .iter()
                .map(|r| {
                    json!({
                        "rows": r.rows.iter().map(|x| row_json(&s, r.p, x)).collect::<Vec<_>>(),
                    })
                })
                .collect();
            out.push(json!({
                "type": "think",
                "g": g,
                "swap": swap,
                "p": actor,
                "deck": seats[actor].name,
                "oppDeck": seats[1 - actor].name,
                "turn": s.turn,
                "decision": decision[actor],
                "legal": legal.len(),
                "secs": secs,
                "chosen": step_text(&s, &a, actor),
                "rescores": rescores,
            }));
        }
        s = apply_action(&s, &a);
    }
    record_rescores(None);
    out.push(json!({
        "type": "game",
        "g": g,
        "swap": swap,
        "decks": [seats[0].name, seats[1].name],
        "winner": s.winner,
        "turns": s.turn,
        "actions": actions,
    }));
    out
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mut games: u32 = 49;
    let mut start: u32 = 0;
    let mut opts_text = "{}".to_string();
    let mut b_samples: usize = 12;
    let mut alt_opp: Option<OpponentSearch> = None;
    let mut out_path: Option<String> = None;
    let mut it = argv.iter();
    while let Some(key) = it.next() {
        let v = it.next().ok_or_else(|| format!("{key} の値がありません"))?;
        let int = || -> Result<u32, String> {
            v.parse::<u32>()
                .map_err(|_| format!("{key} は 0 以上の整数: {v}"))
        };
        match key.as_str() {
            "--games" => games = int()?,
            "--start" => start = int()?,
            "--b" => b_samples = int()? as usize,
            "--opts" => opts_text = v.clone(),
            "--out" => out_path = Some(v.clone()),
            "--alt-opp" => {
                let x: Value =
                    serde_json::from_str(v).map_err(|e| format!("--alt-opp の JSON: {e}"))?;
                let num = |k: &str| -> Result<usize, String> {
                    x[k].as_u64()
                        .map(|n| n as usize)
                        .ok_or_else(|| format!("--alt-opp に {k}（整数）がありません"))
                };
                alt_opp = Some(OpponentSearch {
                    beam_width: num("beamWidth")?,
                    max_depth: num("maxDepth")?,
                    extra_eval: x["extraEval"].as_bool().unwrap_or(false),
                });
            }
            _ => return Err(format!("知らないオプション: {key}")),
        }
    }
    let out_path = out_path.ok_or("--out で書き出すファイルを指定します")?;
    let opts = compare_options(&opts_text).map_err(|e| format!("--opts: {e}"))?;
    let cfg = RescoreLogConfig { b_samples, alt_opp };
    let decks = compare_decks();
    let tasks: Vec<(u32, bool)> = (0..games)
        .flat_map(|k| [(start + k, false), (start + k, true)])
        .collect();
    let mut file = std::io::BufWriter::new(
        std::fs::File::create(&out_path).map_err(|e| format!("{out_path}: {e}"))?,
    );
    eprintln!("{} 試合（並列 {}）", tasks.len(), thread_count());
    let t0 = Instant::now();
    let mut thinks = 0usize;
    let mut rows = 0usize;
    let mut write_err: Option<String> = None;
    parallel_map(
        &tasks,
        |&(g, swap), _| play_logged(&opts, cfg, &decks, g, swap),
        |done, total, lines, _| {
            for l in lines {
                if l["type"] == "think" {
                    thinks += 1;
                    rows += l["rescores"]
                        .as_array()
                        .map(|rs| {
                            rs.iter()
                                .map(|r| r["rows"].as_array().map_or(0, |x| x.len()))
                                .sum::<usize>()
                        })
                        .unwrap_or(0);
                }
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
        "（{} 秒）考え直し {thinks} 回、読み直した終局面 {rows} 個 → {out_path}",
        fixed(t0.elapsed().as_secs_f64(), 1)
    );
    Ok(())
}
