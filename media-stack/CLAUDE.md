# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Vue d'ensemble

Serveur de médiathèque auto-hébergé (`maxibestof.com`). L'ensemble du stack est défini dans `/srv/media-stack/docker-compose.yml`.

## Architecture du stack

### Services Docker (`/srv/media-stack/`)

Tous les services *arr + Transmission ont `network_mode: "service:gluetun"` — ils sortent exclusivement via le VPN (**NordVPN/NordLynx** depuis le 2026-06-13, bascule Mullvad possible, cf. section *Bascule VPN*).

| Conteneur       | Image                                   | Port exposé | Rôle                                      |
|-----------------|-----------------------------------------|-------------|-------------------------------------------|
| `gluetun`       | `qmcgaw/gluetun`                        | gateway     | VPN (NordVPN/NordLynx), gateway réseau + control server `172.17.0.1:8000` |
| `flaresolverr`  | `ghcr.io/flaresolverr/flaresolverr`     | 8191        | Bypass Cloudflare (via gluetun)           |
| `prowlarr`      | `lscr.io/linuxserver/prowlarr`          | 9696        | Gestionnaire d'indexeurs (via gluetun)    |
| `sonarr`        | `lscr.io/linuxserver/sonarr`            | 8989        | Gestion séries TV (via gluetun)           |
| `radarr`        | `lscr.io/linuxserver/radarr`            | 7878        | Gestion films (via gluetun)               |
| `transmission`  | `lscr.io/linuxserver/transmission`      | 9091        | Client torrent (via gluetun)              |
| `media-mcp`     | build local `./media-mcp`              | 18080       | Serveur MCP Node.js (pont IA ↔ apps)      |
| `traefik`       | `traefik:v3`                            | 80/443      | Reverse proxy + TLS Let's Encrypt         |
| `oauth2-proxy`  | `quay.io/oauth2-proxy/oauth2-proxy`     | 4180        | Auth GitHub OAuth2 (`auth.maxibestof.com`, middleware `oauth-auth@docker`) |
| `homepage`      | `ghcr.io/gethomepage/homepage`          | 3000        | Dashboard `home.maxibestof.com` (derrière OAuth) |
| `vpn-control`   | build local `./vpn-control`             | 8080        | Panneau `/vpn` du dashboard (pilote la bascule VPN) |
| `glances`       | `nicolargo/glances`                     | 61208       | Métriques système (network_mode host)     |
| `bazarr`        | `lscr.io/linuxserver/bazarr`            | 6767        | Sous-titres (`bazarr.maxibestof.com`, OAuth) |
| `jellyseerr`    | `ghcr.io/seerr-team/seerr`              | 5055        | Demandes (`jellyseerr.maxibestof.com`, auth Jellyfin native, PAS d'OAuth) |

> Hors compose mais présents : **recyclarr** (`docker run` via `recyclarr-sync.timer`, config `recyclarr/`, sync TRaSH → Radarr/Sonarr chaque nuit) et **tinymediamanager** (conteneur autonome piloté par `tmm-start.timer`/`tmm-stop.timer`, fenêtre 02h–08h UTC).
>
> ⚠️ `tinymediamanager` ne fait plus partie du `docker-compose.yml`. Les ports des *arr (7878/8989/9696/9091 + control server gluetun 8000) sont publiés par **gluetun bindés sur `172.17.0.1`** (durci 2026-06-16) → accessibles aux autres conteneurs (Homepage) et à l'hôte, mais **PAS depuis Internet**. Accès navigateur via Traefik + OAuth. FlareSolverr (8191) n'est pas publié sur l'hôte (interne au réseau gluetun).

### Jellyfin (service systemd natif)

Jellyfin tourne **hors Docker** comme service systemd (paquets `repo.jellyfin.org`, **12.0** depuis le 2026-09-11) :
```
systemctl status jellyfin
```
Il surveille `/mnt/media/movies`, `/mnt/media/series` et `/mnt/media/music`. Exposé en HTTPS via Traefik (`traefik/dynamic/jellyfin.yml`, sans OAuth, rate-limit sur le login).

**Jellyfin 12 — points clés :**
- .NET 10, `jellyfin-ffmpeg8` (8.1.x). Les plugins compilés pour 10.11 ne chargent pas : il faut des builds `targetAbi 12.0.0.0`.
- **Auth legacy désactivée** (`X-Emby-Token`, `X-MediaBrowser-Token`, `api_key=`, routes `/emby/`, `/mediabrowser/`). Utiliser `Authorization: MediaBrowser Token="..."`.
- Migration de base irréversible au 1er démarrage → backup complet pris avant : `/var/backups/jellyfin/jellyfin-pre12-*.tar.gz` (à supprimer une fois la 12 validée).
- Plugins 10.11 conservés hors chargement dans `/var/lib/jellyfin/plugins-disabled-pre12/` (supprimables).

**Plugins installés** (`/var/lib/jellyfin/plugins/`) : Glacier 1.1.0.0 (maison), JavaScript Injector 4.0.0.0 (repo `n00bcodr/.../12/manifest.json`), File Transformation 3.0.0.0, Open Subtitles 25.0.0.0 + plugins officiels (TMDb, OMDb, MusicBrainz, AudioDB, Studio Images, ListenBrainz).

**Plugin Glacier** (archivage films → Scaleway Glacier) : sources et repo git dans `/opt/jellyfin-glacier-plugin` (README = build + install ; `dotnet build -c Release -p:JellyfinBin=...`). Le bouton web est injecté par `glacier-inject.v2.js` via JavaScript Injector. Base des items : `/var/lib/jellyfin/data/glacier_items.json`. Vérif rapide : `GET /Glacier/items` (avec un token) et tâche planifiée « Glacier - Vérifier les restaurations en cours ».

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
- `MEDIA_MOVIES`, `MEDIA_TV`, `MEDIA_DOWNLOADS`, `MEDIA_WATCH` — chemins montés
- `MCP_DOMAIN=mcp.maxibestof.com`
- `LE_EMAIL` — email Let's Encrypt

> Les variables VPN **ne sont plus** dans `.env` ni dans le bloc `environment` de gluetun : elles vivent dans les presets `vpn/{nordvpn,mullvad}.env`, et gluetun lit `vpn/active.env` via `env_file`. Voir *Bascule VPN*.

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
- `home.maxibestof.com` → homepage (dashboard, protégé OAuth) ; sous-chemin `/vpn` → vpn-control

TLS géré par Let's Encrypt via HTTP challenge sur le port 80.

## Bascule VPN

gluetun est piloté par presets (cf. CHANGELOG 2026-06-13) :

```bash
cd /srv/media-stack
./vpn-switch.sh status        # provider + IP actuels
./vpn-switch.sh nordvpn       # bascule NordVPN (actif par défaut)
./vpn-switch.sh mullvad       # bascule Mullvad (⚠️ abonnement à renouveler)
```

- Presets : `vpn/{nordvpn,mullvad}.env` (chmod 600). Preset courant copié dans `vpn/active.env`.
- Clé NordLynx (re)générable via token NordVPN :
  `curl -s -u "token:TOKEN" https://api.nordvpn.com/v1/users/services/credentials | jq -r .nordlynx_private_key`
- ⚠️ **DNS / MAJ gluetun** : la variable `DOT` est dépréciée (remplacée par `DNS_UPSTREAM_RESOLVER_TYPE`). L'ancien `DOT=off` a été **retiré** du compose le 2026-06-29 car il cassait le démarrage des versions récentes (`ERROR dns settings: upstream type dot must be plain if the built-in DNS server is disabled`). On laisse désormais le **DNS-over-TLS intégré par défaut** (Cloudflare, chiffré, anti-fuite). Après toute MAJ de gluetun : vérifier `docker logs gluetun` + l'IP de sortie via `docker exec transmission curl -s https://api.ipify.org` (doit ≠ IP serveur).

## Sécurité

- **fail2ban** actif (jail `sshd`, backend systemd) — config `/etc/fail2ban/jail.local`. `fail2ban-client status sshd` pour voir les bans.
- SSH : `PasswordAuthentication` encore activé (TODO : passer en clé-only).
- Pare-feu : pas encore d'ufw/nftables (TODO). ⚠️ ufw ne bloque pas les ports publiés par Docker → on s'appuie sur le bind `172.17.0.1` dans le compose (déjà en place pour tous les *arr depuis 2026-06-16) plutôt que sur un firewall pour ces ports.

## Supervision / alertes

- **Glances** (`glances`, network_mode host) — métriques système, intégré au dashboard.
- **smartd** (smartmontools) : daemon actif (santé S.M.A.R.T. des disques). À configurer pour alerter (`-M exec` → ntfy).
- **ntfy** : notifs push sur téléphone via le serveur public gratuit `ntfy.sh`. Topic secret + token dans `.env` (jamais commités). Alertes actives : `alert-check.sh` (disque>90%/conteneurs/gluetun/fuite IP, timer 10 min), `glacier-watch.sh` (upload+restauration Glacier, timer 5 min), `smartd-ntfy.sh` (santé disques). App ntfy native requise sur mobile (web push navigateur peu fiable).

## Sauvegardes (backup-config)

`backup-config.sh` (timer `backup-config.timer`, chaque nuit 03:30) sauvegarde les configs **chiffrées** vers Scaleway Object Storage (bucket `mediaserver-config-backups`, classe Standard, région fr-par). Rétention : 14 archives.

Périmètre : bases *arr (dump SQLite cohérent `.backup`) + config.xml, `jellyfin.db` + configs plugins + `/etc/jellyfin`, et le stack (compose/.env/presets/scripts). PAS le cache d'images (ré-téléchargeable).

Chiffrement : GPG symétrique AES256, passphrase dans `.env` (`BACKUP_GPG_PASSPHRASE`). ⚠️ **La passphrase doit aussi être conservée HORS serveur** (sinon backups irrécupérables si le serveur meurt).

**Restauration :**
```bash
source /srv/media-stack/.env
export AWS_ACCESS_KEY_ID=$SCW_ACCESS_KEY AWS_SECRET_ACCESS_KEY=$SCW_SECRET_KEY
EP="https://s3.${SCW_REGION}.scw.cloud"
aws s3 ls s3://$BACKUP_BUCKET/ --endpoint-url $EP --region $SCW_REGION   # choisir une archive
aws s3 cp s3://$BACKUP_BUCKET/<archive>.tar.gz.gpg . --endpoint-url $EP --region $SCW_REGION
gpg -d --passphrase "$BACKUP_GPG_PASSPHRASE" <archive>.tar.gz.gpg | tar xz
# -> dump/arr/*.db, dump/jellyfin/*, dump/stack.tar.gz ; restaurer service par service (stoppé).
```

## Versions en production (à jour au 2026-09-11)

| Composant | Version |
|---|---|
| Jellyfin | 12.0.0 |
| jellyfin-ffmpeg8 | 8.1.2 |
| dotnet SDK (build plugin Glacier) | 10.0 |
| Node.js (media-mcp) | 20 LTS |
| @modelcontextprotocol/sdk | 1.29.0 |
| express | 4.x |
| zod | 3.x |

> express v5 et zod v4 sont des majeures avec breaking changes — migration volontairement reportée.

## Points d'attention

- **`/mnt/media` est structurellement plein** (≈96 % après ménage du 2026-09-11). Les downloads sont majoritairement des hardlinks (pas de double stockage) : pour libérer, archiver sur Glacier ou supprimer des médias, pas les downloads. Audit rapide : `find /mnt/media/downloads/complete -type f -links 1 -size +500M`.
- **Reboot** : uptime > 300 j, kernel installé ≠ kernel chargé → redémarrage à planifier hors heures de visionnage (`shutdown -r +2`).
- `alert-check.sh` surveille aussi `bazarr` et `jellyseerr` (liste `EXPECTED_CONTAINERS`).

- **Tout le trafic *arr/Transmission passe par Gluetun** : si Gluetun est down, ces services sont inaccessibles même en local.
- Les services *arr (`radarr`, `sonarr`, `prowlarr`) sont aussi installés comme services systemd natifs sur l'hôte (`/opt/Radarr`, `/opt/Sonarr`, `/opt/prowlarr`) mais sont **désactivés** — seule la version Docker tourne.
- `media-mcp` accède aux apps *arr via `host.docker.internal:{port}` (ports publiés par gluetun sur l'hôte).
- Prowlarr et Sonarr/Radarr doivent être configurés manuellement pour se pointer mutuellement (pas dans le docker-compose).
