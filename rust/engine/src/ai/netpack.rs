//! ページに置く補正と見込みの形（scripts/pack-nets.ts が JSON から作る）。ブラウザ（WASM）はこれを読み込んで既定の補正・見込みにする
//! （rust/wasm の load_nets、src/engine/wasm.ts）。CLI は今までどおり JSON を埋め込む・読む（この形は使わない）。
//!
//! 重みの数は JSON に書いた 10 進の数（有効数字 6〜7 桁）なので、整数の仮数 m と指数 e（値 = m × 10^e）に分けて送る。
//! m を zigzag にした 4 バイトと e（i16）の 2 バイトを、バイトの面ごと（全部の数の 1 バイト目、全部の数の 2 バイト目、…）に並べる。
//! gzip で縮めると JSON より 25% ほど小さい（gzip はページの JS が戻してから渡す）。
//! 戻すときは、|e| ≤ 22 なら m × 10^e を 1 回の掛け算か割り算で（m も 10^e も f64 でちょうど表せるので、結果は正しく丸めた値）、
//! それ以外は 10 進の文字列の解析で作る。どちらも 10 進の数に最も近い f64 なので、JSON を解析した値とビットまで同じ
//! （tests/nets.test.ts が、WASM の中で JSON を serde_json で解析した値のハッシュと比べる）。
//!
//! ファイルの形: "SVWBNET1"、ヘッダの JSON の長さ（u32 LE）、ヘッダの JSON、数の面。
//! ヘッダは `{"value": 補正の JSON, "potential": 見込みの JSON, "arrays": [[道, 個数], ...]}`。
//! 補正・見込みの JSON の数の配列（arrays に書いたもの）は空にしてあり、数の面は arrays の順に配列をつないだもの。-0 は m = 0・e = -32768

use super::aidata::{RawValueNet, RawValueNetLayer};
use super::potential::RawPotentialNet;
use serde::Deserialize;

const MAGIC: &[u8; 8] = b"SVWBNET1";

/// -0 の指数（m = 0 のとき）
const NEG_ZERO_EXP: i16 = i16::MIN;

/// 10^0〜10^22（どれも f64 でちょうど表せる）
const POW10: [f64; 23] = [
    1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16,
    1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
];

/// m × 10^e（10 進の数 m e e に最も近い f64。scripts/pack-nets.ts の decode と同じ）
pub fn decode(m: i32, e: i16) -> f64 {
    if m == 0 {
        return if e == NEG_ZERO_EXP { -0.0 } else { 0.0 };
    }
    let x = m as f64;
    match e {
        0 => x,
        1..=22 => x * POW10[e as usize],
        -22..=-1 => x / POW10[-e as usize],
        _ => format!("{m}e{e}")
            .parse::<f64>()
            .expect("10 進の数の文字列"),
    }
}

#[derive(Deserialize)]
struct Header {
    value: RawValueNet,
    potential: RawPotentialNet,
    arrays: Vec<(String, usize)>,
}

/// 道（"value.w1" 等）の配列
fn slot<'a>(
    value: &'a mut RawValueNet,
    potential: &'a mut RawPotentialNet,
    path: &str,
) -> Result<&'a mut Vec<f64>, String> {
    let layer = |rest: &str| -> Option<(usize, bool)> {
        let (i, wb) = rest.split_once('.')?;
        let i = i.parse::<usize>().ok()?;
        match wb {
            "w" => Some((i, true)),
            "b" => Some((i, false)),
            _ => None,
        }
    };
    fn pick(l: &mut RawValueNetLayer, w: bool) -> &mut Vec<f64> {
        if w {
            &mut l.w
        } else {
            &mut l.b
        }
    }
    let unknown = || format!("補正のファイルの知らない配列: {path}");
    Ok(match path {
        "value.w1" => &mut value.w1,
        "value.b1" => &mut value.b1,
        "value.w2" => &mut value.w2,
        "potential.w1" => &mut potential.w1,
        "potential.b1" => &mut potential.b1,
        "potential.w2" => &mut potential.w2,
        _ => {
            if let Some(rest) = path.strip_prefix("value.layers.") {
                let (i, w) = layer(rest).ok_or_else(unknown)?;
                pick(value.layers.get_mut(i).ok_or_else(unknown)?, w)
            } else if let Some(rest) = path.strip_prefix("value.board.layers.") {
                let (i, w) = layer(rest).ok_or_else(unknown)?;
                let board = value.board.as_mut().ok_or_else(unknown)?;
                pick(board.layers.get_mut(i).ok_or_else(unknown)?, w)
            } else {
                return Err(unknown());
            }
        }
    })
}

/// 補正のファイル（gzip を戻したもの）から補正と見込みを作る
pub fn unpack(bytes: &[u8]) -> Result<(RawValueNet, RawPotentialNet), String> {
    if bytes.len() < 12 || &bytes[..8] != MAGIC {
        return Err("補正のファイルではありません（先頭が SVWBNET1 でない）".into());
    }
    let head_len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let head = bytes
        .get(12..12 + head_len)
        .ok_or("補正のファイルのヘッダが切れています")?;
    let Header {
        mut value,
        mut potential,
        arrays,
    } = serde_json::from_slice(head)
        .map_err(|e| format!("補正のファイルのヘッダが読めません: {e}"))?;
    let body = &bytes[12 + head_len..];
    let n: usize = arrays.iter().map(|(_, k)| k).sum();
    if body.len() != n * 6 {
        return Err(format!(
            "補正のファイルの数の面の長さが違います（{} バイト、{n} 個の数なら {} バイト）",
            body.len(),
            n * 6
        ));
    }
    let (b0, rest) = body.split_at(n);
    let (b1, rest) = rest.split_at(n);
    let (b2, rest) = rest.split_at(n);
    let (b3, rest) = rest.split_at(n);
    let (e0, e1) = rest.split_at(n);
    let mut i = 0;
    for (path, k) in &arrays {
        let dest = slot(&mut value, &mut potential, path)?;
        if !dest.is_empty() {
            return Err(format!(
                "補正のファイルの配列 {path} が空でないか、2 度あります"
            ));
        }
        dest.reserve_exact(*k);
        for j in i..i + k {
            let z = u32::from_le_bytes([b0[j], b1[j], b2[j], b3[j]]);
            let m = ((z >> 1) as i32) ^ -((z & 1) as i32);
            dest.push(decode(m, i16::from_le_bytes([e0[j], e1[j]])));
        }
        i += k;
    }
    Ok((value, potential))
}

/// 補正と見込みの中身のハッシュ（FNV-1a 32 ビット。数は f64 のビット列）。
/// ページが読み込んだ補正が JSON と同じ値かを確かめる（tests/nets.test.ts）
pub fn checksum(value: &RawValueNet, potential: &RawPotentialNet) -> String {
    let mut h: u32 = 0x811c9dc5;
    let mut bytes = |b: &[u8]| {
        for &x in b {
            h = (h ^ x as u32).wrapping_mul(0x01000193);
        }
    };
    let mut nums = |xs: &[f64]| {
        for x in xs {
            bytes(&x.to_bits().to_le_bytes());
        }
    };
    nums(&value.w1);
    nums(&value.b1);
    for l in &value.layers {
        nums(&l.w);
        nums(&l.b);
    }
    nums(&value.w2);
    nums(&[value.b2, value.a, value.c]);
    if let Some(board) = &value.board {
        for l in &board.layers {
            nums(&l.w);
            nums(&l.b);
        }
    }
    // リーサルの出力（ヘッダの JSON に残る。winForm が survival なら勝つ確率に効く）
    if let Some(l) = &value.lethal_head {
        nums(&l.w);
        nums(&[l.b]);
    }
    nums(&potential.w1);
    nums(&potential.b1);
    nums(&potential.w2);
    nums(&[potential.b2]);
    let mut text = |s: &str| {
        for &x in s.as_bytes() {
            h = (h ^ x as u32).wrapping_mul(0x01000193);
        }
        h = (h ^ 0xff).wrapping_mul(0x01000193);
    };
    for list in [
        &value.vocab,
        &value.zones,
        &value.scalars,
        &potential.vocab,
        &potential.zones,
        &potential.scalars,
    ] {
        for s in list {
            text(s);
        }
        text("");
    }
    if let Some(board) = &value.board {
        for s in board.features.iter().chain(&board.grants) {
            text(s);
        }
    }
    text(&format!(
        "{} {} {} {} {} {} {} {} {}",
        value.kind,
        value.version,
        value.hidden,
        potential.kind,
        potential.version,
        potential.hidden,
        serde_json::to_string(&value.base_weights).unwrap_or_default(),
        value.lethal_head.is_some(),
        value.win_form.as_deref().unwrap_or("logit")
    ));
    format!("{h:08x}")
}

/// 補正と見込みの JSON（`{"value": 補正, "potential": 見込み}`）を CLI と同じく serde_json で読んだもののハッシュ（tests/nets.test.ts）
pub fn checksum_of_json(text: &[u8]) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Both {
        value: RawValueNet,
        potential: RawPotentialNet,
    }
    let b: Both =
        serde_json::from_slice(text).map_err(|e| format!("補正の JSON が読めません: {e}"))?;
    Ok(checksum(&b.value, &b.potential))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_matches_parsing() {
        for s in [
            "-0.358538",
            "0.0491367",
            "5.90251",
            "-6.027962e-81",
            "7.002871e-79",
            "3.19391e-85",
            "-7.509367e-123",
            "4.9e-324",
            "1e22",
            "-123456789",
            "12345e30",
            "0.5",
        ] {
            let x: f64 = s.parse().unwrap();
            let (mant, exp) = s.split_once('e').unwrap_or((s, "0"));
            let neg = mant.starts_with('-');
            let mant = mant.trim_start_matches('-');
            let frac = mant.split_once('.').map_or(0, |(_, f)| f.len());
            let digits: i32 = mant.replace('.', "").parse().unwrap();
            let m = if neg { -digits } else { digits };
            let e = exp.parse::<i32>().unwrap() - frac as i32;
            assert_eq!(decode(m, e as i16).to_bits(), x.to_bits(), "{s}");
        }
        assert_eq!(decode(0, NEG_ZERO_EXP).to_bits(), (-0.0f64).to_bits());
        assert_eq!(decode(0, 0).to_bits(), 0.0f64.to_bits());
    }
}
