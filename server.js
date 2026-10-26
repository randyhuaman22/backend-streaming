"use strict";
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const NodeCache = require("node-cache");
const puppeteer = require("puppeteer");
const iptvParser = require("iptv-playlist-parser");

const app = express();
const PORT = 3000, HOST = "0.0.0.0", CACHE_TTL_SECONDS = 60;
const cache = new NodeCache({ stdTTL: CACHE_TTL_SECONDS, checkperiod: 15, useClones: false });

const SPORTS_URLS = [
  "https://futbollibrelive.pe",
  "https://futbollibresgol.pe",
  "https://viperplay.rest"
];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
];

app.use(cors());
app.use(express.json({ limit: "32kb" }));

function validateSourceUrl(value) {
  let parsed;
  try { parsed = new URL(value.startsWith('http') ? value : `https://${value}`); } 
  catch (_) { throw new Error("URL inválida: " + value); }
  return parsed;
}

const http = axios.create({
  timeout: 15000, maxRedirects: 3, responseType: "text",
  headers: { 
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.7", 
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" 
  }
});

http.interceptors.request.use(config => {
  if (config.url.includes("iptv-org") || config.url.includes("themoviedb.org")) return config; 
  const url = new URL(config.url, config.baseURL || "http://localhost");
  validateSourceUrl(url.href);
  config.headers["User-Agent"] = USER_AGENTS[0];
  config.headers.Referer = url.origin + "/";
  return config;
});

function absoluteUrl(value, base) {
  if (!value) return null;
  try { const u = new URL(value, base); return ["http:","https:"].includes(u.protocol) ? u.href : null; } catch (_) { return null; }
}

function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

// ==========================================
// 1. MÓDULO DE DEPORTES
// ==========================================
async function scrapeMatches() {
  for (const sourceUrl of SPORTS_URLS) {
    let browser;
    try {
      const base = validateSourceUrl(sourceUrl).href;
      console.log(`\n--- INTENTANDO EXTRAER DE: ${base} ---`);

      browser = await puppeteer.launch({ 
        headless: "new", 
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
      });
      const page = await browser.newPage();
      
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        if (request.isInterceptResolutionHandled()) return;
        const url = request.url().toLowerCase();
        if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType()) || url.includes('ads')) {
            request.abort().catch(() => {});
        } else {
            request.continue().catch(() => {});
        }
      });

      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(resolve => setTimeout(resolve, 5000));

      const html = await page.content();
      const $ = cheerio.load(html);
      const found = new Map();
      
      $("li, tr, .row, .agenda-item").each((_, element) => {
        const item = $(element);
        const textContent = cleanText(item.text());
        let anchor = item.find("a[href]").first();
        if (anchor.length === 0) anchor = item.find("ul a[href], .dropdown-menu a[href]").first();
        if (anchor.length === 0 && item.is("a[href]")) anchor = item;
        const url = absoluteUrl(anchor.attr("href"), base);
        if (!url || url === base || url.includes("facebook")) return;

        let time = "Hoy";
        const timeMatch = textContent.match(/\b\d{1,2}:\d{2}\b/);
        if (timeMatch) time = timeMatch[0];

        let title = cleanText(item.find(".agenda-title, strong, h3, b").text());
        if (!title) title = textContent.replace(time, '').replace("Ver evento", "").trim();

        if (title.length > 5 && !/publicidad/i.test(title)) found.set(url, { time, title: title.substring(0, 80), url });
      });

      const matches = [...found.values()];
      console.log(`Partidos extraídos: ${matches.length}`);
      if (matches.length > 0) return matches;

    } catch (error) { console.error(`Error en ${sourceUrl}:`, error.message); } 
    finally { if (browser) { try { await browser.close(); } catch (e) {} } }
  }
  return []; 
}

app.get("/api/matches", async (req, res) => {
  const cached = cache.get("matches");
  if (cached) return res.json({ success: true, matches: cached });
  const data = await scrapeMatches(); 
  cache.set("matches", data, CACHE_TTL_SECONDS);
  return res.json({ success: true, matches: data });
});

// ==========================================
// 2. MÓDULO DE TELEVISIÓN PERUANA (.m3u8)
// ==========================================
app.get("/api/channels", async (req, res) => {
  const cachedChannels = cache.get("pe_channels");
  if (cachedChannels) return res.json({ success: true, channels: cachedChannels });

  try {
    console.log("\n--- OBTENIENDO CANALES DE TV PERUANA ---");
    const response = await axios.get("https://iptv-org.github.io/iptv/countries/pe.m3u");
    const playlist = iptvParser.parse(response.data);

    const channels = playlist.items.map(item => ({
      name: item.name,
      logo: item.tvg.logo || null,
      category: item.group.title || "General",
      url: item.url
    }));

    cache.set("pe_channels", channels, 3600); 
    return res.json({ success: true, count: channels.length, channels });
  } catch (error) {
    console.error("Error al cargar canales IPTV:", error.message);
    return res.status(500).json({ success: false, error: "No se pudieron cargar los canales" });
  }
});

// ==========================================
// 3. MÓDULO DE PELÍCULAS (TMDB + Nube Directa)
// ==========================================
const TMDB_API_KEY = "d9214ee47e9097fdcb0732e6b0f338c9"; 
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

// 3.1 Extraer Catálogo Visual de TMDB (En Español)
app.get("/api/movies", async (req, res) => {
  try {
    const url = `${TMDB_BASE_URL}/movie/popular?api_key=${TMDB_API_KEY}&language=es-MX&page=1`;
    const response = await axios.get(url);
    const movies = response.data.results.map(movie => ({
      id: movie.id,
      title: movie.title,
      overview: movie.overview,
      year: movie.release_date ? movie.release_date.substring(0, 4) : "N/A",
      poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
      backdrop: `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}`
    }));
    return res.json({ success: true, count: movies.length, movies });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Error TMDB" });
  }
});

// 3.2 Obtener Stream Directo en la Nube (Multi-servidor sin bloqueos DNS)
app.get("/api/stream/find/:tmdbId", async (req, res) => {
  const tmdbId = req.params.tmdbId;

  try {
    const externalIdsUrl = `${TMDB_BASE_URL}/movie/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
    const idsResponse = await axios.get(externalIdsUrl);
    const imdbId = idsResponse.data.imdb_id;

    console.log(`[Streaming] Generando opciones para TMDB: ${tmdbId} | IMDB: ${imdbId}`);

    const servers = [
      {
        name: "Servidor Principal (VidLink)",
        embed_url: `https://vidlink.pro/movie/${tmdbId}`
      },
      {
        name: "Servidor Secundario (SmashyStream)",
        embed_url: imdbId ? `https://embed.smashystream.com/playere.php?imdb=${imdbId}` : null
      }
    ].filter(s => s.embed_url !== null);

    return res.json({
      success: true,
      tmdb_id: tmdbId,
      servers: servers
    });

  } catch (error) {
    console.error("Error al generar stream:", error.message);
    return res.status(500).json({ success: false, error: "No se pudo generar el enlace de video" });
  }
});

app.listen(PORT, HOST, () => console.log(`backend-streaming activo en http://${HOST}:${PORT}`));