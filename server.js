// JML Estimateur — moteur de comparaison DVF "feuille blanche"
// Principe : transactions réelles -> comparables stricts -> normalisation temporelle
// locale -> correction de taille -> médiane pondérée -> contrôle indépendant.
// Aucune API Immo Data payante. Le prix propriétaire n'entre jamais dans le calcul.

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');
const readline = require('readline');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DVF_DEPT = String(process.env.DVF_DEPT || '08').padStart(2,'0');
const DVF_YEARS = (process.env.DVF_YEARS || '2025,2024,2023,2022')
  .split(',').map(Number).filter(Number.isInteger);
const MAX_AGE_MONTHS = Number(process.env.MAX_COMPARABLE_AGE_MONTHS || 24);
const RANGE_EUR = Number(process.env.ESTIMATE_RANGE_EUR || 20000);
const DATA_DIR = path.join(__dirname,'data');
const PUBLIC_DIR = path.join(__dirname,'public');
const CACHE = new Map();
const GEO_CACHE = new Map();
const DOWNLOAD_TIMEOUT_MS = 120000;
const DATA_MILLIME = process.env.DVF_MILLIME || 'avril 2026';

app.use(express.json({limit:'100kb'}));
app.use(express.static(PUBLIC_DIR,{etag:false,lastModified:false,maxAge:0}));
app.get('/',(_,res)=>res.sendFile(path.join(PUBLIC_DIR,'index.html')));

const TYPE_CONFIG = {
  house:{label:'Maison',dvf:['Maison'],ppsm:true,built:true},
  apartment:{label:'Appartement',dvf:['Appartement'],ppsm:true,built:true},
  building:{label:'Immeuble',dvf:['Maison','Appartement'],ppsm:true,built:true},
  land:{label:'Terrain constructible',dvf:['Parcelle'],ppsm:false,built:false},
  agricultural_land:{label:'Terrain agricole',dvf:['Parcelle'],ppsm:false,built:false},
  garage:{label:'Garage / dépendance',dvf:['Dépendance'],ppsm:false,built:false},
  parking:{label:'Parking',dvf:['Dépendance'],ppsm:false,built:false},
  commercial:{label:'Local commercial',dvf:['Local industriel. commercial ou assimilé'],ppsm:true,built:true},
  industrial:{label:'Local industriel. commercial ou assimilé',dvf:['Local industriel. commercial ou assimilé'],ppsm:true,built:true},
  other:{label:'Autre',dvf:[],ppsm:false,built:false}
};

function num(v,d=0){const n=Number(String(v??'').replace(',','.').trim());return Number.isFinite(n)?n:d;}
function clamp(x,a,b){return Math.min(b,Math.max(a,x));}
function median(a){const x=a.filter(Number.isFinite).sort((a,b)=>a-b);if(!x.length)return null;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function percentile(a,p){const x=a.filter(Number.isFinite).sort((a,b)=>a-b);if(!x.length)return null;const i=(x.length-1)*p,l=Math.floor(i),h=Math.ceil(i);return l===h?x[l]:x[l]+(x[h]-x[l])*(i-l);}
function round100(x){return Math.round(x/100)*100;}
function round1000(x){return Math.round(x/1000)*1000;}
function parseCsvLine(line){const out=[];let cur='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(c===','&&!q){out.push(cur);cur='';}else cur+=c;}out.push(cur);return out;}
function lineValue(vals,idx,key){return idx[key]==null?'':vals[idx[key]];}
function haversine(a,b,c,d){if(![a,b,c,d].every(Number.isFinite))return null;const r=Math.PI/180,R=6371,dl=(c-a)*r,dn=(d-b)*r,x=Math.sin(dl/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin(dn/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
function ageMonths(date,now=Date.now()){const t=new Date(date).getTime();return Number.isFinite(t)?Math.max(0,(now-t)/(30.4375*864e5)):null;}
function quarterKey(date){const d=new Date(date);return Number.isFinite(d.getTime())?`${d.getFullYear()}-Q${Math.floor(d.getMonth()/3)+1}`:null;}
function quarterIndex(key){if(!key)return null;const [y,q]=key.split('-Q').map(Number);return y*4+(q-1);}
function canonicalType(raw){const s=String(raw||'').trim().toLowerCase();if(s==='maison')return'Maison';if(s==='appartement')return'Appartement';if(s==='dépendance'||s==='dependance')return'Dépendance';if(s.includes('local industriel'))return'Local industriel. commercial ou assimilé';if(s==='parcelle')return'Parcelle';return raw;}

async function fetchBuffer(url){
  const ac=new AbortController();const timer=setTimeout(()=>ac.abort(),DOWNLOAD_TIMEOUT_MS);
  try{const r=await fetch(url,{signal:ac.signal,headers:{'User-Agent':'JML-Estimateur-DVF/8.0'}});if(!r.ok)throw new Error(`DVF HTTP ${r.status}`);return Buffer.from(await r.arrayBuffer());}
  finally{clearTimeout(timer);}
}

async function loadYear(year){
  if(CACHE.has(year))return CACHE.get(year);
  await fsp.mkdir(DATA_DIR,{recursive:true});
  const file=path.join(DATA_DIR,`dvf_${DVF_DEPT}_${year}.csv.gz`);
  if(!fs.existsSync(file)){
    const url=`https://files.data.gouv.fr/geo-dvf/latest/csv/${year}/departements/${DVF_DEPT}.csv.gz`;
    await fsp.writeFile(file,await fetchBuffer(url));
  }
  const stream=fs.createReadStream(file).pipe(zlib.createGunzip());
  const rl=readline.createInterface({input:stream,crlfDelay:Infinity});
  let idx=null;const mutations=new Map();
  for await(const line of rl){
    if(!idx){const h=parseCsvLine(line).map(x=>x.trim());idx={};h.forEach((x,i)=>idx[x]=i);continue;}
    const v=parseCsvLine(line);
    if(lineValue(v,idx,'nature_mutation')!=='Vente')continue;
    const type=canonicalType(lineValue(v,idx,'type_local'));
    const price=num(lineValue(v,idx,'valeur_fonciere'));
    const date=lineValue(v,idx,'date_mutation');
    const lat=num(lineValue(v,idx,'latitude'),NaN),lon=num(lineValue(v,idx,'longitude'),NaN);
    if(!(price>0&&Number.isFinite(lat)&&Number.isFinite(lon)&&date))continue;
    const row={
      id:lineValue(v,idx,'id_mutation'),date,price,type_local:type,
      area:num(lineValue(v,idx,'surface_reelle_bati')),
      land:num(lineValue(v,idx,'surface_terrain')),
      rooms:num(lineValue(v,idx,'nombre_pieces_principales')),
      lat,lon,
      street:String(lineValue(v,idx,'adresse_nom_voie')||'').trim(),
      number:String(lineValue(v,idx,'adresse_numero')||'').trim(),
      city:String(lineValue(v,idx,'nom_commune')||'').trim(),
      postal:String(lineValue(v,idx,'code_postal')||'').trim(),
      parcel:String(lineValue(v,idx,'id_parcelle')||'').trim()
    };
    const key=row.id||`${row.date}|${row.number}|${row.street}|${row.parcel}`;
    if(!mutations.has(key))mutations.set(key,[]);
    mutations.get(key).push(row);
  }
  const rows=[];
  for(const parts of mutations.values()){
    // Une mutation multi-unités ne permet pas d'attribuer proprement le prix global
    // à chaque bien : elle est donc exclue plutôt que répartie arbitrairement.
    const usable=parts.filter(x=>TYPE_CONFIG.house.dvf.concat(TYPE_CONFIG.apartment.dvf,['Dépendance','Parcelle','Local industriel. commercial ou assimilé']).includes(x.type_local));
    if(usable.length!==1)continue;
    rows.push(usable[0]);
  }
  CACHE.set(year,rows);return rows;
}

async function geocode(address){
  const key=address.trim().toLowerCase();
  if(GEO_CACHE.has(key))return GEO_CACHE.get(key);
  const url='https://data.geopf.fr/geocodage/search?'+new URLSearchParams({q:address,limit:'1'});
  const r=await fetch(url,{headers:{'User-Agent':'JML-Estimateur-DVF/8.0'}});
  if(!r.ok)throw new Error(`Géocodage IGN HTTP ${r.status}`);
  const j=await r.json(),f=j?.features?.[0];
  if(!f?.geometry?.coordinates)throw new Error('Adresse introuvable.');
  const p={longitude:num(f.geometry.coordinates[0],NaN),latitude:num(f.geometry.coordinates[1],NaN),label:f.properties?.label||address};
  GEO_CACHE.set(key,p);return p;
}

function typeRows(rows,type){const cfg=TYPE_CONFIG[type];if(!cfg)return[];if(type==='building')return rows.filter(x=>x.type_local==='Maison'||x.type_local==='Appartement');return rows.filter(x=>cfg.dvf.includes(x.type_local));}
function ppsm(tx){return tx.area>0?tx.price/tx.area:null;}
function ratioSimilarity(a,b){if(!(a>0&&b>0))return null;const r=Math.max(a,b)/Math.min(a,b);return Math.exp(-Math.abs(Math.log(r))/0.30);}
function numericSimilarity(a,b,scale){if(!(a>0&&b>0))return null;return Math.exp(-Math.abs(a-b)/scale);}
function recencyWeight(age){if(age==null)return 0.4;if(age<=3)return 1;if(age<=6)return .95;if(age<=12)return .85;if(age<=18)return .65;return .40;}

function robustTrend(rows,subjectDate=new Date()){
  const groups=new Map();
  for(const x of rows){
    const q=quarterKey(x.date),v=ppsm(x);
    if(!q||!(v>0))continue;
    if(!groups.has(q))groups.set(q,[]);
    groups.get(q).push(v);
  }
  const points=[...groups.entries()].map(([q,v])=>({q,idx:quarterIndex(q),value:median(v),n:v.length})).filter(x=>x.value>0).sort((a,b)=>a.idx-b.idx);
  if(points.length<3)return {factor:1,annualPct:0,quality:'insuffisante',points};
  // Régression robuste simple sur log(médiane €/m²) vs trimestre.
  const slopes=[];
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
    const dx=points[j].idx-points[i].idx;if(dx)slopes.push((Math.log(points[j].value)-Math.log(points[i].value))/dx);
  }
  const slope=median(slopes)||0;
  const currentQuarter=quarterIndex(quarterKey(subjectDate.toISOString().slice(0,10)));
  const last=points.at(-1);
  const deltaQ=currentQuarter-last.idx;
  const factor=Math.exp(slope*deltaQ);
  // Protection contre une tendance qui dominerait les transactions.
  const capped=clamp(factor,0.92,1.08);
  const annualPct=(Math.exp(slope*4)-1)*100;
  return {factor:capped,annualPct:clamp(annualPct,-30,30),quality:points.length>=5?'bonne':'correcte',points};
}

function estimateSizeElasticity(rows){
  let pts=rows.filter(x=>x.area>0&&ppsm(x)>0).map(x=>[Math.log(x.area),Math.log(ppsm(x))]);
  if(pts.length<8)return 0;
  // Limite volontairement le calcul : l'élasticité doit être locale, pas une
  // régression quadratique sur plusieurs dizaines de milliers de transactions.
  pts.sort((a,b)=>a[0]-b[0]);
  if(pts.length>260){
    const step=(pts.length-1)/259;
    pts=Array.from({length:260},(_,i)=>pts[Math.round(i*step)]);
  }
  const slopes=[];
  for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++){
    const dx=pts[j][0]-pts[i][0];if(Math.abs(dx)>0.05)slopes.push((pts[j][1]-pts[i][1])/dx);
  }
  return clamp(median(slopes)||0,-0.35,0.10);
}

function buildCandidates(rows,subject,trend){
  const out=[];
  for(const tx of rows){
    const age=ageMonths(tx.date);
    if(age==null||age>MAX_AGE_MONTHS)continue;
    const distance=haversine(subject.latitude,subject.longitude,tx.lat,tx.lon);
    if(distance==null||distance>2.5)continue;
    if(subject.area>0&&tx.area>0){
      const ratio=tx.area/subject.area;
      if(ratio<0.50||ratio>1.80)continue;
    }
    const a=subject.area>0&&tx.area>0?ratioSimilarity(tx.area,subject.area):0.65;
    const r=subject.rooms>0&&tx.rooms>0?numericSimilarity(tx.rooms,subject.rooms,1.4):0.65;
    const l=subject.land>0&&tx.land>0?ratioSimilarity(tx.land,subject.land):0.65;
    const d=Math.exp(-distance/0.35);
    const rec=recencyWeight(age);
    const exactType=(subject.type==='building'||tx.type_local===TYPE_CONFIG[subject.type]?.dvf?.[0])?1:0.45;
    let score=25*exactType+22*d+22*a+10*r+10*l+11*rec;
    // Une transaction très éloignée n'est jamais sauvée par les autres critères.
    if(distance>1)score*=0.75;
    const weight=Math.max(0.001,(score/100)**3*rec*(1/(1+distance*2)));
    out.push({...tx,distanceKm:distance,ageMonths:age,score:Math.round(score),weight});
  }
  out.sort((a,b)=>b.score-a.score||a.distanceKm-b.distanceKm);
  return out;
}

function chooseCandidates(all,subject){
  const radii=[0.15,0.30,0.50,0.80,1.20,1.50,2.00,2.50];
  let chosen=[];
  let radiusUsed=2;
  for(const r of radii){
    const x=all.filter(t=>t.distanceKm<=r&&t.score>=68);
    if(x.length>=5){chosen=x;radiusUsed=r;break;}
  }
  if(!chosen.length)chosen=all.filter(t=>t.score>=58).slice(0,12);
  if(!chosen.length)chosen=all.slice(0,8);
  // Maximum 12, mais priorité aux meilleurs scores.
  chosen=chosen.sort((a,b)=>b.score-a.score||a.distanceKm-b.distanceKm).slice(0,12);
  return {items:chosen,radiusKm:radiusUsed};
}

function normalizeCandidates(items,subject,elasticity,trend){
  return items.map(x=>{
    const raw=ppsm(x);
    const timeFactor=trendFactorForTransaction(x.date,trend);
    // Ramène chaque transaction à la date d'estimation.
    const timeAdjusted=raw*timeFactor;
    // Corrige l'effet de taille observé localement : ppsm_adj = ppsm * (surface_cible/surface_vente)^beta.
    const sizeFactor=(subject.area>0&&x.area>0)?Math.pow(subject.area/x.area,elasticity):1;
    const normalized=timeAdjusted*sizeFactor;
    return {...x,rawPpsm:raw,timeFactor,sizeFactor,normalizedPpsm:normalized};
  });
}
function trendFactorForTransaction(date,trend){
  if(!trend?.points?.length)return 1;
  const q=quarterIndex(quarterKey(date));const cq=quarterIndex(quarterKey(new Date().toISOString().slice(0,10)));
  // Reconstitue le facteur via la pente implicite à partir des deux extrêmes.
  if(trend.points.length<2)return 1;
  const p1=trend.points[0],p2=trend.points.at(-1);
  const slope=(Math.log(p2.value)-Math.log(p1.value))/Math.max(1,p2.idx-p1.idx);
  return clamp(Math.exp(slope*(cq-q)),0.90,1.10);
}

function weightedMedianByNormalized(items){
  const rows=items.filter(x=>x.normalizedPpsm>0).sort((a,b)=>a.normalizedPpsm-b.normalizedPpsm);
  const total=rows.reduce((s,x)=>s+x.weight,0);let acc=0;
  for(const x of rows){acc+=x.weight;if(acc>=total/2)return x.normalizedPpsm;}
  return rows.at(-1)?.normalizedPpsm||null;
}
function iqr(items){
  const v=items.map(x=>x.normalizedPpsm).filter(Number.isFinite);
  if(v.length<5)return {items,mode:'pas assez de ventes'};
  const q1=percentile(v,.25),q3=percentile(v,.75),iqr=q3-q1;
  if(!(iqr>0))return {items,mode:'dispersion faible'};
  const lo=q1-1.5*iqr,hi=q3+1.5*iqr;
  const kept=items.filter(x=>x.normalizedPpsm>=lo&&x.normalizedPpsm<=hi);
  return {items:kept.length>=4?kept:items,mode:kept.length>=4?'IQR robuste':'IQR conservé'};
}

function confidence(items,filtered,trend){
  const n=filtered.length,avg=n?filtered.reduce((s,x)=>s+x.score,0)/n:0;
  const dist=n?filtered.reduce((s,x)=>s+x.distanceKm,0)/n:2;
  const age=n?filtered.reduce((s,x)=>s+x.ageMonths,0)/n:24;
  const vals=filtered.map(x=>x.normalizedPpsm);
  const med=median(vals)||1,q1=percentile(vals,.25),q3=percentile(vals,.75);
  const disp=q1!=null&&q3!=null?(q3-q1)/med:.4;
  let c=25+Math.min(20,n*3)+avg*.35+Math.max(0,15-dist*10)+Math.max(0,12-age/2)+Math.max(0,13-disp*30);
  if(trend.quality==='insuffisante')c-=5;
  c=Math.round(clamp(c,0,100));
  return {score:c,level:c>=85?'Très forte':c>=70?'Forte':c>=55?'Moyenne':c>=40?'Limitée':'Insuffisante',dispersion:disp};
}

function validate(p){
  if(!p.address)throw new Error('L’adresse est obligatoire.');
  if(!TYPE_CONFIG[p.realtyType])throw new Error('Type de bien invalide.');
  const cfg=TYPE_CONFIG[p.realtyType];
  if(cfg.ppsm&&num(p.livingArea)<10)throw new Error('La surface habitable/bâtie est obligatoire.');
  if(!cfg.ppsm&&num(p.livingArea)<=0&&num(p.landArea)<=0)throw new Error('Une surface est obligatoire.');
}

async function estimate(p){
  validate(p);
  const type=p.realtyType,cfg=TYPE_CONFIG[type];
  if(type==='other')return {manual:true,message:'Type non modélisé par DVF : analyse manuelle nécessaire.'};
  const geo=await geocode(p.address);
  const loaded=[],errors=[],all=[];
  for(const y of DVF_YEARS){try{all.push(...await loadYear(y));loaded.push(y);}catch(e){errors.push(`${y}: ${e.message}`);}}
  const rows=typeRows(all,type).filter(x=>x.price>0&&(cfg.ppsm?x.area>0:true));
  const now=new Date();
  const recent=rows.filter(x=>{const a=ageMonths(x.date,now.getTime());return a!=null&&a<=MAX_AGE_MONTHS;});
  if(recent.length<3)throw new Error(`Seulement ${recent.length} ventes de ce type dans les ${MAX_AGE_MONTHS} derniers mois : estimation automatique bloquée.`);
  const subject={...p,latitude:geo.latitude,longitude:geo.longitude,area:num(p.livingArea),land:num(p.landArea),rooms:num(p.rooms)};
  // La tendance et l'effet de taille sont calculés sur le micro-marché,
  // pas sur tout le département : les ventes éloignées ne doivent pas dicter
  // le niveau de prix de l'adresse.
  const nearby=recent.filter(x=>{
    const d=haversine(subject.latitude,subject.longitude,x.lat,x.lon);
    return d!=null && d<=2.5;
  });
  const trendBase=nearby.length>=8?nearby:recent;
  const trend=robustTrend(trendBase,now);
  const elasticity=cfg.ppsm?estimateSizeElasticity(trendBase):0;
  const rawCandidates=buildCandidates(recent,subject,trend);
  if(rawCandidates.length<3){ throw new Error('Pas assez de ventes DVF exploitables dans les 24 mois et 2,5 km pour ce type de bien.'); }
  const selection=chooseCandidates(rawCandidates,subject);
  const normalized=cfg.ppsm?normalizeCandidates(selection.items,subject,elasticity,trend):selection.items.map(x=>({...x,normalizedPpsm:x.price,timeFactor:1,sizeFactor:1}));
  const filtered=cfg.ppsm?iqr(normalized):{items:normalized,mode:'prix direct'};
  if(filtered.items.length<3)throw new Error('Pas assez de comparables après filtrage.');
  const metric=cfg.ppsm?weightedMedianByNormalized(filtered.items):median(filtered.items.map(x=>x.price));
  if(!(metric>0))throw new Error('Impossible de calculer la valeur centrale.');
  const rawEstimate=cfg.ppsm?metric*subject.area:metric;
  // Pas de correction subjective DPE/état dans le prix : ces variables ne sont pas
  // transformées en euros sans calibration statistique locale.
  const estimate=round1000(rawEstimate);
  // Demande utilisateur : écart fixe de 20 000 € autour du point central.
  const low=Math.max(0,round1000(estimate-RANGE_EUR));
  const high=round1000(estimate+RANGE_EUR);
  const conf=confidence(rawCandidates,filtered.items,trend);
  const localMedian=cfg.ppsm?median(filtered.items.map(x=>x.rawPpsm))*subject.area:median(filtered.items.map(x=>x.price));
  const trendValue=cfg.ppsm?metric*subject.area:metric;
  const shown=filtered.items.slice().sort((a,b)=>b.weight-a.weight).map(x=>({
    date:x.date,streetName:x.street,streetNumber:x.number,livingArea:x.area,landArea:x.land,
    price:x.price,sqmPrice:cfg.ppsm?round100(x.rawPpsm):null,
    normalizedSqmPrice:cfg.ppsm?round100(x.normalizedPpsm):null,
    distanceKm:Number(x.distanceKm.toFixed(2)),score:x.score,influence:x.weight,
    ageMonths:Number(x.ageMonths.toFixed(1)),timeFactor:Number(x.timeFactor.toFixed(3)),
    sizeFactor:Number(x.sizeFactor.toFixed(3)),rooms:x.rooms,type:x.type_local
  }));
  const totalW=filtered.items.reduce((s,x)=>s+x.weight,0)||1;
  shown.forEach(x=>x.influence=Number((x.influence/totalW*100).toFixed(1)));
  return {
    version:'8.0.0-FEUILLE-BLANCHE',
    manual:false,estimate,low,high,rangeEur:RANGE_EUR,
    confidence:conf.score,confidenceLevel:conf.level,
    method:'DVF réelles ≤24 mois → type exact → proximité → surface comparable → tendance locale trimestrielle robuste → normalisation temporelle → correction statistique de taille → médiane pondérée → écart fixe ±20 000 €.',
    data:{department:DVF_DEPT,years:loaded,millime:DATA_MILLIME,source:'DVF+ / DGFiP'},
    selection:{radiusKm:selection.radiusKm,totalCandidates:rawCandidates.length,retained:filtered.items.length,directComparables:filtered.items.filter(x=>x.score>=75).length,filter:filtered.mode,windowMonths:MAX_AGE_MONTHS},
    statistics:{
      metricLabel:cfg.ppsm?'€/m²':'prix',
      weightedMetric:metric,localMedianValue:round100(localMedian||0),
      estimateBeforeRounding:rawEstimate,sizeElasticity:Number(elasticity.toFixed(4)),
      trendAnnualPct:Number(trend.annualPct.toFixed(2)),trendFactor:Number(trend.factor.toFixed(4)),
      trendQuality:trend.quality,trendPoints:trend.points.map(x=>({quarter:x.q,median:round100(x.value),sales:x.n})),
      rangeEur:RANGE_EUR
    },
    // Les sources sont des composantes descriptives : la tendance n'est pas ajoutée une seconde fois.
    sources:[
      {name:'Comparables DVF normalisés',value:estimate,weight:100,reason:`${filtered.items.length} ventes retenues ; médiane pondérée après normalisation`},
      {name:'Contrôle médiane locale',value:round100(localMedian||0),weight:0,reason:'Contrôle uniquement, jamais additionné au prix'},
      {name:'Tendance locale',value:round100(trendValue),weight:0,reason:`Tendance trimestrielle ${trend.annualPct>=0?'+':''}${trend.annualPct.toFixed(1)}%/an ; utilisée pour normaliser les transactions, pas comme seconde estimation`}
    ],
    adjustments:[],
    comparables:{data:shown,total:filtered.items.length},
    geo,errors
  };
}

app.get('/api/health',(_,res)=>res.json({ok:true,version:'8.0.0-FEUILLE-BLANCHE',department:DVF_DEPT,years:DVF_YEARS,rangeEur:RANGE_EUR}));
app.post('/api/analyze',async(req,res)=>{try{res.json(await estimate(req.body||{}));}catch(e){res.status(400).json({error:e.message||'Erreur inconnue',version:'8.0.0-FEUILLE-BLANCHE'});}});
if(require.main===module)app.listen(PORT,()=>console.log(`JML Estimateur 8 feuille blanche — port ${PORT}`));
module.exports={estimate,robustTrend,estimateSizeElasticity,buildCandidates,chooseCandidates,weightedMedianByNormalized,TYPE_CONFIG};
