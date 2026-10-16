
require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || "Africa/Abidjan";
const API_KEY = process.env.APIFOOTBALL_KEY;

app.use(express.static(path.join(__dirname, "public")));

function getToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    name: "FOOTBALL-PREDICTOR-PROX",
    apiKeyConfigured: Boolean(API_KEY),
    apiProvider: "football-data.org",
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

  if (!API_KEY) {
    return res.status(500).json({
      error: "La clé football-data.org est absente de la configuration.",
    });
  }

  try {
    const url = new URL("https://api.football-data.org/v4/matches");
    url.searchParams.set("dateFrom", date);
    url.searchParams.set("dateTo", date);

    const response = await fetch(url, {
      headers: { "X-Auth-Token": API_KEY },
      signal: AbortSignal.timeout(15000),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("football-data.org:", response.status, data);

      return res.status(502).json({
        error: "football-data.org a signalé un problème.",
        upstreamStatus: response.status,
        details:
          data.message ||
          data.error ||
          "Vérifie la clé API et les limites du compte.",
      });
    }

    const matches = Array.isArray(data.matches) ? data.matches : [];

    const fixtures = matches.map((match) => ({
      teams: {
        home: { name: match.homeTeam?.name || "Équipe à domicile" },
        away: { name: match.awayTeam?.name || "Équipe à l'extérieur" },
      },
      league: {
        name: match.competition?.name || "Compétition inconnue",
      },
      fixture: {
        date: match.utcDate || null,
        status: { short: match.status || "N/A" },
      },
    }));

    return res.json({
      date,
      timezone: TIMEZONE,
      results: fixtures.length,
      parameters: { dateFrom: date, dateTo: date },
      errors: {},
      message: fixtures.length
        ? "Matchs récupérés avec succès depuis football-data.org."
        : "Aucun match disponible pour cette date dans les compétitions accessibles.",
      fixtures,
    });
  } catch (error) {
    console.error("Erreur football-data.org:", error.message);

    return res.status(502).json({
      error:
        error.name === "TimeoutError"
          ? "football-data.org met trop de temps à répondre."
          : "Impossible de contacter football-data.org.",
    });
  }
}

app.get("/api/fixtures/today", getFixtures);
app.get("/api/fixtures", getFixtures);

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});
