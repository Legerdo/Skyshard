// Feature: skyshard-echoes-of-the-wild, Property 20: AI 상태 전이 제한
// Validates: Requirements 28.2
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ResolvedHit } from '../../src/combat/attackRuntime';
import { createPlayerReceiver } from '../../src/combat/playerReceiver';
import { createGameEventBus } from '../../src/core/gameEvents';
import { DEG2RAD, distance } from '../../src/core/math';
import { getEnemyDef } from '../../src/data/enemies';
import { ELEMENT_IDS, ELITE_IDS, ENEMY_IDS, type EliteId, type ElementId, type EnemyId, type EntityId } from '../../src/data/ids';
import { EnemySystem } from '../../src/enemies/enemySystem';
import { AI_STATES, AI_TRANSITIONS, aiTransition, sleepsAt, type AiState } from '../../src/logic/ai';
import { createNewGameState } from '../../src/logic/save/gameState';
import type { EnemyRuntime } from '../../src/save/runtimeState';

type Kind = EnemyId | EliteId;
const KINDS: readonly Kind[] = [...ENEMY_IDS, ...ELITE_IDS];
const LIVING: readonly AiState[] = AI_STATES.filter((s) => s !== 'dead');
const edge = (from: AiState, to: AiState): string => `${from}>${to}`;

/**
 * The design's state diagram ("AI 상태 머신"), written out independently of AI_TRANSITIONS: the Alive edges, and
 * HP 0 → dead from every living state. Everything else, self-transitions and anything out of dead included, is refused.
 */
const DESIGN_EDGES: ReadonlySet<string> = new Set([
  'idle>patrol', 'patrol>idle', 'idle>alert', 'patrol>alert', 'return>alert', 'alert>chase', 'chase>attack',
  'attack>recovery', 'recovery>chase', 'chase>stagger', 'attack>stagger', 'recovery>stagger', 'stagger>chase',
  'chase>return', 'recovery>return', 'return>idle', ...LIVING.map((s) => edge(s, 'dead')),
]);

// ---------------------------------------------------------------------------------------------------------------
// The table as an AI uses it: a kind requests states; a request applies only along an edge (EnemySystem.setState).

/**
 * One request to an enemy's AI. 'decide' takes one of the living edges the kind has from its current state (a random
 * walk over the table, so each edge is walked many times over the runs); 'request' asks for any of the kind's
 * living states (mostly refused); 'kill' is HP 0. Once dead, 'decide' falls back to any living state.
 */
type AiRequest = { type: 'decide' | 'request'; pick: number } | { type: 'kill' };

/** arbAiRequests: enemies in turn, each of any kind with its own request sequence (most die part-way through). */
const arbAiRequests = fc.array(
  fc.record({
    kind: fc.constantFrom(...KINDS),
    requests: fc.array(
      fc.oneof(
        { arbitrary: fc.record({ type: fc.constantFrom('decide' as const, 'request' as const), pick: fc.nat(99) }), weight: 12 },
        { arbitrary: fc.constant<AiRequest>({ type: 'kill' }), weight: 1 },
      ),
      { maxLength: 40, size: 'max' },
    ),
  }),
  { minLength: 1, maxLength: 20, size: 'max' },
);

interface RequestTally {
  taken: Set<string>;
  refused: number;
  deaths: number;
  afterDead: number;
}

/** Spawns an enemy of `kind` (idle) and applies `requests` to it, checking each against the design diagram. */
function runRequests(kind: Kind, requests: readonly AiRequest[], tally: RequestTally): void {
  const states = getEnemyDef(kind).aiStates;
  const living = states.filter((s) => s !== 'dead');
  let state: AiState = 'idle';
  for (const r of requests) {
    const from: AiState = state;
    let to: AiState = 'dead';
    if (r.type !== 'kill') {
      const next: readonly AiState[] = AI_TRANSITIONS[from].filter((s) => s !== 'dead' && states.includes(s));
      const pool: readonly AiState[] = r.type === 'decide' && next.length > 0 ? next : living;
      to = pool[r.pick % pool.length] ?? from;
    }
    const applied = aiTransition(from, to);
    if (applied) state = to;
    expect(applied).toBe(DESIGN_EDGES.has(edge(from, to)));
    expect(state).toBe(applied ? to : from); // a refused request leaves the state as it was
    expect(states).toContain(state);
    if (from === 'dead') {
      expect(state).toBe('dead');
      tally.afterDead++;
    }
    if (!applied) tally.refused++;
    else {
      tally.taken.add(edge(from, to));
      if (to === 'dead') tally.deaths++;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The real EnemySystem driven by game events.

const DT = 1 / 60;
const FLAT = { heightAt: () => 0 };
/** Design "갱신 비용": these states are reset to the spawn (idle, full HP) before an enemy sleeps beyond 80 m. */
const ENGAGED: readonly AiState[] = ['alert', 'chase', 'attack', 'recovery', 'stagger'];

type AiEvent =
  | { type: 'ticks'; n: number }
  | { type: 'move'; x: number; z: number }
  | { type: 'hit'; who: number; hpPct: number; stagger: number; knockback: number; element: ElementId | null }
  | { type: 'resetEngaged' };

// Integer-based, so values spread evenly over the range (fc.double favours values near 0).
/** A coordinate in [−r, r] m at 0.1 m steps. */
const coord = (r: number) => fc.integer({ min: -r * 10, max: r * 10 }).map((v) => v / 10);
const arbYaw = fc.integer({ min: -180, max: 180 }).map((deg) => deg * DEG2RAD);
/** A point `min`–`max` m from the origin in any direction. */
const ring = (min: number, max: number) =>
  fc.record({ yaw: arbYaw, r: fc.integer({ min, max }) }).map(({ yaw, r }) => ({ x: r * Math.cos(yaw), z: r * Math.sin(yaw) }));
/**
 * Where the target (the Active_Character) stands: in reach, around the ranged band, past the 30 m leash (inside
 * 80 m), or beyond 80 m.
 */
const arbSpot = fc.oneof(
  { arbitrary: fc.record({ x: coord(8), z: coord(8) }), weight: 3 },
  { arbitrary: fc.record({ x: coord(25), z: coord(25) }), weight: 2 },
  { arbitrary: ring(30, 70), weight: 2 },
  { arbitrary: ring(100, 150), weight: 1 },
);

/**
 * arbAiEvents: one to three enemies of any kind (Elites included) spawned around the origin, and an event sequence:
 * fixed ticks (a few, or long enough for the alert / stagger / 8 s lost-target clocks and walks home), the target
 * moving, party hits (HP as a share of the enemy's max, stagger gain, knockback, an Element for reactions) and the
 * Party_Wipe restart. The target starts at the origin.
 */
const arbAiEvents = fc.record({
  enemies: fc.array(fc.record({ kind: fc.constantFrom(...KINDS), x: coord(15), z: coord(15), yaw: arbYaw }), {
    minLength: 1,
    maxLength: 3,
  }),
  events: fc.array(
    fc.oneof(
      {
        arbitrary: fc.record({
          type: fc.constant('ticks' as const),
          n: fc.oneof(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 30, max: 300 })),
        }),
        weight: 16,
      },
      { arbitrary: arbSpot.map((p): AiEvent => ({ type: 'move', ...p })), weight: 6 },
      {
        arbitrary: fc.record({
          type: fc.constant('hit' as const),
          who: fc.nat(2),
          hpPct: fc.integer({ min: 0, max: 40 }),
          stagger: fc.integer({ min: 0, max: 220 }),
          knockback: fc.constantFrom(0, 1),
          element: fc.option(fc.constantFrom(...ELEMENT_IDS), { freq: 2 }),
        }),
        weight: 10,
      },
      { arbitrary: fc.constant<AiEvent>({ type: 'resetEngaged' }), weight: 1 },
    ),
    { maxLength: 60, size: 'max' },
  ),
});

/** The documented non-transition resets to the spawn: an engaged enemy going to sleep, and the Party_Wipe restart. */
type ResetKind = 'sleep' | 'restart';

interface Observed {
  edges: Map<string, number>;
  resets: Record<ResetKind, number>;
  /** Ticks and hits delivered while some enemy was already dead. */
  afterDead: number;
}

/**
 * Runs one scenario and returns every problem found: a state change that is neither an AI_TRANSITIONS edge nor the
 * documented reset to the spawn (the Party_Wipe restart, or an engaged enemy about to sleep beyond 80 m), a state
 * outside the kind's aiStates, any change out of dead, or a reset that did not leave the enemy idle at its spawn
 * with full HP. Every write to an enemy's `state` goes through an accessor, so each of several changes within one
 * tick is checked on its own.
 */
function runScenario(scenario: { enemies: { kind: Kind; x: number; z: number; yaw: number }[]; events: AiEvent[] }, seen: Observed): string[] {
  const bus = createGameEventBus();
  const enemyMap = new Map<EntityId, EnemyRuntime>();
  const enemies = new EnemySystem({ enemies: enemyMap, terrain: FLAT, bus });
  const body = { pos: { x: 0, y: 0, z: 0 }, iFrames: 0 };
  const player = createPlayerReceiver({ gameState: createNewGameState(1), bus, body: () => body });
  const problems: string[] = [];
  /** Which documented reset the non-edge change `from → idle` of `e` right now is, if any. */
  let resetKind: (e: EnemyRuntime, from: AiState) => ResetKind | null = () => null;
  const reset = new Set<EntityId>();

  const ids = scenario.enemies.map((s) => enemies.spawn({ kind: s.kind, pos: { x: s.x, y: 0, z: s.z }, yaw: s.yaw }));
  const receivers = [...enemies.receivers()];
  for (const id of ids) {
    const e = enemyMap.get(id) as EnemyRuntime;
    const states = getEnemyDef(e.def).aiStates;
    let state = e.state;
    Object.defineProperty(e, 'state', {
      configurable: true,
      enumerable: true,
      get: () => state,
      set: (to: AiState) => {
        const from = state;
        state = to;
        if (to === from) return;
        if (!states.includes(to)) problems.push(`${id}: entered ${to}, which ${e.def} does not use`);
        if (aiTransition(from, to)) {
          seen.edges.set(edge(from, to), (seen.edges.get(edge(from, to)) ?? 0) + 1);
          return;
        }
        const kind = from !== 'dead' && to === 'idle' ? resetKind(e, from) : null;
        if (kind === null) {
          problems.push(`${id}: ${from} → ${to} is not an AI_TRANSITIONS edge`);
          return;
        }
        reset.add(id);
        seen.resets[kind] += 1;
      },
    });
  }

  /** After a tick or restart: each reset left its enemy idle at its spawn with full HP. */
  const settle = (): void => {
    for (const id of reset) {
      const e = enemyMap.get(id);
      if (e === undefined || e.state !== 'idle' || e.hp !== e.maxHp || distance(e.pos, e.spawnPos) !== 0) {
        problems.push(`${id}: reset did not leave it idle at its spawn with full HP`);
      }
    }
    reset.clear();
    resetKind = () => null;
  };
  const anyDead = (): boolean => [...enemyMap.values()].some((e) => e.state === 'dead');

  for (const ev of scenario.events) {
    if (ev.type === 'ticks') {
      for (let i = 0; i < ev.n && problems.length === 0; i++) {
        if (anyDead()) seen.afterDead += 1;
        // Engaged enemies that sleep this tick are first reset to their spawn (design "갱신 비용").
        const sleeping = new Set(
          [...enemyMap.values()].filter((e) => ENGAGED.includes(e.state) && sleepsAt(distance(e.pos, body.pos))).map((e) => e.id),
        );
        resetKind = (e) => (sleeping.delete(e.id) ? 'sleep' : null);
        enemies.tick({ dt: DT, player });
        settle();
      }
    } else if (ev.type === 'move') {
      body.pos = { x: ev.x, y: 0, z: ev.z };
    } else if (ev.type === 'hit') {
      if (anyDead()) seen.afterDead += 1;
      // Delivered even to a dead body (immune, listed until removed): it must change nothing.
      const receiver = receivers[ev.who % receivers.length];
      const target = receiver === undefined ? undefined : enemyMap.get(receiver.id);
      if (receiver !== undefined && target !== undefined) {
        const dx = target.pos.x - body.pos.x;
        const dz = target.pos.z - body.pos.z;
        const d = Math.hypot(dx, dz);
        const hit: ResolvedHit = {
          attackerId: 'player', attackId: 'atk_kairen_n1', hitIndex: 0, kind: 'normal',
          amount: Math.max(1, Math.round((ev.hpPct / 100) * target.maxHp)), crit: false,
          element: ev.element, elementSource: ev.element === null ? null : 'kairen',
          stagger: ev.stagger, knockback: ev.knockback,
          direction: d > 1e-6 ? { x: dx / d, y: 0, z: dz / d } : { x: 0, y: 0, z: 1 },
        };
        receiver.receive(hit);
      }
    } else {
      resetKind = (_e, from) => (ENGAGED.includes(from) ? 'restart' : null);
      enemies.resetEngaged();
      settle();
    }
    bus.dispatch();
    if (problems.length > 0) break;
  }
  return problems;
}

describe('Property 20: AI 상태 전이 제한', () => {
  it('aiTransition allows exactly the design diagram edges among all 81 state pairs', () => {
    for (const from of AI_STATES) {
      for (const to of AI_STATES) {
        expect([edge(from, to), aiTransition(from, to)]).toEqual([edge(from, to), DESIGN_EDGES.has(edge(from, to))]);
      }
    }
    expect(AI_TRANSITIONS.dead).toEqual([]);
  });

  it('for any kind and AI request sequence only table edges apply, a refused request keeps the state, and dead is final', () => {
    const tally: RequestTally = { taken: new Set(), refused: 0, deaths: 0, afterDead: 0 };
    fc.assert(
      fc.property(arbAiRequests, (lives) => {
        for (const { kind, requests } of lives) runRequests(kind, requests, tally);
      }),
      { numRuns: 200 },
    );
    // Not vacuous: the walk takes every edge of the diagram, requests get refused, enemies die and keep being asked.
    expect([...DESIGN_EDGES].filter((e) => !tally.taken.has(e))).toEqual([]);
    expect(tally.refused).toBeGreaterThan(5000);
    expect(tally.deaths).toBeGreaterThan(500);
    expect(tally.afterDead).toBeGreaterThan(5000);
  });

  it('for any kinds and game events the EnemySystem changes state only along AI_TRANSITIONS edges (resets aside) and never out of dead', () => {
    const seen: Observed = { edges: new Map(), resets: { sleep: 0, restart: 0 }, afterDead: 0 };
    fc.assert(
      fc.property(arbAiEvents, (scenario) => {
        expect(runScenario(scenario, seen)).toEqual([]);
      }),
      { numRuns: 200 },
    );
    // Not vacuous: every state the system drives (patrol is not driven yet) is entered and left, enemies die and
    // are hit and ticked afterwards, and both kinds of reset happen.
    const into = (s: AiState): number => [...seen.edges].reduce((n, [e, k]) => (e.endsWith(`>${s}`) ? n + k : n), 0);
    const outOf = (s: AiState): number => [...seen.edges].reduce((n, [e, k]) => (e.startsWith(`${s}>`) ? n + k : n), 0);
    const driven: readonly AiState[] = ['alert', 'chase', 'attack', 'recovery', 'stagger', 'return'];
    expect(driven.filter((s) => into(s) === 0 || outOf(s) === 0)).toEqual([]);
    expect(outOf('idle')).toBeGreaterThan(100);
    expect(into('dead')).toBeGreaterThan(20);
    expect(seen.afterDead).toBeGreaterThan(1000);
    expect(seen.resets.sleep).toBeGreaterThan(20);
    expect(seen.resets.restart).toBeGreaterThan(20);
  });
});
