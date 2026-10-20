//! ビームの幅（SearchOptions.beamWidth。棋譜の指摘から 32 → 128）

use super::*;
use crate::ai::search::{SearchAgent, SearchOptions};

/// seed 3108602991（アマリアロイヤル vs スペルウィッチ、どちらもリノセウス用 AI。ロイヤル先攻）。
/// ユーザーが指摘した試合の、ウィッチの 9 ターン目（全体 18 ターン目）の開始まで
fn state_3108602991_turn18() -> GameState {
    let log = actions(
        r#"[{"player":0,"swap":[22,36],"type":"mulligan"},{"player":1,"swap":[60,71,77],"type":"mulligan"},{"type":"endTurn"},{"type":"endTurn"},{"iid":11,"type":"play"},{"type":"endTurn"},{"iid":43,"type":"play"},{"iid":49,"type":"play"},{"targets":[81],"type":"choose"},{"type":"endTurn"},{"iid":3,"type":"play"},{"attacker":11,"target":"leader","type":"attack"},{"type":"endTurn"},{"iid":58,"type":"play"},{"type":"endTurn"},{"attacker":11,"target":"leader","type":"attack"},{"attacker":3,"target":"leader","type":"attack"},{"iid":1,"type":"play"},{"iid":8,"type":"play"},{"type":"endTurn"},{"iid":51,"type":"play"},{"iid":51,"type":"evolve"},{"targets":[8],"type":"choose"},{"iid":54,"type":"play"},{"attacker":51,"target":3,"type":"attack"},{"type":"endTurn"},{"iid":17,"type":"play"},{"targets":[51],"type":"choose"},{"iid":1,"type":"evolve"},{"attacker":1,"target":"leader","type":"attack"},{"attacker":11,"target":"leader","type":"attack"},{"attacker":82,"target":"leader","type":"attack"},{"type":"endTurn"},{"iid":52,"type":"play"},{"iid":52,"type":"evolve"},{"targets":[17],"type":"choose"},{"iid":59,"type":"play"},{"index":2,"type":"mode"},{"attacker":54,"target":"leader","type":"attack"},{"type":"extraPp"},{"iid":46,"type":"play"},{"attacker":52,"target":83,"type":"attack"},{"type":"endTurn"},{"iid":16,"type":"play"},{"targets":[52],"type":"choose"},{"iid":16,"type":"evolve"},{"attacker":16,"target":54,"type":"attack"},{"type":"endTurn"},{"iid":55,"type":"play"},{"iid":55,"type":"superEvolve"},{"iid":56,"type":"play"},{"iid":84,"type":"act"},{"attacker":55,"target":16,"type":"attack"},{"type":"endTurn"},{"iid":15,"type":"play"},{"iid":15,"type":"superEvolve"},{"type":"endTurn"},{"iid":61,"type":"play"},{"index":2,"type":"mode"},{"iid":84,"type":"act"},{"iid":60,"type":"play"},{"index":2,"type":"mode"},{"type":"endTurn"},{"iid":39,"type":"play"},{"type":"endTurn"},{"iid":69,"type":"play"},{"iid":47,"type":"play"},{"type":"endTurn"},{"iid":29,"type":"play"},{"iid":26,"type":"play"},{"attacker":26,"target":"leader","type":"attack"},{"iid":29,"type":"superEvolve"},{"attacker":29,"target":69,"type":"attack"},{"type":"endTurn"}]"#,
    );
    apply_all(
        &new_game(deck("アマリアロイヤル"), deck("スペルウィッチ"), 3108602991),
        &log,
    )
}

/// 相手の場に 白銀の騎士団長・エミリア 7/7（超進化）・レヴィオンの迅雷・アルベール 3/5。PP 9 とエクストラPP、手札に クオン・ミラ・宿題やるですぅ！。
/// 幅 32 では途中の局面が切られて、エミリアを残す手順（クオン → 形代でアルベール → 天后を超進化してエミリア）を打っていた。
/// 指摘の、ミラ超進化・クオン・成長したですぅ！で両方を倒す手順は、ターン末 1.8 点（実戦 −15.2）、相手のターンを読んだ後 −5.3（実戦 −16.6）。
/// どの手順を選ぶかは決定化の乱数と学習した補正で変わる（6 万試合で学び直した補正では、乱数 12 通りのうち
/// 幅 128 で 6 回・幅 32 で 2 回両方を倒し、残すのはどれもアルベール。1 つ前の補正では幅 128 で 9 回）。
/// そこで 12 通りで、幅 128 が幅 32 より多く両方を倒すことと、エミリアは必ず倒すことを確かめる
#[test]
fn witch_turn18_clears_both() {
    let start = state_3108602991_turn18();
    assert_eq!(start.active, 1);
    let names = |s: &GameState| -> Vec<&str> {
        s.players[0].board.iter().map(|c| name_of(c.card)).collect()
    };
    assert_eq!(
        names(&start),
        ["白銀の騎士団長・エミリア", "レヴィオンの迅雷・アルベール"]
    );
    let clears = |beam_width: usize| -> usize {
        (1..=12)
            .filter(|&seed| {
                let mut agent = SearchAgent::new(SearchOptions {
                    beam_width,
                    ..SearchOptions::default()
                });
                let (_, end) = play_turn(start.clone(), 1, &mut agent, &mut Rng::new(seed));
                let left = names(&end);
                if beam_width == SearchOptions::default().beam_width {
                    assert!(
                        !left.contains(&"白銀の騎士団長・エミリア"),
                        "シード {seed}: {left:?}"
                    );
                }
                left.is_empty()
            })
            .count()
    };
    let (wide, narrow) = (clears(SearchOptions::default().beam_width), clears(32));
    assert!(
        wide >= 6 && wide > narrow,
        "幅 128: {wide}/12、幅 32: {narrow}/12"
    );
}
