// 前期のローテーションのウィッチのカード能力（トークン含む）

import type { CardAbilities } from "../../../engine/dsl";
import {
  ENHANCED,
  EVENT,
  OPP_LEADER,
  OUGI,
  THIS,
  THIS_FUSED,
  THIS_X,
  addSigils,
  addToDeck,
  addToHand,
  allFollowers,
  allyFollowers,
  buff,
  choose,
  costChange,
  crest,
  damage,
  discard,
  draw,
  enteredCount,
  fanfare,
  gainPp,
  grant,
  grantAttacks,
  handCards,
  heal,
  id,
  lastWords,
  onAllyEnter,
  onEnter,
  onEvolve,
  onFused,
  onSpellboost,
  onSuperEvolve,
  oppFollowers,
  opponentDraws,
  random,
  repeat,
  slot,
  spell,
  spellboost,
  spendPp,
  summon,
  transform,
  valueAtLeast,
  when,
} from "./helpers";

const addX = { op: "addX", target: THIS, amount: 1 } as const;
/** 自分の場の『没入の実験体』 */
const allySubjects = () => allyFollowers({ ids: [id("没入の実験体")] });
const cheaper = onSpellboost(costChange(THIS, -1));

export const WITCH: Record<string, CardAbilities> = {
  [id("歩む《愚者》・リンクル")]: {
    abilities: [fanfare(crest("歩む《愚者》・リンクル")), onSuperEvolve(addToDeck("歩む《愚者》・リンクル", 10))],
  },
  [id("ストームブラスト")]: {
    initialX: 2,
    abilities: [onSpellboost(addX), spell(choose(oppFollowers()), damage(slot(), THIS_X))],
  },
  [id("明越花の転変")]: { abilities: [spell(choose(handCards()), discard(slot()), draw(2))] },
  [id("睦まやかな団欒")]: { abilities: [spell(heal(2), spellboost(handCards(), 1))] },
  [id("マナリアスクリプター・ティコ")]: {
    abilities: [
      fanfare(addToHand("マナリアの魔弾", 2)),
      onEvolve(costChange(handCards({ type: "spell", tribe: "マナリア" }), -1)),
      onSuperEvolve(crest("マナリアスクリプター・ティコ")),
    ],
  },
  [id("鋼鉄の微睡み")]: {
    initialX: 0,
    abilities: [onSpellboost(addX), spell(draw(2), when({ kind: "thisXAtLeast", value: 5 }, [heal(2), gainPp(2)]))],
  },
  [id("ハッピーフラワー・サミー＆マリー")]: { abilities: [cheaper, fanfare(draw(2), opponentDraws(1))] },
  [id("恩愛の大地・テトラ＆ラティカ")]: {
    initialX: 0,
    abilities: [
      onSpellboost(addX),
      fanfare(
        when({ kind: "thisXAtLeast", value: 10 }, [addToHand("ソニック・フォー")]),
        when({ kind: "thisXAtLeast", value: 20 }, [addToHand("大いなる回帰")]),
      ),
    ],
  },
  [id("災いの言霊・ジンジャー")]: {
    abilities: [
      fanfare(summon("ガーディアンゴーレム", 2)),
      onAllyEnter({ type: "follower" }, grant(EVENT, ["rush"]), spellboost(handCards(), 1)),
      onEvolve(summon("ガーディアンゴーレム")),
    ],
  },
  [id("明越花・アラ")]: {
    abilities: [
      cheaper,
      fanfare(choose(oppFollowers()), damage(slot(), 10)),
      onEvolve(choose(allFollowers({ excludeSelf: true })), transform(slot(), "壮麗なる隼")),
    ],
  },
  [id("余情の俳人")]: { abilities: [cheaper, fanfare(draw(1)), lastWords(spellboost(handCards(), 1))] },
  [id("破式の変貌・フィーリン")]: { abilities: [cheaper] },

  // トークン
  [id("マナリアの魔弾")]: { abilities: [spell(random(oppFollowers()), damage(slot(), 3))] },
  [id("ソニック・フォー")]: { abilities: [spell(damage(oppFollowers(), 5))] },
  [id("大いなる回帰")]: { abilities: [spell(choose(allyFollowers()), grantAttacks(slot(), 2))] },

  // ---- 実験体W ----
  [id("過剰反応")]: { abilities: [spell(addToHand("真理の召喚", 3))] },
  [id("アルケミック・フレア")]: {
    abilities: [spell(choose(oppFollowers()), damage(slot(), 4), addSigils(1), when(OUGI, [damage(OPP_LEADER, 2)]))],
  },
  [id("没入の実験体")]: {
    // 「他の『没入の実験体』の枚数が5以上」: これ自身を含めて 6 以上（条件は働くときに見る）
    abilities: [onEnter(when(valueAtLeast(enteredCount("没入の実験体"), 6), [buff(THIS, 3, 3)]))],
  },
  [id("人らしい愛")]: {
    abilities: [
      spell(
        summon("没入の実験体", 1, "a"),
        buff(slot("a"), 1, 0),
        addToHand("没入の実験体", 1, "b"),
        buff(slot("b"), 1, 0),
      ),
    ],
  },
  [id("心酔の研究者")]: {
    abilities: [
      fanfare(
        when(ENHANCED, [summon("没入の実験体", 3, "c"), grant(slot("c"), ["ward"])], [summon("没入の実験体", 2)]),
      ),
      onEvolve(choose(allySubjects()), grant(slot(), ["bane"])),
    ],
  },
  [id("恍惚の才媛")]: {
    fusion: {},
    abilities: [
      fanfare(draw(2), summon("没入の実験体")),
      onSuperEvolve(when(THIS_FUSED, [choose(allySubjects()), grant(slot(), ["drain"])])),
    ],
  },
  [id("烏ノ涅")]: {
    abilities: [spell(summon("没入の実験体"), repeat(2, random(oppFollowers()), damage(slot(), 7)))],
  },
  [id("万術の咎人・セフィー")]: {
    fusion: {},
    abilities: [
      // PP が 2 未満でも融合できるが、PP は減らず、実験体も出ない（docs/rules.md 12章の 20）
      onFused(spendPp(2, summon("没入の実験体"))),
      fanfare(summon("没入の実験体", 2)),
      onSuperEvolve(crest("万術の咎人・セフィー")),
    ],
  },
  [id("魔恋の慕情・シイム")]: {
    abilities: [fanfare(summon("天晶の魔手", 2)), onSuperEvolve(crest("魔恋の慕情・シイム"))],
  },
  [id("ルーン・リチュオル")]: { abilities: [spell(damage(oppFollowers(), 6), heal(3))] },
};
