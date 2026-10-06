// Cinematic_System (design "Cinematics·Debug·Test Harness" 재생 규칙; Req 7.2, 21.9–21.11). Plays the CinematicDefs of
// src/data/cinematics.ts from their triggers:
//   'landmark:discovered' → cin_landmark_*, a first Challenge_Area 'area:entered' → cin_area_*, 'party:joined' →
//   cin_join_*, 'skyshard:acquired' → cin_skyshard_<n>, 'altar:activated' → cin_altar, 'boss:phaseChanged' →
//   cin_boss_phase<n>, 'boss:defeated' → cin_ending, and `play(id)` for the others (PlaySim plays cin_boss_intro on the
//   arena's first entry, the quests' `startCinematic`).
//
// - Start: the playback lives in RuntimeState.cinematic; 'cinematic:started' goes out (`skippableAfter` 1 s, Infinity
//   when not skippable) and onChange(id) lets the session hide the HUD, release the pointer lock and switch the input
//   context and PauseMode to 'cinematic'. While `playing`, PlaySim holds player input and freezes enemies, hazards,
//   the boss and damage (Req 21.10). A request made while one plays is queued and starts as soon as it ends.
// - Once: a 'perSave' id is recorded in GameState.cinematicsSeen when it starts and never plays again in that save;
//   'perFight' ids (Phase transitions) are kept in a set cleared by resetFight() and on every Party_Wipe (the retry
//   begins a new fight).
// - Timeline: tick(dt) (the sim tick, so headless runs are deterministic) advances `t` and fires the events that are
//   due: `worldChange` / `timeOfDay` as 'cinematic:event' on the bus, `title` / `sfx` / `music` / `vfx` to onCue.
// - Skip (skippable = longer than 3 s): from 1 s after the start, holding `pause` (Esc, Start) or `jump` (Space, A)
//   for 1 s skips; a key already down when the cinematic started counts only after it was released once, and letting
//   go before 1 s empties the gauge. Skipping moves `t` to the end and applies every remaining `worldChange` /
//   `timeOfDay` event in time order (the last `music` too; titles, sounds and VFX are dropped), so the World ends as
//   if it had been watched; 'cinematic:ended' says `skipped: true`.
// - End: 'cinematic:ended' and onChange(next or null) in the same tick; PlaySim still holds input on that tick and
//   gives control back on the next one (≤ 1/60 s, within the 0.3 s of Req 21.10).
// - Camera: cameraPose() evaluates the shot at `t` (plus a render look-ahead) relative to its anchor; entity anchors
//   (the Active_Character, Caelith) are followed with their axes latched at the shot's first evaluation.
// Pure TypeScript: no three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import { clamp01, lerp, yawFromDir } from '../core/math';
import type { Vec3 } from '../core/types';
import {
  CINEMATIC_SKIP_AFTER, CINEMATIC_SKIP_HOLD, CINEMATIC_TITLE_SECONDS, CINEMATIC_TITLES, CINEMATIC_TRIGGERS, CINEMATICS,
  staticAnchorOrigin, type CinematicAnchor, type CinematicDef, type CinematicEvent, type ShotEase,
} from '../data/cinematics';
import type { CinematicId } from '../data/ids';
import type { RuntimeState } from '../save/runtimeState';

/** The skip keys as InputState reads them (`pause`: Esc / Start, `jump`: Space / A). */
export interface CinematicSkipInput {
  down(action: 'pause' | 'jump'): boolean;
}

/** An entity anchor's feet and facing (core/math yaw). */
export interface AnchorFrame {
  readonly pos: Readonly<Vec3>;
  readonly yaw: number;
}

/** Resolves the entity anchors; null when the entity is not there (the shot then falls back to world axes at 0). */
export type AnchorResolver = (anchor: 'player' | 'caelith') => AnchorFrame | null;

/** A presentation cue fired on the timeline (not on a skip, except the last `music`). */
export interface CinematicCue {
  readonly cinematicId: CinematicId;
  readonly kind: 'title' | 'sfx' | 'music' | 'vfx';
  readonly data: string;
}

/** What the render camera shows this frame. */
export interface CinematicCameraPose {
  readonly position: Vec3;
  readonly lookAt: Vec3;
  readonly fov: number;
}

/** What the cinematic overlay draws (letterbox, title card, skip hint and gauge). */
export interface CinematicView {
  readonly id: CinematicId;
  readonly t: number;
  readonly duration: number;
  readonly letterbox: boolean;
  readonly skippable: boolean;
  /** The skip hint shows (skippable and 1 s in). */
  readonly skipAvailable: boolean;
  /** Skip gauge 0..1. */
  readonly skipProgress: number;
  readonly title: { readonly title: string; readonly subtitle: string } | null;
}

export interface CinematicPlayerOptions {
  bus: GameEventBus;
  runtime: Pick<RuntimeState, 'cinematic'>;
  /** GameState.cinematicsSeen (appended to). */
  seen: string[];
  /** This tick's skip keys; omitted: nothing is ever skipped. */
  input?: CinematicSkipInput;
  /** Definitions (default CINEMATICS). */
  defs?: Readonly<Record<string, CinematicDef>>;
  /** Playback began (the id) or ended with nothing queued (null). */
  onChange?(playing: CinematicId | null): void;
  onCue?(cue: CinematicCue): void;
}

const TIME_EPS = 1e-9;
/** An id without a definition (a quest `startCinematic` typo) still starts and ends, as a 1 s hold. */
const FALLBACK_SECONDS = 1;

function fallbackDef(id: CinematicId): CinematicDef {
  return { id, duration: FALLBACK_SECONDS, letterbox: false, skippable: false, shots: [], events: [], once: 'perSave' };
}

export function ease(kind: ShotEase, u: number): number {
  const x = clamp01(u);
  if (kind === 'inOut') return x * x * (3 - 2 * x);
  if (kind === 'out') return 1 - (1 - x) * (1 - x);
  return x;
}

/** `v` turned about +Y by `yaw` (local +z becomes the facing direction { sin yaw, 0, cos yaw }). */
function rotate(v: Readonly<Vec3>, yaw: number): Vec3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}

export class CinematicPlayer {
  private readonly o: CinematicPlayerOptions;
  private readonly defs: Readonly<Record<string, CinematicDef>>;
  private readonly queue: CinematicId[] = [];
  private readonly fightSeen = new Set<string>();
  private readonly unsubscribe: (() => void)[];
  private current: CinematicDef | null = null;
  /** A skip key was down when the playback started: it counts only after a release. */
  private skipBlocked = false;
  /** Frame yaw per shot index, latched at the shot's first evaluation. */
  private readonly latched = new Map<number, number>();
  private lastTitle: { key: string; t: number } | null = null;

  constructor(options: CinematicPlayerOptions) {
    this.o = options;
    this.defs = options.defs ?? CINEMATICS;
    const { bus } = options;
    const play = (id: CinematicId | null): void => {
      if (id !== null) this.play(id);
    };
    this.unsubscribe = [
      bus.on('landmark:discovered', (p) => play(CINEMATIC_TRIGGERS.landmark(p.landmarkId))),
      bus.on('area:entered', (p) => play(CINEMATIC_TRIGGERS.area(p.areaId, p.first))),
      bus.on('party:joined', (p) => play(CINEMATIC_TRIGGERS.join(p.characterId))),
      bus.on('skyshard:acquired', (p) => play(CINEMATIC_TRIGGERS.skyshard(p.index))),
      bus.on('altar:activated', () => play(CINEMATIC_TRIGGERS.altar())),
      bus.on('boss:phaseChanged', (p) => play(CINEMATIC_TRIGGERS.phase(p.to))),
      bus.on('boss:defeated', () => play(CINEMATIC_TRIGGERS.ending())),
      bus.on('party:wipe', () => this.resetFight()),
    ];
  }

  /** The cinematic playing now, or null. */
  get playing(): CinematicId | null {
    return this.o.runtime.cinematic?.id ?? null;
  }

  /** Definition of the one playing, or null. */
  get def(): CinematicDef | null {
    return this.playing === null ? null : this.current;
  }

  /** Waiting to play after the current one. */
  get queued(): readonly CinematicId[] {
    return this.queue;
  }

  /** Starts `id` now, or after the one playing; refused when its `once` rule says it was already played. */
  play(id: CinematicId): void {
    if (this.playing === id || this.queue.includes(id) || this.alreadyPlayed(id)) return;
    if (this.playing !== null) {
      this.queue.push(id);
      return;
    }
    this.start(id);
  }

  /** A new Caelith fight (Boss_Encounter begin, a retry): its Phase transitions may play again. */
  resetFight(): void {
    this.fightSeen.clear();
  }

  /** Advances the playback by `dt` sim seconds: due events, the skip hold, the end (and the next in the queue). */
  tick(dt: number): void {
    const run = this.o.runtime.cinematic;
    const def = this.current;
    if (run === null || def === null || !(Number.isFinite(dt) && dt > 0)) return;
    run.t = Math.min(def.duration, run.t + dt);
    this.fireDue(run.t);
    if (this.skipHeld(dt) && run.skipHold >= CINEMATIC_SKIP_HOLD - TIME_EPS) {
      this.skip();
      return;
    }
    if (run.t >= def.duration - TIME_EPS) this.end(false);
  }

  /** The overlay's model, or null while nothing plays. */
  view(): CinematicView | null {
    const run = this.o.runtime.cinematic;
    const def = this.current;
    if (run === null || def === null) return null;
    const last = this.lastTitle;
    const title = last !== null && run.t - last.t < CINEMATIC_TITLE_SECONDS ? (CINEMATIC_TITLES[last.key] ?? null) : null;
    return {
      id: run.id,
      t: run.t,
      duration: def.duration,
      letterbox: def.letterbox,
      skippable: def.skippable,
      skipAvailable: def.skippable && run.t >= CINEMATIC_SKIP_AFTER - TIME_EPS,
      skipProgress: clamp01(run.skipHold / CINEMATIC_SKIP_HOLD),
      title,
    };
  }

  /**
   * The camera pose at the playback time plus `ahead` s (render interpolation), relative to the shot's anchor; null
   * while nothing plays or the cinematic has no shots.
   */
  cameraPose(resolve: AnchorResolver, ahead = 0): CinematicCameraPose | null {
    const run = this.o.runtime.cinematic;
    const def = this.current;
    if (run === null || def === null || def.shots.length === 0) return null;
    const t = Math.min(def.duration, Math.max(0, run.t + (Number.isFinite(ahead) ? ahead : 0)));
    let index = 0;
    for (let i = 0; i < def.shots.length; i++) if ((def.shots[i]?.t0 ?? Infinity) <= t + TIME_EPS) index = i;
    const shot = def.shots[index];
    if (shot === undefined) return null;
    const span = shot.t1 - shot.t0;
    const k = ease(shot.ease, span > 0 ? (t - shot.t0) / span : 1);
    const originOf = (anchor: CinematicAnchor | undefined): { pos: Vec3; yaw: number } => {
      if (anchor === undefined) return { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
      const fixed = staticAnchorOrigin(anchor);
      if (fixed !== null) return { pos: fixed, yaw: 0 };
      const frame = resolve(anchor as 'player' | 'caelith');
      return frame === null ? { pos: { x: 0, y: 0, z: 0 }, yaw: 0 } : { pos: { ...frame.pos }, yaw: frame.yaw };
    };
    const base = originOf(shot.anchor);
    const lookBase = shot.lookAnchor === undefined ? base : originOf(shot.lookAnchor);
    let yaw = this.latched.get(index);
    if (yaw === undefined) {
      if (shot.face !== undefined) {
        const target = originOf(shot.face).pos;
        const dx = target.x - base.pos.x;
        const dz = target.z - base.pos.z;
        yaw = Math.hypot(dx, dz) > 1e-6 ? yawFromDir(dx, dz) : base.yaw;
      } else {
        yaw = base.yaw;
      }
      this.latched.set(index, yaw);
    }
    const mix = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k) });
    const pos = rotate(mix(shot.from.pos, shot.to.pos), yaw);
    const look = rotate(mix(shot.from.look, shot.to.look), yaw);
    return {
      position: { x: base.pos.x + pos.x, y: base.pos.y + pos.y, z: base.pos.z + pos.z },
      lookAt: { x: lookBase.pos.x + look.x, y: lookBase.pos.y + look.y, z: lookBase.pos.z + look.z },
      fov: lerp(shot.from.fov, shot.to.fov, k),
    };
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private defOf(id: CinematicId): CinematicDef {
    return this.defs[id] ?? fallbackDef(id);
  }

  private alreadyPlayed(id: CinematicId): boolean {
    const def = this.defOf(id);
    return def.once === 'perSave' ? this.o.seen.includes(id) : this.fightSeen.has(id);
  }

  private start(id: CinematicId): void {
    const def = this.defOf(id);
    this.current = def;
    this.latched.clear();
    this.lastTitle = null;
    this.o.runtime.cinematic = { id, t: 0, nextEvent: 0, skipHold: 0 };
    if (def.once === 'perSave') {
      if (!this.o.seen.includes(id)) this.o.seen.push(id);
    } else {
      this.fightSeen.add(id);
    }
    const input = this.o.input;
    this.skipBlocked = input !== undefined && (input.down('pause') || input.down('jump'));
    this.o.bus.emit('cinematic:started', { cinematicId: id, skippableAfter: def.skippable ? CINEMATIC_SKIP_AFTER : Infinity });
    this.o.onChange?.(id);
    this.fireDue(0);
  }

  /** Fires the events due at `t` in order. */
  private fireDue(t: number): void {
    const run = this.o.runtime.cinematic;
    const def = this.current;
    if (run === null || def === null) return;
    while (run.nextEvent < def.events.length) {
      const e = def.events[run.nextEvent];
      if (e === undefined || e.t > t + TIME_EPS) break;
      run.nextEvent++;
      this.fire(run.id, e);
    }
  }

  private fire(id: CinematicId, e: CinematicEvent): void {
    if (e.kind === 'worldChange' || e.kind === 'timeOfDay') {
      this.o.bus.emit('cinematic:event', { cinematicId: id, kind: e.kind, key: e.data });
      return;
    }
    if (e.kind === 'title') this.lastTitle = { key: e.data, t: e.t };
    this.o.onCue?.({ cinematicId: id, kind: e.kind, data: e.data });
  }

  /** Counts this tick into the skip hold; whether a skip key is held and counting. */
  private skipHeld(dt: number): boolean {
    const run = this.o.runtime.cinematic;
    const def = this.current;
    const input = this.o.input;
    if (run === null || def === null || input === undefined || !def.skippable) return false;
    const down = input.down('pause') || input.down('jump');
    if (this.skipBlocked) {
      if (!down) this.skipBlocked = false;
      run.skipHold = 0;
      return false;
    }
    if (!down) {
      run.skipHold = 0; // let go before 1 s: the gauge empties
      return false;
    }
    if (run.t < CINEMATIC_SKIP_AFTER - TIME_EPS) return false; // held early: counting starts at 1 s
    // The first counted tick counts only the part of it after the 1 s mark.
    const counted = Math.min(dt, run.t - CINEMATIC_SKIP_AFTER);
    run.skipHold += Math.max(0, counted);
    return true;
  }

  /** Jumps to the end: every remaining worldChange / timeOfDay in order, the last music, then 'cinematic:ended'. */
  private skip(): void {
    const run = this.o.runtime.cinematic;
    const def = this.current;
    if (run === null || def === null) return;
    let music: CinematicEvent | null = null;
    for (let i = run.nextEvent; i < def.events.length; i++) {
      const e = def.events[i];
      if (e === undefined) continue;
      if (e.kind === 'worldChange' || e.kind === 'timeOfDay') this.o.bus.emit('cinematic:event', { cinematicId: run.id, kind: e.kind, key: e.data });
      else if (e.kind === 'music') music = e;
    }
    run.nextEvent = def.events.length;
    run.t = def.duration;
    if (music !== null) this.o.onCue?.({ cinematicId: run.id, kind: 'music', data: music.data });
    this.end(true);
  }

  private end(skipped: boolean): void {
    const run = this.o.runtime.cinematic;
    if (run === null) return;
    this.o.runtime.cinematic = null;
    this.current = null;
    this.o.bus.emit('cinematic:ended', { cinematicId: run.id, skipped });
    // The queue's next one that may still play starts at once.
    for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
      if (this.alreadyPlayed(next)) continue;
      this.start(next);
      return;
    }
    this.o.onChange?.(null);
  }
}
