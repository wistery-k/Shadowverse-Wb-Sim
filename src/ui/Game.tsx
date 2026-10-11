// 対戦画面（プレイヤー vs AI）

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { LethalRequest, LethalResponse } from "../ai/lethalWorker";
import type { AgentRequest, AgentResponse } from "../ai/worker";
import {
  actingPlayer,
  applyAction,
  cardOf,
  BOARD_LIMIT,
  EP,
  evolveTurnReached,
  HAND_LIMIT,
  leaderId,
  legalActions,
  opponent,
  rngFrom,
  SEP,
  superEvolveTurnReached,
  type Action,
  type GameState,
  type PlayerIndex,
} from "../engine";
import { CardDetail, CardView } from "./CardView";
import { CLASS_NAMES, type ClassId } from "../cards";
import { type AttackStatus, attackStatuses, crestName, describeAction, leaderClasses, modeLabels } from "./describe";

const AI_DELAY_MS = 700;
const AUTO_DELAY_MS = 400;

interface Props {
  initial: GameState;
  /** src/ai/registry.ts のキー */
  ai: string;
  /** 人間の席（既定は 0） */
  human?: PlayerIndex;
  onExit: () => void;
  /** 試合が終わったときに、行われた行動の列を渡す */
  onEnd?: (actions: Action[], final: GameState, autoActions: number[]) => void;
  /** このターンのリーサルの有無を表示し、「リーサルを取る」ボタンを出す */
  lethalHelper?: boolean;
  /** 終わった後の「もう一度」ボタンの文言 */
  exitLabel?: string;
}

const same = (a: Action, b: Action) => JSON.stringify(a) === JSON.stringify(b);

/** リーサル探索の状況 */
type LethalInfo = { status: "searching" } | { status: "found"; steps: Action[] } | { status: "none" } | { status: "broken" };

export function Game({ initial, ai, human = 0, onExit, onEnd, exitLabel = "もう一度", lethalHelper = false }: Props) {
  const HUMAN = human;
  const AI = opponent(human);
  const MY_LEADER = leaderId(HUMAN);
  const OPP_LEADER = leaderId(AI);
  const [state, setState] = useState(initial);
  // 行われた行動の列（記録用）
  const actionsRef = useRef<Action[]>([]);
  const endedRef = useRef(false);
  // 「リーサルを取る」で自動で行った行動の番号（actionsRef の添字）
  const autoRef = useRef<number[]>([]);
  const [lethal, setLethal] = useState<LethalInfo | null>(null);
  // 自動で行う残りの手順
  const [autoSteps, setAutoSteps] = useState<Action[]>([]);
  const [lethalRng] = useState(() => rngFrom({ rng: (initial.rng ^ 0x27d4eb2f) >>> 0 }));
  const lethalWorker = useRef<Worker | null>(null);
  useEffect(() => () => lethalWorker.current?.terminate(), []);
  const [log, setLog] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [picks, setPicks] = useState<number[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [aiRng] = useState(() => rngFrom({ rng: (initial.rng ^ 0x5bd1e995) >>> 0 }));
  const [aiThinking, setAiThinking] = useState(false);
  const worker = useRef<Worker | null>(null);
  useEffect(() => {
    worker.current = new Worker(new URL("../ai/worker.ts", import.meta.url), { type: "module" });
    return () => worker.current?.terminate();
  }, []);

  const classes = useMemo(() => leaderClasses(initial), [initial]);
  const legal = useMemo(() => legalActions(state), [state]);
  const acting = actingPlayer(state);
  const myTurn = state.phase !== "ended" && acting === HUMAN;

  function advance(action: Action, auto = false) {
    const next = applyAction(state, action);
    if (auto) autoRef.current.push(actionsRef.current.length);
    actionsRef.current.push(action);
    setLog((l) => [describeAction(state, action, HUMAN), ...l].slice(0, 200));
    setState(next);
    if (next.phase === "ended" && !endedRef.current) {
      endedRef.current = true;
      onEnd?.([...actionsRef.current], next, [...autoRef.current]);
    }
  }

  function act(action: Action) {
    setAutoSteps([]);
    advance(action);
    setSelected(null);
    setPicks([]);
  }

  // AI の手番（思考は Worker で行う。最低でも AI_DELAY_MS は待って、操作を目で追えるようにする）
  useEffect(() => {
    const w = worker.current;
    if (state.phase === "ended" || acting !== AI || !w) return;
    let cancelled = false;
    const id = aiRng.int(2 ** 30);
    const started = Date.now();
    setAiThinking(true);
    w.onmessage = (e: MessageEvent<AgentResponse>) => {
      const res = e.data;
      if (cancelled || res.id !== id) return;
      const action = res.action ?? legal.find((a) => a.type === "endTurn") ?? legal[0];
      if (res.error) console.error("AI の思考でエラー:", res.error);
      if (!action) return;
      setTimeout(() => {
        if (cancelled) return;
        setAiThinking(false);
        advance(action);
      }, Math.max(0, AI_DELAY_MS - (Date.now() - started)));
    };
    const request: AgentRequest = { id, agent: ai, state, legal, seed: aiRng.int(2 ** 30) };
    w.postMessage(request);
    return () => {
      cancelled = true;
    };
  }, [state]);

  // 自分の手番では、局面が変わるたびにこのターンのリーサルを探す（前の探索は Worker ごと止める）
  useEffect(() => {
    lethalWorker.current?.terminate();
    lethalWorker.current = null;
    if (!lethalHelper || !myTurn || state.phase !== "main" || state.active !== HUMAN) {
      setLethal(null);
      return;
    }
    if (autoSteps.length > 0) return;
    const w = new Worker(new URL("../ai/lethalWorker.ts", import.meta.url), { type: "module" });
    lethalWorker.current = w;
    const id = lethalRng.int(2 ** 30);
    setLethal((l) => (l?.status === "broken" ? l : { status: "searching" }));
    w.onmessage = (e: MessageEvent<LethalResponse>) => {
      if (e.data.id !== id) return;
      if (e.data.error) console.error("リーサル探索でエラー:", e.data.error);
      setLethal(e.data.steps ? { status: "found", steps: e.data.steps } : { status: "none" });
      w.terminate();
      if (lethalWorker.current === w) lethalWorker.current = null;
    };
    const request: LethalRequest = { id, state, player: HUMAN, seed: lethalRng.int(2 ** 30) };
    w.postMessage(request);
  }, [state, autoSteps.length === 0]);

  // 「リーサルを取る」: 見つけた手順を、操作を目で追えるよう間をあけて 1 手ずつ行う。
  // 実際の局面では手順どおりに打てないことがある（ランダムな効果・見えない情報）ので、そのときは止めて探し直す
  useEffect(() => {
    const step = autoSteps[0];
    if (!step || !myTurn) return;
    const t = setTimeout(() => {
      if (!legal.some((a) => same(a, step))) {
        setAutoSteps([]);
        setLethal({ status: "broken" });
        return;
      }
      setAutoSteps(autoSteps.slice(1));
      setSelected(null);
      setPicks([]);
      advance(step, true);
    }, AUTO_DELAY_MS);
    return () => clearTimeout(t);
  }, [state, autoSteps]);

  const me = state.players[HUMAN];
  const opp = state.players[AI];
  const pending = myTurn ? state.pending : null;
  const mulligan = myTurn && state.phase === "mulligan";

  // 選択中のカードでできる行動
  const selectedActions = selected === null ? [] : legal.filter((a) => actionSubject(a) === selected);
  const attackTargets = new Set(
    selectedActions.flatMap((a) => (a.type === "attack" ? [a.target === "leader" ? OPP_LEADER : a.target] : [])),
  );
  const candidates = new Set(pending?.kind === "choose" ? pending.candidates : []);
  const attackable = myTurn && !mulligan ? attackStatuses(state, legal) : new Map<number, AttackStatus>();
  const readyIds = new Set(myTurn && !pending && !mulligan ? legal.map(actionSubject).filter((x) => x !== null) : []);

  function clickEntity(iid: number) {
    setDetailFor(iid);
    if (!myTurn) return;
    if (mulligan || (pending?.kind === "choose" && candidates.has(iid))) {
      setPicks((p) => (p.includes(iid) ? p.filter((x) => x !== iid) : [...p, iid]));
      return;
    }
    if (pending) return;
    if (selected !== null && attackTargets.has(iid)) {
      const target = iid === OPP_LEADER ? "leader" : iid;
      const a = selectedActions.find((x) => x.type === "attack" && x.target === target);
      if (a) act(a);
      return;
    }
    setSelected(selected === iid ? null : iid);
  }

  function setDetailFor(iid: number) {
    const card = [...me.hand, ...me.board, ...opp.board].find((c) => c.iid === iid);
    if (card) setDetail(card.cardId);
  }

  const confirmPick = () => {
    if (mulligan) {
      const a = legal.find((x) => x.type === "mulligan" && sameSet(x.swap, picks));
      if (a) act(a);
    } else if (pending?.kind === "choose") {
      const a = legal.find((x) => x.type === "choose" && sameSet(x.targets, picks));
      if (a) act(a);
    }
  };

  const endTurn = legal.find((a) => a.type === "endTurn");
  const extraPp = legal.find((a) => a.type === "extraPp");

  return (
    <div class="game">
      <section class="side opponent">
        <PlayerInfo label="相手" state={state} p={AI} cls={classes[AI]} />
        <div class="hand-backs">
          {opp.hand.map((h) => (
            <span class="card-back" key={h.iid} />
          ))}
        </div>
        <div
          class={`leader class-${classes[AI]} ${attackTargets.has(OPP_LEADER) ? "targetable" : ""} ${candidates.has(OPP_LEADER) ? "targetable" : ""} ${picks.includes(OPP_LEADER) ? "selected" : ""}`}
          onClick={() => clickEntity(OPP_LEADER)}
        >
          相手リーダー {opp.leaderHp}/{opp.leaderMaxHp}
        </div>
        <div class="board">
          {opp.board.map((c) => (
            <CardView
              key={c.iid}
              cardId={c.cardId}
              board={c}
              targetable={attackTargets.has(c.iid) || candidates.has(c.iid)}
              selected={picks.includes(c.iid)}
              onClick={() => clickEntity(c.iid)}
            />
          ))}
          <BoardSlots count={opp.board.length} />
        </div>
      </section>

      <section class="side me">
        <div class="board">
          {me.board.map((c) => (
            <CardView
              key={c.iid}
              cardId={c.cardId}
              board={c}
              selected={selected === c.iid || picks.includes(c.iid)}
              targetable={candidates.has(c.iid)}
              ready={readyIds.has(c.iid)}
              attackable={attackable.get(c.iid) ?? null}
              onClick={() => clickEntity(c.iid)}
            />
          ))}
          <BoardSlots count={me.board.length} />
        </div>
        <div
          class={`leader class-${classes[HUMAN]} ${candidates.has(MY_LEADER) ? "targetable" : ""} ${picks.includes(MY_LEADER) ? "selected" : ""}`}
          onClick={() => clickEntity(MY_LEADER)}
        >
          あなたのリーダー {me.leaderHp}/{me.leaderMaxHp}
        </div>
        <PlayerInfo label="あなた" state={state} p={HUMAN} cls={classes[HUMAN]} extraPpUsable={!!extraPp && myTurn} />
        <div class="hand">
          {me.hand.map((h) => (
            <CardView
              key={h.iid}
              cardId={h.cardId}
              hand={h}
              selected={selected === h.iid || picks.includes(h.iid)}
              targetable={candidates.has(h.iid)}
              ready={readyIds.has(h.iid)}
              onClick={() => clickEntity(h.iid)}
            />
          ))}
          <EmptySlots count={me.hand.length} />
        </div>
      </section>

      <section class="controls">
        {lethal && myTurn && (
          <div class="banner lethal">
            {autoSteps.length > 0 ? (
              <span>リーサルを取っています…（残り {autoSteps.length} 手）</span>
            ) : lethal.status === "searching" ? (
              <span class="muted">このターンのリーサルを調べています…</span>
            ) : lethal.status === "found" ? (
              <>
                <strong>リーサルがあります（{lethal.steps.length} 手）</strong>
                <button type="button" class="primary" onClick={() => setAutoSteps(lethal.steps)}>
                  リーサルを取る
                </button>
              </>
            ) : lethal.status === "broken" ? (
              <span>手順どおりに打てなかったので止めました</span>
            ) : (
              <span class="muted">このターンのリーサルは見つかりません</span>
            )}
          </div>
        )}
        {state.phase === "ended" ? (
          <div class="banner">
            {state.winner === HUMAN ? "あなたの勝利" : "あなたの敗北"}
            <button type="button" onClick={onExit}>
              {exitLabel}
            </button>
          </div>
        ) : !myTurn ? (
          <div class="banner muted">{aiThinking ? "相手が考えています…" : "相手の手番です…"}</div>
        ) : mulligan ? (
          <div class="banner">
            入れ替えるカードを選んでください（{picks.length}枚）
            <button type="button" onClick={confirmPick}>
              決定
            </button>
          </div>
        ) : pending?.kind === "choose" ? (
          <div class="banner">
            対象を{pending.count}枚選んでください（{picks.length}/{pending.count}）
            <button type="button" disabled={picks.length !== pending.count} onClick={confirmPick}>
              決定
            </button>
          </div>
        ) : pending?.kind === "mode" ? (
          <div class="banner column">
            能力を1つ選んでください
            {modeLabels(state).map((label, index) => (
              <button type="button" key={index} onClick={() => act({ type: "mode", index })}>
                {label}
              </button>
            ))}
          </div>
        ) : (
          <div class="banner">
            {selectedActions
              .filter((a) => a.type !== "attack")
              .map((a) => (
                <button type="button" key={JSON.stringify(a)} onClick={() => act(a)}>
                  {actionLabel(state, a)}
                </button>
              ))}
            {selectedActions.some((a) => a.type === "attack") && <span class="muted">攻撃先をクリック</span>}
            {extraPp && (
              <button type="button" class="extra-pp usable" onClick={() => act(extraPp)}>
                エクストラPP（+1）
              </button>
            )}
            {endTurn && (
              <button type="button" class="end-turn" onClick={() => act(endTurn)}>
                ターン終了
              </button>
            )}
          </div>
        )}
      </section>

      <aside class="info">
        {detail ? <CardDetail card={cardOf(detail)} /> : <div class="muted">カードをクリックすると詳細を表示します</div>}
        <ol class="log">
          {log.map((line, i) => (
            <li key={log.length - i}>{line}</li>
          ))}
        </ol>
      </aside>
    </div>
  );
}

function sameSet(a: readonly number[], b: readonly number[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** アクションの主体（クリックするカード） */
function actionSubject(a: Action): number | null {
  switch (a.type) {
    case "play":
    case "evolve":
    case "superEvolve":
    case "act":
      return a.iid;
    case "attack":
      return a.attacker;
    case "fuse":
      return a.host;
    default:
      return null;
  }
}

function actionLabel(state: GameState, a: Action): string {
  switch (a.type) {
    case "play":
      return "プレイ";
    case "evolve":
      return "進化";
    case "superEvolve":
      return "超進化";
    case "act":
      return "アクト";
    case "fuse":
      return `融合: ${a.materials.map((m) => cardOf(state.players[state.active].hand.find((h) => h.iid === m)?.cardId ?? "").name).join("・")}`;
    default:
      return a.type;
  }
}

/** EP（黄）・SEP（紫）を丸で表示する。使ったぶんは中抜き。まだ使えるターンでなければ薄く表示する */
function Points({ kind, left, max, locked = false }: { kind: "ep" | "sep"; left: number; max: number; locked?: boolean }) {
  const label = kind === "ep" ? "EP" : "SEP";
  const note = locked ? (kind === "sep" ? "（超進化可能なターンになるまで使えません）" : "（進化可能なターンになるまで使えません）") : "";
  return (
    <span class={`points ${locked ? "locked" : ""}`} title={`${label} ${left}/${max}${note}`}>
      {label}
      {Array.from({ length: Math.max(max, left) }, (_, i) => (
        <span key={i} class={`point ${kind} ${i < left ? "" : "used"}`} />
      ))}
    </span>
  );
}

/** 場の空き（上限まで点線の枠を並べる） */
export function BoardSlots({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: Math.max(0, BOARD_LIMIT - count) }, (_, i) => (
        <span key={`empty-${i}`} class="slot-empty board-slot" />
      ))}
    </>
  );
}

/** 手札の空き（上限まで点線の枠を並べる） */
export function EmptySlots({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: Math.max(0, HAND_LIMIT - count) }, (_, i) => (
        <span key={`empty-${i}`} class="slot-empty" />
      ))}
    </>
  );
}

export function PlayerInfo({
  label,
  state,
  p,
  cls,
  extraPpUsable = false,
}: {
  label: string;
  state: GameState;
  p: PlayerIndex;
  /** プレイヤーのクラス（表示する場合） */
  cls?: ClassId;
  /** エクストラPPを今使えるか（強調する） */
  extraPpUsable?: boolean;
}) {
  const pl = state.players[p];
  const active = state.active === p && state.phase === "main";
  return (
    <div class={`player-info ${active ? "active" : ""}`}>
      <strong>{label}</strong>
      {cls && <span class={`class-tag class-${cls}`}>{CLASS_NAMES[cls]}</span>}
      <span>
        PP {pl.pp}/{pl.maxPp}
      </span>
      {pl.extraPpAvailable && <span class={`expp-badge ${extraPpUsable ? "usable" : ""}`}>エクストラPP</span>}
      <Points kind="ep" left={pl.ep} max={EP} locked={!evolveTurnReached(state, p)} />
      <Points kind="sep" left={pl.sep} max={SEP} locked={!superEvolveTurnReached(state, p)} />
      <span>手札 {pl.hand.length}</span>
      <span>山札 {pl.deck.length}</span>
      <span>墓場 {pl.graveyard}</span>
      {state.players[p].combo > 0 && active && <span>コンボ {pl.combo}</span>}
      {pl.crests.map((c) => (
        <span class="badge" key={c.iid}>
          {crestName(c.crestId)}
          {c.countdown !== null ? ` (${c.countdown})` : ""}
        </span>
      ))}
      {state.turn > 0 && p === state.active && <span class="muted">ターン {state.turn}</span>}
    </div>
  );
}
