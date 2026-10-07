import { useState } from "preact/hooks";
import { greedyAgent } from "../ai/greedy";
import { randomAgent } from "../ai/random";
import type { Agent } from "../ai/types";
import { CLASS_NAMES, type ClassId } from "../cards";
import { createGame, rngFrom, type GameState } from "../engine";
import { randomDeck } from "../sim/decks";
import { Game } from "./Game";

type DeckClass = Exclude<ClassId, "neutral">;
const CLASSES: DeckClass[] = ["elf", "royal", "witch", "dragon", "nightmare", "bishop", "nemesis"];
const AGENTS: Record<string, { agent: Agent; label: string }> = {
  greedy: { agent: greedyAgent, label: "ふつう（貪欲法）" },
  random: { agent: randomAgent, label: "よわい（ランダム）" },
};

export function App() {
  const [myClass, setMyClass] = useState<DeckClass>("elf");
  const [aiClass, setAiClass] = useState<DeckClass>("royal");
  const [aiKey, setAiKey] = useState("greedy");
  const [game, setGame] = useState<{ state: GameState; agent: Agent } | null>(null);

  function start() {
    const seed = Math.floor(Math.random() * 2 ** 32);
    const rng = rngFrom({ rng: seed });
    const decks: [string[], string[]] = [randomDeck(myClass, rng), randomDeck(aiClass, rng)];
    setGame({ state: createGame({ decks, seed }), agent: (AGENTS[aiKey] ?? AGENTS.greedy!).agent });
  }

  return (
    <div class="app">
      <header>
        <h1>Shadowverse: Worlds Beyond Simulator</h1>
        <span class="muted">スターター（ベーシック＋伝説の幕開け）</span>
      </header>
      <main>
        {game ? (
          <Game initial={game.state} ai={game.agent} onExit={() => setGame(null)} />
        ) : (
          <div class="setup">
            <label>
              あなたのクラス
              <ClassSelect value={myClass} onChange={setMyClass} />
            </label>
            <label>
              相手のクラス
              <ClassSelect value={aiClass} onChange={setAiClass} />
            </label>
            <label>
              相手の強さ
              <select value={aiKey} onChange={(e) => setAiKey(e.currentTarget.value)}>
                {Object.entries(AGENTS).map(([key, { label }]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <p class="muted">デッキは選んだクラスのカードとニュートラルからランダムに40枚で構築します。</p>
            <button type="button" class="primary" onClick={start}>
              対戦開始
            </button>
          </div>
        )}
      </main>
      <footer>
        非公式ファンプロジェクトです。Cygames 社および関連企業とは一切関係ありません。
        ゲーム名・カード名・カードテキストの権利は各権利者に帰属します。
      </footer>
    </div>
  );
}

function ClassSelect({ value, onChange }: { value: DeckClass; onChange: (c: DeckClass) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.currentTarget.value as DeckClass)}>
      {CLASSES.map((c) => (
        <option key={c} value={c}>
          {CLASS_NAMES[c]}
        </option>
      ))}
    </select>
  );
}
