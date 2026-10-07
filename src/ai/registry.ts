// 選択できる AI の一覧（UI・自動対戦で共通）

import { greedyAgent } from "./greedy";
import { randomAgent } from "./random";
import { searchAgent } from "./search";
import type { Agent } from "./types";

export const AGENTS: Readonly<Record<string, { agent: Agent; label: string }>> = {
  search: { agent: searchAgent, label: "探索" },
  greedy: { agent: greedyAgent, label: "貪欲法" },
  random: { agent: randomAgent, label: "ランダム" },
};

export function agentOf(key: string): Agent {
  const entry = AGENTS[key];
  if (!entry) throw new Error(`未知の AI: ${key}`);
  return entry.agent;
}
