// TEMPORARY enemy drop visuals until the VFX tasks (Req 28.13): one small glowing star per drop in
// RuntimeState.pickups, interpolated between its last two tick positions. A resting drop floats and spins a little
// above the ground where the enemy fell; a pulled drop flies to the Active_Character and shrinks as it arrives.
// Meshes come from a fixed pool reused frame to frame (Req 38.6); drops beyond the pool are not drawn.

import * as THREE from 'three';
import { lerpV3 } from '../core/math';
import type { PickupRuntime } from '../save/runtimeState';

const STARMOTE_COLOR = 0xbfe6ff;
const POOL_SIZE = 16;
/** A resting drop floats this high (m) and bobs by BOB (m) at BOB_RATE (rad/s). */
const REST_LIFT = 0.35;
const BOB = 0.08;
const BOB_RATE = 3;
const SPIN_RATE = 2;
const SIZE = 0.16;

export class TempPickupView {
  readonly object = new THREE.Group();
  private readonly geometry = new THREE.OctahedronGeometry(SIZE, 0);
  private readonly material = new THREE.MeshBasicMaterial({ color: STARMOTE_COLOR });
  private readonly meshes: THREE.Mesh[] = [];

  constructor() {
    this.object.name = 'tempPickups';
    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.visible = false;
      this.meshes.push(mesh);
      this.object.add(mesh);
    }
  }

  /** Shows the first POOL_SIZE drops at interpolation `alpha`; `time` (s) drives the idle bob and spin. */
  sync(pickups: readonly Readonly<PickupRuntime>[], alpha: number, time: number): void {
    const t = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
    this.meshes.forEach((mesh, i) => {
      const p = pickups[i];
      mesh.visible = p !== undefined;
      if (p === undefined) return;
      const pos = lerpV3(p.prevPos, p.pos, t);
      const lift = p.pulled ? 0 : REST_LIFT + BOB * Math.sin(time * BOB_RATE + i);
      mesh.position.set(pos.x, pos.y + lift, pos.z);
      mesh.rotation.y = time * SPIN_RATE + i;
      mesh.scale.setScalar(p.pulled ? 0.7 : 1);
    });
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.object.clear();
  }
}
