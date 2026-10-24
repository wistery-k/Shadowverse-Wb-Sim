# Shadowverse: Worlds Beyond Simulator

シャドウバース ワールズビヨンド（Shadowverse: Worlds Beyond）の対戦シミュレータです。
ブラウザだけで動作し、サーバーなしで GitHub Pages に公開します。

> **非公式ファンプロジェクト**です。Cygames 社および関連企業とは一切関係ありません。
> ゲーム名・カード名・カードテキストの権利は各権利者に帰属します。
> 本リポジトリは画像・音源などのアセットを一切含みません。

## 目標

| フェーズ | 内容 | 状況 |
| --- | --- | --- |
| 1 | ルールエンジン（対戦ロジック）とカードデータ | 全カード・クレストの能力を実装済み（一部の処理順は未確認） |
| 2 | プレイヤー vs AI（ブラウザ上でプレイ可能） | 貪欲法の AI と対戦可能。デッキ構築（ブラウザに保存・テキストでエクスポート/インポート）対応 |
| 3 | AI vs AI（自動対戦・勝率集計・AI強さ比較） | 総当たりの自動対戦と勝率表（ブラウザの「AI対戦」タブ・`npm run sim`）。勝率表のセルから各試合のリプレイを再生できる。リプレイの「打ち比べ」で、ある局面の実戦の手と別の手を、続きを AI に打たせた勝率で比べられる（手番のプレイヤーから見えない手札・山札は試合ごとに並べ直し、同じ番号の試合はどの手でも同じ並べ直しにする）。リプレイの「AI の考え」で、その局面で手番の探索 AI が比べた手（最初の手ごとの並び）と、ターン末・相手のターンを読んだ後の点数の内訳（手で作った評価と学習した補正）を表示できる。探索 AI（貪欲法に約7割勝つ）。「人間との比較」タブで、`npm run rhino-compare`（リノセウスエルフ）・`npm run af-compare`（AFネメシス）・`npm run spellwitch-compare`（スペルウィッチ）・`npm run bishop-compare`（アミュレット疾走ビショップ）・`npm run dragon-compare`（疾走ドラゴン）・`npm run nightmare-compare`（ミッドレンジナイトメア）・`npm run royal-compare`（アマリアロイヤル）と同じシードの試合を人間がそのデッキで打ち、勝敗と各ターンの選択を JSON Lines で保存できる。相手の AI は物差し（`docs/yardstick.md`）か最新版（今の既定の探索 AI）から選べる。このタブの対戦では、自分のターンのリーサルの有無を表示し、ボタンで自動で取れる（`npm run rhino-compare -- --matches <ファイル>`、`npm run af-compare -- --matches <ファイル>`、`npm run spellwitch-compare -- --matches <ファイル>` 等で同じ試合の AI の勝敗と並べる）。「サンドボックス」タブで、手札・場・山札・リーダー・ターンを編集した局面（新しく作るか、リプレイの「サンドボックスで開く」で開く）について、「AI の考え」と打ち比べ（選んだ手どうしを比べる）を使い、打てる手や AI の手で進められる（編集と手は履歴に残り、戻せる。局面は JSON で書き出し・読み込みできる） |

## 対象範囲

- **フォーマット**: スターター
- **カードプール**: 第1弾「伝説の幕開け」＋ベーシック
- **アセット**: 画像・音源・外部フォントなどは使用しない。UI は HTML/CSS とテキストのみで構成する
- **サーバー**: なし（静的ファイルのみ。AI の思考もブラウザ内で完結）

## 技術スタック

- TypeScript（strict）＋ Vite
- エンジン・AI: Rust（ブラウザでは WASM にして使う。`rust/README.md`）
- UI: 軽量ライブラリ（Preact 想定）＋ CSS のみ
- テスト: Vitest
- AI: ルールベース → MCTS（Web Worker 上で実行）
- 配備: GitHub Actions → GitHub Pages

## ディレクトリ構成（予定）

```
rust/
  engine/   ルールエンジンと AI（UI非依存・決定的・シード付き乱数）。自己対戦の CLI（svwb）
  wasm/     ブラウザ・Node から呼ぶ WASM
src/
  engine/   局面の型・能力の DSL と、WASM のエンジンを呼ぶ関数
  cards/    カード定義（data/cards.json からの読み込みと検証）・能力の定義
  ai/       選べる AI の一覧と、AI の思考を行う Web Worker
  ui/       ブラウザ UI
  sim/      AI vs AI の自動対戦ランナー（Node / Worker）
data/
  cards.json  カードデータ（scripts/convert-cards.ts で生成）
  crests.json クレスト（同上）
  starter-overrides.json  当時の能力への手動上書き（通常は空）
  decks/      デフォルトデッキ（アプリのエクスポート形式の .txt。data/decks/README.md 参照）
  raw/        公式カード一覧APIのレスポンス（コミットしない）
docs/
  rules.md    実装するルールの仕様メモ（出典付き）
  ai-notes.md AI の実験記録（試したこと・結果・採否）
tests/
scripts/
  convert-cards.ts  カードデータ変換
```

## 開発

Node と Rust（cargo）が要ります。WASM 向けのターゲットを入れておきます（`rustup target add wasm32-unknown-unknown`）。
`npm test`・`npm run dev`・`npm run build` は先にエンジンの WASM を作ります（`npm run wasm`）。

```sh
npm install
npm run dev        # 開発サーバー
npm test           # テスト
npm run typecheck  # 型チェック
npm run build      # 本番ビルド（dist/）
npm run cards      # data/raw/*.json（公式カード一覧APIのレスポンス）から data/cards.json・crests.json を生成
npm run sim        # デフォルトデッキの AI 同士の総当たり（例: npm run sim -- --games 50 --agents greedy,random）
npm run compare    # 探索 AI の設定同士の比較（例: npm run compare -- 105 '{}' '{"lethal":false}'）
                   # sim と compare は試合を CPU のコア数だけ並列に行う（並列数は環境変数 THREADS で指定）
npm run sim-report # sim の --json の結果（--shard で分けたものも）を Markdown の表にまとめる
npm run game       # 1試合だけ行い、行動の列を表示する（リプレイ画面の「再現に必要な情報」のコマンド）
npm run svwb       # Rust 版の CLI（ゴールデンテスト・計測・自己対戦。rust/README.md）
npm run pack-run   # PC で回した 1 回分の出力（自己対戦・モデル・ログ）を、共有フォルダに上げる .tar.gz にまとめる
```

各コマンドが受け付ける引数の一覧は [`docs/commands.md`](docs/commands.md) にまとめてあります。

## 公開

`main` ブランチへの push で GitHub Actions がビルドし GitHub Pages へデプロイします。
Vite の `base` はリポジトリ名（`/Shadowverse-Wb-Sim/`）に合わせます。

また `main` への push ごとに「自動対戦」ワークフロー（`.github/workflows/auto-match.yml`）が、探索 AI どうし（リノセウスエルフだけリノセウス用 AI）でデフォルトデッキの総当たり（1組 20 試合、8 並列）を回し、通算勝率と対戦表を Actions の実行結果のサマリーに出します。Actions タブの Run workflow から試合数と AI を変えて手動でも実行できます。

## ライセンス

未定。カードデータの取り扱いが確定してから決定します。
