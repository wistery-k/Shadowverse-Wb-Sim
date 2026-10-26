# Claude Code の Remote Control（claude remote-control）を動かすコンテナ。使い方は同じフォルダの README.md
FROM node:22-trixie

# ホストのユーザーと同じ UID・GID にする（作業フォルダに書いたファイルの持ち主をそろえる）。compose.yaml が .env から渡す
ARG USERNAME=wk
ARG USER_UID=1000
ARG USER_GID=1000

# 作業に使う道具（gcc・make・pkg-config・git・curl は元のイメージに入っている）
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq ripgrep less tmux \
 && rm -rf /var/lib/apt/lists/*

# node イメージにある node ユーザー（UID 1000）を消して、ホストと同じ UID のユーザーを作る。
# 作業フォルダ（/workspace）と、名前付きボリュームを重ねる場所は先に作って持ち主を合わせておく（空のボリュームはこの持ち主を引き継ぐ）
RUN (userdel -r node 2> /dev/null || true) \
 && (getent group "$USER_GID" > /dev/null || groupadd -g "$USER_GID" "$USERNAME") \
 && useradd -m -s /bin/bash -u "$USER_UID" -g "$USER_GID" "$USERNAME" \
 && mkdir -p /workspace/rust/target "/home/$USERNAME/.claude" \
 && chown -R "$USER_UID:$USER_GID" /workspace "/home/$USERNAME/.claude"

USER $USERNAME
ENV PATH=/home/$USERNAME/.local/bin:/home/$USERNAME/.cargo/bin:$PATH

# Rust（stable と、WASM を作るための wasm32-unknown-unknown。CI と同じ）
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
 && rustup component add rustfmt clippy \
 && rustup target add wasm32-unknown-unknown

# Claude Code（公式のインストーラ。~/.local/bin/claude に入り、動いている間に自分で更新する）
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && claude --version

# ログイン情報（.credentials.json）と設定（.claude.json。フォルダの信頼・Remote Control の確認の答えも入る）を
# ~/.claude にまとめる。compose.yaml がここに名前付きボリュームを重ねるので、コンテナを作り直しても残る
ENV CLAUDE_CONFIG_DIR=/home/$USERNAME/.claude

WORKDIR /workspace

# 起動のたびに ~/svwb-data の中のフォルダへのリンクを ~ に作ってから、コマンドを流す（entrypoint.sh）
COPY --chmod=755 entrypoint.sh /usr/local/bin/svwb-entrypoint
ENTRYPOINT ["/usr/local/bin/svwb-entrypoint"]
CMD ["claude", "remote-control"]
