//! ターン単位の探索 AI（src/ai/search.ts）。
//!
//! 1. 見えない情報は determinization で複数の「ありうる局面」を作って平均する
//! 2. 各局面で、自分のターン終了までの行動の並びをビームサーチで探索する
//! 3. 有望な並び（最初の手ごとの最善）について、相手のターンを軽いビームサーチで進めた後の局面を評価する
//! 4. 平均の評価が最も良い「最初の手」を選ぶ。このターンで勝てる並び（リーサル）が見つかれば最優先する

use super::aidata::{ai_data, Weights};
use super::converging::{converging_attacks, dominated_attack, settle_converging_trades_with};
use super::determinize::determinize;
use super::eval::{evaluate_with, EvalWeights};
use super::greedy::choose_greedy;
use super::keys::{hand_eq_noid, visible_eq, TurnOrderSet};
use super::lethal::{find_lethal, search_lethal, DEFAULT_LETHAL_OPTIONS};
use super::mulligan::{model_mulligan_swap, sampled_mulligan, weighted_mulligan_swap};
use super::valuenet::{value_net_eval, ValuePhase};
use super::{Agent, Rng};
use crate::game::{acting_player, legal_actions, resolve_turn_end, try_apply_action};
use crate::state::*;
use std::rc::Rc;
use std::sync::Arc;

/// 評価関数に足す項（学習した補正・デッキ専用の AI 用）
pub type ExtraEval = Arc<dyn Fn(&GameState, PlayerIndex, ValuePhase) -> f64 + Send + Sync>;
/// 自分が打ってよい手か（ルールで禁じる手を探索から外す）
pub type Allow = Arc<dyn Fn(&GameState, &Action, PlayerIndex) -> bool + Send + Sync>;
/// 次の自分のターンにリーサルがあるか（nextLethal の判定。None ならリーサル探索 searchLethal）
pub type NextLethalSearch = Arc<dyn Fn(&GameState, PlayerIndex) -> bool + Send + Sync>;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScoreTurnEnd {
    None,
    Terminal,
    All,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MulliganMode {
    Model,
    Weights,
    Cost,
    /// 返し方ごとに引き直しを mulligan_samples 回試して、評価の平均で選ぶ
    Sample,
}

#[derive(Clone, Copy, Debug)]
pub struct OpponentSearch {
    pub beam_width: usize,
    pub max_depth: usize,
    pub extra_eval: bool,
}

/// 探索 AI の設定（search.ts の SearchOptions。exhaustive 等の実験用の項目のうち既定で使わないものは省く）
#[derive(Clone)]
pub struct SearchOptions {
    pub samples: usize,
    pub beam_width: usize,
    pub max_depth: usize,
    pub rescore_top: usize,
    pub lethal: bool,
    pub allow: Option<Allow>,
    pub dedup: bool,
    pub same_hand_once: bool,
    pub chain: bool,
    pub chain_fuse: bool,
    pub score_turn_end: ScoreTurnEnd,
    pub mulligan: MulliganMode,
    /// MulliganMode::Sample で、返し方ごとに引き直しを試す回数
    pub mulligan_samples: usize,
    /// MulliganMode::Sample で、評価関数（手で決めた部分）と学習した補正のどちらを使うか
    pub mulligan_static: bool,
    pub mulligan_net: bool,
    pub settle_trades: bool,
    /// 下位互換の味方で同じことができる攻撃を展開せず、合流する相打ちも下位互換の味方で打つ（converging.rs の dominated_attack）
    pub dominance: bool,
    pub reuse_plan: bool,
    pub plan_candidates: usize,
    pub per_first: usize,
    pub next_lethal: f64,
    pub next_lethal_search: Option<NextLethalSearch>,
    pub beam_pp: f64,
    pub extra_eval: Option<ExtraEval>,
    /// 評価関数の重み（None なら探索 AI の既定 SEARCH_WEIGHTS）
    pub weights: Option<Arc<Weights>>,
    pub opponent_search: Option<OpponentSearch>,
    pub opp_hand_samples: usize,
    pub peek_opp_hand: bool,
    pub opp_fuse: bool,
    pub danger_rescore: usize,
    pub reuse_agree: bool,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions {
            samples: 3,
            beam_width: 32,
            max_depth: 8,
            rescore_top: 4,
            lethal: true,
            allow: None,
            dedup: true,
            same_hand_once: true,
            chain: true,
            chain_fuse: false,
            score_turn_end: ScoreTurnEnd::All,
            mulligan: MulliganMode::Model,
            mulligan_samples: 100,
            mulligan_static: true,
            mulligan_net: true,
            settle_trades: true,
            dominance: true,
            reuse_plan: true,
            plan_candidates: 3,
            per_first: 0,
            next_lethal: 0.0,
            next_lethal_search: None,
            beam_pp: 0.0,
            extra_eval: Some(Arc::new(value_net_eval)),
            weights: None,
            opponent_search: Some(OpponentSearch {
                beam_width: 4,
                max_depth: 8,
                extra_eval: false,
            }),
            opp_hand_samples: 1,
            peek_opp_hand: false,
            opp_fuse: false,
            danger_rescore: 0,
            reuse_agree: false,
        }
    }
}

/// 相手のターンを読んだ後の点数がこれ以下なら、その並びは相手のターンで負ける（dangerRescore）
const DANGER: f64 = -1e5;

/// 1 つのサンプルで、最初の手の評価値と、その手から始まる最善の並び（各手を打った後の局面つき）
#[derive(Clone)]
pub struct Plan {
    pub action: Action,
    pub value: f64,
    pub steps: Vec<(Action, Rc<GameState>)>,
}

/// 探索で使う重み（評価関数の重みと、相手の手番の貪欲法の重み）
pub struct Env<'a> {
    pub opts: &'a SearchOptions,
    pub w: &'a EvalWeights,
    pub policy_w: &'a EvalWeights,
}

struct Step {
    action: Action,
    state: Rc<GameState>,
    prev: Option<usize>,
}

struct Node {
    state: Rc<GameState>,
    first: Action,
    value: f64,
    path: usize,
}

fn by_value_desc(x: f64, y: f64) -> std::cmp::Ordering {
    y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal)
}

/// 後攻の 5 ターン目を終える局面で、残っているエクストラPP の評価から引く点
pub fn expiring_extra_pp(s: &GameState, p: PlayerIndex, w: &EvalWeights) -> f64 {
    let me = &s.players[p];
    let w = &w.w;
    if w.extra_pp_expiring == 1.0
        || s.phase != Phase::Main
        || s.active != p
        || p == s.first
        || !me.extra_pp_available
    {
        return 0.0;
    }
    if me.turn_count == EXTRA_PP_REFRESH_TURN - 1 {
        w.extra_pp * (1.0 - w.extra_pp_expiring)
    } else {
        0.0
    }
}

/// 手札の同じカードのプレイを 1 つに絞った手の一覧
fn distinct_plays(s: &GameState, actions: Vec<Action>) -> Vec<Action> {
    let p = s.active;
    let hand = &s.players[p].hand;
    let mut seen: Vec<&HandCard> = Vec::new();
    actions
        .into_iter()
        .filter(|a| {
            let Action::Play(iid) = a else { return true };
            let Some(card) = hand.iter().find(|h| h.iid == *iid) else {
                return true;
            };
            if seen.iter().any(|x| hand_eq_noid(x, card)) {
                return false;
            }
            seen.push(card);
            true
        })
        .collect()
}

struct Planner<'a> {
    env: &'a Env<'a>,
    p: PlayerIndex,
    steps: Vec<Step>,
}

impl<'a> Planner<'a> {
    fn opts(&self) -> &'a SearchOptions {
        self.env.opts
    }

    fn push_step(&mut self, action: Action, state: Rc<GameState>, prev: Option<usize>) -> usize {
        self.steps.push(Step {
            action,
            state,
            prev,
        });
        self.steps.len() - 1
    }

    fn steps_of(&self, path: usize) -> Vec<(Action, Rc<GameState>)> {
        let mut out = Vec::new();
        let mut cur = Some(path);
        while let Some(i) = cur {
            let s = &self.steps[i];
            out.push((s.action.clone(), s.state.clone()));
            cur = s.prev;
        }
        out.reverse();
        out
    }

    /// ターンを終える局面（合流する相打ちを打った後）。変わらなければ None
    fn settle(&self, s: &GameState) -> Option<GameState> {
        if self.opts().settle_trades {
            settle_converging_trades_with(s, self.p, self.opts().dominance)
        } else {
            None
        }
    }

    fn eval_state(&self, s: &GameState) -> f64 {
        let v = evaluate_with(s, self.p, self.env.w);
        match &self.opts().extra_eval {
            Some(f) => v + f(s, self.p, ValuePhase::End),
            None => v,
        }
    }

    fn eval_after(&self, s: &GameState) -> f64 {
        let v = evaluate_with(s, self.p, self.env.w);
        match &self.opts().extra_eval {
            Some(f) => v + f(s, self.p, ValuePhase::After),
            None => v,
        }
    }

    fn leftover(&self, s: &GameState) -> f64 {
        let w = &self.env.w.w;
        if w.pp_left != 0.0 && s.phase == Phase::Main && s.active == self.p {
            w.pp_left * s.players[self.p].pp as f64
        } else {
            0.0
        }
    }

    fn expiring(&self, s: &GameState) -> f64 {
        expiring_extra_pp(s, self.p, self.env.w)
    }

    fn end_score(&self, s: &GameState) -> f64 {
        let settled = self.settle(s);
        let base = settled.as_ref().unwrap_or(s);
        let resolved = resolve_turn_end(base);
        self.eval_state(resolved.as_ref().unwrap_or(base)) - self.leftover(s) - self.expiring(s)
    }

    fn score(&self, s: &GameState) -> f64 {
        if self.opts().score_turn_end == ScoreTurnEnd::All {
            return self.end_score(s);
        }
        let settled = self.settle(s);
        self.eval_state(settled.as_ref().unwrap_or(s)) - self.leftover(s) - self.expiring(s)
    }

    fn allowed(&self, s: &GameState, a: &Action) -> bool {
        match &self.opts().allow {
            None => true,
            Some(f) => matches!(a, Action::EndTurn) || f(s, a, self.p),
        }
    }

    fn expand(&self, s: &GameState) -> Vec<Action> {
        let mut legal = legal_actions(s);
        if self.opts().dominance {
            legal.retain(|a| !dominated_attack(s, a));
        }
        if self.opts().same_hand_once {
            distinct_plays(s, legal)
        } else {
            legal
        }
    }

    /// 手 a を打った局面と、そこまでの並び。chain なら、続く自分の選択とエクストラPP の後の手まで進めた局面すべて
    fn advance(
        &mut self,
        s: &Rc<GameState>,
        a: &Action,
        prev: Option<usize>,
        depth: u32,
    ) -> Vec<(Rc<GameState>, usize)> {
        let Some(next) = try_apply_action(s, a) else {
            return Vec::new();
        };
        let next = Rc::new(next);
        let path = self.push_step(a.clone(), next.clone(), prev);
        let opts = self.opts();
        if !opts.chain || depth >= 8 || next.phase == Phase::Ended {
            return vec![(next, path)];
        }
        let p = self.p;
        if next.pending.as_ref().is_some_and(|pd| pd.player() == p) {
            let mut out = Vec::new();
            for c in legal_actions(&next) {
                if self.allowed(&next, &c) {
                    out.extend(self.advance(&next, &c, Some(path), depth + 1));
                }
            }
            return if out.is_empty() {
                vec![(next, path)]
            } else {
                out
            };
        }
        if opts.chain_fuse
            && matches!(a, Action::Fuse { .. })
            && next.pending.is_none()
            && next.active == p
        {
            let mut out = vec![(next.clone(), path)];
            for c in self.expand(&next) {
                if matches!(c, Action::EndTurn | Action::Fuse { .. }) || !self.allowed(&next, &c) {
                    continue;
                }
                out.extend(self.advance(&next, &c, Some(path), depth + 1));
            }
            return out;
        }
        if matches!(a, Action::ExtraPp) && next.pending.is_none() && next.active == p {
            let mut out = Vec::new();
            for c in self.expand(&next) {
                if matches!(c, Action::EndTurn | Action::ExtraPp) || !self.allowed(&next, &c) {
                    continue;
                }
                out.extend(self.advance(&next, &c, Some(path), depth + 1));
            }
            return if out.is_empty() {
                vec![(next, path)]
            } else {
                out
            };
        }
        vec![(next, path)]
    }

    /// 評価の高い順に、同じ局面を除いて width 個まで選ぶ（children は評価の降順）
    fn unique_states(&self, children: Vec<Node>, width: usize, per_first: usize) -> Vec<Node> {
        let mut seen = TurnOrderSet::default();
        let mut out: Vec<Node> = Vec::new();
        let mut count: Vec<(Action, usize)> = Vec::new();
        for c in children {
            let n = count
                .iter()
                .find(|(k, _)| *k == c.first)
                .map(|(_, n)| *n)
                .unwrap_or(0);
            if out.len() >= width {
                if per_first == 0 {
                    break;
                }
                if n >= per_first {
                    continue;
                }
            }
            if !seen.add(&c.state) {
                continue;
            }
            match count.iter_mut().find(|(k, _)| *k == c.first) {
                Some(e) => e.1 = n + 1,
                None => count.push((c.first.clone(), n + 1)),
            }
            out.push(c);
        }
        out
    }

    fn beam_terminals(&mut self, root: &Rc<GameState>, root_converges: bool) -> Vec<Node> {
        let p = self.p;
        let opts = self.opts();
        let mut terminals: Vec<Node> = Vec::new();
        let mut frontier: Vec<Node> = Vec::new();
        // 深さ 1: すべての手を展開する（最初の手の候補を落とさない）
        for a in self.expand(root) {
            if !self.allowed(root, &a) {
                continue;
            }
            if matches!(a, Action::EndTurn) {
                if root_converges {
                    continue; // 合流する攻撃をしてから終える手に劣らない
                }
                let path = self.push_step(a.clone(), root.clone(), None);
                let value = self.score(root);
                terminals.push(Node {
                    state: root.clone(),
                    first: a,
                    value,
                    path,
                });
                continue;
            }
            for (st, path) in self.advance(root, &a, None, 0) {
                let value = self.score(&st);
                frontier.push(Node {
                    state: st,
                    first: a.clone(),
                    value,
                    path,
                });
            }
        }
        let mut depth = 1;
        while depth < opts.max_depth && !frontier.is_empty() {
            let mut children: Vec<Node> = Vec::new();
            for node in std::mem::take(&mut frontier) {
                let actor = node
                    .state
                    .pending
                    .as_ref()
                    .map(|pd| pd.player())
                    .unwrap_or(node.state.active);
                if node.state.phase == Phase::Ended || actor != p {
                    terminals.push(node);
                    continue;
                }
                // ターン終了も候補（その時点の局面で終える）
                let st = node.state.clone();
                let first = node.first.clone();
                let path = node.path;
                terminals.push(node);
                for a in self.expand(&st) {
                    if matches!(a, Action::EndTurn) || !self.allowed(&st, &a) {
                        continue;
                    }
                    for (ns, np) in self.advance(&st, &a, Some(path), 0) {
                        let value = self.score(&ns);
                        children.push(Node {
                            state: ns,
                            first: first.clone(),
                            value,
                            path: np,
                        });
                    }
                }
            }
            if opts.beam_pp != 0.0 {
                let key = |n: &Node| n.value + opts.beam_pp * n.state.players[p].pp as f64;
                children.sort_by(|x, y| by_value_desc(key(x), key(y)));
            } else {
                children.sort_by(|x, y| by_value_desc(x.value, y.value));
            }
            frontier = if opts.dedup {
                self.unique_states(children, opts.beam_width, opts.per_first)
            } else {
                children.truncate(opts.beam_width);
                children
            };
            depth += 1;
        }
        terminals.extend(frontier);
        terminals
    }
}

/// 1 つの局面で、最初の手ごとの評価値を求める（挿入順。TypeScript 版の Map と同じ順）。
/// rescore が false なら相手のターンを読まず、最初の手ごとのターン末の最善の並びとその点数を返す
pub fn plan_turn(
    root: &Rc<GameState>,
    p: PlayerIndex,
    env: &Env,
    rng: &mut Rng,
    rescore: bool,
) -> Vec<(Action, Plan)> {
    let opts = env.opts;
    let mut pl = Planner {
        env,
        p,
        steps: Vec::new(),
    };
    let root_converges = opts.settle_trades && !converging_attacks(root, p).is_empty();
    let mut terminals = pl.beam_terminals(root, root_converges);
    if opts.score_turn_end == ScoreTurnEnd::Terminal {
        for t in terminals.iter_mut() {
            t.value = pl.end_score(&t.state);
        }
    }

    // 最初の手ごとに最善の終局面を残し、上位を相手のターンまで読んで評価し直す
    let mut best_by_first: Vec<(Action, usize)> = Vec::new();
    for (i, t) in terminals.iter().enumerate() {
        match best_by_first.iter_mut().find(|(k, _)| *k == t.first) {
            None => best_by_first.push((t.first.clone(), i)),
            Some(e) => {
                if t.value > terminals[e.1].value {
                    e.1 = i;
                }
            }
        }
    }
    if !rescore {
        return best_by_first
            .into_iter()
            .map(|(k, i)| {
                let t = &terminals[i];
                let plan = Plan {
                    action: t.first.clone(),
                    value: t.value,
                    steps: pl.steps_of(t.path),
                };
                (k, plan)
            })
            .collect();
    }
    let mut ranked: Vec<usize> = best_by_first.iter().map(|(_, i)| *i).collect();
    ranked.sort_by(|&x, &y| by_value_desc(terminals[x].value, terminals[y].value));
    ranked.truncate(opts.rescore_top);

    let candidates_of = |best: usize| -> Vec<usize> {
        if !opts.reuse_plan || opts.plan_candidates <= 1 {
            return vec![best];
        }
        let k = &terminals[best].first;
        let mut seen = TurnOrderSet::default();
        seen.add(&terminals[best].state);
        let mut out = vec![best];
        let mut others: Vec<usize> = (0..terminals.len())
            .filter(|&i| i != best && terminals[i].first == *k)
            .collect();
        others.sort_by(|&x, &y| by_value_desc(terminals[x].value, terminals[y].value));
        for i in others {
            if out.len() >= opts.plan_candidates {
                break;
            }
            if seen.add(&terminals[i].state) {
                out.push(i);
            }
        }
        out
    };

    let mut result: Vec<(Action, Plan)> = Vec::new();
    let mut rescored: Vec<usize> = Vec::new();
    let rescore_node = |i: usize, rng: &mut Rng, result: &mut Vec<(Action, Plan)>| {
        let node = &terminals[i];
        let value = if node.state.phase == Phase::Ended {
            pl.eval_state(&node.state)
        } else if opts.opp_hand_samples <= 1 {
            let settled = pl.settle(&node.state);
            read_once(&pl, settled.as_ref().unwrap_or(&node.state), rng) - pl.leftover(&node.state)
        } else {
            let settled = pl.settle(&node.state);
            let base = settled.as_ref().unwrap_or(&node.state);
            let mut sum = 0.0;
            for _ in 0..opts.opp_hand_samples {
                let d = determinize(base, p, rng, opts.peek_opp_hand);
                sum += read_once(&pl, &d, rng);
            }
            sum / opts.opp_hand_samples as f64 - pl.leftover(&node.state)
        };
        let replace = match result.iter().find(|(k, _)| *k == node.first) {
            None => true,
            Some((_, cur)) => value > cur.value,
        };
        if replace {
            let plan = Plan {
                action: node.first.clone(),
                value,
                steps: pl.steps_of(node.path),
            };
            match result.iter_mut().find(|(k, _)| *k == node.first) {
                Some(e) => e.1 = plan,
                None => result.push((node.first.clone(), plan)),
            }
        }
    };
    for best in ranked {
        for i in candidates_of(best) {
            rescore_node(i, rng, &mut result);
            rescored.push(i);
        }
    }
    // 読み直した手がどれも相手のターンで負けるなら、ターン末の点数の高い順に、異なる終局面を dangerRescore 個まで読み足す
    if opts.danger_rescore > 0 && result.iter().all(|(_, x)| x.value <= DANGER) {
        let mut seen = TurnOrderSet::default();
        for &i in &rescored {
            seen.add(&terminals[i].state);
        }
        let mut order: Vec<usize> = (0..terminals.len()).collect();
        order.sort_by(|&x, &y| by_value_desc(terminals[x].value, terminals[y].value));
        let mut n = 0;
        for i in order {
            if n >= opts.danger_rescore {
                break;
            }
            if rescored.contains(&i) || !seen.add(&terminals[i].state) {
                continue;
            }
            rescore_node(i, rng, &mut result);
            n += 1;
        }
    }
    result
}

fn read_once(pl: &Planner, start: &GameState, rng: &mut Rng) -> f64 {
    let env = pl.env;
    let p = pl.p;
    let after = if env.opts.opponent_search.is_some() {
        simulate_opponent_turn_by_search(start, p, rng, env)
    } else {
        simulate_opponent_turn(start, p, rng, env.policy_w, env.opts.opp_fuse)
    };
    let mut v = pl.eval_after(&after);
    if env.opts.next_lethal != 0.0
        && after.phase != Phase::Ended
        && after.players[opponent(p)].leader_hp as f64 <= env.w.w.lethal_range
        && match &env.opts.next_lethal_search {
            Some(f) => f(&after, p),
            None => search_lethal(&after, p, &DEFAULT_LETHAL_OPTIONS).is_some(),
        }
    {
        v += env.opts.next_lethal;
    }
    v
}

/// 自分のターンを終え、相手のターン（と、その途中の選択）を貪欲法で進め、自分の手番に戻った局面を返す
pub fn simulate_opponent_turn(
    state: &GameState,
    p: PlayerIndex,
    rng: &mut Rng,
    policy_w: &EvalWeights,
    fuse_follow_up: bool,
) -> GameState {
    let mut s: Option<GameState> = Some(state.clone());
    let mut ended = false;
    let mut guard = 0;
    while let Some(cur) = s.as_ref() {
        if cur.phase == Phase::Ended || guard >= 80 {
            break;
        }
        guard += 1;
        if cur.pending.is_none() && cur.active == p {
            if ended {
                break;
            }
            s = try_apply_action(cur, &Action::EndTurn);
            ended = true;
            continue;
        }
        let a = choose_greedy(
            cur,
            &legal_actions(cur),
            rng,
            true,
            policy_w,
            fuse_follow_up,
        );
        s = try_apply_action(cur, &a);
    }
    s.unwrap_or_else(|| state.clone())
}

/// 相手のターンをビームサーチで打つ版（SearchOptions.opponentSearch）。
/// 相手のターン中の選択待ちなど、並びの外の手は貪欲法で進める
pub fn simulate_opponent_turn_by_search(
    state: &GameState,
    p: PlayerIndex,
    rng: &mut Rng,
    env: &Env,
) -> GameState {
    let opts = env.opts;
    let q = opponent(p);
    let os = opts.opponent_search;
    let opp_opts = SearchOptions {
        allow: None,
        extra_eval: if os.is_some_and(|o| o.extra_eval) {
            opts.extra_eval.clone()
        } else {
            None
        },
        beam_width: os.map(|o| o.beam_width).unwrap_or(opts.beam_width),
        max_depth: os.map(|o| o.max_depth).unwrap_or(opts.max_depth),
        next_lethal: 0.0,
        opponent_search: None,
        ..opts.clone()
    };
    let opp_env = Env {
        opts: &opp_opts,
        w: env.w,
        policy_w: env.policy_w,
    };
    let mut s: Option<GameState> = Some(state.clone());
    let mut ended = false;
    let mut searched = false;
    let mut guard = 0;
    while let Some(cur) = s.take() {
        if cur.phase == Phase::Ended || guard >= 80 {
            s = Some(cur);
            break;
        }
        guard += 1;
        if cur.pending.is_none() && cur.active == p {
            if ended {
                s = Some(cur);
                break;
            }
            s = try_apply_action(&cur, &Action::EndTurn);
            ended = true;
            continue;
        }
        let mut cur = cur;
        if ended && !searched && cur.pending.is_none() && cur.active == q {
            searched = true;
            let root = Rc::new(cur.clone());
            let mut best: Option<Plan> = None;
            for (_, plan) in plan_turn(&root, q, &opp_env, rng, false) {
                if best.as_ref().is_none_or(|b| plan.value > b.value) {
                    best = Some(plan);
                }
            }
            if let Some((action, last)) = best.as_ref().and_then(|b| b.steps.last()) {
                if !matches!(action, Action::EndTurn) {
                    cur = if opts.settle_trades {
                        settle_converging_trades_with(last, q, opts.dominance)
                            .unwrap_or_else(|| (**last).clone())
                    } else {
                        (**last).clone()
                    };
                    if cur.phase == Phase::Ended {
                        s = Some(cur);
                        break;
                    }
                }
            }
            if cur.pending.is_none() && cur.active == q {
                s = try_apply_action(&cur, &Action::EndTurn);
                continue;
            }
        }
        let a = choose_greedy(&cur, &legal_actions(&cur), rng, true, env.policy_w, false);
        s = try_apply_action(&cur, &a);
    }
    s.unwrap_or_else(|| state.clone())
}

struct PlanState {
    steps: Vec<(Action, Rc<GameState>)>,
    index: usize,
}

struct Total {
    action: Action,
    sum: f64,
    count: usize,
    plan: Plan,
    plans: Vec<Plan>,
}

/// 探索 AI（search.ts の createSearchAgent）
pub struct SearchAgent {
    pub opts: SearchOptions,
    w: EvalWeights,
    policy_w: EvalWeights,
    default_w: EvalWeights,
    plans: [Option<PlanState>; 2],
}

impl SearchAgent {
    pub fn new(opts: SearchOptions) -> SearchAgent {
        let ad = ai_data();
        let w = EvalWeights::new(
            opts.weights
                .as_deref()
                .unwrap_or(&ad.search_weights)
                .clone(),
        );
        let mut pw = ad.default_weights.clone();
        pw.doomed = w.w.doomed;
        SearchAgent {
            opts,
            w,
            policy_w: EvalWeights::new(pw),
            default_w: EvalWeights::new(ad.default_weights.clone()),
            plans: [None, None],
        }
    }
}

/// 並びの、先頭から手がすべて同じ部分の長さ（reuseAgree）
fn agreed_length(plans: &[Plan]) -> usize {
    let Some(first) = plans.first() else { return 0 };
    let mut n = first.steps.len();
    for other in &plans[1..] {
        let mut i = 0;
        while i < n && i < other.steps.len() && first.steps[i].0 == other.steps[i].0 {
            i += 1;
        }
        n = i;
    }
    n
}

impl Agent for SearchAgent {
    fn choose_action(&mut self, real: &GameState, legal: &[Action], rng: &mut Rng) -> Action {
        let first = &legal[0];
        if legal.len() == 1 {
            return first.clone();
        }
        let opts = &self.opts;
        if matches!(first, Action::Mulligan { .. }) {
            let p0 = acting_player(real);
            if opts.mulligan == MulliganMode::Sample {
                let extra = opts.extra_eval.clone().filter(|_| opts.mulligan_net);
                let w = &self.w;
                return sampled_mulligan(real, legal, p0, opts.mulligan_samples, rng, |s| {
                    let v = if opts.mulligan_static {
                        evaluate_with(s, p0, w)
                    } else {
                        0.0
                    };
                    match &extra {
                        Some(f) => v + f(s, p0, ValuePhase::End),
                        None => v,
                    }
                });
            }
            let model_swap = if opts.mulligan == MulliganMode::Model {
                model_mulligan_swap(real, p0)
            } else {
                None
            };
            let swap = model_swap.or_else(|| {
                if opts.mulligan != MulliganMode::Cost {
                    weighted_mulligan_swap(real, p0)
                } else {
                    None
                }
            });
            if let Some(swap) = swap {
                let found = legal.iter().find(|a| match a {
                    Action::Mulligan { swap: x, .. } => {
                        x.len() == swap.len() && x.iter().all(|i| swap.contains(i))
                    }
                    _ => false,
                });
                if let Some(a) = found {
                    return a.clone();
                }
            }
            // 重みの無いデッキは貪欲法と同じ（コスト 4 以上を返す）
            return choose_greedy(real, legal, rng, false, &self.default_w, false);
        }
        let p = real
            .pending
            .as_ref()
            .map(|pd| pd.player())
            .unwrap_or(real.active);

        if opts.lethal {
            if let Some(l) = find_lethal(real, p, rng, &DEFAULT_LETHAL_OPTIONS, None) {
                if legal.contains(&l) {
                    self.plans[p] = None;
                    return l;
                }
            }
        }

        // 前に選んだ並びの途中で、局面が予想どおりなら続ける
        if let Some(mut plan) = self.plans[p].take() {
            if plan.index < plan.steps.len() {
                let next = plan.steps[plan.index].0.clone();
                if visible_eq(real, &plan.steps[plan.index - 1].1, p) && legal.contains(&next) {
                    plan.index += 1;
                    self.plans[p] = Some(plan);
                    return next;
                }
            }
        }

        let env = Env {
            opts,
            w: &self.w,
            policy_w: &self.policy_w,
        };
        let mut totals: Vec<Total> = Vec::new();
        for _ in 0..opts.samples {
            let det = Rc::new(determinize(real, p, rng, opts.peek_opp_hand));
            for (k, sample) in plan_turn(&det, p, &env, rng, true) {
                match totals.iter_mut().find(|t| t.action == k) {
                    Some(t) => {
                        t.sum += sample.value;
                        t.count += 1;
                        t.plans.push(sample.clone());
                        // 並びは、その手の評価が最も高かったサンプルのものを使う
                        if sample.value > t.plan.value {
                            t.plan = sample;
                        }
                    }
                    None => totals.push(Total {
                        action: k,
                        sum: sample.value,
                        count: 1,
                        plans: vec![sample.clone()],
                        plan: sample,
                    }),
                }
            }
        }
        // 実際の局面で合法な手に限る。評価されたサンプルが少ない手は割り引く
        let mut best: Option<&Total> = None;
        let mut best_value = f64::NEG_INFINITY;
        for t in &totals {
            if !legal.contains(&t.action) {
                continue;
            }
            let value = t.sum / t.count as f64 - (opts.samples - t.count) as f64 * 0.5;
            if value > best_value {
                best_value = value;
                best = Some(t);
            }
        }
        if let Some(best) = best {
            let steps: Vec<(Action, Rc<GameState>)> = if opts.reuse_agree {
                let n = if best.count < opts.samples {
                    1
                } else {
                    agreed_length(&best.plans)
                };
                best.plan.steps[..n.min(best.plan.steps.len())].to_vec()
            } else {
                best.plan.steps.clone()
            };
            let action = best.action.clone();
            if opts.reuse_plan && steps.len() > 1 {
                self.plans[p] = Some(PlanState { steps, index: 1 });
            }
            return action;
        }
        let permitted: Vec<Action> = match &opts.allow {
            Some(f) => legal
                .iter()
                .filter(|a| matches!(a, Action::EndTurn) || f(real, a, p))
                .cloned()
                .collect(),
            None => legal.to_vec(),
        };
        let choices = if permitted.is_empty() {
            legal
        } else {
            &permitted
        };
        choose_greedy(real, choices, rng, false, &self.default_w, false)
    }
}
