(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Solver — 회로 해석 (Modified Nodal Analysis)
 *
 *   DC 회로: 실수 MNA. 인덕터=단락(SMALL_R), 커패시터=개방.
 *   AC 회로: 복소 페이저 MNA. 임피던스 jωL, 1/(jωC) 반영.
 *
 *   결과(solverResult)는 _buildResult가 공통 조립:
 *     nodeVoltages, portVoltages, componentVoltages,
 *     branchCurrents, wireCurrents, wireSignedI, componentNodes
 *
 *   run()은 idle 콜백으로 디바운스 실행 (잦은 편집 중 과도한 재계산 방지).
 * ════════════════════════════════════════════════════════════════════ */
App.Solver=(function(){

  /* 물리 근사 상수 */
  var SMALL_R     = 1e-6;   // 인덕터 DC 단락 / 0Ω 저항 대체 (µΩ)
  var R_SER_FALLBACK = 1e-4; // 특이행렬 시 전압원 직렬저항 (병렬전원 등)
  var OVERCURRENT = 1e10;   // 과전류(단락) 판정 임계 (A)

  var _schedId=null;

  /* ── 밀집 행렬 헬퍼 ── */
  function _mat(n){var m=[];for(var i=0;i<n;i++)m.push(new Float64Array(n));return m;}
  function _vec(n){return new Float64Array(n);}

  /* ── 가우스 소거 (부분 피벗) → 해 벡터 또는 null(특이행렬) ── */
  function _gauss(A,b){
    var n=b.length;
    var a=A.map(function(r){return Float64Array.from(r);});
    var x=Float64Array.from(b);
    for(var col=0;col<n;col++){
      var mx=col, mv=Math.abs(a[col][col]);
      for(var rr=col+1;rr<n;rr++){var v=Math.abs(a[rr][col]);if(v>mv){mv=v;mx=rr;}}
      if(mv<1e-12) return null;
      if(mx!==col){var t=a[col];a[col]=a[mx];a[mx]=t;var tb=x[col];x[col]=x[mx];x[mx]=tb;}
      var piv=a[col][col];
      for(var r2=col+1;r2<n;r2++){
        var f=a[r2][col]/piv; if(Math.abs(f)<1e-15) continue;
        for(var cc=col;cc<n;cc++) a[r2][cc]-=f*a[col][cc];
        x[r2]-=f*x[col];
      }
    }
    var sol=new Float64Array(n);
    for(var i=n-1;i>=0;i--){
      sol[i]=x[i];
      for(var j=i+1;j<n;j++) sol[i]-=a[i][j]*sol[j];
      sol[i]/=a[i][i];
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
   *  _buildResult — solverResult 객체 공통 조립
   *
   *  DC·AC 솔버가 노드전압(nodeV)과 전원전류(vsrcI)를 구한 뒤 호출.
   *  소자 전압/전류, 포트전압, 도선 부호전류(wireSignedI)를 계산한다.
   *  overrideCompI: AC 모드에서 복소 전류 크기를 직접 주입 (DC 공식 우회).
   * ══════════════════════════════════════════════════════ */
  function _buildResult(comps, wires, topo, nodeV, vsrcI, overrideCompI){
    var cn  = topo.compNodes;
    var pn  = topo.portNode;

    /* 부품별 전압·전류 */
    var compV={}, compI={};
    comps.forEach(function(c){
      var nn=cn[c.id]; if(!nn) return;
      var vA=nodeV[nn[0]]||0, vB=nodeV[nn[1]]||0;
      var dV=vA-vB;
      compV[c.id]=dV;

      /* overrideCompI 가 있으면 DC 공식 무시 (AC 모드) */
      if(overrideCompI && overrideCompI[c.id]!=null){
        compI[c.id]=overrideCompI[c.id];
        return;
      }
      switch(c.type){
        case TYPE.DC_SOURCE:
        case TYPE.AC_SOURCE:
          compI[c.id]=vsrcI[c.id]||0; break;
        case TYPE.RESISTOR:
          compI[c.id]=c.value>0?dV/c.value:dV/SMALL_R; break;
        case TYPE.INDUCTOR:
          compI[c.id]=dV/SMALL_R; break;
        case TYPE.CAPACITOR:
          compI[c.id]=0; break;
        default:
          compI[c.id]=0;
      }
    });

    /* portVoltages */
    var portV={};
    comps.forEach(function(c){
      portV[c.id]={};
      var pm=pn[c.id]; if(!pm) return;
      Object.keys(pm).forEach(function(p){
        portV[c.id][p]=nodeV[pm[p]]||0;
      });
    });

    /* ════════════════════════════════════════════════════════════════
     * wireSignedI / wireCurrents  계산
     *
     * 목표: 각 도선에 대해
     *   wireSignedI[id] = fromPort→toPort 방향의 부호 있는 전류 (A)
     *   wireCurrents[id] = |wireSignedI[id]|  (절댓값, 기존 호환)
     *
     * 알고리즘:
     *  (1) 각 비-JUNCTION 부품 c에 대해 compI[c.id] 는
     *      portA(ports[0]) → portB(ports[1]) 방향을 양(+)으로 정의한
     *      내부 전류.
     *      → nodeSignedOut[nodeA] += compI[c.id]   (nodeA 에서 나감)
     *      → nodeSignedOut[nodeB] -= compI[c.id]   (nodeB 로 들어옴)
     *
     *  (2) 각 도선 w 에 대해:
     *      fromNode = pn[w.fromId][w.fromPort]
     *      toNode   = pn[w.toId  ][w.toPort  ]
     *
     *    Case A: from 이 비-JUNCTION 부품
     *      fromPort 가 ports[0] 이면 → 전류가 fromPort에서 나감
     *        wireSignedI = +compI[from.id]
     *      fromPort 가 ports[1] 이면 → 전류가 fromPort로 들어옴(반대)
     *        wireSignedI = -compI[from.id]
     *
     *    Case B: to 가 비-JUNCTION 부품 (from 이 JUNCTION)
     *      Case A 와 대칭: toPort 기준으로 부호 결정 후 반전
     *
     *    Case C: 양쪽 모두 JUNCTION
     *      nodeSignedOut[fromNode] 이 도선을 통해 흘러나감
     *      → wireSignedI = +nodeSignedOut[fromNode]
     *         (양수 = fromNode에서 전류가 나가므로 w 방향으로 흐름)
     *
     *  (3) JUNCTION 노드에서 도선이 여러 개인 경우:
     *      각 도선의 wireSignedI 를 먼저 구한 뒤
     *      KCL 검증: Σ wireSignedI (들어오는 방향 기준) = 0
     * ════════════════════════════════════════════════════════════════ */
    var jT={JUNCTION_3:1,JUNCTION_4:1};

    /* Step 1: nodeSignedOut 구성 */
    var nodeSignedOut={};
    comps.forEach(function(c){
      if(jT[c.type]) return;
      var nn=cn[c.id]; if(!nn) return;
      var I=compI[c.id]||0;
      var ports=App.Geo.getCompPorts(c);
      /* ports[0] → nn[0]: I 만큼 나감 */
      nodeSignedOut[nn[0]]=(nodeSignedOut[nn[0]]||0)+I;
      /* ports[1] → nn[1]: I 만큼 들어옴(= -I 나감) */
      nodeSignedOut[nn[1]]=(nodeSignedOut[nn[1]]||0)-I;
    });

    /* Step 2: 각 도선의 부호 있는 전류 계산 */
    var wireSignedI={};
    wires.forEach(function(w){
      var fc=comps.find(function(c){return c.id===w.fromId;});
      var tc=comps.find(function(c){return c.id===w.toId;});
      var fcIsJ=!fc||jT[fc.type];
      var tcIsJ=!tc||jT[tc.type];

      if(!fcIsJ){
        /* Case A: from 이 비-JUNCTION
         * compI[from] > 0 = 전류가 ports[0]→ports[1] (부품 내부)
         * fromPort==ports[0]: 전류가 fromPort 쪽으로 들어옴
         *   → 외부 도선은 toPort→fromPort 방향 → wireSignedI 음수
         * fromPort==ports[1]: 전류가 fromPort 쪽에서 나감
         *   → 외부 도선은 fromPort→toPort 방향 → wireSignedI 양수 */
        var ports=App.Geo.getCompPorts(fc);
        var idx=ports.indexOf(w.fromPort);
        wireSignedI[w.id]=(idx===0?-1:1)*(compI[fc.id]||0);
        return;
      }

      if(!tcIsJ){
        /* Case B: to 가 비-JUNCTION (from 은 JUNCTION)
         * compI[to] > 0 = 전류가 ports[0]→ports[1] (부품 내부)
         * toPort==ports[0]: 전류가 toPort 쪽으로 들어옴
         *   → 도선은 fromPort→toPort 방향 → wireSignedI 양수
         * toPort==ports[1]: 전류가 toPort 쪽에서 나감
         *   → 도선은 toPort→fromPort 방향 → wireSignedI 음수 */
        var portsT=App.Geo.getCompPorts(tc);
        var idxT=portsT.indexOf(w.toPort);
        wireSignedI[w.id]=(idxT===0?1:-1)*(compI[tc.id]||0);
        return;
      }

      /* Case C: 양쪽 모두 JUNCTION ─────────────────────────────────────
       * w.fromId/toId 각각에 대해 KCL을 계산, 절댓값이 큰 쪽 사용.
       * (한쪽이 0이 나오는 경우 다른 쪽에서 정확한 값을 얻을 수 있음)
       * ─────────────────────────────────────────────────────────────── */
      (function(){
        function kclAt(juncId, sign){
          var sumI=0,found=false;
          wires.forEach(function(other){
            if(other.id===w.id) return;
            var isOtherFrom=(other.fromId===juncId);
            var isOtherTo  =(other.toId  ===juncId);
            if(!isOtherFrom&&!isOtherTo) return;
            var ofc2=comps.find(function(c2){return c2.id===other.fromId;});
            var otc2=comps.find(function(c2){return c2.id===other.toId;});
            var otherI=null;
            if(ofc2&&!jT[ofc2.type]){
              var p2=App.Geo.getCompPorts(ofc2),i2=p2.indexOf(other.fromPort);
              otherI=(i2===0?-1:1)*(compI[ofc2.id]||0);
            } else if(otc2&&!jT[otc2.type]){
              var p3=App.Geo.getCompPorts(otc2),i3=p3.indexOf(other.toPort);
              otherI=(i3===0?1:-1)*(compI[otc2.id]||0);
            } else if(wireSignedI[other.id]!=null){
              otherI=wireSignedI[other.id];
            }
            if(otherI==null) return;
            found=true;
            sumI += isOtherTo ? otherI : -otherI;
          });
          return found ? sumI*sign : null;
        }
        /* fromId 기준 계산 (w를 통해 나가는 전류) */
        var fromVal=kclAt(w.fromId, 1);
        /* toId 기준 계산 (w를 통해 들어오는 전류 → 부호 반전) */
        var toVal  =kclAt(w.toId,  -1);
        /* 절댓값이 큰 값 선택 (0이 아닌 쪽이 더 정확) */
        if(fromVal==null && toVal==null){ wireSignedI[w.id]=0; return; }
        if(fromVal==null){ wireSignedI[w.id]=toVal; return; }
        if(toVal  ==null){ wireSignedI[w.id]=fromVal; return; }
        wireSignedI[w.id]=Math.abs(fromVal)>=Math.abs(toVal)?fromVal:toVal;
      })();
    });

    /* Step 3: wireCurrents = |wireSignedI| */
    var wireI={};
    wires.forEach(function(w){ wireI[w.id]=Math.abs(wireSignedI[w.id]||0); });

    return{
      valid:true, error:null,
      nodeVoltages:nodeV,
      portVoltages:portV,
      componentVoltages:compV,
      branchCurrents:compI,
      wireCurrents:wireI,
      wireSignedI:wireSignedI,   /* 부호 있는 도선 전류 (fromPort→toPort 양) */
      componentNodes:cn,
    };
  }

  /* ══════════════════════════════════════════════════════
   *  DC MNA Solver
   *
   *  회로 방정식:
   *    [G  B][v]   [i_s]
   *    [C  0][j] = [v_s]
   *
   *  G: (n×n) 컨덕턴스 행렬
   *  B: (n×m) 전압원 B 블록 (+1/-1)
   *  C: B^T
   *  v: (n)   노드전압 미지수 (접지 제외)
   *  j: (m)   전압원 전류 미지수
   *  i_s: (n) 전류원 벡터 (현재 없음)
   *  v_s: (m) 전압원 전압값
   * ══════════════════════════════════════════════════════ */
  function _solveDC(comps, wires, topo){
    var cn   = topo.compNodes;
    var N    = topo.nodeCount;  // 접지(0) 포함
    var n    = N - 1;           // 미지수: 접지 제외 노드

    if(n <= 0) return _fail('회로를 해석할 수 없습니다');

    /* 전압원 목록 수집 */
    var vsrcs=[];
    comps.forEach(function(c){
      var nn=cn[c.id]; if(!nn) return;
      if(c.type===TYPE.DC_SOURCE)
        vsrcs.push({id:c.id, V:+(c.value)||0, posNode:nn[0], negNode:nn[1]});
    });
    if(vsrcs.length===0) return _fail('전원이 없습니다');

    /* ── 병렬 전압원 전압 불일치 사전 검사 ──────────────────────────
     * 같은 노드 쌍을 공유하는 두 전압원의 전압이 다르면 물리적 단락.
     * 전압이 같으면 중복 제거 후 허용. */
    for(var _ka=0;_ka<vsrcs.length;_ka++){
      for(var _kb=_ka+1;_kb<vsrcs.length;_kb++){
        var _va=vsrcs[_ka], _vb=vsrcs[_kb];
        var _sameDir =(_va.posNode===_vb.posNode&&_va.negNode===_vb.negNode);
        var _revDir  =(_va.posNode===_vb.negNode&&_va.negNode===_vb.posNode);
        if(!_sameDir&&!_revDir) continue;
        var _effVb=_sameDir?_vb.V:-_vb.V;
        if(Math.abs(_va.V-_effVb)>0.5)   /* 0.5V 이상 차이 → 단락 */
          return _fail('서로 다른 전압의 전원이 병렬 연결되어 있습니다 (V₁='+_va.V+'V, V₂='+_vb.V+'V)');
        vsrcs.splice(_kb,1); _kb--;   /* 동일 전압 → 중복 제거 */
      }
    }

    var m=vsrcs.length;
    var sz=n+m;

    /* 수동소자 컨덕턴스를 G 행렬에 스탬프 (정상/폴백 공용 헬퍼)
     *   인덕터: DC 단락(1/SMALL_R), 저항: 1/R, 커패시터: 개방(기여 없음) */
    function stampPassives(G){
      comps.forEach(function(c){
        var nn=cn[c.id]; if(!nn) return;
        var gA=nn[0]-1, gB=nn[1]-1;
        var g=0;
        if(c.type===TYPE.RESISTOR) g=c.value>0?1/c.value:1/SMALL_R;
        if(c.type===TYPE.INDUCTOR) g=1/SMALL_R;
        if(g===0) return;
        if(gA>=0) G[gA][gA]+=g;
        if(gB>=0) G[gB][gB]+=g;
        if(gA>=0&&gB>=0){G[gA][gB]-=g; G[gB][gA]-=g;}
      });
    }

    /* ── 1차 시도: 이상 전압원 ── */
    var G=_mat(sz), rhs=_vec(sz);
    stampPassives(G);
    vsrcs.forEach(function(vs,k){
      var row=n+k, gP=vs.posNode-1, gN=vs.negNode-1;
      if(gP>=0){G[gP][row]+=1; G[row][gP]+=1;}
      if(gN>=0){G[gN][row]-=1; G[row][gN]-=1;}
      rhs[row]=vs.V;
    });
    var sol=_gauss(G, rhs);

    /* ── 폴백: 특이행렬 시 전압원에 미소 직렬저항 삽입 후 재시도 ── */
    if(!sol){
      var G2=_mat(sz), rhs2=_vec(sz);
      stampPassives(G2);
      vsrcs.forEach(function(vs,k){
        var row=n+k, gP=vs.posNode-1, gN=vs.negNode-1;
        if(gP>=0){G2[gP][row]+=1; G2[row][gP]+=1;}
        if(gN>=0){G2[gN][row]-=1; G2[row][gN]-=1;}
        G2[row][row]-=R_SER_FALLBACK;   /* D 블록: 내부 전압강하 */
        rhs2[row]=vs.V;
      });
      sol=_gauss(G2,rhs2);
      if(!sol) return _fail('회로를 해석할 수 없습니다');
    }

    /* 노드전압 추출 */
    var nodeV={0:0};
    for(var i=0;i<n;i++) nodeV[i+1]=sol[i];

    /* 전원 전류 추출 + 과전류(단락) 검사 */
    var vsrcI={};
    for(var k2=0;k2<m;k2++){
      vsrcI[vsrcs[k2].id]=sol[n+k2];
      if(Math.abs(sol[n+k2])>OVERCURRENT) return _fail('단락 회로가 감지되었습니다');
    }

    return _buildResult(comps, wires, topo, nodeV, vsrcI);
  }

  /* ══════════════════════════════════════════════════════
   *  AC 페이저 솔버 (복소 MNA)
   * ══════════════════════════════════════════════════════ */

  /* ── 복소수 연산 헬퍼 ──
   *   복소수는 {re, im} 객체로 표현. 페이저 계산 전반에 사용. */
  function _c(re,im){return{re:re||0,im:im||0};}
  function _cadd(a,b){return{re:a.re+b.re,im:a.im+b.im};}
  function _csub(a,b){return{re:a.re-b.re,im:a.im-b.im};}
  function _cmul(a,b){return{re:a.re*b.re-a.im*b.im,im:a.re*b.im+a.im*b.re};}
  function _cdiv(a,b){var d=b.re*b.re+b.im*b.im;if(d<1e-300)return _c();return{re:(a.re*b.re+a.im*b.im)/d,im:(a.im*b.re-a.re*b.im)/d};}
  function _cabs(a){return Math.hypot(a.re,a.im);}

  /* ── 복소 가우스 소거 ── */
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

  function _solveAC(comps, wires, topo){
    var cn=topo.compNodes;
    var N=topo.nodeCount, n=N-1;
    if(n<=0) return _fail('회로를 해석할 수 없습니다');

    /* 교류 전원 목록 (모두 동일 주파수 가정) */
    var vsrcs=[];
    comps.forEach(function(c){
      var nn=cn[c.id]; if(!nn) return;
      if(c.type===TYPE.AC_SOURCE){
        var f=c.value2||60, w=2*Math.PI*f;
        /* RHS: V_peak * e^(j*0) = (V_peak, 0) (기준 페이저) */
        vsrcs.push({id:c.id, V:+(c.value)||0, omega:w, posNode:nn[0], negNode:nn[1]});
      }
    });
    var m=vsrcs.length;
    if(m===0) return _fail('전원이 없습니다');

    var omega=vsrcs[0].omega;
    var sz=n+m;

    /* ── 복소 MNA 행렬 구성 ── */
    var G=[]; for(var i=0;i<sz;i++){var row=[];for(var j=0;j<sz;j++)row.push(_c());G.push(row);}
    var rhs=[]; for(var i2=0;i2<sz;i2++) rhs.push(_c());

    /* 소자 어드미턴스 스탬프 */
    comps.forEach(function(c){
      var nn=cn[c.id]; if(!nn) return;
      var gA=nn[0]-1, gB=nn[1]-1;
      var Y=_c();
      if(c.type===TYPE.RESISTOR){
        /* Y_R = 1/R (실수) */
        Y=_c(c.value>0?1/c.value:1/SMALL_R, 0);
      } else if(c.type===TYPE.CAPACITOR){
        /* Z_C = 1/(jωC)  →  Y_C = jωC */
        Y=_c(0, omega*(c.value||0));
      } else if(c.type===TYPE.INDUCTOR){
        /* Z_L = jωL  →  Y_L = 1/(jωL) = -j/(ωL) */
        var wL=omega*(c.value||SMALL_R);
        Y=_c(0, wL>0?-1/wL:-1/SMALL_R);
      }
      if(Y.re===0&&Y.im===0) return;
      if(gA>=0) G[gA][gA]=_cadd(G[gA][gA],Y);
      if(gB>=0) G[gB][gB]=_cadd(G[gB][gB],Y);
      if(gA>=0&&gB>=0){G[gA][gB]=_csub(G[gA][gB],Y);G[gB][gA]=_csub(G[gB][gA],Y);}
    });

    /* 전압원 B/C 블록 스탬프 */
    vsrcs.forEach(function(vs,k){
      var row=n+k, gP=vs.posNode-1, gN=vs.negNode-1;
      var ONE=_c(1), M=_c(-1);
      if(gP>=0){G[gP][row]=_cadd(G[gP][row],ONE);G[row][gP]=_cadd(G[row][gP],ONE);}
      if(gN>=0){G[gN][row]=_cadd(G[gN][row],M); G[row][gN]=_cadd(G[row][gN],M);}
      /* RHS: V_peak 기준 페이저 (실수부만) */
      rhs[row]=_c(vs.V, 0);
    });

    var solC=_gaussC(G,rhs);
    if(!solC) return _fail('회로를 해석할 수 없습니다');

    /* ── 복소 노드전압 페이저 추출 ── */
    /* solC[0..n-1]: 노드전압 복소 페이저 */
    /* solC[n..n+m-1]: 전압원 전류 복소 페이저 */
    var nodeVphasor=[];  /* nodeVphasor[i] = complex phasor for node i+1 */
    for(var i3=0;i3<n;i3++) nodeVphasor[i3]=solC[i3];

    /* nodeVoltages (크기, 편집모드 표시용) */
    var nodeV={0:0};
    for(var i4=0;i4<n;i4++) nodeV[i4+1]=_cabs(solC[i4]);

    /* ── 부품별 복소 전류 페이저 계산 ── */
    var compI_phasor={};   /* {re, im} — 복소 전류 페이저 */
    var compV_phasor={};   /* {re, im} — 복소 전압 페이저 */

    comps.forEach(function(c){
      var nn=cn[c.id]; if(!nn) return;
      /* 양단 복소 노드전압 */
      var VA = nn[0]>0 ? nodeVphasor[nn[0]-1] : _c();
      var VB = nn[1]>0 ? nodeVphasor[nn[1]-1] : _c();
      var dV = _csub(VA, VB);  /* 복소 전압 페이저 V_A - V_B */
      compV_phasor[c.id] = dV;

      if(c.type===TYPE.AC_SOURCE){
        /* 전압원 전류는 MNA 보조 미지수에서 직접 추출 */
        var k=vsrcs.findIndex(function(v){return v.id===c.id;});
        compI_phasor[c.id] = k>=0 ? solC[n+k] : _c();
      } else if(c.type===TYPE.RESISTOR){
        /* I = V/R (순수 실수 임피던스, 전압과 동위상) */
        var R=c.value>0?c.value:SMALL_R;
        compI_phasor[c.id]=_c(dV.re/R, dV.im/R);
      } else if(c.type===TYPE.CAPACITOR){
        /* Z_C = 1/(jωC), I = V·Y_C = V·(jωC) */
        var wC=omega*(c.value||0);
        /* Multiply dV by (j·wC): (re+j·im)*(j·wC) = (-im·wC) + j*(re·wC) */
        compI_phasor[c.id]=_c(-dV.im*wC, dV.re*wC);
      } else if(c.type===TYPE.INDUCTOR){
        /* Z_L = jωL, I = V/Z_L = V/(jωL) = V·(-j/(ωL)) */
        var wL=omega*(c.value||SMALL_R);
        if(wL>0){
          /* Divide dV by (j·wL): (re+j·im)/(j·wL) = (im/wL) + j*(-re/wL) */
          compI_phasor[c.id]=_c(dV.im/wL, -dV.re/wL);
        } else {
          compI_phasor[c.id]=_c();
        }
      } else {
        compI_phasor[c.id]=_c();
      }
    });

    /* ── compI(크기), compV(크기) — _buildResult 호환용 ── */
    var compI_mag={}, compV_mag={};
    comps.forEach(function(c){
      compI_mag[c.id] = compI_phasor[c.id] ? _cabs(compI_phasor[c.id]) : 0;
      compV_mag[c.id] = compV_phasor[c.id] ? _cabs(compV_phasor[c.id]) : 0;
    });

    /* ── _buildResult 호출: compI_mag 를 override 해서 DC 공식(dV/1e-6) 차단 ── */
    var base = _buildResult(comps, wires, topo, nodeV, {}, compI_mag);

    /* ── AC 전용 wireCurrents/wireSignedI 재계산 ───────────────────────────
     * _buildResult 내부 wireSignedI 는 nodeSignedOut 을 쓰는데,
     * AC 에서는 복소 phasor 의 크기(magnitude)를 직접 써야 한다.
     * 직렬 회로에서 모든 도선의 전류가 동일하게 나오도록 보장.
     * ─────────────────────────────────────────────────────────────────── */
    var jT_ac={JUNCTION_3:1,JUNCTION_4:1};

    /* JUNCTION 노드 처리를 위한 nodeSignedOut (복소) */
    var nso_re={}, nso_im={};
    comps.forEach(function(c){
      if(jT_ac[c.type]) return;
      var nn=cn[c.id]; if(!nn) return;
      var p=compI_phasor[c.id]||_c();
      nso_re[nn[0]]=(nso_re[nn[0]]||0)+p.re; nso_im[nn[0]]=(nso_im[nn[0]]||0)+p.im;
      nso_re[nn[1]]=(nso_re[nn[1]]||0)-p.re; nso_im[nn[1]]=(nso_im[nn[1]]||0)-p.im;
    });

    var wireSignedI_ac={}, wireCurrents_ac={};
    wires.forEach(function(w){
      var fc=comps.find(function(c2){return c2.id===w.fromId;});
      var tc=comps.find(function(c2){return c2.id===w.toId;});
      var fcJ=!fc||jT_ac[fc.type];
      var tcJ=!tc||jT_ac[tc.type];
      var pre=0, pim=0, mag=0;

      if(!fcJ){
        /* Case A: from 이 비-JUNCTION */
        var ports=App.Geo.getCompPorts(fc);
        var idx=ports.indexOf(w.fromPort);
        var sign=(idx===0?-1:1);
        var p=compI_phasor[fc.id]||_c();
        pre=sign*p.re; pim=sign*p.im; mag=_cabs(p);
      } else if(!tcJ){
        /* Case B: to 가 비-JUNCTION */
        var portsT=App.Geo.getCompPorts(tc);
        var idxT=portsT.indexOf(w.toPort);
        var signT=(idxT===0?1:-1);
        var pT=compI_phasor[tc.id]||_c();
        pre=signT*pT.re; pim=signT*pT.im; mag=_cabs(pT);
      } else {
        /* Case C: 양쪽 JUNCTION */
        var fn=topo.portNode[w.fromId]&&topo.portNode[w.fromId][w.fromPort];
        pre=fn!=null?(nso_re[fn]||0):0;
        pim=fn!=null?(nso_im[fn]||0):0;
        mag=Math.hypot(pre,pim);
      }

      /* 방향 부호: |실수부| > 1% × |페이저| 이면 실수부로, 아니면 허수부로 */
      var signRef=Math.abs(pre)>mag*0.01?pre:pim;
      wireSignedI_ac[w.id]=(signRef>=0?1:-1)*mag;
      wireCurrents_ac[w.id]=mag; /* peak 크기 */
    });

    base.wireCurrents = wireCurrents_ac;
    base.wireSignedI  = wireSignedI_ac;

    /* ── AC 전용 페이저 데이터 추가 ── */
    base.acPhasor = {
      omega     : omega,
      compI     : compI_phasor,   /* {id: {re,im}} — 복소 전류 페이저 */
      compV     : compV_phasor,   /* {id: {re,im}} — 복소 전압 페이저 */
      /* 편의 함수: t(초)에서의 순시 전류 i(t) = Re[I·e^(jωt)] */
      instCurrent: function(compId, t){
        var p=compI_phasor[compId];
        if(!p) return 0;
        /* i(t) = |I|·cos(ωt + φ_I) = Re[(p.re + j·p.im)·(cos(ωt)+j·sin(ωt))]
         *      = p.re·cos(ωt) - p.im·sin(ωt) */
        var ct=Math.cos(omega*t), st=Math.sin(omega*t);
        return p.re*ct - p.im*st;
      },
      /* 편의 함수: t(초)에서의 순시 전압 v(t) = Re[V·e^(jωt)] */
      instVoltage: function(compId, t){
        var p=compV_phasor[compId];
        if(!p) return 0;
        var ct=Math.cos(omega*t), st=Math.sin(omega*t);
        return p.re*ct - p.im*st;
      },
    };

    return base;
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
   *  진입점
   * ══════════════════════════════════════════════════════ */
  function _doSolve(){
    var comps=App.State.components;
    var ws   =App.State.wires;

    if(!comps.length){
      App.State.solverResult={valid:false,error:null,
        nodeVoltages:{},portVoltages:{},componentVoltages:{},branchCurrents:{},wireCurrents:{}};
      App.Events.emit('solver:done'); return;
    }

    var topo=App.Topology.build(comps,ws,App.Geo);
    if(!topo.valid){
      App.State.solverResult=_fail(topo.error||'토폴로지 오류');
      App.Events.emit('solver:done'); return;
    }

    if(_checkOpen(topo,comps)){
      App.State.solverResult=_fail('회로가 열려 있습니다');
      App.Events.emit('solver:done'); return;
    }

    var result;
    try{
      result=topo.hasAC?_solveAC(comps,ws,topo):_solveDC(comps,ws,topo);
    }catch(e){
      result=_fail('내부 오류: '+e.message);
    }

    App.State.solverResult=result;
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

  return{run:run};
})();

}());
