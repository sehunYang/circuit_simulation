(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Topology — 회로 토폴로지 분석 (Union-Find 기반 노드 병합)
 *
 *   목적: 소자·도선 그래프에서 전기적으로 동일한 노드를 병합하여
 *   각 소자 단자의 노드 번호를 결정. MNA 솔버의 입력이 된다.
 *
 *   처리 순서:
 *     1) (소자,포트) 쌍마다 고유 슬롯 부여
 *     2) 도선으로 연결된 슬롯 Union
 *     3) JUNCTION 내부 포트 전부 Union
 *     4) 슬롯 root → 노드번호 매핑 (1부터, 0=접지 예약)
 *     5) 포트별 노드번호 수집
 *     6) 전원 탐색 + 접지 후보(전원 음극) 결정
 *     7) 접지 노드를 0으로 스왑 + 갭 없이 재압축
 *     8) compNodes[id]=[nA,nB] 구성
 *     9~10) 단락/미연결 검사
 * ════════════════════════════════════════════════════════════════════ */
App.Topology=(function(){

  /* 소자 포트 목록 반환 ('LR' 등 → ['L','R']) */
  function portsOf(c){ return (COMP_PORTS[c.type]||'LR').split(''); }

  /* 전원(DC/AC) 여부 */
  function isSource(c){ return c.type===TYPE.DC_SOURCE||c.type===TYPE.AC_SOURCE; }
  /* 분기점 여부 */
  function isJunction(c){ return c.type===TYPE.JUNCTION_3||c.type===TYPE.JUNCTION_4; }

  /* 실패 결과 객체 생성 (반복 제거) */
  function fail(msg){
    return{valid:false,error:msg,nodeCount:0,groundNode:0,compNodes:{},portNode:{},hasAC:false};
  }

  /* ── Union-Find (경로 압축 + 랭크) ── */
  function _uf(n){
    var p=new Int32Array(n), r=new Int32Array(n);
    for(var i=0;i<n;i++) p[i]=i;
    return{
      find:function(x){while(p[x]!==x){p[x]=p[p[x]];x=p[x];}return x;},
      union:function(a,b){
        a=this.find(a); b=this.find(b);
        if(a===b)return;
        if(r[a]<r[b]){var t=a;a=b;b=t;}
        p[b]=a; if(r[a]===r[b])r[a]++;
      }
    };
  }

  /*
   * build(components, wires, Geo) → topology
   *
   * Topology = {
   *   valid      : bool,
   *   error      : string|null,
   *   nodeCount  : number,          // 접지(0) 포함 총 노드 수
   *   groundNode : 0,
   *   compNodes  : { id:[nA,nB] },  // 소자 양단 노드번호
   *   portNode   : { id:{L:n,R:n,…} }, // 포트별 노드번호
   *   hasAC      : bool,
   * }
   */
  function build(comps, wires, Geo){
    if(!comps.length) return fail('부품이 없습니다');

    /* 1. (소자,포트) 쌍마다 고유 슬롯 번호 부여 */
    var slotOf={};   // slotOf[compId][port] = slotIndex
    var slot=0;
    comps.forEach(function(c){
      slotOf[c.id]={};
      portsOf(c).forEach(function(p){ slotOf[c.id][p]=slot++; });
    });
    var uf=_uf(slot);

    /* 2. 도선으로 연결된 슬롯 Union */
    wires.forEach(function(w){
      var fSlots=slotOf[w.fromId], tSlots=slotOf[w.toId];
      if(!fSlots||!tSlots) return;
      var a=fSlots[w.fromPort], b=tSlots[w.toPort];
      if(a!=null && b!=null) uf.union(a,b);
    });

    /* 3. JUNCTION 내부 포트 전부 Union (한 점으로 단락) */
    comps.forEach(function(c){
      if(!isJunction(c)) return;
      var ports=portsOf(c);
      var base=slotOf[c.id][ports[0]];
      for(var i=1;i<ports.length;i++) uf.union(base, slotOf[c.id][ports[i]]);
    });

    /* 4. slot root → 임시 노드번호 (1부터; 0은 접지 예약) */
    var rootNode={};
    var nextNode=1;
    function getNode(root){
      if(rootNode[root]==null) rootNode[root]=nextNode++;
      return rootNode[root];
    }

    /* 5. 포트별 노드번호 수집 */
    var portNode={};
    comps.forEach(function(c){
      portNode[c.id]={};
      portsOf(c).forEach(function(p){
        var s=slotOf[c.id][p];
        if(s!=null) portNode[c.id][p]=getNode(uf.find(s));
      });
    });

    /* 6. 전원 탐색 + 접지 후보 = 전원 2번째 포트(음극) */
    var hasDC=false, hasAC=false, groundRoot=null;
    comps.forEach(function(c){
      if(!isSource(c)) return;
      if(c.type===TYPE.DC_SOURCE) hasDC=true; else hasAC=true;
      var ports=portsOf(c);
      groundRoot=uf.find(slotOf[c.id][ports[1]||ports[0]]);
    });
    if(!hasDC&&!hasAC) return fail('전원이 없습니다');

    /* 7a. 접지 노드를 0으로 스왑 (groundRoot의 임시번호 ↔ 0) */
    if(groundRoot!=null && rootNode[groundRoot]!=null){
      var gNum=rootNode[groundRoot];
      if(gNum!==0){
        Object.keys(rootNode).forEach(function(k){
          if(rootNode[k]===gNum) rootNode[k]=0;
          else if(rootNode[k]===0) rootNode[k]=gNum;
        });
        /* portNode 재계산 */
        comps.forEach(function(c){
          portNode[c.id]={};
          portsOf(c).forEach(function(p){
            var s=slotOf[c.id][p];
            if(s!=null){
              var r=uf.find(s);
              portNode[c.id][p]=rootNode[r]!=null?rootNode[r]:0;
            }
          });
        });
      }
    }

    /* 7b. 노드 번호 갭 없이 재압축 (예: {0,1,3,4} → {0,1,2,3}) */
    var usedSet={};
    Object.keys(rootNode).forEach(function(k){ usedSet[rootNode[k]]=1; });
    var nonZero=Object.keys(usedSet).map(Number).filter(function(v){return v!==0;});
    nonZero.sort(function(a,b){return a-b;});
    var compactMap={0:0};
    nonZero.forEach(function(v,i){ compactMap[v]=i+1; });
    comps.forEach(function(c){
      Object.keys(portNode[c.id]).forEach(function(p){
        var prev=portNode[c.id][p];
        portNode[c.id][p]=compactMap[prev]!=null?compactMap[prev]:0;
      });
    });
    var nodeCount=nonZero.length+1;   // 접지(0) + 비접지 노드

    /* 8. compNodes[id]=[nA,nB]: 첫 두 포트 노드 */
    var compNodes={};
    comps.forEach(function(c){
      var ports=portsOf(c);
      var nA=portNode[c.id][ports[0]]||0;
      var nB=portNode[c.id][ports[1]!=null?ports[1]:ports[0]]||0;
      compNodes[c.id]=[nA,nB];
    });

    /* 9. 전압원 단락 검사 (양단 동일 노드 = 단락) */
    for(var ci=0;ci<comps.length;ci++){
      if(!isSource(comps[ci])) continue;
      var nn=compNodes[comps[ci].id];
      if(nn[0]===nn[1]) return fail('단락 회로가 감지되었습니다');
    }

    /* 10. 미연결 소자 검사 (JUNCTION 제외, 양단 동일 노드 = 미연결) */
    for(var ci2=0;ci2<comps.length;ci2++){
      if(isJunction(comps[ci2])) continue;
      var nn2=compNodes[comps[ci2].id];
      if(nn2[0]===nn2[1]) return fail('연결되지 않은 부품이 있습니다');
    }

    return{valid:true,error:null,nodeCount:nodeCount,groundNode:0,
           compNodes:compNodes,portNode:portNode,hasAC:hasAC};
  }

  return{build:build};
})();

}());
