import { render } from "preact";
import { initEngine } from "./engine";
import { App } from "./ui/App";
import "./ui/style.css";

const root = document.getElementById("app");
// エンジン（WASM。3.5MB ほど）を読み込んでから画面を出す。読み込みの間は、index.html の「読み込んでいます」に進み具合を出す
if (root) {
  const status = document.getElementById("boot-status");
  const mb = (n: number) => (n / 1e6).toFixed(1);
  initEngine((loaded, total) => {
    if (status) status.textContent = total >= loaded ? `（${mb(loaded)} / ${mb(total)} MB）` : `（${mb(loaded)} MB）`;
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
