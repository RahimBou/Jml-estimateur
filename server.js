// JML Immobilier — Estimateur V3
// Adresse -> géocodage Immo Data -> estimation -> comparables.
// Le prix souhaité par le vendeur n'est jamais envoyé à Immo Data.

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.IMMO_DATA_API_KEY;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function immoData(endpoint, params = {}) {
  if (!API_KEY) {
    throw new Error("Clé API Immo Data absente côté serveur.");
  }

  const url = new URL("https://api.immo-data.fr" + endpoint);

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
    throw new Error(
      `Immo Data ${response.status}: ${body.message || "Erreur API"}`
    );
  }

  return body;
}

function firstGeocodeResult(body) {
  if (Array.isArray(body)) return body[0] || null;
  if (Array.isArray(body?.data)) return body.data[0] || null;
  if (Array.isArray(body?.results)) return body.results[0] || null;
  return body || null;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    immoDataConfigured: Boolean(API_KEY)
  });
});

app.post("/api/geocode", async (req, res) => {
  try {
    const address = String(req.body?.address || "").trim();

    if (!address) {
      return res.status(400).json({
        error: "Adresse manquante."
      });
    }

    const raw = await immoData("/v1/geocode", {
      q: address,
      geoLevel: "address,city",
      limit: 5
    });

    const result = firstGeocodeResult(raw);

    if (!result || !result.center || !result.inseeCode) {
      return res.status(404).json({
        error:
          "Adresse non trouvée. Vérifie le numéro, la rue et la commune."
      });
    }

    res.json({
      label: result.label || address,
      cityName: result.cityName || "",
      postCode: Array.isArray(result.postCode)
        ? result.postCode[0]
        : result.postCode || "",
      inseeCode: result.inseeCode,
      latitude: result.center[1],
      longitude: result.center[0]
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const b = req.body || {};

    const address = String(b.address || "").trim();
    const livingArea = numberOrZero(b.livingArea);

    if (!address) {
      return res.status(400).json({
        error: "Adresse du bien obligatoire."
      });
    }

    if (livingArea <= 0) {
      return res.status(400).json({
        error:
          "La surface habitable doit être supérieure à 0 m²."
      });
    }

    // 1. Recherche automatique de l'adresse
    const geocodeRaw = await immoData("/v1/geocode", {
      q: address,
      geoLevel: "address,city",
      limit: 5
    });

    const geo = firstGeocodeResult(geocodeRaw);

    if (!geo || !geo.center || !geo.inseeCode) {
      return res.status(404).json({
        error:
          "Adresse non trouvée. Vérifie l'adresse saisie."
      });
    }

    const longitude = Number(geo.center[0]);
    const latitude = Number(geo.center[1]);
    const cityCode = geo.inseeCode;

    // 2. Estimation Immo Data
    // Le prix souhaité par le vendeur n'est PAS transmis.
    const valuation = await immoData("/v1/valuation", {
      longitude,
      latitude,
      realtyType: b.realtyType || "house",
      nbRooms: numberOrZero(b.nbRooms),
      livingArea: livingArea,
      bathrooms: numberOrZero(b.bathrooms),
      landArea: numberOrZero(b.landArea),
      constructionYear: numberOrZero(b.constructionYear),
      dpe: b.dpe || "",
      parking: Boolean(b.parking),
      garage: Boolean(b.garage),
      cellar: Boolean(b.cellar),
      niceView: Boolean(b.niceView),
      patio: Boolean(b.patio),
      terrace: Boolean(b.terrace)
    });

    const results = {
      property: {
        address: address,
        matchedAddress: geo.label || address,
        cityName: geo.cityName || "",
        postCode: Array.isArray(geo.postCode)
          ? geo.postCode[0]
          : geo.postCode || "",
        cityCode: cityCode,
        latitude: latitude,
        longitude: longitude
      },

      valuation: valuation
    };

    // 3. Prix moyen du marché
    results.marketPrice = await immoData(
      "/v1/market/price/current",
      {
        code: cityCode,
        geoLevel: "city",
        marketType: "sales",
        realtyType: b.realtyType || "house",
        metric: "sqm_price"
      }
    ).catch(error => ({
      error: error.message
    }));

    // 4. Durée moyenne de vente
    results.saleDuration = await immoData(
      "/v1/market/sale-duration/current",
      {
        code: cityCode,
        geoLevel: "city",
        unit: "days"
      }
    ).catch(error => ({
      error: error.message
    }));

    // 5. Transactions comparables
    results.transactions = await immoData(
      "/v1/transactions",
      {
        latitude: latitude,
        longitude: longitude,
        radius: 5000,
        txType: "sales",
        realtyType: b.realtyType || "house",

        livingAreaMin: Math.max(
          1,
          Math.round(livingArea * 0.75)
        ),

        livingAreaMax: Math.round(
          livingArea * 1.25
        ),

        landAreaMin: b.landArea
          ? Math.max(
              1,
              Math.round(
                numberOrZero(b.landArea) * 0.5
              )
            )
          : undefined,

        landAreaMax: b.landArea
          ? Math.round(
              numberOrZero(b.landArea) * 1.5
            )
          : undefined,

        minRoom: b.nbRooms
          ? Math.max(
              1,
              numberOrZero(b.nbRooms) - 1
            )
          : undefined,

        maxRoom: b.nbRooms
          ? numberOrZero(b.nbRooms) + 1
          : undefined,

        size: 20,
        sortBy: "date",
        sortOrder: "desc"
      }
    ).catch(error => ({
      error: error.message
    }));

    res.json(results);

  } catch (error) {

    res.status(500).json({
      error: error.message
    });

  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `JML Estimateur V3 démarré sur le port ${PORT}`
  );
});
