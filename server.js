
const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    name: "FOOTBALL-PREDICTOR-PROX",
    apiKeyConfigured: Boolean(process.env.APIFOOTBALL_KEY),
    message: "Serveur démarré"
  });
});

app.get("/api/fixtures/today", async (req, res) => {
  const apiKey = process.env.APIFOOTBALL_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "Clé API-Football non configurée sur le serveur."
    });
  }

  try {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.TIMEZONE || "Africa/Abidjan",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());

    const response = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${date}`,
      {
        headers: { "x-apisports-key": apiKey },
        signal: AbortSignal.timeout(15000)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "API-Football a refusé la requête."
      });
    }

    res.json({
      date,
      fixtures: data.response || [],
      results: (data.response || []).length
    });
  } catch (error) {
    res.status(502).json({
      error: "Impossible de récupérer les matchs.",
      details: error.name === "TimeoutError" ? "Délai dépassé" : "Erreur réseau"
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Football Predictor Pro démarré sur le port ${PORT}`);
});
