// リプレイ検索（開発サーバー npm run dev だけのタブ）: 自己対戦などで記録した試合（--replays の JSON Lines 等）を読み込み、
// クラス・デッキ・ターンの条件・関連するターンの条件で、条件に合うターンを探す。見つけたターンはリプレイで開き、
// そこから打ち比べ（別の手を打って AI に最後まで打たせる）やサンドボックスに進める。
// 手元のファイルは開発サーバーが配る（scripts/replay-files.ts）。ファイルを選んで読むこともできる。
// vite build では、このモジュールは何も表示しないものに置き換わる（scripts/replay-files.ts の devOnlyReplaySearch）。

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AGENTS } from "../ai/registry";
import { ALL_CARDS, CLASS_IDS, CLASS_NAMES, type ClassId } from "../cards";
import type { GameState, PlayerIndex } from "../engine";
import { REPLAY_API, type ReplayFileEntry, type ReplayFileList } from "../replays/api";
import { ReplayLibrary, readStreamText, type FileStatus, type SearchResult } from "../replays/library";
import {
  cardIdsOf,
  emptyQuery,
  FIELD_LABELS,
  KIND_LABELS,
  newCond,
  OP_LABELS,
  SCOPE_LABELS,
  WHO_LABELS,
  WHOLE_TURN_FIELDS,
  type Cond,
  type CondKind,
  type MatchRow,
  type ReplayQuery,
} from "../replays/query";
import type { GameIndex, ReplayRecord } from "../replays/types";
import type { Entrant, GameRecord } from "../sim/tournament";
import { Replay } from "./Replay";
import "./ReplaySearch.css";

interface Props {
  /** リプレイの局面をサンドボックスで開く */
  onSandbox?: (state: GameState, label: string) => void;
}

const QUERY_KEY = "svwb-sim:replay-search:query:v1";
const FILES_KEY = "svwb-sim:replay-search:files:v1";

function loadStored<T>(key: string, parse: (v: unknown) => T | null, fallback: T): T {
  try {
    return parse(JSON.parse(localStorage.getItem(key) ?? "null")) ?? fallback;
  } catch {
    // 保存できない環境では既定値を使う
    return fallback;
  }
}
function store(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 保存できなくても動作には影響しない
  }
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** 保存した条件（前の版の形でも、足りない項目は既定値で埋める） */
function parseQuery(v: unknown): ReplayQuery | null {
  if (!isObject(v)) return null;
  const conds = Array.isArray(v.conds) ? v.conds.filter(isObject).map((c) => ({ ...newCond(), ...c }) as Cond) : [];
  return { ...emptyQuery(), ...v, conds } as ReplayQuery;
}
const parseStrings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null);

const ANNE = "マナリアフレンズ・アン＆グレア";
const cond = (c: Partial<Cond>): Cond => ({ ...newCond(c.kind), ...c });

/** 条件の例（クラス・デッキの絞り込みは残し、ターンの条件を置き換える） */
const PRESETS: { label: string; apply: (q: ReplayQuery) => ReplayQuery }[] = [
  { label: "リーサルを取られる直前の自分のターン", apply: (q) => ({ ...q, whose: "me", conds: [cond({ kind: "decided", who: "opp", scope: "next" })], expr: "" }) },
  { label: "リーサルを取られたターン（相手のターン）", apply: (q) => ({ ...q, whose: "opp", conds: [cond({ kind: "decided", who: "opp" })], expr: "" }) },
  {
    label: "アン＆グレアを出して、処理されずに残った",
    apply: (q) => ({ ...q, whose: "me", conds: [cond({ kind: "played", card: ANNE }), cond({ kind: "survived", card: ANNE })], expr: "" }),
  },
  { label: "PP＋エクストラPP＝10 の自分のターン", apply: (q) => ({ ...q, whose: "me", conds: [cond({ kind: "num", field: "ppx", op: "eq", value: 10 })], expr: "" }) },
  {
    label: "前の自分のターンに進化させた自分のターン",
    apply: (q) => ({ ...q, whose: "me", conds: [cond({ kind: "evolved", scope: "prevMine" })], expr: "" }),
  },
];

/** カード名を選ぶ候補（同じ名前は 1 つ） */
const CARD_NAMES = [...new Set(ALL_CARDS.map((c) => c.name))];

const CARD_KINDS: ReadonlySet<CondKind> = new Set(["played", "evolved", "attacked", "entered", "left", "survived", "onBoard", "inHand"]);

const mb = (n: number) => (n < 1e6 ? `${Math.ceil(n / 1e3)} KB` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`);
const pct = (n: number, d: number) => (d === 0 ? "-" : `${((n / d) * 100).toFixed(1)}%`);
const dirOf = (rel: string) => {
  const i = Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\"));
  return i < 0 ? "" : rel.slice(0, i);
};

/** リプレイで開いている試合 */
interface OpenGame {
  row: MatchRow;
  record: ReplayRecord;
  index: GameIndex;
  file: string;
  line: number;
}

export function ReplaySearch({ onSandbox }: Props) {
  const [list, setList] = useState<ReplayFileList | null>(null);
  const [listError, setListError] = useState("");
  const [checked, setCheckedState] = useState<string[]>(() => loadStored(FILES_KEY, parseStrings, []));
  const [statuses, setStatuses] = useState<FileStatus[]>([]);
  const [loading, setLoading] = useState<{ file: string; done: number; total: number } | null>(null);
  const [loadError, setLoadError] = useState("");
  const lib = useRef<ReplayLibrary | null>(null);
  const [decks, setDecks] = useState<string[]>([]);
  const [query, setQueryState] = useState<ReplayQuery>(() => loadStored(QUERY_KEY, parseQuery, emptyQuery()));
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [limit, setLimit] = useState(200);
  const [open, setOpen] = useState<OpenGame | null>(null);
  const [openError, setOpenError] = useState("");

  const setQuery = (q: ReplayQuery) => {
    setQueryState(q);
    store(QUERY_KEY, q);
  };
  const setChecked = (paths: string[]) => {
    setCheckedState(paths);
    store(FILES_KEY, paths);
  };

  async function refreshList() {
    setListError("");
    try {
      const res = await fetch(`${REPLAY_API}/list`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setList((await res.json()) as ReplayFileList);
    } catch (e) {
      setListError(`手元のファイルの一覧を取れませんでした（${String(e)}）。npm run dev で開いているか確かめてください`);
    }
  }
  useEffect(() => {
    void refreshList();
    return () => lib.current?.clear();
  }, []);

  const loadedCount = statuses.reduce((n, s) => n + s.games, 0);

  /** ファイルを読み込む（前に読み込んだ試合は捨てる） */
  async function load(sources: { name: string; read: () => Promise<string> }[]) {
    lib.current?.clear();
    const library = new ReplayLibrary();
    lib.current = library;
    setStatuses([]);
    setResult(null);
    setLoadError("");
    const done: FileStatus[] = [];
    try {
      for (const src of sources) {
        setLoading({ file: src.name, done: 0, total: 1 });
        const text = await src.read();
        const st = await library.loadText(src.name, text, (d, total) => setLoading({ file: src.name, done: d, total }));
        if (lib.current !== library) return;
        done.push(st);
        setStatuses([...done]);
      }
    } catch (e) {
      // 読み込みの途中で読み込み直した（前の読み込みは中止）なら何もしない
      if (lib.current === library) setLoadError(`読み込めませんでした: ${String(e)}`);
    } finally {
      if (lib.current === library) {
        setLoading(null);
        setDecks([...library.decks].sort((a, b) => a.localeCompare(b)));
      }
    }
  }

  const loadChecked = () => {
    const files = (list?.files ?? []).filter((f) => checked.includes(f.path));
    void load(
      files.map((f) => ({
        name: f.rel,
        read: async () => {
          const res = await fetch(`${REPLAY_API}/file?path=${encodeURIComponent(f.path)}`);
          if (!res.ok || !res.body) throw new Error(`${f.rel}: ${res.status} ${res.statusText}`);
          return await readStreamText(f.rel, res.body);
        },
      })),
    );
  };

  const loadPicked = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    void load([...files].map((f) => ({ name: f.name, read: () => readStreamText(f.name, f.stream()) })));
  };

  async function search(n = limit) {
    if (!lib.current) return;
    setSearching(true);
    try {
      setResult(await lib.current.search(query, n));
    } catch {
      // 検索の途中で読み込み直した
    } finally {
      setSearching(false);
    }
  }

  async function openRow(row: MatchRow) {
    if (!lib.current) return;
    setOpenError("");
    const g = await lib.current.game(row.w, row.id).catch(() => null);
    if (!g) {
      setOpenError("試合が見つかりません（読み込み直した後なら、もう一度検索してください）");
      return;
    }
    setOpen({ row, record: g.record, index: g.index, file: g.file, line: g.line });
  }

  // 一覧のファイルをフォルダごとにまとめる
  const groups = useMemo(() => {
    const m = new Map<string, ReplayFileEntry[]>();
    for (const f of list?.files ?? []) {
      const key = `${f.root}\n${dirOf(f.rel)}`;
      m.set(key, [...(m.get(key) ?? []), f]);
    }
    return [...m.entries()].map(([key, files]) => ({ key, root: key.split("\n")[0]!, dir: key.split("\n")[1]!, files }));
  }, [list]);

  const toggle = (paths: string[], on: boolean) => setChecked(on ? [...new Set([...checked, ...paths])] : checked.filter((p) => !paths.includes(p)));
  const updateCond = (i: number, c: Cond) => setQuery({ ...query, conds: query.conds.map((x, j) => (j === i ? c : x)) });

  return (
    <div class="replay-search">
      {open && <OpenReplay open={open} onClose={() => setOpen(null)} onSandbox={onSandbox} />}
      <div class="replay-search-main" hidden={!!open}>
        <section class="panel">
          <h2>データ</h2>
          <p class="muted">
            自己対戦の <code>--replays</code>（<code>npm run svwb -- td selfplay … --replays r.jsonl</code>・<code>npm run compare -- … --replays r.jsonl</code>）、
            <code>rhino-compare --record</code>、<code>npm run game -- … --json</code> で書いた試合の記録を読みます。
            探すフォルダは環境変数 <code>SVWB_REPLAY_DIRS</code>（無ければ <code>~/svwb-data</code> とリポジトリの <code>replays/</code>）。
          </p>
          {listError && <p class="problems">{listError}</p>}
          {list && (
            <div class="replay-files">
              <div class="muted">探したフォルダ: {list.roots.length > 0 ? list.roots.join("、") : "（どれもありません）"}</div>
              {list.files.length === 0 && <div class="muted">試合の記録らしいファイルはありませんでした。</div>}
              {groups.map((g) => {
                const paths = g.files.map((f) => f.path);
                const all = paths.every((p) => checked.includes(p));
                return (
                  <details key={g.key} open={groups.length <= 3 || paths.some((p) => checked.includes(p))}>
                    <summary>
                      <label class="check inline" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={all} onChange={(e) => toggle(paths, e.currentTarget.checked)} />
                        {list.roots.length > 1 ? `${g.root}/` : ""}
                        {g.dir || "（直下）"}
                      </label>{" "}
                      <span class="muted">
                        {g.files.length} ファイル・{mb(g.files.reduce((n, f) => n + f.size, 0))}
                      </span>
                    </summary>
                    {g.files.map((f) => (
                      <label key={f.path} class="check">
                        <input type="checkbox" checked={checked.includes(f.path)} onChange={(e) => toggle([f.path], e.currentTarget.checked)} />
                        {f.rel.slice(g.dir.length ? g.dir.length + 1 : 0)}
                        <span class="muted">
                          {mb(f.size)}・{new Date(f.mtime).toLocaleString("ja-JP")}
                        </span>
                      </label>
                    ))}
                  </details>
                );
              })}
            </div>
          )}
          <div class="row-buttons">
            <button type="button" class="primary" disabled={!!loading || !list?.files.some((f) => checked.includes(f.path))} onClick={loadChecked}>
              選んだファイルを読み込む
            </button>
            <button type="button" onClick={() => void refreshList()}>
              一覧を更新
            </button>
            <label class="check">
              ほかのファイルを選んで読む
              <input type="file" multiple accept=".json,.jsonl,.gz" disabled={!!loading} onChange={(e) => loadPicked(e.currentTarget.files)} />
            </label>
          </div>
          {loading && (
            <div>
              {loading.file} を読み込み中…
              <progress value={loading.done} max={loading.total} />
            </div>
          )}
          {loadError && <p class="problems">{loadError}</p>}
          {statuses.length > 0 && (
            <div class="replay-status">
              <strong>読み込んだ試合: {loadedCount}</strong>
              <ul>
                {statuses.map((s) => (
                  <li key={s.file}>
                    {s.file}: {s.games} 試合
                    {s.skipped > 0 && <span class="muted">（試合でない行 {s.skipped}）</span>}
                    {s.mismatched > 0 && <span class="problems-inline">・記録と勝者が違う試合 {s.mismatched}（エンジンの版が違う可能性）</span>}
                    {s.failed > 0 && (
                      <span class="problems-inline">
                        ・読めない・打ち直せない試合 {s.failed}: {s.errors.join(" / ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section class="panel">
          <h2>条件</h2>
          <div class="sim-options">
            <fieldset>
              <legend>自分</legend>
              <ClassSelect value={query.myClass} onChange={(myClass) => setQuery({ ...query, myClass })} />
              <input list="replay-deck-names" placeholder="デッキ名の一部" value={query.myDeck} onInput={(e) => setQuery({ ...query, myDeck: e.currentTarget.value })} />
              <select value={query.order} onChange={(e) => setQuery({ ...query, order: e.currentTarget.value as ReplayQuery["order"] })}>
                <option value="any">先攻・後攻どちらでも</option>
                <option value="first">先攻</option>
                <option value="second">後攻</option>
              </select>
              <select value={query.result} onChange={(e) => setQuery({ ...query, result: e.currentTarget.value as ReplayQuery["result"] })}>
                <option value="any">勝ち・負けどちらでも</option>
                <option value="win">勝った試合</option>
                <option value="lose">負けた試合</option>
              </select>
            </fieldset>
            <fieldset>
              <legend>相手</legend>
              <ClassSelect value={query.oppClass} onChange={(oppClass) => setQuery({ ...query, oppClass })} />
              <input list="replay-deck-names" placeholder="デッキ名の一部" value={query.oppDeck} onInput={(e) => setQuery({ ...query, oppDeck: e.currentTarget.value })} />
            </fieldset>
            <fieldset>
              <legend>探すターン</legend>
              <select value={query.whose} onChange={(e) => setQuery({ ...query, whose: e.currentTarget.value as ReplayQuery["whose"] })}>
                <option value="any">どちらのターンでも</option>
                <option value="me">自分のターン</option>
                <option value="opp">相手のターン</option>
              </select>
              <label class="check">
                <input type="checkbox" checked={query.firstOnly} onChange={(e) => setQuery({ ...query, firstOnly: e.currentTarget.checked })} />
                試合ごとに最初のターンだけ
              </label>
            </fieldset>
          </div>
          <p class="muted">
            1 試合を両方のプレイヤーの視点で調べます（自己対戦ではどちらも「自分」になります）。下の条件をすべて満たすターンを探します。「いつ」は探しているターンから見たターンです。
          </p>
          <div class="conds">
            {query.conds.map((c, i) => (
              <CondRow key={i} c={c} onChange={(x) => updateCond(i, x)} onRemove={() => setQuery({ ...query, conds: query.conds.filter((_, j) => j !== i) })} />
            ))}
          </div>
          <div class="row-buttons">
            <button type="button" onClick={() => setQuery({ ...query, conds: [...query.conds, newCond()] })}>
              条件を足す
            </button>
            <select
              value=""
              onChange={(e) => {
                const p = PRESETS[Number(e.currentTarget.value)];
                if (p) setQuery(p.apply(query));
              }}
            >
              <option value="">例から選ぶ…</option>
              {PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setQuery({ ...emptyQuery() })}>
              条件を消す
            </button>
          </div>
          <details class="expr" open={query.expr.trim() !== ""}>
            <summary>JavaScript の式で書く条件</summary>
            <textarea rows={3} placeholder='例: t.mine && t.me.start.hp <= 5 && has(t.opp.played, "アン＆グレア")' value={query.expr} onInput={(e) => setQuery({ ...query, expr: e.currentTarget.value })} />
            <ul class="muted expr-help">
              <li>
                <code>t</code>: 探しているターン。<code>t.n</code> 全体のターン番号、<code>t.mine</code> 自分のターンか、<code>t.decided</code> 決着したなら "me"・"opp"、
                <code>t.prev</code>・<code>t.next</code> 前後のターン（無ければ null）
              </li>
              <li>
                <code>t.me</code>・<code>t.opp</code>: <code>start</code>・<code>end</code>（ターンの始め・終わりの <code>hp maxPp pp ppx ep sep xpp deck grave</code>、
                <code>hand</code> カード名、<code>board</code> の <code>name attack defense evolve amulet</code>）、<code>played evolved superEvolved entered left</code>（カード名）、
                <code>attacks</code>（<code>name target</code>）、<code>extraPp dmg tc</code>
              </li>
              <li>
                <code>g</code>: 試合（<code>g.turns g.won g.first g.myDeck g.oppDeck g.myClass g.oppClass</code>）。<code>has(リスト, "名前の一部")</code>・<code>count(リスト, "名前の一部")</code>
              </li>
            </ul>
          </details>
          <div class="row-buttons">
            <button type="button" class="primary" disabled={loadedCount === 0 || searching || !!loading} onClick={() => void search()}>
              {searching ? "検索中…" : "検索"}
            </button>
            {loadedCount === 0 && <span class="muted">先に試合を読み込みます</span>}
          </div>
        </section>

        {result && (
          <section class="panel">
            <h2>結果</h2>
            {result.error && <p class="problems">式を実行できません: {result.error}</p>}
            {result.stats.exprError && <p class="problems">式の実行でエラーがありました（そのターンは合わないものにしました）: {result.stats.exprError}</p>}
            <p>
              条件に合うターン <strong>{result.stats.turns}</strong>（そのターンのあった試合（視点）{result.stats.games}、そのうち自分の勝ち {result.stats.wins} ={" "}
              {pct(result.stats.wins, result.stats.games)}）
              <span class="muted">
                {" "}
                / クラス・デッキ等で絞った試合（視点）{result.stats.scanned}、自分の勝ち {pct(result.stats.scannedWins, result.stats.scanned)}
              </span>
            </p>
            {openError && <p class="problems">{openError}</p>}
            <div class="table-scroll">
              <table class="replay-results">
                <thead>
                  <tr>
                    <th>記録</th>
                    <th>自分</th>
                    <th>相手</th>
                    <th>ターン</th>
                    <th>体力（始め）</th>
                    <th>PP</th>
                    <th>このターンにプレイしたカード</th>
                    <th>結果</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={`${r.w}-${r.id}-${r.me}-${r.k}`} class={r.won === null ? "" : r.won ? "win" : "lose"} onClick={() => void openRow(r)} title="リプレイで開く">
                      <td>
                        {r.file}:{r.line}
                        {r.sub > 0 ? `[${r.sub}]` : ""}
                        {r.g !== undefined && <span class="muted"> g{r.g}</span>}
                        {r.mismatch && <span class="problems-inline"> 勝者が違う</span>}
                      </td>
                      <td>
                        <span class={`class-tag class-${r.myClass}`}>{CLASS_NAMES[r.myClass]}</span> {r.myDeck}（{r.first ? "先攻" : "後攻"}）
                      </td>
                      <td>
                        <span class={`class-tag class-${r.oppClass}`}>{CLASS_NAMES[r.oppClass]}</span> {r.oppDeck}
                      </td>
                      <td>
                        {r.n}（{r.mine ? "自分" : "相手"}の {r.tc} ターン目）
                      </td>
                      <td>
                        {r.hp[0]} - {r.hp[1]}
                      </td>
                      <td>
                        {r.maxPp}
                        {r.ppx > r.maxPp ? `＋${r.ppx - r.maxPp}` : ""}
                      </td>
                      <td class="played">{r.played.join("・")}</td>
                      <td>{r.won === null ? "-" : r.won ? "勝ち" : "負け"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {result.rows.length < result.stats.turns && (
              <div class="row-buttons">
                <span class="muted">
                  {result.rows.length} / {result.stats.turns} ターンを表示
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const n = limit * 5;
                    setLimit(n);
                    void search(n);
                  }}
                >
                  もっと表示
                </button>
              </div>
            )}
          </section>
        )}
      </div>
      <datalist id="replay-card-names">
        {CARD_NAMES.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="replay-deck-names">
        {decks.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </div>
  );
}

function ClassSelect({ value, onChange }: { value: ClassId | ""; onChange: (v: ClassId | "") => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.currentTarget.value as ClassId | "")}>
      <option value="">どのクラスでも</option>
      {CLASS_IDS.filter((c) => c !== "neutral").map((c) => (
        <option key={c} value={c}>
          {CLASS_NAMES[c]}
        </option>
      ))}
    </select>
  );
}

function options<K extends string>(labels: Record<K, string>) {
  return (Object.entries(labels) as [K, string][]).map(([k, label]) => (
    <option key={k} value={k}>
      {label}
    </option>
  ));
}

/** 条件 1 つの編集（「いつ」に「誰」が「何を」） */
function CondRow({ c, onChange, onRemove }: { c: Cond; onChange: (c: Cond) => void; onRemove: () => void }) {
  const set = <K extends keyof Cond>(k: K, v: Cond[K]) => onChange({ ...c, [k]: v });
  const ids = useMemo(() => cardIdsOf(c.card), [c.card]);
  const usesCard = CARD_KINDS.has(c.kind);
  const usesWhen = c.kind === "onBoard" || c.kind === "inHand" || (c.kind === "num" && !WHOLE_TURN_FIELDS.has(c.field));
  return (
    <div class={`cond-row ${c.negate ? "negated" : ""}`}>
      <select value={c.scope} onChange={(e) => set("scope", e.currentTarget.value as Cond["scope"])}>
        {options(SCOPE_LABELS)}
      </select>
      <span>に</span>
      <select value={c.who} onChange={(e) => set("who", e.currentTarget.value as Cond["who"])}>
        {options(WHO_LABELS)}
      </select>
      <span>が</span>
      <select value={c.kind} onChange={(e) => set("kind", e.currentTarget.value as CondKind)}>
        {options(KIND_LABELS)}
      </select>
      {usesCard && (
        <input class="card-input" list="replay-card-names" placeholder="カード名（空ならどれでも）" value={c.card} onInput={(e) => set("card", e.currentTarget.value)} />
      )}
      {c.kind === "played" && (
        <label class="check inline">
          <input type="number" min={1} value={c.min} onInput={(e) => set("min", Math.max(1, Number(e.currentTarget.value) || 1))} />
          枚以上
        </label>
      )}
      {c.kind === "evolved" && (
        <select value={c.mode} onChange={(e) => set("mode", e.currentTarget.value as Cond["mode"])}>
          <option value="any">進化・超進化</option>
          <option value="evolve">進化（超進化を除く）</option>
          <option value="super">超進化</option>
        </select>
      )}
      {c.kind === "attacked" && (
        <select value={c.target} onChange={(e) => set("target", e.currentTarget.value as Cond["target"])}>
          <option value="any">攻撃先はどれでも</option>
          <option value="leader">リーダーに</option>
          <option value="follower">フォロワーに</option>
        </select>
      )}
      {c.kind === "num" && (
        <select value={c.field} onChange={(e) => set("field", e.currentTarget.value as Cond["field"])}>
          {options(FIELD_LABELS)}
        </select>
      )}
      {usesWhen && (
        <select value={c.when} onChange={(e) => set("when", e.currentTarget.value as Cond["when"])}>
          <option value="start">ターンの始め</option>
          <option value="end">ターンの終わり</option>
        </select>
      )}
      {c.kind === "num" && (
        <>
          <select value={c.op} onChange={(e) => set("op", e.currentTarget.value as Cond["op"])}>
            {options(OP_LABELS)}
          </select>
          <input type="number" value={c.value} onInput={(e) => set("value", Number(e.currentTarget.value) || 0)} />
        </>
      )}
      <label class="check inline">
        <input type="checkbox" checked={c.negate} onChange={(e) => set("negate", e.currentTarget.checked)} />
        満たさない
      </label>
      <button type="button" onClick={onRemove}>
        削除
      </button>
      {usesCard &&
        ids !== null &&
        (ids.size === 0 ? (
          <span class="problems-inline">合うカードがありません</span>
        ) : (
          !CARD_NAMES.includes(c.card.trim()) && <span class="muted">名前の一部が合うカード {ids.size} 種類</span>
        ))}
    </div>
  );
}

/** 記録の AI が登録された AI（src/ai/registry.ts）なら、その名前。無ければ探索（打ち比べ・AI の考えに使う） */
const agentKey = (a: string) => (a in AGENTS ? a : "search");

/** 見つけたターンをリプレイで開く */
function OpenReplay({ open, onClose, onSandbox }: { open: OpenGame; onClose: () => void; onSandbox?: ((state: GameState, label: string) => void) | undefined }) {
  const { record, index, row } = open;
  const entrants = useMemo(
    (): Entrant[] => ([0, 1] as const).map((p) => ({ name: record.names[p], deck: record.decks[p], agent: agentKey(record.agents[p]) })),
    [record],
  );
  const game = useMemo((): GameRecord => {
    const r: GameRecord = {
      a: 0,
      b: 1,
      seed: record.seed,
      winner: index.winner,
      first: index.first,
      turns: index.turns[index.turns.length - 1]?.n ?? 0,
      aIsPlayer0: true,
      actions: record.actions,
    };
    if (index.winner !== null) r.seats = { winner: index.winner, first: index.first };
    return r;
  }, [record, index]);
  const me: PlayerIndex = row.me;
  return (
    <div class="replay-open">
      <div class="banner column muted">
        <div>
          記録: {open.file}:{open.line}
          {record.source ? `（${record.source}${record.g !== undefined ? ` 試合 ${record.g}` : ""}）` : ""} / 打った AI: {record.agents[0] || "不明"} / {record.agents[1] || "不明"} /
          見つけたターン: {row.n}（{row.mine ? "自分" : "相手"}のターン。自分 = {record.names[me]}、下に表示）
        </div>
        <div>打ち比べ・AI の考えは、登録された AI で行います（記録の AI が登録に無ければ「探索」）。</div>
        {row.mismatch && <div class="problems-inline">記録の勝者と打ち直した勝者が違います（記録したときとエンジンの版が違う可能性があります）</div>}
      </div>
      <Replay
        key={`${row.w}-${row.id}-${row.me}-${row.k}`}
        record={game}
        entrants={entrants}
        onClose={onClose}
        onSandbox={onSandbox}
        initialStep={row.step}
        initialBottom={me}
        backLabel="← 検索結果に戻る"
      />
    </div>
  );
}
