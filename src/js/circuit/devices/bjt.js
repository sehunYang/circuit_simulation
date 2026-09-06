(function(){
'use strict';
var App=window.App, D=App.Devices;

/* BJT (npn / pnp) — Ebers-Moll 수송 모델
 *   포트: L = 베이스(B), T = 컬렉터(C), B = 이미터(E)   (compNodes = [nB, nC, nE])
 *   npn:  I_CC = I_s(e^{V_BE/V_T} − 1),  I_EC = I_s(e^{V_BC/V_T} − 1)
 *         I_C = I_CC − I_EC(1 + 1/β_R),   I_B = I_CC/β_F + I_EC/β_R,   I_E = −(I_C + I_B)
 *         (전류는 모두 '소자로 들어가는' 방향 +)
 *   pnp:  극성 반전 — 접합 전압 부호를 뒤집어 같은 식을 쓰고 전류를 반전한다.
 *   β_F = comp.value (기본 100), β_R = 1.
 *
 *   NR 스탬프: 각 단자 전류 I_t(V_B, V_C, V_E) 를 야코비안으로 선형화해
 *   노드 KCL 행에 ∂I_t/∂V_n 을 더하고 상수항을 우변으로 옮긴다.
 *   동작 영역: 차단(V_BE < 0.5 V) · 포화(V_BC 순방향 > 0.4 V) · 활성 */
function factory(comp, nn, pnp){
  var d=D.base(comp, nn);
  d.linear=false;
  var IS=1e-14, VT=D.VT, BR=1, GMIN=1e-12, VMAX=1.2;
  var VCRIT=VT*Math.log(VT/(Math.SQRT2*IS));
  var sgn=pnp?-1:1;
  var vbeLin=0, vbcLin=0;
  function BF(){ return comp.value>0?comp.value:100; }
  function ex(v){ return Math.exp(Math.min(v,VMAX)/VT); }

  /* 접합 전압(npn 기준: v_be, v_bc)에서 단자 전류와 편미분 */
  function model(vbe, vbc){
    var bf=BF(), e1=ex(vbe), e2=ex(vbc);
    var icc=IS*(e1-1), iec=IS*(e2-1);
    var gcc=IS*e1/VT, gec=IS*e2/VT;
    var iC=icc-iec*(1+1/BR), iB=icc/bf+iec/BR;
    /* ∂/∂v_be, ∂/∂v_bc */
    return{ iC:iC, iB:iB, iE:-(iC+iB),
            dC_be:gcc, dC_bc:-gec*(1+1/BR),
            dB_be:gcc/bf, dB_bc:gec/BR };
  }
  d.reset=function(){ vbeLin=0; vbcLin=0; };
  d.loadOP=function(sys,x){
    var vB=D.V(x,this.i0), vC=D.V(x,this.i1), vE=D.V(x,this.i2);
    var vbeRaw=sgn*(vB-vE), vbcRaw=sgn*(vB-vC);
    var vbe=D.pnjlim(vbeRaw,vbeLin,VT,VCRIT), vbc=D.pnjlim(vbcRaw,vbcLin,VT,VCRIT);
    vbeLin=vbe; vbcLin=vbc;
    this.limited=(Math.abs(vbe-vbeRaw)>1e-6)||(Math.abs(vbc-vbcRaw)>1e-6);   /* 제한 중이면 미수렴 */
    var m=model(vbe,vbc);
    /* 단자 전류 (실제 극성): I_t = sgn·f(sgn·V) → dI/dV = f' (부호 두 번 곱해 원래대로) */
    var iB=sgn*m.iB, iC=sgn*m.iC, iE=sgn*m.iE;
    var dB_be=m.dB_be, dB_bc=m.dB_bc, dC_be=m.dC_be, dC_bc=m.dC_bc;
    var dE_be=-(dC_be+dB_be), dE_bc=-(dC_bc+dB_bc);
    /* v_be = V_B − V_E, v_bc = V_B − V_C  (부호 sgn 은 미분에서 상쇄됨) */
    var iBn=this.i0, iCn=this.i1, iEn=this.i2;
    function row(node, I, d_be, d_bc, vbeR, vbcR){
      /* ∂I/∂V_B = d_be + d_bc, ∂I/∂V_C = −d_bc, ∂I/∂V_E = −d_be */
      sys.add(node,iBn,d_be+d_bc); sys.add(node,iCn,-d_bc); sys.add(node,iEn,-d_be);
      sys.add(node,node,GMIN);
      /* I(V) ≈ I0 + J·(V − V0)  →  우변: −(I0 − J·V0) */
      var lin=I-(d_be*vbeR+d_bc*vbcR);
      sys.rhs(node,-lin);
    }
    var vbeR=sgn*vbe, vbcR=sgn*vbc;   /* 실제 극성의 접합 전압 */
    row(iBn,iB,dB_be,dB_bc,vbeR,vbcR);
    row(iCn,iC,dC_be,dC_bc,vbeR,vbcR);
    row(iEn,iE,dE_be,dE_bc,vbeR,vbcR);
  };
  d.loadAC=function(sys,xOP){
    /* 소신호: 동작점에서의 야코비안(컨덕턴스 행렬)만 스탬프 */
    var vB=D.V(xOP,this.i0), vC=D.V(xOP,this.i1), vE=D.V(xOP,this.i2);
    var m=model(sgn*(vB-vE), sgn*(vB-vC));
    var iBn=this.i0, iCn=this.i1, iEn=this.i2;
    function row(node,d_be,d_bc){ sys.add(node,iBn,d_be+d_bc); sys.add(node,iCn,-d_bc); sys.add(node,iEn,-d_be); sys.add(node,node,GMIN); }
    row(iBn,m.dB_be,m.dB_bc); row(iCn,m.dC_be,m.dC_bc); row(iEn,-(m.dC_be+m.dB_be),-(m.dC_bc+m.dB_bc));
  };
  d.outputs=function(x){
    var vB=D.V(x,this.i0), vC=D.V(x,this.i1), vE=D.V(x,this.i2);
    var vbe=sgn*(vB-vE), vbc=sgn*(vB-vC);
    var m=model(vbe,vbc);
    var region = vbe<0.5 ? 'cutoff' : (vbc>0.4 ? 'saturation' : 'active');
    return{ v:vC-vE, i:sgn*m.iC,                       /* 대표 전류 = 컬렉터 전류 */
            iB:sgn*m.iB, iC:sgn*m.iC, iE:sgn*m.iE,
            vBE:vB-vE, vCE:vC-vE, vBC:vB-vC, region:region, beta:BF() };
  };
  d.portCurrents=function(x){
    var o=this.outputs(x); return{L:o.iB, T:o.iC, B:o.iE};
  };
  d.portCurrentsOut=function(o){ return{L:o.iB, T:o.iC, B:o.iE}; };
  d.outputsAC=function(xr,xi){
    return{v:{re:D.V(xr,this.i1)-D.V(xr,this.i2), im:D.V(xi,this.i1)-D.V(xi,this.i2)}, i:{re:0,im:0}};
  };
  d.portCurrentsAC=function(){ return{L:{re:0,im:0},T:{re:0,im:0},B:{re:0,im:0}}; };
  return d;
}
D.register(TYPE.NPN, function(comp,nn){ return factory(comp,nn,false); });
D.register(TYPE.PNP, function(comp,nn){ return factory(comp,nn,true); });

}());
