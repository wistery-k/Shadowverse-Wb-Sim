//! draw-stability: 同じ局面で乱数を変えて何度も考えさせ、最初の手がどれだけそろうか（ぶれ）を、2 つの設定で比べる
//! （docs/ai-notes.md「引く手の直前で区切って引きを作り直す」）。
//!
//! 使い方: svwb draw-stability [--subject spellwitch] [--games 12] [--start 0] [--seeds 8]
//!                             [--a '<設定JSON>'] [--b '<設定JSON>'] [--detail 0]
//!
//! 比べるデッキと 6 デッキを今の既定の探索 AI どうしで打ち（rhino-compare と同じ組み方・シード）、比べるデッキの各ターンの最初の局面を集める。
//! 各局面で、設定 A・B の探索 AI に seeds 通りの乱数で手を選ばせ（前に選んだ並びは使わない）、最も多く選ばれた手の割合（そろい方）を平均する。
//! 比べるのは、最初の 1 手と、選んだ並びの最初に引く手・ランダムな手まで（引いた後の手は引いたカードで変わってよいので比べない。順番は問わない）。
//! 局面は「カードを引く手（自分の山札が減る手）を今打てる」ものと、そうでないものに分けて出す。最初の 1 手が「引く手・ランダムな手を先に打つか」で割れた局面の割合と、
//! 1 回考える時間の平均も出す（並列に考えるので、1 スレッドで考えるより長めに出る）。
//! --detail N なら、B で先に引くかどうかが割れた局面を N 個まで、局面と、最初の手ごとの選ばれた回数・点数の平均とぶれを出す

use super::compare_decks;
use super::deep_gap::describe;
use super::human_plan::step_text;
use super::options::{rhino_compare_options, search_options};
use super::parallel::parallel_map;
use super::rhino_compare::SUBJECTS;
use super::{fixed, seconds_since};
use crate::ai::keys::turn_order_eq;
use crate::ai::search::{is_chance_step, SearchAgent, SearchOptions};
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

/// 1 つの設定で 1 つの局面を何度も考えさせた結果
#[derive(Clone, Copy, Default)]
struct Spread {
    /// 最初の 1 手で、最も多く選ばれた手の割合
    first: f64,
    /// 最初に引く手・ランダムな手まで（それを含む。無ければターンの終わりまで）の並びを順番によらずに比べて、最も多く選ばれた並びの割合
    prefix: f64,
    /// 最初の 1 手が、引く手・ランダムな手を先に打つものと、ほかの手を先に打つものに割れたか
    draw_timing_split: bool,
    /// 考えた時間（秒）
    seconds: f64,
}

/// 並びを、最初に引く手・ランダムな手の直前まで実際の局面 s に打った局面と、その手（無ければ None）
fn prefix_of(s: &GameState, p: usize, steps: &[Action]) -> (GameState, Option<Action>) {
    let mut cur = s.clone();
    for a in steps {
        if matches!(a, Action::EndTurn) {
            break;
        }
        let Some(next) = try_apply_action(&cur, a) else {
            break;
        };
        if is_chance_step(&cur, &next, p) {
            return (cur, Some(a.clone()));
        }
        cur = next;
    }
    (cur, None)
}

/// 最も多いものの割合（same で同じとみなす）
fn top_share<T>(xs: &[T], same: impl Fn(&T, &T) -> bool) -> f64 {
    let top = xs
        .iter()
        .map(|x| xs.iter().filter(|y| same(x, y)).count())
        .max()
        .unwrap_or(0);
    top as f64 / xs.len().max(1) as f64
}

/// 局面 s で、設定 opts の探索 AI に seeds 通りの乱数で手を選ばせる（choose_action と同じ乱数の使い方。前に選んだ並びは使わない）
fn spread(s: &GameState, opts: &SearchOptions, seeds: u32, salt: u32) -> Spread {
    let legal = legal_actions(s);
    let p = acting_player(s);
    let t = Instant::now();
    let mut firsts: Vec<Action> = Vec::new();
    let mut prefixes: Vec<(GameState, Option<Action>)> = Vec::new();
    let mut chance_first: Vec<bool> = Vec::new();
    for k in 0..seeds {
        let agent = SearchAgent::new(opts.clone());
        let mut rng = Rng::new(salt.wrapping_mul(7919).wrapping_add(k * 104729 + 1));
        let (first, steps) = match agent.think_with(s, &legal, &mut rng, None) {
            Some(th) => {
                let steps = th
                    .candidates
                    .iter()
                    .find(|c| th.lethal.is_none() && c.action == th.chosen)
                    .map(|c| c.steps.clone())
                    .unwrap_or_else(|| vec![th.chosen.clone()]);
                (th.chosen, steps)
            }
            None => (legal[0].clone(), vec![legal[0].clone()]),
        };
        chance_first.push(
            !matches!(first, Action::EndTurn)
                && try_apply_action(s, &first).is_some_and(|n| is_chance_step(s, &n, p)),
        );
        prefixes.push(prefix_of(s, p, &steps));
        firsts.push(first);
    }
    Spread {
        first: top_share(&firsts, |a, b| a == b),
        prefix: top_share(&prefixes, |a, b| a.1 == b.1 && turn_order_eq(&a.0, &b.0)),
        draw_timing_split: chance_first.iter().any(|x| *x) && chance_first.iter().any(|x| !*x),
        seconds: seconds_since(t),
    }
}

/// 局面 s で、設定 opts の探索 AI に seeds 通りの乱数で考えさせたときの、読み直した最初の手ごとの選ばれた回数と点数（選ぶときの値）を出す（--detail）
fn print_detail(s: &GameState, opts: &SearchOptions, seeds: u32, salt: u32) {
    let legal = legal_actions(s);
    let p = acting_player(s);
    // (最初の手, 選ばれた回数, 読み直した点数の列)
    let mut rows: Vec<(Action, u32, Vec<f64>)> = Vec::new();
    for k in 0..seeds {
        let agent = SearchAgent::new(opts.clone());
        let mut rng = Rng::new(salt.wrapping_mul(7919).wrapping_add(k * 104729 + 1));
        let Some(th) = agent.think_with(s, &legal, &mut rng, None) else {
            continue;
        };
        for c in &th.candidates {
            let Some(v) = c.value else {
                continue;
            };
            let at = match rows.iter().position(|r| r.0 == c.action) {
                Some(i) => i,
                None => {
                    rows.push((c.action.clone(), 0, Vec::new()));
                    rows.len() - 1
                }
            };
            rows[at].2.push(v);
        }
        if let Some(r) = rows.iter_mut().find(|r| r.0 == th.chosen) {
            r.1 += 1;
        } else {
            rows.push((th.chosen.clone(), 1, Vec::new()));
        }
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len().max(1) as f64;
    rows.sort_by(|x, y| mean(&y.2).total_cmp(&mean(&x.2)));
    for (a, chosen, vals) in &rows {
        let m = mean(vals);
        let sd = if vals.len() > 1 {
            (vals.iter().map(|v| (v - m).powi(2)).sum::<f64>() / (vals.len() - 1) as f64).sqrt()
        } else {
            0.0
        };
        let draw = !matches!(a, Action::EndTurn)
            && try_apply_action(s, a).is_some_and(|n| is_chance_step(s, &n, p));
        println!(
            "    {}{}: 選んだ {chosen}/{seeds}、点数 {} ± {}（読んだ {} 回）",
            step_text(s, a, p),
            if draw {
                "（引く・ランダム）"
            } else {
                ""
            },
            fixed(m, 1),
            fixed(sd, 1),
            vals.len()
        );
    }
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mut games: u32 = 12;
    let mut start: u32 = 0;
    let mut seeds: u32 = 8;
    let mut subject = SUBJECTS[2];
    let mut a_text = "{}".to_string();
    let mut b_text = r#"{"drawSplit":{}}"#.to_string();
    let mut detail: u32 = 0;
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
            "--detail" => detail = int()?,
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
    let res: Vec<(Spread, Spread)> = parallel_map(
        &all,
        |&(i, n, _), k| {
            let (decks, _, seed) = setup(tasks[i]);
            let mut s = create_game(decks, seed);
            for a in &played[i].0[..n] {
                s = apply_action(&s, a);
            }
            (
                spread(&s, &oa, seeds, k as u32),
                spread(&s, &ob, seeds, k as u32),
            )
        },
        |_, _, _, _| {},
    );
    let line = |name: &str, f: &dyn Fn(bool) -> bool| {
        let sel: Vec<&(Spread, Spread)> = res
            .iter()
            .zip(&all)
            .filter(|(_, x)| f(x.2))
            .map(|(r, _)| r)
            .collect();
        let n = sel.len().max(1) as f64;
        let pct = |g: &dyn Fn(&Spread) -> f64| -> (String, String) {
            let a = sel.iter().map(|r| g(&r.0)).sum::<f64>() / n * 100.0;
            let b = sel.iter().map(|r| g(&r.1)).sum::<f64>() / n * 100.0;
            (fixed(a, 1), fixed(b, 1))
        };
        let all_same = |x: f64| if x >= 1.0 { 1.0 } else { 0.0 };
        let first = pct(&|r| r.first);
        let first_full = pct(&|r| all_same(r.first));
        let prefix = pct(&|r| r.prefix);
        let prefix_full = pct(&|r| all_same(r.prefix));
        let timing = pct(&|r| if r.draw_timing_split { 1.0 } else { 0.0 });
        // 1 回考える時間（ミリ秒）の平均
        let per = n * seeds.max(1) as f64 / 1000.0;
        let ta: f64 = sel.iter().map(|r| r.0.seconds).sum::<f64>() / per;
        let tb: f64 = sel.iter().map(|r| r.1.seconds).sum::<f64>() / per;
        println!("{name}（{} 局面）", sel.len());
        println!(
            "  最初の 1 手: そろい方 A {}% / B {}%、{seeds} 回とも同じ A {}% / B {}%",
            first.0, first.1, first_full.0, first_full.1
        );
        println!(
            "  最初に引く手・ランダムな手までの並び（順番は問わない）: そろい方 A {}% / B {}%、{seeds} 回とも同じ A {}% / B {}%",
            prefix.0, prefix.1, prefix_full.0, prefix_full.1
        );
        println!(
            "  最初の 1 手が、引く手・ランダムな手を先に打つかどうかで割れた局面 A {}% / B {}%",
            timing.0, timing.1
        );
        println!(
            "  1 回考える時間 A {} ms / B {} ms",
            fixed(ta, 0),
            fixed(tb, 0)
        );
    };
    println!("A {a_text} / B {b_text}（{} {seeds} 通り）", subject.1);
    line("引く手を打てる局面", &|d| d);
    line("引く手を打てない局面", &|d| !d);
    line("全部", &|_| true);
    // B で、最初の 1 手が引く手・ランダムな手を先に打つかどうかで割れた局面を、detail 個まで詳しく出す
    let picked: Vec<usize> = (0..all.len())
        .filter(|&j| res[j].1.draw_timing_split)
        .take(detail as usize)
        .collect();
    for j in picked {
        let (i, n, _) = all[j];
        let (decks, seat, seed) = setup(tasks[i]);
        let mut s = create_game(decks, seed);
        for a in &played[i].0[..n] {
            s = apply_action(&s, a);
        }
        let opp = opponents[tasks[i] as usize % opponents.len()];
        let names: [String; 2] = if seat == 0 {
            [me.name.clone(), opp.name.clone()]
        } else {
            [opp.name.clone(), me.name.clone()]
        };
        println!(
            "\n試合 {}（シード {seed}）の {} ターン目（B が先に引くかどうかで割れた局面）",
            tasks[i], s.players[seat].turn_count
        );
        for l in describe(&s, seat, &names) {
            println!("  {l}");
        }
        println!("  B の最初の手（選ぶときの値の平均の順）:");
        print_detail(&s, &ob, seeds, j as u32);
    }
    eprintln!("考えた時間 {} 秒", fixed(seconds_since(t1), 1));
    Ok(())
}
