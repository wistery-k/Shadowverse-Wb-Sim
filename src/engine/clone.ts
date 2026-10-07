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

const cloneHand = (h: HandCard): HandCard => ({ ...h, keywords: [...h.keywords], fusedKinds: [...h.fusedKinds] });

const cloneBoard = (c: OnBoard): OnBoard =>
  c.kind === "follower"
    ? {
        ...c,
        keywords: [...c.keywords],
        tempKeywords: [...c.tempKeywords],
        granted: [...c.granted],
        usedOncePerTurn: { ...c.usedOncePerTurn },
      }
    : { ...c, keywords: [...c.keywords], tempKeywords: [...c.tempKeywords], granted: [...c.granted] };

const clonePlayer = (p: PlayerState): PlayerState => ({
  ...p,
  deck: [...p.deck], // CardRef は書き換えない
  hand: p.hand.map(cloneHand),
  board: p.board.map(cloneBoard),
  crests: p.crests.map((c) => ({ ...c, usedOncePerTurn: { ...c.usedOncePerTurn } })),
  graveyardFollowers: [...p.graveyardFollowers],
  destroyedAmulets: [...p.destroyedAmulets],
  destroyedThisTurn: [...p.destroyedThisTurn], // 記録は書き換えない
  leaderOncePerTurn: { ...p.leaderOncePerTurn },
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
