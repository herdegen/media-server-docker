# CHANGELOG

Historique des modifications apportées au stack média.

---

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
