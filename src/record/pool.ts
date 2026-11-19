// 前期のローテーション（data/pools/azvaldt/）のカードプール。試合の記録（開発サーバーだけ）とアズヴォルト環境のページで使う。
// 読み込むと、画面のカードの表（src/engine/registry.ts）に前期のローテーションのカード・クレスト・能力の定義を足す。
// このモジュールは、開発サーバーだけの画面（src/ui/MatchRecord.tsx）、アズヴォルト環境のページ（公開サイト。src/azvaldt/main.tsx。2026-11-19）、
// コマンド・テストから読む。スターターのページ（src/main.tsx）は読まない。

import { AZVALDT_CARD_ABILITIES } from "../cards/abilities/azvaldt";
import { AZVALDT_CARDS, ENGINE_CARDS, ENGINE_CRESTS } from "../cards/pools";
import type { Card } from "../cards/types";
import { registerPoolCards } from "../engine/registry";

registerPoolCards(ENGINE_CARDS, ENGINE_CRESTS, AZVALDT_CARD_ABILITIES);

/** 前期のローテーションのカード（トークンを除く）を名前で引く。ストームブラストは再録の ID（10831310）になる */
export const POOL_CARD_BY_NAME: ReadonlyMap<string, Card> = new Map(AZVALDT_CARDS.filter((c) => c.set !== "token").map((c) => [c.name, c]));
