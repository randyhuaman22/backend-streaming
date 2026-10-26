"use strict";
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache");
const iptvParser = require("iptv-playlist-parser");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const cache = new NodeCache({ stdTTL: 43200, checkperiod: 120, useClones: false }); 

app.use(cors());
app.use(express.json());

const TV_LISTS = [
  "https://iptv-org.github.io/iptv/countries/pe.m3u"
];

// Diccionario para traducir categorías al español
const categoryMap = {
  "News": "Noticias",
  "Sports": "Deportes",
  "Kids": "Infantil",
  "Movies": "Películas",
  "Documentary": "Cultura",
  "Music": "Música",
  "Entertainment": "Entretenimiento",
  "General": "General"
};

app.get("/api/channels", async (req, res) => {
  const cachedChannels = cache.get("tv_channels");
  if (cachedChannels) return res.json({ success: true, count: cachedChannels.length, channels: cachedChannels });

  try {
    console.log("--- OBTENIENDO LISTA DE CANALES ---");
    const response = await axios.get(TV_LISTS[0], { timeout: 10000 });
    const playlist = iptvParser.parse(response.data);

    const channels = playlist.items.map(item => {
      const rawCategory = item.group.title || "General";
      return {
        id: Buffer.from(item.url).toString('base64'),
        name: item.name,
        logo: item.tvg.logo || null,
        category: categoryMap[rawCategory] || rawCategory,
        url: item.url
      };
    });

    cache.set("tv_channels", channels); 
    return res.json({ success: true, count: channels.length, channels });
  } catch (error) {
    console.error("Error al cargar canales:", error.message);
    return res.status(500).json({ success: false, error: "No se pudieron cargar los canales" });
  }
});

app.listen(PORT, HOST, () => console.log(`Vyro TV Backend activo en http://${HOST}:${PORT}`));