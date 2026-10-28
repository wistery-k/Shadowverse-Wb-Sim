//! 使わない融合を次のターン以降に回す（SearchOptions.deferFuse・deferFuseKeepSet。2026-10-28、ユーザーの指摘
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

/// 候補の最初の手と、終局面の自分の手札・場（カード名）
type Cand = (Action, Vec<&'static str>, Vec<&'static str>);

/// 最初の手ごとのターン末の候補
fn candidates_with(s: &GameState, opts: SearchOptions) -> Vec<Cand> {
    let ag = SearchAgent::new(opts);
    let names = |v: &mut dyn Iterator<Item = CardIdx>| v.map(name_of).collect::<Vec<_>>();
    ag.turn_end_candidates(s, 0)
        .into_iter()
        .map(|(a, _, end)| {
            let hand = names(&mut end.players[0].hand.iter().map(|h| h.card));
            let board = names(&mut end.players[0].board.iter().map(|c| c.card));
            (a, hand, board)
        })
        .collect()
}

/// 使わない融合を回す（deferFuse。α・β・γ の種類が増える融合は残す deferFuseKeepSet も既定のまま）
fn deferred() -> SearchOptions {
    SearchOptions {
        defer_fuse: true,
        ..SearchOptions::default()
    }
}

/// deferFuse の探索 AI の候補
fn candidates(s: &GameState) -> Vec<Cand> {
    candidates_with(s, deferred())
}

/// α・β・γ の種類が増える融合も回す（deferFuseKeepSet なし）
fn strict() -> SearchOptions {
    SearchOptions {
        defer_fuse_keep_set: false,
        ..deferred()
    }
}

fn is_fuse(a: &Action) -> bool {
    matches!(a, Action::Fuse { .. })
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
    let s = af_turn(2, &["パスト・コア", "フューチャー・コア"], &[]);
    for opts in [deferred(), strict()] {
        let with = candidates_with(&s, opts);
        assert!(with.iter().all(|(a, _, _)| !is_fuse(a)), "{with:?}");
        assert!(with
            .iter()
            .all(|(_, hand, _)| hand.iter().all(|n| !PRODUCTS.contains(n))));
    }
    // deferFuse なし（今の既定）なら融合も候補に残る
    let without = candidates_with(&s, SearchOptions::default());
    assert!(without.iter().any(|(a, _, _)| is_fuse(a)));
}

#[test]
fn fusion_used_this_turn_is_kept() {
    // PP 3 なら、融合して作ったアタック・キャッスルをそのターンに出す並びは候補に残る
    let s = af_turn(
        3,
        &["パスト・コア", "パスト・コア", "フューチャー・コア"],
        &[],
    );
    let with = candidates(&s);
    assert!(
        with.iter()
            .any(|(a, _, board)| is_fuse(a) && board.iter().any(|n| PRODUCTS.contains(n))),
        "{with:?}"
    );
}

#[test]
fn destroy_built_and_played_in_one_turn() {
    // 変身したカードはそのターンにもう一度融合できるので、コア 3 枚から α を作ってそのターンに出せる（PP 5）。回さない融合も同じターンに使える
    // （アタック・キャッスルを出す手は打たせない）
    let s = af_turn(
        5,
        &["パスト・コア", "パスト・コア", "フューチャー・コア"],
        &[],
    );
    let no_base: crate::ai::search::Allow = std::sync::Arc::new(|s: &GameState, a: &Action, p| {
        let Action::Play(iid) = a else { return true };
        s.players[p]
            .hand
            .iter()
            .find(|h| h.iid == *iid)
            .is_none_or(|h| !PRODUCTS[..2].contains(&name_of(h.card)))
    });
    let with = candidates_with(
        &s,
        SearchOptions {
            allow: Some(no_base),
            ..strict()
        },
    );
    assert!(
        with.iter()
            .any(|(_, _, board)| board.contains(&"デストロイアーティファクトα")),
        "{with:?}"
    );
}

#[test]
fn fusion_copied_by_alouette_is_kept() {
    // 融合で作ったデストロイアーティファクトγを、改境の天宮・アルエットの進化時能力でコピーする並びは、γ が手札に残っても使ったものとする
    // （手札のアーティファクト・フォロワーが γ だけなので、選ぶ手を打たずに選ばれる）。γ を作る融合は種類が増えるので残すが、それが無くても残す
    let s = af_turn(
        0,
        &["アタックアーティファクト", "キャッスルアーティファクト"],
        &["改境の天宮・アルエット"],
    );
    let with = candidates_with(&s, strict());
    let (_, hand, board) = with
        .iter()
        .find(|(a, _, _)| is_fuse(a))
        .unwrap_or_else(|| panic!("融合から始まる候補がありません: {with:?}"));
    assert!(hand.contains(&"デストロイアーティファクトγ"), "{hand:?}");
    assert!(board.contains(&"デストロイアーティファクトγ"), "{board:?}");
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
    let with = candidates(&s);
    assert!(with.iter().any(|(a, _, _)| is_fuse(a)), "{with:?}");
    // 1 枚少なければ回す
    hand.pop();
    let s = af_turn(2, &hand, &[]);
    let with = candidates(&s);
    assert!(with.iter().all(|(a, _, _)| !is_fuse(a)), "{with:?}");
}

#[test]
fn fusion_that_adds_a_destroy_kind_is_kept() {
    // deferFuseKeepSet: 手札に無い種類のデストロイアーティファクトを作る融合は、そのターンに使わなくても残す（手で作った評価の fusionSet が上がる）。
    // イクシードアーティファクトΩ の素材（α・β・γ）はコアにすると 11 枚以上で、手札に入りきらないので。同じ種類がもう手札にあれば回す
    let s = af_turn(
        0,
        &["アタックアーティファクト", "キャッスルアーティファクト"],
        &[],
    );
    let with = candidates(&s);
    let (_, hand, _) = with
        .iter()
        .find(|(a, _, _)| is_fuse(a))
        .unwrap_or_else(|| panic!("融合から始まる候補がありません: {with:?}"));
    assert_eq!(hand, &vec!["デストロイアーティファクトγ"]);
    // deferFuseKeepSet なしなら回す
    let with = candidates_with(&s, strict());
    assert!(with.iter().all(|(a, _, _)| !is_fuse(a)), "{with:?}");
    // コア 3 枚から α を作るのも残す（PP 2 で出せなくても）
    let s = af_turn(
        2,
        &["パスト・コア", "パスト・コア", "フューチャー・コア"],
        &[],
    );
    let with = candidates(&s);
    assert!(
        with.iter()
            .any(|(_, hand, _)| hand.contains(&"デストロイアーティファクトα")),
        "{with:?}"
    );
    let with = candidates_with(&s, strict());
    assert!(with.iter().all(|(a, _, _)| !is_fuse(a)), "{with:?}");
    // 同じ種類がもう手札にあれば回す
    let s = af_turn(
        0,
        &[
            "アタックアーティファクト",
            "キャッスルアーティファクト",
            "デストロイアーティファクトγ",
        ],
        &[],
    );
    let with = candidates(&s);
    assert!(with.iter().all(|(a, _, _)| !is_fuse(a)), "{with:?}");
}
