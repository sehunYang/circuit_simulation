(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.SN — 수능 지면(paper) 작도 규격 토큰 + Canvas2D→SVG 경로 기록기
 *
 *   근거: 2022~2026 수능 물리학Ⅰ·Ⅱ 문항 그림의 공통 작도 관례
 *     · 완전 흑백. 검정 선 + 회색 채움만 (컬러 없음)
 *     · 가는 실선, 라벨은 글자로
 *     · 서체는 수식 세리프(HyhwpEQ) / 한글 명조 계열(맑은 고딕)
 *   (형제 프로젝트 mechanics_simulation/js/svg-shapes.js 와 같은 규격)
 *
 *   ── 회로 소자 디자인 불변 원칙 ──────────────────────────────────
 *   mechanics 는 요소 모양을 SVG path 로 **새로 작도**했지만, 이 프로젝트의
 *   소자 심볼(App.Symbols)은 이미 완성된 디자인이므로 기하를 손대지 않는다.
 *   대신 Canvas2D 경로 API 와 같은 인터페이스를 갖는 기록기(Recorder)를 만들어
 *   **같은 그리기 함수**를 그대로 통과시킨다:
 *
 *       App.Symbols.draw(ctx,      ...)  → 화면 (Canvas)
 *       App.Symbols.draw(recorder, ...)  → SVG  (<path d="…">)
 *
 *   따라서 보이는 그림과 내보낸 벡터가 기하를 100% 공유하며,
 *   심볼 코드를 한 줄도 고치지 않고 SVG 내보내기를 얻는다.
 * ════════════════════════════════════════════════════════════════════ */
App.SN=(function(){

  /* ── 지면 스타일 토큰 ─────────────────────────────────────────── */
  var TOKENS={
    ink:      '#000000',   // 모든 선
    bodyFill: '#e8e8e8',   // 연회색 채움
    paper:    '#ffffff',   // 지면 바탕
    /* 선 굵기 (화면 px 고정) */
    lwThin:   1.0,         // 보조선
    lwGeom:   1.3,         // 기하 윤곽
    lwWire:   1.7,         // 도선 — 지형선 급 강조
    /* 서체 — 브라우저가 글리프 단위로 폴백하므로 한 스택에 둘 다 넣는다.
       라틴/숫자는 HyhwpEQ, 한글은 맑은 고딕이 자동으로 잡힌다. */
    font:     "'HyhwpEQ', 'HYhwpEQ', 'Malgun Gothic', '맑은 고딕', sans-serif",
    fontKo:   "'Malgun Gothic', '맑은 고딕', 'HyhwpEQ', sans-serif",
  };

  /* 라벨 크기 (화면 px 고정) — 가독성 하한을 둔다 */
  var FS={
    valueMin: 10, valueMax: 14,   // 소자 특성값
    badgeMin:  9, badgeMax: 13,   // 전류 배지
    notice:   12,                 // 안내 문구
  };

  var _n=function(v){ return Math.round(v*1000)/1000; };   // path 문자열 안정화

  /* ══════════════════════════════════════════════════════════════
   * Recorder — CanvasRenderingContext2D 의 경로 API 부분집합을 흉내내
   *            SVG path `d` 문자열과 <path> 조각을 누적한다.
   *
   *   지원: save/restore, translate/rotate/scale,
   *         beginPath/moveTo/lineTo/arc/bezierCurveTo/quadraticCurveTo/
   *         closePath/rect/stroke/fill,
   *         속성 strokeStyle/fillStyle/lineWidth/lineCap/lineJoin/globalAlpha
   *
   *   변환은 2×3 행렬 [a,b,c,d,e,f] 스택으로 직접 적용한다:
   *     x' = a·x + c·y + e     y' = b·x + d·y + f
   *   (SVG 에 transform 속성을 쓰지 않고 좌표를 미리 접어 넣으므로
   *    내보낸 path 좌표가 곧 최종 좌표 — 검증·편집이 쉽다)
   * ══════════════════════════════════════════════════════════════ */
  function Recorder(){
    this._m=[1,0,0,1,0,0];
    this._stack=[];
    this._d='';           // 현재 경로 d 문자열
    this._sub='';         // 현재 서브패스 시작점 (closePath 후 복귀용)
    this._cur=null;       // 현재 펜 위치 (로컬 좌표)
    this.parts=[];        // <path>/<text> 조각
    this.bb={x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity};
    /* Canvas 호환 속성 */
    this.strokeStyle='#000000';
    this.fillStyle='#000000';
    this.lineWidth=1;
    this.lineCap='butt';
    this.lineJoin='miter';
    this.globalAlpha=1;
  }

  /* ── 변환 ── */
  Recorder.prototype.save=function(){
    this._stack.push({m:this._m.slice(),
      strokeStyle:this.strokeStyle, fillStyle:this.fillStyle,
      lineWidth:this.lineWidth, lineCap:this.lineCap,
      lineJoin:this.lineJoin, globalAlpha:this.globalAlpha});
  };
  Recorder.prototype.restore=function(){
    var s=this._stack.pop(); if(!s) return;
    this._m=s.m;
    this.strokeStyle=s.strokeStyle; this.fillStyle=s.fillStyle;
    this.lineWidth=s.lineWidth; this.lineCap=s.lineCap;
    this.lineJoin=s.lineJoin; this.globalAlpha=s.globalAlpha;
  };
  /* m = m · n  (Canvas 와 같은 우측 곱) */
  Recorder.prototype._mul=function(n){
    var m=this._m;
    this._m=[
      m[0]*n[0]+m[2]*n[1],       m[1]*n[0]+m[3]*n[1],
      m[0]*n[2]+m[2]*n[3],       m[1]*n[2]+m[3]*n[3],
      m[0]*n[4]+m[2]*n[5]+m[4],  m[1]*n[4]+m[3]*n[5]+m[5],
    ];
  };
  Recorder.prototype.translate=function(x,y){ this._mul([1,0,0,1,x,y]); };
  Recorder.prototype.rotate=function(r){
    var c=Math.cos(r), s=Math.sin(r);
    this._mul([c,s,-s,c,0,0]);
  };
  Recorder.prototype.scale=function(sx,sy){ this._mul([sx,0,0,sy,0,0]); };
  Recorder.prototype.setLineDash=function(){};   /* SVG 쪽은 dash 미사용 */

  /* 로컬 → 최종 좌표 */
  Recorder.prototype._pt=function(x,y){
    var m=this._m;
    return{x:m[0]*x+m[2]*y+m[4], y:m[1]*x+m[3]*y+m[5]};
  };
  /* 현재 변환의 균일 배율 (강체+균일배율 변환만 사용하므로 유효) */
  Recorder.prototype._scale=function(){
    var m=this._m;
    return Math.sqrt(Math.abs(m[0]*m[3]-m[1]*m[2]))||1;
  };
  Recorder.prototype._grow=function(x,y){
    var b=this.bb;
    if(!isFinite(x)||!isFinite(y)) return;
    if(x<b.x0) b.x0=x; if(x>b.x1) b.x1=x;
    if(y<b.y0) b.y0=y; if(y>b.y1) b.y1=y;
  };

  /* ── 경로 ── */
  Recorder.prototype.beginPath=function(){ this._d=''; this._cur=null; this._sub=null; };
  Recorder.prototype.moveTo=function(x,y){
    var p=this._pt(x,y); this._grow(p.x,p.y);
    this._d+=' M '+_n(p.x)+' '+_n(p.y);
    this._cur={x:x,y:y}; this._sub={x:x,y:y};
  };
  Recorder.prototype.lineTo=function(x,y){
    if(!this._cur){ this.moveTo(x,y); return; }
    var p=this._pt(x,y); this._grow(p.x,p.y);
    this._d+=' L '+_n(p.x)+' '+_n(p.y);
    this._cur={x:x,y:y};
  };
  Recorder.prototype.closePath=function(){
    if(!this._cur) return;
    this._d+=' Z';
    if(this._sub) this._cur={x:this._sub.x,y:this._sub.y};
  };
  Recorder.prototype.rect=function(x,y,w,h){
    this.moveTo(x,y); this.lineTo(x+w,y); this.lineTo(x+w,y+h); this.lineTo(x,y+h); this.closePath();
  };
  Recorder.prototype.bezierCurveTo=function(c1x,c1y,c2x,c2y,x,y){
    if(!this._cur) this.moveTo(c1x,c1y);
    var a=this._pt(c1x,c1y), b=this._pt(c2x,c2y), p=this._pt(x,y);
    this._grow(p.x,p.y);
    this._d+=' C '+_n(a.x)+' '+_n(a.y)+' '+_n(b.x)+' '+_n(b.y)+' '+_n(p.x)+' '+_n(p.y);
    this._cur={x:x,y:y};
  };
  Recorder.prototype.quadraticCurveTo=function(cx,cy,x,y){
    if(!this._cur) this.moveTo(cx,cy);
    var c=this._pt(cx,cy), p=this._pt(x,y);
    this._grow(p.x,p.y);
    this._d+=' Q '+_n(c.x)+' '+_n(c.y)+' '+_n(p.x)+' '+_n(p.y);
    this._cur={x:x,y:y};
  };

  /* Canvas arc 의 실제 회전량 — 시작각에서 끝각까지 부호 있는 delta.
     Canvas 규약: ccw=false 면 증가 방향, true 면 감소 방향으로 돌되
     한 바퀴(2π)를 넘지 않는다. */
  function _arcDelta(start,end,ccw){
    var TAU=Math.PI*2, d=end-start;
    if(!ccw){
      if(d>=TAU) return TAU;
      d=d%TAU; if(d<0) d+=TAU;
      return d;
    }
    if(d<=-TAU) return -TAU;
    d=d%TAU; if(d>0) d-=TAU;
    return d;
  }

  Recorder.prototype.arc=function(cx,cy,r,start,end,ccw){
    var delta=_arcDelta(start,end,!!ccw);
    var rr=r*this._scale();
    var self=this;
    function at(ang){ return self._pt(cx+r*Math.cos(ang), cy+r*Math.sin(ang)); }

    var p0=at(start);
    /* Canvas 는 진행 중인 경로가 있으면 호 시작점까지 직선을 잇는다 */
    if(this._cur){ this._d+=' L '+_n(p0.x)+' '+_n(p0.y); }
    else { this._d+=' M '+_n(p0.x)+' '+_n(p0.y); this._sub={x:cx+r*Math.cos(start),y:cy+r*Math.sin(start)}; }
    this._grow(p0.x,p0.y);

    /* SVG 호는 180°를 넘는 구간을 한 번에 그리면 방향이 모호해지므로
       π 단위로 쪼갠다 (한 바퀴 = 정확히 2조각).
       eps 는 |delta| 가 π 의 정수배일 때 부동소수 오차로 한 조각 더
       생기는 것을 막는다. sweep: 화면 좌표계에서 각도 증가 = 1 */
    var TAU=Math.PI*2;
    var steps=Math.max(1,Math.ceil(Math.abs(delta)/Math.PI-1e-9));
    var step=delta/steps;
    var sweep=(step*(this._m[0]*this._m[3]-this._m[1]*this._m[2])>=0)?1:0;
    for(var i=1;i<=steps;i++){
      var p=at(start+step*i);
      this._grow(p.x,p.y);
      this._d+=' A '+_n(rr)+' '+_n(rr)+' 0 0 '+sweep+' '+_n(p.x)+' '+_n(p.y);
    }
    /* 정확히 한 바퀴면 시작점으로 닫힌다 */
    var endLocal={x:cx+r*Math.cos(start+delta), y:cy+r*Math.sin(start+delta)};
    this._cur=endLocal;
    if(Math.abs(Math.abs(delta)-TAU)<1e-9) this._d+=' Z';
  };

  /* ── 출력 ── */
  function _esc(t){
    return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  Recorder.prototype._emit=function(attrs){
    var d=this._d.trim();
    if(!d) return;
    this.parts.push('<path d="'+d+'" '+attrs+'/>');
  };
  Recorder.prototype.stroke=function(){
    this._emit('fill="none" stroke="'+this.strokeStyle+'"'
      +' stroke-width="'+_n(this.lineWidth)+'"'
      +' stroke-linecap="'+(this.lineCap==='butt'?'butt':this.lineCap)+'"'
      +' stroke-linejoin="'+(this.lineJoin==='miter'?'miter':this.lineJoin)+'"');
  };
  Recorder.prototype.fill=function(){
    this._emit('fill="'+this.fillStyle+'" stroke="none"');
  };
  /* 텍스트는 경로가 아니므로 별도 조각으로.
   * o.width(측정된 글자 폭)를 주면 글자 상자까지 bbox 에 포함시킨다 —
   * 앵커 점만 넣으면 viewBox·PNG 크롭에서 라벨이 잘린다. */
  Recorder.prototype.text=function(t,x,y,size,opt){
    var o=opt||{};
    var p=this._pt(x,y); this._grow(p.x,p.y);
    if(o.width){
      var s=this._scale(), hw=o.width*s/2, hh=size*s/2;
      this._grow(p.x-hw,p.y-hh); this._grow(p.x+hw,p.y+hh);
    }
    this.parts.push('<text x="'+_n(p.x)+'" y="'+_n(p.y)+'"'
      +' font-family="'+_esc(o.ko?TOKENS.fontKo:TOKENS.font)+'"'
      +' font-size="'+_n(size)+'"'+(o.italic?' font-style="italic"':'')
      +' text-anchor="'+(o.align||'middle')+'"'
      +' dominant-baseline="'+(o.baseline||'middle')+'"'
      +' fill="'+(o.color||TOKENS.ink)+'">'+_esc(t)+'</text>');
  };

  /** 누적된 조각을 흰 바탕 SVG 문서로 직렬화 (viewBox = 내용 bbox + 여백) */
  Recorder.prototype.toSVG=function(){
    var b=this.bb;
    if(!isFinite(b.x0)){ b={x0:0,y0:0,x1:100,y1:100}; }
    var pad=Math.max(b.x1-b.x0, b.y1-b.y0)*0.06+12;
    var vx=_n(b.x0-pad), vy=_n(b.y0-pad);
    var vw=_n((b.x1-b.x0)+pad*2), vh=_n((b.y1-b.y0)+pad*2);
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
      +'<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+vx+' '+vy+' '+vw+' '+vh+'"'
      +' width="'+vw+'" height="'+vh+'">\n'
      +'<rect x="'+vx+'" y="'+vy+'" width="'+vw+'" height="'+vh+'" fill="'+TOKENS.paper+'"/>\n'
      +this.parts.join('\n')+'\n</svg>\n';
  };

  return{
    TOKENS:TOKENS, FS:FS, Recorder:Recorder,
    /* 화면 캔버스용 라벨 헬퍼 — 지면 서체로 그린다 */
    label:function(ctx,text,x,y,sizePx,opt){
      opt=opt||{};
      ctx.save();
      ctx.fillStyle=opt.color||TOKENS.ink;
      ctx.font=(opt.italic?'italic ':'')+(opt.weight||'')+(opt.weight?' ':'')
              +sizePx+'px '+(opt.ko?TOKENS.fontKo:TOKENS.font);
      ctx.textAlign=opt.align||'center';
      ctx.textBaseline=opt.baseline||'middle';
      if(opt.halo){            /* 선 위에 겹칠 때 가독성 확보 */
        ctx.strokeStyle=TOKENS.paper;
        ctx.lineWidth=opt.halo;
        ctx.lineJoin='round';
        ctx.strokeText(text,x,y);
      }
      ctx.fillText(text,x,y);
      ctx.restore();
    },
  };
})();

}());
