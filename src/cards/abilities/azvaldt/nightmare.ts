// 前期のローテーションのナイトメアのカード能力（トークン含む）

import type { CardAbilities, Effect } from "../../../engine/dsl";
import {
  BOTH_LEADERS,
  ENHANCED,
  EVENT,
  LEADER_HP_ABOVE_OPPONENT,
  LOWEST_HP_LEADERS,
  OPP_LEADER,
  OWN_TURN,
  SELF_LEADER,
  THIS,
  addToHand,
  banishCopy,
  buff,
  choose,
  costChange,
  crest,
  damage,
  destroy,
  distribute,
  draw,
  evolveIt,
  fanfare,
  gainEp,
  gainPp,
  grant,
  handCards,
  heal,
  id,
  lastWords,
  leaderHpAtMost,
  loseLastWords,
  mode,
  necromancy,
  onAllyEnter,
  onAttack,
  onClash,
  onEvolve,
  onEvolved,
  onSuperEvolve,
  onTurnEnd,
  onTurnEndInHand,
  oppFollowers,
  otherAllyFollowers,
  random,
  reanimate,
  slot,
  specialId,
  spell,
  summon,
  summonFromDeck,
  union,
  when,
} from "./helpers";

/** バニーな悪魔・リミル: 自分のリーダーの体力が相手より大きいなら『バット』2枚を出す */
const rimilBats: Effect = when(LEADER_HP_ABOVE_OPPONENT, [summon("バット", 2)]);
/** タイトロープキャット: 【ファンファーレ】と【進化時】 */
const tightrope: Effect[] = [choose(oppFollowers()), damage(slot(), 3), summon("スケルトン")];
/** 鉄鎖の繋がり: 1 回分 */
const chainHit: Effect[] = [random(oppFollowers()), damage(slot(), 3), damage(BOTH_LEADERS, 1)];

export const NIGHTMARE: Record<string, CardAbilities> = {
  [id("キュートな悪魔・リリム")]: {
    abilities: [onAttack(damage(BOTH_LEADERS, 1)), lastWords(addToHand("バット"))],
  },
  [id("残虐の炸裂")]: { abilities: [spell(damage(LOWEST_HP_LEADERS, 3))] },
  [id("渇仰の悪魔")]: { abilities: [lastWords(draw(1), damage(SELF_LEADER, 1))] },
  [id("バニーな悪魔・リミル")]: { abilities: [fanfare(rimilBats), onEvolve(rimilBats)] },
  [id("強襲の特攻隊長")]: { abilities: [fanfare(damage(BOTH_LEADERS, 2))] },
  [id("元素の共鳴・バアル")]: {
    abilities: [
      fanfare(
        mode(
          [random(otherAllyFollowers()), buff(union(slot(), THIS), 1, 1)],
          [random(oppFollowers()), damage(slot(), 3)],
        ),
      ),
    ],
  },
  [id("ゴーストエスケーパー")]: { abilities: [lastWords(addToHand("ゴースト"))] },
  [id("夜の唱のライブ")]: {
    abilities: [spell(distribute(oppFollowers(), 6), necromancy(6, damage(OPP_LEADER, 2)))],
  },
  [id("透き通る信念・アンサージュ")]: { abilities: [], ignoreWard: true },
  [id("誠実なる呪い屋・スージー")]: {
    abilities: [
      fanfare(choose(oppFollowers()), buff(slot(), 0, -3)),
      onEvolve(choose(handCards({ type: "follower" }), 1, "h"), buff(slot("h"), 3, 0)),
    ],
  },
  [id("激烈の副総長")]: {
    abilities: [
      fanfare(damage(oppFollowers(), 3), damage(BOTH_LEADERS, 3)),
      onSuperEvolve(draw(2), damage(BOTH_LEADERS, 1)),
    ],
  },
  [id("ガロダートVSゼット")]: {
    abilities: [
      onTurnEndInHand(when(leaderHpAtMost(12), [costChange(THIS, -1)])),
      fanfare(
        mode(
          [grant(THIS, ["storm"]), damage(SELF_LEADER, 2)],
          [grant(THIS, ["ward"]), damage(oppFollowers(), 8)],
        ),
      ),
    ],
  },
  [id("鉄鎖の繋がり")]: { abilities: [spell(...chainHit, when(ENHANCED, chainHit))] },

  // ---- ミッドレンジNi ----
  [id("デーモンドラム・ラズ")]: {
    abilities: [lastWords(summon("スケルトン")), onEvolve(choose(oppFollowers()), damage(slot(), 3))],
  },
  [id("幽冥の中尉")]: {
    abilities: [
      lastWords(summon("幽冥の中尉", 1, "c"), buff(slot("c"), 1, 0), grant(slot("c"), ["rush"]), loseLastWords(slot("c"))),
    ],
  },
  [id("トラブルネクロマンサー")]: {
    abilities: [fanfare(summon("ゴースト"), summon("スケルトン")), onEvolve(summon("腐臭のゾンビ"))],
  },
  [id("タイトロープキャット")]: { abilities: [fanfare(...tightrope), onEvolve(...tightrope)] },
  [id("傍死のアナテマ・徒姫")]: {
    abilities: [
      // 「ランダム2種類」はデッキの枚数に比例して選ぶ（docs/rules.md 11章「ランダムに選ぶときの重み」）
      fanfare(summonFromDeck({ type: "follower", class: "nightmare", costMax: 2 }, 2)),
      onAllyEnter({ type: "follower", class: "nightmare" }, grant(EVENT, ["rush"])),
      onSuperEvolve(buff(otherAllyFollowers({ class: "nightmare" }), 2, 2)),
    ],
  },
  [id("淵底の大佐")]: { abilities: [lastWords(random(oppFollowers()), destroy(slot()), heal(2))] },
  [specialId("淵底の大佐", "crystallize")]: { abilities: [lastWords(summon("淵底の大佐"))] },
  [id("イステンデッドVSマルチルゲート")]: {
    abilities: [
      fanfare(reanimate(2), reanimate(2), reanimate(2), damage(oppFollowers(), 2)),
      onSuperEvolve(crest("イステンデッドVSマルチルゲート")),
    ],
  },
  [id("デッドプレゼンター・マクミラン")]: {
    abilities: [
      fanfare(necromancy(10, summon("腐臭のゾンビ", 3))),
      // 死者・フォロワーには、リアニメイトで場に出たフォロワーも入る（docs/rules.md「リアニメイト_N」）
      onAllyEnter(
        { type: "follower", tribe: "死者" },
        when(OWN_TURN, [buff(EVENT, 1, 0), grant(EVENT, ["rush", "ward"]), damage(OPP_LEADER, 1)]),
      ),
    ],
  },
  [id("旧き天眼・ビバティー")]: {
    abilities: [fanfare(necromancy(4, evolveIt())), onEvolved(addToHand("天眼の深淵"))],
  },
  [id("出発の憧憬・イツルギ＆タケツミ")]: {
    abilities: [
      fanfare(mode([damage(OPP_LEADER, 4), heal(4)], [damage(oppFollowers(), 5), gainEp(1)])),
      onEvolve(mode([draw(2)], [gainPp(2)])),
    ],
  },
  [id("紅札の魂魄使い")]: { abilities: [fanfare(reanimate(2)), onEvolve(reanimate(2))] },
  [id("『最強』の魅惑")]: { abilities: [spell(choose(oppFollowers()), banishCopy(slot()))] },
  [id("陽と月の薔薇・セレス")]: {
    abilities: [
      fanfare(necromancy(20, costChange(handCards({ class: "nightmare" }), -2))),
      onClash(damage(EVENT, 4)),
      onTurnEnd(heal(4)),
    ],
  },

  // トークン
  [id("腐臭のゾンビ")]: { abilities: [lastWords(summon("腐臭のゾンビ", 1, "c"), loseLastWords(slot("c")))] },
  [id("天眼の深淵")]: { abilities: [spell(draw(2))] },
};
