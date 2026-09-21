'use strict';
process.env.MOCK_DVF_MODE='true';
const assert=require('assert');
const http=require('http');
const m=require('../server');
assert.strictEqual(m.wmedian([{value:1000,weight:1},{value:1100,weight:3},{value:5000,weight:1}]),1100);
assert.strictEqual(m.percentile([1,2,3,4],.5),2.5);
assert.strictEqual(m.rw(2),1);
assert.strictEqual(m.rw(20),.4);
const base={address:'test',realtyType:'house',livingArea:74,landArea:290,rooms:4};
const direct=m.analyze(m.mockRows(),base,{lat:49.77,lon:4.72});
assert(direct.estimate>0);
assert.strictEqual(direct.high,direct.estimate+20000);
assert.strictEqual(direct.low,direct.estimate-20000);
assert(direct.comparables.data.length>=4);
assert(direct.confidence>=0&&direct.confidence<=100);
assert(direct.method.includes('prix propriétaire'));
const server=m.startServer(0),port=server.address().port;
new Promise((resolve,reject)=>{
 const r=http.request({hostname:'127.0.0.1',port,path:'/api/analyze',method:'POST',headers:{'content-type':'application/json'}},res=>{
  let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b)}));
 });
 r.on('error',reject);r.end(JSON.stringify(base));
}).then(out=>{
 assert.strictEqual(out.status,200);assert(out.body.estimate>0);assert.strictEqual(out.body.high,out.body.estimate+20000);
 server.close(()=>console.log('JML V1 SELFTEST OK'));
}).catch(err=>{server.close();console.error(err);process.exitCode=1});
