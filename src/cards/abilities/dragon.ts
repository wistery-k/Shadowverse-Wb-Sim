// ドラゴンのカード能力（トークン含む）

import type { CardAbilities } from "../../engine/dsl";
import {
  AWAKENED,
  ENHANCED,
  OPP_LEADER,
  THIS,
  act,
  allFollowers,
  allyFollowers,
  buff,
  choose,
  crest,
  damage,
  destroy,
  discard,
  draw,
  evolveIt,
  fanfare,
  grant,
  handCards,
  heal,
  id,
  lastWords,
  onDiscarded,
  onEvolve,
  onEvolved,
  onSuperEvolve,
  onSuperEvolveInstead,
  oppFollowers,
  otherAllyFollowers,
  random,
  slot,
  spell,
  summon,
  when,
} from "./helpers";

export const DRAGON: Record<string, CardAbilities> = {
  [id("烈火のファイアリザード")]: { abilities: [fanfare(choose(oppFollowers()), damage(slot(), 1))] },
  [id("シャークソルジャー")]: { abilities: [fanfare(damage(OPP_LEADER, 6))] },
  [id("ドラゴニュートクラッシュ")]: {
    abilities: [spell(choose(oppFollowers()), when(AWAKENED, [damage(slot(), 4)], [damage(slot(), 2)]))],
  },
  [id("猛撃のドラゴンウォーリアー")]: {
    abilities: [
      onEvolve(choose(oppFollowers()), damage(slot(), 4)),
      onSuperEvolveInstead(damage(oppFollowers(), 4)),
    ],
  },
  [id("咆哮の竜使い")]: { abilities: [fanfare(when(ENHANCED, [summon("大翼のドラゴン")]))] },
  [id("竜の啓示")]: {
    abilities: [spell({ op: "addMaxPp", amount: 1 }, when({ kind: "maxPp", atLeast: 10 }, [draw(1)]))],
  },
  [id("雲海の騎竜兵")]: { abilities: [lastWords(summon("大翼のドラゴン"))] },
  [id("海溝の大剣竜")]: { abilities: [fanfare(when(AWAKENED, [grant(THIS, ["storm"])]))] },
  [id("駆け出しのドラゴンスレイヤー")]: { abilities: [fanfare(choose(oppFollowers()), destroy(slot()))] },
  [id("竜育の少女")]: {
    abilities: [fanfare(summon("ベビーファイアドレイク")), onEvolve(summon("ベビーファイアドレイク"))],
  },
  [id("白鱗の御使い")]: { abilities: [fanfare(when(AWAKENED, [heal(4)]))] },
  [id("ディザスターブレス")]: { abilities: [spell(damage(allFollowers(), 5))] },
  [id("煌牙の義勇・キット")]: { abilities: [onDiscarded(random(allyFollowers()), buff(slot(), 1, 0))] },
  [id("風を駆る者・エイファ")]: { abilities: [fanfare(when(AWAKENED, [grant(THIS, ["intimidate"])]))] },
  [id("風を読む者・ゼル")]: {
    abilities: [onSuperEvolve(choose(otherAllyFollowers()), grant(slot(), ["storm"]))],
  },
  [id("艶麗なる竜人・マリオン")]: {
    abilities: [
      fanfare(choose(otherAllyFollowers()), when(AWAKENED, [buff(slot(), 3, 3)], [buff(slot(), 2, 2)])),
    ],
  },
  [id("栄弦の奏楽")]: { abilities: [spell(draw(2), when(AWAKENED, [heal(2)]))] },
  [id("栄弦の天宮・リュウフウ")]: {
    abilities: [fanfare(when(AWAKENED, [evolveIt()])), onEvolved({ op: "addMaxPp", amount: 1 })],
  },
  [id("荒波のドラグーン・ザハール")]: { abilities: [fanfare(summon("大翼のドラゴン"))] },
  [id("ナイトフォールドラゴン")]: {
    abilities: [fanfare(buff(oppFollowers(), 0, -9)), onSuperEvolve(draw(3))],
  },
  [id("乙姫の扇")]: {
    abilities: [act(3, summon("乙姫お守り隊"), choose(handCards()), discard(slot()))],
  },
  [id("灼熱のアナテマ・バーンドナイト")]: {
    abilities: [
      fanfare(choose(handCards()), discard(slot()), damage(oppFollowers(), { kind: "costOf", slot: "t" })),
      onSuperEvolve(crest("灼熱のアナテマ・バーンドナイト", "opponent")),
    ],
  },
  [id("龍人演義・ガリュウ")]: {
    abilities: [
      fanfare(summon("覇道の金龍"), summon("覇道の銀龍")),
      onSuperEvolve(
        grant(allyFollowers({ ids: [id("覇道の金龍")] }), ["storm"]),
        grant(allyFollowers({ ids: [id("覇道の銀龍")] }), ["barrier"]),
      ),
    ],
  },
};
