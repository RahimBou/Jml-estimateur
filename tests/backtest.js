'use strict';

const {
  loadDvf,
  consolidate,
  selectFromBase,
  estimateFromComparables,
  TYPES
} = require('../server');

const CFG = TYPES.apartment;
const LIMIT = Number(process.env.BACKTEST_LIMIT || 100);
const TEST_YEAR = Number(process.env.BACKTEST_YEAR || 2025);

function d(v){ const x=new Date(String(v).slice(0,10)); return Number.isNaN(x.getTime())?null:x; }
function pct(x){ return (x*100).toFixed(1)+'%'; }
function median(a){ const x=[...a].sort((a,b)=>a-b); if(!x.length)return 0; const i=(x.length-1)/2; return x[Math.floor(i)]===x[Math.ceil(i)]?x[Math.floor(i)]:(x[Math.floor(i)]+x[Math.ceil(i)])/2; }

async function main(){
  const rows=await loadDvf();
  const all=consolidate(rows,CFG);
  const tests=all
    .filter(r=>d(r.date)?.getFullYear()===TEST_YEAR && r.area>=30 && r.area<=250 && r.price>=30000)
    .sort((a,b)=>String(a.date).localeCompare(String(b.date)));

  const step=Math.max(1,Math.floor(tests.length/LIMIT));
  const sample=tests.filter((_,i)=>i%step===0).slice(0,LIMIT);
  const errors=[],absErrors=[],within={5:0,10:0,15:0,20:0},details=[];

  for(const sold of sample){
    const soldDate=d(sold.date);
    const prior=all.filter(r=>d(r.date)?.getTime()<soldDate.getTime());
    if(prior.length<6) continue;
    const target={lat:sold.lat,lon:sold.lon,area:sold.area,rooms:sold.rooms||0,landArea:sold.landArea||0};
    const comps=selectFromBase(prior,target,soldDate);
    const pred=estimateFromComparables(comps,target);
    if(!pred) continue;
    const err=(pred-sold.price)/sold.price;
    const ae=Math.abs(err);
    errors.push(err); absErrors.push(ae);
    for(const k of Object.keys(within)) if(ae<=Number(k)/100) within[k]++;
    details.push({date:sold.date,price:sold.price,pred,err,comps:comps.length});
  }

  const mae=absErrors.reduce((a,b)=>a+b,0)/Math.max(1,absErrors.length);
  const bias=errors.reduce((a,b)=>a+b,0)/Math.max(1,errors.length);
  console.log(JSON.stringify({
    testYear:TEST_YEAR,
    sourceRows:rows.length,
    consolidated:all.length,
    candidates:tests.length,
    evaluated:errors.length,
    medianAbsError:pct(median(absErrors)),
    mae:pct(mae),
    bias:pct(bias),
    within5:pct(within[5]/Math.max(1,errors.length)),
    within10:pct(within[10]/Math.max(1,errors.length)),
    within15:pct(within[15]/Math.max(1,errors.length)),
    within20:pct(within[20]/Math.max(1,errors.length)),
    examples:details.slice(0,10)
  },null,2));
}
main().catch(e=>{console.error(e);process.exit(1);});
