(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.ValPopup — 소자 값 인라인 수정 팝업
 *   open({title,value,step,min,max,anchorEl,onConfirm}) 로 호출.
 *   anchorEl 아래에 위치하며, 화면 밖으로 넘치면 위/좌로 자동 보정.
 *   Enter=확정, Esc=취소, 외부 클릭=닫기.
 * ════════════════════════════════════════════════════════════════════ */
App.ValPopup=(function(){
  var _popup,_input,_title,_onConfirm=null;

  function _init(){
    _popup=document.getElementById('val-popup');
    _input=document.getElementById('vp-input');
    _title=document.getElementById('vp-title');
    document.getElementById('vp-ok').addEventListener('click',_confirm);
    document.getElementById('vp-cancel').addEventListener('click',_close);
    _input.addEventListener('keydown',function(e){
      e.stopPropagation();
      if(e.key==='Enter') _confirm();
      if(e.key==='Escape') _close();
    });
    _input.addEventListener('pointerdown',function(e){e.stopPropagation();});
    /* 외부 클릭 닫기 */
    document.addEventListener('pointerdown',function(e){
      if(_popup.classList.contains('visible')&&!_popup.contains(e.target)) _close();
    },true);
  }

  function open(opts){
    _onConfirm=opts.onConfirm||null;
    _title.textContent=opts.title||'값 입력';
    _input.step =opts.step||'any';
    _input.min  =opts.min!=null?opts.min:'';
    _input.max  =opts.max!=null?opts.max:'';
    _input.value=opts.value;
    /* 위치: 버튼 아래 */
    if(opts.anchorEl){
      var r=opts.anchorEl.getBoundingClientRect();
      var left=r.left, top=r.bottom+6;
      if(left+224>window.innerWidth-8) left=window.innerWidth-232;
      if(top+170>window.innerHeight-8) top=r.top-176;
      _popup.style.left=left+'px'; _popup.style.top=top+'px';
    }
    _popup.classList.add('visible');
    setTimeout(function(){_input.focus();_input.select();},30);
  }

  function _confirm(){
    var v=parseFloat(_input.value);
    if(!isNaN(v)&&_onConfirm) _onConfirm(v);
    _close();
  }
  function _close(){_popup.classList.remove('visible');_onConfirm=null;}

  return{init:_init,open:open,close:_close};
})();

}());
