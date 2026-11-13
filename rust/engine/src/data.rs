//! カード・クレストのデータと能力の DSL（src/engine/dsl.ts の移植）。
//!
//! `npm run rust-data` が書き出した `data/engine-data.json` をビルド時に埋め込み、最初に使うときに読み込む。
//! カードID・クレストID・タイプ・スロット名・変数名は読み込み時に小さな整数に置き換える。
//! 読み込んだデータは `'static` に置き（プロセスの終わりまで解放しない）、局面からは参照で指す。

use serde::de::{Deserializer, Error as _};
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::OnceLock;

pub type CardIdx = u16;
pub type CrestIdx = u16;
pub type TribeId = u8;
pub type SlotId = u8;
pub type VarId = u8;

// ---- キーワード ----

/// 常在型のキーワードの集合。TypeScript 版の配列と同じく、加えた順を覚えている
/// （評価関数の足し算の順と、局面の同一判定が配列の順に依る）。
/// bits は集合、seq は加えた順のキーワードの番号＋1 を下位から 4 ビットずつ並べたもの
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug, Hash)]
pub struct Kw {
    bits: u16,
    seq: u64,
}

pub const KEYWORD_NAMES: [&str; 9] = [
    "ward",
    "storm",
    "rush",
    "bane",
    "drain",
    "ambush",
    "intimidate",
    "barrier",
    "aura",
];
pub const WARD: Kw = Kw::one(0);
pub const STORM: Kw = Kw::one(1);
pub const RUSH: Kw = Kw::one(2);
pub const BANE: Kw = Kw::one(3);
pub const DRAIN: Kw = Kw::one(4);
pub const AMBUSH: Kw = Kw::one(5);
pub const INTIMIDATE: Kw = Kw::one(6);
pub const BARRIER: Kw = Kw::one(7);
pub const AURA: Kw = Kw::one(8);

impl Kw {
    pub const EMPTY: Kw = Kw { bits: 0, seq: 0 };
    /// 並び順を含めた値（同じ並びのキーワードなら同じ値）
    #[inline]
    pub fn seq(self) -> u64 {
        self.seq
    }
    pub const fn one(i: u16) -> Kw {
        Kw {
            bits: 1 << i,
            seq: i as u64 + 1,
        }
    }
    #[inline]
    pub fn has(self, k: Kw) -> bool {
        self.bits & k.bits != 0
    }
    #[inline]
    pub fn len(self) -> usize {
        self.bits.count_ones() as usize
    }
    /// k のキーワードのうち無いものを、k の順に後ろへ加える
    #[inline]
    pub fn with(self, k: Kw) -> Kw {
        if k.bits & !self.bits == 0 {
            return self;
        }
        let mut r = self;
        for i in k.iter() {
            if r.bits & (1 << i) == 0 {
                r.seq |= (i as u64 + 1) << (4 * r.len());
                r.bits |= 1 << i;
            }
        }
        r
    }
    /// k のキーワードを除く（残りの順は保つ）
    #[inline]
    pub fn without(self, k: Kw) -> Kw {
        if self.bits & k.bits == 0 {
            return self;
        }
        let mut r = Kw::EMPTY;
        for i in self.iter() {
            if k.bits & (1 << i) == 0 {
                r.seq |= (i as u64 + 1) << (4 * r.len());
                r.bits |= 1 << i;
            }
        }
        r
    }
    pub fn is_empty(self) -> bool {
        self.bits == 0
    }
    /// キーワードの番号（KEYWORD_NAMES の添字）を加えた順に
    #[inline]
    pub fn iter(self) -> impl Iterator<Item = u16> {
        let mut s = self.seq;
        std::iter::from_fn(move || {
            if s == 0 {
                return None;
            }
            let i = (s & 15) as u16 - 1;
            s >>= 4;
            Some(i)
        })
    }
    pub fn names(self) -> Vec<&'static str> {
        self.iter().map(|i| KEYWORD_NAMES[i as usize]).collect()
    }
}

fn kw_from_name(name: &str) -> Option<Kw> {
    KEYWORD_NAMES
        .iter()
        .position(|n| *n == name)
        .map(|i| Kw::one(i as u16))
}

impl<'de> Deserialize<'de> for Kw {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum One {
            Name(String),
            List(Vec<String>),
        }
        let names = match One::deserialize(d)? {
            One::Name(n) => vec![n],
            One::List(l) => l,
        };
        let mut k = Kw::EMPTY;
        for n in names {
            k = k.with(
                kw_from_name(&n)
                    .ok_or_else(|| D::Error::custom(format!("未知のキーワード: {n}")))?,
            );
        }
        Ok(k)
    }
}

// ---- 読み込み中の名前の対応表 ----

#[derive(Default)]
struct Interner {
    cards: HashMap<String, CardIdx>,
    crests: HashMap<String, CrestIdx>,
    tribes: Vec<String>,
    slots: Vec<String>,
    vars: Vec<String>,
}

thread_local! {
    static INTERN: RefCell<Interner> = RefCell::new(Interner::default());
}

fn intern(list: &mut Vec<String>, s: &str) -> u8 {
    if let Some(i) = list.iter().position(|x| x == s) {
        return i as u8;
    }
    list.push(s.to_string());
    assert!(list.len() < 256, "名前が多すぎます");
    (list.len() - 1) as u8
}

fn de_card<'de, D: Deserializer<'de>>(d: D) -> Result<CardIdx, D::Error> {
    let s = String::deserialize(d)?;
    INTERN
        .with(|i| i.borrow().cards.get(&s).copied())
        .ok_or_else(|| D::Error::custom(format!("未知のカードID: {s}")))
}

fn de_cards<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<CardIdx>>, D::Error> {
    let v = Option::<Vec<String>>::deserialize(d)?;
    v.map(|list| {
        list.iter()
            .map(|s| {
                INTERN
                    .with(|i| i.borrow().cards.get(s).copied())
                    .ok_or_else(|| D::Error::custom(format!("未知のカードID: {s}")))
            })
            .collect()
    })
    .transpose()
}

fn de_card_list<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<CardIdx>, D::Error> {
    Ok(de_cards(d)?.unwrap_or_default())
}

fn de_crest<'de, D: Deserializer<'de>>(d: D) -> Result<CrestIdx, D::Error> {
    let s = String::deserialize(d)?;
    INTERN
        .with(|i| i.borrow().crests.get(&s).copied())
        .ok_or_else(|| D::Error::custom(format!("未知のクレストID: {s}")))
}

fn de_tribe<'de, D: Deserializer<'de>>(d: D) -> Result<Option<TribeId>, D::Error> {
    let s = Option::<String>::deserialize(d)?;
    Ok(s.map(|s| INTERN.with(|i| intern(&mut i.borrow_mut().tribes, &s))))
}

fn de_tribes<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<TribeId>, D::Error> {
    let v = Vec::<String>::deserialize(d)?;
    Ok(v.iter()
        .map(|s| INTERN.with(|i| intern(&mut i.borrow_mut().tribes, s)))
        .collect())
}

fn de_slot<'de, D: Deserializer<'de>>(d: D) -> Result<SlotId, D::Error> {
    let s = String::deserialize(d)?;
    Ok(INTERN.with(|i| intern(&mut i.borrow_mut().slots, &s)))
}

fn de_opt_slot<'de, D: Deserializer<'de>>(d: D) -> Result<Option<SlotId>, D::Error> {
    let s = Option::<String>::deserialize(d)?;
    Ok(s.map(|s| INTERN.with(|i| intern(&mut i.borrow_mut().slots, &s))))
}

fn de_var<'de, D: Deserializer<'de>>(d: D) -> Result<VarId, D::Error> {
    let s = String::deserialize(d)?;
    Ok(INTERN.with(|i| intern(&mut i.borrow_mut().vars, &s)))
}

fn de_opt_var<'de, D: Deserializer<'de>>(d: D) -> Result<Option<VarId>, D::Error> {
    let s = Option::<String>::deserialize(d)?;
    Ok(s.map(|s| INTERN.with(|i| intern(&mut i.borrow_mut().vars, &s))))
}

/// `{ kind: "costOf", slot }` は変数 `cost:<slot>` を読む（discard が書く）
fn de_cost_var<'de, D: Deserializer<'de>>(d: D) -> Result<VarId, D::Error> {
    let s = String::deserialize(d)?;
    Ok(var_id_now(&format!("cost:{s}")))
}

fn var_id_now(name: &str) -> VarId {
    INTERN.with(|i| intern(&mut i.borrow_mut().vars, name))
}

// ---- DSL ----

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum CardType {
    Follower,
    Spell,
    Amulet,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ClassId {
    Neutral,
    Elf,
    Royal,
    Witch,
    Dragon,
    Nightmare,
    Bishop,
    Nemesis,
}

impl ClassId {
    /// 全部のクラス
    pub const ALL: [ClassId; 8] = [
        ClassId::Neutral,
        ClassId::Elf,
        ClassId::Royal,
        ClassId::Witch,
        ClassId::Dragon,
        ClassId::Nightmare,
        ClassId::Bishop,
        ClassId::Nemesis,
    ];

    pub fn name(self) -> &'static str {
        match self {
            ClassId::Neutral => "neutral",
            ClassId::Elf => "elf",
            ClassId::Royal => "royal",
            ClassId::Witch => "witch",
            ClassId::Dragon => "dragon",
            ClassId::Nightmare => "nightmare",
            ClassId::Bishop => "bishop",
            ClassId::Nemesis => "nemesis",
        }
    }
}

impl CardType {
    pub fn name(self) -> &'static str {
        match self {
            CardType::Follower => "follower",
            CardType::Spell => "spell",
            CardType::Amulet => "amulet",
        }
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    #[serde(rename = "self")]
    Me,
    Opponent,
    Both,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardFilter {
    #[serde(rename = "type")]
    pub ctype: Option<CardType>,
    #[serde(default, deserialize_with = "de_tribe")]
    pub tribe: Option<TribeId>,
    pub class: Option<ClassId>,
    #[serde(default, deserialize_with = "de_cards")]
    pub ids: Option<Vec<CardIdx>>,
    pub cost_max: Option<i32>,
    pub cost_eq: Option<Box<Value>>,
    pub defense_max: Option<i32>,
    pub keyword: Option<Kw>,
    #[serde(default)]
    pub not_evolved: bool,
    #[serde(default)]
    pub exclude_self: bool,
    #[serde(default)]
    pub spellboost: bool,
    #[serde(default)]
    pub earth_sigil: bool,
    /// 「それ以外」: 能力を誘発させたカードを除く
    #[serde(default)]
    pub exclude_event: bool,
    /// 「選んでいない」: スロットのカードを除く
    #[serde(default, deserialize_with = "de_opt_slot")]
    pub exclude_slot: Option<SlotId>,
    /// スロットのカードだけ（「〜を選んだなら」）
    #[serde(default, deserialize_with = "de_opt_slot")]
    pub in_slot: Option<SlotId>,
    pub cost_min: Option<i32>,
    /// このタイプでない
    #[serde(default, deserialize_with = "de_tribe")]
    pub not_tribe: Option<TribeId>,
    /// 進化後（超進化後を含む）
    #[serde(default)]
    pub evolved: bool,
    #[serde(default)]
    pub super_evolved: bool,
    /// 【ラストワード】を持つ（場のカードは今持つ能力、ほかはカードの元の能力で見る）
    #[serde(default)]
    pub last_words: bool,
    /// コストがこのどれか（手札のカードは手札のコスト）
    pub cost_in: Option<Vec<i32>>,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Target {
    This,
    Leader {
        side: Side,
    },
    Board {
        side: Side,
        filter: Option<CardFilter>,
    },
    Hand {
        filter: Option<CardFilter>,
    },
    Slot {
        #[serde(deserialize_with = "de_slot")]
        slot: SlotId,
    },
    Event,
    Union {
        of: Vec<Target>,
    },
    MaxAttack {
        of: Box<Target>,
    },
    /// 体力が最小のリーダー（同じならどちらも）
    LowestHpLeaders,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Stat {
    Attack,
    Defense,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum Value {
    Num(i32),
    Obj(ValueObj),
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ValueObj {
    Var {
        #[serde(deserialize_with = "de_var")]
        name: VarId,
    },
    Count {
        of: Target,
    },
    Combo,
    Sigils,
    ThisAttack,
    CostOf {
        #[serde(deserialize_with = "de_cost_var")]
        slot: VarId,
    },
    ThisX,
    DestroyedThisTurn {
        stat: Stat,
        filter: Option<CardFilter>,
    },
    /// 【自分がカードをプレイしたとき】で、プレイしたカードの元のコスト
    PlayedCost,
    /// -of
    Neg {
        of: Box<Value>,
    },
    /// この信仰に「自分の信仰は「…」を持つ」で付いた能力の数
    FaithStacks,
    /// これをプレイしたときに払ったコスト（Card::paid_cost のカードだけ）
    PaidCost,
    /// このバトル中に場に出た自分の ids のカードの枚数（Card::count_entered のカードだけ数える）
    EnteredCount {
        #[serde(deserialize_with = "de_card_list")]
        ids: Vec<CardIdx>,
    },
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Condition {
    Awakened,
    Combo {
        at_least: i32,
    },
    Enhanced,
    SuperEvolveTurn,
    ThisSuperEvolved,
    HandCount {
        at_most: i32,
    },
    AttackingFollower,
    VarAtLeast {
        #[serde(deserialize_with = "de_var")]
        name: VarId,
        value: i32,
    },
    ThisXAtLeast {
        value: i32,
    },
    MaxPp {
        at_least: i32,
    },
    /// 対象が 1 つ以上ある
    Exists {
        of: Target,
    },
    /// 自分のリーダーの体力が value 以下
    LeaderHpAtMost {
        value: i32,
    },
    /// 自分のリーダーの体力が相手のリーダーの体力より大きい
    LeaderHpAboveOpponent,
    /// これ（場のフォロワー）が進化後（超進化後を含む）
    ThisEvolved,
    /// 対象が value 個以上ある
    CountAtLeast {
        of: Target,
        value: i32,
    },
    /// 【奥義】（10）・【解放奥義】（15）: これをプレイしたときの奥義ゲージが level 以上
    Ougi {
        level: i32,
    },
    /// 【連携_N】: このバトル中に場に出た自分のフォロワーの枚数が at_least 以上
    Link {
        at_least: i32,
    },
    /// value が eq と等しい
    ValueEq {
        value: Value,
        eq: i32,
    },
    /// value が at_least 以上
    ValueAtLeast {
        value: Value,
        at_least: i32,
    },
    /// 自分のターン（能力の持ち主が手番のプレイヤー）
    OwnTurn,
    /// これ（場のフォロワー）に手札で【融合】していた（Card::this_fused のカードだけ覚える）
    ThisFused,
    Not {
        cond: Box<Condition>,
    },
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Duration {
    Permanent,
    EndOfTurn,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum EvolveKind {
    Evolve,
    SuperEvolve,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MaxTag {
    #[serde(rename = "max")]
    Max,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum PpAmount {
    Max(MaxTag),
    Value(Value),
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Effect {
    Choose {
        #[serde(deserialize_with = "de_slot")]
        slot: SlotId,
        from: Target,
        count: i32,
    },
    Random {
        #[serde(deserialize_with = "de_slot")]
        slot: SlotId,
        from: Target,
        count: i32,
    },
    /// all_if を満たすなら、1 つを選ぶのではなくすべて（上から順に）
    Mode {
        options: Vec<Vec<Effect>>,
        all_if: Option<Condition>,
    },
    /// 働くたびに options の 1 つ目から順に 1 つ（最後の次は 1 つ目）。回数はこれ（場のフォロワー）の X で数える
    InOrder {
        options: Vec<Vec<Effect>>,
    },
    Damage {
        target: Target,
        amount: Value,
    },
    Distribute {
        target: Target,
        amount: Value,
    },
    Destroy {
        target: Target,
        #[serde(default, deserialize_with = "de_opt_var")]
        count_var: Option<VarId>,
    },
    Banish {
        target: Target,
    },
    Bounce {
        target: Target,
    },
    Heal {
        target: Target,
        amount: Value,
    },
    SetDefense {
        target: Target,
        value: i32,
    },
    Draw {
        count: Value,
        filter: Option<CardFilter>,
        /// Opponent なら相手が自身のデッキから引く
        side: Option<Side>,
    },
    DrawAll {
        filter: CardFilter,
        #[serde(default, deserialize_with = "de_opt_slot")]
        slot: Option<SlotId>,
    },
    AddToHand {
        #[serde(deserialize_with = "de_card")]
        card_id: CardIdx,
        count: Value,
        #[serde(default, deserialize_with = "de_opt_slot")]
        slot: Option<SlotId>,
    },
    Summon {
        #[serde(deserialize_with = "de_card")]
        card_id: CardIdx,
        count: Value,
        #[serde(default, deserialize_with = "de_opt_slot")]
        slot: Option<SlotId>,
        /// Opponent なら相手の場に出す
        side: Option<Side>,
    },
    SummonCopy {
        #[serde(deserialize_with = "de_slot")]
        from: SlotId,
        #[serde(default, deserialize_with = "de_opt_slot")]
        slot: Option<SlotId>,
    },
    Reanimate {
        cost: i32,
    },
    SummonFromDeck {
        filter: CardFilter,
        kinds: i32,
    },
    SummonDestroyedAmulet,
    /// 破壊された自分のアミュレット（filter に合うもの）からランダム count 枚（distinct なら count 種類）と同名のカードを場に出す。
    /// 破壊された回数に比例した確率で選ぶ
    SummonDestroyedAmulets {
        filter: CardFilter,
        count: i32,
        distinct: bool,
    },
    ReturnToDeck {
        target: Target,
    },
    /// カードを生成して自分のデッキのランダムな位置に加える
    AddToDeck {
        #[serde(deserialize_with = "de_card")]
        card_id: CardIdx,
        count: Value,
    },
    Discard {
        target: Target,
    },
    Transform {
        target: Target,
        #[serde(deserialize_with = "de_card")]
        card_id: CardIdx,
    },
    Buff {
        target: Target,
        attack: Value,
        defense: Value,
        duration: Option<Duration>,
    },
    Grant {
        target: Target,
        keywords: Option<Kw>,
        max_attacks: Option<i32>,
        abilities: Option<Vec<Ability>>,
        duration: Option<Duration>,
    },
    LoseKeyword {
        target: Target,
        keyword: Kw,
    },
    CannotAttack {
        target: Target,
        #[allow(dead_code)]
        until: String,
    },
    Evolve {
        target: Target,
        kind: EvolveKind,
    },
    Spellboost {
        target: Target,
        times: i32,
    },
    CostChange {
        target: Target,
        amount: i32,
    },
    /// 手札のカードのコストを cost にする
    SetCost {
        target: Target,
        cost: i32,
    },
    AddX {
        target: Target,
        amount: i32,
    },
    Countdown {
        target: Target,
        amount: i32,
    },
    GainPp {
        amount: PpAmount,
    },
    AddMaxPp {
        amount: i32,
    },
    /// 自分のEPを amount 回復（上限は試合の始めの EP）
    GainEp {
        amount: i32,
    },
    AddCombo {
        amount: i32,
    },
    AddGraveyard {
        amount: i32,
    },
    AddSigils {
        amount: Value,
    },
    EarthRite {
        amount: i32,
        then: Vec<Effect>,
    },
    Necromancy {
        amount: i32,
        then: Vec<Effect>,
    },
    Crest {
        #[serde(deserialize_with = "de_crest")]
        crest_id: CrestIdx,
        side: Side,
    },
    ApocalypseDeck,
    /// クレストすべてを消滅（信仰は消えない）
    BanishCrests {
        side: Side,
    },
    /// 自分の信仰 crest_id の信仰値を amount 増やす
    AddFaith {
        #[serde(deserialize_with = "de_crest")]
        crest_id: CrestIdx,
        amount: i32,
    },
    /// 自分の信仰 crest_id の信仰値が amount 以上なら、amount 減らして then を行う
    SpendFaith {
        #[serde(deserialize_with = "de_crest")]
        crest_id: CrestIdx,
        amount: i32,
        then: Vec<Effect>,
    },
    /// 自分の信仰 crest_id は「…」を持つ（付いた回数を数える）
    GrantFaith {
        #[serde(deserialize_with = "de_crest")]
        crest_id: CrestIdx,
    },
    /// 自分のデッキの filter に合うカードすべては +attack/+defense する
    BuffDeck {
        filter: CardFilter,
        attack: i32,
        defense: i32,
    },
    /// options からランダムに 1 つ
    RandomOption {
        options: Vec<Vec<Effect>>,
    },
    /// 【ラストワード】を失う
    LoseLastWords {
        target: Target,
    },
    /// 場のカードを消滅して、そのコピー（受けたダメージ・かかっている効果を引き継ぐ）を自分の場に出す
    BanishCopy {
        target: Target,
    },
    /// 自分の PP が amount 以上なら、amount 消費して then を行う
    SpendPp {
        amount: i32,
        then: Vec<Effect>,
    },
    /// 相手のターン終了まで、自分のリーダーは「受ける1以上のダメージを0にする。」を持つ
    LeaderDamageZero {
        #[allow(dead_code)]
        until: String,
    },
    SetLeaderMaxHp {
        side: Side,
        value: i32,
    },
    /// リーダーの体力の最大値を増減する（体力は最大値まで下がる）
    AddLeaderMaxHp {
        side: Side,
        amount: i32,
    },
    If {
        cond: Condition,
        then: Vec<Effect>,
        #[serde(rename = "else")]
        otherwise: Option<Vec<Effect>>,
    },
    Repeat {
        times: Value,
        effects: Vec<Effect>,
    },
    SetVar {
        #[serde(deserialize_with = "de_var")]
        name: VarId,
        value: Value,
    },
}

impl Effect {
    /// 効果の種類の名前（網羅の確認用）
    pub fn op_name(&self) -> &'static str {
        match self {
            Effect::Choose { .. } => "Choose",
            Effect::Random { .. } => "Random",
            Effect::Mode { .. } => "Mode",
            Effect::InOrder { .. } => "InOrder",
            Effect::Damage { .. } => "Damage",
            Effect::Distribute { .. } => "Distribute",
            Effect::Destroy { .. } => "Destroy",
            Effect::Banish { .. } => "Banish",
            Effect::Bounce { .. } => "Bounce",
            Effect::Heal { .. } => "Heal",
            Effect::SetDefense { .. } => "SetDefense",
            Effect::Draw { .. } => "Draw",
            Effect::DrawAll { .. } => "DrawAll",
            Effect::AddToHand { .. } => "AddToHand",
            Effect::Summon { .. } => "Summon",
            Effect::SummonCopy { .. } => "SummonCopy",
            Effect::Reanimate { .. } => "Reanimate",
            Effect::SummonFromDeck { .. } => "SummonFromDeck",
            Effect::SummonDestroyedAmulet => "SummonDestroyedAmulet",
            Effect::SummonDestroyedAmulets { .. } => "SummonDestroyedAmulets",
            Effect::ReturnToDeck { .. } => "ReturnToDeck",
            Effect::AddToDeck { .. } => "AddToDeck",
            Effect::Discard { .. } => "Discard",
            Effect::Transform { .. } => "Transform",
            Effect::Buff { .. } => "Buff",
            Effect::Grant { .. } => "Grant",
            Effect::LoseKeyword { .. } => "LoseKeyword",
            Effect::CannotAttack { .. } => "CannotAttack",
            Effect::Evolve { .. } => "Evolve",
            Effect::Spellboost { .. } => "Spellboost",
            Effect::CostChange { .. } => "CostChange",
            Effect::SetCost { .. } => "SetCost",
            Effect::AddX { .. } => "AddX",
            Effect::Countdown { .. } => "Countdown",
            Effect::GainPp { .. } => "GainPp",
            Effect::AddMaxPp { .. } => "AddMaxPp",
            Effect::GainEp { .. } => "GainEp",
            Effect::AddCombo { .. } => "AddCombo",
            Effect::AddGraveyard { .. } => "AddGraveyard",
            Effect::AddSigils { .. } => "AddSigils",
            Effect::EarthRite { .. } => "EarthRite",
            Effect::Necromancy { .. } => "Necromancy",
            Effect::Crest { .. } => "Crest",
            Effect::ApocalypseDeck => "ApocalypseDeck",
            Effect::BanishCrests { .. } => "BanishCrests",
            Effect::AddFaith { .. } => "AddFaith",
            Effect::SpendFaith { .. } => "SpendFaith",
            Effect::GrantFaith { .. } => "GrantFaith",
            Effect::BuffDeck { .. } => "BuffDeck",
            Effect::RandomOption { .. } => "RandomOption",
            Effect::LoseLastWords { .. } => "LoseLastWords",
            Effect::BanishCopy { .. } => "BanishCopy",
            Effect::SpendPp { .. } => "SpendPp",
            Effect::LeaderDamageZero { .. } => "LeaderDamageZero",
            Effect::SetLeaderMaxHp { .. } => "SetLeaderMaxHp",
            Effect::AddLeaderMaxHp { .. } => "AddLeaderMaxHp",
            Effect::If { .. } => "If",
            Effect::Repeat { .. } => "Repeat",
            Effect::SetVar { .. } => "SetVar",
        }
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Whose {
    #[serde(rename = "self")]
    Me,
    Opponent,
}

/// 誘発。AllyPlay は自分が他のカードをプレイしたとき（filter はプレイしたカードの条件。コストは元のコスト。
/// enhanced なら【エンハンス】でプレイしたときだけ）、TurnEndInHand は手札にある間の自分のターン終了時、
/// AllyEvolved は自分のフォロワーが進化したとき（超進化・効果による進化を含む）
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "on",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Trigger {
    Fanfare,
    Spell,
    LastWords,
    Evolve,
    SuperEvolve,
    Evolved,
    Attack,
    Clash,
    TurnStart,
    TurnEnd {
        whose: Whose,
    },
    AllyEnter {
        filter: Option<CardFilter>,
    },
    Enter,
    Act {
        cost: i32,
    },
    AllyAct,
    Fused,
    AllyFuse,
    Spellboost,
    AllyLeaveInHand,
    Discarded,
    AllyDestroyed {
        filter: Option<CardFilter>,
    },
    LeaderHealed,
    AllyPlay {
        filter: Option<CardFilter>,
        #[serde(default)]
        enhanced: bool,
    },
    TurnEndInHand,
    AllyAmuletDestroyed,
    AllyEvolved,
    /// 自分がカードを引いたとき（filter は引いたカードの条件）
    AllyDraw {
        filter: Option<CardFilter>,
    },
    /// 自分のフォロワーが攻撃するとき（filter は攻撃するフォロワーの条件）
    AllyAttack {
        filter: Option<CardFilter>,
    },
}

/// 誘発の種類（Trigger の on だけ）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum On {
    Fanfare,
    Spell,
    LastWords,
    Evolve,
    SuperEvolve,
    Evolved,
    Attack,
    Clash,
    TurnStart,
    TurnEnd,
    AllyEnter,
    Enter,
    Act,
    AllyAct,
    Fused,
    AllyFuse,
    Spellboost,
    AllyLeaveInHand,
    Discarded,
    AllyDestroyed,
    LeaderHealed,
    AllyPlay,
    TurnEndInHand,
    AllyAmuletDestroyed,
    AllyEvolved,
    AllyDraw,
    AllyAttack,
}

impl Trigger {
    pub fn on(&self) -> On {
        match self {
            Trigger::Fanfare => On::Fanfare,
            Trigger::Spell => On::Spell,
            Trigger::LastWords => On::LastWords,
            Trigger::Evolve => On::Evolve,
            Trigger::SuperEvolve => On::SuperEvolve,
            Trigger::Evolved => On::Evolved,
            Trigger::Attack => On::Attack,
            Trigger::Clash => On::Clash,
            Trigger::TurnStart => On::TurnStart,
            Trigger::TurnEnd { .. } => On::TurnEnd,
            Trigger::AllyEnter { .. } => On::AllyEnter,
            Trigger::Enter => On::Enter,
            Trigger::Act { .. } => On::Act,
            Trigger::AllyAct => On::AllyAct,
            Trigger::Fused => On::Fused,
            Trigger::AllyFuse => On::AllyFuse,
            Trigger::Spellboost => On::Spellboost,
            Trigger::AllyLeaveInHand => On::AllyLeaveInHand,
            Trigger::Discarded => On::Discarded,
            Trigger::AllyDestroyed { .. } => On::AllyDestroyed,
            Trigger::LeaderHealed => On::LeaderHealed,
            Trigger::AllyPlay { .. } => On::AllyPlay,
            Trigger::TurnEndInHand => On::TurnEndInHand,
            Trigger::AllyAmuletDestroyed => On::AllyAmuletDestroyed,
            Trigger::AllyEvolved => On::AllyEvolved,
            Trigger::AllyDraw { .. } => On::AllyDraw,
            Trigger::AllyAttack { .. } => On::AllyAttack,
        }
    }
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ability {
    pub trigger: Trigger,
    pub effects: Vec<Effect>,
    #[serde(default)]
    pub once_per_own_turn: bool,
    #[serde(default)]
    pub replaces_evolve: bool,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardAbilities {
    pub abilities: Vec<Ability>,
    #[serde(default)]
    pub banish_on_leave: bool,
    #[serde(default)]
    pub unplayable: bool,
    #[serde(default)]
    pub only_selectable: bool,
    pub initial_x: Option<i32>,
    pub fusion: Option<CardFilter>,
    /// 【守護】を無視して攻撃できる
    #[serde(default)]
    pub ignore_ward: bool,
    #[allow(dead_code)]
    pub unimplemented: Option<String>,
}

// ---- カード ----

/// カードプール（docs/pools/azvaldt.md）。カードの表はスターターのカードを先頭に今の順のまま置き、
/// 前期のローテーションにしか無いカードを後ろに足している（scripts/rust-data-main.ts）
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Pool {
    Starter,
    Azvaldt,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Card {
    pub id: String,
    /// カード名（リノセウス用 AI のルールだけが使う。エンジンは使わない）
    pub name: String,
    #[serde(rename = "type")]
    pub ctype: CardType,
    pub class: ClassId,
    pub cost: i32,
    pub attack: i32,
    pub defense: i32,
    pub countdown: Option<i32>,
    #[serde(deserialize_with = "de_tribes")]
    pub tribes: Vec<TribeId>,
    pub keywords: Kw,
    pub max_attacks: i32,
    pub earth_sigil: bool,
    pub enhance: Option<i32>,
    /// デッキに入れられない生成専用カード
    pub token: bool,
    /// 入っているカードプール（ベーシックと一部のトークンは両方）
    pub pools: Vec<Pool>,
    /// アクセラレート・結晶でプレイしたときの姿（カードの表の番号。docs/rules.md「12」）
    pub alt_play: Option<CardIdx>,
    /// デッキに入れると置かれる信仰（クレストの表の番号）
    pub faith: Option<CrestIdx>,
    /// 能力に【奥義】【解放奥義】を持つ（手札で奥義ゲージを数える）
    #[serde(default)]
    pub ougi: bool,
    /// 能力に【連携】を持つ（デッキに入れると、場に出た自分のフォロワーの枚数を数える）
    #[serde(default)]
    pub link: bool,
    /// 能力が「これのコストがNなら」を見る（プレイしたときに払ったコストを覚える）
    #[serde(default)]
    pub paid_cost: bool,
    /// 能力が「これに【融合】していたなら」を見る（場に出たときに、手札で融合していたかを覚える）
    #[serde(default)]
    pub this_fused: bool,
    /// どれかの能力が「このバトル中に場に出たこのカードの枚数」を見る（場に出るたびに数える）
    #[serde(default)]
    pub count_entered: bool,
}

impl Card {
    pub fn in_pool(&self, pool: Pool) -> bool {
        self.pools.contains(&pool)
    }
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct CrestData {
    pub id: String,
    pub countdown: Option<i32>,
    /// 信仰（クレストではないがリーダーエリアに置く。信仰値を持つ）
    pub faith: bool,
}

pub struct Deck {
    pub key: String,
    pub name: String,
    pub cards: Vec<CardIdx>,
}

pub struct Data {
    pub cards: Vec<Card>,
    /// カードの添字ごとの能力（定義が無ければ空）
    pub abilities: Vec<CardAbilities>,
    pub crests: Vec<CrestData>,
    pub crest_abilities: Vec<Option<CardAbilities>>,
    pub apocalypse_deck: Vec<(CardIdx, i32)>,
    pub decks: Vec<Deck>,
    pub tribe_names: Vec<String>,
    pub slot_names: Vec<String>,
    pub var_names: Vec<String>,
    pub card_by_id: HashMap<String, CardIdx>,
    /// 大地の魔片（【土の印】のトークン）
    pub earth_sigil_token: CardIdx,
    pub var_fused_cost: VarId,
    pub var_fused_kinds: VarId,
    /// 【自分がカードをプレイしたとき】の、プレイしたカードの元のコスト
    pub var_played_cost: VarId,
    /// これをプレイしたときに払ったコスト（Card::paid_cost のカードだけ）
    pub var_paid_cost: VarId,
    /// これをプレイしたときの奥義ゲージ（Card::ougi のカードだけ）
    pub var_ougi: VarId,
    /// 死者・タイプ（リアニメイトで場に出たフォロワーが持つ）
    pub tribe_undead: Option<TribeId>,
}

impl Data {
    pub fn card_idx(&self, id: &str) -> CardIdx {
        *self
            .card_by_id
            .get(id)
            .unwrap_or_else(|| panic!("未知のカードID: {id}"))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawData {
    cards: serde_json::Value,
    crests: serde_json::Value,
    card_abilities: serde_json::Value,
    crest_abilities: serde_json::Value,
    /// 前期のローテーションにしか無いカード・クレストの能力（スターターの能力の後に読む）
    pool_card_abilities: serde_json::Value,
    pool_crest_abilities: serde_json::Value,
    apocalypse_deck: Vec<(String, i32)>,
    decks: Vec<RawDeck>,
}

#[derive(Deserialize)]
struct RawDeck {
    key: String,
    name: String,
    cards: Vec<String>,
}

pub fn load(json: &str) -> Data {
    let raw: RawData = serde_json::from_str(json).expect("engine-data.json を読めません");
    INTERN.with(|i| *i.borrow_mut() = Interner::default());
    let cards: Vec<Card> = serde_json::from_value(raw.cards).expect("cards");
    let crests: Vec<CrestData> = serde_json::from_value(raw.crests).expect("crests");
    let card_by_id: HashMap<String, CardIdx> = cards
        .iter()
        .enumerate()
        .map(|(i, c)| (c.id.clone(), i as CardIdx))
        .collect();
    INTERN.with(|i| {
        let mut i = i.borrow_mut();
        i.cards = card_by_id.clone();
        i.crests = crests
            .iter()
            .enumerate()
            .map(|(n, c)| (c.id.clone(), n as CrestIdx))
            .collect();
    });
    let var_fused_cost = var_id_now("fusedCost");
    let var_fused_kinds = var_id_now("fusedKinds");
    let card_ab: HashMap<String, CardAbilities> =
        serde_json::from_value(raw.card_abilities).unwrap_or_else(|e| panic!("cardAbilities: {e}"));
    let crest_ab: HashMap<String, CardAbilities> = serde_json::from_value(raw.crest_abilities)
        .unwrap_or_else(|e| panic!("crestAbilities: {e}"));
    let mut abilities: Vec<CardAbilities> =
        cards.iter().map(|_| CardAbilities::default()).collect();
    for (id, a) in card_ab {
        abilities[card_by_id[&id] as usize] = a;
    }
    let mut crest_abilities: Vec<Option<CardAbilities>> = crests.iter().map(|_| None).collect();
    for (id, a) in crest_ab {
        let n = crests
            .iter()
            .position(|c| c.id == id)
            .expect("未知のクレスト");
        crest_abilities[n] = Some(a);
    }
    // 前期のローテーションの能力は、スターターの能力を読んだ後に読む（能力の中の名前の番号を、スターターの分は変えないため）
    let pool_card_ab: HashMap<String, CardAbilities> =
        serde_json::from_value(raw.pool_card_abilities)
            .unwrap_or_else(|e| panic!("poolCardAbilities: {e}"));
    let pool_crest_ab: HashMap<String, CardAbilities> =
        serde_json::from_value(raw.pool_crest_abilities)
            .unwrap_or_else(|e| panic!("poolCrestAbilities: {e}"));
    for (id, a) in pool_card_ab {
        let c = card_by_id[&id] as usize;
        assert!(
            abilities[c] == CardAbilities::default(),
            "能力の定義が 2 つあります: {id}"
        );
        abilities[c] = a;
    }
    for (id, a) in pool_crest_ab {
        let n = crests
            .iter()
            .position(|c| c.id == id)
            .expect("未知のクレスト");
        assert!(
            crest_abilities[n].is_none(),
            "クレストの能力の定義が 2 つあります: {id}"
        );
        crest_abilities[n] = Some(a);
    }
    // スターターの能力の後に名前を付ける（スターターの変数の番号を変えないため）
    let var_played_cost = var_id_now("playedCost");
    let var_paid_cost = var_id_now("paidCost");
    let var_ougi = var_id_now("ougi");
    let apocalypse_deck = raw
        .apocalypse_deck
        .iter()
        .map(|(id, n)| (card_by_id[id], *n))
        .collect();
    let decks = raw
        .decks
        .into_iter()
        .map(|d| Deck {
            key: d.key,
            name: d.name,
            cards: d.cards.iter().map(|c| card_by_id[c]).collect(),
        })
        .collect();
    let (tribe_names, slot_names, var_names) = INTERN.with(|i| {
        let i = i.borrow();
        (i.tribes.clone(), i.slots.clone(), i.vars.clone())
    });
    let earth_sigil_token = card_by_id["90031210"];
    let tribe_undead = tribe_names
        .iter()
        .position(|t| t == "死者")
        .map(|i| i as TribeId);
    Data {
        cards,
        abilities,
        crests,
        crest_abilities,
        apocalypse_deck,
        decks,
        tribe_names,
        slot_names,
        var_names,
        card_by_id,
        earth_sigil_token,
        var_fused_cost,
        var_fused_kinds,
        var_played_cost,
        var_paid_cost,
        var_ougi,
        tribe_undead,
    }
}

/// 埋め込んだデータの JSON（局面の JSON の能力を読み書きするときにも使う）
pub const ENGINE_DATA_JSON: &str = include_str!("../data/engine-data.json");

static DATA: OnceLock<&'static Data> = OnceLock::new();

/// 埋め込んだデータ（最初の呼び出しで読み込む）
#[inline]
pub fn data() -> &'static Data {
    DATA.get_or_init(|| Box::leak(Box::new(load(ENGINE_DATA_JSON))))
}
