//! リノセウス用 AI（tests/rhino.test.ts）

use super::*;
use crate::ai::rhino::{
    can_still_play_rhinos, next_turn_rhino_bound, rhino_search_options,
    search_lethal_for_rhino_turn, RhinoAgent, RHINO_POTENTIAL,
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

/// マリガン後、エルフ（プレイヤー0）の手番の局面
fn main_phase() -> GameState {
    let mut s = skip_mulligan(new_game(elf(), royal(), 1));
    s.active = 0;
    s
}

// ---- 次のターンの打点の上限 ----

#[test]
fn next_turn_bound_grows_with_rhinos() {
    // 次のターンのリノセウスの打点の見積もりは、手札にリノセウスが無ければ 0、増えれば上がる
    let mut s = main_phase();
    s.players[0].pp = 7;
    s.players[0].max_pp = 7;
    s.players[0].hand.make_mut().clear();
    assert_eq!(next_turn_rhino_bound(&s, 0), 0);
    let r = hand_card(&mut s, "殺戮のリノセウス");
    s.players[0].hand.make_mut().push(r);
    let one = next_turn_rhino_bound(&s, 0);
    assert!(one > 0);
    let more = hand_cards(&mut s, &["殺戮のリノセウス", "森の神秘"]);
    s.players[0].hand.make_mut().extend(more);
    assert!(next_turn_rhino_bound(&s, 0) > one);
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
        me.hand = vec![fairies[0].clone(), fairies[1].clone(), bail, rhino].into();
        me.board = vec![rod].into();
        me.pp = 8;
        me.max_pp = 8;
        me.turn_count = 8;
        me.ep = 0;
        me.sep = 1;
        me.combo = 0;
        me.extra_pp_available = false;
    }
    s.players[1].board = vec![william].into();
    s.players[1].leader_hp = 11;
    let seq = search_rhino_lethal(&s, 0, &DEFAULT_RHINO_LETHAL_OPTIONS).expect("リーサル");
    let rhino_card = id("殺戮のリノセウス");
    let mut rhino_plays = 0;
    for a in &seq {
        if let Action::Play(iid) = a {
            if s.players[0]
                .hand
                .iter()
                .any(|h| h.iid == *iid && h.card == rhino_card)
            {
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
        me.hand = vec![fairies[0].clone(), fairies[1].clone(), bail, rhino].into();
        me.board = vec![rod, tamer].into();
        me.pp = 10;
        me.max_pp = 10;
        me.turn_count = 10;
        me.ep = 0;
        me.sep = 0;
        me.combo = 0;
        me.extra_pp_available = false;
    }
    let tenko = board_card(&mut s, "式神・天后");
    s.players[1].board = vec![tenko].into();
    s.players[1].leader_hp = 9;
    let seq = search_rhino_lethal(&s, 0, &DEFAULT_RHINO_LETHAL_OPTIONS);
    assert!(wins(&s, seq.as_deref(), 0));
}

#[test]
fn rhino_lethal_plays_mystery_first() {
    // 森の神秘は手札にあれば先に打つ（打ってもリーサルを逃さない）
    let mut s = main_phase();
    s.players[0].hand = hand_cards(&mut s, &["森の神秘", "森の神秘", "殺戮のリノセウス"]).into();
    s.players[0].pp = 3;
    s.players[0].max_pp = 3;
    s.players[0].combo = 0;
    s.players[1].board.make_mut().clear();
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
    s.players[0].hand = hand_cards(&mut s, &["フェアリー"]).into();
    assert!(search_rhino_lethal(&s, 0, &DEFAULT_RHINO_LETHAL_OPTIONS).is_none());
}

#[test]
fn rhino_count_check_pays_for_carbuncle() {
    // 手札のベビーカーバンクルの超進化（PP 3 回復）は、出す 2 PP を払えるときだけ、その差の 1 PP として数える
    let mut s = main_phase();
    let carbuncle = hand_card(&mut s, "ベビーカーバンクル");
    let rhino = board_card(&mut s, "殺戮のリノセウス");
    {
        let me = &mut s.players[0];
        me.hand = vec![carbuncle].into();
        me.board = vec![rhino].into();
        me.max_pp = 8;
        me.turn_count = 8;
        me.ep = 0;
        me.sep = 1;
        me.extra_pp_available = false;
    }
    for (pp, ok) in [(0, false), (1, false), (2, true)] {
        s.players[0].pp = pp;
        assert_eq!(can_still_play_rhinos(&s, 0, 1), ok, "PP {pp}");
    }
    // 場にいれば 3 PP 回復をそのまま数える（戻すのは杖）
    let rod = board_card(&mut s, "聖樹の杖");
    let on_board = board_card(&mut s, "ベビーカーバンクル");
    let me = &mut s.players[0];
    me.hand.make_mut().clear();
    me.board.make_mut().push(rod);
    me.board.make_mut().push(on_board);
    me.pp = 0;
    assert!(can_still_play_rhinos(&s, 0, 1));
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

/// 7 ターン目（相手の場にフォロワーなし）。フェアリーの後に燐光の岩を出すとコンボ 2 で森の神秘が加わらない。
/// 以前はビームで、手の順番が違うだけの局面（加わったフェアリーの iid が違う）がまとまらず枠を埋め、岩を 2 手目に出していた。
/// 確かめたいのは探索の同じ局面の判定なので、手で作った評価だけで打つ（介入データを混ぜた補正では、乱数 8 通り中 5 通りで
/// 岩をコンボ 2 で出す。docs/ai-notes.md「介入データを TD 学習に混ぜる」）
#[test]
fn turn7_does_not_play_rock_after_fairy() {
    let s = state_1678126716(50);
    assert_eq!(s.players[1].combo, 1);
    let mut agent = RhinoAgent::with_options(
        true,
        rhino_search_options(RHINO_POTENTIAL, None),
        SearchOptions {
            extra_eval: None,
            ..SearchOptions::default()
        },
    );
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
/// 以前は選択も 1 手分の深さを使い（推奨は 10 手）、コンボを稼ぐ途中の点数が低いため幅 8 のビームで切られていた。
/// 補正 o60p はこの局面で相手の場を残す並びも選ぶ（30 シード中 20。そこから最後まで打ってもほぼ勝つ。docs/ai-notes.md「3 回目: …」）ので、
/// 確かめるのはビームがこの並びを切らないこと（シード 1〜5 のどれかで選ぶ）
#[test]
fn elf_turn7_lily_with_combo() {
    let found = (1..=5).any(|seed| {
        let (moves, end) = turn_moves(state_954874822(47), 0, &mut RhinoAgent::new(true), seed);
        // このターンに勝てばよい（合流する相打ちの扱い（settleTrades）を入れてから、このターンのリーサルを見つけるようになった）
        if end.phase == Phase::Ended {
            return end.winner == Some(0);
        }
        moves
            .iter()
            .any(|m| m.played == Some("ピュアクリスタリア・リリィ") && m.combo >= 2)
            && followers(&end, 1) == 0
    });
    assert!(found);
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
/// クレストで疾走の付くフェアリーで次のターンに倒しきれる（相手のターン後に 4 割強。テイマーの手は 1 割強）。
/// ビームがこの並びを切らずに読めることを見るので、学習した補正は入れない。
/// 補正 s2b（2026-10-22 から既定）はアリアを 12 回中 4 回しか出さないが、最後まで打つと s2b の手の勝率 56.3%、
/// 必ずアリアを出す手（前の既定 qlp）51.8%（400 回）で、アリアが良いとは言えない（docs/ai-notes.md「読みの中の相手のずれを学習で直す・資源の介入」）
#[test]
fn turn7_plays_aria_for_next_lethal() {
    assert_eq!(start_2275116772().players[0].combo, 0);
    for seed in [1, 2, 3] {
        let learned = None;
        let mut agent = RhinoAgent::with_options(
            true,
            SearchOptions {
                next_lethal: 10.0,
                ..rhino_search_options(RHINO_POTENTIAL, learned.clone())
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

/// ユーザーの指摘（リノセウスエルフ vs アマリアロイヤル、seed 3897936013、両方ともリノセウス用 AI、エルフ後攻）。
/// エルフの 8 ターン目の開始までの行動（main の 778589e の AI の手）
fn start_3897936013() -> GameState {
    let log = actions(
        r#"[{"type":"mulligan","player":1,"swap":[66,62,79]},{"type":"mulligan","player":0,"swap":[38]},{"type":"endTurn"},{"type":"play","iid":11},{"type":"endTurn"},{"type":"play","iid":43},{"type":"endTurn"},{"type":"play","iid":8},{"type":"play","iid":10},{"type":"extraPp"},{"type":"play","iid":1},{"type":"attack","attacker":11,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":42},{"type":"attack","attacker":83,"target":1},{"type":"endTurn"},{"type":"play","iid":15},{"type":"play","iid":81},{"type":"attack","attacker":11,"target":"leader"},{"type":"attack","attacker":10,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":61},{"type":"attack","attacker":42,"target":15},{"type":"endTurn"},{"type":"play","iid":12},{"type":"attack","attacker":11,"target":61},{"type":"evolve","iid":12},{"type":"play","iid":82},{"type":"play","iid":84},{"type":"attack","attacker":10,"target":"leader"},{"type":"attack","attacker":12,"target":61},{"type":"play","iid":85},{"type":"attack","attacker":81,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":62},{"type":"attack","attacker":42,"target":81},{"type":"evolve","iid":88},{"type":"attack","attacker":88,"target":10},{"type":"endTurn"},{"type":"play","iid":34},{"type":"attack","attacker":82,"target":88},{"type":"evolve","iid":34},{"type":"attack","attacker":84,"target":91},{"type":"attack","attacker":34,"target":90},{"type":"attack","attacker":85,"target":"leader"},{"type":"endTurn"},{"type":"play","iid":69},{"type":"play","iid":56},{"type":"choose","targets":[34]},{"type":"evolve","iid":56},{"type":"attack","attacker":56,"target":85},{"type":"endTurn"},{"type":"play","iid":86},{"type":"play","iid":30},{"type":"play","iid":26},{"type":"choose","targets":[69]},{"type":"attack","attacker":86,"target":69},{"type":"extraPp"},{"type":"play","iid":5},{"type":"choose","targets":[26]},{"type":"endTurn"},{"type":"play","iid":71},{"type":"play","iid":51},{"type":"superEvolve","iid":71},{"type":"choose","targets":[94]},{"type":"endTurn"},{"type":"play","iid":87},{"type":"play","iid":19},{"type":"choose","targets":[87]},{"type":"play","iid":93},{"type":"choose","targets":[71]},{"type":"superEvolve","iid":93},{"type":"choose","targets":[71]},{"type":"play","iid":21},{"type":"attack","attacker":93,"target":94},{"type":"endTurn"},{"type":"play","iid":47},{"type":"play","iid":60},{"type":"superEvolve","iid":60},{"type":"attack","attacker":60,"target":93},{"type":"attack","attacker":98,"target":19},{"type":"play","iid":50},{"type":"attack","attacker":51,"target":"leader"},{"type":"endTurn"}]"#,
    );
    apply_all(
        &new_game(
            deck("リノセウスエルフ"),
            deck("アマリアロイヤル"),
            3897936013,
        ),
        &log,
    )
}

/// 8 ターン目（PP 8・SEP 1、相手は体力 15 で守護なし）。森の神秘 → フェアリー 3 枚を相手のフォロワーに当ててベイルを 0 コストに →
/// ベイル → リノセウス 6 点 → カーバンクルで戻して超進化（PP 3 回復）→ リノセウス 8 点 → 燐光の岩のアクト 1 点などで 15 点ちょうど。
/// 全探索の「あと何回リノセウスを出せるか」の判定が、手札のカーバンクルの PP 3 回復を出す 2 PP を引かずに数えていたため、
/// リノセウスを 1 体出して PP 0 になった後の、もう出せない局面を調べ続けて 3 万局面で打ち切っていた
#[test]
fn turn8_lethal_with_carbuncle_refund() {
    let s = start_3897936013();
    assert_eq!(
        (s.active, s.players[0].pp, s.players[1].leader_hp),
        (0, 8, 15)
    );
    fresh();
    let seq = search_lethal_for_rhino_turn(&s, 0);
    assert!(wins(&s, seq.as_deref(), 0));
    // 実際に打っても、このターンに倒しきる
    fresh();
    let end = play_active(s, 0, &mut RhinoAgent::new(true), &mut Rng::new(1));
    assert_eq!(end.winner, Some(0));
}

/// 同じ局面で相手の体力を 17 にしたもの（ユーザーの指摘）。森の神秘 → フェアリー 3 枚 → カーバンクルでフェアリーを戻す →
/// フェアリー 2 体を相手のフォロワーに当てる → ベイル → カーバンクルを超進化（PP 3 回復）→ リノセウス → 聖樹の杖で戻す → リノセウス で 17 点。
/// 汎用の上限では打ち切れない局面が多く、10 万局面ほど調べないと見つからなかった。リノセウスエルフ専用の上限（rhino_turn_damage_bound）で 6 万局面以内に見つかる
#[test]
fn turn8_lethal_17_with_rhino_bound() {
    let mut s = start_3897936013();
    s.players[1].leader_hp = 17;
    fresh();
    let seq = search_lethal_for_rhino_turn(&s, 0);
    assert!(wins(&s, seq.as_deref(), 0));
}
