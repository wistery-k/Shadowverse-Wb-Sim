// npm run misses-lines の本体: 見落とし問題集の問のうち、候補の打ち比べ調査（docs/survey.md）から足した問に、
// 調査で打ち比べた 2 つの並び（AI の選んだ候補と、二段目で比べた候補）を書き添える（<問のフォルダ>/lines/<問>.json）。
// 問題集のページ（src/ui/Misses.tsx）が盤面の下に並べ、1 手ずつ進めて見せるのに使う。
// 問のファイルには書かない（問題集の指紋 set_fingerprint は問のファイルの中身全部から作るので、足すと変わる）。
//
// 使い方: npm run misses-lines -- <調査の出力.jsonl(.gz)>… [--dir misses/azvaldt] [--decks @<デッキの組>] [--force] [--check]
//   問のファイルの origin（"from":"state"、"file":"g<試合>-i<手>.json"）と同じ試合・手の行を探す。
//   --dir は問のフォルダ（既定 misses）。misses/azvaldt なら前期のローテーションのカードを足す。
//   --decks は調査に渡したデッキの組（survey の --decks と同じ。例 @data/pools/azvaldt/sets/rep10.txt）。
//   調査の行のデッキの名前（deck・opp）をその組のデッキに引き当て、両方の席のデッキ（名前と元の 40 枚）を decks に書く
//   （問題集のページが、残りの山札と並べて出す。ユーザーの依頼 2026-11-19）。同じ名前のデッキが大会ごとにあるので、組で決める。
//   既にある lines/<問>.json は書き直さない（--force で書き直す。そのときも、手で書いた並び（"hand" のある並び）は残す）。
//   --check は書かずに、どこまで手に戻せたかだけ出す。
//
// 打ち比べは打ち直さない。調査の行から取るのは:
// - steps: AI がその候補を選んだときに、考え直すまで打つ手（調査が打った手。ドロー・ランダムの手の前まで）
// - full: ビームが読んだ並び（ビームの終局面まで。ターンの終わりまでとは限らない）の説明（文字列だけ。AI から見た決定化の局面のもの）
// - 勝ち負け: 一段目（候補ごとに m 回）と二段目（2 つの候補を confirm.n 回）
// actions は、問の局面に steps を打ち、full の残りを打てる手と文字列で突き合わせて（src/misses/stepText.ts）手に戻したもの。
// その後は、探索 AI（--dir のプールの補正。アズヴォルト環境はページの補正で、今は R5。misses/azvaldt/lines/ は R3 のときに書いた）に問の名前から作った乱数でターンの終わりまで打たせる
// （調査の打ち比べも、steps の後は AI が考え直して打っている）。突き合わせられない文字列が出たとき（引いたカード・ランダムな結果が
// 読みと違う）と、読みを打ちきった後に AI がすぐにはターンを終えなかったとき（full はビームの終局面までで、攻撃などを読まずに
// 終わることがある）は、AI が打った最初の手の番号を rethink に書く。読みを打ちきって AI がすぐターンを終えたら rethink は null。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { agentOf } from "../src/ai/registry";
import type { ClassId } from "../src/cards/types";
import { actingPlayer, applyAction, cardOf, legalActions, tryApplyAction } from "../src/engine/game";
import { rngFrom, seedOf } from "../src/engine/rng";
import type { Action, GameState, PlayerIndex } from "../src/engine/types";
import { selectNets } from "../src/engine/wasm";
import { parseProblem } from "../src/misses/problems";
import { stepText } from "../src/misses/stepText";

/** 調査の行の候補（必要な項目だけ） */
interface Plan {
  steps: Action[];
  text: string[];
  full: string[];
  turnEnd?: number;
}
interface Row {
  g?: number;
  i?: number;
  ai?: number;
  m?: number;
  w?: string[];
  plans?: Plan[];
  confirm?: { c: number; n: number; ai: string; alt: string } | null;
  state?: unknown;
  /** 手番の側の席と、その席・相手の席のデッキの名前 */
  p?: number;
  deck?: string;
  opp?: string;
}

/** 席のデッキ（lines/<問>.json の decks。席の順。src/misses/problems.ts の MissDeck と同じ） */
export interface DeckOut {
  /** デッキの名前（例: ランプD（CR）） */
  name: string;
  /** プロのデッキの ID（<大会>/<チーム>_<クラス>。data/pools/azvaldt/decks/<ID>.txt） */
  id: string;
  /** 元のカード（40 枚。ファイルの行の順） */
  cards: string[];
}

/** 勝ち負けの数 */
export interface Tally {
  wins: number;
  games: number;
}

/** 並び 1 つ（lines/<問>.json の形。src/misses/problems.ts の MissLine と同じ） */
export interface LineOut {
  kind: "ai" | "good";
  label: string;
  /** 局面から打つ手（AI がこの並びを選んだときに、考え直すまで打つ手） */
  steps: Action[];
  /** steps の説明（調査が書いたもの） */
  text: string[];
  /** 調査で読んだ並び（ビームの終局面まで。ターンの終わりまでとは限らない）の説明（AI から見た決定化の局面のもの。途中で引くカードは予想） */
  full: string[];
  /** 問の局面から打つターンの終わりまでの手（steps ＋ full の残りを手に戻したもの ＋ AI が打った続き。最後はターン終了） */
  actions: Action[];
  /** AI が打った最初の手の番号（actions の添字）。full を手に戻しきれず考え直させたか、full を打ちきった後に AI がすぐにはターンを終えなかったとき。どちらでもなければ null */
  rethink: number | null;
  /** 一段目の勝ち（m 回のうち。手で書いた並びは null） */
  first: Tally | null;
  /** 二段目の勝ち（confirm.n 回のうち。手で書いた並びは null） */
  second: Tally | null;
  /** 手で書いた並びの出どころ（例: ユーザーが見つけた手順）。--force で書き直しても残す */
  hand?: string;
}

/** キーの順番によらない文字列（局面が同じかを見る） */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const tally = (s: string): Tally => ({ wins: [...s].filter((c) => c === "1").length, games: s.length });

/** 手番の側のターンが終わったか（相手の手番になったか、勝負がついた） */
const turnOver = (s: GameState, p: PlayerIndex) => s.winner !== null || (s.active !== p && s.pending?.player !== p);

/**
 * full の文字列を、局面で打てる手と突き合わせて手に戻す。同じ文字列になる手が複数あれば（同じ名前のカード）、
 * 残りを最後まで戻せる方を選ぶ（戻せなければ最も長く戻せる方）
 */
function matchTexts(start: GameState, texts: readonly string[], viewer: PlayerIndex): { actions: Action[]; end: GameState } {
  let best: { actions: Action[]; end: GameState } = { actions: [], end: start };
  let budget = 20000;
  const go = (s: GameState, k: number, done: Action[]): boolean => {
    if (done.length > best.actions.length) best = { actions: [...done], end: s };
    if (k === texts.length) return true;
    if (--budget < 0) return false;
    for (const a of legalActions(s)) {
      if (stepText(s, a, viewer) !== texts[k]) continue;
      const next = tryApplyAction(s, a);
      if (!next) continue;
      done.push(a);
      if (go(next, k + 1, done)) return true;
      done.pop();
    }
    return false;
  };
  go(start, 0, []);
  return best;
}

/** デッキの組のファイル（survey の --decks と同じ。1 行に 1 つのデッキのファイル）を読み、名前 → デッキ（とクラス）にする */
async function readDeckSet(arg: string): Promise<Map<string, { deck: DeckOut; cls: ClassId }>> {
  const { proDeck } = await import("../src/record/decks");
  const path = arg.replace(/^@/, "");
  const out = new Map<string, { deck: DeckOut; cls: ClassId }>();
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /decks\/([^/]+\/[^/]+)\.txt$/.exec(line);
    const d = m?.[1] ? proDeck(m[1]) : undefined;
    if (!d) throw new Error(`${path}: プロのデッキが読めません: ${line}`);
    if (out.has(d.name)) throw new Error(`${path}: 同じ名前のデッキが 2 つあります: ${d.name}`);
    out.set(d.name, { deck: { name: d.name, id: d.id, cards: [...d.cards] }, cls: d.cls });
  }
  return out;
}

/**
 * 問の局面の席 q が、そのデッキで打っているか: クラスが同じで、山札にデッキのカードがある。
 * 枚数は比べない（歩む《愚者》・リンクルのように、同じカードを山札に足す能力がある）
 */
function checkDeck(state: GameState, q: number, d: DeckOut, cls: ClassId, id: string) {
  const pl = state.players[q]!;
  const own = [...pl.deck, ...pl.hand, ...pl.board].map((c) => cardOf(c.cardId).class).find((c) => c !== "neutral");
  if (own !== undefined && own !== cls) throw new Error(`${id}: 席 ${q} のクラス（${own}）がデッキ「${d.name}」（${cls}）と違います`);
  const known = new Set(d.cards);
  if (pl.deck.length > 0 && !pl.deck.some((c) => known.has(c.cardId))) throw new Error(`${id}: 席 ${q} の山札に、デッキ「${d.name}」のカードが 1 枚もありません`);
}

function format(body: { v: number; id: string; source: string; decks?: [DeckOut, DeckOut]; lines: LineOut[] }): string {
  const list = (xs: readonly unknown[]) => (xs.length === 0 ? "[]" : `[\n${xs.map((x) => `        ${JSON.stringify(x)}`).join(",\n")}\n      ]`);
  const lines = body.lines.map((l) =>
    [
      `    {`,
      `      "kind": ${JSON.stringify(l.kind)},`,
      `      "label": ${JSON.stringify(l.label)},`,
      ...(l.hand === undefined ? [] : [`      "hand": ${JSON.stringify(l.hand)},`]),
      `      "first": ${JSON.stringify(l.first)},`,
      `      "second": ${JSON.stringify(l.second)},`,
      `      "steps": ${list(l.steps)},`,
      `      "text": ${list(l.text)},`,
      `      "full": ${list(l.full)},`,
      `      "rethink": ${JSON.stringify(l.rethink)},`,
      `      "actions": ${list(l.actions)}`,
      `    }`,
    ].join("\n"),
  );
  const decks = body.decks ? `  "decks": [\n${body.decks.map((d) => `    ${JSON.stringify(d)}`).join(",\n")}\n  ],\n` : "";
  return `{\n  "v": ${body.v},\n  "id": ${JSON.stringify(body.id)},\n  "source": ${JSON.stringify(body.source)},\n${decks}  "lines": [\n${lines.join(",\n")}\n  ]\n}\n`;
}

export async function main(argv: string[]): Promise<number> {
  const force = argv.includes("--force");
  const check = argv.includes("--check");
  let dir = "misses";
  let deckArg = "";
  const files: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    if (a === "--dir") dir = argv[++k] ?? "";
    else if (a === "--decks") deckArg = argv[++k] ?? "";
    else if (a !== "--force" && a !== "--check") files.push(a);
  }
  if (files.length === 0 || !dir || argv.includes("--decks") !== (deckArg !== "")) {
    console.error("使い方: npm run misses-lines -- <調査の出力.jsonl(.gz)>… [--dir misses/azvaldt] [--decks @<デッキの組>] [--force] [--check]");
    return 2;
  }
  const MISSES = resolve(dir);
  const OUT = join(MISSES, "lines");
  if (basename(MISSES) === "azvaldt") {
    selectNets("azvaldt");
    await import("../src/record/pool");
  }
  const deckSet = deckArg ? await readDeckSet(deckArg) : null;

  // 調査の局面から足した問: 試合・手 → 問
  const wanted = new Map<string, { id: string; raw: unknown }>();
  for (const f of readdirSync(MISSES).filter((x) => x.endsWith(".json")).sort()) {
    const raw = JSON.parse(readFileSync(join(MISSES, f), "utf8")) as { id: string; origin?: { from?: string; file?: string } };
    const m = raw.origin?.from === "state" ? /^g(\d+)-i(\d+)\.json$/.exec(raw.origin.file ?? "") : null;
    if (m) wanted.set(`${m[1]}/${m[2]}`, { id: raw.id, raw });
  }

  if (!check) mkdirSync(OUT, { recursive: true });
  let written = 0;
  let skipped = 0;
  const found = new Set<string>();
  for (const file of files) {
    const buf = readFileSync(file);
    const text = file.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    // 共有フォルダの中の場所で書く（どのマシンのパスかによらない）
    const shown = file.replace(/^.*?(?=logs\/)/, "");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Row;
      const key = `${row.g}/${row.i}`;
      const want = wanted.get(key);
      if (!want || !row.plans || row.ai === undefined) continue;
      const problem = parseProblem(want.raw);
      if (canonical(row.state) !== canonical(problem.state)) throw new Error(`${want.id}: 調査の行（${shown} の試合 ${row.g} の ${row.i} 手目）の局面が問の局面と違います`);
      if (!row.confirm) throw new Error(`${want.id}: 調査の行に二段目（confirm）がありません`);
      found.add(key);
      const out = join(OUT, `${want.id}.json`);
      if (existsSync(out) && !force && !check) {
        skipped++;
        continue;
      }
      const p = problem.player;
      if (actingPlayer(problem.state) !== p) throw new Error(`${want.id}: 問の局面の手番が問の player と違います`);
      let decks: [DeckOut, DeckOut] | undefined;
      if (deckSet) {
        if (row.p !== undefined && row.p !== p) throw new Error(`${want.id}: 調査の行の席（${row.p}）が問の player と違います`);
        const own = deckSet.get(row.deck ?? "");
        const opp = deckSet.get(row.opp ?? "");
        if (!own || !opp) throw new Error(`${want.id}: 調査の行のデッキ「${row.deck ?? "?"}」「${row.opp ?? "?"}」が ${deckArg} にありません`);
        const seats = p === 0 ? [own, opp] : [opp, own];
        for (const [q, d] of seats.entries()) checkDeck(problem.state, q, d.deck, d.cls, want.id);
        decks = [seats[0]!.deck, seats[1]!.deck];
      }
      const confirm = row.confirm;
      const pick = (k: number, kind: LineOut["kind"], label: string, second: string): LineOut => {
        const plan = row.plans![k];
        if (!plan) throw new Error(`${want.id}: 候補 ${k} がありません`);
        // steps を打つ
        let s = problem.state;
        for (const [j, a] of plan.steps.entries()) {
          const next = tryApplyAction(s, a);
          if (!next) throw new Error(`${want.id}: ${label}の ${j + 1} 手目（${plan.text[j] ?? ""}）が問の局面から打てません`);
          s = next;
        }
        const actions = [...plan.steps];
        const prefixOk = plan.text.every((t, j) => plan.full[j] === t);
        let rethink: number | null = null;
        let missed = "";
        if (!turnOver(s, p)) {
          const rest = prefixOk ? plan.full.slice(plan.steps.length) : [];
          const m = matchTexts(s, rest, p);
          actions.push(...m.actions);
          s = m.end;
          // 読んだ並びを打ちきったか（full はビームの終局面までの並びで、ターンの終わりまでとは限らない。
          // 攻撃を読まずに終わることがある。2026-11-19 にユーザーの指摘で分かった）
          const done = prefixOk && m.actions.length === rest.length;
          if (!done) missed = prefixOk ? (rest[m.actions.length] ?? "") : (plan.full[plan.steps.length] ?? "");
          // そこから先は、問の AI にターンの終わりまで打たせる（調査の打ち比べも、steps の後は AI が考え直して打つ）
          const from = actions.length;
          const rng = rngFrom({ rng: seedOf([fnv(want.id), kind === "ai" ? 0 : 1]) });
          const agent = agentOf(problem.agent);
          for (let n = 0; !turnOver(s, p); n++) {
            if (n >= 60) throw new Error(`${want.id}: ${label}を AI に打たせると、60 手打ってもターンが終わりません`);
            const a = agent.chooseAction(s, legalActions(s), rng);
            actions.push(a);
            s = applyAction(s, a);
          }
          // 読みを打ちきって AI がすぐターンを終えたら、読みのとおり（考え直した手は無い）
          const ended = actions.length === from + 1 && actions[from]!.type === "endTurn";
          if (!done || !ended) rethink = from;
        }
        const w = row.w?.[k] ?? "";
        console.log(
          `${want.id} ${kind}: steps ${plan.steps.length}、full ${plan.full.length} → 手 ${actions.length}${
            rethink === null ? "" : missed ? `（${rethink + 1} 手目から考え直した。読みの「${missed}」が打てない）` : `（読みの後、${rethink + 1} 手目から AI が続きを打った）`
          }`,
        );
        return { kind, label, steps: plan.steps, text: plan.text, full: plan.full, actions, rethink, first: tally(w), second: tally(second) };
      };
      const body = {
        v: 2,
        id: want.id,
        source: `${shown} の試合 ${row.g} の ${row.i} 手目`,
        ...(decks ? { decks } : {}),
        lines: [pick(row.ai, "ai", "問を作ったときの AI の手", confirm.ai), pick(confirm.c, "good", "打ち比べで良い手", confirm.alt)],
      };
      // 手で書いた並び（hand）は残す（同じ種類の並びを置き換えている）
      if (existsSync(out)) {
        const old = JSON.parse(readFileSync(out, "utf8")) as { lines?: LineOut[] };
        for (const l of old.lines ?? []) {
          if (typeof l.hand !== "string") continue;
          const k = body.lines.findIndex((x) => x.kind === l.kind);
          if (k < 0) throw new Error(`${want.id}: 手で書いた並び（${l.label}）と同じ種類の並びがありません`);
          body.lines[k] = l;
          console.log(`${want.id} ${l.kind}: 手で書いた並び「${l.label}」を残した（${l.hand}）`);
        }
      }
      if (check) continue;
      writeFileSync(out, format(body));
      written++;
    }
  }
  const missing = [...wanted].filter(([k]) => !found.has(k)).map(([, v]) => v.id);
  if (!check) console.log(`書いた ${written}、既にあるので飛ばした ${skipped}（--force で書き直す）`);
  if (missing.length > 0) console.log(`調査の行が見つからない問 ${missing.length}: ${missing.join(", ")}`);
  return 0;
}
