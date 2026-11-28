// キュー（scripts/night-main.ts・docs/queue.md）。svwb と pueue の代わりに偽物を回して、区切り・積み直し・まとめ・券を確かめる

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLedger, type MissesRow, type RunRow } from "../scripts/ledger-main";
import { outboxPathAllowed } from "../scripts/night-outbox";
import { packItems, type PackItem } from "../scripts/pack-run-main";
import { labelOf, pueueStatus } from "../scripts/night-pueue";
import { FAKE, FAKE_PUEUE, drainQueue, gitT } from "./night-helpers";
import {
  branchRows,
  checkArgv,
  checkRunRefs,
  chunkJob,
  combineRows,
  estimate,
  expandBraces,
  gzipKifu,
  httpsRemote,
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
  shellLine,
  shellWords,
  standIn,
  jobArgv,
  ticketHere,
  ticketPlan,
  ticketText,
  wallClock,
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
    // --no-memo（補正の最後の隠れ層を使い回さない）はそのまま渡す
    const pn = parseJob("profile --no-memo --games 2", 5);
    expect(pn.spec).toEqual({ kind: "profile", opts: "{}", rhino: false, decks: null, noMemo: true });
    expect(jobArgv(pn, 0, 2, "/r")).toContain("--no-memo");
    // --no-jemalloc は svwb に渡さない（キューが LD_PRELOAD を入れないだけ）
    const pj = parseJob("profile --no-jemalloc --games 2", 6);
    expect(pj.spec).toEqual({ kind: "profile", opts: "{}", rhino: false, decks: null, noJemalloc: true });
    expect(jobArgv(pj, 0, 2, "/r")).not.toContain("--no-jemalloc");
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
    expect(sp.spec).toMatchObject({ kind: "survey", opts: '{"valueNet":"@/r.json"}', decks: "@data/pools/azvaldt/sets/rep10.txt", mulligan: null });
    // マリガンの打ち比べ（docs/survey.md「マリガンの打ち比べ」）: 既定は一段目 16 回・替える線 0、絞り込みと引き直しの数を渡す
    const mj = parseJob("survey --mulligan 1 --games 3000-3001 --label mul --narrow 32 --confirm 96", 6);
    expect(mj.spec).toMatchObject({ kind: "survey", m: 16, flag: 0, confirm: 96, mulligan: { narrow: 32, narrowTop: 2, reseed: 8 } });
    expect(jobArgv(mj, 3000, 2, "/r")).toEqual(
      ["survey", "run", "--out", "/r/survey-6.jsonl", "--games", "3000-3001", "--mulligan", "1", "--narrow", "32", "--narrow-top", "2", "--reseed", "8", "--m", "16", "--confirm", "96", "--flag", "0", "--batch", "8"],
    );
    expect(() => parseJob("survey --games 0-9 --label x --narrow 8", 1)).toThrow(/--mulligan 1/);
    expect(() => parseJob("survey --games 0-9 --label x --mulligan 2", 1)).toThrow(/--mulligan/);
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
    // --epochOut: エポックごとの重みも作るファイルに数え、読むファイルには数えない（次のジョブが読める）
    const ep = parseJob("td train --model @/a.json --out @/kt.json --epochOut @/kt-e{e}.json --epochs 3 --est 60", 6);
    expect(jobProducts(ep)).toEqual(["@/kt.json", "@/kt-e1.json", "@/kt-e2.json", "@/kt-e3.json"]);
    expect(jobInputs(ep)).toEqual(["@/a.json"]);
    expect(jobArgv(ep, 0, 1, "/r")).toEqual(["td", "train", "--model", "/r/a.json", "--out", "/r/kt.json.tmp", "--epochOut", "/r/kt-e{e}.json", "--epochs", "3"]);
    expect(() =>
      parseJobs("td extend --model x.json --out @/a.json --est 1\n" + "td train --model @/a.json --out @/kt.json --epochOut @/kt-e{e}.json --epochs 2 --est 60\n" + "td prune --model @/kt-e2.json --out @/kp.json --est 1"),
    ).not.toThrow();
    expect(() => parseJob("td train --model a.json --out @/b.json --epochOut @/b-e{e}.json --est 1", 1)).toThrow(/--epochs/);
    expect(() => parseJob("td train --model a.json --out @/b.json --epochOut @/b-e.json --epochs 2 --est 1", 1)).toThrow(/\{e\}/);
    expect(() => parseJob("td train --model a.json --out @/b.json --epochOut @/b-e{e}.json --epochs 2 --impl ts --est 1", 1)).toThrow(/Rust 版/);
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
    // td branch は、前の自己対戦が回のフォルダの kifu/ に書いた棋譜を読める（自己対戦が無ければ断る）
    const branch = "td branch --first random --model x.json --from @/kifu --games 10 --start 0 --chunk 5 --eps 0 --out @/b-{k}.jsonl --est 1";
    expect(parseJobs(`td selfplay --model x.json --games 10 --chunk 5 --eps 0 --out @/s-{k}.jsonl --est 1\n${branch}`)).toHaveLength(2);
    expect(() => parseJobs(branch)).toThrow(/@\/kifu を作るジョブが前にありません/);
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

describe("区切って回す（偽物の svwb・偽物の pueue で）", () => {
  let tmp = "";
  let root = "";
  let jobs = "";
  let fake = "";
  let fakeLog = "";
  /** 偽物の pueue の状態（tests/night-helpers.ts の FAKE_PUEUE・drainQueue） */
  let pueue = "";
  /** PC のリポジトリの代わり（台帳の行を night/<回> にコミットする先） */
  let pcGit = "";
  const env = [
    "FAKE_FAIL",
    "FAKE_HANG",
    "FAKE_LOG",
    "FAKE_WIN",
    "FAKE_TD_FAIL",
    "SVWB_NIGHT_GIT_DIR",
    "SVWB_COMMIT",
    "SVWB_OUTBOX_MAX_MB",
    "SVWB_NIGHT_REMOTE",
    "SVWB_PUEUE",
    "FAKE_PUEUE_STATE",
  ];

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
    const fakePueue = join(tmp, "fake-pueue");
    writeFileSync(fakePueue, FAKE_PUEUE, { mode: 0o755 });
    process.env.SVWB_PUEUE = fakePueue;
    pueue = join(tmp, "pueue.json");
    process.env.FAKE_PUEUE_STATE = pueue;
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

  /** 回 n1 を積み（無ければ作る。あれば済んでいない区切りを積み直す）、キューを回して、流せるものが無くなるまで流す */
  const run = async (...more: string[]) => {
    expect(await main(["enqueue", jobs, "--name", "n1", "--root", root, "--bin", fake, "--threads", "2", "--chunk-min", "1", ...more])).toBe(0);
    expect(await main(["start", "--root", root])).toBe(0);
    drainQueue(pueue);
  };
  const dir = () => join(root, "n1");
  const calls = () => (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").trim().split("\n") : []);
  const done = (name = "n1") => readdirSync(join(root, name, "done")).map((f) => f.replace(/\.json$/, "")).sort();
  /** ブランチ night/<回> の台帳の、その回の行 */
  const branch = (name = "n1") => branchRows(gitT(pcGit, "show", `night/${name}:docs/ledger.jsonl`), name);
  const roles = (name = "n1") => pueueStatus().tasks.filter((t) => labelOf(t.label)?.run === name).map((t) => [labelOf(t.label)?.role, t.state]);
  const said = () => vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");

  it("全部の区切りを積んで回し、回の最後の task（まとめ）がジョブごとに 1 行にまとめた行を night/<回> にコミットする（まとめ直しても足さない）", async () => {
    await run();
    expect(roles()).toEqual([
      ["組み立て", "Success"],
      ["1-1", "Success"],
      ["1-2", "Success"],
      ["1-3", "Success"],
      ["2-1", "Success"],
      ["3-1", "Success"],
      ["4-1", "Success"],
      ["まとめ", "Success"],
    ]);
    expect(done()).toEqual(["1-1", "1-2", "1-3", "2-1", "3-1", "4-1"]);
    expect(calls()).toHaveLength(5);
    expect(calls()[4]).toBe(`misses run --opts '{}' --trials 4 --seed 1 --label '問題集'`);
    expect(readStatus(dir())).toMatchObject({ state: "done", branch: expect.stringMatching(/^night\/n1（/) });
    expect(existsSync(join(dir(), "speed-3.md"))).toBe(true);
    // 棋譜は回のフォルダの kifu/ に区切りごとに書かれ、区切りが済むと gzip される
    expect(readdirSync(join(dir(), "kifu")).sort()).toEqual([
      "compare-g0-49.jsonl.gz",
      "compare-g100-149.jsonl.gz",
      "compare-g50-99.jsonl.gz",
      "yardstick-g10-49.jsonl.gz",
    ]);
    expect(gunzipSync(readFileSync(join(dir(), "kifu", "compare-g50-99.jsonl.gz"))).toString()).toBe('{"kind":"replay","version":2,"g":50}\n');
    const rows = branch();
    expect(rows.runs.map((r) => [r.label, r.g, r.n, r.chunks, r.queue])).toEqual([
      ["幅", [0, 149], 300, 3, "n1"],
      ["弱", [10, 49], 80, 1, "n1"],
    ]);
    expect(rows.runs[0]?.cmd).toBe(`compare 150 '{}' '{"beamWidth":8}' 0 --label '幅'`);
    expect(rows.runs[1]?.seKind).toBe("binomial");
    expect(rows.runs[0]?.threads).toBe(2);
    expect(rows.misses.map((r) => [r.label, r.trials, r.rate, r.queue, r.chunks])).toEqual([["問題集", 4, 0.5, "n1", 1]]);
    // まとめ直しても（queue-push.sh の wrap --pending・手の wrap）、足す行も様子の違いも無ければコミットしない
    const tip = gitT(pcGit, "rev-parse", "night/n1");
    expect(await main(["wrap", "--pending", "--root", root])).toBe(0);
    expect(said()).toContain("まとめが済んでいない回はありません");
    expect(await main(["wrap", "n1", "--root", root])).toBe(0);
    expect(gitT(pcGit, "rev-parse", "night/n1")).toBe(tip);
    // 済んだ回をもう一度積んでも、何も積まない
    expect(await main(["enqueue", jobs, "--name", "n1", "--root", root])).toBe(0);
    expect(pueueStatus().tasks).toHaveLength(8);
    // start はジョブのファイルを受けない（積むのは add）
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["start", jobs, "--root", root])).toBe(2);
    expect(String(errs.mock.calls[0]?.[0])).toContain("ジョブのファイルは渡しません");
  });

  it("打ち比べ調査は区切りごとに同じ出力に足し、全部の区切りが済んでから、まとめが survey report の 1 行を足す", async () => {
    // 1 試合 20 秒・1 区切り 1 分 → 3 試合ずつ 4 区切り。最後の区切りが失敗する
    writeFileSync(jobs, "survey run --games 0-9 --label 調査 --est 20\n");
    process.env.FAKE_FAIL = "9";
    await run();
    expect(done()).toEqual(["1-1", "1-2", "1-3"]);
    expect(calls().map((c) => c.split(" ").slice(4, 6).join(" "))).toEqual(["--games 0-2", "--games 3-5", "--games 6-8", "--games 9-9"]);
    const out = join(dir(), "survey-1.jsonl");
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(18);
    // 途中の調査は台帳に足さない（まとめの表の下に「まだ途中」と出る）
    expect(branch().surveys).toHaveLength(0);
    expect(gitT(pcGit, "log", "-1", "--format=%B", "night/n1")).toContain("ジョブ 1（調査）はまだ途中（区切り 3/4）");
    // 出力に試合が揃っていて印が無い区切りは回さない
    unlinkSync(join(dir(), "done", "1-2.json"));
    delete process.env.FAKE_FAIL;
    const before = calls().length;
    await run();
    expect(calls().slice(before).map((c) => c.split(" ").slice(4, 6).join(" "))).toEqual(["--games 9-9"]);
    expect(JSON.parse(readFileSync(join(dir(), "done", "1-2.json"), "utf8"))).toMatchObject({ recovered: true });
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(20);
    const rows = branch().surveys;
    expect(rows.map((r) => [r.label, r.g, r.games, r.positions, r.queue, r.chunks])).toEqual([["調査", [0, 9], 10, 10, "n1", 4]]);
    expect(readFileSync(join(dir(), "survey-1.md"), "utf8")).toContain("打ち比べ調査");
    expect(await main(["wrap", "n1", "--root", root])).toBe(0);
    expect(branch().surveys).toHaveLength(1);
  });

  it("区切りが失敗したらそのジョブの残りは回らず（pueue の DependencyFailed）、ほかのジョブとまとめは回る。積み直すと続きから", async () => {
    process.env.FAKE_FAIL = "50";
    await run();
    expect(roles()).toEqual([
      ["組み立て", "Success"],
      ["1-1", "Success"],
      ["1-2", "Failed"],
      ["1-3", "DependencyFailed"],
      ["2-1", "Success"],
      ["3-1", "Success"],
      ["4-1", "Success"],
      ["まとめ", "Success"],
    ]);
    expect(done()).toEqual(["1-1", "2-1", "3-1", "4-1"]);
    expect(readFileSync(join(dir(), "failed.json"), "utf8")).toContain("1-2");
    vi.mocked(console.log).mockClear();
    expect(await main(["status", "--root", root])).toBe(0);
    expect(said()).toMatch(/n1 .*積んでいない 2 区切り/);
    delete process.env.FAKE_FAIL;
    const before = calls().length;
    await run();
    // 済んだ区切りは回さない
    expect(calls().slice(before).map((c) => c.split(" ").slice(0, 5).join(" "))).toEqual(["compare 50 '{}' '{\"beamWidth\":8}' 50", "compare 50 '{}' '{\"beamWidth\":8}' 100"]);
    expect(done()).toEqual(["1-1", "1-2", "1-3", "2-1", "3-1", "4-1"]);
    expect(JSON.parse(readFileSync(join(dir(), "failed.json"), "utf8"))).toEqual({});
  });

  it("台帳に行があって印が無い区切り（行を書いた直後に電源が切れた）は回さない", async () => {
    await run();
    unlinkSync(join(dir(), "done", "1-2.json"));
    const before = calls().length;
    await run();
    expect(calls().length).toBe(before);
    expect(JSON.parse(readFileSync(join(dir(), "done", "1-2.json"), "utf8"))).toMatchObject({ recovered: true });
  });

  it("学び直しの流れ: 自己対戦のファイル・学習・pick・見込みを順に作り、失敗したら、その作るファイルを読む後ろのジョブは回らず、積み直すと続きから", async () => {
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
    await run("--node-bin", nodeBin);
    const f = (name: string) => join(dir(), name);
    expect(existsSync(f("net0.json")) && existsSync(f("s-1.jsonl.gz"))).toBe(true);
    expect(existsSync(f("s-2.jsonl.gz")) || existsSync(f("a.json")) || existsSync(f("q2.json"))).toBe(false);
    const failed = JSON.parse(readFileSync(f("failed.json"), "utf8")) as Record<string, string>;
    expect(Object.keys(failed)).toEqual(["2"]);
    expect(failed["2"]).toMatch(/区切り 2-2/);
    // 後ろの区切りは、待つ区切りが失敗したので回っていない
    vi.mocked(console.log).mockClear();
    expect(await main(["status", "--root", root])).toBe(0);
    expect(said()).toMatch(/n1 .*積んでいない 10 区切り/);
    delete process.env.FAKE_FAIL;
    const before = calls().length;
    process.env.FAKE_WIN = "1";
    await run();
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
    await run();
    expect(calls().length).toBe(n);
    expect(JSON.parse(readFileSync(join(dir(), "done", "3-1.json"), "utf8"))).toMatchObject({ recovered: true });
    // まとめは compare の行だけを足し、pick の結果を書き添える
    const added = branch().runs;
    expect(added.map((r) => r.label)).toEqual(["q1", "q2"]);
    // 台帳の行には、PC の中の回のフォルダの道ではなく、回の名前からの道（@<回>/…）を書く
    expect(added[1]?.a).toEqual({ valueNet: "@n1/q2.json", potentialNet: "@n1/q2pot.json" });
    expect(added[1]?.cmd).toBe(`compare 4 '{"valueNet":"@n1/q2.json","potentialNet":"@n1/q2pot.json"}' '{}' 0 --label q2`);
    expect(gitT(pcGit, "show", "night/n1:docs/ledger.jsonl")).not.toContain(dir());
    expect(readFileSync(f("outbox-summary.md"), "utf8")).toMatch(/ジョブ 6（pick）: q1: 100.00%.*越えた。@\/q2.json は @\/a.json/);
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
    await run("--node-bin", nodeBin);
    expect(done()).toEqual(["1-1", "2-1", "3-1", "4-1"]);
    expect(readFileSync(join(dir(), "q2.json"), "utf8")).toContain("y.json");
    expect(JSON.parse(readFileSync(join(dir(), "pick-4.json"), "utf8"))).toMatchObject({ pass: false, chosen: "@/b.json" });
  });

  it("回の最後の task が台帳の行を night/<回> にコミットし、続きを回すと残りの行をその上に積む。スレッドの ingest はブランチの行を足す（2 回目は足さない）", async () => {
    const head = gitT(pcGit, "rev-parse", "HEAD");
    const work = readFileSync(join(pcGit, "docs", "ledger.jsonl"), "utf8");
    // 1 回目: compare の 3 つ目の区切りが失敗する
    process.env.FAKE_FAIL = "100";
    await run();
    delete process.env.FAKE_FAIL;
    const tip1 = gitT(pcGit, "rev-parse", "night/n1");
    expect(gitT(pcGit, "rev-parse", "night/n1^")).toBe(head);
    expect(gitT(pcGit, "log", "-1", "--format=%s", "night/n1")).toBe(`台帳: キュー n1 の結果（3 行、${process.env.SVWB_COMMIT}）`);
    // コミットのメッセージ（公開するブランチ）にも、PC の中の回のフォルダの道は書かない
    expect(gitT(pcGit, "log", "-1", "--format=%B", "night/n1")).not.toContain(root);
    expect(gitT(pcGit, "log", "-1", "--format=%B", "night/n1")).toContain("キュー n1（@n1）");
    expect(readStatus(dir())).toMatchObject({ branch: expect.stringMatching(/^night\/n1（.*台帳の行 3）$/), outbox: expect.stringContaining(join(tmp, "outbox", "n1")) });
    // 2 回目: 積み直して続きを回す。ブランチの上に、残りの区切りの行を積む
    await run();
    expect(gitT(pcGit, "rev-parse", "night/n1^")).toBe(tip1);
    expect(gitT(pcGit, "log", "-1", "--format=%s", "night/n1")).toBe(`台帳: キュー n1 の結果（1 行、${process.env.SVWB_COMMIT}）`);
    // PC の作業ツリーと HEAD には触らない
    expect(gitT(pcGit, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(pcGit, "docs", "ledger.jsonl"), "utf8")).toBe(work);
    expect(gitT(pcGit, "status", "--porcelain")).toBe("");
    const onBranch = gitT(pcGit, "show", "night/n1:docs/ledger.jsonl")
      .split("\n")
      .filter((l) => l.includes('"queue":"n1"'));
    // スレッド: GitHub の代わりに PC のリポジトリから取ってきて足す
    const threadGit = join(tmp, "thread-git");
    mkdirSync(threadGit);
    gitT(threadGit, "init", "-q");
    process.env.SVWB_NIGHT_GIT_DIR = threadGit;
    const byIngest = join(tmp, "ingest-ledger.jsonl");
    writeFileSync(byIngest, "");
    expect(await main(["ingest", "n1", "--remote", pcGit, "--ledger", byIngest])).toBe(0);
    // ingest は種類ごとに並べて足す（compare・yardstick の後に misses）
    const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").sort();
    expect(lines(byIngest)).toEqual([...onBranch].sort());
    expect(parseLedger(readFileSync(byIngest, "utf8")).runs.map((r) => [r.label, r.g])).toEqual([
      ["幅", [0, 99]],
      ["弱", [10, 49]],
      ["幅", [100, 149]],
    ]);
    expect(parseLedger(readFileSync(byIngest, "utf8")).misses).toHaveLength(1);
    expect(await main(["ingest", "night/n1", "--remote", pcGit, "--ledger", byIngest])).toBe(0);
    expect(lines(byIngest)).toEqual([...onBranch].sort());
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
    await run();
    expect(gitT(pcGit, "log", "-1", "--format=%an <%ae>|%cn <%ce>", "night/n1")).toBe("svwb queue <queue@svwb.invalid>|svwb queue <queue@svwb.invalid>");
    // まとめの途中で電源が切れた: status にまとめの結果が無く、ブランチもまだ無い
    const st = readStatus(dir());
    writeFileSync(join(dir(), "status.json"), JSON.stringify({ ...st, outbox: undefined, branch: undefined }));
    gitT(pcGit, "update-ref", "-d", "refs/heads/night/n1");
    expect(await main(["status", "n1", "--root", root])).toBe(0);
    expect(said()).toContain("まとめ: まだ");
    expect(await main(["wrap", "--pending", "--root", root])).toBe(0);
    expect(gitT(pcGit, "log", "-1", "--format=%s", "night/n1")).toMatch(/^台帳: キュー n1 の結果（3 行、/);
    expect(readStatus(dir())).toMatchObject({ state: "done", branch: expect.stringMatching(/^night\/n1（/) });
    vi.mocked(console.log).mockClear();
    expect(await main(["wrap", "--pending", "--root", root])).toBe(0);
    expect(said()).toBe("まとめが済んでいない回はありません");
    expect(await main(["status", "n1", "--root", root])).toBe(0);
    expect(said()).not.toContain("まとめ: まだ");
  });

  it("2026-11-19 より前の版（止まったときにまとめない版）で回した回は、status も wrap --pending も拾わない。名前を渡した wrap ならまとめる", async () => {
    await run();
    // 前の版の回: session.json に wraps が無く、status にまとめの結果も無い。ブランチも無い
    const session = JSON.parse(readFileSync(join(dir(), "session.json"), "utf8")) as Record<string, unknown>;
    delete session.wraps;
    writeFileSync(join(dir(), "session.json"), JSON.stringify(session));
    writeFileSync(join(dir(), "status.json"), JSON.stringify({ ...readStatus(dir()), outbox: undefined, branch: undefined }));
    gitT(pcGit, "update-ref", "-d", "refs/heads/night/n1");
    rmSync(join(tmp, "outbox"), { recursive: true, force: true });
    expect(await main(["status", "n1", "--root", root])).toBe(0);
    expect(said()).not.toContain("まとめ: まだ");
    vi.mocked(console.log).mockClear();
    expect(await main(["wrap", "--pending", "--root", root])).toBe(0);
    expect(said()).toBe("まとめが済んでいない回はありません");
    expect(existsSync(join(tmp, "outbox", "n1"))).toBe(false);
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "night/n1"], { cwd: pcGit }).status).not.toBe(0);
    expect(await main(["wrap", "n1", "--root", root])).toBe(0);
    expect(gitT(pcGit, "log", "-1", "--format=%s", "night/n1")).toMatch(/^台帳: キュー n1 の結果（3 行、/);
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

  it("券（add）: 券のコミットを取ってきて回のフォルダに出し、そこで積む。積んだだけでは回らない。続きは回の名前で積み直し、済んだ回は積まない", async () => {
    // GitHub の代わりのリポジトリ。キューのスクリプト（今のもの）とジョブのファイルをコミットする
    const here = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
    const orig = join(tmp, "origin-git");
    mkdirSync(join(orig, "scripts"), { recursive: true });
    mkdirSync(join(orig, "night"), { recursive: true });
    mkdirSync(join(orig, "docs"), { recursive: true });
    for (const f of ["night-main.ts", "night-outbox.ts", "night-pueue.ts", "ledger-main.ts", "pack-run-main.ts"]) copyFileSync(join(here, f), join(orig, "scripts", f));
    copyFileSync(join(pcGit, "docs", "ledger.jsonl"), join(orig, "docs", "ledger.jsonl"));
    const jobsText = readFileSync(jobs, "utf8");
    writeFileSync(join(orig, "night", "t.txt"), jobsText);
    writeFileSync(join(orig, "package-lock.json"), "{}\n");
    gitT(orig, "init", "-q", "-b", "claude/x");
    gitT(orig, "add", ".");
    gitT(orig, "commit", "-q", "-m", "キュー");
    const full = gitT(orig, "rev-parse", "HEAD");
    process.env.SVWB_NIGHT_REMOTE = orig;
    // PC の /workspace（pcGit）には券のコミットが無い。依存は同じ（node_modules を指す）
    writeFileSync(join(pcGit, "package-lock.json"), "{}\n");
    mkdirSync(join(pcGit, "node_modules"));
    const body = { name: "g1", branch: "claude/x", commit: full.slice(0, 12), jobs: "night/t.txt", threads: 2, chunk: 1 };
    const t = makeTicket(body, jobsText);
    const add = (...words: string[]) => main(["add", ...words, "--root", root, "--bin", fake]);
    const go = async () => {
      expect(await main(["start", "--root", root])).toBe(0);
      drainQueue(pueue);
    };
    const g1 = join(root, "g1");
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const why = () => errs.mock.calls.map((c) => String(c[0])).join("\n");
    // 積むだけでは回らない
    expect(await add(...ticketText(t).split(" "))).toBe(0);
    expect(roles("g1").map(([, s]) => s)).toEqual(Array<string>(8).fill("Queued"));
    expect(calls()).toEqual([]);
    expect(readFileSync(join(g1, "ticket.txt"), "utf8")).toBe(`${ticketText(t)}\n`);
    expect(readFileSync(join(g1, "src", "night", "t.txt"), "utf8")).toBe(jobsText);
    // 1 回目: compare の 3 つ目の区切りが失敗する
    process.env.FAKE_FAIL = "100";
    await go();
    delete process.env.FAKE_FAIL;
    const plan = JSON.parse(readFileSync(join(g1, "plan.json"), "utf8")) as Record<string, unknown>;
    expect(plan).toMatchObject({ repo: join(g1, "src"), gitDir: pcGit, commit: full.slice(0, 7), commitFull: full, branch: "claude/x", queue: 1 });
    expect(lstatSync(join(g1, "src", "node_modules")).isSymbolicLink()).toBe(true);
    expect(done("g1")).toEqual(["1-1", "1-2", "2-1", "3-1", "4-1"]);
    expect(gitT(pcGit, "rev-parse", "night/g1^")).toBe(full);
    // 2 回目: 回の名前で積み直すと、済んでいない区切りとまとめだけを積む
    expect(await add("g1")).toBe(0);
    expect(roles("g1").filter(([, s]) => s === "Queued")).toEqual([
      ["1-3", "Queued"],
      ["まとめ", "Queued"],
    ]);
    await go();
    expect(readStatus(g1)).toMatchObject({ state: "done" });
    expect(gitT(pcGit, "rev-parse", "night/g1^^")).toBe(full);
    // 済んだ回は、同じ券でも積まない
    const n = pueueStatus().tasks.length;
    expect(await add(...ticketText(t).split(" "))).toBe(0);
    expect(pueueStatus().tasks).toHaveLength(n);
    // 写し間違い（指紋が合わない）・同じ名前の別の回・ブランチに無いコミット・前のやり方の券は断る
    expect(await add(...ticketText({ ...t, threads: 3 }).split(" "))).toBe(2);
    expect(why()).toContain("券の指紋が合いません");
    const jobs2 = `${jobsText}\nprofile --games 2\n`;
    writeFileSync(join(orig, "night", "t.txt"), jobs2);
    gitT(orig, "commit", "-q", "-am", "足す");
    const full2 = gitT(orig, "rev-parse", "HEAD");
    expect(await add(...ticketText(makeTicket({ ...body, commit: full2.slice(0, 12) }, jobs2)).split(" "))).toBe(2);
    expect(why()).toContain("同じ名前の別の回があります");
    expect(await add(...ticketText(makeTicket({ ...body, name: "g2", commit: "0123456789ab" }, jobsText)).split(" "))).toBe(2);
    expect(why()).toContain("券のコミット 0123456789ab がブランチ claude/x にありません");
    expect(await add("svwb-night-1", "name=g2", "branch=claude/x", `commit=${full.slice(0, 12)}`, "jobs=night/t.txt", "until=07:00", "plan=0123456789ab")).toBe(2);
    expect(why()).toContain("前のやり方の券");
    expect(existsSync(join(root, "g2"))).toBe(false);
    expect(pueueStatus().tasks).toHaveLength(n);
    // 別の名前なら、新しいコミットで回る
    expect(await add(...ticketText(makeTicket({ ...body, name: "g3", commit: full2.slice(0, 12) }, jobs2)).split(" "))).toBe(0);
    await go();
    expect(readStatus(join(root, "g3"))).toMatchObject({ state: "done" });
    expect(gitT(pcGit, "rev-parse", "night/g3^")).toBe(full2);
  }, 60_000);

  it("出口のアーカイブは、確かめて共有フォルダに展開する（分けたもの・足りないもの・壊れたもの）", async () => {
    process.env.SVWB_OUTBOX_MAX_MB = "0.002";
    await run();
    // 名前が ASCII でないファイルも入る（tar の PAX）
    writeFileSync(join(dir(), "メモ.txt"), "あいう");
    expect(await main(["wrap", "n1", "--root", root])).toBe(0);
    const box = join(tmp, "outbox", "n1");
    const files = readdirSync(box).sort();
    expect(files).toContain("案内.txt");
    const parts = files.filter((f) => f.endsWith(".tar.gz"));
    expect(parts.length).toBeGreaterThan(2);
    expect(readFileSync(join(box, "案内.txt"), "utf8")).toMatch(/^キューの出口: n1\n/);
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
  const body = { name: "branch-1-20261124", branch: "claude/x", commit: "0123456789ab", jobs: "night/t.txt" };
  it("書いて読み直すと同じ。指紋はジョブのファイルの中身と項目で変わる（2026-11-24 に出した券と同じ指紋）", () => {
    const t = makeTicket(body, "profile --games 2\n");
    expect(ticketText(t)).toBe(`svwb-queue-1 name=branch-1-20261124 branch=claude/x commit=0123456789ab jobs=night/t.txt plan=${t.plan}`);
    expect(t.plan).toBe("cc75e6283d6a");
    expect(parseTicket([ticketText(t)])).toEqual(t);
    expect(parseTicket(ticketText(t).split(" "))).toEqual(t);
    const u = makeTicket({ ...body, threads: 8, chunk: 15 }, "x");
    expect(parseTicket([ticketText(u)])).toEqual(u);
    expect(ticketPlan(body, "a")).not.toBe(ticketPlan(body, "b"));
    expect(ticketPlan(body, "a")).not.toBe(ticketPlan({ ...body, threads: 8 }, "a"));
  });
  it("形の違う券・前のやり方の券・止める時刻・読めない語・使えない値は断る", () => {
    const t = ticketText(makeTicket(body, "x"));
    expect(() => parseTicket(["svwb-queue-9", "name=a"])).toThrow(/git pull/);
    expect(() => parseTicket([t.replace("svwb-queue-1", "svwb-night-1")])).toThrow(/前のやり方の券/);
    expect(() => parseTicket(["compare", "10"])).toThrow(/券ではありません/);
    expect(() => parseTicket([t.replace(/ plan=/, " until=07:00 plan=")])).toThrow(/止める時刻/);
    expect(() => parseTicket([t.replace(/ plan=/, " tz=Asia/Tokyo plan=")])).toThrow(/止める時刻/);
    expect(() => parseTicket([`${t} extra=1`])).toThrow(/読めない語/);
    expect(() => parseTicket([t.replace("name=branch-1-20261124", "name=../x")])).toThrow(/name/);
    expect(() => parseTicket([t.replace("jobs=night/t.txt", "jobs=../t.txt")])).toThrow(/jobs/);
    expect(() => parseTicket([t.replace("commit=0123456789ab", "commit=0123")])).toThrow(/commit/);
    expect(() => parseTicket([t.replace(/ plan=\w+/, "")])).toThrow(/plan がありません/);
  });
  it("GitHub の URL を認証の要らない形にする", () => {
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
      expect(ticketHere(file, { name: "n" }, repo)).toEqual({ why: expect.stringContaining("コミットしていない") });
      gitT(repo, "add", ".");
      gitT(repo, "commit", "-q", "-m", "a");
      gitT(repo, "remote", "add", "origin", bare);
      expect(ticketHere(file, { name: "n" }, repo)).toEqual({ why: expect.stringContaining("push していない") });
      gitT(repo, "push", "-q", "origin", "claude/x");
      const r = ticketHere(file, { name: "n", threads: 8 }, repo);
      const full = gitT(repo, "rev-parse", "HEAD");
      expect(r).toEqual({ ticket: makeTicket({ name: "n", branch: "claude/x", commit: full.slice(0, 12), jobs: "night/t.txt", threads: 8 }, "profile --games 2\n") });
      writeFileSync(file, "profile --games 4\n");
      expect(ticketHere(file, { name: "n" }, repo)).toEqual({ why: expect.stringContaining("コミットしていない変更") });
      expect(ticketHere(join(tmp, "outside.txt"), { name: "n" }, repo)).toEqual({ why: expect.stringContaining("リポジトリの外") });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("回のソースの node_modules", () => {
  it("依存が同じなら /workspace を指し、組み立ての前に /workspace の依存が変わっていたら指すのをやめて npm ci", () => {
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
