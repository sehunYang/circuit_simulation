(function(){
'use strict';
var App=window.App;
App.Analysis=App.Analysis||{};

/* ════════════════════════════════════════════════════════════════════
 * App.Analysis.tran — 시간 영역 (과도) 해석
 *
 *   t = 0 에 스위치가 닫힌다: 축전기는 충전 안 됨(단락), 인덕터는 전류 0(개방)
 *   으로 t=0⁺ 해를 먼저 구하고(init), 이후 고정 스텝 h 로 적분한다.
 *   opts.initState = {compId:{i}|{v}} 가 있으면(스위치를 "여는" 과도 — 닫힌 정상상태에서 출발)
 *   t=0⁺ 에 인덕터는 그 전류, 축전기는 그 전압을 갖는다 (ctx.initState 로 소자에 전달).
 *   적분: 처음 두 스텝은 후진 오일러(불연속 링잉 억제), 그 뒤 사다리꼴.
 *   매 스텝 소자 동반 모델을 스탬프하고 NR(비선형이면 반복)로 푼다.
 *   AC 전원은 V·cos(ωt), 비선형 소자는 매 스텝 선형화 → 정류 파형이 그대로 나온다.
 *
 *   반환 { t:Float64Array(S+1), outs:{id:[outputs…]}, xs:[Float64Array…], err }
 * ════════════════════════════════════════════════════════════════════ */
App.Analysis.tran=function(nl, devs, opts){
  opts=opts||{};
  var MNA=App.MNA;
  var N=MNA.layout(nl.nodeCount, devs);
  var nNode=nl.nodeCount-1;
  var S=Math.max(50, Math.round(opts.steps||1500));
  var tMax=opts.tMax>0?opts.tMax:1e-3;
  var h=tMax/S;

  /* 병렬 전원 비활성 플래그는 op 가 정했다고 가정 (같은 devs 재사용) */
  function assembleFor(ctx){
    return function(x, gmin, rser){
      var sys=MNA.makeSystem(N,false);
      ctx.rser=rser;
      for(var i=0;i<devs.length;i++) devs[i].loadTran(sys, x, ctx);
      MNA.stampPins(sys, nl);
      if(gmin>0) for(var n=0;n<nNode;n++) sys.add(n,n,gmin);
      return sys;
    };
  }

  var t=new Float64Array(S+1), outs={}, xs=new Array(S+1);
  devs.forEach(function(d){ outs[d.id]=new Array(S+1); });

  /* t = 0⁺ */
  var initState=opts.initState||null;
  var r0=App.Analysis.newton(devs, N, assembleFor({mode:'tran',init:true,t:0,h:h,method:'BE',initState:initState}), null, {maxIter:80});
  if(r0.err) return{err:r0.err};
  var x=r0.x;
  devs.forEach(function(d){ d.tranInit(x); });
  /* 0 번 표본: init 스탬프 기준 outputs */
  devs.forEach(function(d){ outs[d.id][0]=d.tranUpdate(x,{mode:'tran',init:true,t:0,h:h,initState:initState}); });
  t[0]=0; xs[0]=x;

  for(var n=1;n<=S;n++){
    var tn=n*h, method=(n<=2)?'BE':'TR';
    var ctx={mode:'tran',init:false,t:tn,h:h,method:method};
    var r=App.Analysis.newton(devs, N, assembleFor(ctx), x, {maxIter:80, keepLimits:true});
    if(r.err) return{err:r.err+' (t='+tn.toExponential(2)+'s)'};
    x=r.x; t[n]=tn; xs[n]=x;
    for(var di=0;di<devs.length;di++){ var d=devs[di]; outs[d.id][n]=d.tranUpdate(x,ctx); }
  }
  return{t:t, outs:outs, xs:xs, steps:S, tMax:tMax, err:null};
};

}());
