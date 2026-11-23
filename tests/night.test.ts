// 夜のキュー（scripts/night-main.ts・docs/night.md）。svwb の代わりに、台帳の行だけを書く偽物を回して、区切り・再開・止め方・まとめを確かめる

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLedger, type MissesRow, type RunRow, type SurveyRow } from "../scripts/ledger-main";
import { outboxPathAllowed } from "../scripts/night-outbox";
import { packItems, type PackItem } from "../scripts/pack-run-main";
import {
  checkArgv,
  checkRunRefs,
  chunkJob,
  combineRows,
  estimate,
  expandBraces,
  gzipKifu,
  httpsRemote,
  isDaytime,
  jobInputs,
  jobRunRefs,
  kifuDir,
  kifuSnapshot,
  jobProducts,
  main,
  makeTicket,
  parseJob,
  parseJobs,
  parseTicket,
  parseUntil,
  portablePath,
  portableRow,
  prepareNodeModules,
  readStatus,
  runWorker,
  shellLine,
  shellWords,
  standIn,
  jobArgv,
  ticketHere,
  ticketPlan,
  ticketText,
  wallClock,
  workerPid,
  type WorkerControl,
} from "../scripts/night-main";

describe("ジョブの行", () => {
  it("シェルと同じ形で語に分け、台帳の cmd と同じ形に戻す", () => {
    expect(shellWords(`compare 100 '{"beamWidth":128}' "{}" 0 --label 'a b' # 書き添え`)).toEqual([
      "compare",
      "100",
      '{"beamWidth":128}',
      "{}",
      "0",
      "--label",
      "a b",
    ]);
    // rust/engine/src/runner/ledger.rs の shell_line のテストと同じ
    expect(shellLine(["yardstick", "--opts", "{}", "--label", "it's"])).toBe(`yardstick --opts '{}' --label 'it'\\''s'`);
    expect(shellWords(shellLine(["x", "it's", "定例", ""]))).toEqual(["x", "it's", "定例", ""]);
  });

  it("compare・yardstick・profile・misses を読み、キューで使えない引数は断る", () => {
    const c = parseJob(`compare 3000 '{"beamWidth":128}' '{}' 100000 リノセウスエルフ --no-mirror --label 幅 --est 0.1`, 1);
    expect(c).toMatchObject({ label: "幅", games: 3000, start: 100000, est: 0.1 });
    expect(c.spec).toEqual({ kind: "compare", a: '{"beamWidth":128}', b: "{}", vs: "リノセウスエルフ", noMirror: true, decks: null, with: null, without: null });
    const y = parseJob("svwb yardstick --ref strong --games 4000 --label 強", 2);
    expect(y).toMatchObject({ games: 4000, start: 0, spec: { kind: "yardstick", ref: "strong", opts: "{}" } });
    expect(parseJob("profile", 3)).toMatchObject({ games: 49, label: "", spec: { kind: "profile", rhino: false, decks: null } });
    const pd = parseJob(`profile --opts '{"valueNet":"@/r.json"}' --games 84 --decks @data/pools/azvaldt/sets/all84.txt`, 3);
    expect(pd.spec).toEqual({ kind: "profile", opts: '{"valueNet":"@/r.json"}', rhino: false, decks: "@data/pools/azvaldt/sets/all84.txt" });
    expect(jobArgv(pd, 0, 84, "/r")).toEqual([
      "profile",
      "--opts",
      '{"valueNet":"/r/r.json"}',
      "--games",
      "84",
      "--start",
      "0",
      "--decks",
      "@data/pools/azvaldt/sets/all84.txt",
      "--json",
      "/r/speed-3.json",
      "--report",
      "/r/speed-3.md",
    ]);
    expect(parseJob("misses run --trials 12 --seed 3 --label 定例", 4)).toMatchObject({ games: 12, start: 0, label: "定例", spec: { kind: "misses", opts: "{}", seed: 3 } });
    expect(parseJob(`misses --opts '{"beamWidth":512}' --label x`, 4)).toMatchObject({ games: 24, spec: { kind: "misses", opts: '{"beamWidth":512}', seed: 1 } });
    expect(() => parseJob("misses --trials 12", 1)).toThrow(/--label/);
    expect(() => parseJob("misses --label x --only a", 1)).toThrow(/--only/);
    expect(() => parseJob("misses --label x --no-ledger", 1)).toThrow(/--no-ledger/);
    expect(() => parseJob("compare 100 '{}' '{}'", 1)).toThrow(/--label/);
    expect(() => parseJob("compare 100 '{}' '{}' --label x --no-ledger", 1)).toThrow(/--no-ledger/);
    // 棋譜はキューが回のフォルダの kifu/ に書く
    expect(() => parseJob("compare 100 '{}' '{}' --label x --kifu a.jsonl", 1)).toThrow(/kifu/);
    expect(() => parseJob("compare 100 '{}' '{}' --label x --replays a.jsonl", 1)).toThrow(/kifu/);
    expect(() => parseJob("compare 100 '{}' '{}' --label x --no-kifu", 1)).toThrow(/kifu/);
    expect(() => parseJob("td selfplay --model m.json --games 10 --chunk 5 --out @/s-{k}.jsonl --est 1 --kifu k.jsonl", 1)).toThrow(/kifu/);
    expect(() => parseJob("yardstick --label x --record", 1)).toThrow(/--record/);
    expect(() => parseJob("compare 100 '{beam}' '{}' --label x", 1)).toThrow(/JSON/);
    const s = parseJob("svwb survey run --games 1000-1799 --label 調査 --confirm 64", 5);
    expect(s).toMatchObject({ label: "調査", games: 800, start: 1000, spec: { kind: "survey", rate: 0.1, m: 32, extra: 4, confirm: 64, flag: 10, batch: 8 } });
    expect(parseJob("survey --games 40 --start 7 --rate 0.2 --label x", 5)).toMatchObject({ games: 40, start: 7, spec: { rate: 0.2 } });
    expect(jobArgv(s, 1200, 50, "/r")).toEqual(
      ["survey", "run", "--out", "/r/survey-5.jsonl", "--games", "1200-1249", "--rate", "0.1", "--m", "32", "--extra", "4", "--confirm", "64", "--flag", "10", "--batch", "8"],
    );
    expect(() => parseJob("survey --games 0-9", 1)).toThrow(/--label/);
    expect(() => parseJob("survey --label x", 1)).toThrow(/--games/);
    expect(() => parseJob("survey --games 0-9 --label x --out a.jsonl", 1)).toThrow(/--out/);
    expect(() => parseJob("survey --games 0-9 --label x --rate 2", 1)).toThrow(/--rate/);
    expect(() => parseJob("survey --games 0-9 --start 3 --label x", 1)).toThrow(/--start/);
    // 新しいプールの調査: AI の設定とデッキを svwb survey run に渡す（@/ は回のフォルダ）
    const sp = parseJob(`survey --games 0-9 --label p --opts '{"valueNet":"@/r.json"}' --decks @data/pools/azvaldt/sets/rep10.txt`, 4);
    expect(sp.spec).toMatchObject({ kind: "survey", opts: '{"valueNet":"@/r.json"}', decks: "@data/pools/azvaldt/sets/rep10.txt" });
    expect(jobArgv(sp, 0, 10, "/r").slice(-4)).toEqual(["--opts", '{"valueNet":"/r/r.json"}', "--decks", "@data/pools/azvaldt/sets/rep10.txt"]);
    expect(jobInputs(sp)).toEqual(["@/r.json"]);
    expect(checkArgv(sp, "/t")).toEqual(["compare", "0", '{"valueNet":"data/value-net.json"}', "{}", "0", "--decks", "@data/pools/azvaldt/sets/rep10.txt", "--no-ledger"]);
    expect(checkArgv(s, "/t")).toBeUndefined();
    // 新しいプールの物差し
    expect(parseJob("yardstick --ref pool-r3 --label p", 1).spec).toMatchObject({ kind: "yardstick", ref: "pool-r3" });
    expect(() => parseJob("yardstick --ref pool-r9 --label p", 1)).toThrow(/pool-v0/);
    expect(() => parseJob("rhino-compare --games 10", 1)).toThrow(/compare・yardstick・profile/);
    const w = parseJob("compare 100 '{}' '{}' 0 --with ミッドレンジナイトメア --label x", 6);
    expect(w.spec).toMatchObject({ kind: "compare", with: "ミッドレンジナイトメア" });
    expect(jobArgv(w, 0, 10, "/r")).toEqual(["compare", "10", "{}", "{}", "0", "--with", "ミッドレンジナイトメア", "--label", "x"]);
    const wo = parseJob("compare 100 '{}' '{}' 0 --without ミッドレンジナイトメア --label y", 7);
    expect(wo.spec).toMatchObject({ with: null, without: "ミッドレンジナイトメア" });
    expect(jobArgv(wo, 0, 10, "/r")).toEqual(["compare", "10", "{}", "{}", "0", "--without", "ミッドレンジナイトメア", "--label", "y"]);
    expect(() => parseJob("compare 100 '{}' '{}' 0 --with a --without b --label z", 8)).toThrow(/一緒に使えません/);
    expect(() => parseJobs("# だけ\n\n")).toThrow(/ジョブがありません/);
    expect(() => parseJobs("profile\nyardstick --ref weak --label x")).toThrow(/2 行目/);
  });

  it("学び直しの流れのジョブ（td selfplay・td branch・beam-gap・td・potential・pick）を読み、回のフォルダのファイルのつながりを確かめる", () => {
    expect(expandBraces("@/s-{1..3}.jsonl.gz,x.json")).toBe("@/s-1.jsonl.gz,@/s-2.jsonl.gz,@/s-3.jsonl.gz,x.json");
    expect(expandBraces('{"beamWidth":8}')).toBe('{"beamWidth":8}');
    const sp = parseJob("td selfplay --model @/net0.json --games 10 --start 100 --chunk 4 --eps 0.1 --out @/s-{k}.jsonl.gz --est 0.5", 2);
    expect(sp).toMatchObject({ games: 10, start: 100, est: 0.5, label: "" });
    expect(sp.spec).toEqual({ kind: "data", cmd: ["td", "selfplay"], startFlag: "--start", outFlag: "--out", out: "@/s-{k}.jsonl.gz", chunk: 4, args: ["--model", "@/net0.json", "--eps", "0.1"] });
    // 10 試合を 4 試合ずつ → 4・4・2 の 3 区切り。ファイルは区切りの番号で
    expect(chunkJob(sp, 0.5, 1).map((c) => [c.first, c.count])).toEqual([[100, 4], [104, 4], [108, 2]]);
    expect(jobProducts(sp)).toEqual(["@/s-1.jsonl.gz", "@/s-2.jsonl.gz", "@/s-3.jsonl.gz"]);
    expect(jobInputs(sp)).toEqual(["@/net0.json"]);
    expect(jobArgv(sp, 104, 4, "/r")).toEqual(["td", "selfplay", "--games", "4", "--start", "104", "--model", "/r/net0.json", "--eps", "0.1", "--out", "/r/s-2.jsonl.tmp"]);
    // td branch（選ばなかった候補の枝）も同じく区切る。前の回の棋譜のフォルダは @run: で読む
    const br = parseJob("td branch --model @run:r6-heads-1/v0.json --from @run:r6-heads-1/kifu --games 10 --start 100 --chunk 4 --out @/b-{k}.jsonl.gz --est 0.1", 2);
    expect(br.spec).toMatchObject({ kind: "data", cmd: ["td", "branch"], out: "@/b-{k}.jsonl.gz", chunk: 4 });
    expect(jobArgv(br, 104, 4, "/root/run")).toEqual(["td", "branch", "--games", "4", "--start", "104", "--model", "/root/r6-heads-1/v0.json", "--from", "/root/r6-heads-1/kifu", "--out", "/root/run/b-2.jsonl.tmp"]);
    const bg = parseJob(`beam-gap --games 4 --from 1000 --chunk 2 --ref '{"valueNet":"@/q.json"}' --inputs @/pot-{k}.jsonl --out @/pot-{k}-rows.jsonl --est 1`, 3);
    expect(jobInputs(bg)).toEqual(["@/q.json"]);
    expect(jobArgv(bg, 1002, 2, "/r")).toEqual(["beam-gap", "--games", "2", "--from", "1002", "--ref", '{"valueNet":"/r/q.json"}', "--out", "/r/pot-2-rows.jsonl", "--inputs", "/r/pot-2.jsonl.tmp"]);
    const tr = parseJob("td train --model @/net0.json --data @/s-{1..3}.jsonl.gz --out @/a.json --epochs 3 --est 600", 4);
    expect(tr).toMatchObject({ games: 1, est: 600, spec: { kind: "node", tool: "td", out: "@/a.json" } });
    expect(jobInputs(tr)).toEqual(["@/net0.json", "@/s-1.jsonl.gz", "@/s-2.jsonl.gz", "@/s-3.jsonl.gz"]);
    expect(jobArgv(tr, 0, 1, "/r")).toEqual(["td", "train", "--model", "/r/net0.json", "--data", "/r/s-1.jsonl.gz,/r/s-2.jsonl.gz,/r/s-3.jsonl.gz", "--out", "/r/a.json.tmp", "--epochs", "3"]);
    expect(chunkJob(tr, 600, 60)).toHaveLength(1);
    expect(tr.spec).toMatchObject({ impl: "rust" });
    expect(parseJob("td train --model a.json --out @/b.json --impl ts --est 1", 1).spec).toMatchObject({ impl: "ts" });
    expect(parseJob("td attr --model a.json --out @/b.json --est 1", 1).spec).toMatchObject({ impl: "ts" });
    expect(parseJob("potential train --out @/p.json --est 1", 1).spec).toMatchObject({ impl: "ts" });
    const trRust = parseJob("td prune --model @/a.json --data @/s-1.jsonl.gz --impl rust --out @/ap.json --est 60", 5);
    expect(trRust.spec).toMatchObject({ kind: "node", tool: "td", impl: "rust", out: "@/ap.json" });
    expect(jobArgv(trRust, 0, 1, "/r")).toEqual(["td", "prune", "--model", "/r/a.json", "--data", "/r/s-1.jsonl.gz", "--out", "/r/ap.json.tmp"]);
    expect(() => parseJob("td attr --model @/a.json --out @/b.json --impl rust --est 1", 1)).toThrow(/td train・td prune だけ/);
    expect(() => parseJob("potential train --out @/p.json --impl rust --est 1", 1)).toThrow(/td train・td prune だけ/);
    expect(() => parseJob("td train --model a.json --out @/b.json --impl wasm --est 1", 1)).toThrow(/ts か rust/);
    const pk = parseJob("pick --compare q1 --pass @/a.json --fail @/b.json --out @/q.json", 5);
    expect(pk.spec).toEqual({ kind: "pick", from: "q1", pass: "@/a.json", fail: "@/b.json", out: "@/q.json" });
    expect(() => parseJob("td selfplay --games 10 --chunk 4 --out @/s.jsonl --est 1", 1)).toThrow(/\{k\}/);
    expect(() => parseJob("td selfplay --games 10 --out @/s-{k}.jsonl --est 1", 1)).toThrow(/--chunk/);
    expect(() => parseJob("td selfplay --games 10 --chunk 4 --out @/s-{k}.jsonl", 1)).toThrow(/--est/);
    expect(() => parseJob("td train --model a.json --est 1", 1)).toThrow(/--out/);
    expect(() => parseJob("potential train --out @/p.json", 1)).toThrow(/--est/);
    expect(() => parseJob("pick --compare q1 --pass @/a.json --out @/q.json", 1)).toThrow(/--fail/);
    // 前のジョブが作らないファイルを読む・同じファイルを 2 つのジョブが作る・前に無い compare を選ぶ
    expect(() => parseJobs("td train --model @/net0.json --out @/a.json --est 1")).toThrow(/@\/net0.json を作るジョブが前にありません/);
    expect(() => parseJobs("td extend --model x.json --out @/a.json --est 1\ntd extend --model x.json --out @/a.json --est 1")).toThrow(/2 つあります/);
    expect(() => parseJobs("td extend --model x.json --out @/a.json --est 1\npick --compare q1 --pass @/a.json --fail @/a.json --out @/q.json")).toThrow(/q1 の compare/);
    expect(() => parseJobs(`compare 10 '{"valueNet":"@/a.json"}' '{}' --label q1`)).toThrow(/作るジョブが前にありません/);
    // 確かめる間は、回のフォルダのモデルを今の既定のモデルにする
    expect(standIn('{"valueNet":"@/a.json","beamWidth":8,"v":{"w":{"potentialNet":"@/p.json"}}}')).toBe(
      '{"valueNet":"data/value-net.json","beamWidth":8,"v":{"w":{"potentialNet":"data/potential-net.json"}}}',
    );
    expect(() => standIn('{"model":"@/a.json"}')).toThrow(/valueNet/);
    // 前の回のフォルダのファイル（@run:<回の名前>/<ファイル>）: 同じ根の下のその回のフォルダ。前のジョブが作らなくてよく、確かめる間は既定のモデル
    const ext = parseJobs("td extend --model @run:r6-heads-1/w.json --out @/h.json --est 10")[0]!;
    expect(jobInputs(ext)).toEqual([]);
    expect(jobRunRefs(ext)).toEqual(["@run:r6-heads-1/w.json"]);
    expect(jobArgv(ext, 0, 1, "/root/night/r6-heads-2")).toEqual(["td", "extend", "--model", "/root/night/r6-heads-1/w.json", "--out", "/root/night/r6-heads-2/h.json.tmp"]);
    expect(standIn('{"valueNet":"@run:r6-heads-1/w.json"}')).toBe('{"valueNet":"data/value-net.json"}');
    const cmp = parseJobs(`compare 10 '{"valueNet":"@run:r6-heads-1/w.json"}' '{}' --label q1`)[0]!;
    expect(jobRunRefs(cmp)).toEqual(["@run:r6-heads-1/w.json"]);
    expect(jobArgv(cmp, 0, 10, "/root/night/r6-heads-2")[2]).toBe('{"valueNet":"/root/night/r6-heads-1/w.json"}');
    for (const bad of ["@run:../x/w.json", "@run:a/../w.json", "@run:a b/w.json", "@run:r6-heads-1"]) {
      expect(() => parseJobs(`td extend --model '${bad}' --out @/h.json --est 10`)).toThrow(/@run:<回の名前>/);
    }
    const runRoot = mkdtempSync(join(tmpdir(), "night-runref-"));
    try {
      expect(() => checkRunRefs([ext], runRoot)).toThrow(/r6-heads-1\/w.json がありません/);
      mkdirSync(join(runRoot, "r6-heads-1"));
      writeFileSync(join(runRoot, "r6-heads-1", "w.json"), "{}");
      expect(() => checkRunRefs([ext], runRoot)).not.toThrow();
      // 学習のデータ（{a..b} を開き、ほかの回のデータとカンマで並べる）も、開いた 1 つずつを確かめる
      const tr = parseJobs(
        "td train --impl rust --model @run:r6-heads-1/w.json --data @run:r6-heads-1/s-{1..2}.jsonl.gz,@run:lethal-heads-1/s-{1..2}.jsonl.gz --out @/d.json --est 10",
      )[0]!;
      expect(jobRunRefs(tr)).toEqual([
        "@run:r6-heads-1/w.json",
        "@run:r6-heads-1/s-1.jsonl.gz",
        "@run:r6-heads-1/s-2.jsonl.gz",
        "@run:lethal-heads-1/s-1.jsonl.gz",
        "@run:lethal-heads-1/s-2.jsonl.gz",
      ]);
      expect(jobArgv(tr, 0, 1, "/root/night/r6-heads-2")).toContain(
        "/root/night/r6-heads-1/s-1.jsonl.gz,/root/night/r6-heads-1/s-2.jsonl.gz,/root/night/lethal-heads-1/s-1.jsonl.gz,/root/night/lethal-heads-1/s-2.jsonl.gz",
      );
      writeFileSync(join(runRoot, "r6-heads-1", "s-1.jsonl.gz"), "");
      writeFileSync(join(runRoot, "r6-heads-1", "s-2.jsonl.gz"), "");
      expect(() => checkRunRefs([tr], runRoot)).toThrow(/lethal-heads-1\/s-1.jsonl.gz がありません/);
      mkdirSync(join(runRoot, "lethal-heads-1"));
      writeFileSync(join(runRoot, "lethal-heads-1", "s-1.jsonl.gz"), "");
      writeFileSync(join(runRoot, "lethal-heads-1", "s-2.jsonl.gz"), "");
      expect(() => checkRunRefs([tr], runRoot)).not.toThrow();
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
    // 回す前の確かめ: 語彙を読むモデル（--vocab）も、--model と同じく今の既定のモデルにする。ほかの @/ は tmp の下の名前
    const bgv = parseJob(
      `beam-gap --games 40 --from 1000 --chunk 20 --decks @x.txt --vocab @/r.json --ref '{"valueNet":"@/r.json","potentialNet":null}' --sample 100 --inputs @/pot-{k}.jsonl --out @/pot-{k}-rows.jsonl --est 2`,
      5,
    );
    expect(checkArgv(bgv, "/t")).toEqual([
      "beam-gap",
      "--games",
      "0",
      "--from",
      "1000",
      "--decks",
      "@x.txt",
      "--vocab",
      "data/value-net.json",
      "--ref",
      '{"valueNet":"data/value-net.json","potentialNet":null}',
      "--sample",
      "100",
      "--out",
      "/t/pot-0-rows.jsonl",
      "--inputs",
      "/t/check-5.tmp",
    ]);
    expect(checkArgv(parseJob(`profile --opts '{"valueNet":"@/r.json"}' --decks @x.txt`, 2), "/t")).toEqual([
      "compare",
      "0",
      '{"valueNet":"data/value-net.json"}',
      "{}",
      "0",
      "--decks",
      "@x.txt",
      "--no-ledger",
    ]);
    const spp = parseJob("td selfplay --model @/v0.json --potential @/v0pot.json --games 10 --start 5 --chunk 5 --out @/s-{k}.jsonl.gz --est 1", 6);
    expect(checkArgv(spp, "/t")).toEqual([
      "td",
      "selfplay",
      "--games",
      "0",
      "--start",
      "5",
      "--model",
      "data/value-net.json",
      "--potential",
      "data/potential-net.json",
      "--out",
      "/t/check-6.tmp",
    ]);
    expect(jobInputs(spp)).toEqual(["@/v0.json", "@/v0pot.json"]);
    expect(checkArgv(parseJob("td extend --model x.json --out @/a.json --est 1", 1), "/t")).toBeUndefined();
  });

  it("区切りは大きさをそろえ、試合番号をすき間なく覆う", () => {
    const job = parseJob("compare 1000 '{}' '{}' 500 --label x", 1);
    // 1 試合 0.1 秒・1 区切り 60 秒なら 300 組まで → 4 区切りにして 250 組ずつ
    const cs = chunkJob(job, 0.1, 60);
    expect(cs.map((c) => [c.id, c.first, c.count])).toEqual([
      ["1-1", 500, 250],
      ["1-2", 750, 250],
      ["1-3", 1000, 250],
      ["1-4", 1250, 250],
    ]);
    const odd = chunkJob(parseJob("compare 7 '{}' '{}' --label x", 2), 1, 4);
    expect(odd.map((c) => c.count)).toEqual([2, 2, 2, 1]);
    expect(chunkJob(parseJob("profile --games 49", 3), 10, 1)).toHaveLength(1);
    expect(chunkJob(parseJob("misses --trials 48 --label x", 4), 10, 1).map((c) => [c.first, c.count])).toEqual([[0, 48]]);
    // 打ち比べ調査は 1 つの番号で 1 試合。1 試合 20 秒・1 区切り 60 秒なら 3 試合ずつ
    expect(chunkJob(parseJob("survey --games 100-109 --label x", 5), 20, 60).map((c) => [c.first, c.count])).toEqual([
      [100, 3],
      [103, 3],
      [106, 3],
      [109, 1],
    ]);
  });

  it("見込みは --est、台帳の同じ比べ・同じマシンの回、決めておいた値の順に使う", () => {
    const job = parseJob("yardstick --ref strong --label x", 1);
    const row = (over: Partial<RunRow>): RunRow =>
      ({ kind: "yardstick", a: {}, b: "strong", machine: "svwb-docker", threads: 28, n: 2000, seconds: 200, date: "2026-11-05", cmd: "" }) as RunRow & typeof over;
    expect(estimate(job, [], "svwb-docker", 28).perGame).toBeCloseTo(2.7 / 28);
    expect(estimate(job, [{ ...row({}), seconds: 200 }], "svwb-docker", 28)).toMatchObject({ perGame: 0.1 });
    // 並列数が違えば、スレッド秒で割り直す
    expect(estimate(job, [{ ...row({}), seconds: 200, threads: 14 }], "svwb-docker", 28).perGame).toBeCloseTo(0.05);
    // ほかのマシン・ほかの相手の回は使わない
    expect(estimate(job, [{ ...row({}), machine: "vm" }, { ...row({}), b: "classic" }], "svwb-docker", 28).perGame).toBeCloseTo(2.7 / 28);
    // 見落とし問題集は、全部の問を 1 回ずつ解く秒。台帳の回の問の数が今と違えば、問の数で割り直す
    const mjob = parseJob("misses --label x", 2);
    const mrow = (over: Partial<MissesRow>): MissesRow =>
      ({ kind: "misses", machine: "svwb-docker", threads: 28, trials: 24, seconds: 24, problems: 10, date: "2026-11-11" }) as MissesRow & typeof over;
    expect(estimate(mjob, [], "svwb-docker", 28).perGame).toBeCloseTo(5.9 / 28);
    expect(estimate(mjob, [], "svwb-docker", 28, [mrow({})]).perGame).toBeCloseTo(1);
    expect(estimate(mjob, [], "svwb-docker", 28, [{ ...mrow({}), problems: 5 }, { ...mrow({}), problems: 10 }]).perGame).toBeCloseTo(1.5);
    expect(estimate(parseJob("yardstick --ref strong --label x --est 0.3", 1), [row({})], "svwb-docker", 28).perGame).toBe(0.3);
    // 打ち比べ調査は、決めておいた値を局面の割合に比べて使う
    const sv = estimate(parseJob("survey --games 0-9 --label x", 3), [], "svwb-docker", 28).perGame;
    expect(estimate(parseJob("survey --games 0-9 --rate 0.05 --label x", 3), [], "svwb-docker", 28).perGame).toBeCloseTo(sv / 2);
  });

  it("--until は時刻帯の次のその時刻か、今からの長さ", () => {
    // 2026-11-10T19:27:08Z は東京で 11-11 04:27:08
    const now = Date.parse("2026-11-10T19:27:08Z");
    expect(new Date(parseUntil("07:00", now, "Asia/Tokyo")).toISOString()).toBe("2026-11-10T22:00:00.000Z");
    expect(new Date(parseUntil("04:00", now, "Asia/Tokyo")).toISOString()).toBe("2026-11-11T19:00:00.000Z");
    expect(parseUntil("+90m", now, "Asia/Tokyo") - now).toBe(90 * 60 * 1000);
    expect(wallClock(now, "Asia/Tokyo")).toMatchObject({ d: 11, h: 4, mi: 27 });
    expect(() => parseUntil("朝", now, "Asia/Tokyo")).toThrow(/--until/);
  });
});

const chunkRowsOf = (file: string): RunRow[] => parseLedger(readFileSync(file, "utf8")).runs;

/** 区切りの行（偽物の svwb が書く形） */
function chunkRow(first: number, count: number, seKind: "pairs" | "binomial"): RunRow {
  const pairs: [number, number, number] = [0, 0, 0];
  let wins = 0;
  for (let g = first; g < first + count; g++) {
    const w = (g * 7) % 3;
    pairs[w as 0 | 1 | 2]++;
    wins += w;
  }
  return {
    v: 1,
    kind: seKind === "pairs" ? "compare" : "yardstick",
    date: "2026-11-11",
    at: `2026-11-11T00:00:${String(first % 60).padStart(2, "0")}Z`,
    commit: "abc1234",
    branch: "main",
    label: "x",
    a: {},
    b: seKind === "pairs" ? {} : "classic",
    decks: [],
    mirror: seKind === "pairs",
    g: [first, first + count - 1],
    n: 2 * count,
    wins,
    rate: wins / (2 * count),
    se: 0,
    seKind,
    pairs,
    perDeck: { X: [wins, 2 * count] },
    seconds: count,
    perGame: 0.5,
    threads: 4,
    machine: "vm",
    cmd: "",
  };
}

describe("区切りの行をまとめる", () => {
  it("1 回で回したときと同じ勝ち数・組・誤差になる", () => {
    for (const seKind of ["pairs", "binomial"] as const) {
      const whole = chunkRow(0, 90, seKind);
      const c = combineRows([chunkRow(60, 30, seKind), chunkRow(0, 30, seKind), chunkRow(30, 30, seKind)], "compare 90", "n1");
      expect(c).toMatchObject({ g: [0, 89], n: 180, wins: whole.wins, pairs: whole.pairs, perDeck: whole.perDeck, seconds: 90, queue: "n1", chunks: 3, cmd: "compare 90" });
      const p = whole.wins / whole.n;
      const m = 90;
      const mean = (whole.pairs[1] * 0.5 + whole.pairs[2]) / m;
      const v = (whole.pairs[0] * mean ** 2 + whole.pairs[1] * (0.5 - mean) ** 2 + whole.pairs[2] * (1 - mean) ** 2) / (m - 1);
      const se = seKind === "pairs" ? Math.sqrt(v / m) : Math.sqrt((p * (1 - p)) / whole.n);
      expect(c.se).toBeCloseTo(se, 6);
      expect(c.at).toBe("2026-11-11T00:00:00Z");
    }
  });

  it("区切りごとの棋譜の名前は、試合番号の順の列にする（無ければ null）", () => {
    const row = (first: number, kifu: string | null) => ({ ...chunkRow(first, 30, "pairs"), kifu });
    expect(combineRows([row(30, "b.jsonl"), row(0, "a.jsonl"), row(60, null)], "compare 90", "n1").kifu).toEqual(["a.jsonl", "b.jsonl"]);
    expect(combineRows([row(0, null)], "compare 30", "n1").kifu).toBeNull();
  });
});

describe("棋譜の gzip", () => {
  it("区切りの前と同じままのファイル（止まった survey の書きかけ）は gzip しない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "night-kifu-"));
    try {
      const k = kifuDir(dir);
      mkdirSync(k, { recursive: true });
      writeFileSync(join(k, "survey-g0-9.jsonl"), '{"g":0}\n');
      writeFileSync(join(k, "x.jsonl.tmp"), "{}\n");
      const before = kifuSnapshot(dir);
      writeFileSync(join(k, "compare-g0-9.jsonl"), '{"g":1}\n');
      expect(await gzipKifu(dir, before)).toEqual(["compare-g0-9.jsonl.gz"]);
      expect(readdirSync(k).sort()).toEqual(["compare-g0-9.jsonl.gz", "survey-g0-9.jsonl", "x.jsonl.tmp"]);
      // 続きから回した survey が書き足すと、その区切りの後に gzip する
      const before2 = kifuSnapshot(dir);
      writeFileSync(join(k, "survey-g0-9.jsonl"), '{"g":0}\n{"g":1}\n');
      expect(await gzipKifu(dir, before2)).toEqual(["survey-g0-9.jsonl.gz"]);
      expect(gunzipSync(readFileSync(join(k, "survey-g0-9.jsonl.gz"))).toString()).toBe('{"g":0}\n{"g":1}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** svwb の代わり。台帳の行だけを書く（FAKE_FAIL の区切りは失敗、FAKE_HANG は 1 分待つ、FAKE_STOP_AT は終わった後に STOP を置く） */
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const shellLine = (a) => a.map((x) => (x !== "" && /^[A-Za-z0-9_./,:=+\\-@%]+$/.test(x) ? x : "'" + x.replace(/'/g, "'\\\\''") + "'")).join(" ");
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
const kind = argv[0];
let count, first, a, b;
if (kind === "compare") { count = Number(argv[1]); a = JSON.parse(argv[2]); b = JSON.parse(argv[3]); first = Number(argv[4]); }
else if (kind === "yardstick") { count = Number(flag("--games")); first = Number(flag("--start")); a = JSON.parse(flag("--opts")); b = flag("--ref"); }
else if (kind === "profile") { fs.writeFileSync(flag("--json"), "{}"); fs.writeFileSync(flag("--report"), "# 速さ"); process.exit(0); }
else if (kind === "survey" && argv[1] === "run") {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, shellLine(argv) + "\\n");
  const out = flag("--out");
  const [g0, g1] = flag("--games").split("-").map(Number);
  const rows = fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\\n").filter((l) => l !== "").map((l) => JSON.parse(l)) : [];
  const have = new Set(rows.filter((o) => o.game).map((o) => o.g));
  let t = "";
  for (let g = g0; g <= g1; g++) if (!have.has(g)) t += JSON.stringify({ g, i: 3, p: 0 }) + "\\n" + JSON.stringify({ game: true, g, turnStarts: [9, 9] }) + "\\n";
  fs.appendFileSync(out, t);
  process.exit(0);
}
else if (kind === "survey" && argv[1] === "report") {
  const rows = fs.readFileSync(argv[2], "utf8").split("\\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  const games = rows.filter((o) => o.game).map((o) => o.g);
  const n = rows.length - games.length;
  const row = { v: 1, kind, date: "2026-11-11", at: "2026-11-11T00:00:00Z", commit: process.env.SVWB_COMMIT, branch: process.env.SVWB_BRANCH,
    label: flag("--label"), a: {}, g: [Math.min(...games), Math.max(...games)], games: games.length, rate: 0.1, m: 32, extra: 4, confirm: 96, flag: 10,
    turnStarts: 18 * games.length, positions: n, compared: n, gain4: [0.5, 0.25], gain8: [1, 0.5], gain2: [0.5, 0.25], gain2Extra: [0, 0], flagged: 0, misses: 0, missesPerGame: [0, 0],
    splitAny: 0.5, splitPair: 0.25, pairSe: 0.1, perRollout: 1, seconds: n, machines: ["m"], commits: [process.env.SVWB_COMMIT], cmd: shellLine(argv) };
  fs.appendFileSync(process.env.SVWB_LEDGER, JSON.stringify(row) + "\\n");
  console.log("# 打ち比べ調査");
  process.exit(0);
}
else if (kind === "misses") {
  const trials = Number(flag("--trials"));
  if (trials === 0) process.exit(0);
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, shellLine(argv) + "\\n");
  const row = { v: 1, kind, date: "2026-11-11", at: "2026-11-11T00:00:00Z", commit: process.env.SVWB_COMMIT, branch: process.env.SVWB_BRANCH,
    label: flag("--label"), a: JSON.parse(flag("--opts")), problems: 2, set: "abcd1234", trials, seed: Number(flag("--seed")), n: 2 * trials, passes: trials,
    rate: 0.5, se: 0.01, perProblem: { a: [trials, trials], b: [0, trials] }, seconds: trials / 10,
    threads: Number(process.env.THREADS), machine: process.env.SVWB_MACHINE, cmd: shellLine(argv) };
  fs.appendFileSync(process.env.SVWB_LEDGER, JSON.stringify(row) + "\\n");
  process.exit(0);
}
else if (kind === "td" && (argv[1] === "train" || argv[1] === "prune")) {
  // Rust 版の学習（--impl rust）。--out に引数を書く
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, shellLine(argv) + "\\n");
  fs.writeFileSync(flag("--out"), JSON.stringify({ tool: "svwb", argv }));
  process.exit(0);
}
else if ((kind === "td" && argv[1] === "selfplay") || kind === "beam-gap") {
  const g = Number(flag("--games"));
  const s = Number(flag(kind === "td" ? "--start" : "--from"));
  if (g > 0 && process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, shellLine(argv) + "\\n");
  if (String(s) === process.env.FAKE_FAIL) { console.error("わざと失敗"); process.exit(3); }
  let t = kind === "td" ? JSON.stringify({ tdLayout: {} }) + "\\n" : "";
  for (let i = s; i < s + g; i++) t += JSON.stringify({ g: i }) + "\\n";
  fs.writeFileSync(flag(kind === "td" ? "--out" : "--inputs"), t);
  if (kind === "beam-gap" && flag("--out")) fs.writeFileSync(flag("--out"), "");
  process.exit(0);
}
if (count === 0) process.exit(0);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, shellLine(argv) + "\\n");
if (String(first) === process.env.FAKE_FAIL) { console.error("わざと失敗"); process.exit(3); }
const finish = () => {
  // 棋譜（本物の svwb と同じく、SVWB_KIFU_DIR の下に .tmp で書いてから名前を替える）
  if (process.env.SVWB_KIFU_DIR) {
    fs.mkdirSync(process.env.SVWB_KIFU_DIR, { recursive: true });
    const k = path.join(process.env.SVWB_KIFU_DIR, kind + "-g" + first + "-" + (first + count - 1) + ".jsonl");
    fs.writeFileSync(k + ".tmp", JSON.stringify({ kind: "replay", version: 2, g: first }) + "\\n");
    fs.renameSync(k + ".tmp", k);
  }
  const pairs = [0, 0, 0]; let wins = 0;
  for (let g = first; g < first + count; g++) { const w = process.env.FAKE_WIN ? 2 : (g * 7) % 3; pairs[w]++; wins += w; }
  const n = 2 * count;
  const row = { v: 1, kind, date: "2026-11-11", at: "2026-11-11T00:00:00Z", commit: process.env.SVWB_COMMIT, branch: process.env.SVWB_BRANCH,
    label: flag("--label"), a, b, decks: ["X"], mirror: true, g: [first, first + count - 1], n, wins, rate: wins / n, se: 0.01,
    seKind: kind === "yardstick" && b === "classic" ? "binomial" : "pairs", pairs, perDeck: { X: [wins, n] }, seconds: count / 10, perGame: count / 10 / n,
    threads: Number(process.env.THREADS), machine: process.env.SVWB_MACHINE, cmd: shellLine(argv) };
  fs.appendFileSync(process.env.SVWB_LEDGER, JSON.stringify(row) + "\\n");
  if (String(first) === process.env.FAKE_STOP_AT) fs.writeFileSync(path.join(path.dirname(process.env.SVWB_LEDGER), "STOP"), "");
};
if (String(first) === process.env.FAKE_HANG) setTimeout(finish, 60000); else finish();
`;

describe("worker の pid", () => {
  it("切り離した worker は引数の回のフォルダで、--foreground は start・resume のプロセスそのもので見分ける", async () => {
    const dir = mkdtempSync(join(tmpdir(), "night-pid-"));
    const sleeper = (...args: string[]) => spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", ...args], { stdio: "ignore" });
    const kids = [sleeper("night-main", "worker", dir), sleeper("night-main", "start", "q.txt", "--foreground"), sleeper("night-main", "start", "q.txt")];
    try {
      await new Promise((r) => setTimeout(r, 300));
      const at = (i: number) => {
        writeFileSync(join(dir, "worker.pid"), String(kids[i]!.pid));
        return workerPid(dir);
      };
      expect(at(0)).toBe(kids[0]!.pid);
      expect(at(1)).toBe(kids[1]!.pid);
      // 回のフォルダも --foreground も無いプロセスは、pid が使い回されたもの
      expect(at(2)).toBeNull();
    } finally {
      for (const k of kids) k.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** git を回す（試す用の名前とメールで） */
const gitT = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

describe("区切って回す（偽物の svwb で）", () => {
  let tmp = "";
  let root = "";
  let jobs = "";
  let fake = "";
  let fakeLog = "";
  /** PC のリポジトリの代わり（止まったときに台帳の行を night/<回> にコミットする先） */
  let pcGit = "";
  const env = ["FAKE_FAIL", "FAKE_HANG", "FAKE_STOP_AT", "FAKE_LOG", "FAKE_WIN", "FAKE_TD_FAIL", "SVWB_NIGHT_GIT_DIR", "SVWB_COMMIT", "SVWB_OUTBOX_MAX_MB", "SVWB_NIGHT_REMOTE"];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "night-"));
    root = join(tmp, "runs");
    // 本物のリポジトリに night/ のブランチを作らないよう、小さなリポジトリを作って、その最初のコミットを回のコミットにする
    pcGit = join(tmp, "pc-git");
    mkdirSync(join(pcGit, "docs"), { recursive: true });
    writeFileSync(join(pcGit, "docs", "ledger.jsonl"), `${JSON.stringify({ v: 1, kind: "decision", note: "前からある行" })}\n`);
    gitT(pcGit, "init", "-q", "-b", "main");
    gitT(pcGit, "add", ".");
    gitT(pcGit, "commit", "-q", "-m", "最初");
    process.env.SVWB_NIGHT_GIT_DIR = pcGit;
    process.env.SVWB_COMMIT = gitT(pcGit, "rev-parse", "--short=7", "HEAD");
    fake = join(tmp, "fake-svwb");
    writeFileSync(fake, FAKE, { mode: 0o755 });
    fakeLog = join(tmp, "calls.log");
    process.env.FAKE_LOG = fakeLog;
    jobs = join(tmp, "jobs.txt");
    // 1 試合 0.5 秒・1 区切り 1 分 → compare 150 組は 50 組ずつ 3 区切り。物差し・速さ・見落とし問題集は 1 区切り
    writeFileSync(
      jobs,
      [
        "# 試す",
        "compare 150 '{}' '{\"beamWidth\":8}' 0 --label 幅 --est 0.5",
        "yardstick --ref classic --games 40 --start 10 --label 弱 --est 0.5",
        "profile --games 2",
        "misses --trials 4 --label 問題集 --est 0.5",
      ].join("\n"),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of env) delete process.env[k];
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  const start = (...more: string[]) =>
    main(["start", jobs, "--yes", "--root", root, "--name", "n1", "--bin", fake, "--allow-dirty", "--threads", "2", "--chunk-min", "1", "--until", "+2h", ...more]);
  const resume = (...more: string[]) => main(["resume", "n1", "--yes", "--root", root, "--foreground", "--threads", "2", "--until", "+2h", ...more]);
  const dir = () => join(root, "n1");
  const calls = () => (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").trim().split("\n") : []);
  const done = () => readdirSync(join(dir(), "done")).map((f) => f.replace(/\.json$/, "")).sort();

  it("全部の区切りを回し、finish がジョブごとに 1 行にまとめて台帳に足す（2 回目は足さない）", async () => {
    expect(await start("--foreground")).toBe(0);
    expect(done()).toEqual(["1-1", "1-2", "1-3", "2-1", "3-1", "4-1"]);
    expect(calls()).toHaveLength(5);
    expect(calls()[4]).toBe(`misses run --opts '{}' --trials 4 --seed 1 --label '問題集'`);
    expect(readStatus(dir())).toMatchObject({ state: "done" });
    expect(existsSync(join(dir(), "speed-3.md"))).toBe(true);
    // 棋譜は回のフォルダの kifu/ に区切りごとに書かれ、区切りが済むと gzip される
    expect(readdirSync(join(dir(), "kifu")).sort()).toEqual([
      "compare-g0-49.jsonl.gz",
      "compare-g100-149.jsonl.gz",
      "compare-g50-99.jsonl.gz",
      "yardstick-g10-49.jsonl.gz",
    ]);
    expect(gunzipSync(readFileSync(join(dir(), "kifu", "compare-g50-99.jsonl.gz"))).toString()).toBe('{"kind":"replay","version":2,"g":50}\n');
    const target = join(tmp, "ledger.jsonl");
    writeFileSync(target, "");
    expect(await main(["finish", "n1", "--root", root, "--ledger", target])).toBe(0);
    const rows = parseLedger(readFileSync(target, "utf8")).runs as (RunRow & { queue: string; chunks: number })[];
    expect(rows.map((r) => [r.label, r.g, r.n, r.chunks, r.queue])).toEqual([
      ["幅", [0, 149], 300, 3, "n1"],
      ["弱", [10, 49], 80, 1, "n1"],
    ]);
    expect(rows[0]?.cmd).toBe(`compare 150 '{}' '{"beamWidth":8}' 0 --label '幅'`);
    expect(rows[1]?.seKind).toBe("binomial");
    expect(rows[0]?.threads).toBe(2);
    const misses = parseLedger(readFileSync(target, "utf8")).misses as (MissesRow & { queue: string; chunks: number })[];
    expect(misses.map((r) => [r.label, r.trials, r.rate, r.queue, r.chunks])).toEqual([["問題集", 4, 0.5, "n1", 1]]);
    expect(await main(["finish", "n1", "--root", root, "--ledger", target])).toBe(0);
    expect(parseLedger(readFileSync(target, "utf8")).runs).toHaveLength(2);
    expect(parseLedger(readFileSync(target, "utf8")).misses).toHaveLength(1);
  });

  it("打ち比べ調査は区切りごとに同じ出力に足し、全部済んでから finish が survey report の 1 行を足す", async () => {
    // 1 試合 20 秒・1 区切り 1 分 → 3 試合ずつ 4 区切り
    writeFileSync(jobs, "survey run --games 0-9 --label 調査 --est 20\n");
    expect(await start("--foreground")).toBe(0);
    expect(done()).toEqual(["1-1", "1-2", "1-3", "1-4"]);
    expect(calls().map((c) => c.split(" ").slice(4, 6).join(" "))).toEqual(["--games 0-2", "--games 3-5", "--games 6-8", "--games 9-9"]);
    const out = join(dir(), "survey-1.jsonl");
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(20);
    // 出力に試合が揃っていて印が無い区切りは回さない。最後の区切りを消すと、finish は待つ
    unlinkSync(join(dir(), "done", "1-2.json"));
    unlinkSync(join(dir(), "done", "1-4.json"));
    writeFileSync(out, readFileSync(out, "utf8").split("\n").filter((l) => !l.includes('"g":9')).join("\n"));
    const target = join(tmp, "ledger.jsonl");
    writeFileSync(target, "");
    expect(await main(["finish", "n1", "--root", root, "--ledger", target])).toBe(0);
    expect(parseLedger(readFileSync(target, "utf8")).surveys).toHaveLength(0);
    const before = calls().length;
    expect(await resume()).toBe(0);
    expect(calls().slice(before).map((c) => c.split(" ").slice(4, 6).join(" "))).toEqual(["--games 9-9"]);
    expect(JSON.parse(readFileSync(join(dir(), "done", "1-2.json"), "utf8"))).toMatchObject({ recovered: true });
    expect(await main(["finish", "n1", "--root", root, "--ledger", target])).toBe(0);
    const rows = parseLedger(readFileSync(target, "utf8")).surveys as (SurveyRow & { queue: string; chunks: number })[];
    expect(rows.map((r) => [r.label, r.g, r.games, r.positions, r.queue, r.chunks])).toEqual([["調査", [0, 9], 10, 10, "n1", 4]]);
    expect(readFileSync(join(dir(), "survey-1.md"), "utf8")).toContain("打ち比べ調査");
    expect(await main(["finish", "n1", "--root", root, "--ledger", target])).toBe(0);
    expect(parseLedger(readFileSync(target, "utf8")).surveys).toHaveLength(1);
  });

  it("失敗した区切りの後はそのジョブを飛ばし、resume で続きから回す", async () => {
    process.env.FAKE_FAIL = "50";
    expect(await start("--foreground")).toBe(1);
    expect(done()).toEqual(["1-1", "2-1", "3-1", "4-1"]);
    expect(readFileSync(join(dir(), "failed.json"), "utf8")).toContain("1-2");
    delete process.env.FAKE_FAIL;
    const before = calls().length;
    expect(await resume()).toBe(0);
    // 済んだ区切りは回さない
    expect(calls().slice(before).map((c) => c.split(" ").slice(0, 5).join(" "))).toEqual(["compare 50 '{}' '{\"beamWidth\":8}' 50", "compare 50 '{}' '{\"beamWidth\":8}' 100"]);
    expect(done()).toEqual(["1-1", "1-2", "1-3", "2-1", "3-1", "4-1"]);
  });

  it("台帳に行があって印が無い区切り（行を書いた直後に電源が切れた）は回さない", async () => {
    expect(await start("--foreground")).toBe(0);
    unlinkSync(join(dir(), "done", "1-2.json"));
    const before = calls().length;
    expect(await resume()).toBe(0);
    expect(calls().length).toBe(before);
    expect(JSON.parse(readFileSync(join(dir(), "done", "1-2.json"), "utf8"))).toMatchObject({ recovered: true });
  });

  it("STOP があれば区切りの切れ目で止まる", async () => {
    process.env.FAKE_STOP_AT = "50";
    expect(await start("--foreground")).toBe(1);
    expect(done()).toEqual(["1-1", "1-2"]);
    expect(readStatus(dir())?.reason).toMatch(/手で止めた/);
    // resume は STOP を消して続きから
    expect(await resume()).toBe(0);
    expect(done()).toEqual(["1-1", "1-2", "1-3", "2-1", "3-1", "4-1"]);
  });

  it("止める時刻までに終わらない区切りは始めない", async () => {
    // 50 組（100 試合）× 0.5 秒 = 50 秒の区切りを、残り 20 秒では始めない
    expect(await start("--foreground", "--until", "+20s")).toBe(1);
    expect(existsSync(join(dir(), "done"))).toBe(false);
    expect(readStatus(dir())?.reason).toMatch(/止める時刻/);
  });

  it("学び直しの流れ: 自己対戦のファイル・学習・pick・見込みを順に作り、失敗したら後ろのジョブは入力が無いので飛ばし、resume で続きから", async () => {
    // td・potential の代わり（--out に引数を書く。FAKE_TD_FAIL を含む引数なら失敗）
    const nodeBin = join(tmp, "nodebin");
    const fakeTool = (tool: string) =>
      [
        `import { appendFileSync, writeFileSync } from "node:fs";`,
        `export async function main(argv) {`,
        `  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, "${tool} " + argv.join(" ") + "\\n");`,
        `  if (process.env.FAKE_TD_FAIL && argv.join(" ").includes(process.env.FAKE_TD_FAIL)) return 1;`,
        `  writeFileSync(argv[argv.indexOf("--out") + 1], JSON.stringify({ tool: "${tool}", argv }));`,
        `  return 0;`,
        `}`,
      ].join("\n");
    for (const tool of ["td", "potential"]) {
      mkdirSync(join(nodeBin, tool), { recursive: true });
      writeFileSync(join(nodeBin, tool, `${tool}-main.mjs`), fakeTool(tool));
    }
    writeFileSync(
      jobs,
      [
        "td extend --model data/value-net.json --out @/net0.json --est 1",
        "td selfplay --model @/net0.json --games 10 --start 100 --chunk 4 --eps 0.1 --out @/s-{k}.jsonl.gz --est 0.1",
        "td train --model @/net0.json --data @/s-{1..3}.jsonl.gz --out @/a.json --est 1",
        "td train --model data/value-net.json --data @/s-{1..3}.jsonl.gz --out @/b.json --impl ts --est 1",
        `compare 6 '{"valueNet":"@/a.json"}' '{"valueNet":"@/b.json"}' 0 --label q1 --est 0.1`,
        "pick --compare q1 --pass @/a.json --fail @/b.json --out @/q2.json",
        `beam-gap --games 4 --from 1000 --chunk 2 --ref '{"beamWidth":4096,"valueNet":"@/q2.json"}' --sample 100 --inputs @/pot-{k}.jsonl --out @/pot-{k}-rows.jsonl --est 0.1`,
        "potential train --data @/pot-{1..2}.jsonl --valid 1003-1003 --out @/q2pot.json --est 1",
        `compare 4 '{"valueNet":"@/q2.json","potentialNet":"@/q2pot.json"}' '{}' 0 --label q2 --est 0.1`,
      ].join("\n"),
    );
    // 自己対戦の 2 つ目の区切り（g104〜）が失敗する
    process.env.FAKE_FAIL = "104";
    expect(await start("--foreground", "--node-bin", nodeBin)).toBe(1);
    const f = (name: string) => join(dir(), name);
    expect(existsSync(f("net0.json")) && existsSync(f("s-1.jsonl.gz"))).toBe(true);
    expect(existsSync(f("s-2.jsonl.gz")) || existsSync(f("a.json")) || existsSync(f("q2.json"))).toBe(false);
    const failed = JSON.parse(readFileSync(f("failed.json"), "utf8")) as Record<string, string>;
    expect(Object.keys(failed)).toEqual(["2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(failed["3"]).toMatch(/入力がありません: s-2.jsonl.gz・s-3.jsonl.gz/);
    delete process.env.FAKE_FAIL;
    const before = calls().length;
    process.env.FAKE_WIN = "1";
    expect(await resume()).toBe(0);
    const after = calls().slice(before);
    // 済んだ区切り（td extend・自己対戦の 1 つ目）は回さない
    expect(after.filter((c) => c.startsWith("td extend") || c.includes("--start 100 "))).toEqual([]);
    expect(after.filter((c) => c.startsWith("td selfplay")).map((c) => c.split(" ").slice(2, 6).join(" "))).toEqual(["--games 4 --start 104", "--games 2 --start 108"]);
    expect(after.find((c) => c.startsWith("td train --model data/value-net.json"))).toBe(
      `td train --model data/value-net.json --data ${f("s-1.jsonl.gz")},${f("s-2.jsonl.gz")},${f("s-3.jsonl.gz")} --out ${f("b.json")}.tmp`,
    );
    // td train の既定は Rust 版（svwb td train。--impl は渡さない）。--impl ts の行は TypeScript 版
    expect(JSON.parse(readFileSync(f("a.json"), "utf8"))).toEqual({
      tool: "svwb",
      argv: ["td", "train", "--model", f("net0.json"), "--data", `${f("s-1.jsonl.gz")},${f("s-2.jsonl.gz")},${f("s-3.jsonl.gz")}`, "--out", `${f("a.json")}.tmp`],
    });
    expect(JSON.parse(readFileSync(f("b.json"), "utf8"))).toMatchObject({ tool: "td" });
    // 自己対戦のファイルは gzip してある
    expect(gunzipSync(readFileSync(f("s-3.jsonl.gz"))).toString().trim().split("\n")).toEqual(['{"tdLayout":{}}', '{"g":108}', '{"g":109}']);
    expect(existsSync(f("s-3.jsonl.tmp"))).toBe(false);
    // A が全部勝つ → 線を越えて a.json を選ぶ。見込みは選んだ補正で学ぶ
    expect(readFileSync(f("q2.json"), "utf8")).toBe(readFileSync(f("a.json"), "utf8"));
    expect(JSON.parse(readFileSync(f("pick-6.json"), "utf8"))).toMatchObject({ compare: "q1", n: 12, pass: true, chosen: "@/a.json" });
    expect(after.find((c) => c.startsWith("beam-gap"))).toContain(`"valueNet":"${f("q2.json")}"`);
    expect(JSON.parse(readFileSync(f("q2pot.json"), "utf8"))).toMatchObject({ tool: "potential" });
    const rows = chunkRowsOf(f("ledger.jsonl"));
    expect(rows.map((r) => r.label)).toEqual(["q1", "q2"]);
    expect(rows[1]?.a).toEqual({ valueNet: f("q2.json"), potentialNet: f("q2pot.json") });
    // 作ったファイルがあれば、印が無くても回さない
    unlinkSync(join(dir(), "done", "3-1.json"));
    const n = calls().length;
    expect(await resume()).toBe(0);
    expect(calls().length).toBe(n);
    expect(JSON.parse(readFileSync(join(dir(), "done", "3-1.json"), "utf8"))).toMatchObject({ recovered: true });
    // finish は compare の行だけを足し、pick の結果を書き添える
    const target = join(tmp, "ledger.jsonl");
    writeFileSync(target, "");
    expect(await main(["finish", "n1", "--root", root, "--ledger", target])).toBe(0);
    const added = parseLedger(readFileSync(target, "utf8")).runs;
    expect(added.map((r) => r.label)).toEqual(["q1", "q2"]);
    // 台帳の行には、PC の中の回のフォルダの道ではなく、回の名前からの道（@<回>/…）を書く
    expect(added[1]?.a).toEqual({ valueNet: "@n1/q2.json", potentialNet: "@n1/q2pot.json" });
    expect(added[1]?.cmd).toBe(`compare 4 '{"valueNet":"@n1/q2.json","potentialNet":"@n1/q2pot.json"}' '{}' 0 --label q2`);
    expect(readFileSync(target, "utf8")).not.toContain(dir());
    expect(readFileSync(f("summary.md"), "utf8")).toMatch(/ジョブ 6（pick）: q1: 100.00%.*越えた。@\/q2.json は @\/a.json/);
  });

  it("pick は線を越えなければ fail のファイルを選ぶ", async () => {
    const nodeBin = join(tmp, "nodebin");
    mkdirSync(join(nodeBin, "td"), { recursive: true });
    writeFileSync(
      join(nodeBin, "td", "td-main.mjs"),
      `import { writeFileSync } from "node:fs";\nexport async function main(argv) { writeFileSync(argv[argv.indexOf("--out") + 1], argv.join(" ")); return 0; }\n`,
    );
    writeFileSync(
      jobs,
      [
        "td extend --model x.json --out @/a.json --est 1",
        "td extend --model y.json --out @/b.json --est 1",
        `compare 30 '{"valueNet":"@/a.json"}' '{"valueNet":"@/b.json"}' 0 --label q1 --est 0.1`,
        "pick --compare q1 --pass @/a.json --fail @/b.json --out @/q2.json",
      ].join("\n"),
    );
    expect(await start("--foreground", "--node-bin", nodeBin)).toBe(0);
    expect(readFileSync(join(dir(), "q2.json"), "utf8")).toContain("y.json");
    expect(JSON.parse(readFileSync(join(dir(), "pick-4.json"), "utf8"))).toMatchObject({ pass: false, chosen: "@/b.json" });
  });

  it("すぐ止める（stop --now）と回していた区切りを捨て、resume で回し直す", async () => {
    process.env.FAKE_HANG = "50";
    expect(await start("--prepare-only")).toBe(0);
    const ctl: WorkerControl = { stopNow: false };
    const timer = setInterval(() => {
      if (calls().length >= 2) {
        ctl.stopNow = true;
        ctl.kill?.();
        clearInterval(timer);
      }
    }, 50);
    const st = await runWorker(dir(), ctl);
    expect(st.reason).toMatch(/すぐ止めた/);
    expect(done()).toEqual(["1-1"]);
    expect(parseLedger(readFileSync(join(dir(), "ledger.jsonl"), "utf8")).runs).toHaveLength(1);
    delete process.env.FAKE_HANG;
    expect(await resume()).toBe(0);
    expect(done()).toEqual(["1-1", "1-2", "1-3", "2-1", "3-1", "4-1"]);
  });

  it("止まるたびに台帳の行を night/<回> にコミットし、スレッドの ingest は finish と同じ行を足す（2 回目は足さない）", async () => {
    const head = gitT(pcGit, "rev-parse", "HEAD");
    const work = readFileSync(join(pcGit, "docs", "ledger.jsonl"), "utf8");
    // 1 晩目: compare の 2 つ目の区切りの後で止める
    process.env.FAKE_STOP_AT = "50";
    expect(await start("--foreground")).toBe(1);
    delete process.env.FAKE_STOP_AT;
    // 今の朝のやり方（finish）で足した行と比べる
    const byFinish = join(tmp, "finish-ledger.jsonl");
    writeFileSync(byFinish, "");
    expect(await main(["finish", "n1", "--root", root, "--ledger", byFinish])).toBe(0);
    const tip1 = gitT(pcGit, "rev-parse", "night/n1");
    expect(gitT(pcGit, "rev-parse", "night/n1^")).toBe(head);
    expect(gitT(pcGit, "log", "-1", "--format=%s", "night/n1")).toBe(`台帳: 夜のキュー n1 の結果（1 行、${process.env.SVWB_COMMIT}）`);
    // コミットのメッセージ（公開するブランチ）にも、PC の中の回のフォルダの道は書かない
    expect(gitT(pcGit, "log", "-1", "--format=%B", "night/n1")).not.toContain(root);
    expect(gitT(pcGit, "log", "-1", "--format=%B", "night/n1")).toContain("夜のキュー n1（@n1）");
    expect(readStatus(dir())).toMatchObject({ branch: expect.stringMatching(/^night\/n1（.*台帳の行 1）$/), outbox: expect.stringContaining(join(tmp, "outbox", "n1")) });
    // 2 晩目: 続きを回す。ブランチの上に、残りの区切りの行を積む
    expect(await resume()).toBe(0);
    expect(await main(["finish", "n1", "--root", root, "--ledger", byFinish])).toBe(0);
    expect(gitT(pcGit, "rev-parse", "night/n1^")).toBe(tip1);
    // PC の作業ツリーと HEAD には触らない
    expect(gitT(pcGit, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(pcGit, "docs", "ledger.jsonl"), "utf8")).toBe(work);
    expect(gitT(pcGit, "status", "--porcelain")).toBe("");
    // スレッド: GitHub の代わりに PC のリポジトリから取ってきて足す
    const threadGit = join(tmp, "thread-git");
    mkdirSync(threadGit);
    gitT(threadGit, "init", "-q");
    process.env.SVWB_NIGHT_GIT_DIR = threadGit;
    const byIngest = join(tmp, "ingest-ledger.jsonl");
    writeFileSync(byIngest, "");
    expect(await main(["ingest", "n1", "--remote", pcGit, "--ledger", byIngest])).toBe(0);
    const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n");
    expect(lines(byIngest)).toEqual(lines(byFinish));
    expect(parseLedger(readFileSync(byIngest, "utf8")).runs.map((r) => [r.label, r.g])).toEqual([
      ["幅", [0, 99]],
      ["幅", [100, 149]],
      ["弱", [10, 49]],
    ]);
    expect(await main(["ingest", "night/n1", "--remote", pcGit, "--ledger", byIngest])).toBe(0);
    expect(lines(byIngest)).toEqual(lines(byFinish));
    // まとめ直し（wrap）は、足すものも様子の違いも無ければコミットしない
    process.env.SVWB_NIGHT_GIT_DIR = pcGit;
    const tip2 = gitT(pcGit, "rev-parse", "night/n1");
    expect(await main(["wrap", "n1", "--root", root])).toBe(0);
    expect(gitT(pcGit, "rev-parse", "night/n1")).toBe(tip2);
  });

  it("まとめが済んでいない回（電源が切れた・まとめの途中で落ちた）は status に出し、wrap --pending がまとめる。コミットの名前はいつも決まったもの", async () => {
    // PC の git に名前とメールがあっても、公開するブランチには載せない
    gitT(pcGit, "config", "user.name", "誰か");
    gitT(pcGit, "config", "user.email", "someone@example.invalid");
    process.env.FAKE_STOP_AT = "50";
    expect(await start("--foreground")).toBe(1);
    delete process.env.FAKE_STOP_AT;
    expect(gitT(pcGit, "log", "-1", "--format=%an <%ae>|%cn <%ce>", "night/n1")).toBe("svwb night queue <night-queue@svwb.invalid>|svwb night queue <night-queue@svwb.invalid>");
    // まとめの途中で電源が切れた: status にまとめの結果が無く、ブランチもまだ無い
    const st = readStatus(dir());
    writeFileSync(join(dir(), "status.json"), JSON.stringify({ ...st, outbox: undefined, branch: undefined }));
    gitT(pcGit, "update-ref", "-d", "refs/heads/night/n1");
    const said = () => vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(await main(["status", "n1", "--root", root])).toBe(0);
    expect(said()).toContain("まとめ: まだ");
    expect(await main(["wrap", "--pending", "--root", root])).toBe(0);
    expect(gitT(pcGit, "log", "-1", "--format=%s", "night/n1")).toMatch(/^台帳: 夜のキュー n1 の結果（1 行、/);
    expect(readStatus(dir())).toMatchObject({ state: "stopped", branch: expect.stringMatching(/^night\/n1（/) });
    vi.mocked(console.log).mockClear();
    expect(await main(["wrap", "--pending", "--root", root])).toBe(0);
    expect(said()).toBe("まとめが済んでいない回はありません");
    expect(await main(["status", "n1", "--root", root])).toBe(0);
    expect(said()).not.toContain("まとめ: まだ");
  });

  it("前の版（止まるときにまとめない版）で回した回は、status も wrap --pending も拾わない。名前を渡した wrap ならまとめる", async () => {
    expect(await start("--foreground")).toBe(0);
    // 前の版の回: session.json に wraps が無く、status にまとめの結果も無い。ブランチも無い
    const session = JSON.parse(readFileSync(join(dir(), "session.json"), "utf8")) as Record<string, unknown>;
    delete session.wraps;
    writeFileSync(join(dir(), "session.json"), JSON.stringify(session));
    writeFileSync(join(dir(), "status.json"), JSON.stringify({ ...readStatus(dir()), outbox: undefined, branch: undefined }));
    gitT(pcGit, "update-ref", "-d", "refs/heads/night/n1");
    rmSync(join(tmp, "outbox"), { recursive: true, force: true });
    const said = () => vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(await main(["status", "n1", "--root", root])).toBe(0);
    expect(said()).not.toContain("まとめ: まだ");
    vi.mocked(console.log).mockClear();
    expect(await main(["wrap", "--pending", "--root", root])).toBe(0);
    expect(said()).toBe("まとめが済んでいない回はありません");
    expect(existsSync(join(tmp, "outbox", "n1"))).toBe(false);
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "night/n1"], { cwd: pcGit }).status).not.toBe(0);
    expect(await main(["wrap", "n1", "--root", root])).toBe(0);
    expect(gitT(pcGit, "log", "-1", "--format=%s", "night/n1")).toMatch(/^台帳: 夜のキュー n1 の結果（3 行、/);
  });

  it("出口の一覧にあっても、その回の data/…/<回の名前>/・logs/<回の名前>/ の外には置かない", async () => {
    expect(outboxPathAllowed("n2", "logs/n2/night.log")).toBe(true);
    expect(outboxPathAllowed("n2", "data/kifu/n2/a.jsonl.gz")).toBe(true);
    expect(outboxPathAllowed("n2", "logs/n2/")).toBe(false);
    expect(outboxPathAllowed("n2", "logs/n20/night.log")).toBe(false);
    expect(outboxPathAllowed("n2", "docs/ledger.jsonl")).toBe(false);
    expect(outboxPathAllowed("n2", "data/models/other/m.json")).toBe(false);
    const src = join(tmp, "x.txt");
    writeFileSync(src, "x");
    const item = (path: string): PackItem => ({ file: "x.txt", src, kind: "logs", path, gzip: false, size: 1, mtimeMs: 0 });
    const out = join(tmp, "evil");
    const { partFiles } = await packItems({
      name: "n2",
      note: null,
      dir: tmp,
      created: new Date(),
      command: "試す",
      items: [item("logs/n2/ok.txt"), item("docs/evil.md"), item("data/models/other/m.json")],
      skipped: [],
      outDir: out,
      maxBytes: 0,
      head: (entries, parts) => [
        {
          path: "logs/n2/outbox.json",
          data: Buffer.from(
            JSON.stringify({
              v: 1,
              kind: "night-outbox",
              name: "n2",
              exported: new Date().toISOString(),
              parts: [...parts],
              entries: entries.map((e) => ({ path: e.path, part: e.part, size: e.packedSize, sha256: e.packedSha256 })),
              result: { name: "n2", tz: "Asia/Tokyo" },
            }),
          ),
        },
      ],
    });
    const shared = join(tmp, "shared2");
    mkdirSync(shared);
    expect(await main(["ingest", ...partFiles.map((f) => join(out, f)), "--to", shared])).toBe(1);
    expect(readFileSync(join(shared, "logs", "n2", "ok.txt"), "utf8")).toBe("x");
    expect(existsSync(join(shared, "docs"))).toBe(false);
    expect(existsSync(join(shared, "data", "models", "other"))).toBe(false);
  });

  it("券（go）: 券のコミットを取ってきて回のフォルダに出し、そこで回す。止まった回は同じ券で続きから、済んだ回・動いている回は回さない", async () => {
    // GitHub の代わりのリポジトリ。夜のキューのスクリプト（今のもの）とジョブのファイルをコミットする
    const here = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
    const orig = join(tmp, "origin-git");
    mkdirSync(join(orig, "scripts"), { recursive: true });
    mkdirSync(join(orig, "night"), { recursive: true });
    mkdirSync(join(orig, "docs"), { recursive: true });
    for (const f of ["night-main.ts", "night-outbox.ts", "ledger-main.ts", "pack-run-main.ts"]) copyFileSync(join(here, f), join(orig, "scripts", f));
    copyFileSync(join(pcGit, "docs", "ledger.jsonl"), join(orig, "docs", "ledger.jsonl"));
    const jobsText = readFileSync(jobs, "utf8");
    writeFileSync(join(orig, "night", "t.txt"), jobsText);
    writeFileSync(join(orig, "package-lock.json"), "{}\n");
    gitT(orig, "init", "-q", "-b", "claude/x");
    gitT(orig, "add", ".");
    gitT(orig, "commit", "-q", "-m", "夜のキュー");
    const full = gitT(orig, "rev-parse", "HEAD");
    process.env.SVWB_NIGHT_REMOTE = orig;
    // PC の /workspace（pcGit）には券のコミットが無い。依存は同じ（node_modules を指す）
    writeFileSync(join(pcGit, "package-lock.json"), "{}\n");
    mkdirSync(join(pcGit, "node_modules"));
    const t = makeTicket({ name: "g1", branch: "claude/x", commit: full.slice(0, 12), jobs: "night/t.txt", until: "+2h", threads: 2, chunk: 1 }, jobsText);
    const go = (ticket: string) => main(["go", ...ticket.split(" "), "--root", root, "--yes", "--bin", fake, "--foreground"]);
    const g1 = join(root, "g1");
    const said = () => vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    // 1 晩目: compare の 2 つ目の区切りの後で止める
    process.env.FAKE_STOP_AT = "50";
    expect(await go(ticketText(t))).toBe(1);
    delete process.env.FAKE_STOP_AT;
    expect(readFileSync(join(g1, "ticket.txt"), "utf8")).toBe(`${ticketText(t)}\n`);
    expect(readFileSync(join(g1, "src", "night", "t.txt"), "utf8")).toBe(jobsText);
    const plan = JSON.parse(readFileSync(join(g1, "plan.json"), "utf8")) as { repo: string; gitDir: string; commit: string; commitFull: string; branch: string };
    expect(plan).toMatchObject({ repo: join(g1, "src"), gitDir: pcGit, commit: full.slice(0, 7), commitFull: full, branch: "claude/x" });
    expect(readStatus(g1)).toMatchObject({ state: "stopped" });
    expect(gitT(pcGit, "rev-parse", "night/g1^")).toBe(full);
    const n1 = calls().length;
    // 2 晩目: 同じ券で続きから
    expect(await go(ticketText(t))).toBe(0);
    expect(readStatus(g1)).toMatchObject({ state: "done" });
    expect(gitT(pcGit, "rev-parse", "night/g1^^")).toBe(full);
    const n2 = calls().length;
    expect(n2).toBeGreaterThan(n1);
    // 済んだ回は回さない
    vi.mocked(console.log).mockClear();
    expect(await go(ticketText(t))).toBe(0);
    expect(calls().length).toBe(n2);
    expect(said()).toContain("この回は全部済んでいます");
    // 止める時刻だけ替えた券でも、同じ回として扱う
    const later = makeTicket({ ...t, until: "+3h" }, jobsText);
    expect(await go(ticketText(later))).toBe(0);
    expect(calls().length).toBe(n2);
    // 写し間違い（指紋が合わない）・同じ名前の別の回・ブランチに無いコミットは断る
    const why = () => errs.mock.calls.map((c) => String(c[0])).join("\n");
    expect(await go(ticketText({ ...t, until: "+3h" }))).toBe(2);
    expect(why()).toContain("券の指紋が合いません");
    writeFileSync(join(orig, "night", "t.txt"), `${jobsText}\nprofile --games 2\n`);
    gitT(orig, "commit", "-q", "-am", "足す");
    const full2 = gitT(orig, "rev-parse", "HEAD");
    const other = makeTicket({ ...t, commit: full2.slice(0, 12) }, `${jobsText}\nprofile --games 2\n`);
    expect(await go(ticketText(other))).toBe(2);
    expect(why()).toContain("同じ名前の別の回があります");
    expect(await go(ticketText(makeTicket({ ...t, name: "g2", commit: "0123456789ab" }, jobsText)))).toBe(2);
    expect(why()).toContain("券のコミット 0123456789ab がブランチ claude/x にありません");
    // 別の名前なら、新しいコミットで回る
    expect(await go(ticketText({ ...other, name: "g3", plan: ticketPlan({ ...other, name: "g3" }, `${jobsText}\nprofile --games 2\n`) }))).toBe(0);
    expect(gitT(pcGit, "rev-parse", "night/g3^")).toBe(full2);
    delete process.env.SVWB_NIGHT_REMOTE;
  }, 60_000);

  it("出口のアーカイブは、確かめて共有フォルダに展開する（分けたもの・足りないもの・壊れたもの）", async () => {
    process.env.SVWB_OUTBOX_MAX_MB = "0.002";
    expect(await start("--foreground")).toBe(0);
    // 名前が ASCII でないファイルも入る（tar の PAX）
    writeFileSync(join(dir(), "メモ.txt"), "あいう");
    expect(await main(["wrap", "n1", "--root", root])).toBe(0);
    const box = join(tmp, "outbox", "n1");
    const files = readdirSync(box).sort();
    expect(files).toContain("案内.txt");
    const parts = files.filter((f) => f.endsWith(".tar.gz"));
    expect(parts.length).toBeGreaterThan(2);
    expect(readFileSync(join(box, "案内.txt"), "utf8")).toMatch(/^夜のキューの出口: n1\n/);
    const shared = join(tmp, "shared");
    mkdirSync(shared);
    // 1 つ足りないと、置けるものは置いて、足りないものを言う
    const some = files.filter((f) => f !== parts[1]).map((f) => join(box, f));
    expect(await main(["ingest", ...some, "--to", shared])).toBe(1);
    expect(existsSync(join(shared, "logs", "n1", "night.log"))).toBe(true);
    expect(readFileSync(join(shared, "logs", "n1", "メモ.txt"), "utf8")).toBe("あいう");
    expect(gunzipSync(readFileSync(join(shared, "data", "kifu", "n1", "compare-g50-99.jsonl.gz"))).toString()).toBe('{"kind":"replay","version":2,"g":50}\n');
    expect(JSON.parse(readFileSync(join(shared, "logs", "n1", "outbox.json"), "utf8"))).toMatchObject({ kind: "night-outbox", name: "n1", result: { name: "n1" } });
    // 壊れたもの（途中で切れた）は置かない
    const broken = join(tmp, "broken.tar.gz");
    copyFileSync(join(box, parts[1] ?? ""), broken);
    truncateSync(broken, 200);
    expect(await main(["ingest", broken, "--to", shared])).toBe(1);
    // 全部そろえば 0。同じ中身は書き直さない
    expect(await main(["ingest", ...files.map((f) => join(box, f)), "--to", shared])).toBe(0);
    expect(readdirSync(join(shared, "logs", "n1"))).toEqual(expect.arrayContaining(["chunks", "plan.json", "outbox-summary.md", "speed-3.md", "ledger.jsonl.gz", "MANIFEST.md"]));
    expect(readdirSync(join(shared, "logs", "n1")).filter((f) => f.includes("ingest-tmp"))).toEqual([]);
  });
});

describe("台帳の行の道", () => {
  it("回のフォルダの道だけを @<回の名前> にする（名前の続く別の回や、ほかの道は替えない）", () => {
    const dir = "/home/wk/svwb-data/night/n1";
    expect(portablePath(`td train --data ${dir}/s-1.jsonl.gz,${dir}/s-2.jsonl.gz`, dir, "n1")).toBe("td train --data @n1/s-1.jsonl.gz,@n1/s-2.jsonl.gz");
    expect(portablePath(`回のフォルダ ${dir}（済んだ）`, dir, "n1")).toBe("回のフォルダ @n1（済んだ）");
    expect(portablePath(`${dir}0/a.json /home/wk/svwb-data/td-royal/m.json data/value-net.json`, dir, "n1")).toBe(
      `${dir}0/a.json /home/wk/svwb-data/td-royal/m.json data/value-net.json`,
    );
    expect(portableRow({ a: { valueNet: `${dir}/q.json` }, files: { [`${dir}/q.json`]: "abc" }, g: [0, 9] }, dir, "n1")).toEqual({
      a: { valueNet: "@n1/q.json" },
      files: { "@n1/q.json": "abc" },
      g: [0, 9],
    });
  });
});

describe("券", () => {
  const body = { name: "night-20261119", branch: "claude/x", commit: "0123456789ab", jobs: "night/t.txt", until: "07:00" };
  it("書いて読み直すと同じ。指紋はジョブのファイルの中身と項目で変わる", () => {
    const t = makeTicket(body, "compare 10 '{}' '{}' 0 --label a\n");
    expect(ticketText(t)).toBe(`svwb-night-1 name=night-20261119 branch=claude/x commit=0123456789ab jobs=night/t.txt until=07:00 plan=${t.plan}`);
    expect(parseTicket([ticketText(t)])).toEqual(t);
    expect(parseTicket(ticketText(t).split(" "))).toEqual(t);
    const u = makeTicket({ ...body, tz: "Asia/Tokyo", threads: 8, chunk: 15 }, "x");
    expect(parseTicket([ticketText(u)])).toEqual(u);
    expect(ticketPlan(body, "a")).not.toBe(ticketPlan(body, "b"));
    expect(ticketPlan(body, "a")).not.toBe(ticketPlan({ ...body, until: "08:00" }, "a"));
  });
  it("形の違う券・読めない語・使えない値は断る", () => {
    const t = ticketText(makeTicket(body, "x"));
    expect(() => parseTicket(["svwb-night-2", "name=a"])).toThrow(/git pull/);
    expect(() => parseTicket(["compare", "10"])).toThrow(/券ではありません/);
    expect(() => parseTicket([`${t} extra=1`])).toThrow(/読めない語/);
    expect(() => parseTicket([t.replace("name=night-20261119", "name=../x")])).toThrow(/name/);
    expect(() => parseTicket([t.replace("jobs=night/t.txt", "jobs=../t.txt")])).toThrow(/jobs/);
    expect(() => parseTicket([t.replace("commit=0123456789ab", "commit=0123")])).toThrow(/commit/);
    expect(() => parseTicket([t.replace("until=07:00", "until=朝")])).toThrow(/--until/);
    expect(() => parseTicket([t.replace(/ plan=\w+/, "")])).toThrow(/plan がありません/);
  });
  it("昼（7 時〜18 時）を見分け、GitHub の URL を認証の要らない形にする", () => {
    expect(isDaytime(Date.parse("2026-11-19T05:00:00Z"), "Asia/Tokyo")).toBe(true); // 14:00
    expect(isDaytime(Date.parse("2026-11-19T13:00:00Z"), "Asia/Tokyo")).toBe(false); // 22:00
    expect(isDaytime(Date.parse("2026-11-18T22:00:00Z"), "Asia/Tokyo")).toBe(true); // 07:00
    expect(isDaytime(Date.parse("2026-11-19T09:00:00Z"), "Asia/Tokyo")).toBe(false); // 18:00
    expect(httpsRemote("git@github.com:o/r.git")).toBe("https://github.com/o/r.git");
    expect(httpsRemote("ssh://git@github.com/o/r")).toBe("https://github.com/o/r.git");
    expect(httpsRemote("https://github.com/o/r.git\n")).toBe("https://github.com/o/r.git");
  });
  it("plan の券は、ジョブのファイルをコミットして push してあるときだけ出す", () => {
    const tmp = mkdtempSync(join(tmpdir(), "night-ticket-"));
    try {
      const bare = join(tmp, "bare.git");
      const repo = join(tmp, "repo");
      gitT(tmp, "init", "-q", "--bare", bare);
      mkdirSync(join(repo, "night"), { recursive: true });
      writeFileSync(join(repo, "night", "t.txt"), "profile --games 2\n");
      gitT(repo, "init", "-q", "-b", "claude/x");
      const file = join(repo, "night", "t.txt");
      expect(ticketHere(file, { name: "n", until: "07:00" }, repo)).toEqual({ why: expect.stringContaining("コミットしていない") });
      gitT(repo, "add", ".");
      gitT(repo, "commit", "-q", "-m", "a");
      gitT(repo, "remote", "add", "origin", bare);
      expect(ticketHere(file, { name: "n", until: "07:00" }, repo)).toEqual({ why: expect.stringContaining("push していない") });
      gitT(repo, "push", "-q", "origin", "claude/x");
      const r = ticketHere(file, { name: "n", until: "07:00", threads: 8 }, repo);
      const full = gitT(repo, "rev-parse", "HEAD");
      expect(r).toEqual({ ticket: makeTicket({ name: "n", branch: "claude/x", commit: full.slice(0, 12), jobs: "night/t.txt", until: "07:00", threads: 8 }, "profile --games 2\n") });
      writeFileSync(file, "profile --games 4\n");
      expect(ticketHere(file, { name: "n", until: "07:00" }, repo)).toEqual({ why: expect.stringContaining("コミットしていない変更") });
      expect(ticketHere(join(tmp, "outside.txt"), { name: "n", until: "07:00" }, repo)).toEqual({ why: expect.stringContaining("リポジトリの外") });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("回のソースの node_modules", () => {
  it("依存が同じなら /workspace を指し、続きの go の前に /workspace の依存が変わっていたら指すのをやめて npm ci", () => {
    const tmp = mkdtempSync(join(tmpdir(), "night-nm-"));
    try {
      const repo = join(tmp, "workspace");
      const src = join(tmp, "src");
      mkdirSync(join(repo, "node_modules"), { recursive: true });
      mkdirSync(src);
      writeFileSync(join(repo, "package-lock.json"), "a\n");
      writeFileSync(join(src, "package-lock.json"), "a\n");
      const ci = vi.fn((s: string) => mkdirSync(join(s, "node_modules")));
      const nm = join(src, "node_modules");
      prepareNodeModules(repo, src, ci);
      expect(lstatSync(nm).isSymbolicLink()).toBe(true);
      prepareNodeModules(repo, src, ci);
      expect(ci).not.toHaveBeenCalled();
      // 回が止まっている間に /workspace の依存が変わった
      writeFileSync(join(repo, "package-lock.json"), "b\n");
      prepareNodeModules(repo, src, ci);
      expect(ci).toHaveBeenCalledTimes(1);
      expect(lstatSync(nm).isDirectory()).toBe(true);
      expect(existsSync(join(repo, "node_modules"))).toBe(true);
      // npm ci で入れたものは、そのまま使う
      writeFileSync(join(repo, "package-lock.json"), "a\n");
      prepareNodeModules(repo, src, ci);
      expect(ci).toHaveBeenCalledTimes(1);
      expect(lstatSync(nm).isDirectory()).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
