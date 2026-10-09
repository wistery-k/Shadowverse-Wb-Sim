// 記録した試合を手元で再現するための情報（リプレイ画面の表示と npm run game で共通に使う）
//
// 試合は「コミット・seed・両者の AI とデッキ（カードの並び順を含む）」で決まる。
// デッキの並び順も山札のシャッフル結果に影響するので、順番を保ったまま文字列にする。

import { DEFAULT_DECKS } from "../cards/defaultDecks";
import { seatDecks, type Entrant, type GameRecord } from "./tournament";

/**
 * デッキをコマンドの引数にする。デフォルトデッキと並びまで同じならそのキー（ファイル名）、
 * そうでなければカードIDの列（連続する同じIDは「ID*枚数」にまとめる。例: 10001110*3,10001120）。
 */
export function deckArg(cards: readonly string[]): string {
  const d = DEFAULT_DECKS.find((x) => x.cards.length === cards.length && x.cards.every((id, i) => id === cards[i]));
  if (d) return d.key;
  const runs: string[] = [];
  for (let i = 0; i < cards.length; ) {
    let j = i;
    while (j < cards.length && cards[j] === cards[i]) j++;
    runs.push(j - i > 1 ? `${cards[i]}*${j - i}` : cards[i]!);
    i = j;
  }
  return runs.join(",");
}

/** deckArg の逆。デフォルトデッキのキー・名前か、カードIDの列 */
export function parseDeckArg(arg: string): string[] {
  const d = DEFAULT_DECKS.find((x) => x.key === arg || x.name === arg);
  if (d) return [...d.cards];
  const cards: string[] = [];
  for (const part of arg.split(",")) {
    const m = /^(\w+)(?:\*(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`デッキの指定が読めません: ${part}（デフォルトデッキのキーか「ID*枚数,…」）`);
    for (let n = 0; n < Number(m[2] ?? 1); n++) cards.push(m[1]!);
  }
  return cards;
}

/** シェルにそのまま貼れるよう、必要なら単一引用符で囲む */
function quote(s: string): string {
  return /^[\w.,*/=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 試合を再現する npm run game のコマンド */
export function reproduceCommand(record: Pick<GameRecord, "a" | "b" | "aIsPlayer0" | "seed">, entrants: readonly Entrant[]): string {
  const decks = seatDecks(record, entrants);
  const [e0, e1] = record.aIsPlayer0 ? [entrants[record.a]!, entrants[record.b]!] : [entrants[record.b]!, entrants[record.a]!];
  return [
    "npm run game --",
    `--seed ${record.seed}`,
    `--p0 ${quote(e0.agent)} --p0-deck ${quote(deckArg(decks[0]))}`,
    `--p1 ${quote(e1.agent)} --p1-deck ${quote(deckArg(decks[1]))}`,
  ].join(" ");
}
