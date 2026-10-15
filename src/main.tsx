import { render } from "preact";
import { initEngine } from "./engine";
import { App } from "./ui/App";
import "./ui/style.css";

const root = document.getElementById("app");
// エンジン（WASM）を読み込んでから画面を出す
if (root) {
  initEngine().then(
    () => render(<App />, root),
    (e: unknown) => {
      root.textContent = `エンジンを読み込めませんでした: ${String(e)}`;
    },
  );
}
