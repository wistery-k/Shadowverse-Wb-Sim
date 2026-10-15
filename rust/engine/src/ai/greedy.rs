//! 貪欲法の AI（src/ai/greedy.ts）。各合法手を適用した後の盤面を評価し、最も良いものを選ぶ。

use super::aidata::ai_data;
use super::determinize::determinize;
use super::eval::{evaluate_with, EvalWeights};
use super::rhino::deck_class_of;
use super::{Agent, Rng};
use crate::data::ClassId;
use crate::game::{apply_action, legal_actions, try_apply_action};
use crate::state::*;

/// 選択待ちを含め、手を適用した後の最善の評価値
pub fn value_after(s: &GameState, a: &Action, p: PlayerIndex, w: &EvalWeights, depth: u32) -> f64 {
    let Some(next) = try_apply_action(s, a) else {
        return f64::NEG_INFINITY;
    };
    if let Some(pd) = &next.pending {
        if pd.player() == p && depth < 3 {
            let mut best = f64::NEG_INFINITY;
            for b in legal_actions(&next) {
                best = best.max(value_after(&next, &b, p, w, depth + 1));
            }
            return best;
        }
    }
    evaluate_with(&next, p, w)
}

fn value_after_extra_pp(s: &GameState, p: PlayerIndex, w: &EvalWeights) -> f64 {
    let next = apply_action(s, &Action::ExtraPp);
    let mut best = f64::NEG_INFINITY;
    for a in legal_actions(&next) {
        if matches!(a, Action::EndTurn | Action::ExtraPp) {
            continue;
        }
        best = best.max(value_after(&next, &a, p, w, 0));
    }
    best
}

fn value_after_fuse(s: &GameState, a: &Action, p: PlayerIndex, w: &EvalWeights) -> f64 {
    let own = value_after(s, a, p, w, 0);
    let Some(next) = try_apply_action(s, a) else {
        return own;
    };
    if next.phase == Phase::Ended || next.pending.is_some() || next.active != p {
        return own;
    }
    let mut best = own;
    for b in legal_actions(&next) {
        if matches!(b, Action::EndTurn | Action::ExtraPp | Action::Fuse { .. }) {
            continue;
        }
        best = best.max(value_after(&next, &b, p, w, 0));
    }
    best
}

fn best_action(
    s: &GameState,
    legal: &[Action],
    p: PlayerIndex,
    w: &EvalWeights,
    fuse_follow_up: bool,
) -> Action {
    let mut best: Option<&Action> = None;
    let mut best_value = f64::NEG_INFINITY;
    for a in legal {
        let value = match a {
            Action::EndTurn => continue,
            Action::ExtraPp => value_after_extra_pp(s, p, w),
            Action::Fuse { .. } if fuse_follow_up => value_after_fuse(s, a, p, w),
            _ => value_after(s, a, p, w, 0),
        };
        if value > best_value {
            best_value = value;
            best = Some(a);
        }
    }
    let end = legal.iter().find(|a| matches!(a, Action::EndTurn));
    if let Some(end) = end {
        if best.is_none() || best_value <= evaluate_with(s, p, w) + 0.01 {
            return end.clone();
        }
    }
    best.unwrap_or(&legal[0]).clone()
}

/// コスト 4 以上のカードを入れ替えるマリガン
pub fn cost_mulligan(s: &GameState, legal: &[Action], p: PlayerIndex) -> Action {
    let mut swap: Vec<Iid> = s.players[p]
        .hand
        .iter()
        .filter(|h| card(h.card).cost >= 4)
        .map(|h| h.iid)
        .collect();
    swap.sort();
    legal
        .iter()
        .find(|a| match a {
            Action::Mulligan { swap: x, .. } => {
                let mut x = x.clone();
                x.sort();
                x == swap
            }
            _ => false,
        })
        .unwrap_or(&legal[0])
        .clone()
}

pub fn choose_greedy(
    real: &GameState,
    legal: &[Action],
    rng: &mut Rng,
    omniscient: bool,
    w: &EvalWeights,
    fuse_follow_up: bool,
) -> Action {
    let first = &legal[0];
    if let Action::Mulligan { player, .. } = first {
        return cost_mulligan(real, legal, *player);
    }
    let p = real
        .pending
        .as_ref()
        .map(|pd| pd.player())
        .unwrap_or(real.active);
    let det;
    let s = if omniscient {
        real
    } else {
        det = determinize(real, p, rng, false);
        &det
    };
    if matches!(first, Action::Choose(_) | Action::Mode(_)) {
        let mut best = first;
        let mut best_value = f64::NEG_INFINITY;
        for a in legal {
            let value = value_after(s, a, p, w, 0);
            if value > best_value {
                best_value = value;
                best = a;
            }
        }
        return best.clone();
    }
    best_action(s, legal, p, w, fuse_follow_up)
}

/// 貪欲法の AI。omniscient は探索の中で相手の手番を進めるとき用（見えない情報を使う）
pub struct GreedyAgent {
    pub omniscient: bool,
    pub weights: EvalWeights,
    pub fuse_follow_up: bool,
}

impl Agent for GreedyAgent {
    fn choose_action(&mut self, state: &GameState, legal: &[Action], rng: &mut Rng) -> Action {
        choose_greedy(
            state,
            legal,
            rng,
            self.omniscient,
            &self.weights,
            self.fuse_follow_up,
        )
    }
}

/// クラスごとに調整した重み（data/ai-weights.json）を使う貪欲法 AI（src/ai/greedy.ts の tunedGreedyAgent。対戦相手の「ふつう」）
#[derive(Default)]
pub struct TunedGreedyAgent {
    weights: Vec<(ClassId, EvalWeights)>,
}

impl Agent for TunedGreedyAgent {
    fn choose_action(&mut self, state: &GameState, legal: &[Action], rng: &mut Rng) -> Action {
        let p = state
            .pending
            .as_ref()
            .map(|pd| pd.player())
            .unwrap_or(state.active);
        let cls = deck_class_of(state, p);
        let i = match self.weights.iter().position(|(c, _)| *c == cls) {
            Some(i) => i,
            None => {
                let d = ai_data();
                let w = d
                    .class_weights
                    .get(cls.name())
                    .unwrap_or(&d.default_weights)
                    .clone();
                self.weights.push((cls, EvalWeights::new(w)));
                self.weights.len() - 1
            }
        };
        choose_greedy(state, legal, rng, false, &self.weights[i].1, false)
    }
}
