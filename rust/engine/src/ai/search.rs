//! ターン単位の探索 AI（src/ai/search.ts）。
//!
//! 1. 見えない情報は determinization で複数の「ありうる局面」を作って平均する
//! 2. 各局面で、自分のターン終了までの行動の並びをビームサーチで探索する
//! 3. 有望な並び（最初の手ごとの最善）について、相手のターンを軽いビームサーチで進めた後の局面を評価する
//! 4. 平均の評価が最も良い「最初の手」を選ぶ。このターンで勝てる並び（リーサル）が見つかれば最優先する

use super::aidata::{ai_data, Weights};
use super::converging::{
    converging_attacks, dominated_attack, settle_converging_trade_steps,
    settle_converging_trades_with,
};
use super::determinize::{determinize, determinize_apart_with, determinize_with};
use super::eval::{evaluate_with, EvalWeights};
use super::exact_lethal::{search_exact_lethal, sure_lethal_options};
use super::fusion::{excessive_fusion, last_words_to_hand};
use super::greedy::choose_greedy;
use super::keys::{hand_eq_noid, state_eq, visible_eq, TurnOrderSet};
use super::lethal::{
    find_lethal, search_lethal, LethalOptions, LethalSearch, DEFAULT_LETHAL_OPTIONS,
    GUARDED_LETHAL_OPTIONS,
};
use super::mulligan::{
    model_mulligan_swap, mulligan_action, rollout_mulligan, sampled_mulligan,
    weighted_mulligan_swap, OppMulligan, RolloutPolicy,
};
use super::potential::{default_potential_net, PotentialNet};
use super::think::{Thought, ThoughtCandidate};
use super::valuenet::{default_net_weights, value_net_eval, ValuePhase};
use super::{purpose, purpose_rng, seed_of, with_purpose_rng, Agent, Rng};
use crate::data::CardIdx;
use crate::game::{
    acting_player, apply_legal, is_legal, legal_actions, resolve_turn_end, try_apply_action,
};
use crate::prof::{self, Sec};
use crate::state::*;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

/// 評価関数に足す項（学習した補正・デッキ専用の AI 用）
pub type ExtraEval = Arc<dyn Fn(&GameState, PlayerIndex, ValuePhase) -> f64 + Send + Sync>;
/// 自分が打ってよい手か（ルールで禁じる手を探索から外す）
pub type Allow = Arc<dyn Fn(&GameState, &Action, PlayerIndex) -> bool + Send + Sync>;

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
    /// 区切る手が自分の山札の枚数を変える手なら、samples 通りの代わりに、山札の一番上のカードを山札にある種類ごとに全部試し、
    /// その種類の枚数の割合で重みを付けて平均する（2 枚目からは乱数で並べ直したまま）。1 枚引く手なら、引きの平均が正確になる
    pub enumerate: bool,
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

/// 引き直しごとの (重み, 点数) を重み付きで平均し、offset を引く（重みの和は正であること）
pub(crate) fn average_reads(xs: &[(f64, f64)], offset: f64) -> f64 {
    let w: f64 = xs.iter().map(|&(w, _)| w).sum();
    xs.iter().map(|&(w, x)| w * x).sum::<f64>() / w - offset
}

/// 既定の drawSplit: 区切る手が引く手なら一番上のカードを種類ごとに全部試し、残りを幅 8 で組み直す。
/// 2026-10-28 にスペルウィッチだけで使い始め、同じ日にどのクラスでも使うようにした（docs/ai-notes.md「引く手の直前で区切って引きを作り直す」）。
/// 組み直しの幅は 2026-10-31 に 32 から 8 にした（勝率は同じで、思考が 2 割ほど軽い。docs/ai-notes.md「drawSplit の組み直しのビームを幅 8 に」）
pub const DEFAULT_DRAW_SPLIT: DrawSplit = DrawSplit {
    samples: 4,
    beam_width: 8,
    max_depth: 16,
    root_draws: 2,
    enumerate: true,
};

thread_local! {
    /// ビームが局面を採点した回数（Planner::score。調べもの用。スレッドごと。svwb beam-gap）
    static SCORED: Cell<u64> = const { Cell::new(0) };
}

/// 自分のターンの最初に、候補の打ち比べ調査と同じ候補を最後まで打ち比べて選び直す（2026-11-12。打ち比べ調査の得を対戦で確かめる。
/// docs/survey.md「対戦で確かめる」）。打つのは手番の側から見た決定化（相手の手札は引き直す）で、続きは両方の席とも今の既定の AI
#[derive(Clone, Debug, PartialEq)]
pub struct PickByPlayout {
    /// 候補ごとに最後まで打つ回数（一段目）
    pub m: u32,
    /// 足す候補の数（調査の --extra）
    pub extra: usize,
    /// AI の選んだ候補との勝率の差（ポイント）がこれ以上の候補があれば、差の最も大きい候補に替える
    pub threshold: f64,
    /// 前半の回で AI の選んだ候補に勝っていない候補は、後半を打たない（調査の行から、得の下限 6.9・打つ回数 65% と見積もった）
    pub prune: bool,
}

/// pick の既定（調査の行から決めた線。docs/survey.md「対戦で確かめる」）
pub const DEFAULT_PICK: PickByPlayout = PickByPlayout {
    m: 32,
    extra: 4,
    threshold: 15.0,
    prune: true,
};

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
    /// 次のターン以降に回せる融合（作ったカードをこのターンに使わない融合）は打たない。並びの選び方と点数は変えず（融合した終局面の点数のまま）、
    /// 選んだ並びから回せる融合を除いて打つ（Planner::needless_fusions）
    pub defer_fuse: bool,
    /// deferFuse で回したあとのターン末の手札の枚数の上限。回すと手札がこれより多くなる融合は回さない
    /// （8 なら次のターンの最初に引くカードが入る。手札が上限近くで止まると、コアを加えるカードを出しにくくなり、引いたカードが溢れる）
    pub defer_fuse_hand: usize,
    /// deferFuse で、自分の場のフォロワーのラストワードが手札に加えるカードの枚数（ビビッドインベンター・イリスのコア等）だけ、
    /// defer_fuse_hand を下げる（相手のターンに破壊されると手札が増え、次のターンの最初に引くカードが溢れる）
    pub defer_fuse_last_words: bool,
    /// 素材を入れすぎる融合（同じ融合先を、素材を 1 枚少なく使って作れる融合。ai/fusion.rs）を展開しない
    pub fuse_minimal: bool,
    pub mulligan: MulliganMode,
    /// MulliganMode::Sample・Turn1 で、返し方ごとに引き直しを試す回数
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
    /// ビームで残す局面を選ぶ並べ替えのキーに足す、学習した見込み（potentialNet。ai/potential.rs）と、その倍率（potentialWeight）。
    /// ターンを終える局面の点数には足さず、自分のターンのビームだけに効く（drawSplit の組み直し・読みの中の相手には効かない）。
    /// 既定は data/potential-net.json（2026-10-30 から）
    pub potential: Option<Arc<PotentialNet>>,
    pub potential_weight: f64,
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
    pub opp_hand_samples: usize,
    /// oppHandSamples で引き直す相手の手札を、読み直すどの終局面でも同じ並びにする（手どうしの差のぶれを減らす）
    pub opp_hand_common: bool,
    /// 読み直しの決定化で、自分の山札を別の乱数で並べ直す（determinize_apart）。引く手と引かない手の終局面（自分の山札の枚数が違う）でも、
    /// 同じ引き直しの種なら相手の手札が同じになる（oppHandCommon をどの手でも成り立たせる。docs/ai-notes.md「錬金釜を置くと点数が下がる理由」）
    pub read_own_deck_apart: bool,
    pub peek_opp_hand: bool,
    /// 読み直し（相手のターンの読み）の決定化で、配り直した相手の伏せた手札に、手札の記録（公開の出来事）から見込んだスペルブースト等の回数をかけ直す
    /// （determinize_with。docs/ai-notes/13-2026-11-13.md「伏せた相手の手札のスペルブーストを決定化で見込む」）。
    /// 自分のターンのビームの決定化は前のまま（相手の手札は読み直しで配り直すので、効くのは読み直しの中）
    pub opp_hand_boosts: bool,
    /// 上位の手を読み直した点数に、ターン末の点数をこの割合で混ぜる（0 なら読み直した点数だけ。既定 0.5、2026-10-22）
    pub rescore_mix: f64,
    /// 見込みのない終局面の読みを途中で打ち切る（RescoreRace。None なら全部読む。既定は DEFAULT_RESCORE_RACE、2026-10-30）
    pub rescore_race: Option<RescoreRace>,
    /// 読み直す並びを引く手・ランダムな手の直前で区切り、引きを作り直して平均する（DrawSplit。None なら使わない。既定は DEFAULT_DRAW_SPLIT）
    pub draw_split: Option<DrawSplit>,
    /// 選んだ並びの、相手のターンを読んだ後の想像の局面を残す（SearchAgent::take_reads。TD 学習の自己対戦の --imagined 用。打つ手は変わらない）
    pub record_reads: bool,
    /// AI の思考用の乱数を、渡された乱数から取った順番に使う（2026-11-10 より前の取り方。物差しの相手の手を変えないために残す）。
    /// false（既定）なら、判断ごとに 1 つ取った種から、用途と何番目かで作る（相手の手札の引き直しの数を変えても、前からある引き直しは同じ）。
    /// 試合の中では、true の AI だけが 1 試合に 1 本の乱数を順に使い、false の AI は判断ごとに作った乱数を使う（sim.rs の MatchRng）
    pub sequential_rng: bool,
    /// 自分のターンの最初に、候補を最後まで打ち比べて選び直す（PickByPlayout。None なら使わない。既定 None）
    pub pick: Option<PickByPlayout>,
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
            // docs/ai-notes.md「ターン途中の見込みを学ぶ」）。
            // 2026-11-05 に、見込みはそのままで幅 256 に（12800 試合で 50.57% ± 0.16、思考は 1.08 倍。
            // docs/ai-notes.md「自分のターンのビームを見込みありで幅 256・512 にする」）
            beam_width: 256,
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
            // 使わない融合は次のターン以降に回す（ラストワードの分を空ける形。前の版と勝率は同じで、使わない融合をしない。2026-10-29、
            // docs/ai-notes.md「回して何も残らない並びで、点数に入れた相打ちをしない見落とし」）
            defer_fuse: true,
            defer_fuse_hand: HAND_LIMIT - 1,
            defer_fuse_last_words: true,
            // 素材を入れすぎる融合を展開しないのは、勝率を比べてから決める（docs/ai-notes.md「融合を回した局面で探索が取りこぼすか」）
            fuse_minimal: false,
            // 引き直した後、3 ターン目の終わりまで貪欲法で進めてから採点する
            // （docs/ai-notes.md「引き直した後に先へ進めてから採点するマリガン」。手札の形のモデルより +1.5%）
            mulligan: MulliganMode::Turn1,
            // 引き直しを試す回数。100 回と勝率が変わらず、マリガンの時間が半分になる 50 回
            // （docs/ai-notes.md「マリガンで引き直しを試す回数を減らす」）
            mulligan_samples: 50,
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
            potential: Some(default_potential_net()),
            potential_weight: 1.0,
            extra_eval: Some(Arc::new(value_net_eval)),
            opp_extra_eval: None,
            weights,
            policy_weights,
            // 相手のターンを読むビームの幅は 4 から 16 に（6400 試合で 51.9%、物差しは 78.0% → 79.8%。
            // docs/ai-notes.md「相手のターンを読むビームの幅を 16 に」）。
            // 2026-10-31 に 8 に（幅 16 に 49.8% ± 0.31、思考は 0.87 倍。docs/ai-notes.md「学習した見込みを読みの中の相手のビームに使う」）
            opponent_search: Some(OpponentSearch {
                beam_width: 8,
                max_depth: 8,
                extra_eval: false,
            }),
            opp_hand_samples: 12,
            opp_hand_common: true,
            // 2026-11-02 から（6400 試合で 50.6% ± 0.40。docs/ai-notes.md「錬金釜を置くと点数が下がる理由」）
            read_own_deck_apart: true,
            peek_opp_hand: false,
            opp_hand_boosts: false,
            rescore_mix: 0.5,
            rescore_race: Some(DEFAULT_RESCORE_RACE),
            draw_split: Some(DEFAULT_DRAW_SPLIT),
            record_reads: false,
            // 2026-11-10 から、思考用の乱数を用途から作る（docs/ai-notes.md「AI の思考用の乱数を用途から作る」）
            sequential_rng: false,
            pick: None,
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

/// 相手のターンを読んだ後の点数がこれ以下なら、その並びは相手のターンで負ける（rescoreRace の lethal_guard）
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
        self.end_score(s)
    }

    fn allowed(&self, s: &GameState, a: &Action) -> bool {
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
            let first = a.clone();
            if matches!(a, Action::EndTurn) {
                if root_converges {
                    continue; // 合流する攻撃をしてから終える手に劣らない
                }
                let path = self.push_step(a, None);
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
            self.advance(root, &a, None, 0, &mut next);
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
            // 見込み（potential）で並べると、点数の高い子が残らないことがある。採点は済んでいるので、最初の手ごとに残らなかった子の点数の最大も終局面の候補にする
            let mut cut_best: Vec<Node> = Vec::new();
            if opts.potential.is_some() {
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
            if let Some(net) = &opts.potential {
                let mut keyed: Vec<(f64, Node)> = children
                    .into_iter()
                    .map(|n| (n.value + key_bonus(net, opts, &n.state, p), n))
                    .collect();
                keyed.sort_by(|x, y| by_value_desc(x.0, y.0));
                children = keyed.into_iter().map(|(_, n)| n).collect();
            } else {
                children.sort_by(|x, y| by_value_desc(x.value, y.value));
            }
            frontier = if opts.dedup {
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

/// 並べ替えのキーに足す、学習した見込み（potentialNet）の伸びしろ
fn key_bonus(net: &PotentialNet, opts: &SearchOptions, s: &GameState, p: PlayerIndex) -> f64 {
    opts.potential_weight * net.eval(s, p)
}

/// ビームサーチの終局面と、最初の手ごとにターン末の点数が最も高い終局面の添字（最初の手が出てきた順）
fn turn_end_bests<'a>(
    root: &Rc<GameState>,
    p: PlayerIndex,
    env: &'a Env<'a>,
) -> (Planner<'a>, Vec<Node>, Vec<(Action, usize)>) {
    let _p = prof::scope(Sec::Beam);
    let opts = env.opts;
    let mut pl = Planner {
        env,
        p,
        root: root.clone(),
        steps: Vec::new(),
    };
    let root_converges = opts.settle_trades && !converging_attacks(root, p).is_empty();
    let terminals = pl.beam_terminals(root, root_converges);
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

/// 相手のターンまで読み直す終局面（最初の手ごとの最善のうち、ターン末の点数の上位 rescore_top と、drawSplit が足す引く手）
fn rescore_ranked(
    root: &GameState,
    p: PlayerIndex,
    opts: &SearchOptions,
    terminals: &[Node],
    best_by_first: &[(Action, usize)],
) -> Vec<usize> {
    let mut ranked: Vec<usize> = best_by_first.iter().map(|(_, i)| *i).collect();
    ranked.sort_by(|&x, &y| by_value_desc(terminals[x].value, terminals[y].value));
    ranked.truncate(opts.rescore_top);
    // drawSplit: 今打てる引く手（先に引く手）が上位に無ければ、ターン末の点数の高い順に足す
    // （同じ局面をまとめると、先に引く並びの終局面が後で引く並びの側に数えられて、先に引く手の点数が下がるため）
    if let Some(ds) = opts.draw_split {
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
    ranked
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
    let draw_split = opts.draw_split;
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
    let ranked = rescore_ranked(root, p, opts, &terminals, &best_by_first);

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

    // 読み直しの乱数の元（sequential_rng でなければ、ここで 1 つ取り、引き直しの種は用途と何番目かで作る。
    // 引き直しの数を変えても、前からある引き直しは同じ）
    let pbase: Option<u32> = (!opts.sequential_rng).then(|| rng.int(u32::MAX as usize) as u32);
    let mut seed_at = |purpose: u32, i: usize| -> u32 {
        match pbase {
            Some(b) => seed_of(&[b, purpose, i as u32]),
            None => rng.int(u32::MAX as usize) as u32,
        }
    };
    let common_seeds: Vec<u32> = if opts.opp_hand_common && opts.opp_hand_samples > 1 {
        (0..opts.opp_hand_samples)
            .map(|i| seed_at(purpose::OPP_HAND, i))
            .collect()
    } else {
        Vec::new()
    };
    // drawSplit: 引きを作り直す乱数（どの並びでも同じ）と、組み直すビームの設定
    let split_seeds: Vec<u32> = match draw_split {
        Some(ds) => (0..ds.samples.max(1))
            .map(|i| seed_at(purpose::SPLIT, i))
            .collect(),
        None => Vec::new(),
    };
    // enumerate: 一番上のカードの種類ごとに山札の残りを並べ直す乱数の元（種類ごとに決まるので、どの並びでも同じ種類なら同じ並べ直し）
    let enum_seed: Option<u32> = match draw_split {
        Some(ds) if ds.enumerate => Some(seed_at(purpose::SPLIT_ENUM, 0)),
        _ => None,
    };
    // 終局面 i の k 番目の引き直しの乱数（oppHandCommon でないとき・引き直し 1 回のとき。sequential_rng なら None で、rng を順に使う）
    let read_rng = |i: usize, k: usize| -> Option<Rng> {
        pbase.map(|b| Rng::new(seed_of(&[b, purpose::READ, i as u32, k as u32])))
    };
    let split_opts: Option<SearchOptions> = draw_split.map(|ds| SearchOptions {
        beam_width: ds.beam_width,
        max_depth: ds.max_depth,
        draw_split: None,
        // 見込みは組み直しのビームには使わない（使うと組み直しが重くなり、勝率は同じ）
        potential: None,
        ..opts.clone()
    });
    let split_env: Option<Env> = split_opts.as_ref().map(|o| Env {
        opts: o,
        w: env.w,
        opp_w: env.opp_w,
        policy_w: env.policy_w,
    });
    // rescoreRace で先に読んだ引き直し（終局面の添字と、引き直しの順の (点数, 読んだ後の局面)）
    let race_reads: RefCell<Vec<(usize, Vec<RaceRead>)>> = RefCell::new(Vec::new());
    let mut result: Vec<(Action, Plan)> = Vec::new();
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
                // 読んだ (重み, 点数)、ターン末の点数の重み付きの和と、重みの和
                let mut read_xs: Vec<(f64, f64)> = Vec::new();
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
                    }
                    let Some(s1) = try_apply_action(&s, a) else {
                        continue;
                    };
                    let (end, te) = split_turn_end(&pl, Rc::new(s1), senv);
                    te_sum += w * te;
                    te_w += w;
                    if end.phase == Phase::Ended {
                        let v = pl.eval_state(&end);
                        read_xs.push((w, v));
                        read_w += w;
                        reads += 1;
                        add((*end).clone());
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
                    for &seed2 in &mine {
                        let mut r2 = Rng::new(seed2);
                        let d = read_determinize(base, p, &mut r2, opts);
                        let (v, after) = read_once(&pl, &d, &mut r2);
                        read_xs.push((wr, v - left));
                        read_w += wr;
                        reads += 1;
                        add(after);
                    }
                }
                if te_w > 0.0 && read_w > 0.0 {
                    turn_end = te_sum / te_w;
                    Some((average_reads(&read_xs, 0.0), reads))
                } else {
                    None
                }
            }
            _ => None,
        };
        let (value, n) = if let Some(x) = split {
            x
        } else if node.state.phase == Phase::Ended {
            if tracing {
                parts = pl.parts(&node.state, ValuePhase::End);
            }
            (pl.eval_state(&node.state), 1)
        } else if opts.opp_hand_samples <= 1 {
            let settled = pl.settle(&node.state);
            let start = settled.as_ref().unwrap_or(&node.state);
            let (v, after) = match read_rng(i, 0) {
                Some(mut r) => read_once(&pl, start, &mut r),
                None => read_once(&pl, start, rng),
            };
            add(after);
            (v - pl.leftover(&node.state), 1)
        } else {
            let settled = pl.settle(&node.state);
            let base = settled.as_ref().unwrap_or(&node.state);
            // 引き直しごとの (重み, 点数)（残った PP の分は引かずに入れ、まとめるときに引く）
            let mut xs: Vec<(f64, f64)> = Vec::new();
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
                    let (v, after) = match done.next() {
                        Some(x) => (x.value, x.after),
                        None => {
                            let mut r = Rng::new(seed);
                            read_common(&pl, base, &mut r)
                        }
                    };
                    xs.push((1.0, v));
                    add(after);
                }
            } else {
                for k in 0..opts.opp_hand_samples {
                    let (v, after) = match read_rng(i, k) {
                        Some(mut r) => {
                            let d = read_determinize(base, p, &mut r, opts);
                            read_once(&pl, &d, &mut r)
                        }
                        None => {
                            let d = read_determinize(base, p, rng, opts);
                            read_once(&pl, &d, rng)
                        }
                    };
                    xs.push((1.0, v));
                    add(after);
                }
            }
            (
                average_reads(&xs, pl.leftover(&node.state)),
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
    // 落とした終局面（添字と、落としたときの見込み）
    let mut dropped: Vec<(usize, f64)> = Vec::new();
    if let Some(rr) = opts.rescore_race {
        if opts.opp_hand_common && common_seeds.len() > 1 {
            let racers: Vec<usize> = ranked
                .iter()
                .flat_map(|&b| candidates_of(b))
                .filter(|&i| {
                    let t = &terminals[i];
                    t.state.phase != Phase::Ended
                        && (split_env.is_none()
                            || first_chance_step(root, &pl.steps_of(t.path), p).is_none())
                })
                .collect();
            let (kept, out) = race_rescore(&pl, &terminals, &racers, &common_seeds, rr);
            *race_reads.borrow_mut() = kept;
            dropped = out;
        }
    }
    let is_dropped = |i: usize| dropped.iter().any(|d| d.0 == i);
    for best in ranked {
        for i in candidates_of(best) {
            if is_dropped(i) {
                continue;
            }
            rescore_node(i, rng, &mut result, &mut reads);
        }
    }
    // rescoreRace の reentry: 読み終えた手のいちばん高い点数より、落としたときの見込みが高い終局面は、残りも読んで戻す
    if let Some(m) = opts.rescore_race.and_then(|rr| rr.reentry) {
        if !dropped.is_empty() {
            let best = result
                .iter()
                .map(|(_, x)| x.value)
                .fold(f64::NEG_INFINITY, f64::max);
            for &(i, est) in &dropped {
                if est > best - m {
                    rescore_node(i, rng, &mut result, &mut reads);
                }
            }
        }
    }
    if let Some(tr) = trace {
        tr.reads = reads;
    }
    rekey_deferred(result, opts.defer_fuse, root)
}

/// rescoreRace で先に読んだ 1 通りの引き直し
struct RaceRead {
    value: f64,
    after: GameState,
}

/// 相手のターンを読む前の決定化（読み直しで使う。readOwnDeckApart なら自分の山札を別の乱数で並べ直す）
fn read_determinize(
    base: &GameState,
    p: PlayerIndex,
    rng: &mut Rng,
    opts: &SearchOptions,
) -> GameState {
    if opts.read_own_deck_apart {
        determinize_apart_with(base, p, rng, opts.peek_opp_hand, opts.opp_hand_boosts)
    } else {
        determinize_with(base, p, rng, opts.peek_opp_hand, opts.opp_hand_boosts)
    }
}

/// 相手の手札の引き直し（oppHandCommon。r はその引き直しの種で作った乱数で、読んだ後の状態になる）で、
/// base から相手のターンを読んだ点数と、読んだ後の局面
fn read_common(pl: &Planner, base: &GameState, r: &mut Rng) -> (f64, GameState) {
    let d = read_determinize(base, pl.p, r, pl.opts());
    read_once(pl, &d, r)
}

/// rescoreRace: 終局面 racers（terminals の添字）を、引き直しを rr.first 通り、その後 rr.step 通りずつ読んで比べ、
/// 見込みのないものを落とす。終局面ごとの読んだ分（落とした終局面も。reentry で戻すときに使う）と、
/// 落とした終局面（添字と、落としたときの選ぶ値の見込み）を返す
fn race_rescore(
    pl: &Planner,
    terminals: &[Node],
    racers: &[usize],
    seeds: &[u32],
    rr: RescoreRace,
) -> RaceResult {
    struct Racer {
        i: usize,
        settled: Option<GameState>,
        left: f64,
        /// 引き直しごとの読みの点数（残った PP の分を引いたもの）
        xs: Vec<f64>,
        reads: Vec<RaceRead>,
    }
    let mix = pl.opts().rescore_mix;
    let mut alive: Vec<Racer> = racers
        .iter()
        .map(|&i| Racer {
            i,
            settled: pl.settle(&terminals[i].state),
            left: pl.leftover(&terminals[i].state),
            xs: Vec::new(),
            reads: Vec::new(),
        })
        .collect();
    let mut dropped: Vec<(usize, f64)> = Vec::new();
    let mut kept: Vec<(usize, Vec<RaceRead>)> = Vec::new();
    let mut n = 0;
    let mut next = rr.first.max(1);
    while next < seeds.len() && alive.len() >= 2 {
        for rc in alive.iter_mut() {
            let base = rc.settled.as_ref().unwrap_or(&terminals[rc.i].state);
            for &seed in &seeds[n..next] {
                let mut r = Rng::new(seed);
                let (v, after) = read_common(pl, base, &mut r);
                rc.xs.push(v - rc.left);
                rc.reads.push(RaceRead { value: v, after });
            }
        }
        n = next;
        next = n + rr.step.max(1);
        if rr.lethal_guard && alive.iter().any(|rc| rc.xs.iter().any(|&x| x <= DANGER)) {
            continue;
        }
        let k = n as f64;
        let est = |rc: &Racer| {
            let xs: Vec<(f64, f64)> = rc.xs.iter().map(|&x| (1.0, x)).collect();
            (1.0 - mix) * average_reads(&xs, 0.0) + mix * terminals[rc.i].value
        };
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
                dropped.push((rc.i, est(&rc)));
                kept.push((rc.i, rc.reads));
            }
        }
        alive = rest;
    }
    kept.extend(alive.into_iter().map(|rc| (rc.i, rc.reads)));
    (kept, dropped)
}

/// race_rescore の結果（終局面ごとの読んだ分と、落とした終局面）
type RaceResult = (Vec<(usize, Vec<RaceRead>)>, Vec<(usize, f64)>);

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
    let (_, terminals, _) = turn_end_bests(&start, pl.p, env);
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

/// start から相手のターンを読んだ点数と、読んだ後の局面
fn read_once(pl: &Planner, start: &GameState, rng: &mut Rng) -> (f64, GameState) {
    let env = pl.env;
    let p = pl.p;
    let after = {
        let _p = prof::scope(Sec::OppTurn);
        if env.opts.opponent_search.is_some() {
            simulate_opponent_turn_by_search(start, p, rng, env)
        } else {
            simulate_opponent_turn(start, p, rng, env.policy_w)
        }
    };
    (pl.eval_after(&after), after)
}

/// 自分のターンを終え、相手のターン（と、その途中の選択）を貪欲法で進め、自分の手番に戻った局面を返す
pub fn simulate_opponent_turn(
    state: &GameState,
    p: PlayerIndex,
    rng: &mut Rng,
    policy_w: &EvalWeights,
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
        let a = choose_greedy(cur, &legal_actions(cur), rng, true, policy_w);
        s = try_apply_action(cur, &a);
    }
    s.unwrap_or_else(|| state.clone())
}

/// 読みの中の相手のビームの設定（simulate_opponent_turn_by_search）
fn opponent_search_options(opts: &SearchOptions) -> SearchOptions {
    let os = opts.opponent_search;
    SearchOptions {
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
        opponent_search: None,
        potential: None,
        ..opts.clone()
    }
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
    let opp_opts = opponent_search_options(opts);
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
        let a = choose_greedy(&cur, &legal_actions(&cur), rng, true, env.policy_w);
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
    /// pick で最後に打ち比べた自分のターン（席ごとの turn_count）
    pick_turn: [i32; 2],
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
            pick_turn: [i32::MIN; 2],
        }
    }

    /// p が最後に選んだ並びの、相手のターンを読んだ後の想像の局面（record_reads のとき）を取り出す。取り出すと空になる
    pub fn take_reads(&mut self, p: PlayerIndex) -> Vec<Rc<GameState>> {
        std::mem::take(&mut self.reads[p])
    }
}

impl SearchAgent {
    /// 調べもの用（svwb beam-gap）: 局面 s（決定化した局面。決定化し直さない）で、このAI のリーサル探索が p の勝てる並びを見つけるか
    pub fn finds_lethal(&self, s: &GameState, p: PlayerIndex) -> bool {
        let opts = &self.opts;
        let lo = LethalOptions {
            ward_blocked: opts.lethal_ward_blocked,
            expand_choices: opts.lethal_expand_choices,
            ..DEFAULT_LETHAL_OPTIONS
        };
        search_lethal(s, p, &lo)
            .or_else(|| {
                (opts.lethal_exact_states > 0)
                    .then(|| {
                        search_exact_lethal(s, p, &sure_lethal_options(opts.lethal_exact_states))
                    })
                    .flatten()
            })
            .is_some_and(|seq| !seq.is_empty())
    }

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
        // 判断の乱数の元（choose_action と同じ）
        let base = (!opts.sequential_rng).then(|| rng.int(u32::MAX as usize) as u32);
        let lethal = match lethal {
            Some(l) => l,
            None => with_purpose_rng(rng, base, purpose::LETHAL, 0, |r| {
                self.lethal_action(real, legal, p, r)
            }),
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
            let det = Rc::new(with_purpose_rng(
                rng,
                base,
                purpose::DETERMINIZE,
                sample as u32,
                |r| determinize(real, p, r, opts.peek_opp_hand),
            ));
            let mut trace = PlanTrace::default();
            let plans = with_purpose_rng(rng, base, purpose::PLAN, sample as u32, |r| {
                plan_turn_traced(&det, p, &env, r, true, Some(&mut trace))
            });
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
                with_purpose_rng(rng, base, purpose::GREEDY, 0, |r| {
                    choose_greedy(real, choices, r, false, &self.default_w)
                })
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
                let d = read_determinize(base, p, &mut r, &self.opts);
                read_once(&pl, &d, &mut r).0 - leftover
            })
            .collect()
    }

    /// p のターン末の局面 end から 2 ターン先まで読んだ点数（測るための道具。runner/two_turn.rs。打つ手は変わらない）。
    /// 引き直し（seed）1 つで、相手のターンを読み直しと同じく打ち（read）、続く自分の次のターンを、リーサルがあればそれを、
    /// 無ければ幅 next_beam のビームでターン末の点数が最も高い並びを打ち（own はそのターン末の点数）、
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
        let d = read_determinize(base, p, &mut r, &self.opts);
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

    /// 局面 root から p が手の列 actions（ターン終了の前まで）を打つ並びを、探索が選んだとして、
    /// deferFuse で回せる融合を除いて実際に打つ手の列（テスト用。どの並びを選ぶかは学習した補正で変わるので、並びを決めて確かめる）
    #[cfg(test)]
    pub(crate) fn deferred_actions(
        &self,
        root: &GameState,
        p: PlayerIndex,
        actions: &[Action],
    ) -> Vec<Action> {
        let env = self.env();
        let root = Rc::new(root.clone());
        let mut pl = Planner {
            env: &env,
            p,
            root: root.clone(),
            steps: Vec::new(),
        };
        let mut prev = None;
        let mut state = root.clone();
        for a in actions {
            prev = Some(pl.push_step(a.clone(), prev));
            state = Rc::new(apply_legal(&state, a));
        }
        let path = prev.expect("手の列が空");
        let node = Node {
            state,
            first: actions[0].clone(),
            value: 0.0,
            path,
            depth: actions.len() as u32,
        };
        let steps = pl.steps_of(path);
        pl.defer_steps(&node, steps)
            .into_iter()
            .map(|(a, _)| a)
            .collect()
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
        let (_, terminals, bests) = turn_end_bests(&root, p, &env);
        bests
            .into_iter()
            .map(|(k, i)| (k, terminals[i].value, (*terminals[i].state).clone()))
            .collect()
    }
}

/// 候補の打ち比べ調査（runner/survey.rs）の候補 1 つ
pub struct SurveyPlan {
    /// AI が読み直した候補（AI が選ぶ候補の中）か。false なら、ターン末の点数では下でも使うカードの組が違う並び
    pub top: bool,
    /// AI が読み直しを始めたが、rescoreRace が打ち切った候補（top も true。value は None）
    pub cut: bool,
    /// AI が選ぶ手か（choose_action と同じ）
    pub chosen: bool,
    /// AI がこの並びを選んだら打つ手（drawSplit なら最初の引く手・ランダムな手まで、deferFuse なら回せる融合を除いたもの。
    /// その先は AI が考え直す）
    pub steps: Vec<Action>,
    /// ビームの終局面までの並び（使うカードの組と手の種類を見る用。ターン終了は含まない）
    pub full: Vec<Action>,
    /// ターン末の点数
    pub turn_end: f64,
    /// ターン末の点数の、ビームの全部の終局面の中での順位（0 が最も高い）
    pub rank: usize,
    /// 手を選ぶときの値（読み直した候補だけ）
    pub value: Option<f64>,
}

/// 候補の打ち比べ調査の、1 つの局面の候補
pub struct Survey {
    /// リーサルを見つけた（候補を比べずにそれを打つ。plans は空）
    pub lethal: bool,
    /// 読み直した候補（選ぶときの値の高い順）、続いて足した候補（ターン末の点数の高い順）
    pub plans: Vec<SurveyPlan>,
    /// ビームの終局面の数
    pub terminals: usize,
    /// 考えた決定化の局面（候補の並びはこの局面からのもの。リーサルなら None）
    pub root: Option<GameState>,
}

/// root から p が手の列 acts を打つときに使うカード（手札から出したカードと融合の素材）の種類の組（並べたもの）。打てない手があればそこまで
pub fn used_cards(root: &GameState, acts: &[Action]) -> Vec<CardIdx> {
    let mut s = root.clone();
    let mut out = Vec::new();
    let card_in_hand = |s: &GameState, iid: Iid| {
        s.players
            .iter()
            .flat_map(|pl| pl.hand.iter())
            .find(|h| h.iid == iid)
            .map(|h| h.card)
    };
    for a in acts {
        match a {
            Action::Play(i) => out.extend(card_in_hand(&s, *i)),
            Action::Fuse { materials, .. } => {
                out.extend(materials.iter().filter_map(|m| card_in_hand(&s, *m)))
            }
            _ => {}
        }
        if matches!(a, Action::EndTurn) {
            break;
        }
        match try_apply_action(&s, a) {
            Some(next) => s = next,
            None => break,
        }
    }
    out.sort_unstable();
    out
}

impl SearchAgent {
    /// 候補の打ち比べ調査（runner/survey.rs）: 実際の局面 real で、choose_action と同じ乱数の使い方で考え（think_with）、
    /// 読み直した候補（AI が選ぶ候補）と、同じ決定化のビームの終局面からターン末の点数の高い順に、使うカードの組が
    /// それまでの候補のどれとも違い、打つ手も違う並びを extra 個まで足して返す。手を 1 つしか打てない局面は None
    pub fn survey_plans(
        &self,
        real: &GameState,
        legal: &[Action],
        rng: &mut Rng,
        extra: usize,
    ) -> Option<Survey> {
        let thought = self.think_with(real, legal, rng, None)?;
        if thought.lethal.is_some() {
            return Some(Survey {
                lethal: true,
                plans: Vec::new(),
                terminals: 0,
                root: None,
            });
        }
        let p = thought.player;
        let opts = &self.opts;
        let env = self.env();
        let root = Rc::new(thought.roots[0].clone());
        // think_with と同じ決定化・同じ設定のビーム（乱数を使わないので、考えたときと同じ終局面）
        let (pl, terminals, bests) = turn_end_bests(&root, p, &env);
        let mut order: Vec<usize> = (0..terminals.len()).collect();
        order.sort_by(|&x, &y| by_value_desc(terminals[x].value, terminals[y].value));
        let mut rank = vec![0usize; terminals.len()];
        for (r, &i) in order.iter().enumerate() {
            rank[i] = r;
        }
        let full_of = |i: usize| -> Vec<Action> {
            pl.steps_actions(terminals[i].path)
                .into_iter()
                .filter(|a| !matches!(a, Action::EndTurn))
                .collect()
        };
        // AI がこの終局面の並びを選んだときに打つ手（plan_turn_traced と同じ区切り方と、回せる融合の除き方）。打てなければ None
        let ai_steps = |i: usize| -> Option<Vec<Action>> {
            let t = &terminals[i];
            let mut steps = pl.steps_of(t.path);
            if opts.draw_split.is_some() {
                if let Some(c) = first_chance_step(&root, &steps, p) {
                    steps.truncate(c + 1);
                }
            }
            if opts.defer_fuse {
                steps = pl.defer_steps(t, steps);
            }
            let acts: Vec<Action> = steps.into_iter().map(|(a, _)| a).collect();
            let first = acts.first().cloned()?;
            if legal.contains(&first) {
                return Some(acts);
            }
            // 回せる融合を除いた並びの最初の手が一覧に無い同じ融合なら、一覧の手に直してその手だけを打つ（rekey_deferred と同じ）
            same_fusion_in(&root, legal, &first).map(|a| vec![a])
        };
        let mut plans: Vec<SurveyPlan> = Vec::new();
        let mut keys: Vec<Vec<CardIdx>> = Vec::new();
        for c in thought
            .candidates
            .iter()
            .filter(|c| c.value.is_some() && c.legal)
        {
            // ビームの終局面は、最初の手ごとの最善（決定化 1 回のとき。無ければ打つ手を終局面までの並びとみなす）
            let ti = (c.sample == 0)
                .then(|| bests.iter().find(|(a, _)| *a == c.action).map(|x| x.1))
                .flatten();
            let full = match ti {
                Some(i) => full_of(i),
                None => c
                    .steps
                    .iter()
                    .filter(|a| !matches!(a, Action::EndTurn))
                    .cloned()
                    .collect(),
            };
            keys.push(used_cards(&root, &full));
            plans.push(SurveyPlan {
                top: true,
                cut: false,
                chosen: c.action == thought.chosen,
                steps: c.steps.clone(),
                full,
                turn_end: c.turn_end.total,
                rank: ti.map_or(usize::MAX, |i| rank[i]),
                value: c.value,
            });
        }
        // 読み直しを始めたが rescoreRace が打ち切った候補（読み直す終局面のうち、選ぶときの値が無いもの）
        for i in rescore_ranked(&root, p, opts, &terminals, &bests) {
            let t = &terminals[i];
            let read = thought
                .candidates
                .iter()
                .any(|c| c.action == t.first && c.value.is_some());
            if read {
                continue;
            }
            let Some(acts) = ai_steps(i) else {
                continue;
            };
            if plans.iter().any(|x| x.steps == acts) {
                continue;
            }
            let full = full_of(i);
            keys.push(used_cards(&root, &full));
            plans.push(SurveyPlan {
                top: true,
                cut: true,
                chosen: false,
                steps: acts,
                full,
                turn_end: t.value,
                rank: rank[i],
                value: None,
            });
        }
        let mut added = 0;
        for &i in &order {
            if added >= extra {
                break;
            }
            let t = &terminals[i];
            let full = full_of(i);
            let key = used_cards(&root, &full);
            if keys.contains(&key) {
                continue;
            }
            let Some(acts) = ai_steps(i) else {
                continue;
            };
            if plans.iter().any(|x| x.steps == acts) {
                continue;
            }
            keys.push(key);
            plans.push(SurveyPlan {
                top: false,
                cut: false,
                chosen: false,
                steps: acts,
                full,
                turn_end: t.value,
                rank: rank[i],
                value: None,
            });
            added += 1;
        }
        Some(Survey {
            lethal: false,
            plans,
            terminals: terminals.len(),
            root: Some((*root).clone()),
        })
    }

    /// 候補の打ち比べ調査: p がこのターンに並び steps（各手を打った後の予想の局面つき）を選び、最初の手を打ったものとする。
    /// 次の判断から、choose_action が選んだ並びと同じく、局面が予想どおりなら続きを打つ
    pub fn follow_plan(&mut self, p: PlayerIndex, steps: Vec<(Action, Rc<GameState>)>) {
        self.plans[p] =
            (self.opts.reuse_plan && steps.len() > 1).then_some(PlanState { steps, index: 1 });
    }

    /// pick: 自分のターンの最初の判断なら、候補を最後まで打ち比べ、替える候補があればその最初の手（続きは並びを打つ）。
    /// 替えないとき・ターンの最初でないときは None（渡された乱数を進めないので、続く choose_action は pick なしと同じ手を選ぶ）
    fn pick_by_playout(
        &mut self,
        real: &GameState,
        legal: &[Action],
        rng: &mut Rng,
    ) -> Option<Action> {
        let pk = self.opts.pick.clone()?;
        let p = acting_player(real);
        let start = real.phase == Phase::Main
            && real.active == p
            && real.pending.is_none()
            && real.stack.is_empty()
            && real.queue.is_empty();
        if !start || real.players[p].turn_count == self.pick_turn[p] {
            return None;
        }
        self.pick_turn[p] = real.players[p].turn_count;
        let mut r2 = Rng::new(rng.state);
        let sv = self.survey_plans(real, legal, &mut r2, pk.extra)?;
        if sv.lethal || sv.plans.len() < 2 {
            return None;
        }
        let ai = sv.plans.iter().position(|x| x.chosen)?;
        let seed = r2.int(u32::MAX as usize) as u32;
        let n = sv.plans.len();
        let play =
            |c: usize, r: u32| crate::runner::survey::playout(real, p, &sv.plans[c].steps, seed, r);
        let win = |c: char| match c {
            '1' => Some(1.0),
            '0' => Some(0.0),
            'd' => Some(0.5),
            _ => None,
        };
        // 同じ回どうしの差（a − b）の平均。打てなかった回は除く
        let diff = |a: &[char], b: &[char]| -> f64 {
            let xs: Vec<f64> = a
                .iter()
                .zip(b)
                .filter_map(|(x, y)| Some(win(*x)? - win(*y)?))
                .collect();
            if xs.is_empty() {
                f64::NAN
            } else {
                xs.iter().sum::<f64>() / xs.len() as f64
            }
        };
        let half = if pk.prune { (pk.m / 2).max(1) } else { pk.m };
        let mut w: Vec<Vec<char>> = vec![Vec::new(); n];
        for r in 0..half {
            for (c, wc) in w.iter_mut().enumerate() {
                wc.push(play(c, r));
            }
        }
        let alive: Vec<bool> = (0..n)
            .map(|c| c == ai || !pk.prune || diff(&w[c], &w[ai]) > 1e-12)
            .collect();
        for r in half..pk.m {
            for (c, wc) in w.iter_mut().enumerate() {
                if alive[c] {
                    wc.push(play(c, r));
                }
            }
        }
        let mut best: Option<(usize, f64)> = None;
        for c in (0..n).filter(|&c| c != ai && alive[c]) {
            let d = diff(&w[c], &w[ai]) * 100.0;
            if d.is_finite() && best.is_none_or(|(_, b)| d > b) {
                best = Some((c, d));
            }
        }
        let (c, d) = best?;
        if d < pk.threshold {
            return None;
        }
        // 替える。並びの各手の後の予想の局面を作り、局面が予想どおりなら続きを打つ（AI が並びを選んだときと同じ）
        let steps = &sv.plans[c].steps;
        let first = steps.first()?.clone();
        if !legal.contains(&first) {
            return None;
        }
        let mut t = real.clone();
        let mut follow = Vec::new();
        for a in steps {
            if matches!(a, Action::EndTurn) || !is_legal(&t, a) {
                break;
            }
            t = apply_legal(&t, a);
            follow.push((a.clone(), Rc::new(t.clone())));
        }
        self.reads[p].clear();
        self.follow_plan(p, follow);
        Some(first)
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
    /// 最初の手ごとの、ターン末の点数の最大（最初の手が出てきた順）
    pub firsts: Vec<(Action, f64)>,
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
        let (pl, terminals, bests) = turn_end_bests(&root, p, &env);
        let scored = SCORED.with(|c| c.get()) - before;
        let firsts: Vec<(Action, f64)> = bests
            .iter()
            .map(|(a, i)| (a.clone(), terminals[*i].value))
            .collect();
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
            firsts,
        })
    }
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
        if self.opts.pick.is_some() {
            if let Some(a) = self.pick_by_playout(real, legal, rng) {
                return a;
            }
        }
        let opts = &self.opts;
        // 判断の乱数の元（sequential_rng でなければ 1 つ取り、ここから用途ごとの乱数を作る。think_with と同じ）
        let base = (!opts.sequential_rng).then(|| rng.int(u32::MAX as usize) as u32);
        if matches!(first, Action::Mulligan { .. }) {
            let _p = prof::scope(Sec::Mulligan);
            let p0 = acting_player(real);
            // マリガンは渡された乱数を進めず、その状態から作った乱数で引き直しを試す（mulligan.rs）
            let mrng = match base {
                Some(b) => purpose_rng(b, purpose::MULLIGAN, 0),
                None => Rng::new(rng.state),
            };
            if opts.mulligan == MulliganMode::Sample {
                let extra = opts.extra_eval.clone().filter(|_| opts.mulligan_net);
                let w = &self.w;
                return sampled_mulligan(real, legal, p0, opts.mulligan_samples, &mrng, |s| {
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
                    sequential_rng: opts.sequential_rng,
                    ..SearchOptions::default()
                };
                let new_policy = move || -> RolloutPolicy {
                    if beam == 0 {
                        let dw = default_w.clone();
                        Box::new(move |s, l, r| choose_greedy(s, l, r, false, &dw))
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
                    &mrng,
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
            return with_purpose_rng(rng, base, purpose::GREEDY, 0, |r| {
                choose_greedy(real, legal, r, false, &self.default_w)
            });
        }
        let p = real
            .pending
            .as_ref()
            .map(|pd| pd.player())
            .unwrap_or(real.active);

        if let Some(l) = with_purpose_rng(rng, base, purpose::LETHAL, 0, |r| {
            self.lethal_action(real, legal, p, r)
        }) {
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
        for i in 0..opts.samples {
            let det = Rc::new(with_purpose_rng(
                rng,
                base,
                purpose::DETERMINIZE,
                i as u32,
                |r| determinize(real, p, r, opts.peek_opp_hand),
            ));
            let plans = with_purpose_rng(rng, base, purpose::PLAN, i as u32, |r| {
                plan_turn(&det, p, &env, r, true)
            });
            for (k, sample) in plans {
                match totals.iter_mut().find(|t| t.action == k) {
                    Some(t) => {
                        t.sum += sample.value;
                        t.count += 1;
                        // 並びは、その手の評価が最も高かったサンプルのものを使う
                        if sample.value > t.plan.value {
                            t.plan = sample;
                        }
                    }
                    None => totals.push(Total {
                        action: k,
                        sum: sample.value,
                        count: 1,
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
            let steps = best.plan.steps.clone();
            let action = best.action.clone();
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
        with_purpose_rng(rng, base, purpose::GREEDY, 0, |r| {
            choose_greedy(real, choices, r, false, &self.default_w)
        })
    }

    fn sequential_rng(&self) -> bool {
        self.opts.sequential_rng
    }
}
