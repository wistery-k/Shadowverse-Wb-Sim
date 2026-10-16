//! TD 学習の自己対戦（TypeScript 版 scripts/td-main.ts の selfplay。npm run td -- selfplay と同じ試合・同じ JSON Lines）。
//!
//!   svwb td selfplay --model m0.json --games 2000 [--start 0] [--eps 0.1] [--opp greedy|beam] [--iv 0] --out d0.jsonl
//!
//! --opp beam なら相手のターンを探索 AI の既定と同じビームサーチで読む（既定は貪欲法）。
//! --iv k なら、各試合で 1 つの自分のターンの最初（どちらかのプレイヤーの 3〜8 ターン目）から、手札のカードを 1 枚抜いた局面を
//! k 個（小数なら平均 k 個。抜くカードは別々）作り、そこから最後まで同じ --eps で打った試合も書き出す（"iv": {"p", "k", "card"} 付きの行。
//! k はもとの試合のその局面の添字）。カードを抜くのは打ち方と関係ないので、学習した補正が手札のカードの価値を
//! 相関で覚える偏り（勝っている局面にあったカードを高く見る等）を打ち消す方向に働くと考えた。docs/ai-notes.md「介入データを TD 学習に混ぜる」
//!
//! 両方の席がモデルの評価で打つ探索 AI の自己対戦（7 デッキの全 49 組を順に回す）。各自分のターンの最初の局面（after）と
//! ターン末の局面（end）を、入力と出発点の評価の点数 S と一緒に、試合が終わった順に 1 試合 1 行で書き出す。
//! 書き出したファイルは `npm run td -- train` にそのまま渡せる（init・train・probe・prune は scripts/td-main.ts で行う）。

use super::options::model_eval;
use super::parallel::parallel_map;
use super::{compare_decks, fixed, seconds_since, Tally};
use crate::ai::aidata::{ai_data, weights_with};
use crate::ai::eval::{evaluate_with, EvalWeights};
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::valuenet::{ValueNet, ValuePhase};
use crate::ai::{Agent, Rng};
use crate::data::{data, Deck};
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

fn model_options(net: Arc<ValueNet>, opp_beam: bool) -> Result<Model, String> {
    let weights = weights_with(&ai_data().search_weights_raw, &net.base_weights)?;
    let opts = SearchOptions {
        weights: Some(Arc::new(weights.clone())),
        extra_eval: if net.is_zero() {
            None
        } else {
            Some(model_eval(net.clone()))
        },
        // --opp beam なら探索 AI の既定と同じく、相手のターンをビームサーチで読む
        opponent_search: if opp_beam {
            SearchOptions::default().opponent_search
        } else {
            None
        },
        ..SearchOptions::default()
    }
    // 読み方は今までの自己対戦と同じ（決定化 3 回）
    .with_classic_sampling();
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
    /// 介入して打った試合の数
    ivs: usize,
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

/// 介入: 自分のターンの最初の局面で手札から 1 枚抜き、そこから最後まで打った試合も書き出す（--iv）
struct Intervention {
    /// 抜く側のプレイヤーと、その自分のターンの番号
    p: PlayerIndex,
    turn: i32,
    /// 1 つの局面から作る、抜くカードの違う局面の数
    variants: usize,
}

/// 局面から最後まで打った結果
struct Played {
    state: GameState,
    samples: [String; 2],
    counts: [usize; 2],
    explored: usize,
    /// 介入する局面と、そのときの p の局面の数（その局面の添字）
    branch: Option<(GameState, usize)>,
}

/// state から最後まで打ち、各自分のターンの最初とターン末の局面を記録する
fn play_out(
    g: u32,
    mut state: GameState,
    m: &Model,
    eps: f64,
    seed: u32,
    branch_at: Option<(PlayerIndex, i32)>,
) -> Played {
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
    let mut branch = None;
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
            if branch_at == Some((actor, state.players[actor].turn_count))
                && state.stack.is_empty()
                && state.queue.is_empty()
                && !state.players[actor].hand.is_empty()
            {
                branch = Some((state.clone(), counts[actor]));
            }
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
    Played {
        state,
        samples,
        counts,
        explored,
        branch,
    }
}

/// 試合 1 つの JSON の 1 行（介入した試合は "iv" も）
fn record_line(g: u32, names: &[String; 2], r: &Played, iv: Option<String>) -> String {
    let winner = r
        .state
        .winner
        .unwrap_or_else(|| panic!("試合 {g} に勝者がいません"));
    format!(
        "{{\"g\":{g},\"decks\":[{},{}],\"winner\":{winner},\"turns\":{},{}\"samples\":[[{}],[{}]]}}",
        serde_json::to_string(&names[0]).expect("名前"),
        serde_json::to_string(&names[1]).expect("名前"),
        r.state.turn,
        iv.map(|x| format!("\"iv\":{x},")).unwrap_or_default(),
        r.samples[0],
        r.samples[1]
    )
}

fn play_one(g: u32, decks: &[&'static Deck], m: &Model, eps: f64, iv: f64) -> Summary {
    let (di, dj) = ((g % 7) as usize, ((g / 7) % 7) as usize);
    let seed = SEED_BASE + g;
    let state = create_game([&decks[di].cards, &decks[dj].cards], seed);
    // 介入する試合・プレイヤー・ターン（自己対戦の乱数とは別の乱数で決める。--iv 0 なら今までと同じ試合）
    let mut ivr = Rng::new(seed ^ 0x6a09e667);
    let plan = (iv > 0.0).then(|| {
        let variants =
            iv.floor() as usize + usize::from(ivr.int(1000) < ((iv.fract()) * 1000.0) as usize);
        Intervention {
            p: ivr.int(2),
            turn: 3 + ivr.int(6) as i32,
            variants,
        }
    });
    let base = play_out(
        g,
        state,
        m,
        eps,
        seed,
        plan.as_ref()
            .filter(|x| x.variants > 0)
            .map(|x| (x.p, x.turn)),
    );
    let names = [decks[di].name.clone(), decks[dj].name.clone()];
    let winner = base
        .state
        .winner
        .unwrap_or_else(|| panic!("試合 {g} に勝者がいません"));
    let mut line = record_line(g, &names, &base, None);
    let mut samples = base.counts[0] + base.counts[1];
    let mut ivs = 0;
    if let (Some(plan), Some((at, k))) = (plan, base.branch.as_ref()) {
        // 抜くカード（同じカードは 1 回だけ）
        let mut cards: Vec<usize> = Vec::new();
        for (i, h) in at.players[plan.p].hand.iter().enumerate() {
            if !cards
                .iter()
                .any(|&j| at.players[plan.p].hand[j].card == h.card)
            {
                cards.push(i);
            }
        }
        for v in 0..plan.variants.min(cards.len()) {
            let pick = cards.swap_remove(ivr.int(cards.len()));
            let mut s = at.clone();
            let removed = s.players[plan.p].hand.remove(pick);
            let r = play_out(
                g,
                s,
                m,
                eps,
                seed ^ (0x85ebca6b_u32.wrapping_mul(v as u32 + 1)),
                None,
            );
            let info = format!(
                "{{\"p\":{},\"k\":{k},\"card\":{}}}",
                plan.p,
                serde_json::to_string(&data().cards[removed.card as usize].id).expect("ID")
            );
            line.push('\n');
            line.push_str(&record_line(g, &names, &r, Some(info)));
            samples += r.counts[0] + r.counts[1];
            ivs += 1;
        }
    }
    Summary {
        line,
        decks: names,
        winner,
        turns: base.state.turn,
        samples,
        explored: base.explored,
        ivs,
    }
}

fn selfplay(args: &[(String, String)]) -> Result<(), String> {
    let model_path = arg(args, "model").ok_or("--model がありません")?;
    let out = arg(args, "out").ok_or("--out がありません")?;
    let games = num_arg(args, "games", 100.0)?;
    let start = num_arg(args, "start", 0.0)?;
    let eps = num_arg(args, "eps", 0.1)?;
    let iv = num_arg(args, "iv", 0.0)?;
    if iv < 0.0 {
        return Err("--iv は 0 以上".into());
    }
    let opp_beam = match arg(args, "opp").unwrap_or("greedy") {
        "greedy" => false,
        "beam" => true,
        x => return Err(format!("--opp は greedy か beam: {x}")),
    };
    if games < 0.0 || games.fract() != 0.0 || start < 0.0 || start.fract() != 0.0 {
        return Err("--games・--start は 0 以上の整数".into());
    }
    let m = model_options(Arc::new(ValueNet::load(model_path)?), opp_beam)?;
    let decks = compare_decks();
    if decks.len() != 7 {
        return Err("自己対戦のデッキは 7 つの想定です".into());
    }
    let mut file = std::fs::File::create(out).map_err(|e| format!("{out} に書けません: {e}"))?;
    let t0 = Instant::now();
    let tasks: Vec<u32> = (0..games as u32).map(|k| start as u32 + k).collect();
    let mut summaries = parallel_map(
        &tasks,
        |&g, _| play_one(g, &decks, &m, eps, iv),
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
    let ivs: usize = summaries.iter().map(|r| r.ivs).sum();
    let turns: i64 = summaries.iter().map(|r| r.turns as i64).sum();
    let first_wins = summaries.iter().filter(|r| r.winner == 0).count();
    println!(
        "{out}: {n} 試合、局面 {samples}（ランダムに打った {explored}、介入して打った試合 {ivs}）、平均 {} ターン、先攻の勝率 {}%",
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
