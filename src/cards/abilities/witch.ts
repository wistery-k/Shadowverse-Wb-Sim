// ウィッチのカード能力（トークン含む）

import type { CardAbilities } from "../../engine/dsl";
import {
  ENHANCED,
  SIGILS,
  THIS,
  THIS_ATTACK,
  THIS_X,
  act,
  addSigils,
  allFollowers,
  allyFollowers,
  buff,
  choose,
  costChange,
  count,
  crest,
  damage,
  destroy,
  draw,
  earthRite,
  evolveIt,
  fanfare,
  gainPp,
  grant,
  handCards,
  heal,
  id,
  lastWords,
  mode,
  onEnter,
  onEvolve,
  onEvolved,
  onOpponentTurnEnd,
  onSpellboost,
  onSuperEvolve,
  oppFollowers,
  random,
  returnToDeck,
  slot,
  spell,
  spellboost,
  summon,
  transform,
  when,
} from "./helpers";

const addX = { op: "addX", target: THIS, amount: 1 } as const;
const cheaper = onSpellboost(costChange(THIS, -1));
const shikigami = { type: "follower", tribe: "式神" } as const;

export const WITCH: Record<string, CardAbilities> = {
  [id("閃光の魔法剣士")]: {
    abilities: [
      fanfare(mode([spellboost(handCards(), 2)], [earthRite(1, buff(THIS, 2, 2), grant(THIS, ["ward"]))])),
    ],
  },
  [id("魔女の錬金釜")]: { abilities: [fanfare(draw(1)), act(1, addSigils(1))] },
  [id("知恵の輝き")]: { abilities: [spell(draw(1))] },
  [id("真理の召喚")]: { abilities: [spell(summon("クレイゴーレム"))] },
  [id("相貌の魔女・レミラミ")]: {
    abilities: [
      fanfare(earthRite(1, summon("ガーディアンゴーレム"))),
      onSuperEvolve(choose(allyFollowers({ tribe: "ゴーレム" })), evolveIt(slot()), buff(slot(), 3, 3)),
    ],
  },
  [id("ブレイズデストロイヤー")]: { abilities: [cheaper] },
  [id("イラプション")]: { abilities: [spell(damage(allFollowers(), 2), earthRite(1, draw(1)))] },
  [id("ルーンブレイドコンダクター")]: {
    abilities: [onSpellboost(buff(THIS, 1, 1)), fanfare(choose(oppFollowers()), damage(slot(), THIS_ATTACK))],
  },
  [id("見習い占星術師")]: {
    abilities: [fanfare(choose(handCards()), returnToDeck(slot()), draw(1), addSigils(1))],
  },
  [id("オウルサモナー")]: {
    abilities: [fanfare(addSigils(1)), onEvolve(choose(oppFollowers()), damage(slot(), 5))],
  },
  [id("夢想のペンギンウィザード")]: { abilities: [fanfare(draw(2)), onEvolve(spellboost(handCards(), 2))] },
  [id("虹の奇跡")]: {
    abilities: [spell(choose(handCards({ spellboost: true })), spellboost(slot(), 1), draw(1))],
  },
  [id("ストームブラスト")]: {
    initialX: 2,
    abilities: [onSpellboost(addX), spell(choose(oppFollowers()), damage(slot(), THIS_X))],
  },
  [id("アドラブルティーチャー・ミラ")]: {
    abilities: [
      fanfare(spellboost(handCards(), 1)),
      onEvolve(choose(oppFollowers()), damage(slot(), 3), spellboost(handCards(), 1)),
    ],
  },
  [id("ワンダーウィッチ・エミル")]: {
    abilities: [
      cheaper,
      onEvolve(summon("クレイゴーレム"), damage(oppFollowers(), count(allyFollowers({ tribe: "ゴーレム" })))),
    ],
  },
  [id("マナリアの学徒・ウィリアム")]: {
    initialX: 0,
    abilities: [onSpellboost(addX), fanfare(damage(oppFollowers(), THIS_X)), onEvolve(spellboost(handCards(), 2))],
  },
  [id("理光の証明")]: {
    abilities: [spell(mode([addSigils(4)], [heal(4)], [earthRite(3, damage(oppFollowers(), 4))]))],
  },
  [id("スノーアウェイク")]: {
    abilities: [
      cheaper,
      spell(
        choose(oppFollowers()),
        { op: "setDefense", target: slot(), value: 1 },
        { op: "cannotAttack", target: slot(), until: "opponentTurnEnd" },
      ),
    ],
  },
  [id("黎明の錬金術師・ノノ")]: {
    abilities: [
      fanfare(choose(oppFollowers()), damage(slot(), SIGILS)),
      onEvolve(crest("黎明の錬金術師・ノノ")),
    ],
  },
  [id("魔法の薬剤師・ペネロピー")]: {
    abilities: [fanfare(addSigils(2)), onSuperEvolve(draw(2), heal(2), addSigils(2))],
  },
  [id("理光の天宮・エーデルワイス")]: {
    abilities: [
      fanfare(earthRite(2, evolveIt())),
      onEvolved(random(oppFollowers()), damage(slot(), 4), gainPp(2)),
    ],
  },
  [id("宿題やるですぅ！")]: {
    initialX: 0,
    abilities: [
      onSpellboost(addX, when({ kind: "thisXAtLeast", value: 5 }, [transform(THIS, "成長したですぅ！")])),
      spell(draw(2)),
    ],
  },
  [id("鬼呼びの術")]: { abilities: [cheaper, spell(summon("式神・暴鬼"))] },
  [id("五行の果て・クオン")]: {
    abilities: [
      fanfare(
        summon("式神・天后"),
        summon("式神・暴鬼"),
        summon("式神・形代"),
        when(ENHANCED, [destroy(allyFollowers({ tribe: "式神" })), summon("式神・貴人")]),
      ),
      onSuperEvolve(choose(allyFollowers({ tribe: "式神" })), grant(slot(), ["storm"])),
    ],
  },
  [id("マナリアフレンズ・アン＆グレア")]: {
    abilities: [
      fanfare(summon("アンの大英霊"), spellboost(handCards(), 3)),
      onEvolve(choose(oppFollowers()), damage(slot(), 3)),
    ],
  },
  [id("オーバーディメンション")]: {
    abilities: [
      cheaper,
      spell(returnToDeck(handCards()), draw(5), spellboost(handCards(), 5), gainPp("max")),
    ],
  },

  // トークン
  [id("式神・形代")]: { abilities: [lastWords(spellboost(handCards(), 1))] },
  [id("式神・暴鬼")]: { abilities: [lastWords(spellboost(handCards(), 1))] },
  [id("大地の魔片")]: { abilities: [act(1, addSigils(1))] },
  [id("成長したですぅ！")]: { abilities: [spell(draw(2), random(oppFollowers()), damage(slot(), 2))] },
  [id("式神・天后")]: { abilities: [lastWords(spellboost(handCards(), 3))] },
  [id("式神・貴人")]: {
    abilities: [
      onEnter(
        buff(
          THIS,
          { kind: "destroyedThisTurn", stat: "attack", filter: shikigami },
          { kind: "destroyedThisTurn", stat: "defense", filter: shikigami },
        ),
      ),
    ],
  },
  [id("アンの大英霊")]: { abilities: [onOpponentTurnEnd(destroy(THIS))] },
};
