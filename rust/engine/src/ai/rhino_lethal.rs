//! リノセウスエルフ専用のリーサル探索（src/ai/rhinoLethal.ts）。
//! ターンを「準備」（ビームサーチ）と「仕上げ」（リノセウスを出して殴り切る決まった形）に分ける。

use super::keys::{board_eq, crest_eq, hand_eq, mix, stack_eq, EqSet};
use crate::data::{data, WARD};
use crate::game::{legal_actions, try_apply_action};
use crate::state::*;
use std::sync::OnceLock;

/// リノセウス用 AI が名前で見分けるカード（名前の比較を毎回しないよう、カードの添字ごとに表にする）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tag {
    Other,
    Rhino,
    Rod,
    Rock,
    Mystery,
    Bugs,
    Carbuncle,
    Backwood,
    Bail,
    Lily,
    Olivier,
    Tamer,
    WaterFairy,
    FairyCall,
    May,
    Fairy,
}

const TAG_NAMES: [(Tag, &str); 15] = [
    (Tag::Rhino, "殺戮のリノセウス"),
    (Tag::Rod, "聖樹の杖"),
    (Tag::Rock, "燐光の岩"),
    (Tag::Mystery, "森の神秘"),
    (Tag::Bugs, "虫の知らせ"),
    (Tag::Carbuncle, "ベビーカーバンクル"),
    (Tag::Backwood, "薫交の天宮・バックウッド"),
    (Tag::Bail, "煌撃の戦士・ベイル"),
    (Tag::Lily, "ピュアクリスタリア・リリィ"),
    (Tag::Olivier, "勇壮の堕天使・オリヴィエ"),
    (Tag::Tamer, "フェアリーテイマー"),
    (Tag::WaterFairy, "純粋なるウォーターフェアリー"),
    (Tag::FairyCall, "妖精の招集"),
    (Tag::May, "アドベンチャーエルフ・メイ"),
    (Tag::Fairy, "フェアリー"),
];

/// カードの名前の種類
#[inline]
pub fn tag(c: crate::data::CardIdx) -> Tag {
    static TAGS: OnceLock<Vec<Tag>> = OnceLock::new();
    TAGS.get_or_init(|| {
        data()
            .cards
            .iter()
            .map(|card| {
                TAG_NAMES
                    .iter()
                    .find(|(_, n)| card.name == *n)
                    .map_or(Tag::Other, |(t, _)| *t)
            })
            .collect()
    })[c as usize]
}

pub const RHINO: Tag = Tag::Rhino;
pub const ROD: Tag = Tag::Rod;
pub const ROCK: Tag = Tag::Rock;
pub const MYSTERY: Tag = Tag::Mystery;
pub const BUGS: Tag = Tag::Bugs;
pub const CARBUNCLE: Tag = Tag::Carbuncle;

pub struct RhinoLethalOptions {
    pub beam_width: usize,
    pub max_depth: usize,
}

pub const DEFAULT_RHINO_LETHAL_OPTIONS: RhinoLethalOptions = RhinoLethalOptions {
    beam_width: 16,
    max_depth: 10,
};

#[inline]
pub fn named(c: crate::data::CardIdx, name: Tag) -> bool {
    tag(c) == name
}

#[derive(Clone)]
struct Line {
    state: GameState,
    seq: Vec<Action>,
}

fn step(line: Option<&Line>, action: Option<Action>) -> Option<Line> {
    let line = line?;
    let action = action?;
    if line.state.phase == Phase::Ended {
        return Some(line.clone());
    }
    let state = try_apply_action(&line.state, &action)?;
    let mut seq = line.seq.clone();
    seq.push(action);
    Some(Line { state, seq })
}

pub fn hand_iid(s: &GameState, p: PlayerIndex, name: Tag) -> Option<Iid> {
    s.players[p]
        .hand
        .iter()
        .find(|h| named(h.card, name))
        .map(|h| h.iid)
}

pub fn board_iids(s: &GameState, p: PlayerIndex, name: Tag) -> Vec<Iid> {
    s.players[p]
        .board
        .iter()
        .filter(|c| named(c.card, name))
        .map(|c| c.iid)
        .collect()
}

fn play(iid: Option<Iid>) -> Option<Action> {
    iid.map(Action::Play)
}

/// 選択待ちなら target を選ぶ（選択待ちでなければそのまま）
fn choose_target(line: Option<Line>, target: Iid) -> Option<Line> {
    let line = line?;
    if line.state.pending.is_none() {
        return Some(line);
    }
    step(Some(&line), Some(Action::Choose(vec![target])))
}

fn play_rhino(line: Option<&Line>, p: PlayerIndex) -> Option<(Line, Iid)> {
    let line = line?;
    let iid = hand_iid(&line.state, p, RHINO);
    let next = step(Some(line), play(iid))?;
    Some((next, iid?))
}

#[derive(Clone, Copy)]
enum EvolveType {
    Super,
    Normal,
}

fn evolve(line: Line, iid: Iid, kinds: &[EvolveType]) -> Line {
    for k in kinds {
        let a = match k {
            EvolveType::Super => Action::SuperEvolve(iid),
            EvolveType::Normal => Action::Evolve(iid),
        };
        if let Some(next) = step(Some(&line), Some(a)) {
            return next;
        }
    }
    line
}

fn face_attack(line: Option<&Line>, iid: Iid) -> Option<Line> {
    step(
        line,
        Some(Action::Attack {
            attacker: iid,
            target: None,
        }),
    )
}

/// 場の燐光の岩をすべて target にアクトする（+1/+1）
fn rocks_on(line: Line, p: PlayerIndex, target: Iid) -> Line {
    let mut cur = line;
    for rock in board_iids(&cur.state, p, ROCK) {
        if let Some(next) = choose_target(step(Some(&cur), Some(Action::Act(rock))), target) {
            cur = next;
        }
    }
    cur
}

/// 殴れるフォロワー全員で顔を殴る
fn all_face(line: Line, p: PlayerIndex) -> Line {
    let mut cur = line;
    let board: Vec<(Iid, bool, i32)> = cur.state.players[p]
        .board
        .iter()
        .map(|c| (c.iid, c.is_follower, c.max_attacks))
        .collect();
    for (iid, follower, max_attacks) in board {
        if !follower {
            continue;
        }
        let mut i = 0;
        while i < max_attacks && cur.state.phase != Phase::Ended {
            let Some(next) = face_attack(Some(&cur), iid) else {
                break;
            };
            cur = next;
            i += 1;
        }
    }
    cur
}

const SUPER_THEN_EVOLVE: [EvolveType; 2] = [EvolveType::Super, EvolveType::Normal];

/// 最後のリノセウス: 超進化（無ければ進化）し、燐光の岩をアクトして、全員で顔を殴る
fn last_rhino(line: Option<&Line>, p: PlayerIndex, kinds: &[EvolveType]) -> Option<Line> {
    let (l, rhino) = play_rhino(line, p)?;
    Some(all_face(rocks_on(evolve(l, rhino, kinds), p, rhino), p))
}

fn first_rhino(line: &Line, p: PlayerIndex, first_evolve: bool) -> Option<(Line, Iid)> {
    let (l, rhino) = play_rhino(Some(line), p)?;
    let evolved = if first_evolve {
        step(Some(&l), Some(Action::Evolve(rhino)))
    } else {
        Some(l)
    };
    let hit = face_attack(evolved.as_ref(), rhino)?;
    Some((hit, rhino))
}

/// 仕上げの形（0: リノセウス 1 回、1〜8: 1 体目の進化なし・ありごとに、杖・リノ 2 枚・虫の知らせ・ベビーカーバンクル）
fn finisher(i: usize, start: &Line, p: PlayerIndex) -> Option<Line> {
    if i == 0 {
        return last_rhino(Some(start), p, &SUPER_THEN_EVOLVE);
    }
    let first_evolve = i >= 5;
    let (l, rhino) = first_rhino(start, p, first_evolve)?;
    match (i - 1) % 4 {
        0 => {
            let rod = *board_iids(&l.state, p, ROD).first()?;
            last_rhino(
                choose_target(step(Some(&l), Some(Action::Act(rod))), rhino).as_ref(),
                p,
                &SUPER_THEN_EVOLVE,
            )
        }
        1 => last_rhino(Some(&l), p, &SUPER_THEN_EVOLVE),
        2 => {
            let bugs = hand_iid(&l.state, p, BUGS);
            last_rhino(
                choose_target(step(Some(&l), play(bugs)), rhino).as_ref(),
                p,
                &SUPER_THEN_EVOLVE,
            )
        }
        _ => {
            let carbuncle = hand_iid(&l.state, p, CARBUNCLE);
            let back = choose_target(step(Some(&l), play(carbuncle)), rhino);
            let recovered = match carbuncle {
                None => None,
                Some(c) => step(back.as_ref(), Some(Action::SuperEvolve(c))),
            };
            last_rhino(recovered.as_ref(), p, &[EvolveType::Normal])
        }
    }
}

const FINISHERS: usize = 9;

/// 仕上げで与えられる最大のダメージ（勝てば無限大）と、その手
fn best_finish(start: &Line, p: PlayerIndex, root_opp_hp: i32) -> (f64, Option<Line>) {
    let opp = opponent(p);
    let mut best = (
        (root_opp_hp - start.state.players[opp].leader_hp) as f64,
        None,
    );
    for i in 0..FINISHERS {
        let Some(end) = finisher(i, start, p) else {
            continue;
        };
        let won = end.state.phase == Phase::Ended && end.state.winner == Some(p);
        let damage = if won {
            f64::INFINITY
        } else {
            (root_opp_hp - end.state.players[opp].leader_hp) as f64
        };
        if damage > best.0 {
            best = (damage, Some(end));
        }
        if won {
            break;
        }
    }
    best
}

fn without_wards(s: &GameState, opp: PlayerIndex) -> GameState {
    let mut s = s.clone();
    for c in s.players[opp].board.make_mut().iter_mut() {
        if c.keywords.has(WARD) || c.temp_keywords.has(WARD) {
            c.keywords = c.keywords.without(WARD);
            c.temp_keywords = c.temp_keywords.without(WARD);
        }
    }
    s
}

/// 準備の局面の点数（仕上げで出せるダメージと、守護を外せば出せるダメージ − 守護の体力の大きい方）
fn setup_score(start: &Line, p: PlayerIndex, root_opp_hp: i32) -> (f64, Option<Line>, f64) {
    let (damage, line) = best_finish(start, p, root_opp_hp);
    if damage == f64::INFINITY {
        return (damage, line, f64::INFINITY);
    }
    let opp = opponent(p);
    let wards: Vec<&OnBoard> = start.state.players[opp]
        .board
        .iter()
        .filter(|c| c.is_follower && (c.keywords.has(WARD) || c.temp_keywords.has(WARD)))
        .collect();
    if wards.is_empty() {
        return (damage, line, damage);
    }
    let ward_hp: i32 = wards.iter().map(|c| c.defense).sum();
    let open_line = Line {
        state: without_wards(&start.state, opp),
        seq: start.seq.clone(),
    };
    let (open, _) = best_finish(&open_line, p, root_opp_hp);
    let open_damage = if open == f64::INFINITY {
        (root_opp_hp + 1) as f64
    } else {
        open
    };
    (damage, line, damage.max(open_damage - ward_hp as f64))
}

fn setup_actions(s: &GameState, p: PlayerIndex) -> Vec<Action> {
    let mut legal = legal_actions(s);
    if s.pending.is_some() {
        return legal;
    }
    if let Some(m) = hand_iid(s, p, MYSTERY) {
        if let Some(a) = legal.iter().find(|a| **a == Action::Play(m)) {
            return vec![a.clone()];
        }
    }
    let hand = &s.players[p].hand;
    legal.retain(|a| match a {
        Action::EndTurn => false,
        Action::Attack { target: None, .. } => false,
        Action::Play(iid) => !hand
            .iter()
            .find(|h| h.iid == *iid)
            .is_some_and(|h| named(h.card, RHINO)),
        _ => true,
    });
    legal
}

/// 準備の局面の同一判定（相手リーダーの体力・山札・乱数の状態を除く）
pub(crate) fn setup_key_eq(a: &GameState, b: &GameState) -> bool {
    a.players.iter().zip(&b.players).all(|(x, y)| {
        x.pp == y.pp
            && x.combo == y.combo
            && x.ep == y.ep
            && x.sep == y.sep
            && x.extra_pp_available == y.extra_pp_available
            && x.hand.len() == y.hand.len()
            && x.hand.iter().zip(&y.hand).all(|(h, g)| hand_eq(h, g))
            && x.board.len() == y.board.len()
            && x.board.iter().zip(&y.board).all(|(h, g)| board_eq(h, g))
            && x.crests.len() == y.crests.len()
            && x.crests.iter().zip(&y.crests).all(|(h, g)| crest_eq(h, g))
    }) && a.pending == b.pending
        && stack_eq(&a.stack, &b.stack)
}

pub(crate) fn setup_key_hash(s: &GameState) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for pl in &s.players {
        h = mix(
            mix(mix(mix(mix(h, pl.pp), pl.combo), pl.ep), pl.sep),
            pl.extra_pp_available as i32,
        );
        h = mix(h, pl.hand.len() as i32);
        for c in &pl.hand {
            h = mix(mix(h, c.iid), c.cost_mod);
        }
        h = mix(h, pl.board.len() as i32);
        for c in &pl.board {
            h = mix(mix(mix(h, c.iid), c.attack), c.defense);
        }
        h = mix(h, pl.crests.len() as i32);
    }
    mix(h, s.stack.len() as i32)
}

/// リノセウスで殴り切る手順を探す。手札にリノセウスが無ければ探さない
pub fn search_rhino_lethal(
    root: &GameState,
    p: PlayerIndex,
    opts: &RhinoLethalOptions,
) -> Option<Vec<Action>> {
    if root.phase != Phase::Main || root.active != p || hand_iid(root, p, RHINO).is_none() {
        return None;
    }
    let root_opp_hp = root.players[opponent(p)].leader_hp;
    let root_line = Line {
        state: root.clone(),
        seq: Vec::new(),
    };
    let (damage, line, score) = setup_score(&root_line, p, root_opp_hp);
    if damage == f64::INFINITY {
        return Some(line.expect("勝てる手順").seq);
    }
    let mut frontier: Vec<(Line, f64)> = vec![(root_line, score)];
    let mut depth = 0;
    while depth < opts.max_depth && !frontier.is_empty() {
        let mut children: Vec<(Line, f64)> = Vec::new();
        let mut seen: EqSet<GameState> = EqSet::default();
        for (node, node_score) in &frontier {
            let s = &node.state;
            let actor = s.pending.as_ref().map(|pd| pd.player()).unwrap_or(s.active);
            if s.phase == Phase::Ended || actor != p {
                continue;
            }
            for a in setup_actions(s, p) {
                let Some(next) = step(Some(node), Some(a)) else {
                    continue;
                };
                if next.state.phase == Phase::Ended {
                    continue;
                }
                if !seen.add(
                    next.state.clone(),
                    setup_key_hash(&next.state),
                    setup_key_eq,
                ) {
                    continue;
                }
                // 選択待ちの途中では仕上げに入れないので、点数は親から引き継ぐ
                if next.state.pending.is_some() {
                    children.push((next, *node_score));
                    continue;
                }
                let (damage, line, score) = setup_score(&next, p, root_opp_hp);
                if damage == f64::INFINITY {
                    return Some(line.expect("勝てる手順").seq);
                }
                children.push((next, score));
            }
        }
        children.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
        children.truncate(opts.beam_width);
        frontier = children;
        depth += 1;
    }
    None
}
