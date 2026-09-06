(function(){
'use strict';
var App=window.App;
App.Post=App.Post||{};

/* ════════════════════════════════════════════════════════════════════
 * App.Post.buildView — 해석 결과(x, 페이저) → 화면·패널이 읽는 뷰 객체
 *
 *   뷰 = 예전 solverResult 와 같은 모양 (소비자 호환):
 *     { valid, error, warnings,
 *       nodeVoltages, portVoltages, componentVoltages, branchCurrents,
 *       wireCurrents, wireSignedI, componentNodes,
 *       acPhasor: { omega, compI, compV, dcCompI, dcCompV, instCurrent, instVoltage } | null }
 *
 *   표시값 규약 (기존 계약):
 *     순수 DC        → 부호 있는 실수
 *     AC (혼합 포함) → 피크 |I_dc| + |I_ac|
 *   실효값·평균전력은 acPhasor 의 dc/ac 성분에서 소비자가 계산한다
 *   (App.Post.display 참고).
 *
 *   연결점 소자(분기점·접지·라벨)와 열린 스위치는 전류 0·전압 = 노드차,
 *   닫힌 스위치 전류는 도선 후처리(passI)에서 온다.
 * ════════════════════════════════════════════════════════════════════ */
var OVERCURRENT=1e6;   /* 이상 소자 근사의 발산 전류 → '단락' */

function fail(msg){
  return{valid:false,error:msg,warnings:[],
         nodeVoltages:{},portVoltages:{},componentVoltages:{},
         branchCurrents:{},wireCurrents:{},wireSignedI:{},componentNodes:{},acPhasor:null};
}

App.Post.buildView=function(nl, devs, x, ac, omega){
  var comps=nl.comps, wires=nl.wires, cn=nl.compNodes;
  var isAC=!!ac;
  var devById={};
  devs.forEach(function(d){ devById[d.id]=d; });

  function V(i){ return i>=1?x[i-1]:0; }
  function Vr(i){ return i>=1?ac.xr[i-1]:0; }
  function Vi(i){ return i>=1?ac.xi[i-1]:0; }

  /* 소자별 DC {v,i} · AC {v,i} */
  var dc={}, acc={};
  comps.forEach(function(c){
    var d=devById[c.id], nn=cn[c.id];
    if(d){
      dc[c.id]=d.outputs(x);
      if(isAC) acc[c.id]=d.outputsAC(ac.xr, ac.xi, omega);
    } else {
      dc[c.id]={v:V(nn[0])-V(nn[1]), i:0};
      if(isAC) acc[c.id]={v:{re:Vr(nn[0])-Vr(nn[1]), im:Vi(nn[0])-Vi(nn[1])}, i:{re:0,im:0}};
    }
    if(d&&d.disabled){ dc[c.id].i=0; if(isAC) acc[c.id].i={re:0,im:0}; }
  });

  /* 포트별 유입 전류 (BJT 는 단자마다 다르다) */
  var portI={};
  comps.forEach(function(c){
    var d=devById[c.id]; if(!d) return;
    portI[c.id]=d.portCurrents(x);
  });

  /* 도선 채널: [dc] 또는 [dc, re, im] — 포트로 '들어가는' 전류 */
  var K=isAC?3:1;
  var wc=App.Post.wireChannels(nl, function(c, portId){
    if(NODE_TYPES[c.type]||nl.passthrough[c.id]) return null;   /* 연결점·닫힌 스위치: 필링 대상 */
    if(c.type===TYPE.SWITCH) return [0,0,0].slice(0,K);          /* 열린 스위치: 0 */
    var d=devById[c.id]; if(!d) return null;
    var pi=portI[c.id][portId]; if(pi==null) return null;
    var a=[pi];
    if(isAC){ var pa=d.portCurrentsAC(ac.xr,ac.xi,omega)[portId]||{re:0,im:0}; a.push(pa.re, pa.im); }
    return a;
  }, K);
  /* 닫힌 스위치 전류 채우기 */
  Object.keys(wc.passI).forEach(function(id){
    var p=wc.passI[id];
    dc[id].i=p[0]; if(isAC) acc[id].i={re:p[1],im:p[2]};
  });

  /* 과전류 = 단락 */
  for(var id in dc){
    var mag=Math.abs(dc[id].i)+(isAC?Math.hypot(acc[id].i.re,acc[id].i.im):0);
    if(mag>OVERCURRENT) return fail('단락 회로가 감지되었습니다');
  }

  function disp(d, a){ return isAC ? Math.abs(d)+Math.hypot(a.re,a.im) : d; }

  var nodeV={};
  for(var k=0;k<nl.nodeCount;k++) nodeV[k]=isAC?disp(V(k),{re:Vr(k),im:Vi(k)}):V(k);
  var portV={};
  comps.forEach(function(c){
    portV[c.id]={};
    var pm=nl.portNode[c.id]; if(!pm) return;
    Object.keys(pm).forEach(function(p){ portV[c.id][p]=nodeV[pm[p]]||0; });
  });
  var compV={}, compI={}, dcCompI={}, dcCompV={}, acI={}, acV={};
  comps.forEach(function(c){
    var d=dc[c.id], a=isAC?acc[c.id]:null;
    compV[c.id]=isAC?disp(d.v,a.v):d.v;
    compI[c.id]=isAC?disp(d.i,a.i):d.i;
    dcCompI[c.id]=d.i; dcCompV[c.id]=d.v;
    if(isAC){ acI[c.id]=a.i; acV[c.id]=a.v; }
  });

  var wireSignedI={}, wireI={};
  wires.forEach(function(w){
    var ch=wc.chan[w.id];
    if(!isAC){ wireSignedI[w.id]=ch[0]; wireI[w.id]=Math.abs(ch[0]); return; }
    var acMag=Math.hypot(ch[1],ch[2]), mag=Math.abs(ch[0])+acMag;
    var signRef=Math.abs(ch[0])>mag*0.01?ch[0]:(Math.abs(ch[1])>acMag*0.01?ch[1]:ch[2]);
    wireSignedI[w.id]=(signRef>=0?1:-1)*mag; wireI[w.id]=mag;
  });

  var view={
    valid:true, error:null, warnings:nl.warnings.slice(),
    nodeVoltages:nodeV, portVoltages:portV,
    componentVoltages:compV, branchCurrents:compI,
    wireCurrents:wireI, wireSignedI:wireSignedI,
    componentNodes:cn, acPhasor:null,
    /* 원시 성분 (표시 규약과 무관한 물리량)
     *   out[id]  : 소자 outputs 전체 (P, brightness, region, iB/iC/iE, vBE/vCE …)
     *   portI[id]: 포트별 유입 전류 */
    dc:{compI:dcCompI, compV:dcCompV, out:dc, portI:portI,
        nodeV:(function(){var o={};for(var k=0;k<nl.nodeCount;k++)o[k]=V(k);return o;})()},
  };
  if(isAC){
    function inst(ph, dcm, id, t){
      var p=ph[id], base=dcm[id]||0;
      if(!p) return base;
      return base + p.re*Math.cos(omega*t) - p.im*Math.sin(omega*t);
    }
    view.acPhasor={
      omega:omega, compI:acI, compV:acV, dcCompI:dcCompI, dcCompV:dcCompV,
      instCurrent:function(id,t){ return inst(acI,dcCompI,id,t); },
      instVoltage:function(id,t){ return inst(acV,dcCompV,id,t); },
    };
  }
  return view;
};

/* ── 표시 규약의 단일 구현 ──
 *   display(view, compId) → { peak, rms, avg, dc, acMag, unit:'A' } (전류)
 *   displayV(view, compId) → 같은 구조 (전압)
 *   i(t) = I_dc + Re[I·e^{jωt}]:  peak = |I_dc|+|I|,  rms = √(I_dc² + |I|²/2),  avg = I_dc */
function _disp(dcv, ph){
  var mag=ph?Math.hypot(ph.re,ph.im):0;
  return{dc:dcv, acMag:mag, peak:Math.abs(dcv)+mag, rms:Math.sqrt(dcv*dcv+mag*mag/2), avg:dcv};
}
App.Post.display=function(view, id){
  if(!view||!view.valid) return null;
  var dcv=view.dc?view.dc.compI[id]:view.branchCurrents[id];
  var ph=view.acPhasor?view.acPhasor.compI[id]:null;
  var o=_disp(dcv||0, ph); o.unit='A'; return o;
};
App.Post.displayV=function(view, id){
  if(!view||!view.valid) return null;
  var dcv=view.dc?view.dc.compV[id]:view.componentVoltages[id];
  var ph=view.acPhasor?view.acPhasor.compV[id]:null;
  var o=_disp(dcv||0, ph); o.unit='V'; return o;
};
/* 평균전력 P = V_dc·I_dc + Re(V·I*)/2  (역률 포함) */
App.Post.avgPower=function(view, id){
  if(!view||!view.valid) return null;
  var vd=view.dc?view.dc.compV[id]:view.componentVoltages[id];
  var idc=view.dc?view.dc.compI[id]:view.branchCurrents[id];
  var P=(vd||0)*(idc||0);
  if(view.acPhasor){
    var V=view.acPhasor.compV[id]||{re:0,im:0}, I=view.acPhasor.compI[id]||{re:0,im:0};
    P+=(V.re*I.re+V.im*I.im)/2;
  }
  return P;
};
App.Post.fail=fail;

}());
