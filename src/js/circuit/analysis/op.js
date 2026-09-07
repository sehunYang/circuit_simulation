(function(){
'use strict';
var App=window.App;
App.Analysis=App.Analysis||{};

/* ════════════════════════════════════════════════════════════════════
 * App.Analysis.newton — 비선형 연립의 NR 반복 (동작점·시간 영역 공용)
 *
 *   assemble(x, gmin, rser) → sys   호출자가 소자 스탬프를 찍어 돌려준다
 *   선형 회로(nonlinear=false)면 한 번 풀고 끝.
 *   수렴: |Δx| < tolA + tolR|x|  이고  접합 전압 제한이 걸린 소자가 없을 때.
 *   특이행렬 폴백: (1) 그대로 (2) 모든 노드에 gmin=1e-9 S (3) + 전원 직렬저항 1e-4 Ω
 *   반환 { x, err, iterations }
 * ════════════════════════════════════════════════════════════════════ */
App.Analysis.newton=function(devs, N, assemble, x0, opts){
  opts=opts||{};
  var MNA=App.MNA;
  var maxIter=opts.maxIter||80, tolA=opts.tolA||1e-9, tolR=opts.tolR||1e-6;
  var nonlinear=devs.some(function(d){return !d.linear;});

  function solveWith(gmin, rser){
    var x=x0?Float64Array.from(x0):new Float64Array(N);
    if(!opts.keepLimits) for(var r0=0;r0<devs.length;r0++) if(devs[r0].reset) devs[r0].reset();
    if(!nonlinear){
      var sol=MNA.solve(assemble(x,gmin,rser));
      return sol?{x:sol,iterations:1}:null;
    }
    for(var iter=0;iter<maxIter;iter++){
      var xn=MNA.solve(assemble(x,gmin,rser));
      if(!xn) return null;
      var conv=true;
      for(var i=0;i<N;i++){
        if(Math.abs(xn[i]-x[i])>tolA+tolR*Math.abs(xn[i])){ conv=false; break; }
      }
      for(var di=0;di<devs.length;di++) if(devs[di].limited){ conv=false; break; }
      x=xn;
      if(conv) return{x:x,iterations:iter+1};
    }
    return{x:x,iterations:maxIter,notConverged:true};
  }
  var r=solveWith(0,0) || solveWith(1e-9,0) || solveWith(1e-9,1e-4);
  if(!r) return{x:null, err:'회로를 해석할 수 없습니다'};
  if(r.notConverged) return{x:r.x, err:'해가 수렴하지 않습니다 (비선형 소자)'};
  return{x:r.x, err:null, iterations:r.iterations};
};

/* ════════════════════════════════════════════════════════════════════
 * App.Analysis.op — DC 동작점
 *
 *   병렬 전압원: 같은 노드 쌍을 공유하는 전원끼리 기전력이 다르면 오류,
 *   같으면 중복을 비활성(전류 0)으로 둔다 — 기존 계약 유지.
 *   반환: { x: Float64Array, err: string|null, iterations }
 * ════════════════════════════════════════════════════════════════════ */
App.Analysis.op=function(nl, devs, opts){
  opts=opts||{};
  var MNA=App.MNA;
  var N=MNA.layout(nl.nodeCount, devs);
  var nNode=nl.nodeCount-1;

  var srcs=devs.filter(function(d){return d.isSource;});
  srcs.forEach(function(d){ d.disabled=false; });
  for(var a=0;a<srcs.length;a++){
    for(var b=a+1;b<srcs.length;b++){
      var A=srcs[a], B=srcs[b];
      if(A.disabled||B.disabled) continue;
      var same=(A.nodes[0]===B.nodes[0]&&A.nodes[1]===B.nodes[1]);
      var rev =(A.nodes[0]===B.nodes[1]&&A.nodes[1]===B.nodes[0]);
      if(!same&&!rev) continue;
      if(A.comp.rint>0||B.comp.rint>0) continue;   /* 내부저항이 있으면 전압이 달라도 해가 있다 (한쪽이 충전됨) */
      var Ea=A.emfOP(), Eb=same?B.emfOP():-B.emfOP();
      if(Math.abs(Ea-Eb)>0.5)
        return{x:null, err:'서로 다른 전압의 전원이 병렬 연결되어 있습니다 (V₁='+A.emfOP()+'V, V₂='+B.emfOP()+'V)'};
      B.disabled=true;
    }
  }

  function assemble(x, gmin, rser){
    var sys=MNA.makeSystem(N,false);
    var ctx={mode:'op', rser:rser, zeroSources:!!opts.zeroSources};
    for(var i=0;i<devs.length;i++) devs[i].loadOP(sys, x, ctx);
    MNA.stampPins(sys, nl);
    if(gmin>0) for(var n=0;n<nNode;n++) sys.add(n,n,gmin);
    return sys;
  }
  return App.Analysis.newton(devs, N, assemble, null, {maxIter:opts.maxIter||60});
};

}());
