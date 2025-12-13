// index.js
import express from "express";
import axios from "axios";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const env = (k, def = undefined) => process.env[k] ?? def;

const cfg = {
  port: parseInt(env("MCP_PORT", "18080"), 10),

  rootMovies: env("ROOT_MOVIES", "/media/films"),
  rootTv: env("ROOT_TV", "/media/series"),

  radarrUrl: env("RADARR_URL"),
  radarrKey: env("RADARR_API_KEY"),

  sonarrUrl: env("SONARR_URL"),
  sonarrKey: env("SONARR_API_KEY"),

  prowlarrUrl: env("PROWLARR_URL"),
  prowlarrKey: env("PROWLARR_API_KEY"),

  trUrl: env("TRANSMISSION_URL"),
  trUser: env("TRANSMISSION_USER", ""),
  trPass: env("TRANSMISSION_PASS", ""),

  jellyfinUrl: env("JELLYFIN_URL"),
  jellyfinKey: env("JELLYFIN_API_KEY"),
};

// MCP server instance
const server = new McpServer({
  name: "media-mcp",
  version: "1.0.0",
});

/* --------------------------------------------------
   SCHEMAS
   (larges pour debug : ok/data/error)
-------------------------------------------------- */

const debugOutputSchema = z.object({
  ok: z.boolean(),
  data: z.any().optional(),
  error: z.any().optional(),
});

const radarrMovieSchema = z.object({
  title: z.string(),
  year: z.number().nullable(),
  tmdbId: z.number().nullable(),
  titleSlug: z.string().nullable(),
});

const sonarrSeriesSchema = z.object({
  title: z.string(),
  year: z.number().nullable(),
  tvdbId: z.number().nullable(),
  titleSlug: z.string().nullable(),
});

const torrentSchema = z.object({
  id: z.number(),
  name: z.string(),
  percentDone: z.number(),
  status: z.number(),
  rateDownload: z.number().optional().nullable(),
  eta: z.number().optional().nullable(),
});

const jellyfinItemSchema = z.object({
  name: z.string(),
  type: z.string().nullable(),
  dateCreated: z.string().nullable(),
});

/* --------------------------------------------------
   HELPERS
-------------------------------------------------- */

function debugError(toolName, e) {
  const status = e.response?.status;
  const data = e.response?.data;
  const url = e.config?.url;
  const method = e.config?.method;
  const params = e.config?.params;
  const body = e.config?.data;

  const payload = {
    message: e.message || String(e),
    status,
    url,
    method,
    params,
    body,
    responseData: data,
  };

  console.error(`[media-mcp][${toolName}] error:`, payload);

  const text =
    `ERROR in ${toolName}\n` +
    `status: ${status ?? "?"}\n` +
    `url: ${url ?? "-"}\n` +
    `method: ${method ?? "-"}\n` +
    `params: ${params ? JSON.stringify(params) : "-"}\n` +
    `body: ${body ? body : "-"}\n` +
    `response: ${
      typeof data === "string" ? data : JSON.stringify(data, null, 2)
    }`;

  return {
    content: [{ type: "text", text }],
    structuredContent: {
      ok: false,
      error: payload,
    },
  };
}

async function transmissionRequest(body) {
  if (!cfg.trUrl) {
    throw new Error("TRANSMISSION_URL non configuré");
  }

  // Première requête pour obtenir le session-id
  let sessionId = "";
  try {
    const resp = await axios.post(cfg.trUrl, {}, { validateStatus: () => true });
    const hdr = resp.headers["x-transmission-session-id"];
    if (hdr) sessionId = hdr;
  } catch (e) {
    const hdr = e.response?.headers?.["x-transmission-session-id"];
    if (hdr) sessionId = hdr;
  }

  if (!sessionId) {
    throw new Error("Impossible de récupérer X-Transmission-Session-Id");
  }

  const resp = await axios.post(
    cfg.trUrl,
    body,
    {
      headers: { "X-Transmission-Session-Id": sessionId },
      auth: cfg.trUser || cfg.trPass
        ? { username: cfg.trUser, password: cfg.trPass }
        : undefined,
    }
  );

  return resp.data;
}

/* --------------------------------------------------
   TOOLS
-------------------------------------------------- */

// ---- RADARR: SEARCH MOVIE ----
server.registerTool(
  "radarr_search_movie",
  {
    title: "radarr_search_movie",
    description: "Recherche un film par titre dans Radarr",

    inputSchema: z.object({
      title: z.string(),
    }),

    outputSchema: debugOutputSchema,
  },
  async ({ title }) => {
    const tool = "radarr_search_movie";
    try {
      if (!cfg.radarrUrl || !cfg.radarrKey) {
        throw new Error("Radarr n'est pas configuré (RADARR_URL / RADARR_API_KEY)");
      }

      const r = await axios.get(`${cfg.radarrUrl}/movie/lookup`, {
        params: { term: title },
        headers: { "X-Api-Key": cfg.radarrKey },
      });

      const results = r.data.map((m) => ({
        title: m.title,
        year: m.year,
        tmdbId: m.tmdbId,
        titleSlug: m.titleSlug,
      }));

      const payload = {
        ok: true,
        data: {
          results,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (e) {
      return debugError(tool, e);
    }
  }
);

// ---- RADARR: ADD MOVIE ----
server.registerTool(
  "radarr_add_movie",
  {
    title: "radarr_add_movie",
    description:
      "Ajoute un film dans Radarr à partir de son tmdbId. Utilise ROOT_MOVIES pour rootFolderPath.",

    inputSchema: z.object({
      tmdbId: z.number(),
      qualityProfileId: z.number().optional().default(1),
    }),

    outputSchema: debugOutputSchema,
  },
  async ({ tmdbId, qualityProfileId = 1 }) => {
    const tool = "radarr_add_movie";
    try {
      if (!cfg.radarrUrl || !cfg.radarrKey) {
        throw new Error("Radarr n'est pas configuré (RADARR_URL / RADARR_API_KEY)");
      }

      // Lookup TMDB
      const lookup = await axios.get(`${cfg.radarrUrl}/movie/lookup/tmdb`, {
        params: { tmdbId },
        headers: { "X-Api-Key": cfg.radarrKey },
      });

      const m = lookup.data;
      if (!m || !m.titleSlug) {
        throw new Error("Film introuvable dans Radarr pour ce tmdbId");
      }

      const payloadBody = {
        title: m.title,
        qualityProfileId,
        titleSlug: m.titleSlug,
        images: m.images,
        tmdbId: m.tmdbId,
        rootFolderPath: cfg.rootMovies, // on respecte ton .env
        monitored: true,
        addOptions: { searchForMovie: true },
      };

      const res = await axios.post(`${cfg.radarrUrl}/movie`, payloadBody, {
        headers: { "X-Api-Key": cfg.radarrKey },
      });

      const payload = {
        ok: true,
        data: {
          added: res.data.title,
          id: res.data.id,
          rootFolderPathUsed: cfg.rootMovies,
        },
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent: payload,
      };
    } catch (e) {
      return debugError(tool, e);
    }
  }
);

// ---- SONARR: SEARCH SERIES ----
server.registerTool(
  "sonarr_search_series",
  {
    title: "sonarr_search_series",
    description: "Recherche une série par titre dans Sonarr",

    inputSchema: z.object({
      title: z.string(),
    }),

    outputSchema: debugOutputSchema,
  },
  async ({ title }) => {
    const tool = "sonarr_search_series";
    try {
      if (!cfg.sonarrUrl || !cfg.sonarrKey) {
        throw new Error("Sonarr n'est pas configuré (SONARR_URL / SONARR_API_KEY)");
      }

      const r = await axios.get(`${cfg.sonarrUrl}/series/lookup`, {
        params: { term: title },
        headers: { "X-Api-Key": cfg.sonarrKey },
      });

      const results = r.data.map((s) => ({
        title: s.title,
        year: s.year,
        tvdbId: s.tvdbId,
        titleSlug: s.titleSlug,
      }));

      const payload = {
        ok: true,
        data: { results },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (e) {
      return debugError(tool, e);
    }
  }
);

// ---- SONARR: ADD SERIES ----
server.registerTool(
  "sonarr_add_series",
  {
    title: "sonarr_add_series",
    description:
      "Ajoute une série dans Sonarr à partir de son tvdbId. Utilise ROOT_TV comme rootFolderPath.",

    inputSchema: z.object({
      tvdbId: z.number(),
      qualityProfileId: z.number().optional().default(1),
      languageProfileId: z.number().optional().default(1),
    }),

    outputSchema: debugOutputSchema,
  },
  async ({ tvdbId, qualityProfileId = 1, languageProfileId = 1 }) => {
    const tool = "sonarr_add_series";
    try {
      if (!cfg.sonarrUrl || !cfg.sonarrKey) {
        throw new Error("Sonarr n'est pas configuré (SONARR_URL / SONARR_API_KEY)");
      }

      const lookup = await axios.get(`${cfg.sonarrUrl}/series/lookup`, {
        params: { term: `tvdb:${tvdbId}` },
        headers: { "X-Api-Key": cfg.sonarrKey },
      });

      const s = Array.isArray(lookup.data) ? lookup.data[0] : null;
      if (!s) {
        throw new Error("Série introuvable dans Sonarr pour ce tvdbId");
      }

      const payloadBody = {
        title: s.title,
        qualityProfileId,
        languageProfileId,
        titleSlug: s.titleSlug,
        tvdbId: s.tvdbId,
        images: s.images,
        rootFolderPath: cfg.rootTv, // on respecte ton .env
        monitored: true,
        seasonFolder: true,
        addOptions: { searchForMissingEpisodes: true },
      };

      const res = await axios.post(`${cfg.sonarrUrl}/series`, payloadBody, {
        headers: { "X-Api-Key": cfg.sonarrKey },
      });

      const payload = {
        ok: true,
        data: { added: res.data.title, id: res.data.id, rootFolderPathUsed: cfg.rootTv },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (e) {
      return debugError(tool, e);
    }
  }
);

// ---- PROWLARR: SEARCH ----
server.registerTool(
  "prowlarr_search",
  {
    title: "prowlarr_search",
    description:
      "Recherche globale via Prowlarr (q requis, indexerIds optionnels)",

    inputSchema: z.object({
      q: z.string(),
      indexerIds: z.array(z.number()).optional(),
    }),

    outputSchema: debugOutputSchema,
  },
  async ({ q, indexerIds = [] }) => {
    const tool = "prowlarr_search";
    try {
      if (!cfg.prowlarrUrl || !cfg.prowlarrKey) {
        throw new Error("Prowlarr n'est pas configuré (PROWLARR_URL / PROWLARR_API_KEY)");
      }

      const r = await axios.get(`${cfg.prowlarrUrl}/search`, {
        headers: { "X-Api-Key": cfg.prowlarrKey },
        params: {
          query: q,
          indexerIds: indexerIds.length ? indexerIds.join(",") : undefined,
        },
      });

      const results = (Array.isArray(r.data) ? r.data : []).slice(0, 20);

      const payload = {
        ok: true,
        data: { results },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (e) {
      return debugError(tool, e);
    }
  }
);

// ---- TRANSMISSION: LIST ----
server.registerTool(
  "transmission_list",
  {
    title: "transmission_list",
    description: "Liste les torrents (nom, avancement, statut)",

    inputSchema: z.object({}), // pas de params

    outputSchema: debugOutputSchema,
  },
  async () => {
    const tool = "transmission_list";
    try {
      const data = await transmissionRequest({
        method: "torrent-get",
        arguments: {
          fields: ["id", "name", "percentDone", "status", "rateDownload", "eta"],
        },
      });

      const torrents = data?.arguments?.torrents || [];
      const results = torrents.map((t) => ({
        id: t.id,
        name: t.name,
        percentDone: t.percentDone,
        status: t.status,
        rateDownload: t.rateDownload ?? 0,
        eta: t.eta ?? -1,
      }));

      const payload = {
        ok: true,
        data: { results },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (e) {
      return debugError(tool, e);
    }
  }
);

// ---- TRANSMISSION: ADD URL ----
server.registerTool(
  "transmission_add_url",
  {
    title: "transmission_add_url",
    description:
      "Ajoute un torrent à Transmission via une URL magnet ou un .torrent",

    inputSchema: z.object({
      url: z.string(),
    }),

    outputSchema: debugOutputSchema,
  },
  async ({ url }) => {
    const tool = "transmission_add_url";
    try {
      const data = await transmissionRequest({
        method: "torrent-add",
        arguments: { filename: url },
      });

      const payload = {
        ok: true,
        data: { result: data?.result || "ok", raw: data },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (e) {
      return debugError(tool, e);
    }
  }
);

// ---- JELLYFIN: RECENT ----
server.registerTool(
  "jellyfin_recent",
  {
    title: "jellyfin_recent",
    description: "Derniers éléments ajoutés dans Jellyfin",

    inputSchema: z.object({
      limit: z.number().optional().default(10),
    }),

    outputSchema: debugOutputSchema,
  },
  async ({ limit = 10 }) => {
    const tool = "jellyfin_recent";
    try {
      if (!cfg.jellyfinUrl || !cfg.jellyfinKey) {
        throw new Error("Jellyfin n'est pas configuré (JELLYFIN_URL / JELLYFIN_API_KEY)");
      }

      const r = await axios.get(`${cfg.jellyfinUrl}/Items`, {
        params: {
          SortBy: "DateCreated",
          SortOrder: "Descending",
          Limit: limit,
        },
        headers: { "X-Emby-Token": cfg.jellyfinKey },
      });

      const items = r.data?.Items || [];
      const results = items.map((i) => ({
        name: i.Name,
        type: i.Type,
        dateCreated: i.DateCreated,
      }));

      const payload = {
        ok: true,
        data: { results },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (e) {
      return debugError(tool, e);
    }
  }
);

/* --------------------------------------------------
   HTTP MCP ENDPOINT
-------------------------------------------------- */

const app = express();
app.use(express.json());

// MCP HTTP transport entrypoint
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Simple healthcheck
app.get("/health", (_req, res) => res.send("ok"));

app.listen(cfg.port, () => {
  console.log(`[media-mcp] MCP HTTP server listening on :${cfg.port}/mcp`);
});

