// 「AI の考え」: 今の局面で、手番の AI が比べた手と、その点数の内訳（手で作った評価と学習した補正）を出す（src/ai/think.ts）。
// リプレイとサンドボックスで使う。考えるのは Web Worker（src/ai/thinkWorker.ts）。結果は画面を開いているあいだ、局面（step）ごとに残す。

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AGENTS } from "../ai/registry";
import { THINKING_AGENTS, type ScoreParts, type Thought, type ThoughtCandidate } from "../ai/think";
import type { ThinkRequest, ThinkResponse } from "../ai/thinkWorker";
import { actingPlayer, tryApplyAction, type Action, type GameState, type PlayerIndex } from "../engine";
import { describeAction } from "./describe";

/** 1 回の考え */
export interface ThoughtRun {
  step: number;
  agent: string;
  /** 考え直した回数（乱数を変える） */
  variant: number;
  startedAt: number;
  finishedAt: number | null;
  thought?: Thought | null;
  error?: string;
}

/** 考えの実行（同時に 1 つだけ。始めると前のものは止める） */
export function useThoughts() {
  const [runs, setRuns] = useState<ReadonlyMap<number, ThoughtRun>>(new Map());
  const worker = useRef<Worker | null>(null);
  const terminate = () => {
    worker.current?.terminate();
    worker.current = null;
  };
  useEffect(() => terminate, []);

  const start = (step: number, agent: string, variant: number, state: GameState, rng: number) => {
    terminate();
    setRuns((m) => new Map(m).set(step, { step, agent, variant, startedAt: Date.now(), finishedAt: null }));
    const w = new Worker(new URL("../ai/thinkWorker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (e: MessageEvent<ThinkResponse>) => {
      const msg = e.data;
      setRuns((m) => {
        const r = m.get(step);
        if (!r || r.variant !== variant) return m;
        const done: ThoughtRun = { ...r, finishedAt: Date.now() };
        if (msg.type === "thought") done.thought = msg.thought;
        else done.error = msg.message;
        return new Map(m).set(step, done);
      });
      w.terminate();
      if (worker.current === w) worker.current = null;
    };
    const request: ThinkRequest = { agent, state, rng };
    w.postMessage(request);
  };

  return { runs, start };
}

interface Props {
  state: GameState;
  /** 局面の番号（結果はこれごとに残す） */
  step: number;
  /** 実戦で打った手（あれば表で示す） */
  actual?: Action | undefined;
  names: [string, string];
  /** 試合の AI（プレイヤー0・1） */
  matchAgents: [string, string];
  seed: number;
  thoughts: ReturnType<typeof useThoughts>;
  /** 説明の文言（既定はリプレイ向け） */
  caption?: string;
}

/** 表に出す読み直さなかった手の数（それより多ければ「すべて表示」） */
const SHOW_UNREAD = 4;

const points = (x: number) => (Math.abs(x) < 0.05 ? "0.0" : x < 0 ? `−${Math.abs(x).toFixed(1)}` : x.toFixed(1));
const signed = (x: number) => (x >= 0.05 ? `+${x.toFixed(1)}` : x <= -0.05 ? `−${Math.abs(x).toFixed(1)}` : "±0.0");

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`;
}

export function AiThought({ state, step, actual, names, matchAgents, seed, thoughts, caption }: Props) {
  const actor = actingPlayer(state);
  const agent = matchAgents[actor];
  const label = AGENTS[agent]?.label ?? agent;
  const [open, setOpen] = useState(false);
  const run = thoughts.runs.get(step);
  const supported = THINKING_AGENTS.has(agent);
  const think = (variant: number) =>
    thoughts.start(step, agent, variant, state, (seed ^ Math.imul(step + 1, 0x27d4eb2d) ^ Math.imul(variant, 0x165667b1)) >>> 0);

  return (
    <div class="banner column branch thought">
      <div class="branch-head">
        <button type="button" class={open ? "active" : ""} onClick={() => setOpen(!open)}>
          {open ? "AI の考えを閉じる" : "AI の考え"}
        </button>
        <span class="muted">{caption ?? `${step + 1} 手目（${names[actor]}の手）で、${label}が比べた手と点数の内訳を出します`}</span>
      </div>
      {open &&
        (!supported ? (
          <div class="muted">この AI（{label}）は考えを表示できません。探索 AI をもとにした AI だけです。</div>
        ) : (
          <>
            <div class="row-buttons">
              {run?.finishedAt === null ? (
                <span class="muted">考えています…</span>
              ) : (
                <button type="button" class="primary" onClick={() => think(run ? run.variant + 1 : 0)}>
                  {run ? "別の並べ直しで考え直す" : "考える"}
                </button>
              )}
            </div>
            {run && run.finishedAt !== null && <ThoughtResult run={run} state={state} actual={actual} names={names} actor={actor} />}
          </>
        ))}
    </div>
  );
}

/** 局面 root から並び steps を打ったときの、手ごとの文言（打てなくなったところで止める） */
function describeSteps(root: GameState, steps: readonly Action[], names: [string, string], actor: PlayerIndex): string[] {
  const out: string[] = [];
  let cur = root;
  const prefix = `${names[actor]}: `;
  for (const a of steps) {
    const next = tryApplyAction(cur, a);
    const text = describeAction(cur, a, names, next ?? undefined);
    out.push(text.startsWith(prefix) ? text.slice(prefix.length) : text);
    if (!next) break;
    cur = next;
  }
  return out;
}

function Parts({ p, showExtra }: { p: ScoreParts; showExtra: boolean }) {
  const other = p.total - p.eval - p.extra;
  return (
    <>
      <strong>{points(p.total)}</strong>
      {showExtra && (
        <span class="muted">
          {" "}
          = {points(p.eval)} {signed(p.extra)}
          {Math.abs(other) >= 0.05 && ` ${signed(other)}`}
        </span>
      )}
    </>
  );
}

function ThoughtResult({
  run,
  state,
  actual,
  names,
  actor,
}: {
  run: ThoughtRun;
  state: GameState;
  actual: Action | undefined;
  names: [string, string];
  actor: PlayerIndex;
}) {
  const [all, setAll] = useState(false);
  const thought = run.thought;
  const rows = useMemo(() => {
    if (!thought) return [];
    return thought.candidates.map((c) => ({ c, lines: describeSteps(thought.roots[c.sample]!, c.steps, names, actor) }));
  }, [thought, names, actor]);
  if (run.error) return <div class="problems">エラー: {run.error}</div>;
  if (!thought) return <div class="muted">この局面（マリガン、または打てる手が 1 つ）は考えを表示しません。</div>;

  const key = (a: Action) => JSON.stringify(a);
  const actualKey = actual ? key(actual) : null;
  const chosenKey = key(thought.chosen);
  const read = rows.filter((r) => r.c.read);
  const unread = rows.filter((r) => !r.c.read);
  const shownUnread = all ? unread : unread.slice(0, SHOW_UNREAD);
  // 評価に足す項がどれも 0（学習した補正を使わない AI）なら内訳を出さない
  const showExtra = rows.some((r) => Math.abs(r.c.turnEnd.extra) >= 0.05 || Math.abs(r.c.read?.extra ?? 0) >= 0.05);
  const samples = thought.roots.length;
  // 選ぶときの値が読んだ後の点数と違う（読んだ後の点数にターン末の点数を混ぜる AI など）なら、その列を出す
  const showValue = read.some((r) => r.c.value !== null && r.c.read !== null && Math.abs(r.c.value - r.c.read.total) >= 0.05);
  const lethalLabel = thought.lethal ? describeSteps(state, [thought.lethal], names, actor)[0] : null;

  const row = ({ c, lines }: { c: ThoughtCandidate; lines: string[] }, rank: number | null) => {
    const k = key(c.action);
    return (
      <tr key={k} class={k === chosenKey ? "chosen" : ""}>
        <td class="num">{rank ?? ""}</td>
        <td>
          <div>
            {lines[0]}
            {k === chosenKey && <span class="branch-tag">選ぶ手</span>}
            {k === actualKey && <span class="branch-tag actual">実戦</span>}
            {!c.legal && <span class="muted">（実際の局面では打てない）</span>}
          </div>
          {lines.length > 1 && <div class="muted thought-steps">→ {lines.slice(1).join(" → ")}</div>}
        </td>
        <td class="num">
          <Parts p={c.turnEnd} showExtra={showExtra} />
        </td>
        <td class="num">
          {c.read ? (
            <>
              <Parts p={c.read} showExtra={showExtra} />
              {samples > 1 && <span class="muted">（{c.readCount}/{samples} 回）</span>}
            </>
          ) : (
            "—"
          )}
        </td>
        {showValue && <td class="num">{c.value !== null ? <strong>{points(c.value)}</strong> : "—"}</td>}
      </tr>
    );
  };

  return (
    <div class="branch-result">
      <div class="muted">
        {seconds((run.finishedAt ?? run.startedAt) - run.startedAt)}で考えました
        {run.variant > 0 && ` / ${run.variant + 1} 回目の並べ直し`}
        {samples > 1 && ` / 並べ直し ${samples} 回の平均で選ぶ AI`}
      </div>
      {lethalLabel && (
        <div>
          <strong>リーサルを見つけた</strong>ので、並びを比べずに「{lethalLabel}」を打ちます。
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th></th>
            <th>最初の手と、続く並び</th>
            <th title="このターンの終わりの局面の点数（ビームサーチが並びを選んだ点数）">ターン末{showExtra && "（評価 ＋ 補正）"}</th>
            <th
              title={
                showValue
                  ? "相手のターンを読んだ後の点数（相手の手札を並べ直して読んだ平均）"
                  : "相手のターンを読んだ後の点数（相手の手札を並べ直して読んだ平均）。AI はこの点数の高い手を選ぶ"
              }
            >
              相手のターンの後{showExtra && "（評価 ＋ 補正）"}
            </th>
            {showValue && (
              <th title="相手のターンの後の点数にターン末の点数を混ぜた値。AI はこの値の高い手を選ぶ">選ぶときの値</th>
            )}
          </tr>
        </thead>
        <tbody>
          {read.map((r, i) => row(r, i + 1))}
          {unread.length > 0 && (
            <tr class="thought-sep">
              <td colSpan={showValue ? 5 : 4} class="muted">
                相手のターンを読み直さなかった手（ターン末の点数の高い順に {unread.length} 個）
              </td>
            </tr>
          )}
          {shownUnread.map((r) => row(r, null))}
        </tbody>
      </table>
      {unread.length > SHOW_UNREAD && (
        <div>
          <button type="button" onClick={() => setAll(!all)}>
            {all ? `上位 ${SHOW_UNREAD} 個だけ表示` : `すべて表示（${unread.length} 個）`}
          </button>
        </div>
      )}
      <div class="muted">
        点数は評価関数の点（大きいほど{names[actor]}に良い）。
        {showExtra && "「評価」は手で作った評価関数、「補正」は学習した補正（リノセウス用 AI のエルフではリノセウスの打点の項も含む）。3 つ目の数があれば残り PP の罰などです。"}
        {" "}AI から見えない相手の手札・山札の中身と山札の順番は並べ直して読むので、並べ直し方で点数と選ぶ手が変わることがあります（並びの途中で引くカードも予想です）。
        {actual && "AI は同じターンの途中では、局面が予想どおりならターンの初めに決めた並びを続けるので、実戦の手がここで選ぶ手と違うことがあります。"}
      </div>
    </div>
  );
}
