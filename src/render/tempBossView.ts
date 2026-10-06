// The Caelith fight on screen (tasks 4.9 / 10; the Caelith model of task 19.3 and its animation of task 19.4).
// Read-only: it mirrors the BossEncounter's snapshot. Its Telegraph decals and the Starshell break shards are the
// VfxSystem's (src/vfx, task 19.5).
// - Caelith: the CaelithView (src/visual/caelithView) — the ≈ 6 m star knight with its greatsword, starlight cape,
//   halo and Starshell (7 draw calls), clips chosen from the snapshot, the Final Phase crack glow, the transition and
//   vulnerable flashes, the rising death dissolve. Hidden while the fight has not begun and once the dissolve is over.
// - The Astral Sweep ring: a glowing 0.8 m wall at the ring's radius while it crosses the arena.
// - Shards in flight and the Shard_Crystals on their pedestals (Element colours, sized by HP, a halo while Caelith
//   stands within 6 m of one).

import * as THREE from 'three';
import type { BossEncounter } from '../boss/bossEncounter';
import { lerpAngle, lerpV3 } from '../core/math';
import { CAELITH_GEOMETRY, SHARD_CRYSTAL } from '../data/boss';
import { ELEMENT_DEFS } from '../data/elements';
import type { ElementId } from '../data/ids';
import { CaelithView, DEATH_DISSOLVE_DELAY, DEATH_DISSOLVE_SECONDS } from '../visual/caelithView';
import { defaultVisualLibrary, type VisualLibrary } from '../visual/visualLibrary';

const SHARD_COLOR = 0xcfe0ff;
const MAX_SHARDS = 12;
/** Caelith is gone once the death dissolve is over (s after death). */
const DEATH_GONE = DEATH_DISSOLVE_DELAY + DEATH_DISSOLVE_SECONDS;

export interface BossViewFrame {
  /** The Starshell broke since the last frame. */
  readonly starshellBroke: boolean;
}

export class TempBossView {
  readonly object = new THREE.Group();
  /** The Caelith model (tests, debug tools). */
  readonly caelith: CaelithView;
  private lastTime: number | null = null;
  private seenBreaks = 0;
  private readonly ringWall: THREE.Mesh;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly shards: THREE.Mesh[] = [];
  private readonly crystals = new Map<ElementId, { mesh: THREE.Mesh; halo: THREE.Mesh }>();
  private readonly disposables: { dispose(): void }[] = [];

  constructor(library: VisualLibrary = defaultVisualLibrary()) {
    this.object.name = 'tempBoss';
    this.caelith = new CaelithView(library);
    this.caelith.object.visible = false;

    const astral = CAELITH_GEOMETRY.astral;
    this.ringMaterial = this.track(new THREE.MeshBasicMaterial({ color: 0xbfd4ff, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
    const wall = this.track(new THREE.CylinderGeometry(1, 1, astral.height, 64, 1, true));
    wall.translate(0, astral.height / 2, 0);
    this.ringWall = new THREE.Mesh(wall, this.ringMaterial);
    this.ringWall.visible = false;

    const shardGeometry = this.track(new THREE.OctahedronGeometry(0.4));
    const shardMaterial = this.track(new THREE.MeshBasicMaterial({ color: SHARD_COLOR }));
    for (let i = 0; i < MAX_SHARDS; i++) {
      const s = new THREE.Mesh(shardGeometry, shardMaterial);
      s.visible = false;
      this.shards.push(s);
      this.object.add(s);
    }

    const crystalGeometry = this.track(new THREE.OctahedronGeometry(1));
    crystalGeometry.scale(SHARD_CRYSTAL.radius, SHARD_CRYSTAL.height / 2, SHARD_CRYSTAL.radius);
    crystalGeometry.translate(0, SHARD_CRYSTAL.height / 2, 0);
    const haloGeometry = this.track(new THREE.RingGeometry(1.1, 1.4, 32).rotateX(-Math.PI / 2));
    for (const element of Object.keys(ELEMENT_DEFS) as ElementId[]) {
      const color = new THREE.Color(ELEMENT_DEFS[element].cssColor);
      const material = this.track(new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.5, flatShading: true }));
      const haloMaterial = this.track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }));
      const mesh = new THREE.Mesh(crystalGeometry, material);
      const halo = new THREE.Mesh(haloGeometry, haloMaterial);
      mesh.visible = false;
      halo.visible = false;
      this.crystals.set(element, { mesh, halo });
      this.object.add(mesh, halo);
    }
    this.object.add(this.caelith.object, this.ringWall);
  }

  /**
   * Mirrors `boss` at interpolation `alpha`; `time` (s) drives the arena effects' shimmer; `dt` (scaled s, default the
   * change of `time`) animates Caelith.
   */
  update(boss: BossEncounter, alpha: number, time: number, dt?: number): BossViewFrame {
    const step = dt ?? (this.lastTime === null ? 0 : Math.max(0, Math.min(0.1, time - this.lastTime)));
    this.lastTime = time;
    const snap = boss.snapshot();
    const shown = snap.state !== 'dormant' && !(snap.state === 'dead' && snap.stateTime >= DEATH_GONE);
    const pose = boss.pose();
    const pos = lerpV3(pose.prev, pose.pos, alpha);
    const yaw = lerpAngle(pose.prevYaw, pose.yaw, alpha);
    this.caelith.update(snap, pos, yaw, step, alpha, shown);

    const broke = snap.starshellBreaks > this.seenBreaks;
    this.seenBreaks = snap.starshellBreaks;

    const ring = snap.ring;
    this.ringWall.visible = shown && ring !== null;
    if (ring !== null) {
      const r = Math.max(0.1, ring.radius - ring.thickness / 2);
      this.ringWall.position.set(ring.center.x, ring.center.y + 0.02, ring.center.z);
      this.ringWall.scale.set(r, 1, r);
      this.ringMaterial.opacity = 0.45 + 0.2 * Math.sin(time * 20);
    }

    this.shards.forEach((mesh, i) => {
      const s = snap.shards[i];
      mesh.visible = s !== undefined;
      if (s !== undefined) {
        mesh.position.set(s.x, s.y, s.z);
        mesh.rotation.y = time * 8;
      }
    });

    for (const [element, view] of this.crystals) {
      const c = snap.crystals.find((x) => x.element === element);
      view.mesh.visible = shown && c !== undefined;
      view.halo.visible = shown && c !== undefined && c.caelithNear;
      if (c === undefined) continue;
      const k = 0.6 + 0.4 * (c.hp / Math.max(1, c.maxHp));
      view.mesh.position.set(c.pos.x, c.pos.y + 0.15 * Math.sin(time * 2 + c.pos.x), c.pos.z);
      view.mesh.scale.setScalar(k);
      view.mesh.rotation.y = time * 0.8;
      view.halo.position.set(c.pos.x, c.pos.y + 0.03, c.pos.z);
    }
    return { starshellBroke: broke };
  }

  dispose(): void {
    this.caelith.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.object.clear();
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }
}
