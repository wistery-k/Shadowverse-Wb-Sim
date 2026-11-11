//! 運の補正つきの compare（`svwb compare … --luck`。docs/ai-notes.md「運の補正つきの compare」）。
//!
//! 山札から引くたびに、その引きの運 = 引いた後の局面の価値 − 引きうるカード全部（そのときの本当の山札の残り。枚数で重み）で
//! 引いた後の価値の平均 を出し、試合の勝ち負け（1・0）から引く。相手の引きも相手から見て同じに出し、こちらから見ると符号を逆にする。
//! どの引きも、引く前に分かっていることを決めたときの運の見込みは 0 なので、補正した勝ち負けの平均は補正前と同じ（偏らない）。
//! 偏らない条件は「平均を取る分布が本当の分布と同じ」ことだけで、価値はどんな関数でもよい。価値が良いほど、勝ち負けのぶれのうち引きの分を多く消す。
//! 価値は 2 通りを同じ試合で出す:
//!
//! - 軽い（light）: 引いた後の局面を、既定の評価（評価関数と学習した補正。手番の側のターンの最初の局面として）で勝つ確率 σ(a × 点数) にする
//! - 重い（heavy）: 引いた側の手番なら、drawSplit と同じく、引いた後の局面からターン末までを幅 8 のビームで組み直し（決定化はしない）、
//!   最善のターン末の点数を勝つ確率にする。引いた側の手番でなければ軽いものと同じ
//!
//! 補正する引きは、1 つの手で、ある席の山札の一番上から k 枚が手札に入り、山札の残りの並びが変わらなかったものだけ（席ごとに 1 つと数える）。
//! 条件つきの引き（引いたカードに条件の印が付く）・山札を混ぜ直す手（マリガン等）・山札から場に出す・手札が上限で墓場へ行った引きは飛ばす。
//! 飛ばすかどうかは手の種類で決まり、どのカードを引いたかにはよらない（よると偏る）。
//!
//! 引きうるカードの局面は、手を打つ前の局面で山札の一番上を種類 x のカード（同じ種類が何枚かあれば、どれかを乱数で選ぶ）と入れ替え、
//! 同じ手を打って作る。こうして作った山札は「一番上が x のときの本当の並び」と同じ分布になる（2 枚目より下も偏らない）。
//! 種類ごとに枚数で重みを付けて平均する。1 枚引く手で、価値が山札の並びを見ないなら（軽い）、平均は正確。
//! 2 枚以上引く手は、2 枚目からは並べ替えたうちの 1 つだけで平均するので、ぶれは残るが偏らない。
//! エンジンの乱数（ランダムな対象等）の運は補正しない。

use crate::ai::search::{SearchAgent, SearchOptions, DEFAULT_DRAW_SPLIT};
use crate::ai::valuenet::{default_value_net, ValuePhase};
use crate::ai::{seed_of, Rng};
use crate::data::CardIdx;
use crate::game::{acting_player, apply_legal};
use crate::state::*;
use std::time::Instant;

/// 引きうるカードのうち、同じ種類の何枚目と入れ替えるかを選ぶ乱数の用途（AI の思考用の乱数の用途 ai::purpose とは別の値）
const LUCK_PURPOSE: u32 = 0x4c55_434b;

/// 価値の出し方の名前（GameLuck の luck・eval_secs の並び）
pub const METHODS: [&str; 2] = [
    "軽い（引いた直後の評価）",
    "重い（ターンを幅 8 で組み直す）",
];

/// 1 試合の引きの運
#[derive(Clone, Default, Debug)]
pub struct GameLuck {
    /// 席 0 から見た運の和（METHODS の順）。席 1 から見た運は符号を逆にしたもの
    pub luck: [f64; 2],
    /// 補正した引き（手と席の組の数）と、補正しなかった山札の変化（マリガン・条件つきの引き等）
    pub draws: u32,
    pub skipped: u32,
    /// 掛かった時間（秒）: 引きうるカードの局面を作る、METHODS ごとの採点
    pub alt_secs: f64,
    pub eval_secs: [f64; 2],
}

/// 手を打つ前後で、席 p の山札がどう変わったか
#[derive(Debug, PartialEq, Eq)]
enum DeckChange {
    /// 変わらない
    Same,
    /// 一番上から k 枚が手札に入り、残りの並びは同じ（補正する）
    Top(usize),
    /// それ以外（補正しない）
    Other,
}

fn deck_change(before: &GameState, after: &GameState, p: PlayerIndex) -> DeckChange {
    let (b, a) = (&before.players[p].deck, &after.players[p].deck);
    if b.len() == a.len() && b.iter().zip(a.iter()).all(|(x, y)| x.iid == y.iid) {
        return DeckChange::Same;
    }
    if a.len() >= b.len() {
        return DeckChange::Other;
    }
    let k = b.len() - a.len();
    if !b[k..].iter().zip(a.iter()).all(|(x, y)| x.iid == y.iid) {
        return DeckChange::Other;
    }
    let hand = &after.players[p].hand;
    let in_hand = b[..k]
        .iter()
        .all(|r| hand.iter().any(|h| h.iid == r.iid && h.drawn_by.is_none()));
    if in_hand {
        DeckChange::Top(k)
    } else {
        DeckChange::Other
    }
}

fn ended_value(s: &GameState, p: PlayerIndex) -> f64 {
    match s.winner {
        Some(w) if w == p => 1.0,
        Some(_) => 0.0,
        None => 0.5,
    }
}

/// 引きの運を採点するもの（既定の評価で採点する。比べる AI の設定にはよらない）
pub struct LuckJudge {
    light: SearchAgent,
    heavy: SearchAgent,
    /// 点数を勝つ確率にする傾き（既定の補正の a）
    a: f64,
}

impl Default for LuckJudge {
    fn default() -> Self {
        LuckJudge::new()
    }
}

impl LuckJudge {
    pub fn new() -> LuckJudge {
        LuckJudge {
            light: SearchAgent::new(SearchOptions::default()),
            heavy: SearchAgent::new(SearchOptions {
                beam_width: DEFAULT_DRAW_SPLIT.beam_width,
                max_depth: DEFAULT_DRAW_SPLIT.max_depth,
                draw_split: None,
                potential: None,
                ..SearchOptions::default()
            }),
            a: default_value_net().a(),
        }
    }

    fn prob(&self, v: f64) -> f64 {
        1.0 / (1.0 + (-self.a * v).exp())
    }

    /// 局面 s の、席 p の勝つ確率（軽い）。手番の側のターンの最初の局面として採点する
    pub fn light_value(&self, s: &GameState, p: PlayerIndex) -> f64 {
        if s.phase == Phase::Ended {
            return ended_value(s, p);
        }
        let q = s.active;
        let x = self.prob(self.light.state_value(s, q, ValuePhase::After));
        if q == p {
            x
        } else {
            1.0 - x
        }
    }

    /// 局面 s の、席 p の勝つ確率（重い）。p の手番なら、ターン末までを組み直した最善のターン末の点数から。そうでなければ軽いもの
    pub fn heavy_value(&self, s: &GameState, p: PlayerIndex) -> f64 {
        if s.phase == Phase::Ended {
            return ended_value(s, p);
        }
        if s.phase == Phase::Main && s.active == p && acting_player(s) == p {
            if let Some(v) = self.heavy.best_turn_end_value(s, p) {
                return self.prob(v);
            }
        }
        self.light_value(s, p)
    }

    fn value(&self, m: usize, s: &GameState, p: PlayerIndex) -> f64 {
        if m == 0 {
            self.light_value(s, p)
        } else {
            self.heavy_value(s, p)
        }
    }

    /// 席 p の引きの運（METHODS の順。p から見た値）。before で action を打って after になり、p の山札の一番上から引いたとき。
    /// key は、引きうるカードのうち同じ種類の何枚目と入れ替えるかを選ぶ乱数の種
    pub fn draw_luck(
        &self,
        before: &GameState,
        action: &Action,
        after: &GameState,
        p: PlayerIndex,
        key: u32,
        out: &mut GameLuck,
    ) -> [f64; 2] {
        let deck = &before.players[p].deck;
        let n = deck.len();
        // 種類ごとの山札の位置（種類はカードの番号の順）
        let mut kinds: Vec<(CardIdx, Vec<usize>)> = Vec::new();
        for (i, r) in deck.iter().enumerate() {
            match kinds.iter_mut().find(|(c, _)| *c == r.card) {
                Some(e) => e.1.push(i),
                None => kinds.push((r.card, vec![i])),
            }
        }
        kinds.sort_by_key(|(c, _)| *c);
        let mut rng = Rng::new(key);
        let t0 = Instant::now();
        // (枚数, 引いた後の局面。入れ替えなかった（一番上のまま）なら None で after と同じ)
        let alts: Vec<(f64, Option<GameState>)> = kinds
            .iter()
            .map(|(_, pos)| {
                let j = pos[rng.int(pos.len())];
                if j == 0 {
                    return (pos.len() as f64, None);
                }
                let mut s = before.clone();
                s.players[p].deck.make_mut().swap(0, j);
                (pos.len() as f64, Some(apply_legal(&s, action)))
            })
            .collect();
        out.alt_secs += t0.elapsed().as_secs_f64();
        let mut luck = [0.0; 2];
        for (m, l) in luck.iter_mut().enumerate() {
            let t = Instant::now();
            let actual = self.value(m, after, p);
            let mean = alts
                .iter()
                .map(|(w, s)| {
                    w * match s {
                        Some(s) => self.value(m, s, p),
                        None => actual,
                    }
                })
                .sum::<f64>()
                / n as f64;
            *l = actual - mean;
            out.eval_secs[m] += t.elapsed().as_secs_f64();
        }
        luck
    }

    /// before で action を打って after になった手の引きの運を、席 0 から見て out に足す（seed は試合のシード、step は試合の何手目か）
    pub fn add_step(
        &self,
        before: &GameState,
        action: &Action,
        after: &GameState,
        seed: u32,
        step: u32,
        out: &mut GameLuck,
    ) {
        for p in 0..2 {
            match deck_change(before, after, p) {
                DeckChange::Same => {}
                DeckChange::Other => out.skipped += 1,
                DeckChange::Top(_) => {
                    let key = seed_of(&[LUCK_PURPOSE, seed, step, p as u32]);
                    let l = self.draw_luck(before, action, after, p, key, out);
                    let sign = if p == 0 { 1.0 } else { -1.0 };
                    for (x, lm) in out.luck.iter_mut().zip(l) {
                        *x += sign * lm;
                    }
                    out.draws += 1;
                }
            }
        }
    }
}

/// 補正した組の集計（METHODS の 1 つ分）
#[derive(Clone, Copy, Debug, Default)]
pub struct LuckStats {
    /// 組の数
    pub pairs: usize,
    /// 補正前の A の勝率と標準誤差（組の勝率のばらつきから）
    pub raw: f64,
    pub raw_se: f64,
    /// 補正後の A の勝率と標準誤差
    pub rate: f64,
    pub se: f64,
    /// 組の運（A から見た 2 試合の運の平均）の平均と標準誤差。補正後 − 補正前 = −mean
    pub mean: f64,
    pub mean_se: f64,
    /// 組の勝率を組の運に回帰した傾き（1 なら価値が勝ち負けの見込みとして釣り合っている）と、その傾きで引いたときの標準誤差（参考）
    pub beta: f64,
    pub beta_se: f64,
    /// 補正後の組の勝率がちょうど 0.5 の組（同じ AI どうしの鏡では全部）
    pub exact_half: usize,
}

fn mean_se(xs: &[f64]) -> (f64, f64) {
    let n = xs.len() as f64;
    let mean = xs.iter().sum::<f64>() / n;
    if n < 2.0 {
        return (mean, f64::NAN);
    }
    let var = xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0);
    (mean, (var / n).sqrt())
}

/// 組（同じ試合番号の 2 試合）ごとの A の勝率と運（A から見た値）から、補正前後の勝率と標準誤差を出す。両方の試合がそろった組だけを数える
pub fn luck_stats(tasks: &[(u32, bool)], won: &[bool], luck_a: &[f64]) -> LuckStats {
    let mut by_game: std::collections::BTreeMap<u32, (u32, f64, f64)> = Default::default();
    for ((&(g, _), &w), &l) in tasks.iter().zip(won).zip(luck_a) {
        let e = by_game.entry(g).or_default();
        e.0 += 1;
        e.1 += w as u32 as f64;
        e.2 += l;
    }
    let pairs: Vec<(f64, f64)> = by_game
        .values()
        .filter(|e| e.0 == 2)
        .map(|e| (e.1 / 2.0, e.2 / 2.0))
        .collect();
    let s: Vec<f64> = pairs.iter().map(|x| x.0).collect();
    let l: Vec<f64> = pairs.iter().map(|x| x.1).collect();
    let c: Vec<f64> = pairs.iter().map(|x| x.0 - x.1).collect();
    let (raw, raw_se) = mean_se(&s);
    let (rate, se) = mean_se(&c);
    let (mean, mean_se_) = mean_se(&l);
    let n = pairs.len() as f64;
    let cov = pairs
        .iter()
        .map(|(a, b)| (a - raw) * (b - mean))
        .sum::<f64>()
        / (n - 1.0);
    let var_l = l.iter().map(|b| (b - mean).powi(2)).sum::<f64>() / (n - 1.0);
    let beta = cov / var_l;
    let cb: Vec<f64> = pairs.iter().map(|x| x.0 - beta * x.1).collect();
    let (_, beta_se) = mean_se(&cb);
    LuckStats {
        pairs: pairs.len(),
        raw,
        raw_se,
        rate,
        se,
        mean,
        mean_se: mean_se_,
        beta,
        beta_se,
        exact_half: c.iter().filter(|&&x| (x - 0.5).abs() < 1e-9).count(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::data;
    use crate::game::{create_game, legal_actions};
    use crate::sim::Chooser;

    /// 両者がマリガンを済ませ、何手か進めた局面で、ターンを終える手の直前
    fn before_end_turn() -> GameState {
        let decks = &data().decks;
        let mut s = create_game([&decks[0].cards, &decks[1].cards], 11);
        let mut pick = Chooser::new(5);
        let mut ends = 0;
        loop {
            let legal = legal_actions(&s);
            let a = &legal[pick.pick(legal.len())];
            if *a == Action::EndTurn {
                ends += 1;
                if ends == 6 {
                    return s;
                }
            }
            s = apply_legal(&s, a);
            assert_ne!(s.phase, Phase::Ended);
        }
    }

    /// ターンを終えると、次の手番の側が山札の一番上から 1 枚引く
    #[test]
    fn end_turn_is_a_top_draw() {
        let s = before_end_turn();
        let after = apply_legal(&s, &Action::EndTurn);
        let q = 1 - s.active;
        assert_eq!(deck_change(&s, &after, q), DeckChange::Top(1));
        assert_eq!(deck_change(&s, &after, s.active), DeckChange::Same);
    }

    /// 一番上のカードの種類ごとに、本当にそれを引いた試合の運を枚数で重みを付けて平均すると 0（1 枚引く手の軽い採点は平均が正確）
    #[test]
    fn light_luck_averages_to_zero_over_the_top_card() {
        let judge = LuckJudge::new();
        let s = before_end_turn();
        let q = 1 - s.active;
        let deck = &s.players[q].deck;
        let mut kinds: Vec<(CardIdx, usize)> = Vec::new();
        for (i, r) in deck.iter().enumerate() {
            if !kinds.iter().any(|(c, _)| *c == r.card) {
                kinds.push((r.card, i));
            }
        }
        assert!(kinds.len() > 3);
        let mut sum = 0.0;
        let mut spread = 0.0f64;
        for &(c, i) in &kinds {
            let mut b = s.clone();
            b.players[q].deck.make_mut().swap(0, i);
            let after = apply_legal(&b, &Action::EndTurn);
            let mut out = GameLuck::default();
            let l = judge.draw_luck(&b, &Action::EndTurn, &after, q, 12, &mut out);
            let w = deck.iter().filter(|r| r.card == c).count() as f64;
            sum += w * l[0];
            spread = spread.max(l[0].abs());
        }
        assert!(spread > 1e-6, "引くカードで価値が変わる");
        assert!(sum.abs() < 1e-9, "重み付きの平均 {sum}");
    }

    /// 同じ局面・同じ手なら、席 0 から見た運は同じ値で、席を入れ替えて見ると符号が逆（鏡の 2 試合で打ち消し合う）
    #[test]
    fn add_step_is_deterministic() {
        let judge = LuckJudge::new();
        let s = before_end_turn();
        let after = apply_legal(&s, &Action::EndTurn);
        let mut x = GameLuck::default();
        let mut y = GameLuck::default();
        judge.add_step(&s, &Action::EndTurn, &after, 7, 30, &mut x);
        judge.add_step(&s, &Action::EndTurn, &after, 7, 30, &mut y);
        assert_eq!(x.luck, y.luck);
        assert_eq!(x.draws, 1);
        assert_eq!(x.skipped, 0);
    }

    #[test]
    fn luck_stats_corrects_pairs() {
        let tasks = [(0, false), (0, true), (1, false), (1, true)];
        let won = [true, true, true, false];
        // 組 0 は運が良かった分（0.2）を引き、組 1 は 1 勝 1 敗で運が打ち消し合う
        let luck = [0.3, 0.1, 0.25, -0.25];
        let st = luck_stats(&tasks, &won, &luck);
        assert_eq!(st.pairs, 2);
        assert!((st.raw - 0.75).abs() < 1e-12);
        assert!((st.mean - 0.1).abs() < 1e-12);
        assert!((st.rate - 0.65).abs() < 1e-12);
        assert_eq!(st.exact_half, 1);
    }
}
