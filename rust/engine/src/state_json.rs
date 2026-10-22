//! 局面・行動を、TypeScript 版と同じ形の JSON（src/engine/types.ts の GameState・Action）で書き出し・読み込む。
//! ブラウザ（WASM）や TypeScript のテストと局面を受け渡すため。
//!
//! 能力の DSL（解決スタックの効果・誘発待ちの能力・付与された能力）は、カードの能力のデータの JSON
//! （engine-data.json）と突き合わせて書き出し・読み込む。データに無い能力を含む局面は読み込めない。
//! 文脈の sourceCardId（TypeScript 版のエンジンだけが持っていた値）は書き出さず、読み込むときは無視する。

use crate::data::*;
use crate::json::Json;
use crate::state::*;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

// ---- 能力の DSL と JSON の対応 ----

struct DslIndex {
    /// データの効果・能力（の参照のアドレス）→ その JSON
    effect_json: HashMap<usize, &'static Json>,
    ability_json: HashMap<usize, &'static Json>,
    /// JSON（canonical）→ データの効果・能力（同じ内容が複数あれば最初のもの）
    effect_by_key: HashMap<String, &'static Effect>,
    ability_by_key: HashMap<String, &'static Ability>,
}

fn addr<T>(x: &T) -> usize {
    x as *const T as usize
}

fn walk_abilities(list: &'static [Ability], v: Option<&'static Json>, ix: &mut DslIndex) {
    let Some(Json::Arr(vs)) = v else {
        panic!("能力のデータの JSON の形が違います（abilities）")
    };
    assert_eq!(list.len(), vs.len(), "能力の数が JSON と違います");
    for (a, av) in list.iter().zip(vs) {
        ix.ability_json.insert(addr(a), av);
        ix.ability_by_key.entry(av.canonical()).or_insert(a);
        walk_effects(&a.effects, av.get("effects"), ix);
    }
}

fn walk_effects(list: &'static [Effect], v: Option<&'static Json>, ix: &mut DslIndex) {
    let Some(Json::Arr(vs)) = v else {
        panic!("能力のデータの JSON の形が違います（効果の並び）")
    };
    assert_eq!(list.len(), vs.len(), "効果の数が JSON と違います");
    for (e, ev) in list.iter().zip(vs) {
        ix.effect_json.insert(addr(e), ev);
        ix.effect_by_key.entry(ev.canonical()).or_insert(e);
        match e {
            Effect::Mode { options } => {
                let Some(Json::Arr(ovs)) = ev.get("options") else {
                    panic!("mode の options がありません")
                };
                for (o, ov) in options.iter().zip(ovs) {
                    walk_effects(o, Some(ov), ix);
                }
            }
            Effect::Grant {
                abilities: Some(abs),
                ..
            } => walk_abilities(abs, ev.get("abilities"), ix),
            Effect::EarthRite { then, .. } | Effect::Necromancy { then, .. } => {
                walk_effects(then, ev.get("then"), ix)
            }
            Effect::If {
                then, otherwise, ..
            } => {
                walk_effects(then, ev.get("then"), ix);
                if let Some(o) = otherwise {
                    walk_effects(o, ev.get("else"), ix);
                }
            }
            Effect::Repeat { effects, .. } => walk_effects(effects, ev.get("effects"), ix),
            _ => {}
        }
    }
}

fn dsl_index() -> &'static DslIndex {
    static IX: OnceLock<DslIndex> = OnceLock::new();
    IX.get_or_init(|| {
        let raw: &'static Json = Box::leak(Box::new(
            Json::parse(ENGINE_DATA_JSON).expect("engine-data.json"),
        ));
        let d = data();
        let mut ix = DslIndex {
            effect_json: HashMap::new(),
            ability_json: HashMap::new(),
            effect_by_key: HashMap::new(),
            ability_by_key: HashMap::new(),
        };
        if let Some(Json::Obj(items)) = raw.get("cardAbilities") {
            for (id, v) in items {
                let c = d.card_idx(id) as usize;
                walk_abilities(&d.abilities[c].abilities, v.get("abilities"), &mut ix);
            }
        }
        if let Some(Json::Obj(items)) = raw.get("crestAbilities") {
            for (id, v) in items {
                let n = d.crests.iter().position(|c| &c.id == id).expect("クレスト");
                if let Some(ca) = &d.crest_abilities[n] {
                    walk_abilities(&ca.abilities, v.get("abilities"), &mut ix);
                }
            }
        }
        ix
    })
}

fn effect_json(e: &'static Effect) -> Json {
    dsl_index()
        .effect_json
        .get(&addr(e))
        .map(|v| (*v).clone())
        .expect("能力のデータに無い効果")
}

fn ability_json(a: &'static Ability) -> Json {
    dsl_index()
        .ability_json
        .get(&addr(a))
        .map(|v| (*v).clone())
        .expect("能力のデータに無い能力")
}

/// 能力の JSON の文字列（DSL の形。src/engine/dsl.ts）。自己対戦の書き出しで、場のカードに付与された能力を書くのに使う
pub fn ability_json_text(a: &'static Ability) -> String {
    ability_json(a).stringify()
}

/// カード・クレストの能力のデータにあるすべての能力の、アドレスと JSON の文字列（ability_json_text と同じ）。
/// 学習した補正が、場のカードに付与された能力を JSON の文字列で見分けるのに使う
pub fn ability_json_texts() -> Vec<(usize, String)> {
    dsl_index()
        .ability_json
        .iter()
        .map(|(&a, v)| (a, v.stringify()))
        .collect()
}

fn effect_from(v: &Json) -> Result<&'static Effect, String> {
    dsl_index()
        .effect_by_key
        .get(&v.canonical())
        .copied()
        .ok_or_else(|| format!("カードの能力のデータに無い効果です: {}", v.stringify()))
}

fn ability_from(v: &Json) -> Result<&'static Ability, String> {
    dsl_index()
        .ability_by_key
        .get(&v.canonical())
        .copied()
        .ok_or_else(|| format!("カードの能力のデータに無い能力です: {}", v.stringify()))
}

// ---- 書き出し ----

fn obj(items: Vec<(&str, Json)>) -> Json {
    Json::Obj(items.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn num(x: i32) -> Json {
    Json::Num(x as f64)
}

fn opt_num(x: Option<i32>) -> Json {
    x.map(num).unwrap_or(Json::Null)
}

fn s(x: &str) -> Json {
    Json::Str(x.to_string())
}

fn card_id(c: CardIdx) -> Json {
    s(&data().cards[c as usize].id)
}

fn cards(list: &[CardIdx]) -> Json {
    Json::Arr(list.iter().map(|&c| card_id(c)).collect())
}

fn iids(list: &[Iid]) -> Json {
    Json::Arr(list.iter().map(|&x| num(x)).collect())
}

fn keywords(k: Kw) -> Json {
    Json::Arr(k.names().into_iter().map(s).collect())
}

fn once(r: &[(u8, i32)]) -> Json {
    Json::Obj(r.iter().map(|(k, x)| (k.to_string(), num(*x))).collect())
}

fn hint_json(h: &DrawHint) -> Json {
    let f = h.filter;
    let d = data();
    let mut o = Vec::new();
    if let Some(t) = f.ctype {
        o.push(("type", s(t.name())));
    }
    if let Some(t) = f.tribe {
        o.push(("tribe", s(&d.tribe_names[t as usize])));
    }
    if let Some(c) = f.class {
        o.push(("class", s(c.name())));
    }
    if let Some(ids) = &f.ids {
        o.push(("ids", cards(ids)));
    }
    if let Some(m) = f.cost_max {
        o.push(("costMax", num(m)));
    }
    if let Some(e) = h.cost_eq {
        o.push(("costEq", num(e)));
    }
    obj(o)
}

fn hand_json(h: &HandCard) -> Json {
    obj(vec![
        ("iid", num(h.iid)),
        ("cardId", card_id(h.card)),
        ("costMod", num(h.cost_mod)),
        ("attackMod", num(h.attack_mod)),
        ("defenseMod", num(h.defense_mod)),
        ("boosts", num(h.boosts)),
        ("x", opt_num(h.x)),
        ("keywords", keywords(h.keywords)),
        ("fusedKinds", cards(&h.fused_kinds)),
        ("fusedThisTurn", Json::Bool(h.fused_this_turn)),
        ("revealed", Json::Bool(h.revealed)),
        (
            "drawnBy",
            h.drawn_by.as_ref().map(hint_json).unwrap_or(Json::Null),
        ),
    ])
}

fn evolve_name(e: Evolve) -> &'static str {
    match e {
        Evolve::None => "none",
        Evolve::Evolved => "evolved",
        Evolve::SuperEvolved => "superEvolved",
    }
}

fn board_json(c: &OnBoard) -> Json {
    let mut o = vec![
        ("iid", num(c.iid)),
        ("cardId", card_id(c.card)),
        ("keywords", keywords(c.keywords)),
        ("tempKeywords", keywords(c.temp_keywords)),
        (
            "granted",
            Json::Arr(c.granted.iter().map(|a| ability_json(a)).collect()),
        ),
        ("order", num(c.order)),
    ];
    if c.is_follower {
        o.extend([
            ("kind", s("follower")),
            ("attack", num(c.attack)),
            ("defense", num(c.defense)),
            ("maxDefense", num(c.max_defense)),
            ("tempAttack", num(c.temp_attack)),
            ("maxAttacks", num(c.max_attacks)),
            ("attacksThisTurn", num(c.attacks_this_turn)),
            ("enteredTurn", num(c.entered_turn)),
            ("evolve", s(evolve_name(c.evolve))),
            ("cannotAttackUntil", opt_num(c.cannot_attack_until)),
            ("x", opt_num(c.x)),
            ("usedOncePerTurn", once(&c.used_once)),
        ]);
    } else {
        o.extend([
            ("kind", s("amulet")),
            ("countdown", opt_num(c.countdown)),
            ("sigils", opt_num(c.sigils)),
            ("actedThisTurn", Json::Bool(c.acted_this_turn)),
        ]);
    }
    obj(o)
}

fn player_json(p: &PlayerState) -> Json {
    let mut o = vec![
        ("leaderHp", num(p.leader_hp)),
        ("leaderMaxHp", num(p.leader_max_hp)),
        ("maxPp", num(p.max_pp)),
        ("pp", num(p.pp)),
        ("ep", num(p.ep)),
        ("sep", num(p.sep)),
        ("extraPpAvailable", Json::Bool(p.extra_pp_available)),
        ("turnCount", num(p.turn_count)),
        (
            "deck",
            Json::Arr(
                p.deck
                    .iter()
                    .map(|c| {
                        let mut o = vec![("iid", num(c.iid)), ("cardId", card_id(c.card))];
                        if let Some(h) = p.deck_kept.iter().find(|h| h.iid == c.iid) {
                            o.push(("kept", hand_json(h)));
                        }
                        obj(o)
                    })
                    .collect(),
            ),
        ),
        ("hand", Json::Arr(p.hand.iter().map(hand_json).collect())),
        ("board", Json::Arr(p.board.iter().map(board_json).collect())),
        (
            "crests",
            Json::Arr(
                p.crests
                    .iter()
                    .map(|c| {
                        obj(vec![
                            ("iid", num(c.iid)),
                            ("crestId", s(&data().crests[c.crest as usize].id)),
                            ("countdown", opt_num(c.countdown)),
                            ("order", num(c.order)),
                            ("usedOncePerTurn", once(&c.used_once)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("graveyard", num(p.graveyard)),
        ("graveyardFollowers", cards(&p.graveyard_followers)),
        ("destroyedAmulets", cards(&p.destroyed_amulets)),
    ];
    // 相手に分からない捨てたカード（無ければ省く）
    if !p.hidden_discards.is_empty() {
        o.push(("hiddenDiscards", cards(&p.hidden_discards)));
    }
    o.extend([
        (
            "destroyedThisTurn",
            Json::Arr(
                p.destroyed_this_turn
                    .iter()
                    .map(|r| {
                        obj(vec![
                            ("cardId", card_id(r.card)),
                            ("attack", num(r.attack)),
                            ("defense", num(r.defense)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("combo", num(p.combo)),
        ("evolvedThisTurn", Json::Bool(p.evolved_this_turn)),
        (
            "epEvolvedThisTurn",
            p.ep_evolved_this_turn.map(card_id).unwrap_or(Json::Null),
        ),
        (
            "sepEvolvedThisTurn",
            p.sep_evolved_this_turn.map(card_id).unwrap_or(Json::Null),
        ),
        ("leaderOncePerTurn", Json::Obj(Vec::new())),
        ("mulliganDone", Json::Bool(p.mulligan_done)),
    ]);
    obj(o)
}

fn ctx_json(c: &Ctx) -> Json {
    let d = data();
    obj(vec![
        ("controller", num(c.controller as i32)),
        ("source", num(c.source)),
        ("event", opt_num(c.event)),
        (
            "slots",
            Json::Obj(
                c.slots
                    .iter()
                    .map(|(k, v)| (d.slot_names[*k as usize].clone(), iids(v)))
                    .collect(),
            ),
        ),
        (
            "vars",
            Json::Obj(
                c.vars
                    .iter()
                    .map(|(k, x)| (d.var_names[*k as usize].clone(), num(*x)))
                    .collect(),
            ),
        ),
        ("enhanced", Json::Bool(c.enhanced)),
        ("sourceX", opt_num(c.source_x)),
        ("sourceAttack", num(c.source_attack)),
    ])
}

fn feff_json(e: &FEff) -> Json {
    let op = |name: &str| obj(vec![("op", s(name))]);
    match e {
        FEff::Dsl(x) => effect_json(x),
        FEff::Combat { attacker, target } => obj(vec![
            ("op", s("_combat")),
            ("attacker", num(*attacker)),
            ("target", target.map(num).unwrap_or_else(|| s("leader"))),
        ]),
        FEff::CombatEnd => op("_combatEnd"),
        FEff::EndTurn => op("_endTurn"),
        FEff::Cleanup => op("_cleanup"),
        FEff::StartTurn => op("_startTurn"),
        FEff::StartTurnDraw => op("_startTurnDraw"),
        FEff::FinishMulligan => op("_finishMulligan"),
    }
}

fn pending_json(p: &Pending) -> Json {
    match p {
        Pending::Choose {
            player,
            slot,
            candidates,
            count,
        } => obj(vec![
            ("kind", s("choose")),
            ("player", num(*player as i32)),
            ("slot", s(&data().slot_names[*slot as usize])),
            ("candidates", iids(candidates)),
            ("count", num(*count as i32)),
        ]),
        Pending::Mode { player, options } => obj(vec![
            ("kind", s("mode")),
            ("player", num(*player as i32)),
            ("options", num(*options as i32)),
        ]),
    }
}

/// 局面を TypeScript 版の GameState の形の JSON にする
pub fn state_to_json(st: &GameState) -> Json {
    obj(vec![
        (
            "phase",
            s(match st.phase {
                Phase::Mulligan => "mulligan",
                Phase::Main => "main",
                Phase::Ended => "ended",
            }),
        ),
        (
            "players",
            Json::Arr(st.players.iter().map(player_json).collect()),
        ),
        ("first", num(st.first as i32)),
        ("active", num(st.active as i32)),
        ("turn", num(st.turn)),
        (
            "winner",
            st.winner.map(|w| num(w as i32)).unwrap_or(Json::Null),
        ),
        ("rng", Json::Num(st.rng as f64)),
        ("nextIid", num(st.next_iid)),
        ("nextOrder", num(st.next_order)),
        (
            "stack",
            Json::Arr(
                st.stack
                    .iter()
                    .map(|f| {
                        obj(vec![
                            (
                                "effects",
                                Json::Arr(f.effects.iter().map(|e| feff_json(&e)).collect()),
                            ),
                            ("pc", num(f.pc as i32)),
                            ("ctx", ctx_json(&f.ctx)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "queue",
            Json::Arr(
                st.queue
                    .iter()
                    .map(|q| {
                        obj(vec![
                            ("ability", ability_json(q.ability)),
                            ("ctx", ctx_json(&q.ctx)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "pending",
            st.pending.as_ref().map(pending_json).unwrap_or(Json::Null),
        ),
        (
            "attack",
            st.attack
                .map(|a| {
                    obj(vec![
                        ("attacker", num(a.attacker)),
                        ("defender", num(a.defender)),
                        ("superEvolved", Json::Bool(a.super_evolved)),
                        ("defenderDestroyed", Json::Bool(a.defender_destroyed)),
                    ])
                })
                .unwrap_or(Json::Null),
        ),
    ])
}

/// 行動を TypeScript 版の Action の形の JSON にする
pub fn action_to_json(a: &Action) -> Json {
    let ty = |t: &str| ("type", s(t));
    match a {
        Action::Mulligan { player, swap } => obj(vec![
            ty("mulligan"),
            ("player", num(*player as i32)),
            ("swap", iids(swap)),
        ]),
        Action::Play(iid) => obj(vec![ty("play"), ("iid", num(*iid))]),
        Action::Attack { attacker, target } => obj(vec![
            ty("attack"),
            ("attacker", num(*attacker)),
            ("target", target.map(num).unwrap_or_else(|| s("leader"))),
        ]),
        Action::Evolve(iid) => obj(vec![ty("evolve"), ("iid", num(*iid))]),
        Action::SuperEvolve(iid) => obj(vec![ty("superEvolve"), ("iid", num(*iid))]),
        Action::Act(iid) => obj(vec![ty("act"), ("iid", num(*iid))]),
        Action::Fuse { host, materials } => obj(vec![
            ty("fuse"),
            ("host", num(*host)),
            ("materials", iids(materials)),
        ]),
        Action::ExtraPp => obj(vec![ty("extraPp")]),
        Action::Choose(targets) => obj(vec![ty("choose"), ("targets", iids(targets))]),
        Action::Mode(i) => obj(vec![ty("mode"), ("index", num(*i as i32))]),
        Action::EndTurn => obj(vec![ty("endTurn")]),
    }
}

// ---- 読み込み ----

type R<T> = Result<T, String>;

fn field<'a>(v: &'a Json, k: &str) -> R<&'a Json> {
    v.get(k).ok_or_else(|| format!("\"{k}\" がありません"))
}

fn int_of(k: &str, v: &Json) -> R<i64> {
    match v {
        Json::Num(x) if x.fract() == 0.0 && x.abs() < 9e15 => Ok(*x as i64),
        _ => Err(format!("\"{k}\" は整数: {}", v.stringify())),
    }
}

fn int(v: &Json, k: &str) -> R<i32> {
    let x = int_of(k, field(v, k)?)?;
    i32::try_from(x).map_err(|_| format!("\"{k}\" が大きすぎます: {x}"))
}

fn uint(v: &Json, k: &str) -> R<usize> {
    let x = int_of(k, field(v, k)?)?;
    usize::try_from(x).map_err(|_| format!("\"{k}\" は 0 以上: {x}"))
}

fn opt_int(v: &Json, k: &str) -> R<Option<i32>> {
    match field(v, k)? {
        Json::Null => Ok(None),
        _ => int(v, k).map(Some),
    }
}

fn boolean(v: &Json, k: &str) -> R<bool> {
    match field(v, k)? {
        Json::Bool(b) => Ok(*b),
        x => Err(format!("\"{k}\" は true か false: {}", x.stringify())),
    }
}

fn string<'a>(v: &'a Json, k: &str) -> R<&'a str> {
    match field(v, k)? {
        Json::Str(x) => Ok(x),
        x => Err(format!("\"{k}\" は文字列: {}", x.stringify())),
    }
}

fn array<'a>(v: &'a Json, k: &str) -> R<&'a [Json]> {
    match field(v, k)? {
        Json::Arr(xs) => Ok(xs),
        x => Err(format!("\"{k}\" は配列: {}", x.stringify())),
    }
}

fn player_index(v: &Json, k: &str) -> R<PlayerIndex> {
    match int(v, k)? {
        0 => Ok(0),
        1 => Ok(1),
        x => Err(format!("\"{k}\" は 0 か 1: {x}")),
    }
}

fn card_of(id: &str) -> R<CardIdx> {
    data()
        .card_by_id
        .get(id)
        .copied()
        .ok_or_else(|| format!("未知のカードID: {id}"))
}

fn card_field(v: &Json, k: &str) -> R<CardIdx> {
    card_of(string(v, k)?)
}

fn card_list(v: &Json, k: &str) -> R<Vec<CardIdx>> {
    array(v, k)?
        .iter()
        .map(|x| match x {
            Json::Str(id) => card_of(id),
            _ => Err(format!("\"{k}\" はカードIDの配列")),
        })
        .collect()
}

fn opt_card(v: &Json, k: &str) -> R<Option<CardIdx>> {
    match field(v, k)? {
        Json::Null => Ok(None),
        _ => card_field(v, k).map(Some),
    }
}

fn iid_list(v: &Json, k: &str) -> R<Vec<Iid>> {
    array(v, k)?
        .iter()
        .map(|x| int_of(k, x).and_then(|n| i32::try_from(n).map_err(|e| e.to_string())))
        .collect()
}

fn keywords_of(v: &Json, k: &str) -> R<Kw> {
    let mut kw = Kw::EMPTY;
    for x in array(v, k)? {
        let Json::Str(name) = x else {
            return Err(format!("\"{k}\" はキーワードの配列"));
        };
        let i = KEYWORD_NAMES
            .iter()
            .position(|n| n == name)
            .ok_or_else(|| format!("未知のキーワード: {name}"))?;
        kw = kw.with(Kw::one(i as u16));
    }
    Ok(kw)
}

fn once_of(v: &Json, k: &str) -> R<Vec<(u8, i32)>> {
    let Json::Obj(items) = field(v, k)? else {
        return Err(format!("\"{k}\" はオブジェクト"));
    };
    items
        .iter()
        .map(|(key, x)| {
            let i: u8 = key
                .parse()
                .map_err(|_| format!("\"{k}\" の項目は能力の添字: {key}"))?;
            Ok((i, i32::try_from(int_of(k, x)?).map_err(|e| e.to_string())?))
        })
        .collect()
}

/// 読み込んだ引くカードの条件（同じ内容は 1 つにまとめて使い回す）
fn hint_filter(f: CardFilter) -> &'static CardFilter {
    static FILTERS: OnceLock<Mutex<HashMap<String, &'static CardFilter>>> = OnceLock::new();
    let key = format!("{f:?}");
    let mut m = FILTERS
        .get_or_init(Default::default)
        .lock()
        .expect("条件の表");
    m.entry(key).or_insert_with(|| Box::leak(Box::new(f)))
}

fn hint_of(v: &Json) -> R<Option<DrawHint>> {
    if *v == Json::Null {
        return Ok(None);
    }
    let d = data();
    let mut f = CardFilter::default();
    if let Some(Json::Str(t)) = v.get("type") {
        f.ctype = Some(match t.as_str() {
            "follower" => CardType::Follower,
            "spell" => CardType::Spell,
            "amulet" => CardType::Amulet,
            _ => return Err(format!("未知のカードの種類: {t}")),
        });
    }
    if let Some(Json::Str(t)) = v.get("tribe") {
        let i = d
            .tribe_names
            .iter()
            .position(|n| n == t)
            .ok_or_else(|| format!("未知のタイプ: {t}"))?;
        f.tribe = Some(i as TribeId);
    }
    if let Some(Json::Str(c)) = v.get("class") {
        f.class = Some(
            [
                ClassId::Neutral,
                ClassId::Elf,
                ClassId::Royal,
                ClassId::Witch,
                ClassId::Dragon,
                ClassId::Nightmare,
                ClassId::Bishop,
                ClassId::Nemesis,
            ]
            .into_iter()
            .find(|x| x.name() == c)
            .ok_or_else(|| format!("未知のクラス: {c}"))?,
        );
    }
    if v.get("ids").is_some() {
        f.ids = Some(card_list(v, "ids")?);
    }
    if v.get("costMax").is_some() {
        f.cost_max = Some(int(v, "costMax")?);
    }
    let cost_eq = if v.get("costEq").is_some() {
        Some(int(v, "costEq")?)
    } else {
        None
    };
    Ok(Some(DrawHint {
        filter: hint_filter(f),
        cost_eq,
    }))
}

fn hand_of(v: &Json) -> R<HandCard> {
    Ok(HandCard {
        iid: int(v, "iid")?,
        card: card_field(v, "cardId")?,
        cost_mod: int(v, "costMod")?,
        attack_mod: int(v, "attackMod")?,
        defense_mod: int(v, "defenseMod")?,
        boosts: int(v, "boosts")?,
        x: opt_int(v, "x")?,
        keywords: keywords_of(v, "keywords")?,
        fused_kinds: card_list(v, "fusedKinds")?,
        fused_this_turn: boolean(v, "fusedThisTurn")?,
        revealed: boolean(v, "revealed")?,
        drawn_by: hint_of(field(v, "drawnBy")?)?,
    })
}

fn board_of(v: &Json) -> R<OnBoard> {
    let granted = array(v, "granted")?
        .iter()
        .map(ability_from)
        .collect::<R<Vec<_>>>()?;
    let mut b = OnBoard {
        iid: int(v, "iid")?,
        card: card_field(v, "cardId")?,
        is_follower: false,
        keywords: keywords_of(v, "keywords")?,
        temp_keywords: keywords_of(v, "tempKeywords")?,
        granted,
        order: int(v, "order")?,
        attack: 0,
        defense: 0,
        max_defense: 0,
        temp_attack: 0,
        max_attacks: 0,
        attacks_this_turn: 0,
        entered_turn: 0,
        evolve: Evolve::None,
        cannot_attack_until: None,
        x: None,
        used_once: Vec::new(),
        countdown: None,
        sigils: None,
        acted_this_turn: false,
    };
    match string(v, "kind")? {
        "follower" => {
            b.is_follower = true;
            b.attack = int(v, "attack")?;
            b.defense = int(v, "defense")?;
            b.max_defense = int(v, "maxDefense")?;
            b.temp_attack = int(v, "tempAttack")?;
            b.max_attacks = int(v, "maxAttacks")?;
            b.attacks_this_turn = int(v, "attacksThisTurn")?;
            b.entered_turn = int(v, "enteredTurn")?;
            b.evolve = match string(v, "evolve")? {
                "none" => Evolve::None,
                "evolved" => Evolve::Evolved,
                "superEvolved" => Evolve::SuperEvolved,
                e => return Err(format!("未知の進化の状態: {e}")),
            };
            b.cannot_attack_until = opt_int(v, "cannotAttackUntil")?;
            b.x = opt_int(v, "x")?;
            b.used_once = once_of(v, "usedOncePerTurn")?;
        }
        "amulet" => {
            b.countdown = opt_int(v, "countdown")?;
            b.sigils = opt_int(v, "sigils")?;
            b.acted_this_turn = boolean(v, "actedThisTurn")?;
        }
        k => return Err(format!("未知の場のカードの種類: {k}")),
    }
    Ok(b)
}

fn player_of(v: &Json) -> R<PlayerState> {
    let mut deck_kept = Vec::new();
    for c in array(v, "deck")? {
        if let Some(k) = c.get("kept").filter(|k| !matches!(k, Json::Null)) {
            let h = hand_of(k)?;
            if h.iid != int(c, "iid")? {
                return Err(format!("山札のカード {} の kept の iid が違います", h.iid));
            }
            deck_kept.push(h);
        }
    }
    Ok(PlayerState {
        leader_hp: int(v, "leaderHp")?,
        leader_max_hp: int(v, "leaderMaxHp")?,
        max_pp: int(v, "maxPp")?,
        pp: int(v, "pp")?,
        ep: int(v, "ep")?,
        sep: int(v, "sep")?,
        extra_pp_available: boolean(v, "extraPpAvailable")?,
        turn_count: int(v, "turnCount")?,
        deck: array(v, "deck")?
            .iter()
            .map(|c| {
                Ok(CardRef {
                    iid: int(c, "iid")?,
                    card: card_field(c, "cardId")?,
                })
            })
            .collect::<R<_>>()?,
        deck_kept,
        hand: array(v, "hand")?.iter().map(hand_of).collect::<R<_>>()?,
        board: array(v, "board")?.iter().map(board_of).collect::<R<_>>()?,
        crests: array(v, "crests")?
            .iter()
            .map(|c| {
                let id = string(c, "crestId")?;
                let crest = data()
                    .crests
                    .iter()
                    .position(|x| x.id == id)
                    .ok_or_else(|| format!("未知のクレスト: {id}"))?;
                Ok(CrestInstance {
                    iid: int(c, "iid")?,
                    crest: crest as CrestIdx,
                    countdown: opt_int(c, "countdown")?,
                    order: int(c, "order")?,
                    used_once: once_of(c, "usedOncePerTurn")?,
                })
            })
            .collect::<R<_>>()?,
        graveyard: int(v, "graveyard")?,
        graveyard_followers: card_list(v, "graveyardFollowers")?.into(),
        destroyed_amulets: card_list(v, "destroyedAmulets")?.into(),
        hidden_discards: match v.get("hiddenDiscards") {
            None | Some(Json::Null) => Shared::default(),
            Some(_) => card_list(v, "hiddenDiscards")?.into(),
        },
        destroyed_this_turn: array(v, "destroyedThisTurn")?
            .iter()
            .map(|r| {
                Ok(DestroyedRecord {
                    card: card_field(r, "cardId")?,
                    attack: int(r, "attack")?,
                    defense: int(r, "defense")?,
                })
            })
            .collect::<R<_>>()?,
        combo: int(v, "combo")?,
        evolved_this_turn: boolean(v, "evolvedThisTurn")?,
        ep_evolved_this_turn: opt_card(v, "epEvolvedThisTurn")?,
        sep_evolved_this_turn: opt_card(v, "sepEvolvedThisTurn")?,
        mulligan_done: boolean(v, "mulliganDone")?,
    })
}

fn slot_of(name: &str) -> R<SlotId> {
    data()
        .slot_names
        .iter()
        .position(|n| n == name)
        .map(|i| i as SlotId)
        .ok_or_else(|| format!("未知のスロット: {name}"))
}

fn ctx_of(v: &Json) -> R<Ctx> {
    let d = data();
    let Json::Obj(slots) = field(v, "slots")? else {
        return Err("\"slots\" はオブジェクト".into());
    };
    let Json::Obj(vars) = field(v, "vars")? else {
        return Err("\"vars\" はオブジェクト".into());
    };
    Ok(Ctx {
        controller: player_index(v, "controller")?,
        source: int(v, "source")?,
        event: opt_int(v, "event")?,
        slots: slots
            .iter()
            .map(|(k, x)| {
                let list = match x {
                    Json::Arr(xs) => xs
                        .iter()
                        .map(|n| int_of(k, n).map(|n| n as Iid))
                        .collect::<R<Vec<_>>>()?,
                    _ => return Err(format!("スロット {k} は配列")),
                };
                Ok((slot_of(k)?, list))
            })
            .collect::<R<_>>()?,
        vars: vars
            .iter()
            .map(|(k, x)| {
                let i = d
                    .var_names
                    .iter()
                    .position(|n| n == k)
                    .ok_or_else(|| format!("未知の変数: {k}"))?;
                Ok((i as VarId, int_of(k, x)? as i32))
            })
            .collect::<R<_>>()?,
        enhanced: boolean(v, "enhanced")?,
        source_x: opt_int(v, "sourceX")?,
        source_attack: int(v, "sourceAttack")?,
    })
}

fn feff_of(v: &Json) -> R<FEff> {
    match v.get("op") {
        Some(Json::Str(op)) if op.starts_with('_') => Ok(match op.as_str() {
            "_combat" => FEff::Combat {
                attacker: int(v, "attacker")?,
                target: match field(v, "target")? {
                    Json::Str(x) if x == "leader" => None,
                    _ => Some(int(v, "target")?),
                },
            },
            "_combatEnd" => FEff::CombatEnd,
            "_endTurn" => FEff::EndTurn,
            "_cleanup" => FEff::Cleanup,
            "_startTurn" => FEff::StartTurn,
            "_startTurnDraw" => FEff::StartTurnDraw,
            "_finishMulligan" => FEff::FinishMulligan,
            _ => return Err(format!("未知のエンジン内部の処理: {op}")),
        }),
        _ => effect_from(v).map(FEff::Dsl),
    }
}

/// TypeScript 版の GameState の形の JSON から局面を作る
pub fn state_from_json(v: &Json) -> R<GameState> {
    let players = array(v, "players")?;
    if players.len() != 2 {
        return Err("\"players\" は 2 人".into());
    }
    Ok(GameState {
        phase: match string(v, "phase")? {
            "mulligan" => Phase::Mulligan,
            "main" => Phase::Main,
            "ended" => Phase::Ended,
            p => return Err(format!("未知のフェイズ: {p}")),
        },
        players: [player_of(&players[0])?, player_of(&players[1])?],
        first: player_index(v, "first")?,
        active: player_index(v, "active")?,
        turn: int(v, "turn")?,
        winner: match field(v, "winner")? {
            Json::Null => None,
            _ => Some(player_index(v, "winner")?),
        },
        rng: u32::try_from(int_of("rng", field(v, "rng")?)?)
            .map_err(|_| "\"rng\" は 32 ビットの整数")?,
        next_iid: int(v, "nextIid")?,
        next_order: int(v, "nextOrder")?,
        stack: array(v, "stack")?
            .iter()
            .map(|f| {
                Ok(Frame {
                    effects: Effects::List(
                        array(f, "effects")?.iter().map(feff_of).collect::<R<_>>()?,
                    ),
                    pc: uint(f, "pc")?,
                    ctx: ctx_of(field(f, "ctx")?)?,
                })
            })
            .collect::<R<_>>()?,
        queue: array(v, "queue")?
            .iter()
            .map(|q| {
                Ok(Queued {
                    ability: ability_from(field(q, "ability")?)?,
                    ctx: ctx_of(field(q, "ctx")?)?,
                })
            })
            .collect::<R<VecDeque<_>>>()?,
        pending: match field(v, "pending")? {
            Json::Null => None,
            p => Some(match string(p, "kind")? {
                "choose" => Pending::Choose {
                    player: player_index(p, "player")?,
                    slot: slot_of(string(p, "slot")?)?,
                    candidates: iid_list(p, "candidates")?,
                    count: uint(p, "count")?,
                },
                "mode" => Pending::Mode {
                    player: player_index(p, "player")?,
                    options: uint(p, "options")?,
                },
                k => return Err(format!("未知の選択待ち: {k}")),
            }),
        },
        attack: match field(v, "attack")? {
            Json::Null => None,
            a => Some(AttackInProgress {
                attacker: int(a, "attacker")?,
                defender: int(a, "defender")?,
                super_evolved: boolean(a, "superEvolved")?,
                defender_destroyed: boolean(a, "defenderDestroyed")?,
            }),
        },
    })
}

/// TypeScript 版の Action の形の JSON から行動を作る
pub fn action_from_json(v: &Json) -> R<Action> {
    Ok(match string(v, "type")? {
        "mulligan" => Action::Mulligan {
            player: player_index(v, "player")?,
            swap: iid_list(v, "swap")?,
        },
        "play" => Action::Play(int(v, "iid")?),
        "attack" => Action::Attack {
            attacker: int(v, "attacker")?,
            target: match field(v, "target")? {
                Json::Str(x) if x == "leader" => None,
                _ => Some(int(v, "target")?),
            },
        },
        "evolve" => Action::Evolve(int(v, "iid")?),
        "superEvolve" => Action::SuperEvolve(int(v, "iid")?),
        "act" => Action::Act(int(v, "iid")?),
        "fuse" => Action::Fuse {
            host: int(v, "host")?,
            materials: iid_list(v, "materials")?,
        },
        "extraPp" => Action::ExtraPp,
        "choose" => Action::Choose(iid_list(v, "targets")?),
        "mode" => Action::Mode(uint(v, "index")?),
        "endTurn" => Action::EndTurn,
        t => return Err(format!("未知の行動: {t}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::state_canon;
    use crate::sim::play_random;

    /// ランダムな対戦の毎手番で、書き出して読み込むと同じ局面に戻る（能力の DSL を含む局面も通ること）
    #[test]
    fn round_trip() {
        let mut seen = [0usize; 6];
        for g in 0..400 {
            play_random(g, g % 2 == 1, |_, s, _| {
                let j = state_to_json(s);
                let back = state_from_json(&Json::parse(&j.stringify()).unwrap()).unwrap();
                assert_eq!(state_canon(&back), state_canon(s), "試合 {g}");
                assert_eq!(state_to_json(&back).canonical(), j.canonical(), "試合 {g}");
                let any_board =
                    |f: &dyn Fn(&OnBoard) -> bool| s.players.iter().any(|p| p.board.iter().any(f));
                let counts = [
                    !s.stack.is_empty(),
                    !s.queue.is_empty(),
                    any_board(&|b| !b.granted.is_empty()),
                    s.stack.iter().any(|f| !f.ctx.vars.is_empty()),
                    s.stack.iter().any(|f| !f.ctx.slots.is_empty()),
                    s.players
                        .iter()
                        .any(|p| p.hand.iter().any(|h| h.drawn_by.is_some())),
                ];
                for (n, c) in seen.iter_mut().zip(counts) {
                    *n += c as usize;
                }
            });
        }
        eprintln!("解決スタック・誘発待ち・付与された能力・変数・スロット・引いた条件のある局面: {seen:?}");
        // 選択待ちの局面で変数を持つ文脈はまだ現れない（変数は選択を挟まずに使い切る能力だけ）
        assert!(
            seen.iter().enumerate().all(|(i, &n)| i == 3 || n > 0),
            "試していない形があります: {seen:?}"
        );
    }

    #[test]
    fn actions() {
        for text in [
            r#"{"type":"mulligan","player":1,"swap":[3,5]}"#,
            r#"{"type":"attack","attacker":7,"target":"leader"}"#,
            r#"{"type":"attack","attacker":7,"target":12}"#,
            r#"{"type":"fuse","host":4,"materials":[8,9]}"#,
            r#"{"type":"choose","targets":[]}"#,
            r#"{"type":"mode","index":1}"#,
            r#"{"type":"endTurn"}"#,
        ] {
            let a = action_from_json(&Json::parse(text).unwrap()).unwrap();
            assert_eq!(action_to_json(&a).stringify(), text);
        }
    }
}
