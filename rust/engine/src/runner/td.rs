//! TD 学習の自己対戦（TypeScript 版 scripts/td-main.ts の selfplay。npm run td -- selfplay と同じ試合・同じ JSON Lines）。
//!
//!   svwb td selfplay --model m0.json --games 2000 [--start 0] [--eps 0.1] --out d0.jsonl
//!
//! 両方の席がモデルの評価で打つ探索 AI の自己対戦（7 デッキの全 49 組を順に回す）。各自分のターンの最初の局面（after）と
//! ターン末の局面（end）を、入力と出発点の評価の点数 S と一緒に、試合が終わった順に 1 試合 1 行で書き出す。
//! 書き出したファイルは `npm run td -- train` にそのまま渡せる（init・train・probe・prune は TypeScript 版で行う）。

use super::options::model_eval;
use super::parallel::parallel_map;
use super::{compare_decks, fixed, seconds_since, Tally};
use crate::ai::aidata::{ai_data, weights_with};
use crate::ai::eval::{evaluate_with, EvalWeights};
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::valuenet::{ValueNet, ValuePhase};
use crate::ai::{Agent, Rng};
use crate::data::Deck;
use crate::game::{acting_player, apply_action, create_game, legal_actions, resolve_turn_end};
use crate::jsnum::{js_num, round_precision};
use crate::state::{next_random, Action, GameState, Phase, PlayerIndex};
use std::io::Write;
use std::sync::Arc;
use std::time::Instant;

/// 自己対戦のシード（compare・rhino-compare の試合と重ならないように大きくする）
const SEED_BASE: u32 = 2_000_000;

fn parse_args(argv: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for pair in argv.chunks(2) {
        match pair {
            [k, v] if k.starts_with("--") => out.push((k[2..].to_string(), v.clone())),
            _ => return Err(format!("引数の形が違います: {}", pair[0])),
        }
    }
    Ok(out)
}

fn arg<'a>(args: &'a [(String, String)], k: &str) -> Option<&'a str> {
    // 同じ引数が 2 回あれば後のもの（TypeScript 版の Map）
    args.iter()
        .rev()
        .find(|(x, _)| x == k)
        .map(|(_, v)| v.as_str())
}

fn num_arg(args: &[(String, String)], k: &str, def: f64) -> Result<f64, String> {
    match arg(args, k) {
        None => Ok(def),
        Some(v) => v
            .parse::<f64>()
            .ok()
            .filter(|x| x.is_finite())
            .ok_or_else(|| format!("--{k} は数: {v}")),
    }
}

/// 自己対戦の設定（modelOptions）。補正が 0 のモデルは補正を足さず、相手のターンは貪欲法で読む
struct Model {
    net: Arc<ValueNet>,
    opts: SearchOptions,
    w: EvalWeights,
}

fn model_options(net: Arc<ValueNet>) -> Result<Model, String> {
    let weights = weights_with(&ai_data().search_weights_raw, &net.base_weights)?;
    let opts = SearchOptions {
        weights: Some(Arc::new(weights.clone())),
        extra_eval: if net.is_zero() {
            None
        } else {
            Some(model_eval(net.clone()))
        },
        opponent_search: None,
        ..SearchOptions::default()
    };
    Ok(Model {
        net,
        opts,
        w: EvalWeights::new(weights),
    })
}

/// 1 試合の結果（JSON の 1 行と集計用の値）
struct Summary {
    line: String,
    decks: [String; 2],
    winner: PlayerIndex,
    turns: i32,
    samples: usize,
    explored: usize,
}

/// 局面 1 つ（{"ph":…,"s":…,"x":[…],"v":[…]}、ランダムに打った局面は "ex":1 も）
fn write_sample(
    out: &mut String,
    m: &Model,
    s: &GameState,
    p: PlayerIndex,
    phase: ValuePhase,
    explored: bool,
) {
    let x = m.net.encode(s, p, phase);
    out.push_str(&format!(
        "{{\"ph\":{},\"s\":{},\"x\":[",
        if phase == ValuePhase::End { 0 } else { 1 },
        js_num(round_precision(evaluate_with(s, p, &m.w), 6))
    ));
    for (i, (k, _)) in x.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&k.to_string());
    }
    out.push_str("],\"v\":[");
    for (i, (_, v)) in x.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&js_num(round_precision(*v, 4)));
    }
    out.push(']');
    if explored {
        out.push_str(",\"ex\":1");
    }
    out.push('}');
}

fn play_one(g: u32, decks: &[&'static Deck], m: &Model, eps: f64) -> Summary {
    let (di, dj) = ((g % 7) as usize, ((g / 7) % 7) as usize);
    let seed = SEED_BASE + g;
    let mut state = create_game([&decks[di].cards, &decks[dj].cards], seed);
    let mut agent_rng = Rng::new(seed ^ 0x9e3779b9);
    let mut explore = seed ^ 0x2545f491;
    let mut next_float = || {
        let (v, next) = next_random(explore);
        explore = next;
        v
    };
    let mut agents = [
        SearchAgent::new(m.opts.clone()),
        SearchAgent::new(m.opts.clone()),
    ];
    let mut seen = [-1, -1];
    let mut samples = [String::new(), String::new()];
    let mut counts = [0usize; 2];
    let mut explored = 0;
    let mut n = 0;
    while state.phase != Phase::Ended {
        n += 1;
        assert!(n <= 10001, "試合 {g} のアクション数が上限を超えました");
        let legal = legal_actions(&state);
        let actor = acting_player(&state);
        let mut action: Option<Action> = None;
        let push = |samples: &mut [String; 2],
                    counts: &mut [usize; 2],
                    s: &GameState,
                    phase: ValuePhase,
                    ex: bool| {
            if counts[actor] > 0 {
                samples[actor].push(',');
            }
            counts[actor] += 1;
            write_sample(&mut samples[actor], m, s, actor, phase, ex);
        };
        // 自分のターンの最初の局面（相手のターンを読んだ後に探索が評価する局面と同じ）
        if state.phase == Phase::Main
            && state.pending.is_none()
            && state.active == actor
            && seen[actor] != state.players[actor].turn_count
        {
            seen[actor] = state.players[actor].turn_count;
            let choices: Vec<&Action> = legal
                .iter()
                .filter(|a| !matches!(a, Action::EndTurn))
                .collect();
            if eps > 0.0 && !choices.is_empty() && next_float() < eps {
                action =
                    Some(choices[(next_float() * choices.len() as f64).floor() as usize].clone());
                explored += 1;
            }
            push(
                &mut samples,
                &mut counts,
                &state,
                ValuePhase::After,
                action.is_some(),
            );
        }
        let action = match action {
            Some(a) => a,
            None => agents[actor].choose_action(&state, &legal, &mut agent_rng),
        };
        if matches!(action, Action::EndTurn)
            && state.phase == Phase::Main
            && state.pending.is_none()
        {
            let end = resolve_turn_end(&state);
            let end = end.as_ref().unwrap_or(&state);
            if end.phase != Phase::Ended {
                push(&mut samples, &mut counts, end, ValuePhase::End, false);
            }
        }
        state = apply_action(&state, &action);
    }
    let winner = state
        .winner
        .unwrap_or_else(|| panic!("試合 {g} に勝者がいません"));
    let names = [decks[di].name.clone(), decks[dj].name.clone()];
    let line = format!(
        "{{\"g\":{g},\"decks\":[{},{}],\"winner\":{winner},\"turns\":{},\"samples\":[[{}],[{}]]}}",
        serde_json::to_string(&names[0]).expect("名前"),
        serde_json::to_string(&names[1]).expect("名前"),
        state.turn,
        samples[0],
        samples[1]
    );
    Summary {
        line,
        decks: names,
        winner,
        turns: state.turn,
        samples: counts[0] + counts[1],
        explored,
    }
}

fn selfplay(args: &[(String, String)]) -> Result<(), String> {
    let model_path = arg(args, "model").ok_or("--model がありません")?;
    let out = arg(args, "out").ok_or("--out がありません")?;
    let games = num_arg(args, "games", 100.0)?;
    let start = num_arg(args, "start", 0.0)?;
    let eps = num_arg(args, "eps", 0.1)?;
    if games < 0.0 || games.fract() != 0.0 || start < 0.0 || start.fract() != 0.0 {
        return Err("--games・--start は 0 以上の整数".into());
    }
    let m = model_options(Arc::new(ValueNet::load(model_path)?))?;
    let decks = compare_decks();
    if decks.len() != 7 {
        return Err("自己対戦のデッキは 7 つの想定です".into());
    }
    let mut file = std::fs::File::create(out).map_err(|e| format!("{out} に書けません: {e}"))?;
    let t0 = Instant::now();
    let tasks: Vec<u32> = (0..games as u32).map(|k| start as u32 + k).collect();
    let mut summaries = parallel_map(
        &tasks,
        |&g, _| play_one(g, &decks, &m, eps),
        |done, total, r, _| {
            writeln!(file, "{}", r.line).unwrap_or_else(|e| panic!("{out} に書けません: {e}"));
            if done % 100 == 0 || done == total {
                println!(
                    "{done}/{total} 試合 {}s/試合",
                    fixed(seconds_since(t0) / done as f64, 2)
                );
            }
        },
    );
    for r in &mut summaries {
        r.line = String::new();
    }
    let n = summaries.len();
    let samples: usize = summaries.iter().map(|r| r.samples).sum();
    let explored: usize = summaries.iter().map(|r| r.explored).sum();
    let turns: i64 = summaries.iter().map(|r| r.turns as i64).sum();
    let first_wins = summaries.iter().filter(|r| r.winner == 0).count();
    println!(
        "{out}: {n} 試合、局面 {samples}（ランダムに打った {explored}）、平均 {} ターン、先攻の勝率 {}%",
        fixed(turns as f64 / n as f64, 1),
        fixed((first_wins as f64 / n as f64) * 100.0, 1)
    );
    // 自己対戦でのデッキごとの勝率（同じデッキ同士は除く）
    let mut per_deck = Tally::default();
    for r in &summaries {
        if r.decks[0] == r.decks[1] {
            continue;
        }
        for (p, d) in r.decks.iter().enumerate() {
            per_deck.add(d, r.winner == p);
        }
    }
    println!("{}", per_deck.line());
    Ok(())
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let args = parse_args(argv.get(1..).unwrap_or(&[]))?;
    match argv.first().map(|s| s.as_str()) {
        Some("selfplay") => selfplay(&args),
        _ => {
            Err("svwb td selfplay ...（init・train・probe・prune は npm run td -- で行う）".into())
        }
    }
}
