// リプレイ検索の条件と、条件に合うターンの探し方。
//
// 1 試合を「自分」の視点（プレイヤー0 か 1）から見て、ターンごとに条件を確かめる。1 試合は両方の視点で調べる（自己対戦では両者が「自分」になりうる）。
// 条件は「いつ（このターン・前の自分のターン・これより前のどれか…）」と「何が（プレイした・場にいた・数値…）」の組で、全部を満たすターンを探す。
// 込み入った条件は JavaScript の式でも書ける（開発サーバーだけの機能なので、式はそのまま実行する）。

import { ALL_CARDS, CARDS_BY_ID, CLASS_NAMES, type ClassId } from "../cards";
import type { PlayerIndex } from "../engine";
import type { BoardSnap, LoadedGame, SideSnap, TurnEventKind, TurnIndex } from "./types";

export type Who = "me" | "opp" | "any";
export type Scope =
  | "this"
  | "prev"
  | "next"
  | "prevMine"
  | "nextMine"
  | "prevOpp"
  | "nextOpp"
  | "before"
  | "beforeMine"
  | "beforeOpp"
  | "after"
  | "afterMine"
  | "afterOpp"
  | "game";
export type When = "start" | "end";
export type Op = "eq" | "ne" | "ge" | "le" | "gt" | "lt";
export type NumField = "hp" | "maxPp" | "pp" | "ppx" | "ep" | "sep" | "hand" | "followers" | "board" | "attack" | "deck" | "grave" | "dmg" | "plays" | "tc" | "turn";
export type CondKind = "decided" | "played" | "evolved" | "attacked" | "entered" | "left" | "survived" | "onBoard" | "inHand" | "extraPp" | "num";

/** 条件 1 つ。種類によって使わない項目もある（画面で種類を変えても値を残すため、いつも全部持つ） */
export interface Cond {
  kind: CondKind;
  scope: Scope;
  /** 満たさないこと（範囲のどのターンでも満たさない） */
  negate: boolean;
  who: Who;
  /** カード名（完全に同じ名前があればその名前、無ければ名前の一部。空ならどのカードでも） */
  card: string;
  /** played: この枚数以上 */
  min: number;
  /** evolved: 進化・超進化のどちらか */
  mode: "any" | "evolve" | "super";
  /** attacked: 攻撃先 */
  target: "any" | "leader" | "follower";
  /** onBoard・inHand・num: ターンの始めか終わりか */
  when: When;
  field: NumField;
  op: Op;
  value: number;
}

export interface ReplayQuery {
  /** 自分・相手のクラス（空ならどれでも） */
  myClass: ClassId | "";
  oppClass: ClassId | "";
  /** デッキの名前の一部（空ならどれでも） */
  myDeck: string;
  oppDeck: string;
  order: "any" | "first" | "second";
  result: "any" | "win" | "lose";
  /** 探すターンの手番 */
  whose: "any" | "me" | "opp";
  conds: Cond[];
  /** JavaScript の式（空なら使わない）。t: ターン、g: 試合（TurnView・GameView） */
  expr: string;
  /** 試合（視点）ごとに、条件に合う最初のターンだけ */
  firstOnly: boolean;
}

export const SCOPE_LABELS: Record<Scope, string> = {
  this: "このターン",
  prev: "1つ前のターン",
  next: "次のターン",
  prevMine: "自分の前のターン",
  nextMine: "自分の次のターン",
  prevOpp: "相手の前のターン",
  nextOpp: "相手の次のターン",
  before: "これより前のどれかのターン",
  beforeMine: "これより前の自分のターンのどれか",
  beforeOpp: "これより前の相手のターンのどれか",
  after: "これより後のどれかのターン",
  afterMine: "これより後の自分のターンのどれか",
  afterOpp: "これより後の相手のターンのどれか",
  game: "試合中のどれかのターン",
};

export const WHO_LABELS: Record<Who, string> = { me: "自分", opp: "相手", any: "どちらか" };

export const KIND_LABELS: Record<CondKind, string> = {
  decided: "勝った（このターンで決着。リーサル）",
  played: "カードをプレイした",
  evolved: "進化させた",
  attacked: "攻撃した",
  entered: "場に出た",
  left: "場から離れた（破壊・消滅・手札に戻る等）",
  survived: "次のターンを越えて場に残った（処理されなかった）",
  onBoard: "場にいた",
  inHand: "手札にあった",
  extraPp: "エクストラPPを使った",
  num: "数値",
};

export const FIELD_LABELS: Record<NumField, string> = {
  hp: "リーダーの体力",
  maxPp: "PP最大値",
  pp: "PP（使える分）",
  ppx: "PP＋エクストラPP",
  ep: "EP",
  sep: "SEP",
  hand: "手札の枚数",
  followers: "場のフォロワーの数",
  board: "場のカードの数",
  attack: "場のフォロワーの攻撃力の合計",
  deck: "山札の枚数",
  grave: "墓場",
  dmg: "このターンに受けたダメージ",
  plays: "このターンにプレイした枚数",
  tc: "そのプレイヤーの何ターン目",
  turn: "全体のターン番号",
};

/** ターンの始め・終わりを選ばない数値（ターン全体のもの） */
export const WHOLE_TURN_FIELDS: ReadonlySet<NumField> = new Set(["dmg", "plays", "tc", "turn"]);

export const OP_LABELS: Record<Op, string> = { eq: "＝", ne: "≠", ge: "≧", le: "≦", gt: "＞", lt: "＜" };

export function newCond(kind: CondKind = "played"): Cond {
  return { kind, scope: "this", negate: false, who: "me", card: "", min: 1, mode: "any", target: "any", when: "start", field: "hp", op: "le", value: 0 };
}

export function emptyQuery(): ReplayQuery {
  return { myClass: "", oppClass: "", myDeck: "", oppDeck: "", order: "any", result: "any", whose: "any", conds: [], expr: "", firstOnly: false };
}

// ---- カード名 ----

/** カード名の指定に合うカードID（空なら null = どのカードでも）。同じ名前のカードがあればそれだけ、無ければ名前の一部が合うもの */
export function cardIdsOf(text: string): Set<string> | null {
  const t = text.trim();
  if (t === "") return null;
  const exact = ALL_CARDS.filter((c) => c.name === t);
  const ids = new Set((exact.length > 0 ? exact : ALL_CARDS.filter((c) => c.name.includes(t))).map((c) => c.id));
  if (CARDS_BY_ID.has(t)) ids.add(t);
  return ids;
}

const nameOf = (id: string): string => CARDS_BY_ID.get(id)?.name ?? id;

// ---- 条件を確かめる ----

interface Ctx {
  game: LoadedGame;
  turns: readonly TurnIndex[];
  me: PlayerIndex;
}

type TurnPred = (ctx: Ctx, j: number) => boolean;

/** 範囲（scope）のどれかのターンで pred を満たすか（k は探しているターン） */
function someInScope(ctx: Ctx, k: number, scope: Scope, pred: (j: number) => boolean): boolean {
  const { turns, me } = ctx;
  const len = turns.length;
  const mine = (j: number) => turns[j]!.p === me;
  const first = (from: number, step: number, ok: (j: number) => boolean): boolean => {
    for (let j = from; j >= 0 && j < len; j += step) if (ok(j)) return pred(j);
    return false;
  };
  const any = (from: number, to: number, ok: (j: number) => boolean): boolean => {
    for (let j = from; j < to; j++) if (ok(j) && pred(j)) return true;
    return false;
  };
  const all = () => true;
  const opp = (j: number) => !mine(j);
  switch (scope) {
    case "this":
      return pred(k);
    case "prev":
      return k > 0 && pred(k - 1);
    case "next":
      return k + 1 < len && pred(k + 1);
    case "prevMine":
      return first(k - 1, -1, mine);
    case "nextMine":
      return first(k + 1, 1, mine);
    case "prevOpp":
      return first(k - 1, -1, opp);
    case "nextOpp":
      return first(k + 1, 1, opp);
    case "before":
      return any(0, k, all);
    case "beforeMine":
      return any(0, k, mine);
    case "beforeOpp":
      return any(0, k, opp);
    case "after":
      return any(k + 1, len, all);
    case "afterMine":
      return any(k + 1, len, mine);
    case "afterOpp":
      return any(k + 1, len, opp);
    case "game":
      return any(0, len, all);
  }
}

const isFollower = (b: BoardSnap) => b.a !== undefined;

/** あるターンのプレイヤー seat の数値 */
export function numValue(turns: readonly TurnIndex[], j: number, seat: PlayerIndex, field: NumField, when: When): number {
  const t = turns[j]!;
  const s: SideSnap = (when === "start" ? t.start : t.end)[seat];
  switch (field) {
    case "hp":
      return s.hp;
    case "maxPp":
      return s.maxPp;
    case "pp":
      return s.pp;
    case "ppx":
      return s.pp + (s.xpp ? 1 : 0);
    case "ep":
      return s.ep;
    case "sep":
      return s.sep;
    case "hand":
      return s.hand.length;
    case "followers":
      return s.board.filter(isFollower).length;
    case "board":
      return s.board.length;
    case "attack":
      return s.board.reduce((sum, b) => sum + (b.a ?? 0), 0);
    case "deck":
      return s.deck;
    case "grave":
      return s.grave;
    case "dmg":
      return t.start[seat].hp - t.end[seat].hp;
    case "plays":
      return t.ev.filter((e) => e.k === "play" && e.p === seat).length;
    case "tc": {
      let n = 0;
      for (let i = 0; i <= j; i++) if (turns[i]!.p === seat) n++;
      return n;
    }
    case "turn":
      return t.n;
  }
}

function compare(x: number, op: Op, v: number): boolean {
  switch (op) {
    case "eq":
      return x === v;
    case "ne":
      return x !== v;
    case "ge":
      return x >= v;
    case "le":
      return x <= v;
    case "gt":
      return x > v;
    case "lt":
      return x < v;
  }
}

/** 条件 c の「何が」の部分（あるターン j で満たすか） */
function turnPred(c: Cond): TurnPred {
  const ids = cardIdsOf(c.card);
  const card = (id: string | undefined) => ids === null || (id !== undefined && ids.has(id));
  const seatOk = (ctx: Ctx, p: PlayerIndex) => c.who === "any" || (c.who === "me" ? p === ctx.me : p !== ctx.me);
  const seats = (ctx: Ctx): PlayerIndex[] => (c.who === "any" ? [0, 1] : c.who === "me" ? [ctx.me] : [ctx.me === 0 ? 1 : 0]);
  const countEvents = (kinds: readonly TurnEventKind[], extra: (e: TurnIndex["ev"][number]) => boolean = () => true): TurnPred => {
    const need = Math.max(1, c.kind === "played" ? c.min : 1);
    return (ctx, j) => {
      let n = 0;
      for (const e of ctx.turns[j]!.ev) if (kinds.includes(e.k) && seatOk(ctx, e.p) && card(e.c) && extra(e) && ++n >= need) return true;
      return false;
    };
  };
  switch (c.kind) {
    case "decided":
      return (ctx, j) => {
        const { winner, ended } = ctx.game.index;
        return ended && winner !== null && j === ctx.turns.length - 1 && seatOk(ctx, winner);
      };
    case "played":
      return countEvents(["play"]);
    case "evolved":
      return countEvents(c.mode === "evolve" ? ["evolve"] : c.mode === "super" ? ["superEvolve"] : ["evolve", "superEvolve"]);
    case "attacked":
      return countEvents(["attack"], (e) => c.target === "any" || (c.target === "leader") === (e.t === "leader"));
    case "entered":
      return countEvents(["enter"]);
    case "left":
      return countEvents(["leave"]);
    case "extraPp":
      return countEvents(["extraPp"]);
    case "survived":
      return (ctx, j) => {
        const next = ctx.turns[j + 1];
        if (!next) return false;
        return seats(ctx).some((seat) => {
          const later = new Set(next.end[seat].board.map((b) => b.i));
          return ctx.turns[j]!.end[seat].board.some((b) => card(b.c) && later.has(b.i));
        });
      };
    case "onBoard":
      return (ctx, j) => seats(ctx).some((seat) => (c.when === "start" ? ctx.turns[j]!.start : ctx.turns[j]!.end)[seat].board.some((b) => card(b.c)));
    case "inHand":
      return (ctx, j) => seats(ctx).some((seat) => (c.when === "start" ? ctx.turns[j]!.start : ctx.turns[j]!.end)[seat].hand.some((id) => card(id)));
    case "num":
      return (ctx, j) => seats(ctx).some((seat) => compare(numValue(ctx.turns, j, seat, c.field, c.when), c.op, c.value));
  }
}

// ---- 式で書く条件のための見え方（自分・相手から見たターン） ----

export interface SnapView {
  hp: number;
  maxHp: number;
  maxPp: number;
  pp: number;
  /** PP＋エクストラPP（エクストラPPを使えるなら PP＋1） */
  ppx: number;
  ep: number;
  sep: number;
  xpp: boolean;
  deck: number;
  grave: number;
  /** 手札のカード名 */
  hand: string[];
  board: { name: string; attack: number; defense: number; evolve: number; amulet: boolean; countdown: number | null }[];
}

export interface SideView {
  start: SnapView;
  end: SnapView;
  /** このターンにプレイしたカード名 */
  played: string[];
  /** 進化（超進化を含む）・超進化したカード名 */
  evolved: string[];
  superEvolved: string[];
  attacks: { name: string; target: string }[];
  entered: string[];
  left: string[];
  extraPp: boolean;
  /** このターンに受けたダメージ */
  dmg: number;
  /** そのプレイヤーの何ターン目（このターンまでの、そのプレイヤーのターンの数） */
  tc: number;
}

export interface TurnView {
  /** 全体のターン番号 */
  n: number;
  /** 試合の中のターンの添字（0〜） */
  k: number;
  /** 自分のターンか */
  mine: boolean;
  me: SideView;
  opp: SideView;
  /** このターンで決着したなら勝った側 */
  decided: "me" | "opp" | null;
  prev: TurnView | null;
  next: TurnView | null;
}

export interface GameView {
  turns: TurnView[];
  /** 自分が勝ったか（決着していなければ null） */
  won: boolean | null;
  /** 自分が先攻か */
  first: boolean;
  myDeck: string;
  oppDeck: string;
  myClass: string;
  oppClass: string;
}

function snapView(s: SideSnap): SnapView {
  return {
    hp: s.hp,
    maxHp: s.maxHp,
    maxPp: s.maxPp,
    pp: s.pp,
    ppx: s.pp + (s.xpp ? 1 : 0),
    ep: s.ep,
    sep: s.sep,
    xpp: s.xpp,
    deck: s.deck,
    grave: s.grave,
    hand: s.hand.map(nameOf),
    board: s.board.map((b) => ({ name: nameOf(b.c), attack: b.a ?? 0, defense: b.d ?? 0, evolve: b.e ?? 0, amulet: !isFollower(b), countdown: b.cd ?? null })),
  };
}

export function gameView(game: LoadedGame, me: PlayerIndex): GameView {
  const { turns } = game.index;
  const tcs: [number, number] = [0, 0];
  const views: TurnView[] = turns.map((t, k) => {
    tcs[t.p]++;
    const side = (seat: PlayerIndex): SideView => {
      const mineEv = t.ev.filter((e) => e.p === seat);
      const names = (kinds: readonly TurnEventKind[]) => mineEv.filter((e) => kinds.includes(e.k)).map((e) => nameOf(e.c ?? ""));
      return {
        start: snapView(t.start[seat]),
        end: snapView(t.end[seat]),
        played: names(["play"]),
        evolved: names(["evolve", "superEvolve"]),
        superEvolved: names(["superEvolve"]),
        attacks: mineEv.filter((e) => e.k === "attack").map((e) => ({ name: nameOf(e.c ?? ""), target: e.t === "leader" ? "リーダー" : nameOf(e.t ?? "") })),
        entered: names(["enter"]),
        left: names(["leave"]),
        extraPp: mineEv.some((e) => e.k === "extraPp"),
        dmg: t.start[seat].hp - t.end[seat].hp,
        tc: tcs[seat],
      };
    };
    const opp: PlayerIndex = me === 0 ? 1 : 0;
    const last = k === turns.length - 1 && game.index.ended && game.index.winner !== null;
    return { n: t.n, k, mine: t.p === me, me: side(me), opp: side(opp), decided: last ? (game.index.winner === me ? "me" : "opp") : null, prev: null, next: null };
  });
  views.forEach((v, k) => {
    v.prev = views[k - 1] ?? null;
    v.next = views[k + 1] ?? null;
  });
  const opp: PlayerIndex = me === 0 ? 1 : 0;
  return {
    turns: views,
    won: game.index.winner === null ? null : game.index.winner === me,
    first: game.index.first === me,
    myDeck: game.record.names[me],
    oppDeck: game.record.names[opp],
    myClass: CLASS_NAMES[game.classes[me]],
    oppClass: CLASS_NAMES[game.classes[opp]],
  };
}

/** 式に渡す補助: リストのどれかが text を含むか・含むものの数 */
const has = (list: readonly string[], text: string): boolean => list.some((x) => x.includes(text));
const count = (list: readonly string[], text: string): number => list.filter((x) => x.includes(text)).length;

type ExprFn = (t: TurnView, g: GameView, hasFn: typeof has, countFn: typeof count) => unknown;

/** 式を関数にする（書き方が正しくなければエラーを投げる） */
export function compileExpr(expr: string): ExprFn | null {
  if (expr.trim() === "") return null;
  // 開発サーバーだけの機能なので、書いた式をそのまま実行する
  return new Function("t", "g", "has", "count", `"use strict"; return (${expr}\n);`) as ExprFn;
}

// ---- 検索 ----

/** 見つけたターン 1 つ（一覧の 1 行） */
export interface MatchRow {
  /** 試合を持つ Worker の番号（検索した側が付ける）と、Worker の中での試合の番号 */
  w: number;
  id: number;
  me: PlayerIndex;
  /** 試合の中のターンの添字 */
  k: number;
  file: string;
  line: number;
  sub: number;
  g?: number;
  myDeck: string;
  oppDeck: string;
  myClass: ClassId;
  oppClass: ClassId;
  first: boolean;
  won: boolean | null;
  /** 全体のターン番号・手番が自分か・手番のプレイヤーの何ターン目か */
  n: number;
  mine: boolean;
  tc: number;
  /** ターンの始めの体力（自分・相手） */
  hp: [number, number];
  /** ターンの始めの手番のプレイヤーの PP最大値と PP＋エクストラPP */
  maxPp: number;
  ppx: number;
  /** 手番のプレイヤーがこのターンにプレイしたカード名 */
  played: string[];
  /** リプレイで開く局面（ターンの始め） */
  step: number;
  mismatch: boolean;
}

export interface SearchStats {
  /** 条件に合ったターンの数（firstOnly なら試合の数と同じ） */
  turns: number;
  /** 条件に合うターンがあった試合（視点）の数と、そのうち自分が勝った数 */
  games: number;
  wins: number;
  /** クラス・デッキ・先攻後攻・勝敗で絞った試合（視点）の数と、そのうち自分が勝った数 */
  scanned: number;
  scannedWins: number;
  /** 式の実行で起きた最初のエラー */
  exprError?: string;
}

export interface CompiledQuery {
  query: ReplayQuery;
  /** 視点の絞り込み（クラス・デッキ・先攻後攻・勝敗） */
  viewOk: (game: LoadedGame, me: PlayerIndex) => boolean;
  conds: { scope: Scope; negate: boolean; pred: TurnPred }[];
  expr: ExprFn | null;
}

export function compileQuery(q: ReplayQuery): CompiledQuery {
  const myDeck = q.myDeck.trim();
  const oppDeck = q.oppDeck.trim();
  const viewOk = (game: LoadedGame, me: PlayerIndex): boolean => {
    const opp: PlayerIndex = me === 0 ? 1 : 0;
    if (q.myClass && game.classes[me] !== q.myClass) return false;
    if (q.oppClass && game.classes[opp] !== q.oppClass) return false;
    if (myDeck && !game.record.names[me].includes(myDeck)) return false;
    if (oppDeck && !game.record.names[opp].includes(oppDeck)) return false;
    if (q.order !== "any" && (game.index.first === me) !== (q.order === "first")) return false;
    if (q.result !== "any" && (game.index.winner === null || (game.index.winner === me) !== (q.result === "win"))) return false;
    return true;
  };
  return { query: q, viewOk, conds: q.conds.map((c) => ({ scope: c.scope, negate: c.negate, pred: turnPred(c) })), expr: compileExpr(q.expr) };
}

/** games から条件に合うターンを探す。一覧は limit 行まで（数は全部数える） */
export function searchGames(games: readonly LoadedGame[], cq: CompiledQuery, limit: number): { rows: Omit<MatchRow, "w">[]; stats: SearchStats } {
  const q = cq.query;
  const rows: Omit<MatchRow, "w">[] = [];
  const stats: SearchStats = { turns: 0, games: 0, wins: 0, scanned: 0, scannedWins: 0 };
  for (const game of games) {
    const turns = game.index.turns;
    for (const me of [0, 1] as const) {
      if (!cq.viewOk(game, me)) continue;
      stats.scanned++;
      const won = game.index.winner === null ? null : game.index.winner === me;
      if (won) stats.scannedWins++;
      const ctx: Ctx = { game, turns, me };
      let view: GameView | null = null;
      let hit = false;
      for (let k = 0; k < turns.length; k++) {
        const t = turns[k]!;
        if (q.whose !== "any" && (t.p === me) !== (q.whose === "me")) continue;
        if (!cq.conds.every((c) => someInScope(ctx, k, c.scope, (j) => c.pred(ctx, j)) !== c.negate)) continue;
        if (cq.expr) {
          view ??= gameView(game, me);
          let ok = false;
          try {
            ok = Boolean(cq.expr(view.turns[k]!, view, has, count));
          } catch (e) {
            stats.exprError ??= e instanceof Error ? e.message : String(e);
          }
          if (!ok) continue;
        }
        hit = true;
        stats.turns++;
        if (rows.length < limit) rows.push(matchRow(game, me, k));
        if (q.firstOnly) break;
      }
      if (hit) {
        stats.games++;
        if (won) stats.wins++;
      }
    }
  }
  return { rows, stats };
}

function matchRow(game: LoadedGame, me: PlayerIndex, k: number): Omit<MatchRow, "w"> {
  const t = game.index.turns[k]!;
  const opp: PlayerIndex = me === 0 ? 1 : 0;
  const s = t.start[t.p];
  const row: Omit<MatchRow, "w"> = {
    id: game.id,
    me,
    k,
    file: game.file,
    line: game.line,
    sub: game.sub,
    myDeck: game.record.names[me],
    oppDeck: game.record.names[opp],
    myClass: game.classes[me],
    oppClass: game.classes[opp],
    first: game.index.first === me,
    won: game.index.winner === null ? null : game.index.winner === me,
    n: t.n,
    mine: t.p === me,
    tc: t.tc,
    hp: [t.start[me].hp, t.start[opp].hp],
    maxPp: s.maxPp,
    ppx: s.pp + (s.xpp ? 1 : 0),
    played: t.ev.filter((e) => e.k === "play" && e.p === t.p).map((e) => nameOf(e.c ?? "")),
    step: t.s,
    mismatch: game.mismatch,
  };
  if (game.record.g !== undefined) row.g = game.record.g;
  return row;
}
