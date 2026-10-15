//! リノセウス用 AI（tests/rhino.test.ts）

use super::*;
use crate::ai::rhino::{
    allow_action_with, mulligan_swap, next_turn_rhino_bound, rhino_search_options, RhinoAgent,
    ALL_HOLDS, RHINO_POTENTIAL,
};
use crate::ai::rhino_lethal::{search_rhino_lethal, DEFAULT_RHINO_LETHAL_OPTIONS};
use crate::ai::search::{SearchAgent, SearchOptions};

fn elf() -> &'static [CardIdx] {
    class_deck(ClassId::Elf)
}

fn royal() -> &'static [CardIdx] {
    class_deck(ClassId::Royal)
}

fn bishop() -> &'static [CardIdx] {
    deck("アミュレット疾走ビショップ")
}

fn allow(s: &GameState, a: &Action) -> bool {
    allow_action_with(ALL_HOLDS, s, a, 0)
}

/// マリガン後、エルフ（プレイヤー0）の手番の局面
fn main_phase() -> GameState {
    let mut s = skip_mulligan(new_game(elf(), royal(), 1));
    s.active = 0;
    s
}

/// マリガン前の局面で、エルフ（プレイヤー0）の手札を names にする
fn with_hand(names: &[&str]) -> (GameState, Vec<Iid>) {
    let mut s = new_game(elf(), royal(), 1);
    s.players[0].hand = hand_cards(&mut s, names);
    let iids = s.players[0].hand.iter().map(|h| h.iid).collect();
    (s, iids)
}

// ---- マリガン ----

#[test]
fn mulligan_keeps_backwood_and_early_cards() {
    // バックウッドと序盤のカードがあれば、それと杖1枚・メイ・リリィを残す
    let (s, iids) = with_hand(&[
        "薫交の天宮・バックウッド",
        "聖樹の杖",
        "純粋なるウォーターフェアリー",
        "聖樹の杖",
    ]);
    assert_eq!(mulligan_swap(&s, 0), vec![iids[3]]);
}

#[test]
fn mulligan_keeps_one_early_card_by_priority() {
    // 片方だけならそれだけ残し、序盤のカードは優先順に1枚まで
    let (s, iids) = with_hand(&[
        "妖精の招集",
        "フェアリーテイマー",
        "聖樹の杖",
        "アドベンチャーエルフ・メイ",
    ]);
    assert_eq!(mulligan_swap(&s, 0), vec![iids[0], iids[2], iids[3]]);
}

#[test]
fn mulligan_swaps_all_without_key_cards() {
    // どちらも無ければすべて入れ替える
    let (s, iids) = with_hand(&[
        "聖樹の杖",
        "殺戮のリノセウス",
        "アドベンチャーエルフ・メイ",
        "虫の知らせ",
    ]);
    assert_eq!(mulligan_swap(&s, 0), iids);
}

#[test]
fn mulligan_by_rules_in_either_seat() {
    // 後攻でも、先攻の相手がエルフ以外でも、エルフのマリガンはルールで行う
    for elf_seat in [0, 1] {
        for first in [0, 1] {
            let decks = if elf_seat == 0 {
                [elf(), royal()]
            } else {
                [royal(), elf()]
            };
            let mut s = new_game(decks[0], decks[1], 1);
            s.first = first;
            s.active = first;
            s.players[elf_seat].hand = hand_cards(
                &mut s,
                &[
                    "勇壮の堕天使・オリヴィエ",
                    "ベビーカーバンクル",
                    "ベビーカーバンクル",
                    "フェアリーテイマー",
                ],
            );
            let tamer = s.players[elf_seat].hand[3].iid;
            let mut agent = RhinoAgent::new(true);
            let mut rng = Rng::new(1);
            while s.phase == Phase::Mulligan {
                let a = agent.choose_action(&s, &legal_actions(&s), &mut rng);
                if let Action::Mulligan { player, swap } = &a {
                    if *player == elf_seat {
                        let expected: Vec<Iid> = s.players[elf_seat]
                            .hand
                            .iter()
                            .map(|h| h.iid)
                            .filter(|&x| x != tamer)
                            .collect();
                        assert_eq!(sorted(swap.clone()), sorted(expected));
                    }
                }
                s = apply(&s, &a);
            }
        }
    }
}

// ---- 禁じる手 ----

#[test]
fn does_not_act_last_rod_or_rock() {
    // 場の最後の杖・燐光の岩はアクトしない
    let mut s = main_phase();
    let rod = board_card(&mut s, "聖樹の杖");
    let rod_iid = rod.iid;
    s.players[0].board = vec![rod];
    assert!(!allow(&s, &Action::Act(rod_iid)));
    let rod2 = board_card(&mut s, "聖樹の杖");
    s.players[0].board.push(rod2);
    assert!(allow(&s, &Action::Act(rod_iid)));
    let rock = board_card(&mut s, "燐光の岩");
    let rock_iid = rock.iid;
    s.players[0].board = vec![rock];
    assert!(!allow(&s, &Action::Act(rock_iid)));
}

#[test]
fn does_not_choose_last_rod() {
    // 手札に戻す等の対象に最後の杖を選ばない。杖しか選べないなら、そのカードを打たない
    let mut s = main_phase();
    s.players[0].pp = 3;
    s.players[0].max_pp = 3;
    let rod = board_card(&mut s, "聖樹の杖");
    let bugs = hand_card(&mut s, "虫の知らせ");
    let (rod_iid, bugs_iid) = (rod.iid, bugs.iid);
    s.players[0].board = vec![rod.clone()];
    s.players[0].hand = vec![bugs];
    assert!(!allow(&s, &Action::Play(bugs_iid)));
    let fairy = board_card(&mut s, "フェアリー");
    let fairy_iid = fairy.iid;
    s.players[0].board = vec![rod, fairy];
    assert!(allow(&s, &Action::Play(bugs_iid)));
    let after = apply(&s, &Action::Play(bugs_iid));
    assert!(!allow(&after, &Action::Choose(vec![rod_iid])));
    assert!(allow(&after, &Action::Choose(vec![fairy_iid])));
    let mut agent = RhinoAgent::new(true);
    let a = agent.choose_action(&after, &legal_actions(&after), &mut Rng::new(1));
    assert_eq!(a, Action::Choose(vec![fairy_iid]));
}

#[test]
fn rock_only_against_empty_board_and_no_mystery() {
    // 燐光の岩は相手の場にフォロワーがいないときだけ置く。杖は2枚目でも置いてよい。森の神秘は使わない
    let mut s = main_phase();
    let hand = hand_cards(&mut s, &["聖樹の杖", "燐光の岩", "森の神秘"]);
    let (rod, rock, mystery) = (hand[0].iid, hand[1].iid, hand[2].iid);
    s.players[0].hand = hand;
    assert!(allow(&s, &Action::Play(rod))); // 1枚目
    let rod_on_board = board_card(&mut s, "聖樹の杖");
    s.players[0].board = vec![rod_on_board];
    let knight = board_card(&mut s, "ナイト");
    s.players[1].board = vec![knight];
    assert!(allow(&s, &Action::Play(rod)));
    assert!(!allow(&s, &Action::Play(rock)));
    s.players[1].board.clear();
    assert!(allow(&s, &Action::Play(rod)));
    assert!(allow(&s, &Action::Play(rock)));
    assert!(!allow(&s, &Action::Play(mystery)));
}

#[test]
fn next_turn_bound_grows_with_rhinos() {
    // 次のターンのリノセウスの打点の見積もりは、手札にリノセウスが無ければ 0、増えれば上がる
    let mut s = main_phase();
    s.players[0].pp = 7;
    s.players[0].max_pp = 7;
    s.players[0].hand.clear();
    assert_eq!(next_turn_rhino_bound(&s, 0), 0);
    let r = hand_card(&mut s, "殺戮のリノセウス");
    s.players[0].hand.push(r);
    let one = next_turn_rhino_bound(&s, 0);
    assert!(one > 0);
    let more = hand_cards(&mut s, &["殺戮のリノセウス", "森の神秘"]);
    s.players[0].hand.extend(more);
    assert!(next_turn_rhino_bound(&s, 0) > one);
}

#[test]
fn holds_single_rhinoceus() {
    // 手札に1枚しかないリノセウスはプレイしない（2枚以上ならよい）
    let mut s = main_phase();
    s.players[0].pp = 5;
    s.players[0].max_pp = 5;
    let rhino = hand_card(&mut s, "殺戮のリノセウス");
    let iid = rhino.iid;
    s.players[0].hand = vec![rhino];
    assert!(!allow(&s, &Action::Play(iid)));
    let r2 = hand_card(&mut s, "殺戮のリノセウス");
    s.players[0].hand.push(r2);
    assert!(allow(&s, &Action::Play(iid)));
}

#[test]
fn extra_pp_rules() {
    // エクストラPP: 2つ目は使わない。1つ目は杖を置くためには使わない（バックウッドなら使う）
    let mut s = main_phase();
    {
        let pl = &mut s.players[0];
        pl.extra_pp_available = true;
        pl.turn_count = 2;
        pl.max_pp = 2;
        pl.pp = 2;
    }
    s.players[0].hand = hand_cards(&mut s, &["聖樹の杖"]);
    assert!(!allow(&s, &Action::ExtraPp));
    s.players[0].max_pp = 4;
    s.players[0].pp = 4;
    s.players[0].hand = hand_cards(&mut s, &["薫交の天宮・バックウッド"]);
    assert!(allow(&s, &Action::ExtraPp));
    s.players[0].hand = hand_cards(&mut s, &["殺戮のリノセウス"]);
    assert!(!allow(&s, &Action::ExtraPp));
    s.players[0].turn_count = 6;
    s.players[0].hand = hand_cards(&mut s, &["薫交の天宮・バックウッド"]);
    assert!(!allow(&s, &Action::ExtraPp));
}

// ---- リノセウス専用のリーサル探索 ----

#[test]
fn rhino_lethal_replays_rhinoceus_with_rod() {
    // フェアリーを当ててベイルを安くし、杖でリノセウスを戻して出し直す手順を見つける
    let mut s = main_phase();
    let mut bail = hand_card(&mut s, "煌撃の戦士・ベイル");
    bail.cost_mod = -6;
    let fairies = hand_cards(&mut s, &["フェアリー", "フェアリー"]);
    let rhino = hand_card(&mut s, "殺戮のリノセウス");
    let rod = board_card(&mut s, "聖樹の杖");
    let william = board_card(&mut s, "マナリアの学徒・ウィリアム");
    {
        let me = &mut s.players[0];
        me.hand = vec![fairies[0].clone(), fairies[1].clone(), bail, rhino];
        me.board = vec![rod];
        me.pp = 8;
        me.max_pp = 8;
        me.turn_count = 8;
        me.ep = 0;
        me.sep = 1;
        me.combo = 0;
        me.extra_pp_available = false;
    }
    s.players[1].board = vec![william];
    s.players[1].leader_hp = 11;
    let seq = search_rhino_lethal(&s, 0, &DEFAULT_RHINO_LETHAL_OPTIONS).expect("リーサル");
    let rhino_card = id("殺戮のリノセウス");
    let mut rhino_plays = 0;
    for a in &seq {
        if let Action::Play(iid) = a {
            if s.players[0].hand.iter().any(|h| h.iid == *iid && h.card == rhino_card) {
                rhino_plays += 1;
            }
        }
        s = apply(&s, a);
    }
    assert_eq!(s.winner, Some(0));
    assert_eq!(rhino_plays, 2); // 1回では足りない
}

/// ユーザーの指摘（スペルウィッチ vs リノセウスエルフ、seed 2564010370、エルフの 10 ターン目）を簡単にした局面。
/// 相手の守護（式神・天后）がいると仕上げの点数がどれも 0 になり、フェアリーとテイマーを当ててベイルを安くする準備がビームで切られていた
#[test]
fn rhino_lethal_clears_ward_first() {
    // 守護をフェアリー・テイマー・ベイルで処理してから、リノセウスを杖で出し直す手順を見つける
    let mut s = main_phase();
    let mut bail = hand_card(&mut s, "煌撃の戦士・ベイル");
    bail.cost_mod = -3;
    let fairies = hand_cards(&mut s, &["フェアリー", "フェアリー"]);
    let rhino = hand_card(&mut s, "殺戮のリノセウス");
    let mut tamer = board_card(&mut s, "フェアリーテイマー");
    tamer.entered_turn = s.turn - 2;
    let rod = board_card(&mut s, "聖樹の杖");
    {
        let me = &mut s.players[0];
        me.hand = vec![fairies[0].clone(), fairies[1].clone(), bail, rhino];
        me.board = vec![rod, tamer];
        me.pp = 10;
        me.max_pp = 10;
        me.turn_count = 10;
        me.ep = 0;
        me.sep = 0;
        me.combo = 0;
        me.extra_pp_available = false;
    }
    let tenko = board_card(&mut s, "式神・天后");
    s.players[1].board = vec![tenko];
    s.players[1].leader_hp = 9;
    let seq = search_rhino_lethal(&s, 0, &DEFAULT_RHINO_LETHAL_OPTIONS);
    assert!(wins(&s, seq.as_deref(), 0));
}

#[test]
fn rhino_lethal_plays_mystery_first() {
    // 森の神秘は手札にあれば先に打つ（打ってもリーサルを逃さない）
    let mut s = main_phase();
    s.players[0].hand = hand_cards(&mut s, &["森の神秘", "森の神秘", "殺戮のリノセウス"]);
    s.players[0].pp = 3;
    s.players[0].max_pp = 3;
    s.players[0].combo = 0;
    s.players[1].board.clear();
    s.players[1].leader_hp = 3;
    let rhino = s.players[0].hand[2].iid;
    let seq = search_rhino_lethal(&s, 0, &DEFAULT_RHINO_LETHAL_OPTIONS).expect("リーサル");
    assert!(seq[..2]
        .iter()
        .all(|a| matches!(a, Action::Play(i) if *i != rhino)));
    assert!(wins(&s, Some(&seq), 0));
}

#[test]
fn rhino_lethal_needs_rhinoceus_in_hand() {
    // 手札にリノセウスが無ければ探さない
    let mut s = main_phase();
    s.players[0].hand = hand_cards(&mut s, &["フェアリー"]);
    assert!(search_rhino_lethal(&s, 0, &DEFAULT_RHINO_LETHAL_OPTIONS).is_none());
}

// ---- 手数の多いターン・ユーザーが指摘した試合 ----

/// p の手番の間、agent で打つ（rhino.test.ts の `while (s.phase === "main" && s.active === p)`）
fn play_active(s: GameState, p: PlayerIndex, agent: &mut dyn Agent, rng: &mut Rng) -> GameState {
    play_while(s, agent, rng, |t| t.phase == Phase::Main && t.active == p).1
}

fn followers(s: &GameState, p: PlayerIndex) -> usize {
    s.players[p].board.iter().filter(|c| c.is_follower).count()
}

/// ユーザーの指摘（リノセウスエルフ vs アミュレット疾走ビショップ、seed 2510273090、エルフ後攻の 4 ターン目）。
/// 相手の場は楽朗の天宮・フィルドア 3/1 と鉄拳の神父 5/4。推奨はテイマー → 進化 → フェアリー 2 枚で両方を処理（7 手）。
/// 探索の深さ 6 では届かず、神父だけ処理してフィルドアを残していた
#[test]
fn clears_both_followers_in_long_turn() {
    let log = actions(
        r#"[{"type":"mulligan","player":1,"swap":[69,73]},{"type":"mulligan","player":0,"swap":[37]},{"type":"play","iid":41},{"type":"endTurn"},{"type":"endTurn"},{"type":"play","iid":44},{"type":"endTurn"},{"type":"play","iid":18},{"type":"endTurn"},{"type":"play","iid":52},{"type":"act","iid":52},{"type":"attack","attacker":44,"target":18},{"type":"endTurn"},{"type":"play","iid":30},{"type":"endTurn"},{"type":"play","iid":61},{"type":"attack","attacker":44,"target":"leader"},{"type":"endTurn"}]"#,
    );
    let s = apply_all(&new_game(elf(), bishop(), 2510273090), &log);
    let end = play_active(s, 0, &mut RhinoAgent::new(true), &mut Rng::new(1));
    assert_eq!(followers(&end, 1), 0);
}

/// seed 1678126716（アミュレット疾走ビショップ vs リノセウスエルフ、エルフ後攻）。
/// ユーザーが指摘した試合の、エルフの 7 ターン目の 2 手目までの行動（PR #21 時点の AI の手）
fn state_1678126716(n: usize) -> GameState {
    let log = actions(
        r#"[{"type":"mulligan","player":1,"swap":[43,77,67,66]},{"type":"mulligan","player":0,"swap":[34]},{"type":"endTurn"},{"type":"extraPp"},{"type":"play","iid":4},{"type":"endTurn"},{"type":"play","iid":58},{"type":"endTurn"},{"type":"play","iid":15},{"type":"attack","attacker":4,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":71},{"type":"attack","attacker":58,"target":4},{"type":"endTurn"},{"type":"play","iid":9},{"type":"endTurn"},{"type":"play","iid":54},{"type":"play","iid":49},{"type":"play","iid":46},{"type":"choose","targets":[54]},{"type":"endTurn"},{"type":"play","iid":21},{"type":"evolve","iid":21},{"type":"endTurn"},{"type":"play","iid":81},{"type":"play","iid":82},{"type":"play","iid":64},{"type":"choose","targets":[21]},{"type":"play","iid":83},{"type":"attack","attacker":81,"target":21},{"type":"evolve","iid":64},{"type":"attack","attacker":64,"target":86},{"type":"endTurn"},{"type":"play","iid":12},{"type":"play","iid":6},{"type":"act","iid":12},{"type":"evolve","iid":6},{"type":"choose","targets":[64]},{"type":"attack","attacker":6,"target":82},{"type":"endTurn"},{"type":"play","iid":80},{"type":"play","iid":68},{"type":"evolve","iid":68},{"type":"attack","attacker":83,"target":"leader"},{"type":"attack","attacker":68,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":31},{"type":"act","iid":31},{"type":"endTurn"},{"type":"play","iid":84}]"#,
    );
    apply_all(&new_game(bishop(), elf(), 1678126716), &log[..n])
}

fn hand_names(s: &GameState, p: PlayerIndex) -> Vec<&'static str> {
    s.players[p].hand.iter().map(|h| name_of(h.card)).collect()
}

#[test]
fn turn6_holds_single_rhinoceus_without_lethal() {
    // 6 ターン目: リーサルでなければ、手札に1枚のリノセウスは出さない
    let s = state_1678126716(40);
    let rhinos = |s: &GameState| {
        hand_names(s, 1)
            .iter()
            .filter(|n| **n == "殺戮のリノセウス")
            .count()
    };
    assert_eq!(rhinos(&s), 1);
    let end = play_active(s, 1, &mut RhinoAgent::new(true), &mut Rng::new(1));
    assert!(hand_names(&end, 1).contains(&"殺戮のリノセウス"));
}

/// 7 ターン目（相手の場にフォロワーなし）。フェアリーの後に燐光の岩を出すとコンボ 2 で森の神秘が加わらない。
/// 以前はビームで、手の順番が違うだけの局面（加わったフェアリーの iid が違う）がまとまらず枠を埋め、岩を 2 手目に出していた
#[test]
fn turn7_does_not_play_rock_after_fairy() {
    let s = state_1678126716(50);
    assert_eq!(s.players[1].combo, 1);
    let mut agent = RhinoAgent::new(true);
    let a = agent.choose_action(&s, &legal_actions(&s), &mut Rng::new(1));
    if let Action::Play(iid) = a {
        let c = s.hand_card(iid).expect("手札のカード").card;
        assert_ne!(name_of(c), "燐光の岩");
    }
}

/// seed 954874822（リノセウスエルフ vs アミュレット疾走ビショップ、エルフ先攻）。
/// ユーザーが指摘した試合の、エルフの 7 ターン目の開始までの行動（ビショップは探索 AI、エルフはリノセウス用 AI。選択をまとめる前の AI の手）
fn state_954874822(n: usize) -> GameState {
    let log = actions(
        r#"[{"type":"mulligan","player":0,"swap":[3,27,6]},{"type":"mulligan","player":1,"swap":[]},{"type":"play","iid":2},{"type":"endTurn"},{"type":"endTurn"},{"type":"play","iid":14},{"type":"attack","attacker":2,"target":"leader"},{"type":"endTurn"},{"type":"extraPp"},{"type":"play","iid":56},{"type":"act","iid":56},{"type":"choose","targets":[2]},{"type":"endTurn"},{"type":"play","iid":32},{"type":"attack","attacker":14,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":49},{"type":"endTurn"},{"type":"play","iid":81},{"type":"play","iid":9},{"type":"play","iid":82},{"type":"play","iid":83},{"type":"attack","attacker":81,"target":49},{"type":"attack","attacker":14,"target":"leader"},{"type":"attack","attacker":82,"target":49},{"type":"endTurn"},{"type":"play","iid":62},{"type":"evolve","iid":62},{"type":"choose","targets":[14]},{"type":"attack","attacker":62,"target":83},{"type":"endTurn"},{"type":"play","iid":35},{"type":"evolve","iid":35},{"type":"endTurn"},{"type":"play","iid":51},{"type":"play","iid":55},{"type":"act","iid":55},{"type":"endTurn"},{"type":"play","iid":36},{"type":"attack","attacker":35,"target":"leader"},{"type":"endTurn"},{"type":"superEvolve","iid":86},{"type":"play","iid":64},{"type":"attack","attacker":86,"target":35},{"type":"act","iid":51},{"type":"choose","targets":[86]},{"type":"endTurn"}]"#,
    );
    apply_all(&new_game(elf(), bishop(), 954874822), &log[..n])
}

/// 打った手（プレイしたカードの名前と、打つ前のコンボ）
struct Move {
    action: Action,
    played: Option<&'static str>,
    combo: i32,
}

/// p のターンを最後まで進めた手と最後の局面
fn turn_moves(
    s: GameState,
    p: PlayerIndex,
    agent: &mut dyn Agent,
    seed: u32,
) -> (Vec<Move>, GameState) {
    let (moves, end) = play_turn(s, p, agent, &mut Rng::new(seed));
    let moves = moves
        .into_iter()
        .map(|(t, action)| Move {
            played: match action {
                Action::Play(iid) => Some(name_of(t.hand_card(iid).expect("手札のカード").card)),
                _ => None,
            },
            combo: t.players[p].combo,
            action,
        })
        .collect();
    (moves, end)
}

/// ビショップの 6 ターン目。推奨はエクストラPP → オリヴィエ → 超進化（タイガーも超進化）で、バックウッドとアリアを両方処理する。
/// 以前はエクストラPP が 1 手分の深さを使い、その時点の点数が低いためビームで切られていた
#[test]
fn bishop_turn6_extra_pp_olivier() {
    let mut agent = SearchAgent::new(SearchOptions::default());
    let (moves, end) = turn_moves(state_954874822(41), 1, &mut agent, 2);
    assert!(moves.iter().any(|m| m.action == Action::ExtraPp));
    assert!(moves
        .iter()
        .any(|m| m.played == Some("勇壮の堕天使・オリヴィエ")));
    assert_eq!(followers(&end, 0), 0);
}

/// エルフの 7 ターン目。推奨はフェアリー → ベビーカーバンクル（フェアリーを戻す）→ リリィ（コンボ 3 でタイガーを体力 1）→ リリィ進化でタイガー → 舞い踊る妖精 → リリィでサレファ。
/// 以前は選択も 1 手分の深さを使い（推奨は 10 手）、コンボを稼ぐ途中の点数が低いため幅 8 のビームで切られていた
#[test]
fn elf_turn7_lily_with_combo() {
    let (moves, end) = turn_moves(state_954874822(47), 0, &mut RhinoAgent::new(true), 2);
    // このターンに勝てばよい（合流する相打ちの扱い（settleTrades）を入れてから、このターンのリーサルを見つけるようになった）
    if end.phase == Phase::Ended {
        assert_eq!(end.winner, Some(0));
        return;
    }
    let lily = moves
        .iter()
        .find(|m| m.played == Some("ピュアクリスタリア・リリィ"))
        .expect("リリィ");
    assert!(lily.combo >= 2);
    assert_eq!(followers(&end, 1), 0);
}

/// seed 2275116772（リノセウスエルフ vs アミュレット疾走ビショップ、エルフ先攻）。
/// ユーザーが指摘した試合の、エルフの 7 ターン目の開始までの行動（両方ともリノセウス用 AI）
fn start_2275116772() -> GameState {
    let log = actions(
        r#"[{"type":"mulligan","player":0,"swap":[18,1,7]},{"type":"mulligan","player":1,"swap":[73,78,72]},{"type":"play","iid":3},{"type":"endTurn"},{"type":"play","iid":43},{"type":"endTurn"},{"type":"play","iid":14},{"type":"attack","attacker":3,"target":"leader"},{"type":"endTurn"},{"type":"extraPp"},{"type":"play","iid":56},{"type":"act","iid":56},{"type":"choose","targets":[3]},{"type":"endTurn"},{"type":"play","iid":12},{"type":"play","iid":81},{"type":"play","iid":82},{"type":"attack","attacker":14,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":55},{"type":"act","iid":55},{"type":"endTurn"},{"type":"play","iid":7},{"type":"play","iid":83},{"type":"attack","attacker":14,"target":"leader"},{"type":"attack","attacker":12,"target":"leader"},{"type":"attack","attacker":81,"target":"leader"},{"type":"attack","attacker":82,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":50},{"type":"act","iid":50},{"type":"evolve","iid":85},{"type":"play","iid":41},{"type":"attack","attacker":85,"target":14},{"type":"endTurn"},{"type":"play","iid":35},{"type":"attack","attacker":12,"target":"leader"},{"type":"evolve","iid":35},{"type":"attack","attacker":81,"target":"leader"},{"type":"attack","attacker":82,"target":"leader"},{"type":"attack","attacker":83,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":45},{"type":"evolve","iid":45},{"type":"choose","targets":[35]},{"type":"act","iid":50},{"type":"play","iid":51},{"type":"attack","attacker":45,"target":81},{"type":"endTurn"},{"type":"play","iid":38},{"type":"evolve","iid":12},{"type":"attack","attacker":12,"target":"leader"},{"type":"play","iid":25},{"type":"attack","attacker":82,"target":"leader"},{"type":"attack","attacker":83,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":70},{"type":"act","iid":70},{"type":"endTurn"}]"#,
    );
    apply_all(&new_game(elf(), bishop(), 2275116772), &log)
}

/// エルフのターンを最後まで進め、プレイしたカード名とその時点のコンボ
fn elf_plays(agent: &mut dyn Agent, seed: u32) -> Vec<(&'static str, i32)> {
    let (moves, _) = turn_moves(start_2275116772(), 0, agent, seed);
    moves
        .into_iter()
        .filter_map(|m| m.played.map(|c| (c, m.combo)))
        .collect()
}

/// 7 ターン目（PP 7・SEP 2、相手は体力 8 で場にフォロワーなし）。アリア → 超進化 → フェアリーで顔 4 点にすると、
/// クレストで疾走の付くフェアリーで次のターンに倒しきれる（相手のターン後に 4 割強。テイマーの手は 1 割強）
#[test]
fn turn7_plays_aria_for_next_lethal() {
    assert_eq!(start_2275116772().players[0].combo, 0);
    for seed in [1, 2, 3] {
        let learned = SearchOptions::default().extra_eval;
        let mut agent = RhinoAgent::with_options(
            true,
            SearchOptions {
                next_lethal: 10.0,
                ..rhino_search_options(RHINO_POTENTIAL, ALL_HOLDS, learned.clone())
            },
            SearchOptions {
                extra_eval: learned,
                ..SearchOptions::default()
            },
        );
        let plays = elf_plays(&mut agent, seed);
        assert!(
            plays.iter().any(|(c, _)| *c == "自然の妖精姫・アリア"),
            "シード {seed}: {plays:?}"
        );
    }
}

/// テイマーの並びがビームで切られず、燐光の岩はコンボ 2 以上で出す（森の神秘が加わる）
#[test]
fn turn7_plays_rock_with_combo() {
    for (card, combo) in elf_plays(&mut RhinoAgent::new(true), 1) {
        if card == "燐光の岩" {
            assert!(combo >= 2);
        }
    }
}
