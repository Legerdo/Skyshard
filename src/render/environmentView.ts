/*
 * A play session's environment art (task 18.5): water and the waterfall, the Region atmosphere particles, birds and
 * butterflies, the Blight (crystals, vines, ground patches, purification) and the blob shadows, plus the
 * InteriorVolume the Active_Character stands in (the page's render pipeline blends the interior lighting, since it
 * runs after the world scene's time-of-day values). GameSession owns one and calls `update` once per render frame
 * after the character and enemy views are posed.
 */
import * as THREE from 'three';
import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import type { ChallengeAreaDef } from '../data/challengeAreas';
import { renderQualityFor } from '../data/renderQuality';
import type { BurstSpec } from '../vfx/catalog';
import { waterLevelAt, type TerrainField } from '../world/terrain';
import { AtmosphereParticles } from './atmosphere';
import { BirdFlocks, Butterflies } from './birds';
import { BlightView } from './blight';
import type { BlightProgress } from './blightState';
import { BlobShadows, type BlobActor } from './blobShadows';
import { regionWeights } from './grading';
import { InteriorBlend, interiorLookFor, type InteriorLook } from './interiorLighting';
import { WaterView } from './water';

/** A decal follows the terrain within this height below the feet, else lies at the feet (bridges, platforms). */
const GROUND_SNAP = 1.5;
/** The Active_Character raises a ripple every this many metres waded or swum. */
const RIPPLE_STRIDE = 1.1;

/** The player fields the environment reads. */
export interface EnvironmentPlayer {
  readonly pos: Readonly<Vec3>;
  readonly vel: Readonly<Vec3>;
  readonly mode: string;
  readonly wading: boolean;
  readonly grounded: boolean;
}

export interface EnvironmentViewOptions {
  terrain: Pick<TerrainField, 'seed' | 'heights' | 'heightAt' | 'slopeDeg' | 'waterDepthAt' | 'insideBoundary'>;
  bus: GameEventBus;
  camera: THREE.Camera;
  /** GameState (read-only): Skyshards and the completion flag. */
  progress(): BlightProgress;
  player(): EnvironmentPlayer;
  /** Enemy feet (living ones). */
  enemies(): Iterable<Readonly<Vec3>>;
  /** NPC feet (those standing in the world). */
  npcs(): Iterable<Readonly<Vec3>>;
  /** Projectiles in flight (a ripple where one meets the water). */
  projectiles(): Iterable<Readonly<Vec3>>;
  /** The Challenge_Area the Active_Character is in, or null. */
  challengeArea(): Pick<ChallengeAreaDef, 'id' | 'lighting'> | null;
  /** Settings.qualityPreset (particle scale). */
  quality(): string;
  /** VfxSystem.burst (sparkles, mist); omitted: none. */
  burst?(spec: Readonly<BurstSpec>, at: Readonly<Vec3>): void;
}

const PLAYER_RADIUS = 0.4;
const ENEMY_RADIUS = 0.6;
const NPC_RADIUS = 0.4;

export class EnvironmentView {
  readonly object = new THREE.Group();
  readonly water: WaterView;
  readonly atmosphere = new AtmosphereParticles();
  readonly birds: BirdFlocks;
  readonly butterflies: Butterflies;
  readonly blight: BlightView;
  readonly blobs = new BlobShadows();
  private interiorTarget: InteriorLook | null = null;
  /** The same 1 s interior blend as the pipeline's lighting, for the atmosphere fade indoors. */
  private readonly interiorBlend = new InteriorBlend();
  private time = 0;
  private rippleCarry = 0;
  private readonly lastPlayer = new THREE.Vector3();
  private hasLastPlayer = false;
  /** Projectiles under the water surface last frame (a ripple when one crosses it). */
  private underwater = new Set<object>();
  private underwaterNext = new Set<object>();
  private readonly camPos = new THREE.Vector3();
  private readonly actors: BlobActor[] = [];

  constructor(private readonly o: EnvironmentViewOptions) {
    this.object.name = 'environment';
    const heightAt = (x: number, z: number): number => o.terrain.heightAt(x, z);
    this.water = new WaterView({ heights: o.terrain.heights, burst: o.burst });
    this.birds = new BirdFlocks(heightAt);
    this.butterflies = new Butterflies(heightAt);
    this.blight = new BlightView({ terrain: o.terrain, bus: o.bus, progress: o.progress, burst: o.burst });
    this.object.add(this.water.object, this.atmosphere.object, this.birds.mesh, this.butterflies.mesh, this.blight.object, this.blobs.mesh);
  }

  /** The InteriorVolume look at the Active_Character this frame (null outdoors). */
  get interior(): InteriorLook | null {
    return this.interiorTarget;
  }

  update(realDt: number, focus: Readonly<Vec3>): void {
    const dt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 0.25) : 0;
    this.time += dt;
    const o = this.o;
    const player = o.player();
    this.o.camera.getWorldPosition(this.camPos);
    this.interiorTarget = interiorLookFor(o.challengeArea(), player.pos);

    this.water.update(dt, o.camera);
    this.ripples(player);
    const w = regionWeights(focus);
    this.atmosphere.setScale(renderQualityFor(o.quality()).particleScale);
    this.atmosphere.update(this.time, w, this.interiorBlend.update(dt, this.interiorTarget));
    const speed = Math.hypot(player.vel.x, player.vel.z);
    this.birds.update(dt, this.time, { pos: player.pos, speed });
    this.butterflies.update(this.time, this.camPos);
    this.blight.update(dt, o.camera);
    this.placeBlobs(player);
  }

  dispose(): void {
    this.water.dispose();
    this.atmosphere.dispose();
    this.birds.dispose();
    this.butterflies.dispose();
    this.blight.dispose();
    this.blobs.dispose();
    this.object.clear();
  }

  /** Rings where the Active_Character wades or swims, and where a projectile meets the water. */
  private ripples(player: EnvironmentPlayer): void {
    const p = player.pos;
    const inWater = player.mode === 'swim' || player.wading;
    if (inWater && this.hasLastPlayer) {
      const moved = Math.hypot(p.x - this.lastPlayer.x, p.z - this.lastPlayer.z);
      this.rippleCarry += moved;
      if (this.rippleCarry >= RIPPLE_STRIDE) {
        this.rippleCarry %= RIPPLE_STRIDE;
        this.water.ripple(p.x, p.z, player.mode === 'swim' ? 1 : 0.7);
      }
    } else if (inWater) {
      this.water.ripple(p.x, p.z, 1.2); // stepping in
    } else {
      this.rippleCarry = 0;
    }
    this.lastPlayer.set(p.x, p.y, p.z);
    this.hasLastPlayer = inWater;
    const next = this.underwaterNext;
    next.clear();
    for (const proj of this.o.projectiles()) {
      const level = waterLevelAt(proj.x, proj.z);
      if (level === null || proj.y > level) continue;
      next.add(proj);
      if (!this.underwater.has(proj)) this.water.ripple(proj.x, proj.z, 1.1);
    }
    this.underwaterNext = this.underwater;
    this.underwater = next;
  }

  private placeBlobs(player: EnvironmentPlayer): void {
    const actors = this.actors;
    actors.length = 0;
    actors.push({ pos: player.pos, radius: PLAYER_RADIUS });
    for (const pos of this.o.npcs()) actors.push({ pos, radius: NPC_RADIUS });
    for (const pos of this.o.enemies()) actors.push({ pos, radius: ENEMY_RADIUS });
    const terrain = this.o.terrain;
    const playerGrounded = player.grounded;
    this.blobs.update(actors, (x, z, feetY) => {
      const h = terrain.heightAt(x, z);
      // On a bridge or platform (well above the terrain) the blob lies at the feet of a grounded body.
      if (feetY - h > GROUND_SNAP) return x === player.pos.x && z === player.pos.z && !playerGrounded ? h : feetY;
      return h;
    });
  }
}
