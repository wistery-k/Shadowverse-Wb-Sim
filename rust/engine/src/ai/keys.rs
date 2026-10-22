//! 局面の同一判定（src/ai/keySet.ts の jsonEqual・turnOrderEqual 等）。
//! TypeScript 版は「JSON にしたときに同じ値か」で比べる（オブジェクトのキーの順は問わない、配列の順は問う）ので、
//! それと同じ判定を型ごとに書く。ハッシュは絞り込みにだけ使うので TypeScript 版と同じ値でなくてよい
//! （同じとみなすものが同じハッシュになればよい）。

use crate::data::Ability;
use crate::fasthash::FastMap;
use crate::state::*;
use std::rc::Rc;

/// 順番を問わない (キー, 値) の組の比較（TypeScript 版の Record）
fn map_eq<K: PartialEq, V: PartialEq>(a: &[(K, V)], b: &[(K, V)]) -> bool {
    a.len() == b.len()
        && a.iter()
            .all(|(k, v)| b.iter().any(|(k2, v2)| k == k2 && v == v2))
}

fn ability_eq(a: &Ability, b: &Ability) -> bool {
    std::ptr::eq(a, b) || a == b
}

fn abilities_eq(a: &[&'static Ability], b: &[&'static Ability]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| ability_eq(x, y))
}

fn hint_eq(a: &Option<DrawHint>, b: &Option<DrawHint>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => {
            let (f, g) = (x.filter, y.filter);
            f.ctype == g.ctype
                && f.tribe == g.tribe
                && f.class == g.class
                && f.ids == g.ids
                && f.cost_max == g.cost_max
                && x.cost_eq == y.cost_eq
        }
        _ => false,
    }
}

/// 手札のカードの、iid・boosts・revealed・drawnBy を除いた中身が同じか（withoutIds して比べる）
pub fn hand_eq_noid(a: &HandCard, b: &HandCard) -> bool {
    a.card == b.card
        && a.cost_mod == b.cost_mod
        && a.attack_mod == b.attack_mod
        && a.defense_mod == b.defense_mod
        && a.x == b.x
        && a.keywords == b.keywords
        && a.fused_kinds == b.fused_kinds
        && a.fused_this_turn == b.fused_this_turn
}

pub fn hand_eq(a: &HandCard, b: &HandCard) -> bool {
    a.iid == b.iid
        && a.boosts == b.boosts
        && a.revealed == b.revealed
        && hint_eq(&a.drawn_by, &b.drawn_by)
        && hand_eq_noid(a, b)
}

/// 場のカードの、iid・order を除いた中身が同じか
pub fn board_eq_noid(a: &OnBoard, b: &OnBoard) -> bool {
    if a.card != b.card
        || a.is_follower != b.is_follower
        || a.keywords != b.keywords
        || a.temp_keywords != b.temp_keywords
        || !abilities_eq(&a.granted, &b.granted)
        || !map_eq(&a.used_once, &b.used_once)
    {
        return false;
    }
    if a.is_follower {
        a.attack == b.attack
            && a.defense == b.defense
            && a.max_defense == b.max_defense
            && a.temp_attack == b.temp_attack
            && a.max_attacks == b.max_attacks
            && a.attacks_this_turn == b.attacks_this_turn
            && a.entered_turn == b.entered_turn
            && a.evolve == b.evolve
            && a.cannot_attack_until == b.cannot_attack_until
            && a.x == b.x
    } else {
        a.countdown == b.countdown && a.sigils == b.sigils && a.acted_this_turn == b.acted_this_turn
    }
}

pub fn board_eq(a: &OnBoard, b: &OnBoard) -> bool {
    a.iid == b.iid && a.order == b.order && board_eq_noid(a, b)
}

pub fn crest_eq_noid(a: &CrestInstance, b: &CrestInstance) -> bool {
    a.crest == b.crest && a.countdown == b.countdown && map_eq(&a.used_once, &b.used_once)
}

pub fn crest_eq(a: &CrestInstance, b: &CrestInstance) -> bool {
    a.iid == b.iid && a.order == b.order && crest_eq_noid(a, b)
}

fn list_eq<T>(a: &[T], b: &[T], eq: impl Fn(&T, &T) -> bool) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| eq(x, y))
}

/// 中身の集まりとして同じか（並び順は問わない。keySet.ts の sameCards と同じ貪欲な対応付け）
fn same_cards<T>(a: &[T], b: &[T], eq: impl Fn(&T, &T) -> bool) -> bool {
    if a.len() != b.len() {
        return false;
    }
    match a.len() {
        0 => return true,
        1 => return eq(&a[0], &b[0]),
        _ => {}
    }
    if b.len() <= 64 {
        // 使った印をビットで持つ（下の Vec と同じ対応付け）
        let mut used = 0u64;
        'outer: for x in a {
            for (j, y) in b.iter().enumerate() {
                if used & (1 << j) == 0 && eq(x, y) {
                    used |= 1 << j;
                    continue 'outer;
                }
            }
            return false;
        }
        return true;
    }
    let mut used = vec![false; b.len()];
    'outer: for x in a {
        for (j, y) in b.iter().enumerate() {
            if !used[j] && eq(x, y) {
                used[j] = true;
                continue 'outer;
            }
        }
        return false;
    }
    true
}

fn ctx_eq(a: &Ctx, b: &Ctx) -> bool {
    a.controller == b.controller
        && a.source == b.source
        && a.event == b.event
        && map_eq(&a.slots, &b.slots)
        && map_eq(&a.vars, &b.vars)
        && a.enhanced == b.enhanced
        && a.source_x == b.source_x
        && a.source_attack == b.source_attack
}

fn feff_eq(a: &FEff, b: &FEff) -> bool {
    match (a, b) {
        (FEff::Dsl(x), FEff::Dsl(y)) => std::ptr::eq(*x, *y) || x == y,
        (
            FEff::Combat {
                attacker: a1,
                target: t1,
            },
            FEff::Combat {
                attacker: a2,
                target: t2,
            },
        ) => a1 == a2 && t1 == t2,
        (FEff::CombatEnd, FEff::CombatEnd)
        | (FEff::EndTurn, FEff::EndTurn)
        | (FEff::Cleanup, FEff::Cleanup)
        | (FEff::StartTurn, FEff::StartTurn)
        | (FEff::StartTurnDraw, FEff::StartTurnDraw)
        | (FEff::FinishMulligan, FEff::FinishMulligan) => true,
        _ => false,
    }
}

fn frame_eq(a: &Frame, b: &Frame) -> bool {
    a.pc == b.pc
        && a.effects.len() == b.effects.len()
        && a.effects
            .iter()
            .zip(b.effects.iter())
            .all(|(x, y)| feff_eq(&x, &y))
        && ctx_eq(&a.ctx, &b.ctx)
}

pub fn stack_eq(a: &[Frame], b: &[Frame]) -> bool {
    list_eq(a, b, frame_eq)
}

fn queued_eq(a: &Queued, b: &Queued) -> bool {
    ability_eq(a.ability, b.ability) && ctx_eq(&a.ctx, &b.ctx)
}

/// プレイヤーの、山札・手札・場・クレスト以外が同じか
fn player_rest_eq(a: &PlayerState, b: &PlayerState) -> bool {
    a.leader_hp == b.leader_hp
        && a.leader_max_hp == b.leader_max_hp
        && a.max_pp == b.max_pp
        && a.pp == b.pp
        && a.ep == b.ep
        && a.sep == b.sep
        && a.extra_pp_available == b.extra_pp_available
        && a.turn_count == b.turn_count
        && a.graveyard == b.graveyard
        && a.graveyard_followers == b.graveyard_followers
        && a.destroyed_amulets == b.destroyed_amulets
        && a.hidden_discards == b.hidden_discards
        && list_eq(&a.destroyed_this_turn, &b.destroyed_this_turn, |x, y| {
            x.card == y.card && x.attack == y.attack && x.defense == y.defense
        })
        && a.combo == b.combo
        && a.evolved_this_turn == b.evolved_this_turn
        && a.ep_evolved_this_turn == b.ep_evolved_this_turn
        && a.sep_evolved_this_turn == b.sep_evolved_this_turn
        && a.mulligan_done == b.mulligan_done
}

fn player_eq(a: &PlayerState, b: &PlayerState) -> bool {
    player_rest_eq(a, b)
        && a.deck == b.deck
        && a.deck_kept.len() == b.deck_kept.len()
        && a.deck_kept
            .iter()
            .all(|x| kept_of(b, x.iid).is_some_and(|y| hand_eq(x, y)))
        && list_eq(&a.hand, &b.hand, hand_eq)
        && list_eq(&a.board, &b.board, board_eq)
        && list_eq(&a.crests, &b.crests, crest_eq)
}

/// 局面全体が同じか（jsonEqual(a, b)）
pub fn state_eq(a: &GameState, b: &GameState) -> bool {
    std::ptr::eq(a, b)
        || (a.phase == b.phase
            && a.first == b.first
            && a.active == b.active
            && a.turn == b.turn
            && a.winner == b.winner
            && a.rng == b.rng
            && a.next_iid == b.next_iid
            && a.next_order == b.next_order
            && a.pending == b.pending
            && a.attack == b.attack
            && player_eq(&a.players[0], &b.players[0])
            && player_eq(&a.players[1], &b.players[1])
            && stack_eq(&a.stack, &b.stack)
            && a.queue.len() == b.queue.len()
            && a.queue
                .iter()
                .zip(b.queue.iter())
                .all(|(x, y)| queued_eq(x, y)))
}

fn mid_ability(s: &GameState) -> bool {
    !s.stack.is_empty() || !s.queue.is_empty() || s.pending.is_some() || s.attack.is_some()
}

fn kept_of(p: &PlayerState, iid: Iid) -> Option<&HandCard> {
    if p.deck_kept.is_empty() {
        return None;
    }
    p.deck_kept.iter().find(|h| h.iid == iid)
}

fn kept_eq_noid(a: Option<&HandCard>, b: Option<&HandCard>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => hand_eq_noid(x, y),
        _ => false,
    }
}

fn same_player_for_turn_order(a: &PlayerState, b: &PlayerState) -> bool {
    a.deck.len() == b.deck.len()
        && a.deck
            .iter()
            .zip(&b.deck)
            .all(|(x, y)| x.card == y.card && kept_eq_noid(kept_of(a, x.iid), kept_of(b, y.iid)))
        && same_cards(&a.hand, &b.hand, hand_eq_noid)
        && same_cards(&a.board, &b.board, board_eq_noid)
        && same_cards(&a.crests, &b.crests, crest_eq_noid)
        && player_rest_eq(a, b)
}

/// 手の順番だけが違う局面を同じとみなす判定（keySet.ts の turnOrderEqual）
pub fn turn_order_eq(a: &GameState, b: &GameState) -> bool {
    if std::ptr::eq(a, b) {
        return true;
    }
    let (ma, mb) = (mid_ability(a), mid_ability(b));
    if ma || mb {
        return ma && mb && state_eq(a, b);
    }
    a.phase == b.phase
        && a.turn == b.turn
        && a.active == b.active
        && a.winner == b.winner
        && a.rng == b.rng
        && same_player_for_turn_order(&a.players[0], &b.players[0])
        && same_player_for_turn_order(&a.players[1], &b.players[1])
}

#[inline]
pub fn mix(h: u32, x: i32) -> u32 {
    (h ^ x as u32).wrapping_mul(0x01000193) ^ (h >> 15)
}

/// turn_order_eq 用のハッシュ（手札・場のカードは iid・order を使わず、順番によらない和で混ぜる）
pub fn turn_order_hash(s: &GameState) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for pl in &s.players {
        h = mix(
            mix(mix(h, pl.leader_hp), pl.graveyard),
            pl.graveyard_followers.len() as i32,
        );
        h = mix(
            mix(mix(mix(mix(h, pl.pp), pl.combo), pl.ep), pl.sep),
            pl.extra_pp_available as i32,
        );
        let mut hand: u32 = 0;
        for c in &pl.hand {
            hand = hand.wrapping_add(mix(
                mix(
                    mix(mix(0x811c9dc5, c.card as i32), c.cost_mod),
                    c.attack_mod,
                ),
                c.defense_mod,
            ));
        }
        let mut board: u32 = 0;
        for c in &pl.board {
            let mut x = mix(
                mix(mix(0x811c9dc5, c.card as i32), c.keywords.len() as i32),
                c.granted.len() as i32,
            );
            if c.is_follower {
                x = mix(
                    mix(
                        mix(mix(mix(x, c.attack), c.defense), c.max_defense),
                        c.temp_attack,
                    ),
                    c.attacks_this_turn,
                );
            } else {
                x = mix(mix(x, c.countdown.unwrap_or(-1)), c.acted_this_turn as i32);
            }
            board = board.wrapping_add(x);
        }
        h = mix(
            mix(
                mix(mix(h, pl.hand.len() as i32), hand as i32),
                pl.board.len() as i32,
            ),
            board as i32,
        );
        h = mix(h, pl.crests.len() as i32);
    }
    h = mix(h, pending_code(s));
    mix(h, s.stack.len() as i32)
}

fn pending_code(s: &GameState) -> i32 {
    match &s.pending {
        None => 0,
        Some(Pending::Choose { candidates, .. }) => 1 + candidates.len() as i32,
        Some(Pending::Mode { options, .. }) => 100 + *options as i32,
    }
}

/// 自分で決めた同一判定で値をまとめる集合（keySet.ts の EqSet）
pub struct EqSet<T> {
    buckets: FastMap<u32, Vec<T>>,
}

impl<T> Default for EqSet<T> {
    fn default() -> Self {
        EqSet {
            buckets: FastMap::default(),
        }
    }
}

impl<T> EqSet<T> {
    /// eq で同じとみなす値がまだ無ければ加えて true
    pub fn add(&mut self, value: T, hash: u32, eq: impl Fn(&T, &T) -> bool) -> bool {
        let bucket = self.buckets.entry(hash).or_default();
        if bucket.iter().any(|x| eq(x, &value)) {
            return false;
        }
        bucket.push(value);
        true
    }
}

/// ビームの同じ局面の判定用の集合（turnOrderEqual でまとめる）
#[derive(Default)]
pub struct TurnOrderSet(EqSet<Rc<GameState>>);

impl TurnOrderSet {
    pub fn add(&mut self, s: &Rc<GameState>) -> bool {
        let h = turn_order_hash(s);
        self.0.add(s.clone(), h, |a, b| turn_order_eq(a, b))
    }
}

/// リーサル探索の局面の同一判定（lethal.ts の stateKey を jsonEqual で比べる）
pub fn lethal_key_eq(a: &GameState, b: &GameState) -> bool {
    a.players.iter().zip(&b.players).all(|(x, y)| {
        x.leader_hp == y.leader_hp
            && x.pp == y.pp
            && x.combo == y.combo
            && x.ep == y.ep
            && x.sep == y.sep
            && x.extra_pp_available == y.extra_pp_available
            && list_eq(&x.hand, &y.hand, hand_eq)
            && list_eq(&x.board, &y.board, board_eq)
            && list_eq(&x.crests, &y.crests, crest_eq)
            && x.deck.len() == y.deck.len()
    }) && a.pending == b.pending
        && stack_eq(&a.stack, &b.stack)
}

/// lethal_key_eq 用のハッシュ
pub fn lethal_key_hash(s: &GameState) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for pl in &s.players {
        h = mix(h, pl.leader_hp);
        h = mix(
            mix(mix(mix(mix(h, pl.pp), pl.combo), pl.ep), pl.sep),
            pl.extra_pp_available as i32,
        );
        h = mix(h, pl.hand.len() as i32);
        for c in &pl.hand {
            h = mix(
                mix(
                    mix(
                        mix(mix(mix(h, c.iid), c.cost_mod), c.attack_mod),
                        c.defense_mod,
                    ),
                    c.boosts,
                ),
                c.keywords.len() as i32,
            );
        }
        h = mix(h, pl.board.len() as i32);
        for c in &pl.board {
            h = mix(
                mix(
                    mix(mix(mix(h, c.iid), c.order), c.keywords.len() as i32),
                    c.temp_keywords.len() as i32,
                ),
                c.granted.len() as i32,
            );
            if c.is_follower {
                h = mix(
                    mix(
                        mix(
                            mix(mix(mix(h, c.attack), c.defense), c.max_defense),
                            c.temp_attack,
                        ),
                        c.attacks_this_turn,
                    ),
                    c.max_attacks,
                );
            } else {
                h = mix(
                    mix(mix(h, c.countdown.unwrap_or(-1)), c.sigils.unwrap_or(-1)),
                    c.acted_this_turn as i32,
                );
            }
        }
        h = mix(h, pl.crests.len() as i32);
    }
    h = mix(h, pending_code(s));
    mix(h, s.stack.len() as i32)
}

/// p から見える局面が同じか（lethal.ts の visibleKey が同じ文字列になるか）
pub fn visible_eq(a: &GameState, b: &GameState, p: PlayerIndex) -> bool {
    let (ma, mb) = (&a.players[p], &b.players[p]);
    let (oa, ob) = (&a.players[opponent(p)], &b.players[opponent(p)]);
    a.turn == b.turn
        && a.active == b.active
        && a.pending == b.pending
        && stack_eq(&a.stack, &b.stack)
        && ma.leader_hp == mb.leader_hp
        && ma.pp == mb.pp
        && ma.combo == mb.combo
        && ma.ep == mb.ep
        && ma.sep == mb.sep
        && ma.extra_pp_available == mb.extra_pp_available
        && list_eq(&ma.hand, &mb.hand, hand_eq)
        && list_eq(&ma.board, &mb.board, board_eq)
        && list_eq(&ma.crests, &mb.crests, crest_eq)
        && ma.deck.len() == mb.deck.len()
        && oa.leader_hp == ob.leader_hp
        && list_eq(&oa.board, &ob.board, board_eq)
        && list_eq(&oa.crests, &ob.crests, crest_eq)
        && oa.hand.len() == ob.hand.len()
        && oa.deck.len() == ob.deck.len()
}
