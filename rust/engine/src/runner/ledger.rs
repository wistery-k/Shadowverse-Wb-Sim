//! 実験の台帳: compare・yardstick・見落とし問題集（misses run）を回すたびに、結果を `docs/ledger.jsonl` に 1 行（JSON）足す。
//!
//! 結果の数字を記録の文章に書き写さずに済むように、また同じ比べの回を後から足し合わせられるようにするため（2026-11-10 から）。
//! 1 行の形は `docs/ledger.md`。表にするのは `npm run ledger`（`scripts/ledger-main.ts`）。
//!
//! - 書く先は既定で `docs/ledger.jsonl`（リポジトリの中。回した後に作業ブランチにコミットする）。環境変数 `SVWB_LEDGER` で別のファイルにできる
//! - `--no-ledger` を付けた回は書かない（動くかの確かめなど）
//! - コミットとブランチは、環境変数 `SVWB_COMMIT`・`SVWB_BRANCH` があればそれを書く（夜のキュー `npm run night` が、
//!   組み立てたときのものを渡す。夜の間にチェックアウトが替わっても、行が回したコードを指すように）
//! - 書けたときは何も出さない（出力は前と同じ）。書けなくても回の結果は失わない（標準出力に出したうえで、注意を出すだけ）
//! - 足すだけで、前の行は書き換えない（`.gitattributes` の `merge=union` で、ブランチどうしで行を足し合っても衝突しない）

use super::parallel::thread_count;
use crate::canonical::fnv;
use crate::json::Json;

/// 台帳のファイル（リポジトリの根からの道）
pub const LEDGER_DOC: &str = "docs/ledger.jsonl";

/// 台帳の 1 行の形の版
pub const LEDGER_VERSION: u32 = 1;

/// 台帳のファイルの道（`SVWB_LEDGER` があればそれ）
pub fn ledger_path() -> String {
    match std::env::var("SVWB_LEDGER") {
        Ok(p) if !p.is_empty() => p,
        _ => format!("{}/../../{LEDGER_DOC}", env!("CARGO_MANIFEST_DIR")),
    }
}

/// 引数から `--no-ledger` を取り除き、付いていたかを返す
pub fn take_no_ledger(argv: &mut Vec<String>) -> bool {
    let before = argv.len();
    argv.retain(|s| s != "--no-ledger");
    argv.len() != before
}

/// 引数から `<name> <値>` を取り除き、値を返す
pub fn take_value(argv: &mut Vec<String>, name: &str) -> Result<Option<String>, String> {
    let Some(i) = argv.iter().position(|s| s == name) else {
        return Ok(None);
    };
    let v = argv
        .get(i + 1)
        .ok_or_else(|| format!("{name} の後に値を渡します"))?
        .clone();
    argv.drain(i..i + 2);
    Ok(Some(v))
}

/// 1 回の実行を書く人が渡すもの（日付・コミット・マシン等は `row` が足す）
pub struct Run {
    /// "compare" か "yardstick"
    pub kind: &'static str,
    /// 実行のコマンド（`svwb` の後ろ。再現用）
    pub argv: Vec<String>,
    /// 名前（`--label`。無ければ空）
    pub label: String,
    /// A の設定の JSON の文字列（渡したまま）
    pub a: String,
    /// B の設定。compare なら設定の JSON の文字列、yardstick なら相手の名前（"classic" か "strong"）
    pub b: String,
    /// 種類ごとの項目（yardstick の相手の版・指紋、compare のデッキの絞り込み等）。`a` 等の後に、この順で並べる
    pub extra: Vec<(String, Json)>,
    /// 使ったデッキ（席とデッキを入れ替える 7 つ）
    pub decks: Vec<String>,
    /// 組の 2 試合を同じシードで打ったか
    pub mirror: bool,
    /// 最初と最後の試合番号（1 つの番号で 2 試合）
    pub first: u32,
    pub last: u32,
    /// 打った試合の数と、A の勝ち数
    pub n: u32,
    pub wins: u32,
    /// A の勝率の標準誤差（0〜1）と、その出し方（"pairs": 組の勝率のばらつき、"binomial": 試合ごと）
    pub se: f64,
    pub se_kind: &'static str,
    /// A の勝ち数が 0・1・2 の組の数（両方の試合がそろった組だけ）
    pub pairs: [u32; 3],
    /// A のデッキごとの [勝ち, 試合数]
    pub per_deck: Vec<(String, [u32; 2])>,
    /// かかった時間（秒）
    pub seconds: f64,
}

/// 設定の JSON の文字列を、台帳に書く値にする（読めなければ文字列のまま）
fn opts_json(text: &str) -> Json {
    Json::parse(text).unwrap_or_else(|_| Json::Str(text.to_string()))
}

/// 設定の中の、ファイルを指す文字列（`"valueNet":"tpa.json"` 等）と、その中身の指紋。同じ名前で中身の違うファイルを見分けるため
fn file_fingerprints(opts: &[&Json]) -> Vec<(String, Json)> {
    fn walk(j: &Json, out: &mut Vec<(String, Json)>) {
        match j {
            Json::Str(s) => {
                let p = std::path::Path::new(s);
                if !s.is_empty() && p.is_file() && !out.iter().any(|(k, _)| k == s) {
                    if let Ok(bytes) = std::fs::read(p) {
                        out.push((s.clone(), Json::Str(fnv(&String::from_utf8_lossy(&bytes)))));
                    }
                }
            }
            Json::Arr(xs) => xs.iter().for_each(|x| walk(x, out)),
            Json::Obj(items) => items.iter().for_each(|(_, x)| walk(x, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    for j in opts {
        walk(j, &mut out);
    }
    out
}

/// シェルにそのまま貼れる形に引数を並べる
pub fn shell_line(argv: &[String]) -> String {
    argv.iter()
        .map(|a| {
            let plain = !a.is_empty()
                && a.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_./,:=+-@%".contains(c));
            if plain {
                a.clone()
            } else {
                format!("'{}'", a.replace('\'', r"'\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// UNIX 時刻（秒）を UTC の "YYYY-MM-DDTHH:MM:SSZ" にする
pub fn utc_iso(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // 1970-01-01 からの日数を年月日に（H. Hinnant の civil_from_days）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + (m <= 2) as i64;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// 回したマシン（環境変数 `SVWB_MACHINE`、無ければホスト名）
pub fn machine() -> String {
    if let Ok(m) = std::env::var("SVWB_MACHINE") {
        if !m.is_empty() {
            return m;
        }
    }
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| super::yardstick::command_line("hostname", &[]))
        .unwrap_or_else(|| "?".into())
}

/// 台帳の 1 行（日付・時刻・コミット・ブランチ・マシンを渡す形。試すため）
#[allow(clippy::too_many_arguments)]
pub fn row_with(
    run: &Run,
    date: &str,
    at: &str,
    commit: &str,
    branch: &str,
    machine: &str,
    threads: usize,
) -> Json {
    let a = opts_json(&run.a);
    let b = if run.kind == "compare" {
        opts_json(&run.b)
    } else {
        Json::Str(run.b.clone())
    };
    let files = file_fingerprints(&[&a, &b]);
    let num = |x: f64| Json::Num(x);
    let s = |x: &str| Json::Str(x.to_string());
    let mut items: Vec<(String, Json)> = vec![
        ("v".into(), num(LEDGER_VERSION as f64)),
        ("kind".into(), s(run.kind)),
        ("date".into(), s(date)),
        ("at".into(), s(at)),
        ("commit".into(), s(commit)),
        ("branch".into(), s(branch)),
        ("label".into(), s(&run.label)),
        ("a".into(), a),
        ("b".into(), b),
    ];
    items.extend(run.extra.iter().cloned());
    if !files.is_empty() {
        items.push(("files".into(), Json::Obj(files)));
    }
    let rate = if run.n > 0 {
        run.wins as f64 / run.n as f64
    } else {
        f64::NAN
    };
    // 小数は 6 桁に丸める（読みやすさのため。勝率・誤差の 0.0001% 未満は意味がない）
    let round = |x: f64| {
        if x.is_finite() {
            num((x * 1e6).round() / 1e6)
        } else {
            Json::Null
        }
    };
    items.extend([
        (
            "decks".into(),
            Json::Arr(run.decks.iter().map(|d| s(d)).collect()),
        ),
        ("mirror".into(), Json::Bool(run.mirror)),
        (
            "g".into(),
            Json::Arr(vec![num(run.first as f64), num(run.last as f64)]),
        ),
        ("n".into(), num(run.n as f64)),
        ("wins".into(), num(run.wins as f64)),
        ("rate".into(), round(rate)),
        ("se".into(), round(run.se)),
        ("seKind".into(), s(run.se_kind)),
        (
            "pairs".into(),
            Json::Arr(run.pairs.iter().map(|&c| num(c as f64)).collect()),
        ),
        (
            "perDeck".into(),
            Json::Obj(
                run.per_deck
                    .iter()
                    .map(|(k, [w, t])| (k.clone(), Json::Arr(vec![num(*w as f64), num(*t as f64)])))
                    .collect(),
            ),
        ),
        ("seconds".into(), round((run.seconds * 10.0).round() / 10.0)),
        (
            "perGame".into(),
            round(if run.n > 0 {
                run.seconds / run.n as f64
            } else {
                f64::NAN
            }),
        ),
        ("threads".into(), num(threads as f64)),
        ("machine".into(), s(machine)),
        ("cmd".into(), s(&shell_line(&run.argv))),
    ]);
    Json::Obj(items)
}

/// 環境変数 name が空でなければその値、無ければ f() の値
fn env_or(name: &str, f: impl FnOnce() -> String) -> String {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => v,
        _ => f(),
    }
}

/// 回した日付・時刻・コミット・ブランチ（今のもの。夜のキューは環境変数で渡す）
pub fn context() -> (String, String, String, String) {
    now_context()
}

fn now_context() -> (String, String, String, String) {
    use super::yardstick::{command_line, commit_label_excluding};
    let date = command_line("date", &["+%Y-%m-%d"]).unwrap_or("?".into());
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| utc_iso(d.as_secs()))
        .unwrap_or_else(|_| "?".into());
    // 物差しの表の変更は数えない（yardstick --record は回した後に表を書き換える）。夜のキューは組み立てたときのものを渡す
    let commit = env_or("SVWB_COMMIT", || {
        commit_label_excluding("docs/yardstick.md")
    });
    let branch = env_or("SVWB_BRANCH", || {
        command_line("git", &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or("?".into())
    });
    (date, at, commit, branch)
}

/// 台帳の 1 行（今の日付・コミット等を入れる）
pub fn row(run: &Run) -> Json {
    let (date, at, commit, branch) = now_context();
    row_with(
        run,
        &date,
        &at,
        &commit,
        &branch,
        &machine(),
        thread_count(),
    )
}

/// 見落とし問題集の 1 回（`svwb misses run`。runner/misses.rs）
pub struct MissesRun {
    /// 実行のコマンド（`svwb` の後ろ）
    pub argv: Vec<String>,
    pub label: String,
    /// AI の設定の JSON の文字列（渡したまま）
    pub a: String,
    /// 問の数と、問題集の指紋（問の名前と中身。問を足す・直すと変わる。指紋の違う回の正解率は比べられない）
    pub problems: u32,
    pub set: String,
    /// 1 問を打つ回数と、乱数の元
    pub trials: u32,
    pub seed: u32,
    /// 打った回数（問の数 × 回数）と、合格した回数
    pub n: u32,
    pub passes: u32,
    /// 正解率（問ごとの合格率の平均）と、その標準誤差（0〜1。問ごとの合格率のぶれから。問題集は決まったものとして）
    pub rate: f64,
    pub se: f64,
    /// 問ごとの [合格, 回数]（問の名前の順）
    pub per: Vec<(String, [u32; 2])>,
    pub seconds: f64,
}

/// 見落とし問題集の 1 回の台帳の行（日付・時刻・コミット・ブランチ・マシンを渡す形。試すため）
#[allow(clippy::too_many_arguments)]
pub fn misses_row_with(
    run: &MissesRun,
    date: &str,
    at: &str,
    commit: &str,
    branch: &str,
    machine: &str,
    threads: usize,
) -> Json {
    let a = opts_json(&run.a);
    let files = file_fingerprints(&[&a]);
    let num = |x: f64| Json::Num(x);
    let s = |x: &str| Json::Str(x.to_string());
    let round = |x: f64| {
        if x.is_finite() {
            num((x * 1e6).round() / 1e6)
        } else {
            Json::Null
        }
    };
    let mut items: Vec<(String, Json)> = vec![
        ("v".into(), num(LEDGER_VERSION as f64)),
        ("kind".into(), s("misses")),
        ("date".into(), s(date)),
        ("at".into(), s(at)),
        ("commit".into(), s(commit)),
        ("branch".into(), s(branch)),
        ("label".into(), s(&run.label)),
        ("a".into(), a),
    ];
    if !files.is_empty() {
        items.push(("files".into(), Json::Obj(files)));
    }
    items.extend([
        ("problems".into(), num(run.problems as f64)),
        ("set".into(), s(&run.set)),
        ("trials".into(), num(run.trials as f64)),
        ("seed".into(), num(run.seed as f64)),
        ("n".into(), num(run.n as f64)),
        ("passes".into(), num(run.passes as f64)),
        ("rate".into(), round(run.rate)),
        ("se".into(), round(run.se)),
        (
            "perProblem".into(),
            Json::Obj(
                run.per
                    .iter()
                    .map(|(k, [w, t])| (k.clone(), Json::Arr(vec![num(*w as f64), num(*t as f64)])))
                    .collect(),
            ),
        ),
        ("seconds".into(), round((run.seconds * 10.0).round() / 10.0)),
        ("threads".into(), num(threads as f64)),
        ("machine".into(), s(machine)),
        ("cmd".into(), s(&shell_line(&run.argv))),
    ]);
    Json::Obj(items)
}

/// 見落とし問題集の 1 回を台帳に足す（書けなければ注意を出すだけ）
pub fn append_misses(run: &MissesRun) {
    let (date, at, commit, branch) = now_context();
    append_line(&misses_row_with(
        run,
        &date,
        &at,
        &commit,
        &branch,
        &machine(),
        thread_count(),
    ));
}

/// 候補の打ち比べ調査（`svwb survey report`。runner/survey.rs）の 1 行を台帳に足す。fields は `label` の後に並べる項目
pub fn append_survey(label: &str, fields: Vec<(String, Json)>) {
    let (date, at, commit, branch) = now_context();
    let s = |x: &str| Json::Str(x.to_string());
    let mut items: Vec<(String, Json)> = vec![
        ("v".into(), Json::Num(LEDGER_VERSION as f64)),
        ("kind".into(), s("survey")),
        ("date".into(), s(&date)),
        ("at".into(), s(&at)),
        ("commit".into(), s(&commit)),
        ("branch".into(), s(&branch)),
        ("label".into(), s(label)),
    ];
    items.extend(fields);
    append_line(&Json::Obj(items));
}

/// 台帳に 1 行足す（書けなければ注意を出すだけ）
pub fn append(run: &Run) {
    append_line(&row(run));
}

fn append_line(row: &Json) {
    use std::io::Write;
    let path = ledger_path();
    let line = row.stringify() + "\n";
    let res = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(line.as_bytes()));
    // 書けたときは何も出さない（出力の最後の行を読むジョブ（cloud/jobs/relearn.sh の tail 等）を変えないため）
    if let Err(e) = res {
        eprintln!("注意: 台帳 {path} に書けません（結果は上の出力のとおり）: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> Run {
        Run {
            kind: "compare",
            argv: vec![
                "compare".into(),
                "1600".into(),
                r#"{"beamWidth":256}"#.into(),
                "{}".into(),
                "0".into(),
            ],
            label: "幅 256".into(),
            a: r#"{"beamWidth":256}"#.into(),
            b: "{}".into(),
            extra: vec![("vs".into(), Json::Null)],
            decks: vec!["リノセウスエルフ".into(), "アマリアロイヤル".into()],
            mirror: true,
            first: 0,
            last: 1599,
            n: 3200,
            wins: 1618,
            se: 0.0016,
            se_kind: "pairs",
            pairs: [120, 1352, 128],
            per_deck: vec![("リノセウスエルフ".into(), [300, 458])],
            seconds: 320.0,
        }
    }

    #[test]
    fn row_has_the_fields_in_order() {
        let r = row_with(
            &run(),
            "2026-11-10",
            "2026-11-10T09:00:00Z",
            "bcb49c2",
            "main",
            "svwb-docker",
            28,
        );
        let text = r.stringify();
        assert!(
            text.starts_with(
                r#"{"v":1,"kind":"compare","date":"2026-11-10","at":"2026-11-10T09:00:00Z","commit":"bcb49c2","branch":"main","label":"幅 256","a":{"beamWidth":256},"b":{},"vs":null,"decks":["リノセウスエルフ","アマリアロイヤル"]"#
            ),
            "{text}"
        );
        assert!(
            text.contains(r#""g":[0,1599],"n":3200,"wins":1618,"rate":0.505625,"se":0.0016,"seKind":"pairs","pairs":[120,1352,128],"perDeck":{"リノセウスエルフ":[300,458]},"seconds":320,"perGame":0.1,"threads":28,"machine":"svwb-docker""#),
            "{text}"
        );
        assert!(
            text.ends_with(r#""cmd":"compare 1600 '{\"beamWidth\":256}' '{}' 0"}"#),
            "{text}"
        );
        // 1 行に収まる
        assert!(!text.contains('\n'));
    }

    #[test]
    fn misses_row_has_the_fields_in_order() {
        let m = MissesRun {
            argv: vec![
                "misses".into(),
                "run".into(),
                "--label".into(),
                "定例".into(),
            ],
            label: "定例".into(),
            a: "{}".into(),
            problems: 2,
            set: "91c86c68".into(),
            trials: 24,
            seed: 1,
            n: 48,
            passes: 25,
            rate: 0.520833,
            se: 0.012,
            per: vec![("a".into(), [24, 24]), ("b".into(), [1, 24])],
            seconds: 5.04,
        };
        let text = misses_row_with(
            &m,
            "2026-11-10",
            "2026-11-10T09:00:00Z",
            "bcb49c2",
            "main",
            "cloud",
            4,
        )
        .stringify();
        assert_eq!(
            text,
            r#"{"v":1,"kind":"misses","date":"2026-11-10","at":"2026-11-10T09:00:00Z","commit":"bcb49c2","branch":"main","label":"定例","a":{},"problems":2,"set":"91c86c68","trials":24,"seed":1,"n":48,"passes":25,"rate":0.520833,"se":0.012,"perProblem":{"a":[24,24],"b":[1,24]},"seconds":5,"threads":4,"machine":"cloud","cmd":"misses run --label '定例'"}"#
        );
    }

    #[test]
    fn utc_iso_matches_known_dates() {
        assert_eq!(utc_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_iso(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(utc_iso(1_794_334_135), "2026-11-10T18:08:55Z");
    }

    #[test]
    fn shell_line_quotes_only_when_needed() {
        let argv: Vec<String> = ["yardstick", "--opts", "{}", "--label", "it's"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            shell_line(&argv),
            r#"yardstick --opts '{}' --label 'it'\''s'"#
        );
    }

    #[test]
    fn flags_are_taken_out() {
        let mut argv: Vec<String> = ["10", "--no-ledger", "{}", "--label", "x", "{}"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(take_no_ledger(&mut argv));
        assert_eq!(take_value(&mut argv, "--label").unwrap(), Some("x".into()));
        assert_eq!(argv, ["10", "{}", "{}"]);
        assert!(take_value(&mut vec!["--label".to_string()], "--label").is_err());
    }
}
