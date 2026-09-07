(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Guide — 처음 쓰는 사람을 위한 안내 계층
 *
 *   세 가지를 맡는다. 회로를 푸는 일과는 무관하고, 화면에 무엇을 띄울지만 정한다.
 *
 *   1) 시작 카드 (#start-guide)  캔버스가 비었을 때만 — 무엇을 해야 하는지 한 줄과
 *      바로 눌러 볼 수 있는 버튼(예제 회로·POE·도움말). 소자를 놓으면 사라진다.
 *   2) 상태 알림 (#status-chip)  회로에 오류·경고가 있을 때만 — 무엇이 잘못됐는지와
 *      "어떻게 고치는지" 한 줄. 실행을 눌렀는데 아무 일도 안 일어나는 상황을 없앤다.
 *   3) 도움말 (#help-panel)      모드·표시 토글·단축키·팔레트를 한 장에.
 * ════════════════════════════════════════════════════════════════════ */
App.Guide=(function(){
  var _guide,_chip,_help,_dismissed=false;

  /* 오류 문구 → 고치는 방법 (오류 문자열은 솔버의 계약이라 그대로 두고 여기서 덧붙인다) */
  var FIX={
    '전원이 없습니다':'전지(DC)나 교류 전원(AC)을 놓으세요. 회로이론 표기(⏚)에서는 VCC 라벨에 전위를 주어도 됩니다.',
    '단락 회로가 감지되었습니다':'전원 양단이 저항 없이 이어져 있습니다. 사이 어딘가에 저항이나 전구를 넣으세요.',
    '부품이 없습니다':'왼쪽 팔레트에서 소자를 끌어다 놓으세요.',
    '해가 수렴하지 않습니다':'다이오드·트랜지스터의 값이나 연결을 확인하세요. 베이스 저항이 너무 작으면 수렴하지 않을 수 있습니다.',
    '레일 전위를 쓰려면 접지(GND)가 있어야 합니다':'⏚ 를 켜고 접지(GND)를 하나 놓아 기준을 만드세요.',
  };
  function _fixHint(msg){
    if(!msg) return '';
    var k=Object.keys(FIX);
    for(var i=0;i<k.length;i++) if(msg.indexOf(k[i])>=0) return FIX[k[i]];
    if(/전압의 전원이 병렬/.test(msg)) return '전압이 다른 두 전원을 직접 병렬로 이을 수 없습니다. 한쪽을 빼거나 속성에서 내부저항 r 을 주세요.';
    if(/주파수가 서로 다른/.test(msg)) return '교류 전원의 주파수를 서로 같게 맞추세요.';
    return '';
  }

  function init(){
    _guide=document.getElementById('start-guide');
    _chip =document.getElementById('status-chip');
    _help =document.getElementById('help-panel');
    if(!_guide||!_chip) return;
    /* 시작 카드 버튼 */
    _bind('sg-demo', function(){ _demoCircuit(); });
    _bind('sg-poe',  function(){ if(App.POE) App.POE.open(); });
    _bind('sg-help', function(){ toggleHelp(true); });
    _bind('sg-close',function(){ _dismissed=true; refresh(); });
    _bind('help-btn',    function(){ toggleHelp(); });
    _bind('help-close-btn', function(){ toggleHelp(false); });
    _bind('chip-close', function(){ _chip.classList.remove('visible'); });
    App.Events.on('state:changed', refresh);
    App.Events.on('solver:done',   refresh);
    App.Events.on('mode:changed',  refresh);
    refresh();
  }
  function _bind(id,fn){
    var e=document.getElementById(id); if(!e) return;
    e.addEventListener('click',function(ev){ ev.stopPropagation(); fn(); });
    e.addEventListener('pointerdown',function(ev){ ev.stopPropagation(); });
  }

  /* ── 시작 카드 · 상태 알림 갱신 ── */
  function refresh(){
    if(!_guide||!_chip) return;
    var S=App.State, editish=(S.mode==='edit'||S.mode==='run');
    var empty=S.components.length===0;
    _guide.classList.toggle('visible', empty && !_dismissed && editish);
    /* 모바일에서는 팔레트가 햄버거(☰) 뒤에 있으므로 안내 문구를 바꾼다 */
    var lead=_guide.querySelector('.sg-lead');
    if(lead){
      var mob=window.innerWidth<=480;
      lead.innerHTML = mob
        ? '왼쪽 위 <b>☰</b> 를 눌러 소자를 꺼내 놓고, 포트(●)를 끌어 도선으로 이으세요. 포트끼리 맞닿게 놓으면 저절로 이어집니다. 소자를 누르면 전류·전압이 바로 나옵니다.'
        : '왼쪽 팔레트에서 소자를 <b>끌어다 놓고</b>, 포트(●)를 끌어 도선으로 이으세요. 포트끼리 맞닿게 놓으면 저절로 이어집니다. 소자를 클릭하면 전류·전압이 바로 나옵니다.';
    }
    if(!empty) _dismissed=false;      /* 다시 비면 안내를 되살린다 */

    var sr=S.solverResult, msg='', hint='', cls='warn';
    if(!empty && sr){
      if(!sr.valid && sr.error){ msg='⚠ '+sr.error; hint=_fixHint(sr.error); cls='err'; }
      else if(sr.valid && sr.warnings && sr.warnings.length){ msg='⚠ '+sr.warnings[0];
        hint=/연결되지 않은/.test(sr.warnings[0])
          ? '소자의 포트(●)를 끌어 도선으로 이어 회로를 닫으세요. 포트끼리 맞닿게 놓아도 저절로 이어집니다.'
          : ''; }
    }
    if(msg && editish){
      _chip.innerHTML='';
      var t=document.createElement('div'); t.className='chip-msg'; t.textContent=msg; _chip.appendChild(t);
      if(hint){ var h=document.createElement('div'); h.className='chip-hint'; h.textContent=hint; _chip.appendChild(h); }
      var x=document.createElement('span'); x.className='chip-x'; x.textContent='✕';
      x.addEventListener('click',function(e){ e.stopPropagation(); _chip.classList.remove('visible'); });
      _chip.appendChild(x);
      _chip.classList.remove('err','warn'); _chip.classList.add(cls,'visible');
    } else {
      _chip.classList.remove('visible');
    }
  }

  /* ── 예제 회로: 전지 + 스위치 + 전구 한 바퀴 (POE 예제와 같은 배치 규칙) ── */
  function _demoCircuit(){
    var S=App.State;
    var old=S.components.map(function(c){return c.id;});
    old.forEach(function(id){ if(S.getComponent(id)) S.removeComponent(id); });
    function add(type,gx,gy,rot,value,value2,extra){
      var c={id:S.genId(),type:TYPE[type],gridX:gx,gridY:gy,rotation:rot||0,value:value||0,value2:(value2==null?null:value2),label:''};
      if(extra) Object.keys(extra).forEach(function(k){c[k]=extra[k];});
      S.addComponent(c); return c;
    }
    var dc=add('DC_SOURCE',46,48,90,12); dc.rint=0;
    var sw=add('SWITCH',46,47,90,0,null,{autoFor:dc.id});
    var bulb=add('BULB',49,46,0,100,1,{label:'전구'});
    [[dc,'L',sw,'R','H-first'],[sw,'L',bulb,'L','V-first'],[bulb,'R',dc,'R','V-first']].forEach(function(w){
      S.addWire({id:S.genId(),fromId:w[0].id,fromPort:w[1],toId:w[2].id,toPort:w[3],direction:w[4]});
    });
    S.selectedId=bulb.id;
    var el=document.getElementById('canvas-container'), vt=S.viewTransform;
    vt.scale=1.4; vt.offsetX=el.clientWidth/2-48*CELL_SIZE*vt.scale; vt.offsetY=el.clientHeight/2-47.5*CELL_SIZE*vt.scale;
    App.Events.emit('viewport:changed');
    App.Solver.solveNow();
    App.PropPanel.show(bulb.id);
    showErrorToast('예제 회로를 만들었습니다 — 아래 “실행”을 눌러 전자가 흐르는 것을 보세요',3200);
  }

  /* ── 확인 대화상자 ──
   *   confirm({title, message, okLabel, danger, onOk}) — 되돌리기 어려운 동작 앞에 세운다.
   *   Esc·바깥 클릭·취소는 아무 일도 하지 않는다. */
  function confirm(opts){
    var back=document.getElementById('confirm-back');
    if(!back){ if(window.confirm(opts.title)) opts.onOk&&opts.onOk(); return; }
    var box=back.querySelector('.cf-box');
    back.querySelector('.cf-title').textContent=opts.title||'확인';
    back.querySelector('.cf-msg').textContent=opts.message||'';
    var ok=back.querySelector('#cf-ok'), cancel=back.querySelector('#cf-cancel');
    ok.textContent=opts.okLabel||'확인';
    ok.classList.toggle('danger',!!opts.danger);
    function close(){
      back.classList.remove('visible');
      document.removeEventListener('keydown',onKey,true);
      ok.onclick=null; cancel.onclick=null; back.onpointerdown=null;
    }
    function onKey(e){
      if(e.key==='Escape'){ e.stopPropagation(); close(); }
      else if(e.key==='Enter'){ e.stopPropagation(); close(); opts.onOk&&opts.onOk(); }
    }
    ok.onclick=function(e){ e.stopPropagation(); close(); opts.onOk&&opts.onOk(); };
    cancel.onclick=function(e){ e.stopPropagation(); close(); };
    back.onpointerdown=function(e){ if(e.target===back){ e.stopPropagation(); close(); } };
    box.onpointerdown=function(e){ e.stopPropagation(); };
    document.addEventListener('keydown',onKey,true);
    back.classList.add('visible');
    ok.focus();
  }

  /* ── 도움말 ── */
  function toggleHelp(force){
    if(!_help) return;
    var on=(force==null)?!_help.classList.contains('visible'):!!force;
    _help.classList.toggle('visible',on);
  }

  /* ── 그래프·파형 패널 다시 열기 (닫으면 되살릴 방법이 없던 문제) ── */
  function toggleGraph(){
    var S=App.State;
    if(S.mode==='edit'){ showErrorToast('실행 모드에서 그래프·파형을 볼 수 있습니다',1800); return; }
    var g=document.getElementById('transient-panel'), s=document.getElementById('scope-panel');
    var openG=g&&g.classList.contains('visible'), openS=s&&s.classList.contains('visible');
    if(openG||openS){ App.TransientGraph.hide(); if(App.Scope) App.Scope.hide(); return; }
    App.TransientGraph.show(); if(App.Scope) App.Scope.show();
    var nowG=g&&g.classList.contains('visible'), nowS=s&&s.classList.contains('visible');
    if(!nowG&&!nowS) showErrorToast('이 회로에는 그릴 파형이 없습니다 — 축전기·코일을 넣거나 교류 전원을 쓰면 그래프가 생깁니다',2600);
  }

  return{init:init, refresh:refresh, confirm:confirm, toggleHelp:toggleHelp, toggleGraph:toggleGraph, demoCircuit:_demoCircuit};
})();

}());
