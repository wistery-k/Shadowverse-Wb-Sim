//! 盤面の評価関数（src/ai/evaluate.ts の evaluateWith）。足し算の順番まで TypeScript 版と同じにする。

use super::aidata::{ai_data, Weights};
use crate::data::*;
use crate::state::*;
use std::sync::OnceLock;

/// キーワード能力の価値（KEYWORD_NAMES の順。疾走・突進は 0）
const KEYWORD_VALUE: [f64; 9] = [1.0, 0.0, 0.0, 2.0, 1.0, 1.0, 1.0, 1.0, 0.5];

#[inline]
fn kw_value(k: u16) -> f64 {
    KEYWORD_VALUE[k as usize]
}

/// カウントダウンのアミュレットが割れたときに得るもの（ラストワードで出すフォロワーと引く枚数）
pub struct CountdownPayoff {
    pub followers: Vec<(i32, i32, Kw)>,
    pub draws: i32,
}

/// カードごとに決まる表（evaluate.ts のモジュールの定数）
pub struct Tables {
    pub boostable: Vec<bool>,
    pub boost_grown: Vec<bool>,
    pub evolve_ability: Vec<bool>,
    pub super_evolve_ability: Vec<bool>,
    pub act_storm: Vec<bool>,
    pub has_act: Vec<bool>,
    pub countdown_payoff: Vec<Option<CountdownPayoff>>,
    pub doomed: Vec<bool>,
    pub last_words_payoff: Vec<Option<(i32, i32)>>,
    pub fusion_set: Vec<bool>,
    pub passive: Vec<bool>,
}

fn has_on(c: CardIdx, f: impl Fn(&Ability) -> bool) -> bool {
    abilities_of(c).abilities.iter().any(f)
}

/// 場にいる間に働く誘発能力（自壊するものは除く。Weights.passive）
fn is_passive(a: &Ability) -> bool {
    matches!(
        a.trigger,
        Trigger::TurnStart
            | Trigger::TurnEnd { .. }
            | Trigger::AllyEnter { .. }
            | Trigger::AllyAct
            | Trigger::AllyFuse
            | Trigger::AllyLeaveInHand
            | Trigger::AllyDestroyed { .. }
            | Trigger::LeaderHealed
    ) && !a.effects.iter().any(|e| {
        matches!(
            e,
            Effect::Destroy {
                target: Target::This,
                ..
            }
        )
    })
}

pub fn is_self_destroy_at_opponent_turn_end(a: &Ability) -> bool {
    matches!(
        a.trigger,
        Trigger::TurnEnd {
            whose: Whose::Opponent
        }
    ) && a.effects.iter().any(|e| {
        matches!(
            e,
            Effect::Destroy {
                target: Target::This,
                ..
            }
        )
    })
}

/// ラストワードで得るもの（相手のリーダーへのダメージ・自分のリーダーの回復。定数のものだけ）
pub fn last_words_payoff<'a>(abilities: impl Iterator<Item = &'a Ability>) -> (i32, i32) {
    let mut damage = 0;
    let mut heal = 0;
    for a in abilities {
        if a.trigger.on() != On::LastWords {
            continue;
        }
        for e in &a.effects {
            match e {
                Effect::Damage {
                    target:
                        Target::Leader {
                            side: Side::Opponent,
                        },
                    amount: Value::Num(n),
                } => damage += n,
                Effect::Heal {
                    target: Target::Leader { side: Side::Me },
                    amount: Value::Num(n),
                } => heal += n,
                _ => {}
            }
        }
    }
    (damage, heal)
}

fn countdown_payoff_of(c: CardIdx) -> Option<CountdownPayoff> {
    let cd = card(c);
    if cd.ctype != CardType::Amulet || cd.countdown.is_none() {
        return None;
    }
    let effects: Vec<&Effect> = abilities_of(c)
        .abilities
        .iter()
        .filter(|a| a.trigger.on() == On::LastWords)
        .flat_map(|a| a.effects.iter())
        .collect();
    if effects.is_empty() {
        return None;
    }
    let mut p = CountdownPayoff {
        followers: Vec::new(),
        draws: 0,
    };
    for e in effects {
        match e {
            Effect::Summon {
                card_id,
                count: Value::Num(n),
                ..
            } => {
                let t = card(*card_id);
                if t.ctype != CardType::Follower {
                    return None;
                }
                for _ in 0..*n {
                    p.followers.push((t.attack, t.defense, t.keywords));
                }
            }
            Effect::Draw {
                count: Value::Num(n),
                filter: None,
            } => p.draws += n,
            _ => return None,
        }
    }
    Some(p)
}

pub fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
        let n = data().cards.len();
        let ad = ai_data();
        let all = || 0..n as CardIdx;
        let follower = |c: CardIdx| card(c).ctype == CardType::Follower;
        Tables {
            boostable: all()
                .map(|c| has_on(c, |a| a.trigger.on() == On::Spellboost))
                .collect(),
            boost_grown: all().map(|c| ad.boost_grown.contains(&c)).collect(),
            evolve_ability: all()
                .map(|c| {
                    follower(c)
                        && has_on(c, |a| matches!(a.trigger.on(), On::Evolve | On::Evolved))
                })
                .collect(),
            super_evolve_ability: all()
                .map(|c| {
                    follower(c)
                        && has_on(c, |a| {
                            matches!(a.trigger.on(), On::Evolve | On::Evolved | On::SuperEvolve)
                        })
                })
                .collect(),
            act_storm: all()
                .map(|c| {
                    follower(c)
                        && has_on(c, |a| {
                            a.trigger.on() == On::AllyAct
                                && a.effects.iter().any(|e| {
                                    matches!(e, Effect::Grant { keywords: Some(k), .. } if k.has(STORM))
                                })
                        })
                })
                .collect(),
            has_act: all()
                .map(|c| {
                    card(c).ctype == CardType::Amulet
                        && has_on(c, |a| a.trigger.on() == On::Act)
                })
                .collect(),
            countdown_payoff: all().map(countdown_payoff_of).collect(),
            doomed: all()
                .map(|c| follower(c) && has_on(c, is_self_destroy_at_opponent_turn_end))
                .collect(),
            last_words_payoff: all()
                .map(|c| {
                    if !follower(c) {
                        return None;
                    }
                    let p = last_words_payoff(abilities_of(c).abilities.iter());
                    if p.0 > 0 || p.1 > 0 {
                        Some(p)
                    } else {
                        None
                    }
                })
                .collect(),
            fusion_set: all().map(|c| ad.fusion_set.contains(&c)).collect(),
            passive: all()
                .map(|c| follower(c) && has_on(c, is_passive))
                .collect(),
        }
    })
}

fn countdown_value(
    p: &CountdownPayoff,
    countdown: i32,
    w: &Weights,
    jeanne: Option<&[i32]>,
) -> f64 {
    let mut v = p.draws as f64 * w.my_hand;
    let synced = jeanne.is_some_and(|t| t.contains(&countdown));
    for &(atk, def, kws) in &p.followers {
        v += (atk + if synced { 2 } else { 0 }) as f64 * w.attack
            + (def + if synced { 4 } else { 0 }) as f64 * w.defense
            + w.follower_base;
        for k in kws.iter() {
            v += kw_value(k) * w.keywords;
        }
    }
    v * ai_data().decay_pow(w.countdown_decay, countdown)
}

/// 相手のターン終了時に自壊するフォロワーか（付与されたものも含む）
pub fn is_doomed(f: &OnBoard) -> bool {
    tables().doomed[f.card as usize]
        || f.granted
            .iter()
            .any(|a| is_self_destroy_at_opponent_turn_end(a))
}

fn last_words_amount(s: &GameState, owner: PlayerIndex) -> (i32, i32) {
    let t = tables();
    let me = &s.players[owner];
    let opp = &s.players[opponent(owner)];
    let mut damage = 0;
    let mut heal = 0;
    for c in &me.board {
        if !c.is_follower {
            continue;
        }
        let base = t.last_words_payoff[c.card as usize].unwrap_or((0, 0));
        let extra = if !c.granted.is_empty() {
            last_words_payoff(c.granted.iter().copied())
        } else {
            (0, 0)
        };
        damage += base.0 + extra.0;
        heal += base.1 + extra.1;
    }
    (
        damage.min(opp.leader_hp.max(0)),
        heal.min((me.leader_max_hp - me.leader_hp).max(0)),
    )
}

/// ラストワードで出すフォロワーの価値の合計（倍率を掛ける前）
fn last_words_summon_value<'a>(abilities: impl Iterator<Item = &'a Ability>, w: &Weights) -> f64 {
    let mut v = 0.0;
    for a in abilities {
        if a.trigger.on() != On::LastWords {
            continue;
        }
        for e in &a.effects {
            let Effect::Summon {
                card_id,
                count: Value::Num(n),
                ..
            } = e
            else {
                continue;
            };
            let t = card(*card_id);
            if t.ctype != CardType::Follower {
                continue;
            }
            let mut one =
                t.attack as f64 * w.attack + t.defense as f64 * w.defense + w.follower_base;
            for k in t.keywords.iter() {
                one += kw_value(k) * w.keywords;
            }
            v += one * *n as f64;
        }
    }
    v
}

/// 重みごとの、カードのラストワードで出すフォロワーの価値（lastWordsSummonOf のキャッシュ）
pub struct EvalWeights {
    pub w: Weights,
    summon: OnceLock<Vec<f64>>,
}

impl EvalWeights {
    pub fn new(w: Weights) -> EvalWeights {
        EvalWeights {
            w,
            summon: OnceLock::new(),
        }
    }
    fn summon_of(&self, c: CardIdx) -> f64 {
        self.summon.get_or_init(|| {
            (0..data().cards.len() as CardIdx)
                .map(|c| last_words_summon_value(abilities_of(c).abilities.iter(), &self.w))
                .collect()
        })[c as usize]
    }
}

impl Clone for EvalWeights {
    fn clone(&self) -> Self {
        EvalWeights::new(self.w.clone())
    }
}

fn follower_value(f: &OnBoard, ew: &EvalWeights) -> f64 {
    let w = &ew.w;
    let mut v = f.attack as f64 * w.attack
        + f.temp_attack as f64 * w.temp_attack
        + f.defense as f64 * w.defense
        + w.follower_base;
    for k in f.keywords.iter() {
        v += kw_value(k) * w.keywords;
    }
    for k in f.temp_keywords.iter() {
        v += kw_value(k) * w.keywords;
    }
    if w.passive != 0.0 && tables().passive[f.card as usize] {
        v += w.passive;
    }
    if w.last_words_summon != 0.0 {
        let mut s = ew.summon_of(f.card);
        if !f.granted.is_empty() {
            s += last_words_summon_value(f.granted.iter().copied(), w);
        }
        v += s * w.last_words_summon;
    }
    v
}

fn board_value(c: &OnBoard, ew: &EvalWeights, jeanne: Option<&[i32]>) -> f64 {
    let w = &ew.w;
    if c.is_follower {
        return follower_value(c, ew);
    }
    if let Some(n) = c.sigils {
        return w.sigil_amulet + n as f64 * w.sigil;
    }
    if w.countdown_decay != 0.0 {
        if let Some(cd) = c.countdown {
            if let Some(p) = &tables().countdown_payoff[c.card as usize] {
                return countdown_value(p, cd, w, jeanne);
            }
        }
    }
    w.amulet
}

fn discounted_board_value(c: &OnBoard, ew: &EvalWeights, jeanne: Option<&[i32]>) -> f64 {
    let v = board_value(c, ew, jeanne);
    if ew.w.doomed != 1.0 && c.is_follower && is_doomed(c) {
        v * ew.w.doomed
    } else {
        v
    }
}

const JEANNE_COST: i32 = 8;

fn jeanne_countdowns(s: &GameState, p: PlayerIndex) -> Vec<i32> {
    let me = &s.players[p];
    let mut out = vec![JEANNE_COST - me.turn_count];
    let extra = p != s.first && (me.extra_pp_available || me.turn_count < EXTRA_PP_REFRESH_TURN);
    if extra {
        out.push(JEANNE_COST - 1 - me.turn_count);
    }
    out
}

/// プレイヤー p から見た盤面の評価値（大きいほど p に有利）
pub fn evaluate_with(s: &GameState, p: PlayerIndex, ew: &EvalWeights) -> f64 {
    if s.phase == Phase::Ended {
        return if s.winner == Some(p) { 1e6 } else { -1e6 };
    }
    let w = &ew.w;
    let t = tables();
    let ad = ai_data();
    let me = &s.players[p];
    let opp = &s.players[opponent(p)];
    let mut v = 0.0;
    v += me.leader_hp as f64 * w.my_hp - opp.leader_hp as f64 * w.opp_hp;
    let jeanne = if w.jeanne_sync != 0.0 && me.hand.iter().any(|h| h.card == ad.jeanne) {
        Some(jeanne_countdowns(s, p))
    } else {
        None
    };
    for c in &me.board {
        v += discounted_board_value(c, ew, jeanne.as_deref());
    }
    let mut opp_board = 0.0;
    for c in &opp.board {
        opp_board += discounted_board_value(c, ew, None);
    }
    v -= opp_board * w.opp_board;
    if w.last_words != 0.0 {
        let mine = last_words_amount(s, p);
        let theirs = last_words_amount(s, opponent(p));
        v += (mine.0 as f64 * w.opp_hp + mine.1 as f64 * w.my_hp
            - theirs.0 as f64 * w.my_hp
            - theirs.1 as f64 * w.opp_hp)
            * w.last_words;
    }
    v += me.hand.len() as f64 * w.my_hand - opp.hand.len() as f64 * w.opp_hand;
    for h in &me.hand {
        v += w.hold[h.card as usize];
    }
    if w.fusion_set != 0.0 {
        // 融合できるカードの種類の数（同じカードは 1 つと数える）
        let hand = &me.hand;
        let kinds = (0..hand.len())
            .filter(|&i| {
                let c = hand[i].card;
                t.fusion_set[c as usize] && !hand[..i].iter().any(|h| h.card == c)
            })
            .count();
        v += kinds as f64 * w.fusion_set;
    }
    if w.kuon_reserve != 0.0 && me.sep > 0 && me.hand.iter().any(|h| h.card == ad.kuon) {
        v += w.kuon_reserve;
    }
    if w.evo_reserve != 0.0 {
        let n = me
            .hand
            .iter()
            .filter(|h| t.evolve_ability[h.card as usize])
            .count() as i32;
        let used = match me.ep_evolved_this_turn {
            Some(c) if t.evolve_ability[c as usize] => 1,
            _ => 0,
        };
        v += (n.min(me.ep) + used) as f64 * w.evo_reserve;
    }
    if w.sevo_reserve != 0.0 {
        let n = me
            .hand
            .iter()
            .filter(|h| t.super_evolve_ability[h.card as usize])
            .count() as i32;
        let used = match me.sep_evolved_this_turn {
            Some(c) if t.super_evolve_ability[c as usize] => 1,
            _ => 0,
        };
        v += (n.min(me.sep) + used) as f64 * w.sevo_reserve;
    }
    if w.kerberos_reserve != 0.0 {
        if me.sep > 0 && me.hand.iter().any(|h| h.card == ad.kerberos) {
            v += w.kerberos_reserve;
        }
        if me.sep_evolved_this_turn == Some(ad.kerberos) {
            v += w.kerberos_reserve;
        }
    }
    if w.boost_card != 0.0 || w.boost != 0.0 {
        for h in &me.hand {
            if t.boost_grown[h.card as usize] {
                v += w.boost_card + w.boost_cap * w.boost;
            } else if t.boostable[h.card as usize] {
                v += w.boost_card + (h.boosts as f64).min(w.boost_cap) * w.boost;
            }
        }
    }
    v += me.ep as f64 * w.ep + me.sep as f64 * w.sep;
    if me.extra_pp_available {
        v += w.extra_pp;
    }
    v += (me.max_pp - me.turn_count.min(MAX_PP)) as f64 * w.max_pp;
    v += (me.crests.len() as i32 - opp.crests.len() as i32) as f64 * w.crest;
    v += me.graveyard.min(10) as f64 * w.graveyard;
    if opp.leader_hp as f64 <= w.lethal_range {
        for c in &me.board {
            if c.is_follower {
                v += c.attack as f64
                    * w.lethal_attack
                    * if w.doomed != 1.0 && is_doomed(c) {
                        w.doomed
                    } else {
                        1.0
                    };
            }
        }
        if w.hand_storm != 0.0 && me.board.iter().any(|c| t.has_act[c.card as usize]) {
            let next_pp = MAX_PP.min(me.max_pp + 1);
            for h in &me.hand {
                let cd = card(h.card);
                if cd.ctype == CardType::Follower
                    && t.act_storm[h.card as usize]
                    && cd.cost <= next_pp
                {
                    v += cd.attack as f64 * w.hand_storm;
                }
            }
        }
    }
    v
}
