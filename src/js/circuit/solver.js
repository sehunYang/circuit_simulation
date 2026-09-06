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
  function analyze(comps, wires, closed){
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
      return App.Post.buildView(nl, devs, op.x, ac, omega);
    }catch(e){
      return App.Post.fail('내부 오류: '+e.message);
    }
  }

  function solve(comps, wires, opts){
    opts=opts||{};
    var wantClosed=opts.closed!==false;
    if(!comps.length) return _empty();
    var hasSwitches=comps.some(function(c){return c.type===TYPE.SWITCH;});
    var closedView=analyze(comps, wires, true);
    closedView.switchState='closed';
    var openView=hasSwitches?analyze(comps, wires, false):closedView;
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
    App.State.solverResult=solve(App.State.components, App.State.wires, {closed:_closedForMode()});
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
