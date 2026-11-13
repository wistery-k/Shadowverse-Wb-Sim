// 前期のローテーションのナイトメアのカード能力（トークン含む）

import type { CardAbilities, Effect } from "../../../engine/dsl";
import {
  BOTH_LEADERS,
  ENHANCED,
  LEADER_HP_ABOVE_OPPONENT,
  LOWEST_HP_LEADERS,
  OPP_LEADER,
  SELF_LEADER,
  THIS,
  addToHand,
  buff,
  choose,
  costChange,
  damage,
  distribute,
  draw,
  fanfare,
  grant,
  handCards,
  id,
  lastWords,
  leaderHpAtMost,
  mode,
  necromancy,
  onAttack,
  onEvolve,
  onSuperEvolve,
  onTurnEndInHand,
  oppFollowers,
  otherAllyFollowers,
  random,
  slot,
  spell,
  summon,
  union,
  when,
} from "./helpers";

/** バニーな悪魔・リミル: 自分のリーダーの体力が相手より大きいなら『バット』2枚を出す */
const rimilBats: Effect = when(LEADER_HP_ABOVE_OPPONENT, [summon("バット", 2)]);
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
};
