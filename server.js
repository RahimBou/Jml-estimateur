// JML Immobilier — Estimateur V4
// Adresse -> géocodage -> estimation Immo Data -> marché -> comparables.
// Le prix souhaité par le vendeur n'est jamais envoyé à Immo Data.

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.IMMO_DATA_API_KEY;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function addParam(url, key, value) {
  if (value !== undefined && value !== null && value !== "") {
    url.searchParams.set(key, String(value));
  }
}

async function immoData(endpoint, params = {}) {
  if (!API_KEY) throw new Error("Clé API Immo Data absente côté serveur.");

  const url = new URL("https://api.immo-data.fr" + endpoint);
  for (const [key, value] of Object.entries(params)) addParam(url, key, value);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json"
    }
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail =
      body?.message ||
      body?.error ||
      body?.errors?.[0]?.message ||
      `HTTP ${response.status}`;
    throw new Error(`Immo Data ${response.status}: ${detail}`);
  }

  return body;
}

function firstResult(body) {
  if (Array.isArray(body)) return body[0] || null;
  if (Array.isArray(body?.data)) return body.data[0] || null;
  if (Array.isArray(body?.results)) return body.results[0] || null;
  return body || null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function int(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function bool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function mapCondition(value) {
  if (value === "renovate") return -1;
  if (value === "excellent") return 1;
  if (value === "standard") return 0;
  return null;
}

function normalizeTransactions(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.results)) return body.results;
  if (Array.isArray(body.transactions)) return body.transactions;
  return [];
}

function compactTransaction(tx) {
  // Structure conforme au schéma actuel de /v1/transactions.
  const attributes = tx.attributes || {};
  const address = tx.lot?.[0]?.location?.address || {};

  return {
    date: tx.txDate || tx.date || tx.transactionDate || null,
    price: num(tx.price),
    livingArea: num(attributes.livingArea ?? tx.livingArea),
    landArea: num(attributes.landArea ?? tx.landArea),
    rooms: int(attributes.rooms ?? tx.rooms),
    realtyType: tx.realtyType || null,
    city: address.cityName || null,
    postalCode: address.postCode || null
  };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, immoDataConfigured: Boolean(API_KEY) });
});

app.post("/api/geocode", async (req, res) => {
  try {
    const address = String(req.body?.address || "").trim();
    if (!address) return res.status(400).json({ error: "Adresse manquante." });

    const raw = await immoData("/v1/geocode", {
      q: address,
      geoLevel: "address,city",
      limit: 5
    });

    const geo = firstResult(raw);
    if (!geo?.center || !geo?.inseeCode) {
      return res.status(404).json({
        error: "Adresse non trouvée. Vérifiez le numéro, la rue et la commune."
      });
    }

    res.json({
      label: geo.label || address,
      cityName: geo.cityName || "",
      postCode: Array.isArray(geo.postCode) ? geo.postCode[0] : (geo.postCode || ""),
      inseeCode: geo.inseeCode,
      latitude: Number(geo.center[1]),
      longitude: Number(geo.center[0])
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const b = req.body || {};
    const address = String(b.address || "").trim();
    const realtyType = b.realtyType === "apartment" ? "apartment" : "house";
    const livingArea = num(b.livingArea);
    const nbRooms = int(b.nbRooms);

    if (!address) return res.status(400).json({ error: "Adresse du bien obligatoire." });
    if (!livingArea || livingArea < 1 || livingArea > 10000) {
      return res.status(400).json({ error: "La surface habitable doit être comprise entre 1 et 10 000 m²." });
    }
    if (!nbRooms || nbRooms < 1 || nbRooms > 15) {
      return res.status(400).json({ error: "Le nombre de pièces doit être compris entre 1 et 15." });
    }

    // 1) Géocodage
    const geocodeRaw = await immoData("/v1/geocode", {
      q: address,
      geoLevel: "address,city",
      limit: 5
    });

    const geo = firstResult(geocodeRaw);
    if (!geo?.center || !geo?.inseeCode) {
      return res.status(404).json({
        error: "Adresse non trouvée. Vérifiez l'adresse saisie."
      });
    }

    const longitude = Number(geo.center[0]);
    const latitude = Number(geo.center[1]);
    const cityCode = geo.inseeCode;

    // 2) Estimation.
    // IMPORTANT : aucun prix vendeur n'est lu ni envoyé ici.
    const valuationParams = {
      longitude,
      latitude,
      realtyType,
      nbRooms,
      livingArea
    };

    const condition = mapCondition(b.condition);
    if (condition !== null) valuationParams.condition = condition;

    const bathrooms = int(b.bathrooms);
    if (bathrooms !== null && bathrooms >= 0 && bathrooms <= 5) {
      valuationParams.bathrooms = bathrooms;
    }

    const constructionYear = int(b.constructionYear);
    const currentYear = new Date().getFullYear();
    if (constructionYear !== null && constructionYear >= 0 && constructionYear <= currentYear) {
      valuationParams.constructionYear = constructionYear;
    }

    const dpe = String(b.dpe || "").toUpperCase();
    if (/^[A-G]$/.test(dpe)) valuationParams.dpe = dpe;

    if (realtyType === "house") {
      const landArea = num(b.landArea);
      if (landArea !== null && landArea >= 0 && landArea <= 1000000) {
        valuationParams.landArea = landArea;
      }
      if (bool(b.pool)) valuationParams.pool = true;
    }

    if (bool(b.cellar)) valuationParams.cellar = true;
    if (bool(b.parking)) valuationParams.parking = true;
    if (bool(b.niceView)) valuationParams.niceView = true;

    // Immo Data appelle "patio" la terrasse d'un appartement.
    // Pour une maison, la terrasse reste une information du dossier
    // mais n'est pas envoyée à l'API de valorisation.
    if (realtyType === "apartment" && bool(b.terrace)) {
      valuationParams.patio = true;
    }

    const valuation = await immoData("/v1/valuation", valuationParams);

    // 3) Informations de marché : si l'un de ces appels échoue,
    // l'estimation principale reste disponible.
    const [marketPrice, saleDuration] = await Promise.all([
      immoData("/v1/market/price/current", {
        code: cityCode,
        geoLevel: "city",
        marketType: "sales",
        realtyType,
        metric: "sqm_price"
      }).catch(error => ({ error: error.message })),

      immoData("/v1/market/sale-duration/current", {
        code: cityCode,
        geoLevel: "city",
        unit: "days"
      }).catch(error => ({ error: error.message }))
    ]);

    // 4) Comparables DVF proches, avec seulement des paramètres documentés.
    const minArea = Math.max(1, Math.round(livingArea * 0.75));
    const maxArea = Math.round(livingArea * 1.25);

    const txParams = {
      latitude,
      longitude,
      radius: 5000,
      txType: "sales",
      realtyType,
      livingAreaMin: minArea,
      livingAreaMax: maxArea,
      minRoom: Math.max(1, nbRooms - 1),
      maxRoom: Math.min(15, nbRooms + 1),
      size: 20,
      sortBy: "date",
      sortOrder: "desc"
    };

    if (realtyType === "house") {
      const landArea = num(b.landArea);
      if (landArea !== null && landArea > 0) {
        txParams.landAreaMin = Math.max(1, Math.round(landArea * 0.5));
        txParams.landAreaMax = Math.round(landArea * 1.5);
      }
    }

    const transactionsRaw = await immoData("/v1/transactions", txParams)
      .catch(error => ({ error: error.message }));

    const transactions = normalizeTransactions(transactionsRaw)
      .map(compactTransaction)
      .filter(tx => tx.price !== null || tx.livingArea !== null);

    res.json({
      property: {
        address,
        matchedAddress: geo.label || address,
        cityName: geo.cityName || "",
        postCode: Array.isArray(geo.postCode) ? geo.postCode[0] : (geo.postCode || ""),
        cityCode,
        latitude,
        longitude,
        realtyType,
        livingArea,
        nbRooms
      },
      valuation,
      marketPrice,
      saleDuration,
      transactions
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Erreur serveur." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`JML Estimateur V4.1 démarré sur le port ${PORT}`);
});
