// カードの能力テキストから常在型のキーワードを読み取る。
// 単独行の「【守護】」等と「1ターンにN回攻撃できる。」だけを対象にする。
// 条件付きで得るもの（「【覚醒】なら、これは【威圧】を持つ」等）は能力（src/cards/abilities）で扱う。

import type { StaticKeyword } from "./types";

const KEYWORD_NAMES: Record<string, StaticKeyword> = {
  守護: "ward",
  疾走: "storm",
  突進: "rush",
  必殺: "bane",
  ドレイン: "drain",
  潜伏: "ambush",
  威圧: "intimidate",
  バリア: "barrier",
  オーラ: "aura",
};

export interface StaticAbilities {
  keywords: StaticKeyword[];
  maxAttacks: number;
}

export function parseStaticAbilities(text: string): StaticAbilities {
  const keywords: StaticKeyword[] = [];
  let maxAttacks = 1;
  for (const line of text.split("\n")) {
    const attacks = /^1ターンに(\d)回攻撃できる。$/.exec(line);
    if (attacks?.[1] !== undefined) maxAttacks = Number(attacks[1]);
    const m = /^【([^】_]+)】$/.exec(line);
    const kw = m?.[1] !== undefined ? KEYWORD_NAMES[m[1]] : undefined;
    if (kw && !keywords.includes(kw)) keywords.push(kw);
  }
  return { keywords, maxAttacks };
}

/** 【エンハンス_N】の N。無ければ null */
export function enhanceCost(text: string): number | null {
  const m = /【エンハンス_(\d+)】/.exec(text);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}
