// Render side of the camera: copies a CameraRig to a three.js PerspectiveCamera (design "Camera":
// the rig is copied to the render camera each frame). The renderer updates the camera's world matrix
// itself when it has no parent.

import type { PerspectiveCamera } from 'three';
import type { CameraRig } from './cameraCore';

/** Places `camera` at the rig pose: position, look-at point, roll about the view axis and vertical fov. */
export function applyCameraRig(camera: PerspectiveCamera, rig: Readonly<CameraRig>): void {
  camera.position.set(rig.position.x, rig.position.y, rig.position.z);
  camera.up.set(0, 1, 0);
  camera.lookAt(rig.lookAt.x, rig.lookAt.y, rig.lookAt.z);
  if (rig.roll !== 0) camera.rotateZ(rig.roll);
  if (camera.fov !== rig.fov) {
    camera.fov = rig.fov;
    camera.updateProjectionMatrix();
  }
}
