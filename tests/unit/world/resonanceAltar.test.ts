import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/types';
import { RESONANCE_ALTAR } from '../../../src/data/starlitStair';
import type { WorldProgress } from '../../../src/logic/gates';
import { selectInteractTarget } from '../../../src/logic/interaction';
import { ColliderIdSource } from '../../../src/physics/colliderIds';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import { ResonanceAltar } from '../../../src/world/resonanceAltar';

// Resonance_Altar colliders, status line and light pillar (task 4.5; Req 5.2, 5.3).
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const { pos } = RESONANCE_ALTAR;

function setup(initial: WorldProgress) {
  let progress = initial;
  const world = createCollisionWorld(flatHeightfield(pos.y));
  const altar = new ResonanceAltar({ world, ids: new ColliderIdSource(), progress: () => progress });
  return { world, altar, set: (p: WorldProgress) => (progress = p) };
}

describe('ResonanceAltar', () => {
  it('stands a walkable dais around a solid plinth', () => {
    const { world } = setup({ skyshards: 0, altarActivated: false });
    const daisTop = pos.y + RESONANCE_ALTAR.daisHeight;
    const onDais = world.groundProbe(v(pos.x + 2, daisTop + 0.05, pos.z), 0.3);
    expect(onDais?.walkable).toBe(true);
    expect(onDais?.point.y).toBeCloseTo(daisTop, 5);
    const plinth = world.overlapCapsule(v(pos.x, daisTop + 0.1, pos.z), 0.4, 1.75);
    expect(plinth.some((c) => c.colliderId !== null)).toBe(true);
  });

  it('offers the plinth with "Skyshard n/3", then the activation line, and not once activated', () => {
    const { altar, set } = setup({ skyshards: 1, altarActivated: false });
    const target = altar.interactTarget();
    expect(target).toMatchObject({ kind: 'altar', id: 'resonance_altar', name: 'Resonance Altar' });
    const feet = v(pos.x + 2.2, pos.y + RESONANCE_ALTAR.daisHeight, pos.z); // on the dais
    expect(selectInteractTarget([target], feet)?.id).toBe('resonance_altar');
    expect(target.detail()).toBe('Skyshard 1/3');
    expect(altar.pillarVisible).toBe(false);
    set({ skyshards: 3, altarActivated: false });
    expect(target.detail()).toBe('공명시키기');
    expect(altar.pillarVisible).toBe(true);
    expect(target.available()).toBe(true);
    set({ skyshards: 3, altarActivated: true });
    expect(target.available()).toBe(false);
  });
});
