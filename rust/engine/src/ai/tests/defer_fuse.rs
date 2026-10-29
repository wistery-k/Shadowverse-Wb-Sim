//! 使わない融合を次のターン以降に回す（SearchOptions.deferFuse。2026-10-28、ユーザーの指摘
//! 「AFネメシスが 3 ターン目に、出せないキャッスルアーティファクトを作るためにコアを融合する」から）。
//! 並びの選び方と点数は変えず、選んだ並びから回せる融合を除いて打つ

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

/// 打つ並びの候補（相手のターンを読まない）
fn candidates_with(s: &GameState, opts: SearchOptions) -> Vec<Cand> {
    let ag = SearchAgent::new(opts);
    let names = |v: &mut dyn Iterator<Item = CardIdx>| v.map(name_of).collect::<Vec<_>>();
    ag.plan_candidates(s, 0)
        .into_iter()
        .map(|(a, _, end)| {
            let hand = names(&mut end.players[0].hand.iter().map(|h| h.card));
            let board = names(&mut end.players[0].board.iter().map(|c| c.card));
            (a, hand, board)
        })
        .collect()
}

/// 使わない融合を回す（deferFuse）
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

/// 点数の最も高い候補の点数
fn top_value(s: &GameState, opts: SearchOptions) -> f64 {
    SearchAgent::new(opts)
        .plan_candidates(s, 0)
        .into_iter()
        .map(|(_, v, _)| v)
        .fold(f64::MIN, f64::max)
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
    // PP 2 ではアタック・キャッスル（コスト 3）も α（コスト 5）も出せないので、コアを融合しても使えない。融合する並びは打たない
    let s = af_turn(
        2,
        &["パスト・コア", "パスト・コア", "フューチャー・コア"],
        &[],
    );
    let with = candidates(&s);
    assert!(with.iter().all(|(a, _, _)| !is_fuse(a)), "{with:?}");
    assert!(with
        .iter()
        .all(|(_, hand, _)| hand.iter().all(|n| !PRODUCTS.contains(n))));
    // deferFuse なし（今の既定）なら融合する並びも候補にある
    let without = candidates_with(&s, SearchOptions::default());
    assert!(without.iter().any(|(a, _, _)| is_fuse(a)));
    // 点数は変えない（融合は後でもできるので、融合した終局面の点数より悪くはならない）
    assert_eq!(
        top_value(&s, deferred()),
        top_value(&s, SearchOptions::default())
    );
}

#[test]
fn core_cards_are_still_played() {
    // 1 版目（使わない融合をした並びを候補から外し、同じ最初の手の別の並びに替える）は、コアを手札に加えるカードを出さなくなった
    // （補正が融合したカードを持つ局面を高く見るので、融合しない並びはどれも低く見える。docs/ai-notes.md「使わない融合を次のターン以降に回す」）。
    // 今の形では、融合した並びの点数のまま融合だけを除くので、アーティファクトチャージを出してコアを手札に残す
    let mut s = af_turn(
        1,
        &[
            "レゾリューション・ミリアム",
            "ブーストエクステンド・ララミア",
            "レゾリューション・ミリアム",
            "アーティファクトチャージ",
            "砲撃の猫獣人",
        ],
        &["改良型・操り人形"],
    );
    s.players[0].max_pp = 2;
    let charge = s.players[0]
        .hand
        .iter()
        .find(|h| name_of(h.card) == "アーティファクトチャージ")
        .map(|h| Action::Play(h.iid))
        .unwrap();
    // アーティファクトチャージから始まる並び
    let plan = |opts| {
        SearchAgent::new(opts)
            .plan_candidates(&s, 0)
            .into_iter()
            .find(|(a, _, _)| *a == charge)
            .unwrap()
    };
    let (_, v0, end0) = plan(SearchOptions::default());
    let (_, v1, end1) = plan(deferred());
    let count = |end: &GameState, f: &dyn Fn(&str) -> bool| {
        end.players[0]
            .hand
            .iter()
            .filter(|h| f(name_of(h.card)))
            .count()
    };
    let core = |n: &str| n.ends_with("コア");
    let product = |n: &str| PRODUCTS.contains(&n);
    // 今の既定は、アーティファクトチャージで加えたコアを融合する
    assert_eq!(count(&end0, &product), 1);
    // deferFuse は同じ点数のまま、コアを融合せずに残す
    assert_eq!(v0, v1);
    assert_eq!(count(&end1, &core), 2);
    assert_eq!(count(&end1, &product), 0);
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
fn fusion_copied_by_alouette_is_kept() {
    // 融合で作ったデストロイアーティファクトγを、改境の天宮・アルエットの進化時能力でコピーする並びは、γ が手札に残っても使ったものとする
    // （手札のアーティファクト・フォロワーが γ だけなので、選ぶ手を打たずに選ばれる）
    let s = af_turn(
        0,
        &["アタックアーティファクト", "キャッスルアーティファクト"],
        &["改境の天宮・アルエット"],
    );
    let with = candidates(&s);
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
