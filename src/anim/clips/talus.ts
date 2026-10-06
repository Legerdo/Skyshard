/*
 * Talus's attack clips (design.md 클립 목록): heavy, weight-shifting blows led by the tower shield on the left forearm
 * and the stone right gauntlet. talus_n1 · n2 shield bash / gauntlet punch, talus_n3 overhead slam, talus_charged
 * stomp shockwave, talus_skill raising the stone pillar, talus_burst earthen fortress (1.0 s cut-in).
 * `hit` markers sit on the AttackDef hit times; `vfx` events call the Terra effects.
 */
import type { PoseClip } from '../clip';
import { anticipation, from, hit, poseClip, stand, vfx } from './author';

const READY = stand({
  la: { down: 60, fwd: 70, across: 40, bend: 90 }, ra: { down: 70, fwd: 20, bend: 60 },
  ll: { lift: 15, knee: 25, spread: 8 }, rl: { lift: -8, knee: 20, spread: 8 }, spine: [12, 0, 0],
});
const k = from(READY);

const n1 = poseClip({
  name: 'talus_n1', duration: 0.6,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.12, pose: k({ la: { down: 60, fwd: 30, across: 30, bend: 100 }, spine: [10, -20, 0] }) },
    { t: 0.24, pose: k({ la: { down: 75, fwd: 90, across: 20, bend: 50 }, spine: [18, 25, 0], ll: { lift: 35, knee: 30 } }), ease: 'out' },
    { t: 0.6, pose: k({}) },
  ],
  events: [hit(0.24), vfx(0.24, 'terra:bash')],
});

const n2 = poseClip({
  name: 'talus_n2', duration: 0.62,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.14, pose: k({ ra: { down: 75, fwd: -20, bend: 110 }, spine: [10, 25, 0] }) },
    { t: 0.26, pose: k({ ra: { down: 85, fwd: 90, across: 10, bend: 0 }, spine: [16, -30, 0], rl: { lift: 20, knee: 25 } }), ease: 'out' },
    { t: 0.62, pose: k({}) },
  ],
  events: [hit(0.26), vfx(0.26, 'terra:punch')],
});

const n3 = poseClip({
  name: 'talus_n3', duration: 0.95,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.25, pose: k({ ra: { down: -70, fwd: 30, bend: 40 }, la: { down: -60, fwd: 40, across: 20, bend: 80 }, spine: [-12, 0, 0], ll: { lift: 5, knee: 8, toe: 10 }, rl: { lift: 0, knee: 8, toe: 10 } }) },
    { t: 0.42, pose: k({ ra: { down: 70, fwd: 70, bend: 20 }, la: { down: 60, fwd: 80, across: 30, bend: 70 }, spine: [40, 0, 0], ll: { lift: 50, knee: 80 }, rl: { lift: 30, knee: 80 } }), ease: 'out' },
    { t: 0.95, pose: k({}) },
  ],
  events: [anticipation(0.25, 'gauntlet'), hit(0.42), vfx(0.42, 'terra:quake')],
});

const charged = poseClip({
  name: 'talus_charged', duration: 1.0,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.25, pose: k({ rl: { lift: 75, knee: 95 }, ll: { lift: 5, knee: 10 }, ra: { down: -20, fwd: 30, bend: 70 }, spine: [0, 0, 0] }) },
    { t: 0.4, pose: k({ rl: { lift: 20, knee: 30 }, ll: { lift: 30, knee: 50 }, ra: { down: 80, fwd: 70, bend: 10 }, spine: [35, 0, 0] }), ease: 'out' },
    { t: 1.0, pose: k({}) },
  ],
  events: [hit(0.4), vfx(0.4, 'terra:shockwave')],
});

const skill = poseClip({
  name: 'talus_skill', duration: 0.8,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.15, pose: k({ ra: { down: 80, fwd: 60, bend: 20 }, la: { down: 75, fwd: 70, across: 30, bend: 60 }, spine: [35, 0, 0], ll: { lift: 45, knee: 75 }, rl: { lift: 30, knee: 75 } }) },
    { t: 0.4, pose: k({ ra: { down: -40, fwd: 60, bend: 30 }, la: { down: -30, fwd: 60, across: 20, bend: 70 }, spine: [-5, 0, 0], ll: { lift: 10, knee: 10 }, rl: { lift: 0, knee: 10 } }), ease: 'out' },
    { t: 0.8, pose: k({}) },
  ],
  events: [hit(0.4), vfx(0.4, 'terra:pillar')],
});

const burst = poseClip({
  name: 'talus_burst', duration: 1.7,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.4, pose: k({ la: { down: -70, fwd: 30, across: 20, bend: 60 }, ra: { down: -60, fwd: 40, bend: 60 }, spine: [-10, 0, 0], head: [-18, 0, 0] }) },
    { t: 0.9, pose: k({ la: { down: -72, fwd: 35, across: 20, bend: 62 }, ra: { down: -62, fwd: 42, bend: 62 }, ll: { lift: 40, knee: 70 }, rl: { lift: 25, knee: 70 }, spine: [-4, 0, 0] }) },
    { t: 1.05, pose: k({ la: { down: 70, fwd: 80, across: 30, bend: 70 }, ra: { down: 80, fwd: 70, bend: 20 }, spine: [40, 0, 0], ll: { lift: 55, knee: 95 }, rl: { lift: 30, knee: 95 } }), ease: 'out' },
    { t: 1.7, pose: k({}) },
  ],
  events: [vfx(0, 'burst:cutIn'), anticipation(0.4, 'crystal'), hit(1.05), vfx(1.05, 'terra:fortress')],
});

export const TALUS_CLIPS: readonly PoseClip[] = [n1, n2, n3, charged, skill, burst];
