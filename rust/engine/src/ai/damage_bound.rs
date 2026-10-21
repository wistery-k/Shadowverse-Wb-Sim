//! リーサルの全探索の打ち切りに使う「このターンの残りで相手リーダーに与えうるダメージの上限」。
//!
//! 上限は多めに見積もる（実際に与えられるダメージより小さくはならない）。相手の残り体力がこれより多ければ、
//! その局面から先にリーサルは無いので、全探索はそこで打ち切ってよい。
//!
//! 見積もり方: 手札で出せるかもしれないカード（コストが、増えうる PP を含めて足りるもの）、場のカード、
//! クレストの能力が、誘発しうる回数だけすべて働いたとみなし、顔へのダメージ・攻撃力の増加・疾走や攻撃回数の付与・
//! 召喚・手札に加わるカード・PP の増加を数える。召喚したカードや手札に加わったカードも能力を持つので、
//! 数えたものが増えなくなるまで繰り返す。そのうえで、顔を攻撃できる（できるようになりうる）フォロワーの
//! 攻撃力 × 残りの攻撃回数、増えうる攻撃力、ぶっとばしの回数、能力の顔へのダメージを足す。守護は無視する。
//! 値が局面に依って見積もれない顔へのダメージ、コピーの召喚、自分のフォロワーを手札に戻す効果などがあれば None（打ち切らない）。

use crate::data::*;
use crate::state::*;

/// 見積もれない理由（効果などの名前と、その能力を持つカード）
pub type Why = (&'static str, Option<CardIdx>);

/// 数えたものが増えなくなるまで繰り返す回数の上限
const MAX_ROUNDS: usize = 8;
/// 手札・場に出うるカードの数の上限（これより多くなるなら見積もらない）
const MAX_UNITS: i32 = 80;
/// 掛け算の値の上限（あふれないように）
const CAP: i64 = 10_000;

fn mul(a: i32, b: i32) -> i32 {
    (a as i64 * b as i64).clamp(-CAP, CAP) as i32
}

fn add(a: i32, b: i32) -> i32 {
    (a as i64 + b as i64).clamp(-CAP, CAP) as i32
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Zone {
    Hand,
    Board,
    Entering,
    Crest,
}

/// 能力を持つもの（手札のカード、場のカード、場に出うるカード、クレスト、付与された能力）
struct Unit<'a> {
    mine: bool,
    card: Option<CardIdx>,
    zone: Zone,
    /// 能力は own（カード・クレスト自身のもの）の後に granted（付与されたもの）の順
    own: &'static [Ability],
    granted: &'a [&'static Ability],
    count: i32,
    playable: bool,
    enhance_ok: bool,
    attacks: i32,
    evolvable: bool,
    acted: bool,
    x: Option<i32>,
}

/// 自分のフォロワー（場にいるもの、場に出うるもの）
struct Fol {
    atk: i32,
    attacks: i32,
    face: bool,
    super_evolved: bool,
    count: i32,
}

/// 能力を働かせて数えたもの
#[derive(Clone, Default, PartialEq)]
struct Acc {
    unknown: bool,
    why: &'static str,
    dmg: i32,
    storm_single: i32,
    storm_all: bool,
    extra_single: i32,
    extra_all: i32,
    buff_single: i32,
    buff_all: i32,
    evolves: i32,
    super_evolves: i32,
    summons: Vec<(CardIdx, i32)>,
    opp_summons: i32,
    adds: Vec<(CardIdx, i32)>,
    /// 手札で変身しうるカード
    transforms: Vec<(CardIdx, i32)>,
    /// 場で変身しうるカード（前のターンから場にいたかもしれないので、リーダーを攻撃できるとみなす）
    board_transforms: Vec<(CardIdx, i32)>,
    draws: i32,
    draw_any: bool,
    reshuffle: bool,
    apocalypse: bool,
    pp_gain: i32,
    cost_down: bool,
    sb_events: i32,
    crests: Vec<(CrestIdx, i32)>,
    opp_crests: Vec<(CrestIdx, i32)>,
    granted: Vec<(&'static Ability, i32)>,
    opp_granted: Vec<(&'static Ability, i32)>,
}

impl Acc {
    fn unk(&mut self, why: &'static str) {
        if !self.unknown {
            self.unknown = true;
            self.why = why;
        }
    }
}

impl Acc {
    /// 足し合わせる（両方が起こりうる）
    fn merge_add(&mut self, o: &Acc) {
        if o.unknown {
            self.unk(o.why);
        }
        macro_rules! sum {
            ($($f:ident),*) => { $(self.$f = add(self.$f, o.$f);)* };
        }
        macro_rules! or {
            ($($f:ident),*) => { $(self.$f |= o.$f;)* };
        }
        macro_rules! cat {
            ($($f:ident),*) => { $(for &(k, n) in &o.$f { push(&mut self.$f, k, n); })* };
        }
        sum!(
            dmg,
            storm_single,
            extra_single,
            extra_all,
            buff_single,
            buff_all,
            evolves,
            super_evolves,
            opp_summons,
            draws,
            pp_gain,
            sb_events
        );
        or!(storm_all, draw_any, reshuffle, apocalypse, cost_down);
        cat!(
            summons,
            adds,
            transforms,
            board_transforms,
            crests,
            opp_crests,
            granted,
            opp_granted
        );
    }

    /// 項目ごとに大きいほうをとる（どちらか一方だけが起こる）
    fn merge_max(&mut self, o: &Acc) {
        if o.unknown {
            self.unk(o.why);
        }
        macro_rules! max {
            ($($f:ident),*) => { $(self.$f = self.$f.max(o.$f);)* };
        }
        macro_rules! or {
            ($($f:ident),*) => { $(self.$f |= o.$f;)* };
        }
        macro_rules! top {
            ($($f:ident),*) => { $(
                for &(k, n) in &o.$f {
                    match self.$f.iter_mut().find(|e| e.0 == k) {
                        Some(e) => e.1 = e.1.max(n),
                        None => self.$f.push((k, n)),
                    }
                }
            )* };
        }
        max!(
            dmg,
            storm_single,
            extra_single,
            extra_all,
            buff_single,
            buff_all,
            evolves,
            super_evolves,
            opp_summons,
            draws,
            pp_gain,
            sb_events
        );
        or!(storm_all, draw_any, reshuffle, apocalypse, cost_down);
        top!(
            summons,
            adds,
            transforms,
            board_transforms,
            crests,
            opp_crests,
            granted,
            opp_granted
        );
    }
}

fn push<T: PartialEq>(v: &mut Vec<(T, i32)>, k: T, n: i32) {
    if n <= 0 {
        return;
    }
    match v.iter_mut().find(|e| e.0 == k) {
        Some(e) => e.1 = add(e.1, n),
        None => v.push((k, n)),
    }
}

#[derive(Default)]
struct Counts {
    plays: i32,
    sb: i32,
    hand_units: i32,
    enter_me: i32,
    enter_opp: i32,
    my_fols: i32,
    opp_fols: i32,
    attacks: i32,
    max_attacks: i32,
    acts: i32,
    fuses: i32,
    base_atk: i32,
    e_avail: bool,
    se_avail: bool,
    evolve_effects: i32,
}

#[derive(Clone, Copy)]
enum SlotInfo {
    From(&'static Target, i32),
    Summoned(bool, i32),
}

struct Frame<'u> {
    mine: bool,
    unit: &'u Unit<'u>,
    slots: Vec<(SlotId, SlotInfo)>,
    vars: Vec<(VarId, &'static Value)>,
}

/// 対象の見立て
#[derive(Default, Clone, Copy)]
struct Ti {
    /// 相手（p の相手）のリーダーを含みうる
    enemy_leader: bool,
    /// 自分（p）のフォロワー・手札のうち 1 つずつ選ぶものの数
    my_single: i32,
    /// 自分（p）のフォロワー・手札の全部
    my_all: bool,
    /// 相手（p の相手）のリーダー以外のものを含みうる
    opp_side: bool,
    unknown: bool,
}

impl Ti {
    fn union(self, o: Ti) -> Ti {
        Ti {
            enemy_leader: self.enemy_leader || o.enemy_leader,
            my_single: add(self.my_single, o.my_single),
            my_all: self.my_all || o.my_all,
            opp_side: self.opp_side || o.opp_side,
            unknown: self.unknown || o.unknown,
        }
    }
    fn mine(self) -> bool {
        self.my_all || self.my_single > 0
    }
    /// 全部を 1 つずつ count 個に
    fn single(self, count: i32) -> Ti {
        Ti {
            my_single: if self.mine() { count } else { 0 },
            my_all: false,
            ..self
        }
    }
}

/// side を、能力の持ち主（mine なら p）から見た (p の側を含むか, p の相手の側を含むか) に
fn rel(mine: bool, side: Side) -> (bool, bool) {
    match (side, mine) {
        (Side::Both, _) => (true, true),
        (Side::Me, true) | (Side::Opponent, false) => (true, false),
        (Side::Me, false) | (Side::Opponent, true) => (false, true),
    }
}

/// カード自身のコストを下げる能力（スペルブーストで安くなる 等）で、このターンに下がりうるコスト。
/// sb はスペルブーストされうる回数、leaves は手札から離れうるカードの数
fn self_reduction(c: CardIdx, sb: i32, leaves: i32) -> i32 {
    fn walk(effs: &[Effect]) -> i32 {
        effs.iter()
            .map(|e| match e {
                Effect::CostChange {
                    target: Target::This,
                    amount,
                } => (-*amount).max(0),
                Effect::Mode { options } => options.iter().map(|o| walk(o)).sum(),
                Effect::If {
                    then, otherwise, ..
                } => walk(then) + otherwise.as_ref().map_or(0, |o| walk(o)),
                Effect::Repeat { effects, .. } => {
                    if walk(effects) > 0 {
                        CAP as i32
                    } else {
                        0
                    }
                }
                Effect::EarthRite { then, .. } | Effect::Necromancy { then, .. } => walk(then),
                _ => 0,
            })
            .fold(0, add)
    }
    abilities_of(c).abilities.iter().fold(0, |acc, a| {
        let r = walk(&a.effects);
        if r == 0 {
            return acc;
        }
        let times = match a.trigger.on() {
            On::Spellboost => sb,
            On::AllyLeaveInHand => leaves,
            _ => CAP as i32,
        };
        add(acc, mul(r, times))
    })
}

struct World<'a> {
    units: Vec<Unit<'a>>,
    /// 自分の場にいる・出うるカード（このターンに破壊されて、墓地から戻されうる）
    my_cards: Vec<CardIdx>,
    /// 自分の手札にある・加わりうるカード
    hand_cards: Vec<CardIdx>,
    fols: Vec<Fol>,
    c: Counts,
}

impl<'a> Unit<'a> {
    fn abilities(&self) -> impl Iterator<Item = &'static Ability> + '_ {
        self.own.iter().chain(self.granted.iter().copied())
    }
}

impl<'a> World<'a> {
    fn build(
        s: &'a GameState,
        p: PlayerIndex,
        acc: &'a Acc,
        draws: bool,
    ) -> Result<World<'a>, Why> {
        let pl = &s.players[p];
        let op = &s.players[opponent(p)];
        let pp_max = pl.pp + pl.extra_pp_available as i32 + acc.pp_gain;
        let order = if p == s.first { 0 } else { 1 };
        let mut c = Counts {
            e_avail: !pl.evolved_this_turn && pl.ep > 0 && pl.turn_count >= EVOLVE_TURN[order],
            se_avail: !pl.evolved_this_turn
                && pl.sep > 0
                && pl.turn_count >= SUPER_EVOLVE_TURN[order],
            evolve_effects: add(acc.evolves, acc.super_evolves),
            ..Counts::default()
        };
        let mut units: Vec<Unit<'a>> = Vec::new();
        let mut fols: Vec<Fol> = Vec::new();
        let extra = add(acc.extra_all, acc.extra_single);

        // 手札（今ある・加わりうる・引きうる・変身しうる）
        struct HandItem {
            card: CardIdx,
            cost: i32,
            atk_mod: i32,
            storm: bool,
            x: Option<i32>,
            count: i32,
        }
        let mut hand: Vec<HandItem> = pl
            .hand
            .iter()
            .map(|h| HandItem {
                card: h.card,
                cost: hand_cost(h),
                atk_mod: h.attack_mod,
                storm: h.keywords.has(STORM),
                x: h.x,
                count: 1,
            })
            .collect();
        let base = |card: CardIdx, count: i32| HandItem {
            card,
            cost: crate::state::card(card).cost,
            atk_mod: 0,
            storm: false,
            x: abilities_of(card).initial_x,
            count,
        };
        for &(card, n) in &acc.adds {
            hand.push(base(card, n));
        }
        for &(card, n) in &acc.transforms {
            hand.push(base(card, n));
        }
        if draws && (acc.draws > 0 || acc.draw_any) {
            // 手札を山札に戻して混ぜたら、山札のどのカードでも引きうる
            let n = if acc.draw_any || acc.reshuffle {
                pl.deck.len()
            } else {
                (acc.draws as usize).min(pl.deck.len())
            };
            for r in &pl.deck[..n] {
                let kept = pl.deck_kept.iter().find(|h| h.iid == r.iid);
                hand.push(HandItem {
                    card: r.card,
                    cost: s.deck_cost(p, r),
                    atk_mod: kept.map_or(0, |h| h.attack_mod),
                    storm: kept.is_some_and(|h| h.keywords.has(STORM)),
                    x: kept.map_or(abilities_of(r.card).initial_x, |h| h.x),
                    count: 1,
                });
            }
            if acc.apocalypse {
                for &(card, n) in &data().apocalypse_deck {
                    hand.push(base(card, n.min(acc.draws.max(1))));
                }
            }
        }
        c.hand_units = hand.iter().fold(0, |a, h| add(a, h.count));
        if c.hand_units > MAX_UNITS {
            return Err(("hand_units", None));
        }
        // 出しうるカード（スペルを出すとスペルブーストされて安くなるカードがあるので、増えなくなるまで）
        let mut sb = acc.sb_events;
        let mut playable: Vec<bool> = vec![false; hand.len()];
        for _ in 0..hand.len() + 1 {
            for (i, h) in hand.iter().enumerate() {
                let min_cost = if acc.cost_down {
                    0
                } else {
                    h.cost - self_reduction(h.card, sb, c.hand_units)
                };
                playable[i] = !abilities_of(h.card).unplayable && min_cost <= pp_max;
            }
            let next = hand
                .iter()
                .zip(&playable)
                .filter(|(h, &ok)| ok && crate::state::card(h.card).ctype == CardType::Spell)
                .fold(acc.sb_events, |a, (h, _)| add(a, h.count));
            if next == sb {
                break;
            }
            sb = next;
        }
        c.sb = sb;
        for (h, &playable) in hand.iter().zip(&playable) {
            let cd = crate::state::card(h.card);
            let ab = abilities_of(h.card);
            if playable {
                c.plays = add(c.plays, h.count);
            }
            if ab.fusion.is_some() {
                c.fuses = add(c.fuses, h.count);
            }
            units.push(Unit {
                mine: true,
                card: Some(h.card),
                zone: Zone::Hand,
                own: &ab.abilities,
                granted: &[],
                count: h.count,
                playable,
                enhance_ok: playable && cd.enhance.is_some_and(|e| e <= pp_max),
                attacks: 0,
                evolvable: false,
                acted: false,
                x: h.x,
            });
            if playable && cd.ctype != CardType::Spell {
                let is_f = cd.ctype == CardType::Follower;
                units.push(Unit {
                    mine: true,
                    card: Some(h.card),
                    zone: Zone::Entering,
                    own: &ab.abilities,
                    granted: &[],
                    count: h.count,
                    playable: false,
                    enhance_ok: false,
                    attacks: if is_f { add(cd.max_attacks, extra) } else { 0 },
                    evolvable: is_f,
                    acted: false,
                    x: h.x,
                });
                c.enter_me = add(c.enter_me, h.count);
                if is_f {
                    fols.push(Fol {
                        atk: (cd.attack + h.atk_mod).max(0),
                        attacks: cd.max_attacks,
                        face: cd.keywords.has(STORM) || h.storm,
                        super_evolved: false,
                        count: h.count,
                    });
                    c.base_atk = add(c.base_atk, mul(cd.attack.max(0), h.count));
                } else if abilities_of(h.card)
                    .abilities
                    .iter()
                    .any(|a| matches!(a.trigger, Trigger::Act { .. }))
                {
                    c.acts = add(c.acts, h.count);
                }
            }
        }

        // 場に出うるカード（召喚・変身）
        let entering = acc.summons.iter().map(|&(card, n)| (card, n, false)).chain(
            acc.board_transforms
                .iter()
                .map(|&(card, n)| (card, n, true)),
        );
        for (card, n, transformed) in entering {
            let cd = crate::state::card(card);
            let ab = abilities_of(card);
            let is_f = cd.ctype == CardType::Follower;
            units.push(Unit {
                mine: true,
                card: Some(card),
                zone: Zone::Entering,
                own: &ab.abilities,
                granted: &[],
                count: n,
                playable: false,
                enhance_ok: false,
                attacks: if is_f { add(cd.max_attacks, extra) } else { 0 },
                evolvable: is_f,
                acted: false,
                x: ab.initial_x,
            });
            c.enter_me = add(c.enter_me, n);
            if is_f {
                fols.push(Fol {
                    atk: cd.attack.max(0),
                    attacks: cd.max_attacks,
                    // 変身したフォロワーは前から場にいたかもしれない
                    face: transformed || cd.keywords.has(STORM),
                    super_evolved: false,
                    count: n,
                });
                c.base_atk = add(c.base_atk, mul(cd.attack.max(0), n));
            } else if ab
                .abilities
                .iter()
                .any(|a| matches!(a.trigger, Trigger::Act { .. }))
            {
                c.acts = add(c.acts, n);
            }
        }

        // 自分の場
        for b in &pl.board {
            let mut attacks = 0;
            if b.is_follower {
                let blocked = b.cannot_attack_until.is_some_and(|u| u >= s.turn);
                if !blocked {
                    attacks = (b.max_attacks - b.attacks_this_turn).max(0);
                    fols.push(Fol {
                        atk: b.attack_value(),
                        attacks,
                        face: b.entered_turn != s.turn || b.has_keyword(STORM),
                        super_evolved: b.evolve == Evolve::SuperEvolved,
                        count: 1,
                    });
                    attacks = add(attacks, extra);
                }
                c.base_atk = add(c.base_atk, crate::state::card(b.card).attack.max(0));
            } else if !b.acted_this_turn
                && b.abilities()
                    .any(|a| matches!(a.trigger, Trigger::Act { .. }))
            {
                c.acts += 1;
            }
            units.push(Unit {
                mine: true,
                card: Some(b.card),
                zone: Zone::Board,
                own: &abilities_of(b.card).abilities,
                granted: &b.granted,
                count: 1,
                playable: false,
                enhance_ok: false,
                attacks,
                evolvable: b.is_follower && b.evolve == Evolve::None,
                acted: b.acted_this_turn,
                x: b.x,
            });
        }
        c.my_fols = fols.iter().fold(0, |a, f| add(a, f.count));
        if c.my_fols > MAX_UNITS || c.enter_me > MAX_UNITS {
            return Err(("followers", None));
        }
        c.attacks = fols
            .iter()
            .fold(0, |a, f| add(a, mul(add(f.attacks, extra), f.count)));
        c.max_attacks = fols
            .iter()
            .map(|f| add(f.attacks, extra))
            .max()
            .unwrap_or(0);
        c.enter_opp = acc.opp_summons;
        c.opp_fols = add(
            op.board.iter().filter(|b| b.is_follower).count() as i32,
            acc.opp_summons,
        );

        let crest_unit = |mine: bool, crest: CrestIdx, count: i32| Unit {
            mine,
            card: None,
            zone: Zone::Crest,
            own: crest_abilities_of(crest),
            granted: &[],
            count,
            playable: false,
            enhance_ok: false,
            attacks: 0,
            evolvable: false,
            acted: false,
            x: None,
        };
        let granted_unit = |mine: bool, a: &'a &'static Ability, count: i32, attacks: i32| Unit {
            mine,
            card: None,
            zone: Zone::Board,
            own: &[],
            granted: std::slice::from_ref(a),
            count,
            playable: false,
            enhance_ok: false,
            attacks,
            evolvable: mine,
            acted: false,
            x: None,
        };
        for cr in &pl.crests {
            units.push(crest_unit(true, cr.crest, 1));
        }
        for &(cr, n) in &acc.crests {
            units.push(crest_unit(true, cr, n));
        }
        for (a, n) in &acc.granted {
            units.push(granted_unit(true, a, *n, c.max_attacks));
        }
        // 相手の場・クレスト
        for b in &op.board {
            units.push(Unit {
                mine: false,
                card: Some(b.card),
                zone: Zone::Board,
                own: &abilities_of(b.card).abilities,
                granted: &b.granted,
                count: 1,
                playable: false,
                enhance_ok: false,
                attacks: 0,
                evolvable: false,
                acted: true,
                x: b.x,
            });
        }
        for cr in &op.crests {
            units.push(crest_unit(false, cr.crest, 1));
        }
        for &(cr, n) in &acc.opp_crests {
            units.push(crest_unit(false, cr, n));
        }
        for (a, n) in &acc.opp_granted {
            units.push(granted_unit(false, a, *n, 0));
        }
        let mut my_cards: Vec<CardIdx> = pl.board.iter().map(|b| b.card).collect();
        let mut hand_cards: Vec<CardIdx> = Vec::new();
        for u in &units {
            if u.mine && u.zone == Zone::Hand {
                if let Some(cd) = u.card {
                    if !hand_cards.contains(&cd) {
                        hand_cards.push(cd);
                    }
                }
            }
            if u.mine && u.zone == Zone::Entering {
                if let Some(cd) = u.card {
                    if !my_cards.contains(&cd) {
                        my_cards.push(cd);
                    }
                }
            }
        }
        Ok(World {
            units,
            my_cards,
            hand_cards,
            fols,
            c,
        })
    }

    /// 能力が誘発しうる回数（1 つあたり）
    fn mult(&self, u: &Unit, on: On) -> i32 {
        let c = &self.c;
        let any_evolve = c.e_avail || c.se_avail;
        match (u.mine, u.zone, on) {
            (_, _, On::TurnStart | On::TurnEnd) => 0,
            (true, Zone::Hand, On::Fanfare | On::Spell) => u.playable as i32,
            (true, Zone::Hand, On::Spellboost) => c.sb,
            (true, Zone::Hand, On::AllyLeaveInHand) => c.hand_units,
            (true, Zone::Hand, On::Discarded | On::Fused) => 1,
            (_, Zone::Hand, _) => 0,
            (
                _,
                _,
                On::Fanfare
                | On::Spell
                | On::Spellboost
                | On::AllyLeaveInHand
                | On::Discarded
                | On::Fused,
            ) => 0,
            (_, Zone::Entering, On::Enter) => 1,
            (_, _, On::Enter) => 0,
            (_, _, On::LastWords) => 1,
            (true, _, On::Attack | On::Clash) => u.attacks,
            (false, _, On::Clash) => c.attacks,
            (false, _, On::Attack) => 0,
            (true, _, On::Evolve) => (u.evolvable && any_evolve) as i32,
            (true, _, On::SuperEvolve) => (u.evolvable && c.se_avail) as i32,
            (true, _, On::Evolved) => (u.evolvable && (any_evolve || c.evolve_effects > 0)) as i32,
            (false, _, On::Evolve | On::SuperEvolve | On::Evolved) => 0,
            (true, _, On::AllyEnter) => c.enter_me,
            (false, _, On::AllyEnter) => c.enter_opp,
            (true, _, On::Act) => (!u.acted) as i32,
            (true, _, On::AllyAct) => c.acts,
            (true, _, On::AllyFuse) => c.fuses,
            (false, _, On::Act | On::AllyAct | On::AllyFuse) => 0,
            (true, _, On::AllyDestroyed) => c.my_fols,
            (false, _, On::AllyDestroyed) => c.opp_fols,
            // 回数を見積もれないので、何かを数える能力なら見積もらない（呼び出し側で扱う）
            (_, _, On::LeaderHealed) => -1,
        }
    }

    fn walk_all(&self, s: &GameState, p: PlayerIndex) -> Result<Acc, Why> {
        let mut acc = Acc::default();
        // 【進化時】【超進化時】は進化する操作でだけ働き、操作は 1 ターンに 1 回なので、
        // フォロワーごとに数えて大きいほうだけを足す
        let mut evo = Acc::default();
        for u in &self.units {
            let mut one = Acc::default();
            for a in u.abilities() {
                let on = a.trigger.on();
                let k = self.mult(u, on);
                if k == 0 {
                    continue;
                }
                if matches!(on, On::Evolve | On::SuperEvolve) {
                    let mut fr = Frame {
                        mine: u.mine,
                        unit: u,
                        slots: Vec::new(),
                        vars: Vec::new(),
                    };
                    self.walk(s, p, &a.effects, 1, &mut fr, &mut one);
                    if one.unknown {
                        return Err((one.why, u.card));
                    }
                    continue;
                }
                let mut fr = Frame {
                    mine: u.mine,
                    unit: u,
                    slots: Vec::new(),
                    vars: Vec::new(),
                };
                if k < 0 {
                    let mut t = Acc::default();
                    self.walk(s, p, &a.effects, 1, &mut fr, &mut t);
                    if t != Acc::default() {
                        return Err(("LeaderHealed", u.card));
                    }
                    continue;
                }
                let k = if a.once_per_own_turn && u.mine {
                    k.min(1)
                } else {
                    k
                };
                self.walk(s, p, &a.effects, mul(k, u.count), &mut fr, &mut acc);
                if acc.unknown {
                    return Err((acc.why, u.card));
                }
            }
            evo.merge_max(&one);
        }
        acc.merge_add(&evo);
        Ok(acc)
    }

    fn ti(&self, t: &'static Target, fr: &Frame) -> Ti {
        match t {
            Target::This => Ti {
                my_single: fr.mine as i32,
                opp_side: !fr.mine,
                ..Ti::default()
            },
            Target::Leader { side } => Ti {
                enemy_leader: rel(fr.mine, *side).1,
                ..Ti::default()
            },
            Target::Board { side, filter } => {
                let amulet = filter
                    .as_ref()
                    .is_some_and(|f| f.ctype == Some(CardType::Amulet));
                let (me, them) = rel(fr.mine, *side);
                Ti {
                    my_all: me && !amulet,
                    opp_side: them,
                    ..Ti::default()
                }
            }
            Target::Hand { .. } => Ti {
                my_all: fr.mine,
                opp_side: !fr.mine,
                ..Ti::default()
            },
            Target::Slot { slot } => match fr.slots.iter().rev().find(|e| e.0 == *slot) {
                Some((_, SlotInfo::From(from, count))) => self.ti(from, fr).single(*count),
                Some((_, SlotInfo::Summoned(mine, count))) => Ti {
                    my_single: if *mine { *count } else { 0 },
                    opp_side: !*mine,
                    ..Ti::default()
                },
                None => Ti {
                    unknown: true,
                    ..Ti::default()
                },
            },
            // 誘発のきっかけ（入ったフォロワー、攻撃先のリーダー・フォロワー 等）
            Target::Event => Ti {
                enemy_leader: true,
                my_single: 1,
                opp_side: true,
                ..Ti::default()
            },
            Target::Union { of } => of
                .iter()
                .fold(Ti::default(), |a, x| a.union(self.ti(x, fr))),
            Target::MaxAttack { of } => self.ti(of, fr).single(1),
        }
    }

    fn count_bound(&self, t: &'static Target, fr: &Frame) -> i32 {
        match t {
            Target::This | Target::Event => 1,
            Target::Leader { .. } => 2,
            Target::Board { .. } => 2 * BOARD_LIMIT as i32,
            Target::Hand { .. } => self.c.hand_units,
            Target::Slot { slot } => match fr.slots.iter().rev().find(|e| e.0 == *slot) {
                Some((_, SlotInfo::From(_, n))) | Some((_, SlotInfo::Summoned(_, n))) => *n,
                None => 2 * BOARD_LIMIT as i32,
            },
            Target::Union { of } => of.iter().fold(0, |a, x| add(a, self.count_bound(x, fr))),
            Target::MaxAttack { of } => self.count_bound(of, fr),
        }
    }

    /// 値の上限（見積もれなければ None）
    fn vb(&self, s: &GameState, p: PlayerIndex, v: &'static Value, fr: &Frame) -> Option<i32> {
        match v {
            Value::Num(n) => Some(*n),
            Value::Obj(o) => match o {
                ValueObj::Var { name } => {
                    let v = fr.vars.iter().rev().find(|e| e.0 == *name)?.1;
                    self.vb(s, p, v, fr)
                }
                ValueObj::Count { of } => Some(self.count_bound(of, fr)),
                ValueObj::Combo => {
                    let q = if fr.mine { p } else { opponent(p) };
                    Some(add(
                        s.players[q].combo,
                        if fr.mine { self.c.plays } else { 0 },
                    ))
                }
                ValueObj::ThisX => Some(add(fr.unit.x.unwrap_or(0).max(0), self.c.sb)),
                ValueObj::DestroyedThisTurn { stat, .. } if fr.mine => {
                    let done: i32 = s.players[p]
                        .destroyed_this_turn
                        .iter()
                        .map(|r| {
                            if *stat == Stat::Attack {
                                r.attack
                            } else {
                                r.defense
                            }
                            .max(0)
                        })
                        .sum();
                    if *stat == Stat::Attack {
                        Some(add(done, self.c.base_atk))
                    } else {
                        None
                    }
                }
                _ => None,
            },
        }
    }

    fn walk(
        &self,
        s: &GameState,
        p: PlayerIndex,
        effs: &'static [Effect],
        m: i32,
        fr: &mut Frame,
        acc: &mut Acc,
    ) {
        for e in effs {
            if acc.unknown {
                return;
            }
            match e {
                Effect::Choose { slot, from, count } | Effect::Random { slot, from, count } => {
                    fr.slots.push((*slot, SlotInfo::From(from, *count)));
                }
                Effect::Mode { options } => {
                    for o in options {
                        self.walk(s, p, o, m, fr, acc);
                    }
                }
                Effect::Damage { target, amount } | Effect::Distribute { target, amount } => {
                    let t = self.ti(target, fr);
                    if t.unknown {
                        acc.unk("Damage");
                    } else if t.enemy_leader {
                        match self.vb(s, p, amount, fr) {
                            Some(a) => acc.dmg = add(acc.dmg, mul(m, a.max(0))),
                            None => acc.unk("Damage"),
                        }
                    }
                }
                Effect::SetDefense { target, .. } => {
                    let t = self.ti(target, fr);
                    if t.unknown || t.enemy_leader {
                        acc.unk("SetDefense");
                    }
                }
                Effect::SetLeaderMaxHp { side, .. } => {
                    if rel(fr.mine, *side).1 {
                        acc.unk("SetLeaderMaxHp");
                    }
                }
                Effect::Destroy { .. }
                | Effect::Banish { .. }
                | Effect::Heal { .. }
                | Effect::Discard { .. }
                | Effect::LoseKeyword { .. }
                | Effect::CannotAttack { .. }
                | Effect::AddX { .. }
                | Effect::Countdown { .. }
                | Effect::AddSigils { .. }
                | Effect::AddCombo { .. }
                | Effect::AddGraveyard { .. } => {}
                Effect::Bounce { target } => {
                    // 自分のカードを手札に戻すと、出し直してもう一度働かせられる
                    let t = self.ti(target, fr);
                    if t.unknown || t.mine() {
                        acc.unk("Bounce");
                    }
                }
                Effect::ReturnToDeck { target } => {
                    let t = self.ti(target, fr);
                    if t.unknown {
                        acc.unk("ReturnToDeck");
                    } else if t.mine() {
                        acc.reshuffle = true;
                    }
                }
                Effect::Draw { count, filter } => {
                    if fr.mine {
                        match self.vb(s, p, count, fr) {
                            Some(n) => acc.draws = add(acc.draws, mul(m, n.max(0))),
                            None => acc.unk("Draw"),
                        }
                        if filter.is_some() {
                            acc.draw_any = true;
                        }
                    }
                }
                Effect::DrawAll { slot, .. } => {
                    if fr.mine {
                        acc.draw_any = true;
                    }
                    if let Some(sl) = slot {
                        fr.slots.push((*sl, SlotInfo::Summoned(false, 0)));
                    }
                }
                Effect::AddToHand { card_id, count } => {
                    if fr.mine {
                        match self.vb(s, p, count, fr) {
                            Some(n) => push(&mut acc.adds, *card_id, mul(m, n.max(0))),
                            None => acc.unk("AddToHand"),
                        }
                    }
                }
                Effect::Summon {
                    card_id,
                    count,
                    slot,
                } => {
                    let n = match self.vb(s, p, count, fr) {
                        Some(n) => n.max(0),
                        None => {
                            acc.unk("Summon");
                            return;
                        }
                    };
                    if fr.mine {
                        push(&mut acc.summons, *card_id, mul(m, n));
                    } else {
                        acc.opp_summons = add(acc.opp_summons, mul(m, n));
                    }
                    if let Some(sl) = slot {
                        fr.slots.push((*sl, SlotInfo::Summoned(fr.mine, n)));
                    }
                }
                Effect::Reanimate { cost } => {
                    if fr.mine {
                        // 墓地のフォロワーと、このターンに破壊されて墓地に行きうるフォロワー
                        let mut seen: Vec<CardIdx> = Vec::new();
                        let pool = s.players[p]
                            .graveyard_followers
                            .iter()
                            .chain(&self.my_cards);
                        for &g in pool {
                            if crate::state::card(g).ctype != CardType::Follower {
                                continue;
                            }
                            if crate::state::card(g).cost <= *cost && !seen.contains(&g) {
                                seen.push(g);
                                push(&mut acc.summons, g, m);
                            }
                        }
                    } else {
                        acc.opp_summons = add(acc.opp_summons, m);
                    }
                }
                Effect::SummonCopy { from, slot } => {
                    // 選んだ手札・場のカードと同じカードを出す（どれを選びうるかは数えず、手札・場のフォロワーのどれでも）
                    let n = match fr.slots.iter().rev().find(|e| e.0 == *from) {
                        Some((_, SlotInfo::From(_, n))) | Some((_, SlotInfo::Summoned(_, n))) => *n,
                        None => {
                            acc.unk("SummonCopy");
                            return;
                        }
                    };
                    if fr.mine {
                        let mut seen: Vec<CardIdx> = Vec::new();
                        for &c in self.hand_cards.iter().chain(&self.my_cards) {
                            if crate::state::card(c).ctype != CardType::Spell && !seen.contains(&c)
                            {
                                seen.push(c);
                                push(&mut acc.summons, c, mul(m, n));
                            }
                        }
                        if let Some(sl) = slot {
                            fr.slots.push((*sl, SlotInfo::Summoned(true, n)));
                        }
                    } else {
                        acc.opp_summons = add(acc.opp_summons, m);
                        if let Some(sl) = slot {
                            fr.slots.push((*sl, SlotInfo::Summoned(false, 1)));
                        }
                    }
                }
                Effect::SummonFromDeck { kinds, .. } => {
                    if fr.mine {
                        acc.unk("SummonFromDeck");
                    } else {
                        acc.opp_summons = add(acc.opp_summons, mul(m, *kinds));
                    }
                }
                Effect::SummonDestroyedAmulet => {
                    if fr.mine {
                        let mut seen: Vec<CardIdx> = Vec::new();
                        let pool = s.players[p].destroyed_amulets.iter().chain(&self.my_cards);
                        for &a in pool {
                            if crate::state::card(a).ctype != CardType::Amulet {
                                continue;
                            }
                            if !seen.contains(&a) {
                                seen.push(a);
                                push(&mut acc.summons, a, m);
                            }
                        }
                    } else {
                        acc.opp_summons = add(acc.opp_summons, m);
                    }
                }
                Effect::ApocalypseDeck => {
                    if fr.mine {
                        acc.apocalypse = true;
                    }
                }
                Effect::Transform { target, card_id } => {
                    let t = self.ti(target, fr);
                    if t.unknown {
                        acc.unk("Transform");
                    } else if matches!(target, Target::This) {
                        // 自分自身の変身は、何度誘発しても 1 枚につき 1 回
                        if fr.mine {
                            let n = fr.unit.count;
                            match fr.unit.zone {
                                Zone::Hand => push(&mut acc.transforms, *card_id, n),
                                Zone::Entering => push(&mut acc.summons, *card_id, n),
                                Zone::Board | Zone::Crest => {
                                    push(&mut acc.board_transforms, *card_id, n)
                                }
                            }
                        }
                    } else if matches!(target, Target::Hand { .. }) {
                        if fr.mine {
                            push(&mut acc.transforms, *card_id, mul(m, self.c.hand_units));
                        }
                    } else if t.mine() {
                        let n = if t.my_all {
                            add(self.c.hand_units, 2 * BOARD_LIMIT as i32)
                        } else {
                            t.my_single
                        };
                        push(&mut acc.transforms, *card_id, mul(m, n));
                        push(&mut acc.board_transforms, *card_id, mul(m, n));
                    }
                }
                Effect::Buff { target, attack, .. } => {
                    let t = self.ti(target, fr);
                    if t.unknown {
                        acc.unk("Buff");
                    } else if t.mine() {
                        match self.vb(s, p, attack, fr) {
                            Some(a) if a <= 0 => {}
                            Some(a) => {
                                if t.my_all {
                                    acc.buff_all = add(acc.buff_all, mul(m, a));
                                }
                                acc.buff_single = add(acc.buff_single, mul(mul(m, t.my_single), a));
                            }
                            None => acc.unk("Buff"),
                        }
                    }
                }
                Effect::Grant {
                    target,
                    keywords,
                    max_attacks,
                    abilities,
                    ..
                } => {
                    let t = self.ti(target, fr);
                    if t.unknown {
                        acc.unk("Grant");
                        return;
                    }
                    if t.mine() {
                        if keywords.is_some_and(|k| k.has(STORM)) {
                            if t.my_all {
                                acc.storm_all = true;
                            }
                            acc.storm_single = add(acc.storm_single, mul(m, t.my_single));
                        }
                        if let Some(n) = max_attacks {
                            let x = (*n - 1).max(0);
                            if t.my_all {
                                acc.extra_all = add(acc.extra_all, mul(m, x));
                            }
                            acc.extra_single = add(acc.extra_single, mul(mul(m, t.my_single), x));
                        }
                    }
                    if let Some(abs) = abilities {
                        // 付与された能力は、付与されたもの（全部なら場に出うるフォロワーの数）ごとに働きうる
                        let n = if t.my_all {
                            add(self.c.my_fols, 2 * BOARD_LIMIT as i32)
                        } else {
                            t.my_single
                        };
                        for a in abs {
                            if t.mine() {
                                push(&mut acc.granted, a, mul(m, n));
                            }
                            if t.opp_side {
                                push(&mut acc.opp_granted, a, mul(m, 2 * BOARD_LIMIT as i32));
                            }
                        }
                    }
                }
                Effect::Evolve { target, kind } => {
                    let t = self.ti(target, fr);
                    if t.unknown {
                        acc.unk("Evolve");
                    } else if t.mine() {
                        let n = if t.my_all {
                            add(self.c.my_fols, 1)
                        } else {
                            t.my_single
                        };
                        match kind {
                            EvolveKind::Evolve => acc.evolves = add(acc.evolves, mul(m, n)),
                            EvolveKind::SuperEvolve => {
                                acc.super_evolves = add(acc.super_evolves, mul(m, n))
                            }
                        }
                    }
                }
                Effect::Spellboost { times, .. } => {
                    if fr.mine {
                        acc.sb_events = add(acc.sb_events, mul(m, (*times).max(0)));
                    }
                }
                Effect::CostChange { target, amount } => {
                    if fr.mine && *amount < 0 && !matches!(target, Target::This) {
                        acc.cost_down = true;
                    }
                }
                Effect::GainPp { amount } => {
                    if fr.mine {
                        let n = match amount {
                            PpAmount::Max(_) => Some(s.players[p].max_pp),
                            PpAmount::Value(v) => self.vb(s, p, v, fr),
                        };
                        match n {
                            Some(n) => acc.pp_gain = add(acc.pp_gain, mul(m, n.max(0))),
                            None => acc.unk("GainPp"),
                        }
                    }
                }
                Effect::AddMaxPp { amount } => {
                    if fr.mine {
                        acc.pp_gain = add(acc.pp_gain, mul(m, (*amount).max(0)));
                    }
                }
                Effect::EarthRite { then, .. } | Effect::Necromancy { then, .. } => {
                    self.walk(s, p, then, m, fr, acc);
                }
                Effect::Crest { crest_id, side } => {
                    let (me, them) = rel(fr.mine, *side);
                    if me {
                        push(&mut acc.crests, *crest_id, m);
                    }
                    if them {
                        push(&mut acc.opp_crests, *crest_id, m);
                    }
                }
                Effect::If {
                    cond,
                    then,
                    otherwise,
                } => {
                    let then_ok = match cond {
                        Condition::Enhanced => fr.unit.enhance_ok,
                        _ => true,
                    };
                    if then_ok {
                        self.walk(s, p, then, m, fr, acc);
                    }
                    if let Some(o) = otherwise {
                        self.walk(s, p, o, m, fr, acc);
                    }
                }
                Effect::Repeat { times, effects } => match self.vb(s, p, times, fr) {
                    Some(n) => self.walk(s, p, effects, mul(m, n.max(0)), fr, acc),
                    None => acc.unk("Repeat"),
                },
                Effect::SetVar { name, value } => {
                    fr.vars.push((*name, value));
                }
            }
        }
    }

    /// 数えたものから上限を出す
    fn finish(&self, acc: &Acc) -> i32 {
        let c = &self.c;
        let evolve_bonus = if c.se_avail {
            SUPER_EVOLVE_BONUS
        } else if c.e_avail {
            EVOLVE_BONUS
        } else {
            0
        };
        let single = add(
            add(acc.buff_single, evolve_bonus),
            add(
                mul(acc.evolves, EVOLVE_BONUS),
                mul(acc.super_evolves, SUPER_EVOLVE_BONUS),
            ),
        );
        let mut face: i64 = 0;
        let mut others: Vec<(i64, i32)> = Vec::new();
        let mut max_attacks = 0;
        let mut max_atk = 0;
        let mut se_attacks: i64 = 0;
        for f in &self.fols {
            let attacks = add(f.attacks, acc.extra_all);
            let atk = add(f.atk, acc.buff_all);
            max_attacks = max_attacks.max(attacks);
            max_atk = max_atk.max(atk);
            let v = attacks as i64 * atk as i64;
            if f.face || acc.storm_all {
                face += v * f.count as i64;
            } else if v > 0 {
                others.push((v, f.count));
            }
            if f.super_evolved {
                se_attacks += attacks as i64 * f.count as i64;
            }
        }
        // 疾走を与えられるフォロワーは、攻撃で与えうるダメージの大きい順に
        others.sort_unstable_by_key(|e| std::cmp::Reverse(e.0));
        let mut k = acc.storm_single as i64;
        for (v, n) in others {
            if k <= 0 {
                break;
            }
            let take = k.min(n as i64);
            face += v * take;
            k -= take;
        }
        let m = add(max_attacks, acc.extra_single) as i64;
        let v = add(max_atk, single) as i64;
        face += single as i64 * m + acc.extra_single as i64 * v;
        // ぶっとばし: 超進化したフォロワーが攻撃でフォロワーを破壊するたびに 1
        let se_count = c.se_avail as i64 + acc.super_evolves as i64;
        let smash = (se_attacks + se_count * m + acc.extra_single as i64).min(c.opp_fols as i64);
        (face + smash + acc.dmg as i64).clamp(0, CAP) as i32
    }
}

/// 局面 s から、手番のプレイヤー p がこのターンの残りで相手リーダーに与えうるダメージの上限。見積もれなければ None。
/// draws が false なら、山札からカードを引く手は打たないものとする（乱数に依らない手だけを調べる全探索は、引く手を除くので）
pub fn damage_bound(s: &GameState, p: PlayerIndex, draws: bool) -> Option<i32> {
    damage_bound_or_reason(s, p, draws).ok()
}

/// damage_bound と同じ。見積もれないときはその理由（調べる用）
pub fn damage_bound_or_reason(s: &GameState, p: PlayerIndex, draws: bool) -> Result<i32, Why> {
    if s.phase != Phase::Main || s.active != p {
        return Err(("not main", None));
    }
    let mut acc = Acc::default();
    for _ in 0..MAX_ROUNDS {
        let world = World::build(s, p, &acc, draws)?;
        let next = world.walk_all(s, p)?;
        if next == acc {
            return Ok(world.finish(&acc));
        }
        acc = next;
    }
    Err(("rounds", None))
}

/// 見積もりの途中で数えたもの（調べる用）
pub fn damage_bound_debug(s: &GameState, p: PlayerIndex, draws: bool) -> String {
    let nm = |c: CardIdx| crate::state::card(c).name.as_str();
    let mut out = String::new();
    let mut acc = Acc::default();
    for round in 0..MAX_ROUNDS {
        let world = match World::build(s, p, &acc, draws) {
            Ok(w) => w,
            Err(e) => {
                out += &format!("round {round}: build {e:?}\n");
                break;
            }
        };
        let next = match world.walk_all(s, p) {
            Ok(a) => a,
            Err(e) => {
                out += &format!("round {round}: walk {}\n", e.0);
                break;
            }
        };
        out += &format!(
            "round {round}: dmg {} hand {} plays {} sb {} fols {} adds {:?} summons {:?} transforms {:?} draws {} any {} reshuffle {} apo {} pp+{} costdown {} storm {}/{} buff {}/{} extra {}/{} evo {}/{}\n",
            next.dmg,
            world.c.hand_units,
            world.c.plays,
            world.c.sb,
            world.c.my_fols,
            next.adds.iter().map(|&(c, n)| (nm(c), n)).collect::<Vec<_>>(),
            next.summons.iter().map(|&(c, n)| (nm(c), n)).collect::<Vec<_>>(),
            next.transforms
                .iter()
                .chain(&next.board_transforms)
                .map(|&(c, n)| (nm(c), n))
                .collect::<Vec<_>>(),
            next.draws,
            next.draw_any,
            next.reshuffle,
            next.apocalypse,
            next.pp_gain,
            next.cost_down,
            next.storm_single,
            next.storm_all,
            next.buff_single,
            next.buff_all,
            next.extra_single,
            next.extra_all,
            next.evolves,
            next.super_evolves,
        );
        if next == acc {
            out += &format!("bound {}\n", world.finish(&acc));
            break;
        }
        acc = next;
    }
    out
}
