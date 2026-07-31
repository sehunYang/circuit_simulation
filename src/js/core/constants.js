'use strict';

/* ════════════════════════════════════════════════════════════════════
 * 소자 타입 열거형
 *   Object.freeze로 불변 보장. 값은 문자열(직렬화/디버깅 용이).
 * ════════════════════════════════════════════════════════════════════ */
var TYPE = Object.freeze({
  DC_SOURCE:  'DC_SOURCE',  AC_SOURCE:  'AC_SOURCE',
  RESISTOR:   'RESISTOR',   CAPACITOR:  'CAPACITOR',
  INDUCTOR:   'INDUCTOR',
  JUNCTION_3: 'JUNCTION_3', JUNCTION_4: 'JUNCTION_4',
});

/* ════════════════════════════════════════════════════════════════════
 * 그리드 & 뷰포트
 * ════════════════════════════════════════════════════════════════════ */
var CELL_SIZE = 40;     // 그리드 1칸 = 40px (scale=1 기준)
var GRID_COLS = 100;    // 그리드 가로 칸 수
var GRID_ROWS = 100;    // 그리드 세로 칸 수
var SCALE_MIN = 0.25;   // 최소 줌 배율
var SCALE_MAX = 4.0;    // 최대 줌 배율

/* ════════════════════════════════════════════════════════════════════
 * 입력/인터랙션 튜닝값
 * ════════════════════════════════════════════════════════════════════ */
var INERTIA_FRICTION  = 0.92;  // 패닝 관성 감속 계수 (1에 가까울수록 오래 미끄러짐)
var INERTIA_THRESHOLD = 0.5;   // 관성 정지 임계 속도(px/frame)
var WHEEL_ZOOM_STEP   = 1.1;   // 휠 1회당 줌 배율
var DOUBLE_TAP_MS     = 220;   // 더블탭 판정 간격(ms)
var HIT_RADIUS_TOUCH  = 22;    // 터치 히트 반지름(px)
var HIT_RADIUS_MOUSE  = 10;    // 마우스 히트 반지름(px)
var BEND_HIT_RADIUS   = 10;    // 꺾임점 핸들 히트 반지름(px)
var PORT_DOT_R        = 5;     // 포트 점 기본 반지름(px)
var WIRE_FLASH_MS     = 350;   // 도선 완성 플래시 지속(ms)
var LONGPRESS_MS      = 480;   // 롱프레스 판정 시간(ms)
var UNDO_MAX          = 30;    // Undo 최대 단계

/* ════════════════════════════════════════════════════════════════════
 * 소자 정의 테이블
 * ════════════════════════════════════════════════════════════════════ */

/* 사이드바 팔레트 항목 (생성 가능한 소자 목록)
 *   defValue : 기본 1차값 (저항Ω/전압V/전기용량F/인덕턴스H)
 *   defValue2: 기본 2차값 (AC 주파수Hz, 그 외 null)
 *   shortUnit: 사이드바·라벨 표시 단위 */
var SIDEBAR_ITEMS = [
  { type:TYPE.DC_SOURCE,  label:'DC',  defValue:12,      defValue2:null, shortUnit:'V'  },
  { type:TYPE.AC_SOURCE,  label:'AC',  defValue:220,     defValue2:60,   shortUnit:'V~' },
  { type:TYPE.RESISTOR,   label:'R',   defValue:100,     defValue2:null, shortUnit:'Ω'  },
  { type:TYPE.CAPACITOR,  label:'C',   defValue:100e-6,  defValue2:null, shortUnit:'µF' },
  { type:TYPE.INDUCTOR,   label:'L',   defValue:10e-3,   defValue2:null, shortUnit:'mH' },
  { type:TYPE.JUNCTION_3, label:'J3',  defValue:0,       defValue2:null, shortUnit:''   },
  { type:TYPE.JUNCTION_4, label:'J4',  defValue:0,       defValue2:null, shortUnit:''   },
];

/* 소자별 포트 문자열 (rotation=0 로컬 기준)
 *   L=좌, R=우, T=상, B=하
 *   2단자 소자는 'LR', 분기점은 다중 포트 */
var COMP_PORTS = {
  DC_SOURCE:'LR', AC_SOURCE:'LR', RESISTOR:'LR',
  CAPACITOR:'LR', INDUCTOR:'LR',
  JUNCTION_3:'LRB', JUNCTION_4:'LRTB',
};

/* 다중 연결 허용 타입 (분기점) — 한 포트에 여러 도선 연결 가능 */
var MULTI_PORT_TYPES = { JUNCTION_3:true, JUNCTION_4:true };

/* 90° 시계방향 회전 시 포트 재매핑 (L→T→R→B→L)
 *   주의: 토폴로지용 포트 ID는 회전해도 불변. 이 테이블은
 *   포트 ID를 시각적/논리적으로 회전 변환할 때만 사용. */
var PORT_ROTATE_CW = { L:'T', T:'R', R:'B', B:'L' };
