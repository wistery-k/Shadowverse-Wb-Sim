# ブラウザのページ

公開サイト（GitHub Pages）は 2 つのページに分かれる（2026-11-19 から。ユーザーの依頼、CLAUDE.md「決定済みの前提」）。

| ページ | URL | 入口 | タブ | 探索 AI の補正 |
| --- | --- | --- | --- | --- |
| スターター | `/Shadowverse-Wb-Sim/` | `index.html`・`src/main.tsx`・`src/ui/App.tsx` | 対戦・デッキ・AI対戦・人間との比較・問題集（開発サーバーではサンドボックス等も） | `starter`（`data/value-net.json`・`data/potential-net.json`） |
| アズヴォルト環境 | `/Shadowverse-Wb-Sim/azvaldt/` | `azvaldt/index.html`・`src/azvaldt/main.tsx`・`src/azvaldt/App.tsx` | AI対戦（総当たり）・問題集 | `azvaldt`（`data/pools/azvaldt/` の R3） |

`vite build` は 2 つの入口を束ね（`vite.config.ts` の `rollupOptions.input`）、画面の共通の部分は 1 つのチャンクにまとまる。
ページの上の端に、もう片方のページへのリンクがある。

## 読み込むもの

- **エンジンの WASM**（`svwb.wasm`）: 2 つのページで同じもの。探索 AI の補正・見込みは埋め込まない（`rust/README.md`「WASM」）
- **補正のファイル**（`src/engine/nets/<名前>.bin`。`npm run wasm` の終わりに `scripts/pack-nets.ts` が JSON から作る）: ページは自分の分だけを読む。
  画面のメインスレッドは読まず（`initEngine(…, { nets: false })`）、探索 AI を動かす Worker が初めて動くときに読む（Worker の名前 `nets:<名前>`。`src/engine/wasm.ts` の `workerName`）。
  アズヴォルト環境のページはスターターの補正を取りに行かない（ロードを軽くするため。ユーザーの依頼 2026-11-19）
  - 中身は JSON の重みを、値を変えずに縮めたもの（10 進の仮数と指数をバイトの面ごとに並べて gzip。JSON の gzip より 27% ほど小さい）。
    戻した値は JSON を serde_json で解析した値とビットまで同じなので、補正の出力は変わらない（`tests/nets.test.ts`・`tests/nets-azvaldt.test.ts` が指紋で比べる）
  - ファイルは gzip したまま置き、ページが `DecompressionStream` で戻す（サーバーが gzip で送るかに関わらず、送る大きさは同じ）
- **問題集の問**: 問題集のタブを開いたときに読む別のチャンク（スターターは `misses/*.json`、アズヴォルト環境は `misses/azvaldt/*.json`）

### 送る大きさ（2026-11-19 に測った）

`vite build` の出力を `vite preview` で開き、ヘッドレスの Chromium が取りに行ったファイルを数えた（同じファイルは 1 回。gzip はレベル 6 で縮めた大きさ。補正のファイルは gzip 済みのまま）。
「前」は main（c69ea76）のビルドで、スターターの補正を WASM に埋め込んでいた。

| ページ・時点 | 開いたとき | AI を初めて動かしたとき足すもの | 問題集を開いたとき足すもの |
| --- | ---: | ---: | ---: |
| スターター・前 | 4.12MB（WASM 4.05MB・JS 62KB。そのままなら 12.3MB） | 23KB（Worker の JS） | 33KB |
| スターター・後 | 0.80MB（WASM 0.73MB・JS 65KB。そのままなら 3.2MB） | 2.51MB（補正 2.49MB・Worker の JS 24KB） | 33KB |
| アズヴォルト環境・後 | 0.84MB（WASM 0.73MB・JS 101KB。そのままなら 3.5MB） | 4.55MB（補正 4.53MB・Worker の JS 24KB） | 14KB |

- WASM は 12.1MB → 3.0MB（gzip で 4.05MB → 0.73MB）。スターターのページは、AI を動かすところまでで 4.14MB → 3.32MB、AI を動かさなければ 0.80MB
- 補正のファイルは、補正と見込みの JSON の gzip（スターター 3.41MB、R3 6.18MB）より 27% 小さい
- アズヴォルト環境のページは、スターターの補正（`starter-*.bin`）を一度も取りに行かない（スターターのページも `azvaldt-*.bin` を取りに行かない）
- 公開サイト（GitHub Pages）が WASM・JS を gzip で送るかは、作業環境から公開サイトに届かないので確かめていない。
  送らなければ、開いたときはスターター 12.3MB → 3.2MB、アズヴォルト環境 3.5MB。補正のファイルは gzip 済みなので、どちらでも同じ大きさ。
  確かめるには `curl -sI -H 'Accept-Encoding: gzip' https://wistery-k.github.io/Shadowverse-Wb-Sim/assets/<WASM のファイル名>` の `content-encoding` を見る

## アズヴォルト環境のページ

- **AI対戦（総当たり）**: スターターのページと同じ画面（`src/ui/Simulate.tsx`）に、選べるデッキ・AI・既定を渡したもの
  - デッキ: 取り込んだプロのデッキ 84 個（`data/pools/azvaldt/decks/`。`src/azvaldt/decks.ts`）だけ。大会ごとにまとめて出し、「代表 10 型」「全部」でまとめて選べる。
    既定は代表 10 型（`data/pools/azvaldt/sets/rep10.txt`。物差しと同じ組）。貼り付け・自作・編集は付けない
  - AI: 探索（このページの補正 R3）・貪欲法・ランダム。既定は探索だけ
  - 1 組の試合数の既定は 2（席を入れ替えて 1 回ずつ）。代表 10 型の 45 組で 90 試合
  - 試合のリプレイ・「AI の考え」・「打ち比べ」はスターターのページと同じ（「サンドボックスで開く」は出さない）。
    リプレイの「再現」のコマンドには `--pool azvaldt` が付く（`npm run game -- … --pool azvaldt`。前期のローテーションのカードを足し、補正をこのページと同じにする）
- **問題集**: スターターのページと同じ画面（`src/ui/Misses.tsx`）で、`misses/azvaldt/*.json` の問だけを出す（`docs/misses.md`「問題集のページ」）
- 付けないもの: 人間と AI の対戦・デッキの編集や貼り付け・サンドボックス・試合の記録・リプレイ検索・局面の入力（CLAUDE.md の線引き）

### R3 の試合の時間

- Node の WASM で、代表 10 型の R3 どうしの 1 試合は 2.9〜11.5 秒（平均 5.7 秒）
- ヘッドレスの Chromium（Claude のクラウド環境、4 スレッド。Worker 3 つ）で、既定のまま（代表 10 型を R3 で 1 組 2 試合、90 試合）回すと 105 秒（Worker 1 つで 1 試合 3.5 秒ほど）。
  Worker の数は `navigator.hardwareConcurrency - 1`（24 まで。`src/sim/pool.ts`）なので、スレッドの多い PC ではもっと早い。既定の 1 組 2 試合はここから決めた（4 スレッドのマシンでも 2 分ほどで、組ごとに席を入れ替えた 2 試合がそろう）

### ブラウザの R3 とコマンドの R3

ページの R3 は、WASM の探索 AI の既定の設定に、ページが読み込んだ補正と見込みを入れたもの。コマンドの R3 は
`--opts '{"valueNet":"rust/engine/yardstick/pool-r3-net.json","potentialNet":"rust/engine/yardstick/pool-r3-potential.json"}'`。
同じ局面（`misses/azvaldt/` の 12 問と、代表 10 型のデッキのマリガン 2 つ）から同じ乱数で打った手を `tests/fixtures/browser-r3.json` に書き、
CLI（`rust/engine/tests/browser_r3.rs`）と WASM（`tests/nets-azvaldt.test.ts`）の両方で比べる。
読み込んだ補正の指紋も、JSON を serde_json で読んだものと比べる（`data/pools/azvaldt/` と `rust/engine/yardstick/pool-r3-*.json` の両方）。
2026-11-19 には、ブラウザで打った 1 試合（R3 どうし）を、リプレイの「再現」のコマンドで打ち直して同じ手数・ターン数になることも確かめた。
