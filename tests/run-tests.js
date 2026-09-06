'use strict';
/* ════════════════════════════════════════════════════════════════════
 * 회로 물리 알고리즘 검증 테스트
 *
 *   실행:  node tests/run-tests.js
 *
 *   브라우저 전역(window/App) 을 Node vm 샌드박스로 재현해
 *   constants → topology → solver → transient-graph 를 로드하고,
 *   솔버 결과를 "실제 물리 해석해" (옴 법칙, 복소 임피던스, KCL/KVL,
 *   전력 보존, τ=L/R·RC, RLC 감쇠진동 α=R/2L·ω_d)와 수치 대조한다.
 *
 *   기대값은 솔버 알고리즘과 무관한 닫힌형 공식/손계산 값으로만 작성
 *   (솔버 출력을 기대값으로 재사용하지 않음 — 자기참조 검증 방지).
 * ════════════════════════════════════════════════════════════════════ */
var fs=require('fs'), path=require('path'), vm=require('vm');
var ROOT=path.join(__dirname,'..');

/* ── 샌드박스 구성 ── */
function makeApp(){
  var sandbox={console:console, Math:Math, setTimeout:setTimeout, clearTimeout:clearTimeout};
  sandbox.window=sandbox;
  vm.createContext(sandbox);
  function load(rel){
    var code=fs.readFileSync(path.join(ROOT,rel),'utf8');
    vm.runInContext(code,sandbox,{filename:rel});
  }
  load('src/js/core/constants.js');
  sandbox.App={};
  sandbox.App.Events={on:function(){},emit:function(){}};
  sandbox.App.Geo={getCompPorts:function(c){return (sandbox.COMP_PORTS[c.type]||'LR').split('');}};
  sandbox.App.State={
    components:[], wires:[], solverResult:null,
    getComponent:function(id){
      for(var i=0;i<this.components.length;i++)
        if(this.components[i].id===id) return this.components[i];
      return null;
    },
  };
  load('src/js/circuit/topology.js');
  load('src/js/circuit/solver.js');
  load('src/js/ui/transient-graph.js');
  return sandbox;
}

/* ── 회로 빌더 DSL ── */
function circuit(sb){
  var nid=1, wid=1;
  var comps=[], wires=[];
  return{
    comps:comps, wires:wires,
    add:function(type,value,value2){
      var c={id:'c'+(nid++), type:sb.TYPE[type], value:(value!=null?value:0),
             value2:(value2!=null?value2:null), rotation:0, x:0, y:0};
      comps.push(c); return c;
    },
    wire:function(a,ap,b,bp){
      var w={id:'w'+(wid++), fromId:a.id, fromPort:ap, toId:b.id, toPort:bp};
      wires.push(w); return w;
    },
  };
}

/* ── 솔버 실행 (동기 solve API 우선, 없으면 디바운스 경유) ── */
function solveCircuit(sb, ckt){
  sb.App.State.components=ckt.comps;
  sb.App.State.wires=ckt.wires;
  if(typeof sb.App.Solver.solve==='function'){
    var r=sb.App.Solver.solve(ckt.comps, ckt.wires);
    sb.App.State.solverResult=r;
    return Promise.resolve(r);
  }
  sb.App.Solver.run();
  return new Promise(function(res){
    setTimeout(function(){ res(sb.App.State.solverResult); },90);
  });
}

/* ── 어서션 헬퍼 ── */
var _results=[];  /* {name, ok, detail} */
var _cur=null;
function scenario(name){ _cur={name:name, checks:[], failed:0}; _results.push(_cur); }
function check(label, ok, detail){
  _cur.checks.push({label:label, ok:!!ok, detail:detail||''});
  if(!ok) _cur.failed++;
}
function approx(label, got, want, rtol, atol){
  rtol=rtol!=null?rtol:1e-6; atol=atol!=null?atol:1e-9;
  var ok=(typeof got==='number')&&isFinite(got)&&
         Math.abs(got-want)<=Math.max(atol, rtol*Math.abs(want));
  check(label, ok, ok?'':('got='+got+' want='+want));
}
function expectError(label, sr, needle){
  var ok=sr && sr.valid===false && typeof sr.error==='string' &&
         sr.error.indexOf(needle)>=0;
  check(label, ok, ok?'':('valid='+(sr&&sr.valid)+' error='+(sr&&sr.error)));
}

/* ── 물리 불변량: 정션 KCL (DC 부호 전류 기준) ── */
function checkJunctionKCL(sb, ckt, sr, scale){
  var jT={JUNCTION_3:1, JUNCTION_4:1};
  ckt.comps.forEach(function(j){
    if(!jT[j.type]) return;
    var sum=0, n=0;
    ckt.wires.forEach(function(w){
      var I=(sr.wireSignedI&&sr.wireSignedI[w.id])||0;
      if(w.toId===j.id){ sum+=I; n++; }
      if(w.fromId===j.id){ sum-=I; n++; }
    });
    if(n>0) approx('KCL@'+j.id+' Σ전류=0', sum, 0, 0, Math.max(1e-9, (scale||1)*1e-6));
  });
}

/* ════════════════════════════════════════════════════════════════════
 * 시나리오
 * ════════════════════════════════════════════════════════════════════ */
async function main(){
  var TYPE_KEYS; /* 미사용 — 명시성 위해 남김 */

  /* ── DC-1: 직렬 분배기 (V=12, R1=100, R2=200) ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',12), R1=c.add('RESISTOR',100), R2=c.add('RESISTOR',200);
    c.wire(V,'L',R1,'L'); c.wire(R1,'R',R2,'L'); c.wire(R2,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('DC-1 직렬 분배기 12V/(100+200)');
    check('해석 성공', sr.valid, sr.error);
    if(!sr.valid) return;
    approx('I(R1)=40mA', Math.abs(sr.branchCurrents[R1.id]), 0.04);
    approx('I(R2)=40mA', Math.abs(sr.branchCurrents[R2.id]), 0.04);
    approx('V(R1)=4V',   Math.abs(sr.componentVoltages[R1.id]), 4);
    approx('V(R2)=8V',   Math.abs(sr.componentVoltages[R2.id]), 8);
    approx('V(src)=12V', Math.abs(sr.componentVoltages[V.id]), 12);
    approx('I(src)=40mA', Math.abs(sr.branchCurrents[V.id]), 0.04);
    /* 도선 부호 전류: 전원 +단자에서 나가는 방향이 + */
    approx('wire(src→R1) 부호전류=+0.04', sr.wireSignedI[c.wires[0].id], 0.04);
    /* KVL: 저항 강하 합 = 전원 전압 */
    approx('KVL ΣV_R=V', Math.abs(sr.componentVoltages[R1.id])+Math.abs(sr.componentVoltages[R2.id]), 12);
  })();

  /* ── DC-2: J3 병렬 (100Ω ∥ 300Ω, 12V) ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',12), R1=c.add('RESISTOR',100), R2=c.add('RESISTOR',300);
    var JA=c.add('JUNCTION_3'), JB=c.add('JUNCTION_3');
    var wSrc=c.wire(V,'L',JA,'L');
    var w1=c.wire(JA,'R',R1,'L'), w2=c.wire(JA,'B',R2,'L');
    var w3=c.wire(R1,'R',JB,'L'), w4=c.wire(R2,'R',JB,'B');
    var wBack=c.wire(JB,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('DC-2 병렬 100∥300, 12V');
    check('해석 성공', sr.valid, sr.error);
    if(!sr.valid) return;
    approx('I(R1)=0.12A', Math.abs(sr.branchCurrents[R1.id]), 0.12);
    approx('I(R2)=0.04A', Math.abs(sr.branchCurrents[R2.id]), 0.04);
    approx('I(src)=0.16A', Math.abs(sr.branchCurrents[V.id]), 0.16);
    approx('V(R1)=V(R2)=12V', Math.abs(sr.componentVoltages[R1.id]), 12);
    approx('|I|(src도선)=0.16', sr.wireCurrents[wSrc.id], 0.16);
    approx('|I|(JA→R1)=0.12', sr.wireCurrents[w1.id], 0.12);
    approx('|I|(JA→R2)=0.04', sr.wireCurrents[w2.id], 0.04);
    approx('|I|(JB→src)=0.16', sr.wireCurrents[wBack.id], 0.16);
    checkJunctionKCL(sb,c,sr,0.16);
  })();

  /* ── DC-3: 휘트스톤 브리지 (불평형) ──
   *   10V, R1(A-B)=100, R2(A-C)=200, R3(B-D)=300, R4(C-D)=400, R5(B-C)=500
   *   손계산: 23vB−3vC=150, 19vC−4vB=100 → vB=3150/425, vC=(23vB−150)/3 */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',10);
    var R1=c.add('RESISTOR',100), R2=c.add('RESISTOR',200);
    var R3=c.add('RESISTOR',300), R4=c.add('RESISTOR',400), R5=c.add('RESISTOR',500);
    var A=c.add('JUNCTION_3'), B=c.add('JUNCTION_4'), C4=c.add('JUNCTION_4'), D=c.add('JUNCTION_3');
    c.wire(V,'L',A,'L');
    c.wire(A,'R',R1,'L'); c.wire(R1,'R',B,'L');
    c.wire(A,'B',R2,'L'); c.wire(R2,'R',C4,'L');
    c.wire(B,'R',R3,'L'); c.wire(R3,'R',D,'L');
    c.wire(C4,'R',R4,'L'); c.wire(R4,'R',D,'B');
    c.wire(B,'B',R5,'L'); c.wire(R5,'R',C4,'B');
    c.wire(D,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('DC-3 휘트스톤 브리지 (불평형)');
    check('해석 성공', sr.valid, sr.error);
    if(!sr.valid) return;
    var vB=3150/425, vC=(23*vB-150)/3;
    approx('I(R1)', Math.abs(sr.branchCurrents[R1.id]), (10-vB)/100);
    approx('I(R2)', Math.abs(sr.branchCurrents[R2.id]), (10-vC)/200);
    approx('I(R3)', Math.abs(sr.branchCurrents[R3.id]), vB/300);
    approx('I(R4)', Math.abs(sr.branchCurrents[R4.id]), vC/400);
    approx('I(R5 브리지)', Math.abs(sr.branchCurrents[R5.id]), (vB-vC)/500);
    approx('I(src)', Math.abs(sr.branchCurrents[V.id]), (10-vB)/100+(10-vC)/200);
    /* 전력 보존: Σ I²R = V·I_src */
    var Psum=0;
    [R1,R2,R3,R4,R5].forEach(function(r){
      var I=Math.abs(sr.branchCurrents[r.id]); Psum+=I*I*r.value;
    });
    approx('전력보존 ΣI²R=V·I', Psum, 10*((10-vB)/100+(10-vC)/200), 1e-9);
    checkJunctionKCL(sb,c,sr,0.05);
  })();

  /* ── DC-4: 정션-정션 연결 도선의 전류 ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',12), R1=c.add('RESISTOR',100);
    var JA=c.add('JUNCTION_3'), JB=c.add('JUNCTION_3');
    c.wire(V,'L',JA,'L');
    var wJJ=c.wire(JA,'R',JB,'L');
    c.wire(JB,'R',R1,'L'); c.wire(R1,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('DC-4 정션-정션 도선 전류');
    check('해석 성공', sr.valid, sr.error);
    if(!sr.valid) return;
    approx('|I|(JA–JB)=0.12', sr.wireCurrents[wJJ.id], 0.12);
    approx('부호(JA→JB)=+0.12', sr.wireSignedI[wJJ.id], 0.12);
    checkJunctionKCL(sb,c,sr,0.12);
  })();

  /* ── DC-5: 정션 사이 이중 병렬 도선 (이상도체 병렬 → 균등 분배) ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',12), R1=c.add('RESISTOR',100);
    var JA=c.add('JUNCTION_3'), JB=c.add('JUNCTION_3');
    c.wire(V,'L',JA,'L');
    var wa=c.wire(JA,'R',JB,'L');
    var wb=c.wire(JA,'B',JB,'B');
    c.wire(JB,'R',R1,'L'); c.wire(R1,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('DC-5 정션 병렬 이중 도선 균등 분배');
    check('해석 성공', sr.valid, sr.error);
    if(!sr.valid) return;
    var Ia=sr.wireSignedI[wa.id]||0, Ib=sr.wireSignedI[wb.id]||0;
    approx('합=0.12 (KCL)', Ia+Ib, 0.12);
    approx('균등 분배 wa=0.06', Ia, 0.06);
    approx('균등 분배 wb=0.06', Ib, 0.06);
    checkJunctionKCL(sb,c,sr,0.12);
  })();

  /* ── DC-6: L 은 단락, C 는 개방 ──
   *   12V — R(100) — L(10mH) 직렬 → I=0.12
   *   C(100µF) 는 R2(300) 와 병렬 (J3 사용) → V_C = 12·300/400 = 9V, I_C=0 */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',12), R1=c.add('RESISTOR',100), L=c.add('INDUCTOR',10e-3);
    var sr;
    c.wire(V,'L',R1,'L'); c.wire(R1,'R',L,'L'); c.wire(L,'R',V,'R');
    sr=await solveCircuit(sb,c);
    scenario('DC-6a RL 직렬: L=DC 단락');
    check('해석 성공', sr.valid, sr.error);
    if(sr.valid){
      approx('I=V/R=0.12', Math.abs(sr.branchCurrents[R1.id]), 0.12);
      approx('I(L)=0.12', Math.abs(sr.branchCurrents[L.id]), 0.12, 1e-3);
      approx('V(L)≈0', Math.abs(sr.componentVoltages[L.id]), 0, 0, 1e-3);
    }
    /* b) C 병렬 */
    var sb2=makeApp(), c2=circuit(sb2);
    var V2=c2.add('DC_SOURCE',12), Ra=c2.add('RESISTOR',100), Rb=c2.add('RESISTOR',300);
    var C=c2.add('CAPACITOR',100e-6);
    var JA=c2.add('JUNCTION_3'), JB=c2.add('JUNCTION_3');
    c2.wire(V2,'L',Ra,'L'); c2.wire(Ra,'R',JA,'L');
    c2.wire(JA,'R',Rb,'L'); c2.wire(Rb,'R',JB,'L');
    c2.wire(JA,'B',C,'L');  c2.wire(C,'R',JB,'B');
    c2.wire(JB,'R',V2,'R');
    var sr2=await solveCircuit(sb2,c2);
    scenario('DC-6b RC 병렬: C=DC 개방, V_C=분배전압');
    check('해석 성공', sr2.valid, sr2.error);
    if(sr2.valid){
      approx('I(Ra)=12/400=0.03', Math.abs(sr2.branchCurrents[Ra.id]), 0.03);
      approx('V(C)=9V', Math.abs(sr2.componentVoltages[C.id]), 9);
      approx('I(C)=0', Math.abs(sr2.branchCurrents[C.id]), 0, 0, 1e-9);
      checkJunctionKCL(sb2,c2,sr2,0.03);
    }
  })();

  /* ── DC-7: 직렬 2전원 (순방향 합·역방향 차) ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V1=c.add('DC_SOURCE',12), V2=c.add('DC_SOURCE',5), R=c.add('RESISTOR',100);
    /* 순방향: V1.R(−) — V2.L(+): 두 기전력 합산 */
    c.wire(V1,'L',R,'L'); c.wire(R,'R',V2,'L'); c.wire(V2,'R',V1,'R');
    var sr=await solveCircuit(sb,c);
    scenario('DC-7a 직렬 전원 역방향 (12−5)/100');
    check('해석 성공', sr.valid, sr.error);
    if(sr.valid) approx('I=0.07', Math.abs(sr.branchCurrents[R.id]), 0.07);
    /* 순방향 배선: V2 극성 반전 */
    var sb2=makeApp(), c2=circuit(sb2);
    var A=c2.add('DC_SOURCE',12), B=c2.add('DC_SOURCE',5), R2=c2.add('RESISTOR',100);
    c2.wire(A,'L',R2,'L'); c2.wire(R2,'R',B,'R'); c2.wire(B,'L',A,'R');
    var sr2=await solveCircuit(sb2,c2);
    scenario('DC-7b 직렬 전원 순방향 (12+5)/100');
    check('해석 성공', sr2.valid, sr2.error);
    if(sr2.valid) approx('I=0.17', Math.abs(sr2.branchCurrents[R2.id]), 0.17);
  })();

  /* ── DC-8: 동일 전압 병렬 전원 → 허용, 총 전류 유지 ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V1=c.add('DC_SOURCE',12), V2=c.add('DC_SOURCE',12), R=c.add('RESISTOR',100);
    c.wire(V1,'L',R,'L'); c.wire(R,'R',V1,'R');
    c.wire(V2,'L',V1,'L'); c.wire(V2,'R',V1,'R');
    var sr=await solveCircuit(sb,c);
    scenario('DC-8 동일 전압 병렬 전원');
    check('해석 성공', sr.valid, sr.error);
    if(sr.valid) approx('I(R)=0.12', Math.abs(sr.branchCurrents[R.id]), 0.12);
  })();

  /* ── DC-9: 전압 다른 병렬 전원 → 오류 ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V1=c.add('DC_SOURCE',12), V2=c.add('DC_SOURCE',5), R=c.add('RESISTOR',100);
    c.wire(V1,'L',R,'L'); c.wire(R,'R',V1,'R');
    c.wire(V2,'L',V1,'L'); c.wire(V2,'R',V1,'R');
    var sr=await solveCircuit(sb,c);
    scenario('DC-9 전압 불일치 병렬 전원 → 오류');
    expectError('병렬 전원 오류 메시지', sr, '병렬');
  })();

  /* ── ERR-1: 전원 없음 / 개방 회로 / 전원 단락 ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var R1=c.add('RESISTOR',100), R2=c.add('RESISTOR',200);
    c.wire(R1,'L',R2,'L'); c.wire(R1,'R',R2,'R');
    var sr=await solveCircuit(sb,c);
    scenario('ERR-1a 전원 없음');
    expectError("'전원이 없습니다'", sr, '전원이 없습니다');

    var sb2=makeApp(), c2=circuit(sb2);
    var V=c2.add('DC_SOURCE',12), Ra=c2.add('RESISTOR',100), Rb=c2.add('RESISTOR',200);
    c2.wire(V,'L',Ra,'L'); c2.wire(Ra,'R',V,'R');
    /* Rb 는 어디에도 연결 안 됨 → 분리 서브그래프 */
    void Rb;
    var sr2=await solveCircuit(sb2,c2);
    scenario('ERR-1b 분리된 부품 → 개방 회로');
    expectError("'회로가 열려 있습니다'", sr2, '열려');

    var sb3=makeApp(), c3=circuit(sb3);
    var V3=c3.add('DC_SOURCE',12);
    c3.wire(V3,'L',V3,'R');
    var sr3=await solveCircuit(sb3,c3);
    scenario('ERR-1c 전원 양단 직결 → 단락');
    expectError("'단락'", sr3, '단락');
  })();

  /* ── ERR-2: 전원—인덕터 단독 루프 (이상 소자 → 무한 전류) → 단락 오류 ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',12), L=c.add('INDUCTOR',10e-3);
    c.wire(V,'L',L,'L'); c.wire(L,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('ERR-2 V–L 단독 루프 → 단락 판정 (∞ 전류의 물리적 표현)');
    expectError("'단락' 오류", sr, '단락');
  })();

  /* ── DC-10: 매달린 가지 (전류 0, 오류 아님 — 물리적으로 개방 가지) ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',12), R1=c.add('RESISTOR',100), R2=c.add('RESISTOR',50);
    var JA=c.add('JUNCTION_3'), JB=c.add('JUNCTION_3');
    c.wire(V,'L',JA,'L'); c.wire(JA,'R',R1,'L'); c.wire(R1,'R',JB,'L');
    c.wire(JB,'R',V,'R');
    var wDangle=c.wire(JA,'B',R2,'L');   /* R2.R 은 미연결 → 가지 전류 0 */
    var sr=await solveCircuit(sb,c);
    scenario('DC-10 매달린 가지: 본선 정상, 가지 전류 0');
    check('해석 성공', sr.valid, sr.error);
    if(!sr.valid) return;
    approx('I(R1)=0.12', Math.abs(sr.branchCurrents[R1.id]), 0.12);
    approx('I(R2 매달림)=0', Math.abs(sr.branchCurrents[R2.id]), 0, 0, 1e-9);
    approx('매달린 도선 전류=0', Math.abs(sr.wireSignedI[wDangle.id]||0), 0, 0, 1e-9);
    checkJunctionKCL(sb,c,sr,0.12);
  })();

  /* ── DC-11: L ∥ C 병렬 (R 직렬) — L 이 C 를 단락 ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',12), R=c.add('RESISTOR',100);
    var L=c.add('INDUCTOR',10e-3), C=c.add('CAPACITOR',100e-6);
    var JA=c.add('JUNCTION_3'), JB=c.add('JUNCTION_3');
    c.wire(V,'L',R,'L'); c.wire(R,'R',JA,'L');
    var wL=c.wire(JA,'R',L,'L'); c.wire(L,'R',JB,'L');
    var wC=c.wire(JA,'B',C,'L'); c.wire(C,'R',JB,'B');
    c.wire(JB,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('DC-11 L∥C: L 이 C 를 단락, 전류는 전부 L 로');
    check('해석 성공', sr.valid, sr.error);
    if(!sr.valid) return;
    approx('I(R)=0.12', Math.abs(sr.branchCurrents[R.id]), 0.12, 1e-4);
    approx('I(L)=0.12', Math.abs(sr.branchCurrents[L.id]), 0.12, 1e-4);
    approx('I(C)=0', Math.abs(sr.branchCurrents[C.id]), 0, 0, 1e-9);
    approx('V(C)=V(L)≈0', Math.abs(sr.componentVoltages[C.id]), 0, 0, 1e-3);
    approx('|I|(JA→L 도선)=0.12', sr.wireCurrents[wL.id], 0.12, 1e-4);
    approx('|I|(JA→C 도선)=0', sr.wireCurrents[wC.id], 0, 0, 1e-9);
    checkJunctionKCL(sb,c,sr,0.12);
  })();

  /* ── AC-1: R 단독 (100V peak, 60Hz, 50Ω) ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('AC_SOURCE',100,60), R=c.add('RESISTOR',50);
    c.wire(V,'L',R,'L'); c.wire(R,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('AC-1 R 단독: |I|=V/R');
    check('해석 성공', sr.valid, sr.error);
    if(!sr.valid) return;
    check('acPhasor 존재', !!sr.acPhasor);
    approx('|I|=2A(peak)', Math.abs(sr.branchCurrents[R.id]), 2);
    approx('ω=2π·60', sr.acPhasor.omega, 2*Math.PI*60);
    /* 순시값: t=0 에서 i=I·cos(0)=2 */
    approx('i(0)=2', sr.acPhasor.instCurrent(R.id,0), 2);
    var T=1/60;
    approx('i(T/2)=−2', sr.acPhasor.instCurrent(R.id,T/2), -2, 1e-4);
  })();

  /* ── AC-2: RC 직렬 — 크기·위상(전류 앞섬) ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var Vp=100, f=60, Rv=100, Cv=100e-6, w=2*Math.PI*f;
    var V=c.add('AC_SOURCE',Vp,f), R=c.add('RESISTOR',Rv), C=c.add('CAPACITOR',Cv);
    c.wire(V,'L',R,'L'); c.wire(R,'R',C,'L'); c.wire(C,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('AC-2 RC 직렬: |I|=V/√(R²+Xc²), 전류 위상 앞섬');
    check('해석 성공', sr.valid, sr.error);
    if(!sr.valid) return;
    var Xc=1/(w*Cv), Imag=Vp/Math.hypot(Rv,Xc);
    approx('|I(R)|', Math.abs(sr.branchCurrents[R.id]), Imag);
    approx('|I(C)|', Math.abs(sr.branchCurrents[C.id]), Imag);
    approx('|V_C|=|I|·Xc', Math.abs(sr.componentVoltages[C.id]), Imag*Xc);
    var p=sr.acPhasor.compI[R.id];
    check('전류 위상 앞섬 (Im>0)', p && p.im>0, JSON.stringify(p));
    approx('위상각=atan(Xc/R)', Math.atan2(p.im,p.re), Math.atan(Xc/Rv), 1e-6);
  })();

  /* ── AC-3: RL 직렬 — 크기·위상(전류 뒤짐) ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var Vp=100, f=60, Rv=100, Lv=0.2, w=2*Math.PI*f;
    var V=c.add('AC_SOURCE',Vp,f), R=c.add('RESISTOR',Rv), L=c.add('INDUCTOR',Lv);
    c.wire(V,'L',R,'L'); c.wire(R,'R',L,'L'); c.wire(L,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('AC-3 RL 직렬: |I|=V/√(R²+XL²), 전류 위상 뒤짐');
    check('해석 성공', sr.valid, sr.error);
    if(!sr.valid) return;
    var XL=w*Lv, Imag=Vp/Math.hypot(Rv,XL);
    approx('|I|', Math.abs(sr.branchCurrents[R.id]), Imag);
    approx('|V_L|=|I|·XL', Math.abs(sr.componentVoltages[L.id]), Imag*XL);
    var p=sr.acPhasor.compI[R.id];
    check('전류 위상 뒤짐 (Im<0)', p && p.im<0, JSON.stringify(p));
    approx('위상각=−atan(XL/R)', Math.atan2(p.im,p.re), -Math.atan(XL/Rv), 1e-6);
  })();

  /* ── AC-4: RLC 직렬 — 일반 주파수 + 공진 ── */
  await (async function(){
    var Vp=100, Rv=20, Lv=10e-3, Cv=100e-6;
    /* 일반: f=60 */
    var sb=makeApp(), c=circuit(sb);
    var f=60, w=2*Math.PI*f;
    var V=c.add('AC_SOURCE',Vp,f), R=c.add('RESISTOR',Rv),
        L=c.add('INDUCTOR',Lv), C=c.add('CAPACITOR',Cv);
    c.wire(V,'L',R,'L'); c.wire(R,'R',L,'L'); c.wire(L,'R',C,'L'); c.wire(C,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('AC-4a RLC 직렬 (60Hz)');
    check('해석 성공', sr.valid, sr.error);
    if(sr.valid){
      var X=w*Lv-1/(w*Cv), Imag=Vp/Math.hypot(Rv,X);
      approx('|I|=V/|Z|', Math.abs(sr.branchCurrents[R.id]), Imag);
      /* 평균 전력 보존: ½|I|²R = ½Re[V·conj(I_src공급)] */
      var pI=sr.acPhasor.compI[R.id];
      var Pr=0.5*(pI.re*pI.re+pI.im*pI.im)*Rv;
      var pS=sr.acPhasor.compI[V.id];   /* MNA 부호: 공급전류 = −pS */
      var Psrc=0.5*(Vp*(-pS.re));       /* V 페이저 = (Vp, 0) */
      approx('평균전력 보존', Pr, Psrc, 1e-6);
    }
    /* 공진: f0=1/(2π√(LC)) → |I|=V/R, 전류 위상 0 */
    var f0=1/(2*Math.PI*Math.sqrt(Lv*Cv));
    var sb2=makeApp(), c2=circuit(sb2);
    var V2=c2.add('AC_SOURCE',Vp,f0), R2=c2.add('RESISTOR',Rv),
        L2=c2.add('INDUCTOR',Lv), C2=c2.add('CAPACITOR',Cv);
    c2.wire(V2,'L',R2,'L'); c2.wire(R2,'R',L2,'L'); c2.wire(L2,'R',C2,'L'); c2.wire(C2,'R',V2,'R');
    var sr2=await solveCircuit(sb2,c2);
    scenario('AC-4b RLC 직렬 공진: |I|=V/R, 위상 0');
    check('해석 성공', sr2.valid, sr2.error);
    if(sr2.valid){
      approx('|I|=V/R=5', Math.abs(sr2.branchCurrents[R2.id]), Vp/Rv, 1e-5);
      var p2=sr2.acPhasor.compI[R2.id];
      approx('위상≈0', Math.atan2(p2.im,p2.re), 0, 0, 1e-5);
    }
  })();

  /* ── AC-5: L 단독 / C 단독 ── */
  await (async function(){
    var Vp=100, f=60, w=2*Math.PI*f;
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('AC_SOURCE',Vp,f), L=c.add('INDUCTOR',0.1);
    c.wire(V,'L',L,'L'); c.wire(L,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('AC-5a L 단독: |I|=V/(ωL)');
    check('해석 성공', sr.valid, sr.error);
    if(sr.valid) approx('|I|', Math.abs(sr.branchCurrents[L.id]), Vp/(w*0.1));

    var sb2=makeApp(), c2=circuit(sb2);
    var V2=c2.add('AC_SOURCE',Vp,f), C2=c2.add('CAPACITOR',50e-6);
    c2.wire(V2,'L',C2,'L'); c2.wire(C2,'R',V2,'R');
    var sr2=await solveCircuit(sb2,c2);
    scenario('AC-5b C 단독: |I|=V·ωC');
    check('해석 성공', sr2.valid, sr2.error);
    if(sr2.valid) approx('|I|', Math.abs(sr2.branchCurrents[C2.id]), Vp*w*50e-6);
  })();

  /* ── AC-6: RLC 병렬 — 가지 전류와 전원 전류 ── */
  await (async function(){
    var Vp=100, f=60, w=2*Math.PI*f, Rv=50, Lv=0.1, Cv=50e-6;
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('AC_SOURCE',Vp,f), R=c.add('RESISTOR',Rv),
        L=c.add('INDUCTOR',Lv), C=c.add('CAPACITOR',Cv);
    var JA=c.add('JUNCTION_4'), JB=c.add('JUNCTION_4');
    var wSrc=c.wire(V,'L',JA,'L');
    var wR=c.wire(JA,'R',R,'L'); c.wire(R,'R',JB,'L');
    var wLw=c.wire(JA,'T',L,'L'); c.wire(L,'R',JB,'T');
    var wCw=c.wire(JA,'B',C,'L'); c.wire(C,'R',JB,'B');
    c.wire(JB,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('AC-6 RLC 병렬 가지 전류');
    check('해석 성공', sr.valid, sr.error);
    if(!sr.valid) return;
    approx('|I_R|=V/R', Math.abs(sr.branchCurrents[R.id]), Vp/Rv);
    approx('|I_L|=V/(ωL)', Math.abs(sr.branchCurrents[L.id]), Vp/(w*Lv));
    approx('|I_C|=V·ωC', Math.abs(sr.branchCurrents[C.id]), Vp*w*Cv);
    var Isrc=Vp*Math.hypot(1/Rv, w*Cv-1/(w*Lv));
    approx('|I_src|=V·|Y|', Math.abs(sr.branchCurrents[V.id]), Isrc);
    /* 정션을 지나는 도선 전류 크기 = 해당 가지 페이저 크기 */
    approx('|I|(src도선)', sr.wireCurrents[wSrc.id], Isrc);
    approx('|I|(JA→R)', sr.wireCurrents[wR.id], Vp/Rv);
    approx('|I|(JA→L)', sr.wireCurrents[wLw.id], Vp/(w*Lv));
    approx('|I|(JA→C)', sr.wireCurrents[wCw.id], Vp*w*Cv);
  })();

  /* ── MIX-1: DC+AC 혼합 — 중첩의 원리 ──
   *   12V DC + 10V(peak) 60Hz AC + R=100 직렬.
   *   실제 물리: i(t) = 0.12 + 0.1·cos(ωt) → 피크 0.22A, AC 성분 0.1A */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var Vdc=c.add('DC_SOURCE',12), Vac=c.add('AC_SOURCE',10,60), R=c.add('RESISTOR',100);
    /* AC 전원 극성을 DC 와 순방향 정렬 (R.R→Vac.R, Vac.L→Vdc.R):
     *   KVL: Vdc + Vac·cos(ωt) = I·R → i(t)=0.12+0.1cos(ωt) */
    c.wire(Vdc,'L',R,'L'); c.wire(R,'R',Vac,'R'); c.wire(Vac,'L',Vdc,'R');
    var sr=await solveCircuit(sb,c);
    scenario('MIX-1 DC+AC 중첩: i(t)=0.12+0.1cos(ωt)');
    check('해석 성공', sr.valid, sr.error);
    if(!sr.valid) return;
    check('acPhasor 존재', !!sr.acPhasor);
    if(!sr.acPhasor) return;
    var p=sr.acPhasor.compI[R.id];
    approx('AC 성분 |I_ac|=0.1', Math.hypot(p.re,p.im), 0.1, 1e-5);
    approx('표시 전류 = 피크 0.22', Math.abs(sr.branchCurrents[R.id]), 0.22, 1e-5);
    approx('순시 i(0)=0.22', Math.abs(sr.acPhasor.instCurrent(R.id,0)), 0.22, 1e-5);
    var T=1/60;
    approx('순시 i(T/2)=0.02', Math.abs(sr.acPhasor.instCurrent(R.id,T/2)), 0.02, 1e-3);
  })();

  /* ── MIX-2: 서로 다른 주파수 AC 2개 → 명시적 오류 (묵음 오답 금지) ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V1=c.add('AC_SOURCE',100,60), V2=c.add('AC_SOURCE',50,50), R=c.add('RESISTOR',100);
    c.wire(V1,'L',R,'L'); c.wire(R,'R',V2,'L'); c.wire(V2,'R',V1,'R');
    var sr=await solveCircuit(sb,c);
    scenario('MIX-2 주파수 다른 AC 전원 → 오류');
    expectError('주파수 불일치 오류', sr, '주파수');
  })();

  /* ── TR-1: RL 직렬 과도: τ=L/R, I∞=V/R ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',12), R=c.add('RESISTOR',100), L=c.add('INDUCTOR',10e-3);
    c.wire(V,'L',R,'L'); c.wire(R,'R',L,'L'); c.wire(L,'R',V,'R');
    await solveCircuit(sb,c);
    var td=sb.App.TransientGraph.getTransientData();
    scenario('TR-1 RL 과도: τ=L/R=100µs, I∞=0.12');
    check('과도 데이터 존재', !!td);
    if(!td) return;
    var f=td.byId[L.id];
    check('L 핏 존재', !!f);
    if(!f) return;
    approx('τ=1e-4', f.tau, 10e-3/100, 1e-4);
    approx('I∞=0.12', f.amp, 0.12, 1e-4);
    check('증가형', f.isRising===true);
    var bm=td.branchModel&&td.branchModel.byComp[L.id];
    check('branchModel: i0=0', bm && Math.abs(bm.i0)<1e-9, bm&&('i0='+bm.i0));
    check('branchModel: |iinf|=0.12', bm && Math.abs(Math.abs(bm.iinf)-0.12)<1e-4, bm&&('iinf='+bm.iinf));
  })();

  /* ── TR-2: RC 과도 (Thevenin): R1=100 직렬, C ∥ R2=300 ──
   *   τ = (R1∥R2)·C = 75·1e-4 = 7.5ms, I0 = V/R1 = 0.12 */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',12), Ra=c.add('RESISTOR',100), Rb=c.add('RESISTOR',300);
    var C=c.add('CAPACITOR',100e-6);
    var JA=c.add('JUNCTION_3'), JB=c.add('JUNCTION_3');
    c.wire(V,'L',Ra,'L'); c.wire(Ra,'R',JA,'L');
    c.wire(JA,'R',Rb,'L'); c.wire(Rb,'R',JB,'L');
    c.wire(JA,'B',C,'L'); c.wire(C,'R',JB,'B');
    c.wire(JB,'R',V,'R');
    await solveCircuit(sb,c);
    var td=sb.App.TransientGraph.getTransientData();
    scenario('TR-2 RC 과도 (Thevenin): τ=(R1∥R2)C=7.5ms, I0=0.12');
    check('과도 데이터 존재', !!td);
    if(!td) return;
    var f=td.byId[C.id];
    check('C 핏 존재', !!f);
    if(!f) return;
    approx('τ=7.5ms', f.tau, 7.5e-3, 1e-3);
    approx('I0=0.12', f.amp, 0.12, 1e-3);
    check('감소형', f.isRising===false);
  })();

  /* ── TR-3: RLC 직렬 부족감쇠 — 파형·극점 vs 해석해 ──
   *   R=10, L=10mH, C=100µF: α=R/2L=500, ω0=1000, ωd=√(ω0²−α²)=866.03
   *   i(t)=V/(ωd·L)·e^(−αt)·sin(ωd·t), 첫 피크 t*=atan(ωd/α)/ωd */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var Vv=12, Rv=10, Lv=10e-3, Cv=100e-6;
    var V=c.add('DC_SOURCE',Vv), R=c.add('RESISTOR',Rv),
        L=c.add('INDUCTOR',Lv), C=c.add('CAPACITOR',Cv);
    c.wire(V,'L',R,'L'); c.wire(R,'R',L,'L'); c.wire(L,'R',C,'L'); c.wire(C,'R',V,'R');
    await solveCircuit(sb,c);
    var td=sb.App.TransientGraph.getTransientData();
    scenario('TR-3 RLC 부족감쇠: 파형 피크·극점 vs 해석해');
    check('과도 데이터 존재', !!td);
    if(!td) return;
    if(!td.curves||!td.poles||td.tMax==null){
      check('curves/poles 노출 (getTransientData 확장)', false, 'curves='+!!td.curves+' poles='+!!td.poles);
      return;
    }
    var alpha=Rv/(2*Lv), w0=1/Math.sqrt(Lv*Cv), wd=Math.sqrt(w0*w0-alpha*alpha);
    var arr=td.curves[L.id];
    check('L 파형 존재', !!arr);
    if(arr){
      /* 해석해 피크와 비교 */
      var tPk=Math.atan(wd/alpha)/wd;
      var iPk=Vv/(wd*Lv)*Math.exp(-alpha*tPk)*Math.sin(wd*tPk);
      var got=0;
      for(var k=0;k<arr.length;k++) if(Math.abs(arr[k])>got) got=Math.abs(arr[k]);
      approx('첫 피크 |i|', got, iPk, 0.03);
      /* 파형 전체 대조: 표본 5점 (진동 부호는 canonicalize 로 뒤집힐 수 있어 |·| 비교) */
      var N=arr.length, maxErr=0;
      for(var s=1;s<=5;s++){
        var kk=Math.round(N*0.12*s), t=kk/(N-1)*td.tMax;
        var want=Vv/(wd*Lv)*Math.exp(-alpha*t)*Math.sin(wd*t);
        maxErr=Math.max(maxErr, Math.abs(Math.abs(arr[kk])-Math.abs(want)));
      }
      approx('파형 5점 최대 오차 < 피크의 3%', maxErr/iPk, 0, 0, 0.03);
    }
    check('진동 판정', td.poles.isOsc===true);
    approx('α≈500', td.poles.alpha, alpha, 0.2);
    approx('ωd≈866', td.poles.omegad, wd, 0.08);
  })();

  /* ── TR-4: RLC 직렬 과감쇠 — 파형 vs 2중 지수 해석해 ──
   *   R=100, L=10mH, C=100µF: α=5000, ω0=1000 → s1,2 = −α ± √(α²−ω0²)
   *   i(t) = V/(L·(s1−s2)) · (e^{s1 t} − e^{s2 t}) */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var Vv=12, Rv=100, Lv=10e-3, Cv=100e-6;
    var V=c.add('DC_SOURCE',Vv), R=c.add('RESISTOR',Rv),
        L=c.add('INDUCTOR',Lv), C=c.add('CAPACITOR',Cv);
    c.wire(V,'L',R,'L'); c.wire(R,'R',L,'L'); c.wire(L,'R',C,'L'); c.wire(C,'R',V,'R');
    await solveCircuit(sb,c);
    var td=sb.App.TransientGraph.getTransientData();
    scenario('TR-4 RLC 과감쇠: 파형 vs 2중 지수 해석해');
    check('과도 데이터 존재', !!td&&!!td.curves);
    if(!td||!td.curves) return;
    var alpha=Rv/(2*Lv), w0=1/Math.sqrt(Lv*Cv), rt=Math.sqrt(alpha*alpha-w0*w0);
    var s1=-alpha+rt, s2=-alpha-rt;
    var arr=td.curves[L.id]; check('L 파형 존재', !!arr); if(!arr) return;
    var N=arr.length, maxErr=0, ipk=0;
    for(var k=0;k<N;k++){
      var t=k/(N-1)*td.tMax;
      var want=Vv/(Lv*(s1-s2))*(Math.exp(s1*t)-Math.exp(s2*t));
      ipk=Math.max(ipk,Math.abs(want));
      maxErr=Math.max(maxErr,Math.abs(arr[k]-want));
    }
    approx('전 구간 최대 오차 < 피크의 3%', maxErr/ipk, 0, 0, 0.03);
    check('비진동 판정', td.poles.isOsc===false);
    check('부호: 최대 진폭 지점이 양(+)', (function(){var m=0,v=0;for(var k=0;k<N;k++){if(Math.abs(arr[k])>m){m=Math.abs(arr[k]);v=arr[k];}}return v>0;})());
  })();

  /* ── TR-5: RLC 직렬 임계감쇠 — i(t) = (V/L)·t·e^{−αt}, R=2√(L/C)=20Ω ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var Vv=12, Lv=10e-3, Cv=100e-6, Rv=2*Math.sqrt(Lv/Cv);
    var V=c.add('DC_SOURCE',Vv), R=c.add('RESISTOR',Rv),
        L=c.add('INDUCTOR',Lv), C=c.add('CAPACITOR',Cv);
    c.wire(V,'L',R,'L'); c.wire(R,'R',L,'L'); c.wire(L,'R',C,'L'); c.wire(C,'R',V,'R');
    await solveCircuit(sb,c);
    var td=sb.App.TransientGraph.getTransientData();
    scenario('TR-5 RLC 임계감쇠 (R=2√(L/C)=20Ω): i=(V/L)·t·e^{−αt}');
    check('과도 데이터 존재', !!td&&!!td.curves);
    if(!td||!td.curves) return;
    var alpha=Rv/(2*Lv);
    var arr=td.curves[L.id]; check('L 파형 존재', !!arr); if(!arr) return;
    var N=arr.length, maxErr=0, ipk=Vv/Lv/alpha*Math.exp(-1);
    for(var k=0;k<N;k++){
      var t=k/(N-1)*td.tMax;
      var want=Vv/Lv*t*Math.exp(-alpha*t);
      maxErr=Math.max(maxErr,Math.abs(arr[k]-want));
    }
    approx('전 구간 최대 오차 < 피크의 3%', maxErr/ipk, 0, 0, 0.03);
    approx('피크 = V/(L·α·e)', (function(){var m=0;for(var k=0;k<N;k++)m=Math.max(m,arr[k]);return m;})(), ipk, 0.03);
    check('비진동 판정 (경계)', td.poles.isOsc===false);
  })();

  /* ── TR-6: 부족감쇠 표시 방향 일관성 — 같은 회로에서 R만 바꿔도
   *   최대 진폭 지점(최초 돌입)은 항상 +. (마지막 샘플 기준이던 회귀 방지) ── */
  await (async function(){
    scenario('TR-6 부족감쇠 곡선 부호 일관성 (R=3·5·10·15Ω)');
    for(var i=0;i<4;i++){
      var Rv=[3,5,10,15][i];
      var sb=makeApp(), c=circuit(sb);
      var V=c.add('DC_SOURCE',12), R=c.add('RESISTOR',Rv),
          L=c.add('INDUCTOR',10e-3), C=c.add('CAPACITOR',100e-6);
      c.wire(V,'L',R,'L'); c.wire(R,'R',L,'L'); c.wire(L,'R',C,'L'); c.wire(C,'R',V,'R');
      await solveCircuit(sb,c);
      var td=sb.App.TransientGraph.getTransientData();
      var arr=td&&td.curves&&td.curves[L.id];
      var ok=false;
      if(arr){ var m=0,v=0; for(var k=0;k<arr.length;k++){ if(Math.abs(arr[k])>m){m=Math.abs(arr[k]);v=arr[k];} } ok=v>0; }
      check('R='+Rv+'Ω: 최대 진폭 지점 부호 +', ok);
      check('R='+Rv+'Ω: 진동 판정', !!(td&&td.poles&&td.poles.isOsc));
    }
  })();

  /* ── DC-12: 전력 보존 — 전원 공급전력 = Σ I²R (병렬+직렬 혼합) ── */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',12), R1=c.add('RESISTOR',100), R2=c.add('RESISTOR',200), R3=c.add('RESISTOR',50);
    var JA=c.add('JUNCTION_3'), JB=c.add('JUNCTION_3');
    c.wire(V,'L',R3,'L'); c.wire(R3,'R',JA,'L');
    c.wire(JA,'R',R1,'L'); c.wire(R1,'R',JB,'L');
    c.wire(JA,'B',R2,'L'); c.wire(R2,'R',JB,'B');
    c.wire(JB,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('DC-12 전력 보존: V·I_src = Σ I²R (50 + 100∥200)');
    var Req=50+(100*200)/300, I=12/Req;
    approx('I_src=12/Req', Math.abs(sr.branchCurrents[V.id]), I, 1e-6);
    var Psrc=12*Math.abs(sr.branchCurrents[V.id]);
    var Pr=0; [R1,R2,R3].forEach(function(r){ var i=sr.branchCurrents[r.id]; Pr+=i*i*r.value; });
    approx('ΣI²R = V·I', Pr, Psrc, 1e-6);
    var Pr_v=0; [R1,R2,R3].forEach(function(r){ Pr_v+=Math.abs(sr.componentVoltages[r.id]*sr.branchCurrents[r.id]); });
    approx('Σ|V·I|_R = V·I', Pr_v, Psrc, 1e-6);
  })();

  /* ── AC-7: 유효전력 — RC 직렬에서 전원 평균전력 = I_rms²·R (역률 반영) ──
   *   피상전력 V_rms·I_rms 와 다르다: P = V_rms·I_rms·cosφ, cosφ=R/|Z| */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var Vp=220, f=60, Rv=100, Cv=20e-6;   /* Xc=132.6Ω → 역률 0.60 */
    var V=c.add('AC_SOURCE',Vp,f), R=c.add('RESISTOR',Rv), C=c.add('CAPACITOR',Cv);
    c.wire(V,'L',R,'L'); c.wire(R,'R',C,'L'); c.wire(C,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('AC-7 유효전력: 전원 P_avg = I_rms²R = V_rms·I_rms·cosφ');
    var w=2*Math.PI*f, Xc=1/(w*Cv), Z=Math.hypot(Rv,Xc);
    var Ip=Vp/Z, Irms=Ip/Math.SQRT2, Vrms=Vp/Math.SQRT2;
    var Preal=Irms*Irms*Rv, Sapp=Vrms*Irms;
    approx('|I|=V/|Z|', sr.branchCurrents[R.id], Ip, 1e-6);
    /* 페이저로 계산한 전원 평균전력 Re(V·I*)/2 */
    var ph=sr.acPhasor, vI=ph.compI[V.id], vV=ph.compV[V.id];
    var Pph=Math.abs((vV.re*vI.re+vV.im*vI.im)/2);
    approx('페이저 Re(V·I*)/2 = I_rms²R', Pph, Preal, 1e-6);
    check('피상전력 ≠ 유효전력 (역률 '+(Rv/Z).toFixed(3)+')', Math.abs(Sapp-Preal)/Sapp>0.05, 'S='+Sapp+' P='+Preal);
  })();

  /* ── DC-13: RL ∥ RC 병렬 — 정상상태에서 RC 가지는 정확히 0, RL 가지는 V/R1 ──
   *   (배지가 전류 0 인 가지를 건너뛰어 빈칸으로 보이던 표시 버그의 물리 근거) */
  await (async function(){
    var sb=makeApp(), c=circuit(sb);
    var V=c.add('DC_SOURCE',12), R1=c.add('RESISTOR',100), L=c.add('INDUCTOR',10e-3),
        R2=c.add('RESISTOR',200), C=c.add('CAPACITOR',100e-6);
    var JA=c.add('JUNCTION_3'), JB=c.add('JUNCTION_3');
    c.wire(V,'L',JA,'L');
    c.wire(JA,'R',R1,'L'); c.wire(R1,'R',L,'L'); c.wire(L,'R',JB,'L');
    var wA=c.wire(JA,'B',R2,'L'); var wB=c.wire(R2,'R',C,'L'); var wC=c.wire(C,'R',JB,'B');
    c.wire(JB,'R',V,'R');
    var sr=await solveCircuit(sb,c);
    scenario('DC-13 RL∥RC 병렬: RC 가지 0A, RL 가지 V/R1');
    check('유효', sr.valid, sr.error);
    approx('I_R1=I_L=0.12', sr.branchCurrents[R1.id], 0.12, 1e-6);
    approx('I_R2=0', Math.abs(sr.branchCurrents[R2.id]), 0, 0, 1e-12);
    approx('I_C=0', Math.abs(sr.branchCurrents[C.id]), 0, 0, 1e-12);
    [wA,wB,wC].forEach(function(w){ approx('도선 '+w.id+' 전류=0', Math.abs(sr.wireCurrents[w.id]), 0, 0, 1e-12); });
    check('RC 가지 도선 전류가 null 이 아님 (배지 표시 대상)', sr.wireCurrents[wB.id]!=null);
    approx('전원 전류=0.12', Math.abs(sr.branchCurrents[V.id]), 0.12, 1e-6);
  })();

  /* ════════════ 결과 출력 ════════════ */
  var totalChecks=0, totalFail=0, failScen=0;
  console.log('');
  _results.forEach(function(s){
    totalChecks+=s.checks.length;
    totalFail+=s.failed;
    if(s.failed>0) failScen++;
    var mark=s.failed>0?'✗':'✓';
    console.log(mark+' '+s.name+(s.failed>0?('  ['+s.failed+'/'+s.checks.length+' 실패]'):''));
    s.checks.forEach(function(ch){
      if(!ch.ok) console.log('    ✗ '+ch.label+'  '+ch.detail);
    });
  });
  console.log('');
  console.log('─'.repeat(60));
  console.log('시나리오 '+_results.length+'개 / 검증 '+totalChecks+'건 / 실패 '+totalFail+'건');
  process.exit(totalFail>0?1:0);
}

main().catch(function(e){ console.error(e); process.exit(2); });
