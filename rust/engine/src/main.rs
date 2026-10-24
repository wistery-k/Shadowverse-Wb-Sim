//! svwb: エンジンと AI の確認・計測、自己対戦（npm run svwb -- … で呼べる）
//!
//!   svwb golden [write] [組…]  決まった試合の結果を tests/golden/ に保存したものと比べる（write なら保存し直す。src/golden.rs）
//!   svwb dump <game> <step> [--random-decks] [--json]  その試合のその手番の正規化した文字列（--json なら局面の JSON）を表示する
//!   svwb coverage [games] [--random-decks]    実行された効果の種類を数える（--features coverage でビルド）
//!   svwb bench [games]         速さの計測（ランダムな試合の 1 手と、局面ごとに全ての合法手を試す 1 手）
//!   svwb ai-play [games] [start] [search|rhino|rhino-lethal] AI どうしの試合を打って時間を測る
//!   svwb compare <games> '<A>' '<B>' [start] [vsDeck] [--no-mirror]  探索 AI の設定どうしの勝率（npm run compare と同じ）
//!   svwb rhino-compare [--subject …] [--games …] [--opts …] [--out …]  デッキ専用の AI の勝率（npm run rhino-compare と同じ）
//!   svwb deck-compare --deck <デッキ> [--variant '<変更>']… [--add <カード>] [--file <デッキ>]… [--vs <デッキ>] [--games 50]  デッキのカードを入れ替えた案を元のデッキと比べる
//!   svwb meta init|round|export|show …  環境（デッキと使用率）のアジャスト合戦を 1 回りずつ回す（runner/meta.rs）
//!   svwb mulligan-compare [--games 50] [--a …] [--b …]  マリガンの設定どうしを同じシードの試合で打ち比べる
//!   svwb human-plan-value --out 結果.jsonl [--m 32] <人間の記録.jsonl>…  人間の手順と AI の手順を同じ局面から打ち比べる（report で集計）
//!   svwb td selfplay --model m.json --games N [--start S] [--eps 0.1] --out d.jsonl  TD 学習の自己対戦
//!   svwb yardstick [--opts …] [--games 1000] [--label …] [--record]  固定した相手との勝率（強さの物差し。docs/yardstick.md）

use std::time::Instant;
use svwb_engine::golden::{ai_game, step_canon, SETS};
use svwb_engine::runner;
use svwb_engine::sim::play_random;
use svwb_engine::state_json::state_to_json;
use svwb_engine::{legal_actions, try_apply_action};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
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
        Some(
            cmd @ ("compare" | "rhino-compare" | "deck-compare" | "mulligan-compare" | "td"
            | "yardstick" | "human-plan-value" | "meta"),
        ) => {
            let rest = &args[1..];
            let r = match cmd {
                "compare" => runner::compare::main(rest),
                "mulligan-compare" => runner::mulligan_compare::main(rest),
                "rhino-compare" => runner::rhino_compare::main(rest),
                "deck-compare" => runner::deck_compare::main(rest),
                "yardstick" => runner::yardstick::main(rest),
                "human-plan-value" => runner::human_plan::main(rest),
                "meta" => runner::meta::main(rest),
                _ => runner::td::main(rest),
            };
            if let Err(e) = r {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("使い方: svwb golden [write] | dump <game> <step> | bench [games] | ai-play [games] | compare … | rhino-compare … | deck-compare … | meta … | mulligan-compare … | td selfplay … | yardstick … | human-plan-value …（rust/README.md）");
            std::process::exit(2);
        }
    }
}
