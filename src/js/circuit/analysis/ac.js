(function(){
'use strict';
var App=window.App;
App.Analysis=App.Analysis||{};

/* ════════════════════════════════════════════════════════════════════
 * App.Analysis.ac — 소신호 페이저 해석 (각주파수 ω)
 *
 *   동작점 xOP 에서 각 소자가 선형화한 어드미턴스를 복소 MNA 에 찍는다.
 *   선형 회로에서는 곧 정확해(교류 정상상태)이고, 비선형 소자가 있으면
 *   동작점 주위의 소신호 응답(증폭기 이득 등)이다.
 *   AC 전원만 기전력을 갖고 DC 전원은 0 V(단락)로 스탬프된다.
 *
 *   반환: { xr, xi, err }  (실수부·허수부 벡터)
 * ════════════════════════════════════════════════════════════════════ */
App.Analysis.ac=function(nl, devs, xOP, omega, opts){
  var MNA=App.MNA;
  var N=MNA.layout(nl.nodeCount, devs);
  var nNode=nl.nodeCount-1;

  function attempt(gmin, rser){
    var sys=MNA.makeSystem(N,true);
    var ctx={mode:'ac', rser:rser};
    for(var i=0;i<devs.length;i++) devs[i].loadAC(sys, xOP, omega, ctx);
    if(gmin>0) for(var n=0;n<nNode;n++) sys.add(n,n,gmin);
    return MNA.solve(sys);
  }
  var s=attempt(0,0) || attempt(1e-9,0) || attempt(1e-9,1e-4);
  if(!s) return{xr:null, xi:null, err:'교류 회로를 해석할 수 없습니다'};
  return{xr:s.re, xi:s.im, err:null};
};

}());
