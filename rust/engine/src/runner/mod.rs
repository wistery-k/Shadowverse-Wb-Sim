//! 実験のランナー（TypeScript 版 scripts/ の compare・rhino-compare・td selfplay の移植と、強さの物差し yardstick）。
//!
//! 試合の組み方・シード・画面への出力・書き出すファイル（JSON Lines）は TypeScript 版と同じにしてある。
//! td selfplay の書き出したファイルは、そのまま `npm run td -- train` に渡せる。
//! 試合は CPU のコア数だけのスレッドで並列に行う（環境変数 THREADS で変えられる）。

pub mod compare;
pub mod deck_compare;
pub mod human_plan;
pub mod meta;
pub mod mulligan_compare;
pub mod options;
pub mod parallel;
pub mod rhino_compare;
pub mod td;
pub mod yardstick;

use crate::data::{data, Deck};

/// 比較・自己対戦に使わないデフォルトデッキ（クラスごとに 1 つにするため）
pub const EXCLUDED_DECKS: [&str; 1] = ["ランプドラゴン"];

/// 比較に使うデッキ（各クラス 1 つずつの 7 つ。デフォルトデッキの順）
pub fn compare_decks() -> Vec<&'static Deck> {
    data()
        .decks
        .iter()
        .filter(|d| !EXCLUDED_DECKS.contains(&d.name.as_str()))
        .collect()
}

/// `x.toFixed(f)`（NaN は "NaN"）
pub fn fixed(x: f64, f: usize) -> String {
    if x.is_nan() {
        "NaN".into()
    } else {
        crate::jsnum::to_fixed(x, f)
    }
}

/// 経過時間（秒）
pub fn seconds_since(t0: std::time::Instant) -> f64 {
    t0.elapsed().as_secs_f64()
}

/// 名前ごとの [勝ち, 試合数]（最初に現れた順。TypeScript 版の Map）
#[derive(Default)]
pub struct Tally(pub Vec<(String, [u32; 2])>);

impl Tally {
    pub fn add(&mut self, name: &str, won: bool) {
        let i = match self.0.iter().position(|(k, _)| k == name) {
            Some(i) => i,
            None => {
                self.0.push((name.to_string(), [0, 0]));
                self.0.len() - 1
            }
        };
        self.0[i].1[0] += won as u32;
        self.0[i].1[1] += 1;
    }

    /// "名前 勝ち/試合数, ..."
    pub fn line(&self) -> String {
        self.0
            .iter()
            .map(|(k, [w, t])| format!("{k} {w}/{t}"))
            .collect::<Vec<_>>()
            .join(", ")
    }
}
