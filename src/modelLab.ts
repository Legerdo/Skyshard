/*
 * model-lab.html (task 19.8, design.md "교체 절차" step 3): a developer page to check a Visual_Manifest entry before it
 * ships — `model-lab.html?entity=<id>` (optionally `&kind=gltf|fbx|vrm&url=assets/models/x.glb&rig=humanoid|generic
 * &restPose=T|A&height=1.7&yaw=180` to try a file without editing the manifest).
 *
 * - Entity select; the entity's model through the same VisualLibrary path as the game (procedural first, swapped to the
 *   external model when it loads), next to the procedural model for comparison.
 * - Bone mapping table (humanoid bone ← model node, source manual / vrm / auto, required ones missing in red), the
 *   bones dropped by the hierarchy check and every warning (a failed load keeps the procedural model, Req 43.7).
 * - Pose preview: any pose clip of the entity (retargeted, or the file's clip when `clips` maps it), T-pose, and the
 *   largest bone-direction difference between the two models.
 * - Socket check: axes on weaponR / weaponL / back / headTop and their positions.
 * - Export: the procedural model as GLB (GLTFExporter) and the same bytes loaded back through the glTF adapter.
 * Development only: no game state, no network besides the same-origin model file.
 *
 * Automation (tests/e2e/system; keep stable): `<body data-lab-status>` is loading | procedural | external | fallback |
 * error; controls have fixed ids (#lab-entity, #lab-kind, #lab-url, #lab-rig, #lab-rest-pose, #lab-height, #lab-yaw,
 * #lab-apply, #lab-clip, #lab-play, #lab-tpose, #lab-export, #lab-reimport; #lab-status, #lab-warnings, #lab-bone-rows,
 * #lab-socket-rows, #lab-pose-diff); `window.__modelLab` (ModelLabApi below) shows entities, poses, exports and
 * reimports without the UI and returns a JSON-safe state.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { AnimRequest, BlendDef } from './anim/animator';
import { HERO_BLENDS } from './anim/animState';
import type { PoseClip } from './anim/clip';
import { CAELITH_CLIP_LIST, ENEMY_CLIP_SETS, heroClips, NPC_CLIPS } from './anim/clips';
import { RIG_HUMANOID_BONES, type RigHumanoidBone } from './anim/rigLayout';
import { isBossId, isCharacterId, isNpcId, type VisualEntityId } from './data/ids';
import {
  isVisualEntityId, SOCKET_NAMES, VISUAL_ENTITY_IDS, VISUAL_MANIFEST, type ExternalSourceKind, type VisualSpec,
} from './data/visualManifest';
import { AnimatedView } from './visual/animatedView';
import { EntityView } from './visual/entityView';
import { ExternalVisualProvider } from './visual/externalLoaders';
import { ExternalVisualInstance, ExternalVisualTemplate } from './visual/externalModel';
import type { VisualInstance, VisualProvider } from './visual/types';
import { VisualLibrary } from './visual/visualLibrary';

const canvas = document.getElementById('lab-canvas') as HTMLCanvasElement;
const panel = document.getElementById('lab-panel') as HTMLElement;

// ── Renderer and scene ──────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202432);
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a4058, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 6, 4);
sun.castShadow = true;
scene.add(sun);
const grid = new THREE.GridHelper(8, 16, 0x5a6080, 0x363b52);
scene.add(grid);
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
camera.position.set(0, 1.6, 4.2);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1, 0);
controls.update();

function resize(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ── Panel helpers ───────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

let controlCount = 0;
function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  if (control.id === '') control.id = `lab-control-${++controlCount}`;
  return el('label', { htmlFor: control.id }, text);
}

// Element ids are stable (Playwright system scenarios drive the page by them, see the window hook at the end).
const params = new URLSearchParams(location.search);
const entitySelect = el('select', { id: 'lab-entity' });
for (const id of VISUAL_ENTITY_IDS) entitySelect.append(el('option', { value: id, textContent: id }));
const kindSelect = el('select', { id: 'lab-kind' });
for (const k of ['(manifest)', 'gltf', 'fbx', 'vrm']) kindSelect.append(el('option', { value: k, textContent: k }));
const urlInput = el('input', { id: 'lab-url', type: 'text', placeholder: 'assets/models/model.glb' });
const rigSelect = el('select', { id: 'lab-rig' });
for (const r of ['humanoid', 'generic']) rigSelect.append(el('option', { value: r, textContent: r }));
const restSelect = el('select', { id: 'lab-rest-pose' });
for (const r of ['T', 'A']) restSelect.append(el('option', { value: r, textContent: r }));
const heightInput = el('input', { id: 'lab-height', type: 'number', step: '0.01', min: '0', placeholder: '(절차적 높이)' });
const yawInput = el('input', { id: 'lab-yaw', type: 'number', step: '1', placeholder: '(기본)' });
const applyButton = el('button', { id: 'lab-apply', type: 'button', textContent: '적용' });
const clipSelect = el('select', { id: 'lab-clip' });
const playBox = el('input', { id: 'lab-play', type: 'checkbox', checked: true });
const tposeBox = el('input', { id: 'lab-tpose', type: 'checkbox' });
const socketBox = el('input', { id: 'lab-show-sockets', type: 'checkbox', checked: true });
const skeletonBox = el('input', { id: 'lab-show-skeleton', type: 'checkbox' });
const exportButton = el('button', { id: 'lab-export', type: 'button', textContent: '절차적 모델 GLB 내보내기' });
const reimportButton = el('button', { id: 'lab-reimport', type: 'button', textContent: '내보낸 GLB 다시 불러오기', disabled: true });
const status = el('div', { id: 'lab-status' });
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');
const poseLine = el('div', { id: 'lab-pose-diff', className: 'optional' });
const warningsBox = el('div', { id: 'lab-warnings' });
const boneTableBody = el('tbody', { id: 'lab-bone-rows' });
const socketTableBody = el('tbody', { id: 'lab-socket-rows' });
const droppedBox = el('div', { id: 'lab-notes', className: 'optional' });

/** Where the page stands: `<body data-lab-status>` and `window.__modelLab.state().status`. */
export type LabStatus = 'procedural' | 'loading' | 'external' | 'fallback' | 'error';
let labStatus: LabStatus = 'loading';

function setStatus(kind: LabStatus, text: string): void {
  labStatus = kind;
  status.textContent = text;
  document.body.dataset.labStatus = kind;
}

panel.append(
  el('h1', {}, 'Skyshard Model Lab'),
  labelled('엔티티', entitySelect), entitySelect,
  el('h2', {}, '소스 (manifest 덮어쓰기)'),
  labelled('종류', kindSelect), kindSelect,
  labelled('URL (same-origin 상대 경로)', urlInput), urlInput,
  labelled('rig', rigSelect), rigSelect,
  labelled('restPose', restSelect), restSelect,
  labelled('height (m)', heightInput), heightInput,
  labelled('yawDeg', yawInput), yawInput,
  applyButton,
  el('div', { className: 'row' }, el('label', {}, socketBox, 'socket 축'), el('label', {}, skeletonBox, '골격')),
  status,
  el('h2', {}, '포즈'),
  labelled('clip', clipSelect), clipSelect,
  el('div', { className: 'row' }, el('label', {}, playBox, '재생'), el('label', {}, tposeBox, 'T-pose')),
  poseLine,
  el('h2', {}, 'bone 대응표'),
  el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'humanoid'), el('th', {}, '모델 node'), el('th', {}, '출처'), el('th', {}, '상태'))), boneTableBody),
  droppedBox,
  el('h2', {}, 'socket'),
  el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'socket'), el('th', {}, '부모'), el('th', {}, '위치 (m)'))), socketTableBody),
  el('h2', {}, '내보내기'),
  exportButton, reimportButton,
  el('h2', {}, '경고'),
  warningsBox,
);

// ── Entity state ────────────────────────────────────────────────────────────

interface Shown {
  readonly view: EntityView;
  readonly anim: AnimatedView;
  readonly helpers: THREE.Object3D[];
}

let entity: VisualEntityId = isVisualEntityId(params.get('entity')) ? (params.get('entity') as VisualEntityId) : 'kairen';
let library: VisualLibrary | null = null;
let main: Shown | null = null;
let reference: Shown | null = null;
/** The last GLB export (its entity and rest bounds). */
let exported: { id: VisualEntityId; buffer: ArrayBuffer; box: THREE.Box3 } | null = null;
let time = 0;
/** Settles when the current entity's external load (if any) has finished or failed. */
let settled: Promise<void> = Promise.resolve();
const warnings: string[] = [];
const provider = new ExternalVisualProvider({ warn: (m) => addWarning(m), log: (m) => console.info(m) });

function addWarning(message: string): void {
  warnings.push(message);
  warningsBox.textContent = warnings.join('\n');
}

function clipsFor(id: VisualEntityId): { clips: readonly PoseClip[]; blends?: Readonly<Record<string, BlendDef>> } {
  if (isCharacterId(id)) return { clips: heroClips(id), blends: HERO_BLENDS };
  if (isNpcId(id)) return { clips: NPC_CLIPS };
  if (isBossId(id)) return { clips: CAELITH_CLIP_LIST };
  const set = (ENEMY_CLIP_SETS as Readonly<Record<string, { readonly clips: readonly PoseClip[] }>>)[id];
  return { clips: set?.clips ?? [] };
}

/** The manifest entry the page shows: the shipped one, or the query / form override. */
function entryFor(id: VisualEntityId): unknown {
  const kind = kindSelect.value;
  if (kind === '(manifest)') return VISUAL_MANIFEST[id];
  const entry: Record<string, unknown> = { source: { kind, url: urlInput.value.trim() }, rig: rigSelect.value };
  if (restSelect.value === 'A') entry.restPose = 'A';
  if (heightInput.value !== '') entry.height = Number(heightInput.value);
  if (yawInput.value !== '') entry.yawDeg = Number(yawInput.value);
  return entry;
}

function disposeShown(s: Shown | null): void {
  if (s === null) return;
  for (const h of s.helpers) h.parent?.remove(h);
  s.anim.dispose();
  scene.remove(s.view.object);
  s.view.dispose();
}

function makeShown(view: EntityView, x: number): Shown {
  view.setPose({ x, y: 0, z: 0 }, 0);
  scene.add(view.object);
  const { clips, blends } = clipsFor(view.id);
  const anim = new AnimatedView(view, { clips, blends, procedural: null, warn: (m) => addWarning(m) });
  const shown: Shown = { view, anim, helpers: [] };
  view.onSwap(() => {
    refreshHelpers(shown);
    refreshTables();
  });
  refreshHelpers(shown);
  return shown;
}

function refreshHelpers(s: Shown): void {
  for (const h of s.helpers.splice(0)) h.parent?.remove(h);
  const instance = s.view.instance;
  if (socketBox.checked) {
    for (const socket of instance.sockets.values()) {
      const axes = new THREE.AxesHelper(0.12 * instance.height);
      socket.add(axes);
      s.helpers.push(axes);
    }
  }
  if (skeletonBox.checked) {
    const helper = new THREE.SkeletonHelper(instance.root);
    scene.add(helper);
    s.helpers.push(helper);
  }
}

function show(id: VisualEntityId): void {
  disposeShown(main);
  disposeShown(reference);
  main = null;
  reference = null;
  library?.dispose();
  warnings.length = 0;
  warningsBox.textContent = '';
  entity = id;
  entitySelect.value = id;
  reimportButton.disabled = exported?.id !== id;
  const manifest = { ...VISUAL_MANIFEST, [id]: entryFor(id) };
  library = new VisualLibrary({
    manifest, warn: (m) => addWarning(m),
    providers: { gltf: provider, fbx: provider, vrm: provider } satisfies Record<ExternalSourceKind, VisualProvider>,
  });
  const spec = library.spec(id);
  const external = spec.source.kind !== 'procedural';
  const height = library.procedural.template(id).height;
  main = makeShown(library.createView(id), external ? 0.7 * height : 0);
  if (external) {
    reference = makeShown(new EntityView(id, library.procedural.template(id).instantiate()), -0.7 * height);
    setStatus('loading', `불러오는 중: ${spec.source.kind} ${'url' in spec.source ? spec.source.url : ''} (그동안 절차적 모델)`);
    const current = library;
    // Same cached promise as createView's: its swap handler was registered first, so the view has swapped by now.
    settled = library.externalTemplate(id).then((template) => {
      if (current !== library) return; // another entity was shown meanwhile
      const extra = template instanceof ExternalVisualTemplate ? `, 배율 ${template.scale.toPrecision(3)}, yaw ${template.yawDeg}°` : '';
      if (template === null) setStatus('fallback', '불러오기 실패: 절차적 모델 유지 (아래 경고 참고)');
      else setStatus('external', `외부 모델 표시 중 (${template.kind}, 높이 ${template.height.toFixed(2)} m${extra})`);
      refreshTables();
    });
  } else if (kindSelect.value !== '(manifest)' || (VISUAL_MANIFEST[id]?.source.kind ?? 'procedural') !== 'procedural') {
    // The entry was refused by resolveVisualSpec (bad URL, unknown field…): one warning, procedural model.
    setStatus('fallback', '항목 거부: 절차적 모델 유지 (아래 경고 참고)');
    settled = Promise.resolve();
  } else {
    setStatus('procedural', '절차적 모델 (manifest 기본값)');
    settled = Promise.resolve();
  }
  controls.target.set(0, height * 0.55, 0);
  camera.position.set(0, height * 0.8, height * 2.6);
  controls.update();
  const { clips } = clipsFor(id);
  clipSelect.replaceChildren(...clips.map((c) => el('option', { value: c.name, textContent: `${c.name} (${c.duration.toFixed(2)} s${c.loop ? ', loop' : ''})` })));
  const idle = clips.find((c) => /idle$/.test(c.name));
  if (idle !== undefined) clipSelect.value = idle.name;
  time = 0;
  refreshTables();
  const query: Record<string, string> = { entity: id };
  if (kindSelect.value !== '(manifest)') {
    Object.assign(query, { kind: kindSelect.value, url: urlInput.value.trim(), rig: rigSelect.value });
    if (restSelect.value === 'A') query.restPose = 'A';
    if (heightInput.value !== '') query.height = heightInput.value;
    if (yawInput.value !== '') query.yaw = yawInput.value;
  }
  history.replaceState(null, '', `?${new URLSearchParams(query).toString()}`);
}

// ── Tables ──────────────────────────────────────────────────────────────────

function refreshTables(): void {
  const instance = main?.view.instance ?? null;
  boneTableBody.replaceChildren();
  droppedBox.textContent = '';
  if (instance instanceof ExternalVisualInstance) {
    const t = instance.template;
    for (const row of t.boneRows) {
      if (row.status === 'optional' && row.node === null) continue;
      boneTableBody.append(el('tr', {},
        el('td', {}, row.bone), el('td', {}, row.node ?? '—'), el('td', {}, row.source ?? '—'),
        el('td', { className: row.status }, row.status === 'ok' ? '✓' : row.required ? '없음 (필수)' : '없음')));
    }
    const notes = [
      ...t.bones.dropped.map((d) => `계층 검증으로 제외: ${d.bone} ← '${t.nodeInfo[d.node]?.name ?? d.node}' (${d.reason})`),
      ...t.bones.problems,
      t.clips.size > 0 ? `clip 대응: ${[...t.clips.entries()].map(([k, v]) => `${k} → ${v.clip.name}`).join(', ')}` : 'clip 대응 없음: 공통 포즈 clip retarget / 절차적 루트 애니메이션',
    ];
    droppedBox.textContent = notes.join('\n');
  } else if (instance !== null) {
    for (const bone of RIG_HUMANOID_BONES) {
      const has = instance.joints.has(bone);
      boneTableBody.append(el('tr', {},
        el('td', {}, bone), el('td', {}, has ? bone : '—'), el('td', {}, has ? 'procedural' : '—'),
        el('td', { className: has ? 'ok' : 'optional' }, has ? '✓' : '없음 (비인간형 preset)')));
    }
    droppedBox.textContent = instance.humanoid === null ? '비인간형 preset: 자체 관절 (retarget 없음)' : '절차적 모델: normalized = raw (T-pose, rest 회전 identity)';
  }
  socketTableBody.replaceChildren();
  if (instance !== null) {
    instance.root.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(instance.root.matrixWorld).invert();
    for (const name of SOCKET_NAMES) {
      const socket = instance.sockets.get(name);
      const p = socket === undefined ? null : new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().multiplyMatrices(rootInv, socket.matrixWorld));
      socketTableBody.append(el('tr', {},
        el('td', {}, name), el('td', {}, socket?.parent?.name || '—'),
        el('td', {}, p === null ? '—' : `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`)));
    }
  }
}

// ── Pose ────────────────────────────────────────────────────────────────────

const REST: AnimRequest = { base: { clip: '__rest__' }, action: null, override: null };

function requestFor(s: Shown, name: string): AnimRequest | null {
  const clip = s.anim.animator?.clip(name);
  if (clip === undefined) return null;
  const t = clip.loop ? time : time % (clip.duration + 0.4);
  return { base: { clip: name, time: t }, action: null, override: null };
}

function pose(s: Shown | null, dt: number): void {
  if (s === null) return;
  const req = tposeBox.checked ? null : requestFor(s, clipSelect.value);
  if (req === null) {
    s.anim.animator?.reset();
    s.view.instance.animate?.(dt, REST);
  } else {
    s.anim.update(dt, req);
  }
  s.view.update(dt);
}

/** First child of each humanoid bone in the procedural tree (the bone direction of Property 31). */
const CHILD: Partial<Record<RigHumanoidBone, RigHumanoidBone>> = {
  hips: 'spine', spine: 'chest', chest: 'neck', neck: 'head',
  leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand',
  leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot',
};

function boneDirection(instance: VisualInstance, bone: RigHumanoidBone, child: RigHumanoidBone): THREE.Vector3 | null {
  const nodes = instance instanceof ExternalVisualInstance ? instance.rawBones : instance.joints;
  const a = nodes.get(bone);
  const b = nodes.get(child);
  if (a === undefined || b === undefined) return null;
  const inv = new THREE.Matrix4().copy(instance.root.matrixWorld).invert();
  const pa = a.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  const pb = b.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  return pb.sub(pa).normalize();
}

/** Largest bone-direction angle between the external model (retargeted pose) and the procedural one, or null. */
function poseDifference(): { deg: number; bone: string } | null {
  const a = main?.view.instance;
  const b = reference?.view.instance;
  if (!(a instanceof ExternalVisualInstance) || b === undefined || a.humanoid === null || a.mode !== 'pose') return null;
  let worst = 0;
  let where = '';
  for (const [bone, child] of Object.entries(CHILD) as [RigHumanoidBone, RigHumanoidBone][]) {
    const da = boneDirection(a, bone, child);
    const db = boneDirection(b, bone, child);
    if (da === null || db === null) continue;
    const angle = THREE.MathUtils.radToDeg(da.angleTo(db));
    if (angle > worst) {
      worst = angle;
      where = bone;
    }
  }
  return { deg: worst, bone: where };
}

function poseDifferenceText(): string {
  const d = poseDifference();
  return d === null ? '' : `bone 방향 최대 차이: ${d.deg.toFixed(2)}° (${d.bone || '—'}), 절차적 모델 대비`;
}

// ── Export ──────────────────────────────────────────────────────────────────

/**
 * The procedural model as GLB: body and weapon with standard materials, outlines / aura hidden, userData left out; with
 * the rest bounds of what was exported (hair and weapon reach past the rig's nominal height).
 */
async function exportProcedural(id: VisualEntityId): Promise<{ buffer: ArrayBuffer; box: THREE.Box3 }> {
  if (library === null) throw new Error('no library');
  const instance = library.procedural.template(id).instantiate();
  const restore: (() => void)[] = [];
  const standard = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  instance.root.traverse((o) => {
    const data = o.userData;
    const hide = (data as { outline?: unknown }).outline !== undefined || o.name.endsWith(':aura');
    o.userData = {};
    restore.push(() => { o.userData = data; });
    if (hide && o.visible) {
      o.visible = false;
      restore.push(() => { o.visible = true; });
    }
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh === true && !hide && !(mesh.material instanceof THREE.MeshStandardMaterial)) {
      const previous = mesh.material;
      mesh.material = standard;
      restore.push(() => { mesh.material = previous; });
    }
  });
  instance.root.updateMatrixWorld(true);
  // Skinned rest bounds of the visible meshes (the same measure the external template normalises with).
  const box = new THREE.Box3();
  const vertex = new THREE.Vector3();
  instance.root.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    const count = mesh.geometry.getAttribute('position')?.count ?? 0;
    for (let i = 0; i < count; i++) box.expandByPoint(mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld));
  });
  try {
    const result = await new GLTFExporter().parseAsync(instance.root, { binary: true, onlyVisible: true });
    if (!(result instanceof ArrayBuffer)) throw new Error('GLTFExporter returned JSON, not GLB');
    return { buffer: result, box };
  } finally {
    for (const undo of restore.reverse()) undo();
    standard.dispose();
    instance.dispose();
  }
}

/** Exports the current entity's procedural model (kept for the reimport); `download` also saves `<id>.glb`. */
async function exportCurrent(download: boolean): Promise<number> {
  setStatus(labStatus, 'GLB 내보내는 중…');
  try {
    const { buffer, box } = await exportProcedural(entity);
    exported = { id: entity, buffer, box };
    reimportButton.disabled = false;
    if (download) {
      const url = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
      const a = el('a', { href: url, download: `${entity}.glb` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    setStatus(labStatus, `${entity}.glb 내보냄 (${(buffer.byteLength / 1024).toFixed(0)} KB). public/assets/models/에 두고 manifest의 source를 바꾸면 교체 경로로 불러온다.`);
    return buffer.byteLength;
  } catch (error) {
    setStatus('error', `내보내기 실패: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** Loads the exported GLB back through the glTF adapter (the replacement path without the fetch) and shows it. */
async function reimportExported(): Promise<void> {
  const file = exported;
  if (file === null || file.id !== entity || main === null) throw new Error('nothing exported for this entity yet');
  // The manifest entry a developer would write for this file: the exported bounds as height and feet offset (so it
  // stands exactly where the procedural model does), and its own weapon instead of the procedural one.
  const spec: VisualSpec = {
    source: { kind: 'gltf', url: `assets/models/${entity}.glb` }, rig: VISUAL_MANIFEST[entity]!.rig, hideProceduralWeapon: true,
    height: file.box.max.y - file.box.min.y, offset: [0, file.box.min.y, 0],
  };
  try {
    const template = await provider.loadBuffer(entity, spec, file.buffer);
    if (reference === null && library !== null) {
      reference = makeShown(new EntityView(entity, library.procedural.template(entity).instantiate()), -0.7 * template.height);
    }
    main.view.setPose({ x: 0.7 * template.height, y: 0, z: 0 }, 0);
    main.view.swapVisual(template.instantiate());
    setStatus('external', `내보낸 GLB를 glTF 어댑터로 다시 불러와 표시 중 (높이 ${template.height.toFixed(2)} m)`);
    refreshTables();
  } catch (error) {
    setStatus('error', `다시 불러오기 실패: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

exportButton.addEventListener('click', () => { exportCurrent(true).catch(() => undefined); });
reimportButton.addEventListener('click', () => { reimportExported().catch(() => undefined); });

// ── Wiring and loop ─────────────────────────────────────────────────────────

const queryKind = params.get('kind');
if (queryKind === 'gltf' || queryKind === 'fbx' || queryKind === 'vrm') {
  kindSelect.value = queryKind;
  urlInput.value = params.get('url') ?? '';
  rigSelect.value = params.get('rig') === 'generic' ? 'generic' : 'humanoid';
  restSelect.value = params.get('restPose') === 'A' ? 'A' : 'T';
  heightInput.value = params.get('height') ?? '';
  yawInput.value = params.get('yaw') ?? '';
}
entitySelect.addEventListener('change', () => {
  kindSelect.value = '(manifest)';
  show(entitySelect.value as VisualEntityId);
});
applyButton.addEventListener('click', () => show(entity));
socketBox.addEventListener('change', () => { if (main !== null) refreshHelpers(main); if (reference !== null) refreshHelpers(reference); });
skeletonBox.addEventListener('change', () => { if (main !== null) refreshHelpers(main); if (reference !== null) refreshHelpers(reference); });
clipSelect.addEventListener('change', () => { time = 0; });

const clock = new THREE.Clock();
let tableTimer = 0;
function frame(): void {
  const dt = Math.min(0.1, clock.getDelta());
  if (playBox.checked) time += dt;
  pose(main, playBox.checked ? dt : 0);
  pose(reference, playBox.checked ? dt : 0);
  tableTimer += dt;
  if (tableTimer > 0.5) {
    tableTimer = 0;
    poseLine.textContent = poseDifferenceText();
    if (!playBox.checked) refreshTables();
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ── Test / console hook (`window.__modelLab`) ───────────────────────────────

/** A manifest entry override (like the form / query parameters). */
export interface ModelLabSource {
  readonly kind: ExternalSourceKind;
  /** Same-origin relative path, e.g. 'assets/models/kairen.glb'. */
  readonly url: string;
  readonly rig?: 'humanoid' | 'generic';
  readonly restPose?: 'T' | 'A';
  readonly height?: number;
  readonly yawDeg?: number;
}

export interface ModelLabState {
  readonly entity: VisualEntityId;
  readonly status: LabStatus;
  readonly statusText: string;
  /** What the main view shows now. */
  readonly shown: 'procedural' | ExternalSourceKind;
  readonly height: number;
  /** External model: normalisation scale and front correction (°). */
  readonly scale: number | null;
  readonly yawDeg: number | null;
  /** External model: 'pose' (retargeted clips / generic root motion) or 'mixer:<file clip>'. */
  readonly mode: string | null;
  readonly bones: readonly { bone: string; node: string | null; source: string | null; status: 'ok' | 'missing' | 'optional' }[];
  /** Required humanoid bones the external model lacks. */
  readonly missing: readonly string[];
  readonly sockets: readonly { name: string; parent: string | null; position: [number, number, number] | null }[];
  readonly clip: string;
  readonly clips: readonly string[];
  /** Largest bone-direction difference to the procedural model (°) while an external humanoid retargets, else null. */
  readonly poseDifferenceDeg: number | null;
  readonly warnings: readonly string[];
  readonly exportedBytes: number | null;
}

export interface ModelLabApi {
  state(): ModelLabState;
  /** Resolves once the current external load has finished (or failed). */
  ready(): Promise<ModelLabState>;
  /** Shows an entity with its manifest entry (`source` null / absent) or an override, and waits for the load. */
  show(entity: VisualEntityId, source?: ModelLabSource | null): Promise<ModelLabState>;
  /** Pauses playback and poses both models at `clip` / `time` s (`clip` null: T-pose). */
  preview(clip: string | null, time?: number): ModelLabState;
  /** Exports the procedural model as GLB (no download); resolves to its byte length. */
  exportGlb(): Promise<number>;
  /** Loads the exported GLB back through the glTF adapter and shows it (status 'external'). */
  reimportGlb(): Promise<ModelLabState>;
}

function labState(): ModelLabState {
  const instance = main?.view.instance ?? null;
  const ext = instance instanceof ExternalVisualInstance ? instance : null;
  let bones: ModelLabState['bones'] = [];
  if (ext !== null) {
    bones = ext.template.boneRows.map((r) => ({ bone: r.bone, node: r.node, source: r.source, status: r.status }));
  } else if (instance !== null) {
    bones = RIG_HUMANOID_BONES.map((b) => instance.joints.has(b)
      ? { bone: b, node: b, source: 'procedural', status: 'ok' as const }
      : { bone: b, node: null, source: null, status: 'optional' as const });
  }
  let sockets: ModelLabState['sockets'] = [];
  if (instance !== null) {
    instance.root.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(instance.root.matrixWorld).invert();
    sockets = SOCKET_NAMES.map((name) => {
      const socket = instance.sockets.get(name);
      if (socket === undefined) return { name, parent: null, position: null };
      const p = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().multiplyMatrices(rootInv, socket.matrixWorld));
      return { name, parent: socket.parent?.name ?? null, position: [p.x, p.y, p.z] as [number, number, number] };
    });
  }
  return {
    entity,
    status: labStatus,
    statusText: status.textContent ?? '',
    shown: ext?.template.kind ?? 'procedural',
    height: instance?.height ?? 0,
    scale: ext?.template.scale ?? null,
    yawDeg: ext?.template.yawDeg ?? null,
    mode: ext?.mode ?? null,
    bones,
    missing: ext !== null && ext.template.spec.rig === 'humanoid' ? ext.template.bones.missing : [],
    sockets,
    clip: tposeBox.checked ? 'T-pose' : clipSelect.value,
    clips: [...clipSelect.options].map((o) => o.value),
    poseDifferenceDeg: poseDifference()?.deg ?? null,
    warnings: [...warnings],
    exportedBytes: exported?.id === entity ? exported.buffer.byteLength : null,
  };
}

const labApi: ModelLabApi = {
  state: labState,
  ready: () => settled.then(labState),
  async show(id, source) {
    if (!isVisualEntityId(id)) throw new Error(`unknown entity '${String(id)}'`);
    if (source === undefined || source === null) {
      kindSelect.value = '(manifest)';
    } else {
      kindSelect.value = source.kind;
      urlInput.value = source.url;
      rigSelect.value = source.rig ?? 'humanoid';
      restSelect.value = source.restPose ?? 'T';
      heightInput.value = source.height === undefined ? '' : String(source.height);
      yawInput.value = source.yawDeg === undefined ? '' : String(source.yawDeg);
    }
    show(id);
    await settled;
    return labState();
  },
  preview(clip, t = 0) {
    if (clip !== null && ![...clipSelect.options].some((o) => o.value === clip)) throw new Error(`no clip '${clip}' for ${entity}`);
    playBox.checked = false;
    tposeBox.checked = clip === null;
    if (clip !== null) clipSelect.value = clip;
    time = Number.isFinite(t) ? t : 0;
    // Two long steps settle the Animator's crossfades and the model's own blends.
    for (let i = 0; i < 2; i++) {
      pose(main, 0.3);
      pose(reference, 0.3);
    }
    poseLine.textContent = poseDifferenceText();
    return labState();
  },
  exportGlb: () => exportCurrent(false),
  async reimportGlb() {
    await reimportExported();
    return labState();
  },
};

declare global {
  interface Window {
    /** model-lab.html only (tests/e2e/system, console). */
    __modelLab?: ModelLabApi;
  }
}
window.__modelLab = labApi;

resize();
show(entity);
requestAnimationFrame(frame);
