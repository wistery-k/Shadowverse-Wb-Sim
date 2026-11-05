//! 自分のターンの木の探索（`tree`。ai/search/tree.rs）を、今のビームと採点した局面の数あたりの取りこぼしで比べる道具（2026-11-05）。
//!
//!   svwb tree-gap upper-fit --nodes 局面.jsonl[,…] --tau 0.9 --out 表.json [--min 30] [--gBins 5]
//!   svwb tree-gap report --runs 結果.jsonl[,…] [--tsv 表.tsv]
//!
//! upper-fit: `svwb beam-gap --sample k --nodes` の行（広いビームが残した途中の局面と、その先で届いた最善）から、伸びしろ
//! （届いた最善 − そこで終えた点数）の上側の分位点 tau の表（ai/upper.rs）を作る。先へ広げられない局面と勝ち負けの点の付く局面は数えない。
//!
//! report: 同じ局面で打った `svwb beam-gap --out` の結果をいくつか合わせ、どの設定（と木の探索の予算ごとの途中）でも見つかった最善の最大
//! （分かっている最善）と比べる。設定・予算ごとに、ターン末の最善の差の平均・3 点以上劣る割合、分かっている最善の上位 4 つの最初の手それぞれの最善との差、
//! 最善の最初の手（同じ点数の手が何通りもあればそのどれか）がその設定の上位 4 つの最初の手に入る割合・1 位の割合、見逃したリーサル（そのうちリーサル探索も見つけない数）、採点した局面の数を出す。
//! 分かっている最善が勝ち負けの点（絶対値 1e5 以上）の局面は、見逃したリーサルのほかは数えない。差は 0〜1000 に収める。
//! docs/ai-notes.md「自分のターンの探索を B*・MCTS に」

use super::beam_gap::firsts_from_json;
use super::fixed;
use super::human_plan::mean_se;
use crate::ai::upper::{fit_upper, quantile, UpperShape, UpperTable};
use crate::json::Json;
use std::io::{BufRead, Write};

const DECIDED: f64 = 1e5;
/// 差の上限（負けの点だけの最初の手で平均が壊れないように）
const GAP_CAP: f64 = 1000.0;

pub fn main(argv: &[String]) -> Result<(), String> {
    match argv.first().map(|s| s.as_str()) {
        Some("upper-fit") => upper_fit(&argv[1..]),
        Some("report") => report(&argv[1..]),
        _ => Err("使い方: svwb tree-gap upper-fit … | report …（runner/tree_gap.rs）".into()),
    }
}

fn args(argv: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let v = argv.get(i + 1).cloned().ok_or("引数の値がありません")?;
        out.push((argv[i].clone(), v));
        i += 2;
    }
    Ok(out)
}

fn lines(paths: &str) -> Result<Vec<Json>, String> {
    let mut out = Vec::new();
    for path in paths.split(',') {
        let f = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
        for line in std::io::BufReader::new(f).lines() {
            let line = line.map_err(|e| e.to_string())?;
            if !line.trim().is_empty() {
                out.push(Json::parse(&line)?);
            }
        }
    }
    Ok(out)
}

fn num(v: &Json, k: &str) -> Option<f64> {
    match v.get(k) {
        Some(Json::Num(x)) => Some(*x),
        _ => None,
    }
}

fn upper_fit(argv: &[String]) -> Result<(), String> {
    let mut nodes: Option<String> = None;
    let mut out: Option<String> = None;
    let mut tau = 0.9;
    let mut min = 30usize;
    let mut g_bins = 5usize;
    for (k, v) in args(argv)? {
        match k.as_str() {
            "--nodes" => nodes = Some(v),
            "--out" => out = Some(v),
            "--tau" => tau = v.parse().map_err(|_| "--tau は数")?,
            "--min" => min = v.parse().map_err(|_| "--min は数")?,
            "--gBins" => g_bins = v.parse().map_err(|_| "--gBins は数")?,
            _ => return Err(format!("不明な引数: {k}（tree-gap upper-fit）")),
        }
    }
    let nodes = nodes.ok_or("--nodes がありません")?;
    let out = out.ok_or("--out がありません")?;
    let mut rows: Vec<(UpperShape, f64)> = Vec::new();
    for v in lines(&nodes)? {
        let (Some(depth), Some(value), Some(after)) =
            (num(&v, "depth"), num(&v, "value"), num(&v, "bestAfter"))
        else {
            return Err("局面の行に depth・value・bestAfter がありません".into());
        };
        if !matches!(v.get("open"), Some(Json::Bool(true)))
            || depth < 1.0
            || value.abs() >= DECIDED
            || after.abs() >= DECIDED
        {
            continue;
        }
        let sh = UpperShape {
            depth: depth as u32,
            usable_pp: num(&v, "usablePp").unwrap_or(0.0),
            attackers: num(&v, "attackers").unwrap_or(0.0),
            evolve: num(&v, "evolve").unwrap_or(0.0) > 0.0
                || num(&v, "superEvolve").unwrap_or(0.0) > 0.0,
            pot: num(&v, "pot"),
        };
        rows.push((sh, (after - value).max(0.0)));
    }
    if rows.is_empty() {
        return Err("数える局面がありません（beam-gap --sample の --nodes を渡す）".into());
    }
    let mut pots: Vec<f64> = rows.iter().filter_map(|(s, _)| s.pot).collect();
    pots.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let g_edges: Vec<f64> = (1..g_bins.max(1))
        .map(|i| (quantile(&pots, i as f64 / g_bins as f64) * 1000.0).round() / 1000.0)
        .collect();
    let table = fit_upper(&rows, tau, min, g_edges);
    std::fs::write(&out, table.stringify() + "\n").map_err(|e| format!("{out}: {e}"))?;
    // 学んだ局面で、伸びしろが表の値以下の割合（tau に近いはず）を手数ごとに
    let t = UpperTable::from_json(&table)?;
    println!(
        "{} 局面、tau {tau}、見込みの区切り {:?}",
        rows.len(),
        t.g_edges
    );
    println!("手数: 局面の数・伸びしろ 0 の割合・伸びしろが表の値以下の割合・表の値の平均");
    for d in 1..=16u32 {
        let rs: Vec<&(UpperShape, f64)> = rows.iter().filter(|(s, _)| s.depth == d).collect();
        if rs.is_empty() {
            continue;
        }
        let n = rs.len() as f64;
        let zero = rs.iter().filter(|(_, h)| *h <= 1e-9).count() as f64;
        let covered = rs.iter().filter(|(s, h)| *h <= t.upper(s) + 1e-9).count() as f64;
        let mean_u = rs.iter().map(|(s, _)| t.upper(s)).sum::<f64>() / n;
        println!(
            "  {d}: {} 局面・{}%・{}%・{}",
            rs.len(),
            fixed(100.0 * zero / n, 1),
            fixed(100.0 * covered / n, 1),
            fixed(mean_u, 2)
        );
    }
    Ok(())
}

/// 1 つの設定（または木の探索の予算ごとの途中）の結果
struct Point {
    best: f64,
    firsts: Vec<(String, f64)>,
    /// 正確に採点した局面の数
    scored: f64,
    /// 予想だけした局面の数（木の探索の lazy）
    predicted: f64,
    /// 時間（予算ごとの途中は None）
    secs: Option<f64>,
}

struct Pos {
    deck: String,
    turn: i32,
    lethal: bool,
    /// 方式ごと（methods の並び）。その局面に無ければ None
    points: Vec<Option<Point>>,
}

fn point_of(v: &Json, firsts: Vec<(String, f64)>, secs: Option<f64>) -> Point {
    let scored = num(v, "scored").unwrap_or(0.0);
    let predicted = num(v, "predicted").unwrap_or(0.0);
    let best = firsts
        .iter()
        .map(|x| x.1)
        .fold(num(v, "best").unwrap_or(f64::NEG_INFINITY), f64::max);
    Point {
        best,
        firsts,
        scored,
        predicted,
        secs,
    }
}

fn report(argv: &[String]) -> Result<(), String> {
    let mut runs: Option<String> = None;
    let mut tsv: Option<String> = None;
    for (k, v) in args(argv)? {
        match k.as_str() {
            "--runs" => runs = Some(v),
            "--tsv" => tsv = Some(v),
            _ => return Err(format!("不明な引数: {k}（tree-gap report）")),
        }
    }
    let runs = runs.ok_or("--runs がありません")?;
    // 方式の名前（最初の結果の基準は ref、設定は名前、途中は 名前@予算）と、局面（試合・番号）ごとの結果
    let mut methods: Vec<String> = Vec::new();
    let mut positions: Vec<((u32, usize), Pos)> = Vec::new();
    let index = |methods: &mut Vec<String>, name: String| -> usize {
        match methods.iter().position(|m| *m == name) {
            Some(i) => i,
            None => {
                methods.push(name);
                methods.len() - 1
            }
        }
    };
    for (fi, path) in runs.split(',').enumerate() {
        for v in lines(path)? {
            let key = (
                num(&v, "game").ok_or("結果の行に game がありません")? as u32,
                num(&v, "k").ok_or("結果の行に k がありません")? as usize,
            );
            let pi = match positions.iter().position(|(k, _)| *k == key) {
                Some(i) => i,
                None => {
                    positions.push((
                        key,
                        Pos {
                            deck: match v.get("deck") {
                                Some(Json::Str(s)) => s.clone(),
                                _ => "?".into(),
                            },
                            turn: num(&v, "turn").unwrap_or(0.0) as i32,
                            lethal: matches!(v.get("lethal"), Some(Json::Bool(true))),
                            points: Vec::new(),
                        },
                    ));
                    positions.len() - 1
                }
            };
            let mut found: Vec<(String, Point)> = Vec::new();
            let mut add = |name: String, o: &Json| -> Result<(), String> {
                let firsts = match o.get("firsts") {
                    Some(f) => firsts_from_json(f)?,
                    None => Vec::new(),
                };
                found.push((name.clone(), point_of(o, firsts, num(o, "secs"))));
                if let Some(Json::Arr(ms)) = o.get("marks") {
                    for m in ms {
                        let at = num(m, "at").unwrap_or(0.0) as usize;
                        let firsts = match m.get("firsts") {
                            Some(f) => firsts_from_json(f)?,
                            None => Vec::new(),
                        };
                        found.push((format!("{name}@{at}"), point_of(m, firsts, None)));
                    }
                }
                Ok(())
            };
            if let Some(r) = v.get("ref") {
                add(
                    if fi == 0 {
                        "ref".into()
                    } else {
                        format!("ref#{fi}")
                    },
                    r,
                )?;
            }
            if let Some(Json::Obj(vs)) = v.get("variants") {
                for (name, o) in vs {
                    add(name.clone(), o)?;
                }
            }
            for (name, pt) in found {
                let mi = index(&mut methods, name);
                let pts = &mut positions[pi].1.points;
                if pts.len() <= mi {
                    pts.resize_with(mi + 1, || None);
                }
                pts[mi] = Some(pt);
            }
        }
    }
    // 分かっている最善（全体と最初の手ごと）
    struct Known {
        best: f64,
        firsts: Vec<(String, f64)>,
    }
    let known: Vec<Known> = positions
        .iter()
        .map(|(_, pos)| {
            let mut best = f64::NEG_INFINITY;
            let mut firsts: Vec<(String, f64)> = Vec::new();
            for pt in pos.points.iter().flatten() {
                best = best.max(pt.best);
                for (f, x) in &pt.firsts {
                    match firsts.iter_mut().find(|(g, _)| g == f) {
                        Some(e) => e.1 = e.1.max(*x),
                        None => firsts.push((f.clone(), *x)),
                    }
                }
            }
            firsts.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            Known { best, firsts }
        })
        .collect();
    let counted: Vec<usize> = (0..positions.len())
        .filter(|&i| known[i].best.abs() < DECIDED)
        .collect();
    let wins: Vec<usize> = (0..positions.len())
        .filter(|&i| known[i].best >= DECIDED)
        .collect();
    println!(
        "{} 局面（分かっている最善が勝ち負けの点の {} 局面を除く。そのうち勝ち {} 局面）、方式 {}",
        counted.len(),
        positions.len() - counted.len(),
        wins.len(),
        methods.len()
    );
    let gap = |k: f64, x: f64| (k - x).clamp(0.0, GAP_CAP);
    let mut tsv_rows: Vec<String> = vec![
        "method\tat\treads\tscored\tpredicted\tms\tgap\tse\tworse\tworse3\ttop4gap\ttop4se\tinTop4\tsameFirst\tlethalMiss\tlethalMissBoth\tn"
            .into(),
    ];
    println!("方式: 読んだ局面（予想だけの局面があれば正確に採点した数）・ms | 差の平均 ± 標準誤差・劣る・3 点以上劣る | 上位 4 手の差の平均 ± | 最善の手が上位 4 手に入る・最善の手が同じ | 見逃したリーサル（リーサル探索も見逃す）");
    for (mi, name) in methods.iter().enumerate() {
        let get = |i: usize| positions[i].1.points.get(mi).and_then(|p| p.as_ref());
        let rs: Vec<usize> = counted
            .iter()
            .copied()
            .filter(|&i| get(i).is_some())
            .collect();
        if rs.is_empty() {
            continue;
        }
        let n = rs.len() as f64;
        let gaps: Vec<f64> = rs
            .iter()
            .map(|&i| gap(known[i].best, get(i).map_or(f64::NEG_INFINITY, |p| p.best)))
            .collect();
        let (m, se) = mean_se(&gaps);
        let worse = gaps.iter().filter(|&&g| g > 1e-6).count() as f64;
        let worse3 = gaps.iter().filter(|&&g| g >= 3.0).count() as f64;
        let mut top4: Vec<f64> = Vec::new();
        let mut in_top4 = 0usize;
        let mut same = 0usize;
        for &i in &rs {
            let pt = get(i).expect("rs は結果のある局面");
            let kf = &known[i].firsts;
            let mine = |f: &str| {
                pt.firsts
                    .iter()
                    .find(|(g, _)| g == f)
                    .map_or(f64::NEG_INFINITY, |x| x.1)
            };
            let ks: Vec<f64> = kf
                .iter()
                .take(4)
                .filter(|(_, x)| x.abs() < DECIDED)
                .map(|(f, x)| gap(*x, mine(f)))
                .collect();
            if !ks.is_empty() {
                top4.push(ks.iter().sum::<f64>() / ks.len() as f64);
            }
            // 最善の最初の手（分かっている最善と同じ点数の手が何通りもあれば、そのどれか）が、この方式の上位 4 手・1 位にあるか
            let mut order: Vec<&(String, f64)> = pt.firsts.iter().collect();
            order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let kv = |f: &str| {
                kf.iter()
                    .find(|(g, _)| g == f)
                    .map_or(f64::NEG_INFINITY, |x| x.1)
            };
            let best_first = |f: &str| kv(f) >= known[i].best - 1e-6;
            if order.iter().take(4).any(|(f, _)| best_first(f)) {
                in_top4 += 1;
            }
            if order.first().is_some_and(|(f, _)| best_first(f)) {
                same += 1;
            }
        }
        let (t4, t4se) = mean_se(&top4);
        let scored = rs
            .iter()
            .map(|&i| get(i).map_or(0.0, |p| p.scored))
            .sum::<f64>()
            / n;
        let predicted = rs
            .iter()
            .map(|&i| get(i).map_or(0.0, |p| p.predicted))
            .sum::<f64>()
            / n;
        let secs: Vec<f64> = rs
            .iter()
            .filter_map(|&i| get(i).and_then(|p| p.secs))
            .collect();
        let ms = if secs.is_empty() {
            None
        } else {
            Some(1000.0 * secs.iter().sum::<f64>() / secs.len() as f64)
        };
        let ws: Vec<usize> = wins.iter().copied().filter(|&i| get(i).is_some()).collect();
        let miss: Vec<usize> = ws
            .iter()
            .copied()
            .filter(|&i| get(i).is_some_and(|p| p.best < DECIDED))
            .collect();
        let miss_both = miss.iter().filter(|&&i| !positions[i].1.lethal).count();
        println!(
            "  {name}: {}{}・{} | {} ± {}・{}%・{}% | {} ± {} | {}%・{}% | {}/{}（{}）",
            fixed(scored + predicted, 0),
            if predicted > 0.0 {
                format!("（正確 {}）", fixed(scored, 0))
            } else {
                String::new()
            },
            ms.map_or("—".into(), |x| fixed(x, 1)),
            fixed(m, 3),
            fixed(se, 3),
            fixed(100.0 * worse / n, 1),
            fixed(100.0 * worse3 / n, 1),
            fixed(t4, 3),
            fixed(t4se, 3),
            fixed(100.0 * in_top4 as f64 / n, 1),
            fixed(100.0 * same as f64 / n, 1),
            miss.len(),
            ws.len(),
            miss_both
        );
        let (base, at) = match name.split_once('@') {
            Some((b, a)) => (b.to_string(), a.to_string()),
            None => (name.clone(), String::new()),
        };
        tsv_rows.push(format!(
            "{base}\t{at}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            fixed(scored + predicted, 1),
            fixed(scored, 1),
            fixed(predicted, 1),
            ms.map_or(String::new(), |x| fixed(x, 2)),
            fixed(m, 4),
            fixed(se, 4),
            fixed(worse / n, 4),
            fixed(worse3 / n, 4),
            fixed(t4, 4),
            fixed(t4se, 4),
            fixed(in_top4 as f64 / n, 4),
            fixed(same as f64 / n, 4),
            miss.len(),
            miss_both,
            rs.len()
        ));
    }
    // デッキごと・ターンごとの差の平均（予算ごとの途中を除く）
    let finals: Vec<(usize, &String)> = methods
        .iter()
        .enumerate()
        .filter(|(_, m)| !m.contains('@'))
        .collect();
    let breakdown = |title: &str, label: &dyn Fn(usize) -> String| {
        let mut keys: Vec<String> = Vec::new();
        for &i in &counted {
            let k = label(i);
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
        keys.sort();
        println!("{title}（差の平均）");
        for k in &keys {
            let rs: Vec<usize> = counted
                .iter()
                .copied()
                .filter(|&i| label(i) == *k)
                .collect();
            let parts: Vec<String> = finals
                .iter()
                .map(|&(mi, name)| {
                    let gs: Vec<f64> = rs
                        .iter()
                        .filter_map(|&i| {
                            let p = positions[i].1.points.get(mi).and_then(|p| p.as_ref())?;
                            Some(gap(known[i].best, p.best))
                        })
                        .collect();
                    format!(
                        "{name} {}",
                        fixed(gs.iter().sum::<f64>() / gs.len().max(1) as f64, 2)
                    )
                })
                .collect();
            println!("  {k}（{}）: {}", rs.len(), parts.join("、"));
        }
    };
    breakdown("デッキごと", &|i| positions[i].1.deck.clone());
    breakdown("ターンごと", &|i| {
        let t = positions[i].1.turn;
        match t {
            i32::MIN..=3 => "ターン 1〜3".into(),
            4..=6 => "ターン 4〜6".into(),
            7..=9 => "ターン 7〜9".into(),
            _ => "ターン 10〜".into(),
        }
    });
    if let Some(path) = &tsv {
        let mut w = std::fs::File::create(path).map_err(|e| format!("{path}: {e}"))?;
        for l in &tsv_rows {
            writeln!(w, "{l}").map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
