(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.PropPanel — 선택된 소자/도선의 속성 패널
 *
 *   소자: 유형 헤더 · 이름 입력 · 물리량(값 버튼→ValPopup) · 연결 정보
 *         · 측정값(전류/전압/전력, DC/AC 분기) · 회전/삭제
 *   도선: 출발/도착 · 꺾임 방향 전환 · 전류 · 삭제
 *
 *   FIELDS 테이블: 소자별 편집 가능 물리량 정의
 *     {label, key, unit, ds(표시배율), df(소수자리), min, max, step}
 * ════════════════════════════════════════════════════════════════════ */
App.PropPanel=(function(){
  var _panel,_content;

  var LABELS={
    DC_SOURCE:'직류 전원',AC_SOURCE:'교류 전원',RESISTOR:'저항',
    CAPACITOR:'축전기',INDUCTOR:'인덕터',
    JUNCTION_3:'3방향 교차',JUNCTION_4:'4방향 교차',
    SWITCH:'스위치',GROUND:'접지',LABEL:'레일 라벨',
    BULB:'전구',DIODE:'p-n 접합 다이오드',NPN:'트랜지스터 (npn)',PNP:'트랜지스터 (pnp)',
  };

  // {label, key, unit, displayScale, displayFixed, min, max, step}
  //   rint(내부저항) 은 값이 없으면 0 으로 취급한다 (예전 회로 호환)
  var RINT={label:'내부저항', key:'rint', unit:'Ω', ds:1, df:2, min:0, max:1e6, step:0.1, optional:true};
  var FIELDS={
    DC_SOURCE:[{label:'전압',    key:'value', unit:'V',  ds:1,   df:1, min:0,     max:9999, step:1}, RINT],
    /* 레일 라벨: 전위 0 = 연결 라벨만, 0 이 아니면 접지 기준 직류 전원 (같은 이름은 함께 바뀐다) */
    LABEL:    [{label:'전위',    key:'value', unit:'V',  ds:1,   df:1, min:-999,  max:999,  step:1, syncName:true}],
    /* 교류 전원의 value 는 진폭(최댓값)이다 — 가정용 220 V 처럼 실효값으로 읽기 쉬워 라벨에 명시한다.
        실효값은 아래 측정값의 “전압(RMS)” 에 따로 나온다 (사인파면 최댓값/√2). */
    AC_SOURCE:[{label:'전압(최댓값)',key:'value',unit:'V',ds:1, df:1, min:0,     max:9999, step:1},
               {label:'주파수', key:'value2',unit:'Hz', ds:1,   df:0, min:1,     max:1e6,  step:1}, RINT],
    RESISTOR: [{label:'저항',   key:'value', unit:'Ω',  ds:1,   df:0, min:0.001, max:1e9,  step:1}],
    BULB:     [{label:'저항',   key:'value', unit:'Ω',  ds:1,   df:0, min:0.001, max:1e9,  step:1},
               {label:'정격전력',key:'value2',unit:'W', ds:1,   df:2, min:0.001, max:1e4,  step:0.1}],
    CAPACITOR:[{label:'전기용량',key:'value',unit:'µF', ds:1e6, df:2, min:0.001, max:1e6,  step:1}],
    INDUCTOR: [{label:'인덕턴스',key:'value',unit:'mH', ds:1e3, df:2, min:0.001, max:1e6,  step:1}],
    NPN:      [{label:'전류이득 β',key:'value',unit:'', ds:1,   df:0, min:1,     max:1000, step:1}],
    PNP:      [{label:'전류이득 β',key:'value',unit:'', ds:1,   df:0, min:1,     max:1000, step:1}],
  };

  // ── 측정값 포맷 — 크기에 따라 단위 자동 선택 ──

  /* 범용 SI 소단위 포맷터: value(기본단위) → "12.34 µX" 형태
   *   unit: 기본 단위 문자(C/Wb/J 등). p/n/µ/m 접두어 자동 선택. */
  function _fmtSI(value, unit){
    var a=Math.abs(value);
    if(a<1e-9) return (value*1e12).toFixed(2)+' p'+unit;
    if(a<1e-6) return (value*1e9 ).toFixed(2)+' n'+unit;
    if(a<1e-3) return (value*1e6 ).toFixed(2)+' µ'+unit;
    if(a<1)    return (value*1e3 ).toFixed(2)+' m'+unit;
    return value.toFixed(4)+' '+unit;
  }
  function _fmtCurrent(A){
    if(A==null) return '계산 불가';
    var abs=Math.abs(A);
    if(abs<1e-12) return '0 A';   /* 수치 잔차(1e-18 등)도 0 — "0.00 nA" 로 보이지 않게 */
    if(abs<1e-6)  return (A*1e9).toFixed(2)+' nA';
    if(abs<1e-3)  return (A*1e6).toFixed(2)+' µA';
    if(abs<1)     return (A*1e3).toFixed(3)+' mA';
    return A.toFixed(4)+' A';
  }
  function _fmtVoltage(V){
    if(V==null) return '계산 불가';
    if(Math.abs(V)<0.001) return (V*1000).toFixed(2)+' mV';
    return V.toFixed(4)+' V';
  }
  function _fmtPower(W){
    if(W==null) return '계산 불가';
    return W.toFixed(2)+' W'; // 교육용: W 고정
  }

  function init(){_panel=document.getElementById('prop-panel');_content=document.getElementById('prop-content');}

  function show(id){
    var comp=App.State.getComponent(id);
    if(!comp){var wire=App.State.getWire(id);if(wire){_renderWire(wire);return;}hide();return;}
    _panel.classList.add('visible');
    _renderComp(comp);
  }

  function hide(){_panel.classList.remove('visible');if(_content)_content.innerHTML='';}

  function refresh(){var id=App.State.selectedId;if(id)show(id);else hide();}

  function _renderComp(comp){
    _content.innerHTML='';

    /* ── 유형 헤더 ── */
    var hdr=document.createElement('div');
    hdr.style.cssText='color:var(--text-accent);font-weight:700;font-size:11px;margin-bottom:8px;'+
                      'display:flex;align-items:center;justify-content:space-between';
    var typeSpan=document.createElement('span');typeSpan.textContent=LABELS[comp.type]||comp.type;
    var rotInfo=document.createElement('span');
    rotInfo.style.cssText='color:var(--text-dim);font-size:10px';
    rotInfo.textContent=comp.rotation+'°';
    hdr.appendChild(typeSpan);hdr.appendChild(rotInfo);
    _content.appendChild(hdr);

    /* ── 사용자 라벨 입력 ── */
    var lblRow=document.createElement('div');lblRow.className='pp-row';
    var lblKey=document.createElement('span');lblKey.className='pp-key';lblKey.textContent='이름';
    var lblInp=document.createElement('input');
    lblInp.className='pp-input';lblInp.type='text';
    lblInp.style.width='100px';
    lblInp.placeholder='(선택사항)';
    lblInp.value=comp.label||'';
    lblInp.addEventListener('focus',function(){this.select();});
    lblInp.addEventListener('keydown',function(e){
      e.stopPropagation(); // 키보드 단축키 차단
      if(e.key==='Enter'){this.blur();}
      if(e.key==='Escape'){this.value=comp.label||'';this.blur();}
    });
    lblInp.addEventListener('change',function(){
      comp.label=this.value.trim();
      rotInfo.textContent=comp.rotation+'°';
      App.Events.emit('state:changed');
      if(comp.type===TYPE.LABEL) show(comp.id);   /* 전위 안내·측정값 갱신 */
    });
    lblInp.addEventListener('pointerdown',function(e){e.stopPropagation();});
    lblRow.appendChild(lblKey);lblRow.appendChild(lblInp);
    _content.appendChild(lblRow);

    /* ── 물리량 입력 ── */
    (FIELDS[comp.type]||[]).forEach(function(f){
      var raw=comp[f.key];
      if(raw==null){ if(!f.optional) return; comp[f.key]=0; }
      var row=document.createElement('div');row.className='pp-row';
      var k=document.createElement('span');k.className='pp-key';k.textContent=f.label+' ('+f.unit+')';

      /* 현재 값 표시 버튼 — 클릭 시 팝업 열기 */
      var valBtn=document.createElement('button');
      valBtn.className='pp-input';
      valBtn.style.cssText='cursor:pointer;text-align:right;width:90px;padding:3px 8px;'+
        'font-size:12px;font-family:var(--font);font-weight:700;color:var(--text-base);'+
        'background:#ffffff;border:1px solid var(--border-base);border-radius:6px;';
      function _refreshValBtn(){
        valBtn.textContent=(comp[f.key]*f.ds).toFixed(f.df)+' '+f.unit;
      }
      _refreshValBtn();

      valBtn.addEventListener('click',function(e){
        e.stopPropagation();
        App.ValPopup.open({
          title: f.label+' ('+f.unit+')',
          value: comp[f.key]*f.ds,
          step:  f.step||'any',
          min:   f.min||0,
          max:   f.max,
          anchorEl: valBtn,
          onConfirm: function(v){
            var clamped=Math.max(f.min||0, f.max?Math.min(f.max,v):v);
            comp[f.key]=clamped/f.ds;
            /* 같은 이름의 레일 라벨은 한 노드이므로 전위도 하나 */
            if(f.syncName){
              var nm=App.Netlist.labelName(comp);
              App.State.components.forEach(function(c2){ if(c2.type===comp.type&&c2.id!==comp.id&&App.Netlist.labelName(c2)===nm) c2[f.key]=comp[f.key]; });
            }
            _refreshValBtn();
            App.Events.emit('state:changed');
          }
        });
      });
      valBtn.addEventListener('pointerdown',function(e){e.stopPropagation();});
      row.appendChild(k);row.appendChild(valBtn);_content.appendChild(row);
    });

    /* ── 연결 정보 ── */
    if(comp.type!==TYPE.JUNCTION_3&&comp.type!==TYPE.JUNCTION_4){
      var ports=App.Geo.getCompPorts(comp);
      var connCount=ports.reduce(function(n,p){return n+App.State.getPortWires(comp.id,p).length;},0);
      _content.appendChild(_row('연결',connCount>0?connCount+'개 도선':'없음'));
    }

    /* ── 스위치 개폐 ──
     *   comp.on: undefined = 자동(편집 열림 · 실행 닫힘), true = 닫힘 유지, false = 열림 유지.
     *   편집 모드에서도 여기서 열고 닫을 수 있다 — 자동 스위치를 닫으면 편집 중에도 닫힌 회로가 풀린다. */
    if(comp.type===TYPE.SWITCH){
      var swClosed=App.Netlist.switchClosed(comp, App.State.mode!=='edit');
      var swRow=document.createElement('div');swRow.className='pp-row';
      var swKey=document.createElement('span');swKey.className='pp-key';swKey.textContent='스위치';
      var swVal=document.createElement('span');swVal.className='pp-val';swVal.style.cssText='display:flex;gap:4px;justify-content:flex-end';
      var swBtn=_btn(swClosed?'닫힘 → 열기':'열림 → 닫기','pp-btn-rotate',function(){
        comp.on=!swClosed;
        App.Events.emit('state:changed'); App.Solver.solveNow(); show(comp.id);
      });
      swBtn.style.cssText='flex:0 0 auto;padding:2px 8px';
      swVal.appendChild(swBtn);
      if(comp.on!=null){
        var autoBtn=_btn('자동','pp-btn-rotate',function(){
          delete comp.on;
          App.Events.emit('state:changed'); App.Solver.solveNow(); show(comp.id);
        });
        autoBtn.title='편집 모드에서 열림, 실행 모드에서 닫힘';
        autoBtn.style.cssText='flex:0 0 auto;padding:2px 8px;opacity:.8';
        swVal.appendChild(autoBtn);
      }
      swRow.appendChild(swKey);swRow.appendChild(swVal);_content.appendChild(swRow);
      var swHint=document.createElement('div');
      swHint.style.cssText='color:var(--text-dim);font-size:9px;text-align:right;margin:-4px 0 6px';
      swHint.textContent=comp.on==null?'자동: 편집 열림 · 실행 닫힘':(comp.on?'닫힘 유지 (편집 중에도 닫힘)':'열림 유지 (실행 중에도 열림)');
      _content.appendChild(swHint);
    }
    /* ── 레일 라벨 안내 ── */
    if(comp.type===TYPE.LABEL){
      var rv=App.Netlist.railVoltage(comp);
      var lhint=document.createElement('div');
      lhint.style.cssText='color:var(--text-dim);font-size:9px;text-align:right;margin:-4px 0 6px';
      lhint.textContent=rv?('접지(GND) 기준 '+rv+' V 전원 — 같은 이름 '+App.Netlist.labelName(comp)+' 은 한 노드'):('0 V = 연결 라벨만 (같은 이름 = 같은 노드) · 전위를 주면 전원');
      _content.appendChild(lhint);
    }

    /* ── 인덕터 상호유도 (결합) ──
     *   comp.couple = 짝 id (서로 가리켜야 유효), value2 = 결합 계수 k (둘이 같은 값).
     *   옆 칸(상하좌우)의 결합 안 된 인덕터와 묶을 수 있다. */
    if(comp.type===TYPE.INDUCTOR){
      var allC=App.State.components, partner=App.Netlist.coupledPartner(comp, allC);
      var cpRow=document.createElement('div');cpRow.className='pp-row';
      var cpKey=document.createElement('span');cpKey.className='pp-key';cpKey.textContent='상호유도';
      var cpVal=document.createElement('span');cpVal.className='pp-val';cpVal.style.cssText='display:flex;gap:4px;justify-content:flex-end;align-items:center';
      if(partner){
        var pTxt=document.createElement('span'); pTxt.style.cssText='font-size:10px;color:var(--text-dim)';
        pTxt.textContent='짝: '+((partner.label&&partner.label.trim())||'인덕터 '+_fmtSI(partner.value||0,'H'));
        cpVal.appendChild(pTxt);
        var offBtn=_btn('해제','pp-btn-rotate',function(){
          delete comp.couple; delete partner.couple;
          App.Events.emit('state:changed'); App.Solver.solveNow(); show(comp.id);
        });
        offBtn.style.cssText='flex:0 0 auto;padding:2px 8px'; cpVal.appendChild(offBtn);
      } else {
        var nb=_adjacentInductor(comp);
        var onBtn=_btn(nb?'옆 인덕터와 결합':'결합할 인덕터 없음','pp-btn-rotate',function(){
          if(!nb) return;
          comp.couple=nb.id; nb.couple=comp.id;
          if(!(comp.value2>0)) comp.value2=0.99; nb.value2=comp.value2;
          App.Events.emit('state:changed'); App.Solver.solveNow(); show(comp.id);
        });
        onBtn.style.cssText='flex:0 0 auto;padding:2px 8px'+(nb?'':';opacity:.5');
        cpVal.appendChild(onBtn);
      }
      cpRow.appendChild(cpKey);cpRow.appendChild(cpVal);_content.appendChild(cpRow);
      var cHint=document.createElement('div');
      cHint.style.cssText='color:var(--text-dim);font-size:9px;text-align:right;margin:-4px 0 6px';
      if(partner){
        var kRow=document.createElement('div');kRow.className='pp-row';
        var kKey=document.createElement('span');kKey.className='pp-key';kKey.textContent='결합 계수 k';
        var kBtn=document.createElement('button');kBtn.className='pp-input';
        kBtn.style.cssText='cursor:pointer;text-align:right;width:90px;padding:3px 8px;'+
          'font-size:12px;font-family:var(--font);font-weight:700;color:var(--text-base);'+
          'background:#ffffff;border:1px solid var(--border-base);border-radius:6px;';
        var _refreshK=function(){ kBtn.textContent=App.Netlist.coupleK(comp).toFixed(3); };
        _refreshK();
        kBtn.addEventListener('click',function(e){
          e.stopPropagation();
          App.ValPopup.open({ title:'결합 계수 k (0 ~ 1)', value:App.Netlist.coupleK(comp), step:0.01, min:0.01, max:1, anchorEl:kBtn,
            onConfirm:function(v){ var kk=Math.max(0.01,Math.min(1,v)); comp.value2=kk; partner.value2=kk; _refreshK(); App.Events.emit('state:changed'); refresh(); } });
        });
        kBtn.addEventListener('pointerdown',function(e){e.stopPropagation();});
        kRow.appendChild(kKey);kRow.appendChild(kBtn);_content.appendChild(kRow);
        var Mval=App.Netlist.coupleK(comp)*Math.sqrt((comp.value||0)*(partner.value||0));
        _content.appendChild(_row('M = k√(L₁L₂)', _fmtSI(Mval,'H')));
        cHint.textContent='짝의 전류가 변할 때만 기전력 M·di/dt 가 생깁니다 · 점 = 같은 극성 끝';
      } else {
        cHint.textContent=nb?'옆 칸의 인덕터와 묶으면 변압기(상호유도)가 됩니다':'옆 칸에 인덕터를 나란히 놓고 결합하면 변압기가 됩니다';
      }
      _content.appendChild(cHint);
    }

    /* ── 측정값 ──
     *   편집 모드(스위치 열림)에서는 '열림 · 닫으면' 두 상태를 나란히 보인다.
     *   행 생성은 _measureRows(view, comp) 하나로 통일 — 두 상태가 같은 코드를 쓴다. */
    var sr=App.State.solverResult;
    var mDiv=document.createElement('div');mDiv.className='pp-measure';
    var twoState=!!(sr&&sr.hasSwitches&&App.State.mode==='edit'&&sr.open&&sr.closed&&sr.open!==sr.closed);
    if(twoState){
      var head=document.createElement('div');head.className='pp-row';
      var hk=document.createElement('span');hk.className='pp-key';hk.textContent='';
      var hv=document.createElement('span');hv.className='pp-val';
      hv.style.cssText='display:flex;gap:8px;color:var(--text-label);font-size:9px';
      var h1=document.createElement('span');h1.textContent='열림(지금)';h1.style.flex='1';h1.style.textAlign='right';
      var h2=document.createElement('span');h2.textContent='닫으면';h2.style.flex='1';h2.style.textAlign='right';
      hv.appendChild(h1);hv.appendChild(h2);head.appendChild(hk);head.appendChild(hv);mDiv.appendChild(head);
      var rowsO=sr.open.valid?_measureRows(sr.open,comp):[], rowsC=sr.closed.valid?_measureRows(sr.closed,comp):[];
      var keys=[];
      rowsC.forEach(function(r){keys.push(r.key);});
      rowsO.forEach(function(r){if(keys.indexOf(r.key)<0)keys.push(r.key);});
      keys.forEach(function(k){
        var o=null,c=null;
        rowsO.forEach(function(r){if(r.key===k)o=r;}); rowsC.forEach(function(r){if(r.key===k)c=r;});
        mDiv.appendChild(_row2(k, o?o.val:'—', c?c.val:'—'));
      });
      if(sr.closed.error) mDiv.appendChild(_errDiv('닫으면: '+sr.closed.error));
    } else if(sr&&sr.valid){
      _measureRows(sr,comp).forEach(function(r){ mDiv.appendChild(_row(r.key,r.val)); });
      if(sr.warnings&&sr.warnings.length) mDiv.appendChild(_warnDiv(sr.warnings[0]));
    } else if(sr&&sr.error){
      mDiv.appendChild(_errDiv(sr.error));
    } else {
      var hint=document.createElement('div');
      hint.style.cssText='color:var(--text-dim);font-size:10px;text-align:center;padding:3px 0';
      hint.textContent='— 회로 완성 후 자동 계산 —';mDiv.appendChild(hint);
    }
    _content.appendChild(mDiv);

    /* ── 회전 / 삭제 버튼 ── */
    var isJunction=comp.type===TYPE.JUNCTION_3||comp.type===TYPE.JUNCTION_4;
    var btns=document.createElement('div');btns.className='pp-btns';
    if(comp.type!==TYPE.JUNCTION_4){  /* JUNCTION_4만 회전 제외, J3는 허용 */
      btns.appendChild(_btn('↻ 회전','pp-btn-rotate',function(){
        App.State.rotateComponent(comp.id);
        rotInfo.textContent=comp.rotation+'°';
        show(comp.id);
      }));
    }
    btns.appendChild(_btn('✕ 삭제','pp-btn-delete',function(){
      var id=App.State.selectedId;if(!id) return;
      if(!App.State.removeComponent(id)){showErrorToast('전원에 딸린 스위치는 전원과 함께 삭제됩니다',1800);return;}
      App.EditRenderer.stopSelAnimation();hide();
    }));
    _content.appendChild(btns);
  }

  function _renderWire(wire){
    _panel.classList.add('visible');_content.innerHTML='';

    /* ── 헤더 ── */
    var hdr=document.createElement('div');
    hdr.style.cssText='color:#7ec8f0;font-weight:700;font-size:11px;margin-bottom:8px';
    hdr.textContent='도선';_content.appendChild(hdr);

    /* ── 연결 정보 ── */
    var fromComp=App.State.getComponent(wire.fromId);
    var toComp=App.State.getComponent(wire.toId);
    if(fromComp&&toComp){
      _content.appendChild(_row('출발',(LABELS[fromComp.type]||fromComp.type)+' · '+wire.fromPort));
      _content.appendChild(_row('도착',(LABELS[toComp.type]||toComp.type)+' · '+wire.toPort));
    }

    /* ── 꺾임 방향 전환 ── */
    var dirRow=document.createElement('div');dirRow.className='pp-row';
    var dk=document.createElement('span');dk.className='pp-key';dk.textContent='꺾임 방향';
    var tb=document.createElement('button');
    tb.style.cssText='flex:none;padding:3px 10px;font-size:10px;cursor:pointer;font-family:var(--font);'+
                     'border-radius:4px;border:1px solid var(--border-base);background:#f1f5fb;color:var(--text-accent2)';
    tb.textContent=wire.direction==='H-first'?'H→V':'V→H';
    tb.addEventListener('click',function(){
      wire.direction=wire.direction==='H-first'?'V-first':'H-first';
      tb.textContent=wire.direction==='H-first'?'H→V':'V→H';
      App.Events.emit('state:changed');
    });
    tb.addEventListener('pointerdown',function(e){e.stopPropagation();});
    dirRow.appendChild(dk);dirRow.appendChild(tb);_content.appendChild(dirRow);

    /* ── 힌트 ── */
    var hintEl=document.createElement('div');
    hintEl.style.cssText='color:var(--text-dim);font-size:9px;text-align:center;padding:2px 0 4px';
    hintEl.textContent='◇ 핸들 탭으로도 방향 전환';_content.appendChild(hintEl);

    /* ── 도선 측정값 ── */
    var sr2=App.State.solverResult;
    if(sr2&&sr2.valid){
      var wMeas=document.createElement('div');wMeas.className='pp-measure';
      var wireI=(sr2.wireCurrents&&sr2.wireCurrents[wire.id]!=null)
        ? sr2.wireCurrents[wire.id]
        : null;
      wMeas.appendChild(_row('전류', _fmtCurrent(wireI)));
      _content.appendChild(wMeas);
    } else if(sr2&&sr2.error){
      var wErr=document.createElement('div');
      wErr.style.cssText='color:var(--danger-text);font-size:10px;padding:4px 0;text-align:center';
      wErr.textContent='⚠ '+sr2.error;_content.appendChild(wErr);
    }

    /* ── 삭제 ── */
    var btns=document.createElement('div');btns.className='pp-btns';
    var del=_btn('✕ 도선 삭제','pp-btn-delete',function(){
      App.State.removeWire(wire.id);App.EditRenderer.stopSelAnimation();hide();
    });
    del.style.width='100%';btns.appendChild(del);_content.appendChild(btns);
  }

  /* ── 측정값 행 목록 [{key, val}] — 뷰(view) 하나에 대해 ──
   *   view: 솔버 뷰(sr, sr.open, sr.closed 모두 같은 모양) */
  function _measureRows(sr, comp){
    var rows=[];
    function push(key,val){ rows.push({key:key,val:val}); }
    var cn=sr.componentNodes||{};
    /* 연결점 소자: 전위만 */
    if(comp.type===TYPE.GROUND||comp.type===TYPE.LABEL){
      var nd=cn[comp.id]?cn[comp.id][0]:null;
      push('전위', nd!=null?_fmtVoltage(sr.nodeVoltages[nd]||0):'—');
      /* 레일 전원: 이 라벨이 공급하는 전류·전력 (이름당 첫 라벨만 스탬프) */
      if(comp.type===TYPE.LABEL&&App.Netlist.railVoltage(comp)&&sr.branchCurrents[comp.id]!=null){
        var Ir=sr.branchCurrents[comp.id];
        push('공급 전류', _fmtCurrent(Math.abs(Ir)));
        push('공급 전력', _fmtPower(Math.abs(Ir*App.Netlist.railVoltage(comp))));
      }
      return rows;
    }
    if(comp.type===TYPE.JUNCTION_3||comp.type===TYPE.JUNCTION_4) return rows;
    var I=sr.branchCurrents[comp.id], V=sr.componentVoltages[comp.id];
    var isAC=!!(sr.acPhasor);
    if(comp.type===TYPE.SWITCH){
      var closedSw=App.Netlist.switchClosed(comp, sr.switchState==='closed');
      push('상태', _makeBadge(closedSw?'닫힘':'열림', ''));
      push('전류', _fmtCurrent(I));
      push('양단 전압', _fmtVoltage(V));
      return rows;
    }
    var out=(sr.dc&&sr.dc.out)?sr.dc.out[comp.id]:null;
    /* 전구: 전류·전압·전력·밝기 (밝기 = P/정격) */
    if(comp.type===TYPE.BULB&&out&&!isAC){
      push('전류', _fmtCurrent(I));
      push('전압강하', _fmtVoltage(V));
      push('소비전력', _fmtPower(Math.abs(out.P||0)));
      var br=Math.max(0,out.brightness||0);
      push('밝기', _makeBadge(br<0.10?'꺼짐 ('+Math.round(br*100)+' %)':(Math.round(Math.min(br,1.5)*100)+' %'+(br>1.2?' (과부하)':'')),''));
      return rows;
    }
    /* 다이오드: 순방향/역방향 상태 */
    if(comp.type===TYPE.DIODE&&out){
      push('전류', _fmtCurrent(I));
      push('양단 전압 (애노드−캐소드)', _fmtVoltage(out.v));
      push('상태', _makeBadge(out.region==='forward'?'순방향 도통':'역방향 차단',''));
      return rows;
    }
    /* BJT: 단자 전류·접합 전압·동작 영역 */
    if((comp.type===TYPE.NPN||comp.type===TYPE.PNP)&&out){
      var REG={cutoff:'차단 (OFF)',active:'활성 (증폭)',saturation:'포화 (ON)'};
      push('동작 영역', _makeBadge(REG[out.region]||out.region,''));
      push('I_B (베이스)', _fmtCurrent(out.iB));
      push('I_C (컬렉터)', _fmtCurrent(out.iC));
      push('I_E (이미터)', _fmtCurrent(out.iE));
      push('V_BE', _fmtVoltage(out.vBE));
      push('V_CE', _fmtVoltage(out.vCE));
      if(Math.abs(out.iB)>1e-12) push('I_C / I_B', (out.iC/out.iB).toFixed(1)+(out.region==='active'?' ≈ β':''));
      return rows;
    }
      if(isAC){
        /* ── AC(혼합 포함): 피크 · 실효값 · 임피던스 · 평균전력 ──
         *   i(t) = I_dc + Re[I·e^{jωt}] 이므로
         *     피크   = |I_dc| + |I|            (최대 순시값 — 솔버 표시값)
         *     실효값 = √(I_dc² + |I|²/2)       (혼합이면 peak/√2 가 아니다)
         *   평균전력은 역률을 포함해야 한다:
         *     저항   P = I_rms²·R
         *     전원   P = V_dc·I_dc + Re(V·I*)/2   (피상전력 V_rms·I_rms 와 다름) */
        var ph=sr.acPhasor, omega=ph.omega;
        var Iph=ph.compI[comp.id]||{re:0,im:0}, Vph=ph.compV[comp.id]||{re:0,im:0};
        var Idc=(ph.dcCompI&&ph.dcCompI[comp.id])||0, Vdc=(ph.dcCompV&&ph.dcCompV[comp.id])||0;
        var Iac=Math.hypot(Iph.re,Iph.im), Vac=Math.hypot(Vph.re,Vph.im);
        var Ipk=I!=null?Math.abs(I):null;
        var Vpk=V!=null?Math.abs(V):null;
        var Irms=I!=null?Math.sqrt(Idc*Idc+Iac*Iac/2):null;
        var Vrms=V!=null?Math.sqrt(Vdc*Vdc+Vac*Vac/2):null;
        /* 시간 영역 파형이 있으면 통계는 파형에서 (정류처럼 페이저가 무의미한 경우 포함) */
        var ws=App.Post.waveStats?App.Post.waveStats(sr, comp.id):null;
        if(ws){ Ipk=ws.i.peak; Vpk=ws.v.peak; Irms=ws.i.rms; Vrms=ws.v.rms; }
        var hasNL=App.State.components.some(function(c2){return NONLINEAR_TYPES[c2.type];});
        if(ws&&hasNL){ push('전류(평균)', _fmtCurrent(ws.i.avg)); push('전압(평균)', _fmtVoltage(ws.v.avg)); }
        push('전류(peak)',_fmtCurrent(Ipk));
        push('전류(RMS)', _fmtCurrent(Irms));
        push('전압(peak)',_fmtVoltage(Vpk));
        push('전압(RMS)', _fmtVoltage(Vrms));
        /* 임피던스 */
        var Z=null, Zlabel='임피던스';
        if(comp.type===TYPE.RESISTOR){
          Z=comp.value||0; Zlabel='R';
        } else if(comp.type===TYPE.CAPACITOR){
          var wC2=omega*(comp.value||0);
          Z=wC2>1e-15?1/wC2:Infinity; Zlabel='|Z_C|=1/ωC';
        } else if(comp.type===TYPE.INDUCTOR){
          Z=omega*(comp.value||0); Zlabel='|Z_L|=ωL';
        }
        if(Z!=null&&isFinite(Z))
          push(Zlabel, Z>=1000?(Z/1000).toFixed(3)+' kΩ':Z.toFixed(3)+' Ω');
        if(comp.type===TYPE.RESISTOR&&Irms!=null)
          push('소비전력(평균)',_fmtPower(Irms*Irms*(comp.value||0)));
        if(comp.type===TYPE.AC_SOURCE||comp.type===TYPE.DC_SOURCE){
          /* 전원 평균전력 = DC 항 + AC 항(역률 포함). AC 전원의 DC 성분 전압과
           * DC 전원의 AC 성분 전압은 0 이므로 각자 한 항만 남는다. */
          var Pavg=ws?Math.abs(ws.pAvg):Math.abs(Vdc*Idc+(Vph.re*Iph.re+Vph.im*Iph.im)/2);
          push('공급전력(평균)',_fmtPower(Pavg));
        }
      } else {
        /* ── DC ── */
        push('전류',_fmtCurrent(I));
        push('전압강하',_fmtVoltage(V));
        if(comp.type===TYPE.RESISTOR&&I!=null&&V!=null)
          push('소비전력',_fmtPower(Math.abs(V*I)));
        if((comp.type===TYPE.DC_SOURCE||comp.type===TYPE.AC_SOURCE)&&V!=null&&I!=null)
          push('공급전력',_fmtPower(Math.abs(V*I)));

        /* ── 커패시터: 충전량 Q = C·V ── */
        if(comp.type===TYPE.CAPACITOR){
          var Vcap=V!=null?Math.abs(V):0;
          var Ccap=comp.value||0;
          var Q=Ccap*Vcap;  /* 쿨롱 */
          var Qstr=_fmtSI(Q,'C');
          push('충전량 Q=CV', Qstr);
          push('+극판 전하', '+'+Qstr);
          push('−극판 전하', '−'+Qstr);
          push('상태',_makeBadge('DC 개방 (정상상태)','#1a4030'));

          /* 병렬 연결된 다른 커패시터 합산 */
          var nn=sr.componentNodes?sr.componentNodes[comp.id]:null;
          if(nn){
            var parallelComps=App.State.components.filter(function(c2){
              if(c2.id===comp.id||c2.type!==TYPE.CAPACITOR) return false;
              var nn2=sr.componentNodes[c2.id];
              if(!nn2) return false;
              return (nn2[0]===nn[0]&&nn2[1]===nn[1])||(nn2[0]===nn[1]&&nn2[1]===nn[0]);
            });
            if(parallelComps.length>0){
              var Qtotal=Q;
              parallelComps.forEach(function(c2){
                var V2=sr.componentVoltages[c2.id]||0;
                Qtotal+=(c2.value||0)*Math.abs(V2);
              });
              push('병렬 총 충전량', _fmtSI(Qtotal,'C'));
              /* 전하 보존 검증: +극판 합 = -극판 합 (크기 동일) → 표시 */
              push('전하 보존',_makeBadge('ΣQ+ = ΣQ−  ✓','#1a3a4a'));
            }
          }
        }

        /* ── 인덕터: 자기장 Φ = L·I, 자기에너지 E = ½LI² ── */
        if(comp.type===TYPE.INDUCTOR){
          var Lval=comp.value||0;
          var Iind=I!=null?Math.abs(I):0;
          var phi=Lval*Iind;             /* 자속 Φ = L·I (Wb=V·s) */
          var Emag=0.5*Lval*Iind*Iind;   /* 자기에너지 (J) */
          push('자속 Φ=LI', _fmtSI(phi,'Wb'));
          push('자기에너지 ½LI²', _fmtSI(Emag,'J'));
          push('상태',_makeBadge('DC 단락 (정상상태)','#1a2a50'));
        }
      }
    return rows;
  }
  /* 옆 칸(상하좌우)의 결합되지 않은 인덕터 — 상호유도 짝 후보 */
  function _adjacentInductor(comp){
    var comps=App.State.components, dirs=[[1,0],[-1,0],[0,1],[0,-1]];
    for(var i=0;i<dirs.length;i++){
      for(var j=0;j<comps.length;j++){
        var c=comps[j];
        if(c.id===comp.id||c.type!==TYPE.INDUCTOR) continue;
        if(c.gridX!==comp.gridX+dirs[i][0]||c.gridY!==comp.gridY+dirs[i][1]) continue;
        if(App.Netlist.coupledPartner(c, comps)) continue;
        return c;
      }
    }
    return null;
  }
  /* 두 값(열림 · 닫으면) 행 */
  function _row2(key,a,b){
    var row=document.createElement('div');row.className='pp-row';
    var k=document.createElement('span');k.className='pp-key';k.textContent=key;
    var v=document.createElement('span');v.className='pp-val';v.style.cssText='display:flex;gap:8px';
    [a,b].forEach(function(val){
      var sp=document.createElement('span');sp.style.cssText='flex:1;text-align:right';
      if(val instanceof Node) sp.appendChild(val); else sp.textContent=val;
      v.appendChild(sp);
    });
    row.appendChild(k);row.appendChild(v);return row;
  }
  function _errDiv(msg){
    var d=document.createElement('div');
    d.style.cssText='background:var(--danger-bg);border:1px solid var(--danger-border);'+
      'border-radius:5px;padding:6px 8px;margin-top:2px;color:var(--danger-text);font-size:10px;line-height:1.5';
    d.textContent='⚠ '+msg; return d;
  }
  function _warnDiv(msg){
    var d=document.createElement('div');
    d.style.cssText='background:#fff7e6;border:1px solid #f0d9a8;border-radius:5px;padding:5px 8px;'+
      'margin-top:4px;color:#8a5a00;font-size:10px;line-height:1.4';
    d.textContent='ⓘ '+msg; return d;
  }

  /* 키-값 행 생성.
   *   val이 문자열/숫자면 textContent, DOM 노드(배지 등)면 appendChild.
   *   (과거 _makeBadge 결과를 textContent로 넣어 [object HTMLSpanElement]
   *    표시되던 버그 수정) */
  function _row(key,val){
    var row=document.createElement('div');row.className='pp-row';
    var k=document.createElement('span');k.className='pp-key';k.textContent=key;
    var v=document.createElement('span');v.className='pp-val';
    if(val instanceof Node) v.appendChild(val);
    else v.textContent=val;
    row.appendChild(k);row.appendChild(v);return row;
  }
  /* 상태 배지 — 지면 톤에 맞춰 연회색 배경 + 검정 글자.
   *   bg 인자는 과거 다크 테마 색을 받던 자리로, 이제는 무시한다. */
  function _makeBadge(text,bg){
    var s=document.createElement('span');
    s.style.cssText='background:#eceef1;border:1px solid var(--border-dim);border-radius:3px;'+
                    'padding:1px 5px;font-size:9px;color:var(--text-base)';
    s.textContent=text;return s;
  }
  function _btn(text,cls,onClick){
    var b=document.createElement('button');b.className='pp-btn '+cls;b.textContent=text;
    b.addEventListener('click',onClick);b.addEventListener('pointerdown',function(e){e.stopPropagation();});
    return b;
  }

  return{init,show,hide,refresh};
})();

}());
