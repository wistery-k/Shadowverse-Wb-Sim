//! 使わない融合を次のターン以降に回す（SearchOptions.deferFuse。2026-10-28、ユーザーの指摘
//! 「AFネメシスが 3 ターン目に、出せないキャッスルアーティファクトを作るためにコアを融合する」から）。
//! 並びの選び方と点数は変えず、選んだ並びから回せる融合を除いて打つ

use super::*;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::data::{data, CrestIdx};

/// AFネメシスの手番の局面（PP pp、手札と場は names・board の名前のカード。相手の場は空）
pub(super) fn af_turn(pp: i32, hand: &[&str], board: &[&str]) -> GameState {
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

/// 使わない融合を回さない、前の版（2026-10-29 に deferFuse・deferFuseLastWords を既定にする前の既定）
fn fusing() -> SearchOptions {
    SearchOptions {
        defer_fuse: false,
        defer_fuse_last_words: false,
        ..SearchOptions::default()
    }
}

/// 使わない融合を回す（deferFuse だけ。ラストワードの分は空けない）
fn deferred() -> SearchOptions {
    SearchOptions {
        defer_fuse: true,
        ..fusing()
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
    // deferFuse なし（前の版）なら融合する並びも候補にある
    let without = candidates_with(&s, fusing());
    assert!(without.iter().any(|(a, _, _)| is_fuse(a)));
    // 点数は変えない（融合は後でもできるので、融合した終局面の点数より悪くはならない）
    assert_eq!(top_value(&s, deferred()), top_value(&s, fusing()));
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
    let (_, v0, end0) = plan(fusing());
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
    // 前の版は、アーティファクトチャージで加えたコアを融合する
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
    // deferFuseHand 7 なら、回すとターン末の手札が 8 枚になる融合は回さない
    let hand7 = candidates_with(
        &s,
        SearchOptions {
            defer_fuse_hand: 7,
            ..deferred()
        },
    );
    assert!(hand7.iter().any(|(a, _, _)| is_fuse(a)), "{hand7:?}");
    // deferFuseLastWords: 場のイリスが破壊されるとパスト・コアが手札に加わるので、ターン末の手札が 8 枚になる融合は回さない
    let s = af_turn(2, &hand, &["ビビッドインベンター・イリス"]);
    let plain = candidates(&s);
    assert!(plain.iter().all(|(a, _, _)| !is_fuse(a)), "{plain:?}");
    let last_words = candidates_with(
        &s,
        SearchOptions {
            defer_fuse_last_words: true,
            ..deferred()
        },
    );
    assert!(
        last_words.iter().any(|(a, _, _)| is_fuse(a)),
        "{last_words:?}"
    );
}

#[test]
fn fusion_adding_destroy_kind_is_kept_with_keep_set() {
    // PP 1 では α（コスト 5）を出せない。手札に β があるので、キャッスルにフューチャーで α を作ると α・β・γ の種類が増える（Ω の準備）。
    // deferFuseKeepSet なら α を作る融合は回さず、なければ回す
    let s = af_turn(
        1,
        &[
            "キャッスルアーティファクト",
            "フューチャー・コア",
            "デストロイアーティファクトβ",
        ],
        &[],
    );
    let alpha = "デストロイアーティファクトα";
    // keepSet は自分の評価の重みの手で作った評価で比べるので、重みを探索 AI の既定にして見る
    // （S = 0 の補正が既定なら既定の weights は全部 0 で、keepSet は効かない）
    let keep = candidates_with(
        &s,
        SearchOptions {
            defer_fuse_keep_set: true,
            weights: None,
            policy_weights: None,
            ..deferred()
        },
    );
    assert!(
        keep.iter().any(|(_, hand, _)| hand.contains(&alpha)),
        "{keep:?}"
    );
    let plain = candidates(&s);
    assert!(
        plain.iter().all(|(_, hand, _)| !hand.contains(&alpha)),
        "{plain:?}"
    );
}

#[test]
fn fusion_that_lets_ace_crest_draw_is_kept() {
    // 新たなる少女・エースのクレストは、ターン終了時に手札が 5 枚以下なら 1 枚引き、6 枚以上なら回復する。
    // 融合で手札を 6 枚から 5 枚にすれば引けるので、その融合は回さない（2026-10-29、ユーザーの指摘）
    let mut hand = vec!["パスト・コア", "パスト・コア"];
    hand.extend(["ブーストエクステンド・ララミア"; 3]);
    hand.push("プロシードハート・オーキス");
    let mut s = af_turn(2, &hand, &[]);
    // クレストが無ければ回す
    let plain = candidates(&s);
    assert!(plain.iter().all(|(a, _, _)| !is_fuse(a)), "{plain:?}");
    let crest = data()
        .crests
        .iter()
        .position(|c| c.id == "10174112") // クレスト：新たなる少女・エース
        .unwrap() as CrestIdx;
    let iid = s.new_iid();
    s.players[0].crests.make_mut().push(CrestInstance {
        iid,
        crest,
        countdown: Some(3),
        order: 0,
        used_once: Vec::new(),
    });
    let with = candidates(&s);
    assert!(with.iter().any(|(a, _, _)| is_fuse(a)), "{with:?}");
}

#[test]
fn deferred_plan_still_makes_settled_trades() {
    // AFネメシス対アマリアロイヤル（rhino-compare --subject af の g38・席 0、ラストワード版）の 4 ターン目の終わり。
    // 場のミリアム 2 体は、相手のワルツ（2/1）・スタチウム（4/4）と相打ちできる（合流する攻撃。ターン末の点数はこれを打った局面）。
    // 探索の最良の並びは「パスト・コア 2 枚の融合」だけで、回すと何も残らない。そのときターン終了だけにすると相打ちをせずに終える
    // （2026-10-29、ロイヤル戦の分かれ目から。前の版は 240 試合で 0 回、ラストワード版は 75 回）。相打ちを打つ
    let mut s = new_game(deck("AFネメシス"), deck("アマリアロイヤル"), 800494);
    let seq = actions(
        r#"[{"type":"mulligan","player":1,"swap":[62]},{"type":"mulligan","player":0,"swap":[6,14]},{"type":"endTurn"},
        {"type":"play","iid":3},{"type":"endTurn"},{"type":"play","iid":50},{"type":"attack","attacker":81,"target":3},{"type":"endTurn"},
        {"type":"extraPp"},{"type":"play","iid":16},{"type":"attack","attacker":16,"target":50},{"type":"endTurn"},{"type":"play","iid":55},
        {"type":"endTurn"},{"type":"play","iid":19},{"type":"endTurn"},{"type":"play","iid":59},{"type":"attack","attacker":55,"target":"leader"},
        {"type":"endTurn"},{"type":"fuse","host":82,"materials":[83]},{"type":"play","iid":20},{"type":"fuse","host":82,"materials":[84,86]},
        {"type":"evolve","iid":20},{"type":"fuse","host":85,"materials":[88]}]"#,
    );
    s = apply_all(&s, &seq);
    assert_eq!(s.active, 0);
    assert!(!crate::ai::converging::converging_attacks(&s, 0).is_empty());
    let legal = legal_actions(&s);
    let mut ag = SearchAgent::new(SearchOptions {
        defer_fuse: true,
        defer_fuse_last_words: true,
        ..SearchOptions::default()
    });
    let a = ag.choose_action(&s, &legal, &mut Rng::new(1));
    assert!(matches!(a, Action::Attack { .. }), "{a:?}");
}

#[test]
fn deferred_plans_start_with_listed_actions() {
    // 回せる融合を除いて打ち直した並びの最初の手が、同じカードの別の 1 枚を使う融合（合法手の一覧には無い）になることがある。
    // 一覧に無い手は選ばれず、次に良い手を打っていた（2026-10-30、AFネメシスで 1 試合 0.46 回）。読み直した手は、どれも一覧の手
    let small = || SearchOptions {
        beam_width: 32,
        max_depth: 8,
        ..SearchOptions::default()
    };
    let mut checked = 0;
    for (k, seed) in [5u32, 11, 17].into_iter().enumerate() {
        let mut s = new_game(deck("AFネメシス"), deck_at(k + 1), seed);
        let mut agents = [SearchAgent::new(small()), SearchAgent::new(small())];
        let mut rng = Rng::new(seed);
        while s.phase != Phase::Ended && s.turn <= 16 {
            let legal = legal_actions(&s);
            let p = acting_player(&s);
            if p == 0
                && s.pending.is_none()
                && legal.len() > 1
                && legal.iter().any(|a| matches!(a, Action::Fuse { .. }))
            {
                for plan in agents[0].ranked_plans(&s, p, &mut Rng::new(seed ^ s.turn as u32)) {
                    assert!(
                        legal.contains(&plan.action),
                        "一覧に無い手 {:?}（ターン {}）",
                        plan.action,
                        s.turn
                    );
                    checked += 1;
                }
            }
            let a = agents[p].choose_action(&s, &legal, &mut rng);
            s = apply(&s, &a);
        }
    }
    assert!(checked > 0);
}
