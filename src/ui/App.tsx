import { ALL_CARDS } from "../cards";

export function App() {
  return (
    <div class="app">
      <header>
        <h1>Shadowverse: Worlds Beyond Simulator</h1>
        <p>フォーマット: スターター（伝説の幕開け＋ベーシック）</p>
      </header>
      <main>
        <p>開発中です。収録カード: {ALL_CARDS.length}枚</p>
      </main>
      <footer>
        非公式ファンプロジェクトです。Cygames 社および関連企業とは一切関係ありません。
        ゲーム名・カード名・カードテキストの権利は各権利者に帰属します。
      </footer>
    </div>
  );
}
