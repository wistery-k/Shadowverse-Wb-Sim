//! 合流する相打ちの検出（src/ai/convergingTrade.ts）。

use crate::data::*;
use crate::game::{attack_targets, try_apply_action};
use crate::state::*;
use std::cell::RefCell;
use std::collections::HashMap;

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
    static TOUCHES_BOARD: RefCell<HashMap<usize, bool>> = RefCell::new(HashMap::new());
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

/// 合流する攻撃と、打った後の局面。first なら最初の 1 つだけ探す
fn converging_trades(s: &GameState, p: PlayerIndex, first: bool) -> Vec<(Action, GameState)> {
    let mut out = Vec::new();
    if s.phase == Phase::Ended || s.active != p || s.pending.is_some() {
        return out;
    }
    let me = &s.players[p];
    let opp = &s.players[opponent(p)];
    let mut sensitive: Option<bool> = None;
    let mut targets = Vec::new();
    for a in &me.board {
        if !a.is_follower || a.attacks_this_turn >= a.max_attacks || !symmetric_follower(a) {
            continue;
        }
        for b in &opp.board {
            if !b.is_follower || b.evolve == Evolve::SuperEvolved {
                continue;
            }
            let bane = a.has_keyword(BANE);
            if !bane && (a.attack_value() < b.defense || b.has_keyword(BARRIER)) {
                continue;
            }
            if !symmetric_follower(b)
                || has_board_last_words(b)
                || !can_be_attacked_back(s, p, a, b)
            {
                continue;
            }
            targets.clear();
            attack_targets(s, a, &mut targets);
            if !targets.contains(&Some(b.iid)) {
                continue;
            }
            if *sensitive.get_or_insert_with(|| has_timing_sensitive_ability(s)) {
                return Vec::new();
            }
            let action = Action::Attack {
                attacker: a.iid,
                target: Some(b.iid),
            };
            let Some(after) = try_apply_action(s, &action) else {
                continue;
            };
            if after.pending.is_some() || after.phase == Phase::Ended {
                continue;
            }
            if after.players[opponent(p)]
                .board
                .iter()
                .any(|c| c.iid == b.iid)
            {
                continue;
            }
            out.push((action, after));
            if first {
                return out;
            }
        }
    }
    out
}

/// プレイヤー p の合流する攻撃
pub fn converging_attacks(s: &GameState, p: PlayerIndex) -> Vec<Action> {
    converging_trades(s, p, false)
        .into_iter()
        .map(|(a, _)| a)
        .collect()
}

/// 合流する攻撃を、無くなるまで打った局面（無ければ None）
pub fn settle_converging_trades(s: &GameState, p: PlayerIndex) -> Option<GameState> {
    let mut cur: Option<GameState> = None;
    for _ in 0..7 {
        let base = cur.as_ref().unwrap_or(s);
        let Some((_, after)) = converging_trades(base, p, true).into_iter().next() else {
            break;
        };
        cur = Some(after);
    }
    cur
}
