/* ════════════════════════════════════════════════════════════════════
 * 브라우저 단계 물리·표시 검증 (헤드리스 Chrome)
 *
 *   실행:  npm i --no-save puppeteer-core
 *          python -m http.server 8123      (저장소 루트, 다른 터미널)
 *          node tests/browser/run.js
 *
 *   검증 항목 — 기대값은 전부 닫힌형 공식:
 *     · 속성 패널 표시값: DC(I·V·P), C(Q=CV), L(Φ=LI, ½LI²),
 *       AC(피크·실효값·|Z|·역률 포함 평균전력), 혼합 DC+AC(실효값·평균전력)
 *     · 실행 모드: 전자 이동 방향 = 관례 전류의 반대 (DC·혼합), 입자 밀도 ∝ 전류
 *     · 비유 모드: HUD τ = RC·L/R, AC 회로 진입 차단
 *   (node tests/run-tests.js 는 솔버·과도응답 수치, 이 파일은 화면에 보이는 값)
 * ════════════════════════════════════════════════════════════════════ */
const L=require('./lib'); const C=require('./circuits');
const R=[]; function chk(name,ok,detail){R.push({name,ok:!!ok,detail:detail||''});}
function near(name,got,want,rtol,atol){const ok=typeof got==='number'&&isFinite(got)&&Math.abs(got-want)<=Math.max(atol||1e-9,(rtol||1e-3)*Math.abs(want));chk(name,ok,ok?'':`got=${got} want=${want}`);}
const SI={p:1e-12,n:1e-9,'µ':1e-6,u:1e-6,m:1e-3,k:1e3,'':1};
function val(s){ // "26.526 Ω" / "1.20 mC" / "120.000 mA" → SI 값
  const m=String(s).replace(/,/g,'').match(/(-?[\d.]+)\s*([pnµumk]?)/); if(!m) return NaN; return parseFloat(m[1])*(SI[m[2]]||1); }
async function rows(p){ return p.evaluate(()=>{const o={};document.querySelectorAll('#prop-content .pp-row').forEach(r=>{const k=r.children[0]&&r.children[0].textContent.trim();const v=r.children[1]&&r.children[1].textContent.trim();if(k)o[k]=v;});return o;}); }

/* canvas-anim 에서 특정 그리드 y행 근처의 비투명 픽셀 x-무게중심 (CSS px) */
async function electronX(p, gy, gx0, gx1){
  return p.evaluate((gy,gx0,gx1)=>{
    const cv=document.getElementById('canvas-anim'), ctx=cv.getContext('2d');
    const vt=window.App.State.viewTransform, dpr=window.devicePixelRatio||1;
    const y=(gy*CELL_SIZE*vt.scale+vt.offsetY)*dpr;
    const x0=(gx0*CELL_SIZE*vt.scale+vt.offsetX)*dpr, x1=(gx1*CELL_SIZE*vt.scale+vt.offsetX)*dpr;
    const w=Math.round(x1-x0), h=Math.round(12*dpr);
    const d=ctx.getImageData(Math.round(x0),Math.round(y-h/2),w,h).data;
    let sx=0,n=0; for(let i=0;i<d.length;i+=4){ if(d[i+3]>0){ sx+=(i/4)%w; n++; } }
    return n? (x0+sx/n)/dpr : null;
  },gy,gx0,gx1);
}
/* 행의 1D 알파 프로파일 (전자 여러 개여도 동작) */
async function rowProfile(p, gy, gx0, gx1){
  return p.evaluate((gy,gx0,gx1)=>{
    const cv=document.getElementById('canvas-anim'), ctx=cv.getContext('2d');
    const vt=window.App.State.viewTransform, dpr=window.devicePixelRatio||1;
    const y=(gy*CELL_SIZE*vt.scale+vt.offsetY)*dpr;
    const x0=(gx0*CELL_SIZE*vt.scale+vt.offsetX)*dpr, x1=(gx1*CELL_SIZE*vt.scale+vt.offsetX)*dpr;
    const w=Math.round(x1-x0), h=Math.round(12*dpr);
    const d=ctx.getImageData(Math.round(x0),Math.round(y-h/2),w,h).data;
    const prof=new Array(w).fill(0);
    for(let i=0;i<d.length;i+=4){ if(d[i+3]>0) prof[(i/4)%w]+=1; }
    return prof;
  },gy,gx0,gx1);
}
/* 연속 프로파일 간 최적 이동량(px)을 상호상관으로 추정 — 부호가 이동 방향 */
async function electronDir(p,gy,gx0,gx1){
  const profs=[]; for(let i=0;i<7;i++){ profs.push(await rowProfile(p,gy,gx0,gx1)); await L.sleep(45); }
  let sum=0,n=0;
  for(let i=1;i<profs.length;i++){
    const a=profs[i-1], b=profs[i], W=a.length; let best=0,bestC=-1;
    for(let s=-20;s<=20;s++){ let c=0; for(let x=Math.max(0,-s);x<Math.min(W,W-s);x++) c+=a[x]*b[x+s]; if(c>bestC){bestC=c;best=s;} }
    if(bestC>0){ sum+=best; n++; }
  }
  return n? sum/n : null;
}
async function blobCount(p){
  return p.evaluate(()=>{ /* 연결 성분 개수 = 전자 개수 */
    const cv=document.getElementById('canvas-anim'),c=cv.getContext('2d');const W=cv.width,H=cv.height;
    const d=c.getImageData(0,0,W,H).data; const seen=new Uint8Array(W*H); let n=0;
    for(let i=0;i<W*H;i++){ if(d[i*4+3]===0||seen[i])continue; n++; const st=[i]; seen[i]=1;
      while(st.length){const k=st.pop(),x=k%W,y=(k/W)|0; const nb=[[1,0],[-1,0],[0,1],[0,-1]];
        for(let q=0;q<4;q++){const nx=x+nb[q][0],ny=y+nb[q][1]; if(nx<0||ny<0||nx>=W||ny>=H)continue; const j=ny*W+nx; if(!seen[j]&&d[j*4+3]>0){seen[j]=1;st.push(j);}}}}
    return n; });
}

async function inkCount(p,sel,pred){ return p.evaluate((sel,predSrc)=>{const cv=document.querySelector(sel),c=cv.getContext('2d');const d=c.getImageData(0,0,cv.width,cv.height).data;const f=new Function('r','g','b','a','return '+predSrc);let n=0;for(let i=0;i<d.length;i+=4){if(f(d[i],d[i+1],d[i+2],d[i+3]))n++;}return n;},sel,pred); }
(async()=>{
  const b=await L.launch(); const p=await L.newPage(b,1100,690,1);
  p.on('pageerror',e=>chk('pageerror 없음',false,e.message));

  /* ── 1. 속성 패널: DC 직렬 2저항 ── */
  await L.build(p,C.div.comps,C.div.wires); await L.select(p,'r1');
  let r=await rows(p);
  near('DC R1 전류 40mA', val(r['전류']), 0.04, 1e-3);
  near('DC R1 전압강하 4V', val(r['전압강하']), 4, 1e-3);
  near('DC R1 소비전력 0.16W', val(r['소비전력']), 0.16, 1e-2);
  await L.select(p,'dc'); r=await rows(p);
  near('DC 전원 공급전력 0.48W', val(r['공급전력']), 0.48, 1e-2);

  /* ── 2. 속성 패널: 축전기 Q=CV, 인덕터 Φ·E ── */
  await L.build(p,C.rc.comps,C.rc.wires); await L.select(p,'c'); r=await rows(p);
  near('C 충전량 Q=CV=1.2mC', val(r['충전량 Q=CV']), 1.2e-3, 1e-2);
  await L.build(p,C.rl.comps,C.rl.wires); await L.select(p,'l'); r=await rows(p);
  near('L 전류 120mA', val(r['전류']), 0.12, 1e-3);
  near('L 자속 Φ=LI=1.2mWb', val(r['자속 Φ=LI']), 1.2e-3, 1e-2);
  near('L 자기에너지 ½LI²=72µJ', val(r['자기에너지 ½LI²']), 0.5*10e-3*0.12*0.12, 1e-2);

  /* ── 3. 속성 패널: AC (220V peak, 60Hz, R=100, C=20µF → 역률 0.60) ── */
  const acc=JSON.parse(JSON.stringify(C.ac)); acc.comps[2].value=20e-6;
  await L.build(p,acc.comps,acc.wires);
  const w=2*Math.PI*60, Xc=1/(w*20e-6), Z=Math.hypot(100,Xc), Ip=220/Z, Irms=Ip/Math.SQRT2;
  await L.select(p,'c'); r=await rows(p);
  near('AC C |Z_C|=1/ωC', val(r['|Z_C|=1/ωC']), Xc, 1e-3);
  near('AC C 전류(peak)', val(r['전류(peak)']), Ip, 1e-3);
  near('AC C 전류(RMS)=peak/√2', val(r['전류(RMS)']), Irms, 1e-3);
  near('AC C 전압(peak)=I·Xc', val(r['전압(peak)']), Ip*Xc, 1e-3);
  await L.select(p,'r'); r=await rows(p);
  near('AC R 소비전력(평균)=I_rms²R', val(r['소비전력(평균)']), Irms*Irms*100, 1e-2);
  await L.select(p,'ac'); r=await rows(p);
  near('AC 전원 공급전력(평균)=유효전력 I_rms²R (역률 반영)', val(r['공급전력(평균)']), Irms*Irms*100, 1e-2);
  near('AC 전원 전압(RMS)=220/√2', val(r['전압(RMS)']), 220/Math.SQRT2, 1e-3);

  /* ── 4. 속성 패널: 혼합 DC+AC (12V DC + 5V/60Hz AC 직렬, R=100) ── */
  await L.build(p,
    [{key:'dc',type:'DC_SOURCE',gx:48,gy:50,rot:90,value:12},
     {key:'ac',type:'AC_SOURCE',gx:50,gy:48,rot:0,value:5,value2:60},
     {key:'r', type:'RESISTOR', gx:52,gy:50,rot:90,value:100}],
    [['dc','L','ac','L','V-first'],['ac','R','r','L','H-first'],['r','R','dc','R','H-first']]);
  await L.select(p,'r'); r=await rows(p);
  near('혼합 R 전류(peak)=|I_dc|+|I_ac|=0.17A', val(r['전류(peak)']), 0.17, 1e-3);
  near('혼합 R 전류(RMS)=√(I_dc²+I_ac²/2)', val(r['전류(RMS)']), Math.sqrt(0.12*0.12+0.05*0.05/2), 1e-2);
  near('혼합 R 소비전력(평균)=I_dc²R+I_ac²R/2', val(r['소비전력(평균)']), 0.12*0.12*100+0.05*0.05*100/2, 1e-2);

  /* ── 5. 실행 모드: 전자 방향 = 관례 전류의 반대 (DC) ── */
  await L.build(p,C.div.comps,C.div.wires); await L.focus(p,51,50,1.5);
  await L.mode(p,'run'); await L.sleep(600);
  /* 아래쪽 도선(y=51, x 49→54): 관례 전류는 왼쪽(−x)으로 흐름 → 전자는 +x */
  let d=await electronDir(p,51,49,54);
  chk('DC 전자 이동 방향 = 관례 전류 반대 (+x)', d!=null&&d>0, 'dx/frame='+d);
  await L.mode(p,'edit');

  /* ── 6. 실행 모드: 혼합 DC+AC(DC 우세) 에서도 전자는 관례 전류 반대여야 함 ── */
  await L.build(p,
    [{key:'dc',type:'DC_SOURCE',gx:48,gy:50,rot:90,value:12},
     {key:'ac',type:'AC_SOURCE',gx:50,gy:48,rot:0,value:1,value2:1},
     {key:'r', type:'RESISTOR', gx:52,gy:48,rot:0,value:100}],
    [['dc','L','ac','L','V-first'],['ac','R','r','L','H-first'],['r','R','dc','R','V-first']]);
  await L.focus(p,51,50,1.5);
  await L.mode(p,'run'); await L.sleep(600);
  d=await electronDir(p,51,49,53);
  chk('혼합(DC 우세) 전자 이동 방향 = 관례 전류 반대 (+x)', d!=null&&d>0, 'dx/frame='+d);
  await L.mode(p,'edit');

  /* ── 7. 실행 모드: 입자 밀도가 전류를 반영하는가 (병렬 180/120/60mA) ── */
  await L.build(p,C.par.comps,C.par.wires); await L.focus(p,52,50.5,1.5);
  await L.mode(p,'run'); await L.sleep(800);
  const blobs=await blobCount(p);
  chk('병렬 회로 전자 개수 > 도선 수(8) — 전류 크기가 밀도에 반영', blobs>8, '전자 개수='+blobs);
  await L.mode(p,'edit');

  /* ── 7b. RL∥RC 병렬: 정상상태 RC 가지는 '0 A' 로 표기되어야 한다 (빈칸·'0.00 nA' 아님) ── */
  await L.build(p,
    [{key:'dc',type:'DC_SOURCE',gx:47,gy:50,rot:90,value:12},
     {key:'ja',type:'JUNCTION_3',gx:50,gy:49,rot:0,value:0},
     {key:'jb',type:'JUNCTION_3',gx:56,gy:49,rot:0,value:0},
     {key:'r1',type:'RESISTOR',gx:51,gy:48,rot:0,value:100},
     {key:'l', type:'INDUCTOR',gx:54,gy:48,rot:0,value:10e-3},
     {key:'r2',type:'RESISTOR',gx:51,gy:51,rot:0,value:200},
     {key:'c', type:'CAPACITOR',gx:54,gy:51,rot:0,value:100e-6}],
    [['dc','L','ja','L','V-first'],
     ['ja','R','r1','L','V-first'],['r1','R','l','L','H-first'],['l','R','jb','L','V-first'],
     ['ja','B','r2','L','V-first'],['r2','R','c','L','H-first'],['c','R','jb','B','H-first'],
     ['jb','R','dc','R','V-first']]);
  await L.select(p,'r2'); r=await rows(p);
  chk("RL∥RC: RC 가지 저항 전류 '0 A'", r['전류']==='0 A', r['전류']);
  await L.select(p,'c'); r=await rows(p);
  chk("RL∥RC: 축전기 전류 '0 A'", r['전류']==='0 A', r['전류']);
  await L.select(p,'l'); r=await rows(p);
  near('RL∥RC: 인덕터 전류 120mA', val(r['전류']), 0.12, 1e-3);
  /* 배지: 전류 0 인 도선에도 배지가 그려지는지 — canvas-main 에서 r2–c 사이 도선 아래(y≈51.8) 배지 픽셀 존재 */
  await L.focus(p,52,50,1.5);
  await p.evaluate(()=>{const S=window.App.State; if(!S.showBadges)document.getElementById('vis-badges').click();});
  await L.sleep(400);
  const badgePx=await p.evaluate(()=>{
    const cv=document.getElementById('canvas-main'),c=cv.getContext('2d'),vt=window.App.State.viewTransform,dpr=window.devicePixelRatio||1;
    const x0=(52.3*CELL_SIZE*vt.scale+vt.offsetX)*dpr, x1=(53.7*CELL_SIZE*vt.scale+vt.offsetX)*dpr;
    const y0=(51.6*CELL_SIZE*vt.scale+vt.offsetY)*dpr, y1=(52.1*CELL_SIZE*vt.scale+vt.offsetY)*dpr;
    const d=c.getImageData(Math.round(x0),Math.round(y0),Math.round(x1-x0),Math.round(y1-y0)).data;
    let n=0; for(let i=0;i<d.length;i+=4){ if(d[i]<80&&d[i+3]>0) n++; } return n; });
  chk('RL∥RC: 전류 0 인 RC 가지 도선에도 배지가 그려짐', badgePx>30, '잉크 픽셀='+badgePx);

  /* ── 8. 비유 모드: HUD τ = RC, AC 차단 ── */
  await L.build(p,C.rc.comps,C.rc.wires); await L.mode(p,'analogy'); await L.sleep(1200);
  const tau=await p.evaluate(()=>document.getElementById('analogy-hud-tau').textContent);
  chk('비유 HUD τ = 10.00ms (RC)', /10\.00\s*ms/.test(tau), tau);
  await L.mode(p,'edit');
  await L.build(p,C.rl.comps,C.rl.wires); await L.mode(p,'analogy'); await L.sleep(1200);
  const tau2=await p.evaluate(()=>document.getElementById('analogy-hud-tau').textContent);
  chk('비유 HUD τ = 100.0µs (RL)', /100\.0\s*µs/.test(tau2), tau2);
  await L.mode(p,'edit');
  await L.build(p,C.ac.comps,C.ac.wires); await L.mode(p,'analogy'); await L.sleep(400);
  const mode=await p.evaluate(()=>window.App.State.mode);
  chk('AC 회로는 비유 모드 진입 차단', mode!=='analogy', 'mode='+mode);

  /* ══ 스위치 · 열림/닫힘 · 회로이론 표기 (엔진 v2, A 단계) ══ */
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});

  /* 1. 팔레트 배치 경로로 전원 → 스위치 자동 생성 */
  const r1=await p.evaluate(()=>{
    const S=window.App.State; while(S.components.length) S.removeComponent(S.components[0].id);
    const item=SIDEBAR_ITEMS.find(i=>i.type==='DC_SOURCE');
    window.App.Main.addComponentCenter(item);
    const src=S.components.find(c=>c.type==='DC_SOURCE'), sw=S.components.find(c=>c.type==='SWITCH');
    return {n:S.components.length, hasSw:!!sw, autoFor:sw&&sw.autoFor===src.id, wires:S.wires.length,
            swPos: sw?[sw.gridX-src.gridX, sw.gridY-src.gridY]:null, blocked: sw? S.removeComponent(sw.id)===false : null,
            stillThere: !!S.components.find(c=>c.type==='SWITCH')};
  });
  chk('전원 배치 → 스위치 자동 생성·연결', r1.hasSw&&r1.autoFor&&r1.wires===1, JSON.stringify(r1));
  chk('자동 스위치는 단독 삭제 불가', r1.blocked===true&&r1.stillThere, JSON.stringify(r1));

  /* 2. 전원+스위치+저항 루프: 편집(열림) vs 실행(닫힘) */
  const r2=await p.evaluate(()=>{
    const S=window.App.State;
    const src=S.components.find(c=>c.type==='DC_SOURCE'), sw=S.components.find(c=>c.type==='SWITCH');
    /* 저항을 전원 오른쪽 아래에 두고 도선 2개로 루프 */
    const res={id:S.genId(),type:'RESISTOR',gridX:src.gridX+2,gridY:src.gridY+2,rotation:0,value:100,value2:null,label:''};
    S.addComponent(res);
    S.addWire({id:S.genId(),fromId:sw.id,fromPort:'L',toId:res.id,toPort:'L',direction:'V-first'});
    S.addWire({id:S.genId(),fromId:res.id,fromPort:'R',toId:src.id,toPort:'R',direction:'V-first'});
    window.__ids={src:src.id,sw:sw.id,res:res.id};
    const sr=window.App.Solver.solveNow();
    return {mode:S.mode, valid:sr.valid, err:sr.error, hasSw:sr.hasSwitches, closedFlag:sr.switchesClosed,
            Iopen:sr.branchCurrents[res.id], VswOpen:sr.componentVoltages[sw.id],
            Iclosed:sr.closed.branchCurrents[res.id], VswClosed:sr.closed.componentVoltages[sw.id]};
  });
  chk('편집 모드 = 열림: 저항 전류 0', r2.valid&&Math.abs(r2.Iopen)<1e-9, JSON.stringify(r2));
  chk('열린 스위치 양단 전압 = 기전력 12V', Math.abs(Math.abs(r2.VswOpen)-12)<1e-6, 'Vsw='+r2.VswOpen);
  chk('닫으면 뷰: 저항 전류 120mA', Math.abs(Math.abs(r2.Iclosed)-0.12)<1e-6, 'I='+r2.Iclosed);
  chk('닫힌 스위치 양단 전압 0', Math.abs(r2.VswClosed)<1e-6, 'V='+r2.VswClosed);

  /* 속성 패널 두 열 */
  await p.evaluate(()=>{const id=window.__ids.res; window.App.State.selectedId=id; window.App.PropPanel.show(id);});
  const panel=await p.evaluate(()=>document.getElementById('prop-content').textContent);
  chk("패널에 '열림(지금)'·'닫으면' 두 열", /열림\(지금\)/.test(panel)&&/닫으면/.test(panel)&&/120\.000 mA/.test(panel)&&/0 A/.test(panel), panel.slice(0,200));

  /* 실행 모드 → 닫힘 */
  await L.mode(p,'run'); await L.sleep(500);
  const r3=await p.evaluate(()=>{const sr=window.App.State.solverResult; return {mode:window.App.State.mode, I:sr.branchCurrents[window.__ids.res], closed:sr.switchesClosed};});
  chk('실행 모드 = 닫힘: 120mA', r3.closed&&Math.abs(Math.abs(r3.I)-0.12)<1e-6, JSON.stringify(r3));
  await L.mode(p,'edit'); await L.sleep(300);
  const r4=await p.evaluate(()=>{const sr=window.App.State.solverResult; return {closed:sr.switchesClosed, I:sr.branchCurrents[window.__ids.res]};});
  chk('편집 복귀 = 열림', r4.closed===false&&Math.abs(r4.I)<1e-9, JSON.stringify(r4));

  /* 3. 전원 삭제 → 스위치 함께 삭제 */
  const r5=await p.evaluate(()=>{const S=window.App.State; S.removeComponent(window.__ids.src); return S.components.map(c=>c.type);});
  chk('전원 삭제 시 자동 스위치도 삭제', r5.indexOf('SWITCH')<0&&r5.indexOf('DC_SOURCE')<0, JSON.stringify(r5));

  /* 4. 회로이론 표기: 루프를 닫지 않고 접지·레일로 */
  const r6=await p.evaluate(()=>{
    const S=window.App.State; while(S.components.length) S.removeComponent(S.components[0].id);
    const add=(type,gx,gy,rot,value,label)=>{const c={id:S.genId(),type,gridX:gx,gridY:gy,rotation:rot||0,value:value||0,value2:null,label:label||''}; S.addComponent(c); return c;};
    /* 전원: 위 = VCC 라벨, 아래 = 접지 (닫힌 루프 없음) */
    const src=add('DC_SOURCE',48,50,90,12);
    const lab1=add('LABEL',48,48,0,0,'VCC');      /* 포트 B at (48.5,49) ← 전원 T port at (48.5,50)? 도선으로 연결 */
    const gnd1=add('GROUND',48,52,0,0);
    const lab2=add('LABEL',54,48,0,0,'VCC');
    const res=add('RESISTOR',54,50,90,100);
    const gnd2=add('GROUND',54,52,0,0);
    S.addWire({id:S.genId(),fromId:lab1.id,fromPort:'B',toId:src.id,toPort:'L',direction:'V-first'});
    S.addWire({id:S.genId(),fromId:src.id,fromPort:'R',toId:gnd1.id,toPort:'T',direction:'V-first'});
    S.addWire({id:S.genId(),fromId:lab2.id,fromPort:'B',toId:res.id,toPort:'L',direction:'V-first'});
    S.addWire({id:S.genId(),fromId:res.id,fromPort:'R',toId:gnd2.id,toPort:'T',direction:'V-first'});
    const sr=window.App.Solver.solveNow();
    window.__ids={res:res.id};
    return {valid:sr.valid, err:sr.error, I:sr.branchCurrents[res.id], V:sr.componentVoltages[res.id], warn:sr.warnings};
  });
  chk('레일 표기: VCC–R–GND 가 전원 VCC–GND 와 같은 노드로 풀림 (120mA)', r6.valid&&Math.abs(Math.abs(r6.I)-0.12)<1e-6, JSON.stringify(r6));

  /* 촬영 · 비유 모드 · 실행 모드 콘솔 오류 없음 */
  await p.evaluate(()=>window.App.Capture.buildSceneCanvas(1).toDataURL().length);
  await L.mode(p,'run'); await L.sleep(400); await L.mode(p,'analogy'); await L.sleep(1500); await L.mode(p,'edit');
  await p.evaluate(()=>{document.getElementById('vis-rail').click();});
  const railVisible=await p.evaluate(()=>getComputedStyle(document.getElementById('sidebar-item-GROUND')).display);
  chk('표기 토글 → 접지 팔레트 항목 표시', railVisible!=='none', railVisible);
  chk('콘솔·페이지 오류 없음', errs.length===0, errs.slice(0,3).join(' | '));

  /* ══ B 단계: 그룹 선택 팝업 · 전구 광량 · 다이오드/BJT 패널 ══ */
  /* 1. R 그룹 버튼 클릭 → 팝업 → '전구' 선택 → 중앙 배치 */
  const bc1=await p.evaluate(()=>{const S=window.App.State; while(S.components.length) S.removeComponent(S.components[0].id);
    const r=document.getElementById('sidebar-item-R').getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2];});
  await p.mouse.click(bc1[0],bc1[1]); await L.sleep(150);
  const b1=await p.evaluate(async()=>{
    const S=window.App.State;
    const pop=document.getElementById('sb-picker');
    const opts=pop?Array.from(pop.querySelectorAll('.sb-pick')).map(x=>x.textContent):null;
    if(pop) pop.querySelectorAll('.sb-pick')[1].click();   /* 전구 */
    await new Promise(r=>setTimeout(r,50));
    return {popup:!!pop, opts, placed:S.components.map(c=>c.type), label:document.querySelector('#sidebar-item-R .s-label').textContent};
  });
  chk('R 버튼 클릭 → 저항/전구 선택 팝업', b1.popup&&b1.opts&&b1.opts.length===2, JSON.stringify(b1));
  chk('전구 선택 → 배치 + 버튼 라벨 갱신', b1.placed.indexOf('BULB')>=0&&b1.label==='전구', JSON.stringify(b1));

  /* 2. 반도체 그룹 팝업 옵션 3개 */
  const bc2=await p.evaluate(()=>{const r=document.getElementById('sidebar-item-SEMI').getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2];});
  await p.mouse.click(bc2[0],bc2[1]); await L.sleep(150);
  const b2=await p.evaluate(async()=>{
    const pop=document.getElementById('sb-picker');
    const opts=pop?Array.from(pop.querySelectorAll('.sb-pick')).map(x=>x.textContent):null;
    if(pop) pop.remove();
    return opts;
  });
  chk('반도체 버튼 → 다이오드/npn/pnp 3개', b2&&b2.length===3, JSON.stringify(b2));

  /* 3. 전구 회로: 12V + 스위치(자동) + 전구 100Ω/1W → 실행 모드에서 광량 픽셀 */
  await L.build(p,
    [{key:'dc',type:'DC_SOURCE',gx:48,gy:50,rot:90,value:12},
     {key:'b', type:'BULB',gx:51,gy:48,rot:0,value:100,value2:1}],
    [['dc','L','b','L','V-first'],['b','R','dc','R','V-first']]);
  await L.focus(p,50,50,1.7);
  await L.mode(p,'run'); await L.sleep(400);
  const glow=await p.evaluate(()=>{
    const cv=document.getElementById('canvas-main'),c=cv.getContext('2d'),vt=window.App.State.viewTransform,dpr=window.devicePixelRatio||1;
    const x=(51.5*CELL_SIZE*vt.scale+vt.offsetX)*dpr, y=(48.5*CELL_SIZE*vt.scale+vt.offsetY)*dpr;
    const d=c.getImageData(Math.round(x-14*dpr),Math.round(y-14*dpr),Math.round(28*dpr),Math.round(28*dpr)).data;
    let warm=0; for(let i=0;i<d.length;i+=4){ if(d[i+3]>0&&d[i]>200&&d[i+2]<150) warm++; } return warm;
  });
  chk('실행 모드 전구 광량(노란 픽셀) 존재', glow>50, 'warm px='+glow);
  await L.select(p,'b');
  const panelB=await p.evaluate(()=>document.getElementById('prop-content').textContent);
  chk("전구 패널: 소비전력 1.44W · 밝기 144 %", /1\.44 W/.test(panelB)&&/144 %/.test(panelB), panelB.slice(0,160));
  await L.mode(p,'edit');

  /* 4. 다이오드 + BJT 회로 패널 · 촬영 */
  await L.build(p,
    [{key:'dc',type:'DC_SOURCE',gx:46,gy:50,rot:90,value:12},
     {key:'rb',type:'RESISTOR',gx:48,gy:47,rot:0,value:10000},
     {key:'d', type:'DIODE',gx:50,gy:47,rot:0,value:0},
     {key:'q', type:'NPN',gx:52,gy:49,rot:0,value:100},
     {key:'rc',type:'RESISTOR',gx:52,gy:47,rot:90,value:1000},
     {key:'ja',type:'JUNCTION_3',gx:47,gy:47,rot:0,value:0}],
    [['dc','L','ja','L','V-first'],['ja','R','rb','L','H-first'],['rb','R','d','L','H-first'],['d','R','q','L','H-first'],
     ['ja','B','rc','L','V-first'],['rc','R','q','T','H-first'],['q','B','dc','R','V-first']]);
  await L.focus(p,49.5,49,1.6);
  await L.mode(p,'run'); await L.sleep(300);
  await L.select(p,'q'); const panelQ=await p.evaluate(()=>document.getElementById('prop-content').textContent);
  chk('BJT 패널: 동작 영역 배지(포화) · I_C', /포화/.test(panelQ)&&/I_C/.test(panelQ), panelQ.slice(0,200));
  await L.select(p,'d'); const panelD=await p.evaluate(()=>document.getElementById('prop-content').textContent);
  chk('다이오드 패널: 순방향 도통', /순방향 도통/.test(panelD), panelD.slice(0,160));
  await L.mode(p,'edit');   /* 다음 블록이 모드 전환을 다시 하도록 편집으로 복귀 */
  /* ══ D 단계: 파형 재생 · 오실로스코프 · 그래프 커서 · 비유 모드 파형 ══ */
  /* 1. RC 과도 재생: 전자가 처음엔 많고(120mA) 8초 뒤엔 사라짐(0mA) */
  await L.build(p,C.rc.comps,C.rc.wires); await L.focus(p,51,50.5,1.6);
  await L.mode(p,'run'); await L.sleep(300);
  const early=await inkCount(p,'#canvas-anim','a>0');
  const info=await p.evaluate(()=>{const sr=window.App.State.solverResult; return {wave:!!sr.wave, tMax:sr.wave&&sr.wave.tMax, poles:sr.poles&&sr.poles.taus};});
  chk('RC 실행: wave 존재, tMax=5τ=50ms', info.wave&&Math.abs(info.tMax-0.05)<1e-6, JSON.stringify(info));
  /* 그래프 커서(주황 점선) 존재 — 그래프가 그려지고 커서가 얹힐 때까지 잠깐 */
  await L.sleep(700);
  const cursor=await inkCount(p,'#transient-canvas','r>150&&g<170&&b<120&&(r-b)>60&&a>100');
  chk('과도 그래프에 시간 커서(주황) 표시', cursor>10, 'px='+cursor);
  await L.sleep(9000);
  const late=await inkCount(p,'#canvas-anim','a>0');
  chk('RC 실행: 충전이 끝나면 전자 이동 사라짐 (초기 '+early+' → 말기 '+late+')', early>50&&late<early*0.3, 'early='+early+' late='+late);
    await L.mode(p,'edit');

  /* 2. 반파 정류 + 평활 축전기: 실행 모드에서 오실로스코프 표시 */
  await L.build(p,
    [{key:'ac',type:'AC_SOURCE',gx:47,gy:50,rot:90,value:10,value2:60},
     {key:'d', type:'DIODE',gx:49,gy:48,rot:0,value:0},
     {key:'ja',type:'JUNCTION_3',gx:51,gy:48,rot:0,value:0},
     {key:'r', type:'RESISTOR',gx:53,gy:50,rot:90,value:1000},
     {key:'c', type:'CAPACITOR',gx:51,gy:50,rot:90,value:100e-6},
     {key:'jb',type:'JUNCTION_3',gx:51,gy:52,rot:180,value:0}],
    [['ac','L','d','L','V-first'],['d','R','ja','L','H-first'],['ja','R','r','L','H-first'],['ja','B','c','L','H-first'],
     ['c','R','jb','B','H-first'],['r','R','jb','L','V-first'],['jb','R','ac','R','V-first']]);
  await L.focus(p,50,50,1.5);
  await L.mode(p,'run'); await L.sleep(800);
  const scopeVis=await p.evaluate(()=>document.getElementById('scope-panel').classList.contains('visible'));
  chk('정류 회로 실행 → 오실로스코프 패널 표시', scopeVis, 'visible='+scopeVis);
  const scopeInk=await inkCount(p,'#scope-canvas','(r<100&&g<120&&b>150&&a>0)||(r>150&&g<120&&b<60&&a>0)');
  chk('오실로스코프에 파형 픽셀', scopeInk>200, 'px='+scopeInk);
  await L.select(p,'r');
  const panelR=await p.evaluate(()=>document.getElementById('prop-content').textContent);
  chk('정류 저항 패널: 전압(평균)·전류(평균) 행 (파형 통계)', /전압\(평균\)/.test(panelR)&&/전류\(평균\)/.test(panelR), panelR.slice(0,220));
  const stats=await p.evaluate(()=>{const sr=window.App.State.solverResult; const r=window.App.State.components.find(c=>c.type==='RESISTOR'); return window.App.Post.waveStats(sr,r.id);});
  chk('평활 후 저항 전압 평균 > 반파 평균 (V_p−V_F)/π=3V', stats&&stats.v.avg>5, JSON.stringify(stats&&stats.v));
    await L.mode(p,'edit');

  /* 3. 비유 모드 RLC (R=5): 파형 연결, HUD τ, 오류 없음 */
  const rlc=JSON.parse(JSON.stringify(C.rlc)); rlc.comps[1].value=5;
  await L.build(p,rlc.comps,rlc.wires); await L.mode(p,'analogy'); await L.sleep(1500);
  await p.evaluate(()=>document.getElementById('analogy-play-btn').click()); await L.sleep(2500);
  const hud=await p.evaluate(()=>({t:document.getElementById('analogy-hud-t').textContent,tau:document.getElementById('analogy-hud-tau').textContent}));
  chk('비유 RLC: HUD τ = 4.00ms (정확 극점 1/α, α=250)', /4\.00\s*ms/.test(hud.tau), JSON.stringify(hud));
  await p.mouse.move(600,340); for(let i=0;i<2;i++){ await p.mouse.wheel({deltaY:-100}); await L.sleep(200); }
  await L.sleep(300);
  await L.mode(p,'edit');

  /* ══ E 단계: POE · 진리표 · 공유 링크 · 전위 지형 · 전하 카운터 · 스위치 토글 ══ */
  /* 1. POE 예제 전부: 회로 로드 → 유효 해석 / 진리표 예제는 관찰값 = 기대값 */
  const poeE=await p.evaluate(()=>{
    const P=window.App.POE, out=[];
    P.EXAMPLES.forEach(ex=>{
      P.loadCircuit(ex);
      const sr=window.App.Solver.solve(window.App.State.components, window.App.State.wires, {closed:true, noWave:true});
      const row={id:ex.id, valid:sr.valid, err:sr.error, warn:(sr.warnings||[]).length};
      if(ex.truth){ const rows=P.truthObserve(ex); row.truth=rows.map(r=>r.inp.join('')+':'+r.out+'/'+r.expect); row.truthOK=rows.every(r=>r.out===r.expect); }
      out.push(row);
    });
    return out;
  });
  poeE.forEach(r=>{ chk('POE '+r.id+': 회로 유효'+(r.warn?' (경고 '+r.warn+')':''), r.valid, r.err||''); if(r.truth) chk('POE '+r.id+': 진리표 관찰 = 기대 '+r.truth.join(' '), r.truthOK); });

  /* 2. POE 흐름: 밝기 예제 시작 → 예측 → 관찰(실행 모드) → 설명 → 결과 기록 */
  const flowE=await p.evaluate(async()=>{
    const P=window.App.POE; P.open(); P.start(P.EXAMPLES[0]);
    const body=document.getElementById('poe-body');
    const opts=body.querySelectorAll('.poe-opt'); opts[1].click();   /* 오답 선택 (A=B=C) */
    await new Promise(r=>setTimeout(r,50));
    body.querySelector('.poe-primary').click();   /* 관찰하기 */
    await new Promise(r=>setTimeout(r,300));
    const mode=window.App.State.mode, badges=window.App.State.showBadges;
    body.querySelector('.poe-primary').click();   /* 설명 보기 */
    await new Promise(r=>setTimeout(r,50));
    const verdict=body.querySelector('.poe-verdict')&&body.querySelector('.poe-verdict').textContent;
    const tag=body.querySelector('.poe-tag')&&body.querySelector('.poe-tag').textContent;
    const res=P.results();
    return {mode, badges, verdict, tag, n:res.length, correct:res[0]&&res[0].correct};
  });
  chk('POE 흐름: 관찰 = 실행 모드 + 배지 ON', flowE.mode==='run'&&flowE.badges, JSON.stringify(flowE));
  chk('POE 흐름: 오답 → 판정·오개념 태그·기록', /다릅니다/.test(flowE.verdict||'')&&/전류/.test(flowE.tag||'')&&flowE.n===1&&flowE.correct===false, JSON.stringify(flowE));
  await L.mode(p,'edit');

  /* 3. 공유 링크 왕복 */
  const shareE=await p.evaluate(()=>{
    const S=window.App.State, Sh=window.App.Share;
    const before={n:S.components.length, w:S.wires.length, types:S.components.map(c=>c.type).sort().join(',')};
    const enc=Sh.encode(); const dec=Sh.decode(enc);
    Sh.load(dec);
    const afterE={n:S.components.length, w:S.wires.length, types:S.components.map(c=>c.type).sort().join(',')};
    const sr=window.App.Solver.solve(S.components,S.wires,{closed:true,noWave:true});
    return {before, afterE, len:enc.length, valid:sr.valid, url:Sh.toURL().slice(0,40)};
  });
  chk('공유 링크: 인코딩→디코딩 후 소자·도선 수·종류 동일, 해석 유효', shareE.before.n===shareE.afterE.n&&shareE.before.w===shareE.afterE.w&&shareE.before.types===shareE.afterE.types&&shareE.valid, JSON.stringify(shareE));

  /* 4. 전위 지형: 직렬 2저항 → 도선 색 (파랑·빨강 계열 픽셀) + 전위 텍스트 */
  await L.build(p,C.div.comps,C.div.wires); await L.focus(p,51,50,1.6);
  await p.evaluate(()=>{ if(!window.App.State.showPotential) document.getElementById('vis-potential').click(); });
  await L.sleep(300);
  const potPxE=await inkCount(p,'#canvas-main','a>0&&((b>150&&r<100)||(r>150&&b<100&&g<120))');
  chk('전위 지형: 색칠된 도선 픽셀', potPxE>200, 'px='+potPxE);
    await p.evaluate(()=>{ document.getElementById('vis-potential').click(); });

  /* 5. 전하 카운터 + 실행 모드 스위치 토글 (병렬 추가 예제 회로) */
  await p.evaluate(()=>{ const P=window.App.POE; P.loadCircuit(P.EXAMPLES[1]); if(!window.App.State.showCharge) document.getElementById('vis-charge').click(); });
  await L.mode(p,'run'); await L.sleep(1200);
  const q1E=await inkCount(p,'#canvas-anim','r<60&&g<100&&b>150&&a>0');   /* 파란 Q 글자 */
  chk('전하 카운터 표시 (파란 텍스트 픽셀)', q1E>30, 'px='+q1E);
  const togE=await p.evaluate(async()=>{
    const S=window.App.State; const sw=S.components.find(c=>c.type==='SWITCH'&&c.on===false);
    const gp=window.App.Geo.gridToPixel(sw.gridX,sw.gridY); const cp=CELL_SIZE*S.viewTransform.scale;
    const rect=document.getElementById('canvas-main').getBoundingClientRect();
    return {x:rect.left+gp.x+cp/2, y:rect.top+gp.y+cp/2, id:sw.id, srcI:Math.abs(S.solverResult.branchCurrents[S.components.find(c=>c.type==='DC_SOURCE').id])};
  });
  await p.mouse.click(togE.x,togE.y); await L.sleep(400);
  const afterE=await p.evaluate((id)=>{const S=window.App.State; const sw=S.getComponent(id); return {on:sw.on, srcI:Math.abs(S.solverResult.branchCurrents[S.components.find(c=>c.type==='DC_SOURCE').id])};}, togE.id);
  chk('실행 모드에서 스위치 클릭 → 닫힘, 전지 전류 2배 (120→240mA)', afterE.on===true&&Math.abs(togE.srcI-0.12)<1e-3&&Math.abs(afterE.srcI-0.24)<1e-3, JSON.stringify({before:togE.srcI, afterE}));
    await L.mode(p,'edit');

  /* ══ 후속 수정 (사용자 보고 3건) ══ */
  /* 1. 편집 모드 속성 패널의 스위치 열기/닫기 버튼 — 자동 스위치를 닫으면 편집 중에도 닫힌 회로 */
  await p.evaluate(()=>{
    const S=window.App.State; while(S.components.length) S.removeComponent(S.components[0].id);
    window.App.Main.addComponentCenter(SIDEBAR_ITEMS.find(i=>i.type==='DC_SOURCE'));   /* 전원 + 자동 스위치 */
    const src=S.components.find(c=>c.type==='DC_SOURCE'), sw=S.components.find(c=>c.type==='SWITCH');
    const res={id:S.genId(),type:'RESISTOR',gridX:src.gridX+2,gridY:src.gridY+2,rotation:0,value:200,value2:null,label:''};
    S.addComponent(res);
    S.addWire({id:S.genId(),fromId:sw.id,fromPort:'L',toId:res.id,toPort:'L',direction:'V-first'});
    S.addWire({id:S.genId(),fromId:res.id,fromPort:'R',toId:src.id,toPort:'R',direction:'V-first'});
    window.App.Events.emit('state:changed'); window.App.Solver.solveNow();
  });
  await L.sleep(300);
  const swF=await p.evaluate(async()=>{
    const S=window.App.State, sw=S.components.find(c=>c.type==='SWITCH'), R=S.components.find(c=>c.type==='RESISTOR');
    S.selectedId=sw.id; window.App.PropPanel.show(sw.id);
    const txt=()=>document.getElementById('prop-content').textContent;
    const btnOf=(re)=>[...document.querySelectorAll('#prop-content button')].find(b=>re.test(b.textContent));
    const before={mode:S.mode, on:sw.on, two:/닫으면/.test(txt()), btn:!!btnOf(/열림 → 닫기/), I:Math.abs(S.solverResult.branchCurrents[R.id]||0)};
    btnOf(/열림 → 닫기/).click(); await new Promise(r=>setTimeout(r,250));
    const closed={on:sw.on, two:/닫으면/.test(txt()), I:Math.abs(S.solverResult.branchCurrents[R.id]||0), btn:!!btnOf(/닫힘 → 열기/), auto:!!btnOf(/^자동$/)};
    btnOf(/^자동$/).click(); await new Promise(r=>setTimeout(r,250));
    const reset={on:sw.on, two:/닫으면/.test(txt()), I:Math.abs(S.solverResult.branchCurrents[R.id]||0)};
    return {before, closed, reset};
  });
  chk('편집 패널: 자동 스위치 = 열림, "열림 → 닫기" 버튼과 열림/닫으면 두 열', swF.before.mode==='edit'&&swF.before.on==null&&swF.before.btn&&swF.before.two&&swF.before.I<1e-9, JSON.stringify(swF.before));
  chk('편집 패널: 닫기 → 편집 중에도 닫힌 회로 60mA, 단일 열, "닫힘 → 열기"+"자동"', swF.closed.on===true&&!swF.closed.two&&Math.abs(swF.closed.I-0.06)<1e-4&&swF.closed.btn&&swF.closed.auto, JSON.stringify(swF.closed));
  chk('편집 패널: 자동 → 다시 열림 (0 mA, 두 열)', swF.reset.on==null&&swF.reset.two&&swF.reset.I<1e-9, JSON.stringify(swF.reset));

  /* 2. VCC 라벨에 전위 → 접지 기준 전원 (전지 없이) */
  await L.build(p, [{key:'vcc',type:'LABEL',gx:50,gy:48,rot:0,value:5,label:'VCC'},
                    {key:'r',type:'RESISTOR',gx:50,gy:50,rot:90,value:1000},
                    {key:'g',type:'GROUND',gx:50,gy:52,rot:0,value:0}],
                   [['vcc','B','r','L','V-first'],['r','R','g','T','V-first']]);
  await L.select(p,'vcc');
  const railF=await rows(p);
  const railV=await p.evaluate(()=>{ const S=window.App.State, sr=S.solverResult; return {valid:sr.valid, err:sr.error, I:Math.abs(sr.branchCurrents[window.__ids.r]||0), warn:(sr.warnings||[]).length, txt:document.getElementById('prop-content').textContent}; });
  chk('VCC 5V 라벨 + R 1k + GND: 전지 없이 유효, 5 mA, 경고 없음', railV.valid&&Math.abs(railV.I-0.005)<1e-6&&railV.warn===0, JSON.stringify({valid:railV.valid,err:railV.err,I:railV.I,warn:railV.warn}));
  chk('라벨 패널: 전위 필드 5.0 V · 전위 5 V · 공급 전류 5 mA', /5\.0 V/.test(railF['전위 (V)']||'')&&/5\.0000 V/.test(railF['전위']||'')&&/5\.000 mA/.test(railF['공급 전류']||''), JSON.stringify(railF));

  /* 3. POE 진리표 예제: 예측 칸 클릭으로 채우고 관찰 단계로 진행 */
  const truthF=await p.evaluate(async()=>{
    const P=window.App.POE; P.open(); const ex=P.EXAMPLES.find(e=>e.id==='not'); P.start(ex);
    const body=document.getElementById('poe-body');
    const go=()=>[...body.querySelectorAll('.poe-primary')].find(b=>/관찰하기/.test(b.textContent));
    go().click(); await new Promise(r=>setTimeout(r,100));
    const blocked=!!go();                                   /* 아직 예측 단계 */
    const cells=()=>body.querySelectorAll('td.poe-cell.click');
    const n0=cells().length;
    cells()[0].click(); await new Promise(r=>setTimeout(r,50));      /* ? → 1 */
    cells()[1].click(); await new Promise(r=>setTimeout(r,50));      /* ? → 1 */
    cells()[1].click(); await new Promise(r=>setTimeout(r,50));      /* 1 → 0 */
    const pred=[...cells()].map(td=>td.textContent);
    go().click(); await new Promise(r=>setTimeout(r,400));
    const observed=[...body.querySelectorAll('tr')].slice(1).map(tr=>[...tr.children].map(td=>td.textContent).join(''));
    const step1=!go()&&!!body.querySelector('.poe-primary');
    const explain=[...body.querySelectorAll('.poe-primary')].find(b=>/설명 보기/.test(b.textContent)); explain.click(); await new Promise(r=>setTimeout(r,50));
    const verdict=body.querySelector('.poe-verdict')&&body.querySelector('.poe-verdict').textContent;
    return {blocked, n0, pred, observed, step1, mode:window.App.State.mode, verdict};
  });
  chk('POE NOT: 빈 진리표로는 관찰 단계로 못 넘어감, 예측 칸 2개 클릭 가능', truthF.blocked&&truthF.n0===2, JSON.stringify(truthF));
  chk('POE NOT: 클릭으로 예측 1·0 채움 → 관찰 단계(실행 모드) 진입, 관찰 칸 채워짐', truthF.pred.join('')==='10'&&truthF.step1&&truthF.mode==='run'&&truthF.observed.join('|')==='011|100', JSON.stringify(truthF));
  chk('POE NOT: 예측 = 관찰 → "맞았습니다"', /맞았습니다/.test(truthF.verdict||''), truthF.verdict||'');
  await p.evaluate(()=>{ window.App.POE.close&&window.App.POE.close(); });
    await L.mode(p,'edit');

  await b.close();
  let fail=0; R.forEach(x=>{ if(!x.ok) fail++; console.log((x.ok?'✓ ':'✗ ')+x.name+(x.ok?'':'   '+x.detail)); });
  console.log('─'.repeat(50)); console.log('검증 '+R.length+'건 / 실패 '+fail+'건'); process.exit(fail?1:0);
})();
