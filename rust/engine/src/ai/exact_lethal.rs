//! 全探索のリーサル探索（src/ai/exactLethal.ts）。ターン終了以外のすべての手を深さ優先で試し、同じ局面はまとめる。
//!
//! メモのキーは TypeScript 版の文字列と同じものを同じと見なす（中身の書き方は違ってよい）。
//! キーの区別の細かさが違うと、メモの当たり方が変わり、見つかる手順や打ち切りの位置が変わる。

use super::damage_bound::damage_bound;
use super::Rng;
use crate::data::CardIdx;
use crate::fasthash::FastMap;
use crate::game::{legal_actions, try_apply_action};
use crate::state::*;
use std::cell::RefCell;
use std::fmt::Write;

pub type OrderFn = fn(&GameState, PlayerIndex, Vec<Action>) -> Vec<Action>;
pub type ForcedFn = fn(&GameState, PlayerIndex, &[Action]) -> Option<Action>;
pub type MatchFn = fn(&GameState, &Action) -> bool;
pub type FeasibleFn = fn(&GameState, PlayerIndex, i32) -> bool;

/// 手順の中で必ず count 回打つ手（matches）。feasible が false の局面（残り remaining 回をもう打てない）は調べない
#[derive(Clone, Copy)]
pub struct MustPlay {
    pub count: i32,
    pub matches: MatchFn,
    pub feasible: FeasibleFn,
}

/// 手順の中で高々 count 回しか打たない手（matches）
#[derive(Clone, Copy)]
pub struct MaxPlay {
    pub count: i32,
    pub matches: MatchFn,
}

/// 全探索の設定（exactLethal.ts の ExactLethalOptions）
#[derive(Clone)]
pub struct ExactLethalOptions {
    pub order: Option<OrderFn>,
    pub order_key: Option<&'static str>,
    pub max_states: i64,
    pub max_states_per_turn: i64,
    pub forced: Option<ForcedFn>,
    pub deterministic_only: bool,
    pub must_play: Option<MustPlay>,
    pub max_play: Option<MaxPlay>,
    pub ignore_exhausted_stats: bool,
    pub leader_only: Vec<Iid>,
    pub no_play: Vec<Iid>,
    /// 残りで与えうるダメージの上限（damage_bound）が相手の残り体力に届かない局面で打ち切る
    pub damage_bound: bool,
    /// damage_bound のほかに使う上限（デッキ専用の見積もり。見積もれなければ None）。damage_bound が true のときだけ使い、両方あれば小さいほう
    pub extra_bound: Option<BoundFn>,
}

pub type BoundFn = fn(&GameState, PlayerIndex) -> Option<i32>;

pub const DEFAULT_EXACT_LETHAL_OPTIONS: ExactLethalOptions = ExactLethalOptions {
    order: None,
    order_key: None,
    max_states: 100_000,
    max_states_per_turn: 200_000,
    forced: None,
    deterministic_only: false,
    must_play: None,
    max_play: None,
    ignore_exhausted_stats: false,
    leader_only: Vec::new(),
    no_play: Vec::new(),
    damage_bound: true,
    extra_bound: None,
};

/// 乱数に依らない手だけで、局面数を絞った全探索（ビームで見つからないリーサルの確かめ用。ターンあたりは上限の 2 倍まで）
pub fn sure_lethal_options(max_states: i64) -> ExactLethalOptions {
    ExactLethalOptions {
        deterministic_only: true,
        max_states,
        max_states_per_turn: max_states * 2,
        ..DEFAULT_EXACT_LETHAL_OPTIONS
    }
}

/// 対戦画面のリーサル表示がビームの後に調べる全探索の局面数の上限
pub const HINT_EXACT_STATES: i64 = 20_000;

thread_local! {
    /// 付与された能力の中身ごとの番号（TypeScript 版は能力の JSON をキーに入れる）
    static GRANTED_IDS: RefCell<(FastMap<usize, u32>, FastMap<String, u32>)> = RefCell::new(Default::default());
}

fn granted_id(a: &'static crate::data::Ability) -> u32 {
    GRANTED_IDS.with(|g| {
        let mut g = g.borrow_mut();
        let ptr = a as *const _ as usize;
        if let Some(&id) = g.0.get(&ptr) {
            return id;
        }
        let text = format!("{a:?}");
        let next = g.1.len() as u32;
        let id = *g.1.entry(text).or_insert(next);
        g.0.insert(ptr, id);
        id
    })
}

/// メモのキー。数の列で、長さの変わる部分には長さを先に入れて区切りが曖昧にならないようにする。
/// 以前は文字列だったが、作るのが遅かった（全探索の時間の半分ほど）。同じと見なす局面は文字列のときと同じ
pub type LethalKey = Vec<i32>;

#[inline]
fn push_opt(k: &mut LethalKey, v: Option<i32>) {
    match v {
        None => k.push(0),
        Some(x) => {
            k.push(1);
            k.push(x);
        }
    }
}

#[inline]
fn push_kw(k: &mut LethalKey, kw: crate::data::Kw) {
    let seq = kw.seq();
    k.push(seq as u32 as i32);
    k.push((seq >> 32) as u32 as i32);
}

fn push_sorted_cards(k: &mut LethalKey, cards: impl Iterator<Item = CardIdx>) {
    let mut v: Vec<CardIdx> = cards.collect();
    v.sort_unstable();
    k.push(v.len() as i32);
    k.extend(v.iter().map(|&c| c as i32));
}

/// 「自分のターンごとに1回」の記録（TypeScript 版は能力の添字の文字列をキーにした記録で、JSON では添字の小さい順）
fn used_once_key(out: &mut LethalKey, used: &[(u8, i32)]) {
    let mut v = used.to_vec();
    v.sort_unstable_by_key(|e| e.0);
    out.push(v.len() as i32);
    for (i, t) in v {
        out.push(i as i32);
        out.push(t);
    }
}

fn hand_key(k: &mut LethalKey, h: &HandCard) {
    k.extend([h.card as i32, h.cost_mod, h.attack_mod, h.defense_mod]);
    push_opt(k, h.x);
    push_kw(k, h.keywords);
    k.push(h.fused_kinds.len() as i32);
    k.extend(h.fused_kinds.iter().map(|&c| c as i32));
    k.push(h.fused_this_turn as i32);
}

fn board_key(k: &mut LethalKey, c: &OnBoard, ignore_exhausted_stats: bool) {
    let granted = |k: &mut LethalKey| {
        push_kw(k, c.keywords);
        push_kw(k, c.temp_keywords);
        k.push(c.granted.len() as i32);
        k.extend(c.granted.iter().map(|&a| granted_id(a) as i32));
    };
    if !c.is_follower {
        k.extend([0, c.card as i32]);
        push_opt(k, c.countdown);
        push_opt(k, c.sigils);
        k.push(c.acted_this_turn as i32);
        granted(k);
        return;
    }
    if ignore_exhausted_stats && c.attacks_this_turn >= c.max_attacks {
        k.extend([
            1,
            c.card as i32,
            c.max_attacks,
            c.attacks_this_turn,
            c.evolve as i32,
        ]);
    } else {
        k.extend([
            2,
            c.card as i32,
            c.attack,
            c.defense,
            c.max_defense,
            c.temp_attack,
            c.max_attacks,
            c.attacks_this_turn,
            c.entered_turn,
            c.evolve as i32,
        ]);
        push_opt(k, c.cannot_attack_until);
        push_opt(k, c.x);
    }
    granted(k);
    used_once_key(k, &c.used_once);
}

/// items のキーを順番によらない形で足す（各キーを並べ替えて、個数と長さ付きで並べる）
fn push_unordered<T>(k: &mut LethalKey, items: &[T], key: impl Fn(&mut LethalKey, &T)) {
    let mut buf: LethalKey = Vec::new();
    let mut ranges: Vec<(usize, usize)> = Vec::with_capacity(items.len());
    for it in items {
        let start = buf.len();
        key(&mut buf, it);
        ranges.push((start, buf.len()));
    }
    ranges.sort_unstable_by(|a, b| buf[a.0..a.1].cmp(&buf[b.0..b.1]));
    k.push(ranges.len() as i32);
    for (a, b) in ranges {
        k.push((b - a) as i32);
        k.extend_from_slice(&buf[a..b]);
    }
}

/// 相手（opponent）は体力と手札の中身を含めない。
/// 手札のスペルブーストの回数（boosts）は数えるだけでルールに使わない（効果はコストや X の変化として残る）ので含めない。
/// 破壊された記録は順番を除いた中身で比べる（記録のスタッツはカードの元のスタッツなので、カードだけでよい）
fn player_key(out: &mut LethalKey, pl: &PlayerState, opponent: bool, ignore_exhausted_stats: bool) {
    if !opponent {
        out.push(pl.leader_hp);
    }
    out.extend([
        pl.pp,
        pl.max_pp,
        pl.combo,
        pl.ep,
        pl.sep,
        pl.evolved_this_turn as i32,
        pl.extra_pp_available as i32,
        pl.deck.len() as i32,
        pl.graveyard,
    ]);
    push_sorted_cards(out, pl.graveyard_followers.iter().copied());
    push_sorted_cards(out, pl.destroyed_this_turn.iter().map(|r| r.card));
    push_sorted_cards(out, pl.destroyed_amulets.iter().copied());
    out.push(pl.crests.len() as i32);
    for c in &pl.crests {
        out.push(c.crest as i32);
        push_opt(out, c.countdown);
        used_once_key(out, &c.used_once);
    }
    if opponent {
        out.push(pl.hand.len() as i32);
    } else {
        push_unordered(out, &pl.hand, hand_key);
    }
    let ignore = !opponent && ignore_exhausted_stats;
    push_unordered(out, &pl.board, |k, c| board_key(k, c, ignore));
}

fn is_transient(s: &GameState) -> bool {
    s.pending.is_some() || !s.stack.is_empty() || !s.queue.is_empty()
}

/// 局面のキー（相手 opp のリーダーの体力と手札の中身、手札・場の並び順、インスタンス ID を除く）
pub fn lethal_key(
    out: &mut LethalKey,
    s: &GameState,
    opp: PlayerIndex,
    ignore_exhausted_stats: bool,
) {
    out.push(s.active as i32);
    player_key(out, &s.players[0], opp == 0, ignore_exhausted_stats);
    player_key(out, &s.players[1], opp == 1, ignore_exhausted_stats);
    if is_transient(s) {
        // 選択待ち・解決中（まれ）は中身をそのまま入れる
        push_text(out, &format!("{:?}{:?}{:?}", s.pending, s.stack, s.queue));
    } else {
        out.push(-1);
    }
}

/// 文字列を長さ付きでキーに足す
fn push_text(out: &mut LethalKey, text: &str) {
    out.push(text.len() as i32);
    out.extend(text.bytes().map(|b| b as i32));
}

/// 探索で得た値の意味
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Bound {
    /// ここから与えられる最大のダメージ
    Exact,
    /// 与えられるダメージ（求める値に届いたので打ち切った。最大はこれ以上）
    Lower,
    /// 最大のダメージはこれ以下（上限の見積もりで打ち切ったところがある）
    Upper,
}

/// 同じターンの間はメモを使い回す（局面のキー → 値とその意味）
struct TurnCache {
    turn: i32,
    player: PlayerIndex,
    memo: FastMap<LethalKey, (i32, Bound)>,
    visited: i64,
}

thread_local! {
    /// deterministicOnly かどうかで試す手が違うので、メモを分ける（0: すべて、1: deterministicOnly）
    static CACHES: RefCell<[Option<TurnCache>; 2]> = const { RefCell::new([None, None]) };
}

const MAX_CACHE: usize = 500_000;

thread_local! {
    /// 全探索をした回数と、リーサルを見つけた回数（実験の集計用。reset_exact_lethal_cache で 0 に戻る）
    static COUNTS: RefCell<(u32, u32)> = const { RefCell::new((0, 0)) };
}

/// 全探索をした回数と、リーサルを見つけた回数
pub fn exact_lethal_counts() -> (u32, u32) {
    COUNTS.with(|c| *c.borrow())
}

/// メモを捨てる（新しい試合を始めるとき）
pub fn reset_exact_lethal_cache() {
    CACHES.with(|c| *c.borrow_mut() = [None, None]);
    COUNTS.with(|c| *c.borrow_mut() = (0, 0));
}

const ALT_SEEDS: [u32; 3] = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];

/// 乱数の状態と p の山札の順番だけを変えた局面
fn with_other_random(s: &GameState, p: PlayerIndex, seed: u32) -> GameState {
    let rng = s.rng ^ seed;
    let mut x = s.clone();
    Rng::new(rng).shuffle(x.players[p].deck.make_mut());
    x.rng = rng;
    x
}

/// 手 a の結果が乱数で変わるか
pub fn varies_with_random(s: &GameState, a: &Action, next: &GameState, p: PlayerIndex) -> bool {
    if next.rng == s.rng {
        return false;
    }
    let opp = opponent(p);
    let key = |x: &GameState| {
        let phase = match x.phase {
            Phase::Mulligan => 0,
            Phase::Main => 1,
            Phase::Ended => 2,
        };
        let mut k = vec![x.players[opp].leader_hp, phase];
        lethal_key(&mut k, x, opp, false);
        k
    };
    let expected = key(next);
    ALT_SEEDS.iter().any(
        |&seed| match try_apply_action(&with_other_random(s, p, seed), a) {
            None => true,
            Some(alt) => key(&alt) != expected,
        },
    )
}

/// p が山札からカードを手札に加えたか（引くカードは山札の順番に依るので、乱数に依らない手だけを調べるときは除く。
/// varies_with_random でもほとんど除かれるが、山札が同じカードばかりのときも除いて、damage_bound と揃える）
fn drew_from_deck(s: &GameState, next: &GameState, p: PlayerIndex) -> bool {
    let deck = &s.players[p].deck;
    next.players[p]
        .hand
        .iter()
        .any(|h| deck.iter().any(|r| r.iid == h.iid))
}

fn actor_of(s: &GameState) -> PlayerIndex {
    s.pending.as_ref().map_or(s.active, |pd| pd.player())
}

struct Abort;

struct Dfs<'a> {
    opts: &'a ExactLethalOptions,
    p: PlayerIndex,
    opp: PlayerIndex,
    prefix: LethalKey,
    memo: &'a mut FastMap<LethalKey, (i32, Bound)>,
    visited: i64,
    limit: i64,
}

impl Dfs<'_> {
    /// played は mustPlay（なければ maxPlay）の手を打った回数
    fn candidates(&self, s: &GameState, played: i32) -> Vec<Action> {
        let o = self.opts;
        let legal: Vec<Action> = legal_actions(s)
            .into_iter()
            .filter(|a| match a {
                Action::EndTurn => false,
                Action::Attack {
                    attacker,
                    target: Some(_),
                } if o.leader_only.contains(attacker) => false,
                Action::Play(iid) if o.no_play.contains(iid) => false,
                _ => !o
                    .max_play
                    .is_some_and(|m| played >= m.count && (m.matches)(s, a)),
            })
            .collect();
        let forced = if s.pending.is_some() {
            None
        } else {
            o.forced.and_then(|f| f(s, self.p, &legal))
        };
        match (forced, o.order) {
            (Some(f), _) => vec![f],
            (None, Some(order)) => order(s, self.p, legal),
            (None, None) => legal,
        }
    }

    fn played_after(&self, s: &GameState, a: &Action, played: i32) -> i32 {
        let o = self.opts;
        let counted = o
            .must_play
            .map(|m| m.matches)
            .or(o.max_play.map(|m| m.matches));
        match counted {
            Some(f)
                if (o.max_play.is_some() || played < o.must_play.map_or(0, |m| m.count))
                    && f(s, a) =>
            {
                played + 1
            }
            _ => played,
        }
    }

    fn remaining_of(&self, played: i32) -> i32 {
        (self.opts.must_play.map_or(0, |m| m.count) - played).max(0)
    }

    /// 打ってよい手なら、打った局面と相手リーダーへのダメージ
    fn try_step(&self, s: &GameState, a: &Action) -> Option<(GameState, i32)> {
        let next = try_apply_action(s, a)?;
        if next.phase == Phase::Ended && next.winner != Some(self.p) {
            return None;
        }
        if self.opts.deterministic_only
            && (drew_from_deck(s, &next, self.p) || varies_with_random(s, a, &next, self.p))
        {
            return None;
        }
        let dealt = s.players[self.opp].leader_hp - next.players[self.opp].leader_hp;
        Some((next, dealt))
    }

    /// s から与えられる最大のダメージ（need 以上が見つかればそこで打ち切った値。need に届かないときは上限のこともある）
    fn dfs(&mut self, s: &GameState, need: i32, played: i32) -> Result<i32, Abort> {
        self.dfs_bound(s, need, played).map(|r| r.0)
    }

    fn dfs_bound(&mut self, s: &GameState, need: i32, played: i32) -> Result<(i32, Bound), Abort> {
        if s.phase != Phase::Main || actor_of(s) != self.p {
            return Ok((0, Bound::Exact));
        }
        let remaining = self.remaining_of(played);
        if let Some(m) = self.opts.must_play {
            if remaining > 0 && !is_transient(s) && !(m.feasible)(s, self.p, remaining) {
                return Ok((0, Bound::Exact));
            }
        }
        // 選択待ち・解決中の局面はメモしない
        let key = if is_transient(s) {
            None
        } else {
            let mut k = self.prefix.clone();
            let n = if self.opts.max_play.is_some() {
                played
            } else {
                remaining
            };
            k.push(n);
            lethal_key(&mut k, s, self.opp, self.opts.ignore_exhausted_stats);
            Some(k)
        };
        if let Some(k) = &key {
            if let Some(&(damage, b)) = self.memo.get(k) {
                let usable = match b {
                    Bound::Exact => true,
                    Bound::Lower => damage >= need,
                    Bound::Upper => damage < need,
                };
                if usable {
                    return Ok((damage, b));
                }
            }
            if self.opts.damage_bound {
                let generic = damage_bound(s, self.p, !self.opts.deterministic_only);
                let extra = self.opts.extra_bound.and_then(|f| f(s, self.p));
                let bound = match (generic, extra) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
                if let Some(u) = bound {
                    if u < need {
                        self.memo.insert(k.clone(), (u, Bound::Upper));
                        return Ok((u, Bound::Upper));
                    }
                }
            }
        }
        self.visited += 1;
        if self.visited > self.limit {
            return Err(Abort);
        }
        let mut best = 0;
        let mut upper = false;
        if let Some(k) = &key {
            self.memo.insert(k.clone(), (0, Bound::Lower));
        }
        for a in self.candidates(s, played) {
            let Some((next, dealt)) = self.try_step(s, &a) else {
                continue;
            };
            let after = self.played_after(s, &a, played);
            let (d, b) = self.dfs_bound(&next, need - dealt, after)?;
            upper |= b == Bound::Upper;
            let damage = dealt + d;
            if damage > best {
                best = damage;
            }
            if best >= need {
                break;
            }
        }
        // 打ち切ったなら best は最大値ではない（下限）。上限で打ち切った子があれば best は上限
        let b = if best >= need {
            Bound::Lower
        } else if upper {
            Bound::Upper
        } else {
            Bound::Exact
        };
        if let Some(k) = key {
            self.memo.insert(k, (best, b));
        }
        Ok((best, b))
    }

    fn trace(&mut self, root: &GameState) -> Result<Option<Vec<Action>>, Abort> {
        let mut need = root.players[self.opp].leader_hp;
        let mut played = 0;
        let mut seq = Vec::new();
        if self.dfs(root, need, played)? < need {
            return Ok(None);
        }
        // ダメージが足りる手を順にたどる
        let mut s = root.clone();
        while s.phase != Phase::Ended {
            let mut found: Option<(Action, GameState, i32)> = None;
            for a in self.candidates(&s, played) {
                let Some((next, dealt)) = self.try_step(&s, &a) else {
                    continue;
                };
                let after = self.played_after(&s, &a, played);
                if dealt + self.dfs(&next, need - dealt, after)? >= need {
                    found = Some((a, next, dealt));
                    break;
                }
            }
            let Some((a, next, dealt)) = found else {
                return Ok(None);
            };
            played = self.played_after(&s, &a, played);
            seq.push(a);
            s = next;
            need -= dealt;
        }
        Ok(if s.winner == Some(self.p) {
            Some(seq)
        } else {
            None
        })
    }
}

fn ids(xs: &[Iid]) -> String {
    let mut v = xs.to_vec();
    v.sort_unstable();
    v.dedup();
    v.iter()
        .map(|x| x.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// 相手リーダーを倒しきる手順を全探索で探す。見つかれば手順、無いか局面が多すぎれば None
pub fn search_exact_lethal(
    root: &GameState,
    p: PlayerIndex,
    opts: &ExactLethalOptions,
) -> Option<Vec<Action>> {
    if root.phase != Phase::Main || actor_of(root) != p {
        return None;
    }
    let opp = opponent(p);
    let kind = opts.deterministic_only as usize;
    let mut cache = CACHES
        .with(|c| c.borrow_mut()[kind].take())
        .filter(|c| c.turn == root.turn && c.player == p && c.memo.len() <= MAX_CACHE)
        .unwrap_or_else(|| TurnCache {
            turn: root.turn,
            player: p,
            memo: FastMap::default(),
            visited: 0,
        });
    let limit = opts
        .max_states
        .min(opts.max_states_per_turn - cache.visited);
    let result = if limit <= 0 {
        None
    } else {
        COUNTS.with(|c| c.borrow_mut().0 += 1);
        let mut prefix = String::new();
        if !opts.leader_only.is_empty() || !opts.no_play.is_empty() {
            let _ = write!(prefix, "{}/{}/", ids(&opts.leader_only), ids(&opts.no_play));
        }
        if let Some(m) = opts.max_play {
            let _ = write!(
                prefix,
                "{}<{}/",
                opts.must_play.map_or(0, |x| x.count),
                m.count
            );
        }
        if let Some(k) = opts.order_key {
            let _ = write!(prefix, "{k}/");
        }
        let mut key = Vec::new();
        push_text(&mut key, &prefix);
        let mut dfs = Dfs {
            opts,
            p,
            opp,
            prefix: key,
            memo: &mut cache.memo,
            visited: 0,
            limit,
        };
        let r = dfs.trace(root).unwrap_or(None);
        cache.visited += dfs.visited;
        if r.is_some() {
            COUNTS.with(|c| c.borrow_mut().1 += 1);
        }
        r
    };
    CACHES.with(|c| c.borrow_mut()[kind] = Some(cache));
    result
}

/// root から p がこのターンに相手リーダーへ与えられる最大のダメージ（全探索。局面が多すぎれば None。
/// damage_bound が多めに見積もっているかを確かめる用で、メモは使い回さない）
pub fn exact_max_damage(
    root: &GameState,
    p: PlayerIndex,
    opts: &ExactLethalOptions,
) -> Option<i32> {
    if root.phase != Phase::Main || actor_of(root) != p {
        return None;
    }
    let mut memo = FastMap::default();
    let mut dfs = Dfs {
        opts,
        p,
        opp: opponent(p),
        prefix: vec![0],
        memo: &mut memo,
        visited: 0,
        limit: opts.max_states,
    };
    match dfs.dfs_bound(root, i32::MAX / 2, 0) {
        Ok((d, Bound::Exact)) => Some(d),
        _ => None,
    }
}
