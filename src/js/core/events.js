(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.Events — 경량 이벤트 버스 (옵저버 패턴)
 *   on/off/emit 만 제공. emit 시 핸들러 배열 복사 후 순회하여
 *   콜백 내 on/off 호출에도 안전.
 * ════════════════════════════════════════════════════════════════════ */
App.Events=(function(){
  var m=Object.create(null);
  return{
    on:  function(ev,fn){(m[ev]||(m[ev]=[])).push(fn);},
    off: function(ev,fn){if(m[ev])m[ev]=m[ev].filter(function(f){return f!==fn;});},
    emit:function(ev,d){(m[ev]||[]).slice().forEach(function(fn){fn(d);});},
  };
})();

}());
