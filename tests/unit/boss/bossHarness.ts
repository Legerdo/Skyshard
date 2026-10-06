/*
 * Headless Caelith encounter for tests: a BossEncounter on the Sanctum arena with a stand-in Active_Character (a hit
 * receiver that records hits and can Dodge / jump), and a tick loop with an optional party DPS model.
 */
import type { HitReceiver, ResolvedHit } from '../../../src/combat/attackRuntime';
import { BossEncounter, SANCTUM_ENCOUNTER_ARENA } from '../../../src/boss/bossEncounter';
import { createGameEventBus, type GameEventName } from '../../../src/core/gameEvents';
import { createRngStreams } from '../../../src/core/rng';
import type { Vec3 } from '../../../src/core/types';
import type { BossPhase } from '../../../src/logic/boss';
import type { RuntimeState } from '../../../src/save/runtimeState';

export const DT = 1 / 60;

export interface Dummy extends HitReceiver {
  pos: Vec3;
  hits: ResolvedHit[];
  iFrames: boolean;
}

export function makeDummy(pos: Vec3): Dummy {
  const d: Dummy = {
    id: 'player',
    pos,
    hits: [],
    iFrames: false,
    hurtVolume: () => ({ pos: d.pos, radius: 0.4, height: 1.75 }),
    immune: () => d.iFrames,
    sample: () => ({ def: 50, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false }),
    receive: (hit) => {
      d.hits.push(hit);
    },
    evade: () => {},
  };
  return d;
}

export function setupEncounter(seed = 20240601, start: BossPhase = 1) {
  const bus = createGameEventBus();
  const events: { t: number; type: GameEventName; payload: unknown }[] = [];
  const runtime: Pick<RuntimeState, 'boss' | 'zones'> = { boss: null, zones: [] };
  const record = { reached: 1 as BossPhase, defeated: false };
  const colliders = new Map<number, unknown>();
  const boss = new BossEncounter({
    bus,
    rng: createRngStreams(seed).boss,
    world: {
      upsertDynamic: (c) => {
        colliders.set(c.id, c);
        return true;
      },
      removeDynamic: (id) => colliders.delete(id),
    },
    colliderId: 9001,
    runtime,
    record: {
      reachedPhase: (p) => {
        record.reached = Math.max(record.reached, p) as BossPhase;
      },
      defeated: () => {
        record.defeated = true;
      },
    },
  });
  const c = SANCTUM_ENCOUNTER_ARENA.center;
  const dummy = makeDummy({ x: c.x, y: c.y, z: c.z + 2 });
  bus.onAny((type, payload) => events.push({ t: boss.time, type, payload }));
  boss.begin(start);
  const tick = (): void => {
    boss.tick({ dt: DT, target: dummy, frozen: false });
    bus.dispatch();
  };
  return { bus, boss, dummy, events, record, tick, runtime, colliders };
}

/** A party hit of `amount` final damage (no Element) on Caelith. */
export function partyHit(amount: number): ResolvedHit {
  return {
    attackerId: 'player', attackId: 'atk_kairen_n1', hitIndex: 0, kind: 'normal', amount, crit: false, element: null,
    stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
  };
}
