// 打ち比べ・自動対戦で使う Web Worker の数と、仕事の配り方。
// 仕事は 1 つずつ渡し、終わった Worker に次を渡す（先に終わった Worker が遊ばない）。

/** Worker の数の上限（1 本ごとに WASM とモデルを読み込むので、メモリのために上限を置く） */
export const MAX_WORKERS = 24;

/** 使う Worker の数: 論理コア数 − 1（画面の分を 1 つ残す）。仕事の数と上限を超えない */
export function workerCount(jobs: number): number {
  return Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 4) - 1, jobs));
}

export interface PoolOptions<J, M> {
  create: () => Worker;
  jobs: readonly J[];
  /** 1 つの仕事を Worker に渡すメッセージ */
  request: (job: J) => unknown;
  /** Worker がその仕事を終えたことを表すメッセージか */
  isDone: (msg: M) => boolean;
  /** 終わり以外のメッセージ（結果・エラー） */
  onMessage: (msg: M) => void;
  /** すべての仕事が終わった */
  onFinish: () => void;
}

/**
 * jobs を Worker に 1 つずつ配る。Worker は 1 つのメッセージを処理し終えると isDone のメッセージを返すこと。
 * 返した Worker をすべて terminate すれば途中で止まる（そのとき onFinish は呼ばない）。
 */
export function runPool<J, M>(o: PoolOptions<J, M>): Worker[] {
  const count = workerCount(o.jobs.length);
  let next = 0;
  let finished = 0;
  const workers: Worker[] = [];
  for (let i = 0; i < count; i++) {
    const worker = o.create();
    const feed = () => {
      const job = o.jobs[next];
      if (next < o.jobs.length && job !== undefined) {
        next++;
        worker.postMessage(o.request(job));
      } else {
        worker.terminate();
        if (++finished === count) o.onFinish();
      }
    };
    worker.onmessage = (e: MessageEvent<M>) => {
      if (o.isDone(e.data)) feed();
      else o.onMessage(e.data);
    };
    workers.push(worker);
    feed();
  }
  return workers;
}
