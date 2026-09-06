(function(){
'use strict';
var App=window.App, D=App.Devices;

/* 전압원 (DC·AC 공용) — 보조 미지수 i_k = + 단자(ports[0])에서 전원 내부로
 *   들어가는 전류 (ports[0]→ports[1] 방향 +, 다른 소자와 같은 규약).
 *   동작점(mode 'op'): DC 전원 = 기전력, AC 전원 = 0 V (평균)
 *   교류(mode 'ac') : AC 전원 = 진폭(실수 페이저), DC 전원 = 0 V
 *   내부저항 r (comp.rint, 기본 0): v0 − v1 − r·i_k = E
 *   ctx.rser > 0 이면 특이행렬 폴백 직렬저항을 추가한다.
 *   disabled(중복 병렬 전원): 스탬프 대신 i_k = 0 으로 고정. */
function factory(comp, nn){
  var d=D.base(comp, nn);
  d.extra=1;
  function r(ctx){ return (comp.rint>0?comp.rint:0)+((ctx&&ctx.rser>0)?ctx.rser:0); }
  function stamp(sys,E,ctx){
    var k=this.k;
    if(this.disabled){ sys.add(k,k,1); return; }
    sys.add(this.i0,k,1); sys.add(this.i1,k,-1);
    sys.add(k,this.i0,1); sys.add(k,this.i1,-1);
    var R=r(ctx); if(R>0) sys.add(k,k,-R);
    sys.rhs(k,E);
  }
  d.loadOP=function(sys,x,ctx){ stamp.call(this,sys, comp.type===TYPE.DC_SOURCE?(+comp.value||0):0, ctx); };
  d.loadAC=function(sys,xOP,omega,ctx){ stamp.call(this,sys, comp.type===TYPE.AC_SOURCE?(+comp.value||0):0, ctx); };
  d.outputs=function(x){ return{v:D.V(x,this.i0)-D.V(x,this.i1), i:x[this.k]}; };
  d.outputsAC=function(xr,xi){
    return{v:{re:D.V(xr,this.i0)-D.V(xr,this.i1), im:D.V(xi,this.i0)-D.V(xi,this.i1)},
           i:{re:xr[this.k], im:xi[this.k]}};
  };
  /* 동작점 기전력 (병렬 전원 검사용) */
  d.emfOP=function(){ return comp.type===TYPE.DC_SOURCE?(+comp.value||0):0; };
  d.emfAC=function(){ return comp.type===TYPE.AC_SOURCE?(+comp.value||0):0; };
  d.isSource=true;
  return d;
}
D.register(TYPE.DC_SOURCE, factory);
D.register(TYPE.AC_SOURCE, factory);

}());
