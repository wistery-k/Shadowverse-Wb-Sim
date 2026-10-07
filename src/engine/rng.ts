// シード付き乱数（mulberry32）。状態は uint32 1つで、GameState に入れてシリアライズできる。

/** 乱数を1つ生成し、[0, 1) の値と次の状態を返す */
export function nextRandom(state: number): [value: number, next: number] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

/** 可変な乱数源。エンジン内部で GameState.rng を読み書きするために使う。 */
export interface Rng {
  /** [0, n) の整数 */
  int(n: number): number;
}

export function rngFrom(holder: { rng: number }): Rng {
  return {
    int(n) {
      const [v, next] = nextRandom(holder.rng);
      holder.rng = next;
      return Math.floor(v * n);
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
