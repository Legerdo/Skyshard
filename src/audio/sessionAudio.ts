/*
 * One play session's sound (task 16.2, 16.3; Req 37.1–37.3, 37.7, 19.8, 19.10, 26.5, 12.4, 5.4): the bridge from a
 * PlaySim to the page's AudioEngine.
 *
 * - Bus events → sound effects: movement, the characters' switches, hits, Downed and Perfect_Dodge, the six
 *   Reactions, the enemies' alert / attack-ready (with the Telegraph's start) / hit / death, the boss, the
 *   refusal, rewards and progress, and each dialogue window's voice blip at the speaker's own semitone.
 * - Controller sinks (called by the GameSession): footsteps by material, the swim-entry splash, the glide wind.
 * - Every render frame: the listener (render camera), the MusicDirector's target from the situation (Victory >
 *   the Caelith fight's Phase > In_Combat or an 'enemy:alerted' this frame > the place), the ambient bed, the
 *   attack / climb / dodge sounds from the playing action and movement mode, the Burst-ready chime, and ~15 Hz
 *   updates of the Updraft and Wind_Zone loops at their closest point to the listener.
 */

import * as THREE from 'three';
import type { BossState } from '../boss/bossSnapshot';
import { CAELITH_ENTITY_ID } from '../boss/bossEncounter';
import type { PlayingKind } from '../combat/playerCombat';
import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import { CHARACTERS } from '../data/characters';
import type { ChallengeAreaId, CharacterId, EliteId, EnemyId, EntityId, RegionId, SfxId } from '../data/ids';
import { REACTION_PRESENTATION } from '../data/reactions';
import type { AirVolumeDef, VolumeShape } from '../data/volumes';
import { hashString } from '../core/rng';
import type { SurfaceMaterial } from '../physics/types';
import type { MoveMode } from '../player/core/types';
import type { VolumeIndex } from '../world/volumeIndex';
import type { AmbientId } from './ambient';
import type { AudioEngine, LoopEmitter } from './audioEngine';
import { MusicDirector } from './musicDirector';
import { characterSfx, enemySfx, footstepSfx, type FootstepMaterial } from './sfxRecipes';
import { voicePitchHz } from './voicePitch';

/** What the session audio reads from the simulation (PlaySim satisfies it). */
export interface SessionAudioSim {
  readonly bus: GameEventBus;
  readonly gameState: { readonly altarActivated: boolean; readonly party: { readonly active: CharacterId } };
  readonly runtime: {
    readonly inCombat: boolean;
    readonly enemies: ReadonlyMap<EntityId, { readonly def: EnemyId | EliteId; readonly pos: Readonly<Vec3> }>;
    readonly energy: Readonly<Record<CharacterId, number>>;
  };
  readonly player: { readonly state: { readonly pos: Readonly<Vec3>; readonly mode: MoveMode } };
  readonly combat: { readonly attackKind: PlayingKind | null; readonly comboStep: number };
  readonly boss: {
    readonly state: BossState;
    snapshot(): {
      readonly music: 'mus_boss_p1' | 'mus_boss_p2' | 'mus_boss_p3';
      readonly pos: Readonly<Vec3>;
      readonly telegraphs: readonly unknown[];
      readonly starshellBreaks: number;
    };
  };
  readonly challenge: { readonly current: { readonly id: ChallengeAreaId } | null };
  readonly volumes: Pick<VolumeIndex, 'at' | 'all' | 'version'>;
}

export interface SessionAudioOptions {
  readonly engine: AudioEngine;
  readonly sim: SessionAudioSim;
  /** The render camera: the listener. */
  readonly camera: THREE.Camera;
}

/** Terrain / collider materials → the six footstep sounds. */
const FOOTSTEP_OF: Readonly<Record<SurfaceMaterial, FootstepMaterial>> = {
  grass: 'grass',
  dirt: 'dirt',
  sand: 'dirt',
  snow: 'dirt',
  rock: 'stone',
  ashRock: 'stone',
  stone: 'stone',
  crystal: 'crystal',
  wood: 'wood',
  water: 'water',
};

/** Movement modes that start with a sound. */
const MODE_SFX: Partial<Readonly<Record<MoveMode, SfxId>>> = {
  climbAttach: 'sfx_climb_grab',
  mantle: 'sfx_mantle',
  dodge: 'sfx_dodge',
  glideDeploy: 'sfx_glide_open',
};

/** Seconds between Updraft / Wind_Zone loop updates (about 15 Hz). */
const LOOP_UPDATE_SECONDS = 1 / 15;
/** The Thistlewick area volume (src/data/volumes.ts): the village music inside it. */
const VILLAGE_AREA_ID = 'thistlewick';

/** Loudness of a landing from `fallHeight` m (Req 37.2: "낙하 속도에 비례한 크기"). */
export function landingGain(fallHeight: number): number {
  const h = Number.isFinite(fallHeight) ? Math.max(0, fallHeight) : 0;
  return Math.min(1.3, 0.35 + h * 0.12);
}

/** The point of an air volume closest to `p` (its loop is heard from there). */
export function closestPointInVolume(shape: VolumeShape, p: Readonly<Vec3>): Vec3 {
  const y = Math.min(shape.maxY, Math.max(shape.minY, p.y));
  const dx = p.x - shape.x;
  const dz = p.z - shape.z;
  if (shape.kind === 'cylinder') {
    const d = Math.hypot(dx, dz);
    const k = d > shape.radius && d > 0 ? shape.radius / d : 1;
    return { x: shape.x + dx * k, y, z: shape.z + dz * k };
  }
  // Box-local axes as in volumeContains, clamped, then back to the world.
  const c = Math.cos(shape.yaw);
  const s = Math.sin(shape.yaw);
  const lx = Math.min(shape.halfX, Math.max(-shape.halfX, dx * c - dz * s));
  const lz = Math.min(shape.halfZ, Math.max(-shape.halfZ, dx * s + dz * c));
  return { x: shape.x + lx * c + lz * s, y, z: shape.z - lx * s + lz * c };
}

export class SessionAudio {
  private readonly engine: AudioEngine;
  private readonly sim: SessionAudioSim;
  private readonly camera: THREE.Camera;
  private readonly director = new MusicDirector();
  private readonly forward = new THREE.Vector3();
  private readonly unsubscribe: (() => void)[] = [];
  /** Where each enemy was last hit (a defeated enemy may have left the runtime map when its event arrives). */
  private readonly lastSeen = new Map<EntityId, Vec3>();
  private victory = false;
  private alerted = false;
  private region: RegionId | null = null;
  private lastMode: MoveMode | null = null;
  private lastAttack: PlayingKind | null = null;
  private lastStep = -1;
  private lastActive: CharacterId | null = null;
  private burstReady = false;
  private bossTelegraphs = 0;
  private bossBreaks = 0;
  private loopClock = LOOP_UPDATE_SECONDS;
  private airVersion = -1;
  private air: readonly AirVolumeDef[] = [];
  private disposed = false;

  constructor(o: SessionAudioOptions) {
    this.engine = o.engine;
    this.sim = o.sim;
    this.camera = o.camera;
    const { bus } = o.sim;
    const e = this.engine;
    const feet = (): Readonly<Vec3> => this.sim.player.state.pos;
    const enemyPos = (id: EntityId): Readonly<Vec3> => this.sim.runtime.enemies.get(id)?.pos ?? this.lastSeen.get(id) ?? feet();
    this.unsubscribe.push(
      // Region entries publish the RegionId as the areaId (src/world/worldTriggers.ts).
      bus.on('area:entered', (p) => {
        if (p.areaId === p.regionId) this.region = p.regionId;
      }),
      bus.on('player:jumped', () => e.sfx('sfx_jump', { pos: feet() })),
      bus.on('player:landed', (p) => e.sfx('sfx_land', { pos: feet(), gain: landingGain(p.fallHeight) })),
      bus.on('party:switched', (p) => e.sfx(characterSfx(p.to, 'switch'), { pos: feet() })),
      bus.on('player:damaged', () => e.sfx('sfx_player_hit', { pos: feet() })),
      bus.on('party:downed', () => e.sfx('sfx_downed', { pos: feet() })),
      bus.on('perfectDodge', () => e.sfx('sfx_perfect_dodge', { pos: feet() })),
      bus.on('ability:refused', () => e.sfx('sfx_ui_refuse')),
      bus.on('reaction', (p) => e.sfx(REACTION_PRESENTATION[p.reaction].sfx, { pos: p.position })),
      bus.on('enemy:alerted', (p) => {
        this.alerted = true;
        e.sfx(enemySfx(p.kind, 'alert'), { pos: enemyPos(p.entityId) });
      }),
      // The attack-ready sound starts with the Telegraph (Req 26.5).
      bus.on('enemy:telegraph', (p) => e.sfx(enemySfx(p.kind, 'windup'), { pos: p.position })),
      bus.on('damage:dealt', (p) => {
        if (p.targetId === CAELITH_ENTITY_ID) {
          e.sfx('sfx_boss_hit', { pos: p.position });
        } else {
          const enemy = this.sim.runtime.enemies.get(p.targetId);
          if (enemy !== undefined) {
            this.lastSeen.set(p.targetId, { ...p.position });
            e.sfx(enemySfx(enemy.def, 'hit'), { pos: p.position });
          } else {
            e.sfx('sfx_hit_generic', { pos: p.position });
          }
        }
        if (p.crit) e.sfx('sfx_hit_crit', { pos: p.position });
      }),
      bus.on('enemy:weakSpot', (p) => e.sfx('sfx_weak_spot', { pos: enemyPos(p.entityId) })),
      bus.on('enemy:defeated', (p) => {
        e.sfx(enemySfx(p.kind, 'death'), { pos: enemyPos(p.entityId) });
        this.lastSeen.delete(p.entityId);
      }),
      bus.on('boss:phaseChanged', () => e.sfx('sfx_boss_roar', { pos: this.sim.boss.snapshot().pos })),
      bus.on('boss:defeated', () => {
        this.victory = true;
      }),
      bus.on('chest:opened', (p) => e.sfx(p.tier === 'glowing' ? 'sfx_chest_glowing' : 'sfx_chest_open', { pos: feet() })),
      bus.on('item:granted', (p) => {
        if (p.source !== 'chest' && p.source !== 'quest' && p.source !== 'shop') e.sfx('sfx_pickup');
      }),
      bus.on('landmark:discovered', () => e.sfx('sfx_discovery')),
      bus.on('levelUp', () => e.sfx('sfx_level_up')),
      bus.on('skyshard:acquired', () => e.sfx('sfx_skyshard')),
      bus.on('barrier:opened', () => e.sfx('sfx_barrier_break', { pos: feet() })),
      bus.on('puzzle:progress', () => e.sfx('sfx_puzzle_step')),
      bus.on('puzzle:solved', () => e.sfx('sfx_puzzle_solved')),
      bus.on('puzzle:failed', () => e.sfx('sfx_puzzle_fail')),
      bus.on('waystone:activated', () => e.sfx('sfx_waystone')),
      bus.on('checkpoint:reached', () => e.sfx('sfx_checkpoint')),
      bus.on('altar:activated', () => e.sfx('sfx_altar')),
      bus.on('quest:stageCompleted', () => e.sfx('sfx_quest_complete')),
      // Each dialogue window: a short blip at the speaker's own semitone (Req 37.7).
      bus.on('dialogue:line', (p) => e.voiceBlip(voicePitchHz(p.speaker), hashString(`${p.dialogueId}:${p.line}`))),
    );
  }

  /** The controller's `footstep`: the material's step sound at `pos` (±5 % pitch, ±2 dB per step). */
  footstep(material: SurfaceMaterial, pos: Readonly<Vec3>): void {
    this.engine.sfx(footstepSfx(FOOTSTEP_OF[material] ?? 'dirt'), { pos });
  }

  /** The controller's `enteredWater`: the swim-entry splash. */
  enteredWater(pos: Readonly<Vec3>): void {
    this.engine.sfx('sfx_water_enter', { pos });
  }

  /** Every controller tick: the glide wind loudness, 0 while not gliding (Req 19.10). */
  glideWind(intensity: number): void {
    this.engine.setGlideWind(intensity);
  }

  /** One render frame of `realDt` s; `title` while the Title Screen shows this session's world. */
  update(realDt: number, title: boolean): void {
    if (this.disposed) return;
    const { engine, sim } = this;
    this.camera.getWorldDirection(this.forward);
    engine.setListener({ pos: this.camera.position, forward: this.forward });

    // Music (Req 37.3, 12.4, 5.4).
    const boss = sim.boss;
    const fighting = boss.state !== 'dormant' && boss.state !== 'dead';
    const snapshot = fighting ? boss.snapshot() : null;
    const feet = sim.player.state.pos;
    const challengeArea = sim.challenge.current?.id ?? null;
    const village = challengeArea === null && sim.volumes.at(feet, 'area').some((v) => v.id === VILLAGE_AREA_ID);
    const cue = this.director.update(realDt, {
      title,
      victory: this.victory,
      bossTrack: snapshot?.music ?? null,
      inCombat: !title && (sim.runtime.inCombat || this.alerted),
      region: this.region,
      challengeArea,
      village,
      altarActivated: sim.gameState.altarActivated,
    });
    this.alerted = false;
    if (cue !== null) engine.playMusic(cue.track, cue.fadeSec);

    // Ambient bed: the Region's, 'interior' inside a Challenge_Area; the Title's world is Thistlewick.
    const ambient: AmbientId = title || this.region === null ? 'verdant' : challengeArea !== null ? 'interior' : this.region;
    engine.setAmbient(ambient);

    if (title) {
      this.lastMode = sim.player.state.mode;
      return;
    }
    this.actionSounds(feet);
    if (snapshot !== null) {
      if (snapshot.telegraphs.length > this.bossTelegraphs) engine.sfx('sfx_boss_windup', { pos: snapshot.pos });
      if (snapshot.starshellBreaks > this.bossBreaks) engine.sfx('sfx_boss_shell_break', { pos: snapshot.pos });
      this.bossTelegraphs = snapshot.telegraphs.length;
      this.bossBreaks = snapshot.starshellBreaks;
    }

    // Updraft / Wind_Zone loops at their closest point, about 15 times a second (Req 19.8).
    this.loopClock += Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    if (this.loopClock >= LOOP_UPDATE_SECONDS) {
      this.loopClock = 0;
      engine.setLoops(this.airEmitters());
    }
  }

  /** Attack / Skill / Burst swings, climb, mantle, dodge and glide-open, and the Burst-ready chime. */
  private actionSounds(feet: Readonly<Vec3>): void {
    const { engine, sim } = this;
    const mode = sim.player.state.mode;
    if (mode !== this.lastMode) {
      const id = MODE_SFX[mode];
      if (id !== undefined) engine.sfx(id, { pos: feet });
      this.lastMode = mode;
    }
    const active = sim.gameState.party.active;
    const { attackKind, comboStep } = sim.combat;
    if (attackKind !== null && (attackKind !== this.lastAttack || comboStep !== this.lastStep)) {
      const sound = attackKind === 'skill' ? 'skill' : attackKind === 'burst' ? 'burst' : 'attack';
      engine.sfx(characterSfx(active, sound), { pos: feet });
    }
    this.lastAttack = attackKind;
    this.lastStep = comboStep;
    // Burst ready (Req 32.7): the Active_Character's Energy reaches its cost; a switch only re-reads it.
    const ready = sim.runtime.energy[active] >= CHARACTERS[active].burst.energyCost;
    if (ready && !this.burstReady && this.lastActive === active) engine.sfx('sfx_burst_ready');
    this.burstReady = ready;
    this.lastActive = active;
  }

  private airEmitters(): LoopEmitter[] {
    const { volumes } = this.sim;
    if (volumes.version !== this.airVersion) {
      this.airVersion = volumes.version;
      this.air = [...volumes.all('updraft'), ...volumes.all('windZone')];
    }
    const listener = this.camera.position;
    return this.air.map((v) => ({
      key: `${v.kind}:${v.id}`,
      id: v.kind === 'updraft' ? 'sfx_updraft_loop' : 'sfx_wind_zone_loop',
      pos: closestPointInVolume(v.shape, listener),
    }));
  }

  /** Stops listening and ends this session's loops (the music and bed carry over to the next session). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe.splice(0)) off();
    this.engine.setGlideWind(0);
    this.engine.setLoops([]);
  }
}
