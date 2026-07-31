(function(){
'use strict';
var App=window.App;

App.Interaction=(function(){
  var _cv;

  /* ── 제스처 유한상태기계(FSM) ───────────────────────────────────────
   *   none      : 대기
   *   pinch     : 두 손가락 확대/축소
   *   pan       : 빈 공간 드래그 → 화면 이동 (+관성)
   *   drag      : 부품 이동 (삭제존 드롭 가능)
   *   port-drag : 포트에서 끌기 — 짧으면 tap-to-connect, 길면 drag-to-connect
   *   connect   : tap-to-connect 대기 (다음 포트 탭으로 완성)
   *   select    : 도선 선택됨
   * 전이는 onPointerDown/Move/Up에서 발생. _cancelGesture()가 공통 정리.
   * ─────────────────────────────────────────────────────────────────── */
  var gesture='none';
  var activePointers=new Map();

  /* 제스처별 상태 객체 */
  var _pinch={active:false,startDist:0,startScale:1,focalX:0,focalY:0};
  var _pan={active:false,lastX:0,lastY:0,velX:0,velY:0,rafId:null};
  var _drag={comp:null,origGX:0,origGY:0,snapGX:null,snapGY:null,offGX:0,offGY:0,moved:false};
  var _portDrag={fromPort:null,previewX:0,previewY:0,nearPort:null,pressTime:0,timer:null};
  var _sbDrag={active:false,item:null,el:null,moved:false,startX:0,startY:0};
  var PORT_DRAG_MS=200; /* 이 시간 이내 손 떼면 tap-to-connect, 이상이면 drag-to-connect */

  /* 더블탭 추적 (모바일은 pointerId가 매번 바뀌므로 시간+위치 기반) */
  var _lastTapTime=0,_lastTapPid=null,_lastTapX=0,_lastTapY=0;

  /* 연결 미리보기 방향 */
  var _connectPreviewDir='H-first';

  // ═══ 히트 테스트 ═══

  /* 모든 부품 포트를 순회하며 (px,py)에 가장 가까운 포트 반환 (공용 헬퍼)
   *   filterFn(comp): false면 그 부품 건너뜀
   *   maxDist: 이 거리 이내만 후보. 초과 시 null */
  function _nearestPortOf(px,py,maxDist,filterFn){
    var best=null,bestD=Infinity;
    App.State.components.forEach(function(comp){
      if(filterFn&&!filterFn(comp)) return;
      App.Geo.getCompPorts(comp).forEach(function(portId){
        var pp=App.Geo.getPortPixel(comp,portId);
        var d=Math.hypot(px-pp.x,py-pp.y);
        if(d<bestD){bestD=d;best={componentId:comp.id,port:portId};}
      });
    });
    return (best&&bestD<=maxDist)?best:null;
  }

  // 포트 히트 — conPort 활성 시 모든 부품 포트 검사, 아니면 선택된 부품만
  function _hitPort(px,py,pType){
    var hr=pType==='touch'?HIT_RADIUS_TOUCH:HIT_RADIUS_MOUSE;
    var selId=App.State.selectedId;
    var checkAll=!!App.State.connectingPort;
    return _nearestPortOf(px,py,hr,function(comp){
      return checkAll||comp.id===selId;
    });
  }

  // 부품 바디 히트
  function _hitComp(px,py){
    var vt=App.State.viewTransform,cp=CELL_SIZE*vt.scale;
    var comps=App.State.components;
    for(var i=comps.length-1;i>=0;i--){
      var c=comps[i],gp=App.Geo.gridToPixel(c.gridX,c.gridY);
      if(px>=gp.x&&px<=gp.x+cp&&py>=gp.y&&py<=gp.y+cp) return c;
    }
    return null;
  }

  // 도선 히트 (선분 거리 ≤ threshold)
  function _hitWire(px,py){
    var vt=App.State.viewTransform;
    var thr=Math.max(6,6*vt.scale);
    var wires=App.State.wires;
    for(var i=wires.length-1;i>=0;i--){
      var w=wires[i];
      var from=App.State.getComponent(w.fromId),to=App.State.getComponent(w.toId);
      if(!from||!to) continue;
      var p1=App.Geo.getPortPixel(from,w.fromPort);
      var p2=App.Geo.getPortPixel(to,w.toPort);
      var path=App.Geo.calcWirePath(p1.x,p1.y,p2.x,p2.y,w.direction);
      for(var k=0;k<path.length-1;k++){
        if(App.Geo.distToSegment(px,py,path[k].x,path[k].y,path[k+1].x,path[k+1].y)<=thr) return w;
      }
    }
    return null;
  }

  // 도선 꺾임점 핸들 히트
  function _hitWireBend(px,py){
    var wires=App.State.wires;
    for(var i=wires.length-1;i>=0;i--){
      var w=wires[i];
      var bp=App.Geo.getWireBendPoint(w);
      if(!bp) continue;
      if(Math.hypot(px-bp.x,py-bp.y)<=BEND_HIT_RADIUS) return w;
    }
    return null;
  }

  // ═══ 줌 ═══

  function applyZoom(ns,focalX,focalY){
    var vt=App.State.viewTransform,old=vt.scale;
    ns=Math.min(SCALE_MAX,Math.max(SCALE_MIN,ns));
    if(Math.abs(ns-old)<0.001) return;
    var gfx=(focalX-vt.offsetX)/(CELL_SIZE*old),gfy=(focalY-vt.offsetY)/(CELL_SIZE*old);
    vt.scale=ns;vt.offsetX=focalX-gfx*CELL_SIZE*ns;vt.offsetY=focalY-gfy*CELL_SIZE*ns;
    App.Geo.clampOffset();App.Events.emit('viewport:changed');
  }

  // ═══ 팬 ═══

  function cancelInertia(){if(_pan.rafId!==null){cancelAnimationFrame(_pan.rafId);_pan.rafId=null;}}

  function panStart(x,y){
    cancelInertia();_pan.active=true;_pan.lastX=x;_pan.lastY=y;_pan.velX=0;_pan.velY=0;
    _cv.style.cursor='grabbing';
  }
  function updatePan(x,y){
    if(!_pan.active) return;
    var dx=x-_pan.lastX,dy=y-_pan.lastY,vt=App.State.viewTransform;
    vt.offsetX+=dx;vt.offsetY+=dy;App.Geo.clampOffset();
    _pan.velX=_pan.velX*.7+dx*.3;_pan.velY=_pan.velY*.7+dy*.3;
    _pan.lastX=x;_pan.lastY=y;App.Events.emit('viewport:changed');
  }
  function panEnd(){
    _pan.active=false;_cv.style.cursor='';
    if(Math.hypot(_pan.velX,_pan.velY)>INERTIA_THRESHOLD) _startInertia();
  }
  function _startInertia(){
    (function step(){
      _pan.velX*=INERTIA_FRICTION;_pan.velY*=INERTIA_FRICTION;
      var vt=App.State.viewTransform;
      vt.offsetX+=_pan.velX;vt.offsetY+=_pan.velY;App.Geo.clampOffset();
      App.Events.emit('viewport:changed');
      if(Math.hypot(_pan.velX,_pan.velY)>INERTIA_THRESHOLD) _pan.rafId=requestAnimationFrame(step);
      else _pan.rafId=null;
    })();
  }

  // ═══ 더블탭 ═══

  function _onDoubleTap(x,y){
    /* ── 우선순위 1: 선택된 부품 위 더블탭 → 90° 회전 ── */
    if(App.State.selectedId){
      var selComp=App.State.getComponent(App.State.selectedId);
      if(selComp && selComp.type!==TYPE.JUNCTION_4){
        /* 더블탭 위치가 해당 부품 셀 위인지 확인 */
        var ch=_hitComp(x,y);
        if(ch && ch.id===selComp.id){
          App.State.rotateComponent(selComp.id);
          App.PropPanel.show(selComp.id);
          App.EditRenderer.scheduleRender();
          return;
        }
      }

      /* ── 우선순위 2: 선택된 도선 위 더블탭 → 꺾임 방향 토글 ── */
      var selWire=App.State.getWire(App.State.selectedId);
      if(selWire){
        var fw=App.State.getComponent(selWire.fromId);
        var tw=App.State.getComponent(selWire.toId);
        if(fw&&tw){
          var wh2=_hitWire(x,y);
          if(wh2&&wh2.id===selWire.id){
            selWire.direction=selWire.direction==='H-first'?'V-first':'H-first';
            App.Events.emit('state:changed');
            App.PropPanel.refresh();
            return;
          }
        }
      }
    }

    /* ── 우선순위 3: 선택 없이 부품 위 더블탭 → 선택 후 회전 ── */
    var ch2=_hitComp(x,y);
    if(ch2 && ch2.type!==TYPE.JUNCTION_4){
      App.State.selectedId=ch2.id;
      App.State.rotateComponent(ch2.id);
      App.PropPanel.show(ch2.id);
      App.EditRenderer.startSelAnimation();
      App.EditRenderer.scheduleRender();
      return;
    }

    /* ── 기본 더블탭: 뷰 리셋 ── */
    var c=document.getElementById('canvas-container'),vt=App.State.viewTransform;
    vt.scale=1.0;
    vt.offsetX=Math.round((c.clientWidth-GRID_COLS*CELL_SIZE)/2);
    vt.offsetY=Math.round((c.clientHeight-GRID_ROWS*CELL_SIZE)/2);
    App.Geo.clampOffset();App.Events.emit('viewport:changed');
  }

  // ═══ 핀치 ═══

  function _pinchStart(p1,p2){
    _pinch.active=true;_pinch.startDist=Math.hypot(p2.x-p1.x,p2.y-p1.y)||1;
    _pinch.startScale=App.State.viewTransform.scale;
    _pinch.focalX=(p1.x+p2.x)/2;_pinch.focalY=(p1.y+p2.y)/2;
  }
  function _updatePinch(p1,p2){
    if(!_pinch.active) return;
    applyZoom(_pinch.startScale*(Math.hypot(p2.x-p1.x,p2.y-p1.y)/_pinch.startDist),_pinch.focalX,_pinch.focalY);
  }

  // ═══ 드래그 ═══

  function _updateDrag(px,py){
    var vt=App.State.viewTransform,cp=CELL_SIZE*vt.scale;
    var rawGX=(px-vt.offsetX)/cp-_drag.offGX;
    var rawGY=(py-vt.offsetY)/cp-_drag.offGY;
    var sn=App.Geo.clampGrid(Math.round(rawGX),Math.round(rawGY));
    _drag.snapGX=sn.gridX;_drag.snapGY=sn.gridY;_drag.moved=true;
    App.EditRenderer.scheduleRender();
  }
  function _finishDrag(clientX, clientY){
    if(!_drag.comp) return;
    var dz=document.getElementById('delete-zone');

    /* 삭제존 판정: 숨기기 전에 수행 */
    var overDz=_drag.moved && _overDeleteZone(clientX,clientY);

    /* 삭제존 숨기기 */
    if(dz) dz.classList.remove('visible','hover');

    /* 삭제존 드롭 → 삭제 */
    if(overDz){
      var delId=_drag.comp.id;
      _drag.comp.gridX=_drag.origGX;_drag.comp.gridY=_drag.origGY;
      _drag.comp=null;_drag.snapGX=null;_drag.snapGY=null;_drag.moved=false;
      App.State.removeComponent(delId);
      App.PropPanel.hide();
      App.Events.emit('state:changed');
      App.EditRenderer.scheduleRender();
      return;
    }

    if(_drag.moved&&_drag.snapGX!=null){
      if(!App.State.isOccupied(_drag.snapGX,_drag.snapGY,_drag.comp.id)){
        _drag.comp.gridX=_drag.snapGX;_drag.comp.gridY=_drag.snapGY;
        // 이동 완료 후 인접 포트 자동 연결 (state:changed는 내부에서 emit)
        App.State.autoConnectAdjacent(_drag.comp.id);
      } else {
        _drag.comp.gridX=_drag.origGX;_drag.comp.gridY=_drag.origGY;
        App.Events.emit('state:changed');
      }
    }
    _drag.comp=null;_drag.snapGX=null;_drag.snapGY=null;_drag.moved=false;
    App.EditRenderer.scheduleRender();
  }
  function _cancelGesture(){
    var dz=document.getElementById('delete-zone');
    if(dz) dz.classList.remove('visible','hover');
    /* port-drag 타이머·상태 정리 */
    if(_portDrag.timer){ clearTimeout(_portDrag.timer); _portDrag.timer=null; }
    if(gesture==='port-drag'){
      _portDrag.fromPort=null; _portDrag.nearPort=null;
      _cancelConnect();
    }
    if(gesture==='drag'&&_drag.comp){
      _drag.comp.gridX=_drag.origGX;_drag.comp.gridY=_drag.origGY;_drag.comp=null;
      App.Events.emit('state:changed');
    }
    if(gesture==='connect') _cancelConnect();
    if(gesture==='pan'){_pan.active=false;_cv.style.cursor='';}
    cancelInertia();
  }

  // ═══ 도선 연결 로직 (Phase 3 핵심) ═══

  /* 삭제존 위에 있는지 판정 (clientX/Y 기준). 보이지 않으면 false */
  function _overDeleteZone(clientX,clientY){
    var dz=document.getElementById('delete-zone');
    if(!dz||!dz.classList.contains('visible')||clientX==null) return false;
    var r=dz.getBoundingClientRect();
    return clientX>=r.left&&clientX<=r.right&&clientY>=r.top&&clientY<=r.bottom;
  }

  // 연결 시작: 포트 탭 (tap) 또는 포트 드래그 시작
  function _startConnect(portHit){
    App.State.connectingPort=portHit;
    _connectPreviewDir='H-first';
    /* gesture는 호출자(onPointerDown)가 설정 — 여기서 강제 덮어쓰지 않음 */
    if(gesture!=='port-drag') gesture='connect';
    _showConnHint('다른 포트를 탭하여 연결  ·  빈 곳 탭으로 취소');
    App.EditRenderer.startPortAnimation();
    App.EditRenderer.scheduleRender();
  }

  // 연결 완성: 목표 포트 탭
  function _completeConnect(tgt){
    var cp=App.State.connectingPort;
    if(!cp) return;

    // 자기 자신 포트 재탭 → 취소
    if(tgt.componentId===cp.componentId&&tgt.port===cp.port){_cancelConnect();return;}

    // 같은 부품의 다른 포트 연결도 가능 (허용)
    // 이미 연결된 비-JUNCTION 포트: 기존 도선 먼저 제거 후 새 연결
    if(!App.State.isPortFree(tgt.componentId,tgt.port)){
      var existingWires=App.State.getPortWires(tgt.componentId,tgt.port);
      if(existingWires.length>0) App.State.removeWire(existingWires[0].id);
    }
    if(!App.State.isPortFree(cp.componentId,cp.port)){
      var srcWires=App.State.getPortWires(cp.componentId,cp.port);
      if(srcWires.length>0) App.State.removeWire(srcWires[0].id);
    }

    // 중복 도선 방지 (동일 포트 쌍)
    var dup=App.State.wires.some(function(w){
      return(w.fromId===cp.componentId&&w.fromPort===cp.port&&w.toId===tgt.componentId&&w.toPort===tgt.port)||
             (w.fromId===tgt.componentId&&w.fromPort===tgt.port&&w.toId===cp.componentId&&w.toPort===cp.port);
    });
    if(dup){showErrorToast('이미 같은 포트끼리 연결되어 있습니다.');_cancelConnect();return;}

    // 방향 자동 결정 (포트 상대 위치 기반)
    var srcComp=App.State.getComponent(cp.componentId);
    var tgtComp=App.State.getComponent(tgt.componentId);
    var dir='H-first';
    if(srcComp&&tgtComp){
      var p1=App.Geo.getPortPixel(srcComp,cp.port);
      var p2=App.Geo.getPortPixel(tgtComp,tgt.port);
      dir=App.Geo.getBestDirection(p1,p2,cp.componentId,tgt.componentId);
    }

    var newWireId=App.State.genId();
    App.State.addWire({
      id:newWireId,
      fromId:cp.componentId,fromPort:cp.port,
      toId:tgt.componentId,toPort:tgt.port,
      direction:dir,
    });

    // 완성 플래시 트리거
    App.EditRenderer.flashWire(newWireId);

    _cancelConnect();
  }

  // 연결 취소
  function _cancelConnect(){
    App.State.connectingPort=null;
    App.EditRenderer.setWirePreview(null);
    App.EditRenderer.setNearestPort(null);
    App.EditRenderer.stopPortAnimation();
    _showConnHint(null);
    if(gesture!=='port-drag') gesture='none';
    App.EditRenderer.scheduleRender();
  }

  // nearest port 업데이트 (pointermove 중 호출)
  function _updateNearestPort(px,py,pType){
    var hr=pType==='touch'?HIT_RADIUS_TOUCH*1.5:HIT_RADIUS_MOUSE*2;
    var cp=App.State.connectingPort;
    if(!cp) return;
    /* 출발 부품 제외하고 최근접 포트 탐색 */
    var nearest=_nearestPortOf(px,py,hr,function(comp){
      return comp.id!==cp.componentId;
    });
    App.EditRenderer.setNearestPort(nearest);
  }

  // ═══ 힌트 표시 ═══

  function _showConnHint(msg){
    var el=document.getElementById('conn-hint');
    if(!el) return;
    if(msg){el.textContent=msg;el.classList.add('visible');}
    else el.classList.remove('visible');
  }

  // ═══ 포인터 이벤트 ═══

  function onPointerDown(e){
    _cv.setPointerCapture(e.pointerId);
    var x=e.offsetX,y=e.offsetY;
    activePointers.set(e.pointerId,{x:x,y:y});

    // 두 번째 손가락 → 핀치
    if(activePointers.size===2){
      _cancelGesture();
      gesture='pinch';
      var ptrs=Array.from(activePointers.values());
      _pinchStart(ptrs[0],ptrs[1]);
      return;
    }

    cancelInertia();

    // ── 더블탭 감지: 시간 + 위치 기반 (pointerId는 모바일에서 매번 바뀔 수 있음) ──
    var now=Date.now();
    var dx=x-(_lastTapX||0), dy=y-(_lastTapY||0);
    var sameSpot=Math.hypot(dx,dy)<20;  /* 20px 이내 같은 위치 */
    if(sameSpot&&now-_lastTapTime<DOUBLE_TAP_MS){
      _onDoubleTap(x,y);_lastTapTime=0;return;
    }
    _lastTapTime=now;_lastTapX=x;_lastTapY=y;

    // ── 연결 모드 활성 중 ──
    if(App.State.connectingPort){
      var ph=_hitPort(x,y,e.pointerType);
      if(ph){_completeConnect(ph);}
      else{_cancelConnect();}
      return;
    }

    // ── 선택된 도선의 꺾임점 핸들 탭 → direction 즉시 토글 ──
    if(App.State.selectedId){
      var selWire=App.State.getWire(App.State.selectedId);
      if(selWire){
        var bp=App.Geo.getWireBendPoint(selWire);
        if(bp&&Math.hypot(x-bp.x,y-bp.y)<=BEND_HIT_RADIUS){
          selWire.direction=selWire.direction==='H-first'?'V-first':'H-first';
          App.Events.emit('state:changed');
          App.PropPanel.refresh();
          return;
        }
      }
    }

    // ── 포트 히트 → 즉시 port-drag 시작, 빠른 탭이면 tap-to-connect 전환 ──
    var ph2=_hitPort(x,y,e.pointerType);
    if(ph2){
      gesture='port-drag';
      _portDrag.fromPort=ph2;
      _portDrag.previewX=x;
      _portDrag.previewY=y;
      _portDrag.pressTime=Date.now();   /* 누른 시각 기록 */
      _portDrag.nearPort=null;
      _portDrag.timer=null;
      _startConnect(ph2);               /* 프리뷰 즉시 시작 */
      return;
    }

    // ── 도선 히트 ──
    var wh=_hitWire(x,y);
    if(wh){
      App.State.selectedId=wh.id;
      App.PropPanel.show(wh.id);
      App.EditRenderer.startSelAnimation();
      App.EditRenderer.scheduleRender();
      gesture='select';
      /* 도선도 롱프레스 → 컨텍스트 메뉴 */
      _lpStart(x,y,null,wh);
      return;
    }

    // ── 부품 히트 → 드래그 준비 ──
    var ch=_hitComp(x,y);
    if(ch){
      var vt=App.State.viewTransform,cp2=CELL_SIZE*vt.scale;
      var gp=App.Geo.gridToPixel(ch.gridX,ch.gridY);
      _drag.comp=ch;_drag.origGX=ch.gridX;_drag.origGY=ch.gridY;
      _drag.snapGX=ch.gridX;_drag.snapGY=ch.gridY;
      _drag.offGX=(x-gp.x)/cp2;_drag.offGY=(y-gp.y)/cp2;
      _drag.moved=false;
      /* 드래그 시작: 삭제존 표시, top = J4 버튼 하단 (canvas-container 기준) */
      var dz=document.getElementById('delete-zone');
      if(dz){
        var j4btn=document.getElementById('sidebar-item-JUNCTION_4');
        if(!j4btn){
          var items=document.querySelectorAll('.sidebar-item');
          j4btn=items[items.length-1]||null;
        }
        var container=document.getElementById('canvas-container');
        var cRect=container?container.getBoundingClientRect():{top:0};
        var topPx=j4btn
          ? (j4btn.getBoundingClientRect().bottom - cRect.top + 8)
          : 420;
        dz.style.top=Math.max(8,topPx)+'px';
        dz.style.bottom='60px';
        dz.classList.add('visible');
      }
      gesture='drag';
      App.State.selectedId=ch.id;
      App.PropPanel.show(ch.id);
      App.EditRenderer.startSelAnimation();
      App.EditRenderer.scheduleRender();
      // 롱프레스 시작
      _lpStart(x,y,ch);
      return;
    }

    // ── 빈 공간 → 팬 + 선택 해제 ──
    if(App.State.selectedId!==null){
      App.State.selectedId=null;
      App.EditRenderer.stopSelAnimation();
      App.PropPanel.hide();
      App.EditRenderer.scheduleRender();
    }
    gesture='pan';
    panStart(x,y);
  }

  function onPointerMove(e){
    if(!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId,{x:e.offsetX,y:e.offsetY});
    /* 드롭 판정용 마지막 좌표 저장 */
    window._lastPointerClientXY={x:e.clientX,y:e.clientY};

    if(gesture==='pinch'&&activePointers.size>=2){
      var ptrs=Array.from(activePointers.values());_updatePinch(ptrs[0],ptrs[1]);

    } else if(gesture==='pan'){
      updatePan(e.offsetX,e.offsetY);

    } else if(gesture==='drag'&&_drag.comp){
      if(!_drag.moved){
        var gp=App.Geo.gridToPixel(_drag.origGX,_drag.origGY);
        var vt=App.State.viewTransform,cp=CELL_SIZE*vt.scale;
        if(Math.hypot(e.offsetX-(gp.x+_drag.offGX*cp),e.offsetY-(gp.y+_drag.offGY*cp))<4) return;
        _lpCancel(); // 손가락 움직이면 롱프레스 취소
      }
      _updateDrag(e.offsetX,e.offsetY);
      /* 삭제존 hover 강조 */
      var dz=document.getElementById('delete-zone');
      if(dz&&dz.classList.contains('visible')){
        dz.classList.toggle('hover', _overDeleteZone(e.clientX,e.clientY));
      }

    } else if(gesture==='port-drag'){
      _portDrag.previewX=e.offsetX;
      _portDrag.previewY=e.offsetY;
      /* 가장 가까운 연결 가능 포트 강조 */
      _portDrag.nearPort=_hitPort(e.offsetX,e.offsetY,e.pointerType);
      /* 와이어 프리뷰 + 최근접 포트 업데이트 (커서 방향 기준 자동 꺾임) */
      var conP=App.State.connectingPort;
      if(conP){
        var srcComp=App.State.getComponent(conP.componentId);
        if(srcComp){
          var p1=App.Geo.getPortPixel(srcComp,conP.port);
          _connectPreviewDir=App.Geo.getBestDirection(p1,{x:e.offsetX,y:e.offsetY});
          App.EditRenderer.setWirePreview({x1:p1.x,y1:p1.y,x2:e.offsetX,y2:e.offsetY,dir:_connectPreviewDir});
        }
        _updateNearestPort(e.offsetX,e.offsetY,e.pointerType);
      }
      App.EditRenderer.scheduleRender();
    }
  }

  function onPointerUp(e){
    activePointers.delete(e.pointerId);
    _lpCancel();

    if(gesture==='pinch'){
      if(activePointers.size<2){
        _pinch.active=false;
        if(activePointers.size===1){
          var rem=Array.from(activePointers.values())[0];
          gesture='pan';_pan.active=true;_pan.lastX=rem.x;_pan.lastY=rem.y;_pan.velX=0;_pan.velY=0;
        } else gesture='none';
      }
      return;
    }
    if(gesture==='pan'){panEnd();gesture='none';return;}
    if(gesture==='select'){gesture='none';return;}
    if(gesture==='port-drag'){
      var elapsed=Date.now()-(_portDrag.pressTime||0);
      var tgt=_hitPort(e.offsetX,e.offsetY,e.pointerType);

      if(elapsed < PORT_DRAG_MS){
        /* ── 빠른 탭: tap-to-connect 모드로 전환 ──
         * 프리뷰·connectingPort는 그대로 유지 → 'connect' 제스처로 전환
         * 사용자가 두 번째 포트를 탭할 때까지 대기 */
        _portDrag.fromPort=null; _portDrag.nearPort=null;
        gesture='connect';   /* 기존 tap-to-connect 상태 */
        /* hint 메시지 갱신 */
        _showConnHint('다른 포트를 탭하여 연결  ·  빈 곳 탭으로 취소');
        return;
      }

      /* ── 긴 드래그: 현재 위치에서 연결 완성 ── */
      if(tgt && App.State.connectingPort &&
         !(tgt.componentId===App.State.connectingPort.componentId && tgt.port===App.State.connectingPort.port)){
        _completeConnect(tgt);
      } else {
        _cancelConnect();
      }
      _portDrag.fromPort=null; _portDrag.nearPort=null;
      gesture='none';
      return;
    }
    if(gesture==='drag'){_finishDrag(e.clientX, e.clientY);gesture='none';return;}
    gesture='none';
  }

  function onWheel(e){
    e.preventDefault();
    var rect=_cv.getBoundingClientRect();
    var f=e.deltaY<0?WHEEL_ZOOM_STEP:(1/WHEEL_ZOOM_STEP);
    applyZoom(App.State.viewTransform.scale*f,e.clientX-rect.left,e.clientY-rect.top);
  }

  // ═══ 사이드바 드래그 ═══

  function startSidebarDrag(item,clientX,clientY,el){
    _sbDrag.active=true;_sbDrag.item=item;_sbDrag.el=el;
    _sbDrag.startX=clientX;_sbDrag.startY=clientY;_sbDrag.moved=false;
    el.classList.add('dragging');
    var ghost=document.getElementById('drag-ghost');
    App.Symbols.drawMini(ghost,item.type);
    _moveSbGhost(clientX,clientY);
    ghost.style.display='block';
  }

  function _moveSidebarDrag(clientX,clientY){
    if(!_sbDrag.active) return;
    if(!_sbDrag.moved&&Math.hypot(clientX-_sbDrag.startX,clientY-_sbDrag.startY)>5) _sbDrag.moved=true;
    _moveSbGhost(clientX,clientY);
  }

  function _endSidebarDrag(clientX,clientY){
    if(!_sbDrag.active) return;
    document.getElementById('drag-ghost').style.display='none';
    if(_sbDrag.el) _sbDrag.el.classList.remove('dragging');
    if(_sbDrag.moved){
      var cont=document.getElementById('canvas-container');
      var rect=cont.getBoundingClientRect();
      if(clientX>=rect.left&&clientX<=rect.right&&clientY>=rect.top&&clientY<=rect.bottom)
        App.Main.placeComponent(_sbDrag.item,clientX-rect.left,clientY-rect.top);
    } else {
      App.Main.addComponentCenter(_sbDrag.item);
    }
    _sbDrag.active=false;_sbDrag.item=null;_sbDrag.el=null;
  }

  function _moveSbGhost(cx,cy){
    var g=document.getElementById('drag-ghost');
    if(g){g.style.left=cx+'px';g.style.top=cy+'px';}
  }

  function getDraggedId(){return _drag.comp?_drag.comp.id:null;}
  function getDragInfo(){
    if(!_drag.comp||!_drag.moved) return null;
    return{compId:_drag.comp.id,type:_drag.comp.type,rotation:_drag.comp.rotation,snapGX:_drag.snapGX,snapGY:_drag.snapGY};
  }

  // ═══ 롱프레스 상태 ═══
  var _lp={timer:null,px:0,py:0,compId:null,wireId:null};

  function _lpStart(x,y,comp,wire){
    _lp.px=x;_lp.py=y;
    _lp.compId=comp?comp.id:null;
    _lp.wireId=wire?wire.id:null;
    _lp.timer=setTimeout(function(){_lpFire(x,y);},LONGPRESS_MS);
  }
  function _lpCancel(){
    if(_lp.timer!==null){clearTimeout(_lp.timer);_lp.timer=null;}
  }
  function _lpFire(x,y){
    _lp.timer=null;
    var comp=_lp.compId?App.State.getComponent(_lp.compId):null;
    var wire=_lp.wireId?App.State.getWire(_lp.wireId):null;
    if(comp){
      App.State.selectedId=comp.id;
      App.PropPanel.show(comp.id);
      App.EditRenderer.startSelAnimation();
      _showCtxMenu(x,y,comp,null);
    } else if(wire){
      App.State.selectedId=wire.id;
      App.PropPanel.show(wire.id);
      App.EditRenderer.startSelAnimation();
      _showCtxMenu(x,y,null,wire);
    }
  }

  // ═══ 컨텍스트 메뉴 ═══
  var _ctxTargetComp=null;
  var _ctxCloseDelay=null;

  function _showCtxMenu(canvasX,canvasY,comp,wire){
    _ctxTargetComp=comp||wire||null;
    var isWire=!comp&&!!wire;

    /* 선택 상태 동기화 */
    if(comp) App.State.selectedId=comp.id;
    else if(wire) App.State.selectedId=wire.id;

    var menu=document.getElementById('ctx-menu');
    var cont=document.getElementById('canvas-container');
    var rect=cont.getBoundingClientRect();
    var absX=canvasX+rect.left, absY=canvasY+rect.top;

    var mw=160, mh=130;
    var left=Math.min(absX, window.innerWidth -mw-8);
    var top =Math.min(absY+10, window.innerHeight-mh-8);
    if(top<4) top=absY+10;
    menu.style.left=left+'px'; menu.style.top=top+'px';

    /* 도선: 복제 숨김, 회전=꺾임 방향 전환 레이블 변경 */
    var rotateEl=document.getElementById('ctx-rotate');
    var dupEl   =document.getElementById('ctx-dup');
    if(isWire){
      rotateEl.style.display='flex';
      rotateEl.querySelector('.ctx-icon').textContent='⇄';
      rotateEl.childNodes[1].textContent=' 꺾임 방향 전환';
      dupEl.style.display='none';
    } else {
      rotateEl.querySelector('.ctx-icon').textContent='↻';
      rotateEl.childNodes[1].textContent=' 90° 회전';
      dupEl.style.display='flex';
      /* JUNCTION_4는 회전 숨김 */
      rotateEl.style.display=(comp&&comp.type===TYPE.JUNCTION_4)?'none':'flex';
    }

    menu.classList.add('visible');

    /* 외부 닫기 리스너 등록:
     * click 대신 pointerdown 사용 — 캔버스에서 touchstart preventDefault로
     * 합성 click이 차단되어도 pointerdown은 항상 발생함.
     * capture:true 로 메뉴 안 클릭보다 먼저 감지. */
    clearTimeout(_ctxCloseDelay);
    document.removeEventListener('pointerdown',_outsideCloseCtx,{capture:true});
    document.removeEventListener('click',_outsideCloseCtx,{capture:false});

    function _onDocUp(){
      document.removeEventListener('pointerup',_onDocUp,{capture:true});
      /* pointerup 직후 다음 pointerdown부터 외부 닫기 감지 */
      _ctxCloseDelay=setTimeout(function(){
        document.addEventListener('pointerdown',_outsideCloseCtx,{capture:true});
      },50);
    }
    document.addEventListener('pointerup',_onDocUp,{capture:true,once:true});
  }

  function _outsideCloseCtx(e){
    var menu=document.getElementById('ctx-menu');
    if(menu&&!menu.contains(e.target)){
      _closeCtxMenu();
    }
    /* 메뉴 내부 터치면 리스너 유지 (항목 클릭 핸들러에서 닫음) */
  }

  function _closeCtxMenu(){
    clearTimeout(_ctxCloseDelay);
    document.getElementById('ctx-menu').classList.remove('visible');
    document.removeEventListener('pointerdown',_outsideCloseCtx,{capture:true});
    document.removeEventListener('click',_outsideCloseCtx,{capture:false});
    _ctxTargetComp=null;
  }

  // ═══ 키보드 단축키 ═══
  function _deleteSelected(){
    var id=App.State.selectedId;if(!id) return;
    if(App.State.getComponent(id)){App.State.removeComponent(id);App.EditRenderer.stopSelAnimation();App.PropPanel.hide();}
    else if(App.State.getWire(id)){App.State.removeWire(id);App.EditRenderer.stopSelAnimation();App.PropPanel.hide();}
  }
  function _rotateSelected(){
    var id=App.State.selectedId;
    var comp=id?App.State.getComponent(id):null;
    if(!comp) return;
    App.State.rotateComponent(id);
    App.PropPanel.show(id);
  }
  function _escAction(){
    if(App.State.connectingPort){_cancelConnect();return;}
    if(App.State.selectedId!==null){
      App.State.selectedId=null;
      App.EditRenderer.stopSelAnimation();
      App.PropPanel.hide();
      App.EditRenderer.scheduleRender();
    }
  }
  function _duplicateSelected(){
    var id=App.State.selectedId;
    var comp=id?App.State.getComponent(id):null;
    if(!comp) return;
    // 인접한 빈 셀 탐색
    var empty=null;
    outer:for(var r=1;r<=5;r++){
      for(var dg=-r;dg<=r;dg++){for(var dr=-r;dr<=r;dr++){
        if(Math.abs(dg)!==r&&Math.abs(dr)!==r) continue;
        var cg=App.Geo.clampGrid(comp.gridX+dg,comp.gridY+dr);
        if(!App.State.isOccupied(cg.gridX,cg.gridY,null)){empty=cg;break outer;}
      }}
    }
    if(!empty){showErrorToast('복제할 공간이 없습니다.');return;}
    var dup=JSON.parse(JSON.stringify(comp));
    dup.id=App.State.genId();dup.gridX=empty.gridX;dup.gridY=empty.gridY;
    App.State.addComponent(dup);
    App.State.selectedId=dup.id;
    App.PropPanel.show(dup.id);
    App.EditRenderer.startSelAnimation();
  }

  function _setupKeyboard(){
    document.addEventListener('keydown',function(e){
      // 입력 필드에서는 무시 (단, Escape는 허용)
      if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'){
        if(e.key==='Escape'){e.target.blur();return;}
        return;
      }
      switch(e.key){
        case 'Delete': case 'Backspace': e.preventDefault();_deleteSelected();break;
        case 'r': case 'R': e.preventDefault();_rotateSelected();break;
        case 'Escape': _escAction();break;
        case 'z': case 'Z':
          if(e.ctrlKey||e.metaKey){e.preventDefault();
            if(e.shiftKey) App.State.redo(); else App.State.undo();
            App.EditRenderer.stopSelAnimation();App.PropPanel.refresh();
          } break;
        case 'y': case 'Y':
          if(e.ctrlKey||e.metaKey){e.preventDefault();App.State.redo();App.EditRenderer.stopSelAnimation();App.PropPanel.refresh();}break;
      }
    });
  }

  function _setupCtxMenuHandlers(){
    document.getElementById('ctx-rotate').addEventListener('click',function(e){
      e.stopPropagation();
      var target=_ctxTargetComp;
      _closeCtxMenu();
      if(!target) return;
      var wire=App.State.getWire(target.id);
      if(wire){
        /* 도선: 꺾임 방향 전환 */
        wire.direction=wire.direction==='H-first'?'V-first':'H-first';
        App.Events.emit('state:changed');
        App.PropPanel.refresh();
      } else {
        App.State.selectedId=target.id;
        _rotateSelected();
      }
    });
    document.getElementById('ctx-dup').addEventListener('click',function(e){
      e.stopPropagation();
      var id=_ctxTargetComp?_ctxTargetComp.id:App.State.selectedId;
      _closeCtxMenu();
      if(id){ App.State.selectedId=id; _duplicateSelected(); }
    });
    document.getElementById('ctx-delete').addEventListener('click',function(e){
      e.stopPropagation();
      var id=_ctxTargetComp?_ctxTargetComp.id:App.State.selectedId;
      _closeCtxMenu();
      if(id){ App.State.selectedId=id; _deleteSelected(); }
    });
  }

  function init(){
    _cv=document.getElementById('canvas-main');
    _cv.addEventListener('pointerdown',onPointerDown);
    _cv.addEventListener('pointermove',onPointerMove);
    _cv.addEventListener('pointerup',onPointerUp);
    _cv.addEventListener('pointercancel',onPointerUp);
    _cv.addEventListener('wheel',onWheel,{passive:false});

    /* ── 우클릭 컨텍스트 메뉴 ── */
    _cv.addEventListener('contextmenu',function(e){
      e.preventDefault();
      var rect=_cv.getBoundingClientRect();
      var x=e.clientX-rect.left, y=e.clientY-rect.top;
      /* 부품 히트 */
      var comp=_hitComp(x,y);
      if(comp){
        App.State.selectedId=comp.id;
        App.PropPanel.show(comp.id);
        App.EditRenderer.startSelAnimation();
        _showCtxMenu(x,y,comp,null);
        return;
      }
      /* 도선 히트 */
      var wire=_hitWire(x,y);
      if(wire){
        App.State.selectedId=wire.id;
        App.PropPanel.show(wire.id);
        App.EditRenderer.startSelAnimation();
        _showCtxMenu(x,y,null,wire);
        return;
      }
      /* 선택된 부품 */
      if(App.State.selectedId){
        var sel=App.State.getComponent(App.State.selectedId);
        if(sel){ _showCtxMenu(x,y,sel,null); return; }
        var selW=App.State.getWire(App.State.selectedId);
        if(selW){ _showCtxMenu(x,y,null,selW); }
      }
    });

    var cont=document.getElementById('canvas-container');
    /* touchstart/touchmove preventDefault: 캔버스 요소에서만 적용.
     * 버튼·입력 요소에서 preventDefault하면 합성 click 이벤트가 차단되어
     * mode-btn, 속성 패널 버튼 등 모든 클릭 이벤트가 동작하지 않음. */
    var CANVAS_IDS={
      'canvas-bg':1,'canvas-main':1,'canvas-anim':1,'canvas-container':1
    };
    function _isCanvasTarget(e){
      var t=e.target;
      return t&&(CANVAS_IDS[t.id]||t.tagName==='CANVAS');
    }
    cont.addEventListener('touchstart',function(e){
      if(_isCanvasTarget(e)) e.preventDefault();
    },{passive:false});
    cont.addEventListener('touchmove', function(e){
      if(_isCanvasTarget(e)) e.preventDefault();
    },{passive:false});
    document.addEventListener('pointermove',function(e){_moveSidebarDrag(e.clientX,e.clientY);});
    document.addEventListener('pointerup',  function(e){_endSidebarDrag(e.clientX,e.clientY);});
    _setupKeyboard();
    _setupCtxMenuHandlers();
  }

  return{init,applyZoom,cancelInertia,getDraggedId,getDragInfo,startSidebarDrag,
         deleteSelected:_deleteSelected,rotateSelected:_rotateSelected};
})();

}());
