// アズヴォルト環境（前期のローテーション・能力調整後）のページ（ユーザーの依頼 2026-11-19。CLAUDE.md「決定済みの前提」）。
// タブは「AI対戦（総当たり）」と「問題集」の 2 つだけ。AI 同士の試合と、問題集の決まった局面を表示・再生する。
// 人間と AI の対戦・デッキの編集や貼り付け・サンドボックス・試合の記録・局面の入力は付けない（実際の対戦の支援にならないように。CLAUDE.md「ソフト打ち」）。
// AI 同士の試合のリプレイは、seed・両者の AI・デッキ（プロのデッキの ID）を持つ URL（#game?…。src/sim/gameLink.ts）で開ける（ユーザーの依頼 2026-11-20。局面は URL に入らない）。
// AI は探索 AI に、このページが読み込む補正と見込み R4（data/pools/azvaldt/。2026-11-21 に R3 から入れ替えた）を入れたもの（コマンドの R4 と同じ手を選ぶ。tests/nets-azvaldt.test.ts）

import { useEffect, useState } from "preact/hooks";
import { Footer } from "../ui/Footer";
import { isMissesHash, Misses, type MissesSource } from "../ui/Misses";
import { Simulate, type DeckPreset } from "../ui/Simulate";
import { isGameHash } from "../sim/gameLink";
import { AZVALDT_DECK_OPTIONS, AZVALDT_LINK_DECKS, REP10_IDS } from "./decks";

/** 総当たりで選べる AI（キーは src/ai/registry.ts。探索はこのページの補正 R4 で打つ） */
const AGENTS: Record<string, string> = {
  search: "探索（補正 R4）",
  greedy: "貪欲法",
  random: "ランダム",
};

/**
 * 総当たりの最初の選択: 代表 10 型を探索 AI で、1組 2 試合（席を入れ替えて 1 回ずつ。45 組で 90 試合）。
 * R3 の 1 試合は Worker 1 つで 3.5 秒ほどで、4 スレッドのマシン（Worker 3 つ）で 90 試合が 2 分ほど（docs/browser.md「ページの試合の時間」。R4 は 1 手の思考が R3 と同じほど）
 */
const DEFAULTS = { decks: REP10_IDS, agents: ["search"], games: 2 };

const PRESETS: readonly DeckPreset[] = [
  { label: "代表 10 型", keys: REP10_IDS },
  { label: "全部（84 個）", keys: AZVALDT_DECK_OPTIONS.map((o) => o.key) },
];

/** 問題集: 新しいプールの問（misses/azvaldt/）。シミュレータの中の R3 どうしの自己対戦から取った局面だけ */
const MISSES: MissesSource = {
  load: () => import("../misses/azvaldtData").then((m) => m.loadMisses()),
  dir: "misses/azvaldt",
  about:
    "局面はどれも、このシミュレータの中の AI（探索 AI に補正 R3 を入れたもの）どうしの自己対戦（打ち比べ調査）から取ったもので、ここで見られるのはリポジトリにある問だけです。",
};

type Tab = "sim" | "misses";

const TABS: readonly [Tab, string][] = [
  ["sim", "AI対戦（総当たり）"],
  ["misses", "問題集"],
];

export function AzvaldtApp() {
  // URL が #misses（問題集の問）なら問題集を開く
  const [tab, setTabState] = useState<Tab>(() => (isMissesHash() ? "misses" : "sim"));
  // 問題集は、最初に開くまで作らない（開くと問のデータを読み込む）
  const [missesOpened, setMissesOpened] = useState(() => isMissesHash());
  // 試合の URL（#game?…）を同じページに貼ったら、AI対戦のタブに移る（試合を打ち直すのは Simulate）
  useEffect(() => {
    const onHash = () => {
      if (isGameHash()) setTabState("sim");
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const setTab = (t: Tab) => {
    setTabState(t);
    if (t === "misses") setMissesOpened(true);
    // 問題集を離れたら URL の #misses を消す（読み込み直したときに問題集が開かないように）
    else if (isMissesHash()) {
      try {
        history.replaceState(null, "", location.pathname + location.search);
      } catch {
        // 書き換えられなくても画面は動く
      }
    }
  };

  return (
    <div class="app">
      <header>
        <h1>Shadowverse: Worlds Beyond Simulator</h1>
        <span class="muted">アズヴォルト環境（前期のローテーション・能力調整後。プロのデッキ 84 個）</span>
        <a class="pool-link" href={import.meta.env.BASE_URL}>
          スターターのページへ
        </a>
        <nav class="tabs">
          {TABS.map(([key, label]) => (
            <button type="button" key={key} class={tab === key ? "active" : ""} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {/* どちらのタブも、ほかのタブに移っても実行中の対戦・開いた問を残すため、隠すだけにする */}
        <div hidden={tab !== "sim"}>
          <Simulate
            decks={AZVALDT_DECK_OPTIONS}
            agents={AGENTS}
            defaults={DEFAULTS}
            storageKey="svwb-sim:azvaldt:simulate-selection:v1"
            presets={PRESETS}
            links={AZVALDT_LINK_DECKS}
            note={
              <p class="muted">
                デッキは、取り込んだプロのデッキ（プレミアシリーズ 3 回分）だけを選べます。カードは、これらのデッキに入るものだけを実装しています。
                探索 AI は、このページ用に学習した補正 R4 で打ちます（初めて試合を始めるとき、補正のファイル 5MB ほどを読み込みます）。
              </p>
            }
          />
        </div>
        {missesOpened && (
          <div hidden={tab !== "misses"}>
            <Misses source={MISSES} active={tab === "misses"} />
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
