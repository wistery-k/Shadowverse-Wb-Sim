// リノセウスエルフ専用のリーサル探索（考え方はユーザー案。docs/ai-notes.md 参照）。
//
// ターンを「準備」と「仕上げ」に分ける。
// - 準備: リノセウスのプレイと顔への攻撃以外の手をビームサーチで並べる。森の神秘は手札にあれば即打つ
// - 仕上げ: リノセウスを出す最後の数手は決まった形のどれか（下の FINISHERS）。各形を実際に打ち、
//   最後に殴れるフォロワー全員で顔を殴る
// 準備の局面は「そこから仕上げで最大何点出せるか」で並べる。相手リーダーの体力は見ない
// （体力だけが違う局面は1つにまとめる）。現在のエルフのカードには、相手の体力でリーサルの可否が変わるものは無い。

import { applyAction, cardOf, legalActions, type Action, type GameState, type PlayerIndex } from "../engine";

const RHINO = "殺戮のリノセウス";
const ROD = "聖樹の杖";
const ROCK = "燐光の岩";
const MYSTERY = "森の神秘";
const BUGS = "虫の知らせ";
const CARBUNCLE = "ベビーカーバンクル";

export interface RhinoLethalOptions {
  beamWidth: number;
  /** 準備の手の数の上限 */
  maxDepth: number;
}

export const DEFAULT_RHINO_LETHAL_OPTIONS: RhinoLethalOptions = { beamWidth: 16, maxDepth: 10 };

const nameOf = (cardId: string) => cardOf(cardId).name;

/** 手を順に打つ途中の局面と、打った手 */
interface Line {
  state: GameState;
  seq: Action[];
}

function step(line: Line | null, action: Action | null): Line | null {
  if (!line || !action) return null;
  if (line.state.phase === "ended") return line;
  try {
    return { state: applyAction(line.state, action), seq: [...line.seq, action] };
  } catch {
    return null;
  }
}

function handIid(s: GameState, p: PlayerIndex, name: string): number | null {
  return s.players[p].hand.find((h) => nameOf(h.cardId) === name)?.iid ?? null;
}

function boardIids(s: GameState, p: PlayerIndex, name: string): number[] {
  return s.players[p].board.filter((c) => nameOf(c.cardId) === name).map((c) => c.iid);
}

const play = (iid: number | null): Action | null => (iid === null ? null : { type: "play", iid });

/** 選択待ちなら target を選ぶ（選択待ちでなければそのまま） */
function chooseTarget(line: Line | null, target: number): Line | null {
  if (!line || !line.state.pending) return line;
  return step(line, { type: "choose", targets: [target] });
}

/** 手札のリノセウスを出す。出したリノセウスの iid も返す */
function playRhino(line: Line | null, p: PlayerIndex): { line: Line; rhino: number } | null {
  if (!line) return null;
  const iid = handIid(line.state, p, RHINO);
  const next = step(line, play(iid));
  return next && iid !== null ? { line: next, rhino: iid } : null;
}

/** 進化させる（kind の順に、できるものを1つ） */
function evolve(line: Line, iid: number, kinds: readonly ("superEvolve" | "evolve")[]): Line {
  for (const type of kinds) {
    const next = step(line, { type, iid });
    if (next) return next;
  }
  return line;
}

/** 顔を殴る */
const faceAttack = (line: Line | null, iid: number) => step(line, { type: "attack", attacker: iid, target: "leader" });

/** 場の燐光の岩をすべて target にアクトする（+1/+1） */
function rocksOn(line: Line, p: PlayerIndex, target: number): Line {
  let cur = line;
  for (const rock of boardIids(cur.state, p, ROCK)) {
    const next = chooseTarget(step(cur, { type: "act", iid: rock }), target);
    if (next) cur = next;
  }
  return cur;
}

/** 殴れるフォロワー全員で顔を殴る */
function allFace(line: Line, p: PlayerIndex): Line {
  let cur = line;
  for (const c of [...cur.state.players[p].board]) {
    if (c.kind !== "follower") continue;
    for (let i = 0; i < c.maxAttacks && cur.state.phase !== "ended"; i++) {
      const next = faceAttack(cur, c.iid);
      if (!next) break;
      cur = next;
    }
  }
  return cur;
}

/** 最後のリノセウス: 超進化（無ければ進化）し、燐光の岩をアクトして、全員で顔を殴る */
function lastRhino(line: Line | null, p: PlayerIndex, kinds: readonly ("superEvolve" | "evolve")[] = ["superEvolve", "evolve"]): Line | null {
  const r = playRhino(line, p);
  if (!r) return null;
  return allFace(rocksOn(evolve(r.line, r.rhino, kinds), p, r.rhino), p);
}

/** 1体目のリノセウスを出して殴る（firstEvolve なら進化させてから） */
function firstRhino(line: Line, p: PlayerIndex, firstEvolve: boolean): { line: Line; rhino: number } | null {
  const r = playRhino(line, p);
  if (!r) return null;
  const evolved = firstEvolve ? step(r.line, { type: "evolve", iid: r.rhino }) : r.line;
  const hit = faceAttack(evolved, r.rhino);
  return hit ? { line: hit, rhino: r.rhino } : null;
}

/** 仕上げの形。準備の局面から、リノセウスを出して殴り切るまでの手 */
const FINISHERS: ((start: Line, p: PlayerIndex) => Line | null)[] = [
  // リノセウス1回
  (start, p) => lastRhino(start, p),
  // リノセウス2回（1体目は進化なし・進化ありの両方を試す）
  ...[false, true].flatMap((firstEvolve) => [
    // リノ → 杖のアクトで戻す → リノ（6pp）
    (start: Line, p: PlayerIndex) => {
      const r = firstRhino(start, p, firstEvolve);
      const rod = r ? boardIids(r.line.state, p, ROD)[0] : undefined;
      if (!r || rod === undefined) return null;
      return lastRhino(chooseTarget(step(r.line, { type: "act", iid: rod }), r.rhino), p);
    },
    // リノ → リノ（6pp）
    (start: Line, p: PlayerIndex) => {
      const r = firstRhino(start, p, firstEvolve);
      return r ? lastRhino(r.line, p) : null;
    },
    // リノ → 虫の知らせで戻す → リノ（7pp）
    (start: Line, p: PlayerIndex) => {
      const r = firstRhino(start, p, firstEvolve);
      if (!r) return null;
      return lastRhino(chooseTarget(step(r.line, play(handIid(r.line.state, p, BUGS))), r.rhino), p);
    },
    // リノ → ベビーカーバンクルで戻して超進化（PP 3 回復）→ リノ（差し引き 5pp）
    (start: Line, p: PlayerIndex) => {
      const r = firstRhino(start, p, firstEvolve);
      if (!r) return null;
      const carbuncle = handIid(r.line.state, p, CARBUNCLE);
      const back = chooseTarget(step(r.line, play(carbuncle)), r.rhino);
      const recovered = carbuncle === null ? null : step(back, { type: "superEvolve", iid: carbuncle });
      return lastRhino(recovered, p, ["evolve"]);
    },
  ]),
];

/** 仕上げで与えられる最大のダメージ（勝てば Infinity）と、その手 */
function bestFinish(start: Line, p: PlayerIndex, rootOppHp: number): { damage: number; line: Line | null } {
  const opp = p === 0 ? 1 : 0;
  let best: { damage: number; line: Line | null } = { damage: rootOppHp - start.state.players[opp].leaderHp, line: null };
  for (const finisher of FINISHERS) {
    const end = finisher(start, p);
    if (!end) continue;
    const won = end.state.phase === "ended" && end.state.winner === p;
    const damage = won ? Infinity : rootOppHp - end.state.players[opp].leaderHp;
    if (damage > best.damage) best = { damage, line: end };
    if (won) break;
  }
  return best;
}

/** 準備の手（リノセウスのプレイと顔への攻撃を除く。森の神秘は手札にあればそれだけ） */
function setupActions(s: GameState, p: PlayerIndex): Action[] {
  const legal = legalActions(s);
  if (s.pending) return legal;
  const mystery = handIid(s, p, MYSTERY);
  const mysteryPlay = legal.find((a) => a.type === "play" && a.iid === mystery);
  if (mysteryPlay) return [mysteryPlay];
  return legal.filter((a) => {
    if (a.type === "endTurn") return false;
    if (a.type === "attack" && a.target === "leader") return false;
    if (a.type === "play") return nameOf(s.players[p].hand.find((h) => h.iid === a.iid)?.cardId ?? "") !== RHINO;
    return true;
  });
}

/** 局面の同一判定用のキー（相手リーダーの体力・山札の中身・乱数の状態を除く） */
function setupKey(s: GameState): string {
  return JSON.stringify([
    s.players.map((pl) => [pl.pp, pl.combo, pl.ep, pl.sep, pl.extraPpAvailable, pl.hand, pl.board, pl.crests]),
    s.pending,
    s.stack,
  ]);
}

/**
 * リノセウスで殴り切る手順を探す。見つかれば手順全体、見つからなければ null。
 * 手札にリノセウスが無ければ探さない
 */
export function searchRhinoLethal(root: GameState, p: PlayerIndex, opts: RhinoLethalOptions = DEFAULT_RHINO_LETHAL_OPTIONS): Action[] | null {
  if (root.phase !== "main" || root.active !== p || handIid(root, p, RHINO) === null) return null;
  const rootOppHp = root.players[p === 0 ? 1 : 0].leaderHp;
  let frontier: { line: Line; damage: number }[] = [];
  const rootLine: Line = { state: root, seq: [] };
  const rootFinish = bestFinish(rootLine, p, rootOppHp);
  if (rootFinish.damage === Infinity) return rootFinish.line!.seq;
  frontier.push({ line: rootLine, damage: rootFinish.damage });

  for (let depth = 0; depth < opts.maxDepth && frontier.length > 0; depth++) {
    const children: { line: Line; damage: number }[] = [];
    const seen = new Set<string>();
    for (const node of frontier) {
      const s = node.line.state;
      const actor = s.pending ? s.pending.player : s.active;
      if (s.phase === "ended" || actor !== p) continue;
      for (const a of setupActions(s, p)) {
        const next = step(node.line, a);
        if (!next || next.state.phase === "ended") continue;
        const key = setupKey(next.state);
        if (seen.has(key)) continue;
        seen.add(key);
        // 選択待ちの途中では仕上げに入れないので、点数は親から引き継ぐ
        if (next.state.pending) {
          children.push({ line: next, damage: node.damage });
          continue;
        }
        const finish = bestFinish(next, p, rootOppHp);
        if (finish.damage === Infinity) return finish.line!.seq;
        children.push({ line: next, damage: finish.damage });
      }
    }
    children.sort((x, y) => y.damage - x.damage);
    frontier = children.slice(0, opts.beamWidth);
  }
  return null;
}
