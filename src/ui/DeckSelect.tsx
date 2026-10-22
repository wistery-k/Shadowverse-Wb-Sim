// デッキの選択（対戦の設定・サンドボックスで共通）

import { CLASS_NAMES } from "../cards";
import { DECK_CLASSES, type DeckClass } from "../cards/deck";
import { DEFAULT_DECKS } from "../cards/defaultDecks";
import type { Rng } from "../engine";
import { randomDeck } from "../sim/decks";
import { isPlayable } from "./Decks";
import type { SavedDeck } from "./storage";

/** デッキの選択肢: "saved:<id>" / "default:<key>" / "random:<class>" */
export type DeckChoice = string;

/** 選んだデッキのカード（ランダムなら rng で作る）。見つからないか未完成なら null */
export function resolveDeck(choice: DeckChoice, saved: readonly SavedDeck[], rng: Rng): string[] | null {
  const [kind, value] = [choice.slice(0, choice.indexOf(":")), choice.slice(choice.indexOf(":") + 1)];
  if (kind === "saved") {
    const d = saved.find((x) => x.id === value);
    return d && isPlayable(d) ? d.cards : null;
  }
  if (kind === "default") {
    const d = DEFAULT_DECKS.find((x) => x.key === value);
    return d ? d.cards : null;
  }
  if (kind === "random" && DECK_CLASSES.includes(value as DeckClass)) return randomDeck(value as DeckClass, rng);
  return null;
}

export function DeckSelect({ value, saved, onChange }: { value: DeckChoice; saved: readonly SavedDeck[]; onChange: (v: DeckChoice) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
      {saved.length > 0 && (
        <optgroup label="保存したデッキ">
          {saved.map((d) => (
            <option key={d.id} value={`saved:${d.id}`} disabled={!isPlayable(d)}>
              {d.name}（{CLASS_NAMES[d.class]}）{isPlayable(d) ? "" : " - 未完成"}
            </option>
          ))}
        </optgroup>
      )}
      {DEFAULT_DECKS.length > 0 && (
        <optgroup label="デフォルトデッキ">
          {DEFAULT_DECKS.map((d) => (
            <option key={d.key} value={`default:${d.key}`}>
              {d.name}（{CLASS_NAMES[d.class]}）
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="ランダム">
        {DECK_CLASSES.map((c) => (
          <option key={c} value={`random:${c}`}>
            ランダム（{CLASS_NAMES[c]}）
          </option>
        ))}
      </optgroup>
    </select>
  );
}
