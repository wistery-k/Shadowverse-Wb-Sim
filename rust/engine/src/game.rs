//! ルールエンジンの入口: 対戦の生成、合法手の列挙、アクションの適用（src/engine/game.ts の移植）。
//! `apply_action` は状態を複製してから変更し、新しい状態を返す（引数の状態は変更しない）。

use crate::data::*;
use crate::effects::*;
use crate::state::*;

fn new_player(deck: Vec<CardRef>) -> PlayerState {
    PlayerState {
        leader_hp: LEADER_HP,
        leader_max_hp: LEADER_HP,
        max_pp: 0,
        pp: 0,
        ep: EP,
        sep: SEP,
        extra_pp_available: false,
        turn_count: 0,
        deck: deck.into(),
        deck_kept: Vec::new(),
        hand: Shared::default(),
        board: Shared::default(),
        crests: Shared::default(),
        graveyard: 0,
        graveyard_followers: Shared::default(),
        destroyed_amulets: Shared::default(),
        hidden_discards: Shared::default(),
        destroyed_this_turn: Shared::default(),
        combo: 0,
        evolved_this_turn: false,
        ep_evolved_this_turn: None,
        sep_evolved_this_turn: None,
        mulligan_done: false,
    }
}

pub fn create_game(decks: [&[CardIdx]; 2], seed: u32) -> GameState {
    let mut next_iid = 1;
    let mut refs = |ids: &[CardIdx]| -> Vec<CardRef> {
        ids.iter()
            .map(|&c| {
                let r = CardRef {
                    iid: next_iid,
                    card: c,
                };
                next_iid += 1;
                r
            })
            .collect()
    };
    let p0 = new_player(refs(decks[0]));
    let p1 = new_player(refs(decks[1]));
    let mut s = GameState {
        phase: Phase::Mulligan,
        players: [p0, p1],
        first: 0,
        active: 0,
        turn: 0,
        winner: None,
        rng: seed,
        next_iid,
        next_order: 1,
        stack: Vec::new(),
        queue: Default::default(),
        pending: None,
        attack: None,
    };
    s.first = s.rng_int(2);
    s.active = s.first;
    s.players[opponent(s.first)].extra_pp_available = true;
    for p in 0..2 {
        let mut deck = std::mem::take(&mut s.players[p].deck).into_vec();
        s.shuffle(&mut deck);
        s.players[p].deck = deck.into();
        s.draw_cards(p, INITIAL_HAND as i32, None, None);
    }
    s
}

// ---- ターン進行（内部処理） ----

fn push_start_turn(s: &mut GameState, p: PlayerIndex) {
    push_internal(s, &[FEff::StartTurnDraw], Ctx::new(p, 0));
    push_internal(s, &[FEff::StartTurn], Ctx::new(p, 0));
}

fn push_end_turn(s: &mut GameState) {
    let a = s.active;
    push_internal(s, &[FEff::Cleanup], Ctx::new(a, 0));
    push_internal(s, &[FEff::EndTurn], Ctx::new(a, 0));
}

fn start_turn(s: &mut GameState, p: PlayerIndex) {
    s.turn += 1;
    s.active = p;
    let first = s.first;
    let pl = &mut s.players[p];
    pl.turn_count += 1;
    pl.max_pp = MAX_PP.min(pl.max_pp + 1);
    pl.pp = pl.max_pp;
    pl.combo = 0;
    pl.evolved_this_turn = false;
    pl.ep_evolved_this_turn = None;
    pl.sep_evolved_this_turn = None;
    if p != first && pl.turn_count == EXTRA_PP_REFRESH_TURN {
        pl.extra_pp_available = true;
    }
    s.players[0].destroyed_this_turn.clear();
    s.players[1].destroyed_this_turn.clear();
    let pl = &mut s.players[p];
    for c in pl.board.make_mut() {
        if c.is_follower {
            c.attacks_this_turn = 0;
        } else {
            c.acted_this_turn = false;
        }
    }
    for h in pl.hand.make_mut().iter_mut().chain(pl.deck_kept.iter_mut()) {
        h.fused_this_turn = false;
    }

    // カウントダウン（アミュレット・クレスト）
    let mut amulets: Vec<(i32, Iid)> = s.players[p]
        .board
        .iter()
        .map(|c| (c.order, c.iid))
        .collect();
    amulets.sort_by_key(|x| x.0);
    for (_, iid) in amulets {
        let Some(c) = s.board_card_mut(iid) else {
            continue;
        };
        if c.is_follower {
            continue;
        }
        if let Some(cd) = c.countdown {
            c.countdown = Some(cd - 1);
            if cd - 1 <= 0 {
                leave_board(s, iid, LeaveReason::Destroy);
            }
        }
    }
    let mut crests: Vec<(i32, Iid)> = s.players[p]
        .crests
        .iter()
        .map(|c| (c.order, c.iid))
        .collect();
    crests.sort_by_key(|x| x.0);
    for (_, iid) in crests {
        let Some(ci) = s.players[p].crests.iter().position(|c| c.iid == iid) else {
            continue;
        };
        let c = &mut s.players[p].crests.make_mut()[ci];
        let Some(cd) = c.countdown else { continue };
        c.countdown = Some(cd - 1);
        if cd - 1 > 0 {
            continue;
        }
        let crest = c.crest;
        s.players[p].crests.make_mut().remove(ci);
        for a in crest_abilities_of(crest) {
            if a.trigger.on() == On::LastWords {
                s.queue.push_back(Queued {
                    ability: a,
                    ctx: Ctx::new(p, iid),
                });
            }
        }
    }
    fire_turn_start(s);
}

/// ターン終了時に切れる一時的な効果を消す
fn clear_turn_effects(s: &mut GameState) {
    let turn = s.turn;
    for p in 0..2 {
        // 消すものが無い場は書き換えない（ほかの局面と共有したままにする）
        let changes = |c: &OnBoard| {
            c.temp_keywords != Kw::EMPTY
                || (c.is_follower
                    && (c.temp_attack != 0
                        || matches!(c.cannot_attack_until, Some(u) if u <= turn)))
        };
        if !s.players[p].board.iter().any(changes) {
            continue;
        }
        for c in s.players[p].board.make_mut() {
            c.temp_keywords = Kw::EMPTY;
            if c.is_follower {
                c.temp_attack = 0;
                if matches!(c.cannot_attack_until, Some(u) if u <= turn) {
                    c.cannot_attack_until = None;
                }
            }
        }
    }
}

fn has_turn_effects(s: &GameState) -> bool {
    s.players.iter().any(|pl| {
        pl.board.iter().any(|c| {
            !c.temp_keywords.is_empty()
                || (c.is_follower
                    && (c.temp_attack != 0
                        || matches!(c.cannot_attack_until, Some(u) if u <= s.turn)))
        })
    })
}

fn has_turn_end_trigger(s: &GameState) -> bool {
    (0..2).any(|p| {
        let whose = if p == s.active {
            Whose::Me
        } else {
            Whose::Opponent
        };
        let matches =
            |a: &Ability| matches!(a.trigger, Trigger::TurnEnd { whose: w } if w == whose);
        let pl = &s.players[p];
        pl.crests
            .iter()
            .any(|c| crest_abilities_of(c.crest).iter().any(matches))
            || pl.board.iter().any(|c| c.abilities().any(matches))
    })
}

fn end_turn_cleanup(s: &mut GameState) {
    clear_turn_effects(s);
    let next = opponent(s.active);
    push_start_turn(s, next);
}

/// 手番のプレイヤーがここでターンを終えたときの、ターン終了時の処理だけを行った局面（AI 用）
pub fn resolve_turn_end(prev: &GameState) -> Option<GameState> {
    if prev.phase != Phase::Main
        || prev.pending.is_some()
        || !prev.stack.is_empty()
        || !prev.queue.is_empty()
    {
        return None;
    }
    if !has_turn_end_trigger(prev) {
        if !has_turn_effects(prev) {
            return None;
        }
        let mut s = prev.clone();
        clear_turn_effects(&mut s);
        return Some(s);
    }
    let mut s = prev.clone();
    let a = s.active;
    push_internal(&mut s, &[FEff::EndTurn], Ctx::new(a, 0));
    run(&mut s);
    if s.phase == Phase::Main && s.pending.is_none() && s.stack.is_empty() && s.queue.is_empty() {
        clear_turn_effects(&mut s);
    }
    Some(s)
}

pub(crate) fn handle_internal(s: &mut GameState, controller: PlayerIndex, eff: FEff) {
    match eff {
        FEff::StartTurn => start_turn(s, controller),
        FEff::StartTurnDraw => {
            let a = s.active;
            s.draw_cards(a, 1, None, None);
        }
        FEff::EndTurn => fire_turn_end(s),
        FEff::Cleanup => end_turn_cleanup(s),
        FEff::FinishMulligan => {
            s.phase = Phase::Main;
            let f = s.first;
            push_start_turn(s, f);
        }
        FEff::Combat { attacker, target } => combat(s, attacker, target),
        FEff::CombatEnd => combat_end(s),
        FEff::Dsl(_) => unreachable!(),
    }
}

// ---- 判定 ----

/// プレイに必要なPP。エンハンスはPPが足りれば必ず適用される
pub fn play_cost(c: &Card, pp: i32, hand: Option<&HandCard>) -> i32 {
    let cost = match hand {
        Some(h) => hand_cost(h),
        None => c.cost,
    };
    match c.enhance {
        Some(e) if pp >= e && e > cost => e,
        _ => cost,
    }
}

/// スペルの「選ぶ」に対象がいるか（使用するスペル自身は手札から除いて判定する）
fn spell_has_targets(
    s: &GameState,
    p: PlayerIndex,
    hi: usize,
    scratch: &mut Option<GameState>,
) -> bool {
    let cid = s.players[p].hand[hi].card;
    let chooses = || {
        abilities_of(cid)
            .abilities
            .iter()
            .filter(|a| a.trigger.on() == On::Spell)
            .flat_map(|a| a.effects.iter())
            .filter_map(|e| {
                if let Effect::Choose { from, .. } = e {
                    Some(from)
                } else {
                    None
                }
            })
    };
    if chooses().next().is_none() {
        return true;
    }
    // 手札から除いた局面（合法手の列挙 1 回につき 1 度だけ複製し、除いたカードは戻す）
    let t = scratch.get_or_insert_with(|| s.clone());
    let removed = t.players[p].hand.make_mut().remove(hi);
    let ctx = Ctx::new(p, removed.iid);
    let ok = chooses().all(|from| !choose_candidates(t, &ctx, from).is_empty());
    t.players[p].hand.make_mut().insert(hi, removed);
    ok
}

fn can_play(s: &GameState, p: PlayerIndex, hi: usize, scratch: &mut Option<GameState>) -> bool {
    let pl = &s.players[p];
    let h = &pl.hand[hi];
    let c = card(h.card);
    if abilities_of(h.card).unplayable {
        return false;
    }
    if play_cost(c, pl.pp, Some(h)) > pl.pp {
        return false;
    }
    if c.ctype != CardType::Spell && !s.can_add_to_board(p) {
        return false;
    }
    if c.ctype == CardType::Spell && !spell_has_targets(s, p, hi, scratch) {
        return false;
    }
    true
}

fn can_attack_at_all(s: &GameState, f: &OnBoard) -> bool {
    if f.attacks_this_turn >= f.max_attacks {
        return false;
    }
    match f.cannot_attack_until {
        None => true,
        Some(u) => u < s.turn,
    }
}

pub(crate) fn can_attack_followers(s: &GameState, f: &OnBoard) -> bool {
    if !can_attack_at_all(s, f) {
        return false;
    }
    if f.entered_turn != s.turn {
        return true;
    }
    f.has_keyword(STORM) || f.has_keyword(RUSH) || f.evolve != Evolve::None
}

pub(crate) fn can_attack_leader(s: &GameState, f: &OnBoard) -> bool {
    if !can_attack_at_all(s, f) {
        return false;
    }
    f.entered_turn != s.turn || f.has_keyword(STORM)
}

/// 攻撃先の候補（守護を考慮済み）
pub fn attack_targets(s: &GameState, attacker: &OnBoard, out: &mut Vec<AttackTarget>) {
    for_each_attack_target(s, attacker, |t| out.push(t));
}

/// 攻撃先の候補を順に f に渡す（attack_targets と同じ順）
fn for_each_attack_target(s: &GameState, attacker: &OnBoard, mut f: impl FnMut(AttackTarget)) {
    let opp = &s.players[opponent(s.active)];
    let attackable = || {
        opp.board
            .iter()
            .filter(|c| c.is_follower && !c.has_keyword(AMBUSH) && !c.has_keyword(INTIMIDATE))
    };
    let has_ward = attackable().any(|c| c.has_keyword(WARD));
    if can_attack_followers(s, attacker) {
        for c in attackable() {
            if !has_ward || c.has_keyword(WARD) {
                f(Some(c.iid));
            }
        }
    }
    if !has_ward && can_attack_leader(s, attacker) {
        f(None);
    }
}

/// どこを攻撃できるか（"leader": リーダーも、"follower": フォロワーだけ、"none": 攻撃できない。画面の表示用）
pub fn attack_reach(s: &GameState, f: &OnBoard) -> &'static str {
    if can_attack_leader(s, f) {
        "leader"
    } else if can_attack_followers(s, f) {
        "follower"
    } else {
        "none"
    }
}

fn can_evolve(s: &GameState, f: &OnBoard, kind: EvolveKind) -> bool {
    let p = s.active;
    let pl = &s.players[p];
    let order = if p == s.first { 0 } else { 1 };
    if f.evolve != Evolve::None || pl.evolved_this_turn {
        return false;
    }
    match kind {
        EvolveKind::Evolve => pl.ep > 0 && pl.turn_count >= EVOLVE_TURN[order],
        EvolveKind::SuperEvolve => pl.sep > 0 && pl.turn_count >= SUPER_EVOLVE_TURN[order],
    }
}

fn act_ability(cid: CardIdx) -> Option<(&'static Ability, i32)> {
    abilities_of(cid).abilities.iter().find_map(|a| {
        if let Trigger::Act { cost } = a.trigger {
            Some((a, cost))
        } else {
            None
        }
    })
}

/// 融合できる手札のカードなら、素材の条件
fn fusion_filter(host: &HandCard) -> Option<&'static CardFilter> {
    let f = abilities_of(host.card).fusion.as_ref()?;
    if host.fused_this_turn {
        return None;
    }
    Some(f)
}

/// c が host の融合の素材にできるか（f は host の素材の条件）
fn is_fusion_material(f: &CardFilter, host: &HandCard, c: &HandCard) -> bool {
    if c.iid == host.iid {
        return false;
    }
    let cd = card(c.card);
    if f.ctype.map(|t| cd.ctype != t).unwrap_or(false) {
        return false;
    }
    if f.tribe.map(|t| !cd.tribes.contains(&t)).unwrap_or(false) {
        return false;
    }
    if f.ids
        .as_ref()
        .map(|ids| !ids.contains(&c.card))
        .unwrap_or(false)
    {
        return false;
    }
    true
}

/// 融合の素材の候補（手札の添字）
fn fusion_materials(s: &GameState, p: PlayerIndex, host: &HandCard) -> Vec<usize> {
    let Some(f) = fusion_filter(host) else {
        return Vec::new();
    };
    s.players[p]
        .hand
        .iter()
        .enumerate()
        .filter(|(_, c)| is_fusion_material(f, host, c))
        .map(|(i, _)| i)
        .collect()
}

/// 融合の素材にできる手札のカード（画面で素材を選ぶとき用）
pub fn fusion_candidates(s: &GameState, host_iid: Iid) -> Vec<Iid> {
    if s.phase != Phase::Main || s.pending.is_some() {
        return Vec::new();
    }
    let p = s.active;
    let hand = &s.players[p].hand;
    match hand.iter().find(|c| c.iid == host_iid) {
        Some(host) => fusion_materials(s, p, host)
            .into_iter()
            .map(|i| hand[i].iid)
            .collect(),
        None => Vec::new(),
    }
}

fn mulligan_player(s: &GameState) -> Option<PlayerIndex> {
    [s.first, opponent(s.first)]
        .into_iter()
        .find(|&p| !s.players[p].mulligan_done)
}

/// 次に行動するプレイヤー
pub fn acting_player(s: &GameState) -> PlayerIndex {
    if let Some(pd) = &s.pending {
        return pd.player();
    }
    if s.phase == Phase::Mulligan {
        return mulligan_player(s).unwrap_or(s.first);
    }
    s.active
}

/// 融合の素材の選び方（カードの種類ごとに使う枚数を決める。空の選び方は除く）。
/// 並びは、先に出てくる種類の枚数を上の桁とした辞書順
fn material_choices(s: &GameState, p: PlayerIndex, host: &HandCard) -> Vec<Vec<Iid>> {
    let Some(f) = fusion_filter(host) else {
        return Vec::new();
    };
    // 合法手の列挙のたびに呼ぶので、作業用の領域を使い回す
    thread_local! {
        static SCRATCH: std::cell::RefCell<MaterialScratch> = Default::default();
    }
    SCRATCH.with(|sc| {
        let MaterialScratch {
            kinds,
            iids,
            ends,
            counts,
        } = &mut *sc.borrow_mut();
        let hand = &s.players[p].hand;
        // 種類（最初に出てきた順）ごとに、素材の iid を手札の順に並べる
        kinds.clear();
        for c in hand.iter() {
            if is_fusion_material(f, host, c) && !kinds.contains(&c.card) {
                kinds.push(c.card);
            }
        }
        if kinds.is_empty() {
            return Vec::new();
        }
        iids.clear();
        ends.clear();
        for &k in kinds.iter() {
            for c in hand.iter() {
                if c.card == k && is_fusion_material(f, host, c) {
                    iids.push(c.iid);
                }
            }
            ends.push(iids.len());
        }
        let start = |g: usize| if g == 0 { 0 } else { ends[g - 1] };
        let total: usize = (0..kinds.len()).map(|g| ends[g] - start(g) + 1).product();
        let mut choices: Vec<Vec<Iid>> = Vec::with_capacity(total - 1);
        counts.clear();
        counts.resize(kinds.len(), 0);
        loop {
            // 最後の種類から 1 つ進める（繰り上がりあり）
            let mut g = kinds.len();
            loop {
                if g == 0 {
                    return choices;
                }
                g -= 1;
                if counts[g] < ends[g] - start(g) {
                    counts[g] += 1;
                    break;
                }
                counts[g] = 0;
            }
            let n: usize = counts.iter().sum();
            let mut v = Vec::with_capacity(n);
            for (g, &c) in counts.iter().enumerate() {
                v.extend_from_slice(&iids[start(g)..start(g) + c]);
            }
            choices.push(v);
        }
    })
}

#[derive(Default)]
struct MaterialScratch {
    kinds: Vec<CardIdx>,
    iids: Vec<Iid>,
    ends: Vec<usize>,
    counts: Vec<usize>,
}

fn subsets(items: &[Iid], size: Option<usize>) -> Vec<Vec<Iid>> {
    let mut out = Vec::new();
    for mask in 0u32..(1 << items.len()) {
        if let Some(k) = size {
            if mask.count_ones() as usize != k {
                continue;
            }
        }
        out.push(
            items
                .iter()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) != 0)
                .map(|(_, &x)| x)
                .collect(),
        );
    }
    out
}

// ---- 合法手 ----

pub fn legal_actions(s: &GameState) -> Vec<Action> {
    if s.phase == Phase::Ended {
        return Vec::new();
    }
    if let Some(pd) = &s.pending {
        return match pd {
            Pending::Mode { options, .. } => (0..*options).map(Action::Mode).collect(),
            Pending::Choose {
                candidates, count, ..
            } => subsets(candidates, Some(*count))
                .into_iter()
                .map(Action::Choose)
                .collect(),
        };
    }
    if s.phase == Phase::Mulligan {
        let Some(p) = mulligan_player(s) else {
            return Vec::new();
        };
        let iids: Vec<Iid> = s.players[p].hand.iter().map(|c| c.iid).collect();
        return subsets(&iids, None)
            .into_iter()
            .map(|swap| Action::Mulligan { player: p, swap })
            .collect();
    }
    let p = s.active;
    let pl = &s.players[p];
    let mut actions = Vec::with_capacity(16);
    let mut scratch = None;
    for hi in 0..pl.hand.len() {
        if can_play(s, p, hi, &mut scratch) {
            actions.push(Action::Play(pl.hand[hi].iid));
        }
    }
    for c in &pl.board {
        if c.is_follower {
            for_each_attack_target(s, c, |t| {
                actions.push(Action::Attack {
                    attacker: c.iid,
                    target: t,
                })
            });
            if can_evolve(s, c, EvolveKind::Evolve) {
                actions.push(Action::Evolve(c.iid));
            }
            if can_evolve(s, c, EvolveKind::SuperEvolve) {
                actions.push(Action::SuperEvolve(c.iid));
            }
        } else if let Some((_, cost)) = act_ability(c.card) {
            if !c.acted_this_turn && pl.pp >= cost {
                actions.push(Action::Act(c.iid));
            }
        }
    }
    // 同じカードの融合先・素材は区別しない（どの1枚を使っても結果は同じ）
    let mut fused_hosts: Vec<(CardIdx, &[CardIdx])> = Vec::new();
    for host in &pl.hand {
        if abilities_of(host.card).fusion.is_none() {
            continue;
        }
        let choices = material_choices(s, p, host);
        let key = (host.card, host.fused_kinds.as_slice());
        if choices.is_empty() || fused_hosts.contains(&key) {
            continue;
        }
        fused_hosts.push(key);
        for m in choices {
            actions.push(Action::Fuse {
                host: host.iid,
                materials: m,
            });
        }
    }
    if pl.extra_pp_available {
        actions.push(Action::ExtraPp);
    }
    actions.push(Action::EndTurn);
    actions
}

// ---- アクションの適用 ----

/// 行動が打てるか（局面は変えない）
pub fn is_legal(s: &GameState, action: &Action) -> bool {
    if s.phase == Phase::Ended {
        return false;
    }
    if let Some(pd) = &s.pending {
        return match (pd, action) {
            (
                Pending::Choose {
                    candidates, count, ..
                },
                Action::Choose(targets),
            ) => {
                targets.len() == *count
                    && targets
                        .iter()
                        .enumerate()
                        .all(|(i, t)| !targets[..i].contains(t))
                    && targets.iter().all(|t| candidates.contains(t))
            }
            (Pending::Mode { options, .. }, Action::Mode(i)) => *i < *options,
            _ => false,
        };
    }
    if let Action::Mulligan { player, swap } = action {
        if s.phase != Phase::Mulligan || mulligan_player(s) != Some(*player) {
            return false;
        }
        let hand = &s.players[*player].hand;
        return swap.iter().enumerate().all(|(i, x)| !swap[..i].contains(x))
            && swap.iter().all(|iid| hand.iter().any(|c| c.iid == *iid));
    }
    if s.phase != Phase::Main {
        return false;
    }
    let p = s.active;
    let pl = &s.players[p];
    match action {
        Action::Play(iid) => match pl.hand.iter().position(|c| c.iid == *iid) {
            Some(hi) => can_play(s, p, hi, &mut None),
            None => false,
        },
        Action::Attack { attacker, target } => match pl
            .board
            .iter()
            .find(|c| c.is_follower && c.iid == *attacker)
        {
            Some(a) => {
                let mut found = false;
                for_each_attack_target(s, a, |t| found |= t == *target);
                found
            }
            None => false,
        },
        Action::Evolve(iid) | Action::SuperEvolve(iid) => {
            let kind = if matches!(action, Action::Evolve(_)) {
                EvolveKind::Evolve
            } else {
                EvolveKind::SuperEvolve
            };
            pl.board
                .iter()
                .find(|c| c.is_follower && c.iid == *iid)
                .map(|f| can_evolve(s, f, kind))
                .unwrap_or(false)
        }
        Action::Act(iid) => match pl.board.iter().find(|c| c.iid == *iid) {
            Some(a) if !a.is_follower => match act_ability(a.card) {
                Some((_, cost)) => !a.acted_this_turn && pl.pp >= cost,
                None => false,
            },
            _ => false,
        },
        Action::Fuse { host, materials } => {
            let Some(h) = pl.hand.iter().find(|c| c.iid == *host) else {
                return false;
            };
            let Some(f) = fusion_filter(h) else {
                return false;
            };
            !materials.is_empty()
                && materials
                    .iter()
                    .enumerate()
                    .all(|(i, x)| !materials[..i].contains(x))
                && materials.iter().all(|x| {
                    pl.hand
                        .iter()
                        .any(|c| c.iid == *x && is_fusion_material(f, h, c))
                })
        }
        Action::ExtraPp => pl.extra_pp_available,
        Action::EndTurn => true,
        _ => false,
    }
}

/// 打った局面。不正な手なら panic
pub fn apply_action(prev: &GameState, action: &Action) -> GameState {
    assert!(is_legal(prev, action), "不正な行動: {action:?}");
    apply_legal(prev, action)
}

/// 打てる手なら打った局面、不正な手なら None（局面も複製しない）
pub fn try_apply_action(prev: &GameState, action: &Action) -> Option<GameState> {
    if is_legal(prev, action) {
        Some(apply_legal(prev, action))
    } else {
        None
    }
}

/// 打てると確かめた手を打つ
pub fn apply_legal(prev: &GameState, action: &Action) -> GameState {
    let mut s = prev.clone();
    apply_in_place(&mut s, action);
    s
}

/// 打てると確かめた手を、局面を書き換えて打つ
pub fn apply_in_place(s: &mut GameState, action: &Action) {
    if s.pending.is_some() {
        match action {
            Action::Choose(t) => answer_choose(s, t.clone()),
            Action::Mode(i) => answer_mode(s, *i),
            _ => {}
        }
    } else {
        match action {
            Action::Mulligan { player, swap } => apply_mulligan(s, *player, swap),
            Action::Play(iid) => apply_play(s, *iid),
            Action::Attack { attacker, target } => apply_attack(s, *attacker, *target),
            Action::Evolve(iid) => apply_evolve(s, *iid, EvolveKind::Evolve),
            Action::SuperEvolve(iid) => apply_evolve(s, *iid, EvolveKind::SuperEvolve),
            Action::Act(iid) => apply_act(s, *iid),
            Action::Fuse { host, materials } => apply_fuse(s, *host, materials),
            Action::ExtraPp => {
                let pl = &mut s.players[s.active];
                pl.extra_pp_available = false;
                pl.pp += 1;
            }
            Action::EndTurn => push_end_turn(s),
            Action::Choose(_) | Action::Mode(_) => {}
        }
    }
    run(s);
}

fn apply_mulligan(s: &mut GameState, p: PlayerIndex, swap: &[Iid]) {
    let hand = std::mem::take(&mut s.players[p].hand).into_vec();
    let (aside, keep): (Vec<HandCard>, Vec<HandCard>) =
        hand.into_iter().partition(|c| swap.contains(&c.iid));
    s.players[p].hand = keep.into();
    s.draw_cards(p, aside.len() as i32, None, None);
    for c in aside {
        s.return_to_deck(p, c);
    }
    let mut deck = std::mem::take(&mut s.players[p].deck).into_vec();
    s.shuffle(&mut deck);
    s.players[p].deck = deck.into();
    s.players[p].mulligan_done = true;
    if mulligan_player(s).is_none() {
        let f = s.first;
        push_internal(s, &[FEff::FinishMulligan], Ctx::new(f, 0));
    }
}

fn apply_play(s: &mut GameState, iid: Iid) {
    let p = s.active;
    let Some(hi) = s.players[p].hand.iter().position(|c| c.iid == iid) else {
        return;
    };
    let h = s.players[p].hand.make_mut().remove(hi);
    let cd = card(h.card);
    let pl = &mut s.players[p];
    let cost = play_cost(cd, pl.pp, Some(&h));
    let enhanced = cd.enhance == Some(cost) && cost > hand_cost(&h);
    pl.pp -= cost;
    pl.combo += 1;

    let mut ctx = Ctx::new(p, iid);
    ctx.enhanced = enhanced;
    ctx.source_x = h.x;
    ctx.source_attack = if cd.ctype == CardType::Follower {
        (cd.attack + h.attack_mod).max(0)
    } else {
        0
    };

    if cd.ctype == CardType::Spell {
        s.players[p].graveyard += 1;
        // 手札の他のカードはスペルブーストされる
        let others: Vec<Iid> = s.players[p].hand.iter().map(|c| c.iid).collect();
        for o in others {
            fire_spellboost(s, p, o, 1);
        }
        push_own_abilities(s, h.card, On::Spell, &ctx);
        return;
    }
    let b = s.new_board_card(h.card, Some(&h));
    let fanfare = board_abilities_on(&b, On::Fanfare);
    enter_board(s, p, b);
    push_abilities(s, &fanfare, &ctx);
}

fn apply_attack(s: &mut GameState, attacker_iid: Iid, target: AttackTarget) {
    let p = s.active;
    let Some(ai) = s.players[p]
        .board
        .iter()
        .position(|c| c.is_follower && c.iid == attacker_iid)
    else {
        return;
    };
    let a = &mut s.players[p].board.make_mut()[ai];
    a.attacks_this_turn += 1;
    a.keywords = a.keywords.without(AMBUSH); // 攻撃すると潜伏を失う
    let (a_card, a_super, a_attack, a_x) = (
        a.card,
        a.evolve == Evolve::SuperEvolved,
        a.attack_value(),
        a.x,
    );
    let attack_abilities = board_abilities_on(a, On::Attack);
    let clash_abilities = if target.is_some() {
        board_abilities_on(a, On::Clash)
    } else {
        Vec::new()
    };

    // 戦闘は【攻撃時】【交戦時】の能力の後（処理順は未確認）
    s.attack = target.map(|t| AttackInProgress {
        attacker: attacker_iid,
        defender: t,
        super_evolved: a_super,
        defender_destroyed: false,
    });
    push_internal(
        s,
        &[
            FEff::Combat {
                attacker: attacker_iid,
                target,
            },
            FEff::CombatEnd,
        ],
        Ctx::new(p, attacker_iid),
    );
    let event_id = target.unwrap_or(leader_id(opponent(p)));
    let attacker_ctx = |event: Iid| {
        let mut c = Ctx::new(p, attacker_iid);
        c.event = Some(event);
        c.source_attack = a_attack;
        c.source_x = a_x;
        c
    };
    let mut triggered: Vec<(&'static Ability, Ctx)> = Vec::new();
    for ab in attack_abilities {
        triggered.push((ab, attacker_ctx(event_id)));
    }
    if let Some(t) = target {
        for ab in clash_abilities {
            triggered.push((ab, attacker_ctx(t)));
        }
        if let Some((dp, di)) = s.find_follower(t) {
            let d = &s.players[dp].board[di];
            for ab in board_abilities_on(d, On::Clash) {
                let mut c = Ctx::new(dp, t);
                c.event = Some(attacker_iid);
                triggered.push((ab, c));
            }
        }
    }
    let _ = a_card;
    for (ab, ctx) in triggered.into_iter().rev() {
        push_abilities(s, &[ab], &ctx);
    }
}

fn combat(s: &mut GameState, attacker_iid: Iid, target: AttackTarget) {
    let p = s.active;
    let Some(a) = s.follower(attacker_iid) else {
        return;
    };
    let Some(t) = target else {
        let amount = a.attack_value();
        let drain = a.has_keyword(DRAIN);
        s.players[opponent(p)].leader_hp -= amount;
        if drain {
            heal_leader(s, p, amount);
        }
        s.check_leaders();
        return;
    };
    let Some(d) = s.follower(t) else { return }; // 攻撃先がいなくなった
    let (a_atk, d_atk) = (a.attack_value(), d.attack_value());

    // 交戦: 互いの攻撃力分のダメージを同時に与える
    let dealt = damage_follower(s, t, a_atk);
    damage_follower(s, attacker_iid, d_atk);
    if s.follower(attacker_iid)
        .map(|a| a.has_keyword(DRAIN))
        .unwrap_or(false)
    {
        heal_leader(s, p, dealt);
    }
    // 必殺: 戦闘ダメージを0以上与えたフォロワーを破壊（0ダメージでも破壊）。必殺は効果による破壊
    let a_bane = s
        .follower(attacker_iid)
        .map(|a| a.has_keyword(BANE))
        .unwrap_or(false);
    let d_bane = s.follower(t).map(|d| d.has_keyword(BANE)).unwrap_or(false);
    let destroy_defender = a_bane && !immune_to_effect_destroy(s, t);
    let destroy_attacker = d_bane && !immune_to_effect_destroy(s, attacker_iid);
    // 体力0以下のものと一緒に、手番のプレイヤーのフォロワーから破壊する
    if destroy_attacker
        && s.follower(attacker_iid)
            .map(|a| a.defense > 0)
            .unwrap_or(false)
    {
        leave_board(s, attacker_iid, LeaveReason::Destroy);
    }
    if destroy_defender && s.follower(t).map(|d| d.defense > 0).unwrap_or(false) {
        leave_board(s, t, LeaveReason::Destroy);
    }
}

/// 戦闘の後処理。ぶっとばし: 超進化したフォロワーの攻撃中に攻撃先のフォロワーが破壊されたら、相手のリーダーに1ダメージ
fn combat_end(s: &mut GameState) {
    let at = s.attack.take();
    let Some(at) = at else { return };
    if !at.super_evolved || !at.defender_destroyed {
        return;
    }
    s.players[opponent(s.active)].leader_hp -= 1;
    s.check_leaders();
}

fn apply_evolve(s: &mut GameState, iid: Iid, kind: EvolveKind) {
    let p = s.active;
    let Some(fi) = s.players[p]
        .board
        .iter()
        .position(|c| c.is_follower && c.iid == iid)
    else {
        return;
    };
    let f = &s.players[p].board[fi];
    let cid = f.card;
    let evolve_abilities = board_abilities_on(f, On::Evolve);
    let super_abilities = if kind == EvolveKind::SuperEvolve {
        board_abilities_on(f, On::SuperEvolve)
    } else {
        Vec::new()
    };
    let pl = &mut s.players[p];
    if kind == EvolveKind::Evolve {
        pl.ep -= 1;
        pl.ep_evolved_this_turn = Some(cid);
    } else {
        pl.sep -= 1;
        pl.sep_evolved_this_turn = Some(cid);
    }
    pl.evolved_this_turn = true;

    // 【進化時】【超進化時】（超進化でも【進化時】は働く。「〜ではなく」の【超進化時】は置き換える）
    let replaces = super_abilities.iter().any(|a| a.replaces_evolve);
    let abilities: Vec<&'static Ability> = if replaces {
        super_abilities
    } else {
        evolve_abilities
            .into_iter()
            .chain(super_abilities)
            .collect()
    };

    evolve_follower(s, p, iid, kind);
    let f = s.board_card(iid).unwrap();
    let mut ctx = Ctx::new(p, iid);
    ctx.source_x = f.x;
    ctx.source_attack = f.attack_value();
    push_abilities(s, &abilities, &ctx);
}

fn apply_act(s: &mut GameState, iid: Iid) {
    let p = s.active;
    let Some(ai) = s.players[p].board.iter().position(|c| c.iid == iid) else {
        return;
    };
    if s.players[p].board[ai].is_follower {
        return;
    }
    let Some((ability, cost)) = act_ability(s.players[p].board[ai].card) else {
        return;
    };
    s.players[p].pp -= cost;
    s.players[p].board.make_mut()[ai].acted_this_turn = true;
    fire_ally_act(s, p);
    push_abilities(s, &[ability], &Ctx::new(p, iid));
}

fn apply_fuse(s: &mut GameState, host_iid: Iid, materials: &[Iid]) {
    let p = s.active;
    let Some(hi) = s.players[p].hand.iter().position(|c| c.iid == host_iid) else {
        return;
    };
    let hand = s.players[p].hand.make_mut();
    // 素材（手札の順）のコストを足し、種類を融合先に記録してから、手札から除く
    let mut fused_cost = 0;
    for j in 0..hand.len() {
        if !materials.contains(&hand[j].iid) {
            continue;
        }
        fused_cost += hand_cost(&hand[j]);
        let kind = hand[j].card;
        let host = &mut hand[hi];
        if !host.fused_kinds.contains(&kind) {
            host.fused_kinds.push(kind);
        }
    }
    let host = &mut hand[hi];
    host.fused_this_turn = true;
    let (host_card, n_kinds) = (host.card, host.fused_kinds.len() as i32);
    hand.retain(|c| !materials.contains(&c.iid));
    let d = data();
    let mut ctx = Ctx::new(p, host_iid);
    // 「融合したカードのコスト」は手札で変化したコスト（docs/rules.md の「コスト」と「元のコスト」）
    ctx.set_var(d.var_fused_cost, fused_cost);
    ctx.set_var(d.var_fused_kinds, n_kinds);
    fire_ally_fuse(s, p);
    push_own_abilities(s, host_card, On::Fused, &ctx);
}
