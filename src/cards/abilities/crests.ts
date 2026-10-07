// クレストの能力（data/crests.json）

import type { CardAbilities } from "../../engine/dsl";
import {
  BOTH_LEADERS,
  EVENT,
  SELF_LEADER,
  crestIdOf,
  damage,
  draw,
  earthRite,
  grant,
  heal,
  lastWords,
  onAllyEnter,
  onLeaderHealed,
  onTurnEnd,
  onTurnStart,
  slot,
  summon,
  when,
} from "./helpers";

export const CRESTS: Record<string, CardAbilities> = {
  [crestIdOf("自然の妖精姫・アリア")]: {
    abilities: [onAllyEnter({ type: "follower", tribe: "妖精" }, grant(EVENT, ["storm"]))],
  },
  [crestIdOf("常在戦場・カゲミツ")]: { abilities: [lastWords(summon("常在戦場・カゲミツ"))] },
  [crestIdOf("黎明の錬金術師・ノノ")]: {
    abilities: [onTurnEnd(earthRite(1, summon("ガーディアンゴーレム")))],
  },
  [crestIdOf("灼熱のアナテマ・バーンドナイト")]: {
    abilities: [onTurnStart(damage(SELF_LEADER, 1)), onLeaderHealed(damage(SELF_LEADER, 1))],
  },
  [crestIdOf("闇の賞金稼ぎ・バルト")]: { abilities: [onTurnEnd(damage(BOTH_LEADERS, 1))] },
  [crestIdOf("大いなる熾天使・ラピス")]: {
    abilities: [lastWords(summon("大いなる熾天使・ラピス", 1, "l"), grant(slot("l"), ["storm"]))],
  },
  [crestIdOf("新たなる少女・エース")]: {
    abilities: [onTurnEnd(when({ kind: "handCount", atMost: 5 }, [draw(1)], [heal(1)]))],
  },
};
