// TypeScript 版と Rust 版（rust/）のエンジンが同じ結果になるかの差分テストと、速さの比較（npm run rust-diff）。
//
//   npm run rust-diff -- expect --games 2000 [--start 0] [--random-decks] --out expected.txt
//     ランダムな手（行動の選び方は Rust 版と同じ LCG）で対戦し、各手番の「局面＋合法手の一覧」の正規化した文字列の
//     ハッシュ（FNV-1a）を 1 試合 1 行で書き出す。Rust 版の `svwb diff expected.txt` が同じ対戦を打って突き合わせる
//     --random-decks: デフォルトデッキの代わりに、クラスのカードからランダムに組んだデッキで打つ（全カードの能力を試すため）。
//     書き出すファイルの先頭行に印を付け、Rust 版も同じ組み方をする
//   npm run rust-diff -- dump --game 12 --step 34
//     その試合のその手番の正規化した文字列を表示する（食い違ったときに Rust 版の出力と見比べる）
//   npm run rust-diff -- bench --games 2000
//     速さの計測。Rust 版の `svwb bench` と同じ 2 つを測る
//       random: ランダムな手で対戦を最後まで打つ（合法手の列挙＋適用）
//       expand: 上の対戦の各局面で、合法手をすべて試し打ちする（探索 AI の内側のループに近い。複製＋適用）
//
// 対戦の組み方・正規化した文字列の形は rust/engine/src/canonical.rs と同じにすること。

import { writeFileSync } from "node:fs";
import { ALL_CARDS } from "../src/cards";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import {
  applyAction,
  createGame,
  legalActions,
  resolveTurnEnd,
  tryApplyAction,
  type Action,
  type GameState,
  type HandCard,
  type OnBoard,
  type PlayerState,
} from "../src/engine";

const MAX_STEPS = 5000;

const CLASSES = ["elf", "royal", "witch", "dragon", "nightmare", "bishop", "nemesis"] as const;

/** ランダムなデッキ（クラスとニュートラルのトークン以外のカードから 40 枚。デフォルトデッキに無いカードも試すため） */
function randomDeck(g: number, i: number): string[] {
  const cls = CLASSES[(g + i * 3) % CLASSES.length]!;
  const pool = ALL_CARDS.filter((c) => c.set !== "token" && (c.class === cls || c.class === "neutral"));
  const pick = chooser(Math.imul(g * 2 + i + 1, 40503) >>> 0);
  return Array.from({ length: 40 }, () => pool[pick(pool.length)]!.id);
}

/** 試合 g の組み合わせとシード（randomDecks ならランダムなデッキ） */
export function gameSetup(g: number): { decks: [string[], string[]]; seed: number } {
  const seed = Math.imul(g + 1, 2654435761) >>> 0;
  if (randomDecks) return { decks: [randomDeck(g, 0), randomDeck(g, 1)], seed };
  const n = DEFAULT_DECKS.length;
  const d0 = DEFAULT_DECKS[g % n]!.cards;
  const d1 = DEFAULT_DECKS[Math.floor(g / n) % n]!.cards;
  return { decks: [d0, d1], seed };
}

let randomDecks = false;

/** 行動の選び方（LCG） */
function chooser(seed: number): (len: number) => number {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  return (len) => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return (x >>> 8) % len;
  };
}

const b = (v: boolean) => (v ? "1" : "0");
const opt = (v: number | string | null | undefined) => (v === null || v === undefined ? "-" : String(v));
const kws = (k: readonly string[]) => [...k].sort().join("+");
const once = (r: Record<string, number>) =>
  Object.keys(r)
    .sort()
    .map((k) => `${k}=${r[k]}`)
    .join("+");

function handCanon(h: HandCard): string {
  const d = h.drawnBy;
  const drawn = d
    ? `${d.type ?? ""}/${d.tribe ?? ""}/${d.class ?? ""}/${d.ids?.join("+") ?? ""}/${d.costMax ?? ""}/${d.costEq ?? ""}`
    : "-";
  return [h.iid, h.cardId, h.costMod, h.attackMod, h.defenseMod, h.boosts, opt(h.x), kws(h.keywords), h.fusedKinds.join("+"), b(h.fusedThisTurn), b(h.revealed), drawn].join(":");
}

function boardCanon(c: OnBoard): string {
  const head = [c.iid, c.cardId, c.kind === "follower" ? "f" : "a", kws(c.keywords), kws(c.tempKeywords), c.granted.length, c.order];
  const rest =
    c.kind === "follower"
      ? [c.attack, c.defense, c.maxDefense, c.tempAttack, c.maxAttacks, c.attacksThisTurn, c.enteredTurn, c.evolve, opt(c.cannotAttackUntil), opt(c.x), once(c.usedOncePerTurn)]
      : [opt(c.countdown), opt(c.sigils), b(c.actedThisTurn)];
  return [...head, ...rest].join(":");
}

function playerCanon(p: PlayerState): string {
  const head = [p.leaderHp, p.leaderMaxHp, p.maxPp, p.pp, p.ep, p.sep, b(p.extraPpAvailable), p.turnCount, p.graveyard, p.combo, b(p.evolvedThisTurn), opt(p.epEvolvedThisTurn), opt(p.sepEvolvedThisTurn), b(p.mulliganDone)].join(",");
  return [
    head,
    "D" + p.deck.map((r) => `${r.iid}:${r.cardId}`).join(","),
    "H" + p.hand.map(handCanon).join(","),
    "B" + p.board.map(boardCanon).join(","),
    "C" + p.crests.map((c) => [c.iid, c.crestId, opt(c.countdown), c.order, once(c.usedOncePerTurn)].join(":")).join(","),
    "G" + p.graveyardFollowers.join(","),
    "A" + p.destroyedAmulets.join(","),
    "T" + p.destroyedThisTurn.map((r) => `${r.cardId}:${r.attack}:${r.defense}`).join(","),
  ].join(";");
}

export function stateCanon(s: GameState): string {
  const pd = s.pending;
  const pending = !pd ? "-" : pd.kind === "choose" ? `choose:${pd.player}:${pd.slot}:${pd.candidates.join("+")}:${pd.count}` : `mode:${pd.player}:${pd.options}`;
  const at = s.attack;
  const attack = at ? `${at.attacker}:${at.defender}:${b(at.superEvolved)}:${b(at.defenderDestroyed)}` : "-";
  return [
    s.phase,
    s.first,
    s.active,
    s.turn,
    opt(s.winner),
    s.rng,
    s.nextIid,
    s.nextOrder,
    pending,
    attack,
    "S" + s.stack.map((f) => `${f.effects.length}:${f.pc}`).join(","),
    "Q" + s.queue.length,
    "P0 " + playerCanon(s.players[0]),
    "P1 " + playerCanon(s.players[1]),
  ].join("|");
}

export function actionCanon(a: Action): string {
  switch (a.type) {
    case "mulligan":
      return `mulligan:${a.player}:${a.swap.join("+")}`;
    case "play":
    case "evolve":
    case "superEvolve":
    case "act":
      return `${a.type}:${a.iid}`;
    case "attack":
      return `attack:${a.attacker}:${a.target === "leader" ? "L" : a.target}`;
    case "fuse":
      return `fuse:${a.host}:${a.materials.join("+")}`;
    case "choose":
      return `choose:${a.targets.join("+")}`;
    case "mode":
      return `mode:${a.index}`;
    case "extraPp":
    case "endTurn":
      return a.type;
  }
}

/** FNV-1a（32 ビット、UTF-8 のバイト列） */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(s, "utf8")) h = Math.imul(h ^ byte, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 試合 g をランダムな手で打ち、各手番で visit を呼ぶ（最後は決着した局面で legal が空） */
function playRandom(g: number, visit: (step: number, state: GameState, legal: Action[]) => void): GameState {
  const { decks, seed } = gameSetup(g);
  const pick = chooser(seed);
  let state = createGame({ decks, seed });
  for (let step = 0; ; step++) {
    const legal = state.phase === "ended" || step >= MAX_STEPS ? [] : legalActions(state);
    visit(step, state, legal);
    if (legal.length === 0) return state;
    state = applyAction(state, legal[pick(legal.length)]!);
  }
}

/** 手番の局面・合法手の一覧・ターン終了時の処理だけを行った局面（AI が使う resolveTurnEnd） */
function stepCanon(state: GameState, legal: Action[]): string {
  const end = resolveTurnEnd(state);
  return stateCanon(state) + "#" + legal.map(actionCanon).join(",") + "#" + (end === state ? "-" : stateCanon(end));
}

function flag(argv: string[], name: string, def: number): number {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : def;
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const games = flag(argv, "games", 1000);
  const start = flag(argv, "start", 0);
  randomDecks = argv.includes("--random-decks");
  if (cmd === "expect") {
    const i = argv.indexOf("--out");
    const out = i >= 0 ? argv[i + 1]! : "expected.txt";
    const lines: string[] = [];
    for (let g = start; g < start + games; g++) {
      const hashes: string[] = [];
      playRandom(g, (_, state, legal) => hashes.push(fnv(stepCanon(state, legal))));
      lines.push(`${g} ${hashes.join(" ")}`);
    }
    writeFileSync(out, (randomDecks ? "random-decks\n" : "") + lines.join("\n") + "\n");
    console.log(`${games} 試合（${lines.reduce((n, l) => n + l.split(" ").length - 1, 0)} 手番）を ${out} に書き出しました`);
    return 0;
  }
  if (cmd === "dump") {
    const g = flag(argv, "game", 0);
    const k = flag(argv, "step", 0);
    playRandom(g, (step, state, legal) => {
      if (step === k) console.log(stepCanon(state, legal));
    });
    return 0;
  }
  if (cmd === "bench") {
    let actions = 0;
    const t0 = performance.now();
    for (let g = start; g < start + games; g++) playRandom(g, (_, __, legal) => (actions += legal.length > 0 ? 1 : 0));
    const t1 = performance.now();
    console.log(`random: ${games} 試合 ${(t1 - t0).toFixed(0)}ms、1 試合 ${((t1 - t0) / games).toFixed(3)}ms、1 手 ${((1000 * (t1 - t0)) / actions).toFixed(2)}µs（${actions} 手）`);
    // 試し打ちの対象の局面を先に集めておき、試し打ちの時間だけを測る
    const states: GameState[] = [];
    for (let g = start; g < start + games; g++) playRandom(g, (_, state, legal) => legal.length > 0 && states.push(state));
    let tried = 0;
    let sink = 0;
    const t2 = performance.now();
    for (const s of states) {
      for (const a of legalActions(s)) {
        const next = tryApplyAction(s, a);
        if (next) sink += next.players[0].leaderHp;
        tried++;
      }
    }
    const t3 = performance.now();
    console.log(`expand: ${states.length} 局面・${tried} 手 ${(t3 - t2).toFixed(0)}ms、1 手 ${((1000 * (t3 - t2)) / tried).toFixed(2)}µs（${sink % 10}）`);
    return 0;
  }
  console.error("使い方: npm run rust-diff -- expect|dump|bench ...");
  return 2;
}
