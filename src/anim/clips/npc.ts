/*
 * NPC clips (design.md 클립 목록, Req 14.9): `npc_idle` plus the ambient behaviours — walking (`npc_walk`, `npc_run`),
 * looking around (`npc_lookAround`) and each villager's work (`npc_work_hoe` Hobb, `npc_work_hammer` Durga,
 * `npc_work_sweep` Old Bram, `npc_work_arrange` Pip, `npc_work_telescope` / `npc_work_notebook` Oriel) — and the
 * idle variants the NpcSystem names (point, leanCounter, eyesClosed, restOnHoe, armsCrossed, staff). A talk is `idle`.
 * Humanoid joints only, so the companions standing in the world before they join play them too.
 */
import type { PoseClip } from '../clip';
import { body, mirror, poseClip, stand, step, vfx, type BodyPose } from './author';

const s = (over: BodyPose = {}) => body(stand(over));
const loop = (name: string, duration: number, a: BodyPose, b: BodyPose, forward?: number): PoseClip =>
  poseClip({ name, duration, loop: true, forward, keys: [{ t: 0, pose: s(a) }, { t: duration / 2, pose: s(b) }] });

const walkContact = s({ ll: { lift: 20, knee: 6, toe: -6 }, rl: { lift: -14, knee: 12, toe: 8 }, la: { down: 80, fwd: -12, bend: 12 }, ra: { down: 80, fwd: 14, bend: 18 }, spine: [4, 3, 0] });
const walkPass = s({ ll: { lift: 3, knee: 4 }, rl: { lift: 14, knee: 36, toe: 6 }, spine: [3, 0, 0] });
const walk = poseClip({
  name: 'npc_walk', duration: 1.0, loop: true, forward: 1.5,
  keys: [{ t: 0, pose: walkContact }, { t: 0.25, pose: walkPass }, { t: 0.5, pose: mirror(walkContact) }, { t: 0.75, pose: mirror(walkPass) }],
  events: [step(0), step(0.5)],
});
const runContact = s({ ll: { lift: 38, knee: 20, toe: -8 }, rl: { lift: -22, knee: 50, toe: 18 }, la: { down: 80, fwd: -30, bend: 80 }, ra: { down: 80, fwd: 34, bend: 85 }, spine: [10, 6, 0] });
const runFlight = s({ ll: { lift: 10, knee: 30 }, rl: { lift: 30, knee: 85 }, la: { down: 80, bend: 80 }, ra: { down: 80, bend: 80 }, spine: [10, 0, 0] });
const run = poseClip({
  name: 'npc_run', duration: 0.6, loop: true, forward: 2.4,
  keys: [{ t: 0, pose: runContact }, { t: 0.15, pose: runFlight }, { t: 0.3, pose: mirror(runContact) }, { t: 0.45, pose: mirror(runFlight) }],
  events: [step(0), step(0.3)],
});

const idle = loop('npc_idle', 3.6, {}, { spine: [4, 2, 0], head: [-3, -6, 0], la: { down: 74 }, ra: { down: 77 } });
const lookAround = poseClip({
  name: 'npc_lookAround', duration: 4.0, loop: true,
  keys: [
    { t: 0, pose: s({ head: [-4, 0, 0] }) },
    { t: 1.0, pose: s({ head: [-6, 40, 0], neck: [0, 15, 0], spine: [3, 8, 0] }) },
    { t: 2.0, pose: s({ head: [-4, 0, 0] }) },
    { t: 3.0, pose: s({ head: [-6, -40, 0], neck: [0, -15, 0], spine: [3, -8, 0] }) },
  ],
});
const point = loop('npc_point', 3.0, { ra: { down: 90, fwd: 100, bend: 0 }, head: [-10, 0, 0] }, { ra: { down: 90, fwd: 104, bend: 2 }, head: [-12, 4, 0] });
const leanCounter = loop('npc_leanCounter', 3.0,
  { spine: [20, 0, 0], la: { down: 60, fwd: 60, bend: 60 }, ra: { down: 60, fwd: 60, bend: 60 }, rl: { lift: 6, knee: 12 } },
  { spine: [22, 3, 0], la: { down: 60, fwd: 62, bend: 62 }, ra: { down: 60, fwd: 60, bend: 58 }, rl: { lift: 6, knee: 12 }, head: [-6, 6, 0] });
const arrange = loop('npc_work_arrange', 2.4,
  { spine: [12, -10, 0], la: { down: 70, fwd: 70, bend: 30 }, ra: { down: 75, fwd: 40, bend: 50 } },
  { spine: [12, 10, 0], la: { down: 75, fwd: 40, bend: 50 }, ra: { down: 70, fwd: 70, bend: 30 } });
const eyesClosed = loop('npc_eyesClosed', 4.0,
  { head: [12, 0, 0], la: { down: 72, fwd: 30, across: 30, bend: 100 }, ra: { down: 72, fwd: 30, across: 30, bend: 100 } },
  { head: [14, 0, 0], spine: [5, 0, 0], la: { down: 72, fwd: 30, across: 30, bend: 100 }, ra: { down: 72, fwd: 30, across: 30, bend: 100 } });
const sweepA: BodyPose = { spine: [18, 25, 0], la: { down: 70, fwd: 50, across: 30, bend: 40 }, ra: { down: 80, fwd: 40, across: 10, bend: 30 } };
const sweep = loop('npc_work_sweep', 1.6, sweepA, { ...sweepA, spine: [18, -25, 0] });
const restOnHoe = loop('npc_restOnHoe', 3.0,
  { ra: { down: 72, fwd: 55, bend: 90 }, la: { down: 70, fwd: 50, across: 30, bend: 90 }, spine: [10, 0, -5], rl: { lift: 8, knee: 18 } },
  { ra: { down: 72, fwd: 57, bend: 92 }, la: { down: 70, fwd: 52, across: 30, bend: 92 }, spine: [12, 0, -5], rl: { lift: 8, knee: 18 }, head: [-4, 8, 0] });
const hoe = poseClip({
  name: 'npc_work_hoe', duration: 1.4, loop: true, forward: 1.0,
  keys: [
    { t: 0, pose: s({ ra: { down: -20, fwd: 60, bend: 60 }, la: { down: 30, fwd: 60, across: 30, bend: 70 }, spine: [8, 0, 0], ll: { lift: 16, knee: 10 }, rl: { lift: -8, knee: 12 } }) },
    { t: 0.5, pose: s({ ra: { down: 70, fwd: 70, bend: 20 }, la: { down: 70, fwd: 70, across: 20, bend: 40 }, spine: [32, 0, 0], ll: { lift: 16, knee: 20 }, rl: { lift: -8, knee: 20 } }), ease: 'out' },
    { t: 0.9, pose: s({ ra: { down: 50, fwd: 60, bend: 40 }, la: { down: 60, fwd: 60, across: 20, bend: 50 }, spine: [20, 0, 0], ll: { lift: -8, knee: 12 }, rl: { lift: 16, knee: 10 } }) },
  ],
  events: [vfx(0.5, 'dirt'), step(0.9)],
});
const armsCrossed = loop('npc_armsCrossed', 3.5,
  { la: { down: 70, fwd: 60, across: 60, bend: 110 }, ra: { down: 72, fwd: 58, across: 62, bend: 112 }, head: [-4, 0, 0] },
  { la: { down: 70, fwd: 60, across: 60, bend: 110 }, ra: { down: 72, fwd: 58, across: 62, bend: 112 }, head: [-2, -8, 0], spine: [2, 3, 0] });
const hammer = poseClip({
  name: 'npc_work_hammer', duration: 1.0, loop: true,
  keys: [
    { t: 0, pose: s({ ra: { down: -40, fwd: 50, bend: 90 }, la: { down: 70, fwd: 50, bend: 60 }, spine: [14, -8, 0] }) },
    { t: 0.35, pose: s({ ra: { down: 60, fwd: 80, bend: 20 }, la: { down: 70, fwd: 50, bend: 60 }, spine: [26, 5, 0] }), ease: 'out' },
  ],
  events: [vfx(0.35, 'spark'), { t: 0.35, kind: 'sfx', data: 'anvil' }],
});
const notebook = loop('npc_work_notebook', 3.0,
  { la: { down: 80, fwd: 70, bend: 100 }, ra: { down: 75, fwd: 55, across: 20, bend: 110 }, head: [20, 0, 0] },
  { la: { down: 80, fwd: 70, bend: 100 }, ra: { down: 75, fwd: 58, across: 26, bend: 105 }, head: [22, 5, 0] });
const telescope = loop('npc_work_telescope', 4.0,
  { la: { down: 70, fwd: 90, bend: 130 }, ra: { down: 70, fwd: 90, bend: 130 }, spine: [25, 0, 0], head: [10, 0, 0], ll: { lift: 10, knee: 15 } },
  { la: { down: 70, fwd: 90, bend: 130 }, ra: { down: 70, fwd: 92, bend: 128 }, spine: [26, 3, 0], head: [10, 2, 0], ll: { lift: 10, knee: 15 } });
const staff = loop('npc_staff', 3.2,
  { ra: { down: 88, fwd: 10, bend: 85 }, la: { down: 80, fwd: 30, across: 30, bend: 80 } },
  { ra: { down: 88, fwd: 12, bend: 86 }, la: { down: 80, fwd: 31, across: 30, bend: 82 }, head: [-2, 6, 0] });

export const NPC_CLIPS: readonly PoseClip[] = [
  idle, walk, run, lookAround, point, leanCounter, arrange, eyesClosed, sweep, restOnHoe, hoe, armsCrossed, hammer, notebook, telescope, staff,
];
