//! 探索 AI の設定 A と B を対戦させる（TypeScript 版 scripts/compare-main.ts。npm run compare と同じ試合・同じ出力）。
//!
//!   svwb compare <試合数> '<Aの設定JSON>' '<Bの設定JSON>' [最初の試合番号] [Bのデッキ名]
//!
//! 同じデッキの組で席とデッキを入れ替えて 2 試合ずつ行い、A の勝率とデッキごとの A の勝率を出す。

use super::options::compare_options;
use super::parallel::parallel_map;
use super::{compare_decks, fixed, seconds_since, Tally};
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::Agent;
use crate::data::Deck;
use crate::sim::play_match;
use std::time::Instant;

/// 試合番号 g（swap で席とデッキを入れ替えた方）の A と B のデッキ
pub fn compare_pair(decks: &[&'static Deck], g: u32, swap: bool) -> (&'static Deck, &'static Deck) {
    let i = (g % 7) as usize;
    let j = ((g * 3 + 1 + g / 7) % 7) as usize;
    if swap {
        (decks[j], decks[i])
    } else {
        (decks[i], decks[j])
    }
}

/// 試合番号 g を A と B で打つ（席・シードは g と swap で決まる）。A のデッキ名と、A が勝ったか
pub fn play_compare_game(
    a: &SearchOptions,
    b: &SearchOptions,
    decks: &[&'static Deck],
    g: u32,
    swap: bool,
) -> (String, bool) {
    let (da, db) = compare_pair(decks, g, swap);
    let a_seat = ((g + swap as u32) % 2) as usize;
    let mut a = SearchAgent::new(a.clone());
    let mut b = SearchAgent::new(b.clone());
    let seed = g * 7 + if swap { 1 } else { 2 };
    let end = if a_seat == 0 {
        play_match(
            &mut [&mut a as &mut dyn Agent, &mut b],
            [&da.cards, &db.cards],
            seed,
            |_, _| {},
        )
    } else {
        play_match(
            &mut [&mut b as &mut dyn Agent, &mut a],
            [&db.cards, &da.cards],
            seed,
            |_, _| {},
        )
    };
    let winner = end
        .winner
        .unwrap_or_else(|| panic!("勝者がいません（試合 {g}）"));
    (da.name.clone(), winner == a_seat)
}

fn number_arg(v: Option<&String>, def: f64) -> Result<u32, String> {
    let x = match v {
        None => def,
        Some(s) => s
            .parse::<f64>()
            .map_err(|_| format!("数ではありません: {s}"))?,
    };
    if x < 0.0 || x.fract() != 0.0 {
        return Err(format!("0 以上の整数を渡します: {x}"));
    }
    Ok(x as u32)
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let games = number_arg(argv.first(), 28.0)?;
    let decks = compare_decks();
    if decks.len() != 7 {
        return Err("比較用のデッキは 7 つの想定です".into());
    }
    let a_text = argv.get(1).map(|s| s.as_str()).unwrap_or("{}");
    let b_text = argv.get(2).map(|s| s.as_str()).unwrap_or("{}");
    let a = compare_options(a_text).map_err(|e| format!("A の設定: {e}"))?;
    let b = compare_options(b_text).map_err(|e| format!("B の設定: {e}"))?;
    let t0 = Instant::now();
    let start = number_arg(argv.get(3), 0.0)?;
    let vs = argv.get(4).filter(|s| !s.is_empty());
    if let Some(v) = vs {
        if !decks.iter().any(|d| &d.name == v) {
            return Err(format!("不明なデッキ: {v}"));
        }
    }
    let tasks: Vec<(u32, bool)> = (0..games)
        .flat_map(|k| [(start + k, false), (start + k, true)])
        .filter(|&(g, swap)| vs.is_none_or(|v| &compare_pair(&decks, g, swap).1.name == v))
        .collect();
    let results = parallel_map(
        &tasks,
        |&(g, swap), _| play_compare_game(&a, &b, &decks, g, swap),
        |_, _, _, _| {},
    );
    let n = results.len();
    let mut wins = 0;
    let mut per_deck = Tally::default();
    for (deck, won) in &results {
        wins += *won as u32;
        per_deck.add(deck, *won);
    }
    println!(
        "A{a_text} vs B{b_text}: {wins}/{n} = {}%  {}s/試合",
        fixed((wins as f64 / n as f64) * 100.0, 1),
        fixed(seconds_since(t0) / n as f64, 2)
    );
    println!("{}", per_deck.line());
    Ok(())
}
