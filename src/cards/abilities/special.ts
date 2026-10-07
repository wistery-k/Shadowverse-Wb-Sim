// カード能力以外の特殊なデータ（docs/rules.md 参照）

import { id } from "./helpers";

/** アポカリプスデッキの中身 [カードID, 枚数] */
export const APOCALYPSE_DECK: readonly [string, number][] = [
  [id("沈黙の魔将"), 3],
  [id("サタンズサーヴァント"), 3],
  [id("辺獄の悪鬼"), 3],
  [id("アスタロトの宣告"), 1],
];
