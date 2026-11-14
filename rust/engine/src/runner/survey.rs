//! 候補の打ち比べ調査（2026-11-11。審査の文書「AI の設計の審査と今後の方針」課題点 3「先にやること」、docs/survey.md）。
//!
//!   svwb survey run --out 結果.jsonl --games a-b [--rate 0.1] [--m 32] [--extra 4] [--confirm 96] [--flag 10] [--batch 8] [--decks <デッキ>,…|@<デッキの組>]
//!   svwb survey report 結果.jsonl… [--label 名前] [--no-ledger] [--top 20] [--states <フォルダ>]
//!
//! **run**: 今の既定の AI どうしの自己対戦（試合 g のデッキ・席・シードは `svwb ai-play`・`deep-gap` と同じ。`--decks` なら、並べたデッキで
//! compare と同じ組（n デッキなら試合番号 n² ごとに全部の組。先の席が A）、シードは同じ。デフォルトデッキと違うデッキのマリガンは compare と同じ）を打ち、
//! 両方の席の自分のターンの最初の局面から、試合番号と手の番号で決まる乱数で `--rate` の割合を無作為に選ぶ（差の大きさでは選ばない）。
//! 選んだ局面ごとに:
//! 1. 試合でその局面を考えたときと同じ乱数で今の AI に考えさせ（試合で打った手と同じ手を選ぶ。違えば行に `match: false`）、候補を作る。
//!    AI が読み直した候補（上位 4 と、drawSplit が足す引く手。AI はこの中から選ぶ）と、同じ決定化のビームの終局面から
//!    ターン末の点数の高い順に、使うカードの組（手札から出すカード・融合の素材）がそれまでの候補のどれとも違う並びを `--extra` 個
//!    （`SearchAgent::survey_plans`）
//! 2. 候補ごとに、同じ乱数で `--m` 回最後まで打つ（r 回目は、手番の側から見た決定化と AI の乱数がどの候補でも同じ）。
//!    候補は、AI がその並びを選んだものとして打つ: 最初の手を打ち、次の判断からは局面が予想どおりなら並びの続きを打つ
//!    （並びは最初の引く手・ランダムな手まで。その先と、並びを打ち終えた後は AI が考え直す）。続きは両方の席とも今の既定の AI
//! 3. 二段目（確かめ）: 一段目で、AI の選んだ候補との勝率の差が最も大きい候補の差が `--flag` ポイント以上なら、
//!    その候補と AI の選んだ候補だけを、一段目と重ならない乱数でさらに `--confirm` 回打つ。大きなミスの判定は二段目の回だけで行う
//!    （一段目で差の大きいものを選んだ偏りが入らない）
//!
//! 出力は JSON Lines。局面の行（局面の状態の JSON・候補・勝ち負け）と、試合の行（`"game": true`。自分のターンの最初の局面の数）。
//! `--batch` 試合ごとにまとめて書き、出力に既にある試合は飛ばす（同じ引数で再開できる。試合の行の無い局面の行は、再開のときに消す）。
//! 勝ち負けは 1 文字ずつ（`1` 勝ち・`0` 負け・`d` 引き分け・`x` 打てなかった・途中で止まった）。
//!
//! **report**: 決まり（docs/survey.md「決まり」。回す前に決めたもの）で、打ち比べで選び直す得（1 試合あたり）、大きなミスの回数、
//! デッキ・ターン・手の種類ごとの内訳、問題集に足す局面の候補を Markdown で出し、台帳に 1 行足す（`kind` は `survey`。`--no-ledger` で書かない）。
//! `--states` を渡すと、問題集に足す候補の局面を 1 つずつ状態の JSON で書く（`npm run misses -- add --state` に渡せる）。
//!
//! 実際の対戦の局面を入れる口は無い（自己対戦の局面だけを扱う。CLAUDE.md「ソフト打ち」）。

use super::compare::{compare_pair, deck_options};
use super::deck_compare::read_deck_list;
use super::deep_gap::{
    check_flags, describe, ends_cleanly, flag, multiset_minus, num_flag, open_append, parse_flags,
    read_rows, used_of,
};
use super::fixed;
use super::human_plan::{is_start_of_turn, mean_se, mix, parse_range, round2, step_text};
use super::ledger;
use super::parallel::{parallel_map, thread_count};
use crate::ai::determinize::determinize;
use crate::ai::exact_lethal::reset_exact_lethal_cache;
use crate::ai::lethal::reset_lethal;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::{seed_of, Rng};
use crate::data::{data, CardIdx, Deck};
use crate::game::{
    acting_player, apply_legal, create_game, is_legal, legal_actions, try_apply_action,
};
use crate::json::Json;
use crate::sim::{ai_game_setup, play_match, MatchRng};
use crate::state::{card, Action, GameState, Phase, PlayerIndex};
use crate::state_json::{action_from_json, action_to_json, state_from_json, state_to_json};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::time::Instant;

/// 局面を選ぶ乱数・局面ごとの乱数に混ぜる印（"SURV"）
const TAG: u32 = 0x5355_5256;
/// 大きなミス（と問題集に足す候補）の線: 二段目の差がこのポイント以上で、標準誤差の MISS_Z 倍以上
pub const MISS_POINTS: f64 = 15.0;
pub const MISS_Z: f64 = 3.0;

/// run の設定
#[derive(Clone)]
struct Cfg {
    rate: f64,
    m: u32,
    extra: usize,
    confirm: u32,
    flag: f64,
}

/// 試合のデッキの名前
fn deck_name(cards: &[CardIdx]) -> String {
    data()
        .decks
        .iter()
        .find(|d| d.cards == cards)
        .map_or("?".to_string(), |d| d.name.clone())
}

/// 打った自己対戦 1 試合
struct GameRec {
    g: u32,
    decks: [Vec<CardIdx>; 2],
    /// 席ごとのデッキの名前
    names: [String; 2],
    seed: u32,
    actions: Vec<Action>,
    /// 自分のターンの最初の局面（手の番号と席）
    starts: Vec<(usize, PlayerIndex)>,
    winner: Option<PlayerIndex>,
    sec: f64,
}

/// 試合 g の自己対戦（今の既定の AI どうし。list が無ければ svwb ai-play と同じ試合、あれば並べたデッキで compare と同じ組）
fn play_game(g: u32, list: Option<&[&'static Deck]>) -> GameRec {
    let t = Instant::now();
    let (decks, seed, names, opts) = match list {
        None => {
            let (decks, seed) = ai_game_setup(g, false);
            let names = [deck_name(&decks[0]), deck_name(&decks[1])];
            let o = SearchOptions::default();
            (decks, seed, names, [o.clone(), o])
        }
        Some(list) => {
            let (a, b) = compare_pair(list, g, false);
            let o = SearchOptions::default();
            (
                [a.cards.clone(), b.cards.clone()],
                g * 7 + 1,
                [a.name.clone(), b.name.clone()],
                [deck_options(&o, a), deck_options(&o, b)],
            )
        }
    };
    reset_lethal();
    reset_exact_lethal_cache();
    let [o0, o1] = opts;
    let mut a0 = SearchAgent::new(o0);
    let mut a1 = SearchAgent::new(o1);
    let mut actions = Vec::new();
    let mut starts = Vec::new();
    let mut last = [i32::MIN; 2];
    let end = play_match(
        &mut [&mut a0, &mut a1],
        [&decks[0], &decks[1]],
        seed,
        |s, a| {
            let actor = acting_player(s);
            if s.active == actor
                && is_start_of_turn(s)
                && s.players[actor].turn_count != last[actor]
            {
                last[actor] = s.players[actor].turn_count;
                starts.push((actions.len(), actor));
            }
            actions.push(a.clone());
        },
    );
    GameRec {
        g,
        decks,
        names,
        seed,
        actions,
        starts,
        winner: end.winner,
        sec: t.elapsed().as_secs_f64(),
    }
}

/// 局面 (g, i) を選ぶか（試合番号と手の番号で決まる乱数が rate 未満）
fn sampled(g: u32, i: usize, rate: f64) -> bool {
    (seed_of(&[TAG, g, i as u32]) as f64) / 4_294_967_296.0 < rate
}

/// 局面ごとの乱数の元
fn pos_seed(rec: &GameRec, i: usize) -> u32 {
    seed_of(&[TAG, rec.seed, i as u32])
}

/// 試合の i 手目の前の局面と、試合でその局面を考えたときの AI の乱数（play_match の MatchRng と同じ）
fn rebuild(rec: &GameRec, i: usize) -> (GameState, Rng) {
    let mut s = create_game([&rec.decks[0], &rec.decks[1]], rec.seed);
    let mut mrng = MatchRng::new(rec.seed);
    for a in &rec.actions[..i] {
        let actor = acting_player(&s);
        mrng.next(&s, actor, false);
        s = apply_legal(&s, a);
    }
    let actor = acting_player(&s);
    let r = mrng.next(&s, actor, false);
    let rng = Rng { state: r.state };
    (s, rng)
}

/// 候補 1 つ（スレッドをまたいで渡す形）
#[derive(Clone)]
struct PlanData {
    chosen: bool,
    steps: Vec<Action>,
    value: Value,
}

/// 調べる局面 1 つ
struct Prep {
    rec: usize,
    i: usize,
    p: PlayerIndex,
    seed: u32,
    /// 打ち比べない理由（lethal・one-action・one-plan・no-chosen）
    skip: Option<&'static str>,
    plans: Vec<PlanData>,
    /// AI が選んだ候補の添字
    ai: usize,
    row: Value,
    sec: f64,
}

fn actions_json(acts: &[Action]) -> Value {
    Value::Array(
        acts.iter()
            .map(|a| serde_json::from_str(&action_to_json(a).stringify()).unwrap_or(Value::Null))
            .collect(),
    )
}

/// 局面 start から手の列 acts の説明（打てない手が来たらそこまで）
fn texts(start: &GameState, acts: &[Action], p: PlayerIndex) -> Vec<String> {
    let mut t = start.clone();
    let mut out = Vec::new();
    for a in acts {
        out.push(step_text(&t, a, p));
        if matches!(a, Action::EndTurn) {
            break;
        }
        match try_apply_action(&t, a) {
            Some(n) => t = n,
            None => {
                out.push("…（この先は打てない）".into());
                break;
            }
        }
    }
    out
}

/// 局面を作り、候補を作る
fn prepare(recs: &[GameRec], rec_i: usize, i: usize, p: PlayerIndex, cfg: &Cfg) -> Prep {
    let t = Instant::now();
    let rec = &recs[rec_i];
    let (s, mut rng) = rebuild(rec, i);
    let names = rec.names.clone();
    let me = &s.players[p];
    let mut row = json!({
        "g": rec.g, "i": i, "p": p, "turn": s.turn, "own": me.turn_count,
        "first": s.first == p, "deck": names[p], "opp": names[1 - p],
        "maxPp": me.max_pp, "hp": me.leader_hp, "oppHp": s.players[1 - p].leader_hp,
        "view": describe(&s, p, &names),
        "state": serde_json::from_str::<Value>(&state_to_json(&s).stringify()).unwrap_or(Value::Null),
    });
    let mut prep = Prep {
        rec: rec_i,
        i,
        p,
        seed: pos_seed(rec, i),
        skip: None,
        plans: Vec::new(),
        ai: 0,
        row: Value::Null,
        sec: 0.0,
    };
    let legal = legal_actions(&s);
    reset_lethal();
    reset_exact_lethal_cache();
    let agent = SearchAgent::new(SearchOptions::default());
    let survey = if legal.len() <= 1 {
        None
    } else {
        agent.survey_plans(&s, &legal, &mut rng, cfg.extra)
    };
    match survey {
        None => prep.skip = Some("one-action"),
        Some(sv) if sv.lethal => prep.skip = Some("lethal"),
        Some(sv) => {
            let root = sv.root.as_ref().unwrap_or(&s);
            for pl in &sv.plans {
                prep.plans.push(PlanData {
                    chosen: pl.chosen,
                    steps: pl.steps.clone(),
                    value: json!({
                        "top": pl.top, "cut": pl.cut, "chosen": pl.chosen, "rank": pl.rank,
                        "turnEnd": round2(pl.turn_end), "value": pl.value.map(round2),
                        "steps": actions_json(&pl.steps),
                        "text": texts(root, &pl.steps, p),
                        "full": texts(root, &pl.full, p),
                        "used": used_of(root, &pl.full),
                    }),
                });
            }
            row["terminals"] = json!(sv.terminals);
            match prep.plans.iter().position(|x| x.chosen) {
                None => prep.skip = Some("no-chosen"),
                Some(k) => {
                    prep.ai = k;
                    row["match"] = json!(prep.plans[k].steps.first() == rec.actions.get(i));
                    if prep.plans.len() < 2 {
                        prep.skip = Some("one-plan");
                    }
                }
            }
        }
    }
    row["skip"] = json!(prep.skip);
    row["plans"] = Value::Array(prep.plans.iter().map(|x| x.value.clone()).collect());
    prep.row = row;
    prep.sec = t.elapsed().as_secs_f64();
    prep
}

/// 局面 start（p の自分のターンの最初）から、p が並び plan を選んだとして r 回目の乱数で最後まで打った結果の 1 文字
pub(crate) fn playout(
    start: &GameState,
    p: PlayerIndex,
    plan: &[Action],
    seed: u32,
    r: u32,
) -> char {
    playout_with(start, p, plan, seed, r, false)
}

/// playout の、相手の手札を実際のまま（山札の中身と順番、乱数の状態は作り直す）にもできる形（`survey recheck`）
fn playout_with(
    start: &GameState,
    p: PlayerIndex,
    plan: &[Action],
    seed: u32,
    r: u32,
    peek_opp_hand: bool,
) -> char {
    playout_ends(start, p, plan, seed, r, peek_opp_hand, false, None).result
}

/// 打ち進めた 1 回の結果と、いつ終わったか
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PlayoutEnd {
    /// p から見た勝ち負け（'1' 勝ち・'0' 負け・'d' 引き分け・'x' 打てなかった）
    pub result: char,
    /// 始めの局面から何ターン後に終わったか（0 はこのターン、1 は相手の次のターン、2 は自分の次のターン。打てなかった回は 0）
    pub turns: i32,
    /// 自分の次のターンの最初の [自分の体力, 相手の体力, 自分の場のフォロワーの数, 相手の場のフォロワーの数]（そこまで続かなかった回は None）
    pub next: Option<[i32; 4]>,
}

/// 打ち進めた 1 回の記録（`misses duel --show`）
#[derive(Default)]
pub(crate) struct PlayoutLog {
    /// 自分の次のターンの終わりまでの手と、ターンの変わり目の局面の説明
    pub lines: Vec<String>,
    /// ターンの変わり目の局面（始めの局面から何ターン後か, 局面の JSON）。相手の次のターンの最初と、自分の次のターンの最初。
    /// この回の決定化の局面なので、相手の手札と山札は引き直したもの
    pub states: Vec<(i32, String)>,
}

/// 記録に足す局面の説明（p から見たもの。sampled なら、この回の決定化で相手に配った手札も書く）
fn log_view(
    log: &mut PlayoutLog,
    ahead: i32,
    title: &str,
    s: &GameState,
    p: PlayerIndex,
    sampled: bool,
) {
    log.states.push((ahead, state_to_json(s).stringify()));
    let log = &mut log.lines;
    log.push(format!("  [{title}]"));
    let names = ["-".to_string(), "-".to_string()];
    for l in describe(s, p, &names) {
        log.push(format!("    {l}"));
    }
    if sampled {
        let hand: Vec<String> = s.players[1 - p]
            .hand
            .iter()
            .map(|h| card(h.card).name.clone())
            .collect();
        log.push(format!(
            "    相手の手札（この回の引き直し）: {}",
            hand.join("、")
        ));
    }
}

/// playout の結果と、いつ終わったか・自分の次のターンの最初の様子。
/// fixed なら、並び plan を全部そのまま打ってから（ターンを終える手まで並びに入れる）、両方の席を今の既定の AI で最後まで打つ
/// （`misses duel` の、ターンを終える手で終わる並び）。playout と違い、並びの後に AI が同じターンの続きを打たないので、「何もせずに残す」並びを測れる。
/// 決定化と AI の乱数の取り方は playout と同じ（同じ seed と r なら同じ決定化）。決定化した局面で並びのどれかが打てなければ 'x'。
/// log を渡すと、自分の次のターンの終わりまでの手と、ターンの変わり目の局面を書き足す
#[allow(clippy::too_many_arguments)]
pub(crate) fn playout_ends(
    start: &GameState,
    p: PlayerIndex,
    plan: &[Action],
    seed: u32,
    r: u32,
    peek_opp_hand: bool,
    fixed: bool,
    mut log: Option<&mut PlayoutLog>,
) -> PlayoutEnd {
    let mut next: Option<[i32; 4]> = None;
    let res = catch_unwind(AssertUnwindSafe(|| {
        reset_lethal();
        reset_exact_lethal_cache();
        let det = determinize(
            start,
            p,
            &mut Rng::new(mix(seed, 1_000_000 + r)),
            peek_opp_hand,
        );
        let x = mix(seed, 2_000_000 + r);
        let mut rng = MatchRng::with_shared(x, x);
        let mut me = SearchAgent::new(SearchOptions::default());
        let s = if fixed {
            let mut t = det.clone();
            for a in plan {
                if t.phase == Phase::Ended {
                    break;
                }
                if !is_legal(&t, a) {
                    return None;
                }
                if let Some(l) = log.as_deref_mut() {
                    l.lines.push(format!("  {}", step_text(&t, a, p)));
                }
                t = apply_legal(&t, a);
            }
            t
        } else {
            let first = plan.first()?;
            if !is_legal(&det, first) {
                return None;
            }
            // 並びの各手の後の予想の局面（AI が並びを選んだときと同じく、局面が予想どおりなら続きを打つため）
            let mut steps: Vec<(Action, Rc<GameState>)> = Vec::new();
            let mut t = det.clone();
            for a in plan {
                if matches!(a, Action::EndTurn) || !is_legal(&t, a) {
                    break;
                }
                t = apply_legal(&t, a);
                steps.push((a.clone(), Rc::new(t.clone())));
            }
            // 最初の判断（候補を選んだ判断）の分を使っておく（後の判断の乱数を、試合で AI が選んだときと同じ並びにする）
            rng.next(&det, p, false);
            me.follow_plan(p, steps);
            if let Some(l) = log.as_deref_mut() {
                l.lines.push(format!("  {}", step_text(&det, first, p)));
            }
            apply_legal(&det, first)
        };
        let mut s = s;
        let mut other = SearchAgent::new(SearchOptions::default());
        let mut seen = start.turn;
        for _ in 0..10000 {
            if s.phase == Phase::Ended {
                let c = match s.winner {
                    Some(w) if w == p => '1',
                    Some(_) => '0',
                    None => 'd',
                };
                return Some((c, s.turn - start.turn));
            }
            let ahead = s.turn - start.turn;
            if s.turn != seen {
                seen = s.turn;
                if ahead == 2 && acting_player(&s) == p {
                    let followers = |q: PlayerIndex| {
                        s.players[q].board.iter().filter(|b| b.is_follower).count() as i32
                    };
                    next = Some([
                        s.players[p].leader_hp,
                        s.players[1 - p].leader_hp,
                        followers(p),
                        followers(1 - p),
                    ]);
                }
                if let Some(l) = log.as_deref_mut() {
                    match ahead {
                        1 => log_view(l, 1, "相手の次のターンの最初", &s, p, true),
                        2 => log_view(l, 2, "自分の次のターンの最初", &s, p, false),
                        _ => {}
                    }
                }
            }
            let legal = legal_actions(&s);
            let a = if acting_player(&s) == p {
                rng.choose(&mut me, &s, &legal)
            } else {
                rng.choose(&mut other, &s, &legal)
            };
            if ahead <= 2 {
                if let Some(l) = log.as_deref_mut() {
                    l.lines.push(format!("  {}", step_text(&s, &a, p)));
                }
            }
            s = apply_legal(&s, &a);
        }
        None
    }))
    .ok()
    .flatten();
    match res {
        Some((result, turns)) => PlayoutEnd {
            result,
            turns,
            next,
        },
        None => PlayoutEnd {
            result: 'x',
            turns: 0,
            next: None,
        },
    }
}

/// 勝ち負けの 1 文字を勝ちの数に（打てなかったものは None）
fn win_of(c: char) -> Option<f64> {
    match c {
        '1' => Some(1.0),
        '0' => Some(0.0),
        'd' => Some(0.5),
        _ => None,
    }
}

/// 2 つの勝ち負けの列の、両方が打てた回の差（a − b）
fn paired(a: &[char], b: &[char], keep: impl Fn(usize) -> bool) -> Vec<f64> {
    a.iter()
        .zip(b)
        .enumerate()
        .filter(|(r, _)| keep(*r))
        .filter_map(|(_, (x, y))| Some(win_of(*x)? - win_of(*y)?))
        .collect()
}

fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        f64::NAN
    } else {
        xs.iter().sum::<f64>() / xs.len() as f64
    }
}

/// 一段目で、AI の選んだ候補 ai との差（ポイント）が最も大きい候補とその差（同じなら先の候補）
fn best_alt(w: &[Vec<char>], ai: usize) -> Option<(usize, f64)> {
    let mut best: Option<(usize, f64)> = None;
    for (c, wc) in w.iter().enumerate() {
        if c == ai {
            continue;
        }
        let d = mean(&paired(wc, &w[ai], |_| true)) * 100.0;
        if d.is_finite() && best.is_none_or(|(_, b)| d > b) {
            best = Some((c, d));
        }
    }
    best
}

/// 1 試合分の行を作る（局面を選び、候補を作り、一段目・二段目を打つ）
fn run_batch(games: &[u32], cfg: &Cfg, list: Option<&[&'static Deck]>) -> Vec<Value> {
    let recs: Vec<GameRec> = parallel_map(games, |&g, _| play_game(g, list), |_, _, _, _| {});
    let mut picks: Vec<(usize, usize, PlayerIndex)> = Vec::new();
    for (k, rec) in recs.iter().enumerate() {
        for &(i, p) in &rec.starts {
            if sampled(rec.g, i, cfg.rate) {
                picks.push((k, i, p));
            }
        }
    }
    let mut preps: Vec<Prep> = parallel_map(
        &picks,
        |&(k, i, p), _| prepare(&recs, k, i, p, cfg),
        |_, _, _, _| {},
    );
    // 一段目: 候補ごとに m 回（どの候補も r 回目は同じ乱数）
    let items: Vec<(usize, u32)> = preps
        .iter()
        .enumerate()
        .filter(|(_, x)| x.skip.is_none())
        .flat_map(|(k, _)| (0..cfg.m).map(move |r| (k, r)))
        .collect();
    let plans: Vec<Vec<Vec<Action>>> = preps
        .iter()
        .map(|x| x.plans.iter().map(|pl| pl.steps.clone()).collect())
        .collect();
    let meta: Vec<(usize, usize, PlayerIndex, u32)> =
        preps.iter().map(|x| (x.rec, x.i, x.p, x.seed)).collect();
    let res1: Vec<(Vec<char>, f64)> = parallel_map(
        &items,
        |&(k, r), _| {
            let t = Instant::now();
            let (rec, i, p, seed) = meta[k];
            let (s, _) = rebuild(&recs[rec], i);
            let out = plans[k]
                .iter()
                .map(|pl| playout(&s, p, pl, seed, r))
                .collect();
            (out, t.elapsed().as_secs_f64())
        },
        |_, _, _, _| {},
    );
    let mut w1: Vec<Vec<Vec<char>>> = preps
        .iter()
        .map(|x| vec![Vec::new(); x.plans.len()])
        .collect();
    let mut rollouts = vec![0u32; preps.len()];
    for (&(k, _), (out, sec)) in items.iter().zip(&res1) {
        for (c, ch) in out.iter().enumerate() {
            w1[k][c].push(*ch);
        }
        preps[k].sec += sec;
        rollouts[k] += out.len() as u32;
    }
    // 二段目: 一段目で差が --flag 以上の候補と、AI の選んだ候補を、別の乱数で --confirm 回
    let mut flagged: Vec<(usize, usize, f64)> = Vec::new();
    for (k, x) in preps.iter().enumerate() {
        if x.skip.is_some() {
            continue;
        }
        if let Some((c, d)) = best_alt(&w1[k], x.ai) {
            if d >= cfg.flag {
                flagged.push((k, c, d));
            }
        }
    }
    let items2: Vec<(usize, usize, u32)> = flagged
        .iter()
        .flat_map(|&(k, c, _)| (cfg.m..cfg.m + cfg.confirm).map(move |r| (k, c, r)))
        .collect();
    let ais: Vec<usize> = preps.iter().map(|x| x.ai).collect();
    let res2: Vec<([char; 2], f64)> = parallel_map(
        &items2,
        |&(k, c, r), _| {
            let t = Instant::now();
            let (rec, i, p, seed) = meta[k];
            let (s, _) = rebuild(&recs[rec], i);
            let a = playout(&s, p, &plans[k][ais[k]], seed, r);
            let b = playout(&s, p, &plans[k][c], seed, r);
            ([a, b], t.elapsed().as_secs_f64())
        },
        |_, _, _, _| {},
    );
    let mut w2: BTreeMap<usize, (usize, f64, String, String)> = BTreeMap::new();
    for &(k, c, d) in &flagged {
        w2.insert(k, (c, d, String::new(), String::new()));
    }
    for (&(k, _, _), (pair, sec)) in items2.iter().zip(&res2) {
        let e = w2.get_mut(&k).expect("二段目の局面");
        e.2.push(pair[0]);
        e.3.push(pair[1]);
        preps[k].sec += sec;
        rollouts[k] += 2;
    }
    let mut rows = Vec::new();
    for (k, x) in preps.into_iter().enumerate() {
        let mut row = x.row;
        if x.skip.is_none() {
            row["ai"] = json!(x.ai);
            row["m"] = json!(cfg.m);
            row["w"] = json!(w1[k]
                .iter()
                .map(|v| v.iter().collect::<String>())
                .collect::<Vec<_>>());
            row["confirm"] = match w2.get(&k) {
                Some((c, d, a, b)) => {
                    json!({ "c": c, "d1": round2(*d), "n": cfg.confirm, "ai": a, "alt": b })
                }
                None => Value::Null,
            };
        }
        row["rollouts"] = json!(rollouts[k]);
        row["sec"] = round2(x.sec);
        rows.push(row);
    }
    let (_, _, commit, _) = ledger::context();
    for rec in &recs {
        let n = |q: PlayerIndex| rec.starts.iter().filter(|x| x.1 == q).count();
        rows.push(json!({
            "game": true, "g": rec.g, "seed": rec.seed,
            "decks": rec.names,
            "turnStarts": [n(0), n(1)],
            "sampled": picks.iter().filter(|x| recs[x.0].g == rec.g).count(),
            "winner": rec.winner, "actions": rec.actions.len(), "sec": round2(rec.sec),
            "rate": cfg.rate, "m": cfg.m, "extra": cfg.extra, "confirm": cfg.confirm, "flag": cfg.flag,
            "commit": commit, "machine": ledger::machine(), "threads": thread_count(),
        }));
    }
    rows
}

fn float_flag(flags: &[(String, String)], k: &str, def: f64) -> Result<f64, String> {
    match flag(flags, k) {
        None => Ok(def),
        Some(v) => v
            .parse::<f64>()
            .ok()
            .filter(|x| x.is_finite() && *x >= 0.0)
            .ok_or_else(|| format!("--{k} は 0 以上の数: {v}")),
    }
}

/// svwb survey run
fn run(argv: &[String]) -> Result<(), String> {
    let (flags, rest) = parse_flags(argv)?;
    if !rest.is_empty() {
        return Err(format!("不明な引数: {}", rest.join(" ")));
    }
    check_flags(
        &flags,
        &[
            "out", "games", "rate", "m", "extra", "confirm", "flag", "batch", "decks",
        ],
    )?;
    let list: Option<Vec<&'static Deck>> = flag(&flags, "decks")
        .map(|spec| {
            read_deck_list(spec).map(|v| {
                v.into_iter()
                    .map(|d| &*Box::leak(Box::new(d)))
                    .collect::<Vec<&'static Deck>>()
            })
        })
        .transpose()?;
    if list.as_ref().is_some_and(|l| l.len() < 2) {
        return Err("--decks には 2 つ以上のデッキを並べます".into());
    }
    let out = flag(&flags, "out").ok_or("--out を渡してください")?;
    let (a, b) = parse_range(flag(&flags, "games").ok_or("--games a-b を渡してください")?)?;
    if a < 0 || b < a {
        return Err("--games は 0 以上の a-b（a ≤ b）".into());
    }
    let cfg = Cfg {
        rate: float_flag(&flags, "rate", 0.1)?.min(1.0),
        m: num_flag(&flags, "m", 32)?.max(2),
        extra: num_flag(&flags, "extra", 4)? as usize,
        confirm: num_flag(&flags, "confirm", 96)?,
        flag: float_flag(&flags, "flag", 10.0)?,
    };
    let batch = num_flag(&flags, "batch", 8)?.max(1) as usize;
    let mut done: HashSet<u64> = HashSet::new();
    if std::path::Path::new(out).exists() {
        let rows = read_rows(out)?;
        for v in rows.iter().filter(|v| v["game"] == json!(true)) {
            done.insert(v["g"].as_u64().unwrap_or(u64::MAX));
        }
        let keep: Vec<&Value> = rows
            .iter()
            .filter(|v| done.contains(&v["g"].as_u64().unwrap_or(u64::MAX)))
            .collect();
        if keep.len() != rows.len() || !ends_cleanly(out) {
            let text: String = keep.iter().map(|v| format!("{v}\n")).collect();
            std::fs::write(out, text).map_err(|e| format!("{out} に書けません: {e}"))?;
        }
    }
    let games: Vec<u32> = (a as u32..=b as u32)
        .filter(|g| !done.contains(&(*g as u64)))
        .collect();
    println!(
        "試合 g{a}〜{b} のうち残り {}（済み {}）、局面の割合 {}、一段目 {} 回・候補の足し {}・二段目 {} 回（差 {} ポイント以上）、{} スレッド",
        games.len(),
        done.len(),
        cfg.rate,
        cfg.m,
        cfg.extra,
        cfg.confirm,
        cfg.flag,
        thread_count()
    );
    let mut file = open_append(out)?;
    let t0 = Instant::now();
    let mut positions = 0;
    // まとめる試合の数をそろえる（17 試合を 8・8・1 でなく 6・6・5 に。端の小さなまとまりでスレッドが余らないように）
    let size = games
        .len()
        .div_ceil(games.len().div_ceil(batch).max(1))
        .max(1);
    for (n, chunk) in games.chunks(size).enumerate() {
        let rows = run_batch(chunk, &cfg, list.as_deref());
        positions += rows.iter().filter(|v| v["game"] != json!(true)).count();
        let text: String = rows.iter().map(|v| format!("{v}\n")).collect();
        file.write_all(text.as_bytes())
            .and_then(|_| file.flush())
            .map_err(|e| format!("{out} に書けません: {e}"))?;
        let finished = ((n + 1) * size).min(games.len());
        let sec = t0.elapsed().as_secs_f64();
        eprintln!(
            "試合 {finished}/{}・局面 {positions}（{} 秒、残り約 {} 分）",
            games.len(),
            fixed(sec, 0),
            fixed(
                sec / finished as f64 * (games.len() - finished) as f64 / 60.0,
                0
            )
        );
    }
    println!(
        "完了: 試合 {}・局面 {positions}、{} 秒",
        games.len(),
        fixed(t0.elapsed().as_secs_f64(), 0)
    );
    Ok(())
}

// ---------------------------------------------------------------- report

/// 局面の行を読んだもの
struct PosRow {
    v: Value,
    skip: bool,
    ai: usize,
    top: Vec<bool>,
    /// 読み直しを rescoreRace が打ち切った候補か（top も true）
    cut: Vec<bool>,
    w: Vec<Vec<char>>,
    /// 二段目の差（ポイント）と標準誤差、候補
    confirm: Option<(usize, f64, f64)>,
}

fn chars(v: &Value) -> Vec<char> {
    v.as_str().unwrap_or("").chars().collect()
}

fn pos_row(v: Value) -> PosRow {
    let plans = v["plans"].as_array().cloned().unwrap_or_default();
    let top = plans.iter().map(|x| x["top"] == json!(true)).collect();
    let cut = plans.iter().map(|x| x["cut"] == json!(true)).collect();
    let w: Vec<Vec<char>> = v["w"]
        .as_array()
        .map(|a| a.iter().map(chars).collect())
        .unwrap_or_default();
    let skip = !v["skip"].is_null() || w.len() < 2;
    let ai = v["ai"].as_u64().unwrap_or(0) as usize;
    let confirm = (!v["confirm"].is_null()).then(|| {
        let c = &v["confirm"];
        let d = paired(&chars(&c["alt"]), &chars(&c["ai"]), |_| true);
        let (m, se) = mean_se(&d);
        (c["c"].as_u64().unwrap_or(0) as usize, m * 100.0, se * 100.0)
    });
    PosRow {
        v,
        skip,
        ai,
        top,
        cut,
        w,
        confirm,
    }
}

/// 回を半分に分け、片方で選んで（勝ちの多い候補。同じなら AI の選んだ候補、次に先の候補）もう片方で測った、AI の選んだ候補との差（0〜1）。
/// 偶数回で選んで奇数回で測ったものと、その逆の平均。set は選べる候補（AI の選んだ候補を含む）
pub(crate) fn split_gain(w: &[Vec<char>], ai: usize, set: &[usize]) -> f64 {
    let mut gains = Vec::new();
    for parity in 0..2 {
        let pick = |r: usize| r % 2 == parity;
        let measure = |r: usize| r % 2 != parity;
        let score = |c: usize| {
            let xs: Vec<f64> = w[c]
                .iter()
                .enumerate()
                .filter(|(r, _)| pick(*r))
                .filter_map(|(_, ch)| win_of(*ch))
                .collect();
            mean(&xs)
        };
        let mut sel = ai;
        let mut best = score(ai);
        for &c in set {
            let s = score(c);
            if s.is_finite() && (!best.is_finite() || s > best + 1e-12) {
                sel = c;
                best = s;
            }
        }
        let d = mean(&paired(&w[sel], &w[ai], measure));
        gains.push(if d.is_finite() { d } else { 0.0 });
    }
    mean(&gains)
}

/// 手の種類（AI の選んだ並びと比べた候補の並びの違い。ビームの終局面までの並びで使ったもので見る）
fn kind_of(ai_used: &[String], alt_used: &[String]) -> &'static str {
    let only = |xs: &[String], pre: &[&str]| -> Vec<String> {
        xs.iter()
            .filter(|x| pre.iter().any(|p| x.starts_with(p)))
            .cloned()
            .collect()
    };
    let differ = |pre: &[&str]| {
        let (a, b) = (only(ai_used, pre), only(alt_used, pre));
        !multiset_minus(&a, &b).is_empty() || !multiset_minus(&b, &a).is_empty()
    };
    if differ(&["プレイ "]) {
        "出すカードが違う"
    } else if differ(&["進化 ", "超進化 "]) {
        "進化・超進化が違う"
    } else if differ(&["融合 ", "能力 ", "エクストラPP"]) {
        "融合・能力・エクストラPPが違う"
    } else {
        "攻撃先・手の順番だけが違う"
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
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

/// 局面の行 r が、大きなミス（二段目の差が MISS_POINTS 以上で、標準誤差の MISS_Z 倍以上）か
fn is_miss(r: &PosRow) -> bool {
    matches!(r.confirm, Some((_, d, se)) if d >= MISS_POINTS && (se.is_nan() || d >= MISS_Z * se))
}

/// svwb survey report
fn report(argv: &[String]) -> Result<(), String> {
    let mut args = argv.to_vec();
    let no_ledger = ledger::take_no_ledger(&mut args);
    let (flags, files) = parse_flags(&args)?;
    check_flags(&flags, &["label", "top", "states"])?;
    if files.is_empty() {
        return Err("調査の結果（jsonl）を 1 つ以上渡してください".into());
    }
    let label = flag(&flags, "label").unwrap_or("").to_string();
    let top_n = num_flag(&flags, "top", 20)? as usize;
    let mut games: BTreeMap<u64, Value> = BTreeMap::new();
    let mut pos: BTreeMap<(u64, u64), Value> = BTreeMap::new();
    for f in &files {
        for v in read_rows(f)? {
            let g = v["g"].as_u64().unwrap_or(u64::MAX);
            if v["game"] == json!(true) {
                games.insert(g, v);
            } else {
                pos.insert((g, v["i"].as_u64().unwrap_or(u64::MAX)), v);
            }
        }
    }
    // 試合の行の無い局面（途中で止めたもの）は数えない
    let rows: Vec<PosRow> = pos
        .into_iter()
        .filter(|((g, _), _)| games.contains_key(g))
        .map(|(_, v)| pos_row(v))
        .collect();
    let n_games = games.len();
    if n_games == 0 {
        return Err("試合の行がありません".into());
    }
    let turn_starts: u64 = games
        .values()
        .map(|g| strs_u(&g["turnStarts"]).iter().sum::<u64>())
        .sum();
    let per_seat = turn_starts as f64 / (2.0 * n_games as f64);
    let n = rows.len();
    let gains = |set_of: &dyn Fn(&PosRow) -> Vec<usize>| -> Vec<f64> {
        rows.iter()
            .map(|r| {
                if r.skip {
                    0.0
                } else {
                    split_gain(&r.w, r.ai, &set_of(r)) * 100.0
                }
            })
            .collect()
    };
    let top_set = |r: &PosRow| -> Vec<usize> { (0..r.w.len()).filter(|&c| r.top[c]).collect() };
    let all_set = |r: &PosRow| -> Vec<usize> { (0..r.w.len()).collect() };
    let g4 = gains(&top_set);
    let g8 = gains(&all_set);
    let (m4, se4) = mean_se(&g4);
    let (m8, se8) = mean_se(&g8);
    // 二段目で測る得（試しの後、本番の前に足した決まり。docs/survey.md）: 一段目の回の全部で選び（AI の選んだ候補との差が
    // 最も大きい候補の差が --flag 以上ならその候補、でなければ AI の選んだ候補）、選ぶのに使っていない二段目の回で測る。二段目に回らない局面は 0
    let stage2 = |which: Option<&str>| -> Vec<f64> {
        rows.iter()
            .map(|r| match r.confirm {
                Some((c, d, _)) if d.is_finite() && which.is_none_or(|w| plan_kind(r, c) == w) => d,
                _ => 0.0,
            })
            .collect()
    };
    let g2 = stage2(None);
    let (m2, se2) = mean_se(&g2);
    let (m2x, se2x) = mean_se(&stage2(Some(EXTRA)));
    let (m2c, se2c) = mean_se(&stage2(Some(CUT)));
    let compared: Vec<&PosRow> = rows.iter().filter(|r| !r.skip).collect();
    let misses: Vec<&PosRow> = rows.iter().filter(|r| is_miss(r)).collect();
    let flagged = rows.iter().filter(|r| r.confirm.is_some()).count();
    let miss_rate = misses.len() as f64 / n.max(1) as f64;
    let miss_se = (miss_rate * (1.0 - miss_rate) / n.max(1) as f64).sqrt();
    // 候補どうしで勝ち負けが割れる割合と、1 局面の差（AI の選んだ候補と別の候補 1 つ）の標準誤差
    let mut split_any = Vec::new();
    let mut split_pair = Vec::new();
    let mut pair_se = Vec::new();
    for r in &compared {
        let m = r.w[r.ai].len();
        for t in 0..m {
            let vals: Vec<f64> = r.w.iter().filter_map(|w| win_of(*w.get(t)?)).collect();
            if vals.len() >= 2 {
                split_any.push(if vals.iter().any(|x| (x - vals[0]).abs() > 1e-9) {
                    1.0
                } else {
                    0.0
                });
            }
        }
        for c in 0..r.w.len() {
            if c == r.ai {
                continue;
            }
            let d = paired(&r.w[c], &r.w[r.ai], |_| true);
            split_pair.extend(d.iter().map(|x| if x.abs() > 1e-9 { 1.0 } else { 0.0 }));
            let (_, se) = mean_se(&d);
            if se.is_finite() {
                pair_se.push(se * 100.0);
            }
        }
    }
    let sec: f64 = rows
        .iter()
        .map(|r| r.v["sec"].as_f64().unwrap_or(0.0))
        .sum();
    let n_roll: f64 = rows
        .iter()
        .map(|r| r.v["rollouts"].as_f64().unwrap_or(0.0))
        .sum();
    let skips = |k: &str| rows.iter().filter(|r| r.v["skip"] == json!(k)).count();
    let mism = rows.iter().filter(|r| r.v["match"] == json!(false)).count();
    let illegal: usize = compared
        .iter()
        .map(|r| r.w.iter().flatten().filter(|c| **c == 'x').count())
        .sum();
    let first_game = *games.keys().next().unwrap_or(&0);
    let last_game = *games.keys().last().unwrap_or(&0);
    let cfg0 = games.values().next().cloned().unwrap_or(Value::Null);

    let mut out = String::new();
    let mut line = |s: String| {
        out.push_str(&s);
        out.push('\n');
    };
    line("# 候補の打ち比べ調査".into());
    line(String::new());
    line(format!(
        "試合 {n_games}（g{first_game}〜{last_game}）、自分のターンの最初の局面 {turn_starts}（1 試合 1 席あたり {}）、選んだ局面 {n}（割合 {}）。一段目 {} 回・二段目 {} 回（差 {} ポイント以上）",
        fixed(per_seat, 2),
        cfg0["rate"],
        cfg0["m"],
        cfg0["confirm"],
        cfg0["flag"],
    ));
    line(format!(
        "打ち比べた局面 {}（リーサル {}、打てる手が 1 つ {}、候補が 1 つ {}、AI の手が候補に無い {}）。試合で打った手と違う手を選んだ局面 {mism}、打てなかった・途中で止まった回 {illegal}",
        compared.len(),
        skips("lethal"),
        skips("one-action"),
        skips("one-plan"),
        skips("no-chosen"),
    ));
    let per_kind = |k: &str| {
        let n: usize = compared
            .iter()
            .map(|r| (0..r.w.len()).filter(|&c| plan_kind(r, c) == k).count())
            .sum();
        fixed(n as f64 / compared.len().max(1) as f64, 2)
    };
    line(format!(
        "1 局面の候補の数: {READ} {}・{CUT} {}・{EXTRA} {}",
        per_kind(READ),
        per_kind(CUT),
        per_kind(EXTRA)
    ));
    line(String::new());
    line("## 打ち比べで選び直す得".into());
    line(String::new());
    line("AI の選んだ候補との勝率の差（ポイント）。打ち比べなかった局面は 0。1 試合あたりは、1 局面あたり × 1 試合 1 席の局面の数（片方の席が全部の自分のターンで選び直したときの見積もり。局面どうしの重なりは見ない）".into());
    line(String::new());
    line(format!(
        "二段目で測る得（試しの後に足した決まり）: 一段目の {} 回で、差の最も大きい候補の差が {} ポイント以上なら選び直し、二段目の {} 回で測る",
        cfg0["m"], cfg0["flag"], cfg0["confirm"]
    ));
    line(String::new());
    line("| 選び直し | 1 局面あたり | 1 試合あたり |".into());
    line("| --- | ---: | ---: |".into());
    line(format!(
        "| 全部の候補から（二段目で測る） | {} | {} |",
        pm(m2, se2, 2),
        pm(m2 * per_seat, se2 * per_seat, 2)
    ));
    line(format!(
        "| うち足した候補を選んだ局面の分 | {} | {} |",
        pm(m2x, se2x, 2),
        pm(m2x * per_seat, se2x * per_seat, 2)
    ));
    line(format!(
        "| うち読み直しを打ち切った候補を選んだ局面の分 | {} | {} |",
        pm(m2c, se2c, 2),
        pm(m2c * per_seat, se2c * per_seat, 2)
    ));
    line(String::new());
    line(format!(
        "半分の回で選ぶ得（回す前に決めた決まり）: 一段目の {} 回を偶数回と奇数回に分け、片方で勝ちの最も多い候補を選び、もう片方で測る",
        cfg0["m"]
    ));
    line(String::new());
    line("| 候補 | 1 局面あたり | 1 試合あたり |".into());
    line("| --- | ---: | ---: |".into());
    line(format!(
        "| AI が読み直す候補だけ | {} | {} |",
        pm(m4, se4, 2),
        pm(m4 * per_seat, se4 * per_seat, 2)
    ));
    line(format!(
        "| ＋ 使うカードの組が違う並び | {} | {} |",
        pm(m8, se8, 2),
        pm(m8 * per_seat, se8 * per_seat, 2)
    ));
    let d84: Vec<f64> = g8.iter().zip(&g4).map(|(a, b)| a - b).collect();
    let (md, sed) = mean_se(&d84);
    line(format!(
        "| 差（足した候補の分） | {} | {} |",
        pm(md, sed, 2),
        pm(md * per_seat, sed * per_seat, 2)
    ));
    line(String::new());
    line("## 大きなミス".into());
    line(String::new());
    line(format!(
        "二段目の差が {MISS_POINTS} ポイント以上で、標準誤差の {MISS_Z} 倍以上の局面: {}（選んだ局面の {}、1 試合 1 席あたり {}）。一段目で二段目に回した局面 {flagged}",
        misses.len(),
        pm(miss_rate * 100.0, miss_se * 100.0, 1) + "%",
        pm(miss_rate * per_seat, miss_se * per_seat, 3),
    ));
    let conf: Vec<f64> = rows.iter().filter_map(|r| r.confirm.map(|x| x.1)).collect();
    let (mc, sec_c) = mean_se(&conf);
    line(format!(
        "二段目に回した局面の、二段目の差の平均: {} ポイント（一段目の差の平均 {}）",
        pm(mc, sec_c, 1),
        fixed(
            mean(
                &rows
                    .iter()
                    .filter_map(|r| r.v["confirm"]["d1"].as_f64())
                    .collect::<Vec<_>>()
            ),
            1
        )
    ));
    line(String::new());
    switch_tables(&rows, per_seat, &mut line);
    line("## ぶれと時間".into());
    line(String::new());
    line(format!(
        "- 同じ回で候補どうしの勝ち負けが割れる割合: どれか 1 組でも {}、AI の選んだ候補と別の候補 1 つで {}",
        pct_of(&split_any),
        pct_of(&split_pair)
    ));
    line(format!(
        "- 1 局面の差（AI の選んだ候補と別の候補 1 つ、一段目の {} 回）の標準誤差: 平均 {} ポイント",
        cfg0["m"],
        fixed(mean(&pair_se), 1)
    ));
    line(format!(
        "- 続き 1 試合 {} 秒（スレッド 1 本の秒。{} 回）、1 局面 {} 秒（候補を作る時間を含む）",
        fixed(sec / n_roll.max(1.0), 2),
        n_roll,
        fixed(sec / n.max(1) as f64, 1)
    ));
    line(String::new());
    // 内訳
    let breakdown = |title: &str, key: &dyn Fn(&PosRow) -> String, line: &mut dyn FnMut(String)| {
        let mut groups: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for (k, r) in rows.iter().enumerate() {
            groups.entry(key(r)).or_default().push(k);
        }
        line(format!("### {title}"));
        line(String::new());
        line("| | 局面 | 打ち比べた | 二段目で測る得（1 局面） | 二段目に回した | 半分の回で選ぶ得（全部の候補） | （読み直す候補だけ） | 大きなミス |".into());
        line("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |".into());
        for (name, ks) in groups {
            let (m, s) = mean_se(&ks.iter().map(|&k| g2[k]).collect::<Vec<_>>());
            let (ma, sa) = mean_se(&ks.iter().map(|&k| g8[k]).collect::<Vec<_>>());
            let (mb, sb) = mean_se(&ks.iter().map(|&k| g4[k]).collect::<Vec<_>>());
            line(format!(
                "| {name} | {} | {} | {} | {} | {} | {} | {} |",
                ks.len(),
                ks.iter().filter(|&&k| !rows[k].skip).count(),
                pm(m, s, 2),
                ks.iter().filter(|&&k| rows[k].confirm.is_some()).count(),
                pm(ma, sa, 2),
                pm(mb, sb, 2),
                ks.iter().filter(|&&k| is_miss(&rows[k])).count()
            ));
        }
        line(String::new());
    };
    let mut body = String::new();
    {
        let mut l = |s: String| {
            body.push_str(&s);
            body.push('\n');
        };
        l("## 内訳".into());
        l(String::new());
        l("1 局面あたりのポイント。二段目で測る得はどの内訳でも偏りがない（分け方は一段目の回だけで決まり、測るのは二段目の回）。半分の回で選ぶ得は前の決まり".into());
        l(String::new());
        breakdown(
            "デッキ（手番の側）",
            &|r| r.v["deck"].as_str().unwrap_or("?").to_string(),
            &mut l,
        );
        breakdown(
            "自分のターン",
            &|r| {
                let t = r.v["own"].as_i64().unwrap_or(0);
                match t {
                    ..=3 => "a: 1〜3".into(),
                    4..=6 => "b: 4〜6".into(),
                    7..=9 => "c: 7〜9".into(),
                    _ => "d: 10〜".into(),
                }
            },
            &mut l,
        );
        breakdown(
            "手の種類（一段目の全部の回で勝ちが最も多い候補と AI の選んだ候補の違い）",
            &|r| best_kind(r),
            &mut l,
        );
    }
    out.push_str(&body);
    // 問題集に足す候補
    let mut list: Vec<&PosRow> = misses.clone();
    list.sort_by(|a, b| {
        let d = |r: &PosRow| r.confirm.map_or(0.0, |x| x.1);
        d(b).partial_cmp(&d(a)).unwrap_or(std::cmp::Ordering::Equal)
    });
    out.push_str(&format!(
        "## 問題集に足す局面の候補（大きなミス、差の大きい順に {} まで）\n\n",
        top_n
    ));
    if let Some(dir) = flag(&flags, "states") {
        std::fs::create_dir_all(dir).map_err(|e| format!("{dir} を作れません: {e}"))?;
    }
    for r in list.iter().take(top_n) {
        let (c, d, se) = r.confirm.expect("二段目");
        let plans = r.v["plans"].as_array().cloned().unwrap_or_default();
        let (ai, alt) = (&plans[r.ai], &plans[c]);
        let g = r.v["g"].as_u64().unwrap_or(0);
        let i = r.v["i"].as_u64().unwrap_or(0);
        out.push_str(&format!(
            "### 試合 {g} の {i} 手目（{}、自分のターン {}、{}）: 差 {} ポイント\n\n",
            r.v["deck"].as_str().unwrap_or("?"),
            r.v["own"],
            plan_kind(r, c),
            pm(d, se, 1)
        ));
        for l in strs(&r.v["view"]) {
            out.push_str(&format!("- {l}\n"));
        }
        out.push_str(&format!(
            "- AI の手（ターン末 {}・順位 {}）: {}\n",
            ai["turnEnd"],
            ai["rank"],
            strs(&ai["full"]).join(" → ")
        ));
        out.push_str(&format!(
            "- 打ち比べで良い手（ターン末 {}・順位 {}）: {}\n",
            alt["turnEnd"],
            alt["rank"],
            strs(&alt["full"]).join(" → ")
        ));
        let (au, bu) = (strs(&ai["used"]), strs(&alt["used"]));
        out.push_str(&format!(
            "- 違い: 良い手だけ {}／AI の手だけ {}\n\n",
            join_or(&multiset_minus(&bu, &au)),
            join_or(&multiset_minus(&au, &bu))
        ));
        if let Some(dir) = flag(&flags, "states") {
            let f = format!("{dir}/g{g}-i{i}.json");
            std::fs::write(&f, r.v["state"].to_string() + "\n")
                .map_err(|e| format!("{f} に書けません: {e}"))?;
        }
    }
    print!("{out}");
    if !no_ledger {
        let mut cmd = vec!["survey".to_string(), "report".to_string()];
        cmd.extend(argv.iter().filter(|a| *a != "--no-ledger").cloned());
        let machines: Vec<String> = games
            .values()
            .filter_map(|g| g["machine"].as_str().map(String::from))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let commits: Vec<String> = games
            .values()
            .filter_map(|g| g["commit"].as_str().map(String::from))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let num = Json::Num;
        let r6 = |x: f64| {
            if x.is_finite() {
                num((x * 1e4).round() / 1e4)
            } else {
                Json::Null
            }
        };
        let pair = |m: f64, se: f64| Json::Arr(vec![r6(m), r6(se)]);
        ledger::append_survey(
            &label,
            vec![
                ("a".into(), Json::Obj(Vec::new())),
                (
                    "g".into(),
                    Json::Arr(vec![num(first_game as f64), num(last_game as f64)]),
                ),
                ("games".into(), num(n_games as f64)),
                ("rate".into(), r6(cfg0["rate"].as_f64().unwrap_or(f64::NAN))),
                ("m".into(), r6(cfg0["m"].as_f64().unwrap_or(f64::NAN))),
                (
                    "extra".into(),
                    r6(cfg0["extra"].as_f64().unwrap_or(f64::NAN)),
                ),
                (
                    "confirm".into(),
                    r6(cfg0["confirm"].as_f64().unwrap_or(f64::NAN)),
                ),
                ("flag".into(), r6(cfg0["flag"].as_f64().unwrap_or(f64::NAN))),
                ("turnStarts".into(), num(turn_starts as f64)),
                ("positions".into(), num(n as f64)),
                ("compared".into(), num(compared.len() as f64)),
                ("gain4".into(), pair(m4 * per_seat, se4 * per_seat)),
                ("gain8".into(), pair(m8 * per_seat, se8 * per_seat)),
                ("gain2".into(), pair(m2 * per_seat, se2 * per_seat)),
                ("gain2Extra".into(), pair(m2x * per_seat, se2x * per_seat)),
                ("flagged".into(), num(flagged as f64)),
                ("misses".into(), num(misses.len() as f64)),
                (
                    "missesPerGame".into(),
                    pair(miss_rate * per_seat, miss_se * per_seat),
                ),
                ("splitAny".into(), r6(mean(&split_any))),
                ("splitPair".into(), r6(mean(&split_pair))),
                ("pairSe".into(), r6(mean(&pair_se))),
                ("perRollout".into(), r6(sec / n_roll.max(1.0))),
                ("seconds".into(), r6((sec * 10.0).round() / 10.0)),
                (
                    "machines".into(),
                    Json::Arr(machines.into_iter().map(Json::Str).collect()),
                ),
                (
                    "commits".into(),
                    Json::Arr(commits.into_iter().map(Json::Str).collect()),
                ),
                ("cmd".into(), Json::Str(ledger::shell_line(&cmd))),
            ],
        );
    }
    Ok(())
}

fn strs_u(v: &Value) -> Vec<u64> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_u64()).collect())
        .unwrap_or_default()
}

fn pct_of(xs: &[f64]) -> String {
    if xs.is_empty() {
        "-".into()
    } else {
        format!("{}%", fixed(mean(xs) * 100.0, 1))
    }
}

fn join_or(v: &[String]) -> String {
    if v.is_empty() {
        "なし".into()
    } else {
        v.join("、")
    }
}

/// 局面 r の候補 c の AI 自身の点（読み直した値があればそれ、無ければターン末の点）と、どちらを使ったか
fn ai_score(r: &PosRow, c: usize) -> (Option<f64>, bool) {
    let pl = &r.v["plans"][c];
    match pl["value"].as_f64() {
        Some(v) => (Some(v), true),
        None => (pl["turnEnd"].as_f64(), false),
    }
}

/// 二段目に回した局面の、替える決まりを決めるための表（2026-11-12、本番の後に足した出し方。docs/survey.md）。
/// 分け方は一段目の回と AI の点だけで決まるので、どの行の二段目の差にも偏りはない
fn switch_tables(rows: &[PosRow], per_seat: f64, line: &mut dyn FnMut(String)) {
    let flagged: Vec<&PosRow> = rows.iter().filter(|r| r.confirm.is_some()).collect();
    if flagged.is_empty() {
        return;
    }
    let d1 = |r: &PosRow| r.v["confirm"]["d1"].as_f64().unwrap_or(f64::NAN);
    let d2 = |r: &PosRow| r.confirm.map_or(0.0, |x| x.1);
    // 全部の局面に対する寄与（替えない局面は 0）の平均と標準誤差
    let contrib = |keep: &dyn Fn(&PosRow) -> bool| -> (f64, f64) {
        let xs: Vec<f64> = rows
            .iter()
            .map(|r| {
                if r.confirm.is_some() && keep(r) {
                    d2(r)
                } else {
                    0.0
                }
            })
            .collect();
        mean_se(&xs)
    };
    line("## 替える決まり（二段目に回した局面）".into());
    line(String::new());
    line("どれも二段目の 96 回で測った差（ポイント）。寄与は、選んだ局面の全部に対する 1 局面あたり（替えない局面は 0）".into());
    line(String::new());
    line("### 一段目の差の幅".into());
    line(String::new());
    line("| 一段目の差 | 局面 | 一段目の差の平均 | 二段目の差の平均 | 寄与（1 局面） | この幅から上だけ替える得（1 局面） | （1 試合） |".into());
    line("| --- | ---: | ---: | ---: | ---: | ---: | ---: |".into());
    let edges = [10.0, 15.0, 20.0, 30.0, f64::INFINITY];
    for k in 0..edges.len() - 1 {
        let (lo, hi) = (edges[k], edges[k + 1]);
        let ks: Vec<&&PosRow> = flagged
            .iter()
            .filter(|r| d1(r) >= lo && d1(r) < hi)
            .collect();
        let name = if hi.is_finite() {
            format!("{lo}〜{hi}")
        } else {
            format!("{lo} 以上")
        };
        let (m2, s2) = mean_se(&ks.iter().map(|r| d2(r)).collect::<Vec<_>>());
        let (c, cs) = contrib(&|r| d1(r) >= lo && d1(r) < hi);
        let (a, as_) = contrib(&|r| d1(r) >= lo);
        line(format!(
            "| {name} | {} | {} | {} | {} | {} | {} |",
            ks.len(),
            pm(
                mean(&ks.iter().map(|r| d1(r)).collect::<Vec<_>>()),
                f64::NAN,
                1
            ),
            pm(m2, s2, 1),
            pm(c, cs, 2),
            pm(a, as_, 2),
            pm(a * per_seat, as_ * per_seat, 2)
        ));
    }
    line(String::new());
    line("### AI 自身の点の差（AI の選んだ候補 − 替える候補）".into());
    line(String::new());
    line("点は、両方に読み直した値があればその値、無ければターン末の点（盤面の評価の点。勝率ではない）".into());
    line(String::new());
    line("| 点の差 | 局面 | うち読み直した値どうし | 二段目の差の平均 | 寄与（1 局面） |".into());
    line("| --- | ---: | ---: | ---: | ---: |".into());
    let gap = |r: &PosRow| -> (f64, bool) {
        let c = r.confirm.map_or(0, |x| x.0);
        let (a, av) = ai_score(r, r.ai);
        let (b, bv) = ai_score(r, c);
        if av && bv {
            (a.unwrap_or(f64::NAN) - b.unwrap_or(f64::NAN), true)
        } else {
            let t = |k: usize| r.v["plans"][k]["turnEnd"].as_f64().unwrap_or(f64::NAN);
            (t(r.ai) - t(c), false)
        }
    };
    let gaps = [f64::NEG_INFINITY, 0.0, 5.0, 20.0, 60.0, f64::INFINITY];
    for k in 0..gaps.len() - 1 {
        let (lo, hi) = (gaps[k], gaps[k + 1]);
        let inb = |r: &PosRow| {
            let g = gap(r).0;
            g >= lo && g < hi
        };
        let ks: Vec<&&PosRow> = flagged.iter().filter(|r| inb(r)).collect();
        let name = match (lo.is_finite(), hi.is_finite()) {
            (false, _) => "0 未満（替える候補のほうが高い）".to_string(),
            (_, false) => format!("{lo} 以上"),
            _ => format!("{lo}〜{hi}"),
        };
        let (m2, s2) = mean_se(&ks.iter().map(|r| d2(r)).collect::<Vec<_>>());
        let (c, cs) = contrib(&|r| inb(r));
        line(format!(
            "| {name} | {} | {} | {} | {} |",
            ks.len(),
            ks.iter().filter(|r| gap(r).1).count(),
            pm(m2, s2, 1),
            pm(c, cs, 2)
        ));
    }
    line(String::new());
    // 安くする決まり: 一段目の前半で AI の選んだ候補に勝っていない候補を、後半は打たない
    line("### 一段目の前半で負けている候補を捨てる".into());
    line(String::new());
    line("一段目の前半（初めの半分の回）で、AI の選んだ候補との差が 0 以下の候補を後半は打たないとしたとき。得は、替える候補が捨てられた局面を 0 とした下限（ほかの候補に替わる分は数えない）".into());
    line(String::new());
    let mut kept_runs = 0usize;
    let mut all_runs = 0usize;
    for r in rows.iter().filter(|r| !r.skip) {
        let m = r.w[r.ai].len();
        let h = m / 2;
        for (c, wc) in r.w.iter().enumerate() {
            all_runs += m;
            let first = mean(&paired(wc, &r.w[r.ai], |t| t < h));
            kept_runs += if c == r.ai || first > 1e-12 { m } else { h };
        }
    }
    let survives = |r: &PosRow| {
        let c = r.confirm.map_or(0, |x| x.0);
        let h = r.w[r.ai].len() / 2;
        mean(&paired(&r.w[c], &r.w[r.ai], |t| t < h)) > 1e-12
    };
    let (a, as_) = contrib(&|r| survives(r));
    let (b, bs) = contrib(&|_| true);
    line("| | 得（1 局面） | （1 試合） | 一段目の打つ回数 |".into());
    line("| --- | ---: | ---: | ---: |".into());
    line(format!(
        "| 今の決まり | {} | {} | 100% |",
        pm(b, bs, 2),
        pm(b * per_seat, bs * per_seat, 2)
    ));
    line(format!(
        "| 前半で負けている候補を捨てる | {} | {} | {} |",
        pm(a, as_, 2),
        pm(a * per_seat, as_ * per_seat, 2),
        fixed(100.0 * kept_runs as f64 / all_runs.max(1) as f64, 0) + "%"
    ));
    line(format!(
        "\n二段目に回した {} 局面のうち、替える候補が前半で負けていて捨てられるのは {}",
        flagged.len(),
        flagged.iter().filter(|r| !survives(r)).count()
    ));
    line(String::new());
}

/// 一段目の全部の回で勝ちが最も多い候補（同じなら AI の選んだ候補）と、AI の選んだ候補の違いの種類
fn best_kind(r: &PosRow) -> String {
    if r.skip {
        return "z: 打ち比べていない".into();
    }
    let score = |c: usize| mean(&r.w[c].iter().filter_map(|x| win_of(*x)).collect::<Vec<_>>());
    let mut best = r.ai;
    for c in 0..r.w.len() {
        if score(c) > score(best) + 1e-12 {
            best = c;
        }
    }
    if best == r.ai {
        return "y: AI の選んだ候補が最も多く勝つ".into();
    }
    let plans = r.v["plans"].as_array().cloned().unwrap_or_default();
    let kind = kind_of(&strs(&plans[r.ai]["used"]), &strs(&plans[best]["used"]));
    format!("{}（{}）", kind, plan_kind(r, best))
}

/// 候補の出どころの名前
const READ: &str = "読み直した候補";
const CUT: &str = "読み直しを打ち切った候補";
const EXTRA: &str = "足した候補";

/// 局面 r の候補 c の出どころ
fn plan_kind(r: &PosRow, c: usize) -> &'static str {
    if r.cut.get(c).copied().unwrap_or(false) {
        CUT
    } else if r.top.get(c).copied().unwrap_or(true) {
        READ
    } else {
        EXTRA
    }
}

const RECHECK_TAG: u32 = 0x5245_4348;

/// svwb survey recheck: 二段目に回した局面を、相手の手札を実際のまま（`--peek 0` なら今までどおり引き直す）で、
/// AI の選んだ候補と替える候補を `--m` 回ずつ打ち直す（2026-11-12、本番の後に足した確かめ。docs/survey.md）。
/// 打ち比べは相手の手札を引き直した世界で測るので、実際の手札でも差が残るかを見る
fn recheck(argv: &[String]) -> Result<(), String> {
    let (flags, files) = parse_flags(argv)?;
    check_flags(&flags, &["out", "m", "peek", "batch"])?;
    let out = flag(&flags, "out")
        .ok_or("--out を渡してください")?
        .to_string();
    let m = num_flag(&flags, "m", 32)?.max(2);
    let peek = num_flag(&flags, "peek", 1)? != 0;
    let batch = num_flag(&flags, "batch", 16)?.max(1) as usize;
    if files.is_empty() {
        return Err("調査の結果（jsonl）を 1 つ以上渡してください".into());
    }
    let mut games: BTreeMap<u64, Value> = BTreeMap::new();
    let mut pos: BTreeMap<(u64, u64), Value> = BTreeMap::new();
    for f in &files {
        for v in read_rows(f)? {
            let g = v["g"].as_u64().unwrap_or(u64::MAX);
            if v["game"] == json!(true) {
                games.insert(g, v);
            } else {
                pos.insert((g, v["i"].as_u64().unwrap_or(u64::MAX)), v);
            }
        }
    }
    let rows: Vec<PosRow> = pos
        .into_iter()
        .filter(|((g, _), _)| games.contains_key(g))
        .map(|(_, v)| pos_row(v))
        .collect();
    let turn_starts: u64 = games
        .values()
        .map(|g| strs_u(&g["turnStarts"]).iter().sum::<u64>())
        .sum();
    let per_seat = turn_starts as f64 / (2.0 * games.len().max(1) as f64);
    let done: HashSet<(u64, u64)> = if std::path::Path::new(&out).exists() {
        read_rows(&out)?
            .iter()
            .map(|v| (v["g"].as_u64().unwrap_or(0), v["i"].as_u64().unwrap_or(0)))
            .collect()
    } else {
        HashSet::new()
    };
    let key = |r: &PosRow| {
        (
            r.v["g"].as_u64().unwrap_or(0),
            r.v["i"].as_u64().unwrap_or(0),
        )
    };
    let todo: Vec<&PosRow> = rows
        .iter()
        .filter(|r| r.confirm.is_some() && !done.contains(&key(r)))
        .collect();
    eprintln!(
        "二段目に回した局面のうち残り {}（済み {}）、{m} 回ずつ、相手の手札は{}、{} スレッド",
        todo.len(),
        done.len(),
        if peek {
            "実際のまま"
        } else {
            "引き直す"
        },
        thread_count()
    );
    for chunk in todo.chunks(batch) {
        // 局面と 2 つの並び（AI の選んだ候補・替える候補）
        // 局面は JSON の文字列で持ち、回ごとに作る（GameState はスレッドをまたいで共有できない）
        let mut items: Vec<(String, PlayerIndex, [Vec<Action>; 2], u32)> = Vec::new();
        for r in chunk {
            let s = r.v["state"].to_string();
            state_from_json(&Json::parse(&s)?)?;
            let p = r.v["p"].as_u64().unwrap_or(0) as PlayerIndex;
            let c = r.confirm.map_or(0, |x| x.0);
            let steps = |k: usize| -> Result<Vec<Action>, String> {
                r.v["plans"][k]["steps"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|a| action_from_json(&Json::parse(&a.to_string())?))
                    .collect()
            };
            let (g, i) = key(r);
            let seed = seed_of(&[RECHECK_TAG, g as u32, i as u32]);
            items.push((s, p, [steps(r.ai)?, steps(c)?], seed));
        }
        let tasks: Vec<(usize, usize, u32)> = (0..items.len())
            .flat_map(|k| (0..2).flat_map(move |w| (0..m).map(move |t| (k, w, t))))
            .collect();
        let res: Vec<char> = parallel_map(
            &tasks,
            |&(k, w, t), _| {
                let (s, p, plans, seed) = &items[k];
                match Json::parse(s).and_then(|j| state_from_json(&j)) {
                    Ok(start) => playout_with(&start, *p, &plans[w], *seed, t, peek),
                    Err(_) => 'x',
                }
            },
            |_, _, _, _| {},
        );
        let mut f = open_append(&out)?;
        for (k, r) in chunk.iter().enumerate() {
            let get = |w: usize| -> String {
                tasks
                    .iter()
                    .zip(&res)
                    .filter(|((kk, ww, _), _)| *kk == k && *ww == w)
                    .map(|(_, c)| *c)
                    .collect()
            };
            let (a, b) = (get(0), get(1));
            let (g, i) = key(r);
            let (c, d2, _) = r.confirm.unwrap_or((0, f64::NAN, f64::NAN));
            let row = json!({
                "g": g, "i": i, "p": r.v["p"], "deck": r.v["deck"], "own": r.v["own"],
                "c": c, "kind": plan_kind(r, c), "d1": r.v["confirm"]["d1"], "d2": round2(d2),
                "peek": peek, "m": m, "ai": a, "alt": b,
            });
            writeln!(f, "{row}").map_err(|e| format!("{out} に書けません: {e}"))?;
        }
        f.sync_all().ok();
    }
    // まとめ
    let back = read_rows(&out)?;
    let n_all = rows.len().max(1) as f64;
    let by: BTreeMap<(u64, u64), &Value> = back
        .iter()
        .map(|v| {
            (
                (v["g"].as_u64().unwrap_or(0), v["i"].as_u64().unwrap_or(0)),
                v,
            )
        })
        .collect();
    let flagged: Vec<&PosRow> = rows.iter().filter(|r| r.confirm.is_some()).collect();
    let pairs: Vec<(&PosRow, f64)> = flagged
        .iter()
        .filter_map(|r| {
            let v = by.get(&key(r))?;
            let d = mean(&paired(&chars(&v["alt"]), &chars(&v["ai"]), |_| true)) * 100.0;
            Some((*r, d))
        })
        .collect();
    println!(
        "# 打ち比べ調査の打ち直し（{}）",
        if peek {
            "相手の手札を実際のまま"
        } else {
            "相手の手札を引き直す"
        }
    );
    println!();
    println!(
        "二段目に回した {} 局面のうち {}。AI の選んだ候補と替える候補を {m} 回ずつ（同じ回は同じ乱数）。山札の中身と順番、乱数の状態は回ごとに作り直す",
        flagged.len(),
        pairs.len()
    );
    println!();
    println!("| | 局面 | 二段目の差（96 回、引き直した世界） | 打ち直した差 | 打ち直した差 − 二段目の差 |");
    println!("| --- | ---: | ---: | ---: | ---: |");
    let d1 = |r: &PosRow| r.v["confirm"]["d1"].as_f64().unwrap_or(f64::NAN);
    type Keep = Box<dyn Fn(&PosRow) -> bool>;
    let groups: Vec<(String, Keep)> = vec![
        ("全部".into(), Box::new(|_| true)),
        ("一段目の差 10〜15".into(), Box::new(move |r| d1(r) < 15.0)),
        (
            "一段目の差 15〜20".into(),
            Box::new(move |r| (15.0..20.0).contains(&d1(r))),
        ),
        (
            "一段目の差 20〜30".into(),
            Box::new(move |r| (20.0..30.0).contains(&d1(r))),
        ),
        (
            "一段目の差 30 以上".into(),
            Box::new(move |r| d1(r) >= 30.0),
        ),
        ("大きなミス".into(), Box::new(is_miss)),
        (
            format!("替える候補が{READ}"),
            Box::new(|r| plan_kind(r, r.confirm.map_or(0, |x| x.0)) == READ),
        ),
        (
            format!("替える候補が{CUT}"),
            Box::new(|r| plan_kind(r, r.confirm.map_or(0, |x| x.0)) == CUT),
        ),
        (
            format!("替える候補が{EXTRA}"),
            Box::new(|r| plan_kind(r, r.confirm.map_or(0, |x| x.0)) == EXTRA),
        ),
    ];
    for (name, keep) in &groups {
        let sel: Vec<&(&PosRow, f64)> = pairs.iter().filter(|(r, _)| keep(r)).collect();
        let a: Vec<f64> = sel
            .iter()
            .map(|(r, _)| r.confirm.map_or(0.0, |x| x.1))
            .collect();
        let b: Vec<f64> = sel.iter().map(|(_, d)| *d).collect();
        let ab: Vec<f64> = b.iter().zip(&a).map(|(x, y)| x - y).collect();
        let (ma, sa) = mean_se(&a);
        let (mb, sb) = mean_se(&b);
        let (md, sd) = mean_se(&ab);
        println!(
            "| {name} | {} | {} | {} | {} |",
            sel.len(),
            pm(ma, sa, 1),
            pm(mb, sb, 1),
            pm(md, sd, 1)
        );
    }
    let contrib = |use_recheck: bool| -> (f64, f64) {
        let mut xs: Vec<f64> = pairs
            .iter()
            .map(|(r, d)| {
                if use_recheck {
                    *d
                } else {
                    r.confirm.map_or(0.0, |x| x.1)
                }
            })
            .collect();
        xs.resize(rows.len(), 0.0);
        mean_se(&xs)
    };
    let (g2, s2) = contrib(false);
    let (gr, sr) = contrib(true);
    println!();
    println!(
        "替える決まり（一段目 10 ポイント以上で替える）の得を打ち直した差で測ると、1 局面 {}・1 試合 {}（二段目で測ると 1 局面 {}・1 試合 {}。選んだ局面 {}）",
        pm(gr, sr, 2),
        pm(gr * per_seat, sr * per_seat, 2),
        pm(g2, s2, 2),
        pm(g2 * per_seat, s2 * per_seat, 2),
        n_all
    );
    Ok(())
}

pub fn main(argv: &[String]) -> Result<(), String> {
    match argv.first().map(|s| s.as_str()) {
        Some("run") => run(&argv[1..]),
        Some("report") => report(&argv[1..]),
        Some("recheck") => recheck(&argv[1..]),
        _ => Err("使い方: svwb survey run --out <結果.jsonl> --games a-b [--rate 0.1] [--m 32] [--extra 4] [--confirm 96] [--flag 10] [--batch 8] | survey report <結果.jsonl>… [--label 名前] [--no-ledger] [--top 20] [--states <フォルダ>] | survey recheck <結果.jsonl>… --out <打ち直し.jsonl> [--m 32] [--peek 1] [--batch 16]".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(rows: &[&str]) -> Vec<Vec<char>> {
        rows.iter().map(|r| r.chars().collect()).collect()
    }

    #[test]
    fn split_gain_selects_on_one_half_and_measures_on_the_other() {
        // 候補 1 は偶数回だけ勝ち、奇数回は負ける。偶数回で選ぶと候補 1 を選ぶが、奇数回で測ると AI の候補 0 より 0.5 悪い。
        // 奇数回で選ぶと AI の候補（同じなら AI）を選び、差は 0
        let ws = w(&["01010101", "10101010"]);
        let g = split_gain(&ws, 0, &[0, 1]);
        assert!((g - (-0.5)).abs() < 1e-9, "{g}");
        // どの回でも勝つ候補は、どちらの半分でも選ばれて差は 1
        let ws = w(&["0000", "1111"]);
        assert!((split_gain(&ws, 0, &[0, 1]) - 1.0).abs() < 1e-9);
        // 選べる候補に入っていなければ選ばない
        assert_eq!(split_gain(&ws, 0, &[0]), 0.0);
        // 打てなかった回（x）は除く
        let ws = w(&["0x00", "1x11"]);
        assert!((split_gain(&ws, 0, &[0, 1]) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn kinds_compare_used_cards() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            kind_of(&s(&["プレイ A", "進化 B"]), &s(&["プレイ C", "進化 B"])),
            "出すカードが違う"
        );
        assert_eq!(
            kind_of(&s(&["プレイ A", "進化 B"]), &s(&["プレイ A"])),
            "進化・超進化が違う"
        );
        assert_eq!(
            kind_of(&s(&["プレイ A"]), &s(&["プレイ A", "エクストラPP"])),
            "融合・能力・エクストラPPが違う"
        );
        assert_eq!(
            kind_of(&s(&["プレイ A"]), &s(&["プレイ A"])),
            "攻撃先・手の順番だけが違う"
        );
    }

    #[test]
    fn misses_need_both_points_and_z() {
        let row = |d: f64, se: f64| PosRow {
            v: Value::Null,
            skip: false,
            ai: 0,
            top: vec![true, true],
            cut: vec![false, false],
            w: Vec::new(),
            confirm: Some((1, d, se)),
        };
        assert!(is_miss(&row(16.0, 5.0)));
        assert!(!is_miss(&row(14.0, 3.0)));
        assert!(!is_miss(&row(16.0, 6.0)));
    }

    /// 探索 AI の pick（自分のターンの最初に候補を打ち比べて選び直す）: 替える線に届かなければ pick なしと同じ手を選び、
    /// 線を −∞ にすれば候補のどれかの最初の手を選ぶ。ターンの途中の判断では打ち比べない
    #[test]
    fn pick_keeps_the_ai_move_unless_a_candidate_clears_the_line() {
        use crate::ai::search::PickByPlayout;
        use crate::ai::Agent;
        let rec = play_game(3, None);
        let with = |threshold: f64| SearchOptions {
            pick: Some(PickByPlayout {
                m: 2,
                extra: 2,
                threshold,
                prune: false,
            }),
            ..SearchOptions::default()
        };
        // 最後のほうの局面（続きが短い）を 1 つ
        let mut tried = 0;
        for &(i, p) in rec.starts.iter().rev() {
            let (s, rng) = rebuild(&rec, i);
            let legal = legal_actions(&s);
            if legal.len() <= 1 {
                continue;
            }
            let base = SearchAgent::new(SearchOptions::default()).choose_action(
                &s,
                &legal,
                &mut Rng::new(rng.state),
            );
            let never =
                SearchAgent::new(with(1000.0)).choose_action(&s, &legal, &mut Rng::new(rng.state));
            assert_eq!(never, base, "g3 i{i}");
            let mut always = SearchAgent::new(with(-1000.0));
            let a = always.choose_action(&s, &legal, &mut Rng::new(rng.state));
            let sv = SearchAgent::new(SearchOptions::default())
                .survey_plans(&s, &legal, &mut Rng::new(rng.state), 2)
                .expect("候補");
            if !sv.lethal && sv.plans.len() >= 2 {
                assert!(
                    sv.plans.iter().any(|pl| pl.steps.first() == Some(&a)),
                    "g3 i{i}: {a:?}"
                );
            }
            // 同じターンの 2 回目の判断では打ち比べない（pick なしと同じ）
            assert_eq!(
                always.choose_action(&s, &legal, &mut Rng::new(rng.state)),
                base,
                "g3 i{i} p{p}"
            );
            tried += 1;
            break;
        }
        assert_eq!(tried, 1);
    }

    /// 替える決まりの表: 一段目の差の幅ごとの寄与を足すと全部の得になり、「この幅から上だけ替える」は上の幅の寄与の和。
    /// 前半で負けている候補を捨てると、その局面の寄与が 0 になる
    #[test]
    fn switch_tables_split_the_stage_two_gain() {
        let row = |d1: f64, d2: f64, w1: &str| PosRow {
            v: json!({"confirm": {"d1": d1}, "plans": [{"value": 10.0}, {"value": 4.0}]}),
            skip: false,
            ai: 0,
            top: vec![true, true],
            cut: vec![false, false],
            w: w(&["00000000", w1]),
            confirm: (d1 >= 10.0).then_some((1, d2, 1.0)),
        };
        // 4 局面: 一段目 12（二段目 −8、前半で負け）・25（二段目 20）・40（二段目 30）・5（回さない）
        let rows = vec![
            row(12.0, -8.0, "00001111"),
            row(25.0, 20.0, "11000000"),
            row(40.0, 30.0, "11110000"),
            row(5.0, 0.0, "00000000"),
        ];
        let mut out = String::new();
        switch_tables(&rows, 10.0, &mut |s: String| {
            out.push_str(&s);
            out.push('\n');
        });
        let cell = |prefix: &str, col: usize| -> String {
            let l = out.lines().find(|l| l.starts_with(prefix)).unwrap_or("");
            l.split('|').nth(col).unwrap_or("").trim().to_string()
        };
        // 全部の得 (−8 + 20 + 30) / 4 = 10.5。15 から上だけ替えると (20 + 30) / 4 = 12.5
        assert!(cell("| 10〜15 ", 6).starts_with("10.50"), "{out}");
        assert!(cell("| 15〜20 ", 6).starts_with("12.50"), "{out}");
        assert!(cell("| 30 以上 ", 6).starts_with("7.50"), "{out}");
        // AI 自身の点の差は 10 − 4 = 6（5〜20 の幅に 3 局面）
        assert_eq!(cell("| 5〜20 ", 2), "3");
        // 前半で負けている候補（1 局面目）を捨てると (20 + 30) / 4 = 12.5
        assert!(
            cell("| 前半で負けている候補を捨てる ", 2).starts_with("12.50"),
            "{out}"
        );
    }

    /// 読み直しを打ち切った候補も入れると、AI が読み直す候補（top）の最初の手は、打ち切りを切った（rescoreRace なし）ときと同じになる。
    /// 打ち切った候補は、読み直した候補にも足した候補にも重ならない
    #[test]
    fn cut_candidates_cover_what_the_ai_started_to_read() {
        let rec = play_game(3, None);
        let mut cuts = 0;
        for &(i, _) in rec.starts.iter().take(16) {
            let (s, rng) = rebuild(&rec, i);
            let legal = legal_actions(&s);
            if legal.len() <= 1 {
                continue;
            }
            let run = |opts: SearchOptions| {
                reset_lethal();
                reset_exact_lethal_cache();
                let mut r = Rng { state: rng.state };
                SearchAgent::new(opts)
                    .survey_plans(&s, &legal, &mut r, 4)
                    .filter(|sv| !sv.lethal)
            };
            let firsts = |sv: &crate::ai::search::Survey| {
                let mut v: Vec<String> = sv
                    .plans
                    .iter()
                    .filter(|x| x.top)
                    .map(|x| format!("{:?}", x.steps[0]))
                    .collect();
                v.sort();
                v
            };
            let (Some(on), Some(off)) = (
                run(SearchOptions::default()),
                run(SearchOptions {
                    rescore_race: None,
                    ..SearchOptions::default()
                }),
            ) else {
                continue;
            };
            assert_eq!(firsts(&on), firsts(&off), "局面 {i}");
            assert!(off.plans.iter().all(|x| !x.cut));
            for x in on.plans.iter().filter(|x| x.cut) {
                assert!(x.top && x.value.is_none() && !x.chosen);
            }
            cuts += on.plans.iter().filter(|x| x.cut).count();
        }
        assert!(cuts > 0, "打ち切った候補のある局面が無い");
    }

    /// 自己対戦の局面を作り直すと試合で打った手を選び、候補は AI の選ぶ手を 1 つだけ含み、打つ手がどれも違う。
    /// 同じ乱数の続きは同じ結果になる
    #[test]
    fn prepares_candidates_from_a_self_play_position() {
        let rec = play_game(3, None);
        let cfg = Cfg {
            rate: 1.0,
            m: 2,
            extra: 4,
            confirm: 0,
            flag: 10.0,
        };
        let recs = [rec];
        let (i, p) = *recs[0]
            .starts
            .iter()
            .find(|(i, p)| {
                let (s, _) = rebuild(&recs[0], *i);
                s.players[*p].turn_count >= 4 && legal_actions(&s).len() > 3
            })
            .expect("手の多い局面");
        let prep = prepare(&recs, 0, i, p, &cfg);
        assert_eq!(prep.row["match"], json!(true), "{}", prep.row["skip"]);
        assert!(prep.skip.is_none());
        assert_eq!(prep.plans.iter().filter(|x| x.chosen).count(), 1);
        for (a, x) in prep.plans.iter().enumerate() {
            for y in &prep.plans[a + 1..] {
                assert_ne!(x.steps, y.steps);
            }
        }
        let (s, _) = rebuild(&recs[0], i);
        let first = playout(&s, p, &prep.plans[prep.ai].steps, prep.seed, 0);
        assert!(matches!(first, '0' | '1' | 'd'), "{first}");
        assert_eq!(
            playout(&s, p, &prep.plans[prep.ai].steps, prep.seed, 0),
            first
        );
    }
}
