const assert = require('assert');
const {median,percentile,iqrFilter,buildConfidence,jmlAdjustments} = require('../server');
assert.equal(median([3,1,2]),2);
assert.equal(percentile([1,2,3,4],.5),2.5);
const rows=[1,2,3,4,100].map((sqm,i)=>({sqm,weight:1,score:80,distanceKm:.2,date:'2025-01-01'}));
const f=iqrFilter(rows); assert(f.items.length===4,'IQR doit éliminer 100');
const c=buildConfidence(f.items,f.items,.5,{median:2.5,q1:1.75,q3:3.25,dispersion:.6}); assert(c.score>=0&&c.score<=100);
const a=jmlAdjustments({dpe:'D',condition:'good',garage:true,parking:false,cellar:false,terrace:false,patio:false,niceView:false}); assert(a.pct>0);
console.log('SELFTEST OK — moteur V7.4');
