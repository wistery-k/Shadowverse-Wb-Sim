// 選択できる AI の一覧（UI・自動対戦で共通）

import { greedyAgent, tunedGreedyAgent } from "./greedy";
import { randomAgent } from "./random";
import { rhinoAgent } from "./rhino";
import { searchAgent } from "./search";
import type { Agent } from "./types";

export const AGENTS: Readonly<Record<string, { agent: Agent; label: string }>> = {
  search: { agent: searchAgent, label: "探索" },
  rhino: { agent: rhinoAgent, label: "リノセウス用ルール＋探索" },
  greedy: { agent: tunedGreedyAgent, label: "貪欲法" },
  "greedy-base": { agent: greedyAgent, label: "貪欲法（基準の重み）" },
  random: { agent: randomAgent, label: "ランダム" },
};

export function agentOf(key: string): Agent {
  const entry = AGENTS[key];
  if (!entry) throw new Error(`未知の AI: ${key}`);
  return entry.agent;
}
