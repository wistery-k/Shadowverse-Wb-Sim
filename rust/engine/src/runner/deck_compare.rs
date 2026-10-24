//! デッキのカードを入れ替えた案を、元のデッキと同じ試合で比べる（デッキの最適化）。
//!
//!   svwb deck-compare --deck <デッキ> [--variant '<変更>']… [--add <カード>[,<カード>…]] [--file <デッキ.txt>]…
//!                     [--vs <デッキ>[,<デッキ>…]] [--net <補正.json>] [--netSide both|subject] [--games 50] [--start 0] [--out 結果.jsonl]
//!
//! - 変更は「カード名-枚数」「カード名+枚数」をカンマで並べたもの（例: '知恵の輝き-1,最果ての罪・サタン+1'）。カード名の代わりにカード ID も使える。
//!   抜く枚数と足す枚数は同じにする（40 枚・同名 3 枚まで・クラスを確かめる）
//! - `--add Y` は、デッキの各カード X について「X を 1 枚抜いて Y を 1 枚足す」案をすべて作る（Y を入れるなら何を抜くか）
//! - 抜いたカードの位置に足したカードを置く。山札の並べ方は枚数と乱数だけで決まるので、同じシードなら山札の並びは入れ替えたカードの所だけが違う
//! - 元のデッキと各案は、比較用の 7 デッキのうち自分以外と、両方の席で `--games` 試合ずつ打つ（シードは案どうしで同じ）。
//!   `--vs` で相手のデッキを絞れる（デフォルトデッキならどれでも。元のデッキと同じデッキ・ランプドラゴンも可）
//! - `--deck` と `--file` には、デフォルトデッキのほかにデッキのテキストファイル（data/decks/*.txt と同じ形式）も渡せる。
//!   `--file` はデッキを丸ごと案にする（元のデッキと違うクラスでもよい。山札の並びの対応は無い）
//! - AI はどちらの側も今の既定（リノセウスエルフはリノセウス用 AI、他は探索 AI）。`--net` なら、どちらの側も学習した補正をそのファイルのものに替える
//!   （学び直した補正で、案と元のデッキを比べ直す用。`baseWeights` の無いモデルだけ）。`--netSide subject` なら、替えるのは比べるデッキ（元のデッキと案）の側だけで、
//!   相手は今の既定のまま（学び直した補正が、そのデッキを今の AI の相手に上手く打てるようになったかを見る用）
//! - マリガンの学習したモデルはデッキのカードの並びでデフォルトデッキを引くので、案のデッキでは使えず「コスト 4 以上を返す」だけになる。
//!   そこで案のデッキも元のデッキのモデルでマリガンする（足したカードはモデルの表に無いので役割なし・係数 0）。
//!   ファイルから読んだデッキ（とその案）は、元にするモデルが無いので、返し方ごとに引き直しを試して選ぶ（`mulligan: "sample"`）
//! - 各案の勝率と、元のデッキとの入れ替わり（案で勝ち・元で負け / 元で勝ち・案で負け）、符号検定の z を出す
//! - 同じシードでも、1 枚の入れ替えで 2〜3 割の試合の勝敗が入れ替わる（AI が自分の山札・相手の手札を並べ直して読むので、
//!   入れ替えたカードを引く前から手が変わる）。1 ポイントの差を見分けるには 1 案 1 万試合ほど要る

use super::options::model_eval;
use super::parallel::parallel_map;
use super::{compare_decks, fixed, seconds_since, Tally};
use crate::ai::exact_lethal::reset_exact_lethal_cache;
use crate::ai::mulligan::{
    default_deck_name_of, model_mulligan_swap_as, mulligan_action, weighted_mulligan_swap_as,
};
use crate::ai::rhino::{rhino_search_options, RhinoAgent, RHINO_POTENTIAL};
use crate::ai::search::{ExtraEval, MulliganMode, SearchAgent, SearchOptions};
use crate::ai::valuenet::ValueNet;
use crate::ai::{Agent, Rng};
use crate::data::{data, CardIdx, ClassId, Deck};
use crate::game::acting_player;
use crate::json::Json;
use crate::sim::play_match;
use crate::state::{card, Action, GameState};
use std::sync::Arc;
use std::time::Instant;

/// シードの基準（compare・rhino-compare・td selfplay の試合と重ならないように大きくする）
const SEED_BASE: u32 = 2_000_000;
/// スターターの構築ルール（src/cards/format.ts）
pub(crate) const DECK_SIZE: usize = 40;
pub(crate) const MAX_COPIES: usize = 3;
/// リノセウス用 AI で打つデッキ
pub(crate) const RHINO_DECK: &str = "リノセウスエルフ";

/// 比べるデッキ 1 つ（元のデッキか案）
pub(crate) struct Entry {
    pub(crate) label: String,
    pub(crate) cards: Vec<CardIdx>,
    /// リノセウス用 AI で打つ（元のデッキがリノセウスエルフのとき）
    pub(crate) rhino: bool,
    /// デフォルトデッキと違うとき、マリガンをこのデフォルトデッキのモデルで行う。
    /// None なら返し方ごとに引き直しを試して選ぶ（`mulligan: "sample"`）
    pub(crate) mulligan_as: Option<&'static str>,
}

/// 元のデッキ（デフォルトデッキかファイル）
pub(crate) struct BaseDeck {
    pub(crate) name: String,
    pub(crate) cards: Vec<CardIdx>,
    /// デフォルトデッキならその名前
    pub(crate) default: Option<&'static str>,
}

struct Task {
    entry: usize,
    opp: usize,
    g: u32,
    seat: usize,
}

/// 探索 AI の既定の設定。net（`--net`）があれば学習した補正をそれに替える
fn search_options(net: Option<&ExtraEval>) -> SearchOptions {
    let mut o = SearchOptions::default();
    if let Some(n) = net {
        o.extra_eval = Some(n.clone());
    }
    o
}

/// リノセウス用 AI の既定（RhinoAgent::new(true)）。net があれば学習した補正をそれに替える
fn rhino_agent(net: Option<&ExtraEval>) -> RhinoAgent {
    match net {
        None => RhinoAgent::new(true),
        Some(n) => RhinoAgent::with_options(
            true,
            rhino_search_options(RHINO_POTENTIAL, Some(n.clone())),
            search_options(Some(n)),
        ),
    }
}

/// そのデッキの既定の AI
fn default_agent(deck_name: &str, net: Option<&ExtraEval>) -> Box<dyn Agent> {
    if deck_name == RHINO_DECK {
        Box::new(rhino_agent(net))
    } else {
        Box::new(SearchAgent::new(search_options(net)))
    }
}

/// 比べる側の AI（マリガンの仕方は Entry の mulligan_as）
pub(crate) fn subject_agent(e: &Entry, net: Option<&ExtraEval>) -> Box<dyn Agent> {
    let inner: Box<dyn Agent> = if e.rhino {
        Box::new(rhino_agent(net))
    } else if e.mulligan_as.is_some() {
        Box::new(SearchAgent::new(search_options(net)))
    } else {
        Box::new(SearchAgent::new(SearchOptions {
            mulligan: MulliganMode::Sample,
            ..search_options(net)
        }))
    };
    match e.mulligan_as {
        Some(deck) => Box::new(MulliganAs { inner, deck }),
        None => inner,
    }
}

/// デッキがデフォルトデッキのどれとも違うとき、マリガンだけデフォルトデッキ deck のモデル（無ければ重み）で行う
struct MulliganAs {
    inner: Box<dyn Agent>,
    deck: &'static str,
}

impl Agent for MulliganAs {
    fn choose_action(&mut self, state: &GameState, legal: &[Action], rng: &mut Rng) -> Action {
        if legal.len() > 1 && matches!(legal[0], Action::Mulligan { .. }) {
            let p = acting_player(state);
            if default_deck_name_of(state, p).is_none() {
                let swap = model_mulligan_swap_as(state, p, self.deck)
                    .or_else(|| weighted_mulligan_swap_as(state, p, self.deck));
                if let Some(a) = swap.and_then(|swap| mulligan_action(legal, &swap)) {
                    return a.clone();
                }
            }
        }
        self.inner.choose_action(state, legal, rng)
    }
}

/// カード名かカード ID からカードを引く（トークンは不可）
pub(crate) fn find_card(name: &str) -> Result<CardIdx, String> {
    let d = data();
    let idx = match d.card_by_id.get(name) {
        Some(&i) => i,
        None => d
            .cards
            .iter()
            .position(|c| c.name == name)
            .map(|i| i as CardIdx)
            .ok_or_else(|| format!("カードがありません: {name}"))?,
    };
    if card(idx).token {
        return Err(format!("デッキに入れられないカードです: {name}"));
    }
    Ok(idx)
}

/// デッキのクラス（ニュートラル以外のカードのクラス）
pub(crate) fn deck_class(cards: &[CardIdx]) -> ClassId {
    cards
        .iter()
        .map(|&c| card(c).class)
        .find(|&k| k != ClassId::Neutral)
        .unwrap_or(ClassId::Neutral)
}

/// 「カード名-枚数,カード名+枚数,…」を [(カード, 増減)] にする
fn parse_changes(text: &str) -> Result<Vec<(CardIdx, i32)>, String> {
    let mut out = Vec::new();
    for item in text.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let pos = item.rfind(['+', '-']).ok_or_else(|| {
            format!("「カード名-枚数」か「カード名+枚数」の形ではありません: {item}")
        })?;
        let (name, rest) = item.split_at(pos);
        let n: i32 = rest[1..]
            .parse()
            .map_err(|_| format!("枚数が数ではありません: {item}"))?;
        if n <= 0 {
            return Err(format!("枚数は 1 以上: {item}"));
        }
        let sign = if rest.starts_with('-') { -1 } else { 1 };
        out.push((find_card(name.trim())?, sign * n));
    }
    if out.is_empty() {
        return Err(format!("変更がありません: {text}"));
    }
    Ok(out)
}

/// 元のデッキに変更を当てた案。抜いたカードの位置（後ろから）に、足すカードを書いた順に置く
pub(crate) fn apply_changes(
    base: &[CardIdx],
    changes: &[(CardIdx, i32)],
) -> Result<Vec<CardIdx>, String> {
    let mut cards = base.to_vec();
    let mut slots: Vec<usize> = Vec::new();
    let mut adds: Vec<CardIdx> = Vec::new();
    for &(c, n) in changes {
        if n < 0 {
            let mut left = (-n) as usize;
            for i in (0..cards.len()).rev() {
                if left == 0 {
                    break;
                }
                if cards[i] == c && !slots.contains(&i) {
                    slots.push(i);
                    left -= 1;
                }
            }
            if left > 0 {
                return Err(format!(
                    "{} は {} 枚しか入っていません",
                    card(c).name,
                    -n as usize - left
                ));
            }
        } else {
            adds.extend(std::iter::repeat_n(c, n as usize));
        }
    }
    if slots.len() != adds.len() {
        return Err(format!(
            "抜く枚数（{}）と足す枚数（{}）が違います",
            slots.len(),
            adds.len()
        ));
    }
    for (i, c) in slots.into_iter().zip(adds) {
        cards[i] = c;
    }
    check_deck(&cards, deck_class(base))?;
    Ok(cards)
}

/// スターターの構築ルール（40 枚・同名 3 枚まで・クラス）を満たすか
pub(crate) fn check_deck(cards: &[CardIdx], class: ClassId) -> Result<(), String> {
    for &c in cards {
        let k = card(c).class;
        if k != ClassId::Neutral && k != class {
            return Err(format!(
                "{} はこのデッキのクラスのカードではありません",
                card(c).name
            ));
        }
        let copies = cards.iter().filter(|&&x| x == c).count();
        if copies > MAX_COPIES {
            return Err(format!(
                "{} が {copies} 枚になります（同名は {MAX_COPIES} 枚まで）",
                card(c).name
            ));
        }
    }
    if cards.len() != DECK_SIZE {
        return Err(format!(
            "{} 枚のデッキです（{DECK_SIZE} 枚の想定）",
            cards.len()
        ));
    }
    Ok(())
}

/// デッキのテキスト（src/cards/deck.ts の parseDeckText と同じ形式）から [名前, カード]。名前の行が無ければ default_name
fn parse_deck_text(text: &str, default_name: &str) -> Result<(String, Vec<CardIdx>), String> {
    let mut name = default_name.to_string();
    let mut cards: Vec<CardIdx> = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let meta = ["名前", "クラス", "name", "class"].iter().find_map(|k| {
            let rest = line.strip_prefix(k)?.trim_start();
            rest.strip_prefix([':', '：']).map(|v| (*k, v.trim()))
        });
        if let Some((k, v)) = meta {
            if (k == "名前" || k == "name") && !v.is_empty() {
                name = v.to_string();
            }
            continue;
        }
        let digits = line.chars().take_while(|c| c.is_ascii_digit()).count();
        let rest = line[digits..].trim_start();
        let rest = rest
            .strip_prefix(['x', 'X', '×'])
            .map(|r| r.trim_start())
            .unwrap_or(rest);
        if digits == 0 || rest.is_empty() {
            return Err(format!(
                "{} 行目: 「枚数 カード名」の形式ではありません: {line}",
                i + 1
            ));
        }
        let n: usize = line[..digits]
            .parse()
            .map_err(|_| format!("{} 行目: 枚数が数ではありません: {line}", i + 1))?;
        let c = find_card(rest).map_err(|e| format!("{} 行目: {e}", i + 1))?;
        cards.extend(std::iter::repeat_n(c, n));
    }
    check_deck(&cards, deck_class(&cards))?;
    Ok((name, cards))
}

/// デフォルトデッキの名前か、デッキのテキストファイル
pub(crate) fn load_deck(name: &str) -> Result<BaseDeck, String> {
    if let Ok(d) = find_deck(name) {
        return Ok(BaseDeck {
            name: d.name.clone(),
            cards: d.cards.clone(),
            default: Some(d.name.as_str()),
        });
    }
    let text = std::fs::read_to_string(name)
        .map_err(|e| format!("{name} はデフォルトデッキでもなく、読めません: {e}"))?;
    let stem = std::path::Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let (deck_name, cards) = parse_deck_text(&text, stem).map_err(|e| format!("{name}: {e}"))?;
    Ok(BaseDeck {
        name: deck_name,
        cards,
        default: None,
    })
}

/// デッキ（デフォルトデッキの名前・キーか、デッキのテキストファイル）を読む（td selfplay --decks でも使う）。
/// ファイルのデッキは構築ルールを確かめる。key は渡した名前のまま
pub(crate) fn read_deck(name: &str) -> Result<Deck, String> {
    let d = load_deck(name)?;
    Ok(Deck {
        key: name.to_string(),
        name: d.name,
        cards: d.cards,
    })
}

/// 変更を読みやすい名前に（「知恵の輝き-1,最果ての罪・サタン+1」）
pub(crate) fn changes_label(changes: &[(CardIdx, i32)]) -> String {
    changes
        .iter()
        .map(|&(c, n)| {
            let sign = if n < 0 { "-" } else { "+" };
            format!("{}{sign}{}", card(c).name, n.abs())
        })
        .collect::<Vec<_>>()
        .join(",")
}

pub(crate) fn find_deck(name: &str) -> Result<&'static Deck, String> {
    data()
        .decks
        .iter()
        .find(|d| d.name == name || d.key == name)
        .ok_or_else(|| {
            format!(
                "デッキがありません: {name}（{}）",
                data()
                    .decks
                    .iter()
                    .map(|d| d.name.as_str())
                    .collect::<Vec<_>>()
                    .join(" / ")
            )
        })
}

fn play_one(
    entries: &[Entry],
    opponents: &[&'static Deck],
    net: Option<&ExtraEval>,
    opp_net: Option<&ExtraEval>,
    t: &Task,
) -> bool {
    let me = &entries[t.entry].cards;
    let opp = opponents[t.opp];
    let seed = SEED_BASE + t.g * 13 + t.seat as u32;
    // 全探索のリーサル探索のメモはスレッドごとなので、前の試合のものを捨てる（試合の結果を並べ方によらず同じにする）
    reset_exact_lethal_cache();
    let mut a = subject_agent(&entries[t.entry], net);
    let mut o = default_agent(&opp.name, opp_net);
    let (mut agents, decks): ([&mut dyn Agent; 2], [&[CardIdx]; 2]) = if t.seat == 0 {
        ([a.as_mut(), o.as_mut()], [&me[..], &opp.cards[..]])
    } else {
        ([o.as_mut(), a.as_mut()], [&opp.cards[..], &me[..]])
    };
    let end = play_match(&mut agents, decks, seed, |_, _| {});
    let winner = end
        .winner
        .unwrap_or_else(|| panic!("勝者がいません（{} g{} 席{}）", opp.name, t.g, t.seat));
    winner == t.seat
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mut deck_name: Option<String> = None;
    let mut variants: Vec<String> = Vec::new();
    let mut add: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    let mut vs: Vec<String> = Vec::new();
    let mut games: u32 = 50;
    let mut start: u32 = 0;
    let mut out: Option<String> = None;
    let mut net_path: Option<String> = None;
    let mut subject_only = false;
    let mut it = argv.iter();
    while let Some(key) = it.next() {
        let v = it.next().ok_or_else(|| format!("{key} の値がありません"))?;
        let int = || -> Result<u32, String> {
            v.parse::<u32>()
                .map_err(|_| format!("{key} は 0 以上の整数: {v}"))
        };
        match key.as_str() {
            "--deck" => deck_name = Some(v.clone()),
            "--variant" => variants.push(v.clone()),
            "--add" => add.extend(
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
            ),
            "--file" => files.push(v.clone()),
            "--vs" => vs.extend(
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
            ),
            "--games" => games = int()?,
            "--start" => start = int()?,
            "--out" => out = Some(v.clone()),
            "--net" => net_path = Some(v.clone()),
            "--netSide" => {
                subject_only = match v.as_str() {
                    "both" => false,
                    "subject" => true,
                    x => return Err(format!("--netSide は both か subject: {x}")),
                }
            }
            _ => return Err(format!("不明な引数: {key}")),
        }
    }
    let deck = load_deck(
        deck_name
            .as_deref()
            .ok_or("--deck でデッキを指定してください")?,
    )?;
    if subject_only && net_path.is_none() {
        return Err("--netSide は --net と一緒に使います".into());
    }
    let net: Option<ExtraEval> = match &net_path {
        None => None,
        Some(path) => {
            let net = ValueNet::load(path)?;
            if !net.base_weights.is_empty() {
                return Err(format!(
                    "{path}: baseWeights のあるモデルには対応していません"
                ));
            }
            eprintln!(
                "補正: {path}（{}）",
                if subject_only {
                    "比べるデッキの側だけ"
                } else {
                    "どちらの側も"
                }
            );
            Some(model_eval(Arc::new(net)))
        }
    };
    let opp_net = if subject_only { None } else { net.clone() };
    let rhino = deck.default == Some(RHINO_DECK);
    let mut entries = vec![Entry {
        label: "元のデッキ".into(),
        cards: deck.cards.clone(),
        rhino,
        mulligan_as: deck.default,
    }];
    let mut push = |changes: Vec<(CardIdx, i32)>| -> Result<(), String> {
        let label = changes_label(&changes);
        let cards = apply_changes(&deck.cards, &changes).map_err(|e| format!("{label}: {e}"))?;
        if !entries.iter().any(|e| e.label == label) {
            entries.push(Entry {
                label,
                cards,
                rhino,
                mulligan_as: deck.default,
            });
        }
        Ok(())
    };
    for v in &variants {
        push(parse_changes(v)?)?;
    }
    for y in &add {
        let y = find_card(y)?;
        let mut seen: Vec<CardIdx> = Vec::new();
        for &x in &deck.cards {
            if x == y || seen.contains(&x) {
                continue;
            }
            seen.push(x);
            push(vec![(x, -1), (y, 1)])?;
        }
    }
    for f in &files {
        let d = load_deck(f)?;
        let label = match d.default {
            Some(n) => n.to_string(),
            None => format!("{}（{f}）", d.name),
        };
        entries.push(Entry {
            label,
            cards: d.cards,
            rhino: d.default == Some(RHINO_DECK),
            mulligan_as: d.default,
        });
    }
    let opponents: Vec<&'static Deck> = if vs.is_empty() {
        compare_decks()
            .into_iter()
            .filter(|d| d.name != deck.name)
            .collect()
    } else {
        vs.iter().map(|n| find_deck(n)).collect::<Result<_, _>>()?
    };
    let tasks: Vec<Task> = (0..entries.len())
        .flat_map(|entry| {
            (0..opponents.len()).flat_map(move |opp| {
                (start..start + games).flat_map(move |g| {
                    [0, 1].map(|seat| Task {
                        entry,
                        opp,
                        g,
                        seat,
                    })
                })
            })
        })
        .collect();
    let per_entry = opponents.len() * games as usize * 2;
    eprintln!(
        "{}: 案 {} 個 × {per_entry} 試合（相手 {} デッキ × {games} × 2 席）= {} 試合",
        deck.name,
        entries.len() - 1,
        opponents.len(),
        tasks.len()
    );
    let t0 = Instant::now();
    let step = (tasks.len() / 10).max(1);
    let results = parallel_map(
        &tasks,
        |t, _| play_one(&entries, &opponents, net.as_ref(), opp_net.as_ref(), t),
        |done, total, _, _| {
            if done % step == 0 || done == total {
                eprintln!(
                    "{done}/{total} 試合 {}s/試合",
                    fixed(seconds_since(t0) / done as f64, 2)
                );
            }
        },
    );
    let base: &[bool] = &results[..per_entry];
    let mut lines: Vec<Json> = Vec::new();
    println!(
        "{}（{} 試合ずつ、g{}〜{}）  {}s/試合",
        deck.name,
        per_entry,
        start,
        start + games - 1,
        fixed(seconds_since(t0) / tasks.len().max(1) as f64, 2)
    );
    for (e, entry) in entries.iter().enumerate() {
        let rs = &results[e * per_entry..(e + 1) * per_entry];
        let ts = &tasks[e * per_entry..(e + 1) * per_entry];
        let wins = rs.iter().filter(|&&w| w).count();
        let mut tally = Tally::default();
        for (t, &w) in ts.iter().zip(rs) {
            tally.add(&opponents[t.opp].name, w);
        }
        let rate = wins as f64 / per_entry as f64 * 100.0;
        if e == 0 {
            println!("{}: {wins}/{per_entry} = {}%", entry.label, fixed(rate, 1));
        } else {
            let up = rs.iter().zip(base).filter(|&(&v, &b)| v && !b).count();
            let down = rs.iter().zip(base).filter(|&(&v, &b)| !v && b).count();
            let z = (up as f64 - down as f64) / ((up + down) as f64).sqrt().max(1.0);
            let base_rate = base.iter().filter(|&&w| w).count() as f64 / per_entry as f64 * 100.0;
            println!(
                "{}: {wins}/{per_entry} = {}%（元との差 {}{} ポイント、入れ替わり {up} / {down}、z {}{}）",
                entry.label,
                fixed(rate, 1),
                if rate >= base_rate { "+" } else { "" },
                fixed(rate - base_rate, 1),
                if z >= 0.0 { "+" } else { "" },
                fixed(z, 1)
            );
        }
        println!("  {}", tally.line());
        for (t, &w) in ts.iter().zip(rs) {
            lines.push(Json::Obj(vec![
                ("deck".into(), Json::Str(deck.name.clone())),
                ("variant".into(), Json::Str(entry.label.clone())),
                ("opponent".into(), Json::Str(opponents[t.opp].name.clone())),
                ("g".into(), Json::Num(t.g as f64)),
                ("seat".into(), Json::Num(t.seat as f64)),
                ("won".into(), Json::Bool(w)),
            ]));
        }
    }
    if let Some(out) = out {
        let mut text = String::new();
        for l in &lines {
            text.push_str(&l.stringify());
            text.push('\n');
        }
        std::fs::write(&out, text).map_err(|e| format!("{out} に書けません: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn witch() -> &'static Deck {
        find_deck("スペルウィッチ").unwrap()
    }

    #[test]
    fn swap_keeps_positions() {
        let base = &witch().cards;
        let x = find_card("知恵の輝き").unwrap();
        let y = find_card("最果ての罪・サタン").unwrap();
        let v = apply_changes(
            base,
            &parse_changes("知恵の輝き-1,最果ての罪・サタン+1").unwrap(),
        )
        .unwrap();
        assert_eq!(v.len(), base.len());
        let diff: Vec<usize> = (0..v.len()).filter(|&i| v[i] != base[i]).collect();
        assert_eq!(diff.len(), 1);
        assert_eq!(base[diff[0]], x);
        assert_eq!(v[diff[0]], y);
    }

    #[test]
    fn rejects_bad_variants() {
        let base = &witch().cards;
        // 枚数が合わない
        assert!(apply_changes(base, &parse_changes("知恵の輝き-1").unwrap()).is_err());
        // 同名 4 枚
        assert!(apply_changes(
            base,
            &parse_changes("知恵の輝き-1,ストームブラスト+1").unwrap()
        )
        .is_err());
        // 他のクラスのカード
        assert!(apply_changes(
            base,
            &parse_changes("知恵の輝き-1,殺戮のリノセウス+1").unwrap()
        )
        .is_err());
        // 入っていないカードを抜く
        assert!(apply_changes(
            base,
            &parse_changes("殺戮のリノセウス-1,最果ての罪・サタン+1").unwrap()
        )
        .is_err());
        assert!(parse_changes("知恵の輝き").is_err());
        assert!(parse_changes("無いカード-1").is_err());
    }

    #[test]
    fn variant_mulligans_with_base_model() {
        // 案のデッキはデフォルトデッキとして引けないが、元のデッキのモデルでマリガンする
        let base = witch();
        let v = apply_changes(
            &base.cards,
            &parse_changes("最果ての罪・サタン-1,観察の探偵+1").unwrap(),
        )
        .unwrap();
        let opp = find_deck("AFネメシス").unwrap();
        for seed in 0..10 {
            let mut s = crate::game::create_game([&v, &opp.cards], seed);
            // 先攻からマリガンするので、相手が先攻なら相手は返さずに済ませる
            if acting_player(&s) != 0 {
                let keep = crate::game::legal_actions(&s)[0].clone();
                s = crate::game::apply_action(&s, &keep);
            }
            let legal = crate::game::legal_actions(&s);
            let p = acting_player(&s);
            assert_eq!(p, 0);
            assert_eq!(default_deck_name_of(&s, p), None);
            let expected = model_mulligan_swap_as(&s, p, &base.name).unwrap();
            let mut agent = MulliganAs {
                inner: default_agent(&base.name, None),
                deck: &base.name,
            };
            let a = agent.choose_action(&s, &legal, &mut Rng::new(seed));
            assert_eq!(Some(&a), mulligan_action(&legal, &expected));
        }
    }

    #[test]
    fn reads_deck_files() {
        // data/decks の各ファイルを読むと、デフォルトデッキと同じ並びのカードになる
        for d in &data().decks {
            let path = format!(
                "{}/../../data/decks/{}.txt",
                env!("CARGO_MANIFEST_DIR"),
                d.key
            );
            let b = load_deck(&path).unwrap();
            assert_eq!(b.name, d.name);
            assert_eq!(b.cards, d.cards);
            assert_eq!(b.default, None);
        }
        // 「3x 名前」「3 × 名前」・カード ID・コメント・名前の行が無いもの
        let witch = &find_deck("スペルウィッチ").unwrap().cards;
        let mut text = String::from("# コメント\nクラス: ウィッチ\n");
        for (i, &c) in witch.iter().enumerate() {
            if i == 0 || witch[i - 1] != c {
                let n = witch.iter().filter(|&&x| x == c).count();
                let sep = ["x ", " × ", " "][i % 3];
                let key = if i % 2 == 0 {
                    &card(c).name
                } else {
                    &card(c).id
                };
                text.push_str(&format!("{n}{sep}{key}\n"));
            }
        }
        let (name, cards) = parse_deck_text(&text, "既定の名前").unwrap();
        assert_eq!(name, "既定の名前");
        assert_eq!(&cards, witch);
        // 同名 4 枚以上・40 枚でない・不明なカードは読まない
        assert!(parse_deck_text("40 知恵の輝き\n", "x").is_err());
        assert!(parse_deck_text("3 知恵の輝き\n", "x").is_err());
        assert!(parse_deck_text("3 無いカード\n", "x").is_err());
        // 名前ならデフォルトデッキ
        assert_eq!(
            load_deck("スペルウィッチ").unwrap().default,
            Some("スペルウィッチ")
        );
    }
}
