(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.State — 단일 상태 저장소 (싱글턴)
 *
 *   모든 회로 데이터(소자/도선)·뷰포트·해석결과·UI플래그를 보유.
 *   변경은 반드시 메서드를 통해야 하며, 변경 후 'state:changed' emit.
 *
 *   Undo/Redo 규약:
 *     뮤테이션은 _beginAction() … 변경 … _endAction() 으로 감쌀 것.
 *     _beginAction: 현재 위치 이후 히스토리 폐기(분기 정리)
 *     _endAction:   변경 후 스냅샷 push
 * ════════════════════════════════════════════════════════════════════ */
App.State=(function(){
  var s={
    components:[], wires:[],
    selectedId:null, connectingPort:null,
    mode:'edit',
    viewTransform:{offsetX:0,offsetY:0,scale:1.0},
    solverResult:{nodeVoltages:{},componentVoltages:{},branchCurrents:{},valid:false,error:null},
    /* 가시 토글 */
    showArrows:false,  /* 전류 방향 화살표 (기본 꺼짐) */
    showBadges:false,  /* 전류 세기 배지   (기본 꺼짐) */
    showLabels:true,   /* 소자 특성값      (기본 켜짐) */
  };

  /* ──────────────────────────────────────────────────────────────────
   * Undo/Redo 히스토리
   * ────────────────────────────────────────────────────────────────── */
  var _history=[];      // 스냅샷 배열 (최신 = 마지막)
  var _hIdx=-1;         // 현재 히스토리 위치
  var _skipSave=false;  // restore 중 재저장 방지 플래그

  function _snap(){
    return{
      components:JSON.parse(JSON.stringify(s.components)),
      wires:JSON.parse(JSON.stringify(s.wires)),
      selectedId:s.selectedId,
    };
  }
  function _beginAction(){
    if(_skipSave) return;
    _history.splice(_hIdx+1);   // 현재 이후 분기(redo 대상) 폐기
  }
  function _endAction(){
    if(_skipSave) return;
    _history.push(_snap());
    if(_history.length>UNDO_MAX) _history.shift();
    _hIdx=_history.length-1;
  }
  function _restoreSnap(snap){
    if(!snap) return;
    _skipSave=true;
    s.components=JSON.parse(JSON.stringify(snap.components));
    s.wires=JSON.parse(JSON.stringify(snap.wires));
    s.selectedId=snap.selectedId;
    s.connectingPort=null;
    _skipSave=false;
    App.Events.emit('state:changed');
  }

  /* 고유 ID 생성 (crypto.randomUUID 우선, 폴백 제공) */
  function genId(){
    return typeof crypto!=='undefined'&&crypto.randomUUID
      ?crypto.randomUUID()
      :Date.now().toString(36)+Math.random().toString(36).slice(2);
  }

  /* 변경 1건을 묶어 실행하는 헬퍼: begin → fn() → end → emit */
  function _mutate(fn){
    _beginAction();
    fn();
    _endAction();
    App.Events.emit('state:changed');
  }

  /* ──────────────────────────────────────────────────────────────────
   * 공개 API
   * ────────────────────────────────────────────────────────────────── */
  var api={
    genId:genId,

    /* ── 회로 변경 ── */
    addComponent:function(c){ _mutate(function(){ s.components.push(c); }); },
    removeComponent:function(id){
      _mutate(function(){
        /* 규칙: 도선 먼저 제거 후 소자 제거 (역순 금지) */
        s.wires=s.wires.filter(function(w){return w.fromId!==id&&w.toId!==id;});
        s.components=s.components.filter(function(c){return c.id!==id;});
        if(s.selectedId===id)s.selectedId=null;
      });
    },
    addWire:function(w){ _mutate(function(){ s.wires.push(w); }); },
    removeWire:function(id){
      _mutate(function(){
        s.wires=s.wires.filter(function(w){return w.id!==id;});
        if(s.selectedId===id)s.selectedId=null;
      });
    },

    /* ── 회전: rotation += 90 ──
     * 주의: 포트 이름(L/R/T/B)은 단자 식별자이며 회전으로 변경되지 않는다.
     * getPortPixel()이 rotation을 읽어 시각적 위치를 계산하므로,
     * 도선의 fromPort/toPort는 그대로 유지해야 토폴로지가 올바르다. */
    rotateComponent:function(id){
      var comp=api.getComponent(id);
      if(!comp) return;
      _mutate(function(){ comp.rotation=(comp.rotation+90)%360; });
    },
    setComponentValue:function(id,key,val){
      var comp=api.getComponent(id);
      if(!comp) return;
      _mutate(function(){ comp[key]=val; });
    },

    /* ── 조회 ── */
    getComponent:function(id){return s.components.find(function(c){return c.id===id;})||null;},
    getWire:function(id){return s.wires.find(function(w){return w.id===id;})||null;},
    isOccupied:function(gx,gy,excId){
      return s.components.some(function(c){return c.id!==excId&&c.gridX===gx&&c.gridY===gy;});
    },
    /* 특정 포트에 연결된 도선 목록 */
    getPortWires:function(compId,portId){
      return s.wires.filter(function(w){
        return (w.fromId===compId&&w.fromPort===portId)||(w.toId===compId&&w.toPort===portId);
      });
    },
    /* 포트가 비어 있는지 (JUNCTION은 항상 true) */
    isPortFree:function(compId,portId){
      var comp=api.getComponent(compId);
      if(!comp) return false;
      if(MULTI_PORT_TYPES[comp.type]) return true;
      return s.wires.every(function(w){
        return !((w.fromId===compId&&w.fromPort===portId)||(w.toId===compId&&w.toPort===portId));
      });
    },

    /* ── Undo / Redo ── */
    undo:function(){ if(_hIdx>0){_hIdx--;_restoreSnap(_history[_hIdx]);} },
    redo:function(){ if(_hIdx<_history.length-1){_hIdx++;_restoreSnap(_history[_hIdx]);} },
    canUndo:function(){return _hIdx>0;},
    canRedo:function(){return _hIdx<_history.length-1;},

    /* ── 인접 부품 자동 연결 ──
     * 배치/이동 직후 호출. compId의 각 포트를 다른 부품 포트와
     * 논리 좌표가 일치하면 자동으로 도선 연결한다. */
    autoConnectAdjacent:function(compId){
      var comp=api.getComponent(compId);
      if(!comp) return;
      var myPorts=App.Geo.getCompPorts(comp);
      var connected=false;
      myPorts.forEach(function(myPort){
        var myPos=App.Geo.getPortGridPos(comp,myPort);
        s.components.forEach(function(other){
          if(other.id===compId) return;
          App.Geo.getCompPorts(other).forEach(function(otherPort){
            var otherPos=App.Geo.getPortGridPos(other,otherPort);
            /* 논리 좌표 일치 여부 (허용오차 0.01) */
            if(Math.abs(myPos.x-otherPos.x)>0.01||Math.abs(myPos.y-otherPos.y)>0.01) return;
            /* 중복 도선 방지 */
            var dup=s.wires.some(function(w){
              return(w.fromId===compId&&w.fromPort===myPort&&w.toId===other.id&&w.toPort===otherPort)||
                     (w.fromId===other.id&&w.fromPort===otherPort&&w.toId===compId&&w.toPort===myPort);
            });
            if(dup) return;
            /* JUNCTION 아닌 포트는 단일 연결 — 기존 도선 제거 후 연결 */
            if(!MULTI_PORT_TYPES[comp.type]){
              s.wires=s.wires.filter(function(w){
                return !((w.fromId===compId&&w.fromPort===myPort)||(w.toId===compId&&w.toPort===myPort));
              });
            }
            if(!MULTI_PORT_TYPES[other.type]){
              s.wires=s.wires.filter(function(w){
                return !((w.fromId===other.id&&w.fromPort===otherPort)||(w.toId===other.id&&w.toPort===otherPort));
              });
            }
            s.wires.push({
              id:genId(),
              fromId:compId, fromPort:myPort,
              toId:other.id, toPort:otherPort,
              direction:'H-first',
            });
            connected=true;
          });
        });
      });
      if(connected) App.Events.emit('state:changed');
    },

    /* ── 뷰포트 초기화: 그리드를 화면 중앙에 정렬 ── */
    initViewTransform:function(){
      var el=document.getElementById('canvas-container');
      var W=el.clientWidth,H=el.clientHeight;
      s.viewTransform.scale=1.0;
      s.viewTransform.offsetX=Math.round((W-GRID_COLS*CELL_SIZE)/2);
      s.viewTransform.offsetY=Math.round((H-GRID_ROWS*CELL_SIZE)/2);
      _endAction();   // 초기 빈 상태 스냅샷
    },
  };

  /* ──────────────────────────────────────────────────────────────────
   * 게터/세터 정의 (반복 제거: 테이블 기반 자동 생성)
   *   readonly: 게터만 / readwrite: 게터+세터
   * ────────────────────────────────────────────────────────────────── */
  ['components','wires','viewTransform'].forEach(function(k){
    Object.defineProperty(api,k,{get:function(){return s[k];},enumerable:true});
  });
  ['solverResult','selectedId','connectingPort','mode',
   'showArrows','showBadges','showLabels'].forEach(function(k){
    Object.defineProperty(api,k,{
      get:function(){return s[k];},
      set:function(v){s[k]=v;},
      enumerable:true,
    });
  });

  return api;
})();

}());
