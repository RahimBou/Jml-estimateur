// JML Immobilier — Estimateur V7.4 PRO DVF
// Moteur professionnel : DVF+ géolocalisé, comparables multi-niveaux,
// correction temporelle, gestion des mutations, score de similarité,
// double contrôle et corrections JML clairement séparées des données DVF.
// Aucun appel Immo Data. Aucun crédit payant.

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');
const readline = require('readline');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DVF_DEPT = String(process.env.DVF_DEPT || '08').padStart(2, '0');
const DVF_YEARS = (process.env.DVF_YEARS || '2025,2024,2023,2022')
  .split(',').map(x => Number(x.trim())).filter(Number.isInteger);
const DATA_DIR = path.join(__dirname, 'data');
const CACHE = new Map();
const GEO_CACHE = new Map();
const DOWNLOAD_TIMEOUT_MS = 120000;
const CURRENT_DATA_YEAR = Number(process.env.CURRENT_DATA_YEAR || 2025);
const DATA_MILLIME = process.env.DVF_MILLIME || 'avril 2026';
const ENGINE_VERSION = '7.4.0-PRO-DVF';
const MAX_COMPARABLE_AGE_MONTHS = Number(process.env.MAX_COMPARABLE_AGE_MONTHS || 24);
const RECENT_AGE_MONTHS = Number(process.env.RECENT_AGE_MONTHS || 12);

app.use(express.json({ limit: '100kb' }));
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : path.join(__dirname, 'publique');
app.use(express.static(PUBLIC_DIR, { etag:false, lastModified:false, maxAge:0 }));
app.get('/', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const TYPE_CONFIG = {
  house: { label:'Maison', dvf:['Maison'], built:true, ppsm:true },
  apartment: { label:'Appartement', dvf:['Appartement'], built:true, ppsm:true },
  building: { label:'Immeuble', dvf:['Maison','Appartement'], built:true, ppsm:true, special:'building' },
  land: { label:'Terrain constructible', dvf:['Parcelle'], built:false, ppsm:false, special:'land' },
  agricultural_land: { label:'Terrain agricole', dvf:['Parcelle'], built:false, ppsm:false, special:'agri' },
  garage: { label:'Garage / dépendance', dvf:['Dépendance'], built:false, ppsm:false, special:'dependency' },
  parking: { label:'Parking', dvf:['Dépendance'], built:false, ppsm:false, special:'dependency' },
  commercial: { label:'Local commercial', dvf:['Local industriel. commercial ou assimilé'], built:true, ppsm:true, special:'commercial' },
  industrial: { label:'Local industriel / entrepôt', dvf:['Local industriel. commercial ou assimilé'], built:true, ppsm:true, special:'industrial' },
  other: { label:'Autre bien', dvf:[], built:false, ppsm:false, special:'manual' }
};

function num(v, fallback=0) {
  const x = Number(String(v ?? '').replace(',','.').trim());
  return Number.isFinite(x) ? x : fallback;
}
function clamp(x,a,b){ return Math.min(b,Math.max(a,x)); }
function median(a){ const x=a.filter(Number.isFinite).sort((p,q)=>p-q); if(!x.length)return null; const m=Math.floor(x.length/2); return x.length%2?x[m]:(x[m-1]+x[m])/2; }
function percentile(a,p){ const x=a.filter(Number.isFinite).sort((m,n)=>m-n); if(!x.length)return null; const i=(x.length-1)*p,l=Math.floor(i),h=Math.ceil(i); return l===h?x[l]:x[l]+(x[h]-x[l])*(i-l); }
function round100(x){ return Math.round(x/100)*100; }
function round1000(x){ return Math.round(x/1000)*1000; }
function haversine(lat1,lon1,lat2,lon2){
  if(![lat1,lon1,lat2,lon2].every(Number.isFinite)) return null;
  const R=6371, r=Math.PI/180, dLat=(lat2-lat1)*r, dLon=(lon2-lon1)*r;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function ageMonths(date){ const t=new Date(date).getTime(); return Number.isFinite(t)?Math.max(0,(Date.now()-t)/(30.4375*864e5)):null; }
function parseCsvLine(line){
  const out=[]; let cur='', q=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){ if(q && line[i+1]==='"'){cur+='"';i++;} else q=!q; }
    else if(c===',' && !q){ out.push(cur);cur=''; }
    else cur+=c;
  }
  out.push(cur); return out;
}
async function fetchBuffer(url){
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),DOWNLOAD_TIMEOUT_MS);
  try{
    const r=await fetch(url,{signal:ac.signal,headers:{'User-Agent':'JML-Immobilier-Estimateur/7.4'}});
    if(!r.ok) throw new Error(`DVF HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(timer); }
}
function canonicalType(raw){
  const s=String(raw||'').trim().toLowerCase();
  if(s==='maison') return 'Maison';
  if(s==='appartement') return 'Appartement';
  if(s==='dépendance' || s==='dependance') return 'Dépendance';
  if(s.includes('local industriel')) return 'Local industriel. commercial ou assimilé';
  if(s==='parcelle') return 'Parcelle';
  return raw;
}
function normalizeNature(raw){ return String(raw||'').trim(); }
function isStandardSale(nature){ return nature==='Vente'; }

async function loadYear(year){
  if(CACHE.has(year)) return CACHE.get(year);
  await fsp.mkdir(DATA_DIR,{recursive:true});
  const gz=path.join(DATA_DIR,`dvf_${DVF_DEPT}_${year}.csv.gz`);
  if(!fs.existsSync(gz)){
    const url=`https://files.data.gouv.fr/geo-dvf/latest/csv/${year}/departements/${DVF_DEPT}.csv.gz`;
    await fsp.writeFile(gz,await fetchBuffer(url));
  }
  const byMutation=new Map();
  const stream=fs.createReadStream(gz).pipe(zlib.createGunzip());
  const rl=readline.createInterface({input:stream,crlfDelay:Infinity});
  let headers=null, idx={}; let rawCount=0;
  for await(const line of rl){
    if(!headers){ headers=parseCsvLine(line).map(x=>x.trim()); headers.forEach((h,i)=>idx[h]=i); continue; }
    const nature=normalizeNature(lineValue(parseCsvLine(line),idx,'nature_mutation'));
    if(nature!=='Vente') continue; // moteur principal = ventes classiques uniquement
    const vals=parseCsvLine(line);
    const type=canonicalType(lineValue(vals,idx,'type_local'));
    const price=num(lineValue(vals,idx,'valeur_fonciere'));
    const date=lineValue(vals,idx,'date_mutation');
    const id=lineValue(vals,idx,'id_mutation');
    const lat=num(lineValue(vals,idx,'latitude'),NaN), lon=num(lineValue(vals,idx,'longitude'),NaN);
    const area=num(lineValue(vals,idx,'surface_reelle_bati'));
    const land=num(lineValue(vals,idx,'surface_terrain'));
    const rooms=num(lineValue(vals,idx,'nombre_pieces_principales'));
    const parcel=lineValue(vals,idx,'id_parcelle');
    if(!(price>0 && Number.isFinite(lat) && Number.isFinite(lon))) continue;
    const row={id,date,nature,type_local:type,price,area,land,rooms,lat,lon,parcel,
      street:String(lineValue(vals,idx,'adresse_nom_voie')||'').trim(),
      number:String(lineValue(vals,idx,'adresse_numero')||'').trim(),
      city:String(lineValue(vals,idx,'nom_commune')||'').trim(),
      postal:String(lineValue(vals,idx,'code_postal')||'').trim()};
    const key=id || `${date}|${row.number}|${row.street}|${parcel}`;
    if(!byMutation.has(key)) byMutation.set(key,[]);
    byMutation.get(key).push(row);
  }
  const rows=[];
  for(const parts of byMutation.values()){
    const eligible=parts.filter(x=>x.type_local && TYPE_CONFIG.house.dvf.concat(TYPE_CONFIG.apartment.dvf,['Dépendance','Local industriel. commercial ou assimilé','Parcelle']).includes(x.type_local));
    if(!eligible.length) continue;
    // Pour une mutation multi-biens, on ne divise jamais aveuglément le prix total.
    // Maison/appartement : une seule unité = exploitable. Sinon on conserve seulement
    // les mutations mono-type simples ; les mutations complexes seront exclues du calcul.
    const types=[...new Set(eligible.map(x=>x.type_local))];
    if(eligible.length===1){ rows.push(eligible[0]); continue; }
    if(types.length===1 && ['Maison','Appartement','Dépendance'].includes(types[0])){
      // Plusieurs unités du même type : impossible d'attribuer proprement le prix total.
      continue;
    }
  }
  CACHE.set(year,rows); return rows;
}
function lineValue(vals,idx,key){ return idx[key]==null?'':vals[idx[key]]; }

async function geocode(address){
  const key=String(address||'').trim().toLowerCase();
  if(GEO_CACHE.has(key)) return GEO_CACHE.get(key);
  const url='https://data.geopf.fr/geocodage/search?'+new URLSearchParams({q:address,limit:'1'});
  const r=await fetch(url,{headers:{'User-Agent':'JML-Immobilier-Estimateur/7.2'}});
  if(!r.ok) throw new Error(`Géocodage IGN HTTP ${r.status}`);
  const j=await r.json(); const f=j?.features?.[0];
  if(!f?.geometry?.coordinates) throw new Error('Adresse introuvable. Vérifiez l’adresse et le code postal.');
  const p={longitude:num(f.geometry.coordinates[0],NaN),latitude:num(f.geometry.coordinates[1],NaN),label:f.properties?.label||address,city:f.properties?.city||'',postcode:f.properties?.postcode||''};
  GEO_CACHE.set(key,p); return p;
}

function typeRows(all, type){
  const cfg=TYPE_CONFIG[type];
  if(!cfg) return [];
  if(type==='building') return all.filter(x=>x.type_local==='Maison'||x.type_local==='Appartement');
  return all.filter(x=>cfg.dvf.includes(x.type_local));
}
function metricValue(tx, type){
  const cfg=TYPE_CONFIG[type];
  if(cfg?.ppsm){ return tx.area>0 ? tx.price/tx.area : null; }
  return tx.price>0 ? tx.price : null;
}
function metricLabel(type){ return TYPE_CONFIG[type]?.ppsm ? '€/m²' : 'prix de mutation'; }
function annualMarketFactors(rows,type){
  const byYear=new Map();
  for(const x of rows){
    const y=new Date(x.date).getFullYear(); const v=metricValue(x,type);
    if(!Number.isFinite(y)||!Number.isFinite(v)||v<=0) continue;
    if(!byYear.has(y)) byYear.set(y,[]); byYear.get(y).push(v);
  }
  const years=[...byYear.keys()].sort((a,b)=>b-a); if(years.length<2) return ()=>1;
  const latest=median(byYear.get(years[0]));
  return date=>{
    const y=new Date(date).getFullYear(); const med=byYear.has(y)?median(byYear.get(y)):latest;
    if(!latest||!med) return 1;
    // Correction volontairement plafonnée : elle ne doit pas remplacer une analyse locale.
    return clamp(latest/med,0.88,1.12);
  };
}
function areaSimilarity(a,b){
  if(a<=0||b<=0) return 0.55;
  // Tolérance progressive : 20% d'écart ne doit pas éliminer un comparable pertinent.
  return Math.exp(-Math.abs(a-b)/Math.max(1,b*0.30));
}
function roomSimilarity(a,b){
  if(a<=0||b<=0) return 0.70;
  return Math.exp(-Math.abs(a-b)/1.6);
}
function landSimilarity(a,b){
  if(a<=0||b<=0) return 0.70;
  const ratio=Math.max(a,b)/Math.max(1,Math.min(a,b));
  return Math.exp(-Math.log(ratio)/1.8);
}
function distanceSimilarity(km){
  // Même rue / quelques dizaines de mètres = signal très fort.
  return Math.exp(-km/0.35);
}
function recencySimilarity(date){
  const m=ageMonths(date);
  if(m==null || m>MAX_COMPARABLE_AGE_MONTHS) return 0;
  // Les ventes de moins de 12 mois sont privilégiées. Les ventes de 12 à 24 mois
  // restent utilisables comme filet de sécurité, mais avec une influence moindre.
  return Math.exp(-m/12);
}
function comparableAdjustment(tx,s){
  let factor=1;
  // Normalisation de taille : un petit logement a souvent un €/m² supérieur.
  // On ramène donc légèrement chaque comparable vers la taille du bien cible.
  if(tx.area>0 && s.area>0){
    const ratio=tx.area/s.area;
    factor*=clamp(Math.pow(ratio,0.14),0.88,1.12);
  }
  // Normalisation très légère du nombre de pièces lorsque l'information existe.
  if(tx.rooms>0 && s.rooms>0){
    factor*=clamp(1 + (s.rooms-tx.rooms)*0.018,0.94,1.06);
  }
  return clamp(factor,0.84,1.16);
}
function scoreComparable(tx,s,temporalFn){
  const d=haversine(s.latitude,s.longitude,tx.lat,tx.lon);
  if(d==null)return {score:0,weight:0,distanceKm:null,temporalFactor:1,adjustmentFactor:1,adjustedMetric:null};
  const cfg=TYPE_CONFIG[s.type];
  const typeScore=cfg?.dvf?.includes(tx.type_local)?(s.type==='building' ? 0.65 : 1):0;
  if(typeScore<=0) return {score:0,weight:0,distanceKm:d,temporalFactor:1,adjustmentFactor:1,adjustedMetric:null};
  const a=areaSimilarity(tx.area,s.area);
  const r=roomSimilarity(tx.rooms,s.rooms);
  const l=landSimilarity(tx.land,s.land);
  const dist=distanceSimilarity(d);
  const rec=recencySimilarity(tx.date);
  const tf=temporalFn(tx.date);
  const adjustmentFactor=comparableAdjustment(tx,s);
  const raw=20*typeScore+25*dist+20*rec+15*a+10*r+5*l+5;
  const score=Math.round(clamp(raw,0,100));
  // Pondération non linéaire : les meilleurs comparables dominent sans écraser
  // complètement le reste de l'échantillon.
  const weight=Math.max(0.0001,Math.pow(score/100,3)*tf);
  const adjustedMetric=Number.isFinite(tx.metric) ? tx.metric*adjustmentFactor*tf : null;
  return {score,weight,distanceKm:d,temporalFactor:tf,adjustmentFactor,adjustedMetric};
}
function adaptiveComparables(rows,s){
  const temporalFn=annualMarketFactors(rows,s.type);
  const scored=rows.map(tx=>{ const q=scoreComparable(tx,s,temporalFn); return {...tx,...q,ageMonths:ageMonths(tx.date)}; })
    .filter(x=>x.distanceKm!=null && x.ageMonths!=null && x.ageMonths<=MAX_COMPARABLE_AGE_MONTHS && Number.isFinite(x.metric) && x.metric>0 && Number.isFinite(x.adjustedMetric) && x.adjustedMetric>0);
  // On cherche d'abord la qualité, puis on élargit le rayon si nécessaire.
  const radii=[0.20,0.35,0.50,1,2,3,5];
  let chosen=[]; let used=5;
  for(const r of radii){
    const candidates=scored.filter(x=>x.distanceKm<=r && x.score>=55).sort((a,b)=>b.weight-a.weight);
    if(candidates.length>=8){ chosen=candidates;used=r;break; }
  }
  if(!chosen.length){
    chosen=scored.filter(x=>x.distanceKm<=5).sort((a,b)=>b.score-a.score).slice(0,40);
  }
  // Limite volontaire : un ancien comparable très nombreux ne doit pas diluer
  // les ventes récentes et proches.
  chosen.sort((a,b)=>b.weight-a.weight);
  return {items:chosen.slice(0,30),radiusKm:used};
}
function iqrFilter(items){
  const values=items.map(x=>x.adjustedMetric||x.metric).filter(Number.isFinite);
  if(values.length<5) return {items,mode:'insufficient-sample'};
  const q1=percentile(values,.25),q3=percentile(values,.75),iqr=q3-q1;
  if(!Number.isFinite(iqr)||iqr<=0) return {items,mode:'no-dispersion'};
  const lo=q1-1.5*iqr,hi=q3+1.5*iqr;
  const kept=items.filter(x=>{const v=x.adjustedMetric||x.metric; return v>=lo&&v<=hi;});
  return {items:kept.length>=4?kept:items,mode:kept.length>=4?'IQR':'IQR-fallback'};
}
function weightedMedian(items){
  const rows=items.filter(x=>x.weight>0&&(x.adjustedMetric||x.metric)>0).sort((a,b)=>(a.adjustedMetric||a.metric)-(b.adjustedMetric||b.metric));
  if(!rows.length)return null;
  const total=rows.reduce((s,x)=>s+x.weight,0); let acc=0;
  for(const x of rows){ acc+=x.weight; if(acc>=total/2)return x.adjustedMetric||x.metric; }
  return rows.at(-1).adjustedMetric||rows.at(-1).metric;
}
function localStats(items){
  const values=items.map(x=>x.metric).filter(Number.isFinite);
  const adjusted=items.map(x=>x.adjustedMetric||x.metric).filter(Number.isFinite);
  const med=median(values), q1=percentile(values,.25),q3=percentile(values,.75);
  const adjustedMedian=median(adjusted);
  return {median:med,adjustedMedian,q1,q3,count:values.length,dispersion:med&&q1!=null&&q3!=null?(q3-q1)/med:null};
}
function jmlAdjustments(s){
  // Ces corrections ne sont PAS des coefficients DVF officiels. Elles sont
  // affichées séparément et volontairement modestes. Elles pourront être
  // calibrées statistiquement dans une future version avec données compatibles.
  const dpe={A:0.02,B:0.015,C:0.0075,D:0,E:-0.015,F:-0.035,G:-0.055};
  const condition={excellent:0.025,very_good:0.015,good:0,refresh:-0.02,major_work:-0.05};
  let pct=0; const lines=[];
  if(dpe[s.dpe]!=null){ pct+=dpe[s.dpe]; lines.push({label:`DPE ${s.dpe}`,pct:dpe[s.dpe],kind:'indicative'}); }
  if(condition[s.condition]!=null){ pct+=condition[s.condition]; lines.push({label:'État du bien',pct:condition[s.condition],kind:'indicative'}); }
  const feats=[['Garage','garage',0.015],['Parking','parking',0.006],['Cave','cellar',0.005],['Terrasse','terrace',0.008],['Cour / patio','patio',0.006],['Belle vue','niceView',0.008]];
  for(const [label,key,val] of feats){ if(s[key]){pct+=val;lines.push({label,pct:val,kind:'indicative'});} }
  return {pct,lines};
}
function buildConfidence(items, filtered, radiusKm, local){
  const count=filtered.length;
  const avgScore=count?filtered.reduce((s,x)=>s+x.score,0)/count:0;
  const avgDist=count?filtered.reduce((s,x)=>s+x.distanceKm,0)/count:null;
  const rec=count?filtered.reduce((s,x)=>s+(x.ageMonths ?? MAX_COMPARABLE_AGE_MONTHS),0)/count:null;
  const dispersion=local.dispersion==null?0.35:local.dispersion;
  let score=20;
  score+=clamp(count*2,0,24);
  score+=clamp(avgScore*0.25,0,20);
  score+=avgDist==null?0:clamp(15-avgDist*4,0,15);
  score+=rec==null?0:clamp(12-rec/3,0,12);
  score+=clamp(15-dispersion*30,0,15);
  score=Math.round(clamp(score,0,100));
  let level=score>=85?'Très forte':score>=70?'Forte':score>=55?'Moyenne':score>=40?'Limitée':'Insuffisante';
  return {score,level,avgScore,avgDist,avgAgeMonths:rec,dispersion};
}
function formatSignal(name,value,weight,reason){ return {name,value,weight,reason}; }

function validatePayload(p){
  const type=String(p.realtyType||''); const cfg=TYPE_CONFIG[type];
  if(!cfg) throw new Error('Type de bien non pris en charge.');
  if(!p.address) throw new Error('L’adresse est obligatoire.');
  if(cfg.built && !(num(p.livingArea)>0)) throw new Error('La surface bâtie/habitable est obligatoire pour ce type de bien.');
  if(!cfg.built && type!=='other' && !(num(p.landArea)>0 || num(p.livingArea)>0)) throw new Error('Renseignez la surface du terrain ou la surface du bien.');
}

async function estimate(payload){
  validatePayload(payload);
  const geo=await geocode(payload.address);
  const type=payload.realtyType;
  if(TYPE_CONFIG[type].special==='manual') return {version:ENGINE_VERSION,manual:true,message:'Ce type de bien nécessite une analyse manuelle ou une source DVF spécifique. Le moteur ne fabriquera pas une valeur à partir de comparables d’un autre type.',geo,subject:payload};
  const area=num(payload.livingArea), land=num(payload.landArea), rooms=num(payload.rooms);
  const all=[]; const loaded=[]; const errors=[];
  for(const year of DVF_YEARS){ try{ all.push(...await loadYear(year)); loaded.push(year); }catch(e){ errors.push(`${year}: ${e.message}`); } }
  const cfg=TYPE_CONFIG[type];
  const rows=typeRows(all,type).map(x=>({...x,metric:metricValue(x,type),ageMonths:ageMonths(x.date)})).filter(x=>x.price>0 && x.ageMonths!=null && x.ageMonths<=MAX_COMPARABLE_AGE_MONTHS && Number.isFinite(x.metric) && x.metric>0 && (cfg.built ? x.area>0 && x.metric<=50000 : true));
  if(!rows.length) throw new Error('Aucune transaction DVF exploitable pour ce type de bien dans les millésimes chargés.');
  const subject={...payload,latitude:geo.latitude,longitude:geo.longitude,type,dvfType:type==='house'?'Maison':type==='apartment'?'Appartement':null,area,land,rooms};
  const selection=adaptiveComparables(rows,subject);
  if(selection.items.length<3) throw new Error('Moins de 3 comparables exploitables : estimation automatique bloquée pour éviter un faux niveau de précision.');
  const filtered=iqrFilter(selection.items);
  const local=localStats(filtered.items);
  const weighted=weightedMedian(filtered.items);
  if(!weighted) throw new Error('Impossible de calculer une médiane pondérée fiable.');
  const jml=jmlAdjustments(subject);
  const baseValue=cfg.ppsm ? weighted*area : weighted;
  const correctedValue=baseValue*(1+jml.pct);
  const main=round1000(correctedValue);
  const conf=buildConfidence(selection.items,filtered.items,selection.radiusKm,local);
  const spread=clamp(0.06+(100-conf.score)/100*0.16+(local.dispersion||0)*0.20,0.06,0.25);
  const low=round1000(main*(1-spread)), high=round1000(main*(1+spread));
  const direct=filtered.items.filter(x=>x.score>=75).length;
  const marketMetric=local.adjustedMedian || local.median;
  const marketControl=cfg.ppsm ? local.median*area : local.median;
  const divergence=marketControl>0?Math.abs(marketControl-baseValue)/marketControl:null;
  const warning=divergence!=null&&divergence>0.15?'Divergence importante entre médiane locale et comparables pondérés. Analyse manuelle recommandée.':null;
  const displayed=filtered.items.slice().sort((a,b)=>b.weight-a.weight).slice(0,15).map(x=>({date:x.date,price:x.price,sqmPrice:cfg.ppsm?round100(x.adjustedMetric||x.metric):null,metric:round100(x.adjustedMetric||x.metric),livingArea:x.area,landArea:x.land,rooms:x.rooms,distanceKm:Number(x.distanceKm.toFixed(2)),ageMonths:Number((x.ageMonths||0).toFixed(1)),score:x.score,influence:x.weight,adjustmentFactor:x.adjustmentFactor,streetName:x.street,streetNumber:x.number,nature:x.nature,type:x.type_local,temporalFactor:x.temporalFactor}));
  const totalWeight=filtered.items.reduce((s,x)=>s+x.weight,0)||1;
  displayed.forEach(x=>x.influence=Number((x.influence/totalWeight*100).toFixed(1)));
  const recentCount=filtered.items.filter(x=>Number(x.ageMonths)<=RECENT_AGE_MONTHS).length;
  const olderCount=filtered.items.length-recentCount;
  const marketPosition=marketControl>0 ? (
    baseValue < marketControl*0.97 ? 'sous la médiane DVF' :
    baseValue > marketControl*1.03 ? 'au-dessus de la médiane DVF' : 'proche de la médiane DVF'
  ) : 'non déterminable';
  const marketAnalysis={
    medianValue:round100(marketControl),
    weightedValue:round100(baseValue),
    divergencePct:divergence==null?null:Math.round((baseValue/marketControl-1)*100),
    position:marketPosition,
    comparableCount:filtered.items.length,
    recentCount,
    olderCount,
    radiusKm:selection.radiusKm,
    dispersionPct:local.dispersion==null?null:Math.round(local.dispersion*100),
    q1:cfg.ppsm?round100(local.q1*area):round100(local.q1),
    q3:cfg.ppsm?round100(local.q3*area):round100(local.q3)
  };
  const signals=[
    formatSignal('Comparables DVF pondérés',round100(baseValue),100,`${filtered.items.length} ventes retenues, dont ${direct} très comparables`),
    formatSignal('Médiane locale DVF',round100(marketControl),0,'Contrôle de cohérence uniquement ; elle n’est pas ajoutée une seconde fois au prix final')
  ];
  return {
    version:ENGINE_VERSION, manual:false, estimate:main, low, high, spread,
    confidence:conf.score, confidenceLevel:conf.level,
    method:`DVF géolocalisées → ventes de moins de ${MAX_COMPARABLE_AGE_MONTHS} mois uniquement → priorité aux ventes de moins de ${RECENT_AGE_MONTHS} mois → score de comparabilité /100 → normalisation surface/pièces/date → filtre IQR → médiane pondérée → corrections JML indicatives séparées. La médiane locale sert uniquement de contrôle et ne double pas le calcul.`,
    data:{department:DVF_DEPT,years:loaded,millime:DATA_MILLIME,source:'DVF+ open-data / DGFiP'},
    selection:{radiusKm:selection.radiusKm,totalCandidates:selection.items.length,retained:filtered.items.length,directComparables:direct,filter:filtered.mode,maxAgeMonths:MAX_COMPARABLE_AGE_MONTHS,recentPriorityMonths:RECENT_AGE_MONTHS},
    statistics:{metricLabel:metricLabel(type),weightedMetric:weighted,medianMetric:local.median,adjustedMedianMetric:marketMetric,q1:local.q1,q3:local.q3,dispersion:local.dispersion,marketControlValue:marketControl,baseValue,adjustmentPct:jml.pct},
    marketAnalysis,
    adjustments:jml.lines,
    divergencePct:divergence==null?null:Math.round(divergence*100), warning,
    sources:signals,
    comparables:{data:displayed,total:filtered.items.length},
    geo,
    errors
  };
}

app.get('/api/health',(req,res)=>res.json({ok:true,version:ENGINE_VERSION,department:DVF_DEPT,years:DVF_YEARS,millime:DATA_MILLIME,immoDataCalls:0}));
app.post('/api/analyze',async(req,res)=>{
  try{ const result=await estimate(req.body||{}); res.json(result); }
  catch(e){ res.status(400).json({error:e.message||'Erreur inconnue',version:ENGINE_VERSION}); }
});

if(require.main===module){ app.listen(PORT,()=>console.log(`JML Estimateur V7.4 PRO DVF — comparables <= ${MAX_COMPARABLE_AGE_MONTHS} mois — http://localhost:${PORT}`)); }
module.exports={median,percentile,adaptiveComparables,iqrFilter,buildConfidence,jmlAdjustments,TYPE_CONFIG,estimate,MAX_COMPARABLE_AGE_MONTHS};