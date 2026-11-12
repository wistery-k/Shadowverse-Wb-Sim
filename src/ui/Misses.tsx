// 見落とし問題集（misses/*.json。docs/misses.md）の局面を見る画面。公開のサイトにも出す。
// 見られるのはリポジトリにある決まった局面だけで、局面の編集・貼り付け・ファイルや URL からの読み込みは付けない
// （実際の対戦の局面を入れて AI の手を聞く使い方ができないようにする。CLAUDE.md「ソフト打ち」）。
// 問の一覧 → 盤面・題・合格の条件。打ち比べ調査で比べた並びと、今の AI に打たせた並びを 1 手ずつ進めて見て、ターンの終わりに合格を判定する。

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AGENTS } from "../ai/registry";
import type { AgentRequest, AgentResponse } from "../ai/worker";
import { CLASS_NAMES, type ClassId } from "../cards";
import { actingPlayer, applyAction, cardOf, legalActions, opponent, type Action, type GameState, type PlayerIndex } from "../engine";
import type { MissesData } from "../misses/data";
import { condTexts, judgeTurn, type MissLine, type MissProblem } from "../misses/problems";
import { AiThought, useThoughts } from "./AiThought";
import { CardDetail, CardView, type Motion } from "./CardView";
import { attackStatuses, describeAction, leaderClasses } from "./describe";
import { BoardSlots, EmptySlots, LeaderHp, PlayerInfo, Resources } from "./Game";

const REPO_URL = "https://github.com/wistery-k/Shadowverse-Wb-Sim";
/** 1 ターンに AI が打つ手の上限（これを超えたら止める） */
const MAX_AI_STEPS = 200;
/** 相手の選択待ちを選ぶ AI（Rust の misses run と同じく今の既定の探索 AI） */
const OPP_AGENT = "search";

// ---------------------------------------------------------------- URL の #misses/<問>

const HASH = "#misses";
/** URL が問題集を指しているか（App が最初に開くタブを決める） */
export const isMissesHash = () => typeof location !== "undefined" && location.hash.startsWith(HASH);
function hashId(): string | null {
  const m = typeof location !== "undefined" ? /^#misses\/(.+)$/.exec(location.hash) : null;
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}
function setHash(id: string | null) {
  try {
    history.replaceState(null, "", id ? `${HASH}/${encodeURIComponent(id)}` : HASH);
  } catch {
    // 書き換えられなくても画面は動く
  }
}

// ---------------------------------------------------------------- 乱数

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}
function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------- 画面

interface Props {
  /** 問題集のタブを開いているか（開いたときに URL を今の問に合わせる） */
  active: boolean;
  /** 今の局面をサンドボックスで開く（開発サーバーだけ） */
  onSandbox?: ((state: GameState, label: string) => void) | undefined;
}

export function Misses({ active, onSandbox }: Props) {
  const [data, setData] = useState<MissesData | null>(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    import("../misses/data").then(
      (m) => setData(m.loadMisses()),
      (e: unknown) => setLoadError(String(e)),
    );
  }, []);
  const [openId, setOpenId] = useState<string | null>(hashId);
  const open = (id: string | null) => {
    setOpenId(id);
    setHash(id);
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    if (active) setHash(openId);
  }, [active]);

  if (loadError) return <p class="problems">問題集を読み込めませんでした: {loadError}</p>;
  if (!data) return <p class="muted">問題集を読み込んでいます…</p>;
  const index = openId ? data.problems.findIndex((p) => p.id === openId) : -1;
  const problem = data.problems[index];
  if (!problem) return <MissList data={data} unknown={openId} onOpen={open} />;
  const neighbor = (d: number) => data.problems[index + d]?.id ?? null;
  return (
    <MissView
      key={problem.id}
      problem={problem}
      lines={data.lines.get(problem.id)?.lines ?? []}
      linesSource={data.lines.get(problem.id)?.source ?? null}
      position={`${index + 1}/${data.problems.length}`}
      prev={neighbor(-1)}
      next={neighbor(1)}
      onOpen={open}
      onSandbox={onSandbox}
    />
  );
}

/** 席 p の自分のターンの番号（先攻は奇数、後攻は偶数のターン） */
const ownTurn = (s: GameState) => Math.ceil(s.turn / 2);

function MissList({ data, unknown, onOpen }: { data: MissesData; unknown: string | null; onOpen: (id: string | null) => void }) {
  const rows = useMemo(
    () =>
      data.problems.map((p) => {
        const classes = leaderClasses(p.state);
        return { p, me: classes[p.player], opp: classes[opponent(p.player)] };
      }),
    [data],
  );
  return (
    <div class="misses panel">
      <h2>見落とし問題集（{data.problems.length} 問）</h2>
      <p class="muted">
        人間が見て分かった AI のミスの局面を、合格の条件つきで集めたものです。局面はどれもこのシミュレータの中の試合（AI どうしの自己対戦・人間とこのシミュレータの
        AI の対戦・手で作った局面）から取ったもので、ここで見られるのはリポジトリにある問だけです。問を選ぶと、盤面と正解の理由、打ち比べた手の並びを見られます。
        問の足し方と使い方は{" "}
        <a href={`${REPO_URL}/blob/main/docs/misses.md`} target="_blank" rel="noreferrer">
          docs/misses.md
        </a>
        。
      </p>
      {unknown && <p class="problems">問「{unknown}」は見つかりませんでした。</p>}
      {data.errors.length > 0 && (
        <ul class="problems">
          {data.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div class="misses-table-wrap">
        <table class="misses-table">
          <thead>
            <tr>
              <th>問</th>
              <th>クラス</th>
              <th>相手</th>
              <th title="手番の側の何ターン目か（先攻・後攻）">ターン</th>
              <th>正解</th>
              <th title="解かせる AI">AI</th>
              <th>足した日</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, me, opp }) => (
              <tr key={p.id} onClick={() => onOpen(p.id)}>
                <td>
                  <a
                    href={`${HASH}/${encodeURIComponent(p.id)}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onOpen(p.id);
                    }}
                  >
                    {p.id}
                  </a>
                </td>
                <td>
                  <span class={`class-tag class-${me}`}>{CLASS_NAMES[me]}</span>
                </td>
                <td>
                  <span class={`class-tag class-${opp}`}>{CLASS_NAMES[opp]}</span>
                </td>
                <td class="num">
                  {ownTurn(p.state)}
                  <span class="muted">{p.state.first === p.player ? "（先）" : "（後）"}</span>
                </td>
                <td>{p.title}</td>
                <td>{p.agent === "rhino" ? "リノセウス用" : "探索"}</td>
                <td class="num">{p.added}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 盤面で進めて見る手の並び */
interface Run {
  /** 並びの番号（AI の考えの結果をこれと手の番号で残す） */
  key: number;
  label: string;
  actions: Action[];
  /** actions のうち、もとの並び（調査の並び）の手の数。その後は今の AI が打った手かターン終了 */
  base: number;
  /** 打ち比べ調査の並び */
  survey: MissLine | null;
  /** 今の AI に続きを打たせた回数（乱数を変える） */
  tries: number;
}

interface ViewProps {
  problem: MissProblem;
  lines: readonly MissLine[];
  linesSource: string | null;
  position: string;
  prev: string | null;
  next: string | null;
  onOpen: (id: string | null) => void;
  onSandbox?: ((state: GameState, label: string) => void) | undefined;
}

function MissView({ problem, lines, linesSource, position, prev, next, onOpen, onSandbox }: ViewProps) {
  const p = problem.player;
  const start = problem.state;
  const names = useMemo((): [string, string] => (p === 0 ? ["自分", "相手"] : ["相手", "自分"]), [p]);
  const classes = useMemo(() => leaderClasses(start), [start]);
  const matchAgents = useMemo((): [string, string] => (p === 0 ? [problem.agent, OPP_AGENT] : [OPP_AGENT, problem.agent]), [p, problem.agent]);
  const seed = useMemo(() => fnv(problem.id), [problem.id]);

  const nextKey = useRef(1);
  const [runs, setRuns] = useState<Run[]>(() =>
    lines.map((l) => ({ key: nextKey.current++, label: l.label, actions: [...l.steps], base: l.steps.length, survey: l, tries: 0 })),
  );
  // 盤面に出す並び（null は局面だけ）と手の番号
  const [sel, setSel] = useState<number | null>(null);
  const [step, setStep] = useState(0);
  const [showOpp, setShowOpp] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [running, setRunning] = useState<number | null>(null);
  const [error, setError] = useState("");
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);
  const thoughts = useThoughts();

  const run = sel === null ? null : (runs.find((r) => r.key === sel) ?? null);
  const actions = run?.actions ?? [];
  const states = useMemo(() => {
    const out = [start];
    for (const a of actions) out.push(applyAction(out[out.length - 1]!, a));
    return out;
  }, [start, actions]);
  const last = states.length - 1;
  const cur = Math.min(step, last);
  const state = states[cur]!;
  const lineTexts = useMemo(() => actions.map((a, i) => describeAction(states[i]!, a, names, states[i + 1])), [states, names]);
  const judged = useMemo(() => (run ? judgeTurn(start, run.actions, p, problem.pass) : null), [run, start, p, problem.pass]);

  const go = (s: number) => setStep(Math.max(0, Math.min(last, s)));
  const select = (key: number | null, at?: number) => {
    setSel(key);
    setStep(at ?? 0);
    setError("");
  };

  // ---- 今の AI に打たせる（思考は Web Worker。打つたびに盤面を進める） ----

  function stopAi() {
    cancel.current?.();
    cancel.current = null;
    setRunning(null);
  }

  async function playOn(r: Run) {
    if (running !== null) return;
    const key = r.key;
    const turnSeed = mix(seed, mix(r.key, r.tries));
    setRuns((xs) => xs.map((x) => (x.key === key ? { ...x, tries: x.tries + 1 } : x)));
    let s = start;
    for (const a of r.actions) s = applyAction(s, a);
    const worker = new Worker(new URL("../ai/worker.ts", import.meta.url), { type: "module" });
    let cancelled = false;
    cancel.current = () => {
      cancelled = true;
      worker.terminate();
    };
    setRunning(key);
    setError("");
    const ask = (agent: string, st: GameState, legal: Action[], k: number) =>
      new Promise<Action>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<AgentResponse>) => {
          if (e.data.id !== k) return;
          if (e.data.action) resolve(e.data.action);
          else reject(new Error(`AI の思考でエラー: ${e.data.error ?? "手を選べませんでした"}`));
        };
        const request: AgentRequest = { id: k, agent, state: st, legal, seed: mix(turnSeed, k) };
        worker.postMessage(request);
      });
    let done = r.actions.length;
    try {
      for (let k = 0; k < MAX_AI_STEPS; k++) {
        if (s.phase === "ended") break;
        const legal = legalActions(s);
        if (legal.length === 0) break;
        const actor = actingPlayer(s);
        const a = await ask(actor === p ? problem.agent : OPP_AGENT, s, legal, k);
        if (cancelled) return;
        const endTurn = actor === p && a.type === "endTurn";
        s = applyAction(s, a);
        done++;
        setRuns((xs) => xs.map((x) => (x.key === key ? { ...x, actions: [...x.actions, a] } : x)));
        setStep(done);
        if (endTurn || (s.phase !== "ended" && s.active !== p)) break;
      }
    } catch (e) {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    } finally {
      worker.terminate();
      if (!cancelled) {
        cancel.current = null;
        setRunning(null);
      }
    }
  }

  function newAiRun() {
    if (running !== null) return;
    const n = runs.filter((r) => !r.survey).length + 1;
    const r: Run = { key: nextKey.current++, label: `今の AI（${n}）`, actions: [], base: 0, survey: null, tries: 0 };
    setRuns((xs) => [...xs, r]);
    select(r.key);
    void playOn(r);
  }

  function endTurnHere(key: number) {
    setRuns((xs) => xs.map((x) => (x.key === key ? { ...x, actions: [...x.actions, { type: "endTurn" }] } : x)));
    setStep(last + 1);
  }
  function resetRun(key: number) {
    setRuns((xs) => xs.map((x) => (x.key === key ? { ...x, actions: x.actions.slice(0, x.base) } : x)));
    setStep((s) => Math.min(s, run?.base ?? 0));
  }

  // ---- キー操作 ----

  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (!rootRef.current?.offsetParent) return;
      if (e.key === "ArrowLeft") go(cur - 1);
      else if (e.key === "ArrowRight") go(cur + 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const logRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    logRef.current?.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }, [cur, sel]);

  // ---- 盤面 ----

  const attackable = useMemo(() => attackStatuses(state), [state]);
  const actable = useMemo(
    () => new Set(state.phase === "main" && !state.pending ? legalActions(state).flatMap((a) => (a.type === "act" ? [a.iid] : [])) : []),
    [state],
  );
  const { motions, leaderHit } = useMemo(() => {
    const motions = new Map<number, Motion>();
    let leaderHit: PlayerIndex | null = null;
    const before = cur > 0 ? states[cur - 1]! : null;
    const action = cur > 0 ? actions[cur - 1] : undefined;
    if (before) {
      for (const q of [0, 1] as const) {
        const had = new Set(before.players[q].board.map((c) => c.iid));
        for (const c of state.players[q].board) if (c.kind === "follower" && !had.has(c.iid)) motions.set(c.iid, "summon");
      }
    }
    if (before && action?.type === "attack") {
      motions.set(action.attacker, before.active === p ? "attack-up" : "attack-down");
      if (action.target === "leader") leaderHit = opponent(before.active);
      else motions.set(action.target, "hit");
    }
    return { motions, leaderHit };
  }, [states, cur, p]);

  const side = (q: PlayerIndex, top: boolean) => {
    const pl = state.players[q];
    const hidden = q !== p && !showOpp;
    const board = (
      <div class="board">
        {pl.board.map((c) => {
          const motion = motions.get(c.iid) ?? null;
          return (
            <CardView
              key={motion ? `${c.iid}-${sel}-${cur}` : c.iid}
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
        <div key={leaderHit === q ? `leader-${sel}-${cur}` : "leader"} class={`leader class-${classes[q]} ${leaderHit === q ? "motion-hit" : ""}`}>
          {names[q]}のリーダー <LeaderHp hp={pl.leaderHp} max={pl.leaderMaxHp} />
        </div>
        <Resources state={state} p={q} />
      </div>
    );
    const info = (
      <div class="side-head">
        <PlayerInfo label={`${names[q]}${state.first === q ? "（先攻）" : "（後攻）"}`} state={state} p={q} cls={classes[q]} />
        {q !== p && (
          <button type="button" class={showOpp ? "active" : ""} onClick={() => setShowOpp(!showOpp)} title="相手の手札を表にする・伏せる（公開されたカードはいつも表）">
            {showOpp ? "相手の手札を伏せる" : "相手の手札を見る"}
          </button>
        )}
      </div>
    );
    const hand = (
      <div class="hand">
        {pl.hand.map((h) =>
          hidden && !h.revealed ? (
            <span key={h.iid} class="card-back hand-back" title="相手の手札（伏せています）" />
          ) : (
            <CardView key={h.iid} cardId={h.cardId} hand={h} note={q !== p && h.revealed ? "公開" : null} onClick={() => setDetail(h.cardId)} />
          ),
        )}
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

  const actor = state.phase === "main" ? actingPlayer(state) : null;
  const agentLabel = AGENTS[problem.agent]?.label ?? problem.agent;

  return (
    <div class="replay misses-view" ref={rootRef}>
      <div class="banner">
        <button type="button" onClick={() => onOpen(null)}>
          ← 問の一覧
        </button>
        <button type="button" disabled={!prev} onClick={() => prev && onOpen(prev)}>
          前の問
        </button>
        <button type="button" disabled={!next} onClick={() => next && onOpen(next)}>
          次の問
        </button>
        <span class="muted">{position}</span>
        <strong>{problem.id}</strong>
      </div>
      <MissInfo problem={problem} classes={classes} agentLabel={agentLabel} />
      <div class="game">
        {side(opponent(p), true)}
        {side(p, false)}
        <section class="controls">
          <div class="banner column">
            <div class="replay-buttons">
              <span class="muted">盤面で見る手:</span>
              <button type="button" class={sel === null ? "active" : ""} onClick={() => select(null)}>
                問の局面
              </button>
              {runs.map((r) => (
                <button type="button" key={r.key} class={sel === r.key ? "active" : ""} onClick={() => select(r.key, sel === r.key ? cur : 0)}>
                  {r.label}
                </button>
              ))}
              <button
                type="button"
                class="primary"
                disabled={running !== null}
                onClick={newAiRun}
                title={`問の局面から、${agentLabel} AI にこのターンを打たせます（毎回乱数を変えます。npm run misses -- run の回とは同じになりません）`}
              >
                今の AI にこのターンを打たせる
              </button>
            </div>
            {run && (
              <>
                <div class="replay-buttons">
                  <button type="button" onClick={() => go(0)} disabled={cur === 0}>
                    最初
                  </button>
                  <button type="button" title="←" onClick={() => go(cur - 1)} disabled={cur === 0}>
                    戻る
                  </button>
                  <button type="button" title="→" onClick={() => go(cur + 1)} disabled={cur === last}>
                    進む
                  </button>
                  <button type="button" onClick={() => go(last)} disabled={cur === last}>
                    最後
                  </button>
                  <span class="muted">
                    {cur}/{last} 手
                  </span>
                  {onSandbox && (
                    <button type="button" title="この局面を「サンドボックス」タブで開きます（開発サーバーだけ）" onClick={() => onSandbox(state, `問題集の局面（${problem.id}、${run.label}の ${cur} 手目の後）`)}>
                      サンドボックスで開く
                    </button>
                  )}
                </div>
                {last > 0 && <input type="range" min={0} max={last} value={cur} onInput={(e) => go(Number(e.currentTarget.value))} />}
                <div>{cur === 0 ? "問の局面" : `直前: ${lineTexts[cur - 1]}`}</div>
                {cur < last && <div class="muted">次: {lineTexts[cur]}</div>}
                <RunEnd
                  run={run}
                  judged={judged}
                  running={running === run.key}
                  canEnd={states[last]!.phase === "main" && legalActions(states[last]!).some((a) => a.type === "endTurn")}
                  agentLabel={agentLabel}
                  onPlay={() => void playOn(run)}
                  onStop={stopAi}
                  onEnd={() => endTurnHere(run.key)}
                  onReset={() => resetRun(run.key)}
                />
              </>
            )}
            {sel === null && (
              <div class="muted">
                {lines.length > 0
                  ? "上のボタンで、打ち比べ調査で比べた 2 つの並びか、今の AI に打たせた並びを盤面で 1 手ずつ進めて見られます。"
                  : "上のボタンで、今の AI に打たせた並びを盤面で 1 手ずつ進めて見られます。"}
              </div>
            )}
            {error && <div class="problems">{error}</div>}
          </div>
          {actor !== null && state.phase === "main" && running === null && (
            <AiThought
              state={state}
              step={(sel ?? 0) * 1000 + cur}
              names={names}
              matchAgents={matchAgents}
              seed={seed}
              thoughts={thoughts}
              caption={`この局面（${names[actor]}の手番）で、${AGENTS[matchAgents[actor]]?.label ?? matchAgents[actor]} AI が比べた手と点数の内訳を出します`}
            />
          )}
        </section>
        <aside class="info">
          {detail ? <CardDetail card={cardOf(detail)} /> : <div class="muted">カードをクリックすると詳細を表示します</div>}
          {run && (
            <ol class="log replay-log" ref={logRef}>
              {lineTexts.map((line, i) => (
                <li key={i} class={i === cur - 1 ? "current" : i >= cur ? "muted" : ""} onClick={() => go(i + 1)}>
                  {line}
                  {i >= run.base && run.survey && <span class="branch-tag">続き</span>}
                </li>
              ))}
            </ol>
          )}
          {run?.survey && (
            <div class="panel misses-full">
              <div>
                <strong>調査で読んだ並び</strong>
              </div>
              <div>{run.survey.full.length > 0 ? run.survey.full.join(" → ") : "（何もせずターン終了）"}</div>
              <div class="muted">
                AI から見た局面（相手の手札・山札を並べ直したもの）で読んだターンの終わりまでの並びです。途中で引くカードは予想なので、引いた後の手は盤面の並びに入れず、AI が考え直します（調査と同じ）。
                {linesSource && ` 出どころ: 共有フォルダの ${linesSource}`}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** 問の説明（題・合格の条件・局面と正解の理由・出どころ） */
function MissInfo({ problem, classes, agentLabel }: { problem: MissProblem; classes: [ClassId, ClassId]; agentLabel: string }) {
  const p = problem.player;
  const s = problem.state;
  return (
    <div class="panel misses-info">
      <h2>{problem.title}</h2>
      <div class="muted">
        <span class={`class-tag class-${classes[p]}`}>{CLASS_NAMES[classes[p]]}</span> 対{" "}
        <span class={`class-tag class-${classes[opponent(p)]}`}>{CLASS_NAMES[classes[opponent(p)]]}</span> / 自分の {ownTurn(s)} ターン目（
        {s.first === p ? "先攻" : "後攻"}）/ 解かせる AI: {agentLabel} / 足した日: {problem.added} /{" "}
        <a href={`${REPO_URL}/blob/main/misses/${problem.id}.json`} target="_blank" rel="noreferrer">
          問のファイル
        </a>
      </div>
      <div class="misses-pass">
        <strong>合格の条件</strong>
        {problem.pass.length > 1 && <span class="muted">（どれか 1 つを満たせば合格）</span>}
        <ul>
          {problem.pass.map((c, i) => (
            <li key={i}>{condTexts(c).join("、")}</li>
          ))}
        </ul>
        <code class="muted">{problem.passJson}</code>
      </div>
      <p>{problem.note}</p>
      {problem.originNote && <p class="muted">局面のメモ: {problem.originNote}</p>}
      {problem.played && (
        <p class="muted">元の試合でこの局面から打った手: {problem.played.length > 0 ? problem.played.join(" → ") : "（何もせずターン終了）"}</p>
      )}
      <p class="muted">出どころ: {problem.source}</p>
    </div>
  );
}

/** 並びの終わり: ターンが終わっていれば合格の判定、途中なら続きを打たせるボタン */
function RunEnd({
  run,
  judged,
  running,
  canEnd,
  agentLabel,
  onPlay,
  onStop,
  onEnd,
  onReset,
}: {
  run: Run;
  judged: ReturnType<typeof judgeTurn> | null;
  running: boolean;
  canEnd: boolean;
  agentLabel: string;
  onPlay: () => void;
  onStop: () => void;
  onEnd: () => void;
  onReset: () => void;
}) {
  const extended = run.actions.length > run.base;
  const reset = run.survey && extended && !running && (
    <button type="button" onClick={onReset}>
      調査の並びに戻す
    </button>
  );
  if (running)
    return (
      <div class="row-buttons">
        <span class="muted">{agentLabel} AI が考えています…</span>
        <button type="button" onClick={onStop}>
          止める
        </button>
      </div>
    );
  if (judged?.done)
    return (
      <div class="row-buttons">
        <strong class={judged.passed ? "misses-pass-ok" : "misses-pass-ng"}>{judged.passed ? "○ 合格" : "× 不合格"}</strong>
        <span class="muted">
          {judged.won ? "このターンに勝ち" : `ターンを終えたときの自分の体力 ${judged.hp}`}
        </span>
        {reset}
      </div>
    );
  return (
    <div class="row-buttons">
      {run.survey && !extended && (
        <span class="muted">{run.survey.full.length > run.base ? "調査の AI はここで考え直します。" : "調査の並びはここまでです。"}</span>
      )}
      <button type="button" class="primary" onClick={onPlay} title="ターンの終わりまで、今の AI に続きを打たせます（打たせるたびに乱数を変えます）">
        続きを今の AI に打たせる
      </button>
      {canEnd && (
        <button type="button" onClick={onEnd}>
          ここでターン終了
        </button>
      )}
      {reset}
    </div>
  );
}
