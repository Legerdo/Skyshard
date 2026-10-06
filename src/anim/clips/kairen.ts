/*
 * Kairen's attack clips (design.md 클립 목록): short, fast one-handed slashes with the curved sword in the right hand,
 * the scarf trailing the arc. Each clip spans its AttackDef from start to `duration`; its `hit` markers sit on the
 * AttackDef's hit times (checked by tests/unit/anim/clipSync.test.ts) and its `vfx` events call the Ember effects.
 * kairen_n1–n4 four-hit chain (hits 0.18 · 0.20 · 0.22 · 0.30 s), kairen_charged rising spin, kairen_skill flame dash,
 * kairen_burst sunfall (1.0 s cut-in before the first hit).
 */
import type { PoseClip } from '../clip';
import { anticipation, from, hit, poseClip, stand, trail, vfx } from './author';

const READY = stand({
  ra: { down: 55, fwd: 35, bend: 45 }, la: { down: 70, fwd: 10, bend: 30 },
  ll: { lift: 12, knee: 15, spread: 4 }, rl: { lift: -6, knee: 12, spread: 4 }, spine: [8, 0, 0],
});
const k = from(READY);

const n1 = poseClip({
  name: 'kairen_n1', duration: 0.45,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.1, pose: k({ ra: { down: -35, fwd: 20, across: -20, bend: 75 }, spine: [4, -28, 0], chest: [0, -10, 0] }) },
    { t: 0.18, pose: k({ ra: { down: 55, fwd: 70, across: 55, bend: 15 }, spine: [12, 28, 0], ll: { lift: 26, knee: 18 } }), ease: 'out' },
    { t: 0.45, pose: k({ spine: [8, 10, 0] }) },
  ],
  events: [hit(0.18), ...trail(0.1, 0.26), vfx(0.18, 'ember:slash')],
});

const n2 = poseClip({
  name: 'kairen_n2', duration: 0.48,
  keys: [
    { t: 0, pose: k({ ra: { down: 50, fwd: 60, across: 50, bend: 20 }, spine: [10, 25, 0] }) },
    { t: 0.12, pose: k({ ra: { down: 20, fwd: 55, across: 70, bend: 60 }, spine: [8, 35, 0] }) },
    { t: 0.2, pose: k({ ra: { down: 45, fwd: 55, across: -35, bend: 12 }, spine: [12, -30, 0], rl: { lift: 18, knee: 20 } }), ease: 'out' },
    { t: 0.48, pose: k({ spine: [8, -8, 0] }) },
  ],
  events: [hit(0.2), ...trail(0.12, 0.28), vfx(0.2, 'ember:slash')],
});

const n3 = poseClip({
  name: 'kairen_n3', duration: 0.52,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.12, pose: k({ ra: { down: -85, fwd: 25, bend: 55 }, spine: [-8, 0, 0], head: [-10, 0, 0] }) },
    { t: 0.22, pose: k({ ra: { down: 65, fwd: 85, bend: 8 }, spine: [26, 0, 0], ll: { lift: 30, knee: 25 } }), ease: 'out' },
    { t: 0.52, pose: k({}) },
  ],
  events: [hit(0.22), ...trail(0.13, 0.3), vfx(0.22, 'ember:slash')],
});

const n4 = poseClip({
  name: 'kairen_n4', duration: 0.8,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.15, pose: k({ hips: [0, -50, 0], ra: { down: 10, fwd: 20, across: -40, bend: 30 }, spine: [10, -20, 0] }) },
    { t: 0.24, pose: k({ hips: [0, 40, 0], ra: { down: 8, fwd: 60, across: 20, bend: 8 }, spine: [12, 10, 0] }) },
    { t: 0.3, pose: k({ hips: [0, 130, 0], ra: { down: 8, fwd: 60, across: 30, bend: 8 }, spine: [12, 20, 0], ll: { lift: 30, knee: 30 } }), ease: 'out' },
    { t: 0.55, pose: k({ hips: [0, 40, 0], spine: [10, 5, 0] }) },
    { t: 0.8, pose: k({}) },
  ],
  events: [hit(0.3), ...trail(0.18, 0.4), vfx(0.3, 'ember:slash')],
});

const charged = poseClip({
  name: 'kairen_charged', duration: 0.9,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.15, pose: k({ ll: { lift: 40, knee: 70 }, rl: { lift: 30, knee: 65 }, spine: [20, 0, 0], ra: { down: 60, fwd: -20, bend: 30 } }) },
    { t: 0.26, pose: k({ hips: [0, 100, 0], ll: { lift: 20, knee: 20, toe: 20 }, rl: { lift: 10, knee: 20, toe: 20 }, ra: { down: -20, fwd: 50, bend: 20 } }) },
    { t: 0.36, pose: k({ hips: [0, 200, 0], ll: { lift: 10, knee: 5, toe: 30 }, rl: { lift: 5, knee: 5, toe: 30 }, ra: { down: -60, fwd: 60, bend: 10 }, spine: [-6, 0, 0] }), ease: 'out' },
    { t: 0.48, pose: k({ hips: [0, 290, 0], ra: { down: -40, fwd: 60, bend: 20 } }) },
    { t: 0.9, pose: k({ hips: [0, 360, 0] }) },
  ],
  events: [hit(0.36), ...trail(0.2, 0.5), anticipation(0.15, 'blade'), vfx(0.36, 'ember:rising')],
});

const skill = poseClip({
  name: 'kairen_skill', duration: 0.7,
  keys: [
    { t: 0, pose: k({ spine: [28, 0, 0], ra: { down: 20, fwd: 30, across: -30, bend: 30 }, ll: { lift: 30, knee: 40 }, rl: { lift: -25, knee: 30, toe: 15 } }) },
    { t: 0.12, pose: k({ spine: [30, 20, 0], ra: { down: 25, fwd: 80, across: 50, bend: 5 }, ll: { lift: 45, knee: 35 }, rl: { lift: -30, knee: 25, toe: 20 } }), ease: 'out' },
    { t: 0.4, pose: k({ spine: [18, 15, 0], ra: { down: 40, fwd: 60, across: 40, bend: 15 } }) },
    { t: 0.7, pose: k({}) },
  ],
  events: [vfx(0, 'ember:dash'), hit(0.12), ...trail(0.05, 0.3)],
});

const burst = poseClip({
  name: 'kairen_burst', duration: 1.6,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.35, pose: k({ ra: { down: -88, fwd: 10, bend: 20 }, la: { down: -80, fwd: 15, across: 20, bend: 40 }, spine: [-10, 0, 0], head: [-22, 0, 0] }) },
    { t: 0.9, pose: k({ ra: { down: -88, fwd: 20, bend: 25 }, la: { down: -78, fwd: 20, across: 20, bend: 45 }, spine: [-6, 0, 0], head: [-18, 0, 0], ll: { lift: 35, knee: 60 }, rl: { lift: 25, knee: 60 } }) },
    { t: 1.05, pose: k({ ra: { down: 70, fwd: 90, bend: 5 }, la: { down: 70, fwd: 80, bend: 20 }, spine: [35, 0, 0], ll: { lift: 50, knee: 90 }, rl: { lift: 20, knee: 95 } }), ease: 'out' },
    { t: 1.6, pose: k({}) },
  ],
  events: [vfx(0, 'burst:cutIn'), anticipation(0.35, 'sun'), vfx(1.0, 'ember:sunfall'), hit(1.05), ...trail(0.95, 1.15)],
});

export const KAIREN_CLIPS: readonly PoseClip[] = [n1, n2, n3, n4, charged, skill, burst];
