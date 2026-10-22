import { useState } from "preact/hooks";
import { createGame, rngFrom, type Action, type GameState, type PlayerIndex } from "../engine";
import { buildHumanRecord } from "../sim/humanRecord";
import { compareMatch, OPPONENTS as COMPARE_OPPONENTS } from "../sim/humanCompare";
import { DeckSelect, resolveDeck, type DeckChoice } from "./DeckSelect";
import { Decks } from "./Decks";
import { Game } from "./Game";
import { HumanCompare, loadHumanRecords, saveHumanRecords, type HumanMatchChoice } from "./HumanCompare";
import { Sandbox, type SandboxIncoming } from "./Sandbox";
import { Simulate } from "./Simulate";
import { loadDecks, saveDecks, type SavedDeck } from "./storage";

/** 相手の強さ（キーは src/ai/registry.ts） */
const OPPONENTS: Record<string, string> = {
  search: "つよい（探索）",
  greedy: "ふつう（貪欲法）",
  random: "よわい（ランダム）",
};

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

type Tab = "play" | "decks" | "sim" | "compare" | "sandbox";

const TABS: readonly [Tab, string][] = [
  ["play", "対戦"],
  ["decks", "デッキ"],
  ["sim", "AI対戦"],
  ["compare", "人間との比較"],
  ["sandbox", "サンドボックス"],
];

export function App() {
  const [tab, setTab] = useState<Tab>("play");
  // サンドボックスに開く局面（リプレイの「サンドボックスで開く」）
  const [sandboxIncoming, setSandboxIncoming] = useState<SandboxIncoming | null>(null);
  const [saved, setSaved] = useState<SavedDeck[]>(() => loadDecks());
  const [setup, setSetupState] = useState<Setup>(() => loadSetup());
  const [game, setGame] = useState<{ state: GameState; agent: string; human?: PlayerIndex; compare?: HumanMatchChoice } | null>(null);
  const [compareError, setCompareError] = useState("");
  const [error, setError] = useState("");

  const setSetup = (s: Setup) => {
    setSetupState(s);
    saveSetup(s);
  };
  const updateDecks = (decks: SavedDeck[]) => {
    setSaved(decks);
    if (!saveDecks(decks)) setError("デッキをブラウザに保存できませんでした（プライベートブラウズ等）");
  };

  function openSandbox(state: GameState, label: string) {
    setSandboxIncoming((x) => ({ state, label, nonce: (x?.nonce ?? 0) + 1 }));
    setTab("sandbox");
  }

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
    setGame({ state: createGame({ decks: [me, ai], seed }), agent: OPPONENTS[setup.agent] ? setup.agent : "greedy" });
  }

  function startCompare(m: HumanMatchChoice) {
    setCompareError("");
    setGame({ state: createGame(compareMatch(m.subject, m.deck, m.g, m.seat)), agent: COMPARE_OPPONENTS[m.opponent].agent, human: m.seat, compare: m });
  }

  // 人間との比較の試合が終わったら記録を保存する
  function recordCompare(m: HumanMatchChoice, actions: Action[], autoActions: number[]) {
    try {
      const record = buildHumanRecord({ ...m, actions, autoActions, commit: __BUILD_COMMIT__, playedAt: new Date().toISOString() });
      if (!saveHumanRecords(m.subject, [...loadHumanRecords(m.subject), record])) setCompareError("記録をブラウザに保存できませんでした（プライベートブラウズ等）");
    } catch (e) {
      setCompareError(`記録を作れませんでした: ${String(e)}`);
    }
  }

  return (
    <div class="app">
      <header>
        <h1>Shadowverse: Worlds Beyond Simulator</h1>
        <span class="muted">スターター（ベーシック＋伝説の幕開け）</span>
        {!game && (
          <nav class="tabs">
            {TABS.map(([key, label]) => (
              <button type="button" key={key} class={tab === key ? "active" : ""} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </nav>
        )}
      </header>
      {error && <p class="problems">{error}</p>}
      <main>
        {/* AI対戦とサンドボックスは、ほかのタブに移っても実行中の対戦・打ち比べと局面を残すため、隠すだけにする */}
        <div hidden={!!game || tab !== "sim"}>
          <Simulate saved={saved} onSandbox={openSandbox} />
        </div>
        <div hidden={!!game || tab !== "sandbox"}>
          <Sandbox saved={saved} incoming={sandboxIncoming} />
        </div>
        {game ? (
          <Game
            initial={game.state}
            ai={game.agent}
            human={game.human ?? 0}
            onExit={() => setGame(null)}
            {...(game.compare
              ? { onEnd: (actions: Action[], _final: GameState, auto: number[]) => recordCompare(game.compare!, actions, auto), exitLabel: "記録に戻る", lethalHelper: true }
              : {})}
          />
        ) : tab === "decks" ? (
          <Decks decks={saved} onChange={updateDecks} />
        ) : tab === "sim" || tab === "sandbox" ? null : tab === "compare" ? (
          <HumanCompare onStart={startCompare} saveError={compareError} />
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
                {Object.entries(OPPONENTS).map(([key, label]) => (
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
