//! svwb: Rust 版エンジンの差分テストと計測
//!
//!   svwb golden [write] [組…]  決まった試合の結果を tests/golden/ に保存したものと比べる（write なら保存し直す。src/golden.rs）
//!   svwb diff <expected.txt>   TypeScript 版（npm run rust-diff -- expect）の手番ごとのハッシュと突き合わせる
//!   svwb dump <game> <step> [--random-decks] [--json]  その試合のその手番の正規化した文字列（--json なら局面の JSON）を表示する
//!   svwb coverage [games] [--random-decks]    実行された効果の種類を数える（--features coverage でビルド）
//!   svwb bench [games]         速さの計測（npm run rust-diff -- bench と同じ 2 つ）
//!   svwb ai-diff <expected.txt> TypeScript 版（npm run rust-ai-diff -- expect）の AI どうしの試合の行動の列と突き合わせる
//!   svwb ai-play [games] [start] [search|rhino|rhino-lethal] AI どうしの試合を打って時間を測る
//!   svwb compare <games> '<A>' '<B>' [start] [vsDeck]  探索 AI の設定どうしの勝率（npm run compare と同じ）
//!   svwb rhino-compare [--subject …] [--games …] [--opts …] [--out …]  デッキ専用の AI の勝率（npm run rhino-compare と同じ）
//!   svwb td selfplay --model m.json --games N [--start S] [--eps 0.1] --out d.jsonl  TD 学習の自己対戦（npm run td -- selfplay と同じ）

use std::time::Instant;
use svwb_engine::canonical::fnv;
use svwb_engine::golden::{ai_game, json_round_trip, step_canon, SETS};
use svwb_engine::runner;
use svwb_engine::sim::play_random;
use svwb_engine::state_json::state_to_json;
use svwb_engine::{legal_actions, try_apply_action};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("ai-diff") => {
            let text = std::fs::read_to_string(&args[1]).expect("ファイルを読めません");
            let (mut games, mut bad) = (0, 0);
            let t0 = Instant::now();
            // 先頭の行が「agent 種類 [probe]」なら、その AI で打つ（無ければ探索 AI）
            let header: Vec<&str> = text
                .lines()
                .next()
                .and_then(|l| l.strip_prefix("agent "))
                .unwrap_or("search")
                .split(' ')
                .collect();
            let kind = header[0].to_string();
            let with_probe = header.get(1) == Some(&"probe");
            for line in text
                .lines()
                .filter(|l| !l.is_empty() && !l.starts_with("agent "))
            {
                let mut it = line.split(' ');
                let g: u32 = it.next().unwrap().parse().unwrap();
                let winner = it.next().unwrap();
                let expected: Vec<&str> = it.collect();
                let (log, w) = ai_game(g, &kind, with_probe);
                games += 1;
                let first_diff = (0..log.len().max(expected.len()))
                    .find(|&i| log.get(i).map(|s| s.as_str()) != expected.get(i).copied());
                let w = w.map(|x| x.to_string()).unwrap_or_else(|| "null".into());
                if let Some(i) = first_diff {
                    bad += 1;
                    println!(
                        "試合 {g}: {i} 手目で食い違い（Rust {}、TS {}）",
                        log.get(i).map(|s| s.as_str()).unwrap_or("（終わり）"),
                        expected.get(i).copied().unwrap_or("（終わり）")
                    );
                } else if w != winner {
                    bad += 1;
                    println!("試合 {g}: 勝者が違う（Rust {w}、TS {winner}）");
                }
            }
            println!(
                "{games} 試合を照合、食い違い {bad} 試合（1 試合 {:.2}秒）",
                t0.elapsed().as_secs_f64() / games as f64
            );
            if bad > 0 {
                std::process::exit(1);
            }
        }
        Some("ai-play") => {
            let games: u32 = args.get(1).map(|s| s.parse().unwrap()).unwrap_or(14);
            let start: u32 = args.get(2).map(|s| s.parse().unwrap()).unwrap_or(0);
            let kind = args.get(3).map(|s| s.as_str()).unwrap_or("search");
            let t0 = Instant::now();
            for g in start..start + games {
                let t = Instant::now();
                let (log, w) = ai_game(g, kind, false);
                let (searched, found) = svwb_engine::ai::exact_lethal::exact_lethal_counts();
                println!(
                    "試合 {g}: 勝者 {w:?}、{} 手、{:.2}秒（全探索のリーサル探索 {searched} 回、見つけた {found} 回）",
                    log.len(),
                    t.elapsed().as_secs_f64()
                );
            }
            println!("1 試合 {:.2}秒", t0.elapsed().as_secs_f64() / games as f64);
        }
        Some("diff") => {
            let text = std::fs::read_to_string(&args[1]).expect("ファイルを読めません");
            let (mut games, mut steps, mut bad) = (0, 0, 0);
            // 先頭の設定の行（random-decks: ランダムなデッキ、json: 局面の JSON を比べる）
            let random_decks = text.lines().any(|l| l == "random-decks");
            let json = text.lines().any(|l| l == "json");
            for line in text
                .lines()
                .filter(|l| !l.is_empty() && *l != "random-decks" && *l != "json")
            {
                let mut it = line.split(' ');
                let g: u32 = it.next().unwrap().parse().unwrap();
                let expected: Vec<&str> = it.collect();
                let mut mismatch: Option<(usize, String)> = None;
                let mut n = 0;
                play_random(g, random_decks, |step, s, legal| {
                    n += 1;
                    if mismatch.is_some() {
                        return;
                    }
                    let c = if json {
                        match json_round_trip(s) {
                            Ok(c) => c,
                            Err(e) => {
                                mismatch = Some((step, e));
                                return;
                            }
                        }
                    } else {
                        step_canon(s, legal)
                    };
                    if expected.get(step).copied() != Some(fnv(&c).as_str()) {
                        mismatch = Some((step, c));
                    }
                });
                games += 1;
                steps += n;
                if mismatch.is_none() && n != expected.len() {
                    mismatch = Some((
                        n.min(expected.len()),
                        format!("手番の数が違う: Rust {n}、TS {}", expected.len()),
                    ));
                }
                if let Some((step, c)) = mismatch {
                    bad += 1;
                    if bad <= 3 {
                        println!("食い違い: 試合 {g} の手番 {step}\n  Rust: {c}");
                    }
                }
            }
            println!("{games} 試合・{steps} 手番を照合、食い違い {bad} 試合");
            std::process::exit(if bad == 0 { 0 } else { 1 });
        }
        Some("dump") => {
            let g: u32 = args[1].parse().unwrap();
            let k: usize = args[2].parse().unwrap();
            let random_decks = args.iter().any(|a| a == "--random-decks");
            let json = args.iter().any(|a| a == "--json");
            play_random(g, random_decks, |step, s, legal| {
                if step == k {
                    if json {
                        println!("{}", state_to_json(s).canonical());
                    } else {
                        println!("{}", step_canon(s, legal));
                    }
                }
            });
        }
        Some("bench") => {
            let games: u32 = args.get(1).map(|s| s.parse().unwrap()).unwrap_or(2000);
            let mut actions = 0usize;
            let t0 = Instant::now();
            for g in 0..games {
                play_random(g, false, |_, _, legal| {
                    actions += usize::from(!legal.is_empty())
                });
            }
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            println!(
                "random: {games} 試合 {ms:.0}ms、1 試合 {:.3}ms、1 手 {:.2}µs（{actions} 手）",
                ms / games as f64,
                1000.0 * ms / actions as f64
            );
            let mut states = Vec::new();
            for g in 0..games {
                play_random(g, false, |_, s, legal| {
                    if !legal.is_empty() {
                        states.push(s.clone())
                    }
                });
            }
            let (mut tried, mut sink) = (0usize, 0i64);
            let t1 = Instant::now();
            for s in &states {
                for a in legal_actions(s) {
                    if let Some(next) = try_apply_action(s, &a) {
                        sink += next.players[0].leader_hp as i64;
                    }
                    tried += 1;
                }
            }
            let ms = t1.elapsed().as_secs_f64() * 1000.0;
            println!(
                "expand: {} 局面・{tried} 手 {ms:.0}ms、1 手 {:.2}µs（{}）",
                states.len(),
                1000.0 * ms / tried as f64,
                sink % 10
            );
        }
        #[cfg(feature = "coverage")]
        Some("coverage") => {
            let games: u32 = args.get(1).map(|s| s.parse().unwrap()).unwrap_or(2000);
            let random_decks = args.iter().any(|a| a == "--random-decks");
            for g in 0..games {
                play_random(g, random_decks, |_, _, _| {});
            }
            let hits = svwb_engine::effects::coverage::hits();
            let mut v: Vec<_> = hits.into_iter().collect();
            v.sort();
            for (k, n) in v {
                println!("{k}\t{n}");
            }
        }
        Some("golden") => {
            // svwb golden write [組…]: 保存し直す。svwb golden [組…]: 保存したものと比べる
            let write = args.get(1).map(|a| a == "write").unwrap_or(false);
            let names: Vec<&str> = args[if write { 2 } else { 1 }..]
                .iter()
                .map(|s| s.as_str())
                .collect();
            let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden");
            let mut bad = 0;
            for set in SETS
                .iter()
                .filter(|s| names.is_empty() || names.contains(&s.name))
            {
                let path = format!("{dir}/{}.txt", set.name);
                let t0 = Instant::now();
                let r = if write {
                    svwb_engine::golden::lines(set)
                        .map(|l| std::fs::write(&path, l.join("\n") + "\n").expect("書けません"))
                } else {
                    let expected = std::fs::read_to_string(&path).unwrap_or_default();
                    svwb_engine::golden::check(set, &expected)
                };
                match r {
                    Ok(()) => println!(
                        "{}: {} 試合 {}（{:.1}秒）",
                        set.name,
                        set.games,
                        if write {
                            "を保存しました"
                        } else {
                            "一致"
                        },
                        t0.elapsed().as_secs_f64()
                    ),
                    Err(e) => {
                        bad += 1;
                        println!("{e}");
                    }
                }
            }
            if bad > 0 {
                std::process::exit(1);
            }
        }
        Some(cmd @ ("compare" | "rhino-compare" | "td")) => {
            let rest = &args[1..];
            let r = match cmd {
                "compare" => runner::compare::main(rest),
                "rhino-compare" => runner::rhino_compare::main(rest),
                _ => runner::td::main(rest),
            };
            if let Err(e) = r {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("使い方: svwb diff <expected.txt> | dump <game> <step> | bench [games] | ai-diff <expected.txt> | ai-play [games] | compare … | rhino-compare … | td selfplay …（rust/README.md）");
            std::process::exit(2);
        }
    }
}
