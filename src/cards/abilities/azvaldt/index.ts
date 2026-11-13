// 前期のローテーション（data/pools/azvaldt/）にしか無いカード・クレストの能力定義（カードIDをキーにする）。
// スターターと同じ ID のカード（ベーシックとトークン）は、スターターの定義（../index.ts）を共有するので、ここには書かない。
// エンジンには、スターターの定義の後に読ませる（scripts/rust-data-main.ts の poolCardAbilities・poolCrestAbilities）。
// カード名は ./helpers.ts の id() で引く（スターターの ../helpers.ts の id() はスターターのカードから引くので、
// 同じ名前のストームブラスト 10131320 と 10831310 を取り違えないように）。
// アクセラレート・結晶の姿の能力はその ID（specials.json）に、信仰の能力はクレストと同じ所に書く。
// 今はプロのデッキのスペルW・アグロNi・ランプD・アミュレットB で使うカードだけ（docs/pools/azvaldt.md「段取り」）。

import type { CardAbilities } from "../../../engine/dsl";
import { BISHOP } from "./bishop";
import { CRESTS } from "./crests";
import { DRAGON } from "./dragon";
import { NEUTRAL } from "./neutral";
import { NIGHTMARE } from "./nightmare";
import { WITCH } from "./witch";

export { id } from "./helpers";

export const AZVALDT_CARD_ABILITIES: Readonly<Record<string, CardAbilities>> = {
  ...NEUTRAL,
  ...WITCH,
  ...NIGHTMARE,
  ...DRAGON,
  ...BISHOP,
};

export const AZVALDT_CREST_ABILITIES: Readonly<Record<string, CardAbilities>> = CRESTS;
