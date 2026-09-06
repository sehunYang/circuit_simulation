(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Netlist — 그림(소자·도선) → 회로망(Netlist)
 *
 *   build(comps, wires, opts) 는 전기적으로 같은 점을 하나의 노드 번호로
 *   묶고, 소자마다 양단 노드를 정한다. 솔버는 이 결과만 본다.
 *
 *   노드 병합 규칙 (Union-Find):
 *     1) 도선으로 이어진 포트끼리
 *     2) 분기점(JUNCTION)의 모든 포트끼리
 *     3) 접지(GROUND) 포트 전부 → 하나의 접지 노드
 *     4) 같은 이름의 레일 라벨(LABEL) 포트끼리  (회로이론 표기)
 *     5) 스위치: opts.closed 가 참이면 양 포트 병합(닫힘), 거짓이면 그대로(열림)
 *
 *   기준 노드(0): 접지가 있으면 접지, 없으면 마지막 전원의 음극(둘째 포트).
 *
 *   열린 회로는 오류가 아니다. 전원과 이어지지 않은 부분회로(섬)는 warnings 에
 *   적고 값은 0 으로 나온다. 오류는 물리적으로 해가 없는 경우뿐이다:
 *     '전원이 없습니다' · '단락 회로가 감지되었습니다'(전원 양단 동일 노드)
 *
 *   반환:
 *     { valid, error, warnings:[…], nodeCount, groundNode:0,
 *       compNodes:{id:[nA,nB]}, portNode:{id:{port:n}},
 *       hasAC, hasDC, closed, passthrough:{switchId:true},   // 닫힌 스위치(노드 병합됨)
 *       islands:[{nodes:[…], hasSource}], comps, wires }
 * ════════════════════════════════════════════════════════════════════ */
App.Netlist=(function(){

  function portsOf(c){ return (COMP_PORTS[c.type]||'LR').split(''); }
  function isSource(c){ return c.type===TYPE.DC_SOURCE||c.type===TYPE.AC_SOURCE; }
  function isJunction(c){ return c.type===TYPE.JUNCTION_3||c.type===TYPE.JUNCTION_4; }

  function fail(msg){
    return{valid:false,error:msg,warnings:[],nodeCount:0,groundNode:0,
           compNodes:{},portNode:{},hasAC:false,hasDC:false,closed:true,
           passthrough:{},islands:[],comps:[],wires:[]};
  }

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

  function build(comps, wires, opts){
    opts=opts||{};
    var closed=opts.closed!==false;
    if(!comps.length) return fail('부품이 없습니다');

    /* 1. (소자,포트) 슬롯 */
    var slotOf={}, slot=0;
    comps.forEach(function(c){
      slotOf[c.id]={};
      portsOf(c).forEach(function(p){ slotOf[c.id][p]=slot++; });
    });
    var uf=_uf(slot);

    /* 2. 도선 */
    wires.forEach(function(w){
      var fS=slotOf[w.fromId], tS=slotOf[w.toId];
      if(!fS||!tS) return;
      var a=fS[w.fromPort], b=tS[w.toPort];
      if(a!=null&&b!=null) uf.union(a,b);
    });

    /* 3. 분기점 내부 · 4. 접지·라벨 · 5. 닫힌 스위치 */
    var groundSlot=null, labelSlot={}, passthrough={};
    comps.forEach(function(c){
      var ports=portsOf(c), s0=slotOf[c.id][ports[0]];
      if(isJunction(c)){
        for(var i=1;i<ports.length;i++) uf.union(s0, slotOf[c.id][ports[i]]);
      } else if(c.type===TYPE.GROUND){
        if(groundSlot==null) groundSlot=s0; else uf.union(groundSlot,s0);
      } else if(c.type===TYPE.LABEL){
        var name=(c.label&&c.label.trim())||'VCC';
        if(labelSlot[name]==null) labelSlot[name]=s0; else uf.union(labelSlot[name],s0);
      } else if(c.type===TYPE.SWITCH){
        if(closed){ uf.union(s0, slotOf[c.id][ports[1]]); passthrough[c.id]=true; }
      }
    });

    /* 전원 · 기준 노드 */
    var hasDC=false, hasAC=false, groundRoot=null;
    comps.forEach(function(c){
      if(!isSource(c)) return;
      if(c.type===TYPE.DC_SOURCE) hasDC=true; else hasAC=true;
      var ports=portsOf(c);
      if(groundSlot==null) groundRoot=uf.find(slotOf[c.id][ports[1]]);
    });
    if(groundSlot!=null) groundRoot=uf.find(groundSlot);
    if(!hasDC&&!hasAC) return fail('전원이 없습니다');

    /* 노드 번호 부여 (접지 = 0) */
    var rootNode={}; rootNode[groundRoot]=0;
    var next=1, portNode={};
    comps.forEach(function(c){
      portNode[c.id]={};
      portsOf(c).forEach(function(p){
        var r=uf.find(slotOf[c.id][p]);
        if(rootNode[r]==null) rootNode[r]=next++;
        portNode[c.id][p]=rootNode[r];
      });
    });
    var nodeCount=next;

    var compNodes={};
    comps.forEach(function(c){
      var ports=portsOf(c);
      var nA=portNode[c.id][ports[0]];
      var nB=portNode[c.id][ports[1]!=null?ports[1]:ports[0]];
      compNodes[c.id]=[nA,nB];
    });

    /* 전원 단락 (양단 동일 노드) — 물리적으로 해 없음 */
    for(var ci=0;ci<comps.length;ci++){
      if(!isSource(comps[ci])) continue;
      var nn=compNodes[comps[ci].id];
      if(nn[0]===nn[1]) return fail('단락 회로가 감지되었습니다');
    }

    /* 섬(연결 성분) — 스탬프되는 소자(2포트, 열린 스위치 제외)로 인접 */
    var adj=[]; for(var i=0;i<nodeCount;i++) adj.push([]);
    comps.forEach(function(c){
      if(NODE_TYPES[c.type]) return;
      if(c.type===TYPE.SWITCH&&!closed) return;
      var nn=compNodes[c.id]; if(nn[0]===nn[1]) return;
      adj[nn[0]].push(nn[1]); adj[nn[1]].push(nn[0]);
    });
    var islandOf=new Int32Array(nodeCount); for(var k=0;k<nodeCount;k++) islandOf[k]=-1;
    var islands=[];
    for(var s=0;s<nodeCount;s++){
      if(islandOf[s]>=0) continue;
      var q=[s], nodes=[]; islandOf[s]=islands.length;
      while(q.length){ var cur=q.shift(); nodes.push(cur);
        adj[cur].forEach(function(nb){ if(islandOf[nb]<0){ islandOf[nb]=islands.length; q.push(nb); } }); }
      islands.push({nodes:nodes, hasSource:false});
    }
    comps.forEach(function(c){
      if(!isSource(c)) return;
      var nn=compNodes[c.id];
      islands[islandOf[nn[0]]].hasSource=true; islands[islandOf[nn[1]]].hasSource=true;
    });
    var warnings=[];
    /* 짝이 없는 레일 라벨 — 같은 이름이 하나뿐이면 어디에도 이어지지 않는다 */
    var labelCount={};
    comps.forEach(function(c){ if(c.type===TYPE.LABEL){ var nm=(c.label&&c.label.trim())||'VCC'; labelCount[nm]=(labelCount[nm]||0)+1; } });
    Object.keys(labelCount).forEach(function(nm){ if(labelCount[nm]===1) warnings.push('레일 라벨 '+nm+' 은 짝이 없습니다 — 같은 이름의 라벨이 하나 더 있어야 이어집니다'); });
    var dead=islands.filter(function(is){return !is.hasSource;});
    if(dead.length){
      var deadComps=0;
      comps.forEach(function(c){ if(!NODE_TYPES[c.type]&&!islands[islandOf[compNodes[c.id][0]]].hasSource) deadComps++; });
      if(deadComps>0) warnings.push('전원과 연결되지 않은 부품이 '+deadComps+'개 있습니다 — 그 부분은 전류 0');
    }

    return{valid:true,error:null,warnings:warnings,
           nodeCount:nodeCount,groundNode:0,
           compNodes:compNodes,portNode:portNode,
           hasAC:hasAC,hasDC:hasDC,closed:closed,passthrough:passthrough,
           islands:islands,islandOf:islandOf,comps:comps,wires:wires};
  }

  return{build:build, portsOf:portsOf, isSource:isSource, isJunction:isJunction};
})();

/* 하위 호환 — 예전 이름 */
App.Topology=App.Netlist;

}());
