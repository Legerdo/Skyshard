// VfxSystem (design "VFX 시스템", "Telegraph 표시", "타격 피드백", "속성·반응별 연출", "월드·진행 연출"; Req 26.1,
// 26.2, 26.5–26.9, 25.9, 23.7, 24.9, 10.6, 38.6). Owns every combat and progress effect of a session:
// - listens to the bus: 'reaction', 'element:applied', 'damage:dealt' (numbers), 'party:switched', 'perfectDodge',
//   'burst:cast', 'chest:opened', 'skyshard:acquired', 'barrier:opened', 'altar:activated', 'levelUp',
//   'enemy:defeated' and 'player:damaged' (the hit on the Active_Character);
// - takes each party hit directly through `onHit` (Combat_System hook, no event): hit flash, 35° impact cone;
// - reads each frame the enemies' attack playback and Caelith's snapshot for the Telegraph decals, the staggered
//   bodies for the star billboards, the Element_Shields and the Starshell for their breaks, and the lava zones;
// - draws through boot-time pools only: one particle buffer (rebuilt only when the quality preset changes), mesh
//   pools, weapon trails, decals, afterimages and the 24 floating texts.
// Its clock (`uTime`) is real time and stops only while `paused`, so Hit_Stop frames keep moving debris.

import './vfx.css';
import * as THREE from 'three';
import type { CaelithSnapshot } from '../boss/bossSnapshot';
import type { HitResult } from '../combat/attackRuntime';
import { PLAYER_ENTITY_ID } from '../combat/playerReceiver';
import type { ChestTier, GameEventBus } from '../core/gameEvents';
import { distance, lerpAngle, lerpV3 } from '../core/math';
import type { Vec3 } from '../core/types';
import { CAELITH } from '../data/boss';
import { CHARACTERS } from '../data/characters';
import { getEnemyDef } from '../data/enemies';
import type { BarrierId, CharacterId, ElementId, EntityId, ReactionId } from '../data/ids';
import { renderQualityFor } from '../data/renderQuality';
import type { EffectZone, EnemyRuntime } from '../save/runtimeState';
import { HitIndicator } from '../ui/hitIndicator';
import { Afterimages, StaggerStars, type StaggerMark } from './afterimages';
import { createAtlasTexture } from './atlas';
import {
  ALTAR_BEAM_SECONDS, BURST_FLASH_SECONDS, ELEMENT_COLORS, ELEMENT_FX, HIT_FLASH_SECONDS, LEVEL_UP_PILLAR, REACTION_FX,
  SHIELD_SHARDS, SKYSHARD_RAYS, SKYSHARD_SECONDS, chestBurst, chestPillar, dissolveMotes, impactElement, impactSparks,
  switchSwirl, type BurstSpec,
} from './catalog';
import { DamageNumbers, DamageNumberPool } from './damageNumbers';
import { bossTelegraph, enemyTelegraph, PuddleDecals, TelegraphDecals, type GroundAt, type TelegraphInput } from './decals';
import { MeshFx } from './meshFx';
import { FxRandom, ParticleBuffer, scaledCount } from './particles';
import { WeaponTrails } from './trails';

/** One landed hit for the impact effects (design `HitFx`). `dir` is the hit's travel direction (attacker → target). */
export interface HitFx {
  readonly targetId: EntityId;
  readonly pos: Readonly<Vec3>;
  readonly dir: Readonly<Vec3>;
  readonly amount: number;
  readonly crit: boolean;
  readonly element: ElementId | null;
  readonly toPlayer: boolean;
}

/** The HitFx of a party hit (PlayerCombat onHit): the impact point on the near side of the target's capsule. */
export function hitFxOf(r: Readonly<HitResult>): HitFx {
  const v = r.receiver.hurtVolume();
  const d = r.hit.direction;
  return {
    targetId: r.receiver.id,
    pos: { x: v.pos.x - d.x * v.radius, y: v.pos.y + v.height * 0.6, z: v.pos.z - d.z * v.radius },
    dir: d,
    amount: r.hit.amount,
    crit: r.hit.crit,
    element: r.hit.element,
    toPlayer: false,
  };
}

/** What the VfxSystem reads of the session each frame. */
export interface VfxWorld {
  /** Ground height near (x, z) for a decal at reference height y. */
  groundAt: GroundAt;
  /** Active_Character feet, character and body height. */
  player(): { readonly pos: Readonly<Vec3>; readonly character: CharacterId };
  enemies(): ReadonlyMap<EntityId, Readonly<EnemyRuntime>>;
  /** Caelith's snapshot while the fight shows, else null. */
  boss(): Readonly<CaelithSnapshot> | null;
  /** RuntimeState.zones (lava rifts). */
  zones(): readonly Readonly<EffectZone>[];
  /** Feet of an entity that is neither an enemy, Caelith nor the player (crystals, devices), or null. */
  other?(id: EntityId): Readonly<Vec3> | null;
  chest(id: string): Readonly<Vec3> | null;
  /** A gate wall's span and height, or null (veils and the seal show nothing of their own). */
  barrier(id: BarrierId): { a: Vec3; b: Vec3; bottomY: number; topY: number } | null;
  altar(): Readonly<Vec3>;
  /** The three Landmarks whose light gathers over the Resonance_Altar. */
  landmarks(): readonly Readonly<Vec3>[];
  /** The Active_Character's model root (afterimages), or null. */
  characterModel(): THREE.Object3D | null;
}

export interface VfxSystemOptions {
  bus: GameEventBus;
  camera: THREE.PerspectiveCamera;
  world: VfxWorld;
  /** HUD layer for the floating texts, the hit indicator and the Burst flash; null / omitted: none (tests). */
  hud?: HTMLElement | null;
  /** Settings.qualityPreset, read every frame (default 'medium'). */
  quality?: () => string;
  /** An Element_Shield or the Starshell broke at `pos` (the hit-feel camera impulse). */
  onShieldBreak?(pos: Readonly<Vec3>, starshell: boolean): void;
  /** Drawing-buffer height (px) for the point size (default innerHeight × devicePixelRatio). */
  pixelHeight?: () => number;
  /** GPU point size limit (ALIASED_POINT_SIZE_RANGE[1]); default 256. */
  maxPointSize?: number;
}

interface MudPuddle {
  key: string;
  pos: Vec3;
  t: number;
  life: number;
  radius: number;
}

const BOSS_ID = 'caelith';
const PLAYER_HEIGHT = 1.7;
const WHITE = 0xffffff;

/** Heat haze over a burning lava rift. */
const HAZE: BurstSpec = {
  sprite: 'circle', blend: 'add', count: 1, color: 0xff7a30, speed: [0.05, 0.2], life: [0.8, 1.3], size: [0.35, 0.6],
  layout: 'disc', radius: 2.6, lift: 1.4, alpha: 0.35, shrink: 1.4,
};
const FLAME_ARC: BurstSpec = {
  sprite: 'ember', blend: 'add', count: 1, color: 0xff9a3c, speed: [0.2, 0.6], life: [0.3, 0.5], size: [0.3, 0.45], lift: 0.6,
  essential: true,
};
const HURT_SPARKS: BurstSpec = {
  sprite: 'spark', blend: 'add', count: 6, color: 0xff6a5a, speed: [3, 6], life: [0.12, 0.22], size: [0.12, 0.2], cone: 45, drag: 5,
};

export class VfxSystem {
  readonly object = new THREE.Group();
  /** Weapon trail anchors come from the Animation_System (`trailSample` / `trailEnd`). */
  readonly trails = new WeaponTrails();
  readonly meshes: MeshFx;
  readonly telegraphs: TelegraphDecals;
  readonly puddles: PuddleDecals;
  readonly afterimages = new Afterimages();
  readonly stars: StaggerStars;
  readonly numbers: DamageNumberPool;
  private particlesBuffer: ParticleBuffer;
  private particleScale: number;
  private readonly atlas: THREE.Texture;
  private readonly rng = new FxRandom(0x5eed);
  private readonly o: VfxSystemOptions;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly numberView: DamageNumbers | null;
  private readonly hitIndicator: HitIndicator | null;
  private readonly flashEl: HTMLDivElement | null;
  private flashLeft = 0;
  private readonly flash = new Map<EntityId, number>();
  private readonly shields = new Map<EntityId, ElementId | null>();
  private readonly mud: MudPuddle[] = [];
  private mudSerial = 0;
  private hazeCarry = 0;
  private starshellBreaks = -1;
  private clock = 0;
  private readonly v = new THREE.Vector3();

  constructor(options: VfxSystemOptions) {
    this.o = options;
    this.object.name = 'vfx';
    this.atlas = createAtlasTexture();
    this.particleScale = renderQualityFor(options.quality?.() ?? 'medium').particleScale;
    this.particlesBuffer = new ParticleBuffer(this.particleScale, this.atlas, this.rng);
    this.meshes = new MeshFx(this.rng);
    this.telegraphs = new TelegraphDecals(options.world.groundAt);
    this.puddles = new PuddleDecals(options.world.groundAt);
    this.stars = new StaggerStars(this.atlas);
    const hud = options.hud ?? null;
    this.numberView = hud === null ? null : new DamageNumbers(hud);
    this.numbers = this.numberView?.pool ?? new DamageNumberPool();
    this.hitIndicator = hud === null ? null : new HitIndicator(hud);
    if (hud !== null) {
      this.flashEl = hud.ownerDocument.createElement('div');
      this.flashEl.className = 'vfx-burst-flash';
      this.flashEl.setAttribute('aria-hidden', 'true');
      hud.append(this.flashEl);
    } else {
      this.flashEl = null;
    }
    this.object.add(
      this.particlesBuffer.points, this.meshes.object, this.trails.object, this.puddles.object, this.telegraphs.object,
      this.afterimages.object, this.stars.object,
    );
    this.subscribe(options.bus);
  }

  /** The particle buffer of the current preset. */
  get particles(): ParticleBuffer {
    return this.particlesBuffer;
  }

  /** Real-time clock (s) the effects run on. */
  get time(): number {
    return this.clock;
  }

  /** Emits `spec` at `at` (count × preset scale, at least 1; essential bursts unscaled), along `dir` for cones. */
  burst(spec: Readonly<BurstSpec>, at: Readonly<Vec3>, dir?: Readonly<Vec3>): number {
    const count = scaledCount(spec.count, this.particleScale, spec.essential === true);
    return this.particlesBuffer.burst(spec, count, at, dir);
  }

  /** A landed hit: the target's 0.1 s flash and the impact cone, or on the Active_Character the hit indicator. */
  onHit(h: Readonly<HitFx>): void {
    if (h.toPlayer) {
      // Vignette plus the arc toward the attacker (−dir); a zero dir (no known attacker) shows the vignette only.
      const known = Math.hypot(h.dir.x, h.dir.z) > 1e-9;
      this.hitIndicator?.hit(known ? { x: -h.dir.x, y: 0, z: -h.dir.z } : null);
      this.burst(HURT_SPARKS, h.pos, { x: -h.dir.x, y: 0.4, z: -h.dir.z });
      return;
    }
    this.flash.set(h.targetId, HIT_FLASH_SECONDS);
    const dir = { x: h.dir.x, y: 0.25, z: h.dir.z };
    this.burst(impactSparks(h.crit), h.pos, dir);
    if (h.element !== null) this.burst(impactElement(h.element), h.pos, dir);
  }

  /** `uHitFlash` of `id` now: 1 at the hit, 0 after 0.1 s (the views write it into their materials). */
  hitFlash(id: EntityId): number {
    const left = this.flash.get(id) ?? 0;
    return left > 0 ? left / HIT_FLASH_SECONDS : 0;
  }

  /** Telegraph centres and outline colours for the Camera_System's off-screen arrows (Req 21.5). */
  activeTelegraphs(): readonly { pos: Vec3; color: number }[] {
    return this.telegraphs.activeTelegraphs();
  }

  /** Animation_System: the weapon tip and base of `key` this frame, inside a melee hit window. */
  trailSample(key: string, tip: Readonly<Vec3>, base: Readonly<Vec3>, element: ElementId | null): void {
    this.trails.sample(key, tip, base, element, this.clock);
  }

  /** Animation_System: the hit window of `key` closed. */
  trailEnd(key: string): void {
    this.trails.end(key);
  }

  /** A wading step or a swim entry at the water surface point (design "이동"; Req 16.9, 16.10). */
  splash(kind: 'step' | 'entry', at: Readonly<Vec3>): void {
    const big = kind === 'entry';
    this.meshes.ring(at, big ? 1.8 : 0.75, big ? 0.8 : 0.5, 0xe8f6ff, 0.7);
    this.burst({
      sprite: 'droplet', blend: 'alpha', count: big ? 14 : 5, color: 0xe8f6ff, speed: big ? [2.5, 4] : [1.4, 2],
      life: big ? [0.5, 0.8] : [0.3, 0.5], size: big ? [0.12, 0.2] : [0.08, 0.12], cone: 55, gravity: 9.8, radius: big ? 0.4 : 0.15,
    }, at);
  }

  /** One render frame: `realDt` s (0 while paused), interpolation `alpha` of the last tick. */
  update(realDt: number, alpha: number, paused = false): void {
    const dt = paused || !(realDt > 0) ? 0 : Math.min(realDt, 0.25);
    this.clock += dt;
    const scale = renderQualityFor(this.o.quality?.() ?? 'medium').particleScale;
    if (scale !== this.particleScale) this.rebuildParticles(scale);
    const p = this.particlesBuffer;
    p.setTime(this.clock);
    const g = globalThis as { innerHeight?: number; devicePixelRatio?: number };
    const height = this.o.pixelHeight?.() ?? (g.innerHeight ?? 1080) * Math.min(g.devicePixelRatio ?? 1, 2);
    p.setPointScale(height, this.o.camera.fov, this.o.maxPointSize ?? 256);

    for (const [id, left] of this.flash) {
      const next = left - dt;
      if (next <= 0) this.flash.delete(id);
      else this.flash.set(id, next);
    }
    const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
    const boss = this.o.world.boss();
    this.syncEnemies(a, boss, dt);
    this.syncPuddles(dt);
    this.meshes.update(dt);
    this.trails.update(this.clock);
    this.afterimages.update(dt);
    p.flush();

    if (this.flashEl !== null && this.flashLeft > 0) {
      this.flashLeft = Math.max(0, this.flashLeft - dt);
      this.flashEl.style.opacity = (this.flashLeft / BURST_FLASH_SECONDS * 0.55).toFixed(3);
    }
    if (this.numberView !== null) this.o.camera.updateMatrixWorld();
    this.numberView?.update(dt, (pos) => this.projectPx(pos));
    if (this.numberView === null) this.numbers.update(dt);
  }

  /** Per-frame UI parts that need the camera yaw (the hit direction arc). */
  updateHud(realDt: number, cameraYaw: number): void {
    this.hitIndicator?.update(realDt, cameraYaw);
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.particlesBuffer.dispose();
    this.meshes.dispose();
    this.trails.dispose();
    this.telegraphs.dispose();
    this.puddles.dispose();
    this.afterimages.dispose();
    this.stars.dispose();
    this.atlas.dispose();
    this.numberView?.dispose();
    this.hitIndicator?.dispose();
    this.flashEl?.remove();
    this.object.clear();
  }

  // ── Bus ───────────────────────────────────────────────────────────────────

  private subscribe(bus: GameEventBus): void {
    this.unsubscribe.push(
      bus.on('damage:dealt', (e) => {
        this.numbers.damage(e.amount, e.element, e.crit, e.position);
      }),
      bus.on('reaction', (e) => this.reaction(e.reaction, e.targetId, e.position)),
      bus.on('element:applied', (e) => this.elementApplied(e.targetId, e.element)),
      bus.on('party:switched', (e) => {
        this.burst(switchSwirl(CHARACTERS[e.to].element), this.o.world.player().pos);
      }),
      bus.on('perfectDodge', (e) => {
        this.afterimages.trigger(this.o.world.characterModel(), lighten(ELEMENT_COLORS[CHARACTERS[e.characterId].element]));
      }),
      bus.on('burst:cast', (e) => this.burstCast(e.characterId)),
      bus.on('chest:opened', (e) => this.chestOpened(e.chestId, e.tier)),
      bus.on('skyshard:acquired', () => this.skyshardAcquired()),
      bus.on('barrier:opened', (e) => this.barrierOpened(e.barrierId)),
      bus.on('altar:activated', () => this.altarActivated()),
      bus.on('levelUp', () => this.levelUp()),
      bus.on('enemy:defeated', (e) => this.defeated(e.entityId)),
      bus.on('player:damaged', (e) => {
        const at = this.o.world.player().pos;
        const from = e.fromDirection;
        this.onHit({
          targetId: PLAYER_ENTITY_ID, pos: { x: at.x, y: at.y + 1.1, z: at.z },
          dir: from === null ? { x: 0, y: 0, z: 0 } : { x: -from.x, y: 0, z: -from.z },
          amount: e.amount, crit: false, element: null, toPlayer: true,
        });
      }),
    );
  }

  /** Feet and body height of an entity, or null. */
  private body(id: EntityId): { pos: Vec3; height: number } | null {
    const w = this.o.world;
    if (id === PLAYER_ENTITY_ID) return { pos: { ...w.player().pos }, height: PLAYER_HEIGHT };
    const e = w.enemies().get(id);
    if (e !== undefined) return { pos: { ...e.pos }, height: getEnemyDef(e.def).height };
    if (id === BOSS_ID) {
      const b = w.boss();
      return b === null ? null : { pos: { ...b.pos }, height: CAELITH.height };
    }
    const other = w.other?.(id) ?? null;
    return other === null ? null : { pos: { ...other }, height: 1.5 };
  }

  private elementApplied(targetId: EntityId, element: ElementId): void {
    const b = this.body(targetId);
    if (b === null) return;
    const fx = ELEMENT_FX[element];
    const k = Math.min(3, Math.max(0.8, b.height / 1.4));
    for (const spec of fx.bursts) {
      const scaled = spec.layout === 'column' ? { ...spec, height: (spec.height ?? 1) * k, radius: (spec.radius ?? 0) * Math.sqrt(k) } : spec;
      const at = spec.cone !== undefined ? { x: b.pos.x, y: b.pos.y + b.height * 0.6, z: b.pos.z } : b.pos;
      this.burst(scaled, at);
    }
    if (fx.ring !== undefined) this.meshes.ring(b.pos, fx.ring.radius * Math.sqrt(k), fx.ring.seconds, ELEMENT_COLORS[element], 0.7);
  }

  private reaction(reaction: ReactionId, targetId: EntityId, position: Readonly<Vec3>): void {
    const fx = REACTION_FX[reaction];
    const b = this.body(targetId);
    const height = b?.height ?? 1.5;
    const at = { x: position.x, y: position.y, z: position.z };
    const mid = { x: at.x, y: at.y + Math.min(2, height * 0.5), z: at.z };
    for (const spec of fx.bursts) this.burst(spec, spec.layout === 'column' || spec.layout === 'disc' || spec.layout === 'ring' ? at : mid);
    if (fx.ring !== undefined) this.meshes.ring(at, fx.ring.radius, fx.ring.seconds, fx.color, 0.8);
    if (fx.sphere !== undefined) this.meshes.sphere(mid, fx.sphere.radius, fx.sphere.seconds, fx.color);
    if (fx.puddle?.kind === 'mud') {
      this.mud.push({ key: `mud:${++this.mudSerial}`, pos: at, t: 0, life: fx.puddle.seconds, radius: fx.puddle.radius });
      if (this.mud.length > 3) this.mud.shift();
    }
    const radius = fx.puddle?.radius ?? (fx.arcs === true ? 5 : 0);
    if (fx.vines !== undefined || fx.arcs === true) {
      const near: Vec3[] = [];
      for (const e of this.o.world.enemies().values()) {
        if (e.state === 'dead') continue;
        if (distance(e.pos, at) <= radius) near.push({ ...e.pos });
      }
      if (fx.vines !== undefined) {
        if (near.length === 0) near.push(at);
        for (const p of near.slice(0, 8)) this.meshes.vines(p, fx.vines.seconds);
      }
      if (fx.arcs === true) {
        for (const p of near) if (distance(p, at) > 0.5) this.flameArc(mid, { x: p.x, y: p.y + 1, z: p.z });
      }
    }
    this.numbers.reaction(reaction, { x: at.x, y: at.y + height + 0.4, z: at.z });
  }

  /** Embers along a quadratic Bézier from `from` to `to`, arcing 2 m up, travelling in 0.25 s. */
  private flameArc(from: Readonly<Vec3>, to: Readonly<Vec3>): void {
    const c = { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + 2, z: (from.z + to.z) / 2 };
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const p = {
        x: u * u * from.x + 2 * u * t * c.x + t * t * to.x,
        y: u * u * from.y + 2 * u * t * c.y + t * t * to.y,
        z: u * u * from.z + 2 * u * t * c.z + t * t * to.z,
      };
      this.burst({ ...FLAME_ARC, delay: [t * 0.25, t * 0.25] }, p);
    }
  }

  private burstCast(characterId: CharacterId): void {
    const element = CHARACTERS[characterId].element;
    const color = ELEMENT_COLORS[element];
    if (this.flashEl !== null) {
      this.flashEl.style.background = `radial-gradient(ellipse at center, rgba(255,255,255,0.1) 20%, #${color.toString(16).padStart(6, '0')} 100%)`;
      this.flashEl.style.opacity = '0.55';
      this.flashLeft = BURST_FLASH_SECONDS;
    }
    const at = this.o.world.player().pos;
    this.burst({
      sprite: 'spark', blend: 'add', count: 30, color, speed: [3, 6], life: [0.3, 0.6], size: [0.16, 0.28], layout: 'ring', radius: 0.6,
      lift: 1, drag: 3, essential: true,
    }, at);
    this.meshes.ring(at, 3.5, 0.4, color, 0.8);
  }

  private chestOpened(chestId: string, tier: ChestTier): void {
    const at = this.o.world.chest(chestId);
    if (at === null) return;
    const lid = { x: at.x, y: at.y + 0.6, z: at.z };
    this.burst(chestBurst(tier), lid);
    const pillar = chestPillar(tier);
    this.meshes.pillar(at, pillar.radius, pillar.height, pillar.seconds, pillar.color);
    if (tier === 'glowing') this.meshes.pillar(at, pillar.radius * 0.55, pillar.height, pillar.seconds * 1.2, 0xffffff);
  }

  private skyshardAcquired(): void {
    const at = this.o.world.player().pos;
    const shard = { x: at.x, y: at.y + 2.4, z: at.z };
    for (let i = 0; i < SKYSHARD_RAYS; i++) {
      const a = (i / SKYSHARD_RAYS) * Math.PI * 2;
      const tilt = 0.35 + 0.5 * ((i * 7) % 3) / 2;
      const to = { x: shard.x + Math.sin(a) * 7, y: shard.y + 7 * tilt, z: shard.z + Math.cos(a) * 7 };
      this.meshes.beam(shard, to, 0.08, SKYSHARD_SECONDS, 0xdff2ff, i * 0.04, 0.9);
    }
    this.burst({
      sprite: 'star', blend: 'add', count: 40, color: 0xcfe8ff, speed: [0.3, 0.6], life: [1.2, SKYSHARD_SECONDS], size: [0.14, 0.24],
      layout: 'column', radius: 0.9, height: 0.3, lift: 1.4, swirl: 4, essential: true, delay: [0, 0.6],
    }, at);
  }

  private barrierOpened(barrierId: BarrierId): void {
    const wall = this.o.world.barrier(barrierId);
    if (wall === null) return;
    this.meshes.shardsAlong(wall.a, wall.b, wall.bottomY, wall.topY, 90, 0x9b7bd6);
    const mid = { x: (wall.a.x + wall.b.x) / 2, y: wall.bottomY + 1, z: (wall.a.z + wall.b.z) / 2 };
    this.burst({
      sprite: 'circle', blend: 'alpha', count: 30, color: 0x6e5a8a, speed: [1, 3], life: [1, 1.6], size: [1, 1.8], radius: 2,
      alpha: 0.5, drag: 1.5, shrink: 1.5, essential: true,
    }, mid);
  }

  private altarActivated(): void {
    const altar = this.o.world.altar();
    const top = { x: altar.x, y: altar.y + 12, z: altar.z };
    this.o.world.landmarks().forEach((lm, i) => this.meshes.beam(lm, top, 1.2, ALTAR_BEAM_SECONDS, 0xe8f0ff, 0.3 * i, 0.9));
    this.meshes.pillar(altar, 1.6, 12, ALTAR_BEAM_SECONDS + 1, 0xfff3c4);
  }

  private levelUp(): void {
    const at = this.o.world.player().pos;
    const p = LEVEL_UP_PILLAR;
    this.meshes.pillar(at, p.radius, p.height, p.seconds, p.color);
    this.burst({
      sprite: 'star', blend: 'add', count: 26, color: p.color, speed: [0.2, 0.5], life: [0.8, 1.2], size: [0.14, 0.22],
      layout: 'column', radius: p.radius, height: 0.2, lift: 3, swirl: 3, essential: true,
    }, at);
  }

  private defeated(id: EntityId): void {
    const b = this.body(id);
    if (b === null) return;
    this.burst(dissolveMotes(b.height), b.pos);
  }

  // ── Frame ────────────────────────────────────────────────────────────────

  private syncEnemies(alpha: number, boss: Readonly<CaelithSnapshot> | null, dt: number): void {
    const list: TelegraphInput[] = [];
    const marks: StaggerMark[] = [];
    const seen = new Set<EntityId>();
    for (const [id, e] of this.o.world.enemies()) {
      seen.add(id);
      const pos = lerpV3(e.prevPos, e.pos, alpha);
      const def = getEnemyDef(e.def);
      const t = enemyTelegraph(e, pos, lerpAngle(e.prevYaw, e.yaw, alpha));
      if (t !== null) list.push(t);
      if (e.state === 'stagger') marks.push({ id, head: { x: pos.x, y: pos.y + def.height, z: pos.z } });
      if (def.shield !== undefined) {
        const now = e.element.shield?.element ?? null;
        const before = this.shields.get(id);
        if (before !== undefined && before !== null && now === null) this.shieldBreak({ x: pos.x, y: pos.y + def.height * 0.5, z: pos.z }, before, false);
        this.shields.set(id, now);
      }
    }
    for (const id of this.shields.keys()) if (!seen.has(id)) this.shields.delete(id);
    if (boss !== null) {
      for (const t of boss.telegraphs) list.push(bossTelegraph(t));
      if (boss.state === 'stagger') marks.push({ id: BOSS_ID, head: { x: boss.pos.x, y: boss.pos.y + CAELITH.height, z: boss.pos.z } });
      if (this.starshellBreaks >= 0 && boss.starshellBreaks > this.starshellBreaks) {
        this.shieldBreak({ x: boss.pos.x, y: boss.pos.y + CAELITH.height * 0.5, z: boss.pos.z }, null, true);
      }
      this.starshellBreaks = boss.starshellBreaks;
    }
    this.telegraphs.sync(list, this.clock);
    this.stars.sync(marks, dt);
  }

  private shieldBreak(at: Readonly<Vec3>, element: ElementId | null, starshell: boolean): void {
    const color = element === null ? 0xcfe0ff : ELEMENT_COLORS[element];
    this.meshes.shards(at, SHIELD_SHARDS, color, starshell ? 8 : 5, starshell ? 0.45 : 0.25);
    this.meshes.ring({ x: at.x, y: at.y, z: at.z }, starshell ? 6 : 2.5, 0.35, color, 0.9);
    this.burst({
      sprite: 'shard', blend: 'add', count: 16, color, speed: [4, 8], life: [0.3, 0.6], size: [0.16, 0.28], drag: 3, gravity: 6,
      essential: true,
    }, at);
    this.o.onShieldBreak?.(at, starshell);
  }

  private syncPuddles(dt: number): void {
    const list: { key: string; kind: 'lava' | 'mud'; center: Vec3; radius: number; opacity: number }[] = [];
    let lava = 0;
    for (const z of this.o.world.zones()) {
      if (z.source !== 'lavaRift') continue;
      lava++;
      list.push({ key: z.id, kind: 'lava', center: { ...z.pos }, radius: z.radius, opacity: 1 });
      // Heat haze: HAZE.count per second per rift, carried between frames.
      const perSec = REACTION_FX.lavaRift.haze ?? 0;
      this.hazeCarry += perSec * dt;
      while (this.hazeCarry >= 1) {
        this.hazeCarry -= 1;
        this.burst(HAZE, z.pos);
      }
    }
    if (lava === 0) this.hazeCarry = 0;
    for (let i = this.mud.length - 1; i >= 0; i--) {
      const m = this.mud[i] as MudPuddle;
      m.t += dt;
      if (m.t >= m.life) this.mud.splice(i, 1);
    }
    for (const m of this.mud) {
      list.push({ key: m.key, kind: 'mud', center: m.pos, radius: m.radius, opacity: Math.min(1, m.t / 0.15, (m.life - m.t) / 0.4) });
    }
    this.puddles.sync(list, this.clock);
  }

  private rebuildParticles(scale: number): void {
    this.object.remove(this.particlesBuffer.points);
    this.particlesBuffer.dispose();
    this.particleScale = scale;
    this.particlesBuffer = new ParticleBuffer(scale, this.atlas, this.rng);
    this.particlesBuffer.setTime(this.clock);
    this.object.add(this.particlesBuffer.points);
  }

  /** CSS pixel position of a world point in the render camera, or null behind it / far off screen. */
  private projectPx(pos: Readonly<Vec3>): { x: number; y: number } | null {
    const camera = this.o.camera;
    const p = this.v.set(pos.x, pos.y, pos.z).project(camera);
    if (!(p.z > -1 && p.z < 1) || Math.abs(p.x) > 1.2 || Math.abs(p.y) > 1.2) return null;
    const g = globalThis as { innerWidth?: number; innerHeight?: number };
    const w = g.innerWidth ?? 1920;
    const h = g.innerHeight ?? 1080;
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
  }
}

/** A lighter tint of `color` (afterimages). */
function lighten(color: number): number {
  const c = new THREE.Color(color).lerp(new THREE.Color(WHITE), 0.45);
  return c.getHex();
}
