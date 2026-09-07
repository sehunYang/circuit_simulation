(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Scope — 오실로스코프 패널 (엔진 시간 영역 파형 v(t)·i(t))
 *
 *   실행 모드에서 파형(solverResult.wave)이 있고 회로에 교류 또는 비선형
 *   소자가 있을 때 열린다 (선형 직류 과도는 과도 응답 그래프가 맡는다).
 *   그리는 것: 토글로 켠 소자들의 v(t)(실선, 왼쪽 축)·i(t)(점선, 오른쪽 축) — 소자마다 색.
 *
 *   표시 방향(_orient): 소자는 저마다 "ports[0]→ports[1] 로 흐르는 전류"를 + 로 쓴다.
 *   그래서 같은 직렬 회로인데도 소자를 돌려 놓거나 전원처럼 전류를 내보내는 소자는
 *   파형이 180° 뒤집혀 보인다 — 값은 맞지만 "직렬이면 전류가 같다"를 가르치는 화면에서는
 *   오해를 부른다. 그리기 전에 회로를 도는 방향(전원 + 단자에서 나가는 쪽)을 + 로 잡아
 *   소자마다 부호를 맞춘다. 수동 소자는 v·i 를 함께 뒤집으므로 P = vi 와 위상 관계가 보존되고
 *   (거꾸로 이은 소자는 반대 단자에서 본 것과 같다), 전원은 내보내는 전류만 뒤집는다.
 *   기본은 전원 + 첫 저항/전구, 캔버스에서 소자를 클릭하면 그 소자가 켜진다. v(t)/i(t) 전체 토글.
 *   시간 창 = 정상상태 마지막 PERIODS 주기이고 실행 모드가 같은 구간을 순환하므로
 *   커서(run:time)가 창 처음부터 끝까지 쓸고 간다.
 * ════════════════════════════════════════════════════════════════════ */
App.Scope=(function(){
  var _panel,_cv,_ctx,_legend,_toggles,_visible=false,_cursorT=null,_snapshot=null,_plot=null;
  var PERIODS=2;   /* 시간 창 = 정상상태 마지막 PERIODS 주기 (실행 렌더러의 재생 구간과 같다) */
  /* 소자별 색 — 같은 소자의 v(t) 는 실선, i(t) 는 점선 */
  var COL_V='#1d4ed8', COL_I='#b45309';   /* 축 눈금 색 (전압 왼쪽·전류 오른쪽) */
  var COLORS=['#1d4ed8','#b45309','#15803d','#a21caf','#0e7490','#b91c1c','#4d7c0f','#6d28d9'];
  var _active={}, _showV=true, _showI=true, _circuitKey='', _lastSel=null;

  function init(){
    _panel=document.getElementById('scope-panel');
    _cv=document.getElementById('scope-canvas');
    _legend=document.getElementById('scope-legend');
    _toggles=document.getElementById('scope-toggles');
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
    var sr=App.State.solverResult; if(!sr||!sr.valid) return false;
    if(sr.acPhasor) return true;                       /* 교류: 파형이 없어도 페이저로 합성해 그린다 */
    var nl=App.State.components.some(function(c){return NONLINEAR_TYPES[c.type];});
    return !!sr.wave && nl;
  }
  /* 소자의 시간 열 — 엔진 파형(있으면 창 구간)이거나, 선형 교류면 페이저 합성 v(t) = V_dc + Re[V·e^{jωt}] */
  var SYNTH_N=400;
  function _series(sr, id, kind, win){
    var w=sr.wave;
    if(w&&w.elem[id]) return {t:w.t, a:w.elem[id][kind], n0:win.n0, n1:w.t.length};
    var ph=sr.acPhasor; if(!ph) return null;
    var t=new Float32Array(SYNTH_N+1), a=new Float32Array(SYNTH_N+1);
    for(var k=0;k<=SYNTH_N;k++){ var tt=win.t0+win.span*k/SYNTH_N; t[k]=tt; a[k]=(kind==='v'?ph.instVoltage(id,tt):ph.instCurrent(id,tt)); }
    return {t:t, a:a, n0:0, n1:SYNTH_N+1};
  }
  function show(){ if(!_panel||!applicable()){ hide(); return; } _panel.classList.add('visible'); _visible=true; _draw(); }
  function hide(){ if(_panel) _panel.classList.remove('visible'); _visible=false; _snapshot=null; if(_toggles) _toggles.innerHTML=''; if(_legend) _legend.innerHTML=''; }
  function toggle(){ _visible?hide():show(); }

  /* 파형을 가진 소자 목록 (연결점·스위치 제외) — 토글 후보 */
  function _candidates(){
    var sr=App.State.solverResult, w=sr.wave, ph=sr.acPhasor;
    return App.State.components.filter(function(c){
      if(NODE_TYPES[c.type]||c.type===TYPE.SWITCH) return false;
      return w?!!w.elem[c.id]:!!(ph&&ph.compV&&ph.compV[c.id]);
    });
  }
  /* 켜진 소자 집합 관리: 회로가 바뀌면 기본값(전원 + 첫 저항/전구), 소자를 클릭하면 그 소자를 켠다 */
  function _syncActive(cands){
    var key=cands.map(function(c){return c.id;}).join(',');
    if(key!==_circuitKey){
      _circuitKey=key; _active={};
      var src=cands.filter(function(c){return c.type===TYPE.AC_SOURCE||c.type===TYPE.DC_SOURCE;})[0];
      var load=cands.filter(function(c){return c.type===TYPE.RESISTOR||c.type===TYPE.BULB;})[0];
      if(src) _active[src.id]=true; if(load) _active[load.id]=true;
      if(!src&&!load&&cands[0]) _active[cands[0].id]=true;
    }
    var sel=App.State.selectedId;
    if(sel&&sel!==_lastSel&&cands.some(function(c){return c.id===sel;})) _active[sel]=true;
    _lastSel=sel;
  }
  /* 회로를 도는 방향을 + 로 잡은 소자별 부호 { compId:{v,i} } */
  function _orient(sr){
    var sign={}, cn=sr.componentNodes||{}, comps=App.State.components;
    var src=comps.filter(function(c){return c.type===TYPE.AC_SOURCE||c.type===TYPE.DC_SOURCE;})[0];
    if(!src||!cn[src.id]) return sign;
    sign[src.id]={v:1,i:-1};                     /* 전원: 내보내는 전류를 + (전압은 단자 그대로) */
    var byNode={};
    comps.forEach(function(c){
      if(NODE_TYPES[c.type]||c.type===TYPE.SWITCH||c.id===src.id) return;
      var nn=cn[c.id]; if(!nn||nn.length!==2||nn[0]===nn[1]) return;
      (byNode[nn[0]]=byNode[nn[0]]||[]).push({c:c,port:0});
      (byNode[nn[1]]=byNode[nn[1]]||[]).push({c:c,port:1});
    });
    var seen={}, vis={}, q=[cn[src.id][0]];      /* 전원의 ports[0] 노드에서 출발 */
    vis[q[0]]=true;
    while(q.length){
      var n=q.shift();
      (byNode[n]||[]).forEach(function(e){
        if(seen[e.c.id]) return;
        seen[e.c.id]=true;
        var s=(e.port===0)?1:-1;                 /* 들어오는 쪽이 ports[1] 이면 거꾸로 이은 소자 */
        sign[e.c.id]={v:s,i:s};
        var other=cn[e.c.id][e.port===0?1:0];
        if(!vis[other]){ vis[other]=true; q.push(other); }
      });
    }
    return sign;
  }
  function _traces(){
    var sr=App.State.solverResult;
    var cands=_candidates(); _syncActive(cands); var out=[];
    var sign=_orient(sr);
    cands.forEach(function(c,i){
      if(!_active[c.id]) return;
      var col=COLORS[i%COLORS.length], sg=sign[c.id]||{v:1,i:1};
      if(_showV) out.push({id:c.id,kind:'v',color:col,sign:sg.v,label:_name(c)+' v(t)'});
      if(_showI) out.push({id:c.id,kind:'i',color:col,sign:sg.i,label:_name(c)+' i(t)',dash:[5,3]});
    });
    return out;
  }
  function _buildToggles(cands){
    if(!_toggles) return;
    _toggles.innerHTML='';
    cands.forEach(function(c,i){
      var col=COLORS[i%COLORS.length], b=document.createElement('button');
      b.className='tp-toggle'+(_active[c.id]?' active':''); b.textContent=_name(c);
      b.style.borderColor=col; b.style.color=col; b.style.background='#ffffff';
      b.title='이 소자의 파형 켜기/끄기';
      b.addEventListener('click',function(e){ e.stopPropagation(); _active[c.id]=!_active[c.id]; _draw(); });
      b.addEventListener('pointerdown',function(e){ e.stopPropagation(); });
      _toggles.appendChild(b);
    });
    [['v(t)','_showV'],['i(t)','_showI']].forEach(function(k,j){
      var on=(k[1]==='_showV')?_showV:_showI, b=document.createElement('button');
      b.className='tp-toggle'+(on?' active':'')+(j===0?' sc-kind':''); b.textContent=k[0];
      b.style.borderColor='#374151'; b.style.color='#374151'; b.style.background='#ffffff';
      b.title=(k[1]==='_showV'?'전압':'전류')+' 파형 전체 켜기/끄기';
      b.addEventListener('click',function(e){ e.stopPropagation(); if(k[1]==='_showV') _showV=!_showV; else _showI=!_showI; _draw(); });
      b.addEventListener('pointerdown',function(e){ e.stopPropagation(); });
      _toggles.appendChild(b);
    });
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
    var sr=App.State.solverResult; if(!sr||!applicable()){ hide(); return; }
    var w=sr.wave, traces=_traces();
    var dpr=window.devicePixelRatio||1, rect=_cv.getBoundingClientRect();
    if(rect.width<=0) return;
    var W=Math.round(rect.width), H=170;
    _cv.style.height=H+'px';
    if(_cv.width!==Math.round(W*dpr)||_cv.height!==Math.round(H*dpr)){ _cv.width=Math.round(W*dpr); _cv.height=Math.round(H*dpr); }
    var c=_ctx; c.setTransform(dpr,0,0,dpr,0,0);
    c.fillStyle='#ffffff'; c.fillRect(0,0,W,H);
    var PAD={l:46,r:54,t:10,b:22}, gW=W-PAD.l-PAD.r, gH=H-PAD.t-PAD.b;
    /* 시간 창: 교류면 정상상태 마지막 PERIODS 주기만 (전체를 그리면 수십 주기가 뭉개진다) — 실행 모드 재생 구간과 같다 */
    var t0=0, tEnd=w?w.tMax:0, n0=0;
    if(sr.acPhasor&&sr.acPhasor.omega>0){ var P=2*Math.PI/sr.acPhasor.omega; if(w) t0=Math.max(0,w.tMax-PERIODS*P); else { t0=0; tEnd=PERIODS*P; } }
    var span=tEnd-t0; if(!(span>0)) span=tEnd||1;
    if(w){ while(n0<w.steps&&w.t[n0]<t0) n0++; }
    _plot={x0:PAD.l,x1:PAD.l+gW,y0:PAD.t,y1:PAD.t+gH,t0:t0,span:span};
    var win={t0:t0,span:span,n0:n0};
    traces.forEach(function(tr){ tr.s=_series(sr,tr.id,tr.kind,win); });
    traces=traces.filter(function(tr){return !!tr.s;});
    /* 축 범위 — 그리는 채널만 (v 만 켜면 전류 축을, i 만 켜면 전압 축을 감춘다) */
    var hasV=traces.some(function(t){return t.kind==='v';});
    var hasI=traces.some(function(t){return t.kind==='i';});
    var vMax=0,iMax=0;
    traces.forEach(function(tr){ var a=tr.s.a; for(var k=tr.s.n0;k<tr.s.n1;k++){ var m=Math.abs(a[k]); if(tr.kind==='v'){ if(m>vMax)vMax=m; } else if(m>iMax) iMax=m; } });
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
    if(hasV){ c.fillStyle=COL_V; c.fillText('+'+_fmt(vMax,'V'),PAD.l-4,PAD.t+4); c.fillText('−'+_fmt(vMax,'V'),PAD.l-4,PAD.t+gH-4); }
    c.fillStyle='#374151'; c.fillText('0',PAD.l-4,yZero);
    if(hasI){ c.textAlign='left'; c.fillStyle=COL_I; c.fillText('+'+_fmt(iMax,'A'),PAD.l+gW+4,PAD.t+4); c.fillText('−'+_fmt(iMax,'A'),PAD.l+gW+4,PAD.t+gH-4); }
    c.textAlign='right';
    c.textAlign='center'; c.textBaseline='top'; c.fillStyle='#374151';
    for(var g3=0;g3<=5;g3++){ var tt=t0+span*g3/5; c.fillText(tt<=0?'0':_fmtT(tt),PAD.l+gW*g3/5,PAD.t+gH+4); }
    /* 파형 */
    traces.forEach(function(tr){
      var a=tr.s.a, ta=tr.s.t, k0=tr.s.n0, k1=tr.s.n1, scale=(tr.kind==='v'?vMax:iMax);
      c.strokeStyle=tr.color; c.lineWidth=tr.kind==='v'?2:1.6; c.setLineDash(tr.dash||[]); c.beginPath();
      var step=Math.max(1,Math.floor((k1-k0)/(gW*2))), sg=(tr.sign==null?1:tr.sign);
      for(var k=k0;k<k1;k+=step){
        var x=PAD.l+gW*((ta[k]-t0)/span), y=yZero-(sg*a[k]/scale)*(gH/2);
        if(k===k0) c.moveTo(x,y); else c.lineTo(x,y);
      }
      c.stroke();
    });
    c.setLineDash([]);
    _snapshot=c.getImageData(0,0,_cv.width,_cv.height);
    if(_cursorT!=null) _drawCursor(_cursorT);
    /* 토글 · 범례 */
    _buildToggles(_candidates());
    if(_legend){
      _legend.innerHTML='';
      traces.forEach(function(tr){ var s=document.createElement('span'); s.style.color=tr.color; s.innerHTML=(tr.kind==='v'?'— ':'┅ ')+'<b>'+tr.label+'</b>'; _legend.appendChild(s); });
      var msg='';
      if(!traces.length) msg='위 버튼으로 소자를 켜세요';
      else if(hasI) msg='전류는 회로를 도는 방향(전원에서 나가는 쪽)을 + 로 그립니다'+(_coincide(traces,w)?' — 직렬로 이은 소자라 전류가 모두 같습니다':'');
      if(msg){ var hint=document.createElement('span'); hint.className='sc-note'; hint.textContent=msg; _legend.appendChild(hint); }
    }
  }
  /* 켠 전류 파형들이 사실상 같은 곡선인가 (직렬) */
  function _coincide(traces,w){
    var cur=traces.filter(function(t){return t.kind==='i'&&t.s;});
    if(cur.length<2) return false;
    var ref=cur[0], peak=0, k;
    for(k=ref.s.n0;k<ref.s.n1;k++) peak=Math.max(peak,Math.abs(ref.s.a[k]));
    if(!(peak>0)) return false;
    for(var j=1;j<cur.length;j++){
      var t=cur[j]; if(t.s.n1-t.s.n0!==ref.s.n1-ref.s.n0) return false;
      for(k=0;k<ref.s.n1-ref.s.n0;k+=3){
        var d=Math.abs((ref.sign||1)*ref.s.a[ref.s.n0+k]-(t.sign||1)*t.s.a[t.s.n0+k]);
        if(d>peak*0.02) return false;
      }
    }
    return true;
  }

  function _drawCursor(t){
    _cursorT=t;
    if(!_snapshot||!_plot||!_ctx) return;
    var sr=App.State.solverResult; if(!sr||!sr.valid) return;
    var dpr=window.devicePixelRatio||1;
    _ctx.setTransform(1,0,0,1,0,0); _ctx.putImageData(_snapshot,0,0); _ctx.setTransform(dpr,0,0,dpr,0,0);
    var x=_plot.x0+(_plot.x1-_plot.x0)*Math.max(0,Math.min(1,(t-_plot.t0)/_plot.span));
    _ctx.strokeStyle='rgba(180,83,9,0.95)'; _ctx.lineWidth=2; _ctx.setLineDash([4,3]);
    _ctx.beginPath(); _ctx.moveTo(x,_plot.y0); _ctx.lineTo(x,_plot.y1); _ctx.stroke(); _ctx.setLineDash([]);
  }

  return{init:init, show:show, hide:hide, toggle:toggle, applicable:applicable, redraw:_draw, PERIODS:PERIODS,
         /* 표시 방향 부호 { compId:{v,i} } — 테스트·점검용 */
         orientation:function(){ return _orient(App.State.solverResult); },
         setActive:function(id,on){ _active[id]=!!on; if(_visible) _draw(); }};
})();

}());
