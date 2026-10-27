//! 2 ターン以上の計画が効きそうな局面を手で作り、候補のターンごとに「今の AI の点数」「2 ターン先まで読んだ点数」「最後まで打った勝率」を比べる（2026-10-27）。
//!
//!   svwb two-turn show [--only <名前,…>] [--sandbox <フォルダ>]
//!   svwb two-turn run --out t.jsonl [--only <名前,…>] [--m 64] [--reads 4] [--twos 2] [--nextBeam 256] [--seed 1]
//!   svwb two-turn report t.jsonl… [--only <名前,…>]
//!
//! 今の AI は、自分のターンを打った後に相手のターンを 1 回読んだ局面を採点する（「読み直し」）。次の自分のターン以降は読まないので、
//! 「次のターンにリーサルを取るために手札を残す」「次のターンのエンハンスのためにカードを残す」「次のターンのために場を空けておく」のような
//! 2 ターン以上の計画は、評価関数（手で作った評価＋学習した補正）がその価値を知っているときにだけ選べる。
//! ここでは、そういう計画が効きそうな局面を手で作り（[`SCENARIOS`]）、候補のターン（今の AI がそのまま打つターンと、計画の形に縛ったターン）ごとに次を測る。
//!
//! - **AI の点数**: 今の AI が手を選ぶときの点数（ターン末の点数と、相手の手札を引き直して相手のターンを読んだ点数を `rescoreMix` で混ぜたもの）
//! - **読み直し**: 相手のターンを読んだ後の点数だけ
//! - **次のターン末**: その後の自分の次のターンを打ったターン末の点数（10-18 の `ownNext` と同じ形。最後に動く側の楽観が入る）
//! - **2 ターン読み**: さらに相手の次のターンを読んだ後の点数（自分・相手・自分・相手と打った局面。`SearchAgent::two_turn_read`）
//! - **最後まで打った勝率**: そのターンを打った後、続きを今の AI どうしで最後まで打った勝ち負け（本当の値の目安。今の AI が続きを打つときの値）
//!
//! 点数はどれも、学習した補正の a で σ(a·点数) を引き直しごとに求めてから平均した勝率にする（`deep_gap::win_pct`。相手のリーサルのある引き直しが平均を壊さないため）。
//! 候補は「最初に打つ手の並び（カードの名前で書く）」と「このターンに打たない手（プレイしないカード・リーダーへの攻撃・進化・超進化）」で書き、
//! 残りは今の AI が打つ。手番の側から見た決定化を `--m` 通り作り、r 通り目はどの候補も同じ決定化・同じ乱数で打つ（候補どうしの差のぶれを減らす）。
//!
//! 局面は、このファイルに書いたデッキ・シードの今の AI どうしの自己対戦を、自分（席 0）の決めたターンの最初まで打ち、手札・場・体力・PP・EP 等を書き換えて作る
//! （墓場・山札の枚数、相手の手札の枚数、相手のまだ見えていないカードは自己対戦のまま）。実際の対戦の局面を入れる口は無い（CLAUDE.md「ソフト打ち」）。

use super::deep_gap::{
    check_flags, describe, ends_cleanly, finish, flag, num_flag, open_append, parse_flags,
    read_rows, same_end, steps_of, win_pct,
};
use super::fixed;
use super::human_plan::{is_start_of_turn, mean_se, mix};
use super::options::compare_options;
use super::parallel::parallel_map;
use crate::ai::determinize::determinize;
use crate::ai::exact_lethal::reset_exact_lethal_cache;
use crate::ai::lethal::reset_lethal;
use crate::ai::search::{Allow, SearchAgent, SearchOptions};
use crate::ai::{Agent, Rng};
use crate::data::{data, CardIdx, BARRIER};
use crate::game::{acting_player, apply_legal, create_game, legal_actions};
use crate::json::Json;
use crate::state::{leader_id, opponent, Action, Evolve, GameState, Phase, PlayerIndex};
use crate::state_json::{state_from_json, state_to_json};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;
use std::time::Instant;

/// 自分の席（局面を作る自己対戦で、自分のデッキを席 0 に置く）
const ME: PlayerIndex = 0;

/// 候補のターンの最初に打つ手（カードの名前で書く。名前の合う最初の打てるカードを使う）
#[derive(Clone, Copy, Debug)]
#[allow(dead_code)] // 局面を足すときに使う形も残す
enum Step {
    /// 手札のカードをプレイ
    Play(&'static str),
    /// 自分の場のフォロワーで攻撃（None なら相手のリーダー）
    Attack(&'static str, Option<&'static str>),
    Evolve(&'static str),
    SuperEvolve(&'static str),
    /// 自分の場のアミュレットの能力
    Act(&'static str),
    /// 選択待ちで、相手の場のカード（None なら相手のリーダー）1 枚を選ぶ
    Choose(Option<&'static str>),
    /// 選択待ちで、モードを選ぶ（0 から数える）
    Mode(usize),
}

/// 候補のターン
#[derive(Clone, Debug, Default)]
struct Cand {
    name: &'static str,
    desc: &'static str,
    /// 最初に打つ手（選択待ちは今の AI が選ぶ）
    prefix: Vec<Step>,
    /// このターンにプレイしないカード
    no_play: Vec<&'static str>,
    /// このターンにリーダーを攻撃しない
    no_face: bool,
    /// このターンに進化しない
    no_evolve: bool,
    /// このターンに超進化しない
    no_super: bool,
}

/// 今の AI がそのまま打つ候補
fn ai_cand() -> Cand {
    Cand {
        name: "AI",
        desc: "今の AI がそのまま打つ",
        ..Cand::default()
    }
}

/// 場に置くフォロワー・アミュレット
#[derive(Clone, Copy, Debug)]
struct Put {
    name: &'static str,
    /// 攻撃力・体力を書き換える（None ならカードのまま）
    stats: Option<(i32, i32)>,
    /// このターンに出たばかり（攻撃できない）
    fresh: bool,
    evolve: Evolve,
    /// 土の印の数（土の印のアミュレット）
    sigils: Option<i32>,
    /// バリアを持つ
    barrier: bool,
}

const fn put(name: &'static str) -> Put {
    Put {
        name,
        stats: None,
        fresh: false,
        evolve: Evolve::None,
        sigils: None,
        barrier: false,
    }
}

/// 手札に置くカード（スペルブーストの回数・X を持たせる）
#[derive(Clone, Copy, Debug)]
struct HandSpec {
    name: &'static str,
    boosts: i32,
    /// コストの増減（スペルブーストでコストが下がるカードは自分で書く）
    cost_mod: i32,
}

const fn hand(name: &'static str) -> HandSpec {
    HandSpec {
        name,
        boosts: 0,
        cost_mod: 0,
    }
}

/// 局面の書き換え（None の項目は自己対戦のまま）
#[derive(Clone, Debug, Default)]
struct Edit {
    my_hp: Option<i32>,
    opp_hp: Option<i32>,
    /// 自分の PP 最大値（PP も同じ値にする）
    max_pp: Option<i32>,
    /// 自分の今の PP（max_pp の後に書く）
    pp: Option<i32>,
    ep: Option<i32>,
    sep: Option<i32>,
    my_hand: Vec<HandSpec>,
    my_board: Vec<Put>,
    opp_board: Vec<Put>,
    /// 相手の手札（空なら自己対戦のまま）
    opp_hand: Vec<HandSpec>,
    /// 相手の手札の枚数（多い分を山札に戻す）
    opp_hand_count: Option<usize>,
    /// 相手の PP 最大値・EP・SEP
    opp_max_pp: Option<i32>,
    opp_ep: Option<i32>,
    opp_sep: Option<i32>,
}

struct Scenario {
    name: &'static str,
    title: &'static str,
    /// 何を確かめる局面か
    note: &'static str,
    /// 自分・相手のデッキ
    decks: [&'static str; 2],
    /// 自己対戦のシード（試合が途中で終わったら次のシードを試す）
    seed: u32,
    /// 自分のターン数（このターンの最初まで打つ）
    turn: i32,
    /// 自分が先攻か（None ならどちらでも）
    first: Option<bool>,
    edit: fn() -> Edit,
    cands: fn() -> Vec<Cand>,
}

/// 手で作った局面の一覧
const SCENARIOS: &[Scenario] = &[
    Scenario {
        name: "dragon-genesis",
        title: "疾走ドラゴン: 次のターンのジェネシス（9 点の疾走）の射程に入れる",
        note: "PP 9。相手の体力 14。フォルテ（5 点の疾走）とウォーリアーで顔を 9 点削れば、次のターン（PP 10）にジェネシスで倒しきれる。盤面を取るか、顔を削るか",
        decks: ["疾走ドラゴン", "アマリアロイヤル"],
        seed: 11,
        turn: 9,
        first: None,
        edit: || Edit {
            my_hp: Some(18),
            opp_hp: Some(14),
            max_pp: Some(9),
            ep: Some(0),
            sep: Some(0),
            my_hand: vec![
                hand("再臨のジェネシスドラゴン"),
                hand("覇道の竜翼・フォルテ"),
                hand("駆け出しのドラゴンスレイヤー"),
                hand("烈火のファイアリザード"),
            ],
            my_board: vec![put("猛撃のドラゴンウォーリアー")],
            opp_board: vec![put("王断の天宮・スタチウム"), put("スティールナイト")],
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "race",
                    desc: "フォルテを出し、フォルテとウォーリアーで顔を攻撃（残りは AI）",
                    prefix: vec![
                        Step::Play("覇道の竜翼・フォルテ"),
                        Step::Attack("覇道の竜翼・フォルテ", None),
                        Step::Attack("猛撃のドラゴンウォーリアー", None),
                    ],
                    ..Cand::default()
                },
                Cand {
                    name: "control",
                    desc: "顔を攻撃しない（残りは AI）",
                    no_face: true,
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "elf-rhino-hold",
        title: "リノセウスエルフ: 次のターンにリノセウスで倒しきるため、フェアリーと招集を残す",
        note: "PP 7（次は 8）。相手の体力 6、場に守護のオルトロス。次のターンに 招集→フェアリー 4 枚→リノセウス（コンボ 6）で、フェアリーで守護を倒して 6 点。今のターンにフェアリーで盤面を取るか、残すか",
        decks: ["リノセウスエルフ", "ミッドレンジナイトメア"],
        seed: 21,
        turn: 7,
        first: None,
        edit: || Edit {
            my_hp: Some(20),
            opp_hp: Some(6),
            max_pp: Some(7),
            ep: Some(0),
            sep: Some(0),
            my_hand: vec![
                hand("殺戮のリノセウス"),
                hand("妖精の招集"),
                hand("フェアリー"),
                hand("フェアリー"),
                hand("純粋なるウォーターフェアリー"),
                hand("薫交の天宮・バックウッド"),
            ],
            my_board: vec![],
            opp_board: vec![put("辣腕の死神・ミーノ"), put("燃え盛る魔剣・オルトロス")],
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "hold",
                    desc: "リノセウス・招集・フェアリーをプレイしない（残りは AI）",
                    no_play: vec!["殺戮のリノセウス", "妖精の招集", "フェアリー"],
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "dragon-genesis2",
        title: "疾走ドラゴン: ジェノを残してでも、次のターンのジェネシスの射程に入れる",
        note: "dragon-genesis の相手の場をジェノ（7/6・2 回攻撃）にしたもの。PP 9 ではフォルテ（6）とドラゴンスレイヤー（4）を両方は出せない。ジェノを倒すか、顔を 9 点削るか",
        decks: ["疾走ドラゴン", "アマリアロイヤル"],
        seed: 11,
        turn: 9,
        first: None,
        edit: || Edit {
            my_hp: Some(18),
            opp_hp: Some(14),
            max_pp: Some(9),
            ep: Some(0),
            sep: Some(0),
            my_hand: vec![
                hand("再臨のジェネシスドラゴン"),
                hand("覇道の竜翼・フォルテ"),
                hand("駆け出しのドラゴンスレイヤー"),
                hand("烈火のファイアリザード"),
            ],
            my_board: vec![put("猛撃のドラゴンウォーリアー")],
            opp_board: vec![put("レヴィオンアックス・ジェノ"), put("スティールナイト")],
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "race",
                    desc: "フォルテを出し、フォルテとウォーリアーで顔を攻撃（残りは AI）",
                    prefix: vec![
                        Step::Play("覇道の竜翼・フォルテ"),
                        Step::Attack("覇道の竜翼・フォルテ", None),
                        Step::Attack("猛撃のドラゴンウォーリアー", None),
                    ],
                    ..Cand::default()
                },
                Cand {
                    name: "control",
                    desc: "ドラゴンスレイヤーでジェノを壊し、顔を攻撃しない（残りは AI）",
                    prefix: vec![
                        Step::Play("駆け出しのドラゴンスレイヤー"),
                        Step::Choose(Some("レヴィオンアックス・ジェノ")),
                    ],
                    no_face: true,
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "elf-rhino-hold2",
        title: "リノセウスエルフ: フェアリーで取れる相手の場があっても、次のターンのリノセウスのために残す",
        note: "elf-rhino-hold の相手の場にスケルトン 2 体を足したもの。フェアリーでスケルトンを取ると、次のターンのリノセウス（招集→フェアリー 4 枚→リノセウスでコンボ 6）が届かない",
        decks: ["リノセウスエルフ", "ミッドレンジナイトメア"],
        seed: 21,
        turn: 7,
        first: None,
        edit: || Edit {
            my_hp: Some(20),
            opp_hp: Some(6),
            max_pp: Some(7),
            ep: Some(0),
            sep: Some(0),
            my_hand: vec![
                hand("殺戮のリノセウス"),
                hand("妖精の招集"),
                hand("フェアリー"),
                hand("フェアリー"),
                hand("純粋なるウォーターフェアリー"),
                hand("薫交の天宮・バックウッド"),
            ],
            my_board: vec![],
            opp_board: vec![
                put("辣腕の死神・ミーノ"),
                put("燃え盛る魔剣・オルトロス"),
                put("スケルトン"),
                put("スケルトン"),
            ],
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "hold",
                    desc: "リノセウス・招集・フェアリーをプレイしない（残りは AI）",
                    no_play: vec!["殺戮のリノセウス", "妖精の招集", "フェアリー"],
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "witch-kuon10",
        title: "スペルウィッチ: クオンをエンハンス 10 まで待ち、超進化で貴人に疾走を付ける",
        note: "PP 9（次は 10）、SEP 1。相手の体力 10。次のターンにクオンをエンハンス 10 で出すと式神・貴人が 10/10 になり、クオンの超進化で疾走を付ければ 10 点。今のターンにクオンを出すか、残すか",
        decks: ["スペルウィッチ", "アマリアロイヤル"],
        seed: 31,
        turn: 9,
        first: None,
        edit: || Edit {
            my_hp: Some(18),
            opp_hp: Some(10),
            max_pp: Some(9),
            ep: Some(1),
            sep: Some(1),
            my_hand: vec![
                hand("五行の果て・クオン"),
                HandSpec {
                    name: "マナリアの学徒・ウィリアム",
                    boosts: 3,
                    cost_mod: 0,
                },
                HandSpec {
                    name: "ストームブラスト",
                    boosts: 2,
                    cost_mod: 0,
                },
                hand("知恵の輝き"),
                hand("熾天使の福音"),
            ],
            my_board: vec![],
            opp_board: vec![
                put("白銀の騎士団長・エミリア"),
                put("スティールナイト"),
                put("スティールナイト"),
            ],
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "hold-kuon",
                    desc: "クオンをプレイせず、超進化もしない（残りは AI）",
                    no_play: vec!["五行の果て・クオン"],
                    no_super: true,
                    ..Cand::default()
                },
                Cand {
                    name: "kuon-now",
                    desc: "クオンを先にプレイ（残りは AI）",
                    prefix: vec![Step::Play("五行の果て・クオン")],
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "royal-albert9",
        title: "アマリアロイヤル: アルベールをエンハンス 9 まで待つ",
        note: "PP 8（次は 9）。相手の場に小さなフォロワー 3 体。次のターンにアルベールをエンハンス 9 で出せば全体 3 ダメージと 2 回攻撃の疾走。今のターンにアルベールを出すか、残すか",
        decks: ["アマリアロイヤル", "ミッドレンジナイトメア"],
        seed: 41,
        turn: 8,
        first: None,
        edit: || Edit {
            my_hp: Some(18),
            opp_hp: Some(12),
            max_pp: Some(8),
            ep: Some(0),
            sep: Some(0),
            my_hand: vec![
                hand("レヴィオンの迅雷・アルベール"),
                hand("ミリタリードッグ"),
                hand("王家の御者"),
                hand("勇猛のルミナスランサー"),
            ],
            my_board: vec![put("スティールナイト")],
            opp_board: vec![
                put("ボーンガール"),
                put("悪辣のレッサーマミー"),
                put("辣腕の死神・ミーノ"),
            ],
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "hold-albert",
                    desc: "アルベールをプレイしない（残りは AI）",
                    no_play: vec!["レヴィオンの迅雷・アルベール"],
                    ..Cand::default()
                },
                Cand {
                    name: "albert-now",
                    desc: "アルベールを先にプレイ（残りは AI）",
                    prefix: vec![Step::Play("レヴィオンの迅雷・アルベール")],
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "royal-amalia-space",
        title: "アマリアロイヤル: 次のターンのアマリアのために場を空けておく",
        note: "PP 7（次は 8）。自分の場に 3 体。ルミナスメイジ（スティールナイト 3 体）を出すと場が埋まり、次のターンのアマリア（スティールナイト 4 体）が活きない",
        decks: ["アマリアロイヤル", "AFネメシス"],
        seed: 51,
        turn: 7,
        first: None,
        edit: || Edit {
            my_hp: Some(18),
            opp_hp: Some(15),
            max_pp: Some(7),
            ep: Some(1),
            sep: Some(2),
            my_hand: vec![
                hand("煌刃の勇者・アマリア"),
                hand("卓越のルミナスメイジ"),
                hand("王家の御者"),
                hand("剣士の斬撃"),
            ],
            my_board: vec![put("異端の侍"), put("ナイト"), put("スティールナイト")],
            opp_board: vec![put("アンストッパブルガンナー")],
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "keep-space",
                    desc: "ルミナスメイジをプレイしない（残りは AI）",
                    no_play: vec!["卓越のルミナスメイジ"],
                    ..Cand::default()
                },
                Cand {
                    name: "meiji",
                    desc: "ルミナスメイジを先にプレイ（残りは AI）",
                    prefix: vec![Step::Play("卓越のルミナスメイジ")],
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "witch-sigil",
        title: "スペルウィッチ: 土の印を貯めて、次のターンに理光の証明（全体 4 ダメージ）",
        note: "PP 5（次は 6）。相手はロイヤルで横に並べる。錬金釜とペネロピーで土の印を 3 つにすれば、次のターンに理光の証明の土の秘術で全体 4 ダメージ。アン＆グレアを出すか、土の印を貯めるか",
        decks: ["スペルウィッチ", "アマリアロイヤル"],
        seed: 61,
        turn: 5,
        first: None,
        edit: || Edit {
            my_hp: Some(18),
            opp_hp: Some(17),
            max_pp: Some(5),
            ep: Some(2),
            sep: Some(2),
            my_hand: vec![
                hand("理光の証明"),
                hand("魔女の錬金釜"),
                hand("魔法の薬剤師・ペネロピー"),
                hand("マナリアフレンズ・アン＆グレア"),
                hand("知恵の輝き"),
            ],
            my_board: vec![],
            opp_board: vec![put("ナイト"), put("スティールナイト"), put("異端の侍")],
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "sigils",
                    desc: "錬金釜・ペネロピーを先にプレイし、アン＆グレア・理光の証明はプレイしない（残りは AI）",
                    prefix: vec![
                        Step::Play("魔女の錬金釜"),
                        Step::Play("魔法の薬剤師・ペネロピー"),
                    ],
                    no_play: vec!["マナリアフレンズ・アン＆グレア", "理光の証明"],
                    ..Cand::default()
                },
                Cand {
                    name: "ann",
                    desc: "アン＆グレアを先にプレイ（残りは AI）",
                    prefix: vec![Step::Play("マナリアフレンズ・アン＆グレア")],
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "elf-staff",
        title: "リノセウスエルフ: 聖樹の杖を置く（ユーザーの指摘の形）",
        note: "PP 4。杖を置いてエンドか、フェアリー・リノセウスで盤面と顔を取るか。杖は置いた後のターンからコンボ 3 で毎ターン 1 枚引く",
        decks: ["リノセウスエルフ", "AFネメシス"],
        seed: 71,
        turn: 4,
        first: None,
        edit: || Edit {
            my_hp: Some(18),
            opp_hp: Some(19),
            max_pp: Some(4),
            ep: Some(2),
            sep: Some(2),
            my_hand: vec![
                hand("聖樹の杖"),
                hand("殺戮のリノセウス"),
                hand("フェアリー"),
                hand("妖精の招集"),
                hand("ベビーカーバンクル"),
                hand("燐光の岩"),
            ],
            my_board: vec![],
            opp_board: vec![put("マリオネットランサー"), put("ビビッドインベンター・イリス")],
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "staff",
                    desc: "聖樹の杖を先にプレイ（残りは AI）",
                    prefix: vec![Step::Play("聖樹の杖")],
                    ..Cand::default()
                },
                Cand {
                    name: "no-staff",
                    desc: "聖樹の杖をプレイしない（残りは AI）",
                    no_play: vec!["聖樹の杖"],
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "dragon-awaken",
        title: "疾走ドラゴン: 竜の啓示で次のターンに覚醒する",
        note: "PP 6。竜の啓示で PP 最大値を 7 にすれば、次のターン（PP 8）は覚醒で海溝の大剣竜が疾走、ドラゴニュートクラッシュが 4 ダメージ。啓示か、盤面か",
        decks: ["疾走ドラゴン", "アマリアロイヤル"],
        seed: 81,
        turn: 6,
        first: None,
        edit: || Edit {
            my_hp: Some(18),
            opp_hp: Some(13),
            max_pp: Some(6),
            ep: Some(1),
            sep: Some(2),
            my_hand: vec![
                hand("竜の啓示"),
                hand("海溝の大剣竜"),
                hand("ドラゴニュートクラッシュ"),
                hand("猛撃のドラゴンウォーリアー"),
                hand("竜育の少女"),
            ],
            my_board: vec![],
            opp_board: vec![put("スティールナイト"), put("王断の天宮・スタチウム")],
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "ramp",
                    desc: "竜の啓示を先にプレイ（残りは AI）",
                    prefix: vec![Step::Play("竜の啓示")],
                    ..Cand::default()
                },
                Cand {
                    name: "tempo",
                    desc: "竜の啓示をプレイしない（残りは AI）",
                    no_play: vec!["竜の啓示"],
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "nightmare-burn",
        title: "ミッドレンジナイトメア: 次のターンの蛇神の怒りで倒しきれるまで顔を削る",
        note: "PP 7、EP 1。相手の体力 12。アラガヴィを進化（リーダーすべてに 3）し蛇神の怒りとオルトロスで顔を削れば相手は 4 で、次のターンにもう 1 枚の蛇神とあと 1 点で倒しきれる。盤面を取るか、顔を削るか",
        decks: ["ミッドレンジナイトメア", "スペルウィッチ"],
        seed: 91,
        turn: 7,
        first: None,
        edit: || Edit {
            my_hp: Some(16),
            opp_hp: Some(12),
            max_pp: Some(7),
            ep: Some(1),
            sep: Some(0),
            my_hand: vec![
                hand("蛇神の怒り"),
                hand("蛇神の怒り"),
                hand("エンドレスハンター・アラガヴィ"),
                hand("死神の一振り"),
                hand("ボーンガール"),
            ],
            my_board: vec![put("燃え盛る魔剣・オルトロス")],
            opp_board: vec![put("アドラブルティーチャー・ミラ"), put("魔法の薬剤師・ペネロピー")],
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "burn",
                    desc: "アラガヴィを出して進化し、蛇神の怒りを 1 枚顔に（残りは AI）",
                    prefix: vec![
                        Step::Play("エンドレスハンター・アラガヴィ"),
                        Step::Evolve("エンドレスハンター・アラガヴィ"),
                        Step::Play("蛇神の怒り"),
                        Step::Choose(None),
                    ],
                    ..Cand::default()
                },
                Cand {
                    name: "control",
                    desc: "顔を攻撃しない（蛇神の怒りの顔は攻撃ではないので打てる。残りは AI）",
                    no_face: true,
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "witch-riko-wait",
        title: "スペルウィッチ: 理光の証明（全体 4）を次のターンまで我慢する（ユーザーの案）",
        note: "先攻 3 ターン目、PP 3。土の印 3 の大地の魔片がある。相手（ロイヤル）の場はルミナスランサー 1/2 とナイト 1/1 だけ。今打つと 2 体しか取れない。待てば相手が並べた後に打てる",
        decks: ["スペルウィッチ", "アマリアロイヤル"],
        seed: 101,
        turn: 3,
        first: Some(true),
        edit: || Edit {
            my_hp: Some(20),
            opp_hp: Some(20),
            max_pp: Some(3),
            ep: None,
            sep: None,
            my_hand: vec![
                hand("五行の果て・クオン"),
                hand("マナリアフレンズ・アン＆グレア"),
                hand("理光の証明"),
                hand("五行の果て・クオン"),
                hand("マナリアフレンズ・アン＆グレア"),
            ],
            my_board: vec![Put {
                sigils: Some(3),
                ..put("大地の魔片")
            }],
            opp_board: vec![put("勇猛のルミナスランサー"), put("ナイト")],
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "wait",
                    desc: "理光の証明をプレイしない（残りは AI）",
                    no_play: vec!["理光の証明"],
                    ..Cand::default()
                },
                Cand {
                    name: "riko-now",
                    desc: "理光の証明を全体 4 ダメージで打つ（残りは AI）",
                    prefix: vec![Step::Play("理光の証明"), Step::Mode(2)],
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "witch-kuon-pass",
        title: "スペルウィッチ: 次のターンに確定で勝てるので何もせずターンを終える（ユーザーの案）",
        note: "先攻 9 ターン目、PP 9、SEP 1。土の印 8。相手 HP 8 で場は超進化エミリア 7/7・バリアの御者・バリアのワルツで 3 面。\
               次のターンにクオン（エンハンス 10）で貴人 10/10 を出し、クオンの超進化で疾走を付ければ勝ち。\
               相手の回復はオリヴィエの 2 点まで、場が埋まっているので守護も 1 面まで。今クオンを超進化すると SEP がなくなり、\
               相手の場を減らすと守護が並ぶ",
        decks: ["スペルウィッチ", "アマリアロイヤル"],
        seed: 101,
        turn: 9,
        first: Some(true),
        edit: || Edit {
            my_hp: Some(18),
            opp_hp: Some(8),
            max_pp: Some(9),
            pp: None,
            ep: Some(0),
            sep: Some(1),
            my_hand: vec![
                hand("アドラブルティーチャー・ミラ"),
                hand("アドラブルティーチャー・ミラ"),
                hand("理光の証明"),
                hand("五行の果て・クオン"),
            ],
            my_board: vec![Put {
                sigils: Some(8),
                ..put("大地の魔片")
            }],
            opp_board: vec![
                Put {
                    evolve: Evolve::SuperEvolved,
                    ..put("白銀の騎士団長・エミリア")
                },
                Put {
                    barrier: true,
                    ..put("王家の御者")
                },
                Put {
                    barrier: true,
                    ..put("サイレントスナイパー・ワルツ")
                },
            ],
            opp_hand: vec![
                hand("勇壮の堕天使・オリヴィエ"),
                hand("レヴィオンアックス・ジェノ"),
                hand("白銀の騎士団長・エミリア"),
                hand("卓越のルミナスメイジ"),
            ],
            opp_max_pp: Some(8),
            opp_ep: Some(0),
            opp_sep: Some(0),
            opp_hand_count: None,
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "pass",
                    desc: "カードをプレイせず、進化もしない（大地の魔片のアクトは AI 任せ）",
                    no_play: vec![
                        "アドラブルティーチャー・ミラ",
                        "理光の証明",
                        "五行の果て・クオン",
                    ],
                    no_evolve: true,
                    no_super: true,
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "witch-od-hold",
        title: "スペルウィッチ: オーバーディメンションを温存し、次のターンにサタン → オーバーディメンション（ユーザーの案）",
        note: "先攻 9 ターン目、PP 0/9、SEP 1、体力 13。手札はコスト 0 のオーバーディメンション（スペルブースト 19）とサタン。\
               相手（ロイヤル、体力 20、PP 9）の場は御者・ジェノ 2 体・ルミナスメイジ・ルミナスランサー。今打てば 5 枚引いて PP 9 で動ける。\
               温存すれば次のターンにサタンでアポカリプスデッキにしてから打てる",
        decks: ["スペルウィッチ", "アマリアロイヤル"],
        seed: 101,
        turn: 9,
        first: Some(true),
        edit: || Edit {
            my_hp: Some(13),
            opp_hp: Some(20),
            max_pp: Some(9),
            pp: Some(0),
            ep: Some(0),
            sep: Some(1),
            my_hand: vec![
                HandSpec {
                    name: "オーバーディメンション",
                    boosts: 19,
                    cost_mod: -18,
                },
                hand("最果ての罪・サタン"),
            ],
            my_board: vec![],
            opp_board: vec![
                put("王家の御者"),
                put("レヴィオンアックス・ジェノ"),
                put("卓越のルミナスメイジ"),
                put("レヴィオンアックス・ジェノ"),
                put("勇猛のルミナスランサー"),
            ],
            opp_max_pp: Some(9),
            opp_ep: Some(0),
            opp_sep: Some(1),
            opp_hand_count: Some(5),
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "hold",
                    desc: "オーバーディメンションを打たない（次のターンにサタン → オーバーディメンション）",
                    no_play: vec!["オーバーディメンション"],
                    ..Cand::default()
                },
                Cand {
                    name: "od-now",
                    desc: "オーバーディメンションを今打つ（残りは AI）",
                    prefix: vec![Step::Play("オーバーディメンション")],
                    ..Cand::default()
                },
            ]
        },
    },
    Scenario {
        name: "witch-od-hold-safe",
        title: "スペルウィッチ: オーバーディメンションを温存する（相手の場にジェノがない形）",
        note: "witch-od-hold から相手のジェノ 2 体を除き、温存しても次の相手のターンに倒されない形にしたもの",
        decks: ["スペルウィッチ", "アマリアロイヤル"],
        seed: 101,
        turn: 9,
        first: Some(true),
        edit: || Edit {
            my_hp: Some(13),
            opp_hp: Some(20),
            max_pp: Some(9),
            pp: Some(0),
            ep: Some(0),
            sep: Some(1),
            my_hand: vec![
                HandSpec {
                    name: "オーバーディメンション",
                    boosts: 19,
                    cost_mod: -18,
                },
                hand("最果ての罪・サタン"),
            ],
            my_board: vec![],
            opp_board: vec![
                put("王家の御者"),
                put("卓越のルミナスメイジ"),
                put("勇猛のルミナスランサー"),
            ],
            opp_max_pp: Some(9),
            opp_ep: Some(0),
            opp_sep: Some(1),
            opp_hand_count: Some(5),
            ..Edit::default()
        },
        cands: || {
            vec![
                ai_cand(),
                Cand {
                    name: "hold",
                    desc: "オーバーディメンションを打たない（次のターンにサタン → オーバーディメンション）",
                    no_play: vec!["オーバーディメンション"],
                    ..Cand::default()
                },
                Cand {
                    name: "od-now",
                    desc: "オーバーディメンションを今打つ（残りは AI）",
                    prefix: vec![Step::Play("オーバーディメンション")],
                    ..Cand::default()
                },
            ]
        },
    },
];

fn card_id(name: &str) -> Result<CardIdx, String> {
    data()
        .cards
        .iter()
        .position(|c| c.name == name)
        .map(|i| i as CardIdx)
        .ok_or_else(|| format!("未知のカード: {name}"))
}

fn deck_cards(name: &str) -> Result<Vec<CardIdx>, String> {
    data()
        .decks
        .iter()
        .find(|d| d.name == name)
        .map(|d| d.cards.clone())
        .ok_or_else(|| format!("未知のデッキ: {name}"))
}

/// 今の AI どうしの自己対戦を、席 0 の turn ターン目の最初まで打つ（途中で試合が終われば None）
fn self_play_to(
    decks: [&[CardIdx]; 2],
    seed: u32,
    turn: i32,
    first: Option<bool>,
) -> Option<GameState> {
    reset_lethal();
    reset_exact_lethal_cache();
    let mut s = create_game(decks, seed);
    if first.is_some_and(|f| f != (s.first == ME)) {
        return None;
    }
    let mut agents = [
        SearchAgent::new(SearchOptions::default()),
        SearchAgent::new(SearchOptions::default()),
    ];
    let mut rng = Rng::new(seed ^ 0x9e3779b9);
    for _ in 0..5000 {
        if s.phase == Phase::Ended {
            return None;
        }
        if s.phase == Phase::Main
            && s.active == ME
            && s.players[ME].turn_count == turn
            && is_start_of_turn(&s)
            && acting_player(&s) == ME
        {
            return Some(s);
        }
        if s.players[ME].turn_count > turn {
            return None;
        }
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        let a = agents[actor].choose_action(&s, &legal, &mut rng);
        s = apply_legal(&s, &a);
    }
    None
}

/// 手札のカードを山札から 1 枚抜く（あれば）
fn take_from_deck(s: &mut GameState, p: PlayerIndex, c: CardIdx) {
    let deck = s.players[p].deck.make_mut();
    if let Some(i) = deck.iter().position(|r| r.card == c) {
        deck.remove(i);
    }
}

fn place(s: &mut GameState, q: PlayerIndex, b: &Put) -> Result<(), String> {
    let c = card_id(b.name)?;
    let mut x = s.new_board_card(c, None);
    if x.is_follower {
        if !b.fresh {
            x.entered_turn = 0;
        }
        match b.evolve {
            Evolve::None => {}
            Evolve::Evolved => {
                x.attack += 2;
                x.defense += 2;
                x.max_defense += 2;
            }
            Evolve::SuperEvolved => {
                x.attack += 3;
                x.defense += 3;
                x.max_defense += 3;
            }
        }
        x.evolve = b.evolve;
        if let Some((a, d)) = b.stats {
            x.attack = a;
            x.defense = d;
            x.max_defense = x.max_defense.max(d);
        }
    }
    if b.sigils.is_some() {
        x.sigils = b.sigils;
    }
    if b.barrier {
        x.keywords = x.keywords.with(BARRIER);
    }
    s.players[q].board.make_mut().push(x);
    Ok(())
}

/// 手札: 今の手札を山札に戻し、書いたカードを（山札にあれば山札から抜いて）入れる
fn set_hand(s: &mut GameState, p: PlayerIndex, hand: &[HandSpec]) -> Result<(), String> {
    let old: Vec<_> = s.players[p].hand.iter().cloned().collect();
    s.players[p].hand.make_mut().clear();
    for h in old {
        s.return_to_deck(p, h);
    }
    for hs in hand {
        let c = card_id(hs.name)?;
        take_from_deck(s, p, c);
        let mut h = s.new_hand_card(c, None);
        if hs.boosts > 0 {
            h.boosts = hs.boosts;
            if let Some(x) = h.x {
                h.x = Some(x + hs.boosts);
            }
        }
        h.cost_mod = hs.cost_mod;
        s.players[p].hand.make_mut().push(h);
    }
    Ok(())
}

/// 手で作った局面（席 0 の自分のターンの最初）
fn build(sc: &Scenario) -> Result<GameState, String> {
    let d0 = deck_cards(sc.decks[0])?;
    let d1 = deck_cards(sc.decks[1])?;
    let mut base = None;
    for k in 0..40 {
        if let Some(s) = self_play_to([&d0, &d1], sc.seed + k * 1000, sc.turn, sc.first) {
            base = Some(s);
            break;
        }
    }
    let mut s = base.ok_or_else(|| format!("{}: 局面を作る自己対戦が続きません", sc.name))?;
    let e = (sc.edit)();
    let o = opponent(ME);
    if let Some(v) = e.my_hp {
        s.players[ME].leader_hp = v;
    }
    if let Some(v) = e.opp_hp {
        s.players[o].leader_hp = v;
    }
    if let Some(v) = e.max_pp {
        s.players[ME].max_pp = v;
        s.players[ME].pp = v;
    }
    if let Some(v) = e.pp {
        s.players[ME].pp = v;
    }
    if let Some(v) = e.ep {
        s.players[ME].ep = v;
    }
    if let Some(v) = e.sep {
        s.players[ME].sep = v;
    }
    if let Some(v) = e.opp_max_pp {
        s.players[o].max_pp = v;
        s.players[o].pp = s.players[o].pp.min(v);
    }
    if let Some(v) = e.opp_ep {
        s.players[o].ep = v;
    }
    if let Some(v) = e.opp_sep {
        s.players[o].sep = v;
    }
    set_hand(&mut s, ME, &e.my_hand)?;
    if !e.opp_hand.is_empty() {
        set_hand(&mut s, o, &e.opp_hand)?;
    }
    if let Some(n) = e.opp_hand_count {
        while s.players[o].hand.len() > n {
            let h = s.players[o].hand.make_mut().pop().expect("手札");
            s.return_to_deck(o, h);
        }
    }
    s.players[ME].board.make_mut().clear();
    for b in &e.my_board {
        place(&mut s, ME, b)?;
    }
    s.players[o].board.make_mut().clear();
    for b in &e.opp_board {
        place(&mut s, o, b)?;
    }
    if !is_start_of_turn(&s) || s.active != ME {
        return Err(format!("{}: 自分のターンの最初になっていません", sc.name));
    }
    Ok(s)
}

fn allow_of(c: &Cand) -> Result<Option<Allow>, String> {
    if c.no_play.is_empty() && !c.no_face && !c.no_evolve && !c.no_super {
        return Ok(None);
    }
    let no_play: Vec<CardIdx> = c
        .no_play
        .iter()
        .map(|n| card_id(n))
        .collect::<Result<_, _>>()?;
    let (no_face, no_evolve, no_super) = (c.no_face, c.no_evolve, c.no_super);
    let f: Allow = Arc::new(move |s: &GameState, a: &Action, p: PlayerIndex| match a {
        Action::Play(iid) => s.players[p]
            .hand
            .iter()
            .find(|h| h.iid == *iid)
            .is_none_or(|h| !no_play.contains(&h.card)),
        Action::Attack { target: None, .. } => !no_face,
        Action::Evolve(_) => !no_evolve,
        Action::SuperEvolve(_) => !no_super,
        _ => true,
    });
    Ok(Some(f))
}

/// 最初に打つ手を、局面 s の合法手から探す
fn resolve(s: &GameState, p: PlayerIndex, step: &Step, legal: &[Action]) -> Result<Action, String> {
    let me = &s.players[p];
    let opp = &s.players[opponent(p)];
    let ids = |name: &str| -> Result<CardIdx, String> { card_id(name) };
    let found = match *step {
        Step::Play(n) => {
            let c = ids(n)?;
            me.hand
                .iter()
                .filter(|h| h.card == c)
                .map(|h| Action::Play(h.iid))
                .find(|a| legal.contains(a))
        }
        Step::Attack(n, t) => {
            let c = ids(n)?;
            let targets: Vec<Option<i32>> = match t {
                None => vec![None],
                Some(tn) => {
                    let tc = ids(tn)?;
                    opp.board
                        .iter()
                        .filter(|b| b.card == tc)
                        .map(|b| Some(b.iid))
                        .collect()
                }
            };
            me.board
                .iter()
                .filter(|b| b.card == c)
                .flat_map(|b| {
                    targets.iter().map(move |&target| Action::Attack {
                        attacker: b.iid,
                        target,
                    })
                })
                .find(|a| legal.contains(a))
        }
        Step::Evolve(n) => {
            let c = ids(n)?;
            me.board
                .iter()
                .filter(|b| b.card == c)
                .map(|b| Action::Evolve(b.iid))
                .find(|a| legal.contains(a))
        }
        Step::SuperEvolve(n) => {
            let c = ids(n)?;
            me.board
                .iter()
                .filter(|b| b.card == c)
                .map(|b| Action::SuperEvolve(b.iid))
                .find(|a| legal.contains(a))
        }
        Step::Act(n) => {
            let c = ids(n)?;
            me.board
                .iter()
                .filter(|b| b.card == c)
                .map(|b| Action::Act(b.iid))
                .find(|a| legal.contains(a))
        }
        Step::Mode(i) => Some(Action::Mode(i)).filter(|a| legal.contains(a)),
        Step::Choose(t) => {
            let targets: Vec<i32> = match t {
                None => vec![leader_id(opponent(p))],
                Some(tn) => {
                    let tc = ids(tn)?;
                    opp.board
                        .iter()
                        .filter(|b| b.card == tc)
                        .map(|b| b.iid)
                        .collect()
                }
            };
            targets
                .into_iter()
                .map(|i| Action::Choose(vec![i]))
                .find(|a| legal.contains(a))
        }
    };
    found.ok_or_else(|| format!("打てない手: {step:?}"))
}

/// 候補のターンを、局面 start から p がターンを終える手の直前まで打つ。打った手とターン末
fn play_cand(
    start: &GameState,
    p: PlayerIndex,
    c: &Cand,
    seed: u32,
    agent_opts: Option<&str>,
) -> Result<(Vec<Action>, GameState), String> {
    reset_lethal();
    reset_exact_lethal_cache();
    let base = match agent_opts {
        Some(t) => compare_options(t)?,
        None => SearchOptions::default(),
    };
    let opts = SearchOptions {
        allow: allow_of(c)?,
        ..base
    };
    let mut agent = SearchAgent::new(opts);
    let mut rng = Rng::new(seed);
    let mut t = start.clone();
    let mut done = Vec::new();
    let mut k = 0;
    for _ in 0..500 {
        if t.phase == Phase::Ended {
            return Ok((done, t));
        }
        if acting_player(&t) != p {
            return Err("ターンの途中で相手の手番になりました".into());
        }
        let legal = legal_actions(&t);
        let next_is_choose = matches!(c.prefix.get(k), Some(Step::Choose(_) | Step::Mode(_)));
        let a = if k < c.prefix.len() && (t.pending.is_none() != next_is_choose) {
            let a = resolve(&t, p, &c.prefix[k], &legal)?;
            k += 1;
            a
        } else {
            agent.choose_action(&t, &legal, &mut rng)
        };
        if matches!(a, Action::EndTurn) {
            return Ok((done, t));
        }
        t = apply_legal(&t, &a);
        done.push(a);
        if t.phase != Phase::Ended && t.active != p {
            return Err("ターンを終える手を打たずに相手の番になりました".into());
        }
    }
    Err("AI がターンを終えません".into())
}

struct RunConfig {
    m: u32,
    reads: u32,
    twos: u32,
    next_beam: usize,
    seed: u32,
    /// 候補のターンを打つ AI の設定（compare の設定の JSON。None なら既定）
    opts: Option<String>,
}

/// 局面 sc の r 通り目（決定化 1 つ）で、候補ごとにターンを打ち、点数と最後まで打った勝ち負けを書く
fn run_one(sc: &Scenario, state_text: &str, r: u32, cfg: &RunConfig) -> Result<Value, String> {
    let t0 = Instant::now();
    let start = state_from_json(&Json::parse(state_text)?)?;
    let p = ME;
    let base_seed = mix(cfg.seed, sc.seed);
    let det = determinize(&start, p, &mut Rng::new(mix(base_seed, 100 + r)), false);
    let scorer = SearchAgent::new(SearchOptions::default());
    let read_seeds: Vec<u32> = (0..cfg.reads)
        .map(|j| mix(base_seed, 10_000 + r * 64 + j))
        .collect();
    let mix_w = scorer.opts.rescore_mix;
    let mut out = Vec::new();
    let mut ends: Vec<Option<GameState>> = Vec::new();
    for c in (sc.cands)() {
        let res = catch_unwind(AssertUnwindSafe(|| {
            play_cand(&det, p, &c, mix(base_seed, 200 + r), cfg.opts.as_deref())
        }))
        .unwrap_or_else(|_| Err("途中で止まりました（panic）".into()));
        let (actions, end) = match res {
            Ok(x) => x,
            Err(e) => {
                out.push(json!({"c": c.name, "err": e}));
                ends.push(None);
                continue;
            }
        };
        // 今の AI の点数（手を選ぶときと同じ: 引き直しごとに、読み直した点数とターン末の点数を混ぜる）
        let reads = scorer.read_values(&end, p, &read_seeds);
        let te = if end.phase == Phase::Ended {
            None
        } else {
            Some(scorer.turn_end_value(&end, p))
        };
        let ai: Vec<f64> = reads
            .iter()
            .map(|&v| match te {
                Some(t) => (1.0 - mix_w) * v + mix_w * t,
                None => v,
            })
            .collect();
        let mut two = Vec::new();
        let mut own = Vec::new();
        let mut read1 = Vec::new();
        let mut lethal2 = 0;
        for j in 0..cfg.twos {
            let tr = catch_unwind(AssertUnwindSafe(|| {
                scorer.two_turn_read(&end, p, mix(base_seed, 20_000 + r * 64 + j), cfg.next_beam)
            }))
            .map_err(|_| "2 ターン読みが途中で止まりました（panic）".to_string())?;
            read1.push(tr.read);
            own.push(tr.own);
            two.push(tr.two);
            lethal2 += tr.next_lethal as u32;
        }
        reset_lethal();
        reset_exact_lethal_cache();
        let win = finish(&end, p, mix(base_seed, 30_000 + r));
        let mut row = json!({
            "c": c.name,
            "te": te,
            "ai": ai,
            "read": read1,
            "own": own,
            "two": two,
            "lethal2": lethal2,
            "win": win,
            "ended": end.phase == Phase::Ended,
        });
        if r < 3 {
            row["steps"] = json!(steps_of(&det, &actions, p));
        }
        out.push(row);
        ends.push(Some(end));
    }
    // 今の AI（最初の候補）と同じターン末になったか
    if let Some(Some(a_end)) = ends.first() {
        for (i, e) in ends.iter().enumerate() {
            if let Some(e) = e {
                out[i]["sameAi"] = json!(same_end(a_end, e));
            }
        }
    }
    Ok(json!({
        "s": sc.name, "r": r, "cands": out,
        "sec": (t0.elapsed().as_secs_f64() * 100.0).round() / 100.0,
    }))
}

fn pick(only: Option<&str>) -> Result<Vec<&'static Scenario>, String> {
    match only {
        None => Ok(SCENARIOS.iter().collect()),
        Some(list) => list
            .split(',')
            .map(|n| {
                SCENARIOS
                    .iter()
                    .find(|s| s.name == n)
                    .ok_or_else(|| format!("未知の局面: {n}"))
            })
            .collect(),
    }
}

fn cand_line(c: &Cand) -> String {
    let mut t = format!("`{}`: {}", c.name, c.desc);
    let mut extra = Vec::new();
    if !c.prefix.is_empty() {
        extra.push(format!("最初の手 {:?}", c.prefix));
    }
    if !c.no_play.is_empty() {
        extra.push(format!("プレイしない {}", c.no_play.join("・")));
    }
    if c.no_face {
        extra.push("リーダーを攻撃しない".into());
    }
    if c.no_evolve {
        extra.push("進化しない".into());
    }
    if c.no_super {
        extra.push("超進化しない".into());
    }
    if !extra.is_empty() {
        t += &format!("（{}）", extra.join("、"));
    }
    t
}

/// 局面の説明（Markdown の行）
fn scenario_text(sc: &Scenario, s: &GameState) -> Vec<String> {
    let decks = [sc.decks[0].to_string(), sc.decks[1].to_string()];
    let mut v = vec![format!("### `{}` {}", sc.name, sc.title), String::new()];
    v.push(format!("- {}", sc.note));
    for l in describe(s, ME, &decks) {
        v.push(format!("- {l}"));
    }
    v.push("- 候補:".into());
    for c in (sc.cands)() {
        v.push(format!("  - {}", cand_line(&c)));
    }
    v
}

/// svwb two-turn show
fn show(argv: &[String]) -> Result<(), String> {
    let (flags, rest) = parse_flags(argv)?;
    if !rest.is_empty() {
        return Err(format!("不明な引数: {}", rest.join(" ")));
    }
    check_flags(&flags, &["only", "sandbox"])?;
    let dir = flag(&flags, "sandbox");
    for sc in pick(flag(&flags, "only"))? {
        let s = build(sc)?;
        for l in scenario_text(sc, &s) {
            println!("{l}");
        }
        if let Some(d) = dir {
            // サンドボックス（開発サーバーだけ）の「局面を読み込む」に貼れる形
            let path = format!("{d}/{}.json", sc.name);
            let text = format!(
                "{{\"format\":\"svwb-sandbox\",\"version\":1,\"state\":{}}}\n",
                state_to_json(&s).stringify()
            );
            std::fs::write(&path, text).map_err(|e| format!("{path} に書けません: {e}"))?;
            println!("- サンドボックス用: {path}");
        }
        println!();
    }
    Ok(())
}

/// svwb two-turn run
fn run(argv: &[String]) -> Result<(), String> {
    let (flags, rest) = parse_flags(argv)?;
    if !rest.is_empty() {
        return Err(format!("不明な引数: {}", rest.join(" ")));
    }
    check_flags(
        &flags,
        &[
            "out", "only", "m", "reads", "twos", "nextBeam", "seed", "opts",
        ],
    )?;
    let out = flag(&flags, "out").ok_or("--out を渡してください")?;
    let cfg = RunConfig {
        m: num_flag(&flags, "m", 64)?.max(1),
        reads: num_flag(&flags, "reads", 4)?.max(1),
        twos: num_flag(&flags, "twos", 2)?.max(1),
        next_beam: num_flag(&flags, "nextBeam", 256)?.max(1) as usize,
        seed: num_flag(&flags, "seed", 1)?,
        opts: flag(&flags, "opts").map(str::to_string),
    };
    if let Some(t) = &cfg.opts {
        compare_options(t)?;
    }
    let scs = pick(flag(&flags, "only"))?;
    // 局面は先に作って JSON にしておく（局面はスレッドをまたげないため）
    let t0 = Instant::now();
    let built = parallel_map(
        &scs,
        |sc, _| build(sc).map(|s| state_to_json(&s).stringify()),
        |_, _, _, _| {},
    );
    let mut texts = Vec::new();
    for (sc, b) in scs.iter().zip(built) {
        texts.push((*sc, b?));
    }
    eprintln!(
        "局面 {} を作りました（{} 秒）",
        texts.len(),
        fixed(t0.elapsed().as_secs_f64(), 0)
    );
    let mut done: HashSet<(String, u64)> = HashSet::new();
    if std::path::Path::new(out).exists() {
        let rows = read_rows(out)?;
        for v in &rows {
            if let (Some(s), Some(r)) = (v["s"].as_str(), v["r"].as_u64()) {
                done.insert((s.to_string(), r));
            }
        }
        if !ends_cleanly(out) {
            let text: String = rows.iter().map(|v| format!("{v}\n")).collect();
            std::fs::write(out, text).map_err(|e| format!("{out} に書けません: {e}"))?;
        }
    }
    let mut items: Vec<(usize, u32)> = Vec::new();
    for (i, (sc, _)) in texts.iter().enumerate() {
        for r in 0..cfg.m {
            if !done.contains(&(sc.name.to_string(), r as u64)) {
                items.push((i, r));
            }
        }
    }
    let mut file = open_append(out)?;
    let header = json!({
        "config": {"m": cfg.m, "reads": cfg.reads, "twos": cfg.twos, "nextBeam": cfg.next_beam, "seed": cfg.seed, "opts": cfg.opts},
        "scenarios": texts.iter().map(|(sc, t)| json!({"s": sc.name, "state": t})).collect::<Vec<_>>(),
    });
    if done.is_empty() {
        let _ = writeln!(file, "{header}");
    }
    eprintln!("仕事 {}（済み {}）", items.len(), done.len());
    let t1 = Instant::now();
    let results = parallel_map(
        &items,
        |&(i, r), _| {
            let (sc, text) = &texts[i];
            run_one(sc, text, r, &cfg)
        },
        |n, total, res, _| {
            match res {
                Ok(v) => {
                    let _ = writeln!(file, "{v}");
                }
                Err(e) => eprintln!("{e}"),
            }
            if n % 8 == 0 || n == total {
                let sec = t1.elapsed().as_secs_f64();
                eprintln!(
                    "{n}/{total}（{} 秒、残り約 {} 分）",
                    fixed(sec, 0),
                    fixed(sec / n as f64 * (total - n) as f64 / 60.0, 0)
                );
            }
        },
    );
    let errors = results.iter().filter(|r| r.is_err()).count();
    println!(
        "完了: 仕事 {}（失敗 {errors}）、{} 秒",
        results.len(),
        fixed(t1.elapsed().as_secs_f64(), 0)
    );
    Ok(())
}

/// 引き直しごとの点数の列を勝率（0〜1）の平均にする
fn wins_of(v: &Value) -> Option<f64> {
    let xs: Vec<f64> = v.as_array()?.iter().filter_map(|x| x.as_f64()).collect();
    if xs.is_empty() {
        return None;
    }
    Some(xs.iter().map(|&x| win_pct(x) / 100.0).sum::<f64>() / xs.len() as f64)
}

/// 候補の行から、指標ごとの値（r 通り目の値。無ければ None）
fn metric(row: &Value, key: &str) -> Option<f64> {
    match key {
        "win" => row["win"].as_bool().map(|w| w as u8 as f64),
        "sameAi" => row["sameAi"].as_bool().map(|w| w as u8 as f64),
        "lethal2" => {
            let n = row["two"].as_array().map_or(0, |a| a.len()).max(1) as f64;
            row["lethal2"].as_f64().map(|x| x / n)
        }
        k => wins_of(&row[k]),
    }
}

const METRICS: [(&str, &str); 6] = [
    ("ai", "AI の点数"),
    ("read", "読み直し"),
    ("own", "次のターン末"),
    ("two", "2 ターン読み"),
    ("lethal2", "次のターンのリーサル"),
    ("win", "最後まで打った勝率"),
];

fn pm(m: f64, se: f64) -> String {
    if se.is_nan() {
        fixed(m * 100.0, 1)
    } else {
        format!("{} ± {}", fixed(m * 100.0, 1), fixed(se * 100.0, 1))
    }
}

/// svwb two-turn report
fn report(argv: &[String]) -> Result<(), String> {
    let (flags, rest) = parse_flags(argv)?;
    check_flags(&flags, &["only"])?;
    if rest.is_empty() {
        return Err("結果のファイルを渡してください".into());
    }
    let mut rows = Vec::new();
    let mut states: Vec<(String, String)> = Vec::new();
    let mut config = Value::Null;
    for path in &rest {
        for v in read_rows(path)? {
            if let Some(scs) = v["scenarios"].as_array() {
                config = v["config"].clone();
                for x in scs {
                    if let (Some(s), Some(t)) = (x["s"].as_str(), x["state"].as_str()) {
                        if !states.iter().any(|(n, _)| n == s) {
                            states.push((s.to_string(), t.to_string()));
                        }
                    }
                }
            } else if v["s"].is_string() {
                rows.push(v);
            }
        }
    }
    let scs = pick(flag(&flags, "only"))?;
    println!("# 2 ターン以上の計画が効きそうな局面（`svwb two-turn`）\n");
    println!("設定: {config}\n");
    println!(
        "値はどれも勝率（%）。「AI の点数」は今の AI が手を選ぶ点数、「読み直し」は相手のターンを読んだ後、「次のターン末」はその後の自分のターン末、\
         「2 ターン読み」はさらに相手のターンを読んだ後の点数を σ(a·点数) で勝率にしたもの。「最後まで打った勝率」は続きを今の AI どうしで打った勝ち負け。\
         差は今の AI（`AI`）との差で、同じ決定化どうしの対の差の平均 ± 標準誤差\n"
    );
    for sc in scs {
        let mine: Vec<&Value> = rows.iter().filter(|v| v["s"] == json!(sc.name)).collect();
        if mine.is_empty() {
            continue;
        }
        if let Some((_, t)) = states.iter().find(|(n, _)| n == sc.name) {
            let s = state_from_json(&Json::parse(t)?)?;
            for l in scenario_text(sc, &s) {
                println!("{l}");
            }
        }
        println!("- 決定化 {} 通り\n", mine.len());
        let cands = (sc.cands)();
        let row_of = |v: &Value, c: &str| -> Option<Value> {
            v["cands"]
                .as_array()?
                .iter()
                .find(|x| x["c"] == json!(c) && x["err"].is_null())
                .cloned()
        };
        // 値の表
        let mut head = "| 候補 | AI と同じターン |".to_string();
        let mut sep = "| --- | ---: |".to_string();
        for (_, label) in METRICS {
            head += &format!(" {label} |");
            sep += " ---: |";
        }
        println!("{head}\n{sep}");
        for c in &cands {
            let mut line = format!("| `{}` |", c.name);
            let same: Vec<f64> = mine
                .iter()
                .filter_map(|v| row_of(v, c.name))
                .filter_map(|x| metric(&x, "sameAi"))
                .collect();
            let (m, _) = mean_se(&same);
            line += &format!(" {}% |", fixed(m * 100.0, 0));
            for (k, _) in METRICS {
                let xs: Vec<f64> = mine
                    .iter()
                    .filter_map(|v| row_of(v, c.name))
                    .filter_map(|x| metric(&x, k))
                    .collect();
                let (m, se) = mean_se(&xs);
                line += &format!(" {} |", pm(m, se));
            }
            println!("{line}");
        }
        println!();
        // 今の AI との対の差
        if cands.len() > 1 {
            let mut head = "| 差（候補 − AI） | 対 |".to_string();
            let mut sep = "| --- | ---: |".to_string();
            for (_, label) in METRICS {
                head += &format!(" {label} |");
                sep += " ---: |";
            }
            println!("{head}\n{sep}");
            for c in &cands[1..] {
                let mut line = format!("| `{}` |", c.name);
                let mut n_pairs = 0;
                let mut cells = String::new();
                for (k, _) in METRICS {
                    let d: Vec<f64> = mine
                        .iter()
                        .filter_map(|v| {
                            let a = metric(&row_of(v, "AI")?, k)?;
                            let b = metric(&row_of(v, c.name)?, k)?;
                            Some(b - a)
                        })
                        .collect();
                    n_pairs = n_pairs.max(d.len());
                    let (m, se) = mean_se(&d);
                    cells += &format!(" {} |", pm(m, se));
                }
                line += &format!(" {n_pairs} |{cells}");
                println!("{line}");
            }
            println!();
        }
        // ターンの例
        for c in &cands {
            let ex: Vec<String> = mine
                .iter()
                .filter(|v| v["r"].as_u64().is_some_and(|r| r < 3))
                .filter_map(|v| row_of(v, c.name))
                .filter_map(|x| {
                    x["steps"].as_array().map(|a| {
                        a.iter()
                            .filter_map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join(" → ")
                    })
                })
                .collect();
            for (i, e) in ex.iter().enumerate() {
                println!(
                    "- `{}` の例 {}: {}",
                    c.name,
                    i + 1,
                    if e.is_empty() {
                        "（何もしない）"
                    } else {
                        e
                    }
                );
            }
        }
        let errs: Vec<String> = mine
            .iter()
            .flat_map(|v| v["cands"].as_array().cloned().unwrap_or_default())
            .filter_map(|x| {
                x["err"]
                    .as_str()
                    .map(|e| format!("{}: {e}", x["c"].as_str().unwrap_or("?")))
            })
            .collect();
        if !errs.is_empty() {
            println!("- 打てなかった候補 {} 回（例: {}）", errs.len(), errs[0]);
        }
        println!();
    }
    Ok(())
}

/// svwb two-turn trace --only <局面> --cand <候補> [--r 0] [--seed 1]: run と同じ決定化・乱数で、候補のターンと続きの試合の手を全部出す（確かめ用）
fn trace(argv: &[String]) -> Result<(), String> {
    let (flags, rest) = parse_flags(argv)?;
    if !rest.is_empty() {
        return Err(format!("不明な引数: {}", rest.join(" ")));
    }
    check_flags(&flags, &["only", "cand", "r", "seed", "opts"])?;
    let sc = pick(flag(&flags, "only"))?
        .into_iter()
        .next()
        .ok_or("--only を渡してください")?;
    let cname = flag(&flags, "cand").unwrap_or("AI");
    let c = (sc.cands)()
        .into_iter()
        .find(|c| c.name == cname)
        .ok_or_else(|| format!("未知の候補: {cname}"))?;
    let r = num_flag(&flags, "r", 0)?;
    let seed = num_flag(&flags, "seed", 1)?;
    let start = build(sc)?;
    let p = ME;
    let base_seed = mix(seed, sc.seed);
    let det = determinize(&start, p, &mut Rng::new(mix(base_seed, 100 + r)), false);
    let (actions, end) = play_cand(&det, p, &c, mix(base_seed, 200 + r), flag(&flags, "opts"))?;
    println!("## 候補 {}（決定化 {r}）", c.name);
    for t in steps_of(&det, &actions, p) {
        println!("- {t}");
    }
    if end.phase == Phase::Ended {
        println!("試合終了: 勝者 {:?}", end.winner);
        return Ok(());
    }
    reset_lethal();
    reset_exact_lethal_cache();
    let mut a0 = SearchAgent::new(SearchOptions::default());
    let mut a1 = SearchAgent::new(SearchOptions::default());
    let mut rng = Rng::new(mix(base_seed, 30_000 + r));
    let mut s = apply_legal(&end, &Action::EndTurn);
    let mut last_turn = -1;
    for _ in 0..10000 {
        if s.phase == Phase::Ended {
            break;
        }
        if s.turn != last_turn {
            last_turn = s.turn;
            let who = if s.active == p { "自分" } else { "相手" };
            println!(
                "## {who}のターン（自分 体力 {}・相手 体力 {}、手番の PP {}/{}）",
                s.players[p].leader_hp,
                s.players[opponent(p)].leader_hp,
                s.players[s.active].pp,
                s.players[s.active].max_pp
            );
        }
        let legal = legal_actions(&s);
        let actor = acting_player(&s);
        let a = if actor == 0 {
            a0.choose_action(&s, &legal, &mut rng)
        } else {
            a1.choose_action(&s, &legal, &mut rng)
        };
        println!("- {}", super::human_plan::step_text(&s, &a, p));
        s = apply_legal(&s, &a);
    }
    println!(
        "試合終了: 勝者 {:?}（自分 体力 {}・相手 体力 {}）",
        s.winner,
        s.players[p].leader_hp,
        s.players[opponent(p)].leader_hp
    );
    Ok(())
}

pub fn main(argv: &[String]) -> Result<(), String> {
    match argv.first().map(|s| s.as_str()) {
        Some("trace") => trace(&argv[1..]),
        Some("show") => show(&argv[1..]),
        Some("run") => run(&argv[1..]),
        Some("report") => report(&argv[1..]),
        _ => Err("使い方: svwb two-turn show|run|report …（runner/two_turn.rs）".into()),
    }
}
