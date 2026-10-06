import { describe, expect, it } from 'vitest';
import { mapMarkFlag, VISTA_REVEAL_RADIUS, VISTAS, vistaReachedFlag } from '../../../src/data/vistas';
import { WAYSTONE_LIST } from '../../../src/data/waystones';
import { FogOfWar } from '../../../src/logic/fogOfWar';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { FogSystem, VISIT_REVEAL_RADIUS } from '../../../src/world/fogSystem';

// Map fog in the World (task 13.5; Req 33.3, 9.5, 11.2).

describe('fog system', () => {
  it('reveals 40 m around the feet on each new cell and records the fog in GameState', () => {
    const gs = createNewGameState(1);
    const before = gs.discovery.fog;
    const fog = new FogSystem({ state: gs });
    fog.tick({ x: -250, y: 18, z: 300 });
    expect(gs.discovery.fog).not.toBe(before);
    const saved = FogOfWar.decode(gs.discovery.fog);
    expect(saved.isRevealed(-250 + VISIT_REVEAL_RADIUS - 6, 300)).toBe(true);
    expect(saved.isRevealed(-250 + VISIT_REVEAL_RADIUS + 12, 300)).toBe(false);
    const version = fog.version;
    fog.tick({ x: -249, y: 18, z: 300 }); // same cell: nothing new
    expect(fog.version).toBe(version);
    fog.tick({ x: -200, y: 18, z: 300 });
    expect(fog.version).toBeGreaterThan(version);
    expect(FogOfWar.decode(gs.discovery.fog).isRevealed(-200 + 30, 300)).toBe(true);
  });

  it('restores the saved reveal when the session is built again', () => {
    const gs = createNewGameState(1);
    new FogSystem({ state: gs }).tick({ x: 100, y: 10, z: 100 });
    const again = new FogSystem({ state: gs });
    expect(again.fog.isRevealed(100, 100)).toBe(true);
    expect(again.fog.revealedCount()).toBe(FogOfWar.decode(gs.discovery.fog).revealedCount());
  });

  it('reveals 200 m from a Vista_Point and marks the Waystones and Landmarks inside it (Req 9.5)', () => {
    const gs = createNewGameState(1);
    const vistas: [string, boolean][] = [];
    const fog = new FogSystem({ state: gs, onVista: (id, first) => vistas.push([id, first]) });
    const v = VISTAS.vista_verdant;
    fog.tick({ x: v.x, y: v.groundY - 30, z: v.z }); // at the windmill's foot: no Vista reveal
    expect(vistas).toEqual([]);
    fog.tick({ x: v.x, y: v.groundY, z: v.z });
    expect(vistas).toEqual([['vista_verdant', true]]);
    expect(gs.world.flags[vistaReachedFlag('vista_verdant')]).toBe(true);
    expect(fog.fog.isRevealed(v.x + VISTA_REVEAL_RADIUS - 6, v.z)).toBe(true);
    // ws_thistlewick (≈ 125 m) and ws_elderbough (≈ 112 m) lie within 200 m; ws_ember is far away.
    for (const w of WAYSTONE_LIST) {
      const inside = Math.hypot(w.x - v.x, w.z - v.z) <= VISTA_REVEAL_RADIUS;
      expect(gs.world.flags[mapMarkFlag(w.id)] === true, w.id).toBe(inside);
    }
    expect(gs.world.flags[mapMarkFlag('ws_thistlewick')]).toBe(true);
    expect(gs.world.flags[mapMarkFlag('lm_elderbough')]).toBe(true);
    expect(gs.world.flags[mapMarkFlag('lm_cinderspire')]).toBeUndefined();
    // Marking is not activation (Req 11.2).
    expect(gs.world.waystones).toEqual([]);
    // Standing on stays one arrival; leaving and coming back runs it again (not first).
    fog.tick({ x: v.x + 1, y: v.groundY, z: v.z });
    fog.tick({ x: v.x + 30, y: 22, z: v.z });
    fog.tick({ x: v.x, y: v.groundY, z: v.z });
    expect(vistas).toEqual([['vista_verdant', true], ['vista_verdant', false]]);
  });
});
