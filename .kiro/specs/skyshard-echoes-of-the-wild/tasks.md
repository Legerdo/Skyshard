# Implementation Plan

## Overview

design.md의 마일스톤 M0–M10 순서로 구현한다. 먼저 최소 전체 경로(Title → Village → Open World → Combat → Skyshard ×3 → Final Boss → Victory)를 실제로 동작시킨다(Req 2.9).
그 위에 파티·속성·적·수직 탐험·보스·UI·저장·오디오를 확장하고 아트·밀도·연출을 입힌 뒤, 마지막에 Vitest·fast-check·Playwright로 검증하고 결과를 보고한다.
기술 스택은 TypeScript strict + Vite + Three.js(WebGL2)이며, 순수 규칙은 브라우저 없이 테스트할 수 있도록 `src/logic`·`src/data`에 둔다.
각 작업을 마칠 때마다 `npm run build`와 `npm test`가 통과해야 한다.
개발 중 임시 표시(예: 캡슐 캐릭터)는 해당 아트 작업에서 반드시 교체한다.
캐릭터·적·보스·NPC 시각 모델은 `VisualProvider` 뒤에 두어 나중에 `src/data/visualManifest.ts`만 바꿔 FBX·VRM·glTF 모델로 교체할 수 있게 한다(Req 43).

## Tasks

- [x] 1. 프로젝트 스캐폴드와 핵심 루프 (M0)
  - [x] 1.1 Vite + TypeScript strict 프로젝트와 도구 설정
    - `npm install --save-exact`로 `three`, `@types/three`, `typescript`, `vite`, `vitest`, `fast-check`, `@playwright/test`를 설치하고, scripts `dev`·`build`(`tsc --noEmit && vite build`)·`preview`·`test`(`vitest run`)·`test:e2e`(`playwright test`)를 정의
    - strict `tsconfig.json`, 설계 디렉터리 트리(`src/*`, `tests/{unit,property,e2e}`), `index.html`(WebGL2 캔버스 + DOM UI 루트), `src/ui/styles`의 한국어 시스템 폰트 스택 기본 CSS(외부 CDN·웹 폰트 없음)
    - `vite.config.ts`에 Vitest include(`tests/unit`, `tests/property`, Node 환경)를 설정하고, 스모크 테스트 1개로 초기 상태에서도 `npm test`가 통과하게 한다
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.11_
  - [x] 1.2 core 모듈: GameLoop, RNG, EventBus, Vec3 math
    - `src/core/loop.ts`: `SIM_DT = 1/60` accumulator, 프레임당 최대 5스텝·잔여분 절단, `realDt` 0.25 s clamp, 보간 `alpha`, `TimeScaleSource`별 요청 중 최솟값 적용(실시간 만료), `PauseMode`, `none`·`dialogue`·`cinematic`에서만 누적하는 `playTimeSec`
    - `rng.ts` 서브시스템별 `mulberry32` 스트림, `eventBus.ts` 타입 `GameEvents` 틱 큐(EventDispatch FIFO 전달, 전달 중 emit은 큐 끝, 틱당 1,024건 상한, 핸들러 예외 격리), `math.ts` Vec3 유틸
    - `tests/unit`: 스텝 상한, timeScale 겹침(Hit_Stop 0·Perfect_Dodge 0.3), `menu` 시간 제외, 같은 seed 재현, 이벤트 순서·연쇄 테스트
    - _Requirements: 1.9, 7.8, 24.9, 26.3_
  - [x] 1.3 input 모듈: 샘플링, 버퍼, 컨텍스트, 브라우저 정책
    - `src/input`: DOM 이벤트와 `navigator.getGamepads()`(standard mapping) 폴링을 `RawInputQueue`에 기록하고, 틱 시작 시 `InputState`(`down`·`pressed`·`released`·`heldTime`·`moveVector` 데드존 0.15·`lookDelta`)를 계산
    - `InputBuffer` 0.15 s(`jump`·`attack`·`dodge`), `released` 틱의 `heldTime`(Charged 0.4 s 판정용), 입력 컨텍스트 전환 시 edge 초기화, 기본 키·게임패드 바인딩(X 걷기 토글, 방향키 카메라)
    - 바인딩 키·F3·`contextmenu`·`wheel`(`passive: false`) `preventDefault`, 캔버스 클릭 pointer lock 요청·게임플레이 중 해제 시 Pause 요청, `visibilitychange`(hidden → Pause)·`blur`(입력 모두 놓음) + edge·버퍼 만료 unit tests
    - _Requirements: 35.1, 35.2, 24.3, 31.8, 31.9_
  - [x] 1.4 렌더러 초기화와 F3 성능 표시
    - `src/render/renderer.ts`: WebGL2 미지원이면 한국어 안내 화면을 표시하고, 지원 시 `powerPreference: 'high-performance'`로 생성해 resize 때 캔버스·pixel ratio·aspect를 갱신
    - `webglcontextlost`에서 `preventDefault` 후 렌더 중지·안내, `webglcontextrestored`에서 GPU 리소스 재생성 후 재개
    - `src/debug/perfOverlay.ts`: F3로 토글하는 fps·draw call·삼각형 수 표시(`renderer.info` 기반)
    - _Requirements: 1.5, 1.6, 1.7, 1.8, 38.7_
  - [x] 1.5 `src/data/ids.ts` ID 레지스트리와 계층 경계 테스트
    - `ids.ts`: `RegionId`·`CharacterId`·`ElementId`·`ReactionId`·`EnemyId`·`BossId` 등을 `as const` 배열과 파생 union 타입으로 한곳에 정의
    - `tests/unit/layering.test.ts`: `src/logic`·`src/data`의 `three` 등 금지 import와 `window`·`document`·`AudioContext`·`Math.random` 참조를 스캔해 위반 시 실패(`src/core`는 `rng`·`math`만 허용), 레지스트리 ID 중복 검사
    - _Requirements: 42.1_

- [x] 2. 지형·충돌·이동·카메라 (M1)
  - [x] 2.1 `worldLayout.ts` 좌표 규약·배치 데이터와 경로 검증
    - `src/data/worldLayout.ts`: 좌표 규약(m, y 위, +x 동, −z 북, 원점 크레이터 중심), Region 5개 경계, 핵심 위치 표(id·Region·x·z·지면 y), Waystone·게이트 위치
    - 메인 경로 polyline과 Breezewatch 풍차 최상단(y 64) → `lm_elderbough`(y 14) 활강 구간 데이터
    - `tests/unit/worldLayout.test.ts`: polyline 길이를 다시 계산해 Challenge_Area 입구 3곳 모두 ≤ 1,080 m, 활강비 3.6 기준 필요 낙차 ≤ 가용 낙차, 소요 시간 ≤ Stamina 100 ÷ 6/s
    - _Requirements: 8.1, 8.8, 5.1_
  - [x] 2.2 TerrainField 생성과 지형 질의
    - `src/world/terrain`의 순수 `buildTerrain(seed)`: region mask(40 m smoothstep, 합 1 정규화) 가중합으로 Verdant fBm 언덕·terrace, Ember mesa·협곡·chasm, Azure plateau·ridged 봉우리를 만들고 seed noise를 더한다
    - 국소 carving(crater bowl, Elderbough 함몰지 y −10, `lake_azure`·`pond_verdant`, 강), r 470–540 외곽 ring 산맥, key location pad 평탄화 후 `Float32Array(561 * 561)`에 한 번 샘플링
    - `heightAt`(bilinear)·`normalAt`·`slopeDeg`·`materialAt`·`waterDepthAt`·`insideBoundary`·`walkable` + unit tests(같은 seed 동일 배열, pad 높이 계약값, 생성 300 ms 미만)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 1.10_
  - [x] 2.3 충돌 primitive, spatial hash, 공간 질의
    - `src/physics`: `aabb`·`obb`·`cylinder`·`sphere`·`capsule` `ColliderShape`과 `ColliderFlags`(`climbable`·`walkableTop`·`blocksCamera`·`material`·`hazard`·`oneWay`), 16 m 셀 static spatial hash와 dynamic 리스트
    - `CollisionWorld`의 `sweepCapsule`·`overlapCapsule`·`raycast`(1 m march + 이분 탐색)·`groundProbe`·`closestSurface`가 heightfield와 collider를 함께 검사하고, NaN·Infinity 결과는 버리고 직전 값을 쓴다
    - 1 m 미만 장식은 blocking collider 없음, 시각 displacement는 collider 안쪽 0.15 m 이내 + primitive별 교차·법선, hash 셀 경계, NaN 방어 unit tests
    - _Requirements: 20.1, 20.3, 18.9, 16.7_
  - [x] 2.4 `stepController` 지상 이동
    - `src/player/core`(three 미사용): Grounded(Idle·Walk·Run·Sprint)·Jump·Fall·Landing·Dodge·Slide 전이, 달리기 6·걷기 2.5·질주 9 m/s, 점프 1.4 m(중력 25 m/s²)·공중 제어 60%, 낙하 상한 40 m/s, 12 m 이상 착지 0.4 s 경직, Dodge 0.35 s·4 m, 코요테 0.1 s
    - 캡슐(r 0.4 m, h 1.75 m) collide-and-slide 최대 4회·skin 0.01 m, 0.45 m 턱 오르기, 0.3 m ground snap, 경사 ≤ 50° 보행·50–65° 미끄러짐, `y ≥ heightAt` clamp, NaN 틱 폐기, `ControllerEvent` 반환
    - `CollisionResolve`의 적·NPC 겹침 0.2 s 이내 분리 + unit tests(점프 최고점, 벽 슬라이드, 경사 분류, 턱 오르기, 분리 시간)
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 20.2_
  - [x] 2.5 Property 27 속성 테스트: 지형 위 유지와 턱 오르기
    - **Property 27: 지형 위 유지와 턱 오르기**
    - **Validates: Requirements 20.1, 16.7**
    - `tests/property/terrainStepUp.property.test.ts`(태그 `// Feature: skyshard-echoes-of-the-wild, Property 27: 지형 위 유지와 턱 오르기`, `numRuns` ≥ 100): 임의 seed·시작 위치·입력 시퀀스에서 매 틱 `y ≥ heightAt(x, z)`이고 0.45 m 이하 턱은 오른다
  - [x] 2.6 Property 13 속성 테스트: 고정 스텝의 프레임률 독립성
    - **Property 13: 고정 스텝의 프레임률 독립성**
    - **Validates: Requirements 1.9**
    - `tests/property/fixedStep.property.test.ts`(태그 `// Feature: skyshard-echoes-of-the-wild, Property 13: 고정 스텝의 프레임률 독립성`, `numRuns` ≥ 100): 30–144 fps 임의 프레임 간격으로 같은 입력을 재생하면 이동 거리·점프 높이 차이가 5% 이내
  - [x] 2.7 Camera 시스템: 궤도 추적, 충돌 보정, 흔들림
    - `src/camera`: 어깨 오프셋 target 궤도 추적(기본 5.5 m, 휠 3–8 m, pitch −60°…+75° clamp), 마우스(pointer lock 중)·방향키(yaw 150°/s, pitch 90°/s)·오른쪽 스틱 회전, 감도·`invertY` 적용
    - 반경 0.25 m sphere-cast(heightfield + `blocksCamera`)로 0.1 s 안에 당기고 0.5 s ease-out 복귀, 최소 0.6 m·지면 +0.3 m 보정, 1.0 m 미만이면 캐릭터 35% 반투명(1.2 m에서 복귀)
    - `addTrauma` 흔들림(`trauma²`, 초당 1.6 감소)에 설정 강도 배율(0%면 없음), 순간 이동 snap + unit tests(pitch clamp, 충돌 거리, 흔들림 0%)
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 35.8_
  - [x] 2.8 지형 청크 렌더, 임시 캐릭터 표시, 입력·컨트롤러·카메라 연결
    - `src/render`: 64 m 청크 terrain mesh(`materialAt` 기반 임시 정점 색)와 임시 캡슐 캐릭터(작업 19.2에서 rig로 교체)
    - `src/main.ts`에서 InputSample → `stepController` → 보간 → Camera → 렌더 순으로 연결하고, 이동 방향은 카메라 `yaw` 기준으로 계산
    - _Requirements: 8.1_
  - [x] 2.9 RecoverySystem: Safe_Position 기록과 복귀
    - `src/player/recovery.ts` Safe_Position 8칸 ring buffer: 1초마다 grounded·walkable·비전투일 때만 기록(물·hazard·움직이는 발판 제외)
    - 지형 아래(`heightAt` − 2 m)·경계 밖(r > 490 m)·정체 낙하(2초 이상 |Δy| < 0.1 m) → 0.35 s fade-out·복귀·0.35 s fade-in(막힌 항목은 이전 항목), 적은 스폰 위치로, Pause "끼임 해제"도 같은 경로
    - `RestorableObject` 레지스트리(1초 invalid → 5초 안 원위치·초기 상태) + unit tests(복귀 사유별 위치, 1초 이내 완료, 막힌 항목 건너뜀)
    - _Requirements: 20.4, 20.5, 20.6, 20.7, 20.8, 2.5_

- [x] 3. Checkpoint - 지형 위를 걷고 뛰고 점프하며 카메라가 지형을 통과하지 않는지 확인
  - 모든 테스트와 빌드가 통과하는지 확인하고, 질문이 있으면 사용자에게 묻는다.

- [x] 4. 최소 전체 경로 (M2)
  - [x] 4.1 GameState·RuntimeState 골격과 New Game 초기 상태 팩토리(seed, Kairen만 합류, Thistlewick 배치)
    - `src/logic/save`에 저장 스키마 v1 `GameState`(`quests`·`skyshards`·`altarActivated`·`party`·`inventory`·`discovery`·`world`·`respawn`·`stats`·`debugUsed` 등 Req 36.2 매핑 필드 전체)를 정의하고, UI·Render에는 `DeepReadonly<GameState>`만 넘긴다
    - 저장하지 않는 `RuntimeState`(Energy, Cooldown, Stamina, 적·투사체·보스 런타임)는 `createRuntimeState(gameState)`가 `GameState`와 content 데이터에서 새로 만든다
    - `createNewGameState(seed)`는 `ms1` 첫 Objective, Skyshard 0, `party.joined = ['kairen']`, 레벨 1, `con_herbDumpling` 3개로 시작하고 시작 위치를 Thistlewick(중심 (−250, 300), 지면 y 18) 마을 어귀, `respawn`을 Thistlewick Hearth로 두며, 같은 seed의 두 결과가 deep-equal인지 `tests/unit`에서 확인한다
    - _Requirements: 36.2, 2.1_
  - [x] 4.2 퀘스트 모델·`questReducer`·Main_Quest 10단계 데이터(모든 Objective, trigger, category, marker) + 데이터 테스트(단계당 Objective ≥ 2, category ≥ 2) + 전체 경로 재생 unit test
    - `src/logic/questReducer.ts`에 `QuestDef`·`QuestState`·`QuestEvent`·`QuestEffect`와 순수 `questReducer`를 구현한다: 현재 Objective만 대조하고, 일치하면 같은 호출에서 다음 Objective를 활성화하며, 단계 완료 효과는 `hud:stageComplete` → `onComplete` → `save` → 다음 `onStart` → `hud:objective` 순서로 낸다. 불일치 이벤트는 같은 state 객체와 `log` 하나만 반환하고, 메인 판정은 `side`를 읽지 않는다
    - `src/data/quests.ts`에 표 D의 `ms1`–`ms10` 전체 Objective(trigger, category, marker, Landmark·환경 단서 이름이 든 `text`)와 단계별 `onStart`·`onComplete`를 넣고, `src/quest` 어댑터가 EventBus 이벤트를 발생 순서대로 `QuestEvent`로 바꿔 효과를 HUD·World·Party 등에 적용한다
    - `tests/unit`에 데이터 테스트(`ms1`–`ms10` 순서 10개, 단계당 Objective ≥ 2·category ≥ 2, 모든 `text`에 Landmark·환경 단서 어휘)와, 표 D의 trigger를 순서대로 재생해 `main.done === true`와 단계별 효과 순서를 확인하는 전체 경로 재생 테스트를 작성한다
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.9_
  - [x] 4.3 Property 14 속성 테스트: 퀘스트 단계 전이 규칙
    - **Property 14: 퀘스트 단계 전이 규칙**
    - **Validates: Requirements 3.1, 3.2, 3.4**
    - `tests/property/questTransition.property.test.ts`에 `arbQuestEvents` 생성기로 작성하고 태그 주석 `// Feature: skyshard-echoes-of-the-wild, Property 14: 퀘스트 단계 전이 규칙`을 달며, `numRuns` ≥ 100(기본 200)으로 실행한다
  - [x] 4.4 Property 15 속성 테스트: Side_Quest와 무관한 메인 진행
    - **Property 15: Side_Quest와 무관한 메인 진행**
    - **Validates: Requirements 3.9, 15.5**
    - `tests/property/mainQuestIndependence.property.test.ts`에 메인 열 사이에 Side_Quest 이벤트를 끼워 넣은 열, 뺀 열, Side_Quest 정의를 뺀 `def`의 최종 `main`을 비교하도록 작성하고 태그 주석 `// Feature: skyshard-echoes-of-the-wild, Property 15: Side_Quest와 무관한 메인 진행`을 달며, `numRuns` ≥ 100(기본 200)으로 실행한다
  - [x] 4.5 월드 트리거와 상호작용: area/discovery 볼륨과 'area:entered', 2.5 m 상호작용 대상 선택과 prompt, GateSystem(gate·veil·seal을 Skyshard 수에서 파생), Resonance_Altar와 Starlit_Stair 생성, 계단 추락 복귀
    - `area`·`discovery` 볼륨은 플레이어가 있는 hash 셀과 인접 셀만 검사해 `'area:entered'`(`first`로 첫 진입 구분)·`'landmark:discovered'`를 발행하고, 첫 Region 진입 때 3 s title card를 띄운다. 조작 캐릭터 2.5 m 안의 가장 가까운 대상에 이름과 현재 바인딩 `interact` 키가 든 prompt를 띄우고 `'interact'`(`targetKind`, `targetId`)를 발행한다
    - `GateSystem.refresh(skyshards)`가 `gate_ember`·`veil_ember`(Skyshard ≥ 1)와 `gate_azure`·`veil_azure`(≥ 2)의 개방을 GameState에서 매번 다시 계산해 `'barrier:opened'` → shatter VFX → collider 제거 순서로 열고, 닫힌 gate 앞에서는 "Skyshard n/필요 수" 문구를 보인다
    - Skyshard 3 이후 Resonance_Altar 위에 빛기둥을 세운다. `seal_sanctum`(r 70)은 활성화 전까지 Sanctum 진입을 막다가 `altarActivated`가 켜지면 제거되고 Starlit_Stair 발판·starlit updraft 2개가 생기며, 마지막으로 밟은 발판보다 10 m 이상 떨어지면 `restorePlayer('stairFall')`로 fade 후 그 발판 위에 복귀시킨다
    - _Requirements: 4.5, 4.6, 4.9, 5.2, 5.3, 5.5, 5.6, 8.7, 14.3_
  - [x] 4.6 전투 골격과 피해 공식: AttackDef/HitEvent/HitShape 런타임, `computeDamage`, Kairen Normal_Attack, 단순 적(Bramblekin) 피격·사망
    - `src/combat`에 `AttackDef`·`HitEvent`·`HitShape` 런타임을 둔다: clip 시작 기준 `t`에 판정하고 한 `HitEvent`에서 같은 대상은 한 번만 맞히며, `comboWindow` 안의 `consume('attack')`으로 다음 타격을 잇고, 명중은 대상 상태 샘플링 → `computeDamage` → HP 적용 순서로 처리한다
    - `src/logic/damage`에 순수 `computeDamage`(레벨당 1.06 복리 유효 공격력, `defFactor = 100 / (100 + def)`, `rng < critChance`면 ×1.5, 최종 `max(1, round(...))`)와 `staggerGain`을 두고, 적→플레이어 피해도 `kind: 'enemy'`·`critChance: 0`으로 같은 함수를 쓴다
    - `atk_kairen_n1`–`atk_kairen_n4`(0.9/1.0/1.1/1.6×, 타격 시점 0.18/0.20/0.22/0.30 s)와 `bramblekin`(HP 180, ATK 40, DEF 20, 2연속 할퀴기 `atk_bramblekin_claw`, Telegraph 0.4 s)의 단순 추격·공격·피격·사망을 연결해 사망 시 `'enemy:defeated'`, 그룹 전멸 시 `'camp:cleared'`를 발행하며, 이 골격은 이후 작업 6·7이 확장한다
    - _Requirements: 24.1, 24.10, 28.10_
  - [x] 4.7 Property 10 속성 테스트: 피해 공식의 하한·단조성·치명타 배율
    - **Property 10: 피해 공식의 하한·단조성·치명타 배율**
    - **Validates: Requirements 24.10**
    - `tests/property/damageFormula.property.test.ts`에 `arbDamageInput`으로 정수 하한 1, `baseAtk`·`dmgMul`·`def` 단조성, 치명타 1.5배(차이 ≤ 1)를 검사하도록 작성하고 태그 주석 `// Feature: skyshard-echoes-of-the-wild, Property 10: 피해 공식의 하한·단조성·치명타 배율`을 달며, `numRuns` ≥ 100(기본 200)으로 실행한다
  - [x] 4.8 최소 UI: ScreenManager, Title(New Game/Continue), HUD Objective 문구와 Skyshard n/3, 기본 Victory·Defeat 화면
    - `src/ui`에 Screen stack과 화면별 입력 컨텍스트를 관리하는 `ScreenManager`를 두고 Loading 뒤 Title을 stack 바닥에 push한다. Title은 첫 입력(메뉴 선택으로 처리하지 않음) 뒤 "새로 시작"·"이어하기"(저장 데이터가 없으면 비활성)를 열고, 시작하면 stack을 비운 뒤 Gameplay HUD를 push한다
    - HUD에 추적 퀘스트의 현재 Objective 문구와 "Skyshard n/3"을 표시해 `hud:objective`·`skyshard:acquired`를 받으면 1 s 안에 갱신하고, 화면 문구는 한국어로 쓰되 고유명사만 영어로 둔다
    - `'party:wipe'`를 받으면 Defeat("마지막 부활 지점에서 다시 시작")를, `cin_ending`의 `cinematic:ended`를 받으면 Victory(`VictoryView` 기본 통계와 "탐험 계속"·"메인 메뉴")를 push하고, 선택은 `UiCommand`로 넘긴다
    - _Requirements: 31.1, 31.3, 32.1, 7.3, 7.4_
  - [x] 4.9 전체 경로 연결: 단순화한 세 Challenge_Area 핵심 경로, Skyshard 획득과 게이트 개방, Resonance_Altar 활성화, 단순 Caelith(3 Phase 임계치와 기본 공격 2종), Victory 화면까지 실제 플레이 가능하게 연결
    - Hollowroot·Cinderspire·Observatory마다 입구에서 Skyshard 방까지 핵심 경로만 단순 prefab·collider로 두고, 아직 없는 퍼즐·Elite·대화·연출은 단순 상호작용·단순 적 그룹·바로 끝나는 임시 연출로 대신하되 4.2 데이터와 같은 trigger id를 발행해 이후 작업이 퀘스트 데이터를 바꾸지 않고 교체하게 한다
    - Skyshard 받침대의 `interact`는 `'skyshard:acquired'`(index 1–3)를 발행해 `skyshards` 증가, HUD n/3 갱신, `GateSystem.refresh`로 이어지고, 3개를 모두 모으면 Resonance_Altar의 `interact`가 `'altar:activated'`와 단순 활성화 연출을 거쳐 Starlit_Stair를 연다
    - `src/logic/boss.ts`의 `bossPhaseFor(hpRatio, current)`(임계치 0.65·0.30, 임계값에서 HP 고정, Phase 비감소)와 Telegraph가 있는 `atk_caelith_slashCombo`·`atk_caelith_starShards`만 쓰는 단순 Caelith를 두고, `'boss:defeated'` → `cin_ending` → Victory가 디버그 기능 없이 이어지게 한다
    - _Requirements: 2.1, 2.9, 4.1, 4.3, 5.4, 6.1_

- [x] 5. Checkpoint - Title부터 Victory까지 최소 전체 경로를 실제로 완주할 수 있는지 확인
  - 모든 테스트와 빌드가 통과하는지 확인하고, 질문이 있으면 사용자에게 묻는다.

- [x] 6. 파티·전투·속성 (M3)
  - [x] 6.1 Party_System: 슬롯 순서, 합류, `canSwitch` 규칙과 0.8 s 교체 잠금, 위치·방향·속도 인계, 진행 중 동작 취소·설치 효과 유지, 대기 중 Cooldown 진행, Downed 0.8 s 후 자동 교체, 전멸 판정
    - `src/logic/party.ts`에 `canSwitch`(notJoined → downed → active → context → cooldown 순, 잠금 0.8 s)·`nextActiveOnDowned`·`isWipe`를 두고, `src/party`가 slot 순서(`kairen`·`isla`·`wren`·`talus`), joined flag의 `'party:joined'`, 캐릭터별 HP, 거부 시 HUD slot 흔들기와 잠금 잔여 시간을 맡는다
    - 승인 시 `'party:switched'`와 함께 위치·yaw·속도(수직 성분 포함)를 0.1 s 안에 인계하고, 진행 중 공격·차지·Skill은 취소하되 발사된 projectile·설치 효과는 snapshot 수치로 유지하며 대기 slot Skill Cooldown은 매 틱 감소한다
    - HP 0이면 `'party:downed'` 후 0.8 s 동안 입력·추가 피해를 막고 잠금·context를 건너뛴 자동 교체(잠금 재시작), 전멸이면 `'party:wipe'`를 발행한다. 예시 테스트 `tests/unit/party.test.ts`: 0.79 s 거부·0.8 s 허용, 활강 중 `context` 거부, 대기 Cooldown 경과, 교체 뒤 적 표식 유지
    - _Requirements: 22.1, 22.2, 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.8, 27.1, 27.2, 27.3_
  - [x] 6.2 Property 16 속성 테스트: 파티 교체 규칙
    - **Property 16: 파티 교체 규칙**
    - **Validates: Requirements 23.1, 23.2, 23.3, 23.4, 23.5**
    - `arbPartyState`·대상·`now`·`SwitchContext`를 생성해 위반이 없을 때만 허용되고 거부 사유가 판정 순서의 첫 위반과 같은지, 교체 적용 전후 적 Element_Mark·설치 효과가 같은지 확인
    - `tests/property/partySwitch.property.test.ts`, 태그 `// Feature: skyshard-echoes-of-the-wild, Property 16: 파티 교체 규칙`, `numRuns: 200`
  - [x] 6.3 Property 17 속성 테스트: Downed 자동 교체와 전멸 판정
    - **Property 17: Downed 자동 교체와 전멸 판정**
    - **Validates: Requirements 27.1, 27.2, 27.3**
    - `arbPartyState`의 HP 변화 열을 적용해 HP 0 캐릭터는 Downed, `nextActiveOnDowned`는 현재 slot 다음부터 순환한 첫 합류·비Downed 캐릭터(없으면 null), `isWipe`는 합류 캐릭터 전원 Downed일 때만 참인지 확인
    - `tests/property/partyDowned.property.test.ts`, 태그 `// Feature: skyshard-echoes-of-the-wild, Property 17: Downed 자동 교체와 전멸 판정`, `numRuns: 200`
  - [x] 6.4 전투 액션 런타임: hit 판정 도형·대상별 1회 판정, 조준 보조(5 m·60°), Isla 조준(30°·25 m), 투사체 풀(swept sphere), Charged_Attack(0.4 s), Dodge 무적 0.25 s·Perfect_Dodge 슬로우, 후딜 Dodge 취소, Lock-on과 전투 프레이밍
    - `src/combat`이 `HitEvent`를 clip 기준 `t`에 arc·sphere·capsule·groundCircle(`delay`)·projectile로 판정해 한 HitEvent에서 대상당 1회만 맞히고, `comboWindow` 연계, `heldTime('attack') ≥ 0.4` 해제 시 Charged_Attack, `appliesElement` 명중의 `applyElement` 호출을 처리한다
    - 근접은 5 m·60° 최근접 적으로 0.1 s 안에 yaw 보정, Isla는 Lock-on → 30°·25 m 원뿔 → 카메라 ray 순으로 조준하고 projectile은 pool의 swept sphere로 벽 관통을 막는다. Dodge는 0.25 s i-frame, `dodgeCancelFrom` 이후 후딜 취소, Dodge당 1회 `'perfectDodge'`와 `setTimeScale('perfectDodge', 0.3, 0.5)`를 적용한다
    - `src/camera`에 Lock-on(20 m·가림 없는 적 중 정면 각 최소, ±20° look, 재입력 해제, 대상 없으면 0.3 s 정면 복귀, 처치·25 m 이탈 시 해제)과 전투 거리·화면 밖 Telegraph 투영을 둔다. 예시 테스트 `tests/unit/combat.test.ts`: 대상별 1회 판정, 조준 대상 선택, 고속 화살 벽 관통 없음(Mossback 정면 방어는 작업 7)
    - _Requirements: 24.1, 24.2, 24.3, 24.8, 24.9, 24.11, 24.12, 24.13, 20.3, 38.6, 21.5, 21.6, 21.7, 21.8_
  - [x] 6.5 Energy·Cooldown 규칙(`energyGain`, `addEnergy`, `canBurst`), Skill Cooldown 시작, Burst 1.0 s 무적 연출, 거부 피드백
    - `src/logic/energy.ts`에 `energyGain`(normalHit 1·chargedHit 3·skillCastHit 6·reaction 5·perfectDodge 10), Burst 비용으로 자르는 `addEnergy`, `canBurst`를 두고 Normal·Charged `energyOnHit`를 데이터 로드 시 채워 발생 시점 Active_Character에게 지급한다
    - `skill`은 Cooldown 0일 때 발동해 표 A Cooldown을 simTime으로 시작하고, `burst`는 Energy 0 초기화·`'burst:cast'`·1.0 s 이하 cut-in 무적을 적용한다. Cooldown 중 Skill과 Energy 부족 Burst는 HUD 아이콘 강조와 거부 효과음만 낸다
    - 예시 테스트 `tests/unit/energy.test.ts`: Skill 발동 시 Cooldown 시작, 만료 직전 거부·만료 시각 허용, 대기 캐릭터 Cooldown 경과, 최대치를 채운 명중 직후 Burst 허용
    - _Requirements: 24.4, 24.5, 24.6, 24.7_
  - [x] 6.6 Property 11 속성 테스트: Energy 획득과 Burst 규칙
    - **Property 11: Energy 획득과 Burst 규칙**
    - **Validates: Requirements 24.6, 24.7**
    - `arbEnergyEvents`의 이벤트·Burst 시도 열과 Burst 비용(60·70)으로 누적 Energy가 마지막 Burst 이후 획득량 합을 비용으로 자른 값과 같고, Burst는 `canBurst`가 참일 때만 발동해 직후 0이 되는지 확인
    - `tests/property/energy.property.test.ts`, 태그 `// Feature: skyshard-echoes-of-the-wild, Property 11: Energy 획득과 Burst 규칙`, `numRuns: 200`
  - [x] 6.7 캐릭터 키트 데이터(`src/data/characters.ts`: 4명 스탯, Normal·Charged·Skill·Burst AttackDef, 패시브, 강화 3단계) + 역할 제약 데이터 테스트
    - 스탯(HP/공격력/방어력) Kairen 1000/120/50·Isla 900/100/45·Wren 950/95/50·Talus 1300/85/80, `atk_<owner>_<name>` AttackDef(타격 시점·판정 형태·배율·Element 타격), Skill Cooldown 8/9/10/12 s, Burst 비용 60/60/70/70, Stamina 패시브를 정의한다
    - Skill·Burst 강화 1–3단계는 누적(같은 능력 피해 증가는 합산)되며 단계마다 피해 증가나 효과 확장을 하나 이상 담아 강화 화면이 변경 내용을 표시할 수 있게 한다
    - 데이터 테스트 `tests/unit/characters.test.ts`: Talus 최대 HP ≥ 다른 셋 평균의 130%, Kairen 근접 공격력 최고, Isla Normal_Attack 사거리 25 m, Wren Skill 반경 최대, 모든 강화 단계의 변경 내용 존재, `dodgeCancelFrom ≤ recoveryFrom`
    - _Requirements: 22.1, 22.4, 29.5_
  - [x] 6.8 Element 규칙(`reactionFor`, `applyElement`, `previewReaction`): 8 s 표식, 갱신, 반응과 표식 소모, Element_Shield 배율, 빈도 제한, 표식 효과, Terra 반응 보호막
    - `src/logic/element.ts`에 대칭 `reactionFor`, 입력을 바꾸지 않는 `applyElement`(방어막 → 표식 없음·만료 → 같은 Element 갱신 → 다른 Element Reaction·표식 소모 → 같은 Reaction 1 s 제한), 상태를 바꾸지 않는 `previewReaction`, 확산(5 m)·BFS 연쇄(깊이 4)용 순수 `resolveSpread`를 둔다
    - `src/data/elements.ts`·`reactions.ts`에 Element별 아이콘 형태·색상과 표 B를 두고, `src/element`가 방어막 ×0.25·×3.0과 내구도 0 파괴(3 s Stagger), 표식 효과(Ember 5%/s 지속 피해, Tide 이동 −20%, Gale 넉백 +50%, Terra Stagger +50%), Terra Reaction 보호막(최대 HP 8%·5 s, 중첩 없이 갱신)을 적용한다
    - 예시 테스트 `tests/unit/element.test.ts`: 표 B 6조합의 ReactionId, 표식 만료 시각 경계, 방어막 파괴 뒤 3 s Stagger와 정확한 해제 시각, Terra 보호막 비중첩
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.8, 25.10, 25.11, 25.12_
  - [x] 6.9 Property 5 속성 테스트: Reaction 표의 완전성과 대칭성
    - **Property 5: Reaction 표의 완전성과 대칭성**
    - **Validates: Requirements 25.5**
    - `arbElementPair`의 서로 다른 `a`·`b`에서 `reactionFor(a, b)`와 `reactionFor(b, a)`가 표 B의 같은 Reaction(null 아님)이고, 방어막·속도 제한 없는 유효 `a` 표식 대상에 `b`를 적용하면 `reaction`·`consumed: a`·`next.mark = null`인지 확인
    - `tests/property/reactionTable.property.test.ts`, 태그 `// Feature: skyshard-echoes-of-the-wild, Property 5: Reaction 표의 완전성과 대칭성`, `numRuns: 200`
  - [x] 6.10 Property 6 속성 테스트: 같은 Element 재적용 시 표식 갱신
    - **Property 6: 같은 Element 재적용 시 표식 갱신**
    - **Validates: Requirements 25.2, 25.3**
    - Element `e`와 경과 시간 0 ≤ d < 8 s를 생성해 `e` 표식 대상에 `e`를 다시 적용하면 Reaction 없이 `refreshed`·`expiresAt = now + 8`이고, 표식 없음·만료 대상은 `marked`와 새 8 s 표식인지 확인
    - `tests/property/elementRefresh.property.test.ts`, 태그 `// Feature: skyshard-echoes-of-the-wild, Property 6: 같은 Element 재적용 시 표식 갱신`, `numRuns: 200`
  - [x] 6.11 Property 7 속성 테스트: Reaction 발생 빈도 제한
    - **Property 7: Reaction 발생 빈도 제한**
    - **Validates: Requirements 25.8**
    - `arbElementSeq`의 시각 오름차순 적용 열을 차례로 처리해 같은 Reaction(방어막 발생 포함)의 연속 발생 간격이 1 s 이상이고 `limited` 결과는 표식·방어막을 바꾸지 않는지 확인
    - `tests/property/reactionRateLimit.property.test.ts`, 태그 `// Feature: skyshard-echoes-of-the-wild, Property 7: Reaction 발생 빈도 제한`, `numRuns: 200`
  - [x] 6.12 Property 8 속성 테스트: 확산 반경과 연쇄 상한
    - **Property 8: 확산 반경과 연쇄 상한**
    - **Validates: Requirements 25.6, 25.7**
    - 적 배치·표식과 확산 Reaction을 생성해 `resolveSpread`가 5 m 이내 다른 적에게만 확산 Element를 적용하고, 추가 Reaction은 다른 표식(방어막 Element 포함) 수신자에서만 생기며, 보고 연쇄 수 n이 실제 Reaction 수와 같고 깊이 ≤ 4인지 확인
    - `tests/property/reactionSpread.property.test.ts`, 태그 `// Feature: skyshard-echoes-of-the-wild, Property 8: 확산 반경과 연쇄 상한`, `numRuns: 200`
  - [x] 6.13 Property 9 속성 테스트: Element_Shield 배율과 표식 유지
    - **Property 9: Element_Shield 배율과 표식 유지**
    - **Validates: Requirements 25.10, 6.4**
    - 방어막 Element `s`와 적용 Element `e`를 생성해 `e = s`면 `shieldHit`(`reaction: null`, `shieldMul: 0.25`), 제한에 걸리지 않은 `e ≠ s`면 `shieldHit`(`reactionFor(s, e)`, `shieldMul: 3.0`)이고 `next.shield.element`가 항상 `s`인지 확인
    - `tests/property/elementShield.property.test.ts`, 태그 `// Feature: skyshard-echoes-of-the-wild, Property 9: Element_Shield 배율과 표식 유지`, `numRuns: 200`
  - [x] 6.14 Reaction 효과 런타임(폭발, 용암 지대, 속박, 확산·연쇄, 연쇄 표시), ElementReceiver 인터페이스(가시덤불, 화로, 과열 수정, 불 장애물, 바람개비, 금 간 바위, 압력판, 불안정 수정), 반응 예고 아이콘 데이터, 속성 반응 도감 기록
    - `src/element`가 steamBurst(3 m, 대상 +150%·주변 60%, 1 s Stagger, Hit_Stop 70 ms)·lavaRift(3 m·4 s, 0.5 s마다 공격력 25%)·mudBind(4 m·2.5 s 이동 불가)·확산 3종(`resolveSpread`, 공격력 80% 또는 3 s 40% 둔화)을 실행하고 고유 VFX·효과음·한국어 이름, Energy +5, 연쇄 n ≥ 2의 "연쇄 x{n}" 1.5 s를 낸다
    - `ElementReceiver`(`accepts`, `onElement`)를 적과 같은 타격 판정에 연결해 brambleGate·brazier·heatCrystal(10 s 냉각·climbable)·fireObstacle·windWheel·crackedBoulder(terra·Charged_Attack)·pressurePlate(무게)·unstableCrystal(1 s Telegraph 후 4 m 폭발)을 구현하고, Lock-on 대상(없으면 가장 가까운 표식 적) 기준 대기 slot별 `previewReaction` 아이콘 데이터와 첫 Reaction의 `GameState.codex` 기록을 더한다
    - 예시 테스트 `tests/unit/reactions.test.ts`: 표 B 6조합의 고정 입력 피해 수치와 부가 효과(증기 폭발 150%·1 s Stagger, 진흙 속박 4 m·2.5 s 등), 수신자별 허용·거부 Element, 도감 중복 기록 없음
    - _Requirements: 25.6, 25.7, 25.9, 25.13, 13.1, 13.8, 13.9, 23.9_
  - [x] 6.15 Stamina 규칙(`stepStamina`, `canStart`, 캐릭터 패시브, Exhausted 30% 히스테리시스)과 컨트롤러 연결
    - `src/logic/stamina.ts`에 파티 공유 `stepStamina`(dodge·climbLeap 정액 20, sprint 18·climbMove 10·climbIdle 2·glide 6·swim 6 /s, 1 s 무소모 뒤 25/s 회복, 0에서 `exhausted`, `value ≥ 0.3 × max`에서 해제)와 exhausted 중 swim 외 6종을 거부하는 `canStart`를 둔다
    - 호출 시점 Active_Character 패시브(Kairen sprint ×0.8, Talus 등반 ×0.75, Wren glide ×0.7, Isla swim ×0.6)를 적용하고, `stepController`가 모드를 `StaminaActivity`로 요약해 호출하며 `exhausted` 이벤트와 HUD 링(`value < max` 동안 표시, 최대 도달 2 s 뒤 숨김)을 연결한다
    - 예시 테스트 `tests/unit/stamina.test.ts`: Kairen 질주 14.4/s, 1 s 무소모 뒤 25/s 회복, 0 진입·30% 해제, 교체 시 값 유지와 다음 틱 패시브 전환
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6_
  - [x] 6.16 Property 12 속성 테스트: Stamina 경계와 Exhausted 히스테리시스
    - **Property 12: Stamina 경계와 Exhausted 히스테리시스**
    - **Validates: Requirements 17.2, 17.3, 17.4**
    - `arbStaminaTimeline`의 활동·캐릭터·`dt` 열을 적용하는 동안 `0 ≤ value ≤ max`이고, 0 도달 뒤 `exhausted`가 `value ≥ 0.3 × max` 전까지 유지되며 그동안 `canStart`가 swim 외 6종에 false인지 확인
    - `tests/property/stamina.property.test.ts`, 태그 `// Feature: skyshard-echoes-of-the-wild, Property 12: Stamina 경계와 Exhausted 히스테리시스`, `numRuns: 200`

- [x] 7. 적과 AI (M4)
  - [x] 7.1 적·Elite 데이터(`src/data/enemies.ts`: 8종 + Elite 6체, 스탯, 감지, 사거리, 공격과 Telegraph, 약점, poise, XP·Glim·드롭, Region 레벨) + Mossback Brute 정면 방어·방어 파괴 unit test
    - 8종마다 기준 레벨 수치(HP·ATK·DEF·이동·사거리·감지), `atk_<owner>_<name>` 공격(Telegraph 시간·강공격 여부·stagger 값), 약점, poise, XP·Glim, 적 ID별 드롭 보상표를 선언하고 archetype끼리 실루엣·이동·사거리·속도·HP·약점 중 3개 이상 다르게 구성한다
    - Region 레벨(`verdant` 1–3, `ember` 4–6, `azure` 6–8, `sanctum` 9)에 맞춰 HP는 레벨당 +10% 복리, ATK는 `computeDamage`의 `level = L − L₀ + 1`로 한 번만 보정하고, Elite는 숨겨진 3체가 기반 적 HP·ATK ×2.5·×1.3, 수호 3체가 보정 없는 절대값(`level = 1`)이며 추가 패턴과 소환 개체 공격을 함께 정의한다
    - `tests/unit`: 전방 120° 안 Normal_Attack 피해 70% 감소와 정면 밖 무감소, Ember 또는 Charged_Attack 명중 시 방어 파괴·3 s Stagger, Stagger 종료 후 방어 복구를 확인한다
    - _Requirements: 28.1, 28.9, 28.11, 8.9_
  - [x] 7.2 Property 22 속성 테스트: Telegraph 최소 시간(적·Elite 데이터 전체, 작업 10에서 Caelith 데이터 추가 시 함께 검증)
    - **Property 22: Telegraph 최소 시간**
    - **Validates: Requirements 6.9, 28.9, 26.5**
    - `tests/property/telegraph-minimum.property.test.ts`(피해를 주는 공격 정의 전체 순회 + 레벨 1–9 표본, 연속기는 타마다), 태그 주석 `// Feature: skyshard-echoes-of-the-wild, Property 22: Telegraph 최소 시간`, numRuns ≥ 100
  - [x] 7.3 AI FSM(`AI_TRANSITIONS`, `aiTransition`), 감지(120°·14 m, 6 m, 피격)와 0.5 s alert, 근거리 접근·원거리 8–14 m 유지와 시야 확인, leash·8 s 미감지 → return·회복, Stagger 누적 2 s, 80 m 밖 sleep·20 Hz 결정
    - `src/logic`에 9상태 `AiState`·`AI_TRANSITIONS`와 순수 함수 `aiTransition(from, to)`를 두어 표 밖 전이를 거부하고, idle·patrol에서 감지하면(return 중에는 피격만) alert로 전이해 'enemy:alerted'를 발행하고 0.5 s 동안 "!" 아이콘·경고음을 낸 뒤 chase로 간다
    - 근거리형은 사거리 안에서 토큰을 얻으면 attack, 원거리형은 8–14 m strafe 중 눈높이→가슴 `raycast`가 solid에 막히지 않을 때만 attack하고, 스폰 30 m 이탈이나 8 s 미감지면 return으로 HP 최대·stagger 미터 0을 복구한 뒤 도착 시 idle이 된다
    - 명중마다 공격의 stagger 값을 누적(Terra 표식 +50%)해 임계치(소형 100, Mossback Brute·Aether Sentinel 250, Elite 400)에서 2 s stagger로 전이하고, 80 m 밖은 결정·이동·타이머를 멈추며(추격 중이면 먼저 스폰 위치·최대 HP·idle로 리셋) 80 m 안은 `(tick + n) % 3 === 0`인 tick에만 결정 단계를 돌린다(20 Hz)
    - _Requirements: 28.2, 28.3, 28.4, 28.5, 28.12, 26.9_
  - [x] 7.4 Property 20 속성 테스트: AI 상태 전이 제한
    - **Property 20: AI 상태 전이 제한**
    - **Validates: Requirements 28.2**
    - `tests/property/ai-transition.property.test.ts`(`arbAiEvents`로 적 종류와 AI 이벤트 열 생성, `dead` 이후 불변 포함), 태그 주석 `// Feature: skyshard-echoes-of-the-wild, Property 20: AI 상태 전이 제한`, numRuns ≥ 100
  - [x] 7.5 `MeleeTokenPool`(최대 2), 1.2 m 분리 steering, 플레이어 캡슐 밀어내기, 절벽·장애물 probe와 2 s 정체 → return, 지형 아래·경계 밖 적 복귀
    - `acquire`는 보유 id면 true·만석이면 false, `release`는 미보유 id를 무시하며, 근거리 적은 attack 직전 토큰을 얻고 recovery 종료·stagger·dead·return 진입 시 반환한다(원거리형은 미사용)
    - 토큰이 없으면 플레이어 주위 4–6 m 고리를 id 홀짝 방향으로 선회하며 재요청하고, separation steering과 `CollisionResolve`로 적 간 수평 1.2 m(반지름 합이 더 크면 그 값)를 보장하며 플레이어 capsule과 겹친 적은 0.2 s 안에 밀어낸다
    - 0°·±40° 방향 1.5 m 앞 probe(낙차 > 2.5 m, `slopeDeg` > 50°, `waterDepthAt` > 1 m, 경계 밖, 허리 높이 `raycast` 충돌이면 막힘)로 열린 방향을 고르고, chase 중 2 s간 0.5 m 이상 못 좁히면 return, `heightAt`보다 2 m 아래이거나 중심 거리 > 490 m면 스폰 위치·idle로 리셋한다
    - _Requirements: 28.6, 28.7, 28.8, 20.2, 20.7_
  - [x] 7.6 Property 21 속성 테스트: 근접 공격 토큰 상한
    - **Property 21: 근접 공격 토큰 상한**
    - **Validates: Requirements 28.6**
    - `tests/property/melee-token.property.test.ts`(`arbTokenOps`로 `acquire`/`release` 호출 열 생성), 태그 주석 `// Feature: skyshard-echoes-of-the-wild, Property 21: 근접 공격 토큰 상한`, numRuns ≥ 100
  - [x] 7.7 적 공격 실행(Telegraph 후 판정, 무적 확인, 피해·넉백), 피격 반응, 사망 동작과 1.5 s 소멸, 드롭과 3 m 자동 흡수
    - `AttackDef`의 Telegraph 동안 Render·Audio에 Telegraph·준비음을 요청하고 끝난 뒤에만 판정하며, 겹친 Active_Character의 `iFrames`가 남아 있으면 무시하고 아니면 `computeDamage`(적 ATK·캐릭터 DEF) 피해와 공격 정의의 넉백을 적용한다
    - 명중마다 상태를 바꾸지 않는 0.2 s flinch를 재생하고, 한 번의 stagger 값이 poise 이상이면서 attack 중이 아니면 그동안 이동도 멈추며, 그 밖에는 덧입힘 동작만 재생해 Telegraph를 끊지 않는다
    - HP 0이면 dead로 전이해 토큰을 반환하고 사망 동작·dissolve VFX로 1.5 s 안에 모델을 제거하며, 'enemy:defeated'를 받은 Loot_System이 XP·Glim·확률 재료를 지급하고 드롭은 플레이어 3 m 안에서 끌려와 자동 획득된다
    - _Requirements: 28.10, 28.13, 26.6, 26.7_
  - [x] 7.8 스폰너·Enemy_Camp(잠긴 Chest → 'camp:cleared')·Elite 처치 지속, 빠른 이동·불러오기 후 배회 적 재배치, 전멸 후 해당 전투 적 초기화
    - `SpawnerDef`(`respawn: 'roaming' | 'never'`, `campId`)로 스폰하고, World가 캠프별 생존 수를 집계해 마지막 'enemy:defeated'에서 'camp:cleared'를 발행하면 Loot_System이 잠긴 Chest를 개방 가능으로 바꾸고 "캠프 소탕" 알림을 띄운다
    - 소탕된 `campId`와 처치된 `'never'` spawner(Elite 등)의 id를 GameState에 기록해 다시 스폰하지 않는다
    - 빠른 이동·불러오기 뒤 처치된 `'roaming'` 적을 스폰 위치에 최대 HP로 재배치하고 소탕 전 캠프는 전원 복구하며, Party_Wipe 재시작에도 같은 규칙을 쓰고 alert·chase·attack·recovery·stagger 상태였던 적은 스폰 위치·최대 HP·idle로 되돌린다
    - _Requirements: 10.7, 11.6, 27.4_

- [x] 8. Checkpoint - 여러 적이 감지·추적·공격·피격·사망하고 전투가 처음부터 처치까지 정상 진행되는지 확인
  - 모든 테스트와 빌드가 통과하는지 확인하고, 질문이 있으면 사용자에게 묻는다.

- [x] 9. 수직 탐험과 Challenge_Area (M5)
  - [x] 9.1 등반: 부착 조건(≥ 65°, 0.2 s), `closestSurface` 투영과 법선 정렬, 볼록·오목 모서리, 올라서기 0.45 s, 아래 등반 지면 감지, 도약, C 이탈·Stamina 고갈 낙하, 등반 불가 재질, 등반 중 전투·교체 무시
    - `src/player/core`의 `stepController`에 `climbAttach → climb ⇄ climbLeap` 전이와 `mantle`·`grounded`·`fall` 종료를 추가하고, 부착 시 속도 0·`climbStarted` 발행, `canStart(stamina, 'climbMove')` 거부 시 부착 생략, 등반 계열 모드에서 전투 입력 무시·교체 요청 거부
    - 매 틱 `closestSurface(chestPoint, 0.9, climbable)`의 최근접점 `p`·법선 `n`으로 가슴 지점을 `p + n * 0.45`에 두고 `n`을 0.1 s 보간해 yaw 정렬, 접평면 기저로 2 m/s 이동, 오목 모서리는 접선 sweep으로 인접 면 채택, 0.9 m 안에 표면이 없으면 `fall`
    - `mantle`은 머리 레이 빗나감·가슴 레이 적중·전방 1.2 m 상단 지면일 때, 아래 이동은 `groundProbe` 0.3 m에서 `grounded`, 점프는 입력 방향(없으면 위) 2 m `climbLeap`(Stamina 20); Blight 결정·봉인 벽·가열 Heat_Crystal은 `climbable` 제외, 1 m 미만 물체는 지상 이동
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10, 18.11_
  - [x] 9.2 Property 28 속성 테스트: 등반 표면 거리 유지
    - **Property 28: 등반 표면 거리 유지**
    - **Validates: Requirements 18.10, 18.3**
    - `arbConvexCollider`(박스·원기둥)와 `arbClimbInput`으로 `stepController`를 등반시키며 캡슐 중심과 표면 사이 거리가 0.3–0.5 m이고, 볼록 모서리에서도 collider 안으로 들어가거나 0.9 m 넘게 떨어지지 않음을 단언
    - `tests/property/climbSurface.property.test.ts`, 첫 줄 `// Feature: skyshard-echoes-of-the-wild, Property 28: 등반 표면 거리 유지`, `numRuns: 200`(최소 100)
  - [x] 9.3 활강과 기류: 전개 조건(지면 3 m 이상), 하강 ≤ 2.5 m/s·수평 9 m/s·Stamina 6/s, Updraft 8 m/s·Wind_Zone 4 m/s 볼륨과 시각·음향 표시, Wren Skill 6 m 상승, 종료 전이
    - 공중 점프 시 하향 `raycast`(최대 200 m)로 지면이 3 m 이상 아래이거나 없고 `exhausted`가 아니면 `glideDeploy`(0.3 s) → `glide`·`glideStarted`, 활강 중 `fallStartY`를 현재 높이로 갱신
    - 매 틱 `vy = max(vy, -2.5)` → Updraft(상단까지 `vy = +8`, 상단에서 `vy = 0`) → Wind_Zone(구역 방향 4 m/s 오프셋) → 최대 200°/s 수평 조향 순으로 계산, Wren은 소모 ×0.7, Wren Skill은 6 m 상승하되 위쪽 `raycast` 천장 아래에서 정지
    - 점프·C·Stamina 0 → `fall`, 지면 → `landing`, `depth ≥ 1.2 m` → `swim`, `climbable` → `climbAttach`로 끝내며 `glideEnded` 발행; 두 볼륨에 상승 입자·바람 줄기 VFX와 루프 바람음, 어댑터가 지면 높이·속도로 바람 세기(0–1)를 오디오에 전달
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9, 19.10_
  - [x] 9.4 수영·얕은 물: 깊이 판정, 얕은 물 −20%·물 튀김, 수면 수영 3.5 m/s·Stamina 6/s, 수영 중 고갈 시 Safe_Position 복귀
    - 매 틱 water 볼륨 질의로 `depth = level - terrainHeight`를 구하고 `depth < 1.2 m`면 `wading`으로 지상 속도 20% 감소, 걸음마다 `footstep{material: 'water'}`로 물보라 VFX·물 발소리 재생
    - `depth ≥ 1.2 m`면 `swim`·`enteredWater`로 전환해 중력을 끄고 머리가 수면 위에 오도록 캡슐을 `level` 기준 고정, Isla는 소모 ×0.6, `groundProbe` 0.5 m 이내 지면에서 `grounded` 복귀
    - 수영 중 Stamina 0이면 `locked`·`recoveryNeeded`를 내고 RecoverySystem이 페이드 후 마지막 Safe_Position으로 복원
    - _Requirements: 16.9, 16.10, 16.11_
  - [x] 9.5 Puzzle_Mechanism 시스템(single/allOf/sequence/weight, 0.2 s 피드백, 해결 저장, 순서형 실패 2 s 초기화, 단계×5 s 제한, 3회 실패 힌트, 반복 시도 가능)과 오픈월드 퍼즐 6종
    - `src/data/puzzles.ts`에 `PuzzleDef`(parts·order·timeLimitSec·hint·reward), `src/logic/puzzle.ts`에 순수 `stepPuzzle(def, rt, sig, now)`를 두고 씬 어댑터가 `ElementReceiver`·pressurePlate·도착 트리거를 `PuzzleSignal`로 변환, 부품에 필요한 Element 아이콘·색 표시
    - 올바른 입력은 같은 틱 `'progress'`(발광·개방, `'puzzle:progress'` 음), `'solved'`는 `'puzzle:solved'`·보상 또는 경로 개방·GameState 기록 후 입력 차단; 오답·시간 초과는 실패음 뒤 초기화, `accepted: false` 포함 3회째 실패에 `hint` 한 줄 표시
    - `pz_verdant_1`(화로 allOf)·`pz_verdant_2`(수문 Gale)·`pz_ember_1`(과열 문 Tide)·`pz_ember_2`(불안정 수정 벽 Ember)·`pz_azure_1`(풍경 sequence 15 s)·`pz_azure_2`(압력판 weight)를 Region당 2개씩 배치, 데이터 테스트로 `timeLimitSec ≥ order.length × 5` 검증
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 2.6_
  - [x] 9.6 Hollowroot Shrine: 함몰지 성소 R0–R6, Ember·Gale·Terra 퍼즐, 전투 방, Rootbound Warden, 체크포인트 2개, 추락·전멸 시 체크포인트 복귀, 획득 후 출구
    - `hollowroot_entrance`(y 14)에서 나선 뿌리 경사로로 바닥 y −10까지 내려가며 R1 `pz_hollowroot_1`(Ember 덤불)·R2 `pz_hollowroot_2`(Gale 바람개비 승강기)·R3 `pz_hollowroot_3`(weight 압력판 + Terra crackedBoulder) 배치, 초록 안개·발광 뿌리 조명과 `mus_area_hollowroot`
    - R4 잠김 전투 방(`bramblekin` ×4, `thornspitter` ×2), R5 Rootbound Warden arena(반경 14 m, 등 뒤 발광 뿌리 약점), R6 Skyshard 1 획득 후 추락 판정을 끄고 뿌리 승강기를 Elderbough 기슭 출구로 전환
    - 공용 체크포인트 룬(반경 2 m)으로 `cp_hollowroot_1`·`cp_hollowroot_2`를 `setCheckpointOverride`에 등록, `hazard`·경계 이탈은 1 s fade로, Party_Wipe는 Defeat Screen 뒤 HP 최대로 최신 체크포인트에 복귀; 해결 퍼즐·소탕 방·처치 Elite는 유지하고 진행 중 타이머·미소탕 전투는 초기화
    - _Requirements: 12.1, 12.4, 12.7, 12.8, 12.9_
  - [x] 9.7 Cinderspire: 필수 등반 3구간(각 12 m ≤ 기본 Stamina 70%)·휴식 발판, Updraft 2개, 활강 2구간, Tide로 식히는 과열 수정 벽, 불안정 수정 hazard, 정상 Cinder Alpha, 출구 수정 계단, 기본 Stamina로 통과 가능 검증
    - `src/data/challengeAreas.ts`에 기슭 경사로(y 6→20) → C1 → U1 → G1 → H1 → C3 → U2 → G2(정상 y 95) 경로, 폭 3 m 이상 휴식 발판 L1–L5, 반경 4 m Updraft, `cp_cinderspire_1`(L2)·`cp_cinderspire_2`(L4) 정의
    - H1 `pz_cinderspire_1`(allOf: 수정 벽 + L4 도착 트리거)은 Tide 적중 후 10 s `climbable`(2 s 남으면 주황 점멸, 재과열 시 L3로 낙하), U1·U2 입구 Unstable_Crystal은 Ember 접촉 1 s Telegraph 뒤 반경 4 m 폭발로 파티에도 피해를 주고 지름길 발판을 연다
    - 정상 arena(반경 14 m) Cinder Alpha 처치 → Skyshard 2, 획득 후 정상 서쪽 수정 계단이 `ws_ember` 쪽 출구로 솟음; Vitest로 필수 등반 ≤ 14 m(Stamina ≤ 70), 활강 도착 높이 ≥ 착지면 + 1 m, 기류+활강 소모(31.5·39) < 기본 최대 100 검사
    - _Requirements: 12.2, 12.6, 13.8, 13.9, 2.3_
  - [x] 9.8 Starfall Observatory: 별자리 순서 퍼즐(3단계 15 s), 방어막 적 2웨이브, Sentinel Prime, 돔 발코니 출구 활강로
    - 입구 계단(y 130) → 대전당 → 승강기 → 링 회랑 → 돔(y 150) 구조, 대전당 중앙에서 6 m 떨어진 네 방위에 Element 받침대 4개와 순서를 반복 표시하는 천장 별자리 3개 배치
    - `pz_observatory_1`(sequence)은 세이브 seed로 4 Element 중 3개를 뽑아 `order`·`parts`를 고정하고 첫 올바른 입력부터 `timeLimitSec` 15 s, 해결 시 링 회랑 승강기와 `cp_observatory_1` 개방
    - 링 회랑 양끝 barrier와 `spawnGroup` 1웨이브(`windcutter` ×2, `aetherSentinel` ×1) → `'camp:cleared'` 2 s 뒤 2웨이브(`aetherSentinel` ×2, 10 s마다 Element_Shield 교체) → barrier 해제·`cp_observatory_2`; 돔 Sentinel Prime 처치 → Skyshard 3, 획득 후 돔 발코니 활강 출발점 개방
    - _Requirements: 12.3, 13.6_

- [x] 10. Caelith 보스전 완성 (M6)
  - [x] 10.1 보스 데이터 `src/data/boss.ts` 작성
    - 최대 HP 24,000, ATK 120(레벨 9 고정), Phase 표 `BossPhaseDef` 3개(`until` 0.65/0.30/0, `interval` 2.2/1.9/1.54 s, `adds`, `starshell`, `music`)와 이를 읽는 순수 함수 `bossPhaseFor`(`src/logic/boss.ts`)를 작성한다.
    - 공격 8종 `BossAttackDef`(`strength`, 판정별 `telegraph`·`dmgMul`, `every`)와 `ARENA`·`SHARD_CRYSTAL`·`MIN_TELEGRAPH`, Starshell 수치(내구도 1,200/900, 교체 12 s, 같은 Element 25%, Reaction 300%, 파괴 후 6 s·150%)를 둔다.
    - Property 22 속성 테스트의 데이터 순회에 `strength`가 있는 Caelith 공격과 Shard_Crystal 파동(강공격 기준)을 추가해 판정마다 Telegraph가 `MIN_TELEGRAPH`(일반 0.4 s, 강 0.8 s) 이상인지 검증한다.
    - _Requirements: 6.1, 6.2, 6.3, 6.7, 6.9_
  - [x] 10.2 Arena, 연결 전당, 등장 연출, HUD 보스 바 구현
    - `sanctum_arena`(반경 32 m)에 45° 구역 8개, 중심에서 18 m 떨어진 Shard_Crystal 받침대 4개, 오를 수 없는 1.2 m rim wall collider를 두고, 입구는 전투 중 봉쇄했다가 Party_Wipe나 승리 때 연다.
    - 직전 연결 전당 `sanctum_hall`에 `ws_sanctum` Waystone과 벽화를 배치하고, arena 첫 진입 때만 `cin_boss_intro`(5 s 이하)를 재생하는 트리거를 둔다.
    - HUD 보스 바는 `BossEncounter.snapshot`을 읽어 이름, HP, 65%·30% Phase 눈금, 활성 중인 Starshell 내구도를 표시한다.
    - _Requirements: 5.7, 6.11, 32.6_
  - [x] 10.3 `BossBrain` 패턴 스케줄러 구현
    - recovery가 끝날 때마다(전환·`stagger`·`disabled` 종료 포함) 현재 Phase 풀에서 cooldown 중인 공격과 직전 공격을 빼고 거리 조건(slashCombo ≤ 6 m, starShards > 8 m, dash > 10 m)을 거쳐 가중치로 뽑으며, 후보가 없으면 `idle`에서 거리를 조정한다.
    - 대기 시간은 Phase 기본 간격 ± 0.3 s로 두되 강공격 뒤 최소 1.0 s는 새 Telegraph를 띄우지 않고, 강제 이벤트(Phase 1 세 번째 결정마다 내려찍기 연속기, Phase 2 첫 행동과 재소환 시 summonCrystals, Final 18 s마다 astralSweep)는 추첨을 건너뛴다.
    - 한 번 보여준 Telegraph는 취소하거나 위치·범위를 바꾸지 않고 끝까지 실행하며, 공격 추첨과 대기 오차는 모두 `boss` RNG 스트림에서 뽑는다.
    - _Requirements: 6.2, 6.3, 6.7, 6.9_
  - [x] 10.4 Starshell과 Shard_Crystal 구현
    - Phase 2 전환 뒤와 Final 진입 때 Starshell(내구도 1,200/900)을 씌우고 12 s마다 순수 함수 `nextStarshellElement`(`boss` 스트림)로 다른 Element로 바꾸며, 방어막이 모든 피해를 흡수하고 `applyElement` 기준 같은 Element 25%, Reaction 300%를 받되 방어막 표식은 소모되지 않는다.
    - 내구도가 0이 되면 파편 VFX·Hit_Stop과 함께 6 s `disabled`(받는 피해 150%)로 두고, 끝나면 새 Element와 최대 내구도로 재생성해 교체 타이머를 다시 시작한다.
    - Shard_Crystal 4개(Element별 1개, HP 300, 방어력 0)는 파괴 시 6 m 안의 Caelith에 그 Element 표식을 `applyElement`로 주고, 살아 있는 동안 3 m 안에 캐릭터가 있으면 6 s마다 Telegraph 0.8 s 뒤 3 m 고리 파동을 내며, 재소환은 빈 socket만 채운다.
    - _Requirements: 6.3, 6.4, 6.5, 6.6_
  - [x] 10.5 Property 18 속성 테스트: 보스 Phase 단조성
    - **Property 18: 보스 Phase 단조성**
    - **Validates: Requirements 6.1**
    - `tests/property/boss-phase.property.test.ts`: 임의의 HP 비율 수열과 시작 Phase에서 `bossPhaseFor`가 이전보다 낮은 Phase를 돌려주지 않고 0.65/0.30 경계를 지키는지 numRuns ≥ 100으로 검사하며, 태그 주석 `// Feature: skyshard-echoes-of-the-wild, Property 18: 보스 Phase 단조성`을 단다.
  - [x] 10.6 Property 19 속성 테스트: Starshell Element 회전
    - **Property 19: Starshell Element 회전**
    - **Validates: Requirements 6.4**
    - `tests/property/starshell.property.test.ts`: 임의의 현재 Element와 RNG 시드에서 `nextStarshellElement`가 현재 Element를 돌려주지 않고 유효한 `ElementId`를 고르는지 numRuns ≥ 100으로 검사하며, 태그 주석 `// Feature: skyshard-echoes-of-the-wild, Property 19: Starshell Element 회전`을 단다.
  - [x] 10.7 Phase 전환, Starfall, Astral Sweep, Phase 1 Stagger 구현
    - 피해가 HP를 다음 임계값(최대 HP의 65%/30%) 아래로 내리려 하면 HP를 임계값에 고정하고 넘친 피해를 버리며, 3 s `transition`에서 `'boss:phaseChanged'` 발행, hazard·투사체 제거, 양측 무적, 음악 단계 전환을 처리하고 Final 진입 때 하늘·조명을 별빛 밤 preset으로 바꾼다.
    - `atk_caelith_starfall`(반경 3 m 원 5개, Telegraph 1.2 s)과 `atk_caelith_astralSweep`(Telegraph 1.2 s, 높이 0.8 m 링이 14 m/s로 360° 확장, 발이 0.8 m보다 높은 점프나 Dodge 무적이면 회피, 종료 후 2.5 s vulnerable)을 구현한다.
    - Phase 1 slashCombo → groundSlam 연속기 뒤 3 s `stagger`를 두고, vulnerable 창과 `disabled` 동안 받는 피해 150%와 `snapshot.vulnerable`을 적용하며 창이 열린 동안에는 Starshell을 억제한다.
    - _Requirements: 6.2, 6.7, 6.8, 6.10_
  - [x] 10.8 재도전·처치 흐름 구현과 밸런스 시뮬레이션 테스트
    - `begin(fromPhase)`는 Caelith HP를 최대 HP의 100/65/30%로 맞추고 파티 HP 회복, cooldown·강제 이벤트 카운터 초기화, Phase 2 이상이면 Starshell 재생성과 Shard_Crystal 제거를 하며 등장 연출은 다시 재생하지 않는다.
    - `'party:wipe'` 때 Defeat Screen에 "현재 Phase부터 재도전"과 "Waystone으로 돌아가기"(`ws_sanctum`)를 띄우고, HP 0이면 `dead` 전환 → hazard·투사체 즉시 제거 → `'boss:defeated'` 발행 → 사망 연출 순서로 처리한다.
    - `tests/unit/boss-balance.test.ts`에서 레벨 7–8 파티 DPS 모델(평소 140, vulnerable 창 220)을 붙인 headless `BossEncounter`를 여러 시드로 끝까지 돌려 Phase당 60–150 s, 전체 3–6분 안인지 확인한다.
    - _Requirements: 2.4, 6.12, 6.13, 6.14_

- [x] 11. Checkpoint - Caelith 3 Phase 전투를 정상 입력만으로 처치할 수 있고 모든 강공격에 대응 가능한 Telegraph가 있는지 확인
  - 모든 테스트와 빌드가 통과하는지 확인하고, 질문이 있으면 사용자에게 묻는다.

- [x] 12. 성장·인벤토리·보상 (M7)
  - [x] 12.1 Progression 경험치·레벨업 구현
    - 누적 XP 표(레벨 1–10, 최대 3,000)와 XP 출처(적·Elite 처치, Main_Quest 단계·Side_Quest 완료, Chest 개봉, 첫 발견) 데이터를 정의하고 `src/logic/progression.ts`에 `levelFromXp`·`xpForLevel`·`statsAt` 구현
    - Progression_System이 XP를 누적(3,000 초과분 버림)하고, 레벨업 시 최대 HP ×1.08·공격력 ×1.06을 기본값 기준 복리로 적용, 전원 HP 회복, 최종 레벨로 `levelUp`을 1회 발행해 VFX·SFX 재생
    - `tests/unit` 데이터 테스트: 메인 경로 데이터만으로 `ms9` 시작 전 레벨 ≥ 7, 전체 콘텐츠 XP 합 ≥ 3,000(레벨 10 도달)인지 검증
    - _Requirements: 29.1, 29.2, 29.3_
  - [x] 12.2 Property 24 속성 테스트: 성장 배율과 메인 경로 레벨
    - **Property 24: 성장 배율과 메인 경로 레벨**
    - **Validates: Requirements 29.1, 29.2, 29.3**
    - 임의 누적 XP(0–5,000)에서 `levelFromXp`가 1–10 범위이고 단조 비감소이며 `xpForLevel(levelFromXp(xp)) ≤ xp`인지 검사
    - 임의 기본 스탯과 레벨 L(1–10)에서 `statsAt`이 `maxHp = round(baseHp × 1.08^(L − 1))`, `atk = baseAtk × 1.06^(L − 1)`을 따르고 나머지 스탯은 유지하는지 검사
    - 피할 수 있는 전투·경로상 발견·Chest를 임의로 생략한 메인 경로 XP 합으로도 `ms9` 시작 레벨이 7 이상인지 검사
    - `tests/property/progression.property.test.ts`에 작성, 태그 주석 `// Feature: skyshard-echoes-of-the-wild, Property 24: 성장 배율과 메인 경로 레벨`, `numRuns` ≥ 100
  - [x] 12.3 Echo Altar 능력 강화 구현
    - `upgradeCost`(1단계 Starmote 3·Glim 100, 2단계 6·250, 3단계 10·500)와 부족 Starmote·Glim 수량을 돌려주는 `canUpgrade` 구현(3단계면 `ok: false`·부족량 0)
    - `UiCommand`(`upgradeAbility`)를 다음 틱에 `canUpgrade`로 재검증해 재화를 차감하고 Skill·Burst 단계(최대 3)를 올리며, 캐릭터 키트 데이터의 단계 효과(피해 증가는 `abilityUpgradePct`) 적용
    - 제단 화면용 결과: 현재·다음 단계 설명, 비활성 버튼과 "Starmote 2 · Glim 150 부족" 형식의 부족 수량, 3단계의 "최대" 표시
    - _Requirements: 29.4, 29.5, 29.6_
  - [x] 12.4 장비·소비 아이템 구현
    - 캐릭터별 Weapon·Charm 슬롯과 파티 Relic 슬롯(기본 Weapon 복귀, Charm은 한 번에 한 캐릭터만 장착), 장비 13종(Weapon 4·Charm 6·Relic 3) 데이터 정의
    - 장착·해제 `UiCommand`를 다음 틱에 검증해 `EquipEffect`를 같은 틱에 즉시 적용·해제하고, 장비 화면에 변경 전·후 효과 문구("효과 없음" 포함)를 나란히 표시
    - 허브 경단(Z 즉시 사용, 최대 HP 35% 회복, 3 s 재사용 대기)과 불씨 깃털(Downed 캐릭터를 HP 30%로 부활), `addItem`의 종류별 보유 한도 10 clamp
    - _Requirements: 30.1, 30.2, 30.3, 30.4, 27.5, 27.6_
  - [x] 12.5 Pip 상점 구현
    - 상품·가격 데이터 정의(허브 경단 40, 불씨 깃털 120, 불씨 리본·깃털 방울 각 300 Glim), 소비 아이템은 보유 한도까지 반복 구매·Charm은 종류당 1회
    - `src/logic/inventory.ts`의 `purchase`: 실패 사유 `owned` → `cap` → `glim` 순서, Glim 부족 시 `missing = price − glim`, `ok: true`일 때만 인벤토리·Glim 갱신
    - 상점 화면 버튼 상태를 같은 판정으로 미리 계산해 거부 상품 비활성화와 "보유 중"·"보유 한도"·부족 Glim 수량 표시 데이터 제공
    - _Requirements: 14.11, 14.12_
  - [x] 12.6 Property 23 속성 테스트: 인벤토리와 Glim 경계
    - **Property 23: 인벤토리와 Glim 경계**
    - **Validates: Requirements 30.4, 14.12**
    - 임의 `addItem` 호출 열(음수 소모 포함) 뒤에도 `con_` 수량은 0–10, `mat_` 수량은 0 이상인지 검사
    - 임의 Glim·가격에서 `purchase`는 `glim ≥ price`일 때만 성공하고 결과 Glim `glim − price`는 음수가 아니며, Glim이 부족하면 `ok: false`·`missing = price − glim`인지 검사
    - 거부 사유가 `owned` → `cap` → `glim` 순서로 정해지고 거부 시 입력 인벤토리·Glim이 변하지 않는지 검사
    - `tests/property/inventory.property.test.ts`에 작성, 태그 주석 `// Feature: skyshard-echoes-of-the-wild, Property 23: 인벤토리와 Glim 경계`, `numRuns` ≥ 100
  - [x] 12.7 보상 지급 구현
    - `src/logic/loot.ts`의 `rollChest`: 일반·정교한·빛나는 3등급 보상표와 `mulberry32(hash(chestId))` 시드, 빛나는 Chest는 미보유 지정 장비 또는 Starmote 5 + Glim 200, `chest:opened` 발행과 등급별 VFX·SFX
    - `camp:cleared` 시 잠긴 Chest 개방과 "캠프 소탕" 알림, Elite 처치·Sky Ring Trial 완료 시 빛나는 Chest 보상, `rollEnemyDrop`(일반 적 Starmote 10%, loot 스트림 `Rng`)과 드롭 3 m 자동 흡수
    - 모든 지급을 `item:granted`로 알리고 HUD 획득 알림(3 s, 최대 5줄) 표시, Echo_Tablet 기록 표시·Region별 n/3 갱신·3개 완성 시 최대 Stamina +15
    - _Requirements: 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 28.13, 30.5, 30.6_
  - [x] 12.8 Property 30 속성 테스트: Chest 보상 결정성과 등급
    - **Property 30: Chest 보상 결정성과 등급**
    - **Validates: Requirements 10.5**
    - 임의 `chestId`·등급·보유 장비 집합으로 `rollChest`를 반복 호출해도 같은 보상 목록이 나오는지 검사
    - 일반 등급은 Glim 30–60·허브 경단 0–1개, 정교한 등급은 Glim 60–120·Starmote 2–3 범위 안인지 검사
    - 빛나는 등급은 지정 장비가 미보유일 때만 그 장비를, 그 밖에는 Starmote 5 + Glim 200을 주는지 검사
    - `tests/property/loot.property.test.ts`에 작성, 태그 주석 `// Feature: skyshard-echoes-of-the-wild, Property 30: Chest 보상 결정성과 등급`, `numRuns` ≥ 100

- [x] 13. 마을·NPC·대화·튜토리얼·지도 (M7)
  - [x] 13.1 Dialogue_System: `DialogueDef`, `selectDialogue` 우선순위, 이름판과 최대 3줄 대화 창, 45자/s 출력·F/Space/좌클릭 진행, 0.5 s 안에 NPC 회전, 대화 창 수 제한, 화자별 발화음, 모든 이름 있는 NPC의 0/1/2/3/엔딩 후 대사 작성과 데이터 테스트
    - `src/data/dialogue.ts`에 `DialogueDef`(`npc`, `when{bucket?, questStage?, flag?}`, `lines`, `onEnd`)를 두고, `src/logic`의 순수 `selectDialogue(npc, gs, defs)`가 `when`을 모두 만족하는 후보 중 `questStage` > `flag` > `bucket`(게임 완료면 `'post'`, 아니면 Skyshard 수) > 기본 대화 순(같은 순위는 Objective id 지정, 조건 필드 수, 배열 순서로 결정)으로 항상 하나를 고르며, `flag` 1회성 반응은 끝나면 `seen_<id>`를 켜 후보에서 뺀다
    - NPC 대상 `interact`에 입력 컨텍스트 `dialogue`·PauseMode `'dialogue'`로 적을 동결하고 NPC를 0.5 s 안에 플레이어 쪽으로 돌린 뒤 화자 이름판과 최대 3줄(`text` ≤ 90자) 대화 창을 연다. 대사는 초당 45자로 출력하고 진행 입력(`interact`·`jump`·`attack`, 기본 F·Space·좌클릭)은 출력 중이면 즉시 완성, 완성 뒤면 다음 창으로 넘기며, 창마다 화자별 고유 음높이 발화음(NPC 7명·동료 4명 모두 다름)을 재생하고 마지막 창 뒤 `onEnd` 적용·`dialogue:ended` 발행 후 컨텍스트를 되돌린다
    - 이름 있는 NPC 7명(`maren`·`pip`·`bram`·`tamsin`·`hobb`·`durga`·`oriel`)의 기본 대화와 `bucket` 0·1·2·3·`'post'` 대사를 서로 다르게 한국어(고유명사는 영어)로 쓰고, Vitest 데이터 테스트로 NPC별 기본·다섯 `bucket` 대화의 존재와 상이함, 창 수 상한(일반 6, `questStage` 주요 스토리 10), `text` ≤ 90자를, unit test로 `ms1` Maren의 Objective별 분기와 1회성 반응 뒤 `bucket` 복귀를 검사한다
    - _Requirements: 3.8, 14.4, 14.5, 14.6, 14.7, 35.4, 37.7_
  - [x] 13.2 Thistlewick과 NPC: 광장·집·노점·Echo Altar·우물·밭·망루 배치, NPC idle + 주변 행동, Hearth 회복, Durga·Oriel 배치, Skyshard 단계별 마을 변화, Sanctum 시야 축 확보
    - `src/data/worldLayout.ts`에 중심 (−250, 300)·지면 y 18 기준 오프셋으로 반경 12 m 돌 포장 광장과 Hearth (+4, −4), Maren의 2층 집 (0, −24), Pip 노점 (+14, 0), Old Bram의 Echo Altar (−18, 0), 우물 (−9, +11), Hobb 밭 (+50, +20, 약 30 × 20 m), 10 m 망루 (+30, +32), 길목의 `ws_thistlewick` (+18, +18)을 배치하고, 광장에서 방위 30°–50° 시선 축에는 건물·큰 나무를 두지 않아 New Game 직후 Astral Sanctum 실루엣이 보이게 한다
    - 마을 NPC 5명과 `camp_durga` (235, 235)의 `durga`, `camp_oriel` (40, −220)의 `oriel`이 idle과 주변 행동(Maren 광장↔집 왕복, Pip 진열대 정리, Bram 제단 쓸기, Tamsin 우물가 뛰기, Hobb 밭 갈기, Durga 모루 망치질, Oriel 망원경 보기)을 8–15 s 간격으로 번갈아 재생하고, 걷는 NPC는 플레이어 2.5 m 안에서 멈추며 `dialogue:ended` 뒤 원래 방향·행동으로 돌아간다. Hearth `interact`는 모든 Player_Character의 HP를 최대로 회복하고 Downed를 해제한다
    - 마을 단계를 Skyshard 수(0–3)와 게임 완료 여부에서 매번 계산해 누적 적용한다: 0 꺼진 등불·시든 화단·임시 좌판 → 1 거리 등불·깃발 → 2 노점 재개장·화환 → 3 광장 별 등불과 광장 둘레에서 Sanctum을 바라보는 마을 NPC 5명 → 엔딩 후 새벽 축제·Blight 흔적 소멸. 단계별 GameState를 불러온 직후에도 같은 모습인지 확인한다
    - _Requirements: 14.1, 14.2, 14.8, 14.9, 14.10, 5.1_
  - [x] 13.3 Side_Quest 3종(sq_tamsin 풍차 날개의 연, sq_hobb 가시 둥지 소탕, sq_durga 화로 3개 점화): 데이터, 고유 보상, 세계 변화 플래그, 추적 Objective의 Compass·지도 표시
    - `src/data/quests.ts`에 기존 장소·Enemy_Camp·`ElementReceiver`만 쓰는 5분 이하 `QuestDef` 3개를 추가한다: `sq_tamsin`(Breezewatch 절벽 2단 등반·나선 계단 → 풍차 최상단 y 64 날개 끝의 연 회수 → 활강 귀환 → Tamsin 전달), `sq_hobb`(`camp_verdant_1` 소탕 → Hobb 보고), `sq_durga`(`camp_durga` 주변 `brazier` 3개 Ember 점화, `allOf`·순서·제한 시간 없음 → Durga 보고)
    - 마지막 단계 `onComplete`의 `grant`로 고유 보상(`sq_tamsin` `chm_` Charm + 경험치, `sq_hobb` `rlc_` Relic, `sq_durga` `mat_starmote` ×5 + `chm_` Charm)을 주고 `setFlag`로 마을 하늘의 연·밭의 꽃·다시 빛나는 용광로와 굴뚝 연기를 켜 World가 불러오기 때도 복원한다. 수락 전에 소탕·점화를 마쳤다면 수락 직후 씬 어댑터가 저장 상태를 이벤트로 다시 보내 Objective를 바로 완료하고, 연은 `sq_tamsin`이 `active`일 때만 회수된다
    - `QuestState.tracked` Side_Quest의 현재 Objective를 Compass(다른 색 아이콘)와 지도에 표시하고, 연·화로 같은 전용 오브젝트는 해당 `QuestDef`가 있을 때만 생성한다. unit test로 Side_Quest 하나의 정의·대사 분기를 빼도 나머지와 메인 진행이 동작하는지, `sq_tamsin` 귀환 활강(수평 130 m, 활강비 3.6 기준 필요 낙차 36 m ≤ 가용 46 m, 14.4 s ≤ 16.7 s)이 성립하는지 검사한다
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_
  - [x] 13.4 Tutorial_System: Hint 20종 데이터, 한 번에 1개·최대 2줄·현재 바인딩 키 아이콘, 수행 또는 8 s 후 완료 저장, 재표시 금지와 "조작 안내 보기", 첫 10분 배치 확인(Kairen → Isla 증기 폭발 유도 포함)
    - `src/data/tutorials.ts`에 `TutorialHintDef`(`trigger`: `start`·`near`·`event`·`signal`, `text` ≤ 40자, `actions`, `doneWhen`) 20종(`tut_move`–`tut_puzzle`)을 표시 우선순위 순서로 정의하고, 데이터 테스트로 필수 안내 17개 항목 포함과 `text` 길이를 검사한다
    - `src/logic`의 순수 대기열·타이머 함수로 트리거가 충족된 미완료 Hint 중 순서가 가장 앞선 1개만 최대 2줄로 띄우고 키 아이콘은 현재 바인딩에서 만든다. `doneWhen` 동작·이벤트 또는 표시 8 s에 닫아 같은 틱에 완료 목록에 기록(다음 저장 포함)하고, 완료 Hint는 다시 대기열에 넣지 않고 Settings "조작 안내 보기"에 완료 순서대로 나열하며, 연출·메뉴·대화 중에는 숨긴 채 타이머를 멈춘다
    - 새 게임 첫 10분 흐름에 트리거를 배치한다: 0:00 이동·카메라, 0:20 광장 계단 턱 점프, 0:40 Maren 상호작용, 1:30 `village_raid` 공격·첫 Telegraph Dodge, 1:50 Kairen Skill의 Ember 표식 뒤 교체 키 2로 Isla를 불러 증기 폭발(`tut_reaction`), 2:40 질주, 3:20 등반, 4:20 Vista·지도, 5:00 활강. `ms1`–`ms2` 이벤트 열 재생 테스트로 필수 조작 10개 안내가 활강까지 한 번에 하나씩 모두 뜨는지 확인한다
    - _Requirements: 34.1, 34.2, 34.3, 34.4, 34.5, 34.6_
  - [x] 13.5 지도와 안개: heightfield로 만든 지도 이미지, `FogOfWar`(8 m 칸, 방문 40 m, Vista 200 m, encode/decode), 지도 화면 표시 항목·탐색 구역 원(≥ 60 m)·Region별 Chest/Echo_Tablet 수, 미발견 POI 숨김
    - 시작 시 한 번 1024 × 1024 캔버스에 heightfield hillshade(북서쪽 광원) → Region 팔레트 → `water` 볼륨 수면 → `worldLayout.ts` 길 폴리라인 → Landmark 아이콘 순으로 합성하고, 좌표는 `px = (x + 560) / 1120 × 1024`, `py = (z + 560) / 1120 × 1024`(북쪽이 위)로 변환한다
    - `src/logic/fogOfWar.ts`의 `FogOfWar`를 8 m 칸 140 × 140 bitset(2,450 byte, index `⌊(z + 560) / 8⌋ × 140 + ⌊(x + 560) / 8⌋`)과 base64 `encode`/`decode`(잘못된 입력은 예외 없이 전부 가림)로 구현해 GameState에 저장하고, 새 칸 진입마다 `reveal(x, z, 40)`(반환 > 0이면 안개 텍스처 갱신), `vista_verdant`·`vista_ember`·`vista_azure` 도달 시 `reveal(x, z, 200)`과 그 안의 Waystone·Landmark 위치 표시(활성화 전 Waystone은 빠른 이동 목적지 아님)를 한다
    - 지도 화면(M)은 미공개 칸을 양피지와 선형 보간 마스크로 덮고 플레이어 위치·방향, 발견 Region, Thistlewick, 발견 Landmark 이름표, 활성 Waystone, 발견 POI(미발견 POI는 공개 칸에서도 숨김), Main_Quest Objective(`exact` 마커 또는 반경 60 m 이상 탐색 원), 추적 Side_Quest Objective, Region별 Chest·Echo_Tablet 발견 수/전체를 그리며 드래그 이동·휠 1×–4× 확대·M/Esc 닫기를 지원한다
    - _Requirements: 33.1, 33.2, 33.3, 33.5, 9.5, 3.6_
  - [x] 13.6 Property 26 속성 테스트: 지도 안개 공개
    - **Property 26: 지도 안개 공개**
    - **Validates: Requirements 33.3, 33.2**
    - `arbRevealOps`의 `reveal(x, z, r)` 호출 열을 적용한 `f`에서 `FogOfWar.decode(f.encode())`가 모든 칸의 공개 상태를 보존하고, 공개 칸이 줄지 않으며, 같은 호출을 반복하면 두 번째 반환값이 0이고, 각 중심에서 r − 5.66 m 이내의 월드 안 모든 점이 `isRevealed`인지 확인한다
    - `tests/property/fogOfWar.property.test.ts`, 태그 `// Feature: skyshard-echoes-of-the-wild, Property 26: 지도 안개 공개`, `numRuns` ≥ 100(기본 200)
  - [x] 13.7 Waystone·빠른 이동·Compass: 활성화 연출과 등록, HP 회복·Downed 해제·부활 지점 지정, 전투 밖 3 s 이하 빠른 이동과 전투 중 거부 메시지, 상단 Compass(폭 ≤ 40%, 방위, Objective, 150 m 안 Waystone, 발견 Landmark, 추적 Side_Quest)
    - `src/data/waystones.ts`의 Waystone 6개(`ws_thistlewick`·`ws_elderbough`·`ws_ember`·`ws_azure`·`ws_crater`·`ws_sanctum`)는 비활성 상태에서 `interact`하면 활성화 연출·효과음과 함께 GameState에 등록되고 `waystone:activated`(`waystoneId`, `regionId`)와 `save:request`를 낸다. 활성화 때와 이후 상호작용마다 모든 Player_Character의 HP를 최대로 회복하고 Downed를 해제하며 부활 지점을 그 Waystone으로 지정한다
    - 지도에서 활성 Waystone을 고르면 `UiCommand`(`fastTravel`, `waystoneId`)를 큐에 넣고 다음 틱 World가 In_Combat을 확인한다. 전투 밖이면 지도를 닫고 페이드 아웃 0.5 s → 위치 이동·월드 갱신 → 페이드 인 0.5 s(합계 ≤ 3 s)로 Waystone 앞 2 m 지면에 두고, In_Combat이면 취소하고 "전투 중에는 이동할 수 없습니다"를 표시한다
    - Compass는 화면 상단 중앙에 폭 min(화면 너비 38%, 560 px)으로 두고 시야 180° 스트립에 `Δ = wrap(bearing − yaw)`(`bearing = atan2(dx, −dz)`)를 `u = 0.5 + Δ / 180°`로 그리며 |Δ| 70°–90°에서 흐려지고 90° 밖은 숨긴다. N/E/S/W 눈금, Main_Quest Objective(`zone`은 구역 중심, 구역 안에서는 "탐색 구역"), 추적 Side_Quest(다른 색), 150 m 이내 활성 Waystone, 발견한 대표 Landmark를 표시한다
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 33.4_

- [x] 14. UI 화면·HUD·설정 (M7)
  - [x] 14.1 UI 구조와 스타일: ScreenManager 스택·포커스 탐색(마우스·키보드·게임패드)·0.15–0.3 s 전환과 UI 효과음, 디자인 토큰(남색 패널, 별빛 금색 테두리), Element 아이콘 SVG 4종, 기본 HTML 모양을 쓰지 않는 사용자 정의 컨트롤, 한국어 폰트 스택·UI 배율 변수·명도 대비
    - 작업 4.8의 `src/ui` `ScreenManager`를 확장해 `Screen`(`mount`·`unmount`·`onInput`·`focusables`·`update`) stack의 맨 위에만 `NavInput`을 보내고, push·pop마다 `'ui:screen'` 발행과 입력 컨텍스트·PauseMode 전환을 하며, `pointer-events: none` overlay root와 `innerHTML` 없는 `h()` helper를 쓰고 닫는 화면은 `inert`로 둔 채 motion `finished` 뒤 `unmount`한다
    - `FocusNav`가 마우스 hover·클릭, 방향키·Enter·Esc, D-pad·A·B를 같은 `NavInput`으로 받아(0.4 s 유지 후 0.1 s 반복) "주축 거리 + 2 × 보조축 어긋남"이 최소인 요소로 `--focus` 금색 ring·`.is-focused`·DOM focus를 옮기고, 열기 0.2 s·닫기 0.15 s·전체 화면 0.3 s motion(`prefers-reduced-motion`이면 opacity 0.1 s)과 `'ui:screen'` 기반 열기·닫기 효과음을 붙인다
    - `src/ui/styles`에 `--panel-bg`·`--gold`(네 갈래 별 `border-image`)·`--text`·`--text-muted`·`--danger`·Element 4색 토큰, `<symbol>` sprite의 Element 아이콘 4종(Ember 세 갈래 불꽃, Tide 겹친 물결 원, Gale 나선, Terra 육각 결정)과 위험 삼각형, 기본 모양을 지운 `<button>`(hover·pressed·`aria-disabled` 사유)과 `role="slider"`·`role="switch"` 컨트롤, 폰트 스택과 `calc(20px * var(--ui-scale))` rem 배율을 두고, 흰 장면 합성 기준 글자 대비 ≥ 4.5:1을 unit test로 계산한다
    - _Requirements: 31.2, 31.6, 31.7, 35.5, 35.6, 35.7, 25.1_
  - [x] 14.2 화면 구현: Loading, Title(3D 배경·오디오 시작 안내·New Game/Continue/Settings/Credits), 덮어쓰기 확인, Pause 전체 항목, Inventory/Equipment, Quest, 속성 반응 도감, Shop, Echo Altar, Dialogue, Defeat(상황별 선택지), Victory(통계·탐험 계속/메인 메뉴·디버그 표시), Credits, 오류 화면
    - Loading은 `LoadingProgress`(`terrain`·`vegetation`·`characters`)를 약 30 ms 단위로 처리하고 `requestAnimationFrame`으로 양보해 막대·문구를 갱신하며 10 s 안에 Title을 stack 바닥에 push한다. Title은 궤도 카메라 3D 배경 위 "클릭하거나 아무 키나 눌러 시작"을 첫 입력(오디오 시작, 메뉴 선택 아님) 뒤 New Game/Continue(저장 없으면 "저장 데이터 없음" 비활성)/Settings/Credits로 바꾸고, `newGameConfirm`은 "취소"에 기본 포커스를 둔다
    - Pause(계속·지도·인벤토리/장비·퀘스트·속성 반응 도감·설정·끼임 해제 `unstuck`·Title로, `menu` 컨텍스트라 게임 시간 정지), Inventory/Equipment(Weapon·Charm·Relic 슬롯, 변경 전후 비교, 불씨 깃털 대상 선택), Quest(추적 전환), 도감(`GameState.codex`, 미발견은 잠긴 칸), Shop·Echo Altar(비용·부족 수량·비활성 사유), Dialogue(이름판·3줄·진행 표시)를 만들고 상태 변경은 모두 `UiCommand`로 넘긴다
    - Defeat는 `'party:wipe'`의 `bossPhase`에 따라 일반 1개·Caelith 2개("현재 Phase부터 재도전"·"Waystone으로 돌아가기") 버튼을 `defeatChoice`로, Victory는 `cin_ending`의 `cinematic:ended`에서 만든 `VictoryView`(통계·능력 단계·"디버그 사용됨")와 "탐험 계속"(`continueExploring`)·"메인 메뉴"를 둔다. Credits는 `src/data/credits.ts`를 읽고, 오류 화면은 WebGL2 미지원·컨텍스트 손실·치명적 오류 오버레이와 Title 위 `saveError`로 만든다
    - _Requirements: 31.1, 31.3, 31.4, 31.5, 1.10, 7.3, 7.4, 7.5, 7.7, 25.13, 27.3, 6.13_
  - [x] 14.3 HUD: 레이아웃과 면적 예산(≤ 15%), 파티 슬롯(포트레이트·Element·HP·키·Skill/Burst·Downed·교체 대기·반응 예고), HP·레벨, Skill/Burst 아이콘과 준비 발광·효과음, Stamina 원형, Objective, Skyshard n/3, prompt, 비전투 5 s 후 50%, 적 HP 바·표식·방어막·Elite 이름, 보스 바, 화면 밖 Telegraph 화살표, 피격 방향, 알림(Region 카드, 발견, 단계 완료, 캠프 소탕, 획득, 연쇄, 저장 표시기·저장 실패)
    - 1920×1080 기준 배치표(상단 Compass, 좌상단 Objective, 우상단 Skyshard n/3, 좌하단 파티 슬롯 4개, 하단 중앙 HP·레벨, 우하단 Skill ⌀76·Burst ⌀92, 조건부 Stamina ⌀48·prompt)를 데이터로 두고 상시 ≈ 5.7%·조건부 ≈ 6.5%·UI 배율 130%에서도 ≤ 15%임을 unit test로 계산한다. 슬롯은 portrait·교체 키·Element 아이콘·HP·Skill sweep·Burst 별·Downed 흑백과 "쓰러짐"·0.8 s 교체 대기 radial sweep·`previewReaction` 아이콘을 그린다
    - 비전투 4.7 s부터 0.3 s fade로 5 s에 50%, Burst 최대 도달 틱의 금색 발광·준비음 1회, Stamina 원형(최대 2 s 뒤 0.2 s 숨김)을 구현하고, 적 HP 바 pool 12개(96×8, Elite 128×10·이름)에 Element_Mark 아이콘·8 s ring·방어막 내구도 바, Caelith 720×20 바(65%·30% 눈금, Starshell), 화면 밖 Telegraph 가장자리 화살표, 피격 붉은 vignette와 공격자 방향 호(0.4 s)를 띄운다
    - 알림: Region title card 3 s, 발견 banner와 효과음, 단계 완료 3 s·캠프 소탕 2 s(같은 자리 순서 대기), 획득 feed 3 s·최대 5줄·같은 아이템 합산, "연쇄 x{n}" 1.5 s, `'save:done'`의 "저장 중…" 0.5 s → "저장됨" 1.0 s와 `'save:failed'`의 "저장 실패" 3 s. 틱마다 `HudModel`을 dirty 비교해 `textContent`·`transform`·`stroke-dashoffset`만 쓰고 숫자·문구는 15 Hz로 묶으며 프레임 안에서 layout을 읽지 않는다
    - _Requirements: 32.1, 32.2, 32.3, 32.4, 32.5, 32.6, 32.7, 23.3, 23.9, 17.5, 21.5, 26.7, 8.7, 9.6, 3.5, 10.7, 30.6, 25.7_
  - [x] 14.4 Settings: 데이터·기본값·보정, 오디오/그래픽/조작/접근성/조작 안내 탭, 적용 시간(오디오 0.1 s, 그래픽 1 s), 키 재지정 흐름(`remapBinding` 맞바꿈, 예약 키 거부, 기본값), 게임패드 고정 배치
    - `src/settings`에 `Settings` 필드·기본값·범위(`musicVolume` 0.7, `sfxVolume` 0.8, `qualityPreset` `'medium'`, `renderScale` 0.5–1.0, `mouseSensitivity` 0.2–3.0, `uiScale` 0.8–1.3 등)를 두고 변경마다 `skyshard.settings`에 즉시 JSON으로 쓴다(실패해도 메모리 값 적용). 부팅 때 순수 `sanitizeSettings`가 틀린 필드만 기본값으로 바꾸고 모르는 필드는 버리며 불량 `bindings`는 전체를 `DEFAULT_BINDINGS`로 되돌리는지 unit test한다
    - 탭: 오디오(음악·효과음 켜기·음량, 0.1 s 안 적용), 그래픽(프리셋·render scale·그림자·식생·후처리, "사용자 지정" 판정, 재시작 없이 1 s 안 적용), 조작·접근성(감도·Y 반전·흔들림 0–100%·UI 배율 80–130%, 즉시 적용), 조작 안내 보기(완료한 Tutorial_Hint를 완료 순서대로 현재 키 아이콘과 함께)
    - 키 재지정: "새 키를 누르세요" 뒤 첫 `keydown`(`event.code`)·`mousedown`(`Mouse` + button)을 받아(Esc·B는 취소) 순수 `remapBinding`이 예약·고정 키는 `'reserved'`, 목록 밖 코드는 `'unknown'`으로 거부하고 쓰던 키면 맞바꿔 "점프 ↔ 상호작용" 알림을 내며, "기본값으로"와 prompt·Tutorial_Hint 키 아이콘 재생성을 붙인다. 게임패드는 `mapping === 'standard'` 고정 배치·데드존 0.15이고 감도·반전을 오른쪽 스틱에도 적용한다
    - _Requirements: 35.2, 35.3, 35.8, 37.5, 38.1, 38.2, 34.5_
  - [x] 14.5 Property 25 속성 테스트: 키 재지정 전단사
    - **Property 25: 키 재지정 전단사**
    - **Validates: Requirements 35.3**
    - `arbBindingsOps`로 임의 전단사 `b`와 예약·고정 코드(Esc 포함)·알 수 없는 코드·다른 동작이 쓰는 키가 섞인 재지정 요청 열을 만들어 `remapBinding`을 차례로 적용한다
    - 매 단계 결과가 동작↔입력 전단사이고, `ok`면 `bindings[action] === code`이며 `swappedWith` 동작이 이전 `b[action]`을 받고 나머지 동작은 그대로인지, 예약·고정 코드는 항상 `'reserved'`로 거부되어 바인딩과 인자 `b`가 바뀌지 않는지 확인한다
    - `tests/property/keyRemap.property.test.ts`, 첫 줄 `// Feature: skyshard-echoes-of-the-wild, Property 25: 키 재지정 전단사`, `numRuns: 200`(최소 100)

- [x] 15. 저장·불러오기 (M7)
  - [x] 15.1 저장 형식과 불러오기 파이프라인: `SaveEnvelope`(version, checksum FNV-1a, 정규형), 키 4종, `loadSave`(메인 → 백업 → 격리), `migrate` 체인, `sanitizeGameState` 보정 규칙, `validateGameState`, 손상·잘림·checksum·버전·범위 초과 unit test
    - `src/logic/save/`에 `SAVE_VERSION = 1`과 `SaveEnvelope`(`format: 'skyshard-save'`·`version`·`savedAt`·`playTimeSec`·`checksum`·`state`)를 두고, `serializeSave`는 정렬 배열·base64 bitset·유한 수만 담은 정규형 `state`의 JSON에 FNV-1a 32-bit hex checksum을 붙인다. 키는 `skyshard.save`·`skyshard.save.bak`·`skyshard.save.corrupt.<epochMs>`(3개 초과 시 오래된 것부터 삭제)·`skyshard.settings`이고 저장소는 `KeyValueStore`로 주입한다
    - `loadSave(store)`는 키가 없으면 `none`, 있으면 `JSON.parse` → envelope·format → checksum 재계산 → version(낮으면 `migrate`의 `MIGRATIONS[v]` 연쇄, 높거나 1 미만·비정수·변환 불가면 실패) → `sanitizeGameState` → `validateGameState`를 단계마다 try/catch로 거치고, 실패하면 백업에 같은 단계를, 둘 다 실패하면 주 저장 원문을 격리한 뒤 `unrecoverable`을 돌려주며 어떤 입력에도 throw하지 않는다
    - `sanitizeGameState`는 누락·타입 오류·미정의 enum을 기본값으로, 음수 수량을 0·소모품을 10으로 자르고, 레벨 1–10과 `levelFromXp` 구간 XP, Skyshard 0–3과 Main_Quest 단계 일치, 미정의 ID 항목 제거, 비유한 좌표의 부활 지점 대체를 적용해 `repairs[]`를 `console.warn` 한 번으로 남긴다. `tests/unit`: 손상 JSON, 잘린 파일, 잘못된 checksum, version 0, 미래 버전, 범위 초과 필드
    - _Requirements: 36.1, 36.2, 36.9, 36.10, 36.11, 36.12_
  - [x] 15.2 Property 1 속성 테스트: 저장 데이터 round-trip
    - **Property 1: 저장 데이터 round-trip**
    - **Validates: Requirements 36.9, 36.1**
    - 공용 생성기 `arbGameState`(정렬 배열·base64 bitset·유한 수·content 정의 ID)로 유효한 `GameState` `s`와 플레이 시간 `t ≥ 0`을 생성한다
    - `sanitizeGameState(JSON.parse(serializeSave(s, t)).state)`가 `s`와 deep-equal인 `state`와 빈 `repairs`를 반환하는지 확인한다
    - in-memory `KeyValueStore`의 `skyshard.save`에 `serializeSave(s, t)`를 쓰고 `loadSave`가 `kind: 'ok'`·`source: 'main'`·빈 `repairs`와 `s`와 deep-equal인 `state`를 돌려주는지 확인한다
    - `tests/property/saveRoundTrip.property.test.ts`, 첫 줄 `// Feature: skyshard-echoes-of-the-wild, Property 1: 저장 데이터 round-trip`, `numRuns: 200`(최소 100)
  - [x] 15.3 Property 2 속성 테스트: 불러오기의 전체성과 백업 복구
    - **Property 2: 불러오기의 전체성과 백업 복구**
    - **Validates: Requirements 36.10, 36.12**
    - `arbJsonish`로 주 저장·백업 키마다 임의 문자열·임의 JSON 값·잘린 JSON·필드를 망가뜨린 envelope·정상 envelope·빈 키 중 하나를 넣은 in-memory `KeyValueStore`를 만든다
    - `loadSave`가 예외 없이 `kind`가 `'ok'`·`'none'`·`'unrecoverable'` 중 하나인 `LoadResult`를 반환하고, `'ok'`면 `validateGameState(result.state)`가 빈 배열인지 확인한다
    - 주 저장이 있지만 읽을 수 없고 백업이 정상 envelope이면 `source`가 `'backup'`인지 확인한다
    - `tests/property/loadTotality.property.test.ts`, 첫 줄 `// Feature: skyshard-echoes-of-the-wild, Property 2: 불러오기의 전체성과 백업 복구`, `numRuns: 200`(최소 100)
  - [x] 15.4 Property 3 속성 테스트: 보정 결과의 범위와 멱등성
    - **Property 3: 보정 결과의 범위와 멱등성**
    - **Validates: Requirements 36.12**
    - `fc.anything()`과 필드를 무작위로 망가뜨린 `arbGameState`로 `raw`를 만들고, `sanitizeGameState(raw).state`가 `validateGameState`를 통과하며 수량 0–상한(소모품 10)·Glim ≥ 0·레벨 1–10·Skyshard 0–3이고 미정의 ID가 없는지 확인한다
    - 그 `state`를 다시 `sanitizeGameState`에 넣으면 같은 `state`와 빈 `repairs`가 나오는지 확인한다
    - `tests/property/sanitizeIdempotence.property.test.ts`, 첫 줄 `// Feature: skyshard-echoes-of-the-wild, Property 3: 보정 결과의 범위와 멱등성`, `numRuns: 200`(최소 100)
  - [x] 15.5 Property 4 속성 테스트: 버전 마이그레이션의 보존성
    - **Property 4: 버전 마이그레이션의 보존성**
    - **Validates: Requirements 36.11**
    - `arbLegacySave`로 `SAVE_VERSION`보다 낮은 버전 `v` 형식의 유효한 저장 데이터 `raw`를 만들고 `migrate(raw, v)`가 throw하지 않는지 확인한다
    - 결과를 `sanitizeGameState`에 넣으면 `repairs`가 비고 `validateGameState`를 통과하며, 원래의 Skyshard 수·퀘스트 단계·레벨이 그대로인지 확인한다
    - `tests/property/saveMigration.property.test.ts`, 첫 줄 `// Feature: skyshard-echoes-of-the-wild, Property 4: 버전 마이그레이션의 보존성`, `numRuns: 200`(최소 100)
  - [x] 15.6 SaveScheduler와 Continue: Milestone 0.5 s 병합·2 s 이내 저장, 90 s 주기, 전투·연출 중 보류, 쓰기 전 백업, 저장 표시기, 쓰기 실패 처리와 메모리 전용 경고, Continue 시 GameState로 월드 재구성·위치 배치, New Game 덮어쓰기
    - `src/save`의 `SaveScheduler`는 Milestone 11종의 `'save:request'`를 마지막 요청 뒤 0.5 s 무요청이나 첫 요청 뒤 1.5 s에 한 번 쓰고(실제 시간, 2 s 이내), In_Combat·연출·메뉴가 아닌 게임플레이 90 s마다 `'periodic'`을 내며, In_Combat·연출 중 요청은 보류했다가 둘 다 끝난 순간 도착한 요청으로 처리한다. 가짜 시계로 병합·주기·보류 unit test를 쓴다
    - 쓰기 직전 현재 주 저장이 불러오기 검사를 통과하면 원문을 `skyshard.save.bak`에 복사하고 고정 틱 뒤 `serializeSave` 결과를 `setItem`하며, 다음 틱에 `'save:done'`(저장 표시기) 또는 `QuotaExceededError`·`SecurityError`의 `'save:failed'`("저장 실패" 3 s, 대기 요청 비움, 게임플레이 계속)를 보낸다. 부팅 때 localStorage 접근·시험 쓰기가 실패하면 in-memory `KeyValueStore`로 이어가고 경고를 한 번 띄운다
    - Continue는 `ok` 결과로 `GateSystem.refresh`·Resonance_Altar 플래그(`seal_sanctum`·Starlit_Stair)·퍼즐·Chest·캠프·Elite·퀘스트 단계 spawn·NPC 대화 bucket·시간대를 연출 없이 적용하고 `createRuntimeState`로 `RuntimeState`를 새로 만든 뒤 Safe_Position(Challenge_Area면 최근 체크포인트, 무효면 부활 지점)에 둔다. New Game은 확인 창 뒤 주 저장을 `.bak`으로 옮겨 기본 `GameState`로 시작하고(`skyshard.settings` 유지), 메인 단계마다 저장 → 불러오기 뒤 다음 Objective 달성을 unit test한다
    - _Requirements: 36.3, 36.4, 36.5, 36.6, 36.7, 36.8, 36.13, 2.7, 4.8, 31.4_

- [x] 16. 오디오 (M7)
  - [x] 16.1 AudioEngine 그래프: master·limiter, 곡별 track gain을 둔 musicBus, ui·world·ambient·voice 하위 그룹을 둔 sfxBus, 공유 reverb, `setMusic`·`setSfx` 0.05 s ramp로 독립 on/off, 첫 입력 unlock·재시도, 탭 전환 suspend/resume, 가짜 AudioContext로 버스 독립성 unit test
    - `src/audio`의 `AudioEngine`이 부팅 때 `new AudioContext({ latencyHint: 'interactive' })` 하나를 만들고 `musicBus`(재생 곡마다 track gain)와 `sfxBus`(`ui`·`world`·`ambient`·`voice` 하위 gain)를 master gain 0.8 → limiter `DynamicsCompressorNode`(threshold −6 dB, ratio 12) → `destination`에 연결, `src/core/rng` 고정 seed noise로 만든 2 s impulse(RT60 ≈ 1.8 s)를 버스별 `ConvolverNode`가 공유하고 잔향은 버스 gain 앞에서 합쳐 버스와 함께 꺼지게 함
    - Audio_System이 `Settings`의 `musicOn`·`musicVolume`·`sfxOn`·`sfxVolume` 변경(슬라이더 조작 중 포함)을 구독해 `setMusic`·`setSfx`로 각자 자기 버스 gain만 목표값(on이면 볼륨의 제곱, off면 0)까지 `cancelScheduledValues` → `setValueAtTime` → `linearRampToValueAtTime(target, t + 0.05)`로 옮기고, 꺼진 버스에는 음 노드를 만들지 않되 시퀀서는 박을 계속 셈; 가짜 `AudioContext` Vitest unit test로 `setSfx(false)`가 `musicBus`를, `setMusic(false)`가 `sfxBus`를 바꾸지 않고 ramp가 0.05 s 안에 목표에 닿음을 단언
    - `suspended`인 동안 재생 호출은 no-op(`playMusic`·`setAmbient`는 마지막 요청만 기억)이고, `window` capture 단계 `pointerdown`·`keydown`의 첫 입력에서 `unlock()` → `resume()`, 거부되거나 `suspended`로 남으면(Esc keydown 등) listener를 유지해 다음 입력에서 재시도, `running`이 되면 listener를 떼고 기억한 곡·환경음을 시작하며 이후 `visibilitychange`에 맞춰 탭이 숨으면 `suspend()`, 보이면 `resume()`
    - _Requirements: 37.4, 37.5, 37.6_
  - [x] 16.2 절차적 음악: lookahead 시퀀서, 합성 악기 6종, 곡 데이터(Title/Thistlewick, Region 3곡, 전투, 보스 Phase 3곡, Sanctum, Crater, Challenge_Area 3곡, Victory), 선곡 우선순위와 1.5–3 s crossfade
    - 25 ms 타이머마다 `ctx.currentTime + 0.12` s 안에 시작하는 16분음 스텝을 audio clock 시각(곡 시작 + 스텝 × 60 / bpm / 4)으로 예약하고, 합성 악기 pad(detune saw 3개 → lowpass 1.2 kHz)·pluck(triangle, 0.25 s 감쇠)·airy lead(sine + 5 Hz vibrato + 숨소리 noise)·bell(2-operator FM, 주파수 비 3.5)·bass(square → lowpass 400 Hz)·percussion(noise hat·snare, sine sweep kick, low tom)은 음마다 새 노드로 `start`·`stop`을 예약한 뒤 `ended`에서 연결 해제
    - `src/data/music.ts`에 읽기 전용 `TrackDef { id; bpm; key; mode; bars; chords; layers; loop }`로 Title/Thistlewick `mus_title_village`, Region `mus_verdant`·`mus_ember`·`mus_azure`, 전투 `mus_combat`(`key: 'inherit'`), 보스 `mus_boss_p1`–`p3`(140/148/156 bpm, Phase마다 층 추가), `mus_sanctum`, pad·bell 층만 남긴 `mus_crater`, Challenge_Area `mus_area_hollowroot`·`mus_area_cinderspire`·`mus_area_observatory`, `mus_victory`를 설계 표의 bpm·조성·음색대로 작성하고, `bars` 끝에서 `loop`가 아닌 곡은 예약을 멈춤
    - 목표 곡은 Victory(`boss:defeated` 뒤) > 보스전(`BossEncounter.snapshot` Phase별 `mus_boss_p1`–`p3`) > In_Combat(`enemy:alerted`) > 영역 곡(`area:entered` 기준 Region 곡, Challenge_Area 곡, Title·Thistlewick은 `mus_title_village`, `crater`는 Resonance_Altar 활성화 전 `mus_crater`·후 `mus_sanctum`) 순으로 고르고, equal-power `setValueCurveAtTime` crossfade를 전투 진입 1.5 s·보스/Phase/Victory 2 s·영역 변경/전투 종료 3 s로 적용, 같은 bpm이면 현재 스텝에서 이어 시작하고 In_Combat 해제 뒤 3 s는 `mus_combat` 유지
    - _Requirements: 37.1, 37.3, 12.4_
  - [x] 16.3 효과음: 합성 레시피 카탈로그(재질별 발소리, 이동, 캐릭터 공격·능력, 피격, Reaction 6종, 적, UI, 보상·진행), 거리 감쇠·pan, 동시 32 voice, 활강 바람, Region 환경음, 화자별 발화음, 적 Telegraph 준비음
    - `src/audio/sfxRecipes.ts`에 `sfx_*` id마다 filtered noise envelope·FM tone·pitch sweep 조합 레시피로 재질 6종 발소리(pitch ±5%·gain ±2 dB 변주), 점프·착지·등반, 캐릭터별 공격·능력·교체음, 피격·Downed·`perfectDodge`, Reaction 6종 고유음, 적 archetype별 경고·공격 준비·피격·사망, UI·Burst 준비, Chest·발견·레벨업·Skyshard·퍼즐·Waystone 등 보상·진행음을 정의해 EventBus 이벤트와 clip `sfx`·`footstep` event로 재생하고, 적 공격 준비음은 Telegraph 시작과 함께 재생
    - `world` 음은 카메라를 청취자로 gain = min(1, 3 m / d)와 `StereoPannerNode` pan = sin(카메라 공간 방위각) × 0.8을 적용하고 60 m 밖은 생략, 단발음은 시작 위치 고정·Updraft·Wind_Zone loop는 약 15 Hz로 위치 갱신, 동시 32 voice를 넘으면 `world`에서 가장 작게 들리는 voice부터 정지; `setGlideWind(i)`는 i = clamp01(0.5·h / 40 m + 0.5·v / 13 m/s)로 wind loop gain과 lowpass cutoff(500 Hz → 4 kHz)를 0.2 s smoothing해 따르고 활강 종료 시 0.3 s fade 뒤 loop 정지
    - `setAmbient`는 `ambient` bed를 2 s crossfade로 바꾸고(Verdant 새소리·풀벌레, Ember 불꽃·낮은 울림, Azure 높은 바람·풍경, Crater·Sanctum 낮은 드론·수정 공명, `'interior'`는 방 울림만) 간헐음은 시드 난수 1–4 s 간격으로 예약; 대사 창마다 `voice` 그룹에서 `voicePitch`(NPC 7명·동료 4명에 서로 다른 반음) 음높이로 3–4음·0.3 s 이하 발화음을 내고 Vitest 데이터 테스트로 반음 값 중복 없음 검사
    - _Requirements: 37.2, 37.7, 19.8, 19.10, 26.5_
  - [x] 16.4 선택적 CC0 오디오: manifest 로드·decode, 실패 시 같은 id 합성음 대체, manifest id마다 레시피·TrackDef 존재 데이터 테스트
    - Title 표시 뒤 백그라운드에서 `public/assets/manifest.json`의 audio 항목(`mus_*`·`sfx_*` id와 파일 경로)을 `fetch` → `decodeAudioData`로 id별 `AudioBuffer` map에 올리고, 파일이 없거나 decode에 실패하면 경고만 남김
    - `sfx(id)`는 buffer가 있으면 `AudioBufferSourceNode`로, 없으면 같은 id 합성 레시피로 재생하고, `playMusic`은 `mus_*` buffer가 있으면 시퀀서 대신 그 buffer를 재생(반복 여부는 같은 id `TrackDef`의 `loop`), 사용한 파일은 `CREDITS.md`에 기록
    - Vitest 데이터 테스트로 manifest의 모든 오디오 id에 같은 id의 `sfxRecipes` 레시피나 `TrackDef`가 있는지 검사해 파일 유무와 관계없이 소리가 나도록 보장
    - _Requirements: 40.1, 40.6_

- [x] 17. Checkpoint - 저장·Continue·설정·오디오·모든 UI 화면이 정상 동작하는지 확인
  - 모든 테스트와 빌드가 통과하는지 확인하고, 질문이 있으면 사용자에게 묻는다.

- [x] 18. 렌더링 아트 패스 (M8)
  - [x] 18.1 공유 toon 재질(3단계 명암, rim, vertex color, fog cap)과 캐릭터·NPC·적·보스 전용 inverted-hull 외곽선, 렌더러 설정
    - 부팅 때 얻은 WebGL2 context(`antialias: false`)로 `WebGLRenderer` 생성, `SRGBColorSpace`·`NeutralToneMapping`(exposure 1.0)과 pixel ratio `min(devicePixelRatio, DPR 상한) × render scale` 적용
    - `createToonMaterial(opts)`: 3단계 gradient `DataTexture`(`NearestFilter`) `MeshToonMaterial`에 `onBeforeCompile`로 fresnel rim(`uRimColor`·`uRimPower`·`uRimStrength`)과 `fogCap`(`min(fogFactor, fogCap)`, 기본 1.0) 주입, `vertexColors: true` albedo, `terrain`–`enemy` 공유 instance 11종 고정
    - back face 전용 outline mesh가 법선 방향으로 0.02–0.05 m(카메라 거리 비례) 밀고 base color 약 35% 밝기로 그리며 대상은 캐릭터·NPC·적·Caelith와 든 무기로 한정, mesh를 늘려도 `renderer.info.programs` 수가 그대로인지 확인
    - _Requirements: 39.1_
  - [x] 18.2 하늘 돔과 진행 연동 시간대 프리셋 6종·4 s 전환, Region 팔레트와 color grading 혼합
    - 카메라를 따르는 sky dome(반지름 2,000 m, `BackSide`, `depthWrite: false`) `ShaderMaterial`로 하늘 gradient·태양/달 disc와 glow·cloud band·별 twinkle을 한 pass에 그리고, 태양 `DirectionalLight`·`HemisphereLight` 각 1개를 preset 값(별빛 밤 hemisphere ≥ 한낮 60%)으로 구동
    - 아침·한낮·오후·황혼·별빛 밤·일출 preset을 Skyshard 수·`altar:activated`·엔딩 완료로 골라 load 직후 즉시 적용하고 `cin_skyshard_1`–`3`·`cin_altar` 안에서 4 s 보간(색 linear lerp, 태양 방향 slerp), Caelith arena는 Phase 1–2 황혼·Final Phase 별빛 밤
    - Region 5종 swatch 팔레트와 grading 값(안개 tint·rim 색·채도·대비)을 경계 40 m `smoothstep` weight로 정규화 blend해 `GradingPass`·`uRimColor`(후처리 끔: `uGradeTint`·`uGradeSaturation`)에 전달, 최종 안개색을 `scene.fog`와 dome haze에 공유
    - _Requirements: 39.2, 8.10, 4.7_
  - [x] 18.3 Landmark 가시성(far plane 2,200 m, 거리 culling 제외, 원거리 LOD, fog cap 0.55)과 Astral Sanctum 봉인 고리 3분할 점등·제단 빛기둥
    - 카메라 `far` 2,200 m, `lm_*` mesh의 거리 culling·unload 제외, `THREE.LOD`로 400 m 너머 윤곽 유지 far low-poly 전환(지형 LOD 배율 미적용), `fogCap: 0.55` landmark 전용 재질 instance 적용
    - 품질 세 단계 모두에서 far plane·landmark LOD 거리·`fogCap`이 같고 월드 모서리를 포함한 표본 위치에서 모든 Landmark가 scene에 남는지 Vitest로 확인
    - Astral Sanctum seal ring 3 segment를 `skyshard:acquired` cinematic 안에서 하나씩 금색 emissive로 켜고(load 후 켜진 수 = 획득 수), Skyshard 3 획득 시 Resonance_Altar 위 light pillar(additive, `depthWrite: false`, `fog: false`, culling 제외) 표시
    - _Requirements: 9.1, 9.2, 4.4, 5.1, 5.3_
  - [x] 18.4 지형 LOD·skirt·재질 vertex color·절벽 지층 셰이더, 청크별 instanced 식생·바위·나무(Region별 3종)·밀도 설정·바람·풀 휘어짐, 소품 청크 병합, 모든 핵심 장소 구조물 prefab(Thistlewick 가옥, 풍차, Elderbough, 성소, 다리, 첨탑, 관측소, Sanctum)
    - 64 m 청크 3단계 LOD(2·4·8 m 격자, 160·400 m × 품질 배율)와 skirt, `materialAt` 기반 `TerrainMaterial` vertex color에 경사별 rock(Ember `ashRock`) 혼합과 저주파 노이즈 틴트, 급경사면의 월드 높이 기준 strata 밴드 셰이더 구현
    - 청크 × 종류 `InstancedMesh`(교차 잎 판 풀·꽃·덤불, 노이즈 icosahedron 바위 6종, Region별 나무 원형 3종 + 수관 LOD)에 밀도 0.4·1.0·1.6×와 풀 표시 거리 45·70·90 m, 청크 bounding box frustum culling, 높이 가중 바람과 반경 1 m bend uniform 적용
    - 마을 소품의 청크별 geometry 병합(청크당 ≈ 1 draw call), 기본 도형의 변위·베벨·조합 규칙, 핵심 장소 구조물 8종 prefab을 공유 toon 재질과 Region 팔레트 vertex color로 절차 생성
    - _Requirements: 39.3, 39.4, 39.5, 38.5, 8.3, 8.4, 8.5_
  - [x] 18.5 물 셰이더·폭포, Region별 대기 입자, 새·나비, 실내 조명 전환, Blight 시각 효과·정화·장막 셰이더, 동적 그림자와 blob shadow
    - toon 물 셰이더(561 × 561 half-float 높이 텍스처 기반 수심 틴트·foam 띠, fresnel 하늘 반사, 스크롤 노이즈 노멀, 파문 링 최대 8개)와 foam 띠 + mist 입자 폭포, 카메라 주변 40 m wrap 대기 입자(Verdant·Ember·Azure), boids-lite 새 떼 8–12마리와 꽃 군락 나비 구현
    - InteriorVolume 진입·이탈 시 fog·ambient·exposure 1 s blend, Active_Character를 따르는 80 m directional shadow map(1024·2048·끔, texel 스냅, caster는 캐릭터·적·보스·대형 구조물), 그림자가 꺼졌거나 상자 밖인 대상의 blob shadow decal 적용
    - Blight 결정·덩굴 `InstancedMesh`와 정점 mask × Region 강도 uniform, `skyshard:acquired` 3 s 정화(mask 0, 반짝임 입자, 결정 dissolve)와 load 시 즉시 정화 상태, 장막(`veil_ember`·`veil_azure`) 일렁임 셰이더, 모든 Blight 표면의 공유 재질과 `climbable=false`
    - _Requirements: 39.4, 9.7, 4.7, 18.1, 39.9_
  - [x] 18.6 후처리(half-res bloom, grading, FXAA), 품질 프리셋 3종의 실시간 적용(1 s 이내, 재시작 없음), 성능 예산 달성(draw call ≤ 500, 삼각형 ≤ 1.5M, 1080p 평균 60 fps)과 F3 측정
    - `src/render/post.ts`의 `EffectComposer`를 `RenderPass`(half-float) → `UnrealBloomPass`(절반 해상도, 높음은 전체, 높은 threshold) → `GradingPass` → `OutputPass` → FXAA(보통·높음, `resolution` 갱신) 순으로 구성하고, 끔이면 `renderer.render` 직접 호출
    - 낮음·보통·높음 preset과 개별 덮어쓰기(render scale 50–100%, 그림자, 식생 밀도, 후처리)를 바뀐 항목 자원만 재생성(shadow map 재할당, 공유 재질 `needsUpdate`, 보이는 청크 instanced buffer, composer, particle 용량)해 1 s 안에 적용하고 localStorage에 즉시 저장
    - F3 `perfOverlay`(fps, `renderer.info.render.calls`·`triangles`, `autoReset = false`)와 Playwright 봇의 고정 시점(Village, Landmark 전망 지점, 보스 arena) draw call ≤ 500·삼각형 ≤ 1.5M assert, Dev_Machine 1080p 평균 fps 측정값 Final_Report 기록
    - _Requirements: 38.1, 38.2, 38.3, 38.4, 38.5_

- [x] 19. 캐릭터·적·보스 비주얼, 애니메이션, VFX (M8)
  - [x] 19.1 rig kit와 rigid skinning 병합(본체 1 + 외곽선 1 SkinnedMesh), 캔버스 얼굴과 눈 깜빡임, 스프링 체인
    - `src/anim/rigKit`의 `buildRig(spec: RigSpec)`: `humanoid`·`quadruped`·`crab`·`stalk`·`floater` preset 관절과 socket(`weaponR`·`weaponL`·`back`·`headTop`), lathe 몸통·tapered capsule 팔다리·spline 머리카락 clump를 결정적으로 생성(전체 rig 로딩 중 200 ms 이내)
    - 부위 attribute(`position`·`normal`·`uv`·`skinIndex`·`skinWeight`·`color`·`aFx`)를 맞춰 `mergeGeometries`(관절 1개 weight 1, `chain` 부위만 인접 뼈 smoothstep 분배), 몸·외곽선 `SkinnedMesh`의 geometry·`Skeleton` 공유(face plane은 외곽선에서 퇴화)와 `attachWeapon`, 결정성·공유 구조 Vitest
    - 768 × 768 `CanvasTexture` 얼굴 atlas(눈 3 × 입 3 cell, 8 px 여백)로 3–5 s 무작위 깜빡임·대사 중 0.1 s 입 변경을 uniform만으로 처리하고, 4–8마디 spring chain에 60 Hz verlet(바람 저항, 충돌 구, 교체·순간이동 시 rest 초기화) 적용
    - 관절 이름은 VRM humanoid bone 이름(`hips`, `spine`, `chest`, `neck`, `head`, `leftShoulder`·`leftUpperArm`·`leftLowerArm`·`leftHand`, `leftUpperLeg`·`leftLowerLeg`·`leftFoot`, 오른쪽 대응 관절)과 `root`·socket(`weaponR`, `weaponL`, `back`, `headTop`)·spring 관절 이름을 쓰고, rest는 +Z 정면 T-pose·모든 관절 world 회전 identity로 만들어 절차적 모델이 normalized humanoid와 같게 한다
    - _Requirements: 40.4, 39.6, 43.4_
  - [x] 19.2 영웅 4명 모델(체형·머리 실루엣·의상·팔레트·무기 형상, 30 m 실루엣 구별)과 시작 시 포트레이트 렌더, 임시 캡슐 표시 교체
    - Kairen(1.72 m, 스카프 chain 6마디, crimson·charcoal·gold, 곡검), Isla(1.80 m, 포니테일 chain 7마디·후드 망토, teal·white·navy, recurve 장궁·시위), Wren(1.45 m, 깃털 망토·고글, mint·cream·amber, 초승달 글레이브), Talus(2.05 m, 어깨 폭 1.5×, ochre·stone grey·moss, 탑형 방패) `RigSpec`과 무기 형상 생성기 작성
    - 발바닥을 공통 충돌 캡슐(r 0.4 m, h 1.75 m) 바닥에 맞추고 Element glow line `uGlow`(평소 0.3, Skill·Burst 시전 중 1.0)를 연결, 1080p·세로 fov 60°·30 m 거리에서 키·폭·외곽 강조·주 색상으로 네 명이 구별되는지 Playwright 스크린샷으로 검토
    - 로딩 중 각 영웅 rig를 offscreen render target에 한 번 그려 HUD 파티 슬롯 portrait(64 × 64)로 공급하고, 기존 임시 캡슐 표시를 rig 모델로 교체(충돌 캡슐·sim 변경 없음)
    - _Requirements: 22.5, 32.2_
  - [x] 19.3 적 8종·Elite 6체·NPC 7명·Caelith 모델(Starshell, Final Phase 균열, 사망 파편)
    - 적 8종(`bramblekin`, `thornspitter`, `mossbackBrute`, `cinderHound`, `slagshell`, `ashWisp`, `windcutter`, `aetherSentinel`)을 종별 preset·팔레트·파츠 고정 모델로 만들고 파츠를 몸 geometry에 병합해 1체 2 draw call 유지, Element_Shield는 Starshell과 같은 shell shader 사용
    - Elite 6체는 기반 모델 1.4×에 가시 왕관·뿔·결정 갑주 파츠, additive fresnel 오라 shell, 이름표를 더하고 `rootboundWarden` 고유 모델과 `sentinelPrime` 드론 2기를 구성, NPC 7명(Elder Maren, Pip, Old Bram, Tamsin, Hobb, Durga, Oriel)은 비율·의상·팔레트와 얼굴 atlas로 구분
    - Caelith(≈ 6 m, 결정 판 몸통·별 왕관·결정 대검, 후광 파편 8개 `InstancedMesh`, 별빛 망토 ribbon 6장), Phase 2 Starshell(반경 3.4 m icosphere, Element 색·아이콘 0.3 s crossfade, 파괴 파편), Final Phase 균열 `uGlow` 0 → 1, 사망 dissolve와 파편 흩어짐을 합계 7 draw call로 구현
    - _Requirements: 28.1, 40.4, 14.9_
  - [x] 19.4 애니메이션 시스템: `PoseClip`·Animator 레이어·0.1–0.25 s crossfade·절차적 레이어, 영웅 공용·캐릭터별 클립, 적·보스·NPC 클립, 공격 hit 이벤트와 AttackDef 시각 일치 데이터 테스트
    - `PoseClip` load(Euler → quaternion, 관절 이름 → bone index, 없는 관절은 오류)·ease slerp·scaled time·`rootMotion.forward` 속도 맞춤·event 발생, Animator 3 layer(base 1D blend·action·full-body override)와 `BLEND_TIMES` crossfade·snapshot, 순수 함수 `selectAnimState`, 절차적 레이어(골반 높이, 호흡, 시선, 기울기·착지 squash, 무기 궤적 anchor) 구현
    - `src/anim/clips/`에 영웅 공통 clip 20종(등반 4방향 2D blend), 캐릭터별 공격·Skill·Burst clip(공유 없음, Burst는 1.0 s 이하 cut-in 뒤 첫 `hit`), 적 종별 clip 7종과 Elite windup·strike, Caelith 공격 8종·`phaseShift`·`disabled`·`death`, NPC `idle`과 `work`·`walk`·`lookAround` 작성
    - 공격 clip 시각을 sim 공격 경과 시간의 렌더 alpha 보간으로 구동하고, Vitest `clipSync`(참조 clip 존재, 판정 ±1 tick 안 `hit` 일치와 여분 없음, timeline = `duration`, windup ≥ Telegraph 시간)와 `BLEND_TIMES` 0.1–0.25 s 범위 테스트 작성
    - _Requirements: 39.6, 39.7, 39.8, 22.6, 24.1, 14.9_
  - [x] 19.5 VFX 시스템: 파티클 풀·스프라이트 아틀라스·무기 궤적, VFX 위에 그리는 telegraph decal, hit flash·방향성 impact, 피해 숫자 DOM 풀(24), Element·Reaction별 연출, 월드·진행 연출, 교체 소용돌이, Perfect_Dodge 잔상, Stagger 표시, 사망 소멸
    - `src/vfx`의 `VfxSystem`(EventBus 구독 + Combat_System 직접 `onHit`, 부팅 pool), 단일 GPU `Points` buffer(2,000·4,000·6,000, additive 60%·alpha 40% 2 draw call, 실시간 `uTime`), 384 × 384 sprite atlas 9종, 고리·폭발 구·파편·덩굴 mesh pool, 최근 0.15 s Catmull-Rom 12 segment 무기 궤적 구현
    - telegraph decal 4종(circle·sector·line·ring, pool 12, 지면 정합, 가장자리 → 중심 `uProgress` fill, 일반 `#FF4A2A`·보스 gold-red, 사선 무늬)을 VFX보다 높은 `renderOrder`·`polygonOffset`으로 그리고, `uHitFlash` 0.1 s·35° 원뿔 impact, `aria-hidden` 피해 숫자 pool 24(치명타 1.5×, Reaction 한국어 이름 1.0 s), 피격 vignette·방향 호 0.4 s 구현
    - Element 4종·Reaction 6종 고유 연출, `levelUp`·`chest:opened`(빛나는 Chest는 2배 빛기둥)·`skyshard:acquired`·`barrier:opened`·`altar:activated` 연출, `party:switched` 0.3 s 소용돌이, `perfectDodge` 잔상 3개 0.5 s, Stagger 별 billboard 2 s, 사망 0.4 s 뒤 `uDissolve` 1.0 s·1.5 s 안 pool 반환, 낮음에서도 `essential` 효과 유지
    - _Requirements: 26.1, 26.2, 26.5, 26.6, 26.7, 26.8, 26.9, 25.9, 23.7, 24.9, 10.6_
  - [x] 19.6 타격감: 강한 타격의 50–90 ms Hit_Stop과 camera impulse, Normal_Attack 일반 명중에는 흔들림 없음
    - Charged_Attack 마지막 타격·Burst 명중·폭발형 Reaction(`steamBurst` 70 ms)·Element_Shield 파괴에서 `setTimeScale('hitStop', 0, …)`으로 실시간 50–90 ms Hit_Stop을 요청하고, sim·animation clip만 멈춘 채 렌더·camera·UI·VFX `uTime`은 실시간 갱신
    - camera `addTrauma()`(초당 1.6 감쇠, `maxOffset · trauma² · noise(t)`, 위치 0.25 m·회전 3°, 화면 흔들림 설정 배율, 15–30 m 거리 감쇠)에 Charged_Attack 마지막 타격 0.35·Element_Shield 파괴 0.4·폭발형 Reaction 0.4·Burst 0.5 연결
    - Normal_Attack 일반 명중은 Hit_Stop·trauma 없이 hit flash·impact만 내고 강한 타격의 Hit_Stop 길이는 50–90 ms 안인지 Vitest로 확인
    - _Requirements: 26.3, 26.4_
  - [x] 19.7 Visual_Provider 구조와 절차적 공급자
    - `src/data/visualManifest.ts`: 모든 CharacterId·EnemyId·EliteId·BossId·NpcId에 기본 `{ source: { kind: 'procedural' }, rig }` 항목, 교체 방법을 적은 파일 머리 주석, 순수 `resolveVisualSpec`(잘못된 항목 → 절차적 spec + 경고 1회)
    - `src/visual`: `VisualProvider`·`VisualTemplate`·`VisualInstance` 인터페이스, rig kit을 감싼 `ProceduralVisualProvider`, 템플릿 캐시와 인스턴스 복제, `EntityView.swapVisual`(게임플레이 중 즉시 교체)과 파티 portrait 재렌더
    - 의존 규칙 스캔 테스트 확장: 시뮬레이션 모듈과 `src/logic`·`src/data`가 `src/visual`·`src/anim`·`src/render`를 import하지 않음
    - `tests/unit/visualManifest.test.ts`: 모든 CharacterId·EnemyId·EliteId·BossId·NpcId에 항목이 있고 키는 정의된 엔티티 ID뿐이며, 기본 제공 항목이 모두 `procedural`인지 확인하는 데이터 테스트를 작성한다
    - _Requirements: 40.4, 43.1, 43.3, 43.7, 43.8_
  - [x] 19.8 외부 모델 어댑터(glTF/GLB·FBX·VRM)와 humanoid retarget
    - `GLTFLoader`·`FBXLoader`(three/addons)와 `npm install --save-exact @pixiv/three-vrm` 후 `VRMLoaderPlugin`을 dynamic import로 불러오는 어댑터, 15 s 시간 초과·지원 형식·필수 humanoid bone 검사와 절차적 대체
    - bone 자동 감지(VRM humanoid, Mixamo, 일반 이름 동의어)와 `boneMap` 수동 지정, rest 정보 저장과 `retargetPose`(`raw = P⁻¹·q·P·R`), `restPose` A-pose 보정, 높이·정면·발 위치 정규화, socket 연결, `clips` 대응 `AnimationMixer` 재생(AttackDef 길이에 맞춘 속도), generic 모델의 절차적 루트 애니메이션
    - 재질 `toon`/`original`과 외곽선 복제, hit flash·반투명·dissolve 공통 적용, VRM expression 눈 깜빡임·spring bone 갱신, `model-lab.html` 개발 페이지(엔티티별 bone 대응표·포즈·socket 확인, 절차적 모델 GLB 내보내기)
    - `vite.config.ts`의 `build.rollupOptions.input`에 `index.html`과 `model-lab.html`을 함께 등록해 Playwright가 쓰는 preview 빌드에서도 model-lab이 열리게 하고, `@pixiv/three-vrm`은 Visual_Manifest에 VRM 항목이 있을 때만 요청되는 별도 chunk로 둔다
    - _Requirements: 43.2, 43.4, 43.5, 43.6, 43.7_
  - [x] 19.9 Property 31 속성 테스트: Humanoid retarget 방향 보존
    - **Property 31: Humanoid retarget 방향 보존**
    - **Validates: Requirements 43.4**
    - `tests/property/humanoidRetarget.property.test.ts`(태그 `// Feature: skyshard-echoes-of-the-wild, Property 31: Humanoid retarget 방향 보존`, `numRuns` ≥ 100): 임의 rest 회전·bone 길이 골격과 임의 포즈에서 retarget 후 bone world 방향이 공통 골격 결과와 1e-4 이내
  - [x] 19.10 Property 32 속성 테스트: Visual_Manifest 해석의 전체성
    - **Property 32: Visual_Manifest 해석의 전체성**
    - **Validates: Requirements 43.1, 43.7**
    - `tests/property/visualManifest.property.test.ts`(태그 `// Feature: skyshard-echoes-of-the-wild, Property 32: Visual_Manifest 해석의 전체성`, `numRuns` ≥ 100): 임의 JSON 항목에 대해 예외 없이 유효한 spec을 반환하고 잘못된 항목은 절차적 spec과 경고 1개

- [x] 20. 월드 밀도와 POI (M8)
  - [x] 20.1 POI 데이터와 배치
    - `src/data/pois.ts`의 `PoiDef` 목록에 주요 Region별 Enemy_Camp 2, `context`를 가진 Chest 6(등반·활강으로만 닿는 높은 곳의 빛나는 Chest 1 이상), 퍼즐 2, Echo_Tablet 3, Vista 1, Waystone을 배치한다
    - 숨겨진 장소(첫 진입 시 "숨겨진 장소 발견" 알림·전용 효과음·지도 등록)와 숨겨진 Elite, lore·cache·herb, azure Sky Ring Trial(링 8개, 제한 60 s, 종점 빛나는 Chest)을 추가한다
    - `tests/unit/pois.test.ts`: region·kind별 최소 수량 미달, `context` 없는 Chest, 주요 Region의 `high` 빛나는 Chest 부재 중 하나라도 있으면 실패하는 데이터 테스트를 작성한다
    - _Requirements: 10.2, 10.3, 10.4, 10.10, 9.6_
  - [x] 20.2 Property 29 속성 테스트: POI 60 m 커버리지
    - **Property 29: POI 60 m 커버리지**
    - **Validates: Requirements 10.1**
    - `tests/property/poiCoverage.property.test.ts`에 `// Feature: skyshard-echoes-of-the-wild, Property 29: POI 60 m 커버리지` 태그를 달고 `numRuns: 100` 이상으로 실행한다
    - `buildTerrain(seed)`의 x, z ∈ [−470, 470]에서 임의 walkable 지점(경사 ≤ 50°, 수심 1.2 m 미만, 경계 안)을 생성해 최근접 POI까지 3D 거리가 60 m 이하인지 검사한다
    - 실패 지점은 군집 중심 좌표·Region으로 출력하고, 미커버 구역은 lore·cache·herb POI를 더해 채운다
  - [x] 20.3 시야 검증과 발견
    - `sl_verdant`·`sl_ember`·`sl_azure`(`SightlineDef`)의 눈높이 `pos.y + 1.55 m`에서 다음 목적지 Landmark 실루엣 중심이 정면 15° 안에 막힘 없이 보이는지 heightfield `CollisionWorld.raycast`로 테스트한다
    - 각 Vista 눈높이에서 다른 주요 Region 대표 Landmark 1개 이상과 `lm_astral_sanctum`의 바운딩 높이 50·75·100% 지점 중 하나로 가는 광선이 막히지 않는지 raycast 테스트한다
    - Landmark 발견 반경 첫 진입에 framing 연출·장소명·지도 등록을, Vista 도달에 반경 200 m 지도 공개와 그 안의 Waystone·Landmark 표시를 연결한다
    - _Requirements: 9.3, 9.4, 9.5, 9.8_
  - [x] 20.4 Region 차별화 데이터 테스트와 월드 경계 구현
    - 주요 Region의 각 쌍이 지형, 팔레트, 식생, 건축, 적, 이동, 위험, 음악, Landmark 중 6개 이상에서 다른지 Region 정의 데이터로 비교하는 데이터 테스트(`tests/unit/regions.test.ts`)를 작성한다
    - 외곽 산맥과 구름 바다로 월드 가장자리를 감싸 자연스러운 끝을 만든다
    - 중심 거리 470 m 경계 벽으로 플레이 영역 밖 이탈을 막는다
    - _Requirements: 8.2, 8.6_

- [x] 21. 연출·온보딩·세계 변화 (M9)
  - [x] 21.1 Cinematic_System 재생기
    - `src/cinematics/cinematicPlayer.ts`: `CinematicDef`의 Shot을 anchor 기준 `CamPose` 보간으로 재생하고, PauseMode `'cinematic'`으로 적·hazard를 멈추며 pointer lock 해제와 HUD 숨김을 처리한다
    - 3 s를 넘는 `skippable` 연출은 시작 1 s 후 Esc/Space 1 s 유지로 건너뛰고, 남은 `worldChange`·`timeOfDay` 이벤트를 모두 적용해 끝까지 본 경우와 World 상태를 맞춘다
    - 종료 다음 sim 틱부터 조작을 받아 0.3 s 안에 복귀하고, `once: 'perSave'` 연출은 `GameState.cinematicsSeen`으로 저장 파일당 1회만 재생한다
    - _Requirements: 21.9, 21.10, 21.11, 7.2_
  - [x] 21.2 연출 데이터 전체 작성
    - `src/data/cinematics.ts`에 `cin_landmark_*` 8, `cin_area_*` 3, `cin_join_*` 3, `cin_skyshard_1`·`2`·`3`(1·2는 `gate_ember`·`gate_azure` Blight_Barrier 파괴 컷 포함)을 정의한다
    - `cin_altar`, `cin_boss_intro`, `cin_boss_phase2`·`cin_boss_phase3`, `cin_ending`(20–45 s, 끝나면 Victory Screen)을 정의하고 계기 이벤트(`'landmark:discovered'`, `'party:joined'`, `'skyshard:acquired'`, `'boss:phaseChanged'` 등)에 연결한다
    - `tests/unit/cinematics.test.ts`로 shot 빈틈·겹침, `skippable` = `duration > 3`, id 접두어와 연출별 길이 상한을 검사한다
    - _Requirements: 4.2, 4.5, 4.6, 5.4, 6.10, 6.11, 7.1, 9.4, 12.5, 22.3_
  - [x] 21.3 세계 상태 변화
    - `'skyshard:acquired'`마다 봉인 고리 1개 점등, 해당 Region Blight 정화, `timeOfDay` 4 s 보간으로 시간대 진행, Thistlewick 마을 단계 변화를 적용한다
    - 엔딩 후에는 Blight가 걷힌 세계와 NPC 엔딩 후 대사를 적용하고, Victory Screen에서 "탐험 계속"을 고르면 Thistlewick에 배치한다
    - 게임 완료 여부와 Victory 통계를 저장 데이터에 기록한다
    - _Requirements: 4.4, 4.7, 7.5, 7.6, 8.10, 14.8_
  - [x] 21.4 첫 10분 온보딩 배치와 도달 시간 테스트
    - 첫 10분 경로에 이동·카메라·점프·공격·Dodge·교체·Skill·Reaction·등반·활강이 각각 필요한 지형·적·장애물을 배치한다
    - 동료 합류 시점을 첫 10분 흐름에 맞추고, `cin_join_*`가 끝나면 교체 키 Tutorial_Hint를 띄운다
    - Isla 합류 직후 증기 폭발 Reaction을 써야 하는 전투를 배치한다
    - `tests/unit/onboarding.test.ts`: 메인 경로 polyline과 단계별 시간 예산 데이터로 이동·카메라·점프·공격·Dodge·교체·Skill·Reaction·등반·활강이 처음 필요한 지점까지의 예상 도달 시간을 계산해 모두 10분 이내이고, 각 지점에 해당 조작의 Tutorial_Hint 트리거가 있는지 확인한다
    - _Requirements: 34.2, 34.6, 22.2, 22.3_

- [x] 22. Debug_Tools와 Test_Harness
  - [x] 22.1 `?debug=1` 전용 Debug_Tools
    - `src/debug`: `?debug=1`일 때만 F9 "DEBUG" 패널(무적, 캐릭터 전원 합류, Glim 지급, Skyshard 지급, 지점 이동, 보스 직행, 적 AI 상태 표시)을 mount하고, 매개변수가 없으면 패널 DOM과 단축키를 만들지 않는다
    - 패널 조작은 큐에 넣어 다음 틱에 정상 플레이와 같은 공개 메서드로 적용하고, 메인 진행은 디버그 없이도 완료되게 유지한다
    - 기능 첫 실행 시 저장 데이터의 `GameState.debugUsed`를 true로 두고 `sessionStorage` 세션 플래그를 남기며, HUD "DEBUG" 표시와 Victory 화면 "디버그 사용됨"을 띄운다
    - _Requirements: 41.1, 41.2, 41.3, 41.4, 7.7_
  - [x] 22.2 읽기 전용 Test_Harness
    - `src/harness`: 모든 build에 `window.__SKYSHARD_HARNESS__`를 설치하고, `snapshot()`은 마지막 틱 상태를 `structuredClone`해 재귀 `Object.freeze`한 스냅샷(`audio` 필드 포함)을 돌려준다
    - `events(sinceSeq)`는 Reaction·Phase·연출·Objective·Skyshard·화면·wipe 항목을 512칸 ring buffer에서 동결 배열로 돌려주고, harness 객체는 `Object.create(null)` 평면 객체로 만들어 `Object.freeze`한다
    - `tests/unit/harness.test.ts`: harness와 스냅샷이 재귀 frozen·`writable: false`이고 함수 property가 `snapshot`·`events`뿐인지, strict mode 쓰기가 `TypeError`를 내고 다음 스냅샷이 그대로인지 확인한다
    - _Requirements: 42.2_

- [x] 23. Checkpoint - 전체 비주얼·연출·밀도 패스 후 모든 테스트와 빌드, 최소 전체 경로가 여전히 동작하는지 확인
  - 모든 테스트와 빌드가 통과하는지 확인하고, 질문이 있으면 사용자에게 묻는다.

- [x] 24. 검증 (M10)
  - [x] 24.1 Vitest 전체 정비
    - `tests/unit`에 설계의 단위·예시·데이터 테스트를 채운다: 반응 표(표 B 6조합), 방어 파괴(Mossback Brute), 방어막 파괴(Element_Shield), Energy·Cooldown, Stamina, XP 표, 상점·제단 비활성, 튜토리얼 큐, 대화 bucket 우선순위, 게이트(`gate_*`·`veil_*`)
    - 퀘스트 재생(`ms1`–`ms10`), 단계별 저장→불러오기, 손상 저장, import 경계, 경로 길이, 보스 시뮬레이션(Phase당 60–150초, 합계 3–6분)을 더하고 속성 테스트를 포함한 `npm test`가 전부 통과하게 한다
    - _Requirements: 42.1_
  - [x] 24.2 Playwright 구성
    - `playwright.config.ts`에 webServer(`npm run build && npm run preview -- --port 4173`), projects `system`·`playthrough`, viewport 1920×1080, `workers: 1`을 두어 `dist/` 정적 빌드로 테스트한다
    - headed Chromium GPU 플래그(`--use-angle=d3d11` 등)와 실행 파일이 없을 때의 `channel: 'msedge'` 대체, 공통 fixture의 console error·pageerror·외부 요청 기록기와 SwiftShader 감지를 구성한다
    - _Requirements: 42.5, 42.6, 1.3_
  - [x] 24.3 시스템 시나리오
    - `tests/e2e/system`에서 Thistlewick 주변 정상 플레이로 이동·등반(`C` 이탈)·활강(낙하 ≤ 2.5 m/s)·전투·파티(`1`–`4` 교체)·UI(Pause, Map, Inventory, Settings)를 harness 스냅샷으로 판정한다
    - 저장→새로고침→Continue 복원, Music/SFX 독립(`musicBusGain`·`sfxBusGain`), 성능 3지점(Thistlewick, Ember canyon, Sanctum arena)의 F3 draw calls ≤ 500·triangles ≤ 1.5M·평균 60 fps 이상(Dev_Machine 기준)을 확인한다
    - 모델 교체 시나리오: `model-lab.html`에서 절차적 Kairen을 GLB로 내보내 교체 경로로 다시 불러오기, 같은 GLB에 `VRMC_vrm` 확장을 넣은 VRM 불러오기, CC0 FBX 샘플 불러오기(구하지 못하면 미검증 기록), 손상 파일 → 절차적 대체를 확인하고 스크린샷 저장
    - _Requirements: 42.5, 37.4, 38.3, 38.4, 43.2, 43.4, 43.5, 43.6, 43.7, 43.8, 43.10_
  - [x] 24.4 입력 전용 완주 봇
    - `tests/e2e/bot`에 `harness.ts`(읽기 전용 snapshot·events 폴링, 50 ms 이상 간격), `keys.ts`, `navigate.ts`, `traverse.ts`, `combat.ts`, `boss.ts`를 폐루프 행동으로 구현한다
    - `route.ts`에 `ms1`–`ms10` 단계별 Step 목록을 두고, `?debug=1` 없이 키보드·마우스 입력만으로 진행하며 디버그 기능은 호출하지 않는다
    - _Requirements: 42.3, 42.4_
  - [x] 24.5 전체 완주 테스트와 스크린샷 점검표 생성
    - `tests/e2e/playthrough.spec.ts`: 봇으로 Title → Victory를 완주하며 단계별 소요 시간을 기록하고, 콘솔 error·pageerror·외부 요청 0건과 실행 내내 `debugUsed === false`를 assertion으로 확인한다
    - 12장면 스크린샷(`test-results/screenshots/`, Challenge_Area 3장 포함 총 14장)과 장면별 결함 점검표 8항목을 담은 `test-results/screenshots/review.md`를 함께 생성한다
    - 점검표에서 나온 결함(빈 지형, 기본 도형 나열, 구별되지 않는 캐릭터, 기본 HTML 스타일 UI, 지형을 통과한 카메라 등)은 콘텐츠 추가보다 먼저 해당 모듈의 코드·데이터를 고친 뒤 `playthrough` 프로젝트를 다시 실행한다
    - _Requirements: 42.3, 42.4, 42.6, 42.7, 42.8, 2.1, 2.2_
  - [x] 24.6 완주 계측 기반 플레이 경험 개선
    - 완주 spec이 `test-results/playthrough-metrics.json`에 단계별 소요 시간(설계의 메인 진행 시간 예산 대비), 보스 Phase별 시간, Safe_Position 복귀·끼임 해제 횟수, 5 s 이상 진척이 없는 정체 횟수, 카메라가 캐릭터 1 m 안으로 들어온 횟수를 기록하게 한다
    - 목표를 벗어난 항목(전체 20–30분, 보스 3–6분·Phase당 60–150 s, 복귀·정체 0회)과 스크린샷 점검 결과를 기준으로 가장 약한 부분(카메라, 타격감, 빈 구간, 길 안내)을 코드·데이터로 개선한다
    - 개선 뒤 `npm test`와 `system`·`playthrough` 프로젝트를 다시 실행해 회귀가 없고 완주가 유지되는지 확인한다
    - _Requirements: 2.2, 2.8, 6.12, 42.8_

- [x] 25. 에셋·크레딧·독창성·검증 요약
  - [x] 25.1 선택적 CC0 에셋 반입
    - CC0 출처의 환경 소품·효과음 일부를 `public/assets/{models,audio}/`와 `manifest.json`(`license: 'CC0-1.0'`)에 추가하고, 모델 재질은 공유 toon 재질과 Region 팔레트 색으로 교체한다
    - 로드 실패·manifest 제외 시 같은 `id`의 절차적 생성기·Web Audio 합성 대체를 유지하고, 기본 제공 Player_Character·적·Elite·Caelith 모델은 코드로 생성하며 외부 모델 교체는 `visualManifest.ts`로만 한다
    - 결과: 선택 항목이라 외부 에셋은 반입하지 않았다(`manifest.json` 비어 있음, CREDITS.md "외부 에셋 없음"). 모든 소품·효과음·모델은 코드 생성이며, manifest 항목이 없거나 로드에 실패하면 같은 `id`의 합성·절차적 대체가 쓰이는 경로는 `tests/unit/audio/manifest.test.ts`·`tests/unit/credits.test.ts`와 모델 교체 시나리오(손상 파일 → 절차적 대체)로 검증된다
    - _Requirements: 40.1, 40.5, 40.6_
  - [x] 25.2 `CREDITS.md`와 `src/data/credits.ts` 동기화 테스트, Credits 화면
    - `CREDITS.md`에 반입 에셋의 이름·제작자·URL·라이선스·경로와 사용 라이브러리·라이선스(three.js MIT, Vite MIT 등)를 적고 `src/data/credits.ts`를 같은 내용으로 맞춘다
    - `tests/unit/credits.test.ts`로 두 목록의 항목·필드 일치와 manifest 항목의 등재·`CC0-1.0` 여부를 확인하고, Title Screen의 Credits 화면이 `credits.ts`를 표시하게 한다
    - 교체 검증용 CC0 FBX 샘플(`tests/fixtures/models/`)과 교체 모델의 `credit` 항목도 CREDITS.md에 기록
    - _Requirements: 40.2, 40.3, 43.9_
  - [x] 25.3 독창성 가드 테스트
    - `tests/unit/originality.test.ts`: 모든 표시 문자열(캐릭터·적·NPC·지명·아이템·능력·Reaction 이름, 대사, UI·튜토리얼 문구)과 ID를 `tests/fixtures/originality-denylist.json`(기존 오픈월드 액션 RPG의 원소 명칭·지명·캐릭터·몬스터·시스템 고유명사 목록)과 대조해 일치하면 실패하게 한다
    - 걸린 항목과 비슷한 이름·형태·선율·문장은 새 것으로 바꾸고 관련 데이터와 테스트를 함께 갱신한다
    - _Requirements: 40.7_
  - [x] 25.4 검증 요약 생성기
    - Vitest JSON 출력(`--reporter=json --outputFile`)과 Playwright custom reporter(`tests/e2e/reporters/summaryReporter.ts`) 결과, 스크린샷 목록, 성능 측정값, 모델 교체 검증 결과를 합쳐 `test-results/verification-summary.md`를 만드는 순수 함수 `buildVerificationSummary`를 작성한다
    - 모든 검증 항목을 `통과`·`실패`·`미실행(원인)` 중 하나로 표기하고, 결과가 없는 항목(브라우저·WebGL 사용 불가, FBX 샘플 없음 등)은 `미실행`으로만 표기되는지 `tests/unit/verificationSummary.test.ts`로 확인한다
    - 요약에 실행 방법(`npm install` → `npm run dev`, `npm run build`·`npm run preview`, 테스트 명령), 기본 조작 표, 시각 모델 교체 절차(파일 배치 → `visualManifest.ts` 수정 → `model-lab.html?entity=<id>` 확인 → CREDITS.md 기록)를 정적 섹션으로 넣어 최종 보고의 근거로 쓴다
    - _Requirements: 42.9, 42.10, 43.10_

- [x] 26. Final Checkpoint - 검증 요약을 근거로 모든 테스트·빌드·완주 결과를 확인하고 최종 보고 전 남은 문제를 정리
  - 모든 테스트와 빌드가 통과하는지 확인하고, 질문이 있으면 사용자에게 묻는다.

## Notes

- `*`가 붙은 작업은 선택 항목(주로 보조 속성 테스트·CC0 에셋)으로 빠른 진행 시 건너뛸 수 있지만, 핵심 속성 테스트와 완주 검증은 필수다.
- 각 작업은 `_Requirements_` 줄의 요구사항 번호로 추적된다.
- 체크포인트마다 `npm run build`와 `npm test`를 실행한다.
- 속성 테스트는 모든 입력에 대한 보편 규칙을, 단위 테스트는 구체 사례와 경계를 검증한다.
- 임시 표시(캡슐 캐릭터, 단순 prefab)는 작업 18·19에서 모두 교체해 placeholder가 남지 않게 한다.
- 디버그 기능으로 건너뛴 경로는 완주 검증으로 인정하지 않는다.
- 이미 작성된 코드가 있는 작업은 관련 파일과 테스트를 먼저 확인해 이어서 구현하고, 동작하는 코드를 다시 만들지 않는다.

## Task Dependency Graph

작업은 아래 wave 순서로 실행한다. 한 코드베이스에서 파일 충돌이 없도록 대부분 순차로 두고, 서로 다른 모듈을 다루거나 테스트만 추가하는 작업만 같은 wave에서 병렬로 실행한다.

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.5"] },
    { "id": 3, "tasks": ["1.4"] },
    { "id": 4, "tasks": ["2.1", "2.3"] },
    { "id": 5, "tasks": ["2.2"] },
    { "id": 6, "tasks": ["2.4"] },
    { "id": 7, "tasks": ["2.5", "2.6", "2.7"] },
    { "id": 8, "tasks": ["2.8"] },
    { "id": 9, "tasks": ["2.9"] },
    { "id": 10, "tasks": ["3"] },
    { "id": 11, "tasks": ["4.1"] },
    { "id": 12, "tasks": ["4.2", "4.6"] },
    { "id": 13, "tasks": ["4.3", "4.4", "4.5", "4.7"] },
    { "id": 14, "tasks": ["4.8"] },
    { "id": 15, "tasks": ["4.9"] },
    { "id": 16, "tasks": ["5"] },
    { "id": 17, "tasks": ["6.1", "6.7", "6.8"] },
    { "id": 18, "tasks": ["6.2", "6.3", "6.9", "6.10", "6.15"] },
    { "id": 19, "tasks": ["6.4", "6.11", "6.12", "6.13", "6.16"] },
    { "id": 20, "tasks": ["6.5"] },
    { "id": 21, "tasks": ["6.6", "6.14"] },
    { "id": 22, "tasks": ["7.1"] },
    { "id": 23, "tasks": ["7.2", "7.3"] },
    { "id": 24, "tasks": ["7.4", "7.5"] },
    { "id": 25, "tasks": ["7.6", "7.7"] },
    { "id": 26, "tasks": ["7.8"] },
    { "id": 27, "tasks": ["8"] },
    { "id": 28, "tasks": ["9.1", "9.5"] },
    { "id": 29, "tasks": ["9.3"] },
    { "id": 30, "tasks": ["9.4"] },
    { "id": 31, "tasks": ["9.2", "9.6"] },
    { "id": 32, "tasks": ["9.7"] },
    { "id": 33, "tasks": ["9.8"] },
    { "id": 34, "tasks": ["10.1"] },
    { "id": 35, "tasks": ["10.2"] },
    { "id": 36, "tasks": ["10.3"] },
    { "id": 37, "tasks": ["10.4"] },
    { "id": 38, "tasks": ["10.5", "10.6", "10.7"] },
    { "id": 39, "tasks": ["10.8"] },
    { "id": 40, "tasks": ["11"] },
    { "id": 41, "tasks": ["12.1", "12.4", "13.1"] },
    { "id": 42, "tasks": ["12.2", "12.3", "12.5", "13.2"] },
    { "id": 43, "tasks": ["12.6", "12.7", "13.3"] },
    { "id": 44, "tasks": ["12.8", "13.4"] },
    { "id": 45, "tasks": ["13.5"] },
    { "id": 46, "tasks": ["13.6", "13.7"] },
    { "id": 47, "tasks": ["14.1"] },
    { "id": 48, "tasks": ["14.2", "15.1"] },
    { "id": 49, "tasks": ["14.3", "15.2", "15.3", "15.4", "15.5"] },
    { "id": 50, "tasks": ["14.4", "15.6"] },
    { "id": 51, "tasks": ["14.5", "16.1"] },
    { "id": 52, "tasks": ["16.2"] },
    { "id": 53, "tasks": ["16.3"] },
    { "id": 54, "tasks": ["16.4"] },
    { "id": 55, "tasks": ["17"] },
    { "id": 56, "tasks": ["18.1"] },
    { "id": 57, "tasks": ["18.2", "19.1"] },
    { "id": 58, "tasks": ["18.3", "19.2"] },
    { "id": 59, "tasks": ["18.4", "19.3"] },
    { "id": 60, "tasks": ["18.5", "19.4"] },
    { "id": 61, "tasks": ["19.5", "19.7"] },
    { "id": 62, "tasks": ["18.6", "19.6", "19.8"] },
    { "id": 63, "tasks": ["19.9", "19.10"] },
    { "id": 64, "tasks": ["20.1"] },
    { "id": 65, "tasks": ["20.2"] },
    { "id": 66, "tasks": ["20.3"] },
    { "id": 67, "tasks": ["20.4"] },
    { "id": 68, "tasks": ["21.1", "22.1"] },
    { "id": 69, "tasks": ["21.2", "22.2"] },
    { "id": 70, "tasks": ["21.3"] },
    { "id": 71, "tasks": ["21.4"] },
    { "id": 72, "tasks": ["23"] },
    { "id": 73, "tasks": ["24.1", "24.2"] },
    { "id": 74, "tasks": ["24.3", "24.4"] },
    { "id": 75, "tasks": ["24.5"] },
    { "id": 76, "tasks": ["24.6"] },
    { "id": 77, "tasks": ["25.1", "25.3"] },
    { "id": 78, "tasks": ["25.2"] },
    { "id": 79, "tasks": ["25.4"] },
    { "id": 80, "tasks": ["26"] }
  ]
}
```
