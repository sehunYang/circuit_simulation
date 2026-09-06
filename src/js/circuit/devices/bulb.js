(function(){
'use strict';
var App=window.App, D=App.Devices;

/* 전구 — 저항(value, Ω)과 같은 스탬프. 밝기 = P / 정격전력(value2, W).
 *   교육용 핵심: 밝기는 전류가 아니라 전력(I²R)에 비례한다. */
D.register(TYPE.BULB, function(comp, nn){
  var d=D.base(comp, nn);
  function g(){ var R=comp.value>0?comp.value:D.SMALL_R; return 1/R; }
  function rated(){ return comp.value2>0?comp.value2:1; }
  d.loadOP=function(sys){ sys.stampG(this.i0,this.i1,g()); };
  d.loadAC=function(sys){ sys.stampG(this.i0,this.i1,g()); };
  d.outputs=function(x){
    var v=D.V(x,this.i0)-D.V(x,this.i1), i=g()*v, P=v*i;
    return{v:v, i:i, P:P, brightness:Math.min(1.5, P/rated())};
  };
  d.outputsAC=function(xr,xi){
    var vr=D.V(xr,this.i0)-D.V(xr,this.i1), vi=D.V(xi,this.i0)-D.V(xi,this.i1), G=g();
    return{v:{re:vr,im:vi}, i:{re:G*vr,im:G*vi}};
  };
  return d;
});

}());
