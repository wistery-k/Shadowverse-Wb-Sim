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
// 3. どちらから攻撃しても結果が同じ: A・B に攻撃時・交戦時・ラストワード・ターン開始時/終了時等の能力がない。
//    ターンの終わりで切れる能力値・キーワードがない。B が超進化していない（相手のターン中はダメージを受けないため）。
//    場（両者）とクレストに、フォロワーの破壊・回復で誘発する能力や、ターン開始時/終了時（カウントダウンで消えるときを含む）に
//    場のカードに関わる能力がない
// 4. A・B にラストワードがない（3 に含む）
//
// 攻撃した側だけに効くもの（ドレイン、超進化の被ダメージ 0・ぶっとばし）は、自分から攻撃した方が得なので許す。

import {
  applyAction,
  boardAbilities,
  crestsAndBoard,
  legalActions,
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
]);

const isFollower = (c: { kind: string }): c is FollowerOnBoard => c.kind === "follower";

/** 場のカードに関わる（対象にする・数える・場に出す）能力か */
const touchesBoard = (a: Ability) => {
  const s = JSON.stringify(a.effects);
  return s.includes('"kind":"board"') || s.includes('"op":"summon');
};

/** 場とクレストに、どちらのターンに倒れたかで結果が変わりうる能力がある */
function hasTimingSensitiveAbility(state: GameState): boolean {
  for (const p of [0, 1] as const) {
    for (const entry of crestsAndBoard(state, p)) {
      const countdown = entry.kind === "crest" ? entry.crest.countdown : entry.card.kind === "amulet" ? entry.card.countdown : null;
      for (const a of entry.abilities) {
        const on = a.trigger.on;
        if (on === "allyDestroyed" || on === "leaderHealed") return true;
        if ((on === "turnStart" || on === "turnEnd") && touchesBoard(a)) return true;
        // カウントダウンで消えるときのラストワード（ターン開始時に起きる）
        if (on === "lastWords" && countdown !== null && touchesBoard(a)) return true;
      }
    }
  }
  return false;
}

function symmetricFollower(f: FollowerOnBoard): boolean {
  if (f.tempAttack !== 0 || f.tempKeywords.length > 0) return false;
  return boardAbilities(f).every((a) => HARMLESS_OWN.has(a.trigger.on));
}

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
  if (state.phase === "ended" || state.active !== p || state.pending) return [];
  const attacks = legalActions(state).filter((a): a is Extract<Action, { type: "attack" }> => a.type === "attack" && a.target !== "leader");
  if (attacks.length === 0 || hasTimingSensitiveAbility(state)) return [];
  const me = state.players[p];
  const opp = state.players[opponent(p)];
  const out: Action[] = [];
  for (const action of attacks) {
    const a = me.board.find((c) => c.iid === action.attacker);
    const b = opp.board.find((c) => c.iid === action.target);
    if (!a || !b || !isFollower(a) || !isFollower(b)) continue;
    if (b.evolve === "superEvolved") continue;
    if (!symmetricFollower(a) || !symmetricFollower(b)) continue;
    if (!canBeAttackedBack(state, p, a, b)) continue;
    let after: GameState;
    try {
      after = applyAction(state, action);
    } catch {
      continue;
    }
    if (after.pending || after.phase === "ended") continue;
    if (after.players[opponent(p)].board.some((c) => c.iid === b.iid)) continue;
    out.push(action);
  }
  return out;
}

/** 合流する攻撃を、無くなるまで打った局面（無ければ元の局面） */
export function settleConvergingTrades(state: GameState, p: PlayerIndex): GameState {
  let s = state;
  for (let guard = 0; guard < 7; guard++) {
    const a = convergingAttacks(s, p)[0];
    if (!a) break;
    s = applyAction(s, a);
  }
  return s;
}
