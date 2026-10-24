// 1 回分の出力を .tar.gz にまとめる（scripts/pack-run-main.ts、npm run pack-run）。展開はシステムの tar で確かめる

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkName, classify, destination, globToRegExp, main, paxRecord, planParts } from "../scripts/pack-run-main";

describe("まとめ方（scripts/pack-run-main.ts）", () => {
  it("自己対戦・モデル・それ以外を、ファイル名と先頭で分ける", () => {
    expect(classify("f0.jsonl", '{"g":1,"decks":["a","b"],"winner":0,"turns":3,"samples":[[]]}\n{"g":2}')).toBe("selfplay");
    expect(classify("f0.jsonl.gz", '{"g":1,"samples":[]}\n')).toBe("selfplay");
    expect(classify("rc-base.jsonl", '{"g":0,"seat":0,"won":true}\n{"samples":1}')).toBe("logs");
    expect(classify("rfp.json", '{"kind":"td-value-net","version":1,"vocab":[]}')).toBe("models");
    expect(classify("sim.json", '{"games":[]}')).toBe("logs");
    expect(classify("f0.log", '"samples": 1')).toBe("logs");
  });

  it(".jsonl は gzip して入れ、もう .gz のものはそのまま入れる", () => {
    expect(destination("selfplay", "r9", "f0.jsonl")).toEqual({ path: "data/selfplay/r9/f0.jsonl.gz", gzip: true });
    expect(destination("selfplay", "r9", "f0.jsonl.gz")).toEqual({ path: "data/selfplay/r9/f0.jsonl.gz", gzip: false });
    expect(destination("models", "r9", "rfp.json")).toEqual({ path: "data/models/r9/rfp.json", gzip: false });
    expect(destination("logs", "r9", "rc.jsonl")).toEqual({ path: "logs/r9/rc.jsonl.gz", gzip: true });
    expect(destination("logs", "r9", "rf.log")).toEqual({ path: "logs/r9/rf.log", gzip: false });
  });

  it("上限まで順に詰め、1 つで上限を超えるファイルはそれだけで 1 個にする", () => {
    // 100 バイトのファイルは tar で 1024 バイト（見出し 512 + 中身 512）
    expect(planParts([100, 100, 100], 0)).toEqual([0, 0, 0]);
    expect(planParts([100, 100, 100], 2048)).toEqual([0, 0, 1]);
    expect(planParts([100, 5000, 100], 2048)).toEqual([0, 1, 2]);
    expect(planParts([5000, 100], 2048)).toEqual([0, 1]);
  });

  it("PAX の行の長さは、長さの桁を含めた行全体のバイト数", () => {
    for (let n = 80; n <= 1010; n++) {
      const rec = paxRecord("path", "あ".repeat(n % 7) + "x".repeat(n));
      expect(Number(rec.toString("utf8").split(" ")[0])).toBe(rec.length);
    }
  });

  it("ワイルドカードは * と ? だけ（. はそのまま）", () => {
    const f = globToRegExp("f*");
    expect(f.test("f0.jsonl")).toBe(true);
    expect(f.test("rf.log")).toBe(false);
    expect(globToRegExp("r?.log").test("r0.log")).toBe(true);
    expect(globToRegExp("r?.log").test("r10.log")).toBe(false);
    expect(globToRegExp("a.log").test("aXlog")).toBe(false);
  });

  it("名前は区切りや空白を含まない", () => {
    expect(() => checkName("royal-9")).not.toThrow();
    expect(() => checkName("ロイヤル対策9回目")).not.toThrow();
    for (const bad of ["", "../x", "a/b", "a b", ".x", "a:b"]) expect(() => checkName(bad)).toThrow();
  });
});

describe("npm run pack-run", () => {
  let root = "";
  let src = "";
  let out = "";
  const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
  const selfplay = Array.from({ length: 50 }, (_, g) => JSON.stringify({ g, decks: ["a", "b"], winner: g % 2, turns: 10, samples: [[{ x: [g], v: [1] }]] })).join("\n") + "\n";
  const model = JSON.stringify({ kind: "td-value-net", version: 1, vocab: ["1"], w: Array.from({ length: 2000 }, (_, i) => i % 13) });
  const longName = `${"長い名前のログ".repeat(8)}.txt`; // UTF-8 で 100 バイトを超える

  const extract = (archive: string): string => {
    const dir = mkdtempSync(join(root, "x-"));
    execFileSync("tar", ["-xzf", archive, "-C", dir]);
    return dir;
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    root = mkdtempSync(join(tmpdir(), "pack-run-test-"));
    src = join(root, "td-royal");
    out = join(root, "out");
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "f0.jsonl"), selfplay);
    writeFileSync(join(src, "f1.jsonl.gz"), gzipSync(selfplay));
    writeFileSync(join(src, "f0.log"), "100/2000 試合 0.60s/試合\n");
    writeFileSync(join(src, "f0.done"), "");
    writeFileSync(join(src, "rf-train.log.tmp"), "書きかけ");
    writeFileSync(join(src, "rfp.json"), model);
    writeFileSync(join(src, "rc-base.jsonl"), '{"g":0,"seat":0,"won":true}\n');
    writeFileSync(join(src, "rf.sh"), "#!/bin/bash\necho DONE\n");
    writeFileSync(join(src, longName), "長い\n");
    writeFileSync(join(src, "sub", "x.log"), "サブフォルダ\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("共有フォルダと同じ形の 1 つの .tar.gz にまとめ、展開すると元と同じ中身になる", async () => {
    expect(await main([src, "--name", "royal-9", "--note", "ロイヤル対策 9 回目", "--out", out])).toBe(0);
    expect(readdirSync(out)).toEqual(["royal-9.tar.gz"]); // 一時ファイルは残らない
    const x = extract(join(out, "royal-9.tar.gz"));
    expect(gunzipSync(readFileSync(join(x, "data/selfplay/royal-9/f0.jsonl.gz"))).toString("utf8")).toBe(selfplay);
    expect(gunzipSync(readFileSync(join(x, "data/selfplay/royal-9/f1.jsonl.gz"))).toString("utf8")).toBe(selfplay);
    expect(readFileSync(join(x, "data/models/royal-9/rfp.json"), "utf8")).toBe(model);
    expect(gunzipSync(readFileSync(join(x, "logs/royal-9/rc-base.jsonl.gz"))).toString("utf8")).toBe('{"g":0,"seat":0,"won":true}\n');
    expect(readFileSync(join(x, "logs/royal-9/f0.log"), "utf8")).toBe("100/2000 試合 0.60s/試合\n");
    expect(readFileSync(join(x, "logs/royal-9/rf.sh"), "utf8")).toBe("#!/bin/bash\necho DONE\n");
    expect(readFileSync(join(x, "logs/royal-9", longName), "utf8")).toBe("長い\n");
    expect(existsSync(join(x, "logs/royal-9/f0.done"))).toBe(false);
    expect(existsSync(join(x, "logs/royal-9/rf-train.log.tmp"))).toBe(false);
    expect(existsSync(join(x, "logs/royal-9/x.log"))).toBe(false);

    const m = readFileSync(join(x, "logs/royal-9/MANIFEST.md"), "utf8");
    expect(m).toContain("# royal-9");
    expect(m).toContain("ロイヤル対策 9 回目");
    expect(m).toContain(`| f0.jsonl | 自己対戦 | data/selfplay/royal-9/f0.jsonl.gz | ${(selfplay.length / 1024).toFixed(1)} KB | 50 |`);
    expect(m).toContain(sha(Buffer.from(model))); // 元のファイルの sha256
    expect(m).toContain(sha(Buffer.from(selfplay)));
    expect(m).toContain("- f0.done: 終わった印（.done）");
    expect(m).toContain("- rf-train.log.tmp: 書きかけ（.tmp）");
    expect(m).toContain("- sub/: フォルダ（中は入れない）");
  });

  it("--max-mb で、それぞれ単独で展開できるいくつかのアーカイブに分ける", async () => {
    // 先頭は自己対戦の行、残りは gzip しても縮まない 300 KB
    writeFileSync(join(src, "f2.jsonl"), Buffer.concat([Buffer.from('{"g":0,"samples":[]}\n'), randomBytes(300_000)]));
    expect(await main([src, "--name", "r", "--out", out, "--max-mb", "0.2"])).toBe(0);
    const parts = readdirSync(out).sort();
    expect(parts.length).toBeGreaterThan(1);
    expect(parts).toEqual(parts.map((_, i) => `r-${i + 1}of${parts.length}.tar.gz`));
    const all = new Set<string>();
    let manifest: string | null = null;
    for (const p of parts) {
      const list = execFileSync("tar", ["-tzf", join(out, p)], { encoding: "utf8" }).trim().split("\n");
      expect(list[0]).toBe("logs/r/MANIFEST.md");
      const m = readFileSync(join(extract(join(out, p)), "logs/r/MANIFEST.md"), "utf8");
      if (manifest !== null) expect(m).toBe(manifest); // どのアーカイブにも同じ一覧
      manifest = m;
      for (const f of list.slice(1)) {
        expect(all.has(f)).toBe(false);
        all.add(f);
      }
    }
    expect(all).toContain("data/selfplay/r/f2.jsonl.gz");
    expect(all).toContain("data/models/r/rfp.json");
    expect(all.size).toBe(8);
  });

  it("同じ名前のまとめがあれば作らない（--force で作り直す）", async () => {
    expect(await main([src, "--name", "r", "--out", out, "--max-mb", "0.0001"])).toBe(0);
    expect(readdirSync(out).length).toBeGreaterThan(1);
    expect(await main([src, "--name", "r", "--out", out])).toBe(1);
    expect(await main([src, "--name", "r", "--out", out, "--force"])).toBe(0);
    expect(readdirSync(out)).toEqual(["r.tar.gz"]); // 前に分けたものは消える
  });

  it("--only・--include・--exclude で入れるファイルを絞る", async () => {
    expect(await main([src, "--name", "a", "--out", out, "--only", "models,logs", "--exclude", "rc*"])).toBe(0);
    const a = execFileSync("tar", ["-tzf", join(out, "a.tar.gz")], { encoding: "utf8" });
    expect(a).toContain("data/models/a/rfp.json");
    expect(a).not.toContain("data/selfplay/");
    expect(a).not.toContain("rc-base");
    expect(await main([src, "--name", "b", "--out", out, "--include", "f*"])).toBe(0);
    const b = execFileSync("tar", ["-tzf", join(out, "b.tar.gz")], { encoding: "utf8" }).trim().split("\n").sort();
    expect(b).toEqual(["data/selfplay/b/f0.jsonl.gz", "data/selfplay/b/f1.jsonl.gz", "logs/b/MANIFEST.md", "logs/b/f0.log"]);
  });

  it("間違った引数・名前・フォルダはエラーにする", async () => {
    expect(await main([src, "--name", "../x", "--out", out])).toBe(2);
    expect(await main([src, "--bogus"])).toBe(2);
    expect(await main([src, "--only", "nope"])).toBe(2);
    expect(await main([join(root, "nothing"), "--out", out])).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
});
