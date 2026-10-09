// ユーザーの Scala 製リーサル問題集（wb-lethal の puzzles/リノセウス.scala）をこちらの局面に移したもの。
// 問題集の expected は「出せる最大ダメージ」。相手の体力を expected にすればリーサルがあり、expected + 1 なら無い。
import { ALL_CARDS } from "../src/cards";
import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { applyAction, createGame, legalActions, newBoardCard, newHandCard, type GameState } from "../src/engine";

const id = (name: string) => ALL_CARDS.find((c) => c.name === name)!.id;
const elf = DEFAULT_DECKS.find((d) => d.class === "elf")!;
const royal = DEFAULT_DECKS.find((d) => d.class === "royal")!;

/** 問題集の略称 → カード名 */
const NAMES: Record<string, string> = {
  リノ: "殺戮のリノセウス",
  杖: "聖樹の杖",
  岩: "燐光の岩",
  招集: "妖精の招集",
  鞄: "ベビーカーバンクル",
  神秘: "森の神秘",
  フェアリー: "フェアリー",
};

interface Puzzle {
  name: string;
  pp: number;
  myBoard: string[];
  oppBoard: string[];
  hand: string[];
  ep: number;
  sep: number;
  expected: number;
}

export const PUZZLES: Puzzle[] = [
  { name: "リノセウス1（リノリノ）", pp: 8, myBoard: ["杖", "岩"], oppBoard: [], hand: ["リノ", "招集"], ep: 1, sep: 0, expected: 10 },
  {
    name: "リノセウス2（鞄リノリノ）",
    pp: 8,
    myBoard: ["杖", "岩"],
    oppBoard: ["フェアリー"],
    hand: ["リノ", "招集", "鞄", "神秘", "神秘"],
    ep: 1,
    sep: 1,
    expected: 17,
  },
  {
    name: "リノセウス3（あて先無し）",
    pp: 8,
    myBoard: ["杖", "岩"],
    oppBoard: [],
    hand: ["リノ", "招集", "鞄", "神秘", "神秘"],
    ep: 1,
    sep: 1,
    expected: 16,
  },
  {
    name: "リノセウス4（リノリノリノ）",
    pp: 10,
    myBoard: ["杖"],
    oppBoard: [],
    hand: ["リノ", "リノ", "招集", "招集", "神秘", "神秘", "神秘"],
    ep: 0,
    sep: 0,
    expected: 18,
  },
];

export function puzzleState(pz: Puzzle, oppHp: number): GameState {
  let s = createGame({ decks: [elf.cards, royal.cards], seed: 1 });
  while (s.phase === "mulligan") s = applyAction(s, legalActions(s)[0]!);
  s.active = 0;
  const me = s.players[0];
  me.hand = pz.hand.map((n) => newHandCard(s, id(NAMES[n]!)));
  me.board = pz.myBoard.map((n) => newBoardCard(s, id(NAMES[n]!)));
  me.pp = me.maxPp = pz.pp;
  me.turnCount = pz.pp;
  me.ep = pz.ep;
  me.sep = pz.sep;
  me.combo = 0;
  me.extraPpAvailable = false;
  s.players[1].board = pz.oppBoard.map((n) => newBoardCard(s, id(NAMES[n]!)));
  s.players[1].leaderHp = oppHp;
  return s;
}
