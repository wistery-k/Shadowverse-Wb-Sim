// 試合の記録: プロの試合（配信の動画）を見ながら、両方の席の手をクリックで入れる画面（開発サーバーだけ。vite build では空のものに置き換わる）。
// 中身は src/record/（記録の形・引いたカードとランダムな結果の決め方）、記録の形の説明は docs/match-record.md。
//
// 線引き（CLAUDE.md「決定済みの前提」。変えるならユーザーに確かめる）:
// - デッキは取り込んだプロのデッキ（data/pools/azvaldt/decks/）からだけ選ぶ。貼り付け・自作のデッキ・デッキの編集は付けない
// - 入れている間は AI の手も評価も出さない（この画面は AI を呼ばない）
// - 前期のローテーションのプールだけ。公開サイトには出さない

import "./MatchRecord.css";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CLASS_IDS, CLASS_NAMES, type ClassId } from "../cards";
import {
  actingPlayer,
  cardOf,
  fusionCandidates,
  INITIAL_HAND,
  leaderId,
  legalActions,
  opponent,
  tryApplyAction,
  type Action,
  type EvolveState,
  type GameState,
  type PlayerIndex,
} from "../engine";
import { PRO_EVENTS, PRO_DECKS, findProDeck } from "../record/decks";
import {
  evaluate,
  exportRecord,
  newRecord,
  outcomeLabel,
  outcomeParts,
  parseRecord,
  RANDOM_SAMPLES,
  recordFileName,
  replay,
  resultOf,
  sampleOutcomes,
  setInitialHand,
  type Draws,
  type Evaluation,
  type MatchRecord as Rec,
  type Outcome,
  type PendingStep,
  type RecordSeat,
  type RecordStep,
} from "../record/record";
import * as sb from "../sim/sandbox";
import { CardDetail, CardView } from "./CardView";
import { attackStatuses, describeAction, leaderClasses, modeLabels, modeSourceCard } from "./describe";
import { BoardSlots, EmptySlots, LeaderHp, PlayerInfo, Resources } from "./Game";

const STORE_KEY = "svwb-sim:match-record:v1";
/** 「もっと探す」で足す回数 */
const MORE_SAMPLES = 500;

interface Live {
  record: Rec;
  /** states[i] は i 個の手順の後の局面（states[0] は最初の局面） */
  states: GameState[];
  /** 今の位置（入れた手順の数。これより後ろは「やり直す」で戻れる手順） */
  index: number;
}

interface Stored {
  record: Rec;
  index: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function save(live: Live | null): string | null {
  try {
    if (!live) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify({ record: live.record, index: live.index } satisfies Stored));
    return null;
  } catch {
    return "途中の経過をブラウザに保存できませんでした（プライベートブラウズ等）。書き出しておいてください";
  }
}

/** ブラウザに残した途中の記録を開く（たどれない手順があれば、そこまで） */
function load(): { live: Live | null; warning: string } {
  let text: string | null = null;
  try {
    text = localStorage.getItem(STORE_KEY);
  } catch {
    return { live: null, warning: "" };
  }
  if (!text) return { live: null, warning: "" };
  try {
    const stored = JSON.parse(text) as Stored;
    const record = parseRecord(JSON.stringify(stored.record));
    return open(record, typeof stored.index === "number" ? stored.index : record.steps.length);
  } catch (e) {
    return { live: null, warning: `ブラウザに残した記録を開けませんでした: ${message(e)}` };
  }
}

function open(record: Rec, index: number): { live: Live | null; warning: string } {
  const { states, error } = replay(record);
  if (states.length === 0) return { live: null, warning: `記録を開けませんでした: ${error?.message ?? ""}` };
  const warning = error ? `手順 ${error.step + 1} から先を、今のエンジンでたどれませんでした（${error.message}）。そこまでを開きました` : "";
  const steps = record.steps.slice(0, states.length - 1);
  return { live: { record: { ...record, steps }, states, index: Math.max(0, Math.min(index, steps.length)) }, warning };
}

/** 席の名前（チームとクラス） */
const seatName = (s: RecordSeat) => `${s.team}（${CLASS_NAMES[s.cls]}）`;

export function MatchRecord() {
  const [{ live: initial, warning: initialWarning }] = useState(load);
  const [live, setLiveState] = useState<Live | null>(initial);
  const liveRef = useRef(live);
  liveRef.current = live;
  const [warning, setWarning] = useState(initialWarning);
  const [error, setError] = useState("");
  const [showSetup, setShowSetup] = useState(!initial);

  const setLive = (next: Live | null) => {
    liveRef.current = next;
    setLiveState(next);
    const w = save(next);
    if (w) setWarning(w);
  };

  return (
    <div class="match-record">
      <div class="banner">
        <strong>試合の記録</strong>
        <span class="muted">
          プロの試合（配信の動画）を見ながら、両方の席の手を入れます。前期のローテーションのプロのデッキだけを選べます。入れている間、AI は手も評価も出しません。
        </span>
      </div>
      {warning && <p class="problems">{warning}</p>}
      {error && <p class="problems">{error}</p>}
      {(showSetup || !live) && (
        <SetupPanel
          hasCurrent={!!live}
          onCancel={live ? () => setShowSetup(false) : undefined}
          onStart={(record) => {
            const { live: l, warning: w } = open(record, 0);
            setLive(l);
            setWarning(w);
            setError("");
            setShowSetup(false);
          }}
          onError={setError}
        />
      )}
      {live && !showSetup && (
        <RecordView
          live={live}
          setLive={(l) => {
            setLive(l);
            setError("");
          }}
          setError={setError}
          onNew={() => setShowSetup(true)}
        />
      )}
    </div>
  );
}

// ---- 試合を選ぶ ----

function SetupPanel({ hasCurrent, onStart, onCancel, onError }: { hasCurrent: boolean; onStart: (r: Rec) => void; onCancel: (() => void) | undefined; onError: (e: string) => void }) {
  const [event, setEvent] = useState(PRO_EVENTS[0]?.id ?? "");
  const ev = PRO_EVENTS.find((e) => e.id === event);
  const teams = ev?.teams ?? [];
  const [seats, setSeats] = useState<[{ team: string; cls: ClassId }, { team: string; cls: ClassId }]>([
    { team: teams[0] ?? "", cls: "witch" },
    { team: teams[1] ?? teams[0] ?? "", cls: "witch" },
  ]);
  const [memo, setMemo] = useState("");
  const decks = seats.map((s) => findProDeck(event, s.team, s.cls));
  const fileRef = useRef<HTMLInputElement>(null);

  const changeEvent = (id: string) => {
    setEvent(id);
    const t = PRO_EVENTS.find((e) => e.id === id)?.teams ?? [];
    setSeats([
      { ...seats[0], team: t.includes(seats[0].team) ? seats[0].team : (t[0] ?? "") },
      { ...seats[1], team: t.includes(seats[1].team) ? seats[1].team : (t[1] ?? t[0] ?? "") },
    ]);
  };
  const setSeat = (p: PlayerIndex, s: Partial<{ team: string; cls: ClassId }>) =>
    setSeats(p === 0 ? [{ ...seats[0], ...s }, seats[1]] : [seats[0], { ...seats[1], ...s }]);

  const start = () => {
    const [a, b] = decks;
    if (!a || !b || !ev) {
      onError("選んだデッキがプロのデッキにありません");
      return;
    }
    try {
      onStart(
        newRecord({
          event: ev.id,
          eventName: ev.name,
          seats: [
            { deck: a.id, team: a.team, cls: a.cls },
            { deck: b.id, team: b.team, cls: b.cls },
          ],
          memo: memo.trim(),
          commit: __BUILD_COMMIT__,
          dirty: __BUILD_DIRTY__,
          seed: Math.floor(Math.random() * 2 ** 32),
          now: new Date().toISOString(),
        }),
      );
    } catch (e) {
      onError(message(e));
    }
  };

  const openFile = (file: File) => {
    void file.text().then(
      (text) => {
        try {
          onStart(parseRecord(text));
        } catch (e) {
          onError(message(e));
        }
      },
      (e: unknown) => onError(message(e)),
    );
  };

  const classes = CLASS_IDS.filter((c) => c !== "neutral");
  return (
    <div class="setup panel record-setup">
      <label>
        大会
        <select value={event} onChange={(e) => changeEvent(e.currentTarget.value)}>
          {PRO_EVENTS.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}（{e.date}）
            </option>
          ))}
        </select>
      </label>
      {([0, 1] as const).map((p) => (
        <div key={p} class="record-seat">
          <strong>{p === 0 ? "先攻" : "後攻"}</strong>
          <label>
            チーム
            <select value={seats[p].team} onChange={(e) => setSeat(p, { team: e.currentTarget.value })}>
              {teams.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            クラス
            <select value={seats[p].cls} onChange={(e) => setSeat(p, { cls: e.currentTarget.value as ClassId })}>
              {classes.map((c) => (
                <option key={c} value={c}>
                  {CLASS_NAMES[c]}
                </option>
              ))}
            </select>
          </label>
          <span class={decks[p] ? "" : "problems-inline"}>{decks[p] ? `デッキ: ${decks[p].name}` : "このチームのこのクラスのデッキはありません"}</span>
        </div>
      ))}
      <label>
        メモ（任意。動画のどのあたりか等）
        <input type="text" value={memo} onInput={(e) => setMemo(e.currentTarget.value)} />
      </label>
      <p class="muted">選手の名前は記録しません（大会・チーム・クラスだけ）。デッキはプロのデッキ {PRO_DECKS.length} 個から選びます。</p>
      <div class="row-buttons">
        <button type="button" class="primary" disabled={!decks[0] || !decks[1]} onClick={start}>
          {hasCurrent ? "今の記録をやめて始める" : "始める"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            今の記録に戻る
          </button>
        )}
        <button type="button" onClick={() => fileRef.current?.click()}>
          書き出した記録を開く
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) openFile(f);
            e.currentTarget.value = "";
          }}
        />
      </div>
      {hasCurrent && <p class="muted">今の記録は、書き出していなければ消えます（ブラウザに残すのは 1 試合だけ）。</p>}
    </div>
  );
}

// ---- 入れている記録 ----

interface Resolving {
  step: PendingStep;
  ev: Evaluation;
}

type Mode = "play" | "edit";

function RecordView({ live, setLive, setError, onNew }: { live: Live; setLive: (l: Live) => void; setError: (e: string) => void; onNew: () => void }) {
  const { record, states, index } = live;
  const state = states[index]!;
  const steps = record.steps.slice(0, index);
  const names = useMemo(() => record.meta.seats.map(seatName) as [string, string], [record.meta.seats]);
  const classes = useMemo(() => leaderClasses(states[0]!), [states[0]]);
  const result = useMemo(() => resultOf(steps, state), [steps.length, state]);
  const handsSet = ([0, 1] as const).map((p) => steps.some((s) => s.kind === "hand" && s.player === p));
  const needHand = state.phase === "mulligan" ? ([0, 1] as const).find((p) => !handsSet[p] && !state.players[p].mulliganDone) : undefined;
  const [resolving, setResolving] = useState<Resolving | null>(null);
  const [busy, setBusy] = useState("");
  const [mode, setMode] = useState<Mode>("play");
  const [bottom, setBottom] = useState<PlayerIndex>(0);
  const [detail, setDetail] = useState<string | null>(null);
  const [picks, setPicks] = useState<Picks>(NO_PICKS);
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const legal = useMemo(() => {
    try {
      return legalActions(state);
    } catch {
      return [];
    }
  }, [state]);
  const info = inputInfo(state, legal, picks);
  // 引いたカードを選んでいる間は、仮に打った局面（ターン終了時の効果などの後）を見せる。まだ決めていない引いたカードは伏せる
  const preview = resolving?.ev.kind === "draw" ? resolving.ev : null;
  const shown = preview?.preview ?? state;
  const shownInfo = preview ? inputInfo(preview.preview, [], NO_PICKS) : info;
  const undecided = useMemo(() => {
    if (!preview) return null;
    const iids = new Set(preview.undecided);
    const asking = preview.preview.players[preview.player].hand.find((h) => iids.has(h.iid))?.iid ?? null;
    return { iids, asking };
  }, [preview]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // 位置が変わったら、決めている途中の手はやめる
  useEffect(() => {
    setResolving(null);
    setBusy("");
    setPicks(NO_PICKS);
  }, [index, record]);

  function push(step: RecordStep, next: GameState) {
    const cur = live;
    const kept = cur.record.steps.slice(0, cur.index);
    const record2: Rec = { ...cur.record, steps: [...kept, step], meta: { ...cur.record.meta, updatedAt: new Date().toISOString() } };
    setLive({ record: record2, states: [...cur.states.slice(0, cur.index + 1), next], index: cur.index + 1 });
  }

  const go = (i: number) => setLive({ ...live, index: Math.max(0, Math.min(live.record.steps.length, i)) });

  /** 決めている手を進める（重い計算の前に「探しています」を出す） */
  function run(step: PendingStep, label: string) {
    setBusy(label);
    setTimeout(() => {
      const r = evaluate(state, step, names);
      setBusy("");
      if (r.ev.kind === "done") {
        const s = r.step;
        const draws: Draws | undefined = s.draws[0].length + s.draws[1].length > 0 ? s.draws : undefined;
        push({ kind: "action", action: s.action, ...(draws ? { draws } : {}), ...(s.rng !== undefined ? { rng: s.rng } : {}), ...(s.outcome ? { outcome: s.outcome } : {}) }, r.ev.next);
        setResolving(null);
      } else {
        setResolving(r);
      }
    }, 20);
  }

  const act = (action: Action) => run({ action, draws: [[], []] }, "手を打っています…");

  function applyEdit(label: string, f: (s: GameState) => GameState): boolean {
    try {
      const next = f(state);
      if (next === state) return true;
      push({ kind: "edit", label, state: next }, next);
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    }
  }

  function exportFile() {
    try {
      const out = exportRecord({ ...record, steps }, new Date().toISOString());
      const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = recordFileName(out);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(message(e));
    }
  }

  const minutes = Math.max(0, Math.round((now - Date.parse(record.meta.createdAt)) / 60_000));
  const marks = steps.filter((s) => s.kind === "mark").length;
  const locked = !!resolving || !!busy || !!result;

  return (
    <div class="record-view">
      <div class="banner">
        <button type="button" title="1 手戻す" disabled={!!busy || index <= 0} onClick={() => go(index - 1)}>
          ← 戻す
        </button>
        <button type="button" title="戻した手をやり直す" disabled={!!busy || index >= record.steps.length} onClick={() => go(index + 1)}>
          やり直す →
        </button>
        <button type="button" onClick={onNew} disabled={!!busy}>
          新しい試合
        </button>
        <button type="button" class={result ? "primary" : ""} onClick={exportFile} disabled={!!busy}>
          {result ? "記録を保存（ファイルに書き出す）" : "途中の記録を書き出す"}
        </button>
        <button type="button" title="表示だけ上下を入れ替えます" onClick={() => setBottom(opponent(bottom))}>
          上下を入れ替え
        </button>
        <span class="muted">
          {record.meta.eventName} / 先攻 {names[0]}・後攻 {names[1]}
          {record.meta.memo ? ` / ${record.meta.memo}` : ""} / 入れ始めてから {minutes} 分 / 手順 {index}
          {marks > 0 ? ` / 印 ${marks}` : ""}
        </span>
      </div>
      <div class="game record-game">
        {([opponent(bottom), bottom] as const).map((p, k) => (
          <SeatPanel
            key={p}
            state={shown}
            p={p}
            top={k === 0}
            names={names}
            cls={classes[p]}
            onDetail={setDetail}
            input={mode === "play" && !locked && needHand === undefined ? { act } : null}
            editing={mode === "edit" && !locked ? { apply: applyEdit } : null}
            info={shownInfo}
            setPicks={setPicks}
            editTarget={editTarget}
            setEditTarget={setEditTarget}
            undecided={undecided}
          />
        ))}
        <section class="controls record-controls">
          {busy ? (
            <div class="banner">{busy}</div>
          ) : resolving ? (
            <ResolvePanel
              state={state}
              resolving={resolving}
              names={names}
              onRun={run}
              onUpdate={setResolving}
              onCancel={() => setResolving(null)}
              setBusy={setBusy}
            />
          ) : result ? (
            <div class="banner">
              <strong>
                {names[result.winner]}の勝ち（{result.reason === "retire" ? `${names[opponent(result.winner)]}がリタイア` : result.reason === "deck" ? "山札切れ" : "リーダーの体力が 0"}）
              </strong>
              <span class="muted">「記録を保存」でファイルに書き出せます。「戻す」で前の局面に戻れます。</span>
            </div>
          ) : needHand !== undefined ? (
            <HandPicker
              key={needHand}
              state={state}
              p={needHand}
              name={names[needHand]}
              onDone={(cards) => {
                try {
                  push({ kind: "hand", player: needHand, cards }, setInitialHand(state, needHand, cards));
                } catch (e) {
                  setError(message(e));
                }
              }}
            />
          ) : mode === "edit" ? (
            <div class="banner muted">手で直すモード: 直したいカード・リーダーをクリックしてください。直した局面は手順に残ります。</div>
          ) : null}
          {!resolving && !busy && !result && needHand === undefined && (
            <ToolPanel
              state={state}
              names={names}
              mode={mode}
              setMode={(m) => {
                setMode(m);
                setEditTarget(null);
                setPicks(NO_PICKS);
              }}
              onMark={(note) => push({ kind: "mark", note }, state)}
              onRetire={(loser) => push({ kind: "retire", loser }, state)}
              act={act}
              info={info}
              setPicks={setPicks}
            />
          )}
        </section>
        <aside class="info">
          {detail ? <CardDetail card={cardOf(detail)} /> : <div class="muted">カードをクリックすると詳細を表示します</div>}
          <StepLog record={record} states={states} index={index} names={names} onJump={(i) => !busy && go(i)} />
        </aside>
      </div>
    </div>
  );
}

// ---- 席（盤面・手札・リーダー）と、手の入力 ----

interface SeatProps {
  state: GameState;
  p: PlayerIndex;
  top: boolean;
  names: [string, string];
  cls: ClassId;
  onDetail: (cardId: string) => void;
  /** 手を入れられるとき */
  input: { act: (a: Action) => void } | null;
  /** 手で直すとき */
  editing: { apply: (label: string, f: (s: GameState) => GameState) => boolean } | null;
  info: InputInfo;
  setPicks: (p: Picks) => void;
  editTarget: EditTarget;
  setEditTarget: (t: EditTarget) => void;
  /**
   * 引いたカードを選んでいる間、仮に打った局面の手札で、まだ決めていない引いたカード（中身を伏せる）。
   * asking はいま選んでいるカード（その席の、まだ決めていない最初の 1 枚）
   */
  undecided: { iids: ReadonlySet<number>; asking: number | null } | null;
}

/** 選んでいるもの（手の入力: 主体のカードと、対象・素材・マリガンで返すカード） */
interface Picks {
  selected: number | null;
  picks: number[];
  fusing: boolean;
}
const NO_PICKS: Picks = { selected: null, picks: [], fusing: false };

/** 手で直すときに選んでいるもの */
type EditTarget = { kind: "card"; iid: number } | { kind: "leader"; player: PlayerIndex } | null;

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

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x) => b.includes(x));

/** 局面での手の入力の手がかり（両方の席とボタンで同じものを使う） */
function inputInfo(state: GameState, legal: readonly Action[], picks: Picks) {
  const actor = actingPlayer(state);
  const pending = state.phase === "ended" ? null : state.pending;
  const mulligan = state.phase === "mulligan";
  const selectedActions = picks.selected === null ? [] : legal.filter((a) => actionSubject(a) === picks.selected);
  const attackTargets = new Set(selectedActions.flatMap((a) => (a.type === "attack" ? [a.target === "leader" ? leaderId(opponent(actor)) : a.target] : [])));
  const free = state.phase === "main" && !pending;
  const fusible = new Set(free ? state.players[actor].hand.filter((h) => fusionCandidates(state, h.iid).length > 0).map((h) => h.iid) : []);
  const fuseHost = picks.fusing && picks.selected !== null && fusible.has(picks.selected) ? picks.selected : null;
  const fuseCandidates = fuseHost === null ? [] : fusionCandidates(state, fuseHost);
  const candidates = new Set([...(pending?.kind === "choose" ? pending.candidates : []), ...fuseCandidates]);
  const actable = new Set(free ? legal.flatMap((a) => (a.type === "act" ? [a.iid] : [])) : []);
  const ready = new Set([...(free ? legal.map(actionSubject).filter((x): x is number => x !== null) : []), ...fusible]);
  return { legal, picks, actor, pending, mulligan, selectedActions, attackTargets, fusible, fuseHost, fuseCandidates, candidates, actable, ready };
}
type InputInfo = ReturnType<typeof inputInfo>;

function SeatPanel({ state, p, top, names, cls, onDetail, input, editing, info, setPicks, editTarget, setEditTarget, undecided }: SeatProps) {
  const pl = state.players[p];
  const attackable = info.actor === p && state.active === p ? attackStatuses(state) : new Map();
  const leader = leaderId(p);

  function click(iid: number, cardId: string | null) {
    if (cardId) onDetail(cardId);
    if (editing) {
      setEditTarget(iid < 0 ? { kind: "leader", player: p } : { kind: "card", iid });
      return;
    }
    if (!input) return;
    const { picks } = info;
    const toggle = () => setPicks({ ...picks, picks: picks.picks.includes(iid) ? picks.picks.filter((x) => x !== iid) : [...picks.picks, iid] });
    if (info.mulligan) {
      if (p === info.actor && iid >= 0 && pl.hand.some((h) => h.iid === iid)) toggle();
      return;
    }
    if (info.pending?.kind === "choose") {
      if (info.candidates.has(iid)) toggle();
      return;
    }
    if (info.pending) return;
    if (info.fuseHost !== null) {
      if (info.fuseCandidates.includes(iid)) toggle();
      else if (iid === info.fuseHost) setPicks({ ...picks, fusing: false, picks: [] });
      return;
    }
    if (picks.selected !== null && info.attackTargets.has(iid)) {
      const target = iid === leaderId(opponent(info.actor)) ? "leader" : iid;
      const a = info.selectedActions.find((x) => x.type === "attack" && x.target === target);
      if (a) input.act(a);
      return;
    }
    setPicks({ selected: picks.selected === iid ? null : iid, picks: [], fusing: false });
  }

  const isPicked = (iid: number) => info.picks.selected === iid || info.picks.picks.includes(iid);
  const isEditing = (iid: number) => editing !== null && editTarget?.kind === "card" && editTarget.iid === iid;
  const mulliganMark = (iid: number) => (info.mulligan && p === info.actor && input ? (info.picks.picks.includes(iid) ? "return" : "keep") : null);

  const board = (
    <div class="board">
      {pl.board.map((c) => (
        <CardView
          key={c.iid}
          cardId={c.cardId}
          board={c}
          selected={isPicked(c.iid) || isEditing(c.iid)}
          targetable={info.attackTargets.has(c.iid) || info.candidates.has(c.iid)}
          ready={!!input && p === info.actor && info.ready.has(c.iid)}
          attackable={attackable.get(c.iid) ?? null}
          actable={!!input && p === info.actor && info.actable.has(c.iid)}
          onClick={() => click(c.iid, c.cardId)}
        />
      ))}
      <BoardSlots count={pl.board.length} />
    </div>
  );
  const leaderRow = (
    <div class="leader-row">
      <div
        class={`leader class-${cls} ${info.attackTargets.has(leader) || info.candidates.has(leader) ? "targetable" : ""} ${info.picks.picks.includes(leader) || (editing && editTarget?.kind === "leader" && editTarget.player === p) ? "selected" : ""}`}
        onClick={() => click(leader, null)}
      >
        {names[p]} <LeaderHp hp={pl.leaderHp} max={pl.leaderMaxHp} />
      </div>
      <Resources state={state} p={p} extraPpUsable={!!input && p === info.actor && info.legal.some((a) => a.type === "extraPp")} />
    </div>
  );
  const head = <PlayerInfo label={`${names[p]}${state.first === p ? "（先攻）" : "（後攻）"}${info.actor === p && state.phase !== "ended" ? " ← 手番" : ""}`} state={state} p={p} cls={cls} />;
  const hand = (
    <div class="hand">
      {pl.hand.map((h) =>
        undecided?.iids.has(h.iid) ? (
          <span key={h.iid} class={`slot-empty record-undecided ${undecided.asking === h.iid ? "asking" : ""}`}>
            {undecided.asking === h.iid ? "引いたカード（いま選ぶ）" : "引いたカード（このあと選ぶ）"}
          </span>
        ) : (
        <CardView
          key={h.iid}
          cardId={h.cardId}
          hand={h}
          pp={state.active === p && state.phase === "main" ? pl.pp : undefined}
          note={h.revealed ? "公開" : null}
          mulligan={mulliganMark(h.iid)}
          selected={(!info.mulligan && isPicked(h.iid)) || isEditing(h.iid)}
          targetable={info.candidates.has(h.iid)}
          ready={!!input && p === info.actor && info.ready.has(h.iid)}
          onClick={() => click(h.iid, h.cardId)}
        />
        ),
      )}
      <EmptySlots count={pl.hand.length} />
    </div>
  );
  return (
    <section class={`side ${top ? "opponent" : "me"} ${info.actor === p && state.phase !== "ended" ? "acting" : ""}`}>
      {top ? (
        <>
          {head}
          {hand}
          {leaderRow}
          {board}
        </>
      ) : (
        <>
          {board}
          {leaderRow}
          {head}
          {hand}
        </>
      )}
      {editing && editTarget && <EditPanel state={state} p={p} target={editTarget} apply={editing.apply} clear={() => setEditTarget(null)} />}
    </section>
  );
}

/** 手の入力のボタン（手番の席の、選んでいるカードでできること・ターン終了等） */
function ActionButtons({ state, names, act, info, setPicks }: { state: GameState; names: [string, string]; act: (a: Action) => void; info: InputInfo; setPicks: (p: Picks) => void }) {
  const { picks, pending, actor } = info;
  const modeCard = pending?.kind === "mode" ? modeSourceCard(state) : null;
  const fuseAction: Action | null = info.fuseHost === null ? null : { type: "fuse", host: info.fuseHost, materials: picks.picks };
  const fuseOk = useMemo(() => {
    if (!fuseAction || picks.picks.length === 0) return null;
    try {
      const next = tryApplyAction(state, fuseAction);
      const after = next?.players[actor].hand.find((h) => h.iid === fuseAction.host);
      return next ? { cardId: after?.cardId ?? null } : null;
    } catch {
      return null;
    }
  }, [state, info.fuseHost, picks.picks.join(",")]);
  const who = names[actor];
  if (state.phase === "ended") return null;
  if (info.mulligan) {
    const a = info.legal.find((x) => x.type === "mulligan" && x.player === actor && sameSet(x.swap, picks.picks));
    return (
      <div class="banner">
        {who}のマリガン: 返すカードをクリックしてください（{picks.picks.length} 枚）
        <button type="button" class="primary" disabled={!a} onClick={() => a && act(a)}>
          決定
        </button>
      </div>
    );
  }
  if (pending?.kind === "choose") {
    const a = info.legal.find((x) => x.type === "choose" && sameSet(x.targets, picks.picks));
    return (
      <div class="banner">
        {names[pending.player]}: 対象を {pending.count} 枚選んでください（{picks.picks.length}/{pending.count}）
        <button type="button" class="primary" disabled={!a} onClick={() => a && act(a)}>
          決定
        </button>
      </div>
    );
  }
  if (pending?.kind === "mode") {
    return (
      <div class="banner column">
        {names[pending.player]}: {modeCard ? `${cardOf(modeCard).name}の能力を 1 つ選んでください` : "能力を 1 つ選んでください"}
        {modeLabels(state).map((label, index) => (
          <button type="button" key={index} onClick={() => act({ type: "mode", index })}>
            {label}
          </button>
        ))}
      </div>
    );
  }
  if (info.fuseHost !== null) {
    return (
      <div class="banner">
        融合する素材を選んでください（{picks.picks.length} 枚）
        {fuseOk && (fuseOk.cardId && fuseOk.cardId !== state.players[actor].hand.find((h) => h.iid === info.fuseHost)?.cardId ? <span>→ {cardOf(fuseOk.cardId).name}に変身</span> : <span class="muted">→ 変身しません</span>)}
        <button type="button" class="primary" disabled={!fuseOk || !fuseAction} onClick={() => fuseAction && act(fuseAction)}>
          確定
        </button>
        <button type="button" onClick={() => setPicks({ ...picks, fusing: false, picks: [] })}>
          キャンセル
        </button>
      </div>
    );
  }
  const endTurn = info.legal.find((a) => a.type === "endTurn");
  const extraPp = info.legal.find((a) => a.type === "extraPp");
  const labels: Partial<Record<Action["type"], string>> = { play: "プレイ", evolve: "進化", superEvolve: "超進化", act: "アクト" };
  return (
    <div class="banner">
      <span>{who}の手番:</span>
      {info.selectedActions
        .filter((a) => a.type !== "attack" && a.type !== "fuse")
        .map((a) => (
          <button type="button" key={JSON.stringify(a)} onClick={() => act(a)}>
            {labels[a.type] ?? a.type}
          </button>
        ))}
      {picks.selected !== null && info.fusible.has(picks.selected) && (
        <button type="button" onClick={() => setPicks({ ...picks, fusing: true, picks: [] })}>
          融合
        </button>
      )}
      {info.selectedActions.some((a) => a.type === "attack") && <span class="muted">攻撃先をクリック</span>}
      {picks.selected === null && <span class="muted">カードをクリックすると、できることが出ます</span>}
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
  );
}

// ---- 初期手札 ----

/** カード ID → 枚数を、コストの低い順（同じなら ID の順）に並べる */
const TYPE_ORDER: Record<string, number> = { follower: 0, spell: 1, amulet: 2 };

/** カードの種類の短い説明（フォロワーは攻撃力/体力） */
function typeLabel(id: string): string {
  const c = cardOf(id);
  if (c.type === "follower") return `${c.attack}/${c.defense}`;
  return c.type === "spell" ? "スペル" : "アミュレット";
}

/** コストごとの行に分けたカードの一覧（行の中はフォロワー・スペル・アミュレットの順） */
function byCost(m: ReadonlyMap<string, number>): [number, [string, number][]][] {
  const rows = new Map<number, [string, number][]>();
  for (const [id, n] of m) {
    const cost = cardOf(id).cost;
    rows.set(cost, [...(rows.get(cost) ?? []), [id, n]]);
  }
  const order = (id: string) => TYPE_ORDER[cardOf(id).type] ?? 3;
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([cost, cards]) => [cost, cards.sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))]);
}

function CardButtons({ counts, onPick }: { counts: ReadonlyMap<string, number>; onPick: (cardId: string) => void }) {
  return (
    <div class="record-cards">
      {byCost(counts).map(([cost, cards]) => (
        <div class="record-cost-row" key={cost}>
          <span class="record-cost-label" title={`コスト ${cost}`}>
            {cost}
          </span>
          <div class="record-cost-cards">
            {cards.map(([id, n]) => {
              const c = cardOf(id);
              return (
                <button type="button" key={id} class={`record-card class-${c.class}`} title={c.text} onClick={() => onPick(id)}>
                  <span class="record-card-name">{c.name}</span>
                  <span class="muted record-card-type">{typeLabel(id)}</span>
                  <span class="record-card-count">×{n}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 選ぶところが出たら、画面に入るように動かす（盤面の下にあって、見落としやすいので） */
function useScrollIntoView<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [dep]);
  return ref;
}

function HandPicker({ state, p, name, onDone }: { state: GameState; p: PlayerIndex; name: string; onDone: (cards: string[]) => void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const ref = useScrollIntoView<HTMLDivElement>(p);
  const all = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of [...state.players[p].hand, ...state.players[p].deck]) m.set(c.cardId, (m.get(c.cardId) ?? 0) + 1);
    return m;
  }, [state, p]);
  const rest = new Map(all);
  for (const id of chosen) {
    const n = rest.get(id) ?? 0;
    if (n <= 1) rest.delete(id);
    else rest.set(id, n - 1);
  }
  return (
    <div class="banner column record-picker" ref={ref}>
      <div>
        <strong>{name}の初期手札</strong>を {INITIAL_HAND} 枚選んでください（{chosen.length}/{INITIAL_HAND}）
      </div>
      <div class="row-buttons">
        {chosen.map((id, i) => (
          <button type="button" key={`${id}-${i}`} class="record-chosen" title="クリックで外す" onClick={() => setChosen(chosen.filter((_, k) => k !== i))}>
            {cardOf(id).name} ×
          </button>
        ))}
        <button type="button" class="primary" disabled={chosen.length !== INITIAL_HAND} onClick={() => onDone(chosen)}>
          決定
        </button>
      </div>
      {chosen.length < INITIAL_HAND && <CardButtons counts={rest} onPick={(id) => setChosen([...chosen, id])} />}
    </div>
  );
}

// ---- 引いたカード・ランダムな結果を決める ----

function ResolvePanel({
  state,
  resolving,
  names,
  onRun,
  onUpdate,
  onCancel,
  setBusy,
}: {
  state: GameState;
  resolving: Resolving;
  names: [string, string];
  onRun: (step: PendingStep, label: string) => void;
  onUpdate: (r: Resolving) => void;
  onCancel: () => void;
  setBusy: (s: string) => void;
}) {
  const { step, ev } = resolving;
  const ref = useScrollIntoView<HTMLDivElement>(ev);
  const title = describeAction(state, step.action, names);
  const chosenText = ([0, 1] as const)
    .filter((p) => step.draws[p].length > 0)
    .map((p) => `${names[p]}: ${step.draws[p].map((id) => cardOf(id).name).join("、")}`)
    .join(" / ");
  const popDraw = (p: PlayerIndex) => {
    const draws: Draws = [[...step.draws[0]], [...step.draws[1]]];
    draws[p].pop();
    onRun({ ...step, draws }, "選び直しています…");
  };
  const lastPicked = ([1, 0] as const).find((p) => step.draws[p].length > 0);
  const cancel = (
    <button type="button" onClick={onCancel}>
      この手を取り消す
    </button>
  );
  const head = (
    <div>
      <strong>{title}</strong>
      {step.outcome && <span class="muted">（ランダムな結果: {step.outcome}）</span>}
      {chosenText && <div class="muted">決めた引いたカード: {chosenText}</div>}
    </div>
  );
  if (ev.kind === "draw") {
    const p = ev.player;
    return (
      <div class="banner column record-picker" ref={ref}>
        {head}
        <div>
          <strong>{names[p]}が引いたカード</strong>を選んでください（まだ決めていない引いたカード: {ev.known} 枚）
        </div>
        <div class="muted">盤面は、この手を打った後（ターン終了時の効果などの後）の見込みです。青い枠の「引いたカード（いま選ぶ）」が、いま選んでいるカードです。</div>
        <CardButtons
          counts={ev.pool}
          onPick={(id) => {
            const draws: Draws = [[...step.draws[0]], [...step.draws[1]]];
            draws[p].push(id);
            onRun({ ...step, draws }, "引いたカードで打ち直しています…");
          }}
        />
        <div class="row-buttons">
          {lastPicked !== undefined && (
            <button type="button" onClick={() => popDraw(lastPicked)}>
              最後に選んだカードを外す
            </button>
          )}
          {cancel}
        </div>
      </div>
    );
  }
  if (ev.kind === "random") {
    return (
      <div class="banner column record-picker" ref={ref}>
        {head}
        <div>
          この手には<strong>運で決まるところ</strong>（対象・出るカードなど）があります。<strong>動画で起きた結果</strong>を選んでください
        </div>
        <div class="muted">太字が結果ごとの違い、薄い字はどの結果でも同じところです（乱数を変えて {ev.samples} 回打った結果。多い順）</div>
        <ol class="record-outcomes">
          {ev.outcomes.map((o: Outcome, i) => {
            const { parts, hidden } = outcomeParts(o);
            return (
              <li key={i}>
                <button type="button" onClick={() => onRun({ ...step, rng: o.rng, outcomeKey: o.key, outcome: outcomeLabel(o) }, "選んだ結果で打っています…")}>
                  選ぶ
                </button>{" "}
                {o.changes.length === 0 && <span>（見える違いなし）</span>}
                {parts.map((c, k) => (
                  <span key={k} class={c.diff ? "record-outcome-diff" : "muted"}>
                    {k > 0 ? "、" : ""}
                    {c.text}
                  </span>
                ))}{" "}
                <span class="muted">
                  （{o.count} 回{hidden > 0 ? `。ほかに、どの結果でも同じ変化 ${hidden} 件` : ""}）
                </span>
              </li>
            );
          })}
        </ol>
        <div class="row-buttons">
          <button
            type="button"
            title="まれな結果が出ていないとき"
            onClick={() => {
              setBusy("ほかの結果を探しています…");
              setTimeout(() => {
                const outcomes = sampleOutcomes(state, step.action, step.draws, names, MORE_SAMPLES, ev.outcomes, ev.samples);
                setBusy("");
                onUpdate({ step, ev: { kind: "random", outcomes, samples: ev.samples + MORE_SAMPLES } });
              }, 20);
            }}
          >
            もっと探す（+{MORE_SAMPLES} 回）
          </button>
          {cancel}
        </div>
        <div class="muted">動画の結果が無いときは、近いものを選んで、あとで「手で直す」で直し、「動画と違う」の印を付けてください。</div>
      </div>
    );
  }
  if (ev.kind === "mismatch") {
    return (
      <div class="banner column record-picker" ref={ref}>
        {head}
        <div class="problems">
          {names[ev.player]}が{ev.cardId ? `「${cardOf(ev.cardId).name}」を` : ""}引く結果が見つかりません（その手では引けないカードか、山札を切り直す手で {RANDOM_SAMPLES} 回より多く探しても出ないカード）。
        </div>
        <div class="row-buttons">
          {lastPicked !== undefined && (
            <button type="button" onClick={() => popDraw(lastPicked)}>
              最後に選んだカードを外す
            </button>
          )}
          {cancel}
        </div>
      </div>
    );
  }
  if (ev.kind === "error") {
    return (
      <div class="banner column record-picker" ref={ref}>
        {head}
        <div class="problems">{ev.message}</div>
        <div class="row-buttons">{cancel}</div>
      </div>
    );
  }
  return null;
}

// ---- 印・リタイア・手で直す ----

function ToolPanel({
  state,
  names,
  mode,
  setMode,
  onMark,
  onRetire,
  act,
  info,
  setPicks,
}: {
  state: GameState;
  names: [string, string];
  mode: Mode;
  setMode: (m: Mode) => void;
  onMark: (note: string) => void;
  onRetire: (loser: PlayerIndex) => void;
  act: (a: Action) => void;
  info: InputInfo;
  setPicks: (p: Picks) => void;
}) {
  const [note, setNote] = useState("");
  const [retire, setRetire] = useState(false);
  const blocker = sb.editBlocker(state);
  return (
    <>
      {mode === "play" && state.phase !== "ended" && <ActionButtons state={state} names={names} act={act} info={info} setPicks={setPicks} />}
      <div class="banner record-tools">
        <label class="record-mark">
          動画と違う:
          <input type="text" placeholder="メモ（任意）" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
        </label>
        <button
          type="button"
          title="エンジンの結果が動画と合わない局面に印を付けます（あとでルールとカードの確認に回す）"
          onClick={() => {
            onMark(note.trim());
            setNote("");
          }}
        >
          印を付ける
        </button>
        <button type="button" class={mode === "edit" ? "active" : ""} disabled={mode === "play" && blocker !== null} title={blocker ?? "盤面・手札・リーダーを手で直します"} onClick={() => setMode(mode === "edit" ? "play" : "edit")}>
          {mode === "edit" ? "手で直すのを終える" : "手で直す"}
        </button>
        {retire ? (
          <>
            <span>リタイアした側:</span>
            {([0, 1] as const).map((p) => (
              <button type="button" key={p} onClick={() => onRetire(p)}>
                {names[p]}
              </button>
            ))}
            <button type="button" onClick={() => setRetire(false)}>
              やめる
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setRetire(true)}>
            リタイア
          </button>
        )}
      </div>
    </>
  );
}

function NumField({ label, value, min, max, onCommit }: { label: string; value: number; min: number; max: number; onCommit: (v: number) => void }) {
  return (
    <label class="field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Math.floor(Number(e.currentTarget.value));
          const v = Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : value;
          e.currentTarget.value = String(v);
          if (v !== value) onCommit(v);
        }}
      />
    </label>
  );
}

/** 手で直す（選んだカード・リーダー）。席ごとに、その席のものだけ出す */
function EditPanel({
  state,
  p,
  target,
  apply,
  clear,
}: {
  state: GameState;
  p: PlayerIndex;
  target: NonNullable<EditTarget>;
  apply: (label: string, f: (s: GameState) => GameState) => boolean;
  clear: () => void;
}) {
  const blocker = sb.editBlocker(state);
  if (target.kind === "leader") {
    if (target.player !== p) return null;
    const pl = state.players[p];
    const setPl = (label: string, f: (x: GameState["players"][number]) => void) => apply(label, (s) => sb.edit(s, (x) => f(x.players[p])));
    return (
      <div class="panel record-edit">
        <h3>リーダーを直す</h3>
        {blocker ? (
          <div class="muted">{blocker}</div>
        ) : (
          <div class="fields">
            <NumField label="体力" value={pl.leaderHp} min={0} max={pl.leaderMaxHp} onCommit={(v) => setPl(`リーダーの体力を ${v} に直した`, (x) => (x.leaderHp = v))} />
            <NumField label="PP" value={pl.pp} min={0} max={20} onCommit={(v) => setPl(`PP を ${v} に直した`, (x) => (x.pp = v))} />
            <NumField label="PP の最大値" value={pl.maxPp} min={0} max={10} onCommit={(v) => setPl(`PP の最大値を ${v} に直した`, (x) => (x.maxPp = v))} />
            <NumField label="EP" value={pl.ep} min={0} max={5} onCommit={(v) => setPl(`EP を ${v} に直した`, (x) => (x.ep = v))} />
            <NumField label="SEP" value={pl.sep} min={0} max={5} onCommit={(v) => setPl(`SEP を ${v} に直した`, (x) => (x.sep = v))} />
            <NumField label="墓場" value={pl.graveyard} min={0} max={99} onCommit={(v) => setPl(`墓場を ${v} に直した`, (x) => (x.graveyard = v))} />
          </div>
        )}
        <AddCard state={state} p={p} apply={apply} disabled={blocker !== null} />
      </div>
    );
  }
  const at = sb.findCard(state, target.iid);
  if (!at || at.player !== p) return null;
  const name = cardOf(at.card.cardId).name;
  const move = (to: "hand" | "board" | "deck" | "graveyard" | "none", label: string) => {
    if (apply(`${name}を${label}`, (s) => sb.moveCard(s, target.iid, to)) && to !== "hand" && to !== "board") clear();
  };
  return (
    <div class="panel record-edit">
      <h3>{name}を直す</h3>
      {blocker ? (
        <div class="muted">{blocker}</div>
      ) : (
        <>
          {at.zone === "board" && at.card.kind === "follower" && (
            <div class="fields">
              <NumField label="攻撃力" value={at.card.attack} min={0} max={99} onCommit={(v) => apply(`${name}の攻撃力を ${v} に直した`, (s) => sb.editFollower(s, target.iid, (c) => (c.attack = v)))} />
              <NumField
                label="体力"
                value={at.card.defense}
                min={1}
                max={99}
                onCommit={(v) =>
                  apply(`${name}の体力を ${v} に直した`, (s) =>
                    sb.editFollower(s, target.iid, (c) => {
                      c.defense = v;
                      c.maxDefense = Math.max(c.maxDefense, v);
                    }),
                  )
                }
              />
              <label class="field">
                <span>進化</span>
                <select value={at.card.evolve} onChange={(e) => apply(`${name}の進化を直した`, (s) => sb.setEvolve(s, target.iid, e.currentTarget.value as EvolveState))}>
                  <option value="none">進化前</option>
                  <option value="evolved">進化</option>
                  <option value="superEvolved">超進化</option>
                </select>
              </label>
            </div>
          )}
          {at.zone === "board" && at.card.kind === "amulet" && at.card.countdown !== null && (
            <div class="fields">
              <NumField label="カウントダウン" value={at.card.countdown} min={0} max={20} onCommit={(v) => apply(`${name}のカウントダウンを ${v} に直した`, (s) => sb.editAmulet(s, target.iid, (c) => (c.countdown = v)))} />
            </div>
          )}
          <div class="row-buttons">
            {at.zone === "hand" && (
              <button type="button" title="能力（ファンファーレ等）は働きません" onClick={() => move("board", "場に出した")}>
                場に出す
              </button>
            )}
            {at.zone === "board" && (
              <button type="button" onClick={() => move("hand", "手札に戻した")}>
                手札に戻す
              </button>
            )}
            <button type="button" onClick={() => move("deck", "山札に戻した")}>
              山札に戻す
            </button>
            <button type="button" title="墓場のカウントを 1 増やします（ラストワードは働きません）" onClick={() => move("graveyard", "墓場に置いた")}>
              墓場に置く
            </button>
            <button type="button" title="跡を残さず取り除きます" onClick={() => move("none", "消した")}>
              消す
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 手札・場にカードを加える（その席のデッキのカードと、デッキのカードが出すトークンだけ） */
function AddCard({ state, p, apply, disabled }: { state: GameState; p: PlayerIndex; apply: (label: string, f: (s: GameState) => GameState) => boolean; disabled: boolean }) {
  const ids = useMemo(() => {
    const own = new Set([...state.players[p].deck, ...state.players[p].hand, ...state.players[p].board].map((c) => c.cardId));
    const all = new Set(own);
    for (const id of own) for (const r of cardOf(id).related) all.add(r);
    return [...all].filter((id) => {
      try {
        cardOf(id);
        return true;
      } catch {
        return false;
      }
    }).sort((a, b) => cardOf(a).cost - cardOf(b).cost || a.localeCompare(b));
  }, [state, p]);
  const [id, setId] = useState(ids[0] ?? "");
  const [zone, setZone] = useState<"hand" | "board">("hand");
  const card = ids.includes(id) ? id : (ids[0] ?? "");
  return (
    <div class="row-buttons">
      <select value={card} onChange={(e) => setId(e.currentTarget.value)} disabled={disabled}>
        {ids.map((x) => (
          <option key={x} value={x}>
            {cardOf(x).cost} {cardOf(x).name}
          </option>
        ))}
      </select>
      <select value={zone} onChange={(e) => setZone(e.currentTarget.value as "hand" | "board")} disabled={disabled}>
        <option value="hand">手札に</option>
        <option value="board">場に</option>
      </select>
      <button
        type="button"
        disabled={disabled || !card}
        title="山札にあれば山札から取ります。能力は働きません"
        onClick={() => apply(`${cardOf(card).name}を${zone === "hand" ? "手札" : "場"}に加えた`, (s) => (zone === "hand" ? sb.addToHand(s, p, card, true) : sb.addToBoard(s, p, card, true)))}
      >
        加える
      </button>
    </div>
  );
}

// ---- 手順の一覧 ----

function stepLabel(step: RecordStep, before: GameState, after: GameState | undefined, names: [string, string]): string {
  switch (step.kind) {
    case "hand":
      return `${names[step.player]}の初期手札: ${step.cards.map((id) => cardOf(id).name).join("、")}`;
    case "action": {
      let text = describeAction(before, step.action, names, after);
      // マリガンで引いたカードは describeAction が書く（相手の席の引いたカードだけ足す）
      const own = step.action.type === "mulligan" ? step.action.player : null;
      const drawn = ([0, 1] as const).filter((p) => p !== own && (step.draws?.[p].length ?? 0) > 0);
      if (drawn.length > 0) text += `（引いた: ${drawn.map((p) => `${names[p]} ${step.draws![p].map((id) => cardOf(id).name).join("、")}`).join(" / ")}）`;
      if (step.outcome) text += `［ランダム: ${step.outcome}］`;
      return text;
    }
    case "edit":
      return `手で直した: ${step.label}`;
    case "mark":
      return `【印】動画と違う${step.note ? `: ${step.note}` : ""}`;
    case "retire":
      return `${names[step.loser]}がリタイア`;
  }
}

function StepLog({ record, states, index, names, onJump }: { record: Rec; states: GameState[]; index: number; names: [string, string]; onJump: (i: number) => void }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    ref.current?.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }, [index, record.steps.length]);
  const labels = useMemo(() => record.steps.map((s, i) => stepLabel(s, states[i]!, states[i + 1], names)), [record.steps, states]);
  return (
    <ol class="log replay-log record-log" ref={ref}>
      <li class={index === 0 ? "current" : ""} onClick={() => onJump(0)}>
        試合の始まり
      </li>
      {labels.map((l, i) => {
        const s = record.steps[i]!;
        const turn = states[i + 1]?.phase === "main" && states[i]?.turn !== states[i + 1]?.turn ? ` （ターン ${states[i + 1]!.turn}）` : "";
        return (
          <li key={i} class={`${i + 1 === index ? "current" : i + 1 > index ? "muted" : ""} ${s.kind === "mark" ? "record-log-mark" : ""}`} onClick={() => onJump(i + 1)}>
            {l}
            {turn}
          </li>
        );
      })}
    </ol>
  );
}
