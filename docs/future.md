# 将来実装したいもの

いまは実装しないが、将来対応したいもののリスト。実装したら項目を消し、`docs/rules.md` 等の「未実装」の記述も直す。

## ルール

### 山札に戻したカードの手札での状態を維持する

- 公式ルール（ユーザー確認、2026-10-12）: 手札から山札に戻したカードは、手札で付いた状態を維持する。スペルブーストの回数（オーバーディメンションを使うスペルウィッチで重要）や、コスト変化（煌撃の戦士ベイル等）など。今後手札のカードに付く状態が増えても、基本的に同じく維持される
- 現状: 山札のカードは `CardRef`（`iid` と `cardId` だけ）で持つため、山札に戻すと `HandCard` の状態（`boosts`・`costMod`・`attackMod`・`defenseMod`・`keywords` 等）が消え、引いたときに初期状態で作り直される（`rust/engine/src/effects.rs` の `Effect::ReturnToDeck`、`rust/engine/src/state.rs` の `draw_cards` / `new_hand_card`）
- 影響するカード: `returnToDeck` を使うカード（オーバーディメンション、グリードケルブ・ルビィ、ウィッチ・ロイヤルの手札を山札に戻すカード）
- 実装の検討事項: 山札のカードに手札での状態を持たせる（状態の型と TypeScript との受け渡し（`src/engine/types.ts`・`rust/engine/src/state_json.rs`）・`rust/engine/src/ai/determinize.rs` の山札の並べ直しへの影響）
