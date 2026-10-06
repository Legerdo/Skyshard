// World edge: the cloud sea (task 20.4; Req 8.6, design "World Layout Master Table" 경계). The ring mountains of the
// terrain (src/world/terrain RING_MOUNTAINS) rise beyond the 470 m boundary; past the heightfield's edge a wide ring of
// cloud at y 160 fills the view to the horizon, so from the high places (the Sanctum, the Observatory, the peaks) the
// world ends in a sea of cloud rather than at a cut. Its inner edge sits under the terrain's outer square, where the
// mountains hide it, and it fades into the scene fog far out. Soft brightness variation comes from a small hash noise
// in the vertex colours; it drifts slowly in `update`. Art-pass material work may replace it.

import * as THREE from 'three';
import { TERRAIN_GRID } from '../data/worldLayout';

/** Height of the cloud surface (m). */
export const CLOUD_SEA_Y = 160;
const INNER = TERRAIN_GRID.halfExtent;
const OUTER = 2400;

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class WorldEdgeView {
  readonly object = new THREE.Group();
  private readonly geometry: THREE.RingGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mesh: THREE.Mesh;

  constructor() {
    this.object.name = 'worldEdge';
    this.geometry = new THREE.RingGeometry(INNER, OUTER, 128, 10);
    const pos = this.geometry.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const base = new THREE.Color(0xf4f7ff);
    const shade = new THREE.Color(0xc9d6ec);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const n = 0.6 * hash(Math.round(x / 90), Math.round(y / 90)) + 0.4 * hash(Math.round(x / 37), Math.round(y / 37));
      c.copy(shade).lerp(base, n);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = CLOUD_SEA_Y;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.object.add(this.mesh);
  }

  /** `time` (s, real): a slow drift of the cloud pattern. */
  update(time: number): void {
    this.mesh.rotation.z = time * 0.0015;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.object.clear();
  }
}
