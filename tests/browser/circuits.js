/* 공통 회로 정의 — 모든 포트 좌표는 grid 반정수 */
module.exports = {
  /* DC 12V + R 100Ω + C 100µF 직렬 (사각 루프, R 은 위쪽) */
  rc: {
    comps:[{key:'dc',type:'DC_SOURCE',gx:48,gy:50,rot:90,value:12},
           {key:'r', type:'RESISTOR', gx:50,gy:48,rot:0, value:100},
           {key:'c', type:'CAPACITOR',gx:52,gy:50,rot:90,value:100e-6}],
    wires:[['dc','L','r','L','V-first'],['r','R','c','L','H-first'],['c','R','dc','R','H-first']],
    center:[51,50.5],
  },
  /* DC 12V + R 100Ω + L 10mH 직렬 */
  rl: {
    comps:[{key:'dc',type:'DC_SOURCE',gx:48,gy:50,rot:90,value:12},
           {key:'r', type:'RESISTOR', gx:50,gy:48,rot:0, value:100},
           {key:'l', type:'INDUCTOR', gx:52,gy:50,rot:90,value:10e-3}],
    wires:[['dc','L','r','L','V-first'],['r','R','l','L','H-first'],['l','R','dc','R','H-first']],
    center:[51,50.5],
  },
  /* DC 12V + R + L + C 직렬 (2차 회로 · 비유 모드 전시용) */
  rlc: {
    comps:[{key:'dc',type:'DC_SOURCE',gx:48,gy:50,rot:90,value:12},
           {key:'r', type:'RESISTOR', gx:50,gy:48,rot:0, value:100},
           {key:'l', type:'INDUCTOR', gx:52,gy:48,rot:0, value:10e-3},
           {key:'c', type:'CAPACITOR',gx:55,gy:50,rot:90,value:100e-6}],
    wires:[['dc','L','r','L','V-first'],['r','R','l','L','H-first'],
           ['l','R','c','L','H-first'],['c','R','dc','R','H-first']],
    center:[52,50.5],
  },
  /* AC 220V 60Hz + R 100Ω + C 100µF */
  ac: {
    comps:[{key:'ac',type:'AC_SOURCE',gx:48,gy:50,rot:90,value:220,value2:60},
           {key:'r', type:'RESISTOR', gx:50,gy:48,rot:0, value:100},
           {key:'c', type:'CAPACITOR',gx:52,gy:50,rot:90,value:100e-6}],
    wires:[['ac','L','r','L','V-first'],['r','R','c','L','H-first'],['c','R','ac','R','H-first']],
    center:[51,50.5],
  },
  /* 병렬: DC 12V + R1 100Ω ∥ R2 200Ω (분기점 4개) */
  par: {
    comps:[{key:'dc',type:'DC_SOURCE',gx:48,gy:50,rot:90,value:12},
           {key:'ja',type:'JUNCTION_3',gx:51,gy:49,rot:0,  value:0},
           {key:'jb',type:'JUNCTION_3',gx:54,gy:49,rot:0,  value:0},
           {key:'r1',type:'RESISTOR',  gx:51,gy:50,rot:90, value:100},
           {key:'r2',type:'RESISTOR',  gx:54,gy:50,rot:90, value:200},
           {key:'jc',type:'JUNCTION_3',gx:51,gy:51,rot:180,value:0},
           {key:'jd',type:'JUNCTION_3',gx:54,gy:51,rot:180,value:0}],
    wires:[['dc','L','ja','L','V-first'],
           ['ja','B','r1','L','H-first'],
           ['ja','R','jb','L','H-first'],
           ['jb','B','r2','L','H-first'],
           ['r1','R','jc','B','H-first'],
           ['r2','R','jd','B','H-first'],
           ['jc','L','jd','R','H-first'],
           ['dc','R','jc','R','V-first']],
    center:[52,50.5],
  },
  /* 직렬 2저항 (전압 분배) */
  div: {
    comps:[{key:'dc',type:'DC_SOURCE',gx:48,gy:50,rot:90,value:12},
           {key:'r1',type:'RESISTOR', gx:50,gy:48,rot:0, value:100},
           {key:'r2',type:'RESISTOR', gx:52,gy:48,rot:0, value:200}],
    wires:[['dc','L','r1','L','V-first'],['r1','R','r2','L','H-first'],['r2','R','dc','R','V-first']],
    center:[51,50],
  },
};
