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

  /* 공통 골격.
   *   portCurrents(x) → { portId: 소자로 '들어가는' 전류 }  — 도선 전류 후처리가 쓴다.
   *   2포트 기본값: ports[0] 로 +i 유입, ports[1] 로 −i (= i 유출).
   *   3포트(BJT)는 자기 것을 정의한다. */
  function base(comp, nn){
    var ports=(COMP_PORTS[comp.type]||'LR').split('');
    return{
      id:comp.id, type:comp.type, comp:comp, nodes:nn, ports:ports,
      i0:idx(nn[0]), i1:idx(nn[1]), i2:(nn.length>2?idx(nn[2]):-1),
      extra:0, k:-1, linear:true, dynamic:false, disabled:false,
      reset:function(){},
      loadOP:function(){}, loadAC:function(){},
      /* ── 시간 영역 (기본: 정적 소자 = 동작점 스탬프 그대로) ──
       *   loadTran(sys, x, ctx)  ctx = {mode:'tran', t, h, method:'BE'|'TR', init}
       *   tranInit(x0)           t=0⁺ 해로 이력 초기화
       *   tranUpdate(x, ctx)     한 스텝 확정 후 이력 갱신 → 이 스텝의 outputs */
      loadTran:function(sys,x,ctx){ this.loadOP(sys,x,ctx); },
      tranInit:function(){},
      tranUpdate:function(x){ return this.outputs(x); },
      /* outputs 객체 → 포트별 유입 전류 (파형 후처리용) */
      portCurrentsOut:function(o){ var r={}; r[this.ports[0]]=o.i; r[this.ports[1]]=-o.i; return r; },
      outputs:function(x){ return{v:V(x,this.i0)-V(x,this.i1), i:0}; },
      outputsAC:function(xr,xi){ return{v:{re:V(xr,this.i0)-V(xr,this.i1), im:V(xi,this.i0)-V(xi,this.i1)}, i:{re:0,im:0}}; },
      portCurrents:function(x){
        var o=this.outputs(x), r={}; r[this.ports[0]]=o.i; r[this.ports[1]]=-o.i; return r;
      },
      portCurrentsAC:function(xr,xi,omega){
        var o=this.outputsAC(xr,xi,omega), r={};
        r[this.ports[0]]=o.i; r[this.ports[1]]={re:-o.i.re,im:-o.i.im}; return r;
      },
    };
  }

  /* pn 접합 전압 제한 (SPICE pnjlim) — NR 이 지수 폭발로 발산하지 않게 */
  var VT=0.025852;
  function pnjlim(vnew, vold, vt, vcrit){
    if(vnew>vcrit && Math.abs(vnew-vold)>2*vt){
      if(vold>0){ var arg=1+(vnew-vold)/vt; vnew = arg>0 ? vold+vt*Math.log(arg) : vcrit; }
      else vnew=vt*Math.log(vnew/vt);
    }
    return vnew;
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

  return{register:register, create:create, createAll:createAll, base:base, idx:idx, V:V,
         SMALL_R:SMALL_R, VT:VT, pnjlim:pnjlim};
})();

}());
