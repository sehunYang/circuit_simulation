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

  /* 캔버스 3겹을 컨테이너 크기에 맞춘다.
   * 백업 저장소는 devicePixelRatio 배로 잡고 CSS 크기는 논리 크기로 고정한 뒤
   * 컨텍스트를 같은 배율로 스케일한다. 이렇게 하지 않으면 125%·150% 배율
   * 화면에서 브라우저가 캔버스를 통째로 확대해 도선·화살표가 뭉개진다.
   * (그리기 좌표계는 계속 CSS 픽셀 — 렌더러 코드는 배율을 몰라도 된다) */
  function _resizeCanvases(){
    var c=document.getElementById('canvas-container');var W=c.clientWidth,H=c.clientHeight;
    var dpr=window.devicePixelRatio||1;
    var bw=Math.round(W*dpr), bh=Math.round(H*dpr);
    ['canvas-bg','canvas-main','canvas-anim'].forEach(function(id){
      var cv=document.getElementById(id);
      cv.style.width=W+'px'; cv.style.height=H+'px';
      /* width 대입은 컨텍스트 상태(변환 포함)를 초기화하므로 크기가
       * 바뀔 때만 대입하고, 그 직후 반드시 변환을 다시 건다. */
      if(cv.width!==bw||cv.height!==bh){
        cv.width=bw; cv.height=bh;
        cv.getContext('2d').setTransform(dpr,0,0,dpr,0,0);
      }
    });
    App.Geo.setViewSize(W,H,dpr);
  }

  function _buildSidebar(){
    var sb=document.getElementById('sidebar');sb.innerHTML='';
    /* 같은 group 의 항목은 버튼 하나로 묶인다 (R: 저항/전구, SEMI: 다이오드/npn/pnp).
     *   클릭 = 종류 선택 팝업, 드래그 = 마지막에 고른 종류 배치. */
    var groups={};
    SIDEBAR_ITEMS.forEach(function(item){
      if(!item.group) return;
      if(!groups[item.group]) groups[item.group]={key:item.group,label:item.groupLabel||item.label,options:[],current:0};
      groups[item.group].options.push(item);
    });
    var seen={};
    SIDEBAR_ITEMS.forEach(function(item){
      if(item.group){ if(seen[item.group]) return; seen[item.group]=true; }
      var grp=item.group?groups[item.group]:null;
      var div=document.createElement('div');div.className='sidebar-item'+(item.rail?' rail':'');
      div.id='sidebar-item-'+(grp?grp.key:item.type);  /* J4 위치 계산용 id */
      var cv=document.createElement('canvas');cv.width=32;cv.height=32;cv.style.pointerEvents='none';
      var lbl=document.createElement('span');lbl.className='s-label';
      function _refresh(){
        var cur=grp?grp.options[grp.current]:item;
        App.Symbols.drawMini(cv,cur.type,cur.pair?{pair:true}:null);
        lbl.textContent=grp?(grp.current===0?grp.label:cur.label):item.label;
        /* 툴팁: 기호만으로는 무엇인지 알 수 없다 */
        var d=cur.pair?'변압기 — 결합된 인덕터 두 개(상호유도). 2차 회로는 도선으로 잇지 않아도 됩니다':(SIDEBAR_DESC[cur.type]||cur.label);
        div.title=d+(grp?'  ·  눌러서 종류 고르기':'');
      }
      _refresh();
      div.appendChild(cv);div.appendChild(lbl);
      if(grp){ grp.el=div; grp.refresh=_refresh; div.classList.add('group'); }
      div.addEventListener('pointerdown',function(e){
        e.stopPropagation();
        var eff=grp?grp.options[grp.current]:item;
        if(grp){ eff=Object.assign({},eff,{pickOnClick:grp}); }
        App.Interaction.startSidebarDrag(eff,e.clientX,e.clientY,div);
      });
      sb.appendChild(div);
      if(item.sepAfter){var sep=document.createElement('div');sep.className='sidebar-sep';sb.appendChild(sep);}
    });
    _groups=groups;
    /* ── 전체 초기화 버튼 ── */
    var spacer=document.createElement('div');spacer.style.flex='1';sb.appendChild(spacer);
    var clearSep=document.createElement('div');clearSep.className='sidebar-sep';sb.appendChild(clearSep);
    var clrBtn=document.createElement('div');clrBtn.className='sidebar-item sidebar-clear';
    clrBtn.title='회로 초기화';
    var clrLbl=document.createElement('span');clrLbl.className='s-label';clrLbl.textContent='초기화';
    var clrIcon=document.createElement('span');clrIcon.style.cssText='font-size:16px;line-height:1;color:var(--danger-text)';clrIcon.textContent='⌫';
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

  /* 촬영 — 흰 바탕·검정 선의 SVG 파일로 저장 (App.Capture 가 담당).
   * PNG 대신 벡터로 내보내므로 학습지·시험지에 확대해 붙여도 깨지지 않는다. */
  function _captureCircuit(){
    App.Capture.captureImage();
  }

  function _updateModeBar(mode){
    document.querySelectorAll('.mode-btn').forEach(function(b){
      b.classList.toggle('active', b.dataset.mode===mode);
    });
    App.Events.emit('mode:changed', mode);
  }

  /* 비유 모드 진입/이탈 시 UI 가시성 토글 (#6)
   *   비유 모드에서는 속성 패널·과도그래프·undo/redo·표시토글 바를 모두 숨기고,
   *   편집·실행 모드로 돌아오면 다시 보이게 한다. (모드 전환 바는 항상 표시) */
  function _setAnalogyUIHidden(hidden){
    /* 속성 패널 */
    var pp=document.getElementById('prop-panel');
    if(pp&&hidden) pp.classList.remove('visible');
    /* 과도 응답 그래프 · 오실로스코프 */
    if(hidden && App.TransientGraph) App.TransientGraph.hide();
    if(hidden && App.Scope) App.Scope.hide();
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

        /* ── 편집 모드 진입 (스위치 열림) ── */
        if(next==='edit'){
          App.State.mode='edit';
          _updateModeBar('edit');
          App.TransientGraph.hide();
          if(App.Scope) App.Scope.hide();
          _setAnalogyUIHidden(false);   /* UI 복원 (#6) */
          App.Solver.solveNow();        /* 열림 상태로 즉시 재해석 */
          App.Events.emit('viewport:changed');
          return;
        }

        /* ── 실행 모드 진입 (스위치 닫힘 = t=0) ── */
        if(next==='run'){
          App.State.mode='run';
          _updateModeBar('run');
          _setAnalogyUIHidden(false);   /* UI 복원 (#6) */
          App.Solver.solveNow();        /* 닫힘 상태 결과가 있어야 렌더러가 시작할 수 있다 */
          App.RunRenderer.start();
          App.TransientGraph.show();  /* DC 동적 소자 있으면 그래프 표시 */
          if(App.Scope) App.Scope.show();   /* 교류·정류·비선형이면 오실로스코프 */
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
          App.Solver.solveNow();        /* 비유 모드 = 닫힘 (▶ 가 t=0) */
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

  var _groups={};   /* 사이드바 그룹 (R·SEMI) — _buildSidebar 가 채움 */

  /* 그룹 선택 팝업 — 고르면 그 종류를 화면 중앙에 배치하고 이후 드래그 기본값이 된다 */
  function _openPicker(grp){
    _closePicker();
    var pop=document.createElement('div'); pop.id='sb-picker';
    var rect=grp.el.getBoundingClientRect();
    pop.style.left=(rect.right+8)+'px'; pop.style.top=rect.top+'px';
    grp.options.forEach(function(opt,i){
      var b=document.createElement('div'); b.className='sb-pick'+(i===grp.current?' current':'');
      var cv=document.createElement('canvas'); cv.width=30; cv.height=30; cv.style.pointerEvents='none';
      App.Symbols.drawMini(cv,opt.type,opt.pair?{pair:true}:null);
      var t=document.createElement('span'); t.textContent=opt.label;
      b.appendChild(cv); b.appendChild(t);
      b.addEventListener('pointerdown',function(e){ e.stopPropagation(); });
      b.addEventListener('click',function(e){
        e.stopPropagation();
        grp.current=i; grp.refresh(); _closePicker();
        addComponentCenter(opt);
      });
      pop.appendChild(b);
    });
    document.body.appendChild(pop);
    setTimeout(function(){ document.addEventListener('pointerdown',_closePicker,{once:true}); },0);
  }
  function _closePicker(){ var p=document.getElementById('sb-picker'); if(p) p.remove(); }

  function addComponentCenter(item){
    if(item.pickOnClick){ _openPicker(item.pickOnClick); return; }   /* 그룹 버튼 클릭 = 선택 */
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

  /* 전원의 + 단자(ports[0]) 쪽 옆 칸에 스위치를 자동 생성해 연결한다.
   *   편집 모드 = 열림, 실행·비유 모드 = 닫힘(t=0). 전원과 함께 삭제되고
   *   단독 삭제는 막힌다 (State.removeComponent). 옆 칸이 막혀 있으면
   *   반대쪽(− 단자)을 시도하고, 그것도 안 되면 생성하지 않는다. */
  function attachAutoSwitch(src){
    if(!AUTO_SWITCH_FOR_SOURCE) return null;
    if(src.type!==TYPE.DC_SOURCE&&src.type!==TYPE.AC_SOURCE) return null;
    var ports=App.Geo.getCompPorts(src);
    for(var pi=0;pi<ports.length;pi++){
      var d=App.Geo.rotatedDir(ports[pi], src.rotation);
      if(!d) continue;
      var gx=src.gridX+d.dx, gy=src.gridY+d.dy;
      var cg=App.Geo.clampGrid(gx,gy);
      if(cg.gridX!==gx||cg.gridY!==gy) continue;
      if(App.State.isOccupied(gx,gy,null)) continue;
      var sw={id:App.State.genId(),type:TYPE.SWITCH,gridX:gx,gridY:gy,rotation:src.rotation,
              value:0,value2:null,label:'',autoFor:src.id};
      App.State.addComponent(sw);
      App.State.autoConnectAdjacent(sw.id);
      return sw;
    }
    showErrorToast('스위치를 놓을 자리가 없어 전원만 배치했습니다',2000);
    return null;
  }

  /* 변압기: 결합 인덕터 두 개를 가로로 나란히 — 왼쪽 rot 270 · 오른쪽 rot 90 이면 코일이 바깥으로
   *   불룩하고 철심(두 줄)이 가운데 온다. 두 칸이 비어 있는 자리를 (gx,gy) 근처에서 찾는다. */
  function _placePair(item,gx,gy){
    var S=App.State, spot=null;
    function free(x,y){ var cg=App.Geo.clampGrid(x,y); return cg.gridX===x&&cg.gridY===y&&!S.isOccupied(x,y,null); }
    outer:for(var r=0;r<=15;r++){
      for(var dg=-r;dg<=r;dg++){for(var dr=-r;dr<=r;dr++){
        if(Math.abs(dg)!==r&&Math.abs(dr)!==r) continue;
        var x=gx+dg, y=gy+dr;
        if(free(x,y)&&free(x+1,y)){ spot={x:x,y:y}; break outer; }
        if(free(x-1,y)&&free(x,y)){ spot={x:x-1,y:y}; break outer; }
      }}
    }
    if(!spot){ showErrorToast('배치 공간이 없습니다.'); return; }
    var k=item.defValue2||0.99;
    var a={id:S.genId(),type:TYPE.INDUCTOR,gridX:spot.x,  gridY:spot.y,rotation:270,value:item.defValue,value2:k,label:''};
    var b={id:S.genId(),type:TYPE.INDUCTOR,gridX:spot.x+1,gridY:spot.y,rotation:90, value:item.defValue,value2:k,label:''};
    a.couple=b.id; b.couple=a.id;
    S.addComponent(a); S.addComponent(b);
    S.autoConnectAdjacent(a.id); S.autoConnectAdjacent(b.id);
    S.selectedId=a.id;
    App.PropPanel.show(a.id);
    App.EditRenderer.startSelAnimation();
    App.Events.emit('component:placed',a);
  }

  function _place(item,gx,gy){
    if(item.pair){ _placePair(item,gx,gy); return; }
    var comp={id:App.State.genId(),type:item.type,gridX:gx,gridY:gy,rotation:0,value:item.defValue,value2:item.defValue2,label:''};
    if(item.type===TYPE.LABEL) comp.label=item.label||'VCC';   /* 레일 이름 */
    if(item.type===TYPE.DC_SOURCE||item.type===TYPE.AC_SOURCE) comp.rint=0;   /* 내부저항 (Ω) */
    App.State.addComponent(comp);          // state:changed emit
    App.State.autoConnectAdjacent(comp.id); // 인접 포트 자동 연결 (중복 emit 무해)
    attachAutoSwitch(comp);
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

    /* ── 6. mode-bar / undo-bar 수직 분리 ──
     *   위치는 responsive.css 가 정한다 (모드 바가 맨 아래, 두 줄짜리 undo 바가 그 위).
     *   예전에는 여기서 인라인 style 로 덮어써 CSS 를 고쳐도 두 바가 겹친 채였다. */

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
    if(App.Scope) App.Scope.init();
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
    if(App.POE) App.POE.init();
    if(App.Guide) App.Guide.init();
    var gb=document.getElementById('graph-btn');
    if(gb) gb.addEventListener('click',function(){ App.Guide.toggleGraph(); });

    /* 공유 링크(#c=…)로 열렸으면 그 회로를 복원 */
    if(App.Share&&App.Share.applyFromHash()) showErrorToast('공유된 회로를 불러왔습니다',1800);

    console.log('[Circuit Sim] 초기화 완료');
  }

  /* ── 가시 토글 버튼(화살표/배지/라벨) 연결 ── */
  function _setupVisBtns(){
    function _makeToggle(btnId, prop){
      var btn=document.getElementById(btnId);
      if(!btn) return;
      function _sync(){btn.classList.toggle('active', !!App.State[prop]);}   /* undefined 를 넘기면 토글돼 버린다 */
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

    /* ── 회로이론 표기 모드 (접지·레일 라벨) 토글 ──
     *   팔레트에 접지·라벨 항목을 보이게 할 뿐, 해석은 늘 같다
     *   (같은 이름의 라벨 = 같은 노드, 접지 = 기준 노드). */
    var railBtn=document.getElementById('vis-rail');
    if(railBtn){
      railBtn.addEventListener('click',function(){
        App.State.railNotation=!App.State.railNotation;
        railBtn.classList.toggle('active',App.State.railNotation);
        document.getElementById('sidebar').classList.toggle('rail-mode',App.State.railNotation);
        if(App.State.railNotation) showErrorToast('회로이론 표기: 접지(GND)·레일 라벨(VCC)로 그릴 수 있습니다',2200);
      });
    }

    /* ── 전위 지형 · 전하 카운터 토글 ── */
    _makeToggle('vis-potential','showPotential');
    _makeToggle('vis-charge','showCharge');

    /* ── 공유 링크 · POE ── */
    var shareBtn=document.getElementById('share-btn');
    if(shareBtn&&App.Share) shareBtn.addEventListener('click',function(){
      if(!App.State.components.length){ showErrorToast('공유할 회로가 없습니다',1200); return; }
      App.Share.copyLink();
    });

    /* ── AC 감지 시 화살표 버튼 자동 비활성화 ──
     * AC 는 방향이 계속 바뀌어 화살표가 무의미하므로 강제로 끈다.
     * 다만 이 함수는 'solver:done' 마다 불리므로, DC 분기에서
     * showArrows 를 건드리면 소자 값만 바꿔도 방금 켠 화살표가 꺼진다.
     * → DC 에서는 상태를 손대지 않고 버튼 표시만 상태에 맞춘다.
     *   AC 진입 시 사용자의 선택을 _userArrows 에 넣어 두었다가
     *   DC 로 돌아올 때 그대로 되돌린다. */
    var _userArrows = App.State.showArrows;   /* AC 진입 직전 사용자 선택 */
    var _acLatched  = false;                  /* 현재 AC 때문에 꺼둔 상태인지 */

    function _syncArrowsForAC(){
      var sr = App.State.solverResult;
      var isAC = !!(sr && sr.acPhasor);
      var btn  = document.getElementById('vis-arrows');
      if(!btn) return;
      if(isAC){
        if(!_acLatched){ _userArrows = App.State.showArrows; _acLatched = true; }
        App.State.showArrows    = false;
        btn.style.opacity       = '0.25';
        btn.style.cursor        = 'not-allowed';
        btn.style.pointerEvents = 'none';
        btn.title               = 'AC 회로에서는 화살표가 표시되지 않습니다';
      } else {
        if(_acLatched){ App.State.showArrows = _userArrows; _acLatched = false; }
        btn.style.opacity       = '';
        btn.style.cursor        = '';
        btn.style.pointerEvents = '';
        btn.title               = '전류 방향 화살표 표시/숨김';
      }
      btn.classList.toggle('active', App.State.showArrows);
      App.EditRenderer.scheduleRender();
    }
    App.Events.on('solver:done', _syncArrowsForAC);
    _syncArrowsForAC();
  }

  return{init,placeComponent,addComponentCenter,attachAutoSwitch};
})();

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',function(){App.Main.init();});
else App.Main.init();

}());
