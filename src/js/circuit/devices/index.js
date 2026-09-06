(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Devices — 소자 모델 레지스트리
 *
 *   솔버는 소자 종류를 모른다. 소자는 자기 스탬프를 스스로 찍는다.
 *
 *   Device = {
 *     id, type, comp, nodes:[nA,nB], i0, i1,   // i0/i1 = 미지수 인덱스 (접지 = -1)
 *     extra: 0|1,  k: 보조 미지수 인덱스 (layout 이 부여),
 *     linear: bool, dynamic: bool,
 *     loadOP (sys, x, ctx)        동작점 — 현재 반복해 x 에서 선형화해 누적
 *     loadAC (sys, xOP, ω, ctx)   소신호 페이저 스탬프 (복소 sys)
 *     outputs (x)        → {v, i}           실수 (ports[0]→ports[1] 방향 +)
 *     outputsAC (xr, xi, ω) → {v:{re,im}, i:{re,im}}
 *   }
 *   ctx: { mode:'op'|'ac', rser:전원 직렬저항 폴백 }
 *
 *   연결점 소자(분기점·접지·라벨)와 스위치는 스탬프가 없어 create 가 null 을
 *   돌려준다 — 노드 병합은 Netlist 가, 전류는 도선 후처리(post/wires)가 맡는다.
 * ════════════════════════════════════════════════════════════════════ */
App.Devices=(function(){
  var reg={};
  var SMALL_R=1e-6;   /* 이상 소자 근사: 인덕터 DC·0Ω 저항의 최소 저항 */

  function register(type, factory){ reg[type]=factory; }
  function idx(n){ return n-1; }
  function V(x,i){ return i>=0?x[i]:0; }

  /* 공통 골격 */
  function base(comp, nn){
    return{
      id:comp.id, type:comp.type, comp:comp, nodes:nn,
      i0:idx(nn[0]), i1:idx(nn[1]),
      extra:0, k:-1, linear:true, dynamic:false, disabled:false,
      loadOP:function(){}, loadAC:function(){},
      outputs:function(x){ return{v:V(x,this.i0)-V(x,this.i1), i:0}; },
      outputsAC:function(xr,xi){ return{v:{re:V(xr,this.i0)-V(xr,this.i1), im:V(xi,this.i0)-V(xi,this.i1)}, i:{re:0,im:0}}; },
    };
  }

  function create(comp, nl){
    var f=reg[comp.type]; if(!f) return null;
    var nn=nl.compNodes[comp.id]; if(!nn) return null;
    return f(comp, nn, nl);
  }
  function createAll(nl){
    var devs=[];
    nl.comps.forEach(function(c){ var d=create(c,nl); if(d) devs.push(d); });
    return devs;
  }

  return{register:register, create:create, createAll:createAll, base:base, idx:idx, V:V, SMALL_R:SMALL_R};
})();

}());
