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

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return 0;
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
  if (transactions.length < 5) return transactions;
  const prices = transactions.map(x => x.sqmPrice).filter(Number.isFinite);
  const q1 = percentile(prices, 0.25);
  const q3 = percentile(prices, 0.75);
  const iqr = q3 - q1;
  if (!Number.isFinite(iqr) || iqr <= 0) return transactions;

  // Filtre volontairement robuste : on retire seulement les valeurs
  // franchement atypiques, sans imposer une moyenne arbitraire du marché.
  const low = Math.max(400, q1 - 1.5 * iqr);
  const high = q3 + 1.5 * iqr;
  return transactions.filter(x => x.sqmPrice >= low && x.sqmPrice <= high);
}

function comparableScore(tx, subject, geo) {
  const surfaceRatio = subject.livingArea > 0
    ? Math.abs(tx.livingArea - subject.livingArea) / subject.livingArea
    : 1;
  const roomGap = subject.rooms > 0 && tx.rooms > 0
    ? Math.abs(tx.rooms - subject.rooms)
    : 0;
  const distance = tx.distanceKm == null ? 2.5 : tx.distanceKm;
  const ageDays = Number.isFinite(new Date(tx.date).getTime())
    ? Math.max(0, (Date.now() - new Date(tx.date).getTime()) / 86400000)
    : 730;

  // Plus la vente est récente, proche et similaire en surface/pièces,
  // plus elle pèse dans l'estimation.
  const recency = Math.exp(-ageDays / 240);
  const distanceScore = 1 / (1 + distance / 0.55);
  const surfaceScore = Math.exp(-surfaceRatio * 3.2);
  const roomScore = Math.exp(-roomGap * 0.55);
  const streetBonus = geo?.streetName && tx.streetName
    ? (tx.streetName.trim().toLowerCase() === geo.streetName.trim().toLowerCase() ? 1.35 : 1)
    : 1;

  return recency * distanceScore * surfaceScore * roomScore * streetBonus;
}

function rankComparables(transactions, subject, geo) {
  if (!transactions.length) return [];

  const filtered = robustFilter(transactions);
  const source = filtered.length >= 3 ? filtered : transactions;

  return source
    .map(tx => ({ ...tx, relevanceScore: comparableScore(tx, subject, geo) }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
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

function weightedStdDev(items, valueKey, weightFn, mean) {
  let variance = 0;
  let weights = 0;
  for (const item of items) {
    const value = Number(item[valueKey]);
    const weight = weightFn(item);
    if (Number.isFinite(value) && Number.isFinite(weight) && weight > 0) {
      variance += ((value - mean) ** 2) * weight;
      weights += weight;
    }
  }
  return weights ? Math.sqrt(variance / weights) : null;
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

  const list = Array.isArray(rows) ? rows : (Array.isArray(rows?.data) ? rows.data : []);
  if (!list.length) throw new Error("Adresse introuvable. Vérifie l'adresse saisie.");

  const addressHit = list.find(x => x?.geoLevel === "address") || list[0];
  const cityHit = list.find(x => x?.geoLevel === "city") || {};
  const districtHit = list.find(x => x?.geoLevel === "district") || {};
  const addressMeta = addressHit?.address || addressHit || {};

  const center = Array.isArray(addressHit?.center) ? addressHit.center : null;
  const coordinates = Array.isArray(addressHit?.coordinates) ? addressHit.coordinates : null;
  const lon = firstNumber(addressHit?.longitude, addressMeta?.longitude, coordinates?.[0], center?.[0]);
  const lat = firstNumber(addressHit?.latitude, addressMeta?.latitude, coordinates?.[1], center?.[1]);
  if (!lat || !lon) throw new Error("L'adresse a été trouvée mais ses coordonnées GPS sont indisponibles.");

  const cityCode = addressHit?.inseeCode || addressMeta?.inseeCode || cityHit?.inseeCode || cityHit?.code || "";
  const districtCode = addressHit?.districtCode || addressMeta?.districtCode || districtHit?.districtCode || districtHit?.code || "";
  const streetCode = addressHit?.streetCode || addressMeta?.streetCode || "";

  return {
    latitude: lat,
    longitude: lon,
    label: addressHit?.label || addressHit?.name || address,
    cityName: addressHit?.cityName || addressMeta?.cityName || cityHit?.cityName || cityHit?.name || "",
    postCode: Array.isArray(addressHit?.postCode) ? addressHit.postCode[0] : (addressHit?.postCode || addressMeta?.postCode || cityHit?.postCode?.[0] || ""),
    cityCode,
    districtCode,
    districtName: addressHit?.districtName || addressMeta?.districtName || districtHit?.districtName || districtHit?.name || "",
    streetCode,
    streetName: addressHit?.streetName || addressMeta?.streetName || "",
    addressId: addressHit?.addressId || addressMeta?.addressId || ""
  };
}
async function marketPrice(code, geoLevel, realtyType) {
  if (!code) return null;
  try {
    const raw = await immo("/v1/market/price/current", {
      code,
      geoLevel,
      marketType: "sales",
      realtyType,
      metric: "sqm_price"
    });
    const value = firstNumber(raw?.value, raw?.data?.value);
    return value ? { ...raw, value } : null;
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

async function findComparables(subject, realtyType, geo) {
  const stages = [];
  if (geo?.streetCode) stages.push({ label: "Même rue — 6 mois", code: geo.streetCode, geoLevel: "street", months: 6, radius: 0 });
  if (geo?.districtCode) stages.push({ label: "Même grand quartier — 6 mois", code: geo.districtCode, geoLevel: "district", months: 6, radius: 0 });
  stages.push({ label: "Secteur — 6 mois", radius: 1000, months: 6 });
  if (geo?.districtCode) stages.push({ label: "Même grand quartier — 12 mois", code: geo.districtCode, geoLevel: "district", months: 12, radius: 0 });
  stages.push({ label: "Secteur élargi — 24 mois", radius: 3000, months: 24 });

  let selectedRaw = [];
  let usedStage = stages[stages.length - 1];

  for (const stage of stages) {
    const params = {
      txType: "sales",
      realtyType,
      dateMin: isoDateMonthsAgo(stage.months),
      dateMax: new Date().toISOString().slice(0, 10),
      livingAreaMin: Math.max(20, Math.round(subject.livingArea * 0.70)),
      livingAreaMax: Math.round(subject.livingArea * 1.30),
      minRoom: subject.rooms ? Math.max(1, subject.rooms - 2) : undefined,
      maxRoom: subject.rooms ? subject.rooms + 2 : undefined,
      size: 100,
      sortBy: "date",
      sortOrder: "desc"
    };
    if (stage.code) {
      params.code = stage.code;
      params.geoLevel = stage.geoLevel;
    } else {
      params.latitude = subject.latitude;
      params.longitude = subject.longitude;
      params.radius = stage.radius;
    }

    let raw;
    try {
      raw = await immo("/v1/transactions", params);
    } catch (e) {
      console.warn("Comparables stage failed:", stage.label, e.message);
      continue;
    }

    const normalized = normalizeTransactions(raw, subject);
    const ranked = rankComparables(normalized, subject, geo);
    selectedRaw = ranked;
    usedStage = stage;

    // On arrête dès que nous avons un échantillon exploitable.
    if (ranked.length >= 8) break;
    if (ranked.length >= 3 && stage === stages[stages.length - 1]) break;
  }

  const retained = selectedRaw.slice(0, 15);
  const ppsmValues = retained.map(x => x.sqmPrice);
  const medianPpsm = median(ppsmValues);
  const weightFn = x => Math.max(0.01, x.relevanceScore);
  const weightedPpsm = weightedMean(retained, "sqmPrice", weightFn);
  const effectivePpsm = weightedPpsm || medianPpsm;
  const estimatedValue = effectivePpsm ? effectivePpsm * subject.livingArea : null;
  const weightedStd = effectivePpsm ? weightedStdDev(retained, "sqmPrice", weightFn, effectivePpsm) : null;
  const dispersion = effectivePpsm && weightedStd ? weightedStd / effectivePpsm : null;

  return {
    total: selectedRaw.length,
    foundTotal: selectedRaw.length,
    retainedTotal: retained.length,
    stage: usedStage.label,
    radiusMeters: usedStage.radius || 0,
    months: usedStage.months,
    medianPpsm,
    weightedPpsm,
    estimatedValue,
    dispersion,
    data: retained
  };
}

function listingMedianPpsm(raw) {
  const metric = raw?.data?.[0]?.metrics?.squareMeterPrice || raw?.data?.[0]?.metrics?.sqmPrice;
  const p50 = metric?.percentiles?.find(x => Number(x.percentile) === 50)?.value;
  const mean = metric?.mean;
  return firstNumber(p50, mean) || null;
}

function calculateFinal({ valuation, cityPrice, districtPrice, listings, comparables, subject }) {
  const signals = [];
  if (comparables?.estimatedValue) signals.push({ name: "Ventes DVF comparables", value: comparables.estimatedValue, weight: comparables.retainedTotal >= 8 ? 0.50 : comparables.retainedTotal >= 5 ? 0.46 : comparables.retainedTotal >= 3 ? 0.40 : 0.28 });
  if (valuation?.mainValuation) signals.push({ name: "Modèle d'estimation", value: valuation.mainValuation, weight: valuation.confidence >= 4 ? 0.25 : valuation.confidence >= 3 ? 0.20 : 0.15 });
  if (districtPrice?.value) signals.push({ name: "Prix du grand quartier", value: districtPrice.value * subject.livingArea, weight: 0.12 });
  if (cityPrice?.value) signals.push({ name: "Prix de la commune", value: cityPrice.value * subject.livingArea, weight: 0.08 });
  const listPpsm = listingMedianPpsm(listings);
  if (listPpsm) signals.push({ name: "Annonces actuellement en vente", value: listPpsm * subject.livingArea, weight: 0.05 });

  const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
  if (!totalWeight) {
    throw new Error("Aucune donnée de marché exploitable n'a été retournée. Vérifie la clé API et les crédits Immo Data.");
  }
  const raw = signals.reduce((s, x) => s + x.value * x.weight, 0) / totalWeight;
  const main = round1000(raw);

  const spreadBase = comparables?.retainedTotal >= 8 ? 0.075 : comparables?.retainedTotal >= 5 ? 0.09 : comparables?.retainedTotal >= 3 ? 0.11 : 0.15;
  const apiSpread = valuation?.lowerValuation && valuation?.upperValuation && valuation.mainValuation
    ? Math.max((valuation.upperValuation - valuation.lowerValuation) / (2 * valuation.mainValuation), 0)
    : spreadBase;
  const dispersionSpread = Number.isFinite(comparables?.dispersion)
    ? Math.min(0.20, Math.max(0.055, comparables.dispersion * 0.75))
    : spreadBase;
  const spread = Math.min(0.22, Math.max(spreadBase, apiSpread, dispersionSpread));

  return {
    main,
    low: round1000(main * (1 - spread)),
    high: round1000(main * (1 + spread)),
    signals: signals.map(s => ({ ...s, value: round100(s.value), weight: Math.round((s.weight / totalWeight) * 100) })),
    spread
  };
}

function confidenceScore({ valuation, comparables, cityPrice, districtPrice, listings }) {
  let score = 0;
  if (valuation?.confidence) score += Math.min(2, Number(valuation.confidence) * 0.4);
  if (comparables?.retainedTotal >= 10) score += 2;
  else if (comparables?.retainedTotal >= 7) score += 1.8;
  else if (comparables?.retainedTotal >= 4) score += 1.4;
  else if (comparables?.retainedTotal >= 1) score += 0.6;
  if (Number.isFinite(comparables?.dispersion)) {
    if (comparables.dispersion <= 0.15) score += 0.7;
    else if (comparables.dispersion <= 0.25) score += 0.3;
  }
  if (districtPrice?.value) score += 0.6;
  if (cityPrice?.value) score += 0.4;
  if (listingMedianPpsm(listings)) score += 0.4;
  return Math.max(1, Math.min(5, Math.round(score)));
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: "5.2.0", apiKeyConfigured: Boolean(API_KEY) });
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
    const durationPromise = geo.cityCode ? immo("/v1/market/sale-duration/current", { code: geo.cityCode, geoLevel: "city", unit: "days" }).catch(() => null) : Promise.resolve(null);

    const [valuation, cityPrice, districtPrice, listings, comparables, saleDuration] = await Promise.all([
      valuationPromise,
      cityPromise,
      districtPromise,
      listingsPromise,
      findComparables(subject, subject.realtyType, geo),
      durationPromise
    ]);

    const final = calculateFinal({ valuation, cityPrice, districtPrice, listings, comparables, subject });
    const confidence = confidenceScore({ valuation, comparables, cityPrice, districtPrice, listings });

    const result = {
      version: "5.2.0",
      property: {
        address: geo.label || subject.address,
        city: geo.cityName,
        postalCode: geo.postCode,
        cityCode: geo.cityCode,
        district: geo.districtName || "Grand quartier",
        districtCode: geo.districtCode,
        streetCode: geo.streetCode,
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
          count: listings.data?.[0]?.size || 0,
          medianPpsm: listingMedianPpsm(listings)
        } : null,
        saleDuration: saleDuration?.value || null,
        comparables: {
          ...comparables,
          foundTotal: comparables.foundTotal,
          retainedTotal: comparables.retainedTotal
        }
      },
      method: {
        comparableWindow: `${comparables.months} mois`,
        comparableRadius: `${comparables.radiusMeters} m`,
        comparableSelection: comparables.stage,
        note: `Les ventes DVF sont classées selon la proximité, la récence et la similarité du bien. ${comparables.foundTotal} transaction(s) ont été trouvée(s) et ${comparables.retainedTotal} comparable(s) ont été retenu(s) pour le calcul. Les valeurs atypiques sont écartées lorsqu'elles sont statistiquement très éloignées du marché. La recherche s'élargit automatiquement seulement si nécessaire.`
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
  console.log(`JML Estimateur V5 sur http://localhost:${PORT}`);
});
