//! 融合を回した（コアを手札に残した）局面で、探索が手順を取りこぼすかを測る（2026-10-29）。
//!
//!   svwb fuse-gap --dir <記録のディレクトリ> [--opts '<設定の JSON>'] [--out 結果.jsonl] [--show 10]
//!
//! `svwb rhino-compare --subject af --record <ディレクトリ>` で書いた試合を打ち直し、AF ネメシスの側（ファイル名の席）の自分のターンの
//! 最初の局面ごとに、手札の作ったカードを素材のコアに戻した局面を作る（キャッスル → パスト・コア 2 枚、アタック → フューチャー・コア 2 枚、
//! α → パスト 2 枚＋フューチャー 1 枚、β・γ → パスト 2 枚＋フューチャー 2 枚）。融合は PP を使わないので、戻した局面からは
//! 元の局面の並び（先に融合して作り直してから同じ手を打つ）に届き、ターン末の点数の最大は元の局面以上になるはず。
//! 両方の局面を同じ設定のビーム（相手のターンは読まない。`turn_end_best`）で読み、見つかった並びの点数を比べる。
//! 戻した局面のほうが低ければ、その差はコアを残したことで探索が取りこぼした分。
//!
//! 作ったカードの無い局面、戻すと手札が上限を超える局面は飛ばす。融合済みの種類を持つ（α に β を融合した等）・手札で能力が変わった
//! 作ったカードは戻さない。遺産の砲撃が場にあると融合のたびにランダムにダメージが出て、その後の乱数も変わるので、その局面は印を付けて分けて数える。

use super::deep_gap::describe;
use super::human_plan::{is_start_of_turn, mean_se, step_text};
use super::options::compare_options;
use super::parallel::parallel_map;
use super::{fixed, seconds_since};
use crate::ai::search::SearchAgent;
use crate::data::{data, CardIdx};
use crate::game::{acting_player, apply_legal, create_game};
use crate::json::Json;
use crate::state::{card, Action, GameState, Phase, PlayerIndex, HAND_LIMIT};
use crate::state_json::{action_from_json, action_to_json};
use std::io::Write;
use std::time::Instant;

const FUTURE_CORE: &str = "90071210";
const PAST_CORE: &str = "90071220";
const SHELLING: &str = "10173210";

/// 作ったカードの id と、戻す素材（フューチャー・コアの数、パスト・コアの数）
const RECIPES: [(&str, usize, usize); 5] = [
    ("90072110", 2, 0), // アタックアーティファクト
    ("90072120", 0, 2), // キャッスルアーティファクト
    ("90073110", 1, 2), // デストロイアーティファクトα（キャッスル＋フューチャー）
    ("90073120", 2, 2), // デストロイアーティファクトβ（キャッスル＋フューチャー 2 枚）
    ("90073130", 2, 2), // デストロイアーティファクトγ（キャッスル＋アタック）
];

struct Start {
    file: String,
    decks: [String; 2],
    p: PlayerIndex,
    fused: GameState,
    unfused: GameState,
    products: Vec<String>,
    shelling: bool,
}

/// 局面 1 つの結果（スレッドの間で受け渡すので局面は持たない）
struct Row {
    file: String,
    turn: i32,
    products: Vec<String>,
    shelling: bool,
    f: Read,
    u: Read,
    desc: Vec<String>,
    plan_f: Vec<String>,
    plan_u: Vec<String>,
}

/// 手札の作ったカードを素材のコアに戻した局面と、戻したカードの名前（戻すものが無い・手札が上限を超えるなら None）
fn unfuse(s: &GameState, p: PlayerIndex) -> Option<(GameState, Vec<String>)> {
    let d = data();
    let (future, past) = (d.card_idx(FUTURE_CORE), d.card_idx(PAST_CORE));
    let recipe = |c: CardIdx| {
        RECIPES
            .iter()
            .find(|r| d.card_idx(r.0) == c)
            .map(|r| (r.1, r.2))
    };
    let mut u = s.clone();
    let mut hand = Vec::new();
    let mut names = Vec::new();
    for h in s.players[p].hand.iter() {
        let plain = h.fused_kinds.is_empty()
            && h.cost_mod == 0
            && h.attack_mod == 0
            && h.defense_mod == 0
            && h.boosts == 0
            && h.keywords.is_empty();
        match recipe(h.card).filter(|_| plain) {
            Some((nf, np)) => {
                names.push(card(h.card).name.clone());
                for c in std::iter::repeat_n(past, np).chain(std::iter::repeat_n(future, nf)) {
                    let mut core = u.new_hand_card(c, None);
                    core.revealed = true;
                    hand.push(core);
                }
            }
            None => hand.push(h.clone()),
        }
    }
    if names.is_empty() || hand.len() > HAND_LIMIT {
        return None;
    }
    *u.players[p].hand.make_mut() = hand;
    Some((u, names))
}

fn str_of(v: &Json, key: &str) -> Result<f64, String> {
    match v.get(key) {
        Some(Json::Num(x)) => Ok(*x),
        _ => Err(format!("{key} がありません")),
    }
}

/// 記録 1 つの、AF ネメシスの側の自分のターンの最初の局面（戻せるものだけ）
fn starts_of(path: &std::path::Path) -> Result<Vec<Start>, String> {
    let file = path
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("")
        .to_string();
    let seat: PlayerIndex = file
        .strip_suffix(".json")
        .and_then(|f| f.rsplit_once("-s"))
        .and_then(|(_, s)| s.parse().ok())
        .ok_or_else(|| format!("{file}: ファイル名に席がありません"))?;
    let text = std::fs::read_to_string(path).map_err(|e| format!("{file}: {e}"))?;
    let g = Json::parse(&text)?;
    let seed = str_of(&g, "seed")? as u32;
    let d = data();
    let deck = |i: usize| -> Result<Vec<CardIdx>, String> {
        match g.get("decks") {
            Some(Json::Arr(ds)) => match ds.get(i) {
                Some(Json::Arr(cs)) => cs
                    .iter()
                    .map(|c| match c {
                        Json::Str(id) => Ok(d.card_idx(id)),
                        _ => Err(format!("{file}: デッキのカードが文字列ではありません")),
                    })
                    .collect(),
                _ => Err(format!("{file}: デッキがありません")),
            },
            _ => Err(format!("{file}: decks がありません")),
        }
    };
    let decks = [deck(0)?, deck(1)?];
    let name_of = |cs: &[CardIdx]| {
        d.decks
            .iter()
            .find(|x| x.cards == cs)
            .map_or("?".to_string(), |x| x.name.clone())
    };
    let names = [name_of(&decks[0]), name_of(&decks[1])];
    let Some(Json::Arr(actions)) = g.get("actions") else {
        return Err(format!("{file}: actions がありません"));
    };
    let shelling = d.card_idx(SHELLING);
    let mut s = create_game([&decks[0], &decks[1]], seed);
    let mut last_turn = -1;
    let mut out = Vec::new();
    for a in actions {
        let a = action_from_json(a)?;
        let p = s.active;
        if p == seat
            && s.phase == Phase::Main
            && is_start_of_turn(&s)
            && acting_player(&s) == p
            && s.players[p].turn_count != last_turn
        {
            last_turn = s.players[p].turn_count;
            if let Some((u, products)) = unfuse(&s, p) {
                out.push(Start {
                    file: file.clone(),
                    decks: names.clone(),
                    p,
                    shelling: s.players[p].board.iter().any(|b| b.card == shelling),
                    fused: s.clone(),
                    unfused: u,
                    products,
                });
            }
        }
        s = apply_legal(&s, &a);
    }
    Ok(out)
}

struct Read {
    value: f64,
    actions: Vec<Action>,
    terminals: usize,
    secs: f64,
}

fn read(agent: &SearchAgent, s: &GameState, p: PlayerIndex) -> Read {
    let t0 = Instant::now();
    let (value, actions, _, terminals) = agent
        .turn_end_best(s, p)
        .expect("ターンの最初の局面に並びがありません");
    Read {
        value,
        actions,
        terminals,
        secs: seconds_since(t0),
    }
}

/// 並びの手の説明
fn plan_text(root: &GameState, actions: &[Action], p: PlayerIndex) -> Vec<String> {
    let mut s = root.clone();
    let mut out = Vec::new();
    for a in actions {
        out.push(step_text(&s, a, p));
        s = apply_legal(&s, a);
    }
    out
}

fn fuses(actions: &[Action]) -> usize {
    actions
        .iter()
        .filter(|a| matches!(a, Action::Fuse { .. }))
        .count()
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mut dir = String::new();
    let mut opts_text = "{}".to_string();
    let mut out_path: Option<String> = None;
    let mut show = 10usize;
    let mut i = 0;
    while i < argv.len() {
        let v = argv.get(i + 1).cloned().ok_or("引数の値がありません")?;
        match argv[i].as_str() {
            "--dir" => dir = v,
            "--opts" => opts_text = v,
            "--out" => out_path = Some(v),
            "--show" => show = v.parse().map_err(|_| "--show は数")?,
            k => return Err(format!("不明な引数: {k}")),
        }
        i += 2;
    }
    if dir.is_empty() {
        return Err("使い方: svwb fuse-gap --dir <記録のディレクトリ> [--opts …] [--out …] [--show 10]（runner/fuse_gap.rs）".into());
    }
    let opts = compare_options(&opts_text)?;
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{dir}: {e}"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let t0 = Instant::now();
    let per_file = parallel_map(
        &files,
        |f, _| -> Result<Vec<Row>, String> {
            let agent = SearchAgent::new(opts.clone());
            Ok(starts_of(f)?
                .into_iter()
                .map(|st| {
                    let f = read(&agent, &st.fused, st.p);
                    let u = read(&agent, &st.unfused, st.p);
                    Row {
                        turn: st.fused.players[st.p].turn_count,
                        desc: describe(&st.fused, st.p, &st.decks),
                        plan_f: plan_text(&st.fused, &f.actions, st.p),
                        plan_u: plan_text(&st.unfused, &u.actions, st.p),
                        file: st.file,
                        products: st.products,
                        shelling: st.shelling,
                        f,
                        u,
                    }
                })
                .collect())
        },
        |done, total, _, _| {
            if done % 10 == 0 || done == total {
                eprintln!("{done}/{total} 試合 {}s", fixed(seconds_since(t0), 0));
            }
        },
    );
    let mut rows: Vec<Row> = Vec::new();
    for r in per_file {
        rows.extend(r?);
    }
    let mut out = match &out_path {
        Some(p) => Some(std::fs::File::create(p).map_err(|e| format!("{p}: {e}"))?),
        None => None,
    };
    for r in &rows {
        let (f, u) = (&r.f, &r.u);
        if let Some(w) = out.as_mut() {
            let acts = |r: &Read| Json::Arr(r.actions.iter().map(action_to_json).collect());
            let line = Json::Obj(vec![
                ("file".into(), Json::Str(r.file.clone())),
                ("turn".into(), Json::Num(r.turn as f64)),
                (
                    "products".into(),
                    Json::Arr(r.products.iter().cloned().map(Json::Str).collect()),
                ),
                ("shelling".into(), Json::Bool(r.shelling)),
                ("fused".into(), Json::Num(f.value)),
                ("unfused".into(), Json::Num(u.value)),
                ("gap".into(), Json::Num(f.value - u.value)),
                ("fusedLen".into(), Json::Num(f.actions.len() as f64)),
                ("unfusedLen".into(), Json::Num(u.actions.len() as f64)),
                ("fusedTerminals".into(), Json::Num(f.terminals as f64)),
                ("unfusedTerminals".into(), Json::Num(u.terminals as f64)),
                ("fusedSecs".into(), Json::Num(f.secs)),
                ("unfusedSecs".into(), Json::Num(u.secs)),
                ("fusedActions".into(), acts(f)),
                ("unfusedActions".into(), acts(u)),
            ]);
            writeln!(w, "{}", line.stringify()).map_err(|e| e.to_string())?;
        }
    }
    // まとめ
    let summarize = |label: &str, keep: &dyn Fn(&Row) -> bool| {
        let rs: Vec<&Row> = rows.iter().filter(|r| keep(r)).collect();
        if rs.is_empty() {
            return;
        }
        let gaps: Vec<f64> = rs.iter().map(|r| r.f.value - r.u.value).collect();
        let (m, se) = mean_se(&gaps);
        let count = |c: &dyn Fn(f64) -> bool| gaps.iter().filter(|&&g| c(g)).count();
        let mean = |f: &dyn Fn(&Row) -> f64| rs.iter().map(|r| f(r)).sum::<f64>() / rs.len() as f64;
        let deep = |r: &Read| r.actions.len() >= opts.max_depth;
        println!(
            "{label}: {} 局面、差（元 − 戻した）平均 {} ± {}、戻したほうが 0.5 以上低い {}・2 以上低い {}・0.5 以上高い {}",
            rs.len(),
            fixed(m, 2),
            fixed(se, 2),
            count(&|g| g >= 0.5),
            count(&|g| g >= 2.0),
            count(&|g| g <= -0.5),
        );
        println!(
            "  並びの手の数 元 {}・戻した {}（深さ {} に達した 元 {}・戻した {}）、融合の数 元 {}・戻した {}、読む時間 元 {}s・戻した {}s",
            fixed(mean(&|r| r.f.actions.len() as f64), 2),
            fixed(mean(&|r| r.u.actions.len() as f64), 2),
            opts.max_depth,
            rs.iter().filter(|r| deep(&r.f)).count(),
            rs.iter().filter(|r| deep(&r.u)).count(),
            fixed(mean(&|r| fuses(&r.f.actions) as f64), 2),
            fixed(mean(&|r| fuses(&r.u.actions) as f64), 2),
            fixed(mean(&|r| r.f.secs), 3),
            fixed(mean(&|r| r.u.secs), 3),
        );
    };
    println!(
        "設定 {opts_text}、{} 試合、{}s",
        files.len(),
        fixed(seconds_since(t0), 0)
    );
    summarize("全部", &|_| true);
    summarize("遺産の砲撃が場に無い", &|r| !r.shelling);
    summarize("遺産の砲撃が場にある", &|r| r.shelling);
    for name in ["キャッスル", "アタック", "α", "β", "γ"] {
        summarize(&format!("{name} を戻した"), &|r| {
            r.products.iter().any(|p| p.contains(name))
        });
    }
    let mut order: Vec<&Row> = rows.iter().collect();
    order.sort_by(|a, b| {
        (b.f.value - b.u.value)
            .partial_cmp(&(a.f.value - a.u.value))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for r in order.into_iter().take(show) {
        println!(
            "\n=== {} {} ターン目、差 {}（元 {}・戻した {}）、戻した: {}{}",
            r.file,
            r.turn,
            fixed(r.f.value - r.u.value, 2),
            fixed(r.f.value, 2),
            fixed(r.u.value, 2),
            r.products.join("、"),
            if r.shelling {
                "、遺産の砲撃あり"
            } else {
                ""
            }
        );
        for l in &r.desc {
            println!("  {l}");
        }
        println!("  元の局面の並び:");
        for l in &r.plan_f {
            println!("    {l}");
        }
        println!("  戻した局面の並び:");
        for l in &r.plan_u {
            println!("    {l}");
        }
    }
    Ok(())
}
