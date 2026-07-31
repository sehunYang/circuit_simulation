(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Geo — 좌표 변환 · 포트 위치 · 도선 경로 · 방향 결정
 *
 *   좌표계:
 *     grid  : 논리 좌표 (정수 칸). 소자 위치·인접 판정 기준.
 *     pixel : 화면 좌표. pixel = grid·CELL_SIZE·scale + offset
 *
 *   포트 방향 벡터 (rotation=0 로컬):
 *     L=(-1,0) R=(1,0) T=(0,-1) B=(0,1)
 *     회전 시 표준 2D 회전행렬 적용:
 *       dx' = dx·cosθ - dy·sinθ
 *       dy' = dx·sinθ + dy·cosθ
 * ════════════════════════════════════════════════════════════════════ */
App.Geo=(function(){

  /* 포트 단위 방향 벡터 (모듈 공유 — 중복 제거) */
  var PORT_DIR={ L:[-1,0], R:[1,0], T:[0,-1], B:[0,1] };

  /* 회전 적용된 방향 벡터 반환. 알 수 없는 포트는 null. */
  function rotatedDir(portId, rotation){
    var d=PORT_DIR[portId];
    if(!d) return null;
    var rad=(rotation||0)*Math.PI/180;
    var cos=Math.cos(rad), sin=Math.sin(rad);
    return{ dx:d[0]*cos-d[1]*sin, dy:d[0]*sin+d[1]*cos };
  }

  /* ── 좌표 변환 ───────────────────────────────────────────────────── */
  function gridToPixel(gx,gy){
    var vt=App.State.viewTransform;
    return{x:gx*CELL_SIZE*vt.scale+vt.offsetX, y:gy*CELL_SIZE*vt.scale+vt.offsetY};
  }
  function pixelToGrid(px,py){
    var vt=App.State.viewTransform;
    return{
      gridX:Math.round((px-vt.offsetX)/(CELL_SIZE*vt.scale)),
      gridY:Math.round((py-vt.offsetY)/(CELL_SIZE*vt.scale)),
    };
  }
  function clampGrid(gx,gy){
    return{
      gridX:Math.max(0,Math.min(GRID_COLS-1,Math.round(gx))),
      gridY:Math.max(0,Math.min(GRID_ROWS-1,Math.round(gy))),
    };
  }
  /* ── 뷰포트(캔버스) 논리 크기 ──────────────────────────────────────
   * 캔버스 백업 저장소는 devicePixelRatio 배로 만들고 컨텍스트를 같은
   * 배율로 스케일한다(main.js _resizeCanvases). 그래야 125%·150% 배율
   * 화면에서 가는 선·작은 삼각형이 브라우저 확대로 뭉개지지 않는다.
   * 그리기 좌표는 계속 CSS 픽셀이므로, 렌더러는 cv.width(=장치 픽셀)
   * 대신 반드시 이 논리 크기를 화면 경계로 써야 한다. */
  var _view={w:0,h:0,dpr:1};
  function setViewSize(w,h,dpr){ _view.w=w; _view.h=h; _view.dpr=dpr; }
  function viewSize(){ return _view; }

  /* 뷰포트 오프셋을 화면 밖으로 너무 벗어나지 않게 제한 */
  function clampOffset(){
    var vt=App.State.viewTransform;
    var el=document.getElementById('canvas-main');
    var W=el?el.clientWidth:window.innerWidth, H=el?el.clientHeight:window.innerHeight;
    var gW=GRID_COLS*CELL_SIZE*vt.scale, gH=GRID_ROWS*CELL_SIZE*vt.scale;
    var M=80;   // 여백(px)
    vt.offsetX=Math.min(M,Math.max(W-gW-M,vt.offsetX));
    vt.offsetY=Math.min(M,Math.max(H-gH-M,vt.offsetY));
  }

  /* ── 포트 위치 ───────────────────────────────────────────────────── */

  /* 포트 픽셀 좌표 (회전 반영) — 소자 중심에서 half만큼 방향 이동 */
  function getPortPixel(comp,portId){
    var vt=App.State.viewTransform;
    var half=CELL_SIZE*vt.scale/2;
    var gp=gridToPixel(comp.gridX,comp.gridY);
    var cx=gp.x+half, cy=gp.y+half;
    var d=rotatedDir(portId, comp.rotation);
    if(!d) return{x:cx,y:cy};
    return{x:cx+d.dx*half, y:cy+d.dy*half};
  }

  /* 포트 논리 그리드 좌표 (뷰포트 독립) — 인접 자동 연결 판정용
   *   예: rotation=0, L포트 → {x:gx, y:gy+0.5} */
  function getPortGridPos(comp, portId){
    var d=rotatedDir(portId, comp.rotation);
    if(!d) return{x:comp.gridX+0.5,y:comp.gridY+0.5};
    return{x:comp.gridX+0.5+d.dx*0.5, y:comp.gridY+0.5+d.dy*0.5};
  }

  /* 소자 포트 목록 (문자 배열). 미정의 타입은 'LR' 기본. */
  function getCompPorts(comp){
    return (COMP_PORTS[comp.type]||'LR').split('');
  }

  /* 포트 ID를 90° 시계방향으로 n회 회전 */
  function rotatePortId(portId,times){
    var result=portId;
    for(var i=0;i<times;i++) result=PORT_ROTATE_CW[result]||result;
    return result;
  }

  /* ── 거리 & 도선 경로 ────────────────────────────────────────────── */

  /* 점-선분 최소 거리 */
  function distToSegment(px,py,x1,y1,x2,y2){
    var dx=x2-x1,dy=y2-y1;
    var lenSq=dx*dx+dy*dy;
    if(lenSq===0) return Math.hypot(px-x1,py-y1);
    var t=Math.max(0,Math.min(1,((px-x1)*dx+(py-y1)*dy)/lenSq));
    return Math.hypot(px-(x1+t*dx),py-(y1+t*dy));
  }

  /* L자 도선 경로 (3점). H-first=가로 먼저, V-first=세로 먼저 */
  function calcWirePath(x1,y1,x2,y2,dir){
    if(dir==='H-first') return [{x:x1,y:y1},{x:x2,y:y1},{x:x2,y:y2}];
    return [{x:x1,y:y1},{x:x1,y:y2},{x:x2,y:y2}];
  }

  /* 도선 꺾임점(path[1]) 픽셀 좌표 */
  function getWireBendPoint(wire){
    var from=App.State.getComponent(wire.fromId);
    var to=App.State.getComponent(wire.toId);
    if(!from||!to) return null;
    var p1=getPortPixel(from,wire.fromPort);
    var p2=getPortPixel(to,wire.toPort);
    return calcWirePath(p1.x,p1.y,p2.x,p2.y,wire.direction)[1];
  }

  /* ─────────────────────────────────────────────────────────────────
   * getBestDirection(p1, p2, fromId, toId) → 'H-first' | 'V-first'
   *
   * 두 꺾임 방향 중 다른 소자들과 가장 멀리 떨어진 방향을 선택.
   * 각 후보 경로에서 (연결 당사자 제외) 소자 중심까지의 최소 거리를
   * 구해, 최소 거리가 더 큰(=더 여유로운) 방향을 반환.
   * 장애물이 없으면 수평/수직 거리 비교로 폴백.
   * ──────────────────────────────────────────────────────────────── */
  function getBestDirection(p1, p2, fromId, toId){
    var comps=App.State?App.State.components:[];
    var vt=App.State.viewTransform;
    var cellPx=CELL_SIZE*vt.scale;

    /* 연결 당사자 제외 소자 중심 목록 */
    var obstacles=[];
    comps.forEach(function(c){
      if(c.id===fromId||c.id===toId) return;
      var gp=gridToPixel(c.gridX,c.gridY);
      obstacles.push({x:gp.x+cellPx/2, y:gp.y+cellPx/2});
    });

    /* 경로의 모든 선분에서 모든 장애물까지 최소 거리 */
    function pathMinDist(path){
      if(obstacles.length===0) return Infinity;
      var minD=Infinity;
      for(var si=0; si<path.length-1; si++){
        var a=path[si], b=path[si+1];
        for(var oi=0; oi<obstacles.length; oi++){
          var d=distToSegment(obstacles[oi].x,obstacles[oi].y, a.x,a.y, b.x,b.y);
          if(d<minD) minD=d;
        }
      }
      return minD;
    }

    var pathH=calcWirePath(p1.x,p1.y,p2.x,p2.y,'H-first');
    var pathV=calcWirePath(p1.x,p1.y,p2.x,p2.y,'V-first');
    var distH=pathMinDist(pathH);
    var distV=pathMinDist(pathV);

    /* 장애물 없음 → 수평/수직 거리 폴백 */
    if(!isFinite(distH)&&!isFinite(distV)){
      var dx=Math.abs(p2.x-p1.x), dy=Math.abs(p2.y-p1.y);
      return dx>=dy?'H-first':'V-first';
    }
    return distH>=distV?'H-first':'V-first';
  }

  /* ─────────────────────────────────────────────────────────────────
   * wireConvDir(wire, sr) → +1 | -1
   *   관례 전류 방향: +1 = fromPort→toPort, -1 = 반대
   *   1순위: sr.wireSignedI[wire.id] 부호 직접 사용 (JUNCTION 포함 정확)
   *   2순위: portVoltages 기반 폴백 (미해석 상태 등)
   * ──────────────────────────────────────────────────────────────── */
  function wireConvDir(wire, sr){
    /* 1순위: wireSignedI */
    var wsi=sr&&sr.wireSignedI;
    if(wsi && wsi[wire.id]!=null && Math.abs(wsi[wire.id])>1e-15){
      return wsi[wire.id]>0 ? 1 : -1;
    }

    /* 2순위: portVoltages 폴백 */
    var pv    =(sr&&sr.portVoltages)   || {};
    var nodeV =(sr&&sr.nodeVoltages)   || {};
    var compN =(sr&&sr.componentNodes) || {};

    function portV(comp, portId){
      if(pv[comp.id] && pv[comp.id][portId]!=null) return pv[comp.id][portId];
      var ports=getCompPorts(comp);
      var idx=ports.indexOf(portId);
      var nodes=compN[comp.id];
      if(!nodes) return 0;
      return nodeV[nodes[idx>=0?idx:0]]||0;
    }
    function otherPortV(comp, portId){
      var ports=getCompPorts(comp);
      var idx=ports.indexOf(portId);
      return portV(comp, ports[idx===0?1:0]);
    }

    var from=App.State.getComponent(wire.fromId);
    var to  =App.State.getComponent(wire.toId);
    if(!from||!to) return 1;

    var vFrom=portV(from,wire.fromPort), vFromO=otherPortV(from,wire.fromPort);
    if(Math.abs(vFrom-vFromO)>1e-9) return vFrom>vFromO?1:-1;

    var vTo=portV(to,wire.toPort), vToO=otherPortV(to,wire.toPort);
    if(Math.abs(vTo-vToO)>1e-9) return vTo>vToO?1:-1;

    return 1;
  }

  return{gridToPixel,pixelToGrid,clampGrid,clampOffset,setViewSize,viewSize,
         getPortPixel,getCompPorts,getPortGridPos,rotatePortId,
         distToSegment,calcWirePath,getWireBendPoint,getBestDirection,
         wireConvDir};
})();

}());
