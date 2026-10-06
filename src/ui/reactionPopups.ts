import './reactionPopups.css';
import type { Vec3 } from '../core/types';
import type { ReactionId } from '../data/ids';
import { CHAIN_DISPLAY, REACTION_DEFS, REACTION_PRESENTATION } from '../data/reactions';
import { chainLabel } from '../logic/reactionEffects';
import type { ScreenAnchor } from './staminaRing';

/*
 * Reaction text (Req 25.9, 25.7; minimal until the HUD of task 14.3): each 'reaction' shows its Korean name in the
 * reaction's colour above the target (world projected, rising and fading over NAME_SECONDS), and a 'reaction:chain'
 * shows "연쇄 x{n}" under the top centre for 1.5 s. Name labels come from a small reused pool; the chain label is a
 * single live region. Only `transform`, `opacity`, `left` / `top`, colour and text are written.
 */

/** How long a reaction name stays above its target (real seconds). */
export const NAME_SECONDS = 1.1;
/** Name labels start this far above the target's feet (m). */
const NAME_LIFT = 2.2;
const POOL_SIZE = 8;

const css = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

interface NameLabel {
  el: HTMLDivElement;
  pos: Vec3;
  t: number;
  active: boolean;
}

export class ReactionPopups {
  private readonly names: NameLabel[] = [];
  private readonly chain: HTMLDivElement;
  private chainLeft = 0;

  constructor(parent: HTMLElement) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'hud-reaction-name';
      el.hidden = true;
      el.setAttribute('aria-hidden', 'true');
      parent.append(el);
      this.names.push({ el, pos: { x: 0, y: 0, z: 0 }, t: 0, active: false });
    }
    this.chain = document.createElement('div');
    this.chain.className = 'hud-reaction-chain';
    this.chain.hidden = true;
    this.chain.setAttribute('role', 'status');
    parent.append(this.chain);
  }

  /** A reaction at `pos` (the target's feet): its name above the target. */
  reaction(reaction: ReactionId, pos: Readonly<Vec3>): void {
    const label = this.names.find((n) => !n.active) ?? this.names.reduce((a, b) => (a.t >= b.t ? a : b));
    label.active = true;
    label.t = 0;
    label.pos = { x: pos.x, y: pos.y + NAME_LIFT, z: pos.z };
    label.el.textContent = REACTION_DEFS[reaction].name;
    label.el.style.color = css(REACTION_PRESENTATION[reaction].color);
    label.el.style.opacity = '1';
  }

  /** One application chained `count` reactions: "연쇄 x{count}" for 1.5 s when count ≥ 2. */
  chained(count: number): void {
    const text = chainLabel(count);
    if (text === null) return;
    this.chain.textContent = text;
    this.chain.hidden = false;
    this.chainLeft = CHAIN_DISPLAY.seconds;
  }

  /** One render frame of `realDt` s; `project` maps a world point to the screen (null off screen). */
  update(realDt: number, project: (pos: Readonly<Vec3>) => ScreenAnchor | null): void {
    const dt = Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    for (const n of this.names) {
      if (!n.active) continue;
      n.t += dt;
      const anchor = n.t < NAME_SECONDS ? project(n.pos) : null;
      if (n.t >= NAME_SECONDS) n.active = false;
      n.el.hidden = anchor === null;
      if (anchor === null) continue;
      const k = n.t / NAME_SECONDS;
      n.el.style.left = `${((anchor.x + 1) * 50).toFixed(2)}%`;
      n.el.style.top = `${((1 - anchor.y) * 50).toFixed(2)}%`;
      n.el.style.transform = `translate(-50%, ${(-100 - 60 * k).toFixed(1)}%)`;
      n.el.style.opacity = (k < 0.7 ? 1 : (1 - k) / 0.3).toFixed(2);
    }
    if (this.chainLeft > 0) {
      this.chainLeft -= dt;
      if (this.chainLeft <= 0) this.chain.hidden = true;
    }
  }
}
