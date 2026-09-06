# 아키텍처 (Architecture)

> 이 문서는 **코드를 고치려는 사람**을 위한 것입니다.
> 수업에서 쓰는 방법은 [README.md](README.md) 를 보세요.

빌드 도구·패키지 매니저·트랜스파일러가 없는 **순수 정적 웹앱**입니다.
`index.html` 이 CSS·JS 를 순서대로 불러오고, 각 JS 파일은 IIFE 로 감싸져
`window.App.<모듈명>` 에 공개 API 만 등록합니다.

---

## 개발용 실행

```bash
# 프로젝트 루트에서 — 정적 서버면 무엇이든 됩니다
python -m http.server 8000     # → http://localhost:8000
npx serve .
```

`index.html` 을 더블클릭해 `file://` 로 열어도 대부분 동작하지만,
**비유 모드의 물리 엔진(Cannon-es)** 은 ES 모듈 CDN import 라 로드되지 않을 수 있습니다.
그 경우 `AnalogyRenderer` 가 동일한 적분식으로 **자동 폴백**하므로 기능은 유지됩니다.

### 외부 의존성 (CDN, 설치 불필요)

- [KaTeX 0.16.9](https://katex.org/) — 과도 응답 그래프의 수식 레이블
- [Three.js r128](https://threejs.org/) — 비유 모드 3D 렌더링
- [Cannon-es 0.20.0](https://pmndrs.github.io/cannon-es/) — 비유 모드 물리 시뮬레이션 (선택적)

### 물리 검증 테스트

```bash
node tests/run-tests.js
```

솔버·토폴로지·과도응답을 브라우저 없이(Node vm) 로드해, 해석해(옴 법칙·복소
임피던스·KCL/KVL·전력 보존·`τ=L/R`,`RC`·RLC 부족/임계/과감쇠 `α=R/2L`,`ω_d`)와
수치 대조하는 36개 시나리오(174 검증)를 실행합니다. 기대값은 솔버와 무관한 닫힌형
공식으로만 작성되어 있습니다. **솔버를 고쳤다면 반드시 실행하세요.**

### 화면 표시 검증 (헤드리스 Chrome)

```bash
npm i --no-save puppeteer-core        # 1회
python -m http.server 8123            # 다른 터미널
node tests/browser/run.js
```

실제 페이지를 띄워 **사용자에게 보이는 값**을 검증합니다 — 속성 패널의
전류·전압·전력·`Q=CV`·`Φ=LI`·AC 피크/실효값/임피던스/유효전력·혼합(DC+AC) 실효값,
실행 모드의 전자 이동 방향(관례 전류의 반대)과 입자 밀도(전류 비례),
비유 모드 HUD 의 τ. 렌더러·패널을 고쳤다면 이것도 실행하세요.
(`CHROME_PATH`, `APP_URL` 환경변수로 크롬 경로·주소 변경 가능)

---

## 디렉토리 구조

```
circuit_simulation/
├── index.html                     # 마크업 + 자원 로드 순서 정의 (로직 없음)
├── README.md                      # 학생·교사용 사용 설명서
├── ARCHITECTURE.md                # 이 문서
├── Design_Suneung_Comparison.md   # 수능 지면 규격 대조표
├── docs/images/                   # README 스크린샷
├── tests/run-tests.js             # 물리 검증 (Node, 브라우저 불필요)
└── src/
    ├── styles/                    # CSS — 링크 순서 = 캐스케이드 순서
    │   ├── tokens.css             # 디자인 토큰 (CSS Custom Properties)
    │   ├── base.css               # 리셋 & 기본 레이아웃
    │   ├── sidebar.css            # 사이드바 (소자 팔레트)
    │   ├── canvas.css             # 캔버스 3레이어 · 드래그 고스트 · 삭제존
    │   ├── mode-bar.css           # 모드 바 (편집/실행/비유/촬영)
    │   ├── toolbar.css            # Undo/Redo · 표시 토글 바
    │   ├── prop-panel.css         # 속성 패널
    │   ├── transient-panel.css    # 과도 응답 그래프 패널
    │   ├── val-popup.css          # 값 입력 팝업
    │   ├── context-menu.css       # 우클릭 컨텍스트 메뉴
    │   ├── overlays.css           # 토스트 · 연결 힌트 · 정보 오버레이
    │   └── responsive.css         # 반응형 (⚠️ 반드시 마지막에 로드)
    └── js/
        ├── core/
        │   ├── constants.js       # 전역 상수 · 소자 정의 테이블 (유일한 전역 노출)
        │   ├── namespace.js       # window.App = {}
        │   ├── events.js          # App.Events — 경량 이벤트 버스
        │   └── state.js           # App.State — 단일 상태 저장소 + Undo/Redo
        ├── geometry/
        │   └── geo.js             # App.Geo — 좌표 변환 · 포트 위치 · 도선 경로
        ├── circuit/
        │   ├── topology.js        # App.Topology — Union-Find 노드 병합
        │   └── solver.js          # App.Solver — 통합 복소 MNA 해석 (DC·AC·혼합 중첩)
        ├── render/
        │   ├── svg-shapes.js      # App.SN — 수능 지면 규격 토큰 + Canvas2D→SVG 기록기
        │   ├── symbols.js         # App.Symbols — 소자 심볼 드로잉 (Canvas / Recorder 공용)
        │   ├── grid-renderer.js   # App.GridRenderer — 격자 배경 (canvas-bg)
        │   ├── edit-renderer.js   # App.EditRenderer — 편집 모드 (canvas-main)
        │   ├── run-renderer.js    # App.RunRenderer — 전자 이동 애니메이션 (canvas-anim)
        │   ├── analogy-renderer.js# App.AnalogyRenderer — 수로 비유 3D
        │   └── capture.js         # App.Capture — 선화 내보내기 (촬영 PNG · SVG 직렬화 겸용)
        ├── ui/
        │   ├── interaction.js     # App.Interaction — 포인터 제스처 FSM · 키보드
        │   ├── transient-graph.js # App.TransientGraph — 과도 응답 그래프
        │   ├── val-popup.js       # App.ValPopup — 값 입력 팝업
        │   ├── prop-panel.js      # App.PropPanel — 속성 패널
        │   └── toast.js           # window.showErrorToast — 전역 에러 토스트
        └── main.js                # App.Main — 부트스트랩 & 모드 오케스트레이션
```

---

## 모듈 구조

### 모듈 시스템

번들러 없이 **클래식 `<script>` 태그**로 순차 로드합니다. 각 파일은 IIFE 로 감싸져
전역을 오염시키지 않으며, 공개 API 만 `window.App.<모듈명>` 에 등록합니다.

```js
(function(){
'use strict';
var App = window.App;

App.MyModule = (function(){
  var _private = 1;                 // 외부에서 접근 불가
  function doThing(){ /* ... */ }
  return { doThing: doThing };      // 공개 API
})();

}());
```

예외는 `core/constants.js` 하나뿐으로, `TYPE`·`CELL_SIZE`·`SIDEBAR_ITEMS` 등
튜닝 상수를 의도적으로 전역에 노출합니다.

> ⚠️ **로드 순서를 바꾸지 마세요.** `index.html` 의 `<script>` 나열 순서가 곧
> `App.*` 등록 순서입니다. 예를 들어 `state.js` 가 `events.js` 보다 먼저 실행되면
> 초기화 시점에 `App.Events` 가 없습니다.

### 의존 계층

```
        core/constants.js  (전역 상수)
                 │
        core/namespace.js  (window.App)
                 │
   ┌─────────────┴──────────────┐
core/events.js            core/state.js ──── geometry/geo.js
   │                             │                  │
   │              ┌──────────────┴──────────────┐   │
   │        circuit/topology.js ──────► circuit/solver.js
   │                                            │
   ├──► render/*   (Symbols · Grid · Edit · Run · Analogy)
   ├──► ui/*       (Interaction · TransientGraph · ValPopup · PropPanel · toast)
   └──► main.js    (부트스트랩 · 모드 FSM · 이벤트 배선)
```

### 이벤트 흐름

모듈 간 직접 호출 대신 `App.Events` 버스를 통해 느슨하게 결합합니다.

```
사용자 입력 (Interaction)
        │
        ▼
App.State 변경  ──emit──►  'state:changed'
                                │
                                ├─► App.Solver.run()   (requestIdleCallback 디바운스)
                                │        │
                                │        └──emit──► 'solver:done'
                                │                        │
                                │                        ├─► App.PropPanel.refresh()
                                │                        ├─► App.EditRenderer.scheduleRender()
                                │                        └─► App.RunRenderer / TransientGraph
                                └─► App.EditRenderer.scheduleRender()

뷰포트 변경 (팬·줌) ──emit──► 'viewport:changed' ──► GridRenderer.render()
```

| 토픽 | 발행 시점 |
| --- | --- |
| `state:changed` | 소자·도선 추가/삭제/이동/값 변경, Undo/Redo |
| `solver:done` | MNA 해석 완료 (성공·실패 모두) |
| `viewport:changed` | 팬·줌으로 `viewTransform` 이 바뀜 |
| `component:placed` | 사이드바에서 새 소자 배치 완료 — 모바일 사이드바 자동 닫힘 |

### 회로 해석 파이프라인

1. **`Topology.build(comps, wires)`**
   `(소자, 포트)` 쌍마다 슬롯을 부여하고, 도선으로 이어진 슬롯을 Union-Find 로 병합해
   전기적으로 동일한 노드에 같은 번호를 부여합니다 (접지=전원 음극 노드를 0으로 선지정).
   결과: `{ nodeCount, groundNode, compNodes, portNode, hasAC, hasDC }`
2. **`Solver.solve(comps, wires)`** (순수 함수 — `run()` 은 이를 디바운스 호출)
   단일 복소 MNA 코어로 최대 두 패스를 풉니다.
   - **DC 패스 (ω=0)**: 인덕터=단락(`SMALL_R`), 커패시터=개방, AC 전원=0V(이상 전원=단락)
   - **AC 패스 (ω>0)**: `Y_L=−j/ωL`, `Y_C=jωC`, DC 전원=0V
   - **혼합**: 두 패스를 중첩 — 표시값은 피크 `|I_dc|+|I_ac|`, 순시값은 `acPhasor.instCurrent()`
   - 도선 전류는 정션 KCL 필링(비결정 병렬 이상도체는 균등 분배)으로 결정적으로 계산
   결과는 `App.State.solverResult` 에 저장되고 `solver:done` 이 발행됩니다.

```js
// solverResult 구조
{
  nodeVoltages:      { 0: 0, 1: 12, 2: 9.209302 },
  portVoltages:      { compId: { L: …, R: … } },
  componentVoltages: { compId: … },
  branchCurrents:    { compId: … },
  valid: true,
  error: null
}
```

### 캔버스 레이어

| 레이어 | z-index | 담당 모듈 | 갱신 시점 |
| --- | --- | --- | --- |
| `#canvas-bg` | 1 | `GridRenderer` | 뷰포트 변화 시에만 |
| `#canvas-main` | 2 | `EditRenderer` / `AnalogyRenderer` | rAF 디바운스 |
| `#canvas-anim` | 3 | `RunRenderer` | 실행 모드에서 매 프레임 |

### 좌표계

| 좌표계 | 설명 |
| --- | --- |
| `grid` | 논리 좌표 (정수 칸). 소자 위치·인접 판정 기준 |
| `pixel` | 화면 좌표. `pixel = grid × CELL_SIZE × scale + offset` |

포트 방향 벡터는 `rotation = 0` 로컬 기준으로 `L`(좌) `R`(우) `T`(상) `B`(하) 입니다.

> ⚠️ 포트 이름은 **단자 식별자**이며 회전해도 바뀌지 않습니다. 회전은
> `Geo.getPortPixel()` 이 `rotation` 을 읽어 시각적 위치만 바꿉니다.
> 도선의 `fromPort`/`toPort` 를 회전에 맞춰 고치면 토폴로지가 깨집니다.

### 상태 변경 규약

`App.State` 는 유일한 진실 공급원(single source of truth)입니다.
직접 필드를 건드리지 말고 반드시 메서드를 사용하세요.

```js
App.State.addComponent(comp);         // ✅ 내부에서 _mutate → 스냅샷 → emit
App.State.components.push(comp);      // ❌ Undo 히스토리·렌더 갱신 누락
```

새 뮤테이션 메서드를 추가할 때는 `_mutate(fn)` 으로 감싸면
`_beginAction()` → 변경 → `_endAction()`(스냅샷) → `emit('state:changed')` 가
자동으로 처리됩니다.

---

## 확장 가이드

### 새 소자 타입 추가

1. **`src/js/core/constants.js`**
   - `TYPE` 열거형에 항목 추가
   - `SIDEBAR_ITEMS` 에 팔레트 항목 추가 (`defValue`, `defValue2`, `shortUnit`)
   - `COMP_PORTS` 에 포트 문자열 정의 (예: `'LR'`)
   - 다중 연결이 필요하면 `MULTI_PORT_TYPES` 에 등록
2. **`src/js/render/symbols.js`** — 심볼 드로잉 함수 추가.
   `(cx, cy)` 중심, `r = size/2` 반지름 규약을 따르고 `draw()` 의 분기에 연결.
   `ctx` 는 Canvas 컨텍스트일 수도, `App.SN.Recorder`(SVG 내보내기)일 수도 있으므로
   **경로 API 만** 사용하세요 (`measureText`·`shadowBlur` 등은 기록기에 없습니다).
   그러면 촬영(PNG·SVG)은 별도 작업 없이 자동으로 지원됩니다.
3. **`src/js/circuit/solver.js`** — MNA 스탬프(stamp) 추가.
   DC 경로와 AC 경로 양쪽 모두 처리
4. **`src/js/ui/prop-panel.js`** — `FIELDS` 테이블에 편집 가능한 물리량 정의

### 새 스타일 파일 추가

`src/styles/` 에 파일을 만들고 `index.html` 의 `<link>` 목록에 추가하되,
**`responsive.css` 보다 앞에** 두어야 미디어 쿼리 오버라이드가 정상 동작합니다.

### 새 JS 모듈 추가

IIFE 래퍼 규약을 지키고 `index.html` 의 `<script>` 목록에서
**의존 대상보다 뒤에** 배치하세요.

---

## 코딩 컨벤션

- **ES5 문법 기준** — 트랜스파일 없이 넓은 브라우저 호환성을 유지합니다
  (`var`, `function`, IIFE). 일부 축약 객체 리터럴만 예외적으로 사용
- 모든 파일 상단에 `'use strict';`
- 내부 전용 식별자는 `_` 접두사 (`_private`, `_render`)
- 주석은 한국어. 모듈 헤더에 설계 의도·좌표 규약·주의사항을 명시

---

## 참고

- 이 프로젝트는 원래 단일 `index.html`(약 7,900줄) 이었으며, 동작을 그대로 유지한 채
  위 디렉토리 구조로 분리되었습니다. CSS 캐스케이드 순서와 JS 실행 순서는
  원본과 동일하게 보존되어 있습니다.
- 헤드리스 브라우저 검증 결과 분리 전후의 렌더 DOM, 캔버스 픽셀,
  MNA 해석 결과가 모두 일치합니다.
- 분리 이후 유일한 동작 변경: 모바일에서 소자 배치 시 사이드바가 자동으로 닫히도록
  `main.js` 의 `_place()` 에 `component:placed` 발행을 추가했습니다.
  (구독 코드는 원래 있었으나 발행부가 누락되어 있던 문제)
