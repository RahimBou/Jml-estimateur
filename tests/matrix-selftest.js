'use strict';
process.env.MOCK_DVF_MODE='true';
const assert=require('assert');
const m=require('../server');
const base={address:'test',livingArea:74,landArea:290,rooms:4};
const rows=m.mockRows();
function rowsFor(type){
  if(type==='house') return rows;
  const base=rows.map(r=>({...r,type_local:type==='apartment'?'Appartement':type==='commercial'||type==='industrial'?'Local commercial':type==='garage'||type==='parking'?'Dépendance':'Maison',nature_culture:type==='land'?'Terrain à bâtir':type==='agricultural_land'?'Terres':'',livingArea:type==='land'||type==='agricultural_land'?0:r.livingArea,landArea:type==='land'||type==='agricultural_land'?Math.max(r.landArea,500):r.landArea}));
  return base;
}
const types=Object.keys(m.TYPES);
for(const type of types){
  if(type==='building'||type==='other')continue;
  const input={...base,realtyType:type};
  if(type==='land'||type==='agricultural_land')input.livingArea=0;
  const r=m.analyze(rowsFor(type),input,{lat:49.77,lon:4.72});
  assert(r.estimate>0, type+' doit produire une estimation en mode test');
  assert.strictEqual(r.high,r.estimate+20000);
  assert.strictEqual(r.low,Math.max(0,r.estimate-20000));
}
const a=m.analyze(rows,{...base,realtyType:'house',ownerExpectedPrice:1000000},{lat:49.77,lon:4.72});
const b=m.analyze(rows,{...base,realtyType:'house',ownerExpectedPrice:100000},{lat:49.77,lon:4.72});
assert.strictEqual(a.estimate,b.estimate,'le prix propriétaire ne doit jamais influencer le calcul');
console.log('MATRIX MOCK OK',JSON.stringify({testedTypes:types.filter(x=>!['building','other'].includes(x)),ownerPriceIgnored:true}));
