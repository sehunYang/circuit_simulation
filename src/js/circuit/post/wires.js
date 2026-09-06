(function(){
'use strict';
var App=window.App;
App.Post=App.Post||{};

/* ════════════════════════════════════════════════════════════════════
 * App.Post.wireChannels — 도선 전류 (KCL 필링), 채널 벡터 공용
 *
 *   도선은 이상 도체라 스탬프가 없다. 전류는 양끝 소자에서 결정한다:
 *   (1) 끝이 '전류를 아는 소자'면 그 소자의 전류를 방향 맞춰 그대로 사용
 *       (소자 내부 전류 + 는 ports[0]→ports[1]; 도선이 ports[0]에 붙으면
 *        부호 반전, 도선의 to 쪽이면 다시 반전)
 *   (2) 양끝이 연결점(분기점·접지·라벨·닫힌 스위치)이면 KCL 필링:
 *       미지 도선이 1개뿐인 연결점부터 잔차(순유입)를 배정하고,
 *       모두 2개 이상이라 막히면(병렬 이상도체 = 비결정) 균등 분배
 *   (3) 남는 미지(자기 루프 등)는 0
 *
 *   채널: getCompI(comp) 가 길이 K 의 숫자 배열을 돌려주면 각 채널마다
 *   같은 규칙을 적용한다 (DC 1채널, AC {dc,re,im} 3채널, 파형 K표본).
 *
 *   반환: { chan:{wireId: number[K]}, passI:{switchId: number[K]} }
 *     passI: 닫힌 스위치의 전류 (ports[0]→ports[1] +) — 붙은 도선에서 역산
 * ════════════════════════════════════════════════════════════════════ */
App.Post.wireChannels=function(nl, getCompI, K){
  var comps=nl.comps, wires=nl.wires;
  var compById={};
  comps.forEach(function(c){ compById[c.id]=c; });
  /* KCL 필링 대상 = 분기점·닫힌 스위치. 접지·레일 라벨은 제외한다 — 같은 이름의
   *   라벨끼리는 도선 없이 노드로 이어지므로 '이 소자의 도선들' 만으로는 KCL 이
   *   성립하지 않는다 (라벨 하나에 도선 하나 → 잔차 0 → 전류 0 으로 오판). */
  function isPass(c){ return !!c && (App.Netlist.isJunction(c) || nl.passthrough[c.id]); }
  function zeros(){ var a=new Array(K); for(var i=0;i<K;i++) a[i]=0; return a; }

  /* getCompI(c, portId) → 그 포트로 소자에 '들어가는' 전류 채널 (또는 null).
   *   도선 전류 + 는 from→to. 도선의 to 가 이 포트면 유입 = +, from 이면 −. */
  function fromComp(c, portId, isFrom){
    var arr=getCompI(c, portId); if(!arr) return null;
    var s=isFrom?-1:1;
    var out=new Array(K); for(var i=0;i<K;i++) out[i]=s*arr[i];
    return out;
  }

  var chan={}, inc={};
  var passes=comps.filter(isPass);
  passes.forEach(function(j){ inc[j.id]=[]; });

  wires.forEach(function(w){
    var fc=compById[w.fromId], tc=compById[w.toId];
    var fP=isPass(fc)||!fc, tP=isPass(tc)||!tc;
    /* 전류를 아는 쪽(스탬프된 소자)에서 결정. from 쪽이 접지·라벨처럼 전류를
     *   모르면(null) to 쪽을 본다. */
    var a=(!fP)?fromComp(fc,w.fromPort,true):null;
    if(!a&&!tP) a=fromComp(tc,w.toPort,false);
    if(a) chan[w.id]=a;
    if(w.fromId===w.toId) return;            /* 자기 루프: KCL 정보 없음 */
    if(inc[w.fromId]) inc[w.fromId].push(w);
    if(inc[w.toId])   inc[w.toId].push(w);
  });

  function residual(j){
    var r=zeros(), unknown=[];
    inc[j.id].forEach(function(w){
      var ch=chan[w.id];
      if(!ch){ unknown.push(w); return; }
      var s=(w.toId===j.id)?1:-1;
      for(var i=0;i<K;i++) r[i]+=s*ch[i];
    });
    return{r:r, unknown:unknown};
  }
  function assign(j,w,r,frac){
    var s=(w.fromId===j.id)?1:-1;
    var out=new Array(K); for(var i=0;i<K;i++) out[i]=s*r[i]*frac;
    chan[w.id]=out;
  }
  for(;;){
    var progress=false;
    passes.forEach(function(j){
      var st=residual(j);
      if(st.unknown.length===1){ assign(j,st.unknown[0],st.r,1); progress=true; }
    });
    if(progress) continue;
    var stuck=null, stStuck=null;
    for(var i=0;i<passes.length;i++){
      var st2=residual(passes[i]);
      if(st2.unknown.length>=2){ stuck=passes[i]; stStuck=st2; break; }
    }
    if(!stuck) break;
    stStuck.unknown.forEach(function(w){ assign(stuck,w,stStuck.r,1/stStuck.unknown.length); });
  }
  wires.forEach(function(w){ if(!chan[w.id]) chan[w.id]=zeros(); });

  /* 닫힌 스위치 전류: ports[0] 에 붙은 도선에서 역산 (없으면 ports[1]) */
  var passI={};
  comps.forEach(function(c){
    if(!nl.passthrough[c.id]) return;
    var ports=App.Netlist.portsOf(c), out=null;
    for(var pi=0;pi<2&&!out;pi++){
      var port=ports[pi];
      for(var wi=0;wi<wires.length;wi++){
        var w=wires[wi], ch=chan[w.id];
        var atFrom=(w.fromId===c.id&&w.fromPort===port), atTo=(w.toId===c.id&&w.toPort===port);
        if(!atFrom&&!atTo) continue;
        /* 도선 전류 +: from→to. 스위치 전류 +: port0 → 내부 → port1.
         *   port0 에 to 로 붙음 = 전류가 스위치로 들어옴 = +;  from 이면 −.
         *   port1 은 반대. */
        var s=(atTo?1:-1)*(pi===0?1:-1);
        out=new Array(K); for(var i=0;i<K;i++) out[i]=s*ch[i];
        break;
      }
    }
    passI[c.id]=out||zeros();
  });

  return{chan:chan, passI:passI};
};

}());
