// vite.config.ts の define でビルド時に埋め込む値

/** 最終コミットのハッシュ（取得できなければ空文字列） */
declare const __BUILD_COMMIT__: string;
/** 最終コミットの日時（ISO 8601。取得できなければ空文字列） */
declare const __BUILD_DATE__: string;
