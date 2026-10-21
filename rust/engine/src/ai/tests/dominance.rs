//! 下位互換の味方で同じことができる攻撃を展開しない（SearchOptions.dominance）

use super::*;
use crate::ai::converging::{dominated_attack, settle_converging_trades_with};
use crate::ai::search::{SearchAgent, SearchOptions};

/// プレイヤー0 の手番（PP 0）で、場が空の局面
fn empty_boards() -> GameState {
    let s = new_game(class_deck(ClassId::Royal), class_deck(ClassId::Nemesis), 1);
    let mut s = skip_mulligan(s);
    s.active = 0;
    s.turn = 9;
    for pl in s.players.iter_mut() {
        pl.board.make_mut().clear();
        pl.pp = 0;
    }
    s
}

/// 前のターンから場にいるフォロワーを置く
fn put(s: &mut GameState, p: PlayerIndex, name: &str, attack: i32, defense: i32) -> Iid {
    let mut f = board_card(s, name);
    f.attack = attack;
    f.defense = defense;
    f.max_defense = defense;
    f.entered_turn = s.turn - 1;
    let iid = f.iid;
    s.players[p].board.make_mut().push(f);
    iid
}

fn attack(a: Iid, t: Option<Iid>) -> Action {
    Action::Attack {
        attacker: a,
        target: t,
    }
}

/// 勇猛のルミナスランサー 1/2・ナイト 1/1 と、相手のマリオネットランサー 2/1
fn lancer_knight() -> (GameState, Iid, Iid, Iid) {
    let mut s = empty_boards();
    let lancer = put(&mut s, 0, "勇猛のルミナスランサー", 1, 2);
    let knight = put(&mut s, 0, "ナイト", 1, 1);
    let target = put(&mut s, 1, "マリオネットランサー", 2, 1);
    (s, lancer, knight, target)
}

#[test]
fn trades_with_the_weaker_ally() {
    let (s, lancer, knight, target) = lancer_knight();
    // ルミナスランサーで相打ちする手と、ナイトで顔を殴る手は展開しない（ナイトで相打ちしてルミナスランサーで顔を殴る手順がある）
    assert!(dominated_attack(&s, &attack(lancer, Some(target))));
    assert!(dominated_attack(&s, &attack(knight, None)));
    assert!(!dominated_attack(&s, &attack(knight, Some(target))));
    assert!(!dominated_attack(&s, &attack(lancer, None)));
    // ナイトが攻撃した後なら、ルミナスランサーで相打ちするしかない
    let after = apply(&s, &attack(knight, None));
    assert!(!dominated_attack(&after, &attack(lancer, Some(target))));
}

#[test]
fn settles_trades_with_the_weaker_ally() {
    // 合流する相打ちも、下位互換の方で打つ（場の順では先のルミナスランサーが攻撃する）
    let (s, lancer, knight, _) = lancer_knight();
    let cheapest = settle_converging_trades_with(&s, 0, true).expect("合流する攻撃");
    assert!(cheapest.board_card(lancer).is_some());
    assert!(cheapest.board_card(knight).is_none());
    let first = settle_converging_trades_with(&s, 0, false).expect("合流する攻撃");
    assert!(first.board_card(lancer).is_none());
}

#[test]
fn not_dominated_when_outcomes_differ() {
    // 上位互換の方が相打ちで残るなら、外さない
    let (mut s, lancer, _, target) = lancer_knight();
    board_mut(&mut s, lancer).defense = 3;
    board_mut(&mut s, lancer).max_defense = 3;
    assert!(!dominated_attack(&s, &attack(lancer, Some(target))));
    // ラストワードを持つフォロワーは、破壊されると得をするので上位互換と見ない
    let mut s = empty_boards();
    let coachman = put(&mut s, 0, "王家の御者", 1, 2);
    let knight = put(&mut s, 0, "ナイト", 1, 1);
    let target = put(&mut s, 1, "マリオネットランサー", 2, 1);
    assert!(!dominated_attack(&s, &attack(coachman, Some(target))));
    assert!(!dominated_attack(&s, &attack(knight, None)));
}

#[test]
fn not_dominated_when_weaker_has_more_keywords() {
    // 下位互換の方だけが持つキーワード（守護）があれば上位互換と見ない。突進・疾走は攻撃できる先で比べる
    let (mut s, lancer, knight, target) = lancer_knight();
    let f = board_mut(&mut s, knight);
    f.keywords = f.keywords.with(crate::data::RUSH);
    assert!(dominated_attack(&s, &attack(lancer, Some(target))));
    let f = board_mut(&mut s, knight);
    f.keywords = f.keywords.with(crate::data::WARD);
    assert!(!dominated_attack(&s, &attack(lancer, Some(target))));
}

/// seed 3054946244（アマリアロイヤル vs AFネメシス、どちらもリノセウス用 AI。ネメシス先攻）。
/// ユーザーが指摘した試合の、修正前の手順（n 手目まで）
fn state_3054946244(n: usize) -> GameState {
    let log = actions(
        r#"[{"player":1,"swap":[75,67,66],"type":"mulligan"},{"player":0,"swap":[37,27,36],"type":"mulligan"},{"type":"endTurn"},{"type":"extraPp"},{"iid":11,"type":"play"},{"type":"endTurn"},{"iid":47,"type":"play"},{"type":"endTurn"},{"iid":5,"type":"play"},{"attacker":81,"target":"leader","type":"attack"},{"attacker":11,"target":47,"type":"attack"},{"type":"endTurn"}]"#,
    );
    apply_all(
        &new_game(deck("アマリアロイヤル"), deck("AFネメシス"), 3054946244),
        &log[..n],
    )
}

/// ロイヤルの 2 ターン目（場に勇猛のルミナスランサー 1/2・ナイト 1/1、相手の場にマリオネットランサー 2/1）。
/// 以前はナイトで顔を殴り、ルミナスランサーでマリオネットランサーと相打ちしていた（学習した補正がナイトを残す方を 1.3 点高く見た）。
/// ナイトで相打ちする方が上（打ち比べ 268/384 対 253/384）
#[test]
fn royal_turn2_keeps_luminous_lancer() {
    let start = state_3054946244(8);
    let lancer = start.players[0]
        .board
        .iter()
        .find(|c| name_of(c.card) == "勇猛のルミナスランサー")
        .expect("ルミナスランサー")
        .iid;
    for seed in 1..=4 {
        let mut agent = SearchAgent::new(SearchOptions::default());
        let (_, end) = play_turn(start.clone(), 0, &mut agent, &mut Rng::new(seed));
        assert!(end.board_card(lancer).is_some(), "シード {seed}");
    }
}

/// ネメシスの 3 ターン目（相手の場にフィルドア 2/2・ナイト 1/1）。実戦の 改良型・操り人形 → フィルドアを攻撃 → イリス は、
/// 決定化 3 回のぶれで選ばれたもの（この局面で AI に選ばせると 48 回中 0 回）。打ち比べではミリアム 70/192、実戦 51/192
#[test]
fn nemesis_turn3_does_not_lead_with_puppet() {
    let start = state_3054946244(12);
    for seed in 1..=4 {
        let mut agent = SearchAgent::new(SearchOptions::default());
        let (moves, _) = play_turn(start.clone(), 1, &mut agent, &mut Rng::new(seed));
        let Action::Play(iid) = moves[0].1 else {
            panic!("シード {seed}: 最初の手がプレイではない");
        };
        let first = name_of(moves[0].0.hand_card(iid).expect("手札").card);
        assert_ne!(first, "改良型・操り人形", "シード {seed}");
    }
}
