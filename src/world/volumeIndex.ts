// Trigger and air volumes in a 16 m spatial hash (design "물·기류·트리거 볼륨", "청크와 활성화"). A point query
// looks only at the hash cell the point is in and the eight cells around it, so area and discovery checks
// cost the same wherever the player is. Volumes can be added and removed at run time (the starlit Updrafts
// appear with the Starlit_Stair). Pure TypeScript: no three.js / DOM.

import type { Vec3 } from '../core/types';
import { volumeBounds, volumeContains, type VolumeDef, type VolumeKind } from '../data/volumes';
import { cellIndex, SpatialHash } from '../physics/spatialHash';
import { SPATIAL_CELL_SIZE } from '../physics/types';

type VolumeOf<K extends VolumeKind> = Extract<VolumeDef, { kind: K }>;

const keyOf = (kind: VolumeKind, id: string): string => `${kind}:${id}`;

export class VolumeIndex {
  private readonly hash = new SpatialHash<VolumeDef>(SPATIAL_CELL_SIZE);
  private readonly handles = new Map<string, number>();
  private nextHandle = 1;
  private readonly scratch: VolumeDef[] = [];
  /** Bumped on every add and remove, so views can rebuild only when the set changed. */
  private changes = 0;

  /** Number of volumes held. */
  get size(): number {
    return this.handles.size;
  }

  /** Changes so far (adds and removes); equal values mean the same set of volumes. */
  get version(): number {
    return this.changes;
  }

  /** Adds a volume; a volume with the same kind and id is replaced. */
  add(def: VolumeDef): void {
    this.remove(def.kind, def.id);
    const handle = this.nextHandle++;
    if (this.hash.insert(handle, def, volumeBounds(def.shape))) {
      this.handles.set(keyOf(def.kind, def.id), handle);
      this.changes++;
    }
  }

  addAll(defs: Iterable<VolumeDef>): void {
    for (const def of defs) this.add(def);
  }

  /** Removes a volume; false when there is none of that kind and id. */
  remove(kind: VolumeKind, id: string): boolean {
    const key = keyOf(kind, id);
    const handle = this.handles.get(key);
    if (handle === undefined) return false;
    this.handles.delete(key);
    this.changes++;
    return this.hash.remove(handle);
  }

  has(kind: VolumeKind, id: string): boolean {
    return this.handles.has(keyOf(kind, id));
  }

  /** Every volume of `kind`, in insertion order (for views and emitters, not per-tick queries). */
  all<K extends VolumeKind>(kind: K): VolumeOf<K>[] {
    const out: VolumeOf<K>[] = [];
    for (const handle of this.handles.values()) {
      const def = this.hash.get(handle);
      if (def !== undefined && def.kind === kind) out.push(def as VolumeOf<K>);
    }
    return out;
  }

  /**
   * Volumes of `kind` that contain `p` (feet), found in p's hash cell and its neighbours, in insertion order
   * (the hash orders by handle). A non-finite point is in no volume.
   */
  at<K extends VolumeKind>(p: Readonly<Vec3>, kind: K): VolumeOf<K>[] {
    const out: VolumeOf<K>[] = [];
    if (!(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) return out;
    const size = this.hash.cellSize;
    const ix = cellIndex(p.x, size);
    const iz = cellIndex(p.z, size);
    // The 3 × 3 block of cells around the point, as inclusive bounds just inside the block's outer edges.
    const inset = size * 1e-6;
    const found = this.hash.queryAabb(
      { minX: (ix - 1) * size, minZ: (iz - 1) * size, maxX: (ix + 2) * size - inset, maxZ: (iz + 2) * size - inset },
      this.scratch,
    );
    for (const def of found) {
      if (def.kind === kind && volumeContains(def.shape, p)) out.push(def as VolumeOf<K>);
    }
    found.length = 0;
    return out;
  }
}
