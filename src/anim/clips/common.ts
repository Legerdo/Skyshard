/*
 * The 20 clips every Player_Character shares (design.md 클립 목록, Req 39.6): idle, walk, run, sprint, jump, fall, land,
 * dodge, hurt, downed, climbIdle, climbUp / climbDown / climbLeft / climbRight (a 2D blend by the climb direction),
 * climbLeap, mantle, glideDeploy, glide, swim. Rotation keys only, so the same clip fits the 1.45–2.05 m heroes.
 * Locomotion cycles carry `rootMotion.forward` (the Animator plays them at speed × duration / forward) and footsteps.
 */
import type { PoseClip } from '../clip';
import { body, mirror, poseClip, stand, step, upper, STAND } from './author';

const idle = poseClip({
  name: 'idle', duration: 3.2, loop: true,
  keys: [
    { t: 0, pose: body(STAND) },
    { t: 1.6, pose: body(stand({ spine: [4, 2, 0], head: [-3, -5, 0], la: { down: 74, bend: 16 }, ra: { down: 77, bend: 12 } })) },
  ],
});

const walkContact = body(stand({
  ll: { lift: 24, knee: 6, toe: -8 }, rl: { lift: -16, knee: 14, toe: 10 },
  la: { down: 78, fwd: -16, bend: 12 }, ra: { down: 78, fwd: 18, bend: 22 }, spine: [5, 4, 0], hips: [0, -5, 0],
}));
const walkPass = body(stand({
  ll: { lift: 4, knee: 4, toe: 0 }, rl: { lift: 16, knee: 42, toe: 6 },
  la: { down: 78, fwd: 0, bend: 14 }, ra: { down: 78, fwd: 2, bend: 14 }, spine: [4, 0, 0],
}));
const walk = poseClip({
  name: 'walk', duration: 0.9, loop: true, forward: 2.0,
  keys: [{ t: 0, pose: walkContact }, { t: 0.225, pose: walkPass }, { t: 0.45, pose: mirror(walkContact) }, { t: 0.675, pose: mirror(walkPass) }],
  events: [step(0), step(0.45)],
});

const runContact = body(stand({
  ll: { lift: 42, knee: 20, toe: -10 }, rl: { lift: -24, knee: 55, toe: 20 },
  la: { down: 80, fwd: -34, bend: 80 }, ra: { down: 80, fwd: 38, bend: 90 }, spine: [12, 7, 0], hips: [0, -8, 0], head: [-8, -4, 0],
}));
const runFlight = body(stand({
  ll: { lift: 10, knee: 30, toe: 10 }, rl: { lift: 32, knee: 95, toe: 10 },
  la: { down: 80, fwd: 0, bend: 85 }, ra: { down: 80, fwd: 5, bend: 85 }, spine: [12, 0, 0], head: [-8, 0, 0],
}));
const run = poseClip({
  name: 'run', duration: 0.7, loop: true, forward: 3.4,
  keys: [{ t: 0, pose: runContact }, { t: 0.175, pose: runFlight }, { t: 0.35, pose: mirror(runContact) }, { t: 0.525, pose: mirror(runFlight) }],
  events: [step(0), step(0.35)],
});

const sprintContact = body(stand({
  ll: { lift: 58, knee: 25, toe: -12 }, rl: { lift: -30, knee: 70, toe: 25 },
  la: { down: 82, fwd: -50, bend: 95 }, ra: { down: 82, fwd: 55, bend: 100 }, spine: [18, 8, 0], hips: [4, -9, 0], head: [-14, -4, 0],
}));
const sprintFlight = body(stand({
  ll: { lift: 15, knee: 40, toe: 10 }, rl: { lift: 45, knee: 110, toe: 10 },
  la: { down: 82, fwd: 0, bend: 95 }, ra: { down: 82, fwd: 5, bend: 95 }, spine: [18, 0, 0], hips: [4, 0, 0], head: [-14, 0, 0],
}));
const sprint = poseClip({
  name: 'sprint', duration: 0.6, loop: true, forward: 4.4,
  keys: [{ t: 0, pose: sprintContact }, { t: 0.15, pose: sprintFlight }, { t: 0.3, pose: mirror(sprintContact) }, { t: 0.45, pose: mirror(sprintFlight) }],
  events: [step(0), step(0.3)],
});

const crouch = body(stand({ ll: { lift: 34, knee: 60, toe: -18 }, rl: { lift: 34, knee: 60, toe: -18 }, la: { down: 70, fwd: -30, bend: 20 }, ra: { down: 70, fwd: -30, bend: 20 }, spine: [18, 0, 0] }));
const jump = poseClip({
  name: 'jump', duration: 0.6,
  keys: [
    { t: 0, pose: crouch },
    { t: 0.12, pose: body(stand({ ll: { lift: 4, knee: 4, toe: 22 }, rl: { lift: 0, knee: 8, toe: 22 }, la: { down: 40, fwd: 60, bend: 25 }, ra: { down: 40, fwd: 55, bend: 25 }, spine: [-4, 0, 0], head: [-8, 0, 0] })) },
    { t: 0.35, pose: body(stand({ ll: { lift: 55, knee: 80, toe: 10 }, rl: { lift: 25, knee: 60, toe: 12 }, la: { down: 50, fwd: 25, bend: 40 }, ra: { down: 50, fwd: 15, bend: 40 }, spine: [6, 0, 0] })), ease: 'out' },
    { t: 0.6, pose: body(stand({ ll: { lift: 40, knee: 65, toe: 10 }, rl: { lift: 20, knee: 50, toe: 10 }, la: { down: 45, fwd: 15, bend: 35 }, ra: { down: 45, fwd: 10, bend: 35 }, spine: [4, 0, 0] })) },
  ],
  events: [{ t: 0, kind: 'sfx', data: 'jump' }],
});

const fallA = body(stand({ ll: { lift: 18, knee: 32, toe: 8 }, rl: { lift: 4, knee: 22, toe: 8 }, la: { down: 35, fwd: 10, bend: 25 }, ra: { down: 38, fwd: 5, bend: 20 }, spine: [-2, 0, 0], head: [-6, 0, 0] }));
const fall = poseClip({
  name: 'fall', duration: 1.0, loop: true,
  keys: [{ t: 0, pose: fallA }, { t: 0.5, pose: body(stand({ ll: { lift: 8, knee: 24, toe: 8 }, rl: { lift: 16, knee: 34, toe: 8 }, la: { down: 30, fwd: 5, bend: 30 }, ra: { down: 32, fwd: 12, bend: 28 }, spine: [-3, 0, 0], head: [-6, 0, 0] })) }],
});

const land = poseClip({
  name: 'land', duration: 0.4,
  keys: [
    { t: 0, pose: body(stand({ ll: { lift: 42, knee: 72, toe: -14 }, rl: { lift: 42, knee: 72, toe: -14 }, la: { down: 58, fwd: 25, bend: 30 }, ra: { down: 58, fwd: 25, bend: 30 }, spine: [22, 0, 0], head: [-10, 0, 0] })), ease: 'out' },
    { t: 0.4, pose: body(STAND) },
  ],
  events: [step(0)],
});

const dodge = poseClip({
  name: 'dodge', duration: 0.35,
  keys: [
    { t: 0, pose: body(stand({ ll: { lift: 30, knee: 40 }, rl: { lift: -10, knee: 30, toe: 20 }, la: { down: 70, fwd: -40, bend: 30 }, ra: { down: 70, fwd: -40, bend: 30 }, spine: [28, 0, 0], hips: [10, 0, 0] })), ease: 'out' },
    { t: 0.14, pose: body(stand({ ll: { lift: 70, knee: 110, toe: 10 }, rl: { lift: 50, knee: 110, toe: 10 }, la: { down: 60, fwd: 40, bend: 90 }, ra: { down: 60, fwd: 40, bend: 90 }, spine: [40, 0, 0], hips: [25, 0, 0], head: [20, 0, 0] })) },
    { t: 0.35, pose: body(stand({ ll: { lift: 25, knee: 40, toe: -8 }, rl: { lift: 5, knee: 30, toe: 8 }, spine: [14, 0, 0] })) },
  ],
  events: [{ t: 0, kind: 'sfx', data: 'dodge' }],
});

const hurt = poseClip({
  name: 'hurt', duration: 0.4,
  keys: [
    { t: 0, pose: upper(STAND) },
    { t: 0.08, pose: upper(stand({ spine: [-14, 0, 5], chest: [-8, 0, 0], head: [-18, 6, 0], la: { down: 58, fwd: -22, bend: 42 }, ra: { down: 55, fwd: -26, bend: 46 } })), ease: 'out' },
    { t: 0.4, pose: upper(STAND) },
  ],
});

const downed = poseClip({
  name: 'downed', duration: 1.0,
  keys: [
    { t: 0, pose: body(STAND) },
    { t: 0.4, pose: body(stand({ ll: { lift: 80, knee: 120, toe: 10 }, rl: { lift: 70, knee: 115, toe: 10 }, spine: [30, 0, 0], head: [25, 0, 0], la: { down: 86, fwd: 25, bend: 20 }, ra: { down: 86, fwd: 20, bend: 20 } })), ease: 'out' },
    { t: 1.0, pose: body(stand({ ll: { lift: 85, knee: 130, toe: 20 }, rl: { lift: 80, knee: 128, toe: 20 }, spine: [45, 0, 8], chest: [10, 0, 0], head: [35, 0, 0], la: { down: 88, fwd: 35, bend: 30 }, ra: { down: 88, fwd: 28, bend: 20 } })) },
  ],
});

// ── Climbing (2D blend) ─────────────────────────────────────────────────────

const climbHold = stand({
  la: { down: -62, fwd: 22, bend: 55 }, ra: { down: -40, fwd: 26, bend: 70 },
  ll: { lift: 38, knee: 72, spread: 12, toe: 10 }, rl: { lift: 18, knee: 52, spread: 12, toe: 10 }, spine: [-4, 0, 0], head: [-14, 0, 0],
});
const climbIdle = poseClip({
  name: 'climbIdle', duration: 2.0, loop: true,
  keys: [{ t: 0, pose: body(climbHold) }, { t: 1.0, pose: body({ ...climbHold, spine: [-6, 0, 0], head: [-16, 3, 0] }) }],
});
const reachL = body(stand({
  la: { down: -82, fwd: 20, bend: 18 }, ra: { down: -18, fwd: 30, bend: 95 },
  ll: { lift: 12, knee: 24, spread: 12, toe: 10 }, rl: { lift: 52, knee: 92, spread: 12, toe: 10 }, spine: [-4, 0, 3], head: [-16, 0, 0],
}));
const climbCycle = (name: string, first: typeof reachL, second: typeof reachL): PoseClip => poseClip({
  name, duration: 0.9, loop: true, forward: 0.9,
  keys: [{ t: 0, pose: first }, { t: 0.45, pose: second }],
});
const climbUp = climbCycle('climbUp', reachL, mirror(reachL));
const climbDown = climbCycle('climbDown', mirror(reachL), reachL);
const sideL = body(stand({
  la: { down: -12, fwd: 18, bend: 30 }, ra: { down: -55, fwd: 25, bend: 75 },
  ll: { lift: 22, knee: 40, spread: 26, toe: 10 }, rl: { lift: 28, knee: 60, spread: 6, toe: 10 }, spine: [-4, 0, -4], head: [-12, 8, 0],
}));
const sideClose = body(climbHold);
const climbLeft = poseClip({ name: 'climbLeft', duration: 0.9, loop: true, forward: 0.9, keys: [{ t: 0, pose: sideL }, { t: 0.45, pose: sideClose }] });
const climbRight = poseClip({ name: 'climbRight', duration: 0.9, loop: true, forward: 0.9, keys: [{ t: 0, pose: mirror(sideL) }, { t: 0.45, pose: sideClose }] });

const climbLeap = poseClip({
  name: 'climbLeap', duration: 0.4,
  keys: [
    { t: 0, pose: body(stand({ la: { down: -30, fwd: 25, bend: 95 }, ra: { down: -30, fwd: 25, bend: 95 }, ll: { lift: 62, knee: 105, spread: 10 }, rl: { lift: 62, knee: 105, spread: 10 }, spine: [8, 0, 0] })) },
    { t: 0.15, pose: body(stand({ la: { down: -88, fwd: 15, bend: 5 }, ra: { down: -88, fwd: 15, bend: 5 }, ll: { lift: 0, knee: 6, toe: 30 }, rl: { lift: 4, knee: 10, toe: 30 }, spine: [-8, 0, 0], head: [-20, 0, 0] })), ease: 'out' },
    { t: 0.4, pose: body(climbHold) },
  ],
});

const mantle = poseClip({
  name: 'mantle', duration: 0.45,
  keys: [
    { t: 0, pose: body(stand({ la: { down: -60, fwd: 40, bend: 60 }, ra: { down: -60, fwd: 40, bend: 60 }, ll: { lift: 20, knee: 40 }, rl: { lift: 10, knee: 30 }, spine: [5, 0, 0], head: [-15, 0, 0] })) },
    { t: 0.2, pose: body(stand({ la: { down: 40, fwd: 30, bend: 100 }, ra: { down: 40, fwd: 30, bend: 100 }, ll: { lift: 20, knee: 30 }, rl: { lift: 85, knee: 110 }, spine: [30, 0, 0] })) },
    { t: 0.45, pose: body(stand({ ll: { lift: 30, knee: 50 }, rl: { lift: 20, knee: 40 }, spine: [15, 0, 0] })) },
  ],
});

// ── Glide and swim ──────────────────────────────────────────────────────────

const glidePose = stand({
  la: { down: 12, fwd: -8, bend: 10 }, ra: { down: 12, fwd: -8, bend: 10 },
  ll: { lift: -12, knee: 22, toe: 20 }, rl: { lift: -6, knee: 30, toe: 20 }, hips: [42, 0, 0], spine: [-8, 0, 0], neck: [-18, 0, 0], head: [-16, 0, 0],
});
const glideDeploy = poseClip({
  name: 'glideDeploy', duration: 0.3,
  keys: [{ t: 0, pose: fallA }, { t: 0.3, pose: body(glidePose) }],
  events: [{ t: 0, kind: 'sfx', data: 'glide' }],
});
const glide = poseClip({
  name: 'glide', duration: 1.6, loop: true,
  keys: [{ t: 0, pose: body(glidePose) }, { t: 0.8, pose: body({ ...glidePose, la: { down: 8, fwd: -10, bend: 12 }, ra: { down: 16, fwd: -6, bend: 8 }, spine: [-8, 0, 2] }) }],
});

const swimPose = { hips: [55, 0, 0] as const, neck: [-32, 0, 0] as const, head: [-22, 0, 0] as const };
const swim = poseClip({
  name: 'swim', duration: 1.2, loop: true, forward: 1.8,
  keys: [
    { t: 0, pose: body(stand({ ...swimPose, la: { down: 90, fwd: 165, bend: 5 }, ra: { down: 90, fwd: 165, bend: 5 }, ll: { lift: 0, knee: 5, toe: 40 }, rl: { lift: 0, knee: 5, toe: 40 } })) },
    { t: 0.4, pose: body(stand({ ...swimPose, la: { down: 20, fwd: 95, bend: 30 }, ra: { down: 20, fwd: 95, bend: 30 }, ll: { lift: 40, knee: 90, spread: 20 }, rl: { lift: 40, knee: 90, spread: 20 } })) },
    { t: 0.8, pose: body(stand({ ...swimPose, la: { down: 80, fwd: 60, bend: 120 }, ra: { down: 80, fwd: 60, bend: 120 }, ll: { lift: 0, knee: 0, spread: 30, toe: 40 }, rl: { lift: 0, knee: 0, spread: 30, toe: 40 } })) },
  ],
  events: [{ t: 0.4, kind: 'vfx', data: 'swim:stroke' }],
});

/** The shared hero clips, in HERO_COMMON_CLIPS order. */
export const COMMON_CLIPS: readonly PoseClip[] = [
  idle, walk, run, sprint, jump, fall, land, dodge, hurt, downed,
  climbIdle, climbUp, climbDown, climbLeft, climbRight, climbLeap, mantle, glideDeploy, glide, swim,
];
