// 前期のローテーションのネメシスのカード能力（トークン含む）

import type { CardAbilities, CardFilter, Effect } from "../../../engine/dsl";
import {
  ARTIFACT_FOLLOWER,
  DECK_UNIQUE,
  ENHANCED,
  EVENT,
  OPP_LEADER,
  OUGI,
  RELEASED_OUGI,
  SUPER_EVOLVE_TURN,
  THIS,
  THIS_EVOLVED,
  addCopyToHand,
  addDestroyedCopy,
  addToHand,
  allyFollowers,
  banish,
  boardCards,
  buff,
  choose,
  costChange,
  costChangeUntilEnd,
  count,
  crest,
  damage,
  destroy,
  discard,
  distribute,
  draw,
  drawKinds,
  enteredKinds,
  evolveIt,
  exists,
  fanfare,
  grant,
  handCards,
  heal,
  id,
  lastWords,
  modeAllIf,
  onAllyEnter,
  onAllyPlay,
  onEnter,
  onEvolve,
  onEvolved,
  onSuperEvolve,
  onTurnEnd,
  onTurnStart,
  oppFollowers,
  oppHandCards,
  otherAllyFollowers,
  random,
  randomUnusedOption,
  repeat,
  slot,
  specialId,
  spell,
  summon,
  summonCopy,
  transform,
  union,
  valueAtLeast,
  when,
} from "./helpers";

/** 「自分のデッキから【必殺】を持つネメシス・フォロワー1枚を引く」 */
const drawBaneNemesis: Effect = draw(1, {
  type: "follower",
  class: "nemesis",
  keyword: "bane",
});
/** 「このバトル中に場に出た自分のアーティファクト・フォロワーの種類が3以上なら」 */
const threeArtifactKinds = valueAtLeast(enteredKinds(ARTIFACT_FOLLOWER), 3);
/** 「相手の場のフォロワーからランダム1枚に1ダメージ。」を6回行う */
const sixPings: Effect = repeat(6, random(oppFollowers()), damage(slot(), 1));
/** 元のコスト5以上のフォロワー（場のカードのコストは元のコスト） */
const cost5Follower: CardFilter = { type: "follower", costMin: 5 };

export const NEMESIS: Record<string, CardAbilities> = {
  [id("誠心なる尽小花")]: {
    abilities: [spell(choose(boardCards()), transform(slot(), "イマリの小鬼"))],
  },
  [id("ストリートラン")]: {
    abilities: [
      spell(modeAllIf(threeArtifactKinds, [addToHand("アナライズアーティファクト")], [addToHand("エンシェントアーティファクト")])),
    ],
  },
  [id("青錆の下っ端")]: {
    abilities: [fanfare(when(DECK_UNIQUE, [choose(oppFollowers()), damage(slot(), 5)]))],
  },
  [id("屈辱なる放逐")]: {
    abilities: [spell(choose(handCards()), discard(slot()), drawBaneNemesis, when(DECK_UNIQUE, [draw(2)]))],
  },
  [id("束刃の咎人・カットスロート")]: {
    abilities: [onEvolve(drawBaneNemesis, when(DECK_UNIQUE, [crest("束刃の咎人・カットスロート")]))],
  },
  [id("報恩の技師・アイザック")]: {
    abilities: [lastWords(addToHand("アタックアーティファクト"))],
  },
  [id("尽小花・イマリ")]: {
    abilities: [
      fanfare(choose(handCards()), discard(slot()), draw(1, { type: "spell" })),
      onAllyPlay({ type: "spell" }, when(THIS_EVOLVED, [summon("イマリの小鬼")])),
      onSuperEvolve(drawKinds(2, { type: "spell", costMin: 1, costMax: 1 })),
    ],
  },
  [id("旧き天斧・ヨグゼンタ")]: {
    abilities: [fanfare(when(exists(allyFollowers(cost5Follower)), [addToHand("天斧の深淵")]))],
  },
  [id("チルスケーター")]: {
    abilities: [fanfare(addToHand("エンシェントアーティファクト")), onEvolve(addToHand("エンシェントアーティファクト"))],
  },
  [id("アナタの先輩・エース")]: {
    abilities: [
      fanfare(addToHand("アナライズアーティファクト")),
      onEvolve(choose(otherAllyFollowers({ notEvolved: true })), evolveIt(slot())),
    ],
  },
  [id("再起の夜王・ショウ")]: {
    abilities: [fanfare(when(SUPER_EVOLVE_TURN, [grant(THIS, ["barrier"])]))],
  },
  [id("廻る《運命の輪》・スロース")]: {
    abilities: [
      onTurnEnd(when(THIS_EVOLVED, [crest("廻る《運命の輪》・スロース", "opponent"), banish(THIS)])),
      // 働くのはターン開始時の手札だけ（その後に引くカードは含まない）
      onTurnStart(randomUnusedOption([costChangeUntilEnd(handCards(), -1)], [buff(allyFollowers(), 2, 2)], [heal(3)])),
    ],
  },
  [id("ワイルドキャスター")]: {
    abilities: [
      fanfare(summon("アナライズアーティファクト"), when(ENHANCED, [summon("ミスティックアーティファクト")])),
      onAllyEnter(ARTIFACT_FOLLOWER, grant(EVENT, ["rush"])),
    ],
  },
  [id("ポータルコネクター・ラズリ")]: {
    abilities: [fanfare(addToHand("レディアントアーティファクト"))],
  },
  [id("ハクガ燐斂")]: {
    // 選ぶのは、重複が無いときも先に行う（使うには相手のフォロワーが要る）
    abilities: [spell(choose(oppFollowers()), when(DECK_UNIQUE, [destroy(oppFollowers())], [destroy(slot())]))],
  },
  [id("奮励の追走・ミュー")]: {
    abilities: [
      onAllyEnter(ARTIFACT_FOLLOWER, random(oppFollowers()), damage(slot(), 3)),
      onEvolve(summon("エンシェントアーティファクト")),
      onSuperEvolve(when(threeArtifactKinds, [grant(THIS, ["storm"])])),
    ],
  },
  [id("ツインドローンガール")]: {
    abilities: [fanfare(summon("アナライズアーティファクト")), onEvolve(summon("アナライズアーティファクト"))],
  },
  [id("錬磨の用心棒")]: {
    // 重複が無いときだけ、ダメージも回復も（docs/rules.md 12章の質問 41）
    abilities: [fanfare(when(DECK_UNIQUE, [choose(oppFollowers()), damage(slot(), 4), heal(4)]))],
  },
  [id("決断の交差・アシュレイ＆リディア")]: {
    abilities: [
      fanfare(choose(oppFollowers()), grant(slot(), ["ward"]), when(ENHANCED, [evolveIt(), grant(THIS, ["storm"])])),
      onEvolved(random(oppFollowers({ keyword: "ward" }), 2), destroy(slot())),
    ],
  },
  [id("鋳鉄の腹心")]: {
    abilities: [fanfare(choose(oppFollowers()), destroy(slot()), when(DECK_UNIQUE, [grant(THIS, ["storm"])]))],
  },
  [id("ケイオス・レギオン")]: {
    abilities: [spell(when(RELEASED_OUGI, [damage(union(oppFollowers(), OPP_LEADER), 6)], [damage(union(oppFollowers(), OPP_LEADER), 3)]))],
  },
  [id("劣悪の純心・カミシラ")]: {
    abilities: [
      fanfare(summon("低劣の玩具"), summon("拙劣の人形")),
      onAllyEnter(cost5Follower, evolveIt(EVENT)),
      onSuperEvolve(damage(OPP_LEADER, count(allyFollowers(cost5Follower)))),
    ],
  },
  [id("低劣の玩具")]: { abilities: [fanfare(draw(3))] },
  [id("拙劣の人形")]: {
    abilities: [fanfare(summon("拙劣の人形", 1, "c"), evolveIt(union(slot("c"), THIS)))],
  },
  [id("弾哭の変貌・アイズエデン")]: {
    abilities: [
      fanfare(summon("撃針の看守")),
      onAllyEnter(ARTIFACT_FOLLOWER, random(oppFollowers()), destroy(slot())),
      onSuperEvolve(summon("撃針の看守")),
    ],
  },
  [id("虚刻のアナテマ・スカーレット")]: {
    abilities: [fanfare(damage(oppFollowers(), enteredKinds(ARTIFACT_FOLLOWER)))],
  },
  [id("デバイスマニピュレーター・ジルク")]: {
    abilities: [fanfare(addDestroyedCopy(ARTIFACT_FOLLOWER))],
  },
  [id("ステージメーカー")]: {
    // 【エンハンス】の「それ」は、出した 2 枚とも（docs/rules.md 12章の質問 40）
    abilities: [
      fanfare(
        summon("改良型・操り人形", 1, "a"),
        summon("操り人形", 1, "b"),
        when(ENHANCED, [grant(union(slot("a"), slot("b")), ["storm"])]),
      ),
    ],
  },
  [id("ネオジオグラファー")]: {
    abilities: [
      fanfare(addToHand("デストロイアーティファクトβ")),
      onSuperEvolve(choose(handCards({ ...ARTIFACT_FOLLOWER, costMax: 5 })), summonCopy()),
    ],
  },
  [id("光の理・ル・オー")]: {
    abilities: [fanfare(sixPings, buff(oppHandCards({ type: "follower" }), 1, 0), when(OUGI, [crest("光の理・ル・オー")]))],
  },
  [id("エッジーマスター")]: {
    abilities: [onAllyEnter(ARTIFACT_FOLLOWER, heal(1)), onEvolve(summon("ミスティックアーティファクト"))],
  },
  [id("ブライトクリエイター")]: {
    abilities: [fanfare(summon("デストロイアーティファクトα", 1, "a"), grant(slot("a"), ["bane", "ward"]))],
  },
  [id("エクセシブガーディアン・リオナ")]: {
    abilities: [onSuperEvolve(choose(otherAllyFollowers()), grant(slot(), ["ambush"]))],
  },
  [id("穢れなき日々")]: {
    abilities: [spell(draw(2), when(SUPER_EVOLVE_TURN, [heal(2)]))],
  },
  [id("ストーン・ブレイク")]: { abilities: [spell(sixPings)] },
  [id("愚劣の兵器")]: {
    abilities: [fanfare(summon("愚劣の兵器", 2)), onTurnEnd(distribute(oppFollowers(), 3)), onEvolve(distribute(oppFollowers(), 3))],
  },
  [specialId("愚劣の兵器", "accelerate")]: {
    abilities: [spell(summon("愚劣の兵器"))],
  },

  // トークン
  [id("アナライズアーティファクト")]: { abilities: [onEnter(draw(1))] },
  [id("天斧の深淵")]: {
    abilities: [spell(choose(allyFollowers(cost5Follower)), addCopyToHand("t", "c"), costChange(slot("c"), -3))],
  },
  [id("撃針の看守")]: { abilities: [lastWords(heal(2))] },
};
