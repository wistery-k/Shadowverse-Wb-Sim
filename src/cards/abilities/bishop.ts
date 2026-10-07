// ビショップのカード能力（トークン含む）

import type { CardAbilities } from "../../engine/dsl";
import {
  OPP_LEADER,
  THIS,
  act,
  allFollowers,
  allyAmulets,
  allyFollowers,
  banish,
  buff,
  choose,
  costChange,
  crest,
  damage,
  destroy,
  discard,
  draw,
  fanfare,
  grant,
  grantAttacks,
  handCards,
  heal,
  id,
  lastWords,
  onAllyAct,
  onAllyDestroyed,
  onClash,
  onEvolve,
  onSuperEvolve,
  onSuperEvolveInstead,
  oppFollowers,
  otherAllyFollowers,
  random,
  slot,
  spell,
  summon,
  union,
  v,
} from "./helpers";

const countdown = (amount: number) => ({ op: "countdown", target: THIS, amount }) as const;

export const BISHOP: Record<string, CardAbilities> = {
  [id("癒しのシスター")]: { abilities: [fanfare(heal(5))] },
  [id("ウィングウォーリアー")]: {
    abilities: [
      fanfare(choose(otherAllyFollowers()), buff(slot(), 1, 1)),
      onEvolve(choose(otherAllyFollowers()), buff(slot(), 1, 1)),
    ],
  },
  [id("投影の鳥像")]: { abilities: [lastWords(summon("壮麗なる隼")), act(2, countdown(-2))] },
  [id("鉄拳の神父")]: {
    abilities: [
      onEvolve(choose(oppFollowers({ defenseMax: 3 })), banish(slot())),
      onSuperEvolveInstead(banish(oppFollowers({ defenseMax: 3 }))),
    ],
  },
  [id("セイクリッドグリフォン")]: { abilities: [onAllyAct(grant(THIS, ["storm"]))] },
  [id("有翼の石像")]: { abilities: [lastWords(summon("ホーリーファルコン")), act(1, countdown(-1))] },
  [id("聖心のプリズムプリースト")]: {
    abilities: [
      fanfare(draw(1, { type: "amulet" })),
      onEvolve(choose(handCards({ type: "amulet" })), costChange(slot(), -1)),
    ],
  },
  [id("標を与えるレディアンスエンジェル")]: { abilities: [fanfare(draw(2), heal(2))] },
  [id("潜みしマイニュ")]: { abilities: [onAllyAct(buff(THIS, 1, 0, "endOfTurn"))] },
  [id("穏やかなる教会")]: { abilities: [lastWords(draw(2)), act(1, countdown(-1))] },
  [id("フェザーレイン")]: { abilities: [spell(damage(oppFollowers(), 3), summon("ホーリーファルコン"))] },
  [id("煌槍のアルミラージ・サリッサ")]: {
    abilities: [onAllyDestroyed({ keyword: "ward" }, buff(THIS, 1, 1)), onEvolve(grant(THIS, ["barrier"]))],
  },
  [id("煌翼のフェザーフォルク・リノ")]: {
    abilities: [onClash(damage(OPP_LEADER, 1)), onSuperEvolve(grantAttacks(THIS, 2))],
  },
  [id("大地の守護神・ミーヴェ")]: { abilities: [lastWords({ op: "summonDestroyedAmulet" })] },
  [id("禁密の聖地")]: { abilities: [act(1, choose(allyFollowers()), buff(slot(), 1, 1), heal(1))] },
  [id("セイクリッドインジェクション")]: {
    abilities: [act(0, destroy(THIS), choose(oppFollowers()), damage(slot(), 4), heal(1))],
  },
  [id("終焉のスカルフェイン")]: {
    abilities: [fanfare(destroy(allyAmulets(), "x"), damage(union(oppFollowers(), OPP_LEADER), v("x")))],
  },
  [id("禁密の天宮・ロナヴェロ")]: { abilities: [onEvolve(choose(oppFollowers()), destroy(slot()))] },
  [id("大いなる熾天使・ラピス")]: { abilities: [lastWords(crest("大いなる熾天使・ラピス"))] },
  [id("獣姫の誓約")]: { abilities: [lastWords(summon("ホーリーフレイムタイガー")), act(1, countdown(-1))] },
  [id("邪教の器")]: { abilities: [act(0, destroy(THIS), destroy(allFollowers()))] },
  [id("裁決のアナテマ・ロデオ")]: {
    abilities: [
      fanfare(
        choose(handCards()),
        discard(slot()),
        { op: "summonFromDeck", filter: { type: "amulet", costMax: 3 }, kinds: 3 },
      ),
      onSuperEvolve(
        random({ kind: "maxAttack", of: oppFollowers() }),
        destroy(slot()),
        damage(oppFollowers(), 1),
      ),
    ],
  },
  [id("純白の聖女・ジャンヌ")]: {
    abilities: [fanfare(damage(oppFollowers(), 6), buff(otherAllyFollowers(), 2, 4))],
  },
  [id("水の守護神・サレファ")]: { abilities: [fanfare(heal(3)), onEvolve(damage(oppFollowers(), 3))] },
};
