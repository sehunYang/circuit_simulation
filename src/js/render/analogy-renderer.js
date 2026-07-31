(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.AnalogyRenderer — 수로 비유 모드 (Three.js + Cannon-es 물리 엔진)
 *
 *   ▣ 설계 개요 (AI Agent Guide 기반)
 *     · 전압(V)  → 수로의 '높이(Head)'          : 노드 전위를 Y축 높이로 매핑
 *     · 전류(I)  → 물의 '유속'                    : 물 입자 이동 속도 ∝ |전류|
 *     · DC 전원  → 수직 양수 펌프(임펠러 회전)     : 낮은 포트→높은 포트로 물을 들어올림
 *     · 도선     → 매끄러운 경사 수로(Flume)       : 양 끝 전위 동일 → 거의 수평
 *     · 저항     → 일 수행 물레방아(Waterwheel)    : 낙차 통과, R↑ → 뻑뻑·느림·큰 낙차
 *     · 분기점   → 갈림길 베이슨(Junction Basin)   : KCL은 솔버 전류로 자동 충족
 *     · 축전기   → 수문 댐(Dam/Floodgate)          : 충전(차오름)→DC 차단(유속0)
 *     · 인덕터   → 소용돌이 나선 수로(Vortex)       : 가동 시 유속 서서히 증가(역기전력)
 *
 *   ▣ 렌더링: Three.js 로 2.5D 측면 뷰(약간 위·옆에서 본 각도)를 구성.
 *             전위가 높을수록 물리적으로 높은 위치에 배치되어 물이 아래로 흐른다.
 *   ▣ 물리:  회전체(물레방아·펌프 임펠러)는 Cannon-es 강체의 각운동(관성+감쇠)
 *             으로 구동. 감쇠계수는 저항값 R에 비례(=뻑뻑함). Cannon 미로딩 시
 *             동일한 1자유도 적분식으로 자동 폴백한다.
 *   ▣ 흐름:  비유 모드 진입 시 '정지된 초기 상태'. [시뮬레이션 시작] 버튼을 눌러야
 *             물 입자·회전체가 1차 과도응답(인덕터 상승/축전기 차단)과 함께 작동.
 *
 *   AC 회로는 모드 진입 전(Main)에서 차단된다.
 * ════════════════════════════════════════════════════════════════════ */
App.AnalogyRenderer=(function(){

  /* ── 월드 스케일 상수 ── */
  var SP          = 3.2;    // 그리드 1칸 → 월드 거리
  var H_RANGE     = 6.5;    // 전위차 최대 → 월드 높이 범위
  var FLOW_SPEED  = 2.6;    // 최대 전류에서 물 입자 속도 (월드/초)
  var CH_W        = 0.55;   // 수로 폭
  var WHEEL_OMEGA_MAX = 5.0; // 물레방아 최대 각속도 (rad/s) — 전력 비례, 상한
  var PUMP_OMEGA_MAX  = 6.0; // 펌프 임펠러 최대 각속도 (rad/s)
  var PARTICLE_SPACING= 1.1; // 전자(입자) 균등 간격 (월드 거리) — 모든 도선 공통
  var I_REF_SPEED     = 0;   // 전류→속력 정규화 기준 (start에서 _maxI로 설정)

  /* ── 색상 ──
   *   물·수로는 파란색 유지(물의 정체성). 소자 본체는 종류별 고유색으로 구분.
   *   저항=주황(열 소비), 전원=초록(에너지원), 인덕터=보라(자기), 축전기=갈색(저수), 분기=회색 */
  var COL_WATER   = 0x3aa0ff;   // 물 (파랑, 유지)
  var COL_CHANNEL = 0x16335c;   // 수로 (진한 파랑, 유지)
  var COL_WHEEL   = 0xe08850;   // 저항 물레방아 (주황/적갈)
  var COL_PUMP    = 0x4cc266;   // 전원 펌프 (초록)
  var COL_DAM     = 0xc79a55;   // 축전기 댐 (갈색 톤업)
  var COL_VORTEX  = 0x9b6fd0;   // 인덕터 코일 (보라)
  var COL_NODE    = 0x8a9bb0;   // 분기점 (중립 회색)

  /* ── Three / Cannon 핸들 ── */
  var _renderer, _scene, _camera, _cv, _container;
  var _world=null;            // Cannon world (없으면 폴백)
  var _haveCannon=false;

  /* ── 런타임 상태 ── */
  var _raf=null, _playing=false, _simTime=0, _lastTs=0, _built=false;
  var _lanes=[], _wheels=[], _dynamics=[], _particlePool=[];
  var _maxI=1e-6, _vMin=0, _vMax=1;
  var _cxGrid=0, _czGrid=0;
  var _cam={az:-0.62, el:0.52, dist:26, tx:0, ty:1.4, tz:0};
  var _orbit=null, _resizeFn=null;
  var _sharedGeo=null, _hintEl=null;
  var _labelSprites=[];        // 소자 이름·값 라벨 (카메라 빌보드)
  var _wireLabels=[];          // 도선 전류 I(t) 동적 라벨
  var _labelsVisible=true;     // 라벨(특성값·전류·전위) 표시 여부 (#5 토글)

  /* ── 과도응답(시상수) 데이터 ──
   *   _transData.byId[compId] = {amp, tau, isRising}  (TransientGraph 계산값)
   *   _domTau: 지배 시상수(s). 시간 스케일 결정에 사용.
   *   _simSpeed: 물리시간 t(초) = _simTime(벽시계초) * _simSpeed.
   *     동적 소자가 있으면 5·τ 구간을 약 SHOW_SPAN초에 보여주도록 가속/감속한다. */
  var _transData=null, _domTau=0, _simSpeed=1;
  var _branchModel=null;       // {byComp, byWire, domTau} — 전 가지 i(t) 모델
  var SHOW_SPAN=30.0;          // 5τ 과도구간을 보여줄 화면상 시간(초)
  var _staticBase=0.55;        // 동적 소자 없을 때 기본 흐름 가동 시정수(s)

  /* ════════ 유틸 ════════ */
  function _clamp(v,a,b){return v<a?a:(v>b?b:v);}
  function _lerp(a,b,t){return a+(b-a)*t;}

  function _vToY(v){
    var range=_vMax-_vMin;
    if(range<1e-6) return H_RANGE*0.45;
    return ((v-_vMin)/range)*H_RANGE + 0.25;
  }
  /* 포트의 정상상태(또는 솔버) 전위 — 씬 정규화·폴백용 */
  function _portV(comp,portId){
    var sr=App.State.solverResult;
    if(sr&&sr.portVoltages&&sr.portVoltages[comp.id]&&sr.portVoltages[comp.id][portId]!=null)
      return sr.portVoltages[comp.id][portId];
    return 0;
  }
  /* 포트가 속한 노드 ID (componentNodes 의 포트 순서 매핑) */
  function _portNode(comp,portId){
    var bm=_branchModel;
    if(!bm||!bm.compNodes||!bm.compNodes[comp.id]) return null;
    var ports=App.Geo.getCompPorts(comp);
    var idx=ports.indexOf(portId);
    if(idx<0) idx=0;
    var nodes=bm.compNodes[comp.id];
    return (idx<nodes.length)?nodes[idx]:nodes[0];
  }
  /* 포트의 시변 전위 v(t) (#3) — 노드 모델이 있으면 시간 함수, 없으면 정상상태 */
  function _portVt(comp,portId,t){
    var bm=_branchModel;
    if(bm&&bm.byNode){
      var nd=_portNode(comp,portId);
      if(nd!=null && bm.byNode[nd]){
        var m=bm.byNode[nd];
        if(t<=0) return m.v0;
        return m.vinf+(m.v0-m.vinf)*Math.exp(-t/Math.max(m.tau,1e-12));
      }
    }
    return _portV(comp,portId);   // 폴백: 정상상태
  }
  function _portPos(comp,portId){
    var g=App.Geo.getPortGridPos(comp,portId);   // {x,y} 그리드 좌표
    return new THREE.Vector3((g.x-_cxGrid)*SP, _vToY(_portV(comp,portId)), (g.y-_czGrid)*SP);
  }
  /* 임의 그리드 좌표(gx,gy)와 높이 y → 월드 좌표 (도선 꺾임점용) */
  function _grid3D(gx,gy,y){
    return new THREE.Vector3((gx-_cxGrid)*SP, y, (gy-_czGrid)*SP);
  }
  /* 채널(수로) 한 구간: 두 점이 충분히 떨어졌을 때만 관을 추가. 메쉬 반환. */
  function _channelSeg(p,q){
    if(p.distanceTo(q)>0.02){ var m=_tubeBetween(p,q,CH_W*0.5,COL_CHANNEL,0.45); _scene.add(m); return m; }
    return null;
  }
  /* 두 점 사이 튜브의 position·회전·길이를 갱신 (시변 높이 대응) */
  function _updateTube(mesh,a,b,radius){
    if(!mesh) return;
    var dir=new THREE.Vector3().subVectors(b,a);
    var len=dir.length(); if(len<1e-4) len=1e-4;
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    var up=new THREE.Vector3(0,1,0);
    var nd=dir.clone().normalize();
    var axis=new THREE.Vector3().crossVectors(up,nd);
    var ang=Math.acos(_clamp(up.dot(nd),-1,1));
    if(axis.length()>1e-6) mesh.quaternion.setFromAxisAngle(axis.normalize(),ang);
    else mesh.quaternion.set(0,0,0,1);
    mesh.scale.y=len/(mesh._baseLen||len);   // 원래 길이 대비 스케일
  }
  function _compCenter(comp){
    var ports=App.Geo.getCompPorts(comp);
    var acc=new THREE.Vector3();
    ports.forEach(function(p){acc.add(_portPos(comp,p));});
    return acc.multiplyScalar(1/Math.max(1,ports.length));
  }

  /* ── 외형 가시성 보조 헬퍼 ── */
  /* 소자 발밑 원형 받침대 (바닥에서 위치·종류 식별) */
  function _addBaseDisk(center, radius, color){
    var disk=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius*1.08,0.18,24),
             new THREE.MeshStandardMaterial({color:color,roughness:0.7,metalness:0.15,
               emissive:color,emissiveIntensity:0.18}));
    disk.position.set(center.x, -0.5, center.z);   // 지면 근처
    _scene.add(disk);
    /* 받침대에서 소자까지 가는 흐릿한 기둥 (연결감) */
    var pole=new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.06,Math.max(0.2,center.y+0.5),8),
             new THREE.MeshStandardMaterial({color:color,transparent:true,opacity:0.25,roughness:0.8}));
    pole.position.set(center.x, (center.y-0.5)/2, center.z);
    _scene.add(pole);
    return disk;
  }
  /* 위로 향하는 화살표 (펌프 양수 방향 등) — 콘 + 원기둥 */
  function _addArrow(pos, height, color){
    var grp=new THREE.Group();
    var shaft=new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.07,height*0.6,8),
              new THREE.MeshStandardMaterial({color:color,emissive:color,emissiveIntensity:0.4,roughness:0.4}));
    shaft.position.y=height*0.3; grp.add(shaft);
    var headCone=new THREE.Mesh(new THREE.ConeGeometry(0.18,height*0.35,10),
              new THREE.MeshStandardMaterial({color:color,emissive:color,emissiveIntensity:0.4,roughness:0.4}));
    headCone.position.y=height*0.78; grp.add(headCone);
    grp.position.copy(pos);
    _scene.add(grp);
    return grp;
  }

  /* 두 점 사이에 실린더(수로/관)를 배치 */
  function _tubeBetween(a,b,radius,color,opacity){
    var dir=new THREE.Vector3().subVectors(b,a);
    var len=dir.length();
    if(len<1e-4) len=1e-4;
    var geo=new THREE.CylinderGeometry(radius,radius,len,12,1,true);
    var mat=new THREE.MeshStandardMaterial({color:color,transparent:opacity<1,opacity:opacity,
            roughness:0.55,metalness:0.1,side:THREE.DoubleSide});
    var m=new THREE.Mesh(geo,mat);
    m._baseLen=len;
    m.position.copy(a).add(b).multiplyScalar(0.5);
    var up=new THREE.Vector3(0,1,0);
    var axis=new THREE.Vector3().crossVectors(up,dir.clone().normalize());
    var ang=Math.acos(_clamp(up.dot(dir.clone().normalize()),-1,1));
    if(axis.length()>1e-6) m.quaternion.setFromAxisAngle(axis.normalize(),ang);
    return m;
  }

  /* ════════ 회전체 동역학 (Cannon 강체 또는 폴백) ════════ */
  function _makeRotor(pos,radius,inertiaScale){
    var rotor={angle:0, omega:0, body:null, inertia:Math.max(0.05,inertiaScale)};
    if(_haveCannon&&_world){
      var b=new CANNON.Body({mass:Math.max(0.2,inertiaScale)});
      b.addShape(new CANNON.Cylinder(radius,radius,0.4,12));
      b.position.set(pos.x,pos.y,pos.z);
      b.allowSleep=false;
      b.angularDamping=0.6;
      _world.addBody(b);
      rotor.body=b;
      rotor._px=pos.x; rotor._py=pos.y; rotor._pz=pos.z;
    }
    return rotor;
  }
  /* drive: 구동 토크, damp: 감쇠계수(저항 비례) */
  function _stepRotor(rotor,drive,damp,dt){
    if(rotor.body){
      var b=rotor.body;
      b.angularDamping=_clamp(damp,0,0.99);
      b.applyTorque(new CANNON.Vec3(0,0,drive));
      /* 평행이동·여타 회전축 잠금 */
      b.position.set(rotor._px,rotor._py,rotor._pz);
      b.velocity.set(0,0,0);
      b.angularVelocity.x=0; b.angularVelocity.y=0;
      rotor.omega=b.angularVelocity.z;
    } else {
      /* 폴백: I·α = τ − b·ω */
      var alpha=drive/rotor.inertia - damp*4*rotor.omega;
      rotor.omega+=alpha*dt;
    }
    rotor.omega=_clamp(rotor.omega,-12,12);
    rotor.angle+=rotor.omega*dt;
  }

  /* ════════ 레인(물 입자 경로) ════════
   * pts: Vector3 배열, dirSign: +1/-1 진행방향,
   * kind: 'wire'|'comp', ref: 소자(라벨/식별),
   * cur: {i0,iinf,tau} 전류모델(없으면 null), Iabs: 정상상태 전류 절대값(A)
   *
   * 전자(입자)는 모든 레인에 균등 간격(PARTICLE_SPACING)으로 배치한다.
   * 전류 크기는 입자 '개수'가 아니라 '이동 속력'으로 표현한다(#1). */
  function _addLane(pts,dirSign,kind,ref,cur,Iabs){
    var seg=[], total=0;
    for(var i=0;i<pts.length-1;i++){
      var l=pts[i].distanceTo(pts[i+1]); seg.push(l); total+=l;
    }
    if(total<1e-4) return null;
    /* 균등 간격으로 입자 배치 (개수 = 길이/간격, 최소 2개) */
    var n=Math.max(2,Math.round(total/PARTICLE_SPACING));
    var ps=[];
    for(var k=0;k<n;k++) ps.push({s:(k/n)*total});
    var lane={pts:pts,seg:seg,total:total,dir:dirSign,kind:kind,ref:ref,
              cur:cur||null, Iabs:(Iabs!=null?Math.abs(Iabs):0), parts:ps};
    _lanes.push(lane);
    return lane;
  }
  function _lanePoint(lane,s){
    s=((s%lane.total)+lane.total)%lane.total;
    for(var i=0;i<lane.seg.length;i++){
      if(s<=lane.seg[i]||i===lane.seg.length-1){
        var r=lane.seg[i]>1e-6?s/lane.seg[i]:0;
        return new THREE.Vector3().copy(lane.pts[i]).lerp(lane.pts[i+1],_clamp(r,0,1));
      }
      s-=lane.seg[i];
    }
    return lane.pts[lane.pts.length-1].clone();
  }

  /* 물리(시뮬레이션) 시간 — 시상수에 맞춰 가속된 시간(초) */
  function _physT(){ return _simTime*_simSpeed; }

  /* ── 가지 전류 i(t) (절대값, 암페어) ──
   *   레인에 저장된 {i0, iinf, tau} 로 1차 지수 전이 계산.
   *   i(t) = iinf + (i0 − iinf)·e^{−t/τ}
   *   모델이 없으면(정적 회로) 정상상태 전류로 부드럽게 가동. */
  function _branchCurrent(lane, t){
    var m=lane.cur;
    if(m){
      if(t<=0) return Math.abs(m.i0);
      var e=Math.exp(-t/Math.max(m.tau,1e-12));
      return Math.abs(m.iinf + (m.i0 - m.iinf)*e);
    }
    /* 모델 없음: 정상상태값으로 부드러운 가동 */
    var iss=lane.Iabs||0;
    if(t<=0) return 0;
    var tauB=_domTau>1e-9?_domTau:_staticBase;
    return Math.abs(iss*(1-Math.exp(-t/Math.max(tauB,1e-9))));
  }

  /* 흐름 계수 0~1 (전류를 _maxI로 정규화) — 글로우/속도 보조용 */
  function _flowFactor(comp, t){
    /* comp 기반 호출(펌프 등): branchModel 직접 조회 */
    if(comp && _branchModel && _branchModel.byComp && _branchModel.byComp[comp.id]){
      var m=_branchModel.byComp[comp.id];
      var i = (t<=0)? m.i0 : (m.iinf+(m.i0-m.iinf)*Math.exp(-t/Math.max(m.tau,1e-12)));
      return _clamp(Math.abs(i)/_maxI,0,1);
    }
    if(t<=0) return 0;
    var tauB=_domTau>1e-9?_domTau:_staticBase;
    return 1-Math.exp(-t/Math.max(tauB,1e-9));
  }

  /* 소자 레인 방향 결정 (#전류방향) ──
   *   레인 점이 [ports[0] → ports[1]] 순서로 배열됐다고 가정.
   *   가지 전류 부호(s0/sinf, ports[0]→ports[1]=+)가 양이면 dir=+1(점 순서대로),
   *   음이면 dir=−1(반대). 부호가 0이면 전위 경사(고→저)로 폴백. */
  function _compLaneDir(c){
    var m=(_branchModel&&_branchModel.byComp)?_branchModel.byComp[c.id]:null;
    if(m){
      var s=(Math.abs(m.s0||0)>=Math.abs(m.sinf||0))?(m.s0||0):(m.sinf||0);
      if(Math.abs(s)>1e-15) return s>0?1:-1;
    }
    /* 폴백: 전위 경사 (ports[0]가 고전위면 +1: 전류는 고→저) */
    var ports=App.Geo.getCompPorts(c);
    var v0=_portV(c,ports[0]), v1=_portV(c,ports[1]);
    if(Math.abs(v0-v1)>1e-12) return v0>v1?1:-1;
    return 1;
  }

  function _totR(){
    var r=0;
    App.State.components.forEach(function(c){if(c.type===TYPE.RESISTOR)r+=Math.max(c.value||0,0);});
    return r>1e-3?r:100;
  }

  /* ════════ 씬 구축 ════════ */
  function _computeNorm(){
    var sr=App.State.solverResult;
    _maxI=1e-6; _vMin=Infinity; _vMax=-Infinity;
    var any=false;
    App.State.components.forEach(function(c){
      var I=Math.abs((sr&&sr.branchCurrents&&sr.branchCurrents[c.id])||0);
      if(I>_maxI)_maxI=I;
      App.Geo.getCompPorts(c).forEach(function(p){
        var v=_portV(c,p); any=true;
        if(v<_vMin)_vMin=v; if(v>_vMax)_vMax=v;
      });
    });
    App.State.wires.forEach(function(w){
      var I=Math.abs((sr&&sr.wireSignedI&&sr.wireSignedI[w.id])||0);
      if(I>_maxI)_maxI=I;
    });
    /* 시변 전위(노드 모델)의 t=0·t=∞ 전압도 정규화 범위에 포함 (#3)
     *   → 시간에 따라 높이가 변해도 화면을 벗어나지 않도록 고정 스케일 확보 */
    var bm=_branchModel;
    if(bm&&bm.byNode){
      Object.keys(bm.byNode).forEach(function(k){
        var m=bm.byNode[k]; any=true;
        [m.v0,m.vinf].forEach(function(v){ if(v<_vMin)_vMin=v; if(v>_vMax)_vMax=v; });
      });
    }
    if(!any){_vMin=0;_vMax=1;}
    if(_vMax-_vMin<1e-6)_vMax=_vMin+1;

    /* 그리드 중심 */
    var sx=0,sy=0,n=0;
    App.State.components.forEach(function(c){sx+=c.gridX+0.5;sy+=c.gridY+0.5;n++;});
    _cxGrid=n?sx/n:GRID_COLS/2; _czGrid=n?sy/n:GRID_ROWS/2;
  }

  function _buildGround(){
    var bb=new THREE.Box3();
    var has=false;
    App.State.components.forEach(function(c){
      App.Geo.getCompPorts(c).forEach(function(p){bb.expandByPoint(_portPos(c,p));has=true;});
    });
    if(!has){bb.expandByPoint(new THREE.Vector3(-4,0,-4));bb.expandByPoint(new THREE.Vector3(4,0,4));}
    var sizeX=Math.max(12,(bb.max.x-bb.min.x)+8);
    var sizeZ=Math.max(12,(bb.max.z-bb.min.z)+8);
    var cx=(bb.max.x+bb.min.x)/2, cz=(bb.max.z+bb.min.z)/2;
    var g=new THREE.PlaneGeometry(sizeX,sizeZ);
    /* 바닥 — 지면(밝은 회색) 톤. 소자 색은 의미(물=파랑 등)라 그대로 두고,
     * 환경만 밝게 맞춰 앱 전체가 한 벌로 읽히게 한다. */
    var m=new THREE.MeshStandardMaterial({color:0xe4e7ec,roughness:1,metalness:0});
    var plane=new THREE.Mesh(g,m);
    plane.rotation.x=-Math.PI/2; plane.position.set(cx,-0.6,cz);
    _scene.add(plane);
    /* 격자선 */
    var grid=new THREE.GridHelper(Math.max(sizeX,sizeZ),Math.round(Math.max(sizeX,sizeZ)/SP),0x9aa2b0,0xc2c8d2);
    grid.material.opacity=0.5; grid.material.transparent=true;
    grid.position.set(cx,-0.58,cz);
    _scene.add(grid);
    /* 카메라 프레이밍 */
    _cam.tx=cx; _cam.tz=cz; _cam.ty=(bb.max.y+bb.min.y)/2;
    _cam.dist=_clamp(Math.max(sizeX,sizeZ)*1.15,16,70);
  }

  function _nodePillar(pos){
    /* 전위 높이를 지면과 잇는 기둥 (높이=전압 시각화) */
    var h=Math.max(0.1,pos.y+0.6);
    var geo=new THREE.BoxGeometry(0.5,h,0.5);
    var mat=new THREE.MeshStandardMaterial({color:COL_NODE,roughness:0.8,metalness:0.1,transparent:true,opacity:0.55});
    var m=new THREE.Mesh(geo,mat);
    m.position.set(pos.x,pos.y-h/2+0.1,pos.z);
    _scene.add(m);
  }

  /* 도선 → 경사 수로 + 물 레인 (편집 모드와 동일한 ㄱ/ㄴ 직각 경로) */
  function _buildWire(w){
    var from=App.State.getComponent(w.fromId), to=App.State.getComponent(w.toId);
    if(!from||!to) return;
    /* 양 끝 포트의 그리드 좌표·높이 */
    var ga=App.Geo.getPortGridPos(from,w.fromPort);
    var gb=App.Geo.getPortGridPos(to,  w.toPort);
    var ya=_vToY(_portV(from,w.fromPort));
    var yb=_vToY(_portV(to,  w.toPort));
    /* 편집 모드의 calcWirePath와 동일하게 꺾임점 결정 (대각선 금지)
     *   H-first: 가로 먼저 → 꺾임점 (gb.x, ga.y)
     *   V-first: 세로 먼저 → 꺾임점 (ga.x, gb.y) */
    var bend=(w.direction==='V-first') ? {x:ga.x,y:gb.y} : {x:gb.x,y:ga.y};
    /* 꺾임점 높이: 경로 길이 비율로 보간 (이상적 도선이면 ya≈yb) */
    var d1=Math.hypot(bend.x-ga.x, bend.y-ga.y);
    var d2=Math.hypot(gb.x-bend.x, gb.y-bend.y);
    var frac=(d1+d2)>1e-6 ? d1/(d1+d2) : 0.5;
    var A=_grid3D(ga.x,ga.y,ya);
    var Bend=_grid3D(bend.x,bend.y, ya+(yb-ya)*frac);
    var B=_grid3D(gb.x,gb.y,yb);

    var sr=App.State.solverResult;
    var signedI=(sr&&sr.wireSignedI&&sr.wireSignedI[w.id])||0;
    /* ── 전류 방향 결정 (#2) ──
     *   물은 고전위(높음)→저전위(낮음)로 흐른다. fromPort→toPort 를 +방향으로 두고,
     *   v(from) > v(to) 이면 +1(정방향), 아니면 −1.
     *   전위차가 시변하므로 t=0·t=∞ 중 크기가 큰 쪽으로 부호를 정한다(부호는 보통 불변).
     *   전위차가 0(등전위 도선)이면 연결 소자의 부호 전류로 폴백. */
    var vF0=_portVt(from,w.fromPort,0),   vT0=_portVt(to,w.toPort,0);
    var vFi=_portVt(from,w.fromPort,1e12),vTi=_portVt(to,w.toPort,1e12);
    var dV0=vF0-vT0, dVi=vFi-vTi;
    var dVuse=(Math.abs(dV0)>=Math.abs(dVi))?dV0:dVi;
    var sign;
    if(Math.abs(dVuse)>1e-9){
      sign=dVuse>0?1:-1;
    } else {
      /* 등전위 도선: 연결 소자의 부호 전류로 방향 결정.
       *   소자 부호전류 s(>0): ports[0]→ports[1] 방향(소자 내부)으로 전류가 흐름.
       *   도선이 ports[1]에 붙으면 전류가 소자→도선(유출)이고, 그 방향이
       *   도선의 ref끝→반대끝 과 정렬된다. refIsFrom 으로 from→to 부호 환산. */
      var wm0=(_branchModel&&_branchModel.byWire)?_branchModel.byWire[w.id]:null;
      sign=1;
      if(wm0&&wm0.refId&&_branchModel.byComp[wm0.refId]){
        var rc=_branchModel.byComp[wm0.refId];
        var sref=(Math.abs(rc.s0)>=Math.abs(rc.sinf))?rc.s0:rc.sinf;
        var sbase=(sref>=0?1:-1);
        /* 도선이 소자 ports[1](idx=1)에 붙으면 전류 유출(+), ports[0]이면 유입(−) */
        var portDir=(wm0.refPortIdx===1)?1:-1;
        /* refIsFrom: ref끝이 도선 from이면 그대로, to면 반전 */
        sign=sbase*portDir*(wm0.refIsFrom?1:-1);
        if(sign===0) sign=1;
      } else {
        sign=signedI>=0?1:-1;
      }
    }

    /* 두 직선 구간으로 수로 구성 (꺾임점에서 90° 전환) */
    var tube1=_channelSeg(A,Bend);
    var tube2=_channelSeg(Bend,B);
    /* 꺾임 모서리를 둥글게 (실제 도선처럼 매끄럽게 연결) */
    var bendMesh=null;
    if(d1>0.02 && d2>0.02){
      bendMesh=new THREE.Mesh(new THREE.SphereGeometry(CH_W*0.5,10,8),
             new THREE.MeshStandardMaterial({color:COL_CHANNEL,transparent:true,opacity:0.45,roughness:0.6}));
      bendMesh.position.copy(Bend); _scene.add(bendMesh);
    }
    /* 도선 가지 전류 모델 (branchModel.byWire) */
    var wm=(_branchModel&&_branchModel.byWire)?_branchModel.byWire[w.id]:null;
    /* 물 레인: 꺾임점을 포함한 3점 폴리라인 */
    var lane=_addLane([A.clone(),Bend.clone(),B.clone()],sign,'wire',null,wm,Math.abs(signedI));
    if(lane){
      lane.wireId=w.id;
      /* 시변 높이(#3): 양 끝 포트 노드 v(t)로 A·Bend·B 의 y 를 매 프레임 갱신 */
      lane.dyn={ from:from, fromPort:w.fromPort, to:to, toPort:w.toPort,
                 frac:frac, ga:ga, gb:gb, bend:bend,
                 tube1:tube1, tube2:tube2, bendMesh:bendMesh };
    }
    /* 도선 전류 I(t) 라벨 (꺾임점 위, 매 프레임 갱신) — #3, #4
     *   도선 전위: 양 끝 포트 전위 평균을 최저전위(_vMin) 기준 0V로 환산.
     *   시변 전위를 위해 양 끝 포트 참조를 라벨에 저장. */
    var vWire=(_portV(from,w.fromPort)+_portV(to,w.toPort))/2 - _vMin;
    _makeWireLabel(w, Bend.clone(), wm, Math.abs(signedI), vWire,
                   {from:from, fromPort:w.fromPort, to:to, toPort:w.toPort});
  }

  /* 물 튀김 파티클 풀 — 작은 물방울 n개. 비활성 시 숨김.
   *   _spawnSplash(center) 로 휠 하단에서 사방으로 튀게 활성화. */
  function _makeSplashPool(n){
    var pool=[];
    var geo=new THREE.SphereGeometry(0.09,6,5);
    var mat=new THREE.MeshStandardMaterial({color:0x9fd8ff,emissive:0x2a7fd0,emissiveIntensity:0.5,
            roughness:0.2,transparent:true,opacity:0.9});
    for(var i=0;i<n;i++){
      var m=new THREE.Mesh(geo,mat.clone());
      m.visible=false;
      _scene.add(m);
      pool.push({mesh:m, life:0, vx:0,vy:0,vz:0});
    }
    return {drops:pool, idx:0};
  }
  /* 휠 하단(pos)에서 물방울 몇 개를 사방으로 분출 */
  function _spawnSplash(splash, pos, strength){
    if(!splash) return;
    var burst=2+Math.floor(strength*3);   // 전류 셀수록 더 많이
    for(var b=0;b<burst;b++){
      var d=splash.drops[splash.idx];
      splash.idx=(splash.idx+1)%splash.drops.length;
      d.mesh.position.set(pos.x+(Math.random()-0.5)*0.2, pos.y, pos.z+(Math.random()-0.5)*0.4);
      var ang=Math.random()*Math.PI*2;
      var spd=0.8+Math.random()*1.4*(0.5+strength);
      d.vx=Math.cos(ang)*spd*0.5;
      d.vy=1.2+Math.random()*1.6*(0.5+strength);   // 위로 튀어오름
      d.vz=Math.sin(ang)*spd*0.5;
      d.life=0.5+Math.random()*0.4;
      d.mesh.visible=true;
      d.mesh.material.opacity=0.9;
    }
  }
  /* 물방울 물리 갱신 (중력 낙하 + 페이드) */
  function _updateSplash(splash, dt){
    if(!splash) return;
    var G=6.5;
    splash.drops.forEach(function(d){
      if(d.life<=0){ if(d.mesh.visible)d.mesh.visible=false; return; }
      d.life-=dt;
      d.vy-=G*dt;
      d.mesh.position.x+=d.vx*dt;
      d.mesh.position.y+=d.vy*dt;
      d.mesh.position.z+=d.vz*dt;
      d.mesh.material.opacity=_clamp(d.life*1.6,0,0.9);
      if(d.life<=0) d.mesh.visible=false;
    });
  }

  /* 저항 → 물레방아 */
  function _buildResistor(c){
    var ports=App.Geo.getCompPorts(c);
    var pA=_portPos(c,ports[0]), pB=_portPos(c,ports[1]);
    var hi=pA.y>=pB.y?pA:pB, lo=pA.y>=pB.y?pB:pA;
    var sr=App.State.solverResult;
    var I=Math.abs((sr&&sr.branchCurrents&&sr.branchCurrents[c.id])||0);
    var Vd=Math.abs((sr&&sr.componentVoltages&&sr.componentVoltages[c.id])||0);
    var P=Vd*I;
    /* 저항 가지 전류 모델 (C와 직렬이면 i0>0·iinf=0 → 초반에 돈다, #2 수정) */
    var rm=(_branchModel&&_branchModel.byComp)?_branchModel.byComp[c.id]:null;
    /* 순간전력 정규화 기준: i_peak^2·R (i_peak = max(|i0|,|iinf|)) */
    var ipk=rm?Math.max(Math.abs(rm.i0),Math.abs(rm.iinf)):I;
    var Ppeak=ipk*ipk*Math.max(c.value||0,1e-6);
    var center=_compCenter(c);
    var wheelR=1.35;   // 스케일업

    /* 받침대 (저항색) */
    _addBaseDisk(center, wheelR*0.95, COL_WHEEL);

    /* 낙차 수직관 (high → wheel → low) */
    var top=new THREE.Vector3(center.x,hi.y,center.z);
    var bot=new THREE.Vector3(center.x,lo.y,center.z);
    var rtTube1=_tubeBetween(hi,top,CH_W*0.45,COL_CHANNEL,0.45);
    var rtTube2=_tubeBetween(bot,lo,CH_W*0.45,COL_CHANNEL,0.45);
    _scene.add(rtTube1); _scene.add(rtTube2);

    /* 물레방아 (Three 메쉬 그룹) */
    var grp=new THREE.Group();
    grp.position.set(center.x,(hi.y+lo.y)/2,center.z);
    /* 중심 축(hub) */
    var hub=new THREE.Mesh(new THREE.CylinderGeometry(wheelR*0.14,wheelR*0.14,0.7,14),
            new THREE.MeshStandardMaterial({color:0x9aa,roughness:0.5,metalness:0.6}));
    hub.rotation.x=Math.PI/2; grp.add(hub);
    /* 양쪽 림(두 개의 테) — 폭 있는 물레바퀴 느낌 */
    [-0.22,0.22].forEach(function(zoff){
      var rim=new THREE.Mesh(new THREE.TorusGeometry(wheelR,wheelR*0.07,8,28),
              new THREE.MeshStandardMaterial({color:COL_WHEEL,roughness:0.5,metalness:0.2}));
      rim.position.z=zoff; grp.add(rim);
    });
    /* 컵(scoop) 형태 날개 — 물을 담는 휘어진 패들 */
    var blades=10;
    var scoopMat=new THREE.MeshStandardMaterial({color:COL_WHEEL,roughness:0.5,metalness:0.2,side:THREE.DoubleSide});
    for(var i=0;i<blades;i++){
      var a=(i/blades)*Math.PI*2;
      /* 패들: 반열린 원통 조각(컵)으로 물을 받는 형태 */
      var scoop=new THREE.Mesh(
        new THREE.CylinderGeometry(wheelR*0.26,wheelR*0.26,0.5,8,1,true,0,Math.PI),
        scoopMat);
      scoop.position.set(Math.cos(a)*wheelR*0.74,Math.sin(a)*wheelR*0.74,0);
      scoop.rotation.z=a-Math.PI/2;       // 컵 입구가 회전 접선 방향
      scoop.rotation.y=Math.PI/2;
      grp.add(scoop);
      /* 살(spoke) */
      var spoke=new THREE.Mesh(new THREE.BoxGeometry(wheelR*0.8,0.06,0.06),
                new THREE.MeshStandardMaterial({color:COL_WHEEL,roughness:0.6,metalness:0.2}));
      spoke.position.set(Math.cos(a)*wheelR*0.4,Math.sin(a)*wheelR*0.4,0);
      spoke.rotation.z=a; grp.add(spoke);
    }
    /* 마찰열(전력) 글로우 */
    var glow=new THREE.Mesh(new THREE.SphereGeometry(wheelR*1.1,16,12),
            new THREE.MeshBasicMaterial({color:0xff5530,transparent:true,opacity:0.0}));
    grp.add(glow);
    _scene.add(grp);

    /* 축 지지대(A자 받침) — 물레방아 구조 명확화 */
    var supMat=new THREE.MeshStandardMaterial({color:0x4a5a72,roughness:0.7,metalness:0.3});
    [-0.55,0.55].forEach(function(zoff){
      var leg=new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.09,wheelR*1.5,8),supMat);
      leg.position.set(center.x, (hi.y+lo.y)/2 - wheelR*0.55, center.z+zoff);
      _scene.add(leg);
    });

    /* 낙차 물 레인 — 입자가 물레방아 바깥 테두리(외주)를 타고 돌며 패들을 밀어
     *   휠을 굴려주는 느낌을 준다. hi→(휠 상단)→외주 호(arc)→(휠 하단)→lo 경로.
     *   휠은 z축 둘레로 회전(rotation.z)하므로, 입자는 휠 정면(xy 평면)에서 좌측 외주를
     *   따라 내려간다(반시계: 상단→좌→하단). 패들이 받는 방향과 일치. */
    var wc=grp.position.clone();           // 휠 중심
    var rimR=wheelR*0.96;                  // 입자가 타는 반경(테두리 근처)
    var arcPts=[];
    /* 상단(+90°)에서 좌측을 거쳐 하단(-90°=270°)까지 반바퀴(외주 호) */
    var aStart=Math.PI/2, aEnd=Math.PI*1.5;  // 90°→270° (좌측 경유)
    var ARC_N=10;
    for(var k=0;k<=ARC_N;k++){
      var aa=aStart + (aEnd-aStart)*(k/ARC_N);
      arcPts.push(new THREE.Vector3(wc.x+Math.cos(aa)*rimR, wc.y+Math.sin(aa)*rimR, wc.z));
    }
    var lanePts=[hi.clone(), top.clone()].concat(arcPts).concat([bot.clone(), lo.clone()]);
    var lane=_addLane(lanePts, 1,'comp',c,rm,I);
    /* 시변 낙차(#3): R 양단 전위가 V→0 으로 변하므로 hi/lo·물레방아·튜브 높이 갱신 */
    var pHi = pA.y>=pB.y?ports[0]:ports[1];   // 높은 쪽 포트
    var pLo = pA.y>=pB.y?ports[1]:ports[0];   // 낮은 쪽 포트
    if(lane){
      lane.dynR={ comp:c, pHi:pHi, pLo:pLo, cx:center.x, cz:center.z,
                  grp:grp, tube1:rtTube1, tube2:rtTube2, rimR:rimR, arcN:ARC_N };
      lane.isWheelLane=true;
    }

    /* 물 튀김 파티클 풀 (휠 하단에서 물이 떨어지며 사방으로 튀김) */
    var splash=_makeSplashPool(16);

    /* 동역학 등록: 전류모델·피크전력 저장 (물레방아 각속도 ∝ 순간전력) */
    var rotor=_makeRotor(grp.position,wheelR,0.8);
    _wheels.push({grp:grp,rotor:rotor,glow:glow,comp:c,cur:rm,R:Math.max(c.value||0,1e-6),Ppeak:Ppeak,
                  pHi:pHi,pLo:pLo,cx:center.x,cz:center.z,tube1:rtTube1,tube2:rtTube2,lane:lane,
                  wheelR:wheelR, splash:splash, splashTimer:0});
  }

  /* DC 전원 → 수직 양수 펌프 */
  function _buildPump(c){
    var ports=App.Geo.getCompPorts(c);
    /* DC 전원 +극 판정: 전위가 높은 포트가 +극.
     *   (솔버 컨벤션 ports[0]=posNode 이지만, value 부호·회로에 따라 실제
     *    고전위 단자가 바뀔 수 있으므로 전위로 직접 판정하여 견고하게.) */
    var v0=_portV(c,ports[0]), v1=_portV(c,ports[1]);
    var plusPort  = (v0>=v1)?ports[0]:ports[1];
    var minusPort = (v0>=v1)?ports[1]:ports[0];
    var pPlus =_portPos(c,plusPort);    // +극 (고전위)
    var pMinus=_portPos(c,minusPort);   // −극 (저전위)
    var pA=_portPos(c,ports[0]), pB=_portPos(c,ports[1]);
    var hi=pA.y>=pB.y?pA:pB, lo=pA.y>=pB.y?pB:pA;
    var center=_compCenter(c);
    var sr=App.State.solverResult;
    var I=Math.abs((sr&&sr.branchCurrents&&sr.branchCurrents[c.id])||0);

    /* ── 역기전력(back-EMF) 판정 (#역기전력) ──
     *   정상 전원: 전류가 내부에서 −극→+극 으로 흐른다(전력 공급, 펌프가 퍼올림).
     *   역기전력: 전류가 +극→−극 으로 흐른다(전력 흡수, 피충전). 이때는 펌프가 아니라
     *            물이 펌프를 거꾸로 통과하며 역회전시키는 모습으로 표현해야 한다.
     *   판정: 전원 부호전류 s 가 −극→+극 방향과 같은지 비교.
     *         branchModel.byComp[id].s0 는 ports[0]→ports[1] 을 + 로 정의.
     *         +극이 ports[0]이면 (−극→+극)=(ports[1]→ports[0])=음의 s, 반대면 양의 s.
     *         실제 전류가 (−극→+극)과 같으면 정상(supply), 반대면 역기전력(absorb). */
    var pm0=(_branchModel&&_branchModel.byComp)?_branchModel.byComp[c.id]:null;
    var sSrc=pm0?((Math.abs(pm0.s0||0)>=Math.abs(pm0.sinf||0))?(pm0.s0||0):(pm0.sinf||0)):0;
    /* (−극→+극) 방향을 ports 기준 부호로: +극==ports[0] 이면 그 방향은 ports[1]→ports[0] = 음(-) */
    var emfSignInPortFrame = (plusPort===ports[0]) ? -1 : +1;  // (−→+)가 s 부호로 어느 쪽인지
    /* 실제 전류 s 가 emf 방향과 같으면 supply(정상), 반대면 back-EMF */
    var isBackEMF = false;
    if(Math.abs(sSrc)>1e-12){
      var sameAsEMF = (sSrc>0 ? +1 : -1) === emfSignInPortFrame;
      isBackEMF = !sameAsEMF;
    }

    /* 받침대 (전원색) */
    _addBaseDisk(center, 0.95, COL_PUMP);

    /* 양수 샤프트 (낮은 곳→높은 곳) — 굵게 */
    var top=new THREE.Vector3(center.x,hi.y,center.z);
    var bot=new THREE.Vector3(center.x,lo.y,center.z);
    var shaftH=Math.max(0.2,hi.y-lo.y);
    var shaft=new THREE.Mesh(new THREE.CylinderGeometry(0.62,0.62,shaftH,18,1,true),
              new THREE.MeshStandardMaterial({color:COL_PUMP,roughness:0.4,metalness:0.3,transparent:true,opacity:0.42,side:THREE.DoubleSide}));
    shaft.position.set(center.x,(hi.y+lo.y)/2,center.z);
    _scene.add(shaft);
    /* 흡입구(하단, 깔때기) + 배출구(상단) */
    var inlet=new THREE.Mesh(new THREE.CylinderGeometry(0.85,0.55,0.5,16,1,true),
              new THREE.MeshStandardMaterial({color:COL_PUMP,roughness:0.5,metalness:0.3,transparent:true,opacity:0.6,side:THREE.DoubleSide}));
    inlet.position.set(center.x, lo.y+0.1, center.z); _scene.add(inlet);
    var outlet=new THREE.Mesh(new THREE.CylinderGeometry(0.55,0.8,0.5,16,1,true),
              new THREE.MeshStandardMaterial({color:COL_PUMP,roughness:0.5,metalness:0.3,transparent:true,opacity:0.6,side:THREE.DoubleSide}));
    outlet.position.set(center.x, hi.y-0.1, center.z); _scene.add(outlet);
    _scene.add(_tubeBetween(lo,bot,CH_W*0.45,COL_CHANNEL,0.45));
    _scene.add(_tubeBetween(top,hi,CH_W*0.45,COL_CHANNEL,0.45));

    /* 임펠러(나선 오거) — 굵고 뚜렷하게, 중심축 포함 */
    var grp=new THREE.Group(); grp.position.copy(shaft.position);
    var augerCore=new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.1,shaftH*0.95,8),
              new THREE.MeshStandardMaterial({color:0xbfe0ff,roughness:0.4,metalness:0.4}));
    grp.add(augerCore);
    var augerMat=new THREE.MeshStandardMaterial({color:0xa7d0ff,roughness:0.35,metalness:0.35,
                  emissive:0x2a5a90,emissiveIntensity:0.25,side:THREE.DoubleSide});
    var turns=4, perTurn=10, hAug=Math.max(0.4,shaftH*0.95);
    for(var i=0;i<turns*perTurn;i++){
      var frac=i/(turns*perTurn);
      var ang=frac*turns*Math.PI*2;
      var fin=new THREE.Mesh(new THREE.BoxGeometry(0.95,0.1,0.34),augerMat);
      fin.position.set(0,(frac-0.5)*hAug,0);
      fin.rotation.y=ang;
      grp.add(fin);
    }
    _scene.add(grp);

    /* 방향 화살표: 정상이면 위(공급), 역기전력이면 아래(흡수) — 색도 구분 */
    var arrowH=Math.min(1.6,shaftH*0.6+0.6);
    if(isBackEMF){
      /* 아래로 향하는 화살표 (역기전력: 물이 거꾸로 통과) — 주황/붉은색 */
      var ag=_addArrow(new THREE.Vector3(center.x+1.0, (hi.y+lo.y)/2+0.4, center.z), arrowH, 0xffa060);
      ag.rotation.z=Math.PI;   // 화살표 뒤집어 아래로
    } else {
      /* 위로 향하는 화살표 (정상: 퍼올림) — 밝은 연두 */
      _addArrow(new THREE.Vector3(center.x+1.0, (hi.y+lo.y)/2-0.4, center.z), arrowH, 0xc8ffd8);
    }

    /* 물 레인: 전류 실제 방향대로 점을 배열한다.
     *   정상(supply): −극→+극 (아래→위, 펌프가 퍼올림)
     *   역기전력(absorb): +극→−극 (위→아래, 물이 펌프를 거꾸로 통과) */
    var pm=pm0;
    var minusEnd=pMinus.clone();
    var plusEnd =pPlus.clone();
    var botPt=new THREE.Vector3(center.x, pMinus.y, center.z);
    var topPt=new THREE.Vector3(center.x, pPlus.y,  center.z);
    if(isBackEMF){
      /* +극 → −극 (위→아래) */
      _addLane([plusEnd, topPt, botPt, minusEnd],1,'comp',c,pm,I);
    } else {
      /* −극 → +극 (아래→위) */
      _addLane([minusEnd, botPt, topPt, plusEnd],1,'comp',c,pm,I);
    }

    var rotor=_makeRotor(grp.position,0.7,0.5);
    /* 펌프 회전 방향: 정상은 +방향, 역기전력은 역방향(물에 떠밀려 거꾸로 돎) */
    _dynamics.push({grp:grp,rotor:rotor,kind:'pump',comp:c,cur:pm,axis:'y',backEMF:isBackEMF});
  }

  /* 축전기 → 탄성 막(다이어프램) 탱크
   *   좌우 두 탱크가 가운데 고무막으로 막혀 있다. 물(전하)은 막을 통과하지 못하지만,
   *   한쪽으로 밀려오면 막이 볼록하게 휘며 반대쪽을 밀어낸다(변위 전류).
   *   충전될수록 막이 더 부풀고 역압이 커져 흐름이 느려지다 평형서 정지.
   *   - 막 변위 ∝ 충전량 Q(t) (0 → 최대)
   *   - 입자(전류)는 막 면에서 멈춘다. */
  function _buildCapacitor(c){
    var ports=App.Geo.getCompPorts(c);
    var pA=_portPos(c,ports[0]), pB=_portPos(c,ports[1]);
    var center=_compCenter(c);

    /* 받침대 (축전기색) */
    _addBaseDisk(center, 1.2, COL_DAM);

    /* 흐름 축 = X축(좌→우 포트 방향). 두 탱크를 center 좌우(±xHalf)에 두고,
     *   막은 가운데(x=center.x). 입자(전류)는 X 방향으로 흐른다. */
    var tankR=0.78;          // 탱크 반경
    var xHalf=0.95;          // 막에서 각 탱크 끝까지 거리
    var caseMat=new THREE.MeshStandardMaterial({color:COL_DAM,roughness:0.55,metalness:0.2,
                  transparent:true,opacity:0.30,side:THREE.DoubleSide});

    /* 좌우 탱크(투명 원통) — 흐름 축(x)을 따라 누운 통 */
    function tank(xc){
      var t=new THREE.Mesh(new THREE.CylinderGeometry(tankR,tankR,xHalf,20,1,true),caseMat);
      t.rotation.z=Math.PI/2;                  // 통을 x축으로 눕힘
      t.position.set(center.x+xc, center.y, center.z);
      _scene.add(t);
    }
    tank(-xHalf/2 - 0.05);
    tank( xHalf/2 + 0.05);
    /* 양 끝 마개(극판) */
    var plateMat=new THREE.MeshStandardMaterial({color:COL_DAM,roughness:0.5,metalness:0.35,
                   emissive:COL_DAM,emissiveIntensity:0.2});
    [-xHalf-0.05, xHalf+0.05].forEach(function(xc){
      var plate=new THREE.Mesh(new THREE.CylinderGeometry(tankR*1.05,tankR*1.05,0.12,20),plateMat);
      plate.rotation.z=Math.PI/2;
      plate.position.set(center.x+xc, center.y, center.z);
      _scene.add(plate);
    });

    /* 가운데 탄성 막(다이어프램) — 반구를 눌러 만든 볼록 디스크.
     *   흐름 축(x)으로 볼록 정도(변위)를 표현. 충전량에 따라 매 프레임 갱신. */
    var membGeo=new THREE.SphereGeometry(tankR*0.92,20,14);
    var membMat=new THREE.MeshStandardMaterial({color:0xff7e6b,roughness:0.45,metalness:0.1,
                  emissive:0x802018,emissiveIntensity:0.25,side:THREE.DoubleSide});
    var memb=new THREE.Mesh(membGeo,membMat);
    memb.scale.set(0.18,1,1);                  // 납작한 디스크(x방향 두께) — 초기 평평에 가깝게
    memb.position.set(center.x, center.y, center.z);
    _scene.add(memb);
    /* 막 테두리 링(고정부) — YZ 평면에 위치하도록 x축 정렬 */
    var ring=new THREE.Mesh(new THREE.TorusGeometry(tankR*0.92,0.06,8,24),
             new THREE.MeshStandardMaterial({color:0xcc5040,roughness:0.5,metalness:0.2}));
    ring.rotation.y=Math.PI/2;                  // 링을 YZ 평면으로 (흐름축에 수직)
    ring.position.set(center.x, center.y, center.z);
    _scene.add(ring);

    /* 입출력 연결관 (포트 → 탱크 양 끝) */
    _scene.add(_tubeBetween(pA,new THREE.Vector3(center.x,pA.y,center.z),CH_W*0.45,COL_CHANNEL,0.45));
    _scene.add(_tubeBetween(pB,new THREE.Vector3(center.x,pB.y,center.z),CH_W*0.45,COL_CHANNEL,0.45));

    /* 충전 전류 레인 — branchModel: i0>0, iinf=0.
     *   레인 점 [ports[0] → 막 직전 → 막 직전 → ports[1]] : 입자는 막 양쪽에서
     *   밀려오지만 막을 통과하지 못하므로, 막 면(z=center.z) 근처에서 모이게 한다.
     *   (시각적으로 막 양쪽에 입자가 쌓이는 효과) */
    var cm=(_branchModel&&_branchModel.byComp)?_branchModel.byComp[c.id]:null;
    var cIabs=cm?Math.abs(cm.i0):0;
    var lane=_addLane([pA.clone(),new THREE.Vector3(center.x,pA.y,center.z),
                       new THREE.Vector3(center.x,pB.y,center.z),pB.clone()],
                      _compLaneDir(c),'comp',c,cm,cIabs);
    /* 막 변위 애니메이션용 등록 */
    _dynamics.push({kind:'cap',comp:c,memb:memb,cur:cm,baseScaleX:0.18,maxBulge:1.5});
  }

  /* 인덕터 → 소용돌이 나선 수로 */
  function _buildInductor(c){
    var ports=App.Geo.getCompPorts(c);
    var pA=_portPos(c,ports[0]), pB=_portPos(c,ports[1]);
    var center=_compCenter(c);
    var sr=App.State.solverResult;
    var I=Math.abs((sr&&sr.branchCurrents&&sr.branchCurrents[c.id])||0);
    var midY=(pA.y+pB.y)/2;

    /* 받침대 (인덕터색) */
    _addBaseDisk(center, 1.15, COL_VORTEX);

    /* 나선 튜브: 서브클래싱 없이 내장 CatmullRomCurve3 사용 (버전 안전) — 굵게 */
    var R=1.05, turns=4, height=1.9, NSEG=80;
    var spiralPts=[];
    for(var si=0;si<=NSEG;si++){
      var tt=si/NSEG, ang=tt*turns*Math.PI*2;
      spiralPts.push(new THREE.Vector3(Math.cos(ang)*R,(tt-0.5)*height,Math.sin(ang)*R));
    }
    var curve=new THREE.CatmullRomCurve3(spiralPts);
    var tubeGeo=new THREE.TubeGeometry(curve,120,0.22,10,false);
    /* 반투명으로 복원 — 내부 물(전류) 흐름이 보이도록 */
    var tube=new THREE.Mesh(tubeGeo,new THREE.MeshStandardMaterial({color:COL_VORTEX,roughness:0.4,metalness:0.2,
              transparent:true,opacity:0.4}));
    var grp=new THREE.Group(); grp.position.set(center.x,midY,center.z); grp.add(tube);
    _scene.add(grp);

    /* 입출력 연결관 + 단자(터미널) */
    _scene.add(_tubeBetween(pA,new THREE.Vector3(center.x,midY+height/2,center.z),CH_W*0.45,COL_CHANNEL,0.45));
    _scene.add(_tubeBetween(new THREE.Vector3(center.x,midY-height/2,center.z),pB,CH_W*0.45,COL_CHANNEL,0.45));
    var termMat=new THREE.MeshStandardMaterial({color:COL_VORTEX,roughness:0.5,metalness:0.3});
    [midY+height/2, midY-height/2].forEach(function(ty){
      var term=new THREE.Mesh(new THREE.SphereGeometry(0.2,10,8),termMat);
      term.position.set(center.x,ty,center.z); _scene.add(term);
    });

    /* 나선 물 레인: 곡선 샘플링 — branchModel: i0=0, iinf>0.
     *   레인 점 [ports[0]→ports[1]] 순서. 전류 부호로 진행 방향 결정. */
    var pts=[pA.clone()];
    for(var s=0;s<=24;s++){
      var p=curve.getPoint(s/24);
      pts.push(new THREE.Vector3(center.x+p.x,midY+p.y,center.z+p.z));
    }
    pts.push(pB.clone());
    var lm=(_branchModel&&_branchModel.byComp)?_branchModel.byComp[c.id]:null;
    _addLane(pts,_compLaneDir(c),'comp',c,lm,I);
  }

  /* 분기점 → T자(3way) / 十자(4way) 갈림 수로
   *   중앙 허브에서 실제 포트 방향마다 팔(arm)을 뻗어 분기 형상을 만든다. */
  function _buildJunction(c){
    var center=_compCenter(c);
    /* 중앙 허브 — 키워서 분기 지점 명확화 */
    var hub=new THREE.Mesh(new THREE.CylinderGeometry(CH_W*0.95,CH_W*0.95,0.6,18),
            new THREE.MeshStandardMaterial({color:COL_CHANNEL,roughness:0.6,metalness:0.1,transparent:true,opacity:0.8}));
    hub.position.copy(center);
    _scene.add(hub);
    /* 각 포트로 팔 뻗기 (T자/十자는 포트 구성 LRB / LRTB 에서 자동 결정) */
    App.Geo.getCompPorts(c).forEach(function(p){
      var pp=_portPos(c,p);
      _channelSeg(center.clone(), pp);
    });
    /* 분기 표식: 허브 위 작은 구 */
    var cap=new THREE.Mesh(new THREE.SphereGeometry(CH_W*0.55,12,10),
            new THREE.MeshStandardMaterial({color:COL_NODE,roughness:0.5,metalness:0.2,
              emissive:COL_NODE,emissiveIntensity:0.25,transparent:true,opacity:0.85}));
    cap.position.set(center.x,center.y+0.35,center.z);
    _scene.add(cap);
  }

  function _buildScene(){
    _computeNorm();
    _buildGround();

    /* 노드 높이 기둥 (전위 시각화) — 각 컴포넌트 포트 위치 */
    App.State.components.forEach(function(c){
      if(c.type===TYPE.JUNCTION_3||c.type===TYPE.JUNCTION_4){
        _nodePillar(_compCenter(c)); return;
      }
      App.Geo.getCompPorts(c).forEach(function(p){_nodePillar(_portPos(c,p));});
    });

    /* 도선 */
    App.State.wires.forEach(_buildWire);

    /* 소자 */
    App.State.components.forEach(function(c){
      switch(c.type){
        case TYPE.DC_SOURCE: _buildPump(c); break;
        case TYPE.RESISTOR:  _buildResistor(c); break;
        case TYPE.CAPACITOR: _buildCapacitor(c); break;
        case TYPE.INDUCTOR:  _buildInductor(c); break;
        case TYPE.JUNCTION_3:
        case TYPE.JUNCTION_4: _buildJunction(c); break;
      }
      /* 소자 이름·값 라벨 (분기점은 특성값이 없으므로 제외) */
      if(c.type!==TYPE.JUNCTION_3 && c.type!==TYPE.JUNCTION_4){
        _makeLabel(c, _compCenter(c));
      }
    });

    /* 물 입자 메쉬 풀 생성 */
    _sharedGeo=new THREE.SphereGeometry(0.16,8,8);
    var pmat=new THREE.MeshStandardMaterial({color:0x9fd8ff,emissive:0x1a5fa0,emissiveIntensity:0.6,roughness:0.2});
    _lanes.forEach(function(lane){
      lane.parts.forEach(function(p){
        var m=new THREE.Mesh(_sharedGeo,pmat);
        m.visible=false;
        _scene.add(m);
        _particlePool.push({mesh:m,lane:lane,part:p});
      });
    });

    _built=true;
  }

  /* ════════ 업데이트 ════════ */
  /* 시변 전위 → 높이 갱신 (#3): 도선 레인의 점 y좌표와 수로 튜브를 v(t)로 갱신 */
  function _updateDynamicHeights(t){
    if(!(_branchModel&&_branchModel.byNode)) return;  // 노드 모델 없으면 정적 유지
    _lanes.forEach(function(lane){
      var d=lane.dyn; if(!d) return;
      var ya=_vToY(_portVt(d.from,d.fromPort,t));
      var yb=_vToY(_portVt(d.to,  d.toPort,  t));
      var yBend=ya+(yb-ya)*d.frac;
      /* lane.pts = [A, Bend, B] */
      lane.pts[0].y=ya;
      lane.pts[1].y=yBend;
      lane.pts[2].y=yb;
      /* 세그먼트 길이 재계산 (입자 보간 정확도 유지) */
      var total=0;
      for(var i=0;i<lane.pts.length-1;i++){ var l=lane.pts[i].distanceTo(lane.pts[i+1]); lane.seg[i]=l; total+=l; }
      lane.total=total>1e-4?total:lane.total;
      /* 수로 튜브 재배치 */
      if(d.tube1) _updateTube(d.tube1, lane.pts[0], lane.pts[1], CH_W*0.5);
      if(d.tube2) _updateTube(d.tube2, lane.pts[1], lane.pts[2], CH_W*0.5);
      if(d.bendMesh) d.bendMesh.position.y=yBend;
    });
    /* 저항 물레방아 낙차 시변 갱신 (#3): R 양단 v(t)로 hi/lo·휠·낙차튜브 높이 갱신 */
    _wheels.forEach(function(w){
      if(!w.pHi) return;
      var yHi=_vToY(_portVt(w.comp,w.pHi,t));
      var yLo=_vToY(_portVt(w.comp,w.pLo,t));
      var yMid=(yHi+yLo)/2;
      w.grp.position.y=yMid;
      if(w.rotor){ w.rotor._py=yMid; }
      var hi=new THREE.Vector3(w.cx,yHi,w.cz);
      var lo=new THREE.Vector3(w.cx,yLo,w.cz);
      var top=new THREE.Vector3(w.cx,yHi,w.cz);  // 휠 상단 연결
      var bot=new THREE.Vector3(w.cx,yLo,w.cz);
      var mid=new THREE.Vector3(w.cx,yMid,w.cz);
      if(w.tube1) _updateTube(w.tube1, hi, mid, CH_W*0.45);
      if(w.tube2) _updateTube(w.tube2, mid, lo, CH_W*0.45);
      /* 레인 점 높이 갱신: [hi, top, arc(N+1점), bot, lo] 구조.
       *   arc 는 휠 중심(yMid) 둘레 좌측 외주(90°→270°)를 따라 재배치. */
      var L=w.lane;
      if(L && L.isWheelLane && L.dynR){
        var rimR=L.dynR.rimR||((w.wheelR||1.3)*0.96);
        var arcN=L.dynR.arcN||10;
        var pts=L.pts;
        var nP=pts.length;            // 2 + (arcN+1) + 2
        pts[0].y=yHi;                 // hi
        pts[1].y=yHi;                 // top (휠 상단 진입)
        var aStart=Math.PI/2, aEnd=Math.PI*1.5;
        for(var ai=0;ai<=arcN;ai++){
          var aa=aStart+(aEnd-aStart)*(ai/arcN);
          var p=pts[2+ai];
          p.x=w.cx+Math.cos(aa)*rimR;
          p.y=yMid+Math.sin(aa)*rimR;
          p.z=w.cz;
        }
        pts[nP-2].y=yLo;              // bot
        pts[nP-1].y=yLo;              // lo
        var tot=0; for(var i=0;i<nP-1;i++){var l=pts[i].distanceTo(pts[i+1]);L.seg[i]=l;tot+=l;}
        L.total=tot>1e-4?tot:L.total;
      } else if(L && L.pts.length>=5){
        L.pts[0].y=yHi; L.pts[1].y=yMid; L.pts[2].y=yMid;
        L.pts[3].y=yMid; L.pts[4].y=yLo;
        var tot2=0; for(var j=0;j<L.pts.length-1;j++){var l2=L.pts[j].distanceTo(L.pts[j+1]);L.seg[j]=l2;tot2+=l2;}
        L.total=tot2>1e-4?tot2:L.total;
      }
    });
  }

  function _updateFrame(dt){
    var t=_physT();              // 가속된 물리시간(초)

    /* 시변 전위 → 높이 갱신 (#3): 노드 v(t)에 따라 도선 레인·수로 높이를 매 프레임 갱신.
     *   정지(초기) 상태에서는 t=0 전위로 표시. */
    _updateDynamicHeights(_playing?t:0);

    /* 물레방아 — 각속도 ∝ 순간전력 i(t)²·R (각자의 가지 전류, #2 수정) */
    var maxPpeak=1e-9;
    _wheels.forEach(function(w){maxPpeak=Math.max(maxPpeak,w.Ppeak);});
    _wheels.forEach(function(w){
      var iNow=_playing?_branchCurrentModel(w.cur,t):0;   // 절대 전류(A)
      var pNow=(iNow*iNow*w.R)/maxPpeak;                  // 0~1 정규화 순간전력
      var targetOmega=_playing?_clamp(pNow,0,1)*WHEEL_OMEGA_MAX:0;
      var Rnorm=_clamp((w.comp.value||0)/(Math.max(_totR(),1)),0,1);
      var k=_lerp(6.0,2.0,Rnorm);                         // R 클수록 뻑뻑(느린 수렴)
      w.rotor.omega+=(targetOmega-w.rotor.omega)*_clamp(k*dt,0,1);
      w.rotor.angle+=w.rotor.omega*dt;
      w.grp.rotation.z=w.rotor.angle;
      w.glow.material.opacity=_playing?_clamp(pNow*0.55,0,0.55):0;

      /* 물 튀김: 휠이 도는 속도에 비례해 하단(물이 떨어지는 지점)에서 물방울 분출 */
      if(w.splash){
        var spin=Math.abs(w.rotor.omega)/WHEEL_OMEGA_MAX;   // 0~1
        if(_playing && spin>0.04){
          w.splashTimer-=dt;
          if(w.splashTimer<=0){
            w.splashTimer=_lerp(0.16,0.04,spin);            // 빠를수록 자주
            var botPos=new THREE.Vector3(w.grp.position.x, w.grp.position.y - (w.wheelR||1.3)*0.92, w.grp.position.z);
            _spawnSplash(w.splash, botPos, spin);
          }
        }
        _updateSplash(w.splash, dt);
      }
    });

    /* 펌프 임펠러 + 댐 */
    _dynamics.forEach(function(d){
      if(d.kind==='pump'){
        var ip=_playing?_branchCurrentModel(d.cur,t):0;
        var trp=_clamp(Math.abs(ip)/_maxI,0,1);
        /* 역기전력이면 펌프가 물에 떠밀려 거꾸로 회전 */
        var spin=d.backEMF?-1:1;
        var targetO=trp*PUMP_OMEGA_MAX*spin;
        d.rotor.omega+=(targetO-d.rotor.omega)*_clamp(7.0*dt,0,1);
        d.rotor.angle+=d.rotor.omega*dt;
        d.grp.rotation.y=d.rotor.angle;
      } else if(d.kind==='cap'){
        /* 막 변위 = 충전량 Q(t) ∝ (1 − i_C(t)/i_C0). 충전될수록 막이 볼록하게 부푼다. */
        var charge=0;
        if(_playing && d.cur && Math.abs(d.cur.i0)>1e-15){
          var iC=_branchCurrentModel(d.cur,t);
          charge=1-Math.abs(iC)/Math.abs(d.cur.i0);
        }
        charge=_clamp(charge,0,1);
        if(d.memb){
          /* 막을 흐름축(x)으로 볼록하게: 기본 두께 + 충전량에 비례한 부풀음 */
          var bulge=d.baseScaleX + charge*d.maxBulge;
          d.memb.scale.x=bulge;
          /* 충전될수록 붉게(긴장) — emissive 강조 */
          if(d.memb.material) d.memb.material.emissiveIntensity=0.25+charge*0.5;
        }
      }
    });

    /* 물 입자(전자) 이동 — 속력 ∝ 현재 전류 i(t), 시간 스케일과 무관 (#3)
     *   전류 i(t)는 물리시간 t로 계산하되, 이동량은 벽시계 dt로 적분한다.
     *   따라서 시뮬레이션 시간이 느리게 흘러도 같은 전류면 같은 속력으로 흐른다. */
    _particlePool.forEach(function(pp){
      var lane=pp.lane, p=pp.part;
      var iNow=0;
      if(_playing){
        iNow=_branchCurrent(lane,t);                       // 절대 전류(A)
        var norm=(_maxI>1e-15)?(iNow/_maxI):0;             // 전류 정규화 (속력 비례)
        var spd=FLOW_SPEED*norm;
        p.s+=lane.dir*spd*dt;                              // 벽시계 dt 사용 (시간 스케일 무관)
      }
      var pos=_lanePoint(lane,p.s);
      pp.mesh.position.copy(pos);
      var vis=(!_playing)|| (Math.abs(iNow)/_maxI>0.003);
      pp.mesh.visible=vis;
    });

    _updateLabels();
  }

  /* 전류모델 m={i0,iinf,tau} 에서 시각 t의 전류(A) — _branchCurrent의 comp버전 */
  function _branchCurrentModel(m,t){
    if(!m) return 0;
    if(t<=0) return m.i0;
    return m.iinf + (m.i0-m.iinf)*Math.exp(-t/Math.max(m.tau,1e-12));
  }

  /* ════════ 소자 라벨 (캔버스 텍스처 빌보드) ════════
   *   소자 이름(있으면)과 특성값/측정값을 항상 카메라를 향하는 스프라이트로 표시. */
  function _fmtVal(c){
    var sr=App.State.solverResult;
    var I=(sr&&sr.branchCurrents&&sr.branchCurrents[c.id]);
    var V=(sr&&sr.componentVoltages&&sr.componentVoltages[c.id]);
    function siCur(a){ if(a==null)return''; var x=Math.abs(a);
      if(x<1e-6)return (a*1e9).toFixed(1)+'nA'; if(x<1e-3)return (a*1e6).toFixed(1)+'µA';
      if(x<1)return (a*1e3).toFixed(1)+'mA'; return a.toFixed(2)+'A'; }
    switch(c.type){
      case TYPE.DC_SOURCE: return (c.value||0)+'V';
      case TYPE.RESISTOR:  return (c.value||0)+'Ω';
      case TYPE.CAPACITOR: { var uf=(c.value||0)*1e6; return (uf>=1?uf.toFixed(uf<10?1:0):uf.toFixed(2))+'µF'; }
      case TYPE.INDUCTOR:  { var mh=(c.value||0)*1e3; return (mh>=1?mh.toFixed(mh<10?1:0):mh.toFixed(2))+'mH'; }
      case TYPE.JUNCTION_3: return '3-way';
      case TYPE.JUNCTION_4: return '十 4-way';
    }
    return '';
  }
  function _typeKr(c){
    return ({DC_SOURCE:'전원',RESISTOR:'저항',CAPACITOR:'축전기',
             INDUCTOR:'인덕터',JUNCTION_3:'분기',JUNCTION_4:'분기'})[c.type]||'';
  }
  /* 실시간 물리량 포맷 (#2) — 저항:소비전력, 축전기:전하량, 인덕터:자속쇄교수 NΦ, 전원:공급/흡수전력 */
  function _fmtMetric(c, t){
    var bm=_branchModel;
    var m=(bm&&bm.byComp)?bm.byComp[c.id]:null;
    /* 가지 전류 i(t) */
    function iAt(){ if(!m) return 0; return t<=0?m.i0 : m.iinf+(m.i0-m.iinf)*Math.exp(-t/Math.max(m.tau,1e-12)); }
    if(c.type===TYPE.DC_SOURCE){
      /* 전원 전력 P=V·I. 공급(전류 −극→+극)이면 "공급", 흡수(역기전력)면 "충전" 표시 */
      var i=Math.abs(iAt()), V=Math.abs(c.value||0);
      var P=i*V;
      var x=Math.abs(P);
      var s = x<1e-3?(P*1e6).toFixed(1)+'µW' : x<1?(P*1e3).toFixed(1)+'mW' : P.toFixed(2)+'W';
      /* 역기전력 여부: s0/sinf 부호와 극성 비교 */
      var label='공급';
      if(m){
        var sSrc=(Math.abs(m.s0||0)>=Math.abs(m.sinf||0))?(m.s0||0):(m.sinf||0);
        var ports=App.Geo.getCompPorts(c);
        var v0=_portV(c,ports[0]), v1=_portV(c,ports[1]);
        var plusIsPort0=(v0>=v1);
        var emfSign=plusIsPort0?-1:+1;
        if(Math.abs(sSrc)>1e-12 && (sSrc>0?1:-1)!==emfSign) label='충전';  // 역기전력=흡수
      }
      return (label==='충전'?'⮇ 충전 ':'⮅ 공급 ')+s;
    }
    if(c.type===TYPE.RESISTOR){
      var i=iAt(), R=Math.max(c.value||0,1e-12);
      var P=i*i*R;   // 순간 소비전력 P=I²R
      var x=Math.abs(P);
      var s = x<1e-3?(P*1e6).toFixed(1)+'µW' : x<1?(P*1e3).toFixed(1)+'mW' : P.toFixed(2)+'W';
      return 'P = '+s;
    }
    if(c.type===TYPE.CAPACITOR){
      /* 충전 전하 Q(t) = C·V_C(t). V_C: 0→V_inf 로 상승.
       *   여기선 전하량을 직접: Q(t)=Q_inf·(1−e^{−t/τ}), Q_inf=C·V_inf.
       *   i_C=dQ/dt → Q(t)=∫i dt = Q_inf − τ·i(t)... 간단히 V_C 기반으로 계산. */
      var C=c.value||1e-6;
      var Vinf=_capVinf(c);
      var Qinf=C*Vinf;
      var Qt=(t<=0)?0:Qinf*(1-Math.exp(-t/Math.max(m?m.tau:1,1e-12)));
      var qx=Math.abs(Qt);
      var qs = qx<1e-9?(Qt*1e12).toFixed(1)+'pC' : qx<1e-6?(Qt*1e9).toFixed(1)+'nC'
             : qx<1e-3?(Qt*1e6).toFixed(1)+'µC' : qx<1?(Qt*1e3).toFixed(2)+'mC' : Qt.toFixed(3)+'C';
      return 'Q = '+qs;
    }
    if(c.type===TYPE.INDUCTOR){
      /* 자속쇄교수 λ = N·Φ = L·i(t) (인덕턴스 정의상 Lᵢ = NΦ) */
      var L=c.value||1e-3, i2=iAt();
      var lam=L*i2;
      var lx=Math.abs(lam);
      var ls = lx<1e-6?(lam*1e9).toFixed(1)+'nWb' : lx<1e-3?(lam*1e6).toFixed(1)+'µWb'
             : lx<1?(lam*1e3).toFixed(2)+'mWb' : lam.toFixed(3)+'Wb';
      return 'NΦ = '+ls;
    }
    return '';
  }
  /* 축전기 정상상태 전압 (전하량 계산용) */
  function _capVinf(c){
    var bm=_branchModel;
    if(bm&&bm.byNode&&bm.compNodes&&bm.compNodes[c.id]){
      var nn=bm.compNodes[c.id];
      var v0n=bm.byNode[nn[0]], v1n=bm.byNode[nn[1]];
      if(v0n&&v1n) return Math.abs(v0n.vinf - v1n.vinf);
    }
    var sr=App.State.solverResult;
    return Math.abs((sr&&sr.componentVoltages&&sr.componentVoltages[c.id])||0);
  }
  function _makeLabel(c, pos){
    var name=(c.label&&c.label.trim())?c.label.trim():_typeKr(c);
    var val=_fmtVal(c);
    /* 실시간 물리량을 갖는 소자인지 */
    var hasMetric=(c.type===TYPE.RESISTOR||c.type===TYPE.CAPACITOR||c.type===TYPE.INDUCTOR||c.type===TYPE.DC_SOURCE);
    var cv=document.createElement('canvas');
    var pad=14, fs1=40, fs2=36, fs3=34;   // 폰트 키움
    var lines = hasMetric?3:2;
    var W=320, H=pad*2 + fs1 + fs2 + (hasMetric?fs3+8:0) + 10;
    cv.width=W; cv.height=H;
    var ctx=cv.getContext('2d');
    var rec={sprite:null, tex:null, ctx:ctx, cv:cv, comp:c, name:name, val:val,
             hasMetric:hasMetric, fs1:fs1, fs2:fs2, fs3:fs3, pad:pad, last:null};
    /* 초기 그리기 */
    _drawCompLabel(rec, 0);

    var tex=new THREE.CanvasTexture(cv);
    tex.minFilter=THREE.LinearFilter;
    rec.tex=tex;
    var mat=new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false,depthWrite:false});
    var sp=new THREE.Sprite(mat);
    var sc=0.0095; sp.scale.set(W*sc, H*sc, 1);
    sp.position.set(pos.x, pos.y+1.5, pos.z);
    sp.renderOrder=999;
    sp.visible=_labelsVisible;
    rec.sprite=sp;
    _scene.add(sp);
    _labelSprites.push({sprite:sp, tex:tex, baseY:pos.y+1.5, rec:rec});
  }
  function _drawCompLabel(rec, t){
    var metric = rec.hasMetric?_fmtMetric(rec.comp,t):'';
    var key=rec.name+'|'+rec.val+'|'+metric;
    if(rec.last===key) return;
    rec.last=key;
    var ctx=rec.ctx, W=rec.cv.width, H=rec.cv.height, pad=rec.pad;
    ctx.clearRect(0,0,W,H);
    /* 지면 톤 라벨 — 흰 칩 + 검정 글자 */
    var F=App.SN.TOKENS.font;
    ctx.fillStyle='rgba(255,255,255,0.94)';
    _roundRect(ctx,0,0,W,H,14); ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.45)'; ctx.lineWidth=2.5;
    _roundRect(ctx,1.5,1.5,W-3,H-3,13); ctx.stroke();
    ctx.textAlign='center'; ctx.textBaseline='top';
    /* 이름 */
    ctx.font='700 '+rec.fs1+'px '+F; ctx.fillStyle='#111318';
    ctx.fillText(rec.name, W/2, pad);
    /* 특성값 */
    ctx.font='italic '+rec.fs2+'px '+F; ctx.fillStyle='#3d4453';
    ctx.fillText(rec.val, W/2, pad+rec.fs1+4);
    /* 실시간 물리량 (#2) — 강조 */
    if(rec.hasMetric){
      ctx.font='700 italic '+rec.fs3+'px '+F; ctx.fillStyle='#b45309';
      ctx.fillText(metric, W/2, pad+rec.fs1+rec.fs2+10);
    }
    if(rec.tex) rec.tex.needsUpdate=true;
  }
  function _roundRect(ctx,x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
  }
  /* 전류 포맷 (짧게) */
  function _fmtCurShort(A){
    var x=Math.abs(A);
    if(x<1e-9) return '0';
    if(x<1e-6) return (A*1e9).toFixed(0)+'nA';
    if(x<1e-3) return (A*1e6).toFixed(1)+'µA';
    if(x<1)    return (A*1e3).toFixed(1)+'mA';
    return A.toFixed(2)+'A';
  }
  /* 전압 포맷 (짧게) */
  function _fmtVoltShort(V){
    var x=Math.abs(V);
    if(x<1e-3) return (V*1e3).toFixed(1)+'mV';
    if(x<100)  return V.toFixed(2)+'V';
    return V.toFixed(1)+'V';
  }
  /* 도선 전류·전위 라벨 생성 (캔버스 텍스처, 전류는 매 프레임 갱신) — #1·#3·#4 */
  function _makeWireLabel(w, pos, model, iss, vPot, ends){
    var cv=document.createElement('canvas');
    cv.width=300; cv.height=120;       // 고해상도 (#1 가독성)
    var ctx=cv.getContext('2d');
    var tex=new THREE.CanvasTexture(cv);
    tex.minFilter=THREE.LinearFilter;
    var mat=new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false,depthWrite:false});
    var sp=new THREE.Sprite(mat);
    sp.scale.set(300*0.0072, 120*0.0072, 1);  // 월드 크기 약간 키움
    sp.position.set(pos.x, pos.y+0.85, pos.z);
    sp.renderOrder=1000;
    sp.visible=_labelsVisible;
    _scene.add(sp);
    var rec={sprite:sp, tex:tex, ctx:ctx, cv:cv, model:model, iss:iss, vPot:(vPot||0),
             ends:ends||null, last:null};
    _wireLabels.push(rec);
    _drawWireLabel(rec, model?Math.abs(model.iinf):iss);  // 초기(정지) 표시
  }
  function _drawWireLabel(rec, A){
    var iTxt='I = '+_fmtCurShort(A);
    var vTxt='V = '+_fmtVoltShort(rec.vPot);
    var key=iTxt+'|'+vTxt;
    if(rec.last===key) return;     // 변화 없으면 스킵(텍스처 재업로드 절약)
    rec.last=key;
    var ctx=rec.ctx, W=rec.cv.width, H=rec.cv.height;
    ctx.clearRect(0,0,W,H);
    var F2=App.SN.TOKENS.font;
    ctx.fillStyle='rgba(255,255,255,0.94)';
    _roundRect(ctx,0,0,W,H,16); ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.45)'; ctx.lineWidth=3;
    _roundRect(ctx,1.5,1.5,W-3,H-3,15); ctx.stroke();
    ctx.textAlign='center'; ctx.textBaseline='middle';
    /* 전류 I (위) — 전위 V 와 색으로 구분 */
    ctx.font='700 italic 44px '+F2; ctx.fillStyle='#b45309';
    ctx.fillText(iTxt, W/2, H*0.30);
    /* 전위 V (아래 — 높이=전압 강조) */
    ctx.font='700 italic 42px '+F2; ctx.fillStyle='#0e7490';
    ctx.fillText(vTxt, W/2, H*0.72);
    rec.tex.needsUpdate=true;
  }
  function _updateLabels(){
    /* 도선 전류 I(t)·전위 V(t) 라벨 갱신 (#3·#4) */
    var t=_physT();
    var tt=_playing?t:0;
    _wireLabels.forEach(function(rec){
      var A;
      if(_playing){
        A=rec.model?_branchCurrentModel(rec.model,t):rec.iss;
      } else {
        A=rec.model?rec.model.i0:rec.iss;   // 정지(초기) 상태
      }
      /* 시변 전위: 양 끝 포트 전위 평균을 최저전위 기준 0V로 환산 */
      if(rec.ends){
        var vA=_portVt(rec.ends.from,rec.ends.fromPort,tt);
        var vB=_portVt(rec.ends.to,rec.ends.toPort,tt);
        rec.vPot=(vA+vB)/2 - _vMin;
      }
      _drawWireLabel(rec, Math.abs(A));
    });
    /* 소자 실시간 물리량 라벨 갱신 (#2) — 저항 전력·축전기 전하·인덕터 자속쇄교수 */
    _labelSprites.forEach(function(L){
      if(L.rec && L.rec.hasMetric) _drawCompLabel(L.rec, tt);
    });
  }

  /* ════════ 카메라 ════════ */
  function _applyCamera(){
    var x=_cam.tx+_cam.dist*Math.cos(_cam.el)*Math.cos(_cam.az);
    var y=_cam.ty+_cam.dist*Math.sin(_cam.el);
    var z=_cam.tz+_cam.dist*Math.cos(_cam.el)*Math.sin(_cam.az);
    _camera.position.set(x,y,z);
    _camera.lookAt(_cam.tx,_cam.ty,_cam.tz);
  }

  /* ════════ 루프 ════════ */
  function _loop(ts){
    var dt=Math.min((ts-(_lastTs||ts))/1000,0.05);
    _lastTs=ts;
    if(_playing) _simTime+=dt;
    _updateFrame(dt);
    _applyCamera();
    _renderer.render(_scene,_camera);
    _updateControls();
    _raf=requestAnimationFrame(_loop);
  }

  /* ════════ 입력(카메라 제어) ════════
   *   PC : 휠=줌, 좌클릭 드래그=위치이동(pan), 우클릭 드래그=시점각도(orbit)
   *   모바일: 핀치=줌, 1손가락 스와이프=위치이동(pan), 2손가락 스와이프=시점각도(orbit)
   *   pan 은 카메라 우(right)·상(up) 벡터 평면에서 타겟점(tx,ty,tz)을 이동. */
  function _camPan(dxPix, dyPix){
    /* 화면 픽셀 이동량 → 월드 이동량. 거리에 비례해 자연스러운 속도. */
    var scale=_cam.dist*0.0016;
    /* forward 방향(카메라가 바라보는 방향, 타겟 기준 단위벡터) */
    var ce=Math.cos(_cam.el), se=Math.sin(_cam.el);
    var ca=Math.cos(_cam.az), sa=Math.sin(_cam.az);
    var fx=-ce*ca, fy=-se, fz=-ce*sa;
    /* right = normalize(cross(forward, worldUp)), worldUp=(0,1,0)
     *   cross(f,(0,1,0)) = (fz, 0, -fx) */
    var rx=fz, ry=0, rz=-fx;
    var rl=Math.hypot(rx,ry,rz)||1; rx/=rl; ry/=rl; rz/=rl;
    /* camUp = cross(right, forward) */
    var ux=ry*fz - rz*fy;
    var uy=rz*fx - rx*fz;
    var uz=rx*fy - ry*fx;
    var ul=Math.hypot(ux,uy,uz)||1; ux/=ul; uy/=ul; uz/=ul;
    /* 끄는 방향으로 장면이 이동(타겟이 같은 방향으로 이동) */
    _cam.tx += (rx*dxPix - ux*dyPix)*scale;
    _cam.ty += (ry*dxPix - uy*dyPix)*scale;
    _cam.tz += (rz*dxPix - uz*dyPix)*scale;
  }
  function _camOrbit(dxPix, dyPix){
    _cam.az -= dxPix*0.008;
    _cam.el = _clamp(_cam.el + dyPix*0.006, 0.08, 1.45);
  }
  function _camZoom(factor){
    _cam.dist=_clamp(_cam.dist*factor, 8, 120);
  }

  function _bindOrbit(){
    /* ── 마우스(PC) ── */
    var mDown=false, mBtn=0, lx=0, ly=0;
    function pd(e){
      /* 터치는 별도 핸들러(아래)에서 처리 — pointerType==='touch' 무시 */
      if(e.pointerType==='touch') return;
      mDown=true; mBtn=e.button; lx=e.clientX; ly=e.clientY;
      e.stopPropagation();
    }
    function pm(e){
      if(e.pointerType==='touch') return;
      if(!mDown) return;
      var dx=e.clientX-lx, dy=e.clientY-ly;
      if(mBtn===2){           /* 우클릭 드래그 → 시점각도 */
        _camOrbit(dx,dy);
      } else {                /* 좌클릭 드래그 → 위치이동 */
        _camPan(dx,dy);
      }
      lx=e.clientX; ly=e.clientY; e.stopPropagation();
    }
    function pu(e){ if(e&&e.pointerType==='touch') return; mDown=false; }
    function wh(e){ _camZoom(e.deltaY>0?1.08:0.92); e.preventDefault(); e.stopPropagation(); }
    /* 우클릭 메뉴 차단(우클릭 드래그를 시점각도로 쓰므로) */
    function ctx(e){ e.preventDefault(); return false; }

    /* ── 터치(모바일) ── */
    var touches={};        // id → {x,y}
    var pinchPrevDist=0, twoPrevMidX=0, twoPrevMidY=0;
    function activeTouchIds(){ return Object.keys(touches); }
    function td(e){
      if(e.pointerType!=='touch') return;
      touches[e.pointerId]={x:e.clientX,y:e.clientY};
      var ids=activeTouchIds();
      if(ids.length===2){
        var a=touches[ids[0]], b=touches[ids[1]];
        pinchPrevDist=Math.hypot(a.x-b.x,a.y-b.y);
        twoPrevMidX=(a.x+b.x)/2; twoPrevMidY=(a.y+b.y)/2;
      }
      e.stopPropagation();
    }
    function tm(e){
      if(e.pointerType!=='touch') return;
      if(!touches[e.pointerId]) return;
      var prev=touches[e.pointerId];
      var dx=e.clientX-prev.x, dy=e.clientY-prev.y;
      touches[e.pointerId]={x:e.clientX,y:e.clientY};
      var ids=activeTouchIds();
      if(ids.length===1){
        /* 1손가락 스와이프 → 위치이동(pan) */
        _camPan(dx,dy);
      } else if(ids.length>=2){
        var a=touches[ids[0]], b=touches[ids[1]];
        var dist=Math.hypot(a.x-b.x,a.y-b.y);
        var midX=(a.x+b.x)/2, midY=(a.y+b.y)/2;
        /* 핀치 줌 */
        if(pinchPrevDist>0){
          var ratio=pinchPrevDist/dist;   // 벌리면 dist↑ → ratio<1 → 확대
          _camZoom(_clamp(ratio,0.5,2));
        }
        /* 2손가락 스와이프(중심 이동) → 시점각도(orbit) */
        _camOrbit(midX-twoPrevMidX, midY-twoPrevMidY);
        pinchPrevDist=dist; twoPrevMidX=midX; twoPrevMidY=midY;
      }
      e.stopPropagation();
    }
    function tu(e){
      if(e.pointerType!=='touch') return;
      delete touches[e.pointerId];
      var ids=activeTouchIds();
      if(ids.length===2){
        var a=touches[ids[0]], b=touches[ids[1]];
        pinchPrevDist=Math.hypot(a.x-b.x,a.y-b.y);
        twoPrevMidX=(a.x+b.x)/2; twoPrevMidY=(a.y+b.y)/2;
      } else {
        pinchPrevDist=0;
      }
    }

    _cv.addEventListener('pointerdown',pd);
    window.addEventListener('pointermove',pm);
    window.addEventListener('pointerup',pu);
    _cv.addEventListener('wheel',wh,{passive:false});
    _cv.addEventListener('contextmenu',ctx);
    _cv.addEventListener('pointerdown',td);
    window.addEventListener('pointermove',tm);
    window.addEventListener('pointerup',tu);
    window.addEventListener('pointercancel',tu);
    _orbit={pd:pd,pm:pm,pu:pu,wh:wh,ctx:ctx,td:td,tm:tm,tu:tu};
  }
  function _unbindOrbit(){
    if(!_orbit)return;
    _cv.removeEventListener('pointerdown',_orbit.pd);
    window.removeEventListener('pointermove',_orbit.pm);
    window.removeEventListener('pointerup',_orbit.pu);
    _cv.removeEventListener('wheel',_orbit.wh);
    _cv.removeEventListener('contextmenu',_orbit.ctx);
    _cv.removeEventListener('pointerdown',_orbit.td);
    window.removeEventListener('pointermove',_orbit.tm);
    window.removeEventListener('pointerup',_orbit.tu);
    window.removeEventListener('pointercancel',_orbit.tu);
    _orbit=null;
  }

  /* ════════ 컨트롤 UI ════════ */
  function _buildControls(){
    var ex=document.getElementById('analogy-ctrl'); if(ex)ex.remove();
    var div=document.createElement('div');
    div.id='analogy-ctrl';
    div.style.cssText='position:absolute;bottom:72px;right:12px;z-index:20;'+
      'background:var(--bg-glass);border:1px solid var(--border-base);border-radius:10px;'+
      'padding:10px;backdrop-filter:blur(10px);box-shadow:var(--shadow-panel);'+
      'display:flex;flex-direction:row;gap:8px;align-items:center;';

    /* ── 시작/정지 버튼 (기호만) ── */
    var btn=document.createElement('button');
    btn.id='analogy-play-btn';
    btn.title='시뮬레이션 시작/정지';
    btn.style.cssText='width:44px;height:44px;border-radius:8px;border:1px solid;font-size:18px;'+
      'font-family:var(--font);cursor:pointer;font-weight:700;transition:all 0.15s;'+
      'display:flex;align-items:center;justify-content:center;';
    btn.addEventListener('click',function(){ _playing?_stop():_play(); });
    btn.addEventListener('pointerdown',function(e){e.stopPropagation();});
    div.appendChild(btn);

    /* ── 특성값 표기/숨기 토글 버튼 (기호만: Ω) ── */
    var lblBtn=document.createElement('button');
    lblBtn.id='analogy-label-btn';
    lblBtn.title='소자 특성값·전류·전위 라벨 표시/숨김';
    lblBtn.textContent='Ω';
    lblBtn.style.cssText='width:44px;height:44px;border-radius:8px;border:1px solid;font-size:18px;'+
      'font-family:var(--font);cursor:pointer;font-weight:700;transition:all 0.15s;'+
      'display:flex;align-items:center;justify-content:center;';
    lblBtn.addEventListener('click',function(){ _toggleLabels(); });
    lblBtn.addEventListener('pointerdown',function(e){e.stopPropagation();});
    div.appendChild(lblBtn);

    document.getElementById('canvas-container').appendChild(div);

    /* ── 우측 상단 시간·τ HUD (크게) ── (#2) ── */
    var ex2=document.getElementById('analogy-hud'); if(ex2)ex2.remove();
    var hud=document.createElement('div');
    hud.id='analogy-hud';
    hud.style.cssText='position:absolute;top:14px;right:14px;z-index:20;'+
      'background:var(--bg-glass);border:1px solid var(--border-base);border-radius:12px;'+
      'padding:12px 18px;backdrop-filter:blur(10px);box-shadow:var(--shadow-panel);'+
      'font-family:var(--font);text-align:right;min-width:180px;pointer-events:none;';
    var hudTitle=document.createElement('div');
    hudTitle.style.cssText='font-size:10px;color:var(--text-title);letter-spacing:2px;font-weight:700;text-transform:uppercase;margin-bottom:4px';
    hudTitle.textContent='SIMULATION TIME';
    var hudTimeEl=document.createElement('div');
    hudTimeEl.id='analogy-hud-t';
    hudTimeEl.style.cssText='font-size:26px;color:var(--text-base);font-weight:700;line-height:1.1';
    hudTimeEl.textContent='t = 0 s';
    var hudTauEl=document.createElement('div');
    hudTauEl.id='analogy-hud-tau';
    hudTauEl.style.cssText='font-size:12px;color:var(--text-dim);margin-top:4px';
    hudTauEl.textContent='τ = —';
    hud.appendChild(hudTitle); hud.appendChild(hudTimeEl); hud.appendChild(hudTauEl);
    document.getElementById('canvas-container').appendChild(hud);

    _updateControls();
  }
  function _updateControls(){
    var btn=document.getElementById('analogy-play-btn');
    if(btn){
      if(_playing){
        btn.textContent='■';
        btn.style.background='#fdeaea';btn.style.borderColor='#f0c0c0';btn.style.color='#b42318';
        btn.title='정지 (초기화)';
      } else {
        btn.textContent='▶';
        btn.style.background='#e6f4ec';btn.style.borderColor='#a8d5bd';btn.style.color='#128a53';
        btn.title='시뮬레이션 시작';
      }
    }
    /* 특성값 토글 버튼 상태 */
    var lblBtn=document.getElementById('analogy-label-btn');
    if(lblBtn){
      if(_labelsVisible){
        lblBtn.style.background='#e3edfd';lblBtn.style.borderColor='#2563eb';lblBtn.style.color='#1d4ed8';
      } else {
        lblBtn.style.background='#ffffff';lblBtn.style.borderColor='#c9ced6';lblBtn.style.color='#8b93a1';
      }
    }
    /* HUD 시간·τ 갱신 (#2) */
    var hT=document.getElementById('analogy-hud-t');
    var hTau=document.getElementById('analogy-hud-tau');
    if(hT){
      var tp=_physT(), label;
      if(_domTau>1e-12){
        if(tp<1e-3)      label=(tp*1e6).toFixed(1)+' µs';
        else if(tp<1)    label=(tp*1e3).toFixed(2)+' ms';
        else             label=tp.toFixed(3)+' s';
      } else {
        label=_simTime.toFixed(2)+' s';
      }
      hT.textContent='t = '+label;
    }
    if(hTau) hTau.textContent='τ = '+(_domTau>1e-12?_fmtTau(_domTau):'—');
  }
  function _fmtTau(tau){
    if(tau<1e-3) return (tau*1e6).toFixed(1)+'µs';
    if(tau<1)    return (tau*1e3).toFixed(2)+'ms';
    return tau.toFixed(3)+'s';
  }
  /* 라벨(소자 특성값·도선 전류·전위) 표시/숨김 토글 (#5) */
  function _toggleLabels(){
    _labelsVisible=!_labelsVisible;
    _labelSprites.forEach(function(L){ if(L.sprite)L.sprite.visible=_labelsVisible; });
    _wireLabels.forEach(function(L){ if(L.sprite)L.sprite.visible=_labelsVisible; });
    _updateControls();
  }
  function _showHint(msg){
    if(_hintEl)_hintEl.remove();
    _hintEl=document.createElement('div');
    _hintEl.style.cssText='position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);'+
      'z-index:15;color:var(--text-base);font-size:13px;font-family:var(--font);text-align:center;'+
      'background:var(--bg-glass);padding:14px 20px;border-radius:10px;'+
      'border:1px solid var(--border-base);box-shadow:var(--shadow-panel);pointer-events:none';
    _hintEl.textContent=msg;
    document.getElementById('canvas-container').appendChild(_hintEl);
  }

  /* ════════ play / stop ════════ */
  function _play(){
    var sr=App.State.solverResult;
    if(!sr||!sr.valid){ showErrorToast&&showErrorToast('회로를 완성해야 시뮬레이션할 수 있습니다.'); return; }
    _playing=true; _simTime=0; _lastTs=0;
    _updateControls();
  }
  function _stop(){
    _playing=false; _simTime=0;
    /* 회전체·레인 초기화 */
    _wheels.forEach(function(w){w.rotor.angle=0;w.rotor.omega=0;if(w.rotor.body)w.rotor.body.angularVelocity.set(0,0,0);w.grp.rotation.z=0;w.glow.material.opacity=0;
      if(w.splash){w.splash.drops.forEach(function(d){d.life=0;d.mesh.visible=false;});w.splashTimer=0;}});
    _dynamics.forEach(function(d){
      if(d.kind==='pump'){d.rotor.angle=0;d.rotor.omega=0;if(d.rotor.body)d.rotor.body.angularVelocity.set(0,0,0);d.grp.rotation.y=0;}
      if(d.kind==='cap'&&d.memb){d.memb.scale.x=d.baseScaleX; if(d.memb.material)d.memb.material.emissiveIntensity=0.25;}
    });
    _lanes.forEach(function(lane){
      var n=lane.parts.length;
      lane.parts.forEach(function(p,i){p.s=(i/n)*lane.total;});
    });
    _updateControls();
  }

  /* ════════ 리소스 정리 ════════ */
  function _disposeScene(){
    if(_scene){
      _scene.traverse(function(o){
        if(o.geometry&&o.geometry.dispose)o.geometry.dispose();
        if(o.material){
          var mats=Array.isArray(o.material)?o.material:[o.material];
          mats.forEach(function(m){ if(m.map&&m.map.dispose)m.map.dispose(); m.dispose&&m.dispose(); });
        }
      });
    }
    _labelSprites.forEach(function(L){ if(L.tex&&L.tex.dispose)L.tex.dispose(); });
    _labelSprites=[];
    _wireLabels.forEach(function(L){ if(L.tex&&L.tex.dispose)L.tex.dispose(); });
    _wireLabels=[];
    _lanes=[]; _wheels=[]; _dynamics=[]; _particlePool=[]; _sharedGeo=null;
    if(_world){ /* Cannon 바디 제거 */
      try{ while(_world.bodies&&_world.bodies.length) _world.removeBody(_world.bodies[0]); }catch(e){}
      _world=null;
    }
    _built=false;
  }

  /* 순수 저항 회로(동적 소자 없음)용 정적 branchModel 구성.
   *   solverResult 의 정상상태 값으로 i0=iinf, v0=vinf 를 채운다.
   *   전류·전압이 시간 불변이므로 라벨(전력 P=I²R 등)이 즉시 올바른 값을 갖는다. */
  function _buildStaticBranchModel(){
    var sr=App.State.solverResult;
    if(!sr||!sr.valid) return null;
    var comps=App.State.components;
    var byComp={}, byWire={}, byNode={}, compNodes={};
    var cn=sr.componentNodes||{};

    /* 소자별 전류(부호 포함) + 전압 */
    comps.forEach(function(c){
      var I=(sr.branchCurrents&&sr.branchCurrents[c.id]!=null)?sr.branchCurrents[c.id]:0;
      /* 부호 있는 전류 s: 포트0→포트1 전위차로 추정(저항), 그 외는 branchCurrents 부호 사용 */
      var s=I;
      if(c.type===TYPE.RESISTOR && sr.portVoltages && sr.portVoltages[c.id]){
        var ports=App.Geo.getCompPorts(c);
        var v0=sr.portVoltages[c.id][ports[0]], v1=sr.portVoltages[c.id][ports[1]];
        if(v0!=null&&v1!=null){ var R=Math.max(c.value||0,1e-12); s=(v0-v1)/R; }
      }
      byComp[c.id]={ i0:I, iinf:I, tau:1e-6, s0:s, sinf:s };
      if(cn[c.id]) compNodes[c.id]=cn[c.id];
    });

    /* 노드 전위(시간 불변) */
    if(sr.nodeVoltages){
      for(var nd in sr.nodeVoltages){
        byNode[nd]={ v0:sr.nodeVoltages[nd], vinf:sr.nodeVoltages[nd], tau:1e-6 };
      }
    }
    byNode[0]={v0:0,vinf:0,tau:1e-6};

    /* 도선 전류 (부호 포함) */
    App.State.wires.forEach(function(w){
      var si=(sr.wireSignedI&&sr.wireSignedI[w.id]!=null)?sr.wireSignedI[w.id]:0;
      var fromComp=App.State.getComponent(w.fromId);
      var toComp=App.State.getComponent(w.toId);
      var isJ=function(cc){return cc&&(cc.type===TYPE.JUNCTION_3||cc.type===TYPE.JUNCTION_4);};
      var refId=null, refIsFrom=true, refPort=null;
      if(!isJ(fromComp)&&byComp[w.fromId]){ refId=w.fromId; refIsFrom=true; refPort=w.fromPort; }
      else if(!isJ(toComp)&&byComp[w.toId]){ refId=w.toId; refIsFrom=false; refPort=w.toPort; }
      var refPortIdx=-1;
      if(refId){
        var rc2=App.State.getComponent(refId);
        refPortIdx=App.Geo.getCompPorts(rc2).indexOf(refPort);
      }
      byWire[w.id]={ i0:Math.abs(si), iinf:Math.abs(si), tau:1e-6,
                     refId:refId, refIsFrom:refIsFrom, refPortIdx:refPortIdx };
    });

    return { byComp:byComp, byWire:byWire,
             byNode:(Object.keys(byNode).length>1?byNode:null),
             compNodes:(Object.keys(compNodes).length?compNodes:null), domTau:0 };
  }

  /* ════════ 공개 API ════════ */
  function start(){
    if(typeof THREE==='undefined'){
      showErrorToast&&showErrorToast('3D 라이브러리(Three.js) 로딩에 실패했습니다. 네트워크를 확인하세요.');
      return;
    }
    _labelsVisible=true;   // 라벨 표시 상태 초기화
    _container=document.getElementById('canvas-container');
    /* 기존 2D 레이어 숨김 (몰입형 3D 뷰) */
    ['canvas-bg','canvas-main','canvas-anim'].forEach(function(id){
      var el=document.getElementById(id); if(el)el.style.visibility='hidden';
    });
    /* 전용 WebGL 캔버스 생성 */
    _cv=document.createElement('canvas');
    _cv.id='canvas-three';
    _cv.style.cssText='position:absolute;top:0;left:0;z-index:3;touch-action:none;';
    _container.appendChild(_cv);

    var W=_container.clientWidth, H=_container.clientHeight;
    _renderer=new THREE.WebGLRenderer({canvas:_cv,antialias:true,alpha:true});
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
    _renderer.setSize(W,H);

    _scene=new THREE.Scene();
    /* 안개·조명도 밝은 지면 톤으로 (소자 고유색은 그대로 유지) */
    _scene.fog=new THREE.FogExp2(0xeceef1,0.012);
    _camera=new THREE.PerspectiveCamera(48,W/H,0.1,500);

    /* 조명 */
    _scene.add(new THREE.AmbientLight(0xf2f4f7,0.85));
    var dir=new THREE.DirectionalLight(0xffffff,0.85); dir.position.set(6,14,8); _scene.add(dir);
    var dir2=new THREE.DirectionalLight(0xd8dee8,0.45); dir2.position.set(-8,6,-6); _scene.add(dir2);

    /* Cannon 물리 엔진 준비 (있으면) */
    _haveCannon=(typeof CANNON!=='undefined');
    if(_haveCannon){
      try{
        _world=new CANNON.World({gravity:new CANNON.Vec3(0,0,0)});
        _world.allowSleep=false;
      }catch(e){ _haveCannon=false; _world=null; }
    }

    /* ── 과도응답(시상수) 데이터 로드 + 시간 스케일 결정 ──
     *   TransientGraph 가 계산한 amp/τ/방향을 재사용한다(동일 수식 보장).
     *   _simSpeed: 5·τ 과도구간을 화면상 SHOW_SPAN초에 보여주도록 가속.
     *   동적 소자가 없으면 1배(부드러운 가동만). */
    _transData=null; _domTau=0; _simSpeed=1; _branchModel=null;
    try{
      if(App.TransientGraph && App.TransientGraph.getTransientData){
        var td=App.TransientGraph.getTransientData();
        if(td){ _transData=td; _domTau=td.domTau||0; _branchModel=td.branchModel||null; }
      }
    }catch(e){ _transData=null; _branchModel=null; }

    /* 동적 소자(L/C)가 없는 순수 저항 회로는 getTransientData 가 null →
     *   solverResult 로부터 시간 불변(정상상태) branchModel 을 직접 구성한다.
     *   (전류·전위가 시간에 따라 변하지 않으므로 i0=iinf, v0=vinf) */
    if(!_branchModel){
      _branchModel=_buildStaticBranchModel();
    }

    if(_domTau>1e-12){
      /* 화면상 SHOW_SPAN초 동안 물리시간 5·_domTau 가 흐르도록 */
      _simSpeed=(5*_domTau)/SHOW_SPAN;
    } else {
      _simSpeed=1;   // 정적 회로: 실시간(부드러운 가동 _staticBase 기준)
    }

    _buildScene();   // 내부에서 _computeNorm 호출 (정상상태 _maxI 계산)

    /* _maxI 보정: 과도 초기전류(i0)가 정상상태보다 클 수 있으므로
     *   모델의 모든 i0/iinf 최대값으로 갱신 → 입자 속력 정규화 일관성 확보 */
    if(_branchModel){
      var mx=_maxI;
      function scan(obj){ for(var k in obj){ var m=obj[k];
        mx=Math.max(mx,Math.abs(m.i0||0),Math.abs(m.iinf||0)); } }
      if(_branchModel.byComp) scan(_branchModel.byComp);
      if(_branchModel.byWire) scan(_branchModel.byWire);
      if(mx>_maxI) _maxI=mx;
    }

    _applyCamera();
    _bindOrbit();

    /* 리사이즈 */
    _resizeFn=function(){
      var w=_container.clientWidth,h=_container.clientHeight;
      if(_renderer){_renderer.setSize(w,h);_camera.aspect=w/h;_camera.updateProjectionMatrix();}
    };
    window.addEventListener('resize',_resizeFn);

    _buildControls();
    var sr=App.State.solverResult;
    if(!sr||!sr.valid) _showHint('회로가 완성되지 않았습니다.\n편집 모드에서 연결을 완성하세요.');

    /* 정지(초기) 상태로 렌더 시작 — 입자/회전체는 멈춰 있음 */
    _playing=false; _simTime=0; _lastTs=0;
    _stop();
    _raf=requestAnimationFrame(_loop);
  }

  function stop(){
    _playing=false; _simTime=0;
    if(_raf!==null){cancelAnimationFrame(_raf);_raf=null;}
    _unbindOrbit();
    if(_resizeFn){window.removeEventListener('resize',_resizeFn);_resizeFn=null;}
    _disposeScene();
    if(_renderer){ _renderer.dispose&&_renderer.dispose(); _renderer=null; }
    _scene=null; _camera=null;
    if(_cv&&_cv.parentNode){_cv.parentNode.removeChild(_cv);} _cv=null;
    if(_hintEl){_hintEl.remove();_hintEl=null;}
    var ctrl=document.getElementById('analogy-ctrl'); if(ctrl)ctrl.remove();
    var hud=document.getElementById('analogy-hud'); if(hud)hud.remove();
    /* 2D 레이어 복구 */
    ['canvas-bg','canvas-main','canvas-anim'].forEach(function(id){
      var el=document.getElementById(id); if(el)el.style.visibility='';
    });
  }

  /* render: 외부 강제 1프레임 (호환용) */
  function render(){ if(_renderer&&_scene&&_camera){_applyCamera();_renderer.render(_scene,_camera);} }

  return{start:start, stop:stop, render:render};
})();

}());
