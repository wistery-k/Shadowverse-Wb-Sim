// AI 同士の自動対戦（総当たり）と勝率の集計。複数の Web Worker で並列に実行する。

import { useEffect, useRef, useState } from "preact/hooks";
import { AGENTS } from "../ai/registry";
import { CLASS_NAMES } from "../cards";
import type { PlayerIndex } from "../engine";
import type { Deck } from "../cards/deck";
import { DEFAULT_DECKS } from "../cards/defaultDecks";
import { planGames, summarize, type Entrant, type GameRecord, type TournamentSummary } from "../sim/tournament";
import type { WorkerRequest, WorkerResponse } from "../sim/worker";
import { isPlayable } from "./Decks";
import { Replay } from "./Replay";
import type { SavedDeck } from "./storage";

interface Props {
  saved: readonly SavedDeck[];
}

interface DeckOption {
  key: string;
  deck: Deck;
  label: string;
}

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

export function Simulate({ saved }: Props) {
  const options: DeckOption[] = [
    ...DEFAULT_DECKS.map((d) => ({ key: `default:${d.key}`, deck: d, label: d.name })),
    ...saved.filter(isPlayable).map((d) => ({ key: `saved:${d.id}`, deck: d, label: `${d.name}（保存）` })),
  ];
  const [selected, setSelected] = useState<string[]>(() => DEFAULT_DECKS.map((d) => `default:${d.key}`));
  const [agents, setAgents] = useState<string[]>(["greedy"]);
  const [games, setGames] = useState(10);
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

  function start() {
    stop();
    setReplay(null);
    setPair(null);
    const decks = options.filter((o) => selected.includes(o.key));
    const entrants: Entrant[] = decks.flatMap((o) =>
      agents.map((agent) => ({
        name: agents.length > 1 ? `${o.label}（${AGENTS[agent]?.label ?? agent}）` : o.label,
        deck: o.deck.cards,
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

    const count = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1, specs.length));
    let finished = 0;
    for (let w = 0; w < count; w++) {
      const worker = new Worker(new URL("../sim/worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === "record") {
          setRun((r) => (r ? { ...r, records: [...r.records, msg.record] } : r));
        } else if (++finished === count) {
          setRun((r) => (r ? { ...r, finishedAt: Date.now() } : r));
          stop();
        }
      };
      const request: WorkerRequest = { entrants, specs: specs.filter((_, i) => i % count === w), record: true };
      worker.postMessage(request);
      workers.current.push(worker);
    }
  }

  const running = run !== null && run.finishedAt === null;
  const entrantCount = selected.length * agents.length;
  const pairCount = (entrantCount * (entrantCount - 1)) / 2 + (mirror ? entrantCount : 0);

  if (run && replay) return <Replay record={replay} entrants={run.entrants} onClose={() => setReplay(null)} />;

  return (
    <div class="simulate">
      <section class="panel">
        <h2>AI 同士の総当たり</h2>
        <div class="sim-options">
          <fieldset>
            <legend>デッキ</legend>
            {options.map((o) => (
              <label key={o.key} class={`check class-${o.deck.class}`}>
                <input
                  type="checkbox"
                  checked={selected.includes(o.key)}
                  disabled={running}
                  onChange={(e) =>
                    setSelected(e.currentTarget.checked ? [...selected, o.key] : selected.filter((k) => k !== o.key))
                  }
                />
                {o.label} <span class="muted">{CLASS_NAMES[o.deck.class]}</span>
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>AI</legend>
            {Object.entries(AGENTS).map(([key, { label }]) => (
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
          onReplay={setReplay}
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
