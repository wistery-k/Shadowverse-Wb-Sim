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
use super::exact_lethal::{search_exact_lethal, sure_lethal_options};
use super::greedy::choose_greedy;
use super::keys::{hand_eq_noid, visible_eq, TurnOrderSet};
use super::lethal::{
    find_lethal, search_lethal, LethalOptions, LethalSearch, DEFAULT_LETHAL_OPTIONS,
    GUARDED_LETHAL_OPTIONS,
};
use super::mulligan::{
    model_mulligan_swap, mulligan_action, sampled_mulligan, weighted_mulligan_swap,
};
use super::think::{Thought, ThoughtCandidate};
use super::valuenet::{value_net_eval, ValuePhase};
use super::{Agent, Rng};
use crate::game::{
    acting_player, apply_legal, is_legal, legal_actions, resolve_turn_end, try_apply_action,
};
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

/// 上位の手を読み直すとき、相手のターンの後の自分の次のターンもビームサーチで打ち、そのターン末の点数で評価する（ownNext、実験用）
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OwnNextSearch {
    pub beam_width: usize,
    pub max_depth: usize,
    /// 次のターン末の点数を混ぜる割合（1 なら次のターン末の点数だけ、0.5 なら相手のターンの後の点数と半分ずつ）
    pub mix: f64,
}

/// 探索 AI の設定（search.ts の SearchOptions。exhaustive 等の実験用の項目のうち既定で使わないものは省く）
#[derive(Clone)]
pub struct SearchOptions {
    pub samples: usize,
    pub beam_width: usize,
    pub max_depth: usize,
    pub rescore_top: usize,
    pub lethal: bool,
    /// リーサル探索の途中の点数で、守護に止められている顔への打点にかける重み（`LethalOptions::ward_blocked`）
    pub lethal_ward_blocked: f64,
    /// リーサル探索で自分の選択待ちをその場で展開する（`LethalOptions::expand_choices`）
    pub lethal_expand_choices: bool,
    /// ビームで見つからないとき、乱数に依らない手だけの全探索で調べる局面数の上限（ターンあたりはこの 2 倍。0 なら使わない）
    pub lethal_exact_states: i64,
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
    /// next_lethal を足す相手の体力の上限（None なら評価の重みの lethal_range）
    pub next_lethal_range: Option<f64>,
    pub next_lethal_search: Option<NextLethalSearch>,
    /// 相手が何もしなければ次のターンに倒しきれる（next_lethal_search で調べる）終局面を、ターン末の点数の高い順に
    /// この数まで、相手のターンを読む候補に足す（passLethal）
    pub pass_lethal: usize,
    /// passLethal で終局面を選ぶ判定（None なら next_lethal_search）
    pub pass_lethal_search: Option<NextLethalSearch>,
    pub beam_pp: f64,
    pub extra_eval: Option<ExtraEval>,
    /// 相手のターンを読むビームの評価に足す項（opponentSearch.extraEval のとき。None なら extra_eval と同じ）。
    /// リノセウス用 AI は、エルフ用の打点の項を除いた学習した補正だけを渡す
    pub opp_extra_eval: Option<ExtraEval>,
    /// 評価関数の重み（None なら探索 AI の既定 SEARCH_WEIGHTS）
    pub weights: Option<Arc<Weights>>,
    pub opponent_search: Option<OpponentSearch>,
    pub own_next: Option<OwnNextSearch>,
    pub opp_hand_samples: usize,
    /// oppHandSamples で引き直す相手の手札を、読み直すどの終局面でも同じ並びにする（手どうしの差のぶれを減らす）
    pub opp_hand_common: bool,
    pub peek_opp_hand: bool,
    pub opp_fuse: bool,
    pub danger_rescore: usize,
    /// 上位の手を読み直した点数に、ターン末の点数をこの割合で混ぜる（0 なら読み直した点数だけ。既定 0.5、2026-10-22）
    pub rescore_mix: f64,
    pub reuse_agree: bool,
    /// 上位の手を読み直すとき、このターンに引いて手札に残っているカードも引き直す（oppHandSamples の引き直しごと。ビームで決めた 1 通りの引きで手を比べない）
    pub resample_draws: bool,
    /// 選んだ並びの途中でカードを引く手を、先に打っても並びの残りが打てて点数が下がらなければ先に打つ（引いたカードを見てから残りを決める）
    pub draw_first: bool,
    /// 選んだ並びの、相手のターンを読んだ後の想像の局面を残す（SearchAgent::take_reads。TD 学習の自己対戦の --imagined 用。打つ手は変わらない）
    pub record_reads: bool,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions {
            samples: 1,
            // 32 から 128 に（6400 試合で 52.9%、時間は 1 割ほど増える。docs/ai-notes.md「棋譜の指摘: ビームの幅」）
            beam_width: 128,
            max_depth: 8,
            rescore_top: 4,
            lethal: true,
            lethal_ward_blocked: GUARDED_LETHAL_OPTIONS.ward_blocked,
            lethal_expand_choices: GUARDED_LETHAL_OPTIONS.expand_choices,
            // リーサル探索のビームで見つからないとき全探索する（与えうるダメージの上限で打ち切るので速い。docs/ai-notes.md「リーサル探索: ビームで見つからないとき全探索で調べる」）
            lethal_exact_states: 20_000,
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
            plan_candidates: 1,
            per_first: 0,
            next_lethal: 0.0,
            next_lethal_range: None,
            next_lethal_search: None,
            pass_lethal: 0,
            pass_lethal_search: None,
            beam_pp: 0.0,
            extra_eval: Some(Arc::new(value_net_eval)),
            opp_extra_eval: None,
            weights: None,
            // 相手のターンを読むビームの幅は 4 から 16 に（6400 試合で 51.9%、物差しは 78.0% → 79.8%。
            // docs/ai-notes.md「相手のターンを読むビームの幅を 16 に」）
            opponent_search: Some(OpponentSearch {
                beam_width: 16,
                max_depth: 8,
                extra_eval: false,
            }),
            own_next: None,
            opp_hand_samples: 12,
            opp_hand_common: true,
            peek_opp_hand: false,
            opp_fuse: false,
            danger_rescore: 0,
            rescore_mix: 0.5,
            reuse_agree: false,
            resample_draws: false,
            draw_first: false,
            record_reads: false,
        }
    }
}

impl SearchOptions {
    /// 2026-10-16 より前の既定の読み方（決定化 3 回それぞれで幅 32 のビームを打ち、最初の手ごとに終局面を 3 つまで読み直す。
    /// 読み直した点数にターン末の点数を混ぜない）。
    /// 人間の記録との比較の相手（search-classic）と TD 学習の自己対戦は、今までと比べられるようこちらを使う
    pub fn with_classic_sampling(self) -> SearchOptions {
        SearchOptions {
            beam_width: 32,
            samples: 3,
            plan_candidates: 3,
            opp_hand_samples: 1,
            opp_hand_common: false,
            rescore_mix: 0.0,
            ..self
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
    /// 相手のターンを読んだ後の想像の局面（record_reads のときだけ。読み直した並びの、引き直しごとに 1 つ）
    pub reads: Vec<Rc<GameState>>,
}

/// 点数の内訳（「AI の考え」の表示用）。total は探索が使った点数、eval は手で作った評価関数、extra は評価に足す項（学習した補正など）。
/// total と eval + extra の差は、残り PP の罰・後攻 5 ターン目のエクストラPP・次のターンのリーサルの加点など
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct ScoreParts {
    pub total: f64,
    pub eval: f64,
    pub extra: f64,
}

/// plan_turn の途中の点数（「AI の考え」の表示用。SearchAgent::think）
#[derive(Default)]
pub struct PlanTrace {
    /// 最初の手ごとの、ターン末の点数が最も高い並び（plan.value はターン末の点数）と、その点数の内訳
    pub turn_end: Vec<(Plan, ScoreParts)>,
    /// 相手のターンを読み直した点数の内訳（読み直した最初の手だけ。plan_turn が返す並びのもの。eval・extra は読み直しの平均）
    pub reads: Vec<(Action, ScoreParts)>,
}

/// 探索で使う重み（評価関数の重みと、相手の手番の貪欲法の重み）
pub struct Env<'a> {
    pub opts: &'a SearchOptions,
    pub w: &'a EvalWeights,
    pub policy_w: &'a EvalWeights,
}

/// 並びの 1 手（手と、1 つ前の手の添字）
struct Step {
    action: Action,
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
    /// 探索を始めた局面（steps の並びの局面は、ここから手を打ち直して作る）
    root: Rc<GameState>,
    steps: Vec<Step>,
}

impl<'a> Planner<'a> {
    fn opts(&self) -> &'a SearchOptions {
        self.env.opts
    }

    fn push_step(&mut self, action: Action, prev: Option<usize>) -> usize {
        self.steps.push(Step { action, prev });
        self.steps.len() - 1
    }

    /// path までの並びと、各手を打った後の局面。局面は root から打ち直して作る
    /// （探索中のすべての局面を残すとメモリを多く使って遅くなるので、並びには手だけを残している）。
    /// 最初のターン終了は打たずに root の局面のまま（beam_terminals と同じ）
    fn steps_of(&self, path: usize) -> Vec<(Action, Rc<GameState>)> {
        let mut order = Vec::new();
        let mut cur = Some(path);
        while let Some(i) = cur {
            order.push(i);
            cur = self.steps[i].prev;
        }
        let mut state = self.root.clone();
        order
            .into_iter()
            .rev()
            .map(|i| {
                let a = &self.steps[i].action;
                if !matches!(a, Action::EndTurn) {
                    state = Rc::new(apply_legal(&state, a));
                }
                (a.clone(), state.clone())
            })
            .collect()
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

    /// 相手のターンを読んだ後の局面（想像の局面）の点数
    fn eval_after(&self, s: &GameState) -> f64 {
        let v = evaluate_with(s, self.p, self.env.w);
        match &self.opts().extra_eval {
            Some(f) => v + f(s, self.p, ValuePhase::Imagined),
            None => v,
        }
    }

    /// 局面 s の手で作った評価と、評価に足す項（phase の）
    fn parts(&self, s: &GameState, phase: ValuePhase) -> (f64, f64) {
        let extra = match &self.opts().extra_eval {
            Some(f) => f(s, self.p, phase),
            None => 0.0,
        };
        (evaluate_with(s, self.p, self.env.w), extra)
    }

    /// ターン末の点数（end_score）の内訳
    fn end_parts(&self, s: &GameState, total: f64) -> ScoreParts {
        let settled = self.settle(s);
        let base = settled.as_ref().unwrap_or(s);
        let resolved = resolve_turn_end(base);
        let (eval, extra) = self.parts(resolved.as_ref().unwrap_or(base), ValuePhase::End);
        ScoreParts { total, eval, extra }
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

    /// 手 a を打った局面と、そこまでの並びを out に足す。chain なら、続く自分の選択とエクストラPP の後の手まで進めた局面すべて
    fn advance(
        &mut self,
        s: &Rc<GameState>,
        a: &Action,
        prev: Option<usize>,
        depth: u32,
        out: &mut Vec<(Rc<GameState>, usize)>,
    ) {
        // a は s の合法手（expand・legal_actions の手）なので、打てるかは確かめ直さない
        debug_assert!(is_legal(s, a), "合法手でない: {a:?}");
        let next = Rc::new(apply_legal(s, a));
        let path = self.push_step(a.clone(), prev);
        let opts = self.opts();
        if !opts.chain || depth >= 8 || next.phase == Phase::Ended {
            out.push((next, path));
            return;
        }
        let p = self.p;
        if next.pending.as_ref().is_some_and(|pd| pd.player() == p) {
            let start = out.len();
            for c in legal_actions(&next) {
                if self.allowed(&next, &c) {
                    self.advance(&next, &c, Some(path), depth + 1, out);
                }
            }
            if out.len() == start {
                out.push((next, path));
            }
            return;
        }
        if opts.chain_fuse
            && matches!(a, Action::Fuse { .. })
            && next.pending.is_none()
            && next.active == p
        {
            out.push((next.clone(), path));
            for c in self.expand(&next) {
                if matches!(c, Action::EndTurn | Action::Fuse { .. }) || !self.allowed(&next, &c) {
                    continue;
                }
                self.advance(&next, &c, Some(path), depth + 1, out);
            }
            return;
        }
        if matches!(a, Action::ExtraPp) && next.pending.is_none() && next.active == p {
            let start = out.len();
            for c in self.expand(&next) {
                if matches!(c, Action::EndTurn | Action::ExtraPp) || !self.allowed(&next, &c) {
                    continue;
                }
                self.advance(&next, &c, Some(path), depth + 1, out);
            }
            if out.len() == start {
                out.push((next, path));
            }
            return;
        }
        out.push((next, path));
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
        let mut next: Vec<(Rc<GameState>, usize)> = Vec::new();
        // 深さ 1: すべての手を展開する（最初の手の候補を落とさない）
        for a in self.expand(root) {
            if !self.allowed(root, &a) {
                continue;
            }
            if matches!(a, Action::EndTurn) {
                if root_converges {
                    continue; // 合流する攻撃をしてから終える手に劣らない
                }
                let path = self.push_step(a.clone(), None);
                let value = self.score(root);
                terminals.push(Node {
                    state: root.clone(),
                    first: a,
                    value,
                    path,
                });
                continue;
            }
            next.clear();
            self.advance(root, &a, None, 0, &mut next);
            for (st, path) in next.drain(..) {
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
                    next.clear();
                    self.advance(&st, &a, Some(path), 0, &mut next);
                    for (ns, np) in next.drain(..) {
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

/// ビームサーチの終局面と、最初の手ごとにターン末の点数が最も高い終局面の添字（最初の手が出てきた順）
fn turn_end_bests<'a>(
    root: &Rc<GameState>,
    p: PlayerIndex,
    env: &'a Env<'a>,
) -> (Planner<'a>, Vec<Node>, Vec<(Action, usize)>) {
    let opts = env.opts;
    let mut pl = Planner {
        env,
        p,
        root: root.clone(),
        steps: Vec::new(),
    };
    let root_converges = opts.settle_trades && !converging_attacks(root, p).is_empty();
    let mut terminals = pl.beam_terminals(root, root_converges);
    if opts.score_turn_end == ScoreTurnEnd::Terminal {
        for t in terminals.iter_mut() {
            t.value = pl.end_score(&t.state);
        }
    }
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
    (pl, terminals, best_by_first)
}

/// plan_turn（相手のターンを読まない）の並びのうち点数が最も高いもの（同じなら先のもの）の、最後の手とその後の局面。
/// 並びの局面は打ち直して作るので、使うものだけを作る
fn best_plan_last(
    root: &Rc<GameState>,
    p: PlayerIndex,
    env: &Env,
) -> Option<(Action, Rc<GameState>)> {
    let (pl, terminals, bests) = turn_end_bests(root, p, env);
    let mut best: Option<usize> = None;
    for &(_, i) in &bests {
        if best.is_none_or(|b| terminals[i].value > terminals[b].value) {
            best = Some(i);
        }
    }
    best.and_then(|i| pl.steps_of(terminals[i].path).pop())
}

/// plan_turn（相手のターンを読まない）の並びの点数の最大（並びが無ければ None）
fn best_plan_value(root: &Rc<GameState>, p: PlayerIndex, env: &Env) -> Option<f64> {
    let (_, terminals, bests) = turn_end_bests(root, p, env);
    bests
        .iter()
        .map(|&(_, i)| terminals[i].value)
        .fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v))))
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
    plan_turn_traced(root, p, env, rng, rescore, None)
}

/// plan_turn と同じ。trace があれば、途中の点数とその内訳を書き込む（乱数の使い方も結果も plan_turn と同じ）
pub fn plan_turn_traced(
    root: &Rc<GameState>,
    p: PlayerIndex,
    env: &Env,
    rng: &mut Rng,
    rescore: bool,
    mut trace: Option<&mut PlanTrace>,
) -> Vec<(Action, Plan)> {
    let opts = env.opts;
    // 最初の手ごとに最善の終局面を残し、上位を相手のターンまで読んで評価し直す
    let (pl, terminals, best_by_first) = turn_end_bests(root, p, env);
    if let Some(tr) = trace.as_deref_mut() {
        for (_, i) in &best_by_first {
            let t = &terminals[*i];
            let plan = Plan {
                action: t.first.clone(),
                value: t.value,
                steps: pl.steps_of(t.path),
                reads: Vec::new(),
            };
            let parts = pl.end_parts(&t.state, t.value);
            tr.turn_end.push((plan, parts));
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
                    reads: Vec::new(),
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

    let common_seeds: Vec<u32> = if opts.opp_hand_common && opts.opp_hand_samples > 1 {
        (0..opts.opp_hand_samples)
            .map(|_| rng.int(u32::MAX as usize) as u32)
            .collect()
    } else {
        Vec::new()
    };
    let mut result: Vec<(Action, Plan)> = Vec::new();
    let mut rescored: Vec<usize> = Vec::new();
    let tracing = trace.is_some();
    let mut reads: Vec<(Action, ScoreParts)> = Vec::new();
    let rescore_node = |i: usize,
                        rng: &mut Rng,
                        result: &mut Vec<(Action, Plan)>,
                        reads: &mut Vec<(Action, ScoreParts)>| {
        let node = &terminals[i];
        // 読み直した局面の手で作った評価と評価に足す項の合計（trace のときだけ求める）
        let mut parts = (0.0, 0.0);
        // 読み直した局面（record_reads のときだけ残す）
        let mut afters: Vec<Rc<GameState>> = Vec::new();
        let mut add = |after: GameState| {
            if tracing {
                let (e, x) = pl.parts(&after, ValuePhase::Imagined);
                parts.0 += e;
                parts.1 += x;
            }
            if opts.record_reads {
                afters.push(Rc::new(after));
            }
        };
        let (value, n) = if node.state.phase == Phase::Ended {
            if tracing {
                parts = pl.parts(&node.state, ValuePhase::End);
            }
            (pl.eval_state(&node.state), 1)
        } else if opts.opp_hand_samples <= 1 {
            let settled = pl.settle(&node.state);
            let (v, after) = read_once(&pl, settled.as_ref().unwrap_or(&node.state), rng);
            add(after);
            (v - pl.leftover(&node.state), 1)
        } else {
            let settled = pl.settle(&node.state);
            let base = settled.as_ref().unwrap_or(&node.state);
            let mut sum = 0.0;
            if opts.opp_hand_common {
                for &seed in &common_seeds {
                    let mut r = Rng::new(seed);
                    let mut d = determinize(base, p, &mut r, opts.peek_opp_hand);
                    if opts.resample_draws {
                        resample_own_draws(&mut d, root, p, &mut r);
                    }
                    let (v, after) = read_once(&pl, &d, &mut r);
                    sum += v;
                    add(after);
                }
            } else {
                for _ in 0..opts.opp_hand_samples {
                    let d = determinize(base, p, rng, opts.peek_opp_hand);
                    let (v, after) = read_once(&pl, &d, rng);
                    sum += v;
                    add(after);
                }
            }
            (
                sum / opts.opp_hand_samples as f64 - pl.leftover(&node.state),
                opts.opp_hand_samples,
            )
        };
        // 選ぶときの値は、読み直した点数にターン末の点数を混ぜたもの（考えの表示の内訳は読み直した点数のまま）
        let read_value = value;
        let value = if opts.rescore_mix > 0.0 && node.state.phase != Phase::Ended {
            (1.0 - opts.rescore_mix) * value + opts.rescore_mix * node.value
        } else {
            value
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
                reads: afters,
            };
            match result.iter_mut().find(|(k, _)| *k == node.first) {
                Some(e) => e.1 = plan,
                None => result.push((node.first.clone(), plan)),
            }
            if tracing {
                let sp = ScoreParts {
                    total: read_value,
                    eval: parts.0 / n as f64,
                    extra: parts.1 / n as f64,
                };
                match reads.iter_mut().find(|(k, _)| *k == node.first) {
                    Some(e) => e.1 = sp,
                    None => reads.push((node.first.clone(), sp)),
                }
            }
        }
    };
    for best in ranked {
        for i in candidates_of(best) {
            rescore_node(i, rng, &mut result, &mut reads);
            rescored.push(i);
        }
    }
    // 相手が何もしなければ次のターンに倒しきれる終局面を、ターン末の点数の高い順に passLethal 個まで読み足す
    if opts.pass_lethal > 0 {
        if let Some(f) = opts
            .pass_lethal_search
            .as_ref()
            .or(opts.next_lethal_search.as_ref())
        {
            let mut seen = TurnOrderSet::default();
            for &i in &rescored {
                seen.add(&terminals[i].state);
            }
            let mut order: Vec<usize> = (0..terminals.len()).collect();
            order.sort_by(|&x, &y| by_value_desc(terminals[x].value, terminals[y].value));
            let mut added: Vec<Action> = Vec::new();
            let mut n = 0;
            for i in order {
                if n >= opts.pass_lethal {
                    break;
                }
                let t = &terminals[i];
                if t.state.phase == Phase::Ended
                    || rescored.contains(&i)
                    || added.contains(&t.first)
                    || !seen.add(&t.state)
                {
                    continue;
                }
                let settled = pl.settle(&t.state);
                let base = settled.as_ref().unwrap_or(&t.state);
                if !pass_turn(base, p).is_some_and(|next| f(&next, p)) {
                    continue;
                }
                rescore_node(i, rng, &mut result, &mut reads);
                rescored.push(i);
                added.push(t.first.clone());
                n += 1;
            }
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
            rescore_node(i, rng, &mut result, &mut reads);
            n += 1;
        }
    }
    if let Some(tr) = trace {
        tr.reads = reads;
    }
    result
}

/// このターンに山札から引いて手札に残っている p のカード（root の山札にあったもの。条件付きで引いたもの・公開されたものは除く）を、
/// p の山札と合わせて並べ直す（resampleDraws）。受けたスペルブーストは引き直したカードにかけ直す。
/// 山札に戻って手札での状態を持っているカードは、その状態ごと動かす
pub(crate) fn resample_own_draws(
    s: &mut GameState,
    root: &GameState,
    p: PlayerIndex,
    rng: &mut Rng,
) {
    let root_deck = &root.players[p].deck;
    let idx: Vec<usize> = (0..s.players[p].hand.len())
        .filter(|&i| {
            let h = &s.players[p].hand[i];
            !h.revealed && h.drawn_by.is_none() && root_deck.iter().any(|c| c.iid == h.iid)
        })
        .collect();
    if idx.is_empty() {
        return;
    }
    let root_kept = |iid: Iid| root.players[p].deck_kept.iter().find(|h| h.iid == iid);
    // (カード, 山札にあったときの手札での状態)
    let mut pool: Vec<(crate::data::CardIdx, Option<HandCard>)> = idx
        .iter()
        .map(|&i| {
            let h = &s.players[p].hand[i];
            (h.card, root_kept(h.iid).cloned())
        })
        .collect();
    let deck_kept = std::mem::take(&mut s.players[p].deck_kept);
    for c in &s.players[p].deck {
        pool.push((c.card, deck_kept.iter().find(|h| h.iid == c.iid).cloned()));
    }
    rng.shuffle(&mut pool);
    let mut pool = pool.into_iter();
    let mut boosted: Vec<(Iid, i32)> = Vec::new();
    for &i in &idx {
        let old = &s.players[p].hand[i];
        let iid = old.iid;
        // 引いてから受けたスペルブーストの回数
        let boosts = old.boosts - root_kept(iid).map_or(0, |k| k.boosts);
        let (card, kept) = pool.next().unwrap();
        let h = match kept {
            Some(k) => HandCard { iid, ..k },
            None => s.new_hand_card(card, Some(iid)),
        };
        s.players[p].hand.make_mut()[i] = h;
        if boosts > 0 {
            boosted.push((iid, boosts));
        }
    }
    let pl = &mut s.players[p];
    for c in pl.deck.make_mut().iter_mut() {
        let (card, kept) = pool.next().unwrap();
        c.card = card;
        if let Some(k) = kept {
            pl.deck_kept.push(HandCard { iid: c.iid, ..k });
        }
    }
    for (iid, boosts) in boosted {
        crate::effects::fire_spellboost(s, p, iid, boosts);
    }
    crate::effects::run(s);
}

/// drawFirst で、先に引く並びのターン末の点数が元の並びをこれだけ下回っても先に引く（引いたカードの受けるスペルブースト等で学習した補正が少し動く分。
/// 先に引いて残りを決め直せる価値は点数に入っていない）
const DRAW_FIRST_SLACK: f64 = 1.0;

/// 並び steps（root から）の途中でカードを引く手を先頭に動かした並び（drawFirst）。
/// 残りの手がすべて合法で、ターン末の点数が元の並びから DRAW_FIRST_SLACK 以内のときだけ返す
fn draw_first_steps(
    root: &Rc<GameState>,
    steps: &[(Action, Rc<GameState>)],
    p: PlayerIndex,
    env: &Env,
) -> Option<Vec<(Action, Rc<GameState>)>> {
    let pl = Planner {
        env,
        p,
        root: root.clone(),
        steps: Vec::new(),
    };
    let root_legal = legal_actions(root);
    let base = pl.end_score(&steps.last()?.1);
    for i in 1..steps.len() {
        let (a, st) = &steps[i];
        let prev = &steps[i - 1].1;
        if !matches!(
            a,
            Action::Play(_) | Action::Act(_) | Action::Evolve(_) | Action::SuperEvolve(_)
        ) || st.pending.is_some()
            || st.active != p
            || st.players[p].deck.len() >= prev.players[p].deck.len()
            || !root_legal.contains(a)
        {
            continue;
        }
        // PP が足りなければ、並びの中のエクストラPP も一緒に先に使う
        let xpp = steps.iter().position(|x| matches!(x.0, Action::ExtraPp));
        let mut orders: Vec<Vec<&Action>> = Vec::new();
        let rest = |skip: Option<usize>| {
            steps
                .iter()
                .enumerate()
                .filter(move |(j, _)| *j != i && Some(*j) != skip)
                .map(|(_, x)| &x.0)
        };
        orders.push(std::iter::once(a).chain(rest(None)).collect());
        if let Some(j) = xpp.filter(|&j| j > 0) {
            orders.push([&steps[j].0, a].into_iter().chain(rest(Some(j))).collect());
        }
        for order in orders {
            if let Some(out) = replay(root, &order) {
                if pl.end_score(&out.last()?.1) >= base - DRAW_FIRST_SLACK {
                    return Some(out);
                }
            }
        }
    }
    None
}

/// root から手を順に打った並び（どれかが合法でなければ None）
fn replay(root: &Rc<GameState>, order: &[&Action]) -> Option<Vec<(Action, Rc<GameState>)>> {
    let mut cur: Rc<GameState> = root.clone();
    let mut out: Vec<(Action, Rc<GameState>)> = Vec::new();
    for &b in order {
        if !legal_actions(&cur).contains(b) {
            return None;
        }
        cur = Rc::new(try_apply_action(&cur, b)?);
        out.push((b.clone(), cur.clone()));
    }
    Some(out)
}

/// p のターンを終え、相手が何もせずにターンを終えて、p の次のターンが始まった局面（途中の選択は最初の選択肢）
pub fn pass_turn(s: &GameState, p: PlayerIndex) -> Option<GameState> {
    let mut cur = try_apply_action(s, &Action::EndTurn)?;
    let mut guard = 0;
    while cur.phase != Phase::Ended && (cur.active != p || cur.pending.is_some()) {
        guard += 1;
        if guard > 40 {
            return None;
        }
        let a = if cur.pending.is_some() {
            legal_actions(&cur).into_iter().next()?
        } else {
            Action::EndTurn
        };
        cur = try_apply_action(&cur, &a)?;
    }
    (cur.phase != Phase::Ended).then_some(cur)
}

/// start から相手のターンを読んだ点数と、読んだ後の局面
fn read_once(pl: &Planner, start: &GameState, rng: &mut Rng) -> (f64, GameState) {
    let env = pl.env;
    let p = pl.p;
    let after = if env.opts.opponent_search.is_some() {
        simulate_opponent_turn_by_search(start, p, rng, env)
    } else {
        simulate_opponent_turn(start, p, rng, env.policy_w, env.opts.opp_fuse)
    };
    let mut v = match env.opts.own_next {
        Some(on) if after.phase != Phase::Ended && after.active == p && after.pending.is_none() => {
            let next = own_next_value(pl, &after, on);
            if on.mix >= 1.0 {
                next
            } else {
                (1.0 - on.mix) * pl.eval_after(&after) + on.mix * next
            }
        }
        _ => pl.eval_after(&after),
    };
    if env.opts.next_lethal != 0.0
        && after.phase != Phase::Ended
        && after.players[opponent(p)].leader_hp as f64
            <= env.opts.next_lethal_range.unwrap_or(env.w.w.lethal_range)
        && match &env.opts.next_lethal_search {
            Some(f) => f(&after, p),
            None => search_lethal(&after, p, &DEFAULT_LETHAL_OPTIONS).is_some(),
        }
    {
        v += env.opts.next_lethal;
    }
    (v, after)
}

/// 自分の次のターンの始めの局面 after から、自分のターンをビームサーチで打った最善のターン末の点数（ownNext）
fn own_next_value(pl: &Planner, after: &GameState, on: OwnNextSearch) -> f64 {
    let env = pl.env;
    let opts = SearchOptions {
        beam_width: on.beam_width,
        max_depth: on.max_depth,
        opponent_search: None,
        own_next: None,
        next_lethal: 0.0,
        pass_lethal: 0,
        ..env.opts.clone()
    };
    let next_env = Env {
        opts: &opts,
        w: env.w,
        policy_w: env.policy_w,
    };
    let root = Rc::new(after.clone());
    best_plan_value(&root, pl.p, &next_env).unwrap_or_else(|| pl.eval_after(after))
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
            opts.opp_extra_eval
                .clone()
                .or_else(|| opts.extra_eval.clone())
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
            if let Some((action, last)) = &best_plan_last(&root, q, &opp_env) {
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
    /// plan を求めたサンプルの局面
    root: Rc<GameState>,
}

/// 探索 AI（search.ts の createSearchAgent）
pub struct SearchAgent {
    pub opts: SearchOptions,
    w: EvalWeights,
    policy_w: EvalWeights,
    default_w: EvalWeights,
    plans: [Option<PlanState>; 2],
    /// 最後に選んだ並びの想像の局面（record_reads のとき）
    reads: [Vec<Rc<GameState>>; 2],
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
            reads: [Vec::new(), Vec::new()],
        }
    }

    /// p が最後に選んだ並びの、相手のターンを読んだ後の想像の局面（record_reads のとき）を取り出す。取り出すと空になる
    pub fn take_reads(&mut self, p: PlayerIndex) -> Vec<Rc<GameState>> {
        std::mem::take(&mut self.reads[p])
    }
}

impl SearchAgent {
    /// このターンに勝てる並びの最初の手（lethal のとき。見つからない・実際の局面で打てなければ None）
    pub(crate) fn lethal_action(
        &self,
        real: &GameState,
        legal: &[Action],
        p: PlayerIndex,
        rng: &mut Rng,
    ) -> Option<Action> {
        let opts = &self.opts;
        if !opts.lethal {
            return None;
        }
        let lo = LethalOptions {
            ward_blocked: opts.lethal_ward_blocked,
            expand_choices: opts.lethal_expand_choices,
            ..DEFAULT_LETHAL_OPTIONS
        };
        let exact_states = opts.lethal_exact_states;
        let with_exact = |root: &GameState, q: PlayerIndex| {
            search_lethal(root, q, &lo)
                .or_else(|| search_exact_lethal(root, q, &sure_lethal_options(exact_states)))
        };
        let search: Option<LethalSearch> = if exact_states > 0 {
            Some(&with_exact)
        } else {
            None
        };
        find_lethal(real, p, rng, &lo, search).filter(|l| legal.contains(l))
    }

    /// choose_action と同じ乱数の使い方で手を選び、比べた手と点数の内訳を返す（前に選んだ並びは使わず、考え直す）。
    /// lethal が Some なら、リーサルを先に調べたものとして扱う（デッキ専用の AI が自分で調べたとき）
    pub fn think_with(
        &self,
        real: &GameState,
        legal: &[Action],
        rng: &mut Rng,
        lethal: Option<Option<Action>>,
    ) -> Option<Thought> {
        let first = legal.first()?;
        if legal.len() == 1 || matches!(first, Action::Mulligan { .. }) {
            return None;
        }
        let opts = &self.opts;
        let p = acting_player(real);
        let lethal = match lethal {
            Some(l) => l,
            None => self.lethal_action(real, legal, p, rng),
        };
        let env = Env {
            opts,
            w: &self.w,
            policy_w: &self.policy_w,
        };
        /// 最初の手ごとの読み直しの集計（choose_action の Total と同じ）
        #[derive(Default)]
        struct Acc {
            sum: f64,
            read: f64,
            count: usize,
            eval: f64,
            extra: f64,
            best: f64,
        }
        let mut roots: Vec<GameState> = Vec::new();
        let mut candidates: Vec<ThoughtCandidate> = Vec::new();
        let mut accs: Vec<Acc> = Vec::new();
        // 読み直した手の、choose_action の totals と同じ順（決定化ごとに plan_turn が返した順で、初めて出たところ）
        let mut totals: Vec<usize> = Vec::new();
        for sample in 0..opts.samples {
            let det = Rc::new(determinize(real, p, rng, opts.peek_opp_hand));
            let mut trace = PlanTrace::default();
            let plans = plan_turn_traced(&det, p, &env, rng, true, Some(&mut trace));
            roots.push((*det).clone());
            for (plan, turn_end) in &trace.turn_end {
                if candidates.iter().any(|c| c.action == plan.action) {
                    continue;
                }
                candidates.push(ThoughtCandidate {
                    action: plan.action.clone(),
                    sample,
                    steps: plan.steps.iter().map(|(a, _)| a.clone()).collect(),
                    turn_end: *turn_end,
                    read: None,
                    read_count: 0,
                    value: None,
                    legal: legal.contains(&plan.action),
                });
                accs.push(Acc::default());
            }
            for (k, read_plan) in &plans {
                let Some(i) = candidates.iter().position(|c| c.action == *k) else {
                    continue;
                };
                let parts = trace
                    .reads
                    .iter()
                    .find(|(x, _)| x == k)
                    .map(|(_, sp)| *sp)
                    .unwrap_or_default();
                let acc = &mut accs[i];
                let c = &mut candidates[i];
                // 並びは、読み直した点数が最も高かった決定化のもの（choose_action と同じ）
                if acc.count == 0 || read_plan.value > acc.best {
                    acc.best = read_plan.value;
                    c.sample = sample;
                    c.steps = read_plan.steps.iter().map(|(a, _)| a.clone()).collect();
                    if let Some((_, te)) = trace.turn_end.iter().find(|(x, _)| x.action == *k) {
                        c.turn_end = *te;
                    }
                }
                acc.sum += read_plan.value;
                acc.read += parts.total;
                acc.eval += parts.eval;
                acc.extra += parts.extra;
                acc.count += 1;
                if !totals.contains(&i) {
                    totals.push(i);
                }
            }
        }
        for (c, acc) in candidates.iter_mut().zip(&accs) {
            if acc.count > 0 {
                let n = acc.count as f64;
                c.read = Some(ScoreParts {
                    total: acc.read / n,
                    eval: acc.eval / n,
                    extra: acc.extra / n,
                });
                c.read_count = acc.count;
                c.value = Some(acc.sum / n - (opts.samples - acc.count) as f64 * 0.5);
            }
        }
        // 選ぶ手（choose_action と同じ: 実際の局面で打てる手のうち、選ぶときの値が最も高いもの。同じ値なら totals で先のもの）
        let mut best: Option<usize> = None;
        let mut best_value = f64::NEG_INFINITY;
        for &i in &totals {
            let c = &candidates[i];
            if !c.legal {
                continue;
            }
            let value = c.value.unwrap_or(f64::NEG_INFINITY);
            if value > best_value {
                best_value = value;
                best = Some(i);
            }
        }
        let chosen = match (&lethal, best) {
            (Some(l), _) => l.clone(),
            (None, Some(i)) => candidates[i].action.clone(),
            (None, None) => {
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
        };
        candidates.sort_by(|x, y| match (x.value, y.value) {
            (Some(a), Some(b)) => by_value_desc(a, b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => by_value_desc(x.turn_end.total, y.turn_end.total),
        });
        Some(Thought {
            player: p,
            lethal,
            roots,
            candidates,
            chosen,
        })
    }

    /// 局面 root で p が打てる並びを、最初の手ごとに 1 つずつ、相手のターンを読み直した点数の高い順に返す
    /// （読み直すのは点数の高い rescore_top 個の最初の手だけ）。root を決定化せずにそのまま読む。
    /// TD 学習の打ち比べ（runner/td.rs の --cmp）が、同じ局面から打ち比べる手の候補に使う
    pub fn ranked_plans(&self, root: &GameState, p: PlayerIndex, rng: &mut Rng) -> Vec<Plan> {
        let env = Env {
            opts: &self.opts,
            w: &self.w,
            policy_w: &self.policy_w,
        };
        let root = Rc::new(root.clone());
        let mut plans: Vec<Plan> = plan_turn(&root, p, &env, rng, true)
            .into_iter()
            .map(|(_, x)| x)
            .collect();
        plans.sort_by(|x, y| by_value_desc(x.value, y.value));
        plans
    }
}

/// 探索の外から、探索と同じ点数で局面を採点する（人間の手順と比べる runner/human_plan.rs が使う。打つ手は変えない）
impl SearchAgent {
    fn env(&self) -> Env<'_> {
        Env {
            opts: &self.opts,
            w: &self.w,
            policy_w: &self.policy_w,
        }
    }

    /// p のターン末の局面 end（ターン終了を打つ前）の、ビームが付ける点数（合流する相打ちとターン終了時の処理の後に評価し、残り PP の罰等を引く）
    pub fn turn_end_value(&self, end: &GameState, p: PlayerIndex) -> f64 {
        let env = self.env();
        let pl = Planner {
            env: &env,
            p,
            root: Rc::new(end.clone()),
            steps: Vec::new(),
        };
        pl.end_score(end)
    }

    /// p のターン末の局面 end から相手のターンを読んだ後の点数（plan_turn の読み直しと同じ。
    /// 引き直しは seeds ごとに 1 回で、同じ seeds なら局面が違っても同じ乱数を使う）
    pub fn read_value(&self, end: &GameState, p: PlayerIndex, seeds: &[u32]) -> f64 {
        let env = self.env();
        let pl = Planner {
            env: &env,
            p,
            root: Rc::new(end.clone()),
            steps: Vec::new(),
        };
        if end.phase == Phase::Ended || seeds.is_empty() {
            return pl.eval_state(end);
        }
        let settled = pl.settle(end);
        let base = settled.as_ref().unwrap_or(end);
        let mut sum = 0.0;
        for &seed in seeds {
            let mut r = Rng::new(seed);
            let d = determinize(base, p, &mut r, self.opts.peek_opp_hand);
            sum += read_once(&pl, &d, &mut r).0;
        }
        sum / seeds.len() as f64 - pl.leftover(end)
    }

    /// 局面 root で p が打てる並びの、最初の手ごとにターン末の点数が最も高い終局面とその点数（ビームの候補。root を決定化せずに読む）
    pub fn turn_end_candidates(
        &self,
        root: &GameState,
        p: PlayerIndex,
    ) -> Vec<(Action, f64, GameState)> {
        let env = self.env();
        let root = Rc::new(root.clone());
        let (_, terminals, bests) = turn_end_bests(&root, p, &env);
        bests
            .into_iter()
            .map(|(k, i)| (k, terminals[i].value, (*terminals[i].state).clone()))
            .collect()
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
    fn think(&mut self, real: &GameState, legal: &[Action], rng: &mut Rng) -> Option<Thought> {
        self.think_with(real, legal, rng, None)
    }

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
            if let Some(a) = swap.and_then(|swap| mulligan_action(legal, &swap)) {
                return a.clone();
            }
            // 重みの無いデッキは貪欲法と同じ（コスト 4 以上を返す）
            return choose_greedy(real, legal, rng, false, &self.default_w, false);
        }
        let p = real
            .pending
            .as_ref()
            .map(|pd| pd.player())
            .unwrap_or(real.active);

        if let Some(l) = self.lethal_action(real, legal, p, rng) {
            self.plans[p] = None;
            self.reads[p].clear();
            return l;
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
                            t.root = det.clone();
                        }
                    }
                    None => totals.push(Total {
                        action: k,
                        sum: sample.value,
                        count: 1,
                        plans: vec![sample.clone()],
                        plan: sample,
                        root: det.clone(),
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
            let mut steps = steps;
            let mut action = best.action.clone();
            if opts.draw_first && steps.len() > 1 {
                if let Some(s2) = draw_first_steps(&best.root, &steps, p, &env) {
                    action = s2[0].0.clone();
                    steps = s2;
                }
            }
            if opts.reuse_plan && steps.len() > 1 {
                self.plans[p] = Some(PlanState { steps, index: 1 });
            }
            if opts.record_reads {
                self.reads[p] = best.plan.reads.clone();
            }
            return action;
        }
        self.reads[p].clear();
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
