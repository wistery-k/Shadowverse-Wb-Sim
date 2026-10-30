//! ターン途中の局面の見込みを当てる小さなネットワーク（`potentialNet`、2026-10-30）。
//!
//! ビームは途中の局面を「そこでターンを終えたら」の点数で並べるが、その点数は手数の違う局面どうしでは比べられず、
//! 同じ段の中でも、攻撃を後に残す並び・融合・コンボの長い並びを低く見る（docs/ai-notes.md「ターン途中の評価の見直し」）。
//! このネットワークは、局面 s（p のメインフェイズ）から届くターン末の点数の最大と、s でターンを終えた点数の差（見込み）を、
//! 同じ局面・同じ段の中の順位が合うように学ぶ。並べ替えのキーに足すだけで、ターンを終える局面の点数には足さない。
//!
//! 入力は、カードごとの入力（P_ZONES × 語彙）と数値の入力（P_SCALARS）。学習のデータは `svwb beam-gap --inputs`、
//! 学習は `scripts/train-potential.py`。

use super::beam_key::beam_features;
use crate::data::{data, CardIdx, WARD};
use crate::game::{can_attack_followers, can_attack_leader};
use crate::state::{hand_cost, opponent, Evolve, GameState, Phase, PlayerIndex};
use serde::Deserialize;
use std::cell::RefCell;

/// カードごとの入力の種類（並びはモデルと同じでなければならない）
pub const P_ZONES: [&str; 8] = [
    // 自分の手札（枚数）
    "hand",
    // 自分の手札のうち、今の PP で出せるコストのもの
    "handPlayable",
    // 自分の手札のスペルブーストの回数（10 で頭打ち、5 で割る）
    "handBoost",
    // 自分の場
    "board",
    // 自分の場のフォロワーのうち、まだ攻撃できるもの（攻撃力 / 5）
    "boardReady",
    // 自分の場の進化していないフォロワー
    "boardUnevolved",
    // 自分の場の進化したフォロワー
    "boardEvolved",
    // 相手の場
    "oppBoard",
];

/// 数値の入力（並びはモデルと同じでなければならない）
pub const P_SCALARS: [&str; 24] = [
    "pp",
    "usablePp",
    "attack",
    "attackers",
    "evolve",
    "superEvolve",
    "extraPp",
    "maxPp",
    "combo",
    "handSize",
    "boardSize",
    "oppFollowers",
    "oppWard",
    "myHp",
    "oppHp",
    "ep",
    "sep",
    "turn",
    "myAtkSum",
    "oppAtkSum",
    "oppDefSum",
    "deck",
    "graveyard",
    "first",
];

/// 入力を作るときの語彙（カードの ID の並び。学習のデータの見出しとモデルに書く）
pub fn default_vocab() -> Vec<String> {
    data().cards.iter().map(|c| c.id.clone()).collect()
}

/// 入力の作り方（語彙からカードの添字への対応）
pub struct PotentialEncoder {
    vocab_card: Vec<Option<usize>>,
    vocab_len: usize,
}

impl PotentialEncoder {
    pub fn new(vocab: &[String]) -> PotentialEncoder {
        let d = data();
        let mut vocab_card = vec![None; d.cards.len()];
        for (k, id) in vocab.iter().enumerate() {
            if let Some(&c) = d.card_by_id.get(id) {
                vocab_card[c as usize] = Some(k);
            }
        }
        PotentialEncoder {
            vocab_card,
            vocab_len: vocab.len(),
        }
    }

    /// 入力の数
    pub fn n_inputs(&self) -> usize {
        P_ZONES.len() * self.vocab_len + P_SCALARS.len()
    }

    /// 局面 s の p の入力（添字と値。同じ添字は足し合わせる）。p のメインフェイズでなければ空
    pub fn encode(&self, s: &GameState, p: PlayerIndex, out: &mut Vec<(usize, f64)>) {
        out.clear();
        if s.phase != Phase::Main || s.active != p {
            return;
        }
        let v = self.vocab_len;
        let add = |out: &mut Vec<(usize, f64)>, zone: usize, c: CardIdx, x: f64| {
            if x == 0.0 {
                return;
            }
            if let Some(k) = self.vocab_card[c as usize] {
                let i = zone * v + k;
                match out.iter_mut().find(|(j, _)| *j == i) {
                    Some(e) => e.1 += x,
                    None => out.push((i, x)),
                }
            }
        };
        let me = &s.players[p];
        let opp = &s.players[opponent(p)];
        for h in me.hand.iter() {
            add(out, 0, h.card, 1.0);
            if hand_cost(h) <= me.pp {
                add(out, 1, h.card, 1.0);
            }
            add(out, 2, h.card, h.boosts.min(10) as f64 / 5.0);
        }
        let opp_followers = opp.board.iter().any(|b| b.is_follower);
        let (mut my_atk, mut opp_atk, mut opp_def, mut opp_n, mut opp_ward) =
            (0.0, 0.0, 0.0, 0.0, 0.0);
        for b in me.board.iter() {
            add(out, 3, b.card, 1.0);
            if !b.is_follower {
                continue;
            }
            my_atk += b.attack_value().max(0) as f64;
            if can_attack_leader(s, b) || (opp_followers && can_attack_followers(s, b)) {
                add(
                    out,
                    4,
                    b.card,
                    (b.attack + b.temp_attack).max(0) as f64 / 5.0,
                );
            }
            if b.evolve == Evolve::None {
                add(out, 5, b.card, 1.0);
            } else {
                add(out, 6, b.card, 1.0);
            }
        }
        for b in opp.board.iter() {
            add(out, 7, b.card, 1.0);
            if b.is_follower {
                opp_n += 1.0;
                opp_atk += b.attack_value().max(0) as f64;
                opp_def += b.defense.max(0) as f64;
                if b.has_keyword(WARD) {
                    opp_ward += 1.0;
                }
            }
        }
        let f = beam_features(s, p);
        let b = |x: bool| if x { 1.0 } else { 0.0 };
        let scalars: [f64; P_SCALARS.len()] = [
            f[0] / 10.0,
            f[1] / 10.0,
            f[2] / 10.0,
            f[3] / 5.0,
            f[4],
            f[5],
            f[6],
            me.max_pp as f64 / 10.0,
            me.combo as f64 / 5.0,
            me.hand.len() as f64 / 9.0,
            me.board.len() as f64 / 5.0,
            opp_n / 5.0,
            opp_ward / 2.0,
            me.leader_hp as f64 / 20.0,
            opp.leader_hp as f64 / 20.0,
            me.ep as f64 / 3.0,
            me.sep as f64 / 2.0,
            me.turn_count as f64 / 10.0,
            my_atk / 20.0,
            opp_atk / 20.0,
            opp_def / 20.0,
            me.deck.len() as f64 / 40.0,
            me.graveyard.min(30) as f64 / 20.0,
            b(s.first == p),
        ];
        let base = P_ZONES.len() * v;
        for (j, &x) in scalars.iter().enumerate() {
            if x != 0.0 {
                out.push((base + j, x));
            }
        }
    }
}

/// モデルのファイルの形（scripts/train-potential.py が書く）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPotentialNet {
    kind: String,
    version: u32,
    vocab: Vec<String>,
    zones: Vec<String>,
    scalars: Vec<String>,
    hidden: usize,
    /// 入力ごとに hidden 個（入力の添字 × hidden + 隠れ層の添字）
    w1: Vec<f64>,
    b1: Vec<f64>,
    w2: Vec<f64>,
    b2: f64,
}

/// 見込みのネットワーク（入力 → 隠れ層 1 つ（ReLU）→ 出力。出力はターン末の点数の単位）
pub struct PotentialNet {
    enc: PotentialEncoder,
    hidden: usize,
    w1: Vec<f64>,
    b1: Vec<f64>,
    w2: Vec<f64>,
    b2: f64,
}

/// 推論に使う場所（入力と隠れ層）
type Buf = (Vec<(usize, f64)>, Vec<f64>);

thread_local! {
    static BUF: RefCell<Buf> = const { RefCell::new((Vec::new(), Vec::new())) };
}

impl PotentialNet {
    pub fn load(path: &str) -> Result<PotentialNet, String> {
        let text =
            std::fs::read_to_string(path).map_err(|e| format!("{path} を読めません: {e}"))?;
        let raw: RawPotentialNet = serde_json::from_str(&text)
            .map_err(|e| format!("{path} は見込みのネットワークではありません: {e}"))?;
        if raw.kind != "potential-net" || raw.version != 1 {
            return Err(format!("{path}: kind・version が違います"));
        }
        if raw.zones != P_ZONES || raw.scalars != P_SCALARS {
            return Err(format!("{path}: 入力の並びが今のコードと違います"));
        }
        let enc = PotentialEncoder::new(&raw.vocab);
        let n = enc.n_inputs();
        if raw.w1.len() != n * raw.hidden
            || raw.b1.len() != raw.hidden
            || raw.w2.len() != raw.hidden
        {
            return Err(format!("{path}: 重みの大きさが合いません"));
        }
        Ok(PotentialNet {
            enc,
            hidden: raw.hidden,
            w1: raw.w1,
            b1: raw.b1,
            w2: raw.w2,
            b2: raw.b2,
        })
    }

    /// 局面 s の p の見込み（ターン末の点数の単位）。p のメインフェイズでなければ 0
    pub fn eval(&self, s: &GameState, p: PlayerIndex) -> f64 {
        if s.phase != Phase::Main || s.active != p {
            return 0.0;
        }
        let hn = self.hidden;
        BUF.with(|buf| {
            let (x, h) = &mut *buf.borrow_mut();
            self.enc.encode(s, p, x);
            h.clear();
            h.extend_from_slice(&self.b1);
            for &(i, v) in x.iter() {
                for (hj, &w) in h.iter_mut().zip(&self.w1[i * hn..i * hn + hn]) {
                    *hj += v * w;
                }
            }
            let mut z = self.b2;
            for (&hj, &w) in h.iter().zip(&self.w2) {
                if hj > 0.0 {
                    z += hj * w;
                }
            }
            z
        })
    }
}
