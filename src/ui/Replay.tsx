// AI 対戦の試合を再生する画面（両者の手札を公開して表示する）

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AGENTS } from "../ai/registry";
import { cardOf, legalActions, opponent, type GameState, type PlayerIndex } from "../engine";
import { replayStates } from "../sim/replay";
import { reproduceCommand } from "../sim/reproduce";
import { seatDecks, type Entrant, type GameRecord } from "../sim/tournament";
import { CardDetail, CardView, type Motion, type MulliganMark } from "./CardView";
import { attackStatuses, describeAction, leaderClasses } from "./describe";
import { AiThought, useThoughts } from "./AiThought";
import { BranchCompare, useBranchRuns } from "./BranchCompare";
import { BoardSlots, EmptySlots, LeaderHp, PlayerInfo, Resources } from "./Game";

interface Props {
  record: GameRecord;
  entrants: readonly Entrant[];
  onClose: () => void;
  /** 今の局面をサンドボックスで開く */
  onSandbox?: ((state: GameState, label: string) => void) | undefined;
}

const SPEEDS = [
  { ms: 1000, label: "遅い" },
  { ms: 500, label: "普通" },
  { ms: 200, label: "速い" },
];

export function Replay({ record, entrants, onClose, onSandbox }: Props) {
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
  const lines = useMemo(() => actions.map((a, i) => describeAction(states[i]!, a, names, states[i + 1])), [states, names]);
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
  const branch = useBranchRuns();
  const thoughts = useThoughts();
  const matchAgents = useMemo((): [string, string] => {
    const [p0, p1] = record.aIsPlayer0 ? [record.a, record.b] : [record.b, record.a];
    return [entrants[p0]!.agent, entrants[p1]!.agent];
  }, [record, entrants]);

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

  // 画面の外側（隠したタブの中にあるか）を調べる
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      // ほかのタブを開いているあいだ（隠れているあいだ）は動かさない
      if (!rootRef.current?.offsetParent) return;
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

  // 手番のフォロワーの攻撃の可否
  const attackable = useMemo(() => attackStatuses(state), [state]);
  // 手番のプレイヤーのアクトできるアミュレット
  const actable = useMemo(
    () => new Set(state.phase === "main" && !state.pending ? legalActions(state).flatMap((a) => (a.type === "act" ? [a.iid] : [])) : []),
    [state],
  );

  // マリガン: 行う前は残す・返すカード、行った後は残した・引いたカードを示す（両者のマリガンが終わった局面まで）
  const mulliganMarks = useMemo(() => {
    const marks = new Map<number, MulliganMark>();
    const at = ([0, 1] as const).map((p) => actions.findIndex((a) => a.type === "mulligan" && a.player === p));
    if (at.some((i) => i < 0) || step > Math.max(...at) + 1) return marks;
    for (const p of [0, 1] as const) {
      const i = at[p]!;
      const a = actions[i];
      if (a?.type !== "mulligan") continue;
      const before = states[i]!.players[p].hand;
      if (step <= i) {
        for (const h of before) marks.set(h.iid, a.swap.includes(h.iid) ? "return" : "keep");
      } else {
        const kept = new Set(before.map((h) => h.iid));
        for (const h of states[i + 1]!.players[p].hand) marks.set(h.iid, kept.has(h.iid) ? "kept" : "drawn");
      }
    }
    return marks;
  }, [states, step]);

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
              actable={actable.has(c.iid)}
              motion={motion}
              onClick={() => setDetail(c.cardId)}
            />
          );
        })}
        <BoardSlots count={pl.board.length} />
      </div>
    );
    const leader = (
      <div class="leader-row">
        <div key={leaderHit === p ? `leader-${step}` : "leader"} class={`leader class-${classes[p]} ${leaderHit === p ? "motion-hit" : ""}`}>
          リーダー <LeaderHp hp={pl.leaderHp} max={pl.leaderMaxHp} />
        </div>
        <Resources state={state} p={p} />
      </div>
    );
    const info = <PlayerInfo label={`${names[p]}${state.first === p ? "（先攻）" : "（後攻）"}`} state={state} p={p} cls={classes[p]} />;
    const hand = (
      <div class="hand">
        {pl.hand.map((h) => (
          <CardView key={h.iid} cardId={h.cardId} hand={h} mulligan={mulliganMarks.get(h.iid) ?? null} onClick={() => setDetail(h.cardId)} />
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
    <div class="replay" ref={rootRef}>
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
              {onSandbox && (
                <button
                  type="button"
                  title="この局面を「サンドボックス」タブで開きます（盤面・手札を編集して、AI に考えさせたり手を打ち比べたりできます）"
                  onClick={() => {
                    setPlaying(false);
                    onSandbox(state, `リプレイの局面（${names[0]} vs ${names[1]}、seed ${record.seed}、${step} 手目の後）`);
                  }}
                >
                  サンドボックスで開く
                </button>
              )}
            </div>
            <input type="range" min={0} max={last} value={step} onInput={(e) => go(Number(e.currentTarget.value))} />
            <div>
              {step === 0 ? "対戦開始" : `直前: ${lines[step - 1]}`}
              {step === last && state.phase === "ended" && <strong> — {winnerName}の勝利</strong>}
            </div>
            {step < last && <div class="muted">次: {lines[step]}</div>}
          </div>
          {step < last && (
            <AiThought
              state={state}
              step={step}
              actual={actions[step]!}
              names={names}
              matchAgents={matchAgents}
              seed={record.seed}
              thoughts={thoughts}
            />
          )}
          {step < last && (
            <BranchCompare
              state={state}
              step={step}
              actual={actions[step]!}
              names={names}
              matchAgents={matchAgents}
              seed={record.seed}
              branch={branch}
              onJump={(s) => {
                setPlaying(false);
                go(s);
              }}
            />
          )}
        </section>
        <aside class="info">
          {detail ? <CardDetail card={cardOf(detail)} /> : <div class="muted">カードをクリックすると詳細を表示します</div>}
          <ol class="log replay-log" ref={logRef}>
            {lines.map((line, i) => (
              <li key={i} class={i === step - 1 ? "current" : i >= step ? "muted" : ""} onClick={() => go(i + 1)}>
                {line}
                {branch.runs.has(i) && (
                  <button
                    type="button"
                    class="branch-mark"
                    title="この手の前の局面の打ち比べを見る"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPlaying(false);
                      go(i);
                    }}
                  >
                    打ち比べ
                  </button>
                )}
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
