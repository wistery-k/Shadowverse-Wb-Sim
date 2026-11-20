// アズヴォルト環境のページの総当たりで選べるデッキ: 取り込んだプロのデッキ 84 個（data/pools/azvaldt/decks/。src/record/decks.ts）だけ。
// 貼り付け・自作のデッキ・デッキの編集は付けない。既定は代表 10 型（data/pools/azvaldt/sets/rep10.txt。物差しと同じ組）

import rep10Text from "../../data/pools/azvaldt/sets/rep10.txt?raw";
import { PRO_DECKS, PRO_EVENTS, proDeck } from "../record/decks";
import { sameCards, type LinkDecks } from "../sim/gameLink";
import type { DeckOption } from "../ui/Simulate";

/** 組のファイル（data/pools/azvaldt/sets/*.txt。1 行に 1 つのデッキのファイルの道、# の後は注）のデッキの ID（`<大会>/<チーム>_<クラス>`） */
export function setDeckIds(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => l !== "")
    .map((path) => {
      const m = /decks\/([^/]+\/[^/]+)\.txt$/.exec(path);
      if (!m || !proDeck(m[1]!)) throw new Error(`組のファイルのデッキが見つかりません: ${path}`);
      return m[1]!;
    });
}

/** 代表 10 型のデッキの ID */
export const REP10_IDS: readonly string[] = setDeckIds(rep10Text);

/** 大会の短い名前（「Premier Series 26-27 第9節 後半戦」→「9節後半」。読めなければフォルダの名前） */
export function eventShort(eventId: string): string {
  const name = PRO_EVENTS.find((e) => e.id === eventId)?.name ?? eventId;
  const m = /第(\d+)節\s*(前半|後半)/.exec(name);
  return m ? `${m[1]}節${m[2]}` : eventId;
}

/** 総当たりの選択肢（大会ごとに、ファイルの名前の順） */
export const AZVALDT_DECK_OPTIONS: readonly DeckOption[] = PRO_DECKS.map((d) => {
  const ev = PRO_EVENTS.find((e) => e.id === d.event);
  return {
    key: d.id,
    cls: d.cls,
    cards: d.cards,
    label: `${d.name} ${eventShort(d.event)}`,
    group: ev ? `${ev.name}（${ev.date}）` : d.event,
  };
});

/**
 * 試合の URL（src/sim/gameLink.ts）のデッキの書き方: 取り込んだプロのデッキの ID だけ（カードの列は書かない・読まない。
 * このページで選べるのはプロのデッキだけなので。CLAUDE.md「決定済みの前提」のアズヴォルト環境のページの条件）
 */
export const AZVALDT_LINK_DECKS: LinkDecks = {
  encode: (cards) => AZVALDT_DECK_OPTIONS.find((o) => sameCards(o.cards, cards))?.key ?? null,
  decode(param) {
    const o = AZVALDT_DECK_OPTIONS.find((x) => x.key === param);
    return o ? { cards: [...o.cards], label: o.label } : `このページで選べるデッキ（取り込んだプロのデッキ）にありません: ${param}`;
  },
};
