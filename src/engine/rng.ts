// シード付き乱数（mulberry32）。状態は uint32 1つで、GameState に入れてシリアライズできる。

/** 乱数を1つ生成し、[0, 1) の値と次の状態を返す */
export function nextRandom(state: number): [value: number, next: number] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

/** 32 ビットの値をよく混ぜる（lowbias32） */
function mix32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * いくつかの値（uint32）から乱数の種を作る（同じ並びなら同じ種）。AI の思考用の乱数を、取った順番でなく用途から作るのに使う
 * （rust/engine/src/ai/mod.rs の seed_of と同じ）
 */
export function seedOf(parts: readonly number[]): number {
  let h = 0x811c9dc5;
  for (const x of parts) h = (mix32((h ^ x) >>> 0) + 0x9e3779b9) >>> 0;
  return mix32(h);
}

/** 可変な乱数源（AI・デッキの生成等） */
export interface Rng {
  /** [0, n) の整数 */
  int(n: number): number;
  /** 今の状態（WASM の AI に渡し、使った分だけ進めた状態を書き戻す） */
  state: number;
}

export function rngFrom(holder: { rng: number }): Rng {
  return {
    int(n) {
      const [v, next] = nextRandom(holder.rng);
      holder.rng = next;
      return Math.floor(v * n);
    },
    get state() {
      return holder.rng;
    },
    set state(v: number) {
      holder.rng = v >>> 0;
    },
  };
}

/** Fisher-Yates でその場でシャッフルする */
export function shuffle<T>(arr: T[], rng: Rng): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
  }
}
