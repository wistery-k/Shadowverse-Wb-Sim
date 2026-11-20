// 見落とし問題集（misses/*.json。docs/misses.md）の局面を見る画面。公開のサイトにも出す。
// 見られるのはリポジトリにある決まった局面だけで、局面の編集・貼り付け・ファイルや URL からの読み込みは付けない
// （実際の対戦の局面を入れて AI の手を聞く使い方ができないようにする。CLAUDE.md「ソフト打ち」）。
// 問の一覧 → 盤面・題・合格の条件。打ち比べ調査で比べた並びと、今の AI に打たせた並びを 1 手ずつ進めて見て、ターンの終わりに合格を判定する。
// 並びのファイルにターンの終わりまでの手（actions）がある問は、盤面の下に「手順の候補」として並べ、盤面を問の局面と各手順の後の局面で
// 切り替えられるようにする。引いたカード・ランダムな結果に頼る手は、色を変えて一例と分かるようにする（src/misses/example.ts）。
// 手の一覧では、選ぶ手・効果を選ぶ手を直前の手とまとめる（「海蝕の三叉槍をプレイ（明越花・アラを選択）」。ユーザーの依頼 2026-11-19）

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AGENTS } from "../ai/registry";
import type { AgentRequest, AgentResponse } from "../ai/worker";
import { CLASS_NAMES, type ClassId } from "../cards";
import { actingPlayer, applyAction, cardOf, legalActions, opponent, type Action, type GameState, type PlayerIndex, workerName } from "../engine";
import { deckRows } from "../misses/deck";
import { groupNote, stepGroups, stepNotes, type StepGroup, type StepNote } from "../misses/example";
import type { MissesData } from "../misses/load";
import { condTexts, judgeTurn, passesBefore, type MissDeck, type MissLine, type MissProblem } from "../misses/problems";
import { AiThought, useThoughts } from "./AiThought";
import { CardDetail, CardView, type Motion } from "./CardView";
import { attackStatuses, describeAction, leaderClasses, modeLabels } from "./describe";
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

/** 問のフォルダ（ページごと） */
export interface MissesSource {
  /** 問を読み込む（問のモジュールを開く。別のチャンクにする） */
  load: () => Promise<MissesData>;
  /** リポジトリの中の問のフォルダ（問のファイルへのリンクに使う） */
  dir: string;
  /** 問の一覧の上の説明（問がどこから来たか） */
  about: string;
}

/** スターターのページの問題集（misses/*.json） */
export const STARTER_MISSES: MissesSource = {
  load: () => import("../misses/data").then((m) => m.loadMisses()),
  dir: "misses",
  about:
    "局面はどれもこのシミュレータの中の試合（AI どうしの自己対戦・人間とこのシミュレータの AI の対戦・手で作った局面）から取ったもので、ここで見られるのはリポジトリにある問だけです。",
};

interface Props {
  /** 問のフォルダ（既定はスターターのページの問） */
  source?: MissesSource;
  /** 問題集のタブを開いているか（開いたときに URL を今の問に合わせる） */
  active: boolean;
  /** 今の局面をサンドボックスで開く（開発サーバーだけ） */
  onSandbox?: ((state: GameState, label: string) => void) | undefined;
}

export function Misses({ source = STARTER_MISSES, active, onSandbox }: Props) {
  const [data, setData] = useState<MissesData | null>(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    source.load().then(
      (d) => setData(d),
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
  if (!problem) return <MissList data={data} about={source.about} unknown={openId} onOpen={open} />;
  const neighbor = (d: number) => data.problems[index + d]?.id ?? null;
  return (
    <MissView
      key={problem.id}
      problem={problem}
      lines={data.lines.get(problem.id)?.lines ?? []}
      linesSource={data.lines.get(problem.id)?.source ?? null}
      decks={data.lines.get(problem.id)?.decks ?? null}
      position={`${index + 1}/${data.problems.length}`}
      prev={neighbor(-1)}
      next={neighbor(1)}
      dir={source.dir}
      onOpen={open}
      onSandbox={onSandbox}
    />
  );
}

/** 席 p の自分のターンの番号（先攻は奇数、後攻は偶数のターン） */
const ownTurn = (s: GameState) => Math.ceil(s.turn / 2);

function MissList({ data, about, unknown, onOpen }: { data: MissesData; about: string; unknown: string | null; onOpen: (id: string | null) => void }) {
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
        人間が見て分かった AI のミスの局面を、合格の条件つきで集めたものです。{about}問を選ぶと、盤面と正解の理由、打ち比べた手の並びを見られます。
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

/** 手の説明（自分の手は「自分: 」を省く） */
function stepLabel(state: GameState, a: Action, names: [string, string], p: PlayerIndex, after: GameState | undefined): string {
  const text = describeAction(state, a, names, after);
  const own = `${names[p]}: `;
  return text.startsWith(own) ? text.slice(own.length) : text;
}

/** まとまりの説明: 頭の手の説明に、選んだもの・選んだ効果を括弧で添える（「海蝕の三叉槍をプレイ（明越花・アラを選択）」） */
function groupLabel(states: readonly GameState[], actions: readonly Action[], g: StepGroup, names: [string, string], strip: PlayerIndex | null): string {
  const head = actions[g.start]!;
  const before = states[g.start]!;
  const text = describeAction(before, head, names, states[g.start + 1]);
  const own = strip === null ? null : `${names[strip]}: `;
  const label = own && text.startsWith(own) ? text.slice(own.length) : text;
  const parts: string[] = [];
  for (let k = g.start + 1; k <= g.end; k++) {
    const a = actions[k]!;
    const st = states[k]!;
    if (a.type === "mode") parts.push(`「${modeLabels(st)[a.index] ?? `${a.index + 1} 番目の効果`}」を選択`);
    else {
      const t = describeAction(st, a, names);
      const who = `${names[actingPlayer(st)]}: `;
      parts.push(t.startsWith(who) ? t.slice(who.length) : t);
    }
  }
  return parts.length > 0 ? `${label}（${parts.join("、")}）` : label;
}

/** 手の後ろに添える注釈（引いたカード・ランダムな結果） */
function noteText(note: StepNote, after: GameState | undefined): string {
  const parts: string[] = [];
  if (note.drew.length > 0 && after) {
    const name = (iid: number) => {
      for (const pl of after.players) {
        const h = pl.hand.find((x) => x.iid === iid);
        if (h) return cardOf(h.cardId).name;
      }
      return "?";
    };
    parts.push(`引いた: ${note.drew.map(name).join("・")}`);
  }
  if (note.random) parts.push("ランダムな結果");
  return parts.length > 0 ? `（${parts.join("、")}）` : "";
}

/** 手順の候補 1 つ（ターンの終わりまでの手がある並び） */
interface Candidate {
  line: MissLine;
  actions: Action[];
  states: GameState[];
  /** 選ぶ手を直前の手とまとめた手の一覧 */
  groups: StepGroup[];
  notes: StepNote[];
  labels: string[];
  judged: ReturnType<typeof judgeTurn>;
  /** 不合格だが、AI が打つ前の手（調査で読んだ並び）まででターンを終えれば合格する */
  readPasses: boolean;
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
  /** リポジトリの中の問のフォルダ */
  dir: string;
  lines: readonly MissLine[];
  linesSource: string | null;
  /** 両方の席のデッキ（手順の候補のファイルにあれば） */
  decks: readonly [MissDeck, MissDeck] | null;
  position: string;
  prev: string | null;
  next: string | null;
  onOpen: (id: string | null) => void;
  onSandbox?: ((state: GameState, label: string) => void) | undefined;
}

function MissView({ problem, dir, lines, linesSource, decks, position, prev, next, onOpen, onSandbox }: ViewProps) {
  const p = problem.player;
  const start = problem.state;
  const names = useMemo((): [string, string] => (p === 0 ? ["自分", "相手"] : ["相手", "自分"]), [p]);
  const classes = useMemo(() => leaderClasses(start), [start]);
  const matchAgents = useMemo((): [string, string] => (p === 0 ? [problem.agent, OPP_AGENT] : [OPP_AGENT, problem.agent]), [p, problem.agent]);
  const seed = useMemo(() => fnv(problem.id), [problem.id]);

  const nextKey = useRef(1);
  const [runs, setRuns] = useState<Run[]>(() =>
    lines.map((l) => {
      const actions = [...(l.actions ?? l.steps)];
      return { key: nextKey.current++, label: l.label, actions, base: actions.length, survey: l, tries: 0 };
    }),
  );
  // 手順の候補（ターンの終わりまでの手がある並び。盤面の下に並べる）
  const candidates = useMemo(
    () =>
      lines.flatMap((line): Candidate[] => {
        if (!line.actions) return [];
        const actions = line.actions;
        const states = [start];
        for (const a of actions) states.push(applyAction(states[states.length - 1]!, a));
        const groups = stepGroups(states, actions);
        const notes = stepNotes(states, actions, line.rethink);
        return [
          {
            line,
            actions,
            states,
            groups,
            notes: groups.map((g) => groupNote(notes, g)),
            labels: groups.map((g) => groupLabel(states, actions, g, names, p)),
            judged: judgeTurn(start, actions, p, problem.pass),
            readPasses: passesBefore(start, actions, line.rethink, p, problem.pass) && judgeTurn(start, actions, p, problem.pass).passed === false,
          },
        ];
      }),
    [lines, start, names, p, problem.pass],
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
  const notes = useMemo(() => stepNotes(states, actions, run?.survey?.rethink ?? null), [states, run]);
  // 右の手の一覧（選ぶ手を直前の手とまとめる）
  const logItems = useMemo(() => {
    const groups = stepGroups(states, actions);
    return groups.map((g) => ({ g, label: groupLabel(states, actions, g, names, null), note: groupNote(notes, g) }));
  }, [states, actions, names, notes]);
  const judged = useMemo(() => (run ? judgeTurn(start, run.actions, p, problem.pass) : null), [run, start, p, problem.pass]);

  const go = (s: number) => setStep(Math.max(0, Math.min(last, s)));
  const select = (key: number | null, at?: number) => {
    setSel(key);
    setStep(at ?? 0);
    setError("");
  };
  /** 盤面で見る手のボタン: 手順の候補は打った後の局面、ほかは最初から（選び直したときは今の手のまま） */
  const pick = (r: Run) => select(r.key, sel === r.key ? cur : r.survey?.actions ? r.actions.length : 0);

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
    const worker = new Worker(new URL("../ai/worker.ts", import.meta.url), { type: "module", name: workerName() });
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
      <MissInfo problem={problem} dir={dir} classes={classes} agentLabel={agentLabel} linesSource={linesSource} />
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
                <button type="button" key={r.key} class={sel === r.key ? "active" : ""} onClick={() => pick(r)}>
                  {r.survey?.actions ? `${r.label}の後` : r.label}
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
                <div class={cur > 0 && notes[cur - 1]?.example ? "example" : ""}>{cur === 0 ? "問の局面" : `直前: ${lineTexts[cur - 1]}`}</div>
                {cur < last && <div class={notes[cur]?.example ? "muted example" : "muted"}>次: {lineTexts[cur]}</div>}
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
                {candidates.length > 0
                  ? "上のボタンで、下の手順の候補を打った後の局面か、今の AI に打たせた並びを盤面に出します。手順の手を押すと、その手を打った後の局面を出します。"
                  : lines.length > 0
                    ? "上のボタンで、打ち比べ調査で比べた 2 つの並びか、今の AI に打たせた並びを盤面で 1 手ずつ進めて見られます。"
                    : "上のボタンで、今の AI に打たせた並びを盤面で 1 手ずつ進めて見られます。"}
              </div>
            )}
            {error && <div class="problems">{error}</div>}
          </div>
          {candidates.length > 0 && (
            <Candidates
              candidates={candidates}
              runs={runs}
              sel={sel}
              cur={cur}
              onPick={(key, at) => select(key, at)}
            />
          )}
          <DeckPanel state={state} p={p} names={names} decks={decks} onCard={setDetail} />
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
              {logItems.map(({ g, label, note }) => (
                <li
                  key={g.start}
                  class={`${cur >= g.start + 1 && cur <= g.end + 1 ? "current" : cur <= g.start ? "muted" : ""}${note.example ? " example" : ""}`}
                  onClick={() => go(g.end + 1)}
                >
                  {label}
                  {g.start >= run.base && run.survey && <span class="branch-tag">続き</span>}
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </div>
  );
}

/** 問の説明（題・合格の条件・局面と正解の理由・出どころ）。題のほかは折りたたむ（ユーザーの依頼 2026-11-19） */
function MissInfo({
  problem,
  dir,
  classes,
  agentLabel,
  linesSource,
}: {
  problem: MissProblem;
  dir: string;
  classes: [ClassId, ClassId];
  agentLabel: string;
  linesSource: string | null;
}) {
  const p = problem.player;
  const s = problem.state;
  return (
    <details class="panel misses-info">
      <summary>
        <strong>{problem.title}</strong>
        <span class="muted">（押すと合格の条件・説明・出どころ）</span>
      </summary>
      <div class="muted">
        <span class={`class-tag class-${classes[p]}`}>{CLASS_NAMES[classes[p]]}</span> 対{" "}
        <span class={`class-tag class-${classes[opponent(p)]}`}>{CLASS_NAMES[classes[opponent(p)]]}</span> / 自分の {ownTurn(s)} ターン目（
        {s.first === p ? "先攻" : "後攻"}）/ 解かせる AI: {agentLabel} / 足した日: {problem.added} /{" "}
        <a href={`${REPO_URL}/blob/main/${dir}/${problem.id}.json`} target="_blank" rel="noreferrer">
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
      {linesSource && <p class="muted">手順の候補の出どころ: 共有フォルダの {linesSource}（打ち比べは打ち直していません）</p>}
    </details>
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

/** 二段目の勝ちの説明 */
/** 両方の席のデッキと、盤面の局面の山札に残るカード（折りたたむ。ユーザーの依頼 2026-11-19） */
function DeckPanel({
  state,
  p,
  names,
  decks,
  onCard,
}: {
  state: GameState;
  p: PlayerIndex;
  names: [string, string];
  decks: readonly [MissDeck, MissDeck] | null;
  onCard: (cardId: string) => void;
}) {
  const column = (q: PlayerIndex) => {
    const deck = decks?.[q] ?? null;
    const rows = deckRows(state, q, deck);
    const added = rows.some((r) => r.total !== null && r.left > r.total);
    return (
      <section class="misses-deck" key={q}>
        <strong>
          {names[q]}（{state.first === q ? "先攻" : "後攻"}）{deck ? `: ${deck.name}` : ""}
        </strong>
        <table class="misses-deck-table">
          <tbody>
            {rows.map((r) => {
              const card = cardOf(r.cardId);
              return (
                <tr key={r.cardId} class={r.left === 0 ? "muted" : ""} onClick={() => onCard(r.cardId)}>
                  <td>
                    <span class="cost">{card.cost}</span>
                  </td>
                  <td>{card.name}</td>
                  <td class="num">{r.total === null ? r.left : r.total === 0 ? `${r.left}（デッキに無い）` : `${r.left} / ${r.total}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {added && <div class="muted">残りがデッキの枚数より多いカードは、能力で山札に足された分を含みます</div>}
      </section>
    );
  };
  return (
    <details class="panel misses-decks">
      <summary>
        <strong>デッキと残りの山札</strong>
      </summary>
      <div class="misses-decks-grid">
        {column(p)}
        {column(opponent(p))}
      </div>
    </details>
  );
}

function tallyText(line: MissLine): string | null {
  const t = line.second;
  if (!t || t.games === 0) return null;
  return `打ち比べ ${t.wins}/${t.games} 勝（${Math.round((t.wins / t.games) * 100)}%）`;
}

/** 盤面の下の「手順の候補」: 並びごとに手を並べ、押すとその手を打った後の局面を盤面に出す */
function Candidates({
  candidates,
  runs,
  sel,
  cur,
  onPick,
}: {
  candidates: readonly Candidate[];
  runs: readonly Run[];
  sel: number | null;
  cur: number;
  onPick: (key: number, at: number) => void;
}) {
  const anyExample = candidates.some((c) => c.notes.some((n) => n.example));
  return (
    <div class="panel misses-lines">
      <div>
        <strong>手順の候補</strong>
        <span class="muted">（手を押すと、その手の後の局面を盤面に出します）</span>
      </div>
      <div class="misses-lines-grid">
        {candidates.map((c) => {
          const run = runs.find((r) => r.survey === c.line);
          if (!run) return null;
          const shown = sel === run.key;
          const stats = tallyText(c.line);
          return (
            <section key={run.key} class={`misses-line ${shown ? "shown" : ""}`}>
              <div class="misses-line-head">
                <button type="button" class={shown && cur === c.actions.length ? "active" : ""} onClick={() => onPick(run.key, c.actions.length)}>
                  {c.line.label}
                </button>
                <strong class={c.judged.passed ? "misses-pass-ok" : "misses-pass-ng"} title="この手順を問の合格の条件で判定した結果">
                  {c.judged.passed ? "○ 合格" : "× 不合格"}
                </strong>
                {c.readPasses && <span class="muted">（AI が打った続きで不合格。調査で読んだ並びまでなら合格）</span>}
                {c.line.hand && <span class="muted" title={c.line.hand}>（{c.line.hand.split("。")[0]}）</span>}
                {stats && (
                  <span
                    class="muted"
                    title={`調査の二段目で、この候補を選んでから最後まで打った勝ち（相手の手札・山札と乱数を変えて ${c.line.second?.games ?? 0} 回。続きは両方の席とも AI）。一段目は ${c.line.first?.games ?? 0} 回で ${c.line.first?.wins ?? 0} 勝`}
                  >
                    {stats}
                  </span>
                )}
              </div>
              <ol class="misses-line-steps">
                <li class={shown && cur === 0 ? "current" : ""} onClick={() => onPick(run.key, 0)}>
                  <span class="muted">問の局面</span>
                </li>
                {c.groups.map((g, i) => {
                  const note = c.notes[i];
                  const rethink = c.line.rethink;
                  const rethinkStart = rethink !== null && g.start <= rethink && rethink <= g.end;
                  return (
                    <li
                      key={g.start}
                      class={`${shown && cur >= g.start + 1 && cur <= g.end + 1 ? "current" : ""}${note?.example ? " example" : ""}`}
                      onClick={() => onPick(run.key, g.end + 1)}
                    >
                      {rethinkStart && (
                        <div class="misses-rethink">
                          {rethink < c.line.full.length
                            ? `ここから AI が考え直した手（読んだ並びの「${c.line.full[rethink]}」が問の局面では打てない）`
                            : "ここから AI が打った続き（調査で読んだ並びはここまで）"}
                        </div>
                      )}
                      <span class="step-no">{i + 1}.</span> {c.labels[i]}
                      {note && <span class="muted">{noteText(note, c.states[g.end + 1])}</span>}
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </div>
      {anyExample && (
        <div class="muted misses-legend">
          <span class="example">色を変えた手</span>は一例です（引いたカードを使う手・ランダムな結果の後の手・AI が考え直した手や続けた手。山札の順番や乱数が違えば変わります）
        </div>
      )}
    </div>
  );
}
