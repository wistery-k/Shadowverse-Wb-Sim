//! 見落とし問題集（docs/misses.md）: 人間が見て分かった AI のミスの局面を、合格の条件つきで集めたもの（`misses/*.json`）。
//!
//!   svwb misses run [--opts '<設定>'] [--trials 24] [--seed 1] [--only 名前,…] [--dir misses] [--label 名前] [--no-ledger] [--lines 2] [--out 結果.jsonl]
//!   svwb misses add --id <名前> --pass '<条件>' [--title …] [--note …] [--source …] [--agent search|rhino] [--dir misses] [--force] [--no-run]
//!                   (--replay <記録> [--line N] [--key subject/deck/g/seat] | --seed S --decks A,B [--agents search,search] | --two-turn <局面の名前> | --state <局面.json>)
//!                   (--turn T | --step N) [--player 0|1]
//!   svwb misses list [--dir misses]
//!   svwb misses show <問の名前>… [--dir misses]
//!   svwb misses check [--dir misses]
//!   svwb misses cover [--opts '<設定>'] [--seeds 8] [--m 128] [--extra 4] [--wide 64] [--only 名前,…] [--show] [--dir misses]
//!
//! - 1 問は 1 ファイル。局面そのもの（状態の JSON）・手番・合格の条件・出どころ・ひとことの説明を持つ。
//!   局面を seed とターンで持たないのは、AI を変えると試合の流れが変わるため
//! - `run` は各局面を AI の乱数を変えて `--trials` 回打ち、問ごとと全体の合格率（正解率）を出し、台帳に 1 行足す（`--no-ledger` で書かない）。
//!   設定は compare と同じ形の JSON（リノセウス用 AI の問は rhino-compare の `--opts` と同じに読む）。
//!   局面の隠れた情報（相手の手札・山札、山札の順番、局面の乱数）は問のまま。AI は今までどおり自分から見た決定化で考えるので、見ない
//! - `add` は記録した試合（`npm run game --json`・compare の `--replays`・人間の記録）・今の AI で打ち直す試合・手で作った局面（two-turn）・
//!   サンドボックスの書き出しから局面を取り出し、問のファイルを書いて、今の AI の合格率を出す（`--no-run` で出さない）
//! - `cover` は各問を候補の打ち比べ調査（docs/survey.md）と同じ作り方の候補にして、合格の並びが候補のどこにあるかを数え、
//!   候補に入る問は AI の選んだ並びと最後まで打ち比べる（調査がその種類のミスを拾えるかの確かめ。台帳には書かない）
//! - 局面はシミュレータの中の試合からだけ取り、このコマンドだけで使う（公開サイトには出さない。CLAUDE.md「ソフト打ち」）

use super::deck_compare::read_deck;
use super::fixed;
use super::human_plan::{is_start_of_turn, mix, name_of, parse_record, step_text};
use super::ledger;
use super::options::{rhino_compare_options, rhino_options, search_options};
use super::parallel::parallel_map;
use crate::ai::exact_lethal::reset_exact_lethal_cache;
use crate::ai::lethal::reset_lethal;
use crate::ai::registry::create_agent;
use crate::ai::rhino::RhinoAgent;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::Agent;
use crate::canonical::fnv;
use crate::data::{data, CardIdx};
use crate::game::{acting_player, apply_legal, create_game, is_legal, legal_actions};
use crate::json::Json;
use crate::sim::MatchRng;
use crate::state::{card, Action, GameState, Phase, PlayerIndex};
use crate::state_json::{action_from_json, action_to_json, state_from_json, state_to_json};
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

/// 問題集の置き場所（リポジトリの根から）
pub const MISSES_DIR: &str = "misses";
/// 問のファイルの形の版
const VERSION: f64 = 1.0;
/// 1 問を打つ回数の既定
const TRIALS: u32 = 24;
/// 1 ターンに打つ手の上限（これを超えたら止まらない AI として失敗にする）
const MAX_STEPS: usize = 500;

/// リポジトリの根からの道を、この実行の場所からの道にする（`npm run svwb` はリポジトリの根で動かす）
fn repo_path(p: &str) -> String {
    if std::path::Path::new(p).is_absolute() || std::path::Path::new(p).exists() {
        return p.to_string();
    }
    format!("{}/../../{p}", env!("CARGO_MANIFEST_DIR"))
}

// ---------------------------------------------------------------- 合格の条件

/// 手の種類
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verb {
    Play,
    Attack,
    Evolve,
    SuperEvolve,
    Act,
    Fuse,
    Choose,
    Mode,
    /// 攻撃先か選んだカードに含む
    Target,
}

const VERBS: [(&str, Verb); 9] = [
    ("play", Verb::Play),
    ("attack", Verb::Attack),
    ("evolve", Verb::Evolve),
    ("superEvolve", Verb::SuperEvolve),
    ("act", Verb::Act),
    ("fuse", Verb::Fuse),
    ("choose", Verb::Choose),
    ("mode", Verb::Mode),
    ("target", Verb::Target),
];

/// どれでもよいカード
const ANY: &str = "*";
/// リーダーの名前（攻撃先・選んだもの）
const OPP_LEADER: &str = "相手のリーダー";
const MY_LEADER: &str = "自分のリーダー";

/// 手の形（`{"play":"魔女の錬金釜"}` 等）
#[derive(Clone, Debug)]
struct Pattern {
    verb: Verb,
    /// カードの名前（`*` はどれでも）。mode なら空
    card: String,
    /// mode の番号（1 から。画面の「n 番目の効果」と同じ）
    mode: usize,
    /// attack の攻撃先（無ければどれでも）
    target: Option<String>,
    /// choose・mode を求めたカード（その前に打ったプレイ・アクト・進化・融合・攻撃のカード。無ければどれでも）
    by: Option<String>,
}

/// 条件の 1 組（全部を満たせば合格）
#[derive(Clone, Debug, Default)]
struct Cond {
    /// このターンに全部を含む
    must: Vec<Pattern>,
    /// このターンにどれも含まない
    must_not: Vec<Pattern>,
    /// このターンに勝つ
    win: bool,
    /// ターンを終えたときの自分の体力がこれ以上（このターンに勝ったときも満たす）
    min_hp: Option<i32>,
}

/// 名前がカードの名前かリーダーか `*` か（書き間違いを読むときに見つける）
fn check_name(name: &str) -> Result<(), String> {
    if name == ANY
        || name == OPP_LEADER
        || name == MY_LEADER
        || data().cards.iter().any(|c| c.name == name)
    {
        Ok(())
    } else {
        Err(format!("カードの名前ではありません: {name}"))
    }
}

fn parse_pattern(v: &Json) -> Result<Pattern, String> {
    let Json::Obj(items) = v else {
        return Err(format!(
            "手は {{\"play\":\"カード名\"}} の形で書きます: {}",
            v.stringify()
        ));
    };
    let mut verb = None;
    let mut p = Pattern {
        verb: Verb::Play,
        card: String::new(),
        mode: 0,
        target: None,
        by: None,
    };
    let text = |k: &str, x: &Json| -> Result<String, String> {
        match x {
            Json::Str(s) => {
                check_name(s)?;
                Ok(s.clone())
            }
            _ => Err(format!(
                "\"{k}\" はカードの名前（文字列）: {}",
                x.stringify()
            )),
        }
    };
    for (k, x) in items {
        // "target" は attack の攻撃先にも、単独の手（攻撃先か選んだカード）にもなる。後で決める
        if k == "target" {
            p.target = Some(text(k, x)?);
        } else if let Some(&(_, vb)) = VERBS.iter().find(|(n, _)| n == k) {
            if verb.is_some() {
                return Err(format!("手の種類は 1 つだけ書きます: {}", v.stringify()));
            }
            verb = Some(vb);
            if vb == Verb::Mode {
                p.mode = match x {
                    Json::Num(n) if *n >= 1.0 && n.fract() == 0.0 => *n as usize,
                    _ => return Err(format!("\"mode\" は 1 からの番号: {}", x.stringify())),
                };
            } else {
                p.card = text(k, x)?;
            }
        } else if k == "by" {
            p.by = Some(text(k, x)?);
        } else {
            return Err(format!("知らない項目: {k}（{}）", v.stringify()));
        }
    }
    // {"target": "X"} だけなら「攻撃先か選んだカードに X を含む」
    if verb.is_none() {
        if let Some(t) = p.target.take() {
            verb = Some(Verb::Target);
            p.card = t;
        }
    }
    p.verb = verb.ok_or_else(|| {
        format!(
            "手の種類（{}）がありません: {}",
            VERBS.iter().map(|x| x.0).collect::<Vec<_>>().join("・"),
            v.stringify()
        )
    })?;
    if p.target.is_some() && p.verb != Verb::Attack {
        return Err(format!(
            "\"target\" は attack に付けます: {}",
            v.stringify()
        ));
    }
    if p.by.is_some() && !matches!(p.verb, Verb::Choose | Verb::Mode) {
        return Err(format!(
            "\"by\" は choose・mode に付けます: {}",
            v.stringify()
        ));
    }
    Ok(p)
}

fn parse_cond(v: &Json) -> Result<Cond, String> {
    let Json::Obj(items) = v else {
        return Err(
            "合格の条件はオブジェクトか、オブジェクトの配列（どれか 1 つを満たせば合格）で書きます"
                .into(),
        );
    };
    let mut c = Cond::default();
    let list = |k: &str, x: &Json| -> Result<Vec<Pattern>, String> {
        match x {
            Json::Arr(xs) => xs.iter().map(parse_pattern).collect(),
            _ => Err(format!("\"{k}\" は手の配列")),
        }
    };
    for (k, x) in items {
        match k.as_str() {
            "must" => c.must = list(k, x)?,
            "mustNot" => c.must_not = list(k, x)?,
            "win" => {
                c.win = match x {
                    Json::Bool(b) => *b,
                    _ => return Err("\"win\" は true か false".into()),
                }
            }
            "minHp" => {
                c.min_hp = match x {
                    Json::Num(n) if n.fract() == 0.0 => Some(*n as i32),
                    _ => return Err("\"minHp\" は整数".into()),
                }
            }
            _ => {
                return Err(format!(
                    "合格の条件の知らない項目: {k}（must・mustNot・win・minHp）"
                ))
            }
        }
    }
    if c.must.is_empty() && c.must_not.is_empty() && !c.win && c.min_hp.is_none() {
        return Err("合格の条件が空です".into());
    }
    Ok(c)
}

/// 合格の条件（どれか 1 組を満たせば合格）
fn parse_pass(v: &Json) -> Result<Vec<Cond>, String> {
    match v {
        Json::Arr(xs) if !xs.is_empty() => xs.iter().map(parse_cond).collect(),
        Json::Arr(_) => Err("合格の条件が空です".into()),
        _ => Ok(vec![parse_cond(v)?]),
    }
}

// ---------------------------------------------------------------- 1 ターンの手

/// 打った手 1 つ（名前は打つ前の局面で引く）
#[derive(Clone, Debug)]
struct Step {
    verb: Option<Verb>,
    /// 手のカード（choose なら選んだカード全部）
    cards: Vec<String>,
    mode: usize,
    target: Option<String>,
    by: Option<String>,
    text: String,
}

fn step_of(s: &GameState, a: &Action, p: PlayerIndex, last: &Option<String>) -> Step {
    let name = |i| name_of(s, i, p);
    let mut st = Step {
        verb: None,
        cards: Vec::new(),
        mode: 0,
        target: None,
        by: None,
        text: step_text(s, a, p),
    };
    match a {
        Action::Play(i) => {
            st.verb = Some(Verb::Play);
            st.cards = vec![name(*i)];
        }
        Action::Attack { attacker, target } => {
            st.verb = Some(Verb::Attack);
            st.cards = vec![name(*attacker)];
            st.target = Some(match target {
                Some(t) => name(*t),
                None => OPP_LEADER.into(),
            });
        }
        Action::Evolve(i) => {
            st.verb = Some(Verb::Evolve);
            st.cards = vec![name(*i)];
        }
        Action::SuperEvolve(i) => {
            st.verb = Some(Verb::SuperEvolve);
            st.cards = vec![name(*i)];
        }
        Action::Act(i) => {
            st.verb = Some(Verb::Act);
            st.cards = vec![name(*i)];
        }
        Action::Fuse { host, .. } => {
            st.verb = Some(Verb::Fuse);
            st.cards = vec![name(*host)];
        }
        Action::Choose(ids) => {
            st.verb = Some(Verb::Choose);
            st.cards = ids.iter().map(|&i| name(i)).collect();
            st.by = last.clone();
        }
        Action::Mode(k) => {
            st.verb = Some(Verb::Mode);
            st.mode = k + 1;
            st.by = last.clone();
        }
        Action::Mulligan { .. } | Action::ExtraPp | Action::EndTurn => {}
    }
    st
}

fn same(want: &str, got: &str) -> bool {
    want == ANY || want == got
}

fn matches(p: &Pattern, st: &Step) -> bool {
    let Some(v) = st.verb else { return false };
    let by_ok = || match (&p.by, &st.by) {
        (None, _) => true,
        (Some(w), Some(g)) => same(w, g),
        (Some(_), None) => false,
    };
    match p.verb {
        Verb::Target => match v {
            Verb::Attack => st.target.as_deref().is_some_and(|t| same(&p.card, t)),
            Verb::Choose => st.cards.iter().any(|c| same(&p.card, c)),
            _ => false,
        },
        Verb::Mode => v == Verb::Mode && st.mode == p.mode && by_ok(),
        Verb::Choose => v == Verb::Choose && st.cards.iter().any(|c| same(&p.card, c)) && by_ok(),
        Verb::Attack => {
            v == Verb::Attack
                && st.cards.iter().any(|c| same(&p.card, c))
                && match (&p.target, &st.target) {
                    (None, _) => true,
                    (Some(w), Some(g)) => same(w, g),
                    (Some(_), None) => false,
                }
        }
        other => v == other && st.cards.iter().any(|c| same(&p.card, c)),
    }
}

/// 1 ターンを打った結果
struct Turn {
    steps: Vec<Step>,
    won: bool,
    /// ターンを終えた後（相手のターンの最初）の自分の体力
    hp: i32,
}

fn passes(conds: &[Cond], t: &Turn) -> bool {
    conds.iter().any(|c| {
        c.must.iter().all(|p| t.steps.iter().any(|s| matches(p, s)))
            && !c
                .must_not
                .iter()
                .any(|p| t.steps.iter().any(|s| matches(p, s)))
            && (!c.win || t.won)
            && c.min_hp.is_none_or(|h| t.won || t.hp >= h)
    })
}

/// 局面 start から、席 p の AI がターンを終えるまで打つ（相手の選択待ちは相手の AI が選ぶ）
fn play_turn(
    start: &GameState,
    p: PlayerIndex,
    me: &mut dyn Agent,
    opp: &mut dyn Agent,
    rng: &mut MatchRng,
) -> Result<Turn, String> {
    let mut t = start.clone();
    let mut steps = Vec::new();
    let mut last: Option<String> = None;
    for _ in 0..MAX_STEPS {
        if t.phase == Phase::Ended {
            break;
        }
        let actor = acting_player(&t);
        let legal = legal_actions(&t);
        let a = if actor == p {
            rng.choose(me, &t, &legal)
        } else {
            rng.choose(opp, &t, &legal)
        };
        if actor == p {
            let st = step_of(&t, &a, p, &last);
            if matches!(
                a,
                Action::Play(_)
                    | Action::Act(_)
                    | Action::Evolve(_)
                    | Action::SuperEvolve(_)
                    | Action::Fuse { .. }
                    | Action::Attack { .. }
            ) {
                last = st.cards.first().cloned();
            }
            if !matches!(a, Action::EndTurn | Action::ExtraPp) {
                steps.push(st);
            }
        }
        let end_turn = actor == p && matches!(a, Action::EndTurn);
        t = apply_legal(&t, &a);
        if end_turn || (t.phase != Phase::Ended && t.active != p) {
            return Ok(Turn {
                steps,
                won: false,
                hp: t.players[p].leader_hp,
            });
        }
    }
    if t.phase == Phase::Ended {
        return Ok(Turn {
            steps,
            won: t.winner == Some(p),
            hp: t.players[p].leader_hp,
        });
    }
    Err(format!("AI が {MAX_STEPS} 手でターンを終えません"))
}

// ---------------------------------------------------------------- 問

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgentKind {
    Search,
    Rhino,
}

impl AgentKind {
    fn name(self) -> &'static str {
        match self {
            AgentKind::Search => "search",
            AgentKind::Rhino => "rhino",
        }
    }
    fn parse(s: &str) -> Result<AgentKind, String> {
        match s {
            "search" => Ok(AgentKind::Search),
            "rhino" => Ok(AgentKind::Rhino),
            _ => Err(format!("AI は search か rhino: {s}")),
        }
    }
}

/// 問 1 つ
struct Problem {
    id: String,
    title: String,
    agent: AgentKind,
    player: PlayerIndex,
    pass: Vec<Cond>,
    /// 局面（状態の JSON の文字列。局面はスレッドをまたげないので、打つスレッドで読む）
    state: String,
    /// ファイルの中身全部（指紋と書き戻し用）
    raw: Json,
}

fn str_of(v: &Json, k: &str) -> Result<String, String> {
    match v.get(k) {
        Some(Json::Str(s)) => Ok(s.clone()),
        _ => Err(format!("\"{k}\"（文字列）がありません")),
    }
}

fn parse_problem(text: &str, file: &str) -> Result<Problem, String> {
    let v = Json::parse(text).map_err(|e| format!("{file}: JSON が読めません: {e}"))?;
    let r = (|| -> Result<Problem, String> {
        if v.get("v") != Some(&Json::Num(VERSION)) {
            return Err("版（\"v\":1）がありません".into());
        }
        let id = str_of(&v, "id")?;
        let stem = std::path::Path::new(file)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if !stem.is_empty() && stem != id {
            return Err(format!("名前（{id}）とファイルの名前（{stem}）が違います"));
        }
        for k in ["title", "note", "source", "added"] {
            str_of(&v, k)?;
        }
        let agent = AgentKind::parse(&str_of(&v, "agent")?)?;
        let player = match v.get("player") {
            Some(Json::Num(n)) if *n == 0.0 || *n == 1.0 => *n as usize,
            _ => return Err("\"player\" は 0 か 1".into()),
        };
        let pass = parse_pass(v.get("pass").ok_or("\"pass\" がありません")?)?;
        let sj = v.get("state").ok_or("\"state\" がありません")?;
        let s = state_from_json(sj).map_err(|e| format!("局面が読めません: {e}"))?;
        if s.phase != Phase::Main {
            return Err("局面が対戦の途中（main）ではありません".into());
        }
        if acting_player(&s) != player {
            return Err(format!(
                "手番が違います（\"player\" {player}、局面の手番 {}）",
                acting_player(&s)
            ));
        }
        if legal_actions(&s).is_empty() {
            return Err("局面で打てる手がありません".into());
        }
        Ok(Problem {
            id,
            title: str_of(&v, "title")?,
            agent,
            player,
            pass,
            state: sj.stringify(),
            raw: v.clone(),
        })
    })();
    r.map_err(|e| format!("{file}: {e}"))
}

/// 問題集を読む（ファイルの名前の順）
fn load(dir: &str) -> Result<Vec<Problem>, String> {
    let d = repo_path(dir);
    let mut files: Vec<String> = std::fs::read_dir(&d)
        .map_err(|e| format!("{d} が読めません: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    files.sort();
    files
        .iter()
        .map(|f| {
            let text = std::fs::read_to_string(f).map_err(|e| format!("{f}: {e}"))?;
            parse_problem(&text, f)
        })
        .collect()
}

/// 問題集の指紋（問の名前と中身）
fn set_fingerprint(ps: &[Problem]) -> String {
    let all: Vec<String> = ps
        .iter()
        .map(|p| format!("{}\u{1}{}", p.id, p.raw.canonical()))
        .collect();
    fnv(&all.join("\u{2}"))
}

// ---------------------------------------------------------------- 打つ

/// AI の設定（compare と同じ形の JSON から。リノセウス用 AI の問は rhino-compare の --opts と同じに読む）
struct Agents {
    search: SearchOptions,
    rhino: (SearchOptions, SearchOptions),
}

impl Agents {
    fn new(text: &str) -> Result<Agents, String> {
        let (raw, model) = rhino_compare_options(text)?;
        let search = search_options(
            &raw,
            model.as_ref(),
            SearchOptions::default(),
            &["potential"],
        )?;
        let rhino = rhino_options(&raw, model.as_ref())?;
        Ok(Agents { search, rhino })
    }
    fn create(&self, kind: AgentKind) -> Box<dyn Agent> {
        match kind {
            AgentKind::Search => Box::new(SearchAgent::new(self.search.clone())),
            AgentKind::Rhino => Box::new(RhinoAgent::with_options(
                true,
                self.rhino.0.clone(),
                self.rhino.1.clone(),
            )),
        }
    }
}

/// 問 1 つを 1 回打つ。合格したかと、打った手の並び
fn trial(p: &Problem, agents: &Agents, seed: u32, r: u32) -> (bool, String) {
    let res = catch_unwind(AssertUnwindSafe(|| -> Result<(bool, String), String> {
        reset_lethal();
        reset_exact_lethal_cache();
        let start = state_from_json(&Json::parse(&p.state)?)?;
        let mut me = agents.create(p.agent);
        let mut opp = SearchAgent::new(SearchOptions::default());
        let x = mix(seed, r);
        let mut rng = MatchRng::with_shared(x, x);
        let t = play_turn(&start, p.player, &mut *me, &mut opp, &mut rng)?;
        let mut line: Vec<String> = t.steps.iter().map(|s| s.text.clone()).collect();
        if t.won {
            line.push("（勝ち）".into());
        }
        if line.is_empty() {
            line.push("（何もしない）".into());
        }
        Ok((passes(&p.pass, &t), line.join(" → ")))
    }));
    match res {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => (false, format!("（失敗: {e}）")),
        Err(_) => (false, "（失敗: 途中で止まった）".into()),
    }
}

/// 問ごとの結果
struct Score {
    id: String,
    title: String,
    passed: u32,
    trials: u32,
    /// 打った並びと回数・合格したか（多い順）
    lines: Vec<(String, u32, bool)>,
}

fn run_set(ps: &[Problem], agents: &Agents, trials: u32, seed: u32) -> Vec<Score> {
    let tasks: Vec<(usize, u32)> = (0..ps.len())
        .flat_map(|i| (0..trials).map(move |r| (i, r)))
        .collect();
    let results = parallel_map(
        &tasks,
        |&(i, r), _| trial(&ps[i], agents, seed, r),
        |_, _, _, _| {},
    );
    ps.iter()
        .enumerate()
        .map(|(i, p)| {
            let mut lines: BTreeMap<String, (u32, bool)> = BTreeMap::new();
            let mut passed = 0;
            for ((j, _), (ok, line)) in tasks.iter().zip(&results) {
                if *j != i {
                    continue;
                }
                passed += *ok as u32;
                let e = lines.entry(line.clone()).or_insert((0, *ok));
                e.0 += 1;
            }
            let mut lines: Vec<(String, u32, bool)> =
                lines.into_iter().map(|(l, (n, ok))| (l, n, ok)).collect();
            lines.sort_by(|x, y| y.1.cmp(&x.1).then(x.0.cmp(&y.0)));
            Score {
                id: p.id.clone(),
                title: p.title.clone(),
                passed,
                trials,
                lines,
            }
        })
        .collect()
}

/// 正解率（問ごとの合格率の平均）と、その標準誤差（問ごとの合格率のぶれから。問題集は決まったものとして）
fn rate_of(scores: &[Score]) -> (f64, f64) {
    let ps: Vec<(f64, f64)> = scores
        .iter()
        .filter(|s| s.trials > 0)
        .map(|s| (s.passed as f64 / s.trials as f64, s.trials as f64))
        .collect();
    if ps.is_empty() {
        return (f64::NAN, f64::NAN);
    }
    let k = ps.len() as f64;
    let rate = ps.iter().map(|x| x.0).sum::<f64>() / k;
    let var = ps.iter().map(|(p, t)| p * (1.0 - p) / t).sum::<f64>();
    (rate, var.sqrt() / k)
}

fn pct(x: f64) -> String {
    format!("{}%", fixed(x * 100.0, 1))
}

fn report(scores: &[Score], show_lines: usize) -> String {
    let mut out = String::new();
    out.push_str("| 問 | 合格 | 説明 |\n| --- | ---: | --- |\n");
    for s in scores {
        out.push_str(&format!(
            "| {} | {}/{} | {} |\n",
            s.id,
            s.passed,
            s.trials,
            s.title.replace('|', "\\|")
        ));
    }
    if show_lines > 0 {
        for s in scores {
            out.push_str(&format!("\n{}（{}/{}）\n", s.id, s.passed, s.trials));
            for (line, n, ok) in s.lines.iter().take(show_lines) {
                out.push_str(&format!(
                    "  {} {n} 回: {line}\n",
                    if *ok { "○" } else { "×" }
                ));
            }
            if s.lines.len() > show_lines {
                out.push_str(&format!("  ほか {} 通り\n", s.lines.len() - show_lines));
            }
        }
    }
    out
}

/// 引数から `name 値` を取り除く
fn take(argv: &mut Vec<String>, name: &str) -> Result<Option<String>, String> {
    ledger::take_value(argv, name)
}

fn take_flag(argv: &mut Vec<String>, name: &str) -> bool {
    let before = argv.len();
    argv.retain(|s| s != name);
    argv.len() != before
}

fn int_arg(v: Option<String>, name: &str, def: u32) -> Result<u32, String> {
    match v {
        None => Ok(def),
        Some(s) => s
            .parse::<u32>()
            .map_err(|_| format!("{name} は 0 以上の整数: {s}")),
    }
}

fn no_rest(argv: &[String]) -> Result<(), String> {
    if argv.is_empty() {
        Ok(())
    } else {
        Err(format!("知らない引数: {}", argv.join(" ")))
    }
}

fn run(argv: &[String]) -> Result<(), String> {
    let full_argv: Vec<String> = ["misses", "run"]
        .iter()
        .map(|s| s.to_string())
        .chain(argv.iter().cloned())
        .collect();
    let mut argv = argv.to_vec();
    let no_ledger = ledger::take_no_ledger(&mut argv);
    let label = take(&mut argv, "--label")?.unwrap_or_default();
    let opts = take(&mut argv, "--opts")?.unwrap_or_else(|| "{}".into());
    let trials = int_arg(take(&mut argv, "--trials")?, "--trials", TRIALS)?;
    let seed = int_arg(take(&mut argv, "--seed")?, "--seed", 1)?;
    let show = int_arg(take(&mut argv, "--lines")?, "--lines", 2)? as usize;
    let dir = take(&mut argv, "--dir")?.unwrap_or_else(|| MISSES_DIR.into());
    let only = take(&mut argv, "--only")?;
    let out = take(&mut argv, "--out")?;
    no_rest(&argv)?;
    let agents = Agents::new(&opts).map_err(|e| format!("設定: {e}"))?;
    let mut ps = load(&dir)?;
    if ps.is_empty() {
        return Err(format!("{dir} に問がありません"));
    }
    let set = set_fingerprint(&ps);
    let problems = ps.len() as u32;
    if let Some(o) = &only {
        let want: Vec<&str> = o
            .split(',')
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .collect();
        for w in &want {
            if !ps.iter().any(|p| p.id == *w) {
                return Err(format!("問がありません: {w}"));
            }
        }
        ps.retain(|p| want.contains(&p.id.as_str()));
    }
    // 回数 0 なら問題集と設定を読むだけ（夜のキューが、回す前に書き間違いを見つけるのに使う）
    if trials == 0 {
        println!("{} 問を読みました（設定も読めました）", ps.len());
        return Ok(());
    }
    let t0 = Instant::now();
    let scores = run_set(&ps, &agents, trials, seed);
    let (rate, se) = rate_of(&scores);
    let n: u32 = scores.iter().map(|s| s.trials).sum();
    let passed: u32 = scores.iter().map(|s| s.passed).sum();
    let seconds = super::seconds_since(t0);
    println!(
        "見落とし問題集（{dir}、{} 問 × {trials} 回、設定 {opts}、乱数 {seed}）\n",
        ps.len()
    );
    print!("{}", report(&scores, show));
    println!(
        "\n正解率 {}（{passed}/{n}）± {} ポイント  {}s",
        pct(rate),
        fixed(se * 100.0, 1),
        fixed(seconds, 1)
    );
    if let Some(path) = &out {
        let mut text = String::new();
        for s in &scores {
            let row = Json::Obj(vec![
                ("id".into(), Json::Str(s.id.clone())),
                ("passed".into(), Json::Num(s.passed as f64)),
                ("trials".into(), Json::Num(s.trials as f64)),
                (
                    "lines".into(),
                    Json::Arr(
                        s.lines
                            .iter()
                            .map(|(l, k, ok)| {
                                Json::Obj(vec![
                                    ("line".into(), Json::Str(l.clone())),
                                    ("n".into(), Json::Num(*k as f64)),
                                    ("pass".into(), Json::Bool(*ok)),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ]);
            text.push_str(&row.stringify());
            text.push('\n');
        }
        std::fs::write(path, text).map_err(|e| format!("{path} に書けません: {e}"))?;
    }
    // 全部の問を打った回だけ台帳に足す（--only の回は問題集の正解率にならない）
    if !no_ledger && only.is_none() {
        ledger::append_misses(&ledger::MissesRun {
            argv: full_argv,
            label,
            a: opts,
            problems,
            set,
            trials,
            seed,
            n,
            passes: passed,
            rate,
            se,
            per: scores
                .iter()
                .map(|s| (s.id.clone(), [s.passed, s.trials]))
                .collect(),
            seconds,
        });
    }
    Ok(())
}

// ---------------------------------------------------------------- 問を足す

/// 局面を取り出す元
struct Source {
    /// 最初の局面（記録・打ち直し）。手で作った局面・サンドボックスなら None
    seed: u32,
    decks: [Vec<CardIdx>; 2],
    names: [String; 2],
    agents: Option<[String; 2]>,
    /// 記録した行動の列（打ち直しなら空で、agents で打つ）
    actions: Vec<Action>,
    origin: Vec<(String, Json)>,
}

/// 記録の 1 行・1 ファイルから（`npm run game --json`・compare の `--replays`・rhino-compare の `--record`・人間の記録）
fn source_from_record(v: &Json, line_text: &str) -> Result<Source, String> {
    let kind = match v.get("kind") {
        Some(Json::Str(k)) => k.as_str(),
        _ => "",
    };
    if kind == "human-compare" || kind == "rhino-compare-human" {
        let rec = parse_record(line_text)?;
        let (s, seed) = rec.initial()?;
        let _ = s;
        let decks = &data().decks;
        let me = decks
            .iter()
            .find(|d| d.name == rec.subject.1)
            .ok_or("デッキがありません")?;
        let opp = decks
            .iter()
            .find(|d| d.name == rec.deck)
            .ok_or("デッキがありません")?;
        let (d, n) = if rec.seat == 0 {
            (
                [me.cards.clone(), opp.cards.clone()],
                [me.name.clone(), opp.name.clone()],
            )
        } else {
            (
                [opp.cards.clone(), me.cards.clone()],
                [opp.name.clone(), me.name.clone()],
            )
        };
        let mut agents = [rec.subject.2.to_string(), "search".to_string()];
        agents[rec.seat] = "human".into();
        agents[1 - rec.seat] = "search".into();
        return Ok(Source {
            seed,
            decks: d,
            names: n,
            agents: Some(agents),
            actions: rec.actions.clone(),
            origin: vec![
                ("from".into(), Json::Str("human".into())),
                ("key".into(), Json::Str(rec.key())),
            ],
        });
    }
    let seed = match v.get("seed") {
        Some(Json::Num(x)) if *x >= 0.0 && x.fract() == 0.0 => *x as u32,
        _ => return Err("記録に seed がありません".into()),
    };
    let Some(Json::Arr(ds)) = v.get("decks") else {
        return Err("記録に decks（カード ID の配列 2 つ）がありません".into());
    };
    if ds.len() != 2 {
        return Err("decks は 2 つ".into());
    }
    let ids = |d: &Json| -> Result<Vec<CardIdx>, String> {
        let Json::Arr(xs) = d else {
            return Err("decks はカード ID の配列".into());
        };
        xs.iter()
            .map(|x| match x {
                Json::Str(id) => data()
                    .card_by_id
                    .get(id.as_str())
                    .copied()
                    .ok_or_else(|| format!("知らないカード ID: {id}")),
                _ => Err("カード ID は文字列".into()),
            })
            .collect()
    };
    let decks = [ids(&ds[0])?, ids(&ds[1])?];
    let deck_name = |cards: &[CardIdx], i: usize| -> String {
        if let Some(Json::Arr(ns)) = v.get("names") {
            if let Some(Json::Str(n)) = ns.get(i) {
                return n.clone();
            }
        }
        data()
            .decks
            .iter()
            .find(|d| d.cards == cards)
            .map(|d| d.name.clone())
            .unwrap_or_else(|| "（デッキ）".into())
    };
    let names = [deck_name(&decks[0], 0), deck_name(&decks[1], 1)];
    let agents = match v.get("agents") {
        Some(Json::Arr(a)) if a.len() == 2 => match (&a[0], &a[1]) {
            (Json::Str(x), Json::Str(y)) => Some([x.clone(), y.clone()]),
            _ => None,
        },
        _ => None,
    };
    let Some(Json::Arr(acts)) = v.get("actions") else {
        return Err("記録に actions がありません".into());
    };
    let actions = acts
        .iter()
        .map(action_from_json)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Source {
        seed,
        decks,
        names,
        agents,
        actions,
        origin: vec![("from".into(), Json::Str("replay".into()))],
    })
}

/// 局面の決め方
#[derive(Clone, Copy)]
enum Target {
    /// このターン（state.turn）の最初の局面
    Turn(i32),
    /// この数の行動を打った後の局面
    Step(usize),
}

fn reached(s: &GameState, step: usize, t: Target) -> bool {
    match t {
        Target::Turn(turn) => s.phase == Phase::Main && s.turn == turn && is_start_of_turn(s),
        Target::Step(n) => step == n,
    }
}

/// 元の試合を、決めた局面まで打つ（記録の行動か、記録が無ければ agents で打つ）。
/// 局面と、そこまでの行動の列と、元の試合でその局面から手番の側がターンを終えるまでに打った手（文字）
fn replay_to(
    src: &Source,
    target: Target,
) -> Result<(GameState, Vec<Action>, Vec<String>), String> {
    let mut s = create_game([&src.decks[0], &src.decks[1]], src.seed);
    let mut done: Vec<Action> = Vec::new();
    let mut agents: Option<[Box<dyn Agent>; 2]> = None;
    // AI の乱数は playMatch（npm run game）と同じくシードから作る
    let mut rng = MatchRng::new(src.seed);
    if src.actions.is_empty() {
        let names = src.agents.as_ref().ok_or("打ち直す AI がありません")?;
        let a0 = create_agent(&names[0]).ok_or_else(|| format!("知らない AI: {}", names[0]))?;
        let a1 = create_agent(&names[1]).ok_or_else(|| format!("知らない AI: {}", names[1]))?;
        agents = Some([a0, a1]);
    }
    let mut at: Option<(GameState, usize)> = None;
    let mut played: Vec<String> = Vec::new();
    for k in 0..10_000 {
        if at.is_none() && reached(&s, k, target) {
            at = Some((s.clone(), k));
        }
        if s.phase == Phase::Ended {
            break;
        }
        let a = match agents.as_mut() {
            None => match src.actions.get(k) {
                Some(a) => a.clone(),
                None => break,
            },
            Some(ag) => {
                let legal = legal_actions(&s);
                let actor = acting_player(&s);
                rng.choose(ag[actor].as_mut(), &s, &legal)
            }
        };
        if !is_legal(&s, &a) {
            return Err(format!(
                "記録の {} 手目が今のエンジンでは打てません（{}）",
                k + 1,
                action_to_json(&a).stringify()
            ));
        }
        if let Some((start, _)) = &at {
            // 元の試合で、局面の手番の側がこのターンに打った手
            let p = acting_player(start);
            if acting_player(&s) == p && !matches!(a, Action::EndTurn | Action::ExtraPp) {
                played.push(step_text(&s, &a, p));
            }
            let end = acting_player(&s) == p && matches!(a, Action::EndTurn);
            s = apply_legal(&s, &a);
            if end || (s.phase != Phase::Ended && s.active != p) {
                break;
            }
            continue;
        }
        s = apply_legal(&s, &a);
        done.push(a);
    }
    if let Some((start, k)) = at {
        return Ok((start, done[..k].to_vec(), played));
    }
    Err(match target {
        Target::Turn(t) => format!("ターン {t} の最初の局面まで届きません（試合が先に終わった？）"),
        Target::Step(n) => format!("{n} 手目まで届きません"),
    })
}

/// JSON を読みやすく書く（オブジェクトは 1 項目 1 行。数・文字列だけの配列と、短いものは 1 行に）
fn pretty(v: &Json, indent: usize, out: &mut String) {
    let compact = v.stringify();
    let scalar_arr =
        matches!(v, Json::Arr(xs) if xs.iter().all(|x| !matches!(x, Json::Arr(_) | Json::Obj(_))));
    if indent > 0 && (compact.chars().count() <= 100 || scalar_arr) {
        out.push_str(&compact);
        return;
    }
    let pad = "  ".repeat(indent + 1);
    match v {
        Json::Obj(items) if !items.is_empty() => {
            out.push_str("{\n");
            for (i, (k, x)) in items.iter().enumerate() {
                out.push_str(&pad);
                out.push_str(&Json::Str(k.clone()).stringify());
                out.push_str(": ");
                pretty(x, indent + 1, out);
                if i + 1 < items.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&"  ".repeat(indent));
            out.push('}');
        }
        Json::Arr(xs) if !xs.is_empty() => {
            out.push_str("[\n");
            for (i, x) in xs.iter().enumerate() {
                out.push_str(&pad);
                pretty(x, indent + 1, out);
                if i + 1 < xs.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&"  ".repeat(indent));
            out.push(']');
        }
        _ => out.push_str(&compact),
    }
}

fn today() -> String {
    super::yardstick::command_line("date", &["+%Y-%m-%d"]).unwrap_or_else(|| "?".into())
}

fn ids_json(d: &[CardIdx]) -> Json {
    Json::Arr(d.iter().map(|&c| Json::Str(card(c).id.clone())).collect())
}

fn add(argv: &[String]) -> Result<(), String> {
    let mut argv = argv.to_vec();
    let id = take(&mut argv, "--id")?
        .ok_or("--id で問の名前（英数字と - の短い名前。ファイルの名前になる）を渡します")?;
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("--id は英数字と - _ だけ: {id}"));
    }
    let pass_text = take(&mut argv, "--pass")?.ok_or("--pass で合格の条件（JSON）を渡します")?;
    let pass_json =
        Json::parse(&pass_text).map_err(|e| format!("--pass が JSON として読めません: {e}"))?;
    // 書き間違い（知らない項目・カードの名前）は、局面を作る前に断る
    parse_pass(&pass_json)?;
    let title = take(&mut argv, "--title")?.unwrap_or_default();
    let note = take(&mut argv, "--note")?.unwrap_or_default();
    let source_text = take(&mut argv, "--source")?.unwrap_or_default();
    let agent = AgentKind::parse(&take(&mut argv, "--agent")?.unwrap_or_else(|| "search".into()))?;
    let dir = take(&mut argv, "--dir")?.unwrap_or_else(|| MISSES_DIR.into());
    let force = take_flag(&mut argv, "--force");
    let no_run = take_flag(&mut argv, "--no-run");
    let player_arg = take(&mut argv, "--player")?;
    let turn = take(&mut argv, "--turn")?;
    let step = take(&mut argv, "--step")?;
    let replay = take(&mut argv, "--replay")?;
    let line_no = take(&mut argv, "--line")?;
    let key = take(&mut argv, "--key")?;
    let seed = take(&mut argv, "--seed")?;
    let decks = take(&mut argv, "--decks")?;
    let agents_arg = take(&mut argv, "--agents")?;
    let two_turn = take(&mut argv, "--two-turn")?;
    let state_file = take(&mut argv, "--state")?;
    no_rest(&argv)?;
    let target = match (&turn, &step) {
        (Some(t), None) => Some(Target::Turn(
            t.parse::<i32>()
                .map_err(|_| format!("--turn は整数: {t}"))?,
        )),
        (None, Some(n)) => Some(Target::Step(
            n.parse::<usize>()
                .map_err(|_| format!("--step は 0 以上の整数: {n}"))?,
        )),
        (None, None) => None,
        _ => return Err("--turn と --step はどちらか 1 つ".into()),
    };
    let sources = [
        replay.is_some(),
        seed.is_some(),
        two_turn.is_some(),
        state_file.is_some(),
    ];
    if sources.iter().filter(|&&x| x).count() != 1 {
        return Err("局面の元は --replay・--seed・--two-turn・--state のどれか 1 つ".into());
    }
    let path = format!("{}/{id}.json", repo_path(&dir));
    if std::path::Path::new(&path).exists() && !force {
        return Err(format!("{path} はもうあります（書き直すなら --force）"));
    }

    // 局面と、出どころ（origin）
    let (state, mut origin): (GameState, Vec<(String, Json)>) = if let Some(name) = &two_turn {
        let sc = super::two_turn::SCENARIOS
            .iter()
            .find(|s| s.name == name)
            .ok_or_else(|| format!("手で作った局面がありません: {name}（svwb two-turn show）"))?;
        let s = super::two_turn::build(sc)?;
        (
            s,
            vec![
                ("from".into(), Json::Str("two-turn".into())),
                ("scenario".into(), Json::Str(sc.name.into())),
                (
                    "decks".into(),
                    Json::Arr(sc.decks.iter().map(|d| Json::Str(d.to_string())).collect()),
                ),
                ("note".into(), Json::Str(sc.note.into())),
            ],
        )
    } else if let Some(f) = &state_file {
        let text = std::fs::read_to_string(f).map_err(|e| format!("{f}: {e}"))?;
        let v = Json::parse(&text)?;
        // サンドボックスの書き出し（{"format":"svwb-sandbox","state":…}）か、状態の JSON そのもの
        let sj = match v.get("state") {
            Some(s) if v.get("format").is_some() => s.clone(),
            _ => v.clone(),
        };
        (
            state_from_json(&sj)?,
            vec![
                ("from".into(), Json::Str("state".into())),
                (
                    "file".into(),
                    Json::Str(
                        std::path::Path::new(f)
                            .file_name()
                            .map(|x| x.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                    ),
                ),
            ],
        )
    } else {
        let target = target
            .ok_or("--turn（そのターンの最初）か --step（その数の行動の後）で局面を決めます")?;
        let src = if let Some(f) = &replay {
            let text = std::fs::read_to_string(f).map_err(|e| format!("{f}: {e}"))?;
            // ファイル全体で 1 つの JSON か、JSON Lines
            let (v, line_text) = match Json::parse(&text) {
                Ok(v) => (v, text.clone()),
                Err(_) => {
                    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
                    let pick = if let Some(n) = &line_no {
                        let n: usize = n
                            .parse()
                            .map_err(|_| format!("--line は 1 からの番号: {n}"))?;
                        lines
                            .get(n.wrapping_sub(1))
                            .copied()
                            .ok_or_else(|| format!("{f} に {n} 行目がありません"))?
                    } else if let Some(k) = &key {
                        lines
                            .iter()
                            .copied()
                            .find(|l| {
                                parse_record(l).is_ok_and(|r| r.key().starts_with(k.as_str()))
                            })
                            .ok_or_else(|| format!("{f} に {k} の記録がありません"))?
                    } else if lines.len() == 1 {
                        lines[0]
                    } else {
                        return Err(format!(
                            "{f} は {} 行あります（--line か --key で選ぶ）",
                            lines.len()
                        ));
                    };
                    (Json::parse(pick)?, pick.to_string())
                }
            };
            let compact = if line_text.contains('\n') {
                v.stringify()
            } else {
                line_text
            };
            let mut s = source_from_record(&v, &compact)?;
            s.origin.push((
                "file".into(),
                Json::Str(
                    std::path::Path::new(f)
                        .file_name()
                        .map(|x| x.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                ),
            ));
            s
        } else {
            let seed: u32 = seed
                .as_ref()
                .unwrap()
                .parse()
                .map_err(|_| "--seed は 0 以上の整数")?;
            let names = decks.ok_or("--seed には --decks A,B（席 0・1 のデッキ）が要ります")?;
            let ds: Vec<&str> = names.split(',').map(str::trim).collect();
            if ds.len() != 2 {
                return Err("--decks は 2 つ".into());
            }
            let d0 = read_deck(ds[0])?;
            let d1 = read_deck(ds[1])?;
            let ags: Vec<String> = agents_arg
                .unwrap_or_else(|| "search,search".into())
                .split(',')
                .map(|x| x.trim().to_string())
                .collect();
            if ags.len() != 2 {
                return Err("--agents は 2 つ".into());
            }
            Source {
                seed,
                decks: [d0.cards.clone(), d1.cards.clone()],
                names: [d0.name.clone(), d1.name.clone()],
                agents: Some([ags[0].clone(), ags[1].clone()]),
                actions: Vec::new(),
                origin: vec![("from".into(), Json::Str("game".into()))],
            }
        };
        let (s, done, played) = replay_to(&src, target)?;
        let mut o = src.origin.clone();
        o.extend([
            ("seed".into(), Json::Num(src.seed as f64)),
            (
                "names".into(),
                Json::Arr(src.names.iter().map(|n| Json::Str(n.clone())).collect()),
            ),
        ]);
        if let Some(a) = &src.agents {
            o.push((
                "agents".into(),
                Json::Arr(a.iter().map(|n| Json::Str(n.clone())).collect()),
            ));
        }
        o.extend([
            ("turn".into(), Json::Num(s.turn as f64)),
            ("step".into(), Json::Num(done.len() as f64)),
            (
                "decks".into(),
                Json::Arr(vec![ids_json(&src.decks[0]), ids_json(&src.decks[1])]),
            ),
            (
                "actions".into(),
                Json::Arr(done.iter().map(action_to_json).collect()),
            ),
            (
                "played".into(),
                Json::Arr(played.into_iter().map(Json::Str).collect()),
            ),
        ]);
        (s, o)
    };
    if state.phase != Phase::Main {
        return Err("局面が対戦の途中ではありません".into());
    }
    let player = acting_player(&state);
    if let Some(p) = &player_arg {
        if p != &player.to_string() {
            return Err(format!("その局面の手番は {player} です（--player {p}）"));
        }
    }
    if origin.iter().all(|(k, _)| k != "turn") {
        origin.push(("turn".into(), Json::Num(state.turn as f64)));
    }
    let file = Json::Obj(vec![
        ("v".into(), Json::Num(VERSION)),
        ("id".into(), Json::Str(id.clone())),
        ("title".into(), Json::Str(title)),
        ("note".into(), Json::Str(note)),
        ("source".into(), Json::Str(source_text)),
        ("added".into(), Json::Str(today())),
        ("agent".into(), Json::Str(agent.name().into())),
        ("player".into(), Json::Num(player as f64)),
        ("pass".into(), pass_json),
        ("origin".into(), Json::Obj(origin)),
        ("state".into(), state_to_json(&state)),
    ]);
    let mut text = String::new();
    pretty(&file, 0, &mut text);
    text.push('\n');
    // 書く前に読み直して確かめる
    let p = parse_problem(&text, &path)?;
    std::fs::create_dir_all(repo_path(&dir)).map_err(|e| format!("{dir}: {e}"))?;
    std::fs::write(&path, &text).map_err(|e| format!("{path} に書けません: {e}"))?;
    println!(
        "{path} に書きました（ターン {}、手番 {player}、{}）",
        state.turn,
        agent.name()
    );
    if !no_run {
        let agents = Agents::new("{}")?;
        let scores = run_set(std::slice::from_ref(&p), &agents, TRIALS, 1);
        print!("\n今の AI（既定の設定）:\n{}", report(&scores, 3));
    }
    Ok(())
}

// ---------------------------------------------------------------- 一覧・確かめ

fn cond_text(c: &Cond) -> String {
    let pat = |p: &Pattern| -> String {
        let verb = VERBS
            .iter()
            .find(|x| x.1 == p.verb)
            .map(|x| x.0)
            .unwrap_or("?");
        let mut s = if p.verb == Verb::Mode {
            format!("mode {}", p.mode)
        } else {
            format!("{verb} {}", p.card)
        };
        if let Some(t) = &p.target {
            s.push_str(&format!(" → {t}"));
        }
        if let Some(b) = &p.by {
            s.push_str(&format!("（{b}）"));
        }
        s
    };
    let mut parts = Vec::new();
    if !c.must.is_empty() {
        parts.push(format!(
            "含む: {}",
            c.must.iter().map(pat).collect::<Vec<_>>().join("・")
        ));
    }
    if !c.must_not.is_empty() {
        parts.push(format!(
            "含まない: {}",
            c.must_not.iter().map(pat).collect::<Vec<_>>().join("・")
        ));
    }
    if c.win {
        parts.push("このターンに勝つ".into());
    }
    if let Some(h) = c.min_hp {
        parts.push(format!("ターン末の体力 {h} 以上"));
    }
    parts.join("、")
}

fn list(argv: &[String]) -> Result<(), String> {
    let mut argv = argv.to_vec();
    let dir = take(&mut argv, "--dir")?.unwrap_or_else(|| MISSES_DIR.into());
    no_rest(&argv)?;
    let ps = load(&dir)?;
    println!("| 問 | AI | ターン | 合格の条件 | 説明 |\n| --- | --- | ---: | --- | --- |");
    for p in &ps {
        let turn = p
            .raw
            .get("state")
            .and_then(|s| s.get("turn"))
            .map(|t| t.stringify())
            .unwrap_or_default();
        println!(
            "| {} | {} | {turn} | {} | {} |",
            p.id,
            p.agent.name(),
            p.pass
                .iter()
                .map(cond_text)
                .collect::<Vec<_>>()
                .join(" または ")
                .replace('|', "\\|"),
            p.title.replace('|', "\\|")
        );
    }
    println!("\n{} 問（指紋 {}）", ps.len(), set_fingerprint(&ps));
    Ok(())
}

/// 出どころの記録から打ち直して、同じ局面になるか（エンジンやカードが変わったかを見る）。記録の無い問は None
fn replays_same(p: &Problem) -> Option<Result<bool, String>> {
    let o = p.raw.get("origin")?;
    let Some(Json::Arr(acts)) = o.get("actions") else {
        return None;
    };
    let r = (|| -> Result<bool, String> {
        let seed = match o.get("seed") {
            Some(Json::Num(x)) => *x as u32,
            _ => return Err("seed がありません".into()),
        };
        let Some(Json::Arr(ds)) = o.get("decks") else {
            return Err("decks がありません".into());
        };
        let ids = |d: &Json| -> Result<Vec<CardIdx>, String> {
            let Json::Arr(xs) = d else {
                return Err("decks".into());
            };
            xs.iter()
                .map(|x| match x {
                    Json::Str(id) => data()
                        .card_by_id
                        .get(id.as_str())
                        .copied()
                        .ok_or_else(|| format!("知らないカード ID: {id}")),
                    _ => Err("カード ID".into()),
                })
                .collect()
        };
        let (d0, d1) = (ids(&ds[0])?, ids(&ds[1])?);
        let mut s = create_game([&d0, &d1], seed);
        for (k, a) in acts.iter().enumerate() {
            let a = action_from_json(a)?;
            if !is_legal(&s, &a) {
                return Err(format!("{} 手目が打てません", k + 1));
            }
            s = apply_legal(&s, &a);
        }
        let stored = p
            .raw
            .get("state")
            .map(|x| x.canonical())
            .unwrap_or_default();
        Ok(state_to_json(&s).canonical() == stored)
    })();
    Some(r)
}

fn check(argv: &[String]) -> Result<(), String> {
    let mut argv = argv.to_vec();
    let dir = take(&mut argv, "--dir")?.unwrap_or_else(|| MISSES_DIR.into());
    no_rest(&argv)?;
    let ps = load(&dir)?;
    let mut differ = 0;
    for p in &ps {
        let r = match replays_same(p) {
            None => "記録なし（手で作った局面・サンドボックス）".to_string(),
            Some(Ok(true)) => "記録から打ち直すと同じ局面".to_string(),
            Some(Ok(false)) => {
                differ += 1;
                "記録から打ち直すと違う局面（エンジンかカードが変わった。問の局面はそのまま使える）"
                    .to_string()
            }
            Some(Err(e)) => {
                differ += 1;
                format!("記録から打ち直せない（{e}）")
            }
        };
        println!("{}: 読めた。{r}", p.id);
    }
    println!(
        "\n{} 問（指紋 {}）。打ち直すと違う問 {differ}",
        ps.len(),
        set_fingerprint(&ps)
    );
    Ok(())
}

/// 問の中身を読みやすく出す（局面は手番の側から見える情報だけ）
fn show(argv: &[String]) -> Result<(), String> {
    let mut argv = argv.to_vec();
    let dir = take(&mut argv, "--dir")?.unwrap_or_else(|| MISSES_DIR.into());
    if argv.is_empty() {
        return Err("svwb misses show <問の名前>…".into());
    }
    let ps = load(&dir)?;
    for (i, id) in argv.iter().enumerate() {
        let p = ps
            .iter()
            .find(|p| &p.id == id)
            .ok_or_else(|| format!("問がありません: {id}"))?;
        let s = state_from_json(&Json::parse(&p.state)?)?;
        let o = p.raw.get("origin");
        // デッキの名前（記録からの問は names、手で作った局面は decks）
        let names: [String; 2] = match o
            .and_then(|o| o.get("names"))
            .or_else(|| o.and_then(|o| o.get("decks")))
        {
            Some(Json::Arr(ns))
                if ns.len() == 2 && ns.iter().all(|x| matches!(x, Json::Str(_))) =>
            {
                let n = |x: &Json| match x {
                    Json::Str(t) => t.clone(),
                    _ => "?".into(),
                };
                [n(&ns[0]), n(&ns[1])]
            }
            _ => ["?".into(), "?".into()],
        };
        if i > 0 {
            println!();
        }
        println!("# {}: {}", p.id, p.title);
        let text = |k: &str| str_of(&p.raw, k).unwrap_or_default();
        for (label, k) in [
            ("説明", "note"),
            ("出どころ", "source"),
            ("足した日", "added"),
        ] {
            if !text(k).is_empty() {
                println!("{label}: {}", text(k));
            }
        }
        println!(
            "AI: {}、ターン {}、手番 {}",
            p.agent.name(),
            s.turn,
            p.player
        );
        println!(
            "合格: {}",
            p.pass
                .iter()
                .map(cond_text)
                .collect::<Vec<_>>()
                .join(" または ")
        );
        for line in super::deep_gap::describe(&s, p.player, &names) {
            println!("  {line}");
        }
        if let Some(Json::Arr(xs)) = o.and_then(|o| o.get("played")) {
            let v: Vec<String> = xs
                .iter()
                .filter_map(|x| match x {
                    Json::Str(t) => Some(t.clone()),
                    _ => None,
                })
                .collect();
            println!(
                "元の試合の手: {}",
                if v.is_empty() {
                    "（何もせずターン終了）".to_string()
                } else {
                    v.join(" → ")
                }
            );
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- cover: 打ち比べ調査の候補に合格の並びがあるか

/// cover の乱数の数の既定（候補を作る AI の乱数を変える回数）
const COVER_SEEDS: u32 = 8;
/// cover の打ち比べの回数の既定（0 なら打ち比べない）
const COVER_M: u32 = 128;
/// cover で「足しても入らない」を見るために足す候補の数の既定
const COVER_WIDE: u32 = 64;

/// 並び acts を root から打ったときの 1 ターン（play_turn と同じ形。打てない手があればそこまで）
fn turn_of_plan(root: &GameState, p: PlayerIndex, acts: &[Action]) -> Turn {
    let mut t = root.clone();
    let mut steps = Vec::new();
    let mut last: Option<String> = None;
    for a in acts {
        if t.phase == Phase::Ended || !is_legal(&t, a) {
            break;
        }
        if acting_player(&t) == p {
            let st = step_of(&t, a, p, &last);
            if matches!(
                a,
                Action::Play(_)
                    | Action::Act(_)
                    | Action::Evolve(_)
                    | Action::SuperEvolve(_)
                    | Action::Fuse { .. }
                    | Action::Attack { .. }
            ) {
                last = st.cards.first().cloned();
            }
            if !matches!(a, Action::EndTurn | Action::ExtraPp) {
                steps.push(st);
            }
        }
        t = apply_legal(&t, a);
    }
    if t.phase != Phase::Ended && acting_player(&t) == p && is_legal(&t, &Action::EndTurn) {
        t = apply_legal(&t, &Action::EndTurn);
    }
    Turn {
        steps,
        won: t.phase == Phase::Ended && t.winner == Some(p),
        hp: t.players[p].leader_hp,
    }
}

/// 打ち比べ調査の候補 1 つ（調査と同じ並びの順。読み直す候補が先、足した候補が後）
struct CoverPlan {
    /// AI が読み直す候補か（false は足した候補）
    top: bool,
    /// 読み直しを始めたが、途中で打ち切られた候補か（rescoreRace。top も true）
    cut: bool,
    /// AI が選んだ並びか
    chosen: bool,
    /// 合格の条件を満たすか
    pass: bool,
    /// 打ち比べに渡す並び
    steps: Vec<Action>,
    /// 並びの文
    text: String,
    /// ターンの終わりの評価
    turn_end: f64,
    /// 探索の終点の中の順位
    rank: usize,
}

/// 問 1 つを乱数 1 つで候補にしたもの
struct CoverRow {
    /// AI がリーサルを見つけた（調査はこの局面を取らない）
    lethal: bool,
    plans: Vec<CoverPlan>,
    /// 探索の終点の数
    terminals: usize,
}

/// 問 p を、乱数 k で打ち比べ調査と同じ作り方の候補にする（足す候補は extra 個まで。考える AI の設定は opts）
fn cover_plans(
    p: &Problem,
    k: u32,
    extra: usize,
    opts: &SearchOptions,
) -> Result<CoverRow, String> {
    reset_lethal();
    reset_exact_lethal_cache();
    let start = state_from_json(&Json::parse(&p.state)?)?;
    let x = mix(7, k);
    let mut mr = MatchRng::with_shared(x, x);
    let r = mr.next(&start, p.player, false);
    let mut rng = crate::ai::Rng { state: r.state };
    let legal = legal_actions(&start);
    let agent = SearchAgent::new(opts.clone());
    let none = |lethal| CoverRow {
        lethal,
        plans: Vec::new(),
        terminals: 0,
    };
    match agent.survey_plans(&start, &legal, &mut rng, extra) {
        None => Ok(none(false)),
        Some(sv) if sv.lethal => Ok(none(true)),
        Some(sv) => {
            let root = sv.root.as_ref().unwrap_or(&start);
            let plans = sv
                .plans
                .iter()
                .map(|pl| {
                    let t = turn_of_plan(root, p.player, &pl.full);
                    let mut line: Vec<String> = t.steps.iter().map(|s| s.text.clone()).collect();
                    if line.is_empty() {
                        line.push("（何もしない）".into());
                    }
                    CoverPlan {
                        top: pl.top,
                        cut: pl.cut,
                        chosen: pl.chosen,
                        pass: passes(&p.pass, &t),
                        steps: pl.steps.clone(),
                        text: line.join(" → "),
                        turn_end: pl.turn_end,
                        rank: pl.rank,
                    }
                })
                .collect();
            Ok(CoverRow {
                lethal: false,
                plans,
                terminals: sv.terminals,
            })
        }
    }
}

/// 合格の並びが候補のどこにあるか
#[derive(Default, PartialEq, Debug)]
struct CoverWhere {
    /// AI の選んだ並びが合格
    chosen: bool,
    /// 最後まで読んだ候補に合格の並びがある
    read: bool,
    /// 読み直す候補（途中で打ち切られたものも）に合格の並びがある
    top: bool,
    /// 読み直す候補と、足した extra 個までに合格の並びがある（調査の候補に入る）
    within: bool,
    /// 足した候補の全部までに合格の並びがある
    any: bool,
    /// 調査の候補に入る合格の並びの最初のもの（plans の番号）
    first: Option<usize>,
}

fn cover_where(plans: &[CoverPlan], extra: usize) -> CoverWhere {
    let mut w = CoverWhere::default();
    let mut extras = 0;
    for (x, pl) in plans.iter().enumerate() {
        let within = pl.top || extras < extra;
        if !pl.top {
            extras += 1;
        }
        if !pl.pass {
            continue;
        }
        w.any = true;
        w.chosen |= pl.chosen;
        w.read |= pl.top && !pl.cut;
        w.top |= pl.top;
        if within {
            w.within = true;
            w.first.get_or_insert(x);
        }
    }
    w
}

/// 打ち比べる組（問の番号・AI の選んだ並び・合格の候補の並びと、それぞれの文）
struct Duel {
    problem: usize,
    ai: Vec<Action>,
    pass: Vec<Action>,
    ai_text: String,
    pass_text: String,
}

fn cover(argv: &[String]) -> Result<(), String> {
    let mut argv = argv.to_vec();
    let dir = take(&mut argv, "--dir")?.unwrap_or_else(|| MISSES_DIR.into());
    let seeds = int_arg(take(&mut argv, "--seeds")?, "--seeds", COVER_SEEDS)?;
    let m = int_arg(take(&mut argv, "--m")?, "--m", COVER_M)?;
    let extra = int_arg(take(&mut argv, "--extra")?, "--extra", 4)? as usize;
    let wide = int_arg(take(&mut argv, "--wide")?, "--wide", COVER_WIDE)? as usize;
    let show = take_flag(&mut argv, "--show");
    let only = take(&mut argv, "--only")?;
    let opts_text = take(&mut argv, "--opts")?.unwrap_or_else(|| "{}".into());
    no_rest(&argv)?;
    let wide = wide.max(extra);
    // 候補を作る AI の設定（打ち比べの続きは、調査と同じく今の既定の AI）
    let opts = Agents::new(&opts_text)?.search;
    if opts.plan_candidates > 1 {
        // survey_plans は、読み直す候補の並びを最初の手から引く。同じ最初の手の 2 つ目の並びは取り違える
        return Err("cover は planCandidates が 2 以上の設定を扱えません".into());
    }
    let mut ps = load(&dir)?;
    if let Some(o) = &only {
        let want: Vec<&str> = o.split(',').collect();
        ps.retain(|p| want.contains(&p.id.as_str()));
    }
    if ps.is_empty() {
        return Err("問がありません".into());
    }
    // 候補（問 × 乱数）
    let tasks: Vec<(usize, u32)> = (0..ps.len())
        .flat_map(|i| (0..seeds).map(move |k| (i, k)))
        .collect();
    let rows: Vec<Result<CoverRow, String>> = parallel_map(
        &tasks,
        |&(i, k), _| {
            catch_unwind(AssertUnwindSafe(|| cover_plans(&ps[i], k, wide, &opts)))
                .unwrap_or_else(|_| Err("途中で止まった".into()))
        },
        |_, _, _, _| {},
    );
    println!(
        "打ち比べ調査の候補に合格の並びがあるか（{} 問、乱数 {seeds} 通り、設定 {opts_text}）",
        ps.len()
    );
    println!();
    println!("| 問 | AI の手が合格 | 最後まで読んだ候補に合格 | 読み直す候補に合格 | 足した {extra} つまでに合格 | 足した {wide} までに合格 | リーサル |");
    println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    let mut duels: Vec<Duel> = Vec::new();
    for (i, p) in ps.iter().enumerate() {
        let (mut n, mut chosen, mut read, mut top, mut within, mut any, mut lethal) =
            (0, 0, 0, 0, 0, 0, 0);
        let mut duel_done = false;
        for ((j, k), row) in tasks.iter().zip(&rows) {
            if *j != i {
                continue;
            }
            let row = match row {
                Ok(x) => x,
                Err(e) => {
                    println!("（{} 乱数 {k}: 失敗 {e}）", p.id);
                    continue;
                }
            };
            n += 1;
            if row.lethal {
                lethal += 1;
                continue;
            }
            let w = cover_where(&row.plans, extra);
            chosen += w.chosen as u32;
            read += w.read as u32;
            top += w.top as u32;
            within += w.within as u32;
            any += w.any as u32;
            if show && *k == 0 {
                println!("  {}（乱数 0、探索の終点 {}）", p.id, row.terminals);
                for pl in &row.plans {
                    println!(
                        "    {}{}{} 順位 {} 点 {:.1}: {}",
                        match (pl.top, pl.cut) {
                            (true, false) => "読",
                            (true, true) => "切",
                            _ => "足",
                        },
                        if pl.chosen { "*" } else { " " },
                        if pl.pass { "○" } else { "×" },
                        pl.rank,
                        pl.turn_end,
                        pl.text
                    );
                }
            }
            // 打ち比べる組は、AI の手が不合格で、合格の並びが調査の候補に入った最初の乱数から取る
            if !duel_done && !w.chosen {
                if let (Some(x), Some(ch)) = (w.first, row.plans.iter().position(|pl| pl.chosen)) {
                    duels.push(Duel {
                        problem: i,
                        ai: row.plans[ch].steps.clone(),
                        pass: row.plans[x].steps.clone(),
                        ai_text: row.plans[ch].text.clone(),
                        pass_text: row.plans[x].text.clone(),
                    });
                    duel_done = true;
                }
            }
        }
        println!(
            "| {} | {chosen}/{n} | {read}/{n} | {top}/{n} | {within}/{n} | {any}/{n} | {lethal}/{n} |",
            p.id
        );
    }
    if m == 0 || duels.is_empty() {
        return Ok(());
    }
    // 打ち比べ（調査と同じ打ち方。同じ回は 2 つの並びで同じ決定化と AI の乱数）。シードは問の名前から作る（問を足しても変わらない）
    let dtasks: Vec<(usize, bool, u32)> = (0..duels.len())
        .flat_map(|d| {
            [false, true]
                .into_iter()
                .flat_map(move |w| (0..m).map(move |r| (d, w, r)))
        })
        .collect();
    let res: Vec<char> = parallel_map(
        &dtasks,
        |&(d, pass, r), _| {
            let duel = &duels[d];
            let p = &ps[duel.problem];
            let start = match Json::parse(&p.state).and_then(|j| state_from_json(&j)) {
                Ok(s) => s,
                Err(_) => return 'x',
            };
            let seed = mix(99, u32::from_str_radix(&fnv(&p.id), 16).unwrap_or(0));
            let plan = if pass { &duel.pass } else { &duel.ai };
            super::survey::playout(&start, p.player, plan, seed, r)
        },
        |_, _, _, _| {},
    );
    println!();
    println!("| 問 | AI の並びの勝ち | 合格の候補の勝ち | 差（合格 − AI） |");
    println!("| --- | ---: | ---: | ---: |");
    for (d, duel) in duels.iter().enumerate() {
        let get = |pass: bool| -> Vec<f64> {
            dtasks
                .iter()
                .zip(&res)
                .filter(|((dd, w, _), _)| *dd == d && *w == pass)
                .map(|(_, c)| match c {
                    '1' => 1.0,
                    '0' => 0.0,
                    'd' => 0.5,
                    _ => f64::NAN,
                })
                .collect()
        };
        let (wa, wb) = (get(false), get(true));
        // 同じ回どうしの差（どちらかが打てなかった回は外す）
        let diffs: Vec<f64> = wa
            .iter()
            .zip(&wb)
            .filter(|(x, y)| !x.is_nan() && !y.is_nan())
            .map(|(x, y)| y - x)
            .collect();
        let nn = diffs.len() as f64;
        let mean = diffs.iter().sum::<f64>() / nn.max(1.0);
        let var = diffs.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / (nn - 1.0).max(1.0);
        let se = (var / nn.max(1.0)).sqrt();
        let sum = |v: &[f64]| v.iter().filter(|x| !x.is_nan()).sum::<f64>();
        let count = |v: &[f64]| v.iter().filter(|x| !x.is_nan()).count();
        println!(
            "| {} | {}/{} | {}/{} | {:+.1} ± {:.1} |",
            ps[duel.problem].id,
            sum(&wa),
            count(&wa),
            sum(&wb),
            count(&wb),
            mean * 100.0,
            se * 100.0
        );
        println!("  AI: {}", duel.ai_text);
        println!("  合格: {}", duel.pass_text);
    }
    Ok(())
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let rest = argv.get(1..).unwrap_or(&[]);
    match argv.first().map(|s| s.as_str()) {
        Some("run") => run(rest),
        Some("add") => add(rest),
        Some("list") => list(rest),
        Some("show") => show(rest),
        Some("check") => check(rest),
        Some("cover") => cover(rest),
        _ => Err("使い方: svwb misses run|add|list|show|check|cover …（docs/misses.md）".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(
        verb: Verb,
        cards: &[&str],
        target: Option<&str>,
        by: Option<&str>,
        mode: usize,
    ) -> Step {
        Step {
            verb: Some(verb),
            cards: cards.iter().map(|s| s.to_string()).collect(),
            mode,
            target: target.map(|s| s.to_string()),
            by: by.map(|s| s.to_string()),
            text: String::new(),
        }
    }

    fn pass(text: &str) -> Vec<Cond> {
        parse_pass(&Json::parse(text).unwrap()).unwrap()
    }

    #[test]
    fn conditions_match_the_turn() {
        let turn = Turn {
            steps: vec![
                step(Verb::Play, &["異次元からの銃撃"], None, None, 0),
                step(
                    Verb::Choose,
                    &["楽朗の天宮・フィルドア"],
                    None,
                    Some("異次元からの銃撃"),
                    0,
                ),
                step(
                    Verb::Attack,
                    &["新たなる少女・エース"],
                    Some(OPP_LEADER),
                    None,
                    0,
                ),
                step(Verb::Play, &["理光の証明"], None, None, 0),
                step(Verb::Mode, &[], None, Some("理光の証明"), 2),
            ],
            won: false,
            hp: 11,
        };
        let ok = |t: &str| passes(&pass(t), &turn);
        assert!(ok(r#"{"must":[{"play":"異次元からの銃撃"}]}"#));
        assert!(ok(
            r#"{"must":[{"choose":"楽朗の天宮・フィルドア","by":"異次元からの銃撃"}]}"#
        ));
        assert!(!ok(
            r#"{"must":[{"choose":"楽朗の天宮・フィルドア","by":"理光の証明"}]}"#
        ));
        assert!(ok(r#"{"must":[{"target":"楽朗の天宮・フィルドア"}]}"#));
        assert!(ok(r#"{"must":[{"target":"相手のリーダー"}]}"#));
        assert!(!ok(
            r#"{"must":[{"target":"サイレントスナイパー・ワルツ"}]}"#
        ));
        assert!(ok(r#"{"must":[{"attack":"*","target":"相手のリーダー"}]}"#));
        assert!(!ok(
            r#"{"must":[{"attack":"*","target":"楽朗の天宮・フィルドア"}]}"#
        ));
        assert!(ok(r#"{"must":[{"mode":2,"by":"理光の証明"}]}"#));
        assert!(!ok(r#"{"must":[{"mode":1}]}"#));
        assert!(!ok(r#"{"mustNot":[{"play":"理光の証明"}]}"#));
        assert!(ok(
            r#"{"mustNot":[{"play":"五行の果て・クオン"},{"evolve":"*"}]}"#
        ));
        assert!(ok(r#"{"minHp":11}"#));
        assert!(!ok(r#"{"minHp":12}"#));
        assert!(!ok(r#"{"win":true}"#));
        // どれか 1 組を満たせば合格
        assert!(ok(r#"[{"win":true},{"minHp":11}]"#));
        let won = Turn {
            steps: vec![],
            won: true,
            hp: 1,
        };
        assert!(passes(&pass(r#"{"win":true,"minHp":5}"#), &won));
    }

    #[test]
    fn bad_conditions_are_refused() {
        let bad = |t: &str| parse_pass(&Json::parse(t).unwrap()).unwrap_err();
        assert!(bad(r#"{"must":[{"play":"錬金釜"}]}"#).contains("カードの名前ではありません"));
        assert!(
            bad(r#"{"must":[{"play":"魔女の錬金釜","evolve":"魔女の錬金釜"}]}"#)
                .contains("1 つだけ")
        );
        assert!(bad(r#"{"must":[{"cast":"魔女の錬金釜"}]}"#).contains("知らない項目"));
        assert!(bad(r#"{"must":[{"play":"魔女の錬金釜","by":"魔女の錬金釜"}]}"#).contains("by"));
        assert!(bad(r#"{"never":[]}"#).contains("知らない項目"));
        assert!(bad(r#"{}"#).contains("空"));
        assert!(bad(r#"[]"#).contains("空"));
    }

    #[test]
    fn pretty_keeps_scalar_arrays_on_one_line() {
        let v = Json::parse(r#"{"a":1,"b":[1,2,3],"c":{"d":[{"x":1},{"y":2}]}}"#).unwrap();
        let mut s = String::new();
        pretty(&v, 0, &mut s);
        assert_eq!(
            s,
            "{\n  \"a\": 1,\n  \"b\": [1,2,3],\n  \"c\": {\"d\":[{\"x\":1},{\"y\":2}]}\n}"
        );
        assert_eq!(Json::parse(&s).unwrap(), v);
    }

    #[test]
    fn rate_is_the_mean_of_problem_rates() {
        let s = |p, t| Score {
            id: String::new(),
            title: String::new(),
            passed: p,
            trials: t,
            lines: vec![],
        };
        let (r, se) = rate_of(&[s(24, 24), s(12, 24), s(0, 24)]);
        assert!((r - 0.5).abs() < 1e-12);
        assert!((se - (0.25f64 / 24.0).sqrt() / 3.0).abs() < 1e-12);
    }

    /// リポジトリの問題集は全部読め、記録のある問は打ち直すと同じ局面になる
    #[test]
    fn repository_problems_load() {
        let ps = load(MISSES_DIR).expect("問題集が読めます");
        assert!(!ps.is_empty());
        for p in &ps {
            if let Some(r) = replays_same(p) {
                assert_eq!(r, Ok(true), "{}: 記録から打ち直すと同じ局面", p.id);
            }
        }
    }

    fn cover_plan(kind: char, chosen: bool, pass: bool) -> CoverPlan {
        CoverPlan {
            top: kind != 'x',
            cut: kind == 'c',
            chosen,
            pass,
            steps: Vec::new(),
            text: String::new(),
            turn_end: 0.0,
            rank: 0,
        }
    }

    /// 合格の並びが、最後まで読んだ候補・途中で打ち切られた候補・足した extra 個まで・その先のどこにあるかを分ける
    #[test]
    fn cover_where_separates_the_layers() {
        let flags = |w: &CoverWhere| (w.chosen, w.read, w.top, w.within, w.any, w.first);
        // 最後まで読んだ候補 2 つ（AI の手は不合格）、足した候補 3 つ（3 つ目だけ合格）
        let plans = vec![
            cover_plan('r', true, false),
            cover_plan('r', false, false),
            cover_plan('x', false, false),
            cover_plan('x', false, false),
            cover_plan('x', false, true),
        ];
        assert_eq!(
            flags(&cover_where(&plans, 2)),
            (false, false, false, false, true, None)
        );
        assert_eq!(
            flags(&cover_where(&plans, 3)),
            (false, false, false, true, true, Some(4))
        );
        // 最後まで読んだ候補に合格があれば、足す数に関係なく候補に入る
        let plans = vec![cover_plan('r', true, false), cover_plan('r', false, true)];
        assert_eq!(
            flags(&cover_where(&plans, 0)),
            (false, true, true, true, true, Some(1))
        );
        // 途中で打ち切られた候補の合格は、読み直す候補には数えるが、最後まで読んだ候補には数えない
        let plans = vec![cover_plan('r', true, false), cover_plan('c', false, true)];
        assert_eq!(
            flags(&cover_where(&plans, 0)),
            (false, false, true, true, true, Some(1))
        );
        // AI の手が合格
        let w = cover_where(&[cover_plan('r', true, true)], 0);
        assert!(w.chosen && w.read && w.top && w.within && w.any);
        assert_eq!(cover_where(&[], 4), CoverWhere::default());
    }

    /// 問を調査の候補にすると、AI の選んだ並びがちょうど 1 つあり、読み直す候補が先に並ぶ
    #[test]
    fn cover_plans_follow_the_survey_candidates() {
        let ps = load(MISSES_DIR).expect("問題集が読めます");
        let p = ps
            .iter()
            .find(|p| p.id == "witch-omega-heal")
            .expect("問があります");
        let row = cover_plans(p, 0, 4, &SearchOptions::default()).expect("候補が作れます");
        assert!(!row.lethal);
        assert_eq!(row.plans.iter().filter(|pl| pl.chosen).count(), 1);
        assert!(row.plans.iter().all(|pl| !pl.chosen || (pl.top && !pl.cut)));
        assert!(row.plans.iter().all(|pl| !pl.cut || pl.top));
        assert!(row.plans.iter().filter(|pl| !pl.top).count() <= 4);
        let first_extra = row
            .plans
            .iter()
            .position(|pl| !pl.top)
            .unwrap_or(row.plans.len());
        assert!(row.plans[first_extra..].iter().all(|pl| !pl.top));
        assert!(row.terminals >= row.plans.len());
    }
}
