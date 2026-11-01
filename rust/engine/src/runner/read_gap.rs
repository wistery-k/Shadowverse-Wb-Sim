//! read-gap: 探索 AI どうしの試合で、自分のターンを終えるたびに、ターン末の点数と、相手のターンを読み直しと同じに読んだ点数の差（ギャップ）が
//! 相手のターンのどこで生まれるかを測る（docs/ai-notes.md「相手のターンの読みのギャップがどこで生まれるか」）。
//!
//!   svwb read-gap --out 記録.jsonl [--games 49] [--start 0] [--opts '<設定JSON>'] [--samples 12]
//!
//! - 試合は read-log と同じ（compare と同じデッキの組で、試合番号ごとに席とデッキを入れ替えて 2 試合。両方の席が同じ設定）
//! - 打つ手は測らないときと同じ（測るための読みは、試合の乱数を使わない。引き直しの乱数は試合のシード・ターン・席から作る）
//! - 自分のターン終了を打つ直前の局面（本物のターン末）で、ターン末の点数（"te"）と、相手の手札を --samples 通り引き直して（読み直しと別の乱数）
//!   相手のターンを読んだ記録（"reads"）を書く。1 つの読みは、相手のビームが選んだ並びを 0 手（何もせずにターンを終える）・1 手・…・全部
//!   （と、合流する相打ちの後）で打ち切り、そこで相手がターンを終えて自分の次のターンの最初まで進めた局面を、想像の局面（"imag"。読み直しの点数と同じ）と
//!   自分のターンの最初（"after"。楽観を直す入力 imagined が 0）で採点する。"full" は読み直しと同じ読みの点数（"imag" の最後と同じはず）。
//!   ターン末の局面そのものを自分のターンの最初・想像の局面として採点した点数も書く（"teAfter"・"teImag"。入力の after・imagined だけを変えた分）
//! - 各打ち切りの局面の特徴 "f"（自分から見て）: [自分の体力, 相手の体力, 自分の場のフォロワー数, 相手の場のフォロワー数, 自分の手札, 相手の手札,
//!   自分の場の攻撃力の和, 相手の場の攻撃力の和, 決着（自分の勝ち 1・負け -1・まだ 0）]。"fe" はターン末の局面の同じ特徴
//! - 本物の次の自分のターンの最初（"type":"start"）で、その局面を自分のターンの最初・想像の局面として採点した点数も書く（本物の相手との比べ用）

use super::compare::compare_setup;
use super::compare_decks;
use super::fixed;
use super::human_plan::{is_start_of_turn, step_text};
use super::options::compare_options;
use super::parallel::{parallel_map, thread_count};
use crate::ai::search::{ReadTrace, SearchAgent, SearchOptions};
use crate::ai::valuenet::ValuePhase;
use crate::ai::{Agent, Rng};
use crate::data::{CardType, Deck};
use crate::game::{acting_player, apply_action, create_game, legal_actions};
use crate::state::{card, opponent, Action, GameState, Phase, PlayerIndex};
use serde_json::{json, Value};
use std::io::Write;
use std::time::Instant;

/// 局面 s の、p から見た特徴（先頭の説明の "f"）
fn features(s: &GameState, p: PlayerIndex) -> Value {
    let q = opponent(p);
    let me = &s.players[p];
    let op = &s.players[q];
    let followers =
        |b: &crate::state::PlayerState| b.board.iter().filter(|x| x.is_follower).count();
    let atk = |b: &crate::state::PlayerState| -> i32 {
        b.board
            .iter()
            .filter(|x| x.is_follower)
            .map(|x| x.attack.max(0))
            .sum()
    };
    let end = if s.phase == Phase::Ended {
        if s.winner == Some(p) {
            1
        } else {
            -1
        }
    } else {
        0
    };
    json!([
        me.leader_hp,
        op.leader_hp,
        followers(me),
        followers(op),
        me.hand.len(),
        op.hand.len(),
        atk(me),
        atk(op),
        end
    ])
}

/// 相手の手の種類（局面 before で打つ前の手 a）
fn kind(before: &GameState, a: &Action) -> &'static str {
    match a {
        Action::Play(i) => {
            let q = acting_player(before);
            match before.players[q].hand.iter().find(|h| h.iid == *i) {
                Some(h) => match card(h.card).ctype {
                    CardType::Follower => "playFollower",
                    CardType::Spell => "playSpell",
                    CardType::Amulet => "playAmulet",
                },
                None => "play",
            }
        }
        Action::Attack { target: None, .. } => "attackLeader",
        Action::Attack {
            target: Some(_), ..
        } => "attackFollower",
        Action::Evolve(_) => "evolve",
        Action::SuperEvolve(_) => "superEvolve",
        Action::Act(_) => "act",
        Action::Fuse { .. } => "fuse",
        Action::ExtraPp => "extraPp",
        Action::Choose(_) | Action::Mode(_) => "choose",
        Action::EndTurn => "endTurn",
        Action::Mulligan { .. } => "mulligan",
    }
}

fn trace_json(tr: &ReadTrace, p: PlayerIndex) -> Value {
    let mut kinds: Vec<&str> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    if let Some(root) = &tr.opp_root {
        let mut before: &GameState = root;
        for (a, after) in &tr.steps {
            kinds.push(kind(before, a));
            texts.push(step_text(before, a, p));
            before = after;
        }
        if tr.settled {
            kinds.push("settle");
            texts.push("相手: 合流する相打ち".into());
        }
    }
    json!({
        "full": tr.full,
        "beam": tr.opp_root.is_some(),
        "imag": tr.imagined,
        "after": tr.after,
        "kinds": kinds,
        "steps": texts,
        "f": tr.cuts.iter().map(|c| features(c, p)).collect::<Vec<_>>(),
    })
}

/// 試合番号 g（swap で席とデッキを入れ替えた方）を打ち、書き出す行を返す
fn play_traced(
    opts: &SearchOptions,
    samples: usize,
    decks: &[&'static Deck],
    g: u32,
    swap: bool,
) -> Vec<Value> {
    let (_, seats, seed) = compare_setup(decks, g, swap, false);
    let mut agents = [
        SearchAgent::new(opts.clone()),
        SearchAgent::new(opts.clone()),
    ];
    let mut s = create_game([&seats[0].cards, &seats[1].cards], seed);
    let mut rng = Rng::new(seed ^ 0x9e3779b9);
    let mut out: Vec<Value> = Vec::new();
    let mut actions = 0u32;
    let mut started: [i32; 2] = [-1, -1];
    while s.phase != Phase::Ended {
        actions += 1;
        assert!(
            actions <= 10000,
            "アクション数が上限 10000 を超えました（シード {seed}）"
        );
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        if s.active == actor && is_start_of_turn(&s) && started[actor] != s.turn {
            started[actor] = s.turn;
            let ag = &agents[actor];
            out.push(json!({
                "type": "start",
                "g": g,
                "swap": swap,
                "p": actor,
                "turn": s.turn,
                "after": ag.phase_value(&s, actor, ValuePhase::After),
                "imag": ag.phase_value(&s, actor, ValuePhase::Imagined),
                "f": features(&s, actor),
            }));
        }
        let a = agents[actor].choose_action(&s, &legal, &mut rng);
        if matches!(a, Action::EndTurn) && s.pending.is_none() && s.active == actor {
            let ag = &agents[actor];
            let mut r = Rng::new(
                seed ^ (s.turn as u32).wrapping_mul(0x9E37_79B1)
                    ^ (actor as u32 + 1).wrapping_mul(0x85EB_CA6B),
            );
            let seeds: Vec<u32> = (0..samples)
                .map(|_| r.int(u32::MAX as usize) as u32)
                .collect();
            let reads: Vec<Value> = seeds
                .iter()
                .filter_map(|&sd| ag.read_trace(&s, actor, sd))
                .map(|tr| trace_json(&tr, actor))
                .collect();
            out.push(json!({
                "type": "end",
                "g": g,
                "swap": swap,
                "p": actor,
                "deck": seats[actor].name,
                "oppDeck": seats[1 - actor].name,
                "turn": s.turn,
                "te": ag.turn_end_value(&s, actor),
                "teAfter": ag.turn_end_phase_value(&s, actor, ValuePhase::After),
                "teImag": ag.turn_end_phase_value(&s, actor, ValuePhase::Imagined),
                "fe": features(&s, actor),
                "reads": reads,
            }));
        }
        s = apply_action(&s, &a);
    }
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
    let mut samples: usize = 12;
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
            "--samples" => samples = int()? as usize,
            "--opts" => opts_text = v.clone(),
            "--out" => out_path = Some(v.clone()),
            _ => return Err(format!("知らないオプション: {key}")),
        }
    }
    let out_path = out_path.ok_or("--out で書き出すファイルを指定します")?;
    let opts = compare_options(&opts_text).map_err(|e| format!("--opts: {e}"))?;
    if opts.opponent_search.is_none() || opts.own_next.is_some() || opts.next_lethal != 0.0 {
        return Err(
            "read-gap は相手のターンをビームで読む設定（opponentSearch あり・ownNext なし・nextLethal 0）だけを測ります"
                .into(),
        );
    }
    let decks = compare_decks();
    let tasks: Vec<(u32, bool)> = (0..games)
        .flat_map(|k| [(start + k, false), (start + k, true)])
        .collect();
    let mut file = std::io::BufWriter::new(
        std::fs::File::create(&out_path).map_err(|e| format!("{out_path}: {e}"))?,
    );
    eprintln!("{} 試合（並列 {}）", tasks.len(), thread_count());
    let t0 = Instant::now();
    let mut ends = 0usize;
    let mut mismatch = 0usize;
    let mut write_err: Option<String> = None;
    parallel_map(
        &tasks,
        |&(g, swap), _| play_traced(&opts, samples, &decks, g, swap),
        |done, total, lines, _| {
            for l in lines {
                if l["type"] == "end" {
                    ends += 1;
                    for r in l["reads"].as_array().into_iter().flatten() {
                        let full = r["full"].as_f64().unwrap_or(f64::NAN);
                        let last = r["imag"]
                            .as_array()
                            .and_then(|x| x.last())
                            .and_then(|x| x.as_f64())
                            .unwrap_or(f64::NAN);
                        if (full - last).abs() > 1e-9 {
                            mismatch += 1;
                        }
                    }
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
        "（{} 秒）ターン末 {ends} 回、最後の打ち切りが読みの点数と合わない読み {mismatch} → {out_path}",
        fixed(t0.elapsed().as_secs_f64(), 1)
    );
    Ok(())
}
