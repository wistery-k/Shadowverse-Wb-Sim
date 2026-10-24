# CLAUDE.md

Shadowverse: Worlds Beyond の対戦シミュレータ。概要・目標は `README.md` を参照。
このファイルは、このリポジトリで作業する Claude 向けの方針とルール。

## 決定済みの前提（変更するときはユーザーに確認）

- フォーマット: スターター / カードプール: 第1弾「伝説の幕開け」＋ベーシックのみ
- サーバーなし。静的サイトとして GitHub Pages で公開
- **画像・音源・フォント等のアセットは一切使わない**（CDN 読み込み、絵文字依存の装飾、base64 埋め込み画像も不可）。表現は CSS とテキストのみ。クラスの識別は色＋文字で行う
- スタック: TypeScript(strict) + Vite + 軽量UI(Preact想定) + Vitest。エンジンと AI は Rust（`rust/`）で、ブラウザでは WASM にして使う
- AI: まずルールベース、次に MCTS。重い思考は Web Worker で実行
- 自己対戦の高速化のため、エンジンと AI を Rust に移した（`rust/README.md`、検討は `docs/ai-notes.md`「エンジンを Rust に移す」）。段階 4 で TypeScript 版のエンジン・AI を消し、ブラウザも WASM を使う（ユーザー確認済み 2026-10-15）。ブラウザ向けにビルドした `.wasm` をサイトに置くのは可（ユーザー確認済み 2026-10-15。画像・音・フォント等のアセットの禁止はそのまま）。開発には Rust（cargo と `rustup target add wasm32-unknown-unknown`）が要る
- カードデータは、ユーザーが提供した公式サイトのカード一覧APIのレスポンス（`data/raw/*.json`）を `npm run cards`（`scripts/convert-cards.ts`）で `data/cards.json` と `data/crests.json` に変換する。作業環境からは公式サイト・攻略サイトにアクセスできない
- 元データはブランチ `wistery-k-patch-1` の `cardList.json`〜`cardList_7.json`（全198枚、offset 0〜180）。再生成するときは `git show origin/wistery-k-patch-1:<file> > data/raw/<file>` で取り出す
- ドキュメント・UI 文言・コミットメッセージは日本語。識別子・コードコメントの用語は英語でもよいが、ゲーム用語は `docs/rules.md` の対応表に従う

## アーキテクチャ方針

1. **エンジンは UI 非依存**: ルールエンジンは Rust（`rust/engine`）。ブラウザ・Node からは WASM（`rust/wasm`）を `src/engine/wasm.ts` が読み込み、`src/engine/game.ts` の関数（`createGame`・`legalActions`・`applyAction` 等）として呼ぶ。エンジンは時刻や OS の乱数を使わない
2. **決定的**: 乱数は注入するシード付き PRNG のみ。同じシード＋同じ行動列＝同じ結果（リプレイ・デバッグ・AI評価のため）
3. **状態遷移は純関数的に**: `apply_action(state, action) -> state`。状態は JSON で TypeScript と受け渡す（形は `src/engine/types.ts`、変換は `rust/engine/src/state_json.rs`）。状態の型を変えたら両方を直す。複製は Rust の `Clone`
4. **合法手列挙**: `legal_actions(state)` をエンジンが提供し、UI と AI は同じ API だけを使う。UI/AI がルール判定を再実装しない
5. **カード効果はデータ駆動**: 効果は `src/cards/abilities/<クラス>.ts` にカードIDをキーに宣言的に記述し（DSL は `src/engine/dsl.ts`、補助関数は `src/cards/abilities/helpers.ts`）、エンジンの効果プリミティブ（ダメージ、ドロー、召喚、バフ、キーワード付与 等）の組み合わせで表現する。表現できない効果が出たらプリミティブを足す（`dsl.ts` と Rust 側の `rust/engine/src/data.rs`・`effects.rs`）。カード個別の `if (id === ...)` は書かない。能力の定義は `npm run rust-data` で JSON に書き出して Rust に埋め込む（`npm run wasm`・`npm test`・`npm run dev` が自動で行う）
5.0 **エンジン・AI を変えたら**: `npm test` に加えて `cd rust && cargo test --release --workspace`（AI の単体テストと、決まった試合の結果を保存したものと比べるゴールデンテスト。CI でも行う）を通す。振る舞いを意図して変えたとき（カード能力の修正も含む）は `npm run svwb -- golden write` で保存し直し、結果が変わった理由をコミットに書く
5.1 **能力の解決**: `rust/engine/src/effects.rs` が解決スタック（`state.stack`）と誘発待ち（`state.queue`）で解決する。プレイヤーの選択が必要になると `state.pending` を設定して中断し、`choose` / `mode` アクションで再開する。継続はデータ（効果の配列とプログラムカウンタ）で持つ
6. **非公開情報**: AI は実際の局面を直接先読みせず、`rust/engine/src/ai/determinize.rs` で作った「視点のプレイヤーから見て矛盾しない局面」（相手の手札・山札の中身と山札の順番を並べ直し、乱数の状態も新しくしたもの）で手を試す。新しい AI もこれに従う
7. **AI インターフェース共通化**: `Agent::choose_action(state, legal, rng) -> Action`（`rust/engine/src/ai/mod.rs`）。選べる AI は `rust/engine/src/ai/registry.rs` と `src/ai/registry.ts`（表示名）に登録し、UI・自動対戦（`npm run sim`、「AI対戦」タブ）で共通に使う。UI では AI の思考を Web Worker（`src/ai/worker.ts`）で行う
8. **AI の強さの比較**: AI を変えたら `npm run sim -- --games 50 --agents <新>,<旧>` 等で勝率を比べてから採用する
   - 採用した版は `npm run yardstick -- --label <名前> --record` と `npm run yardstick -- --ref strong --label <名前> --record` で、固定した相手（弱い相手と強い相手）との勝率を `docs/yardstick.md` の表に足す（強さの物差し。相手が動いたら表の先頭の説明に従う）
9. **AI の実験記録**: AI の改善で試したことと結果（不採用のものも）は `docs/ai-notes.md` に残す。新しい実験の前に読み、同じことを繰り返さない
   - 判断は勝率（探索 AI どうしなら `npm run compare`、同じシードで席とデッキを入れ替えて 200 試合程度）で行う。ランナーは Rust（`npm run compare`・`npm run rhino-compare`・`npm run svwb -- td selfplay`。`rust/README.md`）。予測精度などの代わりの指標が良くても、勝率で確かめるまで採用しない（評価関数の学習は予測精度が上がったのに勝率は下がった）
   - 1 組 20 試合の勝率表は 1 マス ±10% ほどぶれる。小さな差で結論を出さない
   - ユーザーの PC で回した自己対戦・モデル・ログは、`npm run pack-run` でまとめたものを共有フォルダ（`/mnt/project-files/`）の `data/selfplay/<名前>/`・`data/models/<名前>/`・`logs/<名前>/` に展開して置く。各回の中身は `logs/<名前>/MANIFEST.md`（`docs/commands.md`「pack-run」）

## ルールの扱い

- 実装するルールは `docs/rules.md` に出典（公式URL・取得日）付きで書き、**コードより先にここを更新**する
- 確信のないルールや処理順（効果の解決順、スタック、同時発動など）を推測で実装しない。不明点は `docs/rules.md` に「未確認」と記して、ユーザーに質問する
- **スターター**フォーマット（ユーザー確認済み）: 第1弾「伝説の幕開け」とベーシックのカードのみ使用可。後に能力調整（ナーフ・バフ等）されたカードは、**調整前の当時の能力**で扱う
- 公式データの `starter_card` にスターター版（当時）の能力があるので変換時にそれを使う。差し替えたカードは `starterAbilityChanged: true`。公式データで足りない場合はユーザーが修正する。Claude は推測で埋めない
- デッキ構築の制限（枚数・同名上限など）は通常ルールに従う想定。公式で確認できなければ `docs/rules.md` に「未確認」と記す

## カードデータ

- 型は `src/cards/types.ts`、検証は `src/cards/validate.ts`（手書き）。`npm test` で全カードを検証する
- `data/cards.json` を手で編集しない。変換スクリプトを直して再生成する
- 元データには第2弾以降のカードも含まれる。カードIDの3桁目でセットを判別する（0=ベーシック、1=第1弾、2=第2弾…）。トークンは9始まりで、プールのカードから参照されるものだけを含める
- 能力調整されたカードの当時の能力は `data/starter-overrides.json`（手で管理、コミットする）に書き、変換時に上書きする
- 元データの変換スクリプトは `scripts/` に置く。元データは `data/raw/`（`.gitignore` 対象）に置く。**コミットするのは整形後の `data/cards.json` のみ**（元データはコミットしない）
- カード画像は取得・保存しない

## 実装順序

1. `docs/rules.md` とカードスキーマ、`data/cards.json`
2. エンジン（ターン進行、PP、進化、場・手札・山札、攻撃、キーワード能力、効果プリミティブ）＋テスト
3. 最小UI（テキストベースで両者の盤面表示と行動選択）で人間 vs ランダムAI
4. ルールベースAI → UI 磨き込み → GitHub Pages デプロイ（Actions）
5. AI vs AI ランナー（Node CLI／ブラウザ上の勝率集計）、MCTS

## テスト・品質

- エンジンは単体テスト必須。カード効果は「カード単位の最小シナリオテスト」を書く
- ランダム/ランダム自己対戦のスモークテスト（数千試合でクラッシュ・不正状態・無限ループがないこと）を CI に含める
- 不変条件の検査関数（手札上限、場の上限、HP、重複ID無し等）を用意し、テストと自己対戦で呼ぶ
- コミット前に `npm run typecheck && npm test` を通す。Rust を変えたら `cd rust && cargo fmt --check && cargo clippy --release --workspace --all-targets -- -D warnings && cargo test --release --workspace` も通す

## コーディング規約

- strict な型、`any` 禁止、`unknown` は境界で検証して絞る
- 依存は最小限。追加する前に必要性を検討し、アセット同梱・外部通信を行うライブラリは入れない
- 実行時の外部通信は一切しない（フォント・アナリティクス・CDN 含む）

## Git / 公開

- 作業ブランチは指示されたブランチ（現在: `claude/next-steps`）。指示なく他ブランチへ push しない
- 作業が一区切りついたら、ユーザーに求められなくても基本的に PR を作成する
- GitHub Pages は GitHub Actions でビルド・デプロイ。Vite の `base` は `/Shadowverse-Wb-Sim/`

## 権利・表記

- 非公式ファンプロジェクトである旨を README とアプリのフッターに明記する
- 公式のロゴ・画像・音声・フォントは使わない。カードはテキストのみを扱い、画像は含めない（ユーザー判断で、テキストのみなら問題になる可能性は現実的に低いとの方針）。公式ガイドラインに変更があれば再確認する
