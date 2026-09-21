'use strict';

const { loadDvf, consolidate, selectFromBase, estimateFromComparables, TYPES } = require('../server');

const LIMIT = Number(process.env.REAL_MATRIX_LIMIT || 60);
const TEST_YEAR = Number(process.env.BACKTEST_YEAR || 2025);

function d(v){ const x=new Date(String(v).slice(0,10)); return Number.isNaN(x.getTime())?null:x; }
function median(a){ const x=[...a].sort((a,b)=>a-b); if(!x.length)return 0; const i=(x.length-1)/2; return x[Math.floor(i)]===x[Math.ceil(i)]?x[Math.floor(i)]:(x[Math.floor(i)]+x[Math.ceil(i)])/2; }
function pct(x){ return +(x*100).toFixed(1); }

async function evaluate(rows, type){
  const all=consolidate(rows,TYPES[type]);
  const tests=all.filter(r=>{
    const dt=d(r.date);
    return dt && dt.getFullYear()===TEST_YEAR && r.area>=30 && r.area<=300 && r.price>=20000;
  }).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const step=Math.max(1,Math.floor(tests.length/LIMIT));
  const sample=tests.filter((_,i)=>i%step===0).slice(0,LIMIT);
  const errors=[];
  const examples=[];
  for(const sold of sample){
    const sd=d(sold.date);
    const prior=all.filter(r=>d(r.date)?.getTime()<sd.getTime());
    if(prior.length<6) continue;
    const target={lat:sold.lat,lon:sold.lon,area:sold.area,rooms:sold.rooms||0,landArea:sold.landArea||0};
    const comps=selectFromBase(prior,target,sd);
    const pred=estimateFromComparables(comps,target);
    if(!pred) continue;
    const err=(pred-sold.price)/sold.price;
    errors.push(err);
    if(examples.length<5) examples.push({date:sold.date,actual:sold.price,estimated:pred,errorPct:pct(err),comparables:comps.length});
  }
  const abs=errors.map(Math.abs);
  return {
    type,
    candidates:tests.length,
    evaluated:errors.length,
    medianAbsErrorPct:pct(median(abs)),
    maePct:pct(abs.reduce((a,b)=>a+b,0)/Math.max(1,abs.length)),
    biasPct:pct(errors.reduce((a,b)=>a+b,0)/Math.max(1,errors.length)),
    within10Pct:pct(abs.filter(x=>x<=.10).length/Math.max(1,abs.length)),
    within20Pct:pct(abs.filter(x=>x<=.20).length/Math.max(1,abs.length)),
    examples
  };
}

async function main(){
  const rows=await loadDvf();
  const results=[];
  for(const type of ['apartment','house']) results.push(await evaluate(rows,type));
  console.log(JSON.stringify({testYear:TEST_YEAR,sourceRows:rows.length,results},null,2));
}
main().catch(e=>{console.error(e);process.exit(1);});
