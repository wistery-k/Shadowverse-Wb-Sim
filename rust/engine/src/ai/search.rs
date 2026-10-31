//! ターン単位の探索 AI（src/ai/search.ts）。
//!
//! 1. 見えない情報は determinization で複数の「ありうる局面」を作って平均する
//! 2. 各局面で、自分のターン終了までの行動の並びをビームサーチで探索する
//! 3. 有望な並び（最初の手ごとの最善）について、相手のターンを軽いビームサーチで進めた後の局面を評価する
//! 4. 平均の評価が最も良い「最初の手」を選ぶ。このターンで勝てる並び（リーサル）が見つかれば最優先する

use super::aidata::{ai_data, Weights};
use super::beam_key::BeamKey;
use super::converging::{
    converging_attacks, dominated_attack, settle_converging_trade_steps,
    settle_converging_trades_with,
};
use super::determinize::determinize;
use super::eval::{evaluate_with, EvalWeights};
use super::exact_lethal::{search_exact_lethal, sure_lethal_options};
use super::fusion::{excessive_fusion, fuse_root_chains, last_words_to_hand};
use super::greedy::{choose_greedy, value_after};
use super::keys::{hand_eq_noid, state_eq, visible_eq, TurnOrderMap, TurnOrderSet};
use super::lethal::{
    find_lethal, search_lethal, LethalOptions, LethalSearch, DEFAULT_LETHAL_OPTIONS,
    GUARDED_LETHAL_OPTIONS,
};
use super::mulligan::{
    model_mulligan_swap, mulligan_action, rollout_mulligan, sampled_mulligan,
    weighted_mulligan_swap, OppMulligan, RolloutPolicy,
};
use super::potential::{default_potential_net, PotentialNet};
use super::rhino::deck_class_of;
use super::think::{Thought, ThoughtCandidate};
use super::valuenet::{default_net_weights, value_net_eval, ValuePhase};
use super::{Agent, Rng};
use crate::data::{CardIdx, CardType, ClassId};
use crate::game::{
    acting_player, apply_legal, is_legal, legal_actions, resolve_turn_end, try_apply_action,
};
use crate::prof::{self, Sec};
use crate::state::*;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
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
    /// 1 枚も返さない（マリガンの効き目の大きさを測る比べ用）
    Keep,
    /// Sample と同じだが、引き直した後に先へ進めてから評価する（mulligan.rs の rollout_mulligan。mulligan_turns・mulligan_rollout_beam）
    Turn1,
}

/// MulliganMode::Turn1 で貪欲法で先へ進めるときの重み（`mulliganRolloutWeights`。docs/ai-notes.md「打ち進める手に PP 最大値を見せる」）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RolloutWeights {
    /// 貪欲法の AI と同じ既定の重み（PP 最大値の項 maxPp は 0 なので、竜の啓示を打たない。2026-10-26 より前の既定）
    Greedy,
    /// 既定の重みの maxPp だけを探索の重みの値にする（既定）
    Ramp,
    /// 探索の重み
    Search,
}

impl MulliganMode {
    /// デフォルトデッキごとに推定したモデルか重みを使う（それ以外のデッキでは使えない）
    pub fn needs_deck_model(self) -> bool {
        matches!(self, MulliganMode::Model | MulliganMode::Weights)
    }
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
    /// 次のターン末で止めず、その後の相手のターンも読んでから採点する（相手の応手を読まない楽観を消す。2 ターン読み）
    pub reply: bool,
}

/// 読み直す上位の手それぞれで 2 ターン読み（ownNext の reply と同じ読み）もして、2 ターン読みの勝率で 1 位の手が、
/// 今の点数で 1 位の手より threshold ポイント以上高いときだけ、その手に変える（twoTurnGate、実験用）。
/// 2 ターン読みは読み直しの乱数とは別に進めるので、手を変えなかったターンは今の AI と同じに進む
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TwoTurnGate {
    pub beam_width: usize,
    pub max_depth: usize,
    /// 勝率（%）の差のしきい値
    pub threshold: f64,
}

/// 読み直す並びに、自分の山札から引く手かランダムな手（引くカード・ランダムの結果が決定化で決まっている手）があれば、その手の直前で区切り、
/// 山札の順番と局面の乱数を samples 通り作り直して、その手を打った後の残りをビーム（幅 beam_width・深さ max_depth）で組み直し、
/// それぞれ相手のターンを読んで平均する（drawSplit。docs/ai-notes.md「引く手の直前で区切って引きを作り直す」）。
/// 今打てる引く手が読み直す上位の手に無ければ、ターン末の点数の高い順に root_draws 個まで候補に足す
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrawSplit {
    pub samples: usize,
    pub beam_width: usize,
    pub max_depth: usize,
    pub root_draws: usize,
    /// 山札の一番上のカードを層別に選ぶ（山札をカードの種類・カードの順に並べ、乱数で決めた位置から等間隔に samples 枚選んで、それぞれの作り直しの一番上に置く。
    /// 1 枚ごとの一番上に来る確率は変わらず、samples 通りが山札の構成に散らばる）
    pub stratify: bool,
    /// 区切る手が自分の山札の枚数を変える手なら、samples 通りの代わりに、山札の一番上のカードを山札にある種類ごとに全部試し、
    /// その種類の枚数の割合で重みを付けて平均する（2 枚目からは乱数で並べ直したまま）。1 枚引く手なら、引きの平均が正確になる
    pub enumerate: bool,
    /// 自分のデッキがこのクラスのときだけ使う（None ならどのクラスでも使う）
    pub class: Option<ClassId>,
}

/// 相手のターンを読み直す上位の手のうち、drawSplit で区切らない・決着していない終局面（rescoreRace）は、相手の手札の引き直し（oppHandCommon）を
/// first 通り読んだところと、その後 step 通り読むたびに、選ぶときの値の見込み（読んだ分の平均にターン末の点数を混ぜたもの）を比べ、
/// いちばん良い終局面との差が、同じ引き直しどうしの差のぶれ（標準誤差）の z 倍に delta を足したものより大きい終局面は、残りを読まない。
/// 読んだ分は残った終局面の読みに使うので、残った終局面の点数は全部読んだときと同じ。
/// reentry が Some(m) なら、読み終えた手のいちばん高い点数が、落とした終局面の落としたときの見込みより m 以上低ければ
/// （先に良く見えた終局面が後の引き直しで相手のリーサルを受けた等）、その終局面も残りを読んで候補に戻す。
/// lethal_guard なら、読んだ引き直しのどれかで相手のリーサルを受けた終局面があるうちは落とさない
/// （選ぶ値はリーサルを受けた引き直しの数でほぼ決まるが、それは先に読んだ引き直しの点数からは読めない）
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RescoreRace {
    pub first: usize,
    pub step: usize,
    pub z: f64,
    pub delta: f64,
    pub reentry: Option<f64>,
    pub lethal_guard: bool,
}

/// rescoreRace の項目を省いたときの値（{} で使うもの）
pub const DEFAULT_RESCORE_RACE: RescoreRace = RescoreRace {
    first: 3,
    step: 3,
    z: 2.0,
    delta: 10.0,
    reentry: Some(0.0),
    lethal_guard: true,
};

/// 既定の drawSplit: 区切る手が引く手なら一番上のカードを種類ごとに全部試し、残りを幅 32 で組み直す。
/// 2026-10-28 にスペルウィッチだけで使い始め、同じ日にどのクラスでも使うようにした（docs/ai-notes.md「引く手の直前で区切って引きを作り直す」）
pub const DEFAULT_DRAW_SPLIT: DrawSplit = DrawSplit {
    samples: 4,
    beam_width: 32,
    max_depth: 16,
    root_draws: 2,
    stratify: false,
    enumerate: true,
    class: None,
};

thread_local! {
    /// ビームが局面を採点した回数（Planner::score。調べもの用。スレッドごと。svwb beam-gap）
    static SCORED: Cell<u64> = const { Cell::new(0) };
    /// twoTurnGate を確かめた回数と、手を変えた回数（実験の集計用。スレッドごと）
    static TWO_TURN_GATE_COUNTS: Cell<(u32, u32)> = const { Cell::new((0, 0)) };
}

/// twoTurnGate を確かめた回数と、手を変えた回数（このスレッドで、前に reset_two_turn_gate_counts を呼んでから）
pub fn two_turn_gate_counts() -> (u32, u32) {
    TWO_TURN_GATE_COUNTS.with(|c| c.get())
}

pub fn reset_two_turn_gate_counts() {
    TWO_TURN_GATE_COUNTS.with(|c| c.set((0, 0)));
}

/// twoTurnGate で手を変えた場面（実験の集計用。record_two_turn_gate(true) のときだけ残す）
pub struct GateEvent {
    /// 手を選んだ局面（手番の側から見た決定化。相手の手札・山札の中身は想像）
    pub root: Rc<GameState>,
    pub p: PlayerIndex,
    /// 今の点数で 1 位の手（A）と、変えた先の手（B）: 並び・点数・2 ターン読みの勝率（%）
    pub a: (Vec<Action>, f64, f64),
    pub b: (Vec<Action>, f64, f64),
}

thread_local! {
    static GATE_RECORD: Cell<bool> = const { Cell::new(false) };
    static GATE_EVENTS: RefCell<Vec<GateEvent>> = const { RefCell::new(Vec::new()) };
}

/// このスレッドで、twoTurnGate で手を変えた場面を残すか（残したものは捨てる）
pub fn record_two_turn_gate(on: bool) {
    GATE_RECORD.with(|c| c.set(on));
    GATE_EVENTS.with(|e| e.borrow_mut().clear());
}

/// 残した場面を取り出す
pub fn take_two_turn_gate_events() -> Vec<GateEvent> {
    GATE_EVENTS.with(|e| std::mem::take(&mut *e.borrow_mut()))
}

/// 読み直しの記録の設定（svwb read-log。相手のターンの読み直しを軽くする実験用）。
/// 記録のための読みは、選ぶ値にも乱数にも使わない（打つ手は記録しないときと同じ）
#[derive(Clone, Copy, Debug, Default)]
pub struct RescoreLogConfig {
    /// 相手の手札の引き直しを、選ぶのに使ったもの（oppHandCommon）とは別の乱数でこの数だけ読む（確かめ用の独立な読み。0 なら読まない）
    pub b_samples: usize,
    /// 選ぶのに使ったのと同じ引き直しを、相手のターンを読むビームをこの設定にして読む（None なら読まない）
    pub alt_opp: Option<OpponentSearch>,
}

/// 読み直す終局面を選んだ理由
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RescoreOrigin {
    /// ターン末の点数の上位（rescoreTop）
    Top,
    /// drawSplit で足した、今打てる引く手（rootDraws）
    Draw,
    /// passLethal
    PassLethal,
    /// dangerRescore
    Danger,
}

/// 読み直した 1 つの終局面の記録
pub struct RescoreRow {
    /// 最初の手（deferFuse で回す融合を除く前）
    pub action: Action,
    pub origin: RescoreOrigin,
    /// 決着した終局面（相手のターンを読まない）
    pub ended: bool,
    /// drawSplit で区切ったときの、作り直した引きの数（区切らなければ 0）
    pub split_kinds: usize,
    /// drawSplit で区切ったときの、作り直した引きごとの (重み, ターン末の点数, reads の数, b_reads の数)（読んだ順。reads・b_reads はこの順に並ぶ）
    pub split_detail: Vec<(f64, f64, usize, usize)>,
    /// 混ぜたターン末の点数（区切ったときは作り直した引きごとの平均）
    pub turn_end: f64,
    /// 読んだ点数（重み, 点数）。区切らなければ引き直しごと（oppHandCommon の順、重み 1）。どれも残った PP の分を引いたもの
    pub reads: Vec<(f64, f64)>,
    /// 別の乱数の引き直しで読んだ点数（RescoreLogConfig::b_samples。区切ったときは、引きごとに同じように分けたもの）
    pub b_reads: Vec<(f64, f64)>,
    /// reads と同じ引き直しを、相手のビームを RescoreLogConfig::alt_opp にして読んだ点数
    pub alt_reads: Vec<(f64, f64)>,
    /// 選ぶときの値（読んだ点数にターン末の点数を混ぜたもの）
    pub value: f64,
}

/// 1 回の考え直し（plan_turn の読み直し）の記録
pub struct RescoreRecord {
    pub p: PlayerIndex,
    /// 読み直した順
    pub rows: Vec<RescoreRow>,
}

thread_local! {
    static RESCORE_LOG_CFG: Cell<Option<RescoreLogConfig>> = const { Cell::new(None) };
    static RESCORE_LOG: RefCell<Vec<RescoreRecord>> = const { RefCell::new(Vec::new()) };
}

/// このスレッドで、読み直しを記録するか（None なら記録しない。残したものは捨てる）
pub fn record_rescores(cfg: Option<RescoreLogConfig>) {
    RESCORE_LOG_CFG.with(|c| c.set(cfg));
    RESCORE_LOG.with(|e| e.borrow_mut().clear());
}

/// 残した読み直しの記録を取り出す
pub fn take_rescores() -> Vec<RescoreRecord> {
    RESCORE_LOG.with(|e| std::mem::take(&mut *e.borrow_mut()))
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
    /// 次のターン以降に回せる融合（作ったカードをこのターンに使わない融合）は打たない。並びの選び方と点数は変えず（融合した終局面の点数のまま）、
    /// 選んだ並びから回せる融合を除いて打つ（Planner::needless_fusions）
    pub defer_fuse: bool,
    /// deferFuse で、手で作った評価が上がる融合（手札の α・β・γ の種類が増える。fusionSet）は回さない。
    /// 自分の評価の重み（weights）で比べるので、S = 0 の補正（2026-10-31 からの既定。weights が全部 0）のままでは効かない
    pub defer_fuse_keep_set: bool,
    /// deferFuse で回したあとのターン末の手札の枚数の上限。回すと手札がこれより多くなる融合は回さない
    /// （8 なら次のターンの最初に引くカードが入る。手札が上限近くで止まると、コアを加えるカードを出しにくくなり、引いたカードが溢れる）
    pub defer_fuse_hand: usize,
    /// deferFuse で、自分の場のフォロワーのラストワードが手札に加えるカードの枚数（ビビッドインベンター・イリスのコア等）だけ、
    /// defer_fuse_hand を下げる（相手のターンに破壊されると手札が増え、次のターンの最初に引くカードが溢れる）
    pub defer_fuse_last_words: bool,
    /// 素材を入れすぎる融合（同じ融合先を、素材を 1 枚少なく使って作れる融合。ai/fusion.rs）を展開しない
    pub fuse_minimal: bool,
    /// 自分のターンの並びを選ぶとき、融合だけで作れて今の PP で出せる、コストが最も高いカードを先に作った局面（融合が 2 回以上要るとき。
    /// コストが同じカードが何種類もあれば種類ごとに 3 種類まで。ai/fusion.rs の fuse_root_chains）からもビームを打ち、
    /// その終局面（並びは先にする融合から）も候補にする（fuseRoot）。相手のターンの読みの中のビームでは打たない
    pub fuse_root: bool,
    pub score_turn_end: ScoreTurnEnd,
    pub mulligan: MulliganMode,
    /// MulliganMode::Sample で、返し方ごとに引き直しを試す回数
    pub mulligan_samples: usize,
    /// MulliganMode::Sample で、評価関数（手で決めた部分）と学習した補正のどちらを使うか
    pub mulligan_static: bool,
    pub mulligan_net: bool,
    /// MulliganMode::Turn1 で、どこまで進めてから評価するか（0 なら自分の 1 ターン目の最初、k なら自分の k ターン目の終わり）
    pub mulligan_turns: i32,
    /// MulliganMode::Turn1 で先へ進めるときの手（0 なら貪欲法、1 以上ならその幅のビームの探索）
    pub mulligan_rollout_beam: usize,
    /// 初手にあれば 1 枚目を必ず残すカード（手札の形のモデル・カードごとの表・コストのマリガンの判断の後で直す。2 枚目以降は判断のまま）
    pub mulligan_keep: Vec<crate::data::CardIdx>,
    /// MulliganMode::Turn1 で先へ進める中の相手のマリガン（mulligan.rs の rollout_mulligan。None なら、相手がまだなら手札の形のモデル、
    /// もう済んでいれば決定化で引き直した手札のまま）
    pub mulligan_opp: Option<OppMulligan>,
    /// MulliganMode::Turn1 で、初手にあれば全部を必ず返すカード（返し方の候補を、それを全部返すものに絞る。比べ用。
    /// docs/ai-notes.md「鬼呼びの術・ベイルを残しすぎていないか」）
    pub mulligan_return: Vec<crate::data::CardIdx>,
    /// MulliganMode::Turn1 で貪欲法（mulligan_rollout_beam 0）で先へ進めるときの重み
    pub mulligan_rollout_weights: RolloutWeights,
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
    /// ビームで残す局面を選ぶ並べ替えのキーに足す伸びしろの項の重み（beamKey。ai/beam_key.rs。ターンを終える局面の点数には足さない）。
    /// 自分のターンのビーム（drawSplit の組み直しを含む）だけに効き、読みの中の相手のビームには効かない。
    /// 点数の高い子が残らないことがあるので、各段で最初の手ごとに、残らなかった子の点数の最大も終局面の候補にする
    pub beam_key: Option<BeamKey>,
    /// 層ごとのビームの代わりに、優先度（ターン末の点数 + beamKey の伸びしろ）の高い局面から 1 つずつ広げ、採点した局面の数がこの数に達したら止める
    /// （bestFirst。0 なら使わず、beamWidth のビーム）。同じ局面はターン全体でまとめ、点数の高いほうを残す。深さの上限は maxDepth。
    /// 自分のターンのビームだけに効く
    pub best_first: usize,
    /// ビームで残す局面を選ぶ並べ替えのキーに足す、学習した見込み（potentialNet。ai/potential.rs）と、その倍率（potentialWeight）。
    /// beamKey と同じく、ターンを終える局面の点数には足さず、自分のターンのビームと bestFirst だけに効く（読みの中の相手には効かない）。
    /// 既定は data/potential-net.json（2026-10-30 から）
    pub potential: Option<Arc<PotentialNet>>,
    pub potential_weight: f64,
    /// 見込みを drawSplit の組み直しのビームにも使うか（potentialDrawSplit、既定 false。使うと組み直しが重くなり、勝率は同じ）
    pub potential_draw_split: bool,
    /// 攻撃を後にまとめるビームの幅（attackLater。0 なら使わない）。今のビームに加えて、攻撃以外の手（自分の場が埋まっているときは攻撃も）
    /// だけで手順を作り、各局面で攻撃を貪欲に（手で作った評価で）済ませた後の点数で並べるビームを打ち、その終局面（攻撃を済ませた局面）も候補にする
    pub attack_later: usize,
    /// ビームの各深さで、同じ「手の組」（手札から出したカード・進化・超進化・能力・エクストラPP の組。攻撃・融合・選ぶ手は数えない）の局面を
    /// まずこの数まで残し、余った枠を点数の順に埋める（perPlan。0 なら使わない）。攻撃先・融合の素材だけが違う並びが枠を埋めて、
    /// 別のカードを使う手順が切られるのを防ぐ
    pub per_plan: usize,
    pub extra_eval: Option<ExtraEval>,
    /// 相手のターンを読むビームの評価に足す項（opponentSearch.extraEval のとき。None なら extra_eval と同じ）。
    /// リノセウス用 AI は、エルフ用の打点の項を除いた学習した補正だけを渡す
    pub opp_extra_eval: Option<ExtraEval>,
    /// 評価関数の重み（None なら探索 AI の既定 SEARCH_WEIGHTS）
    pub weights: Option<Arc<Weights>>,
    /// 手を選ぶ方策として使う評価の重み（None なら weights と同じ）。読みの中の相手のビームの評価、相手のターン・選択待ちを打つ貪欲法の
    /// 自壊の倍率（doomed）、マリガンの打ち進めの PP 最大値（mulliganRolloutWeights の ramp）に使う。自分の評価（weights）だけを変えて、
    /// 読みの中の相手の打ち方は変えないときに渡す（docs/ai-notes.md「評価関数の手作りの項を外す」）
    pub policy_weights: Option<Arc<Weights>>,
    pub opponent_search: Option<OpponentSearch>,
    pub own_next: Option<OwnNextSearch>,
    pub two_turn_gate: Option<TwoTurnGate>,
    pub opp_hand_samples: usize,
    /// oppHandSamples で引き直す相手の手札を、読み直すどの終局面でも同じ並びにする（手どうしの差のぶれを減らす）
    pub opp_hand_common: bool,
    pub peek_opp_hand: bool,
    pub opp_fuse: bool,
    pub danger_rescore: usize,
    /// 上位の手を読み直した点数に、ターン末の点数をこの割合で混ぜる（0 なら読み直した点数だけ。既定 0.5、2026-10-22）
    pub rescore_mix: f64,
    /// 見込みのない終局面の読みを途中で打ち切る（RescoreRace。None なら全部読む。既定は DEFAULT_RESCORE_RACE、2026-10-30）
    pub rescore_race: Option<RescoreRace>,
    pub reuse_agree: bool,
    /// 上位の手を読み直すとき、このターンに引いて手札に残っているカードも引き直す（oppHandSamples の引き直しごと。ビームで決めた 1 通りの引きで手を比べない）
    pub resample_draws: bool,
    /// 選んだ並びの途中でカードを引く手を、先に打っても並びの残りが打てて点数が下がらなければ先に打つ（引いたカードを見てから残りを決める）
    pub draw_first: bool,
    /// 読み直す並びを引く手・ランダムな手の直前で区切り、引きを作り直して平均する（DrawSplit。None なら使わない。既定は DEFAULT_DRAW_SPLIT）
    pub draw_split: Option<DrawSplit>,
    /// 選んだ並びの、相手のターンを読んだ後の想像の局面を残す（SearchAgent::take_reads。TD 学習の自己対戦の --imagined 用。打つ手は変わらない）
    pub record_reads: bool,
}

impl Default for SearchOptions {
    fn default() -> Self {
        // 自分の評価の重みと方策の重みは、既定の補正の出発点の重み（baseWeights）に合わせる（空なら None、探索 AI の既定の重み）
        let (weights, policy_weights) = default_net_weights();
        SearchOptions {
            samples: 1,
            // 32 から 128 に（6400 試合で 52.9%、時間は 1 割ほど増える。docs/ai-notes.md「棋譜の指摘: ビームの幅」）。
            // 2026-10-26 に幅 128・深さ 8 から幅 512・深さ 16 に（別のシードの 2000 試合で 51.3%、1 試合の時間は 1.1 倍ほど。
            // docs/ai-notes.md「人間なら見える手順の取りこぼしを掘る」）。
            // 2026-10-30 に、並べ替えに学習した見込み（potential）を足して幅 128 に（幅 512 に 50.4% ± 0.67、思考は 12% 速い。
            // docs/ai-notes.md「ターン途中の見込みを学ぶ」）
            beam_width: 128,
            max_depth: 16,
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
            // 使わない融合は次のターン以降に回す（ラストワードの分を空ける形。前の版と勝率は同じで、使わない融合をしない。2026-10-29、
            // docs/ai-notes.md「回して何も残らない並びで、点数に入れた相打ちをしない見落とし」）
            defer_fuse: true,
            defer_fuse_keep_set: false,
            defer_fuse_hand: HAND_LIMIT - 1,
            defer_fuse_last_words: true,
            // 素材を入れすぎる融合を展開しないのは、勝率を比べてから決める（docs/ai-notes.md「融合を回した局面で探索が取りこぼすか」）
            fuse_minimal: false,
            // 先に融合した局面からも探すのは、勝率を比べてから決める（docs/ai-notes.md「長い融合の並びの取りこぼしを直す」）
            fuse_root: false,
            score_turn_end: ScoreTurnEnd::All,
            // 引き直した後、3 ターン目の終わりまで貪欲法で進めてから採点する
            // （docs/ai-notes.md「引き直した後に先へ進めてから採点するマリガン」。手札の形のモデルより +1.5%）
            mulligan: MulliganMode::Turn1,
            mulligan_samples: 100,
            mulligan_static: true,
            mulligan_net: true,
            mulligan_turns: 3,
            mulligan_rollout_beam: 0,
            mulligan_keep: Vec::new(),
            mulligan_opp: None,
            mulligan_return: Vec::new(),
            // 打ち進める貪欲法に PP 最大値を見せる（竜の啓示を打つ。勝率は変わらないが仕組みとして筋が通る。
            // docs/ai-notes.md「打ち進める手に PP 最大値を見せる」）
            mulligan_rollout_weights: RolloutWeights::Ramp,
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
            beam_key: None,
            best_first: 0,
            potential: Some(default_potential_net()),
            potential_weight: 1.0,
            potential_draw_split: false,
            attack_later: 0,
            per_plan: 0,
            extra_eval: Some(Arc::new(value_net_eval)),
            opp_extra_eval: None,
            weights,
            policy_weights,
            // 相手のターンを読むビームの幅は 4 から 16 に（6400 試合で 51.9%、物差しは 78.0% → 79.8%。
            // docs/ai-notes.md「相手のターンを読むビームの幅を 16 に」）
            opponent_search: Some(OpponentSearch {
                beam_width: 16,
                max_depth: 8,
                extra_eval: false,
            }),
            own_next: None,
            two_turn_gate: None,
            opp_hand_samples: 12,
            opp_hand_common: true,
            peek_opp_hand: false,
            opp_fuse: false,
            danger_rescore: 0,
            rescore_mix: 0.5,
            rescore_race: Some(DEFAULT_RESCORE_RACE),
            reuse_agree: false,
            resample_draws: false,
            draw_first: false,
            draw_split: Some(DEFAULT_DRAW_SPLIT),
            record_reads: false,
        }
    }
}

impl SearchOptions {
    /// 2026-10-16 より前の既定の読み方（決定化 3 回それぞれで幅 32 のビームを打ち、最初の手ごとに終局面を 3 つまで読み直す。
    /// 読み直した点数にターン末の点数を混ぜない）。
    /// 人間の記録との比較の相手（search-classic）と TD 学習の自己対戦は、今までと比べられるようこちらを使う（深さも当時の 8）
    pub fn with_classic_sampling(self) -> SearchOptions {
        SearchOptions {
            beam_width: 32,
            potential: None,
            max_depth: 8,
            samples: 3,
            plan_candidates: 3,
            opp_hand_samples: 1,
            opp_hand_common: false,
            rescore_mix: 0.0,
            draw_split: None,
            defer_fuse: false,
            ..self
        }
    }

    /// 学習した補正を外し、手で作った評価（探索 AI の既定の重み）だけで打つ設定。
    /// 既定の補正が S = 0（baseWeights が全部 0）なら既定の weights も全部 0 なので、補正と一緒に重みも探索 AI の既定に戻す
    pub fn without_value_net(self) -> SearchOptions {
        SearchOptions {
            extra_eval: None,
            weights: None,
            policy_weights: None,
            ..self
        }
    }
}

/// 相手のターンを読んだ後の点数がこれ以下なら、その並びは相手のターンで負ける（dangerRescore）
const DANGER: f64 = -1e5;

/// 並び（各手と、その手を打った後の局面）
type Steps = Vec<(Action, Rc<GameState>)>;

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

/// 探索で使う重み（評価関数の重みと、読みの中の相手のビームの重みと、相手の手番の貪欲法の重み）
pub struct Env<'a> {
    pub opts: &'a SearchOptions,
    pub w: &'a EvalWeights,
    /// 読みの中の相手のビームの評価の重み（SearchOptions.policy_weights。無ければ w と同じ）
    pub opp_w: &'a EvalWeights,
    pub policy_w: &'a EvalWeights,
}

/// 並びの 1 手（手と、1 つ前の手の添字）
struct Step {
    action: Action,
    prev: Option<usize>,
}

#[derive(Clone)]
struct Node {
    state: Rc<GameState>,
    first: Action,
    value: f64,
    path: usize,
    /// ビームの何段目の局面か（根の局面は 0）
    depth: u32,
}

/// bestFirst の優先度つきキューの要素（key の大きい順、同じなら先に入れた順）
struct Prio {
    key: f64,
    seq: usize,
}

impl PartialEq for Prio {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == std::cmp::Ordering::Equal
    }
}

impl Eq for Prio {}

impl PartialOrd for Prio {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Prio {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.key
            .partial_cmp(&other.key)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(other.seq.cmp(&self.seq))
    }
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
    /// 攻撃を後にまとめるビームの中（自分の場が埋まっていなければ攻撃を展開しない）
    plays_only: bool,
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
        let _p = prof::scope(Sec::StepsOf);
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

    /// 終局面 t までの並びのうち、次のターン以降に回せる融合（deferFuse）。回せるものを 1 つずつ除いていき、除いた融合を返す。
    /// 回せる融合は、融合で作ったカードがターン末まで手札に残り（出していない・素材にしていない）、その融合だけを除いて打ち直しても
    /// 自分の手札のほかは同じ局面になる（作ったカードをコピーしていない・融合で誘発した能力が無い 等）融合のこと。
    /// 融合は PP を使わず、変身したカードはそのターンにもう一度融合できるので、使うターンに融合しても同じことができ、
    /// 素材のまま残せば別のカードを作る選択肢も残る（アタックとキャッスルのどちらを作るか 等）。
    /// ただし、その融合をしないと手札が上限になる（次のターンの最初に引くカードが溢れる）ものと、ターン終了時の処理が変わる
    /// （手札の枚数で引くかどうかが決まるクレスト等）ものは回さない
    fn needless_fusions(&self, t: &Node) -> Vec<Action> {
        let _p = prof::scope(Sec::DeferFuse);
        let mut removed = Vec::new();
        if t.state.phase == Phase::Ended {
            return removed;
        }
        let mut acts: Vec<Action> = self
            .steps_actions(t.path)
            .into_iter()
            .filter(|a| !matches!(a, Action::EndTurn))
            .collect();
        if !acts.iter().any(|a| matches!(a, Action::Fuse { .. })) {
            return removed;
        }
        let mut end: GameState = (*t.state).clone();
        while let Some((k, next)) = self.needless_fuse_at(&acts, &end) {
            removed.push(acts.remove(k));
            end = next;
        }
        removed
    }

    /// path までの手（root から順に）
    fn steps_actions(&self, path: usize) -> Vec<Action> {
        let mut out = Vec::new();
        let mut cur = Some(path);
        while let Some(i) = cur {
            out.push(self.steps[i].action.clone());
            cur = self.steps[i].prev;
        }
        out.reverse();
        out
    }

    /// root から acts を打った局面 end で、次のターン以降に回せる融合の添字と、それを除いて打ち直した局面
    fn needless_fuse_at(&self, acts: &[Action], end: &GameState) -> Option<(usize, GameState)> {
        let p = self.p;
        let hand = &end.players[p].hand;
        let mut limit = self.opts().defer_fuse_hand;
        if self.opts().defer_fuse_last_words {
            limit = limit.saturating_sub(last_words_to_hand(end, p));
        }
        'fuse: for (k, a) in acts.iter().enumerate() {
            let Action::Fuse { host, materials } = a else {
                continue;
            };
            if hand.len() + materials.len() > limit || !hand.iter().any(|h| h.iid == *host) {
                continue;
            }
            // 後の手で作ったカードを使っていれば回せない（打ち直さなくても分かる）
            if acts[k + 1..].iter().any(|b| match b {
                Action::Choose(v) => v.contains(host),
                Action::Fuse { materials, .. } => materials.contains(host),
                Action::Play(x) | Action::Evolve(x) | Action::SuperEvolve(x) | Action::Act(x) => {
                    x == host
                }
                _ => false,
            }) {
                continue;
            }
            // その融合だけを除いて打ち直す（打てない手があれば、作ったカードを使っている）
            let mut s: GameState = (*self.root).clone();
            for (j, b) in acts.iter().enumerate() {
                if j == k {
                    continue;
                }
                match try_apply_action(&s, b) {
                    Some(next) => s = next,
                    None => continue 'fuse,
                }
            }
            // deferFuseKeepSet: 手で作った評価が上がる融合（手札の α・β・γ の種類が増える。fusionSet）は回さない。
            // Ω の素材はコアにすると 11 枚で手札に入りきらないので、何ターンかかけて作っておく
            if self.opts().defer_fuse_keep_set
                && evaluate_with(end, p, self.env.w) > evaluate_with(&s, p, self.env.w) + 1e-9
            {
                continue;
            }
            // ターン終了時の処理の後まで、手札のほかは同じか（新たなる少女・エースのクレストは、手札が 5 枚以下なら引き、6 枚以上なら回復する。
            // 融合で手札を減らして引けるなら回さない。2026-10-29、ユーザーの指摘）
            let mut after = resolve_turn_end(&s).unwrap_or_else(|| s.clone());
            let end_after = resolve_turn_end(end).unwrap_or_else(|| end.clone());
            after.players[p].hand = end_after.players[p].hand.clone();
            let unfused = std::mem::replace(&mut s.players[p].hand, hand.clone());
            if state_eq(&s, end) && state_eq(&after, &end_after) {
                s.players[p].hand = unfused;
                return Some((k, s));
            }
        }
        None
    }

    /// 並び steps から、終局面 t までの並びで次のターン以降に回せる融合を除き、各手の後の局面を打ち直す（deferFuse）。
    /// 何も残らなければターン終了だけの並び
    fn defer_steps(
        &self,
        t: &Node,
        steps: Vec<(Action, Rc<GameState>)>,
    ) -> Vec<(Action, Rc<GameState>)> {
        let removed = self.needless_fusions(t);
        if removed.is_empty() {
            return steps;
        }
        let mut state = self.root.clone();
        let mut out: Vec<(Action, Rc<GameState>)> = Vec::new();
        for (a, _) in steps {
            if removed.contains(&a) {
                continue;
            }
            if !matches!(a, Action::EndTurn) {
                state = Rc::new(apply_legal(&state, &a));
            }
            out.push((a, state.clone()));
        }
        // 何も残らなければ、ターン末の点数に入れている合流する相打ち（settle）を打つ。ターン終了だけにすると、
        // 点数は相打ちをした局面のままで相打ちをせずにターンを終える（2026-10-29、アマリアロイヤル戦の分かれ目から）
        if out.is_empty() && self.opts().settle_trades {
            for (a, after) in
                settle_converging_trade_steps(&self.root, self.p, self.opts().dominance)
            {
                out.push((a, Rc::new(after)));
            }
        }
        if out.is_empty() {
            out.push((Action::EndTurn, self.root.clone()));
        }
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
        let _p = prof::scope(Sec::Score);
        SCORED.with(|c| c.set(c.get() + 1));
        if self.opts().score_turn_end == ScoreTurnEnd::All {
            return self.end_score(s);
        }
        let settled = self.settle(s);
        self.eval_state(settled.as_ref().unwrap_or(s)) - self.leftover(s) - self.expiring(s)
    }

    fn allowed(&self, s: &GameState, a: &Action) -> bool {
        if self.plays_only
            && matches!(a, Action::Attack { .. })
            && s.players[self.p].board.len() < BOARD_LIMIT
        {
            return false;
        }
        match &self.opts().allow {
            None => true,
            Some(f) => matches!(a, Action::EndTurn) || f(s, a, self.p),
        }
    }

    fn expand(&self, s: &GameState) -> Vec<Action> {
        let _p = prof::scope(Sec::Expand);
        let mut legal = legal_actions(s);
        if self.opts().dominance {
            legal.retain(|a| !dominated_attack(s, a));
        }
        if self.opts().fuse_minimal {
            legal.retain(|a| !excessive_fusion(s, a));
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

    /// 攻撃を貪欲に（手で作った評価が上がる攻撃のうち最も上がるものを、上がらなくなるまで）打った局面と並び（attackLater）。
    /// 攻撃で自分の選択待ちになったら手で作った評価で選ぶ
    fn settle_attacks(&mut self, s: &Rc<GameState>, path: usize) -> (Rc<GameState>, usize) {
        let p = self.p;
        let w = self.env.w;
        let mut t = s.clone();
        let mut path = path;
        for _ in 0..16 {
            if t.phase == Phase::Ended || t.active != p || t.pending.is_some() {
                break;
            }
            let cur = evaluate_with(&t, p, w);
            let mut best: Option<(f64, Action)> = None;
            for a in legal_actions(&t) {
                if !matches!(a, Action::Attack { .. }) || dominated_attack(&t, &a) {
                    continue;
                }
                let v = value_after(&t, &a, p, w, 0);
                if best.as_ref().is_none_or(|b| v > b.0) {
                    best = Some((v, a));
                }
            }
            let Some((v, a)) = best else { break };
            if v <= cur {
                break;
            }
            t = Rc::new(apply_legal(&t, &a));
            path = self.push_step(a, Some(path));
            for _ in 0..8 {
                if !t.pending.as_ref().is_some_and(|pd| pd.player() == p) {
                    break;
                }
                let mut chosen: Option<(f64, Action)> = None;
                for c in legal_actions(&t) {
                    let v = value_after(&t, &c, p, w, 0);
                    if chosen.as_ref().is_none_or(|b| v > b.0) {
                        chosen = Some((v, c));
                    }
                }
                let Some((_, c)) = chosen else { break };
                t = Rc::new(apply_legal(&t, &c));
                path = self.push_step(c, Some(path));
            }
        }
        (t, path)
    }

    /// 攻撃を後にまとめるビーム（attackLater）の終局面。攻撃以外の手（自分の場が埋まっているときは攻撃も）で手順を作り、
    /// 各局面で攻撃を貪欲に済ませた後の点数で並べて幅 attack_later 個を残す。終局面は各局面から攻撃を済ませた局面
    /// prefix があれば、root はその並び（steps の添字と最初の手）の後の局面で、終局面の並びはその並びから続け、最初の手はその最初の手にする（fuseRoot）
    fn plays_beam_terminals(
        &mut self,
        root: &Rc<GameState>,
        prefix: Option<(usize, &Action)>,
    ) -> Vec<Node> {
        struct PlayNode {
            state: Rc<GameState>,
            first: Action,
            end: Rc<GameState>,
            end_path: usize,
            value: f64,
        }
        let p = self.p;
        let opts = self.opts();
        let width = opts.attack_later;
        self.plays_only = true;
        let mut terminals: Vec<Node> = Vec::new();
        let mut frontier: Vec<(PlayNode, usize)> = Vec::new();
        let mut next: Vec<(Rc<GameState>, usize)> = Vec::new();
        let make = |pl: &mut Self, st: Rc<GameState>, first: Action, path: usize| {
            let (end, end_path) = pl.settle_attacks(&st, path);
            let value = pl.score(&end);
            PlayNode {
                state: st,
                first,
                end,
                end_path,
                value,
            }
        };
        // 深さ 1: 攻撃以外のすべての手を展開する
        let prev = prefix.map(|(i, _)| i);
        for a in self.expand(root) {
            if matches!(a, Action::EndTurn) || !self.allowed(root, &a) {
                continue;
            }
            let first = prefix.map_or_else(|| a.clone(), |(_, f)| f.clone());
            next.clear();
            self.advance(root, &a, prev, 0, &mut next);
            for (st, path) in std::mem::take(&mut next) {
                let n = make(self, st, first.clone(), path);
                frontier.push((n, path));
            }
        }
        let mut depth = 1;
        loop {
            let mut children: Vec<(PlayNode, usize)> = Vec::new();
            for (node, path) in std::mem::take(&mut frontier) {
                let actor = node
                    .state
                    .pending
                    .as_ref()
                    .map(|pd| pd.player())
                    .unwrap_or(node.state.active);
                let expand =
                    depth < opts.max_depth && node.state.phase != Phase::Ended && actor == p;
                let st = node.state.clone();
                let first = node.first.clone();
                terminals.push(Node {
                    state: node.end,
                    first: node.first,
                    value: node.value,
                    path: node.end_path,
                    depth: depth as u32,
                });
                if !expand {
                    continue;
                }
                for a in self.expand(&st) {
                    if matches!(a, Action::EndTurn) || !self.allowed(&st, &a) {
                        continue;
                    }
                    next.clear();
                    self.advance(&st, &a, Some(path), 0, &mut next);
                    for (ns, np) in std::mem::take(&mut next) {
                        let n = make(self, ns, first.clone(), np);
                        children.push((n, np));
                    }
                }
            }
            if children.is_empty() {
                break;
            }
            children.sort_by(|x, y| by_value_desc(x.0.value, y.0.value));
            let mut seen = TurnOrderSet::default();
            for c in children {
                if frontier.len() >= width {
                    break;
                }
                if opts.dedup && !seen.add(&c.0.state) {
                    continue;
                }
                frontier.push(c);
            }
            depth += 1;
        }
        self.plays_only = false;
        terminals
    }

    /// path までの並びの「手の組」（手札から出したカード・進化・超進化・能力・エクストラPP。攻撃・融合・選ぶ手は数えない）。perPlan の枠に使う
    fn plan_key(&self, path: usize) -> Vec<(u8, i32)> {
        let mut key = Vec::new();
        let mut cur = Some(path);
        while let Some(i) = cur {
            let st = &self.steps[i];
            match &st.action {
                Action::Play(x) => key.push((0, *x)),
                Action::Evolve(x) => key.push((1, *x)),
                Action::SuperEvolve(x) => key.push((2, *x)),
                Action::Act(x) => key.push((3, *x)),
                Action::ExtraPp => key.push((4, 0)),
                _ => {}
            }
            cur = st.prev;
        }
        key.sort_unstable();
        key
    }

    /// 同じ局面を除き、まず手の組ごとに per_plan 個まで（点数の順に）、余った枠を残りの点数の順に、width 個まで選ぶ（children は評価の降順）
    fn unique_by_plan(&self, children: Vec<Node>, width: usize, per_plan: usize) -> Vec<Node> {
        let mut seen = TurnOrderSet::default();
        let mut count: HashMap<Vec<(u8, i32)>, usize> = HashMap::new();
        let mut out: Vec<Node> = Vec::new();
        let mut rest: Vec<Node> = Vec::new();
        for c in children {
            if out.len() >= width {
                break;
            }
            if !seen.add(&c.state) {
                continue;
            }
            let n = count.entry(self.plan_key(c.path)).or_insert(0);
            if *n < per_plan {
                *n += 1;
                out.push(c);
            } else if rest.len() < width {
                rest.push(c);
            }
        }
        let room = width.saturating_sub(out.len());
        out.extend(rest.into_iter().take(room));
        out.sort_by(|x, y| by_value_desc(x.value, y.value));
        out
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

    /// bestFirst: 層を作らず、優先度（ターン末の点数 + beamKey の伸びしろ）の高い局面から 1 つずつ広げる。start は深さ 1 の局面（すべて採点済み）。
    /// 採点した局面の数が best_first に達したら広げるのをやめ、広げた局面と残った局面をすべて終局面の候補にする。
    /// 同じ局面（turnOrderEqual）は採点してから比べ、点数の高いほうを残す。turnOrderEqual は評価が見る項の一部（手札のスペルブーストの回数など）を比べないので、
    /// 同じとみなした局面とその先の局面の点数が違うことがある（ビームは段ごとに点数で並べてから同じ局面を除くので、点数の高いほうが残る）。
    /// 先に出た同じ局面をもう広げていても、点数が高ければ後の局面も広げる
    fn best_first_terminals(&mut self, mut terminals: Vec<Node>, start: Vec<Node>) -> Vec<Node> {
        let p = self.p;
        let opts = self.opts();
        let budget = opts.best_first;
        let prio = |n: &Node| n.value + key_bonus(opts, &n.state, p).unwrap_or(0.0);
        let mut heap: std::collections::BinaryHeap<Prio> = std::collections::BinaryHeap::new();
        let mut nodes: Vec<Option<Node>> = Vec::new();
        // 同じ局面ごとに、残した局面の nodes の添字と点数
        let mut seen: TurnOrderMap<(usize, f64)> = TurnOrderMap::default();
        let mut scored = start.len();
        // n を広げる候補に足す。同じ局面があれば点数の高いほうを残す
        let mut add = |heap: &mut std::collections::BinaryHeap<Prio>,
                       nodes: &mut Vec<Option<Node>>,
                       n: Node| {
            let seq = nodes.len();
            if opts.dedup {
                if let Some(e) = seen.get_or_add(&n.state, (seq, n.value)) {
                    if n.value <= e.1 {
                        return;
                    }
                    // 先の局面がまだ広げていなければ除く（もう広げていれば、後の局面も広げる）
                    nodes[e.0] = None;
                    *e = (seq, n.value);
                }
            }
            heap.push(Prio { key: prio(&n), seq });
            nodes.push(Some(n));
        };
        for n in start {
            add(&mut heap, &mut nodes, n);
        }
        let mut next: Vec<(Rc<GameState>, usize)> = Vec::new();
        while let Some(Prio { seq, .. }) = heap.pop() {
            let Some(node) = nodes[seq].take() else {
                continue;
            };
            let actor = node
                .state
                .pending
                .as_ref()
                .map(|pd| pd.player())
                .unwrap_or(node.state.active);
            if scored >= budget
                || node.state.phase == Phase::Ended
                || actor != p
                || node.depth as usize >= opts.max_depth
            {
                terminals.push(node);
                continue;
            }
            let st = node.state.clone();
            let first = node.first.clone();
            let path = node.path;
            let depth = node.depth;
            terminals.push(node);
            for a in self.expand(&st) {
                if matches!(a, Action::EndTurn) || !self.allowed(&st, &a) {
                    continue;
                }
                next.clear();
                self.advance(&st, &a, Some(path), 0, &mut next);
                for (ns, np) in std::mem::take(&mut next) {
                    let value = self.score(&ns);
                    scored += 1;
                    let n = Node {
                        state: ns,
                        first: first.clone(),
                        value,
                        path: np,
                        depth: depth + 1,
                    };
                    add(&mut heap, &mut nodes, n);
                }
            }
        }
        terminals
    }

    /// prefix があれば、root はその並び（steps の添字と最初の手）の後の局面で、終局面の並びはその並びから続け、最初の手はその最初の手にする（fuseRoot）
    fn beam_terminals(
        &mut self,
        root: &Rc<GameState>,
        root_converges: bool,
        prefix: Option<(usize, &Action)>,
    ) -> Vec<Node> {
        let p = self.p;
        let opts = self.opts();
        let mut terminals: Vec<Node> = Vec::new();
        let mut frontier: Vec<Node> = Vec::new();
        let mut next: Vec<(Rc<GameState>, usize)> = Vec::new();
        let prev = prefix.map(|(i, _)| i);
        // 深さ 1: すべての手を展開する（最初の手の候補を落とさない）
        for a in self.expand(root) {
            if !self.allowed(root, &a) {
                continue;
            }
            let first = prefix.map_or_else(|| a.clone(), |(_, f)| f.clone());
            if matches!(a, Action::EndTurn) {
                if root_converges {
                    continue; // 合流する攻撃をしてから終える手に劣らない
                }
                let path = self.push_step(a, prev);
                let value = self.score(root);
                terminals.push(Node {
                    state: root.clone(),
                    first,
                    value,
                    path,
                    depth: 0,
                });
                continue;
            }
            next.clear();
            self.advance(root, &a, prev, 0, &mut next);
            for (st, path) in next.drain(..) {
                let value = self.score(&st);
                frontier.push(Node {
                    state: st,
                    first: first.clone(),
                    value,
                    path,
                    depth: 1,
                });
            }
        }
        if opts.best_first > 0 {
            return self.best_first_terminals(terminals, frontier);
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
                            depth: depth as u32 + 1,
                        });
                    }
                }
            }
            let _p = prof::scope(Sec::Select);
            // beamKey では、点数の高い子が残らないことがある。採点は済んでいるので、最初の手ごとに残らなかった子の点数の最大も終局面の候補にする
            let mut cut_best: Vec<Node> = Vec::new();
            if opts.beam_key.is_some() || opts.potential.is_some() {
                for c in &children {
                    match cut_best.iter_mut().find(|b| b.first == c.first) {
                        None => cut_best.push(c.clone()),
                        Some(b) => {
                            if c.value > b.value {
                                *b = c.clone();
                            }
                        }
                    }
                }
            }
            if opts.beam_key.is_some() || opts.potential.is_some() {
                let mut keyed: Vec<(f64, Node)> = children
                    .into_iter()
                    .map(|n| (n.value + key_bonus(opts, &n.state, p).unwrap_or(0.0), n))
                    .collect();
                keyed.sort_by(|x, y| by_value_desc(x.0, y.0));
                children = keyed.into_iter().map(|(_, n)| n).collect();
            } else if opts.beam_pp != 0.0 {
                let key = |n: &Node| n.value + opts.beam_pp * n.state.players[p].pp as f64;
                children.sort_by(|x, y| by_value_desc(key(x), key(y)));
            } else {
                children.sort_by(|x, y| by_value_desc(x.value, y.value));
            }
            frontier = if opts.per_plan > 0 {
                self.unique_by_plan(children, opts.beam_width, opts.per_plan)
            } else if opts.dedup {
                self.unique_states(children, opts.beam_width, opts.per_first)
            } else {
                children.truncate(opts.beam_width);
                children
            };
            for b in cut_best {
                if !frontier.iter().any(|f| Rc::ptr_eq(&f.state, &b.state)) {
                    terminals.push(b);
                }
            }
            depth += 1;
        }
        terminals.extend(frontier);
        terminals
    }
}

/// 並べ替えのキーに足す伸びしろ（beamKey の項と、学習した見込み potentialNet の和）。どちらも無ければ None
fn key_bonus(opts: &SearchOptions, s: &GameState, p: PlayerIndex) -> Option<f64> {
    if opts.beam_key.is_none() && opts.potential.is_none() {
        return None;
    }
    let k = opts.beam_key.as_ref().map_or(0.0, |k| k.bonus(s, p));
    let n = opts
        .potential
        .as_ref()
        .map_or(0.0, |net| opts.potential_weight * net.eval(s, p));
    Some(k + n)
}

/// fuseRoot で、先に融合する並びを探すときに調べる局面の数の上限と、先に融合した局面の数の上限
const FUSE_ROOT_STATES: usize = 4000;
const FUSE_ROOT_MAX: usize = 3;

/// ビームサーチの終局面と、最初の手ごとにターン末の点数が最も高い終局面の添字（最初の手が出てきた順）。
/// fuse_root なら、先に融合した局面からのビームの終局面も足す（SearchOptions.fuse_root）
fn turn_end_bests<'a>(
    root: &Rc<GameState>,
    p: PlayerIndex,
    env: &'a Env<'a>,
    fuse_root: bool,
) -> (Planner<'a>, Vec<Node>, Vec<(Action, usize)>) {
    let _p = prof::scope(Sec::Beam);
    let opts = env.opts;
    let mut pl = Planner {
        env,
        p,
        root: root.clone(),
        steps: Vec::new(),
        plays_only: false,
    };
    let root_converges = opts.settle_trades && !converging_attacks(root, p).is_empty();
    let mut terminals = pl.beam_terminals(root, root_converges, None);
    if opts.attack_later > 0 {
        let more = pl.plays_beam_terminals(root, None);
        terminals.extend(more);
    }
    if fuse_root {
        for (chain, fused) in pre_fused_roots(&mut pl, root) {
            let (last, first) = (chain.0, &chain.1);
            let converges = opts.settle_trades && !converging_attacks(&fused, p).is_empty();
            let more = pl.beam_terminals(&fused, converges, Some((last, first)));
            terminals.extend(more);
            if opts.attack_later > 0 {
                let more = pl.plays_beam_terminals(&fused, Some((last, first)));
                terminals.extend(more);
            }
        }
    }
    if opts.score_turn_end == ScoreTurnEnd::Terminal {
        for t in terminals.iter_mut() {
            let _p = prof::scope(Sec::Score);
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

/// fuseRoot: root から先に融合する並び（fuse_root_chains）を pl の並びに足し、並びごとに (最後の手の添字, 最初の手) と打った後の局面を返す。
/// 並びの手が打てない設定（allow）の並びは除く
fn pre_fused_roots(
    pl: &mut Planner,
    root: &Rc<GameState>,
) -> Vec<((usize, Action), Rc<GameState>)> {
    let mut out = Vec::new();
    'chain: for (chain, fused) in fuse_root_chains(root, pl.p, FUSE_ROOT_STATES, FUSE_ROOT_MAX) {
        let mut s: GameState = (**root).clone();
        for a in &chain {
            if !pl.allowed(&s, a) {
                continue 'chain;
            }
            s = apply_legal(&s, a);
        }
        let mut prev = None;
        for a in &chain {
            prev = Some(pl.push_step(a.clone(), prev));
        }
        if let Some(last) = prev {
            out.push(((last, chain[0].clone()), Rc::new(fused)));
        }
    }
    out
}

/// plan_turn（相手のターンを読まない）の並びのうち点数が最も高いもの（同じなら先のもの）の、最後の手とその後の局面。
/// 並びの局面は打ち直して作るので、使うものだけを作る
fn best_plan_last(
    root: &Rc<GameState>,
    p: PlayerIndex,
    env: &Env,
) -> Option<(Action, Rc<GameState>)> {
    let (pl, terminals, bests) = turn_end_bests(root, p, env, false);
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
    let (_, terminals, bests) = turn_end_bests(root, p, env, false);
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
    // drawSplit（自分のデッキのクラスを指定していれば、そのクラスのときだけ）
    let draw_split = opts
        .draw_split
        .filter(|ds| ds.class.is_none_or(|c| deck_class_of(root, p) == c));
    // 最初の手ごとに最善の終局面を残し、上位を相手のターンまで読んで評価し直す
    let (pl, terminals, best_by_first) = turn_end_bests(root, p, env, opts.fuse_root);
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
        let result = best_by_first
            .into_iter()
            .map(|(k, i)| {
                let t = &terminals[i];
                let mut steps = pl.steps_of(t.path);
                if opts.defer_fuse {
                    steps = pl.defer_steps(t, steps);
                }
                let plan = Plan {
                    action: t.first.clone(),
                    value: t.value,
                    steps,
                    reads: Vec::new(),
                };
                (k, plan)
            })
            .collect();
        return rekey_deferred(result, opts.defer_fuse, root);
    }
    let _p = prof::scope(Sec::Rescore);
    let mut ranked: Vec<usize> = best_by_first.iter().map(|(_, i)| *i).collect();
    ranked.sort_by(|&x, &y| by_value_desc(terminals[x].value, terminals[y].value));
    ranked.truncate(opts.rescore_top);
    let n_top = ranked.len();
    // drawSplit: 今打てる引く手（先に引く手）が上位に無ければ、ターン末の点数の高い順に足す
    // （同じ局面をまとめると、先に引く並びの終局面が後で引く並びの側に数えられて、先に引く手の点数が下がるため）
    if let Some(ds) = draw_split {
        let mut more: Vec<usize> = best_by_first
            .iter()
            .map(|(_, i)| *i)
            .filter(|i| !ranked.contains(i))
            .filter(|&i| {
                let t = &terminals[i];
                !matches!(t.first, Action::EndTurn)
                    && try_apply_action(root, &t.first)
                        .is_some_and(|after| is_chance_step(root, &after, p))
            })
            .collect();
        more.sort_by(|&x, &y| by_value_desc(terminals[x].value, terminals[y].value));
        more.truncate(ds.root_draws);
        ranked.extend(more);
    }

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
    // drawSplit: 引きを作り直す乱数（どの並びでも同じ）と、組み直すビームの設定
    let split_seeds: Vec<u32> = match draw_split {
        Some(ds) => (0..ds.samples.max(1))
            .map(|_| rng.int(u32::MAX as usize) as u32)
            .collect(),
        None => Vec::new(),
    };
    // stratify: 層別に選ぶ位置のずれ（0 以上 1 未満。どの並びでも同じ）
    let split_offset: Option<f64> = match draw_split {
        Some(ds) if ds.stratify => Some(rng.int(1 << 30) as f64 / (1u32 << 30) as f64),
        _ => None,
    };
    // enumerate: 一番上のカードの種類ごとに山札の残りを並べ直す乱数の元（種類ごとに決まるので、どの並びでも同じ種類なら同じ並べ直し）
    let enum_seed: Option<u32> = match draw_split {
        Some(ds) if ds.enumerate => Some(rng.int(u32::MAX as usize) as u32),
        _ => None,
    };
    let split_opts: Option<SearchOptions> = draw_split.map(|ds| SearchOptions {
        beam_width: ds.beam_width,
        max_depth: ds.max_depth,
        draw_split: None,
        potential: opts.potential.clone().filter(|_| opts.potential_draw_split),
        ..opts.clone()
    });
    let split_env: Option<Env> = split_opts.as_ref().map(|o| Env {
        opts: o,
        w: env.w,
        opp_w: env.opp_w,
        policy_w: env.policy_w,
    });
    // 読み直しの記録（svwb read-log）。記録のための読みの乱数は rng を進めずに作り、選ぶ値には使わない
    let log_cfg = RESCORE_LOG_CFG.with(|c| c.get());
    let b_seeds: Vec<u32> = match log_cfg {
        Some(c) if c.b_samples > 0 => {
            let mut r = Rng::new(rng.state ^ 0x5bd1_e995);
            (0..c.b_samples)
                .map(|_| r.int(u32::MAX as usize) as u32)
                .collect()
        }
        _ => Vec::new(),
    };
    let alt_opts: Option<SearchOptions> = log_cfg.and_then(|c| c.alt_opp).map(|o| SearchOptions {
        opponent_search: Some(o),
        ..opts.clone()
    });
    let alt_env: Option<Env> = alt_opts.as_ref().map(|o| Env {
        opts: o,
        w: env.w,
        opp_w: env.opp_w,
        policy_w: env.policy_w,
    });
    let log_rows: RefCell<Vec<RescoreRow>> = RefCell::new(Vec::new());
    // rescoreRace で先に読んだ引き直し（終局面の添字と、引き直しの順の (点数, 読んだ後の局面, 読んだ後の乱数の状態)）
    let race_reads: RefCell<Vec<(usize, Vec<RaceRead>)>> = RefCell::new(Vec::new());
    let mut result: Vec<(Action, Plan)> = Vec::new();
    let mut rescored: Vec<usize> = Vec::new();
    let tracing = trace.is_some();
    let mut reads: Vec<(Action, ScoreParts)> = Vec::new();
    // twoTurnGate: 最初の手ごとの 2 ターン読みの勝率（%）
    let mut twos: Vec<(Action, f64)> = Vec::new();
    let gate = opts.two_turn_gate;
    let rescore_node = |i: usize,
                        origin: RescoreOrigin,
                        rng: &mut Rng,
                        result: &mut Vec<(Action, Plan)>,
                        reads: &mut Vec<(Action, ScoreParts)>,
                        twos: &mut Vec<(Action, f64)>| {
        let node = &terminals[i];
        // 読み直しの記録（読んだ点数・別の乱数で読んだ点数・相手のビームを変えて読んだ点数。どれも (重み, 点数)）
        let logging = log_cfg.is_some();
        let mut lg_a: Vec<(f64, f64)> = Vec::new();
        let mut lg_b: Vec<(f64, f64)> = Vec::new();
        let mut lg_alt: Vec<(f64, f64)> = Vec::new();
        let mut lg_kinds = 0usize;
        let mut lg_detail: Vec<(f64, f64, usize, usize)> = Vec::new();
        // twoTurnGate の 2 ターン読みの勝率の合計（読んだ後の局面ごと。乱数は呼んだ側の乱数を写したもので、呼んだ側の乱数は進めない）
        let mut two_sum = 0.0;
        let mut two_of = |after: &GameState, rng: &Rng| {
            if let Some(g) = gate {
                let mut r = Rng { state: rng.state };
                let v = two_turn_value(&pl, after, g, &mut r) - pl.leftover(&node.state);
                two_sum += win_pct(v);
            }
        };
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
        // drawSplit: 並びの中で最初に引く手・ランダムな手（その手の添字と、並び）
        let split_at: Option<(usize, Steps)> = match &split_env {
            Some(_) => {
                let steps = pl.steps_of(node.path);
                first_chance_step(root, &steps, p).map(|c| (c, steps))
            }
            None => None,
        };
        // 選ぶときに混ぜるターン末の点数（drawSplit で区切ったときは、作り直した引きごとのターン末の点数の平均）
        let mut turn_end = node.value;
        let split = match (&split_at, &split_env) {
            (Some((c, steps)), Some(senv)) => {
                let before: &GameState = if *c == 0 { root } else { &steps[*c - 1].1 };
                let a = &steps[*c].0;
                let deck = &before.players[p].deck;
                let draws = steps[*c].1.players[p].deck.len() != deck.len();
                // 作り直す引き（乱数の種、一番上に置くカードの種類、重み）
                let samples: Vec<(u32, Option<CardIdx>, f64)> = match enum_seed {
                    Some(base) if draws && !deck.is_empty() => {
                        let mut kinds: Vec<(CardIdx, usize)> = Vec::new();
                        for r in deck.iter() {
                            match kinds.iter_mut().find(|(x, _)| *x == r.card) {
                                Some(e) => e.1 += 1,
                                None => kinds.push((r.card, 1)),
                            }
                        }
                        kinds.sort_by_key(|(x, _)| *x);
                        let n = deck.len() as f64;
                        kinds
                            .into_iter()
                            .map(|(x, m)| {
                                (
                                    base ^ (x as u32).wrapping_mul(0x9E37_79B1),
                                    Some(x),
                                    m as f64 / n,
                                )
                            })
                            .collect()
                    }
                    _ => split_seeds
                        .iter()
                        .map(|&seed| (seed, None, 1.0 / split_seeds.len() as f64))
                        .collect(),
                };
                let k = samples.len();
                lg_kinds = k;
                // 読んだ点数・ターン末の点数の重み付きの和と、重みの和
                let mut read_sum = 0.0;
                let mut read_w = 0.0;
                let mut reads = 0usize;
                let mut te_sum = 0.0;
                let mut te_w = 0.0;
                for (j, &(seed, top, w)) in samples.iter().enumerate() {
                    let mut r = Rng::new(seed);
                    let mut s = before.clone();
                    reshuffle_own(&mut s, p, &mut r);
                    if let Some(x) = top {
                        put_on_top(&mut s, p, x);
                    } else if let Some(u) = split_offset {
                        stratify_top(&mut s, p, (u + j as f64) / k as f64);
                    }
                    let Some(s1) = try_apply_action(&s, a) else {
                        continue;
                    };
                    let (end, te) = split_turn_end(&pl, Rc::new(s1), senv);
                    te_sum += w * te;
                    te_w += w;
                    if end.phase == Phase::Ended {
                        let v = pl.eval_state(&end);
                        read_sum += w * v;
                        read_w += w;
                        reads += 1;
                        two_of(&end, &r);
                        add((*end).clone());
                        if logging {
                            lg_a.push((w, v));
                            lg_b.push((w, v));
                            lg_alt.push((w, v));
                            lg_detail.push((w, te, 1, 1));
                        }
                        continue;
                    }
                    let settled = pl.settle(&end);
                    let base = settled.as_ref().unwrap_or(&end);
                    let left = pl.leftover(&end);
                    // 相手の手札の引き直しは、どの並びでも同じもの（oppHandCommon）を引きの数で分けて使う
                    let split_seeds_of = |seeds: &[u32], r: &mut Rng| -> Vec<u32> {
                        if seeds.len() >= k {
                            seeds.iter().skip(j).step_by(k).copied().collect()
                        } else if !seeds.is_empty() {
                            vec![seeds[j % seeds.len()]]
                        } else {
                            vec![r.int(u32::MAX as usize) as u32]
                        }
                    };
                    let mine: Vec<u32> = split_seeds_of(&common_seeds, &mut r);
                    let wr = w / mine.len().max(1) as f64;
                    let (na0, nb0) = (lg_a.len(), lg_b.len());
                    for &seed2 in &mine {
                        let mut r2 = Rng::new(seed2);
                        let d = determinize(base, p, &mut r2, opts.peek_opp_hand);
                        let (v, after) = read_once(&pl, &d, &mut r2);
                        read_sum += wr * (v - left);
                        read_w += wr;
                        reads += 1;
                        two_of(&after, &r2);
                        add(after);
                        if logging {
                            lg_a.push((wr, v - left));
                        }
                    }
                    if logging {
                        if !b_seeds.is_empty() {
                            let mut rb = Rng { state: r.state };
                            let theirs = split_seeds_of(&b_seeds, &mut rb);
                            let wb = w / theirs.len().max(1) as f64;
                            for seed2 in theirs {
                                let mut r2 = Rng::new(seed2);
                                let d = determinize(base, p, &mut r2, opts.peek_opp_hand);
                                let (v, _) = read_once(&pl, &d, &mut r2);
                                lg_b.push((wb, v - left));
                            }
                        }
                        if let Some(ae) = &alt_env {
                            for &seed2 in &mine {
                                let mut r2 = Rng::new(seed2);
                                let d = determinize(base, p, &mut r2, opts.peek_opp_hand);
                                let (v, _) = read_once_with(&pl, ae, &d, &mut r2);
                                lg_alt.push((wr, v - left));
                            }
                        }
                        lg_detail.push((w, te, lg_a.len() - na0, lg_b.len() - nb0));
                    }
                }
                if te_w > 0.0 && read_w > 0.0 {
                    turn_end = te_sum / te_w;
                    Some((read_sum / read_w, reads))
                } else {
                    None
                }
            }
            _ => None,
        };
        if logging && split.is_none() {
            lg_a.clear();
            lg_b.clear();
            lg_alt.clear();
            lg_kinds = 0;
            lg_detail.clear();
        }
        let (value, n) = if let Some(x) = split {
            x
        } else if node.state.phase == Phase::Ended {
            if tracing {
                parts = pl.parts(&node.state, ValuePhase::End);
            }
            let v = pl.eval_state(&node.state);
            if gate.is_some() {
                two_sum += win_pct(v);
            }
            (v, 1)
        } else if opts.opp_hand_samples <= 1 {
            let settled = pl.settle(&node.state);
            let (v, after) = read_once(&pl, settled.as_ref().unwrap_or(&node.state), rng);
            two_of(&after, rng);
            add(after);
            if logging {
                lg_a.push((1.0, v - pl.leftover(&node.state)));
            }
            (v - pl.leftover(&node.state), 1)
        } else {
            let settled = pl.settle(&node.state);
            let base = settled.as_ref().unwrap_or(&node.state);
            let left = if logging {
                pl.leftover(&node.state)
            } else {
                0.0
            };
            // 記録用に、引き直し seed で 1 回読んだ点数（相手は opp_env の設定のビームで打つ）
            let read_seed = |seed: u32, opp_env: &Env| -> f64 {
                let mut r = Rng::new(seed);
                let mut d = determinize(base, p, &mut r, opts.peek_opp_hand);
                if opts.resample_draws {
                    resample_own_draws(&mut d, root, p, &mut r);
                }
                read_once_with(&pl, opp_env, &d, &mut r).0
            };
            let mut sum = 0.0;
            if opts.opp_hand_common {
                // rescoreRace で先に読んだ分（引き直しの順の始めから）はそれを使う
                let mut done = {
                    let mut c = race_reads.borrow_mut();
                    match c.iter().position(|(x, _)| *x == i) {
                        Some(k) => c.swap_remove(k).1,
                        None => Vec::new(),
                    }
                }
                .into_iter();
                for &seed in &common_seeds {
                    let (v, after, r) = match done.next() {
                        Some(x) => (x.value, x.after, Rng { state: x.rng }),
                        None => {
                            let mut r = Rng::new(seed);
                            let (v, after) = read_common(&pl, base, root, &mut r);
                            (v, after, r)
                        }
                    };
                    sum += v;
                    two_of(&after, &r);
                    add(after);
                    if logging {
                        lg_a.push((1.0, v - left));
                    }
                }
                if logging {
                    for &seed in &b_seeds {
                        lg_b.push((1.0, read_seed(seed, env) - left));
                    }
                    if let Some(ae) = &alt_env {
                        for &seed in &common_seeds {
                            lg_alt.push((1.0, read_seed(seed, ae) - left));
                        }
                    }
                }
            } else {
                for _ in 0..opts.opp_hand_samples {
                    let d = determinize(base, p, rng, opts.peek_opp_hand);
                    let (v, after) = read_once(&pl, &d, rng);
                    sum += v;
                    two_of(&after, rng);
                    add(after);
                    if logging {
                        lg_a.push((1.0, v - left));
                    }
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
            (1.0 - opts.rescore_mix) * value + opts.rescore_mix * turn_end
        } else {
            value
        };
        if logging {
            log_rows.borrow_mut().push(RescoreRow {
                action: node.first.clone(),
                origin,
                ended: node.state.phase == Phase::Ended,
                split_kinds: lg_kinds,
                split_detail: lg_detail,
                turn_end,
                reads: lg_a,
                b_reads: lg_b,
                alt_reads: lg_alt,
                value,
            });
        }
        let replace = match result.iter().find(|(k, _)| *k == node.first) {
            None => true,
            Some((_, cur)) => value > cur.value,
        };
        if replace {
            // drawSplit で区切ったときは、引く手までの並び（その先は引いたカードを見て考え直す）
            let mut steps = match split_at {
                Some((c, mut steps)) if split.is_some() => {
                    steps.truncate(c + 1);
                    steps
                }
                _ => pl.steps_of(node.path),
            };
            // deferFuse: 選ぶ点数は融合した終局面のまま（融合は後でもできるので、それより悪くはならない）で、回せる融合は打たない
            if opts.defer_fuse {
                steps = pl.defer_steps(node, steps);
            }
            let plan = Plan {
                action: node.first.clone(),
                value,
                steps,
                reads: afters,
            };
            match result.iter_mut().find(|(k, _)| *k == node.first) {
                Some(e) => e.1 = plan,
                None => result.push((node.first.clone(), plan)),
            }
            if gate.is_some() {
                let two = two_sum / n as f64;
                match twos.iter_mut().find(|(k, _)| *k == node.first) {
                    Some(e) => e.1 = two,
                    None => twos.push((node.first.clone(), two)),
                }
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
    // rescoreRace: drawSplit で区切らない・決着していない上位の終局面は、引き直しを何通りか読むたびに比べ、見込みのないものは残りを読まない
    // 落とした終局面（添字・読み直す理由・落としたときの見込み）
    let mut dropped: Vec<(usize, RescoreOrigin, f64)> = Vec::new();
    if let Some(rr) = opts.rescore_race {
        if opts.opp_hand_common && common_seeds.len() > 1 && gate.is_none() {
            let racers: Vec<(usize, RescoreOrigin)> = ranked
                .iter()
                .enumerate()
                .flat_map(|(bi, &b)| {
                    let origin = if bi < n_top {
                        RescoreOrigin::Top
                    } else {
                        RescoreOrigin::Draw
                    };
                    candidates_of(b).into_iter().map(move |i| (i, origin))
                })
                .filter(|&(i, _)| {
                    let t = &terminals[i];
                    t.state.phase != Phase::Ended
                        && (split_env.is_none()
                            || first_chance_step(root, &pl.steps_of(t.path), p).is_none())
                })
                .collect();
            let (kept, out) = race_rescore(&pl, &terminals, &racers, &common_seeds, root, rr);
            *race_reads.borrow_mut() = kept;
            dropped = out;
        }
    }
    let is_dropped = |i: usize| dropped.iter().any(|d| d.0 == i);
    for (bi, best) in ranked.into_iter().enumerate() {
        let origin = if bi < n_top {
            RescoreOrigin::Top
        } else {
            RescoreOrigin::Draw
        };
        for i in candidates_of(best) {
            rescored.push(i);
            if is_dropped(i) {
                continue;
            }
            rescore_node(i, origin, rng, &mut result, &mut reads, &mut twos);
        }
    }
    // rescoreRace の reentry: 読み終えた手のいちばん高い点数より、落としたときの見込みが高い終局面は、残りも読んで戻す
    if let Some(m) = opts.rescore_race.and_then(|rr| rr.reentry) {
        if !dropped.is_empty() {
            let best = result
                .iter()
                .map(|(_, x)| x.value)
                .fold(f64::NEG_INFINITY, f64::max);
            for &(i, origin, est) in &dropped {
                if est > best - m {
                    rescore_node(i, origin, rng, &mut result, &mut reads, &mut twos);
                }
            }
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
                rescore_node(
                    i,
                    RescoreOrigin::PassLethal,
                    rng,
                    &mut result,
                    &mut reads,
                    &mut twos,
                );
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
            rescore_node(
                i,
                RescoreOrigin::Danger,
                rng,
                &mut result,
                &mut reads,
                &mut twos,
            );
            n += 1;
        }
    }
    if let Some(g) = gate {
        apply_two_turn_gate(&mut result, &twos, g.threshold, root, p);
    }
    if let Some(tr) = trace {
        tr.reads = reads;
    }
    if log_cfg.is_some() {
        let rows = log_rows.into_inner();
        RESCORE_LOG.with(|e| e.borrow_mut().push(RescoreRecord { p, rows }));
    }
    rekey_deferred(result, opts.defer_fuse, root)
}

/// rescoreRace で先に読んだ 1 通りの引き直し
struct RaceRead {
    value: f64,
    after: GameState,
    /// 読んだ後の乱数の状態（twoTurnGate 等が続きの乱数を使う）
    rng: u32,
}

/// 相手の手札の引き直し（oppHandCommon。r はその引き直しの種で作った乱数で、読んだ後の状態になる）で、
/// base から相手のターンを読んだ点数と、読んだ後の局面
fn read_common(pl: &Planner, base: &GameState, root: &GameState, r: &mut Rng) -> (f64, GameState) {
    let opts = pl.opts();
    let mut d = determinize(base, pl.p, r, opts.peek_opp_hand);
    if opts.resample_draws {
        resample_own_draws(&mut d, root, pl.p, r);
    }
    read_once(pl, &d, r)
}

/// rescoreRace: 終局面 racers（terminals の添字と、読み直す理由）を、引き直しを rr.first 通り、その後 rr.step 通りずつ読んで比べ、
/// 見込みのないものを落とす。終局面ごとの読んだ分（落とした終局面も。reentry で戻すときに使う）と、
/// 落とした終局面（添字・読み直す理由・落としたときの選ぶ値の見込み）を返す
fn race_rescore(
    pl: &Planner,
    terminals: &[Node],
    racers: &[(usize, RescoreOrigin)],
    seeds: &[u32],
    root: &GameState,
    rr: RescoreRace,
) -> RaceResult {
    struct Racer {
        i: usize,
        origin: RescoreOrigin,
        settled: Option<GameState>,
        left: f64,
        /// 引き直しごとの読みの点数（残った PP の分を引いたもの）
        xs: Vec<f64>,
        reads: Vec<RaceRead>,
    }
    let mix = pl.opts().rescore_mix;
    let mut alive: Vec<Racer> = racers
        .iter()
        .map(|&(i, origin)| Racer {
            i,
            origin,
            settled: pl.settle(&terminals[i].state),
            left: pl.leftover(&terminals[i].state),
            xs: Vec::new(),
            reads: Vec::new(),
        })
        .collect();
    let mut dropped: Vec<(usize, RescoreOrigin, f64)> = Vec::new();
    let mut kept: Vec<(usize, Vec<RaceRead>)> = Vec::new();
    let mut n = 0;
    let mut next = rr.first.max(1);
    while next < seeds.len() && alive.len() >= 2 {
        for rc in alive.iter_mut() {
            let base = rc.settled.as_ref().unwrap_or(&terminals[rc.i].state);
            for &seed in &seeds[n..next] {
                let mut r = Rng::new(seed);
                let (v, after) = read_common(pl, base, root, &mut r);
                rc.xs.push(v - rc.left);
                rc.reads.push(RaceRead {
                    value: v,
                    after,
                    rng: r.state,
                });
            }
        }
        n = next;
        next = n + rr.step.max(1);
        if rr.lethal_guard && alive.iter().any(|rc| rc.xs.iter().any(|&x| x <= DANGER)) {
            continue;
        }
        let k = n as f64;
        let est =
            |rc: &Racer| (1.0 - mix) * rc.xs.iter().sum::<f64>() / k + mix * terminals[rc.i].value;
        let mut lead = 0;
        for j in 1..alive.len() {
            if est(&alive[j]) > est(&alive[lead]) {
                lead = j;
            }
        }
        let lead_xs = alive[lead].xs.clone();
        let lead_te = terminals[alive[lead].i].value;
        let mut rest: Vec<Racer> = Vec::new();
        for (j, rc) in alive.into_iter().enumerate() {
            let keep = j == lead || {
                let d: Vec<f64> = lead_xs.iter().zip(&rc.xs).map(|(a, b)| a - b).collect();
                let mean = d.iter().sum::<f64>() / k;
                let var = if n > 1 {
                    d.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / (k - 1.0)
                } else {
                    0.0
                };
                let gap = (1.0 - mix) * mean + mix * (lead_te - terminals[rc.i].value);
                gap <= rr.z * (1.0 - mix) * (var / k).sqrt() + rr.delta
            };
            if keep {
                rest.push(rc);
            } else {
                dropped.push((rc.i, rc.origin, est(&rc)));
                kept.push((rc.i, rc.reads));
            }
        }
        alive = rest;
    }
    kept.extend(alive.into_iter().map(|rc| (rc.i, rc.reads)));
    (kept, dropped)
}

/// race_rescore の結果（終局面ごとの読んだ分と、落とした終局面）
type RaceResult = (
    Vec<(usize, Vec<RaceRead>)>,
    Vec<(usize, RescoreOrigin, f64)>,
);

/// deferFuse: 回せる融合を除いた並びの最初の手を、その並びの手にする（同じ手になったものは点数の高いほうを残す）
fn rekey_deferred(
    result: Vec<(Action, Plan)>,
    defer_fuse: bool,
    root: &GameState,
) -> Vec<(Action, Plan)> {
    if !defer_fuse {
        return result;
    }
    let legal = legal_actions(root);
    let mut out: Vec<(Action, Plan)> = Vec::new();
    for (_, mut plan) in result {
        let Some(mut first) = plan.steps.first().map(|(a, _)| a.clone()) else {
            continue;
        };
        // 回せる融合を除いて打ち直した並びの最初の手は、合法手の一覧に無い同じカードの別の 1 枚を使うことがある
        // （一覧は同じカードの融合先・素材を区別しない）。一覧の手に直す。後の手は使うカードの番号がずれるので、その手を打った後は考え直す
        if !legal.contains(&first) {
            if let Some(a) = same_fusion_in(root, &legal, &first) {
                let after = Rc::new(apply_legal(root, &a));
                plan.steps = vec![(a.clone(), after)];
                first = a;
            }
        }
        plan.action = first.clone();
        match out.iter_mut().find(|(k, _)| *k == first) {
            Some(e) => {
                if plan.value > e.1.value {
                    e.1 = plan;
                }
            }
            None => out.push((first, plan)),
        }
    }
    out
}

/// 融合 a と同じカード（融合先は種類と融合した種類、素材は種類の組）を使う、合法手の一覧 legal の融合
fn same_fusion_in(s: &GameState, legal: &[Action], a: &Action) -> Option<Action> {
    let Action::Fuse { host, materials } = a else {
        return None;
    };
    let hand = &s.players[s.active].hand;
    let card_of = |iid: Iid| hand.iter().find(|c| c.iid == iid);
    let kinds = |ms: &[Iid]| -> Option<Vec<CardIdx>> {
        let mut v = ms
            .iter()
            .map(|&m| card_of(m).map(|c| c.card))
            .collect::<Option<Vec<_>>>()?;
        v.sort_unstable();
        Some(v)
    };
    let h = card_of(*host)?;
    let want = kinds(materials)?;
    legal.iter().find_map(|b| match b {
        Action::Fuse {
            host: h2,
            materials: m2,
        } => {
            let c2 = card_of(*h2)?;
            (c2.card == h.card && c2.fused_kinds == h.fused_kinds && kinds(m2)? == want)
                .then(|| b.clone())
        }
        _ => None,
    })
}

/// twoTurnGate: 今の点数で 1 位の手（同点は先のもの。choose_action と同じ）より、2 ターン読みの勝率で
/// threshold ポイント以上高い手があれば、その中で 2 ターン読みの 1 位の手の点数を今の 1 位の少し上にする
fn apply_two_turn_gate(
    result: &mut [(Action, Plan)],
    twos: &[(Action, f64)],
    threshold: f64,
    root: &Rc<GameState>,
    p: PlayerIndex,
) {
    let mut a: Option<usize> = None;
    for (i, (_, plan)) in result.iter().enumerate() {
        if a.is_none_or(|j| plan.value > result[j].1.value) {
            a = Some(i);
        }
    }
    let Some(a) = a else { return };
    let two_of = |k: &Action| twos.iter().find(|(x, _)| x == k).map(|x| x.1);
    let Some(two_a) = two_of(&result[a].0) else {
        return;
    };
    TWO_TURN_GATE_COUNTS.with(|c| c.set((c.get().0 + 1, c.get().1)));
    let mut b: Option<(usize, f64)> = None;
    for (i, (k, _)) in result.iter().enumerate() {
        if let Some(t) = two_of(k) {
            if b.is_none_or(|(_, bt)| t > bt) {
                b = Some((i, t));
            }
        }
    }
    if let Some((b, two_b)) = b {
        if b != a && two_b - two_a >= threshold {
            if GATE_RECORD.with(|c| c.get()) {
                let line = |x: &Plan| x.steps.iter().map(|s| s.0.clone()).collect::<Vec<_>>();
                let ev = GateEvent {
                    root: root.clone(),
                    p,
                    a: (line(&result[a].1), result[a].1.value, two_a),
                    b: (line(&result[b].1), result[b].1.value, two_b),
                };
                GATE_EVENTS.with(|e| e.borrow_mut().push(ev));
            }
            result[b].1.value = result[a].1.value + 1.0;
            TWO_TURN_GATE_COUNTS.with(|c| c.set((c.get().0, c.get().1 + 1)));
        }
    }
}

/// 点数を勝率（%）にする（σ(a·点数)。a は学習した補正のもの）
fn win_pct(v: f64) -> f64 {
    let a = ai_data().value_net.a;
    100.0 / (1.0 + (-a * v).exp())
}

/// twoTurnGate の 2 ターン読み: 相手のターンを読んだ後の局面 after から、自分の次のターンを幅 g.beam_width のビームで打ち、
/// その後の相手のターンも読んだ点数（ownNext の reply と同じ。自分の手番に戻っていなければ after の点数）
fn two_turn_value(pl: &Planner, after: &GameState, g: TwoTurnGate, rng: &mut Rng) -> f64 {
    if after.phase != Phase::Ended && after.active == pl.p && after.pending.is_none() {
        let on = OwnNextSearch {
            beam_width: g.beam_width,
            max_depth: g.max_depth,
            mix: 1.0,
            reply: true,
        };
        own_next_value(pl, after, on, rng)
    } else {
        pl.eval_after(after)
    }
}

/// before から手を打って after になったとき、その手の結果が自分の山札の順番か局面の乱数に依りうるか（drawSplit で並びを区切る手）。
/// 自分の山札の枚数が変わったか（引く・山札に戻す・山札から出す）、局面の乱数が進んだか（ランダムな対象・山札を混ぜる）で見る
pub(crate) fn is_chance_step(before: &GameState, after: &GameState, p: PlayerIndex) -> bool {
    before.players[p].deck.len() != after.players[p].deck.len() || before.rng != after.rng
}

/// root からの並び steps のうち、最初に引く手・ランダムな手の添字
pub(crate) fn first_chance_step(
    root: &GameState,
    steps: &[(Action, Rc<GameState>)],
    p: PlayerIndex,
) -> Option<usize> {
    let mut prev: &GameState = root;
    for (j, (a, st)) in steps.iter().enumerate() {
        if matches!(a, Action::EndTurn) {
            return None;
        }
        if is_chance_step(prev, st, p) {
            return Some(j);
        }
        prev = st;
    }
    None
}

/// p の山札の順番と局面の乱数を作り直す（drawSplit。相手の手札・山札はそのまま。相手の分は読み直しで引き直す）。
/// 並べ直す前に iid の順にそろえるので、結果は山札の中身と rng だけで決まる（決定化で上に来たカードによらない）
pub(crate) fn reshuffle_own(s: &mut GameState, p: PlayerIndex, rng: &mut Rng) {
    let deck = s.players[p].deck.make_mut();
    deck.sort_by_key(|r| r.iid);
    rng.shuffle(deck);
    let a = rng.int(1 << 30) as f64;
    let b = rng.int(4) as f64;
    s.rng = (a * 4.0 + b).floor() as u32;
}

/// p の山札を、カードの種類（フォロワー・スペル・アミュレット）・カードの順に並べたときの位置 x（0 以上 1 未満の割合）にあるカードを、山札の一番上に置く
/// （drawSplit の stratify。x を等間隔に選ぶと、作り直しごとの一番上のカードが山札の構成に散らばる。x が一様なら、どのカードも一番上に来る確率は同じ）
pub(crate) fn stratify_top(s: &mut GameState, p: PlayerIndex, x: f64) {
    let deck = s.players[p].deck.make_mut();
    if deck.len() < 2 {
        return;
    }
    let kind = |c: CardIdx| match card(c).ctype {
        CardType::Follower => 0,
        CardType::Spell => 1,
        CardType::Amulet => 2,
    };
    let mut sorted: Vec<CardRef> = deck.to_vec();
    sorted.sort_by_key(|r| (kind(r.card), r.card, r.iid));
    let i = ((x * sorted.len() as f64).floor() as usize).min(sorted.len() - 1);
    let pick = sorted[i].iid;
    if let Some(at) = deck.iter().position(|r| r.iid == pick) {
        let c = deck.remove(at);
        deck.insert(0, c);
    }
}

/// p の山札にある種類 x のカードを 1 枚、山札の一番上に置く（drawSplit の enumerate）
pub(crate) fn put_on_top(s: &mut GameState, p: PlayerIndex, x: CardIdx) {
    let deck = s.players[p].deck.make_mut();
    if let Some(at) = deck.iter().position(|r| r.card == x) {
        let c = deck.remove(at);
        deck.insert(0, c);
    }
}

/// drawSplit で引きを作り直した局面 start から、ターン末までを env のビームで組み直した最善の終局面と、そのターン末の点数。
/// 試合が終わった・p の手番でない局面は、そのまま採点する
fn split_turn_end(pl: &Planner, start: Rc<GameState>, env: &Env) -> (Rc<GameState>, f64) {
    if start.phase == Phase::Ended || acting_player(&start) != pl.p {
        let v = pl.score(&start);
        return (start, v);
    }
    let (_, terminals, _) = turn_end_bests(&start, pl.p, env, false);
    let mut best: Option<&Node> = None;
    for t in &terminals {
        if best.is_none_or(|b| t.value > b.value) {
            best = Some(t);
        }
    }
    match best {
        Some(b) => (b.state.clone(), b.value),
        None => {
            let v = pl.score(&start);
            (start, v)
        }
    }
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
        plays_only: false,
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
    read_once_with(pl, pl.env, start, rng)
}

/// read_once と同じ。相手のターンは opp_env の設定で打つ（読み直しの記録で、相手のビームの設定を変えて比べる用）
fn read_once_with(
    pl: &Planner,
    opp_env: &Env,
    start: &GameState,
    rng: &mut Rng,
) -> (f64, GameState) {
    let env = pl.env;
    let p = pl.p;
    let after = {
        let _p = prof::scope(Sec::OppTurn);
        if opp_env.opts.opponent_search.is_some() {
            simulate_opponent_turn_by_search(start, p, rng, opp_env)
        } else {
            simulate_opponent_turn(start, p, rng, opp_env.policy_w, opp_env.opts.opp_fuse)
        }
    };
    let mut v = match env.opts.own_next {
        Some(on) if after.phase != Phase::Ended && after.active == p && after.pending.is_none() => {
            let next = own_next_value(pl, &after, on, rng);
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

/// 自分の次のターンの始めの局面 after から、自分のターンをビームサーチで打った最善のターン末の点数（ownNext）。
/// on.reply なら、その最善の並びの後の相手のターンも読んだ点数
fn own_next_value(pl: &Planner, after: &GameState, on: OwnNextSearch, rng: &mut Rng) -> f64 {
    let env = pl.env;
    let opts = SearchOptions {
        beam_width: on.beam_width,
        max_depth: on.max_depth,
        opponent_search: None,
        own_next: None,
        two_turn_gate: None,
        next_lethal: 0.0,
        pass_lethal: 0,
        attack_later: 0,
        per_plan: 0,
        ..env.opts.clone()
    };
    let next_env = Env {
        opts: &opts,
        w: env.w,
        opp_w: env.opp_w,
        policy_w: env.policy_w,
    };
    let root = Rc::new(after.clone());
    if !on.reply {
        return best_plan_value(&root, pl.p, &next_env).unwrap_or_else(|| pl.eval_after(after));
    }
    let Some((_, last)) = best_plan_last(&root, pl.p, &next_env) else {
        return pl.eval_after(after);
    };
    let pl2 = Planner {
        env: &next_env,
        p: pl.p,
        root,
        steps: Vec::new(),
        plays_only: false,
    };
    if last.phase == Phase::Ended {
        return pl2.eval_state(&last);
    }
    let settled = pl2.settle(&last);
    let base = settled.as_ref().unwrap_or(&last);
    let after2 = if env.opts.opponent_search.is_some() {
        simulate_opponent_turn_by_search(base, pl.p, rng, env)
    } else {
        simulate_opponent_turn(base, pl.p, rng, env.policy_w, env.opts.opp_fuse)
    };
    pl.eval_after(&after2) - pl2.leftover(&last)
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
        attack_later: 0,
        per_plan: 0,
        beam_key: None,
        best_first: 0,
        potential: None,
        ..opts.clone()
    };
    // 読みの中の相手は、自分の評価の重みでなく方策の重み（policy_weights。既定は同じ）で打つ
    let opp_env = Env {
        opts: &opp_opts,
        w: env.opp_w,
        opp_w: env.opp_w,
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
    /// 読みの中の相手のビームの重み（opts.policy_weights。無ければ w と同じ）
    opp_w: EvalWeights,
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
        let opp_w = match &opts.policy_weights {
            Some(x) => EvalWeights::new((**x).clone()),
            None => w.clone(),
        };
        let mut pw = ad.default_weights.clone();
        pw.doomed = opp_w.w.doomed;
        SearchAgent {
            opts,
            w,
            opp_w,
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
            opp_w: &self.opp_w,
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
            opp_w: &self.opp_w,
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

/// SearchAgent::two_turn_read の結果（引き直し 1 つ分）
#[derive(Clone, Copy, Debug)]
pub struct TwoTurnRead {
    /// 相手のターンを読んだ後の点数（今の AI の読み直しの引き直し 1 つ分と同じ）
    pub read: f64,
    /// 続く自分の次のターンを打ったターン末の点数（ownNext と同じ形。リーサルなら勝ちの点数）
    pub own: f64,
    /// さらに相手の次のターンを読んだ後の点数（リーサルなら勝ちの点数）
    pub two: f64,
    /// 自分の次のターンにリーサルがあった
    pub next_lethal: bool,
}

/// 探索の外から、探索と同じ点数で局面を採点する（人間の手順と比べる runner/human_plan.rs が使う。打つ手は変えない）
impl SearchAgent {
    fn env(&self) -> Env<'_> {
        Env {
            opts: &self.opts,
            w: &self.w,
            opp_w: &self.opp_w,
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
            plays_only: false,
        };
        pl.end_score(end)
    }

    /// p のターン末の局面 end から相手のターンを読んだ後の点数（plan_turn の読み直しと同じ。
    /// 引き直しは seeds ごとに 1 回で、同じ seeds なら局面が違っても同じ乱数を使う）
    pub fn read_value(&self, end: &GameState, p: PlayerIndex, seeds: &[u32]) -> f64 {
        let values = self.read_values(end, p, seeds);
        values.iter().sum::<f64>() / values.len() as f64
    }

    /// read_value の、引き直し（seeds）ごとの点数（試合が終わった局面か seeds が空なら、その局面の点数 1 つ）。
    /// 相手のリーサルがある引き直しは負けの点数（-1e6）になるので、勝率にしてから平均したいときに使う（runner/deep_gap.rs）
    pub fn read_values(&self, end: &GameState, p: PlayerIndex, seeds: &[u32]) -> Vec<f64> {
        let env = self.env();
        let pl = Planner {
            env: &env,
            p,
            root: Rc::new(end.clone()),
            steps: Vec::new(),
            plays_only: false,
        };
        if end.phase == Phase::Ended || seeds.is_empty() {
            return vec![pl.eval_state(end)];
        }
        let settled = pl.settle(end);
        let base = settled.as_ref().unwrap_or(end);
        let leftover = pl.leftover(end);
        seeds
            .iter()
            .map(|&seed| {
                let mut r = Rng::new(seed);
                let d = determinize(base, p, &mut r, self.opts.peek_opp_hand);
                read_once(&pl, &d, &mut r).0 - leftover
            })
            .collect()
    }

    /// p のターン末の局面 end から 2 ターン先まで読んだ点数（測るための道具。runner/two_turn.rs。打つ手は変わらない）。
    /// 引き直し（seed）1 つで、相手のターンを読み直しと同じく打ち（read）、続く自分の次のターンを、リーサルがあればそれを、
    /// 無ければ幅 next_beam のビームでターン末の点数が最も高い並びを打ち（own はそのターン末の点数。ownNext と同じ形）、
    /// さらに相手の次のターンを読んだ後の局面を採点する（two）。読みの中の相手は読み直しと同じ（相手のターンのビーム）
    pub fn two_turn_read(
        &self,
        end: &GameState,
        p: PlayerIndex,
        seed: u32,
        next_beam: usize,
    ) -> TwoTurnRead {
        let env = self.env();
        let pl = Planner {
            env: &env,
            p,
            root: Rc::new(end.clone()),
            steps: Vec::new(),
            plays_only: false,
        };
        let same = |v: f64| TwoTurnRead {
            read: v,
            own: v,
            two: v,
            next_lethal: false,
        };
        if end.phase == Phase::Ended {
            return same(pl.eval_state(end));
        }
        let settled = pl.settle(end);
        let base = settled.as_ref().unwrap_or(end);
        let leftover = pl.leftover(end);
        let mut r = Rng::new(seed);
        let d = determinize(base, p, &mut r, self.opts.peek_opp_hand);
        let (v, after) = read_once(&pl, &d, &mut r);
        let read = v - leftover;
        if after.phase == Phase::Ended || after.active != p || after.pending.is_some() {
            return same(read);
        }
        // 自分の次のターン（相手の手札は読みの中で引き直したまま）
        let lo = LethalOptions {
            ward_blocked: self.opts.lethal_ward_blocked,
            expand_choices: self.opts.lethal_expand_choices,
            ..DEFAULT_LETHAL_OPTIONS
        };
        let lethal = self.opts.lethal
            && (search_lethal(&after, p, &lo).is_some()
                || (self.opts.lethal_exact_states > 0
                    && search_exact_lethal(
                        &after,
                        p,
                        &sure_lethal_options(self.opts.lethal_exact_states),
                    )
                    .is_some()));
        if lethal {
            return TwoTurnRead {
                read,
                own: 1e6,
                two: 1e6,
                next_lethal: true,
            };
        }
        let opts = SearchOptions {
            beam_width: next_beam,
            allow: None,
            own_next: None,
            next_lethal: 0.0,
            pass_lethal: 0,
            attack_later: 0,
            per_plan: 0,
            ..self.opts.clone()
        };
        let next_env = Env {
            opts: &opts,
            w: &self.w,
            opp_w: &self.opp_w,
            policy_w: &self.policy_w,
        };
        let root = Rc::new(after.clone());
        let Some((_, last)) = best_plan_last(&root, p, &next_env) else {
            let v = pl.eval_after(&after);
            return TwoTurnRead {
                read,
                own: v,
                two: v,
                next_lethal: false,
            };
        };
        let pl2 = Planner {
            env: &next_env,
            p,
            root,
            steps: Vec::new(),
            plays_only: false,
        };
        if last.phase == Phase::Ended {
            let v = pl2.eval_state(&last);
            return TwoTurnRead {
                read,
                own: v,
                two: v,
                next_lethal: false,
            };
        }
        let own = pl2.end_score(&last);
        let settled2 = pl2.settle(&last);
        let base2 = settled2.as_ref().unwrap_or(&last);
        let after2 = simulate_opponent_turn_by_search(base2, p, &mut r, &env);
        let two = pl.eval_after(&after2) - pl2.leftover(&last);
        TwoTurnRead {
            read,
            own,
            two,
            next_lethal: false,
        }
    }

    /// 局面 root で p が打つ並び（相手のターンを読まない plan_turn。root を決定化せずに読む）の、最初の手・点数・並びを打った後の局面。
    /// deferFuse なら回せる融合を除いた並び
    pub fn plan_candidates(
        &self,
        root: &GameState,
        p: PlayerIndex,
    ) -> Vec<(Action, f64, GameState)> {
        let env = self.env();
        let root = Rc::new(root.clone());
        let mut rng = Rng::new(1);
        plan_turn(&root, p, &env, &mut rng, false)
            .into_iter()
            .map(|(k, plan)| {
                let end = plan.steps.last().map_or(root.clone(), |(_, s)| s.clone());
                (k, plan.value, (*end).clone())
            })
            .collect()
    }

    /// 局面 root で p が打てる並びの、最初の手ごとにターン末の点数が最も高い終局面とその点数（ビームの候補。root を決定化せずに読む）
    pub fn turn_end_candidates(
        &self,
        root: &GameState,
        p: PlayerIndex,
    ) -> Vec<(Action, f64, GameState)> {
        let env = self.env();
        let root = Rc::new(root.clone());
        let (_, terminals, bests) = turn_end_bests(&root, p, &env, env.opts.fuse_root);
        bests
            .into_iter()
            .map(|(k, i)| (k, terminals[i].value, (*terminals[i].state).clone()))
            .collect()
    }

    /// 局面 root で p が打てる並びのうち、ターン末の点数が最も高いものの点数・手の列・終局面と、ビームの終局面の数（調べもの用。root を決定化せずに読む）
    pub fn turn_end_best(
        &self,
        root: &GameState,
        p: PlayerIndex,
    ) -> Option<(f64, Vec<Action>, GameState, usize)> {
        let env = self.env();
        let root = Rc::new(root.clone());
        let (pl, terminals, bests) = turn_end_bests(&root, p, &env, env.opts.fuse_root);
        let i = bests.iter().map(|&(_, i)| i).reduce(|b, i| {
            if terminals[i].value > terminals[b].value {
                i
            } else {
                b
            }
        })?;
        let t = &terminals[i];
        Some((
            t.value,
            pl.steps_actions(t.path),
            (*t.state).clone(),
            terminals.len(),
        ))
    }
}

/// 調べもの用（svwb beam-gap）: 自分のターンのビームを 1 回打った結果
pub struct BeamProbe {
    /// ターン末の点数の最大と、その並び
    pub best: f64,
    pub best_actions: Vec<Action>,
    /// ビームの終局面（残した局面）の数
    pub terminals: usize,
    /// 局面を採点した回数（残さなかった子の局面を含む）
    pub scored: u64,
    /// 残した局面のうち、別の段で先に残した局面と同じもの（同じ局面をまとめるのは段の中だけなので、段をまたいで重なる）
    pub dup_states: usize,
    /// 残した局面のうち、段ごとの数（添字が段。0 は根の局面でターンを終える手）
    pub per_depth: Vec<usize>,
    /// 選んだ局面（beam_probe の sample）
    pub nodes: Vec<ProbeNode>,
}

/// BeamProbe の、残した局面 1 つ
pub struct ProbeNode {
    pub state: Rc<GameState>,
    pub depth: u32,
    /// ターン末の点数（そこでターンを終えたらの点数。ビームが並べ替えに使う点数）
    pub value: f64,
    /// その局面から（その局面を含めて）ビームが届いたターン末の点数の最大
    pub best_after: f64,
    /// ターン末の点数が最大の並びの途中の局面か
    pub on_best: bool,
    /// 同じ段で残した局面の中での、ターン末の点数の順位（0 が最も高い）と、その段で残した数
    pub rank: usize,
    pub layer: usize,
}

impl SearchAgent {
    /// 調べもの用（svwb beam-gap）: 局面 root で p のターンのビームを 1 回打つ（root を決定化せず、相手のターンは読まない）。
    /// sample が 0 より大きければ、残した局面から乱数で sample 個と、最善の並びの途中の局面すべてを、その先で届いた最善と一緒に返す
    pub fn beam_probe(
        &self,
        root: &GameState,
        p: PlayerIndex,
        sample: usize,
        rng: &mut Rng,
    ) -> Option<BeamProbe> {
        let env = self.env();
        let root = Rc::new(root.clone());
        let before = SCORED.with(|c| c.get());
        let (pl, terminals, bests) = turn_end_bests(&root, p, &env, env.opts.fuse_root);
        let scored = SCORED.with(|c| c.get()) - before;
        let bi = bests.iter().map(|&(_, i)| i).reduce(|b, i| {
            if terminals[i].value > terminals[b].value {
                i
            } else {
                b
            }
        })?;
        // 並びの手ごとに、その手を通る終局面の点数の最大
        let mut best_step = vec![f64::NEG_INFINITY; pl.steps.len()];
        for t in &terminals {
            let mut cur = Some(t.path);
            while let Some(i) = cur {
                best_step[i] = best_step[i].max(t.value);
                cur = pl.steps[i].prev;
            }
        }
        let mut on_best = vec![false; pl.steps.len()];
        let mut cur = Some(terminals[bi].path);
        while let Some(i) = cur {
            on_best[i] = true;
            cur = pl.steps[i].prev;
        }
        let max_depth = terminals.iter().map(|t| t.depth).max().unwrap_or(0) as usize;
        let mut per_depth = vec![0usize; max_depth + 1];
        let mut layers: Vec<Vec<f64>> = vec![Vec::new(); max_depth + 1];
        for t in &terminals {
            per_depth[t.depth as usize] += 1;
            layers[t.depth as usize].push(t.value);
        }
        for l in layers.iter_mut() {
            l.sort_by(|x, y| by_value_desc(*x, *y));
        }
        let mut seen = TurnOrderSet::default();
        let mut dup_states = 0;
        for t in &terminals {
            if !seen.add(&t.state) {
                dup_states += 1;
            }
        }
        let mut nodes = Vec::new();
        if sample > 0 {
            let mut pick: Vec<usize> = (0..terminals.len()).collect();
            rng.shuffle(&mut pick);
            pick.truncate(sample);
            for (i, t) in terminals.iter().enumerate() {
                if on_best[t.path] && !pick.contains(&i) {
                    pick.push(i);
                }
            }
            for i in pick {
                let t = &terminals[i];
                let layer = &layers[t.depth as usize];
                nodes.push(ProbeNode {
                    state: t.state.clone(),
                    depth: t.depth,
                    value: t.value,
                    best_after: best_step[t.path],
                    on_best: on_best[t.path],
                    rank: layer.iter().take_while(|&&v| v > t.value).count(),
                    layer: layer.len(),
                });
            }
        }
        Some(BeamProbe {
            best: terminals[bi].value,
            best_actions: pl.steps_actions(terminals[bi].path),
            terminals: terminals.len(),
            scored,
            dup_states,
            per_depth,
            nodes,
        })
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

/// 返すカード swap のうち、keep のカードの 1 枚目（手札で最初のもの）を残すように直す（mulliganKeep）
fn keep_first_copies(
    s: &GameState,
    p: PlayerIndex,
    mut swap: Vec<Iid>,
    keep: &[crate::data::CardIdx],
) -> Vec<Iid> {
    for &c in keep {
        let copies: Vec<Iid> = s.players[p]
            .hand
            .iter()
            .filter(|h| h.card == c)
            .map(|h| h.iid)
            .collect();
        if let Some(&first) = copies.first() {
            if copies.iter().all(|i| swap.contains(i)) {
                swap.retain(|&i| i != first);
            }
        }
    }
    swap
}

/// マリガンの合法手のうち、cards のカードを初手にある分だけ全部返すもの（mulliganReturn。cards が空か初手に無ければ空）
fn return_all_copies(
    s: &GameState,
    p: PlayerIndex,
    legal: &[Action],
    cards: &[crate::data::CardIdx],
) -> Vec<Action> {
    let must: Vec<Iid> = s.players[p]
        .hand
        .iter()
        .filter(|h| cards.contains(&h.card))
        .map(|h| h.iid)
        .collect();
    if must.is_empty() {
        return Vec::new();
    }
    legal
        .iter()
        .filter(
            |a| matches!(a, Action::Mulligan { swap, .. } if must.iter().all(|i| swap.contains(i))),
        )
        .cloned()
        .collect()
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
            let _p = prof::scope(Sec::Mulligan);
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
            if opts.mulligan == MulliganMode::Keep {
                if let Some(a) = mulligan_action(legal, &[]) {
                    return a.clone();
                }
            }
            if opts.mulligan == MulliganMode::Turn1 {
                let narrowed = return_all_copies(real, p0, legal, &opts.mulligan_return);
                let legal = if narrowed.is_empty() {
                    legal
                } else {
                    &narrowed[..]
                };
                let extra = opts.extra_eval.clone().filter(|_| opts.mulligan_net);
                let w = &self.w;
                let default_w = match opts.mulligan_rollout_weights {
                    RolloutWeights::Greedy => self.default_w.clone(),
                    RolloutWeights::Ramp => {
                        let mut x = self.default_w.w.clone();
                        x.max_pp = self.opp_w.w.max_pp;
                        EvalWeights::new(x)
                    }
                    RolloutWeights::Search => self.opp_w.clone(),
                };
                let beam = opts.mulligan_rollout_beam;
                // 先へ進めるときの手: 幅 beam のビーム（読み直しは 1 手・相手は貪欲法・リーサル探索なし）か、0 なら貪欲法
                let rollout = SearchOptions {
                    beam_width: beam.max(1),
                    rescore_top: 1,
                    opponent_search: None,
                    opp_hand_samples: 1,
                    lethal: false,
                    mulligan: MulliganMode::Model,
                    draw_split: None,
                    ..SearchOptions::default()
                };
                let new_policy = move || -> RolloutPolicy {
                    if beam == 0 {
                        let dw = default_w.clone();
                        Box::new(move |s, l, r| choose_greedy(s, l, r, false, &dw, false))
                    } else {
                        let mut ag = SearchAgent::new(rollout.clone());
                        Box::new(move |s, l, r| ag.choose_action(s, l, r))
                    }
                };
                return rollout_mulligan(
                    real,
                    legal,
                    p0,
                    (
                        opts.mulligan_samples,
                        opts.mulligan_turns,
                        opts.mulligan_opp,
                    ),
                    rng,
                    &new_policy,
                    |s, phase| {
                        let v = if opts.mulligan_static {
                            evaluate_with(s, p0, w)
                        } else {
                            0.0
                        };
                        match &extra {
                            Some(f) if s.phase != Phase::Ended => v + f(s, p0, phase),
                            _ => v,
                        }
                    },
                );
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
            let swap = match (swap, opts.mulligan_keep.is_empty()) {
                (Some(swap), false) => Some(keep_first_copies(real, p0, swap, &opts.mulligan_keep)),
                (None, false) => {
                    let costs: Vec<Iid> = real.players[p0]
                        .hand
                        .iter()
                        .filter(|h| card(h.card).cost >= 4)
                        .map(|h| h.iid)
                        .collect();
                    Some(keep_first_copies(real, p0, costs, &opts.mulligan_keep))
                }
                (swap, true) => swap,
            };
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
            opp_w: &self.opp_w,
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
