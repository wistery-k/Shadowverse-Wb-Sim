// サンドボックス: 局面（盤面・手札・山札・リーダー）を手で編集し、AI に考えさせたり、手を打ち比べたりする画面。
// 局面の編集は src/sim/sandbox.ts。打てる手を打って進めることもでき、編集と手は履歴に残る（戻す・やり直す）。
// 今の局面はブラウザに保存し、開き直しても続きから使える。リプレイの局面を開くこともできる（App から incoming で渡す）。

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AGENTS } from "../ai/registry";
import type { AgentRequest, AgentResponse } from "../ai/worker";
import { ALL_CARDS, ALL_CRESTS, CLASS_NAMES, type Card, type ClassId } from "../cards";
import { compareCards } from "../cards/deck";
import {
  actingPlayer,
  applyAction,
  BOARD_LIMIT,
  cardOf,
  HAND_LIMIT,
  legalActions,
  MAX_PP,
  opponent,
  rngFrom,
  staticOf,
  type Action,
  type AmuletOnBoard,
  type EvolveState,
  type FollowerOnBoard,
  type GameState,
  type HandCard,
  type PlayerIndex,
  type StaticKeyword,
} from "../engine";
import * as sb from "../sim/sandbox";
import { AiThought, useThoughts } from "./AiThought";
import { BranchCompare, useBranchRuns } from "./BranchCompare";
import { CardDetail, CardView, hasSpellboost } from "./CardView";
import { DeckSelect, resolveDeck, type DeckChoice } from "./DeckSelect";
import { actionLabels, attackStatuses, crestName, describeAction, KEYWORD_NAMES, leaderClasses, TYPE_NAMES } from "./describe";
import { BoardSlots, EmptySlots, LeaderHp, PlayerInfo, Resources } from "./Game";
import type { SavedDeck } from "./storage";

/** ほかの画面から開く局面（nonce が変わるたびに履歴に足す） */
export interface SandboxIncoming {
  state: GameState;
  label: string;
  nonce: number;
}

interface Props {
  saved: readonly SavedDeck[];
  incoming: SandboxIncoming | null;
}

/** 履歴の 1 つ（id は打ち比べ・AI の考えの結果を残す番号） */
interface Entry {
  id: number;
  state: GameState;
  label: string;
}

interface History {
  entries: Entry[];
  index: number;
}

type Zone = "hand" | "board" | "deck";

/** 右の欄で編集しているもの */
type Selection =
  | { kind: "card"; iid: number }
  | { kind: "leader"; player: PlayerIndex }
  | { kind: "deck"; player: PlayerIndex }
  | { kind: "add"; player: PlayerIndex; zone: Zone }
  | null;

const NAMES: [string, string] = ["P1", "P2"];
const ZONE_NAMES: Record<Zone, string> = { hand: "手札", board: "場", deck: "山札" };
/** 残す履歴の数（古いものから消す） */
const MAX_HISTORY = 300;
/** AI に打たせる手の数の上限（ターンの終わりまで打たせるとき） */
const MAX_AI_STEPS = 200;

const STATE_KEY = "svwb-sim:sandbox:v1";
const OPTIONS_KEY = "svwb-sim:sandbox-options:v1";

interface Options {
  agent: string;
  decks: [DeckChoice, DeckChoice];
  first: "0" | "1" | "random";
  fromDeck: boolean;
}

const DEFAULT_OPTIONS: Options = { agent: "search", decks: ["random:elf", "random:royal"], first: "0", fromDeck: true };

function loadOptions(): Options {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null");
    if (typeof v !== "object" || v === null) return DEFAULT_OPTIONS;
    const o = { ...DEFAULT_OPTIONS, ...(v as Partial<Options>) };
    return AGENTS[o.agent] ? o : { ...o, agent: DEFAULT_OPTIONS.agent };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

function saveJson(key: string, text: string): void {
  try {
    localStorage.setItem(key, text);
  } catch {
    // 保存できなくても動作には影響しない
  }
}

function loadState(): GameState | null {
  try {
    const text = localStorage.getItem(STATE_KEY);
    return text ? sb.importSandbox(text) : null;
  } catch {
    return null;
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const randomSeed = () => Math.floor(Math.random() * 2 ** 32);

export function Sandbox({ saved, incoming }: Props) {
  const nextId = useRef(1);
  const [history, setHistory] = useState<History>(() => {
    const s = loadState();
    return s ? { entries: [{ id: nextId.current++, state: s, label: "前回の局面" }], index: 0 } : { entries: [], index: -1 };
  });
  // AI に続けて打たせるあいだも最新の履歴に足すため、描画を待たずに参照する
  const historyRef = useRef(history);
  historyRef.current = history;
  const current = history.entries[history.index] ?? null;

  const [options, setOptionsState] = useState<Options>(loadOptions);
  const setOptions = (o: Partial<Options>) =>
    setOptionsState((x) => {
      const next = { ...x, ...o };
      saveJson(OPTIONS_KEY, JSON.stringify(next));
      return next;
    });
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"new" | "io" | null>(current ? null : "new");
  const [bottom, setBottom] = useState<PlayerIndex>(0);
  const [aiRunning, setAiRunning] = useState(false);
  const aiCancel = useRef<(() => void) | null>(null);
  const aiWorker = useRef<Worker | null>(null);
  useEffect(() => () => aiWorker.current?.terminate(), []);
  const [seed] = useState(randomSeed);
  const branch = useBranchRuns();
  const thoughts = useThoughts();

  function push(state: GameState, label: string) {
    const h = historyRef.current;
    const entries = [...h.entries.slice(0, h.index + 1), { id: nextId.current++, state, label }];
    const kept = entries.slice(-MAX_HISTORY);
    // 消える局面で打ち比べていたら止める
    const keptIds = new Set(kept.map((e) => e.id));
    const running = [...branch.runs.values()].find((r) => r.finishedAt === null);
    if (running && !keptIds.has(running.step)) branch.stop();
    const next = { entries: kept, index: kept.length - 1 };
    historyRef.current = next;
    setHistory(next);
  }

  /** 今の局面を f で編集して履歴に足す（編集できなければ理由を出す） */
  function apply(label: string, f: (s: GameState) => GameState): boolean {
    if (!current) return false;
    try {
      const next = f(current.state);
      if (next !== current.state) push(next, label);
      setError("");
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    }
  }

  const go = (index: number) => {
    const h = historyRef.current;
    const i = Math.max(0, Math.min(h.entries.length - 1, index));
    const next = { ...h, index: i };
    historyRef.current = next;
    setHistory(next);
    setError("");
  };

  useEffect(() => {
    if (current) saveJson(STATE_KEY, sb.exportSandbox(current.state));
  }, [current?.id]);

  useEffect(() => {
    if (!incoming) return;
    stopAi();
    push(incoming.state, incoming.label);
    setPanel(null);
    setSelection(null);
  }, [incoming?.nonce]);

  // ---- AI に打たせる（思考は Web Worker） ----

  function askAi(state: GameState, legal: Action[]): Promise<Action> {
    aiWorker.current ??= new Worker(new URL("../ai/worker.ts", import.meta.url), { type: "module" });
    const w = aiWorker.current;
    const id = Math.floor(Math.random() * 2 ** 30);
    return new Promise((resolve, reject) => {
      w.onmessage = (e: MessageEvent<AgentResponse>) => {
        if (e.data.id !== id) return;
        if (e.data.action) resolve(e.data.action);
        else reject(new Error(`AI の思考でエラー: ${e.data.error ?? "手を選べませんでした"}`));
      };
      const request: AgentRequest = { id, agent: options.agent, state, legal, seed: Math.floor(Math.random() * 2 ** 30) };
      w.postMessage(request);
    });
  }

  function stopAi() {
    aiCancel.current?.();
    aiCancel.current = null;
    setAiRunning(false);
  }

  async function runAi(untilTurnEnd: boolean) {
    if (!current || aiRunning) return;
    let cancelled = false;
    aiCancel.current = () => {
      cancelled = true;
      aiWorker.current?.terminate();
      aiWorker.current = null;
    };
    setAiRunning(true);
    setError("");
    let state = current.state;
    const turn = state.turn;
    try {
      for (let i = 0; i < (untilTurnEnd ? MAX_AI_STEPS : 1); i++) {
        if (state.phase === "ended") break;
        const legal = legalActions(state);
        if (legal.length === 0) break;
        const action = await askAi(state, legal);
        if (cancelled) return;
        const next = applyAction(state, action);
        push(next, `AI: ${describeAction(state, action, NAMES, next)}`);
        state = next;
        // マリガンは両者のマリガンが終わるまで、メインフェイズはターンが変わるまで打つ
        if (state.phase === "main" && state.turn !== turn) break;
      }
    } catch (e) {
      if (!cancelled) setError(message(e));
    } finally {
      if (!cancelled) {
        aiCancel.current = null;
        setAiRunning(false);
      }
    }
  }

  // ---- 新しい局面・読み込み ----

  function create() {
    const rng = rngFrom({ rng: randomSeed() });
    const decks = options.decks.map((d) => resolveDeck(d, saved, rng));
    const [d0, d1] = decks;
    if (!d0 || !d1) {
      setError("選んだデッキが見つからないか、未完成です");
      return;
    }
    const first: PlayerIndex = options.first === "random" ? (rng.int(2) as PlayerIndex) : options.first === "1" ? 1 : 0;
    try {
      stopAi();
      push(sb.newSandbox([d0, d1], first, randomSeed()), "新しい局面");
      setPanel(null);
      setSelection(null);
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }

  const topBar = (
    <div class="banner">
      <button type="button" title="前の局面に戻す" onClick={() => go(history.index - 1)} disabled={aiRunning || history.index <= 0}>
        ← 戻す
      </button>
      <button type="button" title="戻した局面をやり直す" onClick={() => go(history.index + 1)} disabled={aiRunning || history.index >= history.entries.length - 1}>
        やり直す →
      </button>
      <button type="button" class={panel === "new" ? "active" : ""} onClick={() => setPanel(panel === "new" ? null : "new")}>
        新しい局面
      </button>
      <button type="button" class={panel === "io" ? "active" : ""} disabled={!current} onClick={() => setPanel(panel === "io" ? null : "io")}>
        書き出し・読み込み
      </button>
      {current && (
        <button type="button" title="表示だけ上下を入れ替えます" onClick={() => setBottom(opponent(bottom))}>
          上下を入れ替え（下: {NAMES[bottom]}）
        </button>
      )}
      <span class="muted">盤面・手札・リーダーを編集して、AI に考えさせたり、手を打ち比べたりできます</span>
    </div>
  );

  const newPanel = panel === "new" && (
    <div class="setup panel">
      {([0, 1] as const).map((p) => (
        <label key={p}>
          {NAMES[p]}（{p === 0 ? "最初は下" : "最初は上"}）のデッキ
          <DeckSelect
            value={options.decks[p]}
            saved={saved}
            onChange={(d) => setOptions({ decks: p === 0 ? [d, options.decks[1]] : [options.decks[0], d] })}
          />
        </label>
      ))}
      <label>
        先攻
        <select value={options.first} onChange={(e) => setOptions({ first: e.currentTarget.value as Options["first"] })}>
          <option value="0">{NAMES[0]}</option>
          <option value="1">{NAMES[1]}</option>
          <option value="random">ランダム</option>
        </select>
      </label>
      <p class="muted">両者が入れ替えなしでマリガンを済ませた、先攻の 1 ターン目から始めます。ターン・手札・場・山札・リーダーはあとから編集できます。</p>
      <div class="row-buttons">
        <button type="button" class="primary" onClick={create}>
          作る
        </button>
        {current && (
          <button type="button" onClick={() => setPanel(null)}>
            閉じる
          </button>
        )}
      </div>
    </div>
  );

  if (!current) {
    return (
      <div class="sandbox">
        {topBar}
        {error && <p class="problems">{error}</p>}
        {newPanel}
      </div>
    );
  }

  return (
    <SandboxView
      entry={current}
      history={history}
      topBar={topBar}
      newPanel={newPanel}
      ioPanel={panel === "io" && <IoPanel state={current.state} onImport={(s) => (push(s, "読み込んだ局面"), setPanel(null), setSelection(null))} />}
      error={error}
      selection={selection}
      setSelection={setSelection}
      bottom={bottom}
      options={options}
      setOptions={setOptions}
      aiRunning={aiRunning}
      runAi={runAi}
      stopAi={stopAi}
      apply={apply}
      play={(action) => {
        const s = current.state;
        apply(describeAction(s, action, NAMES), (x) => applyAction(x, action));
      }}
      go={go}
      seed={seed}
      branch={branch}
      thoughts={thoughts}
    />
  );
}

interface ViewProps {
  entry: Entry;
  history: History;
  topBar: preact.JSX.Element;
  newPanel: preact.JSX.Element | false;
  ioPanel: preact.JSX.Element | false;
  error: string;
  selection: Selection;
  setSelection: (s: Selection) => void;
  bottom: PlayerIndex;
  options: Options;
  setOptions: (o: Partial<Options>) => void;
  aiRunning: boolean;
  runAi: (untilTurnEnd: boolean) => void;
  stopAi: () => void;
  apply: (label: string, f: (s: GameState) => GameState) => boolean;
  play: (action: Action) => void;
  go: (index: number) => void;
  seed: number;
  branch: ReturnType<typeof useBranchRuns>;
  thoughts: ReturnType<typeof useThoughts>;
}

function SandboxView(v: ViewProps) {
  const { entry, history, selection, setSelection, apply, options } = v;
  const state = entry.state;
  const classes = useMemo(() => leaderClasses(state), [state]);
  const problems = useMemo(() => sb.sandboxProblems(state), [state]);
  const legal = useMemo(() => {
    try {
      return legalActions(state);
    } catch {
      return [];
    }
  }, [state]);
  const blocker = sb.editBlocker(state);
  const editable = !blocker && !v.aiRunning && problems.length === 0;
  const attackable = useMemo(() => (problems.length === 0 ? attackStatuses(state) : new Map()), [state, problems]);
  const actable = useMemo(
    () => new Set(state.phase === "main" && !state.pending ? legal.flatMap((a) => (a.type === "act" ? [a.iid] : [])) : []),
    [state, legal],
  );

  // 履歴の今の局面をログ上で見える位置に保つ
  const logRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    logRef.current?.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }, [history.index, history.entries.length]);

  const isSelected = (iid: number) => selection?.kind === "card" && selection.iid === iid;
  const isAdding = (p: PlayerIndex, zone: Zone) => selection?.kind === "add" && selection.player === p && selection.zone === zone;

  const side = (p: PlayerIndex, top: boolean) => {
    const pl = state.players[p];
    const canAddBoard = editable && pl.board.length < BOARD_LIMIT;
    const canAddHand = editable && pl.hand.length < HAND_LIMIT;
    const board = (
      <div class="board">
        {pl.board.map((c) => (
          <CardView
            key={c.iid}
            cardId={c.cardId}
            board={c}
            selected={isSelected(c.iid)}
            attackable={attackable.get(c.iid) ?? null}
            actable={actable.has(c.iid)}
            onClick={() => setSelection({ kind: "card", iid: c.iid })}
          />
        ))}
        {canAddBoard && (
          <button
            type="button"
            class={`slot-empty board-slot slot-add ${isAdding(p, "board") ? "selected" : ""}`}
            title="場にカードを置く"
            onClick={() => setSelection({ kind: "add", player: p, zone: "board" })}
          >
            ＋
          </button>
        )}
        <BoardSlots count={pl.board.length + (canAddBoard ? 1 : 0)} />
      </div>
    );
    const leader = (
      <div class="leader-row">
        <div
          class={`leader class-${classes[p]} ${selection?.kind === "leader" && selection.player === p ? "selected" : ""}`}
          title="クリックでリーダー・PP 等を編集"
          onClick={() => setSelection({ kind: "leader", player: p })}
        >
          {NAMES[p]} <LeaderHp hp={pl.leaderHp} max={pl.leaderMaxHp} />
        </div>
        <Resources state={state} p={p} />
      </div>
    );
    const info = (
      <div class="side-head">
        <PlayerInfo label={`${NAMES[p]}${state.first === p ? "（先攻）" : "（後攻）"}`} state={state} p={p} cls={classes[p]} />
        <button
          type="button"
          class={selection?.kind === "deck" && selection.player === p ? "active" : ""}
          onClick={() => setSelection({ kind: "deck", player: p })}
        >
          山札を見る
        </button>
      </div>
    );
    const hand = (
      <div class="hand">
        {pl.hand.map((h) => (
          <CardView
            key={h.iid}
            cardId={h.cardId}
            hand={h}
            pp={state.active === p && state.phase === "main" ? pl.pp : undefined}
            note={h.revealed ? "公開" : null}
            selected={isSelected(h.iid)}
            onClick={() => setSelection({ kind: "card", iid: h.iid })}
          />
        ))}
        {canAddHand && (
          <button
            type="button"
            class={`slot-empty slot-add ${isAdding(p, "hand") ? "selected" : ""}`}
            title="手札にカードを加える"
            onClick={() => setSelection({ kind: "add", player: p, zone: "hand" })}
          >
            ＋
          </button>
        )}
        <EmptySlots count={pl.hand.length + (canAddHand ? 1 : 0)} />
      </div>
    );
    return (
      <section class={`side ${top ? "opponent" : "me"}`}>
        {top ? (
          <>
            {info}
            {hand}
            {leader}
            {board}
          </>
        ) : (
          <>
            {board}
            {leader}
            {info}
            {hand}
          </>
        )}
      </section>
    );
  };

  const actor = actingPlayer(state);
  const agentLabel = AGENTS[options.agent]?.label ?? options.agent;
  const stepLabel = (id: number) => {
    const i = history.entries.findIndex((e) => e.id === id);
    return i < 0 ? "消えた局面" : `履歴の ${i + 1} 番目の局面`;
  };
  const analyzable = state.phase !== "ended" && legal.length > 0 && problems.length === 0;

  return (
    <div class="sandbox">
      {v.topBar}
      {v.newPanel}
      {v.ioPanel}
      {v.error && <p class="problems">{v.error}</p>}
      {problems.length > 0 && (
        <ul class="problems">
          {problems.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      <div class="game">
        {side(opponent(v.bottom), true)}
        {side(v.bottom, false)}
        <section class="controls">
          <TurnPanel key={entry.id} state={state} editable={editable} apply={apply} />
          <div class="banner column sandbox-actions">
            {state.phase === "ended" ? (
              <div>
                <strong>{state.winner !== null ? `${NAMES[state.winner]}の勝利` : "決着"}</strong>
                <span class="muted">（「戻す」で前の局面に戻れます）</span>
              </div>
            ) : (
              <ActionPicker key={entry.id} state={state} legal={legal} disabled={v.aiRunning} onPlay={v.play} />
            )}
            <div class="row-buttons">
              <label>
                AI{" "}
                <select value={options.agent} disabled={v.aiRunning} onChange={(e) => v.setOptions({ agent: e.currentTarget.value })}>
                  {Object.entries(AGENTS).map(([key, a]) => (
                    <option key={key} value={key}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
              {v.aiRunning ? (
                <>
                  <span class="muted">AI が打っています…</span>
                  <button type="button" onClick={v.stopAi}>
                    止める
                  </button>
                </>
              ) : (
                <>
                  <button type="button" disabled={!analyzable} onClick={() => v.runAi(false)}>
                    AI に 1 手打たせる
                  </button>
                  <button type="button" disabled={!analyzable} onClick={() => v.runAi(true)}>
                    AI にターンの終わりまで打たせる
                  </button>
                </>
              )}
            </div>
            <div class="muted">
              選んだ AI は、ここで打たせる手・「AI の考え」・打ち比べの続き（既定）に使います。
              AI から見えない相手の手札（「公開」でないもの）・山札の中身と、山札の順番は、考えるときと打ち比べで並べ直します。
            </div>
          </div>
          {analyzable && (
            <AiThought
              state={state}
              step={entry.id}
              names={NAMES}
              matchAgents={[options.agent, options.agent]}
              seed={v.seed}
              thoughts={v.thoughts}
              caption={`${NAMES[actor]}の手番で、${agentLabel}が比べた手と点数の内訳を出します`}
            />
          )}
          {analyzable && (
            <BranchCompare
              state={state}
              step={entry.id}
              names={NAMES}
              matchAgents={[options.agent, options.agent]}
              seed={v.seed}
              branch={v.branch}
              onJump={(id) => {
                const i = history.entries.findIndex((e) => e.id === id);
                if (i >= 0) v.go(i);
              }}
              stepLabel={stepLabel}
              caption={`${NAMES[actor]}の手を 2 つ以上選び、それぞれ打った後の続きを AI に打たせた勝率を比べます`}
              sameLabel="上で選んだ AI"
            />
          )}
        </section>
        <aside class="info">
          <div class="panel sandbox-editor">
            <Editor state={state} selection={selection} setSelection={setSelection} blocker={editable ? null : (blocker ?? (v.aiRunning ? "AI が打っているあいだは編集できません" : "局面に問題があるので編集できません（「戻す」で前の局面に戻れます）"))} apply={apply} options={options} setOptions={v.setOptions} classes={classes} />
          </div>
          <ol class="log replay-log" ref={logRef}>
            {history.entries.map((e, i) => (
              <li key={e.id} class={i === history.index ? "current" : i > history.index ? "muted" : ""} onClick={() => !v.aiRunning && v.go(i)}>
                {e.label}
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}

// ---- 手番・ターン ----

function TurnPanel({ state, editable, apply }: { state: GameState; editable: boolean; apply: ViewProps["apply"] }) {
  const [first, setFirst] = useState<PlayerIndex>(state.first);
  const [active, setActive] = useState<PlayerIndex>(state.active);
  const [own, setOwn] = useState(Math.max(1, state.players[state.active].turnCount));
  const [resetPp, setResetPp] = useState(true);
  const set = () =>
    apply(`ターンを${NAMES[active]}の ${own} ターン目（先攻 ${NAMES[first]}）の初めにする`, (s) => {
      const swapped =
        first === s.first
          ? s
          : sb.edit(s, (x) => {
              // 先攻を変えたら、エクストラPP を後攻のものにする
              x.first = first;
              x.players[first].extraPpAvailable = false;
              x.players[opponent(first)].extraPpAvailable = true;
            });
      return sb.setTurn(swapped, active, own, resetPp);
    });
  return (
    <div class="banner column sandbox-turn">
      <div>
        全体のターン {state.turn} / 手番: <strong>{NAMES[state.active]}</strong>（{NAMES[state.active]}の {state.players[state.active].turnCount} ターン目）
        {state.phase === "mulligan" && " / マリガン中"}
      </div>
      {editable && (
        <div class="row-buttons">
          <label>
            先攻{" "}
            <select value={first} onChange={(e) => setFirst(Number(e.currentTarget.value) as PlayerIndex)}>
              <option value={0}>{NAMES[0]}</option>
              <option value={1}>{NAMES[1]}</option>
            </select>
          </label>
          <label>
            手番{" "}
            <select value={active} onChange={(e) => setActive(Number(e.currentTarget.value) as PlayerIndex)}>
              <option value={0}>{NAMES[0]}</option>
              <option value={1}>{NAMES[1]}</option>
            </select>
          </label>
          <label>
            の{" "}
            <input type="number" min={1} max={30} value={own} onChange={(e) => setOwn(Math.max(1, Math.min(30, Math.floor(Number(e.currentTarget.value)) || 1)))} /> ターン目
          </label>
          <label class="check" title="両者の PP 最大値をターン数（上限 10）にし、PP を最大まで回復します">
            <input type="checkbox" checked={resetPp} onChange={(e) => setResetPp(e.currentTarget.checked)} />
            PP も合わせる
          </label>
          <button type="button" onClick={set}>
            ターンの初めにする
          </button>
        </div>
      )}
      {editable && <div class="muted">このターンに行ったこと（攻撃・進化・コンボ等）は消えます。進化は先攻 5・後攻 4 ターン目、超進化は先攻 7・後攻 6 ターン目から。</div>}
    </div>
  );
}

// ---- 打てる手 ----

function ActionPicker({ state, legal, disabled, onPlay }: { state: GameState; legal: Action[]; disabled: boolean; onPlay: (a: Action) => void }) {
  const labels = useMemo(() => actionLabels(state, legal, NAMES), [state, legal]);
  const [index, setIndex] = useState(0);
  const action = legal[index] ?? legal[0];
  if (legal.length === 0) return <div class="muted">打てる手がありません（局面に問題があります）</div>;
  return (
    <div class="row-buttons">
      <span>
        {NAMES[actingPlayer(state)]}の手（{legal.length}）
      </span>
      <select class="action-select" value={index} disabled={disabled} onChange={(e) => setIndex(Number(e.currentTarget.value))}>
        {labels.map((l, i) => (
          <option key={i} value={i}>
            {l}
          </option>
        ))}
      </select>
      <button type="button" class="primary" disabled={disabled || !action} onClick={() => action && onPlay(action)}>
        打つ
      </button>
    </div>
  );
}

// ---- 書き出し・読み込み ----

function IoPanel({ state, onImport }: { state: GameState; onImport: (s: GameState) => void }) {
  const text = useMemo(() => sb.exportSandbox(state), [state]);
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const load = () => {
    try {
      onImport(sb.importSandbox(input));
      setInput("");
      setError("");
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <div class="panel sandbox-io">
      <h2>今の局面を書き出す</h2>
      <textarea readOnly rows={3} value={text} onFocus={(e) => e.currentTarget.select()} />
      <div class="row-buttons">
        <button type="button" onClick={copy}>
          {copied ? "コピーしました" : "コピー"}
        </button>
        <span class="muted">局面の JSON です。読み込むと同じ局面を開けます。</span>
      </div>
      <h2>局面を読み込む</h2>
      <textarea rows={3} value={input} placeholder="書き出したテキストを貼り付け" onInput={(e) => setInput(e.currentTarget.value)} />
      <div class="row-buttons">
        <button type="button" class="primary" disabled={input.trim() === ""} onClick={load}>
          読み込む
        </button>
      </div>
      {error && <p class="problems">{error}</p>}
    </div>
  );
}

// ---- 右の欄（編集） ----

interface EditorProps {
  state: GameState;
  selection: Selection;
  setSelection: (s: Selection) => void;
  /** 編集できない理由（できるなら null） */
  blocker: string | null;
  apply: ViewProps["apply"];
  options: Options;
  setOptions: (o: Partial<Options>) => void;
  classes: [ClassId, ClassId];
}

function Editor(props: EditorProps) {
  const { state, selection, blocker } = props;
  if (!selection) return <div class="muted">カード・リーダーをクリックすると編集できます。「＋」でカードを加えます。</div>;
  if (selection.kind === "card") {
    const at = sb.findCard(state, selection.iid);
    if (!at) return <div class="muted">選んだカードは今の局面にありません。</div>;
    const card = cardOf(at.card.cardId);
    const where = `${NAMES[at.player]}の${ZONE_NAMES[at.zone]}`;
    return (
      <>
        <h3>
          {card.name}（{where}）
        </h3>
        {blocker ? (
          <div class="muted">{blocker}</div>
        ) : at.zone === "hand" ? (
          <HandEditor {...props} h={at.card} />
        ) : at.zone === "board" ? (
          at.card.kind === "follower" ? (
            <FollowerEditor {...props} c={at.card} />
          ) : (
            <AmuletEditor {...props} c={at.card} />
          )
        ) : (
          <div class="muted">山札にあります。山札の編集は「山札を見る」から。</div>
        )}
        <CardDetail card={card} />
      </>
    );
  }
  if (selection.kind === "leader") return <LeaderEditor {...props} p={selection.player} />;
  if (selection.kind === "deck") return <DeckEditor {...props} p={selection.player} />;
  return <CardPicker {...props} p={selection.player} zone={selection.zone} />;
}

function NumField({
  label,
  value,
  min,
  max,
  onCommit,
  title,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  title?: string;
}) {
  return (
    <label class="field" title={title}>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          const n = Math.floor(Number(raw));
          const v = raw.trim() === "" || !Number.isFinite(n) ? value : Math.max(min, Math.min(max, n));
          e.currentTarget.value = String(v);
          if (v !== value) onCommit(v);
        }}
      />
    </label>
  );
}

function CheckField({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label class="field check" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
      {label}
    </label>
  );
}

function MoveButtons({ iid, name, zone, apply, setSelection, toBoard }: { iid: number; name: string; zone: "hand" | "board"; apply: ViewProps["apply"]; setSelection: (s: Selection) => void; toBoard: boolean }) {
  const move = (to: "hand" | "board" | "deck" | "graveyard" | "none", label: string) => {
    if (apply(`${name}を${label}`, (s) => sb.moveCard(s, iid, to)) && (to === "graveyard" || to === "none" || to === "deck")) setSelection(null);
  };
  return (
    <div class="row-buttons">
      {zone === "hand" && toBoard && (
        <button type="button" title="能力（ファンファーレ等）は発動しません" onClick={() => move("board", "場に出した")}>
          場に出す
        </button>
      )}
      {zone === "board" && (
        <button type="button" onClick={() => move("hand", "手札に戻した")}>
          手札に戻す
        </button>
      )}
      <button type="button" onClick={() => move("deck", "山札に戻した")}>
        山札に戻す
      </button>
      <button type="button" title="墓場のカウントを 1 増やします（ラストワードは発動しません）" onClick={() => move("graveyard", "墓場に置いた")}>
        墓場に置く
      </button>
      <button type="button" title="跡を残さず取り除きます" onClick={() => move("none", "消した")}>
        消す
      </button>
    </div>
  );
}

function HandEditor({ h, apply, setSelection }: EditorProps & { h: HandCard }) {
  const card = cardOf(h.cardId);
  const set = (label: string, f: (x: HandCard) => void) => apply(`${card.name}の${label}`, (s) => sb.editHand(s, h.iid, f));
  return (
    <>
      <div class="fields">
        <NumField label="コストの増減" value={h.costMod} min={-20} max={20} onCommit={(v) => set(`コストの増減を ${v} に`, (x) => (x.costMod = v))} />
        {card.type === "follower" && (
          <>
            <NumField label="攻撃力の増減" value={h.attackMod} min={-20} max={50} onCommit={(v) => set(`攻撃力の増減を ${v} に`, (x) => (x.attackMod = v))} />
            <NumField label="体力の増減" value={h.defenseMod} min={-20} max={50} onCommit={(v) => set(`体力の増減を ${v} に`, (x) => (x.defenseMod = v))} />
          </>
        )}
        {hasSpellboost(h.cardId) && (
          <NumField label="スペルブースト" value={h.boosts} min={0} max={50} onCommit={(v) => set(`スペルブーストを ${v} に`, (x) => (x.boosts = v))} />
        )}
        {h.x !== null && <NumField label="X" value={h.x} min={0} max={50} onCommit={(v) => set(`X を ${v} に`, (x) => (x.x = v))} />}
        <CheckField
          label="公開（相手にも分かっている）"
          title="公開でない相手の手札は、AI が考えるときと打ち比べで、山札と混ぜて並べ直します"
          checked={h.revealed}
          onChange={(v) => set(v ? "公開にした" : "公開をやめた", (x) => (x.revealed = v))}
        />
      </div>
      <MoveButtons iid={h.iid} name={card.name} zone="hand" apply={apply} setSelection={setSelection} toBoard={card.type !== "spell"} />
    </>
  );
}

const EVOLVE_NAMES: Record<EvolveState, string> = { none: "なし", evolved: "進化", superEvolved: "超進化" };
const KEYWORDS = Object.keys(KEYWORD_NAMES) as StaticKeyword[];

function FollowerEditor({ state, c, apply, setSelection }: EditorProps & { c: FollowerOnBoard }) {
  const card = cardOf(c.cardId);
  const set = (label: string, f: (x: FollowerOnBoard) => void) => apply(`${card.name}の${label}`, (s) => sb.editFollower(s, c.iid, f));
  const innate = staticOf(c.cardId).keywords;
  const temp = [...c.tempKeywords.map((k) => KEYWORD_NAMES[k]), ...(c.tempAttack !== 0 ? [`攻撃力 ${c.tempAttack > 0 ? "+" : ""}${c.tempAttack}`] : [])];
  return (
    <>
      <div class="fields">
        <NumField label="攻撃力" value={c.attack} min={0} max={99} onCommit={(v) => set(`攻撃力を ${v} に`, (x) => (x.attack = v))} />
        <NumField
          label="体力"
          value={c.defense}
          min={1}
          max={99}
          onCommit={(v) =>
            set(`体力を ${v} に`, (x) => {
              x.defense = v;
              x.maxDefense = Math.max(x.maxDefense, v);
            })
          }
        />
        <NumField
          label="最大体力"
          value={c.maxDefense}
          min={1}
          max={99}
          onCommit={(v) =>
            set(`最大体力を ${v} に`, (x) => {
              x.maxDefense = v;
              x.defense = Math.min(x.defense, v);
            })
          }
        />
        <label class="field" title="攻撃力・体力を進化の分だけ増減します（進化時の能力は発動しません）">
          <span>進化</span>
          <select value={c.evolve} onChange={(e) => apply(`${card.name}を${EVOLVE_NAMES[e.currentTarget.value as EvolveState]}の状態に`, (s) => sb.setEvolve(s, c.iid, e.currentTarget.value as EvolveState))}>
            {(Object.keys(EVOLVE_NAMES) as EvolveState[]).map((k) => (
              <option key={k} value={k}>
                {EVOLVE_NAMES[k]}
              </option>
            ))}
          </select>
        </label>
        <NumField
          label={`攻撃した回数（最大 ${c.maxAttacks}）`}
          value={c.attacksThisTurn}
          min={0}
          max={c.maxAttacks}
          onCommit={(v) => set(`攻撃した回数を ${v} に`, (x) => (x.attacksThisTurn = v))}
        />
        {c.x !== null && <NumField label="X" value={c.x} min={0} max={50} onCommit={(v) => set(`X を ${v} に`, (x) => (x.x = v))} />}
        <CheckField
          label="このターンに場に出た"
          title="このターンに場に出たフォロワーは、疾走・突進・進化がなければ攻撃できません"
          checked={c.enteredTurn === state.turn}
          onChange={(v) => set(v ? "このターンに出たことに" : "前のターンから場にいることに", (x) => (x.enteredTurn = v ? state.turn : state.turn - 1))}
        />
      </div>
      <div class="field">
        <span>キーワード（色付きはカードが元から持つもの）</span>
        <div class="keyword-checks">
          {KEYWORDS.map((k) => (
            <label key={k} class={`check ${innate.includes(k) ? "innate" : ""}`}>
              <input
                type="checkbox"
                checked={c.keywords.includes(k)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  set(`${KEYWORD_NAMES[k]}を${on ? "付けた" : "外した"}`, (x) => (x.keywords = on ? [...x.keywords, k] : x.keywords.filter((y) => y !== k)));
                }}
              />
              {KEYWORD_NAMES[k]}
            </label>
          ))}
        </div>
      </div>
      {temp.length > 0 && <div class="muted">ターン終了まで: {temp.join("・")}</div>}
      <MoveButtons iid={c.iid} name={card.name} zone="board" apply={apply} setSelection={setSelection} toBoard={false} />
      <div class="muted">場に置いたカードの能力（ファンファーレ・進化時等）は発動しません。</div>
    </>
  );
}

function AmuletEditor({ c, apply, setSelection }: EditorProps & { c: AmuletOnBoard }) {
  const card = cardOf(c.cardId);
  const set = (label: string, f: (x: AmuletOnBoard) => void) => apply(`${card.name}の${label}`, (s) => sb.editAmulet(s, c.iid, f));
  return (
    <>
      <div class="fields">
        {c.countdown !== null && (
          <NumField label="カウントダウン" value={c.countdown} min={1} max={20} onCommit={(v) => set(`カウントダウンを ${v} に`, (x) => (x.countdown = v))} />
        )}
        {c.sigils !== null && <NumField label="印の数" value={c.sigils} min={1} max={20} onCommit={(v) => set(`印の数を ${v} に`, (x) => (x.sigils = v))} />}
        <CheckField label="このターンにアクトした" checked={c.actedThisTurn} onChange={(v) => set(v ? "アクトしたことに" : "アクトしていないことに", (x) => (x.actedThisTurn = v))} />
      </div>
      <MoveButtons iid={c.iid} name={card.name} zone="board" apply={apply} setSelection={setSelection} toBoard={false} />
      <div class="muted">場に置いたカードの能力（ファンファーレ等）は発動しません。</div>
    </>
  );
}

function LeaderEditor({ state, p, blocker, apply }: EditorProps & { p: PlayerIndex }) {
  const pl = state.players[p];
  const [crest, setCrest] = useState(ALL_CRESTS[0]?.id ?? "");
  const set = (label: string, f: (x: GameState["players"][0]) => void) => apply(`${NAMES[p]}の${label}`, (s) => sb.edit(s, (x) => f(x.players[p])));
  return (
    <>
      <h3>{NAMES[p]}のリーダー</h3>
      {blocker ? (
        <div class="muted">{blocker}</div>
      ) : (
        <>
          <div class="fields">
            <NumField label="体力" value={pl.leaderHp} min={1} max={pl.leaderMaxHp} onCommit={(v) => set(`体力を ${v} に`, (x) => (x.leaderHp = v))} />
            <NumField
              label="最大体力"
              value={pl.leaderMaxHp}
              min={1}
              max={99}
              onCommit={(v) =>
                set(`最大体力を ${v} に`, (x) => {
                  x.leaderMaxHp = v;
                  x.leaderHp = Math.min(x.leaderHp, v);
                })
              }
            />
            <NumField label="PP" value={pl.pp} min={0} max={pl.maxPp + 1} onCommit={(v) => set(`PP を ${v} に`, (x) => (x.pp = v))} />
            <NumField
              label="PP 最大値"
              value={pl.maxPp}
              min={0}
              max={MAX_PP}
              onCommit={(v) =>
                set(`PP 最大値を ${v} に`, (x) => {
                  x.maxPp = v;
                  x.pp = Math.min(x.pp, v + 1);
                })
              }
            />
            <NumField label="EP" value={pl.ep} min={0} max={9} onCommit={(v) => set(`EP を ${v} に`, (x) => (x.ep = v))} />
            <NumField label="SEP" value={pl.sep} min={0} max={9} onCommit={(v) => set(`SEP を ${v} に`, (x) => (x.sep = v))} />
            <NumField
              label="自分のターン数"
              title="進化・超進化が使えるかを決めます（上の「ターンの初めにする」なら全体のターンも合わせます）"
              value={pl.turnCount}
              min={0}
              max={99}
              onCommit={(v) => set(`ターン数を ${v} に`, (x) => (x.turnCount = v))}
            />
            <NumField label="墓場" value={pl.graveyard} min={0} max={99} onCommit={(v) => set(`墓場を ${v} に`, (x) => (x.graveyard = v))} />
            <NumField label="コンボ" value={pl.combo} min={0} max={30} onCommit={(v) => set(`コンボを ${v} に`, (x) => (x.combo = v))} />
            <CheckField label="エクストラPP を使える" checked={pl.extraPpAvailable} onChange={(v) => set(v ? "エクストラPP を使えるように" : "エクストラPP を使えないように", (x) => (x.extraPpAvailable = v))} />
            <CheckField
              label="このターンに進化した"
              checked={pl.evolvedThisTurn}
              onChange={(v) => set(v ? "このターンに進化したことに" : "このターンに進化していないことに", (x) => (x.evolvedThisTurn = v))}
            />
          </div>
          <div class="field">
            <span>クレスト</span>
            {pl.crests.length === 0 && <span class="muted">なし</span>}
            {pl.crests.map((c) => (
              <div key={c.iid} class="crest-row">
                <span class="crest-name">{crestName(c.crestId)}</span>
                {c.countdown !== null && (
                  <NumField
                    label="カウントダウン"
                    value={c.countdown}
                    min={1}
                    max={20}
                    onCommit={(v) =>
                      set(`${crestName(c.crestId)}のカウントダウンを ${v} に`, (x) => {
                        const y = x.crests.find((z) => z.iid === c.iid);
                        if (y) y.countdown = v;
                      })
                    }
                  />
                )}
                <button type="button" onClick={() => set(`${crestName(c.crestId)}を消した`, (x) => (x.crests = x.crests.filter((z) => z.iid !== c.iid)))}>
                  消す
                </button>
              </div>
            ))}
            <div class="crest-row">
              <select value={crest} onChange={(e) => setCrest(e.currentTarget.value)}>
                {ALL_CRESTS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => apply(`${NAMES[p]}に${crestName(crest)}を足した`, (s) => sb.addCrest(s, p, crest))}>
                足す
              </button>
            </div>
          </div>
          <div class="row-buttons">
            <button
              type="button"
              disabled={pl.hand.length === 0}
              onClick={() => apply(`${NAMES[p]}の手札をすべて山札に戻した`, (s) => pl.hand.reduce((x, h) => sb.moveCard(x, h.iid, "deck"), s))}
            >
              手札をすべて山札に戻す
            </button>
            <button
              type="button"
              disabled={pl.board.length === 0}
              onClick={() => apply(`${NAMES[p]}の場のカードをすべて消した`, (s) => pl.board.reduce((x, c) => sb.moveCard(x, c.iid, "none"), s))}
            >
              場のカードをすべて消す
            </button>
          </div>
        </>
      )}
    </>
  );
}

function DeckEditor({ state, p, blocker, apply, setSelection }: EditorProps & { p: PlayerIndex }) {
  const deck = state.players[p].deck;
  const groups = useMemo(() => {
    const count = new Map<string, number>();
    for (const c of deck) count.set(c.cardId, (count.get(c.cardId) ?? 0) + 1);
    return [...count.entries()].map(([id, n]) => ({ card: cardOf(id), n })).sort((a, b) => compareCards(a.card, b.card));
  }, [deck]);
  return (
    <>
      <h3>
        {NAMES[p]}の山札（{deck.length} 枚）
      </h3>
      {!blocker && (
        <div class="row-buttons">
          <button type="button" onClick={() => setSelection({ kind: "add", player: p, zone: "deck" })}>
            カードを足す
          </button>
          <button type="button" disabled={deck.length < 2} onClick={() => apply(`${NAMES[p]}の山札をシャッフルした`, (s) => sb.shuffleDeck(s, p, randomSeed()))}>
            シャッフル
          </button>
        </div>
      )}
      {blocker && <div class="muted">{blocker}</div>}
      <ul class="card-rows sandbox-rows">
        {groups.map(({ card, n }) => (
          <li key={card.id} class={`card-row class-${card.class}`}>
            <span class="row-main" title={card.text}>
              <span class="cost">{card.cost}</span>
              <span class="row-name">{card.name}</span>
            </span>
            <span class="row-count">×{n}</span>
            {!blocker && (
              <>
                <button type="button" aria-label={`${card.name}を山札から 1 枚抜く`} onClick={() => apply(`${NAMES[p]}の山札から${card.name}を抜いた`, (s) => sb.removeFromDeck(s, p, card.id))}>
                  −
                </button>
                <button type="button" aria-label={`${card.name}を山札に 1 枚足す`} onClick={() => apply(`${NAMES[p]}の山札に${card.name}を足した`, (s) => sb.addToDeck(s, p, card.id))}>
                  ＋
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div class="muted">
        山札の順番は、AI が考えるときと打ち比べでは並べ直します（相手の山札は中身も、公開でない手札と混ぜて並べ直します）。ここで打つ手や AI に打たせる手では、山札の上（この一覧ではなく実際の順番の先頭）から引きます。
      </div>
    </>
  );
}

/** 選べるカードの絞り込み */
type Owner = "all" | "class" | "neutral" | "token";

function CardPicker({ state, p, zone, blocker, apply, options, setOptions, classes, setSelection }: EditorProps & { p: PlayerIndex; zone: Zone }) {
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState<Owner>("all");
  const cls = classes[p];
  const pool = useMemo(
    () =>
      ALL_CARDS.filter((c) => zone !== "board" || c.type !== "spell")
        .filter((c) =>
          owner === "all" ? true : owner === "token" ? c.set === "token" : owner === "neutral" ? c.class === "neutral" && c.set !== "token" : c.class === cls && c.set !== "token",
        )
        .filter((c) => query === "" || c.name.includes(query) || c.text.includes(query))
        .sort((a, b) => Number(a.set === "token") - Number(b.set === "token") || compareCards(a, b)),
    [zone, owner, query, cls],
  );
  const SHOW = 80;
  const add = (c: Card) => {
    const label = `${NAMES[p]}の${ZONE_NAMES[zone]}に${c.name}を${zone === "board" ? "置いた" : "加えた"}`;
    apply(label, (s) =>
      zone === "hand" ? sb.addToHand(s, p, c.id, options.fromDeck) : zone === "board" ? sb.addToBoard(s, p, c.id, options.fromDeck) : sb.addToDeck(s, p, c.id),
    );
  };
  if (blocker) return <div class="muted">{blocker}</div>;
  const pl = state.players[p];
  const full = zone === "hand" ? pl.hand.length >= HAND_LIMIT : zone === "board" ? pl.board.length >= BOARD_LIMIT : false;
  return (
    <>
      <h3>
        {NAMES[p]}の{ZONE_NAMES[zone]}にカードを{zone === "board" ? "置く" : "加える"}
      </h3>
      <div class="filters">
        <input type="search" placeholder="カード名・能力で検索" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        <select value={owner} onChange={(e) => setOwner(e.currentTarget.value as Owner)}>
          <option value="all">すべて</option>
          {cls !== "neutral" && <option value="class">{CLASS_NAMES[cls]}</option>}
          <option value="neutral">ニュートラル</option>
          <option value="token">トークン</option>
        </select>
      </div>
      {zone !== "deck" && (
        <CheckField
          label="山札にあれば山札から取る"
          title="外すと、山札はそのままで新しくカードを作ります"
          checked={options.fromDeck}
          onChange={(v) => setOptions({ fromDeck: v })}
        />
      )}
      {full && <div class="problems">{ZONE_NAMES[zone]}が上限です</div>}
      <ul class="card-rows sandbox-rows">
        {pool.slice(0, SHOW).map((c) => (
          <li key={c.id} class={`card-row class-${c.class}`}>
            <button type="button" class="row-main" title={c.text || "（能力なし）"} disabled={full} onClick={() => add(c)}>
              <span class="cost">{c.cost}</span>
              <span class="row-name">{c.name}</span>
              <span class="row-meta">{c.type === "follower" ? `${c.attack}/${c.defense}` : TYPE_NAMES[c.type]}</span>
            </button>
          </li>
        ))}
      </ul>
      {pool.length > SHOW && <div class="muted">ほか {pool.length - SHOW} 枚。名前で絞り込んでください。</div>}
      <div class="row-buttons">
        <button type="button" onClick={() => setSelection(null)}>
          閉じる
        </button>
        {zone !== "board" && <span class="muted">{zone === "deck" ? "山札の上に足します" : "手札の右端に加えます"}</span>}
        {zone === "board" && <span class="muted">能力（ファンファーレ等）は発動しません</span>}
      </div>
    </>
  );
}
