//! マリガンの設定 A と B を、同じシードの試合で打ち比べる（判断が違った試合だけが差を生む対照比較）。
//!
//!   svwb mulligan-compare [--games 50] [--start 0] [--seed 1] [--a '<設定JSON>'] [--b '<設定JSON>'] [--decks <デッキ>,…] [--rhino]
//!
//! 7 デッキ × 相手 6 デッキ × 席 2 × games のシードの組ごとに、自分だけ A と B の設定で打つ（相手は今の探索 AI）。
//! --decks なら、自分のデッキをその名前のものだけにする（相手は 6 デッキのまま。試合のシードは全部のときと同じ）。
//! --rhino なら、自分がリノセウスエルフのときはリノセウス用 AI で打ち、A・B の設定はそのマリガンの項目（mulligan…）だけを使う
//! （リノセウス用 AI のマリガンは、打点の項を足した補正で採点する）。
//! A と B のマリガンの判断が同じなら試合はまったく同じになる（マリガンが試合の乱数を進めないとき）ので、
//! B の試合はマリガンの判断が違ったときだけ最後まで打つ。勝ち負けが入れ替わった組を数える（McNemar 検定）。

use super::compare_decks;
use super::deck_compare::RHINO_DECK;
use super::options::compare_options;
use super::parallel::parallel_map;
use super::{fixed, seconds_since};
use crate::ai::exact_lethal::reset_exact_lethal_cache;
use crate::ai::lethal::reset_lethal;
use crate::ai::rhino::{rhino_search_options, RhinoAgent, RHINO_POTENTIAL};
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::{Agent, Rng};
use crate::data::Deck;
use crate::game::{acting_player, apply_action, create_game, legal_actions};
use crate::state::*;
use std::time::Instant;

/// 自分の AI。rhino ならリノセウス用 AI の既定に、subject のマリガンの項目だけを載せる
fn subject_agent(subject: &SearchOptions, rhino: bool) -> Box<dyn Agent> {
    if !rhino {
        return Box::new(SearchAgent::new(subject.clone()));
    }
    let learned = subject.extra_eval.clone();
    let search = SearchOptions {
        mulligan: subject.mulligan,
        mulligan_samples: subject.mulligan_samples,
        mulligan_static: subject.mulligan_static,
        mulligan_net: subject.mulligan_net,
        mulligan_turns: subject.mulligan_turns,
        mulligan_rollout_beam: subject.mulligan_rollout_beam,
        mulligan_keep: subject.mulligan_keep.clone(),
        mulligan_opp: subject.mulligan_opp,
        mulligan_return: subject.mulligan_return.clone(),
        ..rhino_search_options(RHINO_POTENTIAL, learned.clone())
    };
    let plain = SearchOptions {
        extra_eval: learned,
        ..SearchOptions::default()
    };
    Box::new(RhinoAgent::with_options(true, search, plain))
}

/// 試合を打ち、自分（subject の席）が勝ったかと、自分のマリガンを返す。
/// stop が自分のマリガンと同じなら、そこで打ち切って勝ち負けは None
fn play(
    subject: &SearchOptions,
    rhino: bool,
    decks: [&Deck; 2],
    subject_seat: usize,
    seed: u32,
    stop: Option<&Action>,
) -> (Option<bool>, Action) {
    reset_lethal();
    reset_exact_lethal_cache();
    let mut me = subject_agent(subject, rhino);
    let mut opp = SearchAgent::new(SearchOptions::default());
    let mut s = create_game([&decks[0].cards, &decks[1].cards], seed);
    let mut rng = Rng::new(seed ^ 0x9e3779b9);
    let mut mulligan: Option<Action> = None;
    let mut actions = 0;
    while s.phase != Phase::Ended {
        actions += 1;
        assert!(
            actions <= 10000,
            "アクション数が上限を超えました（シード {seed}）"
        );
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        let a = if actor == subject_seat {
            me.choose_action(&s, &legal, &mut rng)
        } else {
            opp.choose_action(&s, &legal, &mut rng)
        };
        if actor == subject_seat && matches!(a, Action::Mulligan { .. }) {
            if stop == Some(&a) {
                return (None, a);
            }
            mulligan = Some(a.clone());
        }
        s = apply_action(&s, &a);
    }
    let won = s
        .winner
        .unwrap_or_else(|| panic!("勝者がいません（シード {seed}）"))
        == subject_seat;
    (Some(won), mulligan.expect("マリガン"))
}

struct Pair {
    deck: usize,
    /// A の勝ち負け、B の勝ち負け（判断が同じなら同じ）、判断が違ったか
    a: bool,
    b: bool,
    differ: bool,
}

fn arg<'a>(argv: &'a [String], key: &str) -> Option<&'a str> {
    argv.iter()
        .position(|a| a == key)
        .and_then(|i| argv.get(i + 1))
        .map(|s| s.as_str())
}

fn num(argv: &[String], key: &str, def: u32) -> Result<u32, String> {
    match arg(argv, key) {
        None => Ok(def),
        Some(s) => s.parse().map_err(|_| format!("{key} は 0 以上の整数: {s}")),
    }
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let games = num(argv, "--games", 50)?;
    let start = num(argv, "--start", 0)?;
    let base = num(argv, "--seed", 1)?;
    let a_text = arg(argv, "--a").unwrap_or(r#"{"mulligan":"sample"}"#);
    let b_text = arg(argv, "--b").unwrap_or("{}");
    let a = compare_options(a_text).map_err(|e| format!("A の設定: {e}"))?;
    let b = compare_options(b_text).map_err(|e| format!("B の設定: {e}"))?;
    let decks = compare_decks();
    let n = decks.len();
    let rhino = argv.iter().any(|a| a == "--rhino");
    let only: Option<Vec<&str>> = arg(argv, "--decks").map(|x| x.split(',').collect());
    if let Some(names) = &only {
        for name in names {
            if !decks.iter().any(|d| d.name == *name) {
                return Err(format!("--decks のデッキがありません: {name}"));
            }
        }
    }
    let mut tasks: Vec<(usize, usize, usize, u32)> = Vec::new();
    for k in start..start + games {
        for (i, d) in decks.iter().enumerate() {
            if only
                .as_ref()
                .is_some_and(|names| !names.contains(&d.name.as_str()))
            {
                continue;
            }
            for j in (0..n).filter(|&j| j != i) {
                for seat in 0..2 {
                    tasks.push((i, j, seat, k));
                }
            }
        }
    }
    let t0 = Instant::now();
    let pairs = parallel_map(
        &tasks,
        |&(i, j, seat, k), _| {
            let idx = ((k * n as u32 + i as u32) * n as u32 + j as u32) * 2 + seat as u32;
            let seed = base.wrapping_mul(0x9e37_79b1) ^ idx.wrapping_mul(2_654_435_761);
            let ds = if seat == 0 {
                [decks[i], decks[j]]
            } else {
                [decks[j], decks[i]]
            };
            let rh = rhino && decks[i].name == RHINO_DECK;
            let (won_a, mull_a) = play(&a, rh, ds, seat, seed, None);
            let won_a = won_a.expect("A の勝ち負け");
            let (won_b, _) = play(&b, rh, ds, seat, seed, Some(&mull_a));
            Pair {
                deck: i,
                a: won_a,
                b: won_b.unwrap_or(won_a),
                differ: won_b.is_some(),
            }
        },
        |done, total, _, _| {
            if done % 200 == 0 || done == total {
                eprintln!("{done}/{total}（{:.0}秒）", seconds_since(t0));
            }
        },
    );
    println!(
        "A {a_text} vs B {b_text}（相手は今の探索 AI、seed {base}、games {start}〜{}{}）",
        start + games - 1,
        if rhino {
            "、リノセウスエルフはリノセウス用 AI"
        } else {
            ""
        }
    );
    println!("| デッキ | 組 | 判断が違った組 | A で勝ち・B で負け | A で負け・B で勝ち | A の勝率 | B の勝率 | 差 | z |");
    println!("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    let row = |name: &str, ps: &[&Pair]| {
        let total = ps.len() as f64;
        let differ = ps.iter().filter(|p| p.differ).count();
        let n10 = ps.iter().filter(|p| p.a && !p.b).count() as f64;
        let n01 = ps.iter().filter(|p| !p.a && p.b).count() as f64;
        let wa = ps.iter().filter(|p| p.a).count() as f64;
        let wb = ps.iter().filter(|p| p.b).count() as f64;
        let z = if n10 + n01 > 0.0 {
            (n10 - n01) / (n10 + n01).sqrt()
        } else {
            0.0
        };
        println!(
            "| {name} | {} | {differ} | {n10} | {n01} | {}% | {}% | {}% | {} |",
            ps.len(),
            fixed(wa / total * 100.0, 1),
            fixed(wb / total * 100.0, 1),
            fixed((n10 - n01) / total * 100.0, 1),
            fixed(z, 2)
        );
    };
    for (i, d) in decks.iter().enumerate() {
        let ps: Vec<&Pair> = pairs.iter().filter(|p| p.deck == i).collect();
        if !ps.is_empty() {
            row(&d.name, &ps);
        }
    }
    let all: Vec<&Pair> = pairs.iter().collect();
    row("全体", &all);
    println!("{}秒", fixed(seconds_since(t0), 0));
    Ok(())
}
