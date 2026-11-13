//! 前期のローテーション（docs/pools/azvaldt.md）のプロのデッキのうち、能力を書いた型（スペルW・アグロNi・ランプD・アミュレットB）を
//! 探索 AI で最後まで打つ

use super::*;
use crate::ai::search::{SearchAgent, SearchOptions};
use crate::data::Pool;
use crate::sim::play_match;

/// デッキのファイル（data/pools/azvaldt/decks/）を前期のローテーションのカードで読む
fn pool_deck(text: &str) -> Vec<CardIdx> {
    let d = data();
    let mut out = Vec::new();
    for line in text.lines() {
        let Some((n, name)) = line.trim().split_once(' ') else {
            continue;
        };
        let Ok(n) = n.parse::<usize>() else { continue };
        let i = d
            .cards
            .iter()
            .position(|c| c.name == name.trim() && !c.token && c.in_pool(Pool::Azvaldt))
            .unwrap_or_else(|| panic!("前期のローテーションにカードがありません: {name}"));
        out.extend(std::iter::repeat_n(i as CardIdx, n));
    }
    assert_eq!(out.len(), 40);
    out
}

/// 2 つのデッキを、席を入れ替えて 2 試合打つ
fn finish_both(x: &[CardIdx], y: &[CardIdx]) {
    for seed in 1..=2u32 {
        let mut a = SearchAgent::new(SearchOptions::default());
        let mut b = SearchAgent::new(SearchOptions::default());
        fresh();
        let decks: [&[CardIdx]; 2] = if seed % 2 == 1 { [x, y] } else { [y, x] };
        let end = play_match(&mut [&mut a, &mut b], decks, seed, |_, _| {});
        assert!(end.winner.is_some());
    }
}

#[test]
fn search_finishes_pool_spell_witch_vs_aggro_nightmare() {
    let witch = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/CR_ウィッチ.txt"
    ));
    let nightmare = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/VL_ナイトメア.txt"
    ));
    finish_both(&witch, &nightmare);
}

#[test]
fn search_finishes_pool_ramp_dragon_vs_amulet_bishop() {
    let dragon = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/CR_ドラゴン.txt"
    ));
    let bishop = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/CR_ビショップ.txt"
    ));
    finish_both(&dragon, &bishop);
}
