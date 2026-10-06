import { describe, expect, it } from 'vitest';
import { createGameEventBus, type GameEvents } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import {
  INTERACT_RANGE, INTERACT_VERTICAL_TOLERANCE, interactDistance, selectInteractTarget, type InteractCandidate,
} from '../../../src/logic/interaction';
import { InteractionSystem, type InteractTarget } from '../../../src/player/interaction';

// Nearest interaction target within 2.5 m (task 4.5; Req 14.3).
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const point = (id: string, x: number, z: number, radius = 0, y = 0, height = 1.8): InteractCandidate => ({
  id, a: v(x, y, z), b: v(x, y, z), radius, height,
});

describe('selectInteractTarget', () => {
  it('picks the nearest candidate within 2.5 m and nothing beyond', () => {
    const near = point('near', 1.5, 0);
    const far = point('far', 2.2, 0);
    expect(INTERACT_RANGE).toBe(2.5);
    expect(selectInteractTarget([far, near], v(0, 0, 0))?.id).toBe('near');
    expect(selectInteractTarget([point('edge', 2.5, 0)], v(0, 0, 0))?.id).toBe('edge');
    expect(selectInteractTarget([point('out', 2.51, 0)], v(0, 0, 0))).toBeNull();
    expect(selectInteractTarget([], v(0, 0, 0))).toBeNull();
  });

  it('measures to the target surface: a point plus its radius, a wall along its whole length', () => {
    expect(interactDistance(point('plinth', 3, 0, 0.8), v(0, 0, 0))).toBeCloseTo(2.2, 10);
    const wall: InteractCandidate = { id: 'wall', a: v(60, 20, 288), b: v(60, 20, 312), radius: 1, height: 14 };
    expect(interactDistance(wall, v(57, 20, 310))).toBeCloseTo(2, 10); // near one end, 3 m from the centre line
    expect(interactDistance(wall, v(57, 20, 320))).toBeCloseTo(Math.hypot(3, 8) - 1, 10); // past the end
    expect(interactDistance(wall, v(60.5, 20, 300))).toBe(0); // inside the wall thickness
  });

  it('ignores targets outside their vertical span plus the tolerance', () => {
    const npc = point('npc', 1, 0, 0, 0, 2); // spans y 0..2
    expect(INTERACT_VERTICAL_TOLERANCE).toBe(1);
    expect(selectInteractTarget([npc], v(0, -1, 0))?.id).toBe('npc');
    expect(selectInteractTarget([npc], v(0, -1.01, 0))).toBeNull(); // a ledge below
    expect(selectInteractTarget([npc], v(0, 3, 0))?.id).toBe('npc');
    expect(selectInteractTarget([npc], v(0, 3.01, 0))).toBeNull(); // a ledge above
  });

  it('breaks distance ties by id, independent of order', () => {
    const b = point('b', 1, 0);
    const a = point('a', -1, 0);
    expect(selectInteractTarget([b, a], v(0, 0, 0))?.id).toBe('a');
    expect(selectInteractTarget([a, b], v(0, 0, 0))?.id).toBe('a');
  });
});

describe('InteractionSystem', () => {
  const target = (id: string, x: number, available = () => true, detail: string | null = null): InteractTarget => ({
    ...point(id, x, 0), kind: 'altar', name: `Target ${id}`, detail: () => detail, available,
  });

  it('offers the nearest available target and publishes interact with its kind and id on a press', () => {
    const bus = createGameEventBus();
    const seen: GameEvents['interact'][] = [];
    bus.on('interact', (p) => seen.push(p));
    const system = new InteractionSystem(bus);
    let open = true;
    system.add(target('close', 1, () => open, 'Skyshard 0/3'));
    system.add(target('other', 2));

    system.tick(v(0, 0, 0), false);
    expect(system.prompt).toEqual({ kind: 'altar', id: 'close', name: 'Target close', detail: 'Skyshard 0/3' });
    system.tick(v(0, 0, 0), true);
    bus.dispatch();
    expect(seen).toEqual([{ targetKind: 'altar', targetId: 'close' }]);

    open = false; // e.g. an activated altar
    system.tick(v(0, 0, 0), false);
    expect(system.prompt?.id).toBe('other');
    system.tick(v(10, 0, 0), true);
    bus.dispatch();
    expect(system.prompt).toBeNull();
    expect(seen).toHaveLength(1); // a press with nothing in reach publishes nothing
    system.tick(null, true); // input locked
    expect(system.prompt).toBeNull();
  });

  it('removes a target through the function add returned', () => {
    const system = new InteractionSystem(createGameEventBus());
    const remove = system.add(target('t', 1));
    remove();
    system.tick(v(0, 0, 0), false);
    expect(system.prompt).toBeNull();
  });
});
