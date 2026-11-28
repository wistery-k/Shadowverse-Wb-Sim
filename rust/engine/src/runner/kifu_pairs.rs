//! 枝の棋譜から、同じ局面から別の手順で打った 2 つのターン末の組を作る（比べるネットの学びの組。docs/ai-notes/15-2026-11-22.md「局面 2 つを比べるネットの小さな試し」）。
//!
//!   svwb kifu pairs --main <棋譜>[,…] --branch <棋譜>[,…] --opts '<設定>' [--reads 0] [--out 組.jsonl]
//!
//! - `--main` は本線の自己対戦の棋譜（`"source"` が `td branch` でない行）、`--branch` は枝の棋譜（`svwb td branch` の書いた `"source": "td branch"` の行）。
//!   ファイルかフォルダをコンマで並べる。枝ごとに、同じ試合番号の本線を探す
//! - 枝と本線の行動の列が初めて分かれる手（`div`）を探し、その手を選ぶ席 p のそのターン（`turn`）の終わり（ターン終了を選ぶ直前で、選択の途中でないもの）を、
//!   本線（`a`）と枝（`b`）のそれぞれで打ち直して取る。どちらかがそのターンのうちに決着したら、組にしない（理由ごとの数を出す）
//! - 組の行（1 枝 1 行）: `g`・`k`（同じ試合の枝の何番目か。枝の棋譜の並び順）・`div`・`turn`・`tc`・`seat`・`deck`・`opp`・`first`・`di`（そのターンの何手目で分かれたか）と、
//!   `a`・`b` のそれぞれに `won`（p の勝ち 1・負け 0・引き分け 0.5）・`endTurn`（決着したターン）・`end`・`endWin`（`--opts` の探索 AI がそのターン末に付ける点数と
//!   σ(a·点数) の勝率 %。kifu values と同じ）・`x`・`v`（補正がターン末に見る局面の補正の入力。kifu values の `--features 1` と同じ）・
//!   `later`（そのターンより後の p のターン末ごとの [ターン, endWin]）。`--reads N` なら `readLoss`・`readWin`・`pickWin`（kifu values と同じ。引き直しの種は
//!   試合のシードとターン番号から作るので、組の 2 つで同じ）
//! - 試合は変えない（打ち直すだけ）。打ち直せない行・打ち直した勝者が棋譜と違う行は書かず、数を出す

use super::kifu::parse_replay;
use super::kifu_cmd::{feature_cells, read_kifu, str_of, LOSS_SCORE};
use super::parallel::parallel_map;
use crate::game::{apply_legal, create_game, is_legal};
use crate::json::Json;
use crate::state::{Action, GameState, Phase};
use std::collections::BTreeMap;
use std::io::Write;

/// 1 本の線（本線か枝）を分かれた局面から最後まで打ち直した結果
struct Line {
    /// 席 p のそのターンの終わりの局面（ターン終了を打つ前）
    end: GameState,
    /// その後の p のターン末（ターン番号と局面）
    later: Vec<(i32, GameState)>,
    winner: Option<usize>,
    end_turn: i32,
}

/// s（分かれた手の前の局面）から actions[from..] を打ち、席 p のターン t の終わりと、その後の p のターン末を集める
fn play_line(
    s0: &GameState,
    actions: &[Action],
    from: usize,
    p: usize,
    t: i32,
) -> Result<Line, String> {
    let mut s = s0.clone();
    let mut end: Option<GameState> = None;
    let mut later = Vec::new();
    for (i, act) in actions.iter().enumerate().skip(from) {
        if s.phase == Phase::Ended {
            return Err(format!("{i} 手目: 決着した後にも行動があります"));
        }
        if end.is_none() && s.turn != t {
            return Err("ended".into());
        }
        if !is_legal(&s, act) {
            return Err(format!(
                "{i} 手目が打てません（記録したときとエンジンの版が違う可能性があります）"
            ));
        }
        if s.phase == Phase::Main
            && matches!(act, Action::EndTurn)
            && s.pending.is_none()
            && s.active == p
        {
            if end.is_none() {
                end = Some(s.clone());
            } else {
                later.push((s.turn, s.clone()));
            }
        }
        s = apply_legal(&s, act);
    }
    let Some(end) = end else {
        return Err("ended".into());
    };
    if s.phase != Phase::Ended {
        return Err("決着していない棋譜".into());
    }
    Ok(Line {
        end,
        later,
        winner: s.winner,
        end_turn: s.turn,
    })
}

struct PairOpts {
    opts: crate::ai::search::SearchOptions,
    net: crate::ai::valuenet::ValueNet,
    scale: f64,
    reads: u32,
}

fn side_cells(
    o: &PairOpts,
    agent: &crate::ai::search::SearchAgent,
    l: &Line,
    p: usize,
    seed: u32,
    t: i32,
) -> Json {
    let sig = |x: f64| 100.0 / (1.0 + (-o.scale * x).exp());
    let end = agent.turn_end_value(&l.end, p);
    let won = match l.winner {
        Some(w) if w == p => 1.0,
        Some(_) => 0.0,
        None => 0.5,
    };
    let mut row: Vec<(String, Json)> = vec![
        ("won".into(), Json::Num(won)),
        ("endTurn".into(), Json::Num(l.end_turn as f64)),
        ("end".into(), Json::Num(end)),
        ("endWin".into(), Json::Num(sig(end))),
    ];
    if o.reads > 0 {
        let base = super::human_plan::mix(seed, t as u32);
        let seeds: Vec<u32> = (0..o.reads)
            .map(|k| super::human_plan::mix(base, k))
            .collect();
        let rv = agent.read_values(&l.end, p, &seeds);
        let n = rv.len() as f64;
        let mix = agent.opts.rescore_mix;
        let loss = rv.iter().filter(|&&x| x <= LOSS_SCORE).count() as f64 / n;
        let read_win = rv.iter().map(|&x| sig(x)).sum::<f64>() / n;
        let pick_win = rv
            .iter()
            .map(|&x| sig((1.0 - mix) * x + mix * end))
            .sum::<f64>()
            / n;
        row.extend([
            ("readLoss".into(), Json::Num(loss)),
            ("readWin".into(), Json::Num(read_win)),
            ("pickWin".into(), Json::Num(pick_win)),
        ]);
    }
    row.extend(
        feature_cells(agent, &l.end, p, &o.net)
            .into_iter()
            .filter(|(k, _)| k != "extra"),
    );
    row.push((
        "later".into(),
        Json::Arr(
            l.later
                .iter()
                .map(|(n, s)| {
                    Json::Arr(vec![
                        Json::Num(*n as f64),
                        Json::Num(sig(agent.turn_end_value(s, p))),
                    ])
                })
                .collect(),
        ),
    ));
    Json::Obj(row)
}

/// 1 つの枝の組の行（組にしないなら Err(理由)）
fn pair_row(o: &PairOpts, main: &Json, branch: &Json, k: usize) -> Result<String, String> {
    let a = parse_replay(main)?;
    let b = parse_replay(branch)?;
    if a.seed != b.seed || a.decks != b.decks {
        return Err("本線と枝のデッキかシードが違う".into());
    }
    let Some(div) =
        (0..a.actions.len().min(b.actions.len())).find(|&i| a.actions[i] != b.actions[i])
    else {
        return Err("same".into());
    };
    let mut s = create_game([&a.decks[0], &a.decks[1]], a.seed);
    let mut turn_start = 0usize;
    for (i, act) in a.actions.iter().enumerate().take(div) {
        if !is_legal(&s, act) {
            return Err(format!(
                "{i} 手目が打てません（記録したときとエンジンの版が違う可能性があります）"
            ));
        }
        let next = apply_legal(&s, act);
        if next.turn != s.turn {
            turn_start = i + 1;
        }
        s = next;
    }
    if s.phase != Phase::Main {
        return Err("分かれた手がメインのフェイズでない".into());
    }
    let (p, t) = (s.active, s.turn);
    let agent = crate::ai::search::SearchAgent::new(o.opts.clone());
    let la = play_line(&s, &a.actions, div, p, t)?;
    let lb = play_line(&s, &b.actions, div, p, t)?;
    let winner_of = |v: &Json| match v.get("winner") {
        Some(Json::Num(x)) => Some(*x as usize),
        _ => None,
    };
    if la.winner != winner_of(main) || lb.winner != winner_of(branch) {
        return Err("打ち直した勝者が棋譜と違う（エンジンの版が違う）".into());
    }
    let names = match main.get("names") {
        Some(Json::Arr(xs)) if xs.len() == 2 => [str_of(xs.first()), str_of(xs.get(1))],
        _ => [String::new(), String::new()],
    };
    let first = match main.get("first") {
        Some(Json::Num(x)) => Json::Bool(*x as usize == p),
        _ => Json::Null,
    };
    let g = match main.get("g") {
        Some(Json::Num(x)) => *x,
        _ => -1.0,
    };
    // 分かれた手の前のターン末とは関係なく、そのターンの最初からの手の数（ターンの最初の手が 0）
    let di = div - turn_start;
    let row = Json::Obj(vec![
        ("g".into(), Json::Num(g)),
        ("k".into(), Json::Num(k as f64)),
        ("div".into(), Json::Num(div as f64)),
        ("di".into(), Json::Num(di as f64)),
        ("turn".into(), Json::Num(t as f64)),
        ("tc".into(), Json::Num(s.players[p].turn_count as f64)),
        ("seat".into(), Json::Num(p as f64)),
        ("deck".into(), Json::Str(names[p].clone())),
        ("opp".into(), Json::Str(names[1 - p].clone())),
        ("first".into(), first),
        ("a".into(), side_cells(o, &agent, &la, p, a.seed, t)),
        ("b".into(), side_cells(o, &agent, &lb, p, a.seed, t)),
    ]);
    let mut text = row.stringify();
    text.push('\n');
    Ok(text)
}

fn list(v: Option<&String>) -> Vec<String> {
    v.map(|x| {
        x.split(',')
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect()
    })
    .unwrap_or_default()
}

pub fn pairs(argv: &[String]) -> Result<(), String> {
    let mut kv: BTreeMap<String, String> = BTreeMap::new();
    let mut it = argv.iter();
    while let Some(k) = it.next() {
        let Some(name) = k.strip_prefix("--") else {
            return Err(format!("引数が分かりません: {k}"));
        };
        if !["main", "branch", "opts", "reads", "out"].contains(&name) {
            return Err(format!("知らない引数: --{name}"));
        }
        let v = it
            .next()
            .ok_or_else(|| format!("--{name} の値がありません"))?;
        kv.insert(name.to_string(), v.clone());
    }
    let mains = list(kv.get("main"));
    let branches = list(kv.get("branch"));
    if mains.is_empty() || branches.is_empty() {
        return Err("使い方: svwb kifu pairs --main <棋譜>[,…] --branch <棋譜>[,…] --opts '<設定>' [--reads 0] [--out 組.jsonl]".into());
    }
    let text = kv.get("opts").cloned().unwrap_or_else(|| "{}".into());
    let opts = super::options::compare_options(&text)?;
    let net = match Json::parse(&text)?.get("valueNet") {
        Some(Json::Str(path)) => crate::ai::valuenet::ValueNet::load(path)?,
        _ => return Err("--opts の valueNet（入力の並びを決めるモデル）が要ります".into()),
    };
    let reads = match kv.get("reads") {
        None => 0,
        Some(x) => x
            .parse::<u32>()
            .map_err(|_| format!("--reads は 0 以上の整数: {x}"))?,
    };
    let o = PairOpts {
        opts,
        scale: net.a(),
        net,
        reads,
    };
    let mut by_g: BTreeMap<u64, Json> = BTreeMap::new();
    for v in read_kifu(&mains)? {
        if str_of(v.get("source")) == "td branch" {
            continue;
        }
        if let Some(Json::Num(g)) = v.get("g") {
            by_g.insert(*g as u64, v);
        }
    }
    let mut items: Vec<(u64, usize, Json)> = Vec::new();
    let mut seen: BTreeMap<u64, usize> = BTreeMap::new();
    for v in read_kifu(&branches)? {
        if str_of(v.get("source")) != "td branch" {
            continue;
        }
        if let Some(Json::Num(g)) = v.get("g") {
            let g = *g as u64;
            let k = seen.entry(g).or_insert(0);
            items.push((g, *k, v));
            *k += 1;
        }
    }
    let results = parallel_map(
        &items,
        |(g, k, v), _| match by_g.get(g) {
            None => Err("本線が無い".to_string()),
            Some(main) => pair_row(&o, main, v, *k),
        },
        |_, _, _, _| {},
    );
    let mut sink: Box<dyn Write> = match kv.get("out") {
        Some(p) => Box::new(std::io::BufWriter::new(
            std::fs::File::create(p).map_err(|e| format!("{p} に書けません: {e}"))?,
        )),
        None => Box::new(std::io::BufWriter::new(std::io::stdout())),
    };
    let mut skipped: BTreeMap<String, usize> = BTreeMap::new();
    let mut rows = 0usize;
    for r in results {
        match r {
            Ok(text) => {
                rows += 1;
                sink.write_all(text.as_bytes())
                    .map_err(|e| format!("書けません: {e}"))?;
            }
            Err(why) => *skipped.entry(why).or_insert(0) += 1,
        }
    }
    sink.flush().map_err(|e| format!("書けません: {e}"))?;
    eprintln!("枝 {}（本線 {}）、組 {rows}", items.len(), by_g.len());
    for (why, n) in &skipped {
        eprintln!("  組にしない {n}: {why}");
    }
    if let Some(p) = kv.get("out") {
        println!("組 {rows} 行: {p}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::search::SearchOptions;
    use crate::ai::{Agent, RandomAgent, Rng};
    use crate::data::{data, CardIdx};
    use crate::game::legal_actions;
    use crate::state_json::action_to_json;

    /// s から乱数の手で最後まで打つ（打った手を actions に足す）。決着しなければ None
    fn finish(mut s: GameState, rng: &mut Rng, actions: &mut Vec<Action>) -> Option<usize> {
        while s.phase != Phase::Ended && actions.len() < 3000 {
            let legal = legal_actions(&s);
            let act = RandomAgent.choose_action(&s, &legal, rng);
            s = apply_legal(&s, &act);
            actions.push(act);
        }
        s.winner
    }

    fn replay_json(
        g: u32,
        source: &str,
        decks: [&[CardIdx]; 2],
        winner: usize,
        actions: &[Action],
    ) -> Json {
        let ids = |d: &[CardIdx]| {
            Json::Arr(
                d.iter()
                    .map(|&c| Json::Str(crate::state::card(c).id.clone()))
                    .collect(),
            )
        };
        Json::Obj(vec![
            ("kind".into(), Json::Str("replay".into())),
            ("source".into(), Json::Str(source.into())),
            ("g".into(), Json::Num(g as f64)),
            (
                "names".into(),
                Json::Arr(vec![Json::Str("a".into()), Json::Str("b".into())]),
            ),
            ("seed".into(), Json::Num(g as f64)),
            ("first".into(), Json::Num(0.0)),
            (
                "decks".into(),
                Json::Arr(vec![ids(decks[0]), ids(decks[1])]),
            ),
            ("winner".into(), Json::Num(winner as f64)),
            (
                "actions".into(),
                Json::Arr(actions.iter().map(action_to_json).collect()),
            ),
        ])
    }

    #[test]
    fn pairs_take_both_turn_ends_from_the_divergence() {
        let decks = &data().decks;
        let (d0, d1) = (decks[0].cards.clone(), decks[1].cards.clone());
        let o = PairOpts {
            opts: SearchOptions::default(),
            net: crate::ai::valuenet::ValueNet::new(crate::ai::aidata::ai_data().value_net.clone())
                .unwrap(),
            scale: 1.0,
            reads: 2,
        };
        let mut done = 0;
        for seed in 1..60u32 {
            // 本線: 乱数の手で最後まで
            let mut main_actions = Vec::new();
            let s0 = create_game([&d0, &d1], seed);
            let Some(wa) = finish(s0.clone(), &mut Rng::new(seed), &mut main_actions) else {
                continue;
            };
            // 枝: 本線の 3 ターン目以降で、合法手が 2 つ以上あるメインの局面の手を、別の手に替えて乱数の手で最後まで
            let mut s = s0.clone();
            let mut div = None;
            for (i, act) in main_actions.iter().enumerate() {
                if s.turn >= 5 && s.phase == Phase::Main && s.pending.is_none() {
                    let legal = legal_actions(&s);
                    if let Some(other) = legal
                        .iter()
                        .find(|x| *x != act && !matches!(x, Action::EndTurn))
                    {
                        div = Some((i, other.clone(), s.clone()));
                        break;
                    }
                }
                s = apply_legal(&s, act);
            }
            let Some((i, other, at)) = div else { continue };
            let mut branch_actions = main_actions[..i].to_vec();
            branch_actions.push(other.clone());
            let after = apply_legal(&at, &other);
            let Some(wb) = finish(after, &mut Rng::new(seed + 1000), &mut branch_actions) else {
                continue;
            };
            let main = replay_json(seed, "td selfplay", [&d0, &d1], wa, &main_actions);
            let branch = replay_json(seed, "td branch", [&d0, &d1], wb, &branch_actions);
            let row = match pair_row(&o, &main, &branch, 0) {
                Ok(t) => Json::parse(t.trim()).unwrap(),
                Err(why) if why == "ended" => continue,
                Err(why) => panic!("{why}"),
            };
            let num = |v: &Json, k: &str| match v.get(k) {
                Some(Json::Num(x)) => *x,
                _ => panic!("{k} がない"),
            };
            assert_eq!(num(&row, "div") as usize, i);
            assert_eq!(num(&row, "turn") as i32, at.turn);
            assert_eq!(num(&row, "seat") as usize, at.active);
            let p = at.active;
            for (k, w) in [("a", wa), ("b", wb)] {
                let side = row.get(k).unwrap();
                assert_eq!(num(side, "won"), if w == p { 1.0 } else { 0.0 });
                let Some(Json::Arr(x)) = side.get("x") else {
                    panic!("x がない")
                };
                assert!(!x.is_empty());
                assert!(side.get("pickWin").is_some());
            }
            done += 1;
            if done == 3 {
                break;
            }
        }
        assert_eq!(done, 3, "組を作れた試合が足りない");
    }
}
