# 아키텍처 (Architecture)

> 이 문서는 **코드를 고치려는 사람**을 위한 것입니다.
> 수업에서 쓰는 방법은 [README.md](README.md) 를 보세요.
> 엔진 v2 의 설계 배경과 로드맵은 설계서(회로 엔진 v2 설계서, 세션 아티팩트)에 있습니다.

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

회로 해석 엔진 전체를 브라우저 없이(Node vm) 로드해, 해석해(옴 법칙·복소 임피던스·
KCL/KVL·전력 보존·RC/RL 시상수·RLC 부족/임계/과감쇠 극점·다이오드 Shockley·BJT 세 동작
영역·RTL/DL 논리 게이트 진리표·반파 정류 평균·혼합 DC+AC 시간 영역 = 페이저)와
수치 대조하는 **51개 시나리오(277 검증)** 를 실행합니다. 기대값은 솔버와 무관한
닫힌형 공식으로만 작성되어 있습니다. **엔진을 고쳤다면 반드시 실행하세요.**

### 화면 표시 검증 (헤드리스 Chrome)

```bash
npm i --no-save puppeteer-core        # 1회
python -m http.server 8123            # 다른 터미널
node tests/browser/run.js
```

실제 페이지를 띄워 **사용자에게 보이는 값**을 검증합니다 (**94건**) — 속성 패널의
전류·전압·전력·`Q=CV`·`Φ=LI`·AC 피크/실효값/임피던스/유효전력·혼합 실효값, 실행 모드의
전자 이동 방향(관례 전류의 반대)과 밀도·과도 재생, 자동 스위치와 '열림/닫으면' 두 열,
회로이론 표기, 그룹 선택 팝업, 전구 광량, 다이오드·BJT 패널, 오실로스코프, 그래프
시간 커서, 비유 HUD τ, POE 예제 8종과 진리표, 공유 링크 왕복, 전위 지형, 전하 카운터,
실행 모드 스위치 토글. 렌더러·패널을 고쳤다면 이것도 실행하세요.
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
├── tests/browser/                 # 화면 표시 검증 (puppeteer-core)
└── src/
    ├── styles/                    # CSS — 링크 순서 = 캐스케이드 순서 (responsive 가 마지막)
    └── js/
        ├── core/
        │   ├── constants.js       # TYPE·NODE_TYPES·NONLINEAR_TYPES·SIDEBAR_ITEMS(그룹)·COMP_PORTS
        │   ├── namespace.js       # window.App = {}
        │   ├── events.js          # App.Events — 경량 이벤트 버스
        │   ├── state.js           # App.State — 단일 상태 저장소 + Undo/Redo (자동 스위치 삭제 규칙)
        │   └── share.js           # App.Share — 회로 ↔ URL 해시 (#c=…)
        ├── geometry/geo.js        # App.Geo — 좌표 변환 · 포트 위치 · 도선 경로
        ├── circuit/               # ★ 회로 해석 엔진 v2 (아래 절)
        │   ├── netlist.js         # 그림 → 회로망 (노드 병합·스위치·접지·레일·섬)
        │   ├── mna.js             # MNA 행렬 코어 (실수·복소 가우스 소거)
        │   ├── devices/           # 소자 스탬프: index(레지스트리)·resistor·capacitor·inductor
        │   │                      #   ·vsource·bulb·diode·bjt
        │   ├── analysis/          # op(동작점, NR) · ac(소신호) · tran(시간 영역) · poles(극점)
        │   ├── post/              # wires(도선 전류 KCL 필링) · result(뷰·파형·표시 규약)
        │   └── solver.js          # 오케스트레이터 (열림/닫힘 두 상태, 파형 여부·구간 결정)
        ├── render/
        │   ├── svg-shapes.js      # App.SN — 수능 지면 규격 토큰 + Canvas2D→SVG 기록기
        │   ├── symbols.js         # 소자 심볼 (스위치 열림/닫힘·접지·라벨·전구·다이오드·BJT 포함)
        │   ├── grid-renderer.js   # 격자 배경
        │   ├── edit-renderer.js   # 편집 모드 (전구 광량·전위 지형·전후 비교 배지)
        │   ├── run-renderer.js    # 전자 애니메이션 (파형 재생·전하 카운터)
        │   ├── analogy-renderer.js# 수로 비유 3D (파형 표본화)
        │   └── capture.js         # 선화 내보내기 (촬영 PNG)
        ├── ui/
        │   ├── interaction.js     # 포인터 제스처 · 키보드 · 실행 모드 스위치 토글
        │   ├── transient-graph.js # 과도 응답 그래프 (엔진 파형·극점 위의 뷰 + 시간 커서)
        │   ├── scope.js           # 오실로스코프 (교류·정류·비선형 v(t)·i(t))
        │   ├── poe.js             # 예측·관찰·설명 활동, 진리표, 결과 CSV
        │   ├── val-popup.js       # 값 입력 팝업
        │   ├── prop-panel.js      # 속성 패널 (열림/닫으면 두 열, 파형 통계)
        │   └── toast.js           # 전역 토스트
        └── main.js                # 부트스트랩 · 모드 FSM · 사이드바(그룹 선택) · 자동 스위치
```

---

## 회로 해석 엔진 v2

### 흐름

```
그림 (comps · wires · 라벨)
   │  netlist.build(comps, wires, {closed})
   ▼
Netlist  { nodeCount, compNodes, portNode, passthrough(닫힌 스위치), islands, warnings }
   │  Devices.createAll(nl)  → 소자 객체 (스탬프 인터페이스)
   ▼
analysis/op  ──► x (동작점)            선형: 1회, 비선형: Newton-Raphson
analysis/ac  ──► 페이저 (AC 전원 있을 때, 동작점 주위 소신호)
analysis/poles ► 극점 (선형·동적 소자 있을 때)  τ·α·ω_d 정확값
analysis/tran ─► 파형 (동적 소자 또는 비선형+AC — 닫힘 상태에서만)
   │  post/wires (도선 전류 KCL 필링) · post/result (뷰 조립)
   ▼
Result = 뷰 + { open, closed, hasSwitches, switchesClosed }
```

`App.Solver.solve(comps, wires, opts)` 는 순수 함수입니다 (테스트가 그대로 호출).
`opts.closed` 가 최상위 뷰의 상태를, `opts.noWave` 가 파형 생략을 정합니다.
앱에서는 `solveNow()` 가 **편집 모드 = 열림, 실행·비유 모드 = 닫힘**으로 고릅니다.

### Netlist 병합 규칙

1. 도선으로 이어진 포트끼리   2. 분기점(J3·J4)의 모든 포트
3. 접지(GROUND) 전부 → 노드 0   4. 같은 이름의 레일 라벨(LABEL)끼리
5. 스위치: `Netlist.switchClosed(comp, closed)` 이면 양 포트 병합 (`passthrough`)
   — `comp.on` 이 `undefined` 면 자동(편집 열림 · 실행 닫힘), `true` 면 닫힘 유지, `false` 면 열림 유지.
   자동 스위치가 하나라도 있어야 `Result.open/closed` 두 뷰가 달라진다 (`hasSwitches`).

레일 라벨의 `value`(전위)가 0 이 아니면 그 라벨은 **접지 기준 이상 직류 전원**이다
(`nl.railSource` — 같은 이름은 한 노드이므로 이름당 첫 라벨만 스탬프, `devices/vsource.js` 의 LABEL 팩토리).
접지가 없으면 오류 `레일 전위를 쓰려면 접지(GND)가 있어야 합니다`.

기준 노드는 접지가 있으면 접지, 없으면 마지막 전원의 음극입니다.
열린 회로는 오류가 아닙니다 — 전원과 이어지지 않은 섬, 짝 없는 라벨은 `warnings`.
오류는 물리적으로 해가 없는 경우뿐: `전원이 없습니다`, `단락 회로가 감지되었습니다`,
`서로 다른 전압의 전원이 병렬…`, `주파수가 서로 다른 교류 전원…`, `해가 수렴하지 않습니다`.

### 상호유도 (결합 인덕터)

인덕터 `comp.couple` 이 짝 인덕터의 id 이고 짝도 이쪽을 가리키면 결합 쌍이다 (`Netlist.couplesOf`,
`comp.value2` = 결합 계수 k, 0.999 로 상한 — k=1 은 인덕턴스 행렬이 특이). `Devices.createAll` 이 두 소자에
`partner` 와 `M = k√(L₁L₂)` 을 달고, `devices/inductor.js` 가 자기 행에 상호 항을 찍는다:
교류 `−jωM·i_p`, 시간 영역 `−R_M·i_p` (R_M = 2M/h, 후진 오일러는 M/h) + 우변 `−R_M·i_p(n−1)`.
동작점(직류 정상상태)에는 상호 항이 없다. 극점은 `[L]·di/dt = v` 를 풀어 상태식을 만든다.

2차 회로는 도선으로는 전원 없는 섬이지만 결합을 통해 살아 있다 — 섬의 `hasSource` 를 결합 쌍을 따라
전파하고, **접지 노드가 없는 섬마다 노드 하나를 접지에 1 S 로 묶어**(`nl.pinNodes`, `MNA.stampPins`) 절대
전위를 0 으로 고정한다. 섬 안에 접지로 가는 다른 길이 없으니 전류는 흐르지 않고 값은 바뀌지 않는다.
사이드바 **변압기** 는 결합 인덕터 두 개를 나란히 놓는다 (왼쪽 270°·오른쪽 90° → 코일이 바깥으로, 철심이 가운데).
공유 링크는 `couple` 을 번호로 싣고(`m`), 한쪽을 지우면 남은 쪽의 결합도 풀린다.

### 소자 인터페이스 (`devices/index.js`)

```js
Device = {
  id, type, comp, nodes:[nA,nB,(nC)], i0, i1, i2,   // 미지수 인덱스 (접지 = -1)
  extra: 0|1, k,                                    // 보조 미지수 (전원·인덕터 가지전류)
  linear, dynamic, disabled,
  loadOP  (sys, x, ctx)          // 동작점 — 현재 반복해 x 에서 선형화해 누적
  loadAC  (sys, xOP, ω, ctx)     // 소신호 어드미턴스 (복소 sys)
  loadTran(sys, x, ctx)          // 동반 모델 (ctx: t, h, method 'BE'|'TR', init)
  tranInit(x0) · tranUpdate(x, ctx) → outputs
  outputs(x) → {v, i, …extra}    // ports[0]→ports[1] 방향 +   (P, brightness, region, iB/iC/iE …)
  portCurrents(x) / portCurrentsOut(o) → {portId: 유입 전류}   // BJT 는 단자마다 다르다
  reset()                        // 접합 전압 제한 이력 초기화
}
```

새 소자 = `devices/` 파일 하나 + `symbols.js` 심볼 + `prop-panel.js` 필드/행 +
`constants.js` 의 TYPE·COMP_PORTS·SIDEBAR_ITEMS. 해석 코드는 손대지 않습니다.
스위치·접지·레일 라벨·분기점은 스탬프가 없고(`create` 가 null), 병합은 Netlist 가,
전류는 도선 후처리가 맡습니다.

### 비선형 (Newton-Raphson)

`analysis/op.newton` — 선형 회로는 한 번, 비선형이면 반복. 수렴 조건은 |Δx| 와
**접합 전압 제한(`pnjlim`)이 걸린 소자가 없을 것** 둘 다입니다. x 만 비교하면
'제한된 점'에서 선형화한 결과가 x 를 바꾸지 않아 거짓 수렴이 납니다(베이스 5 V,
전류 10⁶ A). 특이행렬 폴백: 그대로 → 모든 노드 gmin 1e-9 S → 전원 직렬저항 1e-4 Ω.

- 다이오드: Shockley `I = I_s(e^{V/nV_T} − 1)`, I_s = 1e-12, n = 1, gmin 병렬
- BJT: Ebers-Moll 수송 모델, β_F = value, β_R = 1, I_s = 1e-14. 동작 영역:
  차단(V_BE < 0.5) · 포화(V_BC > 0.4) · 활성

### 시간 영역 (`analysis/tran`)

t = 0 에 스위치가 닫힙니다: 축전기 단락·인덕터 개방으로 t=0⁺ 해를 구하고 고정
스텝으로 적분합니다. 처음 두 스텝 후진 오일러, 그 뒤 사다리꼴, 매 스텝 NR.
AC 전원은 `V·cos(ωt)`. 구간 T = 5·τ_max (진동이면 ≥ 3 주기, AC 면 ≥ 4 주기),
스텝 = T/(τ_min/25) (1500~8000). 편집 모드에서는 파형을 만들지 않습니다
(비선형+AC 는 패널 표시를 위해 예외).

**스위치를 여는 과도** (`opts.openTransient`, 앱은 `App.State.openTransient`): 닫힌 뷰의 정상상태(인덕터 전류·
축전기 전압)를 `initState` 로 넘겨 열림 뷰의 t=0⁺ 를 잡는다 — 인덕터는 `i_k = i0`, 축전기는 `G_SHORT` + 노턴 전류원으로 `v = v0`.
초기 에너지를 가진 소자의 섬은 `Netlist.build(…, {energized})` 로 살아 있는 회로가 된다. 실행 모드는 이때 열림 뷰를 재생하고
스위치도 열린 모습으로 그린다 (POE `opening:true` 예제).

### 극점 (`analysis/poles`)

상태(v_C, i_L)를 하나씩 1 로 두고 전원을 0 으로 한 저항 회로망 응답으로 상태행렬
A 를 만들고, Faddeev–LeVerrier 특성다항식 → Durand–Kerner 근. RLC 의 α, ω_d 와
과감쇠의 두 시상수가 추정값이 아니라 고유값입니다.

### 뷰와 표시 규약 (`post/result`)

뷰 = `{ valid, error, warnings, nodeVoltages, portVoltages, componentVoltages,
branchCurrents, wireCurrents, wireSignedI, componentNodes, acPhasor, dc:{compI, compV,
out, portI, nodeV}, wave, poles }`. AC 표시값은 피크 `|I_dc| + |I_ac|`,
실효값은 `√(I_dc² + |I_ac|²/2)`, 평균전력은 `V_dc·I_dc + Re(V·I*)/2`
(`App.Post.display/displayV/avgPower`). 파형이 있으면 `App.Post.waveStats` 가
정상상태 마지막 주기의 peak·rms·avg 를 주고 패널은 그것을 우선합니다(정류처럼
페이저가 무의미한 경우 포함).

`wave = { t, tMax, steps, node, elem{i, v, out}, wire, sample(id,t), sampleWire(wid,t),
sampleNode(k,t) }`. 소비자: 과도 응답 그래프(그리기만), 오실로스코프, 실행 모드
(전자 = `sampleWire`), 비유 모드(소자·도선·노드 모델에 파형 키를 달아 표본화).

---

## 상태 변경 규약

`App.State` 는 유일한 진실 공급원입니다. 직접 필드를 건드리지 말고 메서드를 쓰세요.

```js
App.State.addComponent(comp);         // ✅ 내부에서 _mutate → 스냅샷 → emit
App.State.components.push(comp);      // ❌ Undo 히스토리·렌더 갱신 누락
```

`removeComponent(id)` 는 전원에 딸린 자동 스위치를 단독으로 지우면 `false` 를
돌려주고, 전원을 지우면 그 스위치도 함께 지웁니다.

## 이벤트 흐름

```
사용자 입력 (Interaction)
   ▼
App.State 변경 ──emit──► 'state:changed' ──► Solver.run() (idle 디바운스) ──► 'solver:done'
                                                                       ├─► PropPanel.refresh()
                                                                       ├─► EditRenderer.scheduleRender()
                                                                       ├─► RunRenderer._initPools()
                                                                       └─► TransientGraph / Scope 재그리기
모드 전환 ──► Solver.solveNow() (열림/닫힘 즉시) ──► 렌더러 시작
실행 모드 ──emit──► 'run:time' (재생 시간) ──► 과도 그래프·오실로스코프 커서
뷰포트 변경 ──emit──► 'viewport:changed' ──► GridRenderer.render()
```

## 캔버스 레이어

| 레이어 | z | 담당 | 갱신 |
| --- | --- | --- | --- |
| `#canvas-bg` | 1 | GridRenderer | 뷰포트 변화 시 |
| `#canvas-main` | 2 | EditRenderer / AnalogyRenderer | rAF 디바운스 |
| `#canvas-anim` | 3 | RunRenderer | 실행 모드 매 프레임 |

## 좌표계

`grid` (논리 칸) ↔ `pixel = grid × CELL_SIZE × scale + offset`. 포트 이름(L/R/T/B)은
단자 식별자이며 회전해도 바뀌지 않습니다 — 도선의 `fromPort/toPort` 를 회전에 맞춰
고치면 토폴로지가 깨집니다.

## 코딩 컨벤션

- **ES5 문법** (`var`, `function`, IIFE) — 트랜스파일 없이 넓은 호환성
- 모든 파일 상단 `'use strict'`, 내부 식별자는 `_` 접두사
- 주석은 한국어. 모듈 헤더에 설계 의도·규약·주의사항을 적는다
- 새 CSS 는 `responsive.css` 보다 앞에, 새 JS 는 의존 대상보다 뒤에 링크
