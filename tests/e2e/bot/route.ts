/*
 * Playthrough bot, the main path (task 24.4; design "입력 전용 완주 봇" route.ts, Req 42.3): Main_Quest stages
 * ms1–ms10 as ordered Segments of moves, talks, puzzles, fights, Skyshards and lift rides, ported from the headless
 * route (tests/unit/route/fullRoute.test.ts) and played with keyboard and mouse only. Progress is read from the
 * harness (`mainStage`, `objective`, `skyshards`, `puzzles`); positions come from the static content data the game
 * itself places (src/data/*).
 * - Each Segment names the Objectives it may start in. After a Party_Wipe (the Defeat Screen's normal choice) the
 *   stage resumes at the first Segment listing the current Objective; area segments first walk the Challenge_Area's
 *   own route from the nearest point (riding its lifts), so a checkpoint restart finds its way back. Three wipes in
 *   a row in one stage fail the run (design).
 * - Besides the headless route the bot plays like a player would around it: it climbs the Breezewatch cliff a little
 *   and glides from the windmill top to the Elderbough for real (the design's canonical climb and glide; the lift
 *   pads stay the fallback), fights the thorn nest camp north of the village on the way to Breezewatch (the Enemy_Camp
 *   scene), and rests at the Hearth / Waystones on the path (they restore the party's HP).
 */
import { yawFromDir } from '../../../src/core/math';
import type { Vec3 } from '../../../src/core/types';
import {
  CINDERSPIRE, CINDERSPIRE_DEVICES, CINDERSPIRE_EXIT_END, CINDERSPIRE_Y, HOLLOWROOT, HOLLOWROOT_DEVICES, OBSERVATORY,
  OBSERVATORY_DOME_CENTER, OBSERVATORY_HALL_CENTER, OBSERVATORY_PEDESTALS, type AreaLiftDef, type RoutePoint,
} from '../../../src/data/challengeAreas';
import { observatoryOrder } from '../../../src/data/puzzles';
import { SKYSHARD_PEDESTALS } from '../../../src/data/routeStubs';
import { SANCTUM } from '../../../src/data/sanctum';
import { STARLIT_STAIR } from '../../../src/data/starlitStair';
import { TEMP_LIFTS } from '../../../src/data/tempRoute';
import { HEARTH_POS, HEARTH_TARGET_ID, npcPlacement } from '../../../src/data/village';
import { WAYSTONES } from '../../../src/data/waystones';
import { BREEZEWATCH_TERRACES } from '../../../src/world/terrain/features';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { WipeError, type Bot } from './bot';
import { bossFight } from './boss';
import { CHARACTER_OF, castSkill, fightGroups, strike, switchTo } from './combat';
import { flat, free, isClimbMode, type Snap, type XZ } from './harness';
import { circleTo, goTo, interact, ride, talk, walk, walkTo, type LiftRef } from './navigate';
import { climb, glideToward, glideUpdraft, hopSteps, letGo, rest } from './traverse';

/** A step list of one stage, started in one of `at` (the current Objective id). */
export interface Segment {
  readonly id: string;
  readonly at: readonly string[];
  /** Skip it when this holds (the character is already past it, e.g. after a checkpoint restart). */
  readonly skip?: (s: Snap) => boolean;
  readonly run: (bot: Bot, ctx: RouteContext) => Promise<void>;
}

export interface Stage {
  readonly id: string;
  readonly segments: readonly Segment[];
  /** Steps that may go wrong before the run fails (default MAX_STAGE_ERRORS). */
  readonly maxErrors?: number;
}

export interface RouteContext {
  /** The save's seed (the Observatory's constellation order). */
  seed: number;
  /** Progress callback (stage / segment ids) for logs and failure messages. */
  onSegment?: (stage: string, segment: string) => void;
  /** A stage has begun (play is free in it). */
  onStage?: (stage: string) => Promise<void>;
  /** Development runs: stop once this stage is complete. */
  stopAfter?: string;
}

const seg = (id: string, at: readonly string[], run: Segment['run'], skip?: Segment['skip']): Segment => ({ id, at, run, ...(skip ? { skip } : {}) });
/** Steps that may go wrong in one stage before the run fails (each is picked up again from the current Objective). */
const MAX_STAGE_ERRORS = 4;
const obj = (s: Snap): string => s.objective?.objectiveId ?? '';
const xz = (p: { x: number; z: number }): XZ => ({ x: p.x, z: p.z });

// ── Content lookups ─────────────────────────────────────────────────────────

function liftRef(id: string): LiftRef {
  const temp = TEMP_LIFTS.find((l) => l.id === id);
  if (temp !== undefined) return { id, pad: xz(temp.pad), to: xz(temp.to) };
  const area: AreaLiftDef | undefined = [...HOLLOWROOT.lifts, ...OBSERVATORY.lifts, ...CINDERSPIRE.lifts].find((l) => l.id === id);
  if (area === undefined) throw new Error(`route: no lift ${id}`);
  return { id, pad: xz(area.pad), to: xz(area.to.pos) };
}

/** Where NPC `id` can be met: its home, and for a walker its walk's far end. */
function npcSpots(id: string, gathered = false): XZ[] {
  const p = npcPlacement(id as Parameters<typeof npcPlacement>[0]);
  if (p === undefined) throw new Error(`route: no NPC ${id}`);
  if (gathered && p.gather !== undefined) return [p.gather];
  const spots: XZ[] = [xz(p.home)];
  if (p.ambient.kind === 'walk') {
    const to = p.ambient.to;
    spots.push({ x: (p.home.x + to.x) / 2, z: (p.home.z + to.z) / 2 }, xz(to));
  }
  return spots;
}

function pedestal(index: 1 | 2 | 3): XZ {
  const p = SKYSHARD_PEDESTALS.find((s) => s.index === index);
  if (p === undefined) throw new Error(`route: no pedestal ${index}`);
  return xz(p.pos);
}

const solved = (s: Snap, id: string): boolean => s.puzzles.some((p) => p.id === id && p.solved);
/** The Heat_Crystal wall's part is cooled (climbable for 10 s after a Tide hit). */
const heatWallCooled = (s: Snap): boolean =>
  s.puzzles.some((p) => p.id === 'pz_cinderspire_1' && (p.solved || p.parts.some((part) => part.state === 'cooled')));
const puzzleOpen = (s: Snap, id: string): boolean => s.puzzles.some((p) => p.id === id && p.open);
const puzzleStep = (s: Snap, id: string): number => s.puzzles.find((p) => p.id === id)?.step ?? 0;

/**
 * Walks a Challenge_Area's route from the point nearest the character up to index `to` (riding the lifts the route
 * marks), so a segment works from wherever a checkpoint restart put the party.
 */
async function followRoute(bot: Bot, label: string, route: readonly RoutePoint[], to: number, radius = 1.2): Promise<Snap> {
  const s = await bot.settle();
  const me = s.player.pos;
  let from = 0;
  let best = Infinity;
  for (let i = 0; i <= to; i++) {
    const p = route[i]?.pos;
    if (p === undefined) continue;
    const d = Math.hypot(p.x - me.x, (p.y - me.y) * 3, p.z - me.z);
    if (d < best) {
      best = d;
      from = i;
    }
  }
  // Onto the route first (a diagonal short cut to the next point can clip a doorway's jamb or a stair's side).
  const start = from < to ? route[from] : undefined;
  if (start !== undefined && start.lift === undefined && flat(me, start.pos) > 1.5) {
    await walkTo(bot, label, start.pos, { radius: 0.8, keepMoving: true });
  }
  for (let i = from + 1; i <= to; i++) {
    const point = route[i];
    if (point === undefined) continue;
    if (point.lift !== undefined) await ride(bot, `${label}: ${point.lift}`, liftRef(point.lift));
    else await walkTo(bot, label, point.pos, { radius: i === to ? radius : 0.8, keepMoving: i < to && route[i + 1]?.lift === undefined });
  }
  await bot.keys.stop();
  return bot.s;
}

/** Heals the party at a Waystone (and makes it the respawn point); a detour of a few metres on the path. */
async function waystone(bot: Bot, label: string, id: keyof typeof WAYSTONES): Promise<void> {
  const w = WAYSTONES[id];
  await goTo(bot, `${label}: ${id}`, w.spot);
  await interact(bot, `${label}: ${id}`, 'waystone', id, { x: w.x, z: w.z }, 1.8);
  await bot.idle(400);
}

/**
 * Retries a flaky traversal step up to `times` (resting in between); a Party_Wipe is passed on. `done` says the step's
 * goal was reached anyway (e.g. the fall after a glide brushed a rim still ended on the ledge).
 */
async function retry(bot: Bot, label: string, times: number, step: (attempt: number) => Promise<void>, done?: (s: Snap) => boolean): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await step(attempt);
      return;
    } catch (e) {
      if (e instanceof WipeError || attempt >= times) throw e;
      console.info(`[bot] ${label}: attempt ${attempt} failed (${(e as Error).message}); retrying`);
      bot.retries.push({ t: bot.s.simTime, label, message: (e as Error).message });
      await bot.keys.releaseAll();
      const s = await bot.settle();
      if (done?.(s) === true) return;
    }
  }
}

// ── Hollowroot Shrine (ms3) ─────────────────────────────────────────────────

const HR = HOLLOWROOT.route;
const hrIndex = (room: string, k = 0): number => {
  const all = HR.map((r, i) => ({ r, i })).filter(({ r }) => r.room === room);
  const hit = k < 0 ? all[all.length + k] : all[k];
  if (hit === undefined) throw new Error(`route: Hollowroot ${room}[${k}]`);
  return hit.i;
};
const HR_R1_FRONT = hrIndex('R1', 0);
const HR_R2 = hrIndex('R2', 0);
const HR_R3_ARRIVAL = hrIndex('R3', 0);
const HR_BEFORE_BOULDER = HR.findIndex((r) => flat(r.pos, HOLLOWROOT_DEVICES.boulder) < 2.5);
const HR_R4_ENTRY = hrIndex('R4', 0);
const HR_R4_CENTER = hrIndex('R4', 1);
const HR_R5_INNER = hrIndex('R5', 1);
const HR_R6_LAST = hrIndex('R6', -1);
const inHollowroot = (s: Snap): boolean => s.player.pos.y < 4 && flat(s.player.pos, HOLLOWROOT.bounds.center) < 80;

// ── Cinderspire (ms5) ───────────────────────────────────────────────────────

function cinderspireLegs() {
  const [, c1, u1, g1, h1, c3, u2, g2] = CINDERSPIRE.legs;
  const [column1, column2] = CINDERSPIRE.updrafts;
  if (c1?.kind !== 'climb' || u1?.kind !== 'updraft' || g1?.kind !== 'glide' || h1?.kind !== 'climb' || c3?.kind !== 'climb'
    || u2?.kind !== 'updraft' || g2?.kind !== 'glide' || column1 === undefined || column2 === undefined) throw new Error('route: Cinderspire legs');
  return { c1, u1, g1, h1, c3, u2, g2, column1, column2 };
}
const ledge = (id: string): Vec3 => {
  const l = CINDERSPIRE.ledges.find((x) => x.id === id);
  if (l === undefined) throw new Error(`route: no ledge ${id}`);
  return l.center;
};

// ── Starfall Observatory (ms7) ──────────────────────────────────────────────

const OBS = OBSERVATORY.route;
const obsPoints = (room: string): Vec3[] => OBS.filter((r) => r.room === room).map((r) => r.pos);
/** The hall centre (reach observatory_hall) and the ring lift's arrival (cp_observatory_1) on the area route. */
const OBS_HALL_CENTER = OBS.findIndex((r) => r.room === 'hall' && flat(r.pos, OBSERVATORY_HALL_CENTER) < 0.5);
const OBS_RING_ARRIVAL = OBS.findIndex((r) => r.lift === 'lift_observatory_up');
const inObservatory = (s: Snap): boolean =>
  s.player.pos.y > 125 && (flat(s.player.pos, OBSERVATORY_HALL_CENTER) < 40 || flat(s.player.pos, OBSERVATORY_DOME_CENTER) < 25);

// ── Breezewatch (ms2) ───────────────────────────────────────────────────────

const BW = BREEZEWATCH_TERRACES;
const BW_TOP = { x: LOCATIONS.breezewatch.x, z: LOCATIONS.breezewatch.z };
const ELDERBOUGH = { x: LOCATIONS.lm_elderbough.x, z: LOCATIONS.lm_elderbough.z };
/** The first cliff's foot (along 11 m from the Breezewatch pad toward the Elderbough) and its facing. */
const BW_CLIFF_FOOT = { x: BW.origin.x + BW.dir.x * 10.8, z: BW.origin.z + BW.dir.z * 10.8 };
const BW_CLIFF_FACE = yawFromDir(BW.dir.x, BW.dir.z);
const CAMP_VERDANT_1 = { x: -170, z: 360 };

/**
 * A short real climb on the first Breezewatch cliff (the scene-4 climb), then let go and step back. The cliff's foot
 * is a 45–60° apron (too steep to walk, not steep enough to grab), so the bot jumps into the ≥ 65° face above it
 * (an air attach) while pushing W.
 */
async function breezewatchClimb(bot: Bot): Promise<void> {
  const label = 'ms2 Breezewatch cliff';
  await walkTo(bot, label, BW_CLIFF_FOOT, { radius: 0.5 });
  const end = bot.now() + 6000;
  let climbedAt: number | null = null;
  let lastJump = 0;
  for (;;) {
    const s = await bot.frame();
    if (isClimbMode(s.player.mode) && climbedAt === null) climbedAt = bot.now();
    if (climbedAt !== null && bot.now() - climbedAt > 1300) break;
    if (climbedAt === null && bot.now() > end) {
      console.info(`[bot] ${label}: the cliff did not take a climb (at ${bot.where(s)}); going on`);
      await bot.keys.stop();
      return;
    }
    await bot.face(BW_CLIFF_FACE);
    await bot.keys.move(['KeyW']);
    if (climbedAt === null && s.player.grounded && bot.now() - lastJump > 900) {
      lastJump = bot.now();
      await bot.keys.tap('Space');
    }
  }
  await letGo(bot);
  await bot.waitUntil(`${label}: landing`, (s) => s.player.grounded && !isClimbMode(s.player.mode), 8000);
}

/** The real glide from the windmill top (y 64) to the Elderbough (Wren's passive stretches the Stamina). */
async function breezewatchGlide(bot: Bot): Promise<void> {
  const label = 'ms2 glide to the Elderbough';
  await switchTo(bot, label, 'wren');
  await walkTo(bot, label, BW_TOP, { radius: 0.5 });
  const heading = yawFromDir(ELDERBOUGH.x - BW_TOP.x, ELDERBOUGH.z - BW_TOP.z);
  const landingAim = { x: -228, z: 160 };
  await glideToward(bot, label, { pos: { x: BW_TOP.x, y: 64, z: BW_TOP.z }, yaw: heading }, landingAim, 45_000);
}

/** The Starlit_Stair from the crater floor to the Sanctum gate: tier 1 steps, starlit Updraft 1, tier 2, Updraft 2. */
async function starlitStair(bot: Bot): Promise<void> {
  const [s1, s2, s3, s4, l1, , s6, s7, l3] = STARLIT_STAIR.platforms;
  if (s1 === undefined || s2 === undefined || s3 === undefined || s4 === undefined || l1 === undefined || s6 === undefined || s7 === undefined || l3 === undefined) throw new Error('route: stair');
  const step = (p: typeof s1) => ({ x: p.x, z: p.z, top: p.topY, half: Math.min(p.halfX, p.halfZ) });
  if (bot.s.player.pos.y < 20) {
    await goTo(bot, 'ms8 stair start', { x: 20, z: -10 });
    await hopSteps(bot, 'ms8 tier 1', [s1, s2, s3, s4, l1].map(step));
    await ride(bot, 'ms8 updraft 1', liftRef('lift_stair_1'));
  }
  if (bot.s.player.pos.y < 100) {
    await hopSteps(bot, 'ms8 tier 2', [s6, s7, l3].map(step));
    await ride(bot, 'ms8 updraft 2', liftRef('lift_stair_2'));
  }
  await walk(bot, 'ms8 walkway', [{ x: 1, z: -52 }, { x: 0, z: -46 }, { x: 0, z: -40 }]);
}

// ── Stages ──────────────────────────────────────────────────────────────────

export const STAGES: readonly Stage[] = [
  {
    id: 'ms1',
    segments: [
      seg('maren', ['ms1_maren'], async (bot) => {
        await talk(bot, 'ms1 maren', 'maren', npcSpots('maren'));
      }),
      seg('isla', ['ms1_isla'], async (bot) => {
        await talk(bot, 'ms1 isla', 'isla', npcSpots('isla'));
      }),
      seg('raid', ['ms1_raid'], async (bot) => {
        await fightGroups(bot, 'ms1 raid', ['village_raid'], { objective: 'ms1_raid', approach: { x: -210, z: 304 } });
      }),
      seg('report', ['ms1_report'], async (bot) => {
        await talk(bot, 'ms1 report', 'maren', npcSpots('maren'));
      }),
    ],
  },
  {
    id: 'ms2',
    segments: [
      seg('hearth', ['ms2_breezewatch'], async (bot) => {
        await interact(bot, 'ms2 hearth', 'hearth', HEARTH_TARGET_ID, HEARTH_POS, 1.4);
        await bot.idle(400);
      }),
      seg('thorn nest camp', ['ms2_breezewatch'], async (bot) => {
        // The Enemy_Camp north of Hobb's field, on the way to Breezewatch (scene 7). A wipe here only skips it.
        try {
          await goTo(bot, 'ms2 thorn nest', { x: CAMP_VERDANT_1.x - 9, z: CAMP_VERDANT_1.z - 7 });
          await fightGroups(bot, 'ms2 thorn nest', ['camp_verdant_1'], { approach: CAMP_VERDANT_1, timeoutMs: 150_000 });
        } catch (e) {
          if (!(e instanceof WipeError)) throw e;
          console.info('[bot] ms2 thorn nest: Party_Wipe; the camp is skipped');
        }
      }),
      seg('breezewatch', ['ms2_breezewatch', 'ms2_windmill_top'], async (bot) => {
        await goTo(bot, 'ms2 breezewatch', { x: -126, z: 247 });
        await breezewatchClimb(bot);
      }),
      seg('windmill lift', ['ms2_breezewatch', 'ms2_windmill_top'], async (bot) => {
        await goTo(bot, 'ms2 windmill', { x: -124, z: 250 });
        await ride(bot, 'ms2 windmill', liftRef('lift_breezewatch'));
      }),
      seg('wren', ['ms2_wren'], async (bot) => {
        await talk(bot, 'ms2 wren', 'wren', npcSpots('wren'), 1.2);
      }),
      seg('glide', ['ms2_elderbough'], async (bot) => {
        const s = await bot.settle();
        if (s.player.pos.y > 60) {
          try {
            await breezewatchGlide(bot);
          } catch (e) {
            if (e instanceof WipeError) throw e;
            console.info(`[bot] ms2 glide: ${(e as Error).message}; using the glide pad`);
            await bot.settle();
            if (bot.s.player.pos.y > 60) await ride(bot, 'ms2 glide pad', liftRef('glide_breezewatch'));
          }
        }
        if (obj(bot.s) === 'ms2_elderbough') await goTo(bot, 'ms2 elderbough', { x: -228, z: 160 });
        if (obj(bot.s) === 'ms2_elderbough') await walkTo(bot, 'ms2 elderbough', { x: -236, z: 154 }, { radius: 2 });
        await bot.waitUntil('ms2 elderbough reached', (x) => obj(x) !== 'ms2_elderbough', 8000);
      }),
    ],
  },
  {
    id: 'ms3',
    segments: [
      seg('waystone', ['ms3_talus'], async (bot) => {
        await waystone(bot, 'ms3', 'ws_elderbough');
      }),
      seg('talus', ['ms3_talus'], async (bot) => {
        const home = npcSpots('talus')[0] ?? { x: -231.5, z: 127 };
        await goTo(bot, 'ms3 talus', { x: home.x + 2, z: home.z + 3 });
        await talk(bot, 'ms3 talus', 'talus', [home]);
      }),
      seg('bramble', ['ms3_bramble'], async (bot) => {
        await followRoute(bot, 'ms3 spiral ramp', HR, HR_R1_FRONT);
        await switchTo(bot, 'ms3 kairen', 'kairen');
        await strike(bot, 'ms3 bramble', HOLLOWROOT_DEVICES.bramble, (s) => solved(s, 'pz_hollowroot_1'), 2.2);
      }),
      seg('wind wheel', ['ms3_wind_wheel'], async (bot) => {
        await followRoute(bot, 'ms3 to the wind wheel', HR, HR_R2);
        const w = HOLLOWROOT_DEVICES.windWheel;
        await walkTo(bot, 'ms3 wind wheel', { x: w.x + 1.5, z: w.z }, { radius: 0.6 });
        await switchTo(bot, 'ms3 wren', 'wren');
        await retry(bot, 'ms3 wind wheel', 3, async () => {
          await castSkill(bot, 'ms3 wind wheel', w, (s) => solved(s, 'pz_hollowroot_2'), 4000);
        });
      }),
      seg('plate and boulder', ['ms3_pressure_plate'], async (bot) => {
        await followRoute(bot, 'ms3 root lift', HR, HR_R3_ARRIVAL);
        await switchTo(bot, 'ms3 talus', 'talus');
        const arrival = HR[HR_R3_ARRIVAL]?.pos ?? HOLLOWROOT_DEVICES.plate;
        await retry(bot, 'ms3 pillar', 3, async () => {
          // Back to the lift's arrival (the upper corridor) and cast the pillar onto the plate from there.
          if (Math.abs(bot.s.player.pos.y - arrival.y) < 2) await walkTo(bot, 'ms3 pillar spot', arrival, { radius: 0.8 });
          else await followRoute(bot, 'ms3 root lift', HR, HR_R3_ARRIVAL, 0.8);
          await castSkill(bot, 'ms3 pillar', HOLLOWROOT_DEVICES.plate, (s) => puzzleOpen(s, 'pz_hollowroot_3') || solved(s, 'pz_hollowroot_3'), 3500);
          await followRoute(bot, 'ms3 root door', HR, HR_BEFORE_BOULDER);
        });
        await strike(bot, 'ms3 boulder', HOLLOWROOT_DEVICES.boulder, (s) => solved(s, 'pz_hollowroot_3'), 2);
      }),
      seg('root room', ['ms3_root_room'], async (bot) => {
        await followRoute(bot, 'ms3 descent', HR, HR_R4_ENTRY);
        await switchTo(bot, 'ms3 kairen', 'kairen');
        const center = HR[HR_R4_CENTER]?.pos ?? HOLLOWROOT_DEVICES.boulder;
        await walkTo(bot, 'ms3 room', center, { radius: 3 });
        await fightGroups(bot, 'ms3 room', ['hollowroot_room'], { objective: 'ms3_root_room', anchor: center, approach: center });
      }),
      seg('warden', ['ms3_warden'], async (bot) => {
        await followRoute(bot, 'ms3 arena', HR, HR_R5_INNER);
        await fightGroups(bot, 'ms3 warden', ['rootboundWarden'], { objective: 'ms3_warden', anchor: HOLLOWROOT.arena.center, approach: HOLLOWROOT.arena.center });
      }),
      seg('skyshard', ['ms3_skyshard'], async (bot) => {
        await followRoute(bot, 'ms3 skyshard room', HR, HR_R6_LAST);
        await interact(bot, 'ms3 skyshard', 'skyshard', 'skyshard_1', pedestal(1));
        await bot.waitUntil('ms3 skyshard 1', (s) => s.skyshards >= 1 && free(s), 20_000);
      }),
    ],
  },
  {
    id: 'ms4',
    segments: [
      seg('exit lift', ['ms4_ashgate'], async (bot) => {
        await ride(bot, 'ms3 exit lift', liftRef(HOLLOWROOT.exitLift));
      }, (s) => !inHollowroot(s)),
      seg('ashgate', ['ms4_ashgate'], async (bot) => {
        await goTo(bot, 'ms4 ashgate', { x: 50, z: 300 });
        await walk(bot, 'ms4 through the gate', [{ x: 74, z: 296 }]);
      }),
      seg('bridge', ['ms4_bridge'], async (bot) => {
        await goTo(bot, 'ms4 bridge', { x: 168, z: 260 });
        await walk(bot, 'ms4 plank', [{ x: 212, z: 243.6 }]);
      }),
      seg('durga', ['ms4_durga'], async (bot) => {
        const home = npcSpots('durga')[0] ?? { x: 235, z: 235 };
        await goTo(bot, 'ms4 durga', { x: home.x - 2, z: home.z });
        await talk(bot, 'ms4 durga', 'durga', [home]);
      }),
      seg('pass', ['ms4_pack'], async (bot) => {
        await goTo(bot, 'ms4 pass', { x: 282, z: 168 });
        await fightGroups(bot, 'ms4 pack', ['ember_pass_pack'], { objective: 'ms4_pack', approach: { x: 290, z: 160 } });
      }),
      seg('waystone', ['ms4_cinderspire'], async (bot) => {
        await waystone(bot, 'ms4', 'ws_ember');
      }),
      seg('cinderspire', ['ms4_cinderspire'], async (bot) => {
        await goTo(bot, 'ms4 cinderspire', { x: 327, z: 123 });
      }),
    ],
  },
  {
    id: 'ms5',
    maxErrors: 8,
    segments: [
      // The legs run in height order; each is skipped once the character stands above its landing, so after a missed
      // glide or a fall (the stage resumes from the current Objective) the next leg up is whichever is due.
      seg('ramp and C1', ['ms5_ledge_1', 'ms5_ledge_2'], async (bot) => {
        const { c1 } = cinderspireLegs();
        if (bot.s.player.pos.y < CINDERSPIRE_Y.L1 - 1) await walk(bot, 'ms5 foot ramp', CINDERSPIRE.route.map((r) => r.pos));
        await rest(bot, 'ms5 L1');
        await climb(bot, 'ms5 C1', c1.foot, c1.face, c1.toY);
        await walk(bot, 'ms5 L2', [c1.top], { radius: 0.8 });
      }, (s) => s.player.pos.y > CINDERSPIRE_Y.L2 - 1.5),
      seg('U1 to L3', ['ms5_ledge_2'], async (bot) => {
        const { u1, g1, column1 } = cinderspireLegs();
        await rest(bot, 'ms5 L2');
        await glideUpdraft(bot, 'ms5 U1 → G1', u1.jump, column1, ledge('L3'), g1.toY);
      }, (s) => s.player.pos.y > CINDERSPIRE_Y.L3 - 1.5),
      seg('H1', ['ms5_ledge_2', 'ms5_heat_crystal', 'ms5_alpha'], async (bot) => {
        const { h1 } = cinderspireLegs();
        await switchTo(bot, 'ms5 isla', 'isla');
        await retry(bot, 'ms5 H1', 3, async () => {
          // From the wall's foot: cool it with Tide (10 s climbable) and climb at once.
          await walkTo(bot, 'ms5 H1 foot', h1.foot, { radius: 0.45 });
          await rest(bot, 'ms5 L3');
          await strike(bot, 'ms5 tide', CINDERSPIRE_DEVICES.heatWall, heatWallCooled, 3, 8000);
          await climb(bot, 'ms5 H1', h1.foot, h1.face, h1.toY);
        }, (s) => s.player.pos.y > CINDERSPIRE_Y.L4 - 1.5 || Math.abs(s.player.pos.y - CINDERSPIRE_Y.L3) > 1.5);
        await walk(bot, 'ms5 L4', [h1.top], { radius: 0.6 });
        await bot.idle(300);
      }, (s) => s.player.pos.y > CINDERSPIRE_Y.L4 - 1.5),
      seg('C3', ['ms5_alpha'], async (bot) => {
        const { c3 } = cinderspireLegs();
        await switchTo(bot, 'ms5 kairen', 'kairen');
        // C3's mantle onto L5 only finds room from the leg's foot line westward: line up 0.2 m west, 1.2 m back.
        const into = { x: Math.sin(c3.face), z: Math.cos(c3.face) };
        const foot = { x: c3.foot.x - into.z * 0.2, z: c3.foot.z + into.x * 0.2 };
        await walkTo(bot, 'ms5 C3 line-up', { x: foot.x - into.x * 1.2, z: foot.z - into.z * 1.2 }, { radius: 0.25 });
        await rest(bot, 'ms5 L4');
        await climb(bot, 'ms5 C3', foot, c3.face, c3.toY);
      }, (s) => s.player.pos.y > CINDERSPIRE_Y.L5 - 1.5),
      seg('U2 to the summit', ['ms5_alpha'], async (bot) => {
        const { u2, g2, column2 } = cinderspireLegs();
        await rest(bot, 'ms5 L5');
        await glideUpdraft(bot, 'ms5 U2 → G2', u2.jump, column2, CINDERSPIRE.arena.center, g2.toY);
      }, (s) => s.player.pos.y > CINDERSPIRE.arena.center.y - 2),
      seg('alpha', ['ms5_alpha'], async (bot) => {
        await fightGroups(bot, 'ms5 alpha', ['cinderAlpha'], { objective: 'ms5_alpha', anchor: CINDERSPIRE.arena.center, approach: CINDERSPIRE.arena.center });
      }),
      seg('skyshard', ['ms5_skyshard'], async (bot) => {
        await interact(bot, 'ms5 skyshard', 'skyshard', 'skyshard_2', pedestal(2));
        await bot.waitUntil('ms5 skyshard 2', (s) => s.skyshards >= 2 && free(s), 20_000);
      }),
    ],
  },
  {
    id: 'ms6',
    segments: [
      seg('exit stairs', ['ms6_pass'], async (bot) => {
        const c = CINDERSPIRE.arena.center;
        await walk(bot, 'ms5 exit stairs', [{ x: c.x - 15, z: c.z }, CINDERSPIRE_EXIT_END]);
        await bot.idle(400);
      }, (s) => s.player.pos.y < CINDERSPIRE.arena.center.y - 10),
      seg('crater and gate', ['ms6_pass'], async (bot) => {
        await goTo(bot, 'ms6 crater', { x: 0, z: -20 });
        await walk(bot, 'ms6 north rim', [{ x: 40, z: -115 }]);
        await walk(bot, 'ms6 gate', [{ x: 40, z: -134 }]);
      }),
      seg('waystone', ['ms6_oriel'], async (bot) => {
        await waystone(bot, 'ms6', 'ws_azure');
      }),
      seg('oriel', ['ms6_oriel'], async (bot) => {
        const home = npcSpots('oriel')[0] ?? { x: 37, z: -217 };
        await goTo(bot, 'ms6 oriel', { x: home.x + 1.5, z: home.z - 1 });
        await talk(bot, 'ms6 oriel', 'oriel', [home]);
      }),
      seg('wind glide', ['ms6_wind_ridge'], async (bot) => {
        await ride(bot, 'ms6 wind glide', liftRef('glide_oriel'));
      }),
      seg('ridge', ['ms6_pack'], async (bot) => {
        if (flat(bot.s.player.pos, liftRef('lift_azure_ridge').pad) < 12) await ride(bot, 'ms6 ridge climb', liftRef('lift_azure_ridge'));
        await fightGroups(bot, 'ms6 pack', ['azure_ridge_pack'], { objective: 'ms6_pack', approach: { x: 125, z: -340 } });
      }),
    ],
  },
  {
    id: 'ms7',
    segments: [
      seg('plateau', ['ms7_hall'], async (bot) => {
        await goTo(bot, 'ms7 cliff', { x: 121, z: -355 });
        await ride(bot, 'ms7 plateau', liftRef('lift_observatory_cliff'));
      }, inObservatory),
      seg('hall', ['ms7_hall', 'ms7_constellation'], async (bot) => {
        await followRoute(bot, 'ms7 hall', OBS, OBS_HALL_CENTER);
        await bot.idle(300);
      }),
      seg('constellation', ['ms7_constellation'], async (bot, ctx) => {
        const order = observatoryOrder(ctx.seed);
        await retry(bot, 'ms7 constellation', 4, async () => {
          for (const [i, element] of order.entries()) {
            const at = OBSERVATORY_PEDESTALS.find((p) => p.element === element)?.pos;
            const who = CHARACTER_OF[element];
            if (at === undefined || who === undefined) throw new Error(`ms7: no pedestal for ${element}`);
            await switchTo(bot, `ms7 step ${i + 1}`, who);
            await strike(bot, `ms7 pedestal ${i + 1}`, at, (s) => puzzleStep(s, 'pz_observatory_1') > i || solved(s, 'pz_observatory_1'), 1.9, 8000);
          }
          await bot.waitUntil('ms7 constellation solved', (s) => solved(s, 'pz_observatory_1'), 3000);
        });
      }),
      seg('ring lift', ['ms7_waves'], async (bot) => {
        await followRoute(bot, 'ms7 ring lift', OBS, OBS_RING_ARRIVAL);
      }, (s) => s.player.pos.y > 137),
      seg('waves', ['ms7_waves'], async (bot) => {
        await switchTo(bot, 'ms7 kairen', 'kairen');
        const ring = obsPoints('ring');
        const into = ring[1] ?? ring[0];
        if (into !== undefined) await walkTo(bot, 'ms7 into the corridor', into, { radius: 0.5 });
        await fightGroups(bot, 'ms7 waves', ['observatory_wave_1', 'observatory_waves'], {
          objective: 'ms7_waves', anchor: OBSERVATORY_HALL_CENTER, timeoutMs: 300_000,
        });
      }),
      seg('prime', ['ms7_prime'], async (bot) => {
        const rune = OBSERVATORY.checkpoints[1]?.spot.pos ?? OBSERVATORY_HALL_CENTER;
        if (bot.s.player.pos.y < 145) {
          await circleTo(bot, 'ms7 to the dome stairs', OBSERVATORY_HALL_CENTER, 8.5, 0, flat(rune, OBSERVATORY_HALL_CENTER));
          await walk(bot, 'ms7 dome stairs', obsPoints('stair'), { anchor: OBSERVATORY.arena.center });
        }
        await fightGroups(bot, 'ms7 prime', ['sentinelPrime'], { objective: 'ms7_prime', anchor: OBSERVATORY.arena.center, approach: OBSERVATORY.arena.center });
      }),
      seg('skyshard', ['ms7_skyshard'], async (bot) => {
        await interact(bot, 'ms7 skyshard', 'skyshard', 'skyshard_3', pedestal(3));
        await bot.waitUntil('ms7 skyshard 3', (s) => s.skyshards >= 3 && free(s), 20_000);
      }),
    ],
  },
  {
    id: 'ms8',
    segments: [
      seg('balcony glide', ['ms8_light_pillar'], async (bot) => {
        await walk(bot, 'ms7 balcony', obsPoints('dome').slice(-1));
        await rest(bot, 'ms7 balcony', 100);
        await glideToward(bot, 'ms7 exit glide', OBSERVATORY.exitGlide.start, OBSERVATORY.exitGlide.toward);
      }, (s) => s.player.pos.y < 145 || flat(s.player.pos, OBSERVATORY_DOME_CENTER) > 40),
      seg('crater', ['ms8_light_pillar'], async (bot) => {
        await goTo(bot, 'ms8 down to gate_azure', { x: 40, z: -134 });
        await walk(bot, 'ms8 north rim', [{ x: 40, z: -115 }]);
        await goTo(bot, 'ms8 crater', { x: 0, z: -24 });
        await walk(bot, 'ms8 pillar', [{ x: 0, z: -9 }]);
      }),
      seg('altar', ['ms8_altar', 'ms8_light_pillar'], async (bot) => {
        await interact(bot, 'ms8 altar', 'altar', 'resonance_altar', { x: 0, z: 0 }, 2.2);
        await bot.waitUntil('ms8 altar', (s) => s.altarActivated && free(s), 30_000);
      }),
      seg('starlit stair', ['ms8_stair'], async (bot) => {
        await starlitStair(bot);
      }),
    ],
  },
  {
    id: 'ms9',
    segments: [
      seg('mural', ['ms9_mural'], async (bot) => {
        // A Continue restores the last Safe_Position on the crater floor: climb the Starlit_Stair again first.
        if (bot.s.player.pos.y < 150) await starlitStair(bot);
        await walk(bot, 'ms9 hall', [{ x: 0, z: -30 }, { x: 0, z: -16 }]);
        await interact(bot, 'ms9 mural', 'mural', 'sanctum_mural', SANCTUM.mural.pos, 2.2);
        await bot.waitUntil('ms9 mural', (s) => obj(s) !== 'ms9_mural' && free(s), 20_000);
      }),
      seg('arena', ['ms9_arena'], async (bot) => {
        await walk(bot, 'ms9 arena', [{ x: 0, z: -4 }, { x: 0, z: 6 }]);
      }),
      seg('caelith', ['ms9_arena', 'ms9_caelith'], async (bot) => {
        await bossFight(bot, 'ms9 caelith');
      }),
    ],
  },
  {
    id: 'ms10',
    segments: [
      seg('victory', ['ms10_ending', 'ms10_return'], async (bot) => {
        await bot.waitUntil('ms10 victory screen', (x) => x.screen === 'victory', 120_000);
        // The Victory scene is shot ~1 s after it shows; keep polling (the shot is taken between polls).
        const shown = bot.now();
        while (bot.now() - shown < 2000) await bot.frame();
        const button = bot.page.getByRole('button', { name: '탐험 계속', exact: true });
        for (let tries = 0; bot.s.screens.includes('victory'); tries++) {
          if (tries >= 3) throw new Error(`ms10: "탐험 계속" did not close the Victory Screen (screens ${bot.s.screens.join(' > ')})`);
          // A mouse click on the button; else the keyboard confirm on the focused button (Enter), as a player might.
          const clicked = await button.click({ timeout: 4000 }).then(() => true, async (e: unknown) => {
            // What covers the button (read-only DOM geometry, for the report).
            const geometry = await bot.page.evaluate(() => {
              const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('탐험 계속'));
              if (b === undefined) return 'no button';
              const r = b.getBoundingClientRect();
              const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              const panel = b.closest('section')?.getBoundingClientRect();
              const modal = b.closest('.ui-modal') as HTMLElement | null;
              return JSON.stringify({
                button: [r.x, r.y, r.width, r.height].map(Math.round), top: top?.className ?? null,
                panel: panel === undefined ? null : [panel.x, panel.y, panel.width, panel.height].map(Math.round),
                modalScroll: modal === null ? null : [modal.scrollTop, modal.scrollHeight, modal.clientHeight],
                viewport: [innerWidth, innerHeight],
              });
            });
            console.info(`[bot] ms10 탐험 계속: the click did not go through: ${String((e as Error).message).split('\n')[0]}; ${geometry}`);
            return false;
          });
          if (!clicked || tries > 0) {
            await button.focus().catch(() => undefined);
            await bot.page.keyboard.press('Enter');
          }
          await bot.keys.afterUiClick();
          const until = bot.now() + 5000;
          while (bot.now() < until && bot.s.screens.includes('victory')) await bot.frame();
          console.info(`[bot] ms10 탐험 계속 (try ${tries + 1}): screens ${bot.s.screens.join(' > ')}`);
        }
        await bot.settle();
      }),
      seg('maren', ['ms10_return', 'ms10_maren'], async (bot) => {
        if (obj(bot.s) === 'ms10_return') await goTo(bot, 'ms10 return', { x: LOCATIONS.thistlewick.x, z: LOCATIONS.thistlewick.z });
        await talk(bot, 'ms10 maren', 'maren', [...npcSpots('maren', true), ...npcSpots('maren')]);
      }),
    ],
  },
];

/**
 * Plays the stages in order. Each segment runs once, in order, while its stage is current; after a Party_Wipe the
 * stage resumes at the first segment that lists the current Objective (three wipes in a row in a stage fail).
 */
export async function playRoute(bot: Bot, ctx: RouteContext): Promise<void> {
  if (OBS_HALL_CENTER < 0 || OBS_RING_ARRIVAL < 0 || HR_BEFORE_BOULDER < 0) throw new Error('route: area route points not found');
  // A Continue starts at the saved stage.
  const first = STAGES.findIndex((x) => x.id === bot.s.mainStage);
  if (first < 0) throw new Error(`route: unknown stage ${bot.s.mainStage}`);
  for (const stage of STAGES.slice(first)) {
    let s = await bot.frame();
    if (s.mainStage !== stage.id) throw new Error(`route: expected stage ${stage.id}, the game is at ${s.mainStage}/${obj(s)}`);
    await ctx.onStage?.(stage.id);
    let i = 0;
    let wipes = 0;
    let errors = 0;
    while (i < stage.segments.length) {
      const segment = stage.segments[i];
      if (segment === undefined) break;
      s = bot.s;
      const current = obj(s);
      if (s.mainStage !== stage.id && s.screen !== 'victory') break; // the stage is done
      if (!segment.at.includes(current) || segment.skip?.(s) === true) {
        i++;
        continue;
      }
      bot.label = `${stage.id} ${segment.id}`;
      ctx.onSegment?.(stage.id, segment.id);
      try {
        await segment.run(bot, ctx);
        wipes = 0;
        i++;
      } catch (e) {
        const wiped = e instanceof WipeError;
        const message = (e as Error).message;
        if (wiped) {
          wipes++;
          if (wipes >= 3) throw new Error(`route: three Party_Wipes in a row in ${stage.id} (${message})`);
        } else {
          // A step that went wrong (a missed glide, a fall): pick the stage up again from where the character is.
          errors++;
          bot.retries.push({ t: bot.s.simTime, label: `${stage.id} ${segment.id}`, message });
          if (errors > (stage.maxErrors ?? MAX_STAGE_ERRORS)) throw new Error(`[${stage.id} ${segment.id}] ${message}`, { cause: e });
        }
        console.info(`[bot] ${stage.id} ${segment.id}: ${message}`);
        await bot.keys.releaseAll();
        if (!bot.s.screens.includes('victory')) await bot.settle();
        const now = obj(bot.s);
        const resume = stage.segments.findIndex((x) => x.at.includes(now) && x.skip?.(bot.s) !== true);
        console.info(`[bot] ${stage.id} ${segment.id}: ${message}; resuming at ${stage.segments[resume]?.id ?? '(none)'}`);
        if (resume >= 0) i = resume;
        else if (!wiped) throw new Error(`[${stage.id} ${segment.id}] ${message} (no segment to resume at for ${now})`, { cause: e });
      }
    }
    // Wait for the stage to hand over (its last Objective may complete a moment after the last step).
    const next = STAGES[STAGES.indexOf(stage) + 1]?.id;
    await bot.waitUntil(`${stage.id} complete`, (x) => (next === undefined ? x.mainDone : x.mainStage === next || x.screen === 'victory' && next === 'ms10'), 30_000);
    if (ctx.stopAfter === stage.id) throw new Error(`stopped after ${stage.id} (SKYSHARD_BOT_STOP)`);
  }
}
