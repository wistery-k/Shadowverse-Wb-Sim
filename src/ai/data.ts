// 探索 AI が使うデータ（評価関数の重み・マリガンの係数等）。AI の本体は Rust（rust/engine/src/ai）で、
// npm run rust-data（scripts/rust-data-main.ts）がこれを rust/engine/data/ai-data.json に書き出して Rust に渡す。
// 重みを変えたら npm run wasm で WASM を作り直し、勝率で確かめてから採用する（CLAUDE.md）。

import { CARDS_BY_ID } from "../cards";
import { id } from "../cards/abilities/helpers";
import rolesTable from "../../data/mulligan-roles.json";
import modelTable from "../../data/mulligan-model.json";
import mulliganTable from "../../data/mulligan-weights.json";
import classTable from "../../data/ai-weights.json";
import type { ClassId } from "../cards";

// ---- 評価関数の重み（rust/engine/src/ai/eval.rs） ----

export interface EvalWeights {
  /** 自分・相手のリーダー体力 1 点 */
  myHp: number;
  oppHp: number;
  /** フォロワー: 攻撃力・体力・1体あたりの基礎点・ターン終了までの攻撃力 */
  attack: number;
  defense: number;
  followerBase: number;
  tempAttack: number;
  /** キーワード能力の価値の倍率（守護1・必殺2 等の基準値にかける） */
  keywords: number;
  /** アミュレット1枚・土の印1つ */
  amulet: number;
  sigil: number;
  /**
   * 土の印を持つアミュレット（大地の魔片等）自体の価値（土の印の数は sigil で数える）。
   * 基準は amulet と同じ。土の印を増やすだけの手（理光の証明の（1）等）が、印の数とは別にアミュレット 1 枚分得をする
   */
  sigilAmulet: number;
  /**
   * カウントダウンとラストワード（召喚・ドロー）を持つアミュレット（獣姫の誓約・穏やかなる教会等）を、
   * 「割れたときに得るもの × countdownDecay^残りカウント」で数える（amulet の代わり）。
   * 割れたときに得るものは、出すフォロワーの価値（攻撃力・体力・基礎点・キーワード）と引く枚数 × myHand。
   * カウントを進めるアクトで点が上がり、割れると得るものと同じ点になる。0 なら見ない（amulet で数える）
   */
  countdownDecay: number;
  /**
   * 手札に純白の聖女・ジャンヌがあり、フォロワーを出すカウントダウンのアミュレットがジャンヌを出せるターン
   * （自分のターン数＋残りカウント＝8。エクストラPP を使えるなら 7 も）に割れるとき、出るフォロワーを +2/+4 して数える（countdownDecay のとき）。
   * 0 なら見ない、1 なら見る
   */
  jeanneSync: number;
  /** 相手の盤面の価値の倍率（自分の盤面に対して） */
  oppBoard: number;
  /** 手札 1 枚 */
  myHand: number;
  oppHand: number;
  /** 残っている EP / SEP / エクストラPP の使用権 */
  ep: number;
  sep: number;
  extraPp: number;
  /** 自分の PP 最大値を、毎ターンの自然な増加（ターン数、最大 10）より増やした分 1 あたり（竜の啓示等） */
  maxPp: number;
  /** クレスト 1 つ */
  crest: number;
  /** 墓場 1（10 まで） */
  graveyard: number;
  /** 相手リーダーの体力がこれ以下のとき、自分のフォロワーの攻撃力を追加で評価する */
  lethalRange: number;
  lethalAttack: number;
  /**
   * 手札にあるデストロイアーティファクト α・β・γ の種類 1 つあたり（同じ種類の 2 枚目以降は数えない）。
   * 3 種類そろうとイクシードアーティファクトΩを作れる。0 なら見ない
   */
  fusionSet: number;
  /**
   * 手札に五行の果て・クオンがあり、超進化を 1 回以上残しているときに足す点。
   * PP 10 でエンハンス 10 のクオンを出し、超進化で式神・貴人に疾走を付けてとどめにするために、
   * 超進化を 1 回分使わずに残す価値。0 なら見ない
   */
  kuonReserve: number;
  /**
   * 進化時能力（【進化時】・これが進化したとき）を持つフォロワーのために EP を残す価値。
   * 手札の進化時能力持ちを EP の数まで数え、このターンに EP で進化させたのが進化時能力持ちならさらに 1 枚分数えて、1 枚あたりこの点を足す。
   * 進化時能力持ちを出してそのターンに進化させても点は変わらず、進化時能力のないフォロワーを進化させたり、
   * 出して進化させずに場に残したりすると下がる。0 なら見ない
   */
  evoReserve: number;
  /**
   * 進化時・超進化時能力（【進化時】・これが進化したとき・【超進化時】）を持つフォロワーのために SEP を残す価値。
   * evoReserve の超進化版: 手札の該当カードを SEP の数まで数え、このターンに超進化させたのが該当カードならさらに 1 枚分数えて、1 枚あたりこの点を足す。
   * 能力のないフォロワー（アミュレットから出るトークン等）に超進化を使うと下がる。0 なら見ない
   */
  sevoReserve: number;
  /**
   * 手札に奔放なる獄炎・ケルベロスがあり SEP が 1 以上残っているとき、またはこのターンに SEP でケルベロスを超進化させたときに足す点。
   * ケルベロスの超進化（ミミ・ココのリアニメイト 2 回）はオリヴィエ等より価値が高いので、ほかのカードに先に SEP を使わないようにする（ユーザーの見立て）。0 なら見ない
   */
  kerberosReserve: number;
  /**
   * 場のフォロワーのラストワードの「相手のリーダーに N ダメージ」「自分のリーダーを N 回復」（番犬の右腕・ミミ、番犬の左腕・ココ、
   * 人形に付与されたもの等）を、いずれ得るものとして数える倍率。ダメージは N × oppHp、回復は減っている分までの N × myHp にこの倍率を掛ける。
   * 相手の場のものは逆向きに引く。0 なら見ない
   */
  lastWords: number;
  /**
   * 場のフォロワーのラストワードで出すフォロワー（ボーンガールのスケルトン 2 体、王家の御者のナイト等）の価値の倍率。
   * 出すフォロワーの攻撃力・体力・キーワード・基本点（カウントダウンのアミュレットが割れたときと同じ数え方）にこの値を掛けて、そのフォロワーの価値に足す。
   * 死ぬまで出ず、出るのは早くても次のターンなので割り引く。0 なら見ない（探索 AI は 0.5。docs/ai-notes.md）
   */
  lastWordsSummon: number;
  /**
   * 相手の体力が lethalRange 以下のとき、手札の「アミュレットをアクトすると疾走を得るフォロワー」（セイクリッドグリフォン）を、
   * 次のターンに出せて（コスト ≤ 次のターンの PP）、自分の場にアクトできるアミュレットがあれば、攻撃力 × この値を足す。
   * 次のターンの疾走の打点（リノセウスの potential と同じ考え）。0 なら見ない
   */
  handStorm: number;
  /**
   * 手札のスペルブーストで育つカード（【スペルブースト時】の能力を持つ。ストームブラスト・ウィリアム・宿題やるですぅ！・鬼呼びの術・オーバーディメンション等）1 枚あたり（myHand に加算）。
   * 早く引くほどブーストを多く受けられる価値。0 なら見ない
   */
  boostCard: number;
  /** 手札のスペルブーストで育つカードが受けたスペルブースト 1 回あたり（1 枚につき boostCap 回まで）。0 なら見ない */
  boost: number;
  boostCap: number;
  /**
   * カードごとの「手札に持っておく価値」（カードID → 点数）。切り札を温存させるために使う。
   * 手札1枚の価値（myHand）に加算する
   */
  hold: Readonly<Record<string, number>>;
  /**
   * 相手のターン終了時に自壊する自分のフォロワー（アンの大英霊・改良型・操り人形等）の価値の倍率。
   * 評価は自分のターンの終わりの局面で行うので、そのまま数えると次の自分のターンにも残るように見え、
   * 突進で攻撃せずに残したり、意味の薄い進化をしたりした。残るのは相手のターンに守る分だけなので割り引く。1 なら普通のフォロワーと同じ
   */
  doomed: number;
  /**
   * 自分のターンを終えるときに残った PP 1 につき引く点（探索 AI のターン末の採点と、上位の手を読み直した点数だけに使う。evaluateWith では見ない）。
   * 同じ局面の手順どうしを比べると（plan-value、docs/ai-notes.md）、評価が同じでも PP を余らせた手順ほど勝率が低かった。0 なら見ない
   */
  ppLeft: number;
  /**
   * 後攻の 5 ターン目（使用権が戻る前のターン）を終えるときに残っているエクストラPP の価値を extraPp の何倍にするか。
   * 6 ターン目の開始時に使用権が戻り、重ならないので、5 ターン目に残しても得は無い（ユーザー案）。1 なら他のターンと同じ。
   * 探索 AI のターン末の採点（ビーム）だけに使い、evaluateWith では見ない（相手のターンを読んだ後の自分の 5 ターン目の開始時には、
   * そのターンに使えるので価値がある）
   */
  extraPpExpiring: number;
  /**
   * 場にいる間に働く誘発能力（味方が場に出たとき・ターン終了時・味方が破壊されたとき等。自壊するものは除く）を持つフォロワー 1 枚あたり。
   * 勇猛のルミナスランサー（兵士に突進）のように、能力値は低いが残すと後で効くフォロワーを、能力値だけで数えて安く見ていた（棋譜の指摘、docs/ai-notes.md）。
   * 相手の場のものも同じく数える（oppBoard を掛けて引く）。0 なら見ない
   */
  passive: number;
}

/** 数値の重みの名前（hold を除く） */
export type NumericWeight = Exclude<keyof EvalWeights, "hold">;

/** 手で決めた基準の重み */
export const DEFAULT_WEIGHTS: EvalWeights = {
  myHp: 0.7,
  oppHp: 1.0,
  attack: 1,
  defense: 0.8,
  followerBase: 1,
  tempAttack: 0.3,
  keywords: 1,
  amulet: 1.5,
  sigil: 0.5,
  sigilAmulet: 1.5,
  countdownDecay: 0,
  jeanneSync: 0,
  oppBoard: 1.1,
  myHand: 0.6,
  oppHand: 0.3,
  ep: 1.5,
  sep: 2.5,
  extraPp: 1,
  maxPp: 0,
  crest: 1.5,
  graveyard: 0.05,
  lethalRange: 10,
  lethalAttack: 0.3,
  fusionSet: 0,
  kuonReserve: 0,
  evoReserve: 0,
  sevoReserve: 0,
  kerberosReserve: 0,
  lastWords: 0,
  lastWordsSummon: 0,
  handStorm: 0,
  boostCard: 0,
  boost: 0,
  boostCap: 5,
  hold: {},
  doomed: 1,
  ppLeft: 0,
  extraPpExpiring: 1,
  passive: 0,
};

/**
 * 融合で作るカードの「手札に持っておく価値」。融合した素材の枚数 × 手札 1 枚の価値。
 * 手札を枚数だけで数えると、融合は手札が減る損に見え、AFネメシスがコアを手札に余らせたまま
 * デストロイアーティファクトを作らなかった（ロイヤル戦 7%。docs/ai-notes.md）。
 * Ω は α＋β＋γ の合計（8 枚分）。それより低いと、Ω を作ると評価が下がる
 */
const FUSION_HOLD: Readonly<Record<string, number>> = Object.fromEntries(
  (
    [
      ["アタックアーティファクト", 1],
      ["キャッスルアーティファクト", 1],
      ["デストロイアーティファクトα", 2],
      ["デストロイアーティファクトβ", 3],
      ["デストロイアーティファクトγ", 3],
      ["イクシードアーティファクトΩ", 8],
    ] as const
  ).map(([name, cards]) => [id(name), cards * DEFAULT_WEIGHTS.myHand]),
);

/**
 * 探索 AI の既定の重み（基準の重み＋PP 最大値＋SEP＋融合で作るカードの価値）。
 * PP 最大値の重みが 0 だと、竜の啓示を打つ手は手札が 1 枚減るだけに見え、初手にあっても 95% の試合で打たなかった。
 * 重み 0/1/2/4/6/8/12/16 で比べて 8 が最も勝った（docs/ai-notes.md）。
 * SEP が 2.5 だと +3/+3（5.4）より安く、超進化しなくても倒せる相手にもジェノを超進化した（docs/ai-notes.md）。
 * クレストは 1.5 だとアリアのクレスト（妖精に疾走）を安く見て、出すべき局面でアリアを出さなかったため 3（ユーザー判断。docs/ai-notes.md）
 * fusionSet（手札の α・β・γ の種類 1 つにつき）は 0/1.2/2.4/3.6/4.8 で比べて 3.6（AFネメシスの勝率 38.7% → 46.8%。docs/ai-notes.md）
 * kuonReserve は 0/8/12/16 で比べて 8（スペルウィッチの勝率 44.4% → 47.1%、1200 試合。docs/ai-notes.md）
 * lastWords 1 はユーザー判断で採用（ミミ・ココのラストワードはほぼ確実に回収される。勝率は 1200 試合で誤差の範囲。docs/ai-notes.md）
 * sevoReserve 6 はアミュレット疾走ビショップの勝率 53.3% → 57.0%（2400 試合）、全デッキの compare で 52.4%（1200 試合）（docs/ai-notes.md）
 * evoReserve 3 は勝率を変えない（今の AI と 50〜51%）が、進化時能力を持たないフォロワーへの進化が 30% → 20% に減るので採用（ユーザー判断。docs/ai-notes.md）
 * boostCard 1・boost 0.2（スペルブーストで育つカード）はスペルウィッチの勝率 44.3% → 52.1%（1200 試合。docs/ai-notes.md）
 * countdownDecay 0.8（カウントダウンのアミュレット）はアミュレット疾走ビショップの勝率 50.1% → 54.5%（2400 試合。docs/ai-notes.md）
 * doomed 0.3（相手のターン終了時に自壊するフォロワー）は勝率を変えない（3000 試合で 49.6%）が、改良型・操り人形で攻撃せずに終えたり
 * アンの大英霊を進化させたりするのが直るので採用（ユーザー判断。docs/ai-notes.md）
 */
export const SEARCH_WEIGHTS: EvalWeights = { ...DEFAULT_WEIGHTS, maxPp: 8, sep: 5, crest: 3, fusionSet: 3.6, kuonReserve: 8, evoReserve: 3, sevoReserve: 6, lastWords: 1, lastWordsSummon: 0.5, boostCard: 1, boost: 0.2, countdownDecay: 0.8, doomed: 0.3, extraPpExpiring: 0, hold: FUSION_HOLD };

/**
 * クラスごとに調整した重み（data/ai-weights.json。記載のない項目は DEFAULT_WEIGHTS。以前の scripts/tune-main.ts で調整した）。
 * 貪欲法 AI（対戦相手の「ふつう」）が使う
 */
export const CLASS_WEIGHTS = classTable as Partial<Record<ClassId, Partial<EvalWeights>>>;

// ---- マリガン（rust/engine/src/ai/mulligan.rs） ----

/**
 * デッキ名 → カードID → [1 枚目を残す重み, 2 枚目も残す重み]。
 * 重みは「初手にあるとき、残すと返すより勝率がどれだけ上がるか」（0〜1 の差）。正なら残す
 */
export type MulliganWeights = Record<string, Record<string, [number, number]>>;

/** 推定した重み（以前の scripts/mulligan-fit-main.ts で推定した。今の探索 AI のマリガンは MULLIGAN_MODEL を使う） */
export const MULLIGAN_WEIGHTS: MulliganWeights = parseMulliganWeights(mulliganTable);

/** JSON の重みを検証して読む */
export function parseMulliganWeights(raw: unknown): MulliganWeights {
  const fail = (msg: string): never => {
    throw new Error(`マリガンの重みが不正です: ${msg}`);
  };
  if (typeof raw !== "object" || raw === null) return fail("オブジェクトではありません");
  const out: MulliganWeights = {};
  for (const [deck, cards] of Object.entries(raw)) {
    if (typeof cards !== "object" || cards === null) return fail(deck);
    const t: Record<string, [number, number]> = {};
    for (const [id, w] of Object.entries(cards as Record<string, unknown>)) {
      if (!Array.isArray(w) || w.length !== 2 || !w.every((v) => typeof v === "number" && Number.isFinite(v))) return fail(`${deck} ${id}`);
      t[id] = [w[0] as number, w[1] as number];
    }
    out[deck] = t;
  }
  return out;
}

/** 役割（data/mulligan-roles.json の書き方のまま） */
export const ROLES = ["1PP", "2PP", "3PP", "除去", "リソース", "展開", "回復", "ダメージ", "進化", "超進化", "シナジー与", "シナジー受"] as const;
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
 * 重い はコスト 6 以上の枚数（役割とは別に自動で数える。ユーザー判断）、dup は同じカードの重複（2 枚目以降）の枚数、kept は残した枚数。
 * 1PPxRes は 1PP の動きがある × リソースの枚数（1PP で手札を使う分とリソースの兼ね合い）、
 * synergy はシナジー与とシナジー受が両方ある、*xSecond は後攻との組み合わせ
 */
export const MODEL_FEATURES: readonly string[] = [
  ...ROLES.flatMap((r) => [`${r}>=1`, `${r}>=2`]),
  "重い>=1",
  "重い>=2",
  "dup",
  "kept",
  "1PPxRes",
  "synergy",
  "1PPxSecond",
  "2PPxSecond",
  "3PPxSecond",
];

/** デッキごとの係数（scripts/mulligan-model-fit-main.ts で推定した。git の履歴を参照） */
export type MulliganModel = Record<string, { features: Record<string, number>; cards: Record<string, number> }>;

export const MULLIGAN_MODEL: MulliganModel = modelTable as MulliganModel;
