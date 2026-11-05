//! 自分のターンの木の探索（SearchOptions.tree。ai/search/tree.rs）

use super::*;
use crate::ai::potential::{default_vocab, P_SCALARS, P_ZONES};
use crate::ai::search::{BeamProbe, SearchAgent, SearchOptions, TreeMode, TreeSearch};
use crate::json::Json;
use std::sync::Arc;

/// 貪欲法どうしの試合 g の、ターンの最初の局面（手番の側）。小さな木の局面を選ぶのに使う
fn turn_starts(g: u32) -> Vec<(GameState, PlayerIndex)> {
    let mut a0 = greedy_base();
    let mut a1 = greedy_base();
    let mut agents: [&mut dyn Agent; 2] = [&mut a0, &mut a1];
    let mut out = Vec::new();
    let mut last = -1;
    crate::sim::play_ai(g, false, &mut agents, |s, _| {
        if s.phase == Phase::Main
            && s.pending.is_none()
            && s.stack.is_empty()
            && s.queue.is_empty()
            && acting_player(s) == s.active
            && s.turn != last
        {
            last = s.turn;
            out.push((s.clone(), s.active));
        }
    });
    out
}

fn probe(opts: SearchOptions, s: &GameState, p: PlayerIndex, marks: &[usize]) -> BeamProbe {
    SearchAgent::new(opts)
        .beam_probe(s, p, 0, marks, &mut Rng::new(1))
        .expect("並びがある")
}

fn tree(t: TreeSearch) -> SearchOptions {
    SearchOptions {
        tree: Some(t),
        ..SearchOptions::default()
    }
}

/// どの局面も広げる（楽観の値の下限をとても大きくする）木の探索
fn everything(mode: TreeMode) -> TreeSearch {
    TreeSearch {
        mode,
        budget: 10_000_000,
        upper_min: 1e9,
        stop: false,
        ..TreeSearch::default()
    }
}

/// 木の小さい（幅 4096 のビームの採点が 3000 局面以下の）局面
fn small_positions() -> Vec<(GameState, PlayerIndex, BeamProbe)> {
    let wide = SearchOptions {
        beam_width: 4096,
        potential: None,
        ..SearchOptions::default()
    };
    let mut out = Vec::new();
    for g in [3, 11] {
        for (s, p) in turn_starts(g) {
            if s.players[p].turn_count < 3 {
                continue;
            }
            let r = probe(wide.clone(), &s, p, &[]);
            if r.scored > 50 && r.scored <= 3000 && r.best.abs() < 1e5 {
                out.push((s, p, r));
            }
            if out.len() >= 4 {
                return out;
            }
        }
    }
    out
}

/// すべての局面を広げれば、どの形も広いビームの最善に届く
/// （最初の手ごとの最善は、同じ局面を点数の高い別の最初の手にまとめると、その先を広げないので下回ることがある）
#[test]
fn exhaustive_tree_reaches_wide_beam() {
    let positions = small_positions();
    assert!(positions.len() >= 3, "小さな木の局面 {}", positions.len());
    for (s, p, wide) in &positions {
        for mode in [TreeMode::A0, TreeMode::BStar, TreeMode::Mcts] {
            let r = probe(tree(everything(mode)), s, *p, &[]);
            assert!(
                r.best >= wide.best - 1e-6,
                "{mode:?}: {} < 幅 4096 の {}",
                r.best,
                wide.best
            );
        }
    }
}

/// 予算ごとの途中の最善は予算とともに下がらず、予算が届かない時点は最後の最善と同じ。同じ設定なら同じ結果
#[test]
fn marks_are_monotone_and_deterministic() {
    let positions = small_positions();
    let (s, p, _) = &positions[0];
    for mode in [TreeMode::A0, TreeMode::BStar, TreeMode::Mcts] {
        let opts = tree(everything(mode));
        let marks = [5, 20, 80, 10_000_000];
        let r = probe(opts.clone(), s, *p, &marks);
        assert_eq!(r.marks.len(), marks.len());
        let best = |fs: &[(Action, f64)]| fs.iter().map(|x| x.1).fold(f64::NEG_INFINITY, f64::max);
        for w in r.marks.windows(2) {
            assert!(best(&w[1].firsts) >= best(&w[0].firsts) - 1e-9);
            assert!(w[1].scored >= w[0].scored);
        }
        let last = r.marks.last().unwrap();
        assert_eq!(last.scored as u64, r.scored, "{mode:?}");
        assert!((best(&last.firsts) - r.best).abs() < 1e-9, "{mode:?}");
        let again = probe(opts, s, *p, &marks);
        assert_eq!(again.best_actions, r.best_actions, "{mode:?}");
        assert_eq!(again.scored, r.scored, "{mode:?}");
    }
}

/// 予算で止まる（深さ 1 の局面の後は、局面 1 つの子の分だけ越える）
#[test]
fn budget_limits_scored_states() {
    let positions = small_positions();
    let (s, p, wide) = positions
        .iter()
        .max_by_key(|x| x.2.scored)
        .expect("局面がある");
    let budget = (wide.scored / 4) as usize;
    for mode in [TreeMode::A0, TreeMode::BStar, TreeMode::Mcts] {
        let r = probe(
            tree(TreeSearch {
                budget,
                ..everything(mode)
            }),
            s,
            *p,
            &[],
        );
        assert!(
            (r.scored as usize) < budget + 200,
            "{mode:?}: {} 局面（予算 {budget}）",
            r.scored
        );
    }
}

/// 下限と上限のネットワーク（重み 0。予想はどれも 0、伸びしろの上側はとても大きい）のファイル
fn flat_bounds_net(dir: &std::path::Path) -> String {
    let vocab = default_vocab();
    let n = P_ZONES.len() * vocab.len() + P_SCALARS.len();
    let m = Json::Obj(vec![
        ("kind".into(), Json::Str("bounds-net".into())),
        ("version".into(), Json::Num(1.0)),
        (
            "vocab".into(),
            Json::Arr(vocab.into_iter().map(Json::Str).collect()),
        ),
        (
            "zones".into(),
            Json::Arr(P_ZONES.iter().map(|z| Json::Str((*z).into())).collect()),
        ),
        (
            "scalars".into(),
            Json::Arr(P_SCALARS.iter().map(|z| Json::Str((*z).into())).collect()),
        ),
        ("hidden".into(), Json::Num(1.0)),
        ("w1".into(), Json::Arr(vec![Json::Num(0.0); n])),
        ("b1".into(), Json::Arr(vec![Json::Num(0.0)])),
        ("wv".into(), Json::Arr(vec![Json::Num(0.0)])),
        ("bv".into(), Json::Num(0.0)),
        ("wu".into(), Json::Arr(vec![Json::Num(0.0)])),
        ("bu".into(), Json::Num(100.0)),
        ("scale".into(), Json::Num(50.0)),
        ("tau".into(), Json::Num(0.9)),
    ]);
    let path = dir.join("bounds.json");
    std::fs::write(&path, m.stringify()).unwrap();
    path.to_string_lossy().into_owned()
}

/// 案 A'（lazy）: 予想だけで山に入れても、すべて広げれば同じ最善に届く。正確に採点した数と予想だけの数を分けて数える
#[test]
fn lazy_tree_reaches_same_best() {
    let dir = std::env::temp_dir().join(format!("svwb-tree-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let net = Arc::new(crate::ai::bounds::BoundsNet::load(&flat_bounds_net(&dir)).unwrap());
    assert_eq!(
        net.eval(&new_game(deck_at(0), deck_at(1), 1), 0),
        (0.0, 5000.0)
    );
    for (s, p, wide) in small_positions() {
        let r = probe(
            tree(TreeSearch {
                lazy: Some(net.clone()),
                ..everything(TreeMode::A0)
            }),
            &s,
            p,
            &[1_000_000_000],
        );
        assert!(r.best >= wide.best - 1e-6, "{} < {}", r.best, wide.best);
        assert!(r.predicted > 0);
        let m = &r.marks[0];
        assert_eq!(m.scored as u64, r.scored);
        assert_eq!(m.predicted as u64, r.predicted);
    }
    std::fs::remove_dir_all(&dir).ok();
}
