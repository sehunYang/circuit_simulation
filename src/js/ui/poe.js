(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.POE — 예측 · 관찰 · 설명 (Predict–Observe–Explain) 모드
 *
 *   오개념은 보여 주는 것만으로 풀리지 않는다. 학생이 먼저 예측하고 틀리는
 *   경험이 있어야 한다. 예제마다:
 *     1) 회로를 불러온다 (편집 모드, 값 숨김)
 *     2) 질문 + 선택지 — 학생이 예측 (오답 선택지는 알려진 오개념 모델)
 *     3) 관찰 — 실행 모드로 들어가 배지·파형·밝기를 본다 (스위치 조작 안내)
 *     4) 설명 — 정답과 물리 설명, 학생이 고른 오개념 태그
 *   논리 회로 예제는 진리표 패널이 붙는다 (예측 칸을 채우고 회로로 확인).
 *   결과는 세션 안에 쌓이고 CSV 로 내보낼 수 있다 (진단 세트).
 * ════════════════════════════════════════════════════════════════════ */
App.POE=(function(){
  var _panel,_body,_open=false,_cur=null,_step=0,_picked=null,_results=[];

  /* ── 회로 정의 도우미: [key,type,gx,gy,rot,value,value2,extra] ── */
  function C(key,type,gx,gy,rot,value,value2,extra){ var o={key:key,type:type,gx:gx,gy:gy,rot:rot||0,value:value||0,value2:(value2==null?null:value2)}; if(extra) Object.keys(extra).forEach(function(k){o[k]=extra[k];}); return o; }
  function W(a,ap,b,bp,dir){ return [a,ap,b,bp,dir||'H-first']; }
  var VCC=function(key,gx,gy){ return C(key,'LABEL',gx,gy,0,0,null,{label:'VCC'}); };
  var GND=function(key,gx,gy){ return C(key,'GROUND',gx,gy,0,0); };
  function power(V){ return [C('dc','DC_SOURCE',40,50,90,V), VCC('lv',40,48), GND('lg',40,52)]; }
  var powerW=[W('lv','B','dc','L'), W('dc','R','lg','T')];

  var EXAMPLES=[
    { id:'brightness', title:'전구 밝기 순위', level:'기초',
      misconception:'전류 소모 · 밝기 = 전류',
      circuit:{
        comps:[C('dc','DC_SOURCE',47,50,90,12), C('A','BULB',49,48,0,100,1,{label:'A'}),
               C('ja','JUNCTION_3',51,48), C('jb','JUNCTION_3',54,48),
               C('B','BULB',51,49,90,100,1,{label:'B'}), C('C','BULB',54,49,90,100,1,{label:'C'}),
               C('jc','JUNCTION_3',51,50,180), C('jd','JUNCTION_3',54,50,180)],
        wires:[W('dc','L','A','L','V-first'), W('A','R','ja','L'), W('ja','R','jb','L'),
               W('ja','B','B','L'), W('jb','B','C','L'), W('B','R','jc','B'), W('C','R','jd','B'),
               W('jc','L','jd','R'), W('dc','R','jc','R','V-first')],
        center:[51,49.5] },
      question:'같은 전구 세 개. A 는 전지에 직렬, B 와 C 는 서로 병렬입니다. 밝기 순위는?',
      options:[
        {label:'A > B = C', correct:true},
        {label:'A = B = C', tag:'전류가 갈라져도 밝기는 같다는 생각 (밝기 = 전압만 본 오개념)'},
        {label:'A < B = C', tag:'전류 소모 모델 — 뒤에 있는 전구가 덜 받는다는 생각의 반대 적용'},
        {label:'A > B > C', tag:'순차 모델 — 전류가 먼저 도착하는 전구가 더 밝다는 생각'}],
      observe:'실행 모드에서 광량과 A 배지를 보세요. 각 전구를 클릭하면 소비전력이 나옵니다.',
      explain:'A 에는 전체 전류(80 mA)가, B·C 에는 그 절반(40 mA)씩 흐릅니다. 밝기는 전류가 아니라 전력 P = I²R 에 비례하므로 A 는 B·C 의 4배 밝습니다(0.64 W 대 0.16 W). 전류는 소모되지 않습니다 — B·C 를 지난 전류가 다시 합쳐져 80 mA 로 돌아옵니다.' },

    { id:'parallel', title:'병렬로 전구 추가하기', level:'기초',
      misconception:'정전류 전지 · 병렬 = 저항 증가',
      circuit:{
        comps:[C('dc','DC_SOURCE',47,50,90,12), C('ja','JUNCTION_3',50,48), C('A','BULB',50,49,90,100,1,{label:'A'}),
               C('jc','JUNCTION_3',50,50,180), C('sw','SWITCH',53,48,90,0,null,{on:false}), C('B','BULB',53,49,90,100,1,{label:'B'})],
        wires:[W('dc','L','ja','L','V-first'), W('ja','B','A','L'), W('A','R','jc','B'),
               W('ja','R','sw','L'), W('sw','R','B','L'), W('B','R','jc','L','V-first'), W('jc','R','dc','R','V-first')],
        center:[51,49.5] },
      question:'전구 A 가 켜져 있습니다. 스위치를 닫아 전구 B 를 A 와 병렬로 추가하면?',
      options:[
        {label:'A 밝기 그대로, 전지 전류는 2배', correct:true},
        {label:'A 가 어두워지고, 전지 전류는 그대로', tag:'정전류 전지 모델 — 전지가 늘 같은 전류를 낸다는 생각'},
        {label:'A 가 어두워지고, 전지 전류는 절반', tag:'저항을 더 달면 전체 저항이 커진다는 생각'},
        {label:'A 가 더 밝아진다', tag:'병렬 가지가 서로 돕는다는 생각'}],
      observe:'실행 모드에서 A 배지를 켜고 스위치를 클릭해 B 를 추가하세요. 전지 쪽 도선 배지를 보세요.',
      explain:'병렬 가지는 각각 전지 전압 12 V 를 그대로 받습니다. A 의 전류·밝기는 변하지 않고, 전지는 A·B 두 가지에 전류를 대야 하므로 전지 전류가 두 배가 됩니다. 병렬로 저항을 더 달면 전체 저항은 오히려 줄어듭니다(100 Ω → 50 Ω).' },

    { id:'openswitch', title:'열린 스위치 양단의 전압', level:'기초',
      misconception:'"열리면 전압도 0"',
      circuit:{
        comps:[C('dc','DC_SOURCE',48,50,90,12), C('sw','SWITCH',50,48,0,0,null,{on:false}), C('R','RESISTOR',52,48,0,100)],
        wires:[W('dc','L','sw','L','V-first'), W('sw','R','R','L'), W('R','R','dc','R','V-first')],
        center:[51,49.5] },
      question:'스위치가 열려 있어 전류가 0 입니다. 이때 스위치 양단의 전압은?',
      options:[
        {label:'12 V (전지 전압 전부)', correct:true},
        {label:'0 V — 전류가 없으니 전압도 없다', tag:'전압을 전류의 성질로 보는 오개념'},
        {label:'6 V — 저항과 반씩 나눈다', tag:'전압은 소자 수로 균등 분배된다는 생각'}],
      observe:'실행 모드에서 스위치를 클릭해 속성 패널의 "양단 전압"을 보고, 다시 클릭해 닫아 보세요.',
      explain:'전류가 0 이면 저항 양단 전압은 IR = 0 입니다. 전지의 12 V 는 어디엔가 걸려야 하므로 전부 열린 스위치 양단에 걸립니다. 전압은 두 점 사이의 전위차이지 "흐르는 것"이 아닙니다. 스위치를 닫으면 스위치 전압은 0, 저항 전압이 12 V 가 됩니다.' },

    { id:'rectifier', title:'다이오드의 정류 작용', level:'심화',
      misconception:'"다이오드 = 저항을 줄이는 소자"',
      circuit:{
        comps:[C('ac','AC_SOURCE',47,50,90,10,60), C('D','DIODE',49,48,0,0), C('R','RESISTOR',52,50,90,1000)],
        wires:[W('ac','L','D','L','V-first'), W('D','R','R','L'), W('R','R','ac','R')],
        center:[50,49.5] },
      question:'교류 전원(10 V, 60 Hz)에 다이오드와 저항을 직렬로 이었습니다. 저항 양단 전압 파형은?',
      options:[
        {label:'양의 반주기만 남고 음의 반주기는 0', correct:true},
        {label:'사인파 그대로 (크기만 조금 작아짐)', tag:'다이오드를 그냥 저항으로 보는 오개념'},
        {label:'일정한 직류 전압', tag:'정류 = 직류 변환이라는 생각 (평활 없이는 맥류)'},
        {label:'사인파가 위아래로 뒤집힘', tag:'다이오드가 극성을 바꾼다는 생각'}],
      observe:'실행 모드의 오실로스코프에서 전원 파형(파랑)과 저항 파형(청록)을 비교하세요.',
      explain:'p-n 접합 다이오드는 순방향(애노드가 캐소드보다 약 0.6 V 이상 높을 때)에만 전류를 흘립니다. 전원이 음(−)인 반주기에는 역방향이라 전류가 0, 저항 전압도 0 입니다. 남은 것은 양의 반주기뿐이고 봉우리는 0.6 V 쯤 깎입니다 — 반파 정류입니다.' },

    { id:'transistor', title:'트랜지스터의 스위칭 작용', level:'심화',
      misconception:'"전구 밝기 = 베이스 전류"',
      circuit:{
        comps:power(12).concat([VCC('lb',47,44), C('L','BULB',47,45,90,100,1,{label:'전구'}), C('Q','NPN',47,48,0,100), GND('ge',47,50),
               VCC('li',44,44), C('sw','SWITCH',44,45,90,0,null,{on:false}), C('Rb','RESISTOR',44,46,90,4700)]),
        wires:powerW.concat([W('lb','B','L','L'), W('L','R','Q','T'), W('Q','B','ge','T'),
               W('li','B','sw','L'), W('sw','R','Rb','L'), W('Rb','R','Q','L','V-first')]),
        center:[45.5,48], rail:true },
      question:'베이스에는 4.7 kΩ 을 거쳐 2 mA 정도만 흐릅니다. 스위치를 닫으면 컬렉터의 전구는?',
      options:[
        {label:'환하게 켜진다 — 작은 베이스 전류가 100배 큰 컬렉터 전류를 열어 준다', correct:true},
        {label:'베이스 전류 2 mA 만큼만 아주 희미하게 켜진다', tag:'전구를 지나는 전류가 베이스 전류라는 생각'},
        {label:'변화 없다 — 전구 회로와 스위치 회로는 별개', tag:'세 단자 소자의 제어 작용을 모르는 상태'}],
      observe:'실행 모드에서 베이스 스위치를 클릭하세요. 트랜지스터를 클릭하면 I_B, I_C 와 동작 영역이 나옵니다.',
      explain:'npn 트랜지스터는 베이스 전류 I_B 의 β(≈100)배까지 컬렉터 전류를 허용합니다. 2.4 mA 의 베이스 전류로 전구가 요구하는 120 mA 를 넉넉히 열 수 있어 트랜지스터는 포화(ON)되고, 컬렉터-이미터 전압은 0.1 V 정도로 떨어집니다. 작은 전류로 큰 전류를 켜고 끄는 것 — 스위칭 작용입니다.' },

    { id:'not', title:'논리 회로 — NOT 게이트', level:'심화', truth:{inputs:['swA'], output:'out', fn:function(a){return a?0:1;}},
      misconception:'게이트를 블랙박스로만 아는 상태',
      circuit:{
        comps:power(5).concat([VCC('la',44,44), C('swA','SWITCH',44,45,90,0,null,{on:false,label:'A'}), C('RbA','RESISTOR',44,46,90,10000),
               VCC('lc',47,44), C('Rc','RESISTOR',47,45,90,1000), C('Q','NPN',47,48,0,100), GND('ge',47,50),
               C('out','BULB',50,47,90,100000,0.0002,{label:'출력'}), GND('go',50,49)]),
        wires:powerW.concat([W('la','B','swA','L'), W('swA','R','RbA','L'), W('RbA','R','Q','L','V-first'),
               W('lc','B','Rc','L'), W('Rc','R','Q','T'), W('Q','B','ge','T'),
               W('Q','T','out','L'), W('out','R','go','T')]),
        center:[46,47.5], rail:true },
      question:'입력 A(스위치 닫힘 = 1)에 따라 출력 전구는? 진리표의 예측 칸을 채우세요.',
      options:[{label:'진리표를 채웠습니다', correct:true}],
      observe:'실행 모드에서 스위치 A 를 클릭하며 출력 전구를 보세요. 아래 진리표의 관찰 칸은 회로가 두 경우를 풀어 채운 값입니다.',
      explain:'입력이 1 이면 베이스 전류가 흘러 트랜지스터가 켜지고(포화) 컬렉터 전압이 0 V 근처로 떨어져 전구가 꺼집니다. 입력이 0 이면 트랜지스터가 꺼져 풀업 저항을 통해 컬렉터가 5 V 로 올라가 전구가 켜집니다 — 입력을 뒤집는 NOT.' },

    { id:'and', title:'논리 회로 — AND 게이트 (다이오드)', level:'심화', truth:{inputs:['swA','swB'], output:'out', fn:function(a,b){return (a&&b)?1:0;}},
      misconception:'게이트를 블랙박스로만 아는 상태',
      circuit:{
        comps:power(5).concat([VCC('lp',48,44), C('Rp','RESISTOR',48,45,90,10000), C('J','JUNCTION_4',48,47),
               C('DA','DIODE',46,47,180,0), C('DB','DIODE',50,47,0,0),
               VCC('la',44,44), C('swA','SWITCH',44,45,90,0,null,{on:false,label:'A'}), C('JA','JUNCTION_4',44,46), C('RdA','RESISTOR',44,47,90,1000), GND('ga',44,49),
               VCC('lb',53,44), C('swB','SWITCH',53,45,90,0,null,{on:false,label:'B'}), C('JB','JUNCTION_4',53,46), C('RdB','RESISTOR',53,47,90,1000), GND('gb',53,49),
               C('out','BULB',48,48,90,100000,0.0002,{label:'출력'}), GND('go',48,50)]),
        wires:powerW.concat([W('lp','B','Rp','L'), W('Rp','R','J','T'), W('J','L','DA','L'), W('J','R','DB','L'),
               W('la','B','swA','L'), W('swA','R','JA','T'), W('JA','B','RdA','L'), W('RdA','R','ga','T'), W('JA','R','DA','R'),
               W('lb','B','swB','L'), W('swB','R','JB','T'), W('JB','B','RdB','L'), W('RdB','R','gb','T'), W('JB','L','DB','R'),
               W('J','B','out','L'), W('out','R','go','T')]),
        center:[47,47.5], rail:true },
      question:'두 입력 A, B (스위치 닫힘 = 1). 출력 전구는 언제 켜질까요? 진리표를 예측하세요.',
      options:[{label:'진리표를 채웠습니다', correct:true}],
      observe:'스위치 A·B 를 클릭해 네 조합을 만들어 보세요. 다이오드를 클릭하면 순방향/역방향 상태가 보입니다. 아래 관찰 칸은 회로가 네 조합을 풀어 채운 값입니다.',
      explain:'출력은 풀업 저항으로 5 V 에 매달려 있습니다. 어느 입력이라도 0(스위치 열림 → 풀다운 저항이 0 V 로)이면 그 다이오드가 순방향이 되어 출력을 0.7 V 로 끌어내립니다. 두 입력이 모두 1 이어야 두 다이오드가 다 역방향이 되어 출력이 5 V 로 남습니다 — AND.' },

    { id:'or', title:'논리 회로 — OR 게이트 (다이오드)', level:'심화', truth:{inputs:['swA','swB'], output:'out', fn:function(a,b){return (a||b)?1:0;}},
      misconception:'게이트를 블랙박스로만 아는 상태',
      circuit:{
        comps:power(5).concat([VCC('la',44,44), C('swA','SWITCH',44,45,90,0,null,{on:false,label:'A'}), C('DA','DIODE',44,46,90,0),
               VCC('lb',52,44), C('swB','SWITCH',52,45,90,0,null,{on:false,label:'B'}), C('DB','DIODE',52,46,90,0),
               C('J','JUNCTION_4',48,47), C('Rd','RESISTOR',48,48,90,1000), GND('gr',48,50),
               C('out','BULB',50,48,90,100000,0.0002,{label:'출력'}), GND('go',50,50)]),
        wires:powerW.concat([W('la','B','swA','L'), W('swA','R','DA','L'), W('DA','R','J','L'),
               W('lb','B','swB','L'), W('swB','R','DB','L'), W('DB','R','J','R'),
               W('J','B','Rd','L'), W('Rd','R','gr','T'), W('J','B','out','L'), W('out','R','go','T')]),
        center:[47,47.5], rail:true },
      question:'두 입력 A, B (스위치 닫힘 = 1). 출력 전구는 언제 켜질까요? 진리표를 예측하세요.',
      options:[{label:'진리표를 채웠습니다', correct:true}],
      observe:'스위치 A·B 를 클릭해 네 조합을 만들어 보세요. 아래 관찰 칸은 회로가 네 조합을 풀어 채운 값입니다.',
      explain:'어느 입력이든 1 이면 그 다이오드가 순방향이 되어 출력 노드를 5 V − 0.7 V 로 끌어올립니다. 두 입력이 모두 0 이면 아무 다이오드도 도통하지 않아 풀다운 저항이 출력을 0 V 로 둡니다 — OR.' },
  ];

  /* ── 회로 로드 ── */
  function loadCircuit(ex){
    var S=App.State, ids={};
    var old=S.components.map(function(c){return c.id;});
    old.forEach(function(id){ if(S.getComponent(id)) S.removeComponent(id); });
    ex.circuit.comps.forEach(function(c){
      var comp={id:S.genId(),type:TYPE[c.type],gridX:c.gx,gridY:c.gy,rotation:c.rot,value:c.value,value2:c.value2,label:c.label||''};
      if(c.on===false) comp.on=false;
      if(comp.type===TYPE.DC_SOURCE||comp.type===TYPE.AC_SOURCE) comp.rint=0;
      ids[c.key]=comp.id; S.addComponent(comp);
    });
    ex.circuit.wires.forEach(function(w){
      S.addWire({id:S.genId(),fromId:ids[w[0]],fromPort:w[1],toId:ids[w[2]],toPort:w[3],direction:w[4]});
    });
    ex._ids=ids;
    if(ex.circuit.rail&&!S.railNotation){ var b=document.getElementById('vis-rail'); if(b) b.click(); }
    S.selectedId=null;
    /* 화면 맞춤 */
    var el=document.getElementById('canvas-container'), vt=S.viewTransform, cx=ex.circuit.center[0], cy=ex.circuit.center[1];
    vt.scale=1.4; vt.offsetX=el.clientWidth/2-cx*CELL_SIZE*vt.scale; vt.offsetY=el.clientHeight/2-cy*CELL_SIZE*vt.scale;
    App.Events.emit('viewport:changed');
    /* 관찰 전에는 값 숨김·배지 끔 */
    S.showBadges=false; S.showLabels=true;
    ['vis-badges','vis-labels'].forEach(function(id){ var b=document.getElementById(id); if(b) b.classList.toggle('active', id==='vis-labels'); });
    if(S.mode!=='edit'){ var eb=document.querySelector('.mode-btn[data-mode="edit"]'); if(eb) eb.click(); }
  }

  /* ── 진리표: 회로를 입력 조합마다 풀어 출력 전구 밝기로 0/1 판정 ── */
  function truthObserve(ex){
    var S=App.State, t=ex.truth, rows=[];
    var n=t.inputs.length, combos=n===1?[[0],[1]]:[[0,0],[0,1],[1,0],[1,1]];
    combos.forEach(function(inp){
      var comps=JSON.parse(JSON.stringify(S.components));
      t.inputs.forEach(function(k,i){ var c=comps.find(function(x){return x.id===ex._ids[k];}); if(c) c.on=!!inp[i]; });
      var sr=App.Solver.solve(comps, S.wires, {closed:true, noWave:true});
      var out=sr.valid&&sr.dc&&sr.dc.out&&sr.dc.out[ex._ids[t.output]];
      var lit=out?(out.brightness>0.5?1:0):null;
      rows.push({inp:inp, out:lit, expect:t.fn.apply(null,inp)});
    });
    return rows;
  }

  /* ── UI ── */
  function init(){
    _panel=document.getElementById('poe-panel'); _body=document.getElementById('poe-body');
    if(!_panel) return;
    var x=document.getElementById('poe-close-btn'); if(x) x.addEventListener('click',close);
    var b=document.getElementById('poe-btn'); if(b) b.addEventListener('click',toggle);
  }
  function toggle(){ _open?close():open(); }
  function open(){ _panel.classList.add('visible'); _open=true; _cur=null; renderList(); }
  function close(){ _panel.classList.remove('visible'); _open=false; }

  function h(tag,cls,text){ var e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; }
  function btn(text,cls,fn){ var b=h('button','poe-btn '+(cls||''),text); b.addEventListener('click',function(e){e.stopPropagation();fn();}); b.addEventListener('pointerdown',function(e){e.stopPropagation();}); return b; }

  function renderList(){
    _body.innerHTML='';
    _body.appendChild(h('div','poe-intro','예측 → 관찰 → 설명. 먼저 답을 고른 뒤에 회로를 돌립니다.'));
    EXAMPLES.forEach(function(ex){
      var row=h('div','poe-item');
      var done=_results.filter(function(r){return r.id===ex.id;}).slice(-1)[0];
      row.appendChild(h('span','poe-lv',ex.level));
      row.appendChild(h('span','poe-title',ex.title));
      if(done) row.appendChild(h('span','poe-mark '+(done.correct?'ok':'no'), done.correct?'○':'✕'));
      row.addEventListener('click',function(){ start(ex); });
      _body.appendChild(row);
    });
    var foot=h('div','poe-foot');
    foot.appendChild(btn('결과 CSV 내보내기','', exportCSV));
    foot.appendChild(h('span','poe-dim', _results.length?(_results.length+'건 기록'):''));
    _body.appendChild(foot);
  }

  function start(ex){
    _cur=ex; _step=0; _picked=null; ex._truthPred=null;
    loadCircuit(ex);
    renderStep();
  }

  function renderStep(){
    var ex=_cur; _body.innerHTML='';
    var head=h('div','poe-head'); head.appendChild(h('span','poe-lv',ex.level)); head.appendChild(h('span','poe-title',ex.title));
    var back=btn('← 목록','poe-small',function(){ _cur=null; renderList(); }); head.appendChild(back);
    _body.appendChild(head);
    var steps=h('div','poe-steps');
    ['예측','관찰','설명'].forEach(function(s,i){ var e=h('span','poe-step'+(i===_step?' on':''),(i+1)+' '+s); steps.appendChild(e); });
    _body.appendChild(steps);

    if(_step===0){
      _body.appendChild(h('div','poe-q',ex.question));
      if(ex.truth) _body.appendChild(truthTable(ex,'predict'));
      var opts=h('div','poe-opts');
      ex.options.forEach(function(o,i){
        var b=btn(o.label,'poe-opt'+(_picked===i?' picked':''),function(){ _picked=i; renderStep(); });
        opts.appendChild(b);
      });
      _body.appendChild(opts);
      var go=btn('관찰하기 →','poe-primary',function(){
        if(_picked==null&&!ex.truth){ showErrorToast('먼저 예측을 고르세요',1200); return; }
        if(ex.truth&&!truthPredComplete(ex)){ showErrorToast('진리표의 예측 칸(?)을 모두 클릭해 0/1 로 채우세요',1800); return; }
        if(_picked==null) _picked=0;
        _step=1; observe(ex); renderStep();
      });
      _body.appendChild(go);
    } else if(_step===1){
      _body.appendChild(h('div','poe-q',ex.observe));
      if(ex.truth){
        _body.appendChild(truthTable(ex,'observe'));
      }
      var ex2=btn('설명 보기 →','poe-primary',function(){ _step=2; record(ex); renderStep(); });
      _body.appendChild(ex2);
    } else {
      var picked=ex.options[_picked]||ex.options[0];
      var ok=isCorrect(ex);
      var verdict=h('div','poe-verdict '+(ok?'ok':'no'), ok?'예측이 맞았습니다.':'예측과 다릅니다.');
      _body.appendChild(verdict);
      if(!ok&&picked&&picked.tag) _body.appendChild(h('div','poe-tag','고른 답에 담긴 생각: '+picked.tag));
      if(ex.truth&&ex._truthObs){
        var wrong=ex._truthObs.filter(function(r,i){ return ex._truthPred[i]!==r.out; }).length;
        if(wrong>0) _body.appendChild(h('div','poe-tag','진리표 '+wrong+'행이 예측과 다릅니다.'));
        _body.appendChild(truthTable(ex,'result'));
      }
      _body.appendChild(h('div','poe-explain',ex.explain));
      _body.appendChild(h('div','poe-dim','다루는 오개념: '+ex.misconception));
      var nxt=btn('목록으로','poe-primary',function(){ _cur=null; renderList(); });
      _body.appendChild(nxt);
    }
  }

  function observe(ex){
    var S=App.State;
    S.showBadges=true; var bb=document.getElementById('vis-badges'); if(bb) bb.classList.add('active');
    var rb=document.querySelector('.mode-btn[data-mode="run"]'); if(rb&&S.mode!=='run') rb.click();
    if(ex.truth) ex._truthObs=truthObserve(ex);
  }

  function isCorrect(ex){
    if(ex.truth){
      if(!truthPredComplete(ex)||!ex._truthObs) return false;
      return ex._truthObs.every(function(r,i){ return ex._truthPred[i]===r.out; });
    }
    var o=ex.options[_picked]; return !!(o&&o.correct);
  }

  function record(ex){
    _results.push({id:ex.id, title:ex.title, pick:(ex.options[_picked]||{}).label, correct:isCorrect(ex),
                   tag:(!isCorrect(ex)&&ex.options[_picked]&&ex.options[_picked].tag)||'', at:new Date().toISOString()});
  }

  /* 진리표: mode = predict(예측 칸 클릭) | observe(관찰값 표시) | result(비교) */
  function truthTable(ex, mode){
    var t=ex.truth, n=t.inputs.length, combos=n===1?[[0],[1]]:[[0,0],[0,1],[1,0],[1,1]];
    if(!ex._truthPred) ex._truthPred=combos.map(function(){return null;});
    var tbl=h('table','poe-truth'), thead=h('tr');
    t.inputs.forEach(function(k){ thead.appendChild(h('th','', (App.State.getComponent(ex._ids[k])||{}).label||k)); });
    thead.appendChild(h('th','','예측'));
    if(mode!=='predict') thead.appendChild(h('th','','관찰'));
    tbl.appendChild(thead);
    combos.forEach(function(inp,i){
      var tr=h('tr');
      inp.forEach(function(v){ tr.appendChild(h('td','',String(v))); });
      var pv=ex._truthPred[i];
      var tdp=h('td','poe-cell'+(mode==='predict'?' click':''), pv==null?'?':String(pv));
      if(mode==='predict'){
        tdp.title='클릭해서 0 / 1 바꾸기';
        tdp.addEventListener('click',function(e){ e.stopPropagation(); ex._truthPred[i]=(pv==null?1:(pv===1?0:1)); renderStep(); });
      }
      tr.appendChild(tdp);
      if(mode!=='predict'){
        var ov=ex._truthObs?ex._truthObs[i].out:null;
        var tdo=h('td','poe-cell'+(mode==='result'?(ov===pv?' ok':' no'):''), ov==null?'—':String(ov));
        tr.appendChild(tdo);
      }
      tbl.appendChild(tr);
    });
    return tbl;
  }
  function truthPredComplete(ex){ return !!(ex._truthPred&&ex._truthPred.every(function(v){return v!=null;})); }

  function exportCSV(){
    if(!_results.length){ showErrorToast('기록된 결과가 없습니다',1200); return; }
    var lines=['예제,선택,정답여부,오개념태그,시각'];
    _results.forEach(function(r){ lines.push([r.title,r.pick||'',r.correct?'O':'X',r.tag,r.at].map(function(s){return '"'+String(s).replace(/"/g,'""')+'"';}).join(',')); });
    var blob=new Blob(['﻿'+lines.join('\n')],{type:'text/csv;charset=utf-8'});
    var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='poe_results.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  return{init:init, open:open, close:close, toggle:toggle, EXAMPLES:EXAMPLES, loadCircuit:loadCircuit, truthObserve:truthObserve, start:start, results:function(){return _results;}};
})();

}());
