/*
 * Time-of-day presets (design.md "하늘·조명·시간대"; Req 8.10, 4.7, 6.7). Six looks driven by progress, not by a
 * clock: the Skyshards held pick morning → noon → afternoon → dusk, the activated Resonance_Altar the starlit night and
 * the completed game the sunrise, so a loaded save shows its look at once. The Caelith arena overrides them (dusk in
 * Phases 1–2, the starlit night from the Final Phase).
 *
 * Colours are sRGB hex; the renderer converts them to linear once and blends there. Directions: +x east, −z north,
 * y up; the azimuth is a compass bearing (0 north, 90 east). Pure data and selection: no three.js or DOM.
 */

export const TIME_OF_DAY_IDS = ['morning', 'noon', 'afternoon', 'dusk', 'starNight', 'sunrise'] as const;
export type TimeOfDayId = (typeof TIME_OF_DAY_IDS)[number];

export const TIME_OF_DAY_NAMES: Readonly<Record<TimeOfDayId, string>> = {
  morning: '아침',
  noon: '한낮',
  afternoon: '오후',
  dusk: '황혼',
  starNight: '별빛 밤',
  sunrise: '일출',
};

export interface TimeOfDayPreset {
  /** Key light (sun, or the moon at night) height above the horizon (deg) and compass bearing (deg). */
  readonly sunElevationDeg: number;
  readonly sunAzimuthDeg: number;
  readonly sunColor: number;
  readonly sunIntensity: number;
  /** The dome's disc is the moon (paler, smaller glow) instead of the sun. */
  readonly moon: boolean;
  readonly skyTop: number;
  readonly skyHorizon: number;
  /** Fog colour before the Region fog tint; the dome's horizon haze uses the same final colour. */
  readonly fogColor: number;
  readonly fogNear: number;
  readonly fogFar: number;
  readonly hemiSky: number;
  readonly hemiGround: number;
  readonly hemiIntensity: number;
  /** Cloud band cover 0–1. */
  readonly clouds: number;
  /** Star field brightness 0–1. */
  readonly stars: number;
  /** Fresnel rim strength of the shared toon materials. */
  readonly rimStrength: number;
}

/*
 * Design table values (elevation, sun colour, sky top / horizon, fog) plus the lighting the table leaves open. The
 * starlit night keeps its hemisphere fill at more than 60 % of noon, in intensity and in lit sky luminance, so the
 * night reads clearly under the moon (design "별빛 밤도 어둡게 가라앉히지 않는다").
 */
export const TIME_OF_DAY_PRESETS: Readonly<Record<TimeOfDayId, TimeOfDayPreset>> = {
  morning: {
    sunElevationDeg: 18, sunAzimuthDeg: 105, sunColor: 0xffe4bc, sunIntensity: 2.5, moon: false,
    skyTop: 0x6db6f2, skyHorizon: 0xffe8cc, fogColor: 0xd2e6f4, fogNear: 160, fogFar: 1450,
    hemiSky: 0xd6e8fa, hemiGround: 0x7a664c, hemiIntensity: 1.35, clouds: 0.55, stars: 0, rimStrength: 0.34,
  },
  noon: {
    sunElevationDeg: 62, sunAzimuthDeg: 165, sunColor: 0xfff8e8, sunIntensity: 2.9, moon: false,
    skyTop: 0x3d9bf2, skyHorizon: 0xc4e6ff, fogColor: 0xd8edff, fogNear: 200, fogFar: 1600,
    hemiSky: 0xddeeff, hemiGround: 0x7a6a50, hemiIntensity: 1.4, clouds: 0.5, stars: 0, rimStrength: 0.3,
  },
  afternoon: {
    sunElevationDeg: 36, sunAzimuthDeg: 235, sunColor: 0xffe3a8, sunIntensity: 2.7, moon: false,
    skyTop: 0x4e97e0, skyHorizon: 0xffe2aa, fogColor: 0xeadfc2, fogNear: 180, fogFar: 1500,
    hemiSky: 0xe6e4d2, hemiGround: 0x7a6044, hemiIntensity: 1.35, clouds: 0.5, stars: 0, rimStrength: 0.34,
  },
  dusk: {
    sunElevationDeg: 7, sunAzimuthDeg: 285, sunColor: 0xff9658, sunIntensity: 2.2, moon: false,
    skyTop: 0x5a5cb4, skyHorizon: 0xffb27a, fogColor: 0xe8a58c, fogNear: 150, fogFar: 1350,
    hemiSky: 0xc0b0e0, hemiGround: 0x5e4452, hemiIntensity: 1.3, clouds: 0.65, stars: 0.2, rimStrength: 0.45,
  },
  starNight: {
    sunElevationDeg: 48, sunAzimuthDeg: 200, sunColor: 0xb4c6ff, sunIntensity: 1.25, moon: true,
    skyTop: 0x0e1a46, skyHorizon: 0x34488a, fogColor: 0x2a3a68, fogNear: 140, fogFar: 1300,
    hemiSky: 0x9fb0ec, hemiGround: 0x3a3f6a, hemiIntensity: 1.7, clouds: 0.25, stars: 1, rimStrength: 0.55,
  },
  sunrise: {
    sunElevationDeg: 5, sunAzimuthDeg: 80, sunColor: 0xffc690, sunIntensity: 2.1, moon: false,
    skyTop: 0x8fa8e6, skyHorizon: 0xffc9a0, fogColor: 0xf4c8b8, fogNear: 150, fogFar: 1400,
    hemiSky: 0xe8d4dc, hemiGround: 0x62504c, hemiIntensity: 1.3, clouds: 0.6, stars: 0.08, rimStrength: 0.42,
  },
};

/** Transition length inside cin_skyshard_1–3, cin_altar and the Caelith Final Phase entry (s). */
export const TIME_OF_DAY_BLEND_SECONDS = 4;

/** Cinematics during which a progress change blends instead of cutting. */
export const TIME_OF_DAY_BLEND_CINEMATICS: readonly string[] = ['cin_skyshard_1', 'cin_skyshard_2', 'cin_skyshard_3', 'cin_altar'];

/** What the preset is chosen from (GameState fields). */
export interface TimeOfDayProgress {
  readonly skyshards: number;
  readonly altarActivated: boolean;
  readonly gameCompleted: boolean;
}

const BY_SKYSHARDS: readonly TimeOfDayId[] = ['morning', 'noon', 'afternoon', 'dusk'];

/** The progress look: ending → sunrise, activated altar → starlit night, else by the Skyshards held (0–3). */
export function progressTimeOfDay(p: TimeOfDayProgress): TimeOfDayId {
  if (p.gameCompleted) return 'sunrise';
  if (p.altarActivated) return 'starNight';
  const n = Number.isFinite(p.skyshards) ? Math.min(3, Math.max(0, Math.floor(p.skyshards))) : 0;
  return BY_SKYSHARDS[n] ?? 'morning';
}

/**
 * The look to show: the Caelith arena's (`bossSky`, while the fight runs) over the progress look. After the ending the
 * sunrise wins even if an arena value is still reported.
 */
export function timeOfDayFor(p: TimeOfDayProgress, bossSky: 'dusk' | 'starNight' | null = null): TimeOfDayId {
  if (p.gameCompleted || bossSky === null) return progressTimeOfDay(p);
  return bossSky;
}

/** Unit vector toward the key light: bearing clockwise from north (−z), elevation above the horizon. */
export function sunDirection(preset: Pick<TimeOfDayPreset, 'sunElevationDeg' | 'sunAzimuthDeg'>): { x: number; y: number; z: number } {
  const el = (preset.sunElevationDeg * Math.PI) / 180;
  const az = (preset.sunAzimuthDeg * Math.PI) / 180;
  const c = Math.cos(el);
  return { x: Math.sin(az) * c, y: Math.sin(el), z: -Math.cos(az) * c };
}
