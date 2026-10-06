import { describe, expect, it } from 'vitest';
import type { ResolvedHit } from '../../../src/combat/attackRuntime';
import { createGameEventBus, type GameEventName, type GameEvents } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import { XP_SOURCES } from '../../../src/data/progression';
import {
  CACHE_GLIM, DENSITY_POIS, DISCOVERABLE_POIS, ECHO_TABLETS, HIDDEN_PLACES, HIDDEN_PLACE_SFX, LORE_STONES, POI_STRUCTURES, SKY_RING_TRIAL,
} from '../../../src/data/pois';
import { InventorySystem } from '../../../src/inventory/inventorySystem';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { staminaMax } from '../../../src/logic/stamina';
import { ColliderIdSource } from '../../../src/physics/colliderIds';
import { ProgressionSystem } from '../../../src/progression/progressionSystem';
import { PoiSystem, trialDoneFlag, type PoiNotice } from '../../../src/world/poiSystem';

// Echo_Tablets, hidden places, map POIs, lore / cache / herb and the Sky Ring Trial (tasks 12.7, 20.1; Req 9.6,
// 10.1, 10.8–10.10).

const SEED = 20240601;
const DT = 1 / 60;

function setup(state: GameState = createNewGameState(SEED)) {
  const bus = createGameEventBus();
  const inventory = new InventorySystem({ state, bus });
  const progression = new ProgressionSystem({ state, bus });
  const notices: PoiNotice[] = [];
  let stamina = staminaMax(0);
  let statics = 0;
  const pois = new PoiSystem({
    bus, state, world: { addStatic: () => void statics++ }, ids: new ColliderIdSource(), heightAt: () => Number.NaN, progression, inventory,
    setStaminaMax: (max) => {
      stamina = max;
    },
    notice: (n) => notices.push(n),
  });
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const of = <K extends GameEventName>(type: K): GameEvents[K][] =>
    events.filter((e) => e.type === type).map((e) => e.payload as GameEvents[K]);
  const interact = (targetKind: GameEvents['interact']['targetKind'], targetId: string): void => {
    bus.emit('interact', { targetKind, targetId });
    bus.dispatch();
  };
  return { bus, state, pois, notices, of, interact, stamina: () => stamina, statics: () => statics };
}

describe('Echo_Tablets (Req 10.8, 10.9)', () => {
  it('records a tablet once, updates its Region n/3 and raises max Stamina by 15 when the three are read', () => {
    const h = setup();
    const verdant = ECHO_TABLETS.filter((t) => t.region === 'verdant');
    expect(verdant).toHaveLength(3);
    const xp0 = h.state.party.xp;
    verdant.forEach((t, i) => {
      h.interact('tablet', t.id);
      const last = h.notices.at(-1);
      expect(last).toMatchObject({ kind: 'tablet', id: t.id, region: 'verdant', found: i + 1, total: 3, first: true, text: t.text });
      expect(last?.kind === 'tablet' ? last.staminaMax : undefined).toBe(i === 2 ? staminaMax(1) : null);
    });
    expect(h.stamina()).toBe(115);
    expect(h.state.world.echoTablets).toEqual(verdant.map((t) => t.id));
    expect(h.state.party.xp - xp0).toBe(3 * XP_SOURCES.discovery.tablet);
    // Reading again shows the record, changes nothing.
    h.interact('tablet', verdant[0]?.id ?? '');
    expect(h.notices.at(-1)).toMatchObject({ kind: 'tablet', first: false, found: 3, staminaMax: null });
    expect(h.state.world.echoTablets).toHaveLength(3);
    // A second Region's set adds another 15.
    for (const t of ECHO_TABLETS.filter((x) => x.region === 'ember')) h.interact('tablet', t.id);
    expect(h.stamina()).toBe(130);
  });

  it('builds a collider per tablet and POI structure', () => {
    const h = setup();
    expect(h.statics()).toBe(ECHO_TABLETS.length + POI_STRUCTURES.length);
  });
});

describe('Discovery (Req 9.6, 33.2)', () => {
  it('a hidden place announces itself once with its own sound, pays its XP and goes on the map', () => {
    const h = setup();
    const place = HIDDEN_PLACES[0];
    if (place === undefined) throw new Error('no hidden place');
    const xp0 = h.state.party.xp;
    h.pois.tick(DT, place.pos, true, false);
    h.pois.tick(DT, place.pos, true, false);
    expect(h.notices.filter((n) => n.kind === 'hidden')).toEqual([{ kind: 'hidden', id: place.id, name: place.name, sfx: HIDDEN_PLACE_SFX }]);
    expect(h.state.discovery.hiddenPlaces).toEqual([place.id]);
    expect(h.state.party.xp - xp0).toBe(XP_SOURCES.discovery.hidden);
    // Far above it (a glide over the cave) does not count.
    const other = HIDDEN_PLACES[1];
    if (other === undefined) throw new Error('no second hidden place');
    h.pois.tick(DT, { ...other.pos, y: other.pos.y + 40 }, false, false);
    expect(h.state.discovery.hiddenPlaces).toEqual([place.id]);
  });

  it('map POIs register on the first approach, not while locked', () => {
    const h = setup();
    const camp = DISCOVERABLE_POIS.find((p) => p.kind === 'camp');
    if (camp === undefined) throw new Error('no camp');
    h.pois.tick(DT, camp.pos, true, true);
    expect(h.state.discovery.pois).not.toContain(camp.id);
    h.pois.tick(DT, camp.pos, true, false);
    expect(h.state.discovery.pois).toContain(camp.id);
  });
});

describe('Lore, caches and herbs (Req 10.1)', () => {
  it('a lore stone shows its text; the first read pays 5 XP and maps it', () => {
    const h = setup();
    const lore = LORE_STONES[0];
    if (lore === undefined) throw new Error('no lore');
    const xp0 = h.state.party.xp;
    h.interact('lore', lore.id);
    h.interact('lore', lore.id);
    expect(h.notices).toEqual([
      { kind: 'lore', id: lore.id, name: lore.name, text: lore.text, first: true },
      { kind: 'lore', id: lore.id, name: lore.name, text: lore.text, first: false },
    ]);
    expect(h.state.party.xp - xp0).toBe(5);
    expect(h.state.discovery.pois).toContain(lore.id);
  });

  it('a cache breaks on any party hit for Glim 5–15 (the same amount every time), herbs give a dumpling; both regrow', () => {
    const h = setup();
    const receiver = h.pois.hitTargets()[0];
    if (receiver === undefined) throw new Error('no cache');
    const glim0 = h.state.inventory.glim;
    receiver.receive({} as ResolvedHit);
    receiver.receive({} as ResolvedHit);
    const gained = h.state.inventory.glim - glim0;
    expect(gained).toBeGreaterThanOrEqual(CACHE_GLIM[0]);
    expect(gained).toBeLessThanOrEqual(CACHE_GLIM[1]);
    expect(receiver.immune()).toBe(true);

    const herb = DENSITY_POIS.find((d) => d.kind === 'herb');
    if (herb === undefined) throw new Error('no herb');
    const herbs0 = h.state.inventory.items.con_herbDumpling ?? 0;
    h.interact('herb', herb.id);
    h.interact('herb', herb.id);
    h.bus.dispatch();
    expect((h.state.inventory.items.con_herbDumpling ?? 0) - herbs0).toBe(1);

    h.pois.regrow();
    expect(receiver.immune()).toBe(false);
    receiver.receive({} as ResolvedHit);
    expect(h.state.inventory.glim - glim0).toBe(2 * gained);
    h.interact('herb', herb.id);
    expect((h.state.inventory.items.con_herbDumpling ?? 0) - herbs0).toBe(2);
  });
});

describe('Sky Ring Trial (Req 10.10)', () => {
  /** Feet placed so the body centre (feet + 0.9) is at the ring centre. */
  const feetAt = (r: Vec3): Vec3 => ({ x: r.x, y: r.y - 0.9, z: r.z });

  it('8 rings in order within 60 s complete it: recorded, saved, its Chest may appear', () => {
    const h = setup();
    h.interact('trial', SKY_RING_TRIAL.id);
    expect(h.notices.at(-1)).toEqual({ kind: 'trialStarted', rings: 8, seconds: 60 });
    // Out of order: the 3rd ring first counts nothing.
    const third = SKY_RING_TRIAL.rings[2];
    if (third === undefined) throw new Error('no ring');
    h.pois.tick(DT, feetAt(third), false, false);
    expect(h.pois.trial?.next).toBe(0);
    for (const ring of SKY_RING_TRIAL.rings) h.pois.tick(1, feetAt(ring), false, false);
    expect(h.notices.filter((n) => n.kind === 'trialRing')).toHaveLength(8);
    expect(h.notices.at(-1)).toMatchObject({ kind: 'trialCompleted', first: true });
    expect(h.pois.trialDone(SKY_RING_TRIAL.id)).toBe(true);
    expect(h.state.world.flags[trialDoneFlag(SKY_RING_TRIAL.id)]).toBe(true);
    h.bus.dispatch();
    expect(h.of('save:request')).toContainEqual({ reason: 'puzzle' });
    expect(h.pois.trial).toBeNull();
  });

  it('fails on landing after the first ring or when 60 s run out', () => {
    const h = setup();
    const [first] = SKY_RING_TRIAL.rings;
    if (first === undefined) throw new Error('no ring');
    h.interact('trial', SKY_RING_TRIAL.id);
    h.pois.tick(DT, feetAt(first), false, false);
    h.pois.tick(DT, { x: -100, y: 70, z: -300 }, true, false);
    expect(h.notices.at(-1)).toEqual({ kind: 'trialFailed', reason: 'landed' });

    h.interact('trial', SKY_RING_TRIAL.id);
    for (let t = 0; t < 61; t++) h.pois.tick(1, { x: 0, y: 200, z: 0 }, false, false);
    expect(h.notices.at(-1)).toEqual({ kind: 'trialFailed', reason: 'timeout' });
    expect(h.pois.trialDone(SKY_RING_TRIAL.id)).toBe(false);
  });
});
