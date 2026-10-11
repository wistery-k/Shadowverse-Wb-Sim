// AI 対戦の試合を再生する画面（両者の手札を公開して表示する）

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AGENTS } from "../ai/registry";
import { cardOf, legalActions, opponent, type PlayerIndex } from "../engine";
import { replayStates } from "../sim/replay";
import { reproduceCommand } from "../sim/reproduce";
import { seatDecks, type Entrant, type GameRecord } from "../sim/tournament";
import { CardDetail, CardView, type Motion } from "./CardView";
import { describeAction, leaderClasses } from "./describe";
import { EmptySlots, PlayerInfo } from "./Game";

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
  const classes = useMemo(() => leaderClasses(states[0]!), [states]);
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
  // 下に表示するプレイヤー（表示だけの入れ替え）
  const [bottom, setBottom] = useState<PlayerIndex>(0);
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

  // 攻撃できるフォロワー（リーダーにも攻撃できるか）
  const attackable = useMemo(() => {
    const m = new Map<number, "follower" | "leader">();
    if (state.phase !== "main" || state.pending) return m;
    for (const a of legalActions(state)) {
      if (a.type !== "attack") continue;
      if (a.target === "leader") m.set(a.attacker, "leader");
      else if (!m.has(a.attacker)) m.set(a.attacker, "follower");
    }
    return m;
  }, [state]);

  // 直前の行動の動き: 場に出たフォロワー・攻撃したフォロワーと攻撃されたもの
  const { motions, leaderHit } = useMemo(() => {
    const motions = new Map<number, Motion>();
    let leaderHit: PlayerIndex | null = null;
    const prev = step > 0 ? states[step - 1]! : null;
    const action = step > 0 ? actions[step - 1] : undefined;
    if (prev) {
      for (const p of [0, 1] as const) {
        const before = new Set(prev.players[p].board.map((c) => c.iid));
        for (const c of state.players[p].board) if (c.kind === "follower" && !before.has(c.iid)) motions.set(c.iid, "summon");
      }
    }
    if (prev && action?.type === "attack") {
      motions.set(action.attacker, prev.active === bottom ? "attack-up" : "attack-down");
      if (action.target === "leader") leaderHit = opponent(prev.active);
      else motions.set(action.target, "hit");
    }
    return { motions, leaderHit };
  }, [states, step, bottom]);

  const side = (p: PlayerIndex, top: boolean) => {
    const pl = state.players[p];
    const board = (
      <div class="board">
        {pl.board.map((c) => {
          const motion = motions.get(c.iid) ?? null;
          return (
            <CardView
              // 動きがあるときは作り直して、同じカードでもアニメーションを最初から再生する
              key={motion ? `${c.iid}-${step}` : c.iid}
              cardId={c.cardId}
              board={c}
              attackable={attackable.get(c.iid) ?? null}
              motion={motion}
              onClick={() => setDetail(c.cardId)}
            />
          );
        })}
      </div>
    );
    const leader = (
      <div key={leaderHit === p ? `leader-${step}` : "leader"} class={`leader class-${classes[p]} ${leaderHit === p ? "motion-hit" : ""}`}>
        リーダー {pl.leaderHp}/{pl.leaderMaxHp}
      </div>
    );
    const info = <PlayerInfo label={`${names[p]}${state.first === p ? "（先攻）" : "（後攻）"}`} state={state} p={p} cls={classes[p]} />;
    const hand = (
      <div class="hand">
        {pl.hand.map((h) => (
          <CardView key={h.iid} cardId={h.cardId} hand={h} onClick={() => setDetail(h.cardId)} />
        ))}
        <EmptySlots count={pl.hand.length} />
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
      <Reproduce record={record} entrants={entrants} names={names} />
      <div class="game">
        {side(opponent(bottom), true)}
        {side(bottom, false)}
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
              <button type="button" title="表示だけ上下を入れ替えます" onClick={() => setBottom(opponent(bottom))}>
                上下を入れ替え（下: {names[bottom]}）
              </button>
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

const REPO_URL = "https://github.com/wistery-k/Shadowverse-Wb-Sim";

/** 試合を手元で再現するための情報（コミット・両者の AI とデッキ・コマンド） */
function Reproduce({ record, entrants, names }: { record: GameRecord; entrants: readonly Entrant[]; names: [string, string] }) {
  const [copied, setCopied] = useState(false);
  const seats = record.aIsPlayer0 ? [entrants[record.a]!, entrants[record.b]!] : [entrants[record.b]!, entrants[record.a]!];
  const command = [...(__BUILD_COMMIT__ ? [`git checkout ${__BUILD_COMMIT__}`] : []), reproduceCommand(record, entrants)].join("\n");
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div class="banner column repro">
      <div>
        再現に必要な情報 / コミット:{" "}
        {__BUILD_COMMIT__ ? (
          <a href={`${REPO_URL}/commit/${__BUILD_COMMIT__}`} target="_blank" rel="noreferrer">
            {__BUILD_COMMIT__.slice(0, 7)}
          </a>
        ) : (
          "不明"
        )}
        {__BUILD_DIRTY__ && <strong> （ビルド時に未コミットの変更あり。コミットだけでは再現できない可能性があります）</strong>}
        {" "}/ seed {record.seed}
      </div>
      {seats.map((e, p) => (
        <div key={p} class="muted">
          P{p + 1}{record.seats && (record.seats.first === p ? "（先攻）" : "（後攻）")}: {names[p]} / AI:{" "}
          {AGENTS[e.agent]?.label ?? e.agent}（{e.agent}）/ デッキ {e.deck.length} 枚
        </div>
      ))}
      <div class="repro-command">
        <pre>{command}</pre>
        <button type="button" onClick={copy}>
          {copied ? "コピーしました" : "コピー"}
        </button>
      </div>
    </div>
  );
}
