// Interaction targets and the `interact` event (design "이벤트 버스" `interact`, "Dialogue_System" prompt rule;
// Req 14.3, 4.9, 5.2). Systems register their targets (the Resonance_Altar, closed Blight_Barriers; later NPCs,
// Chests, Waystones, ...). Each sim tick the nearest available target within 2.5 m of the Active_Character's
// feet becomes the prompt the HUD shows with its name, a status line and the key bound to `interact`; an
// `interact` press while a target is offered publishes 'interact' with its kind and id. What happens next
// belongs to the target's owner (dialogue, loot, the altar activation, ...). Pure TypeScript: no DOM.

import type { GameEventBus, InteractTargetKind } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import { selectInteractTarget, type InteractCandidate } from '../logic/interaction';

export interface InteractTarget extends InteractCandidate {
  readonly kind: InteractTargetKind;
  /** Name on the prompt (proper nouns stay English, Req 35.4). */
  readonly name: string;
  /** Status line under the name ("Skyshard 1/2"), or null for none; read every tick. */
  detail(): string | null;
  /** Whether the target is offered now (a lifted barrier or an activated altar is not). */
  available(): boolean;
}

/** What the HUD prompt shows; the key label is added from the current bindings. */
export interface InteractPrompt {
  readonly kind: InteractTargetKind;
  readonly id: string;
  readonly name: string;
  readonly detail: string | null;
}

export class InteractionSystem {
  private readonly bus: GameEventBus;
  private readonly targets = new Map<string, InteractTarget>();
  private offered: InteractPrompt | null = null;

  constructor(bus: GameEventBus) {
    this.bus = bus;
  }

  /** Registers a target (a target with the same kind and id is replaced); the returned function removes it. */
  add(target: InteractTarget): () => void {
    const key = `${target.kind}:${target.id}`;
    this.targets.set(key, target);
    return () => {
      if (this.targets.get(key) === target) this.targets.delete(key);
    };
  }

  /** The target offered after the last tick, or null. */
  get prompt(): InteractPrompt | null {
    return this.offered;
  }

  /**
   * One sim tick: offers the nearest available target to `feet` (null `feet` offers nothing, e.g. while a
   * recovery fade locks the input) and, when `pressed`, publishes 'interact' for it.
   */
  tick(feet: Readonly<Vec3> | null, pressed: boolean): void {
    const target = feet === null ? null : selectInteractTarget(this.availableTargets(), feet);
    if (target === null) {
      this.offered = null;
      return;
    }
    const detail = target.detail();
    const prev = this.offered;
    this.offered =
      prev !== null && prev.kind === target.kind && prev.id === target.id && prev.detail === detail
        ? prev
        : { kind: target.kind, id: target.id, name: target.name, detail };
    if (pressed) this.bus.emit('interact', { targetKind: target.kind, targetId: target.id });
  }

  private *availableTargets(): Iterable<InteractTarget> {
    for (const t of this.targets.values()) if (t.available()) yield t;
  }
}
