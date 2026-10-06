import type { BufferGeometry, Mesh, ShaderMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { rigUniformsOf } from '../../../src/anim/rigMaterial';
import { SHELL_PROGRAM_KEY } from '../../../src/anim/shellMaterial';
import { ELEMENT_DEFS } from '../../../src/data/elements';
import { ProceduralVisualInstance } from '../../../src/visual/proceduralProvider';
import { createPlayerReceiver } from '../../../src/combat/playerReceiver';
import { createGameEventBus } from '../../../src/core/gameEvents';
import { ENEMY_DESPAWN_SECONDS, EnemySystem } from '../../../src/enemies/enemySystem';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { createControllerState } from '../../../src/player/core/types';
import {
  DEATH_MOTION_SECONDS, DISSOLVE_SECONDS, TempEnemyView, dissolveAt,
} from '../../../src/render/tempEnemyView';
import { TempPickupView } from '../../../src/render/tempPickupView';
import type { EnemyRuntime } from '../../../src/save/runtimeState';
import { HIT_INDICATOR_SECONDS, screenAngle } from '../../../src/ui/hitIndicator';
import { enemyTelegraph, TelegraphDecals, type TelegraphInput } from '../../../src/vfx/decals';

// Temporary presentation of enemy attacks, hits, deaths and drops (task 7.7; Req 26.5–26.7, 28.13), built in Node
// without a WebGL context.
const DT = 1 / 60;

function arena() {
  const bus = createGameEventBus();
  const enemyMap = new Map<string, EnemyRuntime>();
  const enemies = new EnemySystem({ enemies: enemyMap, terrain: { heightAt: () => 0 }, bus });
  const player = createPlayerReceiver({
    gameState: createNewGameState(1), bus, body: () => createControllerState({ x: 0, y: 0, z: 0 }, 0),
  });
  return { enemies, enemyMap, tick: () => enemies.tick({ dt: DT, player }) };
}

describe('TempEnemyView', () => {
  it('shows the locked ground circle (VFX decal) during the Telegraph only, then plays the death motion and dissolve', () => {
    const { enemies, enemyMap, tick } = arena();
    const id = enemies.spawn({ kind: 'thornspitter', pos: { x: 0, y: 0, z: 10 }, yaw: Math.PI });
    const view = new TempEnemyView();
    // Task 19.5: the ground Telegraph decals are the VfxSystem's (src/vfx/decals), read from the attack playback.
    const decals = new TelegraphDecals((_x, _z, y) => y);
    const syncDecals = (): void => {
      const list: TelegraphInput[] = [];
      for (const e of enemyMap.values()) {
        const t = enemyTelegraph(e, e.pos, e.yaw);
        if (t !== null) list.push(t);
      }
      decals.sync(list, 0);
    };
    for (let i = 0; i < 600 && enemies.get(id)?.state !== 'attack'; i++) tick();
    tick();
    view.sync(enemyMap, 1);
    syncDecals();
    expect(decals.active).toBe(1);
    // The windup plays through the Telegraph and the body glows orange-red.
    expect(view.animationOf(id)?.animator?.current('action')).toBe('thornspitter_spike_windup');
    const glowRig = (view.viewOf(id)!.instance as ProceduralVisualInstance).rig;
    expect(rigUniformsOf(glowRig.material)!.uFlash.value).toBeGreaterThan(0.3);
    const key = `${id}:${enemies.get(id)?.attack?.def.id}`;
    const centre = decals.vertexOf(key, 8, 8); // the grid's middle vertex sits on the locked target point
    expect([centre?.x, centre?.y, centre?.z].map((n) => Math.round((n ?? NaN) * 100) / 100)).toEqual([0, 0.04, 0]);
    for (let i = 0; i < 60; i++) tick(); // past the 0.8 s circle: judged, decal gone
    view.sync(enemyMap, 1);
    syncDecals();
    expect(decals.active).toBe(0);
    decals.dispose();

    const [receiver] = [...enemies.receivers()];
    receiver?.receive({
      attackerId: 'player', attackId: 'atk_kairen_n1', hitIndex: 0, kind: 'normal', amount: 9999, crit: false,
      element: null, stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
    });
    const root = view.object.getObjectByName(`enemy:${id}`);
    expect(root).toBeDefined();
    // Task 19.3 / 19.4: the Thornspitter rig plays its defeat clip, then dissolves (uDissolve with a glowing edge).
    const rig = (view.viewOf(id)!.instance as ProceduralVisualInstance).rig;
    const dissolve = (): number => rigUniformsOf(rig.material)!.uDissolve.value;
    for (let i = 0; i < Math.round(DEATH_MOTION_SECONDS / DT); i++) tick();
    view.sync(enemyMap, 1);
    expect(view.animationOf(id)?.animator?.current('override')).toBe('thornspitter_defeat');
    expect(dissolve()).toBeCloseTo(0, 6); // the dissolve starts after the motion
    for (let i = 0; i < Math.round(DISSOLVE_SECONDS / DT); i++) tick();
    view.sync(enemyMap, 1);
    expect(dissolve()).toBeCloseTo(1, 6); // dissolved before the removal
    expect(rig.outline.visible).toBe(false);
    expect(enemyMap.has(id)).toBe(true);
    expect(DEATH_MOTION_SECONDS + DISSOLVE_SECONDS).toBeLessThanOrEqual(ENEMY_DESPAWN_SECONDS);
    expect(dissolveAt(ENEMY_DESPAWN_SECONDS)).toBe(1);
    for (let i = 0; i < 10; i++) tick();
    view.sync(enemyMap, 1);
    expect(enemyMap.has(id)).toBe(false);
    expect(view.object.getObjectByName(`enemy:${id}`)).toBeUndefined();
    view.dispose();
  });
});

describe('TempEnemyView models (task 19.3)', () => {
  it("wraps a Slagshell's Element_Shield in the shared shell (3 draw calls) and spins an Aether Sentinel's rings", () => {
    const { enemies, enemyMap, tick } = arena();
    const id = enemies.spawn({ kind: 'slagshell', pos: { x: 0, y: 0, z: 30 }, yaw: 0 });
    const sid = enemies.spawn({ kind: 'aetherSentinel', pos: { x: 12, y: 0, z: 30 }, yaw: 0 });
    const view = new TempEnemyView();
    tick();
    view.sync(enemyMap, 1);
    const root = view.object.getObjectByName(`enemy:${id}`)!;
    const shell = root.getObjectByName(`shield:${id}`) as Mesh<BufferGeometry, ShaderMaterial>;
    expect(shell.visible).toBe(true);
    expect((shell.material.uniforms.uColorB!.value as { getHex(): number }).getHex()).toBe(ELEMENT_DEFS.ember.color);
    expect(shell.material.customProgramCacheKey()).toBe(SHELL_PROGRAM_KEY);
    let calls = 0;
    root.traverseVisible((o) => { if ((o as Mesh).isMesh === true) calls++; });
    expect(calls).toBe(3); // body + outline + shell
    const ring = view.viewOf(sid)!.instance.joints.get('ring0')!;
    const before = ring.quaternion.clone();
    view.sync(enemyMap, 1, 0.5);
    expect(ring.quaternion.angleTo(before)).toBeGreaterThan(0.3);
    view.dispose();
    expect(view.object.children).toHaveLength(0);
  });
});

describe('TempPickupView', () => {
  it('shows one star per drop, floating at rest and at its position while pulled', () => {
    const view = new TempPickupView();
    const at = { x: 3, y: 1, z: -2 };
    view.sync([
      { id: 'drop_1', itemId: 'mat_starmote', count: 1, pos: at, prevPos: at, pulled: false, source: 'enemy' },
      { id: 'drop_2', itemId: 'mat_starmote', count: 1, pos: at, prevPos: at, pulled: true, source: 'enemy' },
    ], 1, 0);
    const shown = view.object.children.filter((c) => c.visible);
    expect(shown).toHaveLength(2);
    expect(shown[0]?.position.y).toBeGreaterThan(1.2);
    expect(shown[1]?.position.toArray()).toEqual([3, 1, -2]);
    view.sync([], 1, 0);
    expect(view.object.children.filter((c) => c.visible)).toHaveLength(0);
    view.dispose();
  });
});

describe('hit feedback on the Active_Character (Req 26.7)', () => {
  it('turns the attacker direction into a screen angle (0 ahead, +π/2 to the right)', () => {
    expect(screenAngle({ x: 0, y: 0, z: 1 }, 0)).toBeCloseTo(0, 9);
    expect(screenAngle({ x: -1, y: 0, z: 0 }, 0)).toBeCloseTo(Math.PI / 2, 9); // the camera's right at yaw 0 is −X
    expect(Math.abs(screenAngle({ x: 0, y: 0, z: -1 }, 0) ?? 0)).toBeCloseTo(Math.PI, 9);
    expect(screenAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2)).toBeCloseTo(0, 9);
    expect(screenAngle({ x: 0, y: 0, z: 0 }, 0)).toBeNull();
    expect(HIT_INDICATOR_SECONDS).toBe(0.4);
  });
  // The 0.4 s hurt motion of the Active_Character is HeroViews' (tests/unit/visual/visualProvider.test.ts).
});
