import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  climbDirection, HERO_COMMON_CLIPS, selectAnimState, selectBossAnim, selectEnemyAnim, selectNpcAnim, type HeroAnimInput,
} from '../../../src/anim/animState';
import { AnimClock } from '../../../src/anim/animClock';
import { CAELITH_ATTACK_CLIPS, ENEMY_CLIP_SETS } from '../../../src/anim/clips';
import { heroRigSpec } from '../../../src/anim/heroes';
import { BREATH_PERIOD, BREATH_PERIOD_WINDED, ProceduralLayers, type ProceduralFrame } from '../../../src/anim/procedural';
import { buildRig } from '../../../src/anim/rigKit';
import { SIM_DT } from '../../../src/core/loop';
import { MOVE_MODES } from '../../../src/player/core/types';

// Task 19.4: the pure state selection (heroes, enemies, Caelith, NPCs), the procedural layers and the scaled clock.

const hero = (over: Partial<HeroAnimInput>): HeroAnimInput => ({
  mode: 'grounded', modeTime: 0, speed: 0, climb: { x: 0, y: 0, speed: 0 }, attack: null, hurtTime: null, ...over,
});
const clipOf = (req: { clip?: string } | { blend?: string } | null): string | null =>
  req === null ? null : 'clip' in req ? req.clip ?? null : 'blend' in req ? `blend:${req.blend}` : null;

describe('selectAnimState (heroes)', () => {
  it('maps every controller mode to a shared clip or blend', () => {
    const names = new Set<string>([...HERO_COMMON_CLIPS, 'blend:locomotion', 'blend:climb']);
    for (const mode of MOVE_MODES) {
      const s = selectAnimState(hero({ mode }));
      for (const layer of [s.base, s.action, s.override]) {
        const n = clipOf(layer);
        if (n !== null) expect(names.has(n), `${mode}: ${n}`).toBe(true);
      }
    }
  });

  it('uses the design mapping: slide → tilted fall, landing → land, climbAttach → climb at rest, locked → idle', () => {
    expect(clipOf(selectAnimState(hero({ mode: 'grounded', speed: 5 })).base)).toBe('blend:locomotion');
    const slide = selectAnimState(hero({ mode: 'slide' }));
    expect([clipOf(slide.override), slide.lean]).toEqual(['fall', 'slope']);
    expect(clipOf(selectAnimState(hero({ mode: 'landing' })).override)).toBe('land');
    expect(selectAnimState(hero({ mode: 'climbAttach' })).override).toEqual({ blend: 'climb', x: 0, y: 0, speed: 0 });
    const locked = selectAnimState(hero({ mode: 'locked' }));
    expect([clipOf(locked.base), locked.action, locked.override]).toEqual(['idle', null, null]);
    expect(selectAnimState(hero({ mode: 'glide' })).weaponOnBack).toBe(true);
    expect(selectAnimState(hero({ mode: 'climb' })).weaponOnBack).toBe(true);
    expect(selectAnimState(hero({ mode: 'grounded' })).weaponOnBack).toBe(false);
  });

  it('reads the combat action, not input: an attack plays at its sim time, a refused Dodge never plays', () => {
    const s = selectAnimState(hero({ attack: { clip: 'kairen_n2', time: 0.21 } }));
    expect(s.action).toEqual({ clip: 'kairen_n2', time: 0.21 });
    // A Dodge refused for Stamina leaves the controller grounded: no dodge clip anywhere.
    const refused = selectAnimState(hero({ mode: 'grounded', speed: 3 }));
    expect([refused.base, refused.action, refused.override].map(clipOf)).not.toContain('dodge');
    expect(clipOf(selectAnimState(hero({ mode: 'dodge', modeTime: 0.1 })).override)).toBe('dodge');
    expect(selectAnimState(hero({ hurtTime: 0.1 })).action).toEqual({ clip: 'hurt', time: 0.1 });
    expect(selectAnimState(hero({ hurtTime: 0.5 })).action).toBeNull();
  });

  it('derives the climb direction from the velocity in the facing frame', () => {
    const up = climbDirection({ x: 0, y: 2, z: 0 }, 0);
    expect(up.x).toBeCloseTo(0, 9);
    expect(up.y).toBe(1);
    // Facing +Z, the model's right is −X.
    const right = climbDirection({ x: -2, y: 0, z: 0 }, 0);
    expect(right.x).toBeCloseTo(1, 9);
    expect(right.speed).toBeCloseTo(2, 9);
  });
});

describe('selectEnemyAnim / selectBossAnim / selectNpcAnim', () => {
  const set = ENEMY_CLIP_SETS.bramblekin.set;
  it('picks idle / move / stagger / defeat by AI state and the windup until firstHit − lead', () => {
    const base = { stateTime: 0, speed: 0, attack: null, flinch: null };
    expect(clipOf(selectEnemyAnim({ ...base, state: 'idle' }, set).base)).toBe('bramblekin_idle');
    expect(clipOf(selectEnemyAnim({ ...base, state: 'alert' }, set).base)).toBe('bramblekin_idle');
    expect(clipOf(selectEnemyAnim({ ...base, state: 'chase', speed: 3 }, set).base)).toBe('bramblekin_move');
    expect(clipOf(selectEnemyAnim({ ...base, state: 'stagger' }, set).override)).toBe('bramblekin_stagger');
    expect(clipOf(selectEnemyAnim({ ...base, state: 'dead', stateTime: 0.2 }, set).override)).toBe('bramblekin_defeat');
    const lead = set.attacks.bramblekin_claw!.lead;
    const at = (t: number) => selectEnemyAnim({ ...base, state: 'attack', attack: { clip: 'bramblekin_claw', time: t, firstHit: 0.4 } }, set).action;
    expect(at(0.4 - lead - 0.01)).toEqual({ clip: 'bramblekin_claw_windup', time: 0.4 - lead - 0.01 });
    const strike = at(0.4) as { clip: string; time: number };
    expect(strike.clip).toBe('bramblekin_claw');
    expect(strike.time).toBeCloseTo(lead, 9);
    expect(selectEnemyAnim({ ...base, state: 'idle', flinch: 0.05 }, set).action).toEqual({ clip: 'bramblekin_hurt', time: 0.05 });
  });

  it('plays Caelith from its snapshot: windup, strike, the strike through recovery, phase shifts, death', () => {
    const clips = (a: keyof typeof CAELITH_ATTACK_CLIPS) => CAELITH_ATTACK_CLIPS[a];
    const base = { phase: 1, attack: null, attackTime: 0, stateTime: 0, lastAttack: null, speed: 0 };
    const t = CAELITH_ATTACK_CLIPS.groundSlam;
    expect(selectBossAnim({ ...base, state: 'telegraph', attack: 'groundSlam', attackTime: 0.1 }, clips).action).toEqual({ clip: t.windup, time: 0.1 });
    const strike = selectBossAnim({ ...base, state: 'attack', attack: 'groundSlam', attackTime: 1.0 }, clips).action as { clip: string; time: number };
    expect(strike.clip).toBe(t.strike);
    expect(strike.time).toBeCloseTo(1.0 - t.strikeStart, 9);
    const rec = selectBossAnim({ ...base, state: 'recovery', lastAttack: 'groundSlam', stateTime: 0.2 }, clips).action as { time: number };
    expect(rec.time).toBeCloseTo(t.activeEnd - t.strikeStart + 0.2, 9);
    expect(clipOf(selectBossAnim({ ...base, state: 'transition', phase: 2 }, clips).override)).toBe('caelith_phaseShift_p2');
    expect(clipOf(selectBossAnim({ ...base, state: 'transition', phase: 3 }, clips).override)).toBe('caelith_phaseShift_final');
    expect(clipOf(selectBossAnim({ ...base, state: 'disabled' }, clips).override)).toBe('caelith_disabled');
    expect(clipOf(selectBossAnim({ ...base, state: 'dead' }, clips).override)).toBe('caelith_death');
  });

  it('plays the NPC animation, idle while talking, idle for a walker held still', () => {
    expect(clipOf(selectNpcAnim('hammer', false, 0).base)).toBe('npc_work_hammer');
    expect(clipOf(selectNpcAnim('hammer', true, 0).base)).toBe('npc_idle');
    expect(selectNpcAnim('walk', false, 1.6).base).toEqual({ clip: 'npc_walk', speed: 1.6 });
    expect(clipOf(selectNpcAnim('walk', false, 0).base)).toBe('npc_idle');
  });
});

describe('procedural layers', () => {
  const frame = (over: Partial<ProceduralFrame> = {}): ProceduralFrame => ({
    grounded: true, speed: 0, yawRate: 0, lean: 'turn', sprinting: false, landing: null, lookAt: null, ...over,
  });
  const setup = () => {
    const rig = buildRig(heroRigSpec('kairen'), { faceAtlas: false });
    const layers = new ProceduralLayers(rig.root, rig.bones, { height: 1.72, feet: ['leftFoot', 'rightFoot'] });
    return { rig, layers };
  };

  it('drops the pelvis so the lower foot stays on the ground as the knees bend', () => {
    const { rig, layers } = setup();
    const hipsY = rig.bones.get('hips')!.position.y;
    layers.apply(1 / 60, frame());
    expect(layers.drop).toBeCloseTo(0, 6);
    for (const side of ['left', 'right']) {
      rig.bones.get(`${side}UpperLeg`)!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.6);
      rig.bones.get(`${side}LowerLeg`)!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2);
    }
    layers.apply(1 / 60, frame());
    expect(layers.drop).toBeGreaterThan(0.05);
    expect(rig.bones.get('hips')!.position.y).toBeCloseTo(hipsY - layers.drop, 9);
    layers.apply(1 / 60, frame({ grounded: false }));
    expect(layers.drop).toBe(0);
  });

  it('breathes on 3.5 s, 1.5 s for 3 s after a sprint; looks at a target in range and returns over 0.3 s', () => {
    const { rig, layers } = setup();
    expect(layers.breathingPeriod).toBe(BREATH_PERIOD);
    layers.apply(0.1, frame({ sprinting: true }));
    layers.apply(0.1, frame({ sprinting: false }));
    expect(layers.breathingPeriod).toBe(BREATH_PERIOD_WINDED);
    for (let i = 0; i < 31; i++) layers.apply(0.1, frame());
    expect(layers.breathingPeriod).toBe(BREATH_PERIOD);
    rig.root.updateMatrixWorld(true);
    const target = { x: 2, y: 1.6, z: 4 };
    for (let i = 0; i < 30; i++) layers.apply(1 / 60, frame({ lookAt: target }));
    expect(layers.lookAmount).toBe(1);
    // Behind the character (yaw > 70°): back to the front within 0.3 s.
    for (let i = 0; i < 18; i++) layers.apply(1 / 60, frame({ lookAt: { x: 0, y: 1.6, z: -3 } }));
    expect(layers.lookAmount).toBeCloseTo(0, 6);
  });

  it('squashes a landing by the fall speed and springs back within 0.2 s', () => {
    const { rig, layers } = setup();
    layers.apply(1 / 60, frame({ landing: 12 }));
    expect(rig.root.scale.y).toBeCloseTo(0.92, 6);
    expect(rig.root.scale.x).toBeCloseTo(1.04, 6);
    for (let i = 0; i < 12; i++) layers.apply(1 / 60, frame());
    expect(Math.abs(rig.root.scale.y - 1)).toBeLessThan(0.08 * 0.05);
  });
});

describe('AnimClock (scaled time)', () => {
  it('counts ticks plus the alpha change: nothing while no tick runs (Hit_Stop, menu)', () => {
    const clock = new AnimClock();
    expect(clock.frame(0.5)).toBeCloseTo(0.5 * SIM_DT, 12);
    clock.tick();
    clock.tick();
    expect(clock.frame(0.25)).toBeCloseTo(1.75 * SIM_DT, 12);
    expect(clock.frame(0.25)).toBe(0);
  });
});
