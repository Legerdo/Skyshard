/*
 * Playthrough measurements (tasks 24.5, 24.6; design "스크린샷 (12 장면)", "검토 체크리스트", "메인 진행 시간 예산";
 * Req 42.7, 42.8, 2.2, 2.8, 6.12): everything is derived from the harness polls and events.
 * - Stage times (sim seconds from the first poll showing a stage to its 'stageCompleted' event) against the design's
 *   time budget; the boss per-Phase times (cin_boss_intro end → 'phase' events → Caelith dead).
 * - Recoveries by reason (Safe_Position returns vs lift fades), the bot's Pause → 끼임 해제 uses, navigation stalls
 *   (5 s without getting closer to the goal), the render camera within 1 m of the character's shoulder, the camera
 *   below the terrain surface.
 * - The 12 scenes (14 files): each is shot the first poll its harness condition holds; review.md gets the 8-item
 *   checklist per scene with the automatic judgements filled in (camera vs terrain) and the visual ones to review.
 */
import type { Page } from '@playwright/test';
import { LOCATIONS } from '../../../src/data/worldLayout';
import type { TerrainField } from '../../../src/world/terrain';
import { flat, free, type BotEvent, type Harness, type Snap } from './harness';

// @types/node is not installed (tests/unit/helpers/importScan.ts): the few Node APIs are typed locally.
interface NodeFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): void;
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: 'utf8'): string;
  rmSync(path: string, options?: { force?: boolean }): void;
  writeFileSync(path: string, data: string): void;
}
export function nodeFs(): NodeFs {
  const p = (globalThis as unknown as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  if (typeof p?.getBuiltinModule !== 'function') throw new Error('node:fs unavailable (Node >= 20.16 needed)');
  return p.getBuiltinModule('node:fs') as NodeFs;
}

/** An environment variable of the test process (undefined when unset). */
export function env(name: string): string | undefined {
  return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

/** Design "메인 진행 시간 예산" (minutes of a first, main-path-only play). */
export const STAGE_BUDGET_MIN: Readonly<Record<string, number>> = {
  ms1: 2.5, ms2: 3.0, ms3: 4.0, ms4: 2.5, ms5: 3.5, ms6: 2.5, ms7: 3.5, ms8: 1.5, ms9: 4.5, ms10: 1.0,
};
export const MAIN_STAGES = ['ms1', 'ms2', 'ms3', 'ms4', 'ms5', 'ms6', 'ms7', 'ms8', 'ms9', 'ms10'] as const;
/** Req 2.2: a first main-path play takes 20–30 min; Req 6.12: Caelith 3–6 min, each Phase 60–150 s. */
export const TOTAL_TARGET_SEC = [20 * 60, 30 * 60] as const;
export const BOSS_TARGET_SEC = [180, 360] as const;
export const PHASE_TARGET_SEC = [60, 150] as const;

/** Design "검토 체크리스트" (Req 42.8), in order. */
export const CHECKLIST = [
  '빈 지형', '기본 도형 나열', '구별되지 않는 캐릭터', '반복 오브젝트', 'Landmark 없는 Region', '기본 HTML 스타일 UI',
  'VFX로 판독 불가능한 전투', '지형을 통과한 카메라',
] as const;

const PLAZA = { x: LOCATIONS.thistlewick.x, z: LOCATIONS.thistlewick.z };
const BREEZEWATCH = { x: LOCATIONS.breezewatch.x, z: LOCATIONS.breezewatch.z };
const CAMP_CENTERS: Readonly<Record<string, { x: number; z: number }>> = {
  camp_verdant_1: { x: -170, z: 360 }, camp_verdant_2: { x: -330, z: 60 }, camp_ember_1: { x: 150, z: 330 },
  camp_ember_2: { x: 300, z: 250 }, camp_azure_1: { x: -120, z: -230 }, camp_azure_2: { x: 60, z: -300 },
};

interface SceneDef {
  readonly file: string;
  /** Design scene number and name. */
  readonly scene: number;
  readonly title: string;
  readonly condition: string;
  readonly when: (s: Snap, m: Metrics) => boolean;
}

const objIs = (s: Snap, ...ids: string[]): boolean => ids.includes(s.objective?.objectiveId ?? '');

export const SCENES: readonly SceneDef[] = [
  { file: '01-thistlewick.png', scene: 1, title: '시작 마을', condition: 'ms1 시작 직후 Thistlewick 광장',
    when: (s) => s.mainStage === 'ms1' && free(s) && flat(s.player.pos, PLAZA) < 45 },
  { file: '02-vista-verdant.png', scene: 2, title: '첫 Region 전경', condition: 'vista_verdant 도달 (풍차 꼭대기)',
    when: (s) => free(s) && objIs(s, 'ms2_wren', 'ms2_elderbough') && s.player.pos.y > 60 },
  { file: '03-glide.png', scene: 3, title: '높은 곳 활강', condition: "player.mode === 'glide', 지면 위 20 m 이상",
    when: (s, m) => s.player.mode === 'glide' && m.clearance(s) >= 20 },
  { file: '04-climb.png', scene: 4, title: '등반', condition: "player.mode === 'climb', Breezewatch 절벽 (없으면 첫 등반)",
    when: (s) => s.player.mode === 'climb' && (flat(s.player.pos, BREEZEWATCH) < 80 || !['ms1', 'ms2'].includes(s.mainStage)) },
  { file: '05-switch-combat.png', scene: 5, title: '2명 이상 교체 전투', condition: '교체 직후 inCombat',
    when: (s, m) => s.inCombat && free(s) && s.party.filter((p) => p.joined).length >= 2 && m.sinceSwitch() < 1500 },
  { file: '06-reaction.png', scene: 6, title: 'Reaction', condition: 'recentReactions에 새 항목',
    when: (s, m) => free(s) && m.sinceReaction() < 900 },
  { file: '07-enemy-camp.png', scene: 7, title: 'Enemy_Camp', condition: 'Enemy_Camp 진입 (중심 18 m 이내, 적 보임)',
    when: (s, m) => free(s) && m.nearCamp(s, 18) },
  // Shot 0.8 s after the entry cinematic ends: the render camera's 0.4 s blend back to the follow camera is over.
  { file: '08-challenge-hollowroot.png', scene: 8, title: 'Challenge_Area: Hollowroot Shrine', condition: 'cin_area_hollowroot 종료 직후 (0.8 s)',
    when: (s, m) => free(s) && m.endedAgo('cin_area_hollowroot') > 800 },
  { file: '08-challenge-cinderspire.png', scene: 8, title: 'Challenge_Area: Cinderspire', condition: 'cin_area_cinderspire 종료 직후 (0.8 s)',
    when: (s, m) => free(s) && m.endedAgo('cin_area_cinderspire') > 800 },
  { file: '08-challenge-observatory.png', scene: 8, title: 'Challenge_Area: Starfall Observatory', condition: 'cin_area_observatory 종료 직후 (0.8 s)',
    when: (s, m) => free(s) && m.endedAgo('cin_area_observatory') > 800 },
  { file: '09-azure-highlands.png', scene: 9, title: '세 번째 Region', condition: 'gate_azure 통과 후 Azure Highlands',
    when: (s) => free(s) && s.mainStage === 'ms6' && !objIs(s, 'ms6_pass') },
  { file: '10-astral-sanctum.png', scene: 10, title: 'Astral Sanctum', condition: '제단 활성화 후 sanctum_hall 도달',
    when: (s) => free(s) && s.altarActivated && objIs(s, 'ms9_mural') },
  { file: '11-caelith-phase2.png', scene: 11, title: 'Caelith', condition: 'boss.phase 2, Starshell 활성',
    when: (s) => free(s) && s.boss !== null && s.boss.phase === 2 && s.boss.starshell !== null && s.boss.state !== 'transition' },
  { file: '12-victory.png', scene: 12, title: 'Victory Screen', condition: 'Victory 화면 표시',
    when: (s, m) => s.screen === 'victory' && m.sinceScreen('victory') > 900 },
];

export interface ShotRecord {
  readonly file: string;
  readonly scene: number;
  readonly title: string;
  readonly condition: string;
  readonly simTime: number;
  readonly stage: string;
  readonly objective: string;
  readonly pos: { x: number; y: number; z: number };
  readonly mode: string;
  readonly activeCharacter: string;
  readonly cameraDistance: number | null;
  /** Camera height above the terrain surface under it (m); negative = below it. */
  readonly cameraClearance: number | null;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly fps: number;
  readonly enemies: number;
}

interface StageTime {
  simStart: number;
  wallStart: number;
  simEnd: number | null;
  wallEnd: number | null;
}

export class Metrics {
  readonly shots: ShotRecord[] = [];
  readonly stalls: { t: number; label: string; pos: string }[] = [];
  readonly unstucks: { t: number; label: string }[] = [];
  /** mainStage values in the order first seen, screens seen, skyshard counts seen, boss Phases seen. */
  readonly stageOrder: string[] = [];
  readonly skyshardOrder: number[] = [];
  readonly phaseOrder: number[] = [];
  readonly modesSeen = new Set<string>();
  switches = 0;
  /** Character switches and Reactions before Skyshard 1 (design 완주 판정 필수 조작). */
  switchesBeforeShard1 = 0;
  reactionsBeforeShard1 = 0;
  reactions = 0;
  cameraNear = { count: 0, samples: 0, min: Infinity };
  /** Where the camera came within 1 m of the character (first 40 episodes). */
  readonly cameraNearList: { t: number; stage: string; objective: string; pos: string; distance: number }[] = [];
  cameraBelow = { count: 0, samples: 0 };
  debugUsedEver = false;
  titleSeen = false;
  victorySeen = false;
  readonly urls = new Set<string>();
  private readonly stages = new Map<string, StageTime>();
  /** Cinematic id → wall time it ended. */
  private readonly endedCinematics = new Map<string, number>();
  private readonly pending: SceneDef[] = [];
  private readonly taken = new Set<string>();
  private lastActive: string | null = null;
  private switchAt = -Infinity;
  private reactionAt = -Infinity;
  private readonly screenSince = new Map<string, number>();
  private nearNow = false;
  private belowNow = false;
  private bossStart: number | null = null;
  private bossEnd: number | null = null;
  private readonly phaseStart = new Map<number, number>();
  private lastSim = 0;
  readonly wallStart = Date.now();

  constructor(
    private readonly page: Page,
    private readonly terrain: TerrainField,
    private readonly shotDir: string,
  ) {}

  attach(h: Harness): void {
    h.onPoll((s, fresh) => this.observe(s, fresh));
  }

  /** Height of the character's feet above the terrain surface (m). */
  clearance(s: Snap): number {
    return s.player.pos.y - this.terrain.heightAt(s.player.pos.x, s.player.pos.z);
  }

  sinceSwitch(): number {
    return Date.now() - this.switchAt;
  }

  sinceReaction(): number {
    return Date.now() - this.reactionAt;
  }

  sinceScreen(id: string): number {
    const at = this.screenSince.get(id);
    return at === undefined ? -1 : Date.now() - at;
  }

  /** Wall ms since cinematic `id` ended (−1 when it has not). */
  endedAgo(cinematicId: string): number {
    const at = this.endedCinematics.get(cinematicId);
    return at === undefined ? -1 : Date.now() - at;
  }

  nearCamp(s: Snap, radius: number): boolean {
    for (const [camp, c] of Object.entries(CAMP_CENTERS)) {
      if (flat(s.player.pos, c) > radius) continue;
      if (s.enemies.some((e) => e.camp === camp && e.distance < 30)) return true;
    }
    return false;
  }

  stall(label: string, s: Snap): void {
    const p = s.player.pos;
    this.stalls.push({ t: s.simTime, label, pos: `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})` });
  }

  unstuck(label: string, s: Snap): void {
    this.unstucks.push({ t: s.simTime, label });
  }

  private observe(s: Snap, fresh: readonly BotEvent[]): void {
    this.lastSim = s.simTime;
    if (s.debugUsed) this.debugUsedEver = true;
    if (s.screen === 'title') this.titleSeen = true;
    for (const id of new Set(s.screens)) if (!this.screenSince.has(id)) this.screenSince.set(id, Date.now());
    for (const id of [...this.screenSince.keys()]) if (!s.screens.includes(id)) this.screenSince.delete(id);
    if (s.screen === 'victory') this.victorySeen = true;
    if (s.mainStage !== '' && s.mainStage !== 'done' && this.stageOrder[this.stageOrder.length - 1] !== s.mainStage) {
      this.stageOrder.push(s.mainStage);
      if (!this.stages.has(s.mainStage)) this.stages.set(s.mainStage, { simStart: s.simTime, wallStart: Date.now(), simEnd: null, wallEnd: null });
    }
    if (this.skyshardOrder[this.skyshardOrder.length - 1] !== s.skyshards) this.skyshardOrder.push(s.skyshards);
    this.modesSeen.add(s.player.mode);
    if (s.screens[0] === 'gameplay') {
      if (this.lastActive !== null && this.lastActive !== s.activeCharacter) {
        this.switches++;
        if (s.skyshards === 0) this.switchesBeforeShard1++;
        this.switchAt = Date.now();
      }
      this.lastActive = s.activeCharacter;
    }
    for (const e of fresh) {
      if (e.kind === 'reaction') {
        this.reactions++;
        if (s.skyshards === 0) this.reactionsBeforeShard1++;
        this.reactionAt = Date.now();
      } else if (e.kind === 'cinematic' && e.data['event'] === 'ended') {
        const id = String(e.data['cinematicId']);
        if (!this.endedCinematics.has(id)) this.endedCinematics.set(id, Date.now());
        if (id === 'cin_boss_intro' && this.bossStart === null) {
          this.bossStart = e.t;
          this.phaseStart.set(1, e.t);
        }
      } else if (e.kind === 'phase') {
        const to = Number(e.data['to']);
        if (!this.phaseStart.has(to)) this.phaseStart.set(to, e.t);
      } else if (e.kind === 'objective' && e.data['event'] === 'stageCompleted') {
        const stage = this.stages.get(String(e.data['stageId']));
        if (stage !== undefined && stage.simEnd === null) {
          stage.simEnd = e.t;
          stage.wallEnd = Date.now();
        }
      }
    }
    if (s.boss !== null) {
      if (this.phaseOrder[this.phaseOrder.length - 1] !== s.boss.phase) this.phaseOrder.push(s.boss.phase);
      if (s.boss.state === 'dead' && this.bossEnd === null) this.bossEnd = s.simTime;
    }
    // The render camera near the character / under the ground, while play is on screen (not in cinematics).
    if (s.camera !== null && s.screens[0] === 'gameplay' && s.cinematic === null && s.screen === 'gameplay') {
      this.cameraNear.samples++;
      this.cameraNear.min = Math.min(this.cameraNear.min, s.camera.distance);
      const near = s.camera.distance < 1;
      if (near && !this.nearNow) {
        this.cameraNear.count++;
        const p = s.player.pos;
        if (this.cameraNearList.length < 40) {
          this.cameraNearList.push({
            t: s.simTime, stage: s.mainStage, objective: s.objective?.objectiveId ?? '', distance: s.camera.distance,
            pos: `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) ${s.player.mode}`,
          });
        }
      }
      this.nearNow = near;
      this.cameraBelow.samples++;
      const below = s.camera.pos.y < this.terrain.heightAt(s.camera.pos.x, s.camera.pos.z) - 0.05;
      if (below && !this.belowNow) this.cameraBelow.count++;
      this.belowNow = below;
    }
    for (const scene of SCENES) {
      if (this.taken.has(scene.file) || !scene.when(s, this)) continue;
      this.taken.add(scene.file);
      this.pending.push(scene);
      this.shots.push(this.record(scene, s));
    }
  }

  private record(scene: SceneDef, s: Snap): ShotRecord {
    const cam = s.camera;
    return {
      file: scene.file, scene: scene.scene, title: scene.title, condition: scene.condition, simTime: s.simTime, stage: s.mainStage,
      objective: s.objective?.objectiveId ?? '', pos: { ...s.player.pos }, mode: s.player.mode, activeCharacter: s.activeCharacter,
      cameraDistance: cam?.distance ?? null,
      cameraClearance: cam === null ? null : cam.pos.y - this.terrain.heightAt(cam.pos.x, cam.pos.z),
      drawCalls: s.drawCalls, triangles: s.triangles, fps: s.fps, enemies: s.enemies.length,
    };
  }

  /** Takes the screenshots that came due (called by the bot before its next poll). */
  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      const scene = this.pending.shift();
      if (scene === undefined) break;
      await this.page.screenshot({ path: `${this.shotDir}/${scene.file}` });
    }
  }

  // ── Results ───────────────────────────────────────────────────────────────

  stageTimes(): { id: string; seconds: number | null; budgetSeconds: number; overBudget: boolean | null; wallSeconds: number | null }[] {
    return MAIN_STAGES.map((id) => {
      const t = this.stages.get(id);
      const seconds = t === undefined || t.simEnd === null ? null : t.simEnd - t.simStart;
      const wallSeconds = t === undefined || t.wallEnd === null ? null : (t.wallEnd - t.wallStart) / 1000;
      const budgetSeconds = (STAGE_BUDGET_MIN[id] ?? 0) * 60;
      return { id, seconds, budgetSeconds, overBudget: seconds === null ? null : seconds > budgetSeconds, wallSeconds };
    });
  }

  bossTimes(): { totalSeconds: number | null; phases: { phase: number; seconds: number | null; inRange: boolean | null }[] } {
    const end = this.bossEnd;
    const phases = [1, 2, 3].map((phase) => {
      const start = this.phaseStart.get(phase);
      const next = phase < 3 ? this.phaseStart.get(phase + 1) : end ?? undefined;
      const seconds = start === undefined || next === undefined || next === null ? null : next - start;
      return { phase, seconds, inRange: seconds === null ? null : seconds >= PHASE_TARGET_SEC[0] && seconds <= PHASE_TARGET_SEC[1] };
    });
    return { totalSeconds: this.bossStart === null || end === null ? null : end - this.bossStart, phases };
  }

  lastSimTime(): number {
    return this.lastSim;
  }

  firstStageSim(): number | null {
    return this.stages.get('ms1')?.simStart ?? null;
  }
}

// ── review.md ───────────────────────────────────────────────────────────────

/** The per-scene 8-item checklist (design "검토 체크리스트"); `visual` fills the items judged from the images. */
export function reviewMarkdown(
  shots: readonly ShotRecord[],
  header: readonly string[],
  visual: Readonly<Record<string, Partial<Record<(typeof CHECKLIST)[number], string>>>> = {},
  summary: readonly string[] = [],
): string {
  const lines: string[] = ['# 완주 스크린샷 검토 (test-results/screenshots)', '', ...header, ''];
  lines.push(
    `점검 항목(8): ${CHECKLIST.join(' · ')}. "지형을 통과한 카메라"는 카메라 높이와 그 아래 지면 높이로 자동 판정하고, 나머지는 이미지를 보고 판정한다 (tests/e2e/bot/reviewNotes.ts; 판정: 통과 · 경미 · 결함 · 해당 없음).`,
    '',
    ...summary,
  );
  const byFile = new Map(shots.map((s) => [s.file, s]));
  for (const scene of SCENES) {
    const shot = byFile.get(scene.file);
    lines.push(`## ${String(scene.scene).padStart(2, '0')} ${scene.title} — \`${scene.file}\``, '');
    if (shot === undefined) {
      lines.push(`- 미촬영: 조건(${scene.condition})이 실행 중 충족되지 않았다.`, '');
      continue;
    }
    const p = shot.pos;
    lines.push(
      `- 조건: ${scene.condition}; sim ${shot.simTime.toFixed(1)} s, ${shot.stage}/${shot.objective}, ${shot.activeCharacter} ${shot.mode} at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`,
      `- 카메라 거리 ${shot.cameraDistance?.toFixed(2) ?? '-'} m, 지면 위 ${shot.cameraClearance?.toFixed(2) ?? '-'} m; draw calls ${shot.drawCalls}, triangles ${shot.triangles}, fps ${shot.fps.toFixed(0)}, 60 m 안 적 ${shot.enemies}`,
      '',
      '| 항목 | 판정 | 근거 |',
      '|---|---|---|',
    );
    const own = visual[scene.file] ?? {};
    for (const item of CHECKLIST) {
      if (item === '지형을 통과한 카메라') {
        const c = shot.cameraClearance;
        lines.push(`| ${item} | ${c === null ? '미판정' : c < -0.05 ? '결함' : '통과(자동)'} | 카메라가 지면 위 ${c?.toFixed(2) ?? '-'} m |`);
        continue;
      }
      const note = own[item];
      lines.push(`| ${item} | ${note === undefined ? '검토 필요' : note.split('|')[0]?.trim() ?? ''} | ${note === undefined ? '' : note.split('|').slice(1).join('|').trim()} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
