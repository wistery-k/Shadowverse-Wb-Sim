//! 評価関数の重み（tests/ai.test.ts の「評価関数の重み」「lastWords の評価」「lastWordsSummon の評価」「extraPpExpiring」）

use super::*;
use crate::ai::aidata::{class_weights_json, weights_from, Weights, AI_DATA_JSON};
use crate::ai::eval::evaluate_with;
use crate::ai::rhino::deck_class_of;
use crate::ai::search::expiring_extra_pp;

/// base の一部を変えた重み
fn with(base: &EvalWeights, f: impl FnOnce(&mut Weights)) -> EvalWeights {
    let mut w = base.w.clone();
    f(&mut w);
    EvalWeights::new(w)
}

/// 手番（メインフェイズ）をプレイヤー 0 にした、作ったばかりの局面
fn main_phase(seed: u32) -> GameState {
    let mut s = new_game(deck_at(0), deck_at(1), seed);
    s.phase = Phase::Main;
    s.active = 0;
    s
}

#[test]
fn class_weights_override_default_weights() {
    // クラスの重みは基準の重みに差分を重ねる（hold はカードごとに重ねる）
    let raw: serde_json::Value = serde_json::from_str(AI_DATA_JSON).expect("ai-data.json");
    let base = raw["defaultWeights"]
        .as_object()
        .expect("defaultWeights")
        .clone();
    let mut hold = serde_json::Map::new();
    hold.insert(card(id("フェアリー")).id.clone(), 1.into());
    let mut o = serde_json::Map::new();
    o.insert("myHp".into(), 2.into());
    o.insert("hold".into(), hold.into());
    let m = class_weights_json(&base, &o);
    assert_eq!(m["myHp"], 2);
    assert_eq!(m["oppHp"], base["oppHp"]);
    let w = weights_from(m).expect("重み");
    assert_eq!(w.my_hp, 2.0);
    assert_eq!(w.opp_hp, ai_data().default_weights.opp_hp);
    assert_eq!(w.hold[id("フェアリー") as usize], 1.0);
}

#[test]
fn deck_class_and_hold_value() {
    // デッキのクラスを判定し、手札に持っておく価値を評価に加える
    let s = new_game(deck_at(0), deck_at(1), 4);
    assert_eq!(deck_class_of(&s, 0), ClassId::Nemesis);
    assert_eq!(deck_class_of(&s, 1), ClassId::Royal);
    let c = s.players[0].hand[0].card;
    let dw = default_weights();
    let base = evaluate_with(&s, 0, &dw);
    let w = with(&dw, |w| {
        w.hold = vec![0.0; w.hold.len()];
        w.hold[c as usize] = 3.0;
    });
    assert!(evaluate_with(&s, 0, &w) >= base + 3.0);
}

#[test]
fn dragon_oracle_raises_search_evaluation() {
    // 探索 AI の重みでは、竜の啓示で PP 最大値を増やすと評価が上がる
    let mut s = new_game(class_deck(ClassId::Dragon), deck_at(1), 4);
    s.phase = Phase::Main;
    s.active = 0;
    s.players[0].max_pp = 3;
    s.players[0].pp = 3;
    let c = hand_card(&mut s, "竜の啓示");
    let iid = c.iid;
    s.players[0].hand = vec![c].into();
    let t = apply(&s, &Action::Play(iid));
    assert_eq!(t.players[0].max_pp, 4);
    let (sw, dw) = (search_weights(), default_weights());
    assert!(evaluate_with(&t, 0, &sw) > evaluate_with(&s, 0, &sw));
    assert!(evaluate_with(&t, 0, &dw) < evaluate_with(&s, 0, &dw));
}

#[test]
fn fusion_does_not_lower_search_evaluation() {
    // 探索 AI の重みでは、融合で手札の枚数が減っても評価が下がらない
    let mut s = main_phase(4);
    let attack = hand_card(&mut s, "アタックアーティファクト");
    let castle = hand_card(&mut s, "キャッスルアーティファクト");
    let (host, material) = (attack.iid, castle.iid);
    s.players[0].hand = vec![attack, castle].into();
    let (sw, dw) = (search_weights(), default_weights());
    let before = evaluate_with(&s, 0, &sw);
    // アタック（素材のコスト 3）→ デストロイアーティファクトγ
    let t = apply(
        &s,
        &Action::Fuse {
            host,
            materials: vec![material],
        },
    );
    let hand: Vec<CardIdx> = t.players[0].hand.iter().map(|h| h.card).collect();
    assert_eq!(hand, vec![id("デストロイアーティファクトγ")]);
    assert!(evaluate_with(&t, 0, &sw) >= before);
    assert!(evaluate_with(&t, 0, &dw) < evaluate_with(&s, 0, &dw));
}

#[test]
fn countdown_decay_values_amulet_payoff() {
    // countdownDecay ではカウントダウンのアミュレットを割れたときに得るもので数え、アクトでカウントを進めると評価が上がる
    let mut s = main_phase(4);
    s.players[0].board.make_mut().clear();
    s.players[0].hand.make_mut().clear();
    s.players[1].board.make_mut().clear();
    s.players[0].pp = 5;
    let w = with(&default_weights(), |w| w.countdown_decay = 0.8);
    let empty = evaluate_with(&s, 0, &w);
    let vow = board_card(&mut s, "獣姫の誓約");
    let vow_iid = vow.iid;
    s.players[0].board = vec![vow].into();
    // ホーリーフレイムタイガー 4/4: 4 + 3.2 + 1 = 8.2、カウント 2
    assert_close(evaluate_with(&s, 0, &w) - empty, 8.2 * 0.64);
    let t = apply(&s, &Action::Act(vow_iid));
    assert!(evaluate_with(&t, 0, &w) > evaluate_with(&s, 0, &w));
    // 穏やかなる教会（2 ドロー）は割ると評価が下がらない
    let mut church = board_card(&mut s, "穏やかなる教会");
    church.countdown = Some(1);
    let church_iid = church.iid;
    s.players[0].board = vec![church].into();
    let before = evaluate_with(&s, 0, &w);
    let u = apply(&s, &Action::Act(church_iid));
    assert!(u.players[0].board.is_empty());
    assert!(evaluate_with(&u, 0, &w) > before);
}

#[test]
fn jeanne_sync_counts_buffed_followers() {
    // jeanneSync では手札にジャンヌがあり、ジャンヌを出せるターンに割れるアミュレットのフォロワーを +2/+4 して数える
    let mut s = new_game(deck_at(0), deck_at(1), 4);
    let p = s.first;
    s.players[opponent(p)].board.make_mut().clear();
    s.players[p].hand.make_mut().clear();
    s.players[p].turn_count = 6;
    let vow = board_card(&mut s, "獣姫の誓約");
    s.players[p].board = vec![vow].into();
    let w = with(&default_weights(), |w| {
        w.countdown_decay = 0.8;
        w.jeanne_sync = 1.0;
    });
    let w0 = with(&w, |w| w.jeanne_sync = 0.0);
    let without = evaluate_with(&s, p, &w);
    let jeanne = hand_card(&mut s, "純白の聖女・ジャンヌ");
    s.players[p].hand = vec![jeanne].into();
    let hand_only = evaluate_with(&s, p, &w0) - without;
    // 6 ターン目＋カウント 2 ＝ 8: タイガー 6/8 = 6 + 6.4 + 1 = 13.4（4/4 なら 8.2）
    assert_close(
        evaluate_with(&s, p, &w) - without - hand_only,
        (13.4 - 8.2) * 0.64,
    );
    // 5 ターン目（先攻なのでエクストラPP なし）なら加点しない
    s.players[p].turn_count = 5;
    assert_close(evaluate_with(&s, p, &w), evaluate_with(&s, p, &w0));
}

#[test]
fn evo_reserve_counts_evolve_abilities_up_to_ep() {
    // evoReserve は EP の数まで手札の進化時能力持ちを数え、このターンに EP で進化させた進化時能力持ちも数える
    let mut s = new_game(deck_at(0), deck_at(1), 4);
    s.players[0].ep = 2;
    let hand = hand_cards(
        &mut s,
        &[
            "楽朗の天宮・フィルドア",
            "楽朗の天宮・フィルドア",
            "栄弦の天宮・リュウフウ",
        ],
    );
    s.players[0].hand = hand.into();
    let dw = default_weights();
    let w = with(&dw, |w| w.evo_reserve = 3.0);
    let diff = |s: &GameState| evaluate_with(s, 0, &w) - evaluate_with(s, 0, &dw);
    // 3 枚あっても EP 2 回分まで
    assert_close(diff(&s), 6.0);
    // 進化時能力を持たないフォロワーは数えない
    s.players[0].hand = hand_cards(&mut s, &["スティールナイト"]).into();
    assert_close(diff(&s), 0.0);
    // このターンに EP で進化させたのが進化時能力持ちなら 1 枚分数える（EP が残っていなくても）
    s.players[0].hand.make_mut().clear();
    s.players[0].ep = 0;
    s.players[0].ep_evolved_this_turn = Some(id("楽朗の天宮・フィルドア"));
    assert_close(diff(&s), 3.0);
    s.players[0].ep_evolved_this_turn = Some(id("スティールナイト"));
    assert_close(diff(&s), 0.0);
}

#[test]
fn sevo_reserve_counts_super_evolve_abilities_up_to_sep() {
    // sevoReserve は SEP の数まで手札の進化時・超進化時能力持ちを数え、このターンに超進化させた能力持ちも数える
    let mut s = new_game(deck_at(0), deck_at(1), 4);
    s.players[0].sep = 1;
    s.players[0].hand = hand_cards(
        &mut s,
        &["勇壮の堕天使・オリヴィエ", "水の守護神・サレファ"],
    )
    .into();
    let dw = default_weights();
    let w = with(&dw, |w| w.sevo_reserve = 4.0);
    let diff = |s: &GameState| evaluate_with(s, 0, &w) - evaluate_with(s, 0, &dw);
    // 2 枚あっても SEP 1 回分まで
    assert_close(diff(&s), 4.0);
    // 能力のないフォロワーは数えない
    s.players[0].hand = hand_cards(&mut s, &["壮麗なる隼"]).into();
    assert_close(diff(&s), 0.0);
    // このターンに超進化させたのが能力持ちなら 1 枚分数える（SEP が残っていなくても）
    s.players[0].hand.make_mut().clear();
    s.players[0].sep = 0;
    s.players[0].sep_evolved_this_turn = Some(id("勇壮の堕天使・オリヴィエ"));
    assert_close(diff(&s), 4.0);
    s.players[0].sep_evolved_this_turn = Some(id("壮麗なる隼"));
    assert_close(diff(&s), 0.0);
}

#[test]
fn hand_storm_counts_griffon_attack() {
    // handStorm は相手の体力が lethalRange 以下で、アクトできるアミュレットが場にあれば、次のターンに出せるグリフォンの攻撃力を数える
    let mut s = new_game(deck_at(0), deck_at(1), 4);
    s.players[1].leader_hp = 8;
    s.players[0].max_pp = 7;
    s.players[0].hand = hand_cards(&mut s, &["セイクリッドグリフォン"]).into();
    let sanctuary = board_card(&mut s, "禁密の聖地");
    s.players[0].board = vec![sanctuary].into();
    let dw = default_weights();
    let w = with(&dw, |w| w.hand_storm = 0.5);
    let diff = |s: &GameState| evaluate_with(s, 0, &w) - evaluate_with(s, 0, &dw);
    assert_close(diff(&s), 3.0);
    // 次のターンに 8 PP に届かなければ数えない
    s.players[0].max_pp = 6;
    assert_close(diff(&s), 0.0);
    // アクトできるアミュレットが無ければ数えない
    s.players[0].max_pp = 7;
    s.players[0].board.make_mut().clear();
    assert_close(diff(&s), 0.0);
}

#[test]
fn last_words_counts_damage_and_heal() {
    // ミミは相手のリーダーへの 2 点、ココは減っている分までの回復を数える。相手の場のものは引く
    let mut s = new_game(deck_at(0), deck_at(1), 3);
    let p = s.active;
    let q = opponent(p);
    let sw = search_weights();
    let w0 = with(&sw, |w| w.last_words = 0.0);
    let w1 = with(&sw, |w| w.last_words = 1.0);
    let diff = |s: &GameState| evaluate_with(s, p, &w1) - evaluate_with(s, p, &w0);
    let (opp_hp, my_hp) = (sw.w.opp_hp, sw.w.my_hp);
    let mimi = board_card(&mut s, "番犬の右腕・ミミ");
    s.players[p].board.make_mut().push(mimi);
    assert_close(diff(&s), 2.0 * opp_hp);
    let coco = board_card(&mut s, "番犬の左腕・ココ");
    s.players[p].board.make_mut().push(coco);
    assert_close(diff(&s), 2.0 * opp_hp); // 体力が減っていないので回復は 0
    s.players[p].leader_hp = 19;
    assert_close(diff(&s), 2.0 * opp_hp + my_hp);
    let mimi2 = board_card(&mut s, "番犬の右腕・ミミ");
    s.players[q].board.make_mut().push(mimi2);
    assert_close(diff(&s), 2.0 * opp_hp + my_hp - 2.0 * my_hp);
}

#[test]
fn last_words_summon_counts_summoned_followers() {
    // ボーンガールはスケルトン 2 体分の価値に倍率を掛けて足す
    let mut s = new_game(deck_at(0), deck_at(1), 3);
    let p = s.active;
    let girl = board_card(&mut s, "ボーンガール");
    s.players[p].board.make_mut().push(girl);
    let sw = search_weights();
    let w0 = with(&sw, |w| w.last_words_summon = 0.0);
    let w1 = with(&sw, |w| w.last_words_summon = 0.5);
    let skeleton = sw.w.attack + sw.w.defense + sw.w.follower_base;
    assert_close(
        evaluate_with(&s, p, &w1) - evaluate_with(&s, p, &w0),
        2.0 * skeleton * 0.5,
    );
}

#[test]
fn expiring_extra_pp_only_at_second_player_turn_5() {
    // 後攻の 5 ターン目を終える局面だけ、残っているエクストラPP の価値を引く
    let mut s = new_game(deck_at(0), deck_at(1), 3);
    let q = s.first;
    let p = opponent(q);
    s.phase = Phase::Main;
    s.active = p;
    s.players[p].extra_pp_available = true;
    let sw = search_weights();
    let w1 = with(&sw, |w| w.extra_pp_expiring = 1.0);
    s.players[p].turn_count = 5;
    assert_close(
        expiring_extra_pp(&s, p, &sw),
        sw.w.extra_pp * (1.0 - sw.w.extra_pp_expiring),
    );
    assert_eq!(expiring_extra_pp(&s, p, &w1), 0.0);
    s.players[p].turn_count = 4;
    assert_eq!(expiring_extra_pp(&s, p, &sw), 0.0);
    // 相手のターン中（相手のターンを読んだ後の局面など）は引かない
    s.players[p].turn_count = 5;
    s.active = q;
    assert_eq!(expiring_extra_pp(&s, p, &sw), 0.0);
    // evaluate_with は 5 ターン目でも他のターンと同じ価値
    s.active = p;
    assert_close(evaluate_with(&s, p, &sw), evaluate_with(&s, p, &w1));
}
