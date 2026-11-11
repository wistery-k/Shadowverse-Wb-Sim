//! 探索 AI の設定 A と B を対戦させる（TypeScript 版 scripts/compare-main.ts。npm run compare と同じ試合・同じ出力）。
//!
//!   svwb compare <試合数> '<Aの設定JSON>' '<Bの設定JSON>' [最初の試合番号] [Bのデッキ名] [--no-mirror] [--decks <7 つのデッキ>] [--replays <ファイル>]
//!                [--label <名前>] [--no-ledger] [--luck]
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
//! `--replays` なら、試合ごとにデッキ・シード・行動の列を JSON Lines で書く（1 行の形は runner/mod.rs の ReplayRecord。
//! npm run dev の「リプレイ検索」タブで読む）。打つ手は変わらない。
//! 回すたびに、結果を実験の台帳 `docs/ledger.jsonl` に 1 行足す（runner/ledger.rs。`--label <名前>` で名前を付け、`--no-ledger` で書かない）。
//! `--luck` なら、引きの運を差し引いた A の勝率と標準誤差も出す（runner/luck.rs。価値の出し方 2 通り。打つ手は変わらない）。
//! 試合数 0 なら設定とデッキを読むだけで終わる。

use super::deck_compare::read_deck;
use super::ledger;
use super::luck::{luck_stats, GameLuck, LuckJudge, METHODS};
use super::options::compare_options;
use super::parallel::parallel_map;
use super::{compare_decks, fixed, seconds_since, Tally};
use crate::ai::search::{MulliganMode, SearchAgent, SearchOptions};
use crate::ai::Agent;
use crate::data::{data, Deck};
use crate::game::apply_legal;
use crate::json::Json;
use crate::sim::play_match;
use crate::state::{Action, Iid};
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
    let (deck, won, _) = play_compare_game_with(a, b, decks, g, swap, mirror, None);
    (deck, won)
}

/// play_compare_game と同じ試合。labels（A・B の名前）があれば、リプレイ検索用の 1 行（ReplayRecord）も返す
pub fn play_compare_game_with(
    a: &SearchOptions,
    b: &SearchOptions,
    decks: &[&'static Deck],
    g: u32,
    swap: bool,
    mirror: bool,
    labels: Option<[&str; 2]>,
) -> (String, bool, Option<String>) {
    let r = play_compare_game_full(a, b, decks, g, swap, mirror, labels, false);
    (r.deck, r.a_won, r.replay)
}

/// compare の 1 試合の結果
pub struct CompareGame {
    /// A のデッキ名と、A が勝ったか
    pub deck: String,
    pub a_won: bool,
    /// リプレイ検索用の 1 行（labels のとき）
    pub replay: Option<String>,
    /// A の席
    pub a_seat: usize,
    /// 引きの運（--luck のとき。席 0 から見た値。runner/luck.rs）
    pub luck: Option<GameLuck>,
    /// 席ごとのマリガンで返したカード（--luck のとき。並べたもの）
    pub mulligans: [Option<Vec<Iid>>; 2],
    /// 試合に掛かった時間（秒。運の採点の分を除く）
    pub seconds: f64,
}

/// play_compare_game_with と同じ試合。luck なら、引きの運（runner/luck.rs）とマリガンも記録する（打つ手は変わらない）
#[allow(clippy::too_many_arguments)]
pub fn play_compare_game_full(
    a: &SearchOptions,
    b: &SearchOptions,
    decks: &[&'static Deck],
    g: u32,
    swap: bool,
    mirror: bool,
    labels: Option<[&str; 2]>,
    luck: bool,
) -> CompareGame {
    let t0 = Instant::now();
    let (a_seat, seats, seed) = compare_setup(decks, g, swap, mirror);
    // デフォルトデッキと違うデッキ（--decks）では、デッキごとのモデルを使うマリガン（model・weights）の代わりに、
    // 返し方ごとに引き直しを試して選ぶ
    let opts = |o: &SearchOptions, d: &Deck| {
        let mut o = o.clone();
        if o.mulligan.needs_deck_model() && !data().decks.iter().any(|x| x.cards == d.cards) {
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
    let mut log = Vec::new();
    let judge = luck.then(LuckJudge::new);
    let mut game_luck = GameLuck::default();
    let mut mulligans: [Option<Vec<Iid>>; 2] = [None, None];
    let mut step = 0u32;
    let end = play_match(
        &mut agents,
        [&seats[0].cards, &seats[1].cards],
        seed,
        |s, a| {
            if labels.is_some() {
                log.push(a.clone());
            }
            if let Some(judge) = &judge {
                if let Action::Mulligan { player, swap } = a {
                    let mut x = swap.clone();
                    x.sort_unstable();
                    mulligans[*player] = Some(x);
                }
                let t = Instant::now();
                let after = apply_legal(s, a);
                game_luck.alt_secs += t.elapsed().as_secs_f64();
                judge.add_step(s, a, &after, seed, step, &mut game_luck);
            }
            step += 1;
        },
    );
    let winner = end
        .winner
        .unwrap_or_else(|| panic!("勝者がいません（試合 {g}）"));
    let replay = labels.map(|[la, lb]| {
        let agents = if a_seat == 0 { [la, lb] } else { [lb, la] };
        super::ReplayRecord {
            source: "compare",
            g,
            names: [&seats[0].name, &seats[1].name],
            agents,
            decks: [&seats[0].cards, &seats[1].cards],
            seed,
            end: &end,
            actions: &log,
        }
        .line()
    });
    let luck_secs = game_luck.alt_secs + game_luck.eval_secs.iter().sum::<f64>();
    CompareGame {
        deck: seats[a_seat].name.clone(),
        a_won: winner == a_seat,
        replay,
        a_seat,
        luck: judge.map(|_| game_luck),
        mulligans,
        seconds: seconds_since(t0) - luck_secs,
    }
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
    let full_argv: Vec<String> = std::iter::once("compare".to_string())
        .chain(argv.iter().cloned())
        .collect();
    let mirror = !argv.iter().any(|s| s == "--no-mirror");
    let mut argv: Vec<String> = argv
        .iter()
        .filter(|s| *s != "--no-mirror")
        .cloned()
        .collect();
    // 実験の台帳（docs/ledger.jsonl。runner/ledger.rs）: --label で名前を付ける、--no-ledger で書かない
    let no_ledger = ledger::take_no_ledger(&mut argv);
    let label = ledger::take_value(&mut argv, "--label")?.unwrap_or_default();
    // 引きの運を差し引いた勝率も出す（--luck。runner/luck.rs）
    let luck = {
        let before = argv.len();
        argv.retain(|s| s != "--luck");
        argv.len() != before
    };
    // リプレイ検索用に、試合ごとのデッキ・シード・行動の列を書くファイル（--replays）
    let mut replays_path = None;
    if let Some(i) = argv.iter().position(|s| s == "--replays") {
        replays_path = Some(
            argv.get(i + 1)
                .ok_or("--replays の後に書き出すファイルを渡します")?
                .clone(),
        );
        argv.drain(i..i + 2);
    }
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
    // 0 試合なら設定とデッキを読むだけ（夜のキュー npm run night が、回す前に書き間違いを見つけるのに使う）
    if tasks.is_empty() {
        println!("試合がありません（設定とデッキは読めました）");
        return Ok(());
    }
    let mut replays = replays_path
        .as_ref()
        .map(|p| std::fs::File::create(p).map_err(|e| format!("{p} に書けません: {e}")))
        .transpose()?;
    let la = format!("A {a_text}");
    let lb = format!("B {b_text}");
    let labels = replays.as_ref().map(|_| [la.as_str(), lb.as_str()]);
    let results = parallel_map(
        &tasks,
        |&(g, swap), _| play_compare_game_full(&a, &b, &decks, g, swap, mirror, labels, luck),
        |_, _, r, _| {
            if let (Some(f), Some(line)) = (replays.as_mut(), r.replay.as_ref()) {
                use std::io::Write;
                writeln!(f, "{line}").unwrap_or_else(|e| {
                    panic!(
                        "{} に書けません: {e}",
                        replays_path.as_deref().unwrap_or("")
                    )
                });
            }
        },
    );
    let n = results.len();
    let mut wins = 0;
    let mut per_deck = Tally::default();
    for r in &results {
        wins += r.a_won as u32;
        per_deck.add(&r.deck, r.a_won);
    }
    println!(
        "A{a_text} vs B{b_text}: {wins}/{n} = {}%  {}s/試合",
        fixed((wins as f64 / n as f64) * 100.0, 1),
        fixed(seconds_since(t0) / n as f64, 2)
    );
    println!("{}", per_deck.line());
    let won: Vec<bool> = results.iter().map(|r| r.a_won).collect();
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
    let luck_json = if luck {
        Some(print_luck(&tasks, &results))
    } else {
        None
    };
    if !no_ledger && n > 0 {
        ledger::append(&ledger::Run {
            kind: "compare",
            argv: full_argv,
            label,
            a: a_text.to_string(),
            b: b_text.to_string(),
            extra: vec![
                (
                    "vs".into(),
                    vs.map_or(crate::json::Json::Null, |v| {
                        crate::json::Json::Str(v.clone())
                    }),
                ),
                (
                    "replays".into(),
                    replays_path.as_ref().map_or(crate::json::Json::Null, |p| {
                        crate::json::Json::Str(p.clone())
                    }),
                ),
            ]
            .into_iter()
            .chain(luck_json.map(|j| ("luck".to_string(), j)))
            .collect(),
            decks: decks.iter().map(|d| d.name.clone()).collect(),
            mirror,
            first: start,
            last: start + games.max(1) - 1,
            n: n as u32,
            wins,
            se,
            se_kind: "pairs",
            pairs: [c0, c1, c2],
            per_deck: per_deck.0,
            seconds: seconds_since(t0),
        });
    }
    Ok(())
}

/// --luck の集計を出し、台帳に書く項目を返す（runner/luck.rs）
fn print_luck(tasks: &[(u32, bool)], results: &[CompareGame]) -> Json {
    let n = results.len() as f64;
    let lucks: Vec<&GameLuck> = results
        .iter()
        .map(|r| r.luck.as_ref().expect("--luck の試合"))
        .collect();
    let per_game = |f: &dyn Fn(&GameLuck) -> f64| lucks.iter().map(|l| f(l)).sum::<f64>() / n;
    let game_secs = results.iter().map(|r| r.seconds).sum::<f64>() / n;
    let alt_secs = per_game(&|l| l.alt_secs);
    let draws = per_game(&|l| l.draws as f64);
    let skipped = per_game(&|l| l.skipped as f64);
    println!(
        "運の補正: 1 試合あたり、補正した引き {}・補正しなかった山札の変化 {}。試合 {} 秒、引きうる局面を作る {} 秒（1 スレッドの時間）",
        fixed(draws, 2),
        fixed(skipped, 2),
        fixed(game_secs, 3),
        fixed(alt_secs, 4)
    );
    let won: Vec<bool> = results.iter().map(|r| r.a_won).collect();
    // 台帳の数（有限でなければ null）
    let num = |x: f64| {
        if x.is_finite() {
            Json::Num(crate::jsnum::round_precision(x, 6))
        } else {
            Json::Null
        }
    };
    let mut methods = Vec::new();
    for (m, name) in METHODS.iter().enumerate() {
        let luck_a: Vec<f64> = results
            .iter()
            .zip(&lucks)
            .map(|(r, l)| if r.a_seat == 0 { l.luck[m] } else { -l.luck[m] })
            .collect();
        let st = luck_stats(tasks, &won, &luck_a);
        let eval_secs = per_game(&|l| l.eval_secs[m]);
        let cost = alt_secs + eval_secs;
        let var_ratio = (st.se / st.raw_se).powi(2);
        let time_ratio = (game_secs + cost) / game_secs;
        println!(
            "  {name}: A の勝率 {}% ± {}（補正前 {}% ± {}）、分散の比 {}、運の平均 {} ± {} ポイント、傾き {}（その傾きなら ± {}）、\
             採点 {} 秒/試合（試合の {} 倍）、同じ確かさの手間 {} 倍、補正後にちょうど 1 点の組 {}/{}",
            fixed(st.rate * 100.0, 2),
            fixed(st.se * 100.0, 2),
            fixed(st.raw * 100.0, 2),
            fixed(st.raw_se * 100.0, 2),
            fixed(var_ratio, 3),
            fixed(st.mean * 100.0, 2),
            fixed(st.mean_se * 100.0, 2),
            fixed(st.beta, 2),
            fixed(st.beta_se * 100.0, 2),
            fixed(cost, 4),
            fixed(time_ratio, 3),
            fixed(var_ratio * time_ratio, 3),
            st.exact_half,
            st.pairs
        );
        methods.push(Json::Obj(vec![
            ("name".into(), Json::Str(["light", "heavy"][m].into())),
            ("rate".into(), num(st.rate)),
            ("se".into(), num(st.se)),
            ("rawSe".into(), num(st.raw_se)),
            ("varRatio".into(), num(var_ratio)),
            ("mean".into(), num(st.mean)),
            ("meanSe".into(), num(st.mean_se)),
            ("beta".into(), num(st.beta)),
            ("betaSe".into(), num(st.beta_se)),
            ("secPerGame".into(), num(cost)),
            ("timeRatio".into(), num(time_ratio)),
            ("exactHalf".into(), Json::Num(st.exact_half as f64)),
        ]));
    }
    // 組の 2 試合で、どちらかの席のマリガン（返したカード）が違った組。割れた組（A が 2 勝か 0 勝）のうちの数も
    let mut by_game: std::collections::BTreeMap<u32, Vec<&CompareGame>> = Default::default();
    for (&(g, _), r) in tasks.iter().zip(results) {
        by_game.entry(g).or_default().push(r);
    }
    let (mut pairs, mut diff, mut split, mut split_diff) = (0, 0, 0, 0);
    for rs in by_game.values().filter(|rs| rs.len() == 2) {
        pairs += 1;
        let d = rs[0].mulligans != rs[1].mulligans;
        let s = rs[0].a_won == rs[1].a_won;
        diff += d as u32;
        split += s as u32;
        split_diff += (d && s) as u32;
    }
    println!("  マリガンが違った組 {diff}/{pairs}、割れた組 {split} のうちマリガンが違った組 {split_diff}");
    Json::Obj(vec![
        ("draws".into(), num(draws)),
        ("skipped".into(), num(skipped)),
        ("gameSec".into(), num(game_secs)),
        ("altSec".into(), num(alt_secs)),
        ("methods".into(), Json::Arr(methods)),
        ("mulliganDiff".into(), Json::Num(diff as f64)),
        ("split".into(), Json::Num(split as f64)),
        ("splitMulliganDiff".into(), Json::Num(split_diff as f64)),
    ])
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

    /// --luck: 同じ AI どうしの鏡では、2 試合の局面が同じなので席 0 から見た運が同じになり、A から見ると打ち消し合って補正後もちょうど 1 勝 1 敗
    #[test]
    fn luck_cancels_in_a_mirror_of_the_same_ai() {
        let decks = compare_decks();
        let o = super::super::options::compare_options(r#"{"beamWidth":8}"#).unwrap();
        let x = play_compare_game_full(&o, &o, &decks, 1, false, true, None, true);
        let y = play_compare_game_full(&o, &o, &decks, 1, true, true, None, true);
        let (lx, ly) = (x.luck.clone().unwrap(), y.luck.clone().unwrap());
        assert!(lx.draws > 5, "補正した引き {}", lx.draws);
        assert_eq!(lx.luck, ly.luck);
        assert!(lx.luck.iter().all(|l| *l != 0.0));
        assert_ne!(x.a_seat, y.a_seat);
        assert_ne!(x.a_won, y.a_won);
        assert_eq!(x.mulligans, y.mulligans);
        let a_view = |r: &CompareGame, m: usize| {
            let l = r.luck.as_ref().unwrap().luck[m];
            if r.a_seat == 0 {
                l
            } else {
                -l
            }
        };
        for m in 0..2 {
            let st = luck_stats(
                &[(1, false), (1, true)],
                &[x.a_won, y.a_won],
                &[a_view(&x, m), a_view(&y, m)],
            );
            assert_eq!(st.exact_half, 1);
            assert_eq!(st.rate, 0.5);
        }
    }

    /// --replays の行（デッキ・シード・行動の列）から打ち直すと、同じ勝者になる
    #[test]
    fn replay_line_replays_the_same_game() {
        use crate::json::Json;
        let decks = compare_decks();
        let o = super::super::options::compare_options(r#"{"beamWidth":8}"#).unwrap();
        let (_, a_won, line) =
            play_compare_game_with(&o, &o, &decks, 3, true, true, Some(["A", "B"]));
        let v = Json::parse(&line.expect("リプレイの行")).unwrap();
        let ids = |d: &Json| -> Vec<crate::data::CardIdx> {
            let Json::Arr(xs) = d else {
                panic!("デッキ")
            };
            xs.iter()
                .map(|x| match x {
                    Json::Str(id) => data().card_by_id[id.as_str()],
                    _ => panic!("カードID"),
                })
                .collect()
        };
        let Some(Json::Arr(ds)) = v.get("decks") else {
            panic!("decks")
        };
        let Some(Json::Arr(acts)) = v.get("actions") else {
            panic!("actions")
        };
        let acts: Vec<_> = acts
            .iter()
            .map(|a| crate::state_json::action_from_json(a).unwrap())
            .collect();
        let Some(Json::Num(seed)) = v.get("seed") else {
            panic!("seed")
        };
        let (d0, d1) = (ids(&ds[0]), ids(&ds[1]));
        let idx = crate::replay_index::replay_index([&d0, &d1], *seed as u32, &acts).unwrap();
        assert_eq!(idx.get("winner"), v.get("winner"));
        // A の席（席とデッキを入れ替えた方）
        let (a_seat, _, _) = compare_setup(&decks, 3, true, true);
        let Some(Json::Arr(agents)) = v.get("agents") else {
            panic!("agents")
        };
        assert_eq!(agents[a_seat], Json::Str("A".into()));
        assert_eq!(
            v.get("winner"),
            Some(&Json::Num(if a_won { a_seat } else { 1 - a_seat } as f64))
        );
    }
}
