// 夜のキューの回す係（pueue。https://github.com/Nukesor/pueue）とのやり取り。運用は docs/night.md「積むキュー（pueue）」。
//
// - 区切りを 1 つずつ pueue の task にして、組 svwb（同時に 1 つ）に積む。止める時刻は組 svwb-ctl（同時にいくつでも）の、時刻を決めた task
// - どこまで済んだかは、今までどおり回のフォルダの印（done/）で決める。pueue は流すだけ（pueue の状態が消えても、同じ券を積み直せば続きから）
// - task は名前（label）の頭の 2 語（回の名前と役目）で見分ける。pueue の番号は clean の後に使い回されるので、番号だけでは見分けない
// - pueue の場所は環境変数 SVWB_PUEUE（試す用。既定は PATH の pueue）。設定は pueue の PUEUE_CONFIG_PATH

import { spawnSync } from "node:child_process";

/** 区切りを回す組（同時に 1 つ） */
export const QUEUE_GROUP = "svwb";
/** 止める時刻などを決めた時刻に流す組（同時にいくつでも） */
export const CTL_GROUP = "svwb-ctl";
/** 止める時刻の task の名前の頭 */
export const STOP_LABEL = "止める時刻";

export const pueueBin = (): string => process.env.SVWB_PUEUE || "pueue";

/** task の様子（pueue の TaskStatus と、済んだものは TaskResult を 1 語にしたもの） */
export type TaskState =
  | "Queued"
  | "Stashed"
  | "Running"
  | "Paused"
  | "Locked"
  | "Success"
  | "Failed"
  | "Killed"
  | "DependencyFailed"
  | "FailedToSpawn"
  | "Errored";

export interface PTask {
  id: number;
  label: string;
  group: string;
  state: TaskState;
  /** 始めた時刻（ミリ秒。回していない・まだのときは null） */
  start: number | null;
  /** 時刻を決めて積んだ task の、積まれる時刻（ミリ秒） */
  enqueueAt: number | null;
  dependencies: number[];
}

export interface PStatus {
  tasks: PTask[];
  groups: Record<string, { status: string; parallel: number }>;
}

/** まだ終わっていない（これから回る・回っている・止めてある）か */
export const isLive = (s: TaskState): boolean => s === "Queued" || s === "Stashed" || s === "Running" || s === "Paused" || s === "Locked";

/** pueue を流す（失敗したら、pueue の言ったことで投げる） */
export function pq(args: string[]): string {
  const r = spawnSync(pueueBin(), ["--color", "never", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.error !== undefined) {
    throw new Error(`pueue を流せません（${r.error.message}）。コンテナのイメージに pueue が入っているか（docker compose up -d --build）を確かめます`);
  }
  if (r.status !== 0) {
    const said = `${r.stderr}\n${r.stdout}`.trim();
    if (/connect|socket|daemon/i.test(said)) {
      throw new Error(`pueue のデーモン（pueued）につながりません: ${said}\nコンテナを作り直してから（ホストで docker compose up -d）もう一度流します`);
    }
    throw new Error(`pueue ${args[0] ?? ""} が失敗しました: ${said}`);
  }
  return r.stdout;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const ms = (x: unknown): number | null => (typeof x === "string" && x !== "" ? Date.parse(x) : null);

/** pueue status --json の task の様子を 1 語にする */
export function taskState(status: unknown): { state: TaskState; start: number | null; enqueueAt: number | null } {
  if (typeof status === "string") return { state: status as TaskState, start: null, enqueueAt: null };
  if (!isObj(status)) throw new Error(`pueue の task の様子が読めません: ${JSON.stringify(status)}`);
  const [k, v] = Object.entries(status)[0] ?? ["", null];
  const body = isObj(v) ? v : {};
  if (k === "Done") {
    const r = body.result;
    const result = typeof r === "string" ? r : isObj(r) ? (Object.keys(r)[0] ?? "Errored") : "Errored";
    return { state: result as TaskState, start: ms(body.start), enqueueAt: null };
  }
  return { state: k as TaskState, start: ms(body.start), enqueueAt: ms(body.enqueue_at) };
}

/** pueue status --json を読む */
export function parseStatus(text: string): PStatus {
  const d = JSON.parse(text) as unknown;
  if (!isObj(d) || !isObj(d.tasks) || !isObj(d.groups)) throw new Error("pueue status --json の形が違います");
  const tasks: PTask[] = Object.values(d.tasks).flatMap((t) => {
    if (!isObj(t) || typeof t.id !== "number") return [];
    return [
      {
        id: t.id,
        label: typeof t.label === "string" ? t.label : "",
        group: typeof t.group === "string" ? t.group : "default",
        ...taskState(t.status),
        dependencies: Array.isArray(t.dependencies) ? t.dependencies.filter((x): x is number => typeof x === "number") : [],
      },
    ];
  });
  const groups: PStatus["groups"] = {};
  for (const [name, g] of Object.entries(d.groups)) {
    if (isObj(g)) groups[name] = { status: String(g.status), parallel: Number(g.parallel_tasks) };
  }
  return { tasks: tasks.sort((x, y) => x.id - y.id), groups };
}

export const pueueStatus = (): PStatus => parseStatus(pq(["status", "--json"]));

/** 組 svwb・svwb-ctl が無ければ作る。作ったばかりの svwb は止めておく（積んだだけで回り始めないように） */
export function ensureGroups(): PStatus {
  let st = pueueStatus();
  if (st.groups[QUEUE_GROUP] === undefined) {
    pq(["group", "add", QUEUE_GROUP, "--parallel", "1"]);
    pq(["pause", "--group", QUEUE_GROUP]);
  }
  if (st.groups[CTL_GROUP] === undefined) pq(["group", "add", CTL_GROUP, "--parallel", "0"]);
  st = pueueStatus();
  return st;
}

/** task を積む（番号を返す）。command はシェルの 1 行（pueue は sh -c で流す） */
export function addTask(o: { group: string; label: string; command: string; cwd: string; after?: number[]; delaySec?: number }): number {
  const args = ["add", "--print-task-id", "--group", o.group, "--label", o.label, "--working-directory", o.cwd];
  for (const id of o.after ?? []) args.push("--after", String(id));
  if (o.delaySec !== undefined) args.push("--delay", String(Math.max(1, Math.ceil(o.delaySec))));
  args.push("--", o.command);
  const out = pq(args).trim();
  const id = Number(out);
  if (!Number.isInteger(id) || id < 0) throw new Error(`pueue add が番号を返しません: ${out}`);
  return id;
}

/** task の名前: 「<回の名前> <役目> <書き添え>」。回の名前と役目には空白が無い */
export const taskLabel = (run: string, role: string, note: string): string => `${run} ${role}${note === "" ? "" : ` ${note}`}`;

/** task の名前から回の名前と役目を読む（夜のキューの task でなければ null） */
export function labelOf(label: string): { run: string; role: string } | null {
  const [run, role] = label.split(" ");
  return run !== undefined && role !== undefined && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(run) ? { run, role } : null;
}
