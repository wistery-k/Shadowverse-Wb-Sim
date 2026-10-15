//! 探索 AI のデータ（`npm run rust-data` が書き出す rust/engine/data/ai-data.json）。
//! 評価関数の重み・学習した評価の補正・マリガンの係数等を TypeScript 版から受け取る（書き写さない）。

use crate::data::{data, CardIdx, CrestIdx};
use serde::{Deserialize, Deserializer};
use std::collections::HashMap;
use std::sync::OnceLock;

/// 評価関数の重み（src/ai/evaluate.ts の EvalWeights）
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Weights {
    pub my_hp: f64,
    pub opp_hp: f64,
    pub attack: f64,
    pub defense: f64,
    pub follower_base: f64,
    pub temp_attack: f64,
    pub keywords: f64,
    pub amulet: f64,
    pub sigil: f64,
    pub sigil_amulet: f64,
    pub countdown_decay: f64,
    pub jeanne_sync: f64,
    pub opp_board: f64,
    pub my_hand: f64,
    pub opp_hand: f64,
    pub ep: f64,
    pub sep: f64,
    pub extra_pp: f64,
    pub max_pp: f64,
    pub crest: f64,
    pub graveyard: f64,
    pub lethal_range: f64,
    pub lethal_attack: f64,
    pub fusion_set: f64,
    pub kuon_reserve: f64,
    pub evo_reserve: f64,
    pub sevo_reserve: f64,
    pub kerberos_reserve: f64,
    pub last_words: f64,
    pub last_words_summon: f64,
    pub hand_storm: f64,
    pub boost_card: f64,
    pub boost: f64,
    pub boost_cap: f64,
    /// カードごとの手札に持っておく価値（カードの添字ごと。無ければ 0）
    #[serde(deserialize_with = "de_hold")]
    pub hold: Vec<f64>,
    pub doomed: f64,
    pub pp_left: f64,
    pub extra_pp_expiring: f64,
}

fn de_hold<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<f64>, D::Error> {
    let m: HashMap<String, f64> = HashMap::deserialize(d)?;
    let mut v = vec![0.0; data().cards.len()];
    for (id, x) in m {
        v[data().card_idx(&id) as usize] = x;
    }
    Ok(v)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCards {
    kuon: String,
    kerberos: String,
    jeanne: String,
    fusion_set: Vec<String>,
    boost_grown: Vec<String>,
}

#[derive(Deserialize)]
pub struct RawValueNet {
    pub kind: String,
    pub version: i32,
    pub vocab: Vec<String>,
    pub zones: Vec<String>,
    pub scalars: Vec<String>,
    pub hidden: usize,
    pub w1: Vec<f64>,
    pub b1: Vec<f64>,
    pub w2: Vec<f64>,
    pub b2: f64,
    pub a: f64,
    pub c: f64,
    #[serde(rename = "baseWeights")]
    pub base_weights: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct RawMulliganDeck {
    features: HashMap<String, f64>,
    cards: HashMap<String, f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAiData {
    default_weights: Weights,
    search_weights: Weights,
    decay_pow: HashMap<String, Vec<f64>>,
    cards: RawCards,
    value_net: RawValueNet,
    mulligan_weights: HashMap<String, HashMap<String, [f64; 2]>>,
    mulligan_model: HashMap<String, RawMulliganDeck>,
    mulligan_roles: HashMap<String, HashMap<String, Vec<String>>>,
    roles: Vec<String>,
    model_features: Vec<String>,
}

/// デッキごとのマリガンのモデル（src/ai/mulliganModel.ts）
pub struct MulliganDeckModel {
    /// MODEL_FEATURES の順の係数（無いものは None）
    pub features: Vec<Option<f64>>,
    pub cards: HashMap<CardIdx, f64>,
}

pub struct AiData {
    pub default_weights: Weights,
    pub search_weights: Weights,
    /// countdownDecay → countdownDecay ** n（n = 0..63）
    pub decay_pow: Vec<(f64, Vec<f64>)>,
    pub kuon: CardIdx,
    pub kerberos: CardIdx,
    pub jeanne: CardIdx,
    pub fusion_set: Vec<CardIdx>,
    pub boost_grown: Vec<CardIdx>,
    pub value_net: RawValueNet,
    /// 学習した評価の補正の vocab の添字（カード・クレストの添字ごと）
    pub vocab_card: Vec<Option<usize>>,
    pub vocab_crest: Vec<Option<usize>>,
    /// デッキ名 → カード → [1 枚目を残す重み, 2 枚目も残す重み]
    pub mulligan_weights: HashMap<String, HashMap<CardIdx, [f64; 2]>>,
    pub mulligan_model: HashMap<String, MulliganDeckModel>,
    /// デッキ名 → カード → 役割（ROLES の添字。同じ役割を 2 つ書いたものは 2 つ）
    pub mulligan_roles: HashMap<String, HashMap<CardIdx, Vec<usize>>>,
    pub roles: Vec<String>,
    pub model_features: Vec<String>,
}

impl AiData {
    pub fn decay_pow(&self, decay: f64, n: i32) -> f64 {
        if n >= 0 {
            if let Some((_, t)) = self.decay_pow.iter().find(|(d, _)| *d == decay) {
                if let Some(x) = t.get(n as usize) {
                    return *x;
                }
            }
        }
        decay.powf(n as f64)
    }
}

fn load(json: &str) -> AiData {
    let raw: RawAiData = serde_json::from_str(json).expect("ai-data.json を読めません");
    let d = data();
    let ids = |v: &[String]| v.iter().map(|id| d.card_idx(id)).collect::<Vec<_>>();
    let vn = raw.value_net;
    let mut vocab_card = vec![None; d.cards.len()];
    let mut vocab_crest = vec![None; d.crests.len()];
    for (k, id) in vn.vocab.iter().enumerate() {
        if let Some(c) = id.strip_prefix("crest:") {
            if let Some(n) = d.crests.iter().position(|x| x.id == c) {
                vocab_crest[n as CrestIdx as usize] = Some(k);
            }
        } else if let Some(&c) = d.card_by_id.get(id) {
            vocab_card[c as usize] = Some(k);
        }
    }
    let role_index = |r: &str| {
        raw.roles
            .iter()
            .position(|x| x == r)
            .unwrap_or_else(|| panic!("未知の役割: {r}"))
    };
    AiData {
        decay_pow: raw
            .decay_pow
            .into_iter()
            .map(|(k, v)| (k.parse::<f64>().expect("decayPow"), v))
            .collect(),
        kuon: d.card_idx(&raw.cards.kuon),
        kerberos: d.card_idx(&raw.cards.kerberos),
        jeanne: d.card_idx(&raw.cards.jeanne),
        fusion_set: ids(&raw.cards.fusion_set),
        boost_grown: ids(&raw.cards.boost_grown),
        value_net: vn,
        vocab_card,
        vocab_crest,
        mulligan_weights: raw
            .mulligan_weights
            .into_iter()
            .map(|(deck, t)| {
                (
                    deck,
                    t.into_iter().map(|(id, w)| (d.card_idx(&id), w)).collect(),
                )
            })
            .collect(),
        mulligan_model: raw
            .mulligan_model
            .into_iter()
            .map(|(deck, m)| {
                let features = raw
                    .model_features
                    .iter()
                    .map(|f| m.features.get(f).copied())
                    .collect();
                let cards = m
                    .cards
                    .into_iter()
                    .map(|(id, x)| (d.card_idx(&id), x))
                    .collect();
                (deck, MulliganDeckModel { features, cards })
            })
            .collect(),
        mulligan_roles: raw
            .mulligan_roles
            .iter()
            .map(|(deck, t)| {
                (
                    deck.clone(),
                    t.iter()
                        .map(|(id, rs)| {
                            (d.card_idx(id), rs.iter().map(|r| role_index(r)).collect())
                        })
                        .collect(),
                )
            })
            .collect(),
        default_weights: raw.default_weights,
        search_weights: raw.search_weights,
        roles: raw.roles.clone(),
        model_features: raw.model_features,
    }
}

static AI_DATA: OnceLock<AiData> = OnceLock::new();

/// 埋め込んだ AI のデータ（最初の呼び出しで読み込む）
pub fn ai_data() -> &'static AiData {
    AI_DATA.get_or_init(|| load(include_str!("../../data/ai-data.json")))
}
