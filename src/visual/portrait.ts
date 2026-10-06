/*
 * Party portraits (tasks 19.2 / 19.7): each hero's current visual rendered once into a 64 × 64 offscreen render
 * target (head and shoulders, a three-quarter view, transparent background) and handed to the HUD party slot as a PNG
 * data URL. Re-run after EntityView.swapVisual so a swapped-in model shows in the HUD (Req 43.8).
 */
import * as THREE from 'three';
import type { VisualInstance } from './types';

export const PORTRAIT_SIZE = 64;

/** linear 0–255 → sRGB 0–255 (render targets hold linear colour; tone mapping and encoding apply to the canvas only). */
const SRGB_LUT = (() => {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    lut[i] = Math.round(Math.min(1, Math.max(0, s)) * 255);
  }
  return lut;
})();

/** The portrait camera for a model of `height` whose head is at `head` (model space). */
export function portraitCamera(height: number, head: THREE.Vector3): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 50);
  const target = head.clone().add(new THREE.Vector3(0, -0.02 * height, 0));
  const distance = 0.2 * height + 0.35;
  const yaw = THREE.MathUtils.degToRad(24);
  camera.position.set(target.x + Math.sin(yaw) * distance, target.y + 0.03 * height, target.z + Math.cos(yaw) * distance);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * Renders `instance` into a `size`² target and returns a PNG data URL (null without a DOM canvas). The instance is
 * borrowed: moved into a private scene at the origin for the draw and put back where it was.
 */
export function renderPortrait(renderer: THREE.WebGLRenderer, instance: VisualInstance, size = PORTRAIT_SIZE): string | null {
  if (typeof document === 'undefined') return null;
  const root = instance.root;
  const parent = root.parent;
  const saved = { position: root.position.clone(), quaternion: root.quaternion.clone(), scale: root.scale.clone(), visible: root.visible };
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a4058, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(1.5, 2.5, 3);
  scene.add(key);
  scene.add(root);
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  root.visible = true;
  root.updateMatrixWorld(true);
  const headBone = instance.humanoid?.bones.get('head') ?? instance.joints.get('head') ?? null;
  const head = headBone === null
    ? new THREE.Vector3(0, instance.height * 0.88, 0)
    : headBone.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.05 * instance.height, 0));
  const camera = portraitCamera(instance.height, head);
  const target = new THREE.WebGLRenderTarget(size, size, { samples: 4, type: THREE.UnsignedByteType });
  const previousTarget = renderer.getRenderTarget();
  const previousColor = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();
  const pixels = new Uint8Array(size * size * 4);
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousColor, previousAlpha);
    target.dispose();
    scene.remove(root);
    if (parent !== null) parent.add(root);
    root.position.copy(saved.position);
    root.quaternion.copy(saved.quaternion);
    root.scale.copy(saved.scale);
    root.visible = saved.visible;
    root.updateMatrixWorld(true);
    key.dispose();
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (g === null) return null;
  const image = g.createImageData(size, size);
  // GL rows run bottom-up; alpha stays linear, colour is encoded to sRGB.
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    const dst = y * size * 4;
    for (let x = 0; x < size * 4; x += 4) {
      image.data[dst + x] = SRGB_LUT[pixels[src + x]!]!;
      image.data[dst + x + 1] = SRGB_LUT[pixels[src + x + 1]!]!;
      image.data[dst + x + 2] = SRGB_LUT[pixels[src + x + 2]!]!;
      image.data[dst + x + 3] = pixels[src + x + 3]!;
    }
  }
  g.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}
