// 局面（や、局面から取り出したキー）の同一判定を速く行う集合。
//
// 以前は JSON.stringify した文字列を Set に入れていたが、局面ごとに数 KB の文字列を作るのが探索の大きな負担だった。
// ここでは値を文字列にせず、
// 1. 局面の安く区別できる部分から数値のハッシュを作り（stateHash）、
// 2. ハッシュが同じものだけ、値どうしを直接比べる（同じオブジェクトを指していれば中を見ない）。
// 同一とみなす条件は「JSON にしたときに同じ値」（ハッシュは絞り込みにだけ使うので、衝突しても結果は変わらない）。

import type { ClassId } from "../cards";
import type { GameState, PlayerIndex } from "../engine";
import { deckClassOf } from "./weights";

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

/** キーをまだ作っていない印 */
const NOT_YET = Symbol("notYet");

/**
 * 局面等を、キーにしたときに同じものを1つにまとめる集合。KeySet と違い、キーはハッシュが同じものがあるときだけ作る
 * （キーを作るのは重いが、ハッシュで大半が区別できるため）
 */
export class LazyKeySet<T> {
  private readonly buckets = new Map<number, { item: T; key: unknown }[]>();
  constructor(private readonly keyOf: (item: T) => unknown) {}

  /** キーが同じものがまだ無ければ加えて true、既にあれば false。hash はキーから決まる数 */
  add(item: T, hash: number): boolean {
    const bucket = this.buckets.get(hash);
    if (!bucket) {
      this.buckets.set(hash, [{ item, key: NOT_YET }]);
      return true;
    }
    const key = this.keyOf(item);
    for (const e of bucket) {
      if (e.key === NOT_YET) e.key = this.keyOf(e.item);
      if (jsonEqual(e.key, key)) return false;
    }
    bucket.push({ item, key });
    return true;
  }
}

/**
 * カードの iid・場に出た順（order）・スペルブーストの回数（boosts）を除いた中身。
 * boosts は表示用でルールの判定には使わない（スペルブーストの効果はコスト等の変化として別に持つ）ため、
 * 前のターンから手札にあったフェアリーと、このターンに加わったフェアリーを同じにする
 */
export function withoutIds<T extends { iid: number }>(c: T): Omit<T, "iid" | "order" | "boosts"> {
  const { iid: _iid, order: _order, boosts: _boosts, ...rest } = c as T & { order?: number; boosts?: number };
  return rest;
}

/** 同じ局面の判定に墓場等の記録を使うか（その記録を参照するカードを持つクラスだけ） */
const GRAVEYARD_CLASSES: readonly ClassId[] = ["nightmare"]; // ネクロマンス・リアニメイト
const DESTROYED_AMULET_CLASSES: readonly ClassId[] = ["bishop"]; // 大地の守護神・ミーヴェ
const DESTROYED_THIS_TURN_CLASSES: readonly ClassId[] = ["witch"]; // 式神・貴人

/** カードの名前（同じ名前どうしだけ中身を比べて並べる） */
const nameOf = (c: object): string => ("cardId" in c ? String(c.cardId) : "crestId" in c ? String(c.crestId) : "");

/**
 * iid 等を除いたカードを、中身の順に並べる（並び順だけが違うものを同じにする）。
 * 名前で並べ、同じ名前のカードどうしだけ JSON 文字列で比べる（JSON 文字列を作るのは同名があるときだけ）
 */
function sortedWithoutIds<T extends { iid: number }>(cards: readonly T[]): unknown[] {
  const items = cards.map((c) => {
    const v = withoutIds(c);
    return { v, name: nameOf(c), json: "" };
  });
  const json = (x: { v: unknown; json: string }) => x.json || (x.json = JSON.stringify(x.v));
  items.sort((x, y) => {
    if (x.name !== y.name) return x.name < y.name ? -1 : 1;
    const a = json(x), b = json(y);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return items.map((x) => x.v);
}

export interface SearchKeyScope {
  /** リーダーの体力を比べる（既定 true） */
  leaderHp?: boolean;
}

/**
 * 探索 AI・リーサル探索で、同じ局面とみなすためのキー（KeySet で searchHash とあわせて使う）。
 * 結果がほぼ変わらない違いを無視して、ビームの枠を同じような局面で埋めないようにする。
 * - 手の順番の違い: 手札・場・クレストのカードは iid・場に出た順・スペルブーストの回数を除き、中身の順に並べる
 *   （場の並び＝古いもの優先の処理の順が違う局面もまとめるので厳密な同一ではない）
 * - 山札: 中身・枚数は見ず、空かどうかだけ（空で引くと負けるため）
 * - 乱数の状態・次の iid・次の通し番号・先攻: 見ない
 * - 墓場（カウント・リアニメイトの対象）はナイトメア、破壊されたアミュレットはビショップ、
 *   このターンに破壊されたフォロワーはウィッチのプレイヤーだけ見る（それを参照するカードがそのクラスにしかない）
 * 能力の途中（解決スタック・誘発待ち・選択待ち・攻撃の途中）は iid を参照しているので、カードは iid ごとそのまま比べる
 */
export function searchKey(s: GameState, scope: SearchKeyScope = {}): unknown {
  const withHp = scope.leaderHp ?? true;
  const midAbility = s.stack.length > 0 || s.queue.length > 0 || s.pending !== null || s.attack !== null;
  return {
    phase: s.phase,
    turn: s.turn,
    active: s.active,
    winner: s.winner,
    players: s.players.map((pl, i) => {
      const cls = deckClassOf(s, i as PlayerIndex);
      return {
        leaderHp: withHp ? pl.leaderHp : null,
        leaderMaxHp: pl.leaderMaxHp,
        maxPp: pl.maxPp,
        pp: pl.pp,
        ep: pl.ep,
        sep: pl.sep,
        extraPpAvailable: pl.extraPpAvailable,
        turnCount: pl.turnCount,
        deckEmpty: pl.deck.length === 0,
        hand: midAbility ? pl.hand : sortedWithoutIds(pl.hand),
        board: midAbility ? pl.board : sortedWithoutIds(pl.board),
        crests: midAbility ? pl.crests : sortedWithoutIds(pl.crests),
        graveyard: GRAVEYARD_CLASSES.includes(cls) ? [pl.graveyard, pl.graveyardFollowers] : null,
        destroyedAmulets: DESTROYED_AMULET_CLASSES.includes(cls) ? pl.destroyedAmulets : null,
        destroyedThisTurn: DESTROYED_THIS_TURN_CLASSES.includes(cls) ? pl.destroyedThisTurn : null,
        combo: pl.combo,
        evolvedThisTurn: pl.evolvedThisTurn,
        leaderOncePerTurn: pl.leaderOncePerTurn,
        mulliganDone: pl.mulliganDone,
      };
    }),
    ability: midAbility ? [s.stack, s.queue, s.pending, s.attack] : null,
  };
}

/** searchKey 用のハッシュ（手札・場のカードは iid・order を使わず、順番によらない和で混ぜる） */
export function searchHash(s: GameState, scope: SearchKeyScope = {}): number {
  const withHp = scope.leaderHp ?? true;
  let h = 0x811c9dc5;
  for (const pl of s.players) {
    if (withHp) h = mix(h, pl.leaderHp);
    h = mix(mix(mix(mix(mix(h, pl.pp), pl.combo), pl.ep), pl.sep), pl.extraPpAvailable ? 1 : 0);
    let hand = 0;
    for (const c of pl.hand) hand = (hand + mix(mix(mix(hashString(c.cardId), c.costMod), c.attackMod), c.defenseMod)) | 0;
    let board = 0;
    for (const c of pl.board) {
      let x = mix(mix(hashString(c.cardId), c.keywords.length), c.granted.length);
      if (c.kind === "follower") x = mix(mix(mix(mix(mix(x, c.attack), c.defense), c.maxDefense), c.tempAttack), c.attacksThisTurn);
      else x = mix(mix(x, c.countdown ?? -1), c.actedThisTurn ? 1 : 0);
      board = (board + x) | 0;
    }
    h = mix(mix(mix(mix(h, pl.hand.length), hand), pl.board.length), board);
    h = mix(h, pl.crests.length);
  }
  const pd = s.pending;
  h = mix(h, pd === null ? 0 : pd.kind === "choose" ? 1 + pd.candidates.length : 100 + pd.options);
  return mix(h, s.stack.length);
}
