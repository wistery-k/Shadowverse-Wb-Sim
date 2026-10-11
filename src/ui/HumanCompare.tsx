// 「人間との比較」: npm run rhino-compare / af-compare / spellwitch-compare と同じシードの試合を、人間が比べるデッキ（リノセウスエルフ・AFネメシス・スペルウィッチ）で打つ画面。
// 打った試合の記録（勝敗・各ターンの選択・行動の列）はデッキごとにブラウザに保存し、JSON Lines で書き出せる。

import { useMemo, useState } from "preact/hooks";
import { createGame, type PlayerIndex } from "../engine";
import { parseHumanRecord, toJsonLines, type HumanGameRecord } from "../sim/humanRecord";
import { compareMatch, isSubjectId, opponentsOf, SUBJECT_IDS, SUBJECTS, type SubjectId } from "../sim/humanCompare";

/** 最後に選んだ比べるデッキ */
const SUBJECT_KEY = "svwb-sim:human-compare-subject:v1";

function loadSubject(): SubjectId {
  try {
    const v = localStorage.getItem(SUBJECT_KEY);
    return isSubjectId(v) ? v : "rhino";
  } catch {
    return "rhino";
  }
}

function saveSubject(subject: SubjectId): void {
  try {
    localStorage.setItem(SUBJECT_KEY, subject);
  } catch {
    // 保存できなくても動作には影響しない
  }
}

export function loadHumanRecords(subject: SubjectId): HumanGameRecord[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(SUBJECTS[subject].storageKey) ?? "[]");
    return Array.isArray(data) ? data.flatMap((v) => parseHumanRecord(v) ?? []).filter((r) => r.subject === subject) : [];
  } catch {
    return [];
  }
}

/** 保存する。失敗したら false */
export function saveHumanRecords(subject: SubjectId, records: readonly HumanGameRecord[]): boolean {
  try {
    localStorage.setItem(SUBJECTS[subject].storageKey, JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

export interface HumanMatchChoice {
  subject: SubjectId;
  deck: string;
  g: number;
  seat: PlayerIndex;
}

function download(fileName: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.replace(/[\\/:*?"<>|]/g, "_");
  a.click();
  URL.revokeObjectURL(url);
}

const matchKey = (m: HumanMatchChoice) => `${m.subject}/${m.deck}/${m.g}/${m.seat}`;
const seatLabel = (p: PlayerIndex) => (p === 0 ? "P1" : "P2");

/**
 * 次に打つ試合。g はまだどの記録にも使っていない最小の番号にする（同じ g だと席が同じなら自分の山札の順番・初手が
 * 相手デッキによらず同じなので、毎回変えて引きを覚えられないようにする）。相手デッキと席は、記録の少ない組み合わせ
 * （同数なら相手デッキ、席の順）にする。
 */
function nextMatch(subject: SubjectId, records: readonly HumanGameRecord[]): HumanMatchChoice {
  const usedG = new Set(records.map((r) => r.g));
  let g = 0;
  while (usedG.has(g)) g++;
  let best: HumanMatchChoice | null = null;
  let bestCount = Infinity;
  for (const d of opponentsOf(subject))
    for (const seat of [0, 1] as const) {
      const count = records.filter((r) => r.deck === d.name && r.seat === seat).length;
      if (count < bestCount) {
        best = { subject, deck: d.name, g, seat };
        bestCount = count;
      }
    }
  if (!best) throw new Error("相手デッキがありません");
  return best;
}

export function HumanCompare({ onStart, saveError }: { onStart: (m: HumanMatchChoice) => void; saveError: string }) {
  const [subject, setSubjectState] = useState<SubjectId>(() => loadSubject());
  const [records, setRecords] = useState<HumanGameRecord[]>(() => loadHumanRecords(subject));
  const [choice, setChoice] = useState<HumanMatchChoice>(() => nextMatch(subject, records));
  const [copied, setCopied] = useState(false);
  const decks = opponentsOf(subject);
  const me = SUBJECTS[subject].deck;
  const { seed, first } = useMemo(() => {
    const m = compareMatch(choice.subject, choice.deck, choice.g, choice.seat);
    return { seed: m.seed, first: createGame(m).first === choice.seat };
  }, [choice]);
  const played = records.filter((r) => matchKey(r) === matchKey(choice)).length;
  const wins = records.filter((r) => r.won).length;
  const jsonl = toJsonLines(records);

  const update = (next: HumanGameRecord[]) => {
    setRecords(next);
    saveHumanRecords(subject, next);
  };
  const setSubject = (next: SubjectId) => {
    const loaded = loadHumanRecords(next);
    setSubjectState(next);
    saveSubject(next);
    setRecords(loaded);
    setChoice(nextMatch(next, loaded));
  };
  const script = subject === "rhino" ? "rhino-compare" : `${subject}-compare`;
  const fileBase = `${subject}-human`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(jsonl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div class="panel human-compare">
      <p>
        <code>npm run {script}</code> と同じシードの試合を、あなたが{me}で打ちます。相手は探索 AI です。
        同じ（相手デッキ・試合番号・席）なら、AI が打ったときと同じ初期局面（先攻・山札の順番・初手）から始まります。
        試合番号 g は、まだ打っていない番号に毎回自動で変わります（相手デッキが違っても、g と席が同じなら自分の初手は同じになるため）。
      </p>
      <div class="setup">
        <label>
          あなたのデッキ
          <select value={subject} onChange={(e) => isSubjectId(e.currentTarget.value) && setSubject(e.currentTarget.value)}>
            {SUBJECT_IDS.map((id) => (
              <option key={id} value={id}>
                {SUBJECTS[id].deck}
              </option>
            ))}
          </select>
        </label>
        <label>
          相手デッキ
          <select value={choice.deck} onChange={(e) => setChoice({ ...choice, deck: e.currentTarget.value })}>
            {decks.map((d) => (
              <option key={d.key} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          試合番号 g
          <input
            type="number"
            min={0}
            step={1}
            value={choice.g}
            onInput={(e) => {
              const g = Math.floor(Number(e.currentTarget.value));
              if (Number.isFinite(g) && g >= 0) setChoice({ ...choice, g });
            }}
          />
        </label>
        <label>
          あなたの席
          <select value={choice.seat} onChange={(e) => setChoice({ ...choice, seat: Number(e.currentTarget.value) as PlayerIndex })}>
            <option value={0}>P1</option>
            <option value={1}>P2</option>
          </select>
        </label>
        <p class="muted">
          seed {seed} / あなたは{first ? "先攻" : "後攻"}
          {played > 0 && ` / この試合は ${played} 回打っています`}
        </p>
        <div class="row-buttons">
          <button type="button" onClick={() => setChoice(nextMatch(subject, records))}>
            次の試合（新しい g）を選ぶ
          </button>
          <button type="button" class="primary" onClick={() => onStart(choice)}>
            対戦開始
          </button>
        </div>
      </div>
      {saveError && <p class="problems">{saveError}</p>}

      <h3>
        {me}で打った試合 {records.length} 件（勝ち {wins}
        {records.length > 0 && ` = ${((wins / records.length) * 100).toFixed(1)}%`}）
      </h3>
      {records.length > 0 && (
        <>
          <div class="row-buttons">
            <button type="button" onClick={() => download(`${fileBase}.jsonl`, jsonl, "application/x-ndjson")}>
              全部を JSON Lines で保存
            </button>
            <button type="button" onClick={copy}>
              {copied ? "コピーしました" : "全部をコピー"}
            </button>
          </div>
          <p class="muted">
            1 行 1 試合です。<code>npm run {script} -- --matches {fileBase}.jsonl</code> で、同じ試合を AI に打たせて勝敗を並べられます。
          </p>
          <table class="human-records">
            <thead>
              <tr>
                <th>相手</th>
                <th>g</th>
                <th>席</th>
                <th>先後</th>
                <th>勝敗</th>
                <th>ターン</th>
                <th>日時</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...records].reverse().map((r) => (
                <RecordRow
                  key={r.playedAt + matchKey(r)}
                  record={r}
                  onDelete={() => {
                    if (confirm("この記録を削除しますか？")) update(records.filter((x) => x !== r));
                  }}
                />
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function RecordRow({ record: r, onDelete }: { record: HumanGameRecord; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const date = new Date(r.playedAt);
  return (
    <>
      <tr>
        <td>{r.deck}</td>
        <td>{r.g}</td>
        <td>{seatLabel(r.seat)}</td>
        <td>{r.first ? "先攻" : "後攻"}</td>
        <td>{r.won ? "勝ち" : "負け"}</td>
        <td>{r.turns}</td>
        <td>{Number.isNaN(date.getTime()) ? "" : date.toLocaleString("ja-JP")}</td>
        <td class="row-buttons">
          <button type="button" onClick={() => setOpen(!open)}>
            {open ? "閉じる" : "選択の列"}
          </button>
          <button type="button" onClick={() => download(`${r.subject}-human-${r.deck}-g${r.g}-${seatLabel(r.seat)}.json`, JSON.stringify(r, null, 2), "application/json")}>
            保存
          </button>
          <button type="button" onClick={onDelete}>
            削除
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8}>
            <ol class="turn-log">
              {r.turnLog.map((t, i) => (
                <li key={i} class={t.by === "you" ? "" : "muted"}>
                  {t.turn === 0 ? "マリガン" : `ターン ${t.turn}`}（{t.by === "you" ? "あなた" : "相手"}）: {t.choices.map((c) => c.replace(/^(あなた|相手): /, "")).join(" → ")}
                </li>
              ))}
            </ol>
          </td>
        </tr>
      )}
    </>
  );
}
