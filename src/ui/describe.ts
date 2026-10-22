// UI 表示用の文言

import { CLASS_NAMES, type Card, type ClassId } from "../cards";
import {
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

/** モードの選択肢の文言（能力テキストの「（1）…」の行） */
export function modeLabels(state: GameState): string[] {
  const frame = state.stack[state.stack.length - 1];
  const pending = state.pending;
  if (!frame || pending?.kind !== "mode") return [];
  const text = frame.ctx.sourceCardId ? cardOf(frame.ctx.sourceCardId).text : "";
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
    case "mode":
      return `${who}: ${modeLabels(state)[action.index] ?? `モード${action.index + 1}`}を選択`;
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
