(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.RunRenderer — 실행 모드 전자 이동 애니메이션 (canvas-anim)
 *
 *   도선마다 파티클 풀을 만들어 전류 크기에 비례한 속도/밀도로 이동.
 *   전류 방향의 반대로 전자가 흐른다(electronDir = -convDir).
 *   DC: 정적 속도. AC: 매 프레임 순시전류로 속도·방향 갱신.
 *
 *   속도는 px/s 단위 → 도선 길이로 나눠 t/s(정규화 매개변수 속도)로 변환.
 *   따라서 도선 길이와 무관하게 일정한 시각적 속도를 유지.
 * ════════════════════════════════════════════════════════════════════ */
App.RunRenderer=(function(){

  /* ── 시각화 튜닝 상수 ── */
  var ELECTRON_DENSITY_SCALE = 8;    // 전류 크기 → 파티클 수 배율
  var ELECTRON_SPEED_SCALE   = 0.6;  // (예약)
  var ELECTRON_SPEED_MIN     = 8;    // 최소 속도 (px/s)
  var ELECTRON_SPEED_MAX     = 120;  // 최대 속도 (px/s)
  var ELECTRON_RADIUS        = 3;    // 전자 반지름 (px)
  var ARROW_SIZE             = 9;    // 전류 방향 화살표 크기
  var MAX_PARTICLES          = 50;   // 도선당 최대 파티클 수

  var _cv, _ctx;
  var _rafId = null;
  var _lastTs = 0;
  var _t = 0;   /* 물리 시간 누산 (초) — AC 순시값 계산용 */

  /* 도선별 파티클 풀 { wireId → {wireId, I, particles:[{t,speed,tail,dir,visible}]} } */
  var _pools = {};

  /* ── 공통 헬퍼 ────────────────────────────────────────────────────
   * 도선 전류 크기: wireCurrents 우선, 없으면 양단 부품 branchCurrent 폴백 */
  function _wireCurrentMag(wire, sr, wc){
    var I = wc[wire.id];
    if(I==null){
      var Ib = sr.branchCurrents[wire.fromId];
      if(Ib==null) Ib = sr.branchCurrents[wire.toId];
      I = Ib!=null ? Math.abs(Ib) : 0;
    }
    return I;
  }
  /* 도선의 L-bend 경로 + 총 길이 반환 (없으면 null) */
  function _wirePathInfo(wire){
    var from = App.State.getComponent(wire.fromId);
    var to   = App.State.getComponent(wire.toId);
    if(!from||!to) return null;
    var p1   = App.Geo.getPortPixel(from, wire.fromPort);
    var p2   = App.Geo.getPortPixel(to,   wire.toPort);
    var path = App.Geo.calcWirePath(p1.x,p1.y,p2.x,p2.y,wire.direction);
    var s1 = Math.hypot(path[1].x-path[0].x, path[1].y-path[0].y);
    var s2 = Math.hypot(path[2].x-path[1].x, path[2].y-path[1].y);
    return{path:path, len:Math.max(1, s1+s2)};
  }

  /* ── AC 모드: 매 프레임 순시 전류로 파티클 속도/방향 갱신 ──────────
   * i(t) = Re[I_phasor · e^(jωt)]
   *       = I_re·cos(ωt) - I_im·sin(ωt)
   *
   * 부호 규약: 양수 = fromPort→toPort 방향 (wireSignedI 와 동일)
   * ─────────────────────────────────────────────────────────────── */
  function _updatePoolsAC(t, sr){
    var phasor = sr.acPhasor;
    var omega  = phasor.omega;
    var jT     = {JUNCTION_3:1, JUNCTION_4:1};
    var ct = Math.cos(omega*t), st = Math.sin(omega*t);

    /* AC 순시 전류 계산 — 먼저 최대값 파악 */
    var wireInstI = {};  /* wire.id → 순시 전류 */
    var maxAbsI = 1e-15;

    App.State.wires.forEach(function(wire){
      var pool = _pools[wire.id]; if(!pool) return;
      var from = App.State.getComponent(wire.fromId);
      var to   = App.State.getComponent(wire.toId);
      if(!from||!to) return;
      var instI = 0;
      function getInstFromComp(comp, portId, isFrom){
        if(!comp||jT[comp.type]) return false;
        var p = phasor.compI[comp.id]; if(!p) return false;
        var raw = p.re*ct - p.im*st;
        var ports = App.Geo.getCompPorts(comp);
        var idx   = ports.indexOf(portId);
        instI = isFrom ? (idx===0?-1:1)*raw : (idx===0?1:-1)*raw;
        return true;
      }
      if(!getInstFromComp(from, wire.fromPort, true))
          getInstFromComp(to,   wire.toPort,   false);
      wireInstI[wire.id] = instI;
      if(Math.abs(instI) > maxAbsI) maxAbsI = Math.abs(instI);
    });

    App.State.wires.forEach(function(wire){
      var pool = _pools[wire.id]; if(!pool) return;
      var instI = wireInstI[wire.id] || 0;
      var absI  = Math.abs(instI);
      var newDir = instI >= 0 ? 1 : -1;

      /* 속도: 전류 비율 기반 */
      var ratio = maxAbsI > 1e-15 ? absI / maxAbsI : 0;
      var newSpd = absI > 1e-12
        ? ELECTRON_SPEED_MIN + ratio * (ELECTRON_SPEED_MAX - ELECTRON_SPEED_MIN)
        : 0;

      pool.particles.forEach(function(p){
        if(p.dir !== newDir){
          p.tail = null; p.visible = false; p.dir = newDir;
        }
        p.speed = newSpd;
      });

      var target = Math.max(1, Math.min(MAX_PARTICLES, Math.round(absI * ELECTRON_DENSITY_SCALE)));
      while(pool.particles.length < target){
        pool.particles.push({t:Math.random(), speed:newSpd, tail:null, dir:newDir, visible:true});
      }
      if(pool.particles.length > target) pool.particles.length = target;
    });
  }

  /* ── 파티클 풀 초기화 ── */
  function _initPools(){
    var sr = App.State.solverResult;
    _pools = {};
    if(!sr||!sr.valid) return;

    var wc = sr.wireCurrents || {};

    /* ── 전류 범위 파악: 정규화 기준(maxI) 계산 ──
     * 속도는 전류 크기에 비례. 모든 도선 중 최대 전류로 정규화하면
     * 회로 내 상대적 전류 크기가 속도에 정확히 반영된다.
     * (예: R=L 같은 전류 → 같은 속도 보장) */
    var maxI = 1e-15;
    App.State.wires.forEach(function(wire){
      var I = _wireCurrentMag(wire, sr, wc);
      if(I > maxI) maxI = I;
    });

    App.State.wires.forEach(function(wire){
      var I = _wireCurrentMag(wire, sr, wc);
      if(Math.abs(I)<1e-15) return;

      /* ── 속도: 전류 크기에 비례 (전위차 기반 아님) ──────────────
       * 과거 dV 기반은 L 도선(dV≈0)이 느려지는 버그가 있었음.
       * ratio = I/maxI → speed = MIN + ratio×(MAX-MIN)
       * 같은 전류 = 같은 속도 (KCL 구간 시각적 일치) */
      var ratio = maxI > 1e-15 ? Math.abs(I) / maxI : 0;
      var speed = ELECTRON_SPEED_MIN + ratio * (ELECTRON_SPEED_MAX - ELECTRON_SPEED_MIN);

      /* 전류 방향 → 전자 방향 = 반대 */
      var electronDir = -App.Geo.wireConvDir(wire, sr);

      var count = Math.min(MAX_PARTICLES, Math.max(1, Math.round(Math.abs(I) * ELECTRON_DENSITY_SCALE)));

      var particles = [];
      for(var i=0;i<count;i++){
        particles.push({
          t:       i / count,
          speed:   speed * (0.9 + Math.random() * 0.2),
          tail:    null,
          dir:     electronDir,
          visible: true,
        });
      }
      _pools[wire.id] = { wireId:wire.id, I:I, particles:particles };
    });
  }

  /* ── 경로 보간: 도선 path 위에서 t(0~1) 위치의 픽셀 좌표 ── */
  function _getPathPoint(path, t){
    /* path = [{x,y},{x,y},{x,y}] (L-bend 3점) */
    var seg1 = Math.hypot(path[1].x-path[0].x, path[1].y-path[0].y);
    var seg2 = Math.hypot(path[2].x-path[1].x, path[2].y-path[1].y);
    var total = seg1+seg2;
    if(total<1) return{x:path[0].x, y:path[0].y};
    var d = t*total;
    if(d<=seg1){
      var r=seg1>0?d/seg1:0;
      return{x:path[0].x+(path[1].x-path[0].x)*r, y:path[0].y+(path[1].y-path[0].y)*r};
    } else {
      var r2=seg2>0?(d-seg1)/seg2:0;
      return{x:path[1].x+(path[2].x-path[1].x)*r2, y:path[1].y+(path[2].y-path[1].y)*r2};
    }
  }

  /* ── 파티클 이동 업데이트 ── */
  function _updateParticles(dt){
    Object.keys(_pools).forEach(function(wid){
      var pool = _pools[wid];
      var wire = App.State.getWire(wid);
      if(!wire) return;

      var info = _wirePathInfo(wire);
      var pathLen = info ? info.len : 1;

      pool.particles.forEach(function(p){
        var prev = p.t;
        var next = prev + p.dir * (p.speed / pathLen) * dt;

        var wrapped = (next < 0 || next >= 1);
        if(wrapped){
          p.t    = ((next % 1) + 1) % 1;
          p.tail = null;
          p.visible = false;
        } else {
          p.tail    = prev;
          p.t       = next;
          p.visible = true;
        }
      });
    });
  }

  /* ── 파티클 렌더링 ── */
  function _drawParticles(){
    var W = _cv.width, H = _cv.height;

    Object.keys(_pools).forEach(function(wid){
      var pool = _pools[wid];
      var wire = App.State.getWire(wid);
      if(!wire) return;
      var info = _wirePathInfo(wire);
      if(!info) return;
      var path = info.path;

      pool.particles.forEach(function(p){
        /* wrap 직후 프레임: 본체·꼬리 모두 숨김 */
        if(p.visible === false){
          p.visible = true;   // 다음 프레임부터 보임
          return;
        }

        var pos  = _getPathPoint(path, p.t);
        if(pos.x<-10||pos.x>W+10||pos.y<-10||pos.y>H+10) return;

        /* 꼬리: tail이 null이면(방금 wrap) 그리지 않음.
         * 수능 지면 규격 — 색이 아니라 농도(회색)로만 잔상을 표현한다. */
        if(p.tail != null){
          var tail = _getPathPoint(path, p.tail);
          _ctx.save();
          _ctx.beginPath();
          _ctx.moveTo(tail.x, tail.y);
          _ctx.lineTo(pos.x,  pos.y);
          _ctx.strokeStyle = 'rgba(0,0,0,0.16)';
          _ctx.lineWidth   = ELECTRON_RADIUS*1.4;
          _ctx.lineCap     = 'round';
          _ctx.stroke();
          _ctx.restore();
        }

        /* 전자 본체 — 검정 원 + 흰 테두리.
         * 검정 도선 위를 지나므로 흰 테두리가 있어야 알갱이로 읽힌다. */
        _ctx.save();
        _ctx.beginPath();
        _ctx.arc(pos.x, pos.y, ELECTRON_RADIUS, 0, Math.PI*2);
        _ctx.strokeStyle = App.SN.TOKENS.paper;
        _ctx.lineWidth   = 2;
        _ctx.stroke();
        _ctx.fillStyle = App.SN.TOKENS.ink;
        _ctx.fill();
        _ctx.restore();
      });
    });
  }

  /* ── 전류 방향 화살표 ── */
  function _drawCurrentArrows(){
    var sr = App.State.solverResult;
    if(!sr||!sr.valid) return;
    /* 토글 off이거나 AC 회로면 화살표 표시 안 함 */
    if(!App.State.showArrows) return;
    if(sr.acPhasor) return;

    /* from 부품의 내부 노드 전위 차로 도선 전류 방향 결정 (+1: t=0→1, -1: t=1→0) */
    App.State.wires.forEach(function(wire){
      var I = sr.branchCurrents[wire.fromId]||sr.branchCurrents[wire.toId]||0;
      if(Math.abs(I)<1e-12) return;

      var info = _wirePathInfo(wire);
      if(!info) return;
      var path = info.path;
      var convDir = App.Geo.wireConvDir(wire, sr);

      for(var k=0;k<path.length-1;k++){
        var sx=path[k].x, sy=path[k].y, ex=path[k+1].x, ey=path[k+1].y;
        if(Math.hypot(ex-sx,ey-sy)<16) continue;
        var mx=(sx+ex)/2, my=(sy+ey)/2;
        var ang=Math.atan2(ey-sy, ex-sx);
        if(convDir < 0) ang += Math.PI;

        /* 수능 규격 화살표: 속 찬 검정 삼각 화살촉 (+ 흰 테두리로 띄움) */
        _ctx.save();
        _ctx.translate(mx,my); _ctx.rotate(ang);
        _ctx.beginPath();
        _ctx.moveTo(ARROW_SIZE, 0);
        _ctx.lineTo(-ARROW_SIZE*0.55, -ARROW_SIZE*0.5);
        _ctx.lineTo(-ARROW_SIZE*0.55,  ARROW_SIZE*0.5);
        _ctx.closePath();
        _ctx.strokeStyle=App.SN.TOKENS.paper; _ctx.lineWidth=2.4; _ctx.lineJoin='round';
        _ctx.stroke();
        _ctx.fillStyle=App.SN.TOKENS.ink;
        _ctx.fill();
        _ctx.restore();
      }
    });
  }

  /* ── 회로 미완성 오버레이 ── */
  function _drawIncompleteOverlay(){
    var W=_cv.width, H=_cv.height;
    _ctx.save();
    /* 지면 위 안내 — 흰 바탕을 가리지 않고 살짝 흐리게만 덮는다 */
    _ctx.fillStyle='rgba(255,255,255,0.72)';
    _ctx.fillRect(0,0,W,H);
    var msg = App.State.solverResult&&App.State.solverResult.error
      ? '⚠ '+App.State.solverResult.error
      : '회로가 완성되지 않았습니다';
    var fs=16;
    _ctx.font=fs+'px '+App.SN.TOKENS.fontKo;
    var tw=_ctx.measureText(msg).width+32;
    var bx=W/2, by=H/2;
    _ctx.fillStyle='rgba(255,255,255,0.97)';
    _ctx.strokeStyle='#c9ced6';
    _ctx.lineWidth=1;
    _ctx.beginPath();
    if(_ctx.roundRect) _ctx.roundRect(bx-tw/2,by-21,tw,42,8);
    else _ctx.rect(bx-tw/2,by-21,tw,42);
    _ctx.fill(); _ctx.stroke();
    _ctx.restore();
    App.SN.label(_ctx,msg,bx,by,fs,{ko:true});
  }

  /* ── 메인 애니메이션 루프 ── */
  function _runLoop(ts){
    if(App.State.mode!=='run'){ _rafId=null; return; }
    var dt = Math.min((ts - (_lastTs||ts))/1000, 0.05);
    _lastTs = ts;

    /* ── AC 시각화 시간 스케일링 ─────────────────────────────────
     * 목표: 모든 주파수에서 방향 전환이 관찰되되, 주파수 차이도 보임.
     *
     * 로그 스케일 공식:
     *   visFreq = VIS_BASE × (realFreq / VIS_BASE)^VIS_EXP
     *
     *   VIS_BASE = 1Hz  (기준: 1Hz는 그대로)
     *   VIS_EXP  = 0.25 (로그 압축 지수)
     *
     * 예시:
     *   1Hz   → visFreq = 1.0Hz  (주기 1000ms)
     *   10Hz  → visFreq = 1.8Hz  (주기  560ms)
     *   60Hz  → visFreq = 2.8Hz  (주기  360ms)
     *   1kHz  → visFreq = 5.6Hz  (주기  180ms)
     *
     * → 고주파일수록 더 빠르게 방향 전환, 하지만 모두 관찰 가능.
     * ─────────────────────────────────────────────────────────── */
    var sr = App.State.solverResult;
    var VIS_BASE = 1.0;   /* 기준 주파수: 1Hz는 원래 속도 유지 */
    var VIS_EXP  = 0.25;  /* 지수: 0=모두 동일, 1=원래 주파수 그대로 */
    if(sr && sr.acPhasor){
      var realFreq = sr.acPhasor.omega / (2 * Math.PI);
      var visFreq  = VIS_BASE * Math.pow(realFreq / VIS_BASE, VIS_EXP);
      var scale    = visFreq / realFreq;
      _t += dt * scale;
    } else {
      _t += dt;  /* DC: 실시간 누산 */
    }

    _ctx.clearRect(0,0,_cv.width,_cv.height);

    if(sr&&sr.valid){
      /* AC 모드: 스케일된 _t로 순시 전류 계산 */
      if(sr.acPhasor) _updatePoolsAC(_t, sr);
      _updateParticles(dt);
      _drawParticles();
      _drawCurrentArrows();
    } else {
      _drawIncompleteOverlay();
    }

    _rafId = requestAnimationFrame(_runLoop);
  }

  /* ── 공개 API ── */
  function start(){
    if(_rafId) return;
    _cv  = document.getElementById('canvas-anim');
    _ctx = _cv.getContext('2d');
    _lastTs = 0;
    _t = 0;  /* 물리 시간 초기화 */
    _initPools();
    App.Events.on('solver:done', _initPools);
    _rafId = requestAnimationFrame(_runLoop);
  }

  function stop(){
    if(_rafId!==null){ cancelAnimationFrame(_rafId); _rafId=null; }
    App.Events.off('solver:done', _initPools);
    if(_cv&&_ctx) _ctx.clearRect(0,0,_cv.width,_cv.height);
  }

  return{start:start, stop:stop};
})();

}());
