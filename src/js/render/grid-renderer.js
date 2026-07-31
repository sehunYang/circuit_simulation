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
    var W=_cv.width,H=_cv.height;
    _ctx.clearRect(0,0,W,H);
    var vt=App.State.viewTransform, cp=CELL_SIZE*vt.scale;
    /* 화면에 보이는 칸 범위만 순회 (성능) */
    var sC=Math.max(0,Math.floor(-vt.offsetX/cp)), eC=Math.min(GRID_COLS,Math.ceil((W-vt.offsetX)/cp)+1);
    var sR=Math.max(0,Math.floor(-vt.offsetY/cp)), eR=Math.min(GRID_ROWS,Math.ceil((H-vt.offsetY)/cp)+1);
    var alpha=Math.min(0.55,0.12+vt.scale*.18);
    _ctx.fillStyle='rgba(90,120,180,'+alpha+')';
    for(var c=sC;c<eC;c++){
      for(var r=sR;r<eR;r++) _ctx.fillRect(c*cp+vt.offsetX-1,r*cp+vt.offsetY-1,2,2);
    }
    var info=document.getElementById('info-overlay');
    if(info) info.textContent='scale:'+vt.scale.toFixed(2)+'  off:('+Math.round(vt.offsetX)+','+Math.round(vt.offsetY)+')';
  }
  return{init,render};
})();

}());
