// UI 表示用の文言

import { CLASS_NAMES, type Card } from "../cards";
import {
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

/** アクションを（実行前の状態で）説明する */
export function describeAction(state: GameState, action: Action, human: Viewer): string {
  const who = playerName(state.pending?.player ?? state.active, human);
  const name = (iid: number) => entityName(state, iid, human);
  switch (action.type) {
    case "mulligan":
      return `${playerName(action.player, human)}: マリガン（${action.swap.length}枚入れ替え）`;
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
      return `${who}: ${action.targets.map(name).join("・") || "なし"}を選択`;
    case "mode":
      return `${who}: ${modeLabels(state)[action.index] ?? `モード${action.index + 1}`}を選択`;
    case "extraPp":
      return `${who}: エクストラPP`;
    case "endTurn":
      return `${who}: ターン終了`;
  }
}

export function crestName(crestId: string): string {
  return crestOf(crestId).name;
}
