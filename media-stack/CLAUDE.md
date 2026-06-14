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

> ⚠️ `tinymediamanager` ne fait plus partie du `docker-compose.yml`. Les ports des *arr (7878/8989/9696/9091/8191) sont publiés par **gluetun** en `0.0.0.0` → accessibles depuis Internet (auth Forms/Basic activée sur chaque app ; à terme : binder sur `172.17.0.1` ou passer derrière Traefik).

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

## Sécurité

- **fail2ban** actif (jail `sshd`, backend systemd) — config `/etc/fail2ban/jail.local`. `fail2ban-client status sshd` pour voir les bans.
- SSH : `PasswordAuthentication` encore activé (TODO : passer en clé-only).
- Pare-feu : pas encore d'ufw/nftables (TODO). ⚠️ ufw ne bloque pas les ports publiés par Docker → préférer un bind sur `172.17.0.1` dans le compose.

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

## Versions en production (à jour au 2026-04-05)

| Composant | Version |
|---|---|
| Jellyfin | 10.11.7 |
| jellyfin-ffmpeg7 | 7.1.3 |
| Node.js (media-mcp) | 20 LTS |
| @modelcontextprotocol/sdk | 1.29.0 |
| express | 4.x |
| zod | 3.x |

> express v5 et zod v4 sont des majeures avec breaking changes — migration volontairement reportée.

## Points d'attention

- **Tout le trafic *arr/Transmission passe par Gluetun** : si Gluetun est down, ces services sont inaccessibles même en local.
- Les services *arr (`radarr`, `sonarr`, `prowlarr`) sont aussi installés comme services systemd natifs sur l'hôte (`/opt/Radarr`, `/opt/Sonarr`, `/opt/prowlarr`) mais sont **désactivés** — seule la version Docker tourne.
- `media-mcp` accède aux apps *arr via `host.docker.internal:{port}` (ports publiés par gluetun sur l'hôte).
- Prowlarr et Sonarr/Radarr doivent être configurés manuellement pour se pointer mutuellement (pas dans le docker-compose).
