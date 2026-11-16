//! 棋譜: 対戦を打つランナー（compare・yardstick・profile・td selfplay）が試合ごとに書く、1 試合 1 行の JSON Lines（形は docs/kifu.md）。
//!
//! 打ち直すのに要るもの（デッキ・シード・行動の列）に、どの回のどの試合か（回の名前・試合番号・組の 2 試合のどちらか）と、
//! 打った AI（席ごとの設定と補正の指紋）・エンジンの版（コミット）・プールを足したもの。エンジンは決定的なので、同じ版で打ち直せば同じ試合になる。
//! 開発サーバーの「リプレイ検索」タブ（src/replays）も読む（1 行の形は前の `--replays` の行を広げたもの。前の行も読める）。
//!
//! - 既定で書く。書く先は `--kifu <ファイル>`（前の名前 `--replays` も使える）、無ければ環境変数 `SVWB_KIFU_DIR` のフォルダ
//!   （無ければ `~/svwb-data/kifu`）に、種類・回の名前・試合番号の範囲・引数の指紋・コミットから決めた名前（`default_path`）。`--no-kifu` で書かない
//! - 名前は同じ引数・同じコミットなら同じ（同じ試合なので上書きしてよい）。設定だけが違う回（夜のキューの 2 つの profile 等）は引数の指紋で分かれる。
//!   夜のキューは区切りごとに回のフォルダの `kifu/` に書く
//! - 書いている間は `<ファイル>.tmp` に書き、全部の試合を書き終えたら名前を替える（途中で止まった回の棋譜は `.tmp` のまま残る）
//! - 打つ手・試合は変えない（書くだけ）

use crate::canonical::fnv;
use crate::data::{data, CardIdx, Pool};
use crate::json::Json;
use crate::state::{card, Action, GameState};
use std::io::Write;

/// 1 行の形の版（1: 2026-11-16 までの `--replays` の行。2: 回・エンジン・プール・席の AI と補正の指紋・組を足した）
pub const KIFU_VERSION: u32 = 2;

/// 引数で決めた書き方
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// 書かない（`--no-kifu`）
    Off,
    /// 決まった名前で書く（`default_path`）
    Default,
    /// このファイルに書く（`--kifu`・`--replays`）
    Path(String),
}

/// 引数から `--kifu <ファイル>`・`--replays <ファイル>`・`--no-kifu` を取り除き、書き方を返す
pub fn take_args(argv: &mut Vec<String>) -> Result<Target, String> {
    let mut target = Target::Default;
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--no-kifu" => {
                if matches!(target, Target::Path(_)) {
                    return Err("--no-kifu と --kifu は一緒に使えません".into());
                }
                target = Target::Off;
                argv.remove(i);
            }
            flag @ ("--kifu" | "--replays") => {
                let flag = flag.to_string();
                let p = argv
                    .get(i + 1)
                    .filter(|p| !p.starts_with("--"))
                    .ok_or_else(|| format!("{flag} の後に棋譜を書くファイルを渡します"))?
                    .clone();
                if target != Target::Default {
                    return Err("--kifu・--replays・--no-kifu はどれか 1 つ".into());
                }
                target = Target::Path(p);
                argv.drain(i..i + 2);
            }
            _ => i += 1,
        }
    }
    Ok(target)
}

/// `take_args` の、(名前, 値) の並びの引数版（td selfplay。`--no-kifu` は値 "1" か "true" で書かない）
pub fn target_of_pairs(args: &[(String, String)]) -> Result<Target, String> {
    let get = |k: &str| args.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
    let path = get("kifu").or_else(|| get("replays"));
    let off = get("no-kifu").is_some_and(|v| v != "0" && v != "false");
    match (path, off) {
        (Some(_), true) => Err("--no-kifu と --kifu は一緒に使えません".into()),
        (Some(p), false) => Ok(Target::Path(p)),
        (None, true) => Ok(Target::Off),
        (None, false) => Ok(Target::Default),
    }
}

/// 既定の棋譜のフォルダ（`SVWB_KIFU_DIR`、無ければ `~/svwb-data/kifu`）
pub fn default_dir() -> String {
    match std::env::var("SVWB_KIFU_DIR") {
        Ok(d) if !d.is_empty() => d,
        _ => {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            format!("{home}/svwb-data/kifu")
        }
    }
}

/// ファイルの名前に使えない文字（/ や空白など）を _ にする
fn safe(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_whitespace() || "/\\:*?\"<>|'`$".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect()
}

/// 引数の指紋（棋譜の名前に入れる。棋譜の引数を除いた引数の並びの FNV-1a）
pub fn args_key<S: AsRef<str>>(argv: &[S]) -> String {
    let joined: Vec<&str> = argv.iter().map(|a| a.as_ref()).collect();
    fnv(&joined.join("\u{1}"))
}

/// 1 回の名前の材料
pub struct Name<'a> {
    /// 種類（"compare"・"yardstick"・"profile"・"selfplay"）
    pub kind: &'a str,
    /// 回の名前（--label。無ければ空）
    pub label: &'a str,
    /// 試合番号の範囲
    pub first: u32,
    pub last: u32,
    /// 引数の指紋（`args_key`）
    pub key: &'a str,
    /// コミット
    pub commit: &'a str,
}

/// 既定の棋譜の名前: `<種類>-<回の名前>-g<最初>-<最後>-<引数の指紋>-<コミット>.jsonl`（回の名前が無ければ飛ばす）
pub fn default_name(n: &Name) -> String {
    let mut parts = vec![safe(n.kind)];
    if !n.label.is_empty() {
        parts.push(safe(n.label));
    }
    parts.push(format!("g{}-{}", n.first, n.last));
    parts.push(safe(n.key));
    parts.push(safe(n.commit));
    format!("{}.jsonl", parts.join("-"))
}

impl Target {
    /// 書くファイル（書かないなら None。既定なら `default_dir` の下の `default_name`）
    pub fn path(&self, n: &Name) -> Option<String> {
        match self {
            Target::Off => None,
            Target::Default => Some(format!("{}/{}", default_dir(), default_name(n))),
            Target::Path(p) => Some(p.clone()),
        }
    }
}

/// 棋譜のファイル。`<ファイル>.tmp` に書き、`finish` で名前を替える
pub struct Writer {
    path: String,
    tmp: String,
    file: std::io::BufWriter<std::fs::File>,
    games: u32,
}

impl Writer {
    pub fn create(path: &str) -> Result<Writer, String> {
        if let Some(dir) = std::path::Path::new(path).parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("棋譜のフォルダ {} を作れません: {e}", dir.display()))?;
            }
        }
        let tmp = format!("{path}.tmp");
        let file =
            std::fs::File::create(&tmp).map_err(|e| format!("棋譜 {tmp} に書けません: {e}"))?;
        Ok(Writer {
            path: path.to_string(),
            tmp,
            file: std::io::BufWriter::new(file),
            games: 0,
        })
    }

    /// 1 試合の行を書く
    pub fn write(&mut self, line: &str) {
        writeln!(self.file, "{line}")
            .unwrap_or_else(|e| panic!("棋譜 {} に書けません: {e}", self.tmp));
        self.games += 1;
    }

    /// 書き終える（名前を替え、ファイルの道と試合の数を返す）
    pub fn finish(mut self) -> Result<(String, u32), String> {
        self.file
            .flush()
            .map_err(|e| format!("棋譜 {} に書けません: {e}", self.tmp))?;
        drop(self.file);
        std::fs::rename(&self.tmp, &self.path)
            .map_err(|e| format!("棋譜 {} の名前を替えられません: {e}", self.tmp))?;
        Ok((self.path, self.games))
    }
}

/// 回（1 回の実行）で同じもの
pub struct RunInfo {
    /// 書いたランナー（"compare"・"yardstick"・"profile"・"td selfplay"）
    pub source: String,
    /// 回の名前（台帳の名前 `--label`。無ければ空）
    pub run: String,
    /// エンジンの版（コミット。手元の変更があれば末尾に "+"。夜のキューは組み立てたときのもの）
    pub engine: String,
}

impl RunInfo {
    /// 今のコミットで（夜のキューは環境変数 `SVWB_COMMIT`）
    pub fn now(source: &str, run: &str) -> RunInfo {
        RunInfo {
            source: source.into(),
            run: run.into(),
            engine: super::ledger::context().2,
        }
    }
}

/// 席に座る AI（compare なら A か B）
#[derive(Clone, Debug)]
pub struct Seat {
    /// 比べの側（"A"・"B"。比べでなければ None）
    pub side: Option<String>,
    /// 表示名（前の `agents`。compare は "A <設定>"）
    pub agent: String,
    /// 設定（compare の設定の JSON など。渡したまま）
    pub ai: Json,
    /// 補正と見込みの指紋（`nets_of`）
    pub nets: Json,
}

/// 1 試合
pub struct Game<'a> {
    /// 試合番号
    pub g: u32,
    /// 組（同じ試合番号で席とデッキを入れ替えた 2 試合）のどちらか。組の無い試合（自己対戦）は None
    pub swap: Option<bool>,
    pub names: [&'a str; 2],
    pub seats: [&'a Seat; 2],
    pub decks: [&'a [CardIdx]; 2],
    pub seed: u32,
    pub end: &'a GameState,
    pub actions: &'a [Action],
}

/// 両方のデッキのカードが入っているプール（どちらにも入るならスターター。どちらにも入らなければ "mixed"）
pub fn pool_of(decks: [&[CardIdx]; 2]) -> &'static str {
    let all = |p: Pool| decks.iter().all(|d| d.iter().all(|&c| card(c).in_pool(p)));
    if all(Pool::Starter) {
        "starter"
    } else if all(Pool::Azvaldt) {
        "azvaldt"
    } else {
        "mixed"
    }
}

/// 埋め込んだデータの元のファイルの指紋（npm run rust-data が書く sources.txt の行。無ければ None）
fn embedded_fingerprint(path: &str) -> Option<String> {
    const SOURCES: &str = include_str!("../../data/sources.txt");
    SOURCES.lines().find_map(|l| {
        let (hash, p) = l.split_once(' ')?;
        (p == path).then(|| hash.to_string())
    })
}

/// ファイルの中身の指紋（台帳の files と同じ。読めなければ "?"）
pub fn file_fingerprint(path: &str) -> String {
    std::fs::read(path)
        .map(|b| fnv(&String::from_utf8_lossy(&b)))
        .unwrap_or_else(|_| "?".into())
}

/// 指紋の値（埋め込みの既定・ファイル・使わない）
fn net_json(v: Option<&Json>, default: &str, off: &Json) -> Json {
    match v {
        None => embedded_fingerprint(default).map_or(Json::Null, Json::Str),
        Some(x) if x == off => Json::Null,
        Some(Json::Str(p)) => Json::Str(file_fingerprint(p)),
        Some(_) => Json::Null,
    }
}

/// compare の設定の JSON が使う補正（valueNet）と見込み（potentialNet）の指紋。書かなければ埋め込みの既定
/// （data/value-net.json・data/potential-net.json の、組み立てたときの中身の指紋）、使わなければ null
pub fn nets_of(opts: &Json) -> Json {
    Json::Obj(vec![
        (
            "valueNet".into(),
            net_json(
                opts.get("valueNet"),
                "data/value-net.json",
                &Json::Bool(false),
            ),
        ),
        (
            "potentialNet".into(),
            net_json(
                opts.get("potentialNet"),
                "data/potential-net.json",
                &Json::Null,
            ),
        ),
    ])
}

/// 補正と見込みを、ファイルの道（None なら使わない、"" なら埋め込みの既定）から
pub fn nets_from(value_net: Option<&str>, potential_net: Option<&str>) -> Json {
    let one = |p: Option<&str>, default: &str| match p {
        None => Json::Null,
        Some("") => embedded_fingerprint(default).map_or(Json::Null, Json::Str),
        Some(p) => Json::Str(file_fingerprint(p)),
    };
    Json::Obj(vec![
        ("valueNet".into(), one(value_net, "data/value-net.json")),
        (
            "potentialNet".into(),
            one(potential_net, "data/potential-net.json"),
        ),
    ])
}

/// compare の設定の側（"A"・"B"）の席
pub fn compare_seat(side: &str, opts_text: &str) -> Seat {
    let ai = Json::parse(opts_text).unwrap_or_else(|_| Json::Str(opts_text.to_string()));
    let nets = nets_of(&ai);
    Seat {
        side: Some(side.into()),
        agent: format!("{side} {opts_text}"),
        ai,
        nets,
    }
}

/// 1 試合の行
pub fn line(run: &RunInfo, game: &Game) -> String {
    let s = |x: &str| Json::Str(x.to_string());
    let num = |x: f64| Json::Num(x);
    let ids = |d: &[CardIdx]| Json::Arr(d.iter().map(|&c| s(&card(c).id)).collect());
    let seats = game.seats;
    let mut items: Vec<(String, Json)> = vec![
        ("kind".into(), s("replay")),
        ("version".into(), num(KIFU_VERSION as f64)),
        ("source".into(), s(&run.source)),
        ("run".into(), s(&run.run)),
        ("engine".into(), s(&run.engine)),
        ("pool".into(), s(pool_of(game.decks))),
        ("g".into(), num(game.g as f64)),
    ];
    if let Some(sw) = game.swap {
        items.push(("swap".into(), Json::Bool(sw)));
    }
    items.extend([
        (
            "names".into(),
            Json::Arr(game.names.iter().map(|x| s(x)).collect()),
        ),
        (
            "agents".into(),
            Json::Arr(seats.iter().map(|x| s(&x.agent)).collect()),
        ),
    ]);
    if seats.iter().any(|x| x.side.is_some()) {
        items.push((
            "sides".into(),
            Json::Arr(
                seats
                    .iter()
                    .map(|x| x.side.as_deref().map_or(Json::Null, s))
                    .collect(),
            ),
        ));
    }
    items.extend([
        (
            "ai".into(),
            Json::Arr(seats.iter().map(|x| x.ai.clone()).collect()),
        ),
        (
            "nets".into(),
            Json::Arr(seats.iter().map(|x| x.nets.clone()).collect()),
        ),
        ("seed".into(), num(game.seed as f64)),
        (
            "decks".into(),
            Json::Arr(vec![ids(game.decks[0]), ids(game.decks[1])]),
        ),
        ("first".into(), num(game.end.first as f64)),
        (
            "winner".into(),
            game.end.winner.map_or(Json::Null, |w| num(w as f64)),
        ),
        ("turns".into(), num(game.end.turn as f64)),
        (
            "actions".into(),
            Json::Arr(
                game.actions
                    .iter()
                    .map(crate::state_json::action_to_json)
                    .collect(),
            ),
        ),
    ]);
    Json::Obj(items).stringify()
}

/// 打ち直すのに要るもの
pub struct Replay {
    pub decks: [Vec<CardIdx>; 2],
    pub seed: u32,
    pub actions: Vec<Action>,
}

/// 棋譜の 1 行から、デッキ・シード・行動の列を読む（打ち直すため。前の版の行も読める）
pub fn parse_replay(v: &Json) -> Result<Replay, String> {
    let deck = |d: &Json| -> Result<Vec<CardIdx>, String> {
        let Json::Arr(xs) = d else {
            return Err("decks がカードIDの列ではありません".into());
        };
        xs.iter()
            .map(|x| match x {
                Json::Str(id) => data()
                    .card_by_id
                    .get(id.as_str())
                    .copied()
                    .ok_or_else(|| format!("未知のカードID: {id}")),
                _ => Err("カードIDが文字列ではありません".into()),
            })
            .collect()
    };
    let Some(Json::Arr(ds)) = v.get("decks") else {
        return Err("decks がありません".into());
    };
    if ds.len() != 2 {
        return Err("decks が 2 つではありません".into());
    }
    let Some(Json::Num(seed)) = v.get("seed") else {
        return Err("seed がありません".into());
    };
    let Some(Json::Arr(acts)) = v.get("actions") else {
        return Err("actions がありません".into());
    };
    let actions = acts
        .iter()
        .map(crate::state_json::action_from_json)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Replay {
        decks: [deck(&ds[0])?, deck(&ds[1])?],
        seed: *seed as u32,
        actions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn takes_the_kifu_flags() {
        let mut a = args(&["10", "{}", "--kifu", "x.jsonl", "--label", "l"]);
        assert_eq!(take_args(&mut a).unwrap(), Target::Path("x.jsonl".into()));
        assert_eq!(a, args(&["10", "{}", "--label", "l"]));
        let mut a = args(&["--replays", "r.jsonl"]);
        assert_eq!(take_args(&mut a).unwrap(), Target::Path("r.jsonl".into()));
        let mut a = args(&["--no-kifu", "5"]);
        assert_eq!(take_args(&mut a).unwrap(), Target::Off);
        assert_eq!(a, args(&["5"]));
        let mut a = args(&["5"]);
        assert_eq!(take_args(&mut a).unwrap(), Target::Default);
        assert!(take_args(&mut args(&["--kifu", "a", "--no-kifu"])).is_err());
        assert!(take_args(&mut args(&["--kifu"])).is_err());
        assert!(take_args(&mut args(&["--kifu", "--label"])).is_err());
    }

    #[test]
    fn default_names_are_safe_and_stable() {
        let n = Name {
            kind: "compare",
            label: "新しいプール R3/x",
            first: 0,
            last: 99,
            key: "0123abcd",
            commit: "abc1234+",
        };
        assert_eq!(
            default_name(&n),
            "compare-新しいプール_R3_x-g0-99-0123abcd-abc1234+.jsonl"
        );
        let n = Name {
            kind: "selfplay",
            label: "",
            first: 7200000,
            last: 7202999,
            ..n
        };
        assert_eq!(
            default_name(&n),
            "selfplay-g7200000-7202999-0123abcd-abc1234+.jsonl"
        );
        // 設定だけが違う引数は指紋が違う
        assert_ne!(
            args_key(&["profile", "--opts", "{}"]),
            args_key(&["profile", "--opts", "{\"beamWidth\":8}"])
        );
        assert_eq!(args_key(&["a", "b"]).len(), 8);
    }

    #[test]
    fn writer_renames_when_finished() {
        let dir = std::env::temp_dir().join(format!("svwb-kifu-test-{}", std::process::id()));
        let path = dir.join("sub/k.jsonl").to_string_lossy().to_string();
        let mut w = Writer::create(&path).unwrap();
        w.write("{}");
        assert!(std::path::Path::new(&format!("{path}.tmp")).exists());
        assert!(!std::path::Path::new(&path).exists());
        let (p, n) = w.finish().unwrap();
        assert_eq!((p.as_str(), n), (path.as_str(), 1));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}\n");
        assert!(!std::path::Path::new(&format!("{path}.tmp")).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn nets_use_the_embedded_defaults() {
        let n = nets_of(&Json::parse("{}").unwrap());
        assert!(
            matches!(n.get("valueNet"), Some(Json::Str(h)) if h.len() == 8),
            "{}",
            n.stringify()
        );
        assert!(matches!(n.get("potentialNet"), Some(Json::Str(h)) if h.len() == 8));
        let off = nets_of(&Json::parse(r#"{"valueNet":false,"potentialNet":null}"#).unwrap());
        assert_eq!(off.get("valueNet"), Some(&Json::Null));
        assert_eq!(off.get("potentialNet"), Some(&Json::Null));
        // ファイルなら中身の指紋（埋め込みの既定と、同じファイルを渡したときは同じ）
        let path = format!("{}/../../data/value-net.json", env!("CARGO_MANIFEST_DIR"));
        let f = nets_of(&Json::Obj(vec![("valueNet".into(), Json::Str(path))]));
        assert_eq!(f.get("valueNet"), n.get("valueNet"));
    }

    #[test]
    fn pools_of_decks() {
        let d = &data().decks;
        assert_eq!(pool_of([&d[0].cards, &d[1].cards]), "starter");
        let az: Vec<CardIdx> = (0..data().cards.len() as CardIdx)
            .filter(|&c| {
                let x = card(c);
                !x.token && x.in_pool(Pool::Azvaldt) && !x.in_pool(Pool::Starter)
            })
            .take(40)
            .collect();
        assert_eq!(pool_of([&az, &az]), "azvaldt");
        assert_eq!(pool_of([&az, &d[0].cards]), "mixed");
    }
}
