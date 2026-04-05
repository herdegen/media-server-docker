# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Vue d'ensemble

Serveur de médiathèque auto-hébergé (`maxibestof.com`). L'ensemble du stack est défini dans `/srv/media-stack/docker-compose.yml`.

## Architecture du stack

### Services Docker (`/srv/media-stack/`)

Tous les services *arr + Transmission ont `network_mode: "service:gluetun"` — ils sortent exclusivement via le VPN Mullvad/WireGuard.

| Conteneur       | Image                                   | Port exposé | Rôle                                      |
|-----------------|-----------------------------------------|-------------|-------------------------------------------|
| `gluetun`       | `qmcgaw/gluetun`                        | gateway     | VPN Mullvad WireGuard, gateway réseau     |
| `flaresolverr`  | `ghcr.io/flaresolverr/flaresolverr`     | 8191        | Bypass Cloudflare (via gluetun)           |
| `prowlarr`      | `lscr.io/linuxserver/prowlarr`          | 9696        | Gestionnaire d'indexeurs (via gluetun)    |
| `sonarr`        | `lscr.io/linuxserver/sonarr`            | 8989        | Gestion séries TV (via gluetun)           |
| `radarr`        | `lscr.io/linuxserver/radarr`            | 7878        | Gestion films (via gluetun)               |
| `transmission`  | `lscr.io/linuxserver/transmission`      | 9091        | Client torrent (via gluetun)              |
| `media-mcp`     | build local `./media-mcp`              | 18080       | Serveur MCP Node.js (pont IA ↔ apps)      |
| `traefik`       | `traefik:v3.1`                          | 80/443      | Reverse proxy + TLS Let's Encrypt         |
| `oauth2-proxy`  | `quay.io/oauth2-proxy/oauth2-proxy`     | 4180        | Auth GitHub OAuth2 sur `auth.maxibestof.com` |
| `tinymediamanager` | `tinymediamanager/tinymediamanager` | —           | Scraping métadonnées médias               |

### Jellyfin (service systemd natif)

Jellyfin tourne **hors Docker** comme service systemd :
```
systemctl status jellyfin
```
Il surveille `/mnt/media/movies` et `/mnt/media/series`.

## Chemins importants

### Stockage média (`/mnt/media/`)

```
/mnt/media/
├── movies/      # Films (~888 GB) — rootFolderPath Radarr
├── series/      # Séries (~369 GB) — rootFolderPath Sonarr
├── music/       # Musique (~193 GB)
├── downloads/   # Torrents en cours (~77 GB)
│   ├── complete/
│   ├── incomplete/
│   ├── tv-sonarr/
│   └── tmm/
├── watch/       # Dossier auto-add Transmission
└── config/
    └── tmm/     # Config TinyMediaManager
```

### Configs des apps *arr (montées dans les conteneurs)

- Radarr   → `/var/lib/radarr`
- Sonarr   → `/var/lib/sonarr`
- Prowlarr → `/var/lib/prowlarr`
- Transmission → `/var/lib/transmission-daemon`
- Gluetun  → `/srv/docker/gluetun`

## Variables d'environnement

Fichier principal : `/srv/media-stack/.env`

Variables clés :
- `PUID=1000` / `PGID=1000` — UID/GID des conteneurs linuxserver
- `TZ=Europe/Paris`
- `VPN_SERVICE_PROVIDER=mullvad` + `VPN_TYPE=wireguard`
- `SERVER_CITIES=Bucharest`
- `MEDIA_MOVIES`, `MEDIA_TV`, `MEDIA_DOWNLOADS`, `MEDIA_WATCH` — chemins montés
- `MCP_DOMAIN=mcp.maxibestof.com`
- `LE_EMAIL` — email Let's Encrypt

Config MCP séparée : `/srv/media-stack/media-mcp/.env`

## Commandes courantes

```bash
# Démarrer / arrêter le stack
cd /srv/media-stack
docker-compose up -d
docker-compose down

# Voir les logs d'un service
docker-compose logs -f radarr
docker-compose logs -f gluetun

# Rebuilder media-mcp après modification de index.js
docker-compose build media-mcp && docker-compose up -d media-mcp

# Redémarrer Jellyfin
systemctl restart jellyfin
journalctl -u jellyfin -f
```

## Service media-mcp (`/srv/media-stack/media-mcp/`)

Serveur MCP HTTP en Node.js (ESM), exposé sur `https://mcp.maxibestof.com/mcp`.

**Stack** : Express + `@modelcontextprotocol/sdk` + axios + zod

**Outils MCP exposés** :
- `radarr_search_movie` — recherche film via Radarr lookup
- `radarr_add_movie` — ajout film par tmdbId
- `sonarr_search_series` — recherche série via Sonarr lookup
- `sonarr_add_series` — ajout série par tvdbId
- `prowlarr_search` — recherche globale via Prowlarr
- `transmission_list` — liste les torrents en cours
- `transmission_add_url` — ajoute un torrent (magnet ou .torrent URL)
- `jellyfin_recent` — derniers éléments ajoutés dans Jellyfin

Toutes les communications internes utilisent `host.docker.internal` pour joindre les ports publiés par gluetun sur l'hôte.

**Point d'entrée HTTP** : `POST /mcp` (MCP Streamable HTTP transport), `GET /health`

## Réseau Traefik

Le réseau Docker `traefik-proxy` est **externe** (créé manuellement) :
```bash
docker network create traefik-proxy
```

Domaines :
- `mcp.maxibestof.com` → media-mcp (port 18080)
- `auth.maxibestof.com` → oauth2-proxy (port 4180)

TLS géré par Let's Encrypt via HTTP challenge sur le port 80.

## Points d'attention

- **Tout le trafic *arr/Transmission passe par Gluetun** : si Gluetun est down, ces services sont inaccessibles même en local.
- Les services *arr (`radarr`, `sonarr`, `prowlarr`) sont aussi installés comme services systemd natifs sur l'hôte (`/opt/Radarr`, `/opt/Sonarr`, `/opt/prowlarr`) mais sont **désactivés** — seule la version Docker tourne.
- `media-mcp` accède aux apps *arr via `host.docker.internal:{port}` (ports publiés par gluetun sur l'hôte).
- Prowlarr et Sonarr/Radarr doivent être configurés manuellement pour se pointer mutuellement (pas dans le docker-compose).
