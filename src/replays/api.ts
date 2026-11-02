// 開発サーバーが手元の試合の記録を配る場所と、一覧の形（配る側は scripts/replay-files.ts）。

export const REPLAY_API = "/__svwb/replays";

export interface ReplayFileEntry {
  /** 絶対パス（中身を取るときに渡す） */
  path: string;
  /** 探したフォルダと、そこからの相対パス */
  root: string;
  rel: string;
  size: number;
  mtime: number;
}

export interface ReplayFileList {
  roots: string[];
  files: ReplayFileEntry[];
}
