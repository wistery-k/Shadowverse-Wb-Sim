//! draw-stability: 同じ局面で乱数を変えて何度も考えさせ、最初の手がどれだけそろうか（ぶれ）を、2 つの設定で比べる
//! （docs/ai-notes.md「引く手の直前で区切って引きを作り直す」）。
//!
//! 使い方: svwb draw-stability [--subject spellwitch] [--games 12] [--start 0] [--seeds 8]
//!                             [--a '<設定JSON>'] [--b '<設定JSON>']
//!
//! 比べるデッキと 6 デッキを今の既定の探索 AI どうしで打ち（rhino-compare と同じ組み方・シード）、比べるデッキの各ターンの最初の局面を集める。
//! 各局面で、設定 A・B の探索 AI に seeds 通りの乱数で手を選ばせ（前に選んだ並びは使わない）、最も多く選ばれた手の割合（そろい方）を平均する。
//! 局面は「カードを引く手（自分の山札が減る手）を今打てる」ものと、そうでないものに分けて出す

use super::compare_decks;
use super::options::{rhino_compare_options, search_options};
use super::parallel::parallel_map;
use super::rhino_compare::SUBJECTS;
use super::{fixed, seconds_since};
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::{Agent, Rng};
use crate::data::{data, Deck};
use crate::game::{acting_player, apply_action, create_game, legal_actions, try_apply_action};
use crate::sim::play_match;
use crate::state::{Action, GameState, Phase};
use std::time::Instant;

/// p がカードを引く手を今打てるか
fn can_draw(s: &GameState, p: usize, legal: &[Action]) -> bool {
    legal.iter().any(|a| {
        !matches!(a, Action::EndTurn)
            && try_apply_action(s, a)
                .is_some_and(|n| n.players[p].deck.len() < s.players[p].deck.len())
    })
}

/// 局面 s で、設定 opts の探索 AI に seeds 通りの乱数で手を選ばせたときの、最も多く選ばれた手の割合
fn agreement(s: &GameState, opts: &SearchOptions, seeds: u32, salt: u32) -> f64 {
    let legal = legal_actions(s);
    let mut chosen: Vec<(Action, u32)> = Vec::new();
    for k in 0..seeds {
        let mut agent = SearchAgent::new(opts.clone());
        let mut rng = Rng::new(salt.wrapping_mul(7919).wrapping_add(k * 104729 + 1));
        let a = agent.choose_action(s, &legal, &mut rng);
        match chosen.iter_mut().find(|(x, _)| *x == a) {
            Some(e) => e.1 += 1,
            None => chosen.push((a, 1)),
        }
    }
    let top = chosen.iter().map(|(_, n)| *n).max().unwrap_or(0);
    top as f64 / seeds.max(1) as f64
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mut games: u32 = 12;
    let mut start: u32 = 0;
    let mut seeds: u32 = 8;
    let mut subject = SUBJECTS[2];
    let mut a_text = "{}".to_string();
    let mut b_text = r#"{"drawSplit":{}}"#.to_string();
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
            "--seeds" => seeds = int()?,
            "--a" => a_text = v.clone(),
            "--b" => b_text = v.clone(),
            "--subject" => {
                subject = *SUBJECTS
                    .iter()
                    .find(|s| s.0 == v)
                    .ok_or_else(|| format!("--subject が違います: {v}"))?
            }
            _ => return Err(format!("知らないオプション: {key}")),
        }
    }
    let parse = |text: &str| -> Result<SearchOptions, String> {
        let (raw, model) = rhino_compare_options(text)?;
        search_options(&raw, model.as_ref(), SearchOptions::default(), &[])
    };
    let (oa, ob) = (parse(&a_text)?, parse(&b_text)?);
    let me: &'static Deck = data()
        .decks
        .iter()
        .find(|d| d.name == subject.1)
        .ok_or_else(|| format!("{} がありません", subject.1))?;
    let opponents: Vec<&'static Deck> = compare_decks()
        .into_iter()
        .filter(|d| d.name != subject.1)
        .collect();
    // 局面を集める（試合 g は、相手デッキ g % 6・席 (g / 6) % 2）。局面はスレッドをまたげないので、
    // 試合の手順と、局面までに打った手の数（と、引く手を打てるか）を残し、考えるスレッドで打ち直して作る
    let t0 = Instant::now();
    let tasks: Vec<u32> = (start..start + games).collect();
    let setup = |g: u32| {
        let opp = opponents[g as usize % opponents.len()];
        let seat = ((g as usize) / opponents.len()) % 2;
        let decks = if seat == 0 {
            [&me.cards[..], &opp.cards[..]]
        } else {
            [&opp.cards[..], &me.cards[..]]
        };
        (decks, seat, subject.3 + g * 13 + seat as u32)
    };
    type Played = (Vec<Action>, Vec<(usize, bool)>);
    let played: Vec<Played> = parallel_map(
        &tasks,
        |&g, _| {
            let (decks, seat, seed) = setup(g);
            let mut x = SearchAgent::new(SearchOptions::default());
            let mut y = SearchAgent::new(SearchOptions::default());
            let mut acts: Vec<Action> = Vec::new();
            let mut at: Vec<(usize, bool)> = Vec::new();
            let mut last_turn = -1;
            play_match(
                &mut [&mut x as &mut dyn Agent, &mut y as &mut dyn Agent],
                decks,
                seed,
                |s, a| {
                    if s.phase == Phase::Main
                        && s.active == seat
                        && acting_player(s) == seat
                        && s.players[seat].turn_count != last_turn
                    {
                        last_turn = s.players[seat].turn_count;
                        let legal = legal_actions(s);
                        if legal.len() > 1 {
                            at.push((acts.len(), can_draw(s, seat, &legal)));
                        }
                    }
                    acts.push(a.clone());
                },
            );
            (acts, at)
        },
        |_, _, _, _| {},
    );
    // (試合の添字, 打った手の数, 引く手を打てるか)
    let all: Vec<(usize, usize, bool)> = played
        .iter()
        .enumerate()
        .flat_map(|(i, (_, at))| at.iter().map(move |&(n, d)| (i, n, d)))
        .collect();
    eprintln!(
        "局面 {}（引く手を打てる {}）を集めた（{} 秒）",
        all.len(),
        all.iter().filter(|x| x.2).count(),
        fixed(seconds_since(t0), 1)
    );
    let t1 = Instant::now();
    let res: Vec<(f64, f64)> = parallel_map(
        &all,
        |&(i, n, _), k| {
            let (decks, _, seed) = setup(tasks[i]);
            let mut s = create_game(decks, seed);
            for a in &played[i].0[..n] {
                s = apply_action(&s, a);
            }
            (
                agreement(&s, &oa, seeds, k as u32),
                agreement(&s, &ob, seeds, k as u32),
            )
        },
        |_, _, _, _| {},
    );
    let line = |name: &str, f: &dyn Fn(bool) -> bool| {
        let sel: Vec<&(f64, f64)> = res
            .iter()
            .zip(&all)
            .filter(|(_, x)| f(x.2))
            .map(|(r, _)| r)
            .collect();
        let n = sel.len().max(1) as f64;
        let a: f64 = sel.iter().map(|r| r.0).sum::<f64>() / n;
        let b: f64 = sel.iter().map(|r| r.1).sum::<f64>() / n;
        let full_a = sel.iter().filter(|r| r.0 >= 1.0).count() as f64 / n;
        let full_b = sel.iter().filter(|r| r.1 >= 1.0).count() as f64 / n;
        println!(
            "{name}（{} 局面）: そろい方 A {}% / B {}%、{seeds} 回とも同じ手 A {}% / B {}%",
            sel.len(),
            fixed(a * 100.0, 1),
            fixed(b * 100.0, 1),
            fixed(full_a * 100.0, 1),
            fixed(full_b * 100.0, 1)
        );
    };
    println!("A {a_text} / B {b_text}（{} {seeds} 通り）", subject.1);
    line("引く手を打てる局面", &|d| d);
    line("引く手を打てない局面", &|d| !d);
    line("全部", &|_| true);
    eprintln!("考えた時間 {} 秒", fixed(seconds_since(t1), 1));
    Ok(())
}
