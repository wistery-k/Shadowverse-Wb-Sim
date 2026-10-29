//! 設定の JSON（compare の A・B、rhino-compare の --opts）を探索 AI の設定にする。
//!
//! TypeScript 版と同じく、`"valueNet"` に学習した評価の補正のファイルを渡すと、重みをそのモデルの出発点にして補正を足す
//! （scripts/valueNetOption.ts）。TypeScript 版とともに消した実験用の項目（exhaustive 等）は、既定の値のときだけ受け付ける。

use crate::ai::aidata::{weights_from, AI_DATA_JSON};
use crate::ai::mulligan::OppMulligan;
use crate::ai::rhino::{rhino_pass_lethal, rhino_search_options, RHINO_POTENTIAL};
use crate::ai::search::{
    DrawSplit, ExtraEval, MulliganMode, OpponentSearch, OwnNextSearch, RolloutWeights,
    ScoreTurnEnd, SearchOptions, TwoTurnGate,
};
use crate::ai::valuenet::ValueNet;
use crate::data::ClassId;
use crate::json::Json;
use std::sync::{Arc, OnceLock};

fn ai_json(key: &str) -> &'static Json {
    static AI: OnceLock<Json> = OnceLock::new();
    AI.get_or_init(|| Json::parse(AI_DATA_JSON).expect("ai-data.json"))
        .get(key)
        .unwrap_or_else(|| panic!("ai-data.json に {key} がありません"))
}

/// 探索 AI の既定の重み SEARCH_WEIGHTS（項目の順番つき）
pub fn search_weights_json() -> &'static Json {
    ai_json("searchWeights")
}

/// 基準の重み DEFAULT_WEIGHTS（項目の順番つき）
pub fn default_weights_json() -> &'static Json {
    ai_json("defaultWeights")
}

/// 学習した評価の補正のモデルを探索の extraEval にする（valueNetExtraEval）
pub fn model_eval(net: Arc<ValueNet>) -> ExtraEval {
    Arc::new(move |s, p, phase| net.eval(s, p, phase))
}

/// 補正のモデルのファイルを読む（モデルと、そのファイルの JSON）
pub fn load_model(path: &str) -> Result<(Arc<ValueNet>, Json), String> {
    let net = ValueNet::load(path)?;
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path} を読めません: {e}"))?;
    Ok((Arc::new(net), Json::parse(&text)?))
}

/// 設定の JSON に `"valueNet"` があれば、学習した補正を入れた設定に直す（applyValueNetOption）。
/// 補正は設定の JSON では `"extraEval"` の関数（表示されない値）になり、その中身を 2 つ目に返す
pub fn apply_value_net(mut raw: Json) -> Result<(Json, Option<ExtraEval>), String> {
    if !raw.is_obj() {
        return Err("設定はオブジェクトの JSON で渡します".into());
    }
    match raw.take("valueNet") {
        None => Ok((raw, None)),
        Some(Json::Bool(false)) => {
            raw.set("extraEval", Json::Null);
            Ok((raw, None))
        }
        Some(Json::Str(path)) => {
            let (net, file) = load_model(&path)?;
            let base = file
                .get("baseWeights")
                .cloned()
                .unwrap_or(Json::Obj(Vec::new()));
            let extra = match raw.get("weights") {
                Some(w @ Json::Obj(_)) => w.clone(),
                // "default"・"search"・"zero" は全部の項目を持つので、モデルの出発点の重みより優先する
                Some(w @ Json::Str(_)) => resolve_weights("weights", Some(w))?.expect("重み"),
                _ => Json::Obj(Vec::new()),
            };
            // 出発点の重みを変えたモデル（baseWeights がある）は、自分の評価だけをその重みにし、読みの中の相手は
            // 探索 AI の既定の重みのまま打つ（"policyWeights" を書けばそちら。docs/ai-notes.md「評価関数の手作りの項を外す」）
            if !matches!(&base, Json::Obj(items) if items.is_empty())
                && raw.get("policyWeights").is_none()
            {
                raw.set("policyWeights", search_weights_json().clone());
            }
            raw.set(
                "weights",
                search_weights_json().spread(&base).spread(&extra),
            );
            raw.set("extraEval", Json::Func);
            Ok((raw, Some(model_eval(net))))
        }
        Some(_) => Err("\"valueNet\" にはモデルのファイル名か false を渡します".into()),
    }
}

fn count(k: &str, v: &Json) -> Result<usize, String> {
    match v {
        Json::Num(x) if *x >= 0.0 && x.fract() == 0.0 => Ok(*x as usize),
        _ => Err(format!("\"{k}\" は 0 以上の整数: {}", v.stringify())),
    }
}

fn number(k: &str, v: &Json) -> Result<f64, String> {
    match v {
        Json::Num(x) => Ok(*x),
        _ => Err(format!("\"{k}\" は数: {}", v.stringify())),
    }
}

fn flag(k: &str, v: &Json) -> Result<bool, String> {
    match v {
        Json::Bool(b) => Ok(*b),
        _ => Err(format!("\"{k}\" は true か false: {}", v.stringify())),
    }
}

/// カード名の配列（mulliganKeep・mulliganReturn）
fn card_names(k: &str, v: &Json) -> Result<Vec<crate::data::CardIdx>, String> {
    let Json::Arr(xs) = v else {
        return Err(format!("\"{k}\" はカード名の配列: {}", v.stringify()));
    };
    xs.iter()
        .map(|x| match x {
            Json::Str(name) => crate::data::data()
                .cards
                .iter()
                .position(|c| c.name == *name)
                .map(|i| i as crate::data::CardIdx)
                .ok_or_else(|| format!("\"{k}\" のカードがありません: {name}")),
            _ => Err(format!("\"{k}\" はカード名の配列: {}", v.stringify())),
        })
        .collect()
}

/// raw の項目で base を上書きした探索 AI の設定（`{ ...base, ...raw }`）。skip の項目は呼び出し側で扱う。
/// model は raw の `"extraEval"` が関数（学習した補正）のときの中身
pub fn search_options(
    raw: &Json,
    model: Option<&ExtraEval>,
    base: SearchOptions,
    skip: &[&str],
) -> Result<SearchOptions, String> {
    let Json::Obj(items) = raw else {
        return Err("設定はオブジェクトの JSON で渡します".into());
    };
    let mut o = base;
    // 補正を既定から替えた・外した（"extraEval"。"valueNet" から作る）ときは、評価の重みを既定の補正の出発点の重みから
    // 探索 AI の既定の重みに戻す。替えた補正の出発点の重みは、apply_value_net が "weights"・"policyWeights" に書いて下で入る
    if raw.get("extraEval").is_some() {
        o.weights = None;
        o.policy_weights = None;
    }
    for (k, v) in items {
        let k = k.as_str();
        if skip.contains(&k) {
            continue;
        }
        match k {
            "samples" => o.samples = count(k, v)?,
            "beamWidth" => o.beam_width = count(k, v)?,
            "maxDepth" => o.max_depth = count(k, v)?,
            "rescoreTop" => o.rescore_top = count(k, v)?,
            "planCandidates" => o.plan_candidates = count(k, v)?,
            "perFirst" => o.per_first = count(k, v)?,
            "oppHandSamples" => o.opp_hand_samples = count(k, v)?,
            "dangerRescore" => o.danger_rescore = count(k, v)?,
            "rescoreMix" => {
                let x = number(k, v)?;
                if !(0.0..=1.0).contains(&x) {
                    return Err(format!("\"rescoreMix\" は 0 以上 1 以下: {x}"));
                }
                o.rescore_mix = x;
            }
            "mulliganSamples" => o.mulligan_samples = count(k, v)?,
            "mulliganTurns" => o.mulligan_turns = count(k, v)? as i32,
            "mulliganKeep" => o.mulligan_keep = card_names(k, v)?,
            "mulliganReturn" => o.mulligan_return = card_names(k, v)?,
            "mulliganRolloutWeights" => {
                o.mulligan_rollout_weights = match v {
                    Json::Str(s) if s == "greedy" => RolloutWeights::Greedy,
                    Json::Str(s) if s == "ramp" => RolloutWeights::Ramp,
                    Json::Str(s) if s == "search" => RolloutWeights::Search,
                    _ => {
                        return Err(format!(
                            "\"mulliganRolloutWeights\" は greedy / ramp / search: {}",
                            v.stringify()
                        ))
                    }
                }
            }
            "mulliganRolloutBeam" => o.mulligan_rollout_beam = count(k, v)?,
            "mulliganOpp" => {
                o.mulligan_opp = Some(match v {
                    Json::Str(s) if s == "model" => OppMulligan::Model,
                    Json::Str(s) if s == "cost" => OppMulligan::Cost,
                    Json::Str(s) if s == "keep" => OppMulligan::Keep,
                    _ => {
                        return Err(format!(
                            "\"mulliganOpp\" は model / cost / keep: {}",
                            v.stringify()
                        ))
                    }
                })
            }
            "lethal" => o.lethal = flag(k, v)?,
            "mulliganStatic" => o.mulligan_static = flag(k, v)?,
            "mulliganNet" => o.mulligan_net = flag(k, v)?,
            "dedup" => o.dedup = flag(k, v)?,
            "sameHandOnce" => o.same_hand_once = flag(k, v)?,
            "chain" => o.chain = flag(k, v)?,
            "chainFuse" => o.chain_fuse = flag(k, v)?,
            "deferFuse" => o.defer_fuse = flag(k, v)?,
            "deferFuseKeepSet" => o.defer_fuse_keep_set = flag(k, v)?,
            "deferFuseHand" => o.defer_fuse_hand = count(k, v)?,
            "deferFuseLastWords" => o.defer_fuse_last_words = flag(k, v)?,
            "fuseMinimal" => o.fuse_minimal = flag(k, v)?,
            "fuseRoot" => o.fuse_root = flag(k, v)?,
            "settleTrades" => o.settle_trades = flag(k, v)?,
            "dominance" => o.dominance = flag(k, v)?,
            "reusePlan" => o.reuse_plan = flag(k, v)?,
            "peekOppHand" => o.peek_opp_hand = flag(k, v)?,
            "oppFuse" => o.opp_fuse = flag(k, v)?,
            "oppHandCommon" => o.opp_hand_common = flag(k, v)?,
            "reuseAgree" => o.reuse_agree = flag(k, v)?,
            "resampleDraws" => o.resample_draws = flag(k, v)?,
            "drawFirst" => o.draw_first = flag(k, v)?,
            "nextLethal" => o.next_lethal = number(k, v)?,
            "lethalWardBlocked" => o.lethal_ward_blocked = number(k, v)?,
            "lethalExpandChoices" => o.lethal_expand_choices = flag(k, v)?,
            "lethalExactStates" => o.lethal_exact_states = number(k, v)? as i64,
            "nextLethalRange" => o.next_lethal_range = Some(number(k, v)?),
            "passLethal" => o.pass_lethal = count(k, v)?,
            "beamPp" => o.beam_pp = number(k, v)?,
            "attackLater" => o.attack_later = count(k, v)?,
            "perPlan" => o.per_plan = count(k, v)?,
            "scoreTurnEnd" => {
                o.score_turn_end = match v {
                    Json::Str(s) if s == "none" => ScoreTurnEnd::None,
                    Json::Str(s) if s == "terminal" => ScoreTurnEnd::Terminal,
                    Json::Str(s) if s == "all" => ScoreTurnEnd::All,
                    _ => {
                        return Err(format!(
                            "\"scoreTurnEnd\" は none / terminal / all: {}",
                            v.stringify()
                        ))
                    }
                }
            }
            "mulligan" => {
                o.mulligan = match v {
                    Json::Str(s) if s == "model" => MulliganMode::Model,
                    Json::Str(s) if s == "weights" => MulliganMode::Weights,
                    Json::Str(s) if s == "cost" => MulliganMode::Cost,
                    Json::Str(s) if s == "sample" => MulliganMode::Sample,
                    Json::Str(s) if s == "turn1" => MulliganMode::Turn1,
                    Json::Str(s) if s == "keep" => MulliganMode::Keep,
                    _ => {
                        return Err(format!(
                            "\"mulligan\" は model / weights / cost / sample / turn1 / keep: {}",
                            v.stringify()
                        ))
                    }
                }
            }
            "opponentSearch" => {
                o.opponent_search = match v {
                    Json::Null => None,
                    Json::Obj(_) => {
                        for key in [v.get("beamWidth"), v.get("maxDepth")] {
                            if key.is_none() {
                                return Err(
                                    "\"opponentSearch\" には beamWidth と maxDepth を書きます"
                                        .into(),
                                );
                            }
                        }
                        Some(OpponentSearch {
                            beam_width: count(
                                "opponentSearch.beamWidth",
                                v.get("beamWidth").expect("beamWidth"),
                            )?,
                            max_depth: count(
                                "opponentSearch.maxDepth",
                                v.get("maxDepth").expect("maxDepth"),
                            )?,
                            extra_eval: match v.get("extraEval") {
                                None => false,
                                Some(x) => flag("opponentSearch.extraEval", x)?,
                            },
                        })
                    }
                    _ => {
                        return Err(format!(
                            "\"opponentSearch\" は null かオブジェクト: {}",
                            v.stringify()
                        ))
                    }
                }
            }
            "ownNext" => {
                o.own_next = match v {
                    Json::Null => None,
                    Json::Obj(_) => Some(OwnNextSearch {
                        beam_width: count(
                            "ownNext.beamWidth",
                            v.get("beamWidth")
                                .ok_or("\"ownNext\" には beamWidth を書きます")?,
                        )?,
                        max_depth: match v.get("maxDepth") {
                            None => 8,
                            Some(x) => count("ownNext.maxDepth", x)?,
                        },
                        mix: match v.get("mix") {
                            None => 1.0,
                            Some(Json::Num(x)) if (0.0..=1.0).contains(x) => *x,
                            Some(x) => {
                                return Err(format!(
                                    "\"ownNext.mix\" は 0〜1 の数: {}",
                                    x.stringify()
                                ))
                            }
                        },
                        reply: match v.get("reply") {
                            None => false,
                            Some(x) => flag("ownNext.reply", x)?,
                        },
                    }),
                    _ => {
                        return Err(format!(
                            "\"ownNext\" は null かオブジェクト: {}",
                            v.stringify()
                        ))
                    }
                }
            }
            "drawSplit" => {
                o.draw_split = match v {
                    Json::Null => None,
                    Json::Obj(fields) => {
                        const KEYS: [&str; 7] = [
                            "samples",
                            "beamWidth",
                            "maxDepth",
                            "rootDraws",
                            "stratify",
                            "enumerate",
                            "class",
                        ];
                        if let Some((k, _)) =
                            fields.iter().find(|(k, _)| !KEYS.contains(&k.as_str()))
                        {
                            return Err(format!("drawSplit の知らない項目: {k}"));
                        }
                        let opt = |name: &str, def: usize| -> Result<usize, String> {
                            match v.get(name) {
                                None => Ok(def),
                                Some(x) => count(&format!("drawSplit.{name}"), x),
                            }
                        };
                        Some(DrawSplit {
                            samples: opt("samples", 4)?,
                            beam_width: opt("beamWidth", 128)?,
                            max_depth: opt("maxDepth", 16)?,
                            root_draws: opt("rootDraws", 2)?,
                            stratify: match v.get("stratify") {
                                None => false,
                                Some(x) => flag("drawSplit.stratify", x)?,
                            },
                            enumerate: match v.get("enumerate") {
                                None => false,
                                Some(x) => flag("drawSplit.enumerate", x)?,
                            },
                            class: match v.get("class") {
                                None | Some(Json::Null) => None,
                                Some(Json::Str(name)) => Some(
                                    ClassId::ALL
                                        .into_iter()
                                        .find(|c| c.name() == name)
                                        .ok_or_else(|| {
                                            format!("drawSplit.class が違います: {name}")
                                        })?,
                                ),
                                Some(x) => {
                                    return Err(format!(
                                        "drawSplit.class はクラスの名前（\"witch\" 等）: {}",
                                        x.stringify()
                                    ))
                                }
                            },
                        })
                    }
                    _ => {
                        return Err(format!(
                            "\"drawSplit\" は null かオブジェクト: {}",
                            v.stringify()
                        ))
                    }
                }
            }
            "twoTurnGate" => {
                o.two_turn_gate = match v {
                    Json::Null => None,
                    Json::Obj(_) => Some(TwoTurnGate {
                        beam_width: match v.get("beamWidth") {
                            None => 16,
                            Some(x) => count("twoTurnGate.beamWidth", x)?,
                        },
                        max_depth: match v.get("maxDepth") {
                            None => 8,
                            Some(x) => count("twoTurnGate.maxDepth", x)?,
                        },
                        threshold: number(
                            "twoTurnGate.threshold",
                            v.get("threshold").ok_or(
                                "\"twoTurnGate\" には threshold（勝率の差、ポイント）を書きます",
                            )?,
                        )?,
                    }),
                    _ => {
                        return Err(format!(
                            "\"twoTurnGate\" は null かオブジェクト: {}",
                            v.stringify()
                        ))
                    }
                }
            }
            "extraEval" => {
                o.extra_eval =
                    match v {
                        Json::Null => None,
                        Json::Func => Some(model.expect("学習した補正").clone()),
                        _ => return Err(
                            "\"extraEval\" は null だけを渡せます（補正は \"valueNet\" で渡す）"
                                .into(),
                        ),
                    }
            }
            "weights" | "policyWeights" => {
                let w = match v {
                    Json::Obj(_) => Some(Arc::new(weights_from(match v.to_value() {
                        serde_json::Value::Object(m) => m,
                        _ => unreachable!(),
                    })?)),
                    _ => {
                        return Err(format!(
                            "Rust 版では \"{k}\" に {} は使えません",
                            v.stringify()
                        ))
                    }
                };
                if k == "weights" {
                    o.weights = w;
                } else {
                    o.policy_weights = w;
                }
            }
            // TypeScript 版とともに消した実験用の項目（既定の値なら何もしない）
            "exhaustive" | "mulliganCards" if *v == Json::Null => {}
            "mulliganEvoBonus" if *v == Json::Num(0.0) => {}
            "reanimateGuard" if *v == Json::Bool(false) => {}
            "turn1ExtraPp" if *v == Json::Str("always".into()) => {}
            "exhaustive" | "mulliganCards" | "mulliganEvoBonus" | "reanimateGuard"
            | "turn1ExtraPp" => {
                return Err(format!(
                    "\"{k}\" は未対応です（TypeScript 版とともに消した実験用の項目）"
                ))
            }
            _ => return Err(format!("未知の設定の項目: \"{k}\"")),
        }
    }
    Ok(o)
}

/// compare の設定（scripts/compare-main.ts の parseOptions）。
/// "weights": "default" で基準の重み、オブジェクトなら SEARCH_WEIGHTS のその項目だけを変える（"holdScale" は hold を何倍にするか）
pub fn compare_options(text: &str) -> Result<SearchOptions, String> {
    let (mut raw, model) = apply_value_net(Json::parse(text)?)?;
    for key in ["weights", "policyWeights"] {
        if let Some(w) = resolve_weights(key, raw.get(key))? {
            raw.set(key, w);
        }
    }
    search_options(&raw, model.as_ref(), SearchOptions::default(), &[])
}

/// compare の "weights"・"policyWeights" の値を、全部の項目のある重みの JSON にする（直さなくてよければ None）。
/// "default" は基準の重み DEFAULT_WEIGHTS、"search" は探索 AI の既定 SEARCH_WEIGHTS、"zero" は全部 0（手で作った評価を使わない。
/// 試合が終わった局面の勝ち負けの点だけが残る）。オブジェクトなら SEARCH_WEIGHTS のその項目だけを変える（"holdScale" は hold を何倍にするか）
fn resolve_weights(key: &str, v: Option<&Json>) -> Result<Option<Json>, String> {
    Ok(match v {
        Some(Json::Str(s)) if s == "default" => Some(default_weights_json().clone()),
        Some(Json::Str(s)) if s == "search" => Some(search_weights_json().clone()),
        Some(Json::Str(s)) if s == "zero" => Some(zero_weights_json()),
        Some(Json::Str(s)) => {
            return Err(format!(
                "\"{key}\" は \"default\"・\"search\"・\"zero\" かオブジェクト: {s}"
            ))
        }
        Some(w @ Json::Obj(_)) => {
            let mut rest = w.clone();
            let scale = match rest.take("holdScale") {
                Some(Json::Num(x)) => x,
                _ => 1.0,
            };
            let hold = match search_weights_json().get("hold") {
                Some(Json::Obj(items)) => Json::Obj(
                    items
                        .iter()
                        .map(|(k, v)| (k.clone(), Json::Num(number(k, v).expect("hold") * scale)))
                        .collect(),
                ),
                _ => panic!("SEARCH_WEIGHTS に hold がありません"),
            };
            Some(
                search_weights_json()
                    .spread(&Json::Obj(vec![("hold".into(), hold)]))
                    .spread(&rest),
            )
        }
        _ => None,
    })
}

/// 全部の項目が 0 の重み（hold は空。"weights": "zero"）。手で作った評価は、試合が終わった局面の勝ち負けの点（±1e6）だけになる
pub fn zero_weights_json() -> Json {
    match search_weights_json() {
        Json::Obj(items) => Json::Obj(
            items
                .iter()
                .map(|(k, v)| {
                    let z = match v {
                        Json::Obj(_) => Json::Obj(Vec::new()),
                        _ => Json::Num(0.0),
                    };
                    (k.clone(), z)
                })
                .collect(),
        ),
        _ => panic!("SEARCH_WEIGHTS がオブジェクトではありません"),
    }
}

/// rhino-compare の --opts（"weights"・"policyWeights" は compare と同じ。オブジェクトは SEARCH_WEIGHTS に重ねる）。表示用の JSON と学習した補正
pub fn rhino_compare_options(text: &str) -> Result<(Json, Option<ExtraEval>), String> {
    let (mut raw, model) = apply_value_net(Json::parse(text)?)?;
    for key in ["weights", "policyWeights"] {
        if let Some(w) = resolve_weights(key, raw.get(key))? {
            raw.set(key, w);
        }
    }
    Ok((raw, model))
}

/// リノセウス用 AI の設定（createRhinoAgent の options）。エルフの手番の探索の設定と、それ以外の探索の設定
pub fn rhino_options(
    raw: &Json,
    model: Option<&ExtraEval>,
) -> Result<(SearchOptions, SearchOptions), String> {
    let potential = match raw.get("potential") {
        None => RHINO_POTENTIAL,
        Some(v) => number("potential", v)?,
    };
    // extraEval を書かなければ探索 AI の既定の補正（data/value-net.json）
    let learned = match raw.get("extraEval") {
        None => SearchOptions::default().extra_eval,
        Some(Json::Null) => None,
        Some(Json::Func) => Some(model.expect("学習した補正").clone()),
        Some(v) => {
            return Err(format!(
                "\"extraEval\" は null だけを渡せます: {}",
                v.stringify()
            ))
        }
    };
    let mut search = search_options(
        raw,
        model,
        rhino_search_options(potential, learned.clone()),
        &["potential", "extraEval", "passLethalWard"],
    )?;
    // passLethal で選ぶ終局面に、守護への見積もりのダメージがこの値以上あることを求める
    if let Some(v) = raw.get("passLethalWard") {
        search.pass_lethal_search = Some(rhino_pass_lethal(number("passLethalWard", v)? as i32));
    }
    // 補正を替えた・外したときは、エルフの手番と同じ評価の重みにする（既定の補正の出発点の重みは使わない）
    let plain = match raw.get("extraEval") {
        None => SearchOptions {
            extra_eval: learned,
            ..SearchOptions::default()
        },
        Some(_) => SearchOptions {
            extra_eval: learned,
            weights: search.weights.clone(),
            policy_weights: search.policy_weights.clone(),
            ..SearchOptions::default()
        },
    };
    Ok((search, plain))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options() {
        let o = compare_options(
            r#"{"lethal":false,"beamWidth":16,"weights":{"myHand":0.8,"holdScale":2}}"#,
        )
        .unwrap();
        assert!(!o.lethal);
        assert_eq!(o.beam_width, 16);
        let w = o.weights.unwrap();
        assert_eq!(w.my_hand, 0.8);
        let base = crate::ai::aidata::ai_data();
        let k = base
            .search_weights
            .hold
            .iter()
            .position(|&x| x != 0.0)
            .expect("hold");
        assert_eq!(w.hold[k], base.search_weights.hold[k] * 2.0);
        assert!(compare_options(r#"{"nope":1}"#).is_err());
        assert_eq!(
            compare_options(r#"{"rescoreMix":0.25}"#)
                .unwrap()
                .rescore_mix,
            0.25
        );
        assert!(compare_options(r#"{"rescoreMix":1.5}"#).is_err());
        assert!(compare_options(r#"{"exhaustive":{"untilTurn":5,"maxStates":100}}"#).is_err());
        assert!(compare_options(r#"{"exhaustive":null,"valueNet":false}"#)
            .unwrap()
            .extra_eval
            .is_none());
        let (raw, _) = rhino_compare_options(r#"{"potential":0,"nextLethal":10}"#).unwrap();
        assert_eq!(raw.stringify(), r#"{"potential":0,"nextLethal":10}"#);
        let (search, plain) = rhino_options(&raw, None).unwrap();
        assert_eq!(search.next_lethal, 10.0);
        assert!(!search.lethal && search.extra_eval.is_some() && plain.extra_eval.is_some());
    }
}
