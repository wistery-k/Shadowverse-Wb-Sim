// ロイヤルのカード能力（トークン含む）

import type { CardAbilities } from "../../engine/dsl";
import {
  ENHANCED,
  EVENT,
  OPP_LEADER,
  THIS,
  allyFollowers,
  buff,
  choose,
  crest,
  damage,
  destroy,
  draw,
  fanfare,
  gainPp,
  grant,
  grantAttacks,
  handCards,
  heal,
  id,
  lastWords,
  mode,
  onAllyEnter,
  onAttack,
  onEvolve,
  onSuperEvolve,
  oppFollowers,
  otherAllyFollowers,
  returnToDeck,
  slot,
  spell,
  summon,
  union,
  when,
} from "./helpers";

const soldier = { type: "follower", tribe: "兵士" } as const;
const royalFollower = { class: "royal", type: "follower" } as const;

export const ROYAL: Record<string, CardAbilities> = {
  [id("バトルマーチャント")]: { abilities: [lastWords(draw(1))] },
  [id("メイドの作法")]: {
    abilities: [spell(choose(handCards()), returnToDeck(slot()), draw(2, royalFollower))],
  },
  [id("王家の御者")]: { abilities: [lastWords(summon("ナイト"))] },
  [id("魔煌のトリックスター・ラスティ")]: {
    abilities: [
      onSuperEvolve(
        { op: "drawAll", filter: { ids: [id("魔煌のトリックスター・ラスティ")] }, slot: "d" },
        grant(slot("d"), ["storm"]),
      ),
    ],
  },
  [id("正統なる王冠")]: { abilities: [onAllyEnter({ type: "follower" }, buff(EVENT, 1, 1))] },
  [id("愛の騎士・イアン")]: { abilities: [fanfare(choose(otherAllyFollowers()), buff(slot(), 1, 1))] },
  [id("ピースディーラー・エルネスタ")]: {
    abilities: [fanfare(buff(otherAllyFollowers(), 1, 1)), onEvolve(buff(otherAllyFollowers(), 1, 1))],
  },
  [id("救援のルミナスヒーラー・リララ")]: {
    abilities: [fanfare(summon("スティールナイト")), onAllyEnter(soldier, heal(1))],
  },
  [id("ミリタリードッグ")]: { abilities: [fanfare(when(ENHANCED, [summon("ミリタリードッグ", 2)]))] },
  [id("異端の侍")]: { abilities: [fanfare(when({ kind: "superEvolveTurn" }, [grant(THIS, ["bane"])]))] },
  [id("剣士の斬撃")]: { abilities: [spell(choose(oppFollowers()), destroy(slot()), summon("スティールナイト"))] },
  [id("統率のルミナスナイト")]: {
    abilities: [onAllyEnter(soldier, buff(THIS, 1, 0, "endOfTurn")), onEvolve(summon("ナイト"))],
  },
  [id("卓越のルミナスメイジ")]: {
    abilities: [fanfare(summon("スティールナイト", 3)), onAllyEnter(soldier, grant(EVENT, ["ward"]))],
  },
  [id("勇猛のルミナスランサー")]: {
    abilities: [fanfare(summon("ナイト")), onAllyEnter(soldier, grant(EVENT, ["rush"]))],
  },
  [id("忍びのムササビ")]: { abilities: [onEvolve(summon("忍びのムササビ"))] },
  [id("王断の威光")]: {
    abilities: [spell(mode([summon("スティールナイト"), summon("ナイト")], [buff(allyFollowers(), 1, 1)]))],
  },
  [id("レヴィオンアックス・ジェノ")]: { abilities: [onAttack(grant(THIS, ["barrier"]), summon("ナイト"))] },
  [id("サイレントスナイパー・ワルツ")]: {
    abilities: [
      fanfare(
        choose(oppFollowers()),
        damage(slot(), 5),
        when(ENHANCED, [buff(THIS, 2, 2), grant(THIS, ["ambush"])]),
      ),
    ],
  },
  [id("王断の天宮・スタチウム")]: {
    abilities: [onEvolve(summon("ナイト", 2), buff(otherAllyFollowers(), 1, 1))],
  },
  [id("煌刃の勇者・アマリア")]: {
    abilities: [
      fanfare(summon("スティールナイト", 4)),
      onAllyEnter({ type: "follower" }, buff(EVENT, 1, 0), grant(EVENT, ["rush", "ward"])),
    ],
  },
  [id("テンタクルバイト")]: {
    abilities: [spell(choose(union(oppFollowers(), OPP_LEADER)), damage(slot(), 5), heal(5))],
  },
  [id("レヴィオンの迅雷・アルベール")]: {
    abilities: [fanfare(when(ENHANCED, [damage(oppFollowers(), 3), grantAttacks(THIS, 2)]))],
  },
  [id("白銀の騎士団長・エミリア")]: {
    abilities: [
      fanfare(draw(2, royalFollower), gainPp(3)),
      onSuperEvolve(grant(otherAllyFollowers({ class: "royal" }), ["barrier"])),
    ],
  },
  [id("常在戦場・カゲミツ")]: {
    abilities: [lastWords(crest("常在戦場・カゲミツ")), onSuperEvolve(grant(THIS, ["storm"]))],
  },
};
