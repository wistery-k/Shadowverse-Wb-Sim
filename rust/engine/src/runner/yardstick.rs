//! 強さの物差し: 固定した相手（学習した補正を入れる前の探索 AI を凍結したもの）との勝率を測り、版ごとに記録する。
//!
//!   svwb yardstick [--opts '<設定JSON>'] [--games 1000] [--start 0] [--label 名前] [--record]
//!   svwb yardstick fingerprint
//!
//! 試合の組み方とシードは compare と同じ（同じデッキの組で席とデッキを入れ替えて 2 試合ずつ。--games 1000 で 2000 試合）。
//! --opts は compare の設定と同じ形（`{}` で今の探索 AI の既定）。--record で `docs/yardstick.md` の表に 1 行足す。
//!
//! 相手（`reference_options`）は、探索 AI の既定や SEARCH_WEIGHTS を変えても動かないよう、設定と重みをここに書き写してある。
//! それでもルール・カード能力・評価関数のコード・マリガンのモデル等を変えると相手の手が変わるので、
//! 相手どうしの決まった試合の手順のハッシュ（指紋）を `FINGERPRINT` と比べる（tests/yardstick.rs と、--record の前）。
//! 指紋が変わったら、AI の変更が相手に漏れたのなら漏れた分をここに書き写して元に戻す。
//! ルールの修正などで戻せないなら `VERSION` を上げて `FINGERPRINT` を書き直し、表を新しく始める（違う版の行どうしは比べない）。

use super::compare::{compare_pair, play_compare_game};
use super::options::compare_options;
use super::parallel::parallel_map;
use super::{compare_decks, fixed, seconds_since, Tally};
use crate::ai::aidata::weights_from;
use crate::ai::search::{MulliganMode, ScoreTurnEnd, SearchAgent, SearchOptions};
use crate::ai::Agent;
use crate::canonical::{action_canon, fnv};
use crate::sim::play_match;
use std::sync::Arc;
use std::time::Instant;

/// 物差しの版（相手の手が変わって戻せないときに上げる）
pub const VERSION: u32 = 1;

/// 相手どうしの決まった試合（`fingerprint`）の手順のハッシュ
pub const FINGERPRINT: &str = "53e88302";

/// 相手の評価関数の重み（2026-10-16 の SEARCH_WEIGHTS を書き写したもの）
const REFERENCE_WEIGHTS: &str = r#"{"myHp":0.7,"oppHp":1,"attack":1,"defense":0.8,"followerBase":1,"tempAttack":0.3,"keywords":1,"amulet":1.5,"sigil":0.5,"sigilAmulet":1.5,"countdownDecay":0.8,"jeanneSync":0,"oppBoard":1.1,"myHand":0.6,"oppHand":0.3,"ep":1.5,"sep":5,"extraPp":1,"maxPp":8,"crest":3,"graveyard":0.05,"lethalRange":10,"lethalAttack":0.3,"fusionSet":3.6,"kuonReserve":8,"evoReserve":3,"sevoReserve":6,"kerberosReserve":0,"lastWords":1,"lastWordsSummon":0.5,"handStorm":0,"boostCard":1,"boost":0.2,"boostCap":5,"hold":{"90072110":0.6,"90072120":0.6,"90073110":1.2,"90073120":1.7999999999999998,"90073130":1.7999999999999998,"90074110":4.8},"doomed":0.3,"ppLeft":0,"extraPpExpiring":0}"#;

/// 物差しの相手の設定（2026-10-16 の search-classic を書き写したもの）。
/// `..SearchOptions::default()` を使わず全項目を書くので、項目が増えたらここで値を決める（既定を変えても相手は動かない）
pub fn reference_options() -> SearchOptions {
    let weights = match serde_json::from_str(REFERENCE_WEIGHTS) {
        Ok(serde_json::Value::Object(m)) => weights_from(m).expect("物差しの重み"),
        _ => panic!("物差しの重みが読めません"),
    };
    SearchOptions {
        samples: 3,
        beam_width: 32,
        max_depth: 8,
        rescore_top: 4,
        lethal: true,
        allow: None,
        dedup: true,
        same_hand_once: true,
        chain: true,
        chain_fuse: false,
        score_turn_end: ScoreTurnEnd::All,
        mulligan: MulliganMode::Model,
        mulligan_samples: 100,
        mulligan_static: true,
        mulligan_net: true,
        settle_trades: true,
        dominance: true,
        reuse_plan: true,
        plan_candidates: 3,
        per_first: 0,
        next_lethal: 0.0,
        next_lethal_search: None,
        beam_pp: 0.0,
        extra_eval: None,
        weights: Some(Arc::new(weights)),
        opponent_search: None,
        opp_hand_samples: 1,
        opp_hand_common: false,
        peek_opp_hand: false,
        opp_fuse: false,
        danger_rescore: 0,
        reuse_agree: false,
    }
}

/// 相手どうしで試合 0〜6 を席とデッキを入れ替えて 14 試合打ち、手順と勝者のハッシュを返す
pub fn fingerprint() -> String {
    let decks = compare_decks();
    let reference = reference_options();
    let tasks: Vec<(u32, bool)> = (0..7).flat_map(|g| [(g, false), (g, true)]).collect();
    let lines = parallel_map(
        &tasks,
        |&(g, swap), _| {
            let (da, db) = compare_pair(&decks, g, swap);
            let mut a = SearchAgent::new(reference.clone());
            let mut b = SearchAgent::new(reference.clone());
            let mut log = Vec::new();
            let end = play_match(
                &mut [&mut a as &mut dyn Agent, &mut b],
                [&da.cards, &db.cards],
                g * 7 + if swap { 1 } else { 2 },
                |_, act| log.push(action_canon(act)),
            );
            format!("{g} {swap} {:?} {}", end.winner, fnv(&log.join(" ")))
        },
        |_, _, _, _| {},
    );
    fnv(&lines.join("\n"))
}

/// 表の列に使うデッキの短い名前
fn short_name(deck: &str) -> &str {
    const CLASSES: [&str; 7] = [
        "エルフ",
        "ロイヤル",
        "ウィッチ",
        "ドラゴン",
        "ナイトメア",
        "ビショップ",
        "ネメシス",
    ];
    CLASSES
        .iter()
        .find(|c| deck.ends_with(*c))
        .copied()
        .unwrap_or(deck)
}

fn doc_path() -> String {
    format!("{}/../../docs/yardstick.md", env!("CARGO_MANIFEST_DIR"))
}

/// コマンドの標準出力の 1 行目（失敗したら None）
fn command_line(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd)
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Some(text.lines().next().unwrap_or("").trim().to_string())
}

/// 今のコミット（コミットしていない変更があれば末尾に "+"。記録の表の変更は数えない）
fn commit_label() -> String {
    let head = command_line("git", &["rev-parse", "--short=7", "HEAD"]).unwrap_or("?".into());
    let dirty = std::process::Command::new("git")
        .args([
            "status",
            "--porcelain",
            "--untracked-files=no",
            "--",
            ":/",
            ":(exclude,top)docs/yardstick.md",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);
    if dirty {
        format!("{head}+")
    } else {
        head
    }
}

/// 表の見出し（この版の節を新しく始めるとき）
fn section_header(decks: &[String]) -> String {
    let mut cols = vec!["日付", "コミット", "名前", "設定", "勝率", "±", "試合"]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
    cols.extend(decks.iter().map(|d| short_name(d).to_string()));
    cols.push("1 試合".into());
    format!(
        "## 物差し {VERSION}（指紋 {FINGERPRINT}）\n\n| {} |\n|{}\n",
        cols.join(" | "),
        " --- |".repeat(cols.len())
    )
}

/// `docs/yardstick.md` に 1 行足す。最後の節がこの版でなければ、この版の節を新しく始める
fn record(row: &str, decks: &[String]) -> Result<(), String> {
    let path = doc_path();
    let mut text =
        std::fs::read_to_string(&path).map_err(|e| format!("{path} を読めません: {e}"))?;
    let last_section = text.lines().rev().find(|l| l.starts_with("## "));
    let current = format!("## 物差し {VERSION}（");
    if !last_section.is_some_and(|l| l.starts_with(&current)) {
        if !text.ends_with("\n\n") {
            text.push('\n');
        }
        text.push_str(&section_header(decks));
    }
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(row);
    text.push('\n');
    std::fs::write(&path, text).map_err(|e| format!("{path} に書けません: {e}"))
}

pub fn main(argv: &[String]) -> Result<(), String> {
    if argv.first().map(|s| s.as_str()) == Some("fingerprint") {
        let f = fingerprint();
        println!("物差し {VERSION} の指紋: {f}（記録してある指紋 {FINGERPRINT}）");
        return Ok(());
    }
    let mut opts_text = "{}".to_string();
    let mut games = 1000u32;
    let mut start = 0u32;
    let mut label = String::new();
    let mut write = false;
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
            "--label" => label = value(i)?,
            "--record" => {
                write = true;
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
    let subject = compare_options(&opts_text).map_err(|e| format!("--opts: {e}"))?;
    let decks = compare_decks();
    if decks.len() != 7 {
        return Err("比較用のデッキは 7 つの想定です".into());
    }
    let fp = fingerprint();
    if fp != FINGERPRINT {
        let msg = format!(
            "物差しの相手の手が変わっています（指紋 {fp}、記録してある指紋 {FINGERPRINT}）。src/runner/yardstick.rs の先頭の説明を見る"
        );
        if write {
            return Err(msg);
        }
        eprintln!("注意: {msg}");
    }
    let reference = reference_options();
    let tasks: Vec<(u32, bool)> = (0..games)
        .flat_map(|k| [(start + k, false), (start + k, true)])
        .collect();
    let t0 = Instant::now();
    let results = parallel_map(
        &tasks,
        |&(g, swap), _| play_compare_game(&subject, &reference, &decks, g, swap),
        |done, total, _, _| {
            if done % 200 == 0 || done == total {
                eprint!("\r{done}/{total}");
            }
        },
    );
    eprintln!();
    let n = results.len();
    let mut wins = 0;
    let mut per_deck = Tally::default();
    for d in &decks {
        per_deck.0.push((d.name.clone(), [0, 0]));
    }
    for (deck, won) in &results {
        wins += *won as u32;
        per_deck.add(deck, *won);
    }
    let p = wins as f64 / n as f64;
    let se = (p * (1.0 - p) / n as f64).sqrt();
    let secs = seconds_since(t0) / n as f64;
    println!(
        "{opts_text} vs 物差し {VERSION}: {wins}/{n} = {}%（標準誤差 ±{}）  {}s/試合",
        fixed(p * 100.0, 1),
        fixed(se * 100.0, 1),
        fixed(secs, 2)
    );
    println!("{}", per_deck.line());
    if write {
        let date = command_line("date", &["+%Y-%m-%d"]).unwrap_or("?".into());
        let last = start + games - 1;
        let mut cells = vec![
            date,
            commit_label(),
            label.replace('|', "\\|"),
            format!("`{}`", opts_text.replace('|', "\\|")),
            format!("**{}%**", fixed(p * 100.0, 1)),
            fixed(se * 100.0, 1),
            format!("{n}（g{start}〜{last}）"),
        ];
        cells.extend(
            per_deck
                .0
                .iter()
                .map(|(_, [w, t])| format!("{}%", fixed(*w as f64 / *t as f64 * 100.0, 1))),
        );
        cells.push(format!("{}秒", fixed(secs, 2)));
        let names: Vec<String> = decks.iter().map(|d| d.name.clone()).collect();
        record(&format!("| {} |", cells.join(" | ")), &names)?;
        println!("{} に記録しました", doc_path());
    }
    Ok(())
}
