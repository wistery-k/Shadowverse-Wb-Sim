// ルールエンジンの入口: 対戦の生成、合法手の列挙、アクションの適用。
// ルールの処理は Rust のエンジン（rust/engine）を WASM にしたものが行う（src/engine/wasm.ts）。ここは呼び方を揃える薄い層。
// applyAction は新しい状態を返す（引数の状態は変更しない）。

import type { Card } from "../cards";
import { enhanceCost } from "./keywords";
import { handCost, opponent } from "./state";
import type { Action, AttackTarget, FollowerOnBoard, GameState, HandCard, PlayerIndex } from "./types";
import { callEngine } from "./wasm";

export { opponent } from "./state";
export { cardOf } from "./registry";
export { IllegalActionError, initEngine } from "./wasm";

export interface GameConfig {
  /** 各プレイヤーのデッキ（カードIDの配列） */
  decks: [readonly string[], readonly string[]];
  seed: number;
}

// WASM の結果は Rust のエンジンが書き出した GameState・Action と同じ形の JSON（rust/engine/src/state_json.rs）なので、検証せずに型を付ける

export function createGame(config: GameConfig): GameState {
  return callEngine({ f: "createGame", decks: config.decks, seed: config.seed >>> 0 }) as GameState;
}

export function legalActions(state: GameState): Action[] {
  return callEngine({ f: "legalActions", state }) as Action[];
}

/** 行動を打った局面。打てない手なら IllegalActionError を投げる */
export function applyAction(prev: GameState, action: Action): GameState {
  return callEngine({ f: "applyAction", state: prev, action }) as GameState;
}

/** 打てる手なら打った局面、不正な手なら null */
export function tryApplyAction(prev: GameState, action: Action): GameState | null {
  return callEngine({ f: "tryApplyAction", state: prev, action }) as GameState | null;
}

/**
 * ターン終了時の処理だけを行った局面（相手のターンには進めない）。処理が無ければ prev をそのまま返す。
 * 選択待ち・解決中・メインフェイズ以外なら何もしない
 */
export function resolveTurnEnd(prev: GameState): GameState {
  return (callEngine({ f: "resolveTurnEnd", state: prev }) as GameState | null) ?? prev;
}

/** カードを使うときのコスト（エンハンスが使える PP なら、エンハンスのコスト） */
export function playCost(card: Card, pp: number, hand?: HandCard): number {
  const cost = hand ? handCost(hand) : card.cost;
  const enhance = enhanceCost(card.text);
  return enhance !== null && pp >= enhance && enhance > cost ? enhance : cost;
}

/** フォロワー自身の状態による攻撃の可否（相手の場は見ない）。leader: リーダーにも / follower: フォロワーにだけ / none: できない */
export function attackReach(state: GameState, f: FollowerOnBoard): "leader" | "follower" | "none" {
  return callEngine({ f: "attackReach", state, attacker: f.iid }) as "leader" | "follower" | "none";
}

/** 攻撃先の候補（守護を考慮済み） */
export function attackTargets(state: GameState, attacker: FollowerOnBoard): AttackTarget[] {
  return callEngine({ f: "attackTargets", state, attacker: attacker.iid }) as AttackTarget[];
}

/** 融合の素材にできる手札のカード（メインフェイズの手番のプレイヤーの手札から） */
export function fusionCandidates(state: GameState, hostIid: number): number[] {
  return callEngine({ f: "fusionCandidates", state, host: hostIid }) as number[];
}

/** 次に行動するプレイヤー（選択待ちならその選択をするプレイヤー、マリガンなら先攻から） */
export function actingPlayer(state: GameState): PlayerIndex {
  if (state.pending) return state.pending.player;
  if (state.phase === "mulligan") {
    for (const p of [state.first, opponent(state.first)]) if (!state.players[p].mulliganDone) return p;
    return state.first;
  }
  return state.active;
}
