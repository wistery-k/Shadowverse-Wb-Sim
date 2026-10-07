import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  // GitHub Pages はリポジトリ名のサブパスで配信される
  base: "/Shadowverse-Wb-Sim/",
  plugins: [preact()],
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
