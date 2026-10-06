/*
 * Enemy placements (design "스폰·캠프·재배치", data file `spawns.ts`; Req 10.7, 11.6, 27.4):
 * - `SpawnerDef`: one enemy or Elite at a spawn point. Without a camp its `respawn` rule decides whether it comes
 *   back after fast travel, a load or a Party_Wipe restart: `'roaming'` always (at its spawn, full HP), `'never'`
 *   not once defeated. The `'never'` spawners are the lone Elites, one per EliteId, so their defeat record is
 *   `GameState.world.elites`. A spawner with a `campId` follows its camp instead.
 * - `CampDef`: an Enemy_Camp (`camp_<region>_<n>`), in the world until cleared (`GameState.world.camps`); clearing
 *   it makes its locked Chest (`chest_<region>_<n>`, tier fine) openable.
 * - `EncounterGroupDef`: a quest encounter group, the id a Main_Quest `defeat` trigger and `spawnGroup` effect name.
 *   It is placed only when activated (the `spawnGroup` effect, or its `defeat` Objective becoming current) and is not
 *   recorded when cleared: the quest state records the progress, and a group beaten before its Objective is current
 *   comes back for it (Req 2.6).
 * The World content (task 20.1): two Enemy_Camps per main Region and the three hidden Elites (lone `'never'`
 * spawners); roaming packs arrive with later content. The other placements are the Hollowroot Shrine's groups (task 9.6: the R4 room and the Rootbound Warden), Cinder Alpha on
 * the Cinderspire summit (task 9.7), the Starfall Observatory's ring corridor waves and Sentinel Prime (task 9.8) and
 * the minimal route's other encounter groups (task 4.9), TEMPORARY Bramblekin stand-ins at route-tuned levels. The
 * Observatory's waves are called by their area (`byArea`), one after another. Heights given as
 * 'ground' are the terrain height; the others stand on the Challenge_Area floors.
 *
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */

import { yawFromDir } from '../core/math';
import type { Vec3 } from '../core/types';
import {
  CINDERSPIRE, HOLLOWROOT, HOLLOWROOT_ROOM_GROUP, HOLLOWROOT_SPAWNS, OBSERVATORY, OBSERVATORY_SPAWNS, OBSERVATORY_WAVE_GROUPS,
} from './challengeAreas';
import { ELITE_DEFS, isRegionEnemyLevel, type EnemyRegionId } from './enemies';
import { isEliteId, isEnemyId, type EliteId, type EnemyId } from './ids';
import { QUEST_SPOTS } from './quests';

/** A spawn point: its height is given, or `'ground'` for the terrain height at (x, z). */
export interface SpawnPoint {
  readonly x: number;
  readonly z: number;
  readonly y: number | 'ground';
}

interface SpawnerBase {
  /** `sp_<camp or group>_<n>`, or `sp_<region>_<n>` for lone spawners. */
  readonly id: string;
  readonly region: EnemyRegionId;
  /** Feet point; the EnemySystem snaps it to the ground it stands on. */
  readonly pos: SpawnPoint;
  /** Facing (rad, core/math yaw). */
  readonly yaw: number;
  /** Placement level: scales max HP and ATK (within the region's range, except the route stand-ins). */
  readonly level: number;
  /** Enemy_Camp or encounter group it belongs to; null for a lone spawner. */
  readonly campId: string | null;
}

export type SpawnerDef = SpawnerBase &
  (
    | { readonly kind: EnemyId | EliteId; readonly respawn: 'roaming' }
    /** A lone Elite: stays defeated (GameState.world.elites). */
    | { readonly kind: EliteId; readonly respawn: 'never' }
  );

export interface CampDef {
  /** `camp_<region>_<n>`: the campId of its spawners. */
  readonly id: string;
  readonly region: EnemyRegionId;
  /** The locked Chest it guards (`chest_<region>_<n>`), openable once the camp is cleared; null when none. */
  readonly chestId: string | null;
  /** Centre of the camp (x, z): its POI and map point (task 20.1); the members stand round it. */
  readonly center?: { readonly x: number; readonly z: number };
  /** Korean display name for the map and the POI list (task 20.1). */
  readonly name?: string;
}

export interface EncounterGroupDef {
  /** The quest `defeat` / `spawnGroup` group id: the campId of its spawners. */
  readonly id: string;
  readonly region: EnemyRegionId;
  /** TEMPORARY Bramblekin stand-ins of the minimal route (task 4.9): levels tuned for the route, not the region. */
  readonly standIn?: boolean;
  /**
   * A wave of a Challenge_Area wave room (the Observatory ring corridor): its area places it (`spawnGroup`) when its turn
   * comes, never a current `defeat` Objective (the last wave shares the room's `defeat` id, but only its turn calls it).
   */
  readonly byArea?: true;
}

const ground = (x: number, z: number): SpawnPoint => ({ x, z, y: 'ground' });
const on = (x: number, y: number, z: number): SpawnPoint => ({ x, z, y });
const S = QUEST_SPOTS;
const west = yawFromDir(-1, 0);

interface StandInGroup {
  readonly id: string;
  readonly region: EnemyRegionId;
  readonly level: number;
  readonly members: readonly (readonly [SpawnPoint, number])[];
}

/** Minimal route encounter groups (moved from routeStubs STUB_ENCOUNTERS), all Bramblekin. */
const ROUTE_GROUPS: readonly StandInGroup[] = [
  // ms1 ③ (onStart spawn): Bramblekin ×4 in Hobb's east field, facing the village.
  { id: 'village_raid', region: 'verdant', level: 1, members: [
    [ground(-213, 303), west], [ground(-211, 305.5), west], [ground(-214.5, 306.5), west], [ground(-210.5, 301.5), west],
  ] },
  // ms4 ④ (onStart spawn): the canyon pass between ws_ember and cinderspire_base.
  { id: 'ember_pass_pack', region: 'ember', level: 2, members: [
    [ground(S.emberPass.x + 2, S.emberPass.z - 2), yawFromDir(-1, 1)], [ground(S.emberPass.x - 2, S.emberPass.z + 2), yawFromDir(-1, 1)],
    [ground(S.emberPass.x + 4, S.emberPass.z + 3), yawFromDir(-1, 1)],
  ] },
  // ms6 ④ (onStart spawn) on the ridge shelf before the Observatory.
  { id: 'azure_ridge_pack', region: 'azure', level: 3, members: [
    [ground(S.azureRidge.x, S.azureRidge.z - 2), yawFromDir(-0.5, 1)], [ground(S.azureRidge.x + 3, S.azureRidge.z + 1), yawFromDir(-0.5, 1)],
    [ground(S.azureRidge.x - 3, S.azureRidge.z - 5), yawFromDir(-0.5, 1)],
  ] },
];

/** A Challenge_Area encounter group: its members' kinds, levels and spawn points (src/data/challengeAreas.ts). */
interface AreaGroup {
  readonly id: string;
  readonly region: EnemyRegionId;
  readonly members: readonly { readonly kind: EnemyId | EliteId; readonly level: number; readonly pos: Vec3; readonly yaw: number }[];
  /** A wave its Challenge_Area calls (EncounterGroupDef.byArea). */
  readonly byArea?: true;
}

const HR = HOLLOWROOT_SPAWNS.room;
const WARDEN = HOLLOWROOT.arena.guardian;
const ALPHA = CINDERSPIRE.arena.guardian;
const PRIME = OBSERVATORY.arena.guardian;
const OW = OBSERVATORY_SPAWNS;
/** The ring corridor's waves stand at the Azure range's middle level. */
const WAVE_LEVEL = 7;
const [WAVE_1, WAVE_LAST] = OBSERVATORY_WAVE_GROUPS;
const wave = (kind: EnemyId, points: readonly Vec3[]) => points.map((pos) => ({ kind, level: WAVE_LEVEL, pos, yaw: OW.yaw }));

/**
 * Hollowroot Shrine (task 9.6): ms3 ⑤ the R4 combat room (bramblekin ×4, thornspitter ×2, Req 12.1) and ms3 ⑥ the
 * Rootbound Warden in the R5 arena. Cinderspire (task 9.7): ms5 ④ Cinder Alpha on the summit arena (Req 12.2). Their
 * `defeat` Objectives activate them. Starfall Observatory (task 9.8): the ring corridor's two waves, called by the area
 * (wave 1 windcutter ×2 + aetherSentinel ×1, wave 2 aetherSentinel ×2 = ms7 ③ `observatory_waves`, Req 12.3), and ms7 ④
 * Sentinel Prime on the dome.
 */
const AREA_GROUPS: readonly AreaGroup[] = [
  { id: HOLLOWROOT_ROOM_GROUP, region: 'verdant', members: [
    ...HR.bramblekin.map((pos) => ({ kind: 'bramblekin' as const, level: 1, pos, yaw: HR.yaw })),
    ...HR.thornspitter.map((pos) => ({ kind: 'thornspitter' as const, level: 1, pos, yaw: HR.yaw })),
  ] },
  { id: 'rootboundWarden', region: 'verdant', members: [
    { kind: 'rootboundWarden', level: ELITE_DEFS.rootboundWarden.level, pos: WARDEN.pos, yaw: WARDEN.yaw },
  ] },
  { id: 'cinderAlpha', region: 'ember', members: [
    { kind: 'cinderAlpha', level: ELITE_DEFS.cinderAlpha.level, pos: ALPHA.pos, yaw: ALPHA.yaw },
  ] },
  { id: WAVE_1, region: 'azure', byArea: true, members: [
    ...wave('windcutter', OW.wave1.windcutter), ...wave('aetherSentinel', OW.wave1.aetherSentinel),
  ] },
  { id: WAVE_LAST, region: 'azure', byArea: true, members: wave('aetherSentinel', OW.wave2.aetherSentinel) },
  { id: 'sentinelPrime', region: 'azure', members: [
    { kind: 'sentinelPrime', level: ELITE_DEFS.sentinelPrime.level, pos: PRIME.pos, yaw: PRIME.yaw },
  ] },
];

// ── World content (task 20.1): two Enemy_Camps per main Region and the three hidden Elites ─────────────────────

/** A camp member: kind, level and its offset (m) from the camp centre. */
interface CampMember {
  readonly kind: EnemyId;
  readonly level: number;
  readonly dx: number;
  readonly dz: number;
}

interface CampSite {
  readonly camp: CampDef & { readonly center: { readonly x: number; readonly z: number } };
  /** Horizontal direction the members face (toward the usual approach). */
  readonly face: { readonly x: number; readonly z: number };
  readonly members: readonly CampMember[];
}

const m = (kind: EnemyId, level: number, dx: number, dz: number): CampMember => ({ kind, level, dx, dz });

/**
 * The design's core POI table: every camp guards its locked fine Chest (`chest_<region>_<n>` with the camp's serial).
 * The sites lie 50 m or more off the main path's walking legs, so passing by never wakes them (14 m detection cone).
 */
const CAMP_SITES: readonly CampSite[] = [
  // Thorn nest north of Hobb's field (sq_hobb's target, src/data/sideQuests.ts HOBB_NEST_CAMP).
  { camp: { id: 'camp_verdant_1', region: 'verdant', chestId: 'chest_verdant_1', center: { x: -170, z: 360 }, name: '가시 둥지' },
    face: { x: -0.8, z: -0.6 },
    members: [m('bramblekin', 2, -2, -2), m('bramblekin', 2, 2.2, -1.5), m('bramblekin', 2, 0, 2.6), m('thornspitter', 2, -4.5, 3)] },
  // Ruin camp north-west of the Elderbough.
  { camp: { id: 'camp_verdant_2', region: 'verdant', chestId: 'chest_verdant_2', center: { x: -330, z: 60 }, name: '폐허 야영지' },
    face: { x: 0.7, z: 0.7 },
    members: [m('bramblekin', 3, -2, 1.5), m('bramblekin', 3, 2, 1.5), m('mossbackBrute', 3, 0, -2.5), m('thornspitter', 3, 4.5, -3)] },
  // Raiders' camp on the slope east of Ashgate.
  { camp: { id: 'camp_ember_1', region: 'ember', chestId: 'chest_ember_1', center: { x: 150, z: 330 }, name: '약탈자 야영지' },
    face: { x: -0.4, z: -0.9 },
    members: [m('cinderHound', 5, -2.5, -1.5), m('cinderHound', 5, 2.5, -1.5), m('thornspitter', 4, 0, 3), m('ashWisp', 5, 4, 2)] },
  // Nest before the mine shaft east of camp_durga.
  { camp: { id: 'camp_ember_2', region: 'ember', chestId: 'chest_ember_2', center: { x: 300, z: 250 }, name: '갱도 앞 둥지' },
    face: { x: -0.9, z: -0.4 },
    members: [m('slagshell', 6, 0, 0), m('cinderHound', 6, -3, -2), m('cinderHound', 6, 3, -2), m('ashWisp', 6, 0, 4)] },
  // Wind-cliff nest west of the great arch.
  { camp: { id: 'camp_azure_1', region: 'azure', chestId: 'chest_azure_1', center: { x: -120, z: -230 }, name: '바람 절벽 둥지' },
    face: { x: 0.6, z: 0.8 },
    members: [m('windcutter', 7, -2.5, 0), m('windcutter', 7, 2.5, 0), m('windcutter', 7, 0, -3)] },
  // Old guard post beside the Observatory road, north of camp_oriel.
  { camp: { id: 'camp_azure_2', region: 'azure', chestId: 'chest_azure_2', center: { x: 60, z: -300 }, name: '옛 초소' },
    face: { x: -0.3, z: 0.95 },
    members: [m('aetherSentinel', 8, 0, -1.5), m('windcutter', 7, -3, 1.5), m('windcutter', 7, 3, 1.5)] },
];

/** The Enemy_Camps (Req 10.2, 10.7): two per main Region, each guarding its locked fine Chest. */
export const CAMPS: readonly CampDef[] = CAMP_SITES.map((s) => s.camp);

const CAMP_SPAWNERS: readonly SpawnerDef[] = CAMP_SITES.flatMap((s) =>
  s.members.map((mem, i): SpawnerDef => ({
    id: `sp_${s.camp.id}_${i + 1}`, region: s.camp.region, kind: mem.kind,
    pos: ground(s.camp.center.x + mem.dx, s.camp.center.z + mem.dz), yaw: yawFromDir(s.face.x, s.face.z), level: mem.level,
    campId: s.camp.id, respawn: 'roaming',
  })),
);

/**
 * The hidden Elites (design core POI table), lone `'never'` spawners at the top of their Region's range: Old Mossback in
 * the hidden forest behind the falls, Emberjaw in its den at the end of the Ember cave, Galeclaw on the floating ruin
 * isles' lower deck (y 118, the POI structure `isle_lower_deck` of src/data/pois.ts, reached only on its Updraft).
 */
export const HIDDEN_ELITE_SPAWNERS: readonly SpawnerDef[] = [
  { id: 'sp_verdant_1', region: 'verdant', kind: 'oldMossback', pos: ground(-430, 120), yaw: yawFromDir(1, 0.6), level: ELITE_DEFS.oldMossback.level, campId: null, respawn: 'never' },
  { id: 'sp_ember_1', region: 'ember', kind: 'emberjaw', pos: ground(300, 330), yaw: yawFromDir(-0.8, 0.6), level: ELITE_DEFS.emberjaw.level, campId: null, respawn: 'never' },
  { id: 'sp_azure_1', region: 'azure', kind: 'galeclaw', pos: on(-110, 118, -390), yaw: yawFromDir(0.6, 0.8), level: ELITE_DEFS.galeclaw.level, campId: null, respawn: 'never' },
];

export const ENCOUNTER_GROUPS: readonly EncounterGroupDef[] = [
  ...AREA_GROUPS.map((g): EncounterGroupDef => (g.byArea === true ? { id: g.id, region: g.region, byArea: true } : { id: g.id, region: g.region })),
  ...ROUTE_GROUPS.map((g) => ({ id: g.id, region: g.region, standIn: true })),
];

/** Every spawner: the camps' and encounter groups' members and the lone ones. Camp members' `respawn` is unused. */
export const SPAWNERS: readonly SpawnerDef[] = [
  ...AREA_GROUPS.flatMap((g) =>
    g.members.map((m, i): SpawnerDef => ({
      id: `sp_${g.id}_${i + 1}`, region: g.region, kind: m.kind, pos: on(m.pos.x, m.pos.y, m.pos.z), yaw: m.yaw, level: m.level,
      campId: g.id, respawn: 'roaming',
    })),
  ),
  ...ROUTE_GROUPS.flatMap((g) =>
    g.members.map(([pos, yaw], i): SpawnerDef => ({
      id: `sp_${g.id}_${i + 1}`, region: g.region, kind: 'bramblekin', pos, yaw, level: g.level, campId: g.id, respawn: 'roaming',
    })),
  ),
  ...CAMP_SPAWNERS, // task 20.1: the Enemy_Camps
  ...HIDDEN_ELITE_SPAWNERS, // task 20.1: the hidden Elites
];

/**
 * Data rules for placements, as messages (empty when valid): unique spawner ids; camp and group ids unique and
 * distinct; every `campId` names a camp or group of the same region, and every camp and group has members; kinds are
 * enemy or Elite ids; a lone Elite is `'never'` and appears once, and only lone Elites are `'never'`; levels are
 * integers within the region's range (route stand-in groups excepted); camp ids read `camp_<region>_<n>` and their
 * Chests `chest_<region>_<n>`.
 */
export function spawnDataErrors(
  spawners: readonly SpawnerDef[] = SPAWNERS,
  camps: readonly CampDef[] = CAMPS,
  groups: readonly EncounterGroupDef[] = ENCOUNTER_GROUPS,
): string[] {
  const errors: string[] = [];
  const owners = new Map<string, { region: EnemyRegionId; standIn: boolean; members: number }>();
  for (const c of camps) {
    if (owners.has(c.id)) errors.push(`duplicate camp or group id ${c.id}`);
    owners.set(c.id, { region: c.region, standIn: false, members: 0 });
    if (!new RegExp(`^camp_${c.region}_\\d+$`).test(c.id)) errors.push(`camp ${c.id}: id is not camp_${c.region}_<n>`);
    if (c.chestId !== null && !new RegExp(`^chest_${c.region}_\\d+$`).test(c.chestId)) {
      errors.push(`camp ${c.id}: chest ${c.chestId} is not chest_${c.region}_<n>`);
    }
  }
  for (const g of groups) {
    if (owners.has(g.id)) errors.push(`duplicate camp or group id ${g.id}`);
    owners.set(g.id, { region: g.region, standIn: g.standIn === true, members: 0 });
  }
  const ids = new Set<string>();
  const loneElites = new Set<EliteId>();
  for (const s of spawners) {
    if (ids.has(s.id)) errors.push(`duplicate spawner id ${s.id}`);
    ids.add(s.id);
    if (!isEnemyId(s.kind) && !isEliteId(s.kind)) errors.push(`spawner ${s.id}: unknown kind ${String(s.kind)}`);
    const owner = s.campId === null ? null : owners.get(s.campId);
    if (owner === undefined) errors.push(`spawner ${s.id}: unknown camp or group ${String(s.campId)}`);
    else if (owner !== null) {
      owner.members += 1;
      if (owner.region !== s.region) errors.push(`spawner ${s.id}: region ${s.region} differs from ${s.campId}'s ${owner.region}`);
    }
    if (s.respawn === 'never' && (s.campId !== null || !isEliteId(s.kind))) {
      errors.push(`spawner ${s.id}: only lone Elites are 'never'`);
    }
    if (s.campId === null && isEliteId(s.kind)) {
      if (s.respawn !== 'never') errors.push(`spawner ${s.id}: a lone Elite must be 'never'`);
      if (loneElites.has(s.kind)) errors.push(`spawner ${s.id}: Elite ${s.kind} is placed twice`);
      loneElites.add(s.kind);
    }
    const levelOk = owner?.standIn === true ? Number.isInteger(s.level) && s.level >= 1 : isRegionEnemyLevel(s.region, s.level);
    if (!levelOk) errors.push(`spawner ${s.id}: level ${s.level} is outside ${s.region}'s range`);
  }
  for (const [id, owner] of owners) if (owner.members === 0) errors.push(`${id} has no spawners`);
  return errors;
}
