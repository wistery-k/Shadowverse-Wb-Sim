//! svwb: Rust 版エンジンの差分テストと計測
//!
//!   svwb diff <expected.txt>   TypeScript 版（npm run rust-diff -- expect）の手番ごとのハッシュと突き合わせる
//!   svwb dump <game> <step> [--random-decks]  その試合のその手番の正規化した文字列を表示する
//!   svwb coverage [games] [--random-decks]    実行された効果の種類を数える（--features coverage でビルド）
//!   svwb bench [games]         速さの計測（npm run rust-diff -- bench と同じ 2 つ）
//!   svwb ai-diff <expected.txt> TypeScript 版（npm run rust-ai-diff -- expect）の AI どうしの試合の行動の列と突き合わせる
//!   svwb ai-play [games] [start] [search|rhino|rhino-lethal] AI どうしの試合を打って時間を測る

use std::time::Instant;
use svwb_engine::ai::rhino::{rhino_lethal_bound, search_lethal_for_rhino_turn, RhinoAgent};
use svwb_engine::ai::rhino_lethal::{tag, Tag};
use svwb_engine::ai::search::{SearchAgent, SearchOptions};
use svwb_engine::ai::Agent;
use svwb_engine::canonical::{action_canon, fnv, state_canon};
use svwb_engine::sim::{play_ai, play_random};
use svwb_engine::{legal_actions, resolve_turn_end, try_apply_action, GameState};

/// 手番の局面・合法手の一覧・ターン終了時の処理だけを行った局面
fn step_canon(s: &GameState, legal: &[svwb_engine::Action]) -> String {
    let end = resolve_turn_end(s)
        .map(|e| state_canon(&e))
        .unwrap_or_else(|| "-".into());
    format!(
        "{}#{}#{}",
        state_canon(s),
        legal.iter().map(action_canon).collect::<Vec<_>>().join(","),
        end
    )
}

/// 試合 g の AI（TypeScript 版 scripts/rust-ai-diff-main.ts の createAgent）
fn ai_of(kind: &str) -> Box<dyn Agent> {
    match kind {
        "search" => Box::new(SearchAgent::new(SearchOptions::default())),
        "rhino" => Box::new(RhinoAgent::new(true)),
        "rhino-lethal" => Box::new(RhinoAgent::new(false)),
        _ => panic!("未知の AI: {kind}"),
    }
}

/// 相手の体力をリノセウスの上限の式の値にした局面でのリーサル探索（TypeScript 版 rust-ai-diff-main.ts の probe）
fn probe(s: &GameState, elf: usize) -> Option<String> {
    if s.phase != svwb_engine::Phase::Main || s.active != elf || s.pending.is_some() {
        return None;
    }
    if !s.players[elf]
        .hand
        .iter()
        .any(|h| tag(h.card) == Tag::Rhino)
    {
        return None;
    }
    let hp = rhino_lethal_bound(s, elf);
    if hp < 1 {
        return None;
    }
    let mut x = s.clone();
    x.players[1 - elf].leader_hp = hp;
    Some(match search_lethal_for_rhino_turn(&x, elf) {
        Some(seq) => format!(
            "?{}",
            seq.iter().map(action_canon).collect::<Vec<_>>().join(",")
        ),
        None => "?-".to_string(),
    })
}

/// AI どうしで試合 g を打ち、行動の列（正規化した文字列）と勝者を返す。
/// rhino・rhino-lethal は片方の席をリノセウスエルフにする。with_probe ならエルフの手番ごとに probe の結果も並べる
fn ai_game(g: u32, kind: &str, with_probe: bool) -> (Vec<String>, Option<usize>) {
    // TypeScript 版は 1 つの AI が両方の手番を打つ。計画はプレイヤーごとに持つので、席ごとに分けても同じ
    let mut a = ai_of(kind);
    let mut b = ai_of(kind);
    let mut agents: [&mut dyn Agent; 2] = [a.as_mut(), b.as_mut()];
    let mut log = Vec::new();
    let elf = (g % 2) as usize;
    let end = play_ai(g, kind != "search", &mut agents, |s, act| {
        log.push(action_canon(act));
        if with_probe {
            if let Some(p) = probe(s, elf) {
                log.push(p);
            }
        }
    });
    (log, end.winner)
}

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
            let random_decks = text.starts_with("random-decks");
            for line in text
                .lines()
                .filter(|l| !l.is_empty() && *l != "random-decks")
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
                    let c = step_canon(s, legal);
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
            play_random(g, random_decks, |step, s, legal| {
                if step == k {
                    println!("{}", step_canon(s, legal));
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
        _ => {
            eprintln!("使い方: svwb diff <expected.txt> | dump <game> <step> | bench [games]");
            std::process::exit(2);
        }
    }
}
