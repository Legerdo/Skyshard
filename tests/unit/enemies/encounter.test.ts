import { describe, expect, it } from 'vitest';
import type { HitReceiver, ResolvedHit } from '../../../src/combat/attackRuntime';
import { PlayerCombat } from '../../../src/combat/playerCombat';
import { createPlayerReceiver } from '../../../src/combat/playerReceiver';
import { createGameEventBus, type GameEventName, type GameEvents } from '../../../src/core/gameEvents';
import { distanceXZ, yawFromDir } from '../../../src/core/math';
import { createRngStreams } from '../../../src/core/rng';
import type { Vec3 } from '../../../src/core/types';
import { getEnemyDef } from '../../../src/data/enemies';
import type { CampDef, SpawnerDef } from '../../../src/data/spawns';
import { ENEMY_DESPAWN_SECONDS, EnemySystem } from '../../../src/enemies/enemySystem';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { InventorySystem } from '../../../src/inventory/inventorySystem';
import { ALERT_SECONDS, type AiState } from '../../../src/logic/ai';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { LootSystem, type CampClearedNotice } from '../../../src/loot/lootSystem';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import { PlayerController } from '../../../src/player/playerController';
import { ProgressionSystem } from '../../../src/progression/progressionSystem';
import type { EnemyRuntime } from '../../../src/save/runtimeState';
import { SpawnerSystem } from '../../../src/world/spawnerSystem';

// Checkpoint 8 (M4): one Enemy_Camp fought from first sight to its clear, headless, with the real systems in the
// PlaySim tick order (PlayerController → PlayerCombat → EnemyAI → CollisionResolve → drop pickups → EventDispatch).
// A scripted Kairen walks in with W and fights with Mouse0 taps only (no Dodge), so the enemies' attacks land.
// Covers detection (cone / 6 m) → 0.5 s alert → chase → melee tokens (≤ 2 attacking) → Telegraph before every
// landed hit → hits, Mossback Brute's guard-break Stagger → death, 1.5 s body removal → XP / Glim / drops with the
// 3 m pickup → 'camp:cleared' once, the Chest unlocked, and the cleared camp staying empty on a rebuild
// (Req 28.2–28.6, 28.9–28.11, 28.13, 26.6, 26.9, 10.7, 11.6).

const DT = 1 / 60;
const SEED = 7;
const EPS = 1e-9;
const CAMP: CampDef = { id: 'camp_verdant_1', region: 'verdant', chestId: 'chest_verdant_1' };
const FACING_SOUTH = yawFromDir(0, -1);
const member = (n: number, kind: SpawnerDef['kind'], x: number, z: number): SpawnerDef => ({
  id: `sp_${CAMP.id}_${n}`, region: 'verdant', kind, pos: { x, z, y: 'ground' }, yaw: FACING_SOUTH, level: 1,
  campId: CAMP.id, respawn: 'roaming',
});
/** Three Bramblekin in front, a Mossback Brute behind them, all facing the player's approach from the south. */
const SPAWNERS: SpawnerDef[] = [
  member(1, 'bramblekin', -1.5, 22),
  member(2, 'bramblekin', 1.5, 22),
  member(3, 'bramblekin', 0, 25),
  member(4, 'mossbackBrute', 0, 28),
];

interface Landed {
  tick: number;
  attackerId: string;
  amount: number;
}

function setup() {
  const bus = createGameEventBus();
  const gameState = createNewGameState(SEED);
  const rngs = createRngStreams(SEED);
  const world = createCollisionWorld(flatHeightfield(0));
  const input = new InputState();
  const player = new PlayerController({ world, pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
  const combat = new PlayerCombat({
    bus, rng: rngs.combat, level: () => gameState.party.level, character: () => gameState.party.active, world,
  });
  const enemyMap = new Map<string, EnemyRuntime>();
  const enemies = new EnemySystem({
    enemies: enemyMap, terrain: flatHeightfield(0), bus, world, projectileWorld: world,
  });
  const spawners = new SpawnerSystem({
    bus, enemies, world: gameState.world, heightAt: () => 0, spawners: SPAWNERS, camps: [CAMP], groups: [],
  });
  const progression = new ProgressionSystem({ state: gameState, bus });
  const inventory = new InventorySystem({ state: gameState, bus });
  const notices: CampClearedNotice[] = [];
  const loot = new LootSystem({
    bus, rng: rngs.loot, progression, inventory, pickups: [], bodyAt: (id) => enemies.get(id)?.pos ?? null,
    camps: [CAMP], world: gameState.world, campCleared: (n) => notices.push(n),
  });
  const receiver = createPlayerReceiver({
    gameState, bus, body: () => player.state, onKnockback: (d, dist) => player.knockback(d, dist),
  });
  // The Active_Character as enemy attacks see it, recording which enemy landed each hit and when.
  const landed: Landed[] = [];
  let tickNo = 0;
  const target: HitReceiver = {
    ...receiver,
    receive: (hit: ResolvedHit) => {
      landed.push({ tick: tickNo, attackerId: hit.attackerId, amount: hit.amount });
      receiver.receive(hit);
    },
  };
  const events: { tick: number; type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ tick: tickNo, type, payload }));
  const of = <K extends GameEventName>(type: K): { tick: number; payload: GameEvents[K] }[] =>
    events.filter((e) => e.type === type).map((e) => ({ tick: e.tick, payload: e.payload as GameEvents[K] }));

  /** Per-enemy state and the player's feet on every tick (index = tick number), and the most enemies attacking at once. */
  const states = new Map<string, AiState[]>();
  const playerAt: Vec3[] = [];
  let maxAttacking = 0;
  let maxTokens = 0;
  /** Ticks on which two enemies attacked while another waited on the ring for a token. */
  let heldBack = 0;
  const gated = combat.gateInput(input);
  const step = (raw: RawInput[], cameraYaw: number): void => {
    tickNo += 1;
    input.beginTick(raw, DT);
    player.tick(gated, cameraYaw, DT);
    combat.tick({ input, body: player, cameraYaw, targets: enemies.receivers(), dt: DT });
    enemies.tick({ dt: DT, player: target });
    enemies.resolveCollisions(world, target.hurtVolume(), DT);
    loot.tick(DT, player.state.pos);
    bus.dispatch();
    playerAt[tickNo] = { ...player.state.pos };
    let attacking = 0;
    let circling = 0;
    for (const e of enemyMap.values()) {
      const list = states.get(e.id) ?? [];
      list[tickNo] = e.state;
      states.set(e.id, list);
      if (e.state === 'attack') attacking += 1;
      if (e.state === 'chase' && e.circling) circling += 1;
    }
    maxAttacking = Math.max(maxAttacking, attacking);
    if (attacking === 2 && circling > 0) heldBack += 1;
    maxTokens = Math.max(maxTokens, enemies.tokens.holders.size);
  };

  /** A scripted player: W toward `to` while farther than `stop` m, Mouse0 every 4th tick when `attack`. */
  const held = { w: false };
  const drive = (to: Readonly<Vec3>, stop: number, attack: boolean): void => {
    const raw: RawInput[] = [];
    const d = distanceXZ(player.state.pos, to);
    const want = d > stop;
    if (want !== held.w) raw.push({ kind: want ? 'down' : 'up', code: 'KeyW', time: 0 });
    held.w = want;
    if (attack && tickNo % 4 === 0) raw.push({ kind: 'down', code: 'Mouse0', time: 0 }, { kind: 'up', code: 'Mouse0', time: 0 });
    step(raw, yawFromDir(to.x - player.state.pos.x, to.z - player.state.pos.z));
  };

  return {
    bus, gameState, player, enemies, enemyMap, spawners, loot, notices, landed, events, of, states, playerAt, drive, step,
    get tick() {
      return tickNo;
    },
    get maxAttacking() {
      return maxAttacking;
    },
    get maxTokens() {
      return maxTokens;
    },
    get heldBack() {
      return heldBack;
    },
  };
}

const firstTick = (list: readonly (AiState | undefined)[], state: AiState): number => list.findIndex((s) => s === state);

describe('encounter: an Enemy_Camp from detection to clear (checkpoint 8)', () => {
  it('four enemies detect, alert, chase, attack after their Telegraph, take hits, stagger, die, drop loot and clear the camp', () => {
    const h = setup();
    h.spawners.rebuild();
    const ids = SPAWNERS.map((s) => h.spawners.entityOf(s.id) ?? '');
    expect(ids.every((id) => id !== '')).toBe(true);
    expect(h.spawners.aliveCount(CAMP.id)).toBe(4);
    expect(h.loot.chestLocked(CAMP.chestId ?? '')).toBe(true);
    const alive = (): EnemyRuntime[] => ids.map((id) => h.enemyMap.get(id)).filter((e): e is EnemyRuntime => e !== undefined && e.state !== 'dead');

    // Out of sight (22 m, beyond the 14 m cone): nobody reacts while the player stands still.
    for (let i = 0; i < 30; i++) h.step([], 0);
    expect(ids.map((id) => h.enemies.get(id)?.state)).toEqual(['idle', 'idle', 'idle', 'idle']);

    // Walk in to 13 m of the Mossback Brute (inside every member's sight cone), then stand still for 4 s while the
    // camp closes in. Camp members do not alert each other: each one notices the player on its own.
    const standAt = { x: 0, y: 0, z: 15 };
    while (distanceXZ(h.player.state.pos, standAt) > 0.5) {
      if (h.tick > 60 * 10) throw new Error(`did not reach the stand point (at z ${h.player.state.pos.z.toFixed(1)})`);
      h.drive(standAt, 0.5, false);
    }
    for (let i = 0; i < 60 * 4; i++) h.drive(h.player.state.pos, 1, false);
    expect(ids.map((id) => h.enemies.get(id)?.state).every((s) => s !== 'idle')).toBe(true);

    // Then fight the nearest living member until the camp is gone.
    const limit = h.tick + 60 * 60;
    while (alive().length > 0) {
      if (h.tick > limit) {
        const report = alive().map((e) => `${e.id} ${e.state} ${e.hp}hp`).join('; ');
        throw new Error(`fight not over after 60 s (Kairen ${h.gameState.party.hp.kairen} HP; ${report})`);
      }
      const nearest = alive().reduce((a, b) => (distanceXZ(h.player.state.pos, a.pos) <= distanceXZ(h.player.state.pos, b.pos) ? a : b));
      h.drive(nearest.pos, 2, distanceXZ(h.player.state.pos, nearest.pos) < 2.8);
    }

    // Detection → alert → chase: each member alerted once ('enemy:alerted') and chased exactly 0.5 s later.
    const alerted = h.of('enemy:alerted').map((e) => e.payload.entityId);
    expect([...alerted].sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const list = h.states.get(id) ?? [];
      const alertAt = firstTick(list, 'alert');
      const chaseAt = firstTick(list, 'chase');
      expect(alertAt, id).toBeGreaterThan(30);
      expect((chaseAt - alertAt) * DT, id).toBeCloseTo(ALERT_SECONDS, 9);
      const attackAt = firstTick(list, 'attack');
      if (attackAt >= 0) expect(attackAt, id).toBeGreaterThan(chaseAt); // some fall before their turn comes
    }
    const attackers = ids.filter((id) => firstTick(h.states.get(id) ?? [], 'attack') >= 0);
    expect(attackers.length).toBeGreaterThanOrEqual(2);
    expect(attackers).toContain(ids[3]); // the Mossback Brute, last to fall, attacks too
    // The first alert came from the 120° / 14 m sight cone as the player walked in (beyond the 6 m all-round range).
    const firstAlert = h.of('enemy:alerted')[0];
    const spawnOf = SPAWNERS[ids.indexOf(firstAlert?.payload.entityId ?? '')]?.pos;
    const seenFrom = h.playerAt[firstAlert?.tick ?? 0];
    expect(spawnOf !== undefined && seenFrom !== undefined).toBe(true);
    const sightDistance = Math.hypot((spawnOf?.x ?? 0) - (seenFrom?.x ?? 0), (spawnOf?.z ?? 0) - (seenFrom?.z ?? 0));
    expect(sightDistance).toBeLessThanOrEqual(14);
    expect(sightDistance).toBeGreaterThan(6);

    // Melee tokens: never more than two enemies attacking (or holding a token) at once, and two did at some point.
    expect(h.maxTokens).toBeLessThanOrEqual(2);
    expect(h.maxAttacking).toBe(2);
    expect(h.heldBack).toBeGreaterThan(0); // a third one waited on the 4–6 m ring meanwhile

    // Every landed enemy hit came after that enemy's Telegraph had run its full length (Req 28.9, 26.5).
    const telegraphs = h.of('enemy:telegraph');
    expect(h.landed.length).toBeGreaterThan(0);
    for (const hit of h.landed) {
      const t = [...telegraphs].reverse().find((e) => e.payload.entityId === hit.attackerId && e.tick <= hit.tick);
      expect(t, `hit by ${hit.attackerId} at tick ${hit.tick}`).toBeDefined();
      expect((hit.tick - (t?.tick ?? 0)) * DT).toBeGreaterThanOrEqual((t?.payload.seconds ?? 0) - EPS);
    }
    const hp = h.gameState.party.hp.kairen;
    expect(hp).toBe(1000 - h.landed.reduce((s, x) => s + x.amount, 0));
    expect(hp).toBeGreaterThan(0);

    // The party's hits landed on every member; the Mossback Brute's front guard broke into its 3 s Stagger.
    const struck = new Set(h.of('damage:dealt').map((e) => e.payload.targetId));
    for (const id of ids) expect(struck.has(id), id).toBe(true);
    const brute = ids[3] ?? '';
    const bruteStates = h.states.get(brute) ?? [];
    const staggerAt = firstTick(bruteStates, 'stagger');
    expect(staggerAt).toBeGreaterThan(0);
    let staggerTicks = 0;
    while (bruteStates[staggerAt + staggerTicks] === 'stagger') staggerTicks += 1;
    // 3 s, or cut short when the Stagger ends in its death.
    expect(staggerTicks * DT >= 3 - DT - EPS || bruteStates[staggerAt + staggerTicks] === 'dead').toBe(true);

    // Death: 'enemy:defeated' once each, then 'camp:cleared' once, right after the last one.
    const order = h.events.map((e) => e.type).filter((t) => t === 'enemy:defeated' || t === 'camp:cleared');
    expect(order).toEqual(['enemy:defeated', 'enemy:defeated', 'enemy:defeated', 'enemy:defeated', 'camp:cleared']);
    expect(h.of('enemy:defeated').map((e) => e.payload.entityId).sort()).toEqual([...ids].sort());
    expect(h.of('camp:cleared').map((e) => e.payload)).toEqual([{ campId: CAMP.id, regionId: 'verdant' }]);
    expect(h.notices).toEqual([{ campId: CAMP.id, regionId: 'verdant', chestId: CAMP.chestId }]);
    expect(h.loot.chestLocked(CAMP.chestId ?? '')).toBe(false);
    expect(h.gameState.world.camps).toEqual([CAMP.id]);
    expect(h.spawners.aliveCount(CAMP.id)).toBe(0);

    // XP and Glim of all four at once (Loot_System on 'enemy:defeated').
    const defs = SPAWNERS.map((s) => getEnemyDef(s.kind));
    expect(h.gameState.party.xp).toBe(defs.reduce((s, d) => s + d.xp, 0));
    expect(h.gameState.inventory.glim).toBe(defs.reduce((s, d) => s + d.glim, 0));

    // Bodies are removed within 1.5 s of their defeat.
    for (let i = 0; i < Math.ceil(ENEMY_DESPAWN_SECONDS / DT) + 1; i++) h.step([], 0);
    for (const { tick, payload } of h.of('enemy:defeated')) {
      const list = h.states.get(payload.entityId) ?? [];
      const removedAt = list.length; // the first tick it was no longer listed
      expect((removedAt - tick) * DT, payload.entityId).toBeLessThanOrEqual(ENEMY_DESPAWN_SECONDS + EPS);
      expect((removedAt - tick) * DT, payload.entityId).toBeGreaterThanOrEqual(ENEMY_DESPAWN_SECONDS - DT - EPS);
    }
    expect(h.enemyMap.size).toBe(0);
    expect([...h.enemies.receivers()]).toEqual([]);

    // Drops: walk over each one left lying; within 3 m it flies in and is granted ('item:granted', source 'enemy').
    const laid = h.loot.pickups.length + h.of('item:granted').filter((e) => e.payload.source === 'enemy').length;
    const pickupLimit = h.tick + 60 * 20;
    while (h.loot.pickups.length > 0) {
      if (h.tick > pickupLimit) throw new Error(`${h.loot.pickups.length} drops left`);
      const p = h.loot.pickups[0];
      if (p === undefined) break;
      h.drive(p.pos, 0.5, false);
    }
    const granted = h.of('item:granted').filter((e) => e.payload.source === 'enemy');
    expect(granted.length).toBe(laid);
    expect(granted.length).toBeGreaterThan(0);
    const starmotes = granted.reduce((s, e) => s + e.payload.count, 0);
    expect(h.gameState.inventory.items.mat_starmote ?? 0).toBe(starmotes);

    // The cleared camp stays empty when the world is rebuilt (fast travel, load, Party_Wipe restart).
    h.spawners.rebuild();
    expect(h.enemyMap.size).toBe(0);
  });
});
