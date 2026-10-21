//! 局面の同一判定（tests/keySet.test.ts）。
//! TypeScript 版は「JSON にしたときに同じ値か」で比べていたので、局面の JSON（state_to_json）を比べた結果と一致することを確かめる

use super::*;
use crate::ai::keys::{
    lethal_key_eq, lethal_key_hash, state_eq, turn_order_eq, turn_order_hash, EqSet,
};
use crate::ai::rhino_lethal::{setup_key_eq, setup_key_hash};
use crate::ai::RandomAgent;

fn arr(j: &Json) -> &[Json] {
    match j {
        Json::Arr(v) => v,
        _ => panic!("配列ではありません"),
    }
}

fn field<'a>(j: &'a Json, key: &str) -> &'a Json {
    j.get(key).unwrap_or_else(|| panic!("{key} がありません"))
}

/// リーサル探索の局面のキー（lethal.ts の stateKey。with_hp でなければ rhinoLethal.ts の準備の局面のキー）
fn lethal_key(s: &GameState, with_hp: bool) -> String {
    let j = state_to_json(s);
    let players = arr(field(&j, "players"))
        .iter()
        .map(|pl| {
            let mut v = Vec::new();
            if with_hp {
                v.push(field(pl, "leaderHp").clone());
            }
            for k in [
                "pp",
                "combo",
                "ep",
                "sep",
                "extraPpAvailable",
                "hand",
                "board",
                "crests",
            ] {
                v.push(field(pl, k).clone());
            }
            if with_hp {
                v.push(Json::Num(arr(field(pl, "deck")).len() as f64));
            }
            Json::Arr(v)
        })
        .collect();
    Json::Arr(vec![
        Json::Arr(players),
        field(&j, "pending").clone(),
        field(&j, "stack").clone(),
    ])
    .canonical()
}

/// カードの iid 等を除いた JSON を並べ替えたもの（keySet.ts の sortedWithoutIds）
fn sorted_without_ids(cards: &Json) -> Json {
    let mut items: Vec<String> = arr(cards)
        .iter()
        .map(|c| match c {
            Json::Obj(fields) => Json::Obj(
                fields
                    .iter()
                    .filter(|(k, _)| {
                        !["iid", "order", "boosts", "revealed", "drawnBy"].contains(&k.as_str())
                    })
                    .cloned()
                    .collect(),
            )
            .canonical(),
            _ => panic!("カードではありません"),
        })
        .collect();
    items.sort();
    Json::Arr(items.into_iter().map(Json::Str).collect())
}

/// 手の順番だけが違う局面を同じにするキー（keySet.ts の turnOrderKey）
fn turn_order_key(s: &GameState) -> String {
    let j = state_to_json(s);
    if !s.stack.is_empty() || !s.queue.is_empty() || s.pending.is_some() || s.attack.is_some() {
        return j.canonical();
    }
    let players = arr(field(&j, "players"))
        .iter()
        .map(|pl| {
            let mut pl = pl.clone();
            let deck = arr(field(&pl, "deck"))
                .iter()
                .map(|c| match c.get("kept") {
                    // 山札に戻ったカードの手札での状態も、手札と同じく iid 等を除いて比べる
                    Some(k) => Json::Arr(vec![
                        field(c, "cardId").clone(),
                        sorted_without_ids(&Json::Arr(vec![k.clone()])),
                    ]),
                    None => field(c, "cardId").clone(),
                })
                .collect();
            pl.set("deck", Json::Arr(deck));
            for k in ["hand", "board", "crests"] {
                let v = sorted_without_ids(field(&pl, k));
                pl.set(k, v);
            }
            pl
        })
        .collect();
    let mut key = Json::Obj(Vec::new());
    for k in ["phase", "turn", "active", "winner", "rng"] {
        key.set(k, field(&j, k).clone());
    }
    key.set("players", Json::Arr(players));
    key.canonical()
}

/// 局面 s から 2 手進めた局面（手の順番が違うだけの同じ局面を含む）
fn two_steps(s: &GameState) -> Vec<GameState> {
    let mut out = Vec::new();
    for a in legal_actions(s) {
        let t = apply(s, &a);
        if t.phase == Phase::Ended {
            continue;
        }
        for b in legal_actions(&t) {
            out.push(apply(&t, &b));
        }
    }
    out
}

type Eq = fn(&GameState, &GameState) -> bool;
type Hash = fn(&GameState) -> u32;
type Key = fn(&GameState) -> String;

#[test]
fn eq_sets_match_json_sets() {
    // 同一判定でまとめた集合が JSON 文字列の集合と同じものをまとめ、JSON が同じ局面は同じハッシュになる
    let projections: [(Eq, Hash, Key); 3] = [
        (state_eq, lethal_key_hash, canon),
        (lethal_key_eq, lethal_key_hash, |s| lethal_key(s, true)),
        (setup_key_eq, setup_key_hash, |s| lethal_key(s, false)),
    ];
    let n = data().decks.len();
    let mut rng = Rng::new(5);
    let mut merged = 0;
    for g in 0..12 {
        let mut s = new_game(deck_at(g % n), deck_at((g + 3) % n), g as u32 + 1);
        while s.phase != Phase::Ended {
            let states = two_steps(&s);
            // turn_order_eq はキーを作らずに同じ判定をする（同じハッシュの局面どうしで確かめる）
            let to_keys: Vec<String> = states.iter().map(turn_order_key).collect();
            let mut by_hash: std::collections::HashMap<u32, Vec<usize>> = Default::default();
            for (i, t) in states.iter().enumerate() {
                let bucket = by_hash.entry(turn_order_hash(t)).or_default();
                for &u in bucket.iter() {
                    assert_eq!(turn_order_eq(t, &states[u]), to_keys[i] == to_keys[u]);
                }
                bucket.push(i);
            }
            for (eq, hash, key) in projections {
                let mut strings = std::collections::HashSet::new();
                let mut hashes = std::collections::HashMap::new();
                let mut set: EqSet<usize> = EqSet::default();
                for (i, t) in states.iter().enumerate() {
                    let json = key(t);
                    let h = hash(t);
                    if let Some(&prev) = hashes.get(&json) {
                        assert_eq!(prev, h, "JSON が同じでハッシュが違う");
                    }
                    hashes.insert(json.clone(), h);
                    let is_new = strings.insert(json);
                    assert_eq!(set.add(i, h, |a, b| eq(&states[*a], &states[*b])), is_new);
                    if !is_new {
                        merged += 1;
                    }
                }
            }
            let a = RandomAgent.choose_action(&s, &legal_actions(&s), &mut rng);
            s = apply(&s, &a);
        }
    }
    // 同じ局面をまとめる場面を実際に試していること
    assert!(merged > 100, "{merged}");
}

/// エルフ（プレイヤー0）の手番で PP 7、手札は names
fn elf_turn(names: &[&str]) -> GameState {
    let s = new_game(class_deck(ClassId::Elf), class_deck(ClassId::Royal), 1);
    let mut s = skip_mulligan(s);
    s.active = 0;
    s.players[0].pp = 7;
    s.players[0].max_pp = 7;
    s.players[0].hand = hand_cards(&mut s, names).into();
    s
}

/// 名前のカードをプレイする（末尾が "!" なら同名のうち最後に加わったもの）
fn play(s: GameState, name: &str) -> GameState {
    let (base, last) = match name.strip_suffix('!') {
        Some(b) => (b, true),
        None => (name, false),
    };
    let cards: Vec<Iid> = s.players[s.active]
        .hand
        .iter()
        .filter(|h| name_of(h.card) == base)
        .map(|h| h.iid)
        .collect();
    let iid = if last { cards.last() } else { cards.first() }.expect("手札のカード");
    apply(&s, &Action::Play(*iid))
}

fn play_all(root: &GameState, names: &[&str]) -> GameState {
    names.iter().fold(root.clone(), |s, n| play(s, n))
}

#[test]
fn turn_order_merges_states_differing_only_in_order() {
    // 効果で加わったカードの iid や場に出た順が違っても、同じ局面としてまとめる
    let mut root = elf_turn(&["フェアリーテイマー", "燐光の岩", "フェアリー"]);
    // 前のターンのスペルでスペルブーストの回数だけが増えているフェアリー
    root.players[0].hand.make_mut()[2].boosts = 1;
    let a = play_all(&root, &["フェアリーテイマー", "燐光の岩", "フェアリー"]);
    let b = play_all(&root, &["燐光の岩", "フェアリー!", "フェアリーテイマー"]);
    assert_ne!(canon(&a), canon(&b));
    assert!(!state_eq(&a, &b));
    assert_eq!(turn_order_key(&a), turn_order_key(&b));
    assert_eq!(turn_order_hash(&a), turn_order_hash(&b));
    assert!(turn_order_eq(&a, &b));
    // 中身が違う局面はまとめない（コンボ 3 で岩を出すと森の神秘が加わる）
    let c = play_all(&root, &["フェアリーテイマー", "フェアリー", "燐光の岩"]);
    assert_ne!(turn_order_key(&a), turn_order_key(&c));
    assert!(!turn_order_eq(&a, &c));
}

#[test]
fn same_turn_order_key_has_same_hash() {
    let n = data().decks.len();
    let mut rng = Rng::new(7);
    let mut merged = 0;
    for g in 0..6 {
        let mut s = new_game(deck_at(g % n), deck_at((g + 2) % n), g as u32 + 11);
        while s.phase != Phase::Ended {
            let mut hashes = std::collections::HashMap::new();
            for t in two_steps(&s) {
                let h = turn_order_hash(&t);
                if let Some(prev) = hashes.insert(turn_order_key(&t), h) {
                    assert_eq!(prev, h);
                    merged += 1;
                }
            }
            let a = RandomAgent.choose_action(&s, &legal_actions(&s), &mut rng);
            s = apply(&s, &a);
        }
    }
    assert!(merged > 100, "{merged}");
}
