(function(){
'use strict';
var App=window.App, D=App.Devices;

/* p-n 접합 다이오드 — Shockley: I = I_s·(e^{V/(nV_T)} − 1)
 *   ports[0] = 애노드(L), ports[1] = 캐소드(R). 순방향 ≈ 0.6~0.7 V 에서 도통.
 *   NR 선형화: g = dI/dV = I_s/(nV_T)·e^{V/nV_T},  I_eq = I − g·V
 *   pn 접합 전압 제한(pnjlim)으로 지수 폭발을 막고, 역방향의 특이행렬을
 *   피하기 위해 gmin(1e-12 S)을 병렬로 둔다. */
D.register(TYPE.DIODE, function(comp, nn){
  var d=D.base(comp, nn);
  d.linear=false;
  var IS=1e-12, N=1, VT=D.VT, NVT=N*VT, GMIN=1e-12;
  var VCRIT=NVT*Math.log(NVT/(Math.SQRT2*IS));
  var VMAX=1.2;                                  /* e^{V/V_T} 오버플로 방지 (물리적으로도 이 위론 없음) */
  var vLin=0;                                    /* 직전 선형화 전압 (제한용) */
  function cur(v){ v=Math.min(v,VMAX); return IS*(Math.exp(v/NVT)-1); }
  function cond(v){ v=Math.min(v,VMAX); return IS/NVT*Math.exp(v/NVT); }
  d.reset=function(){ vLin=0; };
  d.loadOP=function(sys,x){
    var vRaw=D.V(x,this.i0)-D.V(x,this.i1);
    var v=D.pnjlim(vRaw, vLin, VT, VCRIT); vLin=v;
    /* 제한이 걸렸으면 아직 수렴이 아니다 — 해석기가 반복을 계속하게 알린다
     *   (x 만 비교하면 '제한된 점'에서 선형화한 결과가 x 를 바꾸지 않아 거짓 수렴) */
    this.limited=Math.abs(v-vRaw)>1e-6;
    var g=cond(v)+GMIN, I=cur(v), Ieq=I-g*v;
    sys.stampG(this.i0,this.i1,g);
    sys.stampI(this.i0,this.i1,Ieq);
  };
  d.loadAC=function(sys,xOP){
    var v=D.V(xOP,this.i0)-D.V(xOP,this.i1);
    sys.stampG(this.i0,this.i1,cond(v)+GMIN);
  };
  d.outputs=function(x){
    var v=D.V(x,this.i0)-D.V(x,this.i1), I=cur(v);
    return{v:v, i:I, region:(v>0.4?'forward':'reverse')};
  };
  d.outputsAC=function(xr,xi,omega){
    /* 소신호: 동작점 컨덕턴스는 outputsAC 에 전달되지 않으므로 전류는 후처리에서
     *   포트 전류로 다시 계산하지 않고 v 만 준다 (AC+다이오드는 D 단계 시간 영역이 정답) */
    var vr=D.V(xr,this.i0)-D.V(xr,this.i1), vi=D.V(xi,this.i0)-D.V(xi,this.i1);
    return{v:{re:vr,im:vi}, i:{re:0,im:0}};
  };
  return d;
});

}());
