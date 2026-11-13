// 前期のローテーション（data/pools/azvaldt/）にしか無いカード・クレストの能力定義（カードIDをキーにする）。
// スターターと同じ ID のカード（ベーシックとトークン）は、スターターの定義（../index.ts）を共有するので、ここには書かない。
// エンジンには、スターターの定義の後に読ませる（scripts/rust-data-main.ts の poolCardAbilities・poolCrestAbilities）。
// カード名は ./helpers.ts の id() で引く（スターターの ../helpers.ts の id() はスターターのカードから引くので、
// 同じ名前のストームブラスト 10131320 と 10831310 を取り違えないように）。
// 今はプロのデッキのスペルW・アグロNi で使うカードだけ（docs/pools/azvaldt.md「段取り」）。

import type { CardAbilities } from "../../../engine/dsl";
import { CRESTS } from "./crests";
import { NEUTRAL } from "./neutral";
import { NIGHTMARE } from "./nightmare";
import { WITCH } from "./witch";

export { id } from "./helpers";

export const AZVALDT_CARD_ABILITIES: Readonly<Record<string, CardAbilities>> = {
  ...NEUTRAL,
  ...WITCH,
  ...NIGHTMARE,
};

export const AZVALDT_CREST_ABILITIES: Readonly<Record<string, CardAbilities>> = CRESTS;
