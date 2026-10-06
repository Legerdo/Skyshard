/*
 * Full playthrough (tasks 24.5, 24.6; design "입력 전용 완주 봇", "완주 판정", "스크린샷 (12 장면)", "검토 체크리스트";
 * Req 42.3, 42.4, 42.6–42.8, 2.1, 2.2, 2.8, 6.12): the input-only bot (tests/e2e/bot) plays the static build from the
 * Title Screen through New Game, Main_Quest stages ms1–ms10 and the Victory Screen with keyboard and mouse events
 * only, observing the game through the read-only Test_Harness. No `?debug=1`, no debug feature.
 *
 * Outputs (written even when the run fails, for the analysis):
 * - test-results/screenshots/NN-name.png: the 12 scenes (the three Challenge_Areas separately: 14 files) and
 *   test-results/screenshots/review.md with the 8-item checklist per scene;
 * - test-results/playthrough-metrics.json: stage times against the design's time budget, Caelith's per-Phase times,
 *   recoveries / 끼임 해제, navigation stalls, the camera within 1 m of the character, the order checks.
 * Judgement (design 완주 판정): Title → ms1 … ms10 in order, Skyshards 1 → 2 → 3, Phases 1 → 2 → 3, Victory; a switch
 * and a Reaction before Skyshard 1, climb and glide modes seen; `debugUsed === false` throughout and no page URL
 * with `debug`; 0 console errors, 0 page errors, 0 external requests.
 */
import { buildTerrain } from '../../src/world/terrain';
import { Bot } from './bot/bot';
import { isClimbMode } from './bot/harness';
import {
  BOSS_TARGET_SEC, MAIN_STAGES, Metrics, PHASE_TARGET_SEC, SCENES, TOTAL_TARGET_SEC, env, nodeFs, reviewMarkdown,
} from './bot/metrics';
import { REVIEW_NOTES, REVIEW_SUMMARY } from './bot/reviewNotes';
import { playRoute } from './bot/route';
import { expect, test } from './fixtures';

/** src/main.ts WORLD_SEED: the terrain every session uses (a New Game's save seed too). */
const WORLD_SEED = 20240601;
const OUT = 'test-results';
const SHOTS = `${OUT}/screenshots`;
const SAVES = `${OUT}/saves`;

// A 20–30 minute trace is too large to keep, and other e2e runs may clear test-results/playwright under it.
test.use({ trace: 'off' });

test('input-only bot plays Title → New Game → ms1 … ms10 → Victory', async ({ game, page }) => {
  const fs = nodeFs();
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const name of fs.readdirSync(SHOTS)) if (name.endsWith('.png') || name === 'review.md') fs.rmSync(`${SHOTS}/${name}`, { force: true });

  const terrain = buildTerrain(WORLD_SEED);
  const bot = new Bot(page, terrain);
  bot.tracing = env('SKYSHARD_BOT_TRACE') === '1';
  const metrics = new Metrics(page, terrain, SHOTS);
  metrics.attach(bot.h);
  bot.hooks = {
    stall: (label, s) => metrics.stall(label, s),
    unstuck: (label, s) => metrics.unstuck(label, s),
    flush: () => metrics.flush(),
  };
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) metrics.urls.add(frame.url());
  });
  const log: string[] = [];
  const started = Date.now();
  let seed = WORLD_SEED;
  let failure: unknown = null;
  let gpu = '';
  // Development runs only (the judged run is from New Game): SKYSHARD_BOT_FROM=msN continues from the save this spec
  // copied when a normal-play run reached msN (test-results/saves/msN.json); SKYSHARD_BOT_STOP=msN ends after msN.
  const from = env('SKYSHARD_BOT_FROM');
  const stopAfter = env('SKYSHARD_BOT_STOP');
  if (from !== undefined) {
    const saved = JSON.parse(fs.readFileSync(`${SAVES}/${from}.json`, 'utf8')) as Record<string, string>;
    await page.addInitScript((entries) => {
      if (sessionStorage.getItem('bot.seeded') !== null) return;
      sessionStorage.setItem('bot.seeded', '1');
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    }, saved);
  }
  try {
    gpu = await game.gpu();
    await game.open();
    await bot.h.ready();
    await bot.h.poll(); // the Title Screen, in the record
    await page.getByRole('button', { name: from === undefined ? '새로 시작' : '이어하기', exact: true }).click();
    await bot.keys.afterUiClick();
    await bot.waitUntil('play start', (s) => s.screens[0] === 'gameplay' && s.mainStage !== '' && (from !== undefined || s.mainStage === 'ms1'), 90_000);
    // The save's seed (read only; design: the Observatory order from `skyshard.save`).
    const saved = await page.evaluate(() => localStorage.getItem('skyshard.save'));
    const parsed = saved === null ? null : (JSON.parse(saved) as { state?: { seed?: unknown } });
    if (typeof parsed?.state?.seed === 'number') seed = parsed.state.seed;
    await playRoute(bot, {
      seed,
      ...(stopAfter === undefined ? {} : { stopAfter }),
      onStage: async (stage) => {
        // Keep a copy of the game's own save at each stage start (read only), for development restarts.
        await page.waitForTimeout(1200);
        const entries = await page.evaluate(() => {
          const out: Record<string, string> = {};
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k !== null && k.startsWith('skyshard.')) out[k] = localStorage.getItem(k) ?? '';
          }
          return out;
        });
        fs.mkdirSync(SAVES, { recursive: true });
        fs.writeFileSync(`${SAVES}/${stage}.json`, JSON.stringify(entries));
        writeResults('running');
      },
      onSegment: (stage, segment) => {
        const s = bot.s;
        const line = `[bot] ${((Date.now() - started) / 1000).toFixed(0)} s (sim ${s.simTime.toFixed(0)}): ${stage} ${segment} — ${s.objective?.objectiveId ?? '-'} at ${bot.where(s)}`;
        log.push(line);
        console.info(line);
      },
    });
  } catch (e) {
    failure = e;
  } finally {
    await bot.keys.releaseAll().catch(() => undefined);
    writeResults(failure === null ? 'completed' : 'failed');
  }
  if (failure !== null) throw failure;
  judge();

  /** playthrough-metrics.json and review.md (also at every stage start, so a killed run leaves its data). */
  function writeResults(state: 'running' | 'completed' | 'failed'): void {
    const s = bot.h.last;
    const stages = metrics.stageTimes();
    const done = stages.filter((t) => t.seconds !== null);
    const total = done.length === MAIN_STAGES.length ? done.reduce((a, t) => a + (t.seconds ?? 0), 0) : null;
    const boss = metrics.bossTimes();
    const counts = s?.recovery.counts ?? {};
    const safePosition = Object.entries(counts).filter(([reason]) => reason !== 'lift' && reason !== 'manual').reduce((a, [, n]) => a + n, 0);
    const result = {
      generatedAt: new Date().toISOString(),
      result: state,
      failure: failure === null ? null : { message: String((failure as Error).message ?? failure), label: bot.label, at: s === null ? null : bot.where(s) },
      gpu,
      seed,
      wallClockSeconds: (Date.now() - started) / 1000,
      lastSimTime: metrics.lastSimTime(),
      stages,
      total: {
        seconds: total,
        targetSeconds: TOTAL_TARGET_SEC,
        inRange: total === null ? null : total >= TOTAL_TARGET_SEC[0] && total <= TOTAL_TARGET_SEC[1],
        budgetSeconds: stages.reduce((a, t) => a + t.budgetSeconds, 0),
      },
      boss: {
        ...boss,
        targetSeconds: BOSS_TARGET_SEC,
        phaseTargetSeconds: PHASE_TARGET_SEC,
        inRange: boss.totalSeconds === null ? null : boss.totalSeconds >= BOSS_TARGET_SEC[0] && boss.totalSeconds <= BOSS_TARGET_SEC[1],
        retries: bot.wipes.filter((w) => w.bossPhase !== null).length,
      },
      recoveries: { byReason: counts, safePosition, unstuck: metrics.unstucks.length, unstuckList: metrics.unstucks },
      stalls: { count: metrics.stalls.length, list: metrics.stalls },
      cameraNear: {
        episodes: metrics.cameraNear.count, samples: metrics.cameraNear.samples,
        minDistance: Number.isFinite(metrics.cameraNear.min) ? metrics.cameraNear.min : null, list: metrics.cameraNearList,
      },
      cameraBelowTerrain: { episodes: metrics.cameraBelow.count, samples: metrics.cameraBelow.samples },
      wipes: bot.wipes,
      retries: bot.retries,
      order: { stages: metrics.stageOrder, skyshards: metrics.skyshardOrder, bossPhases: metrics.phaseOrder, titleSeen: metrics.titleSeen, victorySeen: metrics.victorySeen },
      required: {
        switchesBeforeShard1: metrics.switchesBeforeShard1,
        reactionsBeforeShard1: metrics.reactionsBeforeShard1,
        climbSeen: [...metrics.modesSeen].some(isClimbMode),
        glideSeen: metrics.modesSeen.has('glide'),
        switches: metrics.switches,
        reactions: metrics.reactions,
      },
      normalPlay: { debugUsedEver: metrics.debugUsedEver, urls: [...metrics.urls] },
      errors: { console: game.record.consoleErrors, page: game.record.pageErrors, external: game.record.externalRequests },
      screenshots: metrics.shots.map((x) => x.file),
      polls: bot.h.polls,
      log,
    };
    fs.writeFileSync(`${OUT}/playthrough-metrics.json`, JSON.stringify(result, null, 2));
    const verdict = state === 'completed' ? '완주' : state === 'running' ? '진행 중' : `실패 (${result.failure?.label ?? ''}: ${result.failure?.message ?? ''})`;
    const header = [
      `- 실행: ${result.generatedAt}, ${verdict}`,
      `- GPU: ${gpu}; 실시간 ${result.wallClockSeconds.toFixed(0)} s, 메인 진행 ${total === null ? '-' : `${(total / 60).toFixed(1)}분`}; 촬영 ${metrics.shots.length}/${SCENES.length}장`,
    ];
    fs.writeFileSync(`${SHOTS}/review.md`, reviewMarkdown(metrics.shots, header, REVIEW_NOTES, REVIEW_SUMMARY));
  }

  /** Design 완주 판정. */
  function judge(): void {
    const m = metrics;
    expect(m.titleSeen, 'the Title Screen was shown first').toBe(true);
    expect(m.stageOrder, 'mainStage ms1 … ms10 in order').toEqual([...MAIN_STAGES]);
    expect(m.skyshardOrder, 'Skyshards 0 → 1 → 2 → 3').toEqual([0, 1, 2, 3]);
    expect(m.phaseOrder.filter((p, i, a) => a.indexOf(p) === i), 'Caelith Phases 1 → 2 → 3').toEqual([1, 2, 3]);
    expect(m.victorySeen, 'the Victory Screen was shown').toBe(true);
    expect(m.debugUsedEver, 'debugUsed stayed false').toBe(false);
    expect([...m.urls].filter((u) => u.includes('debug')), 'no page URL with debug').toEqual([]);
    expect(game.record.pageErrors, 'uncaught page errors').toEqual([]);
    expect(game.record.consoleErrors, 'console errors').toEqual([]);
    expect(game.record.externalRequests, 'external requests').toEqual([]);
    expect.soft(m.switchesBeforeShard1, 'a character switch before Skyshard 1').toBeGreaterThan(0);
    expect.soft(m.reactionsBeforeShard1, 'a Reaction before Skyshard 1').toBeGreaterThan(0);
    expect.soft([...m.modesSeen].some(isClimbMode), "player.mode 'climb' seen").toBe(true);
    expect.soft(m.modesSeen.has('glide'), "player.mode 'glide' seen").toBe(true);
    expect.soft(m.shots.map((x) => x.file).sort(), '14 scene screenshots').toEqual(SCENES.map((x) => x.file).sort());
  }
});
