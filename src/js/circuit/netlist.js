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
 *        — 전위(value)가 0 이 아닌 라벨은 접지 기준 이상 직류 전원 (railSource)
 *     5) 스위치: opts.closed 가 참이면 양 포트 병합(닫힘), 거짓이면 그대로(열림)
 *
 *   기준 노드(0): 접지가 있으면 접지, 없으면 마지막 전원의 음극(둘째 포트).
 *
 *   열린 회로는 오류가 아니다. 전원과 이어지지 않은 부분회로(섬)는 warnings 에
 *   적고 값은 0 으로 나온다. 오류는 물리적으로 해가 없는 경우뿐이다:
 *     '전원이 없습니다' · '단락 회로가 감지되었습니다'(전원 양단 동일 노드)
 *
 *   상호유도: 인덕터 comp.couple = 짝 인덕터 id (서로 가리켜야 유효), comp.value2 = 결합 계수 k.
 *     couples:[{a,b,k}] 로 돌려주고, 짝을 통해 에너지를 받는 섬은 '전원 있음' 으로 본다.
 *   기준 노드 핀(pinNodes): 접지 노드가 없는 섬(변압기 2차 등)은 절대 전위가 정해지지
 *     않아 행렬이 특이해진다 — 섬마다 노드 하나를 접지에 묶어(1 S) 전위 0 으로 고정한다.
 *     섬 안에 접지로 가는 다른 길이 없으므로 전류는 흐르지 않고 값은 바뀌지 않는다.
 *
 *   반환:
 *     { valid, error, warnings:[…], nodeCount, groundNode:0,
 *       compNodes:{id:[nA,nB]}, portNode:{id:{port:n}},
 *       hasAC, hasDC, closed, passthrough:{switchId:true},   // 닫힌 스위치(노드 병합됨)
 *       islands:[{nodes:[…], hasSource}], couples:[{a,b,k}], pinNodes:[n…], comps, wires }
 * ════════════════════════════════════════════════════════════════════ */
App.Netlist=(function(){

  function portsOf(c){ return (COMP_PORTS[c.type]||'LR').split(''); }
  function isSource(c){ return c.type===TYPE.DC_SOURCE||c.type===TYPE.AC_SOURCE; }
  function isJunction(c){ return c.type===TYPE.JUNCTION_3||c.type===TYPE.JUNCTION_4; }

  function fail(msg){
    return{valid:false,error:msg,warnings:[],nodeCount:0,groundNode:0,
           compNodes:{},portNode:{},hasAC:false,hasDC:false,closed:true,
           passthrough:{},islands:[],couples:[],pinNodes:[],comps:[],wires:[]};
  }

  /* 유효한 결합 쌍 — 두 인덕터가 서로를 couple 로 가리킬 때만 (한쪽만 가리키면 무시) */
  function couplesOf(comps){
    var byId={}; comps.forEach(function(c){ byId[c.id]=c; });
    var out=[], seen={};
    comps.forEach(function(c){
      if(c.type!==TYPE.INDUCTOR||!c.couple||seen[c.id]) return;
      var p=byId[c.couple];
      if(!p||p.type!==TYPE.INDUCTOR||p.couple!==c.id||p.id===c.id) return;
      seen[c.id]=true; seen[p.id]=true;
      out.push({a:c.id, b:p.id, k:coupleK(c)});
    });
    return out;
  }
  /* 결합 계수 k (0 < k ≤ 0.999) — k=1 은 인덕턴스 행렬이 특이해지므로 살짝 아래로 제한 */
  function coupleK(c){ var k=+c.value2; if(!isFinite(k)||k<=0) k=0.99; return Math.min(k, 0.999); }
  function coupledPartner(c, comps){
    if(!c||c.type!==TYPE.INDUCTOR||!c.couple) return null;
    for(var i=0;i<comps.length;i++){ var p=comps[i]; if(p.id===c.couple) return (p.type===TYPE.INDUCTOR&&p.couple===c.id)?p:null; }
    return null;
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
        var name=labelName(c);
        if(labelSlot[name]==null) labelSlot[name]=s0; else uf.union(labelSlot[name],s0);
      } else if(c.type===TYPE.SWITCH){
        if(switchClosed(c, closed)){ uf.union(s0, slotOf[c.id][ports[1]]); passthrough[c.id]=true; }
      }
    });

    /* 레일 전원: 전위가 0 이 아닌 라벨은 접지 기준의 이상 직류 전원이다.
     *   같은 이름은 한 노드이므로 이름당 한 번만 스탬프한다 (railSource 에 첫 라벨). */
    var railSource={}, railSeen={}, hasRail=false;
    comps.forEach(function(c){
      if(c.type!==TYPE.LABEL||!railVoltage(c)) return;
      var nm=labelName(c);
      if(railSeen[nm]) return;
      railSeen[nm]=true; railSource[c.id]=true; hasRail=true;
    });
    if(hasRail&&groundSlot==null) return fail('레일 전위를 쓰려면 접지(GND)가 있어야 합니다');

    /* 전원 · 기준 노드 */
    var hasDC=false, hasAC=false, groundRoot=null;
    comps.forEach(function(c){
      if(!isSource(c)) return;
      if(c.type===TYPE.DC_SOURCE) hasDC=true; else hasAC=true;
      var ports=portsOf(c);
      if(groundSlot==null) groundRoot=uf.find(slotOf[c.id][ports[1]]);
    });
    if(groundSlot!=null) groundRoot=uf.find(groundSlot);
    if(hasRail) hasDC=true;
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

    /* compNodes: 포트 순서대로의 노드 목록. 2포트 = [nA,nB], 1포트 = [n,n],
     *   3포트(BJT: B,C,E) = [nB,nC,nE]. 소비자 대부분은 [0],[1] 만 본다. */
    var compNodes={};
    comps.forEach(function(c){
      var ports=portsOf(c);
      var arr=[];
      ports.forEach(function(p){ arr.push(portNode[c.id][p]); });
      if(arr.length===1) arr.push(arr[0]);
      compNodes[c.id]=arr;
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
      if(c.type===TYPE.SWITCH&&!passthrough[c.id]) return;   /* 열린 스위치는 잇지 않는다 */
      var nn=compNodes[c.id];
      for(var a=0;a<nn.length;a++) for(var b2=a+1;b2<nn.length;b2++){
        if(nn[a]===nn[b2]) continue;
        adj[nn[a]].push(nn[b2]); adj[nn[b2]].push(nn[a]);
      }
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
      if(!isSource(c)&&!railSource[c.id]) return;
      var nn=compNodes[c.id];
      islands[islandOf[nn[0]]].hasSource=true; islands[islandOf[nn[1]]].hasSource=true;
    });
    /* 초기 에너지를 가진 소자(스위치를 여는 과도의 인덕터 전류·축전기 전압)가 있는 섬도 살아 있다 */
    if(opts.energized) comps.forEach(function(c){ if(opts.energized[c.id]){ var nn=compNodes[c.id]; islands[islandOf[nn[0]]].hasSource=true; islands[islandOf[nn[1]]].hasSource=true; } });
    /* 상호유도로 이어진 섬: 한쪽에 전원이 있으면 다른 쪽도 살아 있는 회로 (반복 전파) */
    var couples=couplesOf(comps), changed=true;
    while(changed){
      changed=false;
      couples.forEach(function(cp){
        var ia=islands[islandOf[compNodes[cp.a][0]]], ib=islands[islandOf[compNodes[cp.b][0]]];
        if(ia.hasSource!==ib.hasSource){ ia.hasSource=ib.hasSource=true; changed=true; }
      });
    }
    /* 기준 노드 핀: 접지(0)가 없는 섬마다 노드 하나 */
    var pinNodes=[];
    islands.forEach(function(is){ if(is.nodes.indexOf(0)<0&&is.nodes.length) pinNodes.push(is.nodes[0]); });
    var warnings=[];
    /* 짝이 없는 레일 라벨 — 같은 이름이 하나뿐이면 어디에도 이어지지 않는다 */
    var labelCount={};
    comps.forEach(function(c){ if(c.type===TYPE.LABEL){ var nm=labelName(c); labelCount[nm]=(labelCount[nm]||0)+1; } });
    Object.keys(labelCount).forEach(function(nm){ if(labelCount[nm]===1&&!railSeen[nm]) warnings.push('레일 라벨 '+nm+' 은 짝이 없습니다 — 같은 이름의 라벨을 하나 더 두거나, 전위를 주어 전원으로 쓰세요'); });
    var dead=islands.filter(function(is){return !is.hasSource;});
    if(dead.length){
      var deadComps=0;
      comps.forEach(function(c){ if(!NODE_TYPES[c.type]&&!islands[islandOf[compNodes[c.id][0]]].hasSource) deadComps++; });
      if(deadComps>0) warnings.push('전원과 연결되지 않은 부품이 '+deadComps+'개 있습니다 — 그 부분은 전류 0');
    }

    return{valid:true,error:null,warnings:warnings,
           nodeCount:nodeCount,groundNode:0,
           compNodes:compNodes,portNode:portNode,railSource:railSource,
           hasAC:hasAC,hasDC:hasDC,closed:closed,passthrough:passthrough,
           islands:islands,islandOf:islandOf,couples:couples,pinNodes:pinNodes,comps:comps,wires:wires};
  }

  /* 스위치 상태 — comp.on:
   *   undefined = 자동 (편집 열림 · 실행 닫힘),  true = 닫힘 유지,  false = 열림 유지 */
  function switchClosed(c, closedMode){ return c.on===true || (!!closedMode && c.on!==false); }
  function labelName(c){ return (c.label&&c.label.trim())||'VCC'; }
  /* 레일 라벨의 전위 (0 = 연결 라벨만) */
  function railVoltage(c){ var v=+c.value||0; return isFinite(v)?v:0; }

  return{build:build, portsOf:portsOf, isSource:isSource, isJunction:isJunction,
         switchClosed:switchClosed, labelName:labelName, railVoltage:railVoltage,
         couplesOf:couplesOf, coupleK:coupleK, coupledPartner:coupledPartner};
})();

/* 하위 호환 — 예전 이름 */
App.Topology=App.Netlist;

}());
