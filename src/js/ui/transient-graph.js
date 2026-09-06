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

  /* 과감쇠 2차 곡선의 모드 분해 (수식 라벨용)
   *   { compId → {F, slow:{A,tau}, fast:{A,tau}|null, peakDev} }
   *   i(t) = F + A_s·e^{−t/τ_s} (+ A_f·e^{−t/τ_f})
   *   2차 비진동 경로에서만 채워지며, 항목이 없으면 1차 라벨로 폴백. */
  var _secondFit={};

  /* 전 소자/도선 시변 전류 모델 (비유 모드 재사용용)
   *   _branchModel = { byComp:{compId:{i0,iinf,tau,s0,sinf}}, byWire, byNode, domTau }
   *   각 가지 전류는 i(t) = iinf + (i0−iinf)·e^(−t/τ) (1차 지수 모델).
   *   τ: L·C와 그 인접 도선은 소자별 Thevenin τ, 그 외는 지배 τ 근사. */
  var _branchModel=null;

  /* 회로 파라미터 추출 (DC 회로 + 동적 소자 L/C 존재 시에만) */
  function _extractParams(){
    var comps=App.State.components;
    var sr=App.State.solverResult;
    if(!sr||!sr.valid||sr.acPhasor) return null; /* DC만 */
    /* 비선형 소자(다이오드·BJT)가 있으면 이 선형 과도 모델은 맞지 않는다 —
     *   시간 영역 엔진(C 단계)으로 대체될 때까지 그래프를 띄우지 않는다 */
    if(comps.some(function(c){return NONLINEAR_TYPES[c.type];})) return null;

    var caps=comps.filter(function(c){return c.type===TYPE.CAPACITOR;});
    var inds=comps.filter(function(c){return c.type===TYPE.INDUCTOR;});
    var ress=comps.filter(function(c){return c.type===TYPE.RESISTOR;});
    var srcs=comps.filter(function(c){return c.type===TYPE.DC_SOURCE;});

    if(!caps.length&&!inds.length) return null; /* 동적 소자 없음 */

    var Req=ress.reduce(function(s,r){return s+(r.value||0);},0)||1;  // 등가 저항(직렬 합산)
    var Vsrc=srcs.length>0?(srcs[0].value||0):0;                      // 등가 전압원

    return{Req:Req, Vsrc:Vsrc, caps:caps, inds:inds};
  }

  /* ── 과도 응답 해석 ─────────────────────────────────────────────────
   *
   * 두 단계 파이프라인:
   *
   * (1) 저항성 IC 시스템 두 번 풀기 (L/C를 개방·단락으로 치환한 DC 해석)
   *     IC_0  (L=개방, C=단락): t=0 초기조건 + V_oc(L), I_0(C)
   *     IC_inf(L=단락, C=개방): t=∞ 정상상태 + I_inf(L), V_inf(C)
   *     → 소자별 Thevenin 시상수:
   *        τ_L = L·I_inf/V_oc  (R_th = V_oc/I_inf)
   *        τ_C = C·V_inf/I_0   (R_th = V_inf/I_0)
   *
   * (2a) 1차 회로 (L만 또는 C만): 위 값이 곧 정확한 해석해이므로
   *      곡선을 직접 생성한다.
   *        L(증가형): i(t) = I_inf·(1 − e^{−t/τ})
   *        C(감소형): i(t) = I_0·e^{−t/τ}
   *      같은 종류 소자가 여럿이면 소자별 개방/단락 시상수 근사(OCTC).
   *
   * (2b) 2차 회로 (L·C 공존): 단일 지수로 표현 불가(과감쇠 2중 지수
   *      또는 부족감쇠 진동). MNA 상태공간을 Crank-Nicolson 사다리꼴로
   *      수치적분해 파형을 그대로 사용하고, 파형에서 극점(α, ω_d)을
   *      로그 감쇠법으로 추정해 수식 라벨에 쓴다.
   *      상태변수 x = [노드전압 | 인덕터전류 | 전압원전류]
   *        C_mna·dx/dt + G_mna·x = b
   * ──────────────────────────────────────────────────────────────────── */
  function _computeTransient(params){
    var V=params.Vsrc;
    var caps=params.caps, inds=params.inds;
    var STEPS=1000;
    var result={};
    _branchModel=null;   /* 매 계산마다 초기화 */
    _secondFit={};

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

    /* ── 폴백 (노드 정보 없음): 전 소자 직렬 가정 1차 근사 ──
     *   1패스: 소자별 τ·진폭 수집 → 공통 시간축(5·τ_max) 확정
     *   2패스: 공통 축 위에서 소자별 τ로 곡선 생성
     *   (기존에는 생성 도중 _tMax가 자라 먼저 만든 곡선의 축이 어긋났고,
     *    show()가 남긴 0.1s 바닥값보다 짧아질 수도 없었다) */
    if(!cn){
      var Req=Math.max(params.Req,1e-3);
      _fitData={}; _domTau=0;
      var fbByComp={};
      var fbFits=[];
      inds.forEach(function(ind){
        var L=ind.value||1e-3, tau=L/Req, Iinf=V/Req;
        fbFits.push({id:ind.id, tau:tau, amp:Iinf, isRising:true, i0:0, iinf:Iinf});
      });
      caps.forEach(function(cap){
        var C=cap.value||1e-6, tau=Req*C, I0=V/Req;
        fbFits.push({id:cap.id, tau:tau, amp:I0, isRising:false, i0:I0, iinf:0});
      });
      fbFits.forEach(function(f){ _domTau=Math.max(_domTau,f.tau); });
      _tMax=Math.max(5*_domTau,1e-9);
      _systemPoles={alpha:_domTau>0?1/_domTau:0, omegad:0, isOsc:false};
      fbFits.forEach(function(f){
        _fitData[f.id]={amp:f.amp, tau:f.tau, isRising:f.isRising};
        fbByComp[f.id]={i0:f.i0, iinf:f.iinf, tau:f.tau, s0:f.i0, sinf:f.iinf};
        var a=new Float32Array(STEPS);
        for(var k=0;k<STEPS;k++){
          var t=k/(STEPS-1)*_tMax;
          a[k]=f.isRising ? f.amp*(1-Math.exp(-t/f.tau)) : f.amp*Math.exp(-t/f.tau);
        }
        result[f.id]=a;
      });
      _branchModel={byComp:fbByComp, byWire:{}, byNode:null, compNodes:null, domTau:_domTau};
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

    /* ── 4. 소자별 Thevenin 1차 모델 (τ·진폭) ──────────────────────
     *
     * τ_L = L · I_inf / V_oc   (R_th = V_oc/I_inf,  τ = L/R_th)
     *   V_oc : IC_0 (L=개방)에서 L 단자 개방전압
     *   I_inf: IC_inf(L=단락)에서 인덕터 단락전류 = 정상상태 전류
     * τ_C = C · V_inf / I_0    (R_th = V_inf/I_0,  τ = R_th·C)
     *   I_0  : IC_0 (C=단락)에서 C 단락전류 = 초기 충전전류
     *   V_inf: IC_inf(C=개방)에서 C 양단 개방전압 = 정상상태 전압
     *
     * 동적 소자가 1개면 이 τ가 곧 정확한 해석해(1차 회로).
     * 같은 종류가 여럿이면 소자별 개방/단락 시상수(OCTC) 근사가 된다.
     * (dt 기반 수치 미분은 C/dt 조건수 폭발로 불안정 — Thevenin 공식 고정)
     * ──────────────────────────────────────────────────────────────── */
    var elemFit={};   /* compId → {tau, amp, isRising} */

    /* 개방 근사 한계: solveIC 의 '개방'은 G_OPEN=1e-9 S(1GΩ) 저항 근사라
     *   완전 개방 회로에서도 ~nA 누설전류가 계산된다. Thevenin 저항이
     *   이 한계(0.1/G_OPEN)를 넘으면 물리적 개방(전류 없음)으로 판정한다.
     *   (예: 직렬 RLC 에서 C 의 I_0: L 개방이 전류를 막아 실제 0인데,
     *    누설 12nA 가 가드를 통과하면 τ_C = C·1GΩ = 10⁵s 가 되는 병리) */
    var R_OPEN_LIMIT=0.1/1e-9;   /* = 1e8 Ω */

    inds.forEach(function(ind,k){
      var nn=cn[ind.id];if(!nn)return;
      var p=nIdx(nn[0]),q=nIdx(nn[1]);
      var V_oc=sol0?Math.abs((p>=0?sol0[p]:0)-(q>=0?sol0[q]:0)):0;
      var I_inf=solinf?Math.abs(solinf[L_ICinf_OFF+k]||0):0;
      var L=ind.value||1e-3;
      var tau, amp;
      if(V_oc>1e-12&&I_inf>1e-15&&(V_oc/I_inf)<R_OPEN_LIMIT){
        tau=L*I_inf/V_oc; amp=I_inf;              /* R_th = V_oc/I_inf */
      } else {
        tau=L/Math.max(params.Req,1);             /* 직렬 근사 폴백 */
        amp=0;                                    /* 개방/누설 판정 → 전류 없음 */
      }
      elemFit[ind.id]={tau:tau, amp:amp, isRising:true};
    });

    caps.forEach(function(cap,k){
      var nn=cn[cap.id];if(!nn)return;
      var p=nIdx(nn[0]),q=nIdx(nn[1]);
      var I_0=sol0?Math.abs(sol0[C_IC0_OFF+k]||0):0;
      var V_inf=solinf?Math.abs((p>=0?solinf[p]:0)-(q>=0?solinf[q]:0)):0;
      var C=cap.value||1e-6;
      var tau, amp;
      if(I_0>1e-15&&V_inf>1e-12&&(V_inf/I_0)<R_OPEN_LIMIT){
        tau=C*V_inf/I_0; amp=I_0;                 /* R_th = V_inf/I_0 */
      } else {
        tau=Math.max(params.Req,1)*C;             /* 직렬 근사 폴백 */
        amp=0;                                    /* 개방/누설 판정 → 전류 없음 */
      }
      elemFit[cap.id]={tau:tau, amp:amp, isRising:false};
    });

    /* 지배(최대) 시상수 — 전류가 실제로 흐르는 소자 우선 */
    var domTau=0, anyTau=0;
    Object.keys(elemFit).forEach(function(id){
      var f=elemFit[id];
      if(!(f.tau>1e-15&&isFinite(f.tau))) return;
      anyTau=Math.max(anyTau,f.tau);
      if(f.amp>1e-15) domTau=Math.max(domTau,f.tau);
    });
    if(!(domTau>0)) domTau=anyTau>0?anyTau:Math.max(params.Req,1)*1e-6;

    /* 시간축: 5·τ_dom. L·C 공존(2차)이면 공진 주기(≈3주기분)도 포함 */
    var isSecondOrder=(nL>0&&nC>0);
    var span=5*domTau;
    if(isSecondOrder){
      var Ltot=inds.reduce(function(s,l){return s+(l.value||0);},0)||1e-3;
      var Ctot=1/caps.reduce(function(s,c){return s+1/(c.value||1e-6);},0);
      span=Math.max(span,20*Math.sqrt(Ltot*Ctot));
    }
    _tMax=span;
    _domTau=domTau;
    _fitData=elemFit;
    _systemPoles={alpha:domTau>0?1/domTau:0, omegad:0, isOsc:false};

    /* ══════════════════════════════════════════════════════════════════
     * ── 5. 전 소자/도선/노드 시변 모델 구축 (비유 모드 재사용) ──
     *   sol0  : t=0  (L 개방, C 단락) 노드전압 + 전원전류 + C단락전류
     *   solinf: t=∞ (L 단락, C 개방) 노드전압 + 전원전류 + L단락전류
     *   각 가지: i(t) = iinf + (i0 − iinf)·e^{−t/τ}
     *   τ: L·C는 소자별 Thevenin τ(1차 회로에서 정확),
     *      그 외 가지·노드는 여러 모드의 중첩이라 τ_dom 단일 지수 근사.
     * ══════════════════════════════════════════════════════════════════ */
    (function(){
      var byComp={}, byWire={};

      function nodeVolt(sol,node){ var i=nIdx(node); return (i>=0&&sol)?sol[i]:0; }

      /* 소자별 부호 있는 i0·iinf — ports[0]→ports[1] 방향이 양(+).
       *   저항: i=(Vp−Vq)/R, 전원: MNA 보조 미지수,
       *   L: i0=0·iinf=단락전류, C: i0=단락전류·iinf=0.
       *   s0/sinf는 같은 값의 별칭(도선 방향 결정용 부호 보존본). */
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
        var tau=(elemFit[c.id]&&elemFit[c.id].tau>1e-15)?elemFit[c.id].tau:domTau;
        byComp[c.id]={i0:i0, iinf:iinf, tau:tau, s0:i0, sinf:iinf};
      });

      /* ── 노드별 시변 전위 모델 (#3) ──
       *   v_node(t) = vinf + (v0 − vinf)·e^{−t/τ_dom}
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
       *   도선 방향에 맞춰 변환한다. τ도 기준 소자의 τ를 따른다
       *   (C 옆 도선은 τ_C 로 감쇠 — 지배 τ만 쓰면 빠른 가지가 느리게 보임).
       *   refPortIdx: 도선이 붙은 소자 포트의 순서(0/1). 소자 부호전류 s0는
       *   ports[0]→ports[1] 가 +. 도선이 ports[1]에 붙으면 전류가 소자에서
       *   도선으로 나가는(+) 방향이 도선 from→to 와 정렬됨(refIsFrom 고려). */
      App.State.wires.forEach(function(w){
        var fromComp=App.State.getComponent(w.fromId);
        var toComp=App.State.getComponent(w.toId);
        var isJ=function(cc){return cc&&(NODE_TYPES[cc.type]||cc.type===TYPE.SWITCH);};
        var refId=null, refIsFrom=true, refPort=null;
        if(!isJ(fromComp) && byComp[w.fromId]){ refId=w.fromId; refIsFrom=true; refPort=w.fromPort; }
        else if(!isJ(toComp) && byComp[w.toId]){ refId=w.toId; refIsFrom=false; refPort=w.toPort; }
        if(!refId){ byWire[w.id]={i0:0,iinf:0,tau:domTau,signed:false}; return; }
        var rc=byComp[refId];
        var refComp=App.State.getComponent(refId);
        var refPorts=App.Geo.getCompPorts(refComp);
        var refPortIdx=refPorts.indexOf(refPort);
        byWire[w.id]={ i0:Math.abs(rc.i0), iinf:Math.abs(rc.iinf), tau:rc.tau,
                       refId:refId, refIsFrom:refIsFrom, refPortIdx:refPortIdx };
      });

      _branchModel={ byComp:byComp, byWire:byWire, byNode:byNode,
                     compNodes:cn, domTau:domTau };
    })();
    /* ══════════════════════════════════════════════════════════════════
     * ── 6. 1차 회로 (L만 또는 C만): 해석적 곡선 생성 ──
     *   Thevenin τ·진폭이 곧 정확한 해석해이므로 수치적분이 불필요하다.
     *   (기존: CN 적분 → 고정점 2점 로그 핏 → 지수 재생성 — 같은 물리를
     *    3중 계산했고, 시상수가 크게 다른 소자가 섞이면 빠른 소자의 핏이
     *    수치 언더플로로 실패해 지배 τ로 잘못 대체되는 오류가 있었다)
     * ══════════════════════════════════════════════════════════════════ */
    if(!isSecondOrder){
      var mkCurve=function(f){
        var arr=new Float32Array(STEPS);
        for(var k=0;k<STEPS;k++){
          var t=k/(STEPS-1)*_tMax;
          arr[k]=f.isRising ? f.amp*(1-Math.exp(-t/f.tau))
                            : f.amp*Math.exp(-t/f.tau);
        }
        return arr;
      };
      inds.concat(caps).forEach(function(c){
        var f=elemFit[c.id]; if(!f) return;
        if(!(f.tau>1e-15&&isFinite(f.tau))) f.tau=domTau;
        result[c.id]=mkCurve(f);
      });
      return result;
    }

    /* ══════════════════════════════════════════════════════════════════
     * ── 7. 2차 회로 (L·C 공존): MNA + Crank-Nicolson 수치적분 ──
     *   2차 응답(과감쇠 2중 지수·부족감쇠 진동)은 단일 지수로 표현될 수
     *   없으므로 수치 파형을 그대로 그래프에 사용한다.
     *   (기존의 지수 재생성은 부족감쇠 진동을 지워버리는 오류였다)
     * ══════════════════════════════════════════════════════════════════ */
    var dt=_tMax/STEPS;
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
      /* 전류 변수 i_k: nn[1]→nn[0] 방향이 +.
       *   가지행 ki: L·di/dt + v_p − v_q = 0, 노드행: p에 −i_k, q에 +i_k */
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

    /* 초기 상태: t=0 해 (C 단락 노드전압, i_L=0) */
    var x=vec(N);
    if(sol0){
      for(var i5=0;i5<nNodes;i5++) x[i5]=sol0[i5];
      for(var k5=0;k5<nL;k5++)     x[L_OFF+k5]=0;
      for(var k6=0;k6<nVs;k6++)    x[V_OFF+k6]=sol0[nNodes+k6];
    }

    /* 대수 행(미분항 없는 행)은 사다리꼴 평균 대신 현재 시점 방정식 사용 */
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

    var iL_arrs=inds.map(function(ind){return{id:ind.id,arr:new Float32Array(STEPS)};});
    var iC_arrs=caps.map(function(cap){
      return{id:cap.id,arr:new Float32Array(STEPS),nn:cn[cap.id],Cv:cap.value||1e-6};
    });

    /* ── 적분 루프 ── */
    var xp=new Float64Array(x);
    for(var step=0;step<STEPS;step++){

      /* 인덕터 전류 — ports[0]→ports[1] 방향으로 부호 변환(−x).
       *   부족감쇠 진동은 0을 교차하므로 절댓값을 취하면 파형이 접힌다. */
      for(var k=0;k<nL;k++) iL_arrs[k].arr[step]=-xp[L_OFF+k];

      var rhs=matvec(B_mat,xp);
      for(var i=0;i<N;i++)rhs[i]+=b_vec[i];
      var xn=solve(A_mat,rhs);
      if(!xn)break;

      /* 커패시터 전류 i_C = C·Δv/dt (부호 유지)
       * step=0: forward diff = t=0⁺ 초기전류로 arr[0]·arr[1]을 채워 연속 */
      iC_arrs.forEach(function(ci){
        var nn=ci.nn;if(!nn)return;
        var p=nIdx(nn[0]),q=nIdx(nn[1]);
        var dvn=(p>=0?xn[p]:0)-(q>=0?xn[q]:0);
        var dvp=(p>=0?xp[p]:0)-(q>=0?xp[q]:0);
        var iC=ci.Cv*(dvn-dvp)/dt;
        if(step===0) ci.arr[0]=iC;
        if(step+1<STEPS) ci.arr[step+1]=iC;
      });

      xp=xn;
    }

    /* 표시 방향 정규화: 파형에서 절댓값이 가장 큰 지점(= 응답의 주 진폭,
     *   보통 최초의 최대 돌입)이 음수면 곡선 전체 부호를 반전한다.
     *   그래프의 관심사는 크기·형태이고 기준 방향은 소자 배치에 따라
     *   임의로 뒤집힐 수 있으므로 양(+) 위주로 정렬한다.
     *
     *   ⚠️ 기준을 '마지막 샘플'로 잡으면 안 된다. 부족감쇠 진동은 0을
     *      교차하므로 창 끝의 위상에 따라 부호가 임의로 정해지고, 같은
     *      회로에서 저항값만 바꿔도 곡선이 통째로 뒤집혀 보였다.
     *      최대 진폭 지점은 창 길이·위상과 무관해 항상 같은 방향을 준다. */
    function canonicalize(arr){
      var refV=0, mag=0;
      for(var k=0;k<arr.length;k++){
        var a=Math.abs(arr[k]);
        if(a>mag){ mag=a; refV=arr[k]; }
      }
      if(refV<0){ for(var k2=0;k2<arr.length;k2++) arr[k2]=-arr[k2]; }
    }
    var poleRef=null, poleDev=0;
    iL_arrs.concat(iC_arrs).forEach(function(o){
      canonicalize(o.arr);
      result[o.id]=o.arr;
      /* 극점 추정 기준: 최종값 대비 편차가 가장 큰 파형 */
      var fin=o.arr[o.arr.length-1], dev=0;
      for(var k=0;k<o.arr.length;k++){var d=Math.abs(o.arr[k]-fin);if(d>dev)dev=d;}
      if(dev>poleDev){poleDev=dev;poleRef=o.arr;}
    });

    /* ── 8. 파형에서 극점(α, ω_d) 추정 → 수식 라벨 ── */
    var poles=poleRef?_estimatePoles(poleRef,_tMax):null;
    if(poles) _systemPoles=poles;

    /* ── 9. 과감쇠 2모드 분해 (라벨용) ──
     *   비진동 2차 곡선은 단일 지수가 아니라 두 시상수의 합이다
     *   (예: L 가지가 켜지며 생기는 초기 급강하 + C 충전의 완만한 감쇠).
     *   곡선별로 분해를 시도하고, 성공 항목만 2항/꼬리 라벨로 쓴다. */
    if(!_systemPoles.isOsc){
      iL_arrs.concat(iC_arrs).forEach(function(o){
        var m2=_fitTwoMode(o.arr,_tMax);
        if(m2) _secondFit[o.id]=m2;
      });
    }

    return result;
  }

  /* ── 과감쇠 2차 파형의 2모드 분해 ────────────────────────────────────
   *   i(t) = F + A_s·e^{−t/τ_s} + A_f·e^{−t/τ_f}   (A 는 부호 포함)
   *   ① 꼬리 구간(0.35T~0.75T)을 로그-선형 최소제곱 핏 → 느린 모드
   *   ② 잔차 r(t) = i − F − A_s·e^{−t/τ_s} 의 초기 구간 → 빠른 모드
   *   빠른 모드는 진폭이 유의미(피크 편차의 5% 이상)하고 시상수가
   *   분리(τ_f < τ_s/3)될 때만 채택. 그 외에는 느린 모드만 반환하고,
   *   꼬리 핏 자체가 실패하면 null(호출부가 1차 라벨로 폴백). */
  function _fitTwoMode(arr, span){
    var N=arr.length; if(N<20) return null;
    var Fend=arr[N-1];
    var peakDev=0;
    for(var k=0;k<N;k++){var dd=Math.abs(arr[k]-Fend);if(dd>peakDev)peakDev=dd;}
    if(!(peakDev>1e-15)) return null;

    /* ① 느린 모드 τ_s: 꼬리 차분(differencing) 로그-선형 최소제곱.
     *   D[k] = arr[k] − arr[k+m] = A_s·e^{−t_k/τ_s}·(1−e^{−mΔt/τ_s})
     *   차분은 상수항(최종값 F)을 소거하므로, 시간축이 완전 수렴 전에
     *   끝나 arr[N−1]≠F 여도 τ_s 추정이 편향되지 않는다. */
    var k1=Math.round(N*0.35), k2=Math.round(N*0.75);
    var m=Math.max(2,Math.round((k2-k1)/6));
    var sgn=0,n=0,Sx=0,Sy=0,Sxx=0,Sxy=0;
    for(var ka=k1;ka+m<=k2;ka++){
      var D=arr[ka]-arr[ka+m];
      if(Math.abs(D)<peakDev*1e-5) break;               /* 수치 바닥 도달 */
      var s=D>=0?1:-1;
      if(sgn===0) sgn=s; else if(s!==sgn) return null;  /* 부호 교차 → 비단조 */
      var t=ka/(N-1)*span, y=Math.log(Math.abs(D));
      Sx+=t; Sy+=y; Sxx+=t*t; Sxy+=t*y; n++;
    }
    if(n<8) return null;
    var den=n*Sxx-Sx*Sx; if(Math.abs(den)<1e-30) return null;
    var slope=(n*Sxy-Sx*Sy)/den;
    if(!(slope<0)) return null;
    var taus=-1/slope;
    if(!(isFinite(taus)&&taus>0&&taus<span*4)) return null;

    /* ② F·A_s 동시 추정: 꼬리에서 arr ≈ F + A_s·u (u=e^{−t/τ_s}) 선형 회귀 */
    var n3=0,Su=0,Suu=0,Sv=0,Suv=0;
    for(var kc=k1;kc<=k2;kc++){
      var t3=kc/(N-1)*span, u=Math.exp(-t3/taus), v=arr[kc];
      Su+=u; Suu+=u*u; Sv+=v; Suv+=u*v; n3++;
    }
    var den3=n3*Suu-Su*Su; if(Math.abs(den3)<1e-30) return null;
    var As=(n3*Suv-Su*Sv)/den3;
    var F=(Sv-As*Su)/n3;
    if(!(isFinite(As)&&isFinite(F))) return null;

    /* ② 빠른 모드: 잔차 초기 구간 핏
     *   잔차는 느린 모드 핏 오차(≈일정 오프셋)에 오염되므로, 잔차가 충분히
     *   큰 초기부(|r| ≥ 20%·|r₀|)만 사용해 기울기 편향을 줄인다.
     *   kb=0 은 CN forward-diff 표본(≈t=dt/2 평균)이라 제외. */
    var fast=null;
    var r0=arr[0]-F-As;
    if(Math.abs(r0)>peakDev*0.05){
      var sgn2=r0>=0?1:-1,n2=0,Sx2=0,Sy2=0,Sxx2=0,Sxy2=0;
      for(var kb=1;kb<k1;kb++){
        var t2=kb/(N-1)*span;
        var r=arr[kb]-F-As*Math.exp(-t2/taus);
        if((r>=0?1:-1)!==sgn2) break;
        if(Math.abs(r)<Math.abs(r0)*0.2) break;         /* 오염 구간 제외 */
        var y2=Math.log(Math.abs(r));
        Sx2+=t2; Sy2+=y2; Sxx2+=t2*t2; Sxy2+=t2*y2; n2++;
      }
      if(n2>=4){
        var den2=n2*Sxx2-Sx2*Sx2;
        if(Math.abs(den2)>1e-30){
          var slope2=(n2*Sxy2-Sx2*Sy2)/den2;
          if(slope2<0){
            var tauf=-1/slope2;
            var Af=sgn2*Math.exp((Sy2-slope2*Sx2)/n2);
            if(isFinite(tauf)&&tauf>0&&tauf<taus/3&&isFinite(Af))
              fast={A:Af,tau:tauf};
          }
        }
      }
    }
    return {F:F, slow:{A:As,tau:taus}, fast:fast, peakDev:peakDev};
  }

  /* ── 2차 응답 파형의 극점 추정 (로그 감쇠법) ─────────────────────────
   *   부족감쇠: 연속 극값 간격 = 반주기 T_d/2 → ω_d = π/Δt,
   *             극값 진폭비 → α = ln(A₁/A₂)/Δt  (감쇠 포락선 e^{−αt})
   *   과감쇠(내부 극값 없음): 꼬리 구간 두 점의 지수 감쇠율로
   *             지배(느린) 극점만 추정. */
  function _estimatePoles(arr, span){
    var N=arr.length; if(N<8) return null;
    var fin=arr[N-1];
    var peakDev=0;
    for(var k=0;k<N;k++){var d=Math.abs(arr[k]-fin);if(d>peakDev)peakDev=d;}
    if(!(peakDev>1e-15)) return null;
    /* 내부 극값 수집 — 최종값 기준 편차의 2% 미만은 수치 잡음으로 무시 */
    var ext=[];
    for(var k2=1;k2<N-1;k2++){
      var d0=arr[k2-1]-fin, d1=arr[k2]-fin, d2=arr[k2+1]-fin;
      if((d1-d0)*(d2-d1)<0 && Math.abs(d1)>peakDev*0.02)
        ext.push({t:k2/(N-1)*span, a:Math.abs(d1)});
    }
    if(ext.length>=2 && ext[1].a>1e-30){
      var half=ext[1].t-ext[0].t;   /* 연속 극값(마루→골) 간격 = 반주기 */
      if(half>0){
        var alpha=Math.log(ext[0].a/ext[1].a)/half;
        return {alpha:Math.max(alpha,0), omegad:Math.PI/half, isOsc:true};
      }
    }
    /* 과감쇠: 꼬리 감쇠율 (느린 극점이 지배하는 구간) */
    var k3=Math.round(N*0.3), k4=Math.round(N*0.7);
    var e1=Math.abs(arr[k3]-fin), e2=Math.abs(arr[k4]-fin);
    if(e1>1e-30&&e2>1e-30&&e1>e2){
      var a2=Math.log(e1/e2)/((k4-k3)/(N-1)*span);
      return {alpha:a2, omegad:0, isOsc:false};
    }
    return null;
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

      var alpha_f =_systemPoles.alpha;
      var wd_f    =_systemPoles.omegad;
      var isOsc_f =_systemPoles.isOsc;

      /* 곡선 방향(증가/감소) 판정:
       *   1차 경로 → _fitData(소자별 해석 모델)가 정확하므로 우선 사용.
       *   진동(2차) → 1차 모델의 방향은 무의미(예: C 차단으로 I_inf=0인
       *   L도 isRising=true). 실제 파형의 최종값/피크 비로 판정한다. */
      var fd_f=_fitData[c.id]||null;
      var isRising_f=(fd_f&&!isOsc_f)?!!fd_f.isRising:(absIinf_f>absPeak_f*0.5);

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
        /* 진동 파형은 t=0 값이 0(또는 미소)에서 시작하므로 진폭은 피크 기준 */
        var Ipk_s='\\mathrm{'+toLatex(_fmtVal(Math.max(absI0_f,absPeak_f),false))+'}';
        if(isRising_f)
          formula=Iinf_s+'\\!\\left(1-e^{-'+a_tex+'\\cdot t}\\bigl(\\cos('+w_tex+'\\cdot t)+\\cdots\\bigr)\\right)';
        else
          formula=Ipk_s+'\\,e^{-'+a_tex+'\\cdot t}\\bigl(\\cos('+w_tex+'\\cdot t)+\\cdots\\bigr)';
      } else {
        var m2=_secondFit?_secondFit[c.id]:null;
        if(m2){
          /* 과감쇠 2차: 파형에서 분해한 모드 합 표기 — 곡선과 라벨 일치.
           *   i(t) = F + A_s·e^{−t/τ_s} (+ A_f·e^{−t/τ_f})
           *   빠른 모드가 무의미하면 느린 모드 1항만 표기된다. */
          var terms=[];
          if(Math.abs(m2.F)>m2.peakDev*0.02)
            terms.push({neg:m2.F<0,
              tex:'\\mathrm{'+toLatex(_fmtVal(Math.abs(m2.F),false))+'}'});
          [m2.slow, m2.fast].forEach(function(md){
            if(!md) return;
            terms.push({neg:md.A<0,
              tex:'\\mathrm{'+toLatex(_fmtVal(Math.abs(md.A),false))+
                  '}\\,e^{-t/\\mathrm{'+toLatex(_fmtVal(md.tau,true))+'}}'});
          });
          formula=terms.map(function(tm,ti){
            return (ti===0?(tm.neg?'-':''):(tm.neg?'-':'+'))+tm.tex;
          }).join('');
        } else {
          /* 곡선별 τ 우선 — 전 소자 공통 지배 τ(1/α)만 쓰면 시상수가 다른
           *   소자의 라벨이 자기 곡선과 어긋난다 */
          var tau_f=(fd_f&&fd_f.tau>1e-15&&isFinite(fd_f.tau))?fd_f.tau
                   :(alpha_f>1e-10?1/alpha_f:_tMax);
          var tau_s='\\mathrm{'+toLatex(_fmtVal(tau_f,true))+'}';
          if(isRising_f) formula=Iinf_s+'\\!\\left(1-e^{-t/'+tau_s+'}\\right)';
          else           formula=I0_s+'\\,e^{-t/'+tau_s+'}';
        }
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

  /* ── 비유 모드·테스트 재사용: 과도응답 데이터 계산/반환 ──
   *   반환: { byId:{compId:{amp,tau,isRising}}, domTau:지배시상수,
   *           branchModel, curves:{compId:Float32Array}, poles:{alpha,omegad,isOsc},
   *           tMax:곡선 시간축 최대(s) }
   *   동적 소자(L/C)가 없으면 null. 패널 표시 여부와 무관하게 계산. */
  function getTransientData(){
    var params=_extractParams();
    if(!params) return null;
    var savedTMax=_tMax, savedPoles=_systemPoles;
    var curves=_computeTransient(params);   /* _fitData, _domTau, _branchModel 갱신 (부수효과로 _tMax 변경) */
    var data={ byId:_fitData, domTau:_domTau, branchModel:_branchModel,
               curves:curves, poles:_systemPoles, tMax:_tMax };
    /* 패널이 실행 중이 아니면 _tMax 등 원복 (그래프 상태 보호) */
    if(!_running){ _tMax=savedTMax; _systemPoles=savedPoles; }
    return data;
  }

  return{init:init, show:show, hide:hide, toggle:toggle,
         _extractParams:_extractParams, getTransientData:getTransientData};
})();

}());
