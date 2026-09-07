(function(){
'use strict';
var App=window.App, D=App.Devices;

/* 인덕터 — 가지 전류 i_k 를 보조 미지수로 둔다 (ports[0]→ports[1] 방향 +).
 *   동작점: v0 − v1 − r·i_k = 0 (r = SMALL_R, 이상 단락의 특이행렬 회피)
 *   교류:   v0 − v1 − jωL·i_k = 0
 *   시간 영역(동반 모델):
 *     사다리꼴  v_n = (2L/h)(i_n − i_{n−1}) − v_{n−1}  → v0 − v1 − R·i_k = −(R·i_{n−1} + v_{n−1}), R = 2L/h
 *     후진 오일러 v_n = (L/h)(i_n − i_{n−1})           → R = L/h, 우변 −R·i_{n−1}
 *     t=0⁺(init): 전류 0 인 인덕터 = 개방 (i_k = 0)
 *   노드 KCL: 노드0 에서 i_k 유출, 노드1 로 유입
 *   상호유도 (this.partner, this.M — Devices.createAll 이 연결):
 *     v = L·di/dt + M·di_p/dt  → 교류 행에 −jωM·i_p, 시간 영역 행에 −R_M·i_p (R_M = 2M/h, BE 는 M/h)
 *     와 우변 −R_M·i_p(n−1) 이 더해진다. 짝도 자기 행에 같은 항을 찍으므로 행렬은 대칭.
 *     동작점(DC 정상상태)에서는 di/dt = 0 이라 상호 항이 없다. */
D.register(TYPE.INDUCTOR, function(comp, nn){
  var d=D.base(comp, nn);
  d.extra=1; d.dynamic=true;
  var hv=0, hi=0;
  function L(){ return comp.value>0?comp.value:1e-12; }
  function branch(sys){
    var k=this.k;
    sys.add(this.i0,k,1); sys.add(this.i1,k,-1);
    sys.add(k,this.i0,1); sys.add(k,this.i1,-1);
  }
  d.loadOP=function(sys){ branch.call(this,sys); sys.add(this.k,this.k,-D.SMALL_R); };
  d.loadAC=function(sys,xOP,omega){
    branch.call(this,sys); sys.addI(this.k,this.k,-omega*L());
    if(this.partner&&this.partner.k>=0) sys.addI(this.k,this.partner.k,-omega*this.M);
  };
  d.loadTran=function(sys,x,ctx){
    var k=this.k;
    if(ctx.init){   /* i_k = i0 (기본 0 — 스위치를 여는 과도면 닫힌 정상상태의 전류) */
      var st=ctx.initState&&ctx.initState[this.id];
      sys.add(this.i0,k,1); sys.add(this.i1,k,-1); sys.add(k,k,1); sys.rhs(k, st?(st.i||0):0); return; }
    branch.call(this,sys);
    var be=(ctx.method==='BE'), R=(be?1:2)*L()/ctx.h;
    sys.add(k,k,-R);
    sys.rhs(k, be ? -R*hi : -(R*hi+hv));
    if(this.partner&&this.partner.k>=0){
      var RM=(be?1:2)*this.M/ctx.h;
      sys.add(k,this.partner.k,-RM);
      sys.rhs(k, -RM*this.partner.histI());
    }
  };
  d.histI=function(){ return hi; };
  d.tranInit=function(x){ hi=x[this.k]; hv=D.V(x,this.i0)-D.V(x,this.i1); };
  d.tranUpdate=function(x){
    var i=x[this.k], v=D.V(x,this.i0)-D.V(x,this.i1);
    hi=i; hv=v;
    return{v:v, i:i, phi:L()*i};
  };
  d.outputs=function(x){ return{v:D.V(x,this.i0)-D.V(x,this.i1), i:x[this.k]}; };
  d.outputsAC=function(xr,xi){
    return{v:{re:D.V(xr,this.i0)-D.V(xr,this.i1), im:D.V(xi,this.i0)-D.V(xi,this.i1)},
           i:{re:xr[this.k], im:xi[this.k]}};
  };
  return d;
});

}());
