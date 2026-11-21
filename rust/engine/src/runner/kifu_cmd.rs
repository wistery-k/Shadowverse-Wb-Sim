//! 棋譜を打ち直して数えるコマンド（docs/kifu.md「数える」）。調べ物はランナーに専用の処理を足さず、これで引く。
//!
//!   svwb kifu count <棋譜>… --event '<種類>[|<種類>…] [<条件>…]' [--where '<条件>,…'] [--per seat|game|turn] [--by <分け方>,…]
//!   svwb kifu winrate <棋譜>… [--where '<条件>,…'] [--by <分け方>,…]
//!   svwb kifu events <棋譜>… [--where '<条件>,…'] [--event '…'] [--out 出来事.jsonl]
//!   svwb kifu seats <棋譜>… [--where '<条件>,…'] [--out 席.jsonl]
//!   svwb kifu values <棋譜>… [--opts '<設定>'] [--reads N] [--where '<条件>,…'] [--out ターン末.jsonl]
//!
//! - 棋譜は、ファイルかフォルダ（中の `.jsonl`・`.jsonl.gz` を全部。`.tmp` は読まない）。`.gz` は `gzip -dc` で読む
//! - count・events は試合を打ち直して出来事の列（replay_index.rs）にする。打ち直せない試合（エンジンの版が違って打てない手がある）と、
//!   打ち直した勝者が棋譜と違う試合は数えず、その数を出す。winrate・seats は打ち直さない（棋譜の勝者を使う）
//! - seats は、合った席ごとに 1 行（棋譜・回・試合番号・組・席・デッキ・相手・側・AI・案・先攻・勝ち）を JSON Lines で出す。
//!   ランナーが前に書いていた試合ごとの勝ち負けの行（rhino-compare・deck-compare の `--out`）の代わり。表にない比べ方（組ごとの入れ替わり等）は jq 等で
//! - values は、合った席のターン末ごとに、--opts の探索 AI が付けるターン末の値（と --reads N なら相手のターンを読んだ値）と、
//!   その後の決着の印（次の相手のターンに負け・自分の次のターンに勝ち）を 1 行ずつ出す（docs/kifu.md「ターン末の値」）
//! - 席を単位にする: `--where` は席ごとに見る（その席から見た自分・相手）。条件は「,」で区切り、全部に合う席だけを数える
//! - 勝率の誤差は、同じ棋譜の同じ試合番号（席とデッキを入れ替えた組）をまとまりにした誤差（compare の組の誤差と同じ）

use super::fixed;
use super::kifu::parse_replay;
use super::parallel::parallel_map;
use crate::data::{data, CardIdx};
use crate::json::Json;
use crate::replay_index::replay_index;
use crate::state::Action;
use std::collections::BTreeMap;
use std::io::Write;

// ---------------------------------------------------------------- 読む

/// 棋譜の 1 試合の行（ファイルの番号と行）
struct Line {
    file: usize,
    text: String,
}

/// 渡したファイル・フォルダから、棋譜のファイルを並べる（フォルダは中を全部。名前の順）
fn kifu_files(inputs: &[String]) -> Result<Vec<String>, String> {
    fn walk(dir: &std::path::Path, out: &mut Vec<String>) -> Result<(), String> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .map_err(|e| format!("{} を読めません: {e}", dir.display()))?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                walk(&p, out)?;
            } else {
                let name = p.to_string_lossy();
                if name.ends_with(".jsonl") || name.ends_with(".jsonl.gz") {
                    out.push(name.into_owned());
                }
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    for x in inputs {
        let p = std::path::Path::new(x);
        if p.is_dir() {
            walk(p, &mut out)?;
        } else if p.exists() {
            out.push(x.clone());
        } else {
            return Err(format!("{x} がありません"));
        }
    }
    if out.is_empty() {
        return Err("棋譜のファイルがありません（.jsonl・.jsonl.gz）".into());
    }
    Ok(out)
}

/// ファイルの中身（.gz は gzip -dc で展開する。misses add --replay も使う）
pub fn read_text(path: &str) -> Result<String, String> {
    if path.ends_with(".gz") {
        let out = std::process::Command::new("gzip")
            .args(["-dc", path])
            .output()
            .map_err(|e| format!("{path}: gzip を起動できません: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "{path} を展開できません: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        String::from_utf8(out.stdout).map_err(|e| format!("{path}: {e}"))
    } else {
        std::fs::read_to_string(path).map_err(|e| format!("{path} を読めません: {e}"))
    }
}

/// 棋譜の行を全部読む（棋譜でない行は飛ばす）
fn read_lines(files: &[String]) -> Result<Vec<Line>, String> {
    let mut out = Vec::new();
    for (i, f) in files.iter().enumerate() {
        for l in read_text(f)?.lines() {
            if l.starts_with("{\"kind\":\"replay\"") {
                out.push(Line {
                    file: i,
                    text: l.to_string(),
                });
            }
        }
    }
    if out.is_empty() {
        return Err("棋譜の行（{\"kind\":\"replay\", …}）がありません".into());
    }
    Ok(out)
}

/// 渡したファイル・フォルダの棋譜の行を全部読む（ほかのランナーが棋譜を読む口。defer-playout 等）
pub fn read_kifu(inputs: &[String]) -> Result<Vec<Json>, String> {
    read_lines(&kifu_files(inputs)?)?
        .iter()
        .map(|l| Json::parse(&l.text))
        .collect()
}

/// 1 試合の、席に関わらないこと
struct Meta {
    file: usize,
    g: u32,
    swap: Option<bool>,
    run: String,
    source: String,
    engine: String,
    pool: String,
    names: [String; 2],
    sides: [String; 2],
    agents: [String; 2],
    /// 席のデッキの案の名前（deck-compare の比べるデッキの席。元のデッキは「元のデッキ」。案の無い席は空）
    variants: [String; 2],
    /// 先攻の席（版 1 の行には無い）
    first: Option<usize>,
    winner: Option<usize>,
}

pub fn str_of(v: Option<&Json>) -> String {
    match v {
        Some(Json::Str(s)) => s.clone(),
        _ => String::new(),
    }
}

fn pair_of(v: Option<&Json>) -> [String; 2] {
    match v {
        Some(Json::Arr(xs)) if xs.len() == 2 => [str_of(xs.first()), str_of(xs.get(1))],
        _ => [String::new(), String::new()],
    }
}

fn seat_of(v: Option<&Json>) -> Option<usize> {
    match v {
        Some(Json::Num(x)) if *x == 0.0 || *x == 1.0 => Some(*x as usize),
        _ => None,
    }
}

fn meta_of(file: usize, v: &Json) -> Meta {
    Meta {
        file,
        g: match v.get("g") {
            Some(Json::Num(x)) => *x as u32,
            _ => 0,
        },
        swap: match v.get("swap") {
            Some(Json::Bool(b)) => Some(*b),
            _ => None,
        },
        run: str_of(v.get("run")),
        source: str_of(v.get("source")),
        engine: str_of(v.get("engine")),
        pool: str_of(v.get("pool")),
        names: pair_of(v.get("names")),
        sides: pair_of(v.get("sides")),
        agents: pair_of(v.get("agents")),
        variants: pair_of(v.get("variants")),
        first: seat_of(v.get("first")),
        winner: seat_of(v.get("winner")),
    }
}

/// デッキの型（名前の「（」の前。デッキの組のファイルの名前は「型（大会）」）
fn archetype(name: &str) -> &str {
    name.split('（').next().unwrap_or(name)
}

/// カードの名前（クレストなら「クレスト：」の後の名前）。知らない ID はそのまま
fn name_of(id: &str) -> String {
    if let Some(&c) = data().card_by_id.get(id) {
        return crate::state::card(c).name.clone();
    }
    if let Some(c) = data().crests.iter().find(|c| c.id == id) {
        return c.name.clone();
    }
    id.to_string()
}

// ---------------------------------------------------------------- 条件

#[derive(Clone, Debug, PartialEq)]
enum Op {
    Has,
    NotHas,
    Eq,
    Ne,
    Ge,
    Le,
    Gt,
    Lt,
    Flag,
}

/// 条件 1 つ（`deck~アグロNi|クキシロB`・`side=A`・`n>=3`・`own` など）
#[derive(Clone, Debug)]
struct Cond {
    key: String,
    op: Op,
    /// 「|」で並べた値（どれかに合えばよい）
    vals: Vec<String>,
}

fn parse_cond(s: &str) -> Result<Cond, String> {
    let s = s.trim();
    for (pat, op) in [
        (">=", Op::Ge),
        ("<=", Op::Le),
        ("!=", Op::Ne),
        ("!~", Op::NotHas),
        ("~", Op::Has),
        ("=", Op::Eq),
        (">", Op::Gt),
        ("<", Op::Lt),
    ] {
        if let Some(i) = s.find(pat) {
            let key = s[..i].trim().to_string();
            let val = s[i + pat.len()..].trim();
            if key.is_empty() || val.is_empty() {
                return Err(format!("条件が読めません: {s}"));
            }
            return Ok(Cond {
                key,
                op,
                vals: val.split('|').map(|x| x.to_string()).collect(),
            });
        }
    }
    if s.is_empty() || !s.chars().all(|c| c.is_alphanumeric()) {
        return Err(format!("条件が読めません: {s}"));
    }
    Ok(Cond {
        key: s.to_string(),
        op: Op::Flag,
        vals: Vec::new(),
    })
}

/// 文字列の値と条件
fn text_ok(c: &Cond, v: &str) -> bool {
    match c.op {
        Op::Has => c.vals.iter().any(|x| v.contains(x.as_str())),
        Op::NotHas => !c.vals.iter().any(|x| v.contains(x.as_str())),
        Op::Eq => c.vals.iter().any(|x| v == x),
        Op::Ne => !c.vals.iter().any(|x| v == x),
        _ => false,
    }
}

/// 数の値と条件（`g=10-20` の範囲も）
fn num_ok(c: &Cond, v: f64) -> Result<bool, String> {
    let one = |x: &str| -> Result<f64, String> {
        x.parse::<f64>()
            .map_err(|_| format!("{} の値が数ではありません: {x}", c.key))
    };
    Ok(match c.op {
        Op::Eq | Op::Ne => {
            let mut hit = false;
            for x in &c.vals {
                hit |= match x.split_once('-') {
                    Some((a, b)) if !a.is_empty() => one(a)? <= v && v <= one(b)?,
                    _ => one(x)? == v,
                };
            }
            hit == (c.op == Op::Eq)
        }
        Op::Ge => v >= one(&c.vals[0])?,
        Op::Le => v <= one(&c.vals[0])?,
        Op::Gt => v > one(&c.vals[0])?,
        Op::Lt => v < one(&c.vals[0])?,
        _ => return Err(format!("{} は数の条件（=・>=・<=・>・<）で書きます", c.key)),
    })
}

/// 席の条件（--where）。seat から見た自分・相手
fn seat_ok(c: &Cond, m: &Meta, seat: usize) -> Result<bool, String> {
    let opp = 1 - seat;
    let flag = |b: bool| -> Result<bool, String> {
        if c.op == Op::Flag {
            Ok(b)
        } else {
            Err(format!("{} は値を付けずに書きます", c.key))
        }
    };
    let text = |v: &str| -> Result<bool, String> {
        match c.op {
            Op::Has | Op::NotHas | Op::Eq | Op::Ne => Ok(text_ok(c, v)),
            _ => Err(format!("{} は文字の条件（~・!~・=・!=）で書きます", c.key)),
        }
    };
    match c.key.as_str() {
        "deck" => text(&m.names[seat]),
        "arch" => text(archetype(&m.names[seat])),
        "opp" => text(&m.names[opp]),
        "oppArch" => text(archetype(&m.names[opp])),
        // 組（どちらかの席のデッキ）
        "pair" => Ok(match c.op {
            Op::NotHas | Op::Ne => text(&m.names[0])? && text(&m.names[1])?,
            _ => text(&m.names[0])? || text(&m.names[1])?,
        }),
        "side" => text(&m.sides[seat]),
        "agent" => text(&m.agents[seat]),
        "variant" => text(&m.variants[seat]),
        "run" => text(&m.run),
        "source" => text(&m.source),
        "engine" => text(&m.engine),
        "pool" => text(&m.pool),
        "g" => num_ok(c, m.g as f64),
        "seat" => num_ok(c, seat as f64),
        "swap" => num_ok(c, m.swap.map_or(-1.0, |b| f64::from(u8::from(b)))),
        "first" => flag(m.first == Some(seat)),
        "second" => flag(m.first == Some(opp)),
        "won" => flag(m.winner == Some(seat)),
        "lost" => flag(m.winner == Some(opp)),
        "draw" => flag(m.winner.is_none()),
        k => Err(format!(
            "知らない席の条件: {k}（deck・arch・opp・oppArch・pair・side・agent・variant・run・source・engine・pool・g・seat・swap・first・second・won・lost・draw）"
        )),
    }
}

fn parse_where(specs: &[String]) -> Result<Vec<Cond>, String> {
    let mut out = Vec::new();
    for s in specs {
        for part in s.split(',').filter(|x| !x.trim().is_empty()) {
            out.push(parse_cond(part)?);
        }
    }
    Ok(out)
}

/// 数える出来事（--event '<種類>[|<種類>…] <条件>…'）
pub struct EventSpec {
    kinds: Vec<String>,
    conds: Vec<Cond>,
}

const EVENT_KINDS: [&str; 23] = [
    "mulligan",
    "play",
    "attack",
    "act",
    "fuse",
    "extraPp",
    "enter",
    "leave",
    "evolve",
    "superEvolve",
    "trigger",
    "draw",
    "addHand",
    "damage",
    "heal",
    "destroy",
    "banish",
    "bounce",
    "crestIn",
    "crestOut",
    "pp",
    "maxPp",
    "turnEnd",
];

pub fn parse_event(s: &str) -> Result<EventSpec, String> {
    let mut words = s.split_whitespace();
    let kinds: Vec<String> = words
        .next()
        .ok_or("--event に出来事の種類を書きます")?
        .split('|')
        .map(|x| x.to_string())
        .collect();
    for k in &kinds {
        if !EVENT_KINDS.contains(&k.as_str()) {
            return Err(format!(
                "知らない出来事の種類: {k}（{}）",
                EVENT_KINDS.join("・")
            ));
        }
    }
    Ok(EventSpec {
        kinds,
        conds: words.map(parse_cond).collect::<Result<_, _>>()?,
    })
}

pub fn num_field(e: &Json, k: &str) -> Option<f64> {
    match e.get(k) {
        Some(Json::Num(x)) => Some(*x),
        Some(Json::Arr(xs)) => Some(xs.len() as f64),
        Some(Json::Bool(b)) => Some(f64::from(u8::from(*b))),
        _ => None,
    }
}

/// 出来事の条件。turn はその出来事のあったターン（n・p・tc）
pub fn event_ok(spec: &EventSpec, e: &Json, turn: &Json) -> Result<bool, String> {
    let k = str_of(e.get("k"));
    if !spec.kinds.contains(&k) {
        return Ok(false);
    }
    let p = num_field(e, "p");
    let is_crest = e.get("crest") == Some(&Json::Bool(true)) || k.starts_with("crest");
    for c in &spec.conds {
        // カードの条件は id か名前のどちらかに合えばよい（!~・!= はどちらにも合わない）
        let card = |id: &str| -> Result<bool, String> {
            let name = name_of(id);
            match c.op {
                Op::Has | Op::Eq => Ok(text_ok(c, id) || text_ok(c, &name)),
                Op::NotHas | Op::Ne => Ok(text_ok(c, id) && text_ok(c, &name)),
                _ => Err(format!("{} は文字の条件（~・!~・=・!=）で書きます", c.key)),
            }
        };
        let flag = |b: bool| -> Result<bool, String> {
            if c.op == Op::Flag {
                Ok(b)
            } else {
                Err(format!("{} は値を付けずに書きます", c.key))
            }
        };
        let ok = match c.key.as_str() {
            "card" => card(&str_of(e.get("c")))?,
            "crest" if c.op == Op::Flag => is_crest,
            "crest" => is_crest && card(&str_of(e.get("c")))?,
            "target" => card(&str_of(e.get("t")))?,
            // turnEnd の、持っているクレスト（どれかが合えばよい。!~・!= はどれにも合わない）
            "holds" => {
                let ids: Vec<String> = match e.get("crests") {
                    Some(Json::Arr(xs)) => xs.iter().map(|x| str_of(Some(x))).collect(),
                    _ => Vec::new(),
                };
                match c.op {
                    Op::Has | Op::Eq => ids.iter().map(|i| card(i)).collect::<Result<Vec<_>, _>>()?.into_iter().any(|b| b),
                    Op::NotHas | Op::Ne => ids.iter().map(|i| card(i)).collect::<Result<Vec<_>, _>>()?.into_iter().all(|b| b),
                    _ => return Err("holds は文字の条件（~・!~・=・!=）で書きます".into()),
                }
            }
            "as" => card(&str_of(e.get("as")))?,
            "mode" => match c.op {
                Op::Has | Op::NotHas | Op::Eq | Op::Ne => text_ok(c, &str_of(e.get("mode"))),
                _ => return Err("mode は文字の条件（~・!~・=・!=）で書きます".into()),
            },
            // その出来事の持ち主のターンか（誘発は own と同じ）
            "own" | "opp" => {
                let own = p.is_some() && p == num_field(turn, "p");
                flag(own == (c.key == "own"))?
            }
            "search" | "burned" | "ep" | "ret" => flag(e.get(&c.key) == Some(&Json::Bool(true)))?,
            "turn" => num_ok(c, num_field(turn, "n").unwrap_or(0.0))?,
            "tc" => num_ok(c, num_field(turn, "tc").unwrap_or(0.0))?,
            key @ ("n" | "pp" | "ab" | "playable" | "i" | "ougi" | "combo") => match num_field(e, key) {
                Some(v) => num_ok(c, v)?,
                None => false,
            },
            key => {
                return Err(format!(
                    "知らない出来事の条件: {key}（card・crest・holds・target・as・mode・own・opp・search・burned・ep・ret・turn・tc・n・pp・ab・playable・combo・i・ougi）"
                ))
            }
        };
        if !ok {
            return Ok(false);
        }
    }
    Ok(true)
}

// ---------------------------------------------------------------- 分ける

/// 分け方（--by）の値。seat の席から見る
fn by_value(k: &str, m: &Meta, seat: usize, files: &[String]) -> Result<String, String> {
    let opp = 1 - seat;
    Ok(match k {
        "deck" => m.names[seat].clone(),
        "arch" => archetype(&m.names[seat]).to_string(),
        "opp" => m.names[opp].clone(),
        "oppArch" => archetype(&m.names[opp]).to_string(),
        "side" => m.sides[seat].clone(),
        "agent" => m.agents[seat].clone(),
        "variant" => m.variants[seat].clone(),
        "first" => match m.first {
            Some(f) if f == seat => "先攻".into(),
            Some(_) => "後攻".into(),
            None => "?".into(),
        },
        "result" => match m.winner {
            Some(w) if w == seat => "勝ち".into(),
            Some(_) => "負け".into(),
            None => "引き分け".into(),
        },
        "seat" => seat.to_string(),
        "run" => m.run.clone(),
        "source" => m.source.clone(),
        "engine" => m.engine.clone(),
        "pool" => m.pool.clone(),
        "file" => std::path::Path::new(&files[m.file])
            .file_name()
            .map_or_else(String::new, |f| f.to_string_lossy().into_owned()),
        _ => {
            return Err(format!(
                "知らない分け方: {k}（deck・arch・opp・oppArch・side・agent・variant・first・result・seat・run・source・engine・pool・file）"
            ))
        }
    })
}

// ---------------------------------------------------------------- 引数

struct Args {
    inputs: Vec<String>,
    flags: Vec<(String, String)>,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut inputs = Vec::new();
    let mut flags = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if let Some(k) = a.strip_prefix("--") {
            let v = argv
                .get(i + 1)
                .ok_or_else(|| format!("--{k} の後に値を書きます"))?;
            flags.push((k.to_string(), v.clone()));
            i += 2;
        } else {
            inputs.push(a.clone());
            i += 1;
        }
    }
    if inputs.is_empty() {
        return Err("棋譜のファイルかフォルダを渡します".into());
    }
    Ok(Args { inputs, flags })
}

impl Args {
    fn all(&self, k: &str) -> Vec<String> {
        self.flags
            .iter()
            .filter(|(x, _)| x == k)
            .map(|(_, v)| v.clone())
            .collect()
    }
    fn one(&self, k: &str) -> Option<String> {
        self.flags
            .iter()
            .rev()
            .find(|(x, _)| x == k)
            .map(|(_, v)| v.clone())
    }
    fn check(&self, known: &[&str]) -> Result<(), String> {
        for (k, _) in &self.flags {
            if !known.contains(&k.as_str()) {
                return Err(format!("知らない引数: --{k}"));
            }
        }
        Ok(())
    }
    fn by(&self) -> Vec<String> {
        self.all("by")
            .iter()
            .flat_map(|s| s.split(','))
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect()
    }
}

// ---------------------------------------------------------------- 打ち直す

/// 打ち直した 1 試合（出来事の列のまとめ）。打ち直せなければ Err（理由）
fn replay(v: &Json) -> Result<Json, String> {
    let r = parse_replay(v)?;
    let idx = replayed([&r.decks[0], &r.decks[1]], r.seed, &r.actions)?;
    let recorded = v.get("winner");
    if recorded.is_some() && idx.get("winner") != recorded {
        return Err("打ち直した勝者が棋譜と違う（エンジンの版が違う）".into());
    }
    Ok(idx)
}

/// 試合を打ち直して出来事の列にする（replay_index）。最初のターンの前の出来事（"pre"。始めから持っているクレストやマリガン）は、
/// 手番の無いターン 0（n・tc が 0、p が無い）として turns の先頭に入れる（own・opp には合わず、その席の自分のターンの番号は 0）
pub fn replayed(decks: [&[CardIdx]; 2], seed: u32, actions: &[Action]) -> Result<Json, String> {
    let mut idx = replay_index(decks, seed, actions)?;
    if let Some(Json::Arr(pre)) = idx.get("pre").cloned() {
        if !pre.is_empty() {
            let mut turns = vec![Json::Obj(vec![
                ("n".into(), Json::Num(0.0)),
                ("tc".into(), Json::Num(0.0)),
                ("ev".into(), Json::Arr(pre)),
            ])];
            turns.extend(turns_of(&idx).iter().cloned());
            idx.set("turns", Json::Arr(turns));
        }
    }
    Ok(idx)
}

/// 席 seat の出来事を順に f に渡す（出来事のあったターンと、そのときの席の自分のターンの番号。最初の自分のターンの前は 0）
pub fn seat_events(
    idx: &Json,
    seat: usize,
    mut f: impl FnMut(&Json, &Json, u32) -> Result<(), String>,
) -> Result<(), String> {
    let mut own_tc = 0u32;
    for t in turns_of(idx) {
        if num_field(t, "p") == Some(seat as f64) {
            own_tc = num_field(t, "tc").unwrap_or(0.0) as u32;
        }
        for e in events_of(t) {
            if num_field(e, "p") == Some(seat as f64) {
                f(t, e, own_tc)?;
            }
        }
    }
    Ok(())
}

pub fn turns_of(idx: &Json) -> &[Json] {
    match idx.get("turns") {
        Some(Json::Arr(t)) => t,
        _ => &[],
    }
}

pub fn events_of(turn: &Json) -> &[Json] {
    match turn.get("ev") {
        Some(Json::Arr(e)) => e,
        _ => &[],
    }
}

/// 打ち直せなかった試合と、棋譜のエンジンの版のまとめを出す
fn report_skips(skipped: &[(usize, String)], engines: &BTreeMap<String, usize>, total: usize) {
    let now = super::ledger::context().2;
    let others: Vec<String> = engines
        .iter()
        .filter(|(e, _)| **e != now && !e.is_empty())
        .map(|(e, n)| format!("{e}（{n} 試合）"))
        .collect();
    if !others.is_empty() {
        eprintln!(
            "注意: 今のエンジン（{now}）と違う版の棋譜があります: {}。ルールやカードの能力を直した後なら、試合が変わることがあります",
            others.join("・")
        );
    }
    if !skipped.is_empty() {
        eprintln!(
            "打ち直せなかった試合 {} / {total}（数えていない）。初めの 3 つ:",
            skipped.len()
        );
        for (i, why) in skipped.iter().take(3) {
            eprintln!("  {i} 行目: {why}");
        }
    }
}

// ---------------------------------------------------------------- count

#[derive(Clone, Copy, PartialEq)]
enum Per {
    Seat,
    Game,
    Turn,
}

/// 1 つの単位（席・試合・ターン）の数
struct Unit {
    key: Vec<String>,
    count: u64,
    /// 最初の出来事のときの、その席の自分のターンの番号（席・試合の単位だけ）
    first_tc: Option<u32>,
}

fn count(argv: &[String]) -> Result<(), String> {
    let a = parse_args(argv)?;
    a.check(&["event", "where", "per", "by"])?;
    let spec = parse_event(&a.one("event").ok_or("--event で数える出来事を書きます")?)?;
    let conds = parse_where(&a.all("where"))?;
    let per = match a.one("per").as_deref() {
        None | Some("seat") => Per::Seat,
        Some("game") => Per::Game,
        Some("turn") => Per::Turn,
        Some(x) => return Err(format!("--per は seat・game・turn: {x}")),
    };
    let by = a.by();
    let files = kifu_files(&a.inputs)?;
    let lines = read_lines(&files)?;
    let results = parallel_map(
        &lines,
        |l, _| -> Result<Result<(String, Vec<Unit>), String>, String> {
            let v = Json::parse(&l.text)?;
            let m = meta_of(l.file, &v);
            let idx = match replay(&v) {
                Ok(x) => x,
                Err(why) => return Ok(Err(why)),
            };
            let mut units = Vec::new();
            let mut game_unit: Option<Unit> = None;
            for seat in 0..2 {
                let mut pass = true;
                for c in &conds {
                    pass &= seat_ok(c, &m, seat)?;
                }
                if !pass {
                    continue;
                }
                let key = by
                    .iter()
                    .map(|k| by_value(k, &m, seat, &files))
                    .collect::<Result<Vec<_>, _>>()?;
                // 自分のターンの番号（今までに始まった自分のターンの数）
                let mut own_tc = 0u32;
                let mut seat_unit = Unit {
                    key: key.clone(),
                    count: 0,
                    first_tc: None,
                };
                for t in turns_of(&idx) {
                    let mine = num_field(t, "p") == Some(seat as f64);
                    if mine {
                        own_tc = num_field(t, "tc").unwrap_or(0.0) as u32;
                    }
                    let mut n = 0u64;
                    for e in events_of(t) {
                        if num_field(e, "p") == Some(seat as f64) && event_ok(&spec, e, t)? {
                            n += 1;
                        }
                    }
                    if per == Per::Turn {
                        if mine {
                            units.push(Unit {
                                key: key.clone(),
                                count: n,
                                first_tc: None,
                            });
                        }
                    } else if n > 0 {
                        seat_unit.count += n;
                        seat_unit.first_tc.get_or_insert(own_tc);
                    }
                }
                match per {
                    Per::Seat => units.push(seat_unit),
                    Per::Game => {
                        let u = game_unit.get_or_insert(Unit {
                            key,
                            count: 0,
                            first_tc: None,
                        });
                        u.count += seat_unit.count;
                        u.first_tc = match (u.first_tc, seat_unit.first_tc) {
                            (Some(x), Some(y)) => Some(x.min(y)),
                            (x, y) => x.or(y),
                        };
                    }
                    Per::Turn => {}
                }
            }
            units.extend(game_unit);
            Ok(Ok((m.engine, units)))
        },
        |_, _, _, _| {},
    );
    let mut skipped = Vec::new();
    let mut engines: BTreeMap<String, usize> = BTreeMap::new();
    let mut groups: BTreeMap<Vec<String>, Vec<Unit>> = BTreeMap::new();
    for (i, r) in results.into_iter().enumerate() {
        match r? {
            Err(why) => skipped.push((i + 1, why)),
            Ok((engine, units)) => {
                *engines.entry(engine).or_insert(0) += 1;
                for u in units {
                    groups.entry(u.key.clone()).or_default().push(u);
                }
            }
        }
    }
    report_skips(&skipped, &engines, lines.len());
    let unit_name = match per {
        Per::Seat => "席",
        Per::Game => "試合",
        Per::Turn => "ターン",
    };
    let mut head: Vec<String> = by.clone();
    head.extend(
        [
            unit_name,
            "数",
            &format!("{unit_name}あたり"),
            "あった",
            &format!("あった{unit_name}あたり"),
            "最初のターン",
        ]
        .map(String::from),
    );
    println!(
        "{} 試合（{} ファイル）から、`{}`{}を{}ごとに数えた。",
        engines.values().sum::<usize>(),
        files.len(),
        a.one("event").unwrap_or_default(),
        if conds.is_empty() {
            String::new()
        } else {
            format!("（席は `{}`）", a.all("where").join(","))
        },
        unit_name
    );
    println!();
    println!("| {} |", head.join(" | "));
    println!(
        "|{}",
        head.iter()
            .enumerate()
            .map(|(i, _)| if i < by.len() { " --- |" } else { " ---: |" })
            .collect::<String>()
    );
    if groups.is_empty() {
        println!("| （合う{unit_name}なし） |");
    }
    // 平均と標準誤差
    let mean_se = |xs: &[f64]| -> String {
        if xs.is_empty() {
            return "-".into();
        }
        let n = xs.len() as f64;
        let mean = xs.iter().sum::<f64>() / n;
        let var = if xs.len() > 1 {
            xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0)
        } else {
            0.0
        };
        format!("{} ± {}", fixed(mean, 2), fixed((var / n).sqrt(), 2))
    };
    for (key, us) in &groups {
        let n = us.len() as f64;
        let total: u64 = us.iter().map(|u| u.count).sum();
        let counts: Vec<f64> = us.iter().map(|u| u.count as f64).collect();
        let hits: Vec<f64> = counts.iter().copied().filter(|&x| x > 0.0).collect();
        let hit = hits.len();
        let firsts: Vec<u32> = us.iter().filter_map(|u| u.first_tc).collect();
        let mut row = key.clone();
        row.push(us.len().to_string());
        row.push(total.to_string());
        row.push(mean_se(&counts));
        row.push(format!("{hit}（{}%）", fixed(hit as f64 / n * 100.0, 0)));
        row.push(mean_se(&hits));
        row.push(if firsts.is_empty() {
            "-".into()
        } else {
            fixed(
                firsts.iter().map(|&x| x as f64).sum::<f64>() / firsts.len() as f64,
                1,
            )
        });
        println!("| {} |", row.join(" | "));
    }
    println!();
    println!("{unit_name}あたりは平均 ± 標準誤差（{unit_name}ごとの数のばらつきから）。あったは 1 回以上あった{unit_name}で、あった{unit_name}あたりはその{unit_name}だけの平均。最初のターンは、あった{unit_name}で最初にあったときの、その席の自分のターンの番号の平均。");
    Ok(())
}

// ---------------------------------------------------------------- winrate

/// まとまり（棋譜のファイルの番号・試合番号）ごとの [席, 勝ち]
type Clusters = BTreeMap<(usize, u32), [u64; 2]>;

fn winrate(argv: &[String]) -> Result<(), String> {
    let a = parse_args(argv)?;
    a.check(&["where", "by"])?;
    let conds = parse_where(&a.all("where"))?;
    let by = a.by();
    let files = kifu_files(&a.inputs)?;
    let lines = read_lines(&files)?;
    // 分け方ごとに、まとまり（棋譜・試合番号）ごとの [席, 勝ち]
    let mut groups: BTreeMap<Vec<String>, Clusters> = BTreeMap::new();
    let mut engines: BTreeMap<String, usize> = BTreeMap::new();
    for l in &lines {
        let v = Json::parse(&l.text)?;
        let m = meta_of(l.file, &v);
        *engines.entry(m.engine.clone()).or_insert(0) += 1;
        for seat in 0..2 {
            let mut pass = true;
            for c in &conds {
                pass &= seat_ok(c, &m, seat)?;
            }
            if !pass {
                continue;
            }
            let key = by
                .iter()
                .map(|k| by_value(k, &m, seat, &files))
                .collect::<Result<Vec<_>, _>>()?;
            let c = groups
                .entry(key)
                .or_default()
                .entry((m.file, m.g))
                .or_insert([0, 0]);
            c[0] += 1;
            c[1] += u64::from(m.winner == Some(seat));
        }
    }
    println!(
        "{} 試合（{} ファイル）の席ごとの勝率{}。引き分けは負けと数える。",
        lines.len(),
        files.len(),
        if conds.is_empty() {
            String::new()
        } else {
            format!("（席は `{}`）", a.all("where").join(","))
        }
    );
    println!();
    let mut head = by.clone();
    head.extend(["席", "勝ち", "勝率", "まとまり", "組（2 勝・1 勝・0 勝）"].map(String::from));
    println!("| {} |", head.join(" | "));
    println!(
        "|{}",
        head.iter()
            .enumerate()
            .map(|(i, _)| if i < by.len() { " --- |" } else { " ---: |" })
            .collect::<String>()
    );
    if groups.is_empty() {
        println!("| （合う席なし） |");
    }
    for (key, clusters) in &groups {
        let (s, se) = cluster_rate(clusters.values());
        let n: u64 = clusters.values().map(|c| c[0]).sum();
        let w: u64 = clusters.values().map(|c| c[1]).sum();
        let pairs = if clusters.values().all(|c| c[0] == 2) {
            let k = |x: u64| clusters.values().filter(|c| c[1] == x).count();
            format!("{}・{}・{}", k(2), k(1), k(0))
        } else {
            "-".into()
        };
        let mut row = key.clone();
        row.push(n.to_string());
        row.push(w.to_string());
        row.push(format!(
            "{}% ± {}",
            fixed(s * 100.0, 2),
            fixed(se * 100.0, 2)
        ));
        row.push(clusters.len().to_string());
        row.push(pairs);
        println!("| {} |", row.join(" | "));
    }
    println!();
    println!("± は、同じ棋譜の同じ試合番号（席とデッキを入れ替えた組）をまとまりにした標準誤差（compare の組の誤差と同じ。どのまとまりも 2 席なら同じ値）。");
    Ok(())
}

/// まとまりごとの [席, 勝ち] から、勝率と、まとまりを単位にした標準誤差（比の推定。どのまとまりも同じ大きさなら、まとまりの勝率の標準誤差と同じ）
fn cluster_rate<'a>(clusters: impl Iterator<Item = &'a [u64; 2]> + Clone) -> (f64, f64) {
    let n: f64 = clusters.clone().map(|c| c[0] as f64).sum();
    let w: f64 = clusters.clone().map(|c| c[1] as f64).sum();
    let m = clusters.clone().count() as f64;
    if n == 0.0 {
        return (0.0, 0.0);
    }
    let r = w / n;
    if m < 2.0 {
        return (r, 0.0);
    }
    let ss: f64 = clusters
        .map(|c| (c[1] as f64 - r * c[0] as f64).powi(2))
        .sum();
    (r, (m / (m - 1.0) * ss).sqrt() / n)
}

// ---------------------------------------------------------------- events

/// 出来事を 1 行 1 出来事で書き出す（込み入った調べ物を、その場限りのスクリプトで読む用）
fn events(argv: &[String]) -> Result<(), String> {
    let a = parse_args(argv)?;
    a.check(&["where", "event", "out"])?;
    let conds = parse_where(&a.all("where"))?;
    let spec = a.one("event").map(|s| parse_event(&s)).transpose()?;
    let files = kifu_files(&a.inputs)?;
    let lines = read_lines(&files)?;
    let results = parallel_map(
        &lines,
        |l, _| -> Result<Result<(String, String), String>, String> {
            let v = Json::parse(&l.text)?;
            let m = meta_of(l.file, &v);
            let idx = match replay(&v) {
                Ok(x) => x,
                Err(why) => return Ok(Err(why)),
            };
            let mut ok_seat = [true, true];
            for (seat, ok) in ok_seat.iter_mut().enumerate() {
                for c in &conds {
                    *ok &= seat_ok(c, &m, seat)?;
                }
            }
            let mut out = String::new();
            for t in turns_of(&idx) {
                for e in events_of(t) {
                    let Some(p) = num_field(e, "p").map(|x| x as usize).filter(|&p| p < 2) else {
                        continue;
                    };
                    if !ok_seat[p] {
                        continue;
                    }
                    if let Some(sp) = &spec {
                        if !event_ok(sp, e, t)? {
                            continue;
                        }
                    }
                    let mut row = vec![
                        (
                            "file".to_string(),
                            Json::Str(by_value("file", &m, p, &files)?),
                        ),
                        ("run".into(), Json::Str(m.run.clone())),
                        ("g".into(), Json::Num(m.g as f64)),
                    ];
                    if let Some(sw) = m.swap {
                        row.push(("swap".into(), Json::Bool(sw)));
                    }
                    row.extend([
                        ("turn".into(), t.get("n").cloned().unwrap_or(Json::Null)),
                        ("tp".into(), t.get("p").cloned().unwrap_or(Json::Null)),
                        ("tc".into(), t.get("tc").cloned().unwrap_or(Json::Null)),
                        ("deck".into(), Json::Str(m.names[p].clone())),
                        ("arch".into(), Json::Str(archetype(&m.names[p]).into())),
                        ("side".into(), Json::Str(m.sides[p].clone())),
                        ("agent".into(), Json::Str(m.agents[p].clone())),
                    ]);
                    if !m.variants[p].is_empty() {
                        row.push(("variant".into(), Json::Str(m.variants[p].clone())));
                    }
                    row.push(("won".into(), Json::Bool(m.winner == Some(p))));
                    let mut e = e.clone();
                    if let Some(Json::Str(c)) = e.get("c").cloned() {
                        e.set("name", Json::Str(name_of(&c)));
                    }
                    let Json::Obj(items) = e else { continue };
                    row.extend(items);
                    out.push_str(&Json::Obj(row).stringify());
                    out.push('\n');
                }
            }
            Ok(Ok((m.engine, out)))
        },
        |_, _, _, _| {},
    );
    let mut sink: Box<dyn Write> = match a.one("out") {
        Some(p) => Box::new(std::io::BufWriter::new(
            std::fs::File::create(&p).map_err(|e| format!("{p} に書けません: {e}"))?,
        )),
        None => Box::new(std::io::BufWriter::new(std::io::stdout())),
    };
    let mut skipped = Vec::new();
    let mut engines: BTreeMap<String, usize> = BTreeMap::new();
    let mut rows = 0usize;
    for (i, r) in results.into_iter().enumerate() {
        match r? {
            Err(why) => skipped.push((i + 1, why)),
            Ok((engine, text)) => {
                *engines.entry(engine).or_insert(0) += 1;
                rows += text.lines().count();
                sink.write_all(text.as_bytes())
                    .map_err(|e| format!("書けません: {e}"))?;
            }
        }
    }
    sink.flush().map_err(|e| format!("書けません: {e}"))?;
    report_skips(&skipped, &engines, lines.len());
    if let Some(p) = a.one("out") {
        println!("出来事 {rows} 行: {p}");
    }
    Ok(())
}

/// 合った席の 1 行（打ち直さない）
fn seat_row(m: &Meta, seat: usize, files: &[String]) -> Result<Json, String> {
    let s = |x: &str| Json::Str(x.to_string());
    let opp = 1 - seat;
    let mut row = vec![
        ("file".to_string(), s(&by_value("file", m, seat, files)?)),
        ("run".into(), s(&m.run)),
        ("source".into(), s(&m.source)),
        ("g".into(), Json::Num(m.g as f64)),
    ];
    if let Some(sw) = m.swap {
        row.push(("swap".into(), Json::Bool(sw)));
    }
    row.extend([
        ("seat".into(), Json::Num(seat as f64)),
        ("deck".into(), s(&m.names[seat])),
        ("opp".into(), s(&m.names[opp])),
        ("side".into(), s(&m.sides[seat])),
        ("agent".into(), s(&m.agents[seat])),
    ]);
    if !m.variants[seat].is_empty() {
        row.push(("variant".into(), s(&m.variants[seat])));
    }
    row.extend([
        (
            "first".into(),
            m.first.map_or(Json::Null, |f| Json::Bool(f == seat)),
        ),
        ("won".into(), Json::Bool(m.winner == Some(seat))),
    ]);
    Ok(Json::Obj(row))
}

fn seats(argv: &[String]) -> Result<(), String> {
    let a = parse_args(argv)?;
    a.check(&["where", "out"])?;
    let conds = parse_where(&a.all("where"))?;
    let files = kifu_files(&a.inputs)?;
    let lines = read_lines(&files)?;
    let mut sink: Box<dyn Write> = match a.one("out") {
        Some(p) => Box::new(std::io::BufWriter::new(
            std::fs::File::create(&p).map_err(|e| format!("{p} に書けません: {e}"))?,
        )),
        None => Box::new(std::io::BufWriter::new(std::io::stdout())),
    };
    let mut rows = 0usize;
    for l in &lines {
        let m = meta_of(l.file, &Json::parse(&l.text)?);
        for seat in 0..2 {
            let mut pass = true;
            for c in &conds {
                pass &= seat_ok(c, &m, seat)?;
            }
            if pass {
                writeln!(sink, "{}", seat_row(&m, seat, &files)?.stringify())
                    .map_err(|e| format!("書けません: {e}"))?;
                rows += 1;
            }
        }
    }
    sink.flush().map_err(|e| format!("書けません: {e}"))?;
    if let Some(p) = a.one("out") {
        println!("{} 試合の席 {rows} 行: {p}", lines.len());
    }
    Ok(())
}

// ---------------------------------------------------------------- values

/// 読みの点数を負け（相手のリーサル。-1e6）とみなす下限（deep_gap.rs と同じ）
const LOSS_SCORE: f64 = -5e5;

/// ターンを終えた局面（ターン終了を選ぶ直前で、選択の途中でないもの）
struct TurnEndAt {
    s: crate::state::GameState,
    n: i32,
    p: usize,
    tc: i32,
}

/// 場のフォロワーの攻撃力の合計（攻撃できるかは見ない）
fn atk_sum(s: &crate::state::GameState, p: usize) -> f64 {
    s.players[p]
        .board
        .iter()
        .filter(|b| b.is_follower)
        .map(|b| b.attack_value() as f64)
        .sum()
}

/// 場の守護のフォロワーの数
fn ward_count(s: &crate::state::GameState, p: usize) -> f64 {
    s.players[p]
        .board
        .iter()
        .filter(|b| b.is_follower && b.has_keyword(crate::data::WARD))
        .count() as f64
}

/// 1 試合を打ち直し、合った席のターン末ごとに、渡した設定の探索 AI が付ける値と、その後の決着の印を 1 行ずつ書く
#[allow(clippy::too_many_arguments)]
fn value_rows(
    v: &Json,
    m: &Meta,
    ok_seat: [bool; 2],
    agent: &crate::ai::search::SearchAgent,
    scale: f64,
    reads: u32,
    files: &[String],
) -> Result<Result<String, String>, String> {
    use crate::game::{apply_legal, create_game, is_legal};
    use crate::state::Phase;
    let r = parse_replay(v)?;
    let mut s = create_game([&r.decks[0], &r.decks[1]], r.seed);
    let mut ends: Vec<TurnEndAt> = Vec::new();
    // ターン番号ごとの行動の数（全部と、選択・ターン終了を除いたもの）
    let mut steps: BTreeMap<i32, (u32, u32)> = BTreeMap::new();
    for (i, act) in r.actions.iter().enumerate() {
        if s.phase == Phase::Ended {
            return Ok(Err(format!("{i} 手目: 決着した後にも行動があります")));
        }
        if !is_legal(&s, act) {
            return Ok(Err(format!(
                "{i} 手目が打てません（記録したときとエンジンの版が違う可能性があります）"
            )));
        }
        if s.phase == Phase::Main {
            let e = steps.entry(s.turn).or_insert((0, 0));
            e.0 += 1;
            if !matches!(act, Action::Choose(_) | Action::Mode(_) | Action::EndTurn) {
                e.1 += 1;
            }
            if matches!(act, Action::EndTurn) && s.pending.is_none() && ok_seat[s.active] {
                ends.push(TurnEndAt {
                    s: s.clone(),
                    n: s.turn,
                    p: s.active,
                    tc: s.players[s.active].turn_count,
                });
            }
        }
        s = apply_legal(&s, act);
    }
    if v.get("winner").is_some() && s.winner.map(|w| w as f64) != num_field(v, "winner") {
        return Ok(Err(
            "打ち直した勝者が棋譜と違う（エンジンの版が違う）".into()
        ));
    }
    // 決着したターン（ターン終了時の処理で決着したらそのターン、次のターンの始めならそのターン）と、その行動の数
    let ended = s.phase == Phase::Ended;
    let end_n = ended.then_some(s.turn);
    let (final_steps, final_moves) = end_n.and_then(|n| steps.get(&n).copied()).unwrap_or((0, 0));
    let sig = |x: f64| 100.0 / (1.0 + (-scale * x).exp());
    let mix = agent.opts.rescore_mix;
    let mut out = String::new();
    for e in &ends {
        let p = e.p;
        let q = 1 - p;
        let end_in = end_n.map(|n| n - e.n);
        let end = agent.turn_end_value(&e.s, p);
        let mut row = vec![
            (
                "file".to_string(),
                Json::Str(by_value("file", m, p, files)?),
            ),
            ("g".into(), Json::Num(m.g as f64)),
        ];
        if let Some(sw) = m.swap {
            row.push(("swap".into(), Json::Bool(sw)));
        }
        row.extend([
            ("seat".into(), Json::Num(p as f64)),
            ("deck".into(), Json::Str(m.names[p].clone())),
            ("opp".into(), Json::Str(m.names[q].clone())),
            ("side".into(), Json::Str(m.sides[p].clone())),
            ("agent".into(), Json::Str(m.agents[p].clone())),
            (
                "first".into(),
                m.first.map_or(Json::Null, |f| Json::Bool(f == p)),
            ),
            ("turn".into(), Json::Num(e.n as f64)),
            ("tc".into(), Json::Num(e.tc as f64)),
            ("hp".into(), Json::Num(e.s.players[p].leader_hp as f64)),
            ("oppHp".into(), Json::Num(e.s.players[q].leader_hp as f64)),
            (
                "oppHand".into(),
                Json::Num(e.s.players[q].hand.len() as f64),
            ),
            ("oppMaxPp".into(), Json::Num(e.s.players[q].max_pp as f64)),
            ("myAtk".into(), Json::Num(atk_sum(&e.s, p))),
            ("oppAtk".into(), Json::Num(atk_sum(&e.s, q))),
            ("myWard".into(), Json::Num(ward_count(&e.s, p))),
            ("oppWard".into(), Json::Num(ward_count(&e.s, q))),
            ("won".into(), Json::Bool(m.winner == Some(p))),
            (
                "endIn".into(),
                end_in.map_or(Json::Null, |x| Json::Num(x as f64)),
            ),
            (
                "lostNext".into(),
                Json::Bool(end_in == Some(1) && m.winner == Some(q)),
            ),
            (
                "wonNext".into(),
                Json::Bool(end_in == Some(2) && m.winner == Some(p)),
            ),
            ("finalSteps".into(), Json::Num(final_steps as f64)),
            ("finalMoves".into(), Json::Num(final_moves as f64)),
            ("end".into(), Json::Num(end)),
            ("endWin".into(), Json::Num(sig(end))),
        ]);
        if reads > 0 {
            let base = super::human_plan::mix(r.seed, e.n as u32);
            let seeds: Vec<u32> = (0..reads)
                .map(|k| super::human_plan::mix(base, k))
                .collect();
            let rv = agent.read_values(&e.s, p, &seeds);
            let n = rv.len() as f64;
            let loss = rv.iter().filter(|&&x| x <= LOSS_SCORE).count() as f64 / n;
            let read_win = rv.iter().map(|&x| sig(x)).sum::<f64>() / n;
            let pick_win = rv
                .iter()
                .map(|&x| sig((1.0 - mix) * x + mix * end))
                .sum::<f64>()
                / n;
            row.extend([
                ("readLoss".into(), Json::Num(loss)),
                ("readWin".into(), Json::Num(read_win)),
                ("pickWin".into(), Json::Num(pick_win)),
            ]);
        }
        out.push_str(&Json::Obj(row).stringify());
        out.push('\n');
    }
    Ok(Ok(out))
}

fn values(argv: &[String]) -> Result<(), String> {
    let a = parse_args(argv)?;
    a.check(&["opts", "reads", "where", "out"])?;
    let text = a.one("opts").unwrap_or_else(|| "{}".into());
    let opts = super::options::compare_options(&text)?;
    // 点数を勝率にする a（σ(a·点数)。渡した補正のもの。docs/value-net.md）
    let scale = match Json::parse(&text)?.get("valueNet") {
        Some(Json::Str(path)) => crate::ai::valuenet::ValueNet::load(path)?.a(),
        _ => crate::ai::valuenet::default_value_net().a(),
    };
    let reads = match a.one("reads") {
        None => 0,
        Some(x) => x
            .parse::<u32>()
            .map_err(|_| format!("--reads は 0 以上の整数: {x}"))?,
    };
    let conds = parse_where(&a.all("where"))?;
    let files = kifu_files(&a.inputs)?;
    let lines = read_lines(&files)?;
    let results = parallel_map(
        &lines,
        |l, _| -> Result<Result<(String, String), String>, String> {
            let v = Json::parse(&l.text)?;
            let m = meta_of(l.file, &v);
            let mut ok_seat = [true, true];
            for (seat, ok) in ok_seat.iter_mut().enumerate() {
                for c in &conds {
                    *ok &= seat_ok(c, &m, seat)?;
                }
            }
            if !ok_seat[0] && !ok_seat[1] {
                return Ok(Ok((m.engine, String::new())));
            }
            let agent = crate::ai::search::SearchAgent::new(opts.clone());
            Ok(value_rows(&v, &m, ok_seat, &agent, scale, reads, &files)?
                .map(|text| (m.engine.clone(), text)))
        },
        |_, _, _, _| {},
    );
    let mut sink: Box<dyn Write> = match a.one("out") {
        Some(p) => Box::new(std::io::BufWriter::new(
            std::fs::File::create(&p).map_err(|e| format!("{p} に書けません: {e}"))?,
        )),
        None => Box::new(std::io::BufWriter::new(std::io::stdout())),
    };
    let mut skipped = Vec::new();
    let mut engines: BTreeMap<String, usize> = BTreeMap::new();
    let mut rows = 0usize;
    for (i, r) in results.into_iter().enumerate() {
        match r? {
            Err(why) => skipped.push((i + 1, why)),
            Ok((engine, text)) => {
                *engines.entry(engine).or_insert(0) += 1;
                rows += text.lines().count();
                sink.write_all(text.as_bytes())
                    .map_err(|e| format!("書けません: {e}"))?;
            }
        }
    }
    sink.flush().map_err(|e| format!("書けません: {e}"))?;
    report_skips(&skipped, &engines, lines.len());
    if let Some(p) = a.one("out") {
        println!("ターン末 {rows} 行: {p}");
    }
    Ok(())
}

pub fn main(argv: &[String]) -> Result<(), String> {
    match argv.first().map(|s| s.as_str()) {
        Some("count") => count(&argv[1..]),
        Some("winrate") => winrate(&argv[1..]),
        Some("events") => events(&argv[1..]),
        Some("seats") => seats(&argv[1..]),
        Some("values") => values(&argv[1..]),
        _ => Err("使い方: svwb kifu count <棋譜>… --event '<種類> [<条件>…]' [--where '<条件>,…'] [--per seat|game|turn] [--by <分け方>,…] | kifu winrate <棋譜>… [--where …] [--by …] | kifu events <棋譜>… [--where …] [--event …] [--out 出来事.jsonl] | kifu seats <棋譜>… [--where …] [--out 席.jsonl] | kifu values <棋譜>… [--opts '<設定>'] [--reads N] [--where …] [--out ターン末.jsonl]（docs/kifu.md「数える」「値」）".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> Meta {
        Meta {
            file: 0,
            g: 5,
            swap: Some(true),
            run: "r".into(),
            source: "compare".into(),
            engine: "abc".into(),
            pool: "azvaldt".into(),
            names: ["アグロNi（CR）".into(), "クキシロB（ZETA）".into()],
            sides: ["B".into(), "A".into()],
            agents: ["B {}".into(), "A {}".into()],
            variants: ["知恵の輝き-1,最果ての罪・サタン+1".into(), String::new()],
            first: Some(1),
            winner: Some(0),
        }
    }

    fn ok(s: &str, seat: usize) -> bool {
        seat_ok(&parse_cond(s).unwrap(), &meta(), seat).unwrap()
    }

    /// seats の行: 席から見たデッキ・相手・側・案・先攻・勝ち（案の無い席には variant が無い）
    #[test]
    fn seat_rows() {
        let files = vec!["/x/k.jsonl.gz".to_string()];
        let r0 = seat_row(&meta(), 0, &files).unwrap();
        assert_eq!(
            r0.stringify(),
            r#"{"file":"k.jsonl.gz","run":"r","source":"compare","g":5,"swap":true,"seat":0,"deck":"アグロNi（CR）","opp":"クキシロB（ZETA）","side":"B","agent":"B {}","variant":"知恵の輝き-1,最果ての罪・サタン+1","first":false,"won":true}"#
        );
        let r1 = seat_row(&meta(), 1, &files).unwrap();
        assert_eq!(r1.get("variant"), None);
        assert_eq!(r1.get("first"), Some(&Json::Bool(true)));
        assert_eq!(r1.get("won"), Some(&Json::Bool(false)));
    }

    #[test]
    fn seat_conditions() {
        assert!(ok("deck~クキシロ", 1));
        assert!(!ok("deck~クキシロ", 0));
        assert!(ok("deck~アグロNi|クキシロB", 0));
        assert!(ok("arch=クキシロB", 1));
        assert!(ok("opp~アグロ", 1));
        assert!(ok("pair~クキシロ", 0) && ok("pair~クキシロ", 1));
        assert!(!ok("pair!~クキシロ", 0));
        assert!(ok("side=A", 1));
        assert!(ok("first", 1) && ok("second", 0));
        assert!(ok("won", 0) && ok("lost", 1));
        assert!(ok("g=3-7", 0) && !ok("g>=6", 0));
        assert!(ok("swap=1", 0));
        assert!(ok("variant~サタン", 0) && !ok("variant~サタン", 1));
        assert!(ok("variant!~サタン", 1));
        assert!(parse_cond("deck").is_ok());
        assert!(seat_ok(&parse_cond("deck").unwrap(), &meta(), 0).is_err());
        assert!(seat_ok(&parse_cond("color=red").unwrap(), &meta(), 0).is_err());
    }

    #[test]
    fn event_conditions() {
        let spec = parse_event("trigger crest own ab=1").unwrap();
        let e =
            Json::parse(r#"{"k":"trigger","p":1,"at":3,"c":"x","crest":true,"ab":1,"own":true}"#)
                .unwrap();
        let mine = Json::parse(r#"{"n":4,"p":1,"tc":2}"#).unwrap();
        let theirs = Json::parse(r#"{"n":5,"p":0,"tc":3}"#).unwrap();
        assert!(event_ok(&spec, &e, &mine).unwrap());
        assert!(!event_ok(&spec, &e, &theirs).unwrap());
        let spec = parse_event("turnEnd pp>0 playable>0").unwrap();
        let te = Json::parse(r#"{"k":"turnEnd","p":0,"at":9,"pp":2,"playable":["a"]}"#).unwrap();
        assert!(event_ok(&spec, &te, &theirs).unwrap());
        let none = Json::parse(r#"{"k":"turnEnd","p":0,"at":9,"pp":2,"playable":[]}"#).unwrap();
        assert!(!event_ok(&spec, &none, &theirs).unwrap());
        // ターン終わりのコンボの数と、持っているクレスト（2026-11-20、ダストデイズの調べ）
        let te = Json::parse(r#"{"k":"turnEnd","p":0,"at":9,"pp":1,"playable":["a"],"combo":2,"crests":["c1","c2"]}"#).unwrap();
        let te_ok = |spec: &str| event_ok(&parse_event(spec).unwrap(), &te, &theirs);
        assert!(te_ok("turnEnd combo=2 holds=c2").unwrap() && !te_ok("turnEnd combo>=3").unwrap());
        assert!(
            !te_ok("turnEnd holds=c3").unwrap()
                && te_ok("turnEnd holds!=c3").unwrap()
                && !te_ok("turnEnd holds!=c1").unwrap()
        );
        assert!(te_ok("turnEnd holds").is_err());
        assert!(!event_ok(&parse_event("turnEnd holds~c").unwrap(), &none, &theirs).unwrap());
        assert!(parse_event("nope").is_err());
        let ev = |spec: &str| event_ok(&parse_event(spec).unwrap(), &e, &mine);
        assert!(!ev("trigger card!~x").unwrap() && ev("trigger card!=y").unwrap());
        assert!(ev("trigger crest=x").unwrap() && !ev("trigger crest=y").unwrap());
        assert!(ev("trigger own=1").is_err() && ev("trigger card").is_err());
        // プレイの仕方・奥義・進化ポイント（profile の仕組みの表の出来事）
        let play = Json::parse(
            r#"{"k":"play","p":1,"at":4,"c":"x","mode":"accelerate","as":"y","ougi":2}"#,
        )
        .unwrap();
        let ok = |spec: &str, e: &Json| event_ok(&parse_event(spec).unwrap(), e, &mine).unwrap();
        assert!(ok("play mode=accelerate", &play) && !ok("play mode=enhance", &play));
        assert!(ok("play ougi=2", &play) && !ok("play ougi=1", &play) && ok("play as=y", &play));
        let plain = Json::parse(r#"{"k":"play","p":1,"at":5,"c":"x"}"#).unwrap();
        assert!(!ok("play mode=accelerate", &plain) && !ok("play ougi>=1", &plain));
        let evo = Json::parse(r#"{"k":"evolve","p":1,"at":6,"c":"x","i":3,"ep":true}"#).unwrap();
        let by_effect = Json::parse(r#"{"k":"evolve","p":1,"at":6,"c":"x","i":4}"#).unwrap();
        assert!(ok("evolve ep", &evo) && !ok("evolve ep", &by_effect));
        assert!(event_ok(
            &parse_event("play bogus=1").unwrap(),
            &Json::parse(r#"{"k":"play","p":0}"#).unwrap(),
            &mine
        )
        .is_err());
    }

    /// kifu values: ターン末ごとに 1 行。負けた席の最後のターン末が lostNext、勝った席のその前のターン末が wonNext
    #[test]
    fn value_rows_mark_the_next_turns() {
        use crate::ai::search::{SearchAgent, SearchOptions};
        use crate::ai::{Agent, RandomAgent, Rng};
        use crate::game::{apply_legal, create_game, legal_actions};
        use crate::state::Phase;
        use crate::state_json::action_to_json;
        let decks = &data().decks;
        let (d0, d1) = (decks[0].cards.clone(), decks[1].cards.clone());
        let mut done = 0;
        for seed in 1..40u32 {
            let mut s = create_game([&d0, &d1], seed);
            let mut rng = Rng::new(seed);
            let mut actions = Vec::new();
            let mut ends = 0;
            while s.phase != Phase::Ended && actions.len() < 3000 {
                let legal = legal_actions(&s);
                let act = RandomAgent.choose_action(&s, &legal, &mut rng);
                if matches!(act, Action::EndTurn) && s.pending.is_none() {
                    ends += 1;
                }
                s = apply_legal(&s, &act);
                actions.push(act);
            }
            let Some(w) = s.winner else { continue };
            let ids = |d: &[CardIdx]| {
                Json::Arr(
                    d.iter()
                        .map(|&c| Json::Str(crate::state::card(c).id.clone()))
                        .collect(),
                )
            };
            let v = Json::Obj(vec![
                ("kind".into(), Json::Str("replay".into())),
                ("g".into(), Json::Num(seed as f64)),
                (
                    "names".into(),
                    Json::Arr(vec![Json::Str("a".into()), Json::Str("b".into())]),
                ),
                ("seed".into(), Json::Num(seed as f64)),
                ("decks".into(), Json::Arr(vec![ids(&d0), ids(&d1)])),
                ("winner".into(), Json::Num(w as f64)),
                (
                    "actions".into(),
                    Json::Arr(actions.iter().map(action_to_json).collect()),
                ),
            ]);
            let m = meta_of(0, &v);
            let agent = SearchAgent::new(SearchOptions::default());
            let files = vec!["k.jsonl".to_string()];
            let text = value_rows(&v, &m, [true, true], &agent, 0.01, 2, &files)
                .unwrap()
                .unwrap();
            let rows: Vec<Json> = text.lines().map(|l| Json::parse(l).unwrap()).collect();
            assert_eq!(rows.len(), ends);
            let last = s.turn as f64;
            for r in &rows {
                let seat = num_field(r, "seat").unwrap() as usize;
                let turn = num_field(r, "turn").unwrap();
                assert_eq!(r.get("endIn"), Some(&Json::Num(last - turn)));
                let lost = r.get("lostNext") == Some(&Json::Bool(true));
                let won = r.get("wonNext") == Some(&Json::Bool(true));
                assert_eq!(lost, seat != w && turn == last - 1.0);
                assert_eq!(won, seat == w && turn == last - 2.0);
                let x = num_field(r, "endWin").unwrap();
                assert!((0.0..=100.0).contains(&x));
                let loss = num_field(r, "readLoss").unwrap();
                assert!((0.0..=1.0).contains(&loss));
            }
            done += 1;
            if done == 3 {
                break;
            }
        }
        assert_eq!(done, 3);
    }

    #[test]
    fn cluster_rate_matches_pair_se() {
        // 2 席ずつの組: 勝ちが 2・1・0 の組の数が 3・4・3
        let mut cs = Vec::new();
        cs.extend(std::iter::repeat_n([2u64, 2], 3));
        cs.extend(std::iter::repeat_n([2u64, 1], 4));
        cs.extend(std::iter::repeat_n([2u64, 0], 3));
        let (r, se) = cluster_rate(cs.iter());
        assert!((r - 0.5).abs() < 1e-12);
        // 組の勝率（1・0.5・0）の標準誤差
        let m: f64 = 10.0;
        let v: f64 = (3.0 * 0.25 + 4.0 * 0.0 + 3.0 * 0.25) / (m - 1.0);
        assert!((se - (v / m).sqrt()).abs() < 1e-12, "{se}");
    }
}
