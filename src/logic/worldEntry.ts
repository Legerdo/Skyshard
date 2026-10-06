/*
 * Region and area entry rules (design.md "물·기류·트리거 볼륨", event `area:entered`; Req 8.7, 9.4).
 *
 * - Region: the current Region only changes when the character stands in another Region that is
 *   unlocked. Border strips between Regions and a locked Region's edge do not change it, so walking
 *   along a border does not repeat entries. A first entry is one whose Region is not yet in
 *   GameState's discovered Regions.
 * - Areas: an area is entered on the first tick the feet are inside it after a tick outside it (the
 *   first tick after a load counts, so a quest `reach` target the character stands in is met). It is a
 *   first entry when the area has never been entered in this save.
 *
 * Pure: no three.js, DOM or Math.random.
 */

import type { RegionId } from '../data/ids';

export interface RegionStep {
  /** Current Region after this tick. */
  readonly region: RegionId | null;
  /** Set when the Region changed this tick. */
  readonly entered: { readonly regionId: RegionId; readonly first: boolean } | null;
}

/**
 * One tick of Region tracking. `here` is the Region at the feet (null in a border strip); `unlocked`
 * tells whether a Region may be entered; `discovered` lists the Regions entered before.
 */
export function stepRegion(
  current: RegionId | null,
  here: RegionId | null,
  unlocked: (region: RegionId) => boolean,
  discovered: readonly RegionId[],
): RegionStep {
  if (here === null || here === current || !unlocked(here)) return { region: current, entered: null };
  return { region: here, entered: { regionId: here, first: !discovered.includes(here) } };
}

export interface AreaEntry {
  readonly id: string;
  readonly first: boolean;
}

/**
 * Areas in `inside` (this tick, in its order) that were not in `before` (last tick). `visited` tells
 * whether an area was entered before in this save; an id listed twice in `inside` is entered once.
 */
export function newAreaEntries(before: ReadonlySet<string>, inside: readonly string[], visited: (id: string) => boolean): AreaEntry[] {
  const out: AreaEntry[] = [];
  const seen = new Set<string>();
  for (const id of inside) {
    if (before.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, first: !visited(id) });
  }
  return out;
}

/** GameState `world.flags` key recording that an area was entered (Challenge_Area entry cinematics, maps). */
export function areaVisitedFlag(areaId: string): string {
  return `entered_${areaId}`;
}
