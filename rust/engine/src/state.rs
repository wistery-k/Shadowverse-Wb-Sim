//! ゲーム状態の型と、状態の参照・変更の基本操作（src/engine/types.ts・state.ts・rng.ts の移植）。
//! 複製は `Clone`（TypeScript 版の cloneState）。能力のデータは `'static` の参照で共有する。

use crate::data::*;
use std::collections::VecDeque;
use std::fmt;
use std::ops::Deref;
use std::rc::Rc;

/// 書き換えるときだけ複製する列。探索は局面を 1 手ごとに複製するが、ほとんどの列はその手で変わらないので、
/// 複製では中身を共有し（参照を数えるだけ）、書き換える側が `make_mut` で自分の分を複製する。
/// 読むときは `Vec` と同じ（`Deref`）。中身の比べ方・表示も `Vec` と同じ
#[derive(Clone, PartialEq)]
pub struct Shared<T>(Rc<Vec<T>>);

impl<T> Default for Shared<T> {
    fn default() -> Shared<T> {
        Shared(Rc::new(Vec::new()))
    }
}

impl<T> Deref for Shared<T> {
    type Target = Vec<T>;
    #[inline]
    fn deref(&self) -> &Vec<T> {
        &self.0
    }
}

impl<T: Clone> Shared<T> {
    /// 書き換える（ほかの局面と共有していれば、先に自分の分を複製する）
    #[inline]
    pub fn make_mut(&mut self) -> &mut Vec<T> {
        if Rc::get_mut(&mut self.0).is_none() {
            self.unshare();
        }
        Rc::get_mut(&mut self.0).unwrap()
    }
    /// 共有をやめて自分の分を作る。直後に足すことが多いので、少し余裕を持たせる
    #[cold]
    #[inline(never)]
    fn unshare(&mut self) {
        let mut v = Vec::with_capacity(self.0.len() + 2);
        v.extend_from_slice(&self.0);
        self.0 = Rc::new(v);
    }
    /// 空にする（共有していれば、複製せずに新しい空のものにする）
    pub fn clear(&mut self) {
        if self.0.is_empty() {
            return;
        }
        match Rc::get_mut(&mut self.0) {
            Some(v) => v.clear(),
            None => self.0 = Rc::new(Vec::new()),
        }
    }
    /// 中身の Vec（共有していなければそのまま、していれば複製）
    pub fn into_vec(self) -> Vec<T> {
        Rc::unwrap_or_clone(self.0)
    }
}

impl<T> From<Vec<T>> for Shared<T> {
    fn from(v: Vec<T>) -> Shared<T> {
        Shared(Rc::new(v))
    }
}

impl<T> FromIterator<T> for Shared<T> {
    fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Shared<T> {
        Shared(Rc::new(iter.into_iter().collect()))
    }
}

impl<'a, T> IntoIterator for &'a Shared<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;
    fn into_iter(self) -> std::slice::Iter<'a, T> {
        self.0.iter()
    }
}

impl<T: fmt::Debug> fmt::Debug for Shared<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

pub type Iid = i32;
pub type PlayerIndex = usize;

pub const LEADER_HP: i32 = 20;
pub const INITIAL_HAND: usize = 4;
pub const HAND_LIMIT: usize = 9;
pub const BOARD_LIMIT: usize = 5;
pub const MAX_PP: i32 = 10;
/// リーダーエリアに置けるクレスト（と信仰）の数（docs/rules.md「9. クレスト」）
pub const MAX_LEADER_AREA: usize = 5;
pub const EP: i32 = 2;
pub const SEP: i32 = 2;
pub const EVOLVE_BONUS: i32 = 2;
pub const SUPER_EVOLVE_BONUS: i32 = 3;
pub const EVOLVE_TURN: [i32; 2] = [5, 4];
pub const SUPER_EVOLVE_TURN: [i32; 2] = [7, 6];
pub const EXTRA_PP_REFRESH_TURN: i32 = 6;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CardRef {
    pub iid: Iid,
    pub card: CardIdx,
}

/// 条件付きのドローの条件（相手に分かるのは条件だけ）。コストの条件は解決済みの値
#[derive(Clone, Copy, Debug)]
pub struct DrawHint {
    pub filter: &'static CardFilter,
    pub cost_eq: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct HandCard {
    pub iid: Iid,
    pub card: CardIdx,
    pub cost_mod: i32,
    pub attack_mod: i32,
    pub defense_mod: i32,
    pub boosts: i32,
    pub x: Option<i32>,
    pub keywords: Kw,
    pub fused_kinds: Vec<CardIdx>,
    pub fused_this_turn: bool,
    pub revealed: bool,
    pub drawn_by: Option<DrawHint>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Evolve {
    None,
    Evolved,
    SuperEvolved,
}

/// 場のカード（フォロワーとアミュレットを 1 つの形で持つ。使わない項目は既定値）
#[derive(Clone, Debug)]
pub struct OnBoard {
    pub iid: Iid,
    pub card: CardIdx,
    pub is_follower: bool,
    pub keywords: Kw,
    pub temp_keywords: Kw,
    pub granted: Vec<&'static Ability>,
    pub order: i32,
    // フォロワー
    pub attack: i32,
    pub defense: i32,
    pub max_defense: i32,
    pub temp_attack: i32,
    pub max_attacks: i32,
    pub attacks_this_turn: i32,
    pub entered_turn: i32,
    pub evolve: Evolve,
    pub cannot_attack_until: Option<i32>,
    pub x: Option<i32>,
    /// 能力の「自分のターンごとに1回」を使ったターン番号（能力の添字ごと）
    pub used_once: Vec<(u8, i32)>,
    // アミュレット
    pub countdown: Option<i32>,
    pub sigils: Option<i32>,
    pub acted_this_turn: bool,
}

impl OnBoard {
    #[inline]
    pub fn has_keyword(&self, k: Kw) -> bool {
        self.keywords.has(k) || self.temp_keywords.has(k)
    }
    #[inline]
    pub fn attack_value(&self) -> i32 {
        (self.attack + self.temp_attack).max(0)
    }
    /// カード固有の能力＋付与された能力
    pub fn abilities(&self) -> impl Iterator<Item = &'static Ability> + '_ {
        data().abilities[self.card as usize]
            .abilities
            .iter()
            .chain(self.granted.iter().copied())
    }
}

#[derive(Clone, Debug)]
pub struct CrestInstance {
    pub iid: Iid,
    pub crest: CrestIdx,
    pub countdown: Option<i32>,
    pub order: i32,
    pub used_once: Vec<(u8, i32)>,
}

#[derive(Clone, Copy, Debug)]
pub struct DestroyedRecord {
    pub card: CardIdx,
    pub attack: i32,
    pub defense: i32,
}

/// 手札の伏せた枠に起きた、相手にも分かる出来事（`PlayerState::hand_log`）。ルールには効かない。
/// 相手の AI の決定化が、伏せた手札のスペルブーストの回数等を見込むのに使う（docs/ai-notes/13-2026-11-13.md「伏せた相手の手札のスペルブーストを決定化で見込む」）。
/// 相手には手札の何枚目を出したか分からない（docs/rules.md「手札から出したカードの位置」）ので、記録はどの枠かを持たない。記録に非公開の情報は入れない
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum HandEv {
    /// 伏せたカードが手札に入った。山札の一番上から引いたなら、引く前の山札の枚数（それ以外は 0）
    In { deck: u16 },
    /// 公開されていたカードが伏せた枠になった（そのときのスペルブーストの回数）
    InWith { boosts: u16 },
    /// 伏せたカード card を手札から出した。出したときに相手に見えた中身（コスト・X・攻撃力と体力の変化。
    /// X は能力で使うカードだけ（`X_HIDDEN` は見えない））
    Out {
        card: CardIdx,
        cost: i16,
        x: i16,
        atk: i16,
        def: i16,
    },
    /// 伏せたカードが手札から出た（捨てた・融合の素材・公開された等。中身から回数は分からない）
    OutUnknown,
    /// 伏せたカードが山札に戻った（手札で付いた状態を持ったまま）
    ToDeck,
    /// 公開されていたカードが、スペルブーストの回数 boosts を持ったまま山札に戻った
    ToDeckWith { boosts: u16 },
    /// 手札のカードすべてがスペルブーストされた
    Boost { times: u16 },
    /// 伏せたカードのうち 1 枚（どれかは相手に分からない）がスペルブーストされた
    BoostOne { times: u16 },
    /// 味方のフォロワーが場を離れた（手札にある間に働く能力のきっかけ）
    AllyLeft { times: u16 },
}

/// HandEv::Out の X が見えない・無いとき
pub const X_HIDDEN: i16 = i16::MIN;

fn sat16(v: i32) -> i16 {
    v.clamp(i16::MIN as i32 + 1, i16::MAX as i32) as i16
}

pub fn sat_u16(v: i32) -> u16 {
    v.clamp(0, u16::MAX as i32) as u16
}

impl HandEv {
    /// 伏せたカード h を手札から出したときの記録。show_x は X が相手に見えるか（能力で X を使うカード）
    pub fn out_of(h: &HandCard, show_x: bool) -> HandEv {
        HandEv::Out {
            card: h.card,
            cost: sat16(hand_cost(h)),
            x: match h.x {
                Some(x) if show_x => sat16(x),
                _ => X_HIDDEN,
            },
            atk: sat16(h.attack_mod),
            def: sat16(h.defense_mod),
        }
    }
}

struct LogNode {
    ev: HandEv,
    prev: Option<Rc<LogNode>>,
}

/// 手札の記録（HandEv の並び）。局面の複製で中身を写さないよう、新しいものを先頭にした共有のリストで持つ
#[derive(Clone, Default)]
pub struct HandLog {
    head: Option<Rc<LogNode>>,
    len: u32,
}

impl HandLog {
    /// 1 つ足す（続く Boost・AllyLeft は 1 つにまとめる）
    pub fn push(&mut self, e: HandEv) {
        if let Some(h) = &self.head {
            let merged = match (h.ev, e) {
                (HandEv::Boost { times: a }, HandEv::Boost { times: b }) => Some(HandEv::Boost {
                    times: a.saturating_add(b),
                }),
                (HandEv::AllyLeft { times: a }, HandEv::AllyLeft { times: b }) => {
                    Some(HandEv::AllyLeft {
                        times: a.saturating_add(b),
                    })
                }
                _ => None,
            };
            if let Some(ev) = merged {
                let prev = h.prev.clone();
                self.head = Some(Rc::new(LogNode { ev, prev }));
                return;
            }
        }
        let prev = self.head.take();
        self.head = Some(Rc::new(LogNode { ev: e, prev }));
        self.len += 1;
    }

    pub fn len(&self) -> usize {
        self.len as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// 古いものから順の並び
    pub fn to_vec(&self) -> Vec<HandEv> {
        let mut v = Vec::with_capacity(self.len as usize);
        let mut cur = self.head.as_deref();
        while let Some(n) = cur {
            v.push(n.ev);
            cur = n.prev.as_deref();
        }
        v.reverse();
        v
    }

    pub fn from_events(evs: &[HandEv]) -> HandLog {
        let mut l = HandLog::default();
        for &e in evs {
            l.push(e);
        }
        l
    }
}

impl Drop for HandLog {
    /// 長いリストを再帰せずに捨てる
    fn drop(&mut self) {
        let mut cur = self.head.take();
        while let Some(rc) = cur {
            match Rc::try_unwrap(rc) {
                Ok(mut n) => cur = n.prev.take(),
                Err(_) => break,
            }
        }
    }
}

impl PartialEq for HandLog {
    fn eq(&self, other: &HandLog) -> bool {
        self.len == other.len && self.to_vec() == other.to_vec()
    }
}

impl fmt::Debug for HandLog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.to_vec()).finish()
    }
}

#[derive(Clone, Debug)]
pub struct PlayerState {
    pub leader_hp: i32,
    pub leader_max_hp: i32,
    pub max_pp: i32,
    pub pp: i32,
    pub ep: i32,
    pub sep: i32,
    pub extra_pp_available: bool,
    pub turn_count: i32,
    pub deck: Shared<CardRef>,
    /// 手札から山札に戻ったカードの、手札で付いた状態（スペルブーストの回数・コスト変化等）。
    /// 山札のカードと iid で対応し、引いたときにこの状態のまま手札に戻る。状態の変わっていないカードは持たない
    pub deck_kept: Vec<HandCard>,
    pub hand: Shared<HandCard>,
    pub board: Shared<OnBoard>,
    pub crests: Shared<CrestInstance>,
    pub graveyard: i32,
    pub graveyard_followers: Shared<CardIdx>,
    pub destroyed_amulets: Shared<CardIdx>,
    /// 手札から捨てたカードのうち、相手にはどのカードか分からないもの。ルールには影響しない。
    /// 相手の AI の determinization で、伏せた手札・山札と合わせて並べ直す
    pub hidden_discards: Shared<CardIdx>,
    /// 手札の伏せた枠に起きた、相手にも分かる出来事の記録（`HandEv`）。ルールには影響しない。相手の AI の決定化だけが使う
    pub hand_log: HandLog,
    pub destroyed_this_turn: Shared<DestroyedRecord>,
    pub combo: i32,
    pub evolved_this_turn: bool,
    pub ep_evolved_this_turn: Option<CardIdx>,
    pub sep_evolved_this_turn: Option<CardIdx>,
    pub mulligan_done: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Mulligan,
    Main,
    Ended,
}

/// 能力の解決中の文脈
#[derive(Clone, Debug, Default)]
pub struct Ctx {
    pub controller: PlayerIndex,
    pub source: Iid,
    pub event: Option<Iid>,
    pub slots: Vec<(SlotId, Vec<Iid>)>,
    pub vars: Vec<(VarId, i32)>,
    pub enhanced: bool,
    pub source_x: Option<i32>,
    pub source_attack: i32,
}

impl Ctx {
    pub fn new(controller: PlayerIndex, source: Iid) -> Ctx {
        Ctx {
            controller,
            source,
            ..Ctx::default()
        }
    }
    pub fn slot(&self, s: SlotId) -> &[Iid] {
        self.slots
            .iter()
            .find(|(k, _)| *k == s)
            .map(|(_, v)| v.as_slice())
            .unwrap_or(&[])
    }
    pub fn set_slot(&mut self, s: SlotId, v: Vec<Iid>) {
        match self.slots.iter_mut().find(|(k, _)| *k == s) {
            Some(e) => e.1 = v,
            None => self.slots.push((s, v)),
        }
    }
    pub fn var(&self, v: VarId) -> i32 {
        self.vars
            .iter()
            .find(|(k, _)| *k == v)
            .map(|(_, x)| *x)
            .unwrap_or(0)
    }
    pub fn set_var(&mut self, v: VarId, x: i32) {
        match self.vars.iter_mut().find(|(k, _)| *k == v) {
            Some(e) => e.1 = x,
            None => self.vars.push((v, x)),
        }
    }
}

/// 解決スタックの効果（能力の DSL か、エンジン内部の処理）
#[derive(Clone, Copy, Debug)]
pub enum FEff {
    Dsl(&'static Effect),
    Combat {
        attacker: Iid,
        target: Option<Iid>,
    },
    CombatEnd,
    EndTurn,
    Cleanup,
    StartTurn,
    StartTurnDraw,
    FinishMulligan,
    /// プレイしたスペルによる手札のスペルブースト（スペルの効果の後。docs/rules.md 11 章「スペルブーストのタイミング」）
    SpellBoost,
}

/// フレームの効果の並び。能力の効果はデータをそのまま指す（解決のたびに並びを作らない）
#[derive(Clone, Debug)]
pub enum Effects {
    /// 能力の効果（FEff::Dsl の並びと同じ）
    Dsl(&'static [Effect]),
    /// エンジン内部の処理 1〜2 個（先頭の n 個）
    Internal([FEff; 2], u8),
    List(Vec<FEff>),
}

impl Effects {
    #[inline]
    pub fn len(&self) -> usize {
        match self {
            Effects::Dsl(e) => e.len(),
            Effects::Internal(_, n) => *n as usize,
            Effects::List(v) => v.len(),
        }
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// i 番目の効果（範囲外なら panic）
    #[inline]
    pub fn get(&self, i: usize) -> FEff {
        match self {
            Effects::Dsl(e) => FEff::Dsl(&e[i]),
            Effects::Internal(a, n) => a[..*n as usize][i],
            Effects::List(v) => v[i],
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = FEff> + '_ {
        (0..self.len()).map(|i| self.get(i))
    }
    /// エンジン内部の処理の並び
    pub fn internal(list: &[FEff]) -> Effects {
        match *list {
            [a] => Effects::Internal([a, FEff::CombatEnd], 1),
            [a, b] => Effects::Internal([a, b], 2),
            _ => Effects::List(list.to_vec()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Frame {
    pub effects: Effects,
    pub pc: usize,
    pub ctx: Ctx,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Pending {
    Choose {
        player: PlayerIndex,
        slot: SlotId,
        candidates: Vec<Iid>,
        count: usize,
    },
    Mode {
        player: PlayerIndex,
        options: usize,
    },
}

impl Pending {
    pub fn player(&self) -> PlayerIndex {
        match self {
            Pending::Choose { player, .. } | Pending::Mode { player, .. } => *player,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Queued {
    pub ability: &'static Ability,
    pub ctx: Ctx,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AttackInProgress {
    pub attacker: Iid,
    pub defender: Iid,
    pub super_evolved: bool,
    pub defender_destroyed: bool,
}

#[derive(Clone, Debug)]
pub struct GameState {
    pub phase: Phase,
    pub players: [PlayerState; 2],
    pub first: PlayerIndex,
    pub active: PlayerIndex,
    pub turn: i32,
    pub winner: Option<PlayerIndex>,
    pub rng: u32,
    pub next_iid: Iid,
    pub next_order: i32,
    pub stack: Vec<Frame>,
    pub queue: VecDeque<Queued>,
    pub pending: Option<Pending>,
    pub attack: Option<AttackInProgress>,
}

/// 攻撃先（None はリーダー）
pub type AttackTarget = Option<Iid>;

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Action {
    Mulligan { player: PlayerIndex, swap: Vec<Iid> },
    Play(Iid),
    Attack { attacker: Iid, target: AttackTarget },
    Evolve(Iid),
    SuperEvolve(Iid),
    Act(Iid),
    Fuse { host: Iid, materials: Vec<Iid> },
    ExtraPp,
    Choose(Vec<Iid>),
    Mode(usize),
    EndTurn,
}

// ---- 乱数（mulberry32） ----

/// 乱数を 1 つ生成し、[0, 1) の値と次の状態を返す
#[inline]
pub fn next_random(state: u32) -> (f64, u32) {
    let next = state.wrapping_add(0x6d2b79f5);
    let mut t = next;
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    (((t ^ (t >> 14)) as f64) / 4294967296.0, next)
}

impl GameState {
    /// [0, n) の整数
    #[inline]
    pub fn rng_int(&mut self, n: usize) -> usize {
        let (v, next) = next_random(self.rng);
        self.rng = next;
        (v * n as f64).floor() as usize
    }
    pub fn shuffle<T>(&mut self, arr: &mut [T]) {
        let mut i = arr.len();
        while i > 1 {
            i -= 1;
            let j = self.rng_int(i + 1);
            arr.swap(i, j);
        }
    }
}

/// 山札から条件付きで引くときの条件
pub type DeckFilter<'a> = &'a dyn Fn(&GameState, &CardRef) -> bool;

// ---- 基本操作 ----

#[inline]
pub fn opponent(p: PlayerIndex) -> PlayerIndex {
    1 - p
}
#[inline]
pub fn leader_id(p: PlayerIndex) -> Iid {
    -(p as Iid + 1)
}
#[inline]
pub fn is_leader(id: Iid) -> bool {
    id < 0
}
#[inline]
pub fn leader_owner(id: Iid) -> PlayerIndex {
    if id == -1 {
        0
    } else {
        1
    }
}

#[inline]
pub fn card(idx: CardIdx) -> &'static Card {
    &data().cards[idx as usize]
}
#[inline]
pub fn abilities_of(idx: CardIdx) -> &'static CardAbilities {
    &data().abilities[idx as usize]
}
pub fn crest_abilities_of(idx: CrestIdx) -> &'static [Ability] {
    data().crest_abilities[idx as usize]
        .as_ref()
        .map(|a| a.abilities.as_slice())
        .unwrap_or(&[])
}

/// 手札のカードに、作り直したときと違う状態（公開・条件付きドローの印を除く）が付いているか
pub fn hand_state_changed(h: &HandCard) -> bool {
    h.cost_mod != 0
        || h.attack_mod != 0
        || h.defense_mod != 0
        || h.boosts != 0
        || h.x != abilities_of(h.card).initial_x
        || h.keywords != Kw::EMPTY
        || !h.fused_kinds.is_empty()
        || h.fused_this_turn
}

/// 条件付きのドローの条件 hint に、カード c が合うか（コストは元のコストで見る）
pub fn hint_matches(c: CardIdx, hint: &DrawHint) -> bool {
    let cd = card(c);
    let f = hint.filter;
    if let Some(t) = f.ctype {
        if cd.ctype != t {
            return false;
        }
    }
    if let Some(t) = f.tribe {
        if !cd.tribes.contains(&t) {
            return false;
        }
    }
    if let Some(cl) = f.class {
        if cd.class != cl {
            return false;
        }
    }
    if let Some(ids) = &f.ids {
        if !ids.contains(&c) {
            return false;
        }
    }
    if let Some(m) = f.cost_max {
        if cd.cost > m {
            return false;
        }
    }
    if let Some(e) = hint.cost_eq {
        if cd.cost != e {
            return false;
        }
    }
    true
}

/// 条件付きのドローの条件が同じか（hint_matches が見る項目で比べる。状態の JSON から読んだ条件は能力のデータとは別の所を指す）
pub fn same_hint(a: &DrawHint, b: &DrawHint) -> bool {
    let (f, g) = (a.filter, b.filter);
    a.cost_eq == b.cost_eq
        && (std::ptr::eq(f, g)
            || (f.ctype == g.ctype
                && f.tribe == g.tribe
                && f.class == g.class
                && f.ids == g.ids
                && f.cost_max == g.cost_max))
}

pub fn hand_cost(h: &HandCard) -> i32 {
    (card(h.card).cost + h.cost_mod).max(0)
}

impl GameState {
    pub fn turn_order(&self) -> [PlayerIndex; 2] {
        [self.active, opponent(self.active)]
    }

    pub fn lose(&mut self, loser: PlayerIndex) {
        if self.phase == Phase::Ended {
            return;
        }
        self.phase = Phase::Ended;
        self.winner = Some(opponent(loser));
        self.stack.clear();
        self.queue.clear();
        self.pending = None;
    }

    /// 両リーダーの体力を確認し、0以下なら決着させる。同時なら手番のプレイヤーの敗北
    pub fn check_leaders(&mut self) {
        let d0 = self.players[0].leader_hp <= 0;
        let d1 = self.players[1].leader_hp <= 0;
        if d0 && d1 {
            self.lose(self.active);
        } else if d0 {
            self.lose(0);
        } else if d1 {
            self.lose(1);
        }
    }

    /// 場のカード (プレイヤー, 添字)
    #[inline]
    pub fn find_board(&self, iid: Iid) -> Option<(PlayerIndex, usize)> {
        for p in 0..2 {
            if let Some(i) = self.players[p].board.iter().position(|c| c.iid == iid) {
                return Some((p, i));
            }
        }
        None
    }

    #[inline]
    pub fn find_follower(&self, iid: Iid) -> Option<(PlayerIndex, usize)> {
        self.find_board(iid)
            .filter(|&(p, i)| self.players[p].board[i].is_follower)
    }

    #[inline]
    pub fn board_card(&self, iid: Iid) -> Option<&OnBoard> {
        self.find_board(iid).map(|(p, i)| &self.players[p].board[i])
    }

    #[inline]
    pub fn board_card_mut(&mut self, iid: Iid) -> Option<&mut OnBoard> {
        self.find_board(iid)
            .map(move |(p, i)| &mut self.players[p].board.make_mut()[i])
    }

    #[inline]
    pub fn follower(&self, iid: Iid) -> Option<&OnBoard> {
        self.board_card(iid).filter(|c| c.is_follower)
    }

    #[inline]
    pub fn find_hand(&self, iid: Iid) -> Option<(PlayerIndex, usize)> {
        for p in 0..2 {
            if let Some(i) = self.players[p].hand.iter().position(|c| c.iid == iid) {
                return Some((p, i));
            }
        }
        None
    }

    #[inline]
    pub fn hand_card(&self, iid: Iid) -> Option<&HandCard> {
        self.find_hand(iid).map(|(p, i)| &self.players[p].hand[i])
    }

    pub fn evolve_turn_reached(&self, p: PlayerIndex) -> bool {
        let order = if p == self.first { 0 } else { 1 };
        self.players[p].turn_count >= EVOLVE_TURN[order]
    }

    pub fn super_evolve_turn_reached(&self, p: PlayerIndex) -> bool {
        let order = if p == self.first { 0 } else { 1 };
        self.players[p].turn_count >= SUPER_EVOLVE_TURN[order]
    }

    pub fn new_iid(&mut self) -> Iid {
        let i = self.next_iid;
        self.next_iid += 1;
        i
    }

    pub fn new_hand_card(&mut self, c: CardIdx, iid: Option<Iid>) -> HandCard {
        let iid = match iid {
            Some(i) => i,
            None => self.new_iid(),
        };
        HandCard {
            iid,
            card: c,
            cost_mod: 0,
            attack_mod: 0,
            defense_mod: 0,
            boosts: 0,
            x: abilities_of(c).initial_x,
            keywords: Kw::EMPTY,
            fused_kinds: Vec::new(),
            fused_this_turn: false,
            revealed: false,
            drawn_by: None,
        }
    }

    /// 手札のカードを p の山札の末尾に戻す（並べ替えは呼ぶ側）。手札で付いた状態は維持する（公開・条件付きドローの印は情報なので消す）
    pub fn return_to_deck(&mut self, p: PlayerIndex, mut h: HandCard) {
        let ev = if h.revealed {
            HandEv::ToDeckWith {
                boosts: sat_u16(h.boosts),
            }
        } else {
            HandEv::ToDeck
        };
        self.players[p].hand_log.push(ev);
        self.players[p].deck.make_mut().push(CardRef {
            iid: h.iid,
            card: h.card,
        });
        h.revealed = false;
        h.drawn_by = None;
        if hand_state_changed(&h) {
            self.players[p].deck_kept.push(h);
        }
    }

    /// p の山札のカード iid の、手札で付いた状態を取り出す（山札から離れるときに呼ぶ）
    pub fn take_kept(&mut self, p: PlayerIndex, iid: Iid) -> Option<HandCard> {
        let kept = &mut self.players[p].deck_kept;
        let i = kept.iter().position(|h| h.iid == iid)?;
        Some(kept.remove(i))
    }

    /// p の山札のカード r のコスト（手札から戻って手札での状態を持つなら、変化したコスト）
    pub fn deck_cost(&self, p: PlayerIndex, r: &CardRef) -> i32 {
        match self.players[p].deck_kept.iter().find(|h| h.iid == r.iid) {
            Some(h) => hand_cost(h),
            None => card(r.card).cost,
        }
    }

    /// 場に出すカードの実体を作る（手札からなら手札での変化を引き継ぐ）
    pub fn new_board_card(&mut self, c: CardIdx, from: Option<&HandCard>) -> OnBoard {
        let cd = card(c);
        let iid = match from {
            Some(h) => h.iid,
            None => self.new_iid(),
        };
        let order = self.next_order;
        self.next_order += 1;
        let keywords = cd
            .keywords
            .with(from.map(|h| h.keywords).unwrap_or_default());
        let mut b = OnBoard {
            iid,
            card: c,
            is_follower: cd.ctype == CardType::Follower,
            keywords,
            temp_keywords: Kw::EMPTY,
            granted: Vec::new(),
            order,
            attack: 0,
            defense: 0,
            max_defense: 0,
            temp_attack: 0,
            max_attacks: 0,
            attacks_this_turn: 0,
            entered_turn: 0,
            evolve: Evolve::None,
            cannot_attack_until: None,
            x: None,
            used_once: Vec::new(),
            countdown: None,
            sigils: None,
            acted_this_turn: false,
        };
        if b.is_follower {
            let defense = (cd.defense + from.map(|h| h.defense_mod).unwrap_or(0)).max(0);
            b.attack = (cd.attack + from.map(|h| h.attack_mod).unwrap_or(0)).max(0);
            b.defense = defense;
            b.max_defense = defense;
            b.max_attacks = cd.max_attacks;
            b.entered_turn = self.turn;
            b.x = from.and_then(|h| h.x).or(abilities_of(c).initial_x);
        } else {
            b.countdown = if cd.ctype == CardType::Amulet {
                cd.countdown
            } else {
                None
            };
            b.sigils = if cd.earth_sigil { Some(1) } else { None };
        }
        b
    }

    /// 手札に加える。上限なら墓場へ。加えたら true
    pub fn add_hand_card(&mut self, p: PlayerIndex, c: HandCard) -> bool {
        self.add_hand_card_from(p, c, 0)
    }

    /// add_hand_card と同じ。伏せたカードなら手札の記録に足す（deck は山札の一番上から引いたときの、引く前の山札の枚数。それ以外は 0）
    fn add_hand_card_from(&mut self, p: PlayerIndex, c: HandCard, deck: usize) -> bool {
        let pl = &mut self.players[p];
        if pl.hand.len() >= HAND_LIMIT {
            pl.graveyard += 1;
            return false;
        }
        if !c.revealed {
            pl.hand_log.push(HandEv::In {
                deck: deck.min(u16::MAX as usize) as u16,
            });
        }
        pl.hand.make_mut().push(c);
        true
    }

    /// 山札から引く。filter 付きは該当カードが無ければ何もしない。山札切れで敗北。引いた手札の iid を返す
    pub fn draw_cards(
        &mut self,
        p: PlayerIndex,
        n: i32,
        filter: Option<DeckFilter>,
        hint: Option<DrawHint>,
    ) -> Vec<Iid> {
        let mut drawn = Vec::new();
        let mut i = 0;
        while i < n && self.phase != Phase::Ended {
            i += 1;
            // 山札の一番上から引くなら、引く前の山札の枚数（手札の記録。山札に戻ったカードを引いた割合を見込むのに使う）
            let top = if filter.is_none() {
                self.players[p].deck.len()
            } else {
                0
            };
            let r = match filter {
                Some(f) => {
                    let idx = self.players[p].deck.iter().position(|r| f(self, r));
                    match idx {
                        Some(idx) => self.players[p].deck.make_mut().remove(idx),
                        None => break,
                    }
                }
                None => {
                    if self.players[p].deck.is_empty() {
                        self.lose(p);
                        break;
                    }
                    self.players[p].deck.make_mut().remove(0)
                }
            };
            let mut c = match self.take_kept(p, r.iid) {
                Some(k) => k,
                None => self.new_hand_card(r.card, Some(r.iid)),
            };
            if hint.is_some() {
                c.drawn_by = hint;
            }
            if self.add_hand_card_from(p, c, top) {
                drawn.push(r.iid);
            }
        }
        drawn
    }

    pub fn can_add_to_board(&self, p: PlayerIndex) -> bool {
        self.players[p].board.len() < BOARD_LIMIT
    }
}

/// orders が昇順でなければ、昇順に並べた添字（安定）
pub fn order_perm(orders: impl Iterator<Item = i32> + Clone) -> Option<Vec<usize>> {
    let mut prev = i32::MIN;
    let mut sorted = true;
    for o in orders.clone() {
        if o < prev {
            sorted = false;
            break;
        }
        prev = o;
    }
    if sorted {
        return None;
    }
    let v: Vec<i32> = orders.collect();
    let mut idx: Vec<usize> = (0..v.len()).collect();
    idx.sort_by_key(|&i| v[i]);
    Some(idx)
}
