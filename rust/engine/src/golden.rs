//! 振る舞いが変わっていないかのテスト（ゴールデンテスト。tests/golden.rs と `svwb golden`）。
//!
//! 決まった組み合わせ・シードの試合を打ち、その結果を tests/golden/*.txt に保存したものと比べる。
//! TypeScript 版のエンジン・AI を消す前に、TypeScript 版と同じ結果になることを差分テストで確かめてから保存した。
//!
//! - engine-*: ランダムな手で打つ試合（src/sim.rs の play_random）。1 試合 1 行で「試合 手番の数 勝者 ハッシュ」。
//!   ハッシュは、手番ごとの局面・合法手の一覧・ターン終了時の処理だけを行った局面（engine-json は局面の JSON）のハッシュをつないだもののハッシュ
//! - ai-*: AI どうしの試合（src/sim.rs の play_ai）。1 試合 1 行で「試合 勝者 行動の列」
//!
//! ルールや AI を意図して変えたときは `svwb golden write` で保存し直し、変わった試合を確かめてからコミットする。

use crate::ai::exact_lethal::reset_exact_lethal_cache;
use crate::ai::lethal::reset_lethal;
use crate::ai::registry::create_agent;
use crate::ai::rhino::{rhino_lethal_bound, search_lethal_for_rhino_turn};
use crate::ai::rhino_lethal::{tag, Tag};
use crate::ai::Agent;
use crate::canonical::{action_canon, fnv, state_canon};
use crate::game::resolve_turn_end;
use crate::json::Json;
use crate::sim::{play_ai, play_random};
use crate::state::{Action, GameState, Phase};
use crate::state_json::{state_from_json, state_to_json};

/// 保存する試合の組
pub struct GoldenSet {
    pub name: &'static str,
    pub games: u32,
    kind: Kind,
}

enum Kind {
    /// ランダムな手（random_decks: ランダムなデッキ、json: 局面の JSON を比べる）
    Engine { random_decks: bool, json: bool },
    /// AI どうし（probe: エルフの手番ごとにリノセウスのリーサル探索も行う）
    Ai { agent: &'static str, probe: bool },
}

pub const SETS: [GoldenSet; 10] = [
    GoldenSet {
        name: "engine-default",
        games: 1000,
        kind: Kind::Engine {
            random_decks: false,
            json: false,
        },
    },
    GoldenSet {
        name: "engine-random",
        games: 1000,
        kind: Kind::Engine {
            random_decks: true,
            json: false,
        },
    },
    GoldenSet {
        name: "engine-json",
        games: 300,
        kind: Kind::Engine {
            random_decks: true,
            json: true,
        },
    },
    GoldenSet {
        name: "ai-search",
        games: 14,
        kind: Kind::Ai {
            agent: "search",
            probe: false,
        },
    },
    GoldenSet {
        name: "ai-search-classic",
        games: 4,
        kind: Kind::Ai {
            agent: "search-classic",
            probe: false,
        },
    },
    GoldenSet {
        name: "ai-rhino",
        games: 6,
        kind: Kind::Ai {
            agent: "rhino",
            probe: true,
        },
    },
    GoldenSet {
        name: "ai-rhino-lethal",
        games: 4,
        kind: Kind::Ai {
            agent: "rhino-lethal",
            probe: false,
        },
    },
    GoldenSet {
        name: "ai-greedy",
        games: 20,
        kind: Kind::Ai {
            agent: "greedy",
            probe: false,
        },
    },
    GoldenSet {
        name: "ai-greedy-base",
        games: 10,
        kind: Kind::Ai {
            agent: "greedy-base",
            probe: false,
        },
    },
    GoldenSet {
        name: "ai-random",
        games: 10,
        kind: Kind::Ai {
            agent: "random",
            probe: false,
        },
    },
];

/// 手番の局面・合法手の一覧・ターン終了時の処理だけを行った局面
pub fn step_canon(s: &GameState, legal: &[Action]) -> String {
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

/// 局面の JSON（項目を名前順）。読み込んで書き出し直しても同じで、同じ局面に戻ることも確かめる（違えば Err）
pub fn json_round_trip(s: &GameState) -> Result<String, String> {
    let j = state_to_json(s);
    let c = j.canonical();
    let back = state_from_json(&Json::parse(&j.stringify())?)?;
    if state_to_json(&back).canonical() != c {
        return Err(format!("読み込んで書き出すと変わる: {c}"));
    }
    if state_canon(&back) != state_canon(s) {
        return Err(format!("読み込むと別の局面になる: {}", state_canon(&back)));
    }
    Ok(c)
}

/// 相手の体力をリノセウスの上限の式の値にした局面でのリーサル探索の結果（"?" に続けて手順、無ければ "?-"）
pub fn probe(s: &GameState, elf: usize) -> Option<String> {
    if s.phase != Phase::Main || s.active != elf || s.pending.is_some() {
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
pub fn ai_game(g: u32, kind: &str, with_probe: bool) -> (Vec<String>, Option<usize>) {
    let new = || create_agent(kind).unwrap_or_else(|| panic!("未知の AI: {kind}"));
    let (mut a, mut b): (Box<dyn Agent>, Box<dyn Agent>) = (new(), new());
    let mut agents: [&mut dyn Agent; 2] = [a.as_mut(), b.as_mut()];
    let mut log = Vec::new();
    let elf = (g % 2) as usize;
    let end = play_ai(g, kind.starts_with("rhino"), &mut agents, |s, act| {
        log.push(action_canon(act));
        if with_probe {
            if let Some(p) = probe(s, elf) {
                log.push(p);
            }
        }
    });
    (log, end.winner)
}

fn winner(w: Option<usize>) -> String {
    w.map(|x| x.to_string()).unwrap_or_else(|| "null".into())
}

/// ランダムな手で試合 g を打った結果の行（局面の JSON が読み込み直せなければ Err）
pub fn engine_line(g: u32, random_decks: bool, json: bool) -> Result<String, String> {
    let mut hashes = Vec::new();
    let mut err = None;
    let end = play_random(g, random_decks, |step, s, legal| {
        if err.is_some() {
            return;
        }
        let c = if json {
            match json_round_trip(s) {
                Ok(c) => c,
                Err(e) => {
                    err = Some(format!("試合 {g} の手番 {step}: {e}"));
                    return;
                }
            }
        } else {
            step_canon(s, legal)
        };
        hashes.push(fnv(&c));
    });
    if let Some(e) = err {
        return Err(e);
    }
    Ok(format!(
        "{g} {} {} {}",
        hashes.len(),
        winner(end.winner),
        fnv(&hashes.join(" "))
    ))
}

/// 1 試合分の行
pub fn line(set: &GoldenSet, g: u32) -> Result<String, String> {
    match set.kind {
        Kind::Engine { random_decks, json } => engine_line(g, random_decks, json),
        Kind::Ai { agent, probe } => {
            let (log, w) = ai_game(g, agent, probe);
            Ok(format!("{g} {} {}", winner(w), log.join(" ")))
        }
    }
}

/// 組の全試合の行（AI のメモは組の始めに捨てる。どの順に組を打っても同じ結果になる）
pub fn lines(set: &GoldenSet) -> Result<Vec<String>, String> {
    reset_exact_lethal_cache();
    reset_lethal();
    (0..set.games).map(|g| line(set, g)).collect()
}

/// 保存した行と比べる（食い違えば、最初に食い違った試合を Err で返す）
pub fn check(set: &GoldenSet, expected: &str) -> Result<(), String> {
    let actual = lines(set)?;
    let expected: Vec<&str> = expected.lines().filter(|l| !l.is_empty()).collect();
    for (i, a) in actual.iter().enumerate() {
        match expected.get(i) {
            Some(e) if e == a => {}
            Some(e) => {
                let (at, now, saved) = first_diff(a, e);
                return Err(format!(
                    "{}: 試合 {i} が保存した結果と違います（{at} 番目の項目が 今 {now}、保存 {saved}）",
                    set.name
                ));
            }
            None => return Err(format!("{}: 試合 {i} が保存されていません", set.name)),
        }
    }
    if expected.len() != actual.len() {
        return Err(format!(
            "{}: 保存した試合の数が違います（今 {}、保存 {}）",
            set.name,
            actual.len(),
            expected.len()
        ));
    }
    Ok(())
}

/// 空白で区切った項目のうち、最初に違うもの（番号は 0 から。行の先頭は試合の番号）
fn first_diff<'a>(a: &'a str, b: &'a str) -> (usize, &'a str, &'a str) {
    let (x, y): (Vec<&str>, Vec<&str>) = (a.split(' ').collect(), b.split(' ').collect());
    let i = (0..x.len().max(y.len()))
        .find(|&i| x.get(i) != y.get(i))
        .unwrap_or(0);
    let end = "（終わり）";
    (
        i,
        x.get(i).copied().unwrap_or(end),
        y.get(i).copied().unwrap_or(end),
    )
}
