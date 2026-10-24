//! 環境（デッキと使用率）のアジャスト合戦を自動で回す。docs/ai-notes.md「環境を自動で回す」
//!
//!   svwb meta init --out 環境.json [--decks <デッキ>,…] [--usage class|uniform]
//!   svwb meta round --state 環境.json [--out 次.json] [--classes witch,bishop] [--games 30] [--draw 1]
//!                   [--stages 150:10,450:3] [--confirm 1200] [--zmin 2] [--eta 1] [--minUsage 0.02]
//!                   [--pool <カード>,…] [--net 補正.json] [--report 記録.md] [--jsonl 試合.jsonl]
//!   svwb meta export --state 環境.json --dir <フォルダ> [--top 1]
//!   svwb meta show --state 環境.json
//!
//! - **init:** 環境（デッキ・使用率）のファイルを作る。既定は比較用の 7 デッキ。`--decks` にはデフォルトデッキの名前か、
//!   デッキのテキストファイル（deck-compare の `--file` と同じ形式）を並べる。使用率は既定でクラスごとに 1/7 を、そのクラスのデッキで等分する
//!   （`--usage uniform` ならデッキごとに等分）。ファイルのデッキは、同じクラスのデフォルトデッキと 30 枚以上同じならそれを元にする
//!   （マリガンはそのデッキのモデルで行い、リノセウスエルフならリノセウス用 AI で打つ。元が無ければ返し方ごとに引き直しを試して選ぶ）
//! - **round:** 1 回り。
//!   1. 総当たり: 環境のデッキの全組を両方の席で `--games` 試合ずつ打ち、使用率で重みを付けた勝率（全体）を出す。
//!      各試合で、両方の席について確率 `--draw` で「引いた瞬間に抜く」介入をする（td selfplay `--ivZone drawn` と同じ選び方で
//!      ターンを 1〜10 から選び、そのターンの始めに引いたカードを 1 枚手札から消して最後まで打つ）。
//!      カードの価値（もとの試合の勝敗 − 消した試合の勝敗）はデッキごとに環境のファイルに足していく
//!   2. 使用率: 全体の勝率に比例して更新する（u ← u × (2 × 全体)^eta、合計 1 に直す）。`--minUsage` 未満のデッキは環境から外す（クラスで一番のデッキは残す）
//!   3. 案: クラスごとに、使用率が一番のデッキについて、クラスとニュートラルの各カード Y を 2 枚（3 枚を超えるなら入るだけ）足し、
//!      引いた瞬間の価値の低いカード（2 枚以上入っているもの。1 枚ずつ抜くので、どのカードも 0 枚にはならない）を同じ枚数抜く案を作る。
//!      価値は少ない試合ほどデッキの平均に寄せる（20 回分）。`--pool` なら足すカードをそれだけにする
//!   4. ふるい: 更新した使用率に比例して相手を割り当てた試合（両方の席）を、元のデッキと全部の案で打つ（シードは同じ）。
//!      `--stages 150:10,450:3` なら、150 試合打って元のデッキとの差の上位 10 案を残し、さらに 450 試合（新しい試合番号）を足して上位 3 案を残す
//!   5. 確かめ: 残った案と元のデッキを新しい試合番号で `--confirm` 試合打ち、元のデッキに z ≥ `--zmin` で勝つ案のうち差の一番大きいものを採る。
//!      採った案が元のデッキに替わる（使用率はそのまま）。ふるいで上位を選んだぶれ（勝者の呪い）は、確かめを別の試合で行うことで除く
//!   - 試合番号は環境のファイルの `nextG` から順に使い、回りごと・段ごとに新しくする（シードは 5000000 + 試合番号 × 13 + 席。他のランナーと重ならない）
//!   - AI は deck-compare と同じ（どちらの側も今の既定。`--net` ならどちらの側も学習した補正をそのファイルのものに替える）
//!   - 回りのまとめを `--report` に（Markdown で）書き足し、試合ごとの結果を `--jsonl` に書き足す
//! - **export:** 環境のデッキをテキストファイル（`<key>.txt`）に書き出し、カンマで並べたパスを出す（td selfplay `--decks` に渡す。補正の学び直し用）。
//!   `--top 1` なら、クラスごとに使用率が一番のデッキだけ（クラスの順。compare `--decks` に渡す）
//! - **show:** 環境のデッキ・使用率・入れ替えの履歴を出す

use super::deck_compare::{
    apply_changes, changes_label, check_deck, deck_class, find_card, find_deck, load_deck,
    subject_agent, Entry, MAX_COPIES, RHINO_DECK,
};
use super::options::model_eval;
use super::parallel::parallel_map;
use super::{compare_decks, fixed, seconds_since};
use crate::ai::exact_lethal::reset_exact_lethal_cache;
use crate::ai::search::ExtraEval;
use crate::ai::valuenet::ValueNet;
use crate::ai::{Agent, Rng};
use crate::data::{data, CardIdx, ClassId};
use crate::game::{acting_player, apply_action, create_game, legal_actions};
use crate::state::{card, GameState, Iid, Phase, PlayerIndex};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::Arc;
use std::time::Instant;

/// シードの基準（compare・deck-compare・td selfplay の試合と重ならないように大きくする）
const SEED_BASE: u32 = 5_000_000;
const STATE_VERSION: u32 = 1;
/// ファイルのデッキを、同じクラスのデフォルトデッキを元にしたものと見なす同じカードの枚数
const BASE_OVERLAP: usize = 30;
/// 引いた瞬間の価値を、デッキの平均に寄せる重み（介入の回数）
const SHRINK: f64 = 20.0;
/// 1 案で足す枚数
const ADD_COPIES: usize = 2;

const CLASSES: [(ClassId, &str); 7] = [
    (ClassId::Elf, "エルフ"),
    (ClassId::Royal, "ロイヤル"),
    (ClassId::Witch, "ウィッチ"),
    (ClassId::Dragon, "ドラゴン"),
    (ClassId::Nightmare, "ナイトメア"),
    (ClassId::Bishop, "ビショップ"),
    (ClassId::Nemesis, "ネメシス"),
];

fn class_label(c: ClassId) -> &'static str {
    CLASSES
        .iter()
        .find(|x| x.0 == c)
        .map(|x| x.1)
        .unwrap_or("ニュートラル")
}

fn parse_class(s: &str) -> Result<ClassId, String> {
    CLASSES
        .iter()
        .find(|(c, ja)| c.name() == s || *ja == s)
        .map(|x| x.0)
        .ok_or_else(|| {
            format!(
                "クラスがありません: {s}（elf・royal・witch・dragon・nightmare・bishop・nemesis）"
            )
        })
}

// ---- 環境のファイル ----

/// 環境のデッキ 1 つ
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MetaDeck {
    key: String,
    name: String,
    class: String,
    /// 元にしたデフォルトデッキ（マリガンのモデルとリノセウス用 AI に使う）
    #[serde(default)]
    base: Option<String>,
    usage: f64,
    /// 採った入れ替えの数
    #[serde(default)]
    rev: u32,
    /// カード ID（並びも保つ）
    cards: Vec<String>,
    #[serde(default)]
    history: Vec<String>,
    /// カード ID ごとの引いた瞬間に抜く介入の [回数, 価値の合計]
    #[serde(default)]
    drawn: BTreeMap<String, [f64; 2]>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FieldRow {
    key: String,
    name: String,
    usage_before: f64,
    /// 使用率で重みを付けた勝率（総当たりをしなかった回りは null）
    win: Option<f64>,
    /// 外したデッキは 0
    usage_after: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Adopted {
    key: String,
    changes: String,
    /// 確かめの試合での元のデッキとの勝率の差（ポイント）と z
    diff: f64,
    z: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoundSummary {
    round: u32,
    g_start: u32,
    g_end: u32,
    net: Option<String>,
    field: Vec<FieldRow>,
    adopted: Vec<Adopted>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MetaState {
    version: u32,
    /// 済んだ回りの数
    round: u32,
    /// 次に使う試合番号
    next_g: u32,
    next_key: u32,
    decks: Vec<MetaDeck>,
    #[serde(default)]
    rounds: Vec<RoundSummary>,
}

impl MetaDeck {
    fn label(&self) -> String {
        if self.rev > 0 {
            format!("{} 改{}", self.name, self.rev)
        } else {
            self.name.clone()
        }
    }

    fn card_idx(&self) -> Result<Vec<CardIdx>, String> {
        self.cards
            .iter()
            .map(|id| find_card(id).map_err(|e| format!("{}: {e}", self.key)))
            .collect()
    }

    fn class_id(&self) -> Result<ClassId, String> {
        Ok(deck_class(&self.card_idx()?))
    }

    /// 打つときの設定（deck-compare の比べるデッキと同じ）
    fn entry(&self) -> Result<Entry, String> {
        let cards = self.card_idx()?;
        check_deck(&cards, deck_class(&cards)).map_err(|e| format!("{}: {e}", self.key))?;
        let base: Option<&'static str> = match &self.base {
            None => None,
            Some(b) => Some(find_deck(b)?.name.as_str()),
        };
        Ok(Entry {
            label: self.label(),
            cards,
            rhino: base == Some(RHINO_DECK),
            mulligan_as: base,
        })
    }
}

fn read_state(path: &str) -> Result<MetaState, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path} が読めません: {e}"))?;
    let st: MetaState =
        serde_json::from_str(&text).map_err(|e| format!("{path} の形が違います: {e}"))?;
    if st.version != STATE_VERSION {
        return Err(format!(
            "{path}: 版 {} には対応していません（{STATE_VERSION}）",
            st.version
        ));
    }
    for d in &st.decks {
        d.entry()?;
    }
    Ok(st)
}

fn write_state(path: &str, st: &MetaState) -> Result<(), String> {
    let text = serde_json::to_string_pretty(st).map_err(|e| e.to_string())? + "\n";
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("{tmp} に書けません: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{path} に書けません: {e}"))
}

fn append(path: &str, text: &str) -> Result<(), String> {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("{path} に書けません: {e}"))?;
    f.write_all(text.as_bytes())
        .map_err(|e| format!("{path} に書けません: {e}"))
}

/// 2 つのデッキで同じカードの枚数
fn overlap(a: &[CardIdx], b: &[CardIdx]) -> usize {
    let mut rest = b.to_vec();
    let mut n = 0;
    for c in a {
        if let Some(i) = rest.iter().position(|x| x == c) {
            rest.swap_remove(i);
            n += 1;
        }
    }
    n
}

/// ファイルのデッキの元にするデフォルトデッキ（同じクラスで BASE_OVERLAP 枚以上同じもののうち一番近いもの）
fn detect_base(cards: &[CardIdx]) -> Option<&'static str> {
    let class = deck_class(cards);
    let mut best: Option<(usize, &'static str)> = None;
    for d in &data().decks {
        if deck_class(&d.cards) != class {
            continue;
        }
        let o = overlap(cards, &d.cards);
        if o >= BASE_OVERLAP && best.is_none_or(|(b, _)| o > b) {
            best = Some((o, d.name.as_str()));
        }
    }
    best.map(|x| x.1)
}

fn new_state(decks: &[String], by_class: bool) -> Result<MetaState, String> {
    let mut out: Vec<MetaDeck> = Vec::new();
    for (i, name) in decks.iter().enumerate() {
        let d = load_deck(name)?;
        let base = d.default.or_else(|| detect_base(&d.cards));
        let class = deck_class(&d.cards);
        out.push(MetaDeck {
            key: format!("d{i}"),
            name: d.name.clone(),
            class: class.name().to_string(),
            base: base.map(|b| b.to_string()),
            usage: 0.0,
            rev: 0,
            cards: d.cards.iter().map(|&c| card(c).id.clone()).collect(),
            history: Vec::new(),
            drawn: BTreeMap::new(),
        });
    }
    if out.is_empty() {
        return Err("デッキがありません".into());
    }
    let classes: Vec<String> = {
        let mut v: Vec<String> = out.iter().map(|d| d.class.clone()).collect();
        v.sort();
        v.dedup();
        v
    };
    let n = out.len() as f64;
    for i in 0..out.len() {
        out[i].usage = if by_class {
            let same = out.iter().filter(|d| d.class == out[i].class).count() as f64;
            1.0 / classes.len() as f64 / same
        } else {
            1.0 / n
        };
    }
    Ok(MetaState {
        version: STATE_VERSION,
        round: 0,
        next_g: 0,
        next_key: out.len() as u32,
        decks: out,
        rounds: Vec::new(),
    })
}

// ---- 試合 ----

/// 引いた瞬間に抜く介入 1 つの結果
#[derive(Clone, Debug, PartialEq)]
struct Drawn {
    side: PlayerIndex,
    turn: i32,
    card: CardIdx,
    /// もとの試合の勝敗 − 消した試合の勝敗（side から見て。-1・0・1）
    value: i32,
}

#[derive(Clone, Debug, PartialEq)]
struct GameOut {
    winner: PlayerIndex,
    drawn: Vec<Drawn>,
}

type MakeAgent<'a> = &'a (dyn Fn(PlayerIndex) -> Box<dyn Agent> + Sync);

/// 介入するターン（1〜10。1 ターン目は手札のどれでも選べるので 5 倍の重み。td selfplay --ivZone drawn と同じ）
fn draw_turn(rng: &mut Rng) -> i32 {
    let r = rng.int(14) as i32;
    if r < 5 {
        1
    } else {
        r - 3
    }
}

/// 局面から最後まで打った勝者
fn finish(make: MakeAgent, mut s: GameState, seed: u32) -> PlayerIndex {
    reset_exact_lethal_cache();
    let mut agents = [make(0), make(1)];
    let mut rng = Rng::new(seed);
    let mut n = 0;
    while s.phase != Phase::Ended {
        n += 1;
        assert!(
            n <= 10000,
            "アクション数が上限を超えました（介入、シード {seed}）"
        );
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        let a = agents[actor].choose_action(&s, &legal, &mut rng);
        s = apply_action(&s, &a);
    }
    s.winner
        .unwrap_or_else(|| panic!("勝者がいません（介入、シード {seed}）"))
}

/// 1 試合（AI の乱数は play_match と同じくシードから作る）。draw_turns[p] があれば、p のそのターンの始めに引いたカードを
/// 1 枚消した局面からも最後まで打つ
fn play_game(
    make: MakeAgent,
    decks: [&[CardIdx]; 2],
    seed: u32,
    draw_turns: [Option<i32>; 2],
) -> GameOut {
    reset_exact_lethal_cache();
    let mut agents = [make(0), make(1)];
    let mut s = create_game(decks, seed);
    let mut rng = Rng::new(seed ^ 0x9e3779b9);
    // 介入する側の、相手のターンの間の山札（ターンの始めに引いたカードを見分ける）
    let mut pre_deck: [Vec<Iid>; 2] = [Vec::new(), Vec::new()];
    let mut seen = [-1, -1];
    let mut branches: [Option<(GameState, Vec<usize>)>; 2] = [None, None];
    let mut n = 0;
    while s.phase != Phase::Ended {
        n += 1;
        assert!(
            n <= 10000,
            "アクション数が上限 10000 を超えました（シード {seed}）"
        );
        for p in 0..2 {
            if draw_turns[p].is_some() && branches[p].is_none() && s.active != p {
                pre_deck[p].clear();
                pre_deck[p].extend(s.players[p].deck.iter().map(|r| r.iid));
            }
        }
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        if s.phase == Phase::Main
            && s.pending.is_none()
            && s.active == actor
            && seen[actor] != s.players[actor].turn_count
        {
            seen[actor] = s.players[actor].turn_count;
            if draw_turns[actor] == Some(seen[actor]) && s.stack.is_empty() && s.queue.is_empty() {
                let pl = &s.players[actor];
                let idx: Vec<usize> = pl
                    .hand
                    .iter()
                    .enumerate()
                    .filter(|(_, h)| pl.turn_count == 1 || pre_deck[actor].contains(&h.iid))
                    .map(|(i, _)| i)
                    .collect();
                if !idx.is_empty() {
                    branches[actor] = Some((s.clone(), idx));
                }
            }
        }
        let a = agents[actor].choose_action(&s, &legal, &mut rng);
        s = apply_action(&s, &a);
    }
    let winner = s
        .winner
        .unwrap_or_else(|| panic!("勝者がいません（シード {seed}）"));
    let mut drawn = Vec::new();
    for (p, b) in branches.into_iter().enumerate() {
        let Some((mut at, idx)) = b else { continue };
        let mut pick = Rng::new(seed ^ 0x6a09e667 ^ (p as u32).wrapping_mul(0x01000193));
        let i = idx[pick.int(idx.len())];
        let removed = at.players[p].hand.make_mut().remove(i).card;
        let turn = at.players[p].turn_count;
        let w = finish(make, at, seed ^ 0x85ebca6b_u32.wrapping_add(p as u32));
        drawn.push(Drawn {
            side: p,
            turn,
            card: removed,
            value: i32::from(winner == p) - i32::from(w == p),
        });
    }
    GameOut { winner, drawn }
}

fn seed_of(g: u32, seat: usize) -> u32 {
    SEED_BASE
        .wrapping_add(g.wrapping_mul(13))
        .wrapping_add(seat as u32)
}

/// 試合番号 n 個を、使用率に比例して相手のデッキに割り当てる（系統抽出。使用率の大きい順に並ぶのではなく、添字の順）
fn assign_opponents(usage: &[f64], n: usize) -> Vec<usize> {
    let total: f64 = usage.iter().sum();
    let mut out = Vec::with_capacity(n);
    let mut j = 0;
    let mut cum = usage[0] / total;
    for k in 0..n {
        let x = (k as f64 + 0.5) / n as f64;
        while x > cum && j + 1 < usage.len() {
            j += 1;
            cum += usage[j] / total;
        }
        out.push(j);
    }
    out
}

// ---- 使用率 ----

/// 総当たりの勝率 m[i][j]（i が j に勝つ割合、m[i][i] = 0.5）から、使用率で重みを付けた勝率
fn field_win(m: &[Vec<f64>], usage: &[f64]) -> Vec<f64> {
    let total: f64 = usage.iter().sum();
    m.iter()
        .map(|row| row.iter().zip(usage).map(|(w, u)| w * u).sum::<f64>() / total)
        .collect()
}

/// 使用率を全体の勝率に比例して更新する（u × (2 × 全体)^eta）。min 未満は 0 にする（クラスで一番のデッキは残す）。合計 1 に直す
fn update_usage(usage: &[f64], win: &[f64], class: &[ClassId], eta: f64, min: f64) -> Vec<f64> {
    let norm = |v: &mut Vec<f64>| {
        let t: f64 = v.iter().sum();
        if t > 0.0 {
            for x in v.iter_mut() {
                *x /= t;
            }
        }
    };
    let mut u: Vec<f64> = usage
        .iter()
        .zip(win)
        .map(|(u, w)| u * (2.0 * w).powf(eta))
        .collect();
    norm(&mut u);
    let top: Vec<bool> = (0..u.len())
        .map(|i| {
            (0..u.len())
                .filter(|&j| class[j] == class[i])
                .all(|j| u[j] < u[i] || (u[j] == u[i] && j >= i))
        })
        .collect();
    for i in 0..u.len() {
        if u[i] < min && !top[i] {
            u[i] = 0.0;
        }
    }
    norm(&mut u);
    u
}

// ---- 案 ----

/// 抜くカードの順（引いた瞬間の価値の低い順。2 枚以上入っているカードだけ）。(カード, 寄せた価値, 回数)
fn cut_order(d: &MetaDeck, cards: &[CardIdx]) -> Vec<(CardIdx, f64, f64)> {
    let (n_all, s_all) = d
        .drawn
        .iter()
        .filter(|(id, _)| cards.iter().any(|&c| card(c).id == **id))
        .fold((0.0, 0.0), |(n, s), (_, v)| (n + v[0], s + v[1]));
    let mean = if n_all > 0.0 { s_all / n_all } else { 0.0 };
    let mut seen: Vec<CardIdx> = Vec::new();
    let mut out = Vec::new();
    for &c in cards {
        if seen.contains(&c) {
            continue;
        }
        seen.push(c);
        if cards.iter().filter(|&&x| x == c).count() < 2 {
            continue;
        }
        let [n, s] = d.drawn.get(&card(c).id).copied().unwrap_or([0.0, 0.0]);
        out.push((c, (s + SHRINK * mean) / (n + SHRINK), n));
    }
    out.sort_by(|a, b| a.1.total_cmp(&b.1));
    out
}

/// 足すカード Y ごとの案（変更）。Y はクラスとニュートラルのカード（pool があればそれだけ）で、3 枚未満のもの
fn candidates(
    cards: &[CardIdx],
    cuts: &[(CardIdx, f64, f64)],
    pool: Option<&[CardIdx]>,
) -> Vec<Vec<(CardIdx, i32)>> {
    let class = deck_class(cards);
    let mut out = Vec::new();
    for (i, c) in data().cards.iter().enumerate() {
        let y = i as CardIdx;
        if c.token || (c.class != class && c.class != ClassId::Neutral) {
            continue;
        }
        if pool.is_some_and(|p| !p.contains(&y)) {
            continue;
        }
        let have = cards.iter().filter(|&&x| x == y).count();
        if have >= MAX_COPIES {
            continue;
        }
        let k = ADD_COPIES.min(MAX_COPIES - have);
        let cut: Vec<CardIdx> = cuts
            .iter()
            .map(|x| x.0)
            .filter(|&x| x != y)
            .take(k)
            .collect();
        if cut.len() < k {
            continue;
        }
        let mut ch: Vec<(CardIdx, i32)> = cut.into_iter().map(|x| (x, -1)).collect();
        ch.push((y, k as i32));
        out.push(ch);
    }
    out
}

/// 比べた結果（元のデッキと同じ試合での入れ替わり）
#[derive(Clone, Default, Debug)]
struct Score {
    games: u32,
    wins: u32,
    up: u32,
    down: u32,
}

impl Score {
    fn rate(&self) -> f64 {
        self.wins as f64 / self.games.max(1) as f64
    }
    /// 元のデッキとの勝率の差
    fn diff(&self) -> f64 {
        (self.up as f64 - self.down as f64) / self.games.max(1) as f64
    }
    fn z(&self) -> f64 {
        (self.up as f64 - self.down as f64) / ((self.up + self.down) as f64).sqrt().max(1.0)
    }
}

/// クラス 1 つの探し方
struct ClassPlan {
    class: ClassId,
    /// 環境の添字
    base: usize,
    key: String,
    cuts: Vec<(CardIdx, f64, f64)>,
    /// 0 が元のデッキ、1 から案
    entries: Vec<Entry>,
    changes: Vec<Vec<(CardIdx, i32)>>,
    /// ふるいの成績（段を足していく）
    sieve: Vec<Score>,
    /// 残っている案（entries の添字。元のデッキは含めない）
    alive: Vec<usize>,
    confirm: Vec<Score>,
}

struct SieveTask {
    plan: usize,
    entry: usize,
    k: usize,
    seat: usize,
}

/// 各クラスの残っている案と元のデッキを、試合番号 g0..g0+opp_of.len() で打つ（試合番号 g0+k の相手は field[opp_of[k]]）。
/// 戻りはクラスごとの [entry][k*2+seat] の勝ち
#[allow(clippy::too_many_arguments)]
fn play_block(
    plans: &[ClassPlan],
    field: &[Entry],
    opp_keys: &[String],
    opp_of: &[usize],
    g0: u32,
    net: Option<&ExtraEval>,
    what: &str,
    jsonl: &mut Vec<String>,
    round: u32,
) -> Vec<Vec<Vec<bool>>> {
    let mut tasks: Vec<SieveTask> = Vec::new();
    for (pi, p) in plans.iter().enumerate() {
        for entry in std::iter::once(0).chain(p.alive.iter().copied()) {
            for k in 0..opp_of.len() {
                for seat in 0..2 {
                    tasks.push(SieveTask {
                        plan: pi,
                        entry,
                        k,
                        seat,
                    });
                }
            }
        }
    }
    let t0 = Instant::now();
    let step = (tasks.len() / 10).max(1);
    let results = parallel_map(
        &tasks,
        |t, _| {
            let me = &plans[t.plan].entries[t.entry];
            let opp = &field[opp_of[t.k]];
            let make = |p: PlayerIndex| -> Box<dyn Agent> {
                subject_agent(if p == t.seat { me } else { opp }, net)
            };
            let decks: [&[CardIdx]; 2] = if t.seat == 0 {
                [&me.cards, &opp.cards]
            } else {
                [&opp.cards, &me.cards]
            };
            play_game(&make, decks, seed_of(g0 + t.k as u32, t.seat), [None, None]).winner == t.seat
        },
        |done, total, _, _| {
            if done % step == 0 || done == total {
                eprintln!(
                    "{what}: {done}/{total} 試合 {}s/試合",
                    fixed(seconds_since(t0) / done as f64, 2)
                );
            }
        },
    );
    let mut out: Vec<Vec<Vec<bool>>> = plans
        .iter()
        .map(|p| vec![Vec::new(); p.entries.len()])
        .collect();
    for (t, &w) in tasks.iter().zip(&results) {
        out[t.plan][t.entry].push(w);
        let p = &plans[t.plan];
        jsonl.push(
            serde_json::json!({
                "r": round,
                "phase": what,
                "class": p.class.name(),
                "deck": p.key,
                "variant": if t.entry == 0 { "元のデッキ".to_string() } else { changes_label(&p.changes[t.entry]) },
                "opp": opp_keys[opp_of[t.k]],
                "g": g0 + t.k as u32,
                "seat": t.seat,
                "won": w,
            })
            .to_string(),
        );
    }
    out
}

/// 元のデッキ（添字 0）との比べを score に足す
fn add_scores(score: &mut [Score], wins: &[Vec<bool>], entries: impl Iterator<Item = usize>) {
    let base = wins[0].clone();
    score[0].games += base.len() as u32;
    score[0].wins += base.iter().filter(|&&w| w).count() as u32;
    for e in entries {
        let s = &mut score[e];
        for (&v, &b) in wins[e].iter().zip(&base) {
            s.games += 1;
            s.wins += u32::from(v);
            s.up += u32::from(v && !b);
            s.down += u32::from(!v && b);
        }
    }
}

fn pct(x: f64) -> String {
    fixed(x * 100.0, 1)
}

fn signed(x: f64, f: usize) -> String {
    format!("{}{}", if x >= 0.0 { "+" } else { "" }, fixed(x, f))
}

// ---- コマンド ----

fn parse_args(argv: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let mut it = argv.iter();
    while let Some(k) = it.next() {
        let key = k
            .strip_prefix("--")
            .ok_or_else(|| format!("不明な引数: {k}"))?;
        let v = it.next().ok_or_else(|| format!("{k} の値がありません"))?;
        out.push((key.to_string(), v.clone()));
    }
    Ok(out)
}

struct Args(Vec<(String, String)>);

impl Args {
    fn get(&self, k: &str) -> Option<&str> {
        self.0
            .iter()
            .rev()
            .find(|(x, _)| x == k)
            .map(|(_, v)| v.as_str())
    }
    fn need(&self, k: &str) -> Result<&str, String> {
        self.get(k).ok_or_else(|| format!("--{k} がありません"))
    }
    fn num(&self, k: &str, def: f64) -> Result<f64, String> {
        match self.get(k) {
            None => Ok(def),
            Some(v) => v
                .parse::<f64>()
                .ok()
                .filter(|x| x.is_finite() && *x >= 0.0)
                .ok_or_else(|| format!("--{k} は 0 以上の数: {v}")),
        }
    }
    fn int(&self, k: &str, def: u32) -> Result<u32, String> {
        match self.get(k) {
            None => Ok(def),
            Some(v) => v
                .parse::<u32>()
                .map_err(|_| format!("--{k} は 0 以上の整数: {v}")),
        }
    }
    fn check(&self, known: &[&str]) -> Result<(), String> {
        match self.0.iter().find(|(k, _)| !known.contains(&k.as_str())) {
            Some((k, _)) => Err(format!("不明な引数: --{k}")),
            None => Ok(()),
        }
    }
}

fn list(v: &str) -> Vec<String> {
    v.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// "150:10,450:3" → [(150, 10), (450, 3)]（試合数は偶数に切り上げる）
fn parse_stages(v: &str) -> Result<Vec<(u32, usize)>, String> {
    let mut out = Vec::new();
    for item in list(v) {
        let (g, k) = item
            .split_once(':')
            .ok_or_else(|| format!("--stages は「試合数:残す数」をカンマで並べる: {item}"))?;
        let g: u32 = g
            .parse()
            .map_err(|_| format!("--stages の試合数が数ではありません: {item}"))?;
        let k: usize = k
            .parse()
            .map_err(|_| format!("--stages の残す数が数ではありません: {item}"))?;
        if g == 0 || k == 0 {
            return Err(format!("--stages の試合数と残す数は 1 以上: {item}"));
        }
        out.push((g.div_ceil(2) * 2, k));
    }
    Ok(out)
}

fn init(a: &Args) -> Result<(), String> {
    a.check(&["out", "decks", "usage"])?;
    let out = a.need("out")?;
    let decks: Vec<String> = match a.get("decks") {
        Some(v) => list(v),
        None => compare_decks().iter().map(|d| d.name.clone()).collect(),
    };
    let by_class = match a.get("usage").unwrap_or("class") {
        "class" => true,
        "uniform" => false,
        x => return Err(format!("--usage は class か uniform: {x}")),
    };
    let st = new_state(&decks, by_class)?;
    write_state(out, &st)?;
    print!("{}", show_text(&st));
    Ok(())
}

fn show_text(st: &MetaState) -> String {
    let mut s = format!(
        "環境（{} 回り済み、次の試合番号 {}）\n\n| key | デッキ | クラス | 元 | 使用率 | 入れ替え |\n| --- | --- | --- | --- | ---: | --- |\n",
        st.round, st.next_g
    );
    let mut order: Vec<&MetaDeck> = st.decks.iter().collect();
    order.sort_by(|a, b| b.usage.total_cmp(&a.usage));
    for d in order {
        let class = d.class_id().map(class_label).unwrap_or("?");
        s.push_str(&format!(
            "| {} | {} | {} | {} | {}% | {} |\n",
            d.key,
            d.label(),
            class,
            d.base.as_deref().unwrap_or("なし"),
            pct(d.usage),
            if d.history.is_empty() {
                "—".to_string()
            } else {
                d.history.join("<br>")
            }
        ));
    }
    s
}

fn show(a: &Args) -> Result<(), String> {
    a.check(&["state"])?;
    let st = read_state(a.need("state")?)?;
    print!("{}", show_text(&st));
    Ok(())
}

/// デッキのテキスト（同じカードが続くところを 1 行にするので、読み直すと同じ並びになる）
fn deck_text(d: &MetaDeck) -> Result<String, String> {
    let cards = d.card_idx()?;
    let mut s = format!("# 環境のデッキ {}（使用率 {}%）\n", d.key, pct(d.usage));
    for h in &d.history {
        s.push_str(&format!("# {h}\n"));
    }
    s.push_str(&format!("名前: {}\n", d.label()));
    let mut i = 0;
    while i < cards.len() {
        let mut j = i;
        while j < cards.len() && cards[j] == cards[i] {
            j += 1;
        }
        s.push_str(&format!("{} {}\n", j - i, card(cards[i]).name));
        i = j;
    }
    Ok(s)
}

/// クラスごとに使用率が一番のデッキ（環境の添字、クラスの順）
fn class_tops(st: &MetaState) -> Result<Vec<usize>, String> {
    let mut out = Vec::new();
    for (c, _) in CLASSES {
        let mut best: Option<usize> = None;
        for (i, d) in st.decks.iter().enumerate() {
            if d.class_id()? == c && best.is_none_or(|b| d.usage > st.decks[b].usage) {
                best = Some(i);
            }
        }
        out.extend(best);
    }
    Ok(out)
}

fn export(a: &Args) -> Result<(), String> {
    a.check(&["state", "dir", "top"])?;
    let st = read_state(a.need("state")?)?;
    let dir = a.need("dir")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{dir} を作れません: {e}"))?;
    let which: Vec<usize> = if a.int("top", 0)? > 0 {
        class_tops(&st)?
    } else {
        (0..st.decks.len()).collect()
    };
    let mut paths = Vec::new();
    for d in which.iter().map(|&i| &st.decks[i]) {
        let path = format!("{}/{}.txt", dir.trim_end_matches('/'), d.key);
        std::fs::write(&path, deck_text(d)?).map_err(|e| format!("{path} に書けません: {e}"))?;
        paths.push(path);
    }
    println!("{}", paths.join(","));
    Ok(())
}

fn round(a: &Args) -> Result<(), String> {
    a.check(&[
        "state", "out", "classes", "games", "draw", "stages", "confirm", "zmin", "eta", "minUsage",
        "pool", "net", "report", "jsonl",
    ])?;
    let state_path = a.need("state")?;
    let out_path = a.get("out").unwrap_or(state_path).to_string();
    let mut st = read_state(state_path)?;
    let games = a.int("games", 30)?;
    let draw = a.num("draw", 1.0)?.min(1.0);
    let stages = parse_stages(a.get("stages").unwrap_or("150:10,450:3"))?;
    let confirm = a.int("confirm", 1200)?.div_ceil(2) * 2;
    let zmin = a.num("zmin", 2.0)?;
    let eta = a.num("eta", 1.0)?;
    let min_usage = a.num("minUsage", 0.02)?;
    let only: Option<Vec<ClassId>> = a
        .get("classes")
        .map(|v| list(v).iter().map(|c| parse_class(c)).collect())
        .transpose()?;
    let pool: Option<Vec<CardIdx>> = a
        .get("pool")
        .map(|v| list(v).iter().map(|c| find_card(c)).collect())
        .transpose()?;
    let net_path = a.get("net").map(|s| s.to_string());
    let net: Option<ExtraEval> = match &net_path {
        None => None,
        Some(path) => {
            let net = ValueNet::load(path)?;
            if !net.base_weights.is_empty() {
                return Err(format!(
                    "{path}: baseWeights のあるモデルには対応していません"
                ));
            }
            Some(model_eval(Arc::new(net)))
        }
    };
    let net = net.as_ref();
    let round = st.round + 1;
    let g_start = st.next_g;
    let mut g_next = g_start;
    let mut jsonl: Vec<String> = Vec::new();
    let t_round = Instant::now();

    // 環境
    let field: Vec<Entry> = st
        .decks
        .iter()
        .map(|d| d.entry())
        .collect::<Result<_, _>>()?;
    let classes: Vec<ClassId> = field.iter().map(|e| deck_class(&e.cards)).collect();
    let keys: Vec<String> = st.decks.iter().map(|d| d.key.clone()).collect();
    let usage0: Vec<f64> = st.decks.iter().map(|d| d.usage).collect();
    let nf = field.len();
    let mut rep = format!(
        "## 回り {round}\n\n- 補正: {}\n- 試合番号 {g_start}〜（総当たり 1 組 {} 試合、ふるい {}、確かめ {confirm} 試合、z ≥ {}）\n",
        net_path.as_deref().unwrap_or("今の既定"),
        games * 2,
        stages
            .iter()
            .map(|(g, k)| format!("{g} 試合で上位 {k} 案"))
            .collect::<Vec<_>>()
            .join(" → "),
        fixed(zmin, 1)
    );

    // 1. 総当たり（と引いた瞬間に抜く介入）
    let mut win: Option<Vec<f64>> = None;
    if games > 0 && nf > 1 {
        struct MTask {
            a: usize,
            b: usize,
            g: u32,
            seat: usize,
        }
        let mut tasks = Vec::new();
        for i in 0..nf {
            for j in i + 1..nf {
                for g in g_next..g_next + games {
                    for seat in 0..2 {
                        tasks.push(MTask {
                            a: i,
                            b: j,
                            g,
                            seat,
                        });
                    }
                }
            }
        }
        g_next += games;
        eprintln!(
            "回り {round}: 総当たり {} デッキ・{} 試合（介入 {}）",
            nf,
            tasks.len(),
            fixed(draw, 2)
        );
        let t0 = Instant::now();
        let step = (tasks.len() / 10).max(1);
        let results = parallel_map(
            &tasks,
            |t, _| {
                // 席 seat が a
                let (x, y) = (&field[t.a], &field[t.b]);
                let make = |p: PlayerIndex| -> Box<dyn Agent> {
                    subject_agent(if p == t.seat { x } else { y }, net)
                };
                let decks: [&[CardIdx]; 2] = if t.seat == 0 {
                    [&x.cards, &y.cards]
                } else {
                    [&y.cards, &x.cards]
                };
                let seed = seed_of(t.g, t.seat);
                // 介入するかとターンは組ごとにも変える（試合のシードは組によらず試合番号と席で決まる）
                let mut r = Rng::new(
                    seed ^ 0x6a09e667 ^ ((t.a * 64 + t.b) as u32).wrapping_mul(0x9e3779b1),
                );
                let mut turns = [None, None];
                for t in turns.iter_mut() {
                    let take = r.int(1000) < (draw * 1000.0).round() as usize;
                    let turn = draw_turn(&mut r);
                    if take {
                        *t = Some(turn);
                    }
                }
                play_game(&make, decks, seed, turns)
            },
            |done, total, _, _| {
                if done % step == 0 || done == total {
                    eprintln!(
                        "総当たり: {done}/{total} 試合 {}s/試合",
                        fixed(seconds_since(t0) / done as f64, 2)
                    );
                }
            },
        );
        let mut wins = vec![vec![0u32; nf]; nf];
        let mut played = vec![vec![0u32; nf]; nf];
        let mut drawn_n = vec![0u32; nf];
        for (t, r) in tasks.iter().zip(&results) {
            let a_won = r.winner == t.seat;
            wins[t.a][t.b] += u32::from(a_won);
            wins[t.b][t.a] += u32::from(!a_won);
            played[t.a][t.b] += 1;
            played[t.b][t.a] += 1;
            for d in &r.drawn {
                let who = if d.side == t.seat { t.a } else { t.b };
                let e = st.decks[who]
                    .drawn
                    .entry(card(d.card).id.clone())
                    .or_insert([0.0, 0.0]);
                e[0] += 1.0;
                e[1] += d.value as f64;
                drawn_n[who] += 1;
            }
            jsonl.push(
                serde_json::json!({
                    "r": round,
                    "phase": "matrix",
                    "a": keys[t.a],
                    "b": keys[t.b],
                    "g": t.g,
                    "seat": t.seat,
                    "won": a_won,
                    "drawn": r.drawn.iter().map(|d| serde_json::json!({
                        "deck": keys[if d.side == t.seat { t.a } else { t.b }],
                        "turn": d.turn,
                        "card": card(d.card).id,
                        "v": d.value,
                    })).collect::<Vec<_>>(),
                })
                .to_string(),
            );
        }
        let m: Vec<Vec<f64>> = (0..nf)
            .map(|i| {
                (0..nf)
                    .map(|j| {
                        if i == j || played[i][j] == 0 {
                            0.5
                        } else {
                            wins[i][j] as f64 / played[i][j] as f64
                        }
                    })
                    .collect()
            })
            .collect();
        let w = field_win(&m, &usage0);
        // 表（全体の勝率の高い順）
        let mut order: Vec<usize> = (0..nf).collect();
        order.sort_by(|&i, &j| w[j].total_cmp(&w[i]));
        rep.push_str(&format!(
            "\n### 総当たり（1 マス {} 試合、全体は使用率で重みを付けた勝率）\n\n| key | デッキ | 使用率 | 全体 |",
            games * 2
        ));
        for &j in &order {
            rep.push_str(&format!(" {} |", keys[j]));
        }
        rep.push_str("\n| --- | --- | ---: | ---: |");
        rep.push_str(&" ---: |".repeat(nf));
        rep.push('\n');
        for &i in &order {
            rep.push_str(&format!(
                "| {} | {} | {}% | **{}%** |",
                keys[i],
                field[i].label,
                pct(usage0[i]),
                pct(w[i])
            ));
            for &j in &order {
                if i == j {
                    rep.push_str(" — |");
                } else {
                    rep.push_str(&format!(" {} |", pct(m[i][j])));
                }
            }
            rep.push('\n');
        }
        rep.push_str(&format!(
            "\n総当たり {} 試合・介入 {} 回、{} 分\n",
            tasks.len(),
            drawn_n.iter().sum::<u32>(),
            fixed(seconds_since(t0) / 60.0, 1)
        ));
        win = Some(w);
    }

    // 2. 使用率
    let usage1 = match &win {
        Some(w) => update_usage(&usage0, w, &classes, eta, min_usage),
        None => usage0.clone(),
    };
    let mut field_rows: Vec<FieldRow> = (0..nf)
        .map(|i| FieldRow {
            key: keys[i].clone(),
            name: field[i].label.clone(),
            usage_before: usage0[i],
            win: win.as_ref().map(|w| w[i]),
            usage_after: usage1[i],
        })
        .collect();
    field_rows.sort_by(|a, b| b.usage_after.total_cmp(&a.usage_after));
    rep.push_str(&format!(
        "\n### 使用率（u × (2 × 全体)^{}、{}% 未満は外す）\n\n| key | デッキ | 全体 | 使用率 |\n| --- | --- | ---: | --- |\n",
        fixed(eta, 2),
        pct(min_usage)
    ));
    for r in &field_rows {
        rep.push_str(&format!(
            "| {} | {} | {} | {}% → {} |\n",
            r.key,
            r.name,
            r.win.map(|w| format!("{}%", pct(w))).unwrap_or("—".into()),
            pct(r.usage_before),
            if r.usage_after > 0.0 {
                format!("{}%", pct(r.usage_after))
            } else {
                "外す".into()
            }
        ));
    }

    // 3. 案（クラスごとに使用率が一番のデッキ）
    let live: Vec<usize> = (0..nf).filter(|&i| usage1[i] > 0.0).collect();
    let live_usage: Vec<f64> = live.iter().map(|&i| usage1[i]).collect();
    let mut plans: Vec<ClassPlan> = Vec::new();
    for (c, _) in CLASSES {
        if only.as_ref().is_some_and(|o| !o.contains(&c)) {
            continue;
        }
        let Some(&base) = live
            .iter()
            .filter(|&&i| classes[i] == c)
            .max_by(|&&i, &&j| usage1[i].total_cmp(&usage1[j]).then(j.cmp(&i)))
        else {
            continue;
        };
        let d = &st.decks[base];
        let cards = field[base].cards.clone();
        let cuts = cut_order(d, &cards);
        let changes = candidates(&cards, &cuts, pool.as_deref());
        let mut entries = vec![d.entry()?];
        let mut all_changes = vec![Vec::new()];
        for ch in changes {
            let v = apply_changes(&cards, &ch)
                .map_err(|e| format!("{}: {}: {e}", d.key, changes_label(&ch)))?;
            entries.push(Entry {
                label: changes_label(&ch),
                cards: v,
                rhino: field[base].rhino,
                mulligan_as: field[base].mulligan_as,
            });
            all_changes.push(ch);
        }
        let n = entries.len();
        plans.push(ClassPlan {
            class: c,
            base,
            key: d.key.clone(),
            cuts,
            alive: (1..n).collect(),
            sieve: vec![Score::default(); n],
            confirm: vec![Score::default(); n],
            entries,
            changes: all_changes,
        });
    }
    let field_live: Vec<Entry> = live
        .iter()
        .map(|&i| st.decks[i].entry())
        .collect::<Result<_, _>>()?;
    let keys_live: Vec<String> = live.iter().map(|&i| keys[i].clone()).collect();
    let mut est: u64 = 0;
    {
        let mut alive: Vec<usize> = plans.iter().map(|p| p.alive.len()).collect();
        for &(g, k) in &stages {
            est += alive
                .iter()
                .map(|&n| (n as u64 + 1) * g as u64)
                .sum::<u64>();
            alive.iter_mut().for_each(|n| *n = (*n).min(k));
        }
        est += alive
            .iter()
            .map(|&n| (n as u64 + 1) * confirm as u64)
            .sum::<u64>();
    }
    eprintln!(
        "回り {round}: {} クラス・案 {} 個、ふるいと確かめで {est} 試合ほど",
        plans.len(),
        plans.iter().map(|p| p.alive.len()).sum::<usize>()
    );

    // 4. ふるい
    for (si, &(g, keep)) in stages.iter().enumerate() {
        if plans.iter().all(|p| p.alive.is_empty()) {
            break;
        }
        let n = (g / 2) as usize;
        let opp_of = assign_opponents(&live_usage, n);
        let g0 = g_next;
        g_next += n as u32;
        let what = format!("s{}", si + 1);
        let wins = play_block(
            &plans,
            &field_live,
            &keys_live,
            &opp_of,
            g0,
            net,
            &what,
            &mut jsonl,
            round,
        );
        for (p, w) in plans.iter_mut().zip(&wins) {
            let alive = p.alive.clone();
            add_scores(&mut p.sieve, w, alive.into_iter());
            let s = &p.sieve;
            p.alive
                .sort_by(|&x, &y| s[y].diff().total_cmp(&s[x].diff()).then(x.cmp(&y)));
            p.alive.truncate(keep);
        }
    }

    // 5. 確かめ
    if confirm > 0 && plans.iter().any(|p| !p.alive.is_empty()) {
        let n = (confirm / 2) as usize;
        let opp_of = assign_opponents(&live_usage, n);
        let g0 = g_next;
        g_next += n as u32;
        let wins = play_block(
            &plans,
            &field_live,
            &keys_live,
            &opp_of,
            g0,
            net,
            "confirm",
            &mut jsonl,
            round,
        );
        for (p, w) in plans.iter_mut().zip(&wins) {
            let alive = p.alive.clone();
            add_scores(&mut p.confirm, w, alive.into_iter());
        }
    }

    // 6. 採る・記録
    let mut adopted: Vec<Adopted> = Vec::new();
    let mut new_decks: Vec<Option<MetaDeck>> = vec![None; nf];
    for p in &plans {
        let d = &st.decks[p.base];
        rep.push_str(&format!(
            "\n### {}: {}（使用率 {}%）\n\n",
            class_label(p.class),
            p.entries[0].label,
            pct(usage1[p.base])
        ));
        rep.push_str(&format!(
            "抜く順（引いた瞬間の価値、介入の回数）: {}\n\n",
            p.cuts
                .iter()
                .take(6)
                .map(|(c, v, n)| format!(
                    "{} {}%（{}）",
                    card(*c).name,
                    signed(v * 100.0, 1),
                    *n as u32
                ))
                .collect::<Vec<_>>()
                .join("、")
        ));
        let mut ranked: Vec<usize> = (1..p.entries.len()).collect();
        ranked.sort_by(|&x, &y| {
            p.sieve[y]
                .games
                .cmp(&p.sieve[x].games)
                .then(p.sieve[y].diff().total_cmp(&p.sieve[x].diff()))
        });
        rep.push_str(&format!(
            "ふるい（案 {} 個、元のデッキは {} 試合で {}%）\n\n| 案 | 試合 | 勝率 | 元との差 | z | 確かめ |\n| --- | ---: | ---: | ---: | ---: | --- |\n",
            p.entries.len() - 1,
            p.sieve[0].games,
            pct(p.sieve[0].rate())
        ));
        for &e in ranked.iter().take(15) {
            let s = &p.sieve[e];
            let c = &p.confirm[e];
            rep.push_str(&format!(
                "| {} | {} | {}% | {} | {} | {} |\n",
                p.entries[e].label,
                s.games,
                pct(s.rate()),
                signed(s.diff() * 100.0, 1),
                signed(s.z(), 1),
                if c.games > 0 {
                    format!(
                        "{}%（{}、z {}）",
                        pct(c.rate()),
                        signed(c.diff() * 100.0, 1),
                        signed(c.z(), 1)
                    )
                } else {
                    String::new()
                }
            ));
        }
        let best = p
            .alive
            .iter()
            .copied()
            .filter(|&e| p.confirm[e].games > 0 && p.confirm[e].z() >= zmin)
            .max_by(|&x, &y| {
                p.confirm[x]
                    .diff()
                    .total_cmp(&p.confirm[y].diff())
                    .then(y.cmp(&x))
            });
        if p.confirm[0].games > 0 {
            rep.push_str(&format!(
                "\n確かめ（新しい試合番号で {} 試合）: 元のデッキ {}%。",
                p.confirm[0].games,
                pct(p.confirm[0].rate())
            ));
        } else {
            rep.push('\n');
        }
        match best {
            None => rep.push_str("採る案なし\n"),
            Some(e) => {
                let c = &p.confirm[e];
                let label = changes_label(&p.changes[e]);
                rep.push_str(&format!(
                    "**採る: {label}**（{}、z {}）\n",
                    signed(c.diff() * 100.0, 1),
                    signed(c.z(), 1)
                ));
                let mut nd = d.clone();
                nd.rev += 1;
                nd.cards = p.entries[e]
                    .cards
                    .iter()
                    .map(|&x| card(x).id.clone())
                    .collect();
                nd.history.push(format!(
                    "r{round}: {label}（確かめ {} ポイント、z {}）",
                    signed(c.diff() * 100.0, 1),
                    signed(c.z(), 1)
                ));
                let ids = nd.cards.clone();
                nd.drawn.retain(|id, _| ids.contains(id));
                adopted.push(Adopted {
                    key: d.key.clone(),
                    changes: label,
                    diff: c.diff() * 100.0,
                    z: c.z(),
                });
                new_decks[p.base] = Some(nd);
            }
        }
    }

    // 環境を更新する
    let mut decks: Vec<MetaDeck> = Vec::new();
    for (i, d) in st.decks.iter().enumerate() {
        if usage1[i] <= 0.0 {
            continue;
        }
        let mut nd = new_decks[i].take().unwrap_or_else(|| d.clone());
        nd.usage = usage1[i];
        decks.push(nd);
    }
    st.decks = decks;
    st.round = round;
    st.next_g = g_next;
    st.rounds.push(RoundSummary {
        round,
        g_start,
        g_end: g_next,
        net: net_path.clone(),
        field: field_rows,
        adopted,
    });
    rep.push_str(&format!(
        "\n回り {round}: 試合番号 {g_start}〜{}、{} 分\n\n",
        g_next - 1,
        fixed(seconds_since(t_round) / 60.0, 1)
    ));
    write_state(&out_path, &st)?;
    print!("{rep}");
    if let Some(path) = a.get("report") {
        append(path, &rep)?;
    }
    if let Some(path) = a.get("jsonl") {
        let mut text = jsonl.join("\n");
        text.push('\n');
        append(path, &text)?;
    }
    Ok(())
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let sub = argv.first().map(|s| s.as_str());
    let a = Args(parse_args(argv.get(1..).unwrap_or(&[]))?);
    match sub {
        Some("init") => init(&a),
        Some("round") => round(&a),
        Some("export") => export(&a),
        Some("show") => show(&a),
        _ => Err("使い方: svwb meta init|round|export|show …（rust/engine/src/runner/meta.rs の先頭の説明）".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::RandomAgent;

    fn pool_file(name: &str) -> String {
        format!(
            "{}/td-pool/royal-counter/{name}.txt",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    fn witch_deck() -> MetaDeck {
        new_state(&["スペルウィッチ".to_string()], true)
            .unwrap()
            .decks
            .remove(0)
    }

    #[test]
    fn cuts_and_candidates_follow_rules() {
        let mut d = witch_deck();
        let cards = d.card_idx().unwrap();
        // 価値を付ける（添字の小さいカードほど低い）
        for (i, &c) in cards.iter().enumerate() {
            d.drawn
                .insert(card(c).id.clone(), [10.0, i as f64 * 0.1 - 1.0]);
        }
        let cuts = cut_order(&d, &cards);
        assert!(!cuts.is_empty());
        for w in cuts.windows(2) {
            assert!(w[0].1 <= w[1].1);
        }
        for (c, _, _) in &cuts {
            assert!(cards.iter().filter(|&x| x == c).count() >= 2);
        }
        let changes = candidates(&cards, &cuts, None);
        assert!(changes.len() > 20, "{}", changes.len());
        for ch in &changes {
            let v = apply_changes(&cards, ch).unwrap();
            let (adds, cutlist): (Vec<_>, Vec<_>) = ch.iter().partition(|x| x.1 > 0);
            assert_eq!(adds.len(), 1);
            let (y, k) = adds[0];
            assert!(k as usize <= ADD_COPIES);
            assert_eq!(cutlist.len(), k as usize);
            for &(x, n) in &cutlist {
                assert_eq!(n, -1);
                assert_ne!(x, y);
                // 1 枚ずつ抜くので、どのカードも 0 枚にならない
                assert!(v.contains(&x));
            }
            assert_eq!(
                v.iter().filter(|&&x| x == y).count(),
                cards.iter().filter(|&&x| x == y).count() + k as usize
            );
            // 抜くのは価値の低い順
            let first: Vec<CardIdx> = cuts
                .iter()
                .map(|x| x.0)
                .filter(|&x| x != y)
                .take(k as usize)
                .collect();
            assert_eq!(cutlist.iter().map(|x| x.0).collect::<Vec<_>>(), first);
        }
        // --pool なら足すカードはそれだけ
        let edel = find_card("理光の天宮・エーデルワイス").unwrap();
        let only = candidates(&cards, &cuts, Some(&[edel]));
        assert_eq!(only.len(), 1);
        assert_eq!(only[0].last(), Some(&(edel, 2)));
    }

    #[test]
    fn usage_follows_field_win_rate() {
        let m = vec![
            vec![0.5, 0.6, 0.4],
            vec![0.4, 0.5, 0.3],
            vec![0.6, 0.7, 0.5],
        ];
        let usage = [0.25, 0.25, 0.5];
        let w = field_win(&m, &usage);
        assert!((w[0] - (0.125 + 0.15 + 0.2)).abs() < 1e-12);
        // 使用率で重みを付けた平均は 0.5
        let avg: f64 = w.iter().zip(&usage).map(|(a, b)| a * b).sum();
        assert!((avg - 0.5).abs() < 1e-12);
        let class = [ClassId::Witch, ClassId::Witch, ClassId::Royal];
        let u = update_usage(&usage, &w, &class, 1.0, 0.0);
        for i in 0..3 {
            assert!((u[i] - usage[i] * 2.0 * w[i]).abs() < 1e-12);
        }
        // 外すのは min 未満で、クラスで一番でないものだけ
        let u = update_usage(&usage, &w, &class, 1.0, 0.3);
        assert!(u[0] > 0.0 && u[1] == 0.0 && u[2] > 0.0);
        assert!((u.iter().sum::<f64>() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn opponents_in_proportion_to_usage() {
        let opp = assign_opponents(&[0.5, 0.25, 0.25], 8);
        let count = |j| opp.iter().filter(|&&x| x == j).count();
        assert_eq!((count(0), count(1), count(2)), (4, 2, 2));
        assert_eq!(assign_opponents(&[0.2, 0.6, 0.2], 1), vec![1]);
    }

    #[test]
    fn state_round_trip_and_export() {
        let names = [
            "スペルウィッチ".to_string(),
            pool_file("witch-edel"),
            pool_file("nemesis-puredoll"),
            pool_file("elf-contact"),
        ];
        let st = new_state(&names, true).unwrap();
        let base: Vec<Option<&str>> = st.decks.iter().map(|d| d.base.as_deref()).collect();
        assert_eq!(
            base,
            [
                Some("スペルウィッチ"),
                Some("スペルウィッチ"),
                None,
                Some("リノセウスエルフ")
            ]
        );
        // クラスごとに 1/3、ウィッチは 2 つで等分
        assert!((st.decks[0].usage - 1.0 / 6.0).abs() < 1e-12);
        assert!((st.decks[2].usage - 1.0 / 3.0).abs() < 1e-12);
        let e = st.decks[3].entry().unwrap();
        assert!(e.rhino);
        assert_eq!(st.decks[2].entry().unwrap().mulligan_as, None);
        let text = serde_json::to_string_pretty(&st).unwrap();
        let back: MetaState = serde_json::from_str(&text).unwrap();
        assert_eq!(back, st);
        // 書き出したデッキを読み直すと同じ並び
        let dir = std::env::temp_dir().join(format!("svwb-meta-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for d in &st.decks {
            let path = dir.join(format!("{}.txt", d.key));
            std::fs::write(&path, deck_text(d).unwrap()).unwrap();
            let b = load_deck(path.to_str().unwrap()).unwrap();
            assert_eq!(b.cards, d.card_idx().unwrap());
            assert_eq!(b.name, d.label());
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn drawn_branches_are_deterministic() {
        let decks = [
            find_deck("スペルウィッチ").unwrap(),
            find_deck("AFネメシス").unwrap(),
        ];
        let make = |_: PlayerIndex| -> Box<dyn Agent> { Box::new(RandomAgent) };
        let mut seen_turns = 0;
        for g in 0..12 {
            let turns = [Some(1 + (g % 4) as i32), Some(1)];
            let r = play_game(
                &make,
                [&decks[0].cards, &decks[1].cards],
                seed_of(g, 0),
                turns,
            );
            assert_eq!(
                r,
                play_game(
                    &make,
                    [&decks[0].cards, &decks[1].cards],
                    seed_of(g, 0),
                    turns
                )
            );
            for d in &r.drawn {
                assert_eq!(Some(d.turn), turns[d.side]);
                assert!((-1..=1).contains(&d.value));
                assert!(decks[d.side].cards.contains(&d.card));
                seen_turns += 1;
            }
            // 介入しなければ同じ試合
            let plain = play_game(
                &make,
                [&decks[0].cards, &decks[1].cards],
                seed_of(g, 0),
                [None, None],
            );
            assert_eq!(plain.winner, r.winner);
            assert!(plain.drawn.is_empty());
        }
        assert!(seen_turns >= 12, "{seen_turns}");
    }
}
