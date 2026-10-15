//! 能力（DSL）の解釈と、解決スタックの実行（src/engine/effects.ts の移植）。
//! 処理の順番（乱数を引く順を含む）は TypeScript 版と同じにしてある。変えると差分テストが通らなくなる。

use crate::data::*;
use crate::game::handle_internal;
use crate::state::*;

// ---- 対象 ----

pub fn card_matches(s: &GameState, ctx: &Ctx, iid: Iid, filter: Option<&CardFilter>) -> bool {
    let Some(f) = filter else { return true };
    if f.exclude_self && iid == ctx.source {
        return false;
    }
    let board = s.board_card(iid);
    let hand = if board.is_some() {
        None
    } else {
        s.hand_card(iid)
    };
    let cid = match (board, hand) {
        (Some(b), _) => b.card,
        (None, Some(h)) => h.card,
        _ => return false,
    };
    let cd = card(cid);
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
    if let Some(c) = f.class {
        if cd.class != c {
            return false;
        }
    }
    if let Some(ids) = &f.ids {
        if !ids.contains(&cid) {
            return false;
        }
    }
    let cost = match hand {
        Some(h) => hand_cost(h),
        None => cd.cost,
    };
    if let Some(m) = f.cost_max {
        if cost > m {
            return false;
        }
    }
    if let Some(v) = &f.cost_eq {
        if cost != eval_value(s, ctx, v) {
            return false;
        }
    }
    if f.spellboost
        && !abilities_of(cid)
            .abilities
            .iter()
            .any(|a| a.trigger.on() == On::Spellboost)
    {
        return false;
    }
    if f.earth_sigil && !cd.earth_sigil {
        return false;
    }
    if let Some(c) = board {
        if let Some(k) = f.keyword {
            if !c.has_keyword(k) {
                return false;
            }
        }
        if let Some(m) = f.defense_max {
            if !c.is_follower || c.defense > m {
                return false;
            }
        }
        if f.not_evolved && (!c.is_follower || c.evolve != Evolve::None) {
            return false;
        }
    } else if f.keyword.is_some() || f.defense_max.is_some() || f.not_evolved {
        return false;
    }
    true
}

fn side_players(s: &GameState, ctx: &Ctx, side: Side) -> ([PlayerIndex; 2], usize) {
    match side {
        Side::Me => ([ctx.controller, 0], 1),
        Side::Opponent => ([opponent(ctx.controller), 0], 1),
        Side::Both => (s.turn_order(), 2),
    }
}

fn exists_entity(s: &GameState, id: Iid) -> bool {
    is_leader(id) || s.find_board(id).is_some() || s.find_hand(id).is_some()
}

pub fn resolve_target(s: &GameState, ctx: &Ctx, t: &Target) -> Vec<Iid> {
    let mut out = Vec::new();
    resolve_into(s, ctx, t, &mut out);
    out
}

fn resolve_into(s: &GameState, ctx: &Ctx, t: &Target, out: &mut Vec<Iid>) {
    match t {
        Target::This => {
            if exists_entity(s, ctx.source) {
                out.push(ctx.source)
            }
        }
        Target::Leader { side } => {
            let (ps, n) = side_players(s, ctx, *side);
            for &p in &ps[..n] {
                out.push(leader_id(p));
            }
        }
        Target::Board { side, filter } => {
            let (ps, n) = side_players(s, ctx, *side);
            for &p in &ps[..n] {
                let board = &s.players[p].board;
                let perm = order_perm(board.iter().map(|c| c.order));
                let len = board.len();
                for k in 0..len {
                    let c = &board[perm.as_ref().map(|v| v[k]).unwrap_or(k)];
                    if card_matches(s, ctx, c.iid, filter.as_ref()) {
                        out.push(c.iid);
                    }
                }
            }
        }
        Target::Hand { filter } => {
            for c in &s.players[ctx.controller].hand {
                if card_matches(s, ctx, c.iid, filter.as_ref()) {
                    out.push(c.iid);
                }
            }
        }
        Target::Slot { slot } => {
            for &id in ctx.slot(*slot) {
                if exists_entity(s, id) {
                    out.push(id);
                }
            }
        }
        Target::Event => {
            if let Some(e) = ctx.event {
                if exists_entity(s, e) {
                    out.push(e);
                }
            }
        }
        Target::Union { of } => {
            for x in of {
                resolve_into(s, ctx, x, out);
            }
        }
        Target::MaxAttack { of } => {
            let fs: Vec<&OnBoard> = resolve_target(s, ctx, of)
                .into_iter()
                .filter_map(|id| s.follower(id))
                .collect();
            if let Some(max) = fs.iter().map(|f| f.attack_value()).max() {
                for f in fs {
                    if f.attack_value() == max {
                        out.push(f.iid);
                    }
                }
            }
        }
    }
}

/// 相手のカードを能力で選ぶ場合の制限（潜伏・オーラ、「相手は能力でこれしか選べない」）
fn selectable(s: &GameState, chooser: PlayerIndex, ids: Vec<Iid>) -> Vec<Iid> {
    let opp = opponent(chooser);
    let is_opp = |id: Iid| {
        if is_leader(id) {
            leader_owner(id) == opp
        } else {
            s.find_board(id).map(|(p, _)| p) == Some(opp)
        }
    };
    let blocked = |id: Iid| {
        s.board_card(id)
            .map(|c| c.has_keyword(AMBUSH) || c.has_keyword(AURA))
            .unwrap_or(false)
    };
    let only: Vec<Iid> = ids
        .iter()
        .copied()
        .filter(|&id| {
            is_opp(id)
                && !blocked(id)
                && s.board_card(id)
                    .map(|c| abilities_of(c.card).only_selectable)
                    .unwrap_or(false)
        })
        .collect();
    ids.into_iter()
        .filter(|&id| {
            if !is_opp(id) {
                return true;
            }
            if blocked(id) {
                return false;
            }
            only.is_empty() || only.contains(&id)
        })
        .collect()
}

/// 「選ぶ」の候補
pub fn choose_candidates(s: &GameState, ctx: &Ctx, from: &Target) -> Vec<Iid> {
    selectable(s, ctx.controller, resolve_target(s, ctx, from))
}

// ---- 値と条件 ----

fn source_x(s: &GameState, ctx: &Ctx) -> i32 {
    if let Some(b) = s.board_card(ctx.source) {
        if b.is_follower {
            if let Some(x) = b.x {
                return x;
            }
        }
    }
    if let Some(h) = s.hand_card(ctx.source) {
        if let Some(x) = h.x {
            return x;
        }
    }
    ctx.source_x.unwrap_or(0)
}

pub fn eval_value(s: &GameState, ctx: &Ctx, v: &Value) -> i32 {
    let o = match v {
        Value::Num(n) => return *n,
        Value::Obj(o) => o,
    };
    let pl = &s.players[ctx.controller];
    match o {
        ValueObj::Var { name } => ctx.var(*name),
        ValueObj::Count { of } => resolve_target(s, ctx, of).len() as i32,
        ValueObj::Combo => pl.combo,
        ValueObj::Sigils => pl
            .board
            .iter()
            .find(|c| !c.is_follower && c.sigils.is_some())
            .and_then(|c| c.sigils)
            .unwrap_or(0),
        ValueObj::ThisAttack => match s.follower(ctx.source) {
            Some(f) => f.attack_value(),
            None => ctx.source_attack,
        },
        ValueObj::CostOf { slot } => ctx.var(*slot),
        ValueObj::ThisX => source_x(s, ctx),
        ValueObj::DestroyedThisTurn { stat, filter } => pl
            .destroyed_this_turn
            .iter()
            .filter(|r| match filter {
                None => true,
                Some(f) => {
                    let cd = card(r.card);
                    f.tribe.map(|t| cd.tribes.contains(&t)).unwrap_or(true)
                        && f.ctype.map(|t| cd.ctype == t).unwrap_or(true)
                }
            })
            .map(|r| {
                if *stat == Stat::Attack {
                    r.attack
                } else {
                    r.defense
                }
            })
            .sum(),
    }
}

pub fn eval_cond(s: &GameState, ctx: &Ctx, c: &Condition) -> bool {
    let pl = &s.players[ctx.controller];
    match c {
        Condition::Awakened => pl.max_pp >= 7,
        Condition::Combo { at_least } => pl.combo >= *at_least,
        Condition::Enhanced => ctx.enhanced,
        Condition::SuperEvolveTurn => s.super_evolve_turn_reached(ctx.controller),
        Condition::ThisSuperEvolved => s
            .follower(ctx.source)
            .map(|f| f.evolve == Evolve::SuperEvolved)
            .unwrap_or(false),
        Condition::HandCount { at_most } => pl.hand.len() as i32 <= *at_most,
        Condition::AttackingFollower => ctx.event.map(|e| !is_leader(e)).unwrap_or(false),
        Condition::VarAtLeast { name, value } => ctx.var(*name) >= *value,
        Condition::ThisXAtLeast { value } => source_x(s, ctx) >= *value,
        Condition::MaxPp { at_least } => pl.max_pp >= *at_least,
        Condition::Not { cond } => !eval_cond(s, ctx, cond),
    }
}

// ---- 誘発 ----

pub fn push_frame(s: &mut GameState, effects: Vec<FEff>, ctx: Ctx) {
    if !effects.is_empty() {
        s.stack.push(Frame {
            effects,
            pc: 0,
            ctx,
        });
    }
}

#[inline]
fn dsl_list(effects: &'static [Effect]) -> Vec<FEff> {
    effects.iter().map(FEff::Dsl).collect()
}

fn queue(s: &mut GameState, ability: &'static Ability, ctx: Ctx) {
    s.queue.push_back(Queued { ability, ctx });
}

/// 「自分のターンごとに1回」の確認と記録
fn use_once(used: &mut Vec<(u8, i32)>, key: u8, turn_id: i32) -> bool {
    match used.iter_mut().find(|(k, _)| *k == key) {
        Some(e) if e.1 == turn_id => false,
        Some(e) => {
            e.1 = turn_id;
            true
        }
        None => {
            used.push((key, turn_id));
            true
        }
    }
}

/// 誘発の判定の結果: None なら誘発しない。Some(event) は文脈の event を上書きする（Some(None) は上書きしない）
type Matched = Option<Option<Iid>>;

/// プレイヤー p のクレスト（古い順）→場（古い順）のうち、条件を満たす能力を誘発させる
fn fire_side(
    s: &mut GameState,
    p: PlayerIndex,
    mut matcher: impl FnMut(&GameState, &Trigger, Iid) -> Matched,
) {
    let turn_id = s.players[p].turn_count;
    // 誘発の判定は状態を変えないので、クレストと場をそれぞれ並べ替えた順に見ていく
    let crest_perm = order_perm(s.players[p].crests.iter().map(|c| c.order));
    let n_crests = s.players[p].crests.len();
    for k in 0..n_crests {
        let ci = crest_perm.as_ref().map(|v| v[k]).unwrap_or(k);
        let (iid, crest_idx) = {
            let c = &s.players[p].crests[ci];
            (c.iid, c.crest)
        };
        for (i, ability) in crest_abilities_of(crest_idx).iter().enumerate() {
            let Some(event) = matcher(s, &ability.trigger, iid) else {
                continue;
            };
            if ability.once_per_own_turn
                && !use_once(&mut s.players[p].crests[ci].used_once, i as u8, turn_id)
            {
                continue;
            }
            let mut ctx = Ctx::new(p, iid);
            ctx.event = event;
            queue(s, ability, ctx);
        }
    }
    let board_perm = order_perm(s.players[p].board.iter().map(|c| c.order));
    let n_board = s.players[p].board.len();
    for k in 0..n_board {
        let bi = board_perm.as_ref().map(|v| v[k]).unwrap_or(k);
        let c = &s.players[p].board[bi];
        let (iid, cid, is_follower) = (c.iid, c.card, c.is_follower);
        let own = &abilities_of(cid).abilities;
        let n_granted = c.granted.len();
        for i in 0..own.len() + n_granted {
            let ability: &'static Ability = if i < own.len() {
                &own[i]
            } else {
                s.players[p].board[bi].granted[i - own.len()]
            };
            let Some(event) = matcher(s, &ability.trigger, iid) else {
                continue;
            };
            if ability.once_per_own_turn
                && is_follower
                && !use_once(&mut s.players[p].board[bi].used_once, i as u8, turn_id)
            {
                continue;
            }
            let c = &s.players[p].board[bi];
            let mut ctx = Ctx::new(p, iid);
            if is_follower {
                ctx.source_x = c.x;
                ctx.source_attack = c.attack_value();
            }
            ctx.event = event;
            queue(s, ability, ctx);
        }
    }
}

/// 手札のカードの能力を誘発させる
fn fire_hand(s: &mut GameState, p: PlayerIndex, hi: usize, on: On) {
    let h = &s.players[p].hand[hi];
    let (iid, cid, x) = (h.iid, h.card, h.x);
    for ability in &abilities_of(cid).abilities {
        if ability.trigger.on() == on {
            let mut ctx = Ctx::new(p, iid);
            ctx.source_x = x;
            queue(s, ability, ctx);
        }
    }
}

/// カード自身の能力のうち、指定の誘発のもの
pub fn own_abilities(cid: CardIdx, on: On) -> Vec<&'static Ability> {
    abilities_of(cid)
        .abilities
        .iter()
        .filter(|a| a.trigger.on() == on)
        .collect()
}

pub fn board_abilities_on(c: &OnBoard, on: On) -> Vec<&'static Ability> {
    c.abilities().filter(|a| a.trigger.on() == on).collect()
}

// ---- 場への出入り ----

/// カードを場に出す（場が満杯なら出さない）。出したら true
pub fn enter_board(s: &mut GameState, p: PlayerIndex, mut c: OnBoard) -> bool {
    if !s.can_add_to_board(p) {
        return false;
    }
    // 【土の印】アミュレットは1枚にまとまる
    if !c.is_follower && c.sigils.is_some() {
        let pl = &mut s.players[p];
        if let Some(oi) = pl
            .board
            .iter()
            .position(|x| !x.is_follower && x.sigils.is_some())
        {
            c.sigils = Some(c.sigils.unwrap() + pl.board[oi].sigils.unwrap_or(0));
            pl.board.remove(oi);
        }
    }
    let (iid, cid) = (c.iid, c.card);
    let enter = board_abilities_on(&c, On::Enter);
    s.players[p].board.push(c);
    for a in enter {
        queue(s, a, Ctx::new(p, iid));
    }
    fire_side(s, p, |s, t, src| match t {
        Trigger::AllyEnter { filter }
            if src != iid && card_matches(s, &Ctx::new(p, src), iid, filter.as_ref()) =>
        {
            Some(Some(iid))
        }
        _ => None,
    });
    let _ = cid;
    true
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LeaveReason {
    Destroy,
    Banish,
    Bounce,
}

/// 場から離れる処理。ラストワード等を誘発させる
pub fn leave_board(s: &mut GameState, iid: Iid, mut reason: LeaveReason) {
    let Some((p, _)) = s.find_board(iid) else {
        return;
    };
    if reason == LeaveReason::Destroy {
        if let Some(at) = &mut s.attack {
            if at.defender == iid {
                at.defender_destroyed = true;
            }
        }
    }
    let cid = s.board_card(iid).unwrap().card;
    if abilities_of(cid).banish_on_leave {
        reason = LeaveReason::Banish;
    }
    let is_follower = s.board_card(iid).unwrap().is_follower;
    // 破壊されたときの誘発は、離れる前の状態で条件を判定する
    if reason == LeaveReason::Destroy && is_follower {
        fire_side(s, p, |s, t, src| match t {
            Trigger::AllyDestroyed { filter }
                if src != iid && card_matches(s, &Ctx::new(p, src), iid, filter.as_ref()) =>
            {
                Some(Some(iid))
            }
            _ => None,
        });
    }
    let idx = s.players[p]
        .board
        .iter()
        .position(|c| c.iid == iid)
        .unwrap();
    let c = s.players[p].board.remove(idx);

    match reason {
        LeaveReason::Destroy => {
            let pl = &mut s.players[p];
            pl.graveyard += 1;
            let base = card(c.card);
            if c.is_follower {
                pl.graveyard_followers.push(c.card);
                let f = base.ctype == CardType::Follower;
                pl.destroyed_this_turn.push(DestroyedRecord {
                    card: c.card,
                    attack: if f { base.attack } else { 0 },
                    defense: if f { base.defense } else { 0 },
                });
            } else {
                pl.destroyed_amulets.push(c.card);
            }
            for a in board_abilities_on(&c, On::LastWords) {
                let mut ctx = Ctx::new(p, c.iid);
                ctx.source_attack = if c.is_follower { c.attack_value() } else { 0 };
                queue(s, a, ctx);
            }
        }
        LeaveReason::Bounce => {
            let h = revealed_hand_card(s, c.card, None);
            s.add_hand_card(p, h);
        }
        LeaveReason::Banish => {}
    }

    if c.is_follower {
        for hi in 0..s.players[p].hand.len() {
            fire_hand(s, p, hi, On::AllyLeaveInHand);
        }
    }
}

/// 超進化したフォロワーは持ち主のターン中、効果で破壊されない
pub fn immune_to_effect_destroy(s: &GameState, iid: Iid) -> bool {
    match s.find_board(iid) {
        Some((p, i)) => s.players[p].board[i].evolve == Evolve::SuperEvolved && p == s.active,
        None => false,
    }
}

/// 体力0以下のフォロワーを破壊する（手番のプレイヤーの場から、古い順）
pub fn destroy_dead(s: &mut GameState) {
    for p in s.turn_order() {
        if !s.players[p]
            .board
            .iter()
            .any(|c| c.is_follower && c.defense <= 0)
        {
            continue;
        }
        let mut dead: Vec<(i32, Iid)> = s.players[p]
            .board
            .iter()
            .filter(|c| c.is_follower && c.defense <= 0)
            .map(|c| (c.order, c.iid))
            .collect();
        dead.sort_by_key(|x| x.0);
        for (_, iid) in dead {
            leave_board(s, iid, LeaveReason::Destroy);
        }
    }
}

// ---- ダメージ・回復 ----

/// フォロワーにダメージを与え、実際に与えたダメージを返す
pub fn damage_follower(s: &mut GameState, iid: Iid, amount: i32) -> i32 {
    if amount <= 0 {
        return 0;
    }
    let Some((p, i)) = s.find_board(iid) else {
        return 0;
    };
    let active = s.active;
    let f = &mut s.players[p].board[i];
    if f.has_keyword(BARRIER) {
        f.keywords = f.keywords.without(BARRIER);
        f.temp_keywords = f.temp_keywords.without(BARRIER);
        return 0;
    }
    if f.evolve == Evolve::SuperEvolved && p == active {
        return 0;
    }
    f.defense -= amount;
    amount
}

pub fn damage_entity(s: &mut GameState, id: Iid, amount: i32) {
    if amount <= 0 {
        return;
    }
    if is_leader(id) {
        s.players[leader_owner(id)].leader_hp -= amount;
        return;
    }
    if s.follower(id).is_some() {
        damage_follower(s, id, amount);
    }
}

pub fn heal_leader(s: &mut GameState, p: PlayerIndex, amount: i32) {
    let pl = &mut s.players[p];
    let healed = pl.leader_max_hp.min(pl.leader_hp + amount) - pl.leader_hp;
    if healed <= 0 {
        return;
    }
    pl.leader_hp += healed;
    fire_side(s, p, |_, t, _| {
        if matches!(t, Trigger::LeaderHealed) {
            Some(None)
        } else {
            None
        }
    });
}

// ---- 進化 ----

/// 進化・超進化させる（能力値と状態のみ。誘発は呼び出し側）
pub fn evolve_follower(s: &mut GameState, p: PlayerIndex, iid: Iid, kind: EvolveKind) {
    let i = s.players[p]
        .board
        .iter()
        .position(|c| c.iid == iid)
        .unwrap();
    let f = &mut s.players[p].board[i];
    let bonus = if kind == EvolveKind::Evolve {
        EVOLVE_BONUS
    } else {
        SUPER_EVOLVE_BONUS
    };
    f.evolve = if kind == EvolveKind::Evolve {
        Evolve::Evolved
    } else {
        Evolve::SuperEvolved
    };
    f.attack += bonus;
    f.defense += bonus;
    f.max_defense += bonus;
    let evolved = board_abilities_on(f, On::Evolved);
    for a in evolved {
        queue(s, a, Ctx::new(p, iid));
    }
}

// ---- 誘発のきっかけ ----

pub fn fire_turn_start(s: &mut GameState) {
    let p = s.active;
    fire_side(s, p, |_, t, _| {
        if matches!(t, Trigger::TurnStart) {
            Some(None)
        } else {
            None
        }
    });
}

pub fn fire_turn_end(s: &mut GameState) {
    let [me, opp] = s.turn_order();
    fire_side(s, me, |_, t, _| {
        if matches!(t, Trigger::TurnEnd { whose: Whose::Me }) {
            Some(None)
        } else {
            None
        }
    });
    fire_side(s, opp, |_, t, _| {
        if matches!(
            t,
            Trigger::TurnEnd {
                whose: Whose::Opponent
            }
        ) {
            Some(None)
        } else {
            None
        }
    });
}

pub fn fire_ally_act(s: &mut GameState, p: PlayerIndex) {
    fire_side(s, p, |_, t, _| {
        if matches!(t, Trigger::AllyAct) {
            Some(None)
        } else {
            None
        }
    });
}

pub fn fire_ally_fuse(s: &mut GameState, p: PlayerIndex) {
    fire_side(s, p, |_, t, _| {
        if matches!(t, Trigger::AllyFuse) {
            Some(None)
        } else {
            None
        }
    });
}

/// 手札のカード（iid）をスペルブーストする
pub fn fire_spellboost(s: &mut GameState, p: PlayerIndex, iid: Iid, times: i32) {
    for _ in 0..times {
        let Some(hi) = s.players[p].hand.iter().position(|c| c.iid == iid) else {
            return;
        };
        s.players[p].hand[hi].boosts += 1;
        fire_hand(s, p, hi, On::Spellboost);
    }
}

/// 能力を直ちに解決スタックに積む（行動による発動）。先に書かれた能力から解決するよう、逆順に積む
pub fn push_abilities(s: &mut GameState, abilities: &[&'static Ability], ctx: &Ctx) {
    for a in abilities.iter().rev() {
        let c = Ctx {
            slots: Vec::new(),
            vars: ctx.vars.clone(),
            ..ctx.clone_shallow()
        };
        push_frame(s, dsl_list(&a.effects), c);
    }
}

impl Ctx {
    /// slots・vars を空にした複製
    pub fn clone_shallow(&self) -> Ctx {
        Ctx {
            controller: self.controller,
            source: self.source,
            event: self.event,
            slots: Vec::new(),
            vars: Vec::new(),
            enhanced: self.enhanced,
            source_x: self.source_x,
            source_attack: self.source_attack,
        }
    }
}

pub fn push_internal(s: &mut GameState, effects: Vec<FEff>, ctx: Ctx) {
    push_frame(s, effects, ctx);
}

// ---- 効果の実行 ----

/// 選択された対象を記録して再開する
pub fn answer_choose(s: &mut GameState, targets: Vec<Iid>) {
    let Some(Pending::Choose { slot, .. }) = s.pending else {
        panic!("選択待ちではありません")
    };
    let frame = s.stack.last_mut().expect("選択待ちではありません");
    frame.ctx.set_slot(slot, targets);
    frame.pc += 1;
    s.pending = None;
}

pub fn answer_mode(s: &mut GameState, index: usize) {
    let Some(Pending::Mode { .. }) = s.pending else {
        panic!("モード選択待ちではありません")
    };
    let frame = s.stack.last_mut().expect("モード選択待ちではありません");
    let FEff::Dsl(Effect::Mode { options }) = frame.effects[frame.pc] else {
        panic!("モード選択の効果がありません")
    };
    splice(
        frame,
        options.get(index).map(|v| v.as_slice()).unwrap_or(&[]),
        1,
    );
    s.pending = None;
}

/// 現在の効果を effects（times 回繰り返し）で置き換える（if・repeat 等の展開）
fn splice(frame: &mut Frame, effects: &'static [Effect], times: usize) {
    let pc = frame.pc;
    let mut v = Vec::with_capacity(frame.effects.len() + effects.len() * times);
    v.extend_from_slice(&frame.effects[..pc]);
    for _ in 0..times {
        v.extend(effects.iter().map(FEff::Dsl));
    }
    v.extend_from_slice(&frame.effects[pc + 1..]);
    frame.effects = v;
}

fn pick_random(s: &mut GameState, mut pool: Vec<Iid>, count: usize) -> Vec<Iid> {
    s.shuffle(&mut pool);
    pool.truncate(count);
    pool
}

fn sigil_amulet(s: &GameState, p: PlayerIndex) -> Option<usize> {
    s.players[p]
        .board
        .iter()
        .position(|c| !c.is_follower && c.sigils.is_some())
}

/// 効果を1つ実行する（frame はスタックから外してある）。選択待ちで中断したら false
fn exec(s: &mut GameState, frame: &mut Frame, eff: &'static Effect) -> bool {
    #[cfg(feature = "coverage")]
    coverage::hit(eff.op_name());
    let p = frame.ctx.controller;
    macro_rules! targets {
        ($t:expr) => {
            resolve_target(s, &frame.ctx, $t)
        };
    }
    macro_rules! val {
        ($v:expr) => {
            eval_value(s, &frame.ctx, $v)
        };
    }
    match eff {
        Effect::Choose { slot, from, count } => {
            let candidates = choose_candidates(s, &frame.ctx, from);
            if candidates.len() <= *count as usize {
                frame.ctx.set_slot(*slot, candidates);
                frame.pc += 1;
                return true;
            }
            s.pending = Some(Pending::Choose {
                player: p,
                slot: *slot,
                candidates,
                count: *count as usize,
            });
            return false;
        }
        Effect::Random { slot, from, count } => {
            let pool = targets!(from);
            let v = pick_random(s, pool, *count as usize);
            frame.ctx.set_slot(*slot, v);
        }
        Effect::Mode { options } => {
            s.pending = Some(Pending::Mode {
                player: p,
                options: options.len(),
            });
            return false;
        }
        Effect::Damage { target, amount } => {
            let amount = val!(amount);
            for id in targets!(target) {
                damage_entity(s, id, amount);
            }
        }
        Effect::Distribute { target, amount } => {
            // 古いフォロワーから順に、その体力と同じ値を割り当てる。ダメージは同時に与える
            let mut rest = val!(amount);
            let mut fs: Vec<(i32, Iid, i32)> = targets!(target)
                .into_iter()
                .filter_map(|id| s.follower(id).map(|f| (f.order, f.iid, f.defense)))
                .collect();
            fs.sort_by_key(|x| x.0);
            let mut plan = Vec::new();
            for (_, iid, def) in fs {
                if rest <= 0 {
                    break;
                }
                let n = rest.min(def.max(0));
                plan.push((iid, n));
                rest -= n;
            }
            for (iid, n) in plan {
                damage_follower(s, iid, n);
            }
        }
        Effect::Destroy { target, count_var } => {
            let mut count = 0;
            for id in targets!(target) {
                let Some(c) = s.board_card(id) else { continue };
                if c.is_follower && immune_to_effect_destroy(s, id) {
                    continue;
                }
                leave_board(s, id, LeaveReason::Destroy);
                count += 1;
            }
            if let Some(v) = count_var {
                frame.ctx.set_var(*v, count);
            }
        }
        Effect::Banish { target } => {
            for id in targets!(target) {
                leave_board(s, id, LeaveReason::Banish);
            }
        }
        Effect::Bounce { target } => {
            for id in targets!(target) {
                leave_board(s, id, LeaveReason::Bounce);
            }
        }
        Effect::Heal { target, amount } => {
            let amount = val!(amount);
            for id in targets!(target) {
                if is_leader(id) {
                    heal_leader(s, leader_owner(id), amount);
                }
            }
        }
        Effect::SetDefense { target, value } => {
            for id in targets!(target) {
                if let Some((q, i)) = s.find_follower(id) {
                    let f = &mut s.players[q].board[i];
                    f.defense = *value;
                    f.max_defense = *value;
                }
            }
        }
        Effect::Draw { count, filter } => {
            let n = val!(count);
            match filter {
                Some(f) => {
                    let hint = draw_hint(s, &frame.ctx, f);
                    let ctx = &frame.ctx;
                    let pred = |st: &GameState, c: CardIdx| deck_card_matches(st, ctx, c, f);
                    s.draw_cards(p, n, Some(&pred), Some(hint));
                }
                None => {
                    s.draw_cards(p, n, None, None);
                }
            }
        }
        Effect::DrawAll { filter, slot } => {
            let n = {
                let ctx = &frame.ctx;
                s.players[p]
                    .deck
                    .iter()
                    .filter(|r| deck_card_matches(s, ctx, r.card, filter))
                    .count() as i32
            };
            let hint = draw_hint(s, &frame.ctx, filter);
            let drawn = {
                let ctx = &frame.ctx;
                let pred = |st: &GameState, c: CardIdx| deck_card_matches(st, ctx, c, filter);
                s.draw_cards(p, n, Some(&pred), Some(hint))
            };
            if let Some(sl) = slot {
                frame.ctx.set_slot(*sl, drawn);
            }
        }
        Effect::AddToHand { card_id, count } => {
            let mut i = 0;
            while i < val!(count) {
                let h = revealed_hand_card(s, *card_id, None);
                s.add_hand_card(p, h);
                i += 1;
            }
        }
        Effect::Summon {
            card_id,
            count,
            slot,
        } => {
            let mut ids = Vec::new();
            let mut i = 0;
            while i < val!(count) {
                let c = s.new_board_card(*card_id, None);
                let iid = c.iid;
                if !enter_board(s, p, c) {
                    break;
                }
                ids.push(iid);
                i += 1;
            }
            if let Some(sl) = slot {
                frame.ctx.set_slot(*sl, ids);
            }
        }
        Effect::SummonCopy { from, slot } => {
            let mut ids = Vec::new();
            for id in frame.ctx.slot(*from).to_vec() {
                let src = s
                    .hand_card(id)
                    .map(|h| h.card)
                    .or_else(|| s.board_card(id).map(|b| b.card));
                let Some(cid) = src else { continue };
                let c = s.new_board_card(cid, None);
                let iid = c.iid;
                if enter_board(s, p, c) {
                    ids.push(iid);
                }
            }
            if let Some(sl) = slot {
                frame.ctx.set_slot(*sl, ids);
            }
        }
        Effect::Reanimate { cost } => {
            let costs: Vec<(CardIdx, i32)> = s.players[p]
                .graveyard_followers
                .iter()
                .map(|&id| (id, card(id).cost))
                .filter(|x| x.1 <= *cost)
                .collect();
            if let Some(max) = costs.iter().map(|x| x.1).max() {
                let mut best: Vec<CardIdx> = Vec::new();
                for &(id, c) in &costs {
                    if c == max && !best.contains(&id) {
                        best.push(id);
                    }
                }
                let k = s.rng_int(best.len());
                let chosen = best[k];
                let c = s.new_board_card(chosen, None);
                enter_board(s, p, c);
            }
        }
        Effect::SummonFromDeck { filter, kinds } => {
            let mut ks: Vec<CardIdx> = Vec::new();
            for r in &s.players[p].deck {
                if !ks.contains(&r.card) && deck_card_matches(s, &frame.ctx, r.card, filter) {
                    ks.push(r.card);
                }
            }
            s.shuffle(&mut ks);
            for &cid in ks.iter().take((*kinds).max(0) as usize) {
                if !s.can_add_to_board(p) {
                    break;
                }
                let idx = s.players[p]
                    .deck
                    .iter()
                    .position(|r| r.card == cid)
                    .unwrap();
                let r = s.players[p].deck.remove(idx);
                let h = s.new_hand_card(r.card, Some(r.iid));
                let c = s.new_board_card(r.card, Some(&h));
                enter_board(s, p, c);
            }
        }
        Effect::SummonDestroyedAmulet => {
            let da = &s.players[p].destroyed_amulets;
            if let Some(max) = da.iter().map(|&id| card(id).cost).max() {
                let mut best: Vec<CardIdx> = Vec::new();
                for &id in da {
                    if card(id).cost == max && !best.contains(&id) {
                        best.push(id);
                    }
                }
                let k = s.rng_int(best.len());
                let c = s.new_board_card(best[k], None);
                enter_board(s, p, c);
            }
        }
        Effect::ReturnToDeck { target } => {
            let ids = targets!(target);
            for &id in &ids {
                let Some((q, i)) = s.find_hand(id) else {
                    continue;
                };
                let h = s.players[q].hand.remove(i);
                s.players[q].deck.push(CardRef {
                    iid: h.iid,
                    card: h.card,
                });
            }
            if !ids.is_empty() {
                let mut deck = std::mem::take(&mut s.players[p].deck);
                s.shuffle(&mut deck);
                s.players[p].deck = deck;
            }
        }
        Effect::Discard { target } => {
            let var = cost_var_of(target);
            for id in targets!(target) {
                let Some((q, i)) = s.find_hand(id) else {
                    continue;
                };
                frame.ctx.set_var(var, hand_cost(&s.players[q].hand[i]));
                let h = s.players[q].hand.remove(i);
                s.players[q].graveyard += 1;
                for a in own_abilities(h.card, On::Discarded) {
                    queue(s, a, Ctx::new(q, h.iid));
                }
            }
        }
        Effect::Transform { target, card_id } => {
            for id in targets!(target) {
                transform(s, id, *card_id);
            }
        }
        Effect::Buff {
            target,
            attack,
            defense,
            duration,
        } => {
            let a = val!(attack);
            let d = val!(defense);
            for id in targets!(target) {
                if let Some((q, i)) = s.find_follower(id) {
                    let f = &mut s.players[q].board[i];
                    if *duration == Some(Duration::EndOfTurn) {
                        f.temp_attack += a;
                    } else {
                        f.attack = (f.attack + a).max(0);
                    }
                    f.defense += d;
                    f.max_defense += d;
                    continue;
                }
                if let Some((q, i)) = s.find_hand(id) {
                    let h = &mut s.players[q].hand[i];
                    h.attack_mod += a;
                    h.defense_mod += d;
                }
            }
        }
        Effect::Grant {
            target,
            keywords,
            max_attacks,
            abilities,
            duration,
        } => {
            let kw = keywords.unwrap_or_default();
            for id in targets!(target) {
                if let Some((q, i)) = s.find_board(id) {
                    let b = &mut s.players[q].board[i];
                    if *duration == Some(Duration::EndOfTurn) {
                        b.temp_keywords = b.temp_keywords.with(kw);
                    } else {
                        b.keywords = b.keywords.with(kw);
                    }
                    if let (true, Some(m)) = (b.is_follower, max_attacks) {
                        b.max_attacks = b.max_attacks.max(*m);
                    }
                    if let Some(ab) = abilities {
                        b.granted.extend(ab.iter());
                    }
                    continue;
                }
                if let Some((q, i)) = s.find_hand(id) {
                    let h = &mut s.players[q].hand[i];
                    h.keywords = h.keywords.with(kw);
                }
            }
        }
        Effect::LoseKeyword { target, keyword } => {
            for id in targets!(target) {
                if let Some(b) = s.board_card_mut(id) {
                    b.keywords = b.keywords.without(*keyword);
                    b.temp_keywords = b.temp_keywords.without(*keyword);
                }
            }
        }
        Effect::CannotAttack { target, .. } => {
            let until = s.turn + 1;
            for id in targets!(target) {
                if let Some((q, i)) = s.find_follower(id) {
                    s.players[q].board[i].cannot_attack_until = Some(until);
                }
            }
        }
        Effect::Evolve { target, kind } => {
            for id in targets!(target) {
                if let Some((q, i)) = s.find_follower(id) {
                    if s.players[q].board[i].evolve == Evolve::None {
                        evolve_follower(s, q, id, *kind);
                    }
                }
            }
        }
        Effect::Spellboost { target, times } => {
            for id in targets!(target) {
                if let Some((q, _)) = s.find_hand(id) {
                    fire_spellboost(s, q, id, *times);
                }
            }
        }
        Effect::CostChange { target, amount } => {
            for id in targets!(target) {
                if let Some((q, i)) = s.find_hand(id) {
                    s.players[q].hand[i].cost_mod += amount;
                }
            }
        }
        Effect::AddX { target, amount } => {
            for id in targets!(target) {
                if let Some((q, i)) = s.find_hand(id) {
                    let h = &mut s.players[q].hand[i];
                    h.x = Some(h.x.unwrap_or(0) + amount);
                } else if let Some((q, i)) = s.find_follower(id) {
                    let f = &mut s.players[q].board[i];
                    f.x = Some(f.x.unwrap_or(0) + amount);
                }
            }
        }
        Effect::Countdown { target, amount } => {
            for id in targets!(target) {
                let Some((q, i)) = s.find_board(id) else {
                    continue;
                };
                let a = &mut s.players[q].board[i];
                if a.is_follower {
                    continue;
                }
                if let Some(cd) = a.countdown {
                    a.countdown = Some(cd + amount);
                    if cd + amount <= 0 {
                        leave_board(s, id, LeaveReason::Destroy);
                    }
                }
            }
        }
        Effect::GainPp { amount } => {
            // 回復は PP最大値まで。エクストラPPで最大値を超えている場合は減らさない
            let v = match amount {
                PpAmount::Max(_) => None,
                PpAmount::Value(v) => Some(val!(v)),
            };
            let pl = &mut s.players[p];
            pl.pp = pl.pp.max(match v {
                None => pl.max_pp,
                Some(v) => pl.max_pp.min(pl.pp + v),
            });
        }
        Effect::AddMaxPp { amount } => {
            let pl = &mut s.players[p];
            pl.max_pp = MAX_PP.min(pl.max_pp + amount);
        }
        Effect::AddCombo { amount } => s.players[p].combo += amount,
        Effect::AddGraveyard { amount } => s.players[p].graveyard += amount,
        Effect::AddSigils { amount } => {
            let n = val!(amount);
            if let Some(i) = sigil_amulet(s, p) {
                let a = &mut s.players[p].board[i];
                a.sigils = Some(a.sigils.unwrap_or(0) + n);
            } else if s.can_add_to_board(p) {
                let mut c = s.new_board_card(data().earth_sigil_token, None);
                if !c.is_follower {
                    c.sigils = Some(n);
                }
                enter_board(s, p, c);
            }
        }
        Effect::EarthRite { amount, then } => {
            if let Some(i) = sigil_amulet(s, p) {
                let a = &mut s.players[p].board[i];
                if a.sigils.unwrap_or(0) >= *amount {
                    let left = a.sigils.unwrap_or(0) - amount;
                    a.sigils = Some(left);
                    let iid = a.iid;
                    // スタックが0になった【土の印】アミュレットは破壊される（紐づいた能力より先）
                    if left == 0 {
                        leave_board(s, iid, LeaveReason::Destroy);
                    }
                    splice(frame, then, 1);
                    return true;
                }
            }
        }
        Effect::Necromancy { amount, then } => {
            if s.players[p].graveyard >= *amount {
                s.players[p].graveyard -= amount;
                splice(frame, then, 1);
                return true;
            }
        }
        Effect::Crest { crest_id, side } => {
            let holder = if *side == Side::Me { p } else { opponent(p) };
            assert!(
                data().crest_abilities[*crest_id as usize].is_some(),
                "クレストの能力が未定義"
            );
            let iid = s.new_iid();
            let order = s.next_order;
            s.next_order += 1;
            let countdown = data().crests[*crest_id as usize].countdown;
            s.players[holder].crests.push(CrestInstance {
                iid,
                crest: *crest_id,
                countdown,
                order,
                used_once: Vec::new(),
            });
        }
        Effect::ApocalypseDeck => {
            let mut deck = Vec::new();
            for &(cid, n) in &data().apocalypse_deck {
                for _ in 0..n {
                    let iid = s.new_iid();
                    deck.push(CardRef { iid, card: cid });
                }
            }
            s.shuffle(&mut deck);
            s.players[p].deck = deck;
        }
        Effect::SetLeaderMaxHp { side, value } => {
            let t = &mut s.players[if *side == Side::Me { p } else { opponent(p) }];
            t.leader_max_hp = *value;
            t.leader_hp = t.leader_hp.min(*value);
        }
        Effect::If {
            cond,
            then,
            otherwise,
        } => {
            let ok = eval_cond(s, &frame.ctx, cond);
            let list: &'static [Effect] = if ok {
                then
            } else {
                otherwise.as_deref().unwrap_or(&[])
            };
            splice(frame, list, 1);
            return true;
        }
        Effect::Repeat { times, effects } => {
            let n = val!(times).max(0) as usize;
            splice(frame, effects, n);
            return true;
        }
        Effect::SetVar { name, value } => {
            let v = val!(value);
            frame.ctx.set_var(*name, v);
        }
    }
    frame.pc += 1;
    true
}

fn cost_var_of(t: &Target) -> VarId {
    // discard は変数 `cost:<slot>` に書く（slot でない対象は `cost:_`）
    let d = data();
    let name = match t {
        Target::Slot { slot } => format!("cost:{}", d.slot_names[*slot as usize]),
        _ => "cost:_".to_string(),
    };
    d.var_names
        .iter()
        .position(|v| *v == name)
        .map(|i| i as VarId)
        .unwrap_or(VarId::MAX)
}

/// 中身が相手にも分かる手札のカード
fn revealed_hand_card(s: &mut GameState, c: CardIdx, iid: Option<Iid>) -> HandCard {
    let mut h = s.new_hand_card(c, iid);
    h.revealed = true;
    h
}

fn draw_hint(s: &GameState, ctx: &Ctx, f: &'static CardFilter) -> DrawHint {
    DrawHint {
        filter: f,
        cost_eq: f.cost_eq.as_ref().map(|v| eval_value(s, ctx, v)),
    }
}

fn deck_card_matches(s: &GameState, ctx: &Ctx, cid: CardIdx, f: &CardFilter) -> bool {
    let cd = card(cid);
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
    if let Some(c) = f.class {
        if cd.class != c {
            return false;
        }
    }
    if let Some(ids) = &f.ids {
        if !ids.contains(&cid) {
            return false;
        }
    }
    if let Some(m) = f.cost_max {
        if cd.cost > m {
            return false;
        }
    }
    if let Some(v) = &f.cost_eq {
        if cd.cost != eval_value(s, ctx, v) {
            return false;
        }
    }
    true
}

fn transform(s: &mut GameState, id: Iid, cid: CardIdx) {
    if let Some((q, i)) = s.find_board(id) {
        let mut fresh = s.new_board_card(cid, None);
        let old = &s.players[q].board[i];
        fresh.iid = old.iid;
        fresh.order = old.order;
        if fresh.is_follower && old.is_follower {
            fresh.entered_turn = old.entered_turn;
        }
        s.players[q].board[i] = fresh;
        return;
    }
    if let Some((q, i)) = s.find_hand(id) {
        let h = revealed_hand_card(s, cid, Some(id));
        s.players[q].hand[i] = h;
    }
}

/// 解決スタックと誘発待ちを、選択待ちか空になるまで実行する
pub fn run(s: &mut GameState) {
    while s.phase != Phase::Ended && s.pending.is_none() {
        let Some(top) = s.stack.last_mut() else {
            let Some(q) = s.queue.pop_front() else { break };
            push_frame(s, dsl_list(&q.ability.effects), q.ctx);
            continue;
        };
        if top.pc >= top.effects.len() {
            s.stack.pop();
            // 能力の解決が1つ終わったら、誘発待ち（FIFO）から1つ取り出して解決する
            if let Some(q) = s.queue.pop_front() {
                push_frame(s, dsl_list(&q.ability.effects), q.ctx);
            }
            continue;
        }
        match top.effects[top.pc] {
            FEff::Dsl(eff) => {
                let mut frame = s.stack.pop().unwrap();
                let ok = exec(s, &mut frame, eff);
                s.stack.push(frame);
                if !ok {
                    break;
                }
            }
            internal => {
                top.pc += 1;
                let controller = top.ctx.controller;
                handle_internal(s, controller, internal);
            }
        }
        destroy_dead(s);
        s.check_leaders();
    }
    if s.phase == Phase::Ended {
        s.stack.clear();
        s.queue.clear();
        s.pending = None;
    }
}

#[cfg(feature = "coverage")]
pub mod coverage {
    use std::collections::HashMap;
    use std::sync::Mutex;
    static HITS: Mutex<Option<HashMap<&'static str, u64>>> = Mutex::new(None);
    pub fn hit(name: &'static str) {
        *HITS
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .entry(name)
            .or_insert(0) += 1;
    }
    pub fn hits() -> HashMap<&'static str, u64> {
        HITS.lock().unwrap().clone().unwrap_or_default()
    }
}
