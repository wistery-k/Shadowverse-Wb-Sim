//! 試合の記録の検討（段階 4。docs/match-record.md「検討」。設計と審査は共有フォルダの notes/match-record/review-design*.md）。
//!
//!   svwb review run --record <記録.json> --points <局面.jsonl> --out <結果.jsonl> [--m 32] [--confirm 96] [--flag 10] [--opts '<JSON>'] [--all 0|1] [--seat 0|1] [--batch 4]
//!   svwb review zero --out <結果.jsonl> --games a-b --decks <デッキ>,…|@<デッキの組> [--rate 0.3] [--m 32] [--confirm 96] [--flag 10] [--opts '<JSON>'] [--batch 2]
//!   svwb review report <結果.jsonl> [--out <報告.md>]
//!
//! **run**: 勝敗まで入れて保存したプロの試合の記録（`--record`）と、`npm run review`（scripts/review-main.ts）が記録から作った局面（`--points`。
//! ターンごとに、保存した最初の局面と、そこから記録の手順を当てた各手順の前の局面）で、プロの手番ごとに、プロの並びと今の AI の並びを打ち比べる。
//! - 比べる局面: プロの手番のターンの最初と、プロの手番の中の引く手・ランダムな手（`is_chance_step`。AI の並びを区切るのと同じ）の後で、
//!   まだプロの手が残っている局面。そのターンを今のエンジンでたどれない（`--points` の `trace`）ときは、ターンの最初だけ。
//!   「動画と違う」の印か手で直した局面があれば、そこを含む並びと、そのターンのその後の局面は比べない
//! - プロの並び: その局面から、記録の手順を、最初の引く手・ランダムな手まで（その手を含む）か、ターン終了まで。相手の席の手順の前で区切る
//! - AI が見る情報: 局面を読んだらすぐ、手番の側から見えない部分を置き直し（`canonical_view`）、AI が考えるときも打ち比べの各回も、
//!   手番の側から決定化して使う（CLAUDE.md の方針 6）。結果は、見えている部分と両方のデッキの中身だけで決まる
//! - 打ち比べ: プロの並びと AI の選んだ並び（`--all 1` なら AI の候補を全部）を、同じ r 回目の決定化と乱数で `--m` 回最後まで打つ。
//!   並びはそのまま打ち（ターン終了まであればターンを終える。調査と違い、並びの終わりで AI に考え直させない。
//!   プロがカードを残してターンを終えたのに、AI が続きを出してしまわないように）、その先は両方の席とも AI（`--opts` の設定）。
//!   差が `--flag` ポイント以上なら、重ならない乱数でさらに `--confirm` 回ずつ打つ。判定の線は調査と同じ（docs/survey.md）
//! - 記録との突き合わせ: ターンの最初の局面が記録の `turns` の局面と同じこと、局面の手順の番号が記録の手順と並ぶことを確かめる。
//!   プロの並びの手は、記録の手順から読む（`--points` からは読まない）
//!
//! **zero**: 道具の検査（効果 0 の確かめ）。AI どうしの試合（`--decks` の組、`--opts` の設定）を打ち、片方の席の実際の手を「記録の手」として、
//! run と同じ手順（置き直し、区切り、打ち比べ）にかける。記録の手も考え直した手も同じ AI の手なので、差の平均は 0 で、大きな差はほとんど出ないはず。
//!
//! **report**: 結果を Markdown にする。台帳には書かない（道具の確かめの間）。
//!
//! 局面を手で書いて渡す口は無い（run は勝敗のある記録と、記録の turns と合う局面だけを受け取る。CLAUDE.md「ソフト打ち」・試合の記録の線引き 3）。

use super::compare::{compare_pair, deck_options};
use super::deck_compare::read_deck_list;
use super::deep_gap::{
    check_flags, describe, ends_cleanly, flag, num_flag, open_append, parse_flags, read_rows,
    used_of,
};
use super::fixed;
use super::human_plan::{mean_se, mix, parse_range, round2, step_text};
use super::ledger;
use super::options::compare_options;
use super::parallel::{parallel_map, thread_count};
use super::survey::{
    actions_json, float_flag, paired, playout_ends_with, pm, texts, win_of, MISS_POINTS, MISS_Z,
};
use crate::ai::determinize::canonical_view;
use crate::ai::exact_lethal::reset_exact_lethal_cache;
use crate::ai::lethal::reset_lethal;
use crate::ai::search::{is_chance_step, SearchAgent, SearchOptions};
use crate::ai::{seed_of, Agent, Rng};
use crate::data::Deck;
use crate::game::{acting_player, apply_legal, create_game, legal_actions, try_apply_action};
use crate::json::Json;
use crate::sim::play_match;
use crate::state::{Action, GameState, Iid, Phase, PlayerIndex};
use crate::state_json::{action_from_json, action_to_json, state_from_json, state_to_json};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::time::Instant;

/// 局面ごとの乱数に混ぜる印（"REVW"）
const TAG: u32 = 0x5245_5657;
/// AI がリーサルを見つけた局面で、本当にこのターンで勝つかを確かめる回数
const LETHAL_CHECKS: u32 = 8;
/// 打てなかった回（x）がこの割合を超えた局面は「比べられない」
const X_LIMIT: f64 = 0.1;

/// run・zero の設定
struct Cfg {
    m: u32,
    confirm: u32,
    flag: f64,
    all: bool,
    opts: SearchOptions,
}

/// ターンの手順 1 つ
#[derive(Clone, Debug)]
enum TStep {
    Act(Action),
    /// 「動画と違う」の印か、手で直した局面
    Mark,
    /// それ以外（リタイア等）
    Other,
}

/// 記録（または自己対戦）の 1 ターン（手番の側 p から見る）
#[derive(Clone)]
struct Turn {
    /// 記録の turns の添字（自己対戦は試合の中の通し番号）
    t: usize,
    p: PlayerIndex,
    /// ターンの最初の手順の番号（記録の steps の添字。自己対戦は手の番号）
    first_step: usize,
    steps: Vec<TStep>,
    /// states[j] は steps[j] の前の実際の局面（たどれないターンは [0] だけ）
    states: Vec<GameState>,
    /// たどれないなら理由
    trace: Option<String>,
    /// このターンで p が勝った
    won: bool,
    /// 自己対戦の試合番号（記録は None）
    g: Option<u32>,
}

/// プロの並び 1 つ（ターンの j 番目の手順から）
#[derive(Debug, PartialEq)]
struct Chunk {
    j: usize,
    acts: Vec<Action>,
    /// 比べない理由（印を含む・打てない手がある）
    taint: Option<&'static str>,
}

/// ターンの中の、比べる局面とプロの並び（区切りは引く手・ランダムな手、相手の席の手順、ターン終了、印）
fn chunks(turn: &Turn) -> Vec<Chunk> {
    let n = turn.steps.len();
    let p = turn.p;
    let mut out = Vec::new();
    let mut j = 0;
    while j < n {
        // 次のプロの手まで進める（印を越えたら、その後は比べない）
        match &turn.steps[j] {
            TStep::Mark => break,
            TStep::Other => {
                j += 1;
                continue;
            }
            TStep::Act(_) => {}
        }
        let Some(start) = turn.states.get(j) else {
            break;
        };
        if acting_player(start) != p {
            j += 1;
            continue;
        }
        let mut t = start.clone();
        let mut acts = Vec::new();
        let mut taint = None;
        let mut k = j;
        while k < n {
            match &turn.steps[k] {
                TStep::Mark => {
                    taint = Some("mark");
                    break;
                }
                TStep::Other => break,
                TStep::Act(a) => {
                    if acting_player(&t) != p {
                        break;
                    }
                    let Some(after) = try_apply_action(&t, a) else {
                        taint = Some("unplayable");
                        break;
                    };
                    acts.push(a.clone());
                    k += 1;
                    if matches!(a, Action::EndTurn) || is_chance_step(&t, &after, p) {
                        break;
                    }
                    t = after;
                }
            }
        }
        if acts.is_empty() && taint.is_none() {
            break;
        }
        let stop = taint.is_some();
        out.push(Chunk { j, acts, taint });
        if stop {
            break;
        }
        j = k;
    }
    out
}

/// 比べる局面 1 つ（スレッドをまたいで渡すので、局面は JSON の文字列で持つ）
struct Point {
    /// ターン（Turn の t・g・trace・won）
    t: usize,
    g: Option<u32>,
    trace: Option<String>,
    won: bool,
    names: [String; 2],
    step: usize,
    kind: &'static str,
    /// 置き直した局面（JSON）
    state: String,
    p: PlayerIndex,
    pro: Vec<Action>,
    skip: Option<&'static str>,
    seed: u32,
}

impl Point {
    fn game_state(&self) -> GameState {
        state_from_json(&Json::parse(&self.state).expect("局面の JSON")).expect("局面")
    }
}

/// ターンの列から比べる局面を作る（keep で選ぶ。zero の割合）
fn points_of(
    turns: &[Turn],
    names: &[String; 2],
    base: u32,
    keep: impl Fn(&Turn, usize) -> bool,
) -> Vec<Point> {
    let mut out = Vec::new();
    for turn in turns {
        for ch in chunks(turn) {
            let step = turn.first_step + ch.j;
            if !keep(turn, step) {
                continue;
            }
            let state = canonical_view(&turn.states[ch.j], turn.p);
            let skip = ch.taint.or_else(|| {
                if legal_actions(&state).len() <= 1 {
                    Some("one-action")
                } else {
                    None
                }
            });
            out.push(Point {
                t: turn.t,
                g: turn.g,
                trace: turn.trace.clone(),
                won: turn.won,
                names: names.clone(),
                step,
                kind: if ch.j == 0 { "start" } else { "after" },
                state: state_to_json(&state).stringify(),
                p: turn.p,
                pro: ch.acts,
                skip,
                seed: seed_of(&[TAG, base, turn.g.unwrap_or(0), step as u32]),
            });
        }
    }
    out
}

/// 局面 s から手 acts を打った後の局面（ターン終了の前まで。打てない手があれば None）
fn end_of(s: &GameState, acts: &[Action]) -> Option<String> {
    let mut t = s.clone();
    for a in acts {
        if matches!(a, Action::EndTurn) {
            break;
        }
        t = try_apply_action(&t, a)?;
    }
    Some(state_to_json(&t).stringify())
}

/// 手の中の iid を f で付け替えた手
fn map_iids(a: &Action, f: &dyn Fn(Iid) -> Iid) -> Action {
    match a {
        Action::Mulligan { player, swap } => Action::Mulligan {
            player: *player,
            swap: swap.iter().map(|&i| f(i)).collect(),
        },
        Action::Play(i) => Action::Play(f(*i)),
        Action::Attack { attacker, target } => Action::Attack {
            attacker: f(*attacker),
            target: target.map(f),
        },
        Action::Evolve(i) => Action::Evolve(f(*i)),
        Action::SuperEvolve(i) => Action::SuperEvolve(f(*i)),
        Action::Act(i) => Action::Act(f(*i)),
        Action::Fuse { host, materials } => Action::Fuse {
            host: f(*host),
            materials: materials.iter().map(|&i| f(i)).collect(),
        },
        Action::Choose(t) => Action::Choose(t.iter().map(|&i| f(i)).collect()),
        Action::ExtraPp | Action::Mode(_) | Action::EndTurn => a.clone(),
    }
}

/// 並べ替えの全部（k 個の並び）
fn permutations(k: usize) -> Vec<Vec<usize>> {
    if k == 0 {
        return vec![Vec::new()];
    }
    let mut out = Vec::new();
    for rest in permutations(k - 1) {
        for at in 0..=rest.len() {
            let mut v = rest.clone();
            v.insert(at, k - 1);
            out.push(v);
        }
    }
    out
}

/// 並びを打った後の局面が同じか。p の手札の同じカード（iid のほかは同じ）は入れ替えてよいものとして見る
/// （同じカードの 2 枚のどちらを出しても同じ並び。入れ替えの組が多すぎれば、入れ替えずに比べる）
fn same_plan(s: &GameState, p: PlayerIndex, a: &[Action], b: &[Action]) -> bool {
    let Some(want) = end_of(s, a) else {
        return false;
    };
    if end_of(s, b).as_ref() == Some(&want) {
        return true;
    }
    let mut groups: BTreeMap<String, Vec<Iid>> = BTreeMap::new();
    for h in s.players[p].hand.iter() {
        let mut k = h.clone();
        k.iid = 0;
        groups.entry(format!("{k:?}")).or_default().push(h.iid);
    }
    let classes: Vec<Vec<Iid>> = groups.into_values().filter(|v| v.len() >= 2).collect();
    let perms: Vec<Vec<Vec<usize>>> = classes.iter().map(|c| permutations(c.len())).collect();
    let total: usize = perms.iter().map(Vec::len).product();
    if classes.is_empty() || total > 720 {
        return false;
    }
    for n in 0..total {
        let mut rest = n;
        let mut map: BTreeMap<Iid, Iid> = BTreeMap::new();
        for (c, ps) in classes.iter().zip(&perms) {
            let pi = &ps[rest % ps.len()];
            rest /= ps.len();
            for (x, &y) in c.iter().zip(pi) {
                map.insert(*x, c[y]);
            }
        }
        let f = |i: Iid| *map.get(&i).unwrap_or(&i);
        let mapped: Vec<Action> = b.iter().map(|x| map_iids(x, &f)).collect();
        if end_of(s, &mapped).as_ref() == Some(&want) {
            return true;
        }
    }
    false
}

/// AI の並びを、プロの並びと同じ決まりで区切る（最初の引く手・ランダムな手まで。打てない手の前まで）
fn cut_plan(s: &GameState, acts: &[Action], p: PlayerIndex) -> Vec<Action> {
    let mut t = s.clone();
    let mut out = Vec::new();
    for a in acts {
        if matches!(a, Action::EndTurn) {
            out.push(a.clone());
            break;
        }
        let Some(n) = try_apply_action(&t, a) else {
            break;
        };
        out.push(a.clone());
        if is_chance_step(&t, &n, p) {
            break;
        }
        t = n;
    }
    out
}

/// 手の列で使ったもの（打てない手の前まで。used_of と同じ書き方）
fn used_safe(s: &GameState, acts: &[Action]) -> Vec<String> {
    let mut t = s.clone();
    let mut ok = Vec::new();
    for a in acts {
        match try_apply_action(&t, a) {
            Some(n) => {
                ok.push(a.clone());
                t = n;
            }
            None => break,
        }
    }
    used_of(s, &ok)
}

/// 考えた後の局面 1 つ
struct Prep {
    row: Value,
    /// 打ち比べる並び（0 がプロ、1 が AI の選んだ並び、その先は --all の AI の候補）
    play: Vec<Vec<Action>>,
    /// play[c]（c ≥ 1）が AI の候補の何番目か
    play_plan: Vec<Option<usize>>,
    /// AI がリーサルを見つけたときの最初の手
    lethal: Option<Action>,
    sec: f64,
}

fn prepare(pt: &Point, cfg: &Cfg) -> Prep {
    let t0 = Instant::now();
    let st = pt.game_state();
    let s = &st;
    let names = &pt.names;
    let p = pt.p;
    let me = &s.players[p];
    let mut row = json!({
        "turn": pt.t, "g": pt.g, "step": pt.step, "kind": pt.kind, "p": p,
        "gameTurn": s.turn, "own": me.turn_count, "first": s.first == p,
        "deck": names[p], "opp": names[1 - p],
        "maxPp": me.max_pp, "hp": me.leader_hp, "oppHp": s.players[1 - p].leader_hp,
        "trace": pt.trace, "won": pt.won,
        "view": describe(s, p, names),
        "pro": {
            "steps": actions_json(&pt.pro),
            "text": texts(s, &pt.pro, p),
            "used": used_safe(s, &pt.pro),
            "endTurn": pt.pro.last().is_some_and(|a| matches!(a, Action::EndTurn)),
        },
    });
    let mut prep = Prep {
        row: Value::Null,
        play: Vec::new(),
        play_plan: Vec::new(),
        lethal: None,
        sec: 0.0,
    };
    let mut skip = pt.skip;
    if skip.is_none()
        && !pt
            .pro
            .first()
            .is_some_and(|a| try_apply_action(s, a).is_some())
    {
        skip = Some("unplayable");
    }
    if skip.is_none() {
        let legal = legal_actions(s);
        reset_lethal();
        reset_exact_lethal_cache();
        let agent = SearchAgent::new(cfg.opts.clone());
        let mut rng = Rng::new(mix(pt.seed, 0));
        match agent.survey_plans(s, &legal, &mut rng, 4) {
            None => skip = Some("one-action"),
            Some(sv) if sv.lethal => {
                reset_lethal();
                reset_exact_lethal_cache();
                let mut a = SearchAgent::new(cfg.opts.clone());
                let first = a.choose_action(s, &legal, &mut Rng::new(mix(pt.seed, 0)));
                row["lethal"] = json!({
                    "first": serde_json::from_str::<Value>(&action_to_json(&first).stringify()).unwrap_or(Value::Null),
                    "text": step_text(s, &first, p),
                    "proWon": pt.won,
                });
                prep.lethal = Some(first);
            }
            Some(sv) => {
                let root = sv.root.as_ref().unwrap_or(s);
                let pro_end = end_of(s, &pt.pro);
                let mut plans = Vec::new();
                let mut steps_of = Vec::new();
                for pl in &sv.plans {
                    let steps = cut_plan(s, &pl.steps, p);
                    let same = pro_end.is_some() && same_plan(s, p, &pt.pro, &steps);
                    plans.push(json!({
                        "top": pl.top, "cut": pl.cut, "chosen": pl.chosen, "rank": pl.rank,
                        "turnEnd": round2(pl.turn_end), "value": pl.value.map(round2),
                        "steps": actions_json(&steps),
                        "text": texts(s, &steps, p),
                        "full": texts(root, &pl.full, p),
                        "used": used_safe(s, &steps),
                        "usedFull": used_of(root, &pl.full),
                        "samePro": same,
                    }));
                    steps_of.push((steps, same, pl.chosen));
                }
                let pro_in = steps_of.iter().position(|x| x.1);
                row["proIn"] = json!(pro_in);
                row["plans"] = Value::Array(plans);
                row["terminals"] = json!(sv.terminals);
                match steps_of.iter().position(|x| x.2) {
                    None => skip = Some("no-chosen"),
                    Some(ai) => {
                        row["ai"] = json!(ai);
                        let same = steps_of[ai].1;
                        row["same"] = json!(same);
                        if !same {
                            prep.play.push(pt.pro.clone());
                            prep.play_plan.push(None);
                            prep.play.push(steps_of[ai].0.clone());
                            prep.play_plan.push(Some(ai));
                            if cfg.all {
                                for (c, (steps, same, chosen)) in steps_of.iter().enumerate() {
                                    if !same && !chosen {
                                        prep.play.push(steps.clone());
                                        prep.play_plan.push(Some(c));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    row["skip"] = json!(skip);
    row["state"] =
        serde_json::from_str::<Value>(&state_to_json(s).stringify()).unwrap_or(Value::Null);
    prep.row = row;
    prep.sec = t0.elapsed().as_secs_f64();
    prep
}

/// 局面 s から p が並び plan をそのまま打ち、r 回目の乱数で最後まで打った結果の 1 文字と、何ターン後に終わったか
fn play_once(
    cfg: &Cfg,
    s: &GameState,
    p: PlayerIndex,
    plan: &[Action],
    seed: u32,
    r: u32,
) -> (char, i32) {
    let e = playout_ends_with(&cfg.opts, s, p, plan, seed, r, false, true, None);
    (e.result, e.turns)
}

/// 勝ち負けの列の勝率の差（a − b、ポイント）と標準誤差（組にした差）
fn diff(a: &[char], b: &[char]) -> (f64, f64) {
    let d = paired(a, b, |_| true);
    let (m, se) = mean_se(&d);
    (m * 100.0, se * 100.0)
}

/// 比べる局面をまとめて考え、打ち比べた行
fn review_points(points: &[Point], cfg: &Cfg) -> Vec<Value> {
    let mut preps: Vec<Prep> = parallel_map(points, |pt, _| prepare(pt, cfg), |_, _, _, _| {});
    // リーサルの確かめ（AI の最初の手から、AI がこのターンを打つ）
    let litems: Vec<(usize, u32)> = preps
        .iter()
        .enumerate()
        .filter(|(_, x)| x.lethal.is_some())
        .flat_map(|(k, _)| (0..LETHAL_CHECKS).map(move |r| (k, r)))
        .collect();
    let lres: Vec<(char, i32, f64)> = parallel_map(
        &litems,
        |&(k, r), _| {
            let t = Instant::now();
            let pt = &points[k];
            let first = preps[k].lethal.clone().expect("リーサルの手");
            let e = playout_ends_with(
                &cfg.opts,
                &pt.game_state(),
                pt.p,
                &[first],
                pt.seed,
                r,
                false,
                false,
                None,
            );
            (e.result, e.turns, t.elapsed().as_secs_f64())
        },
        |_, _, _, _| {},
    );
    let mut lethal: BTreeMap<usize, (String, bool)> = BTreeMap::new();
    for (&(k, _), (c, turns, sec)) in litems.iter().zip(&lres) {
        let e = lethal.entry(k).or_insert((String::new(), true));
        e.0.push(*c);
        e.1 &= *c == '1' && *turns == 0;
        preps[k].sec += sec;
    }
    // 一段目
    let items: Vec<(usize, u32)> = preps
        .iter()
        .enumerate()
        .filter(|(_, x)| x.play.len() >= 2)
        .flat_map(|(k, _)| (0..cfg.m).map(move |r| (k, r)))
        .collect();
    let res1: Vec<(Vec<char>, f64)> = parallel_map(
        &items,
        |&(k, r), _| {
            let t = Instant::now();
            let pt = &points[k];
            let s = pt.game_state();
            let out = preps[k]
                .play
                .iter()
                .map(|pl| play_once(cfg, &s, pt.p, pl, pt.seed, r).0)
                .collect();
            (out, t.elapsed().as_secs_f64())
        },
        |_, _, _, _| {},
    );
    let mut w1: Vec<Vec<String>> = preps
        .iter()
        .map(|x| vec![String::new(); x.play.len()])
        .collect();
    for (&(k, _), (out, sec)) in items.iter().zip(&res1) {
        for (c, ch) in out.iter().enumerate() {
            w1[k][c].push(*ch);
        }
        preps[k].sec += sec;
    }
    // 二段目: プロと AI の差が --flag 以上なら、重ならない乱数で --confirm 回ずつ
    let flagged: Vec<(usize, f64)> = preps
        .iter()
        .enumerate()
        .filter(|(_, x)| x.play.len() >= 2)
        .filter_map(|(k, _)| {
            let a: Vec<char> = w1[k][0].chars().collect();
            let b: Vec<char> = w1[k][1].chars().collect();
            let (d, _) = diff(&a, &b);
            (d.is_finite() && d.abs() >= cfg.flag).then_some((k, d))
        })
        .collect();
    let items2: Vec<(usize, u32)> = flagged
        .iter()
        .flat_map(|&(k, _)| (cfg.m..cfg.m + cfg.confirm).map(move |r| (k, r)))
        .collect();
    let res2: Vec<([char; 2], f64)> = parallel_map(
        &items2,
        |&(k, r), _| {
            let t = Instant::now();
            let pt = &points[k];
            let s = pt.game_state();
            let a = play_once(cfg, &s, pt.p, &preps[k].play[0], pt.seed, r).0;
            let b = play_once(cfg, &s, pt.p, &preps[k].play[1], pt.seed, r).0;
            ([a, b], t.elapsed().as_secs_f64())
        },
        |_, _, _, _| {},
    );
    let mut w2: BTreeMap<usize, (f64, String, String)> = BTreeMap::new();
    for &(k, d) in &flagged {
        w2.insert(k, (d, String::new(), String::new()));
    }
    for (&(k, _), (pair, sec)) in items2.iter().zip(&res2) {
        let e = w2.get_mut(&k).expect("二段目の局面");
        e.1.push(pair[0]);
        e.2.push(pair[1]);
        preps[k].sec += sec;
    }
    let mut rows = Vec::new();
    for (k, x) in preps.into_iter().enumerate() {
        let mut row = x.row;
        if let Some((w, sure)) = lethal.get(&k) {
            row["lethal"]["w"] = json!(w);
            row["lethal"]["sure"] = json!(sure);
        }
        if x.play.len() >= 2 {
            row["m"] = json!(cfg.m);
            row["w"] = json!({
                "pro": w1[k][0],
                "ai": w1[k][1],
                "others": x.play_plan[2..].iter().zip(&w1[k][2..]).map(|(c, w)| json!({ "plan": c, "w": w })).collect::<Vec<_>>(),
            });
            row["confirm"] = match w2.get(&k) {
                Some((d, a, b)) => json!({ "d1": round2(*d), "n": cfg.confirm, "pro": a, "ai": b }),
                None => Value::Null,
            };
        }
        row["sec"] = round2(x.sec);
        rows.push(row);
    }
    rows
}

// ---------------------------------------------------------------- run

/// 局面の JSON（serde の値）を、今のエンジンで読んで書き直した文字列（記録の局面どうしを比べる形）
fn state_key(v: &Value) -> Result<String, String> {
    let j = Json::parse(&v.to_string())?;
    Ok(state_to_json(&state_from_json(&j)?).stringify())
}

fn state_of(v: &Value) -> Result<GameState, String> {
    state_from_json(&Json::parse(&v.to_string())?)
}

/// 席の名前（`<チーム> <クラス>`。デッキの ID の `<大会>/<チーム>_<クラス>` から）
fn seat_name(seat: &Value) -> String {
    let d = seat["deck"].as_str().unwrap_or("?");
    d.rsplit('/').next().unwrap_or(d).replace('_', " ")
}

/// 記録と局面のファイルからターンの列を作る（記録との突き合わせもここで）
fn record_turns(
    record: &Value,
    points: &[Value],
    seat: Option<PlayerIndex>,
) -> Result<Vec<Turn>, String> {
    if record["format"] != json!("svwb-match-record") {
        return Err("--record が試合の記録のファイルではありません".into());
    }
    let result = &record["result"];
    if result.is_null() {
        return Err(
            "勝敗まで入れて保存した記録だけを検討します（記録に result がありません）".into(),
        );
    }
    let winner = result["winner"]
        .as_u64()
        .ok_or("記録の result が読めません")? as usize;
    let snaps = record["turns"].as_array().filter(|v| !v.is_empty()).ok_or(
        "各ターンの最初の局面（turns）の無い記録は検討しません（画面で書き出した記録を使ってください）",
    )?;
    let steps = record["steps"].as_array().ok_or("記録の手順が読めません")?;
    let mut out = Vec::new();
    for line in points.iter().filter(|v| v["header"] != json!(true)) {
        let t = line["turn"]
            .as_u64()
            .ok_or("局面の行に turn がありません")? as usize;
        let snap = snaps
            .get(t)
            .ok_or_else(|| format!("局面の行のターン {t} が記録にありません"))?;
        let s0 = snap["step"]
            .as_u64()
            .ok_or("記録の turns の step が読めません")? as usize;
        let end = match snaps.get(t + 1) {
            Some(n) => n["step"]
                .as_u64()
                .ok_or("記録の turns の step が読めません")? as usize,
            None => steps.len(),
        };
        let list = line["states"]
            .as_array()
            .filter(|v| !v.is_empty())
            .ok_or("局面の行に states がありません")?;
        // 突き合わせ: ターンの最初の局面は記録の turns の局面と同じ。手順の番号はターンの最初から並ぶ
        if state_key(&list[0]["state"])? != state_key(&snap["state"])? {
            return Err(format!(
                "ターン {t} の最初の局面が、記録の turns の局面と違います"
            ));
        }
        let mut states = Vec::new();
        for (j, x) in list.iter().enumerate() {
            if x["step"].as_u64() != Some((s0 + j) as u64) || s0 + j >= end.max(s0 + 1) {
                return Err(format!(
                    "ターン {t} の局面の手順の番号が、記録の手順と並びません"
                ));
            }
            states.push(state_of(&x["state"])?);
        }
        let trace = line["trace"].as_str().map(str::to_string);
        if trace.is_none() && states.len() != (end - s0).max(1) {
            return Err(format!(
                "ターン {t} はたどれるのに、局面の数が手順の数と違います"
            ));
        }
        let p = states[0].active;
        if seat.is_some_and(|q| q != p) {
            continue;
        }
        let tsteps = steps[s0..end]
            .iter()
            .map(|st| match st["kind"].as_str() {
                Some("action") => Json::parse(&st["action"].to_string())
                    .and_then(|j| action_from_json(&j))
                    .map(TStep::Act),
                Some("mark") | Some("edit") => Ok(TStep::Mark),
                _ => Ok(TStep::Other),
            })
            .collect::<Result<Vec<_>, String>>()?;
        out.push(Turn {
            t,
            p,
            first_step: s0,
            steps: tsteps,
            states,
            trace,
            won: t + 1 == snaps.len() && winner == p,
            g: None,
        });
    }
    Ok(out)
}

fn cfg_of(flags: &[(String, String)]) -> Result<(Cfg, String), String> {
    let opts_text = flag(flags, "opts").unwrap_or("{}").to_string();
    let cfg = Cfg {
        m: num_flag(flags, "m", 32)?.max(2),
        confirm: num_flag(flags, "confirm", 96)?,
        flag: float_flag(flags, "flag", 10.0)?,
        all: num_flag(flags, "all", 0)? != 0,
        opts: compare_options(&opts_text)?,
    };
    Ok((cfg, opts_text))
}

/// 結果の頭の行に足す、回した環境
fn header_common(cfg: &Cfg, opts_text: &str) -> Value {
    let (_, at, commit, _) = ledger::context();
    let opts = Json::parse(opts_text).unwrap_or(Json::Null);
    let files: serde_json::Map<String, Value> = ledger::file_fingerprints(&[&opts])
        .into_iter()
        .map(|(k, v)| {
            (
                k,
                serde_json::from_str(&v.stringify()).unwrap_or(Value::Null),
            )
        })
        .collect();
    json!({
        "header": true, "at": at, "commit": commit, "machine": ledger::machine(), "threads": thread_count(),
        "opts": serde_json::from_str::<Value>(opts_text).unwrap_or(Value::Null), "files": files,
        "m": cfg.m, "confirm": cfg.confirm, "flag": cfg.flag, "all": cfg.all,
    })
}

/// 結果のファイルに既にある分（済んだ単位の番号）を数え、書きかけの単位の行を消す
fn resume(out: &str, unit: &str) -> Result<BTreeSet<u64>, String> {
    let mut done = BTreeSet::new();
    if !std::path::Path::new(out).exists() {
        return Ok(done);
    }
    let rows = read_rows(out)?;
    for v in &rows {
        if let Some(x) = v[unit].as_u64().filter(|_| v["done"] == json!(true)) {
            done.insert(x);
        }
    }
    let keep: Vec<&Value> = rows
        .iter()
        .filter(|v| {
            v["header"] == json!(true) || v[unit].as_u64().is_some_and(|x| done.contains(&x))
        })
        .collect();
    if keep.len() != rows.len() || !ends_cleanly(out) {
        let text: String = keep.iter().map(|v| format!("{v}\n")).collect();
        std::fs::write(out, text).map_err(|e| format!("{out} に書けません: {e}"))?;
    }
    Ok(done)
}

fn write_rows(file: &mut std::fs::File, out: &str, rows: &[Value]) -> Result<(), String> {
    let text: String = rows.iter().map(|v| format!("{v}\n")).collect();
    file.write_all(text.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|e| format!("{out} に書けません: {e}"))
}

/// svwb review run
fn run(argv: &[String]) -> Result<(), String> {
    let (flags, rest) = parse_flags(argv)?;
    if !rest.is_empty() {
        return Err(format!("不明な引数: {}", rest.join(" ")));
    }
    check_flags(
        &flags,
        &[
            "record", "points", "out", "m", "confirm", "flag", "opts", "all", "seat", "batch",
        ],
    )?;
    let rec_path = flag(&flags, "record").ok_or("--record を渡してください")?;
    let pts_path = flag(&flags, "points").ok_or("--points を渡してください")?;
    let out = flag(&flags, "out").ok_or("--out を渡してください")?;
    let seat = match flag(&flags, "seat") {
        None => None,
        Some("0") => Some(0),
        Some("1") => Some(1),
        Some(v) => return Err(format!("--seat は 0 か 1: {v}")),
    };
    let (cfg, opts_text) = cfg_of(&flags)?;
    let batch = num_flag(&flags, "batch", 4)?.max(1) as usize;
    let text =
        std::fs::read_to_string(rec_path).map_err(|e| format!("{rec_path} を読めません: {e}"))?;
    let record: Value =
        serde_json::from_str(&text).map_err(|e| format!("{rec_path} が読めません: {e}"))?;
    let points = read_rows(pts_path)?;
    let turns = record_turns(&record, &points, seat)?;
    let seats = record["meta"]["seats"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let names = [seat_name(&seats[0]), seat_name(&seats[1])];
    let base = record["seed"].as_u64().unwrap_or(0) as u32;
    let done = resume(out, "turn")?;
    let mut file = open_append(out)?;
    if done.is_empty() && std::fs::metadata(out).map_or(true, |m| m.len() == 0) {
        let mut h = header_common(&cfg, &opts_text);
        h["kind"] = json!("record");
        h["record"] = json!(std::path::Path::new(rec_path)
            .file_name()
            .and_then(|x| x.to_str()));
        h["meta"] = json!({
            "eventName": record["meta"]["eventName"], "memo": record["meta"]["memo"],
            "commit": record["meta"]["commit"], "seats": names,
        });
        h["result"] = record["result"].clone();
        h["turns"] = json!(record["turns"].as_array().map_or(0, |v| v.len()));
        h["traces"] = Value::Array(
            turns
                .iter()
                .map(|t| json!({ "turn": t.t, "p": t.p, "trace": t.trace, "marks": t.steps.iter().filter(|s| matches!(s, TStep::Mark)).count() }))
                .collect(),
        );
        write_rows(&mut file, out, &[h])?;
    }
    let todo: Vec<usize> = (0..turns.len())
        .filter(|&i| !done.contains(&(turns[i].t as u64)))
        .collect();
    println!(
        "ターン {} のうち残り {}（済み {}）、一段目 {} 回・二段目 {} 回（差 {} ポイント以上）、{} スレッド",
        turns.len(),
        todo.len(),
        done.len(),
        cfg.m,
        cfg.confirm,
        cfg.flag,
        thread_count()
    );
    let t0 = Instant::now();
    let mut n_points = 0;
    for (n, chunk) in todo.chunks(batch).enumerate() {
        let sel: Vec<usize> = chunk.to_vec();
        let points = points_of(&turns, &names, base, |t, _| {
            sel.iter().any(|&i| turns[i].t == t.t)
        });
        let mut rows = review_points(&points, &cfg);
        n_points += rows.len();
        for &i in &sel {
            rows.push(json!({ "turn": turns[i].t, "done": true }));
        }
        write_rows(&mut file, out, &rows)?;
        let finished = ((n + 1) * batch).min(todo.len());
        let sec = t0.elapsed().as_secs_f64();
        eprintln!(
            "ターン {finished}/{}・局面 {n_points}（{} 秒、残り約 {} 分）",
            todo.len(),
            fixed(sec, 0),
            fixed(
                sec / finished as f64 * (todo.len() - finished) as f64 / 60.0,
                0
            )
        );
    }
    println!(
        "完了: 局面 {n_points}、{} 秒",
        fixed(t0.elapsed().as_secs_f64(), 0)
    );
    Ok(())
}

// ---------------------------------------------------------------- zero

/// zero の試合 1 つ（AI どうし、設定 opts）の手の列
struct ZeroGame {
    g: u32,
    decks: [&'static Deck; 2],
    seed: u32,
    actions: Vec<Action>,
    winner: Option<PlayerIndex>,
}

fn zero_play(g: u32, list: &[&'static Deck], opts: &SearchOptions) -> ZeroGame {
    let (a, b) = compare_pair(list, g, false);
    let seed = g * 7 + 1;
    reset_lethal();
    reset_exact_lethal_cache();
    let mut a0 = SearchAgent::new(deck_options(opts, a));
    let mut a1 = SearchAgent::new(deck_options(opts, b));
    let mut actions = Vec::new();
    let end = play_match(
        &mut [&mut a0, &mut a1],
        [&a.cards, &b.cards],
        seed,
        |_, x| actions.push(x.clone()),
    );
    ZeroGame {
        g,
        decks: [a, b],
        seed,
        actions,
        winner: end.winner,
    }
}

/// zero の試合をターンの列にする
fn zero_turns(z: &ZeroGame) -> (Vec<Turn>, [String; 2], u32) {
    let ZeroGame {
        g,
        decks: [a, b],
        seed,
        ref actions,
        winner,
    } = *z;
    let mut s = create_game([&a.cards, &b.cards], seed);
    let mut states = vec![s.clone()];
    for x in actions {
        s = apply_legal(&s, x);
        states.push(s.clone());
    }
    // ターンの最初（メインフェイズで、ターンが変わった直後。試合の記録の turnSnapshots と同じ）
    let starts: Vec<usize> = (0..actions.len())
        .filter(|&i| {
            let st = &states[i];
            st.phase == Phase::Main
                && st.pending.is_none()
                && (i == 0 || states[i - 1].phase != Phase::Main || states[i - 1].turn != st.turn)
        })
        .collect();
    let mut turns = Vec::new();
    for (k, &i) in starts.iter().enumerate() {
        let e = starts.get(k + 1).copied().unwrap_or(actions.len());
        let p = states[i].active;
        turns.push(Turn {
            t: k,
            p,
            first_step: i,
            steps: actions[i..e].iter().cloned().map(TStep::Act).collect(),
            states: states[i..e].to_vec(),
            trace: None,
            won: k + 1 == starts.len() && winner == Some(p),
            g: Some(g),
        });
    }
    (turns, [a.name.clone(), b.name.clone()], seed)
}

/// svwb review zero
fn zero(argv: &[String]) -> Result<(), String> {
    let (flags, rest) = parse_flags(argv)?;
    if !rest.is_empty() {
        return Err(format!("不明な引数: {}", rest.join(" ")));
    }
    check_flags(
        &flags,
        &[
            "out", "games", "decks", "rate", "m", "confirm", "flag", "opts", "all", "batch",
        ],
    )?;
    let out = flag(&flags, "out").ok_or("--out を渡してください")?;
    let spec = flag(&flags, "decks").ok_or("--decks を渡してください")?;
    let list: Vec<&'static Deck> = read_deck_list(spec)?
        .into_iter()
        .map(|d| &*Box::leak(Box::new(d)))
        .collect();
    if list.len() < 2 {
        return Err("--decks には 2 つ以上のデッキを並べます".into());
    }
    let (a, b) = parse_range(flag(&flags, "games").ok_or("--games a-b を渡してください")?)?;
    if a < 0 || b < a {
        return Err("--games は 0 以上の a-b（a ≤ b）".into());
    }
    let rate = float_flag(&flags, "rate", 0.3)?.min(1.0);
    let (cfg, opts_text) = cfg_of(&flags)?;
    let batch = num_flag(&flags, "batch", 2)?.max(1) as usize;
    let done = resume(out, "g")?;
    let mut file = open_append(out)?;
    if done.is_empty() && std::fs::metadata(out).map_or(true, |m| m.len() == 0) {
        let mut h = header_common(&cfg, &opts_text);
        h["kind"] = json!("zero");
        h["decks"] = json!(spec);
        h["rate"] = json!(rate);
        write_rows(&mut file, out, &[h])?;
    }
    let games: Vec<u32> = (a as u32..=b as u32)
        .filter(|g| !done.contains(&(*g as u64)))
        .collect();
    println!(
        "試合 g{a}〜{b} のうち残り {}（済み {}）、局面の割合 {rate}、一段目 {} 回・二段目 {} 回（差 {} ポイント以上）、{} スレッド",
        games.len(),
        done.len(),
        cfg.m,
        cfg.confirm,
        cfg.flag,
        thread_count()
    );
    let t0 = Instant::now();
    let mut n_points = 0;
    for chunk in games.chunks(batch) {
        let played = parallel_map(
            chunk,
            |&g, _| zero_play(g, &list, &cfg.opts),
            |_, _, _, _| {},
        );
        let mut points = Vec::new();
        for z in &played {
            let (tl, nm, seed) = zero_turns(z);
            points.extend(points_of(&tl, &nm, seed, |t, step| {
                (seed_of(&[TAG, t.g.unwrap_or(0), step as u32]) as f64) / 4_294_967_296.0 < rate
            }));
        }
        let mut rows = review_points(&points, &cfg);
        n_points += rows.len();
        for &g in chunk {
            rows.push(json!({ "g": g, "done": true }));
        }
        write_rows(&mut file, out, &rows)?;
        eprintln!(
            "試合 {}・局面 {n_points}（{} 秒）",
            chunk.last().unwrap_or(&0),
            fixed(t0.elapsed().as_secs_f64(), 0)
        );
    }
    println!(
        "完了: 局面 {n_points}、{} 秒",
        fixed(t0.elapsed().as_secs_f64(), 0)
    );
    Ok(())
}

// ---------------------------------------------------------------- report

/// 局面の行の判定
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Verdict {
    /// 比べない（打てる手が 1 つ・印・打てない）
    Skip,
    Same,
    LethalSame,
    LethalMiss,
    Unclear,
    Small,
    Below,
    ProBetter,
    AiBetter,
}

fn verdict_text(v: Verdict) -> &'static str {
    match v {
        Verdict::Skip => "比べない",
        Verdict::Same => "同じ",
        Verdict::LethalSame => "同じ（リーサル）",
        Verdict::LethalMiss => "リーサルの見落としの候補",
        Verdict::Unclear => "比べられない",
        Verdict::Small => "差は小さい",
        Verdict::Below => "線に届かない",
        Verdict::ProBetter => "プロが大きく良い",
        Verdict::AiBetter => "AI が大きく良い",
    }
}

fn skip_text(s: &str) -> &'static str {
    match s {
        "one-action" => "打てる手が 1 つ",
        "mark" => "動画と違う場面（印・手で直した局面）",
        "unplayable" => "記録の手が打てない",
        "no-chosen" => "AI の選んだ並びが候補に無い",
        _ => "その他",
    }
}

fn chars_of(v: &Value) -> Vec<char> {
    v.as_str().unwrap_or("").chars().collect()
}

/// 判定と、差（ポイント）・標準誤差・どの段か
type Judgement = (Verdict, f64, f64, u8);
/// 局面の行と、その判定
type Judged<'a> = (&'a Value, Judgement);

fn judge(r: &Value) -> Judgement {
    if !r["skip"].is_null() {
        return (Verdict::Skip, f64::NAN, f64::NAN, 0);
    }
    if r["lethal"].is_object() {
        let v = if r["lethal"]["proWon"] == json!(true) {
            Verdict::LethalSame
        } else {
            Verdict::LethalMiss
        };
        return (v, f64::NAN, f64::NAN, 0);
    }
    if r["same"] == json!(true) {
        return (Verdict::Same, f64::NAN, f64::NAN, 0);
    }
    let a = chars_of(&r["w"]["pro"]);
    let b = chars_of(&r["w"]["ai"]);
    let xs = |w: &[char]| w.iter().filter(|c| **c == 'x').count() as f64 / w.len().max(1) as f64;
    if xs(&a) > X_LIMIT || xs(&b) > X_LIMIT {
        return (Verdict::Unclear, f64::NAN, f64::NAN, 1);
    }
    let (d1, se1) = diff(&a, &b);
    if r["confirm"].is_null() {
        return (Verdict::Small, d1, se1, 1);
    }
    let a2 = chars_of(&r["confirm"]["pro"]);
    let b2 = chars_of(&r["confirm"]["ai"]);
    let (d, se) = diff(&a2, &b2);
    let v = if d >= MISS_POINTS && d >= MISS_Z * se {
        Verdict::ProBetter
    } else if -d >= MISS_POINTS && -d >= MISS_Z * se {
        Verdict::AiBetter
    } else {
        Verdict::Below
    };
    (v, d, se, 2)
}

fn strs_of(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

fn md_cell(s: &str) -> String {
    s.replace('|', "／").replace('\n', " ")
}

fn wins(w: &Value) -> String {
    let c = chars_of(w);
    let n = c.iter().filter(|x| **x != 'x').count();
    let win: f64 = c.iter().filter_map(|x| win_of(*x)).sum();
    format!(
        "{}/{}",
        fixed(win, if win.fract() == 0.0 { 0 } else { 1 }),
        n
    )
}

/// svwb review report
fn report(argv: &[String]) -> Result<(), String> {
    let (flags, rest) = parse_flags(argv)?;
    check_flags(&flags, &["out"])?;
    let [path] = rest.as_slice() else {
        return Err("使い方: svwb review report <結果.jsonl> [--out <報告.md>]".into());
    };
    let rows = read_rows(path)?;
    let head = rows
        .iter()
        .find(|v| v["header"] == json!(true))
        .cloned()
        .unwrap_or(Value::Null);
    let pts: Vec<&Value> = rows
        .iter()
        .filter(|v| v["header"] != json!(true) && v["done"] != json!(true))
        .collect();
    let zero = head["kind"] == json!("zero");
    let mut md: Vec<String> = Vec::new();
    let title = if zero {
        format!(
            "# 検討の道具の検査（効果 0）: {}",
            head["decks"].as_str().unwrap_or("?")
        )
    } else {
        format!("# 検討: {}", head["record"].as_str().unwrap_or("?"))
    };
    md.push(title);
    md.push(String::new());
    md.push("**道具の確かめ用の数字です。** 補正は新しいカードを学んでいない（属性で埋めただけの）ものなので、AI の強さや、選手の打ち方の良し悪しを判断するのには使いません。段階 4（新しいプールの学び直し）の後に取り直します。".into());
    md.push(String::new());
    md.push("**偏り**: 並びの先（最初の引く手・ランダムな手の後と、次のターンから）は、両方の席とも AI が打ちます。上手い続きがあって初めて生きるプロの並びは低く出やすく、偏りはプロに不利に働きます。なので「プロが大きく良い」（AI のミスらしい局面）は控えめに出る側で、信じてよい側です。「AI が大きく良い」は、プロの手が悪いとは読めません。".into());
    md.push(String::new());
    if zero {
        md.push(format!(
            "- AI どうしの試合（デッキ {}、局面の割合 {}）。片方の席の実際の手を「記録の手」として比べた。差の平均が 0 に近く、大きな差がほとんど出なければ、道具（置き直し・区切り・乱数の組）に偏りは無い",
            head["decks"].as_str().unwrap_or("?"),
            head["rate"]
        ));
    } else {
        let meta = &head["meta"];
        let seats = strs_of(&meta["seats"]);
        let res = &head["result"];
        let reason = match res["reason"].as_str() {
            Some("leader") => "リーダーの体力",
            Some("deck") => "山札切れ",
            Some("retire") => "リタイア",
            _ => "?",
        };
        let w = res["winner"].as_u64().unwrap_or(9) as usize;
        md.push(format!(
            "- 記録: {}（{}）。先攻 {}、後攻 {}。勝ち: {}（{}）。記録を入れたコミット {}",
            meta["eventName"].as_str().unwrap_or("?"),
            meta["memo"].as_str().unwrap_or(""),
            seats.first().map_or("?", |s| s.as_str()),
            seats.get(1).map_or("?", |s| s.as_str()),
            seats.get(w).map_or("?", |s| s.as_str()),
            reason,
            meta["commit"]
                .as_str()
                .map_or("?", |c| &c[..c.len().min(7)])
        ));
    }
    let files: Vec<String> = head["files"]
        .as_object()
        .map(|o| {
            o.iter()
                .map(|(k, v)| format!("{}（指紋 {}）", k, v.as_str().unwrap_or("?")))
                .collect()
        })
        .unwrap_or_default();
    md.push(format!(
        "- 検討したコミット {}、{}（{} スレッド）、{}。設定 `{}`{}",
        head["commit"].as_str().unwrap_or("?"),
        head["machine"].as_str().unwrap_or("?"),
        head["threads"],
        head["at"].as_str().unwrap_or("?"),
        head["opts"],
        if files.is_empty() {
            String::new()
        } else {
            format!("、{}", files.join("、"))
        }
    ));
    let sec: f64 = pts.iter().filter_map(|r| r["sec"].as_f64()).sum();
    md.push(format!(
        "- 一段目 {} 回ずつ、差が {} ポイント以上なら二段目 {} 回ずつ。大きな差の線は二段目で {} ポイント以上かつ標準誤差の {} 倍以上（調査と同じ）。計算 {} スレッド秒",
        head["m"], head["flag"], head["confirm"], MISS_POINTS, MISS_Z, fixed(sec, 0)
    ));
    if !zero {
        let traces = head["traces"].as_array().cloned().unwrap_or_default();
        let bad: Vec<String> = traces
            .iter()
            .filter(|t| !t["trace"].is_null())
            .map(|t| {
                format!(
                    "ターン {}（{}）",
                    t["turn"].as_u64().unwrap_or(0) + 1,
                    t["trace"].as_str().unwrap_or("")
                )
            })
            .collect();
        let marks: Vec<String> = traces
            .iter()
            .filter(|t| t["marks"].as_u64().unwrap_or(0) > 0)
            .map(|t| format!("ターン {}", t["turn"].as_u64().unwrap_or(0) + 1))
            .collect();
        md.push(format!(
            "- 今のエンジンでたどれないターン: {}。「動画と違う」の印・手で直した局面のあるターン: {}",
            if bad.is_empty() { "無し".into() } else { bad.join("、") },
            if marks.is_empty() { "無し".into() } else { marks.join("、") }
        ));
    }
    md.push(String::new());

    // まとめ
    let judged: Vec<Judged> = pts.iter().map(|r| (*r, judge(r))).collect();
    md.push("## まとめ".into());
    md.push(String::new());
    md.push("| 席 | 局面 | 比べた | 同じ並び | 最初の手が同じ | 使うカードが同じ | プロの並びが AI の候補にある | 差の平均（一段目） |".into());
    md.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |".into());
    let mut seat_keys: Vec<String> = judged
        .iter()
        .map(|(r, _)| r["deck"].as_str().unwrap_or("?").to_string())
        .collect();
    seat_keys.sort();
    seat_keys.dedup();
    let mut keys = seat_keys.clone();
    keys.push("全体".into());
    for key in &keys {
        let sel: Vec<&Judged> = judged
            .iter()
            .filter(|(r, _)| key == "全体" || r["deck"].as_str() == Some(key.as_str()))
            .collect();
        let cmp: Vec<&&Judged> = sel.iter().filter(|(_, j)| j.0 != Verdict::Skip).collect();
        let n = cmp.len().max(1) as f64;
        let same = cmp
            .iter()
            .filter(|(_, j)| matches!(j.0, Verdict::Same | Verdict::LethalSame))
            .count();
        let thought: Vec<&&&Judged> = cmp.iter().filter(|(r, _)| r["ai"].is_u64()).collect();
        let first_same = thought
            .iter()
            .filter(|(r, _)| {
                let ai = r["ai"].as_u64().unwrap_or(0) as usize;
                r["plans"][ai]["text"][0] == r["pro"]["text"][0]
            })
            .count();
        let used_same = thought
            .iter()
            .filter(|(r, _)| {
                let ai = r["ai"].as_u64().unwrap_or(0) as usize;
                sorted(strs_of(&r["plans"][ai]["used"])) == sorted(strs_of(&r["pro"]["used"]))
            })
            .count();
        let pro_in = thought.iter().filter(|(r, _)| r["proIn"].is_u64()).count();
        let ds: Vec<f64> = cmp
            .iter()
            .filter(|(r, _)| r["w"].is_object())
            .flat_map(|(r, _)| {
                paired(&chars_of(&r["w"]["pro"]), &chars_of(&r["w"]["ai"]), |_| {
                    true
                })
            })
            .collect();
        let (dm, dse) = mean_se(&ds);
        let tn = thought.len().max(1) as f64;
        md.push(format!(
            "| {} | {} | {} | {}（{}%） | {}（{}%） | {}（{}%） | {}（{}%） | {} |",
            key,
            sel.len(),
            cmp.len(),
            same,
            fixed(same as f64 / n * 100.0, 0),
            first_same,
            fixed(first_same as f64 / tn * 100.0, 0),
            used_same,
            fixed(used_same as f64 / tn * 100.0, 0),
            pro_in,
            fixed(pro_in as f64 / tn * 100.0, 0),
            pm(dm * 100.0, dse * 100.0, 1)
        ));
    }
    md.push(String::new());
    md.push("- 同じ並びは、比べた局面のうち、プロの並びと AI の選んだ並びの後の局面が同じもの（手札の同じカードのどちらを出したかは問わない。打ち比べない）。最初の手（手の説明が同じ）・使うカード・候補は、AI が考えた局面（リーサルを除く）のうち".into());
    md.push("- 差の平均は、打ち比べた局面の一段目の組にした差（プロ − AI、ポイント）の平均。局面の選び方の偏り（同じ並びを除く）が入るので、目安".into());
    md.push(String::new());
    let mut counts: BTreeMap<Verdict, usize> = BTreeMap::new();
    for (_, j) in &judged {
        *counts.entry(j.0).or_insert(0) += 1;
    }
    let ct: Vec<String> = counts
        .iter()
        .map(|(v, n)| format!("{} {}", verdict_text(*v), n))
        .collect();
    md.push(format!("判定: {}", ct.join("、")));
    let skips: BTreeMap<String, usize> = judged.iter().filter(|(_, j)| j.0 == Verdict::Skip).fold(
        BTreeMap::new(),
        |mut m, (r, _)| {
            *m.entry(skip_text(r["skip"].as_str().unwrap_or("")).to_string())
                .or_insert(0) += 1;
            m
        },
    );
    if !skips.is_empty() {
        let s: Vec<String> = skips.iter().map(|(k, n)| format!("{k} {n}")).collect();
        md.push(format!("（比べない局面の内訳: {}）", s.join("、")));
    }
    md.push(String::new());

    // 局面ごと
    md.push("## 局面ごと".into());
    md.push(String::new());
    md.push(
        "| ターン | 席 | 局面 | プロの並び | AI の並び | 候補 | 判定 | 差（ポイント） |".into(),
    );
    md.push("| --- | --- | --- | --- | --- | --- | --- | ---: |".into());
    let label = |r: &Value| -> String {
        let g = r["g"].as_u64().map_or(String::new(), |g| format!("g{g} "));
        format!(
            "{}{}（{}の {} ターン目{}）",
            g,
            r["turn"].as_u64().unwrap_or(0) + 1,
            if r["first"] == json!(true) {
                "先攻"
            } else {
                "後攻"
            },
            r["own"],
            if r["kind"] == json!("after") {
                "、引いた後"
            } else {
                ""
            }
        )
    };
    // 「AI が大きく良い」のターンの後の局面でプロのほうが良い（10 ポイント以上）なら、続きを AI が打ったせいかもしれない印
    let later_pro_better = |r: &Value| -> bool {
        judged.iter().any(|(x, j)| {
            x["turn"] == r["turn"]
                && x["g"] == r["g"]
                && x["step"].as_u64() > r["step"].as_u64()
                && j.1 >= 10.0
        })
    };
    for (r, (v, d, se, stage)) in &judged {
        let ai_text = match r["ai"].as_u64() {
            Some(ai) => strs_of(&r["plans"][ai as usize]["text"]).join("、"),
            None => match r["lethal"]["text"].as_str() {
                Some(t) => format!("（リーサル）{t}…"),
                None => String::new(),
            },
        };
        let cand = match r["proIn"].as_u64() {
            Some(c) => format!("{} 番目", c + 1),
            None if r["ai"].is_u64() => "無い".into(),
            None => String::new(),
        };
        let mut vt = verdict_text(*v).to_string();
        if *v == Verdict::Skip {
            vt = format!(
                "比べない（{}）",
                skip_text(r["skip"].as_str().unwrap_or(""))
            );
        }
        if *v == Verdict::LethalMiss {
            vt.push_str(if r["lethal"]["sure"] == json!(true) {
                "（確か）"
            } else {
                "（確かではない）"
            });
        }
        if *v == Verdict::AiBetter && later_pro_better(r) {
            vt.push_str("（続きを AI が打ったせいかもしれない）");
        }
        let dtext = if d.is_nan() {
            String::new()
        } else {
            format!("{}（{}段目）", pm(*d, *se, 1), stage)
        };
        md.push(format!(
            "| {} | {} | PP {}、体力 {} 対 {} | {} | {} | {} | {} | {} |",
            label(r),
            md_cell(r["deck"].as_str().unwrap_or("?")),
            r["maxPp"],
            r["hp"],
            r["oppHp"],
            md_cell(&strs_of(&r["pro"]["text"]).join("、")),
            md_cell(&ai_text),
            cand,
            vt,
            dtext
        ));
    }
    md.push(String::new());

    // 大きな差の局面
    let big: Vec<&Judged> = judged
        .iter()
        .filter(|(_, j)| {
            matches!(
                j.0,
                Verdict::ProBetter | Verdict::AiBetter | Verdict::LethalMiss
            )
        })
        .collect();
    md.push("## 大きな差の局面".into());
    md.push(String::new());
    if big.is_empty() {
        md.push("無し".into());
    }
    for (r, (v, d, se, _)) in big {
        md.push(format!(
            "### {}・{}: {}",
            label(r),
            r["deck"].as_str().unwrap_or("?"),
            verdict_text(*v)
        ));
        md.push(String::new());
        for l in strs_of(&r["view"]) {
            md.push(format!("- {l}"));
        }
        md.push(format!(
            "- プロの並び: {}",
            strs_of(&r["pro"]["text"]).join("、")
        ));
        if let Some(ai) = r["ai"].as_u64() {
            let pl = &r["plans"][ai as usize];
            md.push(format!("- AI の並び: {}", strs_of(&pl["text"]).join("、")));
            md.push(format!(
                "- AI が読んだターンの終わりまで: {}",
                strs_of(&pl["full"]).join("、")
            ));
            let others: Vec<String> = r["plans"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .enumerate()
                        .filter(|(c, _)| *c as u64 != ai)
                        .map(|(c, x)| format!("{}. {}", c + 1, strs_of(&x["text"]).join("、")))
                        .collect()
                })
                .unwrap_or_default();
            if !others.is_empty() {
                md.push(format!("- AI の他の候補: {}", others.join(" ／ ")));
            }
            md.push(format!(
                "- 一段目: プロ {} 勝・AI {} 勝。二段目: プロ {} 勝・AI {} 勝（差 {}）",
                wins(&r["w"]["pro"]),
                wins(&r["w"]["ai"]),
                wins(&r["confirm"]["pro"]),
                wins(&r["confirm"]["ai"]),
                pm(*d, *se, 1)
            ));
        }
        if r["lethal"].is_object() {
            md.push(format!(
                "- AI はリーサル（最初の手 {}）。AI がこのターンで勝った回: {}（{}）。プロはこのターンで勝っていない。まれなので、エンジンの計算が動画と違う疑い（ルールやカードの誤り）として先に見る",
                r["lethal"]["text"].as_str().unwrap_or("?"),
                wins(&r["lethal"]["w"]),
                if r["lethal"]["sure"] == json!(true) { "どの回も勝った" } else { "勝たない回があった" }
            ));
        }
        md.push(String::new());
    }
    let text = md.join("\n") + "\n";
    match flag(&flags, "out") {
        Some(o) => {
            std::fs::write(o, &text).map_err(|e| format!("{o} に書けません: {e}"))?;
            println!("{o} に書きました（局面 {}）", pts.len());
        }
        None => print!("{text}"),
    }
    Ok(())
}

pub fn main(argv: &[String]) -> Result<(), String> {
    match argv.first().map(String::as_str) {
        Some("run") => run(&argv[1..]),
        Some("zero") => zero(&argv[1..]),
        Some("report") => report(&argv[1..]),
        _ => Err("使い方: svwb review run|zero|report …（rust/engine/src/runner/review.rs の先頭の説明）".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::super::deck_compare::read_deck;
    use super::*;
    use crate::ai::determinize::determinize;
    use crate::data::data;

    /// 新しいプールの代表のデッキどうしの試合を、既定の AI で途中まで打った局面の列
    fn sample_game(g: u32) -> (Vec<Turn>, [String; 2], u32) {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let list: Vec<&'static Deck> =
            include_str!("../../../../data/pools/azvaldt/sets/rep10.txt")
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(|l| &*Box::leak(Box::new(read_deck(&format!("{root}/{l}")).expect("デッキ"))))
                .collect();
        zero_turns(&zero_play(g, &list, &SearchOptions::default()))
    }

    #[test]
    fn canonical_view_depends_only_on_what_the_viewer_sees() {
        let (turns, _, _) = sample_game(3);
        let turn = turns.iter().find(|t| t.t >= 6).expect("中盤のターン");
        let s = &turn.states[0];
        let p = turn.p;
        let o = 1 - p;
        // 見えない部分だけ変えた局面: 相手の伏せた手札の 1 枚と山札の 1 枚を入れ替え、両方の山札の順番を逆に、局面の乱数を変える
        let mut b = s.clone();
        let hid = (0..b.players[o].hand.len())
            .find(|&i| !b.players[o].hand[i].revealed)
            .expect("伏せた手札");
        let deck_card = b.players[o].deck[0].card;
        let hand_card = b.players[o].hand[hid].card;
        assert_ne!(deck_card, hand_card, "入れ替えて違う局面になる組を選ぶ");
        b.players[o].deck.make_mut()[0].card = hand_card;
        b.players[o].hand.make_mut()[hid].card = deck_card;
        b.players[p].deck.make_mut().reverse();
        b.players[o].deck.make_mut().reverse();
        b.rng = b.rng.wrapping_add(12345);
        assert_ne!(state_to_json(s).stringify(), state_to_json(&b).stringify());
        let ca = canonical_view(s, p);
        let cb = canonical_view(&b, p);
        assert_eq!(
            state_to_json(&ca).stringify(),
            state_to_json(&cb).stringify()
        );
        // 見えている部分はそのまま
        assert_eq!(ca.players[p].hand.len(), s.players[p].hand.len());
        for (x, y) in ca.players[p].hand.iter().zip(s.players[p].hand.iter()) {
            assert_eq!((x.iid, x.card), (y.iid, y.card));
        }
        assert_eq!(
            state_to_json(&ca).get("players"),
            state_to_json(&ca).get("players")
        );
        // 中身（両方のデッキの残り）は変えない
        let multiset = |st: &GameState, q: PlayerIndex| {
            let mut v: Vec<u32> = st.players[q]
                .deck
                .iter()
                .map(|r| r.card as u32)
                .chain(st.players[q].hand.iter().map(|h| h.card as u32))
                .collect();
            v.sort();
            v
        };
        assert_eq!(multiset(&ca, o), multiset(s, o));
        assert_eq!(multiset(&ca, p), multiset(s, p));
        // 置き直した局面からの決定化も、元の局面と同じく、見えている部分を保つ
        let d = determinize(&ca, p, &mut Rng::new(7), false);
        assert_eq!(d.players[p].hand.len(), s.players[p].hand.len());
        assert_eq!(d.players[o].hand.len(), s.players[o].hand.len());
    }

    #[test]
    fn chunks_cut_at_chance_steps_other_seat_and_marks() {
        let (turns, _, _) = sample_game(5);
        let mut seen_after = false;
        for turn in &turns {
            let ch = chunks(turn);
            // 並びをつなぐと、ターンのプロの手を（相手の席の手を除いて）頭から全部覆う
            let mine: Vec<Action> = turn
                .steps
                .iter()
                .zip(&turn.states)
                .filter(|(_, s)| acting_player(s) == turn.p)
                .filter_map(|(x, _)| match x {
                    TStep::Act(a) => Some(a.clone()),
                    _ => None,
                })
                .collect();
            let joined: Vec<Action> = ch.iter().flat_map(|c| c.acts.clone()).collect();
            assert_eq!(joined, mine, "ターン {}", turn.t);
            for (k, c) in ch.iter().enumerate() {
                assert!(c.taint.is_none());
                let last = c.acts.last().expect("手がある");
                let before_last = {
                    let mut t = turn.states[c.j].clone();
                    for a in &c.acts[..c.acts.len() - 1] {
                        t = apply_legal(&t, a);
                    }
                    t
                };
                let after = apply_legal(&before_last, last);
                let cut =
                    matches!(last, Action::EndTurn) || is_chance_step(&before_last, &after, turn.p);
                // 最後の並び以外は、引く手・ランダムな手か、相手の席の手の前で終わる
                if k + 1 < ch.len() {
                    let next_actor = acting_player(&turn.states[c.j + c.acts.len()]);
                    assert!(cut || next_actor != turn.p, "ターン {} の並び {k}", turn.t);
                }
                // 途中の手は区切りにならない
                let mut t = turn.states[c.j].clone();
                for a in &c.acts[..c.acts.len() - 1] {
                    let n = apply_legal(&t, a);
                    assert!(!matches!(a, Action::EndTurn) && !is_chance_step(&t, &n, turn.p));
                    t = n;
                }
                if c.j > 0 {
                    seen_after = true;
                }
            }
        }
        assert!(seen_after, "引いた後の局面が 1 つはある");
        // 印があれば、そこを含む並びは比べず、その後の局面は作らない
        let mut turn = turns
            .into_iter()
            .find(|t| chunks(t).get(1).is_some_and(|c| c.acts.len() >= 2))
            .expect("2 つ目の並びに手が 2 つ以上あるターン");
        let ch = chunks(&turn);
        let at = ch[1].j + 1;
        turn.steps.insert(at, TStep::Mark);
        turn.states.insert(at, turn.states[at].clone());
        let ch2 = chunks(&turn);
        assert_eq!(ch2.len(), 2);
        assert_eq!(ch2[0], ch[0]);
        assert_eq!(ch2[1].taint, Some("mark"));
    }

    #[test]
    fn same_plan_treats_identical_copies_in_hand_as_one() {
        let (turns, _, _) = sample_game(5);
        let mut found = false;
        for turn in &turns {
            let s = canonical_view(&turn.states[0], turn.p);
            let hand = &s.players[turn.p].hand;
            for (i, h) in hand.iter().enumerate() {
                let Some(twin) = hand.iter().skip(i + 1).find(|x| {
                    let mut a = (*x).clone();
                    a.iid = h.iid;
                    format!("{a:?}") == format!("{h:?}")
                }) else {
                    continue;
                };
                let a = [Action::Play(h.iid)];
                let b = [Action::Play(twin.iid)];
                if try_apply_action(&s, &a[0]).is_none() {
                    continue;
                }
                assert!(same_plan(&s, turn.p, &a, &b));
                assert!(same_plan(&s, turn.p, &a, &a));
                assert_ne!(end_of(&s, &a), end_of(&s, &b));
                assert_eq!(permutations(3).len(), 6);
                found = true;
                break;
            }
            if found {
                break;
            }
        }
        assert!(found, "同じカードを 2 枚持つ局面が 1 つはある");
    }

    #[test]
    fn same_plan_and_cut_plan_agree_with_the_pro_cut() {
        let (turns, _, _) = sample_game(5);
        let turn = &turns[4];
        let ch = chunks(turn);
        let s = canonical_view(&turn.states[ch[0].j], turn.p);
        // プロの並びを AI の並びとして区切っても同じ（同じ決まり）
        assert_eq!(cut_plan(&s, &ch[0].acts, turn.p), ch[0].acts);
        assert!(end_of(&s, &ch[0].acts).is_some());
        assert_eq!(
            end_of(&s, &ch[0].acts),
            end_of(&s, &cut_plan(&s, &ch[0].acts, turn.p))
        );
        let _ = data();
    }

    #[test]
    fn review_rows_do_not_depend_on_hidden_information() {
        let (turns, names, seed) = sample_game(3);
        let cfg = Cfg {
            m: 2,
            confirm: 0,
            flag: 1000.0,
            all: false,
            opts: SearchOptions::default(),
        };
        let first_row = |turn: &Turn| -> Vec<Value> {
            let pts = points_of(std::slice::from_ref(turn), &names, seed, |_, _| true);
            review_points(&pts[..1], &cfg)
                .into_iter()
                .map(|mut r| {
                    r["sec"] = Value::Null;
                    r
                })
                .collect()
        };
        let mut played = 0;
        for turn in turns.iter().filter(|t| t.t >= 4) {
            // 見えない部分（相手の伏せた手札と山札の中身の入れ替え、山札の順番、局面の乱数）だけ違う局面
            let mut tb = turn.clone();
            let p = tb.p;
            let o = 1 - p;
            let s = &mut tb.states[0];
            if let Some(hid) =
                (0..s.players[o].hand.len()).find(|&i| !s.players[o].hand[i].revealed)
            {
                let dc = s.players[o].deck[0].card;
                let hc = s.players[o].hand[hid].card;
                s.players[o].deck.make_mut()[0].card = hc;
                s.players[o].hand.make_mut()[hid].card = dc;
            }
            s.players[p].deck.make_mut().reverse();
            s.players[o].deck.make_mut().reverse();
            s.rng = s.rng.wrapping_add(999);
            let a = first_row(turn);
            let b = first_row(&tb);
            assert_eq!(a.len(), 1);
            assert_eq!(a, b, "ターン {}", turn.t);
            if a[0]["w"].is_object() {
                played += 1;
                if played >= 2 {
                    break;
                }
            }
        }
        assert!(played >= 1, "打ち比べた局面が 1 つはある");
    }

    #[test]
    fn record_turns_needs_a_result_and_matching_turn_states() {
        let (turns, _, _) = sample_game(2);
        let st =
            |s: &GameState| serde_json::from_str::<Value>(&state_to_json(s).stringify()).unwrap();
        let t0 = turns
            .iter()
            .find(|t| t.states.len() >= 3)
            .expect("手順が 3 つ以上のターン");
        let steps: Vec<Value> = t0
            .steps
            .iter()
            .map(|x| match x {
                TStep::Act(a) => json!({ "kind": "action", "action": serde_json::from_str::<Value>(&action_to_json(a).stringify()).unwrap() }),
                _ => json!({ "kind": "mark", "note": "" }),
            })
            .collect();
        // 手順の番号を記録の形（ターン 0 が手順 0 から）にそろえる
        let n = steps.len();
        let record = json!({
            "format": "svwb-match-record",
            "seed": 1,
            "meta": { "seats": [{ "deck": "x/A_エルフ" }, { "deck": "x/B_ロイヤル" }] },
            "steps": steps,
            "turns": [{ "turn": 1, "step": 0, "state": st(&t0.states[0]) }],
            "result": { "winner": 0, "reason": "leader" },
        });
        let line = json!({
            "turn": 0,
            "trace": null,
            "states": t0.states.iter().enumerate().map(|(j, s)| json!({ "step": j, "state": st(s) })).collect::<Vec<_>>(),
        });
        let got = record_turns(&record, std::slice::from_ref(&line), None).expect("読める");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].steps.len(), n);
        assert_eq!(chunks(&got[0]), chunks(t0));
        // 勝敗の無い記録は止める
        let mut r2 = record.clone();
        r2["result"] = Value::Null;
        assert!(record_turns(&r2, std::slice::from_ref(&line), None)
            .err()
            .unwrap_or_default()
            .contains("勝敗"));
        // turns の無い記録は止める
        let mut r3 = record.clone();
        r3["turns"] = json!([]);
        assert!(record_turns(&r3, std::slice::from_ref(&line), None).is_err());
        // ターンの最初の局面が記録の turns と違えば止める
        let mut l2 = line.clone();
        l2["states"][0]["state"] = st(&t0.states[1]);
        let e2 = record_turns(&record, &[l2], None).err().unwrap_or_default();
        assert!(e2.contains("turns"), "{e2}");
        // 手順の番号が並ばなければ止める
        let mut l3 = line.clone();
        l3["states"][1]["step"] = json!(5);
        assert!(record_turns(&record, &[l3], None).is_err());
        // たどれないターンは最初の局面だけで、並びは最初の 1 つだけ
        let mut l4 = line.clone();
        l4["trace"] = json!("次のターンの局面と合いません");
        l4["states"] = json!([{ "step": 0, "state": st(&t0.states[0]) }]);
        let got4 = record_turns(&record, &[l4], None).expect("読める");
        assert!(chunks(&got4[0]).len() <= 1);
    }
}
