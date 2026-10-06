/*
 * Canvas face atlas and expression frames (design.md "얼굴", "표정 프레임").
 *
 * The atlas is a 768 × 768 CanvasTexture of 3 × 3 cells (rows: eyes open · half · closed; columns: mouth closed ·
 * small · wide), each drawn inside an 8 px margin so mipmaps never bleed between cells: big anime eyes (vertical
 * gradient iris, two highlights of different sizes, a bold upper lid line), brows and a small mouth on a transparent
 * background (the face plane's skin colour shows through). The rig shader picks the cell from the `faceCell` uniform.
 *
 * FaceAnimator blinks every 3–5 s (random, seeded): half → closed → half over 0.15 s; while its owner talks the mouth
 * cell changes every 0.1 s. It only calls the rig's setFaceCell (uniforms), never touching geometry.
 */
import * as THREE from 'three';
import { createRng, hashString, type Rng } from '../core/rng';
import { FACE_ATLAS_SIZE, FACE_CELL_MARGIN, FACE_CELL_SIZE } from './rigMaterial';
import type { FaceSpec } from './rigTypes';

export type EyeCell = 0 | 1 | 2;
export type MouthCell = 0 | 1 | 2;

export const BLINK_MIN_SECONDS = 3;
export const BLINK_MAX_SECONDS = 5;
/** Whole blink (half → closed → half). */
export const BLINK_SECONDS = 0.15;
/** Mouth cell period while talking. */
export const MOUTH_STEP_SECONDS = 0.1;

export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement | OffscreenCanvas | null;

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const css = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

/** The default canvas factory: a DOM canvas, else an OffscreenCanvas, else null (no atlas: Node). */
export const defaultCanvasFactory: CanvasFactory = (width, height) => {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  return null;
};

/** Draws one eye (centre cx, cy in cell pixels, `side` −1 viewer-left / +1 viewer-right) at openness `row`. */
function drawEye(g: Ctx2D, face: FaceSpec, cx: number, cy: number, side: -1 | 1, row: EyeCell): void {
  const line = css(face.lineColor ?? 0x2a1a18);
  const w = face.eyeShape === 'sharp' ? 34 : face.eyeShape === 'soft' ? 31 : 29;
  const h = face.eyeShape === 'sharp' ? 30 : face.eyeShape === 'soft' ? 34 : 38;
  // Outer corner lift of a sharp eye.
  const tilt = face.eyeShape === 'sharp' ? 0.22 * side : face.eyeShape === 'soft' ? -0.06 * side : 0;
  g.save();
  g.translate(cx, cy);
  g.rotate(tilt);
  if (row === 2) {
    // Closed: a lash arc curving down, and a short lash tick at the outer corner.
    g.strokeStyle = line;
    g.lineWidth = 7;
    g.lineCap = 'round';
    g.beginPath();
    g.ellipse(0, -4, w, h * 0.35, 0, Math.PI * 0.08, Math.PI * 0.92);
    g.stroke();
    g.restore();
    return;
  }
  const open = row === 0 ? 1 : 0.5;
  const top = -h + (1 - open) * h * 1.2; // the lid line comes down for half-open
  g.save();
  g.beginPath();
  g.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = '#fbfbff';
  g.fillRect(-w, top, w * 2, h * 2);
  // Iris with a vertical gradient, pupil, two highlights.
  const iris = g.createLinearGradient(0, -h * 0.8, 0, h * 0.8);
  iris.addColorStop(0, css(face.irisTop));
  iris.addColorStop(1, css(face.irisBottom));
  g.fillStyle = iris;
  g.beginPath();
  g.ellipse(0, h * 0.08, w * 0.68, h * 0.8, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = css(face.irisTop);
  g.beginPath();
  g.ellipse(0, h * 0.02, w * 0.3, h * 0.38, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(-w * 0.28 * side, -h * 0.28 + (1 - open) * h * 0.5, 8, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(w * 0.24 * side, h * 0.38, 4, 0, Math.PI * 2);
  g.fill();
  // Half-open: cover the top with the lid (transparent → skin shows through).
  if (open < 1) g.clearRect(-w - 2, -h - 2, w * 2 + 4, top + h + 2);
  g.restore();
  // Bold upper lid line and a thin lower lash.
  g.strokeStyle = line;
  g.lineCap = 'round';
  g.lineWidth = 8;
  g.beginPath();
  if (open < 1) {
    g.moveTo(-w - 2, top + 2);
    g.quadraticCurveTo(0, top - 4, w + 2, top + 2);
  } else {
    g.ellipse(0, 0, w + 1, h + 1, 0, Math.PI * 1.08, Math.PI * 1.92);
  }
  g.stroke();
  g.lineWidth = 3;
  g.beginPath();
  g.ellipse(0, 0, w * 0.9, h, 0, Math.PI * 0.3, Math.PI * 0.7);
  g.stroke();
  g.restore();
}

function drawBrow(g: Ctx2D, face: FaceSpec, cx: number, cy: number, side: -1 | 1): void {
  const slope = face.eyeShape === 'sharp' ? 9 : face.eyeShape === 'soft' ? -3 : 2;
  g.strokeStyle = css(face.lineColor ?? 0x2a1a18);
  g.lineWidth = 6;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx - 26 * side, cy + slope);
  g.quadraticCurveTo(cx, cy - 6, cx + 24 * side, cy - slope * 0.4);
  g.stroke();
}

function drawMouth(g: Ctx2D, face: FaceSpec, cx: number, cy: number, col: MouthCell): void {
  const line = css(face.lineColor ?? 0x2a1a18);
  g.lineCap = 'round';
  if (col === 0) {
    g.strokeStyle = line;
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cx - 12, cy);
    g.quadraticCurveTo(cx, cy + 5, cx + 12, cy);
    g.stroke();
    return;
  }
  const rx = col === 1 ? 10 : 17;
  const ry = col === 1 ? 7 : 14;
  g.fillStyle = '#5a1f24';
  g.beginPath();
  g.ellipse(cx, cy + ry * 0.3, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#d9707a';
  g.beginPath();
  g.ellipse(cx, cy + ry * 0.75, rx * 0.6, ry * 0.4, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = line;
  g.lineWidth = 3;
  g.beginPath();
  g.ellipse(cx, cy + ry * 0.3, rx, ry, 0, 0, Math.PI * 2);
  g.stroke();
}

/** Draws the 3 × 3 atlas into a 768 × 768 2D context (exported for tests with a recording context). */
export function drawFaceAtlas(g: Ctx2D, face: FaceSpec): void {
  g.clearRect(0, 0, FACE_ATLAS_SIZE, FACE_ATLAS_SIZE);
  const inner = FACE_CELL_SIZE - 2 * FACE_CELL_MARGIN;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const x0 = col * FACE_CELL_SIZE + FACE_CELL_MARGIN;
      const y0 = row * FACE_CELL_SIZE + FACE_CELL_MARGIN;
      g.save();
      g.beginPath();
      g.rect(x0, y0, inner, inner);
      g.clip();
      g.translate(x0, y0);
      // Cell layout (240 px): eyes a little above the centre, brows over them, the mouth near the chin.
      for (const side of [-1, 1] as const) {
        drawBrow(g, face, 120 + side * 56, 64, side);
        drawEye(g, face, 120 + side * 54, 116, side, row as EyeCell);
      }
      drawMouth(g, face, 120, 196, col as MouthCell);
      g.restore();
    }
  }
}

const atlasCache = new Map<string, THREE.Texture>();

/**
 * The face atlas texture of `face` (cached per look), or null when no canvas can be made (Node, workers without
 * OffscreenCanvas): the rig then shows its plain skin colour.
 */
export function faceAtlasTexture(face: FaceSpec, canvasFactory: CanvasFactory = defaultCanvasFactory): THREE.Texture | null {
  const key = `${face.irisTop}:${face.irisBottom}:${face.eyeShape}:${face.lineColor ?? ''}`;
  const cached = atlasCache.get(key);
  if (cached !== undefined) return cached;
  const canvas = canvasFactory(FACE_ATLAS_SIZE, FACE_ATLAS_SIZE);
  if (canvas === null) return null;
  const g = canvas.getContext('2d') as Ctx2D | null;
  if (g === null) return null;
  drawFaceAtlas(g, face);
  const texture = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.name = `faceAtlas:${key}`;
  atlasCache.set(key, texture);
  return texture;
}

/** Blink and talk timing for one face: calls `apply(eye, mouth)` whenever the cell changes. */
export class FaceAnimator {
  /** Mouth moves while true (dialogue line playing). */
  talking = false;
  private readonly rng: Rng;
  private untilBlink: number;
  private blinkTime = -1;
  private mouthTime = 0;
  private mouthStep = 0;
  private eyeCell: EyeCell = 0;
  private mouthCell: MouthCell = 0;

  constructor(seed: number | string, private readonly apply: (eye: EyeCell, mouth: MouthCell) => void) {
    this.rng = createRng(typeof seed === 'string' ? hashString(seed) : seed);
    this.untilBlink = this.nextInterval();
  }

  get eye(): EyeCell {
    return this.eyeCell;
  }

  get mouth(): MouthCell {
    return this.mouthCell;
  }

  /** Seconds to the next blink start. */
  get nextBlinkIn(): number {
    return this.blinkTime >= 0 ? 0 : this.untilBlink;
  }

  private nextInterval(): number {
    return this.rng.range(BLINK_MIN_SECONDS, BLINK_MAX_SECONDS);
  }

  /** Starts a blink now (a hurt flinch, a cut). */
  blink(): void {
    this.blinkTime = 0;
  }

  update(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 1) : 0;
    let eye: EyeCell = 0;
    if (this.blinkTime < 0) {
      this.untilBlink -= step;
      if (this.untilBlink <= 0) {
        this.blinkTime = -this.untilBlink; // carry the overshoot into the blink
        this.untilBlink = this.nextInterval();
      }
    } else {
      this.blinkTime += step;
    }
    if (this.blinkTime >= 0) {
      const t = this.blinkTime;
      if (t >= BLINK_SECONDS) this.blinkTime = -1;
      else eye = t < BLINK_SECONDS / 3 ? 1 : t < (2 * BLINK_SECONDS) / 3 ? 2 : 1;
    }
    let mouth: MouthCell = 0;
    if (this.talking) {
      this.mouthTime += step;
      while (this.mouthTime >= MOUTH_STEP_SECONDS) {
        this.mouthTime -= MOUTH_STEP_SECONDS;
        this.mouthStep++;
      }
      mouth = TALK_PATTERN[this.mouthStep % TALK_PATTERN.length]!;
    } else {
      this.mouthTime = 0;
      this.mouthStep = 0;
    }
    if (eye !== this.eyeCell || mouth !== this.mouthCell) {
      this.eyeCell = eye;
      this.mouthCell = mouth;
      this.apply(eye, mouth);
    }
  }
}

/** Mouth cells cycled every 0.1 s while talking (never the same twice in a row). */
const TALK_PATTERN: readonly MouthCell[] = [1, 2, 1, 0, 2, 1, 0, 2];
