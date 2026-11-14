//! 局面の不変条件（TypeScript 版 src/engine/invariants.ts と同じ決まり）。探索 AI の自己対戦で、手を打つたびに確かめる
//! （`svwb profile --check`。TypeScript 版はランダムどうしのテストで呼ぶ。両方を直すときは同じに保つ）。

use crate::state::{
    card, GameState, HandEv, Phase, BOARD_LIMIT, HAND_LIMIT, MAX_LEADER_AREA, MAX_PP,
};

/// 不変条件の違反を並べる（空なら正常）
pub fn invariant_violations(s: &GameState) -> Vec<String> {
    let mut v = Vec::new();
    let mut iids: Vec<i32> = Vec::new();
    let ended = s.phase == Phase::Ended;
    for (p, pl) in s.players.iter().enumerate() {
        let w = format!("プレイヤー{p}");
        if pl.hand.len() > HAND_LIMIT {
            v.push(format!("{w}: 手札が{}枚", pl.hand.len()));
        }
        if pl.board.len() > BOARD_LIMIT {
            v.push(format!("{w}: 場が{}枚", pl.board.len()));
        }
        if pl.crests.len() > MAX_LEADER_AREA {
            v.push(format!("{w}: クレストが{}つ", pl.crests.len()));
        }
        let mut crests: Vec<_> = pl.crests.iter().map(|c| c.crest).collect();
        crests.sort_unstable();
        if crests.windows(2).any(|x| x[0] == x[1]) {
            v.push(format!("{w}: 同じクレストが2つ"));
        }
        if pl.max_pp < 0 || pl.max_pp > MAX_PP {
            v.push(format!("{w}: 最大PPが{}", pl.max_pp));
        }
        // エクストラPPで PP最大値を1超えることがある
        if pl.pp < 0 || pl.pp > pl.max_pp + 1 {
            v.push(format!("{w}: PPが{}/{}", pl.pp, pl.max_pp));
        }
        if pl.ep < 0 || pl.sep < 0 {
            v.push(format!("{w}: EP/SEPが負"));
        }
        if pl.leader_hp > pl.leader_max_hp {
            v.push(format!("{w}: リーダー体力が最大値を超過"));
        }
        if !ended && pl.leader_hp <= 0 {
            v.push(format!("{w}: 体力0以下で対戦が継続"));
        }
        if pl.graveyard < 0 {
            v.push(format!("{w}: 墓場のカウントが負"));
        }
        let sigils = pl
            .board
            .iter()
            .filter(|c| !c.is_follower && c.sigils.is_some())
            .count();
        if sigils > 1 {
            v.push(format!("{w}: 【土の印】アミュレットが複数"));
        }
        for h in &pl.deck_kept {
            match pl.deck.iter().find(|c| c.iid == h.iid) {
                Some(c) if c.card == h.card => {}
                _ => v.push(format!(
                    "{w}: 山札のカード {} の手札での状態が別のカードのもの",
                    h.iid
                )),
            }
        }
        // 手札の記録の伏せた枠の数（入った − 出た）は、伏せた手札の枚数と同じ（記録の無い局面は見ない）
        if !pl.hand_log.is_empty() {
            let mut slots = 0i64;
            for e in pl.hand_log.to_vec() {
                match e {
                    HandEv::In { .. } | HandEv::InWith { .. } => slots += 1,
                    HandEv::Out { .. } | HandEv::OutUnknown | HandEv::ToDeck => slots -= 1,
                    _ => {}
                }
            }
            let hidden = pl.hand.iter().filter(|h| !h.revealed).count() as i64;
            if slots != hidden {
                v.push(format!(
                    "{w}: 手札の記録の伏せた枠が{slots}、伏せた手札が{hidden}枚"
                ));
            }
        }
        let all = pl
            .deck
            .iter()
            .map(|c| c.iid)
            .chain(pl.hand.iter().map(|h| h.iid))
            .chain(pl.board.iter().map(|b| b.iid));
        for iid in all {
            if iids.contains(&iid) {
                v.push(format!("{w}: iid {iid} が重複"));
            }
            iids.push(iid);
        }
        for c in pl.board.iter().filter(|c| c.is_follower) {
            if !ended && c.defense <= 0 {
                v.push(format!(
                    "{w}: 体力0以下のフォロワー {}（{}）が場に残存",
                    c.iid,
                    card(c.card).name
                ));
            }
            if c.defense > c.max_defense {
                v.push(format!(
                    "{w}: フォロワー {}（{}）の体力が最大値を超過",
                    c.iid,
                    card(c.card).name
                ));
            }
            if c.attacks_this_turn > c.max_attacks {
                v.push(format!(
                    "{w}: フォロワー {}（{}）の攻撃回数が超過",
                    c.iid,
                    card(c.card).name
                ));
            }
        }
    }
    if ended && s.winner.is_none() {
        v.push("終了しているが勝者がいない".into());
    }
    if !ended && s.pending.is_none() && (!s.stack.is_empty() || !s.queue.is_empty()) {
        v.push("選択待ちでないのに未解決の処理が残っている".into());
    }
    if !ended && s.winner.is_some() {
        v.push("勝者がいるが終了していない".into());
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::data;
    use crate::game::create_game;

    #[test]
    fn new_game_has_no_violations() {
        let d = &data().decks[0];
        let s = create_game([&d.cards, &d.cards], 1);
        assert_eq!(invariant_violations(&s), Vec::<String>::new());
    }

    #[test]
    fn finds_broken_states() {
        let d = &data().decks[0];
        let mut s = create_game([&d.cards, &d.cards], 1);
        s.players[0].pp = s.players[0].max_pp + 2;
        s.players[1].ep = -1;
        let v = invariant_violations(&s);
        assert!(v.iter().any(|x| x.contains("PPが")), "{v:?}");
        assert!(v.iter().any(|x| x.contains("EP/SEPが負")), "{v:?}");
    }
}
