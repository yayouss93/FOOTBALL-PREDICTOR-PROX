
const freeAnalysisCache = new Map();
const teamHistoryCache = new Map();
let lastHistoryRequestAt = 0;

const FREE_CACHE_MS = 12 * 60 * 60 * 1000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTeamHistory(teamId, competitionCode) {
  const cacheKey = `${teamId}:${competitionCode || "all"}`;
  const cached = teamHistoryCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < FREE_CACHE_MS) {
    return cached.matches;
  }

  // Respecter approximativement la limite de l'offre gratuite.
  const waitMs = Math.max(
    0,
    6500 - (Date.now() - lastHistoryRequestAt)
  );

  if (waitMs > 0) await wait(waitMs);

  const url = new URL(`${API_BASE}/teams/${teamId}/matches`);
  url.searchParams.set("status", "FINISHED");
  url.searchParams.set("limit", "10");

  if (competitionCode) {
    url.searchParams.set("competitions", competitionCode);
  }

  lastHistoryRequestAt = Date.now();

  const response = await fetch(url, {
    headers: { "X-Auth-Token": API_KEY },
    signal: AbortSignal.timeout(20000),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      response.status === 429
        ? "Limite de requêtes football-data.org atteinte. Réessaie plus tard."
        : `Impossible de récupérer l'historique (${response.status}).`
    );
  }

  const matches = (data.matches || []).filter((m) =>
    m.status === "FINISHED" &&
    Number.isFinite(m.score?.fullTime?.home) &&
    Number.isFinite(m.score?.fullTime?.away)
  );

  teamHistoryCache.set(cacheKey, {
    timestamp: Date.now(),
    matches,
  });

  return matches;
}

function teamStats(history, teamId) {
  const games = history
    .filter((m) =>
      m.homeTeam?.id === teamId || m.awayTeam?.id === teamId
    )
    .slice(0, 10);

  let scored = 0;
  let conceded = 0;
  let homeScored = 0;
  let homeConceded = 0;
  let homeCount = 0;
  let awayScored = 0;
  let awayConceded = 0;
  let awayCount = 0;

  for (const match of games) {
    const isHome = match.homeTeam?.id === teamId;
    const gf = isHome
      ? match.score.fullTime.home
      : match.score.fullTime.away;
    const ga = isHome
      ? match.score.fullTime.away
      : match.score.fullTime.home;

    scored += gf;
    conceded += ga;

    if (isHome) {
      homeScored += gf;
      homeConceded += ga;
      homeCount++;
    } else {
      awayScored += gf;
      awayConceded += ga;
      awayCount++;
    }
  }

  const n = games.length;

  return {
    games: n,
    scoredAvg: n ? scored / n : null,
    concededAvg: n ? conceded / n : null,
    homeScoredAvg: homeCount ? homeScored / homeCount : null,
    homeConcededAvg: homeCount ? homeConceded / homeCount : null,
    awayScoredAvg: awayCount ? awayScored / awayCount : null,
    awayConcededAvg: awayCount ? awayConceded / awayCount : null,
  };
}

function poisson(lambda, goals) {
  let p = Math.exp(-lambda);

  for (let i = 1; i <= goals; i++) {
    p *= lambda / i;
  }

  return p;
}

function calculatePrediction(homeStats, awayStats) {
  if (!homeStats.games || !awayStats.games) {
    return {
      available: false,
      message: "Données historiques insuffisantes pour une estimation fiable.",
    };
  }

  // Combine les moyennes générales et les tendances domicile/extérieur.
  const homeAttack =
    homeStats.homeScoredAvg ?? homeStats.scoredAvg;
  const homeDefense =
    homeStats.homeConcededAvg ?? homeStats.concededAvg;
  const awayAttack =
    awayStats.awayScoredAvg ?? awayStats.scoredAvg;
  const awayDefense =
    awayStats.awayConcededAvg ?? awayStats.concededAvg;

  const homeGoals = Math.max(
    0.15,
    Math.min(5, (homeAttack + awayDefense) / 2)
  );

  const awayGoals = Math.max(
    0.15,
    Math.min(5, (awayAttack + homeDefense) / 2)
  );

  const homeP = Array.from(
    { length: 9 },
    (_, g) => poisson(homeGoals, g)
  );

  const awayP = Array.from(
    { length: 9 },
    (_, g) => poisson(awayGoals, g)
  );

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let total = 0;
  let bestScore = { home: 0, away: 0, probability: -1 };

  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const p = homeP[h] * awayP[a];
      total += p;

      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;

      if (p > bestScore.probability) {
        bestScore = { home: h, away: a, probability: p };
      }
    }
  }

  const pct = (value) =>
    Math.round((value / total) * 1000) / 10;

  return {
    available: true,
    method: "Estimation statistique de Poisson",
    estimatedGoals: {
      home: Math.round(homeGoals * 100) / 100,
      away: Math.round(awayGoals * 100) / 100,
    },
    probabilities: {
      homeWin: pct(homeWin),
      draw: pct(draw),
      awayWin: pct(awayWin),
    },
    predictedScore: `${bestScore.home}-${bestScore.away}`,
    historicalMatches: {
      home: homeStats.games,
      away: awayStats.games,
    },
    warning:
      "Estimation mathématique, pas une garantie. Les blessures, compositions et autres facteurs ne sont pas inclus.",
  };
}

app.get("/api/ai-analysis", async (req, res) => {
  const date = String(req.query.date || getToday());

  if (!isValidDate(date)) {
    return res.status(400).json({
      error: "Date invalide. Utilise le format YYYY-MM-DD.",
    });
  }

  if (!API_KEY) {
    return res.status(500).json({
      error: "La clé football-data.org manque dans Render.",
    });
  }

  const cached = freeAnalysisCache.get(date);

  if (cached && Date.now() - cached.timestamp < FREE_CACHE_MS) {
    return res.json({ ...cached.data, cached: true });
  }

  try {
    const url = new URL(`${API_BASE}/matches`);
    url.searchParams.set("date", date);
    url.searchParams.set(
      "competitions",
      DEFAULT_COMPETITIONS.join(",")
    );

    const response = await fetch(url, {
      headers: { "X-Auth-Token": API_KEY },
      signal: AbortSignal.timeout(20000),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(502).json({
        error: "Impossible de récupérer les rencontres.",
        upstreamStatus: response.status,
        details: data.message || null,
      });
    }

    const matches = Array.isArray(data.matches) ? data.matches : [];

    if (matches.length === 0) {
      return res.json({
        date,
        totalMatches: 0,
        results: [],
        analysis: "Aucun match trouvé pour cette date.",
        generatedAt: new Date().toISOString(),
      });
    }

    // Évite de dépasser trop rapidement la limite gratuite.
    const selected = matches.slice(0, 5);
    const results = [];

    for (const match of selected) {
      const homeId = match.homeTeam?.id;
      const awayId = match.awayTeam?.id;
      const competitionCode = match.competition?.code || null;

      const item = {
        match: `${match.homeTeam?.name || "Domicile"} vs ${match.awayTeam?.name || "Extérieur"}`,
        competition: match.competition?.name || "Compétition inconnue",
        date: match.utcDate || null,
        status: match.status || "INCONNU",
      };

      if (!homeId || !awayId) {
        results.push({
          ...item,
          prediction: {
            available: false,
            message: "Identifiants des équipes indisponibles.",
          },
        });
        continue;
      }

      try {
        const homeHistory = await getTeamHistory(homeId, competitionCode);
        const awayHistory = await getTeamHistory(awayId, competitionCode);

        const homeStats = teamStats(homeHistory, homeId);
        const awayStats = teamStats(awayHistory, awayId);

        results.push({
          ...item,
          homeStats,
          awayStats,
          prediction: calculatePrediction(homeStats, awayStats),
        });
      } catch (error) {
        results.push({
          ...item,
          prediction: {
            available: false,
            message: error.message,
          },
        });

        // Ne pas multiplier les requêtes si la limite est atteinte.
        if (error.message.includes("Limite de requêtes")) break;
      }
    }

    const result = {
      date,
      mode: "Gratuit — sans OpenAI",
      totalMatches: matches.length,
      analyzedMatches: results.length,
      note: matches.length > selected.length
        ? "Pour limiter les appels API, seuls les cinq premiers matchs sont traités à chaque génération."
        : "Les estimations utilisent les historiques disponibles.",
      results,
      generatedAt: new Date().toISOString(),
      cached: false,
    };

    freeAnalysisCache.set(date, {
      timestamp: Date.now(),
      data: result,
    });

    return res.json(result);
  } catch (error) {
    console.error("Erreur d'analyse gratuite:", error);

    return res.status(502).json({
      error: "L'analyse statistique n'a pas pu être terminée.",
      details: error.message,
    });
  }
});
