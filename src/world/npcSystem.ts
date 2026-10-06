// NPC placement and behaviour (design.md "NPC 행동", task 13.2; Req 14.2, 14.3, 14.4, 14.9). Headless: the NPCs'
// positions, facings and animation states live here and the temporary view (src/render/tempVillageView.ts) mirrors
// them.
// - Every NPC alternates its idle and an ambient behaviour (src/data/village.ts NPC_PLACEMENTS): idle and in-place
//   phases last the next of its 8–15 s durations; a walk (Maren plaza ↔ door, Hobb along a furrow) or a run round the
//   well (Tamsin) lasts its way. A walking NPC stops while the player is within 2.5 m, so the prompt target holds
//   still (Req 14.3).
// - Talking: beginTalk turns the NPC toward the player, fast enough to face any direction within 0.5 s (Req 14.4), and
//   holds its behaviour; endTalk ('dialogue:ended') lets it turn back and go on where it stopped.
// - From Skyshard 3 on (and after the ending) the five villagers stand at their plaza-rim spots facing the Astral
//   Sanctum and alternate idle and looking round (the village stage is recomputed from GameState every tick, so a
//   load shows the same, Req 14.8).
// - Companions (Isla, Wren, Talus) stand at their Main_Quest talk spots until they join, then are gone.
// NPCs have no solid body (the final rigs, tasks 18.4 / 19.3, may add one). Pure TypeScript: no three.js / DOM.

import { angleDelta, wrapAngle, yawFromDir } from '../core/math';
import type { Vec3 } from '../core/types';
import { speakerName, type Speaker } from '../data/dialogue';
import {
  NPC_HEIGHT, NPC_PLACEMENTS, NPC_RADIUS, NPC_STOP_RADIUS, SANCTUM_SIGHT_TARGET, type NpcAnim, type NpcPlacementDef,
} from '../data/village';
import type { XZ } from '../data/worldLayout';
import { villageLook } from '../logic/village';
import type { GameState } from '../logic/save/gameState';
import type { InteractTarget } from '../player/interaction';

/** Turn rate (rad/s): half a turn in 0.5 s, so any facing is reached within 0.5 s (Req 14.4). */
export const NPC_TURN_RATE = Math.PI / 0.5;
/** Vertical reach of the stop rule: the player must stand about on the NPC's level (m). */
const STOP_VERTICAL = 2;
const ARRIVE_EPS = 0.05;

/** What the view draws for one NPC. */
export interface NpcView {
  readonly id: Speaker;
  readonly pos: Readonly<Vec3>;
  readonly yaw: number;
  readonly anim: NpcAnim;
  /** Standing in the world (a joined companion is not). */
  readonly present: boolean;
  readonly talking: boolean;
}

interface NpcRuntime {
  readonly def: NpcPlacementDef;
  /** Live position (targets and views read the same object). */
  readonly pos: Vec3;
  yaw: number;
  anim: NpcAnim;
  phase: 'idle' | 'ambient';
  /** Seconds left of a timed phase. */
  timer: number;
  /** Next entry of `durations` and of `idle`. */
  durationIndex: number;
  idleIndex: number;
  /** Walk ambient: whether the NPC is at (or heading to) the far end. */
  away: boolean;
  /** Loop ambient: next point. */
  loopIndex: number;
  gathered: boolean;
  talking: boolean;
  talkYaw: number;
  paused: boolean;
}

export interface NpcSystemOptions {
  /** Read: the Skyshards, the completion record and the party joins. */
  state: GameState;
  heightAt: (x: number, z: number) => number;
  /** Default NPC_PLACEMENTS. */
  placements?: readonly NpcPlacementDef[];
}

const flat = (a: XZ, b: XZ): number => Math.hypot(a.x - b.x, a.z - b.z);
const facing = (from: XZ, to: XZ): number => yawFromDir(to.x - from.x, to.z - from.z);

export class NpcSystem {
  private readonly o: NpcSystemOptions;
  private readonly npcs: NpcRuntime[];

  constructor(options: NpcSystemOptions) {
    this.o = options;
    this.npcs = (options.placements ?? NPC_PLACEMENTS).map((def) => {
      const rt: NpcRuntime = {
        def, pos: { x: def.home.x, y: 0, z: def.home.z }, yaw: def.yaw, anim: def.idle[0] ?? 'idle', phase: 'idle', timer: 0,
        durationIndex: 0, idleIndex: 0, away: false, loopIndex: 0, gathered: false, talking: false, talkYaw: def.yaw, paused: false,
      };
      this.placeHome(rt, this.shouldGather(def));
      return rt;
    });
  }

  /** Every NPC's live position (a stable object that moves in place), or null for an unknown id. */
  position(id: Speaker): Readonly<Vec3> | null {
    return this.find(id)?.pos ?? null;
  }

  /** Whether `id` stands in the world now. */
  present(id: Speaker): boolean {
    const rt = this.find(id);
    return rt !== undefined && this.isPresent(rt);
  }

  views(): NpcView[] {
    return this.npcs.map((rt) => ({ id: rt.def.id, pos: rt.pos, yaw: rt.yaw, anim: rt.anim, present: this.isPresent(rt), talking: rt.talking }));
  }

  /** The NPCs as interaction targets: name, role and "대화하기" on the prompt (Req 14.3). */
  interactTargets(): InteractTarget[] {
    return this.npcs.map((rt): InteractTarget => ({
      kind: 'npc', id: rt.def.id, name: speakerName(rt.def.id), radius: NPC_RADIUS, height: NPC_HEIGHT,
      get a(): Readonly<Vec3> {
        return rt.pos;
      },
      get b(): Readonly<Vec3> {
        return rt.pos;
      },
      detail: () => `${rt.def.role} · 대화하기`,
      available: () => this.isPresent(rt),
    }));
  }

  /** A dialogue with `id` starts: it turns to face `player` (within 0.5 s) and holds its behaviour. */
  beginTalk(id: Speaker, player: Readonly<Vec3>): void {
    const rt = this.find(id);
    if (rt === undefined) return;
    rt.talking = true;
    rt.talkYaw = facing(rt.pos, player);
    rt.anim = 'idle';
  }

  /** The dialogue ended: back to its own facing and behaviour, where it stopped. */
  endTalk(id: Speaker): void {
    const rt = this.find(id);
    if (rt !== undefined) rt.talking = false;
  }

  /** One sim tick: gathering by the village stage, behaviour phases, walking (stopping near `player`) and turning. */
  tick(dt: number, player: Readonly<Vec3> | null): void {
    for (const rt of this.npcs) {
      const gather = this.shouldGather(rt.def);
      if (gather !== rt.gathered) this.placeHome(rt, gather);
      if (!this.isPresent(rt)) continue;
      let target = rt.yaw;
      if (rt.talking) target = rt.talkYaw;
      else target = this.behave(rt, dt, player);
      rt.yaw = turnToward(rt.yaw, target, NPC_TURN_RATE * dt);
    }
  }

  private find(id: Speaker): NpcRuntime | undefined {
    return this.npcs.find((n) => n.def.id === id);
  }

  private isPresent(rt: NpcRuntime): boolean {
    const joins = rt.def.joins;
    return joins === undefined || !this.o.state.party.joined.includes(joins);
  }

  /** Villagers with a plaza-rim spot gather there from Skyshard 3 on (and after the ending). */
  private shouldGather(def: NpcPlacementDef): boolean {
    return def.gather !== undefined && villageLook(this.o.state).villagersGathered;
  }

  /** Puts the NPC at its home (or its rim spot when gathered) and starts its first idle phase. */
  private placeHome(rt: NpcRuntime, gathered: boolean): void {
    rt.gathered = gathered;
    const spot = gathered && rt.def.gather !== undefined ? rt.def.gather : rt.def.home;
    this.moveTo(rt, spot);
    rt.yaw = this.homeYaw(rt);
    rt.away = false;
    rt.loopIndex = 0;
    rt.durationIndex = 0;
    rt.idleIndex = 0;
    this.startIdle(rt);
  }

  private moveTo(rt: NpcRuntime, p: XZ): void {
    rt.pos.x = p.x;
    rt.pos.z = p.z;
    const fixed = rt.gathered ? undefined : rt.def.home.y;
    rt.pos.y = fixed ?? this.o.heightAt(p.x, p.z);
  }

  /** Facing at the home spot: the data's, or toward the Sanctum when gathered. */
  private homeYaw(rt: NpcRuntime): number {
    return rt.gathered ? facing(rt.pos, SANCTUM_SIGHT_TARGET) : rt.def.yaw;
  }

  private nextDuration(rt: NpcRuntime): number {
    const list = rt.def.durations;
    const d = list[rt.durationIndex % list.length] ?? 10;
    rt.durationIndex++;
    return d;
  }

  private startIdle(rt: NpcRuntime): void {
    rt.phase = 'idle';
    rt.timer = this.nextDuration(rt);
    const idles = rt.gathered ? (['idle'] as const) : rt.def.idle;
    rt.anim = idles[rt.idleIndex % idles.length] ?? 'idle';
    rt.idleIndex++;
  }

  private startAmbient(rt: NpcRuntime): void {
    rt.phase = 'ambient';
    const amb = rt.def.ambient;
    if (rt.gathered) {
      rt.anim = 'lookAround';
      rt.timer = this.nextDuration(rt);
      return;
    }
    rt.anim = amb.anim;
    if (amb.kind === 'inPlace') rt.timer = this.nextDuration(rt);
    else if (amb.kind === 'walk') rt.away = !rt.away;
    else rt.loopIndex = 0;
  }

  /** Advances the phase and returns the facing to turn toward. */
  private behave(rt: NpcRuntime, dt: number, player: Readonly<Vec3> | null): number {
    const amb = rt.def.ambient;
    const moving = rt.phase === 'ambient' && !rt.gathered && amb.kind !== 'inPlace';
    rt.paused = moving && player !== null && flat(player, rt.pos) <= NPC_STOP_RADIUS && Math.abs(player.y - rt.pos.y) <= STOP_VERTICAL;
    if (rt.paused) {
      rt.anim = 'idle';
      return rt.yaw;
    }
    if (rt.phase === 'idle') {
      rt.timer -= dt;
      if (rt.timer <= 0) this.startAmbient(rt);
      return this.idleYaw(rt);
    }
    if (rt.gathered || amb.kind === 'inPlace') {
      rt.timer -= dt;
      const yaw = rt.gathered ? this.homeYaw(rt) : amb.kind === 'inPlace' && amb.face !== undefined ? facing(rt.pos, amb.face) : rt.def.yaw;
      if (rt.timer <= 0) this.startIdle(rt);
      return yaw;
    }
    rt.anim = amb.anim;
    const goal = amb.kind === 'walk' ? (rt.away ? amb.to : rt.def.home) : (amb.points[rt.loopIndex] ?? rt.def.home);
    const yaw = this.step(rt, goal, amb.speed * dt);
    if (flat(rt.pos, goal) <= ARRIVE_EPS) {
      if (amb.kind === 'walk') this.startIdle(rt);
      else if (rt.loopIndex + 1 < amb.points.length) rt.loopIndex++;
      else {
        this.moveTo(rt, rt.def.home);
        this.startIdle(rt);
      }
    }
    return yaw;
  }

  /** Facing while idle: pointing at its target, at the far end back toward home, else the home facing. */
  private idleYaw(rt: NpcRuntime): number {
    if (rt.gathered) return this.homeYaw(rt);
    if (rt.anim === 'point' && rt.def.pointAt !== undefined) return facing(rt.pos, rt.def.pointAt);
    if (rt.def.ambient.kind === 'walk' && rt.away) return facing(rt.pos, rt.def.home);
    return rt.def.yaw;
  }

  /** Moves at most `max` m toward `goal` on the ground; returns the heading. */
  private step(rt: NpcRuntime, goal: XZ, max: number): number {
    const d = flat(rt.pos, goal);
    const yaw = d > 1e-6 ? facing(rt.pos, goal) : rt.yaw;
    const k = d <= max ? 1 : max / d;
    this.moveTo(rt, { x: rt.pos.x + (goal.x - rt.pos.x) * k, z: rt.pos.z + (goal.z - rt.pos.z) * k });
    return yaw;
  }
}

/** Turns `from` toward `to` along the shorter arc by at most `maxStep` rad. */
export function turnToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  return Math.abs(d) <= maxStep ? wrapAngle(to) : wrapAngle(from + Math.sign(d) * maxStep);
}
