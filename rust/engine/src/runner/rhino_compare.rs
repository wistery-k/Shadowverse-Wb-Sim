//! デッキ専用の AI・探索 AI の設定を変えたときの勝率（TypeScript 版 scripts/rhino-compare-main.ts。npm run rhino-compare 等と同じ試合・同じ出力）。
//!
//!   svwb rhino-compare [--subject rhino|af|spellwitch|bishop|dragon|nightmare|royal] [--games 50] [--start 0]
//!                      [--agent rhino|rhino-lethal|search|search-classic] [--opts '<設定JSON>'] [--out 結果.jsonl] [--matches 試合.jsonl]
//!                      [--opp search-classic|search]
//!
//! 比べるデッキ vs 他の 6 デッキ（相手は学習した補正を入れる前の探索 AI。--opp search なら今の既定の探索 AI）を、両方の席で同じシードで打つ
//! （試合の決め方は src/sim/humanCompare.ts）。序盤のターンを全探索する "exhaustive" は TypeScript 版とともに消した。

use super::options::{rhino_compare_options, rhino_options, search_options};
use super::parallel::parallel_map;
use super::{compare_decks, fixed, seconds_since, Tally};
use crate::ai::exact_lethal::exact_lethal_counts;
use crate::ai::registry::search_classic_options;
use crate::ai::rhino::RhinoAgent;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::Agent;
use crate::data::{data, Deck};
use crate::json::Json;
use crate::sim::play_match;
use crate::state::{card, Action};
use std::time::Instant;

/// 比べるデッキ（src/sim/humanCompare.ts の SUBJECTS）: id、デッキ名、既定の AI、シードの基準
pub(crate) const SUBJECTS: [(&str, &str, &str, u32); 7] = [
    ("rhino", "リノセウスエルフ", "rhino", 900000),
    ("af", "AFネメシス", "search", 800000),
    ("spellwitch", "スペルウィッチ", "search", 700000),
    ("bishop", "アミュレット疾走ビショップ", "search", 600000),
    ("dragon", "疾走ドラゴン", "search", 500000),
    ("nightmare", "ミッドレンジナイトメア", "search", 400000),
    ("royal", "アマリアロイヤル", "search", 300000),
];

const ARIA: &str = "自然の妖精姫・アリア";
const JEANNE: &str = "純白の聖女・ジャンヌ";
/// フォロワーを出すカウントダウンのアミュレットから出るフォロワー（ホーリーファルコンはフェザーレインでも出るので数えない）
const AMULET_TOKENS: [&str; 2] = ["ホーリーフレイムタイガー", "壮麗なる隼"];

/// 比べるデッキの AI の設定
#[derive(Clone)]
#[allow(clippy::large_enum_variant)]
enum AgentConfig {
    Rhino {
        rhino_eval: bool,
        search: SearchOptions,
        plain: SearchOptions,
    },
    Search(SearchOptions),
}

impl AgentConfig {
    fn create(&self) -> Box<dyn Agent> {
        match self {
            AgentConfig::Rhino {
                rhino_eval,
                search,
                plain,
            } => Box::new(RhinoAgent::with_options(
                *rhino_eval,
                search.clone(),
                plain.clone(),
            )),
            AgentConfig::Search(o) => Box::new(SearchAgent::new(o.clone())),
        }
    }
}

struct Task {
    deck: String,
    g: u32,
    seat: usize,
}

struct Outcome {
    won: bool,
    aria_turn: Option<i32>,
    jeanne: u32,
    jeanne_tokens: u32,
    exact_found: u32,
}

struct Given {
    deck: String,
    g: u32,
    seat: usize,
    won: Option<bool>,
}

/// --matches のファイル（JSON Lines。各行に deck・g・seat（古い形式は elfSeat）、あれば subject・won・opponent）。
/// 人間が打った相手（opponent。無ければ "yardstick"）が、ここで打つ相手と同じ行だけを使う:
/// --opp search-classic（物差しと同じ手を指す）なら "yardstick"、--opp search（今の既定の探索 AI）なら "latest"
fn read_matches(file: &str, subject: &str, opponent: &str) -> Result<Vec<Given>, String> {
    let text = std::fs::read_to_string(file).map_err(|e| format!("{file} を読めません: {e}"))?;
    let mut out = Vec::new();
    let mut skipped = 0;
    for (i, line) in text
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .enumerate()
    {
        let v = Json::parse(line)?;
        let seat = v.get("seat").or_else(|| v.get("elfSeat"));
        let (Some(Json::Str(deck)), Some(Json::Num(g)), Some(Json::Num(seat))) =
            (v.get("deck"), v.get("g"), seat)
        else {
            return Err(format!(
                "{file} の {} 行目に deck・g・seat がありません",
                i + 1
            ));
        };
        if !(*seat == 0.0 || *seat == 1.0) || *g < 0.0 || g.fract() != 0.0 {
            return Err(format!(
                "{file} の {} 行目に deck・g・seat がありません",
                i + 1
            ));
        }
        let line_subject = match v.get("subject") {
            None => "rhino".to_string(),
            Some(Json::Str(s)) => s.clone(),
            Some(x) => x.stringify(),
        };
        if line_subject != subject {
            return Err(format!(
                "{file} の {} 行目は {line_subject} の試合です（--subject {subject}）",
                i + 1
            ));
        }
        let played = match v.get("opponent") {
            None => "yardstick",
            Some(Json::Str(s)) => s.as_str(),
            Some(_) => "",
        };
        if played != opponent {
            skipped += 1;
            continue;
        }
        let won = match v.get("won") {
            Some(Json::Bool(b)) => Some(*b),
            _ => None,
        };
        out.push(Given {
            deck: deck.clone(),
            g: *g as u32,
            seat: *seat as usize,
            won,
        });
    }
    if skipped > 0 {
        eprintln!("{file} のうち相手が {opponent} 以外の {skipped} 試合は飛ばします");
    }
    Ok(out)
}

fn hand_name(
    s: &crate::state::GameState,
    p: usize,
    iid: crate::state::Iid,
) -> Option<&'static str> {
    s.players[p]
        .hand
        .iter()
        .find(|h| h.iid == iid)
        .map(|h| card(h.card).name.as_str())
}

fn play_one(
    subject: &(&str, &str, &str, u32),
    me: &'static Deck,
    opp: &'static Deck,
    t: &Task,
    agent: &AgentConfig,
    opp_options: &SearchOptions,
) -> Outcome {
    let (subject_id, _, _, seed_base) = *subject;
    let seed = seed_base + t.g * 13 + t.seat as u32;
    let mut a = agent.create();
    let mut o = SearchAgent::new(opp_options.clone());
    let decks = if t.seat == 0 {
        [&me.cards[..], &opp.cards[..]]
    } else {
        [&opp.cards[..], &me.cards[..]]
    };
    let mut aria_turn: Option<i32> = None;
    let (mut jeanne, mut jeanne_tokens) = (0, 0);
    let seat = t.seat;
    let visit = |s: &crate::state::GameState, act: &Action| {
        let Action::Play(iid) = act else { return };
        if s.active != seat || s.pending.is_some() {
            return;
        }
        let name = hand_name(s, seat, *iid);
        // アリアを最初に出した自分のターン
        if aria_turn.is_none() && name == Some(ARIA) {
            aria_turn = Some(s.players[seat].turn_count);
        }
        // ビショップ: ジャンヌを出した回数と、そのときアミュレットから出たフォロワーが場にいた回数
        if subject_id == "bishop" && name == Some(JEANNE) {
            jeanne += 1;
            if s.players[seat]
                .board
                .iter()
                .any(|c| AMULET_TOKENS.contains(&card(c.card).name.as_str()))
            {
                jeanne_tokens += 1;
            }
        }
    };
    let end = if seat == 0 {
        play_match(
            &mut [a.as_mut(), &mut o as &mut dyn Agent],
            decks,
            seed,
            visit,
        )
    } else {
        play_match(
            &mut [&mut o as &mut dyn Agent, a.as_mut()],
            decks,
            seed,
            visit,
        )
    };
    let winner = end
        .winner
        .unwrap_or_else(|| panic!("勝者がいません（{} g{} 席{seat}）", t.deck, t.g));
    Outcome {
        won: winner == seat,
        aria_turn,
        jeanne,
        jeanne_tokens,
        exact_found: exact_lethal_counts().1,
    }
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mut games: u32 = 50;
    let mut start: u32 = 0;
    let mut out: Option<String> = None;
    let mut agent_key: Option<String> = None;
    let mut subject = SUBJECTS[0];
    let mut matches: Option<String> = None;
    let mut opts_text: Option<String> = None;
    let mut opp_key = "search-classic".to_string();
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
            "--out" => out = Some(v.clone()),
            "--agent" => agent_key = Some(v.clone()),
            "--matches" => matches = Some(v.clone()),
            "--subject" => {
                subject = *SUBJECTS.iter().find(|s| s.0 == v).ok_or_else(|| {
                    format!(
                        "--subject は {} のどれか: {v}",
                        SUBJECTS.iter().map(|s| s.0).collect::<Vec<_>>().join(" / ")
                    )
                })?
            }
            "--opts" => opts_text = Some(v.clone()),
            "--opp" => opp_key = v.clone(),
            _ => return Err(format!("不明な引数: {key}")),
        }
    }
    let (opts, model) = rhino_compare_options(opts_text.as_deref().unwrap_or("{}"))?;
    let agent_key = agent_key.unwrap_or_else(|| subject.2.to_string());
    // --opts は rhino・rhino-lethal・search のときだけ使う
    let agent = match agent_key.as_str() {
        "rhino" | "rhino-lethal" => {
            let (search, plain) = rhino_options(&opts, model.as_ref())?;
            AgentConfig::Rhino { rhino_eval: agent_key == "rhino", search, plain }
        }
        "search" => AgentConfig::Search(search_options(&opts, model.as_ref(), SearchOptions::default(), &["potential"])?),
        "search-classic" => AgentConfig::Search(search_classic_options()),
        _ => return Err(format!("Rust 版で使える --agent は rhino / rhino-lethal / search / search-classic: {agent_key}")),
    };
    // 相手の AI（既定は人間の記録と比べられるよう search-classic）
    let opp_options = match opp_key.as_str() {
        "search-classic" => search_classic_options(),
        "search" => SearchOptions::default(),
        _ => return Err(format!("--opp は search-classic / search: {opp_key}")),
    };
    let me: &'static Deck = data()
        .decks
        .iter()
        .find(|d| d.name == subject.1)
        .ok_or_else(|| format!("{} がありません", subject.1))?;
    let opponents: Vec<&'static Deck> = compare_decks()
        .into_iter()
        .filter(|d| d.name != subject.1)
        .collect();
    let given = match &matches {
        Some(file) => Some(read_matches(
            file,
            subject.0,
            if opp_key == "search" {
                "latest"
            } else {
                "yardstick"
            },
        )?),
        None => None,
    };
    let tasks: Vec<Task> = match &given {
        Some(given) => given
            .iter()
            .map(|m| Task {
                deck: m.deck.clone(),
                g: m.g,
                seat: m.seat,
            })
            .collect(),
        None => opponents
            .iter()
            .flat_map(|o| {
                (0..games).flat_map(move |k| {
                    [0, 1].map(|seat| Task {
                        deck: o.name.clone(),
                        g: start + k,
                        seat,
                    })
                })
            })
            .collect(),
    };
    for t in &tasks {
        if !opponents.iter().any(|o| o.name == t.deck) {
            return Err(format!("相手デッキがありません: {}", t.deck));
        }
    }
    let t0 = Instant::now();
    let results = parallel_map(
        &tasks,
        |t, _| {
            let opp = *opponents
                .iter()
                .find(|o| o.name == t.deck)
                .expect("相手デッキ");
            play_one(&subject, me, opp, t, &agent, &opp_options)
        },
        |_, _, _, _| {},
    );
    let n = results.len();
    let mut per_deck = Tally::default();
    for (t, r) in tasks.iter().zip(&results) {
        per_deck.add(&t.deck, r.won);
    }
    let wins = results.iter().filter(|r| r.won).count();
    println!(
        "{} agent {agent_key} opts {}{}: {wins}/{n} = {}%  {}s/試合",
        subject.1,
        opts.stringify(),
        if opp_key == "search-classic" {
            String::new()
        } else {
            format!(" opp {opp_key}")
        },
        fixed((wins as f64 / n as f64) * 100.0, 1),
        fixed(seconds_since(t0) / n.max(1) as f64, 2)
    );
    if subject.0 == "bishop" {
        let jeanne: u32 = results.iter().map(|r| r.jeanne).sum();
        let tokens: u32 = results.iter().map(|r| r.jeanne_tokens).sum();
        println!(
            "ジャンヌを出した回数 {jeanne}、そのうちアミュレットから出たフォロワー（{}）が場にいた回数 {tokens}",
            AMULET_TOKENS.join("・")
        );
    }
    if subject.0 == "rhino" {
        let aria: Vec<i32> = results.iter().filter_map(|r| r.aria_turn).collect();
        let aria_wins = results
            .iter()
            .filter(|r| r.aria_turn.is_some() && r.won)
            .count();
        let sum: f64 = aria.iter().fold(0.0, |x, &y| x + y as f64);
        println!(
            "アリアを出した試合 {}/{n}（そのうち勝ち {aria_wins}）、最初に出した自分のターン 平均 {}",
            aria.len(),
            fixed(sum / aria.len().max(1) as f64, 2)
        );
    }
    println!("{}", per_deck.line());
    let exact: Vec<&Outcome> = results.iter().filter(|r| r.exact_found > 0).collect();
    println!(
        "全探索でリーサルを見つけた試合 {}/{n}（そのうち勝ち {}）",
        exact.len(),
        exact.iter().filter(|r| r.won).count()
    );
    if let Some(given) = &given {
        let human_wins = given.iter().filter(|m| m.won == Some(true)).count();
        println!(
            "同じ試合の --matches の勝ち {human_wins}/{} = {}%",
            given.len(),
            fixed((human_wins as f64 / given.len().max(1) as f64) * 100.0, 1)
        );
        for (m, r) in given.iter().zip(&results) {
            let human = match m.won {
                None => "-",
                Some(true) => "勝ち",
                Some(false) => "負け",
            };
            println!(
                "  {} g={} 席{}: {human} / AI {}",
                m.deck,
                m.g,
                m.seat,
                if r.won { "勝ち" } else { "負け" }
            );
        }
    }
    if let Some(out) = out {
        let mut text = String::new();
        for (t, r) in tasks.iter().zip(&results) {
            let line = Json::Obj(vec![
                ("subject".into(), Json::Str(subject.0.into())),
                ("deck".into(), Json::Str(t.deck.clone())),
                ("g".into(), Json::Num(t.g as f64)),
                ("seat".into(), Json::Num(t.seat as f64)),
                ("won".into(), Json::Bool(r.won)),
                ("exactFound".into(), Json::Num(r.exact_found as f64)),
            ]);
            text.push_str(&line.stringify());
            text.push('\n');
        }
        std::fs::write(&out, text).map_err(|e| format!("{out} に書けません: {e}"))?;
    }
    Ok(())
}
