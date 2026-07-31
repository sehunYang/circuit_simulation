(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Main — 앱 부트스트랩 & 오케스트레이션
 *
 *   init(): 캔버스 리사이즈 → 각 모듈 init → 이벤트 배선 →
 *           사이드바/모드바 구성 → (모바일이면) 모바일 UX → 버튼 연결.
 *   모드 FSM: edit ⇄ run ⇄ analogy, capture(일회성 PNG 저장).
 *   이벤트 흐름: state:changed → Solver.run → solver:done → 패널/렌더 갱신.
 * ════════════════════════════════════════════════════════════════════ */
App.Main=(function(){

  /* 지정한 요소들에서 주어진 이벤트들의 전파를 차단 (모바일 터치가
   * 캔버스로 새어 들어가 의도치 않은 제스처를 유발하는 것 방지) */
  function _blockPropagation(el, events){
    if(!el) return;
    events.forEach(function(ev){
      el.addEventListener(ev,function(e){e.stopPropagation();},{passive:false});
    });
  }
  var _TOUCH_EVENTS=['pointerdown','touchstart','touchmove','touchend','click'];

  function _resizeCanvases(){
    var c=document.getElementById('canvas-container');var W=c.clientWidth,H=c.clientHeight;
    ['canvas-bg','canvas-main','canvas-anim'].forEach(function(id){
      var cv=document.getElementById(id);if(cv.width!==W||cv.height!==H){cv.width=W;cv.height=H;}
    });
  }

  function _buildSidebar(){
    var sb=document.getElementById('sidebar');sb.innerHTML='';
    SIDEBAR_ITEMS.forEach(function(item,idx){
      var div=document.createElement('div');div.className='sidebar-item';
      div.id='sidebar-item-'+item.type;  /* J4 위치 계산용 id */
      var cv=document.createElement('canvas');cv.width=32;cv.height=32;cv.style.pointerEvents='none';
      App.Symbols.drawMini(cv,item.type);
      var lbl=document.createElement('span');lbl.className='s-label';lbl.textContent=item.label;
      div.appendChild(cv);div.appendChild(lbl);
      div.addEventListener('pointerdown',function(e){e.stopPropagation();App.Interaction.startSidebarDrag(item,e.clientX,e.clientY,div);});
      sb.appendChild(div);
      if(idx===4){var sep=document.createElement('div');sep.className='sidebar-sep';sb.appendChild(sep);}
    });
    /* ── 전체 초기화 버튼 ── */
    var spacer=document.createElement('div');spacer.style.flex='1';sb.appendChild(spacer);
    var clearSep=document.createElement('div');clearSep.className='sidebar-sep';sb.appendChild(clearSep);
    var clrBtn=document.createElement('div');clrBtn.className='sidebar-item sidebar-clear';
    clrBtn.title='회로 초기화';
    var clrLbl=document.createElement('span');clrLbl.className='s-label';clrLbl.textContent='초기화';
    clrLbl.style.color='#804040';
    var clrIcon=document.createElement('span');clrIcon.style.cssText='font-size:16px;line-height:1;color:#804040';clrIcon.textContent='⌫';
    clrBtn.appendChild(clrIcon);clrBtn.appendChild(clrLbl);
    clrBtn.addEventListener('pointerdown',function(e){
      e.stopPropagation();
      if(!App.State.components.length&&!App.State.wires.length) return;
      showErrorToast('길게 눌러서 초기화하세요',1500);
    });
    /* 롱프레스 1.2초 → 전체 초기화 확인 */
    var clrTimer=null;
    clrBtn.addEventListener('pointerdown',function(e){
      e.stopPropagation();
      clrTimer=setTimeout(function(){
        /* 모드 강제 편집으로 복귀 */
        if(App.State.mode==='run')     App.RunRenderer.stop();
        if(App.State.mode==='analogy') App.AnalogyRenderer.stop();
        _setAnalogyUIHidden(false);   /* UI 복원 (#6) */
        App.State.mode='edit';
        document.querySelectorAll('.mode-btn').forEach(function(b){b.classList.toggle('active',b.dataset.mode==='edit');});
        /* 상태 완전 초기화 */
        while(App.State.components.length) App.State.removeComponent(App.State.components[0].id);
        App.State.selectedId=null;
        App.PropPanel.hide();
        App.EditRenderer.stopSelAnimation();
        App.Events.emit('viewport:changed');
        showErrorToast('회로를 초기화했습니다',2000);
      },1200);
    });
    ['pointerup','pointercancel'].forEach(function(ev){
      clrBtn.addEventListener(ev,function(){clearTimeout(clrTimer);});
    });
    sb.appendChild(clrBtn);
  }

  function _captureCircuit(){
    var srcCv=document.getElementById('canvas-main');
    if(!srcCv) return;
    var W=srcCv.width, H=srcCv.height;
    var off=document.createElement('canvas');
    off.width=W; off.height=H;
    var ctx=off.getContext('2d');
    ctx.clearRect(0,0,W,H);
    var vt=App.State.viewTransform;
    var cellPx=CELL_SIZE*vt.scale;
    var lw=Math.max(1.5,cellPx*0.042);

    /* 도선 */
    ctx.save();
    ctx.strokeStyle='#000000'; ctx.lineWidth=lw;
    ctx.lineCap='round'; ctx.lineJoin='round';
    App.State.wires.forEach(function(wire){
      var from=App.State.getComponent(wire.fromId);
      var to=App.State.getComponent(wire.toId);
      if(!from||!to) return;
      var p1=App.Geo.getPortPixel(from,wire.fromPort);
      var p2=App.Geo.getPortPixel(to,wire.toPort);
      var path=App.Geo.calcWirePath(p1.x,p1.y,p2.x,p2.y,wire.direction);
      ctx.beginPath();
      ctx.moveTo(path[0].x,path[0].y);
      for(var i=1;i<path.length;i++) ctx.lineTo(path[i].x,path[i].y);
      ctx.stroke();
    });
    ctx.restore();

    /* 소자 심볼 */
    App.State.components.forEach(function(comp){
      var gp=App.Geo.gridToPixel(comp.gridX,comp.gridY);
      var cx=gp.x+cellPx/2, cy=gp.y+cellPx/2;
      if(comp.type===TYPE.JUNCTION_3||comp.type===TYPE.JUNCTION_4){
        ctx.save();
        ctx.strokeStyle='#000000'; ctx.lineWidth=lw; ctx.lineCap='round';
        App.State.wires.forEach(function(w){
          var isFrom=(w.fromId===comp.id), isTo=(w.toId===comp.id);
          if(!isFrom&&!isTo) return;
          var jPortPx=isFrom?App.Geo.getPortPixel(comp,w.fromPort):App.Geo.getPortPixel(comp,w.toPort);
          ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(jPortPx.x,jPortPx.y); ctx.stroke();
        });
        ctx.fillStyle='#000000';
        ctx.beginPath(); ctx.arc(cx,cy,lw/2,0,Math.PI*2); ctx.fill();
        ctx.restore();
        return;
      }
      App.Symbols.draw(ctx,comp.type,cx,cy,cellPx,comp.rotation,{color:'#000000'});
    });

    off.toBlob(function(blob){
      var url=URL.createObjectURL(blob);
      var a=document.createElement('a');
      a.href=url; a.download='circuit_'+Date.now()+'.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){URL.revokeObjectURL(url);},1000);
    },'image/png');
  }

  function _updateModeBar(mode){
    document.querySelectorAll('.mode-btn').forEach(function(b){
      b.classList.toggle('active', b.dataset.mode===mode);
    });
  }

  /* 비유 모드 진입/이탈 시 UI 가시성 토글 (#6)
   *   비유 모드에서는 속성 패널·과도그래프·undo/redo·표시토글 바를 모두 숨기고,
   *   편집·실행 모드로 돌아오면 다시 보이게 한다. (모드 전환 바는 항상 표시) */
  function _setAnalogyUIHidden(hidden){
    /* 속성 패널 */
    var pp=document.getElementById('prop-panel');
    if(pp&&hidden) pp.classList.remove('visible');
    /* 과도 응답 그래프 */
    if(hidden && App.TransientGraph) App.TransientGraph.hide();
    /* undo/redo + 표시 토글 바 */
    var undoBar=document.getElementById('undo-bar');
    if(undoBar) undoBar.style.display=hidden?'none':'';
    /* 모바일 전용 버튼(속성·그래프 토글)도 비유 모드에서 숨김 */
    var infoBtn=document.getElementById('mobile-info-btn');
    var graphBtn=document.getElementById('mobile-graph-btn');
    if(hidden){
      if(infoBtn) infoBtn.style.display='none';
      if(graphBtn) graphBtn.style.display='none';
    }
    /* 복원은 각자 로직(state:changed / solver:done)이 자동 처리 */
  }

  function _setupModeBar(){
    document.querySelectorAll('.mode-btn').forEach(function(btn){
      btn.addEventListener('click',function(){
        var next=btn.dataset.mode;
        var cur =App.State.mode;
        if(next===cur) return;

        /* ── 현재 모드 종료 처리 ── */
        if(cur==='run')     App.RunRenderer.stop();
        if(cur==='analogy') App.AnalogyRenderer.stop();

        /* ── 편집 모드 진입 ── */
        if(next==='edit'){
          App.State.mode='edit';
          _updateModeBar('edit');
          App.TransientGraph.hide();
          _setAnalogyUIHidden(false);   /* UI 복원 (#6) */
          App.Events.emit('viewport:changed');
          return;
        }

        /* ── 실행 모드 진입 ── */
        if(next==='run'){
          App.State.mode='run';
          _updateModeBar('run');
          _setAnalogyUIHidden(false);   /* UI 복원 (#6) */
          App.RunRenderer.start();
          App.TransientGraph.show();  /* DC 동적 소자 있으면 그래프 표시 */
          return;
        }

        /* ── 비유 모드 진입 (AC 차단 포함) ── */
        if(next==='analogy'){
          var hasAC=App.State.components.some(function(c){return c.type===TYPE.AC_SOURCE;});
          if(hasAC){
            showErrorToast('교류 전원이 포함된 회로는 수로 비유를 지원하지 않습니다.');
            _updateModeBar(cur);
            return;
          }
          App.State.mode='analogy';
          _updateModeBar('analogy');
          _setAnalogyUIHidden(true);    /* 패널·버튼 숨김 (#6) */
          App.AnalogyRenderer.start();
          return;
        }

        /* ── 촬영 모드 ── */
        if(next==='capture'){
          _captureCircuit();
          _updateModeBar(cur);
          return;
        }
      });
    });
  }

  function placeComponent(item,px,py){
    var g=App.Geo.pixelToGrid(px,py);
    var cg=App.Geo.clampGrid(g.gridX,g.gridY);
    if(App.State.isOccupied(cg.gridX,cg.gridY,null)){
      var f=_findEmpty(cg.gridX,cg.gridY);if(!f){showErrorToast('배치 공간이 없습니다.');return;}cg=f;
    }
    _place(item,cg.gridX,cg.gridY);
  }

  function addComponentCenter(item){
    var c=document.getElementById('canvas-container');
    var g=App.Geo.pixelToGrid(c.clientWidth/2,c.clientHeight/2);
    var f=_findEmpty(g.gridX,g.gridY);if(!f){showErrorToast('배치 공간이 없습니다.');return;}
    _place(item,f.gridX,f.gridY);
  }

  function _findEmpty(gx,gy){
    for(var r=0;r<=15;r++){
      for(var dg=-r;dg<=r;dg++){for(var dr=-r;dr<=r;dr++){
        if(Math.abs(dg)!==r&&Math.abs(dr)!==r) continue;
        var cg=App.Geo.clampGrid(gx+dg,gy+dr);
        if(!App.State.isOccupied(cg.gridX,cg.gridY,null)) return cg;
      }}
    }return null;
  }

  function _place(item,gx,gy){
    var comp={id:App.State.genId(),type:item.type,gridX:gx,gridY:gy,rotation:0,value:item.defValue,value2:item.defValue2,label:''};
    App.State.addComponent(comp);          // state:changed emit
    App.State.autoConnectAdjacent(comp.id); // 인접 포트 자동 연결 (중복 emit 무해)
    App.State.selectedId=comp.id;
    App.PropPanel.show(comp.id);
    App.EditRenderer.startSelAnimation();
    /* 배치 완료 통지 — 모바일에서 사이드바를 자동으로 닫는다
     * (_setupMobileUX 가 'component:placed' 를 구독) */
    App.Events.emit('component:placed',comp);
  }

  /* ── 모바일 전용 UX 설정 (≤480px 또는 모바일 UA) ──────────────────
   * 햄버거 사이드바, 인포/그래프 플로팅 버튼, 패널 슬라이드업,
   * 터치 전파 차단, 토글 버튼 터치 동기화 등. */
  function _setupMobileUX(){
    /* ── 1. 햄버거 사이드바 ── */
    var hbBtn=document.getElementById('hamburger-btn');
    var sbOvl=document.getElementById('sidebar-overlay');
    var sb   =document.getElementById('sidebar');
    hbBtn.style.display='flex';
    function _openSidebar(){sb.classList.add('mobile-open');sbOvl.classList.add('visible');}
    function _closeSidebar(){sb.classList.remove('mobile-open');sbOvl.classList.remove('visible');}
    hbBtn.addEventListener('click',function(e){e.stopPropagation();sb.classList.contains('mobile-open')?_closeSidebar():_openSidebar();});
    sbOvl.addEventListener('click',_closeSidebar);
    App.Events.on('component:placed',_closeSidebar);

    /* ── 2. 인포 버튼 (스타일은 CSS §12에 정의 — 여기선 표시만 토글) ── */
    var infoBtn=document.getElementById('mobile-info-btn');
    App.Events.on('state:changed',function(){
      var sel=App.State.selectedId;
      infoBtn.style.display=sel?'flex':'none';
      if(!sel) document.getElementById('prop-panel').classList.remove('visible');
    });

    var _origShow=App.PropPanel.show.bind(App.PropPanel);

    /* 인포 버튼 클릭: 속성 패널 토글 */
    infoBtn.addEventListener('click',function(e){
      e.stopPropagation();
      var pp=document.getElementById('prop-panel');
      var sel=App.State.selectedId;
      if(pp.classList.contains('visible')){
        pp.classList.remove('visible');
      } else if(sel){
        /* 먼저 visible로 만든 뒤 내용 갱신 (show 재정의가 visible 체크) */
        pp.classList.add('visible');
        _origShow(sel);
      }
    });

    /* 소자 선택 시 패널 자동으로 안 뜨게 — show/refresh 재정의 */
    App.PropPanel.show=function(id){
      var pp=document.getElementById('prop-panel');
      if(pp.classList.contains('visible')) _origShow(id);
    };
    var _origRefresh=App.PropPanel.refresh.bind(App.PropPanel);
    App.PropPanel.refresh=function(){
      var pp=document.getElementById('prop-panel');
      if(pp.classList.contains('visible')&&App.State.selectedId) _origRefresh();
    };

    /* ── 3. 터치 전파 차단 (패널/팝업 → 캔버스 누출 방지) ── */
    _blockPropagation(document.getElementById('prop-panel'), _TOUCH_EVENTS);
    _blockPropagation(document.getElementById('transient-panel'), _TOUCH_EVENTS);
    _blockPropagation(document.getElementById('val-popup'), _TOUCH_EVENTS);

    /* ── 4. 그래프 토글 버튼 ── */
    var graphBtn=document.getElementById('mobile-graph-btn');
    function _syncGraphBtn(){
      var params=App.TransientGraph._extractParams?App.TransientGraph._extractParams():null;
      if(params){
        graphBtn.style.display='flex';
        var tp=document.getElementById('transient-panel');
        graphBtn.classList.toggle('graph-active', tp&&tp.classList.contains('visible'));
      } else {
        graphBtn.style.display='none';
        App.TransientGraph.hide();
      }
    }
    App.Events.on('solver:done', _syncGraphBtn);
    graphBtn.addEventListener('click',function(e){
      e.stopPropagation();
      var tp=document.getElementById('transient-panel');
      if(tp&&tp.classList.contains('visible')){
        App.TransientGraph.hide();
        graphBtn.classList.remove('graph-active');
      } else {
        App.TransientGraph.show();
        graphBtn.classList.add('graph-active');
      }
    });

    /* ── 5. 배경 탭 → 속성 패널 닫기 ──
     * onPointerDown(먼저 등록됨)이 선택을 먼저 처리하므로, 이 리스너가
     * 실행될 때 selectedId 는 이미 확정돼 있다. 소자/도선을 탭하면
     * selectedId 가 설정되어 패널을 유지하고, 빈 곳을 탭한 경우에만 닫는다.
     * (이 조건이 없으면 소자 탭 시 패널이 떴다가 즉시 닫히는 버그 발생) */
    document.getElementById('canvas-main').addEventListener('pointerdown',function(){
      if(App.State.selectedId==null){
        document.getElementById('prop-panel').classList.remove('visible');
      }
    },{passive:true});

    /* ── 6. mode-bar / undo-bar 수직 분리 (CSS와 일치) ── */
    var modeBarEl=document.getElementById('mode-bar');
    var undoBarEl=document.getElementById('undo-bar');
    if(modeBarEl) modeBarEl.style.bottom='58px';
    if(undoBarEl) undoBarEl.style.bottom='8px';

    /* ── 7. 가시 토글 버튼 터치 동기화 ──
     * click 리스너만으론 모바일에서 active 클래스가 안 맞는 문제 보정 */
    ['vis-arrows','vis-badges','vis-labels'].forEach(function(btnId){
      var btn=document.getElementById(btnId);
      if(!btn) return;
      btn.addEventListener('touchend',function(e){
        e.preventDefault();
        if(btn.style.pointerEvents==='none') return;  /* AC 화살표 비활성 */
        var prop=btnId==='vis-arrows'?'showArrows':btnId==='vis-badges'?'showBadges':'showLabels';
        App.State[prop]=!App.State[prop];
        btn.classList.toggle('active',App.State[prop]);
        App.EditRenderer.scheduleRender();
      },{passive:false});
    });
  }

  function init(){
    _resizeCanvases();
    App.GridRenderer.init();App.EditRenderer.init();App.Interaction.init();App.PropPanel.init();
    App.State.initViewTransform();

    App.Events.on('viewport:changed',function(){App.GridRenderer.render();App.EditRenderer.scheduleRender();});
    App.Events.on('state:changed',function(){App.EditRenderer.scheduleRender();App.PropPanel.refresh();App.Solver.run();});
    App.Events.on('solver:done',function(){App.PropPanel.refresh();App.EditRenderer.scheduleRender();});

    window.addEventListener('resize',function(){_resizeCanvases();App.Geo.clampOffset();App.Events.emit('viewport:changed');});

    _buildSidebar();_setupModeBar();App.Events.emit('viewport:changed');
    App.TransientGraph.init();
    App.ValPopup.init();

    /* ── 모바일 UX ── */
    var _isMobile=window.innerWidth<=480||/Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
    if(_isMobile) _setupMobileUX();

    /* ── Undo/Redo 버튼 연결 ── */
    var btnUndo=document.getElementById('btn-undo');
    var btnRedo=document.getElementById('btn-redo');
    function _refreshUndoBtns(){
      btnUndo.disabled=!App.State.canUndo();
      btnRedo.disabled=!App.State.canRedo();
    }
    btnUndo.addEventListener('click',function(){App.State.undo();App.EditRenderer.stopSelAnimation();App.PropPanel.refresh();_refreshUndoBtns();});
    btnRedo.addEventListener('click',function(){App.State.redo();App.EditRenderer.stopSelAnimation();App.PropPanel.refresh();_refreshUndoBtns();});
    App.Events.on('state:changed',_refreshUndoBtns);
    _refreshUndoBtns();

    _setupVisBtns();

    console.log('[Circuit Sim] 초기화 완료');
  }

  /* ── 가시 토글 버튼(화살표/배지/라벨) 연결 ── */
  function _setupVisBtns(){
    function _makeToggle(btnId, prop){
      var btn=document.getElementById(btnId);
      if(!btn) return;
      function _sync(){btn.classList.toggle('active', App.State[prop]);}
      btn.addEventListener('click',function(){
        App.State[prop]=!App.State[prop];
        _sync();
        App.EditRenderer.scheduleRender();
      });
      _sync();
    }
    _makeToggle('vis-arrows','showArrows');
    _makeToggle('vis-badges','showBadges');
    _makeToggle('vis-labels','showLabels');

    /* ── AC 감지 시 화살표 버튼 자동 비활성화 ── */
    function _syncArrowsForAC(){
      var sr = App.State.solverResult;
      var isAC = !!(sr && sr.acPhasor);
      var btn  = document.getElementById('vis-arrows');
      if(!btn) return;
      if(isAC){
        App.State.showArrows = false;
        btn.classList.remove('active');
        btn.style.opacity       = '0.25';
        btn.style.cursor        = 'not-allowed';
        btn.style.pointerEvents = 'none';
        btn.title               = 'AC 회로에서는 화살표가 표시되지 않습니다';
      } else {
        btn.style.opacity       = '';
        btn.style.cursor        = '';
        btn.style.pointerEvents = '';
        btn.title               = '전류 방향 화살표 표시/숨김';
        App.State.showArrows = false;
        btn.classList.remove('active');
      }
      App.EditRenderer.scheduleRender();
    }
    App.Events.on('solver:done', _syncArrowsForAC);
    _syncArrowsForAC();
  }

  return{init,placeComponent,addComponentCenter};
})();

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',function(){App.Main.init();});
else App.Main.init();

}());
