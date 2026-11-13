// 前期のローテーションのクレストの能力（data/pools/azvaldt/crests.json）

import type { CardAbilities } from "../../../engine/dsl";
import {
  EVENT,
  FAITH_STACKS,
  OPP_LEADER,
  SELF_LEADER,
  addFaith,
  addLeaderMaxHp,
  addToHand,
  allyFollowers,
  buff,
  buffDeck,
  combo,
  crestIdOf,
  damage,
  evolveIt,
  id,
  onAllyAmuletDestroyed,
  onAllyEnter,
  onAllyEvolved,
  onAllyPlay,
  onAllyPlayEnhanced,
  onLeaderHealed,
  onTurnEnd,
  onTurnStart,
  oncePerOwnTurn,
  repeat,
  specialId,
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
};
