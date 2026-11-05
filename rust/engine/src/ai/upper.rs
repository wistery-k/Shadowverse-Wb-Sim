//! 自分のターンの木の探索（`tree`。ai/search/tree.rs）の楽観の値に足す、伸びしろの上側の表（2026-11-05）。
//!
//! ターン途中の局面 s（自分のメインフェイズ）の伸びしろ h = （s から届くターン末の点数の最大）−（s でターンを終えた点数 v）は 0 以上で、
//! 手数が進むほど 0 に寄る（docs/ai-notes.md「ターン途中の評価の見直し」）。この表は、h の上側の分位点（tau。0.9 なら 9 割の局面で h がこれ以下）を、
//! 局面の形の組（手数・使える PP・攻撃できる数・進化できるか・学習した見込みの値）ごとに持つ。楽観の値は v + u。
//! 細かい組から順に引き、データの少ない組（min 未満）は粗い組に落とす。
//!
//! 表は `svwb upper-fit`（runner/upper_fit.rs）が `svwb beam-gap --sample k --nodes` の行から作る。

use super::beam_key::beam_features;
use crate::json::Json;
use crate::state::{GameState, PlayerIndex};
use std::collections::HashMap;

/// 表の軸
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpperDim {
    /// 手数（ビームの段。1, 2, 3, 4, 5, 6〜7, 8〜10, 11〜）
    Depth,
    /// 使える PP（0, 1, 2, 3, 4〜5, 6〜）
    Pp,
    /// まだ攻撃できる自分のフォロワーの数（0, 1, 2, 3〜）
    Attackers,
    /// 進化か超進化がまだできるか
    Evolve,
    /// 学習した見込み（potentialNet）の値（区切りは表の gEdges）
    Pot,
}

impl UpperDim {
    pub fn name(self) -> &'static str {
        match self {
            UpperDim::Depth => "depth",
            UpperDim::Pp => "pp",
            UpperDim::Attackers => "attackers",
            UpperDim::Evolve => "evolve",
            UpperDim::Pot => "pot",
        }
    }

    pub fn from_name(s: &str) -> Option<UpperDim> {
        [
            UpperDim::Depth,
            UpperDim::Pp,
            UpperDim::Attackers,
            UpperDim::Evolve,
            UpperDim::Pot,
        ]
        .into_iter()
        .find(|d| d.name() == s)
    }
}

/// 粗くしていく組の並び（細かい順。最後は全体）
pub const UPPER_LEVELS: [&[UpperDim]; 5] = [
    &[
        UpperDim::Depth,
        UpperDim::Pp,
        UpperDim::Attackers,
        UpperDim::Evolve,
        UpperDim::Pot,
    ],
    &[
        UpperDim::Depth,
        UpperDim::Pp,
        UpperDim::Attackers,
        UpperDim::Evolve,
    ],
    &[UpperDim::Depth, UpperDim::Pp],
    &[UpperDim::Depth],
    &[],
];

/// 局面の形（表を引く値）
#[derive(Clone, Copy, Debug)]
pub struct UpperShape {
    pub depth: u32,
    pub usable_pp: f64,
    pub attackers: f64,
    pub evolve: bool,
    /// 見込みの値（使わなければ None。そのときは Pot の軸のある組を飛ばす）
    pub pot: Option<f64>,
}

impl UpperShape {
    pub fn of(s: &GameState, p: PlayerIndex, depth: u32, pot: Option<f64>) -> UpperShape {
        let f = beam_features(s, p);
        UpperShape {
            depth,
            usable_pp: f[1],
            attackers: f[3],
            evolve: f[4] > 0.0 || f[5] > 0.0,
            pot,
        }
    }

    /// 軸 d の区切りの番号（Pot で見込みが無ければ None）
    pub fn bin(&self, d: UpperDim, g_edges: &[f64]) -> Option<u8> {
        Some(match d {
            UpperDim::Depth => match self.depth {
                0..=1 => 0,
                2 => 1,
                3 => 2,
                4 => 3,
                5 => 4,
                6..=7 => 5,
                8..=10 => 6,
                _ => 7,
            },
            UpperDim::Pp => match self.usable_pp as i64 {
                i64::MIN..=0 => 0,
                1 => 1,
                2 => 2,
                3 => 3,
                4..=5 => 4,
                _ => 5,
            },
            UpperDim::Attackers => (self.attackers as i64).clamp(0, 3) as u8,
            UpperDim::Evolve => self.evolve as u8,
            UpperDim::Pot => {
                let g = self.pot?;
                g_edges.iter().take_while(|&&e| g >= e).count() as u8
            }
        })
    }

    pub fn key(&self, dims: &[UpperDim], g_edges: &[f64]) -> Option<Vec<u8>> {
        dims.iter().map(|&d| self.bin(d, g_edges)).collect()
    }
}

struct Level {
    dims: Vec<UpperDim>,
    cells: HashMap<Vec<u8>, f64>,
}

/// 伸びしろの上側の表
pub struct UpperTable {
    /// 分位点（0.9 なら 9 割点）
    pub tau: f64,
    /// 見込みの値の区切り（昇順）
    pub g_edges: Vec<f64>,
    levels: Vec<Level>,
}

impl UpperTable {
    /// 表の JSON（upper-fit が書くもの）を読む
    pub fn from_json(v: &Json) -> Result<UpperTable, String> {
        let num = |o: &Json, k: &str| match o.get(k) {
            Some(Json::Num(x)) => Ok(*x),
            _ => Err(format!("伸びしろの表に {k} がありません")),
        };
        let tau = num(v, "tau")?;
        let g_edges = match v.get("gEdges") {
            Some(Json::Arr(xs)) => xs
                .iter()
                .map(|x| match x {
                    Json::Num(x) => Ok(*x),
                    _ => Err("gEdges は数の配列".to_string()),
                })
                .collect::<Result<Vec<f64>, String>>()?,
            _ => Vec::new(),
        };
        let Some(Json::Arr(ls)) = v.get("levels") else {
            return Err("伸びしろの表に levels がありません".into());
        };
        let mut levels = Vec::new();
        for l in ls {
            let dims = match l.get("dims") {
                Some(Json::Arr(ds)) => ds
                    .iter()
                    .map(|d| match d {
                        Json::Str(s) => UpperDim::from_name(s).ok_or(format!("知らない軸: {s}")),
                        _ => Err("dims は名前の配列".to_string()),
                    })
                    .collect::<Result<Vec<UpperDim>, String>>()?,
                _ => return Err("levels の要素に dims がありません".into()),
            };
            let mut cells = HashMap::new();
            if let Some(Json::Arr(cs)) = l.get("cells") {
                for c in cs {
                    let (Some(Json::Arr(k)), Some(Json::Num(u))) = (c.get("key"), c.get("u"))
                    else {
                        return Err("cells の要素は {key, u, n}".into());
                    };
                    let key = k
                        .iter()
                        .map(|x| match x {
                            Json::Num(x) => Ok(*x as u8),
                            _ => Err("key は数の配列".to_string()),
                        })
                        .collect::<Result<Vec<u8>, String>>()?;
                    cells.insert(key, *u);
                }
            }
            levels.push(Level { dims, cells });
        }
        Ok(UpperTable {
            tau,
            g_edges,
            levels,
        })
    }

    pub fn load(path: &str) -> Result<UpperTable, String> {
        let text =
            std::fs::read_to_string(path).map_err(|e| format!("{path} を読めません: {e}"))?;
        UpperTable::from_json(&Json::parse(&text)?).map_err(|e| format!("{path}: {e}"))
    }

    /// 形 sh の伸びしろの上側（細かい組から引き、無ければ粗い組。どこにも無ければ 0）
    pub fn upper(&self, sh: &UpperShape) -> f64 {
        for l in &self.levels {
            let Some(key) = sh.key(&l.dims, &self.g_edges) else {
                continue;
            };
            if let Some(&u) = l.cells.get(&key) {
                return u;
            }
        }
        0.0
    }
}

/// 表を作る（upper-fit）: 形と伸びしろの組から、組ごとに伸びしろの tau 分位点を求め、min 個以上ある組だけを残す。
/// g_edges は見込みの値の区切り（見込みの値の分位点から作る）
pub fn fit_upper(rows: &[(UpperShape, f64)], tau: f64, min: usize, g_edges: Vec<f64>) -> Json {
    let mut levels = Vec::new();
    for dims in UPPER_LEVELS {
        let mut groups: HashMap<Vec<u8>, Vec<f64>> = HashMap::new();
        for (sh, h) in rows {
            if let Some(key) = sh.key(dims, &g_edges) {
                groups.entry(key).or_default().push(*h);
            }
        }
        let mut cells: Vec<(Vec<u8>, f64, usize)> = groups
            .into_iter()
            .filter(|(_, hs)| hs.len() >= min || dims.is_empty())
            .map(|(k, mut hs)| {
                hs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                (k, quantile(&hs, tau), hs.len())
            })
            .collect();
        cells.sort_by(|a, b| a.0.cmp(&b.0));
        levels.push(Json::Obj(vec![
            (
                "dims".into(),
                Json::Arr(dims.iter().map(|d| Json::Str(d.name().into())).collect()),
            ),
            (
                "cells".into(),
                Json::Arr(
                    cells
                        .into_iter()
                        .map(|(k, u, n)| {
                            Json::Obj(vec![
                                (
                                    "key".into(),
                                    Json::Arr(k.iter().map(|&x| Json::Num(x as f64)).collect()),
                                ),
                                ("u".into(), Json::Num((u * 1000.0).round() / 1000.0)),
                                ("n".into(), Json::Num(n as f64)),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]));
    }
    Json::Obj(vec![
        ("tau".into(), Json::Num(tau)),
        ("min".into(), Json::Num(min as f64)),
        (
            "gEdges".into(),
            Json::Arr(g_edges.into_iter().map(Json::Num).collect()),
        ),
        ("levels".into(), Json::Arr(levels)),
    ])
}

/// 昇順に並べた xs の q 分位点（線形補間。空なら 0）
pub fn quantile(xs: &[f64], q: f64) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let pos = q.clamp(0.0, 1.0) * (xs.len() - 1) as f64;
    let i = pos.floor() as usize;
    let j = (i + 1).min(xs.len() - 1);
    xs[i] + (xs[j] - xs[i]) * (pos - i as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(depth: u32, pp: f64, pot: f64) -> UpperShape {
        UpperShape {
            depth,
            usable_pp: pp,
            attackers: 0.0,
            evolve: false,
            pot: Some(pot),
        }
    }

    #[test]
    fn fit_and_lookup_falls_back_to_coarser_cells() {
        let mut rows = Vec::new();
        // 手数 1・使える PP 3 は伸びしろ 0〜99、手数 5 は 0
        for i in 0..100 {
            rows.push((shape(1, 3.0, 0.0), i as f64));
            rows.push((shape(5, 0.0, 0.0), 0.0));
        }
        // 手数 1・使える PP 6 は 2 個だけ（細かい組には残らない）
        rows.push((shape(1, 6.0, 0.0), 1000.0));
        rows.push((shape(1, 6.0, 0.0), 1000.0));
        let t = UpperTable::from_json(&fit_upper(&rows, 0.9, 10, vec![0.5])).unwrap();
        assert!((t.upper(&shape(1, 3.0, 0.0)) - 89.1).abs() < 1e-6);
        assert_eq!(t.upper(&shape(5, 0.0, 0.0)), 0.0);
        // 使える PP 6 の組は無いので手数 1 の組（102 個）に落ちる
        let u = t.upper(&shape(1, 6.0, 0.0));
        assert!(u > 80.0 && u < 100.0, "{u}");
        // 見込みが無いときは Pot の軸のない組から引く
        let mut sh = shape(1, 3.0, 0.0);
        sh.pot = None;
        assert!((t.upper(&sh) - 89.1).abs() < 1e-6);
    }

    #[test]
    fn quantile_interpolates() {
        assert_eq!(quantile(&[], 0.5), 0.0);
        assert_eq!(quantile(&[1.0, 3.0], 0.5), 2.0);
        assert_eq!(quantile(&[1.0, 3.0, 5.0], 1.0), 5.0);
    }
}
