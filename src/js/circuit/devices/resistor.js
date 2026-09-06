(function(){
'use strict';
var App=window.App, D=App.Devices;

/* 저항 — g = 1/R. 전구도 같은 스탬프를 쓴다(밝기는 outputs 의 P 로). */
D.register(TYPE.RESISTOR, function(comp, nn){
  var d=D.base(comp, nn);
  function g(){ var R=comp.value>0?comp.value:D.SMALL_R; return 1/R; }
  d.loadOP=function(sys){ sys.stampG(this.i0,this.i1,g()); };
  d.loadAC=function(sys){ sys.stampG(this.i0,this.i1,g()); };
  d.outputs=function(x){ var v=D.V(x,this.i0)-D.V(x,this.i1); return{v:v, i:g()*v}; };
  d.outputsAC=function(xr,xi){
    var vr=D.V(xr,this.i0)-D.V(xr,this.i1), vi=D.V(xi,this.i0)-D.V(xi,this.i1), G=g();
    return{v:{re:vr,im:vi}, i:{re:G*vr,im:G*vi}};
  };
  return d;
});

}());
