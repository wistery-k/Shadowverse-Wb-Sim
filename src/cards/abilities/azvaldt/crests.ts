// 前期のローテーションのクレストの能力（data/pools/azvaldt/crests.json）

import type { CardAbilities } from "../../../engine/dsl";
import { OPP_LEADER, addLeaderMaxHp, crestIdOf, damage, id, onAllyEnter, onAllyPlay } from "./helpers";

export const CRESTS: Record<string, CardAbilities> = {
  [crestIdOf("歩む《愚者》・リンクル")]: {
    abilities: [onAllyEnter({ ids: [id("歩む《愚者》・リンクル")] }, addLeaderMaxHp("opponent", -2))],
  },
  [crestIdOf("マナリアスクリプター・ティコ")]: {
    abilities: [onAllyPlay({ type: "spell", tribe: "マナリア" }, damage(OPP_LEADER, 1))],
  },
};
