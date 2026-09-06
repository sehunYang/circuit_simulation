(function(){
'use strict';
var App=window.App;
App.Analysis=App.Analysis||{};

/* ════════════════════════════════════════════════════════════════════
 * App.Analysis.op — DC 동작점
 *
 *   선형 회로: 한 번 풀면 끝. 비선형 소자(다이오드·BJT)가 있으면
 *   Newton-Raphson: 소자가 현재 반복해 x 에서 선형화한 스탬프를 찍고,
 *   |Δx| 가 허용치 아래로 내려올 때까지 반복한다.
 *
 *   특이행렬 폴백 순서:
 *     (1) 그대로  (2) 모든 노드에 gmin = 1e-9 S  (3) + 전원 직렬저항 1e-4 Ω
 *   (부동 노드·열린 스위치·병렬 전원이 여기서 해결된다)
 *
 *   병렬 전압원: 같은 노드 쌍을 공유하는 전원끼리 기전력이 다르면 오류,
 *   같으면 중복을 비활성(전류 0)으로 둔다 — 기존 계약 유지.
 *
 *   반환: { x: Float64Array, err: string|null, iterations }
 * ════════════════════════════════════════════════════════════════════ */
App.Analysis.op=function(nl, devs, opts){
  opts=opts||{};
  var MNA=App.MNA;
  var N=MNA.layout(nl.nodeCount, devs);
  var nNode=nl.nodeCount-1;
  var maxIter=opts.maxIter||60, tolA=1e-9, tolR=1e-6;

  /* ── 병렬 전압원 검사 ── */
  var srcs=devs.filter(function(d){return d.isSource;});
  srcs.forEach(function(d){ d.disabled=false; });
  for(var a=0;a<srcs.length;a++){
    for(var b=a+1;b<srcs.length;b++){
      var A=srcs[a], B=srcs[b];
      if(A.disabled||B.disabled) continue;
      var same=(A.nodes[0]===B.nodes[0]&&A.nodes[1]===B.nodes[1]);
      var rev =(A.nodes[0]===B.nodes[1]&&A.nodes[1]===B.nodes[0]);
      if(!same&&!rev) continue;
      var Ea=A.emfOP(), Eb=same?B.emfOP():-B.emfOP();
      if(Math.abs(Ea-Eb)>0.5)
        return{x:null, err:'서로 다른 전압의 전원이 병렬 연결되어 있습니다 (V₁='+A.emfOP()+'V, V₂='+B.emfOP()+'V)'};
      B.disabled=true;
    }
  }

  var nonlinear=devs.some(function(d){return !d.linear;});

  function assemble(x, gmin, rser){
    var sys=MNA.makeSystem(N,false);
    var ctx={mode:'op', rser:rser};
    for(var i=0;i<devs.length;i++) devs[i].loadOP(sys, x, ctx);
    if(gmin>0) for(var n=0;n<nNode;n++) sys.add(n,n,gmin);
    return sys;
  }

  function solveWith(gmin, rser){
    var x=new Float64Array(N), iter=0;
    if(!nonlinear){
      var sol=MNA.solve(assemble(x,gmin,rser));
      return sol?{x:sol,iterations:1}:null;
    }
    for(iter=0;iter<maxIter;iter++){
      var xn=MNA.solve(assemble(x,gmin,rser));
      if(!xn) return null;
      var conv=true;
      for(var i=0;i<N;i++){
        var dx=Math.abs(xn[i]-x[i]);
        if(dx>tolA+tolR*Math.abs(xn[i])){ conv=false; }
      }
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

}());
