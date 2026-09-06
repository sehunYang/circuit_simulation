(function(){
'use strict';
var App=window.App;

/* ════════════════════════════════════════════════════════════════════
 * App.MNA — 수정 노드 해석 행렬 코어
 *
 *   미지수 배치: 노드 k(1…N-1) → 인덱스 k-1, 그 뒤에 소자 보조 미지수
 *   (전원·인덕터의 가지 전류)가 layout() 순서대로 붙는다. 접지(0)는 -1.
 *
 *   makeSystem(n, complex) → sys
 *     sys.add(i,j,v) / sys.addI(i,j,v)    행렬 누적 (실수부 / 허수부)
 *     sys.rhs(i,v)   / sys.rhsI(i,v)      우변 누적
 *     i 또는 j 가 -1(접지)이면 무시 — 소자 스탬프가 접지 검사를 안 해도 된다.
 *   solve(sys) → Float64Array (실수) | {re,im} (복소) | null (특이행렬)
 * ════════════════════════════════════════════════════════════════════ */
App.MNA=(function(){

  function makeSystem(n, complex){
    var A=[], Ai=null, b=new Float64Array(n), bi=null;
    for(var i=0;i<n;i++) A.push(new Float64Array(n));
    if(complex){ Ai=[]; for(var k=0;k<n;k++) Ai.push(new Float64Array(n)); bi=new Float64Array(n); }
    return{
      n:n, complex:!!complex, A:A, Ai:Ai, b:b, bi:bi,
      add:function(i,j,v){ if(i>=0&&j>=0) A[i][j]+=v; },
      addI:function(i,j,v){ if(i>=0&&j>=0&&Ai) Ai[i][j]+=v; },
      rhs:function(i,v){ if(i>=0) b[i]+=v; },
      rhsI:function(i,v){ if(i>=0&&bi) bi[i]+=v; },
      /* 2단자 어드미턴스 스탬프 (i,j 사이에 g) */
      stampG:function(i,j,g){ this.add(i,i,g); this.add(j,j,g); this.add(i,j,-g); this.add(j,i,-g); },
      stampGI:function(i,j,g){ this.addI(i,i,g); this.addI(j,j,g); this.addI(i,j,-g); this.addI(j,i,-g); },
      /* i→j 방향 전류원 I (노드 i 에서 나가 j 로) */
      stampI:function(i,j,I){ this.rhs(i,-I); this.rhs(j,I); },
    };
  }

  /* 실수 가우스 소거 (부분 피벗) */
  function solveReal(A,b){
    var n=b.length;
    var a=A.map(function(r){return Float64Array.from(r);});
    var x=Float64Array.from(b);
    for(var col=0;col<n;col++){
      var mx=col, mv=Math.abs(a[col][col]);
      for(var r=col+1;r<n;r++){var v=Math.abs(a[r][col]);if(v>mv){mv=v;mx=r;}}
      if(mv<1e-18) return null;
      if(mx!==col){var t=a[col];a[col]=a[mx];a[mx]=t;var tb=x[col];x[col]=x[mx];x[mx]=tb;}
      var piv=a[col][col];
      for(var r2=col+1;r2<n;r2++){
        var f=a[r2][col]/piv; if(f===0) continue;
        var row=a[r2], prow=a[col];
        for(var c=col;c<n;c++) row[c]-=f*prow[c];
        x[r2]-=f*x[col];
      }
    }
    var sol=new Float64Array(n);
    for(var i=n-1;i>=0;i--){
      var s=x[i];
      for(var j=i+1;j<n;j++) s-=a[i][j]*sol[j];
      sol[i]=s/a[i][i];
    }
    return sol;
  }

  /* 복소 가우스 소거 — 실수/허수 배열 분리 저장 */
  function solveComplex(Ar,Ai,br,bi){
    var n=br.length;
    var ar=Ar.map(function(r){return Float64Array.from(r);});
    var ai=Ai.map(function(r){return Float64Array.from(r);});
    var xr=Float64Array.from(br), xi=Float64Array.from(bi);
    for(var col=0;col<n;col++){
      var mx=col, mv=Math.hypot(ar[col][col],ai[col][col]);
      for(var r=col+1;r<n;r++){var v=Math.hypot(ar[r][col],ai[r][col]);if(v>mv){mv=v;mx=r;}}
      if(mv<1e-18) return null;
      if(mx!==col){
        var t=ar[col];ar[col]=ar[mx];ar[mx]=t; t=ai[col];ai[col]=ai[mx];ai[mx]=t;
        var tb=xr[col];xr[col]=xr[mx];xr[mx]=tb; tb=xi[col];xi[col]=xi[mx];xi[mx]=tb;
      }
      var pr=ar[col][col], pi=ai[col][col], pd=pr*pr+pi*pi;
      for(var r2=col+1;r2<n;r2++){
        var nr=ar[r2][col], ni=ai[r2][col];
        if(nr===0&&ni===0) continue;
        /* f = (nr+j ni)/(pr+j pi) */
        var fr=(nr*pr+ni*pi)/pd, fi=(ni*pr-nr*pi)/pd;
        var rr=ar[r2], ri=ai[r2], cr=ar[col], ci=ai[col];
        for(var c=col;c<n;c++){
          var mr=fr*cr[c]-fi*ci[c], mi=fr*ci[c]+fi*cr[c];
          rr[c]-=mr; ri[c]-=mi;
        }
        xr[r2]-=fr*xr[col]-fi*xi[col]; xi[r2]-=fr*xi[col]+fi*xr[col];
      }
    }
    var sr=new Float64Array(n), si=new Float64Array(n);
    for(var i=n-1;i>=0;i--){
      var accR=xr[i], accI=xi[i];
      for(var j=i+1;j<n;j++){
        accR-=ar[i][j]*sr[j]-ai[i][j]*si[j];
        accI-=ar[i][j]*si[j]+ai[i][j]*sr[j];
      }
      var dr=ar[i][i], di=ai[i][i], dd=dr*dr+di*di;
      sr[i]=(accR*dr+accI*di)/dd; si[i]=(accI*dr-accR*di)/dd;
    }
    return{re:sr, im:si};
  }

  function solve(sys){
    if(sys.complex) return solveComplex(sys.A,sys.Ai,sys.b,sys.bi);
    return solveReal(sys.A,sys.b);
  }

  /* 소자 보조 미지수 배치: 노드 수 N(접지 포함) 뒤에 extra>0 인 소자 순서대로 */
  function layout(nodeCount, devices){
    var k=nodeCount-1;
    devices.forEach(function(d){ if(d.extra){ d.k=k; k+=d.extra; } else d.k=-1; });
    return k;   // 총 미지수 수
  }

  return{makeSystem:makeSystem, solve:solve, solveReal:solveReal, solveComplex:solveComplex, layout:layout};
})();

}());
