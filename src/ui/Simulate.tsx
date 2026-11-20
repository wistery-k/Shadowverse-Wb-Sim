// AI 同士の自動対戦（総当たり）と勝率の集計。複数の Web Worker で並列に実行する（試合を 1 つずつ配る。src/sim/pool.ts）。

import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { CLASS_NAMES, type ClassId } from "../cards";
import type { GameState, PlayerIndex } from "../engine";
import { workerName } from "../engine";
import { gameHash, isGameHash, linkMatch, parseGameHash, recordLink, replaceHash, type LinkDecks } from "../sim/gameLink";
import { runPool } from "../sim/pool";
import { planGames, summarize, type Entrant, type GameRecord, type GameSpec, type TournamentSummary } from "../sim/tournament";
import type { WorkerRequest, WorkerResponse } from "../sim/worker";
import { Replay } from "./Replay";

/** 総当たりに出せるデッキ */
export interface DeckOption {
  key: string;
  cls: ClassId;
  cards: readonly string[];
  label: string;
  /** 一覧の小見出し（同じものを続けて並べる。無ければ見出しなし） */
  group?: string;
}

/** デッキをまとめて選ぶボタン */
export interface DeckPreset {
  label: string;
  keys: readonly string[];
}

interface Props {
  /** 選べるデッキ */
  decks: readonly DeckOption[];
  /** 選べる AI（キーは src/ai/registry.ts、値は表示名） */
  agents: Readonly<Record<string, string>>;
  /** 保存した選択が無いときの選択と、1組あたりの試合数 */
  defaults: { decks: readonly string[]; agents: readonly string[]; games: number };
  /** デッキと AI の選択の保存先（localStorage のキー） */
  storageKey: string;
  /** デッキをまとめて選ぶボタン */
  presets?: readonly DeckPreset[];
  /** 見出しの下の説明 */
  note?: ComponentChildren;
  /** リプレイの局面をサンドボックスで開く */
  onSandbox?: (state: GameState, label: string) => void;
  /**
   * 試合の URL（src/sim/gameLink.ts）のデッキの書き方。あれば、リプレイを開くと URL の # に試合（seed・AI・デッキ）を書き、
   * その URL でページを開くと試合を打ち直してリプレイを開く
   */
  links?: LinkDecks;
}

/** URL で開いた試合（打ち直している途中なら record は null） */
interface Linked {
  seed: number;
  entrants: Entrant[];
  record: GameRecord | null;
  error: string | null;
}

/** 今のページの、# を付けた URL */
const pageUrl = (hash: string) => location.origin + location.pathname + location.search + hash;

interface Run {
  entrants: Entrant[];
  total: number;
  records: GameRecord[];
  startedAt: number;
  finishedAt: number | null;
}

/** 勝率のセル色: 50% を灰色の中点に、勝ち越しは青・負け越しは赤へ（最大 60% まで混ぜる） */
function cellColor(rate: number): string {
  const strength = Math.round(Math.min(1, Math.abs(rate - 0.5) * 2) * 60);
  return `color-mix(in oklab, var(${rate >= 0.5 ? "--div-win" : "--div-lose"}) ${strength}%, var(--div-mid))`;
}

const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((n / d) * 100)}%`);

interface Selection {
  decks: string[];
  agents: string[];
}
function loadSelection(key: string, fallback: Selection, agents: Readonly<Record<string, string>>): Selection {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (typeof v !== "object" || v === null) return fallback;
    const strings = (x: unknown): string[] | null =>
      Array.isArray(x) && x.every((k) => typeof k === "string") ? (x as string[]) : null;
    const { decks, agents: saved } = v as Record<string, unknown>;
    return {
      decks: strings(decks) ?? fallback.decks,
      agents: strings(saved)?.filter((k) => k in agents) ?? fallback.agents,
    };
  } catch {
    // 保存できない環境では既定値を使う
  }
  return fallback;
}
function saveSelection(key: string, selection: Selection): void {
  try {
    localStorage.setItem(key, JSON.stringify(selection));
  } catch {
    // 保存できなくても動作には影響しない
  }
}

export function Simulate({ decks: options, agents: agentLabels, defaults, storageKey, presets, note, onSandbox, links }: Props) {
  // 保存済みの選択には、削除されたデッキの key が残っていることがあるので、今ある選択肢だけに絞る
  const [initial] = useState(() => loadSelection(storageKey, { decks: [...defaults.decks], agents: [...defaults.agents] }, agentLabels));
  const [checkedDecks, setSelected] = useState<string[]>(initial.decks);
  const [agents, setAgents] = useState<string[]>(initial.agents);
  const selected = checkedDecks.filter((k) => options.some((o) => o.key === k));
  useEffect(() => saveSelection(storageKey, { decks: checkedDecks, agents }), [checkedDecks, agents]);
  const [games, setGames] = useState(defaults.games);
  const [mirror, setMirror] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [replay, setReplay] = useState<GameRecord | null>(null);
  // 試合一覧に表示する組（参加者の添字）。リプレイから戻っても残るよう、ここで持つ
  const [pair, setPair] = useState<[number, number] | null>(null);
  const workers = useRef<Worker[]>([]);

  const stop = () => {
    for (const w of workers.current) w.terminate();
    workers.current = [];
  };
  useEffect(() => stop, []);

  // URL の試合（#game?…）: 開いたときと、# が変わったとき（同じページに別の試合の URL を貼ったとき）に打ち直す
  const [linked, setLinked] = useState<Linked | null>(null);
  const linkWorker = useRef<Worker | null>(null);
  function openLink(hash: string) {
    if (!links) return;
    linkWorker.current?.terminate();
    linkWorker.current = null;
    setReplay(null);
    const link = parseGameHash(hash);
    const m = link ? linkMatch(link, links, agentLabels) : "URL の試合の指定（seed・p0・d0・p1・d1）が読めません";
    if (typeof m === "string") {
      setLinked({ seed: link?.seed ?? 0, entrants: [], record: null, error: m });
      return;
    }
    setLinked({ seed: m.spec.seed, entrants: m.entrants, record: null, error: null });
    const worker = new Worker(new URL("../sim/worker.ts", import.meta.url), { type: "module", name: workerName() });
    linkWorker.current = worker;
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.type === "record") {
        const r = e.data.record;
        setLinked((l) => (l ? { ...l, record: r, error: r.actions ? null : `試合を打てませんでした: ${r.error ?? "不明なエラー"}` } : l));
      } else {
        worker.terminate();
        if (linkWorker.current === worker) linkWorker.current = null;
      }
    };
    const request: WorkerRequest = { entrants: m.entrants, specs: [m.spec], record: true };
    worker.postMessage(request);
  }
  const closeLinked = () => {
    linkWorker.current?.terminate();
    linkWorker.current = null;
    setLinked(null);
    if (isGameHash()) replaceHash(null);
  };
  useEffect(() => {
    if (!links) return;
    if (isGameHash()) openLink(location.hash);
    const onHash = () => {
      if (isGameHash()) openLink(location.hash);
    };
    addEventListener("hashchange", onHash);
    return () => {
      removeEventListener("hashchange", onHash);
      linkWorker.current?.terminate();
    };
  }, []);

  // 総当たりの試合のリプレイを開くと、URL の # にその試合を書く（読み込み直す・URL を送ると同じ試合を打ち直して開く）
  const openReplay = (r: GameRecord) => {
    setReplay(r);
    const link = links && run ? recordLink(r, run.entrants, links) : null;
    if (link) replaceHash(gameHash(link));
  };
  const closeReplay = () => {
    setReplay(null);
    if (isGameHash()) replaceHash(null);
  };
  const linkOf = (r: GameRecord, entrants: readonly Entrant[]) => {
    const link = links ? recordLink(r, entrants, links) : null;
    return link ? pageUrl(gameHash(link)) : undefined;
  };

  function start() {
    stop();
    setReplay(null);
    setPair(null);
    const decks = options.filter((o) => selected.includes(o.key));
    const entrants: Entrant[] = decks.flatMap((o) =>
      agents.map((agent) => ({
        name: agents.length > 1 ? `${o.label}（${agentLabels[agent] ?? agent}）` : o.label,
        deck: o.cards,
        agent,
      })),
    );
    const specs = planGames(entrants.length, {
      gamesPerPair: games,
      seed: Math.floor(Math.random() * 2 ** 32),
      mirror,
    });
    const startedAt = Date.now();
    setRun({ entrants, total: specs.length, records: [], startedAt, finishedAt: null });

    workers.current = runPool<GameSpec, WorkerResponse>({
      create: () => new Worker(new URL("../sim/worker.ts", import.meta.url), { type: "module", name: workerName() }),
      jobs: specs,
      request: (spec): WorkerRequest => ({ entrants, specs: [spec], record: true }),
      isDone: (msg) => msg.type === "done",
      onMessage: (msg) => {
        if (msg.type === "record") setRun((r) => (r ? { ...r, records: [...r.records, msg.record] } : r));
      },
      onFinish: () => {
        setRun((r) => (r ? { ...r, finishedAt: Date.now() } : r));
        stop();
      },
    });
  }

  const running = run !== null && run.finishedAt === null;
  const entrantCount = selected.length * agents.length;
  const pairCount = (entrantCount * (entrantCount - 1)) / 2 + (mirror ? entrantCount : 0);

  if (linked?.record?.actions)
    return <Replay record={linked.record} entrants={linked.entrants} onClose={closeLinked} onSandbox={onSandbox} link={linkOf(linked.record, linked.entrants)} />;
  if (run && replay) return <Replay record={replay} entrants={run.entrants} onClose={closeReplay} onSandbox={onSandbox} link={linkOf(replay, run.entrants)} />;

  return (
    <div class="simulate">
      {linked && (
        <section class="panel">
          <h2>URL の試合</h2>
          {linked.error ? (
            <p class="problems">URL の試合を開けませんでした: {linked.error}</p>
          ) : (
            <p>
              {linked.entrants[0]?.name} vs {linked.entrants[1]?.name}（seed {linked.seed}）の試合を、このページの今の版で打ち直しています。終わるとリプレイを開きます（探索 AI は 1 試合に数秒かかります）。
            </p>
          )}
          <div class="row-buttons">
            <button type="button" onClick={closeLinked}>
              {linked.error ? "閉じる" : "中止"}
            </button>
          </div>
        </section>
      )}
      <section class="panel">
        <h2>AI 同士の総当たり</h2>
        {note}
        <div class="sim-options">
          <fieldset>
            <legend>デッキ</legend>
            {presets && presets.length > 0 && (
              <div class="row-buttons sim-presets">
                {presets.map((p) => (
                  <button type="button" key={p.label} disabled={running} onClick={() => setSelected(options.filter((o) => p.keys.includes(o.key)).map((o) => o.key))}>
                    {p.label}
                  </button>
                ))}
                <button type="button" disabled={running} onClick={() => setSelected([])}>
                  外す
                </button>
                <span class="muted">{selected.length} 個を選択</span>
              </div>
            )}
            {/* デッキが多いとき（アズヴォルト環境のページの 84 個）は、開始のボタンが遠くならないよう枠の中で送る */}
            <div class={options.length > 20 ? "sim-deck-list" : undefined}>
              {options.map((o, i) => (
                <Fragment key={o.key}>
                  {o.group !== undefined && o.group !== options[i - 1]?.group && <div class="sim-group muted">{o.group}</div>}
                  <label class={`check class-${o.cls}`}>
                    <input
                      type="checkbox"
                      checked={selected.includes(o.key)}
                      disabled={running}
                      onChange={(e) =>
                        setSelected(e.currentTarget.checked ? [...selected, o.key] : selected.filter((k) => k !== o.key))
                      }
                    />
                    {o.label} <span class="muted">{CLASS_NAMES[o.cls]}</span>
                  </label>
                </Fragment>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>AI</legend>
            {Object.entries(agentLabels).map(([key, label]) => (
              <label key={key} class="check">
                <input
                  type="checkbox"
                  checked={agents.includes(key)}
                  disabled={running}
                  onChange={(e) => setAgents(e.currentTarget.checked ? [...agents, key] : agents.filter((k) => k !== key))}
                />
                {label}
              </label>
            ))}
            <p class="muted">複数選ぶと、デッキと AI の組を参加者として総当たりにします。</p>
          </fieldset>
          <fieldset>
            <legend>試合数</legend>
            <label>
              1組あたり{" "}
              <input
                type="number"
                min={1}
                max={1000}
                value={games}
                disabled={running}
                onInput={(e) => setGames(Math.max(1, Math.min(1000, Number(e.currentTarget.value) || 1)))}
              />{" "}
              試合
            </label>
            <label class="check">
              <input type="checkbox" checked={mirror} disabled={running} onChange={(e) => setMirror(e.currentTarget.checked)} />
              同じ参加者同士も対戦（ミラー）
            </label>
            <p class="muted">
              参加者 {entrantCount}、計 {pairCount * games} 試合
            </p>
          </fieldset>
        </div>
        <div class="row-buttons">
          {running ? (
            <button
              type="button"
              onClick={() => {
                stop();
                setRun((r) => (r ? { ...r, finishedAt: Date.now() } : r));
              }}
            >
              中止
            </button>
          ) : (
            <button type="button" class="primary" disabled={entrantCount < (mirror ? 1 : 2)} onClick={start}>
              開始
            </button>
          )}
          {run && (
            <span class="muted">
              {run.records.length}/{run.total} 試合（{(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000).toFixed(1)}秒）
            </span>
          )}
        </div>
        {run && <progress max={run.total} value={run.records.length} />}
      </section>
      {run && run.records.length > 0 && (
        <Results
          entrants={run.entrants}
          records={run.records}
          summary={summarize(run.entrants.length, run.records)}
          pair={pair}
          onPair={setPair}
          onReplay={openReplay}
        />
      )}
    </div>
  );
}

interface ResultsProps {
  entrants: Entrant[];
  records: GameRecord[];
  summary: TournamentSummary;
  pair: [number, number] | null;
  onPair: (pair: [number, number] | null) => void;
  onReplay: (record: GameRecord) => void;
}

function Results({ entrants, records, summary: s, pair, onPair: setPair, onReplay }: ResultsProps) {
  const rate = (i: number) => s.entrants[i]!.wins / Math.max(1, s.entrants[i]!.games);
  const order = entrants.map((_, i) => i).sort((x, y) => rate(y) - rate(x));
  return (
    <section class="panel">
      <h2>結果</h2>
      <p>
        先攻の勝率 {pct(s.firstPlayerWins, s.totalGames)} / 平均 {s.averageTurns.toFixed(1)} ターン / {s.totalGames} 試合
      </p>
      <div class="table-scroll">
        <table class="winrate">
          <thead>
            <tr>
              <th>順位</th>
              <th class="name">参加者</th>
              <th>通算</th>
              {order.map((_, k) => (
                <th key={k} title={entrants[order[k]!]!.name}>
                  vs #{k + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {order.map((i, k) => (
              <tr key={i}>
                <td>#{k + 1}</td>
                <th class="name">{entrants[i]!.name}</th>
                <td class="total">
                  {pct(s.entrants[i]!.wins, s.entrants[i]!.games)}
                  <span class="muted"> ({s.entrants[i]!.games})</span>
                </td>
                {order.map((j) => {
                  const g = s.games[i]![j]!;
                  const w = s.wins[i]![j]!;
                  const picked = pair !== null && pair[0] === i && pair[1] === j;
                  if (i === j)
                    return (
                      <td
                        key={j}
                        class={`diag ${g > 0 ? "clickable" : ""} ${picked ? "picked" : ""}`}
                        title={g > 0 ? `ミラー ${g} 試合（クリックで試合一覧）` : undefined}
                        onClick={g > 0 ? () => setPair([i, j]) : undefined}
                      >
                        -
                      </td>
                    );
                  return (
                    <td
                      key={j}
                      class={`cell clickable ${picked ? "picked" : ""}`}
                      style={g > 0 ? { background: cellColor(w / g) } : undefined}
                      title={`${entrants[i]!.name} vs ${entrants[j]!.name}: ${w}勝${g - w}敗（クリックで試合一覧）`}
                      onClick={() => setPair([i, j])}
                    >
                      {pct(w, g)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="muted legend">
        行の参加者から見た勝率。<span class="swatch win" />
        勝ち越し / <span class="swatch even" />
        五分 / <span class="swatch lose" />
        負け越し。セルにカーソルを合わせると勝敗数を、クリックするとその組の試合一覧（リプレイ）を表示します。
        1組の試合数が少ないと、たまたまの偏りが大きく出ます（目安として1組 50 試合以上）。
      </p>
      {pair && <GameList entrants={entrants} records={records} pair={pair} onReplay={onReplay} onClose={() => setPair(null)} />}
      {s.errors.length > 0 && (
        <ul class="problems">
          {s.errors.slice(0, 20).map((r) => (
            <li key={r.seed}>
              {entrants[r.a]!.name} vs {entrants[r.b]!.name}（seed {r.seed}）: {r.error}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface GameListProps {
  entrants: Entrant[];
  records: GameRecord[];
  /** [行の参加者, 列の参加者] */
  pair: [number, number];
  onReplay: (record: GameRecord) => void;
  onClose: () => void;
}

/** 1組の試合一覧（行の参加者から見た勝敗。ミラーは席 P1・P2 で表す） */
function GameList({ entrants, records, pair: [i, j], onReplay, onClose }: GameListProps) {
  const games = records.filter((r) => (r.a === i && r.b === j) || (r.a === j && r.b === i));
  const mirror = i === j;
  return (
    <div class="game-list">
      <h3>
        {entrants[i]!.name} vs {entrants[j]!.name}（{games.length} 試合）{" "}
        <button type="button" onClick={onClose}>
          閉じる
        </button>
      </h3>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>結果</th>
              <th>{mirror ? "先攻" : "手番"}</th>
              <th>ターン</th>
              <th>seed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {games.map((r, k) => {
              const seat = (p: PlayerIndex | undefined) => (p === undefined ? "-" : `P${p + 1}`);
              const result = r.winner === null ? "エラー" : mirror ? `${seat(r.seats?.winner)}の勝ち` : r.winner === i ? "勝ち" : "負け";
              const first = r.first === null ? "-" : mirror ? seat(r.seats?.first) : r.first === i ? "先攻" : "後攻";
              return (
                <tr key={r.seed} class={r.winner === null ? "" : mirror ? "" : r.winner === i ? "win" : "lose"}>
                  <td>{k + 1}</td>
                  <td>{result}</td>
                  <td>{first}</td>
                  <td>{r.winner === null ? "-" : r.turns}</td>
                  <td class="muted">{r.seed}</td>
                  <td>
                    <button type="button" disabled={!r.actions} title={r.error} onClick={() => onReplay(r)}>
                      リプレイ
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
