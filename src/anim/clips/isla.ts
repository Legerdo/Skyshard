/*
 * Isla's attack clips (design.md 클립 목록): the longbow in the left hand, the right hand drawing the string (the
 * string's middle follows `rightHand` between the `draw:on` and `draw:off` events). isla_n1–n3 draw-and-loose ×3,
 * isla_charged aimed shot, isla_skill arrow rain (bow raised skyward), isla_burst tidal barrage (0.9 s cut-in, kneeling).
 * `hit` markers sit on the AttackDef hit times; `vfx` events call the Tide effects.
 */
import type { PoseClip } from '../clip';
import { anticipation, from, hit, poseClip, stand, vfx } from './author';

const READY = stand({
  la: { down: 70, fwd: 30, bend: 25 }, ra: { down: 75, fwd: 5, bend: 20 },
  ll: { lift: 8, knee: 10, spread: 6 }, rl: { lift: -4, knee: 8, spread: 6 }, spine: [4, 0, 0],
});
const k = from(READY);
/** Bow arm straight forward, string hand at the grip (nocking) or drawn to the chin. */
const nock = { la: { down: 90, fwd: 88, bend: 0 }, ra: { down: 88, fwd: 82, across: 4, bend: 60 }, spine: [2, -12, 0] as const, head: [0, 12, 0] as const };
const drawn = { la: { down: 90, fwd: 90, bend: 0 }, ra: { down: 86, fwd: 80, across: 8, bend: 150 }, spine: [0, -18, 0] as const, head: [0, 16, 0] as const };
const loosed = { la: { down: 88, fwd: 86, bend: 4 }, ra: { down: 80, fwd: 55, across: -10, bend: 165 }, spine: [0, -16, 0] as const, head: [0, 14, 0] as const };

function shot(name: string, duration: number, nockAt: number, drawAt: number, hitAt: number, fx: string): PoseClip {
  return poseClip({
    name, duration,
    keys: [
      { t: 0, pose: k({}) },
      { t: nockAt, pose: k(nock) },
      { t: drawAt, pose: k(drawn) },
      { t: hitAt, pose: k(loosed), ease: 'out' },
      { t: duration, pose: k({}) },
    ],
    events: [vfx(nockAt, 'draw:on'), vfx(hitAt, 'draw:off'), hit(hitAt), vfx(hitAt, fx)],
  });
}

const n1 = shot('isla_n1', 0.5, 0.08, 0.17, 0.2, 'tide:arrow');
const n2 = shot('isla_n2', 0.5, 0.06, 0.15, 0.18, 'tide:arrow');
const n3 = poseClip({
  name: 'isla_n3', duration: 0.7,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.1, pose: k(nock) },
    { t: 0.25, pose: k({ ...drawn, spine: [-6, -20, 0], ll: { lift: -6, knee: 8 }, rl: { lift: 14, knee: 18 } }) },
    { t: 0.28, pose: k({ ...loosed, spine: [-4, -18, 0] }), ease: 'out' },
    { t: 0.7, pose: k({}) },
  ],
  events: [vfx(0.1, 'draw:on'), vfx(0.28, 'draw:off'), hit(0.28), vfx(0.28, 'tide:arrow')],
});

const charged = poseClip({
  name: 'isla_charged', duration: 0.7,
  keys: [
    { t: 0, pose: k({ ...drawn, ll: { lift: 12, knee: 20, spread: 10 }, rl: { lift: -8, knee: 18, spread: 10 } }) },
    { t: 0.17, pose: k({ ...drawn, ra: { down: 86, fwd: 78, across: 10, bend: 158 }, ll: { lift: 12, knee: 22, spread: 10 }, rl: { lift: -8, knee: 20, spread: 10 } }) },
    { t: 0.2, pose: k({ ...loosed, ll: { lift: 12, knee: 20, spread: 10 }, rl: { lift: -8, knee: 18, spread: 10 } }), ease: 'out' },
    { t: 0.7, pose: k({}) },
  ],
  events: [vfx(0, 'draw:on'), anticipation(0, 'arrowhead'), vfx(0.2, 'draw:off'), hit(0.2), vfx(0.2, 'tide:pierce')],
});

const skyNock = { la: { down: 90, fwd: 140, bend: 0 }, ra: { down: 90, fwd: 132, bend: 70 }, spine: [-12, -8, 0] as const, head: [-24, 8, 0] as const };
const skyDrawn = { la: { down: 90, fwd: 142, bend: 0 }, ra: { down: 90, fwd: 130, bend: 150 }, spine: [-14, -10, 0] as const, head: [-26, 8, 0] as const };
const skill = poseClip({
  name: 'isla_skill', duration: 0.75,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.12, pose: k(skyNock) },
    { t: 0.3, pose: k(skyDrawn) },
    { t: 0.35, pose: k({ ...skyDrawn, ra: { down: 86, fwd: 110, bend: 168 } }), ease: 'out' },
    { t: 0.75, pose: k({}) },
  ],
  events: [vfx(0.12, 'draw:on'), vfx(0.35, 'draw:off'), hit(0.35), vfx(0.35, 'tide:rain')],
});

const kneel = { ll: { lift: 80, knee: 90, spread: 6 }, rl: { lift: -5, knee: 100, spread: 6, toe: 30 } };
const burst = poseClip({
  name: 'isla_burst', duration: 1.5,
  keys: [
    { t: 0, pose: k({}) },
    { t: 0.25, pose: k({ ...kneel, spine: [10, 0, 0] }) },
    { t: 0.55, pose: k({ ...kneel, ...nock }) },
    { t: 0.9, pose: k({ ...kneel, ...drawn, ra: { down: 86, fwd: 76, across: 12, bend: 160 } }) },
    { t: 0.95, pose: k({ ...kneel, ...loosed }), ease: 'out' },
    { t: 1.5, pose: k({}) },
  ],
  events: [vfx(0, 'burst:cutIn'), vfx(0.55, 'draw:on'), anticipation(0.55, 'tide'), vfx(0.95, 'draw:off'), hit(0.95), vfx(0.95, 'tide:barrage')],
});

export const ISLA_CLIPS: readonly PoseClip[] = [n1, n2, n3, charged, skill, burst];
