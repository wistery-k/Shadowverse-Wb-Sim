//! ゴールデンテスト用の、局面と行動の正規化した文字列（ハッシュを取って比べる）。

use crate::data::*;
use crate::state::*;

fn b(v: bool) -> &'static str {
    if v {
        "1"
    } else {
        "0"
    }
}

fn opt(v: Option<i32>) -> String {
    v.map(|x| x.to_string()).unwrap_or_else(|| "-".into())
}

fn cid(c: CardIdx) -> &'static str {
    &data().cards[c as usize].id
}

fn kws(k: Kw) -> String {
    k.names().join("+")
}

fn once(r: &[(u8, i32)]) -> String {
    let mut v: Vec<(String, i32)> = r.iter().map(|(k, x)| (k.to_string(), *x)).collect();
    v.sort();
    v.iter()
        .map(|(k, x)| format!("{k}={x}"))
        .collect::<Vec<_>>()
        .join("+")
}

fn join<T>(items: &[T], f: impl Fn(&T) -> String, sep: &str) -> String {
    items.iter().map(f).collect::<Vec<_>>().join(sep)
}

fn hand_canon(h: &HandCard) -> String {
    let d = data();
    let drawn = match &h.drawn_by {
        None => "-".to_string(),
        Some(hint) => {
            let f = hint.filter;
            format!(
                "{}/{}/{}/{}/{}/{}",
                f.ctype.map(|t| t.name()).unwrap_or(""),
                f.tribe
                    .map(|t| d.tribe_names[t as usize].as_str())
                    .unwrap_or(""),
                f.class.map(|c| c.name()).unwrap_or(""),
                f.ids
                    .as_ref()
                    .map(|ids| join(ids, |c| cid(*c).to_string(), "+"))
                    .unwrap_or_default(),
                f.cost_max.map(|x| x.to_string()).unwrap_or_default(),
                hint.cost_eq.map(|x| x.to_string()).unwrap_or_default(),
            )
        }
    };
    [
        h.iid.to_string(),
        cid(h.card).into(),
        h.cost_mod.to_string(),
        h.attack_mod.to_string(),
        h.defense_mod.to_string(),
        h.boosts.to_string(),
        opt(h.x),
        kws(h.keywords),
        join(&h.fused_kinds, |c| cid(*c).to_string(), "+"),
        b(h.fused_this_turn).into(),
        b(h.revealed).into(),
        drawn,
    ]
    .join(":")
}

fn board_canon(c: &OnBoard) -> String {
    let mut v = vec![
        c.iid.to_string(),
        cid(c.card).into(),
        (if c.is_follower { "f" } else { "a" }).into(),
        kws(c.keywords),
        kws(c.temp_keywords),
        c.granted.len().to_string(),
        c.order.to_string(),
    ];
    if c.is_follower {
        let ev = match c.evolve {
            Evolve::None => "none",
            Evolve::Evolved => "evolved",
            Evolve::SuperEvolved => "superEvolved",
        };
        v.extend([
            c.attack.to_string(),
            c.defense.to_string(),
            c.max_defense.to_string(),
            c.temp_attack.to_string(),
            c.max_attacks.to_string(),
            c.attacks_this_turn.to_string(),
            c.entered_turn.to_string(),
            ev.into(),
            opt(c.cannot_attack_until),
            opt(c.x),
            once(&c.used_once),
        ]);
    } else {
        v.extend([opt(c.countdown), opt(c.sigils), b(c.acted_this_turn).into()]);
    }
    v.join(":")
}

fn player_canon(p: &PlayerState) -> String {
    let head = [
        p.leader_hp.to_string(),
        p.leader_max_hp.to_string(),
        p.max_pp.to_string(),
        p.pp.to_string(),
        p.ep.to_string(),
        p.sep.to_string(),
        b(p.extra_pp_available).into(),
        p.turn_count.to_string(),
        p.graveyard.to_string(),
        p.combo.to_string(),
        b(p.evolved_this_turn).into(),
        p.ep_evolved_this_turn
            .map(|c| cid(c).to_string())
            .unwrap_or_else(|| "-".into()),
        p.sep_evolved_this_turn
            .map(|c| cid(c).to_string())
            .unwrap_or_else(|| "-".into()),
        b(p.mulligan_done).into(),
    ]
    .join(",");
    let mut out = [
        head,
        format!(
            "D{}",
            join(
                &p.deck,
                |r| match p.deck_kept.iter().find(|h| h.iid == r.iid) {
                    Some(h) => format!("{}:{}={}", r.iid, cid(r.card), hand_canon(h)),
                    None => format!("{}:{}", r.iid, cid(r.card)),
                },
                ","
            )
        ),
        format!("H{}", join(&p.hand, hand_canon, ",")),
        format!("B{}", join(&p.board, board_canon, ",")),
        format!(
            "C{}",
            join(
                &p.crests,
                |c| format!(
                    "{}:{}:{}:{}:{}",
                    c.iid,
                    data().crests[c.crest as usize].id,
                    opt(c.countdown),
                    c.order,
                    once(&c.used_once)
                ),
                ","
            )
        ),
        format!(
            "G{}",
            join(&p.graveyard_followers, |c| cid(*c).to_string(), ",")
        ),
        format!(
            "A{}",
            join(&p.destroyed_amulets, |c| cid(*c).to_string(), ",")
        ),
        format!(
            "T{}",
            join(
                &p.destroyed_this_turn,
                |r| format!("{}:{}:{}", cid(r.card), r.attack, r.defense),
                ","
            )
        ),
    ]
    .join(";");
    // 相手に分からない捨てたカード（無ければ書かない）
    if !p.hidden_discards.is_empty() {
        out.push_str(&format!(
            ";X{}",
            join(&p.hidden_discards, |c| cid(*c).to_string(), ",")
        ));
    }
    out
}

pub fn state_canon(s: &GameState) -> String {
    let pending = match &s.pending {
        None => "-".to_string(),
        Some(Pending::Choose {
            player,
            slot,
            candidates,
            count,
        }) => {
            format!(
                "choose:{player}:{}:{}:{count}",
                data().slot_names[*slot as usize],
                join(candidates, |x| x.to_string(), "+")
            )
        }
        Some(Pending::Mode { player, options }) => format!("mode:{player}:{options}"),
    };
    let attack = match &s.attack {
        None => "-".to_string(),
        Some(a) => format!(
            "{}:{}:{}:{}",
            a.attacker,
            a.defender,
            b(a.super_evolved),
            b(a.defender_destroyed)
        ),
    };
    let phase = match s.phase {
        Phase::Mulligan => "mulligan",
        Phase::Main => "main",
        Phase::Ended => "ended",
    };
    [
        phase.to_string(),
        s.first.to_string(),
        s.active.to_string(),
        s.turn.to_string(),
        s.winner
            .map(|w| w.to_string())
            .unwrap_or_else(|| "-".into()),
        s.rng.to_string(),
        s.next_iid.to_string(),
        s.next_order.to_string(),
        pending,
        attack,
        format!(
            "S{}",
            join(&s.stack, |f| format!("{}:{}", f.effects.len(), f.pc), ",")
        ),
        format!("Q{}", s.queue.len()),
        format!("P0 {}", player_canon(&s.players[0])),
        format!("P1 {}", player_canon(&s.players[1])),
    ]
    .join("|")
}

pub fn action_canon(a: &Action) -> String {
    let ids = |v: &[Iid]| join(v, |x| x.to_string(), "+");
    match a {
        Action::Mulligan { player, swap } => format!("mulligan:{player}:{}", ids(swap)),
        Action::Play(i) => format!("play:{i}"),
        Action::Evolve(i) => format!("evolve:{i}"),
        Action::SuperEvolve(i) => format!("superEvolve:{i}"),
        Action::Act(i) => format!("act:{i}"),
        Action::Attack { attacker, target } => format!(
            "attack:{attacker}:{}",
            target.map(|t| t.to_string()).unwrap_or_else(|| "L".into())
        ),
        Action::Fuse { host, materials } => format!("fuse:{host}:{}", ids(materials)),
        Action::Choose(t) => format!("choose:{}", ids(t)),
        Action::Mode(i) => format!("mode:{i}"),
        Action::ExtraPp => "extraPp".into(),
        Action::EndTurn => "endTurn".into(),
    }
}

/// FNV-1a（32 ビット、UTF-8 のバイト列）
pub fn fnv(s: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for &byte in s.as_bytes() {
        h = (h ^ byte as u32).wrapping_mul(0x01000193);
    }
    format!("{h:08x}")
}
