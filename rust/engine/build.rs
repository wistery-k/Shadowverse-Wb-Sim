//! 埋め込むデータ（rust/engine/data/。`npm run rust-data` が書き出す）が、元のファイルと合っているかを確かめる。
//!
//! `npm run rust-data` は元のファイルの中身の指紋を data/sources.txt に書く。ここでは同じ指紋を計算し直し、
//! 違えば（元のファイルが変わったのに書き出し直していなければ）ビルドを止める。
//! 古いデータのまま作ると、学習した補正などが前の版のまま動く（2026-10-21、判定をやり直した原因）。

use std::fs;
use std::path::Path;

/// FNV-1a（32 ビット）。scripts/rust-data-main.ts と同じ
fn fnv1a(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for &b in bytes {
        h = (h ^ b as u32).wrapping_mul(0x01000193);
    }
    h
}

/// 理由を出してビルドを止める
fn stop(msg: String) -> ! {
    eprintln!("{msg}。リポジトリの最上位で npm run rust-data を実行してから作り直す");
    std::process::exit(1);
}

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let engine = Path::new(&manifest);
    let root = engine.join("../..");
    let sources = engine.join("data/sources.txt");
    println!("cargo:rerun-if-changed={}", sources.display());
    let text = fs::read_to_string(&sources)
        .unwrap_or_else(|_| stop(format!("{} がありません", sources.display())));
    for line in text
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
    {
        let (hash, path) = line
            .split_once(' ')
            .unwrap_or_else(|| stop(format!("sources.txt の行が読めません（{line}）")));
        let file = root.join(path);
        println!("cargo:rerun-if-changed={}", file.display());
        let now = fs::read(&file)
            .map(|b| format!("{:08x}", fnv1a(&b)))
            .unwrap_or_else(|_| "（ない）".into());
        if now != hash {
            stop(format!(
                "埋め込むデータが古くなっています（{path} が書き出したときから変わった）"
            ));
        }
    }
}
