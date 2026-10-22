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
    Combat { attacker: Iid, target: Option<Iid> },
    CombatEnd,
    EndTurn,
    Cleanup,
    StartTurn,
    StartTurnDraw,
    FinishMulligan,
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
        let pl = &mut self.players[p];
        if pl.hand.len() >= HAND_LIMIT {
            pl.graveyard += 1;
            return false;
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
            if self.add_hand_card(p, c) {
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
