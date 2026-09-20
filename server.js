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
const IMMO_BASE = "https://api.immo-data.fr";

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

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

async function immo(endpoint, params = {}) {
  if (!API_KEY) throw new Error("Clé API Immo Data absente côté serveur.");
  const url = new URL(IMMO_BASE + endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
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
    throw new Error(`Immo Data ${response.status}: ${body.message || "erreur API"}`);
  }
  return body;
}

async function geocodeAddress(address) {
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

async function marketPrice(code, geoLevel, realtyType) {
  if (!code) return null;
  try {
    return await immo("/v1/market/price/current", {
      code,
      geoLevel,
      marketType: "sales",
      realtyType,
      metric: "sqm_price"
    });
  } catch (_) {
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

async function findComparables(subject, realtyType) {
  const stages = [
    { label: "Même secteur — 6 mois", radius: 500, months: 6 },
    { label: "Quartier élargi — 6 mois", radius: 1000, months: 6 },
    { label: "Quartier élargi — 12 mois", radius: 2000, months: 12 },
    { label: "Secteur élargi — 24 mois", radius: 3000, months: 24 }
  ];

  let selected = [];
  let usedStage = stages[stages.length - 1];

  for (const stage of stages) {
    const raw = await immo("/v1/transactions", {
      latitude: subject.latitude,
      longitude: subject.longitude,
      radius: stage.radius,
      txType: "sales",
      realtyType,
      dateMin: isoDateMonthsAgo(stage.months),
      dateMax: new Date().toISOString().slice(0, 10),
      livingAreaMin: Math.max(20, Math.round(subject.livingArea * 0.8)),
      livingAreaMax: Math.round(subject.livingArea * 1.2),
      minRoom: subject.rooms ? Math.max(1, subject.rooms - 1) : undefined,
      maxRoom: subject.rooms ? subject.rooms + 1 : undefined,
      landAreaMin: subject.landArea > 0 ? Math.max(1, Math.round(subject.landArea * 0.5)) : undefined,
      landAreaMax: subject.landArea > 0 ? Math.round(subject.landArea * 1.5) : undefined,
      size: 100,
      sortBy: "date",
      sortOrder: "desc"
    });

    const normalized = robustFilter(normalizeTransactions(raw, subject));
    selected = normalized;
    usedStage = stage;
    if (normalized.length >= 3) break;
  }

  const scored = selected.map(x => ({
    ...x,
    score: comparableScore(x, subject),
    ageMonths: ageMonthsFromDate(x.date),
    rawWeight: similarityWeight(x, subject)
  }));

  // On analyse toutes les transactions trouvées, puis on ne retient que les
  // meilleurs comparables. Cela évite qu'une longue liste de biens moyens
  // dilue les ventes réellement pertinentes.
  const rankedCandidates = scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.rawWeight - a.rawWeight;
  });
  const retained = rankedCandidates.slice(0, 15);
  const retainedWeightTotal = retained.reduce((sum, x) => sum + x.rawWeight, 0);
  const ranked = retained.map(x => ({
    ...x,
    influence: retainedWeightTotal > 0 ? Number(((x.rawWeight / retainedWeightTotal) * 100).toFixed(1)) : 0
  }));

  const ppsmValues = ranked.map(x => x.sqmPrice);
  const medianPpsm = median(ppsmValues);
  const weightedPpsm = weightedMean(ranked, "sqmPrice", x => x.rawWeight);
  const effectivePpsm = weightedPpsm || medianPpsm;
  const estimatedValue = effectivePpsm ? effectivePpsm * subject.livingArea : null;

  return {
    foundCount: selected.length,
    total: ranked.length,
    stage: usedStage.label,
    radiusMeters: usedStage.radius,
    months: usedStage.months,
    medianPpsm,
    weightedPpsm,
    estimatedValue,
    avgScore: ranked.length ? ranked.reduce((s, x) => s + x.score, 0) / ranked.length : null,
    avgDistanceKm: ranked.length ? ranked.reduce((s, x) => s + (Number.isFinite(x.distanceKm) ? x.distanceKm : 3), 0) / ranked.length : null,
    avgAgeMonths: ranked.length ? ranked.reduce((s, x) => s + (x.ageMonths == null ? usedStage.months : x.ageMonths), 0) / ranked.length : null,
    data: ranked
  };
}

function listingMedianPpsm(raw) {
  const metric = raw?.data?.[0]?.metrics?.squareMeterPrice;
  const p50 = metric?.percentiles?.find(x => Number(x.percentile) === 50)?.value;
  const mean = metric?.mean;
  return cleanNumber(p50 || mean, 0) || null;
}

function calculateFinal({ valuation, cityPrice, districtPrice, listings, comparables, subject, confidenceDetails }) {
  const signals = [];
  if (comparables?.estimatedValue) signals.push({ name: "Ventes DVF comparables", value: comparables.estimatedValue, weight: comparables.total >= 5 ? 0.50 : comparables.total >= 3 ? 0.42 : 0.28 });
  if (valuation?.mainValuation) signals.push({ name: "Modèle d'estimation", value: valuation.mainValuation, weight: valuation.confidence >= 4 ? 0.25 : valuation.confidence >= 3 ? 0.20 : 0.15 });
  if (districtPrice?.value) signals.push({ name: "Prix du grand quartier", value: districtPrice.value * subject.livingArea, weight: 0.12 });
  if (cityPrice?.value) signals.push({ name: "Prix de la commune", value: cityPrice.value * subject.livingArea, weight: 0.08 });
  const listPpsm = listingMedianPpsm(listings);
  if (listPpsm) signals.push({ name: "Annonces actuellement en vente", value: listPpsm * subject.livingArea, weight: 0.05 });

  const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
  if (!totalWeight) throw new Error("Pas assez de données de marché pour calculer une estimation.");
  const raw = signals.reduce((s, x) => s + x.value * x.weight, 0) / totalWeight;
  const main = round1000(raw);

  const spreadBase = confidenceDetails?.spread ?? (comparables?.total >= 5 ? 0.09 : comparables?.total >= 3 ? 0.12 : 0.16);
  const apiSpread = valuation?.lowerValuation && valuation?.upperValuation && valuation.mainValuation
    ? Math.max((valuation.upperValuation - valuation.lowerValuation) / (2 * valuation.mainValuation), 0)
    : spreadBase;
  const spread = Math.min(0.22, Math.max(spreadBase, apiSpread));

  return {
    main,
    low: round1000(main * (1 - spread)),
    high: round1000(main * (1 + spread)),
    signals: signals.map(s => ({ ...s, value: round100(s.value), weight: Math.round((s.weight / totalWeight) * 100) })),
    spread
  };
}

function confidenceScore({ valuation, comparables, cityPrice, districtPrice, listings, subject }) {
  const factors = [];
  const count = comparables?.total || 0;
  const avgDistance = comparables?.avgDistanceKm;
  const avgAge = comparables?.avgAgeMonths;
  const avgSimilarity = comparables?.avgScore;
  const values = [];

  if (comparables?.medianPpsm) values.push(comparables.medianPpsm);
  if (comparables?.weightedPpsm) values.push(comparables.weightedPpsm);
  if (valuation?.mainValuation && subject?.livingArea > 0) values.push(Number(valuation.mainValuation) / subject.livingArea);
  if (districtPrice?.value) values.push(Number(districtPrice.value));
  if (cityPrice?.value) values.push(Number(cityPrice.value));
  const listPpsm = listingMedianPpsm(listings);
  if (listPpsm) values.push(Number(listPpsm));

  const dispersionValues = comparables?.total ? [comparables.medianPpsm, comparables.weightedPpsm] : [];
  const q1 = comparables?.total ? percentile((comparables.data || []).map(x => x.sqmPrice), 0.25) : null;
  const q3 = comparables?.total ? percentile((comparables.data || []).map(x => x.sqmPrice), 0.75) : null;
  const medianPpsm = comparables?.medianPpsm || null;
  const iqrRatio = Number.isFinite(q1) && Number.isFinite(q3) && medianPpsm > 0
    ? Math.max(0, (q3 - q1) / medianPpsm)
    : null;

  const cleanValues = values.filter(x => Number.isFinite(x) && x > 0);
  const sourceMedian = median(cleanValues);
  const sourceDeviation = sourceMedian && cleanValues.length > 1
    ? median(cleanValues.map(x => Math.abs(x - sourceMedian) / sourceMedian))
    : null;

  const countPts = count >= 15 ? 20 : count >= 10 ? 18 : count >= 7 ? 15 : count >= 5 ? 12 : count >= 3 ? 8 : count >= 1 ? 4 : 0;
  const distancePts = avgDistance == null ? 0 : avgDistance <= 0.5 ? 15 : avgDistance <= 1 ? 12 : avgDistance <= 2 ? 8 : avgDistance <= 3 ? 5 : 2;
  const recencyPts = avgAge == null ? 0 : avgAge <= 3 ? 15 : avgAge <= 6 ? 13 : avgAge <= 12 ? 10 : avgAge <= 18 ? 7 : 4;
  const similarityPts = avgSimilarity == null ? 0 : avgSimilarity >= 85 ? 15 : avgSimilarity >= 75 ? 13 : avgSimilarity >= 65 ? 10 : avgSimilarity >= 55 ? 7 : 4;
  const dispersionPts = iqrRatio == null ? 4 : iqrRatio <= 0.10 ? 15 : iqrRatio <= 0.15 ? 12 : iqrRatio <= 0.20 ? 9 : iqrRatio <= 0.30 ? 6 : 3;
  const agreementPts = sourceDeviation == null ? 3 : sourceDeviation <= 0.05 ? 10 : sourceDeviation <= 0.10 ? 8 : sourceDeviation <= 0.15 ? 6 : sourceDeviation <= 0.25 ? 3 : 1;
  const coverageCount = [valuation?.mainValuation, districtPrice?.value, cityPrice?.value, listPpsm, comparables?.estimatedValue].filter(x => Number.isFinite(Number(x)) && Number(x) > 0).length;
  const coveragePts = coverageCount >= 5 ? 10 : coverageCount === 4 ? 9 : coverageCount === 3 ? 7 : coverageCount === 2 ? 5 : coverageCount === 1 ? 3 : 0;

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

  return { score100, rating, label, factors, iqrRatio, sourceDeviation, spread };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: "5.3.1", apiKeyConfigured: Boolean(API_KEY) });
});

app.post("/api/analyze", async (req, res) => {
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

    const geo = await geocodeAddress(subject.address);
    subject.latitude = geo.latitude;
    subject.longitude = geo.longitude;

    const valuationPromise = immo("/v1/valuation", {
      longitude: subject.longitude,
      latitude: subject.latitude,
      realtyType: subject.realtyType,
      nbRooms: Math.max(1, subject.rooms || 1),
      livingArea: subject.livingArea,
      bathrooms: subject.bathrooms || 0,
      landArea: subject.landArea || 0,
      constructionYear: subject.constructionYear || 0,
      dpe: subject.dpe,
      condition: ({
        excellent: 1,
        very_good: 1,
        good: 0,
        refresh: -1,
        major_work: -1
      })[subject.condition] ?? -1,
      parking: subject.parking,
      garage: subject.garage,
      cellar: subject.cellar,
      niceView: subject.niceView,
      patio: subject.patio,
      terrace: subject.terrace
    }).catch(() => null);

    const cityPromise = marketPrice(geo.cityCode, "city", subject.realtyType);
    const districtPromise = marketPrice(geo.districtCode, "district", subject.realtyType);
    const listingsPromise = listingStats(subject, subject.realtyType, isoDateMonthsAgo(6));

    const [valuation, cityPrice, districtPrice, listings, comparables] = await Promise.all([
      valuationPromise,
      cityPromise,
      districtPromise,
      listingsPromise,
      findComparables(subject, subject.realtyType)
    ]);

    const confidenceDetails = confidenceScore({ valuation, comparables, cityPrice, districtPrice, listings, subject });
    const final = calculateFinal({ valuation, cityPrice, districtPrice, listings, comparables, subject, confidenceDetails });
    const confidence = confidenceDetails.rating;

    const result = {
      version: "5.3.1",
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
        reliability: confidenceDetails,
        note: "Les ventes réelles DVF comparables sont privilégiées. La recherche s'élargit automatiquement seulement si le nombre de comparables est insuffisant."
      },
      signals: final.signals
    };

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Erreur inconnue" });
  }
});

app.listen(PORT, () => {
  console.log(`JML Estimateur V5.3.1 sur http://localhost:${PORT}`);
});
