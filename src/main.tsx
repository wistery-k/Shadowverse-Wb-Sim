import { render } from "preact";
import { initEngine } from "./engine";
import { App } from "./ui/App";
import "./ui/style.css";

const root = document.getElementById("app");
// エンジン（WASM）を読み込んでから画面を出す。読み込みの間は、index.html の表示に進み具合を出す
// （受け取っている間は割合、受け取り終えたらコンパイルとインスタンス化を待っていること）
if (root) {
  const status = document.querySelector<HTMLElement>("#app .boot");
  initEngine((loaded, done) => {
    if (!status) return;
    if (done) status.textContent = "エンジンを準備しています…";
    else if (__SVWB_WASM_SIZE__ > 0) status.textContent = `エンジンを読み込んでいます…（${Math.min(99, Math.floor((loaded / __SVWB_WASM_SIZE__) * 100))}%）`;
    else status.textContent = `エンジンを読み込んでいます…（${(loaded / 1e6).toFixed(1)} MB）`;
  }).then(
    () => {
      root.textContent = "";
      render(<App />, root);
    },
    (e: unknown) => {
      root.textContent = `エンジンを読み込めませんでした: ${String(e)}`;
    },
  );
}
