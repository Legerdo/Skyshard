// TEMPORARY projectile visuals until the VFX tasks: one mesh per projectile in flight, at its tick position. The
// party's arrows (RuntimeState.projectiles.active) are glowing shafts laid along the velocity; enemy projectiles
// (RuntimeState.enemyProjectiles.active: Ash Wisp fireballs, ...) are glowing orbs of their sweep radius. The meshes
// are a fixed pool that is reused frame to frame (Req 38.6); projectiles beyond the pool are not drawn.

import * as THREE from 'three';
import type { ProjectileRuntime } from '../save/runtimeState';

const ARROW_COLOR = 0x9fe8ff;
const ORB_COLOR = 0xff7a2a;
const POOL_SIZE = 24;
const SHAFT_LENGTH = 0.9;

export interface TempProjectileViewOptions {
  /** 'arrow' (default): a shaft along the velocity; 'orb': a sphere of the projectile's radius. */
  look?: 'arrow' | 'orb';
  color?: number;
}

export class TempProjectileView {
  readonly object = new THREE.Group();
  private readonly look: 'arrow' | 'orb';
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly dir = new THREE.Vector3();

  constructor(options: TempProjectileViewOptions = {}) {
    this.look = options.look ?? 'arrow';
    this.object.name = this.look === 'orb' ? 'tempEnemyProjectiles' : 'tempProjectiles';
    // The cylinder's axis is local +Y; sync() turns +Y onto the velocity. The orb is a unit sphere scaled per shot.
    this.geometry = this.look === 'orb'
      ? new THREE.SphereGeometry(1, 12, 8)
      : new THREE.CylinderGeometry(0.04, 0.04, SHAFT_LENGTH, 5);
    this.material = new THREE.MeshBasicMaterial({ color: options.color ?? (this.look === 'orb' ? ORB_COLOR : ARROW_COLOR) });
    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.object.add(mesh);
    }
  }

  /** Shows the first POOL_SIZE projectiles of `active`. */
  sync(active: readonly Readonly<ProjectileRuntime>[]): void {
    this.meshes.forEach((mesh, i) => {
      const p = active[i];
      mesh.visible = p !== undefined;
      if (p === undefined) return;
      mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
      if (this.look === 'orb') {
        mesh.scale.setScalar(Math.max(0.05, p.radius));
        return;
      }
      this.dir.set(p.vel.x, p.vel.y, p.vel.z);
      if (this.dir.lengthSq() > 1e-9) mesh.quaternion.setFromUnitVectors(this.up, this.dir.normalize());
    });
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
