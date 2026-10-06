/*
 * Cinematic definitions (design "Cinematics·Debug·Test Harness" 연출 데이터·연출 목록; Req 4.2, 4.5–4.7, 5.4, 5.5, 6.10,
 * 6.11, 7.1, 9.4, 12.5, 21.9, 22.3). Every contextual cinematic of the game is one CinematicDef here; the player in
 * src/cinematics/cinematicPlayer.ts plays them from their triggers (`CINEMATIC_TRIGGERS`).
 *
 * - Shots: `[t0, t1]` from `from` to `to` (pos, look, vertical fov) with an ease. Poses are offsets from the shot's
 *   `anchor` (a placement-table location or Landmark: its (x, ground y, z) with world axes; `player` / `caelith`: the
 *   entity's feet, followed every frame, axes turned by its facing latched at the shot's start). `face` turns the
 *   axes instead so +z points from the anchor toward `face`; `lookAnchor` measures `look` from another origin (same
 *   axes). Moving a Landmark in worldLayout / pois moves its cinematics with it.
 * - Events: `title` (a CINEMATIC_TITLES key), `sfx` / `music` (audio keys), `vfx` (preset), `worldChange` (a change the
 *   World applies then: `gate_ember`, `gate_azure`, `altar_pillar`, `seal_ring`, `seal_sanctum`, `starlit_stair`,
 *   `blight_cleared`) and `timeOfDay` (a TimeOfDayId the sky blends to over 4 s).
 * - `skippable` is exactly `duration > 3` and `letterbox` is off at 3 s or less (tests/unit/cinematics.test.ts).
 *
 * Pure data: no three.js / DOM.
 */

import type { Vec3 } from '../core/types';
import {
  CHALLENGE_AREA_IDS, CHALLENGE_AREA_NAMES, isLandmarkId, LANDMARK_IDS, LANDMARK_NAMES,
  type ChallengeAreaId, type CharacterId, type CinematicId, type LandmarkId,
} from './ids';
import { LANDMARK_SILHOUETTES } from './pois';
import type { TimeOfDayId } from './timeOfDay';
import { CHALLENGE_ENTRANCES, LOCATIONS, type LocationId } from './worldLayout';

/** Camera pose: `pos` / `look` are offsets (m) from the shot's anchor, `fov` the vertical field of view (°). */
export interface CamPose {
  readonly pos: Readonly<Vec3>;
  readonly look: Readonly<Vec3>;
  readonly fov: number;
}

export type ShotEase = 'linear' | 'inOut' | 'out';

/** A placement-table location or Landmark (static), or an entity followed while the shot plays. */
export type CinematicAnchor = LocationId | LandmarkId | 'player' | 'caelith';

export interface Shot {
  readonly t0: number;
  readonly t1: number;
  readonly from: CamPose;
  readonly to: CamPose;
  readonly ease: ShotEase;
  /** Origin of `pos` (and of `look` without `lookAnchor`); none: world coordinates. */
  readonly anchor?: CinematicAnchor;
  /** Turns the axes so +z points from the anchor toward this (latched at the shot's start). */
  readonly face?: CinematicAnchor;
  /** Origin of `look` when it differs from `anchor` (same axes). */
  readonly lookAnchor?: CinematicAnchor;
}

export type CinematicEventKind = 'title' | 'sfx' | 'music' | 'vfx' | 'worldChange' | 'timeOfDay';

export interface CinematicEvent {
  readonly t: number;
  readonly kind: CinematicEventKind;
  readonly data: string;
}

export interface CinematicDef {
  readonly id: CinematicId;
  /** Seconds. */
  readonly duration: number;
  readonly letterbox: boolean;
  readonly skippable: boolean;
  readonly shots: readonly Shot[];
  /** In time order. */
  readonly events: readonly CinematicEvent[];
  /** 'perSave': once per save (GameState.cinematicsSeen); 'perFight': once per Caelith fight (not saved). */
  readonly once: 'perSave' | 'perFight';
}

/** A skippable cinematic takes the skip hold from this long after its start (s, Req 21.11). */
export const CINEMATIC_SKIP_AFTER = 1;
/** Seconds the skip input must be held (Req 7.2, 21.11). */
export const CINEMATIC_SKIP_HOLD = 1;
/** Longer than this is skippable and letterboxed (Req 21.11). */
export const CINEMATIC_SKIPPABLE_OVER = 3;
/** A title card stays up this long after its event (or to the end). */
export const CINEMATIC_TITLE_SECONDS = 3;

/** Id prefix → allowed length (s), the design's 연출 목록 (Req 21.9 categories). */
export const CINEMATIC_LIMITS: readonly { readonly prefix: string; readonly min: number; readonly max: number }[] = [
  { prefix: 'cin_landmark_', min: 0.5, max: 3 },
  { prefix: 'cin_area_', min: 0.5, max: 3 },
  { prefix: 'cin_join_', min: 0.5, max: 6 },
  { prefix: 'cin_skyshard_', min: 0.5, max: 6 },
  { prefix: 'cin_altar', min: 0.5, max: 12 },
  { prefix: 'cin_boss_intro', min: 0.5, max: 5 },
  { prefix: 'cin_boss_phase', min: 0.5, max: 3 },
  { prefix: 'cin_ending', min: 20, max: 45 },
];

const AREA_SUBTITLES: Readonly<Record<ChallengeAreaId, string>> = {
  hollowroot: '뿌리 아래 잠든 신전',
  cinderspire: '타오르는 수정 첨탑',
  observatory: '별이 떨어진 산정 관측소',
};

/** Title cards: `title` event data → the lines shown (Korean; proper nouns English). */
export const CINEMATIC_TITLES: Readonly<Record<string, { readonly title: string; readonly subtitle: string }>> = {
  ...Object.fromEntries(LANDMARK_IDS.map((id) => [id, { title: LANDMARK_NAMES[id], subtitle: '새로운 장소를 발견했다' }])),
  ...Object.fromEntries(CHALLENGE_AREA_IDS.map((id) => [`area_${id}`, { title: CHALLENGE_AREA_NAMES[id], subtitle: AREA_SUBTITLES[id] }])),
  join_isla: { title: 'Isla', subtitle: 'Tide · 원거리 공격형 — 동료가 합류했다' },
  join_wren: { title: 'Wren', subtitle: 'Gale · 범위 제어형 — 동료가 합류했다' },
  join_talus: { title: 'Talus', subtitle: 'Terra · 방어/지원형 — 동료가 합류했다' },
  skyshard_1: { title: 'Skyshard 1', subtitle: 'Hollowroot Shrine의 빛이 깨어났다' },
  skyshard_2: { title: 'Skyshard 2', subtitle: 'Cinderspire의 불꽃이 잦아든다' },
  skyshard_3: { title: 'Skyshard 3', subtitle: '크레이터 중앙에 빛기둥이 솟는다' },
  altar: { title: 'Resonance Altar', subtitle: '세 Skyshard가 공명하며 Starlit Stair가 열린다' },
  caelith: { title: 'Caelith', subtitle: '추락한 별의 수호자' },
  boss_phase2: { title: 'Phase 2', subtitle: '별의 껍질이 다시 빛난다' },
  boss_phase3: { title: 'Final Phase', subtitle: '하늘이 별빛 밤으로 물든다' },
  ending_dawn: { title: '새벽', subtitle: 'Blight가 걷히고 세 Region 위로 해가 떠오른다' },
  ending_home: { title: 'Thistlewick', subtitle: '동료들이 마을 광장에 모였다' },
};

// ── Builders ────────────────────────────────────────────────────────────────

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const pose = (pos: Vec3, look: Vec3, fov = 50): CamPose => ({ pos, look, fov });

interface ShotSpec extends Omit<Shot, 't0' | 't1'> {
  readonly seconds: number;
}

/** Shots laid end to end from 0: each starts where the previous one ended. */
function timeline(specs: readonly ShotSpec[]): Shot[] {
  let t = 0;
  return specs.map(({ seconds, ...rest }) => {
    const shot: Shot = { ...rest, t0: t, t1: t + seconds };
    t += seconds;
    return shot;
  });
}

function def(
  id: CinematicId,
  shots: readonly ShotSpec[],
  events: readonly CinematicEvent[],
  once: CinematicDef['once'] = 'perSave',
): CinematicDef {
  const laid = timeline(shots);
  const duration = laid.length === 0 ? 0 : (laid[laid.length - 1]?.t1 ?? 0);
  const long = duration > CINEMATIC_SKIPPABLE_OVER;
  return { id, duration, letterbox: long, skippable: long, shots: laid, events: [...events].sort((a, b) => a.t - b.t), once };
}

const ev = (t: number, kind: CinematicEventKind, data: string): CinematicEvent => ({ t, kind, data });

// ── Landmarks (≤ 3 s, Req 9.4) ─────────────────────────────────────────────

/** From behind the Active_Character, rising while the Landmark fills the view; the name card follows. */
function landmarkCinematic(id: LandmarkId): CinematicDef {
  const s = LANDMARK_SILHOUETTES[id];
  const h = s.maxY - s.minY;
  return def(`cin_landmark_${id.slice(3)}`, [
    {
      seconds: 3, anchor: 'player', face: id, lookAnchor: id, ease: 'inOut',
      from: pose(v(1.2, 2.4, -4.5), v(0, h * 0.4, 0), 55),
      to: pose(v(2.2, 4.2, -7.5), v(0, h * 0.6, 0), 48),
    },
  ], [ev(0.4, 'title', id)]);
}

// ── Challenge_Area first entries (≤ 3 s, Req 12.5) ─────────────────────────

/** A sweep around the Active_Character into the space ahead, with the challenge's name. */
function areaCinematic(area: ChallengeAreaId): CinematicDef {
  return def(`cin_area_${area}`, [
    {
      seconds: 3, anchor: 'player', ease: 'inOut',
      from: pose(v(-4, 2.6, -4), v(0, 1.4, 6), 58),
      to: pose(v(4, 3.6, -3), v(0, 2, 10), 52),
    },
  ], [ev(0.3, 'title', `area_${area}`)]);
}

// ── Companions joining (≤ 6 s, Req 22.3) ───────────────────────────────────

function joinCinematic(character: Exclude<CharacterId, 'kairen'>): CinematicDef {
  return def(`cin_join_${character}`, [
    {
      seconds: 2.5, anchor: 'player', ease: 'out',
      from: pose(v(0.6, 1.5, 2.6), v(0, 1.35, 0), 42),
      to: pose(v(1.4, 1.8, 3.6), v(0, 1.3, 0), 46),
    },
    {
      seconds: 2.5, anchor: 'player', ease: 'inOut',
      from: pose(v(-2.2, 2.2, 4), v(0, 1.2, 0), 50),
      to: pose(v(-3, 2.8, 5.5), v(0, 1.3, 0), 52),
    },
  ], [ev(0.6, 'title', `join_${character}`), ev(0.2, 'vfx', `vfx_join_${character}`)]);
}

// ── Skyshards (≤ 6 s, Req 4.2, 4.5–4.7) ────────────────────────────────────

/** Close framing with the light burst; Skyshards 1 and 2 cut to their Blight_Barrier breaking for the last 1.5 s. */
const SKYSHARD_CLOSE: ShotSpec = {
  seconds: 4.5, anchor: 'player', ease: 'inOut',
  from: pose(v(1.2, 1.8, 3.2), v(0, 1.2, 0), 50),
  to: pose(v(0.6, 2.5, 2.2), v(0, 1.6, 0), 40),
};

function skyshardCinematic(index: 1 | 2 | 3): CinematicDef {
  const sky: Readonly<Record<1 | 2 | 3, TimeOfDayId>> = { 1: 'noon', 2: 'afternoon', 3: 'dusk' };
  const events = [ev(0.3, 'vfx', 'vfx_skyshard_burst'), ev(1.0, 'title', `skyshard_${index}`), ev(1.5, 'timeOfDay', sky[index])];
  if (index === 3) {
    // The altar's light pillar rises in the crater (Req 5.3).
    return def('cin_skyshard_3', [
      SKYSHARD_CLOSE,
      {
        seconds: 1.5, anchor: 'resonance_altar', ease: 'out',
        from: pose(v(60, 30, 90), v(0, 30, 0), 55),
        to: pose(v(50, 40, 80), v(0, 60, 0), 55),
      },
    ], [...events, ev(4.6, 'worldChange', 'altar_pillar')]);
  }
  const gate: LocationId = index === 1 ? 'gate_ember' : 'gate_azure';
  // gate_ember is crossed eastward (from Verdant Reach), gate_azure northward (from the crater).
  const side = index === 1 ? v(-20, 7, 8) : v(8, 9, 22);
  const sideTo = index === 1 ? v(-15, 6, 5) : v(5, 7, 16);
  return def(`cin_skyshard_${index}`, [
    SKYSHARD_CLOSE,
    { seconds: 1.5, anchor: gate, ease: 'out', from: pose(side, v(0, 5, 0), 55), to: pose(sideTo, v(0, 6, 0), 52) },
  ], [...events, ev(4.6, 'worldChange', gate)]);
}

// ── Resonance_Altar (≤ 12 s, Req 5.4, 5.5) ────────────────────────────────

const ALTAR = def('cin_altar', [
  // The altar takes the three Skyshards.
  { seconds: 3, anchor: 'resonance_altar', ease: 'inOut', from: pose(v(0, 6, 22), v(0, 4, 0), 50), to: pose(v(6, 9, 16), v(0, 7, 0), 46) },
  // Light beams from the three Landmarks converge; the seal ring turns.
  { seconds: 3, anchor: 'resonance_altar', ease: 'inOut', from: pose(v(70, 45, 90), v(0, 25, 0), 60), to: pose(v(45, 65, 70), v(0, 60, 0), 60) },
  // The floating structures rise, the sky turns to the starlit night.
  { seconds: 3, anchor: 'resonance_altar', ease: 'inOut', from: pose(v(25, 30, 45), v(0, 175, 0), 60), to: pose(v(12, 45, 32), v(0, 195, 0), 58) },
  // The Starlit_Stair forms from the crater up to the Sanctum.
  { seconds: 3, anchor: 'starlit_stair_start', ease: 'out', from: pose(v(-24, 10, 32), v(0, 30, -20), 60), to: pose(v(-12, 26, 22), v(0, 70, -30), 60) },
], [
  ev(0.4, 'title', 'altar'),
  ev(0.5, 'music', 'mus_altar'),
  ev(3, 'vfx', 'vfx_altar_beams'),
  ev(3.2, 'worldChange', 'seal_ring'),
  ev(6, 'timeOfDay', 'starNight'),
  ev(8.5, 'worldChange', 'seal_sanctum'),
  ev(11, 'worldChange', 'starlit_stair'),
]);

// ── Caelith (Req 6.10, 6.11, 6.7) ──────────────────────────────────────────

/** The arena's entrance side is −z (the hall lies north of it). */
const BOSS_INTRO = def('cin_boss_intro', [
  { seconds: 2.5, anchor: 'sanctum_arena', ease: 'inOut', from: pose(v(0, 5, -28), v(0, 8, 0), 55), to: pose(v(0, 4, -16), v(0, 6, 0), 50) },
  { seconds: 2.5, anchor: 'sanctum_arena', ease: 'out', from: pose(v(7, 1.8, -9), v(0, 5.5, 0), 50), to: pose(v(4, 1.4, -6.5), v(0, 6.5, 0), 46) },
], [ev(0.2, 'vfx', 'vfx_caelith_descend'), ev(2.6, 'title', 'caelith'), ev(2.5, 'music', 'mus_boss_p1')]);

function phaseCinematic(phase: 2 | 3): CinematicDef {
  const events = [ev(0.1, 'vfx', 'vfx_boss_roar'), ev(0.5, 'music', `mus_boss_p${phase}`), ev(0.8, 'title', `boss_phase${phase}`)];
  // The Final Phase starts by turning the arena sky to the starlit night (Req 6.7).
  if (phase === 3) events.unshift(ev(0, 'timeOfDay', 'starNight'));
  return def(`cin_boss_phase${phase}`, [
    { seconds: 3, anchor: 'caelith', face: 'player', ease: 'out', from: pose(v(3, 3, 10), v(0, 4.5, 0), 55), to: pose(v(4, 4.5, 13), v(0, 5, 0), 58) },
  ], events, 'perFight');
}

// ── Ending (20–45 s, target 35 s; Req 7.1) ─────────────────────────────────

const ENDING = def('cin_ending', [
  // Caelith's death.
  { seconds: 6, anchor: 'caelith', face: 'player', ease: 'inOut', from: pose(v(4, 3, 10), v(0, 4, 0), 50), to: pose(v(3, 6, 8), v(0, 3, 0), 46) },
  // The Skyshards' light pours out of the Sanctum.
  { seconds: 6, anchor: 'sanctum_arena', ease: 'inOut', from: pose(v(0, 20, -45), v(0, 10, 0), 55), to: pose(v(0, 45, -70), v(0, 35, 0), 60) },
  // The Blight fades from the three Regions.
  { seconds: 8, anchor: 'resonance_altar', ease: 'inOut', from: pose(v(-120, 160, 220), v(-250, 20, 300), 60), to: pose(v(120, 170, 160), v(250, 20, 180), 60) },
  // Sunrise over the Regions (the sun rises in the east).
  { seconds: 8, anchor: 'resonance_altar', ease: 'inOut', from: pose(v(-40, 150, 40), v(400, 120, 0), 62), to: pose(v(-20, 170, 20), v(400, 160, -40), 60) },
  // The companions gathered in Thistlewick.
  { seconds: 7, anchor: 'thistlewick', ease: 'out', from: pose(v(12, 6, 18), v(0, 2, 0), 50), to: pose(v(6, 4, 11), v(0, 1.8, 0), 45) },
], [
  ev(0.2, 'vfx', 'vfx_caelith_death'),
  ev(1, 'music', 'mus_ending'),
  ev(6.5, 'vfx', 'vfx_skyshard_release'),
  ev(7, 'title', 'ending_dawn'),
  ev(12.5, 'worldChange', 'blight_cleared'),
  ev(20, 'timeOfDay', 'sunrise'),
  ev(29, 'title', 'ending_home'),
]);

// ── Catalogue ───────────────────────────────────────────────────────────────

const ALL: readonly CinematicDef[] = [
  ...LANDMARK_IDS.map(landmarkCinematic),
  ...CHALLENGE_AREA_IDS.map(areaCinematic),
  joinCinematic('isla'),
  joinCinematic('wren'),
  joinCinematic('talus'),
  skyshardCinematic(1),
  skyshardCinematic(2),
  skyshardCinematic(3),
  ALTAR,
  BOSS_INTRO,
  phaseCinematic(2),
  phaseCinematic(3),
  ENDING,
];

export const CINEMATICS: Readonly<Record<string, CinematicDef>> = Object.fromEntries(ALL.map((d) => [d.id, d]));
export const CINEMATIC_IDS: readonly CinematicId[] = ALL.map((d) => d.id);

export function cinematicDef(id: string): CinematicDef | null {
  return CINEMATICS[id] ?? null;
}

/** Which cinematic each trigger plays (design 연출 목록 계기); null: none. */
export const CINEMATIC_TRIGGERS = {
  /** `'landmark:discovered'`. */
  landmark: (id: LandmarkId): CinematicId => `cin_landmark_${id.slice(3)}`,
  /** A `first` `'area:entered'` of a Challenge_Area. */
  area: (areaId: string, first: boolean): CinematicId | null =>
    first && (CHALLENGE_AREA_IDS as readonly string[]).includes(areaId) ? `cin_area_${areaId}` : null,
  /** `'party:joined'`. */
  join: (character: CharacterId): CinematicId | null => (character === 'kairen' ? null : `cin_join_${character}`),
  /** `'skyshard:acquired'`. */
  skyshard: (index: 1 | 2 | 3): CinematicId => `cin_skyshard_${index}`,
  /** `'altar:activated'`. */
  altar: (): CinematicId => 'cin_altar',
  /** `'boss:phaseChanged'`. */
  phase: (to: 2 | 3): CinematicId => `cin_boss_phase${to}`,
  /** `'boss:defeated'`. */
  ending: (): CinematicId => 'cin_ending',
} as const;

/** A static anchor's origin (location: (x, ground y, z); Landmark: its silhouette base), or null for an entity. */
export function staticAnchorOrigin(anchor: CinematicAnchor): Vec3 | null {
  if (anchor === 'player' || anchor === 'caelith') return null;
  if (isLandmarkId(anchor)) {
    const s = LANDMARK_SILHOUETTES[anchor];
    return { x: s.x, y: s.minY, z: s.z };
  }
  const l = LOCATIONS[anchor];
  return { x: l.x, y: l.groundY, z: l.z };
}

/** Challenge_Area entrances as anchors (debug and tests). */
export const AREA_ANCHORS: Readonly<Record<ChallengeAreaId, LocationId>> = CHALLENGE_ENTRANCES;
