// 補正・見込みのモデルの語彙を新しいプールに広げる（scripts/vocab.ts、npm run td -- extend --vocab・vocab・attr）

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentOf } from "../src/ai/registry";
import type { Agent } from "../src/ai/types";
import type { GameState } from "../src/engine";
import { playMatch } from "../src/sim/match";
import { main as td } from "../scripts/td-main";
import { deckFileCards, reachableVocab, vocabRange, widenVocab } from "../scripts/vocab";
import { defaultVocab, loadValueNet, VALUE_SCALARS, VALUE_ZONES } from "../scripts/valueNet";

const REP10 = "data/pools/azvaldt/sets/rep10.txt";

const setDecks = (path: string): string[][] =>
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((f) => {
      // デッキのファイルは「枚数 カード名」。deckFileCards は種類ごとに 1 つなので、枚数分に戻す
      const ids = deckFileCards(readFileSync(f, "utf8"), f);
      const counts = readFileSync(f, "utf8")
        .split(/\r?\n/)
        .map((l) => /^(\d+)\s+/.exec(l.trim()))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]));
      return ids.flatMap((id, i) => Array.from({ length: counts[i]! }, () => id));
    });

describe("語彙の範囲（scripts/vocab.ts）", () => {
  it("starter は今の語彙、pool はその全部を含む。広げても今の語彙の並びは変わらない", () => {
    const starter = vocabRange("starter")!;
    expect(starter).toEqual(defaultVocab());
    const pool = vocabRange("pool")!;
    expect(new Set(pool).size).toBe(pool.length);
    for (const id of starter) expect(pool).toContain(id);
    const wide = widenVocab(starter, pool);
    expect(wide.slice(0, starter.length)).toEqual(starter);
    expect(new Set(wide).size).toBe(pool.length);
    expect(vocabRange("keep")).toBeNull();
  });

  it("デッキの組の範囲は、その組のデッキどうしのランダムな試合に出たカード・クレストを全部含む", () => {
    const vocab = new Set(vocabRange(`@${REP10}`)!);
    const decks = setDecks(REP10);
    expect(decks).toHaveLength(10);
    for (const d of decks) expect(d).toHaveLength(40);
    const seen = new Set<string>();
    const look = (s: GameState): void => {
      for (const p of s.players) {
        for (const c of p.hand) seen.add(c.cardId);
        for (const c of p.board) seen.add(c.cardId);
        for (const c of p.crests) seen.add(`crest:${c.crestId}`);
      }
    };
    const random = agentOf("random");
    const watcher: Agent = {
      name: "watch",
      chooseAction: (s, legal, rng) => {
        look(s);
        return random.chooseAction(s, legal, rng);
      },
    };
    for (let seed = 1; seed <= 40; seed++) {
      const pair: [string[], string[]] = [decks[seed % 10]!, decks[(seed * 3 + 1) % 10]!];
      look(playMatch([watcher, watcher], { decks: pair, seed }).final);
    }
    const missing = [...seen].filter((id) => !vocab.has(id));
    expect(missing).toEqual([]);
  }, 60_000);

  it("名指しをたどる: アクセラレート・結晶の姿と、カードが出すトークンも入る", () => {
    const v = reachableVocab(setDecks(REP10).flat());
    expect(v.length).toBeGreaterThan(new Set(setDecks(REP10).flat()).size);
  });
});

describe("td extend --vocab・attr", () => {
  it("補正のモデル: 足したカードの行は 0 で、今のカードの行と数値の入力はそのまま。attr で 0 の行を属性の分で埋める", async () => {
    const dir = mkdtempSync(join(tmpdir(), "svwb-vocab-"));
    try {
      const vocab = defaultVocab();
      const V0 = vocab.length, Z = VALUE_ZONES.length, S = VALUE_SCALARS.length, H = 2;
      // 小さなモデル（語彙は今のもの、行ごとに決まった値）
      const w1 = Array.from({ length: (Z * V0 + S) * H }, (_, i) => ((i % 7) + 1) / 10);
      const model = { kind: "td-value-net", version: 1, vocab, zones: [...VALUE_ZONES], scalars: [...VALUE_SCALARS], hidden: H, w1, b1: [0, 0], w2: [1, -1], b2: 0, a: 0.08, c: 0, baseWeights: {} };
      const m0 = join(dir, "m0.json"), m1 = join(dir, "m1.json"), m2 = join(dir, "m2.json");
      writeFileSync(m0, JSON.stringify(model));
      expect(await td(["extend", "--model", m0, "--vocab", `@${REP10}`, "--out", m1])).toBe(0);
      const wide = loadValueNet(m1);
      const V = wide.vocab.length;
      expect(V).toBeGreaterThan(V0);
      expect(wide.vocab.slice(0, V0)).toEqual(vocab);
      const row = (m: { w1: number[] }, r: number) => m.w1.slice(r * H, r * H + H);
      for (let z = 0; z < Z; z++) {
        expect(row(wide, z * V + 5)).toEqual(row(model, z * V0 + 5));
        expect(row(wide, z * V + V0)).toEqual([0, 0]);
      }
      expect(wide.w1.slice(Z * V * H)).toEqual(model.w1.slice(Z * V0 * H));
      expect(await td(["attr", "--model", m1, "--out", m2, "--keepA", "0"])).toBe(0);
      const filled = loadValueNet(m2);
      // 足したカードの手札の行が属性の分になる（0 でない）
      const myHand = VALUE_ZONES.indexOf("myHand");
      expect(row(filled, myHand * V + V0).some((x) => x !== 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("見込みのモデルも語彙を広げ、attr で埋める", async () => {
    const dir = mkdtempSync(join(tmpdir(), "svwb-vocab-"));
    try {
      const src = JSON.parse(readFileSync("data/potential-net.json", "utf8")) as { vocab: string[]; zones: string[]; scalars: string[]; hidden: number; w1: number[] };
      const p1 = join(dir, "p1.json"), p2 = join(dir, "p2.json");
      expect(await td(["extend", "--model", "data/potential-net.json", "--vocab", `@${REP10}`, "--out", p1])).toBe(0);
      const wide = JSON.parse(readFileSync(p1, "utf8")) as typeof src;
      const V0 = src.vocab.length, V = wide.vocab.length, H = src.hidden, Z = src.zones.length;
      expect(wide.vocab.slice(0, V0)).toEqual(src.vocab);
      expect(wide.w1).toHaveLength((Z * V + src.scalars.length) * H);
      expect(wide.w1.slice(0, V0 * H)).toEqual(src.w1.slice(0, V0 * H));
      expect(wide.w1.slice(V0 * H, V * H).every((x) => x === 0)).toBe(true);
      expect(wide.w1.slice(Z * V * H)).toEqual(src.w1.slice(Z * V0 * H));
      expect(await td(["attr", "--model", p1, "--out", p2])).toBe(0);
      const filled = JSON.parse(readFileSync(p2, "utf8")) as typeof src;
      expect(filled.w1.slice(V0 * H, V0 * H + H).some((x) => x !== 0)).toBe(true);
      // 学んだ行はそのまま
      expect(filled.w1.slice(0, V0 * H)).toEqual(src.w1.slice(0, V0 * H));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
