//! マリガンの方策を推定・評価するためのデータ取り（TypeScript 版 scripts/mulligan-data-main.ts と同じ形の JSON Lines）。
//!
//!   svwb mulligan-data --games 6000 [--start 0] [--seed 1] [--flip 0.5] --out d.jsonl
//!
//! 両プレイヤーとも、初手の各カードを残す・返すをコインで決め（--flip 0.5）、その後は今の探索 AI で打つ。
//! --flip p（0.5 未満）なら、今の探索 AI のマリガンの判断を各カード確率 p で反転させる（今の方針のまわりのデータ）。
//! 試合 g は比較用の 7 デッキの組（ミラーを除く 42 通り）を順に回し、席は g / 42 の偶奇で入れ替える。
//! 1 試合 1 行: {"seed", "decks": [席 0, 席 1], "first", "winner", "turns", "hands": [[カード ID]…], "kept": [[真偽]…]}。
//! 試合が終わった順に追記する（止めても書き終えた試合は使える）。
//! 残すかどうかを見ていない乱数で決めるので、「残すと返すより勝率がどれだけ上がるか」を因果的に推定でき、
//! どんな方策の勝率も逆確率重み付けで推定できる。docs/ai-notes.md「マリガンの方策を試合を打たずに比べる」

use super::compare_decks;
use super::parallel::parallel_map;
use super::seconds_since;
use crate::ai::exact_lethal::reset_exact_lethal_cache;
use crate::ai::lethal::reset_lethal;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::{Agent, Rng};
use crate::data::data;
use crate::game::{acting_player, apply_action, create_game, legal_actions};
use crate::state::*;
use std::io::Write;
use std::time::Instant;

fn arg<'a>(argv: &'a [String], key: &str) -> Option<&'a str> {
    argv.iter()
        .position(|a| a == key)
        .and_then(|i| argv.get(i + 1))
        .map(|s| s.as_str())
}

fn play(i: usize, j: usize, seat: usize, seed: u32, flip: f64) -> String {
    reset_lethal();
    reset_exact_lethal_cache();
    let decks = compare_decks();
    let ds = if seat == 0 {
        [decks[i], decks[j]]
    } else {
        [decks[j], decks[i]]
    };
    let mut agents = [
        SearchAgent::new(SearchOptions::default()),
        SearchAgent::new(SearchOptions::default()),
    ];
    let mut s = create_game([&ds[0].cards, &ds[1].cards], seed);
    let mut rng = Rng::new(seed ^ 0x9e3779b9);
    // 残す・返すのコイン（打つ手の乱数とは別）
    let mut coin = Rng::new(seed.wrapping_mul(2_654_435_761) ^ 0x6d75_6c6c);
    let mut hands: [Vec<String>; 2] = [Vec::new(), Vec::new()];
    let mut kept: [Vec<bool>; 2] = [Vec::new(), Vec::new()];
    let mut n = 0;
    while s.phase != Phase::Ended {
        n += 1;
        assert!(
            n <= 10000,
            "アクション数が上限を超えました（シード {seed}）"
        );
        let legal = legal_actions(&s);
        let p = acting_player(&s);
        let a = if s.phase == Phase::Mulligan {
            // 基準の判断（flip 0.5 なら使わない）
            let base = if flip < 0.5 {
                match agents[p].choose_action(&s, &legal, &mut Rng::new(rng.state)) {
                    Action::Mulligan { swap, .. } => swap,
                    _ => unreachable!(),
                }
            } else {
                Vec::new()
            };
            let hand = &s.players[p].hand;
            let mut swap = Vec::new();
            for h in hand.iter() {
                let u = coin.int(1 << 30) as f64 / (1u64 << 30) as f64;
                let flipped = u < flip;
                let keep = !base.contains(&h.iid) != flipped;
                hands[p].push(data().cards[h.card as usize].id.clone());
                kept[p].push(keep);
                if !keep {
                    swap.push(h.iid);
                }
            }
            legal
                .iter()
                .find(|x| match x {
                    Action::Mulligan { swap: y, .. } => {
                        y.len() == swap.len() && y.iter().all(|v| swap.contains(v))
                    }
                    _ => false,
                })
                .expect("マリガンの合法手")
                .clone()
        } else {
            agents[p].choose_action(&s, &legal, &mut rng)
        };
        s = apply_action(&s, &a);
    }
    let winner = s.winner.expect("勝者");
    let js = |v: &[String]| serde_json::to_string(v).expect("JSON");
    let jb = |v: &[bool]| serde_json::to_string(v).expect("JSON");
    format!(
        "{{\"seed\":{seed},\"decks\":[{},{}],\"first\":{},\"winner\":{winner},\"turns\":{},\"hands\":[{},{}],\"kept\":[{},{}]}}",
        serde_json::to_string(&ds[0].name).expect("JSON"),
        serde_json::to_string(&ds[1].name).expect("JSON"),
        s.first,
        s.turn,
        js(&hands[0]),
        js(&hands[1]),
        jb(&kept[0]),
        jb(&kept[1]),
    )
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let num = |k: &str, d: f64| -> Result<f64, String> {
        match arg(argv, k) {
            None => Ok(d),
            Some(v) => v.parse::<f64>().map_err(|_| format!("{k} は数: {v}")),
        }
    };
    let games = num("--games", 100.0)? as u32;
    let start = num("--start", 0.0)? as u32;
    let base = num("--seed", 1.0)? as u32;
    let flip = num("--flip", 0.5)?;
    if !(0.0..=0.5).contains(&flip) {
        return Err(format!("--flip は 0 以上 0.5 以下: {flip}"));
    }
    let out = arg(argv, "--out").ok_or("--out が要ります")?;
    let n = compare_decks().len();
    let pairs: Vec<(usize, usize)> = (0..n)
        .flat_map(|i| (0..n).filter(move |&j| j != i).map(move |j| (i, j)))
        .collect();
    let tasks: Vec<u32> = (start..start + games).collect();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(out)
        .map_err(|e| format!("{out}: {e}"))?;
    let t0 = Instant::now();
    parallel_map(
        &tasks,
        |&g, _| {
            let (i, j) = pairs[g as usize % pairs.len()];
            let seat = (g as usize / pairs.len()) % 2;
            let seed = base.wrapping_mul(0x9e37_79b1) ^ g.wrapping_mul(2_654_435_761);
            play(i, j, seat, seed, flip)
        },
        |done, total, line, _| {
            writeln!(file, "{line}").expect("書き込み");
            if done % 500 == 0 || done == total {
                eprintln!("{done}/{total}（{:.0}秒）", seconds_since(t0));
            }
        },
    );
    Ok(())
}
