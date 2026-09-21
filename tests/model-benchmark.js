'use strict';
const {loadDvf,consolidate,selectFromBase,estimateFromComparables,TYPES}=require('../server');
function d(v){const x=new Date(String(v).slice(0,10));return Number.isNaN(x.getTime())?null:x}
function median(a){const x=[...a].sort((a,b)=>a-b);if(!x.length)return 0;const i=(x.length-1)/2;return x[Math.floor(i)]===x[Math.ceil(i)]?x[Math.floor(i)]:(x[Math.floor(i)]+x[Math.ceil(i)])/2}
function pct(x){return +(x*100).toFixed(1)}
function wmed(a){const x=a.filter(z=>z.v>0&&z.w>0).sort((a,b)=>a.v-b.v);let s=x.reduce((q,z)=>q+z.w,0),h=s/2,c=0;for(const z of x){c+=z.w;if(c>=h)return z.v}return 0}
function predVariant(comps,t,mode){
 const vals=[];
 for(const r of comps){
   let w=Math.exp(-r.distance/(mode==='strong'?.45:.8));
   w*=Math.max(.2,1-Math.abs(r.area-t.area)/Math.max(t.area,1));
   if(t.rooms&&r.rooms)w*=Math.max(.25,1-Math.abs(r.rooms-t.rooms)*.18);
   if(t.landArea&&r.landArea)w*=Math.max(.2,1-Math.abs(Math.log1p(r.landArea)-Math.log1p(t.landArea))*.35);
   let p=r.price/t.area;
   if(mode==='landAdj'&&t.landArea&&r.landArea){
     const landDelta=t.landArea-r.landArea;
     p=(r.price+Math.max(-50000,Math.min(50000,landDelta*80)))/t.area;
   }
   vals.push({v:p,w});
 }
 return Math.round(wmed(vals)*t.area/1000)*1000
}
async function run(type,mode){
 const rows=await loadDvf(),all=consolidate(rows,TYPES[type]);
 const tests=all.filter(r=>d(r.date)?.getFullYear()===2025&&r.area>=30&&r.area<=300&&r.price>=20000).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
 const sample=tests.filter((_,i)=>i%Math.max(1,Math.floor(tests.length/100))===0).slice(0,100);
 const e=[];
 for(const sold of sample){const sd=d(sold.date),prior=all.filter(r=>d(r.date)?.getTime()<sd.getTime());if(prior.length<6)continue;const t={lat:sold.lat,lon:sold.lon,area:sold.area,rooms:sold.rooms||0,landArea:sold.landArea||0};const c=selectFromBase(prior,t,sd);const p=predVariant(c,t,mode);if(p)e.push((p-sold.price)/sold.price)}
 const abs=e.map(Math.abs);return {type,mode,n:e.length,medianAbs:pct(median(abs)),mae:pct(abs.reduce((a,b)=>a+b,0)/e.length),bias:pct(e.reduce((a,b)=>a+b,0)/e.length),within20:pct(abs.filter(x=>x<=.2).length/e.length)}
}
(async()=>{for(const type of ['apartment','house'])for(const mode of ['base','strong','landAdj'])console.log(JSON.stringify(await run(type,mode)))})().catch(e=>{console.error(e);process.exit(1)})