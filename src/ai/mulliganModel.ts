// 手札の形でマリガンする（ユーザー案、実験中）。
// 残した手札を役割（1PP・2PP・3PP の動き、除去、リソース、展開、回復、ダメージ、進化、超進化、シナジー与・受）の枚数などの特徴で表し、
// デッキごとに推定した係数で勝率を予測して、初手の残し方（最大 16 通り）から予測が最も高いものを選ぶ。
// カードの役割は data/mulligan-roles.json（ユーザーと決めた表）、係数は scripts/mulligan-model-fit-main.ts で推定する。

import { CARDS_BY_ID } from "../cards";
import { type GameState, type PlayerIndex } from "../engine";
import rolesTable from "../../data/mulligan-roles.json";
import { defaultDeckNameOf } from "./mulligan";

/** 役割（data/mulligan-roles.json の書き方のまま）。返し・重いは古い表の書き方（ナイトメアを直すまで残す） */
export const ROLES = ["1PP", "2PP", "3PP", "除去", "リソース", "展開", "回復", "ダメージ", "進化", "超進化", "シナジー与", "シナジー受", "返し", "重い"] as const;
export type Role = (typeof ROLES)[number];

/** デッキ名 → カードID → 役割（同じ役割を 2 つ書いたカードは 2 枚分に数える） */
export type MulliganRoles = Record<string, Record<string, readonly Role[]>>;

const ID_BY_NAME = new Map([...CARDS_BY_ID.values()].map((c) => [c.name, c.id]));

/** data/mulligan-roles.json（デッキ名 → カード名 → 役割）を検証して、カードIDで引ける形にする */
export function parseMulliganRoles(raw: unknown): MulliganRoles {
  const fail = (msg: string): never => {
    throw new Error(`マリガンの役割の表が不正です: ${msg}`);
  };
  if (typeof raw !== "object" || raw === null) return fail("オブジェクトではありません");
  const out: MulliganRoles = {};
  for (const [deck, cards] of Object.entries(raw)) {
    if (typeof cards !== "object" || cards === null) return fail(deck);
    const t: Record<string, readonly Role[]> = {};
    for (const [name, roles] of Object.entries(cards as Record<string, unknown>)) {
      const id = ID_BY_NAME.get(name) ?? fail(`${deck} ${name}（カードがありません）`);
      if (!Array.isArray(roles) || !roles.every((r) => (ROLES as readonly string[]).includes(r))) return fail(`${deck} ${name}`);
      t[id] = roles as Role[];
    }
    out[deck] = t;
  }
  return out;
}

export const MULLIGAN_ROLES: MulliganRoles = parseMulliganRoles(rolesTable);

/**
 * 特徴の名前。各役割は「1 枚以上」「2 枚以上」で数える（1 枚目は効くが 2 枚目は効きが落ちる、を表すため）。
 * cost4+ はコスト 4 以上の枚数（役割とは別に自動で数える）、dup は同じカードの重複（2 枚目以降）の枚数、kept は残した枚数。
 * 1PPxRes は 1PP の動きがある × リソースの枚数（1PP で手札を使う分とリソースの兼ね合い）、
 * synergy はシナジー与とシナジー受が両方ある、*xSecond は後攻との組み合わせ
 */
export const MODEL_FEATURES: readonly string[] = [
  ...ROLES.flatMap((r) => [`${r}>=1`, `${r}>=2`]),
  "cost4+>=1",
  "cost4+>=2",
  "dup",
  "kept",
  "1PPxRes",
  "synergy",
  "1PPxSecond",
  "2PPxSecond",
  "3PPxSecond",
];

/** 残したカード（重複あり）と後攻かどうかから特徴を作る */
export function handFeatures(kept: readonly string[], roles: Record<string, readonly Role[]>, second: boolean): number[] {
  const count = new Map<Role, number>();
  for (const id of kept) for (const r of roles[id] ?? []) count.set(r, (count.get(r) ?? 0) + 1);
  const n = (r: Role) => count.get(r) ?? 0;
  const s = second ? 1 : 0;
  const high = kept.filter((id) => (CARDS_BY_ID.get(id)?.cost ?? 0) >= 4).length;
  return [
    ...ROLES.flatMap((r) => [n(r) >= 1 ? 1 : 0, n(r) >= 2 ? 1 : 0]),
    high >= 1 ? 1 : 0,
    high >= 2 ? 1 : 0,
    kept.length - new Set(kept).size,
    kept.length,
    (n("1PP") >= 1 ? 1 : 0) * n("リソース"),
    n("シナジー与") >= 1 && n("シナジー受") >= 1 ? 1 : 0,
    (n("1PP") >= 1 ? 1 : 0) * s,
    (n("2PP") >= 1 ? 1 : 0) * s,
    (n("3PP") >= 1 ? 1 : 0) * s,
  ];
}

/** デッキ名 → { 特徴の係数, カードごとの「残した」の係数 } */
export type MulliganModel = Record<string, { features: Record<string, number>; cards: Record<string, number> }>;

/** 残したカードの予測（勝率への寄与。手札が同じなら比べられる） */
export function predictKeep(kept: readonly string[], deck: MulliganModel[string], roles: Record<string, readonly Role[]>, second: boolean): number {
  const f = handFeatures(kept, roles, second);
  let v = 0;
  MODEL_FEATURES.forEach((name, i) => (v += (deck.features[name] ?? 0) * f[i]!));
  for (const id of new Set(kept)) v += deck.cards[id] ?? 0;
  return v;
}

/** 手札の形でマリガンする。デッキの係数か役割が無ければ null */
export function modelMulliganSwap(state: GameState, p: PlayerIndex, model: MulliganModel, roles: MulliganRoles = MULLIGAN_ROLES): number[] | null {
  const name = defaultDeckNameOf(state, p);
  const deck = name === null ? undefined : model[name];
  const r = name === null ? undefined : roles[name];
  if (!deck || !r) return null;
  const hand = state.players[p].hand;
  const second = state.first !== p;
  let best: number[] = [];
  let bestV = -Infinity;
  for (let mask = 0; mask < 1 << hand.length; mask++) {
    const kept = hand.filter((_, i) => mask & (1 << i)).map((h) => h.cardId);
    const v = predictKeep(kept, deck, r, second);
    if (v > bestV + 1e-12) {
      bestV = v;
      best = hand.filter((_, i) => !(mask & (1 << i))).map((h) => h.iid);
    }
  }
  return best;
}
