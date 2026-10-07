// 評価関数を自己対戦のデータから学習する（npm run learn）。
//
// 1. gen: 探索 AI どうしでデフォルトデッキの総当たりを行い、各ターンの開始時と終了時（ターン終了を選んだ直前）の
//    局面の特徴量（learned.ts）と、その試合に勝ったかを記録する（両方のプレイヤーの視点で1件ずつ）
// 2. fit: 記録したデータでロジスティック回帰（L2 正則化、Adam による勾配降下）を行い、モデルを書き出す
//
// 使い方:
//   npm run learn -- gen --games 500 --seed 1 --out <ファイル.jsonl> [--model <モデル.json>]
//     --model を付けると、自己対戦する探索 AI がそのモデルを評価関数に使う（付けなければ基準の重み）
//   npm run learn -- fit --out data/ai-model.json [--epochs 400] [--l2 0.001] <データ.jsonl> ...
//     試合の 2 割を検証用に取り分け、検証データでの対数損失・正解率を基準の評価関数と比べて表示する

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { DEFAULT_WEIGHTS, evaluateWith } from "../src/ai/evaluate";
import { featuresOf, NUMERIC_FEATURES, type Features, type LinearModel } from "../src/ai/learned";
import { createSearchAgent } from "../src/ai/search";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import type { GameState, PlayerIndex } from "../src/engine";
import { playMatch } from "../src/sim/match";

interface Sample {
  /** 試合の番号（検証用の分割に使う） */
  game: number;
  /** この視点のプレイヤーが勝ったか */
  y: 0 | 1;
  /** 基準の評価関数の値（比較用） */
  base: number;
  f: Features;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const [mode, ...rest] = argv;
  if (mode === "gen") return gen(rest);
  if (mode === "fit") return fit(rest);
  console.error("使い方: npm run learn -- gen|fit ...");
  return 2;
}

// ---- データの収集 ----

function gen(argv: string[]): number {
  const games = Number(flag(argv, "--games") ?? 100);
  const seed = Number(flag(argv, "--seed") ?? 1);
  const out = flag(argv, "--out");
  if (!out) throw new Error("--out がありません");
  const modelPath = flag(argv, "--model");
  const agent = createSearchAgent(
    modelPath ? { weights: { linear: JSON.parse(readFileSync(modelPath, "utf8")) as LinearModel } } : {},
  );
  writeFileSync(out, "");
  const n = DEFAULT_DECKS.length;
  const t0 = Date.now();
  let count = 0;
  for (let g = 0; g < games; g++) {
    const gameId = seed * 1_000_000 + g;
    const d0 = DEFAULT_DECKS[g % n]!;
    const d1 = DEFAULT_DECKS[Math.floor(g / n) % n]!;
    const recorded: GameState[] = [];
    let lastTurn = -1;
    const r = playMatch([agent, agent], {
      decks: [d0.cards, d1.cards],
      seed: gameId >>> 0,
      observe: (state, action) => {
        if (state.phase !== "main" || state.pending) return;
        // ターンの最初の行動の直前（ターン開始時）と、ターン終了の直前
        if (state.turn !== lastTurn || action.type === "endTurn") recorded.push(state);
        lastTurn = state.turn;
      },
    });
    const lines: string[] = [];
    for (const s of recorded) {
      for (const p of [0, 1] as PlayerIndex[]) {
        const sample: Sample = { game: gameId, y: r.winner === p ? 1 : 0, base: evaluateWith(s, p, DEFAULT_WEIGHTS), f: featuresOf(s, p) };
        lines.push(JSON.stringify(sample));
      }
    }
    appendFileSync(out, lines.join("\n") + "\n");
    count += lines.length;
    if ((g + 1) % 20 === 0) console.log(`${g + 1}/${games} 試合、${count} 件（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
  }
  console.log(`${out} に ${count} 件を書き出しました`);
  return 0;
}

// ---- 学習 ----

interface Encoded {
  /** 標準化した数値の特徴 */
  num: Float64Array;
  /** カードの特徴の添字（重複あり = 枚数） */
  cards: Int32Array;
  y: number;
  base: number;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function logLoss(p: number, y: number): number {
  const q = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
}

function fit(argv: string[]): number {
  const out = flag(argv, "--out");
  if (!out) throw new Error("--out がありません");
  const epochs = Number(flag(argv, "--epochs") ?? 400);
  const l2 = Number(flag(argv, "--l2") ?? 0.001);
  const files = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1] ?? "").startsWith("--"));
  const samples: Sample[] = files.flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Sample),
  );
  const games = [...new Set(samples.map((s) => s.game))];
  console.log(`${samples.length} 件（${games.length} 試合）`);

  // カードの特徴の添字: 手札・自分の場・相手の場
  const cardIndex = new Map<string, number>();
  const cardKey = (kind: string, id: string) => {
    const k = `${kind}:${id}`;
    let i = cardIndex.get(k);
    if (i === undefined) {
      i = cardIndex.size;
      cardIndex.set(k, i);
    }
    return i;
  };
  const numN = NUMERIC_FEATURES.length;
  // 数値の特徴の平均・標準偏差
  const mean = new Float64Array(numN);
  const sd = new Float64Array(numN);
  for (const s of samples) for (let i = 0; i < numN; i++) mean[i]! += s.f.num[i]! / samples.length;
  for (const s of samples) for (let i = 0; i < numN; i++) sd[i]! += (s.f.num[i]! - mean[i]!) ** 2 / samples.length;
  for (let i = 0; i < numN; i++) sd[i] = Math.sqrt(sd[i]!) || 1;

  // 検証用: 試合番号のハッシュで 2 割
  const isValidation = (game: number) => ((game * 2654435761) >>> 0) % 5 === 0;
  const encode = (s: Sample): Encoded => ({
    num: Float64Array.from(s.f.num, (v, i) => (v - mean[i]!) / sd[i]!),
    cards: Int32Array.from([
      ...s.f.hand.map((id) => cardKey("hand", id)),
      ...s.f.myBoard.map((id) => cardKey("myBoard", id)),
      ...s.f.oppBoard.map((id) => cardKey("oppBoard", id)),
    ]),
    y: s.y,
    base: s.base,
  });
  const train: Encoded[] = [];
  const valid: Encoded[] = [];
  for (const s of samples) (isValidation(s.game) ? valid : train).push(encode(s));
  const cardN = cardIndex.size;
  console.log(`学習 ${train.length} 件 / 検証 ${valid.length} 件、特徴 ${numN} + カード ${cardN}`);

  // パラメータ: [bias, 数値..., カード...]
  const dim = 1 + numN + cardN;
  const w = new Float64Array(dim);
  const m = new Float64Array(dim);
  const v = new Float64Array(dim);
  const grad = new Float64Array(dim);
  const lr = 0.05, b1 = 0.9, b2 = 0.999;
  const predict = (e: Encoded) => {
    let z = w[0]!;
    for (let i = 0; i < numN; i++) z += w[1 + i]! * e.num[i]!;
    for (const c of e.cards) z += w[1 + numN + c]!;
    return z;
  };
  const evaluate = (data: Encoded[]) => {
    let loss = 0, correct = 0;
    for (const e of data) {
      const p = sigmoid(predict(e));
      loss += logLoss(p, e.y);
      if ((p > 0.5 ? 1 : 0) === e.y) correct++;
    }
    return { loss: loss / data.length, acc: correct / data.length };
  };

  for (let epoch = 1; epoch <= epochs; epoch++) {
    grad.fill(0);
    for (const e of train) {
      const err = sigmoid(predict(e)) - e.y;
      grad[0]! += err;
      for (let i = 0; i < numN; i++) grad[1 + i]! += err * e.num[i]!;
      for (const c of e.cards) grad[1 + numN + c]! += err;
    }
    for (let i = 0; i < dim; i++) {
      const g = grad[i]! / train.length + (i === 0 ? 0 : l2 * w[i]!);
      m[i] = b1 * m[i]! + (1 - b1) * g;
      v[i] = b2 * v[i]! + (1 - b2) * g * g;
      const mh = m[i]! / (1 - b1 ** epoch);
      const vh = v[i]! / (1 - b2 ** epoch);
      w[i]! -= (lr * mh) / (Math.sqrt(vh) + 1e-8);
    }
    if (epoch % 100 === 0 || epoch === epochs) {
      const tr = evaluate(train), va = evaluate(valid);
      console.log(`#${epoch} 学習 損失 ${tr.loss.toFixed(4)} 正解 ${(tr.acc * 100).toFixed(1)}% / 検証 損失 ${va.loss.toFixed(4)} 正解 ${(va.acc * 100).toFixed(1)}%`);
    }
  }

  // 比較: 基準の評価関数の値を 1 変数のロジスティック回帰にかけたもの（尺度だけ学習データに合わせる）
  let a = 0.1;
  for (let it = 0; it < 300; it++) {
    let g = 0, h = 0;
    for (const e of train) {
      const p = sigmoid(a * e.base);
      g += (p - e.y) * e.base;
      h += p * (1 - p) * e.base * e.base;
    }
    a -= g / (h + 1e-9);
  }
  let baseLoss = 0, baseCorrect = 0;
  for (const e of valid) {
    const p = sigmoid(a * e.base);
    baseLoss += logLoss(p, e.y);
    if ((p > 0.5 ? 1 : 0) === e.y) baseCorrect++;
  }
  console.log(`基準の評価関数（検証）: 損失 ${(baseLoss / valid.length).toFixed(4)} 正解 ${((baseCorrect / valid.length) * 100).toFixed(1)}%`);

  // 標準化を戻して書き出す（定数項は局面の比較に影響しないので捨てる）
  const round = (x: number) => Math.round(x * 1e5) / 1e5;
  const model: { num: Record<string, number>; hand: Record<string, number>; myBoard: Record<string, number>; oppBoard: Record<string, number> } = {
    num: {},
    hand: {},
    myBoard: {},
    oppBoard: {},
  };
  NUMERIC_FEATURES.forEach((name, i) => (model.num[name] = round(w[1 + i]! / sd[i]!)));
  for (const [k, i] of [...cardIndex].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const [kind, id] = k.split(":") as ["hand" | "myBoard" | "oppBoard", string];
    const value = round(w[1 + numN + i]!);
    if (value !== 0) model[kind][id] = value;
  }
  writeFileSync(out, JSON.stringify(model, null, 2) + "\n");
  const unit = Math.abs(model.num["opp.hp"] ?? 1);
  console.log(`${out} に書き出しました。数値の特徴（相手リーダーの体力 1 = 1 点に換算）:`);
  console.log(NUMERIC_FEATURES.map((n) => `${n} ${((model.num[n] ?? 0) / unit).toFixed(2)}`).join(", "));
  return 0;
}
