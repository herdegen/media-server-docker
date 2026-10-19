// index.js
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import express from "express";
import axios from "axios";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const env = (k, def = undefined) => process.env[k] ?? def;

const cfg = {
  port: parseInt(env("MCP_PORT", "18080"), 10),
  token: env("MCP_TOKEN", ""),

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

/* --------------------------------------------------
   FAIL CLOSED : pas de token => pas de serveur
-------------------------------------------------- */

if (!cfg.token) {
  console.error("[media-mcp] FATAL: MCP_TOKEN non défini — refus de démarrer (fail closed).");
  process.exit(1);
}
if (cfg.token.length < 32) {
  console.warn("[media-mcp] WARN: MCP_TOKEN court (< 32 caractères) — utiliser `openssl rand -hex 32`.");
}

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest();
const TOKEN_HASH = sha256(cfg.token);

// Comparaison en temps constant (hash sha256 des deux côtés => même longueur)
function tokenMatches(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  return crypto.timingSafeEqual(sha256(candidate), TOKEN_HASH);
}

process.on("unhandledRejection", (reason) => {
  console.error("[media-mcp] unhandledRejection:", reason instanceof Error ? reason.message : reason);
});

/* --------------------------------------------------
   HTTP client partagé (timeout 15 s)
-------------------------------------------------- */

const http = axios.create({ timeout: 15000 });

/* --------------------------------------------------
   SCHEMAS
-------------------------------------------------- */

const outputSchema = z.object({
  ok: z.boolean(),
  data: z.any().optional(),
  error: z.any().optional(),
});

/* --------------------------------------------------
   HELPERS
-------------------------------------------------- */

const ok = (data) => {
  const payload = { ok: true, data };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
};

// Erreur côté client : uniquement message + status. Détails => logs serveur (sans clés).
function toolError(toolName, e) {
  const status = e?.response?.status;
  let message;
  if (e?.isAxiosError) {
    message = status
      ? `Le service distant a répondu HTTP ${status}`
      : `Service distant injoignable (${e.code || "erreur réseau"})`;
  } else {
    message = e?.message || String(e);
  }

  let respData = e?.response?.data;
  if (respData !== undefined && typeof respData !== "string") {
    try { respData = JSON.stringify(respData); } catch { respData = "[unserializable]"; }
  }
  console.error(`[media-mcp][${toolName}] error:`, {
    message: e?.message || String(e),
    code: e?.code,
    status,
    method: e?.config?.method,
    url: e?.config?.url, // pas de clé dans l'URL (clés en header)
    response: typeof respData === "string" ? respData.slice(0, 500) : undefined,
  });

  const error = { message, status: status ?? null };
  return {
    isError: true,
    content: [{ type: "text", text: `Erreur ${toolName}: ${message}${status ? ` (HTTP ${status})` : ""}` }],
    structuredContent: { ok: false, error },
  };
}

function requireArr(name, url, key) {
  if (!url || !key) throw new Error(`${name} n'est pas configuré`);
}

async function transmissionRequest(body) {
  if (!cfg.trUrl) throw new Error("Transmission n'est pas configuré");

  const auth = cfg.trUser || cfg.trPass ? { username: cfg.trUser, password: cfg.trPass } : undefined;

  // Première requête pour obtenir le session-id (409 attendu)
  const first = await http.post(cfg.trUrl, {}, { auth, validateStatus: () => true });
  const sessionId = first.headers["x-transmission-session-id"];
  if (!sessionId) throw new Error("Impossible de récupérer X-Transmission-Session-Id");

  const resp = await http.post(cfg.trUrl, body, {
    headers: { "X-Transmission-Session-Id": sessionId },
    auth,
  });
  return resp.data;
}

/* ---------- Validation URL torrent (anti-SSRF) ---------- */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||   // CGNAT
      (a === 169 && b === 254) ||             // link-local
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224                                 // multicast / réservé
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    // IPv4-mapped (::ffff:1.2.3.4 ou forme hex ::ffff:102:304 produite par new URL())
    const dotted = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    // ::, ::1, IPv4-compatible (::x), NAT64 (64:ff9b::), ULA, link-local, multicast
    return v.startsWith("::") || v.startsWith("64:ff9b:") || /^(fc|fd|fe[89ab]|ff)/.test(v);
  }
  return true; // inconnu => refusé
}

async function assertSafeTorrentUrl(raw) {
  const s = String(raw).trim();
  if (/^magnet:\?/i.test(s)) {
    if (!/[?&]xt=urn:bt[im]h:/i.test(s)) throw new Error("Lien magnet invalide (xt=urn:btih manquant)");
    return s;
  }
  let u;
  try { u = new URL(s); } catch { throw new Error("URL invalide"); }
  if (u.protocol !== "https:") throw new Error("Seuls magnet: et https://….torrent sont acceptés");
  if (u.username || u.password) throw new Error("URL avec identifiants refusée");
  if (!/\.torrent$/i.test(u.pathname)) throw new Error("L'URL doit pointer vers un fichier .torrent");
  if (u.port && u.port !== "443") throw new Error("Port non standard refusé");

  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Adresse IP privée/locale refusée");
  } else {
    if (!host.includes(".") || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host)) {
      throw new Error("Nom d'hôte local refusé");
    }
    let addrs;
    try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error("Nom d'hôte introuvable"); }
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
      throw new Error("Le nom d'hôte résout vers une adresse privée/locale");
    }
  }
  return u.toString();
}

/* ---------- Défauts Radarr/Sonarr (root folder + profil qualité) ---------- */

// Profils jamais choisis par défaut :
//  - "Any" (prend n'importe quoi)
//  - VOSTFR : rejette les doublages VF (l'utilisateur préfère la VF ; Sonarr id 7 explicitement exclu)
const isExcludedProfile = (app, p) =>
  /^any$/i.test(p.name.trim()) || /vostfr/i.test(p.name) || (app === "sonarr" && p.id === 7);

const DEFAULTS_TTL_MS = 10 * 60 * 1000;
const defaultsCache = { radarr: null, sonarr: null };
const defaultsFailedAt = { radarr: 0, sonarr: 0 }; // backoff 60 s si le service est injoignable

async function fetchArrDefaults(app) {
  const url = app === "radarr" ? cfg.radarrUrl : cfg.sonarrUrl;
  const key = app === "radarr" ? cfg.radarrKey : cfg.sonarrKey;
  requireArr(app === "radarr" ? "Radarr" : "Sonarr", url, key);
  const headers = { "X-Api-Key": key };
  const itemsEp = app === "radarr" ? "movie" : "series";

  const [roots, profiles, items] = await Promise.all([
    http.get(`${url}/rootfolder`, { headers }),
    http.get(`${url}/qualityprofile`, { headers }),
    http.get(`${url}/${itemsEp}`, { headers }),
  ]);

  const root = (roots.data || []).find((r) => r.accessible !== false) || (roots.data || [])[0];

  const counts = new Map();
  for (const it of items.data || []) counts.set(it.qualityProfileId, (counts.get(it.qualityProfileId) || 0) + 1);

  const candidates = (profiles.data || [])
    .filter((p) => !isExcludedProfile(app, p))
    .map((p) => ({ id: p.id, name: p.name, count: counts.get(p.id) || 0 }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count || a.id - b.id);

  let profile = candidates[0] || null;
  if (!profile) {
    const p1080 = (profiles.data || []).find((p) => /^hd-1080p$/i.test(p.name));
    profile = p1080 ? { id: p1080.id, name: p1080.name, count: 0 } : null;
  }

  return {
    rootFolderPath: root?.path || null,
    qualityProfile: profile ? { id: profile.id, name: profile.name } : null,
    profiles: (profiles.data || []).map((p) => ({ id: p.id, name: p.name })),
    fetchedAt: Date.now(),
  };
}

async function getArrDefaults(app, { force = false } = {}) {
  const c = defaultsCache[app];
  if (!force && c && Date.now() - c.fetchedAt < DEFAULTS_TTL_MS) return c;
  if (!force && Date.now() - defaultsFailedAt[app] < 60000) return c;
  try {
    defaultsCache[app] = await fetchArrDefaults(app);
  } catch (e) {
    defaultsFailedAt[app] = Date.now();
    console.error(`[media-mcp] défauts ${app} indisponibles:`, e?.message);
    if (!c) return null;
  }
  return defaultsCache[app];
}

function describeDefaults(d) {
  if (!d) return "Profil qualité par défaut : non déterminé (service injoignable) — fournir qualityProfileId.";
  const prof = d.qualityProfile
    ? `Profil qualité par défaut : ${d.qualityProfile.id} « ${d.qualityProfile.name} » (le plus utilisé de la bibliothèque, hors Any/VOSTFR).`
    : "Aucun profil par défaut — qualityProfileId obligatoire.";
  const list = d.profiles.map((p) => `${p.id}=${p.name}`).join(", ");
  return `${prof} Root folder : ${d.rootFolderPath ?? "?"}. Profils disponibles : ${list}.`;
}

/* --------------------------------------------------
   MCP SERVER FACTORY (une instance par requête)
-------------------------------------------------- */

function buildServer({ radarrDefaults, sonarrDefaults }) {
  const server = new McpServer({ name: "media-mcp", version: "1.1.0" });

  // ---- RADARR: SEARCH MOVIE ----
  server.registerTool(
    "radarr_search_movie",
    {
      title: "radarr_search_movie",
      description: "Recherche un film par titre dans Radarr",
      inputSchema: z.object({ title: z.string().min(1).max(200) }),
      outputSchema,
    },
    async ({ title }) => {
      try {
        requireArr("Radarr", cfg.radarrUrl, cfg.radarrKey);
        const r = await http.get(`${cfg.radarrUrl}/movie/lookup`, {
          params: { term: title },
          headers: { "X-Api-Key": cfg.radarrKey },
        });
        const results = (r.data || []).map((m) => ({
          title: m.title, year: m.year, tmdbId: m.tmdbId, titleSlug: m.titleSlug,
        }));
        return ok({ results });
      } catch (e) {
        return toolError("radarr_search_movie", e);
      }
    }
  );

  // ---- RADARR: ADD MOVIE ----
  server.registerTool(
    "radarr_add_movie",
    {
      title: "radarr_add_movie",
      description:
        "Ajoute un film dans Radarr à partir de son tmdbId (root folder lu dans Radarr). " +
        describeDefaults(radarrDefaults),
      inputSchema: z.object({
        tmdbId: z.number().int().positive(),
        qualityProfileId: z.number().int().positive().optional(),
      }),
      outputSchema,
    },
    async ({ tmdbId, qualityProfileId }) => {
      try {
        requireArr("Radarr", cfg.radarrUrl, cfg.radarrKey);
        const d = await getArrDefaults("radarr");
        if (!d?.rootFolderPath) throw new Error("Aucun root folder Radarr disponible");
        const profileId = qualityProfileId ?? d.qualityProfile?.id;
        if (!profileId) throw new Error("qualityProfileId requis (aucun profil par défaut)");

        const lookup = await http.get(`${cfg.radarrUrl}/movie/lookup/tmdb`, {
          params: { tmdbId },
          headers: { "X-Api-Key": cfg.radarrKey },
        });
        const m = lookup.data;
        if (!m || !m.titleSlug) throw new Error("Film introuvable dans Radarr pour ce tmdbId");

        const res = await http.post(
          `${cfg.radarrUrl}/movie`,
          {
            title: m.title,
            qualityProfileId: profileId,
            titleSlug: m.titleSlug,
            images: m.images,
            tmdbId: m.tmdbId,
            year: m.year,
            rootFolderPath: d.rootFolderPath,
            monitored: true,
            addOptions: { searchForMovie: true },
          },
          { headers: { "X-Api-Key": cfg.radarrKey } }
        );

        return ok({
          added: res.data.title,
          id: res.data.id,
          path: res.data.path,
          qualityProfileId: profileId,
          rootFolderPathUsed: d.rootFolderPath,
        });
      } catch (e) {
        return toolError("radarr_add_movie", e);
      }
    }
  );

  // ---- SONARR: SEARCH SERIES ----
  server.registerTool(
    "sonarr_search_series",
    {
      title: "sonarr_search_series",
      description: "Recherche une série par titre dans Sonarr",
      inputSchema: z.object({ title: z.string().min(1).max(200) }),
      outputSchema,
    },
    async ({ title }) => {
      try {
        requireArr("Sonarr", cfg.sonarrUrl, cfg.sonarrKey);
        const r = await http.get(`${cfg.sonarrUrl}/series/lookup`, {
          params: { term: title },
          headers: { "X-Api-Key": cfg.sonarrKey },
        });
        const results = (r.data || []).map((s) => ({
          title: s.title, year: s.year, tvdbId: s.tvdbId, titleSlug: s.titleSlug,
        }));
        return ok({ results });
      } catch (e) {
        return toolError("sonarr_search_series", e);
      }
    }
  );

  // ---- SONARR: ADD SERIES ----
  server.registerTool(
    "sonarr_add_series",
    {
      title: "sonarr_add_series",
      description:
        "Ajoute une série dans Sonarr à partir de son tvdbId (root folder lu dans Sonarr). " +
        "Ne jamais utiliser le profil VOSTFR (id 7) pour une demande en VF. " +
        describeDefaults(sonarrDefaults),
      inputSchema: z.object({
        tvdbId: z.number().int().positive(),
        qualityProfileId: z.number().int().positive().optional(),
      }),
      outputSchema,
    },
    async ({ tvdbId, qualityProfileId }) => {
      try {
        requireArr("Sonarr", cfg.sonarrUrl, cfg.sonarrKey);
        const d = await getArrDefaults("sonarr");
        if (!d?.rootFolderPath) throw new Error("Aucun root folder Sonarr disponible");
        const profileId = qualityProfileId ?? d.qualityProfile?.id;
        if (!profileId) throw new Error("qualityProfileId requis (aucun profil par défaut)");

        const lookup = await http.get(`${cfg.sonarrUrl}/series/lookup`, {
          params: { term: `tvdb:${tvdbId}` },
          headers: { "X-Api-Key": cfg.sonarrKey },
        });
        const s = Array.isArray(lookup.data) ? lookup.data[0] : null;
        if (!s) throw new Error("Série introuvable dans Sonarr pour ce tvdbId");

        const res = await http.post(
          `${cfg.sonarrUrl}/series`,
          {
            title: s.title,
            qualityProfileId: profileId,
            titleSlug: s.titleSlug,
            tvdbId: s.tvdbId,
            images: s.images,
            rootFolderPath: d.rootFolderPath,
            monitored: true,
            seasonFolder: true,
            addOptions: { searchForMissingEpisodes: true },
          },
          { headers: { "X-Api-Key": cfg.sonarrKey } }
        );

        return ok({
          added: res.data.title,
          id: res.data.id,
          path: res.data.path, // à vérifier (cf. chemins morts Sonarr)
          qualityProfileId: profileId,
          rootFolderPathUsed: d.rootFolderPath,
        });
      } catch (e) {
        return toolError("sonarr_add_series", e);
      }
    }
  );

  // ---- PROWLARR: SEARCH ----
  server.registerTool(
    "prowlarr_search",
    {
      title: "prowlarr_search",
      description: "Recherche globale via Prowlarr (q requis, indexerIds optionnels)",
      inputSchema: z.object({
        q: z.string().min(1).max(200),
        indexerIds: z.array(z.number().int()).optional(),
      }),
      outputSchema,
    },
    async ({ q, indexerIds = [] }) => {
      try {
        requireArr("Prowlarr", cfg.prowlarrUrl, cfg.prowlarrKey);
        const r = await http.get(`${cfg.prowlarrUrl}/search`, {
          headers: { "X-Api-Key": cfg.prowlarrKey },
          params: { query: q, indexerIds: indexerIds.length ? indexerIds.join(",") : undefined },
        });
        const results = (Array.isArray(r.data) ? r.data : []).slice(0, 20);
        return ok({ results });
      } catch (e) {
        return toolError("prowlarr_search", e);
      }
    }
  );

  // ---- TRANSMISSION: LIST ----
  server.registerTool(
    "transmission_list",
    {
      title: "transmission_list",
      description: "Liste les torrents (nom, avancement, statut)",
      inputSchema: z.object({}),
      outputSchema,
    },
    async () => {
      try {
        const data = await transmissionRequest({
          method: "torrent-get",
          arguments: { fields: ["id", "name", "percentDone", "status", "rateDownload", "eta"] },
        });
        const results = (data?.arguments?.torrents || []).map((t) => ({
          id: t.id,
          name: t.name,
          percentDone: t.percentDone,
          status: t.status,
          rateDownload: t.rateDownload ?? 0,
          eta: t.eta ?? -1,
        }));
        return ok({ results });
      } catch (e) {
        return toolError("transmission_list", e);
      }
    }
  );

  // ---- TRANSMISSION: ADD URL ----
  server.registerTool(
    "transmission_add_url",
    {
      title: "transmission_add_url",
      description:
        "Ajoute un torrent à Transmission. N'accepte que magnet:?xt=urn:btih:… ou https://….torrent (hôte public).",
      inputSchema: z.object({ url: z.string().min(1).max(4096) }),
      outputSchema,
    },
    async ({ url }) => {
      try {
        const safe = await assertSafeTorrentUrl(url);
        const data = await transmissionRequest({ method: "torrent-add", arguments: { filename: safe } });
        return ok({ result: data?.result || "ok" });
      } catch (e) {
        return toolError("transmission_add_url", e);
      }
    }
  );

  // ---- JELLYFIN: RECENT ----
  server.registerTool(
    "jellyfin_recent",
    {
      title: "jellyfin_recent",
      description: "Derniers éléments ajoutés dans Jellyfin",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional().default(10) }),
      outputSchema,
    },
    async ({ limit = 10 }) => {
      try {
        if (!cfg.jellyfinUrl || !cfg.jellyfinKey) throw new Error("Jellyfin n'est pas configuré");
        const r = await http.get(`${cfg.jellyfinUrl}/Items`, {
          params: { SortBy: "DateCreated", SortOrder: "Descending", Limit: limit },
          headers: { Authorization: `MediaBrowser Token="${cfg.jellyfinKey}"` }, // Jellyfin 12 : auth legacy désactivée
        });
        const results = (r.data?.Items || []).map((i) => ({
          name: i.Name, type: i.Type, dateCreated: i.DateCreated,
        }));
        return ok({ results });
      } catch (e) {
        return toolError("jellyfin_recent", e);
      }
    }
  );

  return server;
}

/* --------------------------------------------------
   HTTP
-------------------------------------------------- */

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);

// Log d'accès minimal — le chemin secret est TOUJOURS masqué, jamais de headers d'auth.
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    if (req.path === "/health") return;
    const path = req.path.startsWith("/mcp/") ? "/mcp/***" : req.path.slice(0, 64);
    const ua = String(req.get("user-agent") || "-").slice(0, 120);
    console.log(`[media-mcp] ${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms ua="${ua}"`);
  });
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const unauthorized = (res) => res.status(401).json({ error: "unauthorized" });

function bearerAuth(req, res, next) {
  const h = req.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m && tokenMatches(m[1].trim())) return next();
  return unauthorized(res);
}

function pathAuth(req, res, next) {
  if (tokenMatches(req.params.token)) return next();
  return unauthorized(res);
}

async function handleMcp(req, res) {
  let server;
  let transport;
  try {
    const [radarrDefaults, sonarrDefaults] = await Promise.all([
      getArrDefaults("radarr"),
      getArrDefaults("sonarr"),
    ]);
    server = buildServer({ radarrDefaults, sonarrDefaults });
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[media-mcp] erreur handler /mcp:", e?.message || e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
}

function methodNotAllowed(_req, res) {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null,
  });
}

const jsonBody = express.json({ limit: "1mb" });

// Auth AVANT le parsing du corps
app.post("/mcp", bearerAuth, jsonBody, handleMcp);
app.all("/mcp", bearerAuth, methodNotAllowed);
app.post("/mcp/:token", pathAuth, jsonBody, handleMcp);
app.all("/mcp/:token", pathAuth, methodNotAllowed);

app.use((_req, res) => res.status(404).json({ error: "not found" }));

// Gestionnaire d'erreurs générique (JSON invalide, corps trop gros…) : pas de stack ni d'URL
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err?.status || err?.statusCode || 500;
  if (status >= 500) console.error("[media-mcp] erreur express:", err?.message || err);
  if (res.headersSent) return;
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: status < 500 ? "bad request" : "internal error" });
});

app.listen(cfg.port, () => {
  console.log(`[media-mcp] MCP HTTP server listening on :${cfg.port} (auth: Bearer ou chemin secret)`);
});
