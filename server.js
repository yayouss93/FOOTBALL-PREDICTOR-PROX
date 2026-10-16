require("dotenv").config();

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || "Africa/Abidjan";

app.use(express.static("public"));

function getToday() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    name: "FOOTBALL-PREDICTOR-PROX",
    apiKeyConfigured: Boolean(process.env.APIFOOTBALL_KEY),
    timezone: TIMEZONE,
    message: "Serveur démarré",
  });
});

async function getFixtures(req, res) {
  const date = req.query.date || getToday();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      error: "Date invalide. Utilise le format YYYY-MM-DD.",
    });
  }

  const parsedDate = new Date(`${date}T00:00:00Z`);

  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    return res.status(400).json({
      error: "Cette date n'est pas valide.",
    });
  }

  const apiKey = process.env.APIFOOTBALL_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "La clé API-Football est absente de la configuration.",
    });
  }

  try {
    const url = new URL("https://v3.football.api-sports.io/fixtures");
    url.searchParams.set("date", date);
    url.searchParams.set("timezone", TIMEZONE);

    const response = await fetch(url, {
      headers: {
        "x-apisports-key": apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });

    const data = await response.json();

    if (!response.ok || (data.errors && Object.keys(data.errors).length > 0)) {
      return res.status(502).json({
        error: "API-Football a signalé un problème.",
        upstreamStatus: response.status,
        parameters: data.parameters || {},
        errors: data.errors || {},
      });
    }

    const fixtures = Array.isArray(data.response) ? data.response : [];

    res.json({
      date,
      timezone: TIMEZONE,
      results: fixtures.length,
      parameters: data.parameters || {},
      errors: data.errors || {},
      message:
        fixtures.length > 0
          ? "Matchs récupérés avec succès."
          : "Aucun match renvoyé par l'API pour cette date.",
      fixtures,
    });
  } catch (error) {
    console.error("Erreur API-Football :", error.message);

    res.status(502).json({
      error:
        error.name === "TimeoutError"
          ? "L'API-Football met trop de temps à répondre."
          : "Impossible de contacter API-Football.",
    });
  }
}

app.get("/api/fixtures/today", getFixtures);
app.get("/api/fixtures", getFixtures);

app.get("*", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});
