// Resonance_Altar at the crater centre (design "진행 게이트", World Layout `resonance_altar`; Req 5.2–5.5). Its
// dais and plinth are static colliders; the plinth is an interaction target whose status line reads
// "Skyshard n/3" until all three are held (Req 5.2) and "공명시키기" after; once activated it is no longer
// offered. The light pillar shows from Skyshard 3 (Req 5.3).
// Activation (task 4.9, with `activation` given): an 'interact' on the altar while all three Skyshards are held
// sets GameState.altarActivated and publishes 'altar:activated' (Quest `interact resonance_altar`, the
// Cinematic_System's `cin_altar`) and 'save:request' ('altar', Req 5.5). GateSystem.tick then re-derives the
// barriers: seal_sanctum shatters and the Starlit_Stair appears when it is gone. Pure TypeScript: no three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import { RESONANCE_ALTAR } from '../data/starlitStair';
import { altarPillarVisible, altarPromptText, altarStatus, type WorldProgress } from '../logic/gates';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { Collider, CollisionWorld } from '../physics/types';
import type { InteractTarget } from '../player/interaction';

/** The dais sinks this far into the pad so its edge has no gap (m). */
const DAIS_SINK = 0.2;

/** The altar's static colliders: a low walkable dais and the plinth on it. */
export function altarColliders(ids: ColliderIdSource): Collider[] {
  const a = RESONANCE_ALTAR;
  const daisTop = a.pos.y + a.daisHeight;
  return [
    {
      kind: 'cylinder', id: ids.next(), base: { x: a.pos.x, y: a.pos.y - DAIS_SINK, z: a.pos.z }, radius: a.daisRadius,
      height: a.daisHeight + DAIS_SINK, flags: { climbable: false, walkableTop: true, blocksCamera: true, material: 'stone' },
    },
    {
      kind: 'cylinder', id: ids.next(), base: { x: a.pos.x, y: daisTop - 0.05, z: a.pos.z }, radius: a.plinthRadius,
      height: a.plinthHeight + 0.05, flags: { climbable: false, walkableTop: false, blocksCamera: true, material: 'stone' },
    },
  ];
}

export interface ResonanceAltarOptions {
  world: Pick<CollisionWorld, 'addStatic'>;
  ids: ColliderIdSource;
  /** Current GameState progress. */
  progress: () => WorldProgress;
  /** The activation flow: the bus the altar's 'interact' arrives on and the GameState flag it sets. */
  activation?: { bus: GameEventBus; state: { altarActivated: boolean } };
}

export class ResonanceAltar {
  private readonly progress: () => WorldProgress;
  private readonly unsubscribe: (() => void) | null = null;

  constructor(options: ResonanceAltarOptions) {
    this.progress = options.progress;
    for (const c of altarColliders(options.ids)) options.world.addStatic(c);
    const activation = options.activation;
    if (activation !== undefined) {
      this.unsubscribe = activation.bus.on('interact', (p) => {
        if (p.targetKind !== 'altar' || p.targetId !== RESONANCE_ALTAR.id || altarStatus(this.progress()) !== 'ready') return;
        activation.state.altarActivated = true;
        activation.bus.emit('altar:activated', {});
        activation.bus.emit('save:request', { reason: 'altar' });
      });
    }
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  /** The light pillar above the altar (Req 5.3). */
  get pillarVisible(): boolean {
    return altarPillarVisible(this.progress());
  }

  /** The plinth as an interaction target (kind 'altar', id 'resonance_altar'). */
  interactTarget(): InteractTarget {
    const a = RESONANCE_ALTAR;
    const base = { x: a.pos.x, y: a.pos.y, z: a.pos.z };
    return {
      kind: 'altar',
      id: a.id,
      name: a.name,
      a: base,
      b: base,
      radius: a.plinthRadius,
      height: a.daisHeight + a.plinthHeight,
      detail: () => altarPromptText(this.progress()),
      available: () => altarStatus(this.progress()) !== 'activated',
    };
  }
}
