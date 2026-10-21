//! リノセウスエルフ用の AI（もとは src/ai/rhino.ts）。
//!
//! リノセウス専用のリーサル探索で倒しきれれば最優先で打ち、それ以外は探索 AI に任せる。
//! エルフの探索には、次のターンのリノセウスの打点の項（potential）を評価に足す。
//! 以前はユーザーが作ったルール（マリガン・温存・1 枚目の杖・燐光の岩・最後の杖と岩を残す 等）も重ねていたが、
//! 学習した補正を入れた後はルールを外したほうが強かったので消した（docs/ai-notes.md「リノセウス用 AI のルールを消す」）。
//! エルフ以外のデッキでは探索 AI と同じ。

use super::determinize::determinize;
use super::exact_lethal::{
    reset_exact_lethal_cache, search_exact_lethal, ExactLethalOptions, MaxPlay, MustPlay,
    DEFAULT_EXACT_LETHAL_OPTIONS,
};
use super::lethal::{
    find_lethal, search_lethal, LethalOptions, DEFAULT_LETHAL_OPTIONS, DIRECT_SCORING,
};
use super::rhino_lethal::{search_rhino_lethal, tag, Tag, DEFAULT_RHINO_LETHAL_OPTIONS};
use super::search::{ExtraEval, SearchAgent, SearchOptions};
use super::think::Thought;
use super::valuenet::ValuePhase;
use super::{Agent, Rng};
use crate::data::{ClassId, AMBUSH, INTIMIDATE, STORM, WARD};
use crate::game::{acting_player, legal_actions, try_apply_action};
use crate::state::*;
use std::sync::Arc;

/// ビームに最初の手ごとに残す局面の数（SearchOptions.perFirst）
const RHINO_PER_FIRST: usize = 4;

/// 上限の式が見るプレイヤーの状態（次のターンの見積もりでは、PP 等を変え、場のフォロワーを除いたもの）
#[derive(Clone, Copy)]
struct View<'a> {
    hand: &'a [HandCard],
    board: &'a [OnBoard],
    with_followers: bool,
    pp: i32,
    extra_pp: bool,
    combo: i32,
    evolved: bool,
    ep: i32,
    sep: i32,
    turn_count: i32,
    order: usize,
    turn: i32,
}

impl<'a> View<'a> {
    fn of(s: &'a GameState, p: PlayerIndex) -> View<'a> {
        let pl = &s.players[p];
        View {
            hand: &pl.hand,
            board: &pl.board,
            with_followers: true,
            pp: pl.pp,
            extra_pp: pl.extra_pp_available,
            combo: pl.combo,
            evolved: pl.evolved_this_turn,
            ep: pl.ep,
            sep: pl.sep,
            turn_count: pl.turn_count,
            order: if p == s.first { 0 } else { 1 },
            turn: s.turn,
        }
    }
    /// 次の自分のターン: PP は最大値 +1、コンボ 0、進化は未使用、場のフォロワーは数えない
    fn next_turn(s: &'a GameState, p: PlayerIndex) -> View<'a> {
        let pl = &s.players[p];
        View {
            with_followers: false,
            pp: (pl.max_pp + 1).min(MAX_PP),
            combo: 0,
            evolved: false,
            turn_count: pl.turn_count + 1,
            ..View::of(s, p)
        }
    }
    fn board(&self) -> impl Iterator<Item = &'a OnBoard> + '_ {
        self.board
            .iter()
            .filter(|c| self.with_followers || !c.is_follower)
    }
    fn board_count(&self, name: Tag) -> i32 {
        self.board().filter(|c| tag(c.card) == name).count() as i32
    }
    fn in_hand(&self, name: Tag) -> i32 {
        self.hand.iter().filter(|h| tag(h.card) == name).count() as i32
    }
    fn has_in_hand(&self, name: Tag) -> bool {
        self.hand.iter().any(|h| tag(h.card) == name)
    }
    fn can_super(&self) -> bool {
        !self.evolved && self.sep > 0 && self.turn_count >= SUPER_EVOLVE_TURN[self.order]
    }
    fn can_evolve(&self) -> bool {
        !self.evolved && self.ep > 0 && self.turn_count >= EVOLVE_TURN[self.order]
    }
    fn total_pp(&self) -> i32 {
        self.pp + self.extra_pp as i32
    }
    /// 場に残っていてリーダーを攻撃できるフォロワー
    fn leader_attackers(&self) -> impl Iterator<Item = &'a OnBoard> + '_ {
        self.board().filter(|c| {
            if !c.is_follower || c.attacks_this_turn >= c.max_attacks {
                return false;
            }
            if c.cannot_attack_until.is_some_and(|t| t >= self.turn) {
                return false;
            }
            c.entered_turn != self.turn || c.has_keyword(STORM)
        })
    }
    /// 場に残っていてリーダーを攻撃できるフォロワーの攻撃力（残りの攻撃回数分）
    fn board_attack(&self) -> i32 {
        self.leader_attackers()
            .map(|c| c.attack_value() * (c.max_attacks - c.attacks_this_turn))
            .sum()
    }
    /// リノセウスを rhinos 回出した残りで自由に使える PP
    fn free_pp(&self, rhinos: i32) -> i32 {
        let carbuncle = self.can_super()
            && (self.has_in_hand(Tag::Carbuncle) || self.board_count(Tag::Carbuncle) > 0);
        self.total_pp() + carbuncle as i32 - rhinos * 3
    }
    /// 手札の煌撃の戦士・ベイルのうち、リノセウスを rhinos 回出すターンに 0 コストまで下がりうるもの
    fn zero_cost_bails(&self, rhinos: i32) -> i32 {
        let followers = self.board().filter(|c| c.is_follower).count() as i32;
        let free = self.free_pp(rhinos).max(0);
        self.hand
            .iter()
            .filter(|h| {
                tag(h.card) == Tag::Bail && card(h.card).cost + h.cost_mod - followers - free <= 0
            })
            .count() as i32
    }
    /// リノセウスを 2 回出して与えられるダメージの上限
    fn damage_bound(&self) -> i32 {
        let mut bound = 2 * (self.total_pp() - 7) + 8 + 2 * self.combo;
        if self.can_super() {
            bound += if self.in_hand(Tag::Carbuncle) + self.board_count(Tag::Carbuncle) > 0 {
                2
            } else {
                0
            };
        } else {
            bound -= if self.can_evolve() { 1 } else { 3 };
        }
        bound += 2 * (self.in_hand(Tag::Mystery) + self.zero_cost_bails(2))
            + self.in_hand(Tag::Rock)
            + self.board_count(Tag::Rock);
        bound + self.board_attack()
    }
    /// リノセウスを 1 回出して与えられるダメージの上限
    fn one_damage_bound(&self) -> i32 {
        let mut bound = self.total_pp() - 2
            + self.combo
            + self.in_hand(Tag::Mystery)
            + self.zero_cost_bails(1)
            + self.in_hand(Tag::Rock)
            + self.board_count(Tag::Rock);
        bound += if self.can_super() {
            3
        } else if self.can_evolve() {
            2
        } else {
            0
        };
        bound + self.board_attack()
    }
    /// リノセウスを 3 回出して与えられるダメージの上限
    fn three_damage_bound(&self) -> i32 {
        let evo = if self.can_super() {
            3
        } else if self.can_evolve() {
            2
        } else {
            0
        };
        let mut bound =
            3 * (self.total_pp() - 9) + 6 + 3 * (self.combo + self.in_hand(Tag::Mystery)) + evo;
        bound += self.in_hand(Tag::Rock) + self.board_count(Tag::Rock) + self.board_attack();
        bound
    }
    /// リノセウスを 3 回出せるかもしれない
    fn may_play_three_rhinos(&self) -> bool {
        let bounce = self.board_count(Tag::Rod) > 0
            || self.has_in_hand(Tag::Bugs)
            || self.has_in_hand(Tag::Carbuncle);
        self.in_hand(Tag::Rhino) >= 2 && bounce && self.total_pp() >= 9
    }
    /// リノセウスで与えられるダメージの上限
    fn lethal_bound(&self) -> i32 {
        let bound = self.one_damage_bound().max(self.damage_bound());
        if self.may_play_three_rhinos() {
            bound.max(self.three_damage_bound())
        } else {
            bound
        }
    }
}

/// リノセウスで与えられるダメージの上限（1 回・2 回の式の大きい方。3 回出せるかもしれなければ 3 回の式も見る）
pub fn rhino_lethal_bound(s: &GameState, p: PlayerIndex) -> i32 {
    View::of(s, p).lethal_bound()
}

/// 次の自分のターンにリノセウスで与えられるダメージの上限の見積もり
pub fn next_turn_rhino_bound(s: &GameState, p: PlayerIndex) -> i32 {
    let pl = &s.players[p];
    let rhinos = pl.hand.iter().filter(|h| tag(h.card) == Tag::Rhino).count();
    if rhinos == 0 {
        return 0;
    }
    let v = View::next_turn(s, p);
    let bounce = v.board_count(Tag::Rod) > 0
        || pl
            .hand
            .iter()
            .any(|h| matches!(tag(h.card), Tag::Bugs | Tag::Carbuncle));
    if rhinos == 1 && !bounce {
        v.one_damage_bound()
    } else {
        v.lethal_bound()
    }
}

/// リノセウスを 2 回出して与えられるダメージの上限（ユーザーの式。テスト用）
#[cfg(test)]
pub(crate) fn rhino_damage_bound(s: &GameState, p: PlayerIndex) -> i32 {
    View::of(s, p).damage_bound()
}

/// リノセウスを 3 回出して与えられるダメージの上限（テスト用）
#[cfg(test)]
pub(crate) fn rhino_three_damage_bound(s: &GameState, p: PlayerIndex) -> i32 {
    View::of(s, p).three_damage_bound()
}

/// rhinoPotentialEval の係数の既定（600 試合で 0 → 262 勝、1.0 → 291。docs/ai-notes.md）
pub const RHINO_POTENTIAL: f64 = 1.0;

/// 評価に足す項: 次のターンのリノセウスの打点の上限が相手の体力に足りない分 × potential ＋ learned（rhino.ts の addEval）。
/// potential が 0 なら learned だけ
pub fn rhino_extra_eval(potential: f64, learned: Option<ExtraEval>) -> Option<ExtraEval> {
    if potential == 0.0 {
        return learned;
    }
    let short = move |s: &GameState, p: PlayerIndex| {
        potential * (next_turn_rhino_bound(s, p) - s.players[opponent(p)].leader_hp).min(0) as f64
    };
    Some(match learned {
        None => Arc::new(move |s: &GameState, p: PlayerIndex, _: ValuePhase| short(s, p)),
        Some(b) => Arc::new(move |s: &GameState, p: PlayerIndex, phase: ValuePhase| {
            short(s, p) + b(s, p, phase)
        }),
    })
}

/// リノセウス用 AI の探索の設定（createRhinoAgent の既定。user の設定はこの上に上書きする）
pub fn rhino_search_options(potential: f64, learned: Option<ExtraEval>) -> SearchOptions {
    SearchOptions {
        lethal: false,
        per_first: RHINO_PER_FIRST,
        next_lethal_search: Some(Arc::new(rhino_next_lethal)),
        extra_eval: rhino_extra_eval(potential, learned.clone()),
        // 相手のターンの読みで相手の評価にも補正を足すとき（opponentSearch.extraEval。既定では使わない）は、
        // エルフ用の打点の項を除いた補正だけにする（docs/ai-notes.md「棋譜の指摘: バックウッドかフェアリーか」）
        opp_extra_eval: learned,
        ..SearchOptions::default()
    }
}

/// 次のターンの始めの局面で、リノセウスを使って倒しきれるか（手札にリノセウスがあり、上限の式が相手の体力に届くときだけ探す）
pub fn rhino_next_lethal(s: &GameState, q: PlayerIndex) -> bool {
    s.players[q].hand.iter().any(|h| tag(h.card) == Tag::Rhino)
        && rhino_lethal_bound(s, q) >= s.players[opponent(q)].leader_hp
        && search_lethal_for_rhino(s, q).is_some()
}

/// 次のターンに、相手の守護のフォロワーに与えられるダメージの見積もり（ユーザーの案）。
/// フェアリー（突進 1/1。妖精の招集・フェアリーテイマーは 2 枚、燐光の岩は 1 枚と数える）1 枚につき 1、メイ 3、0 コストまで下がりうるベイル 4、
/// 超進化できるならベビーカーバンクル 5（場にいるか、手札のカーバンクルをリノセウスを戻すのに使わなくてよいとき）
pub fn ward_clear_damage(s: &GameState, q: PlayerIndex) -> i32 {
    let v = View::of(s, q);
    let fairies = v.in_hand(Tag::Fairy)
        + 2 * (v.in_hand(Tag::FairyCall) + v.in_hand(Tag::Tamer))
        + v.in_hand(Tag::Rock);
    let other_bounce =
        v.board_count(Tag::Rod) > 0 || v.has_in_hand(Tag::Bugs) || v.in_hand(Tag::Rhino) >= 2;
    let carbuncle = v.can_super()
        && (v.board_count(Tag::Carbuncle) > 0 || (v.has_in_hand(Tag::Carbuncle) && other_bounce));
    fairies + 3 * v.in_hand(Tag::May) + 4 * v.zero_cost_bails(2) + 5 * carbuncle as i32
}

/// passLethal の判定: 次のターンの始めにリノセウスで倒しきれ、守護への見積もりのダメージが ward 以上
pub fn rhino_pass_lethal(ward: i32) -> super::search::NextLethalSearch {
    Arc::new(move |s: &GameState, q: PlayerIndex| {
        ward_clear_damage(s, q) >= ward && rhino_next_lethal(s, q)
    })
}

const DIRECT_ONLY: LethalOptions = LethalOptions {
    scorings: &[DIRECT_SCORING],
    ..DEFAULT_LETHAL_OPTIONS
};

/// リーサル探索: 汎用の探索（今すぐ殴れるダメージ重視）で見つからなければ、リノセウス専用の探索
pub fn search_lethal_for_rhino(root: &GameState, p: PlayerIndex) -> Option<Vec<Action>> {
    search_lethal(root, p, &DIRECT_ONLY)
        .or_else(|| search_rhino_lethal(root, p, &DEFAULT_RHINO_LETHAL_OPTIONS))
}

/// 全探索で手を試す順番: リーダーへの攻撃 → カードのプレイ（コストの低い順）→ アクト → 進化 → フォロワーへの攻撃
fn exact_order_rank(s: &GameState, p: PlayerIndex, a: &Action) -> f64 {
    match a {
        Action::Attack { target, .. } => {
            if target.is_none() {
                0.0
            } else {
                5.0
            }
        }
        Action::Play(iid) => {
            let cost = s.players[p]
                .hand
                .iter()
                .find(|h| h.iid == *iid)
                .map_or(0, |h| card(h.card).cost);
            1.0 + cost as f64 / 100.0
        }
        Action::Act(_) => 2.0,
        Action::Evolve(_) | Action::SuperEvolve(_) => 3.0,
        _ => 4.0,
    }
}

fn spend_actions(s: &GameState) -> Vec<Action> {
    legal_actions(s)
        .into_iter()
        .filter(|a| matches!(a, Action::Play(_) | Action::Act(_)))
        .collect()
}

/// 相手の場に、攻撃先になる守護のフォロワーがいるか
fn opponent_has_ward(s: &GameState, p: PlayerIndex) -> bool {
    s.players[opponent(p)].board.iter().any(|c| {
        c.is_follower && c.has_keyword(WARD) && !c.has_keyword(AMBUSH) && !c.has_keyword(INTIMIDATE)
    })
}

/// エクストラPPを使うと、今は PP が足りずに出せない・アクトできないカードが出せるようになるか
fn extra_pp_enables_spend(s: &GameState) -> bool {
    let Some(next) = try_apply_action(s, &Action::ExtraPp) else {
        return false;
    };
    let before = spend_actions(s);
    spend_actions(&next).iter().any(|k| !before.contains(k))
}

fn is_rhino_follower_attack(s: &GameState, p: PlayerIndex, a: &Action) -> bool {
    let Action::Attack {
        attacker,
        target: Some(_),
    } = a
    else {
        return false;
    };
    s.players[p]
        .board
        .iter()
        .find(|x| x.iid == *attacker)
        .is_some_and(|c| tag(c.card) == Tag::Rhino)
}

pub fn is_rhino_play(s: &GameState, a: &Action) -> bool {
    let Action::Play(iid) = a else { return false };
    s.players[s.active]
        .hand
        .iter()
        .find(|c| c.iid == *iid)
        .is_some_and(|h| tag(h.card) == Tag::Rhino)
}

fn rhino_order(s: &GameState, p: PlayerIndex, actions: Vec<Action>) -> Vec<Action> {
    let mut out: Vec<Action> = actions
        .into_iter()
        .filter(|a| {
            !is_rhino_follower_attack(s, p, a)
                && (!matches!(a, Action::ExtraPp) || extra_pp_enables_spend(s))
                && !(is_rhino_play(s, a) && opponent_has_ward(s, p))
        })
        .collect();
    out.sort_by(|x, y| {
        exact_order_rank(s, p, x)
            .partial_cmp(&exact_order_rank(s, p, y))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

fn rhino_order_no_wasted_evolve(
    s: &GameState,
    p: PlayerIndex,
    actions: Vec<Action>,
) -> Vec<Action> {
    let mut out = rhino_order(s, p, actions);
    out.retain(|a| !wasted_evolve(s, p, a));
    out
}

fn rhino_forced(s: &GameState, p: PlayerIndex, legal: &[Action]) -> Option<Action> {
    let mystery = s.players[p]
        .hand
        .iter()
        .find(|h| tag(h.card) == Tag::Mystery)?;
    legal
        .iter()
        .find(|a| **a == Action::Play(mystery.iid))
        .cloned()
}

/// 全探索のリーサル探索の設定
pub fn rhino_exact() -> ExactLethalOptions {
    ExactLethalOptions {
        max_states: 60_000,
        max_states_per_turn: 120_000,
        ignore_exhausted_stats: true,
        order: Some(rhino_order),
        forced: Some(rhino_forced),
        extra_bound: Some(rhino_turn_damage_bound),
        ..DEFAULT_EXACT_LETHAL_OPTIONS
    }
}

/// 自分のターンに実際に打つ手を決めるときのリーサル探索
pub fn search_lethal_for_rhino_turn(root: &GameState, p: PlayerIndex) -> Option<Vec<Action>> {
    let found = search_lethal_for_rhino(root, p);
    if let Some(f) = &found {
        if wins_elsewhere(root, p, f) {
            return found;
        }
    }
    if !root.players[p]
        .hand
        .iter()
        .any(|h| tag(h.card) == Tag::Rhino)
    {
        return found;
    }
    let hp = root.players[opponent(p)].leader_hp;
    let bound = rhino_lethal_bound(root, p);
    if hp > bound {
        return found;
    }
    let mut lucky: Option<Vec<Action>> = None;
    for opts in rhino_exact_searches(root, p, hp) {
        let Some(exact) = search_exact_lethal(root, p, &opts) else {
            continue;
        };
        if wins_elsewhere(root, p, &exact) {
            return Some(exact);
        }
        // 乱数で結果が変わる手を除いて探し直す
        let sure_opts = ExactLethalOptions {
            deterministic_only: true,
            ..opts
        };
        if let Some(sure) = search_exact_lethal(root, p, &sure_opts) {
            return Some(sure);
        }
        if lucky.is_none() {
            lucky = Some(exact);
        }
    }
    lucky.or(found)
}

/// 進化・超進化の対象を絞ってよい余裕の境目（このターンに進化か超進化ができれば 2、どちらもできなければ 0）
fn evolve_slack_limit(s: &GameState, p: PlayerIndex) -> i32 {
    let v = View::of(s, p);
    if v.can_super() || v.can_evolve() {
        2
    } else {
        0
    }
}

/// 上限の式で数えた分を出せない進化・超進化
fn wasted_evolve(s: &GameState, p: PlayerIndex, a: &Action) -> bool {
    let (iid, sup) = match a {
        Action::Evolve(iid) => (*iid, false),
        Action::SuperEvolve(iid) => (*iid, true),
        _ => return false,
    };
    let Some(c) = s.players[p].board.iter().find(|x| x.iid == iid) else {
        return false;
    };
    if !c.is_follower {
        return false;
    }
    if View::of(s, p).leader_attackers().any(|x| x.iid == c.iid) {
        return false;
    }
    !(sup && matches!(tag(c.card), Tag::Carbuncle | Tag::Olivier))
}

/// 全探索をリノセウスを出す回数ごと（1 回以下・2 回・3 回以上）に分けたときの、それぞれの設定
pub fn rhino_exact_searches(root: &GameState, p: PlayerIndex, hp: i32) -> Vec<ExactLethalOptions> {
    let bounds = rhino_bounds(root, p);
    let mut out = Vec::new();
    for (i, &(rhinos, bound)) in bounds.iter().enumerate() {
        if bound < hp {
            continue;
        }
        let last = i == bounds.len() - 1;
        let mut opts = ExactLethalOptions {
            leader_only: leader_only_attackers(root, p, bound - hp),
            no_play: useless_plays(root, p, hp, &[(rhinos, bound)]),
            ..rhino_exact()
        };
        if rhinos >= 2 {
            opts.must_play = Some(MustPlay {
                count: rhinos,
                matches: is_rhino_play,
                feasible: can_still_play_rhinos,
            });
        }
        if !last {
            opts.max_play = Some(MaxPlay {
                count: rhinos,
                matches: is_rhino_play,
            });
        }
        if bound - hp < evolve_slack_limit(root, p) {
            opts.order = Some(rhino_order_no_wasted_evolve);
            opts.order_key = Some("evolve");
        }
        out.push(opts);
    }
    out
}

/// リノセウスを出す回数と、その回数での上限
pub fn rhino_bounds(s: &GameState, p: PlayerIndex) -> Vec<(i32, i32)> {
    let v = View::of(s, p);
    let mut bounds = vec![(1, v.one_damage_bound()), (2, v.damage_bound())];
    if v.may_play_three_rhinos() {
        bounds.push((3, v.three_damage_bound()));
    }
    bounds
}

/// 超進化したベビーカーバンクルの PP 3 回復で増やせる PP（場にいれば 3。手札なら出すコストを引いた分で、今の PP で出せるときだけ）
fn carbuncle_refund(v: &View) -> i32 {
    if !v.can_super() {
        return 0;
    }
    if v.board_count(Tag::Carbuncle) > 0 {
        return 3;
    }
    v.hand
        .iter()
        .filter(|h| tag(h.card) == Tag::Carbuncle)
        .map(|h| (card(h.card).cost + h.cost_mod).max(0))
        .filter(|&cost| cost <= v.total_pp())
        .map(|cost| 3 - cost)
        .max()
        .unwrap_or(0)
        .max(0)
}

/// 相手の能力が、自分のターンのうちに相手自身のリーダーにダメージを与えうるか（見積もれないものも含める。depth は召喚・変身したカードをたどる深さ）
fn effects_may_hit_own_leader(effs: &[crate::data::Effect], depth: u32) -> bool {
    use crate::data::{Effect, Side, Target};
    fn hits(t: &Target, slots: &[(crate::data::SlotId, &Target)]) -> bool {
        match t {
            Target::Leader { side } => *side != Side::Opponent,
            Target::This | Target::Board { .. } | Target::Hand { .. } => false,
            Target::Slot { slot } => slots
                .iter()
                .rev()
                .find(|e| e.0 == *slot)
                .is_none_or(|e| hits(e.1, slots)),
            Target::Union { of } => of.iter().any(|x| hits(x, slots)),
            Target::MaxAttack { of } => hits(of, slots),
            Target::Event => true,
        }
    }
    fn card_risky(c: crate::data::CardIdx, depth: u32) -> bool {
        depth == 0
            || crate::state::abilities_of(c)
                .abilities
                .iter()
                .any(|a| effects_may_hit_own_leader(&a.effects, depth - 1))
    }
    fn walk<'a>(
        effs: &'a [Effect],
        slots: &mut Vec<(crate::data::SlotId, &'a Target)>,
        depth: u32,
    ) -> bool {
        for e in effs {
            let risky = match e {
                Effect::Choose { slot, from, .. } | Effect::Random { slot, from, .. } => {
                    slots.push((*slot, from));
                    false
                }
                Effect::Damage { target, .. }
                | Effect::Distribute { target, .. }
                | Effect::SetDefense { target, .. } => hits(target, slots),
                Effect::SetLeaderMaxHp { side, .. } | Effect::Crest { side, .. } => {
                    *side != Side::Opponent
                }
                Effect::Summon { card_id, .. } | Effect::Transform { card_id, .. } => {
                    card_risky(*card_id, depth)
                }
                Effect::SummonCopy { .. }
                | Effect::Reanimate { .. }
                | Effect::SummonFromDeck { .. }
                | Effect::SummonDestroyedAmulet => true,
                Effect::Grant { abilities, .. } => abilities
                    .iter()
                    .flatten()
                    .any(|a| walk(&a.effects, &mut slots.clone(), depth)),
                Effect::Mode { options } => {
                    options.iter().any(|o| walk(o, &mut slots.clone(), depth))
                }
                Effect::If {
                    then, otherwise, ..
                } => {
                    walk(then, &mut slots.clone(), depth)
                        || otherwise
                            .as_ref()
                            .is_some_and(|o| walk(o, &mut slots.clone(), depth))
                }
                Effect::Repeat { effects, .. } => walk(effects, slots, depth),
                Effect::EarthRite { then, .. } | Effect::Necromancy { then, .. } => {
                    walk(then, slots, depth)
                }
                _ => false,
            };
            if risky {
                return true;
            }
        }
        false
    }
    walk(effs, &mut Vec::new(), depth)
}

/// 相手の場・クレストに、自分のターンのうちに相手自身のリーダーにダメージを与えうる能力があるか
fn opponent_may_hurt_itself(s: &GameState, p: PlayerIndex) -> bool {
    let opp = &s.players[opponent(p)];
    opp.board
        .iter()
        .flat_map(|c| c.abilities())
        .chain(opp.crests.iter().flat_map(|c| crest_abilities_of(c.crest)))
        .any(|a| effects_may_hit_own_leader(&a.effects, 3))
}

/// このターンの残りで、リノセウスエルフのカードだけで相手リーダーに与えうるダメージの上限（全探索の途中の局面で打ち切りに使う）。
/// 手札・場が下のカードだけで、自分にクレスト・付与された能力が無く、相手に自分を傷つける能力が無いときだけ見積もる（それ以外は None）。
/// - これから出すリノセウスを j 回（PP（カーバンクルの回復を含む）÷ 3、手札のリノセウス ＋ 戻す手段の数まで）とし、
///   リノセウス以外のカードはすべて 1 体目より前に出すとみなす。出せる枚数は 残りの PP（1 コスト以上のカードは 1 PP につき 1 枚。燐光の岩は森の神秘を含めて 2 PP で 2 枚）
///   ＋ 0 コストのカード ＋ 手札のベイル（0 コストまで下がりうる）＋ 戻して 0 コストで出し直しうるベイル ＋ 回復に数えたカーバンクル
/// - i 体目の打点は コンボ ＋ その枚数 ＋ i。燐光の岩（手札・場、戻して出し直す分）1 枚につき +1、進化 +2・超進化 +3（カーバンクルの回復に使えば、そのカーバンクルがリーダーを攻撃できるときだけ）、
///   リーダーを攻撃できる場のフォロワーの攻撃力、超進化したフォロワーの残りの攻撃 1 回につきぶっとばし +1
pub fn rhino_turn_damage_bound(s: &GameState, p: PlayerIndex) -> Option<i32> {
    if s.phase != Phase::Main || s.active != p || s.pending.is_some() {
        return None;
    }
    let pl = &s.players[p];
    let v = View::of(s, p);
    let evolvable = v.can_evolve() || v.can_super();
    let known = |c: crate::data::CardIdx| match tag(c) {
        Tag::Other | Tag::Backwood | Tag::Olivier => false,
        Tag::Lily => !evolvable,
        _ => true,
    };
    if !pl.crests.is_empty()
        || !pl.hand.iter().all(|h| known(h.card))
        || !pl
            .board
            .iter()
            .all(|c| known(c.card) && c.granted.is_empty())
        || opponent_may_hurt_itself(s, p)
    {
        return None;
    }
    let pp = v.total_pp();
    let rhinos_in_hand = v.in_hand(Tag::Rhino);
    let rhinos = rhinos_in_hand + v.board_count(Tag::Rhino);
    let bounces = v.board_count(Tag::Rod)
        + v.in_hand(Tag::Rod)
        + v.in_hand(Tag::Carbuncle)
        + v.board_count(Tag::Carbuncle)
        + v.in_hand(Tag::Bugs);
    let zero = pl
        .hand
        .iter()
        .filter(|h| tag(h.card) == Tag::Bail || card(h.card).cost + h.cost_mod <= 0)
        .count() as i32;
    let rocks = v.in_hand(Tag::Rock) + v.board_count(Tag::Rock);
    let smash_now: i32 = pl
        .board
        .iter()
        .filter(|c| c.is_follower && c.evolve == Evolve::SuperEvolved)
        .map(|c| (c.max_attacks - c.attacks_this_turn).max(0))
        .sum();
    let fixed = v.board_attack() + smash_now;
    let refund = carbuncle_refund(&v);
    let followers = pl.board.iter().filter(|c| c.is_follower).count() as i32;
    // 手札・場のベイルの元のコスト（手札に戻すと元のコストからやり直しになる）
    let bails: Vec<i32> = pl
        .hand
        .iter()
        .map(|h| h.card)
        .chain(pl.board.iter().map(|c| c.card))
        .filter(|&c| tag(c) == Tag::Bail)
        .map(|c| card(c).cost)
        .collect();
    // (使える PP, 回復に数えたカーバンクルの分の枚数, 進化の打点, 新しく超進化したフォロワーのぶっとばし)
    let mut variants = vec![(
        pp,
        0,
        if v.can_super() {
            3
        } else if v.can_evolve() {
            2
        } else {
            0
        },
        v.can_super() as i32,
    )];
    if refund > 0 {
        let prepaid = (v.board_count(Tag::Carbuncle) == 0) as i32;
        // 場のカーバンクルがリーダーを攻撃できるなら、超進化の +3 はそのまま打点になる
        let evo = if v.leader_attackers().any(|c| tag(c.card) == Tag::Carbuncle) {
            3
        } else {
            0
        };
        variants.push((pp + refund, prepaid, evo, 1));
    }
    let mut best = 0;
    for (t, prepaid, evo, smash_new) in variants {
        let max_j = if rhinos == 0 {
            0
        } else {
            (t / 3).min(rhinos_in_hand + bounces).max(0)
        };
        // ベイルを手札に戻して、このターンに場を離れうるフォロワーの数（今の場 ＋ 出せる枚数）が元のコスト以上なら、もう一度 0 コストで出しうる
        let replay_bails = (bails
            .iter()
            .filter(|&&cost| followers + t + zero + prepaid >= cost)
            .count() as i32)
            .min(bounces);
        for j in 0..=max_j {
            let free = (t - 3 * j).max(0);
            let n = free + zero + replay_bails + prepaid;
            let rhino = j * (pl.combo + n) + j * (j + 1) / 2;
            let spare_bounces = (bounces - (j - rhinos_in_hand).max(0)).max(0);
            let rock_acts = rocks + spare_bounces.min(free / 2);
            best = best.max(rhino + rock_acts + evo + smash_new + fixed);
        }
    }
    Some(best)
}

/// あと remaining 回リノセウスを出せるかもしれないか
pub fn can_still_play_rhinos(s: &GameState, p: PlayerIndex, remaining: i32) -> bool {
    let v = View::of(s, p);
    if v.total_pp() + carbuncle_refund(&v) < 3 * remaining {
        return false;
    }
    let rhinos = v.in_hand(Tag::Rhino);
    if rhinos >= remaining {
        return true;
    }
    let bounce =
        v.board_count(Tag::Rod) > 0 || v.has_in_hand(Tag::Bugs) || v.has_in_hand(Tag::Carbuncle);
    bounce && rhinos + v.board_count(Tag::Rhino) > 0
}

/// 乱数・山札・相手の手札を決め直した局面でも勝てるか
fn wins_elsewhere(root: &GameState, p: PlayerIndex, seq: &[Action]) -> bool {
    [1u32, 2].iter().all(|&seed| {
        let mut rng = Rng::new(root.rng ^ seed.wrapping_mul(0x9e3779b9));
        let mut s: Option<GameState> = Some(determinize(root, p, &mut rng, false));
        for a in seq {
            match &s {
                Some(x) if x.phase != Phase::Ended => s = try_apply_action(x, a),
                _ => break,
            }
        }
        matches!(s, Some(x) if x.phase == Phase::Ended && x.winner == Some(p))
    })
}

/// 出すと上限が相手の体力に届かなくなる手札のカード
fn useless_plays(s: &GameState, p: PlayerIndex, hp: i32, bounds: &[(i32, i32)]) -> Vec<Iid> {
    let pl = &s.players[p];
    let v = View::of(s, p);
    let reachable: Vec<(i32, i32)> = bounds.iter().copied().filter(|&(_, b)| b >= hp).collect();
    let useless = |rhinos: i32, bound: i32, cost: i32| bound - rhinos * (cost - 1) < hp;
    let mut out: Vec<Iid> = pl
        .hand
        .iter()
        .filter(|h| {
            matches!(
                tag(h.card),
                Tag::Backwood | Tag::Lily | Tag::Rod | Tag::Tamer
            )
        })
        .filter(|h| {
            let cost = (card(h.card).cost + h.cost_mod).max(0);
            reachable.iter().all(|&(r, b)| useless(r, b, cost))
        })
        .map(|h| h.iid)
        .collect();
    let super_bonus = v.can_super() as i32;
    for h in pl.hand.iter().filter(|x| tag(x.card) == Tag::Olivier) {
        let cost = (card(h.card).cost + h.cost_mod - 2).max(0);
        if reachable
            .iter()
            .all(|&(r, b)| useless(r, b + super_bonus, cost))
        {
            out.push(h.iid);
        }
    }
    let rocks: Vec<&HandCard> = pl
        .hand
        .iter()
        .filter(|h| tag(h.card) == Tag::Rock)
        .collect();
    if rocks.is_empty() || reachable.is_empty() {
        return out;
    }
    let mysteries = v.in_hand(Tag::Mystery);
    // 出さない岩の数: 届く式のどれでも、1 コスト換算で出せる回数を超え、超えた分を出すと届かなくなる数
    let rock_cost = (card(rocks[0].card).cost + rocks[0].cost_mod).max(0);
    let excess = reachable
        .iter()
        .map(|&(r, b)| {
            let to_combo2 = (2 - mysteries - v.zero_cost_bails(r)).max(0);
            let playable = (v.free_pp(r) - to_combo2).div_euclid(2).max(0);
            if useless(r, b, rock_cost) {
                (rocks.len() as i32 - playable).max(0)
            } else {
                0
            }
        })
        .min()
        .unwrap_or(0);
    out.extend(rocks.iter().take(excess.max(0) as usize).map(|h| h.iid));
    out
}

/// 上限の式でリーダーへの攻撃として数えた場のフォロワーのうち、攻撃力が余裕より大きいもの
fn leader_only_attackers(s: &GameState, p: PlayerIndex, slack: i32) -> Vec<Iid> {
    View::of(s, p)
        .leader_attackers()
        .filter(|c| c.attack_value() > slack)
        .map(|c| c.iid)
        .collect()
}

/// 手札・場・山札で最初に見つかった中立以外のクラス（weights.ts の deckClassOf）
pub fn deck_class_of(s: &GameState, p: PlayerIndex) -> ClassId {
    let pl = &s.players[p];
    pl.hand
        .iter()
        .map(|h| h.card)
        .chain(pl.board.iter().map(|c| c.card))
        .chain(pl.deck.iter().map(|c| c.card))
        .map(|c| card(c).class)
        .find(|c| *c != ClassId::Neutral)
        .unwrap_or(ClassId::Neutral)
}

/// リノセウス用 AI（rhino_eval が false なら、リノセウスの打点の項を使わずリノセウス用のリーサル探索だけを足した比較用の AI）
pub struct RhinoAgent {
    rhino_eval: bool,
    search: SearchAgent,
    plain: SearchAgent,
}

impl RhinoAgent {
    /// 既定の設定のリノセウス用 AI
    pub fn new(rhino_eval: bool) -> RhinoAgent {
        let learned = SearchOptions::default().extra_eval;
        RhinoAgent::with_options(
            rhino_eval,
            rhino_search_options(RHINO_POTENTIAL, learned.clone()),
            SearchOptions {
                extra_eval: learned,
                ..SearchOptions::default()
            },
        )
    }

    /// search はエルフの探索の設定、plain はエルフ以外のデッキ・打点の項を使わないときの探索の設定
    pub fn with_options(
        rhino_eval: bool,
        search: SearchOptions,
        plain: SearchOptions,
    ) -> RhinoAgent {
        RhinoAgent {
            rhino_eval,
            search: SearchAgent::new(search),
            plain: SearchAgent::new(plain),
        }
    }
}

impl Agent for RhinoAgent {
    /// choose_action と同じ流れで、探索の部分の考えを返す（リノセウス用のリーサル探索で見つけたリーサルも入れる）
    fn think(&mut self, real: &GameState, legal: &[Action], rng: &mut Rng) -> Option<Thought> {
        let first = legal.first()?;
        if legal.len() == 1 || matches!(first, Action::Mulligan { .. }) {
            return None;
        }
        let p = acting_player(real);
        if deck_class_of(real, p) != ClassId::Elf {
            return self.plain.think(real, legal, rng);
        }
        let turn_search: &dyn Fn(&GameState, PlayerIndex) -> Option<Vec<Action>> =
            &search_lethal_for_rhino_turn;
        if !self.rhino_eval {
            if real.active == p {
                if let Some(l) =
                    find_lethal(real, p, rng, &DEFAULT_LETHAL_OPTIONS, Some(turn_search))
                        .filter(|l| legal.contains(l))
                {
                    return self.plain.think_with(real, legal, rng, Some(Some(l)));
                }
            }
            return self.plain.think(real, legal, rng);
        }
        if real.active != p {
            return self.search.think(real, legal, rng);
        }
        let l = find_lethal(real, p, rng, &DEFAULT_LETHAL_OPTIONS, Some(turn_search))
            .filter(|l| legal.contains(l));
        self.search.think_with(real, legal, rng, Some(l))
    }

    fn choose_action(&mut self, real: &GameState, legal: &[Action], rng: &mut Rng) -> Action {
        let first = &legal[0];
        let mulligan = matches!(first, Action::Mulligan { .. });
        // 新しい試合では、全探索のリーサル探索のメモを捨てる
        if mulligan {
            reset_exact_lethal_cache();
        }
        let p = acting_player(real);
        if deck_class_of(real, p) != ClassId::Elf {
            return self.plain.choose_action(real, legal, rng);
        }
        let turn_search: &dyn Fn(&GameState, PlayerIndex) -> Option<Vec<Action>> =
            &search_lethal_for_rhino_turn;
        if !self.rhino_eval {
            if !mulligan && legal.len() > 1 && real.active == p {
                if let Some(l) =
                    find_lethal(real, p, rng, &DEFAULT_LETHAL_OPTIONS, Some(turn_search))
                {
                    if legal.contains(&l) {
                        return l;
                    }
                }
            }
            return self.plain.choose_action(real, legal, rng);
        }
        if mulligan {
            return self.search.choose_action(real, legal, rng);
        }
        if legal.len() == 1 {
            return first.clone();
        }
        // 相手のターン中の選択は探索 AI に任せる
        if real.active != p {
            return self.search.choose_action(real, legal, rng);
        }
        // リーサル（手順の途中の選択も含む）
        if let Some(l) = find_lethal(real, p, rng, &DEFAULT_LETHAL_OPTIONS, Some(turn_search)) {
            if legal.contains(&l) {
                return l;
            }
        }
        self.search.choose_action(real, legal, rng)
    }
}
