// JML Immobilier — Estimateur V5.4
// Moteur multi-sources avec budget API, cache mémoire, une seule recherche DVF
// progressive et mode dégradé si une source payante est indisponible.
//
// Render : IMMO_DATA_API_KEY
// Optionnel : JML_MAX_API_CALLS (défaut 4 appels par analyse)
// Optionnel : JML_ENABLE_LISTINGS=1 pour activer les statistiques d'annonces
// Lancement local : IMMO_DATA_API_KEY="..." npm start

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.IMMO_DATA_API_KEY;
const IMMO_BASE = "https://api.immo-data.fr";
const MAX_API_CALLS = Math.max(1, Number(process.env.JML_MAX_API_CALLS || 4));
const ENABLE_LISTINGS = process.env.JML_ENABLE_LISTINGS === "1";
const CACHE_TTL_MS = 30 * 60 * 1000;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const cache = new Map();

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
  if (transactions.length < 4) return transactions;
  const prices = transactions.map(x => x.sqmPrice);
  const q1 = percentile(prices, 0.25);
  const q3 = percentile(prices, 0.75);
  const iqr = q3 - q1;
  if (!Number.isFinite(iqr) || iqr <= 0) return transactions;
  const low = Math.max(400, q1 - 1.5 * iqr);
  const high = q3 + 1.5 * iqr;
  return transactions.filter(x => x.sqmPrice >= low && x.sqmPrice <= high);
}

function similarityScore(tx, subject) {
  const surfaceGap = subject.livingArea > 0
    ? Math.abs(tx.livingArea - subject.livingArea) / subject.livingArea
    : 1;
  const surfaceScore = clamp(100 - surfaceGap * 140, 0, 100);

  const roomScore = subject.rooms > 0 && tx.rooms > 0
    ? clamp(100 - Math.abs(tx.rooms - subject.rooms) * 25, 0, 100)
    : 70;

  const distanceScore = tx.distanceKm == null
    ? 45
    : 100 * Math.exp(-tx.distanceKm / 1.5);

  const ageDays = Math.max(0, (Date.now() - new Date(tx.date).getTime()) / 86400000);
  const recencyScore = Number.isFinite(ageDays)
    ? 100 * Math.exp(-ageDays / 540)
    : 35;

  const landScore = subject.landArea > 0 && tx.landArea > 0
    ? clamp(100 - Math.abs(tx.landArea - subject.landArea) / subject.landArea * 100, 0, 100)
    : 65;

  return clamp(
    surfaceScore * 0.35 +
    distanceScore * 0.25 +
    recencyScore * 0.20 +
    roomScore * 0.12 +
    landScore * 0.08,
    0, 100
  );
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

function scoreAndSelect(transactions, subject, max = 15) {
  const enriched = transactions.map(tx => ({ ...tx, score: similarityScore(tx, subject) }));
  enriched.sort((a, b) => b.score - a.score);

  const selected = enriched.slice(0, max);
  const totalInfluence = selected.reduce((s, x) => s + Math.max(1, x.score), 0);

  return selected.map(x => ({
    ...x,
    influence: totalInfluence ? (Math.max(1, x.score) / totalInfluence) * 100 : 0
  }));
}

async function geocodeAddress(address) {
  const cacheKey = `geo:${address.toLowerCase().trim()}`;
  const cached = getCache(cacheKey);
  if (cached) return { ...cached, cached: true };

  const rows = await immo("/v1/geocode", {
    q: address,
    geoLevel: "address,street,city,district",
    limit: 10
  });

  const list = Array.isArray(rows) ? rows : (Array.isArray(rows.data) ? rows.data : []);
  if (!list.length) throw new Error("Adresse introuvable. Vérifie l'adresse saisie.");

  const addressHit = list.find(x => x.geoLevel === "address") || list[0];
  const center = Array.isArray(addressHit.center) ? addressHit.center : null;
  const coordinates = addressHit.coordinates || null;
  const lon = cleanNumber(addressHit.longitude ?? coordinates?.[0] ?? center?.[0]);
  const lat = cleanNumber(addressHit.latitude ?? coordinates?.[1] ?? center?.[1]);
  if (!lat || !lon) throw new Error("L'adresse a été trouvée mais ses coordonnées GPS sont indisponibles.");

  const city = list.find(x => x.geoLevel === "city" && x.inseeCode) || {};
  const district = list.find(x => x.geoLevel === "district" && (x.districtCode || x.code)) || {};
  const addressMeta = addressHit.address || addressHit;

  const result = {
    latitude: lat,
    longitude: lon,
    label: addressHit.label || addressHit.name || address,
    cityName: addressHit.cityName || city.cityName || "",
    postCode: Array.isArray(addressHit.postCode) ? addressHit.postCode[0] : (addressHit.postCode || city.postCode?.[0] || ""),
    cityCode: addressHit.inseeCode || city.inseeCode || "",
    districtCode: addressHit.districtCode || district.districtCode || district.code || "",
    districtName: addressHit.districtName || district.districtName || "",
    streetCode: addressHit.streetCode || addressMeta.streetCode,
    addressId: addressHit.addressId || addressMeta.addressId
  };

  setCache(cacheKey, result);
  return result;
}

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value) {
  cache.set(key, { time: Date.now(), value });
}

function stableKey(endpoint, params) {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  return `${endpoint}?${sorted}`;
}

let apiCallsThisAnalysis = 0;
let apiCacheHitsThisAnalysis = 0;
let apiFailuresThisAnalysis = [];

async function immo(endpoint, params = {}) {
  const key = stableKey(endpoint, params);
  const cached = getCache(key);
  if (cached) {
    apiCacheHitsThisAnalysis++;
    return cached;
  }

  if (!API_KEY) throw new Error("Clé API Immo Data absente côté serveur.");
  if (apiCallsThisAnalysis >= MAX_API_CALLS) {
    const err = new Error("Budget API atteint : la source optionnelle a été ignorée.");
    err.code = "API_BUDGET";
    throw err;
  }

  apiCallsThisAnalysis++;

  const url = new URL(IMMO_BASE + endpoint);
  for (const [keyName, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(keyName, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json"
    }
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(`Immo Data ${response.status}: ${body.message || "erreur API"}`);
    err.status = response.status;
    if (response.status === 402) err.code = "INSUFFICIENT_BALANCE";
    apiFailuresThisAnalysis.push({ endpoint, status: response.status, code: err.code || "API_ERROR" });
    throw err;
  }

  setCache(key, body);
  return body;
}

async function safeCall(label, fn) {
  try {
    const value = await fn();
    return { value, available: true, label, cached: false };
  } catch (error) {
    return {
      value: null,
      available: false,
      label,
      error: error.message,
      code: error.code || "API_ERROR"
    };
  }
}

async function findComparables(subject, realtyType) {
  // Une seule requête volontairement large : 3 km / 24 mois.
  // On élargit ensuite localement en sélectionnant les meilleurs comparables.
  const rawResult = await safeCall("Ventes DVF", () => immo("/v1/transactions", {
    latitude: subject.latitude,
    longitude: subject.longitude,
    radius: 3000,
    txType: "sales",
    realtyType,
    dateMin: isoDateMonthsAgo(24),
    dateMax: new Date().toISOString().slice(0, 10),
    livingAreaMin: Math.max(20, Math.round(subject.livingArea * 0.75)),
    livingAreaMax: Math.round(subject.livingArea * 1.25),
    minRoom: subject.rooms ? Math.max(1, subject.rooms - 1) : undefined,
    maxRoom: subject.rooms ? subject.rooms + 1 : undefined,
    size: 100,
    sortBy: "date",
    sortOrder: "desc"
  }));

  if (!rawResult.available) {
    return {
      totalFound: 0, total: 0, radiusMeters: 3000, months: 24,
      medianPpsm: null, weightedPpsm: null, estimatedValue: null,
      data: [], error: rawResult.error, code: rawResult.code
    };
  }

  const normalizedRaw = normalizeTransactions(rawResult.value, subject);
  const filtered = robustFilter(normalizedRaw);
  const selected = scoreAndSelect(filtered, subject, 15);

  const ppsmValues = selected.map(x => x.sqmPrice);
  const medianPpsm = median(ppsmValues);
  const weightedPpsm = weightedMean(selected, "sqmPrice", x => Math.max(1, x.score));
  const effectivePpsm = weightedPpsm || medianPpsm;
  const estimatedValue = effectivePpsm ? effectivePpsm * subject.livingArea : null;

  const avgDistance = selected.length
    ? selected.reduce((s, x) => s + (x.distanceKm ?? 3), 0) / selected.length
    : null;
  const avgScore = selected.length
    ? selected.reduce((s, x) => s + x.score, 0) / selected.length
    : null;
  const dates = selected.map(x => new Date(x.date).getTime()).filter(Number.isFinite);
  const avgAgeDays = dates.length
    ? dates.reduce((s, t) => s + Math.max(0, (Date.now() - t) / 86400000), 0) / dates.length
    : null;

  return {
    totalFound: normalizedRaw.length,
    totalAfterFilter: filtered.length,
    total: selected.length,
    stage: "Secteur unique — 24 mois",
    radiusMeters: 3000,
    months: 24,
    medianPpsm,
    weightedPpsm,
    estimatedValue,
    avgDistanceKm: avgDistance,
    avgScore,
    avgAgeDays,
    data: selected
  };
}

function listingMedianPpsm(raw) {
  const metric = raw?.data?.[0]?.metrics?.squareMeterPrice;
  const p50 = metric?.percentiles?.find(x => Number(x.percentile) === 50)?.value;
  const mean = metric?.mean;
  return cleanNumber(p50 || mean, 0) || null;
}

function calculateFinal({ cityPrice, districtPrice, listings, comparables, subject }) {
  const signals = [];

  if (comparables?.estimatedValue) {
    signals.push({
      name: "Ventes DVF comparables",
      value: comparables.estimatedValue,
      weight: comparables.total >= 8 ? 0.66 : comparables.total >= 5 ? 0.58 : 0.48
    });
  }

  if (districtPrice?.value) {
    signals.push({ name: "Prix du grand quartier", value: districtPrice.value * subject.livingArea, weight: 0.18 });
  }

  if (cityPrice?.value) {
    signals.push({ name: "Prix de la commune", value: cityPrice.value * subject.livingArea, weight: 0.11 });
  }

  const listPpsm = listingMedianPpsm(listings);
  if (listPpsm) {
    signals.push({ name: "Annonces actuellement en vente", value: listPpsm * subject.livingArea, weight: 0.05 });
  }

  const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
  if (!totalWeight) throw new Error("Pas assez de données de marché pour calculer une estimation.");

  const raw = signals.reduce((s, x) => s + x.value * x.weight, 0) / totalWeight;
  const main = round1000(raw);

  const values = signals.map(x => x.value).filter(Number.isFinite);
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  const sourceSpread = q1 && q3 ? (q3 - q1) / Math.max(1, main) : 0.10;
  const dataSpread = comparables?.total >= 8 ? 0.07 : comparables?.total >= 5 ? 0.09 : 0.13;
  const spread = clamp(Math.max(dataSpread, sourceSpread), 0.05, 0.22);

  return {
    main,
    low: round1000(main * (1 - spread)),
    high: round1000(main * (1 + spread)),
    signals: signals.map(s => ({
      ...s,
      value: round100(s.value),
      weight: Math.round((s.weight / totalWeight) * 100)
    })),
    spread
  };
}

function confidenceDetails({ comparables, cityPrice, districtPrice, listings }) {
  const countPts = comparables.total >= 15 ? 20 : comparables.total >= 10 ? 18 : comparables.total >= 7 ? 15 : comparables.total >= 5 ? 12 : comparables.total >= 3 ? 8 : comparables.total >= 1 ? 4 : 0;

  const distance = comparables.avgDistanceKm;
  const distancePts = distance == null ? 0 : clamp(15 * Math.exp(-distance / 1.8), 0, 15);

  const age = comparables.avgAgeDays;
  const recencyPts = age == null ? 0 : clamp(15 * Math.exp(-age / 540), 0, 15);

  const similarityPts = comparables.avgScore == null ? 0 : clamp(comparables.avgScore * 0.15, 0, 15);

  const ppsm = (comparables.data || []).map(x => x.sqmPrice).filter(Number.isFinite);
  const q1 = percentile(ppsm, 0.25);
  const q3 = percentile(ppsm, 0.75);
  const med = median(ppsm);
  const dispersion = med ? (q3 - q1) / med : 1;
  const dispersionPts = ppsm.length >= 3 ? clamp(15 * (1 - dispersion / 0.8), 0, 15) : 0;

  const sourceValues = [
    comparables?.estimatedValue,
    districtPrice?.value && districtPrice.value * (comparables.data?.[0]?.livingArea || 1),
    cityPrice?.value && cityPrice.value * (comparables.data?.[0]?.livingArea || 1),
    listingMedianPpsm(listings) && listingMedianPpsm(listings) * (comparables.data?.[0]?.livingArea || 1)
  ].filter(Number.isFinite);

  let coherencePts = 0;
  if (sourceValues.length >= 2) {
    const medSource = median(sourceValues);
    const mad = median(sourceValues.map(v => Math.abs(v - medSource))) || 0;
    coherencePts = clamp(10 * (1 - mad / Math.max(1, medSource * 0.20)), 0, 10);
  }

  const sourceCount = [
    comparables?.estimatedValue,
    districtPrice?.value,
    cityPrice?.value,
    listingMedianPpsm(listings)
  ].filter(Boolean).length;
  const sourcesPts = clamp(sourceCount * 2.5, 0, 10);

  const score100 = Math.round(clamp(
    countPts + distancePts + recencyPts + similarityPts +
    dispersionPts + coherencePts + sourcesPts, 0, 100
  ));

  const confidence5 = clamp(Math.round(score100 / 20), 1, 5);

  return {
    score100,
    confidence5,
    criteria: [
      { name: "Nombre de comparables", points: Math.round(countPts), max: 20 },
      { name: "Proximité géographique", points: Math.round(distancePts), max: 15 },
      { name: "Récence des ventes", points: Math.round(recencyPts), max: 15 },
      { name: "Similarité des biens", points: Math.round(similarityPts), max: 15 },
      { name: "Dispersion des prix", points: Math.round(dispersionPts), max: 15 },
      { name: "Cohérence des sources", points: Math.round(coherencePts), max: 10 },
      { name: "Couverture multi-sources", points: Math.round(sourcesPts), max: 10 }
    ]
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "5.4.0",
    apiKeyConfigured: Boolean(API_KEY),
    maxApiCalls: MAX_API_CALLS,
    listingsEnabled: ENABLE_LISTINGS
  });
});

app.post("/api/analyze", async (req, res) => {
  apiCallsThisAnalysis = 0;
  apiCacheHitsThisAnalysis = 0;
  apiFailuresThisAnalysis = [];

  try {
    if (!API_KEY) return res.status(500).json({ error: "La clé IMMO_DATA_API_KEY n'est pas configurée sur le serveur." });

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

    const geoResult = await safeCall("Géocodage", () => geocodeAddress(subject.address));
    if (!geoResult.available) {
      return res.status(502).json({ error: geoResult.error });
    }

    const geo = geoResult.value;
    subject.latitude = geo.latitude;
    subject.longitude = geo.longitude;

    // Ordre de priorité : DVF > grand quartier > commune > annonces.
    // La recherche DVF est unique et large. Les appels optionnels ne sont jamais répétés.
    const comparablePromise = findComparables(subject, subject.realtyType);
    const districtPromise = geo.districtCode
      ? safeCall("Prix du grand quartier", () => marketPrice(geo.districtCode, "district", subject.realtyType))
      : Promise.resolve({ value: null, available: false, label: "Prix du grand quartier", error: "Code quartier indisponible" });
    const cityPromise = geo.cityCode
      ? safeCall("Prix de la commune", () => marketPrice(geo.cityCode, "city", subject.realtyType))
      : Promise.resolve({ value: null, available: false, label: "Prix de la commune", error: "Code commune indisponible" });

    // Les annonces sont désactivées par défaut pour protéger le solde.
    // On peut les réactiver plus tard avec JML_ENABLE_LISTINGS=1.
    const listingsPromise = ENABLE_LISTINGS
      ? safeCall("Annonces", () => listingStats(subject, subject.realtyType, isoDateMonthsAgo(6)))
      : Promise.resolve({ value: null, available: false, label: "Annonces", code: "DISABLED_FOR_BUDGET" });

    const [comparables, districtResult, cityResult, listingsResult] = await Promise.all([
      comparablePromise,
      districtPromise,
      cityPromise,
      listingsPromise
    ]);

    const districtPrice = districtResult.value;
    const cityPrice = cityResult.value;
    const listings = listingsResult.value;

    const final = calculateFinal({ cityPrice, districtPrice, listings, comparables, subject });
    const confidence = confidenceDetails({ comparables, cityPrice, districtPrice, listings });

    const result = {
      version: "5.4.0",
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
        confidence: confidence.confidence5,
        confidenceScore100: confidence.score100,
        pricePerSqm: round100(final.main / subject.livingArea)
      },
      sources: {
        model: null,
        city: cityPrice?.value || null,
        district: districtPrice?.value || null,
        listings: listings ? {
          count: listings.data?.[0]?.size || 0,
          medianPpsm: listingMedianPpsm(listings)
        } : null,
        comparables
      },
      reliability: confidence,
      api: {
        calls: apiCallsThisAnalysis,
        cacheHits: apiCacheHitsThisAnalysis,
        maxCalls: MAX_API_CALLS,
        failures: apiFailuresThisAnalysis,
        listingsEnabled: ENABLE_LISTINGS
      },
      method: {
        comparableWindow: `${comparables.months} mois`,
        comparableRadius: `${comparables.radiusMeters} m`,
        comparableSelection: comparables.stage,
        note: "Une seule recherche DVF large est effectuée. Les 15 comparables les plus pertinents sont ensuite sélectionnés localement. Les appels optionnels sont protégés par un budget et un cache.",
        budgetNote: ENABLE_LISTINGS
          ? "Mode multi-sources avec statistiques d'annonces activées."
          : "Statistiques d'annonces désactivées par défaut pour limiter les coûts API."
      },
      signals: final.signals
    };

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.message || "Erreur inconnue",
      code: error.code || "SERVER_ERROR",
      api: {
        calls: apiCallsThisAnalysis,
        cacheHits: apiCacheHitsThisAnalysis,
        failures: apiFailuresThisAnalysis
      }
    });
  }
});

async function marketPrice(code, geoLevel, realtyType) {
  if (!code) return null;
  return immo("/v1/market/price/current", {
    code,
    geoLevel,
    marketType: "sales",
    realtyType,
    metric: "sqm_price"
  });
}

async function listingStats(subject, realtyType, dateMin) {
  return immo("/v1/listings/statistics", {
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
}
