// Map fog of war in the World (design "지도 (Map_System)" 방문 공개 · Vista 공개; Req 33.3, 9.5, 11.2). Once per sim
// tick on the Active_Character's feet (the WorldTriggers step):
// - Visit: entering a new 8 m fog cell reveals every cell whose centre lies within 40 m (`FogOfWar.reveal`). When that
//   revealed anything, GameState `discovery.fog` gets the new base64 and `version` goes up, so the map's fog texture
//   is redrawn and the next save carries it.
// - Vista: standing on a Vista_Point (src/data/vistas.ts) reveals 200 m around it and marks every Waystone and
//   Landmark inside that radius on the map (`world.flags` `map_<id>`); a marked Waystone is still no fast-travel
//   destination until it is activated (Req 11.2). `reached_<vista>` records the first arrival. The reveal runs on each
//   arrival (it adds nothing the second time).
// The fog is decoded from GameState when the session is built (New Game or a load), so the saved reveal carries over.
// Pure TypeScript: no three.js / DOM.

import { isFiniteV3 } from '../core/math';
import type { Vec3 } from '../core/types';
import { LANDMARK_IDS, type LandmarkId } from '../data/ids';
import { atVista, mapMarkFlag, VISTA_LIST, VISTA_REVEAL_RADIUS, vistaReachedFlag, withinVista, type VistaDef, type VistaId } from '../data/vistas';
import { DISCOVERY_VOLUMES } from '../data/volumes';
import { WAYSTONE_LIST } from '../data/waystones';
import { cellIndex, FogOfWar } from '../logic/fogOfWar';
import type { GameState } from '../logic/save/gameState';

/** Radius revealed around the Active_Character on each new fog cell (m, Req 33.3). */
export const VISIT_REVEAL_RADIUS = 40;

export interface FogSystemOptions {
  /** Owns `discovery.fog` and the `map_<id>` / `reached_<vista>` flags in `world.flags`. */
  state: GameState;
  /** A Vista's reveal ran (arrival): the HUD may announce it. `first` on the first arrival in this save. */
  onVista?: (id: VistaId, first: boolean) => void;
}

/** Landmark points the Vistas mark: the centres of their discovery radii. */
const LANDMARK_POINTS: readonly { id: LandmarkId; x: number; z: number }[] = DISCOVERY_VOLUMES
  .filter((v) => (LANDMARK_IDS as readonly string[]).includes(v.id))
  .map((v) => ({ id: v.id, x: v.shape.x, z: v.shape.z }));

export class FogSystem {
  private readonly state: GameState;
  private readonly onVista: FogSystemOptions['onVista'];
  private readonly fogOfWar: FogOfWar;
  private cell = -2; // no cell yet (−1 is outside the world)
  private readonly onVistas = new Set<VistaId>();
  private changes = 0;

  constructor(options: FogSystemOptions) {
    this.state = options.state;
    this.onVista = options.onVista;
    this.fogOfWar = FogOfWar.decode(options.state.discovery.fog);
  }

  /** Bumped whenever the revealed cells change (the map redraws its fog texture then). */
  get version(): number {
    return this.changes;
  }

  /** The current fog (read-only use: the map, tests). */
  get fog(): Pick<FogOfWar, 'isRevealed' | 'isCellRevealed' | 'revealedCount'> {
    return this.fogOfWar;
  }

  /** One sim tick on the feet. A non-finite position changes nothing. */
  tick(feet: Readonly<Vec3>): void {
    if (!isFiniteV3(feet)) return;
    const cell = cellIndex(feet.x, feet.z);
    if (cell !== this.cell) {
      this.cell = cell;
      if (cell >= 0) this.reveal(feet.x, feet.z, VISIT_REVEAL_RADIUS);
    }
    for (const vista of VISTA_LIST) {
      const on = atVista(vista, feet.x, feet.y, feet.z);
      if (!on) {
        this.onVistas.delete(vista.id);
        continue;
      }
      if (this.onVistas.has(vista.id)) continue;
      this.onVistas.add(vista.id);
      this.arriveAt(vista);
    }
  }

  /**
   * Forgets the last cell and Vista (after fast travel or a load), so the next tick reveals around the new position
   * and a Vista stood on again runs its reveal again.
   */
  reset(): void {
    this.cell = -2;
    this.onVistas.clear();
  }

  private arriveAt(vista: VistaDef): void {
    const { flags } = this.state.world;
    const first = flags[vistaReachedFlag(vista.id)] !== true;
    flags[vistaReachedFlag(vista.id)] = true;
    this.reveal(vista.x, vista.z, VISTA_REVEAL_RADIUS);
    for (const w of WAYSTONE_LIST) if (withinVista(vista, w)) flags[mapMarkFlag(w.id)] = true;
    for (const l of LANDMARK_POINTS) if (withinVista(vista, l)) flags[mapMarkFlag(l.id)] = true;
    this.changes++;
    this.onVista?.(vista.id, first);
  }

  private reveal(x: number, z: number, r: number): void {
    if (this.fogOfWar.reveal(x, z, r) <= 0) return;
    this.state.discovery.fog = this.fogOfWar.encode();
    this.changes++;
  }
}
