(function(){
'use strict';
var App=window.App, D=App.Devices;

/* 전압원 (DC·AC 공용) — 보조 미지수 i_k = + 단자(ports[0])에서 전원 내부로
 *   들어가는 전류 (ports[0]→ports[1] 방향 +, 다른 소자와 같은 규약).
 *   동작점(mode 'op'):  DC = 기전력,  AC = 0 V (평균)
 *   교류(mode 'ac')  :  AC = 진폭(실수 페이저),  DC = 0 V
 *   시간 영역(mode 'tran'): DC = 기전력,  AC = V·cos(ωt)  (페이저 Re[V e^{jωt}] 와 같은 위상)
 *   ctx.zeroSources: 극점 계산용 — 모든 기전력 0 (전원 = 단락)
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
  function emfAt(ctx){
    if(ctx&&ctx.zeroSources) return 0;
    var V=+comp.value||0;
    if(comp.type!==TYPE.AC_SOURCE) return V;   /* DC 전원 · 레일 전원 */
    /* AC */
    if(ctx&&ctx.mode==='tran'){ var w=2*Math.PI*(comp.value2||60); return V*Math.cos(w*(ctx.t||0)); }
    return 0;   /* 동작점: 평균 0 */
  }
  d.loadOP=function(sys,x,ctx){ stamp.call(this,sys, emfAt(ctx), ctx); };
  d.loadTran=function(sys,x,ctx){ stamp.call(this,sys, emfAt(ctx), ctx); };
  d.loadAC=function(sys,xOP,omega,ctx){ stamp.call(this,sys, comp.type===TYPE.AC_SOURCE?(+comp.value||0):0, ctx); };
  d.outputs=function(x){ return{v:D.V(x,this.i0)-D.V(x,this.i1), i:x[this.k]}; };
  d.outputsAC=function(xr,xi){
    return{v:{re:D.V(xr,this.i0)-D.V(xr,this.i1), im:D.V(xi,this.i0)-D.V(xi,this.i1)},
           i:{re:xr[this.k], im:xi[this.k]}};
  };
  d.emfOP=function(){ return comp.type!==TYPE.AC_SOURCE?(+comp.value||0):0; };
  d.emfAC=function(){ return comp.type===TYPE.AC_SOURCE?(+comp.value||0):0; };
  d.isSource=true;
  return d;
}
D.register(TYPE.DC_SOURCE, factory);
D.register(TYPE.AC_SOURCE, factory);

/* 레일 전원 — 전위가 있는 레일 라벨 (Netlist.railSource 가 이름당 하나 고른다).
 *   노드 [라벨 노드, 접지] 사이의 직류 전원. 포트는 B 하나뿐이라 포트 전류는
 *   B 로 '들어가는' 전류 = 전원 전류 i_k 이다. */
D.register(TYPE.LABEL, function(comp, nn, nl){
  if(!nl||!nl.railSource||!nl.railSource[comp.id]) return null;
  var d=factory(comp, [nn[0], 0]);
  d.isRail=true;
  d.portCurrentsOut=function(o){ var r={}; r[this.ports[0]]=o.i; return r; };
  d.portCurrents=function(x){ return this.portCurrentsOut(this.outputs(x)); };
  d.portCurrentsAC=function(xr,xi,omega){ var o=this.outputsAC(xr,xi,omega), r={}; r[this.ports[0]]=o.i; return r; };
  return d;
});

}());
