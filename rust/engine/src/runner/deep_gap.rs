//! 自己対戦の局面で、今の AI の手と、時間をかけた深い読みの手を比べ、差の大きい局面を集める（2026-10-26）。
//!
//!   svwb deep-gap play --out gap.jsonl [--games 100] [--start 0] [--deep '<設定の JSON>'] [--k 4] [--evalSeeds 48] [--turns 1-30]
//!   svwb deep-gap rollout --in gap.jsonl[,…] --out roll.jsonl [--top 200] [--random 200] [--seed 1] [--m 48]
//!   svwb deep-gap report gap.jsonl… [--rollouts roll.jsonl,…] [--top 30] [--only <内訳の一部>] [--skipDecks <デッキ名,…>] [--sort gap|rollout] [--listOnly 1]
//!
//! **play**: 今の既定の AI どうしの試合 g（`ai_game_setup`。比較用の 7 デッキで、デッキ・席・シードは `svwb ai-play` と同じ）を打ち、
//! 両方のプレイヤーの自分のターンの最初の局面ごとに、試合で今の AI が実際に打ったターン（ターン終了の直前まで）と、
//! 同じ局面から深い読みの設定（`--deep`。既定は [`DEEP_DEFAULT`]。読む深さは今の既定と同じで、広く・多く読む）の探索 AI が打つターンのターン末を比べる。
//! 違った局面（食い違い）だけ、次を測って書く。
//! - **差（主に使う値）**: 手番の側から見た決定化（相手の手札・山札の中身と順番、乱数の状態を並べ直す）を `--k` 通り作り、
//!   それぞれで今の AI と深い読みの両方にそのターンを打たせ、両方のターン末を深い読みの点数で採点した勝率の差（深い読み − 今の AI）の平均。
//!   実際の試合のターン末をそのまま比べると、ターンの途中で引いたカード・乱数の効果の当たり外れ（後から見た運）が差に混ざるため、
//!   引きを並べ直して平均する。今の AI の側は「今の AI ならこう打つ」の平均なので、今の AI のぶれ（決定化 1 回）で損をする分も入る
//! - 深い読みの点数: 深い読みの設定で、`--evalSeeds` 通りの相手の手札の引き直し（深い読みが手を選んだのとは別の引き直し）で相手のターンを読み直し、
//!   探索と同じくターン末の点数を `rescoreMix` の割合で混ぜたもの。勝率は学習した補正の a で σ(a·点数)（`docs/value-net.md`）を引き直しごとに求めて平均する。
//!   相手のリーサルがある引き直しは負けの点数（-1e6）になるので、点数を平均してから勝率にすると、48 通りのうち 1 通りでもリーサルがあれば勝率 0% になる
//!   （最初の版はそうしていた）。相手のリーサルになった引き直しの割合も書く（`loss`・`deepLoss`）
//! - 実際の試合のターン末どうしの差（`real`）: 深い読みの点数と、今の AI の点数（今の既定の設定、引き直し 12 通り）の両方で。
//!   どちらかのターンでカードを引いた・乱数を使ったか（`hidden`。後から見た運が混ざる）
//! - 今の AI のビームの候補（最初の手ごとのターン末の最善）の中での、深い読みの実際のターン末の順位（ビームが届かないのか、読み直しの候補から外れたのか）
//!
//! **rollout**: play の結果から、差の大きい順に `--top` 局面と、残りの食い違った局面から乱数で選んだ `--random` 局面を選び、
//! 手番の側から見た決定化を `--m` 通り作って、それぞれで今の AI と深い読みにそのターンを打たせ、続きを今の AI どうしで最後まで打った勝ち負けを書く
//! （r 通り目は、両方とも同じ決定化・同じ乱数）。深い読みの点数の差が、最後まで打った勝率の差として本当にあるかを確かめる
//! （深い読みにも評価の偏りがあるため）。`--random` の局面は差の大きさで選んでいないので、点数と勝率の突き合わせ（当たり方）に使う。
//!
//! **report**: まとめ（食い違いの割合、差の分布、差の内訳、最後まで打った勝率と点数の差の突き合わせ、差の大きい局面の中身）を Markdown で出す。
//! 局面の中身は `--only`（差の内訳の名前の一部。例: `ビームが届かない`）・`--skipDecks`（手番の側のデッキ）で絞り、`--sort` で並べ替える
//! （既定は、最後まで打った結果があればその差、無ければ差）。`--listOnly 1` はまとめを出さず局面の中身だけを、デッキごとに分けて出す。
//!
//! 出力は JSON Lines。play は試合ごとに局面の行と試合の行（`"game": true`、手の列と深い読みの設定つき）を書き、rollout は局面ごとに 1 行書く。
//! どちらも出力に既にある試合・局面は飛ばす（同じ引数で再開できる）。試合の行の無い試合の局面の行（途中で止めたもの）は、再開のときに消す。
//! 実際の対戦の局面を入れる口は無い（自己対戦の局面だけを扱う。CLAUDE.md「ソフト打ち」）。

use super::fixed;
use super::human_plan::{
    is_start_of_turn, mean_se, mix, parse_range, pct, round2, step_text, summarize_start, win_rate,
};
use super::options::compare_options;
use super::parallel::parallel_map;
use crate::ai::aidata::ai_data;
use crate::ai::determinize::determinize;
use crate::ai::keys::turn_order_eq;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::{Agent, Rng};
use crate::data::{data, Kw};
use crate::game::{acting_player, apply_legal, create_game, is_legal, legal_actions};
use crate::json::Json;
use crate::sim::{ai_game_setup, play_match};
use crate::state::{card, opponent, Action, Evolve, GameState, OnBoard, Phase, PlayerIndex};
use crate::state_json::{action_from_json, action_to_json};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

/// 深い読みの既定の設定（今の既定から、自分のターンのビームを 4 倍、読み直す最初の手を 2 倍・最初の手ごとの終局面を 3 つ、
/// 相手の手札の引き直しを 4 倍、相手のターンのビームを 2 倍にしたもの。1 ターンの思考は今の既定の 15〜20 倍ほど）。
/// 読む深さ（自分のターンのあと相手のターンを 1 回打って評価する）は今の既定と同じで、先までは読まない。
/// 自分のターンのビームは、今の既定が幅 512 になった 2026-10-26 に 512 から 2048 に（それまでの記録は 512）。
pub const DEEP_DEFAULT: &str = r#"{"beamWidth":2048,"rescoreTop":8,"planCandidates":3,"oppHandSamples":48,"opponentSearch":{"beamWidth":32,"maxDepth":8}}"#;

/// 今の AI の点数で読み直す引き直しの数（今の既定の oppHandSamples と同じ）
const AI_EVAL_SEEDS: u32 = 12;

fn deck_name_of(cards: &[crate::data::CardIdx]) -> String {
    data()
        .decks
        .iter()
        .find(|d| d.cards == cards)
        .map_or("?".to_string(), |d| d.name.clone())
}

fn action_value(a: &Action) -> Value {
    action_to_json(a).to_value()
}

fn action_of(v: &Value) -> Result<Action, String> {
    action_from_json(&Json::parse(&v.to_string())?)
}

fn actions_of(v: &Value) -> Result<Vec<Action>, String> {
    v.as_array()
        .ok_or("手の列がありません")?
        .iter()
        .map(action_of)
        .collect()
}

/// 2 つのターン末が同じか（どちらかで試合が終わったなら、両方が終わって勝者が同じか）
pub(crate) fn same_end(a: &GameState, b: &GameState) -> bool {
    let (ea, eb) = (a.phase == Phase::Ended, b.phase == Phase::Ended);
    if ea || eb {
        ea && eb && a.winner == b.winner
    } else {
        turn_order_eq(a, b)
    }
}

/// start から end までのターンで、山札からカードを引いた（山札の枚数が変わった）か、局面の乱数を使ったか
fn hidden_in_turn(start: &GameState, end: &GameState) -> bool {
    end.rng != start.rng || (0..2).any(|q| end.players[q].deck.len() != start.players[q].deck.len())
}

/// 局面 start から手の列 actions を、p がターンを終える手の直前まで打つ（試合が終わればそこまで）。打った手とターン末
fn replay_turn(
    start: &GameState,
    p: PlayerIndex,
    actions: &[Action],
) -> Result<(Vec<Action>, GameState), String> {
    let mut t = start.clone();
    let mut done = Vec::new();
    for a in actions {
        if t.phase == Phase::Ended {
            break;
        }
        if acting_player(&t) == p && matches!(a, Action::EndTurn) {
            return Ok((done, t));
        }
        if !is_legal(&t, a) {
            return Err("記録の手が打てません".into());
        }
        t = apply_legal(&t, a);
        done.push(a.clone());
    }
    if t.phase == Phase::Ended {
        Ok((done, t))
    } else {
        Err("ターンの終わりまで手がありません".into())
    }
}

/// 局面 start から、席 p を設定 me の探索 AI、相手を今の既定の AI にして、p がターンを終える手の直前まで打つ。打った手とターン末
fn play_turn(
    start: &GameState,
    p: PlayerIndex,
    me: &SearchOptions,
    seed: u32,
) -> Result<(Vec<Action>, GameState), String> {
    let mut mine = SearchAgent::new(me.clone());
    let mut other = SearchAgent::new(SearchOptions::default());
    let mut rng = Rng::new(seed);
    let mut t = start.clone();
    let mut done = Vec::new();
    for _ in 0..500 {
        if t.phase == Phase::Ended {
            return Ok((done, t));
        }
        let actor = acting_player(&t);
        let legal = legal_actions(&t);
        let a = if actor == p {
            mine.choose_action(&t, &legal, &mut rng)
        } else {
            other.choose_action(&t, &legal, &mut rng)
        };
        if actor == p && matches!(a, Action::EndTurn) {
            return Ok((done, t));
        }
        t = apply_legal(&t, &a);
        done.push(a);
        if t.phase != Phase::Ended && t.active != p {
            return Err("ターンを終える手を打たずに相手の番になりました".into());
        }
    }
    Err("AI がターンを終えません".into())
}

/// ターン末 1 つの採点（ターン末の点数、相手のターンを読み直した点数、探索が手を選ぶときの点数、勝率、相手の勝ちになった引き直しの割合）
struct Scored {
    turn_end: Option<f64>,
    read: f64,
    value: f64,
    /// 引き直しごとの点数（ターン末の点数を混ぜたもの）を勝率にしてからの平均（%）
    win: f64,
    /// 相手のターンを読んだら相手の勝ち（リーサル）になった引き直しの割合（0〜1）
    loss: f64,
}

/// 負けの点数（-1e6）とみなす下限
const LOSS_SCORE: f64 = -5e5;

fn score(agent: &SearchAgent, end: &GameState, p: PlayerIndex, seeds: &[u32]) -> Scored {
    let reads = agent.read_values(end, p, seeds);
    let n = reads.len() as f64;
    let read = reads.iter().sum::<f64>() / n;
    let loss = reads.iter().filter(|&&v| v <= LOSS_SCORE).count() as f64 / n;
    if end.phase == Phase::Ended {
        return Scored {
            turn_end: None,
            read,
            value: read,
            win: win_pct(read),
            loss,
        };
    }
    let turn_end = agent.turn_end_value(end, p);
    let m = agent.opts.rescore_mix;
    let value_of = |r: f64| (1.0 - m) * r + m * turn_end;
    Scored {
        turn_end: Some(turn_end),
        read,
        value: value_of(read),
        win: reads.iter().map(|&r| win_pct(value_of(r))).sum::<f64>() / n,
        loss,
    }
}

/// 点数を勝率（%）にする（σ(a·点数)。a は学習した補正のもの）
pub(crate) fn win_pct(v: f64) -> f64 {
    let a = ai_data().value_net.a;
    100.0 / (1.0 + (-a * v).exp())
}

fn keyword_ja(name: &str) -> &'static str {
    match name {
        "ward" => "守護",
        "storm" => "疾走",
        "rush" => "突進",
        "bane" => "必殺",
        "drain" => "ドレイン",
        "ambush" => "潜伏",
        "intimidate" => "威圧",
        "barrier" => "バリア",
        "aura" => "オーラ",
        _ => "?",
    }
}

fn board_text(b: &OnBoard) -> String {
    let c = card(b.card);
    let mut t = c.name.clone();
    if b.is_follower {
        t += &format!(" {}/{}", b.attack_value(), b.defense);
        match b.evolve {
            Evolve::Evolved => t += "（進化）",
            Evolve::SuperEvolved => t += "（超進化）",
            Evolve::None => {}
        }
    } else if let Some(n) = b.countdown {
        t += &format!("（カウントダウン {n}）");
    }
    let kws: Kw = b.keywords.with(b.temp_keywords);
    if !kws.is_empty() {
        let names: Vec<&str> = kws.names().into_iter().map(keyword_ja).collect();
        t += &format!("［{}］", names.join("・"));
    }
    t
}

fn list_or_none(v: Vec<String>) -> String {
    if v.is_empty() {
        "なし".into()
    } else {
        v.join("、")
    }
}

/// 局面の説明（手番の側 p から見える情報だけ。相手の手札は枚数だけ）
pub(crate) fn describe(s: &GameState, p: PlayerIndex, decks: &[String; 2]) -> Vec<String> {
    let o = opponent(p);
    let (me, op) = (&s.players[p], &s.players[o]);
    let side = |q: PlayerIndex| if s.first == q { "先攻" } else { "後攻" };
    let hand: Vec<String> = me.hand.iter().map(|h| card(h.card).name.clone()).collect();
    let board = |q: PlayerIndex| -> String {
        list_or_none(s.players[q].board.iter().map(board_text).collect())
    };
    let crests = |q: PlayerIndex| -> String {
        let v: Vec<String> = s.players[q]
            .crests
            .iter()
            .map(|c| data().crests[c.crest as usize].id.clone())
            .collect();
        if v.is_empty() {
            String::new()
        } else {
            format!("（クレスト: {}）", v.join("、"))
        }
    };
    vec![
        format!(
            "自分（{}・{}）: 体力 {}、PP {}/{}、EP {}、SEP {}、山札 {}、墓場 {}",
            side(p),
            decks[p],
            me.leader_hp,
            me.pp,
            me.max_pp,
            me.ep,
            me.sep,
            me.deck.len(),
            me.graveyard
        ),
        format!("自分の手札: {}", list_or_none(hand)),
        format!("自分の場: {}{}", board(p), crests(p)),
        format!(
            "相手（{}・{}）: 体力 {}、PP 最大 {}、EP {}、SEP {}、手札 {} 枚、山札 {}、墓場 {}",
            side(o),
            decks[o],
            op.leader_hp,
            op.max_pp,
            op.ep,
            op.sep,
            op.hand.len(),
            op.deck.len(),
            op.graveyard
        ),
        format!("相手の場: {}{}", board(o), crests(o)),
    ]
}

pub(crate) fn steps_of(start: &GameState, actions: &[Action], p: PlayerIndex) -> Vec<String> {
    let mut t = start.clone();
    let mut out = Vec::new();
    for a in actions {
        out.push(step_text(&t, a, p));
        t = apply_legal(&t, a);
    }
    out
}

/// 手の列で使ったもの（手札から出したカード・進化・超進化・融合の素材・能力・エクストラPP）の名前。2 つのターンの違いを見せるため
fn used_of(start: &GameState, actions: &[Action]) -> Vec<String> {
    let mut t = start.clone();
    let mut out = Vec::new();
    let name = |s: &GameState, iid: i32| -> String {
        s.players
            .iter()
            .flat_map(|pl| {
                pl.hand
                    .iter()
                    .map(|h| (h.iid, h.card))
                    .chain(pl.board.iter().map(|b| (b.iid, b.card)))
            })
            .find(|x| x.0 == iid)
            .map(|x| card(x.1).name.clone())
            .unwrap_or_else(|| format!("#{iid}"))
    };
    for a in actions {
        match a {
            Action::Play(i) => out.push(format!("プレイ {}", name(&t, *i))),
            Action::Evolve(i) => out.push(format!("進化 {}", name(&t, *i))),
            Action::SuperEvolve(i) => out.push(format!("超進化 {}", name(&t, *i))),
            Action::Act(i) => out.push(format!("能力 {}", name(&t, *i))),
            Action::Fuse { materials, .. } => {
                for m in materials {
                    out.push(format!("融合 {}", name(&t, *m)));
                }
            }
            Action::ExtraPp => out.push("エクストラPP".into()),
            _ => {}
        }
        t = apply_legal(&t, a);
    }
    out
}

/// 2 つの多重集合の差（a にあって b に無い分）
fn multiset_minus(a: &[String], b: &[String]) -> Vec<String> {
    let mut rest: Vec<&String> = b.iter().collect();
    let mut out = Vec::new();
    for x in a {
        match rest.iter().position(|y| *y == x) {
            Some(k) => {
                rest.remove(k);
            }
            None => out.push(x.clone()),
        }
    }
    out
}

/// play の設定
struct PlayConfig {
    deep_text: String,
    deep: SearchOptions,
    k: u32,
    eval_seeds: u32,
    turns: (i32, i32),
}

/// 試合 g の初期局面とデッキの名前（席ごと）とシード
fn game_start(g: u32) -> (GameState, [String; 2], u32) {
    let (decks, seed) = ai_game_setup(g, false);
    let names = [deck_name_of(&decks[0]), deck_name_of(&decks[1])];
    (create_game([&decks[0], &decks[1]], seed), names, seed)
}

/// 局面 start（p の自分のターンの最初）から、決定化 k 通りそれぞれで今の AI と深い読みにターンを打たせ、深い読みの点数で採点した
/// 勝率の差（深い読み − 今の AI、% の数）と点数の差、両方が同じターン末になった回数
/// 決定化 k 通りでの差
struct PolicyGap {
    /// 勝率の差（%）
    wins: Vec<f64>,
    /// 点数の差
    points: Vec<f64>,
    /// 今の AI と深い読みのターン末の、相手の勝ちになった引き直しの割合
    loss: Vec<(f64, f64)>,
    /// 同じターン末になった数
    same: u32,
}

fn policy_gap(
    start: &GameState,
    p: PlayerIndex,
    cfg: &PlayConfig,
    deep_agent: &SearchAgent,
    pos_seed: u32,
) -> Result<PolicyGap, String> {
    let seeds: Vec<u32> = (0..cfg.eval_seeds)
        .map(|j| mix(pos_seed, 70_000 + j))
        .collect();
    let mut r = PolicyGap {
        wins: Vec::new(),
        points: Vec::new(),
        loss: Vec::new(),
        same: 0,
    };
    for k in 0..cfg.k {
        let det = determinize(start, p, &mut Rng::new(mix(pos_seed, 60_000 + k)), false);
        let (_, a_end) = play_turn(
            &det,
            p,
            &SearchOptions::default(),
            mix(pos_seed, 61_000 + k),
        )?;
        let (_, d_end) = play_turn(&det, p, &cfg.deep, mix(pos_seed, 62_000 + k))?;
        if same_end(&a_end, &d_end) {
            r.same += 1;
            r.wins.push(0.0);
            r.points.push(0.0);
            continue;
        }
        let sa = score(deep_agent, &a_end, p, &seeds);
        let sd = score(deep_agent, &d_end, p, &seeds);
        r.wins.push(sd.win - sa.win);
        r.points.push(sd.value - sa.value);
        r.loss.push((sa.loss, sd.loss));
    }
    Ok(r)
}

/// 試合 g を今の既定の AI どうしで打ち、自分のターンの最初の局面ごとに深い読みと比べた行と、最後に試合の行を返す
fn play_game(g: u32, cfg: &PlayConfig) -> Result<Vec<Value>, String> {
    let (decks, seed) = ai_game_setup(g, false);
    let names = [deck_name_of(&decks[0]), deck_name_of(&decks[1])];
    let mut a0 = SearchAgent::new(SearchOptions::default());
    let mut a1 = SearchAgent::new(SearchOptions::default());
    let mut agents: [&mut dyn Agent; 2] = [&mut a0, &mut a1];
    let mut actions: Vec<Action> = Vec::new();
    // (手の番号, 局面)
    let mut starts: Vec<(usize, GameState)> = Vec::new();
    let mut last_turn = [-1, -1];
    let end = play_match(&mut agents, [&decks[0], &decks[1]], seed, |s, a| {
        let p = s.active;
        if s.phase == Phase::Main
            && is_start_of_turn(s)
            && acting_player(s) == p
            && s.players[p].turn_count != last_turn[p]
        {
            last_turn[p] = s.players[p].turn_count;
            let t = s.players[p].turn_count;
            if t >= cfg.turns.0 && t <= cfg.turns.1 {
                starts.push((actions.len(), s.clone()));
            }
        }
        actions.push(a.clone());
    });
    let default_agent = SearchAgent::new(SearchOptions::default());
    let deep_agent = SearchAgent::new(cfg.deep.clone());
    let mut rows = Vec::new();
    for (i, start) in &starts {
        let t0 = Instant::now();
        let p = start.active;
        let pos_seed = mix(seed, 1000 + *i as u32);
        let (ai_actions, ai_end) = replay_turn(start, p, &actions[*i..])?;
        let (deep_actions, deep_end) = play_turn(start, p, &cfg.deep, mix(pos_seed, 1))?;
        let mut row = json!({
            "g": g, "i": i, "p": p, "turn": start.turn, "ownTurn": start.players[p].turn_count,
            "first": start.first == p, "deck": names[p], "oppDeck": names[opponent(p)],
            "same": same_end(&ai_end, &deep_end),
        });
        if row["same"] == json!(true) {
            row["sec"] = round2(t0.elapsed().as_secs_f64());
            rows.push(row);
            continue;
        }
        // 実際の試合のターン末どうしの差
        let deep_seeds: Vec<u32> = (0..cfg.eval_seeds)
            .map(|k| mix(pos_seed, 10_000 + k))
            .collect();
        let ai_seeds: Vec<u32> = (0..AI_EVAL_SEEDS)
            .map(|k| mix(pos_seed, 20_000 + k))
            .collect();
        let side = |acts: &[Action], end: &GameState| {
            let d = score(&deep_agent, end, p, &deep_seeds);
            let a = score(&default_agent, end, p, &ai_seeds);
            let value = json!({
                "actions": acts.iter().map(action_value).collect::<Vec<_>>(),
                "steps": steps_of(start, acts, p),
                "ended": end.phase == Phase::Ended,
                "hidden": hidden_in_turn(start, end),
                "turnEnd": a.turn_end.map(round2),
                "read": round2(a.read), "value": round2(a.value),
                "deepRead": round2(d.read), "deepValue": round2(d.value),
                "deepWin": round2(d.win), "deepLoss": round2(d.loss),
                "aiWin": round2(a.win), "aiLoss": round2(a.loss),
            });
            (value, d, a)
        };
        let (ai_side, ai_deep, ai_ai) = side(&ai_actions, &ai_end);
        let (deep_side, deep_deep, deep_ai) = side(&deep_actions, &deep_end);
        // 今の AI のビームの候補（最初の手ごとのターン末の最善。実際の局面をそのまま読む）の中での順位
        let mut beam = Value::Null;
        if ai_end.phase != Phase::Ended && deep_end.phase != Phase::Ended {
            let values: Vec<f64> = default_agent
                .turn_end_candidates(start, p)
                .iter()
                .map(|c| c.1)
                .collect();
            let rank = |v: f64| values.iter().filter(|&&x| x > v + 1e-9).count();
            let best = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let dte = default_agent.turn_end_value(&deep_end, p);
            let ate = default_agent.turn_end_value(&ai_end, p);
            beam = json!({
                "count": values.len(), "best": round2(best),
                "deepRank": rank(dte), "aiRank": rank(ate),
                "deepAbove": dte > best + 1e-6,
                "rescoreTop": default_agent.opts.rescore_top,
            });
        }
        // 決定化 k 通りでの差（後から見た運を除く）
        let pg = policy_gap(start, p, cfg, &deep_agent, pos_seed)?;
        let (gm, gs) = mean_se(&pg.wins);
        let obj = row.as_object_mut().expect("オブジェクト");
        obj.insert("gapWin".into(), round2(gm));
        obj.insert(
            "gapWinSe".into(),
            if gs.is_finite() {
                round2(gs)
            } else {
                Value::Null
            },
        );
        obj.insert("gapPts".into(), round2(mean_se(&pg.points).0));
        obj.insert("k".into(), json!(cfg.k));
        obj.insert("kSame".into(), json!(pg.same));
        // 食い違った決定化での、相手の勝ちになった引き直しの割合の平均（今の AI のターン末・深い読みのターン末）
        if !pg.loss.is_empty() {
            let n = pg.loss.len() as f64;
            obj.insert(
                "loss".into(),
                json!({
                    "ai": round2(pg.loss.iter().map(|l| l.0).sum::<f64>() / n),
                    "deep": round2(pg.loss.iter().map(|l| l.1).sum::<f64>() / n),
                }),
            );
        }
        obj.insert(
            "real".into(),
            json!({
                "gapWin": round2(deep_deep.win - ai_deep.win),
                "gap": round2(deep_deep.value - ai_deep.value),
                "aiGapWin": round2(deep_ai.win - ai_ai.win),
                "aiGap": round2(deep_ai.value - ai_ai.value),
            }),
        );
        obj.insert("start".into(), summarize_start(start, p));
        obj.insert("desc".into(), json!(describe(start, p, &names)));
        obj.insert("ai".into(), ai_side);
        obj.insert("deep".into(), deep_side);
        obj.insert("beam".into(), beam);
        obj.insert("sec".into(), round2(t0.elapsed().as_secs_f64()));
        rows.push(row);
    }
    rows.push(json!({
        "g": g, "game": true, "decks": names, "winner": end.winner,
        "positions": starts.len(), "deep": cfg.deep_text,
        "actions": actions.iter().map(action_value).collect::<Vec<_>>(),
    }));
    Ok(rows)
}

/// (名前, 値) の列
pub(crate) type Flags = Vec<(String, String)>;

/// 引数を (名前, 値) の列と、それ以外にする。--名前 値 の形だけ
pub(crate) fn parse_flags(argv: &[String]) -> Result<(Flags, Vec<String>), String> {
    let mut flags = Vec::new();
    let mut rest = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let k = &argv[i];
        if let Some(name) = k.strip_prefix("--") {
            let v = argv
                .get(i + 1)
                .ok_or_else(|| format!("{k} の値がありません"))?;
            flags.push((name.to_string(), v.clone()));
            i += 2;
        } else {
            rest.push(k.clone());
            i += 1;
        }
    }
    Ok((flags, rest))
}

pub(crate) fn flag<'a>(flags: &'a [(String, String)], k: &str) -> Option<&'a str> {
    flags
        .iter()
        .rev()
        .find(|(n, _)| n == k)
        .map(|(_, v)| v.as_str())
}

pub(crate) fn num_flag(flags: &[(String, String)], k: &str, def: u32) -> Result<u32, String> {
    match flag(flags, k) {
        None => Ok(def),
        Some(v) => v
            .parse::<u32>()
            .map_err(|_| format!("--{k} は 0 以上の整数: {v}")),
    }
}

pub(crate) fn check_flags(flags: &[(String, String)], known: &[&str]) -> Result<(), String> {
    for (k, _) in flags {
        if !known.contains(&k.as_str()) {
            return Err(format!("不明な引数: --{k}"));
        }
    }
    Ok(())
}

/// JSON Lines を読む。最後の行が書きかけ（クラウドの作業フォルダの写しが書いている途中を写したもの等）なら、その行だけ飛ばす
pub(crate) fn read_rows(path: &str) -> Result<Vec<Value>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path} を読めません: {e}"))?;
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let mut rows = Vec::with_capacity(lines.len());
    for (n, l) in lines.iter().enumerate() {
        match serde_json::from_str(l) {
            Ok(v) => rows.push(v),
            Err(_) if n + 1 == lines.len() && !text.ends_with('\n') => {
                eprintln!("注意: {path} の最後の行は書きかけなので飛ばします");
            }
            Err(e) => return Err(format!("{path} の {} 行目: {e}", n + 1)),
        }
    }
    Ok(rows)
}

/// ファイルが空か、改行で終わっているか（書きかけの行が無いか）
pub(crate) fn ends_cleanly(path: &str) -> bool {
    std::fs::read(path).map_or(true, |b| b.is_empty() || b.ends_with(b"\n"))
}

pub(crate) fn open_append(path: &str) -> Result<std::fs::File, String> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("{path} に書けません: {e}"))
}

/// svwb deep-gap play
fn play(argv: &[String]) -> Result<(), String> {
    let (flags, rest) = parse_flags(argv)?;
    if !rest.is_empty() {
        return Err(format!("不明な引数: {}", rest.join(" ")));
    }
    check_flags(
        &flags,
        &["out", "games", "start", "deep", "k", "evalSeeds", "turns"],
    )?;
    let out = flag(&flags, "out").ok_or("--out を渡してください")?;
    let games = num_flag(&flags, "games", 100)?;
    let start = num_flag(&flags, "start", 0)?;
    let deep_text = flag(&flags, "deep").unwrap_or(DEEP_DEFAULT).to_string();
    let cfg = PlayConfig {
        deep: compare_options(&deep_text)?,
        deep_text,
        k: num_flag(&flags, "k", 4)?.max(1),
        eval_seeds: num_flag(&flags, "evalSeeds", 48)?.max(1),
        turns: match flag(&flags, "turns") {
            Some(v) => parse_range(v)?,
            None => (1, 30),
        },
    };
    // 済んだ試合（試合の行があるもの）。試合の行の無い局面の行は消して書き直す
    let mut done: HashSet<u64> = HashSet::new();
    if std::path::Path::new(out).exists() {
        let rows = read_rows(out)?;
        for v in &rows {
            if v["game"] == json!(true) {
                if v["deep"].as_str() != Some(cfg.deep_text.as_str()) {
                    return Err(format!(
                        "{out} は別の深い読みの設定（{}）で作ったものです",
                        v["deep"]
                    ));
                }
                done.insert(v["g"].as_u64().unwrap_or(u64::MAX));
            }
        }
        let keep: Vec<&Value> = rows
            .iter()
            .filter(|v| done.contains(&v["g"].as_u64().unwrap_or(u64::MAX)))
            .collect();
        if keep.len() != rows.len() || !ends_cleanly(out) {
            let text: String = keep.iter().map(|v| format!("{v}\n")).collect();
            std::fs::write(out, text).map_err(|e| format!("{out} に書けません: {e}"))?;
            eprintln!(
                "途中で止めた試合の局面の行を {} 行消しました",
                rows.len() - keep.len()
            );
        }
    }
    let items: Vec<u32> = (start..start + games)
        .filter(|g| !done.contains(&(*g as u64)))
        .collect();
    println!(
        "試合 {}〜{}（済み {}、残り {}）、深い読み {}、決定化 {} 通り、深い読みの点数の引き直し {}、自分のターン {}〜{}",
        start,
        start + games.max(1) - 1,
        games as usize - items.len(),
        items.len(),
        cfg.deep_text,
        cfg.k,
        cfg.eval_seeds,
        cfg.turns.0,
        cfg.turns.1
    );
    let mut file = open_append(out)?;
    let t0 = Instant::now();
    let (mut positions, mut differ) = (0usize, 0usize);
    let results = parallel_map(
        &items,
        |&g, _| {
            catch_unwind(AssertUnwindSafe(|| play_game(g, &cfg)))
                .unwrap_or_else(|_| Err("途中で止まりました（panic）".into()))
                .map_err(|e| format!("試合 {g}: {e}"))
        },
        |n, total, r, _| {
            match r {
                Ok(rows) => {
                    for v in rows {
                        if v["game"] != json!(true) {
                            positions += 1;
                            differ += (v["same"] == json!(false)) as usize;
                        }
                    }
                    let text: String = rows.iter().map(|v| format!("{v}\n")).collect();
                    let _ = file.write_all(text.as_bytes());
                }
                Err(e) => eprintln!("{e}"),
            }
            let sec = t0.elapsed().as_secs_f64();
            eprintln!(
                "試合 {n}/{total}（局面 {positions}、食い違い {differ}。{} 秒、残り約 {} 分）",
                fixed(sec, 0),
                fixed(sec / n as f64 * (total - n) as f64 / 60.0, 0)
            );
        },
    );
    let errors = results.iter().filter(|r| r.is_err()).count();
    println!(
        "完了: 試合 {}（失敗 {errors}）、局面 {positions}、食い違い {differ}、{} 秒",
        results.len(),
        fixed(t0.elapsed().as_secs_f64(), 0)
    );
    Ok(())
}

/// play の結果（試合の行と、局面の行）
struct GapData {
    games: HashMap<u64, Value>,
    rows: Vec<Value>,
}

fn read_gap(paths: &[String]) -> Result<GapData, String> {
    let mut games = HashMap::new();
    let mut rows = Vec::new();
    for p in paths {
        for v in read_rows(p)? {
            if v["game"] == json!(true) {
                games.insert(v["g"].as_u64().unwrap_or(u64::MAX), v);
            } else {
                rows.push(v);
            }
        }
    }
    // 試合の行のある試合の局面だけ（途中で止めた試合を除く）。同じ局面は最後の行
    let mut seen: HashMap<(u64, u64), usize> = HashMap::new();
    let mut out: Vec<Value> = Vec::new();
    for v in rows {
        let g = v["g"].as_u64().unwrap_or(u64::MAX);
        if !games.contains_key(&g) {
            continue;
        }
        let key = (g, v["i"].as_u64().unwrap_or(u64::MAX));
        match seen.get(&key) {
            Some(&k) => out[k] = v,
            None => {
                seen.insert(key, out.len());
                out.push(v);
            }
        }
    }
    Ok(GapData { games, rows: out })
}

fn pos_key(v: &Value) -> (u64, u64) {
    (
        v["g"].as_u64().unwrap_or(u64::MAX),
        v["i"].as_u64().unwrap_or(u64::MAX),
    )
}

/// 局面の行 v（試合 game の i 手目）の始めの局面
fn rebuild(game: &Value, v: &Value) -> Result<GameState, String> {
    let g = game["g"].as_u64().ok_or("g がありません")? as u32;
    let (mut s, _, _) = game_start(g);
    let actions = actions_of(&game["actions"])?;
    let i = v["i"].as_u64().ok_or("i がありません")? as usize;
    for a in actions
        .get(..i)
        .ok_or("手の番号が試合の長さを超えています")?
    {
        s = apply_legal(&s, a);
    }
    let p = v["p"].as_u64().ok_or("p がありません")? as usize;
    if s.active != p || !is_start_of_turn(&s) {
        return Err(
            "記録の局面が自分のターンの最初ではありません（エンジンか AI が変わった）".into(),
        );
    }
    Ok(s)
}

#[cfg(test)]
fn apply_all(s: &GameState, actions: &[Action]) -> GameState {
    let mut t = s.clone();
    for a in actions {
        t = apply_legal(&t, a);
    }
    t
}

/// ターン末 end（p のターン終了の前）からターンを終え、今の AI どうしで最後まで打って p が勝ったか（途中で止まれば None）
pub(crate) fn finish(end: &GameState, p: PlayerIndex, seed: u32) -> Option<bool> {
    if end.phase == Phase::Ended {
        return Some(end.winner == Some(p));
    }
    catch_unwind(AssertUnwindSafe(|| {
        let mut a0 = SearchAgent::new(SearchOptions::default());
        let mut a1 = SearchAgent::new(SearchOptions::default());
        let mut rng = Rng::new(seed);
        let mut s = apply_legal(end, &Action::EndTurn);
        for _ in 0..10000 {
            if s.phase == Phase::Ended {
                return Some(s.winner == Some(p));
            }
            let legal = legal_actions(&s);
            let a = if acting_player(&s) == 0 {
                a0.choose_action(&s, &legal, &mut rng)
            } else {
                a1.choose_action(&s, &legal, &mut rng)
            };
            s = apply_legal(&s, &a);
        }
        None
    }))
    .unwrap_or(None)
}

/// 局面 start（p の自分のターンの最初）から、決定化 m 通りそれぞれで今の AI と深い読みにターンを打たせ、続きを今の AI どうしで最後まで打った
/// p の勝ち負け（今の AI の側、深い読みの側）と、両方が同じターン末になった回数。r 通り目は両方とも同じ決定化・同じ乱数
#[allow(clippy::type_complexity)]
fn rollouts(
    start: &GameState,
    p: PlayerIndex,
    deep: &SearchOptions,
    m: u32,
    seed: u32,
) -> (Vec<Option<bool>>, Vec<Option<bool>>, u32) {
    let (mut ai, mut dp, mut same) = (Vec::new(), Vec::new(), 0);
    for r in 0..m {
        let det = determinize(start, p, &mut Rng::new(mix(seed, 40_000 + r)), false);
        let a = play_turn(&det, p, &SearchOptions::default(), mix(seed, 41_000 + r));
        let d = play_turn(&det, p, deep, mix(seed, 42_000 + r));
        let (Ok((_, a_end)), Ok((_, d_end))) = (a, d) else {
            ai.push(None);
            dp.push(None);
            continue;
        };
        let cont = mix(seed, 50_000 + r);
        let wa = finish(&a_end, p, cont);
        if same_end(&a_end, &d_end) {
            same += 1;
            ai.push(wa);
            dp.push(wa);
            continue;
        }
        ai.push(wa);
        dp.push(finish(&d_end, p, cont));
    }
    (ai, dp, same)
}

/// 差で並べるときの値（決定化 k 通りでの勝率の差の平均）
fn gap_win(v: &Value) -> f64 {
    v["gapWin"].as_f64().unwrap_or(f64::NEG_INFINITY)
}

/// svwb deep-gap rollout
fn rollout(argv: &[String]) -> Result<(), String> {
    let (flags, rest) = parse_flags(argv)?;
    if !rest.is_empty() {
        return Err(format!("不明な引数: {}", rest.join(" ")));
    }
    check_flags(&flags, &["in", "out", "top", "random", "seed", "m"])?;
    let inputs: Vec<String> = flag(&flags, "in")
        .ok_or("--in を渡してください")?
        .split(',')
        .map(|s| s.to_string())
        .collect();
    let out = flag(&flags, "out").ok_or("--out を渡してください")?;
    let top = num_flag(&flags, "top", 200)? as usize;
    let random = num_flag(&flags, "random", 200)? as usize;
    let seed = num_flag(&flags, "seed", 1)?;
    let m = num_flag(&flags, "m", 48)?.max(1);
    let data = read_gap(&inputs)?;
    let mut differ: Vec<&Value> = data
        .rows
        .iter()
        .filter(|v| v["same"] == json!(false))
        .collect();
    // 差の大きい順（同じなら試合・手の番号の順）
    differ.sort_by(|a, b| {
        gap_win(b)
            .partial_cmp(&gap_win(a))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(pos_key(a).cmp(&pos_key(b)))
    });
    let mut picked: Vec<(&Value, &str)> = differ.iter().take(top).map(|v| (*v, "top")).collect();
    let mut others: Vec<&Value> = differ.iter().skip(top).copied().collect();
    others.sort_by_key(|v| pos_key(v));
    Rng::new(seed).shuffle(&mut others);
    picked.extend(others.into_iter().take(random).map(|v| (v, "random")));
    let mut done: HashSet<(u64, u64)> = HashSet::new();
    if std::path::Path::new(out).exists() {
        let rows = read_rows(out)?;
        for v in &rows {
            done.insert(pos_key(v));
        }
        if !ends_cleanly(out) {
            let text: String = rows.iter().map(|v| format!("{v}\n")).collect();
            std::fs::write(out, text).map_err(|e| format!("{out} に書けません: {e}"))?;
        }
    }
    let items: Vec<(&Value, &str)> = picked
        .into_iter()
        .filter(|(v, _)| !done.contains(&pos_key(v)))
        .collect();
    // 深い読みの設定は play のときのもの（試合の行に書いてある）
    let mut deep_by_text: HashMap<String, SearchOptions> = HashMap::new();
    for game in data.games.values() {
        let text = game["deep"].as_str().unwrap_or(DEEP_DEFAULT).to_string();
        if let std::collections::hash_map::Entry::Vacant(e) = deep_by_text.entry(text) {
            let o = compare_options(e.key())?;
            e.insert(o);
        }
    }
    println!(
        "食い違った局面 {}、上位 {top}・乱数 {random}（シード {seed}）のうち残り {}（済み {}）、M {m}",
        differ.len(),
        items.len(),
        done.len()
    );
    let mut file = open_append(out)?;
    let t0 = Instant::now();
    let results = parallel_map(
        &items,
        |(v, sel), _| -> Result<Value, String> {
            let t = Instant::now();
            let (g, i) = pos_key(v);
            let game = data
                .games
                .get(&g)
                .ok_or_else(|| format!("試合 {g} の行がありません"))?;
            let deep = &deep_by_text[game["deep"].as_str().unwrap_or(DEEP_DEFAULT)];
            let start = rebuild(game, v).map_err(|e| format!("試合 {g} の {i} 手目: {e}"))?;
            let p = v["p"].as_u64().unwrap_or(0) as usize;
            let (_, _, game_seed) = game_start(g as u32);
            let pos_seed = mix(game_seed, 7000 + i as u32);
            let (ai, dp, same) =
                catch_unwind(AssertUnwindSafe(|| rollouts(&start, p, deep, m, pos_seed)))
                    .map_err(|_| format!("試合 {g} の {i} 手目: 途中で止まりました（panic）"))?;
            Ok(json!({
                "g": g, "i": i, "sel": sel, "m": m, "same": same,
                "ai": ai, "deep": dp,
                "sec": round2(t.elapsed().as_secs_f64()),
            }))
        },
        |n, total, r, _| {
            match r {
                Ok(v) => {
                    let _ = writeln!(file, "{v}");
                }
                Err(e) => eprintln!("{e}"),
            }
            if n % 5 == 0 || n == total {
                let sec = t0.elapsed().as_secs_f64();
                eprintln!(
                    "局面 {n}/{total}（{} 秒、残り約 {} 分）",
                    fixed(sec, 0),
                    fixed(sec / n as f64 * (total - n) as f64 / 60.0, 0)
                );
            }
        },
    );
    let errors = results.iter().filter(|r| r.is_err()).count();
    println!(
        "完了: 局面 {}（失敗 {errors}）、{} 秒",
        results.len(),
        fixed(t0.elapsed().as_secs_f64(), 0)
    );
    Ok(())
}

/// 局面の差の内訳（今の AI が深い読みのターンを選ばなかったのは、どの段階か）
fn category(v: &Value) -> &'static str {
    if v["ai"]["ended"] == json!(true) || v["deep"]["ended"] == json!(true) {
        return "そのターンで試合が終わった";
    }
    if v["kSame"].as_u64().unwrap_or(0) > 0 {
        return "引きを並べ直すと、今の AI も深い読みと同じターンを打つことがある";
    }
    let beam = &v["beam"];
    if beam["deepAbove"] == json!(true) {
        return "今の AI のビームが届かない（深い読みのターン末の点数が候補の最善より高い）";
    }
    let top = beam["rescoreTop"].as_u64().unwrap_or(4);
    if beam["deepRank"].as_u64().is_some_and(|r| r >= top) {
        return "ターン末の点数で今の AI の読み直しの候補から外れた";
    }
    if v["real"]["aiGap"].as_f64().is_some_and(|x| x > 0.0) {
        return "今の AI の点数でも深い読みのターンが上（選ぶときのぶれ）";
    }
    "今の AI の点数では今の AI のターンが上（引き直しを増やすと逆転）"
}

/// 食い違った局面の、相手のリーサル（深い読みの引き直しで相手のターンを読むと負けになる割合）の分け方
fn loss_kind(v: &Value) -> &'static str {
    match (v["loss"]["ai"].as_f64(), v["loss"]["deep"].as_f64()) {
        (Some(a), Some(d)) if a > d + 1e-9 => "今の AI のターン末のほうが相手のリーサルが多い",
        (Some(a), Some(d)) if d > a + 1e-9 => "深い読みのターン末のほうが相手のリーサルが多い",
        (Some(a), Some(_)) if a > 0.0 => "同じだけある",
        (Some(_), Some(_)) => "どちらにも無い",
        _ => "測っていない（決定化が全部同じターン末か、古い出力）",
    }
}

/// 最後まで打った勝率の差（深い読み − 今の AI、% の数）。どちらかが 1 回も打てなければ None
fn rollout_diff(r: &Value) -> Option<f64> {
    Some((win_rate(&r["deep"])? - win_rate(&r["ai"])?) * 100.0)
}

fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let k = ((sorted.len() - 1) as f64 * q).round() as usize;
    sorted[k]
}

/// 相関係数
fn correlation(xs: &[(f64, f64)]) -> f64 {
    let n = xs.len() as f64;
    if xs.len() < 3 {
        return f64::NAN;
    }
    let mx = xs.iter().map(|x| x.0).sum::<f64>() / n;
    let my = xs.iter().map(|x| x.1).sum::<f64>() / n;
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for &(x, y) in xs {
        sxy += (x - mx) * (y - my);
        sxx += (x - mx).powi(2);
        syy += (y - my).powi(2);
    }
    sxy / (sxx * syy).sqrt()
}

/// 勝率の差（% の数）の区間の名前（並べ替え用の頭 3 文字つき）
fn bin_of(x: f64) -> &'static str {
    if x < 0.0 {
        "a: 0 未満"
    } else if x < 1.0 {
        "b: 0〜1"
    } else if x < 3.0 {
        "c: 1〜3"
    } else if x < 6.0 {
        "d: 3〜6"
    } else if x < 10.0 {
        "e: 6〜10"
    } else {
        "f: 10 以上"
    }
}

fn pm(m: f64, se: f64, f: usize) -> String {
    if m.is_nan() {
        "-".into()
    } else if se.is_nan() {
        fixed(m, f)
    } else {
        format!("{} ± {}", fixed(m, f), fixed(se, f))
    }
}

/// svwb deep-gap report
fn report(argv: &[String]) -> Result<(), String> {
    let (flags, files) = parse_flags(argv)?;
    check_flags(
        &flags,
        &["rollouts", "top", "only", "skipDecks", "sort", "listOnly"],
    )?;
    let top = num_flag(&flags, "top", 30)? as usize;
    let only = flag(&flags, "only");
    let skip_decks: Vec<&str> = flag(&flags, "skipDecks")
        .map(|t| t.split(',').filter(|x| !x.is_empty()).collect())
        .unwrap_or_default();
    let sort = flag(&flags, "sort");
    if !matches!(sort, None | Some("gap") | Some("rollout")) {
        return Err("--sort は gap か rollout".into());
    }
    let list_only = flag(&flags, "listOnly").is_some();
    if files.is_empty() {
        return Err("play の結果（jsonl）を 1 つ以上渡してください".into());
    }
    let data = read_gap(&files)?;
    let mut rolls: HashMap<(u64, u64), Value> = HashMap::new();
    if let Some(list) = flag(&flags, "rollouts") {
        for f in list.split(',') {
            for v in read_rows(f)? {
                rolls.insert(pos_key(&v), v);
            }
        }
    }
    let rows = &data.rows;
    let differ: Vec<&Value> = rows.iter().filter(|v| v["same"] == json!(false)).collect();
    let n_games = data.games.len().max(1);
    let deep_texts: HashSet<&str> = data
        .games
        .values()
        .filter_map(|g| g["deep"].as_str())
        .collect();
    if !list_only {
        println!("# 今の AI の手と深い読みの手の食い違い（deep-gap）\n");
        println!(
            "- 深い読みの設定: {}",
            deep_texts.into_iter().collect::<Vec<_>>().join(" / ")
        );
        println!(
        "- 試合 {}、自分のターンの最初の局面 {}、試合のターンと深い読みのターンのターン末が食い違った局面 {}（{}）、1 試合あたり {}",
        data.games.len(),
        rows.len(),
        differ.len(),
        pct(differ.len() as f64 / rows.len().max(1) as f64),
        fixed(differ.len() as f64 / n_games as f64, 1)
    );
        let gaps: Vec<f64> = differ.iter().map(|v| gap_win(v)).collect();
        let mut sorted = gaps.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let (gm, gs) = mean_se(&gaps);
        println!(
        "- 差（引きを並べ直して両方に打たせ、深い読みの点数で見た勝率の差。深い読み − 今の AI、% の数）: 平均 {}、10%点 {}・25%点 {}・中央 {}・75%点 {}・90%点 {}・99%点 {}",
        pm(gm, gs, 2),
        fixed(quantile(&sorted, 0.1), 2),
        fixed(quantile(&sorted, 0.25), 2),
        fixed(quantile(&sorted, 0.5), 2),
        fixed(quantile(&sorted, 0.75), 2),
        fixed(quantile(&sorted, 0.9), 2),
        fixed(quantile(&sorted, 0.99), 2)
    );
        let share = |th: f64| {
            pct(gaps.iter().filter(|&&x| x >= th).count() as f64 / differ.len().max(1) as f64)
        };
        println!(
            "- 差が 1 以上の局面 {}・3 以上 {}・6 以上 {}・10 以上 {}（食い違った局面のうち）",
            share(1.0),
            share(3.0),
            share(6.0),
            share(10.0)
        );
        let ks: u64 = differ.iter().map(|v| v["k"].as_u64().unwrap_or(0)).sum();
        let k_same: u64 = differ
            .iter()
            .map(|v| v["kSame"].as_u64().unwrap_or(0))
            .sum();
        let hidden = differ
            .iter()
            .filter(|v| v["ai"]["hidden"] == json!(true) || v["deep"]["hidden"] == json!(true))
            .count();
        let real: Vec<(f64, f64)> = differ
            .iter()
            .filter_map(|v| Some((v["real"]["gapWin"].as_f64()?, gap_win(v))))
            .filter(|x| x.0.abs() < 50.0)
            .collect();
        println!(
        "- 引きを並べ直した {} 回のうち、今の AI と深い読みが同じターン末になった回 {}。試合のターンか深い読みのターンでカードを引いた・乱数を使った局面 {}",
        ks,
        pct(k_same as f64 / ks.max(1) as f64),
        pct(hidden as f64 / differ.len().max(1) as f64)
    );
        let losses: Vec<(f64, f64)> = differ
            .iter()
            .filter_map(|v| Some((v["loss"]["ai"].as_f64()?, v["loss"]["deep"].as_f64()?)))
            .collect();
        if !losses.is_empty() {
            let n = losses.len() as f64;
            println!(
            "- 相手のターンを読むと相手のリーサルになる引き直しの割合（深い読みの点数の引き直し、食い違った決定化の平均）: 今の AI のターン末 {}・深い読みのターン末 {}。今の AI のほうが多い局面 {}・深い読みのほうが多い局面 {}",
            pct(losses.iter().map(|x| x.0).sum::<f64>() / n),
            pct(losses.iter().map(|x| x.1).sum::<f64>() / n),
            pct(losses.iter().filter(|x| x.0 > x.1 + 1e-9).count() as f64 / n),
            pct(losses.iter().filter(|x| x.1 > x.0 + 1e-9).count() as f64 / n)
        );
        }
        println!(
        "- 実際の試合のターン末どうしの差（後から見た運を含む）の平均 {}、引きを並べ直した差との相関 {}（どちらかのターンで試合が終わった局面を除く）\n",
        fixed(mean_se(&real.iter().map(|x| x.0).collect::<Vec<_>>()).0, 2),
        fixed(correlation(&real), 2)
    );
        // 表（行の名前ごとの局面の数・食い違い・差の平均・最後まで打った差）
        let table = |title: &str, key: &dyn Fn(&Value) -> String, all: bool| {
            let mut groups: BTreeMap<String, (usize, Vec<f64>, Vec<f64>)> = BTreeMap::new();
            for v in rows {
                let differs = v["same"] == json!(false);
                if !all && !differs {
                    continue;
                }
                let e = groups.entry(key(v)).or_default();
                e.0 += 1;
                if differs {
                    e.1.push(gap_win(v));
                    if let Some(d) = rolls.get(&pos_key(v)).and_then(rollout_diff) {
                        e.2.push(d);
                    }
                }
            }
            println!("## {title}\n");
            println!(
            "| | 局面 | 食い違い | 差の平均 | 差の合計に占める割合 | 最後まで打った局面 | 最後まで打った差の平均 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
        );
            let total: f64 = gaps.iter().filter(|x| x.is_finite()).sum();
            for (k, (n, gs, rs)) in &groups {
                let (m, s) = mean_se(gs);
                let (rm, rse) = mean_se(rs);
                let sum: f64 = gs.iter().filter(|x| x.is_finite()).sum();
                println!(
                    "| {k} | {n} | {} | {} | {} | {} | {} |",
                    if all {
                        pct(gs.len() as f64 / *n as f64)
                    } else {
                        gs.len().to_string()
                    },
                    pm(m, s, 2),
                    if total.abs() > 1e-9 {
                        format!("{}%", fixed(sum / total * 100.0, 0))
                    } else {
                        "-".into()
                    },
                    rs.len(),
                    pm(rm, rse, 1)
                );
            }
            println!();
        };
        table(
            "差の内訳（今の AI が深い読みのターンを選ばなかったのは、どの段階か）",
            &|v| category(v).to_string(),
            false,
        );
        table(
            "相手のリーサル（深い読みの引き直しで、相手のターンを読むと負けになる割合）",
            &|v| loss_kind(v).to_string(),
            false,
        );
        table(
            "デッキ別（手番の側）",
            &|v| v["deck"].as_str().unwrap_or("").to_string(),
            true,
        );
        table(
            "自分のターン別",
            &|v| format!("{:02}", v["ownTurn"].as_i64().unwrap_or(-1)),
            true,
        );
        // 最後まで打って確かめた局面
        if !rolls.is_empty() {
            println!(
                "## 最後まで打って確かめる（今の AI どうしで最後まで打った勝率の差。% の数）\n"
            );
            for sel in ["random", "top"] {
                let pairs: Vec<(f64, f64)> = differ
                    .iter()
                    .filter_map(|v| {
                        let r = rolls.get(&pos_key(v))?;
                        if r["sel"].as_str() != Some(sel) {
                            return None;
                        }
                        Some((gap_win(v), rollout_diff(r)?))
                    })
                    .collect();
                if pairs.is_empty() {
                    continue;
                }
                let m = rolls
                    .values()
                    .find(|r| r["sel"].as_str() == Some(sel))
                    .and_then(|r| r["m"].as_u64())
                    .unwrap_or(0);
                let preds: Vec<f64> = pairs.iter().map(|x| x.0).collect();
                let acts: Vec<f64> = pairs.iter().map(|x| x.1).collect();
                let (pmn, ps) = mean_se(&preds);
                let (am, ase) = mean_se(&acts);
                println!(
                    "### {}（{} 局面、1 局面 {m} 通りずつ）\n",
                    if sel == "random" {
                        "食い違った局面から乱数で選んだもの（差の大きさで選んでいない）"
                    } else {
                        "差の大きい順に選んだもの"
                    },
                    pairs.len()
                );
                println!(
                    "- 差（深い読みの点数）{}、最後まで打った差 {}、相関 {}",
                    pm(pmn, ps, 2),
                    pm(am, ase, 2),
                    fixed(correlation(&pairs), 2)
                );
                if sel == "random" {
                    let per_game = differ.len() as f64 / n_games as f64;
                    println!(
                    "- 1 試合あたりの目安（食い違い {} 局面 × 最後まで打った差の平均）: {} ポイント。そのターンだけ深い読みのとおりに打てたら、の足し合わせ（続きは今の AI。局面どうしの重なりは無視）",
                    fixed(per_game, 1),
                    pm(am * per_game, ase * per_game, 1)
                );
                }
                let mut groups: BTreeMap<&str, Vec<(f64, f64)>> = BTreeMap::new();
                for &(x, y) in &pairs {
                    groups.entry(bin_of(x)).or_default().push((x, y));
                }
                println!("\n| 差（深い読みの点数） | 局面 | 差の平均 | 最後まで打った差の平均 | 深い読みのほうが勝ちの多かった局面 |\n| --- | ---: | ---: | ---: | ---: |");
                for (k, xs) in &groups {
                    let p: Vec<f64> = xs.iter().map(|x| x.0).collect();
                    let a: Vec<f64> = xs.iter().map(|x| x.1).collect();
                    let wins = a.iter().filter(|&&y| y > 0.0).count();
                    let losses = a.iter().filter(|&&y| y < 0.0).count();
                    let (am, ase) = mean_se(&a);
                    println!(
                        "| {} | {} | {} | {} | {} 勝 {} 敗 |",
                        &k[3..],
                        xs.len(),
                        fixed(mean_se(&p).0, 2),
                        pm(am, ase, 1),
                        wins,
                        losses
                    );
                }
                println!();
            }
        }
    } // !list_only
      // 差の大きい局面
    let mut ranked: Vec<&&Value> = differ
        .iter()
        .filter(|v| only.is_none_or(|o| category(v).contains(o)))
        .filter(|v| !skip_decks.contains(&v["deck"].as_str().unwrap_or("")))
        .collect();
    let by_roll = match sort {
        Some(k) => k == "rollout",
        None => !rolls.is_empty(),
    };
    let key = |v: &Value| -> f64 {
        if by_roll {
            rolls
                .get(&pos_key(v))
                .and_then(rollout_diff)
                .unwrap_or(f64::NEG_INFINITY)
        } else {
            gap_win(v)
        }
    };
    ranked.sort_by(|a, b| {
        let deck = |v: &Value| v["deck"].as_str().unwrap_or("").to_string();
        let by_deck = if list_only {
            deck(a).cmp(&deck(b))
        } else {
            std::cmp::Ordering::Equal
        };
        by_deck
            .then(
                key(b)
                    .partial_cmp(&key(a))
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then(pos_key(a).cmp(&pos_key(b)))
    });
    let sort_name = if by_roll {
        "最後まで打った勝率の差"
    } else {
        "差"
    };
    if list_only {
        println!(
            "# 今の AI の手と深い読みの手の食い違い（deep-gap）の局面{}\n",
            only.map(|o| format!("（内訳: {o}）")).unwrap_or_default()
        );
        if !skip_decks.is_empty() {
            println!("- 除いたデッキ（手番の側）: {}", skip_decks.join("、"));
        }
        println!(
            "- デッキごとに、{sort_name}の大きい順。差は、引きを並べ直して両方に打たせ、深い読みの点数で見た勝率の差（深い読み − 今の AI、% の数）\n"
        );
        let mut counts: BTreeMap<&str, (usize, usize, Vec<f64>)> = BTreeMap::new();
        for v in &ranked {
            let e = counts.entry(v["deck"].as_str().unwrap_or("")).or_default();
            e.0 += 1;
            if gap_win(v) >= 3.0 {
                e.1 += 1;
            }
            e.2.push(gap_win(v));
        }
        println!("| デッキ | 局面 | 差が 3 以上 | 差の平均 |\n| --- | ---: | ---: | ---: |");
        for (d, (n, big, gs)) in &counts {
            let (m, se) = mean_se(gs);
            println!("| {d} | {n} | {big} | {} |", pm(m, se, 2));
        }
        println!();
    } else {
        println!("## 差の大きい局面（{sort_name}の上位 {top}）\n");
    }
    // 使ったものの違い（深い読みだけ、試合のターンだけ。始めの局面を試合の手の列から作り直す）
    let diff_of = |v: &Value| -> Option<(Vec<String>, Vec<String>)> {
        let game = data.games.get(&pos_key(v).0)?;
        let start = rebuild(game, v).ok()?;
        let ai = used_of(&start, &actions_of(&v["ai"]["actions"]).ok()?);
        let deep = used_of(&start, &actions_of(&v["deep"]["actions"]).ok()?);
        Some((multiset_minus(&deep, &ai), multiset_minus(&ai, &deep)))
    };
    let roll_diff_text = |v: &Value| {
        rolls
            .get(&pos_key(v))
            .and_then(rollout_diff)
            .map(|d| fixed(d, 1))
            .unwrap_or_else(|| "-".into())
    };
    let mut last_deck = String::new();
    for v in ranked.iter().take(if list_only { usize::MAX } else { top }) {
        let deck = v["deck"].as_str().unwrap_or("");
        if list_only && deck != last_deck {
            println!("## {deck}\n");
            println!("| 局面 | 相手 | 差 | 最後まで打った差 | 深い読みだけ | 試合のターンだけ |\n| --- | --- | ---: | ---: | --- | --- |");
            for w in ranked.iter().filter(|w| w["deck"].as_str() == Some(deck)) {
                let (d, a) = diff_of(w).unwrap_or_default();
                println!(
                    "| 試合 {} の {} 手目（{} ターン目） | {} | {} | {} | {} | {} |",
                    w["g"],
                    w["i"],
                    w["ownTurn"],
                    w["oppDeck"].as_str().unwrap_or(""),
                    fixed(gap_win(w), 1),
                    roll_diff_text(w),
                    list_or_none(d),
                    list_or_none(a)
                );
            }
            println!();
            last_deck = deck.to_string();
        }
        let steps = |s: &Value| {
            s["steps"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join("、")
                })
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| "（何もせずターン終了）".into())
        };
        let roll_text = match rolls.get(&pos_key(v)) {
            Some(r) => format!(
                "。最後まで打った勝率は深い読み {}・今の AI {}（{} 通り、同じターン末 {} 通り）",
                pct(win_rate(&r["deep"]).unwrap_or(f64::NAN)),
                pct(win_rate(&r["ai"]).unwrap_or(f64::NAN)),
                r["m"],
                r["same"]
            ),
            None => String::new(),
        };
        println!(
            "### 試合 {} の {} 手目（{} vs {}、自分の {} ターン目）\n",
            v["g"],
            v["i"],
            deck,
            v["oppDeck"].as_str().unwrap_or(""),
            v["ownTurn"]
        );
        println!(
            "- 差 {}（{} 通り、同じターン末 {} 通り）{roll_text}",
            pm(gap_win(v), v["gapWinSe"].as_f64().unwrap_or(f64::NAN), 2),
            v["k"],
            v["kSame"]
        );
        println!(
            "- 実際の試合のターン末どうし: 深い読みの点数で {}、今の AI の点数で {}（カードを引いた・乱数: 試合 {}・深い読み {}）",
            v["real"]["gapWin"],
            v["real"]["aiGapWin"],
            v["ai"]["hidden"],
            v["deep"]["hidden"]
        );
        println!("- 内訳: {}", category(v));
        if let Some(desc) = v["desc"].as_array() {
            for line in desc {
                println!("- {}", line.as_str().unwrap_or(""));
            }
        }
        let loss_text = |s: &Value| match s["deepLoss"].as_f64() {
            Some(l) if l > 0.0 => format!("、相手のリーサル {}", pct(l)),
            _ => String::new(),
        };
        println!(
            "- **試合のターン**（深い読みの点数で勝率 {}%{}）: {}",
            v["ai"]["deepWin"],
            loss_text(&v["ai"]),
            steps(&v["ai"])
        );
        println!(
            "- **深い読みのターン**（勝率 {}%{}）: {}",
            v["deep"]["deepWin"],
            loss_text(&v["deep"]),
            steps(&v["deep"])
        );
        if let Some((d, a)) = diff_of(v) {
            println!(
                "- 違い: 深い読みだけ {}／試合のターンだけ {}",
                list_or_none(d),
                list_or_none(a)
            );
        }
        println!();
    }
    Ok(())
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let rest = argv.get(1..).unwrap_or(&[]);
    match argv.first().map(|s| s.as_str()) {
        Some("play") => play(rest),
        Some("rollout") => rollout(rest),
        Some("report") => report(rest),
        _ => Err(
            "使い方: svwb deep-gap play|rollout|report …（rust/engine/src/runner/deep_gap.rs の先頭）"
                .into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::super::compare_decks;
    use super::*;

    /// 軽い「深い読み」（ビームの幅を変えただけ）
    fn light_config() -> PlayConfig {
        let text = r#"{"beamWidth":16,"oppHandSamples":2}"#.to_string();
        PlayConfig {
            deep: compare_options(&text).unwrap(),
            deep_text: text,
            k: 2,
            eval_seeds: 2,
            turns: (1, 30),
        }
    }

    #[test]
    fn games_use_the_compare_decks() {
        let names: Vec<&str> = compare_decks().iter().map(|d| d.name.as_str()).collect();
        for g in 0..49 {
            let (_, n, _) = game_start(g);
            assert!(n.iter().all(|x| names.contains(&x.as_str())));
        }
    }

    #[test]
    fn play_game_rows_rebuild_and_roll_out() {
        let cfg = light_config();
        let g = 3;
        let rows = play_game(g, &cfg).unwrap();
        let game = rows.last().unwrap();
        assert_eq!(game["game"], json!(true));
        assert_eq!(game["deep"], json!(cfg.deep_text));
        let positions = &rows[..rows.len() - 1];
        assert_eq!(
            game["positions"].as_u64().unwrap() as usize,
            positions.len()
        );
        // 両方のプレイヤーの自分のターンが 1 ターン目から 1 つずつ
        for p in 0..2 {
            let turns: Vec<i64> = positions
                .iter()
                .filter(|v| v["p"] == json!(p))
                .map(|v| v["ownTurn"].as_i64().unwrap())
                .collect();
            assert!(turns.len() >= 3);
            assert_eq!(turns, (1..=turns.len() as i64).collect::<Vec<_>>());
        }
        let differ: Vec<&Value> = positions
            .iter()
            .filter(|v| v["same"] == json!(false))
            .collect();
        assert!(!differ.is_empty(), "軽い深い読みでも食い違う局面がある");
        let v = differ[0];
        assert_eq!(v["k"], json!(2));
        assert!(v["kSame"].as_u64().unwrap() <= 2);
        let start = rebuild(game, v).unwrap();
        let p = v["p"].as_u64().unwrap() as usize;
        assert_eq!(start.active, p);
        // 書いた手の列を打ち直すと、食い違ったターン末になり、深い読みの点数も同じ
        let ai_end = apply_all(&start, &actions_of(&v["ai"]["actions"]).unwrap());
        let deep_end = apply_all(&start, &actions_of(&v["deep"]["actions"]).unwrap());
        assert!(!same_end(&ai_end, &deep_end));
        let pos_seed = mix(g * 7 + 1, 1000 + v["i"].as_u64().unwrap() as u32);
        let seeds: Vec<u32> = (0..cfg.eval_seeds)
            .map(|k| mix(pos_seed, 10_000 + k))
            .collect();
        let deep_agent = SearchAgent::new(cfg.deep.clone());
        let sc = score(&deep_agent, &deep_end, p, &seeds);
        assert_eq!(round2(sc.value), v["deep"]["deepValue"]);
        assert_eq!(round2(sc.win), v["deep"]["deepWin"]);
        assert_eq!(round2(sc.loss), v["deep"]["deepLoss"]);
        // 勝率は引き直しごとの点数を勝率にしてからの平均。読み直した点数は引き直しごとの点数の平均
        let reads = deep_agent.read_values(&deep_end, p, &seeds);
        assert_eq!(reads.len(), seeds.len());
        let mean = reads.iter().sum::<f64>() / reads.len() as f64;
        assert!((mean - sc.read).abs() < 1e-9);
        assert!((deep_agent.read_value(&deep_end, p, &seeds) - sc.read).abs() < 1e-9);
        let m = deep_agent.opts.rescore_mix;
        let te = sc.turn_end.unwrap();
        let win = reads
            .iter()
            .map(|&r| win_pct((1.0 - m) * r + m * te))
            .sum::<f64>()
            / reads.len() as f64;
        assert!((win - sc.win).abs() < 1e-9);
        // 引きを並べ直した差も、同じシードなら同じ
        let pg = policy_gap(&start, p, &cfg, &deep_agent, pos_seed).unwrap();
        assert_eq!(round2(mean_se(&pg.wins).0), v["gapWin"]);
        assert_eq!(json!(pg.same), v["kSame"]);
        assert_eq!(pg.loss.len() as u32 + pg.same, cfg.k);
        // 最後まで打つ: m 回分、同じシードなら同じ結果
        let r1 = rollouts(&start, p, &cfg.deep, 2, 5);
        assert_eq!(r1.0.len(), 2);
        assert!(r1.0.iter().chain(&r1.1).all(|x| x.is_some()));
        assert_eq!(r1, rollouts(&start, p, &cfg.deep, 2, 5));
        // 試合の手の列を最後まで打つと、試合の勝者になる
        let (mut s, _, _) = game_start(g);
        for a in actions_of(&game["actions"]).unwrap() {
            s = apply_legal(&s, &a);
        }
        assert_eq!(s.phase, Phase::Ended);
        assert_eq!(json!(s.winner), game["winner"]);
    }

    #[test]
    fn categories_and_bins() {
        let v = json!({"ai": {"ended": false}, "deep": {"ended": false}, "kSame": 0,
            "beam": {"deepAbove": false, "deepRank": 5, "rescoreTop": 4}, "real": {"aiGap": 1.0}});
        assert_eq!(
            category(&v),
            "ターン末の点数で今の AI の読み直しの候補から外れた"
        );
        let mut w = v.clone();
        w["kSame"] = json!(1);
        assert!(category(&w).contains("同じターンを打つことがある"));
        assert_eq!(bin_of(-0.5), "a: 0 未満");
        assert_eq!(bin_of(12.0), "f: 10 以上");
        assert!((correlation(&[(0.0, 0.0), (1.0, 2.0), (2.0, 4.0)]) - 1.0).abs() < 1e-9);
        assert_eq!(pm(1.234, f64::NAN, 1), "1.2");
    }
}
