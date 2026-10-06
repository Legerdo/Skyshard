/*
 * Enemy, Elite and drone clips (design.md 클립 목록, Req 39.7): every kind has `idle`, `move`, `attackWindup` /
 * `attack` (one windup · strike pair per attack), `hurt`, `stagger` and `defeat`; Elites use their base kind's clips
 * plus the windup · strike pair of their own attack (rotation keys, so the 1.4× rigs take them as they are), and
 * rootboundWarden and Sentinel Prime's drones have their own sets.
 *
 * Timeline of an attack (design "타이밍 동기화"): the windup (`<clip>_windup`, at least the Telegraph long) plays from the
 * attack start; the strike (`<clip>`, the AttackDef's clip) starts `lead` s before the first judgement, so its first
 * `hit` is at `lead` (≥ 0.1 s: the 0.1 s windup → strike blend is over before the blow) and it runs to the AttackDef's
 * `duration`. tests/unit/anim/clipSync.test.ts checks every pair against its AttackDef.
 * Aether Sentinel's three rings spin procedurally in the enemy view (their bones are not keyed here).
 */
import * as THREE from 'three';
import type { AttackClipPair, EnemyClipSet } from '../animState';
import type { EulerDeg, PoseClip } from '../clip';
import { body, hit, poseClip, stand, step, vfx, type BodyPose, type KeyPose, type Pose } from './author';

const q = (x = 0, y = 0, z = 0): EulerDeg => [x, y, z];
const SIDES = [['left', 1], ['right', -1]] as const;

// ── Pose builders per preset ────────────────────────────────────────────────

type Leg2 = readonly [lift: number, knee: number];

interface QuadPose {
  readonly hips?: EulerDeg; readonly spine?: EulerDeg; readonly chest?: EulerDeg; readonly neck?: EulerDeg; readonly head?: EulerDeg;
  readonly fl?: Leg2; readonly fr?: Leg2; readonly bl?: Leg2; readonly br?: Leg2;
  /** Tail joints (cinder hounds only). */
  readonly tail?: readonly [EulerDeg, EulerDeg];
}

function quad(p: QuadPose): Pose {
  const out: Record<string, EulerDeg> = {
    hips: p.hips ?? q(), spine: p.spine ?? q(), chest: p.chest ?? q(), neck: p.neck ?? q(), head: p.head ?? q(),
  };
  const legs: [string, Leg2 | undefined][] = [['leftFront', p.fl], ['rightFront', p.fr], ['leftBack', p.bl], ['rightBack', p.br]];
  for (const [n, l] of legs) {
    const [lift, knee] = l ?? [0, 8];
    out[`${n}UpperLeg`] = q(-lift);
    out[`${n}LowerLeg`] = q(knee);
    out[`${n}Foot`] = q(-knee * 0.4);
  }
  if (p.tail !== undefined) {
    out.tail0 = p.tail[0];
    out.tail1 = p.tail[1];
  }
  return out;
}

interface CrabPose {
  readonly body?: EulerDeg; readonly head?: EulerDeg;
  /** Leg raise of the two tripods (A: left 0, 2 and right 1; B: the others). */
  readonly a?: number; readonly b?: number;
  /** Claw raise, pincer opening, sideways spread. */
  readonly clawLift?: number; readonly clawOpen?: number; readonly clawSpread?: number;
  readonly tail?: readonly [number, number];
}

function crab(p: CrabPose): Pose {
  const out: Record<string, EulerDeg> = { body: p.body ?? q(), head: p.head ?? q() };
  for (const [side, s] of SIDES) {
    for (let i = 0; i < 3; i++) {
      const groupA = side === 'left' ? i !== 1 : i === 1;
      const raise = (groupA ? p.a : p.b) ?? 0;
      out[`${side}Leg${i}Upper`] = q(0, 0, s * raise);
      out[`${side}Leg${i}Lower`] = q(0, 0, -s * raise * 0.4);
      out[`${side}Leg${i}Foot`] = q();
    }
    out[`${side}ClawUpper`] = q(-(p.clawLift ?? 0), s * (p.clawSpread ?? 0), 0);
    out[`${side}Claw`] = q(0, s * (p.clawOpen ?? 0), 0);
  }
  out.tail0 = q(p.tail?.[0] ?? 0);
  out.tail1 = q(p.tail?.[1] ?? 0);
  return out;
}

interface FloatPose {
  readonly body?: EulerDeg; readonly head?: EulerDeg;
  /** Wing flap (+ up), forward sweep, fold of the outer joints. */
  readonly flap?: number; readonly sweep?: number; readonly fold?: number;
  /** Ash Wisp's lower wing pair. */
  readonly flapB?: number;
  readonly tail?: EulerDeg; readonly talons?: EulerDeg;
}

function floater(p: FloatPose, extras: { wingB?: boolean; tail?: boolean } = {}): Pose {
  const out: Record<string, EulerDeg> = { body: p.body ?? q(), head: p.head ?? q() };
  const flap = p.flap ?? 0;
  const sweep = p.sweep ?? 0;
  const fold = p.fold ?? 0;
  for (const [side, s] of SIDES) {
    out[`${side}Wing0`] = q(0, -s * sweep, s * flap);
    out[`${side}Wing1`] = q(0, -s * sweep * 0.4 - s * fold, s * flap * 0.5);
    out[`${side}Wing2`] = q(0, -s * fold * 0.6, s * flap * 0.3);
    if (extras.wingB === true) {
      out[`${side}WingB0`] = q(0, 0, s * (p.flapB ?? 0));
      out[`${side}WingB1`] = q(0, 0, s * (p.flapB ?? 0) * 0.5);
    }
  }
  if (extras.tail === true) {
    out.tail = p.tail ?? q();
    out.talons = p.talons ?? q();
  }
  return out;
}

const PETAL_AXES: THREE.Vector3[] = Array.from({ length: 5 }, (_, i) => {
  const a = (i / 5) * Math.PI * 2;
  return new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
});
const _pq = new THREE.Quaternion();
const _pe = new THREE.Euler();

/** Euler (deg) opening petal `i` outward by `deg`. */
function petalOpen(i: number, deg: number): EulerDeg {
  _pq.setFromAxisAngle(PETAL_AXES[i]!, (deg * Math.PI) / 180);
  _pe.setFromQuaternion(_pq, 'XYZ');
  const r = 180 / Math.PI;
  return [_pe.x * r, _pe.y * r, _pe.z * r];
}

interface StalkPose {
  readonly bend?: number; readonly side?: number; readonly twist?: number; readonly head?: EulerDeg; readonly petals?: number;
}

function stalk(p: StalkPose): Pose {
  const bend = p.bend ?? 0;
  const side = p.side ?? 0;
  const twist = p.twist ?? 0;
  const out: Record<string, EulerDeg> = {
    stalk0: q(bend * 0.1, twist * 0.25, side * 0.1),
    stalk1: q(bend * 0.3, twist * 0.25, side * 0.3),
    stalk2: q(bend * 0.3, twist * 0.25, side * 0.3),
    stalk3: q(bend * 0.3, twist * 0.25, side * 0.3),
    head: p.head ?? q(),
  };
  for (let i = 0; i < 5; i++) out[`petal${i}`] = petalOpen(i, p.petals ?? 4);
  return out;
}

// ── Clip helpers ────────────────────────────────────────────────────────────

const loop = (name: string, duration: number, keys: KeyPose[], forward?: number, events: PoseClip['events'] = []): PoseClip =>
  poseClip({ name, duration, loop: true, keys, forward, events });
const once = (name: string, duration: number, keys: KeyPose[], events: PoseClip['events'] = []): PoseClip =>
  poseClip({ name, duration, keys, events });

interface PairSpec {
  /** The AttackDef's clip name. */
  readonly clip: string;
  /** Windup length (≥ the Telegraph: the first hit's time). */
  readonly windup: number;
  readonly windupKeys: KeyPose[];
  /** Strike length (AttackDef duration − strike start). */
  readonly strike: number;
  readonly lead: number;
  /** Strike-local hit times (the first is `lead`). */
  readonly hits: readonly number[];
  readonly strikeKeys: KeyPose[];
  readonly fx?: string;
}

function pair(p: PairSpec): { clips: PoseClip[]; pair: AttackClipPair } {
  const windup = once(`${p.clip}_windup`, p.windup, p.windupKeys, [{ t: 0, kind: 'anticipation', data: 'telegraph' }]);
  const strike = once(p.clip, p.strike, p.strikeKeys, [...p.hits.map(hit), ...(p.fx === undefined ? [] : [vfx(p.lead, p.fx)])]);
  return { clips: [windup, strike], pair: { windup: windup.name, strike: strike.name, lead: p.lead } };
}

interface KindSet {
  readonly clips: PoseClip[];
  readonly set: EnemyClipSet;
}

function kind(id: string, base: { idle: PoseClip; move: PoseClip; hurt: PoseClip; stagger: PoseClip; defeat: PoseClip }, pairs: ReturnType<typeof pair>[]): KindSet {
  const attacks: Record<string, AttackClipPair> = {};
  for (const p of pairs) attacks[p.pair.strike] = p.pair;
  return {
    clips: [base.idle, base.move, base.hurt, base.stagger, base.defeat, ...pairs.flatMap((p) => p.clips)],
    set: { idle: base.idle.name, move: base.move.name, hurt: base.hurt.name, stagger: base.stagger.name, defeat: base.defeat.name, attacks },
  };
}

// ── Bramblekin ──────────────────────────────────────────────────────────────

const bIdle = quad({ spine: q(0), head: q(0, 0, 0) });
const bramblekinBase = {
  idle: loop('bramblekin_idle', 1.6, [{ t: 0, pose: bIdle }, { t: 0.8, pose: quad({ spine: q(4), head: q(-6, 12, 0) }) }]),
  move: loop('bramblekin_move', 0.5, [
    { t: 0, pose: quad({ fl: [30, 10], br: [25, 10], fr: [-25, 30], bl: [-20, 30], spine: q(0, 0, 4), head: q(6) }) },
    { t: 0.25, pose: quad({ fr: [30, 10], bl: [25, 10], fl: [-25, 30], br: [-20, 30], spine: q(0, 0, -4), head: q(6) }) },
  ], 1.1, [step(0), step(0.25)]),
  hurt: once('bramblekin_hurt', 0.2, [{ t: 0, pose: bIdle }, { t: 0.06, pose: quad({ chest: q(-15), head: q(-20) }), ease: 'out' }, { t: 0.2, pose: bIdle }]),
  stagger: loop('bramblekin_stagger', 1.0, [
    { t: 0, pose: quad({ spine: q(0, 0, 12), head: q(10, 25, 0) }) },
    { t: 0.5, pose: quad({ spine: q(0, 0, -12), head: q(10, -25, 0) }) },
  ]),
  defeat: once('bramblekin_defeat', 1.0, [
    { t: 0, pose: bIdle },
    { t: 0.4, pose: quad({ hips: q(0, 0, 70), fl: [40, 60], fr: [20, 70], bl: [30, 60], br: [10, 70], head: q(20) }), ease: 'out' },
    { t: 1.0, pose: quad({ hips: q(0, 0, 80), fl: [45, 70], fr: [25, 80], bl: [35, 70], br: [15, 80], head: q(30) }) },
  ]),
};
const bramblekinClaw = pair({
  clip: 'bramblekin_claw', windup: 0.4, lead: 0.15, strike: 0.95, hits: [0.15, 0.55], fx: 'claw',
  windupKeys: [{ t: 0, pose: bIdle }, { t: 0.4, pose: quad({ chest: q(-25), head: q(-15), fl: [70, 40], fr: [60, 50], hips: q(10) }) }],
  strikeKeys: [
    { t: 0, pose: quad({ chest: q(-25), head: q(-15), fl: [70, 40], fr: [60, 50], hips: q(10) }) },
    { t: 0.15, pose: quad({ chest: q(15, 20, 0), head: q(5, 15, 0), fl: [20, 10], fr: [70, 40] }), ease: 'out' },
    { t: 0.35, pose: quad({ chest: q(-20), head: q(-10), fl: [65, 40], fr: [65, 40], hips: q(8) }) },
    { t: 0.55, pose: quad({ chest: q(15, -20, 0), head: q(5, -15, 0), fr: [20, 10], fl: [70, 40] }), ease: 'out' },
    { t: 0.95, pose: bIdle },
  ],
});
const BRAMBLEKIN = kind('bramblekin', bramblekinBase, [bramblekinClaw]);

// ── Thornspitter ────────────────────────────────────────────────────────────

const tIdle = stalk({ bend: 3, side: 2 });
const thornspitterBase = {
  idle: loop('thornspitter_idle', 2.4, [{ t: 0, pose: tIdle }, { t: 1.2, pose: stalk({ bend: 5, side: -3, petals: 8, head: q(-4, 8, 0) }) }]),
  move: loop('thornspitter_move', 1.2, [{ t: 0, pose: stalk({ bend: 15, side: 8, twist: 20 }) }, { t: 0.6, pose: stalk({ bend: 15, side: -8, twist: -20 }) }]),
  hurt: once('thornspitter_hurt', 0.2, [{ t: 0, pose: tIdle }, { t: 0.06, pose: stalk({ bend: -14, head: q(-15) }), ease: 'out' }, { t: 0.2, pose: tIdle }]),
  stagger: loop('thornspitter_stagger', 1.2, [{ t: 0, pose: stalk({ bend: 20, side: 18, petals: 30, head: q(20) }) }, { t: 0.6, pose: stalk({ bend: 24, side: -18, petals: 30, head: q(25) }) }]),
  defeat: once('thornspitter_defeat', 1.0, [
    { t: 0, pose: tIdle },
    { t: 0.5, pose: stalk({ bend: 90, side: 10, petals: 70, head: q(30) }), ease: 'out' },
    { t: 1.0, pose: stalk({ bend: 110, side: 12, petals: 95, head: q(40) }) },
  ]),
};
const thornspitterSpike = pair({
  clip: 'thornspitter_spike', windup: 0.8, lead: 0.2, strike: 0.8, hits: [0.2], fx: 'spike',
  windupKeys: [{ t: 0, pose: tIdle }, { t: 0.8, pose: stalk({ bend: -32, petals: 45, head: q(-20) }) }],
  strikeKeys: [
    { t: 0, pose: stalk({ bend: -30, petals: 45, head: q(-20) }) },
    { t: 0.2, pose: stalk({ bend: 40, petals: 72, head: q(10) }), ease: 'out' },
    { t: 0.8, pose: tIdle },
  ],
});
const THORNSPITTER = kind('thornspitter', thornspitterBase, [thornspitterSpike]);

// ── Mossback Brute (and Old Mossback) ───────────────────────────────────────

const GUARD: BodyPose = stand({
  spine: [22, 0, 0], chest: [10, 0, 0], neck: [-15, 0, 0], head: [-10, 0, 0],
  la: { down: 55, fwd: 55, across: 35, bend: 95 }, ra: { down: 55, fwd: 55, across: 35, bend: 95 },
  ll: { lift: 20, knee: 30, spread: 6 }, rl: { lift: 20, knee: 30, spread: 6 },
});
const mb = (over: BodyPose = {}): Pose => body({ ...GUARD, ...over, la: { ...GUARD.la, ...over.la }, ra: { ...GUARD.ra, ...over.ra }, ll: { ...GUARD.ll, ...over.ll }, rl: { ...GUARD.rl, ...over.rl } });
const mossbackBase = {
  idle: loop('mossbackBrute_idle', 2.8, [{ t: 0, pose: mb() }, { t: 1.4, pose: mb({ spine: [24, 0, 0], head: [-12, 6, 0] }) }]),
  move: loop('mossbackBrute_move', 1.1, [
    { t: 0, pose: mb({ ll: { lift: 22, knee: 25 }, rl: { lift: -12, knee: 30 }, spine: [22, 0, 6] }) },
    { t: 0.55, pose: mb({ rl: { lift: 22, knee: 25 }, ll: { lift: -12, knee: 30 }, spine: [22, 0, -6] }) },
  ], 1.6, [step(0), step(0.55)]),
  hurt: once('mossbackBrute_hurt', 0.2, [{ t: 0, pose: mb() }, { t: 0.06, pose: mb({ spine: [8, 0, 0], head: [-25, 0, 0] }), ease: 'out' }, { t: 0.2, pose: mb() }]),
  stagger: loop('mossbackBrute_stagger', 1.2, [
    { t: 0, pose: mb({ la: { down: 85, fwd: 10, across: 0, bend: 20 }, ra: { down: 85, fwd: 10, across: 0, bend: 20 }, head: [25, 15, 0], spine: [28, 0, 8] }) },
    { t: 0.6, pose: mb({ la: { down: 85, fwd: 10, across: 0, bend: 25 }, ra: { down: 85, fwd: 10, across: 0, bend: 25 }, head: [25, -15, 0], spine: [28, 0, -8] }) },
  ]),
  defeat: once('mossbackBrute_defeat', 1.2, [
    { t: 0, pose: mb() },
    { t: 0.5, pose: mb({ ll: { lift: 80, knee: 110 }, rl: { lift: 75, knee: 110 }, spine: [35, 0, 0], la: { down: 85, fwd: 20, across: 0, bend: 20 }, ra: { down: 85, fwd: 20, across: 0, bend: 20 } }), ease: 'out' },
    { t: 1.2, pose: mb({ hips: [55, 0, 0], ll: { lift: 85, knee: 120 }, rl: { lift: 80, knee: 120 }, spine: [40, 0, 0], head: [30, 0, 0], la: { down: 60, fwd: 60, across: 0, bend: 30 }, ra: { down: 60, fwd: 60, across: 0, bend: 30 } }) },
  ]),
};
const mossbackSweep = pair({
  clip: 'mossbackBrute_sweep', windup: 0.8, lead: 0.2, strike: 0.9, hits: [0.2], fx: 'sweep',
  windupKeys: [{ t: 0, pose: mb() }, { t: 0.8, pose: mb({ ra: { down: 30, fwd: -30, across: -40, bend: 30 }, spine: [18, -40, 0] }) }],
  strikeKeys: [
    { t: 0, pose: mb({ ra: { down: 30, fwd: -30, across: -40, bend: 30 }, spine: [18, -40, 0] }) },
    { t: 0.2, pose: mb({ ra: { down: 30, fwd: 70, across: 80, bend: 10 }, spine: [22, 45, 0], rl: { lift: 30, knee: 30 } }), ease: 'out' },
    { t: 0.9, pose: mb() },
  ],
});
const smashUp = mb({ la: { down: -70, fwd: 30, across: 10, bend: 60 }, ra: { down: -70, fwd: 30, across: 10, bend: 60 }, spine: [-5, 0, 0], head: [-15, 0, 0] });
const mossbackSmash = pair({
  clip: 'mossbackBrute_smash', windup: 0.9, lead: 0.2, strike: 0.9, hits: [0.2], fx: 'smash',
  windupKeys: [{ t: 0, pose: mb() }, { t: 0.9, pose: smashUp }],
  strikeKeys: [
    { t: 0, pose: smashUp },
    { t: 0.2, pose: mb({ la: { down: 60, fwd: 80, across: 10, bend: 20 }, ra: { down: 60, fwd: 80, across: 10, bend: 20 }, spine: [45, 0, 0], ll: { lift: 40, knee: 60 }, rl: { lift: 40, knee: 60 } }), ease: 'out' },
    { t: 0.9, pose: mb() },
  ],
});
const MOSSBACK = kind('mossbackBrute', mossbackBase, [mossbackSweep, mossbackSmash]);
const oldMossbackSpores = pair({
  clip: 'oldMossback_spores', windup: 1.0, lead: 0.2, strike: 0.8, hits: [0.2], fx: 'spores',
  windupKeys: [{ t: 0, pose: mb() }, { t: 1.0, pose: mb({ spine: [45, 0, 0], chest: [15, 0, 0], la: { down: 30, fwd: 20, across: -20, bend: 40 }, ra: { down: 30, fwd: 20, across: -20, bend: 40 } }) }],
  strikeKeys: [
    { t: 0, pose: mb({ spine: [45, 0, 0], chest: [15, 0, 0], la: { down: 30, fwd: 20, across: -20, bend: 40 }, ra: { down: 30, fwd: 20, across: -20, bend: 40 } }) },
    { t: 0.2, pose: mb({ spine: [-15, 0, 0], chest: [-10, 0, 0], head: [-30, 0, 0], la: { down: 10, fwd: 10, across: -30, bend: 20 }, ra: { down: 10, fwd: 10, across: -30, bend: 20 } }), ease: 'out' },
    { t: 0.8, pose: mb() },
  ],
});

// ── Cinder Hound (and Emberjaw, Cinder Alpha) ───────────────────────────────

const TAIL_UP = [q(25), q(15)] as const;
const hIdle = quad({ tail: TAIL_UP, head: q(5) });
const houndBase = {
  idle: loop('cinderHound_idle', 1.4, [{ t: 0, pose: hIdle }, { t: 0.7, pose: quad({ chest: q(3), head: q(8, 6, 0), tail: [q(25, 15, 0), q(15, 10, 0)] }) }]),
  move: loop('cinderHound_move', 0.45, [
    { t: 0, pose: quad({ fl: [45, 10], fr: [40, 12], bl: [-40, 20], br: [-35, 22], spine: q(-6), head: q(-6), tail: [q(10), q(5)] }) },
    { t: 0.225, pose: quad({ fl: [-35, 40], fr: [-30, 42], bl: [40, 10], br: [35, 12], spine: q(6), head: q(4), tail: [q(20), q(10)] }) },
  ], 2.6, [step(0), step(0.225)]),
  hurt: once('cinderHound_hurt', 0.2, [{ t: 0, pose: hIdle }, { t: 0.06, pose: quad({ chest: q(-12), head: q(-20, 10, 0), tail: TAIL_UP }), ease: 'out' }, { t: 0.2, pose: hIdle }]),
  stagger: loop('cinderHound_stagger', 1.0, [
    { t: 0, pose: quad({ head: q(20, 30, 0), spine: q(0, 0, 10), fl: [10, 30], fr: [-10, 30], tail: [q(-10), q(0)] }) },
    { t: 0.5, pose: quad({ head: q(20, -30, 0), spine: q(0, 0, -10), fl: [-10, 30], fr: [10, 30], tail: [q(-10), q(0)] }) },
  ]),
  defeat: once('cinderHound_defeat', 1.0, [
    { t: 0, pose: hIdle },
    { t: 0.4, pose: quad({ hips: q(0, 0, 80), fl: [30, 40], fr: [10, 60], bl: [20, 40], br: [0, 60], head: q(25), tail: [q(-20), q(-10)] }), ease: 'out' },
    { t: 1.0, pose: quad({ hips: q(0, 0, 85), fl: [35, 50], fr: [15, 70], bl: [25, 50], br: [5, 70], head: q(35), tail: [q(-25), q(-15)] }) },
  ]),
};
const CROUCH = quad({ bl: [-10, 45], br: [-10, 45], fl: [20, 35], fr: [20, 35], chest: q(10), head: q(15), tail: [q(40), q(20)] });
const STRETCH = quad({ fl: [60, 5], fr: [55, 5], bl: [-50, 5], br: [-48, 5], head: q(-10), spine: q(-4), tail: [q(5), q(0)] });
const houndDash = pair({
  clip: 'cinderHound_dash', windup: 0.8, lead: 0.15, strike: 0.75, hits: [0.15], fx: 'ember:dash',
  windupKeys: [{ t: 0, pose: hIdle }, { t: 0.8, pose: CROUCH }],
  strikeKeys: [{ t: 0, pose: CROUCH }, { t: 0.15, pose: STRETCH, ease: 'out' }, { t: 0.45, pose: STRETCH }, { t: 0.75, pose: hIdle }],
});
const HOUND = kind('cinderHound', houndBase, [houndDash]);
const emberjawTriple = pair({
  clip: 'emberjaw_tripleDash', windup: 0.8, lead: 0.15, strike: 2.95, hits: [0.15, 1.25, 2.35], fx: 'ember:dash',
  windupKeys: [{ t: 0, pose: hIdle }, { t: 0.8, pose: CROUCH }],
  strikeKeys: [
    { t: 0, pose: CROUCH }, { t: 0.15, pose: STRETCH, ease: 'out' }, { t: 0.5, pose: STRETCH },
    { t: 1.0, pose: CROUCH }, { t: 1.25, pose: STRETCH, ease: 'out' }, { t: 1.6, pose: STRETCH },
    { t: 2.1, pose: CROUCH }, { t: 2.35, pose: STRETCH, ease: 'out' }, { t: 2.7, pose: STRETCH }, { t: 2.95, pose: hIdle },
  ],
});
const REAR = quad({ hips: q(-10), chest: q(-40), head: q(-20), fl: [70, 60], fr: [65, 60], bl: [10, 30], br: [10, 30], tail: [q(30), q(20)] });
const cinderAlphaRing = pair({
  clip: 'cinderAlpha_fireRing', windup: 1.0, lead: 0.2, strike: 1.0, hits: [0.2], fx: 'ember:ring',
  windupKeys: [{ t: 0, pose: hIdle }, { t: 1.0, pose: REAR }],
  strikeKeys: [
    { t: 0, pose: REAR },
    { t: 0.2, pose: quad({ chest: q(15), head: q(20), fl: [30, 10], fr: [30, 10], bl: [-20, 40], br: [-20, 40], tail: [q(35), q(20)] }), ease: 'out' },
    { t: 1.0, pose: hIdle },
  ],
});

// ── Slagshell ───────────────────────────────────────────────────────────────

const sIdle = crab({ clawLift: 10, clawOpen: 8, tail: [10, 5] });
const slagshellBase = {
  idle: loop('slagshell_idle', 2.0, [{ t: 0, pose: sIdle }, { t: 1.0, pose: crab({ body: q(2), clawLift: 14, clawOpen: 18, clawSpread: 5, a: 4, tail: [12, 8] }) }]),
  move: loop('slagshell_move', 0.8, [
    { t: 0, pose: crab({ a: 22, b: 0, clawLift: 12, clawOpen: 8, body: q(0, 0, 3), tail: [10, 5] }) },
    { t: 0.4, pose: crab({ a: 0, b: 22, clawLift: 12, clawOpen: 8, body: q(0, 0, -3), tail: [10, 5] }) },
  ], 1.2, [step(0), step(0.4)]),
  hurt: once('slagshell_hurt', 0.2, [{ t: 0, pose: sIdle }, { t: 0.06, pose: crab({ body: q(-10), clawLift: 30, clawOpen: 30, tail: [20, 10] }), ease: 'out' }, { t: 0.2, pose: sIdle }]),
  stagger: loop('slagshell_stagger', 1.2, [
    { t: 0, pose: crab({ body: q(8, 0, 8), clawLift: -10, clawOpen: 30, a: 15, tail: [-5, 0] }) },
    { t: 0.6, pose: crab({ body: q(8, 0, -8), clawLift: -10, clawOpen: 30, b: 15, tail: [-5, 0] }) },
  ]),
  defeat: once('slagshell_defeat', 1.0, [
    { t: 0, pose: sIdle },
    { t: 0.5, pose: crab({ body: q(15, 0, 20), a: 45, b: 45, clawLift: -20, clawOpen: 40, tail: [-15, -10] }), ease: 'out' },
    { t: 1.0, pose: crab({ body: q(18, 0, 24), a: 55, b: 55, clawLift: -25, clawOpen: 45, tail: [-20, -10] }) },
  ]),
};
const TAIL_HIGH = crab({ body: q(-10), clawLift: 35, clawOpen: 25, tail: [55, 45] });
const slagshellSlam = pair({
  clip: 'slagshell_slam', windup: 1.0, lead: 0.2, strike: 0.9, hits: [0.2], fx: 'ember:slam',
  windupKeys: [{ t: 0, pose: sIdle }, { t: 1.0, pose: TAIL_HIGH }],
  strikeKeys: [
    { t: 0, pose: TAIL_HIGH },
    { t: 0.2, pose: crab({ body: q(8), clawLift: -15, clawOpen: 5, tail: [-25, -18], a: 10, b: 10 }), ease: 'out' },
    { t: 0.9, pose: sIdle },
  ],
});
const SLAGSHELL = kind('slagshell', slagshellBase, [slagshellSlam]);

// ── Ash Wisp ────────────────────────────────────────────────────────────────

const aw = (p: FloatPose): Pose => floater(p, { wingB: true });
const aIdle = aw({ flap: 10, flapB: -8 });
const ashWispBase = {
  idle: loop('ashWisp_idle', 2.2, [{ t: 0, pose: aw({ flap: 22, flapB: -12, body: q(-3) }) }, { t: 1.1, pose: aw({ flap: -14, flapB: 14, body: q(3) }) }]),
  move: loop('ashWisp_move', 1.4, [{ t: 0, pose: aw({ flap: 32, flapB: -20, body: q(6) }) }, { t: 0.7, pose: aw({ flap: -24, flapB: 20, body: q(10) }) }]),
  hurt: once('ashWisp_hurt', 0.2, [{ t: 0, pose: aIdle }, { t: 0.06, pose: aw({ flap: 40, flapB: 30, body: q(-20), head: q(-15) }), ease: 'out' }, { t: 0.2, pose: aIdle }]),
  stagger: loop('ashWisp_stagger', 1.0, [{ t: 0, pose: aw({ flap: -30, flapB: -30, body: q(10, 0, 25) }) }, { t: 0.5, pose: aw({ flap: -30, flapB: -30, body: q(10, 0, -25) }) }]),
  defeat: once('ashWisp_defeat', 1.0, [
    { t: 0, pose: aIdle },
    { t: 0.5, pose: aw({ flap: -60, flapB: -50, fold: 30, body: q(50, 0, 10), head: q(20) }), ease: 'out' },
    { t: 1.0, pose: aw({ flap: -70, flapB: -60, fold: 40, body: q(70, 0, 15), head: q(30) }) },
  ]),
};
const AW_BACK = aw({ flap: 40, flapB: 25, body: q(-20), head: q(-15) });
const ashWispFireball = pair({
  clip: 'ashWisp_fireball', windup: 0.6, lead: 0.15, strike: 0.75, hits: [0.15], fx: 'ember:fireball',
  windupKeys: [{ t: 0, pose: aIdle }, { t: 0.6, pose: AW_BACK }],
  strikeKeys: [{ t: 0, pose: AW_BACK }, { t: 0.15, pose: aw({ flap: -30, flapB: -20, sweep: 20, body: q(25), head: q(10) }), ease: 'out' }, { t: 0.75, pose: aIdle }],
});
const ASH_WISP = kind('ashWisp', ashWispBase, [ashWispFireball]);

// ── Windcutter (and Galeclaw) ───────────────────────────────────────────────

const wc = (p: FloatPose): Pose => floater(p, { tail: true });
const wIdle = wc({ flap: 10, talons: q(10) });
const windcutterBase = {
  idle: loop('windcutter_idle', 1.2, [{ t: 0, pose: wc({ flap: 35, fold: 5, talons: q(10) }) }, { t: 0.6, pose: wc({ flap: -25, fold: 15, talons: q(10) }) }]),
  move: loop('windcutter_move', 0.7, [{ t: 0, pose: wc({ flap: 40, sweep: -10, body: q(10) }) }, { t: 0.35, pose: wc({ flap: -30, sweep: 5, body: q(12) }) }], 3.0),
  hurt: once('windcutter_hurt', 0.2, [{ t: 0, pose: wIdle }, { t: 0.06, pose: wc({ flap: 50, body: q(-18), head: q(-20) }), ease: 'out' }, { t: 0.2, pose: wIdle }]),
  stagger: loop('windcutter_stagger', 1.0, [{ t: 0, pose: wc({ flap: -20, fold: 30, body: q(10, 0, 20), head: q(15) }) }, { t: 0.5, pose: wc({ flap: -20, fold: 30, body: q(10, 0, -20), head: q(15) }) }]),
  defeat: once('windcutter_defeat', 1.0, [
    { t: 0, pose: wIdle },
    { t: 0.5, pose: wc({ flap: -50, fold: 50, body: q(55, 0, 20), head: q(25) }), ease: 'out' },
    { t: 1.0, pose: wc({ flap: -60, fold: 60, body: q(70, 0, 25), head: q(30) }) },
  ]),
};
const WC_WIND = wc({ flap: 45, sweep: -35, body: q(-15), talons: q(-30) });
const WC_DIVE = wc({ flap: 5, sweep: -55, fold: 20, body: q(20), head: q(-10), tail: q(10) });
const windcutterBlade = pair({
  clip: 'windcutter_blade', windup: 0.8, lead: 0.15, strike: 0.65, hits: [0.15], fx: 'gale:blade',
  windupKeys: [{ t: 0, pose: wIdle }, { t: 0.8, pose: WC_WIND }],
  strikeKeys: [{ t: 0, pose: WC_WIND }, { t: 0.15, pose: WC_DIVE, ease: 'out' }, { t: 0.45, pose: WC_DIVE }, { t: 0.65, pose: wIdle }],
});
const WINDCUTTER = kind('windcutter', windcutterBase, [windcutterBlade]);
const galeclawTornado = pair({
  clip: 'galeclaw_tornado', windup: 1.0, lead: 0.2, strike: 0.8, hits: [0.2], fx: 'gale:tornado',
  windupKeys: [{ t: 0, pose: wIdle }, { t: 0.5, pose: wc({ flap: 60, body: q(-10, 90, 0) }) }, { t: 1.0, pose: wc({ flap: 60, body: q(-10, 200, 0) }) }],
  strikeKeys: [
    { t: 0, pose: wc({ flap: 60, body: q(-10, 200, 0) }) },
    { t: 0.2, pose: wc({ flap: -40, sweep: 30, body: q(15, 360, 0) }), ease: 'out' },
    { t: 0.8, pose: wIdle },
  ],
});

// ── Aether Sentinel (and Sentinel Prime) ────────────────────────────────────

/** Sentinel arm pose: `raise` (+ up) of the upper arm, `bend` of the forearm toward the front. */
function sentinel(p: { body?: EulerDeg; head?: EulerDeg; raise?: number; bend?: number; spread?: number }): Pose {
  const out: Record<string, EulerDeg> = { body: p.body ?? q(), head: p.head ?? q() };
  for (const [side, s] of SIDES) {
    out[`${side}Wing0`] = q(0, -s * (p.spread ?? 0), s * (p.raise ?? -55));
    out[`${side}Wing1`] = q(0, -s * (p.bend ?? 25), 0);
    out[`${side}Wing2`] = q();
  }
  return out;
}
const snIdle = sentinel({});
const sentinelBase = {
  idle: loop('aetherSentinel_idle', 3.0, [{ t: 0, pose: snIdle }, { t: 1.5, pose: sentinel({ body: q(2, 0, 2), raise: -52, bend: 28 }) }]),
  move: loop('aetherSentinel_move', 2.0, [{ t: 0, pose: sentinel({ body: q(8, 0, 3), raise: -58, bend: 20, spread: 10 }) }, { t: 1.0, pose: sentinel({ body: q(8, 0, -3), raise: -58, bend: 20, spread: -10 }) }], 1.6),
  hurt: once('aetherSentinel_hurt', 0.2, [{ t: 0, pose: snIdle }, { t: 0.06, pose: sentinel({ body: q(-10), raise: -40, bend: 50 }), ease: 'out' }, { t: 0.2, pose: snIdle }]),
  stagger: loop('aetherSentinel_stagger', 1.4, [{ t: 0, pose: sentinel({ body: q(12, 0, 10), raise: -75, bend: 5, head: q(20) }) }, { t: 0.7, pose: sentinel({ body: q(12, 0, -10), raise: -75, bend: 5, head: q(20) }) }]),
  defeat: once('aetherSentinel_defeat', 1.4, [
    { t: 0, pose: snIdle },
    { t: 0.6, pose: sentinel({ body: q(25, 0, 15), raise: -85, bend: 0, head: q(30) }), ease: 'out' },
    { t: 1.4, pose: sentinel({ body: q(35, 0, 20), raise: -88, bend: 0, head: q(40) }) },
  ]),
};
const SN_UP = sentinel({ body: q(-10), raise: 70, bend: 60 });
const sentinelSlam = pair({
  clip: 'aetherSentinel_slam', windup: 1.2, lead: 0.25, strike: 0.95, hits: [0.25], fx: 'slam',
  windupKeys: [{ t: 0, pose: snIdle }, { t: 1.2, pose: SN_UP }],
  strikeKeys: [{ t: 0, pose: SN_UP }, { t: 0.25, pose: sentinel({ body: q(15), raise: -70, bend: 10 }), ease: 'out' }, { t: 0.95, pose: snIdle }],
});
const SN_AIM = sentinel({ body: q(-5), raise: 10, bend: 5, spread: -20 });
const sentinelBeam = pair({
  clip: 'aetherSentinel_beam', windup: 1.0, lead: 0.15, strike: 0.75, hits: [0.15], fx: 'beam',
  windupKeys: [{ t: 0, pose: snIdle }, { t: 1.0, pose: SN_AIM }],
  strikeKeys: [{ t: 0, pose: SN_AIM }, { t: 0.15, pose: sentinel({ body: q(-12), raise: 20, bend: 5, spread: -20 }), ease: 'out' }, { t: 0.55, pose: SN_AIM }, { t: 0.75, pose: snIdle }],
});
const SENTINEL = kind('aetherSentinel', sentinelBase, [sentinelSlam, sentinelBeam]);
const SP_FWD = sentinel({ body: q(-5, -45, 0), raise: 0, bend: 60, spread: -40 });
const primeSweep = pair({
  clip: 'sentinelPrime_beamSweep', windup: 1.2, lead: 0.2, strike: 1.0, hits: [0.2], fx: 'beam',
  windupKeys: [{ t: 0, pose: snIdle }, { t: 1.2, pose: SP_FWD }],
  strikeKeys: [{ t: 0, pose: SP_FWD }, { t: 0.2, pose: sentinel({ body: q(-5, -30, 0), raise: 0, bend: 60, spread: -40 }) }, { t: 0.7, pose: sentinel({ body: q(-5, 45, 0), raise: 0, bend: 60, spread: -40 }) }, { t: 1.0, pose: snIdle }],
});

// ── Sentinel Prime's drones ─────────────────────────────────────────────────

const droneRest = (x = 0): Pose => ({ body: q(x), head: q() });
const droneBase = {
  idle: loop('sentinelDrone_idle', 2.0, [{ t: 0, pose: droneRest(-4) }, { t: 1.0, pose: droneRest(4) }]),
  move: loop('sentinelDrone_move', 1.0, [{ t: 0, pose: droneRest(10) }, { t: 0.5, pose: droneRest(6) }]),
  hurt: once('sentinelDrone_hurt', 0.2, [{ t: 0, pose: droneRest() }, { t: 0.06, pose: droneRest(-25), ease: 'out' }, { t: 0.2, pose: droneRest() }]),
  stagger: loop('sentinelDrone_stagger', 1.0, [{ t: 0, pose: { body: q(10, 0, 20), head: q() } }, { t: 0.5, pose: { body: q(10, 0, -20), head: q() } }]),
  defeat: once('sentinelDrone_defeat', 0.8, [{ t: 0, pose: droneRest() }, { t: 0.8, pose: { body: q(80, 0, 40), head: q() } }]),
};
const droneBolt = pair({
  clip: 'sentinelPrime_droneBolt', windup: 0.6, lead: 0.15, strike: 0.55, hits: [0.15], fx: 'bolt',
  windupKeys: [{ t: 0, pose: droneRest() }, { t: 0.6, pose: droneRest(-12) }],
  strikeKeys: [{ t: 0, pose: droneRest(-12) }, { t: 0.15, pose: droneRest(14), ease: 'out' }, { t: 0.55, pose: droneRest() }],
});
const DRONE = kind('sentinelDrone', droneBase, [droneBolt]);

// ── Rootbound Warden ────────────────────────────────────────────────────────

const WARDEN_REST: BodyPose = { spine: [8, 0, 0], chest: [6, 0, 0], head: [-6, 0, 0], la: { down: 60, fwd: 25, bend: 40 }, ra: { down: 60, fwd: 25, bend: 40 } };
const wd = (over: BodyPose = {}): Pose => {
  const b: BodyPose = { ...WARDEN_REST, ...over, la: { ...WARDEN_REST.la, ...over.la }, ra: { ...WARDEN_REST.ra, ...over.ra } };
  const p = body(b) as Record<string, EulerDeg>;
  // No legs to animate: the torso rises from the root mound.
  for (const j of Object.keys(p)) if (/UpperLeg|LowerLeg|Foot$/.test(j)) delete p[j];
  return p;
};
const wardenBase = {
  idle: loop('rootboundWarden_idle', 3.6, [{ t: 0, pose: wd() }, { t: 1.8, pose: wd({ spine: [10, 6, 0], head: [-4, -8, 0], la: { down: 58, fwd: 28, bend: 44 } }) }]),
  move: loop('rootboundWarden_move', 2.4, [{ t: 0, pose: wd({ spine: [8, 14, 0] }) }, { t: 1.2, pose: wd({ spine: [8, -14, 0] }) }]),
  hurt: once('rootboundWarden_hurt', 0.2, [{ t: 0, pose: wd() }, { t: 0.06, pose: wd({ spine: [-6, 0, 0], head: [-20, 0, 0], la: { down: 40, fwd: 0, bend: 60 }, ra: { down: 40, fwd: 0, bend: 60 } }), ease: 'out' }, { t: 0.2, pose: wd() }]),
  stagger: loop('rootboundWarden_stagger', 1.6, [
    { t: 0, pose: wd({ spine: [30, 0, 10], head: [25, 0, 0], la: { down: 85, fwd: 20, bend: 10 }, ra: { down: 85, fwd: 20, bend: 10 } }) },
    { t: 0.8, pose: wd({ spine: [30, 0, -10], head: [25, 0, 0], la: { down: 85, fwd: 20, bend: 10 }, ra: { down: 85, fwd: 20, bend: 10 } }) },
  ]),
  defeat: once('rootboundWarden_defeat', 1.4, [
    { t: 0, pose: wd() },
    { t: 0.6, pose: wd({ spine: [40, 0, 0], chest: [20, 0, 0], head: [30, 0, 0], la: { down: 85, fwd: 30, bend: 10 }, ra: { down: 85, fwd: 30, bend: 10 } }), ease: 'out' },
    { t: 1.4, pose: wd({ hips: [20, 0, 0], spine: [50, 0, 0], chest: [25, 0, 0], head: [40, 0, 0], la: { down: 88, fwd: 40, bend: 5 }, ra: { down: 88, fwd: 40, bend: 5 } }) },
  ]),
};
const W_UP = wd({ spine: [-8, 0, 0], la: { down: -60, fwd: 40, bend: 50 }, ra: { down: -60, fwd: 40, bend: 50 }, head: [-15, 0, 0] });
const W_DOWN = wd({ spine: [45, 0, 0], chest: [15, 0, 0], la: { down: 70, fwd: 85, bend: 10 }, ra: { down: 70, fwd: 85, bend: 10 } });
const wardenSpikes = pair({
  clip: 'rootboundWarden_rootSpikes', windup: 0.9, lead: 0.2, strike: 2.7, hits: [0.2, 1.1, 2.0], fx: 'roots',
  windupKeys: [{ t: 0, pose: wd() }, { t: 0.9, pose: W_UP }],
  strikeKeys: [
    { t: 0, pose: W_UP }, { t: 0.2, pose: W_DOWN, ease: 'out' }, { t: 0.6, pose: W_DOWN },
    { t: 0.9, pose: W_UP }, { t: 1.1, pose: W_DOWN, ease: 'out' }, { t: 1.5, pose: W_DOWN },
    { t: 1.8, pose: W_UP }, { t: 2.0, pose: W_DOWN, ease: 'out' }, { t: 2.3, pose: W_DOWN }, { t: 2.7, pose: wd() },
  ],
});
const WARDEN = kind('rootboundWarden', wardenBase, [wardenSpikes]);

// ── Sets ────────────────────────────────────────────────────────────────────

function withExtra(base: KindSet, extras: ReturnType<typeof pair>[]): KindSet {
  const attacks: Record<string, AttackClipPair> = { ...base.set.attacks };
  for (const p of extras) attacks[p.pair.strike] = p.pair;
  return { clips: [...base.clips, ...extras.flatMap((p) => p.clips)], set: { ...base.set, attacks } };
}

/** Clip sets by model id (enemy kinds, Elites, and 'sentinelPrime_drone'). */
export const ENEMY_CLIP_SETS = {
  bramblekin: BRAMBLEKIN,
  thornspitter: THORNSPITTER,
  mossbackBrute: MOSSBACK,
  cinderHound: HOUND,
  slagshell: SLAGSHELL,
  ashWisp: ASH_WISP,
  windcutter: WINDCUTTER,
  aetherSentinel: SENTINEL,
  oldMossback: withExtra(MOSSBACK, [oldMossbackSpores]),
  emberjaw: withExtra(HOUND, [emberjawTriple]),
  galeclaw: withExtra(WINDCUTTER, [galeclawTornado]),
  rootboundWarden: WARDEN,
  cinderAlpha: withExtra(HOUND, [cinderAlphaRing]),
  sentinelPrime: withExtra(SENTINEL, [primeSweep]),
  sentinelPrime_drone: DRONE,
} as const satisfies Readonly<Record<string, KindSet>>;

export type EnemyClipModel = keyof typeof ENEMY_CLIP_SETS;

/** Every enemy-side clip once (Elites share their base kind's). */
export const ENEMY_CLIPS: readonly PoseClip[] = (() => {
  const seen = new Map<string, PoseClip>();
  for (const s of Object.values(ENEMY_CLIP_SETS)) for (const c of s.clips) seen.set(c.name, c);
  return [...seen.values()];
})();
