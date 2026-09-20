// JML Immobilier — serveur V2
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.IMMO_DATA_API_KEY;

if (!API_KEY) {
  console.warn("⚠️ IMMO_DATA_API_KEY n'est pas définie.");
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function immo(pathname, params) {
  if (!API_KEY) {
    throw new Error("Clé API Immo Data absente côté serveur.");
  }

  const url = new URL("https://api.immo-data.fr" + pathname);

  Object.entries(params).forEach(([key, value]) => {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Accept": "application/json"
    }
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Immo Data ${response.status}: ${
        body.message || "Erreur API"
      }`
    );
  }

  return body;
}

app.post("/api/analyze", async (req, res) => {
  try {
    const b = req.body;

    if (
      !b.latitude ||
      !b.longitude ||
      !b.livingArea
    ) {
      return res.status(400).json({
        error:
          "Latitude, longitude et surface sont nécessaires."
      });
    }

    const valuation = await immo("/v1/valuation", {
      longitude: b.longitude,
      latitude: b.latitude,
      realtyType: b.realtyType || "house",
      nbRooms: b.nbRooms || 0,
      livingArea: b.livingArea,
      bathrooms: b.bathrooms || 0,
      landArea: b.landArea || 0,
      constructionYear: b.constructionYear || 0,
      dpe: b.dpe || "",
      parking: !!b.parking,
      garage: !!b.garage,
      cellar: !!b.cellar,
      niceView: !!b.niceView,
      patio: !!b.patio,
      terrace: !!b.terrace
    });

    const results = {
      valuation
    };

    if (b.cityCode) {
      results.marketPrice =
        await immo(
          "/v1/market/price/current",
          {
            code: b.cityCode,
            geoLevel: "city",
            marketType: "sales",
            realtyType:
              b.realtyType || "house",
            metric: "sqm_price"
          }
        ).catch(error => ({
          error: error.message
        }));

      results.saleDuration =
        await immo(
          "/v1/market/sale-duration/current",
          {
            code: b.cityCode,
            geoLevel: "city",
            unit: "days"
          }
        ).catch(error => ({
          error: error.message
        }));
    }

    results.transactions =
      await immo(
        "/v1/transactions",
        {
          latitude: b.latitude,
          longitude: b.longitude,
          radius: 5000,
          txType: "sales",
          realtyType:
            b.realtyType || "house",

          livingAreaMin: Math.max(
            1,
            Math.round(
              b.livingArea * 0.75
            )
          ),

          livingAreaMax:
            Math.round(
              b.livingArea * 1.25
            ),

          landAreaMin: b.landArea
            ? Math.max(
                1,
                Math.round(
                  b.landArea * 0.5
                )
              )
            : undefined,

          landAreaMax: b.landArea
            ? Math.round(
                b.landArea * 1.5
              )
            : undefined,

          minRoom: b.nbRooms
            ? Math.max(
                1,
                b.nbRooms - 1
              )
            : undefined,

          maxRoom: b.nbRooms
            ? b.nbRooms + 1
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

app.listen(PORT, () => {
  console.log(
    `JML Estimateur V2 démarré sur le port ${PORT}`
  );
});
