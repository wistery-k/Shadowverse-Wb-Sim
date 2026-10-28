//! 使わない融合を次のターン以降に回す（SearchOptions.deferFuse。2026-10-28、ユーザーの指摘
//! 「AFネメシスが 3 ターン目に、出せないキャッスルアーティファクトを作るためにコアを融合する」から）

use super::*;
use crate::ai::search::{SearchAgent, SearchOptions};

/// AFネメシスの手番の局面（PP pp、手札と場は names・board の名前のカード。相手の場は空）
fn af_turn(pp: i32, hand: &[&str], board: &[&str]) -> GameState {
    let mut s = keep_hands(new_game(deck("AFネメシス"), deck_at(1), 7));
    s.phase = Phase::Main;
    s.active = 0;
    s.turn = 12;
    s.players[0].turn_count = 6;
    s.players[0].max_pp = pp.max(1);
    s.players[0].pp = pp;
    s.players[0].ep = 2;
    s.players[0].hand = hand_cards(&mut s, hand).into();
    let b: Vec<OnBoard> = board.iter().map(|n| old_follower(&mut s, n)).collect();
    s.players[0].board = b.into();
    s.players[1].board.make_mut().clear();
    s
}

/// 最初の手ごとのターン末の候補の、最初の手と終局面の自分の手札（カード名）
fn candidates(s: &GameState, defer: bool) -> Vec<(Action, Vec<&'static str>)> {
    let ag = SearchAgent::new(SearchOptions {
        defer_fuse: defer,
        ..SearchOptions::default()
    });
    ag.turn_end_candidates(s, 0)
        .into_iter()
        .map(|(a, _, end)| {
            let hand = end.players[0]
                .hand
                .iter()
                .map(|h| name_of(h.card))
                .collect();
            (a, hand)
        })
        .collect()
}

const PRODUCTS: [&str; 6] = [
    "アタックアーティファクト",
    "キャッスルアーティファクト",
    "デストロイアーティファクトα",
    "デストロイアーティファクトβ",
    "デストロイアーティファクトγ",
    "イクシードアーティファクトΩ",
];

#[test]
fn unused_fusion_is_deferred() {
    // PP 2 ではアタック・キャッスル（コスト 3）を出せないので、コアを融合しても使えない。ターン末の候補に融合は残らない
    // （コアが 3 枚あればデストロイアーティファクトαまで作れて、手札の種類が増えるので残す。fusion_that_adds_a_destroy_kind_is_kept）
    let s = af_turn(2, &["パスト・コア", "フューチャー・コア"], &[]);
    let with = candidates(&s, true);
    assert!(
        with.iter().all(|(a, _)| !matches!(a, Action::Fuse { .. })),
        "{with:?}"
    );
    assert!(with
        .iter()
        .all(|(_, hand)| hand.iter().all(|n| !PRODUCTS.contains(n))));
    // deferFuse なしなら融合も候補に残る
    let without = candidates(&s, false);
    assert!(without
        .iter()
        .any(|(a, _)| matches!(a, Action::Fuse { .. })));
}

#[test]
fn fusion_used_this_turn_is_kept() {
    // PP 3 なら、融合して作ったアタック・キャッスルをそのターンに出す並びは候補に残る
    let s = af_turn(
        3,
        &["パスト・コア", "パスト・コア", "フューチャー・コア"],
        &[],
    );
    let with = candidates(&s, true);
    assert!(
        with.iter().any(|(a, _)| matches!(a, Action::Fuse { .. })),
        "{with:?}"
    );
}

#[test]
fn fusion_copied_by_alouette_is_kept() {
    // 融合で作ったデストロイアーティファクトγを、改境の天宮・アルエットの進化時能力でコピーする並びは、γ が手札に残っても使ったものとする
    let s = af_turn(
        0,
        &["アタックアーティファクト", "キャッスルアーティファクト"],
        &["改境の天宮・アルエット"],
    );
    let fuse = |a: &Action| matches!(a, Action::Fuse { .. });
    let with = candidates(&s, true);
    let (_, hand) = with
        .iter()
        .find(|(a, _)| fuse(a))
        .unwrap_or_else(|| panic!("融合から始まる候補がありません: {with:?}"));
    assert!(hand.contains(&"デストロイアーティファクトγ"), "{hand:?}");
}

#[test]
fn fusion_at_hand_limit_is_kept() {
    // 融合しないと手札が上限（9 枚）のままなら、そのターンに使わない融合も候補に残す（次のターンに引くカードが溢れないように）
    let mut hand = vec!["パスト・コア", "パスト・コア"];
    hand.extend(["ブーストエクステンド・ララミア"; 3]);
    hand.extend(["プロシードハート・オーキス"; 3]);
    hand.push("箱庭の断罪者・シルヴィア");
    assert_eq!(hand.len(), HAND_LIMIT);
    let s = af_turn(2, &hand, &[]);
    let with = candidates(&s, true);
    assert!(
        with.iter().any(|(a, _)| matches!(a, Action::Fuse { .. })),
        "{with:?}"
    );
    // 1 枚少なければ回す
    hand.pop();
    let s = af_turn(2, &hand, &[]);
    let with = candidates(&s, true);
    assert!(
        with.iter().all(|(a, _)| !matches!(a, Action::Fuse { .. })),
        "{with:?}"
    );
}

#[test]
fn fusion_that_adds_a_destroy_kind_is_kept() {
    // 手札に無い種類のデストロイアーティファクトを作る融合は、そのターンに使わなくても残す（手で作った評価の fusionSet が上がる。Ω に向けてそろえる）
    let s = af_turn(
        0,
        &["アタックアーティファクト", "キャッスルアーティファクト"],
        &[],
    );
    let with = candidates(&s, true);
    let (_, hand) = with
        .iter()
        .find(|(a, _)| matches!(a, Action::Fuse { .. }))
        .unwrap_or_else(|| panic!("融合から始まる候補がありません: {with:?}"));
    assert_eq!(hand, &vec!["デストロイアーティファクトγ"]);
    // 同じ種類がもう手札にあれば増えないので回す
    let s = af_turn(
        0,
        &[
            "アタックアーティファクト",
            "キャッスルアーティファクト",
            "デストロイアーティファクトγ",
        ],
        &[],
    );
    let with = candidates(&s, true);
    assert!(
        with.iter().all(|(a, _)| !matches!(a, Action::Fuse { .. })),
        "{with:?}"
    );
}
