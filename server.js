
require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || "Africa/Abidjan";

// Clé du fournisseur de matchs existant.
const API_KEY =
  process.env.FOOTBALL_DATA_TOKEN || process.env.APIFOOTBALL_KEY;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

const API_BASE = "https://api.football-data.org/v4";

// Cache en mémoire pour limiter les appels IA répétés.
const aiCache = new Map();
const AI_CACHE_MS = 12 * 60 * 60 * 1000;

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

// Vérifie le fonctionnement du serveur.
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    name: "FOOTBALL-PREDICTOR-PROX",
    apiKeyConfigured: Boolean(API_KEY),
    aiKeyConfigured: Boolean(OPENAI_API_KEY),
    apiProvider: "football-data.org",
    timezone: TIMEZONE,
    competitionsConfigured: DEFAULT_COMPETITIONS.length,
    message: "Serveur démarré",
  });
});

// Liste des compétitions disponibles.
app.get("/api/competitions", (req, res) => {
  res.json({
    count: DEFAULT_COMPETITIONS.length,
    competitions: Object.entries(COMPETITIONS).map(([code, name]) => ({
      code,
      name,
    })),
  });
});

// Récupère les matchs d'une journée.
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
    url.searchParams.set("date", date);
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
        message = "Requête refusée. Vérifie les filtres et les compétitions.";
      } else if (response.status === 401) {
        message = "Jeton API invalide. Vérifie la clé enregistrée sur Render.";
      } else if (response.status === 403) {
        message = "Accès refusé. Vérifie les droits de ton compte API.";
      } else if (response.status === 429) {
        message = "Limite de requêtes API atteinte. Réessaie plus tard.";
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
      .sort(
        (a, b) =>
          new Date(a.fixture.date || 0) -
          new Date(b.fixture.date || 0)
      );

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
        : "Aucun match trouvé dans les compétitions accessibles pour cette date.",
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

// Extrait le texte d'une réponse OpenAI.
function extractAIText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];

  for (const item of data.output || []) {
    if (item.type !== "message") continue;

    for (const content of item.content || []) {
      if (
        (content.type === "output_text" || content.type === "text") &&
        typeof content.text === "string"
      ) {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

// Récupère les liens de sources disponibles dans la réponse.
function extractAISources(data) {
  const sources = new Map();

  for (const item of data.output || []) {
    // Sources fournies par l'outil de recherche Web.
    for (const source of item.action?.sources || []) {
      if (source.url) {
        sources.set(source.url, {
          title: source.title || source.url,
          url: source.url,
        });
      }
    }

    // Sources citées dans le texte final.
    for (const content of item.content || []) {
      for (const annotation of content.annotations || []) {
        if (annotation.url) {
          sources.set(annotation.url, {
            title: annotation.title || annotation.url,
            url: annotation.url,
          });
        }

        if (annotation.type === "url_citation" && annotation.url_citation?.url) {
          const citation = annotation.url_citation;

          sources.set(citation.url, {
            title: citation.title || citation.url,
            url: citation.url,
          });
        }
      }
    }
  }

  return [...sources.values()];
}

// Analyse IA des matchs de la journée avec recherche Web.
app.get("/api/ai-analysis", async (req, res) => {
  const date = String(req.query.date || getToday());

  if (!isValidDate(date)) {
    return res.status(400).json({
      error: "Date invalide. Utilise le format YYYY-MM-DD.",
    });
  }

  if (!API_KEY) {
    return res.status(500).json({
      error: "La clé football-data.org manque dans les variables Render.",
    });
  }

  if (!OPENAI_API_KEY) {
    return res.status(500).json({
      error: "La variable OPENAI_API_KEY manque dans les variables Render.",
      help: "Ajoute ta clé API OpenAI dans Render > Environment.",
    });
  }

  const cacheKey = `ai:${date}`;
  const cached = aiCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < AI_CACHE_MS) {
    return res.json({
      ...cached.data,
      cached: true,
    });
  }

  try {
    // Étape 1 : récupérer les matchs du jour.
    const fixturesURL = new URL(`${API_BASE}/matches`);
    fixturesURL.searchParams.set("date", date);
    fixturesURL.searchParams.set(
      "competitions",
      DEFAULT_COMPETITIONS.join(",")
    );

    const fixturesResponse = await fetch(fixturesURL, {
      headers: {
        "X-Auth-Token": API_KEY,
      },
      signal: AbortSignal.timeout(20000),
    });

    const fixturesData = await fixturesResponse.json().catch(() => ({}));

    if (!fixturesResponse.ok) {
      console.error(
        "Erreur football-data.org pour l'IA:",
        fixturesResponse.status,
        fixturesData
      );

      return res.status(502).json({
        error: "Impossible de récupérer les matchs pour l'analyse IA.",
        upstreamStatus: fixturesResponse.status,
        details: fixturesData.message || fixturesData.error || null,
      });
    }

    const matches = Array.isArray(fixturesData.matches)
      ? fixturesData.matches
      : [];

    if (matches.length === 0) {
      const emptyResult = {
        date,
        totalMatches: 0,
        results: [],
        analysis:
          "Aucun match n'a été retourné pour cette date dans les compétitions accessibles à ton compte.",
        sources: [],
        generatedAt: new Date().toISOString(),
        cached: false,
      };

      return res.json(emptyResult);
    }

    // Limite le nombre de matchs envoyés dans une seule requête IA.
    const selectedMatches = matches.slice(0, 20);

    const matchList = selectedMatches.map((match, index) => ({
      numero: index + 1,
      competition: match.competition?.name || "Compétition inconnue",
      date: match.utcDate || null,
      domicile: match.homeTeam?.name || "Équipe inconnue",
      exterieur: match.awayTeam?.name || "Équipe inconnue",
      statut: match.status || "INCONNU",
    }));

    const prompt = `
Tu es un analyste de football rigoureux. Réponds en français.

DATE DES MATCHS : ${date}
FUSEAU HORAIRE DU SITE : ${TIMEZONE}

MATCHS À ANALYSER :
${JSON.stringify(matchList, null, 2)}

MISSION :
Pour chaque match fourni, effectue une recherche Web actuelle et analyse,
dans la mesure où les informations fiables sont disponibles :

1. Les 5 à 10 derniers matchs de chaque équipe.
2. Les buts marqués et encaissés dans ces matchs.
3. La forme récente, en distinguant domicile et extérieur lorsque possible.
4. Les confrontations directes récentes si des données fiables existent.
5. Les blessures, suspensions et absences importantes confirmées par des sources.
6. Les probabilités estimées de victoire domicile, match nul et victoire extérieur.
   Les trois probabilités doivent totaliser environ 100 %.
7. Un score probable et un bref raisonnement.
8. Les principales incertitudes et la date des informations consultées.

RÈGLES STRICTES :
- Recherche des sources récentes et crédibles sur le Web.
- Ne prétends pas avoir vérifié une statistique si tu ne l'as pas trouvée.
- N'invente ni résultats récents, ni blessures, ni statistiques, ni sources.
- Si une information n'est pas disponible, indique clairement « données insuffisantes ».
- Les probabilités sont des estimations, pas des certitudes.
- Analyse tous les matchs fournis, dans la limite raisonnable de la réponse.
- Présente chaque match séparément avec les noms exacts des équipes.
- Termine chaque analyse par les liens des sources utilisées.
- Ne garantis jamais un résultat sportif.

Organise la réponse avec des titres lisibles, un match par section.
`;

    // Étape 2 : demander à OpenAI d'effectuer la recherche Web.
    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        tools: [{ type: "web_search" }],
        tool_choice: "required",
        input: prompt,
      }),
      signal: AbortSignal.timeout(180000),
    });

    const aiData = await aiResponse.json().catch(() => ({}));

    if (!aiResponse.ok) {
      console.error("Erreur OpenAI:", aiResponse.status, aiData);

      return res.status(502).json({
        error: "La recherche ou l'analyse OpenAI a échoué.",
        upstreamStatus: aiResponse.status,
        details:
          aiData.error?.message ||
          "Vérifie la clé API, le modèle configuré et les limites de ton compte OpenAI.",
      });
    }

    const analysis = extractAIText(aiData);

    if (!analysis) {
      return res.status(502).json({
        error: "OpenAI n'a pas renvoyé de texte d'analyse exploitable.",
      });
    }

    const result = {
      date,
      totalMatches: matches.length,
      analyzedMatches: selectedMatches.length,
      truncated: matches.length > selectedMatches.length,
      results: matchList,
      analysis,
      sources: extractAISources(aiData),
      generatedAt: new Date().toISOString(),
      cached: false,
    };

    aiCache.set(cacheKey, {
      timestamp: Date.now(),
      data: result,
    });

    return res.json(result);
  } catch (error) {
    console.error("Erreur analyse IA:", error);

    return res.status(502).json({
      error:
        error.name === "TimeoutError"
          ? "L'analyse IA a pris trop de temps. Réessaie plus tard."
          : "Une erreur est survenue pendant l'analyse IA.",
      details: error.message,
    });
  }
});

// Sert la page du site après les routes API.
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
  console.log(`Fuseau horaire : ${TIMEZONE}`);
  console.log(`Clé football-data.org configurée : ${Boolean(API_KEY)}`);
  console.log(`Clé OpenAI configurée : ${Boolean(OPENAI_API_KEY)}`);
});

