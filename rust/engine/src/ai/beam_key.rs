//! ビームで残す局面を選ぶ並べ替えに足す「伸びしろ」の項（`beamKey`、2026-10-30）。
//!
//! ビームは途中の局面を「そこでターンを終えたら」の点数（ターン末の点数）で並べて残す。この点数は、その局面から届くターン末の最善の下限で、
//! まだ使っていない PP・攻撃・進化（このターンのうちにしか使えない資源）がある局面ほど低く見える。
//! ここで数える項に重みを掛けた和を、並べ替えのキーにだけ足す（ターンを終える局面の点数には足さない）。
//! 調べ方は `svwb beam-gap`（runner/beam_gap.rs）、記録は docs/ai-notes.md「ターン途中の評価の見直し」。

use crate::game::{can_attack_followers, can_attack_leader};
use crate::state::{hand_cost, opponent, Evolve, GameState, Phase, PlayerIndex};

/// 項の名前（設定の JSON の `beamKey` のキー。並びは beam_features の値の並び）
pub const BEAM_FEATURES: [&str; 7] = [
    // 残り PP
    "pp",
    // 使える PP（手札のカードのコストの組で、残り PP 以下の和の最大。場の上限・対象の有無・エンハンスは見ない）
    "usablePp",
    // まだ攻撃できる自分のフォロワーの攻撃力の和（リーダーを攻撃できるか、相手の場にフォロワーがいて攻撃できるもの）
    "attack",
    // その数
    "attackers",
    // このターンにまだ進化できるか（EP があり、進化できるターンで、進化していない自分のフォロワーがいて、このターンにまだ進化していない）
    "evolve",
    // 超進化の同じもの
    "superEvolve",
    // エクストラPP がまだ使えるか
    "extraPp",
];

pub const N_BEAM_FEATURES: usize = BEAM_FEATURES.len();

/// 局面 s の p の伸びしろの項（p の手番のメインフェイズでなければ全部 0。選択待ちでも数える）
pub fn beam_features(s: &GameState, p: PlayerIndex) -> [f64; N_BEAM_FEATURES] {
    let mut f = [0.0; N_BEAM_FEATURES];
    if s.phase != Phase::Main || s.active != p {
        return f;
    }
    let pl = &s.players[p];
    let pp = pl.pp.clamp(0, 62) as u32;
    // 作れるコストの和の集合（ビット i が立っていれば和 i が作れる）
    let mask = (1u64 << (pp + 1)) - 1;
    let mut reach: u64 = 1;
    for h in pl.hand.iter() {
        let c = hand_cost(h) as u32;
        if c <= pp {
            reach = (reach | (reach << c)) & mask;
        }
    }
    f[0] = pp as f64;
    f[1] = (63 - reach.leading_zeros()) as f64;
    let opp_followers = s.players[opponent(p)].board.iter().any(|b| b.is_follower);
    let mut unevolved = false;
    for b in pl.board.iter() {
        if !b.is_follower {
            continue;
        }
        unevolved |= b.evolve == Evolve::None;
        if can_attack_leader(s, b) || (opp_followers && can_attack_followers(s, b)) {
            f[2] += (b.attack + b.temp_attack).max(0) as f64;
            f[3] += 1.0;
        }
    }
    if unevolved && !pl.evolved_this_turn {
        if pl.ep > 0 && s.evolve_turn_reached(p) {
            f[4] = 1.0;
        }
        if pl.sep > 0 && s.super_evolve_turn_reached(p) {
            f[5] = 1.0;
        }
    }
    if pl.extra_pp_available {
        f[6] = 1.0;
    }
    f
}

/// 並べ替えのキーに足す項の重み（`beamKey`。BEAM_FEATURES の並び）
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeamKey(pub [f64; N_BEAM_FEATURES]);

impl BeamKey {
    /// 局面 s の p の伸びしろ（重みと項の積の和）
    pub fn bonus(&self, s: &GameState, p: PlayerIndex) -> f64 {
        let f = beam_features(s, p);
        self.0.iter().zip(f).map(|(w, x)| w * x).sum()
    }
}
