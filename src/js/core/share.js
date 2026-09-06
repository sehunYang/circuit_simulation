(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Share — 회로 저장·공유 (URL 해시)
 *
 *   서버 없이 링크만으로 회로를 나눈다: 소자·도선을 짧은 JSON 으로 직렬화해
 *   base64url 로 감싸 `#c=…` 에 싣는다. 페이지를 열 때 해시가 있으면 복원.
 *   소자 id 는 짧은 번호로 바꿔 싣고 복원 때 새 id 를 만든다.
 *
 *   encode() → 문자열,  decode(str) → {comps, wires} | null
 *   toURL()  → 현재 회로의 공유 URL,  copyLink() → 클립보드 복사 + 토스트
 *   applyFromHash() → 해시가 있으면 회로 복원 (init 에서 호출)
 * ════════════════════════════════════════════════════════════════════ */
App.Share=(function(){
  /* 소자 필드 → 짧은 키 */
  var KEYS=[['type','t'],['gridX','x'],['gridY','y'],['rotation','r'],['value','v'],['value2','w'],
            ['label','l'],['rint','i'],['on','o'],['autoFor','a']];

  function encode(comps, wires){
    comps=comps||App.State.components; wires=wires||App.State.wires;
    var idx={}; comps.forEach(function(c,i){ idx[c.id]=i; });
    var C=comps.map(function(c){
      var o={}; KEYS.forEach(function(k){ var v=c[k[0]]; if(v==null||v===''||(k[0]==='rotation'&&!v)) return;
        if(k[0]==='autoFor'){ if(idx[v]!=null) o[k[1]]=idx[v]; return; }
        o[k[1]]=v; });
      return o;
    });
    var W=wires.map(function(w){ return [idx[w.fromId],w.fromPort,idx[w.toId],w.toPort,(w.direction==='V-first'?1:0)]; })
                .filter(function(a){return a[0]!=null&&a[2]!=null;});
    var json=JSON.stringify({v:2,c:C,w:W,n:App.State.railNotation?1:0});
    return _b64u(json);
  }

  function decode(str){
    try{
      var json=_unb64u(str), d=JSON.parse(json);
      if(!d||!d.c) return null;
      var comps=d.c.map(function(o){
        var c={id:App.State.genId(),type:o.t,gridX:+o.x||0,gridY:+o.y||0,rotation:+o.r||0,
               value:(o.v!=null?o.v:0),value2:(o.w!=null?o.w:null),label:o.l||''};
        if(o.i!=null) c.rint=o.i; if(o.o===false||o.o===true) c.on=o.o;
        if(o.a!=null) c._autoIdx=o.a;
        return c;
      });
      comps.forEach(function(c){ if(c._autoIdx!=null&&comps[c._autoIdx]){ c.autoFor=comps[c._autoIdx].id; } delete c._autoIdx; });
      var wires=(d.w||[]).map(function(a){
        var f=comps[a[0]], t=comps[a[2]]; if(!f||!t) return null;
        return {id:App.State.genId(),fromId:f.id,fromPort:a[1],toId:t.id,toPort:a[3],direction:a[4]?'V-first':'H-first'};
      }).filter(Boolean);
      return {comps:comps, wires:wires, rail:!!d.n};
    }catch(e){ return null; }
  }

  function load(data){
    var S=App.State;
    /* 기존 회로 제거 (자동 스위치는 전원과 함께 지워진다) */
    var ids=S.components.map(function(c){return c.id;});
    ids.forEach(function(id){ if(S.getComponent(id)) S.removeComponent(id); });
    data.comps.forEach(function(c){ S.addComponent(c); });
    data.wires.forEach(function(w){ S.addWire(w); });
    S.selectedId=null;
    App.Events.emit('viewport:changed');
  }

  function toURL(){
    var base=location.href.split('#')[0];
    return base+'#c='+encode();
  }
  function copyLink(){
    var url=toURL();
    var done=function(){ showErrorToast('공유 링크를 복사했습니다 — 붙여넣어 나누세요',2200); };
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done,function(){ prompt('공유 링크', url); });
    else prompt('공유 링크', url);
    try{ history.replaceState(null,'',url); }catch(e){}
    return url;
  }
  function applyFromHash(){
    var m=/[#&]c=([A-Za-z0-9_-]+)/.exec(location.hash||'');
    if(!m) return false;
    var data=decode(m[1]); if(!data) return false;
    load(data);
    if(data.rail&&!App.State.railNotation){ var b=document.getElementById('vis-rail'); if(b) b.click(); }
    return true;
  }

  /* base64url (UTF-8) */
  function _b64u(s){
    var bytes=unescape(encodeURIComponent(s)), b=btoa(bytes);
    return b.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function _unb64u(s){
    s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4) s+='=';
    return decodeURIComponent(escape(atob(s)));
  }

  return{encode:encode, decode:decode, load:load, toURL:toURL, copyLink:copyLink, applyFromHash:applyFromHash};
})();

}());
