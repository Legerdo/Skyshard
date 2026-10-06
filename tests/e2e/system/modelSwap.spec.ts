// System scenario: visual model swap in model-lab.html (task 24.3; design "모델 교체", Req 43.2, 43.4–43.8, 43.10):
// - GLB: the procedural Kairen exported as GLB (the page's download), loaded back in memory through the glTF adapter,
//   then served as `assets/models/kairen.glb` and loaded through the manifest override (the real replacement path:
//   VisualLibrary → fetch → glTF adapter); the bone table maps every required humanoid bone, the retargeted pose
//   matches the procedural model's and the sockets sit on the swapped skeleton.
// - VRM: the same GLB with a `VRMC_vrm` 1.0 extension (meta + humanoid bones by node name) loaded through the VRM
//   adapter (@pixiv/three-vrm): the bones come from the VRM humanoid.
// - FBX: a CC0 sample from tests/fixtures/models/*.fbx when one is there, otherwise recorded as not run.
// - Corrupt: a GLB whose JSON chunk is destroyed falls back to the procedural model with exactly one warning.
// Each case saves a screenshot under test-results/model-swap/ (kept apart from the playthrough's 14 in
// test-results/screenshots/) and its result into test-results/model-swap.json for the verification summary.
import type { Page, TestInfo } from '@playwright/test';
import type { ModelFormat, ModelSwapResult } from '../../tools/verificationSummary';
import { expect, expectCleanRun, test } from '../fixtures';
import { nodeFs, PLAY_TRACE, writeResultJson } from './play';

test.use(PLAY_TRACE);

const SHOTS = 'test-results/model-swap';
const RESULTS = 'model-swap.json';
const FBX_DIR = 'tests/fixtures/models';
const FORMATS: readonly ModelFormat[] = ['glb', 'vrm', 'fbx', 'corrupt'];
/** The 15 bones an external humanoid must provide (src/data/visualManifest.ts REQUIRED_HUMANOID_BONES). */
const REQUIRED = [
  'hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];
/** Every VRM humanoid bone name the VRMC_vrm extension may map (the procedural rig names its bones after them). */
const VRM_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
];
/** Largest bone-direction difference (°) a retargeted copy of the procedural model may show against the original. */
const POSE_TOLERANCE_DEG = 10;

/** `window.__modelLab.state()` (src/modelLab.ts ModelLabState), the fields read here. */
interface LabState {
  readonly status: 'procedural' | 'loading' | 'external' | 'fallback' | 'error';
  readonly statusText: string;
  readonly shown: string;
  readonly height: number;
  readonly mode: string | null;
  readonly bones: readonly { bone: string; node: string | null; source: string | null; status: string }[];
  readonly missing: readonly string[];
  readonly sockets: readonly { name: string; parent: string | null; position: [number, number, number] | null }[];
  readonly clip: string;
  readonly poseDifferenceDeg: number | null;
  readonly warnings: readonly string[];
}
interface LabWindow {
  __modelLab?: { state(): unknown; ready(): Promise<unknown>; preview(clip: string | null, time?: number): unknown };
}

// ── Results file ────────────────────────────────────────────────────────────

/** Replaces this format's entry in test-results/model-swap.json (each test adds its own, in FORMATS order). */
function record(result: ModelSwapResult): void {
  const fs = nodeFs();
  let list: ModelSwapResult[] = [];
  try {
    const old = JSON.parse(fs.readFileSync(`test-results/${RESULTS}`, 'utf8')) as unknown;
    if (Array.isArray(old)) list = old.filter((r): r is ModelSwapResult => typeof r === 'object' && r !== null && FORMATS.includes((r as ModelSwapResult).format));
  } catch {
    // no file yet
  }
  list = [...list.filter((r) => r.format !== result.format), result].sort((a, b) => FORMATS.indexOf(a.format) - FORMATS.indexOf(b.format));
  writeResultJson(RESULTS, list);
}

// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0]!.trim();

test.afterEach(({}, testInfo: TestInfo) => {
  const format = testInfo.annotations.find((a) => a.type === 'format')?.description as ModelFormat | undefined;
  if (format === undefined) return;
  if (testInfo.status === 'passed') record({ format, status: 'passed' });
  else if (testInfo.status === 'skipped') record({ format, status: 'notRun', reason: testInfo.annotations.find((a) => a.type === 'skip')?.description ?? '건너뜀' });
  else record({ format, status: 'failed', reason: plain(testInfo.error?.message ?? testInfo.status ?? 'failed') });
});

// ── Page helpers ────────────────────────────────────────────────────────────

const labState = (page: Page): Promise<LabState> =>
  page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as LabWindow).__modelLab!.state())) as never);

/** Opens model-lab.html with `query` and waits until its load has settled (`<body data-lab-status>`). */
async function openLab(page: Page, query: string, until: LabState['status']): Promise<LabState> {
  await page.goto(`/model-lab.html?${query}`);
  await page.waitForFunction(() => (window as unknown as LabWindow).__modelLab !== undefined);
  await expect(page.locator('body'), `model-lab settles as '${until}'`).toHaveAttribute('data-lab-status', until, { timeout: 30_000 });
  return page.evaluate(async () => JSON.parse(JSON.stringify(await (window as unknown as LabWindow).__modelLab!.ready())) as never);
}

/** The page's "절차적 모델 GLB 내보내기" download of the procedural Kairen, saved under the test's output dir. */
async function exportKairen(page: Page, testInfo: TestInfo): Promise<{ path: string; bytes: Uint8Array }> {
  await openLab(page, 'entity=kairen', 'procedural');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '절차적 모델 GLB 내보내기' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('kairen.glb');
  const path = testInfo.outputPath('kairen.glb');
  await download.saveAs(path);
  await expect(page.locator('#lab-status')).toContainText('kairen.glb 내보냄');
  const bytes = nodeFs().readFileSync(path);
  expect(new TextDecoder().decode(bytes.subarray(0, 4)), 'GLB magic').toBe('glTF');
  return { path, bytes };
}

/** Serves `path` (or `body`) at the page's same-origin `assets/models/<name>`. */
async function serveModel(page: Page, name: string, path: string): Promise<void> {
  await page.route(`**/assets/models/${name}`, (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', path }));
}

async function screenshot(page: Page, name: string): Promise<void> {
  nodeFs().mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}` });
}

/** The swapped model maps every required bone, poses like the procedural one and carries its sockets. */
async function expectSwapped(page: Page, state: LabState, kind: string, boneSource: string): Promise<LabState> {
  expect(state.shown, `the main view shows the ${kind} model`).toBe(kind);
  expect(state.missing, 'no required humanoid bone missing').toEqual([]);
  for (const bone of REQUIRED) {
    const row = state.bones.find((b) => b.bone === bone);
    expect(row?.status, `bone ${bone}`).toBe('ok');
  }
  expect(state.bones.some((b) => b.source === boneSource), `bones mapped by '${boneSource}'`).toBe(true);
  await expect(page.locator('#lab-panel table').first().locator('tbody tr')).not.toHaveCount(0);
  // Retarget: the idle clip on both models, then the rest pose; the bone directions agree with the procedural model.
  const posed = await page.evaluate((clip) => JSON.parse(JSON.stringify((window as unknown as LabWindow).__modelLab!.preview(clip, 0.6))) as never, state.clip) as LabState;
  expect(posed.poseDifferenceDeg, 'the retargeted pose is measured').not.toBeNull();
  expect(posed.poseDifferenceDeg!, `retargeted ${state.clip} vs the procedural model (°)`).toBeLessThan(POSE_TOLERANCE_DEG);
  const socket = posed.sockets.find((s) => s.name === 'weaponR');
  expect(socket?.position, 'weaponR socket on the swapped skeleton').not.toBeNull();
  expect(socket!.position![1], 'weaponR at hand height').toBeGreaterThan(0.3 * posed.height);
  return posed;
}

// ── Scenarios ───────────────────────────────────────────────────────────────

test('GLB: export the procedural Kairen and load it back through the swap path', async ({ game, page }, testInfo) => {
  testInfo.annotations.push({ type: 'format', description: 'glb' });
  const { path } = await exportKairen(page, testInfo);
  // In memory through the glTF adapter ("내보낸 GLB 다시 불러오기").
  await page.getByRole('button', { name: '내보낸 GLB 다시 불러오기' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-lab-status', 'external', { timeout: 20_000 });
  expect((await labState(page)).shown).toBe('gltf');

  // The replacement path: the manifest override fetches assets/models/kairen.glb.
  await serveModel(page, 'kairen.glb', path);
  const state = await openLab(page, 'entity=kairen&kind=gltf&url=assets/models/kairen.glb&rig=humanoid', 'external');
  expect(state.statusText).toContain('외부 모델 표시 중 (gltf');
  const posed = await expectSwapped(page, state, 'gltf', 'auto');
  expect(state.warnings.filter((w) => /keeping the procedural model/.test(w)), 'no fallback warning').toEqual([]);
  await screenshot(page, 'model-glb.png');
  testInfo.annotations.push({ type: 'note', description: `glb: ${state.statusText}; pose Δ ${posed.poseDifferenceDeg?.toFixed(2)}°` });
  expectCleanRun(game.record);
});

/** The GLB with a VRMC_vrm 1.0 extension: meta (the VRM 1.0 license URL) and humanoid bones by node name. */
function withVrmExtension(glb: Uint8Array): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) throw new Error('the first GLB chunk is not JSON');
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as {
    nodes?: { name?: string }[]; extensionsUsed?: string[]; extensions?: Record<string, unknown>;
  };
  const humanBones: Record<string, { node: number }> = {};
  (json.nodes ?? []).forEach((n, i) => {
    if (n.name !== undefined && VRM_BONES.includes(n.name) && humanBones[n.name] === undefined) humanBones[n.name] = { node: i };
  });
  const missing = REQUIRED.filter((b) => humanBones[b] === undefined);
  if (missing.length > 0) throw new Error(`the exported GLB has no nodes for ${missing.join(', ')}`);
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), 'VRMC_vrm'])];
  json.extensions = {
    ...json.extensions,
    VRMC_vrm: {
      specVersion: '1.0',
      meta: {
        name: 'Kairen (procedural export)', version: '1', authors: ['Skyshard verification suite'],
        licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor', commercialUsage: 'personalNonProfit',
        allowRedistribution: false, modification: 'prohibited', creditNotation: 'required',
      },
      humanoid: { humanBones },
    },
  };
  let text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  text = padded;
  const rest = glb.subarray(20 + jsonLength); // the BIN chunk, unchanged
  const out = new Uint8Array(12 + 8 + text.length + rest.length);
  const w = new DataView(out.buffer);
  out.set(glb.subarray(0, 12));
  w.setUint32(8, out.length, true);
  w.setUint32(12, text.length, true);
  w.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.set(rest, 20 + text.length);
  return out;
}

test('VRM: the exported GLB with a VRMC_vrm extension loads through the VRM adapter', async ({ game, page }, testInfo) => {
  testInfo.annotations.push({ type: 'format', description: 'vrm' });
  const { bytes } = await exportKairen(page, testInfo);
  const vrmPath = testInfo.outputPath('kairen.vrm');
  nodeFs().writeFileSync(vrmPath, withVrmExtension(bytes));
  await serveModel(page, 'kairen.vrm', vrmPath);
  const state = await openLab(page, 'entity=kairen&kind=vrm&url=assets/models/kairen.vrm&rig=humanoid', 'external');
  expect(state.statusText).toContain('외부 모델 표시 중 (vrm');
  const posed = await expectSwapped(page, state, 'vrm', 'vrm');
  expect(state.warnings.filter((w) => /keeping the procedural model/.test(w)), 'no fallback warning').toEqual([]);
  await screenshot(page, 'model-vrm.png');
  testInfo.annotations.push({ type: 'note', description: `vrm: ${state.statusText}; pose Δ ${posed.poseDifferenceDeg?.toFixed(2)}°` });
  expectCleanRun(game.record);
});

test('FBX: a CC0 sample loads through the FBX adapter', async ({ game, page }, testInfo) => {
  testInfo.annotations.push({ type: 'format', description: 'fbx' });
  const fs = nodeFs();
  const sample = fs.existsSync(FBX_DIR) ? fs.readdirSync(FBX_DIR).filter((n) => n.toLowerCase().endsWith('.fbx')).sort()[0] : undefined;
  test.skip(sample === undefined, 'FBX 샘플 없음 (tests/fixtures/models/*.fbx에 CC0 샘플을 두면 검증)');
  await serveModel(page, 'sample.fbx', `${FBX_DIR}/${sample!}`);
  const state = await openLab(page, 'entity=kairen&kind=fbx&url=assets/models/sample.fbx&rig=humanoid', 'external');
  expect(state.shown).toBe('fbx');
  expect(state.missing, 'no required humanoid bone missing').toEqual([]);
  await screenshot(page, 'model-fbx.png');
  testInfo.annotations.push({ type: 'note', description: `fbx ${sample!}: ${state.statusText}` });
  expectCleanRun(game.record);
});

test('corrupt file: the procedural model stays, with one warning', async ({ game, page }, testInfo) => {
  testInfo.annotations.push({ type: 'format', description: 'corrupt' });
  const { bytes } = await exportKairen(page, testInfo);
  // Keep the GLB header, destroy the JSON chunk: the glTF adapter cannot parse it.
  const broken = new Uint8Array(bytes);
  broken.fill(0x00, 20, Math.min(broken.length, 20 + 256));
  const path = testInfo.outputPath('kairen-corrupt.glb');
  nodeFs().writeFileSync(path, broken);
  await serveModel(page, 'kairen.glb', path);
  const state = await openLab(page, 'entity=kairen&kind=gltf&url=assets/models/kairen.glb&rig=humanoid', 'fallback');
  expect(state.statusText).toContain('불러오기 실패: 절차적 모델 유지');
  expect(state.shown, 'the procedural model is shown').toBe('procedural');
  expect(state.bones.filter((b) => b.status === 'ok').map((b) => b.source), 'procedural skeleton').toContain('procedural');
  const fallback = state.warnings.filter((w) => /keeping the procedural model/.test(w));
  expect(fallback, 'exactly one warning').toHaveLength(1);
  expect(state.warnings, 'nothing else warned').toHaveLength(1);
  await expect(page.locator('#lab-warnings')).toContainText('keeping the procedural model');
  await page.waitForTimeout(1_000);
  expect((await labState(page)).warnings, 'the warning is not repeated').toHaveLength(1);
  await screenshot(page, 'model-corrupt.png');
  testInfo.annotations.push({ type: 'note', description: `corrupt: ${fallback[0] ?? ''}` });
  expectCleanRun(game.record);
});
