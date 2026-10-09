// 合流する相打ちの検出（ユーザー案。docs/ai-notes.md）。
//
// 自分のフォロワー A で相手のフォロワー B を攻撃して B が倒れるとき、相手も次のターンに B で A を攻撃すれば
// PP を使わずに同じ局面を作れる。そうなら「攻撃しないでターンを終える」は相手に選択肢を1つ増やすだけで、
// 得をするのは相手がミスしたときだけなので、攻撃してから終える方が同等以上。
// 次の条件をすべて満たす攻撃を「合流する攻撃」とする（どちらから攻撃しても同じ局面になる十分条件）。
//
// 1. 今 A で B を攻撃すると B が倒れる（バリア等も含めてエンジンで試す）。A が倒れるかは問わない
// 2. 相手のターンに B が A を攻撃できる: B が攻撃できない状態でない。A が潜伏・威圧を持たない。
//    A が守護でなければ、自分の場に他の守護がいない
// 3. どちらから攻撃しても結果が同じ: A・B に攻撃時・交戦時・ターン開始時/終了時等の能力がない。
//    ターンの終わりで切れる能力値・キーワードがない。B が超進化していない（相手のターン中はダメージを受けないため）。
//    場（両者）とクレストに、フォロワーの破壊・回復で誘発する能力や、ターン開始時/終了時に場のカードに関わる能力がない
// 4. B が場に関わる（対象にする・数える・場に出す）ラストワードを持たない（ユーザー確認済み。A のラストワード、
//    クレストのラストワードは見ない）
//
// 攻撃した側だけに効くもの（ドレイン、超進化の被ダメージ 0・ぶっとばし）は、自分から攻撃した方が得なので許す。

import {
  applyAction,
  attackOf,
  attackTargets,
  boardAbilities,
  crestsAndBoard,
  hasKeyword,
  opponent,
  type Ability,
  type Action,
  type FollowerOnBoard,
  type GameState,
  type PlayerIndex,
} from "../engine";

/** A・B が持っていてよい能力（もう解決済みか、どちらのターンに倒れても同じもの） */
const HARMLESS_OWN = new Set<Ability["trigger"]["on"]>([
  "fanfare",
  "spell",
  "evolve",
  "superEvolve",
  "evolved",
  "enter",
  "act",
  "fused",
  "spellboost",
  "discarded",
  "allyEnter",
  "allyAct",
  "allyFuse",
  "allyLeaveInHand",
  "lastWords",
]);

const isFollower = (c: { kind: string }): c is FollowerOnBoard => c.kind === "follower";

/** 場のカードに関わる（対象にする・数える・場に出す）能力か（能力の定義ごとに覚えておく） */
const touchesBoardCache = new WeakMap<Ability, boolean>();
const touchesBoard = (a: Ability) => {
  let v = touchesBoardCache.get(a);
  if (v === undefined) {
    const s = JSON.stringify(a.effects);
    v = s.includes('"kind":"board"') || s.includes('"op":"summon');
    touchesBoardCache.set(a, v);
  }
  return v;
};

/** 場とクレストに、どちらのターンに倒れたかで結果が変わりうる能力がある */
function hasTimingSensitiveAbility(state: GameState): boolean {
  for (const p of [0, 1] as const) {
    for (const entry of crestsAndBoard(state, p)) {
      for (const a of entry.abilities) {
        const on = a.trigger.on;
        if (on === "allyDestroyed" || on === "leaderHealed") return true;
        if ((on === "turnStart" || on === "turnEnd") && touchesBoard(a)) return true;
      }
    }
  }
  return false;
}

function symmetricFollower(f: FollowerOnBoard): boolean {
  if (f.tempAttack !== 0 || f.tempKeywords.length > 0) return false;
  return boardAbilities(f).every((a) => HARMLESS_OWN.has(a.trigger.on));
}

/** 場に関わるラストワードを持つ（B がこれを持つと、どちらのターンに倒れたかで結果が変わりうる） */
const hasBoardLastWords = (f: FollowerOnBoard) => boardAbilities(f).some((a) => a.trigger.on === "lastWords" && touchesBoard(a));

/** 相手のターンに B が A を攻撃できるか（2） */
function canBeAttackedBack(state: GameState, p: PlayerIndex, a: FollowerOnBoard, b: FollowerOnBoard): boolean {
  if (b.maxAttacks < 1) return false;
  if (b.cannotAttackUntil !== null && b.cannotAttackUntil >= state.turn + 1) return false;
  if (a.keywords.includes("ambush") || a.keywords.includes("intimidate")) return false;
  if (a.keywords.includes("ward")) return true;
  return !state.players[p].board.some(
    (c) => c.iid !== a.iid && isFollower(c) && c.keywords.includes("ward") && !c.keywords.includes("ambush") && !c.keywords.includes("intimidate"),
  );
}

/** プレイヤー p の合流する攻撃（p の手番で、選択待ちでないときのみ） */
export function convergingAttacks(state: GameState, p: PlayerIndex): Action[] {
  return convergingTrades(state, p, false).map((t) => t.action);
}

/** 合流する攻撃と、打った後の局面。探索の全局面で呼ぶので、安い判定から行う。first なら最初の1つだけ探す */
function convergingTrades(state: GameState, p: PlayerIndex, first: boolean): { action: Action; after: GameState }[] {
  if (state.phase === "ended" || state.active !== p || state.pending) return [];
  const me = state.players[p];
  const opp = state.players[opponent(p)];
  const out: { action: Action; after: GameState }[] = [];
  let sensitive: boolean | null = null;
  for (const a of me.board) {
    if (!isFollower(a) || a.attacksThisTurn >= a.maxAttacks || !symmetricFollower(a)) continue;
    for (const b of opp.board) {
      if (!isFollower(b) || b.evolve === "superEvolved") continue;
      // 倒せそうにないもの（実際に倒れるかは後で試す）
      const bane = hasKeyword(a, "bane");
      if (!bane && (attackOf(a) < b.defense || hasKeyword(b, "barrier"))) continue;
      if (!symmetricFollower(b) || hasBoardLastWords(b) || !canBeAttackedBack(state, p, a, b)) continue;
      if (!attackTargets(state, a).includes(b.iid)) continue;
      sensitive ??= hasTimingSensitiveAbility(state);
      if (sensitive) return [];
      const action: Action = { type: "attack", attacker: a.iid, target: b.iid };
      let after: GameState;
      try {
        after = applyAction(state, action);
      } catch {
        continue;
      }
      if (after.pending || after.phase === "ended") continue;
      if (after.players[opponent(p)].board.some((c) => c.iid === b.iid)) continue;
      out.push({ action, after });
      if (first) return out;
    }
  }
  return out;
}

/** 合流する攻撃を、無くなるまで打った局面（無ければ元の局面） */
export function settleConvergingTrades(state: GameState, p: PlayerIndex): GameState {
  let s = state;
  for (let guard = 0; guard < 7; guard++) {
    const t = convergingTrades(s, p, true)[0];
    if (!t) break;
    s = t.after;
  }
  return s;
}
