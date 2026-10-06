/*
 * Playthrough bot, vertical traversal (task 24.4; design "입력 전용 완주 봇" traverse.ts): the headless route bot's
 * climbs, glides and Updraft rides (tests/unit/helpers/routeBot.ts) on keyboard and mouse.
 * - Climb: from the wall foot, push into the wall (camera facing it, W) until `player.mode` is a climb mode, then W
 *   to the mantle; done once standing on the top. Before a climb the bot rests to full Stamina (Req 12.6).
 * - Glide: run off the ledge along its heading, and once falling past the coyote window press Space (glideDeploy →
 *   glide); then steer with the camera. Updraft: circle inside the column (a 3.2 m circle about its axis, turned in or
 *   out as the character drifts) until its top, then leave once the heading points at the landing.
 * - Between two harness reads (≥ 50 ms) the circle's steering keeps turning the camera at the circle's rate in small
 *   mouse steps (input only; no extra reads).
 */
import { angleDelta, yawFromDir } from '../../../src/core/math';
import type { AreaSpot, AreaUpdraftDef } from '../../../src/data/challengeAreas';
import type { Bot } from './bot';
import { flat, isClimbMode, isGlideMode, type Snap, type XZ } from './harness';
import { walkTo } from './navigate';

const GLIDE_SPEED = 9;
const CIRCLE_R = 3.2;

/** Rests (no input) until the Stamina is back to `min` (or the maximum) and not exhausted. */
export async function rest(bot: Bot, label: string, min = 95): Promise<Snap> {
  return bot.waitUntil(`${label}: Stamina`, (s) => s.player.stamina >= Math.min(min, s.player.staminaMax - 0.5) && !s.player.exhausted, 15_000);
}

/**
 * Walks to `foot`, pushes into the wall (yaw `face`) and climbs to the top (feet ≥ topY − 0.5, standing). Returns the
 * Stamina the climb used. Coming off the wall throws.
 */
export async function climb(bot: Bot, label: string, foot: XZ, face: number, topY: number, maxMs = 25_000): Promise<number> {
  await bot.settle();
  await walkTo(bot, label, foot, { radius: 0.45 });
  let s = bot.s;
  const before = s.player.stamina;
  let lowest = before;
  let started = false;
  const end = bot.now() + maxMs;
  for (;;) {
    s = await bot.frame();
    const mode = s.player.mode;
    if (isClimbMode(mode)) started = true;
    lowest = Math.min(lowest, s.player.stamina);
    if (started && (mode === 'grounded' || mode === 'landing') && s.player.pos.y > topY - 0.5) break;
    if (bot.now() > end) throw new Error(`${label}: not on top after ${maxMs} ms (at ${bot.where(s)}, Stamina ${s.player.stamina.toFixed(0)})`);
    // Past the mantle the feet may be airborne for a moment just above the top: wait for the landing there.
    if (started && !isClimbMode(mode) && s.player.pos.y < topY - 1.2) {
      throw new Error(`${label}: came off the wall at ${bot.where(s)} (Stamina ${s.player.stamina.toFixed(0)})`);
    }
    await bot.face(face);
    await bot.keys.move(['KeyW']);
  }
  await bot.keys.stop();
  return before - lowest;
}

/** Heading that keeps a glider circling inside an Updraft column (routeBot circleYaw, on a 3.2 m circle). */
function circleYaw(pos: XZ, vel: XZ, column: AreaUpdraftDef): { yaw: number; rate: number } {
  const dx = pos.x - column.center.x;
  const dz = pos.z - column.center.z;
  const d = Math.hypot(dx, dz);
  if (d > column.radius - 0.3 || d < 1e-3) return { yaw: yawFromDir(-dx, -dz), rate: 0 };
  const rx = dx / d;
  const rz = dz / d;
  const sgn = rx * vel.z - rz * vel.x >= 0 ? 1 : -1;
  const tx = -rz * sgn;
  const tz = rx * sgn;
  const alpha = Math.max(-0.9, Math.min(0.9, (d - CIRCLE_R) * 0.9));
  const yaw = yawFromDir(tx * Math.cos(alpha) - rx * Math.sin(alpha), tz * Math.cos(alpha) - rz * Math.sin(alpha));
  // Along the tangent (−rz·sgn, rx·sgn) the heading's yaw turns at −sgn · v / R.
  return { yaw, rate: (-sgn * GLIDE_SPEED) / CIRCLE_R };
}

/** Holds W while the camera keeps turning at `rate` rad/s for about one poll interval (small mouse steps). */
async function sweep(bot: Bot, yaw: number, rate: number): Promise<void> {
  await bot.face(yaw);
  await bot.keys.move(['KeyW']);
  if (rate === 0 || !bot.s.pointerLocked) return;
  for (let k = 0; k < 2; k++) {
    await bot.page.waitForTimeout(16);
    await bot.keys.turn(rate * 0.018, true);
  }
}

/** Runs off the ledge at `from` along its yaw and opens the glider once falling past the coyote window. */
async function takeOff(bot: Bot, label: string, from: AreaSpot, maxMs: number): Promise<Snap> {
  const end = bot.now() + maxMs;
  let fallAt: number | null = null;
  let lastSpace = 0;
  for (;;) {
    const s = await bot.frame();
    if (isGlideMode(s.player.mode)) return s;
    if (bot.now() > end) throw new Error(`${label}: the glider did not open (at ${bot.where(s)})`);
    await bot.face(from.yaw);
    await bot.keys.move(['KeyW']);
    if (s.player.mode === 'fall') {
      fallAt ??= bot.now();
      if (bot.now() - fallAt > 110 && bot.now() - lastSpace > 120) {
        lastSpace = bot.now();
        await bot.keys.tap('Space');
      }
    } else fallAt = null;
  }
}

/**
 * Updraft ride: walks to the take-off spot, runs off the ledge, opens the glider, steers into `column`, circles up
 * to its top, leaves once the heading points at `target` and glides there, until standing at about `landingY`.
 * Returns the Stamina used from the take-off to the landing.
 */
export async function glideUpdraft(
  bot: Bot, label: string, from: AreaSpot, column: AreaUpdraftDef, target: XZ, landingY: number, maxMs = 30_000,
): Promise<number> {
  await bot.settle();
  await walkTo(bot, label, from.pos, { radius: 0.35 });
  for (let i = 0; i < 6; i++) {
    await bot.face(from.yaw);
    await bot.frame();
  }
  const before = bot.s.player.stamina;
  let lowest = before;
  let s = await takeOff(bot, label, from, 6000);
  let exiting = false;
  const end = bot.now() + maxMs;
  for (;;) {
    s = await bot.frame();
    lowest = Math.min(lowest, s.player.stamina);
    const mode = s.player.mode;
    if (bot.now() > end) throw new Error(`${label}: glide not landed after ${maxMs} ms (at ${bot.where(s)})`);
    if (s.recovery.active) throw new Error(`${label}: fell into a recovery from ${bot.where(s)}`);
    if ((mode === 'grounded' || mode === 'landing') && Math.abs(s.player.pos.y - landingY) < 1.2) break;
    if (mode === 'grounded' || mode === 'landing') throw new Error(`${label}: landed at ${bot.where(s)}, not on the y ${landingY} ledge`);
    if (mode === 'fall') {
      // Brushed a wall or the landing's rim: keep aiming at the landing while the fall settles.
      await bot.face(yawFromDir(target.x - s.player.pos.x, target.z - s.player.pos.z));
      await bot.keys.move(['KeyW']);
      continue;
    }
    if (isClimbMode(mode)) {
      await bot.keys.move(['KeyW']); // caught a wall short of the landing: climb it up
      continue;
    }
    const pos = s.player.pos;
    const heading = yawFromDir(s.player.vel.x, s.player.vel.z);
    const toTarget = yawFromDir(target.x - pos.x, target.z - pos.z);
    if (!exiting && pos.y >= column.maxY - 0.3 && Math.abs(angleDelta(heading, toTarget)) < 0.45) exiting = true;
    bot.trace(`${label} gap ${bot.h.gapMs} read ${bot.h.readMs} ${mode} (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) axis ${flat(pos, column.center).toFixed(2)} m heading ${heading.toFixed(2)} stamina ${s.player.stamina.toFixed(0)}${exiting ? ' exiting' : ''}`);
    if (exiting) {
      await bot.face(toTarget);
      await bot.keys.move(['KeyW']);
    } else {
      const c = circleYaw(pos, s.player.vel, column);
      await sweep(bot, c.yaw + c.rate * 0.03, c.rate);
    }
  }
  await bot.idle(300);
  return before - lowest;
}

/**
 * Glides off a ledge toward a far point: walks to `from`, runs off along its yaw, opens the glider, steers toward
 * `toward` and holds on until standing again. A recovery on the way throws.
 */
export async function glideToward(bot: Bot, label: string, from: AreaSpot, toward: XZ, maxMs = 60_000): Promise<{ glided: boolean }> {
  await bot.settle();
  await walkTo(bot, label, from.pos, { radius: 0.35 });
  for (let i = 0; i < 6; i++) {
    await bot.face(from.yaw);
    await bot.frame();
  }
  let s = await takeOff(bot, label, from, 6000);
  const end = bot.now() + maxMs;
  for (;;) {
    s = await bot.frame();
    if (bot.now() > end) throw new Error(`${label}: not landed after ${maxMs} ms (at ${bot.where(s)})`);
    if (s.recovery.active) throw new Error(`${label}: a recovery (${s.recovery.reason ?? '?'}) at ${bot.where(s)}`);
    if (s.player.mode === 'grounded' || s.player.mode === 'landing') break;
    await bot.face(yawFromDir(toward.x - s.player.pos.x, toward.z - s.player.pos.z));
    await bot.keys.move(['KeyW']);
  }
  await bot.idle(500);
  return { glided: true };
}

/** Hops from step to step (centre, top height, half size); each step is up to 1 m higher than the last. */
export async function hopSteps(bot: Bot, label: string, steps: readonly { x: number; z: number; top: number; half: number }[]): Promise<void> {
  for (const st of steps) {
    const end = bot.now() + 10_000;
    let lastJump = 0;
    for (;;) {
      const s = await bot.frame();
      const me = s.player;
      const d = flat(me.pos, st);
      const on = me.grounded && Math.abs(me.pos.y - st.top) < 0.15 && d < st.half;
      if (on && d < Math.min(0.8, st.half - 0.4)) break;
      if (bot.now() > end) throw new Error(`${label}: missed the step at (${st.x}, ${st.z}) y ${st.top} (at ${bot.where(s)})`);
      await bot.face(yawFromDir(st.x - me.pos.x, st.z - me.pos.z));
      if (on) {
        // On the step: the last half metre to its centre in short pulses.
        await bot.keys.move(['KeyW']);
        await bot.page.waitForTimeout(40);
        await bot.keys.stop();
        continue;
      }
      await bot.keys.move(['KeyW']);
      if (me.grounded && me.pos.y < st.top - 0.3 && d < st.half + 1.4 && bot.now() - lastJump > 350) {
        lastJump = bot.now();
        await bot.keys.tap('Space');
      }
    }
  }
  await bot.keys.stop();
}

/** Lets go of a wall (C, the release key). */
export async function letGo(bot: Bot): Promise<void> {
  await bot.keys.stop();
  await bot.keys.tap('KeyC');
}
