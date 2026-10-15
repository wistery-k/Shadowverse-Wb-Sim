//! 項目の順番を保つ JSON の値（設定の JSON を TypeScript 版の `JSON.parse`・`{ ...a, ...b }`・`JSON.stringify` と同じに扱うため）。
//!
//! serde_json の `Value` はオブジェクトの項目を名前順に並べるので、表示が TypeScript 版と変わる。

use crate::jsnum::js_num;
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    /// 項目（書いた順。同じ名前は後のもので置き換える）
    Obj(Vec<(String, Json)>),
    /// 関数（`JSON.stringify` で書かれない値。学習した補正を入れた extraEval 等）
    Func,
}

impl Json {
    pub fn parse(text: &str) -> Result<Json, String> {
        serde_json::from_str(text).map_err(|e| format!("JSON が読めません: {e}"))
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// 項目を設定する（あれば同じ位置で置き換え、無ければ最後に足す。`o[key] = v`）
    pub fn set(&mut self, key: &str, v: Json) {
        if let Json::Obj(items) = self {
            match items.iter_mut().find(|(k, _)| k == key) {
                Some(e) => e.1 = v,
                None => items.push((key.to_string(), v)),
            }
        }
    }

    /// 項目を取り除いて返す（`const { key, ...rest } = o`）
    pub fn take(&mut self, key: &str) -> Option<Json> {
        match self {
            Json::Obj(items) => {
                let i = items.iter().position(|(k, _)| k == key)?;
                Some(items.remove(i).1)
            }
            _ => None,
        }
    }

    /// `{ ...self, ...other }`（other がオブジェクトでなければそのまま）
    pub fn spread(&self, other: &Json) -> Json {
        let mut out = self.clone();
        if let Json::Obj(items) = other {
            for (k, v) in items {
                out.set(k, v.clone());
            }
        }
        out
    }

    pub fn is_obj(&self) -> bool {
        matches!(self, Json::Obj(_))
    }

    /// serde_json の値にする（重みを読むため。関数は null）
    pub fn to_value(&self) -> serde_json::Value {
        match self {
            Json::Null | Json::Func => serde_json::Value::Null,
            Json::Bool(b) => serde_json::Value::Bool(*b),
            Json::Num(x) => serde_json::Number::from_f64(*x)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null),
            Json::Str(s) => serde_json::Value::String(s.clone()),
            Json::Arr(xs) => serde_json::Value::Array(xs.iter().map(Json::to_value).collect()),
            Json::Obj(items) => serde_json::Value::Object(
                items
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_value()))
                    .collect(),
            ),
        }
    }

    /// 項目を名前順に並べた `JSON.stringify`（項目の順番によらず、同じ内容なら同じ文字列。比べる・引くための形）
    pub fn canonical(&self) -> String {
        self.sorted().stringify()
    }

    fn sorted(&self) -> Json {
        match self {
            Json::Arr(xs) => Json::Arr(xs.iter().map(Json::sorted).collect()),
            Json::Obj(items) => {
                let mut v: Vec<(String, Json)> =
                    items.iter().map(|(k, x)| (k.clone(), x.sorted())).collect();
                v.sort_by(|a, b| a.0.cmp(&b.0));
                Json::Obj(v)
            }
            x => x.clone(),
        }
    }

    /// `JSON.stringify`（オブジェクトの項目は、配列の添字の形の名前を小さい順に先に、残りを書いた順に並べる）
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Null | Json::Func => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Num(x) => out.push_str(&if x.is_finite() {
                js_num(*x)
            } else {
                "null".into()
            }),
            Json::Str(s) => out.push_str(&serde_json::to_string(s).expect("文字列")),
            Json::Arr(xs) => {
                out.push('[');
                for (i, x) in xs.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    x.write(out);
                }
                out.push(']');
            }
            Json::Obj(items) => {
                let mut index: Vec<(u32, &String, &Json)> = items
                    .iter()
                    .filter_map(|(k, v)| array_index(k).map(|n| (n, k, v)))
                    .collect();
                index.sort_by_key(|e| e.0);
                let named = items.iter().filter(|(k, _)| array_index(k).is_none());
                out.push('{');
                let mut first = true;
                for (k, v) in index
                    .into_iter()
                    .map(|(_, k, v)| (k, v))
                    .chain(named.map(|(k, v)| (k, v)))
                {
                    if matches!(v, Json::Func) {
                        continue;
                    }
                    if !first {
                        out.push(',');
                    }
                    first = false;
                    out.push_str(&serde_json::to_string(k).expect("文字列"));
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

/// 配列の添字の形の名前（"0"、先頭が 0 でない 2^32 - 1 未満の整数）なら、その値
fn array_index(k: &str) -> Option<u32> {
    if k.is_empty() || !k.bytes().all(|b| b.is_ascii_digit()) || (k.len() > 1 && k.starts_with('0'))
    {
        return None;
    }
    k.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Json, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Json;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, b: bool) -> Result<Json, E> {
                Ok(Json::Bool(b))
            }
            fn visit_i64<E>(self, x: i64) -> Result<Json, E> {
                Ok(Json::Num(x as f64))
            }
            fn visit_u64<E>(self, x: u64) -> Result<Json, E> {
                Ok(Json::Num(x as f64))
            }
            fn visit_f64<E>(self, x: f64) -> Result<Json, E> {
                Ok(Json::Num(x))
            }
            fn visit_str<E>(self, s: &str) -> Result<Json, E> {
                Ok(Json::Str(s.to_string()))
            }
            fn visit_string<E>(self, s: String) -> Result<Json, E> {
                Ok(Json::Str(s))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut xs = Vec::new();
                while let Some(x) = seq.next_element()? {
                    xs.push(x);
                }
                Ok(Json::Arr(xs))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut o = Json::Obj(Vec::new());
                while let Some((k, v)) = map.next_entry::<String, Json>()? {
                    o.set(&k, v);
                }
                Ok(o)
            }
        }
        d.deserialize_any(V)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_order_like_javascript() {
        let a = Json::parse(r#"{"b":1,"a":[1.5,true,null],"20":"x","3":{"z":0.1}}"#).unwrap();
        assert_eq!(
            a.stringify(),
            r#"{"3":{"z":0.1},"20":"x","b":1,"a":[1.5,true,null]}"#
        );
        let b = a.spread(&Json::parse(r#"{"a":2,"c":"\n"}"#).unwrap());
        assert_eq!(
            b.stringify(),
            r#"{"3":{"z":0.1},"20":"x","b":1,"a":2,"c":"\n"}"#
        );
        let mut c = b.clone();
        c.set("f", Json::Func);
        assert_eq!(c.take("b"), Some(Json::Num(1.0)));
        assert_eq!(c.stringify(), r#"{"3":{"z":0.1},"20":"x","a":2,"c":"\n"}"#);
        assert_eq!(Json::parse("1e21").unwrap().stringify(), "1e+21");
        assert_eq!(
            Json::parse(r#"{"01":1,"1":2}"#).unwrap().stringify(),
            r#"{"1":2,"01":1}"#
        );
    }
}
