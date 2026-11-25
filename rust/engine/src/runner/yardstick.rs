//! 強さの物差し: 固定した相手との勝率を測り、版ごとに記録する。相手は 2 つ:
//!
//! - 物差し（`classic`）: 学習した補正を入れる前の探索 AI（2026-10-16 の search-classic）を凍結したもの
//! - 強い相手の物差し（`strong`）: 2026-10-22 の既定の探索 AI（補正 s2b・相手のターンを幅 16 で読む）を凍結したもの。
//!   補正は `yardstick/strong-1-net.json`（data/value-net.json の写し）から読む
//! - 新しいプール（前期のローテーション）の物差し（`pool-v0`・`pool-r3`。2026-11-16）: 代表 10 型のデッキ（`POOL_DECKS`。
//!   その日の `data/pools/azvaldt/sets/rep10.txt`）で、2026-11-16 の既定の探索 AI に、新しいプールの補正と見込みを入れたものを凍結したもの。
//!   `pool-v0` は段階 4 の出発の補正 v0（補正 B を 84 個のデッキの語彙に広げ、新しいカードの行を属性で埋めたもの。見込みは B のもの）、
//!   `pool-r3` は段階 4 の学び直しを止めた R3 の補正と見込み。どちらもファイルを `yardstick/pool-*.json` に写して読む
//!
//!   svwb yardstick [--ref classic|strong|pool-v0|pool-r3] [--opts '<設定JSON>'] [--games 1000] [--start 0] [--label 名前] [--record] [--no-ledger] [--kifu <ファイル> | --no-kifu]
//!   svwb yardstick fingerprint [--ref classic|strong|pool-v0|pool-r3]
//!
//! 試合の組み方とシードは compare と同じ（同じデッキの組で席とデッキを入れ替えて 2 試合ずつ。--games 1000 で 2000 試合）。
//! 新しいプールの物差しは `compare --decks`（代表 10 型）と同じ組（試合番号 100 ごとに全部の組）。
//! 強い相手と新しいプールの物差しは組の 2 試合を同じシードで打つ（compare の既定の鏡。同じ AI どうしはちょうど 50%）。
//! 弱い相手は表を前と比べられるよう、組の 2 試合を別のシードで打つ（compare の --no-mirror）。
//! --opts は compare の設定と同じ形（`{}` で今の探索 AI の既定）。--record で `docs/yardstick.md` のその相手の表に 1 行足す。
//! --record の有無にかかわらず、回すたびに実験の台帳 `docs/ledger.jsonl` に 1 行足す（runner/ledger.rs。--no-ledger で書かない）。
//! 試合ごとの棋譜も既定で書く（compare と同じ。runner/kifu.rs。測る側が A、相手が B）。
//!
//! 相手の設定（`reference_options`・`strong_reference_options`）は、探索 AI の既定や SEARCH_WEIGHTS を変えても動かないよう、設定と重みをここに書き写してある。
//! 2026-11-10 に消した実験の設定（`tree`・`nextLethal` 等）は、どちらの相手でも使わない値だったので、ここからも消した（指紋は同じ。docs/removed.md）。
//! それでもルール・カード能力・評価関数や探索のコード・マリガンのモデル等を変えると相手の手が変わるので、
//! 相手どうしの決まった試合の手順のハッシュ（指紋）を `FINGERPRINT`・`STRONG_FINGERPRINT` と比べる（tests/yardstick.rs と、--record の前）。
//! 指紋が変わったら、AI の変更が相手に漏れたのなら漏れた分をここに書き写して元に戻す。
//! ルールの修正などで戻せないなら版（`VERSION`・`STRONG_VERSION`）を上げて指紋を書き直し、表を新しく始める（違う版の行どうしは比べない）。

use super::compare::{compare_pair, compare_seed, pair_stats, play_compare_game_with};
use super::deck_compare::read_deck;
use super::kifu;
use super::ledger;
use super::options::{compare_options, model_eval};
use super::parallel::parallel_map;
use super::{compare_decks, fixed, seconds_since, Tally};
use crate::ai::aidata::{weights_from, Weights};
use crate::ai::potential::PotentialNet;
use crate::ai::search::{
    DrawSplit, MulliganMode, OpponentSearch, RescoreRace, RolloutWeights, SearchAgent,
    SearchOptions,
};
use crate::ai::valuenet::ValueNet;
use crate::ai::Agent;
use crate::canonical::{action_canon, fnv};
use crate::data::Deck;
use crate::json::Json;
use crate::sim::play_match;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

/// 物差しの版（相手の手が変わって戻せないときに上げる）
pub const VERSION: u32 = 5;

/// 相手どうしの決まった試合（`fingerprint`）の手順のハッシュ
pub const FINGERPRINT: &str = "0f818a8c";

/// 強い相手の物差しの版
pub const STRONG_VERSION: u32 = 4;

/// 強い相手どうしの決まった試合の手順のハッシュ
pub const STRONG_FINGERPRINT: &str = "66a09e01";

/// 新しいプールの物差し（相手 v0）の版
pub const POOL_V0_VERSION: u32 = 1;

/// 新しいプールの物差し（相手 v0）どうしの決まった試合の手順のハッシュ
pub const POOL_V0_FINGERPRINT: &str = "36d62937";

/// 新しいプールの強い相手の物差し（相手 R3）の版
pub const POOL_R3_VERSION: u32 = 1;

/// 新しいプールの強い相手の物差し（相手 R3）どうしの決まった試合の手順のハッシュ
pub const POOL_R3_FINGERPRINT: &str = "7fa599f2";

/// 新しいプールの物差しのデッキ（リポジトリの根からの道）。2026-11-16 の `data/pools/azvaldt/sets/rep10.txt`（代表 10 型）を、
/// 同じ順で書き写したもの（デッキの組のファイルを書き直しても物差しは動かない）
pub const POOL_DECKS: [&str; 10] = [
    "data/pools/azvaldt/decks/ps26-27-09b/CR_ウィッチ.txt",
    "data/pools/azvaldt/decks/ps26-27-09b/CR_ドラゴン.txt",
    "data/pools/azvaldt/decks/ps26-27-09b/CR_ナイトメア.txt",
    "data/pools/azvaldt/decks/ps26-27-09b/CR_ロイヤル.txt",
    "data/pools/azvaldt/decks/ps26-27-09b/LVH_ナイトメア.txt",
    "data/pools/azvaldt/decks/ps26-27-09b/LVH_ビショップ.txt",
    "data/pools/azvaldt/decks/ps26-27-09b/VL_ウィッチ.txt",
    "data/pools/azvaldt/decks/ps26-27-09b/VL_エルフ.txt",
    "data/pools/azvaldt/decks/ps26-27-09b/VL_ネメシス.txt",
    "data/pools/azvaldt/decks/ps26-27-09b/ZETA_ビショップ.txt",
];

/// 相手の評価関数の重み（2026-10-16 の SEARCH_WEIGHTS を書き写したもの。2026-10-22 の SEARCH_WEIGHTS も同じなので、強い相手もこれを使う）
const REFERENCE_WEIGHTS: &str = r#"{"myHp":0.7,"oppHp":1,"attack":1,"defense":0.8,"followerBase":1,"tempAttack":0.3,"keywords":1,"amulet":1.5,"sigil":0.5,"sigilAmulet":1.5,"countdownDecay":0.8,"jeanneSync":0,"oppBoard":1.1,"myHand":0.6,"oppHand":0.3,"ep":1.5,"sep":5,"extraPp":1,"maxPp":8,"crest":3,"graveyard":0.05,"lethalRange":10,"lethalAttack":0.3,"fusionSet":3.6,"kuonReserve":8,"evoReserve":3,"sevoReserve":6,"kerberosReserve":0,"lastWords":1,"lastWordsSummon":0.5,"handStorm":0,"boostCard":1,"boost":0.2,"boostCap":5,"hold":{"90072110":0.6,"90072120":0.6,"90073110":1.2,"90073120":1.7999999999999998,"90073130":1.7999999999999998,"90074110":4.8},"doomed":0.3,"ppLeft":0,"extraPpExpiring":0,"passive":0}"#;

/// 物差しの相手の設定（2026-10-16 の search-classic を書き写したもの）。
/// `..SearchOptions::default()` を使わず全項目を書くので、項目が増えたらここで値を決める（既定を変えても相手は動かない）
pub fn reference_options() -> SearchOptions {
    SearchOptions {
        samples: 3,
        beam_width: 32,
        max_depth: 8,
        rescore_top: 4,
        lethal: true,
        lethal_ward_blocked: 0.0,
        lethal_expand_choices: false,
        lethal_exact_states: 0,
        allow: None,
        dedup: true,
        same_hand_once: true,
        chain: true,
        defer_fuse: false,
        defer_fuse_hand: 8,
        defer_fuse_last_words: false,
        fuse_minimal: false,
        fuse_one: false,
        mulligan: MulliganMode::Model,
        mulligan_samples: 100,
        mulligan_static: true,
        mulligan_net: true,
        mulligan_turns: 0,
        mulligan_rollout_beam: 0,
        mulligan_keep: Vec::new(),
        mulligan_opp: None,
        mulligan_return: Vec::new(),
        mulligan_rollout_weights: RolloutWeights::Greedy,
        settle_trades: true,
        dominance: true,
        reuse_plan: true,
        plan_candidates: 3,
        per_first: 0,
        potential: None,
        potential_weight: 1.0,
        extra_eval: None,
        opp_extra_eval: None,
        weights: Some(Arc::new(reference_weights())),
        policy_weights: None,
        opponent_search: None,
        opp_hand_samples: 1,
        opp_hand_common: false,
        read_own_deck_apart: false,
        peek_opp_hand: false,
        peek_all: false,
        // 伏せた手札のスペルブーストの見込み（2026-11-13 に足した設定）は、凍結した相手では切る
        opp_hand_boosts: false,
        rescore_mix: 0.0,
        rescore_race: None,
        draw_split: None,
        record_reads: false,
        // 思考用の乱数は 2026-11-10 より前の取り方のまま（相手の手を変えない）
        sequential_rng: true,
        pick: None,
        read_lethal: None,
        imagined_input: true,
    }
}

fn reference_weights() -> Weights {
    match serde_json::from_str(REFERENCE_WEIGHTS) {
        Ok(serde_json::Value::Object(m)) => weights_from(m).expect("物差しの重み"),
        _ => panic!("物差しの重みが読めません"),
    }
}

/// 強い相手の補正のファイル（2026-10-22 の data/value-net.json の写し。s2b）
pub fn strong_net_path() -> String {
    format!("{}/yardstick/strong-1-net.json", env!("CARGO_MANIFEST_DIR"))
}

fn strong_net() -> Arc<ValueNet> {
    static NET: OnceLock<Arc<ValueNet>> = OnceLock::new();
    NET.get_or_init(|| {
        Arc::new(
            ValueNet::load(&strong_net_path()).unwrap_or_else(|e| panic!("強い相手の補正: {e}")),
        )
    })
    .clone()
}

/// 強い相手の物差しの設定（2026-10-22 の探索 AI の既定を書き写したもの。補正は s2b の写し）。
/// reference_options と同じく全項目を書く
pub fn strong_reference_options() -> SearchOptions {
    SearchOptions {
        samples: 1,
        beam_width: 128,
        max_depth: 8,
        rescore_top: 4,
        lethal: true,
        lethal_ward_blocked: 1.0,
        lethal_expand_choices: true,
        lethal_exact_states: 20_000,
        allow: None,
        dedup: true,
        same_hand_once: true,
        chain: true,
        defer_fuse: false,
        defer_fuse_hand: 8,
        defer_fuse_last_words: false,
        fuse_minimal: false,
        fuse_one: false,
        mulligan: MulliganMode::Model,
        mulligan_samples: 100,
        mulligan_static: true,
        mulligan_net: true,
        mulligan_turns: 0,
        mulligan_rollout_beam: 0,
        mulligan_keep: Vec::new(),
        mulligan_opp: None,
        mulligan_return: Vec::new(),
        mulligan_rollout_weights: RolloutWeights::Greedy,
        settle_trades: true,
        dominance: true,
        reuse_plan: true,
        plan_candidates: 1,
        per_first: 0,
        potential: None,
        potential_weight: 1.0,
        extra_eval: Some(model_eval(strong_net())),
        opp_extra_eval: None,
        weights: Some(Arc::new(reference_weights())),
        policy_weights: None,
        opponent_search: Some(OpponentSearch {
            beam_width: 16,
            max_depth: 8,
            extra_eval: false,
            own_weights: false,
            hand_key: false,
            potential: false,
        }),
        opp_hand_samples: 12,
        opp_hand_common: true,
        read_own_deck_apart: false,
        peek_opp_hand: false,
        peek_all: false,
        // 伏せた手札のスペルブーストの見込み（2026-11-13 に足した設定）は、凍結した相手では切る
        opp_hand_boosts: false,
        rescore_mix: 0.0,
        rescore_race: None,
        draw_split: None,
        record_reads: false,
        // 思考用の乱数は 2026-11-10 より前の取り方のまま（相手の手を変えない）
        sequential_rng: true,
        pick: None,
        read_lethal: None,
        imagined_input: true,
    }
}

/// リポジトリの根からの道を、どこから回しても読める道にする
fn repo_path(p: &str) -> String {
    format!("{}/../../{p}", env!("CARGO_MANIFEST_DIR"))
}

/// 新しいプールの物差しの相手の補正・見込みのファイル（`yardstick/pool-<名前>-net.json`・`-potential.json`）
pub fn pool_model_paths(name: &str) -> (String, String) {
    let dir = format!("{}/yardstick", env!("CARGO_MANIFEST_DIR"));
    (
        format!("{dir}/pool-{name}-net.json"),
        format!("{dir}/pool-{name}-potential.json"),
    )
}

/// 新しいプールの物差しのデッキ（POOL_DECKS）
pub fn pool_decks() -> Vec<&'static Deck> {
    static DECKS: OnceLock<Vec<&'static Deck>> = OnceLock::new();
    DECKS
        .get_or_init(|| {
            POOL_DECKS
                .iter()
                .map(|p| {
                    let d = read_deck(&repo_path(p))
                        .unwrap_or_else(|e| panic!("新しいプールの物差しのデッキ: {e}"));
                    &*Box::leak(Box::new(d))
                })
                .collect()
        })
        .clone()
}

/// 新しいプールの物差しの相手の設定: 2026-11-16 の探索 AI の既定（SearchOptions::default()）を書き写し、
/// 補正と見込みを凍結したファイルにしたもの（compare の `{"valueNet":"<補正>","potentialNet":"<見込み>"}` と同じ AI）。
/// reference_options と同じく全項目を書く。思考用の乱数はその日の既定（判断ごとに作る）なので、同じ設定を測るとちょうど 50%
pub fn pool_reference_options(name: &str) -> SearchOptions {
    let (net_path, pot_path) = pool_model_paths(name);
    let net = ValueNet::load(&net_path).unwrap_or_else(|e| panic!("物差しの相手の補正: {e}"));
    let pot = PotentialNet::load(&pot_path).unwrap_or_else(|e| panic!("物差しの相手の見込み: {e}"));
    // 補正の出発点の重み（baseWeights）で自分の評価の重みを上書きし、読みの中の相手は探索 AI の重みのまま（options.rs の apply_value_net）。
    // その日の探索 AI の重み（SEARCH_WEIGHTS）は REFERENCE_WEIGHTS と同じ
    let text = std::fs::read_to_string(&net_path)
        .unwrap_or_else(|e| panic!("{net_path} を読めません: {e}"));
    let base = Json::parse(&text)
        .ok()
        .and_then(|j| j.get("baseWeights").cloned())
        .unwrap_or(Json::Obj(Vec::new()));
    let own = match Json::parse(REFERENCE_WEIGHTS)
        .expect("物差しの重み")
        .spread(&base)
        .to_value()
    {
        serde_json::Value::Object(m) => weights_from(m).expect("物差しの相手の重み"),
        _ => panic!("物差しの相手の重みが読めません"),
    };
    let base_empty = matches!(&base, Json::Obj(items) if items.is_empty());
    SearchOptions {
        samples: 1,
        beam_width: 256,
        max_depth: 16,
        rescore_top: 4,
        lethal: true,
        lethal_ward_blocked: 1.0,
        lethal_expand_choices: true,
        lethal_exact_states: 20_000,
        allow: None,
        dedup: true,
        same_hand_once: true,
        chain: true,
        defer_fuse: true,
        defer_fuse_hand: 8,
        defer_fuse_last_words: true,
        fuse_minimal: false,
        fuse_one: true,
        mulligan: MulliganMode::Turn1,
        mulligan_samples: 50,
        mulligan_static: true,
        mulligan_net: true,
        mulligan_turns: 3,
        mulligan_rollout_beam: 0,
        mulligan_keep: Vec::new(),
        mulligan_opp: None,
        mulligan_return: Vec::new(),
        mulligan_rollout_weights: RolloutWeights::Ramp,
        settle_trades: true,
        dominance: true,
        reuse_plan: true,
        plan_candidates: 1,
        per_first: 0,
        potential: Some(Arc::new(pot)),
        potential_weight: 1.0,
        extra_eval: Some(model_eval(Arc::new(net))),
        opp_extra_eval: None,
        weights: Some(Arc::new(own)),
        policy_weights: if base_empty {
            None
        } else {
            Some(Arc::new(reference_weights()))
        },
        opponent_search: Some(OpponentSearch {
            beam_width: 8,
            max_depth: 8,
            extra_eval: false,
            own_weights: false,
            hand_key: false,
            potential: false,
        }),
        opp_hand_samples: 12,
        opp_hand_common: true,
        read_own_deck_apart: true,
        peek_opp_hand: false,
        peek_all: false,
        opp_hand_boosts: false,
        rescore_mix: 0.5,
        rescore_race: Some(RescoreRace {
            first: 3,
            step: 3,
            z: 2.0,
            delta: 10.0,
            reentry: Some(0.0),
            lethal_guard: true,
        }),
        draw_split: Some(DrawSplit {
            samples: 4,
            beam_width: 8,
            max_depth: 16,
            root_draws: 2,
            enumerate: true,
        }),
        record_reads: false,
        sequential_rng: false,
        pick: None,
        read_lethal: None,
        imagined_input: true,
    }
}

/// 物差しの相手
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Reference {
    /// 学習した補正を入れる前の探索 AI（2026-10-16 の search-classic）
    Classic,
    /// 2026-10-22 の既定の探索 AI
    Strong,
    /// 新しいプールの代表 10 型で、2026-11-16 の既定の探索 AI に段階 4 の出発の補正 v0 を入れたもの
    PoolV0,
    /// 新しいプールの代表 10 型で、2026-11-16 の既定の探索 AI に段階 4 の R3 の補正と見込みを入れたもの
    PoolR3,
}

impl Reference {
    pub fn parse(s: &str) -> Result<Reference, String> {
        match s {
            "classic" => Ok(Reference::Classic),
            "strong" => Ok(Reference::Strong),
            "pool-v0" => Ok(Reference::PoolV0),
            "pool-r3" => Ok(Reference::PoolR3),
            _ => Err(format!(
                "--ref は classic・strong・pool-v0・pool-r3 のどれか: {s}"
            )),
        }
    }

    /// --ref に渡す名前（台帳の b）
    pub fn key(self) -> &'static str {
        match self {
            Reference::Classic => "classic",
            Reference::Strong => "strong",
            Reference::PoolV0 => "pool-v0",
            Reference::PoolR3 => "pool-r3",
        }
    }

    pub fn version(self) -> u32 {
        match self {
            Reference::Classic => VERSION,
            Reference::Strong => STRONG_VERSION,
            Reference::PoolV0 => POOL_V0_VERSION,
            Reference::PoolR3 => POOL_R3_VERSION,
        }
    }

    /// 記録してある指紋
    pub fn recorded(self) -> &'static str {
        match self {
            Reference::Classic => FINGERPRINT,
            Reference::Strong => STRONG_FINGERPRINT,
            Reference::PoolV0 => POOL_V0_FINGERPRINT,
            Reference::PoolR3 => POOL_R3_FINGERPRINT,
        }
    }

    pub fn options(self) -> SearchOptions {
        match self {
            Reference::Classic => reference_options(),
            Reference::Strong => strong_reference_options(),
            Reference::PoolV0 => pool_reference_options("v0"),
            Reference::PoolR3 => pool_reference_options("r3"),
        }
    }

    /// 試合のデッキ（スターターの物差しは比較用の 7 デッキ、新しいプールの物差しは代表 10 型）
    pub fn decks(self) -> Vec<&'static Deck> {
        match self {
            Reference::Classic | Reference::Strong => compare_decks(),
            Reference::PoolV0 | Reference::PoolR3 => pool_decks(),
        }
    }

    /// 組の 2 試合を同じシードで打つか（弱い相手の物差しだけが、前の表と比べられるよう別のシード）
    pub fn mirror(self) -> bool {
        self != Reference::Classic
    }

    /// 表の節の名前（「物差し 2」等）
    pub fn title(self) -> String {
        match self {
            Reference::Classic => format!("物差し {VERSION}"),
            Reference::Strong => format!("強い相手の物差し {STRONG_VERSION}"),
            Reference::PoolV0 => format!("新しいプールの物差し {POOL_V0_VERSION}"),
            Reference::PoolR3 => format!("新しいプールの強い相手の物差し {POOL_R3_VERSION}"),
        }
    }
}

/// 相手どうしで試合 0〜（デッキの数 − 1）を席とデッキを入れ替えて打ち、手順と勝者のハッシュを返す。
/// どのデッキも先の席に 1 回は出る（スターターは 7 デッキで 14 試合、新しいプールは代表 10 型で 20 試合）
pub fn fingerprint_of(r: Reference) -> String {
    let decks = r.decks();
    let reference = r.options();
    let tasks: Vec<(u32, bool)> = (0..decks.len() as u32)
        .flat_map(|g| [(g, false), (g, true)])
        .collect();
    let lines = parallel_map(
        &tasks,
        |&(g, swap), _| {
            let (da, db) = compare_pair(&decks, g, swap);
            let mut a = SearchAgent::new(reference.clone());
            let mut b = SearchAgent::new(reference.clone());
            let mut log = Vec::new();
            let end = play_match(
                &mut [&mut a as &mut dyn Agent, &mut b],
                [&da.cards, &db.cards],
                compare_seed(g, swap, r.mirror()),
                |_, act| log.push(action_canon(act)),
            );
            format!("{g} {swap} {:?} {}", end.winner, fnv(&log.join(" ")))
        },
        |_, _, _, _| {},
    );
    fnv(&lines.join("\n"))
}

/// 物差し（classic）の指紋
pub fn fingerprint() -> String {
    fingerprint_of(Reference::Classic)
}

/// 表の列に使うデッキの短い名前（スターターはクラス、ファイルのデッキは名前の後ろの「（チーム）」を除いた型）
pub(crate) fn short_name(deck: &str) -> &str {
    const CLASSES: [&str; 7] = [
        "エルフ",
        "ロイヤル",
        "ウィッチ",
        "ドラゴン",
        "ナイトメア",
        "ビショップ",
        "ネメシス",
    ];
    CLASSES
        .iter()
        .find(|c| deck.ends_with(*c))
        .copied()
        .unwrap_or_else(|| deck.split('（').next().unwrap_or(deck))
}

fn doc_path() -> String {
    format!("{}/../../docs/yardstick.md", env!("CARGO_MANIFEST_DIR"))
}

/// コマンドの標準出力の 1 行目（失敗したら None）
pub(crate) fn command_line(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd)
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Some(text.lines().next().unwrap_or("").trim().to_string())
}

/// 今のコミット（コミットしていない変更があれば末尾に "+"。記録の表の変更は数えない）
fn commit_label() -> String {
    commit_label_excluding("docs/yardstick.md")
}

/// 今のコミット（コミットしていない変更があれば末尾に "+"。記録の表 doc（リポジトリの根からの道）と実験の台帳の変更は数えない）
pub(crate) fn commit_label_excluding(doc: &str) -> String {
    let head = command_line("git", &["rev-parse", "--short=7", "HEAD"]).unwrap_or("?".into());
    let dirty = std::process::Command::new("git")
        .args([
            "status",
            "--porcelain",
            "--untracked-files=no",
            "--",
            ":/",
            &format!(":(exclude,top){doc}"),
            &format!(":(exclude,top){}", super::ledger::LEDGER_DOC),
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);
    if dirty {
        format!("{head}+")
    } else {
        head
    }
}

/// 表の見出し（この版の節を新しく始めるとき）
fn section_header(r: Reference, decks: &[String]) -> String {
    let mut cols = vec!["日付", "コミット", "名前", "設定", "勝率", "±", "試合"]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
    cols.extend(decks.iter().map(|d| short_name(d).to_string()));
    cols.push("1 試合".into());
    format!(
        "## {}（指紋 {}）\n\n| {} |\n|{}\n",
        r.title(),
        r.recorded(),
        cols.join(" | "),
        " --- |".repeat(cols.len())
    )
}

/// 表の文書に 1 行足した文書。その相手のこの版の節があればその表の最後に、無ければ文書の最後に節を新しく始めて足す
fn with_row(text: &str, r: Reference, row: &str, decks: &[String]) -> String {
    let heading = format!("## {}（", r.title());
    let lines: Vec<&str> = text.lines().collect();
    if let Some(h) = lines.iter().position(|l| l.starts_with(&heading)) {
        let end = lines[h + 1..]
            .iter()
            .position(|l| l.starts_with("## "))
            .map_or(lines.len(), |k| h + 1 + k);
        let last_row = (h + 1..end)
            .rev()
            .find(|&i| lines[i].starts_with('|'))
            .unwrap_or(end - 1);
        let mut out: Vec<&str> = lines[..=last_row].to_vec();
        out.push(row);
        out.extend_from_slice(&lines[last_row + 1..]);
        return out.join("\n") + "\n";
    }
    let mut text = text.to_string();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    if !text.ends_with("\n\n") {
        text.push('\n');
    }
    text.push_str(&section_header(r, decks));
    text.push_str(row);
    text.push('\n');
    text
}

/// `docs/yardstick.md` に 1 行足す
fn record(r: Reference, row: &str, decks: &[String]) -> Result<(), String> {
    let path = doc_path();
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{path} を読めません: {e}"))?;
    std::fs::write(&path, with_row(&text, r, row, decks))
        .map_err(|e| format!("{path} に書けません: {e}"))
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let mut argv = argv.to_vec();
    let kifu_target = kifu::take_args(&mut argv)?;
    let argv = &argv[..];
    let mut r = Reference::Classic;
    let mut opts_text = "{}".to_string();
    let mut games = 1000u32;
    let mut start = 0u32;
    let mut label = String::new();
    let mut write = false;
    let mut no_ledger = false;
    let only_fingerprint = argv.first().map(|s| s.as_str()) == Some("fingerprint");
    let mut i = only_fingerprint as usize;
    while i < argv.len() {
        let value = |i: usize| {
            argv.get(i + 1)
                .cloned()
                .ok_or_else(|| format!("{} の値がありません", argv[i]))
        };
        let int = |s: String| {
            s.parse::<u32>()
                .map_err(|_| format!("0 以上の整数を渡します: {s}"))
        };
        match argv[i].as_str() {
            "--ref" => r = Reference::parse(&value(i)?)?,
            "--opts" if !only_fingerprint => opts_text = value(i)?,
            "--games" if !only_fingerprint => games = int(value(i)?)?,
            "--start" if !only_fingerprint => start = int(value(i)?)?,
            "--label" if !only_fingerprint => label = value(i)?,
            "--record" if !only_fingerprint => {
                write = true;
                i += 1;
                continue;
            }
            "--no-ledger" if !only_fingerprint => {
                no_ledger = true;
                i += 1;
                continue;
            }
            a => return Err(format!("未知の引数: {a}")),
        }
        i += 2;
    }
    if only_fingerprint {
        let f = fingerprint_of(r);
        println!(
            "{} の指紋: {f}（記録してある指紋 {}）",
            r.title(),
            r.recorded()
        );
        return Ok(());
    }
    if games == 0 {
        return Err("--games は 1 以上".into());
    }
    if write && label.is_empty() {
        return Err("--record には --label で名前を付けます".into());
    }
    let subject = compare_options(&opts_text).map_err(|e| format!("--opts: {e}"))?;
    let decks = r.decks();
    let fp = fingerprint_of(r);
    let fingerprint_ok = fp == r.recorded();
    if !fingerprint_ok {
        let msg = format!(
            "{} の相手の手が変わっています（指紋 {fp}、記録してある指紋 {}）。src/runner/yardstick.rs の先頭の説明を見る",
            r.title(),
            r.recorded()
        );
        if write {
            return Err(msg);
        }
        eprintln!("注意: {msg}");
    }
    let reference = r.options();
    let mirror = r.mirror();
    let tasks: Vec<(u32, bool)> = (0..games)
        .flat_map(|k| [(start + k, false), (start + k, true)])
        .collect();
    let t0 = Instant::now();
    // 棋譜（測る側が A、相手が B。相手は物差しの名前・版・指紋で書く）
    let run = kifu::RunInfo::now("yardstick", &label);
    let key = kifu::args_key(argv);
    let kifu_path = kifu_target.path(&kifu::Name {
        kind: "yardstick",
        label: &label,
        first: start,
        last: start + games - 1,
        key: &key,
        commit: &run.engine,
    });
    let mut writer = kifu_path.as_deref().map(kifu::Writer::create).transpose()?;
    let mut ref_seat = kifu::compare_seat("B", "{}");
    ref_seat.agent = format!("B {}", r.title());
    ref_seat.ai = crate::json::Json::Obj(vec![
        ("yardstick".into(), crate::json::Json::Str(r.title())),
        ("version".into(), crate::json::Json::Num(r.version() as f64)),
        ("fingerprint".into(), crate::json::Json::Str(fp.clone())),
    ]);
    ref_seat.nets = crate::json::Json::Null;
    let seats = [kifu::compare_seat("A", &opts_text), ref_seat];
    let kifu_run = writer.as_ref().map(|_| (&run, &seats));
    let results = parallel_map(
        &tasks,
        |&(g, swap), _| {
            play_compare_game_with(&subject, &reference, &decks, g, swap, mirror, kifu_run)
        },
        |done, total, r, _| {
            if let (Some(w), Some(line)) = (writer.as_mut(), r.2.as_ref()) {
                w.write(line);
            }
            if done % 200 == 0 || done == total {
                eprint!("\r{done}/{total}");
            }
        },
    );
    eprintln!();
    let results: Vec<(String, bool)> = results.into_iter().map(|(d, w, _)| (d, w)).collect();
    if let Some(w) = writer {
        let (p, n) = w.finish()?;
        println!("棋譜: {p}（{n} 試合）");
    }
    let n = results.len();
    let mut wins = 0;
    let mut per_deck = Tally::default();
    for d in &decks {
        per_deck.0.push((d.name.clone(), [0, 0]));
    }
    for (deck, won) in &results {
        wins += *won as u32;
        per_deck.add(deck, *won);
    }
    let p = wins as f64 / n as f64;
    // 鏡の組は 2 試合の結果が強く関係するので、組ごとの勝ち数のばらつきから標準誤差を出す（compare と同じ）
    let won: Vec<bool> = results.iter().map(|(_, w)| *w).collect();
    let (pairs, pair_se) = pair_stats(&tasks, &won);
    let se = if mirror {
        pair_se
    } else {
        (p * (1.0 - p) / n as f64).sqrt()
    };
    let secs = seconds_since(t0) / n as f64;
    println!(
        "{opts_text} vs {}: {wins}/{n} = {}%（標準誤差 ±{}）  {}s/試合",
        r.title(),
        fixed(p * 100.0, 1),
        fixed(se * 100.0, 1),
        fixed(secs, 2)
    );
    if mirror {
        println!(
            "組（同じシード）: 2 勝 {}・1 勝 {}・0 勝 {}",
            pairs[2], pairs[1], pairs[0]
        );
    }
    println!("{}", per_deck.line());
    if !no_ledger {
        use crate::json::Json;
        ledger::append(&ledger::Run {
            kind: "yardstick",
            argv: std::iter::once("yardstick".to_string())
                .chain(argv.iter().cloned())
                .collect(),
            label: label.clone(),
            a: opts_text.clone(),
            b: r.key().into(),
            extra: vec![
                ("refVersion".into(), Json::Num(r.version() as f64)),
                ("refFingerprint".into(), Json::Str(fp.clone())),
                ("refFingerprintOk".into(), Json::Bool(fingerprint_ok)),
                ("recorded".into(), Json::Bool(write)),
                ("kifu".into(), kifu::ledger_name(kifu_path.as_ref())),
            ],
            decks: decks.iter().map(|d| d.name.clone()).collect(),
            mirror,
            first: start,
            last: start + games - 1,
            n: n as u32,
            wins,
            se,
            se_kind: if mirror { "pairs" } else { "binomial" },
            pairs,
            per_deck: per_deck.0.clone(),
            seconds: seconds_since(t0),
        });
    }
    if write {
        let date = command_line("date", &["+%Y-%m-%d"]).unwrap_or("?".into());
        let last = start + games - 1;
        let mut cells = vec![
            date,
            commit_label(),
            label.replace('|', "\\|"),
            format!("`{}`", opts_text.replace('|', "\\|")),
            format!("**{}%**", fixed(p * 100.0, 1)),
            fixed(se * 100.0, 1),
            format!("{n}（g{start}〜{last}）"),
        ];
        cells.extend(
            per_deck
                .0
                .iter()
                .map(|(_, [w, t])| format!("{}%", fixed(*w as f64 / *t as f64 * 100.0, 1))),
        );
        cells.push(format!("{}秒", fixed(secs, 2)));
        let names: Vec<String> = decks.iter().map(|d| d.name.clone()).collect();
        record(r, &format!("| {} |", cells.join(" | ")), &names)?;
        println!("docs/yardstick.md に記録しました");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 今の版の両方の節がある文書
    fn doc() -> String {
        format!(
            "# 物差し\n\n## {}（指紋 x）\n\n| a |\n| --- |\n| 1 |\n\n## {}（指紋 y）\n\n| a |\n| --- |\n| 2 |\n",
            Reference::Classic.title(),
            Reference::Strong.title()
        )
    }

    #[test]
    fn adds_a_row_to_its_own_section() {
        let decks: Vec<String> = Vec::new();
        let doc = with_row(&doc(), Reference::Classic, "| 3 |", &decks);
        let next = format!("| 1 |\n| 3 |\n\n## {}", Reference::Strong.title());
        assert!(doc.contains(&next), "{doc}");
        let doc = with_row(&doc, Reference::Strong, "| 4 |", &decks);
        assert!(doc.ends_with("| 2 |\n| 4 |\n"), "{doc}");
    }

    #[test]
    fn starts_a_section_when_missing() {
        let decks = vec!["リノセウスエルフ".to_string()];
        let doc = with_row("# 物差し\n", Reference::Strong, "| 5 |", &decks);
        let heading = format!("# 物差し\n\n## {}（指紋 ", Reference::Strong.title());
        assert!(doc.starts_with(&heading), "{doc}");
        assert!(
            doc.contains("| 日付 | コミット | 名前 | 設定 | 勝率 | ± | 試合 | エルフ | 1 試合 |"),
            "{doc}"
        );
        assert!(doc.ends_with("| 5 |\n"), "{doc}");
    }
}
