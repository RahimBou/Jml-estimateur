'use strict';
const {loadDvf,consolidate,selectFromBase,TYPES}=require('../server');
function d(v){const x=new Date(String(v).slice(0,10));return Number.isNaN(x.getTime())?null:x}
function median(a){const x=[...a].sort((a,b)=>a-b);if(!x.length)return 0;const i=(x.length-1)/2;return x[Math.floor(i)]===x[Math.ceil(i)]?x[Math.floor(i)]:(x[Math.floor(i)]+x[Math.ceil(i)])/2}
function pct(x){return +(x*100).toFixed(1)}
function wm(a){const x=a.filter(z=>z.v>0&&z.w>0).sort((a,b)=>a.v-b.v),h=x.reduce((s,z)=>s+z.w,0)/2;let s=0;for(const z of x){s+=z.w;if(s>=h)return z.v}return 0}
function pred(c,t,mode){let x=c;
 if(mode!=='all'){x=c.filter(r=>{
   const ar=Math.min(r.area,t.area)/Math.max(r.area,t.area);
   const rr=!t.rooms||!r.rooms?1:Math.max(0,1-Math.abs(r.rooms-t.rooms)*.15);
   const lr=!t.landArea||!r.landArea?1:Math.max(0,1-Math.abs(Math.log1p(r.landArea)-Math.log1p(t.landArea))*.3);
   return ar>=(mode==='strict'?0.75:0.6)&&rr>=(mode==='strict'?.7:.55)&&lr>=(mode==='strict'?.7:.5);
 });}
 if(x.length<4)x=c;
 const v=x.map(r=>({v:r.sqmPrice,w:Math.max(.1,r.weight)*(mode==='strict'?Math.exp(-r.distance/.45):1)}));
 return Math.round(wm(v)*t.area/1000)*1000
}
async function run(type,mode){const rows=await loadDvf(),all=consolidate(rows,TYPES[type]),tests=all.filter(r=>d(r.date)?.getFullYear()===2025&&r.area>=30&&r.area<=300&&r.price>=20000).sort((a,b)=>String(a.date).localeCompare(String(b.date)));const sample=tests.filter((_,i)=>i%Math.max(1,Math.floor(tests.length/100))===0).slice(0,100),e=[];for(const sold of sample){const sd=d(sold.date),prior=all.filter(r=>d(r.date)?.getTime()<sd.getTime());if(prior.length<6)continue;const t={lat:sold.lat,lon:sold.lon,area:sold.area,rooms:sold.rooms||0,landArea:sold.landArea||0},c=selectFromBase(prior,t,sd),p=pred(c,t,mode);if(p)e.push((p-sold.price)/sold.price)}const a=e.map(Math.abs);return{type,mode,n:e.length,medianAbs:pct(median(a)),mae:pct(a.reduce((x,y)=>x+y,0)/e.length),bias:pct(e.reduce((x,y)=>x+y,0)/e.length),within20:pct(a.filter(x=>x<=.2).length/e.length)}}(async()=>{for(const t of ['apartment','house'])for(const m of ['all','surface','strict'])console.log(JSON.stringify(await run(t,m)))})().catch(e=>{console.error(e);process.exit(1)})