// 前期のローテーションのクレストの能力（data/pools/azvaldt/crests.json）

import type { CardAbilities } from "../../../engine/dsl";
import {
  EVENT,
  FAITH_STACKS,
  OPP_LEADER,
  OWN_TURN,
  SELF_LEADER,
  addFaith,
  addLeaderMaxHp,
  addToHand,
  allyCards,
  allyFollowers,
  buff,
  buffDeck,
  combo,
  crestIdOf,
  damage,
  destroy,
  evolveIt,
  exists,
  grant,
  id,
  lastWords,
  onAllyAmuletDestroyed,
  onAllyAttack,
  onAllyDraw,
  onAllyEnter,
  onAllyEvolved,
  onAllyPlay,
  onAllyPlayEnhanced,
  onLeaderHealed,
  onTurnEnd,
  onTurnStart,
  oncePerOwnTurn,
  oppFollowers,
  random,
  randomOption,
  repeat,
  slot,
  specialId,
  summon,
  summonToOpponent,
  union,
  when,
} from "./helpers";

export const CRESTS: Record<string, CardAbilities> = {
  [crestIdOf("歩む《愚者》・リンクル")]: {
    abilities: [onAllyEnter({ ids: [id("歩む《愚者》・リンクル")] }, addLeaderMaxHp("opponent", -2))],
  },
  [crestIdOf("マナリアスクリプター・ティコ")]: {
    abilities: [onAllyPlay({ type: "spell", tribe: "マナリア" }, damage(OPP_LEADER, 1))],
  },
  // 相手が持つ（持ち主から見て「自分」）
  [crestIdOf("焦灰のアナテマ・バーンドナイト")]: {
    abilities: [onTurnStart(damage(SELF_LEADER, 2)), onLeaderHealed(damage(SELF_LEADER, 1))],
  },

  [crestIdOf("操嵩のアナテマ・ダストデイズ")]: {
    abilities: [onTurnEnd(when(combo(3), [buffDeck({ type: "follower" }, 1, 1)]))],
  },
  [crestIdOf("氷界の鹿王")]: { abilities: [onTurnEnd(when(combo(3), [addToHand("森の神秘")]))] },
  [crestIdOf("調和の舞手・ユエル＆ソシエ")]: {
    // プレイしたフォロワーがもう進化していても、そのターンの 1 回を使う（ユーザーの答え。docs/rules.md 12章の 36）
    abilities: [oncePerOwnTurn(onAllyPlay({ type: "follower" }, evolveIt(EVENT)))],
  },
  [crestIdOf("麗金花・ウンケイ")]: { abilities: [onTurnEnd(addToHand("輝く金貨"))] },

  // 信仰（エンジンではリーダーエリアのクレストの一種として持つ。docs/rules.md「12」）。
  // 「自分の信仰は「…」を持つ」で付く能力は、付いた数（FAITH_STACKS）だけ繰り返す
  [specialId("旧き天書・リアントース", "faith")]: {
    abilities: [onAllyAmuletDestroyed(addFaith("旧き天書・リアントース", 1))],
  },
  [specialId("旧き天槍・ササニド", "faith")]: {
    abilities: [
      onAllyEvolved(addFaith("旧き天槍・ササニド", 1)),
      onAllyEvolved(repeat(FAITH_STACKS, damage(OPP_LEADER, 1))),
    ],
  },
  [specialId("旧き天剣・イドメタ", "faith")]: {
    abilities: [
      onAllyPlayEnhanced(addFaith("旧き天剣・イドメタ", 1)),
      onAllyPlayEnhanced(repeat(FAITH_STACKS, buff(allyFollowers(), 1, 1))),
    ],
  },

  // ミッドレンジNi・実験体W・クキシロB
  [crestIdOf("イステンデッドVSマルチルゲート")]: {
    abilities: [
      onTurnEnd(
        when(exists(allyCards({ lastWords: true })), [
          random(allyCards({ lastWords: true }), 1, "a"),
          random(oppFollowers(), 1, "b"),
          destroy(union(slot("a"), slot("b"))),
        ]),
      ),
    ],
  },
  [crestIdOf("万術の咎人・セフィー")]: {
    abilities: [oncePerOwnTurn(onAllyEnter({ ids: [id("没入の実験体")] }, grant(EVENT, ["storm"])))],
  },
  [crestIdOf("魔恋の慕情・シイム")]: { abilities: [onAllyAttack({ ids: [id("天晶の魔手")] }, buff(EVENT, 1, 0))] },
  [crestIdOf("希望の光彩・リテュエル")]: {
    abilities: [lastWords(summon("希望の光彩・リテュエル", 1, "c"), evolveIt(slot("c")))],
  },
  [crestIdOf("霧巻花・クキシロ")]: {
    abilities: [
      onAllyDraw(
        { costIn: [1, 3, 5] },
        when(OWN_TURN, [randomOption([summon("清純なる白狐")], [summon("ホーリーファルコン")])]),
      ),
      onAllyDraw(
        { costIn: [2, 4, 6] },
        when(OWN_TURN, [randomOption([summonToOpponent("清純なる白狐")], [summonToOpponent("ホーリーファルコン")])]),
      ),
    ],
  },
};
