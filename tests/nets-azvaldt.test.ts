// アズヴォルト環境のページの AI（WASM の探索 AI に、ページが読み込んだ R3 の補正と見込みを入れたもの）が、
// コマンドの R3（compare・misses の --opts の valueNet・potentialNet）と同じ値の補正を持ち、決まった局面から同じ手を打つか。
// 局面と手は tests/fixtures/browser-r3.json（コマンドの R3 の手を rust/engine/tests/browser_r3.rs が確かめる）
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actingPlayer, applyAction, createGame, legalActions, selectNets, type Action, type GameState } from "../src/engine";
import { callEngine, currentNets, netsChecksum, netsChecksumOfJson } from "../src/engine/wasm";

// エンジンを使う前に選ぶ（このファイルの WASM はアズヴォルト環境の補正を入れる）
selectNets("azvaldt");

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

interface Row {
  problem?: string;
  decks?: [string[], string[]];
  gameSeed?: number;
  seed: number;
  actions: Action[];
}

/** 1 つの AI で、局面の手番の側のターンの終わりまで打つ（rust/engine/tests/browser_r3.rs と同じ。マリガンは 1 回だけ） */
function play(start: GameState, seed: number): Action[] {
  const handle = callEngine({ f: "agentNew", name: "search" }) as number;
  try {
    let s = start;
    const player = actingPlayer(s);
    const mulligan = s.phase === "mulligan";
    const out: Action[] = [];
    for (let k = 0; k < 60; k++) {
      if (s.phase === "ended" || actingPlayer(s) !== player) break;
      const legal = legalActions(s);
      if (legal.length === 0) break;
      const r = callEngine({ f: "agentChoose", handle, state: s, legal, rng: (seed + k) >>> 0 }) as { action: Action };
      s = applyAction(s, r.action);
      out.push(r.action);
      if (mulligan || r.action.type === "endTurn" || (s.phase !== "ended" && s.active !== player)) break;
    }
    return out;
  } finally {
    callEngine({ f: "agentFree", handle });
  }
}

describe("補正のファイル（アズヴォルト環境）", () => {
  it("WASM に入れた補正と見込みが、R3 の JSON（data/pools/azvaldt/・コマンドの yardstick/pool-r3-*）を serde_json で読んだものと同じ", () => {
    expect(currentNets()).toBe("azvaldt");
    const loaded = netsChecksum();
    expect(loaded).toBe(netsChecksumOfJson(read("data/pools/azvaldt/value-net.json"), read("data/pools/azvaldt/potential-net.json")));
    expect(loaded).toBe(netsChecksumOfJson(read("rust/engine/yardstick/pool-r3-net.json"), read("rust/engine/yardstick/pool-r3-potential.json")));
  });

  const rows = JSON.parse(read("tests/fixtures/browser-r3.json")) as Row[];
  it.each(rows.map((r, i) => [r.problem ?? `マリガン ${i}`, r] as const))("%s から、コマンドの R3 と同じ手を打つ", (_name, row) => {
    const start: GameState = row.problem
      ? ((JSON.parse(read(row.problem)) as { state: GameState }).state)
      : createGame({ decks: row.decks!, seed: row.gameSeed! });
    expect(play(start, row.seed)).toEqual(row.actions);
  }, 120_000);
});
