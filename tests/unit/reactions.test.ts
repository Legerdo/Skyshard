import { describe, expect, it } from 'vitest';
import { judgeShape, type Attacker, type HitReceiver, type ResolvedHit } from '../../src/combat/attackRuntime';
import { PlayerCombat, type CombatBody } from '../../src/combat/playerCombat';
import { createPlayerReceiver } from '../../src/combat/playerReceiver';
import { createGameEventBus, type GameEventName, type GameEvents } from '../../src/core/gameEvents';
import { createRng } from '../../src/core/rng';
import type { Vec3 } from '../../src/core/types';
import type { HitEvent } from '../../src/data/combatTypes';
import { ELEMENT_IDS, REACTION_IDS, type ElementId, type ReactionId } from '../../src/data/ids';
import { RECEIVER_DEFS, RECEIVER_KINDS } from '../../src/data/receivers';
import { CHAIN_DISPLAY, REACTION_PRESENTATION } from '../../src/data/reactions';
import { ReactionSystem, type ReactionActor, type ReactionHost } from '../../src/element/reactionSystem';
import { ReceiverField, type DeviceSignal } from '../../src/element/receiverField';
import { DeviceReceiver } from '../../src/element/receivers';
import { EnemySystem } from '../../src/enemies/enemySystem';
import { InputState, type RawInput } from '../../src/input/inputState';
import { emptyTarget, type ElementTarget } from '../../src/logic/element';
import { chainLabel, previewTarget, reactionPreviews, type ReactorStats } from '../../src/logic/reactionEffects';
import { createNewGameState } from '../../src/logic/save/gameState';
import { createControllerState, type ControllerState } from '../../src/player/core/types';
import type { EffectZone, EnemyRuntime } from '../../src/save/runtimeState';

// Reaction effects, environment receivers, the reaction preview and the codex (design "Reaction 효과",
// "확산과 연쇄", "환경 수신자", "반응 예고와 도감"; Req 25.6, 25.7, 25.9, 25.13, 13.1, 13.8, 13.9, 23.9).
const DT = 1 / 60;
/** Reactor ATK 100 at level 1 against DEF 20: an ATK multiplier m deals round(100 × m × 100 / 120). */
const REACTOR: ReactorStats = { baseAtk: 100, level: 1, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0 };
const DEF = 20;
/** Final damage of the hit that applies the second Element. */
const TRIGGER = 40;

interface FieldTarget extends ReactionActor {
  element: ElementTarget;
  damage: number[];
  staggered: number | null;
  rootedUntil: number | null;
  slowed: { mul: number; until: number } | null;
}

/** Targets standing at fixed positions: the smallest ReactionHost, recording every effect it receives. */
class Field implements ReactionHost {
  readonly targets = new Map<string, FieldTarget>();
  add(id: string, x: number, mark: ElementId | null = null): void {
    const element = emptyTarget();
    if (mark !== null) element.mark = { element: mark, expiresAt: 8 };
    this.targets.set(id, {
      id, pos: { x, y: 0, z: 0 }, alive: true, def: DEF, element, damage: [], staggered: null, rootedUntil: null, slowed: null,
    });
  }
  t(id: string): FieldTarget {
    const t = this.targets.get(id);
    if (t === undefined) throw new Error(id);
    return t;
  }
  actors(): readonly ReactionActor[] {
    return [...this.targets.values()];
  }
  setElement(id: string, next: ElementTarget): void {
    this.t(id).element = next;
  }
  damage(id: string, amount: number): void {
    this.t(id).damage.push(amount);
  }
  stagger(id: string, seconds: number): void {
    this.t(id).staggered = seconds;
  }
  root(id: string, until: number): void {
    this.t(id).rootedUntil = until;
  }
  slow(id: string, mul: number, until: number): void {
    this.t(id).slowed = { mul, until };
  }
}

/** A ReactionSystem over a Field at sim time `clock.now`, with every event and Hit_Stop request recorded. */
function reactions(place: (f: Field) => void) {
  const bus = createGameEventBus();
  const field = new Field();
  place(field);
  const clock = { now: 0 };
  const codex: ReactionId[] = [];
  const zones: EffectZone[] = [];
  const timeScale: [string, number, number][] = [];
  const system = new ReactionSystem({
    bus, host: field, now: () => clock.now, codex, zones, setTimeScale: (s, scale, secs) => timeScale.push([s, scale, secs]),
  });
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const of = <K extends GameEventName>(type: K) => {
    bus.dispatch();
    return events.filter((e) => e.type === type).map((e) => e.payload as GameEvents[K]);
  };
  return { bus, field, clock, codex, zones, timeScale, system, of };
}

describe('Reaction effects (table B, fixed inputs)', () => {
  it('증기 폭발 (ember mark + tide): target +150% of the 40 trigger = 60, others within 3 m 60% = 24, 1 s Stagger, Hit_Stop 70 ms', () => {
    const r = reactions((f) => {
      f.add('t', 0, 'ember');
      f.add('near', 2.9);
      f.add('far', 3.5);
    });
    r.system.apply('t', 'tide', 'isla', { damage: TRIGGER, reactor: REACTOR });
    const { field } = r;
    expect([field.t('t').damage, field.t('near').damage, field.t('far').damage]).toEqual([[60], [24], []]);
    expect([field.t('t').staggered, field.t('near').staggered, field.t('far').staggered]).toEqual([1, 1, null]);
    expect(r.timeScale).toEqual([['hitStop', 0, 0.07]]);
    expect(r.of('reaction')).toEqual([{ reaction: 'steamBurst', targetId: 't', position: { x: 0, y: 0, z: 0 }, chainDepth: 1 }]);
    expect(r.of('reaction:chain')).toEqual([]);
  });

  it('용암 균열 (terra mark + ember): a 3 m zone for 4 s, 25% ATK = 21 every 0.5 s → 8 ticks = 168 inside, then gone', () => {
    const r = reactions((f) => {
      f.add('t', 0, 'terra');
      f.add('near', 3);
      f.add('far', 3.2);
    });
    r.system.apply('t', 'ember', 'kairen', { damage: TRIGGER, reactor: REACTOR });
    expect(r.zones).toEqual([{ id: 'lavaRift_1', source: 'lavaRift', owner: 't', pos: { x: 0, y: 0, z: 0 }, radius: 3, until: 4 }]);
    expect(r.field.t('t').damage).toEqual([]); // no damage at the reaction itself
    for (let i = 1; i <= 300; i++) {
      r.clock.now = i * DT; // 5 s of ticks
      r.system.tick();
    }
    expect(r.field.t('t').damage).toEqual(Array(8).fill(21));
    expect(r.field.t('near').damage).toEqual(Array(8).fill(21));
    expect(r.field.t('far').damage).toEqual([]);
    expect([r.zones, r.system.lavaZones]).toEqual([[], []]);
  });

  it('진흙 속박 (tide mark + terra): everything within 4 m cannot move for 2.5 s', () => {
    const r = reactions((f) => {
      f.add('t', 0, 'tide');
      f.add('near', 3.9);
      f.add('far', 4.5);
    });
    r.clock.now = 2;
    r.system.apply('t', 'terra', 'talus', { damage: TRIGGER, reactor: REACTOR });
    expect([r.field.t('t').rootedUntil, r.field.t('near').rootedUntil, r.field.t('far').rootedUntil]).toEqual([4.5, 4.5, null]);
    expect(r.field.t('t').damage).toEqual([]);
  });

  it.each([
    ['불꽃 확산', 'ember', 'flameSpread'],
    ['모래 돌풍', 'terra', 'sandGust'],
  ] as const)('%s (%s mark + gale): the mark spreads within 5 m and 80%% ATK = 67 lands on everything within 5 m', (_n, held, reaction) => {
    const r = reactions((f) => {
      f.add('t', 0, held);
      f.add('near', 4.9);
      f.add('far', 5.5);
    });
    const report = r.system.apply('t', 'gale', 'wren', { damage: TRIGGER, reactor: REACTOR });
    expect(report.reactions.map((e) => e.reaction)).toEqual([reaction]);
    expect([r.field.t('t').damage, r.field.t('near').damage, r.field.t('far').damage]).toEqual([[67], [67], []]);
    expect([r.field.t('t').element.mark, r.field.t('near').element.mark?.element, r.field.t('far').element.mark]).toEqual([null, held, null]);
    expect(r.of('element:applied')).toEqual([
      { targetId: 't', element: 'gale', source: 'wren' },
      { targetId: 'near', element: held, source: 'reaction' },
    ]);
  });

  it('물안개 확산 (tide mark + gale): the Tide mark spreads within 5 m and everything there is slowed 40% for 3 s, no damage', () => {
    const r = reactions((f) => {
      f.add('t', 0, 'tide');
      f.add('near', 4);
      f.add('far', 6);
    });
    r.clock.now = 1;
    r.system.apply('t', 'gale', 'wren', { damage: TRIGGER, reactor: REACTOR });
    expect([r.field.t('t').slowed, r.field.t('near').slowed, r.field.t('far').slowed]).toEqual([
      { mul: 0.6, until: 4 }, { mul: 0.6, until: 4 }, null,
    ]);
    expect([r.field.t('t').damage, r.field.t('near').damage]).toEqual([[], []]);
    expect(r.field.t('near').element.mark).toEqual({ element: 'tide', expiresAt: 9 });
  });

  it('a chain (flameSpread → steamBurst on a Tide-marked neighbour) emits one reaction per link, then "연쇄 x2" for 1.5 s, and +5 Energy each', () => {
    const r = reactions((f) => {
      f.add('src', 0, 'ember');
      f.add('wet', 2, 'tide');
    });
    const energy = { kairen: 0, isla: 0, wren: 0, talus: 0 };
    const combat = new PlayerCombat({ bus: r.bus, rng: createRng(1), level: () => 1, character: () => 'wren', energy });
    const report = r.system.apply('src', 'gale', 'wren', { damage: TRIGGER, reactor: REACTOR });
    expect(report.chainCount).toBe(2);
    expect(r.of('reaction').map((e) => [e.reaction, e.targetId, e.chainDepth])).toEqual([
      ['flameSpread', 'src', 1],
      ['steamBurst', 'wet', 2],
    ]);
    expect(r.of('reaction:chain')).toEqual([{ count: 2, targetId: 'src', position: { x: 0, y: 0, z: 0 } }]);
    expect([chainLabel(2), chainLabel(1), CHAIN_DISPLAY.seconds]).toEqual(['연쇄 x2', null, 1.5]);
    expect(energy.wren).toBe(10);
    // steamBurst at `wet`: its own +150% of the chain's trigger, 60% for `src` 2 m away, on top of the spread's 67 each.
    expect([r.field.t('src').damage, r.field.t('wet').damage]).toEqual([[67, 24], [67, 60]]);
    combat.dispose();
  });

  it('each reaction has its own VFX, sound and icon', () => {
    const p = REACTION_IDS.map((id) => REACTION_PRESENTATION[id]);
    for (const key of ['vfx', 'sfx', 'icon', 'color'] as const) expect(new Set(p.map((x) => x[key])).size).toBe(REACTION_IDS.length);
    expect(p.every((x) => x.sfx.startsWith('sfx_reaction_'))).toBe(true);
  });
});

describe('Codex (Req 25.13)', () => {
  it('records each reaction once, on its first occurrence, in order', () => {
    const r = reactions((f) => {
      f.add('a', 0, 'ember');
      f.add('b', 20, 'ember');
      f.add('c', 40, 'terra');
    });
    r.system.apply('a', 'tide', 'isla', null);
    r.system.apply('b', 'tide', 'isla', null);
    r.system.apply('c', 'ember', 'kairen', null);
    r.system.apply('a', 'ember', 'kairen', null); // a fresh mark, no reaction
    r.clock.now = 2;
    r.system.apply('a', 'tide', 'isla', null);
    expect(r.of('reaction').map((e) => e.reaction)).toEqual(['steamBurst', 'steamBurst', 'lavaRift', 'steamBurst']);
    expect(r.codex).toEqual(['steamBurst', 'lavaRift']);
  });
});

// ── Through the EnemySystem ────────────────────────────────────────────────

const BODY: { state: ControllerState } = { state: createControllerState({ x: 0, y: 0, z: 0 }, 0) };

function enemyWorld() {
  const bus = createGameEventBus();
  const enemyMap = new Map<string, EnemyRuntime>();
  const gameState = createNewGameState(1);
  const enemies = new EnemySystem({ enemies: enemyMap, terrain: { heightAt: () => 0 }, bus, codex: gameState.codex });
  const player = createPlayerReceiver({ gameState, bus, body: () => BODY.state });
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const receiverOf = (id: string): HitReceiver => {
    const r = [...enemies.receivers()].find((x) => x.id === id);
    if (r === undefined) throw new Error(id);
    return r;
  };
  const hit = (id: string, element: ElementId, amount = TRIGGER): void =>
    receiverOf(id).receive({
      attackerId: 'player', attackId: 'atk_kairen_n4', hitIndex: 0, kind: 'normal', amount, crit: false, element,
      elementSource: 'kairen', stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
      attackerStats: { ...REACTOR, critChance: 0 },
    } satisfies ResolvedHit);
  /** Spawns a Bramblekin 5.5 m ahead facing the player and ticks until it chases. */
  const chaser = (x = 0): string => {
    const id = enemies.spawn({ kind: 'bramblekin', pos: { x, y: 0, z: 5.5 }, yaw: Math.PI });
    for (let i = 0; i < 40 && enemies.get(id)?.state !== 'chase'; i++) enemies.tick({ dt: DT, player });
    return id;
  };
  return { bus, enemies, gameState, player, events, hit, chaser };
}

describe('Reactions on enemies', () => {
  it('a steamBurst hit: HP 180 − 40 − 60, one reaction event (chain depth 1), then a 1 s Stagger before it chases again', () => {
    const w = enemyWorld();
    const id = w.chaser();
    w.enemies.applyElement(id, 'ember', 'kairen');
    w.hit(id, 'tide');
    expect(w.enemies.get(id)?.hp).toBe(80);
    let staggered = 0;
    w.enemies.tick({ dt: DT, player: w.player });
    while (w.enemies.get(id)?.state === 'stagger' && staggered < 300) {
      staggered++;
      w.enemies.tick({ dt: DT, player: w.player });
    }
    expect(staggered * DT).toBeGreaterThan(1 - 3 * DT);
    expect(staggered * DT).toBeLessThan(1 + DT);
    expect(w.enemies.get(id)?.state).toBe('chase');
    w.bus.dispatch();
    expect(w.events.filter((e) => e.type === 'reaction').map((e) => e.payload)).toEqual([
      { reaction: 'steamBurst', targetId: id, position: expect.anything(), chainDepth: 1 },
    ]);
    expect(w.gameState.codex).toEqual(['steamBurst']);
  });

  it('a mudBind hit holds a chasing enemy in place for 2.5 s', () => {
    const w = enemyWorld();
    const id = w.chaser();
    w.enemies.applyElement(id, 'tide', 'isla');
    w.hit(id, 'terra');
    const z0 = w.enemies.get(id)?.pos.z;
    for (let i = 0; i < Math.floor(2.5 / DT) - 1; i++) w.enemies.tick({ dt: DT, player: w.player });
    expect(w.enemies.get(id)?.pos.z).toBe(z0);
    for (let i = 0; i < 10; i++) w.enemies.tick({ dt: DT, player: w.player });
    expect(w.enemies.get(id)?.pos.z).toBeLessThan(z0 ?? 0);
  });

  it('a Gale hit spreads the mark to another enemy within 5 m, which reacts there (chain) and gets "연쇄 x2"', () => {
    const w = enemyWorld();
    const a = w.enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 30 } });
    const b = w.enemies.spawn({ kind: 'bramblekin', pos: { x: 3, y: 0, z: 30 } });
    w.enemies.applyElement(a, 'ember', 'kairen');
    w.enemies.applyElement(b, 'tide', 'isla');
    w.hit(a, 'gale');
    w.bus.dispatch();
    expect(w.events.filter((e) => e.type === 'reaction').map((e) => (e.payload as GameEvents['reaction']).reaction)).toEqual([
      'flameSpread', 'steamBurst',
    ]);
    expect(w.events.filter((e) => e.type === 'reaction:chain').map((e) => (e.payload as GameEvents['reaction:chain']).count)).toEqual([2]);
    expect(w.gameState.codex).toEqual(['flameSpread', 'steamBurst']);
  });
});

// ── Reaction preview (Req 23.9) ─────────────────────────────────────────────

describe('reaction preview', () => {
  const at = (id: string, x: number, element: ElementTarget, alive = true) => ({ id, pos: { x, y: 0, z: 0 }, alive, element });
  const marked = (e: ElementId): ElementTarget => ({ ...emptyTarget(), mark: { element: e, expiresAt: 8 } });
  const slots = [
    { characterId: 'kairen', element: 'ember', standby: false },
    { characterId: 'isla', element: 'tide', standby: true },
    { characterId: 'wren', element: 'gale', standby: true },
    { characterId: 'talus', element: 'terra', standby: false },
  ] as const;

  it('uses the Lock-on target, else the nearest marked enemy, and shows each standby slot its reaction', () => {
    const list = [at('plain', 1, emptyTarget()), at('wet', 6, marked('tide')), at('hot', 4, marked('ember')), at('dead', 0.5, marked('terra'), false)];
    const origin = { x: 0, y: 0, z: 0 };
    expect(previewTarget(list, null, origin, 0)?.id).toBe('hot');
    expect(previewTarget(list, 'wet', origin, 0)?.id).toBe('wet');
    expect(previewTarget(list, 'plain', origin, 0)?.id).toBe('plain');
    expect(previewTarget(list, null, origin, 8)).toBeNull(); // every mark expired
    const hot = previewTarget(list, null, origin, 0);
    expect(reactionPreviews(hot?.element ?? null, slots, 0).map((s) => s.reaction)).toEqual([null, 'steamBurst', 'flameSpread', null]);
    expect(reactionPreviews(marked('tide'), slots, 0).map((s) => s.reaction)).toEqual([null, null, 'mistSpread', null]);
    expect(reactionPreviews(null, slots, 0).map((s) => s.reaction)).toEqual([null, null, null, null]);
  });
});

// ── Environment receivers (Req 13.1, 13.8, 13.9) ────────────────────────────

describe('ElementReceiver devices', () => {
  it('each kind accepts only its Element; others are refused without changing it', () => {
    const accepted: Record<string, ElementId[]> = {};
    for (const kind of RECEIVER_KINDS) {
      accepted[kind] = [];
      for (const el of ELEMENT_IDS) {
        const d = new DeviceReceiver(`d_${kind}`, kind);
        const res = d.onElement(el, 0);
        if (res.accepted) accepted[kind]?.push(el);
        else expect([res.state, res.changed]).toEqual([RECEIVER_DEFS[kind].initial, false]);
      }
    }
    expect(accepted).toEqual({
      brambleGate: ['ember'], brazier: ['ember'], heatCrystal: ['tide'], fireObstacle: ['tide'], windWheel: ['gale'],
      crackedBoulder: ['terra'], pressurePlate: [], unstableCrystal: ['ember'],
      // The Observatory's star pedestals take any Element; their sequence puzzle judges which one was right.
      elementPedestal: ['ember', 'tide', 'gale', 'terra'],
    });
    const done = RECEIVER_KINDS.filter((k) => k !== 'pressurePlate' && k !== 'unstableCrystal').map((kind) => {
      const d = new DeviceReceiver('d', kind);
      return [kind, d.onElement(RECEIVER_DEFS[kind].accepts[0] as ElementId, 0)];
    });
    expect(Object.fromEntries(done)).toEqual({
      brambleGate: { accepted: true, state: 'burnt', changed: true },
      brazier: { accepted: true, state: 'lit', changed: true },
      heatCrystal: { accepted: true, state: 'cooled', changed: true },
      fireObstacle: { accepted: true, state: 'extinguished', changed: true },
      windWheel: { accepted: true, state: 'spinning', changed: true },
      crackedBoulder: { accepted: true, state: 'broken', changed: true },
      elementPedestal: { accepted: true, state: 'lit', changed: true },
    });
  });

  it('a Tide-cooled Heat_Crystal is harmless and climbable for 10 s; Tide again restarts the 10 s', () => {
    const c = new DeviceReceiver('hc', 'heatCrystal');
    expect([c.contactDamage(0), c.climbable(0)]).toEqual([true, false]);
    c.onElement('tide', 1);
    expect([c.stateAt(10.99), c.contactDamage(10.99), c.climbable(10.99)]).toEqual(['cooled', false, true]);
    expect([c.stateAt(11), c.contactDamage(11), c.climbable(11)]).toEqual(['hot', true, false]);
    c.onElement('tide', 8);
    expect([c.stateAt(17.99), c.stateAt(18)]).toEqual(['cooled', 'hot']);
  });

  it('hits reach devices through the same judgement: Ember lights a brazier, a Charged_Attack breaks a cracked boulder', () => {
    const signals: DeviceSignal[] = [];
    const field = new ReceiverField({ onSignal: (s) => signals.push(s) });
    field.add(new DeviceReceiver('brazier', 'brazier'), { pos: { x: 0, y: 0, z: 1.5 }, radius: 0.5, height: 1 });
    field.add(new DeviceReceiver('boulder', 'crackedBoulder'), { pos: { x: 0, y: 0, z: 1.5 }, radius: 0.8, height: 1.6 });
    const arc: HitEvent = { t: 0, shape: { kind: 'arc', radius: 2.5, angleDeg: 120, height: 2 }, dmgMul: 1, appliesElement: true, poise: 10, knockback: 0, energy: null };
    const attacker = (kind: Attacker['kind'], element: ElementId | null): Attacker => ({
      id: 'player', origin: { pos: { x: 0, y: 0, z: 0 }, yaw: 0 },
      stats: { baseAtk: 100, level: 1, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0, critChance: 0 },
      kind, element, elementSource: 'kairen', roll: () => 0.5,
    });
    judgeShape('atk_kairen_n4', 0, arc, attacker('normal', 'ember'), field.hitTargets(), new Set());
    judgeShape('atk_talus_charged', 0, arc, attacker('charged', null), field.hitTargets(), new Set());
    expect(signals).toEqual([
      { part: 'brazier', kind: 'brazier', element: 'ember', accepted: true, state: 'lit', changed: true },
      { part: 'boulder', kind: 'crackedBoulder', element: 'ember', accepted: false, state: 'intact', changed: false },
      { part: 'boulder', kind: 'crackedBoulder', element: null, accepted: true, state: 'broken', changed: true },
    ]);
    // A broken boulder takes no more hits.
    expect([...field.hitTargets()].map((t) => [t.id, t.immune(), t.device])).toEqual([['brazier', false, true], ['boulder', true, true]]);
  });

  it('a pressure plate stays down while a weight stands on it', () => {
    const changes: string[] = [];
    const field = new ReceiverField({ onPlate: (part, change) => changes.push(`${part} ${change}`) });
    field.add(new DeviceReceiver('plate', 'pressurePlate'), { pos: { x: 10, y: 2, z: 0 }, radius: 1, height: 0.1 });
    const w = (x: number): { id: string; pos: Vec3 }[] => [{ id: 'pillar', pos: { x, y: 2, z: 0 } }];
    field.tick(DT, [], w(5));
    field.tick(DT, [], w(10.5));
    field.tick(DT, [], w(10.2));
    field.tick(DT, [], []);
    expect(changes).toEqual(['plate pressed', 'plate released']);
    expect(field.get('plate')?.onElement('terra', 0)).toEqual({ accepted: false, state: 'up', changed: false });
  });

  it('an Unstable_Crystal explodes 1 s after Ember, hitting enemies and the Player_Character within 4 m only', () => {
    const bus = createGameEventBus();
    const gameState = createNewGameState(1);
    const body = { state: createControllerState({ x: 3, y: 0, z: 0 }, 0) };
    const player = createPlayerReceiver({ gameState, bus, body: () => body.state });
    const enemies = new EnemySystem({ enemies: new Map(), terrain: { heightAt: () => 0 }, bus });
    const near = enemies.spawn({ kind: 'bramblekin', pos: { x: -3.5, y: 0, z: 0 } });
    const far = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 6 } });
    const blasts: number[] = [];
    const field = new ReceiverField({ onBlast: (_part, _pos, hits) => blasts.push(hits.length) });
    const crystal = new DeviceReceiver('crystal', 'unstableCrystal');
    field.add(crystal, { pos: { x: 0, y: 0, z: 0 }, radius: 0.6, height: 1.4 });
    const victims = (): HitReceiver[] => [...enemies.receivers(), player];
    field.tick(DT, victims());
    expect(crystal.onElement('ember', field.time)).toEqual({ accepted: true, state: 'primed', changed: true });
    expect(crystal.telegraphLeft(field.time)).toBeCloseTo(1, 9);
    const start = field.time;
    while (field.time - start < 1 - DT / 2) {
      field.tick(DT, victims());
      if (field.time - start < 1 - 1e-6) expect(blasts).toEqual([]);
    }
    field.tick(DT, victims());
    expect(blasts).toEqual([2]);
    expect(crystal.stateAt(field.time)).toBe('exploded');
    expect(enemies.get(near)?.hp).toBeLessThan(180);
    expect(enemies.get(far)?.hp).toBe(180);
    expect(gameState.party.hp.kairen).toBeLessThan(1000);
    field.tick(DT, victims());
    expect(blasts).toEqual([2]); // once
  });

  it('hitting only a device grants no Energy and shows no damage number', () => {
    const bus = createGameEventBus();
    const energy = { kairen: 0, isla: 0, wren: 0, talus: 0 };
    const combat = new PlayerCombat({ bus, rng: createRng(7), level: () => 1, character: () => 'kairen', energy });
    const field = new ReceiverField();
    field.add(new DeviceReceiver('brazier', 'brazier'), { pos: { x: 0, y: 0, z: 1.5 }, radius: 0.5, height: 1 });
    const input = new InputState();
    const body: CombatBody = { state: createControllerState({ x: 0, y: 0, z: 0 }, 0), face() {} };
    const dealt: unknown[] = [];
    bus.on('damage:dealt', (p) => dealt.push(p));
    const tap: RawInput[] = [{ kind: 'down', code: 'Mouse0', time: 0 }, { kind: 'up', code: 'Mouse0', time: 0 }];
    let landed = 0;
    for (let i = 0; i < 60; i++) {
      input.beginTick(i === 0 ? tap : [], DT);
      landed += combat.tick({ input, body, cameraYaw: 0, targets: field.hitTargets(), dt: DT }).length;
    }
    bus.dispatch();
    expect(landed).toBe(1); // the hit landed on the brazier
    expect([energy.kairen, dealt]).toEqual([0, []]);
    combat.dispose();
  });
});
