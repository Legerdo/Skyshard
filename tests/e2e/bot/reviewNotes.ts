/*
 * Screenshot review (task 24.5, design "검토 체크리스트", Req 42.8): the judgements made by looking at the playthrough
 * scenes, merged into test-results/screenshots/review.md next to the automatic camera check. Each entry is
 * "판정 | 근거" (통과 / 경미 / 결함 / 해당 없음). They describe the scenes as the route frames them (the same places,
 * conditions and camera rules every run); re-check them when a run's images change.
 */
import type { CHECKLIST } from './metrics';

type Item = (typeof CHECKLIST)[number];

export const REVIEW_NOTES: Readonly<Record<string, Partial<Record<Item, string>>>> = {
  '01-thistlewick.png': {
    '빈 지형': '통과 | 광장·집·나무·울타리가 화면을 채우고, 전경의 흙길만 단조롭다',
    '기본 도형 나열': '경미 | 광장 왼쪽의 나무 상자 더미와 벤치가 단순한 상자 형태',
    '구별되지 않는 캐릭터': '통과 | 붉은 코트의 Kairen이 배경과 뚜렷이 구별된다',
    '반복 오브젝트': '통과 | 집마다 지붕·벽 색이 다르다',
    'Landmark 없는 Region': '경미 | Region 제목 카드는 보이지만 이 구도에서 Breezewatch·Elderbough는 화면 밖',
    '기본 HTML 스타일 UI': '통과 | HUD·튜토리얼 힌트가 공용 패널 스타일',
    'VFX로 판독 불가능한 전투': '해당 없음 | 전투 없음',
  },
  '02-vista-verdant.png': {
    '빈 지형': '통과 | 언덕·숲·절벽 파노라마',
    '기본 도형 나열': '경미 | (24.5 재검토) 활강 발판이 깎은 돌 받침과 빛나는 룬 고리로 바뀌고 프롬프트는 "바람을 타고 활강한다"; 꼭대기는 난간·깃발 달린 판자 전망대라 여전히 단순하다',
    '구별되지 않는 캐릭터': '통과 | Isla와 Wren의 실루엣·색이 다르다',
    '반복 오브젝트': '통과',
    'Landmark 없는 Region': '통과 | 지평선의 Cinderspire 붉은 첨탑',
    '기본 HTML 스타일 UI': '통과 | 발견 알림·지도 안내 패널',
    'VFX로 판독 불가능한 전투': '해당 없음 | 전투 없음',
  },
  '03-glide.png': {
    '빈 지형': '통과 | 폭포·숲·계단식 절벽',
    '기본 도형 나열': '경미 | 발밑 풍차 탑이 무늬 없는 기둥(임시 조각 bw_tower)',
    '구별되지 않는 캐릭터': '통과 | 활강 자세의 Wren',
    '반복 오브젝트': '경미 | 먼 침엽수가 같은 모양으로 반복',
    'Landmark 없는 Region': '통과 | 폭포와 Elderbough 고목',
    '기본 HTML 스타일 UI': '통과',
    'VFX로 판독 불가능한 전투': '해당 없음 | 전투 없음',
  },
  '04-climb.png': {
    '빈 지형': '경미 | (24.5 재검토) 절벽 면에 층마다 다른 밝기·색조의 암석 띠, 아래 가장자리 음영, 띠마다 어긋난 수직 균열이 보인다; 가까이서는 균열 무늬가 다소 기하학적이다',
    '기본 도형 나열': '통과',
    '구별되지 않는 캐릭터': '통과 | 등반 자세의 Isla',
    '반복 오브젝트': '통과',
    'Landmark 없는 Region': '해당 없음 | 벽을 마주한 구도',
    '기본 HTML 스타일 UI': '통과',
    'VFX로 판독 불가능한 전투': '해당 없음 | 전투 없음',
  },
  '05-switch-combat.png': {
    '빈 지형': '통과 | 밭·나무·풍차',
    '기본 도형 나열': '경미 | 오른쪽 전경의 큰 갈색 판자(밭 소품)가 단순 상자',
    '구별되지 않는 캐릭터': '통과 | 흰 Bramblekin과 Isla',
    '반복 오브젝트': '통과',
    'Landmark 없는 Region': '통과 | 풍차 날개와 Blight 장막',
    '기본 HTML 스타일 UI': '통과 | 적 HP 막대와 교체 슬롯',
    'VFX로 판독 불가능한 전투': '통과 | Tide 효과와 표식 아이콘이 읽힌다',
  },
  '06-reaction.png': {
    '빈 지형': '경미 | 투기장 바닥이 무늬 없는 밝은 녹색 평면, 벽도 단색',
    '기본 도형 나열': '통과',
    '구별되지 않는 캐릭터': '통과 | 붉은 Kairen과 Rootbound Warden',
    '반복 오브젝트': '통과',
    'Landmark 없는 Region': '해당 없음 | 실내',
    '기본 HTML 스타일 UI': '통과 | Reaction 이름("증기 폭발")과 피해 숫자',
    'VFX로 판독 불가능한 전투': '경미 | Warden을 감싼 흰 방어막 구가 몸체와 약점 뿌리를 가린다',
  },
  '07-enemy-camp.png': {
    '빈 지형': '경미 | 캠프까지 풀이 드문 넓은 녹색 평지',
    '기본 도형 나열': '통과',
    '구별되지 않는 캐릭터': '경미 | 먼 거리에서 Bramblekin이 덤불처럼 보인다',
    '반복 오브젝트': '경미 | 뒤쪽 숲이 같은 둥근 나무의 줄',
    'Landmark 없는 Region': '통과 | Breezewatch 절벽과 Blight 장막',
    '기본 HTML 스타일 UI': '통과 | 교체 튜토리얼 힌트',
    'VFX로 판독 불가능한 전투': '해당 없음 | 전투 전',
  },
  '08-challenge-hollowroot.png': {
    // (24.5 re-check) the sinkhole walls are terrain: the strata shader now draws rock courses and joints on them.
    '빈 지형': '경미 | (24.5 재검토) 싱크홀 벽에 암석 층 띠와 균열이 보인다; 나선 경사로 바닥은 녹색 풀밭뿐이고 뿌리 소품은 이 구도에서 보이지 않는다',
    '기본 도형 나열': '경미 | 경사로 바닥이 넓은 단색 면',
    '구별되지 않는 캐릭터': '통과 | Wren',
    '반복 오브젝트': '통과',
    'Landmark 없는 Region': '해당 없음 | 싱크홀 내부',
    '기본 HTML 스타일 UI': '통과',
    'VFX로 판독 불가능한 전투': '해당 없음 | 전투 없음',
  },
  '08-challenge-cinderspire.png': {
    '빈 지형': '경미 | 주황 바닥과 첨탑 벽이 단색 면',
    '기본 도형 나열': '통과 | 결정·떠 있는 바위가 첨탑 형태를 만든다',
    '구별되지 않는 캐릭터': '통과',
    '반복 오브젝트': '통과',
    'Landmark 없는 Region': '통과 | Cinderspire 첨탑 자체',
    '기본 HTML 스타일 UI': '통과',
    'VFX로 판독 불가능한 전투': '해당 없음 | 전투 없음',
  },
  '08-challenge-observatory.png': {
    '빈 지형': '통과 | 입구 계단과 비탈의 침엽수',
    '기본 도형 나열': '경미 | 흰 석재 계단·벽이 밝게 뭉개져 윤곽만 보인다',
    '구별되지 않는 캐릭터': '통과 | Kairen',
    '반복 오브젝트': '통과',
    'Landmark 없는 Region': '통과 | Starfall Observatory',
    '기본 HTML 스타일 UI': '통과',
    'VFX로 판독 불가능한 전투': '해당 없음 | 전투 없음',
  },
  '09-azure-highlands.png': {
    '빈 지형': '경미 | (24.5 재검토) "짙은 회색 안개"로 보이던 것은 관문 바로 앞 Azure 고원의 회색 석벽이었다; 이제 층 띠와 균열이 보이고 흰 바람 줄기가 흐른다. 앞의 흙길·풀은 여전히 단조롭다',
    '기본 도형 나열': '통과',
    '구별되지 않는 캐릭터': '통과',
    '반복 오브젝트': '통과',
    'Landmark 없는 Region': '경미 | 관문 직후 구도는 고원 절벽이 시야를 막아 Observatory가 화면 밖 (Compass에 목표 72 m 표시)',
    '기본 HTML 스타일 UI': '통과',
    'VFX로 판독 불가능한 전투': '해당 없음 | 전투 없음',
  },
  '10-astral-sanctum.png': {
    '빈 지형': '통과 | 떠 있는 섬, 계단, 관문',
    '기본 도형 나열': '경미 | 관문 발판이 단색 파란 상자',
    '구별되지 않는 캐릭터': '통과',
    '반복 오브젝트': '통과',
    'Landmark 없는 Region': '통과 | ASTRAL SANCTUM 제목 카드와 Landmark 알림',
    '기본 HTML 스타일 UI': '통과',
    'VFX로 판독 불가능한 전투': '해당 없음 | 전투 없음',
  },
  '11-caelith-phase2.png': {
    '빈 지형': '경미 | 투기장 바닥이 단색 원판과 구역선',
    '기본 도형 나열': '통과',
    '구별되지 않는 캐릭터': '통과 | Caelith와 Isla',
    '반복 오브젝트': '통과',
    'Landmark 없는 Region': '통과 | 성소 투기장과 노을 하늘',
    '기본 HTML 스타일 UI': '통과 | 보스 HP·Starshell 막대',
    'VFX로 판독 불가능한 전투': '통과 | Lock-on 구도에서 Starshell 구 너머 Caelith 전신이 보인다 (Lock-on 없이 근접하면 추적 카메라가 머리를 화면 밖에 둔다)',
  },
  '12-victory.png': {
    '빈 지형': '해당 없음 | 메뉴 화면',
    '기본 도형 나열': '해당 없음',
    '구별되지 않는 캐릭터': '해당 없음',
    '반복 오브젝트': '해당 없음',
    'Landmark 없는 Region': '해당 없음',
    '기본 HTML 스타일 UI': '통과 | 금색 테두리 패널과 통계 목록 (Playwright 클릭 판정은 "탐험 계속" 위를 통계 행이 가린다고 보고하지만 elementFromPoint는 버튼 자신; 봇은 Enter로 확인)',
    'VFX로 판독 불가능한 전투': '해당 없음',
  },
};

/** Defects found and what was done about them (review.md summary). */
export const REVIEW_SUMMARY: readonly string[] = [
  '## 결함 요약과 조치',
  '',
  '- 고침(24.6, 카메라): Starfall Observatory의 2 m 난간·별빛 장벽·Skyshard 별빛 우리가 카메라 스윕을 막아, 전투 중 카메라가 캐릭터 1 m 안(최소 0.28 m)으로 8회 당겨졌다 → src/world/challengeArea.ts에서 해당 look이 카메라를 막지 않게 했다 (Observatory 0회; 남은 4회는 Hollowroot R4 입구 경사로 3회, Cinderspire 활강 1회로 Req 21.4 근접 반투명 범위).',
  '- 고침(24.5, 봇·촬영): Challenge_Area 진입 장면은 연출 종료 0.8 s 뒤(카메라 0.4 s 복귀 뒤)에 찍고, Caelith 전투는 Lock-on(R)으로 한다.',
  '- 고침(24.5 재검토, 렌더): 급경사 지형의 무늬 없는 절벽 면(04, 09, Hollowroot 싱크홀 벽) → src/render/terrain/terrainMaterial.ts의 strata 셰이더에 층별 색조·수직 균열·잔결을 더했다. "Azure 진입부의 짙은 안개"는 안개가 아니라 이 회색 절벽 면이었다.',
  '- 고침(24.5 재검토, 경로 표시): 임시 활강·등반 발판을 하늘색 원판·반투명 기둥에서 깎은 돌 받침·룬 고리로 바꾸고(src/render/tempRouteView.ts), 프롬프트의 "임시 … 경로" 문구를 "바람을 타고 활강한다" 등으로 바꿨다(src/world/tempRoute.ts).',
  '- 미해결(렌더): 풍차 꼭대기는 판자 전망대, 풍차 탑 기둥은 단순한 원기둥이고, Hollowroot·Cinderspire 투기장 바닥은 단색이다(경미).',
  '- 미해결(카메라 설계): Lock-on 없이 Caelith에 붙으면 7 m 상한(Req 21.5)의 추적 카메라가 6 m 기사 머리를 화면 밖에 둔다.',
  '- 관찰(조작): Breezewatch 첫 절벽 밑은 45–60° 비탈이라 밀기만으로는 붙지 않고 점프해야 붙는다(지형 2 m 격자).',
  '',
];
