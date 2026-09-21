// JML Immobilier — Estimateur V8.0 PRO DVF
// Moteur de comparaison directe : ventes DVF réelles, fenêtre max 24 mois,
// score de similarité, pondération par récence, filtre robuste des outliers,
// médiane pondérée et contrôle local. Aucun crédit/API Immo Data payant.

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');
const readline = require('readline');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DVF_DEPT = String(process.env.DVF_DEPT || '08').padStart(2, '0');
const DVF_YEARS = (process.env.DVF_YEARS || '2025,2024,2023,2022,2021')
  .split(',').map(x => Number(x.trim())).filter(Number.isInteger);
const DATA_DIR = path.join(__dirname, 'data');
const CACHE = new Map();
const GEO_CACHE = new Map();
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_COMPARABLE_AGE_MONTHS = Number(process.env.MAX_COMPARABLE_AGE_MONTHS || 24);
const VALUATION_DATE = process.env.VALUATION_DATE ? new Date(process.env.VALUATION_DATE) : new Date();
const DATA_MILLIME = process.env.DVF_MILLIME || 'avril 2026';

app.use(express.json({limit:'100kb'}));
const PUBLIC_DIR = fs.existsSync(path.join(__dirname,'public')) ? path.join(__dirname,'public') : path.join(__dirname,'publique');
app.use(express.static(PUBLIC_DIR,{etag:false,lastModified:false,maxAge:0}));
app.get('/',(_,res)=>res.sendFile(path.join(PUBLIC_DIR,'index.html')));

const TYPE_CONFIG = {
  house:{label:'Maison',dvf:['Maison'],built:true,ppsm:true},
  apartment:{label:'Appartement',dvf:['Appartement'],built:true,ppsm:true},
  building:{label:'Immeuble',dvf:['Maison','Appartement'],built:true,ppsm:true,special:'building'},
  land:{label:'Terrain constructible',dvf:['Parcelle'],built:false,ppsm:false,special:'land'},
  agricultural_land:{label:'Terrain agricole',dvf:['Parcelle'],built:false,ppsm:false,special:'agri'},
  garage:{label:'Garage / dépendance',dvf:['Dépendance'],built:false,ppsm:false,special:'dependency'},
  parking:{label:'Parking',dvf:['Dépendance'],built:false,ppsm:false,special:'dependency'},
  commercial:{label:'Local commercial',dvf:['Local industriel. commercial ou assimilé'],built:true,ppsm:true,special:'commercial'},
  industrial:{label:'Local industriel / entrepôt',dvf:['Local industriel. commercial ou assimilé'],built:true,ppsm:true,special:'industrial'},
  other:{label:'Autre bien',dvf:[],built:false,ppsm:false,special:'manual'}
};

function num(v,fallback=0){const x=Number(String(v??'').replace(',','.').trim());return Number.isFinite(x)?x:fallback;}
function clamp(x,a,b){return Math.min(b,Math.max(a,x));}
function median(a){const x=a.filter(Number.isFinite).sort((p,q)=>p-q);if(!x.length)return null;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function percentile(a,p){const x=a.filter(Number.isFinite).sort((m,n)=>m-n);if(!x.length)return null;const i=(x.length-1)*p,l=Math.floor(i),h=Math.ceil(i);return l===h?x[l]:x[l]+(x[h]-x[l])*(i-l);}
function round100(x){return Math.round(x/100)*100;}
function round1000(x){return Math.round(x/1000)*1000;}
function haversine(lat1,lon1,lat2,lon2){if(![lat1,lon1,lat2,lon2].every(Number.isFinite))return null;const R=6371,r=Math.PI/180,dLat=(lat2-lat1)*r,dLon=(lon2-lon1)*r,a=Math.sin(dLat/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
function ageMonths(date){const t=new Date(date).getTime();const now=VALUATION_DATE.getTime();return Number.isFinite(t)&&Number.isFinite(now)?Math.max(0,(now-t)/(30.4375*864e5)):null;}
function parseCsvLine(line){const out=[];let cur='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(c===','&&!q){out.push(cur);cur='';}else cur+=c;}out.push(cur);return out;}
async function fetchBuffer(url){const ac=new AbortController();const timer=setTimeout(()=>ac.abort(),DOWNLOAD_TIMEOUT_MS);try{const r=await fetch(url,{signal:ac.signal,headers:{'User-Agent':'JML-Immobilier-Estimateur/8.0'}});if(!r.ok)throw new Error(`DVF HTTP ${r.status}`);return Buffer.from(await r.arrayBuffer());}finally{clearTimeout(timer);}}
function canonicalType(raw){const s=String(raw||'').trim().toLowerCase();if(s==='maison')return'Maison';if(s==='appartement')return'Appartement';if(s==='dépendance'||s==='dependance')return'Dépendance';if(s.includes('local industriel'))return'Local industriel. commercial ou assimilé';if(s==='parcelle')return'Parcelle';return raw;}
function normalizeNature(raw){return String(raw||'').trim();}
function lineValue(vals,idx,key){return idx[key]==null?'':vals[idx[key]];}

async function loadYear(year){
  if(CACHE.has(year))return CACHE.get(year);
  await fsp.mkdir(DATA_DIR,{recursive:true});
  const gz=path.join(DATA_DIR,`dvf_${DVF_DEPT}_${year}.csv.gz`);
  if(!fs.existsSync(gz)){
    const url=`https://files.data.gouv.fr/geo-dvf/latest/csv/${year}/departements/${DVF_DEPT}.csv.gz`;
    await fsp.writeFile(gz,await fetchBuffer(url));
  }
  const byMutation=new Map();
  const stream=fs.createReadStream(gz).pipe(zlib.createGunzip());
  const rl=readline.createInterface({input:stream,crlfDelay:Infinity});
  let headers=null,idx={};
  for await(const line of rl){
    if(!headers){headers=parseCsvLine(line).map(x=>x.trim());headers.forEach((h,i)=>idx[h]=i);continue;}
    const vals=parseCsvLine(line);const nature=normalizeNature(lineValue(vals,idx,'nature_mutation'));if(nature!=='Vente')continue;
    const type=canonicalType(lineValue(vals,idx,'type_local'));const price=num(lineValue(vals,idx,'valeur_fonciere'));const date=lineValue(vals,idx,'date_mutation');
    const id=lineValue(vals,idx,'id_mutation');const lat=num(lineValue(vals,idx,'latitude'),NaN);const lon=num(lineValue(vals,idx,'longitude'),NaN);const area=num(lineValue(vals,idx,'surface_reelle_bati'));const land=num(lineValue(vals,idx,'surface_terrain'));const rooms=num(lineValue(vals,idx,'nombre_pieces_principales'));const parcel=lineValue(vals,idx,'id_parcelle');
    if(!(price>0&&Number.isFinite(lat)&&Number.isFinite(lon)))continue;
    const row={id,date,nature,type_local:type,price,area,land,rooms,lat,lon,parcel,street:String(lineValue(vals,idx,'adresse_nom_voie')||'').trim(),number:String(lineValue(vals,idx,'adresse_numero')||'').trim(),city:String(lineValue(vals,idx,'nom_commune')||'').trim(),postal:String(lineValue(vals,idx,'code_postal')||'').trim()};
    const key=id||`${date}|${row.number}|${row.street}|${parcel}`;if(!byMutation.has(key))byMutation.set(key,[]);byMutation.get(key).push(row);
  }
  const rows=[];
  for(const parts of byMutation.values()){
    const eligible=parts.filter(x=>['Maison','Appartement','Dépendance','Local industriel. commercial ou assimilé','Parcelle'].includes(x.type_local));
    if(!eligible.length)continue;
    if(eligible.length===1){rows.push(eligible[0]);continue;}
    const types=[...new Set(eligible.map(x=>x.type_local))];
    if(types.length===1&&['Maison','Appartement','Dépendance'].includes(types[0]))continue;
  }
  CACHE.set(year,rows);return rows;
}

async function geocode(address){
  const key=String(address||'').trim().toLowerCase();if(GEO_CACHE.has(key))return GEO_CACHE.get(key);
  const url='https://data.geopf.fr/geocodage/search?'+new URLSearchParams({q:address,limit:'1'});const r=await fetch(url,{headers:{'User-Agent':'JML-Immobilier-Estimateur/8.0'}});if(!r.ok)throw new Error(`Géocodage IGN HTTP ${r.status}`);
  const j=await r.json();const f=j?.features?.[0];if(!f?.geometry?.coordinates)throw new Error('Adresse introuvable. Vérifiez l’adresse et le code postal.');
  const p={longitude:num(f.geometry.coordinates[0],NaN),latitude:num(f.geometry.coordinates[1],NaN),label:f.properties?.label||address,city:f.properties?.city||'',postcode:f.properties?.postcode||''};GEO_CACHE.set(key,p);return p;
}
function typeRows(all,type){const cfg=TYPE_CONFIG[type];if(!cfg)return[];if(type==='building')return all.filter(x=>x.type_local==='Maison'||x.type_local==='Appartement');return all.filter(x=>cfg.dvf.includes(x.type_local));}
function metricValue(tx,type){const cfg=TYPE_CONFIG[type];if(cfg?.ppsm)return tx.area>0?tx.price/tx.area:null;return tx.price>0?tx.price:null;}
function metricLabel(type){return TYPE_CONFIG[type]?.ppsm?'€/m²':'prix de mutation';}

// Récence volontairement forte : les ventes récentes dominent, sans jeter brutalement
// une vente à 25 mois si elle est utile comme contrôle (elle est néanmoins exclue).
function recencyFactor(date){const m=ageMonths(date);if(m==null||m>MAX_COMPARABLE_AGE_MONTHS)return 0;if(m<=3)return 1;if(m<=6)return .95;if(m<=12)return .85;if(m<=18)return .65;return .40;}
function areaSimilarity(a,b){if(a<=0||b<=0)return .35;const ratio=Math.min(a,b)/Math.max(a,b);return clamp(Math.pow(ratio,1.8),0,1);}
function roomSimilarity(a,b){if(a<=0||b<=0)return .65;return Math.exp(-Math.abs(a-b)/1.25);}
function landSimilarity(a,b){if(a<=0||b<=0)return .65;const ratio=Math.min(a,b)/Math.max(a,b);return clamp(Math.pow(ratio,.65),0,1);}
function distanceSimilarity(km){return Math.exp(-km/.60);}
function typeScore(tx,s){const cfg=TYPE_CONFIG[s.type];if(!cfg?.dvf?.includes(tx.type_local))return 0;return s.type==='building'?.65:1;}

function scoreComparable(tx,s){
  const d=haversine(s.latitude,s.longitude,tx.lat,tx.lon);if(d==null)return{score:0,weight:0,distanceKm:null,recencyFactor:0};
  const rec=recencyFactor(tx.date);if(rec<=0)return{score:0,weight:0,distanceKm:d,recencyFactor:0};
  const ts=typeScore(tx,s);if(ts<=0)return{score:0,weight:0,distanceKm:d,recencyFactor:rec};
  const area=areaSimilarity(tx.area,s.area);const rooms=roomSimilarity(tx.rooms,s.rooms);const land=landSimilarity(tx.land,s.land);const dist=distanceSimilarity(d);
  // Les critères absents ne doivent pas pénaliser artificiellement une vente DVF.
  const parts=[{v:ts,w:25},{v:dist,w:25},{v:area,w:22}];
  if(s.rooms>0&&tx.rooms>0)parts.push({v:rooms,w:10});
  if(s.land>0&&tx.land>0)parts.push({v:land,w:8});
  const used=parts.reduce((a,x)=>a+x.w,0);let raw=parts.reduce((a,x)=>a+x.v*x.w,0)/used*100;
  // Bonus limité pour une vente très récente et très proche, sans jamais dépasser 100.
  if(d<=.15)raw+=3;if(rec===1)raw+=2;
  const score=Math.round(clamp(raw,0,100));
  const weight=(score/100)**3*rec;
  return{score,weight,distanceKm:d,recencyFactor:rec};
}

function filterAge(rows){return rows.filter(x=>{const m=ageMonths(x.date);return m!=null&&m<=MAX_COMPARABLE_AGE_MONTHS;});}
function surfaceHardFilter(rows,s){
  if(!TYPE_CONFIG[s.type]?.ppsm||s.area<=0)return rows;
  const min=s.area*.50,max=s.area*1.60;
  const strict=rows.filter(x=>x.area>=s.area*.65&&x.area<=s.area*1.35);
  if(strict.length>=5)return strict;
  return rows.filter(x=>x.area>=min&&x.area<=max);
}

function adaptiveComparables(rows,s){
  const ageRows=filterAge(rows);const surfaceRows=surfaceHardFilter(ageRows,s);
  const scored=surfaceRows.map(tx=>({...tx,...scoreComparable(tx,s),metric:metricValue(tx,s.type)})).filter(x=>x.distanceKm!=null&&x.weight>0&&Number.isFinite(x.metric)&&x.metric>0);
  if(!scored.length)return{items:[],radiusKm:null,allScored:[]};
  const radii=[.20,.40,.75,1.25,2,3,5];
  let candidates=[];let used=5;
  // Priorité à un noyau local de 5 à 12 ventes de bonne qualité.
  for(const r of radii){const c=scored.filter(x=>x.distanceKm<=r&&x.score>=65).sort((a,b)=>b.weight-a.weight);if(c.length>=5){candidates=c;used=r;break;}}
  if(!candidates.length)candidates=scored.filter(x=>x.distanceKm<=5).sort((a,b)=>b.weight-a.weight);
  const direct=candidates.filter(x=>x.score>=78);
  const selected=(direct.length>=4?direct:candidates).slice(0,12);
  return{items:selected,radiusKm:used,allScored:scored};
}

function iqrFilter(items){
  if(items.length<5)return{items,mode:'échantillon court'};
  const values=items.map(x=>x.metric).filter(Number.isFinite);const q1=percentile(values,.25),q3=percentile(values,.75),iqr=q3-q1;if(!Number.isFinite(iqr)||iqr<=0)return{items,mode:'dispersion faible'};
  const lo=q1-1.5*iqr,hi=q3+1.5*iqr;const kept=items.filter(x=>x.metric>=lo&&x.metric<=hi);return{items:kept.length>=4?kept:items,mode:kept.length>=4?'IQR robuste':'IQR non appliqué'};
}
function weightedMedian(items){const rows=items.filter(x=>x.weight>0&&x.metric>0).sort((a,b)=>a.metric-b.metric);if(!rows.length)return null;const total=rows.reduce((s,x)=>s+x.weight,0);let acc=0;for(const x of rows){acc+=x.weight;if(acc>=total/2)return x.metric;}return rows.at(-1).metric;}
function localStats(items){const values=items.map(x=>x.metric).filter(Number.isFinite);const med=median(values),q1=percentile(values,.25),q3=percentile(values,.75);return{median:med,q1,q3,count:values.length,dispersion:med&&q1!=null&&q3!=null?(q3-q1)/med:null};}

// Contrôle de tendance : uniquement local et uniquement lorsqu'il existe assez de ventes.
// Il sert à normaliser les comparables entre périodes, pas à remplacer les ventes DVF.
function buildLocalTrend(rows,type,subject){
  const local=rows.filter(x=>haversine(subject.latitude,subject.longitude,x.lat,x.lon)!=null&&haversine(subject.latitude,subject.longitude,x.lat,x.lon)<=2&&Number.isFinite(metricValue(x,type))&&metricValue(x,type)>0&&recencyFactor(x.date)>0);
  const buckets=new Map();
  for(const x of local){const d=new Date(x.date);const key=`${d.getFullYear()}-Q${Math.floor(d.getMonth()/3)+1}`;if(!buckets.has(key))buckets.set(key,{date:new Date(d.getFullYear(),Math.floor(d.getMonth()/3)*3,1),values:[]});buckets.get(key).values.push(metricValue(x,type));}
  const series=[...buckets.values()].filter(x=>x.values.length>=3).sort((a,b)=>a.date-b.date);
  if(series.length<3)return{factorFor:()=>1,available:false,label:'Tendance locale non calculée (volume insuffisant)',series:[]};
  const last=median(series.at(-1).values);const prev=median(series.at(-2).values);if(!(last>0&&prev>0))return{factorFor:()=>1,available:false,label:'Tendance locale non calculée',series};
  const quarterly=clamp(last/prev,.94,1.06);
  const factorFor=date=>{const d=new Date(date);const idx=series.findIndex(q=>d.getFullYear()===q.date.getFullYear()&&d.getMonth()===q.date.getMonth());if(idx<0)return 1;const periods=Math.max(0,series.length-1-idx);return clamp(Math.pow(quarterly,periods),.88,1.12);};
  return{factorFor,available:true,label:`Tendance locale basée sur ${series.length} trimestres`,series};
}

function jmlAdjustments(s){
  const dpe={A:.02,B:.015,C:.0075,D:0,E:-.015,F:-.035,G:-.055};const condition={excellent:.025,very_good:.015,good:0,refresh:-.02,major_work:-.05};let pct=0;const lines=[];
  if(dpe[s.dpe]!=null){pct+=dpe[s.dpe];lines.push({label:`DPE ${s.dpe}`,pct:dpe[s.dpe],kind:'indicative'});}if(condition[s.condition]!=null){pct+=condition[s.condition];lines.push({label:'État du bien',pct:condition[s.condition],kind:'indicative'});}
  const feats=[['Garage','garage',.015],['Parking','parking',.006],['Cave','cellar',.005],['Terrasse','terrace',.008],['Cour / patio','patio',.006],['Belle vue','niceView',.008]];for(const [label,key,val] of feats)if(s[key]){pct+=val;lines.push({label,pct:val,kind:'indicative'});}return{pct,lines};
}
function buildConfidence(items,filtered,radiusKm,local){const count=filtered.length;const avgScore=count?filtered.reduce((s,x)=>s+x.score,0)/count:0;const avgDist=count?filtered.reduce((s,x)=>s+x.distanceKm,0)/count:null;const avgAge=count?filtered.reduce((s,x)=>s+(ageMonths(x.date)||24),0)/count:null;const dispersion=local.dispersion==null?.35:local.dispersion;let score=25+clamp(count*3,0,24)+clamp(avgScore*.30,0,25)+(avgDist==null?0:clamp(18-avgDist*6,0,18))+(avgAge==null?0:clamp(12-avgAge/3,0,12))+clamp(16-dispersion*35,0,16);score=Math.round(clamp(score,0,100));const level=score>=85?'Très forte':score>=70?'Forte':score>=55?'Moyenne':score>=40?'Limitée':'Insuffisante';return{score,level,avgScore,avgDist,avgAgeMonths:avgAge,dispersion};}
function formatSignal(name,value,weight,reason){return{name,value,weight,reason};}
function validatePayload(p){const type=String(p.realtyType||'');const cfg=TYPE_CONFIG[type];if(!cfg)throw new Error('Type de bien non pris en charge.');if(!p.address)throw new Error('L’adresse est obligatoire.');if(cfg.built&&!(num(p.livingArea)>0))throw new Error('La surface bâtie/habitable est obligatoire pour ce type de bien.');if(!cfg.built&&type!=='other'&&!(num(p.landArea)>0||num(p.livingArea)>0))throw new Error('Renseignez la surface du terrain ou la surface du bien.');}

async function estimate(payload){
  validatePayload(payload);const geo=await geocode(payload.address);const type=payload.realtyType;if(TYPE_CONFIG[type].special==='manual')return{version:'8.0.0-PRO-DVF',manual:true,message:'Ce type de bien nécessite une analyse manuelle ou une source DVF spécifique.',geo,subject:payload};
  const area=num(payload.livingArea),land=num(payload.landArea),rooms=num(payload.rooms);const all=[];const loaded=[];const errors=[];
  for(const year of DVF_YEARS){try{all.push(...await loadYear(year));loaded.push(year);}catch(e){errors.push(`${year}: ${e.message}`);}}
  const cfg=TYPE_CONFIG[type];let rows=typeRows(all,type).map(x=>({...x,metric:metricValue(x,type)})).filter(x=>x.price>0&&Number.isFinite(x.metric)&&x.metric>0&&(cfg.built?x.area>0&&x.metric<=50000:true));
  rows=filterAge(rows);if(!rows.length)throw new Error(`Aucune vente DVF de type comparable dans les ${MAX_COMPARABLE_AGE_MONTHS} derniers mois.`);
  const subject={...payload,latitude:geo.latitude,longitude:geo.longitude,type,area,land,rooms};const trend=buildLocalTrend(rows,type,subject);const selection=adaptiveComparables(rows,subject);
  if(selection.items.length<3)throw new Error(`Moins de 3 comparables exploitables dans les ${MAX_COMPARABLE_AGE_MONTHS} derniers mois. Élargissement manuel recommandé.`);
  // Normalisation temporelle locale, plafonnée pour éviter qu'une tendance fragile domine la comparaison.
  const normalized=selection.items.map(x=>({...x,rawMetric:x.metric,trendFactor:trend.factorFor(x.date),metric:x.metric*trend.factorFor(x.date)}));
  const filtered=iqrFilter(normalized);const local=localStats(filtered.items);const weighted=weightedMedian(filtered.items);if(!weighted)throw new Error('Impossible de calculer une médiane pondérée fiable.');
  const jml=jmlAdjustments(subject);const baseValue=cfg.ppsm?weighted*area:weighted;const correctedValue=baseValue*(1+jml.pct);const main=round1000(correctedValue);
  const conf=buildConfidence(selection.items,filtered.items,selection.radiusKm,local);const spread=clamp(.06+(100-conf.score)/100*.15+(local.dispersion||0)*.18,.06,.24);const low=round1000(main*(1-spread)),high=round1000(main*(1+spread));
  const direct=filtered.items.filter(x=>x.score>=78).length;const marketControl=cfg.ppsm?local.median*area:local.median;const divergence=marketControl>0?Math.abs(marketControl-baseValue)/marketControl:null;const warning=divergence!=null&&divergence>.15?'Écart supérieur à 15 % entre le niveau local et la sélection des comparables : contrôle manuel conseillé.':null;
  const displayed=filtered.items.slice().sort((a,b)=>b.weight-a.weight).slice(0,15).map(x=>({date:x.date,price:x.price,sqmPrice:cfg.ppsm?round100(x.rawMetric):null,metric:round100(x.metric),livingArea:x.area,landArea:x.land,rooms:x.rooms,distanceKm:Number(x.distanceKm.toFixed(2)),score:x.score,influence:x.weight,streetName:x.street,streetNumber:x.number,nature:x.nature,type:x.type_local,recencyFactor:x.recencyFactor,trendFactor:x.trendFactor}));
  const totalWeight=filtered.items.reduce((s,x)=>s+x.weight,0)||1;displayed.forEach(x=>x.influence=Number((x.influence/totalWeight*100).toFixed(1)));
  const signals=[formatSignal('Comparables DVF pondérés',round100(baseValue),100,`${filtered.items.length} ventes retenues sur une fenêtre maximale de ${MAX_COMPARABLE_AGE_MONTHS} mois`),formatSignal('Contrôle médiane locale',round100(marketControl),0,'Contrôle statistique ; non additionné au prix final')];
  if(trend.available)signals.push(formatSignal('Tendance locale',round100(baseValue),0,trend.label+' ; utilisée uniquement pour normaliser les comparables'));
  return{version:'8.0.0-PRO-DVF',manual:false,estimate:main,low,high,spread,confidence:conf.score,confidenceLevel:conf.level,method:`DVF réelles → fenêtre ${MAX_COMPARABLE_AGE_MONTHS} mois → filtre surface/localisation → score de similarité → pondération récence → normalisation locale → filtre IQR → médiane pondérée → corrections JML indicatives.`,data:{department:DVF_DEPT,years:loaded,millime:DATA_MILLIME,source:'DVF+ open-data / DGFiP'},selection:{radiusKm:selection.radiusKm,totalCandidates:selection.allScored.length,retained:filtered.items.length,directComparables:direct,filter:filtered.mode,maxAgeMonths:MAX_COMPARABLE_AGE_MONTHS},statistics:{metricLabel:metricLabel(type),weightedMetric:weighted,medianMetric:local.median,q1:local.q1,q3:local.q3,dispersion:local.dispersion,marketControlValue:marketControl,baseValue,adjustmentPct:jml.pct},adjustments:jml.lines,divergencePct:divergence==null?null:Math.round(divergence*100),warning,sources:signals,comparables:{data:displayed,total:filtered.items.length},trend:{available:trend.available,label:trend.label,quarters:trend.series.map(q=>({quarter:q.date.toISOString().slice(0,7),median:median(q.values),count:q.values.length}))},geo,errors};
}

app.get('/api/health',(req,res)=>res.json({ok:true,version:'8.0.0-PRO-DVF',department:DVF_DEPT,years:DVF_YEARS,millime:DATA_MILLIME,maxComparableAgeMonths:MAX_COMPARABLE_AGE_MONTHS}));
app.post('/api/analyze',async(req,res)=>{try{res.json(await estimate(req.body||{}));}catch(e){res.status(400).json({error:e.message||'Erreur inconnue',version:'8.0.0-PRO-DVF'});}});
if(require.main===module)app.listen(PORT,()=>console.log(`JML Estimateur V8.0 PRO DVF — http://localhost:${PORT}`));
module.exports={median,percentile,adaptiveComparables,iqrFilter,weightedMedian,buildConfidence,jmlAdjustments,buildLocalTrend,TYPE_CONFIG,estimate};
