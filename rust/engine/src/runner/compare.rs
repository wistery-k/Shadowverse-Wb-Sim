//! 探索 AI の設定 A と B を対戦させる（TypeScript 版 scripts/compare-main.ts。npm run compare と同じ試合・同じ出力）。
//!
//!   svwb compare <試合数> '<Aの設定JSON>' '<Bの設定JSON>' [最初の試合番号] [Bのデッキ名] [--no-mirror] [--decks <7 つのデッキ>]
//!
//! 同じデッキの組で席とデッキを入れ替えて 2 試合ずつ行い、A の勝率とデッキごとの A の勝率を出す。
//! 2 試合の組ごとの A の勝ち数（2・1・0）の数と、組のばらつきから求めた標準誤差も出す。
//! 組の 2 試合は同じシードで打つ（鏡。デッキと席と山札の順は同じで、A と B だけが入れ替わる。2026-10-22 から）。
//! 同じ AI どうしはちょうど 50% になり、似た AI どうしは運の分が打ち消し合ってぶれが小さい。
//! `--no-mirror` は 2026-10-21 までの試合（組の 2 試合で別のシード。物差しと同じ）。
//! `--decks` なら、比較用の 7 デッキの代わりに、並べた 7 つのデッキ（デフォルトデッキの名前・キーか、デッキのテキストファイル。
//! td selfplay --decks と同じ）で打つ。学習した補正の知らないカードの入ったデッキで、補正どうしを比べる用
//! （docs/ai-notes.md「カードの重みを属性とカードごとの残りに分ける」）。デフォルトデッキと違うデッキのマリガンは、
//! 返し方ごとに引き直しを試して選ぶ（td selfplay と同じ。マリガンのモデルはデフォルトデッキしか知らない）。

use super::deck_compare::read_deck;
use super::options::compare_options;
use super::parallel::parallel_map;
use super::{compare_decks, fixed, seconds_since, Tally};
use crate::ai::search::{MulliganMode, SearchAgent, SearchOptions};
use crate::ai::Agent;
use crate::data::{data, Deck};
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

/// 試合番号 g のシード。mirror なら組の 2 試合で同じ
pub fn compare_seed(g: u32, swap: bool, mirror: bool) -> u32 {
    g * 7 + if swap || mirror { 1 } else { 2 }
}

/// 試合番号 g の A の席・席ごとのデッキ・シード
pub fn compare_setup(
    decks: &[&'static Deck],
    g: u32,
    swap: bool,
    mirror: bool,
) -> (usize, [&'static Deck; 2], u32) {
    let (da, db) = compare_pair(decks, g, swap);
    let a_seat = ((g + swap as u32) % 2) as usize;
    let seats = if a_seat == 0 { [da, db] } else { [db, da] };
    (a_seat, seats, compare_seed(g, swap, mirror))
}

/// 試合番号 g を A と B で打つ（席・シードは g と swap と mirror で決まる）。A のデッキ名と、A が勝ったか
pub fn play_compare_game(
    a: &SearchOptions,
    b: &SearchOptions,
    decks: &[&'static Deck],
    g: u32,
    swap: bool,
    mirror: bool,
) -> (String, bool) {
    let (a_seat, seats, seed) = compare_setup(decks, g, swap, mirror);
    // デフォルトデッキと違うデッキ（--decks）のマリガンは、返し方ごとに引き直しを試して選ぶ
    let opts = |o: &SearchOptions, d: &Deck| {
        let mut o = o.clone();
        if !data().decks.iter().any(|x| x.cards == d.cards) {
            o.mulligan = MulliganMode::Sample;
        }
        o
    };
    let mut a = SearchAgent::new(opts(a, seats[a_seat]));
    let mut b = SearchAgent::new(opts(b, seats[1 - a_seat]));
    let mut agents: [&mut dyn Agent; 2] = if a_seat == 0 {
        [&mut a, &mut b]
    } else {
        [&mut b, &mut a]
    };
    let end = play_match(
        &mut agents,
        [&seats[0].cards, &seats[1].cards],
        seed,
        |_, _| {},
    );
    let winner = end
        .winner
        .unwrap_or_else(|| panic!("勝者がいません（試合 {g}）"));
    (seats[a_seat].name.clone(), winner == a_seat)
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

/// 組（同じ試合番号の 2 試合）ごとの A の勝ち数の数（[0 勝, 1 勝, 2 勝]）と、
/// 組の勝率のばらつきから求めた A の勝率の標準誤差。両方の試合がそろった組だけを数える
pub fn pair_stats(tasks: &[(u32, bool)], won: &[bool]) -> ([u32; 3], f64) {
    let mut by_game: std::collections::BTreeMap<u32, (u32, u32)> = Default::default();
    for (&(g, _), &w) in tasks.iter().zip(won) {
        let e = by_game.entry(g).or_default();
        e.0 += 1;
        e.1 += w as u32;
    }
    let mut counts = [0u32; 3];
    let scores: Vec<f64> = by_game
        .values()
        .filter(|&&(n, _)| n == 2)
        .map(|&(_, w)| {
            counts[w as usize] += 1;
            w as f64 / 2.0
        })
        .collect();
    let n = scores.len() as f64;
    if n < 2.0 {
        return (counts, f64::NAN);
    }
    let mean = scores.iter().sum::<f64>() / n;
    let var = scores.iter().map(|s| (s - mean).powi(2)).sum::<f64>() / (n - 1.0);
    (counts, (var / n).sqrt())
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mirror = !argv.iter().any(|s| s == "--no-mirror");
    let mut argv: Vec<String> = argv
        .iter()
        .filter(|s| *s != "--no-mirror")
        .cloned()
        .collect();
    let mut deck_list = None;
    if let Some(i) = argv.iter().position(|s| s == "--decks") {
        deck_list = Some(
            argv.get(i + 1)
                .ok_or("--decks の後に 7 つのデッキをカンマで並べます")?
                .clone(),
        );
        argv.drain(i..i + 2);
    }
    let games = number_arg(argv.first(), 28.0)?;
    let decks: Vec<&'static Deck> = match deck_list {
        None => compare_decks(),
        Some(list) => list
            .split(',')
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(|name| read_deck(name).map(|d| &*Box::leak(Box::new(d))))
            .collect::<Result<_, _>>()?,
    };
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
        |&(g, swap), _| play_compare_game(&a, &b, &decks, g, swap, mirror),
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
    let won: Vec<bool> = results.iter().map(|r| r.1).collect();
    let ([c0, c1, c2], se) = pair_stats(&tasks, &won);
    if c0 + c1 + c2 >= 2 {
        println!(
            "組（{}）: 2 勝 {c2}・1 勝 {c1}・0 勝 {c0}、標準誤差 ±{} ポイント",
            if mirror {
                "同じシード"
            } else {
                "別のシード"
            },
            fixed(se * 100.0, 2)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_stats_counts_full_pairs() {
        let tasks = [
            (0, false),
            (0, true),
            (1, false),
            (1, true),
            (2, false),
            (3, false),
            (3, true),
        ];
        let won = [true, true, true, false, true, false, false];
        let (counts, se) = pair_stats(&tasks, &won);
        // 試合 2 は片方しかないので数えない
        assert_eq!(counts, [1, 1, 1]);
        // 組の勝率 1・0.5・0 の平均 0.5、ばらつき 0.25
        assert!((se - (0.25f64 / 3.0).sqrt()).abs() < 1e-12);
    }

    #[test]
    fn mirror_swaps_only_the_agents() {
        let decks = compare_decks();
        for g in 0..20 {
            let (s0, d0, seed0) = compare_setup(&decks, g, false, true);
            let (s1, d1, seed1) = compare_setup(&decks, g, true, true);
            assert_eq!(s0, 1 - s1);
            assert_eq!([&d0[0].name, &d0[1].name], [&d1[0].name, &d1[1].name]);
            assert_eq!(seed0, seed1);
            // 鏡でなければシードだけが違う（今までの試合）
            let (_, d2, seed2) = compare_setup(&decks, g, true, false);
            assert_eq!([&d0[0].name, &d0[1].name], [&d2[0].name, &d2[1].name]);
            assert_eq!(seed2, g * 7 + 1);
            assert_eq!(compare_setup(&decks, g, false, false).2, g * 7 + 2);
        }
    }

    #[test]
    fn mirror_splits_pairs_of_the_same_ai() {
        let decks = compare_decks();
        let o = super::super::options::compare_options("{}").unwrap();
        let x = play_compare_game(&o, &o, &decks, 0, false, true);
        let y = play_compare_game(&o, &o, &decks, 0, true, true);
        assert_ne!(x.1, y.1);
    }
}
