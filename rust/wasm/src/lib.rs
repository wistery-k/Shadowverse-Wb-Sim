//! ブラウザ・Node から呼ぶエンジンと AI（src/engine/wasm.ts が読み込む）。
//!
//! wasm-bindgen を使わず、JSON の文字列で受け渡す。JS は `alloc` で確保した領域に要求の JSON（UTF-8）を書いて `call` を呼び、
//! 結果の JSON を `out_ptr`・`out_len` で読む。`call` の戻り値は 0: 成功、1: 不正な行動、2: その他のエラー（結果は message の文字列）。
//! 局面・行動は TypeScript 版と同じ形の JSON（rust/engine/src/state_json.rs）。
//!
//! panic すると WASM は止まる（unreachable）。そのときの message は `out_ptr`・`out_len` に残すので、JS はそれを読んでエラーにする。

use std::cell::RefCell;
use svwb_engine::ai::exact_lethal::reset_exact_lethal_cache;
use svwb_engine::ai::lethal::reset_lethal;
use svwb_engine::ai::lethal_hint::lethal_hint;
use svwb_engine::ai::registry::create_agent;
use svwb_engine::ai::search::ScoreParts;
use svwb_engine::ai::think::Thought;
use svwb_engine::ai::{Agent, Rng};
use svwb_engine::data::{data, CardIdx};
use svwb_engine::game::{attack_reach, attack_targets, fusion_candidates};
use svwb_engine::json::Json;
use svwb_engine::sim::branch_playout;
use svwb_engine::state::Iid;
use svwb_engine::state_json::{action_from_json, action_to_json, state_from_json, state_to_json};
use svwb_engine::{
    apply_legal, create_game, is_legal, legal_actions, resolve_turn_end, try_apply_action, Action,
    GameState,
};

thread_local! {
    /// 最後の結果（または panic の message）
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    /// 作った AI（添字が JS に渡す番号。消したものは None）
    static AGENTS: RefCell<Vec<Option<Box<dyn Agent>>>> = const { RefCell::new(Vec::new()) };
}

enum Fail {
    Illegal(String),
    Error(String),
}

impl From<String> for Fail {
    fn from(e: String) -> Fail {
        Fail::Error(e)
    }
}

type R<T> = Result<T, Fail>;

fn set_out(bytes: Vec<u8>) {
    OUT.with(|o| {
        if let Ok(mut o) = o.try_borrow_mut() {
            *o = bytes;
        }
    });
}

/// JS が要求を書く領域を確保する（`call` が解放する）
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

/// 要求（`alloc` で確保した領域の len バイトの JSON）を処理する
///
/// # Safety
/// ptr は `alloc(len)` が返したもので、len バイトの UTF-8 が書かれていること（この関数が解放する）
#[no_mangle]
pub unsafe extern "C" fn call(ptr: *mut u8, len: usize) -> u32 {
    static HOOK: std::sync::Once = std::sync::Once::new();
    HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|info| set_out(info.to_string().into_bytes())));
    });
    let input = Vec::from_raw_parts(ptr, len, len.max(1));
    let result = std::str::from_utf8(&input)
        .map_err(|e| Fail::Error(format!("要求が UTF-8 ではありません: {e}")))
        .and_then(|text| Json::parse(text).map_err(Fail::Error))
        .and_then(|req| dispatch(&req));
    let (code, out) = match result {
        Ok(v) => (0, v.stringify()),
        Err(Fail::Illegal(m)) => (1, m),
        Err(Fail::Error(m)) => (2, m),
    };
    set_out(out.into_bytes());
    code
}

fn field<'a>(req: &'a Json, key: &str) -> R<&'a Json> {
    req.get(key)
        .ok_or_else(|| Fail::Error(format!("要求に {key} がありません")))
}

fn num(req: &Json, key: &str) -> R<f64> {
    match field(req, key)? {
        Json::Num(x) => Ok(*x),
        v => Err(Fail::Error(format!("{key} は数: {}", v.stringify()))),
    }
}

fn uint(req: &Json, key: &str) -> R<u32> {
    let x = num(req, key)?;
    if x >= 0.0 && x <= u32::MAX as f64 && x.fract() == 0.0 {
        Ok(x as u32)
    } else {
        Err(Fail::Error(format!("{key} は 0 以上の整数: {x}")))
    }
}

fn iid(req: &Json, key: &str) -> R<Iid> {
    let x = num(req, key)?;
    if x.fract() == 0.0 && x.abs() <= i32::MAX as f64 {
        Ok(x as Iid)
    } else {
        Err(Fail::Error(format!("{key} はカードの番号: {x}")))
    }
}

fn state(req: &Json) -> R<GameState> {
    Ok(state_from_json(field(req, "state")?)?)
}

fn action(req: &Json, key: &str) -> R<Action> {
    Ok(action_from_json(field(req, key)?)?)
}

fn actions_json(actions: &[Action]) -> Json {
    Json::Arr(actions.iter().map(action_to_json).collect())
}

fn nums(xs: impl Iterator<Item = Iid>) -> Json {
    Json::Arr(xs.map(|x| Json::Num(x as f64)).collect())
}

fn deck(v: &Json) -> R<Vec<CardIdx>> {
    let Json::Arr(ids) = v else {
        return Err(Fail::Error("デッキはカードIDの配列".into()));
    };
    ids.iter()
        .map(|id| match id {
            Json::Str(id) => data()
                .card_by_id
                .get(id.as_str())
                .copied()
                .ok_or_else(|| Fail::Error(format!("未知のカードID: {id}"))),
            v => Err(Fail::Error(format!("カードIDは文字列: {}", v.stringify()))),
        })
        .collect()
}

fn parts_json(p: &ScoreParts) -> Json {
    Json::Obj(vec![
        ("total".into(), Json::Num(p.total)),
        ("eval".into(), Json::Num(p.eval)),
        ("extra".into(), Json::Num(p.extra)),
    ])
}

fn thought_json(t: &Thought) -> Json {
    let opt = |x: Option<Json>| x.unwrap_or(Json::Null);
    Json::Obj(vec![
        ("player".into(), Json::Num(t.player as f64)),
        ("lethal".into(), opt(t.lethal.as_ref().map(action_to_json))),
        (
            "roots".into(),
            Json::Arr(t.roots.iter().map(state_to_json).collect()),
        ),
        (
            "candidates".into(),
            Json::Arr(
                t.candidates
                    .iter()
                    .map(|c| {
                        Json::Obj(vec![
                            ("action".into(), action_to_json(&c.action)),
                            ("sample".into(), Json::Num(c.sample as f64)),
                            ("steps".into(), actions_json(&c.steps)),
                            ("turnEnd".into(), parts_json(&c.turn_end)),
                            ("read".into(), opt(c.read.as_ref().map(parts_json))),
                            ("readCount".into(), Json::Num(c.read_count as f64)),
                            ("value".into(), opt(c.value.map(Json::Num))),
                            ("legal".into(), Json::Bool(c.legal)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("chosen".into(), action_to_json(&t.chosen)),
    ])
}

fn dispatch(req: &Json) -> R<Json> {
    let f = match field(req, "f")? {
        Json::Str(f) => f.as_str(),
        _ => return Err(Fail::Error("f は関数の名前".into())),
    };
    Ok(match f {
        "createGame" => {
            let Json::Arr(decks) = field(req, "decks")? else {
                return Err(Fail::Error("decks は 2 つのデッキの配列".into()));
            };
            let [a, b] = decks.as_slice() else {
                return Err(Fail::Error("decks は 2 つのデッキの配列".into()));
            };
            let (a, b) = (deck(a)?, deck(b)?);
            state_to_json(&create_game([&a, &b], uint(req, "seed")?))
        }
        "legalActions" => actions_json(&legal_actions(&state(req)?)),
        "applyAction" => {
            let (s, a) = (state(req)?, action(req, "action")?);
            if !is_legal(&s, &a) {
                return Err(Fail::Illegal(format!(
                    "不正な行動です: {}",
                    action_to_json(&a).stringify()
                )));
            }
            state_to_json(&apply_legal(&s, &a))
        }
        "tryApplyAction" => match try_apply_action(&state(req)?, &action(req, "action")?) {
            Some(next) => state_to_json(&next),
            None => Json::Null,
        },
        // 局面を読んで書き出す（サンドボックスの読み込みで、形を確かめてエンジンの書き出す形にそろえる）
        "normalizeState" => state_to_json(&state(req)?),
        "isLegal" => Json::Bool(is_legal(&state(req)?, &action(req, "action")?)),
        "resolveTurnEnd" => match resolve_turn_end(&state(req)?) {
            Some(next) => state_to_json(&next),
            None => Json::Null,
        },
        "fusionCandidates" => nums(fusion_candidates(&state(req)?, iid(req, "host")?).into_iter()),
        "attackTargets" | "attackReach" => {
            let s = state(req)?;
            let iid = iid(req, "attacker")?;
            let Some((p, i)) = s.find_board(iid) else {
                return Err(Fail::Error(format!("場にいないカード: {iid}")));
            };
            let c = &s.players[p].board[i];
            if !c.is_follower {
                return Err(Fail::Error(format!("フォロワーではないカード: {iid}")));
            }
            if f == "attackReach" {
                Json::Str(attack_reach(&s, c).into())
            } else {
                let mut out = Vec::new();
                attack_targets(&s, c, &mut out);
                Json::Arr(
                    out.into_iter()
                        .map(|t| match t {
                            Some(iid) => Json::Num(iid as f64),
                            None => Json::Str("leader".into()),
                        })
                        .collect(),
                )
            }
        }
        "agentNew" => {
            let name = match field(req, "name")? {
                Json::Str(n) => n.as_str(),
                _ => return Err(Fail::Error("name は AI の名前".into())),
            };
            let agent =
                create_agent(name).ok_or_else(|| Fail::Error(format!("未知の AI: {name}")))?;
            AGENTS.with(|a| {
                let mut a = a.borrow_mut();
                a.push(Some(agent));
                Json::Num((a.len() - 1) as f64)
            })
        }
        "agentFree" => {
            let h = uint(req, "handle")? as usize;
            AGENTS.with(|a| {
                if let Some(slot) = a.borrow_mut().get_mut(h) {
                    *slot = None;
                }
            });
            Json::Null
        }
        "agentChoose" => {
            let h = uint(req, "handle")? as usize;
            let s = state(req)?;
            let Json::Arr(legal) = field(req, "legal")? else {
                return Err(Fail::Error("legal は行動の配列".into()));
            };
            let legal = legal
                .iter()
                .map(action_from_json)
                .collect::<Result<Vec<_>, _>>()?;
            if legal.is_empty() {
                return Err(Fail::Error("打てる手がありません".into()));
            }
            let mut rng = Rng::new(uint(req, "rng")?);
            // 考えている間も AI の一覧を借りたままにする（AI の中から WASM を呼び直すことはない）
            let chosen = AGENTS.with(|a| {
                let mut a = a.borrow_mut();
                match a.get_mut(h).and_then(|x| x.as_mut()) {
                    Some(agent) => Ok(agent.choose_action(&s, &legal, &mut rng)),
                    None => Err(Fail::Error(format!("無い AI: {h}"))),
                }
            })?;
            Json::Obj(vec![
                ("action".into(), action_to_json(&chosen)),
                ("rng".into(), Json::Num(rng.state as f64)),
            ])
        }
        "lethalHint" => {
            let s = state(req)?;
            let p = match uint(req, "player")? {
                0 => 0,
                1 => 1,
                x => return Err(Fail::Error(format!("player は 0 か 1: {x}"))),
            };
            match lethal_hint(&s, p, uint(req, "seed")?) {
                Some(steps) => actions_json(&steps),
                None => Json::Null,
            }
        }
        "branchPlayout" => {
            // 打ち比べの 1 試合（svwb_engine::sim::branch_playout）。AI は試合ごとに作り直し、覚えていることを持ち越さない
            let s = state(req)?;
            let first = action(req, "action")?;
            let Json::Arr(names) = field(req, "agents")? else {
                return Err(Fail::Error("agents は 2 つの AI の名前の配列".into()));
            };
            let mut made = Vec::new();
            for n in names {
                let Json::Str(n) = n else {
                    return Err(Fail::Error("agents は 2 つの AI の名前の配列".into()));
                };
                made.push(create_agent(n).ok_or_else(|| Fail::Error(format!("未知の AI: {n}")))?);
            }
            let [a0, a1] = made.as_mut_slice() else {
                return Err(Fail::Error("agents は 2 つの AI の名前の配列".into()));
            };
            reset_exact_lethal_cache();
            reset_lethal();
            match branch_playout(
                &s,
                &first,
                &mut [a0.as_mut(), a1.as_mut()],
                uint(req, "seed")?,
            ) {
                Some(end) => Json::Obj(vec![
                    (
                        "winner".into(),
                        end.winner.map_or(Json::Null, |w| Json::Num(w as f64)),
                    ),
                    ("turns".into(), Json::Num(end.turn as f64)),
                ]),
                None => Json::Null,
            }
        }
        "agentThink" => {
            // リプレイの「AI の考え」（svwb_engine::ai::think）。AI はその場で作り、前の局面で決めた並び・リーサルの手順を使わずに考え直す
            let name = match field(req, "agent")? {
                Json::Str(n) => n.as_str(),
                _ => return Err(Fail::Error("agent は AI の名前".into())),
            };
            let mut agent =
                create_agent(name).ok_or_else(|| Fail::Error(format!("未知の AI: {name}")))?;
            let s = state(req)?;
            let legal = legal_actions(&s);
            reset_exact_lethal_cache();
            reset_lethal();
            let mut rng = Rng::new(uint(req, "rng")?);
            match agent.think(&s, &legal, &mut rng) {
                Some(t) => thought_json(&t),
                None => Json::Null,
            }
        }
        "resetCaches" => {
            reset_exact_lethal_cache();
            reset_lethal();
            Json::Null
        }
        _ => return Err(Fail::Error(format!("未知の関数: {f}"))),
    })
}
