// カード・クレストの能力定義（カードIDをキーにする）

import type { CardAbilities } from "../../engine/dsl";
import { BISHOP } from "./bishop";
import { CRESTS } from "./crests";
import { DRAGON } from "./dragon";
import { ELF } from "./elf";
import { NEMESIS } from "./nemesis";
import { NEUTRAL } from "./neutral";
import { NIGHTMARE } from "./nightmare";
import { ROYAL } from "./royal";
import { WITCH } from "./witch";

export const CARD_ABILITIES: Readonly<Record<string, CardAbilities>> = {
  ...NEUTRAL,
  ...ELF,
  ...ROYAL,
  ...WITCH,
  ...DRAGON,
  ...NIGHTMARE,
  ...BISHOP,
  ...NEMESIS,
};

export const CREST_ABILITIES: Readonly<Record<string, CardAbilities>> = CRESTS;
