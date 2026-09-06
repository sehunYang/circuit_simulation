(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.EditRenderer — 편집 모드 렌더링 (canvas-main)
 *
 *   렌더 순서(레이어): 도선 → 부품/라벨 → 선택박스 → 포트점
 *                      → 도선 미리보기 → 드래그 고스트 → 솔버 오버레이
 *   scheduleRender(): rAF 디바운스. 선택/연결 시 애니메이션 루프 가동.
 *
 *   ── 색 규약 (수능 지면 규격) ────────────────────────────────────
 *   회로 그림 자체(도선·소자·라벨·전류 화살표/배지)는 **완전 흑백**이다.
 *   파란 계열은 오직 *편집 보조 표시*(선택 박스, 포트 점, 미리보기,
 *   드래그 고스트)에만 쓴다 — 이들은 그림이 아니라 UI 이므로 촬영(SVG)
 *   결과물에는 포함되지 않는다.
 * ════════════════════════════════════════════════════════════════════ */
App.EditRenderer=(function(){
  var SN=null;                                   /* App.SN (init 시점에 확정) */
  var UI={                                        /* 편집 보조 표시 색 */
    accent:'#2563eb',   /* 선택·미리보기 */
    ok:    '#128a53',   /* 연결 가능 / 빈 포트 */
    warn:  '#c0392b',   /* 연결 불가 / 점유 */
    node:  '#3d4453',   /* 연결된 포트 */
  };
  var _cv,_ctx;
  var _pending=false;
  var _wirePreview=null;       // {x1,y1,x2,y2,dir} — 도선 미리보기
  var _nearestPort=null;       // {componentId,port} — 연결 중 가장 가까운 포트
  var _flashWires={};          // {wireId: endTime} — 도선 완성 플래시
  var _selAnimId=null;

  function init(){_cv=document.getElementById('canvas-main');_ctx=_cv.getContext('2d');SN=App.SN;}

  function scheduleRender(){
    if(_pending) return;
    _pending=true;
    requestAnimationFrame(function(){_pending=false;render();});
  }

  function setWirePreview(v){_wirePreview=v;}
  function setNearestPort(v){_nearestPort=v;}
  function flashWire(wireId){_flashWires[wireId]=Date.now()+WIRE_FLASH_MS;}

  /* ── 공통 헬퍼 ────────────────────────────────────────────────────
   * 도선의 양 끝 포트 픽셀 좌표 반환 (없으면 null) */
  function _wireEndpoints(wire){
    var from=App.State.getComponent(wire.fromId);
    var to  =App.State.getComponent(wire.toId);
    if(!from||!to) return null;
    return{from:from, to:to,
           p1:App.Geo.getPortPixel(from,wire.fromPort),
           p2:App.Geo.getPortPixel(to,wire.toPort)};
  }
  /* 두 점이 모두 뷰포트 밖이면 false (클리핑) */
  function _segVisible(p1,p2,W,H){
    if(Math.max(p1.x,p2.x)<-10||Math.min(p1.x,p2.x)>W+10) return false;
    if(Math.max(p1.y,p2.y)<-10||Math.min(p1.y,p2.y)>H+10) return false;
    return true;
  }
  /* 도선 전류 크기: wireCurrents 우선, 없으면 양단 부품 branchCurrent 폴백 */
  function _wireCurrentMag(wire,sr,wc){
    var I=wc[wire.id];
    if(I==null){
      I=sr.branchCurrents[wire.fromId];
      if(I==null) I=sr.branchCurrents[wire.toId];
      if(I!=null) I=Math.abs(I);
    }
    return I;
  }

  // ─── 메인 렌더 함수 ───
  function render(){
    if(!_cv||!_ctx) return;
    var vs=App.Geo.viewSize(), W=vs.w, H=vs.h;   /* 논리(CSS) 크기 */
    _ctx.clearRect(0,0,W,H);

    var vt=App.State.viewTransform;
    var cellPx=CELL_SIZE*vt.scale;
    var selId=App.State.selectedId;
    var conPort=App.State.connectingPort;
    var draggedId=App.Interaction?App.Interaction.getDraggedId():null;
    var dragInfo=App.Interaction?App.Interaction.getDragInfo():null;
    var now=Date.now();

    /* ── 1. 도선 ── */
    App.State.wires.forEach(function(wire){
      var ep=_wireEndpoints(wire);
      if(!ep) return;
      var p1=ep.p1, p2=ep.p2;
      if(!_segVisible(p1,p2,W,H)) return;
      var path=App.Geo.calcWirePath(p1.x,p1.y,p2.x,p2.y,wire.direction);
      var isSelected=(wire.id===selId);
      // 플래시 상태 확인
      var flashEnd=_flashWires[wire.id]||0;
      var isFlashing=(now<flashEnd);
      if(isFlashing&&now>flashEnd-50){delete _flashWires[wire.id];}

      _ctx.save();
      _ctx.lineCap='round'; _ctx.lineJoin='round';
      _ctx.beginPath();
      _ctx.moveTo(path[0].x,path[0].y);
      for(var i=1;i<path.length;i++) _ctx.lineTo(path[i].x,path[i].y);

      if(isFlashing){
        // 완성 플래시: 굵기로만 알린다 (색은 지면 잉크 유지)
        var flashRatio=(flashEnd-now)/WIRE_FLASH_MS; // 1→0
        _ctx.strokeStyle=UI.accent;
        _ctx.lineWidth=SN.TOKENS.lwWire+2.2*flashRatio;
      } else if(isSelected){
        _ctx.strokeStyle=UI.accent;
        _ctx.lineWidth=SN.TOKENS.lwWire+1.1;
      } else {
        /* 기본 도선 = 가는 검정 실선 (수능 지면 규격) */
        _ctx.strokeStyle=SN.TOKENS.ink;
        _ctx.lineWidth=SN.TOKENS.lwWire;
      }
      _ctx.stroke();
      _ctx.restore();

      // 선택된 도선: 끝점 핸들 + 꺾임점 핸들
      if(isSelected){
        _drawWireHandles(_ctx,path,wire);
      }
    });

    /* ── 2. 부품 기호 + 라벨 ── */
    App.State.components.forEach(function(comp){
      var gp=App.Geo.gridToPixel(comp.gridX,comp.gridY);
      if(gp.x+cellPx<-5||gp.x>W+5||gp.y+cellPx<-5||gp.y>H+5) return;
      var cx=gp.x+cellPx/2, cy=gp.y+cellPx/2;
      var isDragged=(comp.id===draggedId);
      _ctx.save();
      if(isDragged) _ctx.globalAlpha=0.28;
      /* 전구 광량 — 밝기 ∝ 전력(I²R)/정격. 화면 전용(촬영에는 없음). */
      var srB=App.State.solverResult;
      if(comp.type===TYPE.BULB&&!isDragged&&srB&&srB.valid&&srB.dc&&srB.dc.out&&srB.dc.out[comp.id]){
        var br=Math.max(0,Math.min(1.5,srB.dc.out[comp.id].brightness||0));
        if(br>0.02){
          var gr=_ctx.createRadialGradient(cx,cy,cellPx*0.05,cx,cy,cellPx*0.62);
          var a=0.18+0.55*Math.min(1,br);
          gr.addColorStop(0,'rgba(255,214,90,'+a.toFixed(3)+')');
          gr.addColorStop(0.55,'rgba(255,190,60,'+(a*0.45).toFixed(3)+')');
          gr.addColorStop(1,'rgba(255,170,40,0)');
          _ctx.fillStyle=gr; _ctx.beginPath(); _ctx.arc(cx,cy,cellPx*0.62,0,Math.PI*2); _ctx.fill();
        }
      }
      App.Symbols.draw(_ctx,comp.type,cx,cy,cellPx,comp.rotation);
      if(!isDragged) App.Symbols.drawLabel(_ctx,comp,cx,cy,cellPx);
      _ctx.restore();

      /* ── 3. 선택 바운딩 박스 (애니메이션 점선) ── */
      if(comp.id===selId&&!isDragged){
        _ctx.save();
        _ctx.strokeStyle=UI.accent;_ctx.lineWidth=1.5;
        _ctx.setLineDash([4,4]);
        _ctx.lineDashOffset=-((Date.now()/150)%8);
        _ctx.strokeRect(gp.x+2,gp.y+2,cellPx-4,cellPx-4);
        _ctx.setLineDash([]);
        _ctx.restore();
      }
    });

    /* ── 4. 포트 점 (3가지 상태) ── */
    _renderPorts(_ctx,W,H,cellPx,selId,conPort);

    /* ── 5. 도선 미리보기 ── */
    if(conPort&&_wirePreview){
      var previewDir=_wirePreview.dir||'H-first';
      var pvPath=App.Geo.calcWirePath(_wirePreview.x1,_wirePreview.y1,_wirePreview.x2,_wirePreview.y2,previewDir);
      _ctx.save();
      _ctx.strokeStyle=UI.accent;_ctx.lineWidth=1.8;
      _ctx.setLineDash([6,4]);_ctx.globalAlpha=0.72;
      _ctx.beginPath();
      _ctx.moveTo(pvPath[0].x,pvPath[0].y);
      for(var k=1;k<pvPath.length;k++) _ctx.lineTo(pvPath[k].x,pvPath[k].y);
      _ctx.stroke();
      _ctx.setLineDash([]);_ctx.restore();
    }

    /* ── 6. 드래그 고스트 ── */
    if(dragInfo&&dragInfo.snapGX!=null){
      var sgp=App.Geo.gridToPixel(dragInfo.snapGX,dragInfo.snapGY);
      var scx=sgp.x+cellPx/2, scy=sgp.y+cellPx/2;
      var occ=App.State.isOccupied(dragInfo.snapGX,dragInfo.snapGY,dragInfo.compId);
      _ctx.save();_ctx.globalAlpha=0.52;
      App.Symbols.draw(_ctx,dragInfo.type,scx,scy,cellPx,dragInfo.rotation,{color:occ?UI.warn:UI.ok});
      _ctx.strokeStyle=occ?UI.warn:UI.ok;_ctx.lineWidth=1.5;
      _ctx.setLineDash([3,3]);_ctx.strokeRect(sgp.x+2,sgp.y+2,cellPx-4,cellPx-4);
      _ctx.setLineDash([]);_ctx.restore();
    }

    /* ── 7. 솔버 결과 오버레이 ── */
    var sr=App.State.solverResult;
    if(sr&&sr.valid){
      _renderSolverOverlay(_ctx,W,H,cellPx,sr);
    } else if(sr&&sr.error&&App.State.components.length>0){
      _renderSolverError(_ctx,W,H,sr.error);
    }
  }

  /* 솔버 성공: 도선 전류 화살표 + 부품 전류 값 배지 */
  function _renderSolverOverlay(ctx,W,H,cellPx,sr){
    /* 외부 save: 이전 ctx 상태(shadowBlur, globalAlpha 등) 완전 격리 */
    ctx.save();
    ctx.shadowBlur=0; ctx.shadowColor='transparent'; ctx.globalAlpha=1;

    var wc  = sr.wireCurrents || {};
    var isAC= !!(sr.acPhasor);
    var rmsK= isAC ? 1/Math.SQRT2 : 1;
    var as  = Math.max(9, Math.min(13, cellPx*0.22));
    /* 화살표·배지를 도선에서 옆으로 빼는 거리.
     * 검정 도선 위에 검정 화살표를 겹치면 "도선이 굵어진 곳"으로만 읽히고,
     * 배지도 도선을 가로질러 읽기 어렵다. 지면 규격이라 색을 못 쓰므로
     * 도선 양옆에 나눠 놓아 형태·위치로 구분한다.
     *   화살표 → 수평 구간 위 / 수직 구간 왼쪽
     *   배지   → 그 반대쪽                      (run-renderer 와 같은 규칙) */
    var aoff = Math.round(as*0.7+1.5);
    var boff = as+8;

    /* 가시 플래그 — AC 모드에서는 화살표 항상 숨김 */
    var doArrows = App.State.showArrows && !isAC;
    var doBadges = App.State.showBadges;

    /* ══════════════════════════════
     * 패스 1 — 화살표만
     * ══════════════════════════════ */
    if(doArrows)
    App.State.wires.forEach(function(wire){
      var ep=_wireEndpoints(wire);
      if(!ep) return;
      var Ipeak=_wireCurrentMag(wire,sr,wc);
      if(Ipeak==null||Math.abs(Ipeak)<1e-12) return;
      if(!_segVisible(ep.p1,ep.p2,W,H)) return;
      var path=App.Geo.calcWirePath(ep.p1.x,ep.p1.y,ep.p2.x,ep.p2.y,wire.direction);
      var convDir=App.Geo.wireConvDir(wire,sr);
      for(var k=0;k<path.length-1;k++){
        var sx=path[k].x,sy=path[k].y,ex=path[k+1].x,ey=path[k+1].y;
        if(Math.hypot(ex-sx,ey-sy)<16) continue;
        var mx=(sx+ex)/2, my=(sy+ey)/2;
        var ang=Math.atan2(ey-sy,ex-sx);
        if(convDir<0) ang+=Math.PI;
        /* 수능 규격 화살표: 속 찬 검정 삼각 화살촉 — 도선 옆에 나란히 */
        var arrHoriz=Math.abs(ex-sx)>Math.abs(ey-sy);
        ctx.save();
        ctx.translate(mx+(arrHoriz?0:-aoff), my+(arrHoriz?-aoff:0));
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(as,0); ctx.lineTo(-as*0.6,-as*0.52); ctx.lineTo(-as*0.6,as*0.52);
        ctx.closePath();
        ctx.fillStyle=SN.TOKENS.ink;
        ctx.fill();
        ctx.restore();
      }
    });

    /* ══════════════════════════════════════════════════════════════
     * 패스 2 — 텍스트 배지 전부 (최상위 레이어)
     *
     * 전류 배지는 소자 특성값 라벨과 같은 검정 이탤릭이라 글자만으로는
     * 서로 구분되지 않는다. 색을 쓸 수 없으므로 **얇은 상자 테두리**로
     * 구분한다 (흰 속 + 1px 검정 외곽선) — 지면 규격 안에서의 형태 구분.
     *
     * drawBadge 설계 원칙:
     *   1) ctx 상태를 save/restore 로 완전 격리
     *   2) 글자 폭을 재서 화면 밖으로 잘리지 않게 위치 보정
     *   3) side='right' 는 세로 도선 옆에 놓을 때 — 중앙 정렬하면 상자가
     *      도선을 가로지르므로 상자 왼쪽 끝을 기준점에 맞춘다.
     * ══════════════════════════════════════════════════════════════ */
    /* 배지 자리 잡기용 점유 목록 — 우선순위가 다르므로 둘로 나눈다.
     *   _placed : 이미 놓인 배지. 겹치면 둘 다 못 읽으므로 **절대 금지**.
     *   _soft   : 소자 칸(+특성값 자리)과 도선. 흰 속 배지가 그림을 덮으므로
     *             **되도록 피하되**, 피할 자리가 없으면 덮는 편이 낫다. */
    var _placed=[], _soft=[];
    function _clear(r,list){
      return !list.some(function(q){
        return !(r.x1<q.x0||r.x0>q.x1||r.y1<q.y0||r.y0>q.y1);
      });
    }
    App.State.components.forEach(function(comp){
      var g=App.Geo.gridToPixel(comp.gridX,comp.gridY);
      _soft.push({x0:g.x, x1:g.x+cellPx,
                  y0:g.y, y1:g.y+cellPx+(App.State.showLabels?cellPx*0.3:0)});
    });
    App.State.wires.forEach(function(wire){
      var ep=_wireEndpoints(wire);
      if(!ep) return;
      var path=App.Geo.calcWirePath(ep.p1.x,ep.p1.y,ep.p2.x,ep.p2.y,wire.direction);
      var m=3;   /* 도선 주변 여유 — 배지 테두리가 도선에 붙지 않게 */
      for(var k=0;k<path.length-1;k++){
        _soft.push({x0:Math.min(path[k].x,path[k+1].x)-m,
                    x1:Math.max(path[k].x,path[k+1].x)+m,
                    y0:Math.min(path[k].y,path[k+1].y)-m,
                    y1:Math.max(path[k].y,path[k+1].y)+m});
      }
    });

    function drawBadge(txt, bx, by, fsz, side){
      ctx.save();
      ctx.globalAlpha=1; ctx.setLineDash([]);

      ctx.font='italic '+fsz+'px '+SN.TOKENS.font;
      var tw=ctx.measureText(txt).width+10;
      var bh=fsz+7;

      if(side==='right') bx+=tw/2;
      else if(side==='left') bx-=tw/2;

      /* 경계 클리핑 방지 */
      if(bx-tw/2 <  2) bx=tw/2+2;
      if(bx+tw/2 > W-2) bx=W-tw/2-2;
      if(by-bh/2 <  2) by=bh/2+2;
      if(by+bh/2 > H-2) by=H-bh/2-2;

      /* 위아래로 한 칸씩 비켜 가며 자리를 찾는다.
       *   1순위: 다른 배지·그림 어디에도 안 걸리는 자리
       *   2순위: 최소한 다른 배지와는 안 겹치는 자리 (그림은 덮더라도)
       * 색으로 구분할 수 없는 지면 규격에서는 배지끼리 겹치는 순간 둘 다
       * 못 읽게 되므로, 배지 충돌만은 끝까지 피한다.
       * 위쪽을 먼저 보는 이유는 소자 위가 배지의 관례적 자리이고 아래로
       * 밀면 특성값 라벨·심볼과 부딪히기 쉬워서다. 탐색은 ±2칸으로 제한 —
       * 더 멀리 밀면 자리는 찾겠지만 어느 소자·도선의 값인지 알 수 없게
       * 되어 오히려 해롭다. */
      var by0=by, step=bh+3, offs=[0,-1,1,-2,2];
      var best=null, ok=null;
      for(var a=0;a<offs.length;a++){
        var cy=by0+offs[a]*step;
        if(cy-bh/2<2||cy+bh/2>H-2) continue;
        var cand={x0:bx-tw/2,x1:bx+tw/2,y0:cy-bh/2,y1:cy+bh/2};
        if(!_clear(cand,_placed)) continue;
        if(ok===null) ok=cand;
        if(_clear(cand,_soft)){ best=cand; break; }
      }
      var rect=best||ok||{x0:bx-tw/2,x1:bx+tw/2,y0:by0-bh/2,y1:by0+bh/2};
      by=(rect.y0+rect.y1)/2;
      _placed.push(rect);

      ctx.beginPath();
      if(ctx.roundRect) ctx.roundRect(bx-tw/2,by-bh/2,tw,bh,3);
      else ctx.rect(bx-tw/2,by-bh/2,tw,bh);
      ctx.fillStyle=SN.TOKENS.paper;
      ctx.fill();
      ctx.strokeStyle=SN.TOKENS.ink;
      ctx.lineWidth=SN.TOKENS.lwThin;
      ctx.stroke();
      ctx.restore();

      App.SN.label(ctx,txt,bx,by,fsz,{italic:true});
    }

    /* ── 도선 배지 ── */
    if(doBadges)
    App.State.wires.forEach(function(wire){
      var ep=_wireEndpoints(wire);
      if(!ep) return;
      var Ipeak=_wireCurrentMag(wire,sr,wc);
      /* 전류 0 인 도선도 배지를 그린다 — "0mA" 는 정보다.
       *   (DC 정상상태에서 축전기 가지, 매달린 가지 등. 예전엔 건너뛰어서
       *    RL∥RC 회로의 RC 쪽만 배지가 비어 '계산이 안 된 것'처럼 보였다) */
      if(Ipeak==null) return;
      if(!_segVisible(ep.p1,ep.p2,W,H)) return;
      var path=App.Geo.calcWirePath(ep.p1.x,ep.p1.y,ep.p2.x,ep.p2.y,wire.direction);
      for(var k=0;k<path.length-1;k++){
        var sx=path[k].x,sy=path[k].y,ex=path[k+1].x,ey=path[k+1].y;
        var len=Math.hypot(ex-sx,ey-sy);
        if(len<44) continue;
        var mx=(sx+ex)/2, my=(sy+ey)/2;
        /* 배지는 화살표 반대쪽에 둔다 — 같은 쪽이면 둘이 겹쳐 읽기 어렵다 */
        var isHoriz=Math.abs(ex-sx)>Math.abs(ey-sy);
        var bx2=mx, by2=my, side=null;
        if(isHoriz) by2=my+boff;
        else { bx2=mx+boff; side='right'; }
        var fsz2=Math.max(SN.FS.badgeMin,Math.min(11,cellPx*0.20));
        var Idisp=Ipeak*rmsK;
        drawBadge(_fmtCurrentShort(Math.abs(Idisp))+(isAC?' rms':''),bx2,by2,fsz2,side);
      }
    });

    /* ── 부품 배지 ── */
    /* 회로 중심 x — 배지를 회로 바깥쪽으로 밀어내는 기준 */
    var cxMean=0;
    if(App.State.components.length){
      App.State.components.forEach(function(c){
        cxMean+=App.Geo.gridToPixel(c.gridX,c.gridY).x+cellPx/2;
      });
      cxMean/=App.State.components.length;
    }
    if(doBadges)
    App.State.components.forEach(function(comp){
      if(NODE_TYPES[comp.type]) return;   /* 분기점·접지·라벨: 전류 없음 */
      var Ipeak=sr.branchCurrents[comp.id];
      if(Ipeak==null) return;   /* 0 도 그린다 — 도선 배지와 같은 이유 */
      var gp=App.Geo.gridToPixel(comp.gridX,comp.gridY);
      if(gp.x+cellPx<-5||gp.x>W+5||gp.y+cellPx<-5||gp.y>H+5) return;
      var fsz=Math.max(10,Math.min(SN.FS.badgeMax,cellPx*0.22));
      var Idisp=Math.abs(Ipeak)*rmsK;
      var txt=_fmtCurrentShort(Idisp)+(isAC?' rms':'');
      /* 배지를 소자의 **단자 축과 수직인 쪽**에 둔다.
       * 세로 소자(rotation 90/270)는 위아래로 도선이 나가므로 위에 두면
       * 상자가 도선을 덮는다 → 옆으로 뺀다. 가로 소자는 반대.
       * 좌우 중 어느 쪽이냐는 회로 중심의 반대편(=바깥)으로 정한다.
       * 안쪽에 두면 도선 배지와 자리가 겹친다. */
      if(comp.rotation%180!==0){
        var outLeft=(gp.x+cellPx/2) < cxMean;
        drawBadge(txt, outLeft?gp.x-4:gp.x+cellPx+4, gp.y+cellPx/2, fsz,
                  outLeft?'left':'right');
      } else {
        drawBadge(txt, gp.x+cellPx/2, gp.y-(fsz+7)/2-4, fsz);
      }
    });

    ctx.restore(); /* 외부 restore */
  }

  /* 솔버 에러: 캔버스 상단 중앙 에러 배너 */
  function _renderSolverError(ctx,W,H,errMsg){
    ctx.save();
    var text='⚠ '+errMsg;
    var fs=SN.FS.notice;
    ctx.font=fs+'px '+SN.TOKENS.fontKo;
    var tw=ctx.measureText(text).width+22;
    var bx=W/2, by=40;
    ctx.fillStyle='rgba(255,255,255,0.94)';
    ctx.strokeStyle='#e0b4b4';
    ctx.lineWidth=1;
    ctx.beginPath();
    if(ctx.roundRect) ctx.roundRect(bx-tw/2,by-17,tw,24,5);
    else ctx.rect(bx-tw/2,by-17,tw,24);
    ctx.fill();ctx.stroke();
    ctx.restore();
    App.SN.label(ctx,text,bx,by-5,fs,{ko:true,color:'#b42318'});
  }

  /* 부품 배지용 짧은 전류 포맷 */
  function _fmtCurrentShort(A){
    var abs=Math.abs(A);
    if(abs<1e-12) return '0mA';   /* 수치 잔차(1e-18 등)는 0 — "0nA" 로 읽히지 않게 */
    if(abs<1e-6)  return (A*1e9).toFixed(0)+'nA';
    if(abs<1e-3)  return (A*1e6).toFixed(1)+'µA';
    if(abs<1)     return (A*1e3).toFixed(2)+'mA';
    return A.toFixed(3)+'A';
  }

  // ─── 포트 점 렌더링 (4가지 상태) ───
  // active(출발) | nearest(연결 중 최근접) | connected(연결됨) | free(빈 포트)
  // 연결 모드(conPort)에서는 모든 포트, 평소엔 선택된 부품 포트만 표시.
  function _renderPorts(ctx,W,H,cellPx,selId,conPort){
    var showAll=!!conPort;
    var now=Date.now();

    App.State.components.forEach(function(comp){
      if(!showAll&&comp.id!==selId) return;

      var ports=App.Geo.getCompPorts(comp);
      ports.forEach(function(portId){
        var pp=App.Geo.getPortPixel(comp,portId);
        if(pp.x<-20||pp.x>W+20||pp.y<-20||pp.y>H+20) return;

        // 상태 결정
        var isActive=conPort&&conPort.componentId===comp.id&&conPort.port===portId;
        var isNearest=_nearestPort&&_nearestPort.componentId===comp.id&&_nearestPort.port===portId;
        var isConnected=App.State.getPortWires(comp.id,portId).length>0;
        var isFree=!isConnected;
        var isFromActive=(conPort&&conPort.componentId===comp.id); // 출발 부품인지

        if(isActive){
          _drawPort_active(ctx,pp.x,pp.y,now);
        } else if(isNearest&&conPort){
          // 연결 가능 여부 확인
          var canConnect=App.State.isPortFree(comp.id,portId)&&comp.id!==conPort.componentId;
          _drawPort_nearest(ctx,pp.x,pp.y,canConnect);
        } else if(isConnected){
          _drawPort_connected(ctx,pp.x,pp.y);
        } else {
          _drawPort_free(ctx,pp.x,pp.y);
        }
      });
    });
  }

  /* 포트 점은 편집 보조 표시다 — 지면(흑백) 규격이 아니라 UI 색을 쓴다.
   * 흰 바탕에서 읽히도록 채움은 흰색, 구분은 테두리 색으로 준다. */

  // 출발 포트: 강조 링 + 맥동
  function _drawPort_active(ctx,x,y,now){
    ctx.save();
    var pulse=0.7+0.3*Math.sin(now/200); // 맥동 효과
    var r=PORT_DOT_R+2*pulse;
    ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);
    ctx.fillStyle=UI.ok;
    ctx.fill();
    ctx.strokeStyle=SN.TOKENS.paper;ctx.lineWidth=1.6;ctx.stroke();
    ctx.restore();
  }

  // nearest 포트: 연결 가능 여부에 따라 파란/빨간 하이라이트
  function _drawPort_nearest(ctx,x,y,canConnect){
    ctx.save();
    var r=PORT_DOT_R+2;
    ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);
    ctx.fillStyle=canConnect?UI.accent:UI.warn;
    ctx.fill();
    ctx.strokeStyle=SN.TOKENS.paper;ctx.lineWidth=1.6;ctx.stroke();
    ctx.restore();
  }

  // 연결된 포트: 작은 검정 채워진 점 (수능 회로도의 접점 표기와 같은 인상)
  function _drawPort_connected(ctx,x,y){
    ctx.save();
    var r=PORT_DOT_R-1;
    ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);
    ctx.fillStyle=UI.node;
    ctx.fill();
    ctx.restore();
  }

  // 빈 포트: 흰 속 + 회색 링
  function _drawPort_free(ctx,x,y){
    ctx.save();
    ctx.beginPath();ctx.arc(x,y,PORT_DOT_R,0,Math.PI*2);
    ctx.fillStyle=SN.TOKENS.paper;ctx.fill();
    ctx.strokeStyle=UI.ok;ctx.lineWidth=1.5;ctx.stroke();
    ctx.restore();
  }

  // 선택된 도선의 핸들 (끝점 흰 원 + 꺾임점 다이아)
  function _drawWireHandles(ctx,path,wire){
    if(!path||path.length<3) return;
    ctx.save();

    // 끝점 핸들 (흰 원 + 강조 테두리)
    [path[0],path[2]].forEach(function(pt){
      ctx.beginPath();ctx.arc(pt.x,pt.y,4,0,Math.PI*2);
      ctx.fillStyle=SN.TOKENS.paper;
      ctx.fill();
      ctx.strokeStyle=UI.accent;ctx.lineWidth=1.5;ctx.stroke();
    });

    // 꺾임점 핸들 (다이아몬드)
    var bp=path[1];
    var hs=6; // 핸들 크기
    ctx.beginPath();
    ctx.moveTo(bp.x,bp.y-hs);ctx.lineTo(bp.x+hs,bp.y);
    ctx.lineTo(bp.x,bp.y+hs);ctx.lineTo(bp.x-hs,bp.y);
    ctx.closePath();
    ctx.fillStyle=SN.TOKENS.paper;
    ctx.fill();
    ctx.strokeStyle=UI.accent;ctx.lineWidth=1.4;ctx.stroke();
    ctx.restore();

    // 꺾임 방향 표시 텍스트
    App.SN.label(ctx,wire.direction==='H-first'?'H':'V',bp.x,bp.y,8,{color:UI.accent});
  }

  /* ── 선택 박스 애니메이션 루프 ── */
  function startSelAnimation(){
    if(_selAnimId) return;
    (function loop(){
      if(!App.State.selectedId){_selAnimId=null;return;}
      scheduleRender();
      _selAnimId=requestAnimationFrame(loop);
    })();
  }
  function stopSelAnimation(){
    if(_selAnimId){cancelAnimationFrame(_selAnimId);_selAnimId=null;}
  }

  /* ── 포트 맥동 애니메이션 루프 (연결 모드 활성 시) ── */
  var _portAnimId=null;
  function startPortAnimation(){
    if(_portAnimId) return;
    (function loop(){
      if(!App.State.connectingPort){_portAnimId=null;return;}
      scheduleRender();
      _portAnimId=requestAnimationFrame(loop);
    })();
  }
  function stopPortAnimation(){
    if(_portAnimId){cancelAnimationFrame(_portAnimId);_portAnimId=null;}
  }

  return{init,scheduleRender,render,
         setWirePreview,setNearestPort,flashWire,
         startSelAnimation,stopSelAnimation,
         startPortAnimation,stopPortAnimation};
})();

}());
