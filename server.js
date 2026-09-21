'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),zlib=require('zlib'),{promisify}=require('util');
const gunzip=promisify(zlib.gunzip);
const PORT=Number(process.env.PORT||3000),DEPT=process.env.DVF_DEPT||'08';
const YEARS=(process.env.DVF_YEARS||'2025,2024,2023,2022').split(',').map(Number).filter(Boolean);
const RADII=[.3,.75,1.5,3,5],MAX_MONTHS=24;
const RECENCY=[[3,1],[6,.97],[12,.92],[18,.82],[24,.65]];
const TYPES={
 house:{label:'Maison',area:'living',match:r=>norm(r.type_local)==='maison'},
 apartment:{label:'Appartement',area:'living',match:r=>norm(r.type_local)==='appartement'},
 land:{label:'Terrain à bâtir',area:'land',match:r=>/terrain\s+a\s+batir|terrain\s+constructible/.test(norm(r.nature_culture))},
 agricultural_land:{label:'Terrain agricole',area:'land',match:r=>/terre|pres|prairie|verger|vigne|bois|foret|taillis|lande|etang/.test(norm(r.nature_culture))&&!/terrain\s+a\s+batir/.test(norm(r.nature_culture))},
 commercial:{label:'Local commercial',area:'living',match:r=>commercial(r.type_local)},
 industrial:{label:'Local industriel / entrepôt',area:'living',match:r=>commercial(r.type_local)},
 garage:{label:'Garage / dépendance',area:'living',match:r=>norm(r.type_local)==='dependance'},
 parking:{label:'Parking',area:'living',match:r=>norm(r.type_local)==='dependance'},
 building:{label:'Immeuble',area:'living',match:()=>false},
 other:{label:'Autre bien',area:'living',match:()=>false}
};
function norm(v){return String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim()}
function n(v){const x=Number(String(v??'').replace(',','.').replace(/\s/g,''));return Number.isFinite(x)?x:0}
function date(v){const d=new Date(String(v||'').slice(0,10));return Number.isNaN(d.getTime())?null:d}
function ageMonths(d,asOf=Date.now()){const t=asOf instanceof Date?asOf.getTime():asOf;return Math.max(0,(t-d.getTime())/2629800000)}
function dist(a,b,c,d){const p=Math.PI/180,x=.5-Math.cos((c-a)*p)/2+Math.cos(a*p)*Math.cos(b*p)*(1-Math.cos((d-b)*p))/2;return 12742*Math.asin(Math.sqrt(Math.max(0,x)))}
function rw(m){for(const [max,w] of RECENCY)if(m<=max)return w;return 0}
function median(a){const x=[...a].sort((a,b)=>a-b);if(!x.length)return 0;const i=(x.length-1)/2;return x[Math.floor(i)]===x[Math.ceil(i)]?x[Math.floor(i)]:(x[Math.floor(i)]+x[Math.ceil(i)])/2}
function percentile(a,p){const x=a.filter(Number.isFinite).sort((a,b)=>a-b);if(!x.length)return 0;const i=(x.length-1)*p,l=Math.floor(i),h=Math.ceil(i);return l===h?x[l]:x[l]+(x[h]-x[l])*(i-l)}
function wmedian(rows){const x=rows.filter(r=>r.value>0&&r.weight>0).sort((a,b)=>a.value-b.value);if(!x.length)return 0;const t=x.reduce((s,r)=>s+r.weight,0);let a=0;for(const r of x){a+=r.weight;if(a>=t/2)return r.value}return x.at(-1).value}
function csvLine(s){const o=[];let c='',q=false;for(let i=0;i<s.length;i++){const z=s[i];if(z==='"'){if(q&&s[i+1]==='"'){c+='"';i++}else q=!q}else if(z===','&&!q){o.push(c);c=''}else c+=z}o.push(c);return o}
function csv(s){const l=s.split(/\r?\n/).filter(Boolean),h=csvLine(l[0]||'');return l.slice(1).map(z=>{const c=csvLine(z),r={};h.forEach((k,i)=>r[k]=c[i]??'');return r})}
function row(r){return{id:r.id_mutation,date:r.date_mutation,nature:r.nature_mutation,price:n(r.valeur_fonciere),streetNumber:r.adresse_numero,streetName:r.adresse_nom_voie,postal:r.code_postal,city:r.nom_commune,parcel:r.id_parcelle,type_local:r.type_local,nature_culture:r.nature_culture,livingArea:n(r.surface_reelle_bati),rooms:n(r.nombre_pieces_principales),landArea:n(r.surface_terrain),lat:n(r.latitude),lon:n(r.longitude)}}
function commercial(v){const s=norm(v);return s.includes('commercial')||s.includes('industriel')}
function consolidate(rows,cfg){const m=new Map();for(const r of rows)if(norm(r.nature)==='vente'&&cfg.match(r)&&r.id&&r.price&&r.date){const k=[r.id,r.type_local,r.streetNumber,norm(r.streetName),r.postal,r.parcel].join('|');if(!m.has(k))m.set(k,[]);m.get(k).push(r)}const out=[];for(const a of m.values()){if(a.length!==1)continue;const r=a[0],area=cfg.area==='land'?r.landArea:r.livingArea;if(area>0&&r.lat&&r.lon)out.push({...r,area,sqmPrice:r.price/area})}return out}
async function fetchYear(y){if(process.env.MOCK_DVF_MODE==='true')return mockRows(String(y));const u=`https://files.data.gouv.fr/geo-dvf/latest/csv/${y}/departements/${DEPT}.csv.gz`,r=await fetch(u);if(!r.ok)throw Error(`DVF ${y}: HTTP ${r.status}`);return csv((await gunzip(Buffer.from(await r.arrayBuffer()))).toString('utf8')).map(row)}
async function loadDvf(){return (await Promise.all(YEARS.map(y=>fetchYear(y).catch(()=>[])))).flat()}
async function geocode(address){if(process.env.MOCK_DVF_MODE==='true')return{lat:49.77,lon:4.72,label:address,city:'Charleville-Mézières',postal:'08000'};const u=new URL('https://data.geopf.fr/geocodage/search');u.searchParams.set('q',address);u.searchParams.set('limit','1');const r=await fetch(u);if(!r.ok)throw Error(`Géocodage: HTTP ${r.status}`);const d=await r.json(),f=d.features?.[0];if(!f?.geometry?.coordinates)throw Error('Adresse introuvable. Vérifiez l’adresse saisie.');const p=f.properties||{};return{lat:f.geometry.coordinates[1],lon:f.geometry.coordinates[0],label:p.label||address,city:p.city||p.municipality||p.locality||'',postal:p.postcode||p.postalcode||''}}
function score(r,t,rad){const type=25,d=20*Math.max(0,1-r.distance/rad),s=20*Math.max(0,1-Math.abs(r.area-t.area)/Math.max(1,t.area)),p=t.rooms&&r.rooms?10*Math.max(0,1-Math.abs(t.rooms-r.rooms)/5):5,l=t.landArea&&r.landArea?10*Math.max(0,1-Math.abs(t.landArea-r.landArea)/Math.max(1,t.landArea)):5,rec=15*rw(r.age);return type+d+s+p+l+rec}
function surfaceFactor(r,t){
  const ratio=Math.min(r.area,t.area)/Math.max(r.area,t.area);
  if(ratio<0.45)return 0;

  // La surface reste un critère fort de comparabilité.
  // On pénalise progressivement les écarts importants plutôt que
  // de traiter une maison de 60 m² comme presque aussi comparable
  // qu'une maison de 120 m².
  const logGap=Math.abs(Math.log(Math.max(ratio,0.45)));
  return Math.max(0.05,Math.min(1,Math.exp(-Math.pow(logGap/0.25,2))));
}
function surfaceSimilarityWeight(r,t){
  const ratio=Math.min(r.area,t.area)/Math.max(r.area,t.area);
  if(ratio<.45)return 0;
  const gap=Math.abs(Math.log(Math.max(ratio,.45)));
  // V1.3 : la proximité de surface devient une hiérarchie forte.
  // Une vente quasi-jumelle doit peser nettement plus qu'une vente
  // beaucoup plus petite ou plus grande.
  return Math.max(.02,Math.min(1,Math.exp(-Math.pow(gap/.18,2))));
}
function streetSimilarityWeight(r,t){
  if(!t.streetHint||!r.streetName)return 1;
  const a=norm(t.streetHint),b=norm(r.streetName);
  if(!a||!b)return 1;
  // On ne donne le bonus que si le nom de rue DVF est réellement
  // retrouvé dans l'adresse saisie, pour éviter les faux positifs.
  return a.includes(b)||b.includes(a)?1.25:1;
}
function weight(r,t){
  const sf=surfaceFactor(r,t); if(!sf)return 0;
  const sw=surfaceSimilarityWeight(r,t); if(!sw)return 0;
  const roomFactor=t.rooms&&r.rooms?Math.max(.45,1-Math.abs(t.rooms-r.rooms)*.10):.8;
  const landFactor=t.landArea&&r.landArea?Math.max(.45,Math.min(1,Math.min(t.landArea,r.landArea)/Math.max(t.landArea,r.landArea))):.85;
  const proximity=Math.exp(-r.distance/.95);
  const recency=rw(r.age);
  // V1.5 : une vente très proche et très comparable conserve un poids fort
  // même si elle est un peu plus ancienne. La distance reste secondaire
  // par rapport à la surface, mais ne pénalise plus aussi brutalement.
  return sf*sw*recency*proximity*roomFactor*landFactor*streetSimilarityWeight(r,t)*(0.55+r.score/220);
}
function selectFromBase(base,t,asOf=Date.now()){
  const usable=base.map(r=>({...r,distance:dist(t.lat,t.lon,r.lat,r.lon),age:ageMonths(date(r.date),asOf)}))
    .filter(r=>r.age>=0&&r.age<=MAX_MONTHS&&r.distance<=5&&r.sqmPrice>0&&surfaceFactor(r,t)>0);
  const sel=[];
  for(const rad of RADII){
    for(const r of usable.filter(x=>x.distance<=rad&&!sel.includes(x)).sort((a,b)=>score(b,t,rad)-score(a,t,rad))){
      r.score=score(r,t,rad); sel.push(r); if(sel.length>=20)break;
    }
    if(sel.length>=6)break;
  }
  const ps=sel.map(r=>r.sqmPrice),q1=percentile(ps,.25),q3=percentile(ps,.75),iqr=q3-q1;
  const keep=iqr?sel.filter(r=>r.sqmPrice>=q1-1.5*iqr&&r.sqmPrice<=q3+1.5*iqr):sel;
  keep.forEach(r=>r.weight=weight(r,t));
  const limit=t.type==='apartment'?5:t.type==='house'?15:10;
  return keep.filter(r=>r.weight>0).sort((a,b)=>b.weight-a.weight).slice(0,limit);
}
function select(rows,t,cfg,asOf=Date.now()){return selectFromBase(consolidate(rows,cfg),t,asOf)}
function confidence(c,t){if(!c.length)return 0;const avgD=c.reduce((s,r)=>s+r.distance,0)/c.length,avgA=c.reduce((s,r)=>s+r.age,0)/c.length,med=median(c.map(r=>r.sqmPrice)),mad=median(c.map(r=>Math.abs(r.sqmPrice-med))),surface=c.reduce((s,r)=>s+Math.max(0,1-Math.abs(r.area-t.area)/Math.max(1,t.area)),0)/c.length;return Math.max(0,Math.min(100,Math.round(Math.min(35,c.length*5)+Math.max(0,25-avgD*7)+Math.max(0,20-avgA*.7)+Math.max(0,20-mad/Math.max(1,med)*100)+surface*10)))}
function primaryComparables(c,t){
  if(!c.length)return [];
  // Cœur de comparabilité : on ne laisse pas une multitude de petites
  // surfaces décider du prix d'une maison nettement plus grande.
  // Le seuil reste volontairement large pour conserver de la profondeur
  // statistique quand le marché local est peu fourni.
  const ratioMin=t.type==='apartment'?.80:t.type==='house'?.75:.70;
  return c.filter(r=>{
    const ratio=Math.min(r.area,t.area)/Math.max(r.area,t.area);
    return ratio>=ratioMin&&r.distance<=.75;
  });
}

function weightedMean(rows){
  const x=rows.filter(r=>r.value>0&&r.weight>0);
  if(!x.length)return 0;
  const w=x.reduce((s,r)=>s+r.weight,0);
  return w?x.reduce((s,r)=>s+r.value*r.weight,0)/w:0;
}

function estimateFromComparables(c,t,details=false){
  if(!c.length)return details?{estimate:0,method:'none',primary:[]}:0;
  const globalSqm=wmedian(c.map(r=>({value:r.sqmPrice,weight:r.weight})));
  const localMedianSqm=median(c.map(r=>r.sqmPrice));
  const primary=primaryComparables(c,t);

  if(primary.length>=3){
    const primarySqm=weightedMean(primary.map(r=>({value:r.sqmPrice,weight:r.weight})));
    const primaryMedian=median(primary.map(r=>r.sqmPrice));
    const primaryMad=median(primary.map(r=>Math.abs(r.sqmPrice-primaryMedian)));
    const dispersion=primaryMedian>0?primaryMad/primaryMedian:0;
    const divergence=localMedianSqm>0?(localMedianSqm-primarySqm)/localMedianSqm:0;

    // V1.6.2 : si le socle pondéré est nettement sous la médiane locale,
    // la médiane devient le centre robuste du marché. Cela protège contre
    // quelques ventes basses qui reçoivent trop de poids par récence/distance.
    // Cela évite qu'un petit groupe de ventes basses écrase deux ventes
    // très comparables dans une même micro-zone.
    const localCenterUsed=(
      localMedianSqm>primarySqm &&
      divergence>=0.10
    );
    const chosenSqm=localCenterUsed?localMedianSqm:primarySqm;
    const estimate=Math.round(chosenSqm*t.area/1000)*1000;

    return details?{
      estimate,
      method:localCenterUsed?'centre local de marché cohérent':'cœur de comparabilité par surface',
      primary,
      globalSqm,
      primarySqm,
      localMedianSqm,
      primaryDispersion:dispersion,
      localDivergence:divergence,
      localCenterUsed
    }:estimate;
  }

  const estimate=Math.round(globalSqm*t.area/1000)*1000;
  return details?{estimate,method:'médiane pondérée élargie',primary,globalSqm,primarySqm:null,localMedianSqm,localCenterUsed:false}:estimate;
}
function learnCorrection(rows,cfg,target){
  const all=consolidate(rows,cfg);
  const historical=all.map(r=>({...r,distanceFromTarget:dist(target.lat,target.lon,r.lat,r.lon)}))
    .filter(r=>date(r.date)?.getTime()<target.asOf&&r.distanceFromTarget<=2&&surfaceFactor(r,target)>0)
    .sort((a,b)=>a.distanceFromTarget-b.distanceFromTarget||date(b.date)-date(a.date)).slice(0,36);
  const ratios=[];
  for(const sold of historical){
    const soldDate=date(sold.date); if(!soldDate)continue;
    const prior=all.filter(r=>date(r.date)?.getTime()<soldDate.getTime());
    if(prior.length<6)continue;
    const t={lat:sold.lat,lon:sold.lon,area:sold.area,rooms:sold.rooms||0,landArea:sold.landArea||0,type:cfg===TYPES.apartment?'apartment':cfg===TYPES.house?'house':undefined};
    const c=selectFromBase(prior,t,soldDate);
    const pred=estimateFromComparables(c,t);
    if(pred>0&&sold.price>0){
      const ratio=sold.price/pred;
      if(ratio>=.60&&ratio<=1.60)ratios.push({ratio});
    }
  }
  if(ratios.length<8)return{factor:1,samples:ratios.length,usable:false};
  const rawMedian=median(ratios.map(x=>x.ratio));
  const factor=Math.max(.90,Math.min(1.10,rawMedian));
  return{factor,samples:ratios.length,usable:true,rawMedian};
}
function characteristicAdjustment(input,cfg,baseEstimate){
  // V1.4 : couche complémentaire prudente pour les caractéristiques
  // qui ne sont pas présentes dans les fichiers DVF standards.
  // Elle reste séparée du socle DVF et son détail est affiché à l'utilisateur.
  // Le terrain n'est PAS corrigé une seconde fois : il est déjà intégré
  // dans la comparabilité DVF lorsque la donnée est disponible.
  const items=[];
  const add=(label,pct,reason)=>{if(pct)items.push({label,pct,reason});};

  const dpe={A:3,B:2,C:1,D:0,E:-2,F:-4,G:-6};
  if(input.dpe&&dpe[input.dpe]!==undefined)
    add('DPE '+input.dpe,dpe[input.dpe],'barème prudent, séparé du socle DVF');

  const condition={
    excellent:3.5,
    very_good:2,
    good:0,
    refresh:-3,
    major_work:-7
  };
  if(input.condition&&condition[input.condition]!==undefined)
    add('État général',condition[input.condition],'barème prudent, séparé du socle DVF');

  if(input.garage)add('Garage',1.5,'équipement non détaillé dans DVF');
  if(input.parking)add('Parking',.5,'équipement non détaillé dans DVF');
  if(input.cellar)add('Cave',.5,'équipement non détaillé dans DVF');
  if(input.terrace)add('Terrasse',1,'équipement non détaillé dans DVF');
  if(input.patio)add('Cour / patio',.75,'équipement non détaillé dans DVF');
  if(input.niceView)add('Belle vue',1.5,'caractéristique non détaillée dans DVF');

  if(input.bathrooms>1){
    const extra=Math.min(2,(Number(input.bathrooms)-1)*.5);
    add('Salle(s) de bains supplémentaire(s)',extra,'information non détaillée dans DVF');
  }

  // L'année de construction n'est utilisée que si aucun DPE n'est fourni,
  // pour éviter de compter deux fois le même signal énergétique/âge.
  if(!input.dpe&&input.constructionYear){
    const y=Number(input.constructionYear);
    let pct=0;
    if(y>=2015)pct=1.5;
    else if(y>=2005)pct=1;
    else if(y<1970)pct=-1.5;
    else if(y<1985)pct=-.75;
    if(pct)add('Année de construction',pct,'signal de secours uniquement en absence de DPE');
  }

  // Plafond volontairement conservateur : les caractéristiques ne doivent
  // jamais écraser le signal des ventes DVF.
  const raw=items.reduce((sum,x)=>sum+x.pct,0);
  const pct=Math.max(-10,Math.min(10,raw));
  const characteristicDelta=Math.round((baseEstimate*pct/100)/1000)*1000;
  const adjusted=baseEstimate+characteristicDelta;

  return {
    applied:items.length>0,
    rawPct:raw,
    pct,
    baseEstimate,
    adjustedEstimate:adjusted,
    delta:characteristicDelta,
    finalEstimate:adjusted,
    items,
    capPct:10,
    note:'Couche complémentaire prudente : les caractéristiques absentes de DVF sont appliquées séparément et plafonnées à ±10 %. Le terrain n’est pas ajouté une seconde fois car il participe déjà à la comparabilité DVF lorsqu’il est disponible.'
  };
}

function characteristicReport(input,cfg,characteristic={note:'Les caractéristiques absentes des données DVF sont traitées séparément avec un ajustement prudent.'}){
  const monetary=[];
  if(cfg===TYPES.house||cfg===TYPES.apartment||cfg===TYPES.commercial||cfg===TYPES.industrial){
    monetary.push('type de bien','surface bâtie','distance géographique','récence de la vente','nombre de pièces');
  }
  if(cfg===TYPES.house||cfg===TYPES.land||cfg===TYPES.agricultural_land||cfg===TYPES.commercial||cfg===TYPES.industrial){
    monetary.push('surface du terrain');
  }

  const supplied=[];
  if(input.bathrooms>0) supplied.push('salles de bains');
  if(input.constructionYear>0) supplied.push('année de construction');
  if(input.dpe) supplied.push('DPE '+input.dpe);
  if(input.condition) supplied.push('état général');
  if(input.garage) supplied.push('garage');
  if(input.parking) supplied.push('parking');
  if(input.cellar) supplied.push('cave');
  if(input.terrace) supplied.push('terrasse');
  if(input.patio) supplied.push('cour / patio');
  if(input.niceView) supplied.push('belle vue');

  return {
    monetary,
    supplied,
    notMonetized:[],
    adjustment:characteristic,
    note:characteristic.note
  };
}
function commercialPricing(estimate){
  const price=Math.max(0,Math.round(Number(estimate)||0));
  // Barème JML fourni par l'agence : honoraires TTC inclus dans le prix affiché.
  const rate=price<=50000?.10:price<=100000?.08:price<=150000?.06:.05;
  const sellerPrice=Math.max(0,Math.round((price*(1-rate))/1000)*1000);
  const fees=price-sellerPrice;
  return {
    rate,
    rateLabel:Math.round(rate*100)+' %',
    finalPrice:price,
    sellerPrice,
    fees,
    note:'Prix affiché honoraires inclus. Prix vendeur calculé selon le barème JML appliqué au prix affiché.'
  };
}
function analyze(rows,input,geo){
  const cfg=TYPES[input.realtyType];
  if(!cfg)throw Error('Type de bien invalide.');
  if(['building','other'].includes(input.realtyType))return{manual:true,message:'Ce type n’est pas directement identifiable de façon fiable dans DVF V1. Une méthode dédiée est nécessaire pour éviter d’inventer un prix.'};
  const area=cfg.area==='land'?input.landArea:input.livingArea;
  const t={...geo,area,rooms:input.rooms||0,landArea:input.landArea||0,type:input.realtyType,streetHint:input.address||''};
  const asOf=Date.now();
  const c=select(rows,t,cfg,asOf);
  if(!c.length)return{manual:true,message:'Pas assez de ventes DVF exploitables pour '+cfg.label+' dans les 24 derniers mois et 5 km.'};
  const model=estimateFromComparables(c,t,true);
  const baseEstimate=model.estimate;
  const calibration=learnCorrection(rows,cfg,{...t,asOf});
  const calibrationApplied=calibration.usable&&!model.localCenterUsed;
  const calibratedEstimate=calibrationApplied?Math.round(baseEstimate*calibration.factor/1000)*1000:baseEstimate;
  const characteristics=characteristicAdjustment(input,cfg,calibratedEstimate);
  const estimate=characteristics.finalEstimate;
  const sqm=estimate/Math.max(1,area),local=median(c.map(r=>r.sqmPrice)),conf=confidence(c,t),avgD=c.reduce((s,r)=>s+r.distance,0)/c.length,avgA=c.reduce((s,r)=>s+r.age,0)/c.length;
  const commercial=commercialPricing(estimate);
  return{
    estimate,low:Math.max(0,estimate-7000),high:estimate+7000,rangeEur:7000,confidence:conf,commercial,
    confidenceLevel:conf>=80?'Élevée':conf>=60?'Bonne':conf>=40?'Moyenne':'Faible',
    method:(model.method==='centre local de marché cohérent'
      ?'Centre local de marché robuste V1.6 : lorsque le cœur de surface est hétérogène et nettement sous la médiane locale, cette médiane devient le centre du socle. La calibration historique est alors volontairement neutralisée pour éviter un double biais.'
      :model.method==='cœur de comparabilité par surface'
      ?'Cœur de comparabilité DVF V1.3 : priorité aux ventes de même type, même rue si identifiable, proches géographiquement et surtout à surface proche, puis calibration historique hors échantillon.'
      :'Médiane pondérée des ventes DVF comparables : le cœur de surface est insuffisant pour constituer le socle.')+
      ' Puis couche caractéristiques séparée (plafond ±10 %). Le prix propriétaire n’entre jamais dans le calcul.',
    statistics:{weightedMetric:sqm,baseEstimate,localMedian:local,avgDistanceKm:avgD,avgAgeMonths:avgA,trendAnnualPct:null,adjustmentPct:calibrationApplied?Math.round((calibration.factor-1)*1000)/10:0,calibrationDelta:calibratedEstimate-baseEstimate,characteristicAdjustmentPct:characteristics.pct,characteristicDelta:characteristics.delta,finalEstimate:estimate,metricLabel:'€/m²',localCenterUsed:!!model.localCenterUsed,localMedianSqm:model.localMedianSqm??null,primaryDispersion:model.primaryDispersion??null,localDivergence:model.localDivergence??null},
    calibration:{applied:calibrationApplied,factor:calibration.factor,samples:calibration.samples,rawMedian:calibration.rawMedian??null,rule:'apprentissage uniquement sur ventes antérieures à chaque vente test',suppressed:calibration.usable&&!calibrationApplied,suppressedReason:model.localCenterUsed?'Centre local robuste activé : le signal actuel des ventes locales prime sur la correction historique.':null},
    characteristics:characteristicReport(input,cfg,characteristics),
    selection:{
      retained:c.length,
      directComparables:c.filter(r=>r.distance<=.75).length,
      primaryComparables:model.primary.length,
      primarySurfaceRatio:t.type==='apartment'?.80:t.type==='house'?.75:.70,
      radiusKm:Math.max(...c.map(r=>r.distance)),
      filter:'24 mois · type identique · IQR 1,5 · cœur surface ≥ '+Math.round((t.type==='apartment'?.80:t.type==='house'?.75:.70)*100)+' % · surface hiérarchisée'
    },
    sources:[
      {name:model.method==='centre local de marché cohérent'?'Base DVF — centre local cohérent':model.method==='cœur de comparabilité par surface'?'Base DVF — cœur de comparabilité':'Base DVF — comparables réels',value:baseEstimate,weight:100,role:'base',reason:model.method==='centre local de marché cohérent'
        ?model.primary.length+' ventes dans le cœur de surface, mais une dispersion locale a déclenché un centre robuste basé sur la médiane des '+c.length+' ventes retenues : '+Math.round(model.localMedianSqm)+' €/m².'
        :model.method==='cœur de comparabilité par surface'
        ?model.primary.length+' ventes dans le cœur de surface, avec poids renforcé selon la proximité exacte de surface et, si identifiable, de la rue, sur '+c.length+' comparables DVF retenus.'
        :c.length+' ventes réelles retenues après filtrage ; le cœur de surface ne contient que '+model.primary.length+' vente(s).'},
      ...(model.primary.length?[
        {name:'Cœur de surface DVF',value:Math.round((model.primarySqm||0)*area),weight:0,role:'cohort',reason:model.primary.length+' comparables à surface proche (seuil '+Math.round((t.type==='apartment'?.80:t.type==='house'?.75:.70)*100)+' %), utilisé comme socle lorsque le nombre est suffisant.'}
      ]:[]),
      ...(calibrationApplied?[{name:'Calibration historique',value:calibratedEstimate,weight:0,role:'adjustment',delta:calibratedEstimate-baseEstimate,reason:calibration.samples+' ventes historiques testées hors échantillon · correction appliquée : '+(calibration.factor>=1?'+':'')+Math.round((calibration.factor-1)*1000)/10+' %.'}]:[]),
      {name:model.localCenterUsed?'Médiane locale de marché':'Médiane locale de contrôle',value:Math.round(local*area),weight:model.localCenterUsed?100:0,role:model.localCenterUsed?'market':'control',reason:model.localCenterUsed?'Centre robuste réellement utilisé dans le calcul : médiane des ventes DVF retenues.':'Contrôle de cohérence uniquement, jamais ajoutée au prix.'},
      ...(characteristics.applied?[{
        name:'Caractéristiques du bien',
        value:estimate,
        weight:0,
        role:'characteristic',
        delta:characteristics.delta,
        reason:characteristics.items.map(x=>x.label+' '+(x.pct>=0?'+':'')+x.pct.toFixed(1)+' %').join(' · ')+' · total '+(characteristics.pct>=0?'+':'')+characteristics.pct.toFixed(1)+' % · plafond ±10 %. Ajustement réellement appliqué : '+(characteristics.delta>=0?'+':'')+characteristics.delta+' €.'
      }]:[])
    ],
    comparables:{data:c.map(r=>({date:r.date,streetName:r.streetName,streetNumber:r.streetNumber,livingArea:r.area,rooms:r.rooms,landArea:r.landArea,price:r.price,sqmPrice:r.sqmPrice,distanceKm:r.distance,score:Math.round(r.score),ageMonths:Math.round(r.age),weight:Number(r.weight.toFixed(4))}))},
    data:{source:'DVF+ géolocalisées — données ouvertes',millime:YEARS.join(', '),engineVersion:'V1.8.6-annonces-robustes',localCenter:model.localCenterUsed}
  };
}

const COMPETITION_HOSTS=['leboncoin.fr','www.leboncoin.fr','seloger.com','www.seloger.com','bienici.com','www.bienici.com','logic-immo.com','www.logic-immo.com','pap.fr','www.pap.fr'];
const NOTARY_HOSTS=[
  'immobilier.notaires.fr','www.immobilier.notaires.fr',
  'immonot.com','www.immonot.com',
  'chambre-interdep-08-10-51.notaires.fr'
];
const AGENCY_HOSTS=[
  'jml-immobilier.fr','www.jml-immobilier.fr',
  'fischer-immobilier.fr','www.fischer-immobilier.fr',
  'agence-ing.fr','www.agence-ing.fr',
  'sassi-immobilier.fr','www.sassi-immobilier.fr',
  'justimmo08.fr','www.justimmo08.fr',
  'ill-immobilier.fr','www.ill-immobilier.fr',
  'rimbaudimmo.fr','www.rimbaudimmo.fr',
  'charlevillemezieres.stephaneplazaimmobilier.com',
  'charleville-mezieres.guy-hoquet.com',
  'guy-hoquet.com','www.guy-hoquet.com',
  'citya.com','www.citya.com',
  'charleville-arthurimmo.com','www.charleville-arthurimmo.com'
];
function competitionHostAllowed(host){
  const h=String(host||'').toLowerCase();
  return [...COMPETITION_HOSTS,...AGENCY_HOSTS].some(x=>h===x||h.endsWith('.'+x));
}
function agencyHostAllowed(host){
  const h=String(host||'').toLowerCase();
  return AGENCY_HOSTS.some(x=>h===x||h.endsWith('.'+x));
}
function notaryHostAllowed(host){
  const h=String(host||'').toLowerCase();
  return NOTARY_HOSTS.some(x=>h===x||h.endsWith('.'+x));
}
function parseLooseNumber(v){
  if(v==null)return 0;
  let s=String(v).trim().replace(/\u00a0/g,' ').replace(/\s/g,'');
  if(!s)return 0;
  if(s.includes(',')&&s.includes('.'))s=s.replace(/\./g,'').replace(',','.');
  else if(s.includes(','))s=s.replace(',','.');
  else if(/^\d{1,3}(?:\.\d{3})+$/.test(s))s=s.replace(/\./g,'');
  const x=Number(s);
  return Number.isFinite(x)?x:0;
}
function walkJsonLd(value,out=[]){
  if(!value)return out;
  if(Array.isArray(value)){for(const x of value)walkJsonLd(x,out);return out;}
  if(typeof value==='object'){
    out.push(value);
    for(const x of Object.values(value))walkJsonLd(x,out);
  }
  return out;
}
function extractCompetitionListing(html,url){
  const scripts=[];
  const re=/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\\s\\S]*?)<\/script>/gi;
  let m;
  while((m=re.exec(html)))scripts.push(m[1].trim());
  const candidates=[];
  for(const raw of scripts){
    try{
      const parsed=JSON.parse(raw.replace(/&quot;/g,'"').replace(/&#39;/g,"'"));
      candidates.push(...walkJsonLd(parsed));
    }catch{}
  }
  let best=null;
  for(const o of candidates){
    const offers=o?.offers||o?.offer||{};
    const price=parseLooseNumber(typeof offers==='object'?offers.price:o.price);
    const fs=o?.floorSize;
    const ls=o?.lotSize||o?.landSize;
    const area=parseLooseNumber(typeof fs==='object'?fs.value:fs)||parseLooseNumber(o?.area);
    const landArea=parseLooseNumber(typeof ls==='object'?ls.value:ls)||parseLooseNumber(o?.surfaceTerrain);
    const rooms=parseLooseNumber(o?.numberOfRooms);
    const title=String(o?.name||o?.headline||'').trim();
    const addr=o?.address;
    const locality=typeof addr==='object'?String(addr.addressLocality||'').trim():'';
    if(price>=10000&&area>=15&&area<=5000){
      const candidate={title,price,area,rooms,locality,landArea};
      if(!best||((rooms>0?1:0)+(title?1:0)+(locality?1:0))>((best.rooms>0?1:0)+(best.title?1:0)+(best.locality?1:0)))best=candidate;
    }
  }
  if(!best){
    const text=String(html).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    const priceMatches=[...text.matchAll(/(?:prix(?:\s+de\s+vente)?|prix\s+du\s+bien)[^0-9]{0,40}([0-9][0-9\s]{3,})\s*€/gi)];
    const areaMatches=[...text.matchAll(/([0-9]{2,4}(?:[.,][0-9]+)?)\s*m²/gi)];
    const price=priceMatches.map(x=>parseLooseNumber(x[1])).find(x=>x>=10000)||0;
    const area=areaMatches.map(x=>parseLooseNumber(x[1])).find(x=>x>=15&&x<=5000)||0;
    const terrain=(text.match(/([0-9]{2,5}(?:[.,][0-9]+)?)\s*m²\s*(?:de\s*)?(?:terrain|parcelle)/i)||[])[1];
    const landArea=parseLooseNumber(terrain);
    if(price&&area)best={title:'Annonce immobilière',price,area,rooms:0,locality:'',landArea};
  }
  if(!best||!best.price||!best.area)throw Error('Impossible d’extraire automatiquement le prix et la surface de cette annonce. Utilisez la saisie manuelle.');
  return {
    source:new URL(url).hostname.replace(/^www\./,''),
    url,
    title:best.title||'Annonce immobilière',
    price:Math.round(best.price),
    area:best.area,
    rooms:best.rooms||0,
    locality:best.locality||'',
    landArea:best.landArea||0,
    sqmPrice:Math.round(best.price/best.area),
    importedAt:new Date().toISOString()
  };
}
async function importCompetitionListing(url){
  let u;
  try{u=new URL(String(url||''));}catch{throw Error('URL d’annonce invalide.');}
  const host=u.hostname.toLowerCase();
  const knownAgency=agencyHostAllowed(host);
  const knownNotary=notaryHostAllowed(host);
  const isSearchDiscoveredAgency=knownAgency||knownNotary;
  if(!['http:','https:'].includes(u.protocol)||(!competitionHostAllowed(host)&&!isSearchDiscoveredAgency)){
    throw Error('URL d’annonce non autorisée.');
  }
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{
    const r=await fetch(u,{signal:controller.signal,headers:{'user-agent':'Mozilla/5.0 JML-Estimateur/1.7','accept':'text/html,application/xhtml+xml'}});
    if(!r.ok)throw Error('Le site de l’annonce a répondu HTTP '+r.status+'.');
    const html=await r.text();
    if(html.length>8_000_000)throw Error('Page d’annonce trop volumineuse.');
    return extractCompetitionListing(html,u.toString());
  }catch(e){
    if(e.name==='AbortError')throw Error('Délai dépassé lors de la lecture de l’annonce.');
    throw e;
  }finally{clearTimeout(timer);}
}


function decodeHtml(s){
  return String(s||'')
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&sup2;/gi,'²').replace(/&#178;/gi,'²').replace(/&#xB2;/gi,'²');
}
function stripHtml(s){return decodeHtml(String(s||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());}
function competitionTypeFromText(s){
  const x=norm(s);
  if(/\bmaison\b|\bvilla\b|\bpavillon\b/.test(x))return'house';
  if(/\bappartement\b|\bt[0-9]\b|\bf[0-9]\b/.test(x))return'apartment';
  if(/\bgarage\b|\bdependance\b/.test(x))return'garage';
  if(/\bparking\b/.test(x))return'parking';
  if(/\blocal commercial\b|\bcommerce\b/.test(x))return'commercial';
  if(/\bentrepot\b|\blocal industriel\b/.test(x))return'industrial';
  if(/\bterrain\b/.test(x))return'land';
  return'other';
}
function extractSearchResultLinks(html){
  const out=[];
  const re=/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=re.exec(html))){
    let href=decodeHtml(m[1]);
    try{
      const u=new URL(href,'https://html.duckduckgo.com');
      const target=u.searchParams.get('uddg');
      href=target?decodeURIComponent(target):href;
    }catch{}
    const title=stripHtml(m[2]);
    if(/^https?:\/\//i.test(href))out.push({url:href,title});
  }
  return out;
}
function extractBingSearchResults(html){
  const out=[];
  const re=/<li[^>]+class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while((m=re.exec(html))){
    const block=m[1];
    const a=block.match(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if(!a)continue;
    const href=decodeHtml(a[1]);
    const title=stripHtml(a[2]);
    const p=block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet=stripHtml(p?p[1]:'');
    if(/^https?:\/\//i.test(href))out.push({url:href,title,snippet});
  }
  return out;
}
function extractGoogleSearchResults(html){
  const out=[];
  const seen=new Set();
  const blocks=String(html||'').split(/<div[^>]+class="[^"]*(?:MjjYud|tF2Cxc)[^"]*"[^>]*>/i).slice(1);
  for(const block of blocks){
    const a=block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if(!a)continue;
    let href=decodeHtml(a[1]);
    try{
      const u=new URL(href,'https://www.google.com');
      const q=u.searchParams.get('q');
      if(q)href=decodeURIComponent(q);
      else href=u.toString();
    }catch{}
    if(!/^https?:\/\//i.test(href))continue;
    try{
      const host=new URL(href).hostname.toLowerCase();
      if(/(^|\.)google\./.test(host))continue;
    }catch{continue}
    const title=stripHtml(a[2]);
    const text=stripHtml(block).slice(0,2500);
    const snippet=text.replace(title,'').trim();
    const key=href.split('#')[0];
    if(!seen.has(key)){
      seen.add(key);
      out.push({url:href,title,snippet});
    }
  }
  return out;
}

async function searchGoogleLinks(query){
  // Si une configuration Google Programmable Search est fournie, on utilise
  // l'API officielle. Sinon, on tente la page de résultats Google publique.
  // Cela permet de tester la méthode sans ajouter immédiatement une nouvelle clé payante.
  const apiKey=process.env.GOOGLE_CSE_API_KEY;
  const cx=process.env.GOOGLE_CSE_ID;
  if(apiKey&&cx){
    const u=new URL('https://www.googleapis.com/customsearch/v1');
    u.searchParams.set('key',apiKey);
    u.searchParams.set('cx',cx);
    u.searchParams.set('q',query);
    u.searchParams.set('num','10');
    u.searchParams.set('gl','fr');
    u.searchParams.set('hl','fr');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{
      const r=await fetch(u,{signal:controller.signal,headers:{'user-agent':'JML-Estimateur/1.9.3'}});
      if(!r.ok)throw Error('Google CSE HTTP '+r.status);
      const d=await r.json();
      return (d.items||[]).map(x=>({url:x.link,title:x.title||'',snippet:x.snippet||''})).filter(x=>/^https?:\/\//i.test(x.url));
    }finally{clearTimeout(timer);}
  }
  const u='https://www.google.com/search?q='+encodeURIComponent(query)+'&num=10&hl=fr&gl=fr';
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetch(u,{signal:controller.signal,headers:{
      'user-agent':'Mozilla/5.0 (compatible; JML-Estimateur/1.9.3; +https://jml-immobilier.fr)',
      'accept':'text/html,application/xhtml+xml',
      'accept-language':'fr-FR,fr;q=0.9'
    }});
    if(!r.ok)throw Error('Google HTTP '+r.status);
    return extractGoogleSearchResults(await r.text());
  }catch(e){
    if(e.name==='AbortError')throw Error('Délai dépassé pendant la recherche Google.');
    throw e;
  }finally{clearTimeout(timer);}
}

async function searchBingLinks(query){
  const u='https://www.bing.com/search?q='+encodeURIComponent(query)+'&count=10&setlang=fr-FR';
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetch(u,{signal:controller.signal,headers:{'user-agent':'Mozilla/5.0 JML-Estimateur/1.8','accept':'text/html,application/xhtml+xml'}});
    if(!r.ok)throw Error('Bing HTTP '+r.status);
    return extractBingSearchResults(await r.text());
  }catch(e){
    if(e.name==='AbortError')throw Error('Délai dépassé pendant la recherche web.');
    throw e;
  }finally{clearTimeout(timer);}
}
function listingFromSearchResult(r){
  const text=String((r.title||'')+' '+(r.snippet||''));
  const priceCandidates=[...text.matchAll(/(?:prix\s*[:\-]?\s*)?([0-9]{2,3}(?:[ .\u00a0][0-9]{3})+|[0-9]{5,6})\s*(?:€|euros?)/gi)]
    .map(m=>parseLooseNumber(m[1])).filter(x=>x>=10000&&x<=10000000);
  const sqmCandidates=[...text.matchAll(/([0-9]{2,4}(?:[.,][0-9]+)?)\s*(?:m²|m2|mètres?\s*carrés?)/gi)]
    .map(m=>parseLooseNumber(m[1])).filter(x=>x>=15&&x<=5000);
  const roomCandidates=[...text.matchAll(/(?:\b(?:T|F)\s*)?([1-9][0-9]?)\s*(?:pièces?|p\.|chambres?)/gi)]
    .map(m=>Number(m[1])).filter(x=>x>0&&x<30);
  const landCandidates=[...text.matchAll(/(?:terrain|parcelle)[^0-9]{0,30}([0-9]{2,5}(?:[.,][0-9]+)?)\s*m²/gi)]
    .map(m=>parseLooseNumber(m[1])).filter(x=>x>=20&&x<=100000);
  const price=priceCandidates[0]||0, area=sqmCandidates[0]||0;
  if(!price||!area)return null;
  const rooms=roomCandidates[0]||0;
  const landArea=landCandidates[0]||0;
  let locality='';
  const lm=text.match(/([A-ZÀ-Ÿ][^,|]{2,60})\s*\(?(?:0[0-9]|[1-9][0-9]){2}\)?/);
  if(lm)locality=lm[1].trim();
  return {
    source:new URL(r.url).hostname.replace(/^www\./,''),
    url:r.url,title:r.title||'Annonce immobilière',snippet:r.snippet||'',
    price,area,rooms,landArea,locality,
    sqmPrice:Math.round(price/area),
    importedAt:new Date().toISOString(),
    fromSearch:true
  };
}
async function searchWebLinks(query){
  try{
    const google=await searchGoogleLinks(query);
    const usable=google.filter(x=>{try{
      const u=new URL(x.url);
      return ['http:','https:'].includes(u.protocol);
    }catch{return false}});
    if(usable.length)return usable;
  }catch{}
  try{
    const bing=await searchBingLinks(query);
    const usable=bing.filter(x=>{try{
      const u=new URL(x.url);
      return ['http:','https:'].includes(u.protocol);
    }catch{return false}});
    if(usable.length)return usable;
  }catch{}
  const u='https://html.duckduckgo.com/html/?q='+encodeURIComponent(query)+'&kp=-2';
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetch(u,{signal:controller.signal,headers:{'user-agent':'Mozilla/5.0 JML-Estimateur/1.8'}});
    if(!r.ok)throw Error('Recherche HTTP '+r.status);
    return extractSearchResultLinks(await r.text());
  }catch(e){
    if(e.name==='AbortError')throw Error('Délai dépassé pendant la recherche des annonces actuelles.');
    throw e;
  }finally{clearTimeout(timer);}
}
function similarityForCompetition(x,input){
  const targetArea=n(input.livingArea)||n(input.landArea);
  const targetRooms=n(input.rooms);
  const targetLand=n(input.landArea);
  const areaRatio=targetArea&&x.area?Math.min(targetArea,x.area)/Math.max(targetArea,x.area):0;
  const areaScore=areaRatio?Math.max(0,100-Math.abs(x.area-targetArea)/targetArea*100):50;
  const roomScore=targetRooms&&x.rooms?Math.max(0,100-Math.abs(x.rooms-targetRooms)*45):55;
  const landRatio=targetLand&&x.landArea?Math.min(targetLand,x.landArea)/Math.max(targetLand,x.landArea):0;
  const landScore=landRatio?Math.max(0,100-Math.abs(x.landArea-targetLand)/targetLand*100):60;
  const textType=(x.title||'')+' '+(x.description||'');
  let type=competitionTypeFromText(textType);
  if(input.realtyType==='house' && type==='apartment' && /\b(?:t|f)\s*[1-9][0-9]?\b/i.test(textType) && !/\bappartement\b/i.test(norm(textType))) type='house';
  const typeScore=type===input.realtyType?100:0;
  const locality=norm((x.locality||'')+' '+(x.title||''));
  const city=norm(input.city||'');
  const localityScore=city&&locality&&locality.includes(city)?100:70;
  if(typeScore===0||areaRatio<.70)return null;
  if(targetRooms&&x.rooms&&Math.abs(x.rooms-targetRooms)>1)return null;
  if(targetLand&&x.landArea&&landRatio<.40)return null;
  const score=Math.round(areaScore*.40+roomScore*.25+landScore*.15+typeScore*.15+localityScore*.05);
  return {...x,similarity:score,type};
}
function extractCompetitionCity(rawAddress){
  const raw=String(rawAddress||'').replace(/\s+/g,' ').trim();
  if(!raw)return '';
  // Cette fonction sert uniquement de secours : le géocodage fournit normalement
  // la commune. Elle ne doit jamais confondre un morceau du nom de rue avec la ville.
  const postal=raw.match(/\b\d{5}\b/);
  if(postal){
    // Format : "08000 Charleville-Mézières - quartier".
    const after=raw.match(/\b\d{5}\s+(.+?)(?:\s+-\s+|$)/);
    if(after&&after[1]&&!after[1].trim().startsWith('-'))return after[1].trim();
    const before=raw.slice(0,postal.index).replace(/[,:\-]+\s*$/,'').trim();
    // Format : "25 rue ... Charleville-Mézières 08000 - quartier".
    const hyphenCity=before.match(/([A-ZÀ-Ÿ][A-Za-zÀ-ÿ'’]+(?:-[A-ZÀ-Ÿ][A-Za-zÀ-ÿ'’]+)+(?:\s+[A-ZÀ-Ÿ][A-Za-zÀ-ÿ'’]+)?)$/);
    if(hyphenCity)return hyphenCity[1].trim();
    // Format : "25 rue ..., Charleville 08000".
    const commaParts=before.split(/\s*,\s*/).filter(Boolean);
    if(commaParts.length)return commaParts.at(-1).trim();
  }
  const parts=raw.split(/\s+-\s+/);
  return (parts[0]||raw).split(',').at(-1).trim();
}


const DIRECT_MARKET_CATALOGUES=[
  {source:'JML Immobilier',urls:['https://www.jml-immobilier.fr/']},
  {source:'Toutabitat',urls:['https://www.toutabitat.com/immobiliers/achat','https://www.toutabitat.com/acheter']},
  {source:'Fischer Immobilier',urls:['https://www.fischer-immobilier.fr/immobiliers/achat','https://www.fischer-immobilier.fr/logements/liste']},
  {source:'Sassi Immobilier',urls:['https://www.sassi-immobilier.fr/vente','https://www.sassi-immobilier.fr/vente/maison/charleville-mezieres/08000']},
  {source:'Rimbaud Immo',urls:['https://www.rimbaudimmo.fr/vente','https://www.rimbaudimmo.fr/vente/appartement/charleville-mezieres/08000']},
  {source:'Justimmo08',urls:['https://www.justimmo08.fr/achat']}
];

async function fetchPublicPage(url){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7000);
  try{
    const r=await fetch(url,{signal:controller.signal,headers:{
      'user-agent':'Mozilla/5.0 (compatible; JML-Estimateur/1.9.9; +https://jml-immobilier.fr)',
      'accept':'text/html,application/xhtml+xml','accept-language':'fr-FR,fr;q=0.9'
    }});
    if(!r.ok)throw Error('Catalogue HTTP '+r.status);
    return await r.text();
  }finally{clearTimeout(timer);}
}

function extractCatalogueAnchors(html,baseUrl){
  const out=[],seen=new Set(),src=String(html||'');
  const re=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=re.exec(src))){
    let href=decodeHtml(m[1]); if(!href||/^javascript:|^mailto:|^tel:/i.test(href))continue;
    try{href=new URL(href,baseUrl).toString()}catch{continue}
    if(!/^https?:\/\//i.test(href))continue;
    const text=stripHtml(m[2]).replace(/\s+/g,' ').trim();
    const parent=src.slice(Math.max(0,m.index-1400),Math.min(src.length,re.lastIndex+1400));
    const block=stripHtml(parent).replace(/\s+/g,' ').trim();
    const combined=(text+' '+block).slice(0,5000);
    const hasPrice=/\b\d{2,3}(?:[ .\u00a0]\d{3})\s*(?:€|euros?)\b|\b\d{5,7}\s*(?:€|euros?)\b/i.test(combined);
    const hasArea=/\b\d{2,4}(?:[.,]\d+)?\s*m(?:²|2)\b/i.test(combined);
    const hasProperty=/(maison|appartement|pavillon|terrain|immeuble|local|commerce|garage|parking|loft|studio|duplex|propriete|villa)/i.test(combined);
    const isListingPath=/\/(?:vente|acheter|achat|immobiliers|logements|bien|biens|annonce)\//i.test(href);
    if(!(hasPrice||hasArea||hasProperty||isListingPath))continue;
    if(/\/(?:mentions-legales|honoraires|contact|cookies|politique|estimation|location|louer)(?:\/|$)/i.test(href))continue;
    const key=href.split('#')[0]; if(seen.has(key))continue; seen.add(key);
    out.push({url:key,title:text||'Annonce immobilière',snippet:block});
  }
  return out;
}

function listingFromCatalogueText(item,source){
  const title=decodeHtml(stripHtml(item.title||'')).replace(/\s+/g,' ').trim();
  const snippet=decodeHtml(stripHtml(item.snippet||'')).replace(/\s+/g,' ').trim();
  const text=title+' '+snippet;
  const prices=[...text.matchAll(/([0-9]{2,3}(?:[ .\u00a0]\d{3})+|[0-9]{5,7})\s*(?:€|euros?)/gi)]
    .map(m=>parseLooseNumber(m[1])).filter(x=>x>=10000&&x<=10000000);
  // Certains catalogues écrivent 115 m² sous la forme "115 m 2" ou utilisent
  // une balise <sup>2</sup>. Le texte nettoyé doit donc accepter les deux.
  const areaMatches=[...text.matchAll(/([0-9]{2,4}(?:[.,]\d+)?)\s*m(?:\s*²|\s*2)(?!\d)/gi)];
  // Sépare strictement la surface habitable de la surface de terrain :
  // "terrain/parcelle 400 m²" ne doit jamais devenir 400 m² habitables.
  const livingAreas=areaMatches
    .filter(m=>{
      const before=text.slice(Math.max(0,m.index-55),m.index);
      const terrainPos=Math.max(before.toLowerCase().lastIndexOf('terrain'),before.toLowerCase().lastIndexOf('parcelle'));
      const surfacePos=Math.max(before.toLowerCase().lastIndexOf('surface'),before.toLowerCase().lastIndexOf('habitable'));
      return terrainPos<0 || surfacePos>terrainPos;
    })
    .map(m=>parseLooseNumber(m[1])).filter(x=>x>=15&&x<=10000);
  const areas=livingAreas;
  const rooms=[...text.matchAll(/(?:\b(?:T|F)\s*)?([1-9][0-9]?)\s*(?:pièces?|p\.|chambres?)/gi)]
    .map(m=>Number(m[1])).filter(x=>x>0&&x<30);
  const land=[...text.matchAll(/(?:terrain|parcelle)[^0-9]{0,40}([0-9]{2,6}(?:[.,]\d+)?)\s*m\s*(?:²|2)\b/gi)]
    .map(m=>parseLooseNumber(m[1])).filter(x=>x>=20&&x<=100000);
  const price=prices[0]||0; if(!price)return null;
  const area=areas[0]||0;
  // Le titre de la carte est prioritaire pour le type : le bloc HTML voisin
  // peut contenir le type d'une autre carte.
  const titleType=competitionTypeFromText(title);
  const type=titleType||competitionTypeFromText(text);
  const cityCodes=/(08000|08120|08700|08500|08440|08150|08300|08090|08410)/g;
  const code=text.match(cityCodes);
  let locality='';
  if(code){const pos=text.lastIndexOf(code[0]),before=text.slice(Math.max(0,pos-80),pos).trim(),m=before.match(/([A-ZÀ-Ÿ][A-Za-zÀ-ÿ'’.-]+(?:[\s-]+[A-ZÀ-Ÿ][A-Za-zÀ-ÿ'’.-]+){0,4})\s*$/);if(m)locality=m[1].trim();}
  return {source,sourceType:'agence',url:item.url,title,snippet,price,area,rooms:rooms[0]||0,landArea:land[0]||0,locality,sqmPrice:area?Math.round(price/area):0,importedAt:new Date().toISOString(),fromCatalogue:true,type};
}

async function searchDirectAgencyCatalogues(input,city,typeLabel){
  const target=norm(city),results=[];
  for(const source of DIRECT_MARKET_CATALOGUES){
    const pages=await Promise.all(source.urls.map(async url=>{try{return{url,html:await fetchPublicPage(url)}}catch{return null}}));
    for(const page of pages.filter(Boolean)){
      const candidates=extractCatalogueAnchors(page.html,page.url).filter(x=>{
        const text=norm(x.title+' '+x.snippet);
        return !/(sous compromis|sous offre|vendu|offre acceptee|offre acceptée)/.test(text) &&
          /(prix|€|m²|maison|appartement|pavillon|terrain|immeuble|local|commerce|garage|parking|loft|studio|duplex)/.test(text);
      }).slice(0,30);
      for(const candidate of candidates){
        const parsed=listingFromCatalogueText(candidate,source.source); if(!parsed)continue;
        const text=norm(parsed.title+' '+parsed.snippet+' '+parsed.locality);
        const parsedType=parsed.type;
        const typeOk=parsedType===input.realtyType;
        const cityOk=!target||text.includes(target)||(/charleville/.test(target)&&/charleville/.test(text));
        if(!typeOk||!cityOk)continue;
        results.push(parsed); if(results.length>=30)break;
      }
      if(results.length>=30)break;
    }
    if(results.length>=30)break;
  }
  const unique=new Map();
  for(const x of results){const key=x.url||[x.source,x.price,x.area,x.rooms,norm(x.title)].join('|');if(!unique.has(key))unique.set(key,x);}
  return [...unique.values()].slice(0,25);
}

async function searchCompetitionListings(input){
  const city=String(input.city||extractCompetitionCity(input.address)||'').trim();
  input.city=city;
  const typeLabel={
    house:'maison',
    apartment:'appartement',
    commercial:'local commercial',
    industrial:'local industriel',
    garage:'garage',
    parking:'parking',
    land:'terrain'
  }[input.realtyType]||'immobilier';

  let directCatalogues=[];
  try{directCatalogues=await searchDirectAgencyCatalogues(input,city,typeLabel)}catch{}

  const portals=['seloger.com','leboncoin.fr','bienici.com','logic-immo.com','pap.fr'];
  // Base locale connue + découverte dynamique : on ne limite pas la couverture à
  // une poignée d'agences. La recherche est relancée par commune et peut découvrir
  // de nouveaux domaines d'agences sans modifier le moteur DVF.
  const agencies=[
    'jml-immobilier.fr','fischer-immobilier.fr','agence-ing.fr','sassi-immobilier.fr',
    'justimmo08.fr','ill-immobilier.fr','rimbaudimmo.fr',
    'charlevillemezieres.stephaneplazaimmobilier.com',
    'charleville-mezieres.guy-hoquet.com','guy-hoquet.com','citya.com',
    'charleville-arthurimmo.com'
  ];
  const ardennesTowns=[
    'Charleville-Mézières','Sedan','Rethel','Givet','Revin','Vouziers',
    'Nouzonville','Bogny-sur-Meuse','Fumay','Villers-Semeuse','Monthermé',
    'Carignan','Bazeilles','Donchery','Rocroi','Vireux-Wallerand','Asfeld',
    'Attigny','Signy-le-Petit','Renwez','La Francheville','Prix-lès-Mézières',
    'Aiglemont','Haybes','Floing','Raucourt-et-Flaba','Juniville','Rethel'
  ];
  const towns=[city,...ardennesTowns.filter(x=>norm(x)!==norm(city))].slice(0,18);

  const queries=[];
  // Portails : conservés comme source complémentaire.
  for(const domain of portals){
    queries.push(['site:'+domain,'"'+city+'"',typeLabel,'vente'].join(' '));
    queries.push(['site:'+domain,'"'+city+'"',typeLabel].join(' '));
  }
  // Agences connues : recherche directe dans leurs propres vitrines.
  for(const domain of agencies){
    queries.push(['site:'+domain,'"'+city+'"',typeLabel,'vente'].join(' '));
    queries.push(['site:'+domain,'"'+city+'"',typeLabel].join(' '));
    if(domain.includes('toutabitat.com')) queries.push(['site:'+domain,'"'+city+'"','biens','vente'].join(' '));
  }
  // Découverte départementale : recherche des sites d'agences dans chaque bassin.
  for(const town of towns){
    queries.push(['"'+town+'"','agence immobilière',typeLabel,'vente','-leboncoin','-seloger','-bienici','-logic-immo','-pap'].join(' '));
    queries.push(['"'+town+'"','agence immobilière','annonces',typeLabel,'-leboncoin','-seloger','-bienici','-logic-immo','-pap'].join(' '));
  }
  // Notaires : source officielle des annonces notariales du 08.
  queries.push(['site:immobilier.notaires.fr','Ardennes','vente',typeLabel].join(' '));
  queries.push(['site:chambre-interdep-08-10-51.notaires.fr','Ardennes','vente',typeLabel].join(' '));
  queries.push(['site:immonot.com','Ardennes','vente',typeLabel,'notaire'].join(' '));

  const querySet=[...new Set(queries)].slice(0,40);
  const searchBatches=[];
  for(let i=0;i<querySet.length;i+=5){
    const batch=querySet.slice(i,i+5);
    searchBatches.push(...await Promise.all(batch.map(q=>searchWebLinks(q).catch(()=>[]))));
  }
  const found=[];
  for(const links of searchBatches){
    for(const l of links){
      let parsedUrl;
      try{parsedUrl=new URL(l.url);}catch{continue}
      const host=parsedUrl.hostname.toLowerCase();
      const knownAgency=agencyHostAllowed(host);
      const knownNotary=notaryHostAllowed(host);
      const context=norm(String(l.title||'')+' '+String(l.snippet||''));
      const looksLikeAgency=/(agence immobili|immobilier|transaction|vente immobili|cabinet immobilier|mandataire)/.test(context);
      const looksLikeNotary=/(notaire|office notarial|immobilier\.notaires)/.test(context);
      const allowedPortal=competitionHostAllowed(host);
      if(!knownAgency && !knownNotary && !allowedPortal && !looksLikeAgency && !looksLikeNotary)continue;
      // Écarter les annuaires et intermédiaires.
      if(!knownAgency && !knownNotary && !allowedPortal && /(pagesjaunes|seloger|meilleursagents|societe\.com|thervy|immoplanete)/.test(host))continue;
      if(found.some(x=>x.url===l.url))continue;
      found.push(l);
      if(found.length>=60)break;
    }
    if(found.length>=60)break;
  }

  const direct=await Promise.allSettled(found.slice(0,50).map(async r=>{
    try{
      const item=await importCompetitionListing(r.url);
      const host=new URL(r.url).hostname.replace(/^www\./,'');
      return {...item,title:item.title&&item.title!=='Annonce immobilière'?item.title:(r.title||item.title),
        sourceType:notaryHostAllowed(host)?'notaire':agencyHostAllowed(host)?'agence':'portail',fromSearch:true};
    }catch{
      const item=listingFromSearchResult(r);
      if(!item)return null;
      const host=new URL(r.url).hostname.replace(/^www\./,'');
      return {...item,sourceType:notaryHostAllowed(host)?'notaire':agencyHostAllowed(host)?'agence':'portail'};
    }
  }));

  const parsed=direct.map(x=>x.status==='fulfilled'?x.value:null).filter(Boolean);
  const typeNeedle=norm(typeLabel);
  const market=parsed.filter(x=>{
    const text=norm((x.title||'')+' '+(x.snippet||'')+' '+(x.locality||''));
    const typeOk=input.realtyType==='house'
      ? /\bmaison\b|\bvilla\b|\bpavillon\b/.test(text)
      : input.realtyType==='apartment'
        ? /\bappartement\b|\bt[1-9][0-9]?\b|\bf[1-9][0-9]?\b/.test(text)
        : typeNeedle ? text.includes(typeNeedle) : true;
    return typeOk;
  });

  const unique=new Map();
  for(const x of market){
    const key=x.url||[x.source,x.price,x.area,x.rooms,norm(x.title)].join('|');
    if(!unique.has(key))unique.set(key,x);
  }
  const merged=[...directCatalogues,...unique.values()];
  const finalMap=new Map();
  for(const x of merged){const key=x.url||[x.source,x.price,x.area,x.rooms,norm(x.title)].join('|');if(!finalMap.has(key))finalMap.set(key,x);}
  return [...finalMap.values()].slice(0,25);
}

function validate(p){if(!p||!String(p.address||'').trim())throw Error('L’adresse du bien est obligatoire.');if(!TYPES[p.realtyType])throw Error('Type de bien invalide.');const area=['land','agricultural_land'].includes(p.realtyType)?n(p.landArea):n(p.livingArea);if(area<=0)throw Error('La surface du bien est obligatoire.');return{...p,livingArea:n(p.livingArea),landArea:n(p.landArea),rooms:n(p.rooms)}}
function send(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
function startServer(port=PORT){return http.createServer((req,res)=>{if(req.method==='GET'&&(new URL(req.url,'http://localhost').pathname==='/'||new URL(req.url,'http://localhost').pathname==='/index.html')){try{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(__dirname,'public','index.html')))}catch(e){send(res,500,{error:'Interface introuvable.'})}return}if(req.method==='POST'&&req.url==='/api/competition/search'){let b='';req.on('data',c=>{b+=c;if(b.length>65536)req.destroy()});req.on('end',async()=>{try{const p=JSON.parse(b||'{}');const listings=await searchCompetitionListings(p);send(res,200,{listings,searchedAt:new Date().toISOString(),criteria:{type:p.realtyType,area:n(p.livingArea)||n(p.landArea),rooms:n(p.rooms),city:extractCompetitionCity(p.city||p.address),source:'moteur de recherche web + annonces publiques indexées'},diagnostic:{city:extractCompetitionCity(p.city||p.address),resultCount:listings.length}})}catch(e){send(res,400,{error:e.message||'Erreur lors de la recherche des annonces actuelles.'})}});return}if(req.method==='POST'&&req.url==='/api/competition/import'){let b='';req.on('data',c=>{b+=c;if(b.length>65536)req.destroy()});req.on('end',async()=>{try{const p=JSON.parse(b||'{}');const listing=await importCompetitionListing(p.url);send(res,200,listing)}catch(e){send(res,400,{error:e.message||'Erreur lors de l’import de l’annonce.'})}});return}if(req.method==='POST'&&req.url==='/api/analyze'){let b='';req.on('data',c=>{b+=c;if(b.length>65536)req.destroy()});req.on('end',async()=>{try{const input=validate(JSON.parse(b||'{}')),geo=await geocode(input.address),rows=await loadDvf();const result=analyze(rows,input,geo);if(!result.manual)result.location={city:geo.city||'',postal:geo.postal||'',label:geo.label||''};send(res,200,result)}catch(e){send(res,400,{error:e.message||'Erreur inconnue.'})}});return}send(res,404,{error:'Route introuvable.'})}).listen(port,()=>console.log(`JML Estimateur V1.9.9 sur http://localhost:${port}`))}
function mockRows(prefix=''){return[
['72','145000','2026-08-20','49.7705','4.7205','4','300','1'],['75','152000','2026-07-10','49.7710','4.7210','4','280','2'],['68','132000','2026-05-10','49.7720','4.7220','3','250','3'],['80','160000','2025-12-10','49.7730','4.7230','4','320','4'],['74','148000','2025-10-10','49.7740','4.7240','4','290','5']
].map(x=>row({id_mutation:prefix+'-m'+x[7],date_mutation:x[2],nature_mutation:'Vente',valeur_fonciere:x[1],adresse_numero:x[7],adresse_nom_voie:'Rue Test',code_postal:'08000',nom_commune:'Charleville-Mézières',id_parcelle:prefix+'-p'+x[7],type_local:'Maison',surface_reelle_bati:x[0],nombre_pieces_principales:x[5],surface_terrain:x[6],latitude:x[3],longitude:x[4]}))}
if(require.main===module)startServer();
module.exports={startServer,searchCompetitionListings,similarityForCompetition,extractSearchResultLinks,extractCompetitionCity,commercialPricing,median,percentile,wmedian,rw,consolidate,select,selectFromBase,primaryComparables,weightedMean,estimateFromComparables,learnCorrection,characteristicAdjustment,analyze,mockRows,TYPES,geocode,loadDvf,extractCompetitionListing,importCompetitionListing};