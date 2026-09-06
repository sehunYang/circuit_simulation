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

  await b.close();
  let fail=0; R.forEach(x=>{ if(!x.ok) fail++; console.log((x.ok?'✓ ':'✗ ')+x.name+(x.ok?'':'   '+x.detail)); });
  console.log('─'.repeat(50)); console.log('검증 '+R.length+'건 / 실패 '+fail+'건'); process.exit(fail?1:0);
})();
