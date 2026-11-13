// 前期のローテーションのニュートラルのカード能力

import type { CardAbilities } from "../../../engine/dsl";
import {
  PLAYED_COST,
  allyFollowers,
  boardCards,
  buff,
  choose,
  countdown,
  damage,
  draw,
  exists,
  fanfare,
  id,
  lastWords,
  mode,
  onAllyPlay,
  oppFollowers,
  random,
  slot,
  spell,
  when,
} from "./helpers";

export const NEUTRAL: Record<string, CardAbilities> = {
  [id("大遊戯世界")]: {
    abilities: [
      // 「場にそれ以外の元のコストXのカード」は両方の場で見る（Q&A。docs/rules.md 12章）。これ自身も数える（ユーザー確認済み。docs/rules.md 12章の 29）
      onAllyPlay({}, when(exists(boardCards({ costEq: PLAYED_COST, excludeEvent: true })), [countdown(-1)])),
      lastWords(draw(2)),
    ],
  },
  [id("相承の意思")]: {
    abilities: [
      spell(
        mode(
          [random(oppFollowers()), damage(slot(), 3)],
          [{ op: "reanimate", cost: 2 }],
          [buff(allyFollowers(), 1, 0)],
        ),
      ),
    ],
  },
  [id("最古の獄卒")]: {
    abilities: [
      fanfare(
        choose(oppFollowers()),
        damage(slot(), 6),
        random(oppFollowers({ excludeSlot: "t" }), 1, "r"),
        damage(slot("r"), 2),
      ),
    ],
    unimplemented: "アクセラレート（コスト1「相手の場のフォロワーからランダム1枚に2ダメージ。」）",
  },
  [id("達筆の怪異")]: {
    abilities: [fanfare(when(exists(boardCards({ costEq: 1, excludeSelf: true })), [buff({ kind: "this" }, 1, 1)]))],
  },
};
