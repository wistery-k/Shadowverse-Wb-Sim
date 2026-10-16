//! 強さの物差しの相手（src/runner/yardstick.rs）の手が変わっていないか。
//! 変わったら、AI の変更が相手に漏れたのなら yardstick.rs に書き写して戻す。戻せないなら VERSION を上げて FINGERPRINT を書き直す

use svwb_engine::runner::yardstick::{fingerprint, FINGERPRINT, VERSION};

#[test]
fn yardstick_reference_unchanged() {
    let f = fingerprint();
    assert_eq!(
        f, FINGERPRINT,
        "物差し {VERSION} の相手の手が変わりました（src/runner/yardstick.rs の先頭の説明を見る）"
    );
}
