import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { BossTelegraph, CaelithSnapshot } from '../../../src/boss/bossSnapshot';
import { createGameEventBus } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import { ELEMENT_IDS, REACTION_IDS, type EntityId } from '../../../src/data/ids';
import { REACTION_DEFS } from '../../../src/data/reactions';
import type { EffectZone, EnemyRuntime } from '../../../src/save/runtimeState';
import { ATLAS_PADDING, ATLAS_SIZE, spriteRect, spriteUv } from '../../../src/vfx/atlas';
import {
  CHEST_PILLAR_HEIGHT, DAMAGE_NUMBER_POOL_SIZE, ELEMENT_FX, REACTION_FX, SPRITE_IDS, TELEGRAPH_COLORS, catalogCovers,
  dissolveProgress, impactSparks,
} from '../../../src/vfx/catalog';
import { DamageNumberPool, floatScale } from '../../../src/vfx/damageNumbers';
import {
  DECAL_POLYGON_OFFSET, DECAL_POOL, DECAL_RENDER_ORDER, PUDDLE_RENDER_ORDER, TelegraphDecals, bossTelegraph, decalParams,
  type TelegraphInput,
} from '../../../src/vfx/decals';
import { BEAM_POOL, MeshFx, RING_POOL, SHARD_INSTANCES, SPHERE_POOL, VFX_RENDER_ORDER, VINE_INSTANCES, claimSlot } from '../../../src/vfx/meshFx';
import { ParticleBuffer, particleCapacity, scaledCount } from '../../../src/vfx/particles';
import { TRAIL_POOL, TRAIL_SEGMENTS, WeaponTrails, resampleTrail, type TrailSample } from '../../../src/vfx/trails';
import { VfxSystem, type VfxWorld } from '../../../src/vfx/vfxSystem';

// Task 19.5 VFX system, built in Node without a WebGL context or DOM (design "VFX 시스템", "Telegraph 표시",
// "타격 피드백"; Req 26, 25.9, 38.6).

describe('particle buffer', () => {
  it('holds 2,000 / 4,000 / 6,000 points by preset, 60 % additive and 40 % alpha in two draw groups', () => {
    expect([0.5, 1, 1.5].map((s) => particleCapacity(s).total)).toEqual([2000, 4000, 6000]);
    const cap = particleCapacity(1);
    expect([cap.add, cap.alpha]).toEqual([2400, 1600]);
    const p = new ParticleBuffer(1, new THREE.Texture());
    expect(p.points.frustumCulled).toBe(false);
    expect(p.points.geometry.groups).toEqual([
      { start: 0, count: 2400, materialIndex: 0 },
      { start: 2400, count: 1600, materialIndex: 1 },
    ]);
    expect(p.materials.map((m) => [m.blending, m.depthWrite])).toEqual([[THREE.AdditiveBlending, false], [THREE.NormalBlending, false]]);
    p.dispose();
  });

  it('scales burst counts by the preset (at least 1) but never essential ones', () => {
    expect(scaledCount(8, 0.5)).toBe(4);
    expect(scaledCount(1, 0.5)).toBe(1);
    expect(scaledCount(8, 1.5)).toBe(12);
    expect(scaledCount(8, 0.5, true)).toBe(8);
    expect(scaledCount(0, 1)).toBe(0);
  });

  it('writes into a ring per range, overwriting the oldest slot, and uploads only the written span', () => {
    const p = new ParticleBuffer(0.5, new THREE.Texture()); // 1,200 additive + 800 alpha
    p.setTime(2);
    expect(p.burst(impactSparks(false), 10, { x: 0, y: 1, z: 0 })).toBe(10);
    p.flush();
    expect(p.pendingRanges()).toEqual([{ start: 0, count: 30 }]);
    expect(p.nextSlot('add')).toBe(10);
    expect(p.nextSlot('alpha')).toBe(1200);
    // Fill the rest of the additive ring and wrap: slot 0 now holds the newest point.
    p.setTime(5);
    p.burst(impactSparks(false), 1195, { x: 0, y: 0, z: 0 });
    p.flush();
    expect(p.nextSlot('add')).toBe(5);
    expect(p.birthAt(0)).toBe(5);
    expect(p.birthAt(9)).toBe(2); // not overwritten yet
    expect(p.pendingRanges()).toEqual([{ start: 30, count: 1190 * 3 }, { start: 0, count: 15 }]);
    p.dispose();
  });
});

describe('sprite atlas', () => {
  it('lays nine sprites in 128 px cells of a 384 px atlas with 4 px margins', () => {
    expect(SPRITE_IDS).toHaveLength(9);
    for (const id of SPRITE_IDS) {
      const r = spriteRect(id);
      expect(r.size).toBe(120);
      expect((r.x - ATLAS_PADDING) % 128).toBe(0);
      expect(r.x + r.size + ATLAS_PADDING).toBeLessThanOrEqual(ATLAS_SIZE);
      const uv = spriteUv(id);
      expect(uv.u1 - uv.u0).toBeCloseTo(120 / 384, 9);
      expect(uv.v1).toBeLessThanOrEqual(1);
    }
    expect(spriteRect('ring')).toEqual({ x: 260, y: 260, size: 120 });
  });
});

describe('mesh effect pools', () => {
  it('caps every pool and takes back the oldest effect', () => {
    const fx = new MeshFx();
    const at = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < RING_POOL + 2; i++) fx.ring(at, 3, 0.5, 0xffffff);
    for (let i = 0; i < SPHERE_POOL + 1; i++) fx.sphere(at, 3, 0.35, 0xffffff);
    for (let i = 0; i < BEAM_POOL + 3; i++) fx.beam(at, { x: 0, y: 5, z: 0 }, 0.2, 1, 0xffffff);
    fx.shards(at, SHARD_INSTANCES + 20, 0xffffff);
    fx.vines(at, 2.5, VINE_INSTANCES + 6);
    expect(fx.counts()).toEqual({ rings: 5, spheres: 3, beams: 8, shards: 96, vines: 24 });
    fx.update(0.4);
    expect(fx.counts().spheres).toBe(0);
    fx.update(5); // past the last vine's start delay and its 2.5 s
    expect(fx.counts()).toEqual({ rings: 0, spheres: 0, beams: 0, shards: 0, vines: 0 });
    fx.dispose();
  });

  it('claimSlot takes a free slot first, else the lowest serial', () => {
    expect(claimSlot([{ active: true, t: 0, life: 1, delay: 0, serial: 3 }, { active: false, t: 0, life: 1, delay: 0, serial: 1 }])).toBe(1);
    expect(claimSlot([{ active: true, t: 0, life: 1, delay: 0, serial: 3 }, { active: true, t: 0, life: 1, delay: 0, serial: 2 }])).toBe(1);
  });
});

const telegraph = (over: Partial<TelegraphInput>): TelegraphInput => ({
  key: 'k', shape: 'circle', center: { x: 0, y: 0, z: 0 }, yaw: 0, radius: 2, inner: 0, angleDeg: 90, length: 0, width: 1,
  progress: 0.5, boss: false, strong: false, flat: false, ...over,
});

describe('Telegraph decals', () => {
  it('derives shape parameters, grid bounds and colours', () => {
    const circle = decalParams(telegraph({ radius: 2.4 }));
    expect(circle?.bounds).toEqual({ x0: -2.4, x1: 2.4, z0: -2.4, z1: 2.4 });
    const sector = decalParams(telegraph({ shape: 'sector', radius: 2.4, angleDeg: 150 }));
    expect(sector?.half).toBeCloseTo((75 * Math.PI) / 180, 9);
    expect(sector?.bounds.z0).toBe(0); // entirely in front
    expect(sector?.bounds.x1).toBeCloseTo(2.4 * Math.sin((75 * Math.PI) / 180), 9);
    const line = decalParams(telegraph({ shape: 'line', length: 12, width: 1.4 }));
    expect(line?.bounds).toEqual({ x0: -0.7, x1: 0.7, z0: 0, z1: 12 });
    expect(decalParams(telegraph({ shape: 'ring', radius: 5 }))?.inner).toBe(4);
    expect(decalParams(telegraph({ radius: 0 }))).toBeNull();
    expect(decalParams(telegraph({ progress: 1.7 }))?.progress).toBe(1);
    expect(decalParams(telegraph({}))?.edge).toBe(0xff4a2a);
    const boss = decalParams(telegraph({ boss: true, strong: true }));
    expect([boss?.edge, boss?.fill]).toEqual([TELEGRAPH_COLORS.boss.edge, TELEGRAPH_COLORS.boss.fill]);
    expect([boss?.edge, boss?.fill]).toEqual([0xffc247, 0xe03a2a]);
    expect(boss?.outline).toBeGreaterThan(circle?.outline ?? Infinity);
  });

  it("maps Caelith's Telegraph shapes onto the four decals with the fill rising to 1 at the judgement", () => {
    const base: BossTelegraph = {
      id: 1, attack: 'atk_caelith_groundSlam', shape: 'circle', center: { x: 1, y: 30, z: 2 }, yaw: 0, radius: 6, angleDeg: 0,
      length: 0, width: 0, sector: -1, remaining: 0.3, duration: 1.2, strong: true,
    } as BossTelegraph;
    expect(bossTelegraph(base)).toMatchObject({ shape: 'circle', radius: 6, boss: true, flat: true, key: 'boss:1' });
    expect(bossTelegraph(base).progress).toBeCloseTo(0.75, 9);
    expect(bossTelegraph({ ...base, shape: 'arenaSector', angleDeg: 45, radius: 30 }).shape).toBe('sector');
    expect(bossTelegraph({ ...base, shape: 'aim', length: 20, width: 1 })).toMatchObject({ shape: 'line', length: 20 });
    expect(bossTelegraph({ ...base, shape: 'ring', radius: 0 })).toMatchObject({ shape: 'ring', radius: 6 });
  });

  it('draws above every combat effect, with polygon offset, depth test and no depth write; the pool of 12 grows', () => {
    const ground = (x: number, z: number): number => 0.1 * x + 0.05 * z;
    const decals = new TelegraphDecals(ground);
    expect(decals.poolSize).toBe(DECAL_POOL);
    const list = Array.from({ length: 13 }, (_, i) => telegraph({ key: `t${i}`, center: { x: i * 10, y: 0, z: 0 } }));
    decals.sync(list, 0);
    expect(decals.active).toBe(13);
    expect(decals.poolSize).toBe(13);
    const mesh = decals.meshOf('t3');
    const material = mesh?.material as THREE.ShaderMaterial;
    expect(mesh?.renderOrder).toBe(DECAL_RENDER_ORDER);
    expect(DECAL_RENDER_ORDER).toBeGreaterThan(VFX_RENDER_ORDER);
    expect(PUDDLE_RENDER_ORDER).toBeLessThan(DECAL_RENDER_ORDER);
    expect([material.polygonOffset, material.polygonOffsetFactor, material.polygonOffsetUnits]).toEqual([
      true, DECAL_POLYGON_OFFSET.factor, DECAL_POLYGON_OFFSET.units,
    ]);
    expect([material.depthTest, material.depthWrite]).toEqual([true, false]);
    // Ground conforming: every grid vertex sits 4 cm over the ground under it.
    const corner = decals.vertexOf('t3', 0, 0) as Vec3;
    expect(corner.x).toBeCloseTo(28, 9);
    expect(corner.z).toBeCloseTo(-2, 9);
    expect(corner.y).toBeCloseTo(ground(corner.x, corner.z) + 0.04, 5); // Float32 vertex buffer
    expect(decals.activeTelegraphs()).toHaveLength(13);
    decals.sync(list.slice(0, 2), 0);
    expect(decals.active).toBe(2);
    decals.dispose();
  });

  it('turns local +Z along the yaw: a line at yaw π/2 reaches along +X', () => {
    const decals = new TelegraphDecals((_x, _z, y) => y);
    decals.sync([telegraph({ key: 'l', shape: 'line', length: 10, width: 2, yaw: Math.PI / 2, flat: true })], 0);
    const far = decals.vertexOf('l', 8, 16) as Vec3; // x = 0, z = length
    expect([far.x, far.z].map((n) => Math.round(n * 1e6) / 1e6)).toEqual([10, 0]);
    decals.dispose();
  });
});

describe('floating texts', () => {
  it('keeps 24 elements and reuses the oldest for the 25th', () => {
    const pool = new DamageNumberPool();
    expect(pool.slots).toHaveLength(DAMAGE_NUMBER_POOL_SIZE);
    const at = { x: 0, y: 0, z: 0 };
    const first = pool.damage(10, 'ember', false, at);
    for (let i = 1; i < 24; i++) pool.damage(10 + i, null, false, at);
    expect(pool.activeCount).toBe(24);
    expect(pool.damage(99, 'tide', true, at)).toBe(first);
    expect(pool.activeCount).toBe(24);
    expect(pool.slots[first]?.text).toBe('99');
  });

  it('shows crits 1.5× larger, numbers 0.8 s and Reaction names (Korean) 1.0 s', () => {
    const pool = new DamageNumberPool();
    const n = pool.damage(123.4, 'gale', true, { x: 0, y: 0, z: 0 });
    const r = pool.reaction('steamBurst', { x: 0, y: 0, z: 0 });
    expect(pool.slots[r]?.text).toBe(REACTION_DEFS.steamBurst.name);
    expect(pool.slots[r]?.text).toBe('증기 폭발');
    expect([pool.slots[n]?.life, pool.slots[r]?.life]).toEqual([0.8, 1.0]);
    expect(floatScale({ crit: true, kind: 'damage' }, 0.5)).toBe(1.5);
    expect(floatScale({ crit: false, kind: 'damage' }, 0.5)).toBe(1);
    pool.update(0.85);
    expect([pool.slots[n]?.active, pool.slots[r]?.active]).toEqual([false, true]);
    pool.update(0.2);
    expect(pool.activeCount).toBe(0);
  });
});

describe('catalog', () => {
  it('has a recipe for every Element and Reaction, with the Korean Reaction names', () => {
    expect(catalogCovers()).toEqual({ elements: true, reactions: true });
    expect(Object.keys(ELEMENT_FX).sort()).toEqual([...ELEMENT_IDS].sort());
    expect(Object.keys(REACTION_FX).sort()).toEqual([...REACTION_IDS].sort());
    expect(REACTION_IDS.map((r) => REACTION_FX[r].label)).toEqual(['증기 폭발', '용암 균열', '진흙 속박', '불꽃 확산', '물안개 확산', '모래 돌풍']);
    for (const id of ELEMENT_IDS) expect(ELEMENT_FX[id].bursts.some((b) => b.essential === true)).toBe(true);
    for (const id of REACTION_IDS) expect(REACTION_FX[id].bursts.some((b) => b.essential === true)).toBe(true);
  });

  it("gives a glowing Chest a pillar twice the common one's and dissolves bodies within 1.5 s", () => {
    expect(CHEST_PILLAR_HEIGHT.glowing).toBe(2 * CHEST_PILLAR_HEIGHT.common);
    expect([dissolveProgress(0.4), dissolveProgress(0.9), dissolveProgress(1.4), dissolveProgress(1.5)]).toEqual(
      [0, 0.5, 1, 1].map((n) => expect.closeTo(n, 9)),
    );
  });
});

describe('weapon trails', () => {
  const swing = (fps: number, until: number): TrailSample[] => {
    const out: TrailSample[] = [];
    for (let t = 0; t <= until + 1e-9; t += 1 / fps) out.push({ t, tip: { x: t * 10, y: 1, z: 0 }, base: { x: t * 10, y: 0, z: 0 } });
    return out;
  };

  it('resamples the last 0.15 s into 12 segments whatever the frame rate', () => {
    const slow = resampleTrail(swing(30, 0.5), 0.5);
    const fast = resampleTrail(swing(144, 0.5), 0.5);
    expect(slow?.tip).toHaveLength(TRAIL_SEGMENTS + 1);
    expect(fast?.tip).toHaveLength(TRAIL_SEGMENTS + 1);
    expect(slow?.tip[0]?.x).toBeCloseTo(fast?.tip[0]?.x ?? NaN, 1);
    expect(slow?.tip[TRAIL_SEGMENTS]?.x).toBeCloseTo(3.5, 1); // 0.35 s × 10 m/s
    expect(fast?.tip[TRAIL_SEGMENTS]?.x).toBeCloseTo(3.5, 1);
    expect(resampleTrail(swing(60, 0.1), 0.5)).toBeNull(); // newest sample older than the window
  });

  it('keeps a pool of two ribbons', () => {
    const trails = new WeaponTrails();
    for (const key of ['a', 'b', 'c']) {
      trails.sample(key, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, 'ember', 0);
      trails.sample(key, { x: 1, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 'ember', 0.05);
    }
    trails.update(0.05);
    expect(trails.active).toBe(TRAIL_POOL);
    trails.end('c');
    trails.update(0.5);
    expect(trails.active).toBe(0);
    trails.dispose();
  });
});

/** A shielded Slagshell stand-in (only the fields the VfxSystem reads). */
function slagshell(id: EntityId): EnemyRuntime {
  const pos = { x: 4, y: 0, z: 0 };
  return {
    id, def: 'slagshell', pos, prevPos: { ...pos }, yaw: 0, prevYaw: 0, state: 'chase', stateTime: 0, attack: null, aim: null,
    element: { mark: null, shield: { element: 'ember', durability: 300, max: 300 } },
  } as unknown as EnemyRuntime;
}

function world(enemies: Map<EntityId, EnemyRuntime>, zones: EffectZone[] = []): VfxWorld {
  return {
    groundAt: (_x, _z, y) => y,
    player: () => ({ pos: { x: 0, y: 0, z: 0 }, character: 'kairen' }),
    enemies: () => enemies,
    boss: () => null as CaelithSnapshot | null,
    zones: () => zones,
    chest: () => ({ x: 1, y: 0, z: 1 }),
    barrier: () => null,
    altar: () => ({ x: 0, y: 0, z: 0 }),
    landmarks: () => [],
    characterModel: () => null,
  };
}

describe('VfxSystem', () => {
  it('reacts to the bus and the onHit hook, keeps its clock real-time, and rebuilds the buffer on a preset change', () => {
    const bus = createGameEventBus();
    const enemies = new Map<EntityId, EnemyRuntime>([['e1', slagshell('e1')]]);
    let quality = 'medium';
    const breaks: boolean[] = [];
    const vfx = new VfxSystem({
      bus, camera: new THREE.PerspectiveCamera(), world: world(enemies), quality: () => quality,
      onShieldBreak: (_p, starshell) => breaks.push(starshell),
    });
    expect(vfx.particles.capacity.total).toBe(4000);

    vfx.onHit({ targetId: 'e1', pos: { x: 4, y: 1, z: 0 }, dir: { x: 1, y: 0, z: 0 }, amount: 50, crit: false, element: 'ember', toPlayer: false });
    expect(vfx.hitFlash('e1')).toBe(1);
    vfx.update(0.05, 1);
    expect(vfx.hitFlash('e1')).toBeCloseTo(0.5, 6);
    vfx.update(0.06, 1);
    expect(vfx.hitFlash('e1')).toBe(0);
    expect(vfx.particles.totalEmitted).toBe(8 + 4); // white sparks + Ember sprites

    bus.emit('damage:dealt', { targetId: 'e1', amount: 50, crit: true, element: 'ember', position: { x: 4, y: 1.6, z: 0 } });
    bus.emit('reaction', { reaction: 'steamBurst', targetId: 'e1', position: { x: 4, y: 0, z: 0 }, chainDepth: 1 });
    bus.emit('element:applied', { targetId: 'e1', element: 'tide', source: 'kairen' });
    bus.emit('chest:opened', { chestId: 'c', tier: 'glowing' });
    bus.dispatch();
    expect(vfx.numbers.activeCount).toBe(2); // the number and "증기 폭발"
    expect(vfx.meshes.counts()).toMatchObject({ spheres: 1, beams: 2 });
    expect(vfx.meshes.counts().rings).toBe(2); // steam shock ring + Tide ripple

    // The Element_Shield breaks between frames.
    const e = enemies.get('e1') as EnemyRuntime;
    e.element = { ...e.element, shield: null };
    vfx.update(0.016, 1);
    expect(breaks).toEqual([false]);

    const before = vfx.time;
    vfx.update(0.5, 1, true);
    expect(vfx.time).toBe(before); // paused: the clock stops

    quality = 'low';
    vfx.update(0.016, 1);
    expect(vfx.particles.capacity.total).toBe(2000);
    vfx.dispose();
  });

  it("draws enemy Telegraphs from the attack playback and puddles from the lava zones", () => {
    const bus = createGameEventBus();
    const e = slagshell('e2');
    Object.assign(e, {
      state: 'attack',
      attack: { def: { id: 'atk_slagshell_slam', hits: [{ t: 1 }], telegraph: { kind: 'circle', duration: 1, strong: true, radius: 3 } }, t: 0.25 },
    });
    const enemies = new Map<EntityId, EnemyRuntime>([['e2', e]]);
    const zones: EffectZone[] = [{ id: 'z1', source: 'lavaRift', owner: 'player', pos: { x: 0, y: 0, z: 5 }, radius: 3, until: 10 }];
    const vfx = new VfxSystem({ bus, camera: new THREE.PerspectiveCamera(), world: world(enemies, zones) });
    vfx.update(0.016, 1);
    expect(vfx.telegraphs.active).toBe(1);
    expect(vfx.activeTelegraphs()[0]?.color).toBe(0xff4a2a);
    expect(vfx.puddles.active).toBe(1);
    vfx.dispose();
  });
});
