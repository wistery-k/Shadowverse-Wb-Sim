// GameState の高速な複製（structuredClone の数倍速い。AI の探索で多用する）。
// 能力・効果のデータ（Ability, Effect）は書き換えない約束なので共有し、可変な部分だけを複製する。
// 状態の型にフィールドを足したら、ここも更新すること（tests/clone.test.ts が漏れを検出する）。

import type {
  EffectContext,
  GameState,
  HandCard,
  OnBoard,
  PendingChoice,
  PlayerState,
} from "./types";

const cloneCtx = (c: EffectContext): EffectContext => {
  const slots: Record<string, number[]> = {};
  for (const k in c.slots) slots[k] = [...(c.slots[k] as number[])];
  return { ...c, slots, vars: { ...c.vars } };
};

// 手札・場・クレストのカードの配列（keywords 等）と記録（usedOncePerTurn 等）は、エンジンが書き換えずに作り直すので共有する
const cloneHand = (h: HandCard): HandCard => ({ ...h });

const cloneBoard = (c: OnBoard): OnBoard => ({ ...c });

const clonePlayer = (p: PlayerState): PlayerState => ({
  ...p,
  deck: [...p.deck], // CardRef は書き換えない
  hand: p.hand.map(cloneHand),
  board: p.board.map(cloneBoard),
  crests: p.crests.map((c) => ({ ...c })),
  graveyardFollowers: [...p.graveyardFollowers],
  destroyedAmulets: [...p.destroyedAmulets],
  destroyedThisTurn: [...p.destroyedThisTurn], // 記録は書き換えない
});

const clonePending = (p: PendingChoice | null): PendingChoice | null =>
  p === null ? null : p.kind === "choose" ? { ...p, candidates: [...p.candidates] } : { ...p };

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    players: [clonePlayer(s.players[0]), clonePlayer(s.players[1])],
    stack: s.stack.map((f) => ({ effects: f.effects, pc: f.pc, ctx: cloneCtx(f.ctx) })),
    queue: s.queue.map((q) => ({ ability: q.ability, ctx: cloneCtx(q.ctx) })),
    pending: clonePending(s.pending),
    attack: s.attack ? { ...s.attack } : null,
  };
}
