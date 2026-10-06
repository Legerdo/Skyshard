/*
 * Wren's attack clips (design.md 클립 목록): the long-shafted crescent glaive swung in wide 150° arcs with both hands.
 * wren_n1–n3 wide sweeps ×3, wren_charged gust thrust, wren_skill vortex whirl, wren_burst eye of the storm (0.9 s cut-in).
 * `hit` markers sit on the AttackDef hit times; `vfx` events call the Gale effects.
 */
import type { PoseClip } from '../clip';
import { anticipation, from, hit, poseClip, stand, trail, vfx } from './author';

const READY = stand({
  ra: { down: 45, fwd: 50, bend: 60 }, la: { down: 60, fwd: 45, across: 30, bend: 70 },
  ll: { lift: 15, knee: 20, spread: 10 }, rl: { lift: -10, knee: 15, spread: 10 }, spine: [10, 0, 0],
});
const k = from(READY);

const n1 = poseClip({
  name: 'wren_n1', duration: 0.55,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.1, pose: k({ spine: [8, 55, 0], ra: { down: 25, fwd: 30, across: -30, bend: 40 }, la: { down: 40, fwd: 20, across: 10, bend: 80 } }) },
    { t: 0.22, pose: k({ spine: [12, -60, 0], ra: { down: 20, fwd: 70, across: 70, bend: 20 }, la: { down: 35, fwd: 70, across: 60, bend: 50 }, ll: { lift: 28, knee: 26 } }), ease: 'out' },
    { t: 0.55, pose: k({ spine: [10, -15, 0] }) },
  ],
  events: [hit(0.22), ...trail(0.12, 0.32), vfx(0.22, 'gale:sweep')],
});

const n2 = poseClip({
  name: 'wren_n2', duration: 0.58,
  keys: [
    { t: 0, pose: k({ spine: [10, -40, 0], ra: { down: 25, fwd: 60, across: 60, bend: 25 } }) },
    { t: 0.12, pose: k({ spine: [8, -60, 0], ra: { down: 25, fwd: 55, across: 75, bend: 35 }, la: { down: 30, fwd: 60, across: 70, bend: 60 } }) },
    { t: 0.24, pose: k({ spine: [12, 55, 0], ra: { down: 20, fwd: 65, across: -40, bend: 20 }, la: { down: 35, fwd: 60, across: -10, bend: 60 }, rl: { lift: 24, knee: 26 } }), ease: 'out' },
    { t: 0.58, pose: k({ spine: [10, 10, 0] }) },
  ],
  events: [hit(0.24), ...trail(0.13, 0.34), vfx(0.24, 'gale:sweep')],
});

const n3 = poseClip({
  name: 'wren_n3', duration: 0.8,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.12, pose: k({ hips: [0, 60, 0], ra: { down: -40, fwd: 60, bend: 30 }, la: { down: -20, fwd: 50, across: 30, bend: 60 } }) },
    { t: 0.22, pose: k({ hips: [0, 160, 0], ra: { down: -30, fwd: 70, bend: 30 } }) },
    { t: 0.32, pose: k({ hips: [0, 260, 0], ra: { down: 30, fwd: 90, bend: 10 }, la: { down: 40, fwd: 80, across: 20, bend: 40 }, spine: [22, 0, 0], ll: { lift: 35, knee: 45 } }), ease: 'out' },
    { t: 0.55, pose: k({ hips: [0, 330, 0], spine: [14, 0, 0] }) },
    { t: 0.8, pose: k({ hips: [0, 360, 0] }) },
  ],
  events: [hit(0.32), ...trail(0.15, 0.45), vfx(0.32, 'gale:cleave')],
});

const charged = poseClip({
  name: 'wren_charged', duration: 0.85,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.15, pose: k({ spine: [6, -30, 0], ra: { down: 70, fwd: 0, bend: 90 }, la: { down: 60, fwd: 30, across: 40, bend: 90 }, rl: { lift: -20, knee: 30 } }) },
    { t: 0.3, pose: k({ spine: [15, 20, 0], ra: { down: 10, fwd: 90, bend: 0 }, la: { down: 20, fwd: 85, across: 10, bend: 10 }, ll: { lift: 45, knee: 40 }, rl: { lift: -25, knee: 20, toe: 20 } }), ease: 'out' },
    { t: 0.85, pose: k({}) },
  ],
  events: [anticipation(0.15, 'blade'), hit(0.3), ...trail(0.2, 0.38), vfx(0.3, 'gale:thrust')],
});

const spinArms = { ra: { down: 5, fwd: 40, bend: 10 }, la: { down: 10, fwd: 30, across: 20, bend: 30 }, spine: [6, 0, 0] as const };
const skill = poseClip({
  name: 'wren_skill', duration: 0.7,
  keys: [
    { t: 0, pose: k({}) },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ t: 0.075 * i, pose: k({ ...spinArms, hips: [0, 90 * i, 0] as const }) })),
    { t: 0.7, pose: k({ hips: [0, 720, 0] }) },
  ],
  events: [vfx(0.1, 'gale:vortex'), hit(0.3), ...trail(0.05, 0.55)],
});

const burst = poseClip({
  name: 'wren_burst', duration: 1.4,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.3, pose: k({ ra: { down: -85, fwd: 10, bend: 20, twist: 40 }, la: { down: -70, fwd: 20, across: 20, bend: 40 }, spine: [-8, 0, 0], head: [-20, 0, 0] }) },
    { t: 0.6, pose: k({ hips: [0, 90, 0], ra: { down: -85, fwd: 10, bend: 20, twist: -40 }, la: { down: -70, fwd: 20, across: 20, bend: 40 }, spine: [-8, 0, 0] }) },
    { t: 0.9, pose: k({ hips: [0, 0, 0], ra: { down: 80, fwd: 60, bend: 30 }, la: { down: 70, fwd: 60, across: 30, bend: 60 }, spine: [30, 0, 0], ll: { lift: 45, knee: 80 }, rl: { lift: 20, knee: 85 } }) },
    { t: 0.95, pose: k({ ra: { down: 82, fwd: 58, bend: 28 }, la: { down: 72, fwd: 58, across: 30, bend: 58 }, spine: [32, 0, 0], ll: { lift: 48, knee: 85 }, rl: { lift: 22, knee: 90 } }), ease: 'out' },
    { t: 1.4, pose: k({}) },
  ],
  events: [vfx(0, 'burst:cutIn'), anticipation(0.3, 'storm'), hit(0.95), vfx(0.95, 'gale:storm')],
});

export const WREN_CLIPS: readonly PoseClip[] = [n1, n2, n3, charged, skill, burst];
