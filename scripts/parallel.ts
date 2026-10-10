// 自動対戦などの独立した仕事を、CPU のコア数だけ worker_threads で並列に行う（Node のスクリプト専用）。
//
// scripts/vite-run.mjs で実行したスクリプトの中で使う。Worker はスクリプトの main を親と同じ引数でもう一度呼び、
// parallelMap に来たところで「親から渡された番号の仕事をして結果を返す」処理に切り替わる。そのため、
// - parallelMap は 1 回の実行で 1 回だけ、毎回同じ items で呼ぶ（引数から決まる仕事の一覧にする）
// - parallelMap より前に画面への出力などの副作用を置かない（置くときは isParallelWorker で親だけにする）
// 結果は items と同じ順に並ぶ。各仕事がシードで決まっていれば、並列数によらず同じ結果になる。
// 並列数は環境変数 THREADS（既定は CPU のコア数。1 なら並列にしない）。

import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker } from "node:worker_threads";

interface ViteRun {
  runner: string;
  bundle: string;
  argv: string[];
}

const viteRun = (): ViteRun | undefined => (globalThis as { __viteRun?: ViteRun }).__viteRun;

/** 並列実行の Worker の中か（親だけで行う出力等の判定に使う） */
export const isParallelWorker = !isMainThread && viteRun() !== undefined;

/** 並列数（環境変数 THREADS、既定は CPU のコア数） */
export function threadCount(): number {
  const n = Number(process.env.THREADS ?? availableParallelism());
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

type Reply<R> = { index: number; ok: true; value: R } | { index: number; ok: false; error: string };

/**
 * items の各要素に run を適用した結果を、items と同じ順で返す（並列に行う）。
 * onProgress は親で、仕事が 1 つ終わるたびに呼ばれる
 */
export async function parallelMap<T, R>(
  items: readonly T[],
  run: (item: T, index: number) => R,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  if (isParallelWorker) {
    const port = parentPort;
    if (!port) throw new Error("parentPort がありません");
    port.on("message", (index: number) => {
      let reply: Reply<R>;
      try {
        reply = { index, ok: true, value: run(items[index] as T, index) };
      } catch (e) {
        reply = { index, ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) };
      }
      port.postMessage(reply);
    });
    // Worker の main はここで止まり、親が終了させる
    return new Promise<R[]>(() => {});
  }

  const results: R[] = new Array<R>(items.length);
  const ctx = viteRun();
  const threads = Math.min(threadCount(), items.length);
  if (!ctx || threads <= 1) {
    for (const [i, item] of items.entries()) {
      results[i] = run(item, i);
      onProgress?.(i + 1, items.length);
    }
    return results;
  }

  let next = 0;
  let done = 0;
  const workers: Worker[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      for (let t = 0; t < threads; t++) {
        const worker = new Worker(new URL(ctx.runner), { workerData: { viteRun: ctx } });
        workers.push(worker);
        const feed = () => {
          if (next < items.length) worker.postMessage(next++);
        };
        worker.on("message", (reply: Reply<R>) => {
          if (!reply.ok) {
            reject(new Error(`仕事 ${reply.index} でエラー: ${reply.error}`));
            return;
          }
          results[reply.index] = reply.value;
          done++;
          onProgress?.(done, items.length);
          if (done === items.length) resolve();
          else feed();
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (done < items.length) reject(new Error(`Worker が終了しました（終了コード ${code}）`));
        });
        feed();
      }
    });
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  return results;
}
