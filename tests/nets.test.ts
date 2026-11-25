// ページが読み込む探索 AI の補正と見込み（scripts/pack-nets.ts が詰め、WASM が戻す。rust/engine/src/ai/netpack.rs）が、
// JSON を CLI と同じく serde_json で読んだ値とビットまで同じか。スターターのページの分（Node の既定もこれ）
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { currentNets } from "../src/engine";
import { netsChecksum, netsChecksumOfJson, searchOptions } from "../src/engine/wasm";
import { decode, split } from "../scripts/pack-nets";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("補正のファイル（スターター）", () => {
  it("WASM に入れた補正と見込みが、JSON を serde_json で読んだものと同じ", () => {
    expect(currentNets()).toBe("starter");
    const loaded = netsChecksum();
    expect(loaded).toMatch(/^[0-9a-f]{8}$/);
    expect(loaded).toBe(netsChecksumOfJson(read("data/value-net.json"), read("data/potential-net.json")));
  });

  it("スターターのページの探索 AI は既定の設定のまま（設定を入れない）", () => {
    expect(searchOptions()).toBeNull();
  });

  it("違う補正ならハッシュも違う（ハッシュが中身を見ている）", () => {
    const value = JSON.parse(read("data/value-net.json")) as { w1: number[] };
    value.w1[12345] = (value.w1[12345] ?? 0) + 1e-6;
    expect(netsChecksumOfJson(JSON.stringify(value), read("data/potential-net.json"))).not.toBe(netsChecksum());
  });

  it("数を仮数と指数に分けて戻すと同じ値（-0・整数・とても小さい数・大きい数も）", () => {
    for (const x of [0, -0, 1, -3, 0.5, -0.358538, 0.0491367, 5.90251, -6.027962e-81, -7.509367e-123, 5e-324, 1.5e308, 123456789, 1e22, 1e23]) {
      const [m, e] = split(x);
      expect(Object.is(decode(m, e), x)).toBe(true);
    }
    // 仮数が 32 ビットに入らない数は詰めない（補正の数は有効数字 6〜7 桁）
    expect(() => split(0.1 + 0.2)).toThrow();
  });
});
