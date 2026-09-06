(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.GridRenderer — 격자 배경 (canvas-bg)
 *   뷰포트 변화 시에만 재렌더. 화면에 보이는 칸만 점으로 그린다.
 * ════════════════════════════════════════════════════════════════════ */
App.GridRenderer=(function(){
  var _cv,_ctx;
  function init(){_cv=document.getElementById('canvas-bg');_ctx=_cv.getContext('2d');}
  function render(){
    if(!_cv||!_ctx) return;
    var vs=App.Geo.viewSize(), W=vs.w, H=vs.h;   /* 논리(CSS) 크기 */
    _ctx.clearRect(0,0,W,H);
    var vt=App.State.viewTransform, cp=CELL_SIZE*vt.scale;
    /* 화면에 보이는 칸 범위만 순회 (성능) */
    var sC=Math.max(0,Math.floor(-vt.offsetX/cp)), eC=Math.min(GRID_COLS,Math.ceil((W-vt.offsetX)/cp)+1);
    var sR=Math.max(0,Math.floor(-vt.offsetY/cp)), eR=Math.min(GRID_ROWS,Math.ceil((H-vt.offsetY)/cp)+1);
    /* 지면(흰 바탕) 위 배치 보조선 — 아주 옅은 회색 점.
     * 수능 문항 그림에는 격자가 없으므로 편집을 돕는 최소한으로만 남긴다. */
    var alpha=Math.min(0.30,0.07+vt.scale*.10);
    _ctx.fillStyle='rgba(0,0,0,'+alpha+')';
    for(var c=sC;c<eC;c++){
      for(var r=sR;r<eR;r++) _ctx.fillRect(c*cp+vt.offsetX-1,r*cp+vt.offsetY-1,2,2);
    }
  }
  return{init,render};
})();

}());
