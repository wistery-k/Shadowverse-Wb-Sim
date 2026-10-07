// ルールの数値。出典・確認状況は docs/rules.md を参照。

export const LEADER_HP = 20;
export const INITIAL_HAND = 4;
export const HAND_LIMIT = 9;
export const BOARD_LIMIT = 5;
export const MAX_PP = 10;
export const EP = 2;
export const SEP = 2;
export const EVOLVE_BONUS = 2;
export const SUPER_EVOLVE_BONUS = 3;

/** 進化・超進化が解禁される自分のターン数 [先攻, 後攻] */
export const EVOLVE_TURN: readonly [number, number] = [5, 4];
export const SUPER_EVOLVE_TURN: readonly [number, number] = [7, 6];

/** 後攻のエクストラPPの使用権が復活する自分のターン数 */
export const EXTRA_PP_REFRESH_TURN = 6;
