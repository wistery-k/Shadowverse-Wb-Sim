// カード1枚の表示（場・手札・詳細）

import { CLASS_NAMES, SET_NAMES, type Card } from "../cards";
import { abilitiesOf, cardOf, handCost, type HandCard, type OnBoard } from "../engine";
import { KEYWORD_NAMES, TYPE_NAMES } from "./describe";

interface Props {
  cardId: string;
  board?: OnBoard;
  hand?: HandCard;
  selected?: boolean;
  /** 攻撃先・選択の候補 */
  targetable?: boolean;
  /** 行動できる */
  ready?: boolean;
  /** 攻撃できる（follower: フォロワーのみ、leader: リーダーにも） */
  attackable?: "follower" | "leader" | null;
  /** 直前の行動の動き */
  motion?: Motion | null;
  onClick?: () => void;
  onHover?: () => void;
}

/** summon: 場に出た / attack-up・attack-down: その向きへ攻撃した / hit: 攻撃された */
export type Motion = "summon" | "attack-up" | "attack-down" | "hit";

export function CardView({ cardId, board, hand, selected, targetable, ready, attackable, motion, onClick, onHover }: Props) {
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
    attackable ? `can-attack-${attackable}` : "",
    motion ? `motion-${motion}` : "",
  ].join(" ");

  const cost = hand ? handCost(hand) : card.cost;

  return (
    <button type="button" class={classes} onClick={onClick} onMouseEnter={onHover} title={card.text}>
      <div class="card-top">
        <span class={`cost ${hand && hand.costMod < 0 ? "reduced" : ""}`}>{cost}</span>
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

const hasSpellboost = (cardId: string) => abilitiesOf(cardId).abilities.some((a) => a.trigger.on === "spellboost");
