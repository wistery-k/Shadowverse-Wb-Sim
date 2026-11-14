// 前期のローテーションのビショップのカード能力（トークン・結晶の姿を含む）

import type { CardAbilities, Effect } from "../../../engine/dsl";
import {
  ENHANCED,
  OPP_LEADER,
  OWN_TURN,
  THIS,
  act,
  addToHand,
  allFollowers,
  allyAmulets,
  allyCards,
  allyFollowers,
  banish,
  boardCards,
  choose,
  choseAllyAmulet,
  countAtLeast,
  crest,
  damage,
  destroy,
  draw,
  exists,
  fanfare,
  gainPp,
  grant,
  handCards,
  heal,
  id,
  inOrder,
  lastWords,
  mode,
  modeAllIf,
  onAllyAct,
  onAllyAmuletDestroyed,
  onAllyDraw,
  onEnter,
  onEvolve,
  onSuperEvolve,
  onTurnEnd,
  oppFollowers,
  otherBoardCards,
  random,
  returnToDeck,
  slot,
  specialId,
  spell,
  spendFaith,
  summon,
  summonDestroyedAmulets,
  transform,
  when,
} from "./helpers";

const countdown = (amount: number): Effect => ({ op: "countdown", target: THIS, amount });
/** 陽光の耳飾り: 自分の手札1枚を選ぶ。それをデッキに戻す。自分のデッキから1枚を引く（アクトでは、選んでからこれを破壊する） */
const earringChoose: Effect = choose(handCards(), 1, "h");
const earringRest: Effect[] = [returnToDeck(slot("h")), draw(1)];
/** 選んだ場のカードを破壊する。自分のアミュレットを選んだなら then（破壊する前に見る） */
const destroyChosen = (...then: Effect[]): Effect => when(choseAllyAmulet(), [destroy(slot()), ...then], [destroy(slot())]);
/** 「このバトル中に破壊された自分の『元のコスト2以下の、【ラストワード】を持つアミュレット』」 */
const SMALL_LAST_WORDS_AMULET = { costMax: 2, lastWords: true };
/** アドアマネージャー・イニシア */
const iniciaEffects: Effect[] = [choose(oppFollowers()), banish(slot()), when(countAtLeast(allyAmulets(), 3), [heal(3)])];

export const BISHOP: Record<string, CardAbilities> = {
  [id("魔杖の外科医・ティコ")]: {
    abilities: [onAllyAct(heal(1)), onEvolve(choose(oppFollowers()), damage(slot(), 3))],
  },
  [id("陽光の耳飾り")]: {
    abilities: [fanfare(earringChoose, ...earringRest), act(0, earringChoose, destroy(THIS), ...earringRest)],
  },
  [id("海蝕の三叉槍")]: {
    abilities: [
      fanfare(choose(oppFollowers()), damage(slot(), 4)),
      act(0, choose(oppFollowers()), destroy(THIS), damage(slot(), 2)),
    ],
  },
  [id("朋友の学級")]: {
    abilities: [
      onTurnEnd(
        draw(1),
        when(exists(allyFollowers({ superEvolved: true })), [heal(2)], [when(exists(allyFollowers({ evolved: true })), [heal(1)])]),
      ),
    ],
  },
  [id("旧き天書・リアントース")]: {
    abilities: [
      fanfare(choose(otherBoardCards(), 3), destroy(slot())),
      onTurnEnd(spendFaith("旧き天書・リアントース", 10, addToHand("天書の深淵"))),
    ],
  },
  [id("救済の聖典")]: { abilities: [lastWords(draw(2), damage(oppFollowers(), 2), heal(2))] },
  [id("崇高の憎悪・カンディマ")]: {
    abilities: [
      fanfare(summonDestroyedAmulets(SMALL_LAST_WORDS_AMULET, 2, true)),
      onSuperEvolve(choose(otherBoardCards()), destroyChosen(damage(oppFollowers(), 3))),
    ],
  },
  [id("崇高の天書")]: {
    abilities: [
      fanfare(choose(otherBoardCards()), destroyChosen(gainPp(2))),
      lastWords(summonDestroyedAmulets(SMALL_LAST_WORDS_AMULET, 1, false)),
    ],
  },
  [id("崇奉の怯者")]: { abilities: [onEnter(heal(2))] },
  [specialId("崇奉の怯者", "crystallize")]: { abilities: [lastWords(summon("崇奉の怯者"))] },
  [id("リーリエ・ライツ")]: {
    abilities: [act(2, choose(allyFollowers()), destroy(THIS), transform(slot(), "リーリエ・ライツ"), draw(1))],
  },
  [id("汚濁の聖水")]: {
    abilities: [lastWords(draw(1), random(oppFollowers()), destroy(slot())), act(1, countdown(-1))],
  },
  [id("アドアマネージャー・イニシア")]: { abilities: [fanfare(...iniciaEffects), onSuperEvolve(...iniciaEffects)] },
  [id("神紋ユラティオ")]: {
    abilities: [fanfare(destroy(allFollowers())), act(1, destroy(THIS), draw(1), heal(1))],
  },
  [id("無欠の時計")]: {
    abilities: [
      fanfare(when(ENHANCED, [damage(oppFollowers(), 1)])),
      act(0, destroy(THIS), damage(oppFollowers(), 1)),
    ],
  },
  [id("翼天の変貌・オルメリオ")]: {
    abilities: [
      onAllyAmuletDestroyed(
        inOrder([random(oppFollowers(), 2), damage(slot(), 3)], [heal(2)], [summon("ホーリーファルコン")]),
      ),
      onEvolve(destroy(allyAmulets())),
    ],
  },
  [id("刻みし約束")]: {
    abilities: [
      spell(
        modeAllIf(exists(allyCards({ costMin: 6 })), [random(oppFollowers()), damage(slot(), 3)], [heal(2)]),
      ),
    ],
  },
  [id("レ・フィーエの宝石")]: {
    abilities: [act(0, destroy(THIS), mode([random(oppFollowers()), destroy(slot())], [draw(2)]))],
  },

  // トークン
  [id("天書の深淵")]: {
    abilities: [spell(choose(boardCards()), destroyChosen(damage(OPP_LEADER, 2)), addToHand("天書の深淵"))],
  },

  // ---- クキシロB ----
  [id("結びの使徒")]: {
    abilities: [
      fanfare(when(ENHANCED, [draw(1), grant(THIS, ["bane"])])),
      onAllyDraw({}, when(OWN_TURN, [grant(THIS, ["rush"])])),
    ],
  },
  [id("英雄幻視・トルー")]: { abilities: [onAllyAct(grant(THIS, ["drain"]))] },
  [id("霧巻花の激憤")]: { abilities: [spell(random(handCards(), 1, "r"), returnToDeck(slot("r")), draw(3))] },
  [id("堅固なる霧巻花")]: {
    abilities: [
      fanfare(choose(oppFollowers()), damage(slot(), 5)),
      act(0, destroy(THIS), random(handCards(), 2, "r"), returnToDeck(slot("r")), draw(2)),
    ],
  },
  [id("窮鼠の斎女")]: {
    abilities: [
      fanfare(draw(1)),
      onAllyDraw({}, when(OWN_TURN, [damage(oppFollowers(), 1)])),
      onEvolve(draw(1)),
    ],
  },
  [id("希望の光彩・リテュエル")]: {
    abilities: [
      fanfare(mode([damage(oppFollowers(), 3)], [damage(OPP_LEADER, 3)], [heal(3)]), damage(THIS, 3)),
      onEvolve(crest("希望の光彩・リテュエル")),
    ],
  },
  [specialId("ミラクルアルミラージ", "crystallize")]: {
    abilities: [lastWords(summon("ミラクルアルミラージ")), act(1, countdown(-1))],
  },
  [id("霧巻花・クキシロ")]: {
    abilities: [fanfare(crest("霧巻花・クキシロ"), random(handCards(), 2, "r"), returnToDeck(slot("r")), draw(2))],
  },
};
