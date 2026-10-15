//! 決まった試合の結果が、保存したもの（tests/golden/*.txt）と同じか（src/golden.rs）。
//! ルールや AI を意図して変えたときは `svwb golden write` で保存し直す。
//! AI の試合は時間がかかるので `cargo test --release` で行う。

use svwb_engine::golden::{check, SETS};

fn golden(name: &str) {
    let set = SETS.iter().find(|s| s.name == name).expect("組の名前");
    let path = format!("{}/tests/golden/{name}.txt", env!("CARGO_MANIFEST_DIR"));
    let expected =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path} を読めません: {e}"));
    if let Err(e) = check(set, &expected) {
        panic!("{e}\n意図した変更なら svwb golden write {name} で保存し直す");
    }
}

macro_rules! golden_tests {
    ($($f:ident => $name:literal),* $(,)?) => {
        $(#[test] fn $f() { golden($name); })*
        #[test]
        fn all_sets_tested() {
            let tested = [$($name),*];
            for s in SETS.iter() {
                assert!(tested.contains(&s.name), "{} のテストがありません", s.name);
            }
        }
    };
}

golden_tests! {
    engine_default => "engine-default",
    engine_random => "engine-random",
    engine_json => "engine-json",
    ai_search => "ai-search",
    ai_search_classic => "ai-search-classic",
    ai_rhino => "ai-rhino",
    ai_rhino_lethal => "ai-rhino-lethal",
    ai_greedy => "ai-greedy",
    ai_greedy_base => "ai-greedy-base",
    ai_random => "ai-random",
}
