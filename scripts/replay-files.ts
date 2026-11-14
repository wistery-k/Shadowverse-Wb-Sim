// 開発サーバー（npm run dev）だけで、手元のフォルダにある試合の記録（「リプレイ検索」タブで読むファイル）の一覧と中身を配る（vite.config.ts）。
// 公開サイト（vite build）には入らない（画面のモジュールも devOnlyModules で置き換える）。
//
// 探すフォルダは環境変数 SVWB_REPLAY_DIRS（区切りは Linux・macOS は「:」、Windows は「;」）。無ければ ~/svwb-data と、リポジトリの replays/。
// その下（深さ 6 まで）の .json・.jsonl・.json.gz・.jsonl.gz のうち、始めの部分が試合の記録らしいもの（"seed"・"decks"・"actions" があり、
// 自己対戦の学習用の "samples" が無い）を一覧に出す。中身は、一覧に出せるファイルだけを、そのまま（gzip も展開せずに）返す。
//
//   GET /__svwb/replays/list           → { roots: [フォルダ], files: [{ path, root, rel, size, mtime }] }
//   GET /__svwb/replays/file?path=...  → ファイルの中身

import { closeSync, createReadStream, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { constants, gunzipSync } from "node:zlib";
import type { Plugin } from "vite";
import { REPLAY_API, type ReplayFileEntry, type ReplayFileList } from "../src/replays/api.ts";

const FILE_RE = /\.jsonl?(\.gz)?$/i;
const MAX_DEPTH = 6;
const MAX_FILES = 20_000;
const HEAD_BYTES = 256 * 1024;

const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** 探すフォルダ（あるものだけ） */
export function replayRoots(env: NodeJS.ProcessEnv = process.env, repo: string = process.cwd()): string[] {
  const raw = env.SVWB_REPLAY_DIRS;
  const list = raw
    ? raw
        .split(delimiter)
        .map((s) => s.trim())
        .filter((s) => s !== "")
    : [join(homedir(), "svwb-data"), join(repo, "replays")];
  const roots: string[] = [];
  for (const p of list) {
    const abs = resolve(expandHome(p));
    try {
      if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
      const real = realpathSync(abs);
      if (!roots.includes(real)) roots.push(real);
    } catch {
      // 読めないフォルダは飛ばす
    }
  }
  return roots;
}

/** ファイルの始めの部分が試合の記録らしいか */
export function looksLikeReplays(head: string): boolean {
  return head.includes('"actions"') && head.includes('"seed"') && head.includes('"decks"') && !head.includes('"samples"');
}

function readHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const gz = /\.gz$/i.test(path);
    const buf = Buffer.alloc(gz ? HEAD_BYTES / 4 : HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const raw = buf.subarray(0, n);
    // 途中までの gzip も、展開できたところまで読む
    const bytes = gz ? gunzipSync(raw, { finishFlush: constants.Z_SYNC_FLUSH }) : raw;
    return bytes.subarray(0, HEAD_BYTES).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** p が roots のどれかの下にあるか（シンボリックリンクはたどった先で比べる） */
export function insideRoots(p: string, roots: readonly string[]): boolean {
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    return false;
  }
  return roots.some((r) => {
    const rel = relative(r, real);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
}

/** 一覧を作る。始めの部分を調べた結果は、パス・大きさ・更新時刻が同じなら覚えておいたものを使う */
function listFiles(roots: readonly string[], cache: Map<string, boolean>): ReplayFileEntry[] {
  const out: ReplayFileEntry[] = [];
  let budget = MAX_FILES;
  const walk = (root: string, dir: string, depth: number) => {
    if (depth > MAX_DEPTH || budget <= 0) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(root, p, depth + 1);
      } else if (e.isFile() && FILE_RE.test(e.name)) {
        if (--budget <= 0) return;
        try {
          const st = statSync(p);
          const key = `${p}\n${st.size}\n${st.mtimeMs}`;
          let ok = cache.get(key);
          if (ok === undefined) {
            ok = st.size > 0 && looksLikeReplays(readHead(p));
            cache.set(key, ok);
          }
          if (ok) out.push({ path: p, root, rel: relative(root, p), size: st.size, mtime: st.mtimeMs });
        } catch {
          // 読めないファイルは飛ばす
        }
      }
    }
  };
  for (const root of roots) walk(root, root, 0);
  return out;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** 開発サーバーに一覧と中身を配るミドルウェアを足すプラグイン */
export function replayFiles(): Plugin {
  const cache = new Map<string, boolean>();
  return {
    name: "svwb-replay-files",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(REPLAY_API, (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const roots = replayRoots();
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "GET だけです" });
        } else if (url.pathname === "/list") {
          const body: ReplayFileList = { roots, files: listFiles(roots, cache) };
          sendJson(res, 200, body);
        } else if (url.pathname === "/file") {
          const path = url.searchParams.get("path") ?? "";
          if (!FILE_RE.test(path) || !insideRoots(path, roots)) {
            sendJson(res, 403, { error: `一覧に出せるファイルではありません: ${path}` });
            return;
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Cache-Control", "no-store");
          createReadStream(path)
            .on("error", (e) => {
              if (!res.headersSent) sendJson(res, 500, { error: String(e) });
              else res.destroy(e);
            })
            .pipe(res);
        } else {
          sendJson(res, 404, { error: `不明な場所: ${url.pathname}` });
        }
      });
    },
  };
}

/** 開発サーバーだけのモジュール（vite build では中身を読まず、何も表示しないものに置き換える） */
export const DEV_ONLY_MODULES: Record<string, string> = {
  // リプレイ検索の画面。Worker（src/replays/worker.ts）と CSS ごと公開サイトに入れない
  "/src/ui/ReplaySearch.tsx": "export function ReplaySearch() { return null; }",
  // 試合の記録の画面。前期のローテーションのカード・プロのデッキ（src/record/）と CSS ごと公開サイトに入れない（CLAUDE.md の試合の記録の条件）
  "/src/ui/MatchRecord.tsx": "export function MatchRecord() { return null; }",
};

/**
 * vite build で、開発サーバーだけのモジュールを置き換えるプラグイン
 * （App.tsx の REPLAY_SEARCH・MATCH_RECORD が false なので使われない）
 */
export function devOnlyModules(): Plugin {
  return {
    name: "svwb-dev-only-modules",
    apply: "build",
    enforce: "pre",
    load(id) {
      const path = id.split("?")[0]!.replace(/\\/g, "/");
      for (const [suffix, code] of Object.entries(DEV_ONLY_MODULES)) if (path.endsWith(suffix)) return code;
      return null;
    },
  };
}
