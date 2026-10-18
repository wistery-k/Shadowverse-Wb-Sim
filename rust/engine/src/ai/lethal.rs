//! リーサル（このターンでの勝利）の探索（src/ai/lethal.ts）。

use super::determinize::determinize;
use super::keys::{lethal_key_eq, lethal_key_hash, visible_eq, EqSet};
use super::Rng;
use crate::data::{AMBUSH, INTIMIDATE, STORM, WARD};
use crate::game::{
    attack_targets, can_attack_followers, can_attack_leader, legal_actions, try_apply_action,
};
use crate::state::*;
use std::cell::RefCell;

pub struct LethalScoring {
    pub combo: f64,
    pub pp: f64,
    pub cost_reduction: f64,
    pub setup: bool,
    pub width_factor: usize,
}

pub const DIRECT_SCORING: LethalScoring = LethalScoring {
    combo: 0.25,
    pp: 0.05,
    cost_reduction: 0.0,
    setup: false,
    width_factor: 1,
};
pub const SETUP_SCORING: LethalScoring = LethalScoring {
    combo: 0.25,
    pp: 0.05,
    cost_reduction: 0.05,
    setup: true,
    width_factor: 2,
};

pub struct LethalOptions {
    pub beam_width: usize,
    pub max_depth: usize,
    pub samples: usize,
    pub scorings: &'static [LethalScoring],
    /// 相手の守護に止められている、リーダーを攻撃できるフォロワーの打点にかける重み（途中の局面の点数）。
    /// リーダーを攻撃できないフォロワーで守護を倒しきれるときだけ数える（`ward_blocked_damage`）。
    /// クオンの超進化で疾走を付けた式神の打点をビームに残すため。0 なら数えない
    pub ward_blocked: f64,
    /// 自分の選択待ち（超進化時の対象の選択など）になった局面を、その場で選択肢ごとに展開して同じ深さの子にする。
    /// 選んだ後の打点（クオンの超進化で式神に付ける疾走など）で点数を付けるため
    pub expand_choices: bool,
}

pub const DEFAULT_LETHAL_OPTIONS: LethalOptions = LethalOptions {
    beam_width: 16,
    max_depth: 14,
    samples: 3,
    scorings: &[DIRECT_SCORING, SETUP_SCORING],
    ward_blocked: 0.0,
    expand_choices: false,
};

/// 探索 AI の既定と対戦画面のリーサル表示で使う設定: 守護の奥の打点を数え、選択待ちをその場で展開する
/// （クオンの超進化で式神に疾走を付ける手順を見つけるため。docs/ai-notes.md「リーサル探索で守護の奥の打点を数える」）
pub const GUARDED_LETHAL_OPTIONS: LethalOptions = LethalOptions {
    ward_blocked: 1.0,
    expand_choices: true,
    ..DEFAULT_LETHAL_OPTIONS
};

const WIN: f64 = 1e9;

/// 相手の場に守護がいて、リーダーを攻撃できないフォロワー（進化して出たターンのクオン等）の攻撃力の合計が守護の体力の合計以上のとき、
/// 守護がいなければリーダーを攻撃できるフォロワーの残りの打点（そうでなければ 0）。守護を倒せば顔に入る打点
fn ward_blocked_damage(s: &GameState, p: PlayerIndex) -> i32 {
    if s.active != p {
        return 0;
    }
    let opp = &s.players[opponent(p)];
    let ward_hp: i32 = opp
        .board
        .iter()
        .filter(|c| {
            c.is_follower
                && c.has_keyword(WARD)
                && !c.has_keyword(AMBUSH)
                && !c.has_keyword(INTIMIDATE)
        })
        .map(|c| c.defense)
        .sum();
    if ward_hp == 0 {
        return 0;
    }
    let (mut face, mut clear) = (0, 0);
    for f in &s.players[p].board {
        if !f.is_follower {
            continue;
        }
        let dmg = f.attack_value() * (f.max_attacks - f.attacks_this_turn);
        if can_attack_leader(s, f) {
            face += dmg;
        } else if can_attack_followers(s, f) {
            clear += dmg;
        }
    }
    if clear >= ward_hp {
        face
    } else {
        0
    }
}

/// このターンにまだ相手リーダーへ与えられる攻撃のダメージ
fn ready_face_damage(s: &GameState, p: PlayerIndex) -> i32 {
    if s.active != p {
        return 0;
    }
    let mut total = 0;
    let mut targets = Vec::new();
    for f in &s.players[p].board {
        if !f.is_follower {
            continue;
        }
        targets.clear();
        attack_targets(s, f, &mut targets);
        if targets.contains(&None) {
            total += f.attack_value() * (f.max_attacks - f.attacks_this_turn);
        }
    }
    total
}

pub fn lethal_score(s: &GameState, p: PlayerIndex, w: &LethalScoring, ward_blocked: f64) -> f64 {
    if s.phase == Phase::Ended {
        return if s.winner == Some(p) { WIN } else { -WIN };
    }
    let me = &s.players[p];
    let opp = &s.players[opponent(p)];
    let prep = w.combo * me.combo as f64
        + w.pp * me.pp as f64
        + if w.cost_reduction > 0.0 {
            w.cost_reduction * hand_cost_reduction(s, p) as f64
        } else {
            0.0
        };
    let ready = ready_face_damage(s, p);
    let storm = if w.setup {
        storm_from_hand(s, p, ready)
    } else {
        0
    };
    let blocked = if ward_blocked != 0.0 {
        ward_blocked * ward_blocked_damage(s, p) as f64
    } else {
        0.0
    };
    -((opp.leader_hp - ready - storm) as f64) + prep + blocked
}

fn has_storm(h: &HandCard) -> bool {
    card(h.card).keywords.has(STORM) || h.keywords.has(STORM)
}

fn storm_from_hand(s: &GameState, p: PlayerIndex, ready: i32) -> i32 {
    if s.pending.is_some() || s.active != p {
        return 0;
    }
    let mut best = 0;
    for h in &s.players[p].hand {
        if !has_storm(h) {
            continue;
        }
        let Some(next) = try_apply_action(s, &Action::Play(h.iid)) else {
            continue;
        };
        if next.pending.is_some() {
            continue;
        }
        best = best.max(ready_face_damage(&next, p) - ready);
    }
    best
}

fn hand_cost_reduction(s: &GameState, p: PlayerIndex) -> i32 {
    s.players[p]
        .hand
        .iter()
        .map(|h| (card(h.card).cost - hand_cost(h)).max(0))
        .sum()
}

fn candidates(s: &GameState, setup: bool) -> Vec<Action> {
    let mut legal = legal_actions(s);
    if setup {
        legal.retain(|a| !matches!(a, Action::EndTurn));
        return legal;
    }
    let opp = &s.players[opponent(s.active)];
    let wards: Vec<Iid> = opp
        .board
        .iter()
        .filter(|c| c.is_follower && (c.keywords.has(WARD) || c.temp_keywords.has(WARD)))
        .map(|c| c.iid)
        .collect();
    legal.retain(|a| match a {
        Action::EndTurn => false,
        Action::Attack {
            target: Some(t), ..
        } => wards.contains(t),
        _ => true,
    });
    legal
}

struct Node {
    state: GameState,
    seq: Vec<Action>,
    score: f64,
}

fn select_beam(mut children: Vec<Node>, p: PlayerIndex, width: usize) -> Vec<Node> {
    children.sort_by(|x, y| {
        y.score
            .partial_cmp(&x.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut seen: EqSet<usize> = EqSet::default();
    let mut unique: Vec<usize> = Vec::new();
    for (i, c) in children.iter().enumerate() {
        if seen.add(i, lethal_key_hash(&c.state), |a, b| {
            lethal_key_eq(&children[*a].state, &children[*b].state)
        }) {
            unique.push(i);
        }
    }
    let mut picked = vec![false; children.len()];
    let mut n_picked = 0;
    let mut buckets: Vec<(i32, i32, i32, i32, usize)> = Vec::new();
    for &i in &unique {
        if n_picked >= width {
            break;
        }
        let me = &children[i].state.players[p];
        let bucket = (me.pp, me.combo, me.sep, me.ep, me.hand.len());
        if buckets.contains(&bucket) {
            continue;
        }
        buckets.push(bucket);
        picked[i] = true;
        n_picked += 1;
    }
    for &i in &unique {
        if n_picked >= width {
            break;
        }
        if !picked[i] {
            picked[i] = true;
            n_picked += 1;
        }
    }
    let keep: Vec<bool> = unique
        .iter()
        .fold(vec![false; children.len()], |mut k, &i| {
            k[i] = picked[i];
            k
        });
    children
        .into_iter()
        .enumerate()
        .filter(|(i, _)| keep[*i])
        .map(|(_, c)| c)
        .collect()
}

fn beam_lethal(
    root: &GameState,
    p: PlayerIndex,
    opts: &LethalOptions,
    w: &LethalScoring,
) -> Option<Vec<Action>> {
    let mut frontier = vec![Node {
        state: root.clone(),
        seq: Vec::new(),
        score: lethal_score(root, p, w, opts.ward_blocked),
    }];
    let mut depth = 0;
    while depth < opts.max_depth && !frontier.is_empty() {
        let mut children = Vec::new();
        for node in &frontier {
            let actor = node
                .state
                .pending
                .as_ref()
                .map(|pd| pd.player())
                .unwrap_or(node.state.active);
            if node.state.phase == Phase::Ended || actor != p {
                continue;
            }
            // (局面, 手順, 続けて選んだ回数)。expand_choices なら、自分の選択待ちはその場で選んで同じ深さの子にする
            let mut stack: Vec<(GameState, Vec<Action>, u32)> = Vec::new();
            // 候補の順に子を並べる（点数が同じ子の順番を変えないため、逆順に積んで取り出す）
            for a in candidates(&node.state, w.setup).into_iter().rev() {
                let Some(next) = try_apply_action(&node.state, &a) else {
                    continue;
                };
                let mut seq = node.seq.clone();
                seq.push(a);
                stack.push((next, seq, 0));
            }
            while let Some((next, seq, chained)) = stack.pop() {
                if next.phase == Phase::Ended {
                    if next.winner == Some(p) {
                        return Some(seq);
                    }
                    continue;
                }
                if opts.expand_choices
                    && chained < 3
                    && next.pending.as_ref().map(|pd| pd.player()) == Some(p)
                {
                    for a in candidates(&next, w.setup).into_iter().rev() {
                        if let Some(n2) = try_apply_action(&next, &a) {
                            let mut s2 = seq.clone();
                            s2.push(a);
                            stack.push((n2, s2, chained + 1));
                        }
                    }
                    continue;
                }
                let score = lethal_score(&next, p, w, opts.ward_blocked);
                children.push(Node {
                    state: next,
                    seq,
                    score,
                });
            }
        }
        frontier = select_beam(children, p, opts.beam_width * w.width_factor);
        depth += 1;
    }
    None
}

/// 1 つの局面で、勝てる行動の並びを探す
pub fn search_lethal(
    root: &GameState,
    p: PlayerIndex,
    opts: &LethalOptions,
) -> Option<Vec<Action>> {
    for w in opts.scorings {
        if w.setup && !root.players[p].hand.iter().any(has_storm) {
            continue;
        }
        if let Some(seq) = beam_lethal(root, p, opts, w) {
            return Some(seq);
        }
    }
    None
}

fn replay_wins(s: &GameState, seq: &[Action], p: PlayerIndex) -> bool {
    let mut cur: Option<GameState> = Some(s.clone());
    for a in seq {
        match &cur {
            Some(x) if x.phase != Phase::Ended => cur = try_apply_action(x, a),
            _ => break,
        }
    }
    matches!(cur, Some(x) if x.phase == Phase::Ended && x.winner == Some(p))
}

/// 見つけた手順と、各手を打つ前に p から見えているはずの局面（None は決して一致しない）
pub struct LethalLine {
    pub steps: Vec<Action>,
    pub expected: Vec<Option<GameState>>,
}

pub type LethalSearch<'a> = &'a dyn Fn(&GameState, PlayerIndex) -> Option<Vec<Action>>;

/// 実際の局面から、確実に勝てる行動の並び全体を探す
pub fn find_lethal_line(
    real: &GameState,
    p: PlayerIndex,
    rng: &mut Rng,
    samples: usize,
    search: LethalSearch,
) -> Option<LethalLine> {
    let det = determinize(real, p, rng, false);
    let seq = search(&det, p)?;
    if seq.is_empty() {
        return None;
    }
    for _ in 1..samples {
        if !replay_wins(&determinize(real, p, rng, false), &seq, p) {
            return None;
        }
    }
    let mut expected = Vec::new();
    let mut s: Option<GameState> = Some(det);
    for a in &seq {
        expected.push(s.clone());
        s = s.and_then(|x| try_apply_action(&x, a));
    }
    Some(LethalLine {
        steps: seq,
        expected,
    })
}

struct Current {
    player: PlayerIndex,
    line: LethalLine,
    index: usize,
}

thread_local! {
    /// 実行中のリーサルの手順（TypeScript 版のモジュールの変数と同じく、AI をまたいで 1 つ）
    static CURRENT: RefCell<Option<Current>> = const { RefCell::new(None) };
}

/// 実行中のリーサルの手順を忘れる（試合の区切りで呼ぶ）
pub fn reset_lethal() {
    CURRENT.with(|c| *c.borrow_mut() = None);
}

/// 実際の局面から、確実に勝てる行動の並びを探して最初の手を返す
pub fn find_lethal(
    real: &GameState,
    p: PlayerIndex,
    rng: &mut Rng,
    opts: &LethalOptions,
    search: Option<LethalSearch>,
) -> Option<Action> {
    let legal = legal_actions(real);
    let cont = CURRENT.with(|c| {
        let mut c = c.borrow_mut();
        if let Some(cur) = c.as_mut() {
            if cur.player == p && cur.index < cur.line.steps.len() {
                let planned = &cur.line.steps[cur.index];
                let ok = cur.line.expected[cur.index]
                    .as_ref()
                    .is_some_and(|e| visible_eq(real, e, p));
                if ok && legal.contains(planned) {
                    let a = planned.clone();
                    cur.index += 1;
                    return Some(a);
                }
            }
        }
        *c = None;
        None
    });
    if cont.is_some() {
        return cont;
    }
    let default_search = |root: &GameState, q: PlayerIndex| search_lethal(root, q, opts);
    let line = find_lethal_line(
        real,
        p,
        rng,
        opts.samples,
        search.unwrap_or(&default_search),
    )?;
    let first = line.steps[0].clone();
    CURRENT.with(|c| {
        *c.borrow_mut() = Some(Current {
            player: p,
            line,
            index: 1,
        })
    });
    Some(first)
}
