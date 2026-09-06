(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Solver — 회로 해석 (통합 복소 MNA)
 *
 *   모든 해석은 단일 복소 MNA 코어(_solvePass)로 수행한다:
 *     DC 패스(ω=0): L=단락(SMALL_R), C=개방. AC 전원은 0V(이상 전원=단락).
 *     AC 패스(ω>0): Y_L=−j/(ωL), Y_C=jωC.  DC 전원은 0V.
 *
 *   혼합(DC+AC) 회로는 중첩의 원리로 두 패스를 합성한다:
 *     i(t) = I_dc + Re[I_ac·e^(jωt)]  →  표시값(피크) = |I_dc| + |I_ac|
 *   순수 DC 는 부호 있는 실수값, 순수 AC 는 페이저 크기(피크)로 표시
 *   (기존 결과 계약과 동일).
 *
 *   결과(solverResult)는 _buildResult가 조립:
 *     nodeVoltages, portVoltages, componentVoltages,
 *     branchCurrents, wireCurrents, wireSignedI, componentNodes,
 *     (AC 시) acPhasor { omega, compI, compV, instCurrent, instVoltage }
 *
 *   solve(comps, wires)는 순수 함수(테스트용). run()은 idle 콜백으로
 *   디바운스 실행 (잦은 편집 중 과도한 재계산 방지).
 * ════════════════════════════════════════════════════════════════════ */
App.Solver=(function(){

  /* 물리 근사 상수 */
  var SMALL_R        = 1e-6;  // 인덕터 DC 단락 / 0Ω 저항 대체 (µΩ)
  var R_SER_FALLBACK = 1e-4;  // 특이행렬 시 전압원 직렬저항 (병렬전원 등)
  var OVERCURRENT    = 1e6;   // 과전류(단락) 판정 임계 (A) — 이상 소자
                              // 근사(SMALL_R)의 전류 발산을 '단락'으로 번역

  var _schedId=null;

  /* ── 복소수 연산 헬퍼 — 복소수는 {re, im} 객체 ── */
  function _c(re,im){return{re:re||0,im:im||0};}
  function _cadd(a,b){return{re:a.re+b.re,im:a.im+b.im};}
  function _csub(a,b){return{re:a.re-b.re,im:a.im-b.im};}
  function _cmul(a,b){return{re:a.re*b.re-a.im*b.im,im:a.re*b.im+a.im*b.re};}
  function _cdiv(a,b){var d=b.re*b.re+b.im*b.im;if(d<1e-300)return _c();return{re:(a.re*b.re+a.im*b.im)/d,im:(a.im*b.re-a.re*b.im)/d};}
  function _cabs(a){return Math.hypot(a.re,a.im);}

  /* ── 복소 가우스 소거 (부분 피벗) → 해 벡터 또는 null(특이행렬) ── */
  function _gaussC(A,b){
    var n=b.length;
    var a=A.map(function(r){return r.map(function(v){return{re:v.re,im:v.im};});});
    var x=b.map(function(v){return{re:v.re,im:v.im};});
    for(var col=0;col<n;col++){
      var mx=col, mv=_cabs(a[col][col]);
      for(var rr=col+1;rr<n;rr++){var v=_cabs(a[rr][col]);if(v>mv){mv=v;mx=rr;}}
      if(mv<1e-20) return null;
      if(mx!==col){var t=a[col];a[col]=a[mx];a[mx]=t;var tb=x[col];x[col]=x[mx];x[mx]=tb;}
      var piv=a[col][col];
      for(var r2=col+1;r2<n;r2++){
        var f=_cdiv(a[r2][col],piv);
        for(var cc=col;cc<n;cc++) a[r2][cc]=_csub(a[r2][cc],_cmul(f,a[col][cc]));
        x[r2]=_csub(x[r2],_cmul(f,x[col]));
      }
    }
    var sol=new Array(n);
    for(var i=n-1;i>=0;i--){
      sol[i]=x[i];
      for(var j=i+1;j<n;j++) sol[i]=_csub(sol[i],_cmul(a[i][j],sol[j]));
      sol[i]=_cdiv(sol[i],a[i][i]);
    }
    return sol;
  }

  /* ── 실패 결과 객체 ── */
  function _fail(msg){
    return{valid:false,error:msg,
           nodeVoltages:{},portVoltages:{},
           componentVoltages:{},branchCurrents:{},wireCurrents:{}};
  }

  /* ══════════════════════════════════════════════════════
   *  _solvePass — 복소 MNA 한 패스
   *
   *  omega=0  → DC 해석 (activeKind='DC': DC 전원만 기전력, AC 전원=0V)
   *  omega>0  → AC 페이저 해석 (activeKind='AC': AC 전원만 기전력)
   *  비활성 전원도 0V 이상 전압원으로 스탬프된다 (내부 임피던스 0 = 단락).
   *
   *  회로 방정식:
   *    [Y  B][v]   [0  ]
   *    [Bᵀ D][j] = [v_s]
   *  Y: 노드 어드미턴스, B: 전압원 결합(±1), D: 폴백 직렬저항(−R_ser)
   *
   *  반환: {err} 또는 {nodeV, compV, compI}
   *    nodeV[k] : 노드 k 전압 페이저 (k=0 접지)
   *    compV/compI : 소자별 전압·전류 페이저 (ports[0]→ports[1] 방향 +)
   * ══════════════════════════════════════════════════════ */
  function _solvePass(comps, topo, omega, activeKind){
    var cn=topo.compNodes;
    var n=topo.nodeCount-1;          // 접지 제외 미지수
    if(n<=0) return{err:'회로를 해석할 수 없습니다'};

    /* 전원 수집 — 비활성 종류는 0V 로 */
    var vsrcs=[];
    comps.forEach(function(c){
      if(c.type!==TYPE.DC_SOURCE&&c.type!==TYPE.AC_SOURCE) return;
      var nn=cn[c.id]; if(!nn) return;
      var active=(c.type===TYPE.DC_SOURCE)===(activeKind==='DC');
      vsrcs.push({id:c.id, V:active?(+(c.value)||0):0, posNode:nn[0], negNode:nn[1]});
    });
    if(!vsrcs.length) return{err:'전원이 없습니다'};

    /* 병렬 전압원 검사: 같은 노드 쌍 공유 시 전압이 다르면 물리적 단락,
     * 같으면 중복 제거 (제거된 전원의 전류는 0으로 표시됨 — 비결정 배분) */
    for(var ka=0;ka<vsrcs.length;ka++){
      for(var kb=ka+1;kb<vsrcs.length;kb++){
        var va=vsrcs[ka], vb=vsrcs[kb];
        var sameDir=(va.posNode===vb.posNode&&va.negNode===vb.negNode);
        var revDir =(va.posNode===vb.negNode&&va.negNode===vb.posNode);
        if(!sameDir&&!revDir) continue;
        var effVb=sameDir?vb.V:-vb.V;
        if(Math.abs(va.V-effVb)>0.5)   /* 0.5V 이상 차이 → 단락 */
          return{err:'서로 다른 전압의 전원이 병렬 연결되어 있습니다 (V₁='+va.V+'V, V₂='+vb.V+'V)'};
        vsrcs.splice(kb,1); kb--;
      }
    }

    var m=vsrcs.length;
    var sz=n+m;

    /* ── MNA 행렬 구성 + 풀이 (rser>0: 특이행렬 폴백 재시도) ── */
    function build(rser){
      var G=[], rhs=[];
      for(var i=0;i<sz;i++){
        var row=[]; for(var j=0;j<sz;j++) row.push(_c());
        G.push(row); rhs.push(_c());
      }
      /* 수동소자 어드미턴스 스탬프 */
      comps.forEach(function(c){
        var nn=cn[c.id]; if(!nn) return;
        var Y=null;
        if(c.type===TYPE.RESISTOR){
          Y=_c(1/(c.value>0?c.value:SMALL_R), 0);
        } else if(c.type===TYPE.INDUCTOR){
          if(omega>0){
            var wL=omega*(c.value||SMALL_R);       /* Y_L = −j/(ωL) */
            Y=_c(0, wL>0?-1/wL:-1/SMALL_R);
          } else {
            Y=_c(1/SMALL_R, 0);                    /* DC: 단락 근사 */
          }
        } else if(c.type===TYPE.CAPACITOR){
          if(omega>0) Y=_c(0, omega*(c.value||0)); /* Y_C = jωC */
          /* DC: 개방 → 스탬프 없음 */
        }
        if(!Y||(Y.re===0&&Y.im===0)) return;
        var gA=nn[0]-1, gB=nn[1]-1;
        if(gA>=0) G[gA][gA]=_cadd(G[gA][gA],Y);
        if(gB>=0) G[gB][gB]=_cadd(G[gB][gB],Y);
        if(gA>=0&&gB>=0){G[gA][gB]=_csub(G[gA][gB],Y);G[gB][gA]=_csub(G[gB][gA],Y);}
      });
      /* 전압원 B/Bᵀ 블록 스탬프 */
      vsrcs.forEach(function(vs,k){
        var row=n+k, gP=vs.posNode-1, gN=vs.negNode-1;
        if(gP>=0){G[gP][row].re+=1; G[row][gP].re+=1;}
        if(gN>=0){G[gN][row].re-=1; G[row][gN].re-=1;}
        if(rser>0) G[row][row].re-=rser;           /* D 블록: 내부 전압강하 */
        rhs[row]=_c(vs.V,0);                       /* 기준 페이저 (실수부) */
      });
      return _gaussC(G,rhs);
    }
    var sol=build(0);
    if(!sol) sol=build(R_SER_FALLBACK);
    if(!sol) return{err:'회로를 해석할 수 없습니다'};

    /* 노드전압 페이저 (nodeV[0]=접지) */
    var nodeV=[_c()];
    for(var i2=0;i2<n;i2++) nodeV.push(sol[i2]);

    /* 전원 전류 페이저 (MNA 보조 미지수: +노드에서 전원 내부로 들어가는 방향) */
    var srcI={};
    vsrcs.forEach(function(vs,k){ srcI[vs.id]=sol[n+k]; });

    /* 소자별 전압·전류 페이저 */
    var compV={}, compI={};
    comps.forEach(function(c){
      var nn=cn[c.id]; if(!nn) return;
      var dV=_csub(nodeV[nn[0]]||_c(), nodeV[nn[1]]||_c());
      compV[c.id]=dV;
      switch(c.type){
        case TYPE.DC_SOURCE:
        case TYPE.AC_SOURCE:
          compI[c.id]=srcI[c.id]||_c(); break;     /* 중복 제거된 병렬 전원=0 */
        case TYPE.RESISTOR:
          var R=c.value>0?c.value:SMALL_R;
          compI[c.id]=_c(dV.re/R, dV.im/R); break;
        case TYPE.INDUCTOR:
          if(omega>0){
            var wL2=omega*(c.value||SMALL_R);      /* I = V/(jωL) = V·(−j/ωL) */
            compI[c.id]=wL2>0?_c(dV.im/wL2,-dV.re/wL2):_c();
          } else {
            compI[c.id]=_c(dV.re/SMALL_R, dV.im/SMALL_R);
          }
          break;
        case TYPE.CAPACITOR:
          if(omega>0){
            var wC=omega*(c.value||0);             /* I = V·(jωC) */
            compI[c.id]=_c(-dV.im*wC, dV.re*wC);
          } else {
            compI[c.id]=_c();                      /* DC: 개방 */
          }
          break;
        default:
          compI[c.id]=_c();                        /* JUNCTION 등 */
      }
    });

    /* 과전류(단락) 검사 — 이상 소자 근사(SMALL_R)의 발산 전류를 물리적
     * 단락으로 번역 (예: 전원–인덕터 단독 루프의 DC 정상상태 전류는 ∞) */
    for(var id in compI)
      if(_cabs(compI[id])>OVERCURRENT) return{err:'단락 회로가 감지되었습니다'};

    return{err:null, nodeV:nodeV, compV:compV, compI:compI};
  }

  /* ══════════════════════════════════════════════════════
   *  도선 전류 — DC·AC 공통 단일 구현
   *
   *  각 도선 w 의 채널 전류 {dc, re, im} (fromPort→toPort 방향 +):
   *   (1) 끝점이 비-JUNCTION 소자면 그 소자의 전류에서 직접 결정
   *       (소자 내부 전류 + 는 ports[0]→ports[1]; 도선이 ports[0]에
   *        붙으면 부호 반전, from/to 쪽이면 다시 반전).
   *   (2) 양끝이 JUNCTION 인 도선은 KCL 필링으로 결정:
   *       미지 도선이 1개뿐인 정션부터 잔차(순유입)를 그 도선에 배정,
   *       모두 2개 이상이라 막히면(병렬 이상도체 = 비결정) 잔차를
   *       미지 도선들에 균등 분배 — 대칭 극한, 순서 무관·결정적.
   *   (3) 남는 미지(자기 루프 등)는 0.
   * ══════════════════════════════════════════════════════ */
  function _wireChannels(comps, wires, dcPass, acPass){
    var jT={JUNCTION_3:1,JUNCTION_4:1};
    var compById={};
    comps.forEach(function(c){ compById[c.id]=c; });

    /* 소자 c 의 portId 에 붙은 도선의 채널 전류 (isFrom: 도선 from 쪽 여부) */
    function fromComp(c, portId, isFrom){
      var ports=App.Geo.getCompPorts(c);
      var s=(ports.indexOf(portId)===0?-1:1)*(isFrom?1:-1);
      var d=dcPass?dcPass.compI[c.id]:null;
      var a=acPass?acPass.compI[c.id]:null;
      return{dc:d?s*d.re:0, re:a?s*a.re:0, im:a?s*a.im:0};
    }

    var chan={};
    var juncs=comps.filter(function(c){return jT[c.type];});
    var inc={};
    juncs.forEach(function(j){ inc[j.id]=[]; });

    wires.forEach(function(w){
      var fc=compById[w.fromId], tc=compById[w.toId];
      var fcJ=!fc||jT[fc.type], tcJ=!tc||jT[tc.type];
      if(!fcJ)      chan[w.id]=fromComp(fc,w.fromPort,true);
      else if(!tcJ) chan[w.id]=fromComp(tc,w.toPort,false);
      /* 정션 인시던스 (자기 루프는 KCL 정보가 없으므로 제외 → 최종 0) */
      if(w.fromId===w.toId) return;
      if(inc[w.fromId]) inc[w.fromId].push(w);
      if(inc[w.toId])   inc[w.toId].push(w);
    });

    /* 정션 j 의 알려진 순유입 잔차 + 미지 도선 목록 */
    function residual(j){
      var r={dc:0,re:0,im:0}, unknown=[];
      inc[j.id].forEach(function(w){
        var ch=chan[w.id];
        if(!ch){ unknown.push(w); return; }
        var s=(w.toId===j.id)?1:-1;
        r.dc+=s*ch.dc; r.re+=s*ch.re; r.im+=s*ch.im;
      });
      return{r:r, unknown:unknown};
    }
    function assign(j,w,r,frac){
      var s=(w.fromId===j.id)?1:-1;   /* 유입 잔차는 w 로 유출되어야 함 */
      chan[w.id]={dc:s*r.dc*frac, re:s*r.re*frac, im:s*r.im*frac};
    }

    for(;;){
      var progress=false;
      juncs.forEach(function(j){
        var st=residual(j);
        if(st.unknown.length===1){ assign(j,st.unknown[0],st.r,1); progress=true; }
      });
      if(progress) continue;
      /* 막힘: 미지 ≥2 정션 하나를 골라 균등 분배 후 필링 재개 */
      var stuck=null, stStuck=null;
      for(var i=0;i<juncs.length;i++){
        var st2=residual(juncs[i]);
        if(st2.unknown.length>=2){ stuck=juncs[i]; stStuck=st2; break; }
      }
      if(!stuck) break;
      stStuck.unknown.forEach(function(w){ assign(stuck,w,stStuck.r,1/stStuck.unknown.length); });
    }

    wires.forEach(function(w){ if(!chan[w.id]) chan[w.id]={dc:0,re:0,im:0}; });
    return chan;
  }

  /* ══════════════════════════════════════════════════════
   *  _buildResult — 두 패스(dcPass/acPass)를 합성해 결과 조립
   *
   *  표시값 규약:
   *    순수 DC          → 부호 있는 실수값
   *    AC (혼합 포함)   → 피크 크기 |I_dc| + |I_ac|
   *  (i(t)=I_dc+|I_ac|cos(ωt+φ) 의 최대 순시값. 한쪽만 있으면 기존과 동일)
   * ══════════════════════════════════════════════════════ */
  function _buildResult(comps, wires, topo, dcPass, acPass, omega){
    var cn=topo.compNodes, pn=topo.portNode;
    var isAC=!!acPass;

    function display(dcC, acC){
      var d=dcC?dcC.re:0;
      if(!isAC) return d;
      return Math.abs(d)+(acC?_cabs(acC):0);
    }

    /* 노드전압 */
    var nodeV={};
    for(var k=0;k<topo.nodeCount;k++)
      nodeV[k]=display(dcPass&&dcPass.nodeV[k], acPass&&acPass.nodeV[k]);

    /* 포트전압 */
    var portV={};
    comps.forEach(function(c){
      portV[c.id]={};
      var pm=pn[c.id]; if(!pm) return;
      Object.keys(pm).forEach(function(p){ portV[c.id][p]=nodeV[pm[p]]||0; });
    });

    /* 소자 전압·전류 */
    var compV={}, compI={};
    comps.forEach(function(c){
      compV[c.id]=display(dcPass&&dcPass.compV[c.id], acPass&&acPass.compV[c.id]);
      compI[c.id]=display(dcPass&&dcPass.compI[c.id], acPass&&acPass.compI[c.id]);
    });

    /* 도선 전류 */
    var chan=_wireChannels(comps, wires, dcPass, acPass);
    var wireSignedI={}, wireI={};
    wires.forEach(function(w){
      var ch=chan[w.id];
      if(!isAC){
        wireSignedI[w.id]=ch.dc;
        wireI[w.id]=Math.abs(ch.dc);
        return;
      }
      var acMag=Math.hypot(ch.re,ch.im);
      var mag=Math.abs(ch.dc)+acMag;
      /* 방향 부호: DC 성분 → 실수부 → 허수부 순으로 유의미한 값 사용 */
      var signRef=Math.abs(ch.dc)>mag*0.01?ch.dc
                 :(Math.abs(ch.re)>acMag*0.01?ch.re:ch.im);
      wireSignedI[w.id]=(signRef>=0?1:-1)*mag;
      wireI[w.id]=mag;
    });

    var result={
      valid:true, error:null,
      nodeVoltages:nodeV,
      portVoltages:portV,
      componentVoltages:compV,
      branchCurrents:compI,
      wireCurrents:wireI,
      wireSignedI:wireSignedI,   /* 부호 있는 도선 전류 (fromPort→toPort 양) */
      componentNodes:cn,
    };

    /* ── AC 페이저 데이터 (혼합 시 DC 오프셋 포함 순시값) ── */
    if(isAC){
      var acI=acPass.compI, acV=acPass.compV;
      var dcI=dcPass?dcPass.compI:null, dcV=dcPass?dcPass.compV:null;
      function inst(phMap, dcMap, compId, t){
        var p=phMap[compId];
        var base=(dcMap&&dcMap[compId])?dcMap[compId].re:0;
        if(!p) return base;
        /* Re[(p.re+j·p.im)·e^(jωt)] = p.re·cos(ωt) − p.im·sin(ωt) */
        return base + p.re*Math.cos(omega*t) - p.im*Math.sin(omega*t);
      }
      /* DC 성분(부호 있는 실수)을 따로 노출 — 혼합 회로의 실효값·평균전력은
       *   |I_dc|+|I_ac| 표시값으로는 계산할 수 없다 (I_rms=√(I_dc²+|I_ac|²/2)) */
      var dcCompI={}, dcCompV={};
      comps.forEach(function(c){
        dcCompI[c.id]=(dcI&&dcI[c.id])?dcI[c.id].re:0;
        dcCompV[c.id]=(dcV&&dcV[c.id])?dcV[c.id].re:0;
      });
      result.acPhasor={
        omega : omega,
        compI : acI,   /* {id:{re,im}} — 복소 전류 페이저 (AC 성분) */
        compV : acV,   /* {id:{re,im}} — 복소 전압 페이저 (AC 성분) */
        dcCompI: dcCompI,  /* {id:실수} — DC 성분 전류 (혼합 회로, 순수 AC 면 0) */
        dcCompV: dcCompV,  /* {id:실수} — DC 성분 전압 */
        /* t(초)의 순시 전류/전압 i(t)=I_dc+Re[I·e^(jωt)] */
        instCurrent: function(compId,t){ return inst(acI,dcI,compId,t); },
        instVoltage: function(compId,t){ return inst(acV,dcV,compId,t); },
      };
    }

    return result;
  }

  /* ══════════════════════════════════════════════════════
   *  개방 회로 검사 (BFS)
   * ══════════════════════════════════════════════════════ */
  function _checkOpen(topo, comps){
    var cn=topo.compNodes, N=topo.nodeCount;
    var adj=[]; for(var i=0;i<N;i++) adj.push([]);
    comps.forEach(function(c){
      var nn=cn[c.id]; if(!nn||nn[0]===nn[1]) return;
      adj[nn[0]].push(nn[1]); adj[nn[1]].push(nn[0]);
    });
    var vis=new Uint8Array(N);
    var q=[0]; vis[0]=1;
    while(q.length){
      var cur=q.shift();
      adj[cur].forEach(function(nb){if(!vis[nb]){vis[nb]=1;q.push(nb);}});
    }
    for(var i2=1;i2<N;i2++) if(!vis[i2]) return true;
    return false;
  }

  /* ══════════════════════════════════════════════════════
   *  solve — 순수 해석 함수 (상태 비의존, 테스트 가능)
   * ══════════════════════════════════════════════════════ */
  function solve(comps, wires){
    if(!comps.length)
      return{valid:false,error:null,
             nodeVoltages:{},portVoltages:{},componentVoltages:{},
             branchCurrents:{},wireCurrents:{}};

    var topo=App.Topology.build(comps,wires);
    if(!topo.valid) return _fail(topo.error||'토폴로지 오류');
    if(_checkOpen(topo,comps)) return _fail('회로가 열려 있습니다');

    try{
      /* AC 주파수 결정 — 페이저 해석은 단일 주파수만 표현 가능 */
      var omega=0;
      if(topo.hasAC){
        var freq=null;
        for(var i=0;i<comps.length;i++){
          if(comps[i].type!==TYPE.AC_SOURCE) continue;
          var f=comps[i].value2||60;
          if(freq==null) freq=f;
          else if(Math.abs(f-freq)>1e-9)
            return _fail('주파수가 서로 다른 교류 전원은 함께 해석할 수 없습니다 ('+freq+'Hz, '+f+'Hz)');
        }
        omega=2*Math.PI*freq;
      }

      var acPass=null, dcPass=null;
      if(topo.hasAC){
        acPass=_solvePass(comps,topo,omega,'AC');
        if(acPass.err) return _fail(acPass.err);
      }
      if(topo.hasDC){
        dcPass=_solvePass(comps,topo,0,'DC');
        if(dcPass.err) return _fail(dcPass.err);
      }
      return _buildResult(comps,wires,topo,dcPass,acPass,omega);
    }catch(e){
      return _fail('내부 오류: '+e.message);
    }
  }

  /* ══════════════════════════════════════════════════════
   *  진입점 (디바운스)
   * ══════════════════════════════════════════════════════ */
  function _doSolve(){
    App.State.solverResult=solve(App.State.components,App.State.wires);
    App.Events.emit('solver:done');
  }

  function run(){
    if(_schedId!==null){
      if(typeof cancelIdleCallback!=='undefined') cancelIdleCallback(_schedId);
      else clearTimeout(_schedId);
      _schedId=null;
    }
    if(typeof requestIdleCallback!=='undefined')
      _schedId=requestIdleCallback(function(){_schedId=null;_doSolve();},{timeout:120});
    else
      _schedId=setTimeout(function(){_schedId=null;_doSolve();},50);
  }

  return{run:run, solve:solve};
})();

}());
