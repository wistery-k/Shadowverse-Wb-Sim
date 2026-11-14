//! 探索 AI の設定 A と B を対戦させる（TypeScript 版 scripts/compare-main.ts。npm run compare と同じ試合・同じ出力）。
//!
//!   svwb compare <試合数> '<Aの設定JSON>' '<Bの設定JSON>' [最初の試合番号] [Bのデッキ名] [--no-mirror] [--decks <デッキ>,…|@<デッキの組>] [--replays <ファイル>]
//!                [--with <デッキ名> | --without <デッキ名>] [--label <名前>] [--no-ledger]
//!
//! 同じデッキの組で席とデッキを入れ替えて 2 試合ずつ行い、A の勝率とデッキごとの A の勝率を出す。
//! 2 試合の組ごとの A の勝ち数（2・1・0）の数と、組のばらつきから求めた標準誤差も出す。
//! 組の 2 試合は同じシードで打つ（鏡。デッキと席と山札の順は同じで、A と B だけが入れ替わる。2026-10-22 から）。
//! 同じ AI どうしはちょうど 50% になり、似た AI どうしは運の分が打ち消し合ってぶれが小さい。
//! `--no-mirror` は 2026-10-21 までの試合（組の 2 試合で別のシード。物差しと同じ）。
//! `--decks` なら、比較用の 7 デッキの代わりに、並べたデッキ（デフォルトデッキの名前・キーか、デッキのテキストファイル。
//! `@<ファイル>` はデッキの組のファイルに並べたデッキ。td selfplay --decks と同じ）で打つ。学習した補正の知らないカードの入ったデッキで、
//! 補正どうしを比べる用。デッキが n 個なら、試合番号 n² ごとに全部の組を回る（compare_pair。7 個なら今までと同じ組とシード）
//! （docs/ai-notes.md「カードの重みを属性とカードごとの残りに分ける」）。デフォルトデッキと違うデッキのマリガンは、
//! 返し方ごとに引き直しを試して選ぶ（td selfplay と同じ。マリガンのモデルはデフォルトデッキしか知らない）。
//! `--replays` なら、試合ごとにデッキ・シード・行動の列を JSON Lines で書く（1 行の形は runner/mod.rs の ReplayRecord。
//! npm run dev の「リプレイ検索」タブで読む）。打つ手は変わらない。
//! 回すたびに、結果を実験の台帳 `docs/ledger.jsonl` に 1 行足す（runner/ledger.rs。`--label <名前>` で名前を付け、`--no-ledger` で書かない）。
//! 試合数 0 なら設定とデッキを読むだけで終わる。
//! `--with <デッキ名>` なら、そのデッキの絡む組（A か B のどちらかがそのデッキ。7 デッキなら 49 組のうち 13 組）だけを打つ。試合番号 k は
//! 「そのデッキの絡む k 番目の試合番号」（with_game）で、組の 2 試合（鏡）はそのまま。見ていないデッキを渡したときの落ち方を、
//! そのデッキの絡む試合だけで測る用（docs/STATE.md の案 E）。`--without <デッキ名>` はその逆で、そのデッキの絡まない 36 組だけを打つ
//! （そのデッキで学び足した補正が、ほかのデッキどうしの判断を壊していないかを測る用）。

use super::deck_compare::read_deck_list;
use super::ledger;
use super::options::compare_options;
use super::parallel::parallel_map;
use super::{compare_decks, fixed, seconds_since, Tally};
use crate::ai::search::{MulliganMode, SearchAgent, SearchOptions};
use crate::ai::Agent;
use crate::data::{data, Deck};
use crate::sim::play_match;
use std::time::Instant;

/// 試合番号 g（swap で席とデッキを入れ替えた方）の A と B のデッキ。n デッキなら、試合番号 n² ごとに全部の組（同じデッキどうしを含む）を
/// 1 回ずつ回る（g = q n + r なら A は r、B は (3r + 1 + q) mod n。r ごとに q で B が全部回る）。7 デッキの組は 2026-11-14 より前と同じ
pub fn compare_pair(decks: &[&'static Deck], g: u32, swap: bool) -> (&'static Deck, &'static Deck) {
    let n = decks.len() as u32;
    let i = (g % n) as usize;
    let j = ((g * 3 + 1 + g / n) % n) as usize;
    if swap {
        (decks[j], decks[i])
    } else {
        (decks[i], decks[j])
    }
}

/// --with: デッキ with の絡む（A か B のどちらかがそのデッキの）k 番目の試合番号。compare_pair は試合番号 n²（7 デッキなら 49）ごとに同じ組を繰り返す
pub fn with_game(decks: &[&'static Deck], with: &str, k: u32) -> u32 {
    deck_game(decks, with, true, k)
}

/// --with（involved）・--without（!involved）: デッキ name の絡む・絡まない k 番目の試合番号
pub fn deck_game(decks: &[&'static Deck], name: &str, involved: bool, k: u32) -> u32 {
    let nn = (decks.len() * decks.len()) as u32;
    let table: Vec<u32> = (0..nn)
        .filter(|&g| {
            let (a, b) = compare_pair(decks, g, false);
            (a.name == name || b.name == name) == involved
        })
        .collect();
    assert!(
        !table.is_empty(),
        "{name} の{}組がありません",
        if involved { "絡む" } else { "絡まない" }
    );
    let n = table.len() as u32;
    nn * (k / n) + table[(k % n) as usize]
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

/// デッキ d で打つときの設定。デフォルトデッキと違うデッキ（--decks）では、デッキごとのモデルを使うマリガン（model・weights）の代わりに、
/// 返し方ごとに引き直しを試して選ぶ
pub fn deck_options(o: &SearchOptions, d: &Deck) -> SearchOptions {
    let mut o = o.clone();
    if o.mulligan.needs_deck_model() && !data().decks.iter().any(|x| x.cards == d.cards) {
        o.mulligan = MulliganMode::Sample;
    }
    o
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
    let (a_seat, seats, seed) = compare_setup(decks, g, swap, mirror);
    let mut a = SearchAgent::new(deck_options(a, seats[a_seat]));
    let mut b = SearchAgent::new(deck_options(b, seats[1 - a_seat]));
    let mut agents: [&mut dyn Agent; 2] = if a_seat == 0 {
        [&mut a, &mut b]
    } else {
        [&mut b, &mut a]
    };
    let mut log = Vec::new();
    let end = play_match(
        &mut agents,
        [&seats[0].cards, &seats[1].cards],
        seed,
        |_, a| {
            if labels.is_some() {
                log.push(a.clone());
            }
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
    (seats[a_seat].name.clone(), winner == a_seat, replay)
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
    // --with: そのデッキの絡む組だけを打つ。--without: 絡まない組だけを打つ
    let with = ledger::take_value(&mut argv, "--with")?;
    let without = ledger::take_value(&mut argv, "--without")?;
    let mut deck_list = None;
    if let Some(i) = argv.iter().position(|s| s == "--decks") {
        deck_list = Some(
            argv.get(i + 1)
                .ok_or("--decks の後にデッキをカンマで並べます（@<ファイル> でデッキの組）")?
                .clone(),
        );
        argv.drain(i..i + 2);
    }
    let games = number_arg(argv.first(), 28.0)?;
    let decks: Vec<&'static Deck> = match deck_list {
        None => compare_decks(),
        Some(list) => read_deck_list(&list)?
            .into_iter()
            .map(|d| &*Box::leak(Box::new(d)))
            .collect(),
    };
    if decks.len() < 2 {
        return Err("比較用のデッキは 2 つ以上".into());
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
    if with.is_some() && without.is_some() {
        return Err("--with と --without は一緒に使えません".into());
    }
    for (flag, w) in [("--with", &with), ("--without", &without)] {
        if let Some(w) = w {
            if !decks.iter().any(|d| &d.name == w) {
                return Err(format!("{flag}: 不明なデッキ: {w}"));
            }
            if vs.is_some() {
                return Err(format!("{flag} と B のデッキは一緒に使えません"));
            }
        }
    }
    let game_of = |k: u32| match (&with, &without) {
        (Some(w), _) => deck_game(&decks, w, true, k),
        (_, Some(w)) => deck_game(&decks, w, false, k),
        _ => k,
    };
    let tasks: Vec<(u32, bool)> = (0..games)
        .flat_map(|k| [(game_of(start + k), false), (game_of(start + k), true)])
        .filter(|&(g, swap)| vs.is_none_or(|v| &compare_pair(&decks, g, swap).1.name == v))
        .collect();
    let only = with
        .as_ref()
        .map(|w| format!("{w} の絡む組だけ"))
        .or_else(|| without.as_ref().map(|w| format!("{w} の絡まない組だけ")));
    if let (Some(o), Some(first), Some(last)) = (&only, tasks.first(), tasks.last()) {
        println!(
            "{o}（{} 組、試合番号 {}〜{}）",
            tasks.len() / 2,
            first.0,
            last.0
        );
    }
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
        |&(g, swap), _| play_compare_game_with(&a, &b, &decks, g, swap, mirror, labels),
        |_, _, r, _| {
            if let (Some(f), Some(line)) = (replays.as_mut(), r.2.as_ref()) {
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
    for (deck, won, _) in &results {
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
                    "with".into(),
                    with.as_ref().map_or(crate::json::Json::Null, |w| {
                        crate::json::Json::Str(w.clone())
                    }),
                ),
                (
                    "without".into(),
                    without.as_ref().map_or(crate::json::Json::Null, |w| {
                        crate::json::Json::Str(w.clone())
                    }),
                ),
                (
                    "replays".into(),
                    replays_path.as_ref().map_or(crate::json::Json::Null, |p| {
                        crate::json::Json::Str(p.clone())
                    }),
                ),
            ],
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
    fn with_game_lists_pairs_with_the_deck() {
        // --with: 49 組のうち、そのデッキの絡む 13 組を順に回す（同じ番号が 2 回出ない）
        let decks = compare_decks();
        let name = &decks[5].name;
        let gs: Vec<u32> = (0..39).map(|k| with_game(&decks, name, k)).collect();
        assert!(gs.windows(2).all(|w| w[0] < w[1]));
        for &g in &gs {
            let (a, b) = compare_pair(&decks, g, false);
            assert!(&a.name == name || &b.name == name);
        }
        assert_eq!(gs[13], gs[0] + 49);
        let all: Vec<u32> = (0..49)
            .filter(|&g| {
                let (a, b) = compare_pair(&decks, g, false);
                &a.name == name || &b.name == name
            })
            .collect();
        assert_eq!(all.len(), 13);
        assert_eq!(&gs[..13], &all[..]);
        // --without: 残りの 36 組。絡む組と合わせると 49 組を 1 回ずつ
        let out: Vec<u32> = (0..36).map(|k| deck_game(&decks, name, false, k)).collect();
        assert!(out.windows(2).all(|w| w[0] < w[1]));
        let mut both: Vec<u32> = out.iter().chain(&all).copied().collect();
        both.sort_unstable();
        assert_eq!(both, (0..49).collect::<Vec<u32>>());
        assert_eq!(deck_game(&decks, name, false, 36), out[0] + 49);
    }

    #[test]
    fn mirror_splits_pairs_of_the_same_ai() {
        let decks = compare_decks();
        let o = super::super::options::compare_options("{}").unwrap();
        let x = play_compare_game(&o, &o, &decks, 0, false, true);
        let y = play_compare_game(&o, &o, &decks, 0, true, true);
        assert_ne!(x.1, y.1);
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
