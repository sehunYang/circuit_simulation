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
  /* 레일 라벨: 전위 V 를 주면 그 자체가 접지 기준 전원 (같은 이름 VCC 는 한 노드) */
  var VCC=function(key,gx,gy,V){ return C(key,'LABEL',gx,gy,0,V||0,null,{label:'VCC'}); };
  var GND=function(key,gx,gy){ return C(key,'GROUND',gx,gy,0,0); };
  /* 전지 + 딸린 자동 스위치 (편집 열림 · 실행 닫힘). 전지는 rot 90 (L = 위 = +), 스위치는 바로 위 칸 */
  function battery(V,gx,gy,extraSw){ var sw={autoFor:'dc'}; if(extraSw) Object.keys(extraSw).forEach(function(k){sw[k]=extraSw[k];});
    return [C('dc','DC_SOURCE',gx,gy,90,V), C('sw','SWITCH',gx,gy-1,90,0,null,sw)]; }
  var batteryW=[W('dc','L','sw','R')];
  /* 키를 지정하는 전지 (전지가 둘 이상일 때): 키 k 의 전지 + 키 k+'s' 의 딸린 스위치 */
  function bat(k,V,gx,gy,extra){ var dc=C(k,'DC_SOURCE',gx,gy,90,V); if(extra) Object.keys(extra).forEach(function(q){dc[q]=extra[q];});
    return [dc, C(k+'s','SWITCH',gx,gy-1,90,0,null,{autoFor:k})]; }
  function batW(k){ return W(k,'L',k+'s','R'); }

  /* 분류 탭 — 목록이 길어지지 않게 한 번에 한 분류만 보인다 */
  var CATS=[{id:'dc',label:'직류 기초'},{id:'lc',label:'축전기·인덕터'},{id:'multi',label:'여러 전원·전위'},
            {id:'ac',label:'교류'},{id:'semi',label:'반도체·논리'},{id:'mutual',label:'상호유도'}];
  var _tab='dc';

  var EXAMPLES=[
    { id:'brightness', cat:'dc', title:'전구 밝기 순위', level:'기초',
      misconception:'전류 소모 · 밝기 = 전류',
      circuit:{
        comps:battery(12,46,48).concat([C('A','BULB',48,46,0,100,1,{label:'A'}), C('ja','JUNCTION_3',50,46),
               C('B','BULB',50,47,90,100,1,{label:'B'}), C('C','BULB',53,47,90,100,1,{label:'C'}),
               C('jc','JUNCTION_3',50,49,180)]),   /* 분기점은 전지 행 아래 — 같은 행이면 귀환 도선이 전지를 관통 */
        wires:batteryW.concat([W('sw','L','A','L','V-first'), W('A','R','ja','L'), W('ja','R','C','L','H-first'),
               W('ja','B','B','L'), W('B','R','jc','B'), W('C','R','jc','L','V-first'), W('jc','R','dc','R','H-first')]),
        center:[49.5,48] },
      question:'같은 전구 세 개. A 는 전지에 직렬, B 와 C 는 서로 병렬입니다. 밝기 순위는?',
      options:[
        {label:'A > B = C', correct:true},
        {label:'A = B = C', tag:'전류가 갈라져도 밝기는 같다는 생각 (밝기 = 전압만 본 오개념)'},
        {label:'A < B = C', tag:'전류 소모 모델 — 뒤에 있는 전구가 덜 받는다는 생각의 반대 적용'},
        {label:'A > B > C', tag:'순차 모델 — 전류가 먼저 도착하는 전구가 더 밝다는 생각'}],
      observe:'실행 모드에서 광량과 A 배지를 보세요. 각 전구를 클릭하면 소비전력이 나옵니다.',
      explain:'A 에는 전체 전류(80 mA)가, B·C 에는 그 절반(40 mA)씩 흐릅니다. 밝기는 전류가 아니라 전력 P = I²R 에 비례하므로 A 는 B·C 의 4배 밝습니다(0.64 W 대 0.16 W). 전류는 소모되지 않습니다 — B·C 를 지난 전류가 다시 합쳐져 80 mA 로 돌아옵니다.' },

    { id:'parallel', cat:'dc', title:'병렬로 전구 추가하기', level:'기초',
      misconception:'정전류 전지 · 병렬 = 저항 증가',
      circuit:{
        comps:battery(12,46,49).concat([C('ja','JUNCTION_3',49,46), C('A','BULB',49,47,90,100,1,{label:'A'}),
               C('sw2','SWITCH',52,47,90,0,null,{on:false}), C('B','BULB',52,48,90,100,1,{label:'B'}),
               C('jc','JUNCTION_3',49,50,180)]),   /* 분기점은 전지 행 아래 */
        wires:batteryW.concat([W('sw','L','ja','L','V-first'), W('ja','B','A','L'), W('A','R','jc','B'),
               W('ja','R','sw2','L','H-first'), W('sw2','R','B','L'), W('B','R','jc','L','V-first'), W('jc','R','dc','R','H-first')]),
        center:[49.5,48.5] },
      question:'전구 A 가 켜져 있습니다. 스위치를 닫아 전구 B 를 A 와 병렬로 추가하면?',
      options:[
        {label:'A 밝기 그대로, 전지 전류는 2배', correct:true},
        {label:'A 가 어두워지고, 전지 전류는 그대로', tag:'정전류 전지 모델 — 전지가 늘 같은 전류를 낸다는 생각'},
        {label:'A 가 어두워지고, 전지 전류는 절반', tag:'저항을 더 달면 전체 저항이 커진다는 생각'},
        {label:'A 가 더 밝아진다', tag:'병렬 가지가 서로 돕는다는 생각'}],
      observe:'실행 모드에서 A 배지를 켜고 스위치를 클릭해 B 를 추가하세요. 전지 쪽 도선 배지를 보세요.',
      explain:'병렬 가지는 각각 전지 전압 12 V 를 그대로 받습니다. A 의 전류·밝기는 변하지 않고, 전지는 A·B 두 가지에 전류를 대야 하므로 전지 전류가 두 배가 됩니다. 병렬로 저항을 더 달면 전체 저항은 오히려 줄어듭니다(100 Ω → 50 Ω).' },

    { id:'openswitch', cat:'dc', title:'열린 스위치 양단의 전압', level:'기초',
      misconception:'"열리면 전압도 0"',
      circuit:{
        comps:battery(12,46,48,{on:false}).concat([C('R','RESISTOR',49,46,0,100)]),
        wires:batteryW.concat([W('sw','L','R','L','V-first'), W('R','R','dc','R','V-first')]),
        center:[48.5,47.5] },
      question:'스위치가 열려 있어 전류가 0 입니다. 이때 스위치 양단의 전압은?',
      options:[
        {label:'12 V (전지 전압 전부)', correct:true},
        {label:'0 V — 전류가 없으니 전압도 없다', tag:'전압을 전류의 성질로 보는 오개념'},
        {label:'6 V — 저항과 반씩 나눈다', tag:'전압은 소자 수로 균등 분배된다는 생각'}],
      observe:'실행 모드에서 스위치를 클릭해 속성 패널의 "양단 전압"을 보고, 다시 클릭해 닫아 보세요.',
      explain:'전류가 0 이면 저항 양단 전압은 IR = 0 입니다. 전지의 12 V 는 어디엔가 걸려야 하므로 전부 열린 스위치 양단에 걸립니다. 전압은 두 점 사이의 전위차이지 "흐르는 것"이 아닙니다. 스위치를 닫으면 스위치 전압은 0, 저항 전압이 12 V 가 됩니다.' },

    { id:'rectifier', cat:'semi', title:'다이오드의 정류 작용', level:'심화',
      misconception:'"다이오드 = 저항을 줄이는 소자"',
      circuit:{
        comps:[C('ac','AC_SOURCE',46,48,90,10,60), C('sw','SWITCH',46,47,90,0,null,{autoFor:'ac'}),
               C('D','DIODE',48,46,0,0), C('R','RESISTOR',51,47,90,1000)],
        wires:[W('ac','L','sw','R'), W('sw','L','D','L','V-first'), W('D','R','R','L','H-first'), W('R','R','ac','R','V-first')],
        center:[49,47.5] },
      question:'교류 전원(10 V, 60 Hz)에 다이오드와 저항을 직렬로 이었습니다. 저항 양단 전압 파형은?',
      options:[
        {label:'양의 반주기만 남고 음의 반주기는 0', correct:true},
        {label:'사인파 그대로 (크기만 조금 작아짐)', tag:'다이오드를 그냥 저항으로 보는 오개념'},
        {label:'일정한 직류 전압', tag:'정류 = 직류 변환이라는 생각 (평활 없이는 맥류)'},
        {label:'사인파가 위아래로 뒤집힘', tag:'다이오드가 극성을 바꾼다는 생각'}],
      observe:'실행 모드의 오실로스코프에서 전원 파형(파랑)과 저항 파형(청록)을 비교하세요.',
      explain:'p-n 접합 다이오드는 순방향(애노드가 캐소드보다 약 0.6 V 이상 높을 때)에만 전류를 흘립니다. 전원이 음(−)인 반주기에는 역방향이라 전류가 0, 저항 전압도 0 입니다. 남은 것은 양의 반주기뿐이고 봉우리는 0.6 V 쯤 깎입니다 — 반파 정류입니다.' },

    { id:'transistor', cat:'semi', title:'트랜지스터의 스위칭 작용', level:'심화',
      misconception:'"전구 밝기 = 베이스 전류"',
      circuit:{
        comps:[VCC('lb',47,44,12), C('L','BULB',47,45,90,100,1,{label:'전구'}), C('Q','NPN',47,48,0,100), GND('ge',47,50),
               VCC('li',44,44,12), C('sw','SWITCH',44,45,90,0,null,{on:false}), C('Rb','RESISTOR',44,46,90,4700)],
        wires:[W('lb','B','L','L'), W('L','R','Q','T'), W('Q','B','ge','T'),
               W('li','B','sw','L'), W('sw','R','Rb','L'), W('Rb','R','Q','L','V-first')],
        center:[46,47], rail:true },
      question:'베이스에는 4.7 kΩ 을 거쳐 2 mA 정도만 흐릅니다. 스위치를 닫으면 컬렉터의 전구는?',
      options:[
        {label:'환하게 켜진다 — 작은 베이스 전류가 100배 큰 컬렉터 전류를 열어 준다', correct:true},
        {label:'베이스 전류 2 mA 만큼만 아주 희미하게 켜진다', tag:'전구를 지나는 전류가 베이스 전류라는 생각'},
        {label:'변화 없다 — 전구 회로와 스위치 회로는 별개', tag:'세 단자 소자의 제어 작용을 모르는 상태'}],
      observe:'실행 모드에서 베이스 스위치를 클릭하세요. 트랜지스터를 클릭하면 I_B, I_C 와 동작 영역이 나옵니다.',
      explain:'npn 트랜지스터는 베이스 전류 I_B 의 β(≈100)배까지 컬렉터 전류를 허용합니다. 2.4 mA 의 베이스 전류로 전구가 요구하는 120 mA 를 넉넉히 열 수 있어 트랜지스터는 포화(ON)되고, 컬렉터-이미터 전압은 0.1 V 정도로 떨어집니다. 작은 전류로 큰 전류를 켜고 끄는 것 — 스위칭 작용입니다.' },

    { id:'not', cat:'semi', title:'논리 회로 — NOT 게이트', level:'심화', truth:{inputs:['swA'], output:'out', fn:function(a){return a?0:1;}},
      misconception:'게이트를 블랙박스로만 아는 상태',
      circuit:{
        comps:[VCC('la',44,44,5), C('swA','SWITCH',44,45,90,0,null,{on:false,label:'A'}), C('RbA','RESISTOR',44,46,90,10000),
               VCC('lc',47,44,5), C('Rc','RESISTOR',47,45,90,1000), C('J','JUNCTION_3',47,47,270), C('Q','NPN',47,48,0,100), GND('ge',47,50),
               C('out','BULB',50,47,0,100000,0.0002,{label:'출력'}), GND('go',52,48)],
        wires:[W('la','B','swA','L'), W('swA','R','RbA','L'), W('RbA','R','Q','L','V-first'),
               W('lc','B','Rc','L'), W('Rc','R','J','R'), W('J','L','Q','T'), W('Q','B','ge','T'),
               W('J','B','out','L'), W('out','R','go','T','H-first')],
        center:[48,47.5], rail:true },
      question:'입력 A(스위치 닫힘 = 1)에 따라 출력 전구는? 진리표의 예측 칸을 채우세요.',
      options:[{label:'진리표를 채웠습니다', correct:true}],
      observe:'실행 모드에서 스위치 A 를 클릭하며 출력 전구를 보세요. 아래 진리표의 관찰 칸은 회로가 두 경우를 풀어 채운 값입니다.',
      explain:'입력이 1 이면 베이스 전류가 흘러 트랜지스터가 켜지고(포화) 컬렉터 전압이 0 V 근처로 떨어져 전구가 꺼집니다. 입력이 0 이면 트랜지스터가 꺼져 풀업 저항을 통해 컬렉터가 5 V 로 올라가 전구가 켜집니다 — 입력을 뒤집는 NOT.' },

    /* AND (교과서 배선): 트랜지스터 두 개를 직렬로 — Q1 컬렉터 ← VCC, Q1 이미터 → Q2 컬렉터, Q2 이미터 = OUT, OUT → R → 접지.
     *   입력은 왼쪽에서 R 을 거쳐 베이스로 (A → Q1, B → Q2). 두 베이스가 다 열려야 전류 경로가 이어진다. */
    { id:'and', cat:'semi', title:'논리 회로 — AND 게이트 (트랜지스터)', level:'심화', truth:{inputs:['swA','swB'], output:'out', fn:function(a,b){return (a&&b)?1:0;}},
      misconception:'게이트를 블랙박스로만 아는 상태',
      circuit:{
        comps:[VCC('lc',47,42,5), C('Q1','NPN',47,43,0,100), C('Q2','NPN',47,45,0,100),
               VCC('la',42,42,5), C('swA','SWITCH',43,43,0,0,null,{on:false,label:'A'}), C('RbA','RESISTOR',45,43,0,10000),
               VCC('lb',42,44,5), C('swB','SWITCH',43,45,0,0,null,{on:false,label:'B'}), C('RbB','RESISTOR',45,45,0,10000),
               C('J','JUNCTION_3',47,46,270), C('Rd','RESISTOR',47,47,90,1000), GND('gr',47,49),
               C('out','BULB',50,46,0,100000,0.0002,{label:'출력'}), GND('go',52,47)],
        /* J(rot 270): R=위, L=아래, B=오른쪽 */
        wires:[W('lc','B','Q1','T'), W('Q1','B','Q2','T'),
               W('la','B','swA','L','V-first'), W('swA','R','RbA','L'), W('RbA','R','Q1','L'),
               W('lb','B','swB','L','V-first'), W('swB','R','RbB','L'), W('RbB','R','Q2','L'),
               W('Q2','B','J','R'), W('J','L','Rd','L'), W('Rd','R','gr','T'),
               W('J','B','out','L'), W('out','R','go','T','H-first')],
        center:[47.5,45.5], rail:true },
      question:'두 입력 A, B (스위치 닫힘 = 1). 출력 전구는 언제 켜질까요? 진리표를 예측하세요.',
      options:[{label:'진리표를 채웠습니다', correct:true}],
      observe:'스위치 A·B 를 클릭해 네 조합을 만들어 보세요. 트랜지스터를 클릭하면 I_B, I_C 와 동작 영역(차단/포화)이 보입니다. 아래 관찰 칸은 회로가 네 조합을 풀어 채운 값입니다.',
      explain:'두 트랜지스터가 전원과 출력 사이에 직렬로 놓여 있습니다. 입력이 1 이면 그 베이스에 전류가 흘러 트랜지스터가 켜지고(스위치 닫힘), 0 이면 꺼집니다(스위치 열림). 직렬이므로 둘 다 켜져야 전류가 VCC → Q1 → Q2 → 출력으로 이어져 출력이 약 3.8 V(1)가 됩니다. 어느 하나라도 꺼지면 경로가 끊겨 풀다운 저항이 출력을 0 V 근처로 둡니다 — AND.' },

    /* OR (교과서 배선): 트랜지스터 두 개를 병렬로 — 컬렉터는 둘 다 VCC, 이미터는 한 점(OUT)에 모아 R 로 접지.
     *   입력은 왼쪽에서 R 을 거쳐 베이스로 (A → Q1, B → Q2). 어느 한쪽만 열려도 전류 경로가 생긴다. */
    { id:'or', cat:'semi', title:'논리 회로 — OR 게이트 (트랜지스터)', level:'심화', truth:{inputs:['swA','swB'], output:'out', fn:function(a,b){return (a||b)?1:0;}},
      misconception:'게이트를 블랙박스로만 아는 상태',
      circuit:{
        comps:[VCC('lc',47,42,5), C('Q1','NPN',47,43,0,100), VCC('lc2',49,45,5), C('Q2','NPN',47,46,0,100),
               VCC('la',42,42,5), C('swA','SWITCH',43,43,0,0,null,{on:false,label:'A'}), C('RbA','RESISTOR',45,43,0,10000),
               VCC('lb',42,45,5), C('swB','SWITCH',43,46,0,0,null,{on:false,label:'B'}), C('RbB','RESISTOR',45,46,0,10000),
               C('J','JUNCTION_4',50,47), C('Rd','RESISTOR',50,48,90,1000), GND('gr',50,50),
               C('out','BULB',52,47,0,100000,0.0002,{label:'출력'}), GND('go',54,48)],
        wires:[W('lc','B','Q1','T'), W('Q2','T','lc2','B'),
               W('la','B','swA','L','V-first'), W('swA','R','RbA','L'), W('RbA','R','Q1','L'),
               W('lb','B','swB','L','V-first'), W('swB','R','RbB','L'), W('RbB','R','Q2','L'),
               W('Q1','B','J','T','H-first'), W('Q2','B','J','L','V-first'),
               W('J','B','Rd','L'), W('Rd','R','gr','T'), W('J','R','out','L'), W('out','R','go','T','H-first')],
        center:[48.5,46], rail:true },
      question:'두 입력 A, B (스위치 닫힘 = 1). 출력 전구는 언제 켜질까요? 진리표를 예측하세요.',
      options:[{label:'진리표를 채웠습니다', correct:true}],
      observe:'스위치 A·B 를 클릭해 네 조합을 만들어 보세요. 트랜지스터를 클릭하면 I_B, I_C 와 동작 영역이 보입니다. 아래 관찰 칸은 회로가 네 조합을 풀어 채운 값입니다.',
      explain:'두 트랜지스터가 전원과 출력 사이에 병렬로 놓여 있습니다. 입력이 1 인 쪽의 트랜지스터가 켜져 VCC → 그 트랜지스터 → 출력으로 전류가 흐르고, 출력은 약 3.9 V(1)가 됩니다. 병렬이므로 어느 한쪽만 켜져도 경로가 생기고, 둘 다 꺼져야 풀다운 저항이 출력을 0 V 로 둡니다 — OR.' },

    /* ── 상호유도 (결합 인덕터 = 변압기) ──
     *   1차·2차 코일을 나란히 (왼쪽 rot 270 · 오른쪽 rot 90 → 코일이 바깥으로 불룩, 철심이 가운데).
     *   couple 로 서로 가리키고 value2 = k. 2차 회로는 도선으로는 섬이지만 결합으로 살아 있다. */
    { id:'mutual', cat:'mutual', title:'상호유도 — 직류 전지와 변압기', level:'심화',
      misconception:'"변압기는 직류도 옮긴다" · "이어지지 않은 회로엔 절대 전류가 없다"',
      circuit:{
        comps:battery(12,45,48).concat([C('R1','RESISTOR',47,45,0,100), C('L1','INDUCTOR',49,47,270,1,0.99,{couple:'L2',label:'1차'}),
               C('L2','INDUCTOR',50,47,90,1,0.99,{couple:'L1',label:'2차'}), C('out','BULB',52,45,0,100,0.25,{label:'2차 전구'})]),
        /* L1(rot 270): L=아래·R=위 / L2(rot 90): L=위·R=아래 */
        wires:batteryW.concat([W('sw','L','R1','L','V-first'), W('R1','R','L1','R','H-first'), W('L1','L','dc','R','V-first'),
               W('L2','L','out','L','V-first'), W('out','R','L2','R','V-first')]),
        center:[49,47] },
      question:'1차 코일에 12 V 전지를, 2차 코일에 전구를 이었습니다. 두 회로는 도선으로 이어져 있지 않습니다. 스위치를 닫으면 2차 전구는?',
      options:[
        {label:'닫는 순간 잠깐 켜졌다가 꺼진다', correct:true},
        {label:'계속 켜져 있다', tag:'변압기가 직류도 옮긴다는 생각 — 상호유도는 전류의 "변화"만 옮긴다'},
        {label:'전혀 켜지지 않는다 — 도선으로 이어져 있지 않다', tag:'자기장을 통한 에너지 전달을 모르는 상태 (도선으로 이어져야만 전류가 흐른다는 생각)'},
        {label:'1차와 같은 밝기로 계속 켜진다', tag:'변압기를 도선처럼 보는 생각'}],
      observe:'실행 모드에서 스위치가 닫히는 순간(t = 0) 2차 전구를 보세요. 과도 응답 그래프에 1차 전류(서서히 올라감)와 2차 전류(솟았다가 사라짐)가 함께 그려집니다. 2차 코일을 클릭하면 결합 계수 k 와 M 이 보입니다.',
      explain:'2차 코일에 생기는 기전력은 M·di₁/dt — 1차 전류가 "변하는" 동안만 있습니다. 스위치를 닫으면 1차 전류가 τ = L/R = 10 ms 동안 0에서 120 mA 로 올라가고, 그동안만 2차에 전류가 흘러 전구가 잠깐 켜집니다. 1차 전류가 일정해지면 자기장도 일정해져 2차 기전력은 0 이 됩니다. 직류를 바꾸려면 끊었다 이었다 해야 하고, 그래서 변압기는 교류에 씁니다.' },

    { id:'transformer', cat:'mutual', title:'상호유도 — 교류 변압기의 전압비', level:'심화',
      misconception:'"권선비는 상관없다" · "전압이 2배면 전류도 2배 (에너지가 늘어난다)"',
      circuit:{
        comps:[C('ac','AC_SOURCE',45,48,90,10,60), C('sw','SWITCH',45,47,90,0,null,{autoFor:'ac'}),
               C('L1','INDUCTOR',49,47,270,10,0.99,{couple:'L2',label:'1차 10 H'}), C('L2','INDUCTOR',50,47,90,40,0.99,{couple:'L1',label:'2차 40 H'}),
               C('out','BULB',52,45,0,1000,0.2,{label:'2차 전구'})],
        wires:[W('ac','L','sw','R'), W('sw','L','L1','R','V-first'), W('L1','L','ac','R','V-first'),
               W('L2','L','out','L','V-first'), W('out','R','L2','R','V-first')],
        center:[49,47] },
      question:'1차 코일 10 H, 2차 코일 40 H (권선비 1:2). 1차에 10 V 교류를 걸면 2차 전구에 걸리는 전압(peak)은?',
      options:[
        {label:'약 20 V — 권선비(√(L₂/L₁) = 2)만큼 커진다', correct:true},
        {label:'10 V — 코일을 거쳐도 전압은 그대로', tag:'권선비의 역할을 모르는 상태'},
        {label:'40 V — 인덕턴스가 4배이니 전압도 4배', tag:'전압비를 인덕턴스비로 보는 생각 (전압비는 권선비 = √(인덕턴스비))'},
        {label:'20 V 이고 전류도 2배가 된다', tag:'에너지 보존을 놓친 생각 — 전압이 2배면 전류는 절반'}],
      variants:[{label:'k = 0.99 (밀착)'},{label:'k = 0.9',set:{L1:{value2:0.9},L2:{value2:0.9}}},{label:'k = 0.5 (멀리 뗌)',set:{L1:{value2:0.5},L2:{value2:0.5}}}],
      measure:{key:'out',q:'v',label:'2차 전구 전압(peak)'},
      observe:'실행 모드에서 2차 전구를 클릭해 전압(peak)을 보세요. 오실로스코프에는 1차 전원(10 V)과 2차 전구 전압이 겹쳐 그려집니다. 아래 표의 줄을 클릭하면 결합 계수 k(코일을 떼어 놓은 정도)를 바꿔 볼 수 있습니다 — 결합이 약하면 2차 전압이 크게 줍니다.',
      explain:'결합 계수 k ≈ 1 인 변압기에서 V₂/V₁ = √(L₂/L₁) = 권선비이므로 2차 전압은 약 20 V 입니다. 에너지는 늘지 않습니다 — 전원이 주는 평균전력과 전구가 쓰는 평균전력이 같고, 전압이 2배가 된 만큼 전류는 절반입니다. 변압기가 교류에서만 쓰이는 이유는 앞 예제(직류 전지)와 이어집니다: 기전력은 전류의 변화 M·di/dt 에서 나옵니다.' },

    /* ════════ 축전기 · 인덕터 ════════ */
    { id:'capcharge', cat:'lc', title:'축전기를 충전하는 순간의 전구', level:'기초',
      misconception:'"축전기는 끊어진 회로라 전류가 흐르지 않는다"',
      circuit:{
        comps:battery(12,45,48).concat([C('out','BULB',47,45,0,100,1,{label:'전구'}), C('Cc','CAPACITOR',50,47,90,1000e-6)]),
        wires:batteryW.concat([W('sw','L','out','L','V-first'), W('out','R','Cc','L','H-first'), W('Cc','R','dc','R','V-first')]),
        center:[48,47] },
      question:'전지 · 전구 · 축전기(1000 µF)를 직렬로 이었습니다. 스위치를 닫으면 전구는?',
      options:[
        {label:'처음엔 밝게 켜졌다가 점점 어두워져 꺼진다', correct:true},
        {label:'켜지지 않는다 — 축전기 사이는 끊어져 있다', tag:'축전기를 항상 끊어진 회로로 보는 생각 (충전 전류를 모름)'},
        {label:'점점 밝아져 계속 켜져 있다', tag:'충전될수록 전류가 커진다는 생각 (실제는 반대)'},
        {label:'처음부터 끝까지 같은 밝기', tag:'축전기를 저항처럼 보는 생각'}],
      observe:'실행 모드에서 스위치가 닫히는 순간 전구를 보세요. 과도 응답 그래프에 충전 전류가 e^(−t/τ) 로 줄어드는 곡선이 그려집니다 (τ = RC = 0.1 s). 축전기를 클릭하면 충전량 Q = CV 가 보입니다.',
      explain:'스위치를 닫는 순간 축전기는 비어 있어(전압 0) 전지 전압이 모두 전구에 걸리고 120 mA 가 흐릅니다. 극판에 전하가 쌓일수록 축전기 전압이 전지 전압을 밀어내 전류가 줄고, τ = RC = 0.1 s 마다 37 % 로 줄어 5τ 뒤에는 거의 0 — 전구는 밝게 켜졌다가 꺼집니다. "끊어진 회로"인 것은 다 충전된 뒤의 정상상태뿐입니다.' },

    { id:'rctau', cat:'lc', title:'시간 상수 τ = RC — 어느 전구가 먼저 꺼질까', level:'기초',
      misconception:'"저항이 크면 빨리 찬다" · "충전 시간은 축전기만 정한다"',
      circuit:{
        comps:battery(12,45,49).concat([C('ja','JUNCTION_3',47,46), C('A','BULB',47,47,90,100,1,{label:'A'}), C('C1','CAPACITOR',47,49,90,1000e-6),
               C('B','BULB',50,47,90,200,1,{label:'B'}), C('C2','CAPACITOR',50,49,90,1000e-6), C('jc','JUNCTION_3',47,51,180)]),
        /* ja(rot 0): B=아래 / jc(rot 180): B=위, L=오른쪽, R=왼쪽 */
        wires:batteryW.concat([W('sw','L','ja','L','V-first'), W('ja','B','A','L'), W('A','R','C1','L'), W('C1','R','jc','B'),
               W('ja','R','B','L','H-first'), W('B','R','C2','L'), W('C2','R','jc','L','V-first'), W('jc','R','dc','R','H-first')]),
        center:[48,48.5] },
      question:'같은 축전기(1000 µF) 두 개. A 쪽 전구는 100 Ω, B 쪽 전구는 200 Ω 입니다. 어느 전구가 먼저 꺼질까요?',
      options:[
        {label:'A (100 Ω) 가 먼저 꺼진다', correct:true},
        {label:'B (200 Ω) 가 먼저 꺼진다', tag:'저항이 크면 빨리 찬다는 생각 (τ = RC 는 R 에 비례)'},
        {label:'동시에 꺼진다 — 축전기가 같으니까', tag:'충전 시간을 축전기만 정한다는 생각'},
        {label:'B 는 켜지지 않는다', tag:'저항이 크면 전류가 0 이라는 생각'}],
      observe:'실행 모드에서 두 전구가 꺼지는 순서를 보고, 과도 응답 그래프의 두 곡선을 비교하세요 (τ_A = 0.1 s, τ_B = 0.2 s).',
      explain:'충전이 얼마나 빨리 끝나는지는 시간 상수 τ = RC 가 정합니다. 축전기가 같으면 저항이 작은 쪽이 τ 가 짧아 먼저 다 차고 먼저 꺼집니다 — A 는 0.1 s, B 는 0.2 s. 저항이 크면 전류가 작아 전하가 천천히 쌓입니다. 마지막에 쌓이는 전하량 Q = CV 는 둘이 같습니다.' },

    { id:'capseries', cat:'lc', title:'직렬 축전기의 전하량', level:'심화',
      misconception:'"전하도 전류처럼 나뉜다" · "큰 축전기가 더 많이 갖는다"',
      circuit:{
        comps:battery(12,45,48).concat([C('R','RESISTOR',47,45,0,100), C('C1','CAPACITOR',49,45,0,100e-6,null,{label:'C₁ 100 µF'}),
               C('C2','CAPACITOR',51,45,0,200e-6,null,{label:'C₂ 200 µF'})]),
        wires:batteryW.concat([W('sw','L','R','L','V-first'), W('R','R','C1','L'), W('C1','R','C2','L'), W('C2','R','dc','R','V-first')]),
        center:[48.5,47] },
      select:'C1',
      question:'100 µF 와 200 µF 축전기를 직렬로 이어 12 V 로 충전했습니다. 다 충전된 뒤 두 축전기의 전하량은?',
      options:[
        {label:'둘 다 같다 (0.8 mC)', correct:true},
        {label:'200 µF 쪽이 2배 많다', tag:'전기용량이 크면 전하도 많다는 생각 — 직렬에서는 전압이 나뉜다'},
        {label:'전하가 나뉘어 각각 절반씩', tag:'전하를 전류처럼 갈라지는 양으로 보는 생각'},
        {label:'100 µF 쪽이 2배 많다', tag:'전압이 큰 쪽이 전하도 많다는 생각 (Q = CV 에서 C 가 절반)'}],
      observe:'실행 모드에서 C₁ 과 C₂ 를 차례로 클릭해 충전량 Q = CV 와 전압을 비교하세요.',
      explain:'직렬로 이어진 두 축전기 사이 도선은 어디와도 이어져 있지 않아 전하가 드나들 수 없습니다. C₁ 의 −극판에 −Q 가 모이면 그 전하는 C₂ 의 +극판에서 온 것이라 두 축전기의 전하량은 반드시 같습니다. 대신 전압이 나뉩니다: V = Q/C 이므로 100 µF 에 8 V, 200 µF 에 4 V (합 12 V), Q = 0.8 mC.' },

    { id:'inddelay', cat:'lc', title:'코일이 있는 가지의 전구는 늦게 켜진다', level:'기초',
      misconception:'"코일은 그냥 도선이다"',
      circuit:{
        comps:battery(12,45,49).concat([C('ja','JUNCTION_3',47,46), C('A','BULB',47,47,90,100,1,{label:'A'}),
               C('Lc','INDUCTOR',50,47,90,1), C('B','BULB',50,49,90,100,1,{label:'B'}), C('jc','JUNCTION_3',47,50,180)]),
        wires:batteryW.concat([W('sw','L','ja','L','V-first'), W('ja','B','A','L'), W('A','R','jc','B'),
               W('ja','R','Lc','L','H-first'), W('Lc','R','B','L'), W('B','R','jc','L','V-first'), W('jc','R','dc','R','H-first')]),
        center:[48,48] },
      question:'같은 전구 A, B 가 병렬입니다. B 앞에는 코일(1 H)이 있습니다. 스위치를 닫으면?',
      options:[
        {label:'A 는 바로 켜지고, B 는 잠시 뒤 서서히 밝아진다', correct:true},
        {label:'둘 다 동시에 같은 밝기로 켜진다', tag:'코일을 그냥 도선으로 보는 생각 (유도 기전력을 모름)'},
        {label:'B 는 켜지지 않는다 — 코일이 막는다', tag:'코일을 저항이 큰 소자로 보는 생각 (정상상태에서는 도선)'},
        {label:'B 가 먼저 켜진다', tag:'코일이 전류를 밀어 준다는 생각'}],
      observe:'실행 모드에서 A 와 B 가 켜지는 순간을 비교하고, 과도 응답 그래프의 코일 전류 곡선(τ = L/R = 10 ms)을 보세요.',
      explain:'전류가 갑자기 커지려 하면 코일은 자기장을 만들며 그 변화를 막는 기전력 −L·di/dt 를 냅니다. 그래서 B 쪽 전류는 0 에서 시작해 τ = L/R = 10 ms 의 시간 상수로 서서히 올라갑니다. 다 올라간 뒤(정상상태)에는 코일이 도선과 같아 A, B 밝기가 같아집니다.' },

    { id:'lcosc', cat:'lc', title:'코일과 축전기 — 전류가 흔들린다', level:'심화',
      misconception:'"충전은 항상 서서히 올라가 멈춘다"',
      circuit:{
        comps:battery(12,45,48).concat([C('R','RESISTOR',47,45,0,5), C('Lc','INDUCTOR',49,45,0,10e-3), C('Cc','CAPACITOR',51,45,0,100e-6)]),
        wires:batteryW.concat([W('sw','L','R','L','V-first'), W('R','R','Lc','L'), W('Lc','R','Cc','L'), W('Cc','R','dc','R','V-first')]),
        center:[48.5,47] },
      select:'Cc',
      question:'저항(5 Ω) · 코일(10 mH) · 축전기(100 µF)를 직렬로 이었습니다. 스위치를 닫으면 축전기 전압은?',
      options:[
        {label:'12 V 를 넘어섰다가 되돌아오기를 되풀이하며 잦아든다', correct:true},
        {label:'서서히 올라가 12 V 에서 멈춘다', tag:'RC 충전처럼만 생각 — 코일의 관성(자기에너지)을 놓침'},
        {label:'곧바로 12 V 가 된다', tag:'코일·축전기를 도선으로 보는 생각'},
        {label:'12 V 까지 올라가지 못한다', tag:'저항이 전압을 깎는다는 생각'}],
      observe:'실행 모드에서 과도 응답 그래프의 전류 곡선을 보세요 — 방향을 바꿔 가며 진동합니다. 축전기를 클릭하면 전압을 볼 수 있습니다.',
      explain:'코일은 전류를 갑자기 멈추지 못합니다. 축전기가 12 V 까지 차도 코일에 흐르던 전류가 관성처럼 계속 흘러 축전기를 12 V 넘게 채우고, 이어 거꾸로 흐르며 되돌립니다. 에너지가 코일의 자기에너지 ½LI² 와 축전기의 전기에너지 ½CV² 사이를 오가는 진동이고, 저항이 조금씩 열로 빼앗아 잦아듭니다 (ω₀ = 1/√(LC) ≈ 1000 rad/s).' },

    /* ════════ 여러 전원 · 전위 ════════ */
    { id:'potential', cat:'multi', title:'직렬 두 전지 — 각 점의 전위', level:'기초',
      misconception:'"전지 + 극은 항상 전지 전압" · "전압은 저항을 지나도 그대로"',
      circuit:{
        comps:bat('d1',6,45,49,{label:'전지 1'}).concat(bat('d2',6,45,46,{label:'전지 2'}), [
               C('R1','RESISTOR',48,44,0,100,null,{label:'R₁'}), C('R2','RESISTOR',51,47,90,100,null,{label:'R₂'}),
               C('jb','JUNCTION_3',48,50), GND('g',48,52)]),
        wires:[batW('d1'), batW('d2'), W('d1s','L','d2','R'), W('d2s','L','R1','L','V-first'), W('R1','R','R2','L','H-first'),
               W('R2','R','jb','R','V-first'), W('jb','L','d1','R','H-first'), W('jb','B','g','T')],
        center:[48.5,48], rail:true },
      vis:['potential'],
      question:'6 V 전지 두 개를 직렬로, 100 Ω 저항 두 개를 직렬로 이었습니다. 전지 1 의 − 극이 접지(0 V)입니다. 두 전지 사이의 점 P 와 두 저항 사이의 점 Q 의 전위는?',
      options:[
        {label:'P = 6 V, Q = 6 V', correct:true},
        {label:'P = 6 V, Q = 12 V', tag:'전압이 저항을 지나도 그대로라는 생각 (저항마다 6 V 씩 떨어진다)'},
        {label:'P = 12 V, Q = 6 V', tag:'전지의 + 극은 항상 전지 전압이라는 생각 (전위는 접지 기준의 누적)'},
        {label:'P = 0 V, Q = 0 V', tag:'전위가 전지 안에서만 있다는 생각'}],
      observe:'전위 지형(V)이 켜져 도선이 전위에 따라 색칠되고 값이 붙습니다. 두 전지 사이와 두 저항 사이의 값을 읽고, 전류(60 mA)를 확인하세요.',
      explain:'전위는 접지에서 출발해 전지를 지날 때마다 +6 V 씩 올라가고(P = 6 V, 전지 2 위는 12 V), 저항을 지날 때마다 IR = 60 mA × 100 Ω = 6 V 씩 내려옵니다 (Q = 6 V, R₂ 아래 = 0 V). 한 바퀴 돌아오면 다시 0 — 키르히호프 전압 법칙입니다.' },

    { id:'opposed', cat:'multi', title:'마주 보게 이은 두 전지', level:'기초',
      misconception:'"전지가 둘이면 무조건 더 세다"',
      circuit:{
        comps:[C('d1','DC_SOURCE',45,49,90,12,null,{label:'전지 1'}), C('d1s','SWITCH',45,48,90,0,null,{autoFor:'d1'}),
               C('d2','DC_SOURCE',45,46,270,12,null,{label:'전지 2 (거꾸로)'}), C('d2s','SWITCH',45,45,90,0,null,{autoFor:'d2'}),
               C('out','BULB',49,44,0,100,1,{label:'전구'})],
        /* d2(rot 270): L=아래, R=위 */
        wires:[batW('d1'), W('d2','R','d2s','R'), W('d1s','L','d2','L'), W('d2s','L','out','L','V-first'), W('out','R','d1','R','V-first')],
        center:[47.5,47] },
      vis:['potential'],
      question:'12 V 전지 두 개를 직렬로 잇되, 전지 2 는 거꾸로(+ 극끼리 마주 보게) 넣었습니다. 전구는?',
      options:[
        {label:'켜지지 않는다 — 두 기전력이 상쇄되어 전류 0', correct:true},
        {label:'전지 한 개일 때의 2배로 밝다', tag:'전지가 둘이면 무조건 더 세다는 생각 (방향을 무시)'},
        {label:'전지 한 개일 때와 같다', tag:'거꾸로 넣은 전지가 그냥 도선이 된다는 생각'},
        {label:'전지가 타 버린다', tag:'마주 보는 전지 = 단락이라는 생각 (같은 전압이면 전류 0)'}],
      observe:'실행 모드에서 전류 배지(0 A)와 전위 지형을 보세요 — 전지 1 이 12 V 올린 것을 전지 2 가 도로 내립니다.',
      explain:'회로를 한 바퀴 돌며 기전력을 더하면 +12 V − 12 V = 0 이라 전류를 밀 힘이 없습니다. 전지 1 의 + 극은 12 V 지만 거꾸로 놓인 전지 2 를 지나며 다시 0 V 로 내려와 전구 양단 전압이 0 입니다. 전지는 "전류를 내놓는 통"이 아니라 "전위를 올리는 펌프"이고, 펌프의 방향이 중요합니다.' },

    { id:'pardiff', cat:'multi', title:'전압이 다른 두 전지의 병렬', level:'심화',
      misconception:'"전지가 둘이면 둘 다 전류를 보탠다"',
      circuit:{
        comps:bat('da',12,45,48,{label:'12 V (r = 1 Ω)',rint:1}).concat(bat('db',9,48,48,{label:'9 V (r = 1 Ω)',rint:1}), [
               C('jt','JUNCTION_3',48,45), C('out','BULB',51,48,90,10,10,{label:'전구'}), C('jb','JUNCTION_3',48,50,180)]),
        /* jt(rot 0): B=아래 / jb(rot 180): B=위, L=오른쪽, R=왼쪽 */
        wires:[batW('da'), batW('db'), W('das','L','jt','L','V-first'), W('dbs','L','jt','B'), W('jt','R','out','L','H-first'),
               W('db','R','jb','B'), W('da','R','jb','R','V-first'), W('out','R','jb','L','V-first')],
        center:[48.5,47.5] },
      vis:['potential','arrows'],
      question:'12 V 전지와 9 V 전지(내부저항 각 1 Ω)를 병렬로 이어 전구(10 Ω)를 켰습니다. 9 V 전지에는 전류가 어떻게 흐를까요?',
      options:[
        {label:'거꾸로 흘러 들어간다 (충전된다)', correct:true},
        {label:'12 V 전지와 함께 전구로 전류를 보낸다', tag:'전지가 둘이면 둘 다 전류를 보탠다는 생각 (전위가 높은 쪽이 낮은 쪽을 민다)'},
        {label:'흐르지 않는다', tag:'전압이 다르면 낮은 쪽은 쉰다는 생각'},
        {label:'전구가 21 V 를 받아 타 버린다', tag:'병렬 전압을 더하는 생각 (병렬은 같은 전압)'}],
      observe:'실행 모드에서 전류 화살표와 배지를 보세요. 9 V 전지 가지의 화살표가 다른 가지와 반대입니다. 전위 지형에서 공통 노드의 전위(10 V)를 읽으세요.',
      explain:'병렬이면 두 전지의 + 쪽이 같은 전위 — 여기서는 10 V 입니다. 12 V 전지는 자기 기전력보다 낮은 노드로 2 A 를 밀어내고, 9 V 전지는 자기 기전력보다 높은 노드에 물려 1 A 가 거꾸로 밀려 들어옵니다(충전). 전구에는 그 차 1 A 만 흐릅니다. 내부저항이 없다면 두 전지가 서로 무한대 전류를 주고받는 모순이 생겨, 실제 전지에는 항상 내부저항이 있습니다.' },

    /* ════════ 교류 ════════ */
    { id:'acrms', cat:'ac', title:'교류의 실효값 — 몇 V 직류와 같은가', level:'기초',
      misconception:'"최댓값이 곧 전압" · "왔다 갔다 하니 상쇄되어 0"',
      circuit:{
        comps:[C('ac','AC_SOURCE',45,48,90,10,60), C('sw','SWITCH',45,47,90,0,null,{autoFor:'ac'}), C('out','BULB',48,45,0,100,0.5,{label:'전구'})],
        wires:[W('ac','L','sw','R'), W('sw','L','out','L','V-first'), W('out','R','ac','R','V-first')],
        center:[47.5,47] },
      select:'out',
      question:'최댓값 10 V, 60 Hz 교류에 전구(100 Ω)를 이었습니다. 이 전구를 똑같은 밝기로 켜는 직류 전압은?',
      options:[
        {label:'약 7.07 V (= 10/√2)', correct:true},
        {label:'10 V — 최댓값이 곧 전압', tag:'최댓값과 실효값을 같게 보는 생각'},
        {label:'5 V — 평균이 절반', tag:'평균 전압을 밝기의 기준으로 보는 생각 (밝기는 V² 의 평균)'},
        {label:'0 V — 왔다 갔다 하니 상쇄된다', tag:'교류 전력을 방향과 함께 상쇄시키는 생각 (P = I²R 은 항상 양)'}],
      observe:'실행 모드에서 전구를 클릭해 전압(peak) 10 V 와 전압(RMS) 7.07 V, 소비전력(평균) 0.5 W 를 보세요. 오실로스코프에 v(t) 가 그려집니다.',
      explain:'전구 밝기는 전력 P = V²/R 에 달려 있고, 전력은 전압의 부호와 상관없이 양(+)입니다. 사인파 전압의 제곱 평균은 최댓값²의 절반이므로 같은 열을 내는 직류 전압은 V_max/√2 = 7.07 V — 이것이 실효값(RMS)입니다. 가정용 220 V 도 실효값이고 최댓값은 311 V 입니다.' },

    { id:'accap', cat:'ac', title:'축전기는 교류를 통과시킬까', level:'심화',
      misconception:'"축전기는 항상 끊어진 회로"',
      circuit:{
        comps:[C('ac','AC_SOURCE',45,48,90,10,60), C('sw','SWITCH',45,47,90,0,null,{autoFor:'ac'}),
               C('Cc','CAPACITOR',48,45,0,100e-6), C('out','BULB',50,45,0,100,0.5,{label:'전구'})],
        wires:[W('ac','L','sw','R'), W('sw','L','Cc','L','V-first'), W('Cc','R','out','L'), W('out','R','ac','R','V-first')],
        center:[48.5,47] },
      select:'Cc',
      question:'직류에서는 축전기가 다 충전되면 전류를 막았습니다. 교류(10 V, 60 Hz)에 축전기(100 µF)와 전구를 직렬로 이으면?',
      options:[
        {label:'계속 켜져 있다 — 충전과 방전이 되풀이된다', correct:true},
        {label:'켜지지 않는다 — 축전기 사이는 끊어져 있다', tag:'축전기를 항상 끊어진 회로로 보는 생각'},
        {label:'처음 잠깐만 켜졌다가 꺼진다', tag:'직류 충전 경험을 그대로 적용한 생각'},
        {label:'전류는 흐르지만 전구를 지나지 않는다', tag:'전하가 축전기를 "통과"해야만 흐른다는 생각'}],
      variants:[{label:'60 Hz'},{label:'6 Hz',set:{ac:{value2:6}}},{label:'600 Hz',set:{ac:{value2:600}}}],
      measure:{key:'out',q:'i',label:'전구 전류(RMS)'},
      observe:'실행 모드에서 전구가 계속 켜져 있고 전자가 왕복하는 것을 보세요. 축전기를 클릭하면 |Z_C| = 1/ωC ≈ 26.5 Ω 이 보이고, 오실로스코프에 전류가 전압보다 앞서는 위상이 보입니다. 아래 표의 줄을 클릭해 주파수를 바꿔 보세요 — 낮을수록 축전기가 더 막습니다.',
      explain:'전하는 축전기 사이를 건너지 않습니다. 대신 전압이 계속 바뀌어 한쪽 극판에 전하가 쌓였다 빠졌다 하고, 그 충·방전 전류가 회로 전체(전구 포함)에 흐릅니다. 축전기가 교류를 막는 정도는 |Z_C| = 1/(ωC) — 주파수가 높거나 용량이 크면 거의 도선처럼 통과시킵니다.' },

    { id:'acind', cat:'ac', title:'코일은 교류에서도 도선일까', level:'심화',
      misconception:'"코일은 저항이 0 인 도선이다"',
      circuit:{
        comps:[C('ac','AC_SOURCE',45,48,90,10,60), C('sw','SWITCH',45,47,90,0,null,{autoFor:'ac'}),
               C('Lc','INDUCTOR',48,45,0,0.5), C('out','BULB',50,45,0,100,0.5,{label:'전구'})],
        wires:[W('ac','L','sw','R'), W('sw','L','Lc','L','V-first'), W('Lc','R','out','L'), W('out','R','ac','R','V-first')],
        center:[48.5,47] },
      select:'Lc',
      question:'직류 정상상태에서 코일은 전류를 다 흘리는 도선이었습니다. 교류(10 V, 60 Hz)에 코일(0.5 H)과 전구를 직렬로 이으면?',
      options:[
        {label:'전류가 크게 줄고, 전압보다 늦게(위상이 뒤져) 흐른다', correct:true},
        {label:'직류 때처럼 도선과 같다 — 전구가 환하다', tag:'코일을 저항 0 인 도선으로만 보는 생각 (유도 기전력은 변화에 비례)'},
        {label:'전류가 전혀 흐르지 않는다', tag:'코일을 교류 차단기로 보는 생각 (막는 정도는 ωL 로 유한)'},
        {label:'전류는 그대로이고 위상만 바뀐다', tag:'리액턴스를 위상만의 문제로 보는 생각'}],
      variants:[{label:'60 Hz'},{label:'600 Hz',set:{ac:{value2:600}}},{label:'6 Hz',set:{ac:{value2:6}}}],
      measure:{key:'out',q:'i',label:'전구 전류(RMS)'},
      observe:'실행 모드에서 전구가 희미한 것을 보고, 코일을 클릭해 |Z_L| = ωL ≈ 188 Ω 을 읽으세요. 오실로스코프에서 전류가 전압보다 늦는 위상을 보세요. 아래 표의 줄을 클릭해 주파수를 바꿔 보세요 — 높을수록 코일이 더 막습니다.',
      explain:'교류는 전류가 끊임없이 변하므로 코일은 늘 그 변화를 막는 기전력 −L·di/dt 를 냅니다. 그래서 저항처럼 전류를 제한하는데, 그 크기가 유도 리액턴스 |Z_L| = ωL = 2π·60·0.5 ≈ 188 Ω 입니다. 전구(100 Ω)와 합쳐 전류는 직류 때의 절반 이하가 되고, 전류는 전압보다 늦게(최대 90°) 따라옵니다. 주파수가 높을수록 코일은 더 세게 막습니다.' },

    /* ════════ 트랜지스터 증폭 (바이어스) ════════
     *   공통 이미터: VCC 12 → Rc 470 → 컬렉터, 이미터 → Re 100 → GND. 베이스 ← Rb 1k ← (교류 1 V + 직류 바이어스).
     *   이득 ≈ −Rc/Re ≈ −3. 바이어스 0 이면 베이스가 0.65 V 를 넘는 반주기만 도통, 6 V 면 포화. */
    { id:'ampnobias', cat:'semi', title:'트랜지스터 증폭 ① 바이어스가 없으면', level:'심화',
      misconception:'"트랜지스터는 신호를 그대로 키운다"',
      circuit:{
        comps:[VCC('lc',47,42,12), C('Rc','RESISTOR',47,43,90,470,null,{label:'Rc'}), C('Q','NPN',47,45,0,100), C('Re','RESISTOR',47,47,90,150,null,{label:'Re'}), GND('ge',47,49),
               C('ac','AC_SOURCE',43,46,90,1,1000,{label:'신호 1 V'}), GND('gi',43,48), C('Rb','RESISTOR',45,45,0,1000,null,{label:'Rb'})],
        wires:[W('lc','B','Rc','L'), W('Rc','R','Q','T'), W('Q','B','Re','L'), W('Re','R','ge','T'),
               W('ac','R','gi','T'), W('ac','L','Rb','L','V-first'), W('Rb','R','Q','L')],
        center:[46,46], rail:true },
      select:'Q',
      question:'베이스에 최댓값 1 V 인 교류 신호만 넣었습니다 (직류 바이어스 없음). 컬렉터-이미터 전압 v_CE(t) 파형은?',
      options:[
        {label:'신호의 한쪽 반주기만 나타나고 나머지는 납작하다 (일그러짐)', correct:true},
        {label:'입력을 뒤집어 키운 온전한 사인파', tag:'바이어스 없이도 증폭된다는 생각 (베이스-이미터는 0.65 V 넘어야 도통)'},
        {label:'아무 변화 없다 — 12 V 그대로', tag:'1 V 신호로는 트랜지스터가 전혀 켜지지 않는다는 생각 (봉우리 근처는 도통)'},
        {label:'입력과 같은 크기의 사인파', tag:'트랜지스터를 도선으로 보는 생각'}],
      observe:'실행 모드에서 오실로스코프의 v_CE(t)·i_C(t) 를 보세요. 입력 신호가 +0.65 V 를 넘는 잠깐만 컬렉터 전류가 흐릅니다. 트랜지스터를 클릭하면 동작 영역이 나옵니다.',
      explain:'베이스-이미터는 다이오드라 약 0.65 V 를 넘어야 전류가 흐릅니다. 바이어스가 없으면 신호가 그 문턱을 넘는 봉우리 부근에서만 트랜지스터가 켜져, 출력에는 반주기의 일부만 나타나고 파형이 심하게 일그러집니다. 소리라면 찌그러진 소리입니다. 온전히 증폭하려면 신호 전체가 문턱 위에 놓이도록 직류를 더해 주어야 합니다 — 그것이 바이어스입니다.' },

    { id:'ampbias', cat:'semi', title:'트랜지스터 증폭 ② 바이어스 전압을 걸면', level:'심화',
      misconception:'"트랜지스터는 전류만 키운다" · "직류를 더하면 신호가 망가진다"',
      circuit:{
        comps:[VCC('lc',47,42,12), C('Rc','RESISTOR',47,43,90,470,null,{label:'Rc'}), C('Q','NPN',47,45,0,100), C('Re','RESISTOR',47,47,90,150,null,{label:'Re'}), GND('ge',47,49),
               C('ac','AC_SOURCE',43,46,90,1,1000,{label:'신호 1 V'}), C('bias','DC_SOURCE',43,48,90,2,null,{label:'바이어스 2 V'}), GND('gi',43,50), C('Rb','RESISTOR',45,45,0,1000,null,{label:'Rb'})],
        wires:[W('lc','B','Rc','L'), W('Rc','R','Q','T'), W('Q','B','Re','L'), W('Re','R','ge','T'),
               W('ac','R','bias','L'), W('bias','R','gi','T'), W('ac','L','Rb','L','V-first'), W('Rb','R','Q','L')],
        center:[46,46], rail:true },
      select:'Q',
      question:'같은 회로에 직류 2 V 바이어스를 더해 베이스가 항상 문턱 위에 있게 했습니다. v_CE(t) 파형은?',
      options:[
        {label:'입력을 거꾸로 뒤집어 약 3배 키운 온전한 사인파', correct:true},
        {label:'여전히 반쪽만 나온다', tag:'바이어스의 역할(신호 전체를 문턱 위로 올림)을 모르는 상태'},
        {label:'입력과 같은 크기의 사인파 — 트랜지스터는 전류만 키운다', tag:'전류 이득만 알고 전압 이득(컬렉터 저항에 걸리는 전압)을 모르는 상태'},
        {label:'직류 2 V 때문에 신호가 사라진다', tag:'직류를 더하면 교류가 망가진다는 생각 (둘은 겹쳐진다)'}],
      observe:'실행 모드에서 오실로스코프의 v_CE(t) 를 보세요 — 입력이 오를 때 내려가는 온전한 사인파이고 진폭이 입력의 약 3배입니다. 트랜지스터를 클릭하면 동작 영역 "활성"이 보입니다.',
      explain:'바이어스로 베이스 전류가 늘 흐르게 해 두면 트랜지스터는 활성 영역에 머물고, 작은 신호가 컬렉터 전류를 비례해서 흔듭니다. 컬렉터 전류의 변화가 Rc 에 걸리는 전압을 바꾸므로 전압 이득은 약 −Rc/Re ≈ −3 — 부호가 음이라 파형이 뒤집힙니다. 증폭은 "신호를 키우는 마법"이 아니라 전원(12 V)의 에너지를 신호 모양대로 꺼내 쓰는 것입니다.' },

    { id:'ampover', cat:'semi', title:'트랜지스터 증폭 ③ 바이어스가 지나치면', level:'심화',
      misconception:'"베이스 전류가 클수록 좋다"',
      circuit:{
        comps:[VCC('lc',47,42,12), C('Rc','RESISTOR',47,43,90,470,null,{label:'Rc'}), C('Q','NPN',47,45,0,100), C('Re','RESISTOR',47,47,90,150,null,{label:'Re'}), GND('ge',47,49),
               C('ac','AC_SOURCE',43,46,90,1,1000,{label:'신호 1 V'}), C('bias','DC_SOURCE',43,48,90,6,null,{label:'바이어스 6 V'}), GND('gi',43,50), C('Rb','RESISTOR',45,45,0,1000,null,{label:'Rb'})],
        wires:[W('lc','B','Rc','L'), W('Rc','R','Q','T'), W('Q','B','Re','L'), W('Re','R','ge','T'),
               W('ac','R','bias','L'), W('bias','R','gi','T'), W('ac','L','Rb','L','V-first'), W('Rb','R','Q','L')],
        center:[46,46], rail:true },
      select:'Q',
      question:'바이어스를 6 V 로 더 올렸습니다. 베이스 전류가 커졌으니 출력도 더 커질까요?',
      options:[
        {label:'포화되어 v_CE 가 바닥(약 0.1 V)에 붙고 출력이 납작해진다', correct:true},
        {label:'더 크게 증폭된다', tag:'베이스 전류가 클수록 좋다는 생각 (컬렉터 전류는 전원과 Rc 가 정한 한계를 못 넘는다)'},
        {label:'② 와 같다', tag:'동작점이 어디든 상관없다는 생각'},
        {label:'트랜지스터가 꺼진다', tag:'바이어스가 크면 차단된다는 생각 (반대: 포화)'}],
      observe:'실행 모드에서 오실로스코프의 v_CE(t) 를 보세요 — 거의 0 V 에 붙어 흔들리지 않습니다. 트랜지스터를 클릭하면 동작 영역 "포화"가 보입니다.',
      explain:'컬렉터 전류는 베이스 전류의 β배까지"만" 허용되는 것이지, 실제 흐르는 양은 전원과 저항이 정합니다. 바이어스 6 V 면 이미터 전압이 5 V 를 넘고 그때 필요한 컬렉터 전류 35 mA 를 Rc 470 Ω 이 12 V 로는 다 대지 못해 컬렉터 전압이 바닥까지 떨어져 버립니다(포화). 신호가 흔들어도 더 내려갈 곳이 없어 출력이 납작해집니다. 증폭기는 차단과 포화 사이의 한가운데에 동작점을 두어야 합니다.' },

    /* ── 스위치를 "여는" 순간 (opening:true — 실행 모드가 닫힌 정상상태에서 출발해 열림 뷰를 재생) ── */
    { id:'indopen', cat:'lc', title:'스위치를 여는 순간 — 코일의 유도 기전력', level:'심화', opening:true,
      misconception:'"전원을 끊으면 전류는 즉시 0" · "코일 전압은 전지 전압을 못 넘는다"',
      circuit:{
        comps:battery(12,45,49).concat([C('ja','JUNCTION_3',47,46), C('Lc','INDUCTOR',47,47,90,1,null,{label:'코일 1 H'}), C('RL','RESISTOR',47,49,90,10,null,{label:'코일 저항'}),
               C('out','BULB',50,47,90,100,1,{label:'전구'}), C('jc','JUNCTION_3',47,51,180)]),
        wires:batteryW.concat([W('sw','L','ja','L','V-first'), W('ja','B','Lc','L'), W('Lc','R','RL','L'), W('RL','R','jc','B'),
               W('ja','R','out','L','H-first'), W('out','R','jc','L','V-first'), W('jc','R','dc','R','H-first')]),
        center:[48,48.5] },
      question:'스위치가 닫혀 코일(1 H, 저항 10 Ω)에는 1.2 A, 병렬인 전구(100 Ω)에는 0.12 A 가 흐르고 있습니다. 이제 스위치를 "열면" 전구는?',
      options:[
        {label:'순간 훨씬 더 밝게 번쩍이고 꺼진다', correct:true},
        {label:'그냥 꺼진다 — 전원이 끊겼으니까', tag:'코일에 저장된 자기에너지(½LI²)를 모르는 상태'},
        {label:'서서히 어두워지되 원래보다 밝아지진 않는다', tag:'코일이 전류를 이어 가려 하지만 전압은 전지 전압(12 V)을 못 넘는다는 생각'},
        {label:'그대로 켜져 있다', tag:'전원 없이도 회로가 유지된다는 생각'}],
      observe:'이 예제의 실행 모드는 스위치가 "열리는" 순간(t = 0)부터 재생됩니다. 전구가 번쩍이고 전자가 아까와 반대 방향으로 도는 것을 보세요. 과도 응답 그래프에 코일 전류가 1.2 A 에서 줄어드는 곡선이 그려집니다 (τ = L/R = 9 ms). 전구를 클릭하면 전압을 볼 수 있습니다.',
      explain:'전류가 갑자기 끊기려 하면 코일은 −L·di/dt 의 큰 기전력으로 전류를 이어 가려 합니다. 남은 길은 전구뿐이라 1.2 A 가 100 Ω 전구를 지나며 120 V — 전지 전압의 10배 — 가 걸리고 전구는 순간 아주 밝게 번쩍입니다. 코일의 자기에너지 ½LI² = 0.72 J 가 다 빠질 때까지 τ = L/R ≈ 9 ms 로 잦아듭니다. 스위치를 열 때 튀는 불꽃, 자동차 점화 코일이 같은 원리입니다.' },

    /* ── 중첩 (variants: 한쪽 전지를 0 V 로 바꿔 가며 가운데 저항 전류 비교) ── */
    { id:'superpos', cat:'multi', title:'두 전지가 한 저항을 함께 밀 때 — 중첩', level:'심화',
      misconception:'"센 전지 하나가 정한다" · "병렬 가지의 전압은 더해진다"',
      circuit:{
        comps:bat('da',12,45,48,{label:'전지 A'}).concat(bat('db',6,51,48,{label:'전지 B'}), [
               C('R1','RESISTOR',47,45,0,100,null,{label:'R₁'}), C('jt','JUNCTION_3',49,45), C('R2','RESISTOR',52,45,0,100,null,{label:'R₂'}),
               C('R3','RESISTOR',49,47,90,100,null,{label:'가운데 R₃'}), C('jb','JUNCTION_3',49,50,180)]),
        wires:[batW('da'), batW('db'), W('das','L','R1','L','V-first'), W('R1','R','jt','L'), W('jt','R','R2','L'), W('dbs','L','R2','R','H-first'),
               W('jt','B','R3','L'), W('R3','R','jb','B'), W('da','R','jb','R','V-first'), W('db','R','jb','L','V-first')],
        center:[49,47.5] },
      variants:[{label:'A 12 V + B 6 V (둘 다)'},{label:'B 를 0 V 로 (도선)',set:{db:{value:0}}},{label:'A 를 0 V 로 (도선)',set:{da:{value:0}}}],
      measure:{key:'R3',q:'i',label:'R₃ 전류'},
      question:'12 V 전지 A 와 6 V 전지 B 가 각각 100 Ω 을 거쳐 가운데 저항 R₃(100 Ω)를 함께 밉니다. 둘 다 있을 때의 R₃ 전류는, 한쪽 전지를 0 V(도선)로 바꿨을 때의 전류 둘과 어떤 관계일까요?',
      options:[
        {label:'둘을 더한 값이다 (중첩)', correct:true},
        {label:'센 전지 A 하나만 있을 때와 같다', tag:'전지가 여럿이면 가장 센 것이 정한다는 생각'},
        {label:'두 값의 평균이다', tag:'전원이 둘이면 나눠 갖는다는 생각'},
        {label:'12 + 6 = 18 V 로 계산한 값이다', tag:'병렬 가지의 전압을 더하는 생각 (직렬일 때만 더해진다)'}],
      observe:'아래 표의 줄을 클릭하면 회로가 그 경우로 바뀌고 배지가 갱신됩니다. 세 경우의 R₃ 전류(60 · 40 · 20 mA)를 비교하세요.',
      explain:'회로가 저항과 전원만으로 된 선형 회로면, 전원 여러 개의 효과는 전원 하나씩 남기고(나머지는 0 V = 도선으로 바꿈) 구한 전류의 합과 같습니다 — 중첩의 원리. A 만 있으면 40 mA, B 만 있으면 20 mA, 둘이면 60 mA 입니다. 전원을 "빼는" 것이 아니라 "0 V 도선으로 바꾸는" 것이 핵심입니다 — 빼 버리면 그 가지의 저항 R₂ 까지 사라져 다른 답이 나옵니다.' },

    /* ── 전류 이득 β 와 포화 (variants: 베이스 저항 1/10 씩) ── */
    { id:'beta', cat:'semi', title:'베이스 전류를 키우면 컬렉터 전류는 — β 와 포화', level:'심화',
      misconception:'"I_C = βI_B 는 항상 성립한다"',
      circuit:{
        comps:[VCC('lb',47,44,12), C('L','BULB',47,45,90,100,1,{label:'전구'}), C('Q','NPN',47,48,0,100), GND('ge',47,50),
               VCC('li',44,44,12), C('Rb','RESISTOR',44,46,90,470000,null,{label:'Rb'})],
        wires:[W('lb','B','L','L'), W('L','R','Q','T'), W('Q','B','ge','T'), W('li','B','Rb','L'), W('Rb','R','Q','L','V-first')],
        center:[46,47], rail:true },
      variants:[{label:'Rb 470 kΩ'},{label:'Rb 47 kΩ',set:{Rb:{value:47000}}},{label:'Rb 4.7 kΩ',set:{Rb:{value:4700}}}],
      measure:{key:'Q',q:'ic',label:'컬렉터 전류 I_C'},
      select:'Q',
      question:'β = 100 인 트랜지스터가 전구(100 Ω, 12 V)를 켭니다. 베이스 저항을 470 kΩ → 47 kΩ → 4.7 kΩ 로 1/10 씩 줄이면 컬렉터 전류는?',
      options:[
        {label:'처음엔 10배씩 늘지만, 한계(포화)에 닿으면 더 늘지 않는다', correct:true},
        {label:'매번 10배씩 계속 는다', tag:'I_C = βI_B 가 항상 성립한다는 생각 — 컬렉터 전류는 전원과 부하가 정한 한계를 못 넘는다'},
        {label:'변하지 않는다', tag:'베이스 전류와 컬렉터 전류가 무관하다는 생각'},
        {label:'줄어든다', tag:'저항이 작아지면 전류가 준다는 혼동'}],
      observe:'아래 표의 줄을 클릭해 베이스 저항을 바꾸고, 트랜지스터를 클릭해 I_B·I_C 와 동작 영역(활성/포화)을 읽으세요. 전구 밝기도 비교하세요.',
      explain:'활성 영역에서는 I_C = βI_B 라 베이스 전류가 10배면 컬렉터 전류도 10배(2.4 mA → 24 mA)입니다. 그러나 컬렉터 전류는 전원 12 V 를 전구 100 Ω 으로 나눈 약 120 mA 를 넘을 수 없습니다. 4.7 kΩ 에서는 βI_B = 240 mA 를 "허용"하지만 실제로는 120 mA 에서 막혀 포화됩니다 — 스위치로 쓸 때는 일부러 이 영역을 씁니다.' },

    /* ── pnp 는 반대로 (베이스를 이미터보다 낮게 당겨야 켜진다) ── */
    { id:'pnp', cat:'semi', title:'pnp 트랜지스터는 반대로 켜진다', level:'심화',
      misconception:'"트랜지스터는 베이스에 + 를 걸어야 켜진다"',
      circuit:{
        comps:[VCC('lc',47,42,12), C('Q','PNP',47,44,180,100), C('out','BULB',47,46,90,100,1,{label:'전구'}), GND('go',47,48),
               C('Rb','RESISTOR',49,44,0,10000,null,{label:'Rb'}), C('sw','SWITCH',50,46,90,0,null,{on:false,label:'S'}), GND('gs',50,48)],
        /* Q(rot 180): B=위(이미터) · T=아래(컬렉터) · L=오른쪽(베이스) */
        wires:[W('lc','B','Q','B'), W('Q','T','out','L'), W('out','R','go','T'), W('Q','L','Rb','L'), W('Rb','R','sw','L','H-first'), W('sw','R','gs','T')],
        center:[48.5,45.5], rail:true },
      select:'Q',
      question:'pnp 트랜지스터입니다. 이미터가 +12 V 에, 컬렉터가 전구를 거쳐 접지에, 베이스는 저항을 거쳐 스위치 S 로 접지에 이어져 있습니다. 전구를 켜려면?',
      options:[
        {label:'S 를 닫아 베이스를 이미터보다 낮게(접지 쪽으로) 당긴다', correct:true},
        {label:'베이스에 + 전압을 걸어야 한다 — S 를 닫으면 오히려 꺼진다', tag:'npn 과 같다고 보는 생각 (pnp 는 베이스가 이미터보다 0.7 V 낮을 때 켜진다)'},
        {label:'S 와 상관없이 항상 켜져 있다', tag:'pnp 를 도선으로 보는 생각'},
        {label:'pnp 로는 전구를 켤 수 없다', tag:'전류가 컬렉터→이미터로만 흐른다는 생각 (pnp 는 이미터→컬렉터)'}],
      observe:'실행 모드에서 스위치 S 를 클릭해 켜고 끄며 전구를 보세요. 트랜지스터를 클릭하면 I_B 가 베이스에서 "나가는" 방향(음수)이고 이미터→컬렉터로 전류가 흐르는 것이 보입니다.',
      explain:'pnp 는 npn 의 모든 극성이 뒤집힌 소자입니다. 이미터-베이스 접합이 순방향이 되려면 베이스가 이미터보다 약 0.7 V "낮아야" 하고, 전류는 이미터(+12 V)에서 컬렉터로 흘러 나갑니다. S 를 닫으면 베이스가 저항을 거쳐 접지로 당겨져 켜지고, S 를 열면 베이스 전류가 없어 꺼집니다. 회로에서 npn 은 "아래쪽(접지 쪽) 스위치", pnp 는 "위쪽(전원 쪽) 스위치"로 쓰입니다.' },
  ];

  /* ── 회로 로드 ── */
  function loadCircuit(ex){
    var S=App.State, ids={};
    var old=S.components.map(function(c){return c.id;});
    old.forEach(function(id){ if(S.getComponent(id)) S.removeComponent(id); });
    ex.circuit.comps.forEach(function(c){
      var comp={id:S.genId(),type:TYPE[c.type],gridX:c.gx,gridY:c.gy,rotation:c.rot,value:c.value,value2:c.value2,label:c.label||''};
      if(c.on===false) comp.on=false;
      if(c.autoFor&&ids[c.autoFor]) comp.autoFor=ids[c.autoFor];   /* 전지에 딸린 스위치 (삭제 불가·편집 열림·실행 닫힘) */
      if(c.couple) comp._coupleKey=c.couple;                          /* 상호유도 짝 (키 → 아래에서 id 로) */
      if(comp.type===TYPE.DC_SOURCE||comp.type===TYPE.AC_SOURCE) comp.rint=(c.rint>0?c.rint:0);
      ids[c.key]=comp.id; S.addComponent(comp);
    });
    S.components.forEach(function(comp){ if(comp._coupleKey){ if(ids[comp._coupleKey]) comp.couple=ids[comp._coupleKey]; delete comp._coupleKey; } });
    ex.circuit.wires.forEach(function(w){
      S.addWire({id:S.genId(),fromId:ids[w[0]],fromPort:w[1],toId:ids[w[2]],toPort:w[3],direction:w[4]});
    });
    ex._ids=ids; ex._variant=0; ex._variantObs=null;
    S.openTransient=!!ex.opening;   /* 실행 모드가 "스위치를 여는 순간" 이 되는 예제 */
    if(ex.circuit.rail&&!S.railNotation){ var b=document.getElementById('vis-rail'); if(b) b.click(); }
    S.selectedId=null;
    /* 화면 맞춤 */
    var el=document.getElementById('canvas-container'), vt=S.viewTransform, cx=ex.circuit.center[0], cy=ex.circuit.center[1];
    vt.scale=1.4; vt.offsetX=el.clientWidth/2-cx*CELL_SIZE*vt.scale; vt.offsetY=el.clientHeight/2-cy*CELL_SIZE*vt.scale;
    App.Events.emit('viewport:changed');
    /* 관찰 전에는 값 숨김·배지 끔 */
    S.showBadges=false; S.showLabels=true;
    ['vis-badges','vis-labels'].forEach(function(id){ var b=document.getElementById(id); if(b) b.classList.toggle('active', id==='vis-labels'); });
    /* 전위 지형·전하 카운터·화살표는 관찰 단계에서 예제가 켠다 (ex.vis) */
    _setVis('potential',false); _setVis('charge',false); _setVis('arrows',false);
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
  function close(){ _panel.classList.remove('visible'); _open=false;
    if(App.State.openTransient){ App.State.openTransient=false; App.Solver.solveNow(); } }

  function h(tag,cls,text){ var e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; }
  function btn(text,cls,fn){ var b=h('button','poe-btn '+(cls||''),text); b.addEventListener('click',function(e){e.stopPropagation();fn();}); b.addEventListener('pointerdown',function(e){e.stopPropagation();}); return b; }

  function renderList(){
    _body.innerHTML='';
    _body.appendChild(h('div','poe-intro','예측 → 관찰 → 설명. 먼저 답을 고른 뒤에 회로를 돌립니다.'));
    var tabs=h('div','poe-tabs');
    CATS.forEach(function(ct){
      var n=EXAMPLES.filter(function(ex){return ex.cat===ct.id;}).length; if(!n) return;
      var done=_results.filter(function(r){ var ex=EXAMPLES.find(function(e){return e.id===r.id;}); return ex&&ex.cat===ct.id; }).length;
      var b=h('button','poe-tab'+(ct.id===_tab?' on':''), ct.label+' '+n+(done?' ✓':''));
      b.addEventListener('click',function(e){ e.stopPropagation(); _tab=ct.id; renderList(); });
      b.addEventListener('pointerdown',function(e){ e.stopPropagation(); });
      tabs.appendChild(b);
    });
    _body.appendChild(tabs);
    EXAMPLES.forEach(function(ex){
      if(ex.cat!==_tab) return;
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
    _cur=ex; _step=0; _picked=null; ex._truthPred=null; if(ex.cat) _tab=ex.cat;
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
      if(ex.variants) _body.appendChild(variantTable(ex,'observe'));
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
      if(ex.variants&&ex._variantObs) _body.appendChild(variantTable(ex,'result'));
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
    (ex.vis||[]).forEach(function(v){ _setVis(v,true); });
    if(ex.select&&ex._ids[ex.select]){ S.selectedId=ex._ids[ex.select]; App.PropPanel.show(S.selectedId); }
    if(ex.truth) ex._truthObs=truthObserve(ex);
    if(ex.variants) ex._variantObs=variantObserve(ex);
  }

  /* ── 변형 비교: 값을 바꾼 회로를 하나씩 풀어 측정값 표를 채운다 ──
   *   variants:[{label, set:{키:{value,value2,…}}}]  (첫 항목은 보통 기준 = set 없음)
   *   measure:{key, q:'i'|'v'|'ic'|'P'|'br', label} — 교류면 i 는 실효값, v 는 최댓값 */
  function variantObserve(ex){
    var S=App.State;
    return ex.variants.map(function(v){
      var comps=JSON.parse(JSON.stringify(S.components));
      _applySet(comps, ex, v.set);
      var sr=App.Solver.solve(comps, S.wires, {closed:true, noWave:true});
      return {label:v.label, text:_measureText(sr, ex, comps)};
    });
  }
  function _applySet(comps, ex, set){
    if(!set) return;
    Object.keys(set).forEach(function(k){
      var c=comps.find(function(x){return x.id===ex._ids[k];}); if(!c) return;
      Object.keys(set[k]).forEach(function(f){ c[f]=set[k][f]; });
    });
  }
  function _measureText(sr, ex, comps){
    var m=ex.measure, id=ex._ids[m.key]; if(!sr||!sr.valid||!id) return '—';
    var comp=comps.find(function(x){return x.id===id;});
    switch(m.q){
      case 'i': { var d=App.Post.display(sr,id); return _fmtA(sr.acPhasor?d.rms:d.dc)+(sr.acPhasor?' (RMS)':''); }
      case 'v': { var dv=App.Post.displayV(sr,id); return _fmtV(sr.acPhasor?dv.peak:dv.dc)+(sr.acPhasor?' (peak)':''); }
      case 'ic': { var o=sr.dc&&sr.dc.out&&sr.dc.out[id]; return o?_fmtA(o.iC)+(o.region?' · '+({cutoff:'차단',active:'활성',saturation:'포화'}[o.region]||o.region):''):'—'; }
      case 'P': return _fmtW(App.Post.avgPower(sr,id));
      case 'br': return (App.Post.bulbBrightness(sr,comp,null)*100).toFixed(0)+' %';
    }
    return '—';
  }
  function _fmtA(a){ var x=Math.abs(a||0); if(x<1e-12) return '0 A'; if(x<1e-3) return (a*1e6).toFixed(1)+' µA'; if(x<1) return (a*1e3).toFixed(1)+' mA'; return a.toFixed(3)+' A'; }
  function _fmtV(v){ var x=Math.abs(v||0); if(x<1e-9) return '0 V'; if(x<1) return (v*1e3).toFixed(1)+' mV'; return v.toFixed(2)+' V'; }
  function _fmtW(w){ var x=Math.abs(w||0); if(x<1e-3) return (w*1e6).toFixed(1)+' µW'; if(x<1) return (w*1e3).toFixed(1)+' mW'; return w.toFixed(2)+' W'; }
  /* 변형을 실제 회로에 적용 (관찰 중 표의 줄 클릭) */
  function applyVariant(ex, i){
    var S=App.State, v=ex.variants[i]; if(!v) return;
    /* 기준 값으로 되돌린 뒤 적용: 모든 변형이 건드리는 키를 원본 정의에서 복원 */
    var keys={}; ex.variants.forEach(function(vv){ Object.keys(vv.set||{}).forEach(function(k){ keys[k]=true; }); });
    Object.keys(keys).forEach(function(k){
      var def=ex.circuit.comps.find(function(c){return c.key===k;}), c=S.getComponent(ex._ids[k]); if(!def||!c) return;
      c.value=def.value; c.value2=def.value2;
    });
    _applySet(S.components, ex, v.set);
    ex._variant=i;
    App.Events.emit('state:changed'); App.Solver.solveNow(); App.PropPanel.refresh();
  }
  /* 변형 비교 표 (mode: observe = 줄 클릭으로 적용 | result = 보기만) */
  function variantTable(ex, mode){
    var tbl=h('table','poe-truth'), thead=h('tr');
    thead.appendChild(h('th','','경우')); thead.appendChild(h('th','',ex.measure.label||'측정값'));
    tbl.appendChild(thead);
    ex.variants.forEach(function(v,i){
      var tr=h('tr',(mode==='observe'?'click':'')+(ex._variant===i?' on':''));
      tr.appendChild(h('td','',v.label));
      tr.appendChild(h('td','poe-cell', ex._variantObs?ex._variantObs[i].text:'—'));
      if(mode==='observe'){
        tr.title='클릭하면 회로가 이 경우로 바뀝니다';
        tr.addEventListener('click',function(e){ e.stopPropagation(); applyVariant(ex,i); renderStep(); });
        tr.addEventListener('pointerdown',function(e){ e.stopPropagation(); });
      }
      tbl.appendChild(tr);
    });
    return tbl;
  }
  /* 시각화 토글(전위 지형·전하 카운터·화살표)을 원하는 상태로 — 툴바 버튼을 눌러 상태·버튼을 함께 맞춘다 */
  function _setVis(name,on){
    var prop={potential:'showPotential',charge:'showCharge',arrows:'showArrows'}[name]; if(!prop) return;
    if(!!App.State[prop]===!!on) return;
    var b=document.getElementById('vis-'+name); if(b) b.click(); else App.State[prop]=!!on;
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

  return{init:init, open:open, close:close, toggle:toggle, EXAMPLES:EXAMPLES, CATS:CATS, loadCircuit:loadCircuit, truthObserve:truthObserve,
         variantObserve:variantObserve, applyVariant:applyVariant, start:start, observe:observe, results:function(){return _results;}};
})();

}());
