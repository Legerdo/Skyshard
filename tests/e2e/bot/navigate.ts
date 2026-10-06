/*
 * Playthrough bot, getting around (task 24.4; design "입력 전용 완주 봇" navigate.ts): closed-loop waypoint
 * following on keyboard and mouse. Every frame turns the camera toward the next waypoint (movement is
 * camera-relative) and holds W (with Shift on long open-ground legs while the Stamina lasts); a waypoint counts as
 * reached within its radius, and the last metre to a tight radius goes in short W pulses.
 * - Stalls: 1.5 s without getting 0.3 m closer → jump every 0.6 s; 5 s → a stall is counted and the bot side-steps
 *   (W + A / D alternately) for 0.9 s; 20 s → Pause → "끼임 해제" (Req 20.8, at most twice per leg); 45 s → failure.
 * - Enemies engaging within 12 m are fought first (combat.ts), then the leg continues.
 * - Ground paths come from the heightfield (tests/unit/helpers/terrainPath.ts, as the headless route bot).
 * Also: talking to NPCs and using interaction targets (F once the prompt names the target), lift pads.
 */
import { yawFromDir } from '../../../src/core/math';
import { findGroundPath } from '../../unit/helpers/terrainPath';
import type { Bot } from './bot';
import { fightEngaged } from './combat';
import { engagedNear, flat, free, type Snap, type XZ } from './harness';
import type { MoveKey } from './keys';

export interface WalkOptions {
  radius?: number;
  /** A platform / arena centre for fights on the way (combat.ts anchor). */
  anchor?: XZ;
  /** Sprint on long legs (default false). */
  sprint?: boolean;
  /** Fight enemies that engage on the way (default true). */
  fight?: boolean;
  /** Keep the keys held at the end (default: stop). */
  keepMoving?: boolean;
  timeoutMs?: number;
}

/** Walks straight to `p`; returns the snapshot on arrival. */
export async function walkTo(bot: Bot, label: string, p: XZ, opts: WalkOptions = {}): Promise<Snap> {
  const radius = opts.radius ?? 1.2;
  const end = bot.now() + (opts.timeoutMs ?? 120_000);
  let best = Infinity;
  let bestAt = bot.now();
  let lastJump = 0;
  let detourUntil = 0;
  let nextDetour = Infinity;
  let detourKey: MoveKey = 'KeyA';
  let stalled = false;
  let unstucks = 0;
  bot.label = label;
  for (;;) {
    const s = await bot.frame();
    if (opts.fight !== false && engagedNear(s, 12) !== null) {
      await fightEngaged(bot, `${label} (fight on the way)`, opts.anchor ?? null);
      best = Infinity;
      bestAt = bot.now();
      continue;
    }
    const pos = s.player.pos;
    const d = flat(pos, p);
    if (d <= radius) break;
    if (!s.pointerLocked) await bot.ensureLock();
    const now = bot.now();
    if (d < best - 0.3) {
      best = d;
      bestAt = now;
      stalled = false;
      nextDetour = Infinity;
    }
    const since = now - bestAt;
    if (since > 5000 && !stalled) {
      stalled = true;
      bot.hooks?.stall(label, s);
      nextDetour = now;
    }
    if (now >= nextDetour) {
      // Side-step around whatever blocks the way, alternating sides every 4 s.
      detourKey = detourKey === 'KeyA' ? 'KeyD' : 'KeyA';
      detourUntil = now + 900;
      nextDetour = now + 4000;
    }
    if (since > 20_000 && unstucks < 2) {
      unstucks++;
      await bot.unstuck(label);
      best = Infinity;
      bestAt = bot.now();
      continue;
    }
    if (since > 45_000 || now > end) throw new Error(`${label}: stuck at ${bot.where(s)} heading to (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
    await bot.face(yawFromDir(p.x - pos.x, p.z - pos.z));
    const tight = radius < 0.8 && d < radius + 1.2;
    if (tight) {
      // Short pulses: ≈ 0.1–0.3 m each, re-aimed every frame.
      await bot.keys.move(['KeyW']);
      await bot.page.waitForTimeout(Math.max(18, Math.min(110, ((d - radius * 0.4) / 6) * 1000)));
      await bot.keys.stop();
      continue;
    }
    const sprint = opts.sprint === true && d > 8 && !s.player.exhausted && s.player.stamina > s.player.staminaMax * 0.45;
    await bot.keys.move(now < detourUntil ? ['KeyW', detourKey] : ['KeyW'], sprint);
    if (since > 1500 && now - lastJump > 600 && s.player.grounded) {
      lastJump = now;
      await bot.keys.tap('Space');
    }
  }
  if (opts.keepMoving !== true) await bot.keys.stop();
  return bot.s;
}

/** Walks through `points` in order (the last with `opts.radius`). */
export async function walk(bot: Bot, label: string, points: readonly XZ[], opts: WalkOptions = {}): Promise<Snap> {
  let s = bot.s;
  for (const [i, p] of points.entries()) {
    const last = i === points.length - 1;
    s = await walkTo(bot, label, p, { ...opts, radius: last ? opts.radius ?? 1.2 : Math.max(1.2, opts.radius ?? 1.2), keepMoving: !last });
  }
  await bot.keys.stop();
  return s;
}

/** Walks a heightfield path from here to (x, z) (sprinting on the long legs). */
export async function goTo(bot: Bot, label: string, to: XZ, opts: WalkOptions & { maxSlopeDeg?: number } = {}): Promise<Snap> {
  const s = await bot.settle();
  const from = { x: s.player.pos.x, z: s.player.pos.z };
  const path = findGroundPath(bot.terrain, from, to, { maxSlopeDeg: opts.maxSlopeDeg ?? 42 });
  if (path === null) throw new Error(`${label}: no ground path from ${bot.where(s)} to (${to.x}, ${to.z})`);
  return walk(bot, label, path.slice(1), { sprint: true, ...opts });
}

/**
 * Walks up to `at` and presses F once the prompt names target `kind:id` (moving closer while another target is
 * nearer). Returns the snapshot after the press.
 */
export async function interact(bot: Bot, label: string, kind: string, id: string, at: XZ, approach = 1.6): Promise<Snap> {
  await bot.settle();
  await walkTo(bot, label, at, { radius: approach });
  const end = bot.now() + 8000;
  let s = bot.s;
  for (;;) {
    s = await bot.frame();
    if (s.interact !== null && s.interact.kind === kind && s.interact.id === id) break;
    if (bot.now() > end) throw new Error(`${label}: no prompt for ${kind}:${id} at ${bot.where(s)} (offered: ${s.interact?.id ?? 'none'})`);
    const d = flat(s.player.pos, at);
    await bot.face(yawFromDir(at.x - s.player.pos.x, at.z - s.player.pos.z));
    if (d > 0.9) {
      await bot.keys.move(['KeyW']);
      await bot.page.waitForTimeout(40);
    }
    await bot.keys.stop();
  }
  await bot.keys.stop();
  await bot.keys.tap('KeyF');
  return bot.h.poll().then((snap) => (bot.s = snap));
}

/**
 * Talks to NPC `id`: walks to each of `spots` in turn (a walking NPC is somewhere on its route) until its prompt
 * shows, presses F and reads the dialogue to its end (the frame loop advances it); returns once play is free again.
 */
export async function talk(bot: Bot, label: string, id: string, spots: readonly XZ[], approach = 1.6): Promise<Snap> {
  await bot.settle();
  const end = bot.now() + 90_000;
  let s = bot.s;
  for (let round = 0; ; round++) {
    for (const spot of spots) {
      if (bot.now() > end) throw new Error(`${label}: could not reach ${id} (at ${bot.where(s)})`);
      s = await walkTo(bot, label, spot, { radius: approach, keepMoving: true });
      if (s.interact?.kind === 'npc' && s.interact.id === id) break;
      // Close to the spot: wait a moment for a walking NPC to come by (it stops within 2.5 m of the player).
      const until = bot.now() + (spots.length === 1 ? 3000 : 400);
      await bot.keys.stop();
      while (bot.now() < until && !(s.interact?.kind === 'npc' && s.interact.id === id)) s = await bot.frame();
      if (s.interact?.kind === 'npc' && s.interact.id === id) break;
    }
    if (s.interact?.kind === 'npc' && s.interact.id === id) break;
    if (round > 6) throw new Error(`${label}: ${id}'s prompt never showed (at ${bot.where(s)}; offered ${s.interact?.id ?? 'none'})`);
  }
  await bot.keys.stop();
  const before = s.dialogue?.dialogueId ?? null;
  let opened = false;
  for (let tries = 0; tries < 4 && !opened; tries++) {
    await bot.keys.tap('KeyF');
    const until = bot.now() + 1500;
    while (bot.now() < until) {
      s = await bot.h.poll();
      bot.s = s;
      if (s.dialogue !== null && s.dialogue.dialogueId !== before) {
        opened = true;
        break;
      }
    }
    if (!opened) s = await bot.frame();
  }
  if (!opened) throw new Error(`${label}: F did not open a dialogue with ${id} (at ${bot.where(s)})`);
  return bot.settle();
}

export interface LiftRef {
  readonly id: string;
  readonly pad: XZ;
  readonly to: XZ;
}

/** Rides a lift pad (a stand-in climb / glide / Updraft or a Challenge_Area lift): F on its pad, the fade, arrival. */
export async function ride(bot: Bot, label: string, lift: LiftRef): Promise<Snap> {
  await interact(bot, label, 'lift', lift.id, lift.pad, 1.0);
  let s = bot.s;
  const end = bot.now() + 6000;
  let faded = false;
  for (;;) {
    s = await bot.h.poll();
    bot.s = s;
    if (s.recovery.active) faded = true;
    if (faded && free(s) && flat(s.player.pos, lift.to) < 1.5) break;
    if (bot.now() > end) {
      if (flat(s.player.pos, lift.to) < 1.5) break;
      throw new Error(`${label}: lift ${lift.id} did not take the character to (${lift.to.x}, ${lift.to.z}) (at ${bot.where(s)})`);
    }
  }
  return bot.settle();
}

/**
 * Walks around a round obstacle (the Observatory's oculus): straight out from `center` to `radius`, then along
 * that circle the short way to angle `toAngle` (rad, from +x toward +z), in steps of at most 0.5 rad.
 */
export async function circleTo(bot: Bot, label: string, center: XZ, radius: number, toAngle: number, endRadius = radius): Promise<Snap> {
  const s = await bot.settle();
  const from = Math.atan2(s.player.pos.z - center.z, s.player.pos.x - center.x);
  let delta = toAngle - from;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(delta) / 0.5));
  const points: XZ[] = [];
  for (let k = 0; k <= n; k++) {
    const a = from + (delta * k) / n;
    const r = k === n ? endRadius : radius;
    points.push({ x: center.x + r * Math.cos(a), z: center.z + r * Math.sin(a) });
  }
  return walk(bot, label, points, { radius: 0.6 });
}
