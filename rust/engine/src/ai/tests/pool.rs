//! 前期のローテーション（docs/pools/azvaldt.md）のプロのデッキのうち、能力を書いた型（スペルW・アグロNi・ランプD・アミュレットB・コンボE・海賊R・
//! ミッドレンジNi・実験体W・クキシロB・ハイランダーNm）を
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

#[test]
fn search_finishes_pool_combo_elf_vs_pirate_royal() {
    let elf = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/CR_エルフ.txt"
    ));
    let royal = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/CR_ロイヤル.txt"
    ));
    finish_both(&elf, &royal);
}

#[test]
fn search_finishes_pool_midrange_nightmare_vs_subject_witch() {
    let nightmare = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/CR_ナイトメア.txt"
    ));
    let witch = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/VL_ウィッチ.txt"
    ));
    finish_both(&nightmare, &witch);
}

#[test]
fn search_finishes_pool_kukishiro_bishop_vs_midrange_nightmare() {
    let bishop = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-09b/ZETA_ビショップ.txt"
    ));
    let nightmare = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/CR_ナイトメア.txt"
    ));
    finish_both(&bishop, &nightmare);
}

#[test]
fn search_finishes_pool_highlander_nemesis_vs_spell_witch() {
    let nemesis = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/CR_ネメシス.txt"
    ));
    let witch = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/CR_ウィッチ.txt"
    ));
    finish_both(&nemesis, &witch);
}

#[test]
fn search_finishes_pool_highlander_nemesis_mirror() {
    // 愚劣の兵器を入れたものと、ストーン・ブレイクを入れたもの
    let a = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-08b/ZETA_ネメシス.txt"
    ));
    let b = pool_deck(include_str!(
        "../../../../../data/pools/azvaldt/decks/ps26-27-09b/ZETA_ネメシス.txt"
    ));
    finish_both(&a, &b);
}
