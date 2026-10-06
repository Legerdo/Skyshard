/*
 * Playthrough bot, the Caelith fight (task 24.4; design "입력 전용 완주 봇" boss.ts, Req 6.x): the headless route
 * bot's bossFight (tests/unit/helpers/routeBot.ts) reading the arena through the Test_Harness boss view (Caelith's
 * feet, the Telegraph areas on the floor, the Astral Sweep ring, the starShards in flight, the Starshell):
 * - a Telegraph area covering the character (with a step of margin): run out of it (the camera-relative key nearest
 *   the escape direction) and Dodge as it lands (within its last 0.22 s: the 0.25 s i-frames cover the hit);
 * - the Astral Sweep ring (Final Phase): stop attacking while it is announced, and jump so the feet are above
 *   0.8 m as its band passes (the take-off is timed from the ring's radius and 14 m/s, between two reads if need be);
 * - a starShard about to hit: side-step and Dodge; the starShards aim lines: side-step;
 * - otherwise close in and swing, with Skill / Burst when ready (plain hits break the Starshell in Phases 2 and 3);
 * - a Party_Wipe: the Defeat Screen's "현재 Phase부터 재도전" (the frame loop) and the fight goes on (Req 6.13).
 */
import { angleDelta, yawFromDir } from '../../../src/core/math';
import { ARENA } from '../../../src/data/boss';
import { SANCTUM } from '../../../src/data/sanctum';
import { WipeError, type Bot } from './bot';
import { abilities, switchIfLow } from './combat';
import { flat, type Snap, type SnapBoss, type XZ } from './harness';
import type { MoveKey } from './keys';

type Telegraph = SnapBoss['telegraphs'][number];

const RING_SPEED = 14;
/** Jump timing: the feet are above 0.8 m from 0.12 s to 0.55 s after the take-off; aim the band's arrival at 0.25 s. */
const RING_LEAD = 0.25;

/** Arena floor sector (0–7, 0 north at the entrance, clockwise) under (x, z) (src/boss/bossEncounter.ts sectorOf). */
function sectorAt(p: XZ): number | null {
  const c = SANCTUM.arena.center;
  const dx = p.x - c.x;
  const dz = p.z - c.z;
  if (!(Math.hypot(dx, dz) <= SANCTUM.arena.radius)) return null;
  let deg = dx === 0 && dz === 0 ? 0 : (Math.atan2(dx, -dz) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  const size = 360 / ARENA.sectors;
  return Math.floor(((deg + size / 2) % 360) / size);
}

/** Whether Telegraph area `t` covers the character at `p`, with a step of margin. */
function covers(t: Telegraph, p: XZ): boolean {
  const margin = 0.4 + 0.6;
  const dx = p.x - t.center.x;
  const dz = p.z - t.center.z;
  const r = Math.hypot(dx, dz);
  switch (t.shape) {
    case 'circle':
      return r < t.radius + margin;
    case 'sector': {
      if (r > t.radius + margin) return false;
      if (r < 1) return true;
      const off = Math.abs(angleDelta(t.yaw, yawFromDir(dx, dz)));
      return off < (t.angleDeg / 2) * (Math.PI / 180) + 0.35;
    }
    case 'line': {
      const fx = Math.sin(t.yaw);
      const fz = Math.cos(t.yaw);
      const along = dx * fx + dz * fz;
      return along > -1 && along < t.length + 1 && Math.abs(dx * fz - dz * fx) < t.width / 2 + margin;
    }
    case 'arenaSector':
      return sectorAt(p) === t.sector;
    default:
      return false;
  }
}

/** World direction out of Telegraph area `t` from `p`. */
function escape(t: Telegraph, p: XZ): XZ {
  const dx = p.x - t.center.x;
  const dz = p.z - t.center.z;
  const r = Math.hypot(dx, dz);
  if (t.shape === 'line') {
    const side = dx * Math.cos(t.yaw) - dz * Math.sin(t.yaw) >= 0 ? 1 : -1;
    return { x: Math.cos(t.yaw) * side, z: -Math.sin(t.yaw) * side };
  }
  if (t.shape === 'arenaSector') return r > 1e-3 ? { x: -dz / r, z: dx / r } : { x: 1, z: 0 }; // along the rim to a neighbour
  return r > 1e-3 ? { x: dx / r, z: dz / r } : { x: Math.sin(t.yaw + Math.PI / 2), z: Math.cos(t.yaw + Math.PI / 2) };
}

/** The camera-relative movement key closest to world direction `dir` (player/controllerInput cameraRelativeMove). */
function keyToward(dir: XZ, cameraYaw: number): MoveKey {
  const s = Math.sin(cameraYaw);
  const c = Math.cos(cameraYaw);
  const options: [MoveKey, number, number][] = [['KeyW', s, c], ['KeyS', -s, -c], ['KeyA', c, -s], ['KeyD', -c, s]];
  let best: MoveKey = 'KeyS';
  let bestDot = -Infinity;
  for (const [key, x, z] of options) {
    const dot = x * dir.x + z * dir.z;
    if (dot > bestDot) {
      bestDot = dot;
      best = key;
    }
  }
  return best;
}

/**
 * Lock-on to Caelith (R; design boss.ts / combat.ts "R로 Lock-on", Req 21.6): the locked camera frames the 6 m knight
 * and the character together and turns with it, and Isla's shots follow the lock. The harness does not show the lock,
 * so the bot infers it: after R (pressed while facing Caelith, so it is the candidate nearest the screen centre) the
 * camera keeps facing Caelith by itself; if it drifts off by more than 45° for 0.8 s the lock is taken as lost (a
 * Phase transition, a crystal picked instead) and the bot turns back to Caelith and presses R again (at most 8 times).
 */
class BossLock {
  private locked = false;
  private tries = 0;
  private offSince: number | null = null;
  private lastPress = 0;

  constructor(private readonly bot: Bot) {}

  reset(): void {
    this.locked = false;
    this.offSince = null;
  }

  async aim(s: Snap, toBoss: number, allowed: boolean): Promise<void> {
    const bot = this.bot;
    const err = s.camera === null ? 0 : Math.abs(angleDelta(s.camera.yaw, toBoss));
    if (this.locked) {
      if (err < 0.8) {
        this.offSince = null;
        return;
      }
      this.offSince ??= bot.now();
      if (bot.now() - this.offSince < 800) return;
      this.locked = false;
      this.offSince = null;
    }
    await bot.face(toBoss);
    if (!allowed || this.tries >= 8 || err > 0.12 || bot.now() - this.lastPress < 1500) return;
    this.tries++;
    this.lastPress = bot.now();
    this.locked = true;
    await bot.keys.tap('KeyR');
  }
}

export interface BossResult {
  /** Party_Wipes (Phase retries) during the fight. */
  retries: number;
}

/** Walks into the arena (the fight starts inside 28 m of its centre) and fights Caelith until it is defeated. */
export async function bossFight(bot: Bot, label: string, maxMs = 20 * 60_000): Promise<BossResult> {
  const center = SANCTUM.arena.center;
  const end = bot.now() + maxMs;
  let retries = 0;
  let engagedOnce = false;
  const lock = new BossLock(bot);
  for (;;) {
    let s: Snap;
    try {
      s = await bot.frame();
    } catch (e) {
      if (!(e instanceof WipeError) || e.bossPhase === null) throw e;
      retries++;
      lock.reset();
      if (retries > 12) throw new Error(`${label}: ${retries} Party_Wipes in the Caelith fight`);
      continue;
    }
    if (bot.now() > end) throw new Error(`${label}: Caelith at ${s.boss?.hp ?? '?'} HP in Phase ${s.boss?.phase ?? '?'} after the time limit`);
    if (s.screen === 'victory' || s.bossDefeated) break;
    const b = s.boss;
    const pos = s.player.pos;
    if (b === null) {
      if (engagedOnce && s.bossDefeated) break;
      // Dormant: walk in to start the fight (the intro cinematic plays on the first entry).
      await bot.face(yawFromDir(center.x - pos.x, center.z - pos.z));
      await bot.keys.move(flat(pos, center) > 6 ? ['KeyW'] : []);
      continue;
    }
    engagedOnce = true;
    if (b.state === 'dead') break;
    const d = flat(pos, b.pos);
    const toBoss = yawFromDir(b.pos.x - pos.x, b.pos.z - pos.z);
    await lock.aim(s, toBoss, b.state !== 'transition' && b.state !== 'intro' && d < 19);
    const camYaw = s.camera?.yaw ?? toBoss;
    await switchIfLow(bot, s);
    const covering = b.telegraphs.filter((t) => covers(t, pos));
    const soonest = covering.reduce((m, t) => Math.min(m, t.remaining), Infinity);
    const ring = b.ring;
    const ringGap = ring === null ? Infinity : flat(pos, ring.center) - 0.4 - ring.radius;
    const shardNear = b.shards.some((p) => flat(pos, p) < 2.6 && Math.abs(p.y - pos.y - 1) < 1.5);
    const sweepSoon = b.attack === 'atk_caelith_astralSweep' || ring !== null;
    const canDodge = s.player.mode !== 'dodge' && !s.player.exhausted;
    if (ring !== null && ringGap > -0.2) {
      // The band arrives in ringGap / 14 s: take off RING_LEAD s before that (now, or later within this frame).
      await bot.keys.stop();
      const lead = ringGap / RING_SPEED - RING_LEAD;
      if (lead < 0.075 && s.player.grounded) {
        if (lead > 0.005) await bot.page.waitForTimeout(lead * 1000);
        await bot.keys.tap('Space');
      }
    } else if (covering.length > 0) {
      const t = covering.reduce((a, c) => (a.remaining <= c.remaining ? a : c));
      await bot.keys.move([keyToward(escape(t, pos), camYaw)]);
      if (soonest <= 0.22 && canDodge) await bot.keys.tap('Mouse2');
    } else if (shardNear) {
      await bot.keys.move(['KeyD']);
      if (canDodge) await bot.keys.tap('Mouse2');
    } else if (b.attack === 'atk_caelith_starShards' && b.telegraphRemaining > 0) {
      await bot.keys.move(['KeyD']); // step aside from the aim lines
    } else if (sweepSoon) {
      await bot.keys.move(d < 5 ? ['KeyS'] : []); // stand clear, no attack lock when the ring comes
    } else {
      await bot.keys.move(d > 3.4 ? ['KeyW'] : []);
      const aligned = Math.abs(angleDelta(camYaw, toBoss)) < 0.6;
      if (b.state !== 'transition' && d < 4.2 && aligned) await bot.attack();
      if (b.state !== 'transition') await abilities(bot, s, d, null);
    }
  }
  await bot.keys.stop();
  return { retries };
}
