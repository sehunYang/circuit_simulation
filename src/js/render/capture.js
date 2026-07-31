(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Capture — SVG 선화 내보내기 (수능 지면 규격)
 *
 *   화면 렌더와 **같은 심볼 그리기 함수**(App.Symbols.draw)를 통과시켜
 *   <path d="…"> 를 찍어낸다. ctx 자리에 App.SN.Recorder 를 넣으면
 *   같은 코드가 Canvas 대신 SVG 경로를 쌓는다 →
 *   보이는 그림과 내보낸 벡터가 기하를 100% 공유한다.
 *
 *   출력은 흰 바탕 · 검정 선 — 학습지·시험지에 그대로 붙일 수 있는 형태.
 *
 *   좌표계: 뷰포트와 무관하게 **scale=1, offset=0** 으로 고정해서 그린다.
 *           (그리드 1칸 = CELL_SIZE) 따라서 화면을 얼마나 확대해 두었든
 *           같은 회로는 항상 같은 SVG 를 낸다.
 * ════════════════════════════════════════════════════════════════════ */
App.Capture=(function(){

  var CS=null;   /* 셀 크기 (내보내기 기준) — build 시 CELL_SIZE 로 고정 */

  /* 소자 중심 (내보내기 좌표) */
  function _center(comp){
    return{x:(comp.gridX+0.5)*CS, y:(comp.gridY+0.5)*CS};
  }
  /* 포트 위치 (내보내기 좌표) — getPortGridPos 는 뷰포트 독립이라 그대로 쓴다 */
  function _port(comp,portId){
    var g=App.Geo.getPortGridPos(comp,portId);
    return{x:g.x*CS, y:g.y*CS};
  }

  /**
   * 현재 회로를 SVG 문자열로 직렬화.
   *   그리는 순서: 도선 → 소자 심볼 → 특성값 라벨
   *   편집 보조 표시(선택 박스·포트 점·격자)는 그림이 아니므로 제외한다.
   */
  function buildSceneSVG(){
    CS=CELL_SIZE;
    var SN=App.SN;
    var rec=new SN.Recorder();
    var lw=Math.max(1.5,CS*0.042);   /* 심볼 선 굵기 (화면과 같은 규칙) */

    /* ── 1. 도선 ── */
    rec.strokeStyle=SN.TOKENS.ink;
    rec.lineWidth=SN.TOKENS.lwWire;
    rec.lineCap='round'; rec.lineJoin='round';
    App.State.wires.forEach(function(wire){
      var from=App.State.getComponent(wire.fromId);
      var to  =App.State.getComponent(wire.toId);
      if(!from||!to) return;
      var p1=_port(from,wire.fromPort);
      var p2=_port(to,  wire.toPort);
      var path=App.Geo.calcWirePath(p1.x,p1.y,p2.x,p2.y,wire.direction);
      rec.beginPath();
      rec.moveTo(path[0].x,path[0].y);
      for(var i=1;i<path.length;i++) rec.lineTo(path[i].x,path[i].y);
      rec.stroke();
    });

    /* ── 2. 소자 심볼 ── */
    App.State.components.forEach(function(comp){
      var c=_center(comp);

      /* 분기점: 심볼의 고정 다리(L·R·B[·T]) 대신 **실제 연결된 포트로만**
       * 다리를 뻗는다. 지면에 붕 뜬 짧은 선이 남지 않게 하기 위한 것으로,
       * 기존 촬영 동작을 그대로 유지한 것이다 (심볼 디자인 변경 아님). */
      if(comp.type===TYPE.JUNCTION_3||comp.type===TYPE.JUNCTION_4){
        rec.strokeStyle=SN.TOKENS.ink; rec.lineWidth=lw; rec.lineCap='round';
        App.State.wires.forEach(function(w){
          var isFrom=(w.fromId===comp.id), isTo=(w.toId===comp.id);
          if(!isFrom&&!isTo) return;
          var pp=_port(comp,isFrom?w.fromPort:w.toPort);
          rec.beginPath(); rec.moveTo(c.x,c.y); rec.lineTo(pp.x,pp.y); rec.stroke();
        });
        /* 중심 접점 — 심볼과 같은 반지름 규약 (r·0.10, r=CS/2) */
        rec.fillStyle=SN.TOKENS.ink;
        rec.beginPath(); rec.arc(c.x,c.y,CS*0.05,0,Math.PI*2); rec.fill();
        return;
      }

      /* 그 외 소자: 화면과 **같은** 그리기 함수를 그대로 통과시킨다 */
      App.Symbols.draw(rec,comp.type,c.x,c.y,CS,comp.rotation,
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
        rec.text(text,c.x,ly+fs*0.5,fs,{italic:true});
      });
    }

    return rec.toSVG();
  }

  /** 촬영 버튼: SVG 파일로 저장 */
  function captureImage(){
    if(!App.State.components.length&&!App.State.wires.length){
      if(typeof showErrorToast==='function') showErrorToast('내보낼 회로가 없습니다.');
      return;
    }
    var svg=buildSceneSVG();
    var blob=new Blob([svg],{type:'image/svg+xml;charset=utf-8'});
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');
    a.href=url; a.download='circuit_'+Date.now()+'.svg';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }

  return{buildSceneSVG:buildSceneSVG, captureImage:captureImage};
})();

}());
