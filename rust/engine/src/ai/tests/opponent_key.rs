//! 読みの中の相手のビームの並べ直しのキー（opponentSearch.handKey・potential）

use super::pool::pool_deck;
use super::*;
use crate::ai::search::SearchAgent;
use crate::runner::options::compare_options;

/// 新しいプールの R6 の補正・R4 の見込みで、読みの中の相手の設定 os（opponentSearch の JSON）の探索 AI
fn agent(os: &str) -> SearchAgent {
    let dir = format!("{}/yardstick", env!("CARGO_MANIFEST_DIR"));
    let text = format!(
        r#"{{"valueNet":"{dir}/pool-r6-net.json","potentialNet":"{dir}/pool-r4-potential.json","opponentSearch":{os}}}"#
    );
    SearchAgent::new(compare_options(&text).expect("設定"))
}

/// 貪欲法どうしの試合の、6 ターン目以降のターン終了を打つ直前の局面（打つ側の席と）
fn ends() -> Vec<(GameState, PlayerIndex)> {
    let x = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/VL_ナイトメア.txt"
    ));
    let y = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/CR_ウィッチ.txt"
    ));
    let mut out = Vec::new();
    let mut s = new_game(&x, &y, 5);
    let mut greedy = greedy_base();
    let mut rng = Rng::new(5);
    while s.phase != Phase::Ended {
        let legal = legal_actions(&s);
        let a = greedy.choose_action(&s, &legal, &mut rng);
        if matches!(a, Action::EndTurn) && s.pending.is_none() && s.turn >= 6 {
            out.push((s.clone(), s.active));
        }
        s = apply(&s, &a);
    }
    assert!(out.len() >= 3, "{}", out.len());
    out
}

#[test]
fn opponent_hand_key_and_potential_change_only_when_asked() {
    // handKey は、補正を使う読みの中の相手（extraEval）の並べ直しを手で作った評価にし、最後に選ぶ点だけ補正にする。
    // potential は並べ直しのキーに見込みを足す。どちらも読みを変え、handKey は補正を使わない相手では何もしない
    let ends = ends();
    let seeds: Vec<u32> = (0..4).collect();
    let reads = |os: &str| -> Vec<f64> {
        let a = agent(os);
        ends.iter()
            .flat_map(|(s, p)| a.read_values(s, *p, &seeds))
            .collect()
    };
    let net = r#""beamWidth":8,"maxDepth":8,"extraEval":true,"ownWeights":true"#;
    let plain = reads(&format!("{{{net}}}"));
    assert_ne!(plain, reads(&format!(r#"{{{net},"handKey":true}}"#)));
    assert_ne!(plain, reads(&format!(r#"{{{net},"potential":true}}"#)));
    let hand = r#""beamWidth":8,"maxDepth":8"#;
    assert_eq!(
        reads(&format!("{{{hand}}}")),
        reads(&format!(r#"{{{hand},"handKey":true}}"#))
    );
}
