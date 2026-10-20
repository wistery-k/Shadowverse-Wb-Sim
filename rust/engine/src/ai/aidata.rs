//! 探索 AI のデータ（`npm run rust-data` が書き出す rust/engine/data/ai-data.json）。
//! 評価関数の重み・学習した評価の補正・マリガンの係数等を TypeScript 版から受け取る（書き写さない）。

use crate::data::{data, CardIdx};
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
    pub passive: f64,
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

#[derive(Deserialize, Clone)]
pub struct RawValueNet {
    pub kind: String,
    pub version: i32,
    pub vocab: Vec<String>,
    pub zones: Vec<String>,
    pub scalars: Vec<String>,
    pub hidden: usize,
    pub w1: Vec<f64>,
    pub b1: Vec<f64>,
    /// 最初の隠れ層の後に足す隠れ層（valueNet.ts の layers。無ければ隠れ層 1 つ）
    #[serde(default)]
    pub layers: Vec<RawValueNetLayer>,
    pub w2: Vec<f64>,
    pub b2: f64,
    pub a: f64,
    pub c: f64,
    #[serde(rename = "baseWeights")]
    pub base_weights: serde_json::Map<String, serde_json::Value>,
    /// 場のカードのネットワーク（valueNet.ts の board。無ければ使わない）
    #[serde(default)]
    pub board: Option<RawValueNetBoard>,
}

/// 場のカードのネットワーク（valueNet.ts の ValueNetBoard）
#[derive(Deserialize, Clone)]
pub struct RawValueNetBoard {
    /// 数値の入力（valuenet.rs の BOARD_FEATURES の部分列）
    pub features: Vec<String>,
    /// 付与された能力（DSL の Ability の JSON の文字列）
    pub grants: Vec<String>,
    /// 層（最初の層の入力は vocab のカード・grants・features の順）
    pub layers: Vec<RawValueNetLayer>,
}

/// 足した隠れ層（w は前の層 × この層。前の層の値ごとに b.len() 個ずつ並べる）
#[derive(Deserialize, Clone)]
pub struct RawValueNetLayer {
    pub w: Vec<f64>,
    pub b: Vec<f64>,
}

#[derive(Deserialize)]
struct RawMulliganDeck {
    features: HashMap<String, f64>,
    cards: HashMap<String, f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAiData {
    default_weights: serde_json::Map<String, serde_json::Value>,
    search_weights: serde_json::Map<String, serde_json::Value>,
    decay_pow: HashMap<String, Vec<f64>>,
    cards: RawCards,
    value_net: RawValueNet,
    mulligan_weights: HashMap<String, HashMap<String, [f64; 2]>>,
    mulligan_model: HashMap<String, RawMulliganDeck>,
    mulligan_roles: HashMap<String, HashMap<String, Vec<String>>>,
    roles: Vec<String>,
    model_features: Vec<String>,
    /// クラス → DEFAULT_WEIGHTS から変える重み（data/ai-weights.json）
    class_weights: HashMap<String, serde_json::Map<String, serde_json::Value>>,
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
    /// SEARCH_WEIGHTS の JSON（一部の項目だけを変えた重みを作るため。TypeScript の `{ ...SEARCH_WEIGHTS, ...x }`）
    pub search_weights_raw: serde_json::Map<String, serde_json::Value>,
    /// countdownDecay → countdownDecay ** n（n = 0..63）
    pub decay_pow: Vec<(f64, Vec<f64>)>,
    pub kuon: CardIdx,
    pub kerberos: CardIdx,
    pub jeanne: CardIdx,
    pub fusion_set: Vec<CardIdx>,
    pub boost_grown: Vec<CardIdx>,
    /// 学習した評価の補正（data/value-net.json）
    pub value_net: RawValueNet,
    /// デッキ名 → カード → [1 枚目を残す重み, 2 枚目も残す重み]
    pub mulligan_weights: HashMap<String, HashMap<CardIdx, [f64; 2]>>,
    pub mulligan_model: HashMap<String, MulliganDeckModel>,
    /// デッキ名 → カード → 役割（ROLES の添字。同じ役割を 2 つ書いたものは 2 つ）
    pub mulligan_roles: HashMap<String, HashMap<CardIdx, Vec<usize>>>,
    pub roles: Vec<String>,
    pub model_features: Vec<String>,
    /// クラスごとに調整した重み（data/ai-weights.json を DEFAULT_WEIGHTS に重ねたもの。src/ai/weights.ts の weightsForClass）
    pub class_weights: HashMap<String, Weights>,
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
        value_net: raw.value_net,
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
        class_weights: raw
            .class_weights
            .iter()
            .map(|(cls, o)| {
                let w = class_weights_json(&raw.default_weights, o);
                (cls.clone(), weights_from(w).expect("classWeights"))
            })
            .collect(),
        default_weights: weights_from(raw.default_weights).expect("defaultWeights"),
        search_weights: weights_from(raw.search_weights.clone()).expect("searchWeights"),
        search_weights_raw: raw.search_weights,
        roles: raw.roles.clone(),
        model_features: raw.model_features,
    }
}

/// `{ ...DEFAULT_WEIGHTS, ...o, hold: { ...DEFAULT_WEIGHTS.hold, ...o.hold } }`
pub(crate) fn class_weights_json(
    base: &serde_json::Map<String, serde_json::Value>,
    o: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut m = base.clone();
    for (k, v) in o {
        m.insert(k.clone(), v.clone());
    }
    let mut hold = match base.get("hold") {
        Some(serde_json::Value::Object(h)) => h.clone(),
        _ => serde_json::Map::new(),
    };
    if let Some(serde_json::Value::Object(h)) = o.get("hold") {
        for (k, v) in h {
            hold.insert(k.clone(), v.clone());
        }
    }
    m.insert("hold".into(), serde_json::Value::Object(hold));
    m
}

/// 重みの JSON から重みを作る（足りない項目・知らない項目があれば Err）
pub fn weights_from(map: serde_json::Map<String, serde_json::Value>) -> Result<Weights, String> {
    serde_json::from_value(serde_json::Value::Object(map))
        .map_err(|e| format!("重みが読めません: {e}"))
}

/// base（重みの JSON）の項目を overrides で上書きした重み（TypeScript の `{ ...base, ...overrides }`）
pub fn weights_with(
    base: &serde_json::Map<String, serde_json::Value>,
    overrides: &serde_json::Map<String, serde_json::Value>,
) -> Result<Weights, String> {
    let mut m = base.clone();
    for (k, v) in overrides {
        m.insert(k.clone(), v.clone());
    }
    weights_from(m)
}

/// 埋め込んだ AI のデータの JSON（設定の重みを項目の順番どおりに表示するときにも読む）
pub const AI_DATA_JSON: &str = include_str!("../../data/ai-data.json");

static AI_DATA: OnceLock<AiData> = OnceLock::new();

/// 埋め込んだ AI のデータ（最初の呼び出しで読み込む）
pub fn ai_data() -> &'static AiData {
    AI_DATA.get_or_init(|| load(AI_DATA_JSON))
}
