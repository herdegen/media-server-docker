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
| `lidarr`        | `lscr.io/linuxserver/lidarr`            | 8686        | Musique (via gluetun, `lidarr.maxibestof.com`, OAuth), root folder `/data/music`, catégorie Transmission `music-lidarr`. Config `/var/lib/lidarr`. API **v1** |
| `slskd` / `soularr` | `slskd/slskd` / `mrusse08/soularr` | 5030 | Soulseek (via gluetun) : Soularr envoie les albums **surveillés manquants** de Lidarr à slskd. `slskd.maxibestof.com` (OAuth). Aucun partage, upload désactivé. Configs `/var/lib/slskd`, `/var/lib/soularr` |
| `romarr`        | `ghcr.io/blizzhacker/romarr`            | 6868        | *arr des ROMs (via gluetun, `romarr.maxibestof.com`, OAuth + mot de passe ROMarr), range dans `/srv/games` pour Moonbase. Config `/var/lib/romarr` |

> Hors compose mais présents : **recyclarr** (`docker run` via `recyclarr-sync.timer`, config `recyclarr/`, sync TRaSH → Radarr/Sonarr chaque nuit) et **tinymediamanager** (conteneur autonome piloté par `tmm-start.timer`/`tmm-stop.timer`, fenêtre 02h–08h UTC).
>
> ⚠️ `tinymediamanager` ne fait plus partie du `docker-compose.yml`. Les ports des *arr (7878/8989/9696/9091/6868/8686 + control server gluetun 8000) sont publiés par **gluetun bindés sur `172.17.0.1`** (durci 2026-06-16) → accessibles aux autres conteneurs (Homepage) et à l'hôte, mais **PAS depuis Internet**. Accès navigateur via Traefik + OAuth. FlareSolverr (8191) n'est pas publié sur l'hôte (interne au réseau gluetun).

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

**Plugin Moonbase** 2.3.0.0 (jeux rétro + client Moonfin, repo `Moonfin-Client/Plugin`, installé à la main le 2026-09-28, `targetAbi 10.10` mais charge bien sur la 12) : ROMs dans `/srv/games/<Console>/` (disque système, PAS `/mnt/media`), émulation côté client. Saves par utilisateur dans `plugins/configurations/Moonfin/saves/` (inclus au backup, caches exclus). ⚠️ Renommer/déplacer une ROM rend ses saves orphelines.

**Plugin Glacier** (archivage films → Scaleway Glacier) : sources et repo git dans `/opt/jellyfin-glacier-plugin` (README = build + install ; `dotnet build -c Release -p:JellyfinBin=...`). Le bouton web est injecté par `glacier-inject.v2.js` via JavaScript Injector. Base des items : `/var/lib/jellyfin/data/glacier_items.json`. Vérif rapide : `GET /Glacier/items` (avec un token) et tâche planifiée « Glacier - Vérifier les restaurations en cours ».

## Chemins importants

### Stockage média (`/mnt/media/`)

```
/mnt/media/
├── movies/      # Films (~752 GB) — rootFolderPath Radarr
├── series/      # Séries (~520 GB) — rootFolderPath Sonarr
├── music/       # Musique (~166 GB, rangée comme en local 2026-10-09) — rootFolderPath Lidarr
├── downloads/   # Torrents en cours (~268 GB, dont ~250 GB de hardlinks)
│   ├── complete/
│   ├── incomplete/
│   ├── tv-sonarr/
│   └── tmm/
├── watch/       # Dossier auto-add Transmission
└── config/
    └── tmm/     # Config TinyMediaManager
```

> ⚠️ Mesurer avec `du -sh /mnt/media/*` (un seul appel) **fausse ces chiffres** : `du` ne compte un inode qu'une fois et attribue tous les hardlinks downloads↔movies/series au premier dossier parcouru (`downloads`). Les tailles ci-dessus sont des mesures **par dossier séparé** (`du -sh --apparent-size /mnt/media/series`, etc.) — c'est la seule façon d'obtenir le vrai poids. Relevé au 2026-10-08.

### Configs des apps *arr (montées dans les conteneurs)

- Radarr   → `/var/lib/radarr`
- Sonarr   → `/var/lib/sonarr`
- Prowlarr → `/var/lib/prowlarr`
- Lidarr   → `/var/lib/lidarr`
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
- **Anti-malware downloads** — 4 couches :
  1. Custom format Sonarr/Radarr « Executable (malware) » -10000 sur tous les profils (depuis 2026-09-18, protégé du sync Recyclarr par `except`). ⚠️ Ne voit que le **titre** → inefficace contre les faux à titre propre (LimeTorrents, TorrentDownload), qui sont la majorité.
  2. **Hook `script-torrent-added`** (depuis 2026-10-08) : `/var/lib/transmission-daemon/malware-guard-hook.sh` — vu comme `/config/malware-guard-hook.sh` dans le conteneur, donc **aucune modif du compose** (pas de recréation de gluetun). Activé via `script-torrent-added-enabled`/`-filename` dans `settings.json`. Inspecte la liste de fichiers dès l'ajout et supprime le torrent **avant tout téléchargement**. ⚠️ Transmission réécrit `settings.json` à l'arrêt → **toujours `docker stop transmission` avant d'éditer**, sinon la modif est perdue. Log : `/var/lib/transmission-daemon/malware-guard-hook.log`. `DRY=1` pour tester sans supprimer. ⚠️ Après un test, vérifier que `download-dir` est bien revenu à `/data/downloads/complete` (resté sur `/config/hooktest` le 2026-10-08).
     > Sur un **magnet**, les métadonnées ne sont pas encore là à l'ajout : le hook sort sans rien faire et c'est la couche 3 qui attrape le torrent (≤ 5 min).
     >
     > **Couplage couche 2 ↔ 3** : le hook faisant disparaître le torrent de Transmission, `malware-guard.sh` ne peut plus l'y voir pour blacklister la release → sans quoi Sonarr regrabberait le même faux en boucle. Le hook inscrit donc le hash dans `/var/lib/transmission-daemon/quarantine.list`, que `malware-guard.sh` consomme (renommage atomique en `.processing`) pour blacklister côté *arr. **Ne pas casser ce fichier.**
  3. **`malware-guard.sh`** (`malware-guard.timer`, toutes les 5 min, depuis 2026-10-08) — **la couche de référence**. Détecte sur la **liste de fichiers réelle** du torrent via le RPC Transmission (`172.17.0.1:9091`, sans auth), puis `DELETE /api/v3/queue/{id}?removeFromClient=true&blocklist=true&skipRedownload=false` → supprime les données, blackliste la release définitivement et relance une recherche de remplacement. Les torrents qu'aucun *arr ne revendique (ROMarr, ajout manuel) sont retirés directement par RPC. Balayage final des orphelins **strictement limité à `/mnt/media/downloads`**. Log : `alerts/malware-guard.log`. Dry-run : `malware-guard.sh --dry-run`.
  4. Section 5 d'`alert-check.sh` = filet. Si elle alerte encore, c'est que `malware-guard` a échoué.
  > Historique : les couches 2 et 3 manquaient jusqu'au 2026-10-08. Le CF ne bloquait rien et `alert-check` se contentait d'alerter → 8 torrents / 8,3 GB de faux `.exe` accumulés pendant 3 semaines, coincés en `importPending` dans Sonarr (qui ne les marque **jamais** en échec, donc ne cherche jamais de remplacement). Purgés le 2026-10-08.
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

- ⚠️ **Vérifier les `path` de Sonarr après tout ajout de série.** Au 2026-10-08, 11 séries sur 23 pointaient vers un dossier inexistant (nom du *dossier de release* au lieu du dossier série, parfois apparié au mauvais show par TheTVDB) → `episodeFileCount=0` malgré les fichiers présents → **864 épisodes monitorés cherchés en boucle**, principal moteur du remplissage du disque. Corrigé par réparation des `path` + `RescanSeries` (50 Go réadoptés) et suppression de 4 séries fantômes (`deleteFiles=false`). Diagnostic : comparer le `path` de l'API au disque, en traduisant `/data/series/` → `/mnt/media/series/`.
- **`/mnt/media` est structurellement plein** (≈96 % après ménage du 2026-09-11). Les downloads sont majoritairement des hardlinks (pas de double stockage) : pour libérer, archiver sur Glacier ou supprimer des médias, pas les downloads. Audit rapide : `find /mnt/media/downloads/complete -type f -links 1 -size +500M`.
- **Reboot** : après une MAJ kernel (kernel installé ≠ chargé, cf. `uname -r` vs `/boot`), redémarrer hors heures de visionnage (`shutdown -r +2`), puis lancer `post-reboot-check.sh`. Dernier reboot : 2026-10-08 (6.12.111).
- `alert-check.sh` surveille aussi `bazarr`, `jellyseerr`, `lidarr`, `slskd` et `soularr`
- ⚠️ **Lidarr/Soularr — demander un album** = surveiller l'ARTISTE et l'album, et ajouter l'id d'album dans `/var/lib/soularr/approved_album_ids.txt` ; sinon `soularr-guard` (timer 1 min) coupe Soularr au-delà de 20 albums hors liste (`docker start soularr` pour relancer). Le refresh planifié de Lidarr re-surveille les albums : ne jamais laisser d'artistes surveillés sans raison. Corbeille Lidarr `/mnt/media/.lidarr-recycle` (30 j).
- ⚠️ **Lidarr : ne surveiller que ce qu'on demande.** Tout surveillé = Lidarr ET Soularr téléchargent la discographie entière. Le scan auto du root folder ajoute les artistes en `existing` / nouvelles sorties `none`. (liste `EXPECTED_CONTAINERS`).

- **Tout le trafic *arr/Transmission passe par Gluetun** : si Gluetun est down, ces services sont inaccessibles même en local.
- **ROMarr 0.9.0 — correctif local** `romarr/sitecustomize.py` (monté dans le conteneur) : ajoute `Transmission.completed()` absent upstream (sans lui, aucun import). S'auto-désactive si upstream ajoute la méthode. ROMarr apparie torrent ↔ release par nom exact : quand le nom du torrent diffère, l'import ne se fait pas → ranger à la main dans `/srv/games/<slug>/`.
- ⚠️ **Modifier le bloc gluetun (ports, env) le RECRÉE** au `docker compose up` → flaresolverr/prowlarr/sonarr/radarr/transmission/romarr restent accrochés à l'ancien netns (plus de réseau ni de ports). Toujours enchaîner : `docker compose up -d --force-recreate --no-deps flaresolverr prowlarr sonarr radarr transmission romarr lidarr slskd soularr`.
- Les services *arr (`radarr`, `sonarr`, `prowlarr`) sont aussi installés comme services systemd natifs sur l'hôte (`/opt/Radarr`, `/opt/Sonarr`, `/opt/prowlarr`) mais sont **désactivés** — seule la version Docker tourne.
- `media-mcp` accède aux apps *arr via `host.docker.internal:{port}` (ports publiés par gluetun sur l'hôte).
- Prowlarr et Sonarr/Radarr doivent être configurés manuellement pour se pointer mutuellement (pas dans le docker-compose).
