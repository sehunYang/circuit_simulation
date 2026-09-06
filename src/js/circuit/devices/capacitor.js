(function(){
'use strict';
var App=window.App, D=App.Devices;

/* 축전기 — 동작점: 개방(스탬프 없음), 교류: Y = jωC */
D.register(TYPE.CAPACITOR, function(comp, nn){
  var d=D.base(comp, nn);
  d.dynamic=true;
  function C(){ return comp.value>0?comp.value:1e-12; }
  d.loadOP=function(){};
  d.loadAC=function(sys,xOP,omega){ sys.stampGI(this.i0,this.i1,omega*C()); };
  d.outputs=function(x){ return{v:D.V(x,this.i0)-D.V(x,this.i1), i:0}; };
  d.outputsAC=function(xr,xi,omega){
    var vr=D.V(xr,this.i0)-D.V(xr,this.i1), vi=D.V(xi,this.i0)-D.V(xi,this.i1), wC=omega*C();
    /* I = jωC·V */
    return{v:{re:vr,im:vi}, i:{re:-wC*vi, im:wC*vr}};
  };
  return d;
});

}());
