require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || "Africa/Abidjan";

// Conserve la variable actuelle de Render.
// FOOTBALL_DATA_TOKEN est aussi accepté si tu souhaites la renommer plus tard.
const API_KEY =
  process.env.FOOTBALL_DATA_TOKEN || process.env.APIFOOTBALL_KEY;

const API_BASE = "https://api.football-data.org/v4";

const COMPETITIONS = {
  WC: "Coupe du Monde de la FIFA",
  CL: "Ligue des champions de l'UEFA",
  BL1: "Bundesliga",
  DED: "Eredivisie",
  BSA: "Campeonato Brasileiro Série A",
  PD: "Première Division espagnole",
  FL1: "Ligue 1",
  ELC: "Championship anglais",
  PPL: "Primeira Liga",
  EC: "Championnat d'Europe",
  SA: "Serie A italienne",
  PL: "Premier League",
};

const DEFAULT_COMPETITIONS = Object.keys(COMPETITIONS);

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
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }

  const parsed = new Date(`${date}T00:00:00Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}

function getRequestedCompetitions(req) {
  const requested = req.query.competitions || req.query.competition;

  if (!requested) {
    return DEFAULT_COMPETITIONS;
  }

  const codes = String(requested)
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);

  if (
    codes.length === 0 ||
    codes.some((code) => !Object.hasOwn(COMPETITIONS, code))
  ) {
    return null;
  }

  return [...new Set(codes)];
}

function mapMatch(match) {
  return {
    teams: {
      home: {
        name: match.homeTeam?.name || "Équipe à domicile",
      },
      away: {
        name: match.awayTeam?.name || "Équipe à l'extérieur",
      },
    },
    league: {
      name: match.competition?.name || "Compétition inconnue",
      code: match.competition?.code || null,
    },
    fixture: {
      id: match.id || null,
      date: match.utcDate || null,
      status: {
        short: match.status || "N/A",
      },
    },
    goals: {
      home: match.score?.fullTime?.home ?? null,
      away: match.score?.fullTime?.away ?? null,
    },
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    name: "FOOTBALL-PREDICTOR-PROX",
    apiKeyConfigured: Boolean(API_KEY),
    apiProvider: "football-data.org",
    timezone: TIMEZONE,
    competitionsConfigured: DEFAULT_COMPETITIONS.length,
    message: "Serveur démarré",
  });
});

app.get("/api/competitions", (req, res) => {
  res.json({
    count: DEFAULT_COMPETITIONS.length,
    competitions: Object.entries(COMPETITIONS).map(([code, name]) => ({
      code,
      name,
    })),
  });
});

async function getFixtures(req, res) {
  const date = String(req.query.date || getToday());

  if (!isValidDate(date)) {
    return res.status(400).json({
      error: "Date invalide. Utilise le format YYYY-MM-DD.",
    });
  }

  const competitionCodes = getRequestedCompetitions(req);

  if (!competitionCodes) {
    return res.status(400).json({
      error: "Code de compétition invalide.",
      availableCompetitions: COMPETITIONS,
    });
  }

  if (!API_KEY) {
    return res.status(500).json({
      error: "La clé API football-data.org est absente de Render.",
    });
  }

  try {
    const url = new URL(`${API_BASE}/matches`);

    // Utiliser date pour rechercher une seule journée.
    url.searchParams.set("date", date);

    // Rechercher uniquement les compétitions configurées.
    url.searchParams.set("competitions", competitionCodes.join(","));

    const response = await fetch(url, {
      headers: {
        "X-Auth-Token": API_KEY,
      },
      signal: AbortSignal.timeout(20000),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("football-data.org:", response.status, data);

      let message = "football-data.org a signalé un problème.";

      if (response.status === 400) {
        message =
          "Requête refusée. Vérifie les filtres et les codes de compétition.";
      } else if (response.status === 401) {
        message = "Jeton API invalide. Vérifie la clé enregistrée sur Render.";
      } else if (response.status === 403) {
        message =
          "Accès refusé. Vérifie les droits de ton compte sur les compétitions.";
      } else if (response.status === 429) {
        message =
          "Limite de requêtes API atteinte. Réessaie plus tard.";
      }

      return res.status(502).json({
        error: message,
        upstreamStatus: response.status,
        details:
          data.message ||
          data.error ||
          "Aucun détail supplémentaire fourni par l'API.",
      });
    }

    const matches = Array.isArray(data.matches) ? data.matches : [];

    const fixtures = matches
      .map(mapMatch)
      .sort((a, b) => {
        return new Date(a.fixture.date || 0) - new Date(b.fixture.date || 0);
      });

    return res.json({
      date,
      timezone: TIMEZONE,
      results: fixtures.length,
      competitionsRequested: competitionCodes,
      parameters: {
        date,
        competitions: competitionCodes.join(","),
      },
      errors: {},
      message: fixtures.length
        ? "Matchs récupérés avec succès depuis football-data.org."
        : "Aucun match retourné pour cette date dans les compétitions accessibles à ton compte.",
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

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});
