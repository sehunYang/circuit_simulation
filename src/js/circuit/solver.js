(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Solver — 해석 오케스트레이터
 *
 *   solve(comps, wires, opts) → Result   (순수 함수 — 테스트용)
 *     그림 → Netlist → 소자(devices) → 동작점(op) → (AC 면) 페이저(ac)
 *     → 뷰(post/result). 스위치가 있으면 '열림'과 '닫힘' 두 상태를 모두 푼다.
 *
 *   Result = 뷰(선택된 상태) + {
 *     open, closed   : 두 상태의 뷰 (스위치 없으면 같은 객체)
 *     hasSwitches, switchesClosed
 *   }
 *   opts.closed : 최상위 뷰를 어느 상태로 할지 (기본 true — 테스트·정적 회로)
 *   앱에서는 run()/solveNow() 가 편집 모드 = 열림, 실행·비유 모드 = 닫힘으로 고른다.
 *
 *   오류 계약 (valid=false, error=문자열):
 *     '전원이 없습니다' · '단락 회로가 감지되었습니다'
 *     '서로 다른 전압의 전원이 병렬 연결…' · '주파수가 서로 다른 교류 전원…'
 *     '회로를 해석할 수 없습니다' · '해가 수렴하지 않습니다'
 *   전원과 이어지지 않은 부분회로는 오류가 아니라 warnings (값 0).
 * ════════════════════════════════════════════════════════════════════ */
App.Solver=(function(){
  var _schedId=null;

  function _empty(){
    return{valid:false,error:null,warnings:[],
           nodeVoltages:{},portVoltages:{},componentVoltages:{},
           branchCurrents:{},wireCurrents:{},wireSignedI:{},componentNodes:{},acPhasor:null};
  }

  /* 한 상태(열림/닫힘)의 해석 */
  function analyze(comps, wires, closed, opts){
    opts=opts||{};
    var nl=App.Netlist.build(comps, wires, {closed:closed});
    if(!nl.valid) return App.Post.fail(nl.error||'토폴로지 오류');
    try{
      var omega=0;
      if(nl.hasAC){
        var freq=null;
        for(var i=0;i<comps.length;i++){
          if(comps[i].type!==TYPE.AC_SOURCE) continue;
          var f=comps[i].value2||60;
          if(freq==null) freq=f;
          else if(Math.abs(f-freq)>1e-9)
            return App.Post.fail('주파수가 서로 다른 교류 전원은 함께 해석할 수 없습니다 ('+freq+'Hz, '+f+'Hz)');
        }
        omega=2*Math.PI*freq;
      }
      var devs=App.Devices.createAll(nl);
      var op=App.Analysis.op(nl, devs, {});
      if(op.err) return App.Post.fail(op.err);
      var ac=null;
      if(nl.hasAC){
        ac=App.Analysis.ac(nl, devs, op.x, omega, {});
        if(ac.err) return App.Post.fail(ac.err);
      }
      var view=App.Post.buildView(nl, devs, op.x, ac, omega);
      if(!view.valid) return view;

      /* ── 시간 영역: 닫힘 상태(t=0 스위치 닫힘)에서만 의미가 있다 ──
       *   동적 소자(L/C)가 있거나, 비선형 소자와 교류가 함께 있으면(정류) 파형을 만든다.
       *   구간 T: 선형이면 극점에서 (5·τ_max, 진동이면 ≥ 3 주기), 교류는 ≥ 4 주기,
       *   비선형 DC 는 R·C, L/R 의 조합으로 어림. */
      if(closed && !opts.noWave){
        var dynamic=devs.some(function(d){return d.dynamic;});
        var nonlinear=devs.some(function(d){return !d.linear;});
        var poles=dynamic?App.Analysis.poles(nl, devs):null;
        view.poles=poles;
        if(dynamic || (nonlinear && nl.hasAC)){
          var T=0;
          if(poles&&poles.domTau>0){
            T=5*poles.domTau;
            if(poles.isOsc&&poles.omegaD>0) T=Math.max(T, 3*2*Math.PI/poles.omegaD);
          } else if(dynamic){
            /* 극점을 못 구하는(비선형) 경우: 직렬 근사 τ */
            var Req=0, Csum=0, Lsum=0;
            comps.forEach(function(c){
              if(c.type===TYPE.RESISTOR||c.type===TYPE.BULB) Req+=c.value||0;
              if(c.type===TYPE.CAPACITOR) Csum+=c.value||0;
              if(c.type===TYPE.INDUCTOR) Lsum+=c.value||0;
            });
            Req=Req||100;
            T=5*Math.max(Req*Csum, Lsum/Req, 1e-6);
          }
          if(nl.hasAC&&omega>0){ T=Math.max(T, 4*2*Math.PI/omega); }
          if(!(T>0)) T=1e-3;
          /* 스텝 수: 가장 빠른 극점(τ_min)을 스텝 25개로 분해해야 사다리꼴 오차가
           *   1% 아래로 내려간다 (과감쇠 RLC 는 τ_fast/τ_slow 가 1/100 이기도 하다) */
          var steps=1500;
          if(poles&&poles.poles.length){
            var tauMin=Infinity;
            poles.poles.forEach(function(z){ if(z.re<0){ var tq=1/(-z.re); if(tq<tauMin) tauMin=tq; } });
            if(isFinite(tauMin)&&tauMin>0) steps=Math.max(steps, Math.ceil(T/(tauMin/25)));
          }
          if(nl.hasAC&&omega>0) steps=Math.max(steps, Math.round(200*T*omega/(2*Math.PI)));
          steps=Math.min(steps, 8000);
          var tr=App.Analysis.tran(nl, devs, {tMax:T, steps:steps});
          if(!tr.err) view.wave=App.Post.buildWave(nl, devs, tr);
          else view.warnings.push('파형 계산 실패: '+tr.err);
        }
      }
      return view;
    }catch(e){
      return App.Post.fail('내부 오류: '+e.message);
    }
  }

  function solve(comps, wires, opts){
    opts=opts||{};
    var wantClosed=opts.closed!==false;
    if(!comps.length) return _empty();
    var hasSwitches=comps.some(function(c){return c.type===TYPE.SWITCH;});
    var closedView=analyze(comps, wires, true, opts);
    closedView.switchState='closed';
    var openView=hasSwitches?analyze(comps, wires, false, opts):closedView;
    if(hasSwitches) openView.switchState='open';
    var top=wantClosed?closedView:openView;
    /* 뷰를 복사하지 않고 메타를 덧붙인다 (open/closed 가 같은 객체여도 무해) */
    top.open=openView; top.closed=closedView;
    top.hasSwitches=hasSwitches; top.switchesClosed=wantClosed;
    return top;
  }

  /* ── 앱 진입점 ── */
  function _closedForMode(){
    return !!(App.State && App.State.mode && App.State.mode!=='edit');
  }
  function solveNow(){
    /* 편집 모드에서는 파형을 만들지 않는다 (그래프·실행·비유가 없으니 쓸 데가 없고,
     *   드래그 중 재해석이 잦다). 실행·비유 모드 진입 시 solveNow 가 다시 불린다. */
    var closed=_closedForMode();
    /* 예외: 비선형 + 교류(정류)는 패널 표시값이 파형에서만 나오므로 편집 모드에도 만든다 */
    var comps=App.State.components;
    var nlAC=comps.some(function(c){return NONLINEAR_TYPES[c.type];}) && comps.some(function(c){return c.type===TYPE.AC_SOURCE;});
    App.State.solverResult=solve(comps, App.State.wires, {closed:closed, noWave:!closed&&!nlAC});
    App.Events.emit('solver:done');
    return App.State.solverResult;
  }
  function run(){
    if(_schedId!==null){
      if(typeof cancelIdleCallback!=='undefined') cancelIdleCallback(_schedId);
      else clearTimeout(_schedId);
      _schedId=null;
    }
    if(typeof requestIdleCallback!=='undefined')
      _schedId=requestIdleCallback(function(){ _schedId=null; solveNow(); },{timeout:80});
    else
      _schedId=setTimeout(function(){ _schedId=null; solveNow(); },30);
  }

  return{solve:solve, run:run, solveNow:solveNow};
})();

}());
