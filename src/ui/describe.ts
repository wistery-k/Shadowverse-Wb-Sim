// UI 表示用の文言

import { ALL_CARDS, CLASS_NAMES, type Card, type ClassId } from "../cards";
import {
  abilitiesOf,
  actingPlayer,
  attackReach,
  cardOf,
  crestOf,
  findBoard,
  findHand,
  type Action,
  type GameState,
  type PlayerIndex,
  type StaticKeyword,
} from "../engine";

export const KEYWORD_NAMES: Record<StaticKeyword, string> = {
  ward: "守護",
  storm: "疾走",
  rush: "突進",
  bane: "必殺",
  drain: "ドレイン",
  ambush: "潜伏",
  intimidate: "威圧",
  barrier: "バリア",
  aura: "オーラ",
};

export const TYPE_NAMES: Record<Card["type"], string> = {
  follower: "フォロワー",
  spell: "スペル",
  amulet: "アミュレット",
};

export const classLabel = (card: Card) => CLASS_NAMES[card.class];

/** 攻撃の可否（leader: リーダーにも攻撃できる / follower: フォロワーにだけ攻撃できる / none: 攻撃できない） */
export type AttackStatus = "leader" | "follower" | "none";

/** 手番のプレイヤーの場のフォロワーごとの攻撃の可否。相手の場（守護・攻撃先の有無）は見ず、フォロワー自身の状態で決める。
 *  能力の対象を選んでいるあいだも表示し続ける。メインフェイズでなければ空 */
export function attackStatuses(state: GameState): Map<number, AttackStatus> {
  const m = new Map<number, AttackStatus>();
  if (state.phase !== "main") return m;
  for (const c of state.players[state.active].board) if (c.kind === "follower") m.set(c.iid, attackReach(state, c));
  return m;
}

/** 各プレイヤーのクラス（試合開始時の局面の山札・手札にあるニュートラル以外のカードから決める） */
export function leaderClasses(state: GameState): [ClassId, ClassId] {
  const classOf = (p: PlayerIndex): ClassId => {
    const pl = state.players[p];
    for (const c of [...pl.deck, ...pl.hand, ...pl.board]) {
      const cls = cardOf(c.cardId).class;
      if (cls !== "neutral") return cls;
    }
    return "neutral";
  };
  return [classOf(0), classOf(1)];
}

/** 文言の視点: 人間のプレイヤー（「あなた」「相手」と呼ぶ）か、各プレイヤーの名前 */
export type Viewer = PlayerIndex | readonly [string, string];

export const playerName = (p: PlayerIndex, viewer: Viewer) =>
  typeof viewer === "number" ? (p === viewer ? "あなた" : "相手") : viewer[p];

/** 実体ID（場・手札・リーダー）の表示名 */
export function entityName(state: GameState, iid: number, human: Viewer): string {
  if (iid < 0) return `${playerName(iid === -1 ? 0 : 1, human)}のリーダー`;
  const b = findBoard(state, iid);
  if (b) return cardOf(b.card.cardId).name;
  const h = findHand(state, iid);
  if (h) return cardOf(h.card.cardId).name;
  return "（不明）";
}

/** JSON にしたときの中身を比べるための文字列（オブジェクトのキーの順は問わない） */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** 能力のデータの中の【モード】の効果をすべて探す */
function collectModes(v: unknown, found: (mode: unknown) => void): void {
  if (Array.isArray(v)) {
    for (const x of v) collectModes(x, found);
  } else if (v !== null && typeof v === "object") {
    if ("op" in v && v.op === "mode") found(v);
    for (const x of Object.values(v)) collectModes(x, found);
  }
}

/** 【モード】の効果（canonicalJson）→ その効果を能力に持つカードのID */
let modeCards: Map<string, string> | undefined;

/** モード選択待ちの【モード】の効果を持つカードのID。
 *  局面（エンジンの JSON）にはどのカードの能力かが入っていない（スペルはプレイすると場にも手札にも残らない）ので、
 *  解決中の効果の中身をカードの能力のデータと突き合わせて引く */
export function modeSourceCard(state: GameState): string | null {
  const frame = state.stack[state.stack.length - 1];
  if (!frame || state.pending?.kind !== "mode") return null;
  if (!modeCards) {
    const m = new Map<string, string>();
    for (const card of ALL_CARDS) {
      collectModes(abilitiesOf(card.id), (mode) => {
        const key = canonicalJson(mode);
        if (!m.has(key)) m.set(key, card.id);
      });
    }
    modeCards = m;
  }
  return modeCards.get(canonicalJson(frame.effects[frame.pc])) ?? null;
}

/** モードの選択肢の文言（そのカードの能力テキストの「（1）…」の行） */
export function modeLabels(state: GameState): string[] {
  const pending = state.pending;
  if (pending?.kind !== "mode") return [];
  const cardId = modeSourceCard(state);
  const text = cardId ? cardOf(cardId).text : "";
  const lines = text.split("\n").filter((l) => /^（\d）/.test(l));
  return Array.from({ length: pending.options }, (_, i) => lines[i] ?? `選択肢${i + 1}`);
}

/** アクションを（実行前の状態で）説明する。after（実行後の状態）を渡すと、マリガンで引いたカードも書く */
export function describeAction(state: GameState, action: Action, human: Viewer, after?: GameState): string {
  const who = playerName(state.pending?.player ?? state.active, human);
  const name = (iid: number) => entityName(state, iid, human);
  switch (action.type) {
    case "mulligan":
      return describeMulligan(state, action, human, after);
    case "play":
      return `${who}: ${name(action.iid)}をプレイ`;
    case "attack":
      return `${who}: ${name(action.attacker)}で${action.target === "leader" ? "リーダー" : name(action.target)}を攻撃`;
    case "evolve":
      return `${who}: ${name(action.iid)}を進化`;
    case "superEvolve":
      return `${who}: ${name(action.iid)}を超進化`;
    case "act":
      return `${who}: ${name(action.iid)}をアクト`;
    case "fuse":
      return `${who}: ${name(action.host)}に${action.materials.map(name).join("・")}を融合`;
    case "choose":
      return `${who}: ${describeChosen(state, action.targets, human)}を選択`;
    case "mode": {
      const cardId = modeSourceCard(state);
      const label = modeLabels(state)[action.index] ?? `選択肢${action.index + 1}`;
      return `${who}: ${cardId ? `${cardOf(cardId).name}の` : ""}モード「${label}」を選択`;
    }
    case "extraPp":
      return `${who}: エクストラPP`;
    case "endTurn":
      return `${who}: ターン終了`;
  }
}

/** 選んだ対象。人間の視点では、相手が手札から選んだカードは枚数だけ書く（捨てる・山札に戻すカードはどれか分からない。docs/rules.md 11章） */
function describeChosen(state: GameState, targets: readonly number[], human: Viewer): string {
  const chooser = state.pending?.player ?? state.active;
  const hidden = (iid: number) =>
    typeof human === "number" && chooser !== human && state.players[chooser].hand.some((h) => h.iid === iid);
  const parts = targets.filter((t) => !hidden(t)).map((t) => entityName(state, t, human));
  const fromHand = targets.filter(hidden).length;
  if (fromHand > 0) parts.push(`手札${fromHand}枚`);
  return parts.join("・") || "なし";
}

/**
 * 局面 state で打てる手の文言の一覧（打つ前の局面で説明する。手番のプレイヤーの「名前: 」は省く）。
 * 同じ名前のカードが 2 枚以上あって文言が同じになるときは、何枚目かを付けて区別する
 */
export function actionLabels(state: GameState, actions: readonly Action[], names: readonly [string, string]): string[] {
  const prefix = `${names[actingPlayer(state)]}: `;
  // マリガンで引くカードは分からないので after は渡さない
  const labels = actions.map((a) => {
    const text = describeAction(state, a, names);
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
  });
  const count = new Map<string, number>();
  for (const l of labels) count.set(l, (count.get(l) ?? 0) + 1);
  const seen = new Map<string, number>();
  return labels.map((l) => {
    if (count.get(l)! < 2) return l;
    const k = (seen.get(l) ?? 0) + 1;
    seen.set(l, k);
    return `${l}（${k} 枚目）`;
  });
}

/** マリガン: 残したカードと返したカード（と引いたカード）。人間の視点では相手の手札は書かない */
function describeMulligan(state: GameState, action: Extract<Action, { type: "mulligan" }>, human: Viewer, after?: GameState): string {
  const who = playerName(action.player, human);
  if (typeof human === "number" && action.player !== human) return `${who}: マリガン（${action.swap.length}枚入れ替え）`;
  const hand = state.players[action.player].hand;
  const names = (cards: readonly { cardId: string }[]) => cards.map((c) => cardOf(c.cardId).name).join("、") || "なし";
  const returned = hand.filter((h) => action.swap.includes(h.iid));
  const kept = hand.filter((h) => !action.swap.includes(h.iid));
  let text = `${who}: マリガン（残す: ${names(kept)} / 返す: ${names(returned)}`;
  if (after && returned.length > 0) {
    const before = new Set(hand.map((h) => h.iid));
    const drawn = after.players[action.player].hand.filter((h) => !before.has(h.iid)).slice(0, returned.length);
    text += ` → 引いた: ${names(drawn)}`;
  }
  return `${text}）`;
}

export function crestName(crestId: string): string {
  return crestOf(crestId).name;
}
