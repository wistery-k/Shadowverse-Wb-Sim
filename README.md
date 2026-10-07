# Shadowverse: Worlds Beyond Simulator

シャドウバース ワールズビヨンド（Shadowverse: Worlds Beyond）の対戦シミュレータです。
ブラウザだけで動作し、サーバーなしで GitHub Pages に公開します。

> **非公式ファンプロジェクト**です。Cygames 社および関連企業とは一切関係ありません。
> ゲーム名・カード名・カードテキストの権利は各権利者に帰属します。
> 本リポジトリは画像・音源などのアセットを一切含みません。

## 目標

| フェーズ | 内容 | 状況 |
| --- | --- | --- |
| 1 | ルールエンジン（対戦ロジック）とカードデータ | カードデータ完了。エンジンは基本ルール・常在キーワードまで（カード能力は未実装） |
| 2 | プレイヤー vs AI（ブラウザ上でプレイ可能） | 未着手 |
| 3 | AI vs AI（自動対戦・勝率集計・AI強さ比較） | 展望 |

## 対象範囲

- **フォーマット**: スターター
- **カードプール**: 第1弾「伝説の幕開け」＋ベーシック
- **アセット**: 画像・音源・外部フォントなどは使用しない。UI は HTML/CSS とテキストのみで構成する
- **サーバー**: なし（静的ファイルのみ。AI の思考もブラウザ内で完結）

## 技術スタック

- TypeScript（strict）＋ Vite
- UI: 軽量ライブラリ（Preact 想定）＋ CSS のみ
- テスト: Vitest
- AI: ルールベース → MCTS（Web Worker 上で実行）
- 配備: GitHub Actions → GitHub Pages

## ディレクトリ構成（予定）

```
src/
  engine/   ルールエンジン（UI非依存の純TypeScript・決定的・シード付き乱数）
  cards/    カード定義（data/cards.json からの読み込みと検証）
  ai/       AI 実装（rule-based / mcts）と共通インターフェース
  ui/       ブラウザ UI
  sim/      AI vs AI の自動対戦ランナー（Node / Worker）
data/
  cards.json  カードデータ（scripts/convert-cards.ts で生成）
  crests.json クレスト（同上）
  starter-overrides.json  当時の能力への手動上書き（通常は空）
  raw/        公式カード一覧APIのレスポンス（コミットしない）
docs/
  rules.md    実装するルールの仕様メモ（出典付き）
tests/
scripts/
  convert-cards.ts  カードデータ変換
```

## 開発

```sh
npm install
npm run dev        # 開発サーバー
npm test           # テスト
npm run typecheck  # 型チェック
npm run build      # 本番ビルド（dist/）
npm run cards      # data/raw/*.json（公式カード一覧APIのレスポンス）から data/cards.json・crests.json を生成
```

## 公開

`main` ブランチへの push で GitHub Actions がビルドし GitHub Pages へデプロイします。
Vite の `base` はリポジトリ名（`/Shadowverse-Wb-Sim/`）に合わせます。

## ライセンス

未定。カードデータの取り扱いが確定してから決定します。
