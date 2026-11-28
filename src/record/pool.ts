// 前期のローテーション（data/pools/azvaldt/）のカードプール。試合の記録（開発サーバーだけ）とアズヴォルト環境のページで使う。
// 読み込むと、画面のカードの表（src/engine/registry.ts）に前期のローテーションのカード・クレスト・能力の定義を足す。
// このモジュールは、開発サーバーだけの画面（src/ui/MatchRecord.tsx）、アズヴォルト環境のページ（公開サイト。src/azvaldt/main.tsx。2026-11-19）、
// コマンド・テストから読む。スターターのページ（src/main.tsx）は読まない。

import { AZVALDT_CARD_ABILITIES } from "../cards/abilities/azvaldt";
import { AZVALDT_CARDS, ENGINE_CARDS, ENGINE_CRESTS } from "../cards/pools";
import type { Card } from "../cards/types";
import { registerPoolCards } from "../engine/registry";

registerPoolCards(ENGINE_CARDS, ENGINE_CRESTS, AZVALDT_CARD_ABILITIES);

/** エンジンのカードの表で、名前ごとに最初のカード（スターターの表が先） */
const FIRST_BY_NAME = new Map<string, Card>();
for (const c of ENGINE_CARDS) if (!FIRST_BY_NAME.has(c.name)) FIRST_BY_NAME.set(c.name, c);

/**
 * 前期のローテーションのカード（トークンを除く）の名前 → デッキに入れるカード。
 * コマンド（rust/engine/src/runner/deck_compare.rs の find_card）と同じく、エンジンのカードの表で名前が最初に合うカードにする。
 * なので再録のストームブラストは、前期のローテーションの ID（10831310）ではなくスターターの ID（10131320）になる。
 * 効果は同じで、補正と見込みはコマンドの自己対戦の 10131320 で学んだもの（10831310 の重みは学んでいない）。
 * ページの AI がコマンドと同じ手を打つように、そろえる（2026-11-28。tests/fixtures/azvaldt-decks.json で両方の読み方を比べる）
 */
export const POOL_CARD_BY_NAME: ReadonlyMap<string, Card> = new Map(
  AZVALDT_CARDS.filter((c) => c.set !== "token").map((c) => [c.name, FIRST_BY_NAME.get(c.name) ?? c]),
);
