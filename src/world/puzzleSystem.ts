// Puzzle_Mechanism scene adapter (design "Puzzle_Mechanism 규칙", "오픈월드 퍼즐"; Req 13.1–13.7, 2.6). It places
// every part of the puzzle definitions (src/data/puzzles.ts): Element receivers and pressure plates become
// DeviceReceivers in the ReceiverField (they take the party's hits through the same judgement as enemies), arrival
// triggers are volumes around a point. Their answers become PuzzleSignals for the pure stepPuzzle
// (src/logic/puzzle.ts), and the outcome is applied here in the same tick:
// - 'progress': 'puzzle:progress' (the progress sound); the part views glow / spin / open from the runtime (Req 13.3).
// - 'solved': the id is recorded in GameState world.puzzles, the parts settle in their done state,
//   'puzzle:solved' (solve sound, the opening, Quest `solve`), a RewardRef is granted, 'save:request' ('puzzle')
//   follows (Req 13.4). Solved puzzles take no more input; a load places them solved.
// - 'fail': 'puzzle:failed' (failure sound); a sequence out of order or out of time puts its parts back at once
//   (Req 13.5); from the 3rd failure the one-line hint goes to the HUD (Req 13.7). Puzzles can always be retried.
// Element hits on pressure plates are not puzzle input (a plate takes weights only). Solid devices are dynamic
// colliders; breakable ones (bramble, boulder, fire, Unstable_Crystal) go when broken and a `gate` part (the
// Heat_Crystal door) when its puzzle is solved; a `solid: false` part has none (its Challenge_Area places the collider,
// the Cinderspire H1 wall). The clock is the ReceiverField's, so the timers stop whenever the field does (cinematics,
// fades). Pure TypeScript: no three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import type { ElementId, ItemId, PuzzleId } from '../data/ids';
import {
  PUZZLE_RULES, PUZZLES, isOpensReward, partElement, type PuzzleDef, type PuzzlePartDef, type PuzzlePartDevice, type PuzzlePoint,
} from '../data/puzzles';
import {
  hintDue, initialPuzzleRuntime, puzzleOpen, puzzleProgress, puzzleTotal, sequenceTimeLeft, sequenceTimeLimit, solvedPuzzleRuntime,
  stepPuzzle, type PuzzleRuntime, type PuzzleSignal,
} from '../logic/puzzle';
import type { GameState } from '../logic/save/gameState';
import type { DeviceSignal, ReceiverField } from '../element/receiverField';
import { DeviceReceiver } from '../element/receivers';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { Collider, CollisionWorld } from '../physics/types';
import type { ObjectiveView } from '../quest/questSystem';

/** The solid body is this fraction of the hurt radius, so projectiles reach the hurt capsule before the wall. */
const BODY_RADIUS_SCALE = 0.8;
/** An arrival trigger counts feet from this far below its base. */
const ARRIVAL_BELOW = 0.5;
/** Devices that stop blocking once broken (DeviceReceiver.blocking). */
const BREAKABLE: ReadonlySet<PuzzlePartDevice> = new Set(['brambleGate', 'crackedBoulder', 'fireObstacle', 'unstableCrystal']);

/** What a solved puzzle's RewardRef is granted through. */
export interface PuzzleRewardSink {
  grantXp(amount: number): void;
  addGlim(amount: number): void;
  grant(itemId: ItemId, count: number, source: string): void;
}

export interface PuzzleSystemOptions {
  bus: GameEventBus;
  /** Written: world.puzzles. */
  state: GameState;
  /** Devices join it; its clock is the puzzles' clock. Route its onSignal / onPlate to this system. */
  field: ReceiverField;
  world: Pick<CollisionWorld, 'upsertDynamic' | 'removeDynamic'>;
  ids: ColliderIdSource;
  heightAt(x: number, z: number): number;
  rewards: PuzzleRewardSink;
  /** The one-line hint from the 3rd failure on (UI_System). */
  hint?(puzzleId: PuzzleId, text: string): void;
  /** Default PUZZLES; a play session passes puzzleDefsFor(its save seed), which adds the seeded Observatory puzzle. */
  defs?: readonly PuzzleDef[];
}

/** One part as the render draws it. */
export interface PuzzlePartView {
  readonly id: string;
  readonly device: PuzzlePartDevice;
  readonly pos: Vec3;
  readonly radius: number;
  readonly height: number;
  /** Element icon and colour on its surface (Req 13.2); null for an arrival trigger. */
  readonly element: ElementId | null;
  /** Order notches: the 1-based step of a sequence part, else 0. */
  readonly notches: number;
  /** Activated in the puzzle now (lit, spinning, pressed, reached). */
  readonly active: boolean;
  /** DeviceReceiver state ('arrival' parts: 'idle' / 'reached'). */
  readonly state: string;
  /** Still standing: not burnt, broken or exploded, and a gate not yet opened. */
  readonly present: boolean;
  /** Unstable_Crystal Telegraph left (s), else 0. */
  readonly telegraph: number;
  /** The part has a body of its own to draw; false when its Challenge_Area draws it (the H1 Heat_Crystal wall). */
  readonly body: boolean;
}

export interface PuzzleView {
  readonly id: PuzzleId;
  readonly kind: PuzzleDef['kind'];
  readonly solved: boolean;
  /** The `opens` target is open (solved, or a weight puzzle's plates all held). */
  readonly open: boolean;
  /** Where the opened thing is, when the reward opens one. */
  readonly opensAt: Vec3 | null;
  /** Seconds since it was solved in this session (the opening effect), else null. */
  readonly solvedAgo: number | null;
  /** 1 → 0 over the failure flash, else 0. */
  readonly failFlash: number;
  /** Fraction of a running sequence's time left (the shrinking ring), else null. */
  readonly timeLeft: number | null;
  readonly parts: readonly PuzzlePartView[];
}

interface PlacedPart {
  readonly def: PuzzlePartDef;
  readonly index: number;
  readonly pos: Vec3;
  readonly device: DeviceReceiver | null;
  readonly body: Collider | null;
  solid: boolean;
  /** Arrival: the Active_Character stands inside. */
  inside: boolean;
}

interface PuzzleEntry {
  readonly def: PuzzleDef;
  readonly parts: readonly PlacedPart[];
  readonly opensAt: Vec3 | null;
  rt: PuzzleRuntime;
  failedAt: number | null;
  solvedAt: number | null;
}

const resolve = (p: PuzzlePoint, heightAt: (x: number, z: number) => number): Vec3 => ({ x: p.x, y: p.y ?? heightAt(p.x, p.z), z: p.z });

export class PuzzleSystem {
  private readonly o: PuzzleSystemOptions;
  private readonly entries: readonly PuzzleEntry[];
  /** Part id → its puzzle. */
  private readonly byPart = new Map<string, PuzzleEntry>();

  constructor(options: PuzzleSystemOptions) {
    this.o = options;
    const solvedIds = new Set(options.state.world.puzzles);
    this.entries = (options.defs ?? PUZZLES).map((def) => {
      const parts = def.parts.map((part, index) => this.place(part, index));
      const reward = def.reward;
      const entry: PuzzleEntry = {
        def,
        parts,
        opensAt: isOpensReward(reward) ? resolve(reward.at, options.heightAt) : null,
        rt: initialPuzzleRuntime(),
        failedAt: null,
        solvedAt: null,
      };
      for (const p of parts) {
        if (this.byPart.has(p.def.id)) throw new Error(`PuzzleSystem: duplicate part ${p.def.id}`);
        this.byPart.set(p.def.id, entry);
      }
      if (solvedIds.has(def.id)) {
        // A load: solved puzzles are placed solved, their parts in the done state without effects.
        entry.rt = solvedPuzzleRuntime(def);
        for (const p of parts) p.device?.settle();
      }
      return entry;
    });
    this.updateBodies();
  }

  private get now(): number {
    return this.o.field.time;
  }

  /** ReceiverField onSignal: a hit reached a device. */
  deviceSignal(signal: DeviceSignal): void {
    if (signal.kind === 'pressurePlate') return; // plates take weights, not Elements
    this.feed(signal.part, { kind: 'element', part: signal.part, element: signal.element, accepted: signal.accepted });
  }

  /** ReceiverField onPlate: a pressure plate went down or came up. */
  plate(part: string, change: 'pressed' | 'released'): void {
    this.feed(part, { kind: change, part });
  }

  /**
   * After the ReceiverField's tick: arrival triggers against the Active_Character's feet, the sequence timers
   * (a 'tick' signal each) and the solid bodies.
   */
  tick(feet: Readonly<Vec3> | null): void {
    for (const entry of this.entries) {
      for (const p of entry.parts) {
        if (p.def.device !== 'arrival') continue;
        const inside = feet !== null && this.inArrival(p, feet);
        if (inside && !p.inside) this.feed(p.def.id, { kind: 'reached', part: p.def.id });
        p.inside = inside;
      }
      if (!entry.rt.solved) this.apply(entry, { kind: 'tick' });
    }
    this.updateBodies();
  }

  isSolved(id: string): boolean {
    return this.entries.some((e) => e.def.id === id && e.rt.solved);
  }

  /**
   * Party_Wipe restart at a checkpoint (design "체크포인트와 실패 처리", Req 12.8): solved puzzles stay solved; every
   * unsolved one drops its attempt in progress (sequence steps and timer, activations, plates) and its parts go back
   * to their first state. The failure count stays, so an earned hint keeps showing.
   */
  resetUnsolved(): void {
    for (const entry of this.entries) {
      if (entry.rt.solved) continue;
      entry.rt = { ...initialPuzzleRuntime(), failures: entry.rt.failures };
      entry.failedAt = null;
      for (const p of entry.parts) {
        p.device?.reset();
        p.inside = false;
      }
    }
    this.updateBodies();
  }

  /**
   * `hud:objective`: a `solve` Objective whose puzzle is already solved (solved before it became current, e.g. the
   * bramble burnt before Talus joined) hears its 'puzzle:solved' again, so the Main_Quest never waits on a puzzle that
   * cannot be solved twice (Req 2.6).
   */
  objectiveChanged(view: ObjectiveView | null): void {
    const trigger = view?.objective.trigger;
    if (trigger?.kind !== 'solve') return;
    const entry = this.entries.find((e) => e.def.id === trigger.puzzleId);
    if (entry === undefined || !entry.rt.solved) return;
    this.o.bus.emit('puzzle:solved', { puzzleId: entry.def.id, regionId: entry.def.region });
  }

  /** Whether the target `opens` names is open now (a Chest to show, a door, a platform). */
  isOpen(target: string): boolean {
    return this.entries.some((e) => isOpensReward(e.def.reward) && e.def.reward.opens === target && puzzleOpen(e.def, e.rt));
  }

  /** The runtime of a puzzle (tests, debug). */
  runtime(id: string): PuzzleRuntime | null {
    return this.entries.find((e) => e.def.id === id)?.rt ?? null;
  }

  /** The placed definition of a puzzle (the Observatory's is the save's seeded one), or null. */
  definition(id: string): PuzzleDef | null {
    return this.entries.find((e) => e.def.id === id)?.def ?? null;
  }

  /** A sequence puzzle's order (the ceiling constellations show it), null for an unknown puzzle or another kind. */
  sequenceOrder(id: string): readonly ElementId[] | null {
    return this.definition(id)?.order ?? null;
  }

  /** The placed device of a part. */
  device(partId: string): DeviceReceiver | null {
    for (const e of this.entries) for (const p of e.parts) if (p.def.id === partId) return p.device;
    return null;
  }

  /** Whether a part's solid body is in the collision world. */
  bodySolid(partId: string): boolean {
    for (const e of this.entries) for (const p of e.parts) if (p.def.id === partId) return p.solid;
    return false;
  }

  /** Whether a part still stands: not burnt, broken or exploded, and a gate not yet opened (false for an unknown id). */
  partPresent(partId: string): boolean {
    for (const e of this.entries) for (const p of e.parts) if (p.def.id === partId) return this.standing(e, p, this.now);
    return false;
  }

  /** Every puzzle and part for the render, in definition order. */
  views(): PuzzleView[] {
    const now = this.now;
    return this.entries.map((e): PuzzleView => {
      const { def, rt } = e;
      const left = sequenceTimeLeft(def, rt, now);
      const flash = e.failedAt === null ? 0 : 1 - (now - e.failedAt) / PUZZLE_RULES.failFlashSec;
      return {
        id: def.id,
        kind: def.kind,
        solved: rt.solved,
        open: puzzleOpen(def, rt),
        opensAt: e.opensAt,
        solvedAgo: e.solvedAt === null ? null : now - e.solvedAt,
        failFlash: Math.max(0, Math.min(1, flash)),
        timeLeft: left === null ? null : left / sequenceTimeLimit(def),
        parts: e.parts.map((p) => this.partView(e, p, now)),
      };
    });
  }

  private partView(e: PuzzleEntry, p: PlacedPart, now: number): PuzzlePartView {
    const d = p.device;
    const active = e.rt.active.includes(p.def.id);
    return {
      id: p.def.id,
      device: p.def.device,
      pos: p.pos,
      radius: p.def.radius,
      height: p.def.height,
      element: partElement(e.def, p.index),
      notches: e.def.kind === 'sequence' && p.index < (e.def.order?.length ?? 0) ? p.index + 1 : 0,
      active,
      state: d === null ? (active ? 'reached' : 'idle') : d.stateAt(now),
      present: this.standing(e, p, now),
      telegraph: d?.telegraphLeft(now) ?? 0,
      body: p.def.solid !== false,
    };
  }

  private place(part: PuzzlePartDef, index: number): PlacedPart {
    const pos = resolve(part.pos, this.o.heightAt);
    if (part.device === 'arrival') return { def: part, index, pos, device: null, body: null, solid: false, inside: false };
    const device = new DeviceReceiver(part.id, part.device);
    this.o.field.add(device, { pos, radius: part.radius, height: part.height });
    // Pressure plates are walked over; a part with `solid: false` has its collider placed by its Challenge_Area.
    const body: Collider | null = part.device === 'pressurePlate' || part.solid === false ? null : {
      kind: 'cylinder', id: this.o.ids.next(), base: { ...pos }, radius: part.radius * BODY_RADIUS_SCALE, height: part.height,
      flags: { climbable: false, walkableTop: false, blocksCamera: false, material: part.device === 'brazier' || part.device === 'windWheel' ? 'stone' : 'crystal' },
    };
    return { def: part, index, pos, device, body, solid: false, inside: false };
  }

  private inArrival(p: PlacedPart, feet: Readonly<Vec3>): boolean {
    return Math.hypot(feet.x - p.pos.x, feet.z - p.pos.z) <= p.def.radius
      && feet.y >= p.pos.y - ARRIVAL_BELOW && feet.y <= p.pos.y + p.def.height;
  }

  /** Not broken open, and a gate part not yet opened by its puzzle. */
  private standing(e: PuzzleEntry, p: PlacedPart, now: number): boolean {
    if (p.device === null) return true;
    if (BREAKABLE.has(p.def.device)) return p.device.blocking(now);
    return !(p.def.gate === true && e.rt.solved);
  }

  private updateBodies(): void {
    const now = this.now;
    for (const e of this.entries) {
      for (const p of e.parts) {
        if (p.body === null) continue;
        const solid = this.standing(e, p, now);
        if (solid === p.solid) continue;
        p.solid = solid;
        if (solid) this.o.world.upsertDynamic(p.body);
        else this.o.world.removeDynamic(p.body.id);
      }
    }
  }

  private feed(partId: string, sig: PuzzleSignal): void {
    const entry = this.byPart.get(partId);
    if (entry !== undefined) this.apply(entry, sig);
  }

  private apply(entry: PuzzleEntry, sig: PuzzleSignal): void {
    const { def } = entry;
    const now = this.now;
    const { rt, outcome, cause } = stepPuzzle(def, entry.rt, sig, now);
    entry.rt = rt;
    switch (outcome) {
      case 'none':
        return;
      case 'progress':
        this.o.bus.emit('puzzle:progress', { puzzleId: def.id, step: puzzleProgress(def, rt), total: puzzleTotal(def) });
        return;
      case 'solved':
        this.solve(entry, now);
        return;
      case 'fail': {
        entry.failedAt = now;
        if (cause !== 'rejected') for (const p of entry.parts) p.device?.reset(); // the steps start over
        this.o.bus.emit('puzzle:failed', { puzzleId: def.id, failures: rt.failures, cause: cause ?? 'order' });
        if (hintDue(rt)) this.o.hint?.(def.id, def.hint);
      }
    }
  }

  private solve(entry: PuzzleEntry, now: number): void {
    const { def } = entry;
    entry.solvedAt = now;
    const world = this.o.state.world;
    if (!world.puzzles.includes(def.id)) world.puzzles.push(def.id);
    for (const p of entry.parts) p.device?.settle();
    this.o.bus.emit('puzzle:solved', { puzzleId: def.id, regionId: def.region });
    const reward = def.reward;
    if (!isOpensReward(reward)) {
      const r = this.o.rewards;
      if (reward.xp !== undefined) r.grantXp(reward.xp);
      if (reward.glim !== undefined) r.addGlim(reward.glim);
      for (const item of reward.items ?? []) r.grant(item.id, item.count, 'puzzle');
    }
    this.o.bus.emit('save:request', { reason: 'puzzle' });
    this.updateBodies();
  }
}
