// Test helper: a scripted player for the headless PlaySim. It plays only through the InputState (raw key and
// mouse events, like BrowserInput) and the camera yaw it passes to PlaySim.tick (what mouse look would set), and
// reads the simulation state to decide (as the Playwright bot reads the Test_Harness). Primitives: walking along
// terrain paths, interacting with a named target, riding lift pads, hopping onto raised steps, climbing a wall to its
// top, gliding off a ledge into an Updraft, circling up it and gliding on to a landing, gliding off a ledge toward a
// far point, resting for Stamina, fighting an encounter group (backing off / dodging when an enemy's Telegraph starts)
// and fighting Caelith.

import { angleDelta, yawFromDir } from '../../../src/core/math';
import type { Vec3 } from '../../../src/core/types';
import type { UiCommandQueue } from '../../../src/core/uiCommands';
import type { BossTelegraph } from '../../../src/boss/bossSnapshot';
import type { AreaSpot, AreaUpdraftDef } from '../../../src/data/challengeAreas';
import type { InteractTargetKind } from '../../../src/core/gameEvents';
import type { CharacterId } from '../../../src/data/ids';
import type { InputState, RawInput } from '../../../src/input/inputState';
import { PARTY_SLOTS } from '../../../src/logic/party';
import type { PlaySim } from '../../../src/playSim';
import { isClimbMode, isGlideMode } from '../../../src/player/core/types';
import type { EnemyRuntime } from '../../../src/save/runtimeState';
import { findGroundPath, type XZ } from './terrainPath';

export const BOT_DT = 1 / 60;
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD'] as const;
type MoveKey = (typeof MOVE_KEYS)[number];
const ENGAGED = new Set(['alert', 'chase', 'attack', 'recovery', 'stagger']);

const flat = (a: Readonly<Vec3> | XZ, b: Readonly<Vec3> | XZ): number => Math.hypot(b.x - a.x, b.z - a.z);

export class RouteBot {
  /** Sim seconds played. */
  t = 0;
  cameraYaw = 0;
  /** Party_Wipes, by the Caelith Phase they happened in (null outside the fight). */
  readonly wipes: (1 | 2 | 3 | null)[] = [];
  private readonly held = new Set<MoveKey>();
  private events: RawInput[] = [];
  trace = false;
  private anchor: XZ | null = null;
  private evadeUntil = 0;
  private dodged = false;
  private evadeKeys: MoveKey[] = [];
  private ticks = 0;
  /** Task 21.1: skip skippable cinematics with the normal skip input (Esc hold). */
  skipCinematics = true;
  /** The cinematic Esc is held for, or null. */
  private skipping: string | null = null;

  constructor(
    readonly sim: PlaySim,
    private readonly input: InputState,
    private readonly commands: UiCommandQueue,
    private readonly maxSeconds: number,
  ) {}

  /** The Defeat Screen's choice, as the UI would queue it. */
  onWipe(bossPhase: 1 | 2 | 3 | null): void {
    this.wipes.push(bossPhase);
    this.commands.push({ kind: 'defeatChoice', choice: bossPhase === null ? 'respawn' : 'retryPhase' });
  }

  get pos(): Readonly<Vec3> {
    return this.sim.player.state.pos;
  }

  /**
   * One tick with the held keys and this tick's taps. While a dialogue window is open (an NPC talk or a stage
   * briefing, task 13.1) the bot reads it through like a player: F every third tick completes the typing, then
   * moves on to the next window.
   */
  step(): void {
    if (this.t > this.maxSeconds) throw new Error(`route bot: over ${this.maxSeconds} s of play`);
    if (this.sim.dialogue.open && this.ticks % 3 === 0) this.events.push({ kind: 'down', code: 'KeyF', time: 0 }, { kind: 'up', code: 'KeyF', time: 0 });
    // Task 21.1: a skippable cinematic is skipped as a player would: Esc held from its skip hint on (1 s in) for 1 s,
    // released once it ends (or before holding it again for the next one).
    const view = this.skipCinematics ? this.sim.cinematics.view() : null;
    const skip = view !== null && view.skipAvailable ? view.id : null;
    if (this.skipping !== null && this.skipping !== skip) {
      this.events.push({ kind: 'up', code: 'Escape', time: 0 });
      this.skipping = null;
    } else if (this.skipping === null && skip !== null) {
      this.events.push({ kind: 'down', code: 'Escape', time: 0 });
      this.skipping = skip;
    }
    this.input.beginTick(this.events, BOT_DT);
    this.events = [];
    this.sim.tick(BOT_DT, this.cameraYaw);
    this.t += BOT_DT;
    this.ticks++;
    if (this.trace && this.ticks % 6 === 0) console.info('trace', this.t.toFixed(2), this.where(), this.sim.interaction.prompt?.id ?? '-', this.sim.recovery.reason ?? '');
  }

  /** Holds exactly `keys` of the movement keys. */
  hold(keys: readonly MoveKey[] = []): void {
    for (const k of MOVE_KEYS) {
      const want = keys.includes(k);
      if (want && !this.held.has(k)) {
        this.held.add(k);
        this.events.push({ kind: 'down', code: k, time: 0 });
      } else if (!want && this.held.has(k)) {
        this.held.delete(k);
        this.events.push({ kind: 'up', code: k, time: 0 });
      }
    }
  }

  /** Press and release inside the next tick (F interact, Space jump, Mouse0 attack, Mouse2 dodge, E Skill, digits switch). */
  tap(code: 'KeyF' | 'Space' | 'Mouse0' | 'Mouse2' | 'KeyE' | `Digit${1 | 2 | 3 | 4}`): void {
    this.events.push({ kind: 'down', code, time: 0 }, { kind: 'up', code, time: 0 });
  }

  /** Switches the Active_Character with its number key (slots kairen 1, isla 2, wren 3, talus 4) and waits for it. */
  switchTo(label: string, character: CharacterId): void {
    this.settle();
    const slot = PARTY_SLOTS.indexOf(character) + 1;
    if (slot < 1) throw new Error(`${label}: no slot for ${character}`);
    const party = this.sim.gameState.party;
    if (party.downed.includes(character)) throw new Error(`${label}: ${character} is Downed`);
    const end = this.t + 3;
    this.hold([]);
    while (party.active !== character) {
      if (this.t > end) throw new Error(`${label}: could not switch to ${character} (active ${party.active})`);
      if (this.ticks % 6 === 0) this.tap(`Digit${slot as 1 | 2 | 3 | 4}`);
      this.step();
    }
    this.idle(0.1);
  }

  /** Faces `at` and casts the Active_Character's Skill (E) toward it, then waits until `done` (or `maxSeconds`). */
  castSkill(label: string, at: Readonly<Vec3>, done: () => boolean, maxSeconds = 4): void {
    this.settle();
    this.cameraYaw = yawFromDir(at.x - this.pos.x, at.z - this.pos.z);
    this.hold(['KeyW']); // the Skill faces the move input as it starts
    this.tap('KeyE');
    this.step();
    this.hold([]);
    const end = this.t + maxSeconds;
    while (!done()) {
      if (this.t > end) throw new Error(`${label}: not done ${maxSeconds} s after the Skill (at ${this.where()})`);
      this.step();
    }
  }

  /** Walks up to `at` and swings the Normal_Attack chain at it until `done` (a puzzle device breaking or burning). */
  strike(label: string, at: Readonly<Vec3>, done: () => boolean, reach = 1.9, maxSeconds = 12): void {
    this.settle();
    const end = this.t + maxSeconds;
    while (!done()) {
      if (this.t > end) throw new Error(`${label}: not done after ${maxSeconds} s of attacks (at ${this.where()})`);
      const d = flat(this.pos, at);
      this.cameraYaw = yawFromDir(at.x - this.pos.x, at.z - this.pos.z);
      this.hold(d > reach && !this.sim.combat.locksMovement ? ['KeyW'] : []);
      if (d <= reach + 0.4 && this.ticks % 4 === 0) this.tap('Mouse0');
      this.step();
    }
    this.calm();
  }

  /** Ticks without movement for `seconds`. */
  idle(seconds: number): void {
    this.hold([]);
    for (let i = 0; i < Math.round(seconds / BOT_DT); i++) this.step();
  }

  /** Ticks without input until `done` (or fails after `maxSeconds`). */
  waitUntil(label: string, done: () => boolean, maxSeconds = 10): void {
    this.hold([]);
    const end = this.t + maxSeconds;
    while (!done()) {
      if (this.t > end) throw new Error(`${label}: not done after ${maxSeconds} s (at ${this.where()})`);
      this.step();
    }
  }

  /** Waits while a fade or cinematic holds input. */
  settle(): void {
    this.waitUntil('settle', () => !this.sim.inputLocked, 15);
  }

  where(): string {
    const p = this.pos;
    return `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) ${this.sim.player.state.mode}`;
  }

  /** Walks a terrain path from here to (x, z), found on the heightfield. */
  goTo(label: string, to: XZ, radius = 1.2, maxSlopeDeg = 42): void {
    const from = { x: this.pos.x, z: this.pos.z };
    const path = findGroundPath(this.sim.terrain, from, to, { maxSlopeDeg });
    if (path === null) throw new Error(`${label}: no ground path from ${this.where()} to (${to.x}, ${to.z})`);
    this.walk(label, path.slice(1), radius);
  }

  /** Walks straight through `points`, fighting enemies that engage on the way. */
  walk(label: string, points: readonly XZ[], radius = 1.2): void {
    points.forEach((p, i) => this.walkTo(label, p, i === points.length - 1 ? radius : 1.2));
    this.hold([]);
  }

  walkTo(label: string, p: XZ, radius = 1.2): void {
    let best = Infinity;
    let bestT = this.t;
    for (;;) {
      if (this.sim.inputLocked) {
        this.hold([]);
        this.step();
        continue;
      }
      if (this.engagedNear(12) !== null) {
        this.fightEngaged(label);
        best = Infinity;
        bestT = this.t;
        continue;
      }
      const d = flat(this.pos, p);
      if (d <= radius) return;
      if (d < best - 0.3) {
        best = d;
        bestT = this.t;
      }
      if (this.t - bestT > 1.5 && this.ticks % 30 === 0) this.tap('Space');
      if (this.t - bestT > 12) throw new Error(`${label}: stuck at ${this.where()} heading to (${p.x}, ${p.z})`);
      this.cameraYaw = yawFromDir(p.x - this.pos.x, p.z - this.pos.z);
      this.hold(['KeyW']);
      this.step();
    }
  }

  /** Walks up to a target and interacts once its prompt is offered. */
  interact(label: string, kind: InteractTargetKind, id: string, at: Readonly<Vec3>, approach = 1.6): void {
    this.settle();
    this.walkTo(label, at, approach);
    const end = this.t + 3;
    for (;;) {
      const prompt = this.sim.interaction.prompt;
      if (prompt !== null && prompt.kind === kind && prompt.id === id) break;
      if (this.t > end) throw new Error(`${label}: no prompt for ${kind}:${id} at ${this.where()} (offered: ${prompt?.id ?? 'none'})`);
      this.cameraYaw = yawFromDir(at.x - this.pos.x, at.z - this.pos.z);
      this.hold(flat(this.pos, at) > 0.9 ? ['KeyW'] : []);
      this.step();
    }
    this.hold([]);
    this.tap('KeyF');
    this.step();
    this.step();
    // An NPC talk: read it to its end, when its onEnd (a companion joining, a Side_Quest accepted) has applied.
    if (kind === 'npc') this.waitUntil(`${label}: dialogue`, () => !this.sim.dialogue.open, 60);
  }

  /** Uses a lift pad (a temporary route lift or a Challenge_Area root lift) and waits until the fade has put the character on its destination. */
  ride(label: string, id: string): void {
    const lift = this.sim.route.lifts.find((l) => l.def.id === id) ?? this.sim.challenge.lifts.find((l) => l.def.id === id);
    if (lift === undefined) throw new Error(`${label}: no lift ${id}`);
    this.interact(label, 'lift', id, lift.pad, 1.0);
    this.waitUntil(`${label}: fade`, () => this.sim.recovery.active, 1);
    this.settle();
    if (flat(this.pos, lift.to.pos) > 0.5) throw new Error(`${label}: lift ${id} left the character at ${this.where()}`);
  }

  /** Rests (no input) until the party Stamina is back to `min` (Req 17.2: regen 25/s after 1 s without drain). */
  rest(label: string, min = 95): void {
    this.waitUntil(`${label}: Stamina`, () => this.sim.runtime.stamina.value >= min && !this.sim.runtime.stamina.exhausted, 12);
  }

  /**
   * Walks to `foot` (in front of a climbable wall), then pushes into the wall (camera yaw `face`, W held): the push
   * attaches (0.2 s), W climbs up at 2 m/s and the top mantles. Returns once standing on the top (feet ≥ topY − 0.5)
   * with the Stamina the climb used; falling off (a reheated Heat_Crystal, Stamina out) throws.
   */
  climb(label: string, foot: Readonly<Vec3>, face: number, topY: number, maxSeconds = 20): number {
    this.settle();
    this.walkTo(label, foot, 0.45);
    const before = this.sim.runtime.stamina.value;
    let lowest = before;
    let started = false;
    const end = this.t + maxSeconds;
    for (;;) {
      const s = this.sim.player.state;
      if (isClimbMode(s.mode)) started = true;
      lowest = Math.min(lowest, this.sim.runtime.stamina.value);
      if (started && s.mode === 'grounded' && s.pos.y > topY - 0.5) break;
      if (this.t > end) throw new Error(`${label}: not on top after ${maxSeconds} s (at ${this.where()}, Stamina ${this.sim.runtime.stamina.value.toFixed(0)})`);
      if (started && !isClimbMode(s.mode)) throw new Error(`${label}: came off the wall at ${this.where()} (Stamina ${this.sim.runtime.stamina.value.toFixed(0)})`);
      this.cameraYaw = face;
      this.hold(['KeyW']);
      this.step();
    }
    this.hold([]);
    this.step();
    return before - lowest;
  }

  /**
   * Updraft ride: walks to the take-off spot `from`, runs off the ledge along its yaw and opens the glider once the
   * fall is past its coyote window (a jump then deploys), steers into `column`, circles up to its top, leaves it once
   * the heading points at `target` and glides there, until standing on ground at about `landingY`. Returns the Stamina
   * used from the take-off to the landing.
   */
  glideUpdraft(label: string, from: AreaSpot, column: AreaUpdraftDef, target: Readonly<Vec3>, landingY: number, maxSeconds = 20): number {
    this.settle();
    this.walkTo(label, from.pos, 0.35);
    const before = this.sim.runtime.stamina.value;
    let lowest = before;
    const end = this.t + maxSeconds;
    let exiting = false;
    let airborne = false;
    for (;;) {
      const s = this.sim.player.state;
      lowest = Math.min(lowest, this.sim.runtime.stamina.value);
      if (this.t > end) throw new Error(`${label}: glide not landed after ${maxSeconds} s (at ${this.where()})`);
      if (this.sim.recovery.active) throw new Error(`${label}: fell into the fall judgement from ${this.where()}`);
      if (!airborne) {
        if (isGlideMode(s.mode)) airborne = true;
        else {
          // Run off the rim; once falling past the coyote window, a jump press opens the glider.
          this.cameraYaw = from.yaw;
          this.hold(['KeyW']);
          if (s.mode === 'fall' && s.coyoteTime <= 0 && this.ticks % 2 === 0) this.tap('Space');
          this.step();
          continue;
        }
      }
      if ((s.mode === 'grounded' || s.mode === 'landing') && Math.abs(s.pos.y - landingY) < 1) break;
      if (s.mode === 'grounded' || s.mode === 'fall') throw new Error(`${label}: glide ended at ${this.where()}`);
      if (isClimbMode(s.mode)) {
        // Caught a wall short of the landing: climb it up.
        this.hold(['KeyW']);
        this.step();
        continue;
      }
      const heading = yawFromDir(s.vel.x, s.vel.z);
      const toTarget = yawFromDir(target.x - s.pos.x, target.z - s.pos.z);
      if (!exiting && s.pos.y >= column.maxY - 0.3 && Math.abs(angleDelta(heading, toTarget)) < 0.35) exiting = true;
      this.cameraYaw = exiting ? toTarget : this.circleYaw(s.pos, s.vel, column);
      this.hold(['KeyW']);
      this.step();
    }
    this.hold([]);
    this.idle(0.3);
    return before - lowest;
  }

  /**
   * Glides off a ledge toward a far point: walks to `from`, runs off it along its yaw, opens the glider once the fall is
   * past its coyote window, steers toward `toward` and holds on until standing on the ground again (the glide ends by
   * itself when the Stamina runs out, and the fall lands). Returns the Stamina used from the take-off to the landing
   * and whether the glider opened; a recovery on the way throws.
   */
  glideToward(label: string, from: AreaSpot, toward: XZ, maxSeconds = 40): { used: number; glided: boolean } {
    this.settle();
    this.walkTo(label, from.pos, 0.35);
    const before = this.sim.runtime.stamina.value;
    let lowest = before;
    let airborne = false;
    let glided = false;
    const end = this.t + maxSeconds;
    for (;;) {
      const s = this.sim.player.state;
      lowest = Math.min(lowest, this.sim.runtime.stamina.value);
      if (this.t > end) throw new Error(`${label}: not landed after ${maxSeconds} s (at ${this.where()})`);
      if (this.sim.recovery.active) throw new Error(`${label}: a recovery (${this.sim.recovery.reason ?? '?'}) at ${this.where()}`);
      if (isGlideMode(s.mode)) glided = true;
      if (s.mode !== 'grounded') airborne = true;
      if (airborne && glided && (s.mode === 'grounded' || s.mode === 'landing')) break;
      if (!glided) {
        this.cameraYaw = from.yaw;
        if (s.mode === 'fall' && s.coyoteTime <= 0 && this.ticks % 2 === 0) this.tap('Space');
      } else {
        this.cameraYaw = yawFromDir(toward.x - s.pos.x, toward.z - s.pos.z);
      }
      this.hold(['KeyW']);
      this.step();
    }
    this.hold([]);
    this.idle(0.5);
    return { used: before - lowest, glided };
  }

  /**
   * Heading that keeps a glider circling inside an Updraft column: along the circle of radius 2.9 m about its axis
   * (the glide turns at most 200°/s, a 2.6 m radius at 9 m/s), turned inward when outside that circle and outward
   * when inside it; from outside the column, straight for its axis.
   */
  private circleYaw(pos: Readonly<Vec3>, vel: Readonly<Vec3>, column: AreaUpdraftDef): number {
    const dx = pos.x - column.center.x;
    const dz = pos.z - column.center.z;
    const d = Math.hypot(dx, dz);
    if (d > column.radius - 0.3 || d < 1e-3) return yawFromDir(-dx, -dz);
    const rx = dx / d;
    const rz = dz / d;
    const sgn = rx * vel.z - rz * vel.x >= 0 ? 1 : -1;
    const tx = -rz * sgn;
    const tz = rx * sgn;
    const alpha = Math.max(-0.9, Math.min(0.9, (d - 2.9) * 0.8));
    return yawFromDir(tx * Math.cos(alpha) - rx * Math.sin(alpha), tz * Math.cos(alpha) - rz * Math.sin(alpha));
  }

  /**
   * Walks around a round obstacle (a ring corridor's central oculus): straight out from `center` to `radius`, then
   * along that circle the short way to angle `toAngle` (rad, from +x toward +z), in steps of at most 0.5 rad.
   */
  circleTo(label: string, center: XZ, radius: number, toAngle: number, endRadius = radius): void {
    const from = Math.atan2(this.pos.z - center.z, this.pos.x - center.x);
    const delta = angleDelta(from, toAngle);
    const n = Math.max(1, Math.ceil(Math.abs(delta) / 0.5));
    const points: XZ[] = [];
    for (let k = 0; k <= n; k++) {
      const a = from + (delta * k) / n;
      const r = k === n ? endRadius : radius;
      points.push({ x: center.x + r * Math.cos(a), z: center.z + r * Math.sin(a) });
    }
    this.walk(label, points, 0.6);
  }

  /** Hops from step to step (centre, top height, half size); each step is up to 1 m higher than the last. */
  hopSteps(label: string, steps: readonly { x: number; z: number; top: number; half: number }[]): void {
    for (const s of steps) {
      const end = this.t + 6;
      for (;;) {
        const me = this.sim.player.state;
        const d = flat(me.pos, s);
        const on = me.grounded && Math.abs(me.pos.y - s.top) < 0.15 && d < s.half;
        if (on && d < Math.min(0.8, s.half - 0.4)) break;
        if (this.t > end) throw new Error(`${label}: missed the step at (${s.x}, ${s.z}) y ${s.top} (at ${this.where()})`);
        this.cameraYaw = yawFromDir(s.x - me.pos.x, s.z - me.pos.z);
        this.hold(['KeyW']);
        if (me.mode === 'grounded' && me.pos.y < s.top - 0.3 && d < s.half + 1.4) this.tap('Space');
        this.step();
      }
    }
    this.hold([]);
  }

  /** The nearest living enemy engaging the party within `range`, else null. */
  engagedNear(range: number): EnemyRuntime | null {
    let best: EnemyRuntime | null = null;
    for (const e of this.sim.runtime.enemies.values()) {
      if (!ENGAGED.has(e.state) || Math.abs(e.pos.y - this.pos.y) > 6) continue;
      const d = flat(this.pos, e.pos);
      if (d <= range && (best === null || d < flat(this.pos, best.pos))) best = e;
    }
    return best;
  }

  /** Fights until no enemy engages within 20 m. */
  fightEngaged(label: string): void {
    const end = this.t + 90;
    for (let e = this.engagedNear(20); e !== null; e = this.engagedNear(20)) {
      if (this.t > end) throw new Error(`${label}: fight did not end (at ${this.where()}; ${this.enemyReport()})`);
      this.combatTick(e.pos);
    }
    this.calm();
  }

  /**
   * Defeats every member of encounter group `campId` (waits for it to appear first). On a platform, `anchor` is
   * its centre: evasion then steps back or sideways, whichever stays nearest to it.
   */
  fight(label: string, campId: string, anchor: XZ | null = null): void {
    this.anchor = anchor;
    try {
      this.fightGroup(label, campId);
    } finally {
      this.anchor = null;
    }
  }

  private fightGroup(label: string, campId: string): void {
    const members = (): EnemyRuntime[] => [...this.sim.runtime.enemies.values()].filter((e) => e.campId === campId && e.state !== 'dead');
    const pending = (): boolean => {
      const t = this.sim.quests.objectiveView('main')?.objective.trigger;
      return t?.kind === 'defeat' && t.groupId === campId;
    };
    // Already beaten on the way here (walkTo fights whoever engages) when its Objective has moved on.
    this.waitUntil(`${label}: ${campId} spawned`, () => members().length > 0 || !pending(), 3);
    // Up to 4 minutes: the Observatory's shielded, knock-back waves can hold the melee bot off for a long time (and a
    // Party_Wipe restarts the room from its checkpoint) before they fall.
    const end = this.t + 240;
    for (let list = members(); list.length > 0; list = members()) {
      if (this.t > end) throw new Error(`${label}: ${campId} still has ${list.length} members (at ${this.where()}; ${this.enemyReport()})`);
      if (this.sim.inputLocked) {
        this.hold([]);
        this.step();
        continue;
      }
      const engaged = this.engagedNear(20);
      const target = engaged ?? list.reduce((a, b) => (flat(this.pos, a.pos) <= flat(this.pos, b.pos) ? a : b));
      this.combatTick(target.pos);
    }
    this.calm();
  }

  /** After a fight: no evasion left and the buffered attack / dodge presses expired (0.15 s). */
  private calm(): void {
    this.evadeUntil = 0;
    this.idle(0.25);
  }

  /** Fights Caelith until it is defeated (Party_Wipes retry the Phase through onWipe). */
  bossFight(label: string): void {
    const boss = this.sim.boss;
    const end = this.t + 900;
    while (boss.state !== 'dead') {
      if (this.t > end) throw new Error(`${label}: Caelith at ${boss.hp} HP in Phase ${boss.phase} after the time limit`);
      if (this.sim.inputLocked) {
        this.hold([]);
        this.step();
        continue;
      }
      // Task 10: the full encounter. Read its Telegraph areas like a player: step out of one that covers the
      // character, Dodge (i-frames) as it lands, jump the Astral Sweep ring, Dodge an incoming shard; otherwise melee.
      const snap = boss.snapshot();
      const me = this.sim.player.state;
      const d = flat(this.pos, snap.pos);
      this.cameraYaw = yawFromDir(snap.pos.x - this.pos.x, snap.pos.z - this.pos.z);
      if (snap.state === 'dormant') {
        this.hold(['KeyW']); // walk in to start the fight
        this.step();
        continue;
      }
      this.switchIfLow();
      const covering = snap.telegraphs.filter((t) => this.bossTelegraphCovers(t));
      const soonest = covering.reduce((m, t) => Math.min(m, t.remaining), Infinity);
      const ring = snap.ring;
      const ringGap = ring === null ? Infinity : flat(this.pos, ring.center) - 0.4 - ring.radius;
      const shardNear = snap.shards.some((s) => flat(this.pos, s) < 2.6 && Math.abs(s.y - this.pos.y - 1) < 1.5);
      const sweepSoon = snap.attack === 'atk_caelith_astralSweep' || ring !== null;
      const canDodge = me.mode !== 'dodge' && !this.sim.combat.locksMovement;
      if (ring !== null && ringGap > 0.6 && ringGap < 2.2 && me.grounded) {
        this.hold([]);
        this.tap('Space'); // feet above 0.8 m as the ring passes (Req 6.8)
      } else if (covering.length > 0) {
        const t = covering.reduce((a, b) => (a.remaining <= b.remaining ? a : b));
        this.hold([this.keyToward(this.bossEscape(t))]);
        if (soonest <= 0.15 && canDodge) this.tap('Mouse2');
      } else if (shardNear) {
        this.hold(['KeyD']);
        if (canDodge) this.tap('Mouse2');
      } else if (snap.attack === 'atk_caelith_starShards' && snap.telegraphRemaining > 0) {
        this.hold(['KeyD']); // step aside from the aim lines
      } else if (sweepSoon) {
        this.hold(d < 5 ? ['KeyS'] : []); // stand clear, no attack lock when the ring comes
      } else {
        this.hold(d > 3.4 ? ['KeyW'] : []);
        if (snap.state !== 'transition' && d < 4.2 && this.ticks % 4 === 0) this.tap('Mouse0');
      }
      this.step();
    }
    this.hold([]);
  }

  /** Whether Caelith's (or a crystal's) Telegraph area `t` covers the character, with a step of margin. */
  private bossTelegraphCovers(t: BossTelegraph): boolean {
    const p = this.pos;
    const margin = 0.4 + 0.6;
    const dx = p.x - t.center.x;
    const dz = p.z - t.center.z;
    const r = Math.hypot(dx, dz);
    switch (t.shape) {
      case 'circle':
        return r < t.radius + margin;
      case 'sector': {
        if (r > t.radius + margin) return false;
        if (r < 1) return true;
        const off = Math.abs(angleDelta(t.yaw, yawFromDir(dx, dz)));
        return off < (t.angleDeg / 2) * (Math.PI / 180) + 0.35;
      }
      case 'line': {
        const fx = Math.sin(t.yaw);
        const fz = Math.cos(t.yaw);
        const along = dx * fx + dz * fz;
        return along > -1 && along < t.length + 1 && Math.abs(dx * fz - dz * fx) < t.width / 2 + margin;
      }
      case 'arenaSector':
        return this.sim.sanctum.sectorAt(p.x, p.z) === t.sector;
      default:
        return false;
    }
  }

  /** World direction out of Telegraph area `t`. */
  private bossEscape(t: BossTelegraph): XZ {
    const p = this.pos;
    const dx = p.x - t.center.x;
    const dz = p.z - t.center.z;
    const r = Math.hypot(dx, dz);
    if (t.shape === 'line') {
      const side = dx * Math.cos(t.yaw) - dz * Math.sin(t.yaw) >= 0 ? 1 : -1;
      return { x: Math.cos(t.yaw) * side, z: -Math.sin(t.yaw) * side };
    }
    if (t.shape === 'arenaSector') return r > 1e-3 ? { x: -dz / r, z: dx / r } : { x: 1, z: 0 }; // along the rim to a neighbour
    return r > 1e-3 ? { x: dx / r, z: dz / r } : { x: Math.sin(t.yaw + Math.PI / 2), z: Math.cos(t.yaw + Math.PI / 2) };
  }

  /** The camera-relative movement key closest to world direction `dir` (player/controllerInput cameraRelativeMove). */
  private keyToward(dir: XZ): MoveKey {
    const s = Math.sin(this.cameraYaw);
    const c = Math.cos(this.cameraYaw);
    const options: [MoveKey, number, number][] = [['KeyW', s, c], ['KeyS', -s, -c], ['KeyA', c, -s], ['KeyD', -c, s]];
    let best: MoveKey = 'KeyS';
    let bestDot = -Infinity;
    for (const [key, x, z] of options) {
      const dot = x * dir.x + z * dir.z;
      if (dot > bestDot) {
        bestDot = dot;
        best = key;
      }
    }
    return best;
  }

  /**
   * A worn-out Active_Character (under 30 % HP) hands over to the healthiest companion still above half of theirs, so
   * nobody the route needs later (an Element for a puzzle) is Downed while others could fight.
   */
  private switchIfLow(): void {
    const party = this.sim.gameState.party;
    const share = (id: CharacterId): number => party.hp[id] / Math.max(1, this.sim.party.maxHp(id));
    if (share(party.active) >= 0.3 || this.ticks % 6 !== 0) return;
    let best: CharacterId | null = null;
    for (const id of PARTY_SLOTS) {
      if (id === party.active || !party.joined.includes(id) || party.downed.includes(id) || share(id) <= 0.5) continue;
      if (best === null || share(id) > share(best)) best = id;
    }
    if (best !== null) this.tap(`Digit${(PARTY_SLOTS.indexOf(best) + 1) as 1 | 2 | 3 | 4}`);
  }

  /** One tick of melee against the enemy at `target`: back off / dodge from a starting Telegraph, else attack. */
  private combatTick(target: Readonly<Vec3>): void {
    this.switchIfLow();
    const threat = this.threat();
    if (this.t < this.evadeUntil) {
      this.hold(this.evadeKeys);
      this.evadeDodge();
      this.step();
      return;
    }
    if (threat !== null) {
      this.cameraYaw = yawFromDir(threat.x - this.pos.x, threat.z - this.pos.z);
      this.evadeKeys = [this.evadeKey()];
      this.evadeUntil = this.t + 0.45;
      this.dodged = false;
      this.hold(this.evadeKeys);
      this.evadeDodge();
      this.step();
      return;
    }
    const d = flat(this.pos, target);
    this.cameraYaw = yawFromDir(target.x - this.pos.x, target.z - this.pos.z);
    this.hold(d > 2.0 ? ['KeyW'] : []);
    if (d < 2.8 && this.ticks % 4 === 0) this.tap('Mouse0');
    this.step();
  }

  /**
   * One Dodge per evasion, pressed only once the attack in progress lets movement through (before that the
   * Dodge would take the character's back instead of the held direction).
   */
  private evadeDodge(): void {
    if (this.sim.player.state.mode === 'dodge') this.dodged = true;
    if (!this.dodged && !this.sim.combat.locksMovement && this.ticks % 2 === 0) this.tap('Mouse2');
  }

  /** Back (S) off the ground; on a platform the one of S / A / D that stays nearest its centre. */
  private evadeKey(): MoveKey {
    const a = this.anchor;
    if (a === null) return 'KeyS';
    const yaw = this.cameraYaw;
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    // Camera-relative directions (player/controllerInput cameraRelativeMove): back, left, right.
    const options: [MoveKey, number, number][] = [['KeyS', -s, -c], ['KeyA', c, -s], ['KeyD', -c, s]];
    let best: MoveKey = 'KeyS';
    let bestD = Infinity;
    for (const [key, dx, dz] of options) {
      const d = Math.hypot(this.pos.x + dx * 4 - a.x, this.pos.z + dz * 4 - a.z);
      if (d < bestD) {
        bestD = d;
        best = key;
      }
    }
    return best;
  }

  /** Living enemies for failure messages. */
  enemyReport(): string {
    return [...this.sim.runtime.enemies.values()]
      .filter((e) => e.state !== 'dead')
      .map((e) => `${e.id}@(${e.pos.x.toFixed(1)},${e.pos.y.toFixed(1)},${e.pos.z.toFixed(1)}) ${e.state} ${e.hp}hp`)
      .join('; ');
  }

  /** Position of an enemy within 3.4 m whose attack Telegraph has just started, else null. */
  private threat(): Readonly<Vec3> | null {
    for (const e of this.sim.runtime.enemies.values()) {
      const first = e.attack?.def.hits[0];
      if (e.state !== 'attack' || e.attack === null || first === undefined || e.attack.t >= first.t - 0.03) continue;
      if (flat(this.pos, e.pos) <= 3.4) return e.pos;
    }
    return null;
  }
}
