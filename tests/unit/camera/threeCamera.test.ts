import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CameraCore, type CameraRig } from '../../../src/camera/cameraCore';
import { CAMERA_FOV_DEG, SHOULDER_HEIGHT } from '../../../src/camera/constants';
import { applyCameraRig } from '../../../src/camera/threeCamera';

const worldUp = (c: PerspectiveCamera): Vector3 => new Vector3(0, 1, 0).applyQuaternion(c.quaternion);
const viewDir = (c: PerspectiveCamera): Vector3 => c.getWorldDirection(new Vector3());

describe('applyCameraRig', () => {
  it('aims the camera at the rig target with the rig fov, the character left of centre', () => {
    const rig = new CameraCore().update({ realDt: 1 / 60, characterPos: { x: 2, y: 0, z: 3 }, characterYaw: 0.7 });
    const camera = new PerspectiveCamera(45, 16 / 9, 0.1, 500);
    applyCameraRig(camera, rig);
    camera.updateMatrixWorld();
    expect(camera.fov).toBe(CAMERA_FOV_DEG);
    expect(camera.projectionMatrix.elements).toEqual(new PerspectiveCamera(CAMERA_FOV_DEG, 16 / 9, 0.1, 500).projectionMatrix.elements);
    expect(camera.position.toArray()).toEqual([rig.position.x, rig.position.y, rig.position.z]);
    const aim = new Vector3(rig.lookAt.x - rig.position.x, rig.lookAt.y - rig.position.y, rig.lookAt.z - rig.position.z).normalize();
    expect(viewDir(camera).distanceTo(aim)).toBeLessThan(1e-9);
    // Over the right shoulder: the character's shoulder point sits left of centre on the horizon line.
    const shoulder = new Vector3(2, SHOULDER_HEIGHT, 3).project(camera);
    expect(shoulder.x).toBeLessThan(-0.01);
    expect(Math.abs(shoulder.y)).toBeLessThan(1e-9);
  });

  it('rolls the camera about its view axis', () => {
    const rig: CameraRig = { position: { x: 0, y: 2, z: -5 }, lookAt: { x: 0, y: 1.5, z: 0 }, fov: 60, roll: 0.1 };
    const level = new PerspectiveCamera(60, 1, 0.1, 100);
    const rolled = new PerspectiveCamera(60, 1, 0.1, 100);
    applyCameraRig(level, { ...rig, roll: 0 });
    applyCameraRig(rolled, rig);
    expect(worldUp(level).angleTo(worldUp(rolled))).toBeCloseTo(0.1, 9);
    expect(viewDir(level).distanceTo(viewDir(rolled))).toBeLessThan(1e-9);
  });
});
