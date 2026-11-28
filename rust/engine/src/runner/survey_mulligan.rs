//! マリガンの打ち比べ（`svwb survey run --mulligan 1`。2026-11-28、docs/survey.md「マリガンの打ち比べ」）。
//!
//!   svwb survey run --mulligan 1 --out 結果.jsonl --games a-b [--m 16] [--narrow 32] [--narrow-top 2] [--confirm 96] [--flag 0]
//!                   [--reseed 8] [--batch 8] [--decks <デッキ>,…|@<デッキの組>] [--opts '<設定>']
//!   svwb survey report 結果.jsonl…（マリガンの行なら、この報告になる）
//!
//! 自己対戦（打ち比べ調査と同じ試合）の両方の席のマリガンの局面で、返すカードの組の違う返し方（同じカードの 2 枚目は同じに数える）を
//! 今の AI で最後まで打ち比べる:
//! 1. 一段目: どの返し方も `--m` 回（r = 0〜m−1）。r 回目は、手番の側から見た決定化と AI の乱数がどの返し方でも同じ
//! 2. 絞り込み: AI の返し方・それを 1 枚だけ変えた返し方（裏返し。結果で選ばない）・残りのうち一段目で AI との差が大きい `--narrow-top` 個を、
//!    `--narrow` 回足す（r = m〜m+narrow−1）
//! 3. 選ぶ: 絞り込みの返し方のうち、全部の回で AI との差が最も大きいもの。差が `--flag` ポイントより大きければ替える
//! 4. 二段目（確かめ）: 替えた局面だけ、AI の返し方と替えた返し方を、選ぶのに使っていない乱数で `--confirm` 回ずつ
//!
//! 後攻のマリガンは、先攻のマリガンの前まで戻して打つ: 後攻から見た決定化で先攻の手札と山札を配り直し、先攻のマリガンを今の AI に打たせてから、
//! 後攻の返し方を打つ（r ごとに 1 回で、返し方どうしで同じ。相手が今の AI のときの正しい配り方。審査、2026-11-28）。
//! 行には、試合で AI が返し方ごとに付けた `turn1` の点数（`scores`。1 回あたりの評価の平均）と、乱数だけを変えて AI に考え直させた返し方（`reseed`）も書く。
//!
//! 実際の対戦の局面を入れる口は無い（自己対戦の局面だけを扱う。CLAUDE.md「ソフト打ち」）。

use super::deep_gap::flag;
use super::human_plan::{mean_se, mix, round2};
use super::kifu::{RunInfo, Seat};
use super::ledger;
use super::parallel::{parallel_map, thread_count};
use super::survey::{
    kifu_lines, mean, paired, play_game, pm, pos_seed, rebuild, run_opts, win_of, GameRec,
    MISS_POINTS, MISS_Z,
};
use crate::ai::determinize::determinize;
use crate::ai::exact_lethal::reset_exact_lethal_cache;
use crate::ai::lethal::reset_lethal;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::ai::{seed_of, Rng};
use crate::data::Deck;
use crate::game::{acting_player, apply_legal, is_legal, legal_actions};
use crate::sim::MatchRng;
use crate::state::{card, Action, GameState, Phase, PlayerIndex};
use crate::state_json::state_to_json;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

/// 小数 f 桁の文字列。数でない・無限（局面が 1 つで SE が 0 など）は「-」
fn fixed(x: f64, f: usize) -> String {
    if x.is_finite() && x.abs() < 1e21 {
        super::fixed(x, f)
    } else {
        "-".into()
    }
}

/// AI に乱数だけを変えて考え直させるときの印（"MRSD"）
const RESEED_TAG: u32 = 0x4d52_5344;

/// マリガンの打ち比べの設定
#[derive(Clone)]
pub(crate) struct MCfg {
    pub m: u32,
    pub narrow: u32,
    pub narrow_top: usize,
    pub confirm: u32,
    pub flag: f64,
    pub reseed: u32,
    pub opts: SearchOptions,
    pub opts_text: String,
}

/// 1 局面の準備
struct Pos {
    rec: usize,
    p: PlayerIndex,
    seed: u32,
    /// 返し方（返すカードの組ごとに 1 つ）
    options: Vec<Action>,
    ai: usize,
    /// 裏返し（AI の返し方を 1 枚だけ変えた返し方。返し方の添字、重なりなし）
    flips: Vec<usize>,
    row: Value,
    sec: f64,
}

/// 局面の手札の i 番目を返すか（返し方の swap に、その枠の iid があるか）
fn mask_of(hand: &[i32], a: &Action) -> usize {
    match a {
        Action::Mulligan { swap, .. } => hand
            .iter()
            .enumerate()
            .filter(|(_, iid)| swap.contains(iid))
            .fold(0, |m, (j, _)| m | (1 << j)),
        _ => 0,
    }
}

/// 返し方ごとの点の最大（同じなら先）
fn argmax(xs: &[f64]) -> usize {
    let mut best = 0;
    for (k, &x) in xs.iter().enumerate() {
        if x > xs[best] {
            best = k;
        }
    }
    best
}

fn prepare(recs: &[GameRec], k: usize, i: usize, p: PlayerIndex, cfg: &MCfg) -> Pos {
    let t = Instant::now();
    let rec = &recs[k];
    let (s, rng) = rebuild(rec, i);
    let hand: Vec<i32> = s.players[p].hand.iter().map(|h| h.iid).collect();
    let cards: Vec<_> = s.players[p].hand.iter().map(|h| h.card).collect();
    let legal = legal_actions(&s);
    // 返すカードの組（カードの番号を並べたもの）ごとに、合法手の並びで最初の返し方
    let mut keys: Vec<Vec<usize>> = Vec::new();
    let mut options: Vec<Action> = Vec::new();
    let mut class_of = vec![usize::MAX; 1 << hand.len()];
    let mut class_of_legal = Vec::with_capacity(legal.len());
    for a in &legal {
        let mask = mask_of(&hand, a);
        let mut key: Vec<usize> = (0..hand.len())
            .filter(|j| mask >> j & 1 == 1)
            .map(|j| cards[j] as usize)
            .collect();
        key.sort_unstable();
        let c = match keys.iter().position(|x| *x == key) {
            Some(c) => c,
            None => {
                keys.push(key);
                options.push(a.clone());
                options.len() - 1
            }
        };
        class_of[mask] = c;
        class_of_legal.push(c);
    }
    let ai_mask = mask_of(&hand, &rec.actions[i]);
    let ai = class_of[ai_mask];
    let mut flips: Vec<usize> = Vec::new();
    let mut flip_rows = Vec::new();
    for j in 0..hand.len() {
        let c = class_of[ai_mask ^ (1 << j)];
        if c != ai && !flips.contains(&c) {
            flips.push(c);
            flip_rows.push(json!({ "slot": j, "c": c, "ret": ai_mask >> j & 1 == 0 }));
        }
    }
    // 試合で AI が付けた点数（返し方ごとの平均。同じ組の返し方は最初のもの）と、乱数だけを変えて考え直させた返し方
    let agent = SearchAgent::new(cfg.opts.clone());
    let to_options = |xs: &[f64]| -> Vec<f64> {
        (0..options.len())
            .map(|c| {
                let l = class_of_legal.iter().position(|&x| x == c).unwrap_or(0);
                xs[l]
            })
            .collect()
    };
    let scores = agent.turn1_mulligan_scores(&s, &legal, &mut Rng { state: rng.state });
    let matched = scores.as_ref().map(|xs| class_of_legal[argmax(xs)] == ai);
    let seed = pos_seed(rec, i);
    let reseed: Vec<usize> = (0..cfg.reseed)
        .filter_map(|n| {
            let mut r = Rng::new(seed_of(&[RESEED_TAG, seed, n]));
            agent
                .turn1_mulligan_scores(&s, &legal, &mut r)
                .map(|xs| class_of_legal[argmax(&xs)])
        })
        .collect();
    let name = |c: usize| card(cards[c]).name.clone();
    let row = json!({
        "g": rec.g, "i": i, "p": p, "first": s.first == p, "turn": s.turn,
        "deck": rec.names[p], "opp": rec.names[1 - p],
        "hand": (0..hand.len()).map(name).collect::<Vec<_>>(),
        "cards": cards.iter().map(|&c| c as u64).collect::<Vec<_>>(),
        "costs": cards.iter().map(|&c| card(c).cost).collect::<Vec<_>>(),
        "options": options.iter().map(|a| {
            let mask = mask_of(&hand, a);
            json!({
                "mask": mask,
                "ret": (0..hand.len()).filter(|j| mask >> j & 1 == 1).map(name).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
        "masks": class_of,
        "ai": ai, "flips": flip_rows,
        "scores": scores.as_ref().map(|xs| to_options(xs).into_iter().map(|x| (x * 1e4).round() / 1e4).collect::<Vec<_>>()),
        "match": matched,
        "reseed": reseed,
        "state": Value::String(state_to_json(&s).stringify()),
    });
    Pos {
        rec: k,
        p,
        seed,
        options,
        ai,
        flips,
        row,
        sec: t.elapsed().as_secs_f64(),
    }
}

/// 返し方 option を打ってから、両方の席を設定 o の AI で最後まで打った 1 回（p から見た '1' 勝ち・'0' 負け・'d' 引き分け・'x' 打てなかった）。
/// start は試合の最初の局面（先攻のマリガンの前）。p から見た決定化（p の山札の順番、相手の手札・山札、乱数の状態）を r から作り、
/// p が後攻なら、先攻のマリガンを AI に打たせてから option を打つ。決定化と AI の乱数は返し方によらない
pub(crate) fn mulligan_playout(
    o: &SearchOptions,
    start: &GameState,
    p: PlayerIndex,
    option: &Action,
    seed: u32,
    r: u32,
) -> char {
    let res = catch_unwind(AssertUnwindSafe(|| {
        reset_lethal();
        reset_exact_lethal_cache();
        let det = determinize(start, p, &mut Rng::new(mix(seed, 1_000_000 + r)), false);
        let x = mix(seed, 2_000_000 + r);
        let mut rng = MatchRng::with_shared(x, x);
        let mut me = SearchAgent::new(o.clone());
        let mut other = SearchAgent::new(o.clone());
        let mut s = det;
        let mut applied = false;
        for _ in 0..10000 {
            if s.phase == Phase::Ended {
                return Some(match s.winner {
                    Some(w) if w == p => '1',
                    Some(_) => '0',
                    None => 'd',
                });
            }
            let actor = acting_player(&s);
            let a = if !applied && actor == p && s.phase == Phase::Mulligan {
                applied = true;
                // 返し方を選んだ判断の分の乱数を使っておく（後の判断の乱数を、試合で AI が選んだときと同じ並びにする）
                rng.next(&s, p, false);
                if !is_legal(&s, option) {
                    return None;
                }
                option.clone()
            } else {
                let legal = legal_actions(&s);
                if actor == p {
                    rng.choose(&mut me, &s, &legal)
                } else {
                    rng.choose(&mut other, &s, &legal)
                }
            };
            s = apply_legal(&s, &a);
        }
        None
    }))
    .ok()
    .flatten();
    res.unwrap_or('x')
}

/// 同じ回どうしの差（a − b、ポイント）の平均
fn diff(a: &[char], b: &[char]) -> f64 {
    mean(&paired(a, b, |_| true)) * 100.0
}

/// 1 まとまりの試合の行を作る（試合を打ち、両方の席のマリガンで一段目・絞り込み・二段目を打つ）
pub(crate) fn run_batch(
    games: &[u32],
    cfg: &MCfg,
    list: Option<&[&'static Deck]>,
    kifu: Option<(&RunInfo, &[Seat; 2])>,
) -> (Vec<Value>, Vec<(u32, String)>) {
    let recs: Vec<GameRec> = parallel_map(
        games,
        |&g, _| play_game(g, list, &cfg.opts),
        |_, _, _, _| {},
    );
    let mut picks: Vec<(usize, usize, PlayerIndex)> = Vec::new();
    for (k, rec) in recs.iter().enumerate() {
        for (i, a) in rec.actions.iter().enumerate() {
            if let Action::Mulligan { player, .. } = a {
                picks.push((k, i, *player));
            }
        }
    }
    let preps: Vec<Pos> = parallel_map(
        &picks,
        |&(k, i, p), _| prepare(&recs, k, i, p, cfg),
        |_, _, _, _| {},
    );
    // 打ち比べの始めの局面は、試合の最初（先攻のマリガンの前）。後攻のマリガンも、先攻のマリガンを AI に打たせるところから打つ
    let n = preps.len();
    let options: Vec<Vec<Action>> = preps.iter().map(|x| x.options.clone()).collect();
    let meta: Vec<(usize, PlayerIndex, u32)> = preps.iter().map(|x| (x.rec, x.p, x.seed)).collect();
    let mut secs = vec![0.0f64; n];
    let mut rollouts = vec![0u32; n];
    // 回 r の範囲 rs で、局面ごとに sets[k] の返し方を打つ（結果は [局面][sets の何番目][回]）
    let mut play = |sets: &[Vec<usize>], rs: std::ops::Range<u32>| -> Vec<Vec<Vec<char>>> {
        // 1 回ずつ分ける（返し方の数の多い局面でもスレッドが余らないように。決定化と AI の乱数は回 r で決まるので、どのスレッドで打っても同じ）
        let items: Vec<(usize, u32, usize)> = (0..n)
            .flat_map(|k| {
                let len = sets[k].len();
                rs.clone()
                    .flat_map(move |r| (0..len).map(move |j| (k, r, j)))
            })
            .collect();
        let res: Vec<(char, f64)> = parallel_map(
            &items,
            |&(k, r, j), _| {
                let t = Instant::now();
                let (rec, p, seed) = meta[k];
                let (start, _) = rebuild(&recs[rec], 0);
                let out = mulligan_playout(&cfg.opts, &start, p, &options[k][sets[k][j]], seed, r);
                (out, t.elapsed().as_secs_f64())
            },
            |_, _, _, _| {},
        );
        let mut w: Vec<Vec<Vec<char>>> = sets.iter().map(|s| vec![Vec::new(); s.len()]).collect();
        for (&(k, _, j), (ch, sec)) in items.iter().zip(&res) {
            w[k][j].push(*ch);
            secs[k] += sec;
            rollouts[k] += 1;
        }
        w
    };
    // 一段目: どの返し方も m 回
    let all: Vec<Vec<usize>> = preps
        .iter()
        .map(|x| (0..x.options.len()).collect())
        .collect();
    let w1 = play(&all, 0..cfg.m);
    // 絞り込み: AI の返し方・裏返し・一段目で AI との差が大きい narrow_top 個
    let narrow_sets: Vec<(Vec<usize>, Vec<usize>)> = preps
        .iter()
        .enumerate()
        .map(|(k, x)| {
            let mut set = vec![x.ai];
            set.extend(x.flips.iter().copied());
            let mut rest: Vec<(usize, f64)> = (0..x.options.len())
                .filter(|c| !set.contains(c))
                .map(|c| (c, diff(&w1[k][c], &w1[k][x.ai])))
                .filter(|(_, d)| d.is_finite())
                .collect();
            rest.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            let extra: Vec<usize> = rest.iter().take(cfg.narrow_top).map(|x| x.0).collect();
            set.extend(extra.iter().copied());
            (set, extra)
        })
        .collect();
    let sets: Vec<Vec<usize>> = narrow_sets
        .iter()
        .map(|(s, _)| {
            if cfg.narrow > 0 {
                s.clone()
            } else {
                Vec::new()
            }
        })
        .collect();
    let m2 = cfg.m + cfg.narrow;
    let wn = play(&sets, cfg.m..m2);
    // 選ぶ: 絞り込みの返し方の全部の回（一段目＋絞り込み）で、AI との差が最も大きいもの
    let mut chosen: Vec<Option<(usize, f64)>> = vec![None; n];
    for (k, x) in preps.iter().enumerate() {
        let full = |c: usize| -> Vec<char> {
            let mut v = w1[k][c].clone();
            if let Some(j) = sets[k].iter().position(|&y| y == c) {
                v.extend(wn[k][j].iter());
            }
            v
        };
        let ai_w = full(x.ai);
        let mut best: Option<(usize, f64)> = None;
        for &c in narrow_sets[k].0.iter().filter(|&&c| c != x.ai) {
            let d = diff(&full(c), &ai_w);
            if d.is_finite() && best.is_none_or(|(_, b)| d > b) {
                best = Some((c, d));
            }
        }
        chosen[k] = best.filter(|(_, d)| *d > cfg.flag);
    }
    // 二段目: 替えた局面だけ、AI の返し方と替えた返し方を confirm 回
    let csets: Vec<Vec<usize>> = (0..n)
        .map(|k| match chosen[k] {
            Some((c, _)) if cfg.confirm > 0 => vec![preps[k].ai, c],
            _ => Vec::new(),
        })
        .collect();
    let w2 = play(&csets, m2..m2 + cfg.confirm);
    let mut rows = Vec::new();
    for (k, x) in preps.into_iter().enumerate() {
        let mut row = x.row;
        row["m"] = json!(cfg.m);
        row["w"] = json!(w1[k]
            .iter()
            .map(|v| v.iter().collect::<String>())
            .collect::<Vec<_>>());
        row["narrow"] = json!({
            "c": sets[k], "extra": narrow_sets[k].1, "n": cfg.narrow,
            "w": wn[k].iter().map(|v| v.iter().collect::<String>()).collect::<Vec<_>>(),
        });
        row["pick"] = match chosen[k] {
            Some((c, d)) => json!({ "c": c, "d": round2(d) }),
            None => Value::Null,
        };
        row["confirm"] = if csets[k].is_empty() {
            Value::Null
        } else {
            json!({
                "c": csets[k][1], "n": cfg.confirm,
                "ai": w2[k][0].iter().collect::<String>(),
                "alt": w2[k][1].iter().collect::<String>(),
            })
        };
        row["rollouts"] = json!(rollouts[k]);
        row["sec"] = round2(x.sec + secs[k]);
        rows.push(row);
    }
    let (_, _, commit, _) = ledger::context();
    for rec in &recs {
        rows.push(json!({
            "game": true, "mulligan": true, "g": rec.g, "seed": rec.seed,
            "decks": rec.names, "deckKeys": rec.keys,
            "turnStarts": [1, 1], "sampled": 2,
            "winner": rec.winner, "actions": rec.actions.len(), "sec": round2(rec.sec),
            "m": cfg.m, "narrow": cfg.narrow, "narrowTop": cfg.narrow_top,
            "confirm": cfg.confirm, "flag": cfg.flag, "reseed": cfg.reseed,
            "opts": cfg.opts_text,
            "commit": commit, "machine": ledger::machine(), "threads": thread_count(),
        }));
    }
    (rows, kifu_lines(&recs, kifu))
}

// ---------------------------------------------------------------- report

/// 局面の行を読んだもの
struct Row {
    v: Value,
    first: bool,
    deck: String,
    hand: Vec<String>,
    costs: Vec<i64>,
    /// 返し方ごとの、返す枠の印
    masks: Vec<usize>,
    /// 枠の印から返し方の添字
    class_of: Vec<usize>,
    ai: usize,
    /// 裏返し（枠、返し方、返す向きか）
    flips: Vec<(usize, usize, bool)>,
    w1: Vec<Vec<char>>,
    /// 絞り込みの返し方と、その回
    nset: Vec<usize>,
    nextra: Vec<usize>,
    wn: Vec<Vec<char>>,
    pick: Option<(usize, f64)>,
    /// 二段目（替えた返し方、AI、替えた返し方）
    confirm: Option<(usize, Vec<char>, Vec<char>)>,
    scores: Option<Vec<f64>>,
    matched: Option<bool>,
    reseed: Vec<usize>,
}

fn chars(v: &Value) -> Vec<char> {
    v.as_str().unwrap_or("").chars().collect()
}

fn usizes(v: &Value) -> Vec<usize> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_u64())
                .map(|x| x as usize)
                .collect()
        })
        .unwrap_or_default()
}

fn row_of(v: Value) -> Row {
    let strs = |x: &Value| -> Vec<String> {
        x.as_array()
            .map(|a| {
                a.iter()
                    .map(|s| s.as_str().unwrap_or("?").to_string())
                    .collect()
            })
            .unwrap_or_default()
    };
    let flips = v["flips"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|f| {
                    (
                        f["slot"].as_u64().unwrap_or(0) as usize,
                        f["c"].as_u64().unwrap_or(0) as usize,
                        f["ret"].as_bool().unwrap_or(false),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let w = |x: &Value| -> Vec<Vec<char>> {
        x.as_array()
            .map(|a| a.iter().map(chars).collect())
            .unwrap_or_default()
    };
    let confirm = if v["confirm"].is_null() {
        None
    } else {
        Some((
            v["confirm"]["c"].as_u64().unwrap_or(0) as usize,
            chars(&v["confirm"]["ai"]),
            chars(&v["confirm"]["alt"]),
        ))
    };
    let pick = if v["pick"].is_null() {
        None
    } else {
        Some((
            v["pick"]["c"].as_u64().unwrap_or(0) as usize,
            v["pick"]["d"].as_f64().unwrap_or(f64::NAN),
        ))
    };
    Row {
        first: v["first"].as_bool().unwrap_or(false),
        deck: v["deck"].as_str().unwrap_or("?").to_string(),
        hand: strs(&v["hand"]),
        costs: v["costs"]
            .as_array()
            .map(|a| a.iter().map(|x| x.as_i64().unwrap_or(0)).collect())
            .unwrap_or_default(),
        masks: v["options"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|o| o["mask"].as_u64().unwrap_or(0) as usize)
                    .collect()
            })
            .unwrap_or_default(),
        class_of: usizes(&v["masks"]),
        ai: v["ai"].as_u64().unwrap_or(0) as usize,
        flips,
        w1: w(&v["w"]),
        nset: usizes(&v["narrow"]["c"]),
        nextra: usizes(&v["narrow"]["extra"]),
        wn: w(&v["narrow"]["w"]),
        pick,
        confirm,
        scores: v["scores"]
            .as_array()
            .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect()),
        matched: v["match"].as_bool(),
        reseed: usizes(&v["reseed"]),
        v,
    }
}

impl Row {
    /// 返し方 c の、一段目と絞り込みの全部の回
    fn full(&self, c: usize) -> Vec<char> {
        let mut v = self.w1[c].clone();
        if let Some(j) = self.nset.iter().position(|&y| y == c) {
            v.extend(self.wn[j].iter());
        }
        v
    }
    /// 二段目で測る得（ポイント。替えなかった局面は 0）
    fn gain(&self) -> f64 {
        match &self.confirm {
            Some((_, a, b)) => {
                let d = diff(b, a);
                if d.is_finite() {
                    d
                } else {
                    0.0
                }
            }
            None => 0.0,
        }
    }
    /// 二段目の差と、その標準誤差（ポイント）
    fn confirm_se(&self) -> Option<(f64, f64)> {
        self.confirm.as_ref().map(|(_, a, b)| {
            let (m, se) = mean_se(&paired(b, a, |_| true));
            (m * 100.0, se * 100.0)
        })
    }
    /// 大きなミス（二段目の差が MISS_POINTS 以上で、標準誤差の MISS_Z 倍以上）
    fn is_miss(&self) -> bool {
        self.confirm_se()
            .is_some_and(|(d, se)| d >= MISS_POINTS && d >= MISS_Z * se)
    }
    /// 返し方 c で返すカードの名前
    fn ret_names(&self, c: usize) -> Vec<String> {
        (0..self.hand.len())
            .filter(|j| self.masks[c] >> j & 1 == 1)
            .map(|j| self.hand[j].clone())
            .collect()
    }
}

/// コストの区切り
fn cost_bucket(c: i64) -> String {
    if c >= 5 {
        "5 以上".into()
    } else {
        format!("{c}")
    }
}

/// 欄ごとに、局面ごとの値を集めた表（同じ局面の値は平均して 1 つにする）
#[derive(Default)]
struct Cells {
    /// 欄 → 局面の番号 → 値の列
    cells: BTreeMap<String, BTreeMap<usize, Vec<f64>>>,
}

impl Cells {
    fn add(&mut self, key: String, pos: usize, x: f64) {
        if x.is_finite() {
            self.cells
                .entry(key)
                .or_default()
                .entry(pos)
                .or_default()
                .push(x);
        }
    }
    /// 欄ごとの (欄, 局面の数, 平均, 標準誤差)
    fn stats(&self) -> Vec<(String, usize, f64, f64)> {
        self.cells
            .iter()
            .map(|(k, by)| {
                let xs: Vec<f64> = by.values().map(|v| mean(v)).collect();
                let (m, se) = mean_se(&xs);
                (k.clone(), xs.len(), m, se)
            })
            .collect()
    }
}

/// 2 つの列の相関と、y の x への傾き
fn corr_slope(xs: &[f64], ys: &[f64]) -> (f64, f64) {
    let n = xs.len() as f64;
    if xs.len() < 3 {
        return (f64::NAN, f64::NAN);
    }
    let mx = xs.iter().sum::<f64>() / n;
    let my = ys.iter().sum::<f64>() / n;
    let sxy: f64 = xs.iter().zip(ys).map(|(x, y)| (x - mx) * (y - my)).sum();
    let sxx: f64 = xs.iter().map(|x| (x - mx).powi(2)).sum();
    let syy: f64 = ys.iter().map(|y| (y - my).powi(2)).sum();
    (sxy / (sxx * syy).sqrt(), sxy / sxx)
}

/// 偶数回と奇数回の差の相関から、打ち比べの差の信頼度（Spearman–Brown で全部の回に直したもの）
fn reliability(halves: &[(f64, f64)]) -> f64 {
    let (a, b): (Vec<f64>, Vec<f64>) = halves
        .iter()
        .filter(|(x, y)| x.is_finite() && y.is_finite())
        .copied()
        .unzip();
    let (r, _) = corr_slope(&a, &b);
    2.0 * r / (1.0 + r)
}

/// 偶数回・奇数回だけの差
fn half_diffs(a: &[char], b: &[char]) -> (f64, f64) {
    let even = mean(&paired(a, b, |r| r % 2 == 0)) * 100.0;
    let odd = mean(&paired(a, b, |r| r % 2 == 1)) * 100.0;
    (even, odd)
}

/// svwb survey report（マリガンの打ち比べの行）
pub(crate) fn report(
    argv: &[String],
    no_ledger: bool,
    flags: &[(String, String)],
    games: BTreeMap<u64, Value>,
    pos: BTreeMap<(u64, u64), Value>,
) -> Result<(), String> {
    let label = flag(flags, "label").unwrap_or("").to_string();
    let rows: Vec<Row> = pos
        .into_iter()
        .filter(|((g, _), _)| games.contains_key(g))
        .map(|(_, v)| row_of(v))
        .collect();
    let n_games = games.len();
    if n_games == 0 || rows.is_empty() {
        return Err("試合の行・局面の行がありません".into());
    }
    let opts_text = run_opts(&games)?;
    let g0 = games.values().next().cloned().unwrap_or(Value::Null);
    let setting = |k: &str| g0[k].as_f64().unwrap_or(f64::NAN);
    let first_game = *games.keys().next().unwrap_or(&0);
    let last_game = *games.keys().last().unwrap_or(&0);
    let n = rows.len();
    let mut out = String::new();
    let mut line = |s: String| {
        out.push_str(&s);
        out.push('\n');
    };
    line(format!(
        "# マリガンの打ち比べ（{}）",
        if label.is_empty() {
            "名前なし"
        } else {
            &label
        }
    ));
    line(String::new());
    line(format!(
        "試合 {n_games}（g{first_game}〜{last_game}）、局面 {n}（両方の席のマリガン）。一段目 {} 回・絞り込み +{} 回（裏返しと上位 {}）・二段目 {} 回（差 {} ポイントより大きければ替える）。AI の設定 `{opts_text}`。読み方は docs/survey.md「マリガンの打ち比べ」",
        setting("m"),
        setting("narrow"),
        setting("narrowTop"),
        setting("confirm"),
        setting("flag")
    ));
    line(String::new());

    // 1. 取りこぼし
    let gains: Vec<f64> = rows.iter().map(|r| r.gain()).collect();
    let (gm, gse) = mean_se(&gains);
    let switched = rows.iter().filter(|r| r.confirm.is_some()).count();
    let misses: Vec<&Row> = rows.iter().filter(|r| r.is_miss()).collect();
    let (miss_rate, miss_se) = mean_se(
        &rows
            .iter()
            .map(|r| if r.is_miss() { 1.0 } else { 0.0 })
            .collect::<Vec<_>>(),
    );
    line("## 1. 取りこぼし（二段目で測る得）".into());
    line(String::new());
    line("1 試合 1 席のマリガンは 1 回なので、1 局面あたりの得がそのまま 1 試合（片方の席）あたりの得。替えなかった局面は 0。".into());
    line(String::new());
    line("| 分け方 | 局面 | 替えた | 得（1 試合あたり、ポイント） |".into());
    line("| --- | ---: | ---: | ---: |".into());
    let group = |name: String, keep: &dyn Fn(&Row) -> bool, line: &mut dyn FnMut(String)| {
        let xs: Vec<f64> = rows.iter().filter(|r| keep(r)).map(|r| r.gain()).collect();
        let sw = rows
            .iter()
            .filter(|r| keep(r) && r.confirm.is_some())
            .count();
        let (m, se) = mean_se(&xs);
        line(format!(
            "| {name} | {} | {sw} | {} |",
            xs.len(),
            pm(m, se, 2)
        ));
    };
    group("全部".into(), &|_| true, &mut line);
    group("先攻".into(), &|r| r.first, &mut line);
    group("後攻".into(), &|r| !r.first, &mut line);
    let decks: Vec<String> = rows
        .iter()
        .map(|r| r.deck.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    for d in &decks {
        group(format!("型 {d}"), &|r| &r.deck == d, &mut line);
    }
    line(String::new());
    line(format!(
        "- 1 試合あたりの得 **{}**（局面 {n}、替えた {switched}）。2 SE の幅 {} 〜 {}",
        pm(gm, gse, 2),
        fixed(gm - 2.0 * gse, 2),
        fixed(gm + 2.0 * gse, 2)
    ));
    line(format!(
        "- 大きなミス（二段目の差が {MISS_POINTS} ポイント以上で標準誤差の {MISS_Z} 倍以上）: {} 局面（1 試合 1 席 {}）",
        misses.len(),
        pm(miss_rate, miss_se, 3)
    ));
    line(String::new());
    // 替えた局面の内訳（選ぶ段の差の幅・裏返しか・違うカードの枚数）。どの分け方も選ぶ段の回だけで決まるので、二段目の得に偏りは入らない
    line("### 替えた局面の内訳".into());
    line(String::new());
    line("「1 試合あたり」は、その内訳の局面の得の和 ÷ 全部の局面の数（足すと上の得）。".into());
    line(String::new());
    line("| 内訳 | 局面 | 二段目の差（替えた局面の平均） | 1 試合あたり |".into());
    line("| --- | ---: | ---: | ---: |".into());
    let part = |name: &str, keep: &dyn Fn(&Row) -> bool, line: &mut dyn FnMut(String)| {
        let xs: Vec<f64> = rows
            .iter()
            .filter(|r| r.confirm.is_some() && keep(r))
            .map(|r| r.gain())
            .collect();
        let all: Vec<f64> = rows
            .iter()
            .map(|r| {
                if r.confirm.is_some() && keep(r) {
                    r.gain()
                } else {
                    0.0
                }
            })
            .collect();
        let (m, se) = mean_se(&xs);
        let (a, ase) = mean_se(&all);
        line(format!(
            "| {name} | {} | {} | {} |",
            xs.len(),
            pm(m, se, 1),
            pm(a, ase, 2)
        ));
    };
    let d48 = |r: &Row| r.pick.map_or(f64::NAN, |x| x.1);
    part("選ぶ段の差 0〜15", &|r| d48(r) < 15.0, &mut line);
    part(
        "選ぶ段の差 15〜30",
        &|r| (15.0..30.0).contains(&d48(r)),
        &mut line,
    );
    part("選ぶ段の差 30 以上", &|r| d48(r) >= 30.0, &mut line);
    let is_flip = |r: &Row| {
        r.pick
            .is_some_and(|(c, _)| r.flips.iter().any(|f| f.1 == c))
    };
    part("替えた返し方が裏返し（1 枚だけ違う）", &is_flip, &mut line);
    part("替えた返し方がほかの返し方", &|r| !is_flip(r), &mut line);
    part("先攻", &|r| r.first, &mut line);
    part("後攻", &|r| !r.first, &mut line);
    line(String::new());

    // 2. 裏返しの差
    line("## 2. カードの「残す・返す」のずれ（裏返しの差）".into());
    line(String::new());
    line("AI の返し方を 1 枚だけ変えた返し方と AI の返し方の、一段目と絞り込みの全部の回での勝率の差（ポイント、正なら変えたほうが良い）。返し方は打つ前に決まるので選んだ偏りは入らない。同じ局面の値は平均して 1 つに数え、標準誤差は局面どうしのばらつきから。「候補」は 5 局面以上で、(a)(c) は差 ÷ SE の絶対値 2.5 以上、(b) は 3 以上（docs/survey.md「読み方」。候補は別の夜で確かめる）".into());
    line(String::new());
    let dir_name = |ret: bool| {
        if ret {
            "残したのを返す"
        } else {
            "返したのを残す"
        }
    };
    let mut by_deck = Cells::default();
    let mut by_card = Cells::default();
    let mut by_cost = Cells::default();
    let mut by_dir = Cells::default();
    let mut by_seat = Cells::default();
    // turn1 の点数の差と打ち比べの差（裏返しは全部の回、ほかの返し方は一段目だけ）
    let mut rel: Vec<(f64, f64, bool, f64, f64)> = Vec::new();
    let mut rel_all: Vec<(f64, f64, bool)> = Vec::new();
    let mut q_split: Vec<f64> = Vec::new();
    let mut sd_roll: Vec<f64> = Vec::new();
    for (k, r) in rows.iter().enumerate() {
        let ai_w = r.full(r.ai);
        for &(slot, c, ret) in &r.flips {
            let fw = r.full(c);
            let d = diff(&fw, &ai_w);
            let card_name = r.hand.get(slot).cloned().unwrap_or_default();
            by_deck.add(format!("{}\t{}", r.deck, dir_name(ret)), k, d);
            by_card.add(
                format!("{}\t{}\t{}", r.deck, card_name, dir_name(ret)),
                k,
                d,
            );
            by_cost.add(
                format!(
                    "{}\t{}",
                    cost_bucket(*r.costs.get(slot).unwrap_or(&0)),
                    dir_name(ret)
                ),
                k,
                d,
            );
            by_dir.add(dir_name(ret).to_string(), k, d);
            by_seat.add(
                format!(
                    "{}\t{}",
                    if r.first { "先攻" } else { "後攻" },
                    dir_name(ret)
                ),
                k,
                d,
            );
            let ds = paired(&fw, &ai_w, |_| true);
            if !ds.is_empty() {
                q_split.push(ds.iter().filter(|x| **x != 0.0).count() as f64 / ds.len() as f64);
                let (_, se) = mean_se(&ds);
                sd_roll.push(se * (ds.len() as f64).sqrt() * 100.0);
            }
            if let Some(sc) = &r.scores {
                let (e, o) = half_diffs(&fw, &ai_w);
                rel.push((sc[c] - sc[r.ai], d, r.first, e, o));
            }
        }
        if let Some(sc) = &r.scores {
            for c in 0..r.w1.len() {
                if c != r.ai {
                    rel_all.push((sc[c] - sc[r.ai], diff(&r.w1[c], &r.w1[r.ai]), r.first));
                }
            }
        }
    }
    let mark = |m: f64, se: f64, z: f64, ok: bool| {
        if ok && se.is_finite() && se > 0.0 && (m / se).abs() >= z {
            "候補"
        } else {
            ""
        }
    };
    line("### 向きごと・先攻後攻ごと".into());
    line(String::new());
    line("| 分け方 | 局面 | 差 | 差 ÷ SE |".into());
    line("| --- | ---: | ---: | ---: |".into());
    for (k, np, m, se) in by_dir.stats().into_iter().chain(by_seat.stats()) {
        line(format!(
            "| {} | {np} | {} | {} |",
            k.replace('\t', "・"),
            pm(m, se, 2),
            fixed(m / se, 2)
        ));
    }
    line(String::new());
    line("### (a) 型 × 向き".into());
    line(String::new());
    line("| 型 | 向き | 局面 | 差 | 差 ÷ SE | |".into());
    line("| --- | --- | ---: | ---: | ---: | --- |".into());
    for (k, np, m, se) in by_deck.stats() {
        let mut it = k.split('\t');
        line(format!(
            "| {} | {} | {np} | {} | {} | {} |",
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
            pm(m, se, 2),
            fixed(m / se, 2),
            mark(m, se, 2.5, np >= 5)
        ));
    }
    line(String::new());
    line("### (c) コスト × 向き".into());
    line(String::new());
    line("| コスト | 向き | 局面 | 差 | 差 ÷ SE | |".into());
    line("| --- | --- | ---: | ---: | ---: | --- |".into());
    for (k, np, m, se) in by_cost.stats() {
        let mut it = k.split('\t');
        line(format!(
            "| {} | {} | {np} | {} | {} | {} |",
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
            pm(m, se, 2),
            fixed(m / se, 2),
            mark(m, se, 2.5, np >= 5)
        ));
    }
    line(String::new());
    // AI がそのカードを残した割合（型 × カード、手札の枠で数える）
    let mut kept: BTreeMap<(String, String), (usize, usize)> = BTreeMap::new();
    for r in &rows {
        for (j, name) in r.hand.iter().enumerate() {
            let e = kept.entry((r.deck.clone(), name.clone())).or_default();
            e.1 += 1;
            if r.masks[r.ai] >> j & 1 == 0 {
                e.0 += 1;
            }
        }
    }
    line("### (b) 型 × カード × 向き".into());
    line(String::new());
    line(
        "「AI が残した割合」は、そのカードが初手にあった枠のうち AI が残した割合（向きによらない）"
            .into(),
    );
    line(String::new());
    line("| 型 | カード | AI が残した割合 | 向き | 局面 | 差 | 差 ÷ SE | |".into());
    line("| --- | --- | ---: | --- | ---: | ---: | ---: | --- |".into());
    for (k, np, m, se) in by_card.stats() {
        let mut it = k.split('\t');
        let (deck, name, dir) = (
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
        );
        let (kk, nn) = kept
            .get(&(deck.to_string(), name.to_string()))
            .copied()
            .unwrap_or((0, 0));
        line(format!(
            "| {deck} | {name} | {kk}/{nn} | {dir} | {np} | {} | {} | {} |",
            pm(m, se, 1),
            fixed(m / se, 2),
            mark(m, se, 3.0, np >= 5)
        ));
    }
    line(String::new());

    // 2′. 残すと返すの平均の差（一段目だけ。全部の返し方を 16 回ずつ打った回）
    line("## 2′. 残すと返すの平均の差（一段目）".into());
    line(String::new());
    line("一段目（どの返し方も同じ回数）で、そのカードの枠を残す返し方の平均と返す返し方の平均の差（ポイント、正なら残すほうが良い）。ほかの枠の扱いを全部ならしたもの。同じカードの枠が 2 つ以上あれば平均".into());
    line(String::new());
    let mut marg = Cells::default();
    let mut marg_cost = Cells::default();
    for (k, r) in rows.iter().enumerate() {
        let mut per_card: BTreeMap<String, (Vec<f64>, i64)> = BTreeMap::new();
        let m = r.w1.first().map_or(0, |w| w.len());
        let full_masks = r.class_of.len();
        for j in 0..r.hand.len() {
            let mut ds = Vec::new();
            for t in 0..m {
                let (mut kw, mut kn, mut rw, mut rn) = (0.0, 0.0, 0.0, 0.0);
                for mask in 0..full_masks {
                    let c = r.class_of[mask];
                    let Some(x) =
                        r.w1.get(c)
                            .and_then(|w| w.get(t))
                            .and_then(|ch| win_of(*ch))
                    else {
                        continue;
                    };
                    if mask >> j & 1 == 1 {
                        rw += x;
                        rn += 1.0;
                    } else {
                        kw += x;
                        kn += 1.0;
                    }
                }
                if kn > 0.0 && rn > 0.0 {
                    ds.push((kw / kn - rw / rn) * 100.0);
                }
            }
            let e = per_card
                .entry(r.hand[j].clone())
                .or_insert((Vec::new(), *r.costs.get(j).unwrap_or(&0)));
            e.0.push(mean(&ds));
        }
        for (name, (xs, cost)) in per_card {
            let x = mean(&xs);
            marg.add(format!("{}\t{}", r.deck, name), k, x);
            marg_cost.add(cost_bucket(cost), k, x);
        }
    }
    line("| コスト | 局面 | 残す − 返す | 差 ÷ SE | |".into());
    line("| --- | ---: | ---: | ---: | --- |".into());
    for (k, np, m, se) in marg_cost.stats() {
        line(format!(
            "| {k} | {np} | {} | {} | {} |",
            pm(m, se, 2),
            fixed(m / se, 2),
            mark(m, se, 2.5, np >= 5)
        ));
    }
    line(String::new());
    line("| 型 | カード | AI が残した割合 | 局面 | 残す − 返す | 差 ÷ SE | |".into());
    line("| --- | --- | ---: | ---: | ---: | ---: | --- |".into());
    for (k, np, m, se) in marg.stats() {
        let mut it = k.split('\t');
        let (deck, name) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
        let (kk, nn) = kept
            .get(&(deck.to_string(), name.to_string()))
            .copied()
            .unwrap_or((0, 0));
        line(format!(
            "| {deck} | {name} | {kk}/{nn} | {np} | {} | {} | {} |",
            pm(m, se, 1),
            fixed(m / se, 2),
            mark(m, se, 3.0, np >= 5)
        ));
    }
    line(String::new());

    // 3. AI の採点と打ち比べ
    line("## 3. AI の採点（turn1 の点数）と打ち比べの差".into());
    line(String::new());
    line("試合で AI が返し方ごとに付けた点数（1 回あたりの評価の平均）の、AI の返し方との差と、打ち比べの差（ポイント）の関係。裏返しは全部の回、ほかの返し方は一段目だけ。割り戻した相関は、打ち比べの差の偶数回と奇数回の相関から出した信頼度で割ったもの（打ち比べの回が少ないことによるぶれを除いた見込み）".into());
    line(String::new());
    line("| 組 | 数 | 相関 | 傾き（点 1 あたりのポイント） | 打ち比べの差の信頼度 | 割り戻した相関 |".into());
    line("| --- | ---: | ---: | ---: | ---: | ---: |".into());
    for (name, keep) in [
        ("裏返し・全部", None),
        ("裏返し・先攻", Some(true)),
        ("裏返し・後攻", Some(false)),
    ] {
        let xs: Vec<&(f64, f64, bool, f64, f64)> = rel
            .iter()
            .filter(|x| keep.is_none_or(|f| x.2 == f) && x.0.is_finite() && x.1.is_finite())
            .collect();
        let (c, s) = corr_slope(
            &xs.iter().map(|x| x.0).collect::<Vec<_>>(),
            &xs.iter().map(|x| x.1).collect::<Vec<_>>(),
        );
        let relia = reliability(&xs.iter().map(|x| (x.3, x.4)).collect::<Vec<_>>());
        line(format!(
            "| {name} | {} | {} | {} | {} | {} |",
            xs.len(),
            fixed(c, 3),
            fixed(s, 3),
            fixed(relia, 3),
            if relia > 0.05 {
                fixed(c / relia.sqrt(), 3)
            } else {
                "-".into()
            }
        ));
    }
    let xs: Vec<&(f64, f64, bool)> = rel_all
        .iter()
        .filter(|x| x.0.is_finite() && x.1.is_finite())
        .collect();
    let (c, s) = corr_slope(
        &xs.iter().map(|x| x.0).collect::<Vec<_>>(),
        &xs.iter().map(|x| x.1).collect::<Vec<_>>(),
    );
    line(format!(
        "| 全部の返し方（一段目） | {} | {} | {} | - | - |",
        xs.len(),
        fixed(c, 3),
        fixed(s, 3)
    ));
    line(String::new());
    // AI の返し方の、一段目での順位と、乱数だけを変えたときの揺れ
    let ranks: Vec<f64> = rows
        .iter()
        .map(|r| {
            let wins = |c: usize| r.w1[c].iter().filter_map(|ch| win_of(*ch)).sum::<f64>();
            let a = wins(r.ai);
            1.0 + (0..r.w1.len()).filter(|&c| wins(c) > a).count() as f64
        })
        .collect();
    let with_reseed: Vec<&Row> = rows.iter().filter(|r| !r.reseed.is_empty()).collect();
    let changed: f64 = with_reseed
        .iter()
        .map(|r| r.reseed.iter().filter(|&&c| c != r.ai).count() as f64 / r.reseed.len() as f64)
        .sum::<f64>()
        / with_reseed.len().max(1) as f64;
    let any_changed = with_reseed
        .iter()
        .filter(|r| r.reseed.iter().any(|&c| c != r.ai))
        .count();
    let matched = rows.iter().filter(|r| r.matched == Some(true)).count();
    let n_match = rows.iter().filter(|r| r.matched.is_some()).count();
    line(format!(
        "- AI の返し方の、一段目の勝ちの数での順位の平均 {}（返し方の数の平均 {}）",
        fixed(mean(&ranks), 2),
        fixed(
            mean(&rows.iter().map(|r| r.w1.len() as f64).collect::<Vec<_>>()),
            2
        )
    ));
    line(format!(
        "- 乱数だけを変えて AI に考え直させると（局面ごとに {} 回）、試合の返し方と違う返し方を選んだ割合 {}、1 回でも違った局面 {}/{}",
        setting("reseed"),
        super::human_plan::pct(changed),
        any_changed,
        with_reseed.len()
    ));
    line(format!(
        "- 点数から選んだ返し方が試合の返し方と同じだった局面 {matched}/{n_match}（違えば点数の取り出しが試合と違う）"
    ));
    line(String::new());

    // 4. 調べ
    let sec: f64 = rows
        .iter()
        .map(|r| r.v["sec"].as_f64().unwrap_or(0.0))
        .sum();
    let n_roll: f64 = rows
        .iter()
        .map(|r| r.v["rollouts"].as_f64().unwrap_or(0.0))
        .sum();
    let x_count: usize = rows
        .iter()
        .map(|r| {
            r.w1.iter()
                .chain(r.wn.iter())
                .map(|w| w.iter().filter(|&&c| c == 'x').count())
                .sum::<usize>()
        })
        .sum();
    line("## 4. 調べ".into());
    line(String::new());
    line(format!(
        "- 裏返しと AI の返し方で、同じ回の勝ち負けが割れる割合 q {}、1 回の差のばらつき {} ポイント（見込みは q 0.40〜0.50・63〜71）",
        fixed(mean(&q_split), 3),
        fixed(mean(&sd_roll), 1)
    ));
    line(format!(
        "- 打った回 {}、スレッド秒 {}（1 回 {} 秒、1 局面 {} 秒）。打てなかった回 {x_count}",
        n_roll,
        fixed(sec, 0),
        fixed(sec / n_roll.max(1.0), 2),
        fixed(sec / n as f64, 0)
    ));
    line(String::new());

    // 大きなミス
    if !misses.is_empty() {
        line("## 大きなミスの局面".into());
        line(String::new());
        for r in &misses {
            let g = r.v["g"].as_u64().unwrap_or(0);
            let i = r.v["i"].as_u64().unwrap_or(0);
            let (c, _, _) = r.confirm.clone().unwrap_or((0, vec![], vec![]));
            let (d, se) = r.confirm_se().unwrap_or((f64::NAN, f64::NAN));
            line(format!(
                "- g{g} {}（{}、相手 {}）: 手札 {}。AI は {} を返す、打ち比べは {} を返す。二段目の差 {}",
                if r.first { "先攻" } else { "後攻" },
                r.deck,
                r.v["opp"].as_str().unwrap_or("?"),
                r.hand.join("・"),
                join_or(&r.ret_names(r.ai)),
                join_or(&r.ret_names(c)),
                pm(d, se, 1)
            ));
            if let Some(dir) = flag(flags, "states") {
                let f = format!("{dir}/g{g}-i{i}.json");
                let text = r.v["state"].as_str().unwrap_or("").to_string() + "\n";
                std::fs::write(&f, text).map_err(|e| format!("{f} に書けません: {e}"))?;
            }
        }
        line(String::new());
    }
    print!("{out}");
    if !no_ledger {
        let mut cmd = vec!["survey".to_string(), "report".to_string()];
        cmd.extend(argv.iter().filter(|a| *a != "--no-ledger").cloned());
        let set_of = |k: &str| -> Vec<String> {
            games
                .values()
                .filter_map(|g| g[k].as_str().map(String::from))
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect()
        };
        let extra_gain: Vec<f64> = rows
            .iter()
            .map(|r| match r.pick {
                Some((c, _)) if r.nextra.contains(&c) => r.gain(),
                _ => 0.0,
            })
            .collect();
        let (xm, xse) = mean_se(&extra_gain);
        ledger::append_survey(&ledger::SurveyRun {
            argv: cmd,
            label,
            a: opts_text,
            first: first_game,
            last: last_game,
            games: n_games,
            rate: 1.0,
            m: setting("m"),
            extra: setting("narrowTop"),
            confirm: setting("confirm"),
            flag: setting("flag"),
            turn_starts: n as u64,
            positions: n,
            compared: n,
            gain4: [f64::NAN, f64::NAN],
            gain8: [f64::NAN, f64::NAN],
            gain2: [gm, gse],
            gain2_extra: [xm, xse],
            flagged: switched,
            misses: misses.len(),
            misses_per_game: [miss_rate, miss_se],
            split_any: f64::NAN,
            split_pair: mean(&q_split),
            pair_se: mean(&sd_roll) / (setting("m") + setting("narrow")).sqrt(),
            per_rollout: sec / n_roll.max(1.0),
            seconds: sec,
            machines: set_of("machine"),
            commits: set_of("commit"),
            mode: "mulligan".into(),
        });
    }
    Ok(())
}

fn join_or(v: &[String]) -> String {
    if v.is_empty() {
        "何も".into()
    } else {
        v.join("・")
    }
}
