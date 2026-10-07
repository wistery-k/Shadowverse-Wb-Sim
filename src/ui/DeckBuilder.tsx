// デッキ編集画面

import { useMemo, useState } from "preact/hooks";
import { ALL_CARDS, CARDS_BY_ID, CLASS_NAMES, DECK_SIZE, MAX_COPIES, STARTER, deckProblems, type Card } from "../cards";
import { compareCards, countCards, deckToText, type Deck } from "../cards/deck";
import { CardDetail } from "./CardView";
import { TYPE_NAMES } from "./describe";
import { ExportBox } from "./ExportBox";

interface Props {
  initial: Deck;
  onSave: (deck: Deck) => void;
  onCancel: () => void;
}

const COST_FILTERS = ["すべて", "0-1", "2", "3", "4", "5", "6", "7", "8+"] as const;

function costMatches(cost: number, filter: (typeof COST_FILTERS)[number]): boolean {
  if (filter === "すべて") return true;
  if (filter === "0-1") return cost <= 1;
  if (filter === "8+") return cost >= 8;
  return cost === Number(filter);
}

export function DeckBuilder({ initial, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial.name);
  const [cards, setCards] = useState<string[]>(initial.cards);
  const [cost, setCost] = useState<(typeof COST_FILTERS)[number]>("すべて");
  const [type, setType] = useState<"all" | Card["type"]>("all");
  const [owner, setOwner] = useState<"all" | "class" | "neutral">("all");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<Card | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify([initial.name, initial.cards]));
  const dirty = JSON.stringify([name, cards]) !== savedSnapshot;

  const deckClass = initial.class;
  const counts = useMemo(() => countCards(cards), [cards]);

  const pool = useMemo(
    () =>
      ALL_CARDS.filter((c) => STARTER.sets.includes(c.set) && (c.class === deckClass || c.class === "neutral"))
        .filter((c) => costMatches(c.cost, cost))
        .filter((c) => type === "all" || c.type === type)
        .filter((c) => owner === "all" || (owner === "class" ? c.class === deckClass : c.class === "neutral"))
        .filter((c) => query === "" || c.name.includes(query) || c.text.includes(query))
        .sort(compareCards),
    [deckClass, cost, type, owner, query],
  );

  const deckCards = [...counts.keys()]
    .map((id) => CARDS_BY_ID.get(id))
    .filter((c): c is Card => c !== undefined)
    .sort(compareCards);
  const problems = deckProblems(STARTER, deckClass, cards.map((id) => CARDS_BY_ID.get(id)).filter((c): c is Card => !!c));

  const add = (c: Card) => {
    if ((counts.get(c.id) ?? 0) < MAX_COPIES && cards.length < DECK_SIZE) setCards([...cards, c.id]);
  };
  const remove = (c: Card) => {
    const i = cards.lastIndexOf(c.id);
    if (i >= 0) setCards([...cards.slice(0, i), ...cards.slice(i + 1)]);
  };

  // コスト分布（0〜8+）
  const curve = Array.from({ length: 9 }, (_, i) =>
    cards.filter((id) => {
      const c = CARDS_BY_ID.get(id)?.cost ?? 0;
      return i === 8 ? c >= 8 : c === i;
    }).length,
  );
  const curveMax = Math.max(1, ...curve);

  return (
    <div class="builder">
      <section class="pool panel">
        <div class="filters">
          <input
            type="search"
            placeholder="カード名・能力で検索"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <select value={type} onChange={(e) => setType(e.currentTarget.value as typeof type)}>
            <option value="all">すべての種類</option>
            <option value="follower">フォロワー</option>
            <option value="spell">スペル</option>
            <option value="amulet">アミュレット</option>
          </select>
          <select value={owner} onChange={(e) => setOwner(e.currentTarget.value as typeof owner)}>
            <option value="all">{CLASS_NAMES[deckClass]}＋ニュートラル</option>
            <option value="class">{CLASS_NAMES[deckClass]}のみ</option>
            <option value="neutral">ニュートラルのみ</option>
          </select>
          <div class="cost-filter">
            {COST_FILTERS.map((f) => (
              <button type="button" key={f} class={cost === f ? "active" : ""} onClick={() => setCost(f)}>
                {f}
              </button>
            ))}
          </div>
        </div>
        <ul class="card-rows">
          {pool.map((c) => {
            const n = counts.get(c.id) ?? 0;
            return (
              <li key={c.id} class={`card-row class-${c.class} ${detail?.id === c.id ? "selected" : ""}`}>
                <button type="button" class="row-main" onClick={() => setDetail(c)}>
                  <span class="cost">{c.cost}</span>
                  <span class="row-name">{c.name}</span>
                  <span class="row-meta">{c.type === "follower" ? `${c.attack}/${c.defense}` : TYPE_NAMES[c.type]}</span>
                </button>
                <span class="row-count">{n > 0 ? `×${n}` : ""}</span>
                <button type="button" disabled={n === 0} onClick={() => remove(c)} aria-label={`${c.name}を1枚減らす`}>
                  −
                </button>
                <button
                  type="button"
                  disabled={n >= MAX_COPIES || cards.length >= DECK_SIZE}
                  onClick={() => add(c)}
                  aria-label={`${c.name}を1枚追加`}
                >
                  ＋
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section class="deck panel">
        <label class="deck-name">
          デッキ名
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <div class="deck-summary">
          <strong class={cards.length === DECK_SIZE ? "ok" : ""}>
            {cards.length}/{DECK_SIZE}枚
          </strong>
          <span class="muted">{CLASS_NAMES[deckClass]}</span>
        </div>
        <div class="curve" aria-label="コスト分布">
          {curve.map((n, i) => (
            <div class="curve-col" key={i}>
              <span class="curve-n">{n}</span>
              <div class="curve-bar" style={{ height: `${(n / curveMax) * 48}px` }} />
              <span class="curve-label">{i === 8 ? "8+" : i}</span>
            </div>
          ))}
        </div>
        <ul class="card-rows">
          {deckCards.map((c) => (
            <li key={c.id} class={`card-row class-${c.class}`}>
              <button type="button" class="row-main" onClick={() => setDetail(c)}>
                <span class="cost">{c.cost}</span>
                <span class="row-name">{c.name}</span>
              </button>
              <span class="row-count">×{counts.get(c.id)}</span>
              <button type="button" onClick={() => remove(c)} aria-label={`${c.name}を1枚減らす`}>
                −
              </button>
              <button
                type="button"
                disabled={(counts.get(c.id) ?? 0) >= MAX_COPIES || cards.length >= DECK_SIZE}
                onClick={() => add(c)}
                aria-label={`${c.name}を1枚追加`}
              >
                ＋
              </button>
            </li>
          ))}
        </ul>
        {problems.length > 0 && (
          <ul class="problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div class="row-buttons">
          <button
            type="button"
            class="primary"
            onClick={() => {
              const saved = name.trim() || "無題のデッキ";
              setName(saved);
              setSavedSnapshot(JSON.stringify([saved, cards]));
              onSave({ name: saved, class: deckClass, cards });
            }}
          >
            {dirty ? "保存" : "保存済み"}
          </button>
          <button type="button" onClick={() => setShowExport(!showExport)}>
            エクスポート
          </button>
          <button
            type="button"
            onClick={() => {
              if (!dirty || confirm("保存していない変更があります。破棄して戻りますか？")) onCancel();
            }}
          >
            戻る
          </button>
        </div>
        {showExport && (
          <ExportBox
            text={deckToText({ name: name.trim() || "無題のデッキ", class: deckClass, cards })}
            fileName={name.trim() || "deck"}
          />
        )}
      </section>

      <aside class="builder-detail">{detail ? <CardDetail card={detail} /> : <p class="muted">カード名をクリックすると詳細を表示します</p>}</aside>
    </div>
  );
}
