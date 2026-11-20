import { useEffect, useState } from "preact/hooks";
import { createGame, rngFrom, type Action, type GameState, type PlayerIndex } from "../engine";
import { isGameHash, STARTER_LINK_DECKS } from "../sim/gameLink";
import { buildHumanRecord } from "../sim/humanRecord";
import { compareMatch, OPPONENTS as COMPARE_OPPONENTS } from "../sim/humanCompare";
import { DeckSelect, resolveDeck, type DeckChoice } from "./DeckSelect";
import { Decks } from "./Decks";
import { Footer } from "./Footer";
import { Game } from "./Game";
import { HumanCompare, loadHumanRecords, saveHumanRecords, type HumanMatchChoice } from "./HumanCompare";
import { MatchRecord } from "./MatchRecord";
import { isMissesHash, Misses } from "./Misses";
import { ReplaySearch } from "./ReplaySearch";
import { Sandbox, type SandboxIncoming } from "./Sandbox";
import { AGENTS } from "../ai/registry";
import { DEFAULT_DECKS } from "../cards/defaultDecks";
import { isPlayable } from "./Decks";
import { Simulate, type DeckOption } from "./Simulate";
import { loadDecks, saveDecks, type SavedDeck } from "./storage";

/** 相手の強さ（キーは src/ai/registry.ts） */
const OPPONENTS: Record<string, string> = {
  search: "つよい（探索）",
  greedy: "ふつう（貪欲法）",
  random: "よわい（ランダム）",
};

/** AI対戦（総当たり）で選べる AI（全部） */
const SIM_AGENTS: Record<string, string> = Object.fromEntries(Object.entries(AGENTS).map(([key, { label }]) => [key, label]));
/** AI対戦の最初の選択（デフォルトデッキ全部と貪欲法、1組 10 試合） */
const SIM_DEFAULTS = { decks: DEFAULT_DECKS.map((d) => `default:${d.key}`), agents: ["greedy"], games: 10 };

/** AI対戦で選べるデッキ（デフォルトデッキと、保存した完成済みのデッキ） */
function simDecks(saved: readonly SavedDeck[]): DeckOption[] {
  return [
    ...DEFAULT_DECKS.map((d) => ({ key: `default:${d.key}`, cls: d.class, cards: d.cards, label: d.name })),
    ...saved.filter(isPlayable).map((d) => ({ key: `saved:${d.id}`, cls: d.class, cards: d.cards, label: `${d.name}（保存）` })),
  ];
}

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

type Tab = "play" | "decks" | "sim" | "compare" | "misses" | "sandbox" | "replays" | "record";

/**
 * サンドボックス（好きな局面を作って AI に考えさせる）は、ゲームの実際の対戦の局面を入れて手を聞く
 * 「ソフト打ち」に使えてしまうので、開発サーバー（npm run dev）だけで出し、公開サイト（vite build）には出さない
 */
const SANDBOX = import.meta.env.DEV;

/** リプレイ検索（手元の自己対戦の記録から条件に合うターンを探す）は、手元のファイルを読むので開発サーバーだけで出す */
const REPLAY_SEARCH = import.meta.env.DEV;

/**
 * 試合の記録（プロの試合を見ながら手を入れる）は開発サーバーだけで出す。CLAUDE.md「決定済みの前提」の試合の記録の条件:
 * デッキはプロのデッキだけ・入れている間は AI を呼ばない・前期のローテーションだけ。vite build では画面のモジュールを空のものに置き換える
 */
const MATCH_RECORD = import.meta.env.DEV;

// 問題集（見落とし問題集の局面を見る）は公開サイトにも出す。見られるのはリポジトリにある決まった局面だけで、
// 局面の編集・貼り付け・読み込みは付けない（サンドボックスと違い、実際の対戦の局面を入れて手を聞くことはできない。CLAUDE.md「ソフト打ち」）

const TABS: readonly [Tab, string][] = [
  ["play", "対戦"],
  ["decks", "デッキ"],
  ["sim", "AI対戦"],
  ["compare", "人間との比較"],
  ["misses", "問題集"],
  ...(SANDBOX ? [["sandbox", "サンドボックス"] as [Tab, string]] : []),
  ...(REPLAY_SEARCH ? [["replays", "リプレイ検索"] as [Tab, string]] : []),
  ...(MATCH_RECORD ? [["record", "試合の記録"] as [Tab, string]] : []),
];

export function App() {
  // URL が #misses（問題集の問）なら問題集を、#game（AI 同士の試合。src/sim/gameLink.ts）なら AI対戦を開く
  const [tab, setTabState] = useState<Tab>(() => (isMissesHash() ? "misses" : isGameHash() ? "sim" : "play"));
  // 試合の URL を同じページに貼ったら、AI対戦のタブに移る（試合を打ち直すのは Simulate）
  useEffect(() => {
    const onHash = () => {
      if (isGameHash()) setTabState("sim");
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  // リプレイ検索は、最初に開くまで作らない（開くと手元のファイルの一覧を取りに行く）
  const [replaysOpened, setReplaysOpened] = useState(false);
  // 問題集も、最初に開くまで作らない（開くと問のデータを読み込む）
  const [missesOpened, setMissesOpened] = useState(() => isMissesHash());
  // 試合の記録も、最初に開くまで作らない（開くとブラウザに残した途中の記録をたどり直す）
  const [recordOpened, setRecordOpened] = useState(false);
  const setTab = (t: Tab) => {
    setTabState(t);
    if (t === "replays") setReplaysOpened(true);
    if (t === "record") setRecordOpened(true);
    if (t === "misses") setMissesOpened(true);
    // 問題集を離れたら URL の #misses を消す（読み込み直したときに問題集が開かないように）
    else if (isMissesHash()) {
      try {
        history.replaceState(null, "", location.pathname + location.search);
      } catch {
        // 書き換えられなくても画面は動く
      }
    }
  };
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
        <span class="muted">{MATCH_RECORD && tab === "record" ? "前期のローテーション（プロのデッキ）" : "スターター（ベーシック＋伝説の幕開け）"}</span>
        <a class="pool-link" href={`${import.meta.env.BASE_URL}azvaldt/`}>
          アズヴォルト環境のページへ
        </a>
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
          <Simulate
            decks={simDecks(saved)}
            agents={SIM_AGENTS}
            defaults={SIM_DEFAULTS}
            storageKey="svwb-sim:simulate-selection:v1"
            links={STARTER_LINK_DECKS}
            {...(SANDBOX ? { onSandbox: openSandbox } : {})}
          />
        </div>
        {SANDBOX && (
          <div hidden={!!game || tab !== "sandbox"}>
            <Sandbox saved={saved} incoming={sandboxIncoming} />
          </div>
        )}
        {/* リプレイ検索も、読み込んだ試合と検索結果を残すため隠すだけにする */}
        {REPLAY_SEARCH && replaysOpened && (
          <div hidden={!!game || tab !== "replays"}>
            <ReplaySearch {...(SANDBOX ? { onSandbox: openSandbox } : {})} />
          </div>
        )}
        {/* 試合の記録も、入れている途中の局面を残すため隠すだけにする */}
        {MATCH_RECORD && recordOpened && (
          <div hidden={!!game || tab !== "record"}>
            <MatchRecord />
          </div>
        )}
        {/* 問題集も、開いた問と打たせた並びを残すため隠すだけにする */}
        {missesOpened && (
          <div hidden={!!game || tab !== "misses"}>
            <Misses active={!game && tab === "misses"} {...(SANDBOX ? { onSandbox: openSandbox } : {})} />
          </div>
        )}
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
        ) : tab === "sim" || tab === "sandbox" || tab === "replays" || tab === "misses" || tab === "record" ? null : tab === "compare" ? (
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
      <Footer />
    </div>
  );
}
