(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Scope — 오실로스코프 패널 (엔진 시간 영역 파형 v(t)·i(t))
 *
 *   실행 모드에서 파형(solverResult.wave)이 있고 회로에 교류 또는 비선형
 *   소자가 있을 때 열린다 (선형 직류 과도는 과도 응답 그래프가 맡는다).
 *   그리는 것: 선택한 소자의 v(t)(파랑, 왼쪽 축)·i(t)(주황, 오른쪽 축).
 *   아무것도 선택하지 않으면 전원 v(t) 와 첫 저항/전구의 v(t).
 *   실행 모드 재생 시간(run:time)에 맞춰 시간 커서를 그린다.
 * ════════════════════════════════════════════════════════════════════ */
App.Scope=(function(){
  var _panel,_cv,_ctx,_legend,_visible=false,_cursorT=null,_snapshot=null,_plot=null;
  var COL_V='#1d4ed8', COL_I='#b45309', COL_V2='#0e7490';

  function init(){
    _panel=document.getElementById('scope-panel');
    _cv=document.getElementById('scope-canvas');
    _legend=document.getElementById('scope-legend');
    if(!_panel||!_cv) return;
    _ctx=_cv.getContext('2d');
    var x=document.getElementById('scope-close-btn');
    if(x) x.addEventListener('click',hide);
    App.Events.on('solver:done',function(){ if(_visible) _draw(); });
    App.Events.on('state:changed',function(){ if(_visible) _draw(); });
    App.Events.on('run:time',function(t){ if(_visible) _drawCursor(t); });
  }

  /* 이 회로에서 오실로스코프가 의미 있는가 */
  function applicable(){
    var sr=App.State.solverResult; if(!sr||!sr.valid||!sr.wave) return false;
    var comps=App.State.components;
    var nl=comps.some(function(c){return NONLINEAR_TYPES[c.type];});
    return !!sr.acPhasor || nl;
  }
  function show(){ if(!_panel||!applicable()){ hide(); return; } _panel.classList.add('visible'); _visible=true; _draw(); }
  function hide(){ if(_panel) _panel.classList.remove('visible'); _visible=false; _snapshot=null; }
  function toggle(){ _visible?hide():show(); }

  function _traces(){
    var sr=App.State.solverResult, w=sr.wave, comps=App.State.components, out=[];
    var sel=App.State.selectedId?App.State.getComponent(App.State.selectedId):null;
    if(sel&&w.elem[sel.id]&&!NODE_TYPES[sel.type]){
      out.push({id:sel.id,kind:'v',color:COL_V,label:_name(sel)+' v(t)'});
      out.push({id:sel.id,kind:'i',color:COL_I,label:_name(sel)+' i(t)'});
      return out;
    }
    var src=comps.filter(function(c){return c.type===TYPE.AC_SOURCE||c.type===TYPE.DC_SOURCE;})[0];
    var load=comps.filter(function(c){return c.type===TYPE.RESISTOR||c.type===TYPE.BULB;})[0];
    if(src&&w.elem[src.id]) out.push({id:src.id,kind:'v',color:COL_V,label:'전원 v(t)'});
    if(load&&w.elem[load.id]) out.push({id:load.id,kind:'v',color:COL_V2,label:_name(load)+' v(t)'});
    if(load&&w.elem[load.id]) out.push({id:load.id,kind:'i',color:COL_I,label:_name(load)+' i(t)'});
    return out;
  }
  function _name(c){
    if(c.label&&c.label.trim()) return c.label.trim();
    var K={RESISTOR:'저항',BULB:'전구',CAPACITOR:'축전기',INDUCTOR:'인덕터',DIODE:'다이오드',NPN:'npn',PNP:'pnp',DC_SOURCE:'전원',AC_SOURCE:'전원',SWITCH:'스위치'};
    return K[c.type]||c.type;
  }
  function _fmt(v,unit){
    var a=Math.abs(v);
    if(a<1e-9) return '0'+unit;
    if(a<1e-3) return (v*1e6).toPrecision(3)+'µ'+unit;
    if(a<1) return (v*1e3).toPrecision(3)+'m'+unit;
    return v.toPrecision(3)+unit;
  }
  function _fmtT(t){
    if(t<1e-3) return (t*1e6).toFixed(0)+'µs';
    if(t<1) return (t*1e3).toFixed(1)+'ms';
    return t.toFixed(2)+'s';
  }
  function _nice(x){ if(x<=0) return 1; var e=Math.pow(10,Math.floor(Math.log10(x))); var m=x/e; var n=m<=1?1:m<=2?2:m<=5?5:10; return n*e; }

  function _draw(){
    if(!_cv||!_ctx) return;
    var sr=App.State.solverResult; if(!sr||!sr.wave){ hide(); return; }
    var w=sr.wave, traces=_traces();
    var dpr=window.devicePixelRatio||1, rect=_cv.getBoundingClientRect();
    if(rect.width<=0) return;
    var W=Math.round(rect.width), H=170;
    _cv.style.height=H+'px';
    if(_cv.width!==Math.round(W*dpr)||_cv.height!==Math.round(H*dpr)){ _cv.width=Math.round(W*dpr); _cv.height=Math.round(H*dpr); }
    var c=_ctx; c.setTransform(dpr,0,0,dpr,0,0);
    c.fillStyle='#ffffff'; c.fillRect(0,0,W,H);
    var PAD={l:46,r:54,t:10,b:22}, gW=W-PAD.l-PAD.r, gH=H-PAD.t-PAD.b;
    /* 시간 창: 교류면 정상상태 마지막 3주기만 (전체를 그리면 수십 주기가 뭉개진다) */
    var t0=0;
    if(sr.acPhasor&&sr.acPhasor.omega>0){ var P=2*Math.PI/sr.acPhasor.omega; t0=Math.max(0,w.tMax-3*P); }
    var span=w.tMax-t0; if(!(span>0)) span=w.tMax||1;
    var n0=0; while(n0<w.steps&&w.t[n0]<t0) n0++;
    _plot={x0:PAD.l,x1:PAD.l+gW,y0:PAD.t,y1:PAD.t+gH,t0:t0,span:span};
    /* 축 범위 */
    var vMax=0,iMax=0;
    traces.forEach(function(tr){ var a=w.elem[tr.id][tr.kind]; for(var k=n0;k<a.length;k++){ var m=Math.abs(a[k]); if(tr.kind==='v'){ if(m>vMax)vMax=m; } else if(m>iMax) iMax=m; } });
    vMax=_nice(vMax*1.05||1); iMax=_nice(iMax*1.05||1);
    /* 격자 */
    c.strokeStyle='#e5e7eb'; c.lineWidth=1;
    for(var g=0;g<=4;g++){ var y=PAD.t+gH*g/4; c.beginPath(); c.moveTo(PAD.l,y); c.lineTo(PAD.l+gW,y); c.stroke(); }
    for(var g2=0;g2<=5;g2++){ var x=PAD.l+gW*g2/5; c.beginPath(); c.moveTo(x,PAD.t); c.lineTo(x,PAD.t+gH); c.stroke(); }
    /* 0 선 */
    var yZero=PAD.t+gH/2;
    c.strokeStyle='#9ca3af'; c.beginPath(); c.moveTo(PAD.l,yZero); c.lineTo(PAD.l+gW,yZero); c.stroke();
    c.strokeStyle='#111318'; c.strokeRect(PAD.l+0.5,PAD.t+0.5,gW-1,gH-1);
    /* 눈금 글자 */
    c.font='10px '+(App.SN&&App.SN.TOKENS?App.SN.TOKENS.font:'serif'); c.fillStyle='#374151';
    c.textAlign='right'; c.textBaseline='middle';
    c.fillStyle=COL_V; c.fillText('+'+_fmt(vMax,'V'),PAD.l-4,PAD.t+4); c.fillText('−'+_fmt(vMax,'V'),PAD.l-4,PAD.t+gH-4); c.fillText('0',PAD.l-4,yZero);
    c.textAlign='left'; c.fillStyle=COL_I; c.fillText('+'+_fmt(iMax,'A'),PAD.l+gW+4,PAD.t+4); c.fillText('−'+_fmt(iMax,'A'),PAD.l+gW+4,PAD.t+gH-4);
    c.textAlign='center'; c.textBaseline='top'; c.fillStyle='#374151';
    for(var g3=0;g3<=5;g3++){ var tt=t0+span*g3/5; c.fillText(tt<=0?'0':_fmtT(tt),PAD.l+gW*g3/5,PAD.t+gH+4); }
    /* 파형 */
    traces.forEach(function(tr){
      var a=w.elem[tr.id][tr.kind], scale=(tr.kind==='v'?vMax:iMax);
      c.strokeStyle=tr.color; c.lineWidth=tr.kind==='v'?2:1.6; c.beginPath();
      var step=Math.max(1,Math.floor((a.length-n0)/(gW*2)));
      for(var k=n0;k<a.length;k+=step){
        var x=PAD.l+gW*((w.t[k]-t0)/span), y=yZero-(a[k]/scale)*(gH/2);
        if(k===n0) c.moveTo(x,y); else c.lineTo(x,y);
      }
      c.stroke();
    });
    _snapshot=c.getImageData(0,0,_cv.width,_cv.height);
    if(_cursorT!=null) _drawCursor(_cursorT);
    /* 범례 */
    if(_legend){
      _legend.innerHTML='';
      traces.forEach(function(tr){ var s=document.createElement('span'); s.style.color=tr.color; s.innerHTML='— <b>'+tr.label+'</b>'; _legend.appendChild(s); });
      var hint=document.createElement('span'); hint.textContent=App.State.selectedId?'':'소자를 클릭하면 그 소자의 v(t)·i(t)'; _legend.appendChild(hint);
    }
  }
  function _drawCursor(t){
    _cursorT=t;
    if(!_snapshot||!_plot||!_ctx) return;
    var sr=App.State.solverResult; if(!sr||!sr.wave) return;
    var dpr=window.devicePixelRatio||1;
    _ctx.setTransform(1,0,0,1,0,0); _ctx.putImageData(_snapshot,0,0); _ctx.setTransform(dpr,0,0,dpr,0,0);
    var x=_plot.x0+(_plot.x1-_plot.x0)*Math.max(0,Math.min(1,(t-_plot.t0)/_plot.span));
    _ctx.strokeStyle='rgba(180,83,9,0.95)'; _ctx.lineWidth=2; _ctx.setLineDash([4,3]);
    _ctx.beginPath(); _ctx.moveTo(x,_plot.y0); _ctx.lineTo(x,_plot.y1); _ctx.stroke(); _ctx.setLineDash([]);
  }

  return{init:init, show:show, hide:hide, toggle:toggle, applicable:applicable, redraw:_draw};
})();

}());
