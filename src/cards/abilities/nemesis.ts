// ネメシスのカード能力（トークン含む）

import type { CardAbilities, CardFilter } from "../../engine/dsl";
import {
  EVENT,
  OPP_LEADER,
  THIS,
  addToHand,
  allyFollowers,
  buff,
  choose,
  crest,
  damage,
  destroy,
  draw,
  fanfare,
  grant,
  grantAbilities,
  handCards,
  heal,
  id,
  lastWords,
  mode,
  onAllyEnter,
  onAllyFuse,
  onEvolve,
  onFused,
  onOpponentTurnEnd,
  onSuperEvolve,
  onSuperEvolveInstead,
  onTurnEnd,
  oncePerOwnTurn,
  oppFollowers,
  random,
  slot,
  spell,
  summon,
  transform,
  when,
} from "./helpers";

const puppet = { type: "follower", tribe: "人形" } as const;
const artifactFollowerInHand: CardFilter = { type: "follower", tribe: "アーティファクト", costMax: 5 };
const bothCores = [addToHand("フューチャー・コア"), addToHand("パスト・コア")];
const summonCopy = (from = "t", name?: string) =>
  (name ? { op: "summonCopy", from, slot: name } : { op: "summonCopy", from }) as { op: "summonCopy"; from: string; slot?: string };
const destroyAtOpponentTurnEnd = onOpponentTurnEnd(destroy(THIS));
const fusedCostAtLeast = (value: number) => ({ kind: "varAtLeast", name: "fusedCost", value }) as const;

/** アタックアーティファクト・キャッスルアーティファクトの融合による変身 */
const artifactFusion = onFused(
  when(
    fusedCostAtLeast(3),
    [transform(THIS, "デストロイアーティファクトγ")],
    [
      when(
        fusedCostAtLeast(2),
        [transform(THIS, "デストロイアーティファクトβ")],
        [transform(THIS, "デストロイアーティファクトα")],
      ),
    ],
  ),
);

export const NEMESIS: Record<string, CardAbilities> = {
  [id("砲撃の猫獣人")]: { abilities: [fanfare(addToHand("フューチャー・コア"))] },
  [id("マリオネットランサー")]: { abilities: [fanfare(addToHand("改良型・操り人形"))] },
  [id("異次元からの銃撃")]: { abilities: [spell(choose(oppFollowers()), destroy(slot()), ...bothCores)] },
  [id("エレクトロウィッパー")]: { abilities: [fanfare(addToHand("パスト・コア"))] },
  [id("魔鋼の騎兵")]: {
    abilities: [onEvolve(summon("魔鋼の騎兵")), onSuperEvolveInstead(summon("魔鋼の騎兵", 2))],
  },
  [id("ドールズシアター")]: {
    abilities: [fanfare(addToHand("操り人形")), onTurnEnd(addToHand("操り人形"))],
  },
  [id("ビビッドインベンター・イリス")]: { abilities: [lastWords(addToHand("パスト・コア"))] },
  [id("メタルマーセナリー・ディルク")]: { abilities: [fanfare(summon("キャッスルアーティファクト"))] },
  [id("アンストッパブルガンナー")]: {
    abilities: [fanfare(addToHand("フューチャー・コア")), onEvolve(choose(oppFollowers()), damage(slot(), 3))],
  },
  [id("オートマタアサシン")]: {
    abilities: [
      fanfare(addToHand("改良型・操り人形")),
      oncePerOwnTurn(onAllyEnter(puppet, grant(EVENT, ["bane"]))),
    ],
  },
  [id("人形の身代わり")]: { abilities: [spell(summon("改良型・操り人形", 2))] },
  [id("アーティファクトチャージ")]: { abilities: [spell(...bothCores)] },
  [id("ストラグルリーダー・ルキナ")]: {
    abilities: [fanfare(...bothCores), onEvolve(summon("アタックアーティファクト"))],
  },
  [id("愛執のドールユーザー")]: {
    abilities: [fanfare(addToHand("操り人形")), onEvolve(addToHand("操り人形"))],
  },
  [id("殺意の糸・ノア")]: {
    abilities: [fanfare(addToHand("操り人形", 3), buff(handCards(puppet), 1, 0))],
  },
  [id("命の奔流")]: {
    abilities: [spell(choose(oppFollowers()), damage(slot(), 3), addToHand("パスト・コア"))],
  },
  [id("改境の再動")]: {
    abilities: [
      spell(
        choose(handCards(artifactFollowerInHand), 2),
        summonCopy("t", "c"),
        grantAbilities(slot("c"), [destroyAtOpponentTurnEnd]),
      ),
    ],
  },
  [id("レゾリューション・ミリアム")]: { abilities: [fanfare(...bothCores), onEvolve(...bothCores)] },
  [id("箱庭の断罪者・シルヴィア")]: {
    abilities: [
      fanfare(mode([draw(2)], [heal(4)])),
      onEvolve(choose(oppFollowers()), destroy(slot())),
      onSuperEvolveInstead(choose(oppFollowers(), 2), destroy(slot())),
    ],
  },
  [id("狂気の創造者・リーアム")]: {
    abilities: [
      fanfare(summon("改良型・操り人形", 3)),
      onEvolve(
        grant(allyFollowers({ tribe: "人形" }), ["ward"]),
        grantAbilities(allyFollowers({ tribe: "人形" }), [lastWords(damage(OPP_LEADER, 2))]),
      ),
    ],
  },
  [id("改境の天宮・アルエット")]: {
    abilities: [fanfare(...bothCores), onEvolve(choose(handCards(artifactFollowerInHand)), summonCopy())],
  },
  [id("遺産の砲撃")]: {
    abilities: [
      fanfare(addToHand("フューチャー・コア")),
      onAllyFuse(random(oppFollowers()), damage(slot(), 2)),
    ],
  },
  [id("新たなる少女・エース")]: { abilities: [fanfare(draw(1)), onEvolve(crest("新たなる少女・エース"))] },
  [id("プロシードハート・オーキス")]: {
    abilities: [
      fanfare(summon("ロイド")),
      onAllyEnter(puppet, grant(EVENT, ["storm", "bane"])),
      onSuperEvolve(summon("改良型・操り人形", 2)),
    ],
  },
  [id("ブーストエクステンド・ララミア")]: {
    abilities: [
      fanfare(choose(handCards(artifactFollowerInHand), 3), summonCopy()),
      onSuperEvolve(buff(allyFollowers({ tribe: "アーティファクト" }), 1, 1)),
    ],
  },

  // トークン
  [id("操り人形")]: { abilities: [destroyAtOpponentTurnEnd] },
  [id("改良型・操り人形")]: { abilities: [destroyAtOpponentTurnEnd] },
  [id("フューチャー・コア")]: {
    unplayable: true,
    fusion: { type: "amulet", tribe: "アーティファクト" },
    abilities: [onFused(transform(THIS, "アタックアーティファクト"))],
  },
  [id("パスト・コア")]: {
    unplayable: true,
    fusion: { type: "amulet", tribe: "アーティファクト" },
    abilities: [onFused(transform(THIS, "キャッスルアーティファクト"))],
  },
  [id("アタックアーティファクト")]: { fusion: { tribe: "アーティファクト" }, abilities: [artifactFusion] },
  [id("キャッスルアーティファクト")]: { fusion: { tribe: "アーティファクト" }, abilities: [artifactFusion] },
  [id("デストロイアーティファクトα")]: {
    fusion: { ids: [id("デストロイアーティファクトβ"), id("デストロイアーティファクトγ")] },
    abilities: [
      onFused(when({ kind: "varAtLeast", name: "fusedKinds", value: 2 }, [transform(THIS, "イクシードアーティファクトΩ")])),
      onTurnEnd(heal(3)),
    ],
  },
  [id("デストロイアーティファクトβ")]: { abilities: [onTurnEnd(damage(OPP_LEADER, 3))] },
  [id("デストロイアーティファクトγ")]: { abilities: [onTurnEnd(damage(oppFollowers(), 3))] },
  [id("イクシードアーティファクトΩ")]: { abilities: [fanfare(damage(oppFollowers(), 5), heal(5))] },
  [id("ロイド")]: { onlySelectable: true, abilities: [] },
};
