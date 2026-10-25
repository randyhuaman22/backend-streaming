"use strict";
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const NodeCache = require("node-cache");
const puppeteer = require("puppeteer");

const app = express();
const PORT = 3000, HOST = "0.0.0.0", CACHE_TTL_SECONDS = 60;
const cache = new NodeCache({ stdTTL: CACHE_TTL_SECONDS, checkperiod: 15, useClones: false });

const SPORTS_URLS = [
  "https://futbollibrelive.pe",
  "https://futbollibresgol.pe",
  "https://viperplay.rest"
];

const MOVIES_URLS = [
  "https://cuevana3c.pro",
  "https://pelisflix2.rent/nuevas-peliculas/"
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
  timeout: 12000, maxRedirects: 3, responseType: "text",
  headers: { "Accept-Language": "es-ES,es;q=0.9,en;q=0.7", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
});

http.interceptors.request.use(config => {
  const url = new URL(config.url, config.baseURL);
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

// 1. Scraper de Deportes (Puppeteer)
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

// 2. Extractor Dinámico para TODAS las categorías de Cuevana
async function extractCatalog(targetUrl, logMessage) {
  console.log(`\n--- ${logMessage}: ${targetUrl} ---`);
  try {
    const response = await http.get(targetUrl);
    const { data: html, request: { res: { responseUrl: finalUrl } = {} } = {} } = response;
    const $ = cheerio.load(String(html)), found = new Map();
    
    $("article, .movie-item, .film-item, .poster, .item").each((_, element) => {
      const item = $(element), anchor = item.is("a") ? item : item.find("a[href]").first();
      // Ajuste estético implementado aquí:
      const title = cleanText(anchor.attr("title") || item.find("h2, h3, .title, .movie-title").first().text() || anchor.text()).replace(/^(\d{4})(?=[^\s])/g, '$1 ');
      const url = absoluteUrl(anchor.attr("href"), finalUrl || targetUrl);
      const image = item.find("img").first();
      const poster = absoluteUrl(image.attr("data-src") || image.attr("data-lazy-src") || image.attr("src"), finalUrl || targetUrl);
      
      if (!title || !url) return;
      found.set(url, { title, poster, url });
    });

    const results = [...found.values()];
    console.log(`Resultados extraídos: ${results.length}`);
    return results;
  } catch (error) {
    console.error(`Error en ${targetUrl}:`, error.message);
    return [];
  }
}

// Enrutador de Categorías
async function scrapeCategory(path, logMessage) {
  for (const sourceUrl of MOVIES_URLS) {
    const base = validateSourceUrl(sourceUrl).href.replace(/\/$/, '');
    const targetUrl = path ? `${base}/${path}` : base;
    const results = await extractCatalog(targetUrl, logMessage);
    if (results.length > 0) return results;
  }
  return [];
}

async function searchMovies(query) {
  for (const sourceUrl of MOVIES_URLS) {
    const base = validateSourceUrl(sourceUrl).href.replace(/\/$/, '');
    const searchUrl = `${base}/?s=${encodeURIComponent(query)}`;
    const results = await extractCatalog(searchUrl, `BUSCANDO "${query}" EN TODA LA BASE DE DATOS`);
    if (results.length > 0) return results;
  }
  return [];
}

function findDirectHls(html) {
  const matches = html.match(/https?:\/\/[^"'\s<>\\]+?\.m3u8(?:\?[^"'\s<>\\]*)?/gi) || [];
  return matches.find(url => { try { validateSourceUrl(url); return true; } catch (_) { return false; } }) || null;
}

async function extractStream(startUrl) {
  let current = validateSourceUrl(startUrl).href, firstIframe = null;
  for (let depth = 0; depth <= 2; depth++) {
    const response = await http.get(current);
    const html = String(response.data);
    const finalUrl = response.request?.res?.responseUrl || current;
    
    const hls = findDirectHls(html);
    if (hls) return { streamUrl: hls, type: "hls" };
    
    const $ = cheerio.load(html);
    const iframe = $("iframe[src]").toArray().map(node => absoluteUrl($(node).attr("src"), finalUrl)).find(candidate => {
      if (!candidate) return false;
      try { validateSourceUrl(candidate); return true; } catch (_) { return false; }
    });
    if (!iframe) break;
    if (!firstIframe) firstIframe = iframe;
    current = iframe;
  }
  return firstIframe ? { streamUrl: firstIframe, type: "iframe" } : null;
}

// --- ENDPOINTS PARA LA INTERFAZ DE LA SMART TV ---

app.get("/api/matches", async (req, res) => {
  const cached = cache.get("matches");
  if (cached) return res.json({ success: true, matches: cached });
  const data = await scrapeMatches(); 
  cache.set("matches", data, CACHE_TTL_SECONDS);
  return res.json({ success: true, matches: data });
});

//Endpoints mapeados exactos al menú de Cuevana
app.get("/api/movies", async (req, res) => {
  const data = await scrapeCategory("peliculas", "EXTRAYENDO PELÍCULAS");
  return res.json({ success: true, data });
});
app.get("/api/movies/featured", async (req, res) => {
  const data = await scrapeCategory("peliculas-destacadas", "EXTRAYENDO PELÍCULAS DESTACADAS");
  return res.json({ success: true, data });
});
app.get("/api/series", async (req, res) => {
  const data = await scrapeCategory("series", "EXTRAYENDO SERIES");
  return res.json({ success: true, data });
});
app.get("/api/episodes", async (req, res) => {
  const data = await scrapeCategory("episodios", "EXTRAYENDO EPISODIOS RECIENTES");
  return res.json({ success: true, data });
});

app.get("/api/search", async (req, res) => {
  if (!req.query.q) return res.status(400).json({ success: false, error: "Falta término de búsqueda" });
  const data = await searchMovies(req.query.q);
  return res.json({ success: true, data });
});

app.get("/api/stream", async (req, res) => {
  if (!req.query.url) return res.status(400).json({ success: false, error: "Falta url" });
  const result = await extractStream(req.query.url);
  if (!result) return res.status(200).json({ success: false, error: "Video no válido" });
  return res.json({ success: true, ...result });
});

app.listen(PORT, HOST, () => console.log(`backend-streaming activo en http://${HOST}:${PORT}`));