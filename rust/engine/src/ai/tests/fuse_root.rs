//! 先に融合した局面からも探す（SearchOptions.fuseRoot、ai/fusion.rs の fuse_root_chains。2026-10-29）。
//! コアから Ω まで融合が何回も要る並びは、途中の局面の点数が上がらないのでビームから落ちやすい

use super::defer_fuse::af_turn;
use super::*;
use crate::ai::fusion::fuse_root_chains;
use crate::ai::search::{SearchAgent, SearchOptions};

const F: &str = "フューチャー・コア";
const P: &str = "パスト・コア";
const OMEGA: &str = "イクシードアーティファクトΩ";

/// 先に融合した局面ごとに、融合の回数と、融合で変わった手札のカードの名前
fn roots(s: &GameState) -> Vec<(usize, Vec<&'static str>)> {
    let orig: Vec<(Iid, CardIdx)> = s.players[0].hand.iter().map(|h| (h.iid, h.card)).collect();
    fuse_root_chains(s, 0, 4000, 3)
        .into_iter()
        .map(|(chain, u)| {
            let made = u.players[0]
                .hand
                .iter()
                .filter(|h| !orig.contains(&(h.iid, h.card)))
                .map(|h| name_of(h.card))
                .collect();
            (chain.len(), made)
        })
        .collect()
}

/// 手札がリノセウスエルフ戦で Ω を作らなかった局面（docs/ai-notes.md「出さなかった Ω を最後まで打って確かめる」の 29 番）
fn omega_hand() -> Vec<&'static str> {
    vec![
        "プロシードハート・オーキス",
        "デストロイアーティファクトβ",
        "キャッスルアーティファクト",
        "キャッスルアーティファクト",
        "レゾリューション・ミリアム",
        F,
        P,
        P,
        "プロシードハート・オーキス",
    ]
}

#[test]
fn omega_root_when_affordable() {
    // PP 10 なら Ω（コスト 10）を作る並び 1 つだけ（融合 4 回）
    let r = roots(&af_turn(10, &omega_hand(), &[]));
    assert_eq!(r.len(), 1, "{r:?}");
    assert!(r[0].0 >= 2 && r[0].1.contains(&OMEGA), "{r:?}");
    // PP 9 では Ω を出せない。α・β・γ（コスト 5）はどれも 1 回の融合で作れる（キャッスルにコア・キャッスル）ので、先に融合する局面は無い
    let r = roots(&af_turn(9, &omega_hand(), &[]));
    assert!(r.is_empty(), "{r:?}");
}

#[test]
fn destroy_roots_one_per_kind() {
    // コアだけなら、α・β・γ（どれもコスト 5）は融合が 2 回以上要る。種類ごとに 1 つずつ
    let s = af_turn(5, &[F, F, P, P, P], &[]);
    let r = roots(&s);
    let mut kinds: Vec<&str> = r.iter().flat_map(|(_, m)| m.clone()).collect();
    kinds.sort_unstable();
    kinds.dedup();
    assert_eq!(r.len(), 3, "{r:?}");
    for k in [
        "デストロイアーティファクトα",
        "デストロイアーティファクトβ",
        "デストロイアーティファクトγ",
    ] {
        assert!(kinds.contains(&k), "{r:?}");
    }
    assert!(r.iter().all(|(n, _)| *n >= 2), "{r:?}");
    // PP 4 なら出せるのはアタック・キャッスル（コスト 3）で、どれも 1 回の融合で作れる
    let r = roots(&af_turn(4, &[F, F, P, P, P], &[]));
    assert!(r.is_empty(), "{r:?}");
}

/// 相手のターンを読まない並びのうち、勝って終わるものがあるか
fn finds_win(s: &GameState, opts: SearchOptions) -> bool {
    SearchAgent::new(opts)
        .plan_candidates(s, 0)
        .into_iter()
        .any(|(_, _, end)| end.phase == Phase::Ended && end.winner == Some(0))
}

#[test]
fn narrow_beam_finds_omega_with_fuse_root() {
    // 相手の体力 10・場は空。Ω（疾走 10/10）を作って出せば勝つが、融合が 4 回要る。幅 4 のビームでは見落とし、
    // 先に Ω を作った局面からも探せば見つかる
    let mut s = af_turn(10, &omega_hand(), &[]);
    s.players[1].leader_hp = 10;
    let narrow = SearchOptions {
        beam_width: 4,
        ..SearchOptions::default()
    };
    assert!(!finds_win(&s, narrow.clone()));
    assert!(finds_win(
        &s,
        SearchOptions {
            fuse_root: true,
            ..narrow
        }
    ));
}
