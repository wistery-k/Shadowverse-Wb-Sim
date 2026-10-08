// AI 対戦の試合を再生する画面（両者の手札を公開して表示する）

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { cardOf, type PlayerIndex } from "../engine";
import { replayStates } from "../sim/replay";
import { seatDecks, type Entrant, type GameRecord } from "../sim/tournament";
import { CardDetail, CardView } from "./CardView";
import { describeAction } from "./describe";
import { PlayerInfo } from "./Game";

interface Props {
  record: GameRecord;
  entrants: readonly Entrant[];
  onClose: () => void;
}

const SPEEDS = [
  { ms: 1000, label: "遅い" },
  { ms: 500, label: "普通" },
  { ms: 200, label: "速い" },
];

export function Replay({ record, entrants, onClose }: Props) {
  const actions = record.actions ?? [];
  const states = useMemo(() => replayStates(seatDecks(record, entrants), record.seed, actions), [record, entrants]);
  const names = useMemo((): [string, string] => {
    const ea = entrants[record.a]!.name;
    const eb = entrants[record.b]!.name;
    const [n0, n1] = record.aIsPlayer0 ? [ea, eb] : [eb, ea];
    // ミラーで同じ名前になるときは席で区別する
    return n0 === n1 ? [`${n0}（P1）`, `${n1}（P2）`] : [n0, n1];
  }, [record, entrants]);
  const lines = useMemo(() => actions.map((a, i) => describeAction(states[i]!, a, names)), [states, names]);
  // ターンの区切り: ターン終了の直後の局面
  const turnStarts = useMemo(() => [0, ...actions.flatMap((a, i) => (a.type === "endTurn" ? [i + 1] : []))], [actions]);

  const last = states.length - 1;
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SPEEDS[1]!.ms);
  const [detail, setDetail] = useState<string | null>(null);
  const go = (s: number) => setStep(Math.max(0, Math.min(last, s)));

  useEffect(() => {
    if (!playing) return;
    if (step >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => Math.min(last, s + 1)), speed);
    return () => clearTimeout(t);
  }, [playing, step, speed, last]);

  const prevTurn = () => go([...turnStarts].reverse().find((s) => s < step) ?? 0);
  const nextTurn = () => go(turnStarts.find((s) => s > step) ?? last);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "ArrowLeft") (e.shiftKey ? prevTurn : () => go(step - 1))();
      else if (e.key === "ArrowRight") (e.shiftKey ? nextTurn : () => go(step + 1))();
      else return;
      e.preventDefault();
      setPlaying(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 現在の行動をログ上で見える位置に保つ
  const logRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    logRef.current?.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }, [step]);

  const state = states[step]!;
  const winnerName = record.seats ? names[record.seats.winner] : "なし";

  const side = (p: PlayerIndex, top: boolean) => {
    const pl = state.players[p];
    const board = (
      <div class="board">
        {pl.board.map((c) => (
          <CardView key={c.iid} cardId={c.cardId} board={c} onClick={() => setDetail(c.cardId)} />
        ))}
      </div>
    );
    const leader = (
      <div class="leader">
        リーダー {pl.leaderHp}/{pl.leaderMaxHp}
      </div>
    );
    const info = <PlayerInfo label={`${names[p]}${state.first === p ? "（先攻）" : "（後攻）"}`} state={state} p={p} />;
    const hand = (
      <div class="hand">
        {pl.hand.map((h) => (
          <CardView key={h.iid} cardId={h.cardId} hand={h} onClick={() => setDetail(h.cardId)} />
        ))}
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

  return (
    <div class="replay">
      <div class="banner">
        <button type="button" onClick={onClose}>
          ← 結果に戻る
        </button>
        <span>
          {names[0]} vs {names[1]} / 勝者: {winnerName} / {record.turns} ターン / seed {record.seed}
        </span>
      </div>
      <div class="game">
        {side(1, true)}
        {side(0, false)}
        <section class="controls">
          <div class="banner column">
            <div class="replay-buttons">
              <button type="button" onClick={() => go(0)} disabled={step === 0}>
                最初
              </button>
              <button type="button" title="Shift+←" onClick={prevTurn} disabled={step === 0}>
                前のターン
              </button>
              <button type="button" title="←" onClick={() => go(step - 1)} disabled={step === 0}>
                戻る
              </button>
              <button
                type="button"
                class="primary"
                onClick={() => {
                  if (step >= last) setStep(0);
                  setPlaying(!playing);
                }}
              >
                {playing ? "一時停止" : "再生"}
              </button>
              <button type="button" title="→" onClick={() => go(step + 1)} disabled={step === last}>
                進む
              </button>
              <button type="button" title="Shift+→" onClick={nextTurn} disabled={step === last}>
                次のターン
              </button>
              <button type="button" onClick={() => go(last)} disabled={step === last}>
                最後
              </button>
              <select value={speed} onChange={(e) => setSpeed(Number(e.currentTarget.value))}>
                {SPEEDS.map((s) => (
                  <option key={s.ms} value={s.ms}>
                    {s.label}
                  </option>
                ))}
              </select>
              <span class="muted">
                {step}/{last} 手
              </span>
            </div>
            <input type="range" min={0} max={last} value={step} onInput={(e) => go(Number(e.currentTarget.value))} />
            <div>
              {step === 0 ? "対戦開始" : `直前: ${lines[step - 1]}`}
              {step === last && state.phase === "ended" && <strong> — {winnerName}の勝利</strong>}
            </div>
            {step < last && <div class="muted">次: {lines[step]}</div>}
          </div>
        </section>
        <aside class="info">
          {detail ? <CardDetail card={cardOf(detail)} /> : <div class="muted">カードをクリックすると詳細を表示します</div>}
          <ol class="log replay-log" ref={logRef}>
            {lines.map((line, i) => (
              <li key={i} class={i === step - 1 ? "current" : i >= step ? "muted" : ""} onClick={() => go(i + 1)}>
                {line}
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}
