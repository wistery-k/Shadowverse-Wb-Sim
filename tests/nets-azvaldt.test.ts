// アズヴォルト環境のページの AI（WASM の探索 AI に、ページが読み込んだ補正と見込み（今は R6。2026-11-21 に R3 から R4 に、2026-11-22 に R5 に、2026-11-23 に R6 に替えた。R5・R6 の見込みは R4 のまま）と、
// 探索 AI の設定（data/pools/azvaldt/search-options.json。2026-11-25 から。読みの中の相手を補正で打たせ、想像の局面の印を切る）を入れたもの）が、
// コマンドの同じ補正・同じ設定（compare・misses の --opts の valueNet・potentialNet と、残りの項目。rust/engine/yardstick/<PAGE_NET>-net.json・<PAGE_POTENTIAL>-potential.json）と同じ値の補正を持ち、決まった局面から同じ手を打つか。
// 局面と手は tests/fixtures/browser-azvaldt.json（コマンドの側の手を rust/engine/tests/browser_azvaldt.rs が確かめる）
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actingPlayer, applyAction, createGame, legalActions, selectNets, type Action, type GameState } from "../src/engine";
import { callEngine, currentNets, netsChecksum, netsChecksumOfJson, searchOptions } from "../src/engine/wasm";
import { packNets } from "../scripts/pack-nets";

// エンジンを使う前に選ぶ（このファイルの WASM はアズヴォルト環境の補正を入れる）
selectNets("azvaldt");

/** ページの補正と見込みの凍結した写し（rust/engine/yardstick/<PAGE_NET>-net.json・<PAGE_POTENTIAL>-potential.json。rust/engine/tests/browser_azvaldt.rs と同じ） */
const PAGE_NET = "pool-r6";
const PAGE_POTENTIAL = "pool-r4";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

interface Row {
  problem?: string;
  decks?: [string[], string[]];
  gameSeed?: number;
  seed: number;
  actions: Action[];
}

/** 1 つの AI で、局面の手番の側のターンの終わりまで打つ（rust/engine/tests/browser_azvaldt.rs と同じ。マリガンは 1 回だけ） */
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
  it("WASM に入れた補正と見込みが、ページの JSON（data/pools/azvaldt/・コマンドの yardstick/ の写し）を serde_json で読んだものと同じ", () => {
    expect(currentNets()).toBe("azvaldt");
    const loaded = netsChecksum();
    expect(loaded).toBe(netsChecksumOfJson(read("data/pools/azvaldt/value-net.json"), read("data/pools/azvaldt/potential-net.json")));
    expect(loaded).toBe(netsChecksumOfJson(read(`rust/engine/yardstick/${PAGE_NET}-net.json`), read(`rust/engine/yardstick/${PAGE_POTENTIAL}-potential.json`)));
  });

  it("WASM に入れた探索 AI の設定が data/pools/azvaldt/search-options.json と同じ（rust/engine/tests/browser_azvaldt.rs のコマンドの側も同じファイルを読む）", () => {
    expect(searchOptions()).toEqual(JSON.parse(read("data/pools/azvaldt/search-options.json")));
  });

  it("リーサルの出力と勝つ確率の形もハッシュに入る（R5・R6 は winForm が survival。ヘッダの JSON に残る値も確かめる）", () => {
    const valueText = read("data/pools/azvaldt/value-net.json");
    const potentialText = read("data/pools/azvaldt/potential-net.json");
    const value = JSON.parse(valueText) as { lethalHead?: { w: number[]; b: number }; winForm?: string };
    expect(value.winForm).toBe("survival");
    const base = netsChecksumOfJson(valueText, potentialText);
    const head = structuredClone(value);
    head.lethalHead!.w[3] = (head.lethalHead!.w[3] ?? 0) + 1e-6;
    expect(netsChecksumOfJson(JSON.stringify(head), potentialText)).not.toBe(base);
    const bias = structuredClone(value);
    bias.lethalHead!.b += 1e-6;
    expect(netsChecksumOfJson(JSON.stringify(bias), potentialText)).not.toBe(base);
    const logit = structuredClone(value);
    logit.winForm = "logit";
    expect(netsChecksumOfJson(JSON.stringify(logit), potentialText)).not.toBe(base);
  });

  it("勝ちの出力（winHead）と winForm survivalWin もハッシュに入り、読みの出力（readHead）は入らず、ページにも詰めない", () => {
    const valueText = read("data/pools/azvaldt/value-net.json");
    const potentialText = read("data/pools/azvaldt/potential-net.json");
    type Head = { w: number[]; b: number };
    const value = JSON.parse(valueText) as { lethalHead: Head; winHead?: Head; readHead?: Head; winForm?: string };
    const base = netsChecksumOfJson(valueText, potentialText);
    const n = value.lethalHead.w.length;
    const win = { ...structuredClone(value), winHead: { w: new Array<number>(n).fill(0), b: -1 }, winForm: "survivalWin" };
    const winSum = netsChecksumOfJson(JSON.stringify(win), potentialText);
    expect(winSum).not.toBe(base);
    const moved = structuredClone(win);
    moved.winHead.w[3] = 1e-6;
    expect(netsChecksumOfJson(JSON.stringify(moved), potentialText)).not.toBe(winSum);
    const aux = { ...structuredClone(win), winForm: "survival" };
    expect(netsChecksumOfJson(JSON.stringify(aux), potentialText)).not.toBe(winSum);
    const withRead = { ...structuredClone(win), readHead: { w: new Array<number>(n).fill(0.5), b: 2 } };
    expect(netsChecksumOfJson(JSON.stringify(withRead), potentialText)).toBe(winSum);
    // 詰めたファイルのヘッダの JSON: 勝ちの出力は残り、読みの出力は無い
    type PackJson = Parameters<typeof packNets>[0];
    const packed = packNets(JSON.parse(JSON.stringify(withRead)) as PackJson, JSON.parse(potentialText) as PackJson);
    const len = new DataView(packed.buffer, packed.byteOffset).getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(packed.subarray(12, 12 + len))) as { value: Record<string, unknown> };
    expect(header.value["winHead"]).toEqual(win.winHead);
    expect(header.value["winForm"]).toBe("survivalWin");
    expect("readHead" in header.value).toBe(false);
  });

  const rows = JSON.parse(read("tests/fixtures/browser-azvaldt.json")) as Row[];
  it.each(rows.map((r, i) => [r.problem ?? `マリガン ${i}`, r] as const))("%s から、コマンドの同じ補正と同じ手を打つ", (_name, row) => {
    const start: GameState = row.problem
      ? ((JSON.parse(read(row.problem)) as { state: GameState }).state)
      : createGame({ decks: row.decks!, seed: row.gameSeed! });
    expect(play(start, row.seed)).toEqual(row.actions);
  }, 120_000);
});
