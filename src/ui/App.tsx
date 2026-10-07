import { useState } from "preact/hooks";
import { greedyAgent } from "../ai/greedy";
import { randomAgent } from "../ai/random";
import type { Agent } from "../ai/types";
import { CLASS_NAMES } from "../cards";
import { DECK_CLASSES, type DeckClass } from "../cards/deck";
import { DEFAULT_DECKS } from "../cards/defaultDecks";
import { createGame, rngFrom, type GameState, type Rng } from "../engine";
import { randomDeck } from "../sim/decks";
import { Decks, isPlayable } from "./Decks";
import { Game } from "./Game";
import { Simulate } from "./Simulate";
import { loadDecks, saveDecks, type SavedDeck } from "./storage";

const AGENTS: Record<string, { agent: Agent; label: string }> = {
  greedy: { agent: greedyAgent, label: "ふつう（貪欲法）" },
  random: { agent: randomAgent, label: "よわい（ランダム）" },
};

/** デッキの選択肢: "saved:<id>" / "default:<key>" / "random:<class>" */
type DeckChoice = string;

const SETUP_KEY = "svwb-sim:setup:v1";
interface Setup {
  me: DeckChoice;
  ai: DeckChoice;
  agent: string;
}
function loadSetup(): Setup {
  const fallback: Setup = { me: "random:elf", ai: "random:royal", agent: "greedy" };
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SETUP_KEY) ?? "null");
    if (typeof v === "object" && v !== null) return { ...fallback, ...(v as Partial<Setup>) };
  } catch {
    // 保存できない環境では既定値を使う
  }
  return fallback;
}
function saveSetup(setup: Setup): void {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
  } catch {
    // 保存できなくても動作には影響しない
  }
}

function resolveDeck(choice: DeckChoice, saved: readonly SavedDeck[], rng: Rng): string[] | null {
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

export function App() {
  const [tab, setTab] = useState<"play" | "decks" | "sim">("play");
  const [saved, setSaved] = useState<SavedDeck[]>(() => loadDecks());
  const [setup, setSetupState] = useState<Setup>(() => loadSetup());
  const [game, setGame] = useState<{ state: GameState; agent: Agent } | null>(null);
  const [error, setError] = useState("");

  const setSetup = (s: Setup) => {
    setSetupState(s);
    saveSetup(s);
  };
  const updateDecks = (decks: SavedDeck[]) => {
    setSaved(decks);
    if (!saveDecks(decks)) setError("デッキをブラウザに保存できませんでした（プライベートブラウズ等）");
  };

  function start() {
    const seed = Math.floor(Math.random() * 2 ** 32);
    const rng = rngFrom({ rng: seed });
    const me = resolveDeck(setup.me, saved, rng);
    const ai = resolveDeck(setup.ai, saved, rng);
    if (!me || !ai) {
      setError("選んだデッキが見つからないか、未完成です");
      return;
    }
    setError("");
    setGame({ state: createGame({ decks: [me, ai], seed }), agent: (AGENTS[setup.agent] ?? AGENTS.greedy!).agent });
  }

  return (
    <div class="app">
      <header>
        <h1>Shadowverse: Worlds Beyond Simulator</h1>
        <span class="muted">スターター（ベーシック＋伝説の幕開け）</span>
        {!game && (
          <nav class="tabs">
            <button type="button" class={tab === "play" ? "active" : ""} onClick={() => setTab("play")}>
              対戦
            </button>
            <button type="button" class={tab === "decks" ? "active" : ""} onClick={() => setTab("decks")}>
              デッキ
            </button>
            <button type="button" class={tab === "sim" ? "active" : ""} onClick={() => setTab("sim")}>
              AI対戦
            </button>
          </nav>
        )}
      </header>
      {error && <p class="problems">{error}</p>}
      <main>
        {game ? (
          <Game initial={game.state} ai={game.agent} onExit={() => setGame(null)} />
        ) : tab === "decks" ? (
          <Decks decks={saved} onChange={updateDecks} />
        ) : tab === "sim" ? (
          <Simulate saved={saved} />
        ) : (
          <div class="setup panel">
            <label>
              あなたのデッキ
              <DeckSelect value={setup.me} saved={saved} onChange={(me) => setSetup({ ...setup, me })} />
            </label>
            <label>
              相手のデッキ
              <DeckSelect value={setup.ai} saved={saved} onChange={(ai) => setSetup({ ...setup, ai })} />
            </label>
            <label>
              相手の強さ
              <select value={setup.agent} onChange={(e) => setSetup({ ...setup, agent: e.currentTarget.value })}>
                {Object.entries(AGENTS).map(([key, { label }]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <p class="muted">「ランダム」は選んだクラスのカードとニュートラルから40枚をランダムに選びます。</p>
            <button type="button" class="primary" onClick={start}>
              対戦開始
            </button>
          </div>
        )}
      </main>
      <footer>
        非公式ファンプロジェクトです。Cygames 社および関連企業とは一切関係ありません。
        ゲーム名・カード名・カードテキストの権利は各権利者に帰属します。
        <BuildInfo />
      </footer>
    </div>
  );
}

function DeckSelect({ value, saved, onChange }: { value: DeckChoice; saved: readonly SavedDeck[]; onChange: (v: DeckChoice) => void }) {
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

const REPO_URL = "https://github.com/wistery-k/Shadowverse-Wb-Sim";

/** 最終更新日時とコミットハッシュ（ビルド時に埋め込んだ値） */
function BuildInfo() {
  if (!__BUILD_COMMIT__) return null;
  const date = __BUILD_DATE__ ? new Date(__BUILD_DATE__) : null;
  const dateText =
    date && !Number.isNaN(date.getTime())
      ? date.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "不明";
  return (
    <div class="build-info">
      最終更新: {dateText} / コミット:{" "}
      <a href={`${REPO_URL}/commit/${__BUILD_COMMIT__}`} target="_blank" rel="noreferrer">
        {__BUILD_COMMIT__.slice(0, 7)}
      </a>
    </div>
  );
}
