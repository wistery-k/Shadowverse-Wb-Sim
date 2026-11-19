import { render, type ComponentChildren } from "preact";
import { initEngine } from "../engine";

/**
 * エンジン（WASM）を読み込んでから画面を出す（ページの入口 src/main.tsx・src/azvaldt/main.tsx）。
 * 読み込みの間は、index.html の表示に進み具合を出す（受け取っている間は割合、受け取り終えたらコンパイルとインスタンス化を待っていること）。
 * 画面は AI を動かさないので、探索 AI の補正は読み込まない（AI を動かす Worker が読み込む。src/engine/wasm.ts）
 */
export function boot(app: () => ComponentChildren): void {
  const root = document.getElementById("app");
  if (!root) return;
  const status = document.querySelector<HTMLElement>("#app .boot");
  initEngine(
    (loaded, done) => {
      if (!status) return;
      if (done) status.textContent = "エンジンを準備しています…";
      else if (__SVWB_WASM_SIZE__ > 0) status.textContent = `エンジンを読み込んでいます…（${Math.min(99, Math.floor((loaded / __SVWB_WASM_SIZE__) * 100))}%）`;
      else status.textContent = `エンジンを読み込んでいます…（${(loaded / 1e6).toFixed(1)} MB）`;
    },
    { nets: false },
  ).then(
    () => {
      root.textContent = "";
      render(app(), root);
    },
    (e: unknown) => {
      root.textContent = `エンジンを読み込めませんでした: ${String(e)}`;
    },
  );
}
