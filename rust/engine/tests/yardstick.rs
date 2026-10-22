//! 強さの物差しの相手（src/runner/yardstick.rs）の手が変わっていないか。
//! 変わったら、AI の変更が相手に漏れたのなら yardstick.rs に書き写して戻す。戻せないなら版を上げて指紋を書き直す

use svwb_engine::runner::yardstick::{
    fingerprint, fingerprint_of, Reference, FINGERPRINT, STRONG_FINGERPRINT, STRONG_VERSION,
    VERSION,
};

#[test]
fn yardstick_reference_unchanged() {
    let f = fingerprint();
    assert_eq!(
        f, FINGERPRINT,
        "物差し {VERSION} の相手の手が変わりました（src/runner/yardstick.rs の先頭の説明を見る）"
    );
}

#[test]
fn strong_yardstick_reference_unchanged() {
    let f = fingerprint_of(Reference::Strong);
    assert_eq!(
        f, STRONG_FINGERPRINT,
        "強い相手の物差し {STRONG_VERSION} の相手の手が変わりました（src/runner/yardstick.rs の先頭の説明を見る）"
    );
}
