//! 「AI の考え」: ある局面で AI が比べた手と、その点数の内訳（リプレイの表示用。src/ui/AiThought.tsx）。
//!
//! 探索 AI（SearchAgent::think）は choose_action と同じ乱数の使い方で同じ手を選び、途中で比べた最初の手ごとに
//! 並び・ターン末の点数・相手のターンを読み直した点数と、それぞれの内訳（手で作った評価と、評価に足す項）を返す。

use super::search::ScoreParts;
use crate::state::{Action, GameState, PlayerIndex};

/// 最初の手 1 つについての考え
#[derive(Clone, Debug)]
pub struct ThoughtCandidate {
    pub action: Action,
    /// 並びを打った決定化の局面（Thought::roots の添字）と、その局面からの並び（このターンの終わりまで）
    pub sample: usize,
    pub steps: Vec<Action>,
    /// ターン末の点数（ビームサーチが並びを選んだ点数）
    pub turn_end: ScoreParts,
    /// 相手のターンを読み直した後の点数（読み直した決定化の平均。読み直していなければ None）
    pub read: Option<ScoreParts>,
    /// 読み直した決定化の数
    pub read_count: usize,
    /// 手を選ぶときの値（read にターン末の点数を rescoreMix の割合で混ぜた値の平均から、読み直されなかった決定化の数だけ割り引いたもの。読み直していなければ None）
    pub value: Option<f64>,
    /// 実際の局面で打てる手か
    pub legal: bool,
}

/// ある局面での AI の考え
#[derive(Clone, Debug)]
pub struct Thought {
    pub player: PlayerIndex,
    /// 見つけたリーサルの最初の手（見つければ、並びを比べずにこれを打つ）
    pub lethal: Option<Action>,
    /// 決定化した局面（相手の手札・山札の中身と山札の順番を並べ直したもの。決定化の回数だけ）
    pub roots: Vec<GameState>,
    /// 読み直した手（選ぶときの値の高い順）、続いて読み直さなかった手（ターン末の点数の高い順）
    pub candidates: Vec<ThoughtCandidate>,
    /// 選ぶ手（choose_action と同じ）
    pub chosen: Action,
}
