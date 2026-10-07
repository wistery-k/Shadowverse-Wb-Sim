// テスト・自己対戦用のデッキ生成

import { ALL_CARDS, DECK_SIZE, MAX_COPIES, STARTER, type ClassId } from "../cards";
import { shuffle, type Rng } from "../engine";

/** 指定クラスのスターターの合法なデッキをランダムに作る */
export function randomDeck(deckClass: Exclude<ClassId, "neutral">, rng: Rng): string[] {
  const candidates = ALL_CARDS.filter(
    (c) => STARTER.sets.includes(c.set) && (c.class === deckClass || c.class === "neutral"),
  );
  const pool = candidates.flatMap((c) => Array.from({ length: MAX_COPIES }, () => c.id));
  shuffle(pool, rng);
  return pool.slice(0, DECK_SIZE);
}
