//! JavaScript と同じ数の書き方（TypeScript 版のランナーと同じ出力にするため）。
//!
//! - `js_num`: `Number#toString`（`JSON.stringify` の数）。最短で元の値に戻る桁を、JavaScript の規則で固定小数・指数に書き分ける
//! - `round_precision`: `Number(x.toPrecision(p))`。ちょうど中間のときは絶対値の大きい方に丸める（Rust の書式は偶数に丸める）
//! - `to_fixed`: `x.toFixed(f)`。同じく中間は絶対値の大きい方

/// 指数表記の文字列（"1.234e-7" 等）を、符号なしの桁の列と指数に分ける
fn split_exp(s: &str) -> (String, i32) {
    let (mant, exp) = s.split_once('e').expect("指数表記");
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    (digits, exp.parse().expect("指数"))
}

/// `Number#toString`（有限の値）
pub fn js_num(x: f64) -> String {
    assert!(x.is_finite(), "有限でない数: {x}");
    if x == 0.0 {
        return "0".into();
    }
    if x < 0.0 {
        return format!("-{}", js_num(-x));
    }
    let (digits, exp) = split_exp(&format!("{x:e}"));
    let k = digits.len() as i32;
    let n = exp + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let (d1, rest) = digits.split_at(1);
        let sign = if n > 0 { '+' } else { '-' };
        if rest.is_empty() {
            format!("{d1}e{sign}{}", (n - 1).abs())
        } else {
            format!("{d1}.{rest}e{sign}{}", (n - 1).abs())
        }
    }
}

/// 桁の列に 1 を足す（繰り上がりで桁が増えたら true）
fn increment(digits: &mut [u8]) -> bool {
    for d in digits.iter_mut().rev() {
        if *d == b'9' {
            *d = b'0';
        } else {
            *d += 1;
            return false;
        }
    }
    true
}

/// x の正確な 10 進展開で、丸める位置（`cut` 桁目以降）がちょうど "5000…" か
fn exact_tie(exact_digits: &str, cut: usize) -> bool {
    let tail = exact_digits.as_bytes().get(cut..).unwrap_or(&[]);
    tail.first() == Some(&b'5') && tail[1..].iter().all(|&c| c == b'0')
}

/// `Number(x.toPrecision(p))`
pub fn round_precision(x: f64, p: usize) -> f64 {
    assert!(p >= 1 && x.is_finite());
    if x == 0.0 {
        return 0.0;
    }
    let near = format!("{:.*e}", p - 1, x);
    // 中間に近いときだけ、正確な展開で中間かを確かめる（Rust は偶数に、JavaScript は絶対値の大きい方に丸める）
    let (wide, _) = split_exp(&format!("{:.*e}", p + 20, x));
    if !exact_tie(&wide, p) {
        return near.parse().expect("数");
    }
    let (exact, exp) = split_exp(&format!("{:.1100e}", x));
    if !exact_tie(&exact, p) {
        return near.parse().expect("数");
    }
    let mut d = exact.as_bytes()[..p].to_vec();
    let mut exp = exp;
    if increment(&mut d) {
        d.insert(0, b'1');
        d.pop();
        exp += 1;
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let d = String::from_utf8(d).expect("桁");
    format!("{sign}{}.{}e{exp}", &d[..1], &d[1..])
        .parse()
        .expect("数")
}

/// `x.toFixed(f)`（|x| < 1e21）
pub fn to_fixed(x: f64, f: usize) -> String {
    assert!(x.is_finite() && x.abs() < 1e21);
    let x = if x == 0.0 { 0.0 } else { x };
    let near = format!("{x:.f$}");
    let wide = format!("{:.*}", f + 20, x.abs());
    let int_len = wide.find('.').expect("小数点");
    let digits = |s: &str| s.chars().filter(|c| c.is_ascii_digit()).collect::<String>();
    if !exact_tie(&digits(&wide), int_len + f) {
        return near;
    }
    let exact = digits(&format!("{:.1100}", x.abs()));
    if !exact_tie(&exact, int_len + f) {
        return near;
    }
    let mut d = exact.as_bytes()[..int_len + f].to_vec();
    let mut int_len = int_len;
    if increment(&mut d) {
        d.insert(0, b'1');
        int_len += 1;
    }
    let d = String::from_utf8(d).expect("桁");
    let sign = if x < 0.0 { "-" } else { "" };
    if f == 0 {
        format!("{sign}{d}")
    } else {
        format!("{sign}{}.{}", &d[..int_len], &d[int_len..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_to_string() {
        let cases: [(f64, &str); 14] = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-2.5, "-2.5"),
            (0.1, "0.1"),
            (123456.0, "123456"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (1.234e-7, "1.234e-7"),
            (0.30000000000000004, "0.30000000000000004"),
            (5e-324, "5e-324"),
        ];
        for (x, s) in cases {
            assert_eq!(js_num(x), s, "{x}");
        }
    }

    #[test]
    fn precision() {
        // 1.234375 = 79/64 はちょうど中間（JavaScript は 1.23438、偶数丸めなら 1.23437）
        assert_eq!(round_precision(1.234375, 6), 1.23438);
        assert_eq!(round_precision(-1.234375, 6), -1.23438);
        assert_eq!(round_precision(2.5, 1), 3.0);
        assert_eq!(round_precision(0.125, 2), 0.13);
        assert_eq!(round_precision(1.0 / 3.0, 4), 0.3333);
        assert_eq!(round_precision(9.99995, 4), 10.0);
        assert_eq!(round_precision(123456789.0, 6), 123457000.0);
    }

    #[test]
    fn fixed() {
        assert_eq!(to_fixed(12.25, 1), "12.3");
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(-0.125, 2), "-0.13");
        assert_eq!(to_fixed(1.005, 2), "1.00"); // 1.005 は 1.00499… なので切り下げ
        assert_eq!(to_fixed(99.95, 1), "100.0"); // 99.95 は 99.9500000000000028…
        assert_eq!(to_fixed(9.5, 0), "10");
        assert_eq!(to_fixed(0.0, 2), "0.00");
        assert_eq!(to_fixed(50.0, 1), "50.0");
    }
}
