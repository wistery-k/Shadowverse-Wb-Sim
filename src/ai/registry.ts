// 選択できる AI の一覧（UI・自動対戦で共通）。
// AI の本体は Rust（rust/engine/src/ai。名前は rust/engine/src/ai/registry.rs と同じ）で、WASM の中で考える（src/engine/wasm.ts）。

import { callEngine, engineGeneration } from "../engine/wasm";
import type { Action } from "../engine";
import type { Agent } from "./types";

/**
 * WASM の中の AI を呼ぶ Agent。AI は WASM の中に 1 つ作り、試合をまたいで使う（Rust 版の AI が自分で覚えていることは、試合の始めに捨てる）。
 * 乱数は rng の状態を渡し、AI が使った分だけ進めた状態を書き戻す
 */
function wasmAgent(name: string): Agent {
  let handle: { generation: number; id: number } | null = null;
  return {
    name,
    chooseAction(state, legal, rng) {
      const generation = engineGeneration();
      if (handle?.generation !== generation) handle = { generation, id: callEngine({ f: "agentNew", name }) as number };
      const r = callEngine({ f: "agentChoose", handle: handle.id, state, legal, rng: rng.state }) as { action: Action; rng: number };
      rng.state = r.rng;
      return r.action;
    },
  };
}

export const AGENTS: Readonly<Record<string, { agent: Agent; label: string }>> = {
  search: { agent: wasmAgent("search"), label: "探索" },
  // 学習した評価の補正（data/value-net.json）と相手のターンのビームサーチを入れる前の探索 AI（rhino-compare の相手）
  "search-classic": { agent: wasmAgent("search-classic"), label: "探索（学習した補正なし）" },
  // 強さの物差しの相手（rust/engine/src/runner/yardstick.rs で凍結した search-classic）。人間との比較の相手（既定）
  yardstick: { agent: wasmAgent("yardstick"), label: "物差し（凍結した探索）" },
  rhino: { agent: wasmAgent("rhino"), label: "探索＋リノセウス用の評価・リーサル" },
  "rhino-lethal": { agent: wasmAgent("rhino-lethal"), label: "探索＋リノセウス用リーサル" },
  greedy: { agent: wasmAgent("greedy"), label: "貪欲法" },
  "greedy-base": { agent: wasmAgent("greedy-base"), label: "貪欲法（基準の重み）" },
  random: { agent: wasmAgent("random"), label: "ランダム" },
};

export function agentOf(key: string): Agent {
  const entry = AGENTS[key];
  if (!entry) throw new Error(`未知の AI: ${key}`);
  return entry.agent;
}
