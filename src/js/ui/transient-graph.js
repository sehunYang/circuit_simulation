(function(){
'use strict';
var App=window.App;

App.TransientGraph=(function(){
  /* ── 캔버스 & 애니메이션 상태 ── */
  var _cv=null, _ctx=null;
  var _rafId=null;
  var _running=false;
  var _resizeObs=null;

  /* ── 시뮬레이션 상태 ── */
  var _t=0, _dt=0.5e-3;     // 현재 시간, 적분 스텝(s)
  var _tMax=0.1;            // 그래프 시간축 최대 (5·τ로 자동 보정)
  var _history={};          // { compId → Float32Array } 계산된 전류 곡선
  var _active={};           // { compId → bool } 토글 켜짐 여부
  var _compList=[];         // [{id,type,label,color}] 범례용

  /* 곡선 색상 팔레트 (소자 순서대로 순환 배정) */
  /* 곡선 색 — 흰 지면 위에서 읽히도록 어둡고 채도를 눌러 잡은 팔레트.
   * (수능 지면은 흑백이지만 그래프는 여러 소자를 동시에 겹쳐 그리므로
   *  구분을 위해 최소한의 색을 쓴다. 인쇄해도 명도가 서로 다르다.) */
  var _colors=['#1d4ed8','#b45309','#15803d','#a21caf','#0e7490','#b91c1c'];

  /* 극점 정보: _computeTransient에서 계산, _drawGraph 수식 레이블에서 사용
   *   {alpha:1/τ, omegad:감쇠진동 각주파수, isOsc:진동 여부} */
  var _systemPoles={alpha:0, omegad:0, isOsc:false};

  /* 과도응답 핏 데이터 (비유 모드 재사용용)
   *   { compId → {amp, tau, isRising} }  + _domTau(dominant 시상수) */
  var _fitData={};
  var _domTau=0;

  /* 전 소자/도선 시변 전류 모델 (비유 모드 재사용용)
   *   _branchModel = { byComp:{compId:{i0,iinf,tau}}, byWire:{wireId:{i0,iinf,tau}}, domTau }
   *   각 가지 전류는 i(t) = iinf + (i0−iinf)·e^(−t/τ) (1차 회로 가정). */
  var _branchModel=null;

  /* 회로 파라미터 추출 (DC 회로 + 동적 소자 L/C 존재 시에만) */
  function _extractParams(){
    var comps=App.State.components;
    var sr=App.State.solverResult;
    if(!sr||!sr.valid||sr.acPhasor) return null; /* DC만 */

    var caps=comps.filter(function(c){return c.type===TYPE.CAPACITOR;});
    var inds=comps.filter(function(c){return c.type===TYPE.INDUCTOR;});
    var ress=comps.filter(function(c){return c.type===TYPE.RESISTOR;});
    var srcs=comps.filter(function(c){return c.type===TYPE.DC_SOURCE;});

    if(!caps.length&&!inds.length) return null; /* 동적 소자 없음 */

    var Req=ress.reduce(function(s,r){return s+(r.value||0);},0)||1;  // 등가 저항(직렬 합산)
    var Vsrc=srcs.length>0?(srcs[0].value||0):0;                      // 등가 전압원

    return{Req:Req, Vsrc:Vsrc, caps:caps, inds:inds};
  }

  /* ── 과도 응답 수치 해석 (MNA 상태공간 + Crank-Nicolson 사다리꼴 적분) ──
   *
   * 토폴로지 자동 감지:
   *   인덕터(L)·축전기(C)가 같은 노드 쌍 → 병렬 LC, 그 외 → 직렬 RLC
   *
   * 상태변수 x = [노드전압 | 인덕터전류 | 전압원전류]
   *   C_mna·dx/dt + G_mna·x = b   (사다리꼴 적분으로 시간 전진)
   *
   * 시정수 τ: Thevenin 공식 (수치 안정)
   *   τ_L = L·I_inf/V_oc,  τ_C = C·V_inf/I_0
   * 사후처리: 1패스 배열에서 실제 τ·진폭 역산 → 해석적 지수곡선 재생성
   *   (사다리꼴 t=0 forward-diff 과대평가로 인한 수직 점프 제거)
   * ──────────────────────────────────────────────────────────────────── */
  function _computeTransient(params){
    var V=params.Vsrc;
    var caps=params.caps, inds=params.inds;
    var STEPS=1000;
    var result={};
    _branchModel=null;   /* 매 계산마다 초기화 */

    /* ══════════════════════════════════════════════════════════════════
     * MNA 과도응답 솔버 (완전 독립 IC 기반)
     *
     * 시정수 계산 버그 수정:
     *   버그1: caps.forEach에서 인덱스 k 누락 → 외부 k 사용 → 잘못된 ic_sol 참조
     *   버그2: τ_L 계산을 bI[ind.id]에 의존 → 0이면 τ≈0 or overflow
     *
     * 해결: IC 시스템 두 번 풀기
     *   IC_0  (L=개방, C=단락): t=0 초기조건 + V_oc(L), I_0(C)
     *   IC_inf(L=단락, C=개방): t=∞ 정상상태 + I_inf(L), V_inf(C)
     *
     *   τ_L = L · I_inf / V_oc   (Thevenin: R_th = V_oc/I_inf)
     *   τ_C = C · V_inf / I_0    (Thevenin: R_th = V_inf/I_0)
     * ══════════════════════════════════════════════════════════════════ */

    function mat(n){var m=[];for(var i=0;i<n;i++)m.push(new Float64Array(n));return m;}
    function vec(n){return new Float64Array(n);}
    function matvec(A,x){
      var n=x.length,y=vec(n);
      for(var i=0;i<n;i++)for(var j=0;j<n;j++)y[i]+=A[i][j]*x[j];
      return y;
    }
    function solve(A,b){
      var n=b.length;
      var a=A.map(function(r){return Float64Array.from(r);});
      var x=Float64Array.from(b);
      for(var col=0;col<n;col++){
        var mx=col,mv=Math.abs(a[col][col]);
        for(var rr=col+1;rr<n;rr++){var v=Math.abs(a[rr][col]);if(v>mv){mv=v;mx=rr;}}
        if(mv<1e-14)return null;
        if(mx!==col){var t=a[col];a[col]=a[mx];a[mx]=t;var tb=x[col];x[col]=x[mx];x[mx]=tb;}
        var piv=a[col][col];
        for(var r2=col+1;r2<n;r2++){
          var f=a[r2][col]/piv;if(Math.abs(f)<1e-16)continue;
          for(var c2=col;c2<n;c2++)a[r2][c2]-=f*a[col][c2];
          x[r2]-=f*x[col];
        }
      }
      var sol=new Float64Array(n);
      for(var i2=n-1;i2>=0;i2--){
        sol[i2]=x[i2];
        for(var j2=i2+1;j2<n;j2++)sol[i2]-=a[i2][j2]*sol[j2];
        sol[i2]/=a[i2][i2];
      }
      return sol;
    }

    var sr=App.State.solverResult;
    var cn=sr&&sr.componentNodes;
    var comps=App.State.components;

    /* ── 폴백 ── */
    if(!cn){
      var Req=params.Req;
      _fitData={}; _domTau=0;
      var fbByComp={}, fbByWire={};
      inds.forEach(function(ind){
        var R=Math.max(Req,1e-3),L=ind.value||1e-3,tau=L/R,Iinf=V/R;
        _tMax=Math.max(_tMax,tau*5); _domTau=Math.max(_domTau,tau);
        _fitData[ind.id]={amp:Iinf, tau:tau, isRising:true};
        fbByComp[ind.id]={i0:0, iinf:Iinf, tau:tau};
        var a=new Float32Array(STEPS);
        for(var k=0;k<STEPS;k++)a[k]=Iinf*(1-Math.exp(-k/(STEPS-1)*_tMax/tau));
        result[ind.id]=a;
      });
      caps.forEach(function(cap){
        var R=Math.max(Req,1e-3),C=cap.value||1e-6,tau=R*C,I0=V/R;
        _tMax=Math.max(_tMax,tau*5); _domTau=Math.max(_domTau,tau);
        _fitData[cap.id]={amp:I0, tau:tau, isRising:false};
        fbByComp[cap.id]={i0:I0, iinf:0, tau:tau};
        var a=new Float32Array(STEPS);
        for(var k=0;k<STEPS;k++)a[k]=I0*Math.exp(-k/(STEPS-1)*_tMax/tau);
        result[cap.id]=a;
      });
      _branchModel={byComp:fbByComp, byWire:fbByWire, byNode:null, compNodes:null, domTau:_domTau};
      return result;
    }

    /* ── 1. 노드 수 ── */
    var maxNode=0;
    comps.forEach(function(c){
      var nn=cn[c.id];if(!nn)return;
      nn.forEach(function(n){if(n>maxNode)maxNode=n;});
    });
    var nNodes=maxNode;

    /* ── 2. 소자 목록 ── */
    var vsrcs=comps.filter(function(c){
      return c.type===TYPE.DC_SOURCE||c.type===TYPE.AC_SOURCE;
    });
    var nL=inds.length,nVs=vsrcs.length,nC=caps.length;
    var N=nNodes+nL+nVs;
    if(N<=0)return result;

    var L_OFF=nNodes,V_OFF=nNodes+nL;

    function nIdx(n){return n===0?-1:n-1;}
    function stamp2(M,p,q,val){
      if(p>=0)M[p][p]+=val;
      if(q>=0)M[q][q]+=val;
      if(p>=0&&q>=0){M[p][q]-=val;M[q][p]-=val;}
    }

    /* ══════════════════════════════════════════════════════════════════
     * ── 3. IC 시스템 헬퍼 ──────────────────────────────────────────
     * solveIC(shortL, shortC):
     *   shortL=true  → L 단락(V=0 전압원으로 치환)
     *   shortL=false → L 개방(스탬프 없음)
     *   shortC=true  → C 단락(V=0 전압원으로 치환)
     *   shortC=false → C 개방(스탬프 없음)
     *
     * 반환: sol 배열
     *   [0 .. nNodes-1]       : 노드 전압
     *   [nNodes .. +nVs-1]    : 전압원 전류
     *   [nNodes+nVs .. +nL-1] : (shortL=true) 인덕터 단락 전류
     *   [nNodes+nVs+nL .. +nC-1]: (shortC=true) 커패시터 단락 전류
     * ══════════════════════════════════════════════════════════════════ */
    function solveIC(shortL, shortC){
      var nExtra=(shortL?nL:0)+(shortC?nC:0);
      var N2=nNodes+nVs+nExtra;
      var G2=mat(N2),b2=vec(N2);
      var L_IC_OFF=nNodes+nVs;
      var C_IC_OFF=nNodes+nVs+(shortL?nL:0);

      /* 저항 */
      comps.forEach(function(c){
        if(c.type!==TYPE.RESISTOR)return;
        var nn=cn[c.id];if(!nn)return;
        stamp2(G2,nIdx(nn[0]),nIdx(nn[1]),c.value>0?1/c.value:1e6);
      });
      /* 전압원 */
      vsrcs.forEach(function(vs,k){
        var nn=cn[vs.id];if(!nn)return;
        var p=nIdx(nn[0]),q=nIdx(nn[1]),kv=nNodes+k;
        var Vs=vs.type===TYPE.DC_SOURCE?(vs.value||0):0;
        if(p>=0){G2[p][kv]+=1;G2[kv][p]+=1;}
        if(q>=0){G2[q][kv]-=1;G2[kv][q]-=1;}
        b2[kv]=Vs;
      });
      /* 인덕터 */
      var G_OPEN=1e-9; /* 개방 = 1GΩ 저항 (행렬 가역성 보장) */
      inds.forEach(function(ind,k){
        var nn=cn[ind.id];if(!nn)return;
        var p=nIdx(nn[0]),q=nIdx(nn[1]);
        if(shortL){
          /* V=0 전압원(단락) */
          var ki=L_IC_OFF+k;
          if(p>=0){G2[p][ki]+=1;G2[ki][p]+=1;}
          if(q>=0){G2[q][ki]-=1;G2[ki][q]-=1;}
          /* b2[ki]=0: V_L=0 */
        } else {
          /* 개방: 1GΩ 저항으로 근사 (singular 방지) */
          stamp2(G2,p,q,G_OPEN);
        }
      });
      /* 커패시터 */
      caps.forEach(function(cap,k){
        var nn=cn[cap.id];if(!nn)return;
        var p=nIdx(nn[0]),q=nIdx(nn[1]);
        if(shortC){
          /* V=0 전압원(단락) */
          var kc=C_IC_OFF+k;
          if(p>=0){G2[p][kc]+=1;G2[kc][p]+=1;}
          if(q>=0){G2[q][kc]-=1;G2[kc][q]-=1;}
          /* b2[kc]=0 */
        } else {
          /* 개방: 1GΩ 저항으로 근사 (singular 방지) */
          stamp2(G2,p,q,G_OPEN);
        }
      });

      return solve(G2,b2);
    }

    /* IC_0:  L=개방, C=단락 → t=0 초기조건 + V_oc(L), I_0(C) */
    var C_IC0_OFF=nNodes+nVs;  /* (shortL=false이므로 L 추가변수 없음) */
    var sol0=solveIC(false,true);

    /* IC_inf: L=단락, C=개방 → t=∞ 정상상태 + I_inf(L) */
    var L_ICinf_OFF=nNodes+nVs;
    var solinf=solveIC(true,false);

    /* ── 4. MNA 행렬 스탬프 ── */
    var G_mna=mat(N),C_mna=mat(N),b_vec=vec(N);
    comps.forEach(function(c){
      var nn=cn[c.id];if(!nn)return;
      var p=nIdx(nn[0]),q=nIdx(nn[1]);
      if(c.type===TYPE.RESISTOR)  stamp2(G_mna,p,q,c.value>0?1/c.value:1e6);
      if(c.type===TYPE.CAPACITOR) stamp2(C_mna,p,q,c.value||1e-6);
    });
    inds.forEach(function(ind,k){
      var nn=cn[ind.id];if(!nn)return;
      var p=nIdx(nn[0]),q=nIdx(nn[1]),ki=L_OFF+k,Lv=ind.value||1e-3;
      if(p>=0){G_mna[p][ki]-=1;G_mna[ki][p]+=1;}
      if(q>=0){G_mna[q][ki]+=1;G_mna[ki][q]-=1;}
      C_mna[ki][ki]+=Lv;
    });
    vsrcs.forEach(function(vs,k){
      var nn=cn[vs.id];if(!nn)return;
      var p=nIdx(nn[0]),q=nIdx(nn[1]),kv=V_OFF+k;
      var Vs=vs.type===TYPE.DC_SOURCE?(vs.value||0):0;
      if(p>=0){G_mna[p][kv]+=1;G_mna[kv][p]+=1;}
      if(q>=0){G_mna[q][kv]-=1;G_mna[kv][q]-=1;}
      b_vec[kv]=Vs;
    });

    /* ── 5. 초기 상태 x ── */
    var x=vec(N);
    if(sol0){
      for(var i=0;i<nNodes;i++) x[i]=sol0[i];
      for(var k=0;k<nL;k++)     x[L_OFF+k]=0;
      for(var k=0;k<nVs;k++)    x[V_OFF+k]=sol0[nNodes+k];
    }

    /* ── 6. τ 추정 — Thevenin 공식 ─────────────────────────────────
     *
     * τ_L = L · I_inf / V_oc
     *   V_oc: IC_0(L=개방)에서 L 단자 개방전압 (sol0 에서 직접 읽음)
     *   I_inf: IC_inf(L=단락)에서 인덕터 단락전류
     *
     * τ_C = C · V_inf / I_0
     *   V_inf: IC_inf(C=개방)에서 C 양단 전압
     *   I_0: IC_0(C=단락)에서 C 단락전류 = sol0[C_IC0_OFF+k]
     *
     * 이 공식은 회로 복잡도와 무관하게 수치적으로 완전히 안정합니다.
     * dt_try 기반 수치 미분 방법은 C_mna/dt_try 조건수 폭발로 인해
     * 수치 불안정 (예: C=100pF, R=100Ω → dt_try=0.1ns, C/dt=1e3 → ill-conditioned)
     * ──────────────────────────────────────────────────────────────── */
    var tauMax=1e-9;

    inds.forEach(function(ind,k){
      var nn=cn[ind.id];if(!nn)return;
      var p=nIdx(nn[0]),q=nIdx(nn[1]);
      var V_oc=sol0?Math.abs((p>=0?sol0[p]:0)-(q>=0?sol0[q]:0)):0;
      var I_inf=solinf?Math.abs(solinf[L_ICinf_OFF+k]||0):0;
      var tau;
      if(V_oc>1e-12&&I_inf>1e-15) tau=(ind.value||1e-3)*I_inf/V_oc;
      else tau=(ind.value||1e-3)/Math.max(params.Req,1);
      tauMax=Math.max(tauMax,tau*5);
    });

    caps.forEach(function(cap,k){
      var nn=cn[cap.id];if(!nn)return;
      var p=nIdx(nn[0]),q=nIdx(nn[1]);
      var I_0=sol0?Math.abs(sol0[C_IC0_OFF+k]||0):0;
      var V_inf=solinf?Math.abs((p>=0?solinf[p]:0)-(q>=0?solinf[q]:0)):0;
      var tau;
      if(I_0>1e-15&&V_inf>1e-12) tau=(cap.value||1e-6)*V_inf/I_0;
      else tau=Math.max(params.Req,1)*(cap.value||1e-6);
      tauMax=Math.max(tauMax,tau*5);
    });

    /* RLC 공진 주기도 고려 */
    if(nL>0&&nC>0){
      var Ltot=inds.reduce(function(s,l){return s+(l.value||0);},0)||1e-3;
      var Ctot=1/caps.reduce(function(s,c){return s+1/(c.value||1e-6);},0);
      tauMax=Math.max(tauMax,20*Math.sqrt(Ltot*Ctot));
    }

    _tMax=tauMax;
    var dt=_tMax/STEPS;

    /* ══════════════════════════════════════════════════════════════════
     * 전 소자/도선 시변 전류 모델 구축 (비유 모드 재사용)
     *   sol0  : t=0  (L 개방, C 단락) 노드전압 + 전원전류 + C단락전류
     *   solinf: t=∞ (L 단락, C 개방) 노드전압 + 전원전류 + L단락전류
     *   각 가지: i(t) = iinf + (i0 − iinf)·e^{−t/τ_dom}
     * ══════════════════════════════════════════════════════════════════ */
    (function(){
      var domTau=tauMax/5;   // tauMax=5·domTau
      if(!(domTau>1e-15)) domTau=Math.max(params.Req,1)*1e-6;
      var byComp={}, byWire={};

      function nodeVolt(sol,node){ var i=nIdx(node); return (i>=0&&sol)?sol[i]:0; }

      /* 저항: i = (Vp − Vq)/R, 전원: 전압원 전류, L: i0=0·iinf=단락전류, C: i0=단락전류·iinf=0 */
      comps.forEach(function(c){
        var nn=cn[c.id]; if(!nn) return;
        var i0=0, iinf=0;
        if(c.type===TYPE.RESISTOR){
          var R=c.value>0?c.value:1e-6;
          i0  =(nodeVolt(sol0,nn[0])  -nodeVolt(sol0,nn[1])) /R;
          iinf=(nodeVolt(solinf,nn[0])-nodeVolt(solinf,nn[1]))/R;
        } else if(c.type===TYPE.DC_SOURCE||c.type===TYPE.AC_SOURCE){
          var kv=vsrcs.indexOf(c);
          if(kv>=0){ i0=sol0?(sol0[nNodes+kv]||0):0; iinf=solinf?(solinf[nNodes+kv]||0):0; }
        } else if(c.type===TYPE.INDUCTOR){
          var kL=inds.indexOf(c);
          i0=0;  /* t=0 인덕터 전류=0 */
          iinf=(kL>=0&&solinf)?(solinf[L_ICinf_OFF+kL]||0):0;
        } else if(c.type===TYPE.CAPACITOR){
          var kC=caps.indexOf(c);
          i0=(kC>=0&&sol0)?(sol0[C_IC0_OFF+kC]||0):0;
          iinf=0;  /* t=∞ 커패시터 전류=0 */
        }
        byComp[c.id]={i0:i0, iinf:iinf, tau:domTau};
      });

      /* ── 노드별 시변 전위 모델 (#3) ──
       *   v_node(t) = vinf + (v0 − vinf)·e^{−t/τ}
       *   sol0/solinf 의 노드전압을 그대로 사용. 그라운드(node 0)=0V 고정. */
      var byNode={};
      var maxNodeId=0;
      comps.forEach(function(c){ var nn=cn[c.id]; if(nn) nn.forEach(function(n){ if(n>maxNodeId)maxNodeId=n; }); });
      for(var nd=0; nd<=maxNodeId; nd++){
        if(nd===0){ byNode[0]={v0:0,vinf:0,tau:domTau}; continue; }
        byNode[nd]={ v0:nodeVolt(sol0,nd), vinf:nodeVolt(solinf,nd), tau:domTau };
      }

      /* 도선: 양 끝 소자 중 전류를 아는 쪽으로 i(t) 결정 (부호 보존, #2).
       *   부호 기준: fromPort→toPort 가 양(+). 연결 소자의 부호 있는 i0/iinf 를
       *   도선 방향에 맞춰 변환한다. */
      App.State.wires.forEach(function(w){
        var fromComp=App.State.getComponent(w.fromId);
        var toComp=App.State.getComponent(w.toId);
        var isJ=function(cc){return cc&&(cc.type===TYPE.JUNCTION_3||cc.type===TYPE.JUNCTION_4);};
        /* 기준 소자(전류를 아는 쪽) 선택: 분기점이 아닌 쪽 우선 */
        var refId=null, refIsFrom=true, refPort=null;
        if(!isJ(fromComp) && byComp[w.fromId]){ refId=w.fromId; refIsFrom=true; refPort=w.fromPort; }
        else if(!isJ(toComp) && byComp[w.toId]){ refId=w.toId; refIsFrom=false; refPort=w.toPort; }
        if(!refId){ byWire[w.id]={i0:0,iinf:0,tau:domTau,signed:false}; return; }
        var rc=byComp[refId];
        /* refPortIdx: 도선이 붙은 소자 포트의 순서(0/1). 소자 부호전류 s0는
         *   ports[0]→ports[1] 가 +. 도선이 ports[1]에 붙으면 전류가 소자에서
         *   도선으로 나가는(+) 방향이 도선 from→to 와 정렬됨(refIsFrom 고려). */
        var refComp=App.State.getComponent(refId);
        var refPorts=App.Geo.getCompPorts(refComp);
        var refPortIdx=refPorts.indexOf(refPort);
        byWire[w.id]={ i0:Math.abs(rc.i0), iinf:Math.abs(rc.iinf), tau:domTau,
                       refId:refId, refIsFrom:refIsFrom, refPortIdx:refPortIdx };
      });

      /* 소자 전류 부호 보존본 (도선 방향 결정용) */
      comps.forEach(function(c){
        var nn=cn[c.id]; if(!nn) return;
        var s0=0, sinf=0;
        if(c.type===TYPE.RESISTOR){
          var R=c.value>0?c.value:1e-6;
          s0  =(nodeVolt(sol0,nn[0])  -nodeVolt(sol0,nn[1])) /R;
          sinf=(nodeVolt(solinf,nn[0])-nodeVolt(solinf,nn[1]))/R;
        } else if(c.type===TYPE.DC_SOURCE||c.type===TYPE.AC_SOURCE){
          var kv=vsrcs.indexOf(c);
          if(kv>=0){ s0=sol0?(sol0[nNodes+kv]||0):0; sinf=solinf?(solinf[nNodes+kv]||0):0; }
        } else if(c.type===TYPE.INDUCTOR){
          var kL=inds.indexOf(c);
          sinf=(kL>=0&&solinf)?(solinf[L_ICinf_OFF+kL]||0):0;
        } else if(c.type===TYPE.CAPACITOR){
          var kC=caps.indexOf(c);
          s0=(kC>=0&&sol0)?(sol0[C_IC0_OFF+kC]||0):0;
        }
        byComp[c.id].s0=s0; byComp[c.id].sinf=sinf;   // 부호 있는 전류
      });

      _branchModel={ byComp:byComp, byWire:byWire, byNode:byNode,
                     compNodes:cn, domTau:domTau };
    })();
    var isAlg=new Uint8Array(N);
    for(var i=0;i<N;i++){
      var hasC=false;
      for(var j=0;j<N;j++)if(Math.abs(C_mna[i][j])>1e-20){hasC=true;break;}
      isAlg[i]=hasC?0:1;
    }
    var A_mat=mat(N),B_mat=mat(N);
    for(var i=0;i<N;i++)for(var j=0;j<N;j++){
      if(isAlg[i]){
        A_mat[i][j]=G_mna[i][j];
        B_mat[i][j]=0;
      } else {
        A_mat[i][j]=C_mna[i][j]/dt+G_mna[i][j]/2;
        B_mat[i][j]=C_mna[i][j]/dt-G_mna[i][j]/2;
      }
    }

    /* ── 9. 전류 배열 초기화 ── */
    var iL_arrs=inds.map(function(ind){return{id:ind.id,arr:new Float32Array(STEPS)};});
    var iC_arrs=caps.map(function(cap,k){
      return{id:cap.id,arr:new Float32Array(STEPS),nn:cn[cap.id],Cv:cap.value||1e-6};
    });

    /* ── 10. 적분 루프 ── */
    var xp=new Float64Array(x);
    for(var step=0;step<STEPS;step++){

      /* 인덕터 전류: 현재 상태(xp) 기록 */
      for(var k=0;k<nL;k++) iL_arrs[k].arr[step]=Math.abs(xp[L_OFF+k]);

      /* 다음 상태 계산 */
      var rhs=matvec(B_mat,xp);
      for(var i=0;i<N;i++)rhs[i]+=b_vec[i];
      var xn=solve(A_mat,rhs);
      if(!xn)break;

      /* 커패시터 전류: i_C = C · Δv / dt
       * step=0: arr[0] = forward diff (t=0의 실제 초기전류)
       *         arr[1] 은 아래 backward diff로 기록
       * step>0: arr[step+1] = backward diff */
      iC_arrs.forEach(function(ci){
        var nn=ci.nn;if(!nn)return;
        var p=nIdx(nn[0]),q=nIdx(nn[1]);
        var dvn=(p>=0?xn[p]:0)-(q>=0?xn[q]:0);
        var dvp=(p>=0?xp[p]:0)-(q>=0?xp[q]:0);
        var iC=Math.abs(ci.Cv*(dvn-dvp)/dt);
        if(step===0){
          /* t=0 초기값: forward diff v[1]-v[0] 은 첫 스텝의 변화량
           * = 실제 i_C(0+). arr[0]과 arr[1] 모두 동일 값으로 초기화하면
           * 연속적으로 보임 */
          ci.arr[0]=iC;
        }
        if(step+1<STEPS) ci.arr[step+1]=iC;
      });

      xp=xn;
    }

    /* ── 11. 결과 수집 ── */
    iL_arrs.forEach(function(o){result[o.id]=o.arr;});
    iC_arrs.forEach(function(o){result[o.id]=o.arr;});

    /* ── 12. 사후처리: τ·진폭 추출 → 해석적 곡선 재생성 ──────────────
     *
     * 사다리꼴 수치적분은 t=0 첫 스텝에서 forward-diff 과대평가로
     * arr[0]이 실제 곡선보다 크게 나와 수직 점프(급강하/급상승)를 만듦.
     *
     * 해결: 1패스 배열에서 실제 τ와 진폭을 역산한 뒤,
     *   각 소자를 1차 지수 곡선으로 해석적으로 재생성.
     *     증가형(RL):  i(t) = I_inf·(1 - e^{-t/τ})
     *     감소형(RC):  i(t) = I_0·e^{-t/τ}
     *
     * τ 역산: 안정 구간 두 점 t1=0.2T, t2=0.6T (T=1패스 _tMax)
     *   증가형: τ = (t2-t1)/ln((I_inf-i1)/(I_inf-i2))
     *   감소형: τ = (t2-t1)/ln(i1/i2)
     * 진폭 역산: 여러 점에서 e 보정 후 평균 (노이즈 완화)
     * ──────────────────────────────────────────────────────────────── */
    var _tMaxPass1=_tMax;  /* 1패스 시간축 보존 */
    var allArrs=iL_arrs.concat(iC_arrs);

    /* 각 소자별 τ, 진폭, 방향 추출 */
    var fits=allArrs.map(function(o){
      var arr=o.arr, Nf=arr.length;
      var Iend=arr[Nf-1];
      var peak=0;
      for(var ki=0;ki<Nf;ki++) if(Math.abs(arr[ki])>Math.abs(peak)) peak=arr[ki];
      var isRising=Math.abs(Iend)>Math.abs(peak)*0.5;

      var k1=Math.round(Nf*0.2), k2=Math.round(Nf*0.6);
      var t1=k1/(Nf-1)*_tMaxPass1, t2=k2/(Nf-1)*_tMaxPass1;
      var i1=Math.abs(arr[k1]), i2=Math.abs(arr[k2]);
      var Ie=Math.abs(Iend);

      var tau=0;
      if(isRising){
        var r1=Ie-i1, r2=Ie-i2;
        if(r1>1e-30&&r2>1e-30&&r1>r2) tau=(t2-t1)/Math.log(r1/r2);
      } else {
        if(i1>1e-30&&i2>1e-30&&i1>i2) tau=(t2-t1)/Math.log(i1/i2);
      }

      return {o:o, tau:tau, isRising:isRising, Nf:Nf};
    });

    /* dominant τ (가장 느린 소자 기준으로 시간축 결정) */
    var dominantTau=0;
    fits.forEach(function(f){ if(f.tau>1e-30&&isFinite(f.tau)) dominantTau=Math.max(dominantTau,f.tau); });

    /* 비유 모드 재사용 데이터 초기화 */
    _fitData={}; _domTau=dominantTau;

    if(dominantTau>1e-15){
      _tMax=dominantTau*5;
      dt=_tMax/STEPS;
      _systemPoles={alpha:1/dominantTau, omegad:0, isOsc:false};

      /* 각 소자 해석적 재생성 */
      fits.forEach(function(f){
        var arr=f.o.arr, Nf=f.Nf;
        var tau=(f.tau>1e-30&&isFinite(f.tau))?f.tau:dominantTau;

        /* 진폭 추출: 안정 구간 여러 점에서 e 보정 후 평균 */
        var amp=0, cnt=0;
        var kStart=Math.round(Nf*0.1), kEnd=Math.round(Nf*0.6);
        for(var kk=kStart;kk<=kEnd;kk++){
          var tt=kk/(Nf-1)*_tMaxPass1;
          var v=Math.abs(arr[kk]);
          if(f.isRising){
            var d=1-Math.exp(-tt/tau);
            if(d>1e-6){ amp+=v/d; cnt++; }
          } else {
            amp+=v*Math.exp(tt/tau); cnt++;
          }
        }
        amp=cnt>0?amp/cnt:Math.abs(arr[Nf-1]);

        /* 비유 모드용 핏 데이터 저장 */
        _fitData[f.o.id]={amp:amp, tau:tau, isRising:f.isRising};

        /* 새 시간축으로 해석적 곡선 생성 */
        var newArr=new Float32Array(Nf);
        for(var k=0;k<Nf;k++){
          var t=k/(Nf-1)*_tMax;
          newArr[k]=f.isRising
            ? amp*(1-Math.exp(-t/tau))
            : amp*Math.exp(-t/tau);
        }
        f.o.arr=newArr;
      });

      /* 결과 갱신 */
      result={};
      iL_arrs.forEach(function(o){result[o.id]=o.arr;});
      iC_arrs.forEach(function(o){result[o.id]=o.arr;});
    }

    return result;
  }
  function _buildToggles(params){
    var toggleDiv=document.getElementById('transient-toggles');
    var legendDiv=document.getElementById('transient-legend');
    if(!toggleDiv||!legendDiv) return;
    toggleDiv.innerHTML=''; legendDiv.innerHTML='';
    _compList=[];

    var allComps=params.caps.concat(params.inds);
    allComps.forEach(function(c,idx){
      var color=_colors[idx%_colors.length];
      var label=(c.type===TYPE.CAPACITOR?'C':'L')+(idx+1)+
                (c.label?' ('+c.label+')':'');
      _compList.push({id:c.id,type:c.type,label:label,color:color});
      _active[c.id]=true;

      var btn=document.createElement('button');
      btn.className='tp-toggle active';
      btn.textContent=label;
      btn.style.borderColor=color; btn.style.color=color;
      btn.style.background='#ffffff';
      btn.dataset.compId=c.id;
      btn.addEventListener('click',function(){
        _active[c.id]=!_active[c.id];
        btn.classList.toggle('active',_active[c.id]);
        _drawGraph();
      });
      toggleDiv.appendChild(btn);

      var leg=document.createElement('span');
      leg.style.color=color;
      leg.textContent='— '+label+': '+
        (c.type===TYPE.CAPACITOR?'충전전류 i_C(t)':'인덕터전류 i_L(t)');
      legendDiv.appendChild(leg);
    });
  }

  /* ── 단위 보기 좋은 눈금 계산 ──────────────────────────────────────
   * 범위 [0, rawMax] 에 대해 "보기 좋은" 최대값과 눈금 간격을 결정.
   * 예: rawMax=0.00234 → niceMax=0.0025, step=0.0005 (5단계)
   * ─────────────────────────────────────────────────────────────── */
  function _niceScale(rawMax, nDiv){
    if(rawMax<=0) return{max:1,step:0.2};
    var rough=rawMax/nDiv;
    var mag=Math.pow(10,Math.floor(Math.log10(rough)));
    var norm=rough/mag;
    var nice=norm<=1?1:norm<=2?2:norm<=5?5:10;
    var step=nice*mag;
    var niceMax=Math.ceil(rawMax/step)*step;
    return{max:niceMax, step:step};
  }

  /* 값→단위 문자열 (시간용, 전류용 공통) */
  function _fmtVal(v, isTime){
    if(isTime){
      if(Math.abs(v)<1e-9) return '0';
      if(Math.abs(v)<1e-6) return (v*1e9).toPrecision(3)+'ns';
      if(Math.abs(v)<1e-3) return (v*1e6).toPrecision(3)+'µs';
      if(Math.abs(v)<1)    return (v*1e3).toPrecision(3)+'ms';
      return v.toPrecision(3)+'s';
    } else {
      if(Math.abs(v)<1e-12) return '0';
      if(Math.abs(v)<1e-9)  return (v*1e12).toPrecision(3)+'pA';
      if(Math.abs(v)<1e-6)  return (v*1e9 ).toPrecision(3)+'nA';
      if(Math.abs(v)<1e-3)  return (v*1e6 ).toPrecision(3)+'µA';
      if(Math.abs(v)<1)     return (v*1e3 ).toPrecision(3)+'mA';
      return v.toPrecision(4)+'A';
    }
  }

  /* ── 그래프 렌더 (활성 소자 기반 동적 스케일 + 수식 레이블) ── */
  function _drawGraph(){
    if(!_cv||!_ctx) return;

    /* KaTeX 오버레이용 레이블 수집 배열 */
    var _pendingLabels=[];

    var dpr=window.devicePixelRatio||1;
    var rect=_cv.getBoundingClientRect();
    if(rect.width<=0||rect.height<=0) return;

    var isMobile=window.innerWidth<=480;
    var targetH=isMobile
      ? Math.min(160, Math.round(window.innerHeight*0.28))
      : 180;

    _cv.style.height=targetH+'px';

    var physW=Math.round(rect.width*dpr);
    var physH=Math.round(targetH*dpr);
    if(_cv.width!==physW)  _cv.width=physW;
    if(_cv.height!==physH) _cv.height=physH;

    _ctx.setTransform(dpr,0,0,dpr,0,0);

    var W=rect.width, H=targetH;
    _ctx.clearRect(0,0,W,H);

    /* ── 여백 ── */
    var PAD={left:52, right:14, top:12, bottom:28};
    var gW=W-PAD.left-PAD.right;
    var gH=H-PAD.top-PAD.bottom;

    /* ── 배경 ── 수능 그래프 문항과 같이 흰 지면 위에 그린다 */
    _ctx.fillStyle='#ffffff';
    _ctx.fillRect(0,0,W,H);

    /* ── 활성 소자 데이터 수집 ── */
    var STEPS_N=1000;
    var dataMinI=Infinity, dataMaxI=-Infinity, hasData=false;

    /* x축 동적 범위: 활성 소자들의 데이터에서 수렴 시점 추출
     * 방법: 각 배열에서 최종값의 99%에 처음 도달하는 인덱스 k_eff 계산
     *       → t_eff = k_eff / (N-1) * _tMax
     * xMax = 활성 소자 중 최대 t_eff * 1.1 (약간 여유) */
    var tEffMax=0;
    _compList.forEach(function(c){
      if(!_active[c.id]||!_history[c.id]) return;
      var arr=_history[c.id];
      var N=arr.length;

      /* y 범위 */
      for(var k=0;k<N;k++){
        var v=arr[k];
        if(v<dataMinI) dataMinI=v;
        if(v>dataMaxI) dataMaxI=v;
        hasData=true;
      }

      /* 수렴 시점: 최종값의 99%에 도달하거나, 최댓값의 1%이하로 내려가는 시점 */
      var finalV=arr[N-1];
      var peakV=0;
      for(var k2=0;k2<N;k2++) if(Math.abs(arr[k2])>peakV) peakV=Math.abs(arr[k2]);

      var kEff=N-1;
      if(Math.abs(finalV)>peakV*0.1){
        /* 증가형 (RL): 최종값의 99% 도달 시점 */
        for(var k3=0;k3<N;k3++){
          if(Math.abs(arr[k3])>=Math.abs(finalV)*0.99){kEff=k3;break;}
        }
      } else {
        /* 감소형 (RC): 최댓값의 1% 이하로 떨어지는 시점 */
        for(var k4=0;k4<N;k4++){
          if(Math.abs(arr[k4])<=peakV*0.01){kEff=k4;break;}
        }
      }
      var tEff=kEff/(N-1)*_tMax;
      if(tEff>tEffMax) tEffMax=tEff;
    });

    if(!hasData){ dataMinI=0; dataMaxI=1e-3; }
    if(tEffMax<=0) tEffMax=_tMax;

    /* x축: 활성 소자의 수렴 시점 + 10% 여유 */
    var xRaw=tEffMax*1.1;
    var scaleX=_niceScale(xRaw,5);
    var xMax=scaleX.max;

    /* y축: 활성 소자의 실제 데이터 범위 */
    var absMax=Math.max(Math.abs(dataMinI),Math.abs(dataMaxI),1e-30);
    var scaleY=_niceScale(absMax*1.05,4);
    var yMax=scaleY.max;
    var yMin=(dataMinI<-1e-30)?-scaleY.max:0;
    var yRange=yMax-yMin;

    function toPixX(t){ return PAD.left+t/xMax*gW; }
    function toPixY(iv){ return PAD.top+gH-(iv-yMin)/yRange*gH; }

    /* ── 그리드선 ── */
    _ctx.save();
    var yStep=scaleY.step, xStep=scaleX.step;
    for(var yv=yMin; yv<=yMax+yStep*0.001; yv+=yStep){
      var py=Math.round(toPixY(yv))+0.5;
      if(py<PAD.top-1||py>PAD.top+gH+1) continue;
      var isZero=Math.abs(yv)<yStep*0.01;
      _ctx.strokeStyle=isZero?'rgba(0,0,0,0.55)':'rgba(0,0,0,0.13)';
      _ctx.lineWidth=isZero?1.2:0.7;
      _ctx.beginPath(); _ctx.moveTo(PAD.left,py); _ctx.lineTo(PAD.left+gW,py); _ctx.stroke();
    }
    for(var xv=0; xv<=xMax+xStep*0.001; xv+=xStep){
      var px=Math.round(toPixX(xv))+0.5;
      if(px<PAD.left-1||px>PAD.left+gW+1) continue;
      var isOrg=xv<xStep*0.01;
      _ctx.strokeStyle=isOrg?'rgba(0,0,0,0.55)':'rgba(0,0,0,0.13)';
      _ctx.lineWidth=isOrg?1.2:0.7;
      _ctx.beginPath(); _ctx.moveTo(px,PAD.top); _ctx.lineTo(px,PAD.top+gH); _ctx.stroke();
    }
    _ctx.restore();

    /* ── 축 테두리 ── */
    _ctx.save();
    _ctx.strokeStyle='rgba(0,0,0,0.8)'; _ctx.lineWidth=1.2;
    _ctx.strokeRect(PAD.left+0.5,PAD.top+0.5,gW,gH);
    _ctx.restore();

    /* ── Y 눈금 레이블 ── */
    _ctx.save();
    _ctx.font='10px '+App.SN.TOKENS.font;
    _ctx.textAlign='right'; _ctx.textBaseline='middle';
    for(var yv2=yMin; yv2<=yMax+yStep*0.001; yv2+=yStep){
      var py2=Math.round(toPixY(yv2))+0.5;
      if(py2<PAD.top-1||py2>PAD.top+gH+1) continue;
      _ctx.fillStyle=Math.abs(yv2)<yStep*0.01?'#000000':'#3d4453';
      _ctx.fillText(_fmtVal(yv2,false), PAD.left-5, py2);
    }
    _ctx.restore();

    /* ── X 눈금 레이블 ── */
    _ctx.save();
    _ctx.font='10px '+App.SN.TOKENS.font;
    _ctx.textAlign='center'; _ctx.textBaseline='top';
    for(var xv2=0; xv2<=xMax+xStep*0.001; xv2+=xStep){
      var px2=Math.round(toPixX(xv2))+0.5;
      if(px2<PAD.left-1||px2>PAD.left+gW+1) continue;
      _ctx.fillStyle=xv2<xStep*0.01?'#000000':'#3d4453';
      _ctx.fillText(_fmtVal(xv2,true), px2, PAD.top+gH+5);
    }
    _ctx.restore();

    /* ── 커브 렌더 + 수식 레이블 ── */
    /* 레이블 y충돌 방지용 */
    var usedLabelY=[];
    function freeLabelY(preferY, lineH){
      var y=preferY;
      var tries=0;
      while(tries<20){
        var ok=true;
        for(var ui=0;ui<usedLabelY.length;ui++){
          if(Math.abs(usedLabelY[ui]-y)<lineH){ok=false;break;}
        }
        if(ok) break;
        y-=lineH;
        tries++;
      }
      usedLabelY.push(y);
      return y;
    }

    _compList.forEach(function(c){
      if(!_active[c.id]||!_history[c.id]) return;
      var arr=_history[c.id];
      var N=arr.length;

      var rgb=c.color.replace('#','');
      var r=parseInt(rgb.slice(0,2),16),g2=parseInt(rgb.slice(2,4),16),b2=parseInt(rgb.slice(4,6),16);

      /* 커브 아래 그라데이션 — t=0에서 수직 점프 없이 시작 */
      _ctx.save();
      _ctx.beginPath();
      var started=false;
      for(var k=0;k<N;k++){
        var t=k/(N-1)*_tMax;
        if(t>xMax*1.001) break;
        var pxk=toPixX(t), pyk=toPixY(arr[k]);
        if(!started){
          _ctx.moveTo(pxk, toPixY(0)); /* 그라데이션 하단 시작 */
          _ctx.lineTo(pxk, pyk);        /* 첫 값으로 이동 (수직) */
          started=true;
        } else {
          _ctx.lineTo(pxk,pyk);
        }
      }
      var tClip=Math.min(_tMax,xMax);
      var kClip=Math.round((tClip/_tMax)*(N-1));
      _ctx.lineTo(toPixX(tClip), toPixY(arr[Math.min(kClip,N-1)]));
      _ctx.lineTo(toPixX(tClip), toPixY(0));
      _ctx.closePath();
      var grad=_ctx.createLinearGradient(0,PAD.top,0,PAD.top+gH);
      grad.addColorStop(0,'rgba('+r+','+g2+','+b2+',0.22)');
      grad.addColorStop(1,'rgba('+r+','+g2+','+b2+',0.02)');
      _ctx.fillStyle=grad;
      _ctx.fill();
      _ctx.restore();

      /* 커브 라인 — arr[0]이 t=0의 정확한 초기값 */
      _ctx.save();
      _ctx.beginPath();
      _ctx.strokeStyle=c.color; _ctx.lineWidth=2.2; _ctx.lineJoin='round';
      var started2=false;
      var lastPxk=PAD.left, lastPyk=PAD.top+gH;
      for(var k2=0;k2<N;k2++){
        var t2=k2/(N-1)*_tMax;
        if(t2>xMax*1.001) break;
        var pxk2=toPixX(t2), pyk2=toPixY(arr[k2]);
        if(!started2){_ctx.moveTo(pxk2,pyk2);started2=true;}
        else _ctx.lineTo(pxk2,pyk2);
        lastPxk=pxk2; lastPyk=pyk2;
      }
      if(started2) _ctx.stroke();

      /* 종점 강조 */
      if(started){
        _ctx.beginPath(); _ctx.arc(lastPxk,lastPyk,3.5,0,Math.PI*2);
        _ctx.strokeStyle='#ffffff'; _ctx.lineWidth=2; _ctx.stroke();
        _ctx.fillStyle=c.color; _ctx.fill();
      }
      _ctx.restore();

      /* ── 수식 레이블 ──────────────────────────────────────────────
       * _systemPoles(Schur complement 극점) 기반 정확한 수식 표기.
       * 배열 역산 대신 실제 시스템 고유값(α, ωd)을 직접 사용.
       *
       * 판별: 증가형(RL-like) vs 감소형(RC-like)
       *   |arr[N-1]| > |arr[0]| * 0.5  → 증가형
       *
       * 수식 형식:
       *   단순(isOsc=false):
       *     증가: I∞·(1−e^(−αt))
       *     감소: I₀·e^(−αt)
       *   진동(isOsc=true):
       *     증가: I∞·(1−e^(−αt)·(cos+sin 항))
       *     감소: e^(−αt)·(I₀·cos(ωdt)+…)
       *   α 대신 1/τ 표기: τ = 1/α
       * ──────────────────────────────────────────────────────────── */
      var N_f=arr.length;
      var Iinf_f=arr[N_f-1];
      var absIinf_f=Math.abs(Iinf_f);
      var absI0_f=Math.abs(arr[0]);
      var absPeak_f=0;
      for(var kf=0;kf<N_f;kf++) if(Math.abs(arr[kf])>absPeak_f) absPeak_f=Math.abs(arr[kf]);

      var isRising_f=absIinf_f>absPeak_f*0.5;

      var alpha_f =_systemPoles.alpha;
      var wd_f    =_systemPoles.omegad;
      var isOsc_f =_systemPoles.isOsc;

      function fmtRate(r){
        var v,u;
        if(r>=1e6){v=(r/1e6).toPrecision(3);u='\\,\\mathrm{M/s}';}
        else if(r>=1e3){v=(r/1e3).toPrecision(3);u='\\,\\mathrm{k/s}';}
        else if(r>=1){v=r.toPrecision(3);u='\\,\\mathrm{/s}';}
        else if(r>=1e-3){v=(r*1e3).toPrecision(3);u='\\,\\mathrm{/ms}';}
        else{v=(r*1e6).toPrecision(3);u='\\,/\\mu\\mathrm{s}';}  /* µ → \mu */
        return v+u;
      }
      function fmtFreq(w){
        var v,u;
        if(w>=1e6){v=(w/1e6).toPrecision(3);u='\\,\\mathrm{Mrad/s}';}
        else if(w>=1e3){v=(w/1e3).toPrecision(3);u='\\,\\mathrm{krad/s}';}
        else if(w>=1){v=w.toPrecision(3);u='\\,\\mathrm{rad/s}';}
        else{v=(w*1e3).toPrecision(3);u='\\,\\mathrm{rad/ms}';}
        return v+u;
      }

      /* _fmtVal 반환값의 유니코드 µ (U+00B5) → LaTeX \mu 치환 */
      function toLatex(s){
        return s.replace(/µ/g,'\\mu ');
      }

      var Iinf_s='\\mathrm{'+toLatex(_fmtVal(absIinf_f,false))+'}';
      var I0_s  ='\\mathrm{'+toLatex(_fmtVal(absI0_f||absPeak_f,false))+'}';

      var formula='';
      if(isOsc_f){
        var a_tex=fmtRate(alpha_f);
        var w_tex=fmtFreq(wd_f);
        if(isRising_f)
          formula=Iinf_s+'\\!\\left(1-e^{-'+a_tex+'\\cdot t}\\bigl(\\cos('+w_tex+'\\cdot t)+\\cdots\\bigr)\\right)';
        else
          formula=I0_s+'\\,e^{-'+a_tex+'\\cdot t}\\bigl(\\cos('+w_tex+'\\cdot t)+\\cdots\\bigr)';
      } else {
        var tau_f=alpha_f>1e-10?1/alpha_f:_tMax;
        var tau_s='\\mathrm{'+toLatex(_fmtVal(tau_f,true))+'}';
        if(isRising_f) formula=Iinf_s+'\\!\\left(1-e^{-t/'+tau_s+'}\\right)';
        else           formula=I0_s+'\\,e^{-t/'+tau_s+'}';
      }

      var kMid=Math.round(0.4*(N_f-1)*Math.min(xMax,_tMax)/_tMax);
      kMid=Math.max(0,Math.min(N_f-1,kMid));
      var labelPreferY=toPixY(arr[kMid])-14;
      labelPreferY=Math.max(PAD.top+2,Math.min(PAD.top+gH-14,labelPreferY));
      var labelY=freeLabelY(labelPreferY,14);

      /* KaTeX DOM 오버레이용 데이터 수집 */
      _pendingLabels.push({formula:formula, lx:null, ly:labelY, color:c.color, preferLx:PAD.left+gW*0.38, gW:gW, PAD_left:PAD.left});
    });

    /* ── 축 레이블 ── */
    _ctx.save();
    _ctx.font='italic 11px '+App.SN.TOKENS.font;
    _ctx.fillStyle='#000000';
    _ctx.textAlign='left'; _ctx.textBaseline='top';
    _ctx.fillText('i(t)', PAD.left+4, PAD.top+3);
    _ctx.textAlign='right'; _ctx.textBaseline='bottom';
    _ctx.fillText('t →', PAD.left+gW-2, PAD.top+gH-3);
    _ctx.restore();

    /* ── KaTeX DOM 오버레이 ──────────────────────────────────────────
     * 캔버스 위에 절대 위치 div를 올려 KaTeX로 수식을 렌더링.
     * 캔버스 재드로우 시 기존 레이블 div를 모두 제거 후 재생성.
     * ────────────────────────────────────────────────────────────── */
    var cvContainer=_cv.parentElement;
    /* 기존 수식 레이블 div 모두 제거 */
    var oldLabels=cvContainer.querySelectorAll('.tg-formula-label');
    for(var oi=0;oi<oldLabels.length;oi++) oldLabels[oi].parentNode.removeChild(oldLabels[oi]);

    /* KaTeX가 로드되어 있을 때만 렌더링 */
    if(typeof katex!=='undefined'&&_pendingLabels.length>0){
      var cvRect=_cv.getBoundingClientRect();
      var conRect=cvContainer.getBoundingClientRect();
      var offX=cvRect.left-conRect.left;
      var offY=cvRect.top-conRect.top;

      _pendingLabels.forEach(function(lb){
        var div=document.createElement('div');
        div.className='tg-formula-label';
        div.style.cssText=[
          'position:absolute',
          'pointer-events:none',
          'z-index:30',
          'white-space:nowrap',
          'background:rgba(255,255,255,0.86)',
          'border-radius:3px',
          'padding:1px 4px',
          'color:'+lb.color,
          'top:'+(offY+lb.ly-8)+'px',
          'left:'+(offX+lb.preferLx)+'px',
          'max-width:'+(lb.gW*0.55)+'px'
        ].join(';');

        try{
          katex.render(lb.formula,div,{throwOnError:false,displayMode:false,fontSize:'9px'});
        } catch(e){
          div.textContent=lb.formula;
        }

        /* 오른쪽 경계 초과 방지: 렌더 후 위치 재조정 */
        cvContainer.appendChild(div);
        var dw=div.offsetWidth;
        var maxLeft=offX+lb.PAD_left+lb.gW-dw-4;
        if(offX+lb.preferLx+dw>offX+lb.PAD_left+lb.gW){
          div.style.left=maxLeft+'px';
        }
      });
    } else if(_pendingLabels.length>0){
      /* KaTeX 미로드 시 캔버스 폴백 */
      _pendingLabels.forEach(function(lb){
        _ctx.save();
        _ctx.font='italic 9px '+App.SN.TOKENS.font;
        _ctx.textAlign='left'; _ctx.textBaseline='middle';
        var tw=_ctx.measureText(lb.formula).width;
        var lx=lb.preferLx;
        if(lx+tw+6>lb.PAD_left+lb.gW) lx=lb.PAD_left+lb.gW-tw-6;
        _ctx.fillStyle='rgba(255,255,255,0.85)';
        _ctx.fillRect(lx-2,lb.ly-7,tw+6,14);
        _ctx.fillStyle=lb.color;
        _ctx.fillText(lb.formula,lx,lb.ly);
        _ctx.restore();
      });
    }
  }

  /* ── 공개 API ── */
  function show(){
    var params=_extractParams();
    if(!params){return;}
    var panel=document.getElementById('transient-panel');
    if(!panel) return;
    _cv=document.getElementById('transient-canvas');
    _ctx=_cv.getContext('2d');
    _tMax=0.1;
    _history=_computeTransient(params);
    _buildToggles(params);
    panel.classList.add('visible');
    _running=true;
    /* 패널이 보이고 나서 크기가 확정된 뒤 그래프 그리기 */
    requestAnimationFrame(function(){
      requestAnimationFrame(_drawGraph);
    });
    /* ResizeObserver: 패널 크기 변화(모바일 방향 전환 등) 시 자동 재렌더 */
    if(window.ResizeObserver && !_resizeObs){
      _resizeObs=new ResizeObserver(function(){
        if(_running) requestAnimationFrame(_drawGraph);
      });
      _resizeObs.observe(panel);
    }
  }

  function hide(){
    var panel=document.getElementById('transient-panel');
    if(panel) panel.classList.remove('visible');
    _running=false;
    if(_resizeObs){_resizeObs.disconnect();_resizeObs=null;}
  }

  function toggle(){
    var panel=document.getElementById('transient-panel');
    if(!panel) return;
    if(panel.classList.contains('visible')) hide();
    else show();
  }

  function init(){
    var closeBtn=document.getElementById('tp-close-btn');
    if(closeBtn) closeBtn.addEventListener('click',function(){
      hide();
      var gb=document.getElementById('mobile-graph-btn');
      if(gb) gb.classList.remove('graph-active');
    });
    App.Events.on('solver:done',function(){
      if(_running) show();
    });
  }

  /* ── 비유 모드 재사용: 과도응답 핏 데이터 계산/반환 ──
   *   반환: { byId:{compId:{amp,tau,isRising}}, domTau:지배시상수 }
   *   동적 소자(L/C)가 없으면 null. 패널 표시 여부와 무관하게 계산. */
  function getTransientData(){
    var params=_extractParams();
    if(!params) return null;
    var savedTMax=_tMax, savedPoles=_systemPoles;
    _computeTransient(params);   /* _fitData, _domTau, _branchModel 갱신 (부수효과로 _tMax 변경) */
    var data={ byId:_fitData, domTau:_domTau, branchModel:_branchModel };
    /* 패널이 실행 중이 아니면 _tMax 등 원복 (그래프 상태 보호) */
    if(!_running){ _tMax=savedTMax; _systemPoles=savedPoles; }
    return data;
  }

  return{init:init, show:show, hide:hide, toggle:toggle,
         _extractParams:_extractParams, getTransientData:getTransientData};
})();

}());
