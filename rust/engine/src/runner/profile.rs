//! 対戦の速さの計測（定期的なプロファイリング）。比較用の 7 デッキの総当たりを探索 AI どうしで打ち、
//! デッキごとの 1 試合の時間と、思考の処理ごとの時間の内訳を出す。
//!
//!   svwb profile [--games 49] [--start 0] [--opts '<設定JSON>'] [--rhino] [--decks <デッキ>,…|@<デッキの組>] [--check] [--log <フォルダ>] [--json 結果.json]
//!                [--baseline 測らないビルドの結果.json] [--report 報告.md] [--label 名前] [--record]
//!
//! - --check なら、手を打つたびに局面の不変条件（invariants.rs）を確かめ、破った局面を報告に並べる（1 つでもあれば終わりにエラーを返す）
//! - 報告には、デッキ（名前の「（」の前が同じものは型にまとめる）ごとの勝率と、仕組み（アクセラレート・結晶・エンハンス・奥義・進化・
//!   超進化・融合・アクト・エクストラPP・攻撃）を使った回数も出す。--log <フォルダ> なら、1 試合ずつ手の並びを文章で書く（試合を読むため）
//! - --decks なら、比較用の 7 デッキの代わりに並べたデッキで打つ（compare --decks と同じ組とシード。n デッキなら --games n² で全部の組）。
//!   --record とは一緒に使えない（docs/profile.md の表の列は 7 デッキ）
//! - 試合は compare と同じデッキの組で、試合番号ごとに席とデッキを入れ替えて 2 試合打つ（両方の席が同じ設定。
//!   シードは compare --no-mirror と同じ）。--games 49 で 7×7 のデッキの組（同じデッキどうしも含む）を 2 回ずつ、98 試合
//! - --opts は compare の設定と同じ形（`{}` で今の探索 AI の既定）。--rhino ならリノセウスエルフはリノセウス用 AI（rhino）で打つ
//!   （ブラウザの AI対戦・自動対戦と同じ。--opts はリノセウス用 AI には効かない）
//! - 処理ごとの内訳は `--features profile` でビルドしたときだけ測る（src/prof.rs）。測るビルドは少し遅いので、
//!   --baseline に測らないビルドの --json を渡すと、時間の表はそちらの値を使い、内訳だけを測るビルドから取る
//!   （同じ試合になったかも確かめる）。npm run profile（scripts/profile.mjs）が両方を続けて回す
//! - --record で docs/profile.md の表に 1 行足す（--label で名前を付ける）
//! - 時間は試合を打ったスレッドの経過時間。並列数（THREADS）・CPU で変わるので、比べるときは同じ環境の行どうしで比べる

use super::compare::{compare_setup, deck_options};
use super::deck_compare::read_deck_list;
use super::deep_gap::describe;
use super::human_plan::step_text;
use super::options::compare_options;
use super::parallel::{parallel_map, thread_count};
use super::yardstick::{command_line, commit_label_excluding, short_name};
use super::{compare_decks, fixed};
use crate::ai::rhino::RhinoAgent;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::Agent;
use crate::data::{CardIdx, CardType, Deck};
use crate::game::{acting_player, apply_action, create_game, legal_actions, play_as, play_cost};
use crate::invariants::invariant_violations;
use crate::prof::{self, Profile, Sec};
use crate::sim::MatchRng;
use crate::state::{card, Action, GameState, Phase, PlayerIndex};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Instant;

/// 1 試合の記録
struct GameRecord {
    g: u32,
    swap: bool,
    decks: [String; 2],
    turns: i32,
    actions: u32,
    winner: Option<usize>,
    /// 試合の経過時間（秒）
    secs: f64,
    /// 席ごとの思考の時間（秒）
    think: [f64; 2],
    /// 席ごとの手番の数（choose_action を呼んだ数）
    decisions: [u32; 2],
    /// 席ごとの処理の内訳
    prof: [Profile; 2],
    /// 席ごとの自分のターンの数（考えたターン）
    own_turns: [u32; 2],
    /// 時間の長かった手番（長い順に SLOW_PER_GAME まで）
    slow: Vec<SlowDecision>,
    /// 不変条件を破った局面（--check。1 試合で最初の 5 つまで）
    violations: Vec<String>,
    /// 席ごとの仕組みを使った回数（USAGE の順）
    usage: [[u32; USAGE.len()]; 2],
    /// 席ごとの、最初に進化・超進化した自分のターン（0 はしなかった）
    first: [[u32; 2]; 2],
    /// 手の並びの文章（--log）
    log: Vec<String>,
    /// 席ごとの、プレイできるカードがあって PP も残っているのにターンを終えた数と、そのときに残した PP の合計
    idle: [[u32; 2]; 2],
    /// 席ごとの、そのとき（idle）にプレイできたカード（1 ターンに同じカードは 1 回）
    idle_cards: [Vec<CardIdx>; 2],
    /// 先攻の席
    first_seat: usize,
}

/// 仕組みを使った回数の列（tally が数える）
const USAGE: [&str; 13] = [
    "プレイ",
    "アクセラレート",
    "結晶",
    "エンハンス",
    "奥義",
    "解放奥義",
    "進化",
    "超進化",
    "融合",
    "アクト",
    "エクストラPP",
    "リーダーへの攻撃",
    "フォロワーへの攻撃",
];

/// 手 a を打つ前の局面 s で、席 p が使った仕組みを数える。アクセラレート・結晶はプレイしたときの姿が違うもの、エンハンスは
/// エンハンスのコストを払ったもの、奥義・解放奥義は【奥義】を持つカードを奥義ゲージ 10 以上・15 以上でプレイしたもの
/// （効果が奥義の条件を見るかによらない）
fn tally(u: &mut [u32; USAGE.len()], s: &GameState, a: &Action, p: PlayerIndex) {
    let pl = &s.players[p];
    let col = |name: &str| USAGE.iter().position(|x| *x == name).expect("列");
    match a {
        Action::Play(iid) => {
            u[col("プレイ")] += 1;
            let Some(h) = pl.hand.iter().find(|h| h.iid == *iid) else {
                return;
            };
            let c = card(h.card);
            match play_as(h, pl.pp) {
                Some(f) if f != h.card => {
                    u[col(if card(f).ctype == CardType::Spell {
                        "アクセラレート"
                    } else {
                        "結晶"
                    })] += 1
                }
                _ if c.enhance.is_some_and(|e| play_cost(c, pl.pp, Some(h)) == e) => {
                    u[col("エンハンス")] += 1
                }
                _ => {}
            }
            if c.ougi {
                let gauge = pl.turn_count + h.ougi;
                if gauge >= 15 {
                    u[col("解放奥義")] += 1;
                } else if gauge >= 10 {
                    u[col("奥義")] += 1;
                }
            }
        }
        Action::Evolve(_) => u[col("進化")] += 1,
        Action::SuperEvolve(_) => u[col("超進化")] += 1,
        Action::Fuse { .. } => u[col("融合")] += 1,
        Action::Act(_) => u[col("アクト")] += 1,
        Action::ExtraPp => u[col("エクストラPP")] += 1,
        Action::Attack { target: None, .. } => u[col("リーダーへの攻撃")] += 1,
        Action::Attack { .. } => u[col("フォロワーへの攻撃")] += 1,
        _ => {}
    }
}

/// デッキの型（名前の「（」の前。デッキの組のファイルの名前は「型（大会）」）
fn archetype(name: &str) -> &str {
    name.split('（').next().unwrap_or(name)
}

/// 「PP を残して終えたときにプレイできたカード」の表に出す枚数
const IDLE_TOP: usize = 8;

/// 1 試合で残す、時間の長かった手番の数
const SLOW_PER_GAME: usize = 3;

/// 時間の長かった手番（どの局面で考え込んだか）
#[derive(Clone)]
struct SlowDecision {
    g: u32,
    swap: bool,
    seat: usize,
    /// 考えた側が先攻か
    first: bool,
    deck: String,
    turn: i32,
    secs: f64,
    legal: usize,
    hand: usize,
    board: [usize; 2],
    pp: i32,
    choosing: bool,
}

impl GameRecord {
    fn to_json(&self) -> Value {
        json!({
            "g": self.g,
            "swap": self.swap,
            "decks": self.decks,
            "turns": self.turns,
            "actions": self.actions,
            "winner": self.winner,
            "seconds": self.secs,
            "think": self.think,
            "decisions": self.decisions,
        })
    }
}

/// 測らないビルドの結果の 1 試合（--baseline）
struct BaseGame {
    decks: [String; 2],
    actions: u32,
    winner: Option<usize>,
    secs: f64,
    think: [f64; 2],
}

fn make_agent(opts: &SearchOptions, deck: &Deck, rhino: bool) -> Box<dyn Agent> {
    if rhino && deck.name == "リノセウスエルフ" {
        Box::new(RhinoAgent::new(true))
    } else {
        Box::new(SearchAgent::new(deck_options(opts, deck)))
    }
}

/// 試合番号 g（swap で席とデッキを入れ替えた方）を打って時間を測る（sim::play_match と同じ手順・乱数の使い方）
fn play_timed(
    opts: &SearchOptions,
    rhino: bool,
    decks: &[&'static Deck],
    g: u32,
    swap: bool,
    check: bool,
    log: bool,
) -> GameRecord {
    let (_, seats, seed) = compare_setup(decks, g, swap, false);
    let mut agents = [
        make_agent(opts, seats[0], rhino),
        make_agent(opts, seats[1], rhino),
    ];
    let _ = prof::take();
    let t0 = Instant::now();
    let mut s = create_game([&seats[0].cards, &seats[1].cards], seed);
    let mut rng = MatchRng::new(seed);
    let mut think = [0.0; 2];
    let mut decisions = [0u32; 2];
    let mut profs: [Profile; 2] = Default::default();
    let mut actions = 0u32;
    let mut own_turns = [0u32; 2];
    let mut last_turn = [-1i32; 2];
    let mut slow: Vec<SlowDecision> = Vec::new();
    let mut violations: Vec<String> = Vec::new();
    let mut usage = [[0u32; USAGE.len()]; 2];
    let mut idle = [[0u32; 2]; 2];
    let mut idle_cards: [Vec<CardIdx>; 2] = Default::default();
    let mut first = [[0u32; 2]; 2];
    let names = [seats[0].name.clone(), seats[1].name.clone()];
    let mut lines: Vec<String> = Vec::new();
    while s.phase != Phase::Ended {
        actions += 1;
        assert!(
            actions <= 10000,
            "アクション数が上限 10000 を超えました（シード {seed}）"
        );
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        let t = Instant::now();
        let a = {
            let _p = prof::scope(Sec::Think);
            rng.choose(&mut *agents[actor], &s, &legal)
        };
        let secs = t.elapsed().as_secs_f64();
        think[actor] += secs;
        decisions[actor] += 1;
        if s.phase != Phase::Mulligan && last_turn[actor] != s.turn {
            last_turn[actor] = s.turn;
            own_turns[actor] += 1;
            if log {
                lines.push(String::new());
                lines.push(format!(
                    "## ターン {}・席 {actor}（{}）の自分のターン {}",
                    s.turn, names[actor], own_turns[actor]
                ));
                lines.extend(describe(&s, actor, &names));
            }
        }
        if log {
            lines.push(format!(
                "- {}{}",
                step_text(&s, &a, actor),
                if secs >= 0.5 {
                    format!("（{} 秒）", fixed(secs, 1))
                } else {
                    String::new()
                }
            ));
        }
        tally(&mut usage[actor], &s, &a, actor);
        let pp = s.players[actor].pp;
        if a == Action::EndTurn && pp > 0 && legal.iter().any(|x| matches!(x, Action::Play(_))) {
            idle[actor][0] += 1;
            idle[actor][1] += pp as u32;
            let pl = &s.players[actor];
            let mut cs: Vec<CardIdx> = legal
                .iter()
                .filter_map(|x| match x {
                    Action::Play(iid) => pl.hand.iter().find(|h| h.iid == *iid).map(|h| h.card),
                    _ => None,
                })
                .collect();
            cs.sort_unstable();
            cs.dedup();
            idle_cards[actor].extend(cs);
        }
        let evolved = match a {
            Action::Evolve(_) => Some(0),
            Action::SuperEvolve(_) => Some(1),
            _ => None,
        };
        if let Some(k) = evolved.filter(|&k| first[actor][k] == 0) {
            first[actor][k] = own_turns[actor];
        }
        if slow.len() < SLOW_PER_GAME || slow.last().is_some_and(|x| x.secs < secs) {
            let pl = &s.players[actor];
            slow.push(SlowDecision {
                g,
                swap,
                seat: actor,
                first: s.first == actor,
                deck: seats[actor].name.clone(),
                turn: s.turn,
                secs,
                legal: legal.len(),
                hand: pl.hand.len(),
                board: [pl.board.len(), s.players[1 - actor].board.len()],
                pp: pl.pp,
                choosing: s.pending.is_some(),
            });
            slow.sort_by(|a, b| b.secs.total_cmp(&a.secs));
            slow.truncate(SLOW_PER_GAME);
        }
        if prof::ENABLED {
            prof::merge(&mut profs[actor], &prof::take());
        }
        s = apply_action(&s, &a);
        if check && violations.len() < 5 {
            for m in invariant_violations(&s) {
                violations.push(format!(
                    "g{g}{}・{actions} 手目（ターン {}、{a:?} の後）: {m}",
                    if swap { "（入れ替え）" } else { "" },
                    s.turn
                ));
            }
        }
    }
    GameRecord {
        g,
        swap,
        decks: [seats[0].name.clone(), seats[1].name.clone()],
        turns: s.turn,
        actions,
        winner: s.winner,
        secs: t0.elapsed().as_secs_f64(),
        think,
        decisions,
        prof: profs,
        own_turns,
        slow,
        violations,
        usage,
        first,
        log: lines,
        idle,
        idle_cards,
        first_seat: s.first,
    }
}

/// CPU の名前（Linux の /proc/cpuinfo。読めなければ "?"）
fn cpu_name() -> String {
    std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|t| {
            t.lines()
                .find(|l| l.starts_with("model name"))
                .and_then(|l| l.split(':').nth(1))
                .map(|x| x.split_whitespace().collect::<Vec<_>>().join(" "))
        })
        .unwrap_or_else(|| "?".into())
}

fn path_key(path: &[Sec]) -> String {
    path.iter().map(|s| s.key()).collect::<Vec<_>>().join("/")
}

fn read_baseline(path: &str) -> Result<BTreeMap<(u32, bool), BaseGame>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path} を読めません: {e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    let games = v["games"]
        .as_array()
        .ok_or_else(|| format!("{path}: games がありません"))?;
    let mut out = BTreeMap::new();
    for x in games {
        let num = |k: &str| {
            x[k].as_f64()
                .ok_or_else(|| format!("{path}: {k} がありません"))
        };
        let name = |i: usize| x["decks"][i].as_str().unwrap_or("").to_string();
        out.insert(
            (num("g")? as u32, x["swap"].as_bool().unwrap_or(false)),
            BaseGame {
                decks: [name(0), name(1)],
                actions: num("actions")? as u32,
                winner: x["winner"].as_u64().map(|w| w as usize),
                secs: num("seconds")?,
                think: [
                    x["think"][0].as_f64().unwrap_or(0.0),
                    x["think"][1].as_f64().unwrap_or(0.0),
                ],
            },
        );
    }
    Ok(out)
}

/// デッキごとの集計
#[derive(Default, Clone)]
struct DeckStat {
    /// そのデッキが出た試合の数（同じデッキどうしは 1 試合で 2 席）
    seats: u32,
    games: u32,
    think: f64,
    game_secs: f64,
    decisions: u32,
    turns: i64,
    /// 自分のターンの数（席ごとの合計）
    own_turns: u32,
    prof: Profile,
    /// 勝った席の数（引き分けは数えない）
    wins: u32,
    /// 仕組みを使った回数（席ごとの合計）
    usage: [u64; USAGE.len()],
    /// 最初に進化・超進化した自分のターンの合計と、した席の数
    first_sum: [u64; 2],
    first_n: [u32; 2],
    /// プレイできるカードがあって PP も残っているのにターンを終えた数と、残した PP の合計
    idle_turns: u32,
    idle_pp: u64,
    /// そのときにプレイできたカードと回数
    idle_cards: BTreeMap<CardIdx, u32>,
}

impl DeckStat {
    /// 1 席分（試合 r の席 seat）を足す。試合の数・時間・ターンは、同じデッキどうしの試合を 1 試合と数えるので別に足す
    fn add_seat(&mut self, r: &GameRecord, seat: usize, think: f64) {
        self.seats += 1;
        self.think += think;
        self.decisions += r.decisions[seat];
        self.own_turns += r.own_turns[seat];
        prof::merge(&mut self.prof, &r.prof[seat]);
        self.wins += u32::from(r.winner == Some(seat));
        for (x, &n) in self.usage.iter_mut().zip(&r.usage[seat]) {
            *x += n as u64;
        }
        self.idle_turns += r.idle[seat][0];
        self.idle_pp += r.idle[seat][1] as u64;
        for &c in &r.idle_cards[seat] {
            *self.idle_cards.entry(c).or_insert(0) += 1;
        }
        for k in 0..2 {
            if r.first[seat][k] > 0 {
                self.first_sum[k] += r.first[seat][k] as u64;
                self.first_n[k] += 1;
            }
        }
    }

    fn add_game(&mut self, secs: f64, turns: i32) {
        self.games += 1;
        self.game_secs += secs;
        self.turns += turns as i64;
    }
}

/// 内訳の木の 1 つの節（path の時間・回数と、子）
fn children_of<'a>(p: &'a Profile, path: &[Sec]) -> Vec<(&'a Vec<Sec>, [u64; 2])> {
    let mut v: Vec<(&Vec<Sec>, [u64; 2])> = p
        .iter()
        .filter(|(k, _)| k.len() == path.len() + 1 && k.starts_with(path))
        .map(|(k, v)| (k, *v))
        .collect();
    v.sort_by(|a, b| b.1[0].cmp(&a.1[0]));
    v
}

fn ns_of(p: &Profile, path: &[Sec]) -> u64 {
    p.get(path).map_or(0, |v| v[0])
}

fn pct(x: u64, total: u64) -> String {
    if total == 0 {
        return "-".into();
    }
    format!("{}%", fixed(x as f64 / total as f64 * 100.0, 1))
}

/// 処理の種類ごとの [自分の時間（子を除く）, 含む時間（同じ種類の入れ子は外側だけ）, 回数]
fn flat(p: &Profile) -> BTreeMap<Sec, [u64; 3]> {
    let mut out: BTreeMap<Sec, [u64; 3]> = BTreeMap::new();
    for (k, v) in p {
        let sec = *k.last().expect("空の入れ子");
        let child: u64 = p
            .iter()
            .filter(|(c, _)| c.len() == k.len() + 1 && c.starts_with(k))
            .map(|(_, cv)| cv[0])
            .sum();
        let e = out.entry(sec).or_insert([0, 0, 0]);
        e[0] += v[0].saturating_sub(child);
        if !k[..k.len() - 1].contains(&sec) {
            e[1] += v[0];
        }
        e[2] += v[1];
    }
    out
}

/// 思考の直下の処理の分け方（デッキごとの内訳の表の列）
const TOP: [(Sec, &str); 4] = [
    (Sec::Mulligan, "マリガン"),
    (Sec::Lethal, "リーサル探索"),
    (Sec::Beam, "自分のターンのビーム"),
    (Sec::Rescore, "読み直し（相手のターン）"),
];

fn deck_breakdown(p: &Profile) -> (u64, Vec<u64>, u64) {
    let total = ns_of(p, &[Sec::Think]);
    let parts: Vec<u64> = TOP
        .iter()
        .map(|(s, _)| ns_of(p, &[Sec::Think, *s]))
        .collect();
    let other = total.saturating_sub(parts.iter().sum::<u64>());
    (total, parts, other)
}

struct Summary {
    opts_text: String,
    rhino: bool,
    start: u32,
    games: u32,
    threads: usize,
    cpu: String,
    profiled: bool,
    /// 時間を --baseline（測らないビルド）から取ったか（測るビルドで --baseline を渡したとき）
    from_baseline: bool,
    /// この実行の思考の時間 / --baseline の思考の時間
    ratio: Option<f64>,
    /// 思考の時間が長い順
    decks: Vec<(String, DeckStat)>,
    /// 型ごと（デッキより型が少ないときだけ。思考の時間が長い順）
    groups: Vec<(String, DeckStat)>,
    /// 記録の表の列の順（比較用の 7 デッキの順）
    deck_order: Vec<String>,
    all: DeckStat,
    total_games: u32,
    /// 時間の長かった手番（全試合で長い順）
    slow: Vec<SlowDecision>,
    /// --check で不変条件を確かめたか、破った局面
    check: Option<Vec<String>>,
}

fn report(sm: &Summary, date: &str, commit: &str, label: &str) -> String {
    let mut out = String::new();
    let push = |out: &mut String, s: &str| {
        out.push_str(s);
        out.push('\n');
    };
    push(&mut out, "# 対戦の速さ（svwb profile）");
    push(&mut out, "");
    push(
        &mut out,
        &format!(
            "- {date}・コミット {commit}{}",
            if label.is_empty() {
                String::new()
            } else {
                format!("・{label}")
            }
        ),
    );
    push(
        &mut out,
        &format!(
            "- 設定: `{}`{}（両方の席が同じ設定）",
            sm.opts_text,
            if sm.rhino {
                "、リノセウスエルフはリノセウス用 AI"
            } else {
                ""
            }
        ),
    );
    push(
        &mut out,
        &format!(
            "- 試合: {}（g{}〜{} の席とデッキを入れ替えた 2 試合ずつ）、並列 {}、CPU {}",
            sm.total_games,
            sm.start,
            sm.start + sm.games - 1,
            sm.threads,
            sm.cpu
        ),
    );
    match (sm.from_baseline, sm.ratio) {
        (true, Some(o)) => push(
            &mut out,
            &format!(
                "- 時間は測らないビルド、内訳は測るビルド（`--features profile`）から。測るビルドは思考の時間が {} 倍",
                fixed(o, 2)
            ),
        ),
        (false, Some(o)) => push(
            &mut out,
            &format!(
                "- 思考の時間は --baseline の {} 倍（同じ試合になったことを確かめた）{}",
                fixed(o, 2),
                if sm.profiled {
                    "。時間も内訳も測るビルドから"
                } else {
                    "。内訳は無し"
                }
            ),
        ),
        _ if sm.profiled => push(
            &mut out,
            "- 時間も内訳も測るビルド（`--features profile`）から（測る分だけ長めに出る）",
        ),
        _ => push(
            &mut out,
            "- 測らないビルドなので内訳は無し（`npm run profile` なら内訳も出る）",
        ),
    }
    push(&mut out, "");
    push(&mut out, "## デッキごとの 1 試合の時間");
    push(&mut out, "");
    push(
        &mut out,
        "思考は、そのデッキを持った側が 1 試合で考えた時間。試合は、そのデッキが出た試合の両者の合計（同じデッキどうしの試合も 1 試合と数える）。",
    );
    push(&mut out, "");
    push(
        &mut out,
        "| デッキ | 席 | 思考（秒/試合） | 1 ターン（ミリ秒） | 1 手（ミリ秒） | 手番/試合 | 試合（秒） | ターン/試合 |",
    );
    push(
        &mut out,
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    let row = |name: &str, d: &DeckStat| {
        let seats = d.seats.max(1) as f64;
        let games = d.games.max(1) as f64;
        format!(
            "| {name} | {} | **{}** | {} | {} | {} | {} | {} |",
            d.seats,
            fixed(d.think / seats, 2),
            fixed(d.think / d.own_turns.max(1) as f64 * 1000.0, 0),
            fixed(d.think / d.decisions.max(1) as f64 * 1000.0, 1),
            fixed(d.decisions as f64 / seats, 1),
            fixed(d.game_secs / games, 2),
            fixed(d.turns as f64 / games, 1),
        )
    };
    for (name, d) in &sm.decks {
        push(&mut out, &row(name, d));
    }
    push(&mut out, &row("全体", &sm.all));
    if !sm.groups.is_empty() {
        push(&mut out, "");
        push(&mut out, "## 型ごとの 1 試合の時間");
        push(&mut out, "");
        push(
            &mut out,
            "上の表を型（デッキの名前の「（」の前）ごとにまとめたもの。試合は、その型のデッキが出た試合（同じ型の違うデッキどうしは 2 試合と数える）。",
        );
        push(&mut out, "");
        push(
            &mut out,
            "| 型 | 席 | 思考（秒/試合） | 1 ターン（ミリ秒） | 1 手（ミリ秒） | 手番/試合 | 試合（秒） | ターン/試合 |",
        );
        push(
            &mut out,
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        );
        for (name, d) in &sm.groups {
            push(&mut out, &row(name, d));
        }
    }
    push(&mut out, "");
    push(&mut out, "## 仕組みを使った回数");
    push(&mut out, "");
    push(
        &mut out,
        "1 席（1 試合で片方の側）あたりの回数。勝率は引き分けを負けと数える。アクセラレート・結晶はその姿でプレイした数、エンハンスはエンハンスのコストを払ってプレイした数、奥義・解放奥義は【奥義】を持つカードを奥義ゲージ 10 以上・15 以上（解放奥義の分は奥義に数えない）でプレイした数。最初の進化・超進化は、した席での自分のターンの平均（括弧はした席の割合）。PP を残して終えたは、手札にプレイできるカードがあり PP も残っているのにターンを終えた割合（自分のターンに対する）と、そのとき残した PP の平均。",
    );
    push(&mut out, "");
    let by = if sm.groups.is_empty() {
        "デッキ"
    } else {
        "型"
    };
    let mut head = vec![by.to_string(), "勝率".into(), "ターン/試合".into()];
    head.extend(USAGE.iter().map(|x| x.to_string()));
    head.push("最初の進化".into());
    head.push("最初の超進化".into());
    head.push("PP を残して終えた".into());
    push(&mut out, &format!("| {} |", head.join(" | ")));
    push(
        &mut out,
        &format!("| --- |{}", " ---: |".repeat(head.len() - 1)),
    );
    let urow = |name: &str, d: &DeckStat| {
        let seats = d.seats.max(1) as f64;
        let mut cells = vec![
            name.to_string(),
            format!("{}%", fixed(d.wins as f64 / seats * 100.0, 0)),
            fixed(d.turns as f64 / d.games.max(1) as f64, 1),
        ];
        cells.extend(d.usage.iter().map(|&n| fixed(n as f64 / seats, 2)));
        let idle = |d: &DeckStat| {
            format!(
                "{}%（{}）",
                fixed(d.idle_turns as f64 / d.own_turns.max(1) as f64 * 100.0, 0),
                fixed(d.idle_pp as f64 / d.idle_turns.max(1) as f64, 1)
            )
        };
        for k in 0..2 {
            cells.push(if d.first_n[k] == 0 {
                "-".into()
            } else {
                format!(
                    "{}（{}%）",
                    fixed(d.first_sum[k] as f64 / d.first_n[k] as f64, 1),
                    fixed(d.first_n[k] as f64 / seats * 100.0, 0)
                )
            });
        }
        cells.push(idle(d));
        format!("| {} |", cells.join(" | "))
    };
    for (name, d) in if sm.groups.is_empty() {
        &sm.decks
    } else {
        &sm.groups
    } {
        push(&mut out, &urow(name, d));
    }
    push(&mut out, &urow("全体", &sm.all));
    push(&mut out, "");
    push(&mut out, "## PP を残して終えたときにプレイできたカード");
    push(&mut out, "");
    push(
        &mut out,
        &format!("上の「PP を残して終えた」ターンに、手札からプレイできたカード（1 ターンに同じカードは 1 回）。多い順に {IDLE_TOP} 枚まで。括弧は回数。"),
    );
    push(&mut out, "");
    push(&mut out, &format!("| {by} | ターン | カード |"));
    push(&mut out, "| --- | ---: | --- |");
    for (name, d) in if sm.groups.is_empty() {
        &sm.decks
    } else {
        &sm.groups
    } {
        let mut v: Vec<(&CardIdx, &u32)> = d.idle_cards.iter().collect();
        v.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        let cells: Vec<String> = v
            .iter()
            .take(IDLE_TOP)
            .map(|(c, n)| format!("{}（{n}）", card(**c).name))
            .collect();
        push(
            &mut out,
            &format!("| {name} | {} | {} |", d.idle_turns, cells.join("、")),
        );
    }
    if let Some(v) = &sm.check {
        push(&mut out, "");
        push(&mut out, "## 不変条件");
        push(&mut out, "");
        if v.is_empty() {
            push(
                &mut out,
                &format!(
                    "{} 試合のすべての手の後の局面で、不変条件（`invariants.rs`）を破らなかった。",
                    sm.total_games
                ),
            );
        } else {
            push(
                &mut out,
                &format!("破った局面 {} 件（1 試合で 5 件まで）:", v.len()),
            );
            push(&mut out, "");
            for m in v {
                push(&mut out, &format!("- {m}"));
            }
        }
    }
    push(&mut out, "");
    push(&mut out, "## 時間の長かった手番");
    push(&mut out, "");
    push(
        &mut out,
        &format!("1 試合で長い順に {SLOW_PER_GAME} つまでを集め、全試合で長い順に並べたもの。先後は考えた側が先攻か後攻か。合法手は考えたときの数、手札・場・PP は考えた側のもの（場は自分・相手）。選ぶのは能力の対象・モードを選ぶ手番。"),
    );
    push(&mut out, "");
    push(
        &mut out,
        "| 秒 | 試合 | 席 | 先後 | デッキ | ターン | 合法手 | 手札 | 場 | PP | 選ぶ |",
    );
    push(
        &mut out,
        "| ---: | --- | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | --- |",
    );
    for x in &sm.slow {
        push(
            &mut out,
            &format!(
                "| {} | g{}{} | {} | {} | {} | {} | {} | {} | {}・{} | {} | {} |",
                fixed(x.secs, 2),
                x.g,
                if x.swap { "（入れ替え）" } else { "" },
                x.seat,
                if x.first { "先攻" } else { "後攻" },
                x.deck,
                x.turn,
                x.legal,
                x.hand,
                x.board[0],
                x.board[1],
                x.pp,
                if x.choosing { "選ぶ" } else { "" },
            ),
        );
    }
    if !sm.profiled {
        return out;
    }
    push(&mut out, "");
    push(&mut out, "## デッキごとの内訳");
    push(&mut out, "");
    push(
        &mut out,
        "そのデッキの思考の時間に対する割合。考え直し/試合 は自分のターンのビームを打った数（前に選んだ並びの続き・リーサルの続きは数えない）。",
    );
    push(&mut out, "");
    let mut head = vec!["デッキ".to_string()];
    head.extend(TOP.iter().map(|(_, l)| l.to_string()));
    head.push("その他".into());
    head.push("考え直し/試合".into());
    head.push("ビーム 1 回（ミリ秒）".into());
    push(&mut out, &format!("| {} |", head.join(" | ")));
    push(
        &mut out,
        &format!("| --- |{}", " ---: |".repeat(head.len() - 1)),
    );
    let brow = |name: &str, d: &DeckStat| {
        let (total, parts, other) = deck_breakdown(&d.prof);
        let mut cells = vec![name.to_string()];
        cells.extend(parts.iter().map(|&x| pct(x, total)));
        cells.push(pct(other, total));
        let beam = d
            .prof
            .get(&vec![Sec::Think, Sec::Beam])
            .copied()
            .unwrap_or([0, 0]);
        cells.push(fixed(beam[1] as f64 / d.seats.max(1) as f64, 1));
        cells.push(fixed(beam[0] as f64 / beam[1].max(1) as f64 / 1e6, 1));
        format!("| {} |", cells.join(" | "))
    };
    for (name, d) in &sm.decks {
        push(&mut out, &brow(name, d));
    }
    push(&mut out, &brow("全体", &sm.all));

    let p = &sm.all.prof;
    let total = ns_of(p, &[Sec::Think]);
    let per_game = |x: f64| x / sm.total_games.max(1) as f64;
    push(&mut out, "");
    push(&mut out, "## 処理ごとの内訳（全デッキ）");
    push(&mut out, "");
    push(
        &mut out,
        "思考の時間（両方の席の合計）に対する割合。字下げは、どの処理の中で呼ばれたか（同じ処理でも、自分のターンのビームの中と相手のターンの読みの中は別の行）。0.5% 未満の行は省く。秒/試合・1 回の時間は測るビルドの値（測る分だけ長めに出る）。",
    );
    push(&mut out, "");
    push(
        &mut out,
        "| 処理 | 割合 | 秒/試合 | 回数/試合 | 1 回（µs） |",
    );
    push(&mut out, "| --- | ---: | ---: | ---: | ---: |");
    fn walk(out: &mut String, p: &Profile, path: &[Sec], v: [u64; 2], total: u64, games: f64) {
        let depth = path.len() - 1;
        let name = format!(
            "{}{}",
            "　".repeat(depth),
            path.last().expect("空の入れ子").label()
        );
        out.push_str(&format!(
            "| {name} | {} | {} | {} | {} |\n",
            pct(v[0], total),
            fixed(v[0] as f64 / 1e9 / games, 3),
            fixed(v[1] as f64 / games, 0),
            fixed(v[0] as f64 / v[1].max(1) as f64 / 1e3, 2),
        ));
        for (k, cv) in children_of(p, path) {
            if (cv[0] as f64) < total as f64 * 0.005 {
                continue;
            }
            walk(out, p, k, cv, total, games);
        }
    }
    if let Some(v) = p.get(&vec![Sec::Think]) {
        walk(
            &mut out,
            p,
            &[Sec::Think],
            *v,
            total,
            sm.total_games.max(1) as f64,
        );
    }
    push(&mut out, "");
    push(&mut out, "## 処理の種類ごとの合計（全デッキ）");
    push(&mut out, "");
    push(
        &mut out,
        "自分の時間は、その処理の時間から中で測った処理の時間を引いたもの（どこで時間を使っているか）。含む時間は、どこで呼ばれたかによらず足したもの（同じ処理の入れ子は外側だけ）。",
    );
    push(&mut out, "");
    push(
        &mut out,
        "| 処理 | 自分の時間 | 含む時間 | 回数/試合 | 1 回（µs） |",
    );
    push(&mut out, "| --- | ---: | ---: | ---: | ---: |");
    let think_only: Profile = p
        .iter()
        .filter(|(k, _)| k.first() == Some(&Sec::Think))
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    let mut f: Vec<(Sec, [u64; 3])> = flat(&think_only).into_iter().collect();
    f.sort_by(|a, b| b.1[0].cmp(&a.1[0]));
    for (sec, [own, incl, calls]) in f {
        push(
            &mut out,
            &format!(
                "| {} | {} | {} | {} | {} |",
                sec.label(),
                pct(own, total),
                pct(incl, total),
                fixed(per_game(calls as f64), 0),
                fixed(incl as f64 / calls.max(1) as f64 / 1e3, 2),
            ),
        );
    }
    let outside: u64 = p
        .iter()
        .filter(|(k, _)| k.len() == 1 && k[0] != Sec::Think)
        .map(|(_, v)| v[0])
        .sum();
    push(&mut out, "");
    push(
        &mut out,
        &format!(
            "思考の外（実際の対戦の合法手と手を打つ処理）は思考の {}。",
            pct(outside, total)
        ),
    );
    out
}

fn doc_path() -> String {
    format!("{}/../../docs/profile.md", env!("CARGO_MANIFEST_DIR"))
}

/// 記録の表の見出し
fn table_header(decks: &[String]) -> String {
    let mut cols: Vec<String> = [
        "日付",
        "コミット",
        "名前",
        "設定",
        "試合",
        "並列・CPU",
        "1 試合",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    cols.extend(decks.iter().map(|d| short_name(d).to_string()));
    cols.extend(TOP.iter().map(|(_, l)| l.to_string()));
    format!("| {} |\n|{}", cols.join(" | "), " --- |".repeat(cols.len()))
}

/// docs/profile.md の表に 1 行足す（表は文書の最後にある。無ければ見出しから書く）
fn record(row: &str, decks: &[String]) -> Result<(), String> {
    let path = doc_path();
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{path} を読めません: {e}"))?;
    let mut text = text.trim_end_matches('\n').to_string();
    text.push('\n');
    if !text.lines().last().is_some_and(|l| l.starts_with('|')) {
        text.push('\n');
        text.push_str(&table_header(decks));
        text.push('\n');
    }
    text.push_str(row);
    text.push('\n');
    std::fs::write(&path, text).map_err(|e| format!("{path} に書けません: {e}"))
}

fn record_row(sm: &Summary, date: &str, commit: &str, label: &str) -> String {
    let mut cells = vec![
        date.to_string(),
        commit.to_string(),
        label.replace('|', "\\|"),
        format!("`{}`", sm.opts_text.replace('|', "\\|")),
        format!(
            "{}（g{}〜{}）",
            sm.total_games,
            sm.start,
            sm.start + sm.games - 1
        ),
        format!("{}・{}", sm.threads, sm.cpu.replace('|', "\\|")),
        format!(
            "**{}**",
            fixed(sm.all.think / sm.total_games.max(1) as f64, 2)
        ),
    ];
    for name in &sm.deck_order {
        let d = &sm.decks.iter().find(|(n, _)| n == name).expect("デッキ").1;
        cells.push(fixed(d.think / d.seats.max(1) as f64, 2));
    }
    if sm.profiled {
        let (total, parts, _) = deck_breakdown(&sm.all.prof);
        for x in &parts {
            cells.push(pct(*x, total));
        }
    } else {
        cells.extend(std::iter::repeat_n("-".to_string(), TOP.len()));
    }
    format!("| {} |", cells.join(" | "))
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mut opts_text = "{}".to_string();
    let mut games = 49u32;
    let mut start = 0u32;
    let mut rhino = false;
    let mut json_out: Option<String> = None;
    let mut baseline: Option<String> = None;
    let mut report_out: Option<String> = None;
    let mut label = String::new();
    let mut write = false;
    let mut deck_list: Option<String> = None;
    let mut check = false;
    let mut log_dir: Option<String> = None;
    let mut i = 0;
    while i < argv.len() {
        let value = |i: usize| {
            argv.get(i + 1)
                .cloned()
                .ok_or_else(|| format!("{} の値がありません", argv[i]))
        };
        let int = |s: String| {
            s.parse::<u32>()
                .map_err(|_| format!("0 以上の整数を渡します: {s}"))
        };
        match argv[i].as_str() {
            "--opts" => opts_text = value(i)?,
            "--games" => games = int(value(i)?)?,
            "--start" => start = int(value(i)?)?,
            "--json" => json_out = Some(value(i)?),
            "--baseline" => baseline = Some(value(i)?),
            "--report" => report_out = Some(value(i)?),
            "--label" => label = value(i)?,
            "--decks" => deck_list = Some(value(i)?),
            "--log" => log_dir = Some(value(i)?),
            "--rhino" | "--record" | "--check" => {
                match argv[i].as_str() {
                    "--rhino" => rhino = true,
                    "--record" => write = true,
                    _ => check = true,
                }
                i += 1;
                continue;
            }
            a => return Err(format!("未知の引数: {a}")),
        }
        i += 2;
    }
    if games == 0 {
        return Err("--games は 1 以上".into());
    }
    if write && label.is_empty() {
        return Err("--record には --label で名前を付けます".into());
    }
    if write && deck_list.is_some() {
        return Err("--record は比較用の 7 デッキだけ（--decks とは一緒に使えない）".into());
    }
    let opts = compare_options(&opts_text).map_err(|e| format!("--opts: {e}"))?;
    let decks: Vec<&'static Deck> = match &deck_list {
        None => compare_decks(),
        Some(list) => read_deck_list(list)?
            .into_iter()
            .map(|d| &*Box::leak(Box::new(d)))
            .collect(),
    };
    if decks.is_empty() {
        return Err("--decks にデッキを並べます".into());
    }
    {
        let mut names: Vec<&str> = decks.iter().map(|d| d.name.as_str()).collect();
        names.sort_unstable();
        if let Some(w) = names.windows(2).find(|w| w[0] == w[1]) {
            return Err(format!("同じ名前のデッキが 2 つあります: {}", w[0]));
        }
    }
    let base = baseline.as_deref().map(read_baseline).transpose()?;
    let tasks: Vec<(u32, bool)> = (0..games)
        .flat_map(|k| [(start + k, false), (start + k, true)])
        .collect();
    let threads = thread_count();
    eprintln!(
        "{} 試合（並列 {threads}{}）",
        tasks.len(),
        if prof::ENABLED {
            "、処理ごとの内訳を測る"
        } else {
            ""
        }
    );
    let t0 = Instant::now();
    let records = parallel_map(
        &tasks,
        |&(g, swap), _| play_timed(&opts, rhino, &decks, g, swap, check, log_dir.is_some()),
        |done, total, _, _| {
            if done % 10 == 0 || done == total {
                eprint!("\r{done}/{total}");
            }
        },
    );
    eprintln!("（{} 秒）", fixed(t0.elapsed().as_secs_f64(), 1));
    if let Some(dir) = &log_dir {
        std::fs::create_dir_all(dir).map_err(|e| format!("{dir} を作れません: {e}"))?;
        for r in &records {
            let path = format!("{dir}/g{}{}.md", r.g, if r.swap { "s" } else { "" });
            let head = format!(
                "# g{}{}: 席 0 {} 対 席 1 {}（先攻は席 {}）、勝者 {}、{} ターン\n",
                r.g,
                if r.swap { "（入れ替え）" } else { "" },
                r.decks[0],
                r.decks[1],
                r.first_seat,
                r.winner.map_or("なし".to_string(), |w| format!("席 {w}")),
                r.turns
            );
            std::fs::write(&path, head + &r.log.join("\n") + "\n")
                .map_err(|e| format!("{path} に書けません: {e}"))?;
        }
    }

    // --baseline と同じ試合になったか。思考の時間の比
    let mut ratio = None;
    if let Some(b) = &base {
        let (mut mine, mut theirs) = (0.0, 0.0);
        for r in &records {
            let x = b
                .get(&(r.g, r.swap))
                .ok_or_else(|| format!("--baseline に試合 {}（{}）がありません", r.g, r.swap))?;
            if x.decks != r.decks || x.actions != r.actions || x.winner != r.winner {
                return Err(format!(
                    "--baseline と試合 {}（{}）の結果が違います（設定・コミットが同じかを確かめる）",
                    r.g, r.swap
                ));
            }
            mine += r.think[0] + r.think[1];
            theirs += x.think[0] + x.think[1];
        }
        ratio = Some(mine / theirs);
    }
    // 測るビルドなら、時間は --baseline（測らないビルド）のものを使う
    let time_base = base.as_ref().filter(|_| prof::ENABLED);

    let mut stats: Vec<(String, DeckStat)> = decks
        .iter()
        .map(|d| (d.name.clone(), DeckStat::default()))
        .collect();
    let mut all = DeckStat::default();
    let mut groups: Vec<(String, DeckStat)> = Vec::new();
    for r in &records {
        let (secs, think) = match time_base.and_then(|b| b.get(&(r.g, r.swap))) {
            Some(x) => (x.secs, x.think),
            None => (r.secs, r.think),
        };
        all.add_game(secs, r.turns);
        for seat in [0, 1] {
            all.add_seat(r, seat, think[seat]);
            let d = &mut stats
                .iter_mut()
                .find(|(n, _)| *n == r.decks[seat])
                .expect("デッキ")
                .1;
            d.add_seat(r, seat, think[seat]);
            if seat == 0 || r.decks[0] != r.decks[1] {
                d.add_game(secs, r.turns);
            }
            let k = archetype(&r.decks[seat]);
            if !groups.iter().any(|(n, _)| n == k) {
                groups.push((k.to_string(), DeckStat::default()));
            }
            let gs = &mut groups.iter_mut().find(|(n, _)| n == k).expect("型").1;
            gs.add_seat(r, seat, think[seat]);
            if seat == 0 || r.decks[0] != r.decks[1] {
                gs.add_game(secs, r.turns);
            }
        }
    }
    // 1 席あたりの思考の時間が長い順
    let by_think = |a: &(String, DeckStat), b: &(String, DeckStat)| {
        let x = a.1.think / a.1.seats.max(1) as f64;
        let y = b.1.think / b.1.seats.max(1) as f64;
        y.total_cmp(&x)
    };
    stats.sort_by(by_think);
    groups.sort_by(by_think);
    if groups.len() == stats.len() {
        groups.clear();
    }
    let sm = Summary {
        opts_text: opts_text.clone(),
        rhino,
        start,
        games,
        threads,
        cpu: cpu_name(),
        profiled: prof::ENABLED,
        from_baseline: time_base.is_some(),
        ratio,
        decks: stats,
        groups,
        deck_order: decks.iter().map(|d| d.name.clone()).collect(),
        all,
        total_games: records.len() as u32,
        slow: {
            let mut v: Vec<SlowDecision> = records.iter().flat_map(|r| r.slow.clone()).collect();
            v.sort_by(|a, b| b.secs.total_cmp(&a.secs));
            v.truncate(20);
            v
        },
        check: check.then(|| records.iter().flat_map(|r| r.violations.clone()).collect()),
    };
    let date = command_line("date", &["+%Y-%m-%d"]).unwrap_or("?".into());
    let commit = commit_label_excluding("docs/profile.md");
    let text = report(&sm, &date, &commit, &label);
    // 報告は --report のファイルか、無ければ標準出力に
    if report_out.is_none() {
        println!("{text}");
    }
    if let Some(path) = &report_out {
        std::fs::write(path, &text).map_err(|e| format!("{path} に書けません: {e}"))?;
    }
    if let Some(path) = &json_out {
        let mut sections = serde_json::Map::new();
        for (name, d) in sm
            .decks
            .iter()
            .chain(std::iter::once(&("全体".to_string(), sm.all.clone())))
        {
            let rows: Vec<Value> = d
                .prof
                .iter()
                .map(|(k, v)| json!([path_key(k), v[0], v[1]]))
                .collect();
            sections.insert(name.clone(), Value::Array(rows));
        }
        let v = json!({
            "date": date,
            "commit": commit,
            "label": label,
            "opts": opts_text,
            "rhino": rhino,
            "threads": threads,
            "cpu": sm.cpu,
            "profiled": prof::ENABLED,
            "games": records.iter().map(|r| r.to_json()).collect::<Vec<_>>(),
            "sections": sections,
        });
        std::fs::write(path, v.to_string() + "\n")
            .map_err(|e| format!("{path} に書けません: {e}"))?;
    }
    if write {
        record(&record_row(&sm, &date, &commit, &label), &sm.deck_order)?;
        eprintln!("docs/profile.md に記録しました");
    }
    if let Some(v) = sm.check.as_ref().filter(|v| !v.is_empty()) {
        return Err(format!("不変条件を破った局面が {} 件あります", v.len()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_separates_own_and_inclusive_time() {
        let mut p = Profile::new();
        p.insert(vec![Sec::Think], [100, 1]);
        p.insert(vec![Sec::Think, Sec::Beam], [60, 2]);
        p.insert(vec![Sec::Think, Sec::Beam, Sec::Eval], [20, 5]);
        p.insert(vec![Sec::Think, Sec::Rescore], [30, 1]);
        p.insert(vec![Sec::Think, Sec::Rescore, Sec::Beam], [25, 3]);
        let f = flat(&p);
        assert_eq!(f[&Sec::Think], [10, 100, 1]);
        assert_eq!(f[&Sec::Beam], [40 + 25, 85, 5]);
        assert_eq!(f[&Sec::Eval], [20, 20, 5]);
        assert_eq!(f[&Sec::Rescore], [5, 30, 1]);
    }
}
