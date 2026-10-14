// 設定の JSON の "valueNet"（TD 学習で作った評価の補正のファイル。scripts/td-main.ts）を、探索 AI の設定に直す（compare・rhino-compare 用）

import { readFileSync } from "node:fs";
import { SEARCH_WEIGHTS } from "../src/ai/evaluate";
import { compileValueNet, parseValueNetModel, valueNetExtraEval, type ValueNetModel } from "../src/ai/valueNet";

export function loadValueNet(path: string): ValueNetModel {
  return parseValueNetModel(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/**
 * raw に "valueNet": "<ファイル>" があれば、評価の重みをそのモデルの出発点（SEARCH_WEIGHTS ＋ baseWeights）にし、
 * extraEval に学習した補正を入れる。"weights" も渡したときは、その項目をさらに上書きする。
 * "valueNet": false なら、学習した補正を使わない（探索 AI の既定の補正を外す。data/value-net.json を入れる前の AI）
 */
export function applyValueNetOption(raw: Record<string, unknown>): Record<string, unknown> {
  const { valueNet, ...rest } = raw;
  if (valueNet === undefined) return raw;
  if (valueNet === false) return { ...rest, extraEval: null };
  if (typeof valueNet !== "string") throw new Error(`"valueNet" にはモデルのファイル名か false を渡します`);
  const model = loadValueNet(valueNet);
  const extra = typeof rest.weights === "object" && rest.weights !== null ? rest.weights : {};
  return { ...rest, weights: { ...SEARCH_WEIGHTS, ...model.baseWeights, ...extra }, extraEval: valueNetExtraEval(compileValueNet(model)) };
}
