'use strict';
process.env.MOCK_DVF_MODE='false';
process.env.DVF_DEPT='08';
process.env.DVF_YEARS='2025,2024,2023,2022';
const assert=require('assert');
const m=require('../server');
(async()=>{
  const address='15 Rue Payer Guillemain, 08000 Charleville-Mézières';
  const geo=await m.geocode(address);
  assert(Number.isFinite(geo.lat)&&Number.isFinite(geo.lon),'géocodage réel absent');
  const rows=await m.loadDvf();
  assert(rows.length>0,'DVF 2025 vide');
  const result=m.analyze(rows,{address,realtyType:'apartment',livingArea:70,landArea:0,rooms:3},{lat:geo.lat,lon:geo.lon});
  assert(result.estimate>0,'estimation réelle invalide');
  assert.strictEqual(result.high,result.estimate+20000);
  assert.strictEqual(result.low,Math.max(0,result.estimate-20000));
  assert(result.comparables.data.length>0,'aucun comparable réel');
  console.log('REAL DVF SMOKE OK',JSON.stringify({estimate:result.estimate,confidence:result.confidence,comparables:result.comparables.data.length,avgDistanceKm:result.statistics.avgDistanceKm,avgAgeMonths:result.statistics.avgAgeMonths,localMedian:result.statistics.localMedian,rows:result.comparables.data},null,2));
})().catch(e=>{console.error('REAL DVF SMOKE FAILED:',e.stack||e);process.exit(1)});
