# CHANGELOG

Historique des modifications apportées au stack média.

---

## 2026-10-09

### Lidarr/Soularr : incident et garde-fou

- Le refresh planifié de Lidarr a re-surveillé ~10 000 albums (malgré `monitorNewItems=none`). Soularr en a grabbé 6 ; Lidarr a **supprimé définitivement** les originaux de Ladytron *604* (16 pistes) et Pink Floyd *A Momentary Lapse of Reason* (10 pistes), remplacés par les versions Soulseek (originaux toujours sur le PC local). 4 albums non demandés restés dans `downloads/complete/soulseek`.
- Correctifs : **artistes non surveillés** par défaut (Lidarr ne veut rien pour un artiste non surveillé) ; **corbeille Lidarr** `/mnt/media/.lidarr-recycle` (30 j) ; **`soularr-guard.sh`** + `soularr-guard.timer` (chaque minute) : stoppe Soularr et notifie si plus de 20 albums voulus sont absents de `/var/lib/soularr/approved_album_ids.txt`.
- Lancé : complétion des 194 albums incomplets validés (109 artistes surveillés, `monitorNewItems=none`), via Soularr + `MissingAlbumSearch`. Il existe en réalité 873 albums incomplets (dont ~450 à un seul titre) — non lancés (≈ 85 Go).

### Musique : alignement sur le rangement local

- Inventaire local (empreinte SHA1 taille + 1er/dernier Mo) comparé au serveur : 100 % de l'audio local déjà présent, **rien à renvoyer**.
- Appliqué : 7 834 déplacements (rename, 0 copie), 2 178 hardlinks pour les doublons locaux, 5 459 fichiers serveur non appariés rangés dans `/mnt/media/music/_restes_serveur/` (chemins d'origine conservés : déchets `.ini`/`Thumbs.db`/`.itc2`, 787 `.bc!` BitComet incomplets, ~160 audio dont ~69 doublons), 3 353 dossiers vides supprimés. Lidarr stoppé pendant l'opération, puis `RescanFolders` + refresh de la bibliothèque Jellyfin « Musiques ».
- Plan, scripts et journal : `/var/lib/media-reorg/`. **Annulation** : `sudo python3 -I /var/lib/media-reorg/undo_reorg.py /var/lib/media-reorg/journal-20261009.tsv` (ne recrée pas les dossiers vides supprimés).
- `_restes_serveur` trié puis **supprimé** : déchets (`.ini`, `Thumbs.db`, `.itc2`, 787 `.bc!`, AppleDouble `._*`, iTunes, `.ipa`, pochettes, fichiers de rip) = 28,4 Go libérés ; 91 audio + 15 modules vérifiés **doublons exacts** (empreinte du flux audio via ffmpeg, tags exclus) puis supprimés. Liste complète : `/var/lib/media-reorg/dechets_supprimes-20261009.txt`.
- Restaurés dans la bibliothèque : `Daft Punk/Random Access Memories (2013)` (seul exemplaire, fichiers « - Copie » renommés) et `MaXi Compil` (compilation conservée à la demande, morceaux aussi présents par artiste). À répercuter en local.
- 3 MP3 vides (0 octet) supprimés : Funkadelic *Uncle Jam Wants You* pistes 4 et 5 (désormais manquantes), ELO `Send It~#~.mp3` (doublon cassé ; *Balance of Power* est complet et vérifié au décodage).

---

## 2026-10-08

### Lidarr (musique)

- Nouveau conteneur `lidarr` (`lscr.io/linuxserver/lidarr`, v3.1) derrière gluetun, port `172.17.0.1:8686` publié par gluetun (gluetun + services accrochés recréés). Config `/var/lib/lidarr`, auth `External` (derrière OAuth), `https://lidarr.maxibestof.com` (route dans `traefik/dynamic/arr.yml`).
- Root folder `/data/music` (profil qualité Standard, métadonnées Standard). Les 1054 dossiers existants ne sont **pas** importés automatiquement : *Library → Import* dans l'UI.
- `/mnt/media/music` : propriétaire 1002 conservé, groupe passé à 1000 (PGID conteneurs) + `g+w` + setgid sur les dossiers, pour que Lidarr puisse écrire.
- Transmission catégorie `music-lidarr` (→ `/data/downloads/complete/music-lidarr`). Prowlarr → Lidarr en fullSync : seul **1337x** expose des catégories musique.
- Intégré à `malware-guard.sh` (file `/api/v1/queue`, `arr_purge` prend la version d'API), `alert-check.sh`, `post-reboot-check.sh` (+ romarr qui manquait), `backup-config.sh`, widget Homepage (`HOMEPAGE_VAR_LIDARR_KEY` dans `homepage.env`).
- Le scan initial a auto-ajouté 768 artistes en « tout surveiller » → 4046 albums manquants + 878 incomplets prêts à être cherchés (même piège que Sonarr). **Tout passé en non surveillé** avant le moindre grab ; artistes `monitorNewItems=none` ; root folder par défaut `existing`/`none`. Règle : on ne surveille que ce qu'on demande.
- **Soulseek** : `slskd` (client, `slskd.maxibestof.com` OAuth + login propre, port `172.17.0.1:5030` via gluetun) + `soularr` (toutes les 5 min, albums **surveillés manquants** Lidarr → recherche slskd → import Lidarr, MP3 uniquement). Configs `/var/lib/slskd/slskd.yml`, `/var/lib/soularr/config.ini`, identifiants dans `/var/lib/slskd/credentials.txt` (600). **Aucun partage, upload 0 slot** (choix délibéré : on ne diffuse pas la bibliothèque). Téléchargements dans `/data/downloads/complete/soulseek` (non couverts par malware-guard, Lidarr n'importe que l'audio).
- **Correctif** : `download-dir` de Transmission était resté sur `/config/hooktest` après le test du hook malware → rétabli à `/data/downloads/complete` (aucun torrent concerné).

### Anti-malware : on bloque au lieu d'alerter

- Constat : 8 torrents / 8,3 Go de faux `.exe` (titres propres, LimeTorrents/TorrentDownload) accumulés pendant 3 semaines. Le custom format « Executable (malware) » ne voit que le titre, `alert-check` (section 5) ne faisait qu'alerter, et Sonarr laissait les items en `importPending` sans jamais chercher de remplacement. Purgés.
- **Couche 2 — hook `script-torrent-added`** : `/var/lib/transmission-daemon/malware-guard-hook.sh` (vu `/config/...` dans le conteneur, aucune modif du compose). Inspecte la liste de fichiers à l'ajout et supprime le torrent avant tout téléchargement ; inscrit le hash dans `quarantine.list`. Log `malware-guard-hook.log`, `DRY=1` pour tester.
- **Couche 3 — `malware-guard.sh`** + `malware-guard.timer` (5 min) : détection via RPC Transmission sur la liste de fichiers réelle, `DELETE /api/v3/queue/{id}?removeFromClient=true&blocklist=true&skipRedownload=false` (release blacklistée + recherche de remplacement), consommation de `quarantine.list` (renommage atomique `.processing`), balayage des orphelins limité à `/mnt/media/downloads`. Log `alerts/malware-guard.log`, `--dry-run`.
- Correctif : verrou `flock` (`/run/lock/malware-guard.lock`) — deux exécutions simultanées (manuelle + timer) traitaient deux fois la quarantaine. Test de bout en bout OK (faux `.torrent` avec `.exe` → tué à l'ajout → hash consommé, une seule exécution journalisée).

### Sonarr : chemins morts

- 11 séries sur 23 pointaient vers un dossier inexistant (nom du dossier de release, parfois mauvais appariement TheTVDB) → `episodeFileCount=0` → 864 épisodes monitorés recherchés en boucle, principal moteur du remplissage disque.
- `path` réparés + `RescanSeries` (≈ 50 Go réadoptés), 4 séries fantômes supprimées (`deleteFiles=false`). `/mnt/media` : 91 %.

### Divers

- Prowlarr : world-torrent et Torrent9 bloqués par changement de domaine → à réajouter.
- `openvpn-dco-dkms` purgé (module compilé pour le seul kernel 6.12.48, `dkms.service` en échec depuis le 2026-09-11 ; inutile, le VPN est en WireGuard/NordLynx).
- Reboot sur kernel 6.12.111 (6.12.107 chargé).

---

## 2026-09-11

### Jellyfin 10.11.11 → 12.0.0 (+ jellyfin-ffmpeg8 8.1.2)

- Audit préalable : aucune collision de casse entre utilisateurs (migration 12 sinon bloquante), aucune lecture en cours.
- Backup complet avant migration : `/var/backups/jellyfin/jellyfin-pre12-<ts>.tar.gz` (`/var/lib/jellyfin` + `/etc/jellyfin`, 1,8 G). Seul moyen de revenir en 10.11 (schéma de base réécrit).
- Plugins 10.11 déplacés dans `/var/lib/jellyfin/plugins-disabled-pre12/` avant le 1er démarrage (ABI incompatible avec .NET 10).
- Migration DB OK en 54 s (LinkedChildren 1066 items, merge artistes/personnes, refresh CleanNames…), aucune erreur. Scan complet obligatoire lancé ensuite (4 min) : 298 films, 27 séries, 521 épisodes.
- Plugins réinstallés en versions 12 : **Glacier 1.1.0.0** (build maison, cf. ci-dessous), **JavaScript Injector 4.0.0.0** (repo `…/n00bcodr/jellyfin-plugins/main/12/manifest.json`, URL mise à jour dans `system.xml`), **File Transformation 3.0.0.0**, **Open Subtitles 25.0.0.0** (catalogue officiel). Config des plugins (`plugins/configurations/`) conservée telle quelle.
- Vérifications Glacier sur la 12 : `GET /Glacier/items` → 15 films `OnGlacier`, 15 items taggés `Glacier`, page de config OK, tâche « Vérifier les restaurations » exécutée sans erreur, script `glacier-inject.v2.js` bien servi via `/JavaScriptInjector/public.js` et injecté dans `index.html`. Non testé : un archivage/restauration réel (à faire au prochain besoin).
- Intégrations : Radarr → Jellyfin (test notification OK), Jellyseerr (sync bibliothèque OK), Traefik `jellyfin.yml` inchangé.
- ⚠️ Auth legacy désactivée par la 12 (`X-Emby-Token`, `api_key=`, `/emby/`) : media-mcp corrigé (`Authorization: MediaBrowser Token=…`, rebuild). Les vieux clients TV pourraient devoir être mis à jour.

### Plugin Glacier — portage Jellyfin 12 (v1.1.0.0)

- `net10.0`, `FrameworkReference Microsoft.AspNetCore.App` (remplace Mvc.Core 2.2 / Swashbuckle / Logging.Abstractions), chemin des DLL serveur paramétrable (`-p:JellyfinBin=`), AWSSDK copié dans `bin/`. `ReadWriteTimeout` (obsolète) retiré. README (build/install) + `meta.json` ajoutés, `glacier-inject.js` resynchronisé avec la prod. Commit dans `/opt/jellyfin-glacier-plugin` (repo `herdegen/jellyfin-glacier-plugin`). SDK `dotnet-sdk-10.0` installé sur l'hôte.

### Nettoyage disque (98 % → 96 %, ≈ 45 G)

- **FROM** : saisons 1-4 supprimées (bibliothèque + downloads + 4 torrents), série conservée dans Sonarr, S1-S4 démonitorées, `monitorNewItems=all` (S5 sera prise). Dossier vide retiré, série disparue de Jellyfin.
- Orphelins downloads (copies non hardlinkées) : Ted Lasso S04E01 (doublé par le PROPER), Silo S03E04 `.scr` et Futurama S11E07 `.exe` (faux fichiers bloqués par Sonarr), Mad Men S05E04/E06 et Futurama S11E01 playWEB (non importés, lib déjà en meilleure qualité) → torrents supprimés avec données.
- Audit hardlinks : ~159 G des downloads sont partagés avec la bibliothèque (seed sans coût), il ne restait que ~20 G de vraies copies. Reste en cours : *Clue (1985)* à 68 % (0 seed, dans la file Radarr).
- Docker : images inutilisées supprimées (tdarr 4,3 G, anciens jellyseerr ×2, traefik v3.1, docker-socket-proxy) + prune build cache → 2,7 G.

### Divers

- `alert-check.sh` : `bazarr` et `jellyseerr` ajoutés aux conteneurs surveillés.
- `CLAUDE.md` remis à jour (services hors compose, Jellyfin 12, versions, points d'attention).
- Constaté, non traité : `rcette-db` publie PostgreSQL `0.0.0.0:5432` (projet `~/rcette`, hors stack) → à binder sur `172.17.0.1`. Reboot kernel en attente (6.12.48 chargé vs 6.12.107 installé).

## 2026-06-28

### Doublons à chaque import — fix hardlinks (montage unique /data)

- Symptôme : chaque import laissait une **copie** du média dans `downloads/` en plus de la bibliothèque → disque qui se remplit (`/mnt/media` à 93 %).
- Cause : bien que `copyUsingHardlinks=true` dans Radarr ET Sonarr, les conteneurs montaient `downloads` et la lib comme **montages séparés** (`/downloads` + `/movies` / `/tv`). Le hardlink cross-mount échoue (EXDEV) → *arr recopie.
- Fix (migration TRaSH-guides) : montage parent **unique** `${MEDIA_ROOT}:/data` (= `/mnt/media:/data`) pour radarr/sonarr/transmission/bazarr (`.env` : ajout `MEDIA_ROOT`). Repointage :
  - Radarr root `/movies/movies` → `/data/movies/movies` ; Sonarr root `/tv` → `/data/series` (UPDATE SQL `Movies.Path`/`Series.Path`/`RootFolders`, services stoppés, backups `*.db.bak-<ts>`). `MovieFiles`/`EpisodeFiles` n'ont que `RelativePath` → rien à toucher.
  - Transmission `download-dir`/`incomplete-dir`/`watch-dir` → `/data/...` (backup `settings.json.bak-<ts>`). Torrents en seed repointés via `--find` + `--verify` (⚠️ IDs renumérotés au restart).
  - Bazarr : aucun path_mapping → le montage `/data` suffit.
- Vérifié : `stat -c %d` identique pour `/data/downloads` et `/data/movies` dans radarr + test `ln` réel → `nlinks=2`. Root folders `accessible=true`, biblio intacte. Cf [[hardlinks-mount-layout]].

### Nettoyage downloads (~37 G récupérés, 93 % → 91 %)

- 5 torrents James Bond bloqués (incomplets, 0 seed, ~18 G) supprimés via Transmission (à re-télécharger plus tard). Restent 2 doublons radarr (Eighth Day, Falling Down ~17 G) + From S04 en seed.

### Glacier — vignettes vides + clic mort sur les films archivés (UI web)

- Symptôme : dans la grille bibliothèque (navigateur), les 4 films sur Glacier (Kramer, Prometheus, Tu ne tueras point, The Surfer) n'affichaient pas de miniature et le clic ne faisait rien. Serveur 100 % sain (métadonnées, images Primary/Backdrop, PlaybackInfo OK, testés aussi via le domaine public).
- Cause : `applyBadges()` du script d'injection (`glacier-inject.v2.js`, servi par le plugin **JavaScriptInjector**) utilisait `querySelectorAll('[data-id]')` — trop large. En Jellyfin 10.11, plusieurs éléments d'une carte portent le même `data-id` (carte, lien-poster `<a class="cardImageContainer cardContent">`, boutons d'overlay lu/favori, lien-titre). Le badge `position:absolute; z-index:10` était donc injecté ~4× par carte, dont **dans** le lien-poster et les boutons → recouvrait le poster et interceptait les clics.
- Fix : sélecteur restreint à `.card[data-id]` et badge appendu sur `.cardScalable` (au-dessus du poster, hors des éléments cliquables). Appliqué au fichier source ET à la config plugin `Jellyfin.Plugin.JavaScriptInjector.xml` (backups `.bak-<ts>`), Jellyfin redémarré. Vérifié servi via `/JavaScriptInjector/public.js`. Cf [[project-glacier-plugin]].
- ⚠️ Reste à régler (cosmétique, non bloquant) : après archivage, un scan Jellyfin re-sonde le stub MKV de 4 s → `RunTimeTicks` écrasé à 0:04 sur les films archivés.

### Jellyseerr — bouton « Lire sur Jellyfin » cassé

- Symptôme : le bouton renvoyait vers `http://host.docker.internal:8096/web/...`, non résolvable par le navigateur.
- Cause : champ `externalHostname` vide dans `settings.json` → fallback sur l'adresse interne `ip:port` (`host.docker.internal`). Le front Jellyseerr construit le lien comme `jellyfinExternalHost || jellyfinHost` + `/web/index.html#!/...`.
- Fix : `externalHostname = https://jellyfin.maxibestof.com` (URL complète, utilisée verbatim), Jellyseerr redémarré. Backup `settings.json.bak-<date>`.

## 2026-06-14

### Sauvegardes config (backups chiffrés Scaleway)

- `backup-config.sh` + `backup-config.timer` (nuit 03:30) : dump SQLite cohérent des bases *arr + `jellyfin.db`, configs plugins, `/etc/jellyfin`, et le stack → archive **chiffrée GPG AES256** → bucket Scaleway `mediaserver-config-backups` (Standard, fr-par). Rétention 14. Notif ntfy succès/échec. Passphrase dans `.env` (à conserver aussi hors serveur). Restauration testée OK (download+déchiffrement+listing).

### Glacier — réparation bouton (après MAJ Jellyfin 10.11)

- Bouton disparu : entrée injecteur désactivée + plugin **File Transformation** manquant (installé v2.5.11.0) + script incompatible React → réécrit en v2 (token via localStorage, MutationObserver, plus de hashchange). Cf [[project-glacier-plugin]].
- `glacier-watch.sh` corrigé : notifie aussi les **nouveaux** items (marqueur d'init), pas seulement les changements.

### Supervision / alertes

- **ntfy** retenu pour les notifications push sur téléphone (serveur public `ntfy.sh`, **gratuit**, topic au nom imprévisible — non versionné, stocké dans `.env`). Notif de test reçue OK.
- À brancher : alertes disque >90 %, VPN down/fuite IP, conteneur tombé, et `smartd` (santé disques) → tous via `curl` vers le topic ntfy.

### Documentation

- Mise à jour de `CLAUDE.md` (était périmé : VPN Mullvad → NordVPN, services obsolètes, ajout dashboard/fail2ban/bascule VPN).

## 2026-06-13

### VPN — migration Mullvad → NordVPN + mécanisme de bascule

- Mullvad expiré → migration sur **NordVPN (WireGuard/NordLynx)**, sortie Roumanie. gluetun `healthy`, kill-switch OK, transmission relancé.
- Variables VPN sorties du bloc `environment` → **presets** `vpn/{nordvpn,mullvad}.env` (chmod 600), gluetun lit `vpn/active.env` via `env_file`.
- Script **`vpn-switch.sh {nordvpn|mullvad|status}`** : copie le preset → `active.env`, recrée gluetun, attend healthy, relance les *arr+transmission, affiche l'IP.
- **Control server** gluetun activé (`172.17.0.1:8000`, auth apikey) pour le widget VPN du dashboard.
- ⚠️ Abonnement Mullvad expiré → à renouveler avant de rebasculer.

### Dashboard

- **Homepage + Glances** déployés sur `home.maxibestof.com` (derrière Traefik + OAuth GitHub). Panneau `/vpn` (conteneur `vpn-control`) pour piloter la bascule VPN. Cert Let's Encrypt OK.

### Sécurité

- **fail2ban** installé et actif : jail `sshd`, backend systemd, maxretry 5/10min, bantime 1h (incrément jusqu'à 1 semaine), `ignoreip` localhost. Config : `/etc/fail2ban/jail.local`. (≈19k tentatives SSH/24h observées avant install.)

### Nettoyage disque (94 % → 88 %, ~100 G libérés)

- Mad Men S1-S3 démonitorées + fichiers/copies orphelines des downloads supprimés (S04 conservée).

## 2026-06-12

### Incident gluetun (fork bomb)

- Healthcheck `wget` en boucle quand le VPN était down → ~76k process zombies. Fix : healthcheck natif gluetun (`/gluetun-entrypoint healthcheck`) au lieu de `wget`. Mergé sur `main`.

### Plugin Glacier (Jellyfin)

- Plugin d'archivage cold-storage Scaleway Glacier installé et versionné (`glacier-plugin/`). JS d'injection en place. Fonctionnel.

## 2026-04-05

### Mises à jour

- **Jellyfin** : 10.11.0 → 10.11.7 (+ jellyfin-ffmpeg7 7.1.2 → 7.1.3) via `apt upgrade`
- **Traefik** : tag `v3.1` → `v3` dans docker-compose (suit désormais les mineures automatiquement)
- **Tous les conteneurs Docker** (`gluetun`, `sonarr`, `radarr`, `prowlarr`, `transmission`, `flaresolverr`, `oauth2-proxy`) : pull des dernières images `latest` (~4 mois de retard comblé)
- **media-mcp** dépendances npm :
  - `@modelcontextprotocol/sdk` : 1.22.0 → 1.29.0
  - `axios` : 1.13.2 → 1.14.0
  - `express` : 4.21.2 → 4.22.1 (maintenu en v4, v5 est une majeure)
  - `zod` : maintenu en 3.x (v4 est une majeure avec breaking changes)
  - 4 vulnérabilités corrigées via `npm audit fix`

### Nettoyage

- Images Docker orphelines (`<none>`) supprimées : **~1.86 GB libérés**
- Image `romancin/tinymediamanager:latest` (4 ans, non utilisée) supprimée

### Documentation

- Création de `CLAUDE.md` (architecture du stack pour Claude Code)
- Création de `oauth2-proxy.env.example` (template sans secrets)
- Synchronisation du repo GitHub `herdegen/media-server-docker` avec l'état réel du serveur
- Création de ce fichier `CHANGELOG.md`

### Libération d'espace disque (99% → 96%)

- Supprimé : FROM Saison 2, Gunslingers, La Forme de l'eau, Les Fugitifs (~14 GB)
- Vidé : `downloads/complete/radarr/` et `downloads/complete/tv-sonarr/` (~51 GB)
- Importé manuellement : Le Huitième Jour (1996) CD1+CD2 → `Le_Huitième_Jour_(1996)/`

### Planification TinyMediaManager

- TMM limité à la fenêtre 02h00–08h00 via deux timers systemd (`tmm-start.timer`, `tmm-stop.timer`)
- TMM arrêté manuellement hors fenêtre pour libérer le CPU pendant les heures de visionnage

### À vérifier

- **TMM en mode headless** : TinyMediaManager nécessite peut-être une interaction manuelle pour scanner — à vérifier si le scan tourne automatiquement entre 2h et 8h ou s'il reste bloqué sans GUI
- **Reboot à planifier** : kernel en retard (6.12.48 → 6.12.74)

### À faire (non bloquant)

- **Accélération matérielle Jellyfin** : iGPU Intel HD P630 potentiellement disponible — activer QSV si `/dev/dri` accessible après reboot
- **VACUUM base de données Jellyfin** : jellyfin.db à 172 MB, optimisation à faire
- **Migration express v5** : breaking changes à évaluer
- **Migration zod v4** : breaking changes à évaluer
