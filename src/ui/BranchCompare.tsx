// 打ち比べ: 今の局面で実戦の手と別の手（か、続けて打つ手の列）を打ち、残りを AI に最後まで打たせて勝率を比べる（src/sim/branch.ts）。
// リプレイとサンドボックス（実戦の手がなく、選んだ手の最初のものを基準にする）で使う。
// 手の列は、この局面から実際に打てる手を 1 つずつ選んで作る（選ぶたびに局面を進め、次の手はその局面で打てる手から選ぶ）。
// 試合は複数の Web Worker で並列に打つ（試合と手の列の組を 1 つずつ配る。src/sim/pool.ts）。結果は画面を開いているあいだ、局面（step）ごとに残す。

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AGENTS } from "../ai/registry";
import { actingPlayer, applyAction, legalActions, type Action, type GameState, type PlayerIndex, workerName } from "../engine";
import { branchStats, diffStats, tallyTurns, type Outcome, type Played } from "../sim/branch";
import type { BranchRequest, BranchResponse } from "../sim/branchWorker";
import { runPool } from "../sim/pool";
import { actionLabels } from "./describe";

/** 1 回の打ち比べ */
export interface BranchRun {
  step: number;
  actor: PlayerIndex;
  /** 比べた手の列（0 番目が基準: 実戦の手か、実戦の手がなければ選んだ最初のもの。1 手だけの列もある）と、手ごとの文言 */
  lines: Action[][];
  /** 0 番目が実戦の手か */
  hasActual: boolean;
  labels: string[][];
  /** 続きを打った AI（プレイヤー0・1） */
  agents: [string, string];
  games: number;
  /** played[手の列][試合]（まだなら undefined） */
  played: (Played | undefined)[][];
  done: number;
  startedAt: number;
  finishedAt: number | null;
  /** 途中で止めた */
  stopped: boolean;
  error?: string;
}

const GAME_COUNTS = [20, 50, 100, 200];
/** 続きを打つ AI の選択肢の「試合と同じ」 */
const SAME = "";

/** 打ち比べの実行（同時に 1 つだけ。始めると前のものは止める） */
export function useBranchRuns() {
  const [runs, setRuns] = useState<ReadonlyMap<number, BranchRun>>(new Map());
  const workers = useRef<Worker[]>([]);
  const terminate = () => {
    for (const w of workers.current) w.terminate();
    workers.current = [];
  };
  useEffect(() => terminate, []);

  const update = (step: number, f: (r: BranchRun) => BranchRun) =>
    setRuns((m) => {
      const r = m.get(step);
      if (!r) return m;
      const next = new Map(m);
      next.set(step, f(r));
      return next;
    });

  const stop = () => {
    terminate();
    setRuns((m) => {
      const next = new Map(m);
      for (const [k, r] of m) if (r.finishedAt === null) next.set(k, { ...r, finishedAt: Date.now(), stopped: true });
      return next;
    });
  };

  const start = (run: Omit<BranchRun, "played" | "done" | "startedAt" | "finishedAt" | "stopped">, state: GameState, seedBase: number) => {
    stop();
    const { step, games } = run;
    setRuns((m) =>
      new Map(m).set(step, {
        ...run,
        played: run.lines.map(() => Array<Played | undefined>(games).fill(undefined)),
        done: 0,
        startedAt: Date.now(),
        finishedAt: null,
        stopped: false,
      }),
    );
    // 仕事は（試合, 手の列）の組 1 つずつ。試合の番号の順に配るので、前の試合から揃っていく
    const jobs = Array.from({ length: games }, (_, game) => run.lines.map((_, line) => ({ game, line }))).flat();
    const mine = runPool<{ game: number; line: number }, BranchResponse>({
      create: () => new Worker(new URL("../sim/branchWorker.ts", import.meta.url), { type: "module", name: workerName() }),
      jobs,
      request: ({ game, line }): BranchRequest => ({
        state,
        lines: run.lines,
        agents: run.agents,
        viewer: run.actor,
        seedBase,
        game,
        line,
      }),
      isDone: (msg) => msg.type === "done",
      onMessage: (msg) => {
        if (msg.type === "outcome") {
          update(step, (r) => {
            const played = r.played.map((o, b) => (b === msg.line ? o.map((x, g) => (g === msg.game ? msg.played : x)) : o));
            // すべての手の列を打ち終えた試合の数
            const done = played[0]?.filter((_, g) => played.every((o) => o[g] !== undefined)).length ?? 0;
            return { ...r, played, done };
          });
        } else if (msg.type === "error") {
          update(step, (r) => ({ ...r, error: msg.message }));
        }
      },
      onFinish: () => {
        update(step, (r) => ({ ...r, finishedAt: Date.now() }));
        workers.current = workers.current.filter((x) => !mine.includes(x));
      },
    });
    workers.current = mine;
  };

  return { runs, start, stop };
}

interface Props {
  state: GameState;
  /** 局面の番号（結果はこれごとに残す） */
  step: number;
  /** 実戦で打った手（なければ、選んだ手の最初のものを基準にする） */
  actual?: Action | undefined;
  /** 実戦でこのターンに手番の側が続けて打った手（この局面の手から。「実戦の手順から作る」に使う） */
  actualLine?: readonly Action[] | undefined;
  names: [string, string];
  /** 試合の AI（プレイヤー0・1） */
  matchAgents: [string, string];
  seed: number;
  branch: ReturnType<typeof useBranchRuns>;
  onJump: (step: number) => void;
  /** 作っている手の列を打った後の局面を盤面に出す（null で戻す） */
  onPreview?: ((state: GameState | null) => void) | undefined;
  /** 局面の呼び方（既定は「N 手目」） */
  stepLabel?: (step: number) => string;
  /** 説明の文言（既定はリプレイ向け） */
  caption?: string;
  /** 続きを打つ AI の選択肢の「試合と同じ」の文言 */
  sameLabel?: string;
}

const percent = (x: number) => `${(x * 100).toFixed(0)}%`;
const signedPercent = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x * 100).toFixed(0)}%`;

function seconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

const defaultStepLabel = (step: number) => `${step + 1} 手目`;

/** 比べる手の列 1 つ（1 手だけのものは、打てる手の一覧の 1 行） */
interface Choice {
  key: string;
  actions: Action[];
  labels: string[];
}

const lineKey = (actions: readonly Action[]) => JSON.stringify(actions);
const lineText = (labels: readonly string[]) => labels.join(" → ");

/** 局面 state で打てる手の文言の一覧の中の、手 a の文言 */
function labelIn(state: GameState, legal: readonly Action[], a: Action, names: [string, string]): string {
  const key = JSON.stringify(a);
  const i = legal.findIndex((x) => JSON.stringify(x) === key);
  return i >= 0 ? actionLabels(state, legal, names)[i]! : actionLabels(state, [a], names)[0]!;
}

/** 手の列 actions を state から順に打った局面（[0] が state）。打てない手があれば、その手の前まで */
function lineStates(state: GameState, actions: readonly Action[]): GameState[] {
  const out = [state];
  for (const a of actions) {
    const s = out[out.length - 1]!;
    const key = JSON.stringify(a);
    if (!legalActions(s).some((x) => JSON.stringify(x) === key)) break;
    out.push(applyAction(s, a));
  }
  return out;
}

/** 手の列の後に、手番の側がまだ手を続けられないなら、その理由 */
function lineEnd(after: GameState, last: Action | undefined, actor: PlayerIndex): string | null {
  if (last?.type === "endTurn") return "ターンを終えたので、手の列はここまでです";
  if (after.phase === "ended") return "決着したので、手の列はここまでです";
  if (actingPlayer(after) !== actor) return "相手が選ぶ手になるので、手の列はここまでです";
  return null;
}

export function BranchCompare({
  state,
  step,
  actual,
  actualLine,
  names,
  matchAgents,
  seed,
  branch,
  onJump,
  onPreview,
  stepLabel = defaultStepLabel,
  caption,
  sameLabel = "試合と同じ",
}: Props) {
  const actor = actingPlayer(state);
  const legal = useMemo(() => legalActions(state), [state]);
  const actualKey = actual ? JSON.stringify(actual) : null;
  const options = useMemo(() => {
    const labels = actionLabels(state, legal, names);
    const list = legal.map((a, i) => ({ action: a, key: JSON.stringify(a), label: labels[i]! }));
    return list.sort((x, y) => Number(y.key === actualKey) - Number(x.key === actualKey));
  }, [legal, actualKey, names]);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  // 作った手の列（2 手以上）。選ぶかどうかは checked（キーは lineKey）
  const [lines, setLines] = useState<readonly Choice[]>([]);
  // 作っている途中の手の列
  const [draft, setDraft] = useState<readonly Action[]>([]);
  const [open, setOpen] = useState(false);
  const [games, setGames] = useState(GAME_COUNTS[1]!);
  const [agent, setAgent] = useState(SAME);
  const run = branch.runs.get(step);
  // 局面が変わったら選び直す（打ち比べた局面なら、そのとき比べた手と手の列を選んでおく）
  useEffect(() => {
    const compared = run?.lines.slice(run.hasActual ? 1 : 0) ?? [];
    setChecked(new Set(compared.map((l) => (l.length === 1 ? JSON.stringify(l[0]) : lineKey(l)))));
    setLines(
      compared.flatMap((l, i) => {
        const labels = run!.labels[i + (run!.hasActual ? 1 : 0)]!;
        return l.length > 1 ? [{ key: lineKey(l), actions: l, labels }] : [];
      }),
    );
    setDraft([]);
  }, [step]);

  // 作っている手の列を打った局面と、その手の文言
  const draftStates = useMemo(() => lineStates(state, draft), [state, draft]);
  const draftLabels = useMemo(() => draft.slice(0, draftStates.length - 1).map((a, k) => labelIn(draftStates[k]!, legalActions(draftStates[k]!), a, names)), [draftStates, names]);
  const draftEnd = draftStates[draftStates.length - 1]!;
  const draftValid = draft.slice(0, draftStates.length - 1);
  const ended = lineEnd(draftEnd, draftValid[draftValid.length - 1], actor);
  const nextOptions = useMemo(() => {
    if (ended) return [];
    const next = legalActions(draftEnd);
    const labels = actionLabels(draftEnd, next, names);
    return next.map((a, i) => ({ action: a, label: labels[i]! }));
  }, [draftEnd, ended, names]);
  const draftKey = lineKey(draftValid);
  const draftAdded = lines.some((l) => l.key === draftKey);

  // 作っている手の列を打った局面を盤面に出す（パネルを閉じたら・局面が変わったら戻す）
  useEffect(() => {
    onPreview?.(open && draftValid.length > 0 ? draftEnd : null);
  }, [open, draftEnd, draftValid.length]);
  useEffect(() => () => onPreview?.(null), []);

  const running = [...branch.runs.values()].find((r) => r.finishedAt === null);
  const singles = options.filter((o) => o.key !== actualKey && checked.has(o.key)).map((o): Choice => ({ key: o.key, actions: [o.action], labels: [o.label] }));
  const alternatives = [...singles, ...lines.filter((l) => checked.has(l.key))];
  // 比べる手の列（0 番目が基準）
  const actualOption = actual ? (options.find((o) => o.key === actualKey) ?? { action: actual, key: actualKey!, label: actionLabels(state, [actual], names)[0]! }) : null;
  const actualChoice: Choice | null = actualOption ? { key: actualOption.key, actions: [actualOption.action], labels: [actualOption.label] } : null;
  const chosen = actualChoice ? [actualChoice, ...alternatives] : alternatives;
  const agentPair: [string, string] = agent === SAME ? matchAgents : [agent, agent];
  const agentLabel = (key: string) => AGENTS[key]?.label ?? key;

  const start = () => {
    branch.start(
      {
        step,
        actor,
        lines: chosen.map((c) => c.actions),
        labels: chosen.map((c) => c.labels),
        hasActual: actualChoice !== null,
        agents: agentPair,
        games,
      },
      state,
      (seed ^ Math.imul(step + 1, 0x85ebca6b)) >>> 0,
    );
  };

  const toggle = (key: string) =>
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const addDraft = () => {
    if (draftValid.length < 2) return;
    if (!draftAdded) setLines([...lines, { key: draftKey, actions: [...draftValid], labels: draftLabels }]);
    setChecked((c) => new Set(c).add(draftKey));
    setDraft([]);
  };
  const removeLine = (key: string) => {
    setLines(lines.filter((l) => l.key !== key));
    setChecked((c) => {
      const next = new Set(c);
      next.delete(key);
      return next;
    });
  };
  // 実戦の手順（同じターンの手番の側の手）のうち、この局面から打てる分
  const actualSteps = useMemo(() => (actualLine ? lineStates(state, actualLine).length - 1 : 0), [state, actualLine]);

  return (
    <div class="banner column branch">
      <div class="branch-head">
        <button type="button" class={open ? "active" : ""} onClick={() => setOpen(!open)}>
          {open ? "打ち比べを閉じる" : "打ち比べ"}
        </button>
        <span class="muted">
          {caption ?? `${step + 1} 手目（${names[actor]}の手）を別の手にしたら勝率がどう変わるか、続きを AI に打たせて比べます`}
        </span>
      </div>
      {running && running.step !== step && (
        <div class="muted">
          {stepLabel(running.step)}の打ち比べを実行中（{running.done}/{running.games} 試合）{" "}
          <button type="button" onClick={() => onJump(running.step)}>
            その局面へ
          </button>{" "}
          <button type="button" onClick={branch.stop}>
            止める
          </button>
        </div>
      )}
      {open && (
        <>
          <ul class="branch-options">
            {options.map((o) => {
              const isActual = o.key === actualKey;
              return (
                <li key={o.key}>
                  <label>
                    <input type="checkbox" checked={isActual || checked.has(o.key)} disabled={isActual} onChange={() => toggle(o.key)} />
                    {o.label}
                    {isActual && <span class="branch-tag">実戦</span>}
                    {!actualChoice && chosen[0]?.key === o.key && chosen.length > 1 && <span class="branch-tag">基準</span>}
                  </label>
                </li>
              );
            })}
            {lines.map((l) => (
              <li key={l.key} class="branch-line-item">
                <label>
                  <input type="checkbox" checked={checked.has(l.key)} onChange={() => toggle(l.key)} />
                  {lineText(l.labels)}
                  <span class="branch-tag line">{l.actions.length} 手</span>
                  {!actualChoice && chosen[0]?.key === l.key && chosen.length > 1 && <span class="branch-tag">基準</span>}
                </label>
                <button type="button" class="branch-remove" title="この手の列を消す" onClick={() => removeLine(l.key)}>
                  消す
                </button>
              </li>
            ))}
          </ul>
          <div class="branch-builder">
            <div class="muted">
              続けて打つ手の列（2 手以上）を作る: 手を選ぶたびにその手を打った局面に進み{onPreview ? "（盤面もその局面にします）" : ""}、次の手はその局面で打てる手から選びます。
              打ち比べでは、手の列を打ってから続きを AI に打たせます。試合ごとに見えない手札・山札を並べ直すので、2 手目からは同じカードの同じ手を探して打ち、無ければそこから AI が打ちます。
            </div>
            {draft.length > 0 && (
              <ol class="branch-draft">
                {draftLabels.map((label, k) => (
                  <li key={k}>
                    <button type="button" title="この手までに戻す" onClick={() => setDraft(draftValid.slice(0, k + 1))}>
                      {label}
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <div class="row-buttons">
              {ended ? (
                <span class="muted">{ended}</span>
              ) : (
                <select
                  value=""
                  onChange={(e) => {
                    const a = nextOptions[Number(e.currentTarget.value)]?.action;
                    if (a) setDraft([...draftValid, a]);
                  }}
                >
                  <option value="">{draftValid.length === 0 ? "1 手目を選ぶ…" : `${draftValid.length + 1} 手目を選ぶ…`}</option>
                  {nextOptions.map((o, i) => (
                    <option key={i} value={i}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
              <button type="button" onClick={() => setDraft(draftValid.slice(0, -1))} disabled={draftValid.length === 0}>
                1 手戻す
              </button>
              <button type="button" onClick={() => setDraft([])} disabled={draftValid.length === 0}>
                やり直す
              </button>
              {actualSteps > 0 && (
                <button type="button" title="実戦でこのターンに打った手順を手の列に入れます（手を戻して途中から変えられます）" onClick={() => setDraft(actualLine!.slice(0, actualSteps))}>
                  実戦の手順を入れる
                </button>
              )}
              <button type="button" class="primary" onClick={addDraft} disabled={draftValid.length < 2}>
                {draftAdded ? "比べる手に入っています" : "比べる手に加える"}
              </button>
            </div>
            {draftValid.length === 1 && <div class="muted">1 手だけなら、上の一覧で選べます。</div>}
          </div>
          <div class="row-buttons">
            <button type="button" onClick={() => setChecked(new Set([...options.map((o) => o.key), ...lines.map((l) => l.key)]))} disabled={options.length + lines.length <= 1}>
              全部選ぶ
            </button>
            <button type="button" onClick={() => setChecked(new Set())} disabled={alternatives.length === 0}>
              選択を外す
            </button>
            <label>
              試合数（手ごと）{" "}
              <select value={games} onChange={(e) => setGames(Number(e.currentTarget.value))}>
                {GAME_COUNTS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              続きを打つ AI{" "}
              <select value={agent} onChange={(e) => setAgent(e.currentTarget.value)}>
                <option value={SAME}>
                  {sameLabel}（{matchAgents[0] === matchAgents[1] ? agentLabel(matchAgents[0]) : `${agentLabel(matchAgents[0])} / ${agentLabel(matchAgents[1])}`}）
                </option>
                {Object.entries(AGENTS).map(([key, e]) => (
                  <option key={key} value={key}>
                    {e.label}
                  </option>
                ))}
              </select>
            </label>
            {run?.finishedAt === null ? (
              <button type="button" onClick={branch.stop}>
                止める
              </button>
            ) : (
              <button type="button" class="primary" onClick={start} disabled={chosen.length < 2}>
                打ち比べる（{Math.max(2, chosen.length) * games} 試合）
              </button>
            )}
          </div>
          {options.length <= 1 && lines.length === 0 ? (
            <div class="muted">この局面で打てる手は{actualOption ? "実戦の手" : " 1 つ"}だけです。</div>
          ) : (
            chosen.length < 2 &&
            !run && (
              <div class="muted">
                {actualOption ? "実戦の手と比べたい手か手の列を選んでください。" : "比べたい手か手の列を 2 つ以上選んでください（いちばん上のものを基準にします）。"}
              </div>
            )
          )}
        </>
      )}
      {run && <BranchResult run={run} names={names} agentLabel={agentLabel} />}
    </div>
  );
}

/** 手順の表で、はじめに出す行の数 */
const TALLY_ROWS = 6;

function BranchResult({ run, names, agentLabel }: { run: BranchRun; names: [string, string]; agentLabel: (key: string) => string }) {
  const [shown, setShown] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    setShown(null);
    setAll(false);
  }, [run.startedAt]);
  const outcomes = (p: readonly (Played | undefined)[]): (Outcome | undefined)[] => p.map((x) => x?.outcome);
  const completed = (o: (Outcome | undefined)[]) => o.filter((x): x is Outcome => x !== undefined);
  const base = outcomes(run.played[0]!);
  const elapsed = (run.finishedAt ?? Date.now()) - run.startedAt;
  const remaining = run.done > 0 && run.finishedAt === null ? (elapsed / run.done) * (run.games - run.done) : null;
  const skipped = run.played.map((o) => branchStats(completed(outcomes(o))).skipped).reduce((s, x) => s + x, 0);
  const baseTag = run.hasActual ? "実戦" : "基準";
  const multi = run.lines.some((l) => l.length > 1);
  return (
    <div class="branch-result">
      <div class="muted">
        {run.finishedAt === null ? "実行中" : run.stopped ? "途中で止めました" : "完了"}: {run.done}/{run.games} 試合（手ごと）/ {seconds(elapsed)}
        {remaining !== null && ` / 残り約 ${seconds(remaining)}`} / 続き: {agentLabel(run.agents[0])}
        {run.agents[0] !== run.agents[1] && ` vs ${agentLabel(run.agents[1])}`}
      </div>
      <table>
        <thead>
          <tr>
            <th>手</th>
            <th>{names[run.actor]}の勝率</th>
            <th title="同じ並べ直しの試合どうしの勝ち負けの差の平均">{baseTag}との差</th>
            {multi && <th title="手の列を最後まで打てた試合の数（打てなかった手からは AI が打った）">手の列を打てた</th>}
            <th title="始めのターンに実際に打った手順（手の列の後に AI が打った続きも含む）の内訳">このターン</th>
          </tr>
        </thead>
        <tbody>
          {run.played.map((p, b) => {
            const o = outcomes(p);
            const s = branchStats(completed(o));
            const d = b === 0 ? null : diffStats(base, o);
            // 差の 95% の幅が 0 をまたがなければ色を付ける
            const cls = d && d.games > 1 ? (d.diff - d.margin > 0 ? "better" : d.diff + d.margin < 0 ? "worse" : "") : "";
            const len = run.lines[b]!.length;
            const finished = p.filter((x): x is Played => x !== undefined && x.outcome !== null);
            const full = finished.filter((x) => x.followed >= len).length;
            const cols = 4 + Number(multi);
            return [
              <tr key={b} class={cls}>
                <td>
                  {lineText(run.labels[b]!)}
                  {b === 0 && <span class="branch-tag">{baseTag}</span>}
                </td>
                <td class="num">
                  {s.games > 0 ? (
                    <>
                      {percent(s.wins / s.games)} <span class="muted">±{percent(s.margin)}（{s.wins}/{s.games}）</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td class="num">
                  {d ? (
                    d.games > 0 ? (
                      <>
                        {signedPercent(d.diff)} <span class="muted">±{percent(d.margin)}</span>
                      </>
                    ) : (
                      "—"
                    )
                  ) : (
                    ""
                  )}
                </td>
                {multi && <td class="num">{len > 1 ? (finished.length > 0 ? `${full}/${finished.length}` : "—") : ""}</td>}
                <td>
                  <button type="button" class={shown === b ? "active" : ""} disabled={finished.length === 0} onClick={() => setShown(shown === b ? null : b)}>
                    {shown === b ? "閉じる" : "手順"}
                  </button>
                </td>
              </tr>,
              shown === b && (
                <tr key={`${b}-turns`} class="branch-turns">
                  <td colSpan={cols}>
                    <TurnTable played={p} all={all} setAll={setAll} actor={names[run.actor]} />
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
      <div class="muted">
        ± は 95% の幅。差は同じ試合番号（{names[run.actor]}から見えない手札・山札を同じに並べ直した試合）どうしで比べ、幅が 0 をまたがないときに色を付けます。
        {multi && " 手の列は、2 手目から同じカードの同じ手が打てなかった試合ではそこから AI が打つので、「手の列を打てた」で最後まで打てた試合の数を見てください。"}
        {skipped > 0 && ` 打てなかった・エラーになった試合 ${skipped} は数えていません。`}
      </div>
      {run.error && <div class="problems">エラー: {run.error}</div>}
    </div>
  );
}

/** 手の列 1 つの、始めのターンに打った手順ごとの回数と勝率 */
function TurnTable({ played, all, setAll, actor }: { played: readonly (Played | undefined)[]; all: boolean; setAll: (all: boolean) => void; actor: string }) {
  const rows = useMemo(() => tallyTurns(played), [played]);
  const list = all ? rows : rows.slice(0, TALLY_ROWS);
  return (
    <div class="branch-tally">
      <div class="muted">始めのターンに{actor}が打った手順（手の列と、その後に AI が打った続き）を、同じ手順の試合でまとめたもの</div>
      <table>
        <thead>
          <tr>
            <th>試合</th>
            <th>勝率</th>
            <th>このターンの手順</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.text}>
              <td class="num">{r.games}</td>
              <td class="num">
                {percent(r.wins / r.decided)} <span class="muted">（{r.wins}/{r.decided}）</span>
              </td>
              <td>{r.text || "（なし）"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > TALLY_ROWS && (
        <button type="button" onClick={() => setAll(!all)}>
          {all ? `多い ${TALLY_ROWS} 通りだけ出す` : `全部の ${rows.length} 通りを出す`}
        </button>
      )}
    </div>
  );
}
