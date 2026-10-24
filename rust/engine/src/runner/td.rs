//! TD 学習の自己対戦（TypeScript 版 scripts/td-main.ts の selfplay。npm run td -- selfplay と同じ試合・同じ JSON Lines）。
//!
//!   svwb td selfplay --model m0.json --games 2000 [--start 0] [--eps 0.1] [--opp greedy|beam] [--iv 0] [--ivZone hand|board|both|drawn] [--ivRes 0] [--imagined 0] [--sampling classic|default] [--cmp 0] [--rollouts 8] [--board 1] [--check 0] [--decks <デッキ>,…] [--vs <デッキ>] --out d0.jsonl
//!
//! --sampling default なら探索 AI の既定の読み方（ビームは 1 回・幅 128、上位の手の読み直しで相手の手札を 12 通り引き直す）で打つ
//! （既定の classic は今までの自己対戦と同じ、決定化 3 回・幅 32）。
//! --opp beam なら相手のターンを探索 AI の既定と同じビームサーチで読む（既定は貪欲法）。
//! --iv k なら、各試合で 1 つの自分のターンの最初（どちらかのプレイヤーの 3〜8 ターン目）から、手札のカードを 1 枚抜いた局面を
//! k 個（小数なら平均 k 個。抜くカードは別々）作り、そこから最後まで同じ --eps で打った試合も書き出す（"iv": {"p", "k", "card"} 付きの行。
//! k はもとの試合のその局面の添字）。カードを抜くのは打ち方と関係ないので、学習した補正が手札のカードの価値を
//! 相関で覚える偏り（勝っている局面にあったカードを高く見る等）を打ち消す方向に働くと考えた。docs/ai-notes.md「介入データを TD 学習に混ぜる」
//! --ivZone board なら、手札の代わりに場のカード（自分と相手の場のフォロワー・アミュレット）を 1 枚消す（"zone": "board" か "oppBoard" が付く）。
//! both なら手札と場のカードを合わせた中から選ぶ。
//! drawn なら、ターンを 1〜10（1 ターン目は 5 倍の重み）から選び、そのターンの始めに引いたカード（1 ターン目は手札のどれでも）を
//! 手札から消す（"zone": "drawn"）。カードを引いた瞬間に抜くので、序盤のカードは序盤に引いたときの、フィニッシャーは引いてから最後まで
//! 持っている価値で測り、実際に引くタイミングの割合で混ざる（デッキに 1 枚入れる価値に近い）。docs/ai-notes.md「引いた瞬間に抜く介入」
//! 場にいる間に働く能力の価値を、相関ではなく消した結果から学ばせる。docs/ai-notes.md「場のカードを消す介入を混ぜる」
//! --ivRes r なら、同じ局面から、資源（自分か相手の EP・SEP・リーダーの体力・PP 最大値のどれか 1 つ）を ±1 した局面も r 個（小数なら平均 r 個。
//! --iv とは別に数える）作り、最後まで打った試合も書き出す（"iv": {"p", "k", "res", "d", "zone": "res" か "oppRes"} 付きの行）。
//! 値はルールの範囲（EP・SEP は 0〜2、体力は 1〜上限、PP 最大値は 1〜10）に収まるものだけ。自分の PP 最大値を変えたときは今の PP も同じだけ変える。
//! 資源の価値を、相関（不利な側ほど SEP を使う等）ではなく変えた結果から学ばせる。--iv の試合は --ivRes があっても同じ。
//! docs/ai-notes.md「読みの中の相手のずれを学習で直す・資源の介入」
//!
//! --imagined k なら、各ターン末の局面の後に、そのターンに選んだ並びを探索が相手のターンまで読んだ想像の局面（自分の次のターンの最初。
//! 相手の手札の引き直しごとに 1 つ）から k 個を選んで書き出す（"ph": 2）。学習はその目標を、同じターンのターン末の局面と同じ
//! （本物の次の自分のターンの最初の局面からの λ 収益）にする。モデルには "imagined" の入力が要る（npm run td -- extend で足す）。
//! 打つ手は変わらない（同じ試合になる）。docs/ai-notes.md「読みの中の相手のずれを学習で直す・資源の介入」
//!
//! --cmp k なら、各試合で 1 つの自分のターンの最初（--iv と同じ選び方）から、探索が読んだ点数の高い順に最初の手の違う並びを k 個まで選び、
//! 並びごとにターン末から最後まで --rollouts 回打った勝ち数を書き出す（"cmp" 付きの行。打ち比べ）。r 回目はどの並びも同じ乱数で
//! 見えない情報を並べ直して打つので、手札や山札の運の大半が並びどうしで共通になり、並びの差だけが残る。最後まで打つのは相手のターンを
//! 貪欲法で読む探索 AI（ビームは 1 回・幅 128）。--iv とは一緒に使えない。docs/ai-notes.md「同じ局面からの手の比べ合いを学ぶ」
//!
//! --decks なら、比較用の 7 デッキの代わりに、並べたデッキ（デフォルトデッキの名前・キーか、デッキのテキストファイル。
//! deck-compare の --file と同じ形式）の全組を順に回す（n デッキなら試合 g は (g mod n, (g / n) mod n) の組）。
//! 学習した補正の知らないカードの入ったデッキを自己対戦に混ぜて学び直す用。デフォルトデッキと違うデッキのマリガンは、
//! 返し方ごとに引き直しを試して選ぶ（`mulligan: "sample"`。マリガンのモデルはデフォルトデッキしか知らない）。
//! docs/ai-notes.md「ロイヤルに勝ち越せるデッキを探す」
//! --vs <デッキ> なら、どの試合も片方がそのデッキで、もう片方（挑戦する側）は並べたデッキ（--decks か比較用の 7 デッキから
//! そのデッキを除いたもの）を順に回す（m デッキなら試合 g の挑戦する側は g mod m、(g / m) mod 2 が 0 なら挑戦する側が先攻）。
//! --iv・--cmp で介入するのは挑戦する側だけ。特定の相手との試合でのカードの価値を測る用。docs/ai-notes.md「ロイヤル対策 5 回目」
//!
//! 両方の席がモデルの評価で打つ探索 AI の自己対戦（7 デッキの全 49 組を順に回す）。各自分のターンの最初の局面（after）と
//! ターン末の局面（end）を、入力と出発点の評価の点数 S と一緒に、試合が終わった順に 1 試合 1 行で書き出す。
//! 書き出したファイルは `npm run td -- train` にそのまま渡せる（init・train・probe・prune は scripts/td-main.ts で行う）。
//!
//! 各局面には、場のカードの属性も書く（"b": [[自分の場], [相手の場]]。カード ID、攻撃力・体力・体力の上限、進化、キーワード、
//! 付与された能力、アミュレットのカウントダウン等。形は scripts/valueNet.ts の BoardCard）。学習の入力に直す前の値なので、
//! 入力の形を変えても自己対戦を作り直さずに学び直せる。--board 0 なら書かない（試合と他の項目は同じ）。
//! docs/ai-notes.md「自己対戦に場のカードの属性も書き出す」
//!
//! --check 1 なら、各局面にモデルの補正の値（評価の点数の単位）も書く（"z"）。`npm run td -- check` で、学習側（scripts/valueNet.ts）が
//! "x" と "b" から出す補正が探索の補正と同じかを確かめる（場のカードのネットワークを変えたとき用）。

use super::deck_compare::read_deck;
use super::options::model_eval;
use super::parallel::parallel_map;
use super::{compare_decks, fixed, seconds_since, Tally};
use crate::ai::aidata::{ai_data, weights_with};
use crate::ai::determinize::determinize;
use crate::ai::eval::{evaluate_with, EvalWeights};
use crate::ai::mulligan::default_deck_name_of;
use crate::ai::search::{MulliganMode, SearchAgent, SearchOptions};
use crate::ai::valuenet::{ValueNet, ValuePhase};
use crate::ai::{Agent, Rng};
use crate::data::{data, CardIdx, Deck};
use crate::game::{acting_player, apply_action, create_game, legal_actions, resolve_turn_end};
use crate::jsnum::{js_num, round_precision};
use crate::state::{
    next_random, opponent, Action, Evolve, GameState, Iid, OnBoard, Phase, PlayerIndex, EP, MAX_PP,
    SEP,
};
use crate::state_json::ability_json_text;
use std::io::Write;
use std::sync::Arc;
use std::time::Instant;

/// 自己対戦のシード（compare・rhino-compare の試合と重ならないように大きくする）
const SEED_BASE: u32 = 2_000_000;

fn parse_args(argv: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for pair in argv.chunks(2) {
        match pair {
            [k, v] if k.starts_with("--") => out.push((k[2..].to_string(), v.clone())),
            _ => return Err(format!("引数の形が違います: {}", pair[0])),
        }
    }
    Ok(out)
}

fn arg<'a>(args: &'a [(String, String)], k: &str) -> Option<&'a str> {
    // 同じ引数が 2 回あれば後のもの（TypeScript 版の Map）
    args.iter()
        .rev()
        .find(|(x, _)| x == k)
        .map(|(_, v)| v.as_str())
}

fn num_arg(args: &[(String, String)], k: &str, def: f64) -> Result<f64, String> {
    match arg(args, k) {
        None => Ok(def),
        Some(v) => v
            .parse::<f64>()
            .ok()
            .filter(|x| x.is_finite())
            .ok_or_else(|| format!("--{k} は数: {v}")),
    }
}

/// 自己対戦の設定（modelOptions）。補正が 0 のモデルは補正を足さず、相手のターンは貪欲法で読む
struct Model {
    net: Arc<ValueNet>,
    opts: SearchOptions,
    w: EvalWeights,
    /// 局面に場のカードの属性も書く（--board）
    board: bool,
    /// 局面にモデルの補正の値も書く（--check。学習側の計算が探索と同じかを npm run td -- check で確かめる）
    check: bool,
    /// ターン末の後に書く想像の局面の数（--imagined）
    imagined: usize,
}

fn model_options(net: Arc<ValueNet>, opp_beam: bool, classic: bool) -> Result<Model, String> {
    let weights = weights_with(&ai_data().search_weights_raw, &net.base_weights)?;
    let opts = SearchOptions {
        weights: Some(Arc::new(weights.clone())),
        extra_eval: if net.is_zero() {
            None
        } else {
            Some(model_eval(net.clone()))
        },
        // --opp beam なら探索 AI の既定と同じく、相手のターンをビームサーチで読む
        opponent_search: if opp_beam {
            SearchOptions::default().opponent_search
        } else {
            None
        },
        ..SearchOptions::default()
    };
    // 既定の読み方は今までの自己対戦と同じ（決定化 3 回・幅 32）。--sampling default なら探索 AI の既定の読み方
    let opts = if classic {
        opts.with_classic_sampling()
    } else {
        opts
    };
    Ok(Model {
        net,
        opts,
        w: EvalWeights::new(weights),
        board: false,
        check: false,
        imagined: 0,
    })
}

/// 1 試合の結果（JSON の 1 行と集計用の値）
struct Summary {
    line: String,
    decks: [String; 2],
    winner: PlayerIndex,
    turns: i32,
    samples: usize,
    explored: usize,
    /// 介入して打った試合の数（資源の介入を含む）
    ivs: usize,
    /// そのうち資源の介入の試合
    res_ivs: usize,
    /// 打ち比べた局面の数
    groups: usize,
}

/// 局面 1 つ（{"ph":…,"s":…,"x":[…],"v":[…]}、ランダムに打った局面は "ex":1、board なら場のカードの属性 "b" も）。
/// ph は 0: ターン末、1: 自分のターンの最初、2: 探索が相手のターンを読んだ後の想像の局面（--imagined）
fn write_sample(
    out: &mut String,
    m: &Model,
    s: &GameState,
    p: PlayerIndex,
    phase: ValuePhase,
    explored: bool,
    board: bool,
) {
    let x = m.net.encode(s, p, phase);
    out.push_str(&format!(
        "{{\"ph\":{},\"s\":{},\"x\":[",
        match phase {
            ValuePhase::End => 0,
            ValuePhase::After => 1,
            ValuePhase::Imagined => 2,
        },
        js_num(round_precision(evaluate_with(s, p, &m.w), 6))
    ));
    for (i, (k, _)) in x.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&k.to_string());
    }
    out.push_str("],\"v\":[");
    for (i, (_, v)) in x.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&js_num(round_precision(*v, 4)));
    }
    out.push(']');
    if explored {
        out.push_str(",\"ex\":1");
    }
    if board {
        write_board(out, s, p);
    }
    if m.check {
        out.push_str(&format!(
            ",\"z\":{}",
            js_num(round_precision(m.net.eval(s, p, phase), 12))
        ));
    }
    out.push('}');
}

/// 場のカードの属性（,"b":[[p の場],[相手の場]]、場の並び順）。学習の入力に直す前の値なので、入力の形を変えても
/// 自己対戦を作り直さずに学び直せる。形は scripts/valueNet.ts の BoardCard
fn write_board(out: &mut String, s: &GameState, p: PlayerIndex) {
    out.push_str(",\"b\":[");
    for (k, side) in [p, opponent(p)].into_iter().enumerate() {
        if k > 0 {
            out.push(',');
        }
        out.push('[');
        for (i, c) in s.players[side].board.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            write_board_card(out, c);
        }
        out.push(']');
    }
    out.push(']');
}

/// 場のカード 1 枚。既定の値の項目は書かない
fn write_board_card(out: &mut String, c: &OnBoard) {
    let cd = &data().cards[c.card as usize];
    out.push_str(&format!(
        "{{\"c\":{}",
        serde_json::to_string(&cd.id).expect("ID")
    ));
    if c.is_follower {
        // 元の攻撃力・体力（カードに書かれた値。進化の分もバフの扱い。docs/rules.md「進化・超進化」）はカード ID から分かるので書かない
        out.push_str(&format!(
            ",\"a\":{},\"d\":{},\"md\":{}",
            c.attack_value(),
            c.defense,
            c.max_defense
        ));
        match c.evolve {
            Evolve::None => {}
            Evolve::Evolved => out.push_str(",\"e\":1"),
            Evolve::SuperEvolved => out.push_str(",\"e\":2"),
        }
        if c.max_attacks != 1 {
            out.push_str(&format!(",\"ma\":{}", c.max_attacks));
        }
        if c.cannot_attack_until.is_some() {
            out.push_str(",\"na\":1");
        }
        if let Some(x) = c.x {
            out.push_str(&format!(",\"x\":{x}"));
        }
    } else {
        if let Some(n) = c.countdown {
            out.push_str(&format!(",\"cd\":{n}"));
        }
        if let Some(n) = c.sigils {
            out.push_str(&format!(",\"sg\":{n}"));
        }
    }
    let kw = c.keywords.with(c.temp_keywords);
    if !kw.is_empty() {
        out.push_str(&format!(
            ",\"k\":{}",
            serde_json::to_string(&kw.names()).expect("キーワード")
        ));
    }
    if !c.granted.is_empty() {
        let g: Vec<String> = c.granted.iter().map(|a| ability_json_text(a)).collect();
        out.push_str(&format!(",\"g\":[{}]", g.join(",")));
    }
    out.push('}');
}

/// 介入: 自分のターンの最初の局面で手札から 1 枚抜き、そこから最後まで打った試合も書き出す（--iv）
struct Intervention {
    /// 抜く側のプレイヤーと、その自分のターンの番号
    p: PlayerIndex,
    turn: i32,
    /// 1 つの局面から作る、抜くカードの違う局面の数
    variants: usize,
    /// 資源を ±1 した局面の数（--ivRes）
    res_variants: usize,
}

/// 介入で消すカードの場所（--ivZone）
#[derive(Clone, Copy, PartialEq)]
enum IvZone {
    Hand,
    Board,
    /// 手札と場のカードから選ぶ
    Both,
    /// そのターンの始めに引いたカード（1 ターン目は手札のどれでも）から選ぶ
    Drawn,
}

/// 介入で ±1 する資源（--ivRes）
#[derive(Clone, Copy, PartialEq, Debug)]
enum Res {
    Ep,
    Sep,
    Hp,
    MaxPp,
}

impl Res {
    const ALL: [Res; 4] = [Res::Ep, Res::Sep, Res::Hp, Res::MaxPp];

    fn name(self) -> &'static str {
        match self {
            Res::Ep => "ep",
            Res::Sep => "sep",
            Res::Hp => "hp",
            Res::MaxPp => "maxPp",
        }
    }
}

/// 局面 at（p の自分のターンの最初）で、ルールの範囲に収まる資源の ±1（側, 資源, 増減）
fn res_candidates(at: &GameState, p: PlayerIndex) -> Vec<(PlayerIndex, Res, i32)> {
    let mut out = Vec::new();
    for side in [p, opponent(p)] {
        let pl = &at.players[side];
        for r in Res::ALL {
            let (cur, lo, hi) = match r {
                Res::Ep => (pl.ep, 0, EP),
                Res::Sep => (pl.sep, 0, SEP),
                Res::Hp => (pl.leader_hp, 1, pl.leader_max_hp),
                Res::MaxPp => (pl.max_pp, 1, MAX_PP),
            };
            for d in [1, -1] {
                if (lo..=hi).contains(&(cur + d)) {
                    out.push((side, r, d));
                }
            }
        }
    }
    out
}

/// 資源を d だけ変える。手番のプレイヤーの PP 最大値なら今の PP も同じだけ変える（ターンの最初は PP 最大値まで回復しているので）
fn apply_res(s: &mut GameState, side: PlayerIndex, r: Res, d: i32) {
    let active = s.active == side;
    let pl = &mut s.players[side];
    match r {
        Res::Ep => pl.ep += d,
        Res::Sep => pl.sep += d,
        Res::Hp => pl.leader_hp += d,
        Res::MaxPp => {
            pl.max_pp += d;
            if active {
                pl.pp = (pl.pp + d).max(0);
            }
        }
    }
}

/// 局面から最後まで打った結果
struct Played {
    state: GameState,
    samples: [String; 2],
    counts: [usize; 2],
    explored: usize,
    /// 介入する局面と、そのときの p の局面の数（その局面の添字）
    branch: Option<(GameState, usize)>,
    /// 介入する局面で、そのターンの始めに引いた手札の iid（1 ターン目は手札のすべて）
    drawn: Vec<Iid>,
}

/// state から最後まで打ち、各自分のターンの最初とターン末の局面を記録する
fn play_out(
    g: u32,
    mut state: GameState,
    m: &Model,
    eps: f64,
    seed: u32,
    branch_at: Option<(PlayerIndex, i32)>,
) -> Played {
    let mut agent_rng = Rng::new(seed ^ 0x9e3779b9);
    let mut img_rng = Rng::new(seed ^ 0x3c6ef372);
    let mut explore = seed ^ 0x2545f491;
    let mut next_float = || {
        let (v, next) = next_random(explore);
        explore = next;
        v
    };
    // デフォルトデッキと違うデッキ（--decks）のマリガンは、返し方ごとに引き直しを試して選ぶ（マリガンのモデルはデフォルトデッキしか知らない）
    let agent = |p: PlayerIndex| {
        let mut o = m.opts.clone();
        if state.phase == Phase::Mulligan && default_deck_name_of(&state, p).is_none() {
            o.mulligan = MulliganMode::Sample;
        }
        SearchAgent::new(o)
    };
    let mut agents = [agent(0), agent(1)];
    let mut seen = [-1, -1];
    let mut samples = [String::new(), String::new()];
    let mut counts = [0usize; 2];
    let mut explored = 0;
    let mut branch = None;
    let mut drawn: Vec<Iid> = Vec::new();
    // 介入するプレイヤーの、相手のターンの間の山札（ターンの始めに引いたカードを見分ける）
    let mut pre_deck: Vec<Iid> = Vec::new();
    let mut n = 0;
    while state.phase != Phase::Ended {
        n += 1;
        if let Some((bp, _)) = branch_at {
            if state.active != bp && branch.is_none() {
                pre_deck.clear();
                pre_deck.extend(state.players[bp].deck.iter().map(|r| r.iid));
            }
        }
        assert!(n <= 10001, "試合 {g} のアクション数が上限を超えました");
        let legal = legal_actions(&state);
        let actor = acting_player(&state);
        let mut action: Option<Action> = None;
        let push = |samples: &mut [String; 2],
                    counts: &mut [usize; 2],
                    s: &GameState,
                    phase: ValuePhase,
                    ex: bool| {
            if counts[actor] > 0 {
                samples[actor].push(',');
            }
            counts[actor] += 1;
            write_sample(&mut samples[actor], m, s, actor, phase, ex, m.board);
        };
        // 自分のターンの最初の局面（相手のターンを読んだ後に探索が評価する局面と同じ）
        if state.phase == Phase::Main
            && state.pending.is_none()
            && state.active == actor
            && seen[actor] != state.players[actor].turn_count
        {
            seen[actor] = state.players[actor].turn_count;
            // 前のターンの読み（相手のターン中の選択で読んだもの等）は使わない
            agents[actor].take_reads(actor);
            if branch_at == Some((actor, state.players[actor].turn_count))
                && state.stack.is_empty()
                && state.queue.is_empty()
            {
                let pl = &state.players[actor];
                drawn = pl
                    .hand
                    .iter()
                    .filter(|h| pl.turn_count == 1 || pre_deck.contains(&h.iid))
                    .map(|h| h.iid)
                    .collect();
                branch = Some((state.clone(), counts[actor]));
            }
            let choices: Vec<&Action> = legal
                .iter()
                .filter(|a| !matches!(a, Action::EndTurn))
                .collect();
            if eps > 0.0 && !choices.is_empty() && next_float() < eps {
                action =
                    Some(choices[(next_float() * choices.len() as f64).floor() as usize].clone());
                explored += 1;
            }
            push(
                &mut samples,
                &mut counts,
                &state,
                ValuePhase::After,
                action.is_some(),
            );
        }
        let action = match action {
            Some(a) => a,
            None => agents[actor].choose_action(&state, &legal, &mut agent_rng),
        };
        if matches!(action, Action::EndTurn)
            && state.phase == Phase::Main
            && state.pending.is_none()
        {
            let end = resolve_turn_end(&state);
            let end = end.as_ref().unwrap_or(&state);
            if end.phase != Phase::Ended {
                push(&mut samples, &mut counts, end, ValuePhase::End, false);
                // そのターンに選んだ並びの想像の局面から m.imagined 個（試合の乱数とは別の乱数で選ぶ）
                let mut reads: Vec<_> = agents[actor]
                    .take_reads(actor)
                    .into_iter()
                    .filter(|x| x.phase != Phase::Ended)
                    .collect();
                for _ in 0..m.imagined.min(reads.len()) {
                    let x = reads.swap_remove(img_rng.int(reads.len()));
                    push(&mut samples, &mut counts, &x, ValuePhase::Imagined, false);
                }
            }
        }
        state = apply_action(&state, &action);
    }
    Played {
        state,
        samples,
        counts,
        explored,
        branch,
        drawn,
    }
}

/// 試合 1 つの JSON の 1 行（介入した試合は "iv" も）
fn record_line(g: u32, names: &[String; 2], r: &Played, iv: Option<String>) -> String {
    let winner = r
        .state
        .winner
        .unwrap_or_else(|| panic!("試合 {g} に勝者がいません"));
    format!(
        "{{\"g\":{g},\"decks\":[{},{}],\"winner\":{winner},\"turns\":{},{}\"samples\":[[{}],[{}]]}}",
        serde_json::to_string(&names[0]).expect("名前"),
        serde_json::to_string(&names[1]).expect("名前"),
        r.state.turn,
        iv.map(|x| format!("\"iv\":{x},")).unwrap_or_default(),
        r.samples[0],
        r.samples[1]
    )
}

/// 打ち比べの設定（--cmp・--rollouts）と、最後まで打つ探索 AI
struct Compare {
    k: usize,
    rollouts: usize,
    roll: Model,
}

/// state（p の手番）から、見えない情報を seed で並べ直してターンを終え、最後まで打って p が勝ったか
fn rollout_wins(end: &GameState, p: PlayerIndex, roll: &Model, seed: u32) -> bool {
    let mut rng = Rng::new(seed);
    let d = determinize(end, p, &mut rng, false);
    let mut state = apply_action(&d, &Action::EndTurn);
    let mut agents = [
        SearchAgent::new(roll.opts.clone()),
        SearchAgent::new(roll.opts.clone()),
    ];
    let mut agent_rng = Rng::new(seed ^ 0x9e3779b9);
    let mut n = 0;
    while state.phase != Phase::Ended {
        n += 1;
        assert!(n <= 10001, "打ち比べのアクション数が上限を超えました");
        let legal = legal_actions(&state);
        let actor = acting_player(&state);
        let action = agents[actor].choose_action(&state, &legal, &mut agent_rng);
        state = apply_action(&state, &action);
    }
    state.winner == Some(p)
}

/// 打ち比べ（--cmp）: 局面 at（p の自分のターンの最初）から、探索の点数の高い順に最初の手の違う並びを k 個まで選び、
/// 並びごとにターン末から最後まで打った勝ち数。並びが 2 つ未満なら None
fn compare_plans(
    at: &GameState,
    p: PlayerIndex,
    m: &Model,
    c: &Compare,
    seed: u32,
) -> Option<String> {
    let agent = SearchAgent::new(m.opts.clone());
    let mut rng = Rng::new(seed ^ 0x510e527f);
    // (探索の点数, ターン末の局面, 局面の JSON（場のカードの属性なし。同じ局面かの判定に使う）, 書き出す局面の JSON)
    let mut cands: Vec<(f64, GameState, String, String)> = Vec::new();
    for plan in agent.ranked_plans(at, p, &mut rng) {
        if cands.len() >= c.k {
            break;
        }
        let end = plan
            .steps
            .last()
            .map(|x| (*x.1).clone())
            .unwrap_or_else(|| at.clone());
        if end.phase == Phase::Ended || !legal_actions(&end).contains(&Action::EndTurn) {
            continue;
        }
        let settled = resolve_turn_end(&end);
        let label = settled.as_ref().unwrap_or(&end);
        if label.phase == Phase::Ended {
            continue;
        }
        let mut json = String::new();
        write_sample(&mut json, m, label, p, ValuePhase::End, false, false);
        // ターン末が同じ局面になる並び（入力と点数が同じ）は 1 つだけ（--board でも選ぶ並びは変えない）
        if cands.iter().any(|x| x.2 == json) {
            continue;
        }
        let full = if m.board {
            let mut full = String::new();
            write_sample(&mut full, m, label, p, ValuePhase::End, false, true);
            full
        } else {
            json.clone()
        };
        cands.push((plan.value, end, json, full));
    }
    if cands.len() < 2 {
        return None;
    }
    let mut wins = vec![0usize; cands.len()];
    for r in 0..c.rollouts {
        // r 回目はどの並びも同じ乱数
        let rs = seed ^ 0x9b05688c_u32.wrapping_mul(r as u32 + 1);
        for (i, (_, end, _, _)) in cands.iter().enumerate() {
            if rollout_wins(end, p, &c.roll, rs) {
                wins[i] += 1;
            }
        }
    }
    let list: Vec<String> = cands
        .iter()
        .zip(&wins)
        .map(|((v, _, _, json), w)| {
            format!(
                "{{\"val\":{},\"w\":{w},\"sample\":{json}}}",
                js_num(round_precision(*v, 6))
            )
        })
        .collect();
    Some(format!(
        "{{\"p\":{p},\"turn\":{},\"n\":{},\"cands\":[{}]}}",
        at.players[p].turn_count,
        c.rollouts,
        list.join(",")
    ))
}

/// 平均 x 個（小数部分は乱数で切り上げる）
fn count_of(x: f64, rng: &mut Rng) -> usize {
    x.floor() as usize + usize::from(rng.int(1000) < ((x.fract()) * 1000.0) as usize)
}

#[allow(clippy::too_many_arguments)]
fn play_one(
    g: u32,
    decks: &[&Deck],
    vs: Option<&Deck>,
    m: &Model,
    eps: f64,
    iv: f64,
    zone: IvZone,
    iv_res: f64,
    cmp: Option<&Compare>,
) -> Summary {
    let n = decks.len() as u32;
    // 2 つのデッキと、--vs のときの相手でない側（挑戦する側）の席
    let (pair, challenger): ([&Deck; 2], Option<PlayerIndex>) = match vs {
        None => (
            [decks[(g % n) as usize], decks[((g / n) % n) as usize]],
            None,
        ),
        Some(v) => {
            let c = decks[(g % n) as usize];
            if (g / n).is_multiple_of(2) {
                ([c, v], Some(0))
            } else {
                ([v, c], Some(1))
            }
        }
    };
    let seed = SEED_BASE + g;
    let state = create_game([&pair[0].cards, &pair[1].cards], seed);
    // 介入する試合・プレイヤー・ターン（自己対戦の乱数とは別の乱数で決める。--iv 0 なら今までと同じ試合）
    let mut ivr = Rng::new(seed ^ 0x6a09e667);
    // 資源の介入の数と選び方は別の乱数で決める（--ivRes があっても --iv の試合は同じ）
    let mut res_rng = Rng::new(seed ^ 0xbb67ae85);
    let plan = (iv > 0.0 || iv_res > 0.0).then(|| {
        let variants = count_of(iv, &mut ivr);
        // --vs なら介入するのは挑戦する側（乱数は同じだけ使う）
        let p = ivr.int(2);
        let p = challenger.unwrap_or(p);
        let turn = if zone == IvZone::Drawn {
            // 1〜10（1 ターン目は手札のどれでも選べるので 5 倍の重み）
            let r = ivr.int(14) as i32;
            if r < 5 {
                1
            } else {
                r - 3
            }
        } else {
            3 + ivr.int(6) as i32
        };
        Intervention {
            p,
            turn,
            variants,
            res_variants: if iv_res > 0.0 {
                count_of(iv_res, &mut res_rng)
            } else {
                0
            },
        }
    });
    // 打ち比べる局面（--iv と同じ選び方。--iv とは一緒に使わない）
    let cmp_at = cmp.map(|_| {
        let p = ivr.int(2);
        (challenger.unwrap_or(p), 3 + ivr.int(6) as i32)
    });
    let base = play_out(
        g,
        state,
        m,
        eps,
        seed,
        plan.as_ref()
            .filter(|x| x.variants + x.res_variants > 0)
            .map(|x| (x.p, x.turn))
            .or(cmp_at),
    );
    let names = [pair[0].name.clone(), pair[1].name.clone()];
    let winner = base
        .state
        .winner
        .unwrap_or_else(|| panic!("試合 {g} に勝者がいません"));
    let mut line = record_line(g, &names, &base, None);
    let mut samples = base.counts[0] + base.counts[1];
    let mut ivs = 0;
    let mut res_ivs = 0;
    let mut groups = 0;
    if let (Some(c), Some((p, _)), Some((at, _))) = (cmp, cmp_at, base.branch.as_ref()) {
        if at.players[p].hand.is_empty() {
            // 手札が無い局面は打ち比べない（手札を抜く介入と同じ局面の選び方）
        } else if let Some(info) = compare_plans(at, p, m, c, seed) {
            line.push_str(&format!(
                "\n{{\"g\":{g},\"decks\":[{},{}],\"cmp\":{info}}}",
                serde_json::to_string(&names[0]).expect("名前"),
                serde_json::to_string(&names[1]).expect("名前"),
            ));
            groups += 1;
        }
    }
    if let (Some(plan), Some((at, k))) = (plan, base.branch.as_ref()) {
        // 消すカード（側, 添字, 場所の名前）。同じ場所の同じカードは 1 回だけ。手札は p の手札、場は p と相手の場
        let card_at = |side: PlayerIndex, i: usize, name: &str| -> CardIdx {
            if name == "hand" || name == "drawn" {
                at.players[side].hand[i].card
            } else {
                at.players[side].board[i].card
            }
        };
        let mut cards: Vec<(PlayerIndex, usize, &'static str)> = Vec::new();
        let mut add = |side: PlayerIndex, i: usize, name: &'static str| {
            let card = card_at(side, i, name);
            if !cards
                .iter()
                .any(|&(s2, j, n2)| n2 == name && card_at(s2, j, n2) == card)
            {
                cards.push((side, i, name));
            }
        };
        if zone == IvZone::Drawn {
            for (i, h) in at.players[plan.p].hand.iter().enumerate() {
                if base.drawn.contains(&h.iid) {
                    add(plan.p, i, "drawn");
                }
            }
        } else if zone != IvZone::Board {
            for i in 0..at.players[plan.p].hand.len() {
                add(plan.p, i, "hand");
            }
        }
        if zone == IvZone::Board || zone == IvZone::Both {
            for (side, name) in [(plan.p, "board"), (1 - plan.p, "oppBoard")] {
                for i in 0..at.players[side].board.len() {
                    add(side, i, name);
                }
            }
        }
        for v in 0..plan.variants.min(cards.len()) {
            let (side, pick, name) = cards.swap_remove(ivr.int(cards.len()));
            let mut s = at.clone();
            let removed = if name == "hand" || name == "drawn" {
                s.players[side].hand.make_mut().remove(pick).card
            } else {
                s.players[side].board.make_mut().remove(pick).card
            };
            let r = play_out(
                g,
                s,
                m,
                eps,
                seed ^ (0x85ebca6b_u32.wrapping_mul(v as u32 + 1)),
                None,
            );
            let info = format!(
                "{{\"p\":{},\"k\":{k},\"card\":{}{}}}",
                plan.p,
                serde_json::to_string(&data().cards[removed as usize].id).expect("ID"),
                if name == "hand" {
                    String::new()
                } else {
                    format!(",\"zone\":\"{name}\"")
                }
            );
            line.push('\n');
            line.push_str(&record_line(g, &names, &r, Some(info)));
            samples += r.counts[0] + r.counts[1];
            ivs += 1;
        }
        // 資源を ±1 した局面（--ivRes）
        let mut res = res_candidates(at, plan.p);
        for v in 0..plan.res_variants.min(res.len()) {
            let (side, kind, d) = res.swap_remove(res_rng.int(res.len()));
            let mut s = at.clone();
            apply_res(&mut s, side, kind, d);
            let r = play_out(
                g,
                s,
                m,
                eps,
                seed ^ (0xc2b2ae35_u32.wrapping_mul(v as u32 + 1)),
                None,
            );
            let info = format!(
                "{{\"p\":{},\"k\":{k},\"res\":\"{}\",\"d\":{d},\"zone\":\"{}\"}}",
                plan.p,
                kind.name(),
                if side == plan.p { "res" } else { "oppRes" }
            );
            line.push('\n');
            line.push_str(&record_line(g, &names, &r, Some(info)));
            samples += r.counts[0] + r.counts[1];
            ivs += 1;
            res_ivs += 1;
        }
    }
    Summary {
        line,
        decks: names,
        winner,
        turns: base.state.turn,
        samples,
        explored: base.explored,
        ivs,
        res_ivs,
        groups,
    }
}

fn selfplay(args: &[(String, String)]) -> Result<(), String> {
    let model_path = arg(args, "model").ok_or("--model がありません")?;
    let out = arg(args, "out").ok_or("--out がありません")?;
    let games = num_arg(args, "games", 100.0)?;
    let start = num_arg(args, "start", 0.0)?;
    let eps = num_arg(args, "eps", 0.1)?;
    let iv = num_arg(args, "iv", 0.0)?;
    if iv < 0.0 {
        return Err("--iv は 0 以上".into());
    }
    let iv_res = num_arg(args, "ivRes", 0.0)?;
    if iv_res < 0.0 {
        return Err("--ivRes は 0 以上".into());
    }
    let imagined = num_arg(args, "imagined", 0.0)?;
    if imagined < 0.0 || imagined.fract() != 0.0 {
        return Err("--imagined は 0 以上の整数".into());
    }
    let zone = match arg(args, "ivZone").unwrap_or("hand") {
        "hand" => IvZone::Hand,
        "board" => IvZone::Board,
        "both" => IvZone::Both,
        "drawn" => IvZone::Drawn,
        x => return Err(format!("--ivZone は hand・board・both・drawn: {x}")),
    };
    let opp_beam = match arg(args, "opp").unwrap_or("greedy") {
        "greedy" => false,
        "beam" => true,
        x => return Err(format!("--opp は greedy か beam: {x}")),
    };
    if games < 0.0 || games.fract() != 0.0 || start < 0.0 || start.fract() != 0.0 {
        return Err("--games・--start は 0 以上の整数".into());
    }
    let classic = match arg(args, "sampling").unwrap_or("classic") {
        "classic" => true,
        "default" => false,
        x => return Err(format!("--sampling は classic か default: {x}")),
    };
    let cmp_k = num_arg(args, "cmp", 0.0)?;
    let rollouts = num_arg(args, "rollouts", 8.0)?;
    if cmp_k < 0.0
        || cmp_k.fract() != 0.0
        || cmp_k == 1.0
        || rollouts < 1.0
        || rollouts.fract() != 0.0
    {
        return Err("--cmp は 0 か 2 以上の整数、--rollouts は 1 以上の整数".into());
    }
    if cmp_k > 0.0 && (iv > 0.0 || iv_res > 0.0) {
        return Err("--cmp と --iv・--ivRes は一緒に使えません".into());
    }
    let board = match arg(args, "board").unwrap_or("1") {
        "1" => true,
        "0" => false,
        x => return Err(format!("--board は 1 か 0: {x}")),
    };
    let net = Arc::new(ValueNet::load(model_path)?);
    if imagined > 0.0 && !net.has_scalar("imagined") {
        return Err(format!(
            "--imagined には \"imagined\" の入力のあるモデルが要ります（npm run td -- extend --model {model_path} --out <新しいモデル> で足す。補正は同じ）"
        ));
    }
    let mut m = model_options(net.clone(), opp_beam, classic)?;
    m.board = board;
    m.imagined = imagined as usize;
    m.opts.record_reads = m.imagined > 0;
    m.check = match arg(args, "check").unwrap_or("0") {
        "0" => false,
        "1" => true,
        x => return Err(format!("--check は 0 か 1: {x}")),
    };
    let cmp = if cmp_k > 0.0 {
        Some(Compare {
            k: cmp_k as usize,
            rollouts: rollouts as usize,
            roll: model_options(net, false, false)?,
        })
    } else {
        None
    };
    let owned: Vec<Deck> = match arg(args, "decks") {
        None => Vec::new(),
        Some(list) => list
            .split(',')
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(read_deck)
            .collect::<Result<_, _>>()?,
    };
    if arg(args, "decks").is_some() {
        if owned.len() < 2 {
            return Err("--decks には 2 つ以上のデッキを並べます".into());
        }
        println!(
            "デッキ {} 個: {}",
            owned.len(),
            owned
                .iter()
                .map(|d| d.name.as_str())
                .collect::<Vec<_>>()
                .join("・")
        );
    }
    let vs: Option<Deck> = arg(args, "vs").map(read_deck).transpose()?;
    let mut decks: Vec<&Deck> = if owned.is_empty() {
        compare_decks()
    } else {
        owned.iter().collect()
    };
    if let Some(v) = &vs {
        // 相手と同じデッキは挑戦する側から除く
        decks.retain(|d| d.name != v.name);
        if decks.is_empty() {
            return Err("--vs のほかにデッキがありません".into());
        }
        println!("相手は {}（挑戦する側 {} 個）", v.name, decks.len());
    }
    let mut file = std::fs::File::create(out).map_err(|e| format!("{out} に書けません: {e}"))?;
    let t0 = Instant::now();
    let tasks: Vec<u32> = (0..games as u32).map(|k| start as u32 + k).collect();
    let mut summaries = parallel_map(
        &tasks,
        |&g, _| {
            play_one(
                g,
                &decks,
                vs.as_ref(),
                &m,
                eps,
                iv,
                zone,
                iv_res,
                cmp.as_ref(),
            )
        },
        |done, total, r, _| {
            writeln!(file, "{}", r.line).unwrap_or_else(|e| panic!("{out} に書けません: {e}"));
            if done % 100 == 0 || done == total {
                println!(
                    "{done}/{total} 試合 {}s/試合",
                    fixed(seconds_since(t0) / done as f64, 2)
                );
            }
        },
    );
    for r in &mut summaries {
        r.line = String::new();
    }
    let n = summaries.len();
    let samples: usize = summaries.iter().map(|r| r.samples).sum();
    let explored: usize = summaries.iter().map(|r| r.explored).sum();
    let ivs: usize = summaries.iter().map(|r| r.ivs).sum();
    let res_ivs: usize = summaries.iter().map(|r| r.res_ivs).sum();
    let groups: usize = summaries.iter().map(|r| r.groups).sum();
    let turns: i64 = summaries.iter().map(|r| r.turns as i64).sum();
    let first_wins = summaries.iter().filter(|r| r.winner == 0).count();
    println!(
        "{out}: {n} 試合、局面 {samples}（ランダムに打った {explored}、介入して打った試合 {ivs}（うち資源 {res_ivs}）、打ち比べた局面 {groups}）、平均 {} ターン、先攻の勝率 {}%",
        fixed(turns as f64 / n as f64, 1),
        fixed((first_wins as f64 / n as f64) * 100.0, 1)
    );
    // 自己対戦でのデッキごとの勝率（同じデッキ同士は除く）
    let mut per_deck = Tally::default();
    for r in &summaries {
        if r.decks[0] == r.decks[1] {
            continue;
        }
        for (p, d) in r.decks.iter().enumerate() {
            per_deck.add(d, r.winner == p);
        }
    }
    println!("{}", per_deck.line());
    Ok(())
}

pub fn main(argv: &[String]) -> Result<(), String> {
    let args = parse_args(argv.get(1..).unwrap_or(&[]))?;
    match argv.first().map(|s| s.as_str()) {
        Some("selfplay") => selfplay(&args),
        _ => {
            Err("svwb td selfplay ...（init・train・probe・prune は npm run td -- で行う）".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::AMBUSH;
    use crate::state::EVOLVE_BONUS;

    fn card_named(name: &str) -> CardIdx {
        data()
            .cards
            .iter()
            .position(|c| c.name == name)
            .unwrap_or_else(|| panic!("{name} がありません")) as CardIdx
    }

    fn board_json(s: &GameState, p: PlayerIndex) -> serde_json::Value {
        let mut out = String::from("{\"z\":0");
        write_board(&mut out, s, p);
        out.push('}');
        serde_json::from_str::<serde_json::Value>(&out).expect("JSON")["b"].clone()
    }

    /// 今の既定の補正（"imagined" の入力が無ければ重み 0 で足す）で、速い読み方（classic・相手は貪欲法）の自己対戦の設定
    fn imagined_model(imagined: usize) -> Model {
        let mut raw = ai_data().value_net.clone();
        assert!(raw.board.is_none());
        if !raw.scalars.iter().any(|x| x == "imagined") {
            raw.scalars.push("imagined".into());
            // 場のカードのネットワークの無いモデルなので、最後の数値の入力の行は w1 の末尾
            raw.w1.extend(std::iter::repeat_n(0.0, raw.hidden));
        }
        let mut m = model_options(Arc::new(ValueNet::new(raw).expect("モデル")), false, true)
            .expect("設定");
        m.board = true;
        m.imagined = imagined;
        m.opts.record_reads = imagined > 0;
        m
    }

    /// 1 行ずつ JSON にし、想像の局面（"ph": 2）を除いたもの
    fn without_imagined(text: &str) -> Vec<serde_json::Value> {
        text.lines()
            .map(|l| {
                let mut v: serde_json::Value = serde_json::from_str(l).expect("JSON");
                if let Some(samples) = v["samples"].as_array_mut() {
                    for seq in samples {
                        seq.as_array_mut()
                            .expect("局面の列")
                            .retain(|x| x["ph"] != 2);
                    }
                }
                v
            })
            .collect()
    }

    #[test]
    fn imagined_samples_follow_turn_ends_without_changing_games() {
        // --imagined を付けても試合は同じ。想像の局面はターン末の局面の直後に、1 つのターン末につき 2 つまで
        let decks = compare_decks();
        for g in [3u32, 10] {
            let plain = play_one(
                g,
                &decks,
                None,
                &imagined_model(0),
                0.1,
                0.0,
                IvZone::Hand,
                0.0,
                None,
            );
            let with = play_one(
                g,
                &decks,
                None,
                &imagined_model(2),
                0.1,
                0.0,
                IvZone::Hand,
                0.0,
                None,
            );
            assert_eq!(without_imagined(&plain.line), without_imagined(&with.line));
            assert!(with.samples > plain.samples);
            let v: serde_json::Value = serde_json::from_str(&with.line).expect("JSON");
            for seq in v["samples"].as_array().expect("局面") {
                let ph: Vec<i64> = seq
                    .as_array()
                    .expect("局面の列")
                    .iter()
                    .map(|x| x["ph"].as_i64().expect("ph"))
                    .collect();
                let mut run = 0;
                for (k, &x) in ph.iter().enumerate() {
                    if x == 2 {
                        run += 1;
                        assert!(run <= 2 && k >= run && ph[k - run] == 0, "{ph:?}");
                    } else {
                        run = 0;
                    }
                }
            }
        }
    }

    #[test]
    fn deck_pool_from_files() {
        // --decks: 並べたデッキの全組を回す。td-pool のファイルのデッキ（デフォルトデッキと違う）でも最後まで打てて、行にデッキの名前が入る
        let dir = format!("{}/td-pool/royal-counter", env!("CARGO_MANIFEST_DIR"));
        let mut files: Vec<String> = std::fs::read_dir(&dir)
            .expect("td-pool")
            .map(|e| e.expect("ファイル").path().display().to_string())
            .filter(|f| f.ends_with(".txt"))
            .collect();
        files.sort();
        assert_eq!(files.len(), 12);
        let pool: Vec<Deck> = files
            .iter()
            .map(|f| read_deck(f).expect("デッキ"))
            .collect();
        for d in &pool {
            let s = create_game([&d.cards, &d.cards], 1);
            assert_eq!(default_deck_name_of(&s, 0), None, "{}", d.name);
        }
        let royal = read_deck("アマリアロイヤル").expect("デッキ");
        let decks: Vec<&Deck> = vec![&royal, &pool[0]];
        // g = 1 は (1 mod 2, 0) = (ファイルのデッキ, ロイヤル)
        let r = play_one(
            1,
            &decks,
            None,
            &imagined_model(0),
            0.1,
            0.0,
            IvZone::Hand,
            0.0,
            None,
        );
        assert_eq!(r.decks, [pool[0].name.clone(), royal.name.clone()]);
        let v: serde_json::Value = serde_json::from_str(&r.line).expect("JSON");
        assert_eq!(v["decks"][0], pool[0].name.as_str());
    }

    #[test]
    fn drawn_interventions() {
        // --ivZone drawn: 介入する局面で「引いたカード」は、1 ターン目なら手札のすべて、2 ターン目からはそのターンの始めに引いた 1 枚（手札の最後）
        let decks = compare_decks();
        let m = imagined_model(0);
        for (g, p, turn) in [
            (0u32, 0usize, 1i32),
            (1, 1, 1),
            (2, 0, 3),
            (3, 1, 4),
            (4, 0, 6),
        ] {
            let seed = SEED_BASE + g;
            let state = create_game([&decks[0].cards, &decks[(g as usize) % 7].cards], seed);
            let r = play_out(g, state, &m, 0.1, seed, Some((p, turn)));
            let (at, _) = r.branch.as_ref().expect("介入する局面");
            let hand: Vec<Iid> = at.players[p].hand.iter().map(|h| h.iid).collect();
            if turn == 1 {
                assert_eq!(r.drawn, hand);
            } else {
                assert_eq!(r.drawn.len(), 1, "g{g} {:?} {:?}", r.drawn, hand);
                assert_eq!(r.drawn.last(), hand.last());
            }
        }
        // 介入の行は "zone": "drawn" で、消したカードはもとの試合のその局面の引いたカード
        for g in [5u32, 6] {
            let r = play_one(g, &decks, None, &m, 0.1, 1.0, IvZone::Drawn, 0.0, None);
            let lines: Vec<serde_json::Value> = r
                .line
                .lines()
                .map(|l| serde_json::from_str(l).expect("JSON"))
                .collect();
            for v in &lines[1..] {
                assert_eq!(v["iv"]["zone"], "drawn", "{}", v["iv"]);
            }
        }
    }

    #[test]
    fn vs_pairs_and_challenger_side() {
        // --vs: どの試合も相手のデッキと挑戦する側の 1 つ（席は g / n で入れ替わる）で、介入するのは挑戦する側
        let royal = read_deck("アマリアロイヤル").expect("デッキ");
        let decks: Vec<&Deck> = compare_decks()
            .into_iter()
            .filter(|d| d.name != royal.name)
            .collect();
        let n = decks.len() as u32;
        assert_eq!(n, 6);
        let m = imagined_model(0);
        for (g, seat) in [(0u32, 0usize), (1, 0), (n, 1), (n + 2, 1)] {
            let r = play_one(
                g,
                &decks,
                Some(&royal),
                &m,
                0.1,
                1.0,
                IvZone::Drawn,
                0.0,
                None,
            );
            let c = &decks[(g % n) as usize].name;
            assert_eq!(&r.decks[seat], c, "g{g}");
            assert_eq!(r.decks[1 - seat], royal.name, "g{g}");
            let lines: Vec<serde_json::Value> = r
                .line
                .lines()
                .map(|l| serde_json::from_str(l).expect("JSON"))
                .collect();
            for v in &lines[1..] {
                assert_eq!(v["iv"]["p"], seat, "g{g} {}", v["iv"]);
            }
        }
    }

    #[test]
    fn resource_interventions() {
        // 資源の ±1 はルールの範囲に収まるものだけ。--ivRes を足しても --iv の試合は同じ
        let decks = compare_decks();
        let s = create_game([&decks[0].cards, &decks[1].cards], 1);
        let c = res_candidates(&s, 0);
        // 始めは体力・EP・SEP が上限なので減らすだけ、PP 最大値 0 は増やすだけ
        assert!(
            c.iter().all(|&(_, r, d)| (r == Res::MaxPp) == (d == 1)),
            "{c:?}"
        );
        let mut t = s.clone();
        t.active = 0;
        t.players[0].max_pp = 5;
        t.players[0].pp = 5;
        apply_res(&mut t, 0, Res::MaxPp, -1);
        assert_eq!((t.players[0].max_pp, t.players[0].pp), (4, 4));
        apply_res(&mut t, 1, Res::MaxPp, 1);
        assert_eq!(
            (t.players[1].max_pp, t.players[1].pp),
            (s.players[1].max_pp + 1, s.players[1].pp)
        );

        let m = imagined_model(0);
        let g = 4;
        let base = play_one(g, &decks, None, &m, 0.1, 2.0, IvZone::Both, 0.0, None);
        let more = play_one(g, &decks, None, &m, 0.1, 2.0, IvZone::Both, 1.0, None);
        let (a, b): (Vec<&str>, Vec<&str>) =
            (base.line.lines().collect(), more.line.lines().collect());
        assert_eq!(more.res_ivs, 1);
        assert_eq!(b.len(), a.len() + 1);
        assert_eq!(&b[..a.len()], &a[..]);
        let iv: serde_json::Value = serde_json::from_str(b[a.len()]).expect("JSON");
        let iv = &iv["iv"];
        assert!(iv["zone"] == "res" || iv["zone"] == "oppRes", "{iv}");
        assert!(iv["d"] == 1 || iv["d"] == -1);
        assert!(["ep", "sep", "hp", "maxPp"].contains(&iv["res"].as_str().expect("res")));
    }

    #[test]
    fn board_attributes() {
        let decks = compare_decks();
        let mut s = create_game([&decks[0].cards, &decks[1].cards], 1);
        s.players[0].board.make_mut().clear();
        s.players[1].board.make_mut().clear();
        // エンハンスした形のワルツを進化させて、1 ダメージ受けた（2/1 → 4/3 潜伏 → 進化 6/5 → 6/4）
        let waltz = card_named("サイレントスナイパー・ワルツ");
        let mut w = s.new_board_card(waltz, None);
        w.attack += 2 + EVOLVE_BONUS;
        w.defense += 2 + EVOLVE_BONUS - 1;
        w.max_defense += 2 + EVOLVE_BONUS;
        w.keywords = w.keywords.with(AMBUSH);
        w.evolve = Evolve::Evolved;
        let granted = &data().abilities[waltz as usize].abilities[0];
        w.granted.push(granted);
        s.players[0].board.make_mut().push(w);
        let plain = s.new_board_card(waltz, None);
        s.players[0].board.make_mut().push(plain);
        let garden = card_named("繚乱の庭");
        let a = s.new_board_card(garden, None);
        s.players[1].board.make_mut().push(a);

        let g: serde_json::Value = serde_json::from_str(&ability_json_text(granted)).unwrap();
        let mine = serde_json::json!([
            {"c": "10123120", "a": 6, "d": 4, "md": 5, "e": 1, "k": ["ambush"], "g": [g]},
            {"c": "10123120", "a": 2, "d": 1, "md": 1}
        ]);
        let theirs = serde_json::json!([{"c": "10011210", "cd": 2}]);
        assert_eq!(board_json(&s, 0), serde_json::json!([mine, theirs]));
        // 相手から見ると並びが入れ替わる
        assert_eq!(board_json(&s, 1), serde_json::json!([theirs, mine]));
    }
}
