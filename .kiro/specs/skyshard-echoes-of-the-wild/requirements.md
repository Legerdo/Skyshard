# Requirements Document

## Introduction

`Skyshard: Echoes of the Wild`는 브라우저에서 설치 없이 실행되는 3D stylized anime fantasy 오픈월드 액션 RPG다. 하늘에서 떨어진 별의 파편이 자연을 뒤틀고 고대 문명을 무너뜨린 세계에서, 방랑자 Kairen은 변경 마을 Thistlewick에 도착해 동료 Isla, Wren, Talus와 함께 세 지역(Verdant Reach, Ember Ravine, Azure Highlands)의 주요 도전에 잠든 Ancient Skyshard 3개를 모으고, 봉인된 중앙 부유 성소 Astral Sanctum을 열어 최종 보스 Caelith를 쓰러뜨린다.

핵심 경험: 먼 landmark를 발견하고, 직접 이동하고, 오르고, 활강하고, 네 캐릭터를 교체하며 속성 반응을 연계해 싸우고, 세 Skyshard를 모아 마지막 성소와 보스를 열어 하나의 모험을 완주한다. 첫 플레이 목표 시간은 20~30분이며, 넓이보다 상호작용 밀도가 높은 작은 오픈월드를 지향한다.

기본 진행: Title → Thistlewick → Verdant Reach 탐험 → Hollowroot Shrine → Skyshard 1 → Ember Ravine → Cinderspire → Skyshard 2 → Azure Highlands → Starfall Observatory → Skyshard 3 → Astral Sanctum 활성화 → Caelith → 엔딩 → Victory Screen.

이 문서는 반드시 구현할 핵심 경험과 최소 품질선을 정의한다. 플레이 경험을 개선하는 연출·편의·작은 시스템은 핵심 진행과 모순되지 않고 실제 동작·검증까지 완료되는 범위에서 추가할 수 있다. 문서의 수치(속도, 피해, 시간)는 초기 목표값이며, 같은 의도를 유지하는 범위에서 조정할 수 있고 조정 결과는 설계 문서에 기록한다.

우선순위 표기:
- [P1] 시작~엔딩 핵심 경로, 이동·카메라·충돌·전투 안정성, 저장, 검증
- [P2] 핵심 시스템 완성도(월드 밀도, 성장, UI, 오디오, 아트, 설정)
- [P3] 연출·편의·부가 콘텐츠

범위 축소 규칙: 일정·복잡도 문제가 생기면 콘텐츠 양(지역 면적, 적 변형 수, 부가 퀘스트 수, 장비 종류, 장식 변형, NPC 수, 수집품 수)을 먼저 줄이고 시스템은 유지한다. 연결된 오픈월드, 서로 다른 세 주요 지역, 수직 탐험(등반·활강), 캐릭터 교체, 4명 플레이 캐릭터, 속성 기반 전투와 여러 Reaction, 세 Skyshard, 지역별 주요 도전, 다단계 최종 보스, 저장/Continue, 엔딩은 축소하지 않는다.

## 전제 및 자율 결정 사항

사용자 명세 §55에 따라 자율 결정했으며 Clarify 답변(한국어 텍스트, CC0 에셋 일부 혼용)을 반영했다.

| ID | 결정 | 근거 |
|---|---|---|
| A1 | TypeScript + Vite + Three.js(WebGL2), 예측 가능한 kinematic character controller, backend 없음 | §52, 안정성 |
| A2 | `npm install` → `npm run dev`, `npm run build` / `npm run preview`로 정적 빌드 실행 | 실행 용이성 |
| A3 | 키보드+마우스(pointer lock) 우선, 기본 Gamepad API 지원, 터치/모바일 미지원 | §2-A 편의 |
| A4 | 게임 내 텍스트 한국어, 고유명사 영어 유지, 언어 전환 없음, 시스템 한국어 폰트 스택 | Clarify 답변 1 |
| A5 | CC0 에셋(환경 소품, 효과음, 적합 시 음악) 일부 혼용. 캐릭터·적·보스는 자체 제작. 저장소 내 포함, Credits 파일 기록, 실패 시 절차적 생성/Web Audio 합성 | Clarify 답변 2 |
| A6 | 검증: Vitest(순수 로직), Playwright(입력 이벤트만 쓰는 전체 플레이 + 스크린샷) | §57~§59 |
| A7 | 저장: 버전·스키마 검증·백업 슬롯을 갖춘 localStorage, Milestone 자동 저장과 표시기 | §42 |
| A8 | 지역은 물리적으로 연결되며, Ember Ravine·Azure Highlands 진입로는 Blight_Barrier가 막고 각각 Skyshard 1·2 획득 시 해제. Shardfall Crater는 처음부터 방문 가능 | 메인 진행 순서 보장, 순서 파괴·softlock 방지 |
| A9 | 동료 합류: Kairen(시작) → Isla(Thistlewick) → Wren(Breezewatch) → Talus(Hollowroot Shrine 입구). 첫 Skyshard 전에 4명 합류 | 온보딩 분산(§36), 캐릭터 등장 연출 |
| A10 | 실시간 낮/밤 대신 메인 진행 연동 시간대(아침→한낮→오후→황혼→별빛 밤→일출) | 핵심 순간 연출 제어, 전투 가독성 |
| A11 | 미니맵 대신 상단 Compass | §38, landmark 중심 탐험 |
| A12 | 보스 재도전 시 도달한 Phase부터 재개 | 좌절 완화 |
| A13 | 속성명은 영어(Ember/Tide/Gale/Terra), Reaction·아이템·능력 이름은 한국어 표시 | 가독성, 고유명사 규칙 |
| A14 | 파티 공용 레벨(1~10) | 단순하고 체감되는 성장(§30) |
| A15 | 얕은 물 보행 + 단순 수면 수영 | §8 |
| A16 | 음성 대사 없음, 화자별 짧은 발화음으로 대체 | §4 축소 허용 항목 |
| A17 | WebGL `powerPreference: 'high-performance'`, 기본 품질은 일반 데스크톱 기준 "보통" | 하이브리드 GPU 환경 |
| A18 | 구현 순서: 최소 전체 경로(Title→Village→Open World→Combat→Skyshard×3→Boss→Victory)를 먼저 동작시킨 뒤 시스템·비주얼 확장 | §54 |
| A19 | 캐릭터·적·Elite·Caelith·NPC의 시각 모델은 Visual_Manifest 기반 교체 구조 뒤에 두고 기본값은 자체 절차적 모델로 한다. 나중에 manifest만 바꿔 FBX·VRM·glTF 모델로 교체할 수 있다 | 스펙 검토 후 사용자 추가 요청 |

채택한 주요 자율 확장(§2-A): 지역 첫 진입 연출, Vista 카메라 연출과 지도 공개, 숨겨진 장소 발견 효과, Waystone 빠른 이동, 동굴 조명 전환, 높이에 따른 바람 음향, 진행 연동 시간대와 Blight 정화, 지역별 ambient VFX·환경 생물·풀 반응·물 파문, 완벽 회피, 반응 연쇄 표시, 반응 가능 파티원 표시, 속성 반응 도감, hit-stop·camera impulse, 보스 Phase 전환 연출, 동료 합류 연출, 마을 단계적 변화, Astral Sanctum 단계적 점등, 엔딩 세계 정상화, 활강 링·시간 제한 도전, Echo Tablet 수집 세트, 캠프 소탕 보상, 숨겨진 Elite, 끼임 해제·Safe_Position 복구, 탭 비활성 시 자동 일시정지, 아이템 자동 흡수, 키 재지정·UI 배율·화면 흔들림 설정, 화자별 발화음.

## 범위 외

- 멀티플레이, 서버/backend, 온라인 계정, gacha, 과금, 일일 퀘스트, live-service 요소
- 대규모 제작(crafting) 시스템, 다수의 자원 종류
- 모바일·터치 조작, 언어 전환, 음성 대사
- 실시간 낮/밤 주기(A10으로 대체), 무작위 절차 생성 월드

## Glossary

시스템
- **Game**: 브라우저에서 실행되는 `Skyshard: Echoes of the Wild` 애플리케이션 전체.
- **World**: 지형, Region, 오브젝트, 시간대, 날씨, Blight 상태를 포함하는 하나의 연결된 3D 오픈월드와 그 상태 관리.
- **Player_Controller**: Active_Character의 걷기·달리기·질주·점프·낙하·Dodge 이동·등반·활강·수영을 처리하는 시스템.
- **Collision_System**: 캐릭터·적·투사체·카메라와 월드 사이의 충돌 판정, Safe_Position 갱신, 끼임·추락 복구를 처리하는 시스템.
- **Camera_System**: 3인칭 추적 카메라, 카메라 충돌, Lock-on을 처리하는 시스템.
- **Cinematic_System**: 짧은 in-engine 카메라 연출을 재생하는 시스템.
- **Party_System**: 파티 구성, 캐릭터 교체, 캐릭터별 HP·Downed 상태를 관리하는 시스템.
- **Combat_System**: 공격, 피해 계산, Dodge 판정, Skill·Burst, Energy, Cooldown, 피격 반응을 처리하는 시스템.
- **Element_System**: Element_Mark 부여, Reaction 판정·효과, Element_Shield를 처리하는 시스템.
- **Enemy_AI**: 일반 적과 Elite의 감지, 이동, 공격, 복귀를 결정하는 시스템.
- **Boss_Encounter**: 최종 보스 Caelith 전투의 Phase, 패턴, arena hazard, 재도전을 관리하는 시스템.
- **Quest_System**: Main_Quest·Side_Quest 단계, Objective, 진행 플래그를 관리하는 시스템.
- **Dialogue_System**: NPC 대화 창과 진행 상태에 따른 대사 선택을 처리하는 시스템.
- **Progression_System**: 파티 레벨, 경험치, 능력 강화, 최대 Stamina 증가를 관리하는 시스템.
- **Inventory_System**: Glim, 소비 아이템, Starmote, 장비의 보유·장착·사용을 관리하는 시스템.
- **Loot_System**: 적 처치, Chest, 퀘스트, 발견 보상을 생성하고 지급하는 시스템.
- **Map_System**: 월드 지도와 Compass를 관리하는 시스템.
- **HUD**: 게임플레이 중 화면에 겹쳐 표시되는 정보 계층.
- **UI_System**: Title, Pause, Settings, Map, Inventory/Equipment, Quest, Dialogue, Shop, Defeat, Victory, Credits 화면을 관리하는 시스템.
- **Tutorial_System**: 상황 기반 Tutorial_Hint를 관리하는 시스템.
- **Save_System**: localStorage 기반 저장, 불러오기, 스키마 검증, 백업을 처리하는 시스템.
- **Settings_System**: 오디오·그래픽·조작·접근성 설정의 적용과 보존을 처리하는 시스템.
- **Audio_System**: 음악, 환경음, 효과음의 재생과 전환을 처리하는 시스템.
- **Render_System**: 렌더링, toon 셰이딩, 후처리, VFX, 품질 단계, 거리 기반 최적화를 처리하는 시스템.
- **Animation_System**: Player_Character·적·Caelith·NPC의 애니메이션 상태와 전환을 처리하는 시스템.
- **Puzzle_Mechanism**: Element 또는 이동 능력으로 작동하는 환경 장치.
- **Debug_Tools**: 검증 전용 디버그 기능 모음.
- **Asset_Pipeline**: 외부 CC0 에셋의 반입, 재질 통일, 출처 기록을 담당하는 처리 과정.
- **Visual_Provider**: 엔티티의 시각 모델(메시, 골격, 재질, 애니메이션 연결)을 만드는 교체 가능한 구현. 기본은 자체 절차적 모델이고, 외부 모델은 glTF/GLB, FBX, VRM 파일을 사용한다.
- **Visual_Manifest**: 엔티티 ID마다 Visual_Provider 종류, 파일 경로, 골격 대응, 크기, socket, 재질 옵션을 지정하는 데이터.
- **Humanoid_Skeleton**: VRM humanoid bone 이름을 기준으로 한 공통 인간형 골격. 포즈 클립은 이 골격 기준으로 정의하고 외부 humanoid 모델에 retarget한다.
- **Test_Harness**: 자동 테스트가 Game 상태를 읽기 위해 사용하는 읽기 전용 인터페이스.
- **Verification_Suite**: Vitest 단위 테스트와 Playwright 브라우저 테스트로 구성된 자동 검증 모음.
- **Final_Report**: 구현 완료 후 사용자에게 제출하는 최종 응답.

게임 용어
- **Player_Character**: 플레이 가능한 캐릭터 4명(Kairen, Isla, Wren, Talus). **Active_Character**: 현재 조작 중인 Player_Character. **Party**: 합류한 Player_Character 목록.
- **Downed**: HP가 0이 되어 행동과 교체 선택이 불가능한 상태. **Party_Wipe**: 합류한 모든 Player_Character가 Downed인 상태.
- **In_Combat**: 1체 이상의 적 또는 Caelith가 플레이어를 대상으로 alert·chase·attack 상태인 상태.
- **Stamina**: Party가 공유하는 이동 자원(기본 최대치 100). **Exhausted**: Stamina가 0이 된 뒤 최대치의 30%까지 회복되기 전 상태.
- **Element**: 게임 고유 4속성 Ember(불꽃), Tide(물결), Gale(바람), Terra(대지).
- **Element_Mark**: Element 공격에 맞은 대상에게 8초 동안 남는 속성 표식.
- **Reaction**: Element_Mark를 지닌 대상에게 다른 Element가 적용될 때 발생하는 속성 반응. **Reaction_Chain**: Reaction이 퍼뜨린 표식이 다른 대상에서 추가 Reaction을 일으키는 연쇄.
- **Element_Shield**: 일부 적과 Caelith가 두르는 속성 방어막. 해당 Element_Mark를 항상 지닌 것으로 취급한다.
- **Normal_Attack**: 캐릭터별 기본 연속 공격. **Charged_Attack**: 공격 입력을 0.4초 이상 유지 후 놓아 발동하는 강공격.
- **Skill**: 캐릭터별 일반 능력(Cooldown 사용). **Burst**: 캐릭터별 특수 능력(Energy 사용). **Energy**: 캐릭터별 Burst 자원. **Cooldown**: Skill 재사용 대기 시간.
- **Dodge**: 짧은 무적 시간을 가진 회피 이동. **Perfect_Dodge**: Dodge 무적 시간 중 적 공격 판정이 Active_Character와 겹친 회피.
- **Stagger**: 행동이 중단되는 경직 상태. **Telegraph**: 공격 전 범위와 시점을 알리는 시각·청각 신호. **Hit_Stop**: 강한 타격 순간 게임 시간을 수십 ms 정지하는 연출.
- **Region**: 주요 지역 Verdant Reach, Ember Ravine, Azure Highlands와 중앙 Shardfall Crater, 최종 지역 Astral Sanctum.
- **Thistlewick**: Verdant Reach의 시작 마을. **Breezewatch**: Verdant Reach 절벽 위 풍차 전망대. **Elderbough**: Verdant Reach의 거대 고목.
- **Challenge_Area**: Skyshard가 놓인 지역 도전 장소. Hollowroot Shrine(Verdant Reach), Cinderspire(Ember Ravine), Starfall Observatory(Azure Highlands).
- **Skyshard**: 각 Challenge_Area에서 1개씩 얻는 Ancient Skyshard(총 3개).
- **Astral Sanctum**: Shardfall Crater 상공의 봉인된 부유 성소이자 최종 지역. **Resonance_Altar**: Shardfall Crater 중앙 제단. **Starlit_Stair**: 활성화 후 생성되는 부유 발판 진입로.
- **Blight**: Skyshard가 자연을 뒤틀어 만든 보라색 결정·가시 오염. **Blight_Barrier**: 다음 주요 Region 진입로를 막는 Blight 장벽.
- **Caelith**: 최종 보스. **Starshell**: Caelith의 Element_Shield. **Shard_Crystal**: Caelith가 소환하는 속성 결정 hazard.
- **Landmark**: 먼 거리에서 실루엣으로 식별되는 대형 구조물. **POI**: 상호작용 또는 보상이 있는 지점. **Vista_Point**: 도달 시 주변 지도가 공개되는 높은 전망 지점.
- **Waystone**: 빠른 이동 목적지이자 회복·부활 지점인 고대 비석. **Enemy_Camp**: 여러 적과 잠긴 보상 Chest가 있는 거점. **Elite**: 강화된 이름 있는 적.
- **Chest**: 보물 상자(일반, 정교한, 빛나는 3등급). **Echo_Tablet**: 짧은 고대 기록이 새겨진 수집품(주요 Region당 3개).
- **Glim**: 화폐. **Starmote**: 능력 강화 재료. **Weapon**, **Charm**, **Relic**: 장비 종류.
- **Main_Quest**, **Side_Quest**: 메인·부가 퀘스트. **Objective**: 퀘스트 단계의 개별 목표. **Milestone**: 자동 저장을 발생시키는 진행 사건.
- **Safe_Position**: 복구에 사용하는 최근의 안전한 지상 위치.
- **Updraft**: 활강 중 캐릭터를 상승시키는 기류. **Wind_Zone**: 활강 중 캐릭터를 수평으로 미는 강풍 구역.
- **Heat_Crystal**: 접촉 시 피해를 주고 Tide로 식힐 수 있는 과열 수정 표면. **Unstable_Crystal**: Ember를 받으면 폭발하는 불안정 수정.
- **Tutorial_Hint**: 상황 발생 시 1회 표시되는 짧은 조작 안내.
- **Normal_Play**: Debug_Tools를 한 번도 사용하지 않은 플레이 세션.
- **Default_Quality**: 최초 실행 시 적용되는 그래픽 품질 단계 "보통".
- **Dev_Machine**: 검증에 사용하는 현재 개발 장비(Windows, RTX 5080 하이브리드 GPU).
- **Hearth**: Thistlewick의 회복용 모닥불. **Echo Altar**: Old Bram이 관리하는 능력 강화 제단. **Sky Ring Trial**: 제한 시간 안에 활강으로 링을 통과하는 도전.
- **허브 경단**: HP 회복 소비 아이템. **불씨 깃털**: Downed 캐릭터 부활 소비 아이템.
- **진행 연동 시간대**: 실시간 낮/밤 대신 Main_Quest 진행에 따라 바뀌는 시간대(아침 → 한낮 → 오후 → 황혼 → 별빛 밤 → 일출).
- **이름 있는 NPC**: Elder Maren(촌장), Pip(상인), Old Bram(Echo Altar 관리인), Tamsin(아이), Hobb(농부), Durga(광부, Ember Ravine), Oriel(천문학자, Azure Highlands).

## 기준표

요구사항에서 참조하는 초기 콘텐츠 기준이다. 수치는 같은 의도를 유지하는 범위에서 조정할 수 있다.

### 표 A. Player_Character

| 캐릭터 | Element | 역할 | 무기·실루엣 | Normal_Attack / Charged_Attack | Skill (Cooldown) | Burst (Energy) | 패시브 |
|---|---|---|---|---|---|---|---|
| Kairen | Ember | 근거리 공격형 | 한손 곡검, 긴 붉은 스카프, 짧은 코트, 중간 체구 | 4연속 베기 / 회전 상승 베기 | 화염 돌진: 전방 6m 돌진 베기, 경로의 적에게 Ember (8초) | 태양 낙하: 전방 반경 5m 화염 강타 (60) | 질주 Stamina 소모 20% 감소 |
| Isla | Tide | 원거리 공격형 | 장궁, 짧은 후드 망토, 긴 포니테일, 장신 | 3연사 화살(사거리 25m) / 조준 관통 화살 | 물결 화살비: 지정 지점 반경 4m에 2초간 Tide 화살비 (9초) | 해일 포화: 전방 부채꼴 10m 파도, 넉백 (60) | 수영 Stamina 소모 40% 감소 |
| Wren | Gale | 범위 제어형 | 긴 글레이브, 깃털 망토, 고글, 작은 체구 | 넓은 호 3연속 휘두르기 / 돌풍 찌르기(띄우기) | 소용돌이: 반경 5m 적을 1.5초 끌어당김, 활강 중 사용 시 캐릭터 6m 상승 (10초) | 폭풍의 눈: 5초간 반경 7m 회오리, 적 구속과 지속 Gale (70) | 활강 Stamina 소모 30% 감소 |
| Talus | Terra | 방어/지원형 | 대형 방패, 석재 건틀릿, 넓은 어깨 갑주, 큰 체구 | 방패 강타 2회 + 내려찍기 / 전방 대지 충격파 | 암석 방벽: 전방 돌기둥 생성(8초 유지, 발판·압력판 사용 가능)과 Party 보호막(최대 HP 20%) (12초) | 대지의 요새: 반경 6m 돌기둥 고리, 적 1.5초 기절, Party HP 25% 회복 (70) | 등반 Stamina 소모 25% 감소 |

### 표 B. Reaction

학습 규칙: "Ember와 Tide는 폭발한다 / Terra는 땅을 바꾼다 / Gale은 다른 속성을 퍼뜨린다."

| 조합 | Reaction | 효과 |
|---|---|---|
| Ember + Tide | 증기 폭발 | 대상 반경 3m 폭발, 트리거 피해의 150% 추가 피해, 1초 Stagger |
| Ember + Terra | 용암 균열 | 대상 발밑 반경 3m 용암 지대 4초, 지대 안 적에게 초당 피해 |
| Tide + Terra | 진흙 속박 | 반경 4m 적 2.5초 이동 불가 |
| Gale + Ember | 불꽃 확산 | 대상의 Ember 표식을 반경 5m 적에게 전파, 화염 피해 |
| Gale + Tide | 물안개 확산 | 대상의 Tide 표식을 반경 5m 적에게 전파, 3초간 이동 둔화 40% |
| Gale + Terra | 모래 돌풍 | 대상의 Terra 표식을 반경 5m 적에게 전파, 파편 피해 |

Terra가 관여한 Reaction은 추가로 Active_Character에게 5초간 최대 HP 8%의 보호막을 부여한다.

### 표 C. 적

| 적 | Region | Archetype | 구별 특징 |
|---|---|---|---|
| Bramblekin | Verdant Reach | 근거리 추격형 | 작은 가시 정령, 빠른 2연속 할퀴기, 낮은 HP |
| Thornspitter | Verdant Reach, Ember Ravine | 원거리형 | 뿌리 내린 식물, 곡사 가시탄, 근접 시 땅속 이동으로 거리 유지 |
| Mossback Brute | Verdant Reach | 방어형 | 이끼 등껍질 거한, 정면 피해 70% 감소, Ember 또는 Charged_Attack으로 방어 파괴 |
| Cinder Hound | Ember Ravine | 빠른 돌진형 | 붉은 선 Telegraph 후 직선 돌진, 명중 시 화상 지속 피해 |
| Slagshell | Ember Ravine | 방어형·속성 | Ember Element_Shield를 두른 용암 갑각 |
| Ash Wisp | Ember Ravine | 원거리·속성 | 공중 부유, 화염구와 4초간 불타는 바닥 생성 |
| Windcutter | Azure Highlands | 빠른 돌진형·속성 | 바람 칼날 돌진, Gale 넉백 |
| Aether Sentinel | Azure Highlands | 원거리·방어형 | 고대 기계, 조준 빔과 범위 강타, 10초마다 바뀌는 Element_Shield |

Elite: Old Mossback(Verdant Reach 숨겨진 Elite), Emberjaw(Ember Ravine 숨겨진 Elite), Galeclaw(Azure Highlands 숨겨진 Elite), Rootbound Warden(Hollowroot Shrine 수호자), Cinder Alpha(Cinderspire 정상), Sentinel Prime(Starfall Observatory 수호자).

### 표 D. Main_Quest

| 단계 | 이름 | 핵심 내용 |
|---|---|---|
| 1 | 방랑자의 도착 | Thistlewick 도착, Elder Maren과 세계·목표 소개, 마을 방어전, Isla 합류 |
| 2 | 첫 번째 공명 | Verdant Reach에서 Skyshard 공명 조사, Breezewatch 등반과 활강, Wren 합류 |
| 3 | 뿌리 아래의 성소 | Hollowroot Shrine 입구에서 Talus 합류, 퍼즐과 전투, Rootbound Warden, Skyshard 1 |
| 4 | 붉은 협곡 | Ember Ravine 탐험, 무너진 다리, 광부 Durga, Cinderspire 경로 확보 |
| 5 | 불꽃 첨탑 | Cinderspire 수직 도전, Cinder Alpha, Skyshard 2 |
| 6 | 하늘 고원 | Azure Highlands 탐험, Wind_Zone 활강, 천문학자 Oriel, 관측소 경로 확보 |
| 7 | 별이 떨어진 관측소 | Starfall Observatory 속성 조합 퍼즐과 강화 전투, Sentinel Prime, Skyshard 3 |
| 8 | 성소의 각성 | Resonance_Altar 활성화, Starlit_Stair 등반 |
| 9 | 추락한 별 | Astral Sanctum 진입, Caelith 3 Phase 전투 |
| 10 | 새벽 | 엔딩 연출, Victory Screen, 탐험 계속 |

## Requirements

### Requirement 1: 브라우저 실행과 기술 기반 [P1]

**User Story:** 플레이어로서, 설치 없이 브라우저에서 게임을 실행하고 싶다. 그래서 바로 모험을 시작할 수 있다.

#### Acceptance Criteria

1. THE Game SHALL TypeScript로 작성되고 `npm install` 후 `npm run dev` 명령으로 로컬 개발 서버에서 실행된다.
2. WHEN `npm run build`를 실행하면, THE Game SHALL 서버 로직 없이 동작하는 정적 파일 묶음을 `dist/` 폴더에 생성한다.
3. WHEN 정적 빌드를 `npm run preview`로 제공하면, THE Game SHALL Title Screen부터 Victory Screen까지 개발 서버 실행과 동일하게 동작한다.
4. THE Game SHALL 모든 코드, 에셋, 폰트 참조를 동일 출처(same-origin) 파일 또는 사용자 시스템 폰트에서 불러온다.
5. THE Game SHALL WebGL2를 지원하는 최신 데스크톱 Chrome과 Edge에서 동작한다.
6. WHEN WebGL 컨텍스트를 생성하면, THE Render_System SHALL `powerPreference: 'high-performance'`를 요청한다.
7. IF 브라우저가 WebGL2를 지원하지 않으면, THEN THE Game SHALL 지원 브라우저와 해결 방법을 한국어 안내 화면으로 표시한다.
8. IF WebGL 컨텍스트가 손실되면, THEN THE Game SHALL 게임을 일시정지하고 복구를 시도하며, 복구 실패 시 마지막 저장 상태에서 다시 시작하는 버튼을 표시한다.
9. THE Game SHALL 게임 로직을 렌더링 프레임률과 독립된 고정 간격으로 갱신하여, 렌더링 프레임률이 30~144fps 범위에서 변할 때 동일 입력에 대한 이동 거리와 점프 높이 차이를 5% 이내로 유지한다.
10. WHEN Dev_Machine에서 게임 페이지를 열면, THE Game SHALL 로딩 진행률을 표시하고 10초 이내에 Title Screen을 표시한다.
11. THE Game SHALL 서버, 온라인 계정, 멀티플레이, 결제 요소가 없는 단일 플레이어 오프라인 게임으로 동작한다.

### Requirement 2: 시작부터 엔딩까지의 완주 경로 [P1]

**User Story:** 플레이어로서, 처음부터 엔딩까지 하나의 완성된 모험을 끊김 없이 플레이하고 싶다. 그래서 세 Skyshard를 모아 최종 보스를 쓰러뜨리는 이야기를 완주할 수 있다.

#### Acceptance Criteria

1. THE Game SHALL Normal_Play로 Title Screen → New Game → Thistlewick → Verdant Reach → Hollowroot Shrine → Skyshard 1 → Ember Ravine → Cinderspire → Skyshard 2 → Azure Highlands → Starfall Observatory → Skyshard 3 → Resonance_Altar → Astral Sanctum → Caelith 처치 → 엔딩 연출 → Victory Screen 순서로 완주할 수 있는 경로를 제공한다.
2. THE Game SHALL 메인 진행만 수행하는 첫 플레이의 예상 완주 시간을 20~30분으로 구성한다.
3. THE World SHALL 메인 진행에 필요한 모든 이동 구간을 기본 최대 Stamina로, 레벨·장비 요구 조건 없이 통과할 수 있게 구성한다.
4. THE Game SHALL Side_Quest와 선택 POI를 수행하지 않은 플레이어가 메인 진행 중 얻는 레벨과 장비로 Caelith를 처치할 수 있도록 적과 보스 수치를 구성한다.
5. IF 메인 진행에 필요한 오브젝트(Puzzle_Mechanism, 이동 발판, 퀘스트 NPC, 퀘스트 아이템)가 월드 경계 밖으로 이동하거나 비정상 상태가 되면, THEN THE World SHALL 5초 이내에 해당 오브젝트를 원래 위치와 상태로 복원한다.
6. THE Quest_System SHALL 메인 진행에 필요한 모든 상호작용을 성공할 때까지 반복 시도 가능하게 유지한다.
7. WHEN 메인 진행의 어느 단계에서든 저장 후 불러오기를 수행하면, THE Game SHALL 다음 Objective를 달성할 수 있는 상태로 월드와 퀘스트를 복원한다.
8. THE Game SHALL 캐릭터, 적, 보스, Region, 퀘스트, UI 화면을 TODO 문구, 빈 화면, 가공하지 않은 기본 도형이 없는 완성된 콘텐츠로 제공한다.
9. THE Game SHALL 개발 순서상 최소 전체 경로(Title → Village → Open World → Combat → Skyshard 3개 → Final Boss → Victory)를 먼저 동작시킨 뒤 시스템과 비주얼을 확장한다.

### Requirement 3: Main_Quest [P1]

**User Story:** 플레이어로서, 탐험·전투·환경 상호작용이 섞인 명확한 메인 목표를 따라가고 싶다. 그래서 마커만 따라가는 느낌 없이 세 Region을 진행할 수 있다.

#### Acceptance Criteria

1. THE Quest_System SHALL Main_Quest를 표 D의 10단계로 구성하고 정해진 순서로만 진행한다.
2. WHEN 진행 이벤트가 발생하면, THE Quest_System SHALL 현재 단계에 정의된 전이만 적용하고, 정의되지 않은 전이 요청은 상태 변경 없이 기록만 남긴다.
3. THE Quest_System SHALL 각 Main_Quest 단계를 2개 이상의 Objective로 나누고, 단계마다 탐험, 전투, 환경 상호작용 중 2가지 이상을 포함한다.
4. WHEN Objective가 완료되면, THE Quest_System SHALL 1초 이내에 다음 Objective를 활성화하고 HUD의 Objective 문구를 갱신한다.
5. WHEN Main_Quest 단계가 완료되면, THE HUD SHALL 단계 완료 알림(단계 이름과 보상)을 3초 동안 표시하고, THE Save_System SHALL Milestone 자동 저장을 수행한다.
6. WHILE Main_Quest 탐험 단계(2, 4, 6)의 탐색 Objective가 활성인 동안, THE Map_System SHALL 정확한 지점 대신 반경 60m 이상의 탐색 구역을 표시하고, THE World SHALL 탐색 구역 안에 목적지로 이어지는 환경 단서(빛기둥, 흔적, NPC 흔적, 공명음)를 배치한다.
7. THE Quest_System SHALL 각 Objective 문구에 방향 단서가 되는 Landmark 또는 환경 요소 이름을 포함한다.
8. WHEN Main_Quest 단계가 시작되면, THE Dialogue_System SHALL 관련 NPC 또는 동료의 짧은 대화로 목표와 이유를 전달한다.
9. THE Quest_System SHALL Main_Quest 진행 조건을 Side_Quest 완료 여부와 독립적으로 판정한다.

### Requirement 4: Skyshard 획득과 진행 게이트 [P1]

**User Story:** 플레이어로서, Skyshard를 얻는 순간을 일반 아이템과 다른 큰 사건으로 느끼고 싶다. 그래서 모험이 한 단계 진전했음을 체감할 수 있다.

#### Acceptance Criteria

1. THE World SHALL Hollowroot Shrine, Cinderspire, Starfall Observatory의 최종 지점에 Skyshard를 1개씩 배치한다.
2. WHEN 플레이어가 Skyshard와 상호작용하면, THE Cinematic_System SHALL 6초 이하의 획득 연출(카메라 근접 framing, 강한 빛 VFX, 전용 획득 효과음)을 재생한다.
3. WHEN Skyshard 획득 연출이 끝나면, THE HUD SHALL Skyshard 진행 표시(n/3)를 갱신하고 5초 동안 강조한다.
4. WHEN Skyshard를 획득하면, THE World SHALL Astral Sanctum 주위 봉인 고리 3개 중 1개를 점등하여 월드 어디서나 보이는 변화를 적용한다.
5. WHEN Skyshard 1을 획득하면, THE World SHALL Ember Ravine 진입로의 Blight_Barrier가 부서지는 연출과 함께 통로를 개방한다.
6. WHEN Skyshard 2를 획득하면, THE World SHALL Azure Highlands 진입로의 Blight_Barrier가 부서지는 연출과 함께 통로를 개방한다.
7. WHEN Skyshard를 획득하면, THE World SHALL 해당 Region의 Blight 오염 표현을 줄이고 진행 연동 시간대를 다음 단계로 전환한다.
8. WHEN Skyshard 획득 연출이 끝나면, THE Save_System SHALL 2초 이내에 Milestone 자동 저장을 수행한다.
9. WHILE 획득한 Skyshard 수가 다음 Region 개방 조건보다 적은 동안, THE World SHALL Blight_Barrier 앞에서 필요한 Skyshard 수를 알려주는 상호작용 문구를 표시한다.

### Requirement 5: Astral Sanctum 해금과 최종 지역 [P1]

**User Story:** 플레이어로서, 처음부터 보이던 부유 성소가 세 Skyshard로 열리는 순간을 보고 싶다. 그래서 여정의 목표가 이루어졌음을 느낄 수 있다.

#### Acceptance Criteria

1. THE World SHALL Astral Sanctum을 Shardfall Crater 상공에 배치하고, New Game 직후 Thistlewick에서 실루엣이 보이게 한다.
2. WHILE 획득한 Skyshard가 3개 미만인 동안, THE World SHALL Resonance_Altar에 "Skyshard n/3" 상태를 표시하고 Starlit_Stair를 비활성 상태로 유지한다.
3. WHEN Skyshard 3을 획득하면, THE World SHALL Resonance_Altar 위치에 월드 어디서나 보이는 빛기둥을 표시한다.
4. WHEN 플레이어가 Skyshard 3개를 지닌 상태에서 Resonance_Altar와 상호작용하면, THE Cinematic_System SHALL 12초 이하의 활성화 연출(세 대표 Landmark에서 모이는 빛줄기, 봉인 고리 회전, 부유 구조물 상승, 하늘색 변화, 음악 전환)을 재생한다.
5. WHEN 활성화 연출이 끝나면, THE World SHALL Shardfall Crater에서 Astral Sanctum까지 걷기·점프·활강으로 이동하는 Starlit_Stair를 생성하고, THE Save_System SHALL Milestone 자동 저장을 수행한다.
6. IF 플레이어가 Starlit_Stair에서 추락하면, THEN THE Collision_System SHALL 플레이어를 가장 최근에 밟은 Starlit_Stair 발판으로 복귀시킨다.
7. THE World SHALL Astral Sanctum 내부의 보스 arena 직전에 전투가 없는 연결 공간(Waystone 1개, 짧은 벽화 기록)을 배치한다.

### Requirement 6: 최종 보스 Caelith [P1]

**User Story:** 플레이어로서, 패턴과 공간이 바뀌는 다단계 보스전을 치르고 싶다. 그래서 지금까지 익힌 이동, 교체, 속성 반응을 모두 활용해 승리할 수 있다.

#### Acceptance Criteria

1. THE Boss_Encounter SHALL Caelith 전투를 Phase 1(HP 100~65%), Phase 2(HP 65~30%), Final Phase(HP 30~0%)의 3단계로 구성한다.
2. WHILE Phase 1인 동안, THE Boss_Encounter SHALL 근거리 연속 베기, 3방향 별 파편 projectile, 원형 ground Telegraph가 있는 내려찍기를 사용하고, 내려찍기 연속기 후 Caelith를 3초 동안 Stagger(vulnerable window) 상태로 만든다.
3. WHILE Phase 2인 동안, THE Boss_Encounter SHALL 직선 Telegraph 후 돌진, 순차적으로 Telegraph되는 arena 바닥 구역 폭발, Shard_Crystal 4개 소환을 추가하고 Caelith에게 Starshell을 부여한다.
4. WHILE Starshell이 활성인 동안, THE Element_System SHALL Starshell의 현재 Element를 색상과 아이콘으로 표시하고 12초마다 다른 Element로 바꾸며, 같은 Element 공격 피해를 25%, Reaction 피해를 300%로 Starshell에 적용한다.
5. WHEN Starshell 내구도가 0이 되면, THE Boss_Encounter SHALL Caelith를 6초 동안 무력화하고 무력화 중 받는 피해를 150%로 적용한 뒤 Starshell을 재생성한다.
6. WHEN Shard_Crystal이 파괴되면, THE Element_System SHALL 해당 Shard_Crystal의 Element_Mark를 반경 6m 안의 Caelith에게 부여한다.
7. WHILE Final Phase인 동안, THE Boss_Encounter SHALL 공격 간격을 Phase 1 대비 30% 줄이고, 원형 Telegraph가 있는 Starfall 운석 강하와 점프 또는 Dodge로 피하는 360° 충격파 Astral Sweep을 추가하며, arena 하늘과 조명을 별빛 밤으로 전환한다.
8. WHEN Astral Sweep이 끝나면, THE Boss_Encounter SHALL Caelith를 2.5초 동안 vulnerable window 상태로 만든다.
9. THE Boss_Encounter SHALL 모든 강공격에 0.8초 이상, 일반 공격에 0.4초 이상의 Telegraph를 적용한다.
10. WHEN Phase가 전환되면, THE Cinematic_System SHALL 3초 이하의 전환 연출(camera impulse, 음악 단계 전환)을 재생하고, 연출 중 Caelith와 Party 모두에게 피해를 적용하지 않는다.
11. WHEN 플레이어가 arena에 처음 진입하면, THE Cinematic_System SHALL 5초 이하의 Caelith 등장 연출을 재생하고, THE HUD SHALL 보스 이름과 HP 바를 표시한다.
12. THE Boss_Encounter SHALL 메인 진행만으로 도달하는 파티 레벨에서 전투 시간이 3~6분, Phase당 60~150초가 되도록 수치를 구성한다.
13. WHEN Caelith 전투 중 Party_Wipe가 발생하면, THE UI_System SHALL Defeat Screen에 "현재 Phase부터 재도전"과 "Waystone으로 돌아가기"를 제공하고, 재도전 시 Party HP를 최대치로 회복한다.
14. WHEN Caelith의 HP가 0이 되면, THE Boss_Encounter SHALL 모든 hazard와 projectile을 제거하고 보스 사망 연출을 시작한다.

### Requirement 7: 승리와 엔딩 [P1]

**User Story:** 플레이어로서, 보스를 쓰러뜨린 뒤 세계가 되살아나는 엔딩과 내 모험의 기록을 보고 싶다. 그래서 하나의 이야기를 완주했다는 만족을 얻을 수 있다.

#### Acceptance Criteria

1. WHEN Caelith가 처치되면, THE Cinematic_System SHALL 보스 사망 애니메이션, Skyshard 빛의 방출, 세계 정상화(Blight 소멸, 일출 조명) 장면을 포함한 20~45초 엔딩 연출을 재생한다.
2. WHILE 엔딩 연출이 재생되는 동안, THE UI_System SHALL 재생 시작 1초 후부터 Esc 1초 길게 누르기로 건너뛰기를 허용한다.
3. WHEN 엔딩 연출이 끝나면, THE UI_System SHALL Victory Screen에 플레이 시간, 처치한 적 수, 발견한 장소 수/전체, 완료한 퀘스트 수, 발견한 Chest 수/전체, 최종 파티 레벨, 캐릭터별 능력 강화 단계를 표시한다.
4. THE UI_System SHALL Victory Screen에 "탐험 계속"과 "메인 메뉴" 선택지를 제공한다.
5. WHEN 플레이어가 "탐험 계속"을 선택하면, THE World SHALL 플레이어를 Thistlewick에 배치하고 Blight가 사라진 엔딩 후 월드 상태와 엔딩 후 NPC 대사를 적용한다.
6. WHEN Caelith가 처치되면, THE Save_System SHALL 게임 완료 상태와 Victory Screen 통계를 저장하여 Continue 시 엔딩 후 상태로 복원한다.
7. WHERE 세션에서 Debug_Tools가 사용된 경우, THE UI_System SHALL Victory Screen에 "디버그 사용됨" 표시를 함께 표시한다.
8. THE Game SHALL 플레이 시간을 게임플레이와 연출 상태에서만 누적하고 Pause, 메뉴, Title Screen 체류 시간을 제외한다.

### Requirement 8: 연결된 오픈월드와 세 Region [P1]

**User Story:** 플레이어로서, 로딩 없이 이어진 세계에서 서로 다른 분위기의 세 지역을 걸어서 넘나들고 싶다. 그래서 지역마다 새로운 경험을 발견할 수 있다.

#### Acceptance Criteria

1. THE World SHALL Verdant Reach, Ember Ravine, Azure Highlands, Shardfall Crater를 로딩 화면 없이 걸어서 이동하는 하나의 연결된 3D 지형으로 구성한다.
2. THE World SHALL 각 주요 Region을 지형 형태, 색 팔레트, 식생, 건축 양식, 적 구성, 이동 특성, 환경 위험, 음악, Landmark 중 6개 이상의 요소에서 다른 주요 Region과 구별되게 구성한다.
3. THE World SHALL Verdant Reach를 완만한 언덕, 초원, 숲, 큰 나무, 바위 절벽, 작은 폐허, 폭포, Thistlewick, Breezewatch, Elderbough로 구성한다.
4. THE World SHALL Ember Ravine을 좁은 바위 협곡, 붉은 수정 지대, 절벽, 동굴, 무너진 다리, 열기 분출구 Updraft, Heat_Crystal, Unstable_Crystal, Cinderspire로 구성한다.
5. THE World SHALL Azure Highlands를 높은 산, 절벽, 호수, 부유 유적 섬, 부유 발판, Wind_Zone, 거대 자연 아치, Starfall Observatory로 구성한다.
6. THE World SHALL 월드 가장자리를 높은 산맥, 절벽, 구름 바다 같은 지형 요소로 시각적으로 경계 짓는다.
7. WHEN 플레이어가 Region에 처음 진입하면, THE HUD SHALL 조작권을 유지한 채 Region 이름과 한 줄 부제를 3초 동안 표시하고, THE Map_System SHALL 해당 Region을 지도에 등록한다.
8. THE World SHALL Thistlewick에서 가장 먼 Challenge_Area 입구까지 지상 경로 달리기 이동 시간을 3분 이하로 구성한다.
9. THE World SHALL Region별 적 레벨을 Verdant Reach 1~3, Ember Ravine 4~6, Azure Highlands 6~8, Astral Sanctum 9로 배치한다.
10. WHEN Skyshard 획득 수가 증가하면, THE World SHALL 진행 연동 시간대를 아침 → 한낮 → 오후 → 황혼 순서로 전환하고, Astral Sanctum 활성화 후 별빛 밤, 엔딩 후 일출로 전환한다.

### Requirement 9: Landmark 중심 탐험과 발견 [P2]

**User Story:** 플레이어로서, 멀리 보이는 흥미로운 장소를 직접 찾아가고 싶다. 그래서 지도 아이콘보다 세계 자체를 보며 탐험할 수 있다.

#### Acceptance Criteria

1. THE World SHALL 대표 Landmark로 Verdant Reach에 Elderbough와 Breezewatch, Ember Ravine에 Cinderspire, Azure Highlands에 Starfall Observatory와 부유 유적 섬, 중앙에 Astral Sanctum을 배치한다.
2. THE Render_System SHALL 그래픽 품질 설정과 관계없이 지형에 가려지지 않은 대표 Landmark와 Astral Sanctum의 실루엣을 월드 어느 지점에서든 렌더링한다.
3. THE World SHALL 각 주요 Region의 Vista_Point에서 다른 주요 Region의 대표 Landmark 1개 이상과 Astral Sanctum이 보이도록 지형과 시야를 배치한다.
4. WHEN 플레이어가 Landmark의 발견 반경에 처음 진입하면, THE Cinematic_System SHALL 3초 이하의 Landmark framing 연출과 장소명을 표시하고, THE Map_System SHALL 해당 Landmark를 지도에 등록한다.
5. WHEN 플레이어가 Vista_Point에 도달하면, THE Map_System SHALL 주변 지도 구역을 공개하고 구역 안의 Waystone과 Landmark 위치를 표시한다.
6. WHEN 플레이어가 숨겨진 장소에 처음 진입하면, THE HUD SHALL "숨겨진 장소 발견" 알림과 전용 효과음을 재생하고, THE Map_System SHALL 해당 장소를 지도에 등록한다.
7. WHILE 플레이어가 동굴 또는 실내 공간 안에 있는 동안, THE Render_System SHALL 외부와 다른 조명·안개 설정으로 1초 동안 전환한 상태를 적용한다.
8. THE World SHALL 각 주요 Region의 주요 경로에 다음 목적지 방향의 Landmark가 화면 중앙 부근에 보이는 시야 지점을 1곳 이상 배치한다.

### Requirement 10: 월드 밀도, Chest, 수집품 [P2]

**User Story:** 플레이어로서, 길이 아닌 곳으로 가도 새로운 것을 발견하고 싶다. 그래서 작은 발견이 보상과 성장으로 이어지는 탐험을 즐길 수 있다.

#### Acceptance Criteria

1. THE World SHALL 이동 가능한 지상 영역의 모든 지점에서 반경 60m 안에 POI가 1개 이상 존재하도록 배치한다.
2. THE World SHALL 각 주요 Region에 Enemy_Camp 2개, Chest 6개, Puzzle_Mechanism 2개, Echo_Tablet 3개, Vista_Point 1개, Waystone 1개, 숨겨진 장소 1개, 숨겨진 Elite 1개 이상을 배치한다.
3. THE World SHALL 각 Chest를 숨겨진 장소, Enemy_Camp, 높은 지점, 퍼즐 보상, 샛길, 동굴 중 1가지 이상의 탐험 맥락과 연결된 위치에 배치한다.
4. THE World SHALL 각 주요 Region에 등반 또는 활강으로만 도달하는 높은 지점의 빛나는 Chest를 1개 이상 배치한다.
5. WHEN 플레이어가 Chest와 상호작용하면, THE Loot_System SHALL 개봉 애니메이션, 효과음, 보상 목록을 표시하고 등급별 보상(일반: Glim·회복 아이템, 정교한: Glim·Starmote, 빛나는: 장비 또는 다량 Starmote)을 지급한다.
6. WHEN 빛나는 Chest가 개봉되면, THE Render_System SHALL 일반 Chest보다 큰 빛 기둥 VFX를 재생하고, THE Audio_System SHALL 전용 효과음을 재생한다.
7. WHEN Enemy_Camp의 모든 적이 처치되면, THE Loot_System SHALL 캠프의 잠긴 Chest를 개방 가능 상태로 바꾸고 "캠프 소탕" 알림을 표시한다.
8. WHEN 플레이어가 Echo_Tablet을 획득하면, THE UI_System SHALL 1~2문장의 기록 텍스트를 표시하고, THE Inventory_System SHALL 해당 Region 수집 수(n/3)를 갱신한다.
9. WHEN 한 주요 Region의 Echo_Tablet 3개를 모두 획득하면, THE Progression_System SHALL 최대 Stamina를 15 증가시킨다.
10. THE World SHALL Azure Highlands에 제한 시간 안에 활강으로 링을 통과하는 Sky Ring Trial을 1개 이상 배치하고, 완료 시 THE Loot_System SHALL 빛나는 Chest 보상을 지급한다.

### Requirement 11: Waystone과 빠른 이동 [P2]

**User Story:** 플레이어로서, 발견한 장소로 빠르게 돌아가고 안전하게 재정비하고 싶다. 그래서 이동 반복 없이 탐험을 이어갈 수 있다.

#### Acceptance Criteria

1. THE World SHALL Thistlewick, 각 주요 Region, Shardfall Crater, Astral Sanctum 내부 연결 공간에 Waystone을 1개 이상 배치한다.
2. WHEN 플레이어가 비활성 Waystone과 상호작용하면, THE World SHALL Waystone을 활성화하는 빛 연출을 재생하고, THE Map_System SHALL 해당 Waystone을 빠른 이동 목적지로 등록한다.
3. WHEN 플레이어가 Waystone을 활성화하거나 활성 Waystone과 상호작용하면, THE Party_System SHALL 모든 Player_Character의 HP를 최대치로 회복하고 Downed를 해제하며, 해당 Waystone을 부활 지점으로 지정한다.
4. WHEN 플레이어가 In_Combat이 아닌 상태에서 지도에서 활성 Waystone을 선택하면, THE World SHALL 3초 이하의 화면 전환 후 플레이어를 해당 Waystone 옆에 배치한다.
5. IF 플레이어가 In_Combat 상태에서 빠른 이동을 선택하면, THEN THE UI_System SHALL "전투 중에는 이동할 수 없습니다" 메시지를 표시하고 이동을 취소한다.
6. WHEN 빠른 이동 또는 불러오기가 완료되면, THE World SHALL 처치된 일반 배회 적을 재배치하고, 소탕된 Enemy_Camp와 처치된 Elite는 처치된 상태로 유지한다.

### Requirement 12: Challenge_Area [P1]

**User Story:** 플레이어로서, 각 Skyshard를 서로 다른 성격의 도전을 통과해 얻고 싶다. 그래서 세 도전이 반복이 아닌 새로운 경험으로 느껴진다.

#### Acceptance Criteria

1. THE World SHALL Hollowroot Shrine을 전투와 기본 퍼즐 중심의 지하 뿌리 성소로 구성하고, Ember·Gale·Terra 퍼즐 각 1개 이상, 전투 방 1개 이상, Rootbound Warden 전투를 포함한다.
2. THE World SHALL Cinderspire를 수직 이동과 활강 중심의 외부 수정 첨탑으로 구성하고, 필수 등반 구간 3개 이상, Updraft 구간 2개 이상, 첨탑 사이 활강 구간 2개 이상, Tide로 식혀야 하는 Heat_Crystal 등반 구간 1개 이상, 정상의 Cinder Alpha 전투를 포함한다.
3. THE World SHALL Starfall Observatory를 속성 조합과 강화 전투 중심의 산정 관측소로 구성하고, 두 가지 이상 Element를 제한 시간 안에 정해진 순서로 적용하는 퍼즐 1개 이상, Element_Shield를 지닌 적 웨이브 전투, Sentinel Prime 전투를 포함한다.
4. THE World SHALL 세 Challenge_Area를 서로 다른 공간 구조, 조명, 색 팔레트, 음악으로 구성한다.
5. WHEN 플레이어가 Challenge_Area에 처음 진입하면, THE Cinematic_System SHALL 3초 이하의 진입 연출과 도전 이름 표시를 재생한다.
6. THE World SHALL Cinderspire의 각 필수 등반 구간을 기본 최대 Stamina의 70% 이하로 완주 가능하게 하고, 필수 구간 사이에 Stamina를 회복하는 휴식 발판을 배치한다.
7. THE World SHALL 각 Challenge_Area 안에 체크포인트를 2개 이상 배치한다.
8. IF 플레이어가 Challenge_Area 안에서 추락하거나 Party_Wipe가 발생하면, THEN THE Collision_System SHALL 플레이어를 해당 Challenge_Area의 가장 최근 체크포인트로 복귀시키고, 해결된 퍼즐 상태를 유지한다.
9. WHEN Challenge_Area의 Skyshard를 획득하면, THE World SHALL Challenge_Area 입구 또는 외부로 이어지는 출구 경로를 개방한다.

### Requirement 13: 환경 퍼즐 [P2]

**User Story:** 플레이어로서, 속성과 이동 능력으로 환경 장치를 풀고 싶다. 그래서 캐릭터 교체와 속성이 전투 밖에서도 의미를 가진다.

#### Acceptance Criteria

1. THE Puzzle_Mechanism SHALL Ember로 가시덤불 태우기와 화로 점화, Tide로 Heat_Crystal 냉각과 불붙은 장애물 소화, Gale로 풍력 장치 회전, Terra로 금 간 바위 파괴와 돌기둥을 이용한 압력판 누르기를 지원한다.
2. THE Puzzle_Mechanism SHALL 필요한 Element를 장치 표면의 Element 아이콘과 색상으로 표시한다.
3. WHEN Puzzle_Mechanism이 올바른 입력을 받으면, THE Puzzle_Mechanism SHALL 0.2초 이내에 시각 변화(발광, 회전, 개방)와 효과음을 재생한다.
4. WHEN 퍼즐이 해결되면, THE Puzzle_Mechanism SHALL 해결 효과음과 보상 또는 경로 개방 연출을 재생하고, THE Save_System SHALL 해결 상태를 저장한다.
5. IF 순서형 퍼즐이 잘못된 순서로 작동되거나 제한 시간을 넘기면, THEN THE Puzzle_Mechanism SHALL 2초 이내에 초기 상태로 되돌리고 실패 효과음을 재생한다.
6. THE Puzzle_Mechanism SHALL 순서형 퍼즐의 제한 시간을 단계 수 × 5초 이상으로 설정한다.
7. WHEN 플레이어가 같은 퍼즐에서 3회 실패하면, THE UI_System SHALL 해당 퍼즐의 한 줄 힌트를 표시한다.
8. WHEN Heat_Crystal이 Tide를 받으면, THE Puzzle_Mechanism SHALL 해당 Heat_Crystal을 10초 동안 식은 상태로 바꾸어 접촉 피해를 해제하고 등반 가능 표면으로 전환한다.
9. WHEN Unstable_Crystal이 Ember를 받으면, THE Puzzle_Mechanism SHALL 1초 Telegraph 후 반경 4m 폭발을 일으켜 범위 안의 적과 Player_Character에게 피해를 적용한다.

### Requirement 14: 마을, NPC, 대화, 상점 [P2]

**User Story:** 플레이어로서, 역할이 분명한 마을 사람들과 짧게 대화하고 재정비하고 싶다. 그래서 세계가 내 진행에 반응한다고 느낄 수 있다.

#### Acceptance Criteria

1. THE World SHALL Thistlewick에 Elder Maren(Main_Quest), Pip(상점), Old Bram(Echo Altar 능력 강화), Tamsin과 Hobb(Side_Quest), 회복용 Hearth, Waystone을 배치한다.
2. THE World SHALL Ember Ravine에 광부 Durga를, Azure Highlands에 천문학자 Oriel을 지역 이야기와 힌트 NPC로 배치한다.
3. WHEN 플레이어가 NPC에게 2.5m 이내로 접근하면, THE HUD SHALL NPC 이름, 역할 아이콘, 상호작용 키가 포함된 prompt를 표시한다.
4. WHEN 플레이어가 NPC와 대화를 시작하면, THE Dialogue_System SHALL 0.5초 안에 NPC를 플레이어 쪽으로 회전시키고 화자 이름과 최대 3줄의 대사가 있는 대화 창을 표시한다.
5. THE Dialogue_System SHALL 한 번의 대화를 일반 대화 6개, 주요 스토리 대화 10개 이하의 대사 창으로 구성한다.
6. WHEN 대사 출력 중 진행 입력(F, Space, 좌클릭)을 누르면, THE Dialogue_System SHALL 현재 대사 출력을 즉시 완료하고, 다음 진행 입력에 다음 대사로 넘긴다.
7. THE Dialogue_System SHALL 이름 있는 NPC마다 Skyshard 0·1·2·3개와 엔딩 후 구간에 따라 서로 다른 대사를 제공한다.
8. WHEN Skyshard 획득 수가 증가하면, THE World SHALL Thistlewick에 장식, 등불, NPC 배치 중 1가지 이상의 시각 변화를 적용한다.
9. THE Animation_System SHALL 각 NPC에 idle 동작과 일하기, 걷기, 둘러보기 중 1가지 이상의 주변 행동을 재생한다.
10. WHEN 플레이어가 Hearth와 상호작용하면, THE Party_System SHALL 모든 Player_Character의 HP를 최대치로 회복하고 Downed를 해제한다.
11. WHEN 플레이어가 Pip과 상호작용하면, THE UI_System SHALL Glim으로 소비 아이템과 Charm을 구매하는 상점 화면을 표시한다.
12. IF 보유 Glim이 상품 가격보다 적으면, THEN THE UI_System SHALL 해당 구매 버튼을 비활성화하고 부족한 Glim 수량을 표시한다.

### Requirement 15: Side_Quest [P3]

**User Story:** 플레이어로서, 기존 장소를 새롭게 활용하는 짧은 부가 이야기를 즐기고 싶다. 그래서 메인 진행 사이에 추가 동기를 얻을 수 있다.

#### Acceptance Criteria

1. THE Quest_System SHALL Side_Quest 3개를 제공한다: Tamsin의 잃어버린 풍경(등반·활강으로 높은 곳 탐색), Hobb의 들판 가시 소탕(Enemy_Camp 전투), Durga의 식어버린 용광로(Ember로 화로 3개 점화).
2. THE Quest_System SHALL 각 Side_Quest를 기존 장소와 시스템을 활용해 5분 이하로 완료할 수 있게 구성한다.
3. WHEN Side_Quest를 완료하면, THE Loot_System SHALL 고유 보상(Charm, Relic 또는 Starmote)을 지급하고, THE World SHALL 관련 장소에 시각 변화 1가지를 적용한다.
4. WHILE Side_Quest가 추적 상태인 동안, THE Map_System SHALL Compass와 지도에 해당 Side_Quest의 Objective를 표시한다.
5. WHERE 일정·품질 문제로 Side_Quest가 메인 완성도를 떨어뜨리는 경우, THE Quest_System SHALL 해당 Side_Quest를 제거하고 나머지 Side_Quest와 메인 진행을 유지한다.

### Requirement 16: 기본 이동과 수영 [P1]

**User Story:** 플레이어로서, 예측 가능하고 반응이 좋은 이동으로 세계를 누비고 싶다. 그래서 조작이 아닌 탐험에 집중할 수 있다.

#### Acceptance Criteria

1. THE Player_Controller SHALL 달리기(기본 이동, 6m/s), 걷기(Ctrl 토글 또는 아날로그 입력 50% 이하, 2.5m/s), 질주(Shift 유지, 9m/s, Stamina 초당 18 소모)를 제공한다.
2. THE Player_Controller SHALL 이동 시작 후 0.15초 이내에 목표 속도에 도달하고, 입력 해제 후 0.12초 이내에 정지하며, 방향 전환을 0.1~0.2초 동안 보간한다.
3. WHEN 지상에서 점프 입력(Space)을 누르면, THE Player_Controller SHALL 약 1.4m 높이의 점프를 수행하고 공중에서 입력 방향 제어를 허용한다.
4. WHEN 캐릭터가 지면을 벗어나면, THE Player_Controller SHALL 낙하 상태로 전환하고 최대 낙하 속도 40m/s까지 중력 가속을 적용한다.
5. WHEN 캐릭터가 12m 이상 낙하 후 착지하면, THE Player_Controller SHALL 0.4초 착지 경직, 먼지 VFX, 착지음, 약한 카메라 흔들림을 적용하고 낙하 피해를 적용하지 않는다.
6. THE Player_Controller SHALL 50° 이하의 경사를 걸어서 오르게 하고, 50° 초과 경사에서는 미끄러짐 또는 등반 가능 표면의 등반으로 전환한다.
7. THE Player_Controller SHALL 0.45m 이하 높이의 턱과 계단을 멈춤 없이 올라가게 한다.
8. WHEN Dodge 입력(우클릭)을 누르면, THE Player_Controller SHALL 입력 방향(입력이 없으면 후방)으로 0.35초 동안 약 4m 이동하고 Stamina 20을 소모한다.
9. WHILE 캐릭터가 깊이 1.2m 미만의 물에 있는 동안, THE Player_Controller SHALL 이동 속도를 20% 줄이고 물 튀김 VFX와 물 발소리를 재생한다.
10. WHEN 캐릭터가 깊이 1.2m 이상의 물에 들어가면, THE Player_Controller SHALL 수면 수영 상태로 전환하고 수영 이동 중 Stamina를 초당 6 소모한다.
11. IF 수영 중 Stamina가 0이 되면, THEN THE Player_Controller SHALL 화면 전환 후 캐릭터를 가장 최근 Safe_Position으로 복귀시킨다.

### Requirement 17: Stamina [P1]

**User Story:** 플레이어로서, 이동 자원의 한계를 계산하며 오르고 날고 싶다. 그래서 등반과 활강에 긴장감과 계획이 생긴다.

#### Acceptance Criteria

1. THE Player_Controller SHALL Party가 공유하는 Stamina를 질주, Dodge, 등반, 등반 도약, 활강, 수영에 사용한다.
2. WHILE Stamina 소모 행동이 없는 상태가 1초 이상 지속되는 동안, THE Player_Controller SHALL Stamina를 초당 25씩 회복한다.
3. WHEN Stamina가 0이 되면, THE Player_Controller SHALL Exhausted 상태로 전환하고, THE HUD SHALL Stamina 게이지를 붉게 점멸한다.
4. WHILE Exhausted 상태인 동안, THE Player_Controller SHALL 질주, Dodge, 등반, 활강의 새 시작 입력을 거부하고, Stamina가 최대치의 30% 이상이 되면 Exhausted를 해제한다.
5. WHILE Stamina가 최대치 미만인 동안, THE HUD SHALL Active_Character 옆에 원형 Stamina 게이지를 표시하고, 최대치 상태가 2초 지속되면 게이지를 숨긴다.
6. WHEN 캐릭터 교체가 수행되면, THE Player_Controller SHALL 현재 Stamina 값을 유지하고 새 Active_Character의 패시브 소모 보정(표 A)을 적용한다.

### Requirement 18: 등반 [P1]

**User Story:** 플레이어로서, 절벽과 구조물을 직접 올라 높은 곳에서 세계를 내려다보고 싶다. 그래서 길이 아닌 곳으로도 탐험할 수 있다.

#### Acceptance Criteria

1. THE World SHALL 바위 절벽, 흙 절벽, 폐허 벽, 큰 나무 줄기, 건물 외벽을 등반 가능 표면으로 지정하고, 등반 불가 표면(Blight 결정, 성소 결계 벽, 가열된 Heat_Crystal)을 공통 시각 재질로 표시한다.
2. WHEN 캐릭터가 경사 65° 이상의 등반 가능 표면을 향해 이동 입력을 0.2초 이상 유지하거나 공중에서 등반 가능 표면에 접촉하면, THE Player_Controller SHALL 등반 시작 동작과 함께 등반 상태로 전환한다.
3. WHILE 등반 상태인 동안, THE Player_Controller SHALL 이동 입력에 따라 위·아래·좌·우로 초당 2m 이동하고, 이동 중 Stamina를 초당 10, 정지 중 초당 2 소모한다.
4. WHEN 등반 상태에서 점프 입력을 누르면, THE Player_Controller SHALL 입력 방향으로 약 2m 도약하고 Stamina 20을 소모한다.
5. WHEN 등반 중 표면 상단 모서리에 도달하면, THE Player_Controller SHALL 0.5초 이내의 올라서기 동작 후 캐릭터를 상단 지면 위에 배치한다.
6. WHEN 등반 중 이탈 입력(C)을 누르면, THE Player_Controller SHALL 캐릭터를 표면에서 떼어 낙하 상태로 전환한다.
7. IF 등반 중 Stamina가 0이 되면, THEN THE Player_Controller SHALL 캐릭터를 표면에서 떼어 낙하 상태로 전환한다.
8. WHEN 아래 방향 등반 중 발 아래 0.3m 이내에 걸을 수 있는 지면이 감지되면, THE Player_Controller SHALL 등반 상태를 해제하고 지상 상태로 전환한다.
9. THE Player_Controller SHALL 높이 1.0m 미만의 장식 오브젝트(작은 바위, 울타리, 상자)를 등반 대상에서 제외하고 턱 오르기 또는 넘어가기로 처리한다.
10. WHILE 등반 상태인 동안, THE Player_Controller SHALL 캐릭터 방향을 표면 법선에 맞추고 볼록·오목 모서리에서 캐릭터를 표면 바깥 0.5m 이내에 유지하여 튕겨 나감과 표면 관통을 방지한다.
11. WHILE 등반 상태인 동안, THE Combat_System SHALL Normal_Attack, Skill, Burst 입력을 무시한다.

### Requirement 19: 활강과 기류 [P1]

**User Story:** 플레이어로서, 높은 곳에서 뛰어내려 활강하며 동선을 줄이고 싶다. 그래서 높은 Landmark와 지형이 이동의 기회가 된다.

#### Acceptance Criteria

1. WHEN 낙하 중 캐릭터 아래 지면까지 거리가 3m 이상일 때 점프 입력을 누르면, THE Player_Controller SHALL 0.3초 전개 동작과 함께 활강 상태로 전환한다.
2. WHILE 활강 상태인 동안, THE Player_Controller SHALL 낙하 속도를 초당 2.5m 이하로 제한하고, 입력 방향 수평 이동을 9m/s로 허용하며, Stamina를 초당 6 소모한다.
3. WHEN 활강 중 점프 입력 또는 이탈 입력(C)을 누르면, THE Player_Controller SHALL 활강을 종료하고 낙하 상태로 전환한다.
4. WHEN 활강 중 지면, 물, 등반 가능 표면에 닿으면, THE Player_Controller SHALL 활강을 종료하고 각각 착지, 수영, 등반 상태로 전환한다.
5. IF 활강 중 Stamina가 0이 되면, THEN THE Player_Controller SHALL 활강을 종료하고 낙하 상태로 전환한다.
6. WHILE 활강 상태로 Updraft 안에 있는 동안, THE Player_Controller SHALL 캐릭터를 초당 8m 상승시키고 Updraft 상단 높이에서 상승을 멈춘다.
7. WHILE 활강 상태로 Wind_Zone 안에 있는 동안, THE Player_Controller SHALL Wind_Zone 방향으로 초당 4m의 수평 이동을 더한다.
8. THE Render_System SHALL Updraft를 위로 흐르는 입자 기둥으로, Wind_Zone을 흐르는 바람 선으로 표시하고, THE Audio_System SHALL 각각 바람 소리를 재생한다.
9. WHILE Wren이 Active_Character로 활강 중인 동안, THE Combat_System SHALL Wren의 Skill 사용을 허용하고 사용 시 캐릭터를 6m 상승시킨다.
10. WHILE 활강 중인 동안, THE Audio_System SHALL 높이와 속도에 비례해 커지는 바람 소리를 재생한다.

### Requirement 20: 충돌 안정성과 복구 [P1]

**User Story:** 플레이어로서, 지형에 빠지거나 끼여 진행이 막히는 일 없이 움직이고 싶다. 그래서 이동과 전투를 신뢰할 수 있다.

#### Acceptance Criteria

1. THE Collision_System SHALL Player_Character, 적, Caelith, NPC를 지형과 정적 구조물 표면 바깥에 유지한다.
2. WHEN Player_Character와 적의 충돌체가 겹치면, THE Collision_System SHALL 0.2초 이내에 두 충돌체를 분리한다.
3. THE Collision_System SHALL 투사체의 이동 경로 전체를 기준으로 지형·벽 충돌을 판정한다.
4. WHILE 캐릭터가 In_Combat이 아닌 상태로 물, hazard, 움직이는 발판이 아닌 걸을 수 있는 지면에 서 있는 동안, THE Collision_System SHALL 1초마다 Safe_Position을 갱신한다.
5. IF 캐릭터가 지형 표면보다 2m 이상 아래 또는 월드 경계 밖에 있으면, THEN THE Collision_System SHALL 1초 이내에 화면 전환과 함께 캐릭터를 가장 최근 Safe_Position으로 복귀시킨다.
6. IF 낙하 상태가 2초 이상 지속되는 동안 높이 변화가 0.1m 미만이면, THEN THE Collision_System SHALL 끼임으로 판정하고 캐릭터를 가장 최근 Safe_Position으로 복귀시킨다.
7. IF 적이 지형 아래 또는 월드 경계 밖에 있으면, THEN THE Collision_System SHALL 해당 적을 스폰 위치로 되돌린다.
8. THE UI_System SHALL Pause 메뉴에 "끼임 해제" 명령을 제공하고, THE Collision_System SHALL 명령 실행 시 캐릭터를 가장 최근 Safe_Position으로 복귀시킨다.

### Requirement 21: 카메라와 컨텍스트 연출 [P1]

**User Story:** 플레이어로서, 전투와 플랫폼 이동 중 항상 캐릭터와 위협을 볼 수 있는 카메라를 원한다. 그래서 카메라 때문에 실패하지 않는다.

#### Acceptance Criteria

1. THE Camera_System SHALL Active_Character를 기본 거리 5.5m, 어깨 높이에서 추적하는 3인칭 카메라를 제공하고, 마우스 휠로 3~8m 범위의 거리 조절을 허용한다.
2. WHEN pointer lock 상태에서 마우스가 이동하면, THE Camera_System SHALL 감도 설정에 비례해 카메라를 회전하고 수직 각도를 -60°~+75°로 제한한다.
3. WHEN 카메라와 캐릭터 사이에 지형 또는 벽이 있으면, THE Camera_System SHALL 0.1초 이내에 카메라를 장애물 앞으로 당겨 지오메트리 외부에 유지하고, 장애물이 사라지면 0.5초 동안 원래 거리로 복귀한다.
4. WHEN 카메라가 캐릭터에서 1.0m 이내로 가까워지면, THE Render_System SHALL 캐릭터 모델을 반투명으로 표시한다.
5. WHILE In_Combat인 동안, THE Camera_System SHALL 카메라 거리를 최대 7m까지 늘려 주변 적이 화면에 들어오게 하고, THE HUD SHALL 화면 밖 적의 공격 Telegraph 방향을 화면 가장자리 표시로 알린다.
6. WHEN Lock-on 입력(R 또는 마우스 가운데 버튼)을 누르면, THE Camera_System SHALL 20m 이내에서 화면 중앙에 가장 가까운 적을 고정 대상으로 설정하여 대상과 캐릭터가 모두 화면에 들어오게 회전하고, 재입력 시 해제한다.
7. WHEN 20m 이내에 적이 없는 상태에서 Lock-on 입력을 누르면, THE Camera_System SHALL 0.3초 동안 캐릭터 정면 방향으로 카메라를 재정렬한다.
8. WHEN Lock-on 대상이 처치되거나 25m 밖으로 벗어나면, THE Camera_System SHALL 고정을 해제한다.
9. THE Cinematic_System SHALL 컨텍스트 연출을 Landmark 발견, Challenge_Area 진입, 동료 합류, Skyshard 획득, Astral Sanctum 활성화, 보스 등장, Phase 전환, 엔딩에만 사용하고, 각 연출을 저장 파일당 1회(Phase 전환은 전투마다) 재생한다.
10. WHILE 컨텍스트 연출이 재생되는 동안, THE Game SHALL 적 공격과 hazard 피해를 정지하고, 연출 종료 후 0.3초 이내에 조작권을 돌려준다.
11. WHILE 3초를 넘는 컨텍스트 연출이 재생되는 동안, THE UI_System SHALL 재생 1초 후부터 Esc 입력으로 건너뛰기를 허용한다.

### Requirement 22: 파티 구성과 캐릭터 차별화 [P1]

**User Story:** 플레이어로서, 외형과 전투 방식이 뚜렷이 다른 네 동료를 조작하고 싶다. 그래서 상황에 맞는 캐릭터를 고르는 재미가 생긴다.

#### Acceptance Criteria

1. THE Party_System SHALL 표 A의 4명 Player_Character를 각자의 Element, 역할, Normal_Attack, Charged_Attack, Skill, Burst, 패시브와 함께 제공한다.
2. THE Party_System SHALL Player_Character를 Kairen(시작), Isla(Main_Quest 1단계, Thistlewick), Wren(Main_Quest 2단계, Breezewatch), Talus(Main_Quest 3단계, Hollowroot Shrine 입구) 순서로 합류시킨다.
3. WHEN Player_Character가 합류하면, THE Cinematic_System SHALL 6초 이하의 합류 연출을 재생하고, THE Tutorial_System SHALL 교체 키와 대표 능력을 안내한다.
4. THE Party_System SHALL 캐릭터별 기본 스탯을 역할에 따라 설정한다: Talus의 최대 HP는 다른 캐릭터 평균의 130% 이상, Kairen의 근접 공격력은 파티 최고, Isla의 Normal_Attack 사거리는 25m, Wren의 Skill 효과 반경은 파티 최대.
5. THE Render_System SHALL 4명의 Player_Character를 서로 다른 체형 비율, 헤어 실루엣, 의상 형태, 주 색상, 무기 형태로 구성하여 30m 거리에서 실루엣만으로 구별되게 한다.
6. THE Animation_System SHALL 캐릭터별 Normal_Attack, Charged_Attack, Skill, Burst 동작을 서로 다른 애니메이션과 VFX로 재생한다.

### Requirement 23: 캐릭터 교체 [P1]

**User Story:** 플레이어로서, 전투 중 메뉴 없이 즉시 캐릭터를 바꾸고 싶다. 그래서 이전 캐릭터가 남긴 속성을 다음 캐릭터로 이어 반응을 만들 수 있다.

#### Acceptance Criteria

1. WHEN 숫자 키 1~4 또는 게임패드 D-pad 입력을 누르면, THE Party_System SHALL 0.1초 이내에 해당 Player_Character를 Active_Character로 교체하고 이전 캐릭터의 위치, 방향, 이동 속도를 이어받게 한다.
2. IF 교체 대상이 Downed, 미합류, 현재 Active_Character 중 하나이면, THEN THE Party_System SHALL 교체를 수행하지 않고 파티 UI의 해당 슬롯을 흔드는 피드백을 표시한다.
3. WHEN 교체가 수행되면, THE Party_System SHALL 0.8초 동안 추가 교체 입력을 거부하고 파티 UI에 교체 대기 시간을 표시한다.
4. WHILE 등반, 활강, 수영, 대화, 컨텍스트 연출 중인 동안, THE Party_System SHALL 교체 입력을 거부한다.
5. WHEN 교체가 수행되면, THE Element_System SHALL 적에게 남은 모든 Element_Mark, 지속 효과, 설치된 효과(돌기둥, 화살비, 소용돌이)를 유지한다.
6. WHEN 공격 동작 중 교체가 수행되면, THE Combat_System SHALL 이전 캐릭터의 진행 중인 동작을 취소하고, 이미 발사된 projectile과 설치된 효과를 유지한다.
7. WHEN 교체가 수행되면, THE Render_System SHALL 새 Active_Character의 Element 색상 등장 VFX를 0.3초 재생하고, THE Audio_System SHALL 교체 효과음을 재생한다.
8. WHILE Player_Character가 대기 중인 동안, THE Combat_System SHALL 해당 캐릭터의 Skill Cooldown 경과를 계속 진행한다.
9. WHILE Lock-on 대상 또는 가장 가까운 적이 Element_Mark를 지닌 동안, THE HUD SHALL 각 대기 캐릭터 슬롯 옆에 해당 캐릭터가 일으킬 Reaction 아이콘을 표시한다.

### Requirement 24: 기본 전투와 능력 자원 [P1]

**User Story:** 플레이어로서, 공격·회피·능력이 애니메이션과 타이밍으로 연결된 손맛 있는 전투를 원한다. 그래서 숫자만 줄어드는 전투가 아니라 행동의 결과를 느낄 수 있다.

#### Acceptance Criteria

1. WHEN 공격 입력(좌클릭)을 누르면, THE Combat_System SHALL Active_Character의 Normal_Attack 다음 타격을 재생하고 애니메이션의 지정 타격 시점에 피해 판정을 발생시킨다.
2. WHEN Normal_Attack의 마지막 타격, Charged_Attack, Skill, Burst가 적에게 명중하면, THE Element_System SHALL 대상에게 Active_Character의 Element를 적용한다.
3. WHEN 공격 입력을 0.4초 이상 유지한 뒤 놓으면, THE Combat_System SHALL Active_Character의 Charged_Attack을 발동한다.
4. WHEN Skill 입력(E)을 누르고 Cooldown이 0이면, THE Combat_System SHALL Skill을 발동하고 표 A의 Cooldown을 시작한다.
5. IF Cooldown 중 Skill 입력을 누르거나 Energy가 부족한 상태에서 Burst 입력을 누르면, THEN THE HUD SHALL 해당 아이콘을 강조하고 거부 효과음을 재생한다.
6. WHEN Burst 입력(Q)을 누르고 Active_Character의 Energy가 최대치이면, THE Combat_System SHALL Burst를 발동하고, 1.0초 이하의 캐릭터 전용 연출 동안 Active_Character에게 무적을 적용하며, Energy를 0으로 만든다.
7. THE Combat_System SHALL Active_Character에게 Energy를 Normal_Attack 명중당 1, Charged_Attack 명중당 3, 적에게 명중한 Skill 시전당 6, Reaction 발생당 5, Perfect_Dodge당 10만큼 지급한다.
8. WHEN Dodge를 시작하면, THE Combat_System SHALL 0.25초 동안 Active_Character에게 피해 무효를 적용한다.
9. WHEN Perfect_Dodge가 판정되면, THE Combat_System SHALL 0.5초 동안 게임 속도를 30%로 낮추고 잔상 VFX와 전용 효과음을 재생한다.
10. WHEN 공격이 적에게 명중하면, THE Combat_System SHALL 공격력, 능력 배율, 대상 방어력, 장비 효과, 치명타(기본 확률 5%, 피해 150%)를 반영한 피해를 적 HP에 적용한다.
11. WHILE 공격 동작의 후딜 구간인 동안, THE Combat_System SHALL Dodge 입력으로 동작 취소를 허용한다.
12. WHEN 근접 공격 시작 시 5m 이내에 적이 있으면, THE Combat_System SHALL 카메라 정면 기준 60° 이내의 가장 가까운 적 방향으로 캐릭터를 회전시킨다.
13. WHEN Isla가 Normal_Attack 또는 Charged_Attack을 사용하면, THE Combat_System SHALL Lock-on 대상 또는 카메라 정면 30° 원뿔 안의 25m 이내 가장 가까운 적을 조준하고, 대상이 없으면 화면 중앙 방향으로 발사한다.

### Requirement 25: Element_Mark와 Reaction [P1]

**User Story:** 플레이어로서, 속성을 순서대로 겹쳐 강력한 반응을 만들고 싶다. 그래서 캐릭터를 교체하는 분명한 이유가 생긴다.

#### Acceptance Criteria

1. THE Element_System SHALL Ember, Tide, Gale, Terra를 고유 색상과 고유 아이콘 형태(Ember: 세 갈래 불꽃, Tide: 겹친 물결 원, Gale: 나선, Terra: 육각 결정)로 표시한다.
2. WHEN Element가 Element_Mark 없는 대상에게 적용되면, THE Element_System SHALL 8초 지속 Element_Mark를 부여하고 대상 HP 바 위에 Element 아이콘과 남은 시간 표시를 한다.
3. WHEN 대상이 지닌 Element_Mark와 같은 Element가 적용되면, THE Element_System SHALL 표식 지속 시간을 8초로 갱신한다.
4. WHILE 대상이 Element_Mark를 지닌 동안, THE Element_System SHALL 표식 효과를 적용한다: Ember는 초당 공격력 5% 지속 피해, Tide는 이동 속도 20% 감소, Gale은 넉백 거리 50% 증가, Terra는 Stagger 누적량 50% 증가.
5. WHEN Element_Mark를 지닌 대상에게 다른 Element가 적용되면, THE Element_System SHALL 표 B의 Reaction을 발생시키고 대상의 기존 Element_Mark를 소모한다.
6. WHEN 확산 Reaction(불꽃 확산, 물안개 확산, 모래 돌풍)이 발생하면, THE Element_System SHALL 대상의 기존 표식을 반경 5m 안의 다른 적에게 부여하고, 부여 대상이 다른 Element_Mark를 지니면 해당 대상에서 추가 Reaction을 발생시킨다.
7. WHEN Reaction_Chain이 2회 이상 이어지면, THE HUD SHALL 연쇄 횟수(예: "연쇄 x2")를 1.5초 동안 표시한다.
8. THE Element_System SHALL 같은 대상에서 같은 Reaction을 1초에 최대 1회 발생시킨다.
9. WHEN Reaction이 발생하면, THE Element_System SHALL Reaction별 고유 VFX, 고유 효과음, 한국어 Reaction 이름 텍스트를 대상 위치에 표시한다.
10. WHILE 대상이 Element_Shield를 지닌 동안, THE Element_System SHALL 같은 Element 피해를 25%, Reaction 피해를 300%로 방어막에 적용하고 방어막 Element_Mark를 소모하지 않는다.
11. WHEN Element_Shield 내구도가 0이 되면, THE Element_System SHALL 방어막 파괴 VFX를 재생하고 대상을 3초 동안 Stagger 상태로 만든다.
12. WHEN Terra가 관여한 Reaction이 발생하면, THE Party_System SHALL Active_Character에게 5초 동안 최대 HP 8%의 보호막을 부여한다.
13. THE UI_System SHALL Pause 메뉴에 발견한 Reaction의 조합과 효과를 보여주는 "속성 반응 도감"을 제공한다.

### Requirement 26: 전투 피드백 [P1]

**User Story:** 플레이어로서, 모든 타격과 반응의 결과를 한눈에 읽고 싶다. 그래서 화려하면서도 판독 가능한 전투를 즐길 수 있다.

#### Acceptance Criteria

1. WHEN 공격이 적에게 명중하면, THE Render_System SHALL 0.1초 hit flash, 타격 방향 impact particle, Element 색상의 피해 숫자를 표시하고, THE Animation_System SHALL 적 피격 반응 동작을 재생한다.
2. WHEN 치명타가 발생하면, THE Render_System SHALL 일반 피해보다 큰 크기와 강조 색상의 피해 숫자를 표시한다.
3. WHEN Charged_Attack 마지막 타격, Burst, 폭발형 Reaction, Element_Shield 파괴가 발생하면, THE Combat_System SHALL 50~90ms Hit_Stop을 적용하고, THE Camera_System SHALL 짧은 camera impulse를 적용한다.
4. THE Camera_System SHALL Normal_Attack 일반 명중에 화면 흔들림을 적용하지 않는다.
5. WHEN 적이 공격을 준비하면, THE Render_System SHALL 공격 종류에 맞는 Telegraph(몸체 발광, 지면 범위 표시, 돌진 경로 선)를 공격 판정 전에 표시하고, THE Audio_System SHALL 준비 효과음을 재생한다.
6. WHEN 적이 처치되면, THE Animation_System SHALL 적 사망 동작을 재생하고, THE Render_System SHALL 1.5초 이내에 소멸 VFX와 함께 적 모델을 제거한다.
7. WHEN Active_Character가 피해를 받으면, THE Render_System SHALL 화면 가장자리 피격 표시와 피격 방향 표시를 0.4초 동안 표시하고, THE Animation_System SHALL 피격 동작을 재생한다.
8. THE Render_System SHALL 동시에 표시되는 피해 숫자를 최대 24개로 제한하고, 전투 VFX가 적 Telegraph를 가리지 않도록 Telegraph를 VFX 위 계층에 렌더링한다.
9. WHEN 적의 Stagger 누적량이 임계치에 도달하면, THE Enemy_AI SHALL 적을 2초 동안 Stagger 상태로 만들고, THE Render_System SHALL Stagger 표시를 적 위에 표시한다.

### Requirement 27: HP, Downed, 패배 [P1]

**User Story:** 플레이어로서, 쓰러져도 진행을 잃지 않고 다시 도전하고 싶다. 그래서 어려운 전투에도 부담 없이 도전할 수 있다.

#### Acceptance Criteria

1. THE Party_System SHALL Player_Character마다 독립된 현재 HP와 최대 HP를 관리한다.
2. WHEN Active_Character의 HP가 0이 되면, THE Party_System SHALL 해당 캐릭터를 Downed로 만들고 0.8초 후 Downed가 아닌 다음 슬롯의 캐릭터로 자동 교체한다.
3. WHEN Party_Wipe가 발생하면, THE UI_System SHALL Defeat Screen을 표시하고, 플레이어 선택 후 THE World SHALL Party를 마지막 부활 지점(Waystone, Hearth 또는 Challenge_Area 체크포인트)에 모든 캐릭터 HP 최대치로 배치한다.
4. WHEN Party_Wipe 후 재시작하면, THE Game SHALL Skyshard, 퀘스트 진행, 획득 아이템, Glim, 경험치를 유지하고 해당 전투의 적을 최대 HP로 재배치한다.
5. WHEN 회복 아이템 빠른 사용 입력(Z)을 누르면, THE Inventory_System SHALL 허브 경단 1개를 소모해 Active_Character HP를 최대치의 35% 회복하고, 3초 동안 추가 사용을 거부한다.
6. WHEN 플레이어가 Inventory 화면에서 불씨 깃털을 Downed 캐릭터에게 사용하면, THE Party_System SHALL 해당 캐릭터를 HP 30%로 부활시킨다.

### Requirement 28: 적 종류와 Enemy_AI [P1]

**User Story:** 플레이어로서, 행동과 대응법이 다른 적들과 싸우고 싶다. 그래서 전투마다 다른 판단과 캐릭터 선택이 필요하다.

#### Acceptance Criteria

1. THE Enemy_AI SHALL 표 C의 8종 적과 Elite를 근거리 추격형, 원거리형, 방어형, 빠른 돌진형, 속성 능력 사용형 archetype으로 구성하고, 각 적을 실루엣, 이동 패턴, 공격 사거리, 속도, HP, 약점 중 3개 이상의 요소로 구별한다.
2. THE Enemy_AI SHALL 각 적을 idle, patrol, alert, chase, attack, recovery, return, dead 상태 중 해당 적에 정의된 상태로 동작시키고, 상태 전이를 정의된 전이로 제한한다.
3. WHEN 플레이어가 적의 전방 120° 시야 안 14m 이내 또는 전방위 6m 이내에 들어오거나 적을 공격하면, THE Enemy_AI SHALL 0.5초의 alert 동작(느낌표 표시, 경고음) 후 chase 상태로 전환한다.
4. WHILE chase 상태인 동안, THE Enemy_AI SHALL 근거리형은 공격 사거리 2m 안으로 접근하고, 원거리형은 플레이어와 8~14m 거리를 유지하며 시야가 확보된 위치로 이동한다.
5. WHEN 적이 스폰 위치에서 30m 이상 멀어지거나 플레이어를 8초 이상 감지하지 못하면, THE Enemy_AI SHALL return 상태로 전환해 스폰 위치로 돌아가며 HP를 최대치로 회복한다.
6. THE Enemy_AI SHALL 플레이어에게 동시에 공격 동작을 시작하는 근거리 적을 최대 2체로 제한하고, 나머지 적은 주변을 선회하며 대기시킨다.
7. THE Enemy_AI SHALL 적끼리 최소 1.2m 간격을 유지하도록 분리 이동을 적용한다.
8. WHEN 적의 이동 경로 앞에 절벽 가장자리 또는 장애물이 감지되면, THE Enemy_AI SHALL 다른 방향으로 경로를 바꾸고, 2초 이상 이동 진척이 없으면 return 상태로 전환한다.
9. WHEN 적이 공격을 시작하면, THE Enemy_AI SHALL 일반 공격 0.4초 이상, 강공격 0.8초 이상의 Telegraph 준비 동작 후 피해 판정을 발생시킨다.
10. WHEN 적의 공격 판정이 Dodge 무적이 아닌 Active_Character와 겹치면, THE Combat_System SHALL 적 공격력과 캐릭터 방어력을 반영한 피해를 Active_Character HP에 적용한다.
11. WHEN Mossback Brute가 정면에서 Normal_Attack을 받으면, THE Combat_System SHALL 피해를 70% 감소시키고, Ember 또는 Charged_Attack 명중 시 방어를 파괴해 3초 Stagger를 적용한다.
12. WHILE 적이 플레이어로부터 80m 밖에 있는 동안, THE Enemy_AI SHALL 해당 적의 AI 갱신을 정지한다.
13. WHEN 적이 처치되면, THE Loot_System SHALL 적 종류별 경험치, Glim, 확률형 재료를 지급하고, 드롭 아이템을 3m 이내 접근 시 자동 흡수시킨다.

### Requirement 29: 성장 [P2]

**User Story:** 플레이어로서, 짧은 플레이 안에서도 강해지는 것을 체감하고 싶다. 그래서 전투와 탐험의 보상이 의미를 가진다.

#### Acceptance Criteria

1. THE Progression_System SHALL Party 공용 레벨 1~10과 경험치를 관리하고, 적 처치, 퀘스트 완료, Chest 개봉, 첫 발견에서 경험치를 지급한다.
2. WHEN Party 레벨이 오르면, THE Progression_System SHALL 모든 Player_Character의 최대 HP를 8%, 공격력을 6% 증가시키고 HP를 최대치로 회복하며, 레벨업 VFX와 효과음을 재생한다.
3. THE Progression_System SHALL 메인 진행만 수행한 플레이어가 Caelith 전투 시점에 레벨 7 이상에 도달하도록 경험치 곡선을 구성한다.
4. WHEN 플레이어가 Old Bram의 Echo Altar에서 Starmote와 Glim을 소모하면, THE Progression_System SHALL 선택한 캐릭터의 Skill 또는 Burst를 1단계 강화한다(최대 3단계).
5. THE Progression_System SHALL 능력 강화 단계마다 피해 증가와 효과 확장(반경, 지속 시간 또는 추가 타격) 중 1가지 이상을 적용하고, 강화 화면에 변경 내용을 표시한다.
6. IF 강화에 필요한 Starmote 또는 Glim이 부족하면, THEN THE UI_System SHALL 강화 버튼을 비활성화하고 부족한 수량을 표시한다.

### Requirement 30: 장비, 전리품, 아이템 [P2]

**User Story:** 플레이어로서, 적은 수의 의미 있는 장비로 플레이 방식을 바꾸고 싶다. 그래서 수치 비교 대신 효과 선택을 즐길 수 있다.

#### Acceptance Criteria

1. THE Inventory_System SHALL 캐릭터 전용 Weapon 4종(캐릭터당 1종), Charm 6종, Relic 3종 이상을 제공하고, 각 장비에 다른 장비와 겹치지 않는 고유 효과를 부여한다.
2. THE Inventory_System SHALL Player_Character마다 Weapon 슬롯 1개와 Charm 슬롯 1개를, Party 공용 Relic 슬롯 1개를 제공한다.
3. WHEN 플레이어가 장비를 장착하거나 해제하면, THE Inventory_System SHALL 효과를 즉시 적용하고 장비 화면에 변경 전후 효과를 표시한다.
4. THE Inventory_System SHALL 소비 아이템을 허브 경단(HP 35% 회복)과 불씨 깃털(Downed 캐릭터 부활)의 2종으로 구성하고, 각 소비 아이템 보유 한도를 10개로 제한한다.
5. THE Loot_System SHALL 적, Chest, 퀘스트, Enemy_Camp 소탕에서 Glim, 소비 아이템, Starmote, 장비를 보상 표에 따라 지급한다.
6. WHEN 아이템을 획득하면, THE HUD SHALL 화면 측면에 아이템 이름, 아이콘, 수량을 3초 동안 표시하고, 동시에 최대 5개 항목을 표시한다.

### Requirement 31: UI 화면 [P1]

**User Story:** 플레이어로서, 게임 세계와 어울리는 화면에서 메뉴를 다루고 싶다. 그래서 기본 HTML 양식이 아닌 완성된 게임을 사용하는 느낌을 받는다.

#### Acceptance Criteria

1. THE UI_System SHALL Title Screen(New Game, Continue, Settings, Credits), Gameplay HUD, Pause, Settings, Map, Inventory/Equipment, Quest, Dialogue, Shop, Echo Altar, Defeat Screen, Victory Screen, Credits 화면을 제공한다.
2. THE UI_System SHALL 모든 화면에 게임 고유 시각 스타일(별빛 금색 테두리 장식 패널, 반투명 남색 배경, Element 아이콘 체계)을 적용한다.
3. WHILE 저장 데이터가 없는 동안, THE UI_System SHALL Title Screen의 Continue를 비활성 상태로 표시한다.
4. WHEN 저장 데이터가 있는 상태에서 New Game을 선택하면, THE UI_System SHALL 기존 저장 덮어쓰기 확인 창을 표시한다.
5. WHEN Esc를 누르면, THE UI_System SHALL Pause 메뉴(계속, 지도, 인벤토리/장비, 퀘스트, 속성 반응 도감, 설정, 끼임 해제, Title로)를 열고 게임 시간을 정지한다.
6. WHEN 메뉴를 열거나 닫으면, THE UI_System SHALL 0.15~0.3초의 전환 motion과 UI 효과음을 재생한다.
7. THE UI_System SHALL 모든 메뉴를 마우스, 키보드(방향키, Enter, Esc), 게임패드로 조작 가능하게 하고, 선택 항목에 시각 초점 표시를 한다.
8. WHEN 브라우저 탭이 비활성화되면, THE UI_System SHALL 자동으로 Pause 메뉴를 연다.
9. WHEN 게임플레이 중 캔버스를 클릭하면, THE Game SHALL pointer lock을 요청하고, pointer lock이 해제되면 조작 안내 문구("클릭하여 계속")를 표시한다.

### Requirement 32: HUD와 파티 UI [P1]

**User Story:** 플레이어로서, 화면을 가리지 않으면서 필요한 정보를 즉시 읽고 싶다. 그래서 세계와 전투에 시선을 둘 수 있다.

#### Acceptance Criteria

1. THE HUD SHALL Active_Character HP와 레벨, 파티 슬롯, Skill Cooldown, Burst Energy, Stamina, 현재 Objective, 상호작용 prompt, Compass, Skyshard 진행(n/3), 저장 표시기를 표시한다.
2. THE HUD SHALL 각 파티 슬롯에 캐릭터 portrait, Element 아이콘, HP 바, 교체 키 번호, Skill Cooldown 상태, Burst 준비 상태, Downed 표시를 표시한다.
3. WHILE In_Combat이 아닌 상태가 5초 이상 지속되는 동안, THE HUD SHALL Skill·Burst 아이콘과 파티 슬롯의 불투명도를 50%로 낮춘다.
4. THE HUD SHALL 탐험 중 HUD 요소가 차지하는 면적을 1920×1080 기준 화면 면적의 15% 이하로 유지한다.
5. WHILE 적이 피해를 받았거나 Lock-on 대상인 동안, THE HUD SHALL 해당 적 위에 HP 바, Element_Mark, Element_Shield 내구도를 표시하고, Elite에는 이름을 함께 표시한다.
6. WHILE Caelith 전투 중인 동안, THE HUD SHALL 화면 상단에 보스 이름, HP 바, Phase 구간 눈금, Starshell 내구도를 표시한다.
7. WHEN Burst Energy가 최대치가 되면, THE HUD SHALL Burst 아이콘에 발광 효과와 준비 효과음을 재생한다.

### Requirement 33: 지도와 Compass [P2]

**User Story:** 플레이어로서, 내가 발견한 세계를 지도에 기록하고 싶다. 그래서 탐험의 흔적을 보고 다음 목표를 계획할 수 있다.

#### Acceptance Criteria

1. WHEN 지도 입력(M)을 누르면, THE Map_System SHALL 플레이어 위치와 방향, 발견한 Region, Thistlewick, 발견한 Landmark, 활성 Waystone, 발견한 POI, 현재 Objective를 표시하는 지도 화면을 연다.
2. THE Map_System SHALL 방문하지 않았거나 Vista_Point로 공개하지 않은 지도 구역을 양피지 안개로 덮고, 미발견 POI를 표시하지 않는다.
3. WHEN 플레이어가 지도 구역을 방문하면, THE Map_System SHALL 반경 40m의 지도 안개를 제거하고 공개 상태를 저장한다.
4. THE Map_System SHALL 화면 상단 중앙에 화면 너비 40% 이하의 Compass를 표시하고, 방위, 현재 Objective 방향, 150m 이내 활성 Waystone, 발견한 대표 Landmark 방향을 표시한다.
5. THE Map_System SHALL 지도 화면에 Region별 Chest와 Echo_Tablet 발견 수를 표시한다.

### Requirement 34: 온보딩 [P1]

**User Story:** 플레이어로서, 외부 설명 없이 플레이하며 조작을 익히고 싶다. 그래서 첫 몇 분 안에 모든 핵심 조작을 자연스럽게 배운다.

#### Acceptance Criteria

1. THE Tutorial_System SHALL 이동, 카메라, 점프, 질주, 상호작용, 공격, Dodge, 캐릭터 교체, Skill, Burst, Reaction, 등반, 활강, 지도, Waystone, 장비, 능력 강화 안내를 각 조작이 처음 필요한 상황에서 표시한다.
2. THE World SHALL Normal_Play 시작 후 10분 안에 이동, 카메라, 점프, 공격, Dodge, 캐릭터 교체, Skill, Reaction, 등반, 활강을 사용해야 하는 상황을 배치한다.
3. THE Tutorial_System SHALL Tutorial_Hint를 한 번에 1개, 최대 2줄, 해당 키 아이콘과 함께 표시한다.
4. WHEN 안내된 조작을 플레이어가 수행하거나 8초가 지나면, THE Tutorial_System SHALL Tutorial_Hint를 닫고 해당 Hint를 완료 상태로 저장한다.
5. THE Tutorial_System SHALL 완료 상태로 저장된 Tutorial_Hint를 다시 표시하지 않고, Settings의 "조작 안내 보기" 화면에서만 다시 확인하게 한다.
6. WHEN Isla가 합류한 직후 첫 전투가 시작되면, THE World SHALL Kairen이 Ember Element_Mark를 부여하기 쉬운 적 배치를 제공하고, THE Tutorial_System SHALL Isla로 교체해 증기 폭발을 일으키도록 안내한다.

### Requirement 35: 조작, 입력, 한국어 텍스트, 접근성 [P1]

**User Story:** 플레이어로서, 익숙한 키보드·마우스 조작과 읽기 쉬운 한국어 화면으로 플레이하고 싶다. 그래서 조작과 정보 이해에 막힘이 없다.

#### Acceptance Criteria

1. THE Game SHALL 기본 키 배치를 WASD 이동, 마우스 카메라, Space 점프·활강, Shift 질주, Ctrl 걷기 토글, 좌클릭 공격(유지 시 Charged_Attack), 우클릭 Dodge, E Skill, Q Burst, 1~4 교체, F 상호작용, Z 회복 아이템, R Lock-on, C 등반·활강 이탈, M 지도, I 인벤토리/장비, J 퀘스트, Esc Pause로 제공한다.
2. WHERE 게임패드가 연결된 경우, THE Game SHALL 표준 배치(왼쪽 스틱 이동, 오른쪽 스틱 카메라, A 점프·활강, B Dodge, X 공격, Y 상호작용, RB Skill, RT Burst, LB 질주, D-pad 교체, Start Pause)로 게임플레이와 메뉴 조작을 지원한다.
3. THE Settings_System SHALL 키보드 키 재지정을 제공하고, 이미 사용 중인 키를 지정하면 두 동작의 키를 서로 맞바꾼다.
4. THE Game SHALL 대사, UI, Tutorial_Hint, 퀘스트, 메뉴 텍스트를 한국어로 표시하고, 고유명사(Skyshard, Astral Sanctum, Region, 캐릭터, Element, 적, 보스 이름)를 영어로 표시한다.
5. THE UI_System SHALL 한국어 텍스트를 시스템 폰트 스택(Malgun Gothic, Apple SD Gothic Neo, Noto Sans CJK KR, sans-serif)으로 렌더링한다.
6. THE UI_System SHALL UI 배율 80~130%에서 본문 텍스트를 1920×1080 기준 16px 이상으로 표시하고, 텍스트와 배경 패널의 명도 대비를 4.5:1 이상으로 유지한다.
7. THE UI_System SHALL Element, Reaction, 위험 표시를 색상과 함께 아이콘 형태 또는 텍스트로 구별한다.
8. THE Settings_System SHALL 마우스 감도, Y축 반전, 화면 흔들림 강도(0~100%), UI 배율 설정을 제공한다.

### Requirement 36: 저장과 불러오기 [P1]

**User Story:** 플레이어로서, 브라우저를 닫았다 열어도 모험을 이어가고 싶다. 그래서 진행을 잃을 걱정 없이 플레이할 수 있다.

#### Acceptance Criteria

1. THE Save_System SHALL 저장 데이터를 버전 번호가 포함된 형식으로 localStorage에 저장하고, 설정 데이터를 별도 키에 저장한다.
2. THE Save_System SHALL Main_Quest와 Side_Quest 진행, Skyshard, Party 합류 상태, 레벨·경험치, 능력 강화, 장비, 인벤토리, Glim, 발견 장소, 지도 공개 상태, 활성 Waystone, 개봉 Chest, 해결 퍼즐, 소탕 캠프, 처치 Elite, Echo_Tablet, Tutorial_Hint 완료 상태, 통계, 부활 지점, Debug_Tools 사용 여부를 저장한다.
3. WHEN Milestone(Objective 완료, Main_Quest 단계 완료, Skyshard 획득, Waystone 활성화, Chest 개봉, 퍼즐 해결, 레벨업, 장비 변경, Side_Quest 완료)이 발생하면, THE Save_System SHALL 2초 이내에 자동 저장을 수행한다.
4. WHILE In_Combat이 아닌 게임플레이가 진행되는 동안, THE Save_System SHALL 90초마다 자동 저장을 수행한다.
5. WHILE In_Combat인 동안, THE Save_System SHALL 자동 저장 요청을 보류하고 In_Combat 종료 후 2초 이내에 수행한다.
6. WHEN 저장이 수행되면, THE HUD SHALL 화면 모서리에 저장 표시기("저장 중…" 후 "저장됨")를 1.5초 동안 표시한다.
7. WHEN 저장이 수행되면, THE Save_System SHALL 직전의 정상 저장 데이터를 백업 키에 보존한다.
8. WHEN 플레이어가 Continue를 선택하면, THE Save_System SHALL 저장 데이터를 불러와 저장 시점의 진행 상태를 복원하고 Party를 마지막 부활 지점 또는 저장 위치에 배치한다.
9. THE Save_System SHALL 모든 유효한 게임 상태에 대해 직렬화 후 역직렬화한 상태를 원래 상태와 동일하게 복원한다(round-trip).
10. IF 저장 데이터가 JSON 파싱에 실패하거나 스키마 검증에 실패하면, THEN THE Save_System SHALL 백업 저장 데이터를 불러오고, 백업도 실패하면 손상 데이터를 별도 키에 보관한 뒤 "저장 데이터를 불러올 수 없습니다" 안내와 New Game 선택지를 표시한다.
11. IF 저장 데이터의 버전이 현재 버전보다 낮으면, THEN THE Save_System SHALL 정의된 변환 절차로 현재 버전 형식으로 변환하고, 변환 불가 시 손상 데이터와 같은 절차를 적용한다.
12. IF 저장 데이터에 범위를 벗어난 값(음수 수량, 존재하지 않는 ID, 최대치를 넘는 레벨)이 있으면, THEN THE Save_System SHALL 해당 필드를 허용 범위 또는 기본값으로 보정하고 게임을 실행한다.
13. IF localStorage 쓰기가 실패하면, THEN THE HUD SHALL "저장 실패" 표시를 3초 동안 표시하고 THE Game SHALL 게임플레이를 계속한다.

### Requirement 37: 오디오 [P2]

**User Story:** 플레이어로서, 지역과 상황에 맞는 음악과 명확한 효과음을 듣고 싶다. 그래서 세계의 분위기와 전투 결과를 소리로도 느낄 수 있다.

#### Acceptance Criteria

1. THE Audio_System SHALL Title/Thistlewick 음악, Region별 탐험 음악 3곡, 전투 음악, Caelith Phase별 보스 음악, Astral Sanctum 음악, Victory 음악을 Web Audio API 절차적 합성 또는 저장소에 포함된 CC0 음원으로 재생한다.
2. THE Audio_System SHALL Region별 환경음, 지면 재질별 발소리(풀, 흙, 돌, 나무, 물, 수정), 점프·착지·활강·등반음, 캐릭터별 공격음과 능력음, 피격음, Reaction별 효과음, 적 경고·공격·피격·사망음, UI 효과음, Chest 개봉음, 발견음, 레벨업음, Skyshard 획득음, Victory 음을 재생한다.
3. WHEN Region, In_Combat 상태 또는 보스 Phase가 바뀌면, THE Audio_System SHALL 1.5~3초 crossfade로 음악을 전환한다.
4. THE Audio_System SHALL Music과 SFX를 별도 버스로 처리하여, Music을 끄면 음악만, SFX를 끄면 효과음과 환경음만 무음으로 만든다.
5. THE Settings_System SHALL Music on/off와 볼륨, SFX on/off와 볼륨을 독립 설정으로 제공하고 설정 변경을 0.1초 이내에 적용한다.
6. WHEN 첫 사용자 입력(클릭 또는 키 입력)이 발생하면, THE Audio_System SHALL 오디오 컨텍스트를 시작하고, 첫 입력 전 Title Screen에 "클릭하거나 아무 키나 눌러 시작" 안내를 표시한다.
7. WHEN NPC 대사 창이 표시되면, THE Audio_System SHALL 화자별로 다른 음높이의 짧은 발화음을 재생한다.

### Requirement 38: 그래픽 설정과 성능 [P2]

**User Story:** 플레이어로서, 내 컴퓨터에서 안정적인 프레임으로 플레이하고 싶다. 그래서 끊김 없이 탐험과 전투를 즐길 수 있다.

#### Acceptance Criteria

1. THE Settings_System SHALL 품질 프리셋(낮음/보통/높음), render scale(50~100%), 그림자 품질(끔/낮음/높음), 식생 밀도(낮음/보통/높음), 후처리 on/off 설정을 제공한다.
2. WHEN 그래픽 설정이 바뀌면, THE Render_System SHALL 게임 재시작 없이 1초 이내에 설정을 적용하고, THE Settings_System SHALL 설정을 저장한다.
3. THE Render_System SHALL Default_Quality에서 프레임당 draw call 500회 이하, 렌더링 삼각형 150만 개 이하를 유지한다.
4. WHILE Default_Quality로 Dev_Machine의 1920×1080 화면에서 게임플레이하는 동안, THE Render_System SHALL 평균 60fps 이상을 유지한다.
5. THE Render_System SHALL 식생과 반복 소품을 instancing으로 렌더링하고, 거리 기반 culling과 LOD를 적용한다.
6. THE Combat_System SHALL projectile, 피해 숫자, 전투 VFX 객체를 재사용 풀로 관리한다.
7. WHEN 게임플레이 중 성능 측정용 표시(F3)를 켜면, THE Render_System SHALL fps, draw call, 삼각형 수를 화면 모서리에 표시한다.

### Requirement 39: 아트 디렉션, 애니메이션, 월드 연출 [P2]

**User Story:** 플레이어로서, 밝고 매력적인 고유의 anime fantasy 세계를 보고 싶다. 그래서 prototype이 아닌 하나의 완성된 세계로 느낄 수 있다.

#### Acceptance Criteria

1. THE Render_System SHALL 캐릭터, 적, 환경에 2~3단계 toon/cel shading, 캐릭터와 적의 외곽선, rim lighting, Region별 안개 색과 color grading을 적용한다.
2. THE Render_System SHALL Region별 색 팔레트(Verdant Reach: 따뜻한 초록과 황금빛, Ember Ravine: 녹슨 붉은색·숯색·주황 발광, Azure Highlands: 차가운 청색·흰 석재·보라빛 황혼, Astral Sanctum: 남색과 금색 별빛)를 적용한다.
3. THE Render_System SHALL 지형, 나무, 풀, 바위, 절벽, 물, 건축물, 폐허, 소품을 절차적 형태 변형, 재질, 배치, 조명으로 가공하여 가공하지 않은 기본 도형이 화면에 노출되지 않게 한다.
4. THE Render_System SHALL Region별 ambient VFX(Verdant Reach: 꽃잎과 반딧불, Ember Ravine: 불씨와 재, Azure Highlands: 구름 안개와 빛 입자), 흔들리는 풀과 나무, 물 표면 움직임, 환경 생물(새 또는 나비)을 표시한다.
5. WHEN Player_Character가 풀 사이를 지나가면, THE Render_System SHALL 캐릭터 주변 1m 안의 풀을 캐릭터 이동 방향으로 휘게 표시한다.
6. THE Animation_System SHALL Player_Character에 idle, run, sprint, jump, fall, land, attack(캐릭터별), skill, burst, dodge, hurt, downed, climb, climb leap, mantle, glide, swim 상태를 제공한다.
7. THE Animation_System SHALL 적에 idle, move, attack 준비, attack, hurt, stagger, defeat 상태를, Caelith에 Phase별 공격, 전환, 무력화, 사망 상태를 제공한다.
8. THE Animation_System SHALL 애니메이션 상태 전환을 0.1~0.25초 blend로 연결한다.
9. THE Render_System SHALL 동적 그림자 또는 blob shadow로 Player_Character와 적의 지면 위치를 표시한다.

### Requirement 40: 에셋 출처와 독창성 [P2]

**User Story:** 개발자로서, 라이선스가 명확한 에셋만 사용하고 고유한 캐릭터를 유지하고 싶다. 그래서 결과물을 안심하고 배포할 수 있다.

#### Acceptance Criteria

1. THE Asset_Pipeline SHALL 기본 제공 빌드에 포함하는 외부 에셋을 CC0 라이선스가 명시된 출처에서만 반입하고 저장소 안에 포함한다.
2. THE Asset_Pipeline SHALL 반입한 모든 외부 에셋의 이름, 제작자, 출처 URL, 라이선스, 저장소 내 경로를 `CREDITS.md`에 기록하고, 사용한 라이브러리와 라이선스를 함께 기록한다.
3. THE UI_System SHALL Title Screen의 Credits 화면에 `CREDITS.md`와 같은 출처 정보를 표시한다.
4. THE Asset_Pipeline SHALL 기본 제공 Player_Character, 적, Elite, Caelith 모델을 외부 에셋 없이 자체 절차적 생성 또는 직접 작성한 형태로 제작하고, 이후 외부 모델 교체는 Requirement 43의 구조로 수행한다.
5. WHEN 외부 모델을 불러오면, THE Asset_Pipeline SHALL 모델 재질을 게임의 toon 재질과 Region 색 팔레트로 교체한다.
6. IF 외부 에셋 다운로드가 실패하거나 스타일에 맞지 않으면, THEN THE Asset_Pipeline SHALL 해당 에셋을 절차적 생성 모델 또는 Web Audio 합성 음향으로 대체한다.
7. THE Game SHALL 기존 게임의 캐릭터, 세계관, 지명, 스토리, UI 구조, 아이콘, 음악, 몬스터, 능력명, 원소 명칭, 퀘스트, 지도, 건축물, 대사를 복제하지 않은 고유 콘텐츠로 구성한다.

### Requirement 41: Debug_Tools [P2]

**User Story:** 개발자로서, 검증 중 특정 상황을 빠르게 재현하고 싶다. 그래서 문제를 효율적으로 확인하되 정상 플레이 검증과 구분할 수 있다.

#### Acceptance Criteria

1. WHERE URL에 `?debug=1` 매개변수가 있는 경우, THE Debug_Tools SHALL 무적, 캐릭터 합류, Glim 지급, Skyshard 지급, 지점 이동, 보스 직행, 적 AI 상태 표시 기능을 "DEBUG" 표시가 붙은 별도 패널로 제공한다.
2. WHILE `?debug=1` 매개변수가 없는 동안, THE Debug_Tools SHALL 디버그 패널과 디버그 단축키를 비활성 상태로 유지한다.
3. WHEN Debug_Tools 기능이 한 번이라도 사용되면, THE Save_System SHALL 세션과 저장 데이터에 Debug_Tools 사용 여부를 기록하고, THE HUD SHALL 화면 모서리에 "DEBUG" 표시를 유지한다.
4. THE Game SHALL 메인 진행의 모든 단계를 Debug_Tools 없이 완료할 수 있게 구성한다.

### Requirement 42: 자동 검증, 플레이 검증, 최종 보고 [P1]

**User Story:** 사용자로서, 실제 실행으로 확인된 완성 게임을 받고 싶다. 그래서 보고된 내용이 실제 동작과 일치함을 신뢰할 수 있다.

#### Acceptance Criteria

1. THE Verification_Suite SHALL Vitest 단위 테스트로 Reaction 판정(표 B 6조합, 같은 Element 갱신, 확산과 Reaction_Chain, Element_Shield 배율), 피해 계산, Energy·Cooldown, Stamina 상태 전이, Main_Quest 전이, 저장 round-trip, 손상·구버전·범위 초과 저장 데이터 처리를 검증한다.
2. THE Test_Harness SHALL 자동 테스트에 Active_Character, 위치, HP, Stamina, 이동 상태, Objective, Skyshard 수, Boss Phase, 최근 Reaction 기록을 읽기 전용으로 제공하고, 게임 상태 변경 기능을 제공하지 않는다.
3. THE Verification_Suite SHALL Playwright 테스트로 Title → New Game → Thistlewick → Verdant Reach 이동 → 일반 적 전투 → 캐릭터 교체 → Reaction → 등반 → 활강 → Hollowroot Shrine → Skyshard 1 → Ember Ravine → Skyshard 2 → Azure Highlands → Skyshard 3 → Astral Sanctum 해금 → 최종 지역 진입 → Caelith Phase 1 → Phase 2 → Final Phase → 처치 → Victory Screen 경로를 키보드·마우스 입력 이벤트만으로 1회 이상 완주한다.
4. IF 플레이 검증 실행 중 Debug_Tools가 사용되면, THEN THE Verification_Suite SHALL 해당 실행을 정상 플레이 검증 실패로 판정한다.
5. THE Verification_Suite SHALL 이동(평지, 경사, 점프, 낙하, 절벽, 좁은 공간), 등반(시작, 이동, Stamina, 올라서기, 이탈), 활강(전개, 낙하 감소, Stamina, 착지), 전투(공격, 능력, Dodge, 적 공격, 피해, 사망), 파티(교체, 캐릭터별 공격과 능력, HP), 저장(저장, 새로고침, Continue, 복원), UI(Pause, Map, Inventory, Settings, Music/SFX 독립 설정)를 브라우저에서 검증한다.
6. WHILE Playwright 플레이 검증이 실행되는 동안, THE Verification_Suite SHALL 콘솔 error, 처리되지 않은 예외, 외부 도메인 네트워크 요청을 기록하고 각 항목 0건을 통과 조건으로 사용한다.
7. THE Verification_Suite SHALL 시작 마을, 첫 Region 전경, 높은 곳 활강, 등반, 2명 이상 교체 전투, Reaction, Enemy_Camp, 세 Challenge_Area, 세 번째 Region, Astral Sanctum, Caelith, Victory Screen의 스크린샷을 저장한다.
8. WHEN 스크린샷 검토에서 빈 지형, 기본 도형 나열, 구별되지 않는 캐릭터, 반복 오브젝트, Landmark 없는 Region, 기본 HTML 스타일 UI, VFX로 판독 불가능한 전투, 지형을 통과한 카메라가 발견되면, THE Verification_Suite SHALL 해당 항목을 결함으로 기록하고 콘텐츠 추가보다 먼저 수정 대상으로 지정한다.
9. IF 실행 환경 문제(브라우저 미설치, WebGL 미지원)로 Playwright 검증을 실행하지 못하면, THEN THE Final_Report SHALL 실행하지 못한 검증 항목과 원인을 명시한다.
10. THE Final_Report SHALL 구현한 주요 시스템, 자율 추가 기능과 연출, 실행 방법, 기본 조작, 실제 실행으로 검증한 플레이 경로, 남은 제한 사항을 포함하고, 실행하지 않은 검증을 검증 완료로 표기하지 않는다.

### Requirement 43: 시각 모델 교체 구조 [P2]

**User Story:** 개발자로서, 캐릭터·적·보스의 기본 절차적 모델을 나중에 FBX, VRM, glTF 모델로 쉽게 바꾸고 싶다. 그래서 게임 규칙이나 코드를 고치지 않고 외형만 교체할 수 있다.

#### Acceptance Criteria

1. THE Asset_Pipeline SHALL Player_Character, 적, Elite, Caelith, 이름 있는 NPC의 시각 모델을 Visual_Manifest 항목으로 지정하고, 항목이 없거나 기본값이면 자체 절차적 모델을 사용한다.
2. WHEN Visual_Manifest 항목의 소스를 glTF/GLB, FBX 또는 VRM 파일로 바꾸면, THE Render_System SHALL 게임 코드 수정 없이 해당 엔티티를 외부 모델로 표시한다.
3. THE Game SHALL 시각 모델 교체와 관계없이 충돌체, 이동 수치, 공격 판정 시점과 범위, 퀘스트·전투 규칙을 동일하게 유지한다.
4. THE Animation_System SHALL 포즈 클립을 Humanoid_Skeleton 기준으로 정의하고, 외부 humanoid 모델에는 bone 대응표와 휴지 자세(rest pose) 보정으로 retarget하여 재생한다.
5. WHERE 외부 모델이 자체 애니메이션 clip을 포함하는 경우, THE Animation_System SHALL Visual_Manifest의 clip 대응표에 따라 해당 clip을 공통 애니메이션 상태에 연결하고, 대응이 없는 상태에는 Humanoid_Skeleton 포즈 클립 retarget 또는 절차적 루트 애니메이션을 사용한다.
6. WHEN 외부 모델을 불러오면, THE Asset_Pipeline SHALL 모델 높이와 정면 방향을 Visual_Manifest 값으로 맞추고, 무기·장비 socket을 지정 bone에 연결하며, 설정에 따라 재질을 게임 toon 재질로 바꾸거나 원본 재질을 유지한다.
7. IF 외부 모델 파일을 불러오지 못하거나 필수 humanoid bone이 없으면, THEN THE Asset_Pipeline SHALL 경고를 1회 기록하고 해당 엔티티를 기본 절차적 모델로 표시한다.
8. WHEN 외부 모델이 게임 시작 후 불러와지면, THE Render_System SHALL 게임플레이를 멈추지 않고 해당 엔티티의 모델과 파티 portrait를 교체한다.
9. WHERE 교체용 외부 모델을 추가하는 경우, THE Asset_Pipeline SHALL 모델 이름, 제작자, 출처, 라이선스를 CREDITS.md에 기록한다.
10. THE Verification_Suite SHALL 절차적 모델을 glTF와 VRM 형식으로 내보낸 검증용 파일을 교체 경로로 불러와 표시, retarget, 대체 동작을 브라우저에서 검증하고, FBX 경로는 CC0 샘플 파일로 검증하며 샘플을 구하지 못하면 Final_Report에 미검증으로 명시한다.
