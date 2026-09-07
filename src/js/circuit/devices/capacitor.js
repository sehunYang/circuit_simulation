(function(){
'use strict';
var App=window.App, D=App.Devices;

/* 축전기
 *   동작점: 개방(스탬프 없음).  교류: Y = jωC.
 *   시간 영역(동반 모델):
 *     사다리꼴  i_n = (2C/h)(v_n − v_{n−1}) − i_{n−1}   → G = 2C/h, I_eq = −(G·v_{n−1} + i_{n−1})
 *     후진 오일러 i_n = (C/h)(v_n − v_{n−1})            → G = C/h,  I_eq = −G·v_{n−1}
 *     t=0⁺(init): 충전 안 된 축전기 = 단락 (G_SHORT) — "스위치를 닫는 순간" */
D.register(TYPE.CAPACITOR, function(comp, nn){
  var d=D.base(comp, nn);
  d.dynamic=true;
  var G_SHORT=1e6;
  var hv=0, hi=0, curG=0, curIeq=0, initMode=false;
  function C(){ return comp.value>0?comp.value:1e-12; }
  /* 동작점: 개방 — 다만 C 에 비례하는 미소 누설(C·1e-11 S)을 둔다. 직렬 축전기 사이 노드가 떠서
   *   특이행렬 폴백(gmin)이 전압을 한쪽에 몰아 주는 것을 막고, 전하 보존 V ∝ 1/C 분배가 그대로 나온다.
   *   1000 µF 에 12 V 면 0.12 pA — 표시(0 A 판정 1 pA 아래)에도, 다른 회로에도 영향이 없다. */
  d.loadOP=function(sys){ sys.stampG(this.i0,this.i1,C()*1e-11); };
  d.loadAC=function(sys,xOP,omega){ sys.stampGI(this.i0,this.i1,omega*C()); };
  d.loadTran=function(sys,x,ctx){
    if(ctx.init){   /* v = v0 (기본 0 = 단락 — 스위치를 여는 과도면 닫힌 정상상태의 전압): G_SHORT 와 노턴 전류원 */
      var st=ctx.initState&&ctx.initState[this.id], v0=st?(st.v||0):0;
      initMode=true; curG=G_SHORT; curIeq=-G_SHORT*v0;
      sys.stampG(this.i0,this.i1,G_SHORT); if(v0) sys.stampI(this.i0,this.i1,curIeq); return; }
    initMode=false;
    if(ctx.method==='BE'){ curG=C()/ctx.h; curIeq=-curG*hv; }
    else { curG=2*C()/ctx.h; curIeq=-(curG*hv+hi); }
    sys.stampG(this.i0,this.i1,curG);
    sys.stampI(this.i0,this.i1,curIeq);
  };
  d.tranInit=function(x){ hv=D.V(x,this.i0)-D.V(x,this.i1); hi=curG*hv+curIeq; };
  d.tranUpdate=function(x){
    var v=D.V(x,this.i0)-D.V(x,this.i1);
    var i=curG*v+curIeq;
    hv=v; hi=i;
    return{v:v, i:i, Q:C()*v};
  };
  d.outputs=function(x){ return{v:D.V(x,this.i0)-D.V(x,this.i1), i:0}; };
  d.outputsAC=function(xr,xi,omega){
    var vr=D.V(xr,this.i0)-D.V(xr,this.i1), vi=D.V(xi,this.i0)-D.V(xi,this.i1), wC=omega*C();
    return{v:{re:vr,im:vi}, i:{re:-wC*vi, im:wC*vr}};   /* I = jωC·V */
  };
  return d;
});

}());
