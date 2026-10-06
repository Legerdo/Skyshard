// The session's VFX and hit feel (tasks 19.5 / 19.6): builds the VfxSystem over a PlaySim (enemies, Caelith, zones,
// the Chests, gates, Resonance_Altar and Landmarks it reads) and the HitFeelCamera over the Camera_System, and routes
// each party hit from the Combat_System hook to both. GameSession owns one; main.ts passes the quality preset and the
// pause state through it.

import type * as THREE from 'three';
import type { HitResult } from '../combat/attackRuntime';
import type { Vec3 } from '../core/types';
import { BARRIERS } from '../data/barriers';
import { CHESTS, silhouettePoint } from '../data/pois';
import { RESONANCE_ALTAR } from '../data/starlitStair';
import type { BarrierId, LandmarkId } from '../data/ids';
import type { PlaySim } from '../playSim';
import type { TerrainField } from '../world/terrain';
import { HitFeelCamera } from './hitFeelCamera';
import { hitFxOf, VfxSystem } from './vfxSystem';

/** The three Landmarks whose light gathers over the Resonance_Altar (one per Skyshard Region, design "cin_altar"). */
export const ALTAR_LANDMARKS: readonly LandmarkId[] = ['lm_breezewatch', 'lm_cinderspire', 'lm_observatory'];
/** A decal follows the terrain within this height of its reference point, else lies flat (bridges, platforms). */
const GROUND_SNAP = 1.5;

export interface SessionVfxOptions {
  sim: PlaySim;
  terrain: Pick<TerrainField, 'heightAt'>;
  camera: THREE.PerspectiveCamera;
  /** HUD layer for the floating texts, hit indicator and Burst flash; null: none. */
  hud: HTMLElement | null;
  /** Settings.qualityPreset (default 'medium'). */
  quality?: () => string;
  /** Camera_System.addTrauma. */
  addTrauma(amount: number): void;
  /** The Active_Character's interpolated feet. */
  focus(): Readonly<Vec3>;
  /** The Active_Character's model root (afterimages). */
  characterModel(): THREE.Object3D | null;
}

export class SessionVfx {
  readonly vfx: VfxSystem;
  readonly hitFeel: HitFeelCamera;

  constructor(o: SessionVfxOptions) {
    const { sim } = o;
    const landmarks = ALTAR_LANDMARKS.map((id) => silhouettePoint(id, 0.6));
    this.hitFeel = new HitFeelCamera({ bus: sim.bus, addTrauma: (n) => o.addTrauma(n), focus: () => o.focus() });
    this.vfx = new VfxSystem({
      bus: sim.bus,
      camera: o.camera,
      hud: o.hud,
      quality: o.quality,
      onShieldBreak: (pos, starshell) => this.hitFeel.shieldBreak(pos, starshell),
      world: {
        groundAt: (x, z, refY) => {
          const h = o.terrain.heightAt(x, z);
          return Math.abs(h - refY) <= GROUND_SNAP ? h : refY;
        },
        player: () => ({ pos: o.focus(), character: sim.gameState.party.active }),
        enemies: () => sim.runtime.enemies,
        boss: () => {
          const s = sim.boss.snapshot();
          return s.state === 'dormant' ? null : s;
        },
        zones: () => sim.runtime.zones,
        chest: (id) => CHESTS.find((c) => c.id === id)?.pos ?? null,
        barrier: (id: BarrierId) => {
          const b = BARRIERS[id];
          if (b.kind !== 'gate') return null;
          const y = b.groundY;
          return { a: { x: b.span.a.x, y, z: b.span.a.z }, b: { x: b.span.b.x, y, z: b.span.b.z }, bottomY: y, topY: b.topY };
        },
        altar: () => RESONANCE_ALTAR.pos,
        landmarks: () => landmarks,
        characterModel: () => o.characterModel(),
      },
    });
  }

  /** Combat_System hook: a party hit landed (inside the tick). */
  hit(r: Readonly<HitResult>): void {
    this.vfx.onHit(hitFxOf(r));
    this.hitFeel.hit(r);
  }

  /** One render frame after the views are posed. */
  update(realDt: number, alpha: number, paused: boolean, cameraYaw: number): void {
    this.vfx.update(realDt, alpha, paused);
    this.vfx.updateHud(paused ? 0 : realDt, cameraYaw);
  }

  dispose(): void {
    this.hitFeel.dispose();
    this.vfx.dispose();
  }
}
