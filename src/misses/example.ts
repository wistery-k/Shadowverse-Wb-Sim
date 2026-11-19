// 問の手順のうち「一例」の手を見分ける（問題集のページ src/ui/Misses.tsx が色を変えて注釈を添える。docs/misses.md「手順の候補」）。
// 問の局面は実際の試合の局面なので、山札の順番と乱数の状態は 1 通りに決まっている。手順を打った後の局面はその 1 通りでの結果で、
// 山札から引いたカードやランダムな結果が違えば変わる。カードの能力を推測せず、エンジンが返した局面から求める:
// - 引いたカード: 問の局面で山札にあったカード（両方の席）を指す手（引いたカード・山札から出たカードを使う手）。
//   引いたカードを指さない手は、引いた後でも一例にしない
// - ランダムの後: 手を打つ前と後で局面の乱数の状態（rng）が変わり、乱数を変えて同じ手を打ち直すと、山札の順番と
//   山札から手札に入ったカードのほかにも違いが出る手（ランダムな結果が出た手）。その後の手はみな一例。
//   山札を混ぜただけ・山札からランダムに手札に加えただけの手は、ランダムの後にしない（後で引いたカードを使う手が一例になる）
// - 考え直した手: 調査で読んだ並びを問の局面で打ちきれず、AI が考え直して打った手（並びの rethink から後。みな一例）

import { actingPlayer, tryApplyAction } from "../engine/game";
import type { Action, GameState } from "../engine/types";

export type ExampleKind = "draw" | "random" | "rethink";

export interface StepNote {
  /** 一例の手か（null ならそうでない） */
  example: ExampleKind | null;
  /** この手で、問の局面で山札にあったカードが手札に入った（引いたカード。打った席のもの） */
  drew: number[];
  /** この手でランダムな結果が出た */
  random: boolean;
}

/** 手が指すカード（iid） */
export function actionIids(a: Action): number[] {
  switch (a.type) {
    case "play":
    case "evolve":
    case "superEvolve":
    case "act":
      return [a.iid];
    case "attack":
      return a.target === "leader" ? [a.attacker] : [a.attacker, a.target];
    case "fuse":
      return [a.host, ...a.materials];
    case "choose":
      return [...a.targets];
    case "mulligan":
      return [...a.swap];
    case "mode":
    case "extraPp":
    case "endTurn":
      return [];
  }
}

/** 乱数を変えて打ち直したときに比べる形（乱数・山札・手札の記録を除き、山札から手札に入ったカードは中身を見ない） */
function settled(s: GameState, inDeck: ReadonlySet<number>): string {
  return JSON.stringify({
    ...s,
    rng: 0,
    players: s.players.map((pl) => ({
      ...pl,
      deck: pl.deck.length,
      handLog: null,
      hand: pl.hand.map((h) => (inDeck.has(h.iid) ? "deck" : h)),
    })),
  });
}

/** 打ち直すときの乱数の状態（決まった値） */
const ALT_RNG = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];

/** before で a を打った結果 after が、乱数によって山札・引いたカードのほかにも変わるか */
function randomResult(before: GameState, a: Action, after: GameState, inDeck: ReadonlySet<number>): boolean {
  if (after.rng === before.rng) return false;
  const base = settled(after, inDeck);
  for (const x of ALT_RNG) {
    const alt = tryApplyAction({ ...before, rng: (before.rng ^ x) >>> 0 }, a);
    if (!alt || settled(alt, inDeck) !== base) return true;
  }
  return false;
}

/**
 * 手順の手ごとの注釈。states[k] は actions[k] を打つ前の局面（states[0] が問の局面。打った後の局面が無い手は、そこで止める）。
 * rethink は AI が考え直した最初の手の番号（無ければ null）。「ターン終了」は一例にしない（手順の終わりを示すだけ）
 */
export function stepNotes(states: readonly GameState[], actions: readonly Action[], rethink: number | null = null): StepNote[] {
  const start = states[0];
  if (!start) return [];
  const inDeck = new Set<number>();
  for (const pl of start.players) for (const c of pl.deck) inDeck.add(c.iid);
  const notes: StepNote[] = [];
  let afterRandom = false;
  for (const [k, a] of actions.entries()) {
    const before = states[k];
    const after = states[k + 1];
    if (!before) break;
    const example: ExampleKind | null =
      a.type === "endTurn"
        ? null
        : rethink !== null && k >= rethink
          ? "rethink"
          : afterRandom
            ? "random"
            : actionIids(a).some((iid) => inDeck.has(iid))
              ? "draw"
              : null;
    const random = after !== undefined && randomResult(before, a, after, inDeck);
    const drew: number[] = [];
    if (after) {
      const p = actingPlayer(before);
      const had = new Set(before.players[p].hand.map((h) => h.iid));
      for (const h of after.players[p].hand) if (!had.has(h.iid) && inDeck.has(h.iid)) drew.push(h.iid);
    }
    notes.push({ example, drew, random });
    if (random) afterRandom = true;
  }
  return notes;
}
