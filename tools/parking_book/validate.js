#!/usr/bin/env node
/** 复核 boards2.json：对每关（按读出的出口/警车）跑 BFS 求最少步数，报无解/异常。 */
'use strict';
const fs = require('fs');
const N = 6, CAP = 220000;
function solve(cars, exit){
  const n = cars.length;
  const L = new Int8Array(n), D = new Int8Array(n);
  let PI = -1;
  for(let i=0;i<n;i++){ L[i]=cars[i].length; D[i]=cars[i].ori==='h'?0:1; if(cars[i].police) PI=i; }
  if(PI<0) return -3;
  const S=n*2, arena=new Int8Array(S*CAP);
  for(let i=0;i<n;i++){ arena[i*2]=cars[i].row; arena[i*2+1]=cars[i].col; }
  let cnt=1;
  const keyOf=off=>{ let s=''; for(let k=0;k<S;k++) s+=String.fromCharCode(arena[off+k]); return s; };
  const key2=t=>{ let s=''; for(let k=0;k<t.length;k++) s+=String.fromCharCode(t[k]); return s; };
  const seen=new Set([keyOf(0)]); const queue=[0]; let head=0, depth=0, levelEnd=1;
  const free=(off,r,c,skip)=>{ if(r<0||r>=N||c<0||c>=N) return false;
    for(let i=0;i<n;i++){ if(i===skip) continue;
      const rr=arena[off+i*2], cc=arena[off+i*2+1];
      if(D[i]===0){ if(rr===r && c>=cc && c<cc+L[i]) return false; }
      else { if(cc===c && r>=rr && r<rr+L[i]) return false; } }
    return true; };
  const isOut=off=>{ const rr=arena[off+PI*2], cc=arena[off+PI*2+1], len=L[PI];
    if(exit==='right') return D[PI]===0 && cc+len>=N;
    if(exit==='left')  return D[PI]===0 && cc<=0;
    if(exit==='bottom')return D[PI]===1 && rr+len>=N;
    if(exit==='top')   return D[PI]===1 && rr<=0;
    return false; };
  while(head<queue.length){
    if(head===levelEnd){ depth++; levelEnd=queue.length; }
    const off=queue[head++];
    if(isOut(off)) return depth;
    if(depth>45) return -1;
    for(let i=0;i<n;i++) for(let d=-1;d<=1;d+=2){
      const tmp=new Int8Array(S); tmp.set(arena.subarray(off,off+S));
      for(let step=1; step<=N; step++){
        const r=tmp[i*2]+(D[i]===1?d:0), c=tmp[i*2+1]+(D[i]===0?d:0);
        let ok=true;
        for(let k=0;k<L[i];k++){ const rr=D[i]===1?r+k:r, cc=D[i]===0?c+k:c; if(!free(off,rr,cc,i)){ ok=false; break; } }
        if(!ok) break;
        tmp[i*2]=r; tmp[i*2+1]=c;
        const kk=key2(tmp);
        if(!seen.has(kk)){ seen.add(kk); if(cnt>=CAP) return -2; const at2=cnt*S; arena.set(tmp,at2); cnt++; queue.push(at2); }
      }
    }
  }
  return -1;
}
const B = JSON.parse(fs.readFileSync('/opt/data/parking_grid/boards2.json','utf8'));
let ok=0, stat={};
for(const t of Object.keys(B).sort()){
  const b=B[t];
  const cars=b.cars.map(c=>({row:c.row,col:c.col,length:c.length,ori:c.ori,police:!!c.police}));
  const m = (b.exit? solve(cars,b.exit): -3);
  b.min = m;
  const tag = m>=0?'解':'异常';
  stat[tag]=(stat[tag]||0)+1;
  if(m>=0) ok++;
  if(m<0) console.log(`  ${t} exit=${b.exit} note=${b.note} 单格=${b.singles.length} 车=${b.cars.length} → ${m}`);
}
fs.writeFileSync('/opt/data/parking_grid/boards2.json', JSON.stringify(B));
console.log(`可解 ${ok} / ${Object.keys(B).length}`, JSON.stringify(stat));
