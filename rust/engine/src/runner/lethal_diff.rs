//! lethal-diff: compare（A = 設定に lethalRead を足したもの、B = 設定そのまま。鏡）と同じ試合を打ち、lethalRead で手や勝ち負けが
//! どう変わったかを調べる（docs/ai-notes.md「見逃したリーサルから相手の手札を絞る」）。
//!
//!   svwb lethal-diff --out 記録.jsonl [--games 1600] [--start 0] [--opts '<設定JSON>'] [--samples 6] [--playouts 64] [--replays リプレイ.jsonl]
//!
//! 1. A の試合（compare と同じ試合・同じ手）を全部打ち、A の読み（hand_reading）が効いた手番を覚える。読みが効いた A のターンの最初の手番では、
//!    lethalRead の無い新しい AI が同じ局面・同じ乱数で選ぶ手とも比べる（"type":"change"）
//! 2. 読みが効いた組、A の勝ちが 1 勝 1 敗でない組、確かめ用に残りの 20 組に 1 組で、B どうしの試合（lethalRead が無ければ打たれた試合。
//!    鏡なので組の 2 試合で同じ）を打ち、A の試合と最初に食い違う手と、AI の乱数が最初に食い違う手を書く（"type":"diff"）。
//!    読みは決定化で乱数を使う量を変えるので、同じ手を選んでも後の乱数がずれ、相手の手から食い違うこともある
//! 3. 読みが効いた A のターンの最初の手番ごとに、読みあり（種 1..K）・読みなし（同じ種）・読みなし（別の種）で --samples 回ずつ手を選ばせ、
//!    手の分布の違い（全変動距離）を比べる（"type":"dist"。読みが手を動かす分と、AI の乱数だけで手が動く分）。
//!    同じ種で読みありと読みなしの手が違った組ごとに、2 つの手を打ち比べる（"type":"playout"。差は違った回数で重み付けて平均する）:
//!    手札・場は本当の局面のまま、両方の山札の順番と局面の乱数を並べ直し（どちらの手も同じ種）、その手を打って、残りを B の設定どうしで最後まで打つ。--playouts 回
//!
//! 最後の行は "type":"summary"。--replays なら、食い違う試合の A の試合と B どうしの試合を compare --replays と同じ形で書く
//! （npm run dev の「リプレイ検索」で読める）

use super::compare::compare_setup;
use super::compare_decks;
use super::fixed;
use super::human_plan::step_text;
use super::options::compare_options;
use super::parallel::{parallel_map, thread_count};
use super::ReplayRecord;
use crate::ai::hand_read::HandReading;
use crate::ai::search::{MulliganMode, SearchAgent, SearchOptions};
use crate::ai::{Agent, Rng};
use crate::data::{data, Deck};
use crate::game::{acting_player, apply_action, apply_legal, create_game, is_legal, legal_actions};
use crate::state::{card, opponent, Action, GameState, Phase, PlayerIndex};
use serde_json::{json, Value};
use std::io::Write;
use std::sync::Arc;
use std::time::Instant;

/// compare と同じ、席ごとの設定（デフォルトデッキと違うデッキのマリガンは引き直しを試す）
fn seat_options(o: &SearchOptions, d: &Deck) -> SearchOptions {
    let mut o = o.clone();
    if o.mulligan.needs_deck_model() && !data().decks.iter().any(|x| x.cards == d.cards) {
        o.mulligan = MulliganMode::Sample;
    }
    o
}

/// A の読みが効いた手番（手の列の番号、選ぶ前の AI の乱数、読み）
struct Active {
    step: usize,
    rng: u32,
    reading: HandReading,
    /// A のターンの最初の手番で、選べる手が 2 つ以上
    turn_first: bool,
}

struct Played {
    actions: Vec<Action>,
    /// 各手を選ぶ前の、試合の AI の乱数の状態
    rngs: Vec<u32>,
    winner: PlayerIndex,
    active: Vec<Active>,
    /// 読みが効いた、A のターンの最初の手番で、lethalRead の無い AI（新しく作ったもの・同じ乱数）が選ぶ手と違ったもの（手の列の番号、その手）
    changes: Vec<(usize, Action)>,
}

/// play_match と同じ試合（席 a_seat が a_opts、もう一方が b_opts）。track なら A の読みが効いた手番を覚え、
/// そのうち A のターンの最初の手番（打ちかけの並びが無い）では、b_opts の新しい AI が同じ局面・同じ乱数で選ぶ手と比べる
fn play(
    a_opts: &SearchOptions,
    b_opts: &SearchOptions,
    seats: [&Deck; 2],
    a_seat: PlayerIndex,
    seed: u32,
    track: bool,
) -> Played {
    let mut a = SearchAgent::new(seat_options(a_opts, seats[a_seat]));
    let mut b = SearchAgent::new(seat_options(b_opts, seats[1 - a_seat]));
    let mut s = create_game([&seats[0].cards, &seats[1].cards], seed);
    let mut rng = Rng::new(seed ^ 0x9e3779b9);
    let mut actions = Vec::new();
    let mut rngs = Vec::new();
    let mut active = Vec::new();
    let mut changes = Vec::new();
    let mut first_of_turn = -1;
    while s.phase != Phase::Ended {
        assert!(
            actions.len() < 10000,
            "アクション数が上限 10000 を超えました（シード {seed}）"
        );
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        let rng0 = rng.state;
        rngs.push(rng0);
        let act = if actor == a_seat {
            b.observe(&s);
            let x = a.choose_action(&s, &legal, &mut rng);
            let turn_first = s.phase == Phase::Main
                && s.pending.is_none()
                && actor == s.active
                && first_of_turn != s.turn;
            if turn_first {
                first_of_turn = s.turn;
            }
            if track {
                if let Some(rd) = &a.opts.hand_reading {
                    active.push(Active {
                        step: actions.len(),
                        rng: rng0,
                        reading: (**rd).clone(),
                        turn_first: turn_first && legal.len() > 1,
                    });
                    if turn_first && legal.len() > 1 {
                        let mut twin = SearchAgent::new(seat_options(b_opts, seats[a_seat]));
                        let y = crate::ai::exact_lethal::with_isolated_cache(|| {
                            twin.choose_action(&s, &legal, &mut Rng::new(rng0))
                        });
                        if y != x {
                            changes.push((actions.len(), y));
                        }
                    }
                }
            }
            x
        } else {
            a.observe(&s);
            b.choose_action(&s, &legal, &mut rng)
        };
        s = apply_action(&s, &act);
        actions.push(act);
    }
    Played {
        actions,
        rngs,
        winner: s
            .winner
            .unwrap_or_else(|| panic!("勝者がいません（シード {seed}）")),
        active,
        changes,
    }
}

/// 試合の始めから actions を打った局面
fn replay(seats: [&Deck; 2], seed: u32, actions: &[Action]) -> GameState {
    let mut s = create_game([&seats[0].cards, &seats[1].cards], seed);
    for a in actions {
        s = apply_action(&s, a);
    }
    s
}

/// start から actions を打った手を、ターンごとに 1 行にまとめる（見る側 a_seat の体力・相手の体力と、手番の側から見た手）
fn turn_lines(start: &GameState, actions: &[Action], a_seat: PlayerIndex) -> Vec<String> {
    let mut s = start.clone();
    let mut lines = Vec::new();
    let mut cur: Option<(i32, String, Vec<String>)> = None;
    for a in actions {
        if cur.as_ref().is_none_or(|c| c.0 != s.turn) {
            if let Some((_, head, xs)) = cur.take() {
                lines.push(format!("{head}: {}", xs.join(" / ")));
            }
            let who = if s.active == a_seat { "A" } else { "相手" };
            let head = format!(
                "ターン {}（{who}、A の体力 {}・相手 {}）",
                s.turn,
                s.players[a_seat].leader_hp,
                s.players[opponent(a_seat)].leader_hp
            );
            cur = Some((s.turn, head, Vec::new()));
        }
        let actor = acting_player(&s);
        if let Some(c) = cur.as_mut() {
            c.2.push(step_text(&s, a, actor));
        }
        s = apply_action(&s, a);
    }
    if let Some((_, head, xs)) = cur.take() {
        lines.push(format!("{head}: {}", xs.join(" / ")));
    }
    lines.push(format!(
        "終わり: ターン {}、{}の勝ち",
        s.turn,
        if s.winner == Some(a_seat) {
            "A"
        } else {
            "相手"
        }
    ));
    lines
}

/// 読み直した候補ごとの [最初の手, 選ぶときの値, 読んだ点数]（think_with。新しく作った AI で、選んだときの乱数から）
fn candidate_values(
    s: &GameState,
    legal: &[Action],
    opts: SearchOptions,
    rng0: u32,
    p: PlayerIndex,
) -> Value {
    let ag = SearchAgent::new(opts);
    crate::ai::exact_lethal::with_isolated_cache(|| {
        ag.think_with(s, legal, &mut Rng::new(rng0), None)
            .map(|t| {
                let vals: Vec<Value> = t
                    .candidates
                    .iter()
                    .filter_map(|c| {
                        let v = c.value?;
                        Some(json!([
                            step_text(s, &c.action, p),
                            v,
                            c.read.map(|r| r.total)
                        ]))
                    })
                    .collect();
                Value::Array(vals)
            })
            .unwrap_or(Value::Null)
    })
}

/// 打ち比べの 1 試合。手札・場は start のまま、両方の山札と局面の乱数を seed で並べ直し、first を打って、残りを opts どうしで打つ。勝者
fn playout(
    start: &GameState,
    first: &Action,
    opts: &SearchOptions,
    seats: [&Deck; 2],
    seed: u32,
) -> Option<PlayerIndex> {
    let mut t = start.clone();
    let mut r = Rng::new(seed);
    r.shuffle(t.players[0].deck.make_mut());
    r.shuffle(t.players[1].deck.make_mut());
    let a = r.int(1 << 30) as f64;
    let b = r.int(4) as f64;
    t.rng = (a * 4.0 + b).floor() as u32;
    if !is_legal(&t, first) {
        return None;
    }
    let mut s = apply_legal(&t, first);
    let mut agents = [
        SearchAgent::new(seat_options(opts, seats[0])),
        SearchAgent::new(seat_options(opts, seats[1])),
    ];
    let mut rng = Rng::new(seed ^ 0x9e3779b9);
    let mut n = 0;
    while s.phase != Phase::Ended {
        n += 1;
        assert!(
            n <= 10000,
            "アクション数が上限 10000 を超えました（打ち比べ、シード {seed}）"
        );
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        agents[1 - actor].observe(&s);
        let x = agents[actor].choose_action(&s, &legal, &mut rng);
        s = apply_action(&s, &x);
    }
    s.winner
}

/// 同じ種で読みあり・なしの手が違った組（読みありの手、読みなしの手、回数）
type MovePairs = Vec<(Action, Action, u32)>;

/// 変えた手 1 つ
struct Diff {
    /// A の試合の番号（tasks の添え字）
    task: usize,
    /// B どうしの試合の番号（selected の添え字）
    d_game: usize,
    step: usize,
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mut games: u32 = 1600;
    let mut start: u32 = 0;
    let mut opts_text = "{}".to_string();
    let mut out_path: Option<String> = None;
    let mut replays_path: Option<String> = None;
    let mut playouts: u32 = 64;
    let mut samples: u32 = 6;
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
            "--playouts" => playouts = int()?,
            "--samples" => samples = int()?,
            "--opts" => opts_text = v.clone(),
            "--out" => out_path = Some(v.clone()),
            "--replays" => replays_path = Some(v.clone()),
            _ => return Err(format!("知らないオプション: {key}")),
        }
    }
    let out_path = out_path.ok_or("--out で書き出すファイルを指定します")?;
    let b_opts = compare_options(&opts_text).map_err(|e| format!("--opts: {e}"))?;
    let a_opts = SearchOptions {
        lethal_read: true,
        ..b_opts.clone()
    };
    let decks = compare_decks();
    let mut file = std::io::BufWriter::new(
        std::fs::File::create(&out_path).map_err(|e| format!("{out_path}: {e}"))?,
    );
    let mut write = |v: &Value| -> Result<(), String> {
        writeln!(file, "{v}")
            .and_then(|_| file.flush())
            .map_err(|e| format!("{out_path}: {e}"))
    };
    let t0 = Instant::now();

    // 1. A の試合
    let tasks: Vec<(u32, bool)> = (0..games)
        .flat_map(|k| [(start + k, false), (start + k, true)])
        .collect();
    eprintln!("A の試合 {} 試合（並列 {}）", tasks.len(), thread_count());
    let a_games = parallel_map(
        &tasks,
        |&(g, swap), _| {
            let (a_seat, seats, seed) = compare_setup(&decks, g, swap, true);
            play(&a_opts, &b_opts, seats, a_seat, seed, true)
        },
        |done, total, _, _| eprint!("\r{done}/{total}"),
    );
    let a_won = |i: usize| {
        let (g, swap) = tasks[i];
        a_games[i].winner == compare_setup(&decks, g, swap, true).0
    };
    let wins: u32 = (0..tasks.len()).map(|i| a_won(i) as u32).sum();
    let mut pair_counts = [0u32; 3];
    for k in 0..games as usize {
        pair_counts[a_won(2 * k) as usize + a_won(2 * k + 1) as usize] += 1;
    }
    eprintln!(
        "\nA {wins}/{}（組: 2 勝 {}・1 勝 {}・0 勝 {}）{} 秒",
        tasks.len(),
        pair_counts[2],
        pair_counts[1],
        pair_counts[0],
        fixed(t0.elapsed().as_secs_f64(), 0)
    );

    // 2. B どうしの試合
    let mut selected: Vec<u32> = Vec::new();
    let mut quiet = 0;
    for k in 0..games as usize {
        let g = start + k as u32;
        let active = [
            !a_games[2 * k].active.is_empty(),
            !a_games[2 * k + 1].active.is_empty(),
        ];
        let w = a_won(2 * k) as u32 + a_won(2 * k + 1) as u32;
        let check = !active[0] && !active[1] && w == 1 && {
            quiet += 1;
            quiet % 20 == 1
        };
        let play_d = active[0] || active[1] || w != 1 || check;
        if play_d {
            selected.push(g);
        }
        write(&json!({
            "type": "pair",
            "g": g,
            "wins": w,
            "active": active,
            "playedB": play_d,
            "check": check,
        }))?;
    }
    eprintln!("B どうしの試合 {} 試合", selected.len());
    let d_games = parallel_map(
        &selected,
        |&g, _| {
            let (_, seats, seed) = compare_setup(&decks, g, false, true);
            play(&b_opts, &b_opts, seats, 0, seed, false)
        },
        |done, total, _, _| eprint!("\r{done}/{total}"),
    );
    eprintln!("（{} 秒）", fixed(t0.elapsed().as_secs_f64(), 0));

    // A の試合と B どうしの試合が最初に食い違う所
    let mut diffs: Vec<Diff> = Vec::new();
    let mut odd: Vec<Value> = Vec::new();
    let (mut same_active, mut checked_same) = (0, 0);
    for (di, &g) in selected.iter().enumerate() {
        let k = (g - start) as usize;
        for task in [2 * k, 2 * k + 1] {
            let a = &a_games[task];
            let d = &d_games[di];
            match a.actions.iter().zip(&d.actions).position(|(x, y)| x != y) {
                Some(step) => diffs.push(Diff {
                    task,
                    d_game: di,
                    step,
                }),
                None => {
                    if a.actions.len() != d.actions.len() || a.winner != d.winner {
                        odd.push(json!({"g": g, "swap": tasks[task].1}));
                    } else if a.active.is_empty() {
                        checked_same += 1;
                    } else {
                        same_active += 1;
                    }
                }
            }
        }
    }
    // 読みが変えた手（A のターンの最初の手番で、lethalRead の無い AI と違う手）
    let changes: Vec<(usize, usize)> = a_games
        .iter()
        .enumerate()
        .flat_map(|(t, a)| (0..a.changes.len()).map(move |c| (t, c)))
        .collect();
    eprintln!(
        "食い違う試合 {}（読みが効いて同じ手のままの試合 {same_active}、読みが効かず同じ手の試合 {checked_same}、勝者の食い違い {}）、読みが変えた手 {}",
        diffs.len(),
        odd.len(),
        changes.len()
    );
    let d_of = |task: usize| -> Option<usize> {
        let g = tasks[task].0;
        selected.iter().position(|&x| x == g)
    };

    // 食い違う試合ごとの、最初に食い違う手・乱数・その後の手の列
    let described: Vec<(Value, Option<[String; 2]>)> = parallel_map(
        &diffs,
        |df, _| {
            let (g, swap) = tasks[df.task];
            let (a_seat, seats, seed) = compare_setup(&decks, g, swap, true);
            let a = &a_games[df.task];
            let d = &d_games[df.d_game];
            let s = replay(seats, seed, &a.actions[..df.step]);
            let actor = acting_player(&s);
            let q = opponent(a_seat);
            let rng_step = a.rngs.iter().zip(&d.rngs).position(|(x, y)| x != y);
            let rng_turn = rng_step.map(|k| replay(seats, seed, &a.actions[..k]).turn);
            let first_change = a.changes.first().map(|c| c.0);
            let row = json!({
                "type": "diff",
                "g": g,
                "swap": swap,
                "step": df.step,
                "turn": s.turn,
                "aSeat": a_seat,
                "byA": actor == a_seat,
                "deck": seats[a_seat].name,
                "oppDeck": seats[q].name,
                "hp": s.players[a_seat].leader_hp,
                "oppHp": s.players[q].leader_hp,
                "rngStep": rng_step,
                "rngTurn": rng_turn,
                "firstChange": first_change,
                "atChange": first_change == Some(df.step),
                "readingActive": a.active.iter().any(|x| x.step == df.step),
                "a": step_text(&s, &a.actions[df.step], actor),
                "b": step_text(&s, &d.actions[df.step], actor),
                "aWon": a.winner == a_seat,
                "bWon": d.winner == a_seat,
                "restA": turn_lines(&s, &a.actions[df.step..], a_seat),
                "restB": turn_lines(&s, &d.actions[df.step..], a_seat),
            });
            let lines = replays_path.as_ref().map(|_| {
                let line = |p: &Played, agents: [&str; 2]| {
                    let end = replay(seats, seed, &p.actions);
                    ReplayRecord {
                        source: "lethal-diff",
                        g,
                        names: [&seats[0].name, &seats[1].name],
                        agents,
                        decks: [&seats[0].cards, &seats[1].cards],
                        seed,
                        end: &end,
                        actions: &p.actions,
                    }
                    .line()
                };
                let la = if a_seat == 0 {
                    ["A lethalRead", "B"]
                } else {
                    ["B", "A lethalRead"]
                };
                [line(a, la), line(d, ["B", "B"])]
            });
            (row, lines)
        },
        |_, _, _, _| {},
    );
    for (row, _) in &described {
        write(row)?;
    }
    for o in &odd {
        write(&json!({"type": "odd", "game": o}))?;
    }
    if let Some(path) = &replays_path {
        let mut f = std::io::BufWriter::new(
            std::fs::File::create(path).map_err(|e| format!("{path}: {e}"))?,
        );
        for (_, lines) in &described {
            for l in lines.iter().flatten() {
                writeln!(f, "{l}").map_err(|e| format!("{path}: {e}"))?;
            }
        }
        f.flush().map_err(|e| format!("{path}: {e}"))?;
    }
    let flips: i32 = described
        .iter()
        .map(|(r, _)| {
            r["aWon"].as_bool().unwrap_or(false) as i32
                - r["bWon"].as_bool().unwrap_or(false) as i32
        })
        .sum();

    // 読みが変えた手ごとの局面・2 つの手・候補の点数
    let change_rows: Vec<Value> = parallel_map(
        &changes,
        |&(task, c), _| {
            let (g, swap) = tasks[task];
            let (a_seat, seats, seed) = compare_setup(&decks, g, swap, true);
            let a = &a_games[task];
            let (step, ref b) = a.changes[c];
            let s = replay(seats, seed, &a.actions[..step]);
            let q = opponent(a_seat);
            let legal = legal_actions(&s);
            let act = a
                .active
                .iter()
                .find(|x| x.step == step)
                .expect("読みの手番");
            let excluded: Vec<String> = act
                .reading
                .excluded
                .first()
                .map(|(_, e)| e.iter().map(|&c| card(c).name.clone()).collect())
                .unwrap_or_default();
            let hidden: Vec<String> = s.players[q]
                .hand
                .iter()
                .filter(|h| !h.revealed)
                .map(|h| card(h.card).name.clone())
                .collect();
            let d = d_of(task).map(|i| &d_games[i]);
            json!({
                "type": "change",
                "g": g,
                "swap": swap,
                "step": step,
                "turn": s.turn,
                "aSeat": a_seat,
                "deck": seats[a_seat].name,
                "oppDeck": seats[q].name,
                "hp": s.players[a_seat].leader_hp,
                "oppHp": s.players[q].leader_hp,
                "pp": s.players[a_seat].pp,
                "slots": act.reading.excluded.len(),
                "excluded": excluded,
                "oppHidden": hidden,
                "a": step_text(&s, &a.actions[step], a_seat),
                "b": step_text(&s, b, a_seat),
                "firstDiff": d.and_then(|d| a.actions.iter().zip(&d.actions).position(|(x, y)| x != y)),
                "aWon": a.winner == a_seat,
                "bWon": d.map(|d| d.winner == a_seat),
                "valsA": candidate_values(
                    &s,
                    &legal,
                    SearchOptions {
                        hand_reading: Some(Arc::new(act.reading.clone())),
                        ..b_opts.clone()
                    },
                    act.rng,
                    a_seat,
                ),
                "valsB": candidate_values(&s, &legal, b_opts.clone(), act.rng, a_seat),
                "restA": turn_lines(&s, &a.actions[step..], a_seat),
            })
        },
        |_, _, _, _| {},
    );
    for r in &change_rows {
        write(r)?;
    }

    // 読みが効いた A のターンの最初の手番ごとに、読みあり（種 1..K）・読みなし（同じ種 1..K）・読みなし（別の種 K+1..2K）で選ぶ手を数える
    // （読みが手を動かす分と、AI の乱数だけで手が動く分を比べる）
    let dist_tasks: Vec<(usize, usize)> = a_games
        .iter()
        .enumerate()
        .flat_map(|(t, a)| {
            a.active
                .iter()
                .enumerate()
                .filter(|(_, x)| x.turn_first)
                .map(move |(i, _)| (t, i))
        })
        .collect();
    eprintln!(
        "読みが効いたターンの最初の手番 {} 個 × {} 回 × 3",
        dist_tasks.len(),
        samples
    );
    let t2 = Instant::now();
    let dists: Vec<(Value, MovePairs)> = parallel_map(
        &dist_tasks,
        |&(task, i), _| {
            let (g, swap) = tasks[task];
            let (a_seat, seats, seed) = compare_setup(&decks, g, swap, true);
            let a = &a_games[task];
            let x = &a.active[i];
            let s = replay(seats, seed, &a.actions[..x.step]);
            let legal = legal_actions(&s);
            let read_opts = SearchOptions {
                hand_reading: Some(Arc::new(x.reading.clone())),
                ..seat_options(&b_opts, seats[a_seat])
            };
            let plain = seat_options(&b_opts, seats[a_seat]);
            let pick = |o: &SearchOptions, sd: u32| -> Action {
                let mut ag = SearchAgent::new(o.clone());
                crate::ai::exact_lethal::with_isolated_cache(|| {
                    ag.choose_action(&s, &legal, &mut Rng::new(sd))
                })
            };
            let mut counts: Vec<(Action, [u32; 3])> = Vec::new();
            let mut add = |t: &Action, k: usize| match counts.iter_mut().find(|c| &c.0 == t) {
                Some(c) => c.1[k] += 1,
                None => {
                    let mut n = [0; 3];
                    n[k] = 1;
                    counts.push((t.clone(), n));
                }
            };
            // 同じ種で読みあり・なしの手が違った組（読みありの手、読みなしの手、回数）
            let mut pairs: MovePairs = Vec::new();
            let (mut read_changed, mut noise_changed) = (0, 0);
            for j in 0..samples {
                let sd = x.rng ^ (j + 1).wrapping_mul(0x9e37_79b9);
                let sd2 = x.rng ^ (j + 1 + samples).wrapping_mul(0x9e37_79b9);
                let r = pick(&read_opts, sd);
                let d = pick(&plain, sd);
                let d2 = pick(&plain, sd2);
                add(&r, 0);
                add(&d, 1);
                add(&d2, 2);
                noise_changed += (d2 != d) as u32;
                if r != d {
                    read_changed += 1;
                    match pairs.iter_mut().find(|p| p.0 == r && p.1 == d) {
                        Some(p) => p.2 += 1,
                        None => pairs.push((r, d, 1)),
                    }
                }
            }
            let k = samples.max(1) as f64;
            let tv = |u: usize, v: usize| {
                counts
                    .iter()
                    .map(|c| (c.1[u] as f64 - c.1[v] as f64).abs())
                    .sum::<f64>()
                    / (2.0 * k)
            };
            let change = a.changes.iter().find(|c| c.0 == x.step);
            let row = json!({
                "type": "dist",
                "g": g,
                "swap": swap,
                "step": x.step,
                "turn": s.turn,
                "deck": seats[a_seat].name,
                "oppDeck": seats[opponent(a_seat)].name,
                "hp": s.players[a_seat].leader_hp,
                "oppHp": s.players[opponent(a_seat)].leader_hp,
                "changed": change.is_some(),
                "chosen": step_text(&s, &a.actions[x.step], a_seat),
                "twin": change.map(|c| step_text(&s, &c.1, a_seat)),
                "counts": counts.iter().map(|c| json!([step_text(&s, &c.0, a_seat), c.1])).collect::<Vec<_>>(),
                "tvRead": tv(0, 1),
                "tvNoise": tv(2, 1),
                "readChanged": read_changed,
                "noiseChanged": noise_changed,
                "pairs": pairs.iter().map(|p| json!([step_text(&s, &p.0, a_seat), step_text(&s, &p.1, a_seat), p.2])).collect::<Vec<_>>(),
            });
            (row, pairs)
        },
        |done, total, _, _| {
            if done % 20 == 0 || done == total {
                eprint!(
                    "\r{done}/{total}（{} 秒）",
                    fixed(t2.elapsed().as_secs_f64(), 0)
                )
            }
        },
    );
    let (mut tv_read, mut tv_noise, mut n_read, mut n_noise) = (0.0, 0.0, 0, 0);
    for (r, _) in &dists {
        tv_read += r["tvRead"].as_f64().unwrap_or(0.0);
        tv_noise += r["tvNoise"].as_f64().unwrap_or(0.0);
        n_read += r["readChanged"].as_u64().unwrap_or(0);
        n_noise += r["noiseChanged"].as_u64().unwrap_or(0);
        write(r)?;
    }
    let nd = dists.len().max(1) as f64;
    // 同じ種で読みあり・なしの手が違った組（dist_tasks の添え字、読みありの手、読みなしの手、回数）
    let prefs: Vec<(usize, Action, Action, u32, usize)> = dists
        .iter()
        .enumerate()
        .flat_map(|(i, (_, ps))| {
            ps.iter()
                .enumerate()
                .map(move |(k, (x, y, m))| (i, x.clone(), y.clone(), *m, k))
        })
        .collect();
    eprintln!(
        "\n手の分布の違い（読みあり − 読みなし、同じ種）{}・（読みなし − 読みなし、別の種）{}。同じ種で手が変わった回数: 読み {n_read}・乱数 {n_noise}（{} 回中）、打ち比べる組 {}",
        fixed(tv_read / nd, 3),
        fixed(tv_noise / nd, 3),
        dists.len() as u32 * samples,
        prefs.len()
    );

    // 3. 打ち比べ（同じ種で読みありと読みなしの手が違った組）
    let pt: Vec<(usize, u32)> = (0..prefs.len())
        .flat_map(|i| (0..playouts).map(move |j| (i, j)))
        .collect();
    eprintln!("打ち比べ {} 局面 × {playouts} 回 × 2 手", prefs.len());
    let t1 = Instant::now();
    let results = parallel_map(
        &pt,
        |&(i, j), _| {
            let (di, ref ar, ref ad, _, _) = prefs[i];
            let (task, ai) = dist_tasks[di];
            let (g, swap) = tasks[task];
            let (a_seat, seats, seed) = compare_setup(&decks, g, swap, true);
            let a = &a_games[task];
            let step = a.active[ai].step;
            let s = replay(seats, seed, &a.actions[..step]);
            let ps = g
                .wrapping_mul(1_000_003)
                .wrapping_add((swap as u32).wrapping_mul(7919))
                .wrapping_add((step as u32).wrapping_mul(104_729))
                .wrapping_add(j.wrapping_mul(2_654_435_761));
            let wa = playout(&s, ar, &b_opts, seats, ps).map(|w| w == a_seat);
            let wb = playout(&s, ad, &b_opts, seats, ps).map(|w| w == a_seat);
            (wa, wb)
        },
        |done, total, _, _| {
            if done % 50 == 0 || done == total {
                eprint!(
                    "\r{done}/{total}（{} 秒）",
                    fixed(t1.elapsed().as_secs_f64(), 0)
                )
            }
        },
    );
    let mut per: Vec<(u32, u32, u32)> = vec![(0, 0, 0); prefs.len()];
    for (k, &(i, _)) in pt.iter().enumerate() {
        if let (Some(wa), Some(wb)) = results[k] {
            per[i].0 += wa as u32;
            per[i].1 += wb as u32;
            per[i].2 += 1;
        }
    }
    // 組ごとの差（読みありの手 − 読みなしの手）を、同じ種で手が変わった回数で重み付けて平均する
    let (mut sw, mut swx, mut swxx) = (0.0, 0.0, 0.0);
    for (i, &(wa, wb, n)) in per.iter().enumerate() {
        let (di, _, _, mult, pi) = prefs[i];
        let (task, ai) = dist_tasks[di];
        let (g, swap) = tasks[task];
        write(&json!({
            "type": "playout",
            "g": g,
            "swap": swap,
            "step": a_games[task].active[ai].step,
            "times": mult,
            "turn": dists[di].0["turn"],
            "deck": dists[di].0["deck"],
            "oppDeck": dists[di].0["oppDeck"],
            "a": dists[di].0["pairs"][pi][0],
            "b": dists[di].0["pairs"][pi][1],
            "n": n,
            "aWins": wa,
            "bWins": wb,
        }))?;
        if n > 0 {
            let x = (wa as f64 - wb as f64) / n as f64;
            let w = mult as f64;
            sw += w;
            swx += w * x;
            swxx += w * x * x;
        }
    }
    let m = swx / sw.max(1.0);
    let var = (swxx / sw.max(1.0) - m * m).max(0.0);
    let se = (var / prefs.len().max(1) as f64).sqrt();
    write(&json!({
        "type": "summary",
        "games": tasks.len(),
        "aWins": wins,
        "pairs": pair_counts,
        "playedB": selected.len(),
        "diffs": diffs.len(),
        "flipsNet": flips,
        "odd": odd.len(),
        "changes": changes.len(),
        "turnFirstReads": dists.len(),
        "prefs": prefs.len(),
        "readChanged": n_read,
        "noiseChanged": n_noise,
        "tvRead": tv_read / nd,
        "tvNoise": tv_noise / nd,
        "playouts": playouts,
        "meanGain": m,
        "se": se,
        "secs": t0.elapsed().as_secs_f64(),
    }))?;
    eprintln!(
        "\n同じ種で読みあり・なしの手が違った組 {} 個: 打ち比べで読みありの手 − 読みなしの手 = {} ± {} ポイント（局面ごとの平均）。{} 秒 → {out_path}",
        prefs.len(),
        fixed(m * 100.0, 1),
        fixed(se * 100.0, 1),
        fixed(t0.elapsed().as_secs_f64(), 0)
    );
    Ok(())
}
