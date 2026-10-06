// Feature: skyshard-echoes-of-the-wild, Property 21: 근접 공격 토큰 상한
// Validates: Requirements 28.6
//
// 1. MeleeTokenPool against a reference model: for any acquire / release sequence (default capacity 2 and other
//    small capacities) `holders.size ≤ capacity` after every call; `acquire` is true exactly when the id already held
//    a token or a slot was free, and the id holds one afterwards exactly when it returned true; a refused acquire and
//    a release of a non-holder change nothing, and a release removes only that id. While the pool is full a
//    non-holder is refused until some holder releases.
// 2. The same bound in the EnemySystem: several melee enemies (plus a ranged one sometimes) closing in on a target,
//    with party hits that stagger or kill them, never have more than 2 token holders; every melee enemy in `attack`
//    holds a token, holders are live melee enemies in chase / attack / recovery, and ranged enemies never hold one.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { HitReceiver } from '../../src/combat/attackRuntime';
import { createGameEventBus } from '../../src/core/gameEvents';
import { yawFromDir } from '../../src/core/math';
import type { Vec3 } from '../../src/core/types';
import { getEnemyDef } from '../../src/data/enemies';
import { ENEMY_IDS, type EnemyId, type EntityId } from '../../src/data/ids';
import { EnemySystem } from '../../src/enemies/enemySystem';
import { MeleeTokenPool, type AiState } from '../../src/logic/ai';
import { createCollisionWorld } from '../../src/physics/collisionWorld';
import { flatHeightfield } from '../../src/physics/heightfield';
import type { EnemyRuntime } from '../../src/save/runtimeState';

// ---------------------------------------------------------------------------
// 1. The pool against a reference model
// ---------------------------------------------------------------------------

interface TokenOp {
  op: 'acquire' | 'release';
  id: string;
}

/** A few more ids than slots, so the pool is often full and refusals and re-acquires are common. */
const TOKEN_IDS = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5'] as const;
const arbId = fc.constantFrom(...TOKEN_IDS);

/** arbTokenOps: acquire / release calls over the ids, acquire-heavy so the slots fill up. */
const arbTokenOps: fc.Arbitrary<TokenOp[]> = fc.array(
  fc.oneof(
    { arbitrary: fc.record({ op: fc.constant('acquire' as const), id: arbId }), weight: 3 },
    { arbitrary: fc.record({ op: fc.constant('release' as const), id: arbId }), weight: 2 },
  ),
  { maxLength: 80, size: 'max' },
);

/** `null`: the default constructor (capacity 2, the EnemyAI's pool); otherwise an explicit small capacity. */
const arbCapacity = fc.oneof(
  { arbitrary: fc.constant(null), weight: 3 },
  { arbitrary: fc.integer({ min: 0, max: 4 }), weight: 2 },
);

// ---------------------------------------------------------------------------
// 2. The EnemySystem around one target
// ---------------------------------------------------------------------------

const DT = 1 / 60;
/** 6 s: alert, the approach, attacks, recoveries and the next attackers taking the freed tokens. */
const TICKS = 360;
const TARGET_RADIUS = 0.4;
const TARGET_HEIGHT = 1.75;
const MELEE_KINDS: readonly EnemyId[] = ENEMY_IDS.filter((k) => getEnemyDef(k).melee);
const RANGED_KINDS: readonly EnemyId[] = ENEMY_IDS.filter((k) => !getEnemyDef(k).melee);
/** States a token holder can be in: it gives the token back on recovery end, stagger, dead and return. */
const HOLDER_STATES: ReadonlySet<AiState> = new Set<AiState>(['chase', 'attack', 'recovery']);

interface Placement {
  kind: EnemyId;
  /** Bearing from the target in degrees, and distance in m; the enemy faces the target so it sees it at once. */
  bearing: number;
  distance: number;
}

type HitKind = 'poke' | 'stagger' | 'kill';

interface PartyHit {
  tick: number;
  /** Enemy index, taken modulo the enemy count. */
  who: number;
  kind: HitKind;
}

const arbPlacement = (kinds: readonly EnemyId[]): fc.Arbitrary<Placement> =>
  fc.record({
    kind: fc.constantFrom(...kinds),
    bearing: fc.integer({ min: 0, max: 359 }),
    distance: fc.integer({ min: 30, max: 100 }).map((d) => d / 10),
  });

const arbEncounter = fc.record({
  melee: fc.array(arbPlacement(MELEE_KINDS), { minLength: 3, maxLength: 6 }),
  ranged: fc.option(arbPlacement(RANGED_KINDS), { nil: undefined }),
  hits: fc.array(
    fc.record({
      tick: fc.integer({ min: 0, max: TICKS - 1 }),
      who: fc.nat({ max: 7 }),
      kind: fc.constantFrom<HitKind>('poke', 'stagger', 'stagger', 'kill'),
    }),
    { maxLength: 5 },
  ),
});

/** What one encounter showed, for the non-vacuity guards. */
interface EncounterStats {
  /** Most melee enemies in `attack` on one tick. */
  peakAttacking: number;
  /** Ticks on which some melee enemy was circling for a token while both were held. */
  waitingTicks: number;
  /** Distinct enemies that held a token at some point. */
  holders: number;
}

function runEncounter(melee: readonly Placement[], ranged: Placement | undefined, hits: readonly PartyHit[]): EncounterStats {
  const bus = createGameEventBus();
  const map = new Map<EntityId, EnemyRuntime>();
  const enemies = new EnemySystem({ enemies: map, terrain: { heightAt: () => 0 }, bus });
  const world = createCollisionWorld(flatHeightfield(0));
  const target: Vec3 = { x: 0, y: 0, z: 0 };
  const player: HitReceiver = {
    id: 'player',
    hurtVolume: () => ({ pos: target, radius: TARGET_RADIUS, height: TARGET_HEIGHT }),
    immune: () => false,
    sample: () => ({ def: 50, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false }),
    receive: () => {},
  };
  const spawn = ({ kind, bearing, distance }: Placement): EntityId => {
    const rad = (bearing * Math.PI) / 180;
    const pos = { x: Math.sin(rad) * distance, y: 0, z: Math.cos(rad) * distance };
    return enemies.spawn({ kind, pos, yaw: yawFromDir(-pos.x, -pos.z) });
  };
  const ids = melee.map(spawn);
  const rangedId = ranged === undefined ? null : spawn(ranged);
  const all = rangedId === null ? ids : [...ids, rangedId];

  const byTick = new Map<number, PartyHit[]>();
  for (const h of hits) byTick.set(h.tick, [...(byTick.get(h.tick) ?? []), h]);
  const partyHit = (id: EntityId, kind: HitKind): void => {
    const r = [...enemies.receivers()].find((x) => x.id === id);
    if (r === undefined) return; // already removed after its death
    r.receive({
      attackerId: 'player', attackId: 'atk_kairen_n1', hitIndex: 0, kind: 'normal', amount: kind === 'kill' ? 1e9 : 1,
      crit: false, element: null, stagger: kind === 'stagger' ? 1e4 : 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
    });
  };

  const everHeld = new Set<EntityId>();
  const stats: EncounterStats = { peakAttacking: 0, waitingTicks: 0, holders: 0 };
  /** The bound and the token bookkeeping, checked after every tick and every hit. */
  const check = (when: string): void => {
    const { holders } = enemies.tokens;
    expect(enemies.tokens.capacity, when).toBe(2);
    expect(holders.size, `${when}: token holders`).toBeLessThanOrEqual(2);
    for (const id of holders) {
      const e = map.get(id);
      expect(e, `${when}: holder ${id} is a live enemy`).toBeDefined();
      if (e === undefined) continue;
      expect(getEnemyDef(e.def).melee, `${when}: holder ${id} is melee`).toBe(true);
      expect(HOLDER_STATES.has(e.state), `${when}: holder ${id} in ${e.state}`).toBe(true);
      everHeld.add(id);
    }
    let attacking = 0;
    for (const id of ids) {
      const e = map.get(id);
      if (e?.state !== 'attack') continue;
      attacking += 1;
      expect(holders.has(id), `${when}: ${id} attacks without a token`).toBe(true);
    }
    expect(attacking, `${when}: melee enemies in attack`).toBeLessThanOrEqual(2);
    stats.peakAttacking = Math.max(stats.peakAttacking, attacking);
    if (holders.size === 2 && ids.some((id) => map.get(id)?.circling === true)) stats.waitingTicks += 1;
    if (rangedId !== null) expect(holders.has(rangedId), `${when}: ranged ${rangedId} holds a token`).toBe(false);
  };

  for (let t = 0; t < TICKS; t++) {
    for (const h of byTick.get(t) ?? []) {
      partyHit(all[h.who % all.length], h.kind);
      check(`tick ${t} after a ${h.kind} hit`);
    }
    enemies.tick({ dt: DT, player });
    enemies.resolveCollisions(world, player.hurtVolume(), DT);
    bus.dispatch();
    check(`tick ${t}`);
  }
  stats.holders = everHeld.size;
  return stats;
}

describe('Property 21: 근접 공격 토큰 상한', () => {
  it('MeleeTokenPool: never more holders than slots; acquire / release match the reference model on any call sequence', () => {
    let refused = 0;
    let reopened = 0; // non-holder successes after a refusal, once a holder released
    let fullDefault = 0; // calls made while the default pool had both of its slots taken
    const capacities = new Set<number>();
    fc.assert(
      fc.property(arbCapacity, arbTokenOps, (cap, ops) => {
        const pool = cap === null ? new MeleeTokenPool() : new MeleeTokenPool(cap);
        const capacity = cap ?? 2;
        expect(pool.capacity).toBe(capacity);
        capacities.add(capacity);
        const model = new Set<string>();
        let blocked = false; // a non-holder was refused and no holder has released since
        let wasRefused = false;
        for (const { op, id } of ops) {
          const before = new Set(pool.holders);
          if (cap === null && model.size === 2) fullDefault++;
          if (op === 'release') {
            if (model.delete(id)) blocked = false;
            pool.release(id);
            // Only `id` leaves; releasing a non-holder is ignored.
            expect(new Set(pool.holders)).toEqual(model);
          } else {
            const held = model.has(id);
            const ok = pool.acquire(id);
            expect(ok).toBe(held || model.size < capacity);
            expect(pool.holders.has(id)).toBe(ok);
            if (!ok) {
              expect(new Set(pool.holders)).toEqual(before); // a refusal changes nothing
              blocked = wasRefused = true;
              refused++;
            } else if (!held) {
              expect(blocked).toBe(false); // full since the refusal: only a holder's release reopens a slot
              if (wasRefused) reopened++;
              model.add(id);
            }
          }
          expect(pool.holders.size).toBeLessThanOrEqual(capacity);
          expect(new Set(pool.holders)).toEqual(model);
        }
      }),
      { numRuns: 200, seed: 2101 },
    );
    // Guard against a vacuous pass: the pools must fill up, refuse and reopen after releases, the default pool must
    // spend many calls full, and every capacity 0–4 must have been tried.
    expect(refused).toBeGreaterThan(500);
    expect(reopened).toBeGreaterThan(200);
    expect(fullDefault).toBeGreaterThan(1000);
    expect([...capacities].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('EnemySystem: at most 2 melee enemies attack at once, each holding a token, however many close in', () => {
    let crowded = 0; // encounters with two melee attackers at once
    let waited = 0; // encounters where a melee enemy circled for a token while both were held
    let turnover = 0; // encounters where more than two enemies took a token in turn
    fc.assert(
      fc.property(arbEncounter, ({ melee, ranged, hits }) => {
        const s = runEncounter(melee, ranged, hits);
        if (s.peakAttacking === 2) crowded++;
        if (s.waitingTicks > 0) waited++;
        if (s.holders > 2) turnover++;
      }),
      { numRuns: 200, seed: 2102 },
    );
    // Guard against a vacuous pass: two melee enemies must attack at once, refused ones must wait on the ring, and
    // freed tokens must pass on to the waiting ones.
    expect(crowded).toBeGreaterThan(100);
    expect(waited).toBeGreaterThan(100);
    expect(turnover).toBeGreaterThan(60);
  }, 30_000); // 200 simulated encounters: ≈ 3.5 s alone, past Vitest's 5 s default when the whole suite runs in parallel
});
