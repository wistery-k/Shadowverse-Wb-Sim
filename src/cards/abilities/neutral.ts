// ニュートラルのカード能力（トークン含む）

import type { CardAbilities } from "../../engine/dsl";
import {
  OPP_LEADER,
  act,
  addToHand,
  buff,
  choose,
  damage,
  destroy,
  draw,
  fanfare,
  gainPp,
  grant,
  heal,
  id,
  lastWords,
  onEvolve,
  onSuperEvolve,
  onSuperEvolveInstead,
  oppFollowers,
  allyFollowers,
  otherAllyFollowers,
  random,
  returnToDeck,
  handCards,
  slot,
  spell,
  summon,
  superEvolveIt,
  union,
  when,
  ENHANCED,
  THIS,
} from "./helpers";

export const NEUTRAL: Record<string, CardAbilities> = {
  [id("不屈のファイター")]: { abilities: [fanfare(when(ENHANCED, [buff(THIS, 3, 3)]))] },
  [id("ベルエンジェル・リア")]: { abilities: [lastWords(draw(1)), onEvolve(draw(1))] },
  [id("探偵のルーペ")]: {
    abilities: [act(0, destroy(THIS), choose(oppFollowers()), { op: "loseKeyword", target: slot(), keyword: "ward" })],
  },
  [id("煌響の使者・アンリエット")]: { abilities: [onEvolve(heal(2)), onSuperEvolveInstead(heal(4))] },
  [id("冒険者のギルド")]: {
    abilities: [
      fanfare(draw(1, { type: "follower" })),
      act(0, destroy(THIS), choose(allyFollowers()), grant(slot(), ["rush"])),
    ],
  },
  [id("グリードケルブ・ルビィ")]: { abilities: [fanfare(choose(handCards()), returnToDeck(slot()), draw(1))] },
  [id("観察の探偵")]: { abilities: [lastWords(addToHand("探偵のルーペ"))] },
  [id("ゴブリンの襲撃")]: { abilities: [spell(summon("ゴブリン", 5))] },
  [id("迸る光明・アポロン")]: {
    abilities: [fanfare(damage(oppFollowers(), 1)), onEvolve(damage(oppFollowers(), 1))],
  },
  [id("熾天使の福音")]: { abilities: [spell(draw(2))] },
  [id("楽朗の天宮・フィルドア")]: { abilities: [onEvolve(choose(oppFollowers()), destroy(slot()))] },
  [id("神の雷霆")]: {
    abilities: [
      spell(random({ kind: "maxAttack", of: oppFollowers() }), destroy(slot()), damage(oppFollowers(), 1)),
    ],
  },
  [id("勇壮の堕天使・オリヴィエ")]: {
    abilities: [
      fanfare(draw(2), heal(2), gainPp(2)),
      onSuperEvolve(choose(otherAllyFollowers({ notEvolved: true })), superEvolveIt(slot())),
    ],
  },
  [id("最果ての罪・サタン")]: { abilities: [fanfare({ op: "apocalypseDeck" })] },

  // トークン
  [id("辺獄の悪鬼")]: {
    abilities: [fanfare(choose(oppFollowers(), 2), damage(union(slot(), OPP_LEADER), 6))],
  },
  [id("アスタロトの宣告")]: { abilities: [spell({ op: "setLeaderMaxHp", side: "opponent", value: 1 })] },
};
