import { DEFAULT_DECKS } from "../src/cards/defaultDecks";
import { planGames, runGame } from "../src/sim/tournament";
export async function main() {
  const entrants = DEFAULT_DECKS.map((d) => ({ name: d.name, deck: d.cards, agent: "greedy" }));
  const specs = planGames(entrants.length, { gamesPerPair: 4, seed: 1 }).slice(0, 20);
  for (const s of specs) {
    const t = Date.now();
    const r = runGame(s, entrants);
    const ms = Date.now() - t;
    if (ms > 300) console.log(entrants[s.a]!.name, "vs", entrants[s.b]!.name, "seed", s.seed, ms, "ms", "turns", r.turns);
  }
  return 0;
}
