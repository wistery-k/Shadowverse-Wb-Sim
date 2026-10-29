//! 回した融合を、その場でした場合と最後まで打ち比べる（2026-10-29）。
//!
//!   svwb defer-playout --dir <記録のディレクトリ> --opts '<回す版の設定>' [--cont '<分かれ目の後の自分の設定>'] [--seeds 8] [--seedBase 0] [--out 結果.jsonl]
//!
//! `svwb rhino-compare --subject af --record <ディレクトリ>` で書いた、融合を回す版（`deferFuse`）の試合を打ち直し、
//! AF ネメシスの側（ファイル名の席）がターン終了を打った局面ごとに、`--opts` から `deferFuse` だけを外した AI に同じ局面から打たせる。
//! その AI がターン終了まで融合だけを打つなら、それが回した融合。「そのままターンを終える（回す）」と「その融合をしてからターンを終える」の
//! 2 つの筋を、同じ乱数（相手の手札・山札の並べ直しと AI の乱数）で `--seeds` 通り最後まで打ち、勝ち数を比べる。
//! 分かれ目の後は、自分を `--cont`（既定は `--opts`）、相手を今の既定の探索 AI で打つ。
//! 融合以外の手を打つ局面は数えるだけ。並べ直した局面で融合を打てなかった回数も出す（0 のはず）。
//!
//! 局面ごとの結果を `--out` に試合が終わった順に書き（途中で止まってもそれまでの分が残る）、最後にまとめ（全部・試合ごとの合計・
//! その場で作るはずだったカード・実際の次のターンに作ったカード・相手のデッキ・PP ごとの勝ちの差）を出す。

use super::human_plan::{mean_se, step_text};
use super::options::compare_options;
use super::parallel::parallel_map;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::{Agent, Rng};
use crate::data::{data, CardIdx};
use crate::game::{acting_player, apply_action, apply_legal, create_game, is_legal, legal_actions};
use crate::json::Json;
use crate::state::{card, Action, GameState, Phase, PlayerIndex};
use crate::state_json::action_from_json;
use std::collections::BTreeMap;
use std::io::Write;

/// 1 つの局面の結果（まとめ用）
struct Row {
    file: String,
    deck: String,
    pp: i32,
    products: Vec<String>,
    next_made: Vec<String>,
    /// 融合だけでなかった（打ち比べていない）
    other: bool,
    seeds: u32,
    wins_defer: u32,
    wins_fuse: u32,
    illegal: u32,
}

fn jstr(v: &[String]) -> String {
    let items: Vec<String> = v
        .iter()
        .map(|x| format!("\"{}\"", x.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    format!("[{}]", items.join(","))
}

/// 手札に新しく入ったカード（iid とカードの組で比べる）の名前
fn made(before: &GameState, after: &GameState, p: PlayerIndex) -> Vec<String> {
    after.players[p]
        .hand
        .iter()
        .filter(|h| {
            !before.players[p]
                .hand
                .iter()
                .any(|b| b.iid == h.iid && b.card == h.card)
        })
        .map(|h| card(h.card).name.clone())
        .collect()
}

/// 局面 start（p の番）から forced を打ち、残りを最後まで。p が勝ったか、forced をすべて打てたか
fn playout(
    start: &GameState,
    forced: &[Action],
    me: &SearchOptions,
    seed: u32,
    p: PlayerIndex,
) -> (bool, bool) {
    let mut rng = Rng::new(seed);
    let mut s = crate::ai::determinize::determinize(start, p, &mut rng, false);
    let mut all = true;
    for a in forced {
        if s.phase == Phase::Ended || !is_legal(&s, a) {
            all = false;
            break;
        }
        s = apply_legal(&s, a);
    }
    let mut mine = SearchAgent::new(me.clone());
    let mut theirs = SearchAgent::new(SearchOptions::default());
    let mut rng = Rng::new(seed ^ 0x9e3779b9);
    let mut n = 0;
    while s.phase != Phase::Ended && n < 10000 {
        n += 1;
        let legal = legal_actions(&s);
        let a = if acting_player(&s) == p {
            mine.choose_action(&s, &legal, &mut rng)
        } else {
            theirs.choose_action(&s, &legal, &mut rng)
        };
        s = apply_action(&s, &a);
    }
    (s.winner == Some(p), all)
}

/// 1 試合の記録の、回した局面ごとの結果（JSON 行とまとめ用）
fn run_file(
    path: &std::path::Path,
    my: &SearchOptions,
    cont: &SearchOptions,
    seeds: u32,
    base: u32,
) -> Result<Vec<(String, Row)>, String> {
    let file = path
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("")
        .to_string();
    let p: PlayerIndex = file
        .strip_suffix(".json")
        .and_then(|f| f.rsplit_once("-s"))
        .and_then(|(_, s)| s.parse().ok())
        .ok_or("ファイル名に席がありません")?;
    let deck_name = file.split("-g").next().unwrap_or("").to_string();
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let g = Json::parse(&text)?;
    let seed = match g.get("seed") {
        Some(Json::Num(x)) => *x as u32,
        _ => return Err("seed がありません".into()),
    };
    let won = matches!(g.get("winner"), Some(Json::Num(x)) if *x as usize == p);
    let d = data();
    let deck = |k: usize| -> Vec<CardIdx> {
        match g.get("decks") {
            Some(Json::Arr(ds)) => match ds.get(k) {
                Some(Json::Arr(cs)) => cs
                    .iter()
                    .filter_map(|c| match c {
                        Json::Str(id) => Some(d.card_idx(id)),
                        _ => None,
                    })
                    .collect(),
                _ => vec![],
            },
            _ => vec![],
        }
    };
    let decks = [deck(0), deck(1)];
    let Some(Json::Arr(actions)) = g.get("actions") else {
        return Err("actions がありません".into());
    };
    let actions: Vec<Action> = actions
        .iter()
        .map(action_from_json)
        .collect::<Result<_, _>>()?;
    let fusing = SearchOptions {
        defer_fuse: false,
        ..my.clone()
    };
    let mut states = vec![create_game([&decks[0], &decks[1]], seed)];
    for a in &actions {
        let next = apply_legal(states.last().unwrap(), a);
        states.push(next);
    }
    let mut out = Vec::new();
    for (idx, a) in actions.iter().enumerate() {
        let e = &states[idx];
        if !(matches!(a, Action::EndTurn)
            && e.phase == Phase::Main
            && e.pending.is_none()
            && e.active == p
            && acting_player(e) == p)
        {
            continue;
        }
        // 回さない AI がこの局面から打つ手（ターン終了まで融合だけならその並び）
        let mut ag = SearchAgent::new(fusing.clone());
        let mut rng = Rng::new(1);
        let mut t = e.clone();
        let mut fuses = Vec::new();
        let mut other = None;
        for _ in 0..12 {
            let legal = legal_actions(&t);
            let b = ag.choose_action(&t, &legal, &mut rng);
            match b {
                Action::Fuse { .. } => {
                    t = apply_legal(&t, &b);
                    fuses.push(b);
                }
                Action::EndTurn => break,
                x => {
                    other = Some(step_text(&t, &x, p));
                    break;
                }
            }
        }
        if fuses.is_empty() && other.is_none() {
            continue;
        }
        let products = made(e, &t, p);
        // 実際の試合の次の自分のターンに、融合で作ったカードと出したカード
        let mut next_made = Vec::new();
        let mut next_played = Vec::new();
        let mut k = idx + 1;
        while k < actions.len() && !(states[k].active == p && states[k].phase == Phase::Main) {
            k += 1;
        }
        while k < actions.len() && states[k].active == p && states[k].phase != Phase::Ended {
            let s = &states[k];
            match &actions[k] {
                Action::Fuse { .. } => next_made.extend(made(s, &states[k + 1], p)),
                Action::Play(iid) => {
                    if let Some(h) = s.players[p].hand.iter().find(|h| h.iid == *iid) {
                        next_played.push(card(h.card).name.clone());
                    }
                }
                Action::EndTurn => break,
                _ => {}
            }
            k += 1;
        }
        let (mut wd, mut wf, mut bad) = (0u32, 0u32, 0u32);
        if other.is_none() {
            let mut forced = fuses.clone();
            forced.push(Action::EndTurn);
            for j in 0..seeds {
                let sd = 1000 + (base + j) * 7919;
                let (w, ok) = playout(e, &[Action::EndTurn], cont, sd, p);
                wd += w as u32;
                bad += !ok as u32;
                let (w, ok) = playout(e, &forced, cont, sd, p);
                wf += w as u32;
                bad += !ok as u32;
            }
        }
        let pl = &e.players[p];
        let hand: Vec<String> = pl.hand.iter().map(|h| card(h.card).name.clone()).collect();
        let line = format!(
            "{{\"file\":\"{file}\",\"won\":{won},\"turn\":{},\"pp\":{},\"handLen\":{},\"hand\":{},\"fuses\":{},\"products\":{},\"other\":{},\"nextMade\":{},\"nextPlayed\":{},\"seeds\":{seeds},\"seedBase\":{base},\"winsDefer\":{wd},\"winsFuse\":{wf},\"illegal\":{bad}}}",
            pl.turn_count,
            pl.max_pp,
            pl.hand.len(),
            jstr(&hand),
            fuses.len(),
            jstr(&products),
            other.as_ref().map_or("null".to_string(), |o| jstr(std::slice::from_ref(o))),
            jstr(&next_made),
            jstr(&next_played),
        );
        out.push((
            line,
            Row {
                file: file.clone(),
                deck: deck_name.clone(),
                pp: pl.max_pp,
                products,
                next_made,
                other: other.is_some(),
                seeds,
                wins_defer: wd,
                wins_fuse: wf,
                illegal: bad,
            },
        ));
    }
    Ok(out)
}

/// その場で作るはずだったカードの分け方
fn product_kind(r: &Row) -> String {
    match r.products.as_slice() {
        [one] if one.contains('Ω') => "Ω".into(),
        [one] if one.contains("デストロイ") => "α・β・γ".into(),
        [one] => one.replace("アーティファクト", ""),
        _ => "2 枚以上".into(),
    }
}

/// 実際の次のターンに作ったカードの分け方
fn next_kind(r: &Row) -> &'static str {
    if r.next_made.is_empty() {
        return "次のターンに融合しない";
    }
    let mut left = r.next_made.clone();
    for p in &r.products {
        match left.iter().position(|x| x == p) {
            Some(i) => {
                left.remove(i);
            }
            None => return "次のターンに別のカードを作る",
        }
    }
    "次のターンに同じカードを作る"
}

fn print_group(title: &str, rows: &[&Row], key: impl Fn(&Row) -> String) {
    println!("{title}");
    let mut by: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for r in rows {
        by.entry(key(r)).or_default().push(diff(r));
    }
    for (k, xs) in by {
        print_line(&k, &xs);
    }
}

fn diff(r: &Row) -> f64 {
    (r.wins_defer as f64 - r.wins_fuse as f64) / r.seeds as f64
}

fn print_line(name: &str, xs: &[f64]) {
    let (m, se) = mean_se(xs);
    let pos = xs.iter().filter(|&&x| x > 0.0).count();
    let neg = xs.iter().filter(|&&x| x < 0.0).count();
    println!(
        "  {name}: {} 局面、回す − その場で融合 {:+.1} ± {:.1} ポイント（回すほうが勝つ {pos}・負ける {neg}）",
        xs.len(),
        100.0 * m,
        100.0 * se
    );
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mut dir = String::new();
    let mut out_path = String::new();
    let mut opts = "{}".to_string();
    let mut cont_opts = String::new();
    let mut seeds = 8u32;
    let mut base = 0u32;
    let mut k = 0;
    while k + 1 < argv.len() {
        match argv[k].as_str() {
            "--dir" => dir = argv[k + 1].clone(),
            "--out" => out_path = argv[k + 1].clone(),
            "--opts" => opts = argv[k + 1].clone(),
            "--cont" => cont_opts = argv[k + 1].clone(),
            "--seeds" => seeds = argv[k + 1].parse().map_err(|_| "--seeds は数")?,
            "--seedBase" => base = argv[k + 1].parse().map_err(|_| "--seedBase は数")?,
            x => return Err(format!("不明な引数 {x}")),
        }
        k += 2;
    }
    if dir.is_empty() || seeds == 0 {
        return Err("--dir と 1 以上の --seeds が要ります".into());
    }
    let my = compare_options(&opts)?;
    let cont = if cont_opts.is_empty() {
        my.clone()
    } else {
        compare_options(&cont_opts)?
    };
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let t0 = std::time::Instant::now();
    let mut w = if out_path.is_empty() {
        None
    } else {
        Some(std::fs::File::create(&out_path).map_err(|e| e.to_string())?)
    };
    let results = parallel_map(
        &files,
        |f, _| run_file(f, &my, &cont, seeds, base),
        |done, total, r: &Result<Vec<(String, Row)>, String>, _| {
            if let (Some(w), Ok(rows)) = (w.as_mut(), r) {
                for (line, _) in rows {
                    let _ = writeln!(w, "{line}");
                }
                let _ = w.flush();
            }
            if done % 10 == 0 || done == total {
                eprintln!("{done}/{total} {:.0}s", t0.elapsed().as_secs_f64());
            }
        },
    );
    let mut rows = Vec::new();
    for r in results {
        rows.extend(r?.into_iter().map(|(_, row)| row));
    }
    let played: Vec<&Row> = rows.iter().filter(|r| !r.other).collect();
    println!(
        "{} 試合、回した局面 {}（融合以外の手を打つ局面 {}）、乱数 {seeds} 通り、並べ直した局面で融合を打てなかった {} 回",
        files.len(),
        played.len(),
        rows.len() - played.len(),
        played.iter().map(|r| r.illegal).sum::<u32>()
    );
    print_line("全部", &played.iter().map(|r| diff(r)).collect::<Vec<_>>());
    // 試合ごとの合計（回した局面の無い試合も 0 として数える）
    let mut per_game: BTreeMap<String, f64> = files
        .iter()
        .filter_map(|f| {
            f.file_name()
                .and_then(|x| x.to_str())
                .map(|x| (x.to_string(), 0.0))
        })
        .collect();
    for r in &played {
        *per_game.entry(r.file.clone()).or_default() += diff(r);
    }
    let (m, se) = mean_se(&per_game.values().copied().collect::<Vec<_>>());
    println!(
        "試合ごとの合計: {:+.1} ± {:.1} ポイント（{} 試合）",
        100.0 * m,
        100.0 * se,
        per_game.len()
    );
    print_group("その場で作るはずだったカード", &played, product_kind);
    print_group("実際の次のターン", &played, |r| {
        next_kind(r).to_string()
    });
    print_group("相手のデッキ", &played, |r| r.deck.clone());
    print_group("PP", &played, |r| {
        let lo = r.pp.min(10) / 2 * 2;
        format!("{lo:>2}〜{:>2}", lo + 1)
    });
    Ok(())
}
