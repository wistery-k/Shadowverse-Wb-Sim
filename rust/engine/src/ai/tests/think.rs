//! 「AI の考え」（think.rs）: choose_action と同じ手を選び、点数の内訳が探索の点数と合う

use super::*;
use crate::ai::registry::create_agent;
use crate::ai::search::{SearchAgent, SearchOptions};

/// AI どうしの試合の途中の局面で、think と choose_action（どちらも作り直した AI・同じ乱数）を比べる
fn compare_on_game(
    agent: &str,
    d0: &str,
    d1: &str,
    seed: u32,
    every: usize,
    limit: usize,
) -> usize {
    let mut s = new_game(deck(d0), deck(d1), seed);
    let mut players = [create_agent(agent).unwrap(), create_agent(agent).unwrap()];
    let mut rng = Rng::new(seed);
    let mut checked = 0;
    let mut k = 0;
    while s.phase != Phase::Ended && checked < limit {
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        if legal.len() > 1 && !matches!(legal[0], Action::Mulligan { .. }) {
            k += 1;
            if k % every == 0 {
                let r = 0x1234_5678 ^ k as u32;
                fresh();
                let thought = create_agent(agent)
                    .unwrap()
                    .think(&s, &legal, &mut Rng::new(r))
                    .expect("考えがある");
                fresh();
                let chosen =
                    create_agent(agent)
                        .unwrap()
                        .choose_action(&s, &legal, &mut Rng::new(r));
                assert_eq!(thought.chosen, chosen, "{agent} 試合 {seed} の {k} 手目");
                assert_eq!(thought.player, actor);
                assert!(!thought.roots.is_empty());
                // 並びは決定化した局面から打てる
                for c in &thought.candidates {
                    let mut t = thought.roots[c.sample].clone();
                    assert_eq!(c.steps.first(), Some(&c.action));
                    for a in &c.steps {
                        t = crate::game::try_apply_action(&t, a).expect("並びが打てる");
                    }
                }
                // 読み直した手が先、選ぶときの値の高い順
                let values: Vec<f64> = thought.candidates.iter().map_while(|c| c.value).collect();
                assert!(values.windows(2).all(|w| w[0] >= w[1]));
                assert!(thought.candidates[values.len()..]
                    .iter()
                    .all(|c| c.read.is_none()));
                checked += 1;
            }
        }
        let a = players[actor].choose_action(&s, &legal, &mut rng);
        s = apply(&s, &a);
    }
    checked
}

#[test]
fn think_chooses_like_choose_action() {
    assert!(compare_on_game("search", "スペルウィッチ", "AFネメシス", 11, 4, 8) >= 4);
    // 決定化 3 回の平均で選ぶ AI
    assert!(compare_on_game("yardstick", "アマリアロイヤル", "疾走ドラゴン", 12, 5, 6) >= 3);
    // リノセウス用 AI（エルフでリノセウス用のリーサル探索と評価を使う）
    assert!(
        compare_on_game(
            "rhino",
            "リノセウスエルフ",
            "ミッドレンジナイトメア",
            13,
            4,
            8
        ) >= 4
    );
}

#[test]
fn score_parts_add_up() {
    // 内訳の手で作った評価と学習した補正は、探索の点数と（残り PP の罰などを除いて）合う
    let mut s = new_game(deck("AFネメシス"), deck("アミュレット疾走ビショップ"), 21);
    let mut players = [
        SearchAgent::new(SearchOptions::default()),
        SearchAgent::new(SearchOptions::default()),
    ];
    let mut rng = Rng::new(21);
    let mut checked = 0;
    while s.phase != Phase::Ended && checked < 6 {
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        if s.turn >= 5 && legal.len() > 1 && s.pending.is_none() && s.active == actor {
            fresh();
            let t = SearchAgent::new(SearchOptions::default())
                .think(&s, &legal, &mut Rng::new(checked))
                .expect("考えがある");
            for c in &t.candidates {
                let te = c.turn_end;
                assert!(te.extra != 0.0, "学習した補正が入っている");
                assert!((te.total - te.eval - te.extra).abs() < 3.0, "{te:?}");
                if let Some(r) = c.read {
                    assert!((r.total - r.eval - r.extra).abs() < 1e-6, "{r:?}");
                    assert_eq!(c.read_count, 1);
                    // 選ぶときの値は、読み直した点数にターン末の点数を混ぜたもの（rescoreMix）
                    let m = SearchOptions::default().rescore_mix;
                    let want = (1.0 - m) * r.total + m * te.total;
                    assert!((c.value.expect("値がある") - want).abs() < 1e-6, "{c:?}");
                }
            }
            assert!(t.candidates.iter().filter(|c| c.read.is_some()).count() <= 4);
            checked += 1;
        }
        let a = players[actor].choose_action(&s, &legal, &mut rng);
        s = apply(&s, &a);
    }
    assert!(checked >= 3);
}
