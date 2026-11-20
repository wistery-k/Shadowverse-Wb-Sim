//! ゴールデンテスト・計測用の対戦（ランダムな手で打つ試合と、AI どうしの試合）。

use crate::data::{data, CardIdx, ClassId, Pool};
use crate::game::{apply_action, create_game, legal_actions};
use crate::state::*;

pub const MAX_STEPS: usize = 5000;

const CLASSES: [ClassId; 7] = [
    ClassId::Elf,
    ClassId::Royal,
    ClassId::Witch,
    ClassId::Dragon,
    ClassId::Nightmare,
    ClassId::Bishop,
    ClassId::Nemesis,
];

/// ランダムなデッキ（スターターの、クラスとニュートラルのトークン以外のカードから 40 枚）
fn random_deck(g: u32, i: u32) -> Vec<CardIdx> {
    let cls = CLASSES[((g + i * 3) % 7) as usize];
    let pool: Vec<CardIdx> = data()
        .cards
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            !c.token && c.in_pool(Pool::Starter) && (c.class == cls || c.class == ClassId::Neutral)
        })
        .map(|(i, _)| i as CardIdx)
        .collect();
    let mut pick = Chooser::new((g * 2 + i + 1).wrapping_mul(40503));
    (0..40).map(|_| pool[pick.pick(pool.len())]).collect()
}

/// 試合 g の組み合わせとシード（random_decks ならランダムなデッキ）
pub fn game_setup(g: u32, random_decks: bool) -> ([Vec<CardIdx>; 2], u32) {
    let seed = (g + 1).wrapping_mul(2654435761);
    if random_decks {
        return ([random_deck(g, 0), random_deck(g, 1)], seed);
    }
    let decks = &data().decks;
    let n = decks.len() as u32;
    let d0 = decks[(g % n) as usize].cards.clone();
    let d1 = decks[((g / n) % n) as usize].cards.clone();
    ([d0, d1], seed)
}

/// 行動の選び方（LCG）
pub struct Chooser(u32);

impl Chooser {
    pub fn new(seed: u32) -> Chooser {
        Chooser(seed ^ 0x9e3779b9)
    }
    pub fn pick(&mut self, len: usize) -> usize {
        self.0 = self.0.wrapping_mul(1103515245).wrapping_add(12345);
        (self.0 >> 8) as usize % len
    }
}

/// 試合 g をランダムな手で打ち、各手番で visit を呼ぶ（最後は決着した局面で legal が空）
pub fn play_random(
    g: u32,
    random_decks: bool,
    mut visit: impl FnMut(usize, &GameState, &[Action]),
) -> GameState {
    let (decks, seed) = game_setup(g, random_decks);
    let mut pick = Chooser::new(seed);
    let mut s = create_game([&decks[0], &decks[1]], seed);
    let mut step = 0;
    loop {
        let legal = if s.phase == Phase::Ended || step >= MAX_STEPS {
            Vec::new()
        } else {
            legal_actions(&s)
        };
        visit(step, &s, &legal);
        if legal.is_empty() {
            return s;
        }
        let a = &legal[pick.pick(legal.len())];
        s = apply_action(&s, a);
        step += 1;
    }
}

/// 探索 AI どうしの試合 g の組み合わせとシード
pub fn ai_game_setup(g: u32, elf: bool) -> ([Vec<CardIdx>; 2], u32) {
    let decks: Vec<&crate::data::Deck> = data()
        .decks
        .iter()
        .filter(|d| d.name != "ランプドラゴン")
        .collect();
    let seed = g * 7 + 1;
    if elf {
        // 試合ごとに席を入れ替えてリノセウスエルフと、それ以外のデッキ（2 試合ごとに次のデッキ）を当てる
        let others: Vec<&crate::data::Deck> = decks
            .iter()
            .copied()
            .filter(|d| d.name != "リノセウスエルフ")
            .collect();
        let elf_cards = decks
            .iter()
            .find(|d| d.name == "リノセウスエルフ")
            .expect("リノセウスエルフのデッキ")
            .cards
            .clone();
        let other = others[(g / 2) as usize % others.len()].cards.clone();
        return if g.is_multiple_of(2) {
            ([elf_cards, other], seed)
        } else {
            ([other, elf_cards], seed)
        };
    }
    let i = (g % 7) as usize;
    let j = ((g * 3 + 1 + g / 7) % 7) as usize;
    ([decks[i].cards.clone(), decks[j].cards.clone()], seed)
}

/// 2 つの AI で試合 g を最後まで打つ（AI の乱数は playMatch と同じくシードから作る）。各手で visit を呼ぶ
pub fn play_ai(
    g: u32,
    elf: bool,
    agents: &mut [&mut dyn crate::ai::Agent; 2],
    visit: impl FnMut(&GameState, &Action),
) -> GameState {
    let (decks, seed) = ai_game_setup(g, elf);
    play_match(agents, [&decks[0], &decks[1]], seed, visit)
}

/// 試合の中で AI に渡す思考用の乱数（TypeScript 版 src/sim/match.ts の playFrom と同じ）。
///
/// 判断ごとに、試合のシード・席・ターン・そのターンでその席が何回目の判断かから作る（2026-11-10 から）。
/// 片方の席の AI が乱数を使う数を変えても、もう片方の席の乱数は変わらず、組の 2 試合（鏡）で同じ局面なら同じ乱数になる。
/// `Agent::sequential_rng` の AI（物差しの相手）には、1 試合に 1 本の乱数（シード ^ 0x9e3779b9）をその AI たちが順に使う古い取り方で渡す
pub struct MatchRng {
    seed: u32,
    shared: crate::ai::Rng,
    turn: i32,
    counts: [u32; 2],
    cur: crate::ai::Rng,
}

impl MatchRng {
    /// 試合のシード seed の乱数（古い取り方の 1 本は seed ^ 0x9e3779b9 から）
    pub fn new(seed: u32) -> MatchRng {
        MatchRng::with_shared(seed, seed ^ 0x9e3779b9)
    }

    /// 判断ごとの乱数を seed から、古い取り方の 1 本を shared から作る（打ち進め等で、前から 1 本を Rng::new(shared) で作っていたもの）
    pub fn with_shared(seed: u32, shared: u32) -> MatchRng {
        MatchRng {
            seed,
            shared: crate::ai::Rng::new(shared),
            turn: i32::MIN,
            counts: [0, 0],
            cur: crate::ai::Rng::new(0),
        }
    }

    /// 局面 s で actor が判断するときの乱数（判断ごとに 1 回呼ぶ）。sequential なら古い取り方の 1 本
    pub fn next(
        &mut self,
        s: &GameState,
        actor: PlayerIndex,
        sequential: bool,
    ) -> &mut crate::ai::Rng {
        if s.turn != self.turn {
            self.turn = s.turn;
            self.counts = [0, 0];
        }
        let k = self.counts[actor];
        self.counts[actor] += 1;
        if sequential {
            return &mut self.shared;
        }
        self.cur = crate::ai::Rng::new(crate::ai::seed_of(&[
            crate::ai::purpose::DECISION,
            self.seed,
            actor as u32,
            s.turn as u32,
            k,
        ]));
        &mut self.cur
    }

    /// 局面 s で手番の側の agent に手を選ばせる
    pub fn choose(
        &mut self,
        agent: &mut dyn crate::ai::Agent,
        s: &GameState,
        legal: &[Action],
    ) -> Action {
        let actor = crate::game::acting_player(s);
        let rng = self.next(s, actor, agent.sequential_rng());
        agent.choose_action(s, legal, rng)
    }
}

/// 2 つの AI で 1 試合を最後まで打つ（TypeScript 版 src/sim/match.ts の playMatch。AI の乱数は seed から MatchRng で作る）。
/// 各手で、打つ前の局面と選んだ手で visit を呼ぶ（勝者がいない終わり方は呼び出し側で確かめる）
pub fn play_match(
    agents: &mut [&mut dyn crate::ai::Agent; 2],
    decks: [&[CardIdx]; 2],
    seed: u32,
    mut visit: impl FnMut(&GameState, &Action),
) -> GameState {
    let mut s = create_game(decks, seed);
    let mut rng = MatchRng::new(seed);
    let mut actions = 0;
    while s.phase != Phase::Ended {
        actions += 1;
        assert!(
            actions <= 10000,
            "アクション数が上限 10000 を超えました（シード {seed}）"
        );
        let legal = legal_actions(&s);
        let actor = crate::game::acting_player(&s);
        let a = rng.choose(&mut *agents[actor], &s, &legal);
        visit(&s, &a);
        s = apply_action(&s, &a);
    }
    s
}

/// 打ち比べ（リプレイの「この局面で別の手を打ったら」）の 1 試合。
/// 手番のプレイヤーから見えない情報（相手の手札・山札の中身、山札の順番、乱数の状態）を seed で並べ直した局面で first を打ち、
/// 残りを agents で最後まで対戦させて、終わった局面を返す。
/// 同じ seed なら first が違っても並べ直し方と AI の乱数は同じ（手の違いだけを比べるため。AI の乱数は MatchRng で、
/// 判断ごとに席・ターン・そのターンで何回目の判断かから作る）。first がその局面で打てなければ None。
/// 手が 1 つの branch_line_playout と同じ
pub fn branch_playout(
    start: &GameState,
    first: &Action,
    agents: &mut [&mut dyn crate::ai::Agent; 2],
    seed: u32,
) -> Option<GameState> {
    branch_line_playout(start, std::slice::from_ref(first), agents, seed, false).map(|e| e.end)
}

/// 打ち比べの手の列の 1 試合の結果
#[derive(Clone, Debug)]
pub struct LineEnd {
    /// 終わった局面
    pub end: GameState,
    /// 手の列のうち、この試合で打てた手の数（最初の手は必ず打つ。手の列の長さと同じなら全部打てた）
    pub followed: usize,
    /// 始めのターンに打った手（手の列の手と、その後に AI が打った続き。ターンを終える手か、そのターンに決着したら決着の手まで）の説明。
    /// 選ぶ手（Choose・Mode）は直前の手にまとめる（`svwb survey turns` と同じ）。log が false なら空
    pub turn: Vec<String>,
}

/// 打ち比べの、手の列（line）を打ってから続きを AI に打たせる 1 試合（2026-11-20。リプレイの打ち比べで 2 手以上を指定する）。
/// 並べ直し方と AI の乱数は branch_playout と同じで、手が 1 つなら branch_playout と同じ試合になる。
///
/// 最初の手は、並べ直した局面でそのまま打つ（打てなければ None）。2 手目からは、試合ごとに並べ直したので、
/// 山札から引いた・手札に加えたカードの番号（iid）が実際の局面と違ったり、そのカードが無かったりする。そこで、手の列を実際の局面
/// （start から手の列を順に打った局面）で打つときの「手の種類と、指すカードの持ち主・場所・カード」（line_key）を作り、
/// 並べ直した局面の打てる手から、同じものを選ぶ（同じ手そのものが打てて同じものなら、それを優先する）。
/// 合う手が無ければ、そこから先は AI が打つ（followed がそこまでの数）。手番の側の手番で、始めのターンのあいだだけ合わせる
/// （相手が選ぶ手が挟まったら、それは AI が打ち、手の列は続ける）。
/// log なら、始めのターンに打った手の説明を turn に入れる
pub fn branch_line_playout(
    start: &GameState,
    line: &[Action],
    agents: &mut [&mut dyn crate::ai::Agent; 2],
    seed: u32,
    log: bool,
) -> Option<LineEnd> {
    let viewer = crate::game::acting_player(start);
    let first = line.first()?;
    let mut rng = crate::ai::Rng::new(seed);
    let det = crate::ai::determinize::determinize(start, viewer, &mut rng, false);
    if !crate::game::is_legal(&det, first) {
        return None;
    }
    let keys = line_keys(start, line, viewer);
    let mut turn = TurnLog::new(log, viewer);
    turn.push(&det, first);
    let mut s = crate::game::apply_legal(&det, first);
    let mut followed = 1;
    let mut following = true;
    let mut rng = MatchRng::new(seed);
    let mut actions = 0;
    while s.phase != Phase::Ended {
        actions += 1;
        assert!(
            actions <= 10000,
            "アクション数が上限 10000 を超えました（打ち比べ、シード {seed}）"
        );
        let legal = legal_actions(&s);
        let actor = crate::game::acting_player(&s);
        if s.turn != start.turn {
            following = false;
        }
        let planned = if following && followed < keys.len() && actor == viewer {
            let m = line_match(&s, &legal, &line[followed], &keys[followed], viewer);
            if m.is_none() {
                following = false;
            }
            m
        } else {
            None
        };
        let a = match planned {
            Some(a) => {
                followed += 1;
                a
            }
            None => rng.choose(&mut *agents[actor], &s, &legal),
        };
        if s.turn == start.turn {
            turn.push(&s, &a);
        }
        s = apply_action(&s, &a);
    }
    Some(LineEnd {
        end: s,
        followed,
        turn: turn.steps,
    })
}

/// 手の列の各手の line_key（start から順に打った実際の局面で作る）。打てない手があれば、その手の前まで
fn line_keys(start: &GameState, line: &[Action], viewer: PlayerIndex) -> Vec<String> {
    let mut s = start.clone();
    let mut keys = Vec::with_capacity(line.len());
    for a in line {
        if !crate::game::is_legal(&s, a) {
            break;
        }
        keys.push(line_key(&s, a, viewer));
        s = crate::game::apply_legal(&s, a);
    }
    keys
}

/// 並べ直した局面 s の打てる手 legal から、手の列の手 want（実際の局面での line_key が key）に合うもの。
/// want そのものが打てて同じ line_key ならそれ、無ければ legal の順で最初に line_key が合う手
fn line_match(
    s: &GameState,
    legal: &[Action],
    want: &Action,
    key: &str,
    viewer: PlayerIndex,
) -> Option<Action> {
    if legal.contains(want) && line_key(s, want, viewer) == key {
        return Some(want.clone());
    }
    legal
        .iter()
        .find(|a| line_key(s, a, viewer) == key)
        .cloned()
}

/// 手の、局面によらない呼び方: 手の種類と、指すもの（リーダーか、カードの持ち主（viewer から見て自分か相手か）・場所・カード）。
/// 選ぶ手・融合の素材・マリガンで返すカードは並べ替えて並びによらないものにする（打てる手は 1 つの組を 1 つの並びでしか出さない）
fn line_key(s: &GameState, a: &Action, viewer: PlayerIndex) -> String {
    let e = |i: Iid| entity_key(s, i, viewer);
    let set = |ids: &[Iid]| {
        let mut v: Vec<String> = ids.iter().map(|&i| e(i)).collect();
        v.sort();
        v.join(",")
    };
    match a {
        Action::Mulligan { swap, .. } => format!("mulligan {}", set(swap)),
        Action::Play(i) => format!("play {}", e(*i)),
        Action::Attack { attacker, target } => format!(
            "attack {} {}",
            e(*attacker),
            target.map_or_else(|| "leader".to_string(), e)
        ),
        Action::Evolve(i) => format!("evolve {}", e(*i)),
        Action::SuperEvolve(i) => format!("superEvolve {}", e(*i)),
        Action::Act(i) => format!("act {}", e(*i)),
        Action::Fuse { host, materials } => format!("fuse {} {}", e(*host), set(materials)),
        Action::Choose(ids) => format!("choose {}", set(ids)),
        Action::Mode(i) => format!("mode {i}"),
        Action::ExtraPp => "extraPp".into(),
        Action::EndTurn => "endTurn".into(),
    }
}

/// カードの番号 iid が指すもの（viewer から見た持ち主 0 自分・1 相手と、場所 H 手札・B 場・D 山札とカード。リーダーは L と持ち主）。
/// どこにも無い番号は番号のまま（同じ番号の手にしか合わない）
fn entity_key(s: &GameState, iid: Iid, viewer: PlayerIndex) -> String {
    if is_leader(iid) {
        let owner = (-iid - 1) as usize;
        return format!("L{}", usize::from(owner != viewer));
    }
    for (q, pl) in s.players.iter().enumerate() {
        let side = usize::from(q != viewer);
        if let Some(h) = pl.hand.iter().find(|h| h.iid == iid) {
            return format!("H{side}:{}", h.card);
        }
        if let Some(b) = pl.board.iter().find(|b| b.iid == iid) {
            return format!("B{side}:{}", b.card);
        }
        if let Some(d) = pl.deck.iter().find(|d| d.iid == iid) {
            return format!("D{side}:{}", d.card);
        }
    }
    format!("#{iid}")
}

/// 始めのターンに打った手の説明（branch_line_playout の turn）
struct TurnLog {
    on: bool,
    viewer: PlayerIndex,
    steps: Vec<String>,
    /// 最後に足した手を打った側（選ぶ手をまとめるのは同じ側の手のとき）
    last: Option<PlayerIndex>,
}

impl TurnLog {
    fn new(on: bool, viewer: PlayerIndex) -> TurnLog {
        TurnLog {
            on,
            viewer,
            steps: Vec::new(),
            last: None,
        }
    }

    /// 局面 s で打つ手 a を足す（選ぶ手は、同じ側の直前の手に「（…）」でまとめる）
    fn push(&mut self, s: &GameState, a: &Action) {
        if !self.on {
            return;
        }
        let actor = crate::game::acting_player(s);
        let text = action_text(s, a, self.viewer);
        match self.steps.last_mut() {
            Some(prev)
                if matches!(a, Action::Choose(_) | Action::Mode(_)) && self.last == Some(actor) =>
            {
                prev.push_str(&format!("（{text}）"));
            }
            _ => {
                let who = if actor == self.viewer { "" } else { "相手: " };
                self.steps.push(format!("{who}{text}"));
            }
        }
        self.last = Some(actor);
    }
}

/// カードの番号 iid の名前（リーダーは「自分のリーダー」「相手のリーダー」。viewer から見て）
fn entity_name(s: &GameState, iid: Iid, viewer: PlayerIndex) -> String {
    if is_leader(iid) {
        let owner = (-iid - 1) as usize;
        return if owner == viewer {
            "自分のリーダー".into()
        } else {
            "相手のリーダー".into()
        };
    }
    for pl in &s.players {
        let found = pl
            .hand
            .iter()
            .find(|h| h.iid == iid)
            .map(|h| h.card)
            .or_else(|| pl.board.iter().find(|b| b.iid == iid).map(|b| b.card))
            .or_else(|| pl.deck.iter().find(|d| d.iid == iid).map(|d| d.card));
        if let Some(c) = found {
            return card(c).name.clone();
        }
    }
    format!("#{iid}")
}

/// 手の短い説明（局面 s で打つ前に作る。画面の打てる手の文言（src/ui/describe.ts の describeAction）に寄せる）
fn action_text(s: &GameState, a: &Action, viewer: PlayerIndex) -> String {
    let name = |i: Iid| entity_name(s, i, viewer);
    let names = |ids: &[Iid]| ids.iter().map(|&i| name(i)).collect::<Vec<_>>().join("・");
    match a {
        Action::Mulligan { swap, .. } => format!("マリガン（{}枚入れ替え）", swap.len()),
        Action::Play(i) => format!("{}をプレイ", name(*i)),
        Action::Attack { attacker, target } => format!(
            "{}で{}を攻撃",
            name(*attacker),
            target.map_or_else(|| "リーダー".to_string(), name)
        ),
        Action::Evolve(i) => format!("{}を進化", name(*i)),
        Action::SuperEvolve(i) => format!("{}を超進化", name(*i)),
        Action::Act(i) => format!("{}をアクト", name(*i)),
        Action::Fuse { host, materials } => {
            format!("{}に{}を融合", name(*host), names(materials))
        }
        Action::Choose(ids) if ids.is_empty() => "選ぶ: なし".into(),
        Action::Choose(ids) => format!("{}を選択", names(ids)),
        Action::Mode(i) => format!("モード {} を選択", i + 1),
        Action::ExtraPp => "エクストラPP".into(),
        Action::EndTurn => "ターン終了".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::RandomAgent;

    /// 両者がマリガンを済ませ、何手か進めた局面
    fn mid_game() -> GameState {
        let decks = &data().decks;
        let mut s = create_game([&decks[0].cards, &decks[1].cards], 7);
        let mut pick = Chooser::new(3);
        for _ in 0..30 {
            let legal = legal_actions(&s);
            s = apply_action(&s, &legal[pick.pick(legal.len())]);
            if s.phase == Phase::Ended {
                break;
            }
        }
        assert_ne!(s.phase, Phase::Ended);
        s
    }

    /// 手番の側が、プレイしても手番が続き選ぶ手も出ないカードを手札に持つ局面と、そのプレイの手
    fn with_play() -> (GameState, Action) {
        let decks = &data().decks;
        let mut s = create_game([&decks[0].cards, &decks[1].cards], 7);
        let mut pick = Chooser::new(5);
        for _ in 0..2000 {
            if s.phase == Phase::Main && s.pending.is_none() {
                let p = crate::game::acting_player(&s);
                let found = legal_actions(&s).into_iter().find(|a| {
                    let t = apply_action(&s, a);
                    matches!(a, Action::Play(_))
                        && t.phase == Phase::Main
                        && t.pending.is_none()
                        && crate::game::acting_player(&t) == p
                });
                if let Some(a) = found {
                    if s.turn >= 6 {
                        return (s, a);
                    }
                }
            }
            let legal = legal_actions(&s);
            s = apply_action(&s, &legal[pick.pick(legal.len())]);
            assert_ne!(s.phase, Phase::Ended);
        }
        panic!("プレイできる局面が無い");
    }

    fn playout(s: &GameState, a: &Action, seed: u32) -> Option<(Option<PlayerIndex>, i32)> {
        let (mut r0, mut r1) = (RandomAgent, RandomAgent);
        branch_playout(s, a, &mut [&mut r0, &mut r1], seed).map(|e| (e.winner, e.turn))
    }

    #[test]
    fn branch_playout_is_deterministic_and_finishes() {
        let s = mid_game();
        for a in legal_actions(&s) {
            let r = playout(&s, &a, 11).expect("打てる手");
            assert!(r.0.is_some());
            assert_eq!(playout(&s, &a, 11), Some(r));
        }
    }

    fn line(s: &GameState, l: &[Action], seed: u32) -> Option<LineEnd> {
        let (mut r0, mut r1) = (RandomAgent, RandomAgent);
        branch_line_playout(s, l, &mut [&mut r0, &mut r1], seed, true)
    }

    fn json_of(s: &GameState) -> String {
        crate::state_json::state_to_json(s).stringify()
    }

    #[test]
    fn branch_line_with_one_action_is_branch_playout() {
        // 手が 1 つなら、前からの打ち比べ（branch_playout）と同じ試合になる
        let s = mid_game();
        for a in legal_actions(&s) {
            for seed in [1, 11, 12345] {
                let (mut r0, mut r1) = (RandomAgent, RandomAgent);
                let old = branch_playout(&s, &a, &mut [&mut r0, &mut r1], seed).expect("打てる手");
                let new = line(&s, std::slice::from_ref(&a), seed).expect("打てる手");
                assert_eq!(json_of(&old), json_of(&new.end));
                assert_eq!(new.followed, 1);
                assert!(!new.turn.is_empty());
            }
        }
    }

    #[test]
    fn branch_line_plays_the_whole_line_and_logs_the_turn() {
        // 手番の側がカードを 1 枚プレイし、ターンを終える手の列。どの並べ直しでも最後まで打て、始めのターンの説明はその 2 手
        let (s, first) = with_play();
        let l = vec![first, Action::EndTurn];
        for seed in 0..8 {
            let e = line(&s, &l, seed).expect("打てる");
            assert_eq!(e.followed, 2);
            assert_eq!(e.turn.len(), 2, "{:?}", e.turn);
            assert!(e.turn[0].ends_with("をプレイ"), "{:?}", e.turn);
            assert_eq!(e.turn[1], "ターン終了");
            assert!(e.end.winner.is_some());
            // 同じシードなら同じ試合
            let again = line(&s, &l, seed).expect("打てる");
            assert_eq!(json_of(&e.end), json_of(&again.end));
            assert_eq!(e.turn, again.turn);
        }
    }

    #[test]
    fn line_match_finds_the_same_card_under_another_number() {
        // 並べ直した局面で、同じカードが別の番号で手札にあれば、その番号の手を選ぶ
        let (s, want) = with_play();
        let p = crate::game::acting_player(&s);
        let Action::Play(h) = want else {
            unreachable!()
        };
        let key = line_key(&s, &want, p);
        let mut other = s.clone();
        let fresh = 987_654;
        for c in other.players[p].hand.make_mut().iter_mut() {
            if c.iid == h {
                c.iid = fresh;
            }
        }
        let legal = legal_actions(&other);
        assert_eq!(
            line_match(&other, &legal, &want, &key, p),
            Some(Action::Play(fresh))
        );
        // 元の局面では、その手そのもの
        assert_eq!(
            line_match(&s, &legal_actions(&s), &want, &key, p),
            Some(want.clone())
        );
        // 手札に無いカードの手は合わない
        let mut gone = s.clone();
        gone.players[p].hand.make_mut().retain(|c| c.iid != h);
        let same_card = s.players[p].hand.iter().find(|c| c.iid == h).unwrap().card;
        if !gone.players[p].hand.iter().any(|c| c.card == same_card) {
            assert_eq!(
                line_match(&gone, &legal_actions(&gone), &want, &key, p),
                None
            );
        }
    }

    #[test]
    fn branch_line_falls_back_to_the_ai_when_a_step_cannot_be_matched() {
        // 実際の局面で打てない手は合わせる手を作れないので、そこから AI が打つ（最初の手だけ打てた）
        let s = mid_game();
        let first = legal_actions(&s)[0].clone();
        let bad = Action::Attack {
            attacker: -12345,
            target: None,
        };
        let e = line(&s, &[first, bad], 3).expect("最初の手は打てる");
        assert_eq!(e.followed, 1);
        assert!(e.end.winner.is_some());
    }

    #[test]
    fn branch_playout_rejects_illegal_action() {
        let s = mid_game();
        let illegal = Action::Attack {
            attacker: -12345,
            target: None,
        };
        assert_eq!(playout(&s, &illegal, 1), None);
    }
}
