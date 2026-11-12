// 見落とし問題集（misses/*.json。docs/misses.md）の問を読み、合格の条件を文にし、1 ターンの手の並びが合格かを判定する。
// 問題集のページ（src/ui/Misses.tsx）で使う。判定の決まりは Rust の rust/engine/src/runner/misses.rs
// （step_of・matches・passes・play_turn）と同じ。どちらかを変えるときは両方を直す。

import { actingPlayer, applyAction, cardOf, type Action, type GameState, type PlayerIndex } from "../engine";

// ---------------------------------------------------------------- 合格の条件

export type Verb = "play" | "attack" | "evolve" | "superEvolve" | "act" | "fuse" | "choose" | "mode" | "target";
const VERBS: readonly Verb[] = ["play", "attack", "evolve", "superEvolve", "act", "fuse", "choose", "mode", "target"];

/** どれでもよいカード */
export const ANY = "*";
export const OPP_LEADER = "相手のリーダー";
export const MY_LEADER = "自分のリーダー";

/** 手の形（`{"play":"魔女の錬金釜"}` 等） */
export interface Pattern {
  verb: Verb;
  /** カードの名前（`*` はどれでも）。mode なら空 */
  card: string;
  /** mode の番号（1 から） */
  mode: number;
  /** attack の攻撃先（無ければどれでも） */
  target: string | null;
  /** choose・mode を求めたカード（無ければどれでも） */
  by: string | null;
}

/** 条件の 1 組（全部を満たせば合格） */
export interface Cond {
  must: Pattern[];
  mustNot: Pattern[];
  win: boolean;
  minHp: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isVerb = (k: string): k is Verb => (VERBS as readonly string[]).includes(k);

function parsePattern(v: unknown): Pattern {
  if (!isObj(v)) throw new Error(`手は {"play":"カード名"} の形: ${JSON.stringify(v)}`);
  const p: Pattern = { verb: "play", card: "", mode: 0, target: null, by: null };
  let verb: Verb | null = null;
  const text = (k: string, x: unknown): string => {
    if (typeof x !== "string") throw new Error(`"${k}" はカードの名前（文字列）: ${JSON.stringify(x)}`);
    return x;
  };
  for (const [k, x] of Object.entries(v)) {
    if (k === "target") p.target = text(k, x);
    else if (k === "by") p.by = text(k, x);
    else if (isVerb(k)) {
      if (verb) throw new Error(`手の種類は 1 つだけ: ${JSON.stringify(v)}`);
      verb = k;
      if (k === "mode") {
        if (typeof x !== "number" || !Number.isInteger(x) || x < 1) throw new Error(`"mode" は 1 からの番号: ${JSON.stringify(x)}`);
        p.mode = x;
      } else p.card = text(k, x);
    } else throw new Error(`知らない項目: ${k}`);
  }
  // {"target": "X"} だけなら「攻撃先か選んだカードに X を含む」
  if (!verb && p.target !== null) {
    verb = "target";
    p.card = p.target;
    p.target = null;
  }
  if (!verb) throw new Error(`手の種類がありません: ${JSON.stringify(v)}`);
  p.verb = verb;
  return p;
}

function parseCond(v: unknown): Cond {
  if (!isObj(v)) throw new Error("合格の条件はオブジェクトか、オブジェクトの配列");
  const c: Cond = { must: [], mustNot: [], win: false, minHp: null };
  const list = (k: string, x: unknown) => {
    if (!Array.isArray(x)) throw new Error(`"${k}" は手の配列`);
    return x.map(parsePattern);
  };
  for (const [k, x] of Object.entries(v)) {
    if (k === "must") c.must = list(k, x);
    else if (k === "mustNot") c.mustNot = list(k, x);
    else if (k === "win") {
      if (typeof x !== "boolean") throw new Error(`"win" は true か false`);
      c.win = x;
    } else if (k === "minHp") {
      if (typeof x !== "number" || !Number.isInteger(x)) throw new Error(`"minHp" は整数`);
      c.minHp = x;
    } else throw new Error(`合格の条件の知らない項目: ${k}`);
  }
  return c;
}

/** 合格の条件（どれか 1 組を満たせば合格） */
export function parsePass(v: unknown): Cond[] {
  const conds = Array.isArray(v) ? v.map(parseCond) : [parseCond(v)];
  if (conds.length === 0) throw new Error("合格の条件が空です");
  return conds;
}

const cardText = (name: string) => (name === ANY ? "どれか" : name);

/** 手の形の文（「魔女の錬金釜をプレイ」等） */
export function patternText(p: Pattern): string {
  const card = cardText(p.card);
  const by = p.by !== null ? `${cardText(p.by)}で` : "";
  switch (p.verb) {
    case "play":
      return `${card}をプレイ`;
    case "attack":
      return `${card}で${p.target !== null ? cardText(p.target) : "どこか"}を攻撃`;
    case "evolve":
      return `${card}を進化`;
    case "superEvolve":
      return `${card}を超進化`;
    case "act":
      return `${card}の能力を使う`;
    case "fuse":
      return `${card}に融合`;
    case "choose":
      return `${by}${card}を選ぶ`;
    case "mode":
      return `${by}${p.mode} 番目の効果を選ぶ`;
    case "target":
      return `${card}を攻撃するか選ぶ（除去の手段は問わない）`;
  }
}

/** 条件 1 組の文 */
export function condTexts(c: Cond): string[] {
  const out: string[] = [];
  if (c.must.length > 0) out.push(`このターンに ${c.must.map(patternText).join("・")} をする`);
  if (c.mustNot.length > 0) out.push(`このターンに ${c.mustNot.map(patternText).join("・")} をしない`);
  if (c.win) out.push("このターンに勝つ");
  if (c.minHp !== null) out.push(`ターンを終えたときの自分の体力が ${c.minHp} 以上（このターンに勝てば満たす）`);
  return out;
}

// ---------------------------------------------------------------- 1 ターンの手

/** 打った手 1 つ（名前は打つ前の局面で引く） */
interface Step {
  verb: Verb | null;
  /** 手のカード（choose なら選んだカード全部） */
  cards: string[];
  mode: number;
  target: string | null;
  by: string | null;
}

/** 実体の名前（席 viewer から見たリーダーの呼び方） */
function nameOf(s: GameState, iid: number, viewer: PlayerIndex): string {
  if (iid < 0) return -iid - 1 === viewer ? MY_LEADER : OPP_LEADER;
  for (const pl of s.players) {
    const h = pl.hand.find((x) => x.iid === iid);
    if (h) return cardOf(h.cardId).name;
    const b = pl.board.find((x) => x.iid === iid);
    if (b) return cardOf(b.cardId).name;
  }
  return `#${iid}`;
}

function stepOf(s: GameState, a: Action, p: PlayerIndex, last: string | null): Step {
  const name = (iid: number) => nameOf(s, iid, p);
  const st: Step = { verb: null, cards: [], mode: 0, target: null, by: null };
  switch (a.type) {
    case "play":
    case "evolve":
    case "superEvolve":
    case "act":
      st.verb = a.type;
      st.cards = [name(a.iid)];
      break;
    case "attack":
      st.verb = "attack";
      st.cards = [name(a.attacker)];
      st.target = a.target === "leader" ? OPP_LEADER : name(a.target);
      break;
    case "fuse":
      st.verb = "fuse";
      st.cards = [name(a.host)];
      break;
    case "choose":
      st.verb = "choose";
      st.cards = a.targets.map(name);
      st.by = last;
      break;
    case "mode":
      st.verb = "mode";
      st.mode = a.index + 1;
      st.by = last;
      break;
    case "mulligan":
    case "extraPp":
    case "endTurn":
      break;
  }
  return st;
}

const same = (want: string, got: string) => want === ANY || want === got;
const optSame = (want: string | null, got: string | null) => want === null || (got !== null && same(want, got));

function matches(p: Pattern, st: Step): boolean {
  const v = st.verb;
  if (v === null) return false;
  switch (p.verb) {
    case "target":
      if (v === "attack") return st.target !== null && same(p.card, st.target);
      if (v === "choose") return st.cards.some((c) => same(p.card, c));
      return false;
    case "mode":
      return v === "mode" && st.mode === p.mode && optSame(p.by, st.by);
    case "choose":
      return v === "choose" && st.cards.some((c) => same(p.card, c)) && optSame(p.by, st.by);
    case "attack":
      return v === "attack" && st.cards.some((c) => same(p.card, c)) && optSame(p.target, st.target);
    default:
      return v === p.verb && st.cards.some((c) => same(p.card, c));
  }
}

/** 手の並びを 1 ターン分として見た結果 */
export interface TurnResult {
  /** ターンが終わったか（並びが途中までならまだ判定できない） */
  done: boolean;
  /** 合格か（done のときだけ） */
  passed: boolean | null;
  won: boolean;
  /** ターンを終えた後の自分の体力 */
  hp: number;
  /** ターンが終わった手の番号（並びの添字。その手までが 1 ターン） */
  endIndex: number | null;
}

/**
 * 局面 start から手の並び actions を打ち、席 p のターンが終わったら合格の条件で判定する（Rust の play_turn・passes と同じ数え方:
 * 席 p の手だけを数え、エクストラPP・ターン終了は数えない。choose・mode は直前のプレイ・アクト・進化・超進化・融合・攻撃のカードで求めたものとする）
 */
export function judgeTurn(start: GameState, actions: readonly Action[], p: PlayerIndex, pass: readonly Cond[]): TurnResult {
  let s = start;
  const steps: Step[] = [];
  let last: string | null = null;
  const result = (done: boolean, won: boolean, endIndex: number | null): TurnResult => ({
    done,
    won,
    hp: s.players[p].leaderHp,
    endIndex,
    passed: done ? passes(pass, steps, won, s.players[p].leaderHp) : null,
  });
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    const actor = actingPlayer(s);
    if (actor === p) {
      const st = stepOf(s, a, p, last);
      if (a.type === "play" || a.type === "act" || a.type === "evolve" || a.type === "superEvolve" || a.type === "fuse" || a.type === "attack") {
        last = st.cards[0] ?? null;
      }
      if (a.type !== "endTurn" && a.type !== "extraPp") steps.push(st);
    }
    const endTurn = actor === p && a.type === "endTurn";
    s = applyAction(s, a);
    // Rust と同じく、ターン終了の手で試合が終わったときは勝ちに数えない
    if (endTurn || (s.phase !== "ended" && s.active !== p)) return result(true, false, i);
    if (s.phase === "ended") return result(true, s.winner === p, i);
  }
  return result(false, false, null);
}

function passes(conds: readonly Cond[], steps: readonly Step[], won: boolean, hp: number): boolean {
  return conds.some(
    (c) =>
      c.must.every((pt) => steps.some((st) => matches(pt, st))) &&
      !c.mustNot.some((pt) => steps.some((st) => matches(pt, st))) &&
      (!c.win || won) &&
      (c.minHp === null || won || hp >= c.minHp),
  );
}

// ---------------------------------------------------------------- 問のファイル

/** 問 1 つ（misses/<問>.json） */
export interface MissProblem {
  id: string;
  title: string;
  note: string;
  source: string;
  added: string;
  /** 解かせる AI（src/ai/registry.ts のキー。search か rhino） */
  agent: "search" | "rhino";
  /** 手番の側 */
  player: PlayerIndex;
  pass: Cond[];
  /** 合格の条件の JSON（そのまま見せる） */
  passJson: string;
  /** 局面の取り方（state: 打ち比べ調査の局面、replay: 記録した試合、human: 人間の対戦記録、two-turn: 手で作った局面） */
  from: string;
  /** 手で作った局面のメモ */
  originNote: string | null;
  /** 元の試合でこの局面から打った手の説明（記録から取った問） */
  played: string[] | null;
  state: GameState;
}

/** 打ち比べ調査で比べた並び（misses/lines/<問>.json。scripts/misses-lines.ts が書く） */
export interface MissLine {
  kind: "ai" | "good";
  label: string;
  /** 局面から打つ手（AI がこの並びを選んだとき、考え直すまでに打つ手） */
  steps: Action[];
  /** steps の説明 */
  text: string[];
  /** 調査で読んだ、ターンの終わりまでの並びの説明（AI から見た局面のもの。途中で引くカードは予想） */
  full: string[];
}
export interface MissLines {
  id: string;
  source: string;
  lines: MissLine[];
}

const str = (v: Record<string, unknown>, k: string): string => {
  const x = v[k];
  if (typeof x !== "string") throw new Error(`"${k}"（文字列）がありません`);
  return x;
};
const strs = (x: unknown, k: string): string[] => {
  if (!Array.isArray(x) || !x.every((s) => typeof s === "string")) throw new Error(`"${k}" は文字列の配列`);
  return x;
};
/** 手の並び（形だけを見る。打てるかは局面に打って確かめる） */
function actions(x: unknown, k: string): Action[] {
  if (!Array.isArray(x) || !x.every((a) => isObj(a) && typeof a.type === "string")) throw new Error(`"${k}" は手の配列`);
  return x as Action[];
}

/** 問のファイルの中身を読む（リポジトリの問。局面の中身は Rust の misses check と npm test が確かめる） */
export function parseProblem(v: unknown): MissProblem {
  if (!isObj(v) || v.v !== 1) throw new Error(`版（"v":1）がありません`);
  const id = str(v, "id");
  try {
    const agent = str(v, "agent");
    if (agent !== "search" && agent !== "rhino") throw new Error(`AI は search か rhino: ${agent}`);
    const player = v.player;
    if (player !== 0 && player !== 1) throw new Error(`"player" は 0 か 1`);
    const state = v.state;
    if (!isObj(state) || !Array.isArray(state.players)) throw new Error(`"state" が局面ではありません`);
    const origin = isObj(v.origin) ? v.origin : {};
    return {
      id,
      title: str(v, "title"),
      note: str(v, "note"),
      source: str(v, "source"),
      added: str(v, "added"),
      agent,
      player,
      pass: parsePass(v.pass),
      passJson: JSON.stringify(v.pass),
      from: typeof origin.from === "string" ? origin.from : "",
      originNote: typeof origin.note === "string" ? origin.note : null,
      played: origin.played === undefined ? null : strs(origin.played, "origin.played"),
      state: state as unknown as GameState,
    };
  } catch (e) {
    throw new Error(`${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function parseLines(v: unknown): MissLines {
  if (!isObj(v) || v.v !== 1) throw new Error(`版（"v":1）がありません`);
  const id = str(v, "id");
  if (!Array.isArray(v.lines)) throw new Error(`${id}: "lines" は配列`);
  return {
    id,
    source: str(v, "source"),
    lines: v.lines.map((l): MissLine => {
      if (!isObj(l) || (l.kind !== "ai" && l.kind !== "good")) throw new Error(`${id}: 並びの "kind" は ai か good`);
      return { kind: l.kind, label: str(l, "label"), steps: actions(l.steps, "steps"), text: strs(l.text, "text"), full: strs(l.full, "full") };
    }),
  };
}
