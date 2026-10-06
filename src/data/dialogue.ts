/*
 * Dialogue content (design.md "Dialogue_System", task 13.1; Req 3.8, 14.4–14.7, 35.4). Read-only data: the pure
 * `selectDialogue` (src/logic/dialogue.ts) picks one `DialogueDef` per talk from GameState alone, and the
 * Dialogue_System (src/dialogue/dialogueSystem.ts) plays it window by window.
 *
 * - `DialogueDef.when`: every given field must hold. `questStage` is the current stage id or Objective id of the
 *   Main_Quest or of an 'active' Side_Quest; `flag` a GameState progress flag; `bucket` the progress band (Skyshards
 *   0–3, 'post' once the game is completed). `sideQuest` (an addition to the design's three fields) is a Side_Quest's
 *   status, for the quest givers' offers; it ranks with `questStage`.
 * - A dialogue with `flag` and no `questStage` / `sideQuest` is a one-shot reaction: once it has played the
 *   Dialogue_System turns `seen_<id>` on and it is no longer a candidate.
 * - `onEnd` effects go through QuestSystem.applyEffects, the reducer's effect path (companion `joinParty`, Side_Quest
 *   `acceptQuest`), before 'dialogue:ended' is published.
 * - Every named NPC has a default dialogue (`when: {}`) and one per bucket 0, 1, 2, 3 and 'post', all different
 *   (Req 14.7). Companions (`kairen`, `isla`, `wren`, `talus`) take part as speakers; `isla`, `wren` and `talus` also
 *   stand in the world as talk targets until they join (Main_Quest `talk isla` / `wren` / `talus`).
 * - Stage-start dialogues (Req 3.8): each Main_Quest stage is briefed by a short dialogue. Most play by themselves
 *   when the stage starts (`STAGE_DIALOGUES`); ms2 is briefed by Elder Maren's ms1 report, which ends ms1.
 * - Limits (Req 14.4, 14.5): `text` ≤ 90 characters (3 lines of the window); ≤ 6 windows, ≤ 10 for main-story
 *   dialogues (a `questStage` naming a Main_Quest stage or Objective).
 * - Side_Quest branches live in `SIDE_QUEST_DIALOGUES` by quest, so dropping a Side_Quest (Req 15.5) drops them too
 *   (`dialogueDefsFor`).
 *
 * Korean text; proper nouns (Skyshard, Regions, characters, Elements, enemies) stay English (Req 35.4).
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */
import type { QuestDef, QuestEffect, SideQuestStatus } from '../logic/quest/types';
import {
  CHARACTER_NAMES, isNpcId, NPC_NAMES, SIDE_QUEST_IDS, type CharacterId, type MainStageId, type NpcId, type SideQuestId,
} from './ids';

// ── Types ───────────────────────────────────────────────────────────────────

/** Anyone who speaks or can be talked to: a named NPC or a companion. */
export type Speaker = NpcId | CharacterId;

/** Progress band of the bucket dialogues: Skyshards held, or 'post' once the game is completed (Req 7.6). */
export type DialogueBucket = 0 | 1 | 2 | 3 | 'post';

export const DIALOGUE_BUCKETS: readonly DialogueBucket[] = [0, 1, 2, 3, 'post'];

/** One dialogue window. */
export interface DialogueLine {
  readonly speaker: Speaker;
  readonly text: string;
}

export interface DialogueWhen {
  readonly bucket?: DialogueBucket;
  readonly questStage?: string;
  readonly flag?: string;
  /** A Side_Quest's status (quest givers' offers). */
  readonly sideQuest?: { readonly id: SideQuestId; readonly status: SideQuestStatus };
}

export interface DialogueDef {
  readonly id: string;
  /** Who is talked to (a named NPC, or a companion before joining). */
  readonly npc: Speaker;
  readonly when: DialogueWhen;
  readonly lines: readonly DialogueLine[];
  readonly onEnd?: readonly QuestEffect[];
}

/** A dialogue that plays by itself when its Main_Quest stage starts (Req 3.8). */
export interface StageDialogueDef {
  readonly id: string;
  readonly stage: MainStageId;
  readonly lines: readonly DialogueLine[];
}

/** Window, typing and turning rules (Req 14.4–14.6). */
export const DIALOGUE_RULES = {
  /** Characters typed per second. */
  charsPerSecond: 45,
  /** Longest window text: 3 lines of the window. */
  maxTextLength: 90,
  /** Lines of text a window shows. */
  maxLines: 3,
  /** Windows of an ordinary dialogue. */
  maxWindows: 6,
  /** Windows of a main-story dialogue (`questStage` naming a Main_Quest stage or Objective). */
  maxStoryWindows: 10,
  /** The NPC faces the player within this (s). */
  turnSeconds: 0.5,
  /** A stage-start dialogue waits this long after its stage starts (s), so the stage banner shows first. */
  stageDelaySeconds: 0.8,
} as const;

/**
 * Voice blip pitch of each speaker (Hz, Req 37.7): the 7 named NPCs and the 4 companions all differ. On every
 * 'dialogue:line' the Audio_System (task 16) plays a short blip at the speaker's pitch.
 */
export const SPEAKER_VOICE_HZ: Readonly<Record<Speaker, number>> = {
  maren: 196, pip: 330, bram: 147, tamsin: 523, hobb: 165, durga: 220, oriel: 294,
  kairen: 247, isla: 392, wren: 440, talus: 131,
};

/** Flag that retires one-shot reaction `id` once it has played. */
export const seenFlag = (id: string): string => `seen_${id}`;

/** Display name of a speaker (proper nouns stay English). */
export const speakerName = (id: Speaker): string => (isNpcId(id) ? NPC_NAMES[id] : CHARACTER_NAMES[id]);

// ── World-change flags (Side_Quest completions, Req 15.3) ───────────────────

/** GameState flags the Side_Quests' last `onComplete` turns on; the World restores their look from them on load. */
export const SIDE_QUEST_FLAGS = {
  /** sq_tamsin: the kite flies in the sky over Thistlewick. */
  sq_tamsin: 'village_kite',
  /** sq_hobb: flowers bloom in Hobb's field. */
  sq_hobb: 'field_flowers',
  /** sq_durga: the forge glows again and its chimney smokes. */
  sq_durga: 'forge_lit',
} as const satisfies Readonly<Record<SideQuestId, string>>;

// ── Builders ────────────────────────────────────────────────────────────────

const say = (speaker: Speaker, text: string): DialogueLine => ({ speaker, text });

/** The bucket texts of one NPC, in DIALOGUE_BUCKETS order (one window each unless given as lines). */
type BucketLines = readonly [string | readonly DialogueLine[], string | readonly DialogueLine[], string | readonly DialogueLine[],
  string | readonly DialogueLine[], string | readonly DialogueLine[]];

const bucketKey = (b: DialogueBucket): string => (b === 'post' ? 'post' : `b${b}`);

/** A named NPC's default and five bucket dialogues. */
function npcBasics(npc: NpcId, defaultText: string, buckets: BucketLines): DialogueDef[] {
  const lines = (v: string | readonly DialogueLine[]): readonly DialogueLine[] => (typeof v === 'string' ? [say(npc, v)] : v);
  return [
    { id: `dlg_${npc}_default`, npc, when: {}, lines: [say(npc, defaultText)] },
    ...DIALOGUE_BUCKETS.map((bucket, i): DialogueDef => ({
      id: `dlg_${npc}_${bucketKey(bucket)}`, npc, when: { bucket }, lines: lines(buckets[i] as string | readonly DialogueLine[]),
    })),
  ];
}

const story = (npc: Speaker, questStage: string, lines: readonly DialogueLine[], onEnd?: readonly QuestEffect[]): DialogueDef =>
  onEnd === undefined ? { id: `dlg_${npc}_${questStage}`, npc, when: { questStage }, lines }
    : { id: `dlg_${npc}_${questStage}`, npc, when: { questStage }, lines, onEnd };

/** A one-shot reaction to progress flag `flag`. */
const reaction = (npc: NpcId, flag: string, text: string): DialogueDef => ({
  id: `dlg_${npc}_react_${flag}`, npc, when: { flag }, lines: [say(npc, text)],
});

// ── Named NPCs ──────────────────────────────────────────────────────────────

const MAREN: readonly DialogueDef[] = [
  ...npcBasics('maren', '바람이 좋은 날이구먼. 필요한 게 있으면 언제든 광장으로 찾아오게.', [
    'Blight 때문에 거리 등불이 모두 꺼졌다네. 밤이 이렇게 어두운 건 처음일세.',
    '첫 Skyshard가 돌아오자 거리 등불이 다시 켜졌네. 마을 사람들 얼굴도 밝아졌어.',
    '노점이 다시 열리고 문마다 화환이 걸렸지. 자네 덕분에 마을이 숨을 쉬는구먼.',
    'Skyshard 세 개가 모였군. 크레이터 가운데 Resonance Altar가 자네를 기다리네.',
    '새벽 축제가 한창일세. 밤하늘의 별도, 들판의 꽃도 모두 제자리로 돌아왔어.',
  ]),
  // ms1 ①: the arrival (Objective id wins over the stage id).
  story('maren', 'ms1_maren', [
    say('maren', '먼 길을 온 방랑자로군. Thistlewick에 온 걸 환영하네. 나는 이 마을 촌장 Maren일세.'),
    say('kairen', '하늘에서 별 조각이 떨어지는 걸 보고 여기까지 따라왔습니다.'),
    say('maren', '그게 Skyshard일세. 그날 밤부터 들판에 가시 정령이 늘고 Blight가 번지기 시작했지.'),
    say('maren', '혼자서는 위험해. 망루 아래에 활을 잘 쏘는 Isla가 있으니 먼저 만나 보게.'),
  ]),
  // The rest of ms1 (② Isla) at the stage level.
  story('maren', 'ms1', [say('maren', '망루 아래의 Isla는 만났나? 망루는 광장 남동쪽 길 끝에 있다네.')]),
  story('maren', 'ms1_raid', [say('maren', '가시 정령이 동쪽 Hobb의 밭을 덮쳤네! 어서 가서 막아 주게!')]),
  // ms1 ④: the report, which also briefs ms2 (Req 3.8).
  story('maren', 'ms1_report', [
    say('maren', '밭을 지켜 줘서 고맙네. 자네 둘이라면 이 일을 해낼 수 있겠어.'),
    say('maren', '저길 보게. 북동쪽 절벽 위 풍차로 공명 빛이 흘러가고 있지. 저 풍차가 Breezewatch일세.'),
    say('maren', 'Skyshard의 울림은 높은 곳에서 가장 잘 들린다네. 풍차지기 Wren이 무언가 알고 있을 걸세.'),
    say('isla', '절벽이 꽤 높아요. 벽을 타고 두 번 오르면 풍차 꼭대기까지 갈 수 있을 거예요.'),
  ]),
  story('maren', 'ms2', [say('maren', 'Breezewatch는 북동쪽 절벽 위에 있네. 흘러가는 공명 빛을 따라가게.')]),
  // ms10 ③: the closing talk.
  story('maren', 'ms10_maren', [
    say('maren', '돌아왔구먼! 보게, 새벽빛이 온 마을을 감싸고 있어.'),
    say('maren', '별이 제자리를 찾았네. 들판을 뒤덮던 Blight도 흔적 없이 걷혔고.'),
    say('kairen', '모두가 함께해 준 덕분입니다.'),
    say('maren', '오늘은 축제일세. 그리고 언제든 이 세상을 마음껏 둘러보게.'),
  ]),
  reaction('maren', SIDE_QUEST_FLAGS.sq_tamsin, 'Tamsin의 연이 다시 하늘을 나는구먼. 그 아이 웃음소리가 여기까지 들리네.'),
];

const PIP: readonly DialogueDef[] = npcBasics('pip', '어서 와! 필요한 게 있으면 말만 해. Glim만 있으면 뭐든 구해 주지.', [
  '요즘은 임시 좌판에서 장사 중이야. Blight 탓에 물건이 통 안 들어와.',
  '거리 등불이 켜지니 손님이 조금씩 늘었어. 허브 경단 하나 어때?',
  '짜잔, 노점을 다시 열었어! 차양도 진열대도 새것처럼 고쳤지.',
  '광장 위 별 등불 봤어? 오늘 밤엔 장사 대신 하늘만 보게 될 것 같아.',
  '새벽 축제 덕에 없는 물건이 없어. 오늘은 기분이다, 천천히 골라 봐!',
]);

const BRAM: readonly DialogueDef[] = npcBasics('bram', 'Echo Altar는 Starmote의 울림으로 잠든 힘을 깨운다네. 모아 오면 도와주지.', [
  '제단이 조용하군. 하늘에서 별의 울림이 끊긴 지 오래일세.',
  '제단이 희미하게 울리기 시작했어. 첫 Skyshard가 돌아온 모양이군.',
  '울림이 한층 깊어졌네. 두 번째 조각도 제자리를 찾은 게지.',
  '세 조각이 모였으니 곧 Astral Sanctum이 깨어날 걸세. 부디 조심하게.',
  '하늘의 노래가 온전히 돌아왔네. 이 늙은이도 오랜만에 푹 자겠어.',
]);

const TAMSIN: readonly DialogueDef[] = [
  ...npcBasics('tamsin', '나 Tamsin! 이 우물 한 바퀴 누가 더 빨리 도나 내기할래?', [
    '밤이 너무 깜깜해서 무서워. 거리 등불이 다시 켜졌으면 좋겠어.',
    '등불이 켜졌어! 이제 밤에도 우물가에서 놀 수 있어.',
    '문마다 화환이 걸렸어. 나도 들꽃으로 하나 만들었다?',
    '광장 위에 별 등불이 떠 있어! 진짜 별보다 더 반짝거려.',
    '새벽 축제다! 오늘은 밤새 놀아도 된대!',
  ]),
];

const HOBB: readonly DialogueDef[] = [
  ...npcBasics('hobb', '흙은 정직하다네. 돌본 만큼 꼭 돌려주지.', [
    'Blight가 번지고 나서 작물이 영 시들시들해. 가시 정령도 자꾸 내려오고.',
    '밭에 다시 새싹이 올라왔네. 올해 농사는 해 볼 만하겠어.',
    '허허, 이랑마다 싹이 가득하구먼. Pip 노점에 채소를 댈 수 있겠어.',
    '밤마다 크레이터 쪽 하늘이 환하네. 곧 좋은 일이 생길 것 같구먼.',
    '새벽 축제에 낼 호박을 골라 두었지. 올해 제일 큰 녀석일세!',
  ]),
];

const DURGA: readonly DialogueDef[] = [
  ...npcBasics('durga', '광부 야영지에 온 걸 환영하지. 불똥 튀니까 조심하고.', [
    '협곡 입구가 Blight로 막혀서 보급이 끊겼어. 여기까지 어떻게 왔지?',
    'Ashgate 고개가 뚫렸다고? 덕분에 마을로 가는 보급로가 살아나겠군.',
    'Cinderspire의 불길이 잠잠해졌어. 첨탑 위 공명을 네가 가라앉혔구나.',
    '크레이터 쪽 하늘이 별빛으로 가득해. 광부들도 곡괭이를 놓고 구경 중이야.',
    '새벽이 오니 수정들이 노래하는 것 같아. 오늘은 모두 쉬는 날이다!',
  ]),
  // ms4 ③: the region's story and the way to Cinderspire.
  story('durga', 'ms4_durga', [
    say('durga', '낯선 얼굴이군. Ashgate 고개를 넘어왔다고? 배짱 한번 좋은데.'),
    say('durga', '이 협곡의 수정은 불꽃의 울림을 먹고 자라. 그런데 요즘 그 울림이 미쳐 날뛰고 있어.'),
    say('durga', '남동쪽 수정 첨탑 Cinderspire 꼭대기에서 붉은 빛이 치솟더군. 네가 찾는 Skyshard일 거야.'),
    say('durga', '가는 협곡 길목에 Cinder Hound 무리가 진을 쳤어. 싸울 준비는 하고 가.'),
  ]),
];

const ORIEL: readonly DialogueDef[] = [
  ...npcBasics('oriel', '별은 늘 같은 자리에서 길을 알려 주지. 올려다보기만 하면 돼.', [
    '고원 위 하늘이 흐려. Blight가 별빛까지 가리고 있어.',
    '별자리 하나가 다시 선명해졌어. 네가 첫 Skyshard를 찾은 날이었지.',
    '크레이터 북쪽 고개가 열렸다니, 드디어 이 고원에도 손님이 오겠군.',
    '관측소 돔 위로 별빛이 돌아왔어. 이제 세 조각의 노래가 하늘에 닿겠지.',
    '새벽 별이 저렇게 밝은 건 처음 봐. 기록장에 꼭 적어 둬야겠어.',
  ]),
  // ms6 ②: the Observatory and the Wind_Zone glide.
  story('oriel', 'ms6_oriel', [
    say('oriel', '망원경 반사광을 보고 왔구나. 반가워, 나는 천문학자 Oriel이야.'),
    say('oriel', 'Starfall Observatory는 능선 너머 절벽 위에 있어. 세 번째 Skyshard가 거기 떨어졌지.'),
    say('oriel', '능선으로 부는 강풍을 타고 활강하면 관측소 쪽으로 곧장 갈 수 있어.'),
    say('oriel', '길목의 Windcutter 무리는 돌진해 와. 단단한 돌벽으로 막으면 수월할 거야.'),
  ]),
];

// ── Companions before they join (Main_Quest `talk` targets) ─────────────────

const COMPANIONS: readonly DialogueDef[] = [
  { id: 'dlg_isla_default', npc: 'isla', when: {}, lines: [say('isla', '먼저 광장의 Elder Maren 촌장님께 인사드리는 게 어때요?')] },
  story('isla', 'ms1_isla', [
    say('isla', 'Maren 촌장님이 말한 방랑자군요. 저는 Isla예요. 이 망루에서 들판을 지키고 있어요.'),
    say('isla', '방금 동쪽 밭이 가시 정령한테 습격당했어요. 활이라면 자신 있어요.'),
    say('kairen', '좋아, 같이 가자.'),
    say('isla', '교체 키 2를 누르면 제가 나설게요. 멀리 있는 적은 제 화살에 맡겨요.'),
  ], [{ kind: 'joinParty', character: 'isla' }]),
  { id: 'dlg_wren_default', npc: 'wren', when: {}, lines: [say('wren', '풍차 날개가 이상하게 떨려. 무언가 다가오고 있어.')] },
  story('wren', 'ms2_wren', [
    say('wren', '여기까지 올라오다니, 바람이 널 좋아하나 봐. 나는 풍차지기 Wren이야.'),
    say('wren', 'Skyshard의 울림이 남서쪽 거대 고목 Elderbough 뿌리 아래에서 들려.'),
    say('wren', '여기서 활강하면 곧장 닿을 수 있어. 나도 같이 갈게.'),
    say('wren', '교체 키 3이면 내가 나서. 활강 중 Skill 소용돌이를 쓰면 더 높이 떠오를 수 있어.'),
  ], [{ kind: 'joinParty', character: 'wren' }]),
  { id: 'dlg_talus_default', npc: 'talus', when: {}, lines: [say('talus', '이 뿌리 아래는 아무나 들어갈 수 있는 곳이 아니다.')] },
  story('talus', 'ms3_talus', [
    say('talus', '뿌리 성소를 찾아왔나. 나는 Talus, 오래전부터 이곳을 지켜 왔다.'),
    say('talus', '안쪽 장치는 Ember, Gale, Terra의 힘으로만 움직인다. 셋이 모였으니 들어갈 수 있겠군.'),
    say('talus', '교체 키 4를 눌러라. 내 돌기둥이면 압력판쯤은 거뜬히 누른다.'),
  ], [{ kind: 'joinParty', character: 'talus' }]),
];

// ── Side_Quest branches (Req 15.1, 15.5) ────────────────────────────────────

const offer = (npc: NpcId, quest: SideQuestId, lines: readonly DialogueLine[]): DialogueDef => ({
  id: `dlg_${npc}_${quest}_offer`, npc, when: { sideQuest: { id: quest, status: 'available' } }, lines,
  onEnd: [{ kind: 'acceptQuest', quest }],
});

/** Each Side_Quest's dialogue branches: the offer (accepts it), the Objective reminders and the hand-in, the reaction. */
export const SIDE_QUEST_DIALOGUES: Readonly<Record<SideQuestId, readonly DialogueDef[]>> = {
  sq_tamsin: [
    offer('tamsin', 'sq_tamsin', [
      say('tamsin', '저기, 도와줄 수 있어? 내 연이 바람에 날아가 버렸어.'),
      say('tamsin', 'Breezewatch 풍차 날개 끝에 걸린 게 보였어. 너무 높아서 나는 못 올라가...'),
      say('kairen', '걱정 마. 풍차 꼭대기까지 올라가서 가져다줄게.'),
    ]),
    story('tamsin', 'sq_tamsin_kite', [say('tamsin', '풍차 꼭대기 날개 끝이야! 절벽을 두 번 오르면 풍차를 감는 나선 계단이 있어.')]),
    story('tamsin', 'sq_tamsin_return', [
      say('tamsin', '내 연이다! 정말 풍차 꼭대기까지 갔었어?'),
      say('tamsin', '고마워! 이건 우물가에서 주운 이슬방울 부적이야. 너 가져.'),
    ]),
    reaction('tamsin', SIDE_QUEST_FLAGS.sq_tamsin, '봐, 내 연이 마을 하늘에서 제일 높이 날아!'),
  ],
  sq_hobb: [
    offer('hobb', 'sq_hobb', [
      say('hobb', '이보게, 부탁 하나 들어주겠나? 밭 너머 가시 둥지 때문에 작물이 다 망가지네.'),
      say('hobb', '둥지의 가시 정령을 모두 쫓아내 주면 톡톡히 사례하겠네.'),
    ]),
    story('hobb', 'sq_hobb_nest', [say('hobb', '가시 둥지는 밭 동쪽 너머 덤불 언덕에 있네. 조심하게.')]),
    story('hobb', 'sq_hobb_report', [
      say('hobb', '둥지가 조용해졌구먼! 이제 작물이 마음 놓고 자라겠어.'),
      say('hobb', '밭을 갈다 캐낸 오래된 나침반일세. 자네 같은 모험가에게 어울리겠어.'),
    ]),
    reaction('hobb', SIDE_QUEST_FLAGS.sq_hobb, '밭에 꽃이 활짝 피었네! 가시 둥지를 치워 준 덕분이야.'),
  ],
  sq_durga: [
    offer('durga', 'sq_durga', [
      say('durga', '하나 부탁하지. 용광로 불이 꺼져서 일을 할 수가 없어.'),
      say('durga', '야영지 둘레 화로 세 개에 Ember 불을 붙여 주면 용광로가 다시 살아날 거야.'),
    ]),
    story('durga', 'sq_durga_braziers', [say('durga', '화로는 야영지 둘레에 세 개야. 순서는 상관없어.')]),
    story('durga', 'sq_durga_report', [
      say('durga', '용광로가 다시 달아올랐어! 굴뚝 연기 좀 봐.'),
      say('durga', '약속한 Starmote하고, 용광로 첫 불로 벼린 돌심장 부적이야.'),
    ]),
    reaction('durga', SIDE_QUEST_FLAGS.sq_durga, '용광로가 쉬지 않고 돌아가. 광부들 사기가 하늘을 찌르는군!'),
  ],
};

// ── Stage-start dialogues (Req 3.8) ─────────────────────────────────────────

/** Played by themselves when their stage starts (ms1 on New Game), once the party stands still and out of combat. */
export const STAGE_DIALOGUES: readonly StageDialogueDef[] = [
  { id: 'dlg_stage_ms1', stage: 'ms1', lines: [
    say('kairen', '떨어진 별 조각의 흔적이 이 마을로 이어졌어. 광장의 Elder Maren께 먼저 여쭤 보자.'),
  ] },
  { id: 'dlg_stage_ms3', stage: 'ms3', lines: [
    say('wren', '여기가 Elderbough야. 뿌리 아치 쪽에서 공명이 울려.'),
    say('wren', '아치 앞에 누가 서 있어. 가 보자.'),
  ] },
  { id: 'dlg_stage_ms4', stage: 'ms4', lines: [
    say('talus', 'Skyshard가 돌아오자 동쪽 Ashgate 고개의 장벽이 걷혔다.'),
    say('isla', '고개 너머 붉은 협곡에서 두 번째 울림이 들려요. 가 봐요.'),
  ] },
  { id: 'dlg_stage_ms5', stage: 'ms5', lines: [
    say('isla', '이게 Cinderspire... 첨탑 벽을 타고 올라가야겠어요.'),
    say('kairen', '휴식 발판에서 숨을 고르며 정상까지 가자.'),
  ] },
  { id: 'dlg_stage_ms6', stage: 'ms6', lines: [
    say('wren', '크레이터 북쪽 고개의 장벽도 사라졌어. 하늘 고원으로 가자.'),
    say('wren', '고원 야영지에서 망원경이 반짝이던데, 누가 살고 있나 봐.'),
  ] },
  { id: 'dlg_stage_ms7', stage: 'ms7', lines: [
    say('isla', 'Starfall Observatory 입구예요. 대전당 안쪽에서 마지막 울림이 들려요.'),
  ] },
  { id: 'dlg_stage_ms8', stage: 'ms8', lines: [
    say('talus', '세 조각이 모였다. 크레이터 중앙에 빛기둥이 솟는 게 보이나?'),
    say('talus', 'Resonance Altar에 바치면 성소로 가는 길이 열릴 것이다.'),
  ] },
  { id: 'dlg_stage_ms9', stage: 'ms9', lines: [
    say('kairen', '여기가 Astral Sanctum... 벽화가 있는 연결 전당부터 살펴보자.'),
  ] },
  { id: 'dlg_stage_ms10', stage: 'ms10', lines: [
    say('kairen', '별의 목소리가 잦아들었어. 새벽의 Thistlewick으로 돌아가자.'),
    say('isla', 'Maren 촌장님께 알려 드려야죠!'),
  ] },
];

/**
 * The dialogue that briefs each Main_Quest stage (Req 3.8): its stage-start dialogue, or for ms2 Elder Maren's ms1
 * report (the talk that ends ms1 and points at Breezewatch).
 */
export const STAGE_BRIEFINGS: Readonly<Record<MainStageId, string>> = {
  ms1: 'dlg_stage_ms1',
  ms2: 'dlg_maren_ms1_report',
  ms3: 'dlg_stage_ms3',
  ms4: 'dlg_stage_ms4',
  ms5: 'dlg_stage_ms5',
  ms6: 'dlg_stage_ms6',
  ms7: 'dlg_stage_ms7',
  ms8: 'dlg_stage_ms8',
  ms9: 'dlg_stage_ms9',
  ms10: 'dlg_stage_ms10',
};

// ── Catalogue ───────────────────────────────────────────────────────────────

/** The named NPCs' and companions' dialogues without the Side_Quest branches. */
export const BASE_DIALOGUES: readonly DialogueDef[] = [...MAREN, ...PIP, ...BRAM, ...TAMSIN, ...HOBB, ...DURGA, ...ORIEL, ...COMPANIONS];

/** Every dialogue for a quest set: the base ones plus the branches of the Side_Quests defined in `quests`. */
export function dialogueDefsFor(quests: readonly QuestDef[]): readonly DialogueDef[] {
  const defined = new Set<string>(quests.map((q) => q.id));
  return [...BASE_DIALOGUES, ...SIDE_QUEST_IDS.filter((id) => defined.has(id)).flatMap((id) => SIDE_QUEST_DIALOGUES[id])];
}

/** Every dialogue of the full game (all three Side_Quests). */
export const DIALOGUES: readonly DialogueDef[] = [...BASE_DIALOGUES, ...SIDE_QUEST_IDS.flatMap((id) => SIDE_QUEST_DIALOGUES[id])];
