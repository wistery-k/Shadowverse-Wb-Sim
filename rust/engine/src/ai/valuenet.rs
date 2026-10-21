//! 学習した評価の補正（src/ai/valueNet.ts の encodeState・forwardValueNet・valueNetExtraEval）。

use super::aidata::{ai_data, RawValueNet, RawValueNetBoard};
use crate::data::{data, Ability, Kw, AMBUSH, BANE, BARRIER, KEYWORD_NAMES, WARD};
use crate::state::*;
use crate::state_json::ability_json_texts;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::OnceLock;

/// カード・クレストごとの入力の種類。モデルはこの並びの部分列を持つ（足す前のモデルも読める）。
/// 後ろの 4 つは場のフォロワーの攻撃力・体力（カードごとの合計を 5 で割る）。カードの枚数だけでは、
/// バフを受けたナイトと素のナイトを区別できない（docs/ai-notes.md「補正の入力に攻撃力・体力を足す」）
pub const ZONES: [&str; 14] = [
    "myHand",
    "myHandBoost",
    "myBoard",
    "myBoardCountdown",
    "myBoardEvolved",
    "myCrest",
    "oppBoard",
    "oppBoardEvolved",
    "oppCrest",
    "oppHandRevealed",
    "myBoardAtk",
    "myBoardDef",
    "oppBoardAtk",
    "oppBoardDef",
];
/// 数値の入力（ZONES と同じく、モデルはこの並びの部分列を持つ）。
/// "after" より後ろは場のフォロワーの合計とキーワードを持つ数（同上）。
/// 最後の "imagined" は、探索が相手のターンを読んだ後の想像の局面か（ValuePhase::Imagined。docs/ai-notes.md「読みの中の相手のずれを学習で直す」）
pub const SCALARS: [&str; 34] = [
    "myHp",
    "oppHp",
    "myMaxPp",
    "oppMaxPp",
    "myTurn",
    "oppTurn",
    "myPp",
    "myEp",
    "mySep",
    "oppEp",
    "oppSep",
    "myExtraPp",
    "oppExtraPp",
    "myHandSize",
    "oppHandSize",
    "myDeck",
    "oppDeck",
    "myGraveyard",
    "oppGraveyard",
    "after",
    "first",
    "myAtkSum",
    "myDefSum",
    "oppAtkSum",
    "oppDefSum",
    "myWard",
    "oppWard",
    "myBane",
    "oppBane",
    "myBarrier",
    "oppBarrier",
    "myAmbush",
    "oppAmbush",
    "imagined",
];

/// 場のカード 1 枚ごとの数値の入力（場のカードのネットワーク。valueNet.ts の BOARD_FEATURES。モデルはこの並びの部分列を持つ）。
/// 値は自己対戦の書き出しの "b"（td.rs の write_board_card）から valueNet.ts の boardCardInput で作るものと同じ。
/// 9 つのキーワードは KEYWORD_NAMES の順
pub const BOARD_FEATURES: [&str; 19] = [
    "follower",
    "atk",
    "def",
    "damage",
    "evolved",
    "superEvolved",
    "ward",
    "storm",
    "rush",
    "bane",
    "drain",
    "ambush",
    "intimidate",
    "barrier",
    "aura",
    "extraAttacks",
    "cannotAttack",
    "countdown",
    "sigils",
];
/// BOARD_FEATURES の最初のキーワード（ward）の位置
const BOARD_KEYWORD0: usize = 6;

/// names が all の部分列（順番を保つ）なら、all の各項目のモデルでの添字（無ければ None）
fn subsequence_slots<const N: usize>(
    names: &[String],
    all: &[&str; N],
) -> Option<[Option<usize>; N]> {
    let mut slots = [None; N];
    let mut j = 0;
    for (k, n) in names.iter().enumerate() {
        while j < N && all[j] != n {
            j += 1;
        }
        if j == N {
            return None;
        }
        slots[j] = Some(k);
        j += 1;
    }
    Some(slots)
}

/// 評価する局面の種類
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ValuePhase {
    /// 自分のターン末
    End,
    /// 自分のターンの最初（自己対戦で相手が実際に打った後）
    After,
    /// 探索が相手のターンを読んだ後の、自分のターンの最初の想像の局面。入力は After に "imagined" を足したもの
    /// （"imagined" の無いモデルでは After と同じ）
    Imagined,
}

/// 学習した評価の補正のモデル（valueNet.ts の CompiledValueNet）
pub struct ValueNet {
    /// vocab の添字（カード・クレストの添字ごと。vocab に無ければ None）
    vocab_card: Vec<Option<usize>>,
    vocab_crest: Vec<Option<usize>>,
    vocab_len: usize,
    /// ZONES・SCALARS の各項目の、モデルの入力での添字（モデルに無い項目は None）
    zone_slot: [Option<usize>; ZONES.len()],
    scalar_slot: [Option<usize>; SCALARS.len()],
    n_zones: usize,
    hidden: usize,
    w1: Vec<f64>,
    b1: Vec<f64>,
    /// 最初の隠れ層の後に足す隠れ層（重み・バイアス）
    layers: Vec<(Vec<f64>, Vec<f64>)>,
    w2: Vec<f64>,
    b2: f64,
    a: f64,
    c: f64,
    /// 出発点の評価の重み（SEARCH_WEIGHTS のうち変える項目）
    pub base_weights: serde_json::Map<String, serde_json::Value>,
    /// 補正の最初の層の入力のうち、局面から作る入力（encode）の数。場のカードのネットワークの出力はこの後ろに入る
    n_base: usize,
    board: Option<BoardNet>,
}

/// 場のカードのネットワーク（valueNet.ts の CompiledBoard）。場のカード 1 枚ずつを同じ層に通し、最後の層の値（ReLU の後）を
/// 自分の場・相手の場ごとに足して、補正の最初の層の入力の末尾（自分の K 個、相手の K 個）に入れる
struct BoardNet {
    /// BOARD_FEATURES の各項目の、モデルの features での添字
    feature_slot: [Option<usize>; BOARD_FEATURES.len()],
    /// 能力のアドレス → grants での添字
    grant_slot: HashMap<usize, usize>,
    n_grants: usize,
    /// 層（重み・バイアス）。最初の層の入力は vocab のカード・grants・features の順
    layers: Vec<(Vec<f64>, Vec<f64>)>,
    /// 最後の層の大きさ
    out: usize,
}

impl BoardNet {
    fn new(raw: RawValueNetBoard, vocab_len: usize) -> Result<BoardNet, String> {
        let Some(feature_slot) = subsequence_slots(&raw.features, &BOARD_FEATURES) else {
            return Err("ValueNetModel の board.features の並びが今のコードと違います".into());
        };
        let mut last = vocab_len + raw.grants.len() + raw.features.len();
        let mut ok = !raw.layers.is_empty();
        for l in &raw.layers {
            ok &= !l.b.is_empty() && l.w.len() == last * l.b.len();
            last = l.b.len();
        }
        if !ok {
            return Err("ValueNetModel の board の重みの大きさが合いません".into());
        }
        let mut grant_slot = HashMap::new();
        for (a, text) in ability_json_texts() {
            if let Some(k) = raw.grants.iter().position(|g| *g == text) {
                grant_slot.insert(a, k);
            }
        }
        Ok(BoardNet {
            feature_slot,
            grant_slot,
            n_grants: raw.grants.len(),
            layers: raw.layers.into_iter().map(|l| (l.w, l.b)).collect(),
            out: last,
        })
    }

    /// 場のカード 1 枚の入力（疎。valueNet.ts の boardCardInput）
    fn card_input(&self, net: &ValueNet, c: &OnBoard, out: &mut Vec<(usize, f64)>) {
        out.clear();
        let v = net.vocab_len;
        if let Some(k) = net.vocab_card[c.card as usize] {
            out.push((k, 1.0));
        }
        for &a in &c.granted {
            if let Some(&g) = self.grant_slot.get(&(a as *const Ability as usize)) {
                out.push((v + g, 1.0));
            }
        }
        let mut f = [0.0f64; BOARD_FEATURES.len()];
        let b = |x: bool| if x { 1.0 } else { 0.0 };
        if c.is_follower {
            let atk = c.attack_value();
            f[0] = 1.0;
            f[1] = atk as f64 / 5.0;
            f[2] = c.defense as f64 / 5.0;
            f[3] = (c.max_defense - c.defense) as f64 / 5.0;
            f[4] = b(c.evolve == Evolve::Evolved);
            f[5] = b(c.evolve == Evolve::SuperEvolved);
            f[15] = (c.max_attacks - 1) as f64;
            f[16] = b(c.cannot_attack_until.is_some());
        } else {
            f[17] = c.countdown.unwrap_or(0) as f64 / 3.0;
            f[18] = c.sigils.unwrap_or(0) as f64 / 3.0;
        }
        for (i, slot) in f[BOARD_KEYWORD0..BOARD_KEYWORD0 + KEYWORD_NAMES.len()]
            .iter_mut()
            .enumerate()
        {
            *slot = b(c.has_keyword(Kw::one(i as u16)));
        }
        let base = v + self.n_grants;
        for (j, &x) in f.iter().enumerate() {
            if let Some(k) = self.feature_slot[j] {
                if x != 0.0 {
                    out.push((base + k, x));
                }
            }
        }
    }

    /// 自分（p）と相手の場のカードを層に通して足した値（sums[0..K] が自分、sums[K..2K] が相手）
    fn sums(&self, net: &ValueNet, s: &GameState, p: PlayerIndex, buf: &mut BoardBuf) {
        let k = self.out;
        buf.sums.clear();
        buf.sums.resize(2 * k, 0.0);
        for (side, pl) in [p, opponent(p)].into_iter().enumerate() {
            for c in &s.players[pl].board {
                self.card_input(net, c, &mut buf.input);
                let (w0, b0) = &self.layers[0];
                let m = b0.len();
                buf.h.clear();
                buf.h.extend_from_slice(b0);
                for &(i, x) in &buf.input {
                    for (hj, &r) in buf.h.iter_mut().zip(&w0[i * m..i * m + m]) {
                        *hj += x * r;
                    }
                }
                relu(&mut buf.h);
                for (w, b) in &self.layers[1..] {
                    let m = b.len();
                    buf.h2.clear();
                    buf.h2.extend_from_slice(b);
                    for (i, &x) in buf.h.iter().enumerate() {
                        if x == 0.0 {
                            continue;
                        }
                        for (oj, &r) in buf.h2.iter_mut().zip(&w[i * m..i * m + m]) {
                            *oj += x * r;
                        }
                    }
                    relu(&mut buf.h2);
                    std::mem::swap(&mut buf.h, &mut buf.h2);
                }
                for (t, &x) in buf.sums[side * k..side * k + k].iter_mut().zip(&buf.h) {
                    *t += x;
                }
            }
        }
    }
}

fn relu(h: &mut [f64]) {
    for x in h.iter_mut() {
        if *x < 0.0 {
            *x = 0.0;
        }
    }
}

/// 場のカードのネットワークの計算に使う場所
#[derive(Default)]
struct BoardBuf {
    input: Vec<(usize, f64)>,
    h: Vec<f64>,
    h2: Vec<f64>,
    sums: Vec<f64>,
}

impl ValueNet {
    /// モデルを確かめて使える形にする（parseValueNetModel・compileValueNet）
    pub fn new(raw: RawValueNet) -> Result<ValueNet, String> {
        if raw.kind != "td-value-net" || raw.version != 1 {
            return Err("ValueNetModel の kind・version が違います".into());
        }
        let (Some(zone_slot), Some(scalar_slot)) = (
            subsequence_slots(&raw.zones, &ZONES),
            subsequence_slots(&raw.scalars, &SCALARS),
        ) else {
            return Err("ValueNetModel の入力の並びが今のコードと違います".into());
        };
        let n_base = raw.zones.len() * raw.vocab.len() + raw.scalars.len();
        let board = match raw.board {
            Some(b) => Some(BoardNet::new(b, raw.vocab.len())?),
            None => None,
        };
        let n = n_base + board.as_ref().map_or(0, |b| 2 * b.out);
        let mut last = raw.hidden;
        let mut layers_ok = true;
        for l in &raw.layers {
            layers_ok &= !l.b.is_empty() && l.w.len() == last * l.b.len();
            last = l.b.len();
        }
        if raw.w1.len() != n * raw.hidden
            || raw.b1.len() != raw.hidden
            || !layers_ok
            || raw.w2.len() != last
        {
            return Err("ValueNetModel の重みの大きさが合いません".into());
        }
        let d = data();
        let mut vocab_card = vec![None; d.cards.len()];
        let mut vocab_crest = vec![None; d.crests.len()];
        // TypeScript 版は vocab の ID → 添字の Map（同じ ID が 2 つあれば後のもの）
        for (k, id) in raw.vocab.iter().enumerate() {
            if let Some(c) = id.strip_prefix("crest:") {
                if let Some(n) = d.crests.iter().position(|x| x.id == c) {
                    vocab_crest[n] = Some(k);
                }
            } else if let Some(&c) = d.card_by_id.get(id) {
                vocab_card[c as usize] = Some(k);
            }
        }
        Ok(ValueNet {
            vocab_card,
            vocab_crest,
            vocab_len: raw.vocab.len(),
            zone_slot,
            scalar_slot,
            n_zones: raw.zones.len(),
            hidden: raw.hidden,
            w1: raw.w1,
            b1: raw.b1,
            layers: raw.layers.into_iter().map(|l| (l.w, l.b)).collect(),
            w2: raw.w2,
            b2: raw.b2,
            a: raw.a,
            c: raw.c,
            base_weights: raw.base_weights,
            n_base,
            board,
        })
    }

    /// ファイル（npm run td が書き出すモデル）から読む
    pub fn load(path: &str) -> Result<ValueNet, String> {
        let text =
            std::fs::read_to_string(path).map_err(|e| format!("{path} を読めません: {e}"))?;
        let raw: RawValueNet = serde_json::from_str(&text)
            .map_err(|e| format!("{path} は ValueNetModel ではありません: {e}"))?;
        ValueNet::new(raw)
    }

    /// 数値の入力 name（SCALARS の 1 つ）を持つか
    pub fn has_scalar(&self, name: &str) -> bool {
        SCALARS
            .iter()
            .position(|x| *x == name)
            .is_some_and(|j| self.scalar_slot[j].is_some())
    }

    /// 補正が 0 のモデル（出力の重み・バイアスがすべて 0）
    pub fn is_zero(&self) -> bool {
        self.w2.iter().all(|&x| x == 0.0) && self.b2 == 0.0 && self.c == 0.0
    }

    /// 入力（encodeState。添字と値を、最初に現れた順に）。場のカードのネットワークの出力（入力の末尾）は含まない
    /// （自己対戦の書き出しの "x"。学習が "b" から作る）
    pub fn encode(&self, s: &GameState, p: PlayerIndex, phase: ValuePhase) -> Vec<(usize, f64)> {
        let mut acc = Acc(Vec::new());
        encode(self, s, p, phase, &mut acc);
        acc.0
    }

    /// 探索の extraEval（評価の点数の単位の補正。valueNetExtraEval）
    pub fn eval(&self, s: &GameState, p: PlayerIndex, phase: ValuePhase) -> f64 {
        if s.phase == Phase::Ended {
            return 0.0;
        }
        let hn = self.hidden;
        BUF.with(|buf| {
            let (acc, h, h2) = &mut *buf.borrow_mut();
            acc.0.clear();
            encode(self, s, p, phase, acc);
            h.clear();
            h.extend_from_slice(&self.b1);
            for &(i, x) in &acc.0 {
                let row = &self.w1[i * hn..i * hn + hn];
                for (hj, &r) in h.iter_mut().zip(row) {
                    *hj += x * r;
                }
            }
            // 場のカードのネットワークの出力（入力の末尾）
            if let Some(board) = &self.board {
                BOARD_BUF.with(|bb| {
                    let bb = &mut *bb.borrow_mut();
                    board.sums(self, s, p, bb);
                    for (t, &x) in bb.sums.iter().enumerate() {
                        if x == 0.0 {
                            continue;
                        }
                        let i = self.n_base + t;
                        for (hj, &r) in h.iter_mut().zip(&self.w1[i * hn..i * hn + hn]) {
                            *hj += x * r;
                        }
                    }
                });
            }
            for hj in h.iter_mut() {
                if *hj < 0.0 {
                    *hj = 0.0;
                }
            }
            // 足した隠れ層（valueNet.ts の forwardRest と同じ順で足す）
            for (w, b) in &self.layers {
                let m = b.len();
                h2.clear();
                h2.extend_from_slice(b);
                for (i, &x) in h.iter().enumerate() {
                    if x == 0.0 {
                        continue;
                    }
                    for (oj, &r) in h2.iter_mut().zip(&w[i * m..i * m + m]) {
                        *oj += x * r;
                    }
                }
                for oj in h2.iter_mut() {
                    if *oj < 0.0 {
                        *oj = 0.0;
                    }
                }
                std::mem::swap(h, h2);
            }
            let mut z = self.b2;
            for (&hj, &w2) in h.iter().zip(&self.w2) {
                z += hj * w2;
            }
            (self.c + z) / self.a
        })
    }
}

/// 探索 AI の既定の補正（data/value-net.json）
pub fn default_value_net() -> &'static ValueNet {
    static NET: OnceLock<ValueNet> = OnceLock::new();
    NET.get_or_init(|| {
        let net = ValueNet::new(ai_data().value_net.clone()).expect("data/value-net.json");
        assert!(
            net.base_weights.is_empty(),
            "data/value-net.json は baseWeights なしのモデルの想定です"
        );
        net
    })
}

/// 疎な入力（添字と値。TypeScript 版の Map と同じく、最初に現れた順）
struct Acc(Vec<(usize, f64)>);

impl Acc {
    #[inline]
    fn add(&mut self, i: usize, v: f64) {
        match self.0.iter_mut().find(|(k, _)| *k == i) {
            Some(e) => e.1 += v,
            None => self.0.push((i, v)),
        }
    }
    #[inline]
    fn set(&mut self, i: usize, v: f64) {
        match self.0.iter_mut().find(|(k, _)| *k == i) {
            Some(e) => e.1 = v,
            None => self.0.push((i, v)),
        }
    }
}

fn encode(net: &ValueNet, s: &GameState, p: PlayerIndex, phase: ValuePhase, acc: &mut Acc) {
    let v = net.vocab_len;
    let card_k = |c: crate::data::CardIdx| net.vocab_card[c as usize];
    let mut add = |zone: usize, k: Option<usize>, x: f64| {
        if let (Some(z), Some(k)) = (net.zone_slot[zone], k) {
            if x != 0.0 {
                acc.add(z * v + k, x);
            }
        }
    };
    let me = &s.players[p];
    let opp = &s.players[opponent(p)];
    for h in &me.hand {
        add(0, card_k(h.card), 1.0);
        add(1, card_k(h.card), h.boosts.min(10) as f64 / 5.0);
    }
    for c in &me.board {
        add(2, card_k(c.card), 1.0);
        if !c.is_follower {
            if let Some(cd) = c.countdown {
                add(3, card_k(c.card), cd as f64 / 3.0);
            }
        }
        if c.is_follower && c.evolve != Evolve::None {
            add(4, card_k(c.card), 1.0);
        }
    }
    for c in &me.crests {
        add(5, net.vocab_crest[c.crest as usize], 1.0);
    }
    for c in &opp.board {
        add(6, card_k(c.card), 1.0);
        if c.is_follower && c.evolve != Evolve::None {
            add(7, card_k(c.card), 1.0);
        }
    }
    for c in &opp.crests {
        add(8, net.vocab_crest[c.crest as usize], 1.0);
    }
    for h in &opp.hand {
        if h.revealed {
            add(9, card_k(h.card), 1.0);
        }
    }
    // 場のフォロワーの攻撃力・体力と、キーワードを持つ数（自分・相手）
    let mut sums = [[0.0f64; 6]; 2];
    for (side, pl) in [me, opp].into_iter().enumerate() {
        for c in pl.board.iter().filter(|c| c.is_follower) {
            let atk = c.attack_value() as f64 / 5.0;
            let def = c.defense.max(0) as f64 / 5.0;
            add(10 + 2 * side, card_k(c.card), atk);
            add(11 + 2 * side, card_k(c.card), def);
            let t = &mut sums[side];
            t[0] += atk;
            t[1] += def;
            for (j, k) in [WARD, BANE, BARRIER, AMBUSH].into_iter().enumerate() {
                if c.has_keyword(k) {
                    t[2 + j] += 1.0;
                }
            }
        }
    }
    let base = net.n_zones * v;
    let b = |x: bool| if x { 1.0 } else { 0.0 };
    let (m, o) = (&sums[0], &sums[1]);
    let scalars: [f64; SCALARS.len()] = [
        me.leader_hp as f64 / 20.0,
        opp.leader_hp as f64 / 20.0,
        me.max_pp as f64 / 10.0,
        opp.max_pp as f64 / 10.0,
        me.turn_count as f64 / 10.0,
        opp.turn_count as f64 / 10.0,
        me.pp as f64 / 10.0,
        me.ep as f64 / 3.0,
        me.sep as f64 / 2.0,
        opp.ep as f64 / 3.0,
        opp.sep as f64 / 2.0,
        b(me.extra_pp_available),
        b(opp.extra_pp_available),
        me.hand.len() as f64 / 9.0,
        opp.hand.len() as f64 / 9.0,
        me.deck.len() as f64 / 40.0,
        opp.deck.len() as f64 / 40.0,
        me.graveyard.min(30) as f64 / 20.0,
        opp.graveyard.min(30) as f64 / 20.0,
        b(phase != ValuePhase::End),
        b(s.first == p),
        m[0] / 4.0,
        m[1] / 4.0,
        o[0] / 4.0,
        o[1] / 4.0,
        m[2] / 2.0,
        o[2] / 2.0,
        m[3] / 2.0,
        o[3] / 2.0,
        m[4] / 2.0,
        o[4] / 2.0,
        m[5] / 2.0,
        o[5] / 2.0,
        b(phase == ValuePhase::Imagined),
    ];
    for (j, &x) in scalars.iter().enumerate() {
        if let Some(k) = net.scalar_slot[j] {
            if x != 0.0 {
                acc.set(base + k, x);
            }
        }
    }
}

thread_local! {
    static BUF: RefCell<(Acc, Vec<f64>, Vec<f64>)> = const { RefCell::new((Acc(Vec::new()), Vec::new(), Vec::new())) };
    static BOARD_BUF: RefCell<BoardBuf> = RefCell::new(BoardBuf::default());
}

/// 探索の extraEval（既定の補正。評価の点数の単位）
pub fn value_net_eval(s: &GameState, p: PlayerIndex, phase: ValuePhase) -> f64 {
    default_value_net().eval(s, p, phase)
}
