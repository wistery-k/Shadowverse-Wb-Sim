// カード1枚の表示（場・手札・詳細）

import { CLASS_NAMES, SET_NAMES, type Card } from "../cards";
import { abilitiesOf, cardOf, handCost, playCost, type HandCard, type OnBoard } from "../engine";
import { KEYWORD_NAMES, TYPE_NAMES, type AttackStatus } from "./describe";

interface Props {
  cardId: string;
  board?: OnBoard;
  hand?: HandCard;
  /** 手札のカードの持ち主の今の PP。渡すとエンハンスが有効なときにエンハンスのコストを表示する */
  pp?: number | undefined;
  selected?: boolean;
  /** 攻撃先・選択の候補 */
  targetable?: boolean;
  /** 行動できる */
  ready?: boolean;
  /** 攻撃の可否（場のフォロワーに、手番のときだけ渡す）。色で示す */
  attackable?: AttackStatus | null;
  /** アクトできる（場のアミュレット等）。黄色で示す */
  actable?: boolean;
  /** マリガンで残す・返す（手札のカードに、リプレイのマリガンのときだけ渡す） */
  mulligan?: MulliganMark | null;
  /** カード上端の帯に出す短い文言（マリガンの印が無いとき） */
  note?: string | null;
  /** 直前の行動の動き */
  motion?: Motion | null;
  onClick?: () => void;
  onHover?: () => void;
  /** ドラッグの開始（手札からのプレイ） */
  onPointerDown?: ((e: PointerEvent) => void) | undefined;
  /** ドラッグ中なら、元の位置からのずれ */
  dragOffset?: { x: number; y: number } | null;
}

/** keep・return: マリガンで残す・返す（マリガン前） / kept・drawn: 残した・引いた（マリガン後） */
export type MulliganMark = "keep" | "return" | "kept" | "drawn";

const MULLIGAN_LABELS: Record<MulliganMark, string> = {
  keep: "残す",
  return: "返す",
  kept: "残した",
  drawn: "引いた",
};

/** summon: 場に出た / attack-up・attack-down: その向きへ攻撃した / hit: 攻撃された */
export type Motion = "summon" | "attack-up" | "attack-down" | "hit";

export function CardView({
  cardId,
  board,
  hand,
  pp,
  selected,
  targetable,
  ready,
  attackable,
  actable,
  mulligan,
  note,
  motion,
  onClick,
  onHover,
  onPointerDown,
  dragOffset,
}: Props) {
  const card = cardOf(cardId);
  const keywords = board ? [...board.keywords, ...board.tempKeywords] : (hand?.keywords ?? []);
  const classes = [
    "card",
    `class-${card.class}`,
    selected ? "selected" : "",
    targetable ? "targetable" : "",
    ready ? "ready" : "",
    onClick ? "clickable" : "",
    board?.kind === "follower" && keywords.includes("ward") ? "ward" : "",
    attackable ? `attack-${attackable}` : "",
    actable ? "actable" : "",
    mulligan ? `mull-${mulligan}` : "",
    mulligan || note ? "tagged" : "",
    motion ? `motion-${motion}` : "",
    onPointerDown ? "draggable" : "",
    dragOffset ? "dragging" : "",
  ].join(" ");

  const cost = hand ? handCost(hand) : card.cost;
  // エンハンスが有効なら、エンハンスのコストを出し、元のコストをカッコで添える
  const enhanced = hand && pp !== undefined && playCost(card, pp, hand) > cost ? playCost(card, pp, hand) : null;
  const style = dragOffset ? { transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` } : undefined;

  return (
    <button
      type="button"
      class={classes}
      style={style}
      onClick={onClick}
      onMouseEnter={onHover}
      onPointerDown={onPointerDown}
      title={card.text}
    >
      {mulligan ? <div class={`card-tag mull-${mulligan}`}>{MULLIGAN_LABELS[mulligan]}</div> : note && <div class="card-tag note">{note}</div>}
      <div class="card-top">
        {enhanced !== null ? (
          <span class="cost enhanced" title={`エンハンス（元のコスト ${cost}）`}>
            {enhanced}
            <span class="cost-base">({cost})</span>
          </span>
        ) : (
          <span class={`cost ${hand && hand.costMod < 0 ? "reduced" : ""}`}>{cost}</span>
        )}
        <span class="card-name">{card.name}</span>
      </div>
      <div class="card-badges">
        {[...new Set(keywords)].map((k) => (
          <span class="badge" key={k}>
            {KEYWORD_NAMES[k]}
          </span>
        ))}
        {board?.kind === "follower" && board.evolve !== "none" && (
          <span class="badge evo">{board.evolve === "evolved" ? "進化" : "超進化"}</span>
        )}
        {board?.kind === "amulet" && board.countdown !== null && <span class="badge">CD {board.countdown}</span>}
        {board?.kind === "amulet" && board.sigils !== null && <span class="badge">印 {board.sigils}</span>}
        {hand && hand.x !== null && <span class="badge">X {hand.x}</span>}
        {hand && hand.boosts > 0 && hasSpellboost(cardId) && <span class="badge">SB {hand.boosts}</span>}
      </div>
      {card.type === "follower" ? (
        <div class="stats">
          <span class="atk">{board?.kind === "follower" ? Math.max(0, board.attack + board.tempAttack) : card.attack + (hand?.attackMod ?? 0)}</span>
          <span class="def">{board?.kind === "follower" ? board.defense : card.defense + (hand?.defenseMod ?? 0)}</span>
        </div>
      ) : (
        <div class="stats type">{TYPE_NAMES[card.type]}</div>
      )}
    </button>
  );
}

/** カードの詳細 */
export function CardDetail({ card }: { card: Card }) {
  return (
    <div class={`detail class-${card.class}`}>
      <div class="detail-head">
        <span class="cost">{card.cost}</span>
        <strong>{card.name}</strong>
      </div>
      <div class="detail-meta">
        {CLASS_NAMES[card.class]} / {TYPE_NAMES[card.type]}
        {card.tribes && card.tribes.length > 0 ? ` / ${card.tribes.join("・")}` : ""} / {SET_NAMES[card.set]}
        {card.type === "follower" ? ` / ${card.attack}/${card.defense}` : ""}
      </div>
      <div class="detail-text">{card.text || "（能力なし）"}</div>
    </div>
  );
}

export const hasSpellboost = (cardId: string) => abilitiesOf(cardId).abilities.some((a) => a.trigger.on === "spellboost");
