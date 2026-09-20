// JML Immobilier — Estimateur V5
// Objectif : combiner plusieurs signaux immobiliers sans demander le prix souhaité
// avant d'avoir terminé l'analyse.
//
// Variable Render : IMMO_DATA_API_KEY
// Lancement local : IMMO_DATA_API_KEY="..." npm start

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.IMMO_DATA_API_KEY;
const MOCK_API_MODE = /^(1|true|yes)$/i.test(String(process.env.MOCK_API_MODE || ""));
const COMPARABLE_MIN_PPSM = Math.max(0, cleanNumber(process.env.COMPARABLE_MIN_PPSM, 400));
const COMPARABLE_ROBUST_MULT = Math.max(0.5, cleanNumber(process.env.COMPARABLE_ROBUST_MULT, 1.5));
const IMMO_BASE = "https://api.immo-data.fr";

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public"), { etag: false, lastModified: false, maxAge: 0 }));
app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function cleanNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isoDateMonthsAgo(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function percentile(values, p) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  const i = (a.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

function round100(value) {
  return Math.round(value / 100) * 100;
}

function round1000(value) {
  return Math.round(value / 1000) * 1000;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractPoint(tx) {
  const c = tx?.lot?.[0]?.location?.geometry?.coordinates;
  if (Array.isArray(c) && c.length >= 2) {
    return { lon: Number(c[0]), lat: Number(c[1]) };
  }
  return null;
}

function normalizeTransactions(raw, subject) {
  const data = Array.isArray(raw?.data) ? raw.data : [];
  return data.map(tx => {
    const attrs = tx.attributes || tx.realty || {};
    const point = extractPoint(tx);
    const livingArea = cleanNumber(attrs.livingArea || tx.livingArea);
    const landArea = cleanNumber(attrs.landArea || tx.landArea);
    const rooms = cleanNumber(attrs.rooms || tx.rooms);
    const price = cleanNumber(tx.price);
    const sqmPrice = cleanNumber(tx.squareMeterPrice || (price && livingArea ? price / livingArea : 0));
    const distanceKm = point ? haversineKm(subject.latitude, subject.longitude, point.lat, point.lon) : null;
    const date = tx.txDate || "";
    return {
      txId: tx.txId || "",
      date,
      price,
      sqmPrice,
      livingArea,
      landArea,
      rooms,
      distanceKm,
      streetName: tx?.lot?.[0]?.location?.address?.streetName || "",
      streetNumber: tx?.lot?.[0]?.location?.address?.streetNumber || "",
      cityName: tx?.lot?.[0]?.location?.address?.cityName || ""
    };
  }).filter(tx => tx.price > 0 && tx.livingArea > 0 && tx.sqmPrice > 0);
}

function robustFilter(transactions) {
  if (transactions.length < 4) return { items: transactions, mode: "insufficient-volume", reason: "moins de 4 ventes exploitables : aucun filtre statistique agressif appliqué" };
  const prices = transactions.map(x => x.sqmPrice);
  const q1 = percentile(prices, 0.25);
  const q3 = percentile(prices, 0.75);
  const iqr = q3 - q1;
  if (!Number.isFinite(iqr) || iqr <= 0) return { items: transactions, mode: "no-dispersion", reason: "dispersion statistique non exploitable : toutes les ventes conservées" };

  const low = Math.max(COMPARABLE_MIN_PPSM, q1 - COMPARABLE_ROBUST_MULT * iqr);
  const high = q3 + COMPARABLE_ROBUST_MULT * iqr;
  const strict = transactions.filter(x => x.sqmPrice >= low && x.sqmPrice <= high);
  if (strict.length >= 3) return { items: strict, mode: "iqr", reason: `${strict.length} ventes conservées après filtre IQR et seuil ${Math.round(COMPARABLE_MIN_PPSM)} €/m²` };

  // Fallback local, sans nouvel appel API : on évite qu'un marché atypique ou peu fourni
  // transforme une recherche réussie en "aucun comparable".
  const iqrOnly = transactions.filter(x => x.sqmPrice >= q1 - COMPARABLE_ROBUST_MULT * iqr && x.sqmPrice <= q3 + COMPARABLE_ROBUST_MULT * iqr);
  if (iqrOnly.length >= 3) return { items: iqrOnly, mode: "iqr-relaxed", reason: `${iqrOnly.length} ventes conservées après assouplissement du seuil minimum €/m²` };

  return { items: transactions, mode: "all-fallback", reason: `filtre statistique trop restrictif : ${transactions.length} ventes conservées avec avertissement` };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ageMonthsFromDate(date) {
  const t = new Date(date).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / (30.4375 * 86400000));
}

function comparableScore(tx, subject) {
  const surfaceRatio = subject.livingArea > 0 && tx.livingArea > 0
    ? Math.abs(tx.livingArea - subject.livingArea) / subject.livingArea
    : 1;
  const distance = Number.isFinite(tx.distanceKm) ? tx.distanceKm : 3;
  const ageMonths = ageMonthsFromDate(tx.date);
  const roomGap = subject.rooms > 0 && tx.rooms > 0 ? Math.abs(tx.rooms - subject.rooms) : 0;

  const surfaceScore = 30 * clamp(1 - surfaceRatio / 0.30, 0, 1);
  const distanceScore = 25 * clamp(1 - distance / 3, 0, 1);
  const recencyScore = 20 * clamp(1 - (ageMonths == null ? 24 : ageMonths) / 24, 0, 1);
  const roomScore = subject.rooms > 0 && tx.rooms > 0
    ? 15 * clamp(1 - roomGap / 3, 0, 1)
    : 8;
  const landScore = subject.landArea > 0 && tx.landArea > 0
    ? 10 * clamp(1 - Math.abs(tx.landArea - subject.landArea) / Math.max(subject.landArea, 1), 0, 1)
    : 5;

  return Math.round(surfaceScore + distanceScore + recencyScore + roomScore + landScore);
}

function similarityWeight(tx, subject) {
  const surfaceRatio = subject.livingArea > 0 ? Math.abs(tx.livingArea - subject.livingArea) / subject.livingArea : 1;
  const roomGap = subject.rooms > 0 && tx.rooms > 0 ? Math.abs(tx.rooms - subject.rooms) : 0;
  const distance = Number.isFinite(tx.distanceKm) ? tx.distanceKm : 1.5;
  const ageMonths = ageMonthsFromDate(tx.date);
  const recency = ageMonths == null ? 0.35 : Math.exp(-ageMonths / 6);
  const distanceWeight = 1 / (1 + distance / 0.5);
  const surfaceWeight = Math.exp(-surfaceRatio * 3);
  const roomWeight = Math.exp(-roomGap * 0.5);
  return Math.max(0.01, recency * distanceWeight * surfaceWeight * roomWeight);
}

function weightedMean(items, valueKey, weightFn) {
  let sum = 0;
  let weights = 0;
  for (const item of items) {
    const value = Number(item[valueKey]);
    const weight = weightFn(item);
    if (Number.isFinite(value) && Number.isFinite(weight) && weight > 0) {
      sum += value * weight;
      weights += weight;
    }
  }
  return weights ? sum / weights : null;
}

const API_CACHE = new Map();
const API_CACHE_TTL = {
  "/v1/geocode": 24 * 60 * 60 * 1000,
  "/v1/market/price/current": 6 * 60 * 60 * 1000,
  "/v1/valuation": 30 * 60 * 1000,
  "/v1/transactions": 60 * 60 * 1000,
  "/v1/listings/statistics": 30 * 60 * 1000
};

function cacheKey(endpoint, params) {
  return endpoint + "?" + Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function mockResponse(endpoint, params) {
  if (endpoint === "/v1/geocode") return [{ geoLevel: "address", label: params.q || "Adresse test", longitude: 3.235, latitude: 50.175, cityName: "Cambrai", postCode: "59400", inseeCode: "59122", districtCode: "TEST-DISTRICT", districtName: "Grand quartier test" }];
  if (endpoint === "/v1/market/price/current") return { value: 1760 };
  if (endpoint === "/v1/valuation") return { mainValuation: 188000, lowerValuation: 160000, upperValuation: 215000, confidence: 4 };
  if (endpoint === "/v1/transactions") {
    const area = Number(params.livingAreaMin || 100) + 10;
    return { data: Array.from({ length: 18 }, (_, i) => ({ txId: `MOCK-${i+1}`, txDate: isoDateMonthsAgo(Math.max(1, i % 18)), price: (1550 + (i % 6) * 75) * area, squareMeterPrice: 1550 + (i % 6) * 75, attributes: { livingArea: area + (i % 5) - 2, landArea: 300 + i * 12, rooms: 4 }, lot: [{ location: { geometry: { coordinates: [3.235 + i * 0.001, 50.175 + i * 0.001] }, address: { streetName: `Rue test ${i+1}`, streetNumber: `${i+1}` } } }] })) };
  }
  return {};
}

function logEvent(event, details = {}) {
  const payload = { ts: new Date().toISOString(), service: "jml-estimateur", event, ...details };
  console.log(JSON.stringify(payload));
}

async function immo(endpoint, params = {}, requestId = null) {
  if (MOCK_API_MODE) return cloneJson(mockResponse(endpoint, params));
  if (!API_KEY) throw new Error("Clé API Immo Data absente côté serveur.");

  const key = cacheKey(endpoint, params);
  const ttl = API_CACHE_TTL[endpoint] || 15 * 60 * 1000;
  const cached = API_CACHE.get(key);
  if (cached && (Date.now() - cached.at) < ttl) return cloneJson(cached.body);

  const url = new URL(IMMO_BASE + endpoint);
  for (const [paramKey, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(paramKey, String(value));
  }

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" }
    });
  } catch (networkError) {
    logEvent("api_network_error", { requestId, endpoint, durationMs: Date.now() - startedAt, error: networkError.message });
    throw networkError;
  }
  const body = await response.json().catch(() => ({}));
  logEvent(response.ok ? "api_success" : "api_http_error", { requestId, endpoint, status: response.status, durationMs: Date.now() - startedAt });
  if (!response.ok) {
    const error = new Error(`Immo Data ${response.status}: ${body.message || "erreur API"}`);
    error.status = response.status;
    error.apiBody = body;
    throw error;
  }

  API_CACHE.set(key, { at: Date.now(), body: cloneJson(body) });
  if (API_CACHE.size > 250) API_CACHE.delete(API_CACHE.keys().next().value);
  return body;
}

function isInsufficientBalance(error) {
  return Number(error?.status) === 402 || /Insufficient balance|solde insuffisant|balance/i.test(String(error?.message || ""));
}

async function geocodeAddress(address, requestId = null) {
  const rows = await immo("/v1/geocode", {
    q: address,
    geoLevel: "address,street,city,district",
    limit: 10
  }, requestId);
  const list = Array.isArray(rows) ? rows : (Array.isArray(rows.data) ? rows.data : []);
  if (!list.length) throw new Error("Adresse introuvable. Vérifie l'adresse saisie.");

  const addressHit = list.find(x => x.geoLevel === "address") || list[0];
  const center = Array.isArray(addressHit.center) ? addressHit.center : null;
  const coordinates = addressHit.coordinates || null;
  const lon = cleanNumber(addressHit.longitude ?? coordinates?.[0] ?? center?.[0]);
  const lat = cleanNumber(addressHit.latitude ?? coordinates?.[1] ?? center?.[1]);
  if (!lat || !lon) throw new Error("L'adresse a été trouvée mais ses coordonnées GPS sont indisponibles.");

  let city = list.find(x => x.geoLevel === "city" && x.inseeCode) || {};
  let district = list.find(x => x.geoLevel === "district" && (x.districtCode || x.code)) || {};

  const addressMeta = addressHit.address || addressHit;
  const streetCode = addressHit.streetCode || addressMeta.streetCode;
  const addressId = addressHit.addressId || addressMeta.addressId;

  return {
    latitude: lat,
    longitude: lon,
    label: addressHit.label || addressHit.name || address,
    cityName: addressHit.cityName || city.cityName || "",
    postCode: Array.isArray(addressHit.postCode) ? addressHit.postCode[0] : (addressHit.postCode || city.postCode?.[0] || ""),
    cityCode: addressHit.inseeCode || city.inseeCode || "",
    districtCode: addressHit.districtCode || district.districtCode || district.code || "",
    districtName: addressHit.districtName || district.districtName || "",
    streetCode,
    addressId
  };
}

async function marketPrice(code, geoLevel, realtyType, requestId = null) {
  if (!code) return null;
  try {
    return await immo("/v1/market/price/current", {
      code,
      geoLevel,
      marketType: "sales",
      realtyType,
      metric: "sqm_price"
    }, requestId);
  } catch (error) {
    logEvent("market_price_error", { endpoint: "/v1/market/price/current", status: error.status || null, error: error.message });
    return null;
  }
}

async function listingStats(subject, realtyType, dateMin) {
  try {
    return await immo("/v1/listings/statistics", {
      metrics: "squareMeterPrice,price,livingArea,numberOfRooms",
      stats: "mean,count,percentile",
      percentiles: "25,50,75",
      latitude: subject.latitude,
      longitude: subject.longitude,
      radius: 1500,
      marketType: "sales",
      realtyType,
      dateRef: "listed",
      dateMin,
      isActive: true,
      livingAreaMin: Math.max(20, Math.round(subject.livingArea * 0.75)),
      livingAreaMax: Math.round(subject.livingArea * 1.25),
      roomsMin: subject.rooms ? Math.max(1, subject.rooms - 1) : undefined,
      roomsMax: subject.rooms ? subject.rooms + 1 : undefined
    });
  } catch (_) {
    return null;
  }
}

async function findComparables(subject, realtyType, requestId = null) {
  // V5.4 : une seule requête large. Le classement est ensuite fait localement.
  const query = {
    latitude: subject.latitude, longitude: subject.longitude, radius: 3000,
    txType: "sales", realtyType,
    dateMin: isoDateMonthsAgo(24), dateMax: new Date().toISOString().slice(0, 10),
    // Requête volontairement large : les critères terrain/pièces sont appliqués
    // localement afin d'éviter d'exclure des ventes utiles avant le classement.
    livingAreaMin: Math.max(20, Math.round(subject.livingArea * 0.60)),
    livingAreaMax: Math.round(subject.livingArea * 1.40),
    size: 100, sortBy: "date", sortOrder: "desc"
  };

  let raw;
  try { raw = await immo("/v1/transactions", query, requestId); }
  catch (error) {
    return { foundCount: 0, analyzedCount: 0, total: 0, stage: "Transactions indisponibles",
      radiusMeters: 3000, months: 24, medianPpsm: null, weightedPpsm: null, estimatedValue: null,
      avgScore: null, avgDistanceKm: null, avgAgeMonths: null, data: [], unavailable: true,
      unavailableReason: isInsufficientBalance(error) ? "solde API insuffisant" : "source temporairement indisponible" };
  }

  const normalizedBeforeFilter = normalizeTransactions(raw, subject);
  const filterResult = robustFilter(normalizedBeforeFilter);
  const filtered = filterResult.items;
  const scored = filtered.map(x => ({ ...x, score: comparableScore(x, subject),
    ageMonths: ageMonthsFromDate(x.date), rawWeight: similarityWeight(x, subject) }));
  scored.sort((a, b) => b.score - a.score || b.rawWeight - a.rawWeight);

  const retained = scored.slice(0, 15);
  const totalWeight = retained.reduce((sum, x) => sum + x.rawWeight, 0);
  const ranked = retained.map(x => ({ ...x, influence: totalWeight > 0 ? Number(((x.rawWeight / totalWeight) * 100).toFixed(1)) : 0 }));

  const medianPpsm = median(ranked.map(x => x.sqmPrice));
  const weightedPpsm = weightedMean(ranked, "sqmPrice", x => x.rawWeight);
  const effectivePpsm = weightedPpsm || medianPpsm;

  return {
    foundCount: normalizedBeforeFilter.length, analyzedCount: filtered.length, total: ranked.length,
    stage: "Secteur élargi — 24 mois", radiusMeters: 3000, months: 24, medianPpsm, weightedPpsm, filterMode: filterResult.mode, filterReason: filterResult.reason,
    estimatedValue: effectivePpsm ? effectivePpsm * subject.livingArea : null,
    avgScore: ranked.length ? ranked.reduce((s, x) => s + x.score, 0) / ranked.length : null,
    avgDistanceKm: ranked.length ? ranked.reduce((s, x) => s + (Number.isFinite(x.distanceKm) ? x.distanceKm : 3), 0) / ranked.length : null,
    avgAgeMonths: ranked.length ? ranked.reduce((s, x) => s + (x.ageMonths == null ? 24 : x.ageMonths), 0) / ranked.length : null,
    data: ranked, unavailable: false
  };
}

function listingMedianPpsm(raw) {
  const metric = raw?.data?.[0]?.metrics?.squareMeterPrice;
  const p50 = metric?.percentiles?.find(x => Number(x.percentile) === 50)?.value;
  const mean = metric?.mean;
  return cleanNumber(p50 || mean, 0) || null;
}

function weightedMedian(items, valueFn, weightFn) {
  const rows = items.map(item => ({
    value: Number(valueFn(item)),
    weight: Number(weightFn(item))
  })).filter(x => Number.isFinite(x.value) && x.value > 0 && Number.isFinite(x.weight) && x.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!rows.length) return null;
  const total = rows.reduce((s, x) => s + x.weight, 0);
  let acc = 0;
  for (const row of rows) {
    acc += row.weight;
    if (acc >= total / 2) return row.value;
  }
  return rows[rows.length - 1].value;
}

function characteristicAdjustment(subject) {
  // Ajustements JML volontairement plafonnés : ils affinent les ventes et le prix
  // de secteur sans pouvoir remplacer les données de marché.
  const f = subject?.propertyFeatures || {};
  let pct = 0;
  const reasons = [];
  const add = (value, label) => { pct += value; if (value) reasons.push(`${label} ${value > 0 ? '+' : ''}${value}%`); };

  const condition = String(subject?.condition || '').toLowerCase();
  if (condition === 'excellent') add(6, 'état excellent');
  else if (condition === 'very_good') add(4, 'très bon état');
  else if (condition === 'good') add(2, 'bon état');
  else if (condition === 'refresh') add(-4, 'à rafraîchir');
  else if (condition === 'major_work') add(-9, 'travaux importants');

  const dpe = String(subject?.dpe || '').toUpperCase();
  if (dpe === 'A' || dpe === 'B') add(3, `DPE ${dpe}`);
  else if (dpe === 'E') add(-2, 'DPE E');
  else if (dpe === 'F') add(-5, 'DPE F');
  else if (dpe === 'G') add(-8, 'DPE G');

  if (subject?.terrace || f.balcony) add(2, 'extérieur');
  if (subject?.garage) add(2, 'garage');
  else if (subject?.parking) add(1, 'parking');
  if (subject?.cellar) add(1, 'cave');
  if (subject?.niceView) add(2, 'vue');
  if (f.elevator) add(2, 'ascenseur');

  const floor = Number(f.floor);
  if (subject?.realtyType === 'apartment' && Number.isFinite(floor)) {
    if (floor === 0) add(-2, 'rez-de-chaussée');
    else if (floor >= 4 && f.elevator) add(2, 'étage élevé avec ascenseur');
    else if (floor >= 2) add(1, 'étage');
  }

  // Pour les terrains, les facteurs dédiés remplacent les équipements résidentiels.
  if (subject?.realtyType === 'land') {
    if (String(f.buildable || '').toLowerCase().includes('constructible')) add(5, 'constructibilité');
    if (String(f.serviced || '').toLowerCase().includes('viabil')) add(3, 'viabilisation');
  }

  const capped = clamp(pct, -12, 12);
  return { factor: 1 + capped / 100, percent: capped, reasons };
}

function sourceQualityAndValue({ valuation, districtPrice, comparables, subject }) {
  const out = [];
  const adjustment = characteristicAdjustment(subject);
  const adjustmentLabel = adjustment.percent === 0
    ? 'aucun ajustement caractéristique'
    : `ajustement JML ${adjustment.percent > 0 ? '+' : ''}${adjustment.percent}% (${adjustment.reasons.join(', ')})`;

  if (comparables?.estimatedValue && comparables.total > 0) {
    const count = comparables.total;
    const countQ = clamp(count / 15, 0, 1);
    const similarityQ = clamp((comparables.avgScore || 0) / 100, 0, 1);
    const distanceQ = comparables.avgDistanceKm == null ? 0.35 : clamp(1 - comparables.avgDistanceKm / 3, 0, 1);
    const recencyQ = comparables.avgAgeMonths == null ? 0.35 : clamp(1 - comparables.avgAgeMonths / 24, 0, 1);
    const iqrRatio = comparables.iqrRatio == null ? 0.30 : comparables.iqrRatio;
    const dispersionQ = clamp(1 - iqrRatio / 0.45, 0.05, 1);

    const dataQuality = 100 * (
      0.30 * countQ +
      0.22 * similarityQ +
      0.18 * distanceQ +
      0.15 * recencyQ +
      0.15 * dispersionQ
    );

    // Quand la dispersion DVF est forte, les ventes deviennent moins aptes à
    // fixer seules le prix : on réduit leur fiabilité de départ plutôt que de
    // laisser une série de ventes atypiques tirer toute l'estimation vers le bas.
    const dvfReliability = iqrRatio >= 0.40 ? 0.72 : iqrRatio >= 0.30 ? 0.82 : 1.00;
    out.push({
      key: "dvf",
      name: "Ventes DVF comparables",
      value: comparables.estimatedValue * adjustment.factor,
      rawValue: comparables.estimatedValue,
      ppsm: (comparables.effectivePpsm || comparables.weightedPpsm || comparables.medianPpsm) * adjustment.factor,
      quality: Math.round(dataQuality),
      reason: `${count} ventes, similarité ${Math.round(comparables.avgScore || 0)}/100, distance moyenne ${comparables.avgDistanceKm == null ? "—" : comparables.avgDistanceKm.toFixed(2) + " km"} · ${adjustmentLabel}`,
      baseReliability: 1.15 * dvfReliability
    });
  }

  if (valuation?.mainValuation && subject?.livingArea > 0) {
    const apiConfidence = clamp((Number(valuation.confidence) || 1) / 5, 0, 1);
    const intervalRatio = valuation.lowerValuation && valuation.upperValuation
      ? Math.max(0, (valuation.upperValuation - valuation.lowerValuation) / (2 * valuation.mainValuation))
      : 0.20;
    const intervalQ = clamp(1 - intervalRatio / 0.35, 0.05, 1);
    const modelQuality = 100 * (0.60 * apiConfidence + 0.40 * intervalQ);
    out.push({
      key: "model",
      name: "Modèle d'estimation",
      value: valuation.mainValuation,
      ppsm: Number(valuation.mainValuation) / subject.livingArea,
      quality: Math.round(modelQuality),
      reason: `confiance API ${Number(valuation.confidence) || 1}/5, intervalle ${valuation.lowerValuation && valuation.upperValuation ? Math.round(intervalRatio * 100) + "%" : "non communiqué"}`,
      baseReliability: 1.00
    });
  }

  if (districtPrice?.value && subject?.livingArea > 0) {
    out.push({
      key: "district",
      name: "Prix du grand quartier",
      value: Number(districtPrice.value) * subject.livingArea * adjustment.factor,
      ppsm: Number(districtPrice.value) * adjustment.factor,
      quality: 55,
      reason: `indicateur de marché agrégé du grand quartier · ${adjustmentLabel}`,
      baseReliability: 0.65
    });
  }

  return out;
}

function calculateFinal({ valuation, cityPrice, districtPrice, listings, comparables, subject, confidenceDetails }) {
  const sources = sourceQualityAndValue({ valuation, districtPrice, comparables, subject });
  const consensus = weightedMedian(sources, x => x.ppsm, x => Math.max(1, x.quality * x.baseReliability));

  const scored = sources.map(source => {
    const deviation = consensus && source.ppsm > 0 ? Math.abs(source.ppsm - consensus) / consensus : 0;
    // Pénalité plus douce : un écart de source augmente l'incertitude, mais ne
    // doit pas automatiquement écraser le modèle ou le prix de secteur.
    const agreementFactor = clamp(Math.exp(-deviation / 0.30), 0.75, 1.05);
    const rawWeight = Math.max(0.01, (source.quality / 100) * source.baseReliability * agreementFactor);
    return { ...source, deviation, agreementFactor, rawWeight };
  });

  const listPpsm = listingMedianPpsm(listings);
  if (listPpsm) {
    const deviation = consensus ? Math.abs(listPpsm - consensus) / consensus : 0;
    const agreementFactor = clamp(Math.exp(-deviation / 0.30), 0.70, 1.05);
    scored.push({
      key: "listings", name: "Annonces actuellement en vente",
      value: listPpsm * subject.livingArea, ppsm: listPpsm, quality: 45,
      reason: "prix affichés, non prix de vente", baseReliability: 0.45,
      deviation, agreementFactor, rawWeight: Math.max(0.01, 0.45 * agreementFactor)
    });
  }

  const totalWeight = scored.reduce((s, x) => s + x.rawWeight, 0);
  if (!totalWeight) throw new Error("Pas assez de données de marché pour calculer une estimation.");

  // Garde-fou : lorsque la dispersion DVF est forte, aucune source DVF ne peut
  // représenter plus de 35 % du prix final. Le poids libéré est redistribué aux
  // autres sources déjà présentes, proportionnellement à leur poids.
  let normalized = scored.map(s => s.rawWeight / totalWeight);
  const dvfIndex = scored.findIndex(s => s.key === 'dvf');
  if (dvfIndex >= 0 && normalized[dvfIndex] > 0.35) {
    const excess = normalized[dvfIndex] - 0.35;
    normalized[dvfIndex] = 0.35;
    const otherTotal = normalized.reduce((sum, w, i) => i === dvfIndex ? sum : sum + w, 0);
    if (otherTotal > 0) normalized = normalized.map((w, i) => i === dvfIndex ? w : w + excess * (w / otherTotal));
  }

  const normalizedWeights = normalized.map(w => Math.round(w * 100));
  let weightDelta = 100 - normalizedWeights.reduce((sum, w) => sum + w, 0);
  if (normalizedWeights.length) {
    let maxIndex = 0;
    for (let i = 1; i < scored.length; i++) if (normalized[i] > normalized[maxIndex]) maxIndex = i;
    normalizedWeights[maxIndex] += weightDelta;
  }

  const displayedValues = scored.map(s => round100(s.value));
  const weightedDisplayedValue = displayedValues.reduce((sum, value, i) => sum + value * (normalizedWeights[i] / 100), 0);
  const main = round1000(weightedDisplayedValue);

  const spreadBase = confidenceDetails?.spread ?? 0.12;
  const apiSpread = valuation?.lowerValuation && valuation?.upperValuation && valuation.mainValuation
    ? Math.max((valuation.upperValuation - valuation.lowerValuation) / (2 * valuation.mainValuation), 0)
    : spreadBase;
  const spread = Math.min(0.22, Math.max(spreadBase, apiSpread));

  const contributions = scored.map((s, i) => ({
    key: s.key, name: s.name, value: displayedValues[i], weight: normalizedWeights[i],
    contribution: round100(displayedValues[i] * (normalizedWeights[i] / 100))
  }));

  return {
    main, low: round1000(main * (1 - spread)), high: round1000(main * (1 + spread)),
    consensusPpsm: consensus,
    signals: scored.map((s, i) => ({ ...s, value: round100(s.value), weight: normalizedWeights[i], quality: s.quality,
      agreement: Math.round(s.agreementFactor * 100), deviationPct: Math.round(s.deviation * 100), contribution: contributions[i].contribution })),
    displayedCalculation: { inputs: contributions, totalWeight: normalizedWeights.reduce((sum, w) => sum + w, 0), weightedTotal: round100(weightedDisplayedValue), final: main },
    spread
  };
}

function confidenceScore({ valuation, comparables, cityPrice, districtPrice, listings, subject }) {
  const factors = [];
  const count = comparables?.total || 0;
  const avgDistance = comparables?.avgDistanceKm;
  const avgAge = comparables?.avgAgeMonths;
  const avgSimilarity = comparables?.avgScore;

  const q1 = comparables?.total ? percentile((comparables.data || []).map(x => x.sqmPrice), 0.25) : null;
  const q3 = comparables?.total ? percentile((comparables.data || []).map(x => x.sqmPrice), 0.75) : null;
  const medianPpsm = comparables?.medianPpsm || null;
  const iqrRatio = Number.isFinite(q1) && Number.isFinite(q3) && medianPpsm > 0
    ? Math.max(0, (q3 - q1) / medianPpsm)
    : null;
  if (comparables) comparables.iqrRatio = iqrRatio;

  // Une seule valeur par source : DVF, modèle, quartier, puis éventuellement
  // annonces. La médiane et la moyenne pondérée DVF ne comptent pas comme deux sources.
  const sources = sourceQualityAndValue({ valuation, districtPrice, comparables, subject });
  const ppsms = sources.map(s => s.ppsm).filter(x => Number.isFinite(x) && x > 0);
  const sourceMedian = median(ppsms);
  const sourceDeviation = sourceMedian && ppsms.length > 1
    ? median(ppsms.map(x => Math.abs(x - sourceMedian) / sourceMedian))
    : null;

  const countPts = count >= 15 ? 20 : count >= 10 ? 18 : count >= 7 ? 15 : count >= 5 ? 12 : count >= 3 ? 8 : count >= 1 ? 4 : 0;
  const distancePts = avgDistance == null ? 0 : avgDistance <= 0.5 ? 15 : avgDistance <= 1 ? 12 : avgDistance <= 2 ? 8 : avgDistance <= 3 ? 5 : 2;
  const recencyPts = avgAge == null ? 0 : avgAge <= 3 ? 15 : avgAge <= 6 ? 13 : avgAge <= 12 ? 10 : avgAge <= 18 ? 7 : 4;
  const similarityPts = avgSimilarity == null ? 0 : avgSimilarity >= 85 ? 15 : avgSimilarity >= 75 ? 13 : avgSimilarity >= 65 ? 10 : avgSimilarity >= 55 ? 7 : 4;
  const dispersionPts = iqrRatio == null ? 4 : iqrRatio <= 0.10 ? 15 : iqrRatio <= 0.15 ? 12 : iqrRatio <= 0.20 ? 9 : iqrRatio <= 0.30 ? 6 : 3;
  const agreementPts = sourceDeviation == null ? 3 : sourceDeviation <= 0.05 ? 10 : sourceDeviation <= 0.10 ? 8 : sourceDeviation <= 0.15 ? 6 : sourceDeviation <= 0.25 ? 3 : 1;
  const coverageCount = sources.length;
  const coveragePts = coverageCount >= 4 ? 10 : coverageCount === 3 ? 7 : coverageCount === 2 ? 5 : coverageCount === 1 ? 3 : 0;

  factors.push({ key: "comparables", label: "Nombre de comparables", score: countPts, max: 20, detail: `${count} vente${count > 1 ? "s" : ""} retenue${count > 1 ? "s" : ""}` });
  factors.push({ key: "distance", label: "Proximité géographique", score: distancePts, max: 15, detail: avgDistance == null ? "Distance indisponible" : `moyenne ${avgDistance.toFixed(2)} km` });
  factors.push({ key: "recency", label: "Récence des ventes", score: recencyPts, max: 15, detail: avgAge == null ? "Date indisponible" : `moyenne ${avgAge.toFixed(1)} mois` });
  factors.push({ key: "similarity", label: "Similarité des biens", score: similarityPts, max: 15, detail: avgSimilarity == null ? "Non calculable" : `score moyen ${Math.round(avgSimilarity)}/100` });
  factors.push({ key: "dispersion", label: "Dispersion des prix", score: dispersionPts, max: 15, detail: iqrRatio == null ? "Dispersion indisponible" : `IQR ${Math.round(iqrRatio * 100)} %` });
  factors.push({ key: "agreement", label: "Cohérence des sources", score: agreementPts, max: 10, detail: sourceDeviation == null ? "Une seule source exploitable" : `écart médian ${Math.round(sourceDeviation * 100)} %` });
  factors.push({ key: "coverage", label: "Couverture multi-sources", score: coveragePts, max: 10, detail: `${coverageCount} source${coverageCount > 1 ? "s" : ""} exploitable${coverageCount > 1 ? "s" : ""}` });

  const score100 = Math.round(factors.reduce((s, x) => s + x.score, 0));
  const rating = score100 >= 85 ? 5 : score100 >= 70 ? 4 : score100 >= 55 ? 3 : score100 >= 40 ? 2 : 1;
  const label = rating === 5 ? "Très forte" : rating === 4 ? "Forte" : rating === 3 ? "Correcte" : rating === 2 ? "Faible" : "Très faible";
  const dispersionPart = iqrRatio == null ? 0.04 : clamp(iqrRatio * 0.45, 0.02, 0.12);
  const disagreementPart = sourceDeviation == null ? 0.02 : clamp(sourceDeviation * 0.40, 0.01, 0.08);
  const confidencePart = (100 - score100) * 0.0007;
  const spread = clamp(0.045 + dispersionPart + disagreementPart + confidencePart, 0.055, 0.22);

  return { score100, rating, label, factors, iqrRatio, sourceDeviation, spread, sourceCount: sources.length };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: "6.3.0", apiKeyConfigured: Boolean(API_KEY), mockMode: MOCK_API_MODE });
});

app.post("/api/analyze", async (req, res) => {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  try {
    // Mode test gratuit : aucune clé API n'est nécessaire.
    // MOCK_API_MODE=true force toutes les réponses Immo Data en local
    // et n'effectue aucun appel payant.
    if (!API_KEY && !MOCK_API_MODE) {
      return res.status(500).json({
        error: "La clé IMMO_DATA_API_KEY n'est pas configurée. Pour tester gratuitement, démarre le serveur avec MOCK_API_MODE=true."
      });
    }

    const b = req.body || {};
    const subject = {
      address: String(b.address || "").trim(),
      realtyType: b.realtyType === "apartment" ? "apartment" : "house",
      livingArea: cleanNumber(b.livingArea),
      landArea: cleanNumber(b.landArea),
      rooms: cleanNumber(b.rooms),
      bathrooms: cleanNumber(b.bathrooms),
      constructionYear: cleanNumber(b.constructionYear),
      dpe: String(b.dpe || ""),
      condition: String(b.condition || ""),
      parking: Boolean(b.parking),
      garage: Boolean(b.garage),
      cellar: Boolean(b.cellar),
      terrace: Boolean(b.terrace),
      patio: Boolean(b.patio),
      niceView: Boolean(b.niceView)
    };

    if (!subject.address) return res.status(400).json({ error: "L'adresse du bien est obligatoire." });
    if (!subject.livingArea || subject.livingArea < 10) return res.status(400).json({ error: "La surface habitable doit être renseignée." });

    logEvent("analysis_start", { requestId, realtyType: subject.realtyType, livingArea: subject.livingArea });
    const geo = await geocodeAddress(subject.address, requestId);
    subject.latitude = geo.latitude;
    subject.longitude = geo.longitude;

    // V5.4.4 : requête /valuation volontairement minimale.
    // La documentation Immo Data rend uniquement longitude, latitude, realtyType,
    // nbRooms et livingArea obligatoires. Nous n'envoyons plus aucun champ
    // facultatif à l'aveugle : cela évite qu'un seul paramètre optionnel invalide
    // fasse tomber toute l'estimation avec un HTTP 400.
    const valuationRooms = Math.min(15, Math.max(1, Math.round(subject.rooms || 1)));
    const valuationArea = Math.min(10000, Math.max(1, Number(subject.livingArea)));
    const valuationRealtyType = subject.realtyType === "apartment" ? "apartment" : "house";
    const valuationParams = {
      longitude: Number(subject.longitude),
      latitude: Number(subject.latitude),
      realtyType: valuationRealtyType,
      nbRooms: valuationRooms,
      livingArea: valuationArea
    };

    const valuationValidation = [
      ["longitude", Number.isFinite(valuationParams.longitude)],
      ["latitude", Number.isFinite(valuationParams.latitude)],
      ["realtyType", valuationParams.realtyType === "house" || valuationParams.realtyType === "apartment"],
      ["nbRooms", Number.isInteger(valuationParams.nbRooms) && valuationParams.nbRooms >= 1 && valuationParams.nbRooms <= 15],
      ["livingArea", Number.isFinite(valuationParams.livingArea) && valuationParams.livingArea >= 1 && valuationParams.livingArea <= 10000]
    ];
    const invalidValuationParam = valuationValidation.find(([, ok]) => !ok);
    if (invalidValuationParam) throw new Error(`Paramètre /valuation invalide avant envoi : ${invalidValuationParam[0]}`);

    const valuationPromise = immo("/v1/valuation", valuationParams)
      .then(value => ({ value, error: null, params: valuationParams }))
      .catch(error => ({
        value: null,
        params: valuationParams,
        error: {
          status: error.status || null,
          message: error.message || "Erreur valuation",
          apiBody: error.apiBody || null
        }
      }));

    // V5.4.4 : budget strict de 4 appels max par analyse :
    // 1 géocodage + 1 estimation + 1 prix quartier + 1 recherche transactions.
    // Les annonces et le prix commune sont désactivés par défaut pour éviter d'épuiser le solde.
    const districtPromise = marketPrice(geo.districtCode, "district", subject.realtyType, requestId);

    const [valuationResult, districtPrice, comparables] = await Promise.all([
      valuationPromise,
      districtPromise,
      findComparables(subject, subject.realtyType, requestId)
    ]);

    const valuation = valuationResult.value;
    const cityPrice = null;
    const listings = null;
    const confidenceDetails = confidenceScore({ valuation, comparables, cityPrice, districtPrice, listings, subject });
    const final = calculateFinal({ valuation, cityPrice, districtPrice, listings, comparables, subject, confidenceDetails });
    const confidence = confidenceDetails.rating;

    const result = {
      version: "6.3.0",
      requestId,
      property: {
        address: geo.label || subject.address,
        city: geo.cityName,
        postalCode: geo.postCode,
        cityCode: geo.cityCode,
        district: geo.districtName || "Grand quartier",
        districtCode: geo.districtCode,
        latitude: geo.latitude,
        longitude: geo.longitude,
        realtyType: subject.realtyType,
        livingArea: subject.livingArea,
        landArea: subject.landArea,
        rooms: subject.rooms,
        bathrooms: subject.bathrooms,
        constructionYear: subject.constructionYear,
        dpe: subject.dpe
      },
      estimate: {
        main: final.main,
        low: final.low,
        high: final.high,
        confidence,
        confidenceScore: confidenceDetails.score100,
        confidenceLabel: confidenceDetails.label,
        pricePerSqm: round100(final.main / subject.livingArea)
      },
      sources: {
        model: valuation ? {
          main: valuation.mainValuation,
          low: valuation.lowerValuation,
          high: valuation.upperValuation,
          confidence: valuation.confidence
        } : null,
        city: cityPrice?.value || null,
        district: districtPrice?.value || null,
        listings: listings ? {
          count: cleanNumber(listings?.data?.[0]?.size || listings?.data?.[0]?.count || listings?.data?.length || 0),
          medianPpsm: listingMedianPpsm(listings)
        } : null,
        comparables
      },
      method: {
        comparableWindow: `${comparables.months} mois`,
        comparableRadius: `${comparables.radiusMeters} m`,
        comparableSelection: comparables.stage,
        foundTransactions: comparables.foundCount || 0,
        analyzedTransactions: comparables.analyzedCount || comparables.foundCount || 0,
        retainedComparables: comparables.total || 0,
        reliability: confidenceDetails,
        consensusPpsm: final.consensusPpsm,
        filterMode: comparables.filterMode || null,
        filterReason: comparables.filterReason || null,
        sourceQuality: final.signals.map(s => ({ key: s.key, name: s.name, quality: s.quality, agreement: s.agreement, deviationPct: s.deviationPct, reason: s.reason })),
        displayedCalculation: final.displayedCalculation,
        apiWarning: [
          comparables.unavailable ? `Source transactions indisponible : ${comparables.unavailableReason}.` : null,
          valuationResult.error ? `Source estimation indisponible : ${valuationResult.error.message}${valuationResult.error.apiBody?.message ? ` (${valuationResult.error.apiBody.message})` : ""}.` : null
        ].filter(Boolean).join(" ") || null,
        note: "Mode économie API : 4 appels maximum par analyse (géocodage, estimation, quartier, transactions). Les poids sont calculés selon la qualité de chaque source, puis ajustés selon leur accord avec un consensus robuste. Le prix souhaité n’intervient jamais dans le calcul."
      },
      api: { maxCallsPerAnalysis: 4, cachedResponses: API_CACHE.size, transactionsUnavailable: Boolean(comparables.unavailable), valuationUnavailable: Boolean(valuationResult.error), listingsEnabled: false, cityPriceEnabled: false, mockMode: MOCK_API_MODE },
      signals: final.signals
    };

    logEvent("analysis_complete", { requestId, durationMs: Date.now() - startedAt, confidence: confidenceDetails.score100, sources: final.signals.map(s => s.key) });
    res.json(result);
  } catch (error) {
    logEvent("analysis_error", { requestId, durationMs: Date.now() - startedAt, status: error.status || 500, error: error.message });
    res.status(500).json({ error: error.message || "Erreur inconnue" });
  }
});

app.listen(PORT, () => {
  console.log(`JML Estimateur V6.3.0 sur http://localhost:${PORT}`);
  console.log(MOCK_API_MODE
    ? "MODE TEST GRATUIT : aucune requête Immo Data réelle ne sera envoyée."
    : "MODE API RÉELLE : les appels Immo Data peuvent consommer des crédits.");
});
