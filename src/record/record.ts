// 試合の記録: プロの試合（配信の動画）を、見ながら手で入れる（開発サーバーだけ。画面は src/ui/MatchRecord.tsx、形は docs/match-record.md）。
//
// 記録は「最初の局面からたどれるだけの手順」と、各ターンの最初の局面（状態の JSON）を持つ。
// - 引いたカードは、手を打つ前に山札の上に並べてから打つ（エンジンは山札の上から、条件付きなら上から見て最初に合うカードを引く）。
//   どの手で何枚引くかは打つまで分からないので、打ってみて「引いたのに、まだ決めていないカード」があれば聞き、並べ直して打ち直す
// - ランダムな結果（対象・出るカード・手札に加わるカード）は、乱数の状態を変えて同じ手を何度か打ち、見える結果の違うものを並べて選ぶ。
//   選んだ結果を出した乱数の状態を記録に残す（エンジンは変えない。まれな結果は取りこぼしうるので、画面で「もっと探す」ができる）
// - 入れている間は AI を呼ばない（CLAUDE.md の試合の記録の条件）

import "./pool";
import type { ClassId } from "../cards/types";
import {
  actingPlayer,
  applyAction,
  cardOf,
  createGame,
  crestOf,
  HAND_LIMIT,
  INITIAL_HAND,
  newHandCard,
  opponent,
  type Action,
  type DeckCard,
  type GameState,
  type HandCard,
  type OnBoard,
  type PlayerIndex,
} from "../engine";
import { callEngine } from "../engine/wasm";
import { KEYWORD_NAMES } from "../ui/describe";
import { proDeck } from "./decks";

export const RECORD_FORMAT = "svwb-match-record";
export const RECORD_VERSION = 1;

/** 記録の操作の誤り（画面に出す） */
export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordError";
  }
}

/** 席ごとの、決めた引いたカード（カード ID。引いた順） */
export type Draws = [string[], string[]];

/** 手順の 1 つ */
export type RecordStep =
  /** 初期手札（マリガンの前。カード ID を 4 枚） */
  | { kind: "hand"; player: PlayerIndex; cards: string[] }
  /**
   * 手。draws は打つ前に山札の上に並べる引いたカード（席ごと）。rng は打つ前に置き換える乱数の状態（ランダムな結果を選んだとき）。
   * outcome は選んだランダムな結果の説明（見る人のため。たどるときには使わない）
   */
  | { kind: "action"; action: Action; draws?: Draws; rng?: number; outcome?: string }
  /** 手で直した局面（エンジンの結果が動画と合わないとき。直した後の局面をそのまま持つ） */
  | { kind: "edit"; label: string; state: GameState }
  /** 「動画と違う」の印（この手順の前の局面に付ける） */
  | { kind: "mark"; note: string }
  /** リタイア（負けた側） */
  | { kind: "retire"; loser: PlayerIndex };

export interface RecordSeat {
  /** プロのデッキの ID（`<大会>/<チーム>_<クラス>`） */
  deck: string;
  team: string;
  cls: ClassId;
}

export interface RecordMeta {
  /** 大会（フォルダの名前） */
  event: string;
  eventName: string;
  /** 席 0 が先攻、席 1 が後攻 */
  seats: [RecordSeat, RecordSeat];
  /** 動画のどのあたりか等（任意） */
  memo: string;
  /** 入れたときのコミット（とコミットしていない変更があったか） */
  commit: string;
  dirty: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RecordResult {
  winner: PlayerIndex;
  /** leader: リーダーの体力が 0 / deck: 山札切れ / retire: リタイア */
  reason: "leader" | "deck" | "retire";
}

/** 各ターンの最初の局面（step はその局面の前までの手順の数） */
export interface TurnSnapshot {
  turn: number;
  step: number;
  state: GameState;
}

export interface MatchRecord {
  format: typeof RECORD_FORMAT;
  version: typeof RECORD_VERSION;
  meta: RecordMeta;
  /** 席ごとのデッキ（カード ID） */
  decks: [string[], string[]];
  /** createGame のシード（席 0 が先攻になるもの） */
  seed: number;
  steps: RecordStep[];
  /** 書き出すときに作る（ブラウザに残すものには無い） */
  turns?: TurnSnapshot[];
  result: RecordResult | null;
}

// ---- 始める ----

/** 席 0 が先攻になるシードで試合を作る（seed から 1 ずつ進めて探す） */
export function startGame(decks: [readonly string[], readonly string[]], seed: number): { seed: number; state: GameState } {
  let s = seed >>> 0;
  for (;;) {
    const state = createGame({ decks, seed: s });
    if (state.first === 0) return { seed: s, state };
    s = (s + 1) >>> 0;
  }
}

/** 新しい記録（手順は空） */
export function newRecord(o: { event: string; eventName: string; seats: [RecordSeat, RecordSeat]; memo: string; commit: string; dirty: boolean; seed: number; now: string }): MatchRecord {
  const decks = o.seats.map((seat) => {
    const d = proDeck(seat.deck);
    if (!d) throw new RecordError(`プロのデッキにありません: ${seat.deck}`);
    return [...d.cards];
  }) as [string[], string[]];
  const { seed } = startGame(decks, o.seed);
  return {
    format: RECORD_FORMAT,
    version: RECORD_VERSION,
    meta: { event: o.event, eventName: o.eventName, seats: o.seats, memo: o.memo, commit: o.commit, dirty: o.dirty, createdAt: o.now, updatedAt: o.now },
    decks,
    seed,
    steps: [],
    result: null,
  };
}

// ---- 初期手札 ----

/** 初期手札を cards（カード ID を 4 枚）にした局面。手札と山札のカードを入れ替える（引いた記録の数は変わらない） */
export function setInitialHand(state: GameState, p: PlayerIndex, cards: readonly string[]): GameState {
  if (state.phase !== "mulligan" || state.players[p].mulliganDone) throw new RecordError("初期手札はマリガンの前にだけ決められます");
  if (cards.length !== INITIAL_HAND) throw new RecordError(`初期手札は ${INITIAL_HAND} 枚です`);
  const s = structuredClone(state);
  const pl = s.players[p];
  const pool: DeckCard[] = [...pl.hand.map((h) => ({ iid: h.iid, cardId: h.cardId })), ...pl.deck];
  const hand: HandCard[] = [];
  for (const id of cards) {
    const i = pool.findIndex((c) => c.cardId === id);
    if (i < 0) throw new RecordError(`${cardOf(id).name}はデッキに残っていません`);
    const [c] = pool.splice(i, 1);
    hand.push(newHandCard(s, id, c!.iid));
  }
  pl.hand = hand;
  // 山札は、元の山札の順のまま（手札から戻したカードは末尾）
  const handIids = new Set(state.players[p].hand.map((h) => h.iid));
  pl.deck = [...pool.filter((c) => !handIids.has(c.iid)), ...pool.filter((c) => handIids.has(c.iid))];
  return s;
}

// ---- 手を打つ（引いたカード・乱数を決めて） ----

/** 山札の上に ids のカードを順に並べた山札（残りは元の順）。足りないカードがあればそのカード ID */
function arrangeDeck(deck: readonly DeckCard[], ids: readonly string[]): DeckCard[] | string {
  const rest = [...deck];
  const top: DeckCard[] = [];
  for (const id of ids) {
    const i = rest.findIndex((c) => c.cardId === id);
    if (i < 0) return id;
    top.push(rest.splice(i, 1)[0]!);
  }
  return [...top, ...rest];
}

/** 引いたカードを山札の上に並べ、乱数を置き換えた局面（打つ前） */
export function arrange(state: GameState, draws: Draws, rng?: number): GameState {
  const players = state.players.map((pl, p) => {
    const ids = draws[p as PlayerIndex];
    if (ids.length === 0) return pl;
    const deck = arrangeDeck(pl.deck, ids);
    if (typeof deck === "string") throw new RecordError(`${cardOf(deck).name}は山札に残っていません`);
    return { ...pl, deck };
  }) as GameState["players"];
  return { ...state, players, ...(rng !== undefined ? { rng: rng >>> 0 } : {}) };
}

/** 引いたカードと乱数を決めて手を打つ。打てない手なら RecordError */
export function runStep(state: GameState, action: Action, draws: Draws, rng?: number): { arranged: GameState; next: GameState } {
  const arranged = arrange(state, draws, rng);
  try {
    return { arranged, next: applyAction(arranged, action) };
  } catch (e) {
    throw new RecordError(`打てない手です: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 打つ前の山札から、手札に引いたカード（引いた順）。手札が上限で墓場に行ったものも含む */
export function drawnCards(arranged: GameState, next: GameState, p: PlayerIndex): DeckCard[] {
  const before = arranged.players[p].deck;
  const beforeIids = new Set(before.map((c) => c.iid));
  const after = next.players[p];
  const left = new Set(after.deck.map((c) => c.iid));
  const departed = before.filter((c) => !left.has(c.iid));
  if (departed.length === 0) return [];
  const handIndex = new Map(after.hand.map((h, i) => [h.iid, i]));
  const elsewhere = new Set<number>();
  for (const pl of next.players) {
    for (const c of pl.board) elsewhere.add(c.iid);
    for (const h of pl.hand) elsewhere.add(h.iid);
    for (const c of pl.deck) elsewhere.add(c.iid);
  }
  const toHand = departed.filter((c) => handIndex.has(c.iid)).sort((a, b) => handIndex.get(a.iid)! - handIndex.get(b.iid)!);
  // どこにも無いもの: 手札が上限で墓場に行った（引いた）か、引いた後に捨てた等。山札ごと入れ替わったとき（アポカリプスデッキ）は数えない
  const replaced = after.deck.filter((c) => !beforeIids.has(c.iid)).length >= 10;
  const gone = departed.filter((c) => !elsewhere.has(c.iid));
  const burned = replaced ? [] : gone.slice(0, Math.max(0, after.graveyard - arranged.players[p].graveyard));
  return [...toHand, ...burned];
}

/** 引いたカードのうち、決めた引いたカード（ids）で説明できないもの（引いた順）。ids のうち引かれなかったものがあれば、そのカード ID も */
function extraDraws(drawn: readonly DeckCard[], ids: readonly string[]): { extra: DeckCard[]; missing: string | null } {
  const want = new Map<string, number>();
  for (const id of ids) want.set(id, (want.get(id) ?? 0) + 1);
  const extra: DeckCard[] = [];
  for (const c of drawn) {
    const n = want.get(c.cardId) ?? 0;
    if (n > 0) want.set(c.cardId, n - 1);
    else extra.push(c);
  }
  const missing = [...want.entries()].find(([, n]) => n > 0)?.[0] ?? null;
  return { extra, missing };
}

/** 局面の見える中身（ランダムな結果をまとめる・説明するのに使う） */
interface SeatView {
  leader: string;
  res: string;
  /** text は見える中身、turn は場に出た全体のターン（同じカードのどれが残ったかを分ける） */
  board: { iid: number; text: string; turn: number }[];
  hand: string[];
  deck: string[];
  crests: string[];
  graveyard: number;
}

function boardText(c: OnBoard): string {
  const name = cardOf(c.cardId).name;
  const kws = [...new Set([...c.keywords, ...c.tempKeywords])].map((k) => KEYWORD_NAMES[k]);
  const extra = [...kws, ...(c.granted.length > 0 ? [`能力 +${c.granted.length}`] : []), ...(c.lostLastWords ? ["ラストワードなし"] : [])];
  if (c.kind === "follower") {
    const evo = c.evolve === "evolved" ? "・進化" : c.evolve === "superEvolved" ? "・超進化" : "";
    return `${name} ${Math.max(0, c.attack + c.tempAttack)}/${c.defense}${evo}${extra.length > 0 ? `（${extra.join("・")}）` : ""}`;
  }
  const cd = c.countdown !== null ? ` CD ${c.countdown}` : "";
  return `${name}${cd}${extra.length > 0 ? `（${extra.join("・")}）` : ""}`;
}

function handText(h: HandCard): string {
  const name = cardOf(h.cardId).name;
  const mods = [
    h.costMod !== 0 ? `コスト${h.costMod > 0 ? "+" : ""}${h.costMod}` : "",
    h.attackMod !== 0 || h.defenseMod !== 0 ? `+${h.attackMod}/+${h.defenseMod}` : "",
    h.boosts > 0 ? `SB ${h.boosts}` : "",
    h.x !== null && h.x !== 0 ? `X ${h.x}` : "",
  ].filter((x) => x !== "");
  return mods.length > 0 ? `${name}（${mods.join("・")}）` : name;
}

const HIDDEN_DRAW = "（引いたカード）";

/**
 * 席 p の見える中身。この手で引いたカードは、どれを引いたかを見ない（山札の並べ方しだいで、あとから決めるので）:
 * 手札では「（引いたカード）」、山札では残っているものとして数える
 */
function seatView(arranged: GameState, next: GameState, p: PlayerIndex): SeatView {
  const pl = next.players[p];
  const drawn = drawnCards(arranged, next, p);
  const hidden = new Set(drawn.map((c) => c.iid));
  return {
    leader: `${pl.leaderHp}/${pl.leaderMaxHp}`,
    res: `PP ${pl.pp}/${pl.maxPp}・EP ${pl.ep}・SEP ${pl.sep}${pl.extraPpAvailable ? "・エクストラPP" : ""}`,
    board: pl.board.map((c) => ({ iid: c.iid, text: boardText(c), turn: c.kind === "follower" ? c.enteredTurn : 0 })),
    hand: pl.hand.map((h) => (hidden.has(h.iid) ? HIDDEN_DRAW : handText(h))).sort(),
    deck: [...pl.deck, ...drawn].map((c) => cardOf(c.cardId).name).sort(),
    crests: pl.crests.map((c) => `${crestOf(c.crestId).name}${c.countdown !== null ? ` (${c.countdown})` : ""}${c.faith !== undefined ? ` 信仰値 ${c.faith}` : ""}`).sort(),
    graveyard: pl.graveyard,
  };
}

/** 局面の見える中身 */
interface View {
  seats: [SeatView, SeatView];
  rest: string;
}

function viewOf(arranged: GameState, next: GameState): View {
  const pending = next.pending;
  const rest = JSON.stringify({
    phase: next.phase,
    winner: next.winner,
    pending: pending ? (pending.kind === "choose" ? { kind: pending.kind, player: pending.player, count: pending.count, n: pending.candidates.length } : pending) : null,
    stack: next.stack.map((f) => ({ effects: f.effects.slice(f.pc) })),
    queue: next.queue.length,
  });
  return { seats: [seatView(arranged, next, 0), seatView(arranged, next, 1)], rest };
}

/** 見える結果のまとめのキー（盤面のカードの実体 ID は見ない。同じカードの写しのどれが選ばれたかは区別しない） */
function viewKey(v: View): string {
  return JSON.stringify({ seats: v.seats.map((s) => ({ ...s, board: s.board.map((b) => `${b.text}|${b.turn}`) })), rest: v.rest });
}

/** ランダムな結果の候補の 1 つ */
export interface Outcome {
  /** 打つ前に置き換える乱数の状態 */
  rng: number;
  /** 見える結果のまとめのキー（引いたカードを決めるときに、同じ結果のまま乱数を探し直すのに使う） */
  key: string;
  /** 試した回数のうち、この結果になった回数 */
  count: number;
  /** 打つ前の局面と比べた違い */
  changes: string[];
  /** changes のうち、ほかの候補にもあるもの（ランダムでない結果。画面では薄く出す） */
  common: string[];
}

/** 結果の説明（ほかの候補と違うところだけ。無ければ全部） */
export const outcomeLabel = (o: Outcome): string => {
  const distinct = o.changes.filter((c) => !o.common.includes(c));
  return (distinct.length > 0 ? distinct : o.changes).join("、") || "（見える違いなし）";
};

/**
 * 画面に出す結果の説明: ほかの候補と違うところ（diff）と、どの結果でも同じ場・リーダーの変化（同じ名前のカードのどれかを見分けるのに要る）。
 * そのほかの、どの結果でも同じ変化（手札のスペルブースト等）は数だけ
 */
export function outcomeParts(o: Outcome): { parts: { text: string; diff: boolean }[]; hidden: number } {
  const parts: { text: string; diff: boolean }[] = [];
  let hidden = 0;
  for (const c of o.changes) {
    const diff = !o.common.includes(c);
    if (diff || /の場|のリーダー/.test(c)) parts.push({ text: c, diff });
    else hidden++;
  }
  return { parts, hidden };
}

/** 乱数の状態の候補（試すたびに同じものを使う。打つ前の局面の乱数の状態と番号から決まる） */
export function variantRng(base: number, i: number): number {
  let z = (base + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

/** 打つ前と比べた見える違い */
function changesOf(before: View, after: View, names: readonly [string, string]): string[] {
  const out: string[] = [];
  for (const p of [0, 1] as const) {
    const b = before.seats[p];
    const a = after.seats[p];
    const who = names[p];
    if (a.leader !== b.leader) out.push(`${who}のリーダー: 体力 ${b.leader} → ${a.leader}`);
    const beforeBoard = new Map(b.board.map((c) => [c.iid, c.text]));
    const afterBoard = new Map(a.board.map((c) => [c.iid, c.text]));
    // 同じ名前のカードが場に 2 枚以上あれば、左から何枚目かを添える（動画で見分けるため）
    const pos = (iid: number, text: string) => {
      const name = text.split(" ")[0];
      const i = b.board.findIndex((c) => c.iid === iid);
      return b.board.filter((c) => c.text.split(" ")[0] === name).length > 1 ? `（左から ${i + 1} 枚目）` : "";
    };
    for (const [iid, text] of beforeBoard) {
      const t = afterBoard.get(iid);
      if (t === undefined) out.push(`${who}の場から: ${text}${pos(iid, text)}`);
      else if (t !== text) out.push(`${who}の場: ${text}${pos(iid, text)} → ${t}`);
    }
    for (const [iid, text] of afterBoard) if (!beforeBoard.has(iid)) out.push(`${who}の場に: ${text}`);
    for (const [label, xs, ys] of [
      ["手札", b.hand, a.hand],
      ["山札", b.deck, a.deck],
      ["クレスト", b.crests, a.crests],
    ] as const) {
      const { added, removed } = multisetDiff(xs, ys);
      for (const x of added) out.push(`${who}の${label} +${x}`);
      for (const x of removed) out.push(`${who}の${label} −${x}`);
    }
    if (a.graveyard !== b.graveyard) out.push(`${who}の墓場 ${b.graveyard} → ${a.graveyard}`);
    if (a.res !== b.res) out.push(`${who}: ${a.res}`);
  }
  if (after.rest !== before.rest) {
    const r = JSON.parse(after.rest) as { pending: { kind: string; count?: number; n?: number } | null; phase: string };
    if (r.phase === "ended") out.push("決着");
    else if (r.pending?.kind === "choose") out.push(`選ぶ（${r.pending.n ?? 0} 個から ${r.pending.count ?? 0} 個）`);
    else if (r.pending?.kind === "mode") out.push("モードを選ぶ");
    else out.push("解決の途中が違う");
  }
  return out;
}

function multisetDiff(xs: readonly string[], ys: readonly string[]): { added: string[]; removed: string[] } {
  const count = new Map<string, number>();
  for (const x of xs) count.set(x, (count.get(x) ?? 0) + 1);
  const added: string[] = [];
  for (const y of ys) {
    const n = count.get(y) ?? 0;
    if (n > 0) count.set(y, n - 1);
    else added.push(y);
  }
  const removed: string[] = [];
  for (const [x, n] of count) for (let i = 0; i < n; i++) removed.push(x);
  return { added, removed };
}

/** 乱数 rng で打った結果（打てなければ null） */
function tryRun(state: GameState, action: Action, draws: Draws, rng: number | undefined): { arranged: GameState; next: GameState } | null {
  try {
    return runStep(state, action, draws, rng);
  } catch {
    return null;
  }
}

/**
 * 乱数を変えて同じ手を count 回打ち（from 番目の候補から）、見える結果ごとにまとめる。prev（前に見つけた候補）も打ち直して足す。
 * 結果が 1 つなら、ランダムな結果は無い（か、見えない所だけ違う）
 */
export function sampleOutcomes(
  state: GameState,
  action: Action,
  draws: Draws,
  names: readonly [string, string],
  count: number,
  prev: readonly Outcome[] = [],
  from = 0,
): Outcome[] {
  const groups = new Map<string, { rng: number; count: number; view: View }>();
  const arranged = arrange(state, draws);
  const before = viewOf(arranged, arranged);
  const add = (rng: number, n: number) => {
    const run = tryRun(state, action, draws, rng);
    if (!run) return;
    const view = viewOf(run.arranged, run.next);
    const key = viewKey(view);
    const g = groups.get(key);
    if (g) g.count += n;
    else groups.set(key, { rng, count: n, view });
  };
  for (const o of prev) add(o.rng, o.count);
  for (let i = from; i < from + count; i++) add(variantRng(state.rng, i), 1);
  const list = [...groups.entries()];
  const all = list.map(([, g]) => changesOf(before, g.view, names));
  // どの候補にもある違い（ランダムでない結果）は除く
  const common = all.reduce<string[]>((acc, cs) => acc.filter((c) => cs.includes(c)), all[0] ?? []);
  return list.map(([key, g], i) => ({ rng: g.rng, key, count: g.count, changes: all[i]!, common })).sort((a, b) => b.count - a.count);
}

/** ランダムな結果があるかを確かめるときに試す回数 */
export const RANDOM_PROBE = 12;
/** ランダムな結果の候補を並べるときに試す回数（「もっと探す」でさらに足す） */
export const RANDOM_SAMPLES = 120;
/** 決めた引いたカードを引く乱数を探す回数（山札を切り直してから引く手のとき） */
export const SEARCH_LIMIT = 5000;
/** 探す乱数の候補の番号の始まり（ランダムな結果の候補と重ねない） */
const SEARCH_FROM = 1_000_000;

/** 決めた引いたカードをすべて引き、見える結果が key になる乱数（見つからなければ null） */
export function searchRng(state: GameState, action: Action, draws: Draws, key: string, limit = SEARCH_LIMIT): number | null {
  for (let i = 0; i < limit; i++) {
    const rng = variantRng(state.rng, SEARCH_FROM + i);
    const run = tryRun(state, action, draws, rng);
    if (!run) continue;
    if (([0, 1] as const).some((p) => extraDraws(drawnCards(run.arranged, run.next, p), draws[p]).missing !== null)) continue;
    if (viewKey(viewOf(run.arranged, run.next)) === key) return rng;
  }
  return null;
}

/** 打とうとしている手（引いたカード・乱数を決めているところ） */
export interface PendingStep {
  action: Action;
  draws: Draws;
  /** 打つ前に置き換える乱数の状態（ランダムな結果を選んだ・決めた引いたカードを引く乱数を探したとき） */
  rng?: number;
  /** 選んだランダムな結果の見える結果のキー */
  outcomeKey?: string;
  /** 選んだランダムな結果の説明 */
  outcome?: string;
}

export type Evaluation =
  | { kind: "error"; message: string }
  /** 決めた引いたカードを引く結果が見つからない（条件に合わない等） */
  | { kind: "mismatch"; player: PlayerIndex; cardId: string }
  /** ランダムな結果を選ぶ */
  | { kind: "random"; outcomes: Outcome[]; samples: number }
  /** 引いたカードを決める（player の山札から。known はまだ決めていない引いたカードの枚数） */
  | { kind: "draw"; player: PlayerIndex; known: number }
  | { kind: "done"; next: GameState };

/**
 * 打とうとしている手の、次に決めること（乱数を探し直したときは step も変わる）。
 * 1. ランダムな結果があれば（まだ選んでいなければ）選ぶ
 * 2. 決めた引いたカードを引かなかったら（山札を切り直してから引く手など）、同じ見える結果のまま引く乱数を探す
 * 3. 引いたのにまだ決めていないカードがあれば決める 4. 無ければ打った局面
 */
export function evaluate(state: GameState, step: PendingStep, names: readonly [string, string]): { step: PendingStep; ev: Evaluation } {
  let run: { arranged: GameState; next: GameState };
  try {
    run = runStep(state, step.action, step.draws, step.rng);
  } catch (e) {
    return { step, ev: { kind: "error", message: e instanceof Error ? e.message : String(e) } };
  }
  if (step.rng === undefined && step.outcomeKey === undefined) {
    const probe = sampleOutcomes(state, step.action, step.draws, names, RANDOM_PROBE);
    if (probe.length > 1) {
      const outcomes = sampleOutcomes(state, step.action, step.draws, names, RANDOM_SAMPLES - RANDOM_PROBE, probe, RANDOM_PROBE);
      return { step, ev: { kind: "random", outcomes, samples: RANDOM_SAMPLES } };
    }
  }
  let drawn = ([0, 1] as const).map((p) => extraDraws(drawnCards(run.arranged, run.next, p), step.draws[p]));
  const key = viewKey(viewOf(run.arranged, run.next));
  const missing = drawn.findIndex((d) => d.missing !== null);
  if (missing >= 0 || (step.outcomeKey !== undefined && key !== step.outcomeKey)) {
    const target = step.outcomeKey ?? key;
    // 引くカードが乱数で変わらない手（山札の上から引くだけ）なら、探しても見つからない（引けないカードを選んだ）
    const other = tryRun(state, step.action, step.draws, variantRng(state.rng, SEARCH_FROM - 1));
    const same =
      other !== null &&
      ([0, 1] as const).every((p) => drawnCards(other.arranged, other.next, p).map((c) => c.iid).join() === drawnCards(run.arranged, run.next, p).map((c) => c.iid).join());
    const rng = same && missing >= 0 ? null : searchRng(state, step.action, step.draws, target);
    if (rng === null) {
      const p = (missing >= 0 ? missing : 0) as PlayerIndex;
      return { step, ev: { kind: "mismatch", player: p, cardId: drawn[p]!.missing ?? step.draws[p].at(-1) ?? "" } };
    }
    step = { ...step, rng, outcomeKey: target };
    run = runStep(state, step.action, step.draws, rng);
    drawn = ([0, 1] as const).map((p) => extraDraws(drawnCards(run.arranged, run.next, p), step.draws[p]));
  }
  const acting = actingPlayer(state);
  for (const p of [acting, opponent(acting)]) {
    const extra = drawn[p]!.extra;
    if (extra.length > 0) return { step, ev: { kind: "draw", player: p, known: extra.length } };
  }
  return { step, ev: { kind: "done", next: run.next } };
}

/** 山札に残っているカード（カード ID → 枚数。決めた引いたカードの分を除く） */
export function deckRemaining(state: GameState, p: PlayerIndex, taken: readonly string[] = []): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of state.players[p].deck) m.set(c.cardId, (m.get(c.cardId) ?? 0) + 1);
  for (const id of taken) {
    const n = m.get(id) ?? 0;
    if (n <= 1) m.delete(id);
    else m.set(id, n - 1);
  }
  return m;
}

// ---- たどる ----

/** 手順を 1 つ進めた局面 */
export function applyStep(state: GameState, step: RecordStep): GameState {
  switch (step.kind) {
    case "hand":
      return setInitialHand(state, step.player, step.cards);
    case "action": {
      const draws = step.draws ?? [[], []];
      const { arranged, next } = runStep(state, step.action, draws, step.rng);
      for (const p of [0, 1] as const) {
        const { missing } = extraDraws(drawnCards(arranged, next, p), draws[p]);
        if (missing !== null) throw new RecordError(`${cardOf(missing).name}を引いたはずが、引かれませんでした`);
      }
      return next;
    }
    case "edit":
      return normalize(step.state);
    case "mark":
    case "retire":
      return state;
  }
}

/** エンジンに読ませて形をそろえた局面（読めなければ RecordError） */
export function normalize(raw: unknown): GameState {
  try {
    return callEngine({ f: "normalizeState", state: raw }) as GameState;
  } catch (e) {
    throw new RecordError(`局面として読めません: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 記録の最初の局面 */
export function initialState(record: MatchRecord): GameState {
  const { state } = startGame(record.decks, record.seed);
  if (state.first !== 0) throw new RecordError("記録のシードでは席 0 が先攻になりません");
  return state;
}

/**
 * 手順をたどった局面の列（states[0] が最初の局面、states[i + 1] が i 番目の手順の後）。
 * たどれない手順があれば、そこまでの局面と誤り
 */
export function replay(record: Pick<MatchRecord, "decks" | "seed" | "steps">): { states: GameState[]; error: { step: number; message: string } | null } {
  const states: GameState[] = [];
  let state: GameState;
  try {
    state = initialState(record as MatchRecord);
  } catch (e) {
    return { states, error: { step: -1, message: e instanceof Error ? e.message : String(e) } };
  }
  states.push(state);
  for (let i = 0; i < record.steps.length; i++) {
    try {
      state = applyStep(state, record.steps[i]!);
    } catch (e) {
      return { states, error: { step: i, message: e instanceof Error ? e.message : String(e) } };
    }
    states.push(state);
  }
  return { states, error: null };
}

/** 各ターンの最初の局面（メインフェイズで、ターンが変わった直後） */
export function turnSnapshots(states: readonly GameState[]): TurnSnapshot[] {
  const out: TurnSnapshot[] = [];
  for (let i = 0; i < states.length; i++) {
    const s = states[i]!;
    const prev = states[i - 1];
    if (s.phase === "main" && !s.pending && (!prev || prev.phase !== "main" || prev.turn !== s.turn)) out.push({ turn: s.turn, step: i, state: s });
  }
  return out;
}

/** 試合の結果（終わっていなければ null） */
export function resultOf(steps: readonly RecordStep[], last: GameState): RecordResult | null {
  const retire = steps.find((s): s is Extract<RecordStep, { kind: "retire" }> => s.kind === "retire");
  if (retire) return { winner: opponent(retire.loser), reason: "retire" };
  if (last.phase !== "ended" || last.winner === null) return null;
  const loser = opponent(last.winner);
  return { winner: last.winner, reason: last.players[loser].leaderHp <= 0 ? "leader" : "deck" };
}

// ---- 書き出し・読み込み ----

/** 書き出す記録（各ターンの最初の局面と結果を付ける） */
export function exportRecord(record: MatchRecord, now: string): MatchRecord {
  const { states, error } = replay(record);
  if (error) throw new RecordError(`手順 ${error.step + 1} をたどれません: ${error.message}`);
  return { ...record, meta: { ...record.meta, updatedAt: now }, turns: turnSnapshots(states), result: resultOf(record.steps, states[states.length - 1]!) };
}

/** 書き出した記録のファイルの名前（大会_先攻_vs_後攻_日時。環境によって日本語のファイル名で保存できないので、クラスは ID で） */
export function recordFileName(record: MatchRecord): string {
  const seat = (s: RecordSeat) => `${s.team}-${s.cls}`;
  const t = record.meta.createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  return `${record.meta.event}_${seat(record.meta.seats[0])}_vs_${seat(record.meta.seats[1])}_${t}.json`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSeatIndex = (v: unknown): v is PlayerIndex => v === 0 || v === 1;
const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function checkStep(v: unknown, i: number): RecordStep {
  const bad = (why: string) => new RecordError(`手順 ${i + 1} が読めません（${why}）`);
  if (!isObj(v)) throw bad("形");
  switch (v.kind) {
    case "hand":
      if (!isSeatIndex(v.player) || !isIds(v.cards)) throw bad("初期手札");
      return { kind: "hand", player: v.player, cards: v.cards };
    case "action": {
      if (!isObj(v.action) || typeof v.action.type !== "string") throw bad("手");
      const draws = v.draws;
      if (draws !== undefined && !(Array.isArray(draws) && draws.length === 2 && isIds(draws[0]) && isIds(draws[1]))) throw bad("引いたカード");
      if (v.rng !== undefined && typeof v.rng !== "number") throw bad("乱数");
      return {
        kind: "action",
        action: v.action as unknown as Action,
        ...(draws !== undefined ? { draws: draws as Draws } : {}),
        ...(typeof v.rng === "number" ? { rng: v.rng } : {}),
        ...(typeof v.outcome === "string" ? { outcome: v.outcome } : {}),
      };
    }
    case "edit":
      if (typeof v.label !== "string" || !isObj(v.state)) throw bad("手で直した局面");
      return { kind: "edit", label: v.label, state: v.state as unknown as GameState };
    case "mark":
      if (typeof v.note !== "string") throw bad("印");
      return { kind: "mark", note: v.note };
    case "retire":
      if (!isSeatIndex(v.loser)) throw bad("リタイア");
      return { kind: "retire", loser: v.loser };
    default:
      throw bad(`種類 ${String(v.kind)}`);
  }
}

/**
 * 書き出した記録を読む。デッキはプロのデッキと同じものでなければ読まない（CLAUDE.md の試合の記録の条件）。
 * 手順の形だけを確かめる（たどれるかは replay で見る）
 */
export function parseRecord(text: string): MatchRecord {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new RecordError(`JSON として読めません: ${String(e)}`);
  }
  if (!isObj(v) || v.format !== RECORD_FORMAT) throw new RecordError("試合の記録のファイルではありません");
  if (v.version !== RECORD_VERSION) throw new RecordError(`記録の版 ${String(v.version)} は読めません（${RECORD_VERSION} だけ）`);
  const meta = v.meta;
  if (!isObj(meta) || !Array.isArray(meta.seats) || meta.seats.length !== 2) throw new RecordError("記録の頭が読めません");
  const seats = meta.seats.map((s: unknown, p) => {
    if (!isObj(s) || typeof s.deck !== "string") throw new RecordError(`席 ${p} のデッキが読めません`);
    const d = proDeck(s.deck);
    if (!d) throw new RecordError(`席 ${p} のデッキ ${s.deck} はプロのデッキにありません`);
    return { deck: d.id, team: d.team, cls: d.cls };
  }) as [RecordSeat, RecordSeat];
  const decks = v.decks;
  if (!Array.isArray(decks) || decks.length !== 2 || !isIds(decks[0]) || !isIds(decks[1])) throw new RecordError("デッキが読めません");
  for (const p of [0, 1] as const) {
    const want = [...proDeck(seats[p].deck)!.cards].sort().join(",");
    if ([...(decks[p] as string[])].sort().join(",") !== want) throw new RecordError(`席 ${p} のデッキが、プロのデッキ ${seats[p].deck} と違います`);
  }
  if (typeof v.seed !== "number" || !Array.isArray(v.steps)) throw new RecordError("シードか手順が読めません");
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  return {
    format: RECORD_FORMAT,
    version: RECORD_VERSION,
    meta: {
      event: str(meta.event),
      eventName: str(meta.eventName),
      seats,
      memo: str(meta.memo),
      commit: str(meta.commit),
      dirty: meta.dirty === true,
      createdAt: str(meta.createdAt),
      updatedAt: str(meta.updatedAt),
    },
    decks: [decks[0] as string[], decks[1] as string[]],
    seed: v.seed >>> 0,
    steps: v.steps.map(checkStep),
    result: null,
  };
}

/** 手札が上限か（引いたカードが墓場に行く） */
export const handFull = (state: GameState, p: PlayerIndex) => state.players[p].hand.length >= HAND_LIMIT;
