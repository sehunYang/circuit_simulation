(function(){
'use strict';
var App=window.App;
App.Analysis=App.Analysis||{};

/* ════════════════════════════════════════════════════════════════════
 * App.Analysis.poles — 선형 회로의 극점 (정확한 τ·α·ω_d)
 *
 *   상태 = 축전기 전압 v_C, 인덕터 전류 i_L.  전원을 0 으로 두고
 *     dv_C/dt = i_C / C,   di_L/dt = v_L / L
 *   에서 i_C·v_L 은 저항 회로망의 선형 응답이므로, 상태 하나만 1 로 두고
 *   나머지를 0 으로 둔 해석을 상태 수만큼 돌려 상태행렬 A 를 얻는다
 *   (축전기 = 전압원 v_C, 인덕터 = 전류원 i_L 로 스탬프).
 *   A 의 고유값 = 극점. 특성다항식(Faddeev–LeVerrier) → Durand–Kerner 근.
 *   상호유도가 있으면 인덕터 상태식은 [L]·di/dt = v (L 행렬: 대각 L, 짝끼리 M) —
 *   [L] 을 풀어 di/dt 를 얻는다.
 *
 *   반환 null(상태 없음·비선형) 또는
 *   { poles:[{re,im}], taus:[τ…](실근), alpha, omegaD, isOsc, domTau, order }
 * ════════════════════════════════════════════════════════════════════ */
App.Analysis.poles=function(nl, devs){
  var MNA=App.MNA, D=App.Devices;
  if(devs.some(function(d){return !d.linear;})) return null;
  var caps=devs.filter(function(d){return d.type===TYPE.CAPACITOR;});
  var inds=devs.filter(function(d){return d.type===TYPE.INDUCTOR;});
  var n=caps.length+inds.length;
  if(n===0) return null;
  var statics=devs.filter(function(d){return d.type!==TYPE.CAPACITOR&&d.type!==TYPE.INDUCTOR;});
  var N0=MNA.layout(nl.nodeCount, statics);
  var N=N0+caps.length;
  var nNode=nl.nodeCount-1;

  function response(state){   /* state: 길이 n 의 [v_C…, i_L…] → [i_C/C…, v_L/L…] */
    function assemble(gmin,rser){
      var sys=MNA.makeSystem(N,false);
      var ctx={mode:'op', rser:rser, zeroSources:true};
      for(var i=0;i<statics.length;i++) statics[i].loadOP(sys, new Float64Array(N), ctx);
      caps.forEach(function(c,j){
        var k=N0+j;
        sys.add(c.i0,k,1); sys.add(c.i1,k,-1); sys.add(k,c.i0,1); sys.add(k,c.i1,-1);
        sys.rhs(k, state[j]);
      });
      inds.forEach(function(l,j){ sys.stampI(l.i0,l.i1, state[caps.length+j]); });
      MNA.stampPins(sys, nl);
      if(gmin>0) for(var q=0;q<nNode;q++) sys.add(q,q,gmin);
      return MNA.solve(sys);
    }
    var x=assemble(0,0)||assemble(1e-9,0)||assemble(1e-9,1e-4);
    if(!x) return null;
    var out=new Array(n);
    caps.forEach(function(c,j){ var C=c.comp.value>0?c.comp.value:1e-12; out[j]=x[N0+j]/C; });
    var vL=inds.map(function(l){ return D.V(x,l.i0)-D.V(x,l.i1); });
    if(inds.some(function(l){return !!l.partner;})){
      /* [L]·di/dt = v_L */
      var m=inds.length, Lm=[]; for(var a=0;a<m;a++) Lm.push(new Float64Array(m));
      inds.forEach(function(l,j){ Lm[j][j]=l.comp.value>0?l.comp.value:1e-12;
        if(l.partner){ var pj=inds.indexOf(l.partner); if(pj>=0) Lm[j][pj]=l.M; } });
      var di=MNA.solveReal(Lm, Float64Array.from(vL)); if(!di) return null;
      inds.forEach(function(l,j){ out[caps.length+j]=di[j]; });
    } else {
      inds.forEach(function(l,j){ var L=l.comp.value>0?l.comp.value:1e-12; out[caps.length+j]=vL[j]/L; });
    }
    return out;
  }

  /* A[i][j] = 상태 j 단위 입력에 대한 d(state_i)/dt */
  var A=[]; for(var i=0;i<n;i++) A.push(new Float64Array(n));
  for(var j=0;j<n;j++){
    var e=new Float64Array(n); e[j]=1;
    var col=response(e); if(!col) return null;
    for(var i2=0;i2<n;i2++) A[i2][j]=col[i2];
  }

  /* 특성다항식 계수 (Faddeev–LeVerrier): λ^n + c1 λ^{n-1} + … + cn */
  var M=[]; for(var a=0;a<n;a++){ M.push(new Float64Array(n)); }
  var coef=[1];
  var Mk=[]; for(var a2=0;a2<n;a2++){ Mk.push(new Float64Array(n)); Mk[a2][a2]=1; }   /* M_1 = I */
  for(var k=1;k<=n;k++){
    /* AM = A·Mk */
    var AM=[]; for(var r=0;r<n;r++){ AM.push(new Float64Array(n)); for(var c=0;c<n;c++){ var s=0; for(var q=0;q<n;q++) s+=A[r][q]*Mk[q][c]; AM[r][c]=s; } }
    var tr=0; for(var d=0;d<n;d++) tr+=AM[d][d];
    var ck=-tr/k; coef.push(ck);
    for(var r2=0;r2<n;r2++) for(var c2=0;c2<n;c2++) Mk[r2][c2]=AM[r2][c2]+(r2===c2?ck:0);
  }

  /* Durand–Kerner 근 */
  function cmul(a,b){return{re:a.re*b.re-a.im*b.im, im:a.re*b.im+a.im*b.re};}
  function csub(a,b){return{re:a.re-b.re, im:a.im-b.im};}
  function cdiv(a,b){var dd=b.re*b.re+b.im*b.im; return{re:(a.re*b.re+a.im*b.im)/dd, im:(a.im*b.re-a.re*b.im)/dd};}
  function peval(z){ var r={re:1,im:0}; for(var i=1;i<=n;i++){ r=cmul(r,z); r.re+=coef[i]; } return r; }
  /* 크기 정규화: 계수 규모로 초기 반지름 잡기 */
  var scale=1; for(var i3=1;i3<=n;i3++){ var m=Math.pow(Math.abs(coef[i3]),1/i3); if(m>scale) scale=m; }
  var roots=[]; for(var i4=0;i4<n;i4++){ var ang=2*Math.PI*i4/n+0.4; roots.push({re:scale*Math.cos(ang), im:scale*Math.sin(ang)}); }
  for(var it=0;it<500;it++){
    var maxd=0;
    for(var i5=0;i5<n;i5++){
      var num=peval(roots[i5]), den={re:1,im:0};
      for(var j5=0;j5<n;j5++) if(j5!==i5) den=cmul(den,csub(roots[i5],roots[j5]));
      if(Math.abs(den.re)+Math.abs(den.im)<1e-300) den={re:1e-300,im:0};
      var delta=cdiv(num,den);
      roots[i5]=csub(roots[i5],delta);
      maxd=Math.max(maxd, Math.hypot(delta.re,delta.im)/(Math.hypot(roots[i5].re,roots[i5].im)+1e-30));
    }
    if(maxd<1e-12) break;
  }
  /* 정리: 미소 허수부 제거, 안정 극점만 */
  var poles=roots.map(function(z){ var mag=Math.hypot(z.re,z.im); return{re:z.re, im:(Math.abs(z.im)<1e-9*mag?0:z.im)}; });
  var taus=[], alpha=0, omegaD=0, isOsc=false, domTau=0, bestRe=Infinity;
  poles.forEach(function(z){
    if(z.re>=0) return;                   /* 불안정/영 극점은 무시 */
    var tau=1/(-z.re);
    if(z.im===0) taus.push(tau);
    if(tau>domTau) domTau=tau;
    if(z.im!==0 && Math.abs(z.im)>1e-6*Math.abs(z.re) && -z.re<bestRe){ bestRe=-z.re; alpha=-z.re; omegaD=Math.abs(z.im); isOsc=true; }
  });
  if(!isOsc && domTau>0) alpha=1/domTau;
  taus.sort(function(a,b){return b-a;});
  return{poles:poles, taus:taus, alpha:alpha, omegaD:omegaD, isOsc:isOsc, domTau:domTau, order:n};
};

}());
