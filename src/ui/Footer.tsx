// ページの下の表記（非公式であること・ソフト打ちの禁止・ビルドの情報）。スターターとアズヴォルト環境のページで共通

const REPO_URL = "https://github.com/wistery-k/Shadowverse-Wb-Sim";

export function Footer() {
  return (
    <footer>
      非公式ファンプロジェクトです。Cygames 社および関連企業とは一切関係ありません。
      ゲーム名・カード名・カードテキストの権利は各権利者に帰属します。
      ゲームの実際の対戦の最中に、手を決める助けとして使うこと（ソフト打ち）は禁止です。
      <BuildInfo />
    </footer>
  );
}

/** 最終更新日時とコミットハッシュ（ビルド時に埋め込んだ値） */
function BuildInfo() {
  if (!__BUILD_COMMIT__) return null;
  const date = __BUILD_DATE__ ? new Date(__BUILD_DATE__) : null;
  const dateText =
    date && !Number.isNaN(date.getTime())
      ? date.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "不明";
  return (
    <div class="build-info">
      最終更新: {dateText} / コミット:{" "}
      <a href={`${REPO_URL}/commit/${__BUILD_COMMIT__}`} target="_blank" rel="noreferrer">
        {__BUILD_COMMIT__.slice(0, 7)}
      </a>
    </div>
  );
}
