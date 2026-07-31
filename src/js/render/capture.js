(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Capture — 회로 선화 내보내기 (수능 지면 규격)
 *
 *   화면 렌더와 **같은 심볼 그리기 함수**(App.Symbols.draw)를 통과시킨다.
 *   그리기 대상(g)은 두 가지를 받는다:
 *     · App.SN.Recorder      → <path d="…"> 누적 (SVG · bbox 계산용)
 *     · CanvasRenderingContext2D → 픽셀 (PNG 저장용)
 *   Recorder 가 Canvas2D 경로 API 를 흉내내므로 _drawScene 한 벌로 둘 다
 *   처리되고, 보이는 그림과 내보낸 결과가 기하를 100% 공유한다.
 *
 *   출력은 흰 바탕 · 검정 선 — 학습지·시험지에 그대로 붙일 수 있는 형태.
 *   촬영 버튼은 PNG 를 저장한다(buildSceneSVG 는 같은 장면의 벡터 형태).
 *
 *   좌표계: 뷰포트와 무관하게 **scale=1, offset=0** 으로 고정해서 그린다.
 *           (그리드 1칸 = CELL_SIZE) 따라서 화면을 얼마나 확대해 두었든
 *           같은 회로는 항상 같은 결과를 낸다.
 * ════════════════════════════════════════════════════════════════════ */
App.Capture=(function(){

  var CS=CELL_SIZE;   /* 셀 크기 (내보내기 기준) */
  var PNG_SCALE=3;    /* PNG 배율 — 확대해 붙여도 선이 뭉개지지 않게 */

  /* 소자 중심 (내보내기 좌표) */
  function _center(comp){
    return{x:(comp.gridX+0.5)*CS, y:(comp.gridY+0.5)*CS};
  }
  /* 포트 위치 (내보내기 좌표) — getPortGridPos 는 뷰포트 독립이라 그대로 쓴다 */
  function _port(comp,portId){
    var g=App.Geo.getPortGridPos(comp,portId);
    return{x:g.x*CS, y:g.y*CS};
  }

  /* 라벨 폭 측정용 스크래치 컨텍스트 (bbox 계산에 필요) */
  var _measureCtx=null;
  function _measure(text,fs){
    if(!_measureCtx) _measureCtx=document.createElement('canvas').getContext('2d');
    _measureCtx.font='italic '+fs+'px '+App.SN.TOKENS.font;
    return _measureCtx.measureText(text).width;
  }

  /**
   * 장면 그리기 — g 는 App.SN.Recorder 또는 2D 컨텍스트.
   *   그리는 순서: 도선 → 소자 심볼 → 특성값 라벨
   *   편집 보조 표시(선택 박스·포트 점·격자)와 실행 모드 표시(전자·전류
   *   화살표·전류 배지)는 그림이 아니므로 제외한다.
   */
  function _drawScene(g){
    var SN=App.SN;
    var lw=Math.max(1.5,CS*0.042);   /* 심볼 선 굵기 (화면과 같은 규칙) */

    /* ── 1. 도선 ── */
    g.strokeStyle=SN.TOKENS.ink;
    g.lineWidth=SN.TOKENS.lwWire;
    g.lineCap='round'; g.lineJoin='round';
    App.State.wires.forEach(function(wire){
      var from=App.State.getComponent(wire.fromId);
      var to  =App.State.getComponent(wire.toId);
      if(!from||!to) return;
      var p1=_port(from,wire.fromPort);
      var p2=_port(to,  wire.toPort);
      var path=App.Geo.calcWirePath(p1.x,p1.y,p2.x,p2.y,wire.direction);
      g.beginPath();
      g.moveTo(path[0].x,path[0].y);
      for(var i=1;i<path.length;i++) g.lineTo(path[i].x,path[i].y);
      g.stroke();
    });

    /* ── 2. 소자 심볼 ── */
    App.State.components.forEach(function(comp){
      var c=_center(comp);

      /* 분기점: 심볼의 고정 다리(L·R·B[·T]) 대신 **실제 연결된 포트로만**
       * 다리를 뻗는다. 지면에 붕 뜬 짧은 선이 남지 않게 하기 위한 것으로,
       * 기존 촬영 동작을 그대로 유지한 것이다 (심볼 디자인 변경 아님). */
      if(comp.type===TYPE.JUNCTION_3||comp.type===TYPE.JUNCTION_4){
        g.strokeStyle=SN.TOKENS.ink; g.lineWidth=lw; g.lineCap='round';
        App.State.wires.forEach(function(w){
          var isFrom=(w.fromId===comp.id), isTo=(w.toId===comp.id);
          if(!isFrom&&!isTo) return;
          var pp=_port(comp,isFrom?w.fromPort:w.toPort);
          g.beginPath(); g.moveTo(c.x,c.y); g.lineTo(pp.x,pp.y); g.stroke();
        });
        /* 중심 접점(점)은 찍지 않는다 — 수능 문항 그림에서 분기점은 도선이
         * 만나는 것으로만 표현하고 별도 점을 두지 않는다. 다리들이 중심에서
         * 이미 만나므로 점 없이도 접속으로 읽힌다.
         * (화면 편집용 심볼 App.Symbols.drawJunction 의 점은 그대로 둔다 —
         *  거기서는 분기점 소자가 어디 있는지 보여야 하기 때문) */
        return;
      }

      /* 그 외 소자: 화면과 **같은** 그리기 함수를 그대로 통과시킨다 */
      App.Symbols.draw(g,comp.type,c.x,c.y,CS,comp.rotation,
                       {color:SN.TOKENS.ink,lineWidth:lw});
    });

    /* ── 3. 특성값 라벨 (표시 중일 때만) ── */
    if(App.State.showLabels){
      App.State.components.forEach(function(comp){
        if(comp.type===TYPE.JUNCTION_3||comp.type===TYPE.JUNCTION_4) return;
        var text=App.Symbols.makeLabel(comp);
        if(!text) return;
        var c=_center(comp);
        var fs=App.Symbols.labelFontSize(CS);
        var ly=c.y+CS*App.Symbols.labelOffsetRatio(comp.type);
        g.text(text,c.x,ly+fs*0.5,fs,{italic:true,width:_measure(text,fs)});
      });
    }
  }

  /** 내용 bbox + 여백 (SVG viewBox · PNG 크롭 공통 규칙) */
  function _sceneBounds(){
    var rec=new App.SN.Recorder();
    _drawScene(rec);
    var b=rec.bb;
    if(!isFinite(b.x0)) b={x0:0,y0:0,x1:100,y1:100};
    var pad=Math.max(b.x1-b.x0,b.y1-b.y0)*0.06+12;
    return{x:b.x0-pad, y:b.y0-pad,
           w:(b.x1-b.x0)+pad*2, h:(b.y1-b.y0)+pad*2, rec:rec};
  }

  /** 현재 회로를 SVG 문자열로 직렬화 (벡터가 필요할 때) */
  function buildSceneSVG(){
    var rec=new App.SN.Recorder();
    _drawScene(rec);
    return rec.toSVG();
  }

  /** 현재 회로를 흰 바탕 PNG 캔버스로 렌더 */
  function buildSceneCanvas(scale){
    var s=scale||PNG_SCALE;
    var b=_sceneBounds();
    var cv=document.createElement('canvas');
    cv.width =Math.max(1,Math.round(b.w*s));
    cv.height=Math.max(1,Math.round(b.h*s));
    var ctx=cv.getContext('2d');
    ctx.fillStyle=App.SN.TOKENS.paper;
    ctx.fillRect(0,0,cv.width,cv.height);
    ctx.setTransform(s,0,0,s,0,0);
    ctx.translate(-b.x,-b.y);
    /* Recorder 의 text() 에 맞춘 어댑터 — 지면 서체로 글자를 찍는다 */
    ctx.text=function(t,x,y,size,opt){ App.SN.label(ctx,t,x,y,size,opt); };
    _drawScene(ctx);
    return cv;
  }

  /** 촬영 버튼: PNG 파일로 저장 */
  function captureImage(){
    if(!App.State.components.length&&!App.State.wires.length){
      if(typeof showErrorToast==='function') showErrorToast('내보낼 회로가 없습니다.');
      return;
    }
    buildSceneCanvas().toBlob(function(blob){
      var url=URL.createObjectURL(blob);
      var a=document.createElement('a');
      a.href=url; a.download='circuit_'+Date.now()+'.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){URL.revokeObjectURL(url);},1000);
    },'image/png');
  }

  return{buildSceneSVG:buildSceneSVG, buildSceneCanvas:buildSceneCanvas,
         captureImage:captureImage};
})();

}());
