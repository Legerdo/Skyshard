import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  BLINK_MAX_SECONDS, BLINK_MIN_SECONDS, BLINK_SECONDS, drawFaceAtlas, FaceAnimator, faceAtlasTexture, MOUTH_STEP_SECONDS,
} from '../../../src/anim/face';
import { heroRigSpec } from '../../../src/anim/heroes';
import { buildRig } from '../../../src/anim/rigKit';
import { FACE_ATLAS_SIZE, FACE_CELL_MARGIN, FACE_CELL_SIZE } from '../../../src/anim/rigMaterial';
import { SPRING_HZ, SpringChain, SpringSystem, TELEPORT_DISTANCE } from '../../../src/anim/spring';

// Task 19.1: the canvas face atlas, blink / talk timing and the spring chains, in Node.

const FACE = { irisTop: 0x102030, irisBottom: 0x60c0e0, eyeShape: 'round' } as const;

describe('face atlas', () => {
  it('draws 3 × 3 cells clipped inside 8 px margins of a 768 px atlas', () => {
    const clips: number[][] = [];
    let pendingRect: number[] | null = null;
    const ctx = new Proxy({}, {
      get(_t, key) {
        if (key === 'rect') return (...a: number[]) => { pendingRect = a; };
        if (key === 'clip') return () => { if (pendingRect !== null) clips.push(pendingRect); };
        if (key === 'beginPath') return () => { pendingRect = null; };
        if (key === 'createLinearGradient') return () => ({ addColorStop: () => undefined });
        return () => undefined;
      },
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    drawFaceAtlas(ctx, FACE);
    expect(FACE_ATLAS_SIZE).toBe(768);
    expect(FACE_CELL_SIZE * 3).toBe(FACE_ATLAS_SIZE);
    const inner = FACE_CELL_SIZE - 2 * FACE_CELL_MARGIN;
    const expected: number[][] = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) expected.push([col * 256 + 8, row * 256 + 8, inner, inner]);
    }
    expect(clips.filter((c) => c[2] === inner)).toEqual(expected);
  });

  it('skips the atlas when no canvas can be made (Node): the rig keeps its skin colour', () => {
    expect(faceAtlasTexture(FACE, () => null)).toBeNull();
    const rig = buildRig(heroRigSpec('kairen'), { canvas: () => null });
    expect(rig.material.userData.rig.faceMap.value.image.width).toBe(1);
    rig.dispose();
  });
});

describe('FaceAnimator', () => {
  it('blinks every 3–5 s: half → closed → half over 0.15 s, then open', () => {
    const cells: [number, number][] = [];
    const face = new FaceAnimator('test', (eye, mouth) => cells.push([eye, mouth]));
    const dt = 1 / 240;
    let t = 0;
    const starts: number[] = [];
    let prevEye = 0;
    const trace: number[] = [];
    while (t < 40) {
      face.update(dt);
      t += dt;
      if (face.eye !== 0 && prevEye === 0) starts.push(t);
      if (starts.length === 1 && t - starts[0]! <= BLINK_SECONDS + 0.02) trace.push(face.eye);
      prevEye = face.eye;
    }
    expect(starts.length).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i]! - starts[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(BLINK_MIN_SECONDS - 0.01);
      expect(gap).toBeLessThanOrEqual(BLINK_MAX_SECONDS + BLINK_SECONDS + 0.02);
    }
    const phases = trace.filter((e, i) => i === 0 || e !== trace[i - 1]);
    expect(phases).toEqual([1, 2, 1, 0]);
    expect(cells.every(([, mouth]) => mouth === 0)).toBe(true);
  });

  it('changes the mouth cell every 0.1 s while talking and closes it after', () => {
    const face = new FaceAnimator(7, () => undefined);
    face.talking = true;
    const mouths: number[] = [];
    for (let i = 0; i < 10; i++) {
      face.update(MOUTH_STEP_SECONDS);
      mouths.push(face.mouth);
    }
    for (let i = 1; i < mouths.length; i++) expect(mouths[i]).not.toBe(mouths[i - 1]);
    expect(mouths.some((m) => m === 2)).toBe(true);
    face.talking = false;
    face.update(0.01);
    expect(face.mouth).toBe(0);
  });
});

describe('spring chains', () => {
  /** A 5-joint chain hanging from `anchor` (at 2 m) along −Y, 0.1 m segments. */
  function chain(stiffness = 0) {
    const anchor = new THREE.Bone();
    anchor.position.set(0, 2, 0);
    const bones: THREE.Bone[] = [];
    let parent: THREE.Object3D = anchor;
    for (let i = 0; i < 5; i++) {
      const b = new THREE.Bone();
      b.position.set(0, i === 0 ? 0 : -0.1, 0);
      parent.add(b);
      bones.push(b);
      parent = b;
    }
    anchor.updateMatrixWorld(true);
    const c = new SpringChain(bones, new THREE.Vector3(0, -0.1, 0), { stiffness, drag: 3 });
    return { anchor, bones, c };
  }

  it('starts at rest, keeps segment lengths and stays outside collision spheres', () => {
    const { anchor, bones, c } = chain();
    const collider = new THREE.Bone();
    collider.position.set(0.05, 1.75, 0);
    collider.updateMatrixWorld(true);
    const system = new SpringSystem([c], [{ bone: collider, offset: new THREE.Vector3(), radius: 0.12 }]);
    system.reset();
    expect(c.points.map((p) => p.y)).toEqual([2, 1.9, 1.8, 1.7, 1.6, 1.5].map((y) => expect.closeTo(y, 9)));
    for (let i = 0; i < SPRING_HZ * 2; i++) system.update(1 / SPRING_HZ, { x: 0, y: 0, z: 0 });
    // The collision push comes after the length passes, so a pressed segment may stretch a little.
    for (let i = 1; i < c.points.length; i++) expect(Math.abs(c.points[i]!.distanceTo(c.points[i - 1]!) - 0.1)).toBeLessThan(0.002);
    const centre = new THREE.Vector3(0.05, 1.75, 0);
    for (let i = 1; i < c.points.length; i++) expect(c.points[i]!.distanceTo(centre)).toBeGreaterThanOrEqual(0.12 - 1e-6);
    // The bones follow the points: the chain tip bone points at the tip.
    anchor.updateMatrixWorld(true);
    const last = bones[4]!.getWorldPosition(new THREE.Vector3());
    expect(last.distanceTo(c.points[4]!)).toBeLessThan(0.005);
  });

  it('streams downwind', () => {
    const { c } = chain();
    const system = new SpringSystem([c], []);
    system.reset();
    for (let i = 0; i < SPRING_HZ * 3; i++) system.update(1 / SPRING_HZ, { x: 6, y: 0, z: 0 });
    expect(c.points[5]!.x).toBeGreaterThan(0.1);
  });

  it('resets to rest on a teleport instead of whipping', () => {
    const { anchor, c } = chain();
    const system = new SpringSystem([c], []);
    system.reset();
    for (let i = 0; i < 30; i++) system.update(1 / SPRING_HZ, { x: 4, y: 0, z: 0 });
    anchor.position.set(TELEPORT_DISTANCE * 4, 2, 0);
    anchor.updateMatrixWorld(true);
    system.update(1 / SPRING_HZ);
    expect(c.points.map((p) => [p.x, p.y])).toEqual(
      [2, 1.9, 1.8, 1.7, 1.6, 1.5].map((y) => [expect.closeTo(TELEPORT_DISTANCE * 4, 9), expect.closeTo(y, 9)]),
    );
  });

  it("drives a hero's scarf joints", () => {
    const rig = buildRig(heroRigSpec('kairen'), { faceAtlas: false });
    rig.root.updateMatrixWorld(true);
    rig.springs.reset();
    const scarf = rig.bones.get('scarf_5')!;
    const before = scarf.getWorldPosition(new THREE.Vector3());
    for (let i = 0; i < 90; i++) {
      rig.root.position.z += 0.1; // running forward at 6 m/s
      rig.root.updateMatrixWorld(true);
      rig.springs.update(1 / 60, { x: 0, y: 0, z: 0 });
    }
    rig.root.updateMatrixWorld(true);
    const after = scarf.getWorldPosition(new THREE.Vector3()).sub(rig.root.position);
    expect(rig.bones.get('scarf_2')!.quaternion.equals(new THREE.Quaternion())).toBe(false);
    expect(after.z).toBeLessThan(before.z + 0.05); // trails behind
    rig.dispose();
  });
});
