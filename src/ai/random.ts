import type { Agent } from "./types";

/** 合法手から一様ランダムに選ぶ */
export const randomAgent: Agent = {
  name: "random",
  chooseAction(_state, legal, rng) {
    const action = legal[rng.int(legal.length)];
    if (!action) throw new Error("合法手がありません");
    return action;
  },
};
