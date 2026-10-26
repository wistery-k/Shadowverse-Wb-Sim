# Docker の中で Remote Control を動かす

Claude Code の Remote Control（`claude remote-control`）を Docker のコンテナの中で動かす。claude.ai/code・Claude のアプリ・
プロジェクトのスレッドから、このコンテナの中で作業させられる。Claude が触れるのは、このリポジトリ（コンテナの中では `/workspace`）と
コンテナの中だけになる。

- `Dockerfile`: Node 22・Rust（stable と `wasm32-unknown-unknown`。CI と同じ）・Claude Code（公式のインストーラ）を入れたイメージ
- `compose.yaml`: リポジトリを `/workspace` に見せ、ログイン情報と設定を名前付きボリュームに残し、`claude remote-control` を常駐させる

公式の説明: [Remote Control](https://code.claude.com/docs/en/remote-control)・[ログイン](https://code.claude.com/docs/en/authentication)・
[dev container](https://code.claude.com/docs/en/devcontainer)（2026-10-26 に確認）

## 要るもの

- Docker（Docker Engine と compose プラグイン。Compose は 2.24 以上）
- Claude の Pro・Max・Team・Enterprise のアカウント。Remote Control は claude.ai のログインでしか使えない（API キーや
  `claude setup-token` のトークンでは使えない）。Team・Enterprise は、組織の管理者が Remote Control を有効にしている必要がある

## 初めて使うとき

コマンドはすべて、このフォルダ（`docker/remote-control`）で打つ。

1. ホストのユーザーと UID・GID をそろえて、イメージを作る（数分かかる）

   ```sh
   printf 'SVWB_UID=%s\nSVWB_GID=%s\n' "$(id -u)" "$(id -g)" > .env
   mkdir -p ../../rust/target   # 無いと Docker が root の持ち物として作ってしまうので、先に作っておく
   docker compose build
   ```

2. claude.ai でログインする

   ```sh
   docker compose run --rm rc claude auth login
   ```

   出てきた URL をホストのブラウザで開いてログインする。ブラウザにコードが出たら、端末の `Paste code here if prompted` に貼る
   （コンテナの中へはブラウザから戻ってこられないので、コードを貼る形になる）。`Login successful` が出れば終わり。
   `docker compose run --rm rc claude auth status --text` で、claude.ai でログインしていることを確かめられる

3. 最初の確認に答える

   ```sh
   docker compose run --rm rc
   ```

   `Trust /workspace? [y/N]` には `y`、Remote Control を有効にするかを聞かれたら `y` で答える。セッションの URL が出たら `Ctrl+C` で止める。
   答えは設定のボリュームに残るので、次からは聞かれない

4. 常駐させる

   ```sh
   docker compose up -d
   docker compose logs -f   # 様子を見る。Ctrl+C で抜けてもコンテナは動き続ける
   ```

   claude.ai/code やアプリのセッションの一覧に `svwb-docker-…` が出る。プロジェクトのスレッドからも、このコンテナ
   （フォルダ `/workspace`）で作業させられる

## ふだんの操作

| したいこと | コマンド |
| --- | --- |
| 止める | `docker compose down`（ログインと設定はボリュームに残る） |
| 動かす | `docker compose up -d` |
| 様子を見る | `docker compose logs -f` |
| コンテナの中でシェルを開く | `docker compose exec rc bash` |
| ログインし直す | `docker compose exec rc claude auth login` の後に `docker compose restart` |
| Claude Code・Rust を新しくする | `docker compose build --pull --no-cache && docker compose up -d`（Claude Code は動いている間にも自分で更新する） |
| ログインと設定を消す | `docker compose down -v`（Rust のビルド結果のボリュームも消える） |

## 設定（`.env`）

`.env` に書くとコンテナに渡る（`compose.yaml` の `env_file`）。

- `CLAUDE_PERMISSION_MODE`: セッションの権限モード。既定は `acceptEdits`（ファイルの編集は聞かずに行い、コマンドは聞く）。
  ほかに `default`・`auto`・`dontAsk`・`plan`・`bypassPermissions`。コンテナの中なので `bypassPermissions` にして確認を無くす手もある
  （ただし `/workspace` とコンテナの中のログイン情報には触れられる。Remote Control でこのモードがそのまま使えるかは試していない）
- `CLAUDE_SPAWN`: 新しいセッションの作り方。既定は `same-dir`（どのセッションも `/workspace` で作業する）。`worktree` にすると
  セッションごとに git の worktree を作る（同時に複数のスレッドが作業しても混ざらないが、worktree ごとに Rust を作り直すので遅い）
- コミットするなら `GIT_AUTHOR_NAME`・`GIT_AUTHOR_EMAIL`・`GIT_COMMITTER_NAME`・`GIT_COMMITTER_EMAIL`

## 気をつけること

- 次の環境変数をコンテナに渡さない。どれかがあると Remote Control が使えない: `ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`・
  `CLAUDE_CODE_OAUTH_TOKEN`・`ANTHROPIC_BASE_URL`・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`・`DISABLE_GROWTHBOOK`
  （公式の dev container の例は `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を入れているので、そこは真似しない）
- 通信は外向きの HTTPS（443）だけで、ホストのポートは開けない。ネットワークが 10 分ほど切れると `claude remote-control` は終わるが、
  `restart: unless-stopped` で立ち上げ直す
- ログインには期限がある。期限が近いと起動時に `Your login expires in 3 days` と出る。切れるとセッションが進まなくなるので、ログインし直す
- アカウントの設定で「信頼できるデバイス」を必須にしていると、ログインから 18 時間たつとセッションを見られなくなる。そのときもログインし直す
- コンテナには GitHub の認証情報を入れていないので、コンテナからは push できない（コミットまで。push はホストで）
- Rust のビルド結果（`rust/target`）は、コンテナではボリュームに分けている。ホストで作ったものとは別に作り直す（初回は数分）。
  `node_modules` はホストと同じものを使う
- 2026 年 7 月ごろ、コンテナの中の Remote Control でセッションが作れず 401 で黙って失敗するという報告がある（GitHub の課題を写したサイトで見た。
  中身と、直ったかどうかは確かめていない）。セッションが出てこなければ `docker compose run --rm rc claude remote-control --verbose`
  で 401 が出ていないかを見る

## 確かめたこと（2026-10-26）

Claude のクラウド環境の Docker で、イメージを作り（ネットワークの制限で、apt の部分を外し、Claude Code を npm で入れた版）、
`compose.yaml` のままで次を確かめた。ログインと、Remote Control のセッションが本当に作れるかは確かめていない（ログインが要るため）。

- ユーザーが UID 1000 の `wk` になり、`/workspace`・`rust/target`・`~/.claude` に書ける。`.claude.json` も `~/.claude` の中にできる
- Claude Code 2.1.310 が動き、ログインの前の `claude remote-control` は `You must be logged in to use Remote Control.` で終わる
- コンテナの中で `npm ci`・`npm run wasm`・`cargo build --release`（約 3 分）が通り、`npm run svwb` が動く。`npm run typecheck`・`npm test`（171 件）も通る
