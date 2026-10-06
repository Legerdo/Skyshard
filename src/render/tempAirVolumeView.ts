// TEMPORARY Updraft and Wind_Zone VFX until the VFX tasks (Req 19.8, AIR_VOLUME_PRESENTATION): every Updraft is a
// column of motes rising from its base to its top, every Wind_Zone a field of short wind streaks flowing along its
// direction. One Points / LineSegments object per volume, animated on the CPU from a fixed per-particle seed (a few
// hundred vertices in total), rebuilt only when the VolumeIndex changes (the starlit Updrafts come and go with the
// Starlit_Stair). Their loop sounds (AIR_VOLUME_PRESENTATION sfx) are the Audio_System's (task 16.3).

import * as THREE from 'three';
import { AIR_VOLUME_PRESENTATION, volumeBounds, type UpdraftVolumeDef, type VolumeShape, type WindZoneVolumeDef } from '../data/volumes';
import type { VolumeIndex } from '../world/volumeIndex';

/** How fast the motes rise and the streaks flow (m/s): a little faster than a glider moves, so the flow reads. */
export const UPDRAFT_MOTE_SPEED = 6;
export const WIND_STREAK_SPEED = 12;
/** Length of one wind streak (m). */
export const WIND_STREAK_LENGTH = 3;
/** Motes per m² of column cross-section, and the count bounds. */
const MOTES_PER_M2 = 1.2;
const MIN_MOTES = 48;
const MAX_MOTES = 220;
/** Streaks per 1000 m³ of zone, and the count bounds. */
const STREAKS_PER_KM3 = 1.2;
const MIN_STREAKS = 40;
const MAX_STREAKS = 200;

/** The air volumes the view reads. */
export type AirVolumeSource = Pick<VolumeIndex, 'version' | 'all'>;

/** Deterministic value in [0, 1) for particle `i`, channel `k`. */
function seed(i: number, k: number): number {
  const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Fractional part in [0, 1). */
const fract = (x: number): number => x - Math.floor(x);

/** Horizontal half extents and yaw of a shape seen as a box (a cylinder as its bounding square, yaw 0). */
function boxOf(shape: VolumeShape): { halfX: number; halfZ: number; yaw: number } {
  return shape.kind === 'box' ? { halfX: shape.halfX, halfZ: shape.halfZ, yaw: shape.yaw } : { halfX: shape.radius, halfZ: shape.radius, yaw: 0 };
}

/** A sphere around the whole volume, so the moving particles are culled with it and never popped. */
function boundsSphere(shape: VolumeShape): THREE.Sphere {
  const b = volumeBounds(shape);
  const centre = new THREE.Vector3((b.minX + b.maxX) / 2, (shape.minY + shape.maxY) / 2, (b.minZ + b.maxZ) / 2);
  const corner = new THREE.Vector3(b.maxX, shape.maxY, b.maxZ);
  return new THREE.Sphere(centre, centre.distanceTo(corner) + WIND_STREAK_LENGTH);
}

interface AirEffect {
  readonly object: THREE.Points | THREE.LineSegments;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  /** Writes the particle positions for `time` (s). */
  readonly animate: (time: number) => void;
}

function updraftEffect(def: UpdraftVolumeDef): AirEffect {
  const shape = def.shape;
  const radius = shape.radius;
  const count = Math.round(Math.min(MAX_MOTES, Math.max(MIN_MOTES, Math.PI * radius * radius * MOTES_PER_M2)));
  const height = Math.max(0.1, shape.maxY - shape.minY);
  const positions = new Float32Array(count * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.boundingSphere = boundsSphere(shape);
  const material = new THREE.PointsMaterial({
    color: AIR_VOLUME_PRESENTATION.updraft.color, size: 0.35, transparent: true, opacity: 0.75,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const object = new THREE.Points(geometry, material);
  object.name = `updraft:${def.id}`;
  const animate = (time: number): void => {
    for (let i = 0; i < count; i++) {
      // Even spread over the disc (sqrt), a slow swirl, and a rise that wraps from the top back to the base.
      const r = radius * Math.sqrt(seed(i, 1));
      const a = seed(i, 2) * Math.PI * 2 + time * 0.6;
      const h = fract(seed(i, 3) + (time * UPDRAFT_MOTE_SPEED * (0.7 + 0.6 * seed(i, 4))) / height);
      positions[i * 3] = shape.x + Math.cos(a) * r;
      positions[i * 3 + 1] = shape.minY + h * height;
      positions[i * 3 + 2] = shape.z + Math.sin(a) * r;
    }
    geometry.attributes.position.needsUpdate = true;
  };
  return { object, geometry, material, animate };
}

function windZoneEffect(def: WindZoneVolumeDef): AirEffect {
  const shape = def.shape;
  const { halfX, halfZ, yaw } = boxOf(shape);
  const height = Math.max(0.1, shape.maxY - shape.minY);
  const volume = 4 * halfX * halfZ * height;
  const count = Math.round(Math.min(MAX_STREAKS, Math.max(MIN_STREAKS, (volume / 1000) * STREAKS_PER_KM3)));
  const len = Math.hypot(def.direction.x, def.direction.z);
  const dir = len > 1e-9 ? { x: def.direction.x / len, z: def.direction.z / len } : { x: 0, z: 1 };
  // Box-local axes in world space (core/math yaw convention: wx = vx·cos + vz·sin, wz = −vx·sin + vz·cos).
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const ax = { x: c, z: -s };
  const az = { x: s, z: c };
  const span = 2 * Math.max(halfX, halfZ);
  const positions = new Float32Array(count * 6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.boundingSphere = boundsSphere(shape);
  const material = new THREE.LineBasicMaterial({
    color: AIR_VOLUME_PRESENTATION.windZone.color, transparent: true, opacity: 0.55, depthWrite: false,
  });
  const object = new THREE.LineSegments(geometry, material);
  object.name = `windZone:${def.id}`;
  const animate = (time: number): void => {
    for (let i = 0; i < count; i++) {
      // A fixed start in the box carried along the flow, folded back into the box on each local axis, so a streak
      // leaving one side re-enters on the other.
      const along = seed(i, 3) * span + time * WIND_STREAK_SPEED * (0.8 + 0.4 * seed(i, 5));
      const dx = dir.x * along;
      const dz = dir.z * along;
      const fx = foldInto((seed(i, 1) * 2 - 1) * halfX + dx * c - dz * s, halfX);
      const fz = foldInto((seed(i, 2) * 2 - 1) * halfZ + dx * s + dz * c, halfZ);
      const x = shape.x + ax.x * fx + az.x * fz;
      const z = shape.z + ax.z * fx + az.z * fz;
      const y = shape.minY + seed(i, 4) * height;
      const o = i * 6;
      positions[o] = x;
      positions[o + 1] = y;
      positions[o + 2] = z;
      positions[o + 3] = x + dir.x * WIND_STREAK_LENGTH;
      positions[o + 4] = y;
      positions[o + 5] = z + dir.z * WIND_STREAK_LENGTH;
    }
    geometry.attributes.position.needsUpdate = true;
  };
  return { object, geometry, material, animate };
}

/** Wraps `v` into [−half, half] (a periodic fold, so a streak leaving one side re-enters on the other). */
function foldInto(v: number, half: number): number {
  if (!(half > 0)) return 0;
  return fract((v + half) / (2 * half)) * 2 * half - half;
}

export class TempAirVolumeView {
  readonly object = new THREE.Group();
  private effects: AirEffect[] = [];
  private version = -1;

  constructor() {
    this.object.name = 'tempAirVolumes';
  }

  /** Number of volumes drawn. */
  get count(): number {
    return this.effects.length;
  }

  /** Rebuilds when the source's volumes changed, then animates every effect for `time` (s of real time). */
  update(source: AirVolumeSource, time: number): void {
    if (source.version !== this.version) this.rebuild(source);
    const t = Number.isFinite(time) ? time : 0;
    for (const e of this.effects) e.animate(t);
  }

  dispose(): void {
    this.clear();
  }

  private rebuild(source: AirVolumeSource): void {
    this.clear();
    this.version = source.version;
    for (const u of source.all('updraft')) this.effects.push(updraftEffect(u));
    for (const w of source.all('windZone')) this.effects.push(windZoneEffect(w));
    for (const e of this.effects) this.object.add(e.object);
  }

  private clear(): void {
    for (const e of this.effects) {
      this.object.remove(e.object);
      e.geometry.dispose();
      e.material.dispose();
    }
    this.effects = [];
  }
}
