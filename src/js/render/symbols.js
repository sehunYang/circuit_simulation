(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Symbols — 소자 심볼 렌더링
 *
 *   좌표 규약: 모든 그리기 함수는 (cx,cy) 중심, r=size/2 반지름 기준.
 *   심볼은 좌우 단자(±r)를 잇는 가로선 위에 그려진다.
 *   회전은 draw()에서 ctx 변환으로 일괄 처리 (개별 함수는 rotation 무관).
 *   선 두께 = size*0.042 (draw에서 설정), 색상은 opts.color로 오버라이드.
 *
 *   ── 소자 기하는 변경 금지 ────────────────────────────────────────
 *   아래 그리기 함수들의 좌표·비율은 이미 완성된 디자인이다. 수능 지면
 *   규격 적용은 **색(검정 잉크)·서체·선 굵기**에만 해당하며 모양은 그대로다.
 *
 *   ctx 인자는 CanvasRenderingContext2D 또는 App.SN.Recorder 를 받는다.
 *   둘 다 같은 경로 API 를 제공하므로 화면과 SVG 내보내기가 **같은 코드**를
 *   통과한다 → 보이는 그림과 내보낸 벡터의 기하가 100% 일치한다.
 * ════════════════════════════════════════════════════════════════════ */
App.Symbols=(function(){

  /* ── 직류 전원: 긴 판(+) / 짧은 판(−) ──────────────────────────── */
  function drawDCSource(ctx,cx,cy,r){
    var gap=r*.11;       // 두 판 사이 절반 간격
    var longH=r*.40;     // 긴 판(양극) 절반 높이
    var shortH=r*.24;    // 짧은 판(음극) 절반 높이
    ctx.beginPath();
    ctx.moveTo(cx-r,cy); ctx.lineTo(cx-gap,cy);              // 좌측 단자선
    ctx.moveTo(cx+gap,cy); ctx.lineTo(cx+r,cy);              // 우측 단자선
    ctx.moveTo(cx-gap,cy-longH);  ctx.lineTo(cx-gap,cy+longH);  // 긴 판
    ctx.moveTo(cx+gap,cy-shortH); ctx.lineTo(cx+gap,cy+shortH); // 짧은 판
    ctx.stroke();
  }

  /* ── 교류 전원: 원 + 사인파 ─────────────────────────────────────── */
  function drawACSource(ctx,cx,cy,r){
    var R=r*.45;   // 원 반지름
    ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.stroke();
    /* 내부 사인파 (2개 베지어로 1주기) */
    ctx.beginPath();
    ctx.moveTo(cx-r*.30,cy);
    ctx.bezierCurveTo(cx-r*.15,cy-r*.25, cx,cy-r*.25, cx,cy);
    ctx.bezierCurveTo(cx,cy+r*.25, cx+r*.15,cy+r*.25, cx+r*.30,cy);
    ctx.stroke();
    /* 좌우 단자선 */
    ctx.beginPath();
    ctx.moveTo(cx-r,cy); ctx.lineTo(cx-R,cy);
    ctx.moveTo(cx+R,cy); ctx.lineTo(cx+r,cy);
    ctx.stroke();
  }

  /* ── 저항: ANSI 지그재그 (6회 꺾임) ─────────────────────────────── */
  function drawResistor(ctx,cx,cy,r){
    var amp=r*.22;             // 지그재그 진폭
    var x0=cx-r*.64, x1=cx+r*.64;  // 지그재그 시작/끝 x
    var d=(x1-x0)/12;          // 반 스텝 폭 (균일 기울기 보장)
    ctx.beginPath();
    ctx.moveTo(cx-r,   cy);    // 좌측 단자
    ctx.lineTo(x0,     cy);
    ctx.lineTo(x0+ 1*d,cy-amp);
    ctx.lineTo(x0+ 3*d,cy+amp);
    ctx.lineTo(x0+ 5*d,cy-amp);
    ctx.lineTo(x0+ 7*d,cy+amp);
    ctx.lineTo(x0+ 9*d,cy-amp);
    ctx.lineTo(x0+11*d,cy+amp);
    ctx.lineTo(x1,     cy);
    ctx.lineTo(cx+r,   cy);    // 우측 단자
    ctx.stroke();
  }

  /* ── 커패시터: 평행 두 판 ───────────────────────────────────────── */
  function drawCapacitor(ctx,cx,cy,r){
    var g=r*.10;         // 두 판 사이 절반 간격
    var plateH=r*.38;    // 판 절반 높이
    ctx.beginPath();
    ctx.moveTo(cx-g,cy-plateH); ctx.lineTo(cx-g,cy+plateH);  // 좌측 판
    ctx.moveTo(cx+g,cy-plateH); ctx.lineTo(cx+g,cy+plateH);  // 우측 판
    ctx.moveTo(cx-r,cy); ctx.lineTo(cx-g,cy);                 // 좌측 단자
    ctx.moveTo(cx+g,cy); ctx.lineTo(cx+r,cy);                 // 우측 단자
    ctx.stroke();
  }

  /* ── 인덕터: 4개 원형 코일 (G1 연속 베지어 필렛) ─────────────────
   *   각 코일은 원호(arc) + 코일 간 부드러운 연결(quadraticCurveTo).
   *   R=코일 반지름, space=코일 중심 간격(R√2). */
  function drawInductor(ctx,cx,cy,r){
    var loops=4;
    var R    =r*0.25;            // 코일 반지름
    var space=R*Math.SQRT2;      // 코일 중심 간격
    var x0   =cx-(loops-1)*space/2;   // 첫 코일 중심 x
    var f    =0.28;              // 필렛 계수
    var eps  =R*f;
    var th1s =Math.PI+Math.asin(f);   // 첫 코일 시작각
    var thEnd=Math.PI/4-f;            // 코일 종료각
    var thSt =3*Math.PI/4+f;          // 코일 시작각
    var thLE =-f;                     // 마지막 코일 종료각
    var xLast=x0+(loops-1)*space;     // 마지막 코일 중심 x
    ctx.beginPath();
    ctx.moveTo(cx-r,cy);              // 좌측 단자
    ctx.lineTo(x0-R-eps,cy);
    ctx.quadraticCurveTo(x0-R,cy, x0+R*Math.cos(th1s),cy+R*Math.sin(th1s));
    ctx.arc(x0,cy,R,th1s,thEnd,false);
    for(var i=0;i<loops-1;i++){
      var xci=x0+i*space, xci1=xci+space;
      ctx.quadraticCurveTo(
        xci +R*Math.cos(Math.PI/4), cy+R*Math.sin(Math.PI/4),
        xci1+R*Math.cos(thSt),      cy+R*Math.sin(thSt));
      ctx.arc(xci1,cy,R,thSt,(i===loops-2)?thLE:thEnd,false);
    }
    ctx.quadraticCurveTo(xLast+R,cy, xLast+R+eps,cy);
    ctx.lineTo(cx+r,cy);             // 우측 단자
    ctx.stroke();
  }

  /* ── 분기점: 중심 점 + 각 포트로의 선 (3way/4way) ───────────────── */
  function drawJunction(ctx,cx,cy,r,ways){
    ctx.beginPath(); ctx.arc(cx,cy,r*.10,0,Math.PI*2); ctx.fill();   // 중심 점
    ctx.beginPath();
    ctx.moveTo(cx-r,cy); ctx.lineTo(cx+r,cy);   // 좌우(L-R)
    ctx.moveTo(cx,cy);   ctx.lineTo(cx,cy+r);   // 하(B)
    if(ways===4){ ctx.moveTo(cx,cy-r); ctx.lineTo(cx,cy); }  // 상(T)
    ctx.stroke();
  }

  /* ════════════════════════════════════════════════════════════════
   * 값 라벨 (소자 아래 표시)
   *
   *   수능 지면 규격: 배경 상자 없이 검정 글자만 둔다. 도선 위에 겹칠 때를
   *   대비해 흰색 헤일로(외곽선)를 깔아 가독성을 확보한다.
   * ════════════════════════════════════════════════════════════════ */
  function labelOffsetRatio(type){
    /* 전원은 심볼이 크므로 라벨을 더 아래로, 레일 라벨은 이름을 심볼 위에 */
    if(type===TYPE.LABEL) return -0.62;
    return (type===TYPE.DC_SOURCE||type===TYPE.AC_SOURCE)?0.52:0.44;
  }
  function labelFontSize(cellPx){
    var FS=App.SN.FS;
    return Math.max(FS.valueMin,Math.min(FS.valueMax,cellPx*0.26));
  }

  function drawLabel(ctx,comp,cx,cy,cellPx){
    var type=comp.type;
    if(NODE_TYPES[type]&&type!==TYPE.LABEL) return;             // 분기점·접지는 라벨 없음
    if(!App.State.showLabels&&type!==TYPE.LABEL) return;       // 특성값 숨김 (레일 이름은 항상)
    var text=_makeLabel(comp);
    if(!text) return;

    var fs=labelFontSize(cellPx);
    var ly=cy+cellPx*labelOffsetRatio(type);
    App.SN.label(ctx,text,cx,ly,fs,{baseline:'top',italic:true,halo:3});
  }

  /* 소자 값 → 표시 문자열 (SI 접두어 자동 선택) */
  function _makeLabel(comp){
    if(comp.type===TYPE.LABEL){                                     /* 레일 이름 (+ 전위 = 전원) */
      var rv=App.Netlist.railVoltage(comp);
      return App.Netlist.labelName(comp)+(rv?' '+(Math.abs(rv)%1?rv.toFixed(1):rv)+' V':'');
    }
    if(comp.type===TYPE.NPN) return 'npn';
    if(comp.type===TYPE.PNP) return 'pnp';
    if(comp.type===TYPE.DIODE||comp.type===TYPE.SWITCH||comp.type===TYPE.GROUND) return '';
    var v=comp.value; if(v==null) return '';
    switch(comp.type){
      case TYPE.DC_SOURCE: return v+' V';
      case TYPE.BULB:
        if(v>=1e3) return (v/1e3).toFixed(v%1e3?1:0)+' kΩ';
        return v+' Ω';
      case TYPE.AC_SOURCE: return v+' V~';
      case TYPE.RESISTOR:
        if(v>=1e6) return (v/1e6).toFixed(v%1e6?1:0)+' MΩ';
        if(v>=1e3) return (v/1e3).toFixed(v%1e3?1:0)+' kΩ';
        return v+' Ω';
      case TYPE.CAPACITOR:
        if(v>=1e-3) return (v*1e3).toFixed(1)+' mF';
        if(v>=1e-6) return Math.round(v*1e6)+' µF';
        return (v*1e9).toFixed(0)+' nF';
      case TYPE.INDUCTOR:
        if(v>=1)    return v+' H';
        if(v>=1e-3) return Math.round(v*1e3)+' mH';
        return (v*1e6).toFixed(0)+' µH';
      default: return '';
    }
  }

  /* ════════════════════════════════════════════════════════════════
   * 공개 그리기 진입점
   * ════════════════════════════════════════════════════════════════ */

  /* 타입→그리기 함수 디스패치 테이블 */
  /* ── 스위치: 두 단자 접점 + 칼날 ──────────────────────────────────
   *   편집 모드 = 열림(칼날이 들려 있음), 실행·비유 모드 = 닫힘(수평).
   *   상태는 App.State.mode 로 판단한다 (드로어는 소자를 모른다). */
  function drawSwitch(ctx,cx,cy,r,opts){
    var comp=opts&&opts.comp;
    var closed=App.Netlist.switchClosed(comp||{}, !!(App.State&&App.State.mode&&App.State.mode!=='edit'));
    var a=cx-r*.42, b=cx+r*.42, dot=r*.07;
    ctx.beginPath();
    ctx.moveTo(cx-r,cy); ctx.lineTo(a,cy);            // 좌측 단자선
    ctx.moveTo(b,cy);    ctx.lineTo(cx+r,cy);         // 우측 단자선
    ctx.stroke();
    /* 칼날: 좌 접점에서 우 접점으로, 열리면 위로 들림 */
    var ang=closed?0:-0.55;
    var len=(b-a)*1.02;
    ctx.beginPath();
    ctx.moveTo(a,cy); ctx.lineTo(a+len*Math.cos(ang), cy+len*Math.sin(ang));
    ctx.stroke();
    /* 접점 (작은 원) */
    ctx.beginPath(); ctx.arc(a,cy,dot,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(b,cy,dot,0,Math.PI*2); ctx.fill();
  }

  /* ── 접지: 포트(상단)에서 내려와 가로선 3개 (점점 짧게) ─────────── */
  function drawGround(ctx,cx,cy,r){
    ctx.beginPath();
    ctx.moveTo(cx,cy-r); ctx.lineTo(cx,cy+r*.05);
    ctx.moveTo(cx-r*.55,cy+r*.05); ctx.lineTo(cx+r*.55,cy+r*.05);
    ctx.moveTo(cx-r*.35,cy+r*.32); ctx.lineTo(cx+r*.35,cy+r*.32);
    ctx.moveTo(cx-r*.15,cy+r*.59); ctx.lineTo(cx+r*.15,cy+r*.59);
    ctx.stroke();
  }

  /* ── 레일 라벨: 포트(하단)에서 올라와 작은 원 — 이름은 값 라벨로 위에 표시 ── */
  function drawRailLabel(ctx,cx,cy,r){
    ctx.beginPath();
    ctx.moveTo(cx,cy+r); ctx.lineTo(cx,cy-r*.25);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx,cy-r*.40,r*.15,0,Math.PI*2); ctx.stroke();
  }

  /* ── 전구: 원 + X (수능 지면 규격 ⊗) ────────────────────────────── */
  function drawBulb(ctx,cx,cy,r){
    var R=r*.42, k=R*Math.SQRT1_2;
    ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx-k,cy-k); ctx.lineTo(cx+k,cy+k);
    ctx.moveTo(cx-k,cy+k); ctx.lineTo(cx+k,cy-k);
    ctx.moveTo(cx-r,cy); ctx.lineTo(cx-R,cy);
    ctx.moveTo(cx+R,cy); ctx.lineTo(cx+r,cy);
    ctx.stroke();
  }

  /* ── 다이오드: 삼각형(애노드, 좌) → 막대(캐소드, 우) ───────────── */
  function drawDiode(ctx,cx,cy,r){
    var h=r*.34, w=r*.36;
    ctx.beginPath();
    ctx.moveTo(cx-r,cy); ctx.lineTo(cx-w,cy);
    ctx.moveTo(cx+w,cy); ctx.lineTo(cx+r,cy);
    ctx.moveTo(cx+w,cy-h); ctx.lineTo(cx+w,cy+h);     // 캐소드 막대
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx-w,cy-h); ctx.lineTo(cx+w,cy); ctx.lineTo(cx-w,cy+h); ctx.closePath();
    ctx.fill();
  }

  /* ── BJT: 원 + 베이스 막대 + 컬렉터(위)·이미터(아래) 사선, 이미터 화살표 ──
   *   포트: L=베이스, T=컬렉터, B=이미터. npn 화살표는 밖으로, pnp 는 안으로. */
  function drawBJT(ctx,cx,cy,r,pnp){
    var R=r*.55;
    ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.stroke();
    var bx=cx-r*.12, bh=r*.30;              // 베이스 막대
    ctx.beginPath();
    ctx.moveTo(cx-r,cy); ctx.lineTo(bx,cy);               // 베이스 단자
    ctx.moveTo(bx,cy-bh); ctx.lineTo(bx,cy+bh);           // 막대
    ctx.moveTo(bx,cy-bh*.5); ctx.lineTo(cx+r*.30,cy-R*.9); ctx.lineTo(cx+r*.30,cy-r);   // 컬렉터
    ctx.moveTo(bx,cy+bh*.5); ctx.lineTo(cx+r*.30,cy+R*.9); ctx.lineTo(cx+r*.30,cy+r);   // 이미터
    ctx.stroke();
    /* 이미터 화살표 */
    var ex0=bx, ey0=cy+bh*.5, ex1=cx+r*.30, ey1=cy+R*.9;
    var ang=Math.atan2(ey1-ey0,ex1-ex0), al=r*.22;
    var tipx, tipy, dir;
    if(pnp){ tipx=ex0+(ex1-ex0)*.25; tipy=ey0+(ey1-ey0)*.25; dir=ang+Math.PI; }
    else   { tipx=ex1-(ex1-ex0)*.05; tipy=ey1-(ey1-ey0)*.05; dir=ang; }
    ctx.beginPath();
    ctx.moveTo(tipx,tipy);
    ctx.lineTo(tipx-al*Math.cos(dir-0.45), tipy-al*Math.sin(dir-0.45));
    ctx.lineTo(tipx-al*Math.cos(dir+0.45), tipy-al*Math.sin(dir+0.45));
    ctx.closePath(); ctx.fill();
  }

  var DRAWERS={};
  DRAWERS[TYPE.BULB]      =function(ctx,cx,cy,r){ drawBulb(ctx,cx,cy,r); };
  DRAWERS[TYPE.DIODE]     =function(ctx,cx,cy,r){ drawDiode(ctx,cx,cy,r); };
  DRAWERS[TYPE.NPN]       =function(ctx,cx,cy,r){ drawBJT(ctx,cx,cy,r,false); };
  DRAWERS[TYPE.PNP]       =function(ctx,cx,cy,r){ drawBJT(ctx,cx,cy,r,true); };
  DRAWERS[TYPE.SWITCH]    =function(ctx,cx,cy,r,opts){ drawSwitch(ctx,cx,cy,r,opts); };
  DRAWERS[TYPE.GROUND]    =function(ctx,cx,cy,r){ drawGround(ctx,cx,cy,r); };
  DRAWERS[TYPE.LABEL]     =function(ctx,cx,cy,r){ drawRailLabel(ctx,cx,cy,r); };
  DRAWERS[TYPE.DC_SOURCE] =function(ctx,cx,cy,r){ drawDCSource(ctx,cx,cy,r); };
  DRAWERS[TYPE.AC_SOURCE] =function(ctx,cx,cy,r){ drawACSource(ctx,cx,cy,r); };
  DRAWERS[TYPE.RESISTOR]  =function(ctx,cx,cy,r){ drawResistor(ctx,cx,cy,r); };
  DRAWERS[TYPE.CAPACITOR] =function(ctx,cx,cy,r){ drawCapacitor(ctx,cx,cy,r); };
  DRAWERS[TYPE.INDUCTOR]  =function(ctx,cx,cy,r){ drawInductor(ctx,cx,cy,r); };
  DRAWERS[TYPE.JUNCTION_3]=function(ctx,cx,cy,r){ drawJunction(ctx,cx,cy,r,3); };
  DRAWERS[TYPE.JUNCTION_4]=function(ctx,cx,cy,r){ drawJunction(ctx,cx,cy,r,4); };

  /* draw: 회전 변환 + 스타일 설정 후 타입별 그리기 함수 호출
   *   ctx        : Canvas 2D 컨텍스트 또는 App.SN.Recorder
   *   opts.color : 선/채움 색상 오버라이드 (기본 = 지면 잉크 검정)
   *   opts.lineWidth : 선 굵기 오버라이드 */
  function draw(ctx,type,cx,cy,size,rotation,opts){
    opts=opts||{};
    ctx.save();
    ctx.translate(cx,cy); ctx.rotate((rotation||0)*Math.PI/180); ctx.translate(-cx,-cy);
    ctx.lineWidth=opts.lineWidth||Math.max(1.5,size*.042);
    ctx.lineCap='round'; ctx.lineJoin='round';
    var col=opts.color||App.SN.TOKENS.ink;
    ctx.strokeStyle=col; ctx.fillStyle=col;
    var fn=DRAWERS[type];
    if(fn) fn(ctx,cx,cy,size/2,opts);   /* opts.comp: 상태가 있는 소자(스위치 on/off) */
    ctx.restore();
  }

  /* drawMini: 사이드바 미니 심볼 · 드래그 고스트 (캔버스 중앙에 회전 없이)
   * 메인 캔버스와 같은 이유로 HiDPI 대응 — 백업 저장소만 배율만큼 키우고
   * CSS 크기는 원래 논리 크기로 고정한다. 논리 크기는 최초 호출 때의
   * width/height 속성값이며, 재호출로 배율이 누적되지 않게 보관해 둔다. */
  function drawMini(canvas,type){
    var w=canvas._miniW||canvas.width, h=canvas._miniH||canvas.height;
    canvas._miniW=w; canvas._miniH=h;
    var dpr=window.devicePixelRatio||1;
    canvas.style.width=w+'px'; canvas.style.height=h+'px';
    canvas.width=Math.round(w*dpr); canvas.height=Math.round(h*dpr);
    var ctx=canvas.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0);   /* width 대입이 변환을 지우므로 재설정 */
    ctx.clearRect(0,0,w,h);
    draw(ctx,type,w/2,h/2,Math.min(w,h)*.78,0,{color:App.SN.TOKENS.ink});
  }

  return{draw,drawLabel,drawMini,makeLabel:_makeLabel,labelFontSize,labelOffsetRatio};
})();

}());
