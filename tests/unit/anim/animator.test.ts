import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Animator } from '../../../src/anim/animator';
import {
  bindClip, ease, eulerToQuaternion, eventsBetween, loadClip, playbackRate, sampleJoint, type ClipEvent, type PoseClip,
} from '../../../src/anim/clip';
import { BLEND_TIMES } from '../../../src/anim/blendTimes';
import { poseClip } from '../../../src/anim/clips/author';

// Task 19.4: PoseClip load / sampling / events and the Animator's three layers, crossfades and snapshots.

const deg = (d: number): number => (d * Math.PI) / 180;
const qy = (d: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg(d));
/** Angle (deg) between two rotations, precise for small angles (float32 keys). */
const angleBetween = (a: THREE.Quaternion, b: THREE.Quaternion): number => {
  const d = a.clone().invert().multiply(b);
  return (2 * Math.atan2(Math.hypot(d.x, d.y, d.z), Math.abs(d.w)) * 180) / Math.PI;
};

const turn: PoseClip = {
  name: 'turn', duration: 1, loop: false,
  tracks: { a: [{ t: 0, rot: [0, 0, 0] }, { t: 1, rot: [0, 90, 0], ease: 'linear' }] },
  events: [{ t: 0.5, kind: 'hit' }],
};

function rig(names: readonly string[]): Map<string, THREE.Object3D> {
  return new Map(names.map((n) => {
    const o = new THREE.Object3D();
    o.name = n;
    return [n, o];
  }));
}

describe('PoseClip load and sampling', () => {
  it('converts Euler degrees (XYZ) to quaternions once and binds joint names to indices', () => {
    const l = loadClip(turn);
    expect(loadClip(turn)).toBe(l);
    expect(l.tracks[0]!.times).toBeInstanceOf(Float32Array);
    const q = new THREE.Quaternion().fromArray(l.tracks[0]!.quats, 4);
    expect(angleBetween(q, qy(90))).toBeLessThan(1e-3);
    const xyz = eulerToQuaternion([30, 40, 50]);
    expect(angleBetween(xyz, new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(30), deg(40), deg(50), 'XYZ')))).toBeLessThan(1e-6);
    const bound = bindClip(turn, new Map([['a', 3]]), 'test');
    expect(Array.from(bound.joints)).toEqual([3]);
  });

  it('reports a joint the rig lacks as a load error (bindClip and the Animator)', () => {
    expect(() => bindClip(turn, new Map([['b', 0]]), 'rigX')).toThrow(/joint 'a' is not a joint of rig rigX/);
    expect(() => new Animator(rig(['b']), [turn], { name: 'rigX' })).toThrow(/joint 'a'/);
  });

  it('eases each segment by its arrival key and slerps', () => {
    expect([ease('linear', 0.5), ease('inOut', 0.5), ease('out', 0.5)]).toEqual([0.5, 0.5, 0.75]);
    expect(ease('inOut', 0.25)).toBeCloseTo(3 * 0.0625 - 2 * 0.015625, 9);
    expect(angleBetween(sampleJoint(turn, 'a', 0.5)!, qy(45))).toBeLessThan(0.01);
    const eased = poseClip({ name: 'e', duration: 1, keys: [{ t: 0, pose: { a: [0, 0, 0] } }, { t: 1, pose: { a: [0, 90, 0] }, ease: 'out' }] });
    expect(angleBetween(sampleJoint(eased, 'a', 0.5)!, qy(67.5))).toBeLessThan(0.01);
    // Past the end a non-loop clip holds its last key.
    expect(angleBetween(sampleJoint(turn, 'a', 3)!, qy(90))).toBeLessThan(1e-3);
  });

  it('wraps a loop from its last key back to its first', () => {
    const spin: PoseClip = {
      name: 'spin', duration: 2, loop: true,
      tracks: { a: [{ t: 0, rot: [0, 0, 0], ease: 'linear' }, { t: 1, rot: [0, 90, 0], ease: 'linear' }] },
      events: [{ t: 0, kind: 'footstep' }, { t: 1, kind: 'footstep' }],
    };
    expect(angleBetween(sampleJoint(spin, 'a', 1.5)!, qy(45))).toBeLessThan(0.01);
    expect(angleBetween(sampleJoint(spin, 'a', 2.5)!, qy(45))).toBeLessThan(0.01);
    const out: ClipEvent[] = [];
    eventsBetween(spin, 1.9, 2.1, false, out);
    expect(out.map((e) => e.t)).toEqual([0]); // the loop boundary fires the t = 0 footstep once
    out.length = 0;
    eventsBetween(spin, 0.5, 4.5, false, out);
    expect(out).toHaveLength(4);
  });

  it('matches playback to rootMotion.forward (rate = speed × duration / forward)', () => {
    const walk: PoseClip = { name: 'w', duration: 0.9, loop: true, tracks: {}, rootMotion: { forward: 2 }, events: [] };
    expect(playbackRate(walk, 2.5)).toBeCloseTo(2.5 * 0.9 / 2, 9);
    expect(playbackRate(walk, 0)).toBe(0);
    expect(playbackRate(turn, 5)).toBe(1);
  });
});

describe('Animator layers', () => {
  const baseClip = poseClip({ name: 'base', duration: 1, loop: true, keys: [{ t: 0, pose: { a: [0, 10, 0], b: [0, 20, 0] } }] });
  const act = poseClip({ name: 'act', duration: 1, keys: [{ t: 0, pose: { a: [0, 80, 0] } }], events: [{ t: 0.2, kind: 'hit' }] });
  const act2 = poseClip({ name: 'act2', duration: 1, keys: [{ t: 0, pose: { a: [0, -60, 0] } }] });
  const full = poseClip({ name: 'full', duration: 1, loop: true, keys: [{ t: 0, pose: { a: [0, 0, 30], b: [0, 0, 30] } }] });

  it('lets an upper layer overwrite only the joints its clip has tracks for', () => {
    const joints = rig(['a', 'b']);
    const anim = new Animator(joints, [baseClip, act, full], { name: 't' });
    anim.update(0, { base: { clip: 'base' }, action: { clip: 'act', time: 0 }, override: null });
    // First frame: no blend from anything, the layers snap.
    expect(angleBetween(joints.get('a')!.quaternion, qy(80))).toBeLessThan(0.01);
    expect(angleBetween(joints.get('b')!.quaternion, qy(20))).toBeLessThan(0.01);
  });

  it('crossfades a layer entry over its BLEND_TIMES time and snapshots a mid-blend transition (no pop)', () => {
    const joints = rig(['a', 'b']);
    const anim = new Animator(joints, [baseClip, act, act2, full], { name: 't' });
    const a = joints.get('a')!.quaternion;
    anim.update(1 / 60, { base: { clip: 'base' }, action: null, override: null });
    anim.update(0, { base: { clip: 'base' }, action: { clip: 'act', time: 0 }, override: null });
    expect(angleBetween(a, qy(10))).toBeLessThan(0.01); // the blend starts at the pose below
    const half = BLEND_TIMES.default / 2;
    anim.update(half, { base: { clip: 'base' }, action: { clip: 'act', time: half }, override: null });
    const mid = a.clone();
    expect(angleBetween(mid, qy(10))).toBeGreaterThan(20);
    expect(angleBetween(mid, qy(80))).toBeGreaterThan(20);
    expect(anim.fading('action')).toBe(true);
    // A new clip mid-blend starts from the current pose.
    anim.update(0, { base: { clip: 'base' }, action: { clip: 'act2', time: 0 }, override: null });
    expect(angleBetween(a, mid)).toBeLessThan(0.01);
    for (let i = 0; i < 20; i++) anim.update(1 / 60, { base: { clip: 'base' }, action: { clip: 'act2', time: 0 }, override: null });
    expect(angleBetween(a, qy(-60))).toBeLessThan(0.01);
    expect(anim.fading('action')).toBe(false);
    // Leaving the layer fades back to the base.
    for (let i = 0; i < 20; i++) anim.update(1 / 60, { base: { clip: 'base' }, action: null, override: null });
    expect(angleBetween(a, qy(10))).toBeLessThan(0.01);
    expect(anim.current('action')).toBeNull();
  });

  it('plays driven clips at the time given, fires their events once, and freezes with dt 0 (Hit_Stop)', () => {
    const joints = rig(['a', 'b']);
    const anim = new Animator(joints, [baseClip, act], { name: 't' });
    let hits = 0;
    for (let i = 0; i <= 30; i++) {
      const ev = anim.update(1 / 60, { base: { clip: 'base' }, action: { clip: 'act', time: i / 60 }, override: null });
      hits += ev.filter((e) => e.event.kind === 'hit').length;
    }
    expect(hits).toBe(1);
    expect(anim.time('action')).toBeCloseTo(0.5, 9);
    const before = joints.get('a')!.quaternion.clone();
    anim.update(0, { base: { clip: 'base' }, action: { clip: 'act', time: 0.5 }, override: null });
    expect(joints.get('a')!.quaternion.equals(before)).toBe(true);
  });

  it('blends 1D locomotion by speed on one shared phase and speed-matches it', () => {
    const idle = poseClip({ name: 'idle', duration: 2, loop: true, keys: [{ t: 0, pose: { a: [0, 0, 0] } }] });
    const walk = poseClip({ name: 'walk', duration: 1, loop: true, forward: 2, keys: [{ t: 0, pose: { a: [0, 40, 0] } }, { t: 0.5, pose: { a: [0, -40, 0] } }], events: [{ t: 0, kind: 'footstep' }, { t: 0.5, kind: 'footstep' }] });
    const run = poseClip({ name: 'run', duration: 1, loop: true, forward: 4, keys: [{ t: 0, pose: { a: [0, 80, 0] } }, { t: 0.5, pose: { a: [0, -80, 0] } }] });
    const joints = rig(['a']);
    const anim = new Animator(joints, [idle, walk, run], {
      name: 't', blends: { loco: { kind: '1d', points: [{ clip: 'idle', at: 0 }, { clip: 'walk', at: 2 }, { clip: 'run', at: 4 }] } },
    });
    anim.update(0, { base: { blend: 'loco', x: 3 }, action: null, override: null });
    // Halfway between walk (40°) and run (80°) at phase 0.
    expect(angleBetween(joints.get('a')!.quaternion, qy(60))).toBeLessThan(0.5);
    // At 2 m/s the walk cycle (2 m per cycle) takes 1 s: two footsteps per second.
    let steps = 0;
    for (let i = 0; i < 60; i++) steps += anim.update(1 / 60, { base: { blend: 'loco', x: 2 }, action: null, override: null }).filter((e) => e.event.kind === 'footstep').length;
    expect(steps).toBe(2);
  });

  it('keeps the full-body override on top of the action layer', () => {
    const joints = rig(['a', 'b']);
    const anim = new Animator(joints, [baseClip, act, full], { name: 't' });
    anim.update(0, { base: { clip: 'base' }, action: { clip: 'act', time: 0 }, override: { clip: 'full' } });
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, deg(30)));
    expect(angleBetween(joints.get('a')!.quaternion, expected)).toBeLessThan(0.01);
    expect(anim.current('override')).toBe('full');
  });
});
