// Rust 版エンジン（rust/）が読むデータを書き出す（npm run rust-data）。
// カード・クレストの基本情報と、テキストから読み取る常在型キーワード等（registry.ts の staticOf と同じもの）、
// カード能力の DSL（src/cards/abilities。関数を含まない JSON）、アポカリプスデッキ、デフォルトデッキを 1 つの JSON にまとめる。
// 探索 AI が使うデータ（評価関数の重み、学習した評価の補正、マリガンの係数等）は ai-data.json に書き出す。
// 出力は rust/engine/data/ の 2 つ（生成物なのでコミットしない）。
// あわせて、元になったファイルの中身の指紋を sources.txt に書く。rust/engine/build.rs がビルドのときに確かめ、
// 元のファイルが変わったのに書き出し直していなければ、ビルドを止める（古い補正などを埋め込まないように）。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ALT_PLAY_OF, ENGINE_CARDS, ENGINE_CRESTS, FAITH_CREST_IDS, FAITH_OF, poolsOfCard } from "../src/cards/pools";
import { CARD_ABILITIES, CREST_ABILITIES } from "../src/cards/abilities";
import { AZVALDT_CARD_ABILITIES, AZVALDT_CREST_ABILITIES } from "../src/cards/abilities/azvaldt";
import { APOCALYPSE_DECK } from "../src/cards/abilities/special";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { enhanceCost, staticInfoOf } from "../src/engine";
import { id } from "../src/cards/abilities/helpers";
import { CLASS_WEIGHTS, DEFAULT_WEIGHTS, MODEL_FEATURES, MULLIGAN_MODEL, MULLIGAN_ROLES, MULLIGAN_WEIGHTS, ROLES, SEARCH_WEIGHTS } from "../src/ai/data";
import valueNet from "../data/value-net.json";
import potentialNet from "../data/potential-net.json";

export const RUST_DATA_PATH = "rust/engine/data/engine-data.json";
export const RUST_AI_DATA_PATH = "rust/engine/data/ai-data.json";

/** 書き出すデータの元になるファイル（ディレクトリと、その下で数えるファイル名）。元データの data/raw/ は除く */
const SOURCES: [string, RegExp][] = [
  ["data", /./],
  ["src/cards", /\.ts$/],
  ["src/engine", /\.ts$/],
  ["src/ai", /^data\.ts$/],
];

function listFiles(dir: string, keep: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return path === "data/raw" ? [] : listFiles(path, keep);
    return keep.test(e.name) ? [path] : [];
  });
}

/** FNV-1a（32 ビット）。build.rs と同じ */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** 元になったファイルの指紋の一覧（1 行に「指紋 パス」。パスはリポジトリの最上位から） */
export function sourcesText(): string {
  const paths = SOURCES.flatMap(([dir, keep]) => listFiles(dir, keep)).sort();
  const lines = paths.map((path) => `${fnv1a(readFileSync(path))} ${path}`);
  return `# npm run rust-data が書き出す。元のファイルの中身の指紋（FNV-1a 32 ビット）。rust/engine/build.rs が確かめる\n${lines.join("\n")}\n`;
}

/**
 * カードの表は src/cards/pools.ts の ENGINE_CARDS（スターターの全カードを今の順で先頭に、前期のローテーションにしか無いカードを後ろに）。
 * 能力の定義は、スターターのもの（cardAbilities・crestAbilities）と前期のローテーションにしか無いもの（poolCardAbilities・poolCrestAbilities）を
 * 分けて渡す。Rust はスターターのものから読むので、能力の中の名前（スロット・変数）の番号もスターターの分は変わらない。
 */
export function engineData() {
  for (const key of [...Object.keys(AZVALDT_CARD_ABILITIES), ...Object.keys(AZVALDT_CREST_ABILITIES)]) {
    if (CARD_ABILITIES[key] || CREST_ABILITIES[key]) throw new Error(`スターターと同じ ID の定義を前期のローテーションに書いています: ${key}`);
  }
  const cardIndex = new Map(ENGINE_CARDS.map((c, i) => [c.id, i]));
  // 「このバトル中に場に出た自分の『…』の枚数」（値 enteredCount）が見るカード。エンジンはこのカードだけ、場に出た枚数を数える
  const allDefs = JSON.stringify([CARD_ABILITIES, CREST_ABILITIES, AZVALDT_CARD_ABILITIES, AZVALDT_CREST_ABILITIES]);
  const countEntered = new Set(
    [...allDefs.matchAll(/"kind":"enteredCount","ids":\[([^\]]*)\]/g)].flatMap((m) => JSON.parse(`[${m[1]}]`) as string[]),
  );
  const crestIndex = new Map(ENGINE_CRESTS.map((c, i) => [c.id, i]));
  return {
    cards: ENGINE_CARDS.map((c) => {
      const st = staticInfoOf(c.text);
      const alt = ALT_PLAY_OF.get(c.id);
      const faith = FAITH_OF.get(c.id);
      // 能力の定義が使う条件・値（エンジンはこれを持つカードだけ、奥義ゲージ・場に出たフォロワーの枚数・払ったコスト・融合していたかを数える）
      const def = AZVALDT_CARD_ABILITIES[c.id] ?? CARD_ABILITIES[c.id];
      const defJson = JSON.stringify(def ?? {});
      const uses = (kind: string) => defJson.includes(`"kind":"${kind}"`);
      // 素材の条件が無く（どのカードも素材にできる）、融合したカードのコスト・種類も見ない融合先。どの素材を何枚融合しても融合先は同じになる
      const fuseAnyOne =
        def?.fusion !== undefined &&
        Object.keys(def.fusion).length === 0 &&
        !defJson.includes(`"name":"fusedCost"`) &&
        !defJson.includes(`"name":"fusedKinds"`);
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        class: c.class,
        cost: c.cost,
        attack: c.type === "follower" ? c.attack : 0,
        defense: c.type === "follower" ? c.defense : 0,
        countdown: c.type === "amulet" ? (c.countdown ?? null) : null,
        tribes: c.tribes ?? [],
        keywords: st.keywords,
        maxAttacks: st.maxAttacks,
        earthSigil: st.earthSigil,
        enhance: enhanceCost(c.text),
        token: c.set === "token",
        pools: poolsOfCard(c.id),
        // アクセラレート・結晶の姿（カードの表の番号）と、デッキに入れると置かれる信仰（クレストの表の番号）
        altPlay: alt === undefined ? null : cardIndex.get(alt)!,
        faith: faith === undefined ? null : crestIndex.get(faith)!,
        ougi: uses("ougi"),
        link: uses("link"),
        paidCost: uses("paidCost"),
        thisFused: uses("thisFused"),
        countEntered: countEntered.has(c.id),
        countEvolved: uses("evolvedCount"),
        countKinds: uses("enteredKinds"),
        fuseAnyOne,
      };
    }),
    crests: ENGINE_CRESTS.map((c) => ({ id: c.id, countdown: c.countdown ?? null, faith: FAITH_CREST_IDS.has(c.id) })),
    cardAbilities: CARD_ABILITIES,
    crestAbilities: CREST_ABILITIES,
    poolCardAbilities: AZVALDT_CARD_ABILITIES,
    poolCrestAbilities: AZVALDT_CREST_ABILITIES,
    apocalypseDeck: APOCALYPSE_DECK,
    decks: DEFAULT_DECKS.map((d) => ({ key: d.key, name: d.name, cards: d.cards })),
  };
}

/** 探索 AI のデータ（src/ai/data.ts と、学習した評価の補正 data/value-net.json、ターン途中の見込み data/potential-net.json） */
export function aiData() {
  return {
    defaultWeights: DEFAULT_WEIGHTS,
    searchWeights: SEARCH_WEIGHTS,
    // countdownDecay ** n（V8 の Math.pow は Rust の powf と最後の桁が違うことがあるので、表にして渡す）
    decayPow: Object.fromEntries(
      [DEFAULT_WEIGHTS.countdownDecay, SEARCH_WEIGHTS.countdownDecay].map((d) => [String(d), Array.from({ length: 64 }, (_, n) => d ** n)]),
    ),
    cards: {
      kuon: id("五行の果て・クオン"),
      kerberos: id("奔放なる獄炎・ケルベロス"),
      jeanne: id("純白の聖女・ジャンヌ"),
      fusionSet: ["デストロイアーティファクトα", "デストロイアーティファクトβ", "デストロイアーティファクトγ"].map(id),
      boostGrown: [id("成長したですぅ！")],
    },
    valueNet,
    potentialNet,
    mulliganWeights: MULLIGAN_WEIGHTS,
    mulliganModel: MULLIGAN_MODEL,
    mulliganRoles: MULLIGAN_ROLES,
    roles: ROLES,
    modelFeatures: MODEL_FEATURES,
    classWeights: CLASS_WEIGHTS,
  };
}

/** 中身が変わったときだけ書く（変わらなければ Rust を作り直さずに済む） */
function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeFileSync(path, text);
  return true;
}

export async function main(argv: string[]): Promise<number> {
  const quiet = argv.includes("--quiet");
  const [out = RUST_DATA_PATH, aiOut = RUST_AI_DATA_PATH] = argv.filter((a) => a !== "--quiet");
  mkdirSync(dirname(out), { recursive: true });
  const changed = [writeIfChanged(out, JSON.stringify(engineData())), writeIfChanged(aiOut, JSON.stringify(aiData()))];
  writeIfChanged(join(dirname(aiOut), "sources.txt"), sourcesText());
  if (!quiet) console.log(changed.some((c) => c) ? `${out}・${aiOut} に書き出しました` : `${out}・${aiOut} は変わっていません`);
  return 0;
}

