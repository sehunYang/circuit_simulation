(function(){
'use strict';

/* 전역 에러 토스트 (어느 모듈에서나 호출 가능) */
window.showErrorToast=function(msg,dur){
  var t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('visible');
  setTimeout(function(){t.classList.remove('visible');},dur||3000);
};

}());
