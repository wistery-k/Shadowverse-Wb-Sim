// リプレイの打ち比べ: 今の局面で実戦の手と別の手を打ち、残りを AI に最後まで打たせて勝率を比べる（src/sim/branch.ts）。
// 試合は複数の Web Worker で並列に打つ。結果はリプレイを開いているあいだ、局面（何手目か）ごとに残す。

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AGENTS } from "../ai/registry";
import { actingPlayer, legalActions, type Action, type GameState, type PlayerIndex } from "../engine";
import { branchStats, diffStats, type Outcome } from "../sim/branch";
import type { BranchRequest, BranchResponse } from "../sim/branchWorker";
import { describeAction } from "./describe";

/** 1 回の打ち比べ */
export interface BranchRun {
  step: number;
  actor: PlayerIndex;
  /** 比べた手（0 番目が実戦の手）と、その文言 */
  actions: Action[];
  labels: string[];
  /** 続きを打った AI（プレイヤー0・1） */
  agents: [string, string];
  games: number;
  /** outcomes[手][試合]（まだなら undefined） */
  outcomes: (Outcome | undefined)[][];
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

  const start = (run: Omit<BranchRun, "outcomes" | "done" | "startedAt" | "finishedAt" | "stopped">, state: GameState, seedBase: number) => {
    stop();
    const { step, games } = run;
    setRuns((m) =>
      new Map(m).set(step, {
        ...run,
        outcomes: run.actions.map(() => Array<Outcome | undefined>(games).fill(undefined)),
        done: 0,
        startedAt: Date.now(),
        finishedAt: null,
        stopped: false,
      }),
    );
    const count = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1, games));
    let finished = 0;
    const mine: Worker[] = [];
    for (let w = 0; w < count; w++) {
      const worker = new Worker(new URL("../sim/branchWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<BranchResponse>) => {
        const msg = e.data;
        if (msg.type === "game") {
          update(step, (r) => ({
            ...r,
            outcomes: r.outcomes.map((o, b) => o.map((x, g) => (g === msg.game ? msg.outcomes[b] : x))),
            done: r.done + 1,
          }));
        } else if (msg.type === "error") {
          update(step, (r) => ({ ...r, error: msg.message }));
        } else if (++finished === count) {
          update(step, (r) => ({ ...r, finishedAt: Date.now() }));
          for (const x of mine) x.terminate();
          workers.current = workers.current.filter((x) => !mine.includes(x));
        }
      };
      const request: BranchRequest = {
        state,
        actions: run.actions,
        agents: run.agents,
        viewer: run.actor,
        seedBase,
        games: Array.from({ length: games }, (_, i) => i).filter((i) => i % count === w),
      };
      worker.postMessage(request);
      mine.push(worker);
    }
    workers.current = mine;
  };

  return { runs, start, stop };
}

interface Props {
  state: GameState;
  step: number;
  /** 実戦で打った手 */
  actual: Action;
  names: [string, string];
  /** 試合の AI（プレイヤー0・1） */
  matchAgents: [string, string];
  seed: number;
  branch: ReturnType<typeof useBranchRuns>;
  onJump: (step: number) => void;
}

const percent = (x: number) => `${(x * 100).toFixed(0)}%`;
const signedPercent = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x * 100).toFixed(0)}%`;

function seconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

export function BranchCompare({ state, step, actual, names, matchAgents, seed, branch, onJump }: Props) {
  const actor = actingPlayer(state);
  const legal = useMemo(() => legalActions(state), [state]);
  const actualKey = JSON.stringify(actual);
  // 手の文言（「名前: 」は手番のプレイヤーなので省く）
  const label = (a: Action) => {
    // マリガンで引くカードは試合ごとに並べ直すので、実戦で引いたカードは書かない（after を渡さない）
    const text = describeAction(state, a, names);
    const prefix = `${names[actor]}: `;
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
  };
  const options = useMemo(() => {
    const list = legal.map((a) => ({ action: a, key: JSON.stringify(a), label: label(a) }));
    // 同じ名前のカードが 2 枚以上あるときは、何枚目かを付けて区別する
    const count = new Map<string, number>();
    for (const o of list) count.set(o.label, (count.get(o.label) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const o of list) {
      if (count.get(o.label)! < 2) continue;
      const k = (seen.get(o.label) ?? 0) + 1;
      seen.set(o.label, k);
      o.label = `${o.label}（${k} 枚目）`;
    }
    return list.sort((x, y) => Number(y.key === actualKey) - Number(x.key === actualKey));
  }, [legal, actualKey, names]);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [games, setGames] = useState(GAME_COUNTS[1]!);
  const [agent, setAgent] = useState(SAME);
  const run = branch.runs.get(step);
  // 局面が変わったら選び直す（打ち比べた局面なら、そのとき比べた手を選んでおく）
  useEffect(() => setChecked(new Set(run?.actions.slice(1).map((a) => JSON.stringify(a)) ?? [])), [step]);

  const running = [...branch.runs.values()].find((r) => r.finishedAt === null);
  const alternatives = options.filter((o) => o.key !== actualKey && checked.has(o.key));
  const agentPair: [string, string] = agent === SAME ? matchAgents : [agent, agent];
  const agentLabel = (key: string) => AGENTS[key]?.label ?? key;

  const start = () => {
    const chosen = [options.find((o) => o.key === actualKey) ?? { action: actual, label: label(actual) }, ...alternatives];
    branch.start(
      { step, actor, actions: chosen.map((o) => o.action), labels: chosen.map((o) => o.label), agents: agentPair, games },
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

  return (
    <div class="banner column branch">
      <div class="branch-head">
        <button type="button" class={open ? "active" : ""} onClick={() => setOpen(!open)}>
          {open ? "打ち比べを閉じる" : "打ち比べ"}
        </button>
        <span class="muted">
          {step + 1} 手目（{names[actor]}の手）を別の手にしたら勝率がどう変わるか、続きを AI に打たせて比べます
        </span>
      </div>
      {running && running.step !== step && (
        <div class="muted">
          {running.step + 1} 手目の打ち比べを実行中（{running.done}/{running.games} 試合）{" "}
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
                  </label>
                </li>
              );
            })}
          </ul>
          <div class="row-buttons">
            <button type="button" onClick={() => setChecked(new Set(options.map((o) => o.key)))} disabled={options.length <= 1}>
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
                  試合と同じ（{matchAgents[0] === matchAgents[1] ? agentLabel(matchAgents[0]) : `${agentLabel(matchAgents[0])} / ${agentLabel(matchAgents[1])}`}）
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
              <button type="button" class="primary" onClick={start} disabled={alternatives.length === 0}>
                打ち比べる（{(alternatives.length + 1) * games} 試合）
              </button>
            )}
          </div>
          {options.length <= 1 ? (
            <div class="muted">この局面で打てる手は実戦の手だけです。</div>
          ) : (
            alternatives.length === 0 && !run && <div class="muted">実戦の手と比べたい手を選んでください。</div>
          )}
        </>
      )}
      {run && <BranchResult run={run} names={names} agentLabel={agentLabel} />}
    </div>
  );
}

function BranchResult({ run, names, agentLabel }: { run: BranchRun; names: [string, string]; agentLabel: (key: string) => string }) {
  const completed = (o: (Outcome | undefined)[]) => o.filter((x): x is Outcome => x !== undefined);
  const base = run.outcomes[0]!;
  const elapsed = (run.finishedAt ?? Date.now()) - run.startedAt;
  const remaining = run.done > 0 && run.finishedAt === null ? (elapsed / run.done) * (run.games - run.done) : null;
  const skipped = run.outcomes.map((o) => branchStats(completed(o)).skipped).reduce((s, x) => s + x, 0);
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
            <th title="同じ並べ直しの試合どうしの勝ち負けの差の平均">実戦との差</th>
          </tr>
        </thead>
        <tbody>
          {run.outcomes.map((o, b) => {
            const s = branchStats(completed(o));
            const d = b === 0 ? null : diffStats(base, o);
            // 差の 95% の幅が 0 をまたがなければ色を付ける
            const cls = d && d.games > 1 ? (d.diff - d.margin > 0 ? "better" : d.diff + d.margin < 0 ? "worse" : "") : "";
            return (
              <tr key={b} class={cls}>
                <td>
                  {run.labels[b]}
                  {b === 0 && <span class="branch-tag">実戦</span>}
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
              </tr>
            );
          })}
        </tbody>
      </table>
      <div class="muted">
        ± は 95% の幅。差は同じ試合番号（{names[run.actor]}から見えない手札・山札を同じに並べ直した試合）どうしで比べ、幅が 0 をまたがないときに色を付けます。
        {skipped > 0 && ` 打てなかった・エラーになった試合 ${skipped} は数えていません。`}
      </div>
      {run.error && <div class="problems">エラー: {run.error}</div>}
    </div>
  );
}
