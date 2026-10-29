//! 素材を入れすぎる融合（探索で展開しない融合。SearchOptions.fuseMinimal。2026-10-29、ユーザーの指摘）。
//!
//! 融合は PP を使わず、作ったカードはまた素材にできるので、同じ融合先をより少ない素材で作れる融合は、残る手札がいつも劣る。
//! そういう融合を探索で展開しないと、手札にコアが多い局面で数十通りある融合の手が減り、ビームが同じような融合の並びで埋まりにくくなる。
//! 例: 手札がフューチャー・コア 2・パスト・コア 2・キャッスル・アタックなら、融合の手は 44 通りから 16 通りになる。

use super::keys::state_eq;
use crate::data::{CardIdx, Effect, On, Value};
use crate::effects::board_abilities_on;
use crate::game::try_apply_action;
use crate::state::{hand_cost, Action, GameState, HandCard, PlayerIndex};
use std::cell::RefCell;
use std::collections::HashMap;

/// 手札のカードの、融合の結果に関わるところ（カード・手札でのコスト・融合した種類・このターンに融合したか）
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct CardKey {
    card: CardIdx,
    cost: i32,
    kinds: Vec<CardIdx>,
    fused: bool,
}

fn key_of(h: &HandCard) -> CardKey {
    let mut kinds = h.fused_kinds.clone();
    kinds.sort_unstable();
    CardKey {
        card: h.card,
        cost: hand_cost(h),
        kinds,
        fused: h.fused_this_turn,
    }
}

/// (融合先, 素材) → 融合した後の融合先（融合できないなら None）
type Outcomes = HashMap<(CardKey, Vec<CardKey>), Option<HandCard>>;

thread_local! {
    static OUTCOMES: RefCell<Outcomes> = RefCell::new(HashMap::new());
}

/// 手札が host と mats だけの局面で host に mats を融合した後の host（融合できないなら None）。
/// 結果はカードの中身だけで決まるとみなして覚えておく（アーティファクトの変身は、融合した素材のコストの合計と種類の数だけで決まる）
fn outcome(s: &GameState, p: PlayerIndex, host: &HandCard, mats: &[&HandCard]) -> Option<HandCard> {
    let mut mk: Vec<CardKey> = mats.iter().map(|m| key_of(m)).collect();
    mk.sort_unstable();
    let key = (key_of(host), mk);
    if let Some(r) = OUTCOMES.with(|c| c.borrow().get(&key).cloned()) {
        return r;
    }
    let mut t = s.clone();
    t.pending = None;
    let mut hand = vec![host.clone()];
    for m in mats {
        let mut m = (*m).clone();
        m.iid = t.new_iid();
        hand.push(m);
    }
    let materials = hand[1..].iter().map(|h| h.iid).collect();
    *t.players[p].hand.make_mut() = hand;
    let r = try_apply_action(
        &t,
        &Action::Fuse {
            host: host.iid,
            materials,
        },
    )
    .and_then(|u| {
        u.players[p]
            .hand
            .iter()
            .find(|h| h.iid == host.iid)
            .cloned()
    });
    OUTCOMES.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() > 100_000 {
            c.clear();
        }
        c.insert(key, r.clone());
    });
    r
}

fn same(a: &HandCard, b: &HandCard) -> bool {
    key_of(a) == key_of(b)
}

/// このターンに融合したかを見ずに同じカードか（融合した後のほうが、このターンにもう融合できない分だけ劣る）
fn same_card(a: &HandCard, b: &HandCard) -> bool {
    let (x, y) = (key_of(a), key_of(b));
    (x.card, x.cost, x.kinds) == (y.card, y.cost, y.kinds)
}

/// 添字 skip を除いた素材
fn without<'a>(mats: &[&'a HandCard], skip: &[usize]) -> Vec<&'a HandCard> {
    mats.iter()
        .enumerate()
        .filter(|(i, _)| !skip.contains(i))
        .map(|(_, m)| *m)
        .collect()
}

/// 添字の並びから、同じ中身のカードを 2 回目以降は除いたもの
fn distinct(mats: &[&HandCard], idx: impl Iterator<Item = usize>) -> Vec<usize> {
    let mut seen: Vec<CardKey> = Vec::new();
    idx.filter(|&i| {
        let k = key_of(mats[i]);
        if seen.contains(&k) {
            false
        } else {
            seen.push(k);
            true
        }
    })
    .collect()
}

/// 手 a（局面 s の合法手）が、素材を入れすぎる融合か。次のどれかなら入れすぎ:
/// 1. 素材のどれか 1 枚を除いても、融合先が同じカードになる（融合した種類も同じ）
/// 2. 素材のうち 2 枚を先に融合して作ったカードを素材にすれば、素材の別の 1 枚を除いても融合先が同じカードになる
///    （例: キャッスルにコア 3 枚 → γ は、コア 2 枚 → アタック、キャッスルにアタック → γ でコアが 1 枚残る）
/// 3. 融合した結果が、融合する前の融合先か素材のどれか 1 枚と同じカードで（カードを捨てるだけ。アタックに γ → γ、
///    β を融合済みの α に β など）、融合しても手札の外に何も起きない（遺産の砲撃が場にあればダメージが出るので残す）
///
/// 1・2 は同じ融合先を素材を 1 枚少なく使って作れ（もう 1 回融合が要ることはある）、3 は融合しないほうが手札が多く残る
pub fn excessive_fusion(s: &GameState, a: &Action) -> bool {
    let Action::Fuse { host, materials } = a else {
        return false;
    };
    let p = s.active;
    let hand = &s.players[p].hand;
    let Some(h) = hand.iter().find(|c| c.iid == *host) else {
        return false;
    };
    let mats: Vec<&HandCard> = materials
        .iter()
        .filter_map(|m| hand.iter().find(|c| c.iid == *m))
        .collect();
    let Some(full) = outcome(s, p, h, &mats) else {
        return false;
    };
    // 3. カードを捨てるだけ（手札の外に何も起きないかは、その局面で実際に融合して確かめる）
    if (same_card(&full, h) || mats.iter().any(|m| same_card(&full, m)))
        && try_apply_action(s, a).is_some_and(|mut u| {
            u.players[p].hand = s.players[p].hand.clone();
            state_eq(&u, s)
        })
    {
        return true;
    }
    let n = mats.len();
    if n < 2 {
        return false;
    }
    // 1. 1 枚除いても同じ
    for i in distinct(&mats, 0..n) {
        if outcome(s, p, h, &without(&mats, &[i])).is_some_and(|o| same(&o, &full)) {
            return true;
        }
    }
    // 2. 2 枚を先に融合したカードを使えば、別の 1 枚を除いても同じ
    if n < 3 {
        return false;
    }
    let mut tried: Vec<(CardKey, CardKey)> = Vec::new();
    for i in 0..n {
        for j in 0..n {
            if i == j {
                continue;
            }
            let pair = (key_of(mats[i]), key_of(mats[j]));
            if tried.contains(&pair) {
                continue;
            }
            tried.push(pair);
            let Some(made) = outcome(s, p, mats[i], &[mats[j]]) else {
                continue;
            };
            let rest = without(&mats, &[i, j]);
            for k in distinct(&rest, 0..rest.len()) {
                let mut m2 = without(&rest, &[k]);
                m2.push(&made);
                if outcome(s, p, h, &m2).is_some_and(|o| same(&o, &full)) {
                    return true;
                }
            }
        }
    }
    false
}

/// 自分の場のフォロワーのラストワードが手札に加える・引くカードの枚数（相手のターンに破壊されると、次のターンの最初に引く前に手札が増える。
/// ビビッドインベンター・イリスのパスト・コア等）。枚数が能力で決まるものは 1 枚と数える
pub fn last_words_to_hand(s: &GameState, p: PlayerIndex) -> usize {
    s.players[p]
        .board
        .iter()
        .filter(|c| c.is_follower)
        .flat_map(|c| board_abilities_on(c, On::LastWords))
        .flat_map(|a| a.effects.iter())
        .map(|e| match e {
            Effect::AddToHand { count, .. } | Effect::Draw { count, .. } => match count {
                Value::Num(n) => (*n).max(0) as usize,
                Value::Obj(_) => 1,
            },
            _ => 0,
        })
        .sum()
}
