//! 素材を入れすぎる融合を展開しない（SearchOptions.fuseMinimal、ai/fusion.rs。2026-10-29、ユーザーの指摘
//! 「融合の選択肢をすべて展開すると数十パターンあることがザラで、ほとんどが考慮にも値しない」から）

use super::defer_fuse::af_turn;
use super::*;
use crate::ai::fusion::excessive_fusion;

const F: &str = "フューチャー・コア";
const P: &str = "パスト・コア";
const CASTLE: &str = "キャッスルアーティファクト";
const ATTACK: &str = "アタックアーティファクト";

/// 局面 s の融合の手（融合先の名前と、素材の名前を並べ替えたもの）。excessive なら入れすぎの手だけ、でなければ残る手だけ
fn fusions(s: &GameState, excessive: bool) -> Vec<(&'static str, Vec<&'static str>)> {
    let hand = &s.players[0].hand;
    let name = |iid: Iid| name_of(hand.iter().find(|h| h.iid == iid).unwrap().card);
    let mut out: Vec<_> = legal_actions(s)
        .into_iter()
        .filter(|a| excessive_fusion(s, a) == excessive)
        .filter_map(|a| match a {
            Action::Fuse { host, materials } => {
                let mut m: Vec<_> = materials.iter().map(|&x| name(x)).collect();
                m.sort_unstable();
                Some((name(host), m))
            }
            _ => None,
        })
        .collect();
    out.sort();
    out
}

fn fusion(host: &'static str, mats: &[&'static str]) -> (&'static str, Vec<&'static str>) {
    let mut m = mats.to_vec();
    m.sort_unstable();
    (host, m)
}

#[test]
fn cores_and_artifacts_keep_sixteen() {
    // フューチャー 2・パスト 2・キャッスル・アタック: 融合の手 44 通りのうち、入れすぎでないのは 16 通り
    let s = af_turn(10, &[F, F, P, P, CASTLE, ATTACK], &[]);
    let n = legal_actions(&s)
        .iter()
        .filter(|a| matches!(a, Action::Fuse { .. }))
        .count();
    assert_eq!(n, 44);
    let mut want = vec![
        fusion(F, &[F]),
        fusion(F, &[P]),
        fusion(P, &[F]),
        fusion(P, &[P]),
    ];
    for (host, other) in [(CASTLE, ATTACK), (ATTACK, CASTLE)] {
        want.push(fusion(host, &[F])); // α
        want.push(fusion(host, &[P])); // α
        want.push(fusion(host, &[F, F])); // β
        want.push(fusion(host, &[F, P])); // β
        want.push(fusion(host, &[P, P])); // β
        want.push(fusion(host, &[other])); // γ
    }
    want.sort();
    assert_eq!(fusions(&s, false), want);
    // コア 3 枚で作る γ（先にコア 2 枚でアタックかキャッスルを作れば、同じ γ ができてコアが 1 枚残る）は除く
    let excessive = fusions(&s, true);
    assert!(excessive.contains(&fusion(CASTLE, &[F, F, P])));
    assert!(excessive.contains(&fusion(ATTACK, &[F, P, P])));
    // コア 2 枚どうしで作るアタック・キャッスルに 3 枚目を入れるのも除く
    assert!(excessive.contains(&fusion(F, &[F, P])));
}

#[test]
fn destroy_fusions_keep_omega() {
    // α に β・γ → Ω は残す。α に β 2 枚（種類は 1 のまま）、Ω に余分な β を入れるのは除く
    let a = "デストロイアーティファクトα";
    let b = "デストロイアーティファクトβ";
    let g = "デストロイアーティファクトγ";
    let s = af_turn(10, &[a, b, b, g, CASTLE], &[]);
    let kept = fusions(&s, false);
    let excessive = fusions(&s, true);
    assert!(kept.contains(&fusion(a, &[b, g])));
    assert!(kept.contains(&fusion(a, &[b])));
    assert!(kept.contains(&fusion(a, &[g])));
    assert!(excessive.contains(&fusion(a, &[b, b])));
    assert!(excessive.contains(&fusion(a, &[b, b, g])));
    // キャッスルにデストロイ 1 枚（→ γ）は残し、デストロイ 2 枚以上は除く
    assert!(kept.contains(&fusion(CASTLE, &[a])));
    assert!(excessive.contains(&fusion(CASTLE, &[a, b])));
    assert!(excessive.contains(&fusion(CASTLE, &[b, g])));
}

/// 手札の名前 name のカード（最初の 1 枚）に、融合した種類 kinds を付ける
fn set_fused(s: &mut GameState, name: &str, kinds: &[&str]) {
    let h = s.players[0]
        .hand
        .make_mut()
        .iter_mut()
        .find(|h| name_of(h.card) == name)
        .unwrap();
    h.fused_kinds = kinds.iter().map(|k| id(k)).collect();
}

#[test]
fn throwaway_fusions_are_excessive() {
    // カードを捨てるだけの融合（結果が融合前の融合先か素材と同じ）は除く
    let a = "デストロイアーティファクトα";
    let b = "デストロイアーティファクトβ";
    let g = "デストロイアーティファクトγ";
    let mut s = af_turn(10, &[ATTACK, g, a, b], &[]);
    set_fused(&mut s, a, &[b]);
    let kept = fusions(&s, false);
    let excessive = fusions(&s, true);
    assert!(excessive.contains(&fusion(ATTACK, &[g])), "{kept:?}");
    assert!(excessive.contains(&fusion(a, &[b])), "{kept:?}");
    // アタックに α・β → γ、β を融合済みの α に γ → Ω は残す
    assert!(kept.contains(&fusion(ATTACK, &[a])));
    assert!(kept.contains(&fusion(ATTACK, &[b])));
    assert!(kept.contains(&fusion(a, &[g])));
    // γ を融合済みの α に γ も除く
    let mut s = af_turn(10, &[a, g], &[]);
    set_fused(&mut s, a, &[g]);
    assert_eq!(fusions(&s, false), vec![]);
    // 遺産の砲撃が場にあれば、融合するとダメージが出るので残す
    let mut s = af_turn(10, &[ATTACK, g], &[]);
    let shelling = board_card(&mut s, "遺産の砲撃");
    s.players[0].board.make_mut().push(shelling);
    let enemy = old_follower(&mut s, "ゴブリン");
    s.players[1].board.make_mut().push(enemy);
    assert!(fusions(&s, false).contains(&fusion(ATTACK, &[g])));
}
