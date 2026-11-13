// 前期のローテーション（data/pools/azvaldt/）にしか無いカード・クレストの能力定義（カードIDをキーにする）。
// スターターと同じ ID のカード（ベーシックとトークン）は、スターターの定義（../index.ts）を共有するので、ここには書かない。
// エンジンには、スターターの定義の後に読ませる（scripts/rust-data-main.ts の poolCardAbilities・poolCrestAbilities）。
// まだ定義は無い。書くときは、カード名は下の id() で引く（スターターの ../helpers.ts の id() はスターターのカードから引くので、
// 同じ名前のストームブラスト 10131320 と 10831310 を取り違えないように）。

import rawRotCards from "../../../../data/pools/azvaldt/cards.json";
import type { CardAbilities } from "../../../engine/dsl";

const ID_BY_NAME = new Map((rawRotCards as { id: string; name: string }[]).map((c) => [c.name, c.id]));

/** カード名から前期のローテーションのカードIDを引く */
export function id(name: string): string {
  const v = ID_BY_NAME.get(name);
  if (!v) throw new Error(`前期のローテーションにカードがありません: ${name}`);
  return v;
}

export const AZVALDT_CARD_ABILITIES: Readonly<Record<string, CardAbilities>> = {};

export const AZVALDT_CREST_ABILITIES: Readonly<Record<string, CardAbilities>> = {};
