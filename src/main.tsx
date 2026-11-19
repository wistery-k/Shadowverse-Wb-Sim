// スターター（ベーシック＋伝説の幕開け）のページの入口（index.html）。探索 AI の補正はスターターのもの（src/engine/wasm.ts の既定）
import { App } from "./ui/App";
import { boot } from "./ui/boot";
import "./ui/style.css";

boot(() => <App />);
