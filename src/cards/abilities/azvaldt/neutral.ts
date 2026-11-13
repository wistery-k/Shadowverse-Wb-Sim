// 前期のローテーションのニュートラルのカード能力

import type { CardAbilities } from "../../../engine/dsl";
import {
  ENHANCED,
  OPP_LEADER,
  OUGI,
  PLAYED_COST,
  allFollowers,
  allyFollowers,
  banish,
  banishCrests,
  boardCards,
  buff,
  choose,
  countdown,
  damage,
  destroy,
  discard,
  draw,
  evolveIt,
  exists,
  fanfare,
  gainPp,
  handCards,
  id,
  lastWords,
  mode,
  onAllyPlay,
  onTurnEnd,
  oppFollowers,
  random,
  slot,
  specialId,
  spell,
  union,
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
  },
  [specialId("最古の獄卒", "accelerate")]: { abilities: [spell(random(oppFollowers()), damage(slot(), 2))] },
  [id("空の命運を握る少女・ルリア")]: {
    abilities: [fanfare(when(ENHANCED, [draw(1, { type: "follower", costMin: 7 }), gainPp(7)]))],
  },
  [id("暗黒次元")]: { abilities: [onTurnEnd(damage(allFollowers({ notTribe: "アサイラント" }), 2))] },
  [id("アルビオンバハムート")]: {
    abilities: [
      fanfare(
        mode(
          [banish(allFollowers({ excludeSelf: true }))],
          [banish(boardCards({ type: "amulet" }))],
          [banishCrests("both")],
        ),
      ),
    ],
  },
  [id("《世界》の提示")]: {
    abilities: [
      spell(
        draw(2),
        random({ kind: "maxAttack", of: oppFollowers() }),
        destroy(slot()),
        when(ENHANCED, [damage(union(oppFollowers(), OPP_LEADER), 4)]),
      ),
    ],
  },
  [id("達筆の怪異")]: {
    abilities: [fanfare(when(exists(boardCards({ costEq: 1, excludeSelf: true })), [buff({ kind: "this" }, 1, 1)]))],
  },
  [id("蒼い空を征く騎空士・グラン＆ジータ")]: {
    abilities: [
      fanfare(
        mode([random(oppFollowers()), damage(slot(), 5)], [draw(2, { type: "follower" })]),
        when(OUGI, [evolveIt()]),
      ),
    ],
  },
  [id("享楽の上位市民")]: { abilities: [fanfare(choose(handCards()), discard(slot()), damage(oppFollowers(), 2))] },
};
