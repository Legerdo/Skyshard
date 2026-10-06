/*
 * Caelith's clips (design.md 클립 목록, Req 39.7): idle, move, a windup · strike pair for each of the eight attacks,
 * phaseShift (p1 → p2 and p2 → final), stagger, disabled and death.
 *
 * Attack timeline (design "타이밍 동기화"): the windup plays from the action start (at least the first Telegraph long);
 * the strike starts `lead` s before the first judgement (when `telegraphRemaining ≤ lead`), carries a `hit` marker at
 * every damaging judgement (CAELITH_ACTIONS `at`, shifted by the strike start) and runs to the end of the action's
 * recovery (activeEnd + recovery). summonCrystals deals no damage: its summon moment is a `vfx` event instead.
 */
import type { CaelithAttack } from '../../data/boss';
import type { BossAttackClips } from '../animState';
import type { PoseClip } from '../clip';
import { from, hit, poseClip, stand, vfx, type KeyPose } from './author';

const REST = stand({
  ra: { down: 60, fwd: 30, bend: 30 }, la: { down: 75, fwd: 6, bend: 16 },
  ll: { lift: 4, knee: 6, spread: 4 }, rl: { lift: 0, knee: 5, spread: 4 }, spine: [2, 0, 0], head: [-3, 0, 0],
});
const c = from(REST);

const idle = poseClip({ name: 'caelith_idle', duration: 4, loop: true, keys: [{ t: 0, pose: c() }, { t: 2, pose: c({ spine: [3, 3, 0], head: [-5, -6, 0], ra: { down: 58, fwd: 32, bend: 32 } }) }] });
const move = poseClip({
  name: 'caelith_move', duration: 2.0, loop: true, forward: 3.0,
  keys: [
    { t: 0, pose: c({ ll: { lift: 18, knee: 10 }, rl: { lift: -10, knee: 15 }, spine: [8, 4, 0] }) },
    { t: 1.0, pose: c({ ll: { lift: -10, knee: 15 }, rl: { lift: 18, knee: 10 }, spine: [8, -4, 0] }) },
  ],
});

interface AttackSpec {
  readonly attack: CaelithAttack;
  /** Windup length (≥ the first Telegraph). */
  readonly windup: number;
  readonly lead: number;
  /** Judgement times from the action start (CAELITH_ACTIONS) and whether each deals damage. */
  readonly at: readonly number[];
  readonly damaging: boolean;
  /** activeEnd + recovery (s from the action start). */
  readonly end: number;
  readonly activeEnd: number;
  readonly windupKeys: KeyPose[];
  /** Strike keys in strike-local time. */
  readonly strikeKeys: KeyPose[];
}

function attack(s: AttackSpec): { clips: PoseClip[]; timing: BossAttackClips } {
  const start = s.at[0]! - s.lead;
  const duration = s.end - start;
  const windup = poseClip({ name: `caelith_${s.attack}_windup`, duration: s.windup, keys: s.windupKeys, events: [{ t: 0, kind: 'anticipation', data: 'telegraph' }] });
  const events = s.damaging ? s.at.map((t) => hit(t - start)) : [vfx(s.lead, 'summon')];
  const strike = poseClip({ name: `caelith_${s.attack}_strike`, duration, keys: s.strikeKeys, events });
  return { clips: [windup, strike], timing: { windup: windup.name, strike: strike.name, strikeStart: start, activeEnd: s.activeEnd } };
}

const SLASH_BACK = c({ ra: { down: -30, fwd: 0, across: -40, bend: 60 }, spine: [4, -30, 0] });
const slashCombo = attack({
  attack: 'slashCombo', windup: 0.5, lead: 0.2, at: [0.5, 0.9, 1.3], damaging: true, activeEnd: 1.5, end: 2.1,
  windupKeys: [{ t: 0, pose: c() }, { t: 0.5, pose: SLASH_BACK }],
  strikeKeys: [
    { t: 0, pose: SLASH_BACK },
    { t: 0.2, pose: c({ ra: { down: 40, fwd: 70, across: 60, bend: 10 }, spine: [10, 30, 0], ll: { lift: 20, knee: 15 } }), ease: 'out' },
    { t: 0.4, pose: c({ ra: { down: 10, fwd: 60, across: 70, bend: 50 }, spine: [8, 35, 0] }) },
    { t: 0.6, pose: c({ ra: { down: 40, fwd: 65, across: -40, bend: 10 }, spine: [10, -30, 0], rl: { lift: 20, knee: 15 } }), ease: 'out' },
    { t: 0.8, pose: c({ ra: { down: -80, fwd: 20, bend: 50 }, spine: [-6, 0, 0] }) },
    { t: 1.0, pose: c({ ra: { down: 60, fwd: 85, bend: 5 }, spine: [25, 0, 0], ll: { lift: 30, knee: 30 } }), ease: 'out' },
    { t: 1.8, pose: c() },
  ],
});

const SHARD_AIM = c({ la: { down: 90, fwd: 88, bend: 12 }, spine: [2, 15, 0], head: [0, -10, 0] });
const starShards = attack({
  attack: 'starShards', windup: 0.6, lead: 0.15, at: [0.6], damaging: true, activeEnd: 0.9, end: 1.4,
  windupKeys: [{ t: 0, pose: c() }, { t: 0.6, pose: SHARD_AIM }],
  strikeKeys: [{ t: 0, pose: SHARD_AIM }, { t: 0.15, pose: c({ la: { down: 90, fwd: 95, bend: 0 }, spine: [6, 20, 0] }), ease: 'out' }, { t: 0.95, pose: c() }],
});

const OVERHEAD = c({ ra: { down: -80, fwd: 15, bend: 30 }, la: { down: -75, fwd: 20, across: 20, bend: 45 }, spine: [-10, 0, 0], head: [-10, 0, 0] });
const SLAM = c({ ra: { down: 70, fwd: 80, bend: 5 }, la: { down: 70, fwd: 75, across: 10, bend: 20 }, spine: [40, 0, 0], ll: { lift: 50, knee: 80 }, rl: { lift: 25, knee: 80 } });
const groundSlam = attack({
  attack: 'groundSlam', windup: 1.0, lead: 0.2, at: [1.0], damaging: true, activeEnd: 1.3, end: 2.0,
  windupKeys: [{ t: 0, pose: c() }, { t: 1.0, pose: OVERHEAD }],
  strikeKeys: [{ t: 0, pose: OVERHEAD }, { t: 0.2, pose: SLAM, ease: 'out' }, { t: 0.6, pose: SLAM }, { t: 1.2, pose: c() }],
});

const LUNGE = c({ ra: { down: 50, fwd: -30, bend: 40 }, spine: [25, 0, 0], ll: { lift: 40, knee: 60 }, rl: { lift: -20, knee: 40 } });
const THRUST = c({ ra: { down: 5, fwd: 90, bend: 0 }, spine: [30, 0, 0], ll: { lift: 55, knee: 40 }, rl: { lift: -35, knee: 20, toe: 20 } });
const dash = attack({
  attack: 'dash', windup: 0.9, lead: 0.15, at: [0.9], damaging: true, activeEnd: 1.3, end: 1.9,
  windupKeys: [{ t: 0, pose: c() }, { t: 0.9, pose: LUNGE }],
  strikeKeys: [{ t: 0, pose: LUNGE }, { t: 0.15, pose: THRUST, ease: 'out' }, { t: 0.45, pose: THRUST }, { t: 1.15, pose: c() }],
});

const SPREAD = c({ la: { down: -20, fwd: 30, bend: 20 }, ra: { down: -20, fwd: 30, bend: 20 }, head: [-15, 0, 0], spine: [-6, 0, 0] });
const PULSE = c({ la: { down: 50, fwd: 60, bend: 10 }, ra: { down: 50, fwd: 60, bend: 10 }, spine: [15, 0, 0] });
const sectorBlast = attack({
  attack: 'sectorBlast', windup: 1.0, lead: 0.2, at: [1.0, 1.4, 1.8, 2.2], damaging: true, activeEnd: 2.4, end: 3.0,
  windupKeys: [{ t: 0, pose: c() }, { t: 1.0, pose: SPREAD }],
  strikeKeys: [
    { t: 0, pose: SPREAD }, { t: 0.2, pose: PULSE, ease: 'out' }, { t: 0.4, pose: SPREAD }, { t: 0.6, pose: PULSE, ease: 'out' },
    { t: 0.8, pose: SPREAD }, { t: 1.0, pose: PULSE, ease: 'out' }, { t: 1.2, pose: SPREAD }, { t: 1.4, pose: PULSE, ease: 'out' }, { t: 2.2, pose: c() },
  ],
});

const INVOKE = c({ la: { down: -80, fwd: 20, bend: 10 }, ra: { down: -80, fwd: 20, bend: 20 }, head: [-25, 0, 0], spine: [-8, 0, 0] });
const summonCrystals = attack({
  attack: 'summonCrystals', windup: 1.0, lead: 0.2, at: [1.0], damaging: false, activeEnd: 1.2, end: 1.7,
  windupKeys: [{ t: 0, pose: c() }, { t: 1.0, pose: INVOKE }],
  strikeKeys: [{ t: 0, pose: INVOKE }, { t: 0.2, pose: c({ la: { down: 20, fwd: 40, bend: 10 }, ra: { down: 20, fwd: 40, bend: 20 }, spine: [10, 0, 0] }), ease: 'out' }, { t: 0.9, pose: c() }],
});

const SKY = c({ ra: { down: -92, fwd: 5, bend: 0 }, la: { down: -60, fwd: 20, bend: 30 }, head: [-30, 0, 0], spine: [-12, 0, 0] });
const starfall = attack({
  attack: 'starfall', windup: 1.2, lead: 0.2, at: [1.2], damaging: true, activeEnd: 1.5, end: 2.1,
  windupKeys: [{ t: 0, pose: c() }, { t: 1.2, pose: SKY }],
  strikeKeys: [{ t: 0, pose: SKY }, { t: 0.2, pose: c({ ra: { down: 20, fwd: 80, bend: 0 }, la: { down: 60, fwd: 30, bend: 30 }, spine: [15, 0, 0] }), ease: 'out' }, { t: 1.1, pose: c() }],
});

const LEAP = c({ ra: { down: -80, fwd: 20, bend: 30 }, la: { down: -70, fwd: 20, bend: 40 }, ll: { lift: 70, knee: 100 }, rl: { lift: 60, knee: 100 }, spine: [10, 0, 0] });
const astralSweep = attack({
  attack: 'astralSweep', windup: 1.2, lead: 0.2, at: [1.2], damaging: true, activeEnd: 1.2, end: 1.2,
  windupKeys: [{ t: 0, pose: c() }, { t: 0.4, pose: c({ ll: { lift: 45, knee: 80 }, rl: { lift: 40, knee: 80 }, spine: [25, 0, 0] }) }, { t: 1.2, pose: LEAP }],
  strikeKeys: [{ t: 0, pose: LEAP }, { t: 0.2, pose: SLAM, ease: 'out' }],
});

const phaseShift = (name: string, big: boolean): PoseClip => poseClip({
  name, duration: 3,
  keys: [
    { t: 0, pose: c() },
    { t: 0.4, pose: c({ spine: [-18, 0, 0], head: [-30, 0, 0], la: { down: -10, fwd: 20, bend: 20 }, ra: { down: -10, fwd: 20, bend: 20 } }), ease: 'out' },
    { t: 1.4, pose: big
      ? c({ ll: { lift: 80, knee: 100 }, rl: { lift: -5, knee: 95, toe: 20 }, spine: [30, 0, 0], head: [20, 0, 0], la: { down: 80, fwd: 20, bend: 20 }, ra: { down: 70, fwd: 60, bend: 40 } })
      : c({ spine: [-20, 0, 0], head: [-35, 0, 0], la: { down: -30, fwd: 20, bend: 10 }, ra: { down: -30, fwd: 20, bend: 10 } }) },
    { t: 2.3, pose: c({ spine: [-10, 0, 0], head: [-20, 0, 0], la: { down: -60, fwd: 20, bend: 10 }, ra: { down: -60, fwd: 20, bend: 10 } }) },
    { t: 3, pose: c() },
  ],
  events: [vfx(0.4, big ? 'phase:final' : 'phase:p2')],
});

const stagger = poseClip({
  name: 'caelith_stagger', duration: 1.6, loop: true,
  keys: [
    { t: 0, pose: c({ ra: { down: 85, fwd: 10, bend: 10 }, spine: [20, 0, 8], head: [20, 10, 0], ll: { lift: 20, knee: 40 } }) },
    { t: 0.8, pose: c({ ra: { down: 85, fwd: 5, bend: 10 }, spine: [22, 0, -6], head: [22, -10, 0], ll: { lift: 22, knee: 45 } }) },
  ],
});
const KNEEL = c({ ll: { lift: 80, knee: 95 }, rl: { lift: -5, knee: 100, toe: 25 }, spine: [25, 0, 0], head: [30, 0, 0], ra: { down: 70, fwd: 70, bend: 70 }, la: { down: 80, fwd: 20, bend: 20 } });
const disabled = poseClip({ name: 'caelith_disabled', duration: 2.0, loop: true, keys: [{ t: 0, pose: KNEEL }, { t: 1.0, pose: c({ ll: { lift: 80, knee: 95 }, rl: { lift: -5, knee: 100, toe: 25 }, spine: [28, 0, 0], head: [34, 0, 0], ra: { down: 70, fwd: 70, bend: 72 }, la: { down: 82, fwd: 20, bend: 20 } }) }] });
const death = poseClip({
  name: 'caelith_death', duration: 2.0,
  keys: [
    { t: 0, pose: c() },
    { t: 0.5, pose: c({ spine: [-15, 0, 5], head: [-30, 0, 0], la: { down: 20, fwd: 10, bend: 20 }, ra: { down: 30, fwd: 10, bend: 20 } }), ease: 'out' },
    { t: 2.0, pose: KNEEL },
  ],
  events: [vfx(0.5, 'death:dissolve')],
});

const ATTACKS = { slashCombo, starShards, groundSlam, dash, sectorBlast, summonCrystals, starfall, astralSweep };

/** Windup / strike names and timeline of each attack. */
export const CAELITH_ATTACK_CLIPS: Readonly<Record<CaelithAttack, BossAttackClips>> = Object.fromEntries(
  Object.entries(ATTACKS).map(([k, v]) => [k, v.timing]),
) as Record<CaelithAttack, BossAttackClips>;

export const CAELITH_CLIP_LIST: readonly PoseClip[] = [
  idle, move, ...Object.values(ATTACKS).flatMap((a) => a.clips),
  phaseShift('caelith_phaseShift_p2', false), phaseShift('caelith_phaseShift_final', true), stagger, disabled, death,
];
