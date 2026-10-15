// 探索 AI が使う、TD 学習で作った評価の補正（data/value-net.json、docs/ai-notes.md「評価の項目を手で作らない（TD 学習）」）。
// 今の評価関数（SEARCH_WEIGHTS）を出発点に、自己対戦 4000 試合 × 4 回で学んだもの。今の評価関数だけの探索 AI に 55.3%（2000 試合）。
// 作り直すときは npm run td（scripts/td-main.ts）で学び、train の出力を prune（学習データに現れなかった入力の重みを 0 にする）してから置き換える

import raw from "../../data/value-net.json";
import { compileValueNet, parseValueNetModel, valueNetExtraEval } from "./valueNet";

export const VALUE_NET = compileValueNet(parseValueNetModel(raw as unknown));

if (Object.keys(VALUE_NET.model.baseWeights).length > 0) throw new Error("data/value-net.json は今の評価関数（baseWeights なし）から学んだモデルの想定です");

/** 探索 AI の既定の extraEval */
export const valueNetEval = valueNetExtraEval(VALUE_NET);
