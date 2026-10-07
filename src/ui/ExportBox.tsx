// デッキのテキストを表示し、コピー・ファイル保存できる欄

import { useState } from "preact/hooks";

export function ExportBox({ text, fileName = "deck" }: { text: string; fileName?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName.replace(/[\\/:*?"<>|]/g, "_")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div class="export-box">
      <textarea readOnly rows={10} value={text} onFocus={(e) => e.currentTarget.select()} />
      <div class="row-buttons">
        <button type="button" onClick={copy}>
          {copied ? "コピーしました" : "コピー"}
        </button>
        <button type="button" onClick={download}>
          ファイルに保存
        </button>
        <span class="muted">data/decks/ に置くとデフォルトデッキになります</span>
      </div>
    </div>
  );
}
