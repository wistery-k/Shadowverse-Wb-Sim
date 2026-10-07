// 対戦画面（プレイヤー vs AI）

import { useEffect, useMemo, useState } from "preact/hooks";
import type { Agent } from "../ai/types";
import {
  actingPlayer,
  applyAction,
  cardOf,
  legalActions,
  rngFrom,
  type Action,
  type GameState,
  type PlayerIndex,
} from "../engine";
import { CardDetail, CardView } from "./CardView";
import { crestName, describeAction, modeLabels } from "./describe";

const HUMAN: PlayerIndex = 0;
const AI: PlayerIndex = 1;
const AI_DELAY_MS = 700;

interface Props {
  initial: GameState;
  ai: Agent;
  onExit: () => void;
}

const same = (a: Action, b: Action) => JSON.stringify(a) === JSON.stringify(b);

export function Game({ initial, ai, onExit }: Props) {
  const [state, setState] = useState(initial);
  const [log, setLog] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [picks, setPicks] = useState<number[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [aiRng] = useState(() => rngFrom({ rng: (initial.rng ^ 0x5bd1e995) >>> 0 }));

  const legal = useMemo(() => legalActions(state), [state]);
  const acting = actingPlayer(state);
  const myTurn = state.phase !== "ended" && acting === HUMAN;

  function act(action: Action) {
    setLog((l) => [describeAction(state, action, HUMAN), ...l].slice(0, 200));
    setState(applyAction(state, action));
    setSelected(null);
    setPicks([]);
  }

  // AI の手番
  useEffect(() => {
    if (state.phase === "ended" || acting !== AI) return;
    const timer = setTimeout(() => {
      const action = ai.chooseAction(state, legal, aiRng);
      setLog((l) => [describeAction(state, action, HUMAN), ...l].slice(0, 200));
      setState(applyAction(state, action));
    }, AI_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const me = state.players[HUMAN];
  const opp = state.players[AI];
  const pending = myTurn ? state.pending : null;
  const mulligan = myTurn && state.phase === "mulligan";

  // 選択中のカードでできる行動
  const selectedActions = selected === null ? [] : legal.filter((a) => actionSubject(a) === selected);
  const attackTargets = new Set(
    selectedActions.flatMap((a) => (a.type === "attack" ? [a.target === "leader" ? -2 : a.target] : [])),
  );
  const candidates = new Set(pending?.kind === "choose" ? pending.candidates : []);
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
      const target = iid === -2 ? "leader" : iid;
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
        <PlayerInfo label="相手" state={state} p={AI} />
        <div class="hand-backs">
          {opp.hand.map((h) => (
            <span class="card-back" key={h.iid} />
          ))}
        </div>
        <div
          class={`leader ${attackTargets.has(-2) ? "targetable" : ""} ${candidates.has(-2) ? "targetable" : ""} ${picks.includes(-2) ? "selected" : ""}`}
          onClick={() => clickEntity(-2)}
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
              onClick={() => clickEntity(c.iid)}
            />
          ))}
        </div>
        <div
          class={`leader ${candidates.has(-1) ? "targetable" : ""} ${picks.includes(-1) ? "selected" : ""}`}
          onClick={() => clickEntity(-1)}
        >
          あなたのリーダー {me.leaderHp}/{me.leaderMaxHp}
        </div>
        <PlayerInfo label="あなた" state={state} p={HUMAN} />
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
        </div>
      </section>

      <section class="controls">
        {state.phase === "ended" ? (
          <div class="banner">
            {state.winner === HUMAN ? "あなたの勝利" : "あなたの敗北"}
            <button type="button" onClick={onExit}>
              もう一度
            </button>
          </div>
        ) : !myTurn ? (
          <div class="banner muted">相手の手番です…</div>
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
              <button type="button" class="extra-pp" onClick={() => act(extraPp)}>
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

function PlayerInfo({ label, state, p }: { label: string; state: GameState; p: PlayerIndex }) {
  const pl = state.players[p];
  const active = state.active === p && state.phase === "main";
  return (
    <div class={`player-info ${active ? "active" : ""}`}>
      <strong>{label}</strong>
      <span>
        PP {pl.pp}/{pl.maxPp}
      </span>
      {pl.extraPpAvailable && <span class="badge">エクストラPP</span>}
      <span>EP {pl.ep}</span>
      <span>SEP {pl.sep}</span>
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
