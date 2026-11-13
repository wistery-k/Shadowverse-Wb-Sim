// 前期のローテーションのクレストの能力（data/pools/azvaldt/crests.json）

import type { CardAbilities } from "../../../engine/dsl";
import {
  OPP_LEADER,
  SELF_LEADER,
  addFaith,
  addLeaderMaxHp,
  crestIdOf,
  damage,
  id,
  onAllyAmuletDestroyed,
  onAllyEnter,
  onAllyPlay,
  onLeaderHealed,
  onTurnStart,
  specialId,
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

  // 信仰（エンジンではリーダーエリアのクレストの一種として持つ。docs/rules.md「12」）
  [specialId("旧き天書・リアントース", "faith")]: {
    abilities: [onAllyAmuletDestroyed(addFaith("旧き天書・リアントース", 1))],
  },
};
