//! 合流する相打ちの検出（src/ai/convergingTrade.ts）。

use crate::data::*;
use crate::fasthash::FastMap;
use crate::game::{attack_reach, attack_targets, try_apply_action};
use crate::state::*;
use std::cell::RefCell;

/// A・B が持っていてよい能力
fn harmless_own(on: On) -> bool {
    matches!(
        on,
        On::Fanfare
            | On::Spell
            | On::Evolve
            | On::SuperEvolve
            | On::Evolved
            | On::Enter
            | On::Act
            | On::Fused
            | On::Spellboost
            | On::Discarded
            | On::AllyEnter
            | On::AllyAct
            | On::AllyFuse
            | On::AllyLeaveInHand
            | On::LastWords
    )
}

thread_local! {
    static TOUCHES_BOARD: RefCell<FastMap<usize, bool>> = RefCell::new(FastMap::default());
}

/// 場のカードに関わる（対象にする・数える・場に出す）能力か。
/// TypeScript 版は効果の JSON に "kind":"board" か "op":"summon（summonCopy 等も含む）があるかで決める
fn touches_board(a: &'static Ability) -> bool {
    let key = a as *const Ability as usize;
    TOUCHES_BOARD.with(|m| {
        *m.borrow_mut().entry(key).or_insert_with(|| {
            let s = format!("{:?}", a.effects);
            s.contains("Board {") || s.contains("Summon")
        })
    })
}

fn has_timing_sensitive_ability(s: &GameState) -> bool {
    for p in 0..2 {
        let pl = &s.players[p];
        let crest_abs = pl
            .crests
            .iter()
            .flat_map(|c| crest_abilities_of(c.crest).iter());
        let board_abs = pl.board.iter().flat_map(|c| c.abilities());
        for a in crest_abs.chain(board_abs) {
            let on = a.trigger.on();
            if on == On::AllyDestroyed || on == On::LeaderHealed {
                return true;
            }
            if (on == On::TurnStart || on == On::TurnEnd) && touches_board(a) {
                return true;
            }
        }
    }
    false
}

fn symmetric_follower(f: &OnBoard) -> bool {
    if f.temp_attack != 0 || !f.temp_keywords.is_empty() {
        return false;
    }
    f.abilities().all(|a| harmless_own(a.trigger.on()))
}

fn has_board_last_words(f: &OnBoard) -> bool {
    f.abilities()
        .any(|a| a.trigger.on() == On::LastWords && touches_board(a))
}

fn can_be_attacked_back(s: &GameState, p: PlayerIndex, a: &OnBoard, b: &OnBoard) -> bool {
    if b.max_attacks < 1 {
        return false;
    }
    if let Some(u) = b.cannot_attack_until {
        if u > s.turn {
            return false;
        }
    }
    if a.keywords.has(AMBUSH) || a.keywords.has(INTIMIDATE) {
        return false;
    }
    if a.keywords.has(WARD) {
        return true;
    }
    !s.players[p].board.iter().any(|c| {
        c.iid != a.iid
            && c.is_follower
            && c.keywords.has(WARD)
            && !c.keywords.has(AMBUSH)
            && !c.keywords.has(INTIMIDATE)
    })
}

/// 自分の a で相手の b を攻撃するのが合流する攻撃なら、その手と打った後の局面
fn converging_pair(
    s: &GameState,
    p: PlayerIndex,
    a: &OnBoard,
    b: &OnBoard,
    sensitive: &mut Option<bool>,
    targets: &mut Vec<AttackTarget>,
) -> Option<(Action, GameState)> {
    if !a.is_follower || a.attacks_this_turn >= a.max_attacks || !symmetric_follower(a) {
        return None;
    }
    if !b.is_follower || b.evolve == Evolve::SuperEvolved {
        return None;
    }
    let bane = a.has_keyword(BANE);
    if !bane && (a.attack_value() < b.defense || b.has_keyword(BARRIER)) {
        return None;
    }
    if !symmetric_follower(b) || has_board_last_words(b) || !can_be_attacked_back(s, p, a, b) {
        return None;
    }
    targets.clear();
    attack_targets(s, a, targets);
    if !targets.contains(&Some(b.iid)) {
        return None;
    }
    if *sensitive.get_or_insert_with(|| has_timing_sensitive_ability(s)) {
        return None;
    }
    let action = Action::Attack {
        attacker: a.iid,
        target: Some(b.iid),
    };
    let after = try_apply_action(s, &action)?;
    if after.pending.is_some() || after.phase == Phase::Ended {
        return None;
    }
    if after.players[opponent(p)]
        .board
        .iter()
        .any(|c| c.iid == b.iid)
    {
        return None;
    }
    Some((action, after))
}

/// 合流する攻撃と、打った後の局面。first なら最初の 1 つだけ探す。
/// cheapest なら、同じ相手に下位互換の味方を当てても同じ相打ちになるとき、そちらを打つ（`dominates`）
fn converging_trades(
    s: &GameState,
    p: PlayerIndex,
    first: bool,
    cheapest: bool,
) -> Vec<(Action, GameState)> {
    let mut out = Vec::new();
    if s.phase == Phase::Ended || s.active != p || s.pending.is_some() {
        return out;
    }
    let me = &s.players[p];
    let opp = &s.players[opponent(p)];
    let mut sensitive: Option<bool> = None;
    let mut targets = Vec::new();
    for a in &me.board {
        for b in &opp.board {
            let Some((action, after)) = converging_pair(s, p, a, b, &mut sensitive, &mut targets)
            else {
                if sensitive == Some(true) {
                    return Vec::new();
                }
                continue;
            };
            if first {
                if cheapest && !alive(&after, a.iid) {
                    for y in &me.board {
                        if !dominates(s, a, y) {
                            continue;
                        }
                        if let Some((ya, yafter)) =
                            converging_pair(s, p, y, b, &mut sensitive, &mut targets)
                        {
                            if !alive(&yafter, y.iid) {
                                return vec![(ya, yafter)];
                            }
                        }
                    }
                }
                return vec![(action, after)];
            }
            out.push((action, after));
        }
    }
    out
}

fn alive(s: &GameState, iid: Iid) -> bool {
    s.board_card(iid).is_some()
}

/// 場の x が y の上位互換か（y にできる攻撃は x にもでき、x が場に残る方が得）。
/// y は能力を持たない（または x と同じカード）。x の能力は場を離れるときに働かないもの（ラストワード・自壊等を除く）。
/// 攻撃力・体力・キーワード（疾走・突進を除く）・攻撃できる先が y 以上で、どれかが上回るか能力を持つ
pub fn dominates(s: &GameState, x: &OnBoard, y: &OnBoard) -> bool {
    if x.iid == y.iid || !x.is_follower || !y.is_follower {
        return false;
    }
    if x.temp_attack != 0
        || y.temp_attack != 0
        || !x.temp_keywords.is_empty()
        || !y.temp_keywords.is_empty()
    {
        return false;
    }
    if x.attacks_this_turn != 0 || y.attacks_this_turn != 0 || x.max_attacks != y.max_attacks {
        return false;
    }
    let y_plain = y.abilities().next().is_none();
    if !y_plain && y.card != x.card {
        return false;
    }
    if !x
        .abilities()
        .all(|a| harmless_own(a.trigger.on()) && a.trigger.on() != On::LastWords)
    {
        return false;
    }
    if x.attack < y.attack || x.defense < y.defense || x.max_defense < y.max_defense {
        return false;
    }
    // 疾走・突進は、このターンに攻撃できる先（下の reach）にしか効かない
    let (xk, yk) = (
        x.keywords.without(STORM.with(RUSH)),
        y.keywords.without(STORM.with(RUSH)),
    );
    if yk.iter().any(|k| !xk.has(Kw::one(k))) {
        return false;
    }
    let reach = |f: &OnBoard| match attack_reach(s, f) {
        "leader" => 2,
        "follower" => 1,
        _ => 0,
    };
    if reach(x) < reach(y) {
        return false;
    }
    x.attack > y.attack
        || x.defense > y.defense
        || x.max_defense > y.max_defense
        || xk.len() > yk.len()
        || (y_plain && x.abilities().next().is_some())
}

/// 下位互換の味方で同じことができる攻撃か（探索で展開しない手）。
/// - x で相手のフォロワー t を攻撃して x も t も破壊されるとき、x の下位互換の y で攻撃しても同じになる
/// - y でリーダーを攻撃するとき、まだ攻撃していない y の上位互換の x もリーダーを攻撃できる（x で攻撃する方が得か同じ）
///
/// どちらも、上位互換の方を残す同じ手順（攻撃の順番を変えたもの）が別にあるので、外しても失う局面は無い
pub fn dominated_attack(s: &GameState, action: &Action) -> bool {
    let Action::Attack { attacker, target } = action else {
        return false;
    };
    if s.pending.is_some() {
        return false;
    }
    let p = s.active;
    let me = &s.players[p];
    let Some(x) = me.board.iter().find(|c| c.iid == *attacker) else {
        return false;
    };
    // 安い判定を先に行う
    if !me
        .board
        .iter()
        .any(|y| dominates(s, x, y) || dominates(s, y, x))
    {
        return false;
    }
    if has_timing_sensitive_ability(s) {
        return false;
    }
    let mut targets = Vec::new();
    match target {
        None => me.board.iter().any(|y| {
            dominates(s, y, x) && {
                targets.clear();
                attack_targets(s, y, &mut targets);
                targets.contains(&None)
            }
        }),
        Some(t) => {
            let trades = |f: &OnBoard| -> bool {
                let a = Action::Attack {
                    attacker: f.iid,
                    target: Some(*t),
                };
                match try_apply_action(s, &a) {
                    Some(after) => {
                        after.pending.is_none()
                            && after.phase != Phase::Ended
                            && !alive(&after, f.iid)
                            && !alive(&after, *t)
                    }
                    None => false,
                }
            };
            let mut cheaper = me.board.iter().filter(|y| dominates(s, x, y)).peekable();
            cheaper.peek().is_some() && trades(x) && cheaper.any(trades)
        }
    }
}

/// プレイヤー p の合流する攻撃
pub fn converging_attacks(s: &GameState, p: PlayerIndex) -> Vec<Action> {
    converging_trades(s, p, false, false)
        .into_iter()
        .map(|(a, _)| a)
        .collect()
}

/// 合流する攻撃を、無くなるまで打った局面（無ければ None）
pub fn settle_converging_trades(s: &GameState, p: PlayerIndex) -> Option<GameState> {
    settle_converging_trades_with(s, p, false)
}

/// settle_converging_trades で、cheapest なら同じ相打ちは下位互換の味方で打つ
pub fn settle_converging_trades_with(
    s: &GameState,
    p: PlayerIndex,
    cheapest: bool,
) -> Option<GameState> {
    let mut cur: Option<GameState> = None;
    for _ in 0..7 {
        let base = cur.as_ref().unwrap_or(s);
        let Some((_, after)) = converging_trades(base, p, true, cheapest)
            .into_iter()
            .next()
        else {
            break;
        };
        cur = Some(after);
    }
    cur
}
