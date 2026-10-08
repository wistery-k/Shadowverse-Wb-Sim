// 局面（や、局面から取り出したキー）の同一判定を速く行う集合。
//
// 以前は JSON.stringify した文字列を Set に入れていたが、局面ごとに数 KB の文字列を作るのが探索の大きな負担だった。
// ここでは値を文字列にせず、
// 1. 局面の安く区別できる部分から数値のハッシュを作り（stateHash）、
// 2. ハッシュが同じものだけ、値どうしを直接比べる（同じオブジェクトを指していれば中を見ない）。
// 同一とみなす条件は「JSON にしたときに同じ値」（ハッシュは絞り込みにだけ使うので、衝突しても結果は変わらない）。

import type { GameState } from "../engine";

const mix = (h: number, x: number) => Math.imul((h ^ x) >>> 0, 0x01000193) ^ (h >>> 15);

const stringHashes = new Map<string, number>();

/** 文字列のハッシュ（カードID等、種類の少ない文字列向けにキャッシュする） */
function hashString(str: string): number {
  let h = stringHashes.get(str);
  if (h === undefined) {
    h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    if (stringHashes.size < 10000) stringHashes.set(str, h);
  }
  return h;
}

/** stateHash で使う部分（局面の一部だけを取り出したキーには、そのキーに含まれる部分だけを使う） */
export interface HashScope {
  /** リーダーの体力（既定 true） */
  leaderHp?: boolean;
  /** 墓地・このターンに破壊されたカードの記録（既定 true） */
  graveyard?: boolean;
}

/**
 * 局面のハッシュ。安く区別できる部分（リーダーの体力・PP・手札と場のカード・選択待ち等）だけを使う。
 * 同じ値には同じハッシュになればよく（違う値が同じハッシュになっても KeySet が中身を比べる）、
 * 山札の中身・乱数の状態・能力のデータは使わない
 */
export function stateHash(s: GameState, scope: HashScope = {}): number {
  const withHp = scope.leaderHp ?? true;
  const withGraveyard = scope.graveyard ?? true;
  let h = 0x811c9dc5;
  for (const pl of s.players) {
    if (withHp) h = mix(h, pl.leaderHp);
    if (withGraveyard) {
      h = mix(mix(mix(h, pl.graveyard), pl.graveyardFollowers.length), pl.destroyedThisTurn.length);
      for (const id of pl.graveyardFollowers) h = mix(h, hashString(id));
      for (const d of pl.destroyedThisTurn) h = mix(h, hashString(d.cardId));
    }
    h = mix(mix(mix(mix(mix(h, pl.pp), pl.combo), pl.ep), pl.sep), pl.extraPpAvailable ? 1 : 0);
    h = mix(h, pl.hand.length);
    for (const c of pl.hand) h = mix(mix(mix(mix(mix(mix(h, c.iid), c.costMod), c.attackMod), c.defenseMod), c.boosts), c.keywords.length);
    h = mix(h, pl.board.length);
    for (const c of pl.board) {
      h = mix(mix(mix(mix(mix(h, c.iid), c.order), c.keywords.length), c.tempKeywords.length), c.granted.length);
      if (c.kind === "follower") {
        h = mix(mix(mix(mix(mix(mix(h, c.attack), c.defense), c.maxDefense), c.tempAttack), c.attacksThisTurn), c.maxAttacks);
        h = mix(h, c.evolve.length);
      } else h = mix(mix(mix(h, c.countdown ?? -1), c.sigils ?? -1), c.actedThisTurn ? 1 : 0);
    }
    h = mix(h, pl.crests.length);
  }
  const pd = s.pending;
  h = mix(h, pd === null ? 0 : pd.kind === "choose" ? 1 + pd.candidates.length : 100 + pd.options);
  return mix(h, s.stack.length);
}

/** JSON にしたときと同じ扱いの値（undefined・関数・NaN・Infinity は null） */
function normalized(v: unknown): unknown {
  if (v === undefined || typeof v === "function") return null;
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  return v;
}

const present = (x: unknown) => x !== undefined && typeof x !== "function";

/**
 * JSON にしたときに同じ値か（文字列は作らない）。JSON.stringify(a) === JSON.stringify(b) との違いは、
 * オブジェクトのキーの順番を問わないことだけ（同じコードで作った局面どうしなので、順番は普通そろっている）
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return normalized(a) === normalized(b);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const oa = a as Record<string, unknown>;
  const ob = b as Record<string, unknown>;
  let n = 0;
  for (const k in oa) {
    const x = oa[k];
    if (!present(x)) continue;
    const y = ob[k];
    if (!present(y) || !jsonEqual(x, y)) return false;
    n++;
  }
  for (const k in ob) if (present(ob[k])) n--;
  return n === 0;
}

/** JSON にしたときに同じ値を1つにまとめる集合 */
export class KeySet {
  private readonly buckets = new Map<number, unknown[]>();

  /**
   * 同じ値がまだ無ければ加えて true、既にあれば false。
   * hash は値から決まる数（JSON にしたときに同じ値には同じ数）。普通は stateHash を使う
   */
  add(value: unknown, hash: number): boolean {
    const bucket = this.buckets.get(hash);
    if (!bucket) {
      this.buckets.set(hash, [value]);
      return true;
    }
    for (const x of bucket) if (jsonEqual(x, value)) return false;
    bucket.push(value);
    return true;
  }
}
