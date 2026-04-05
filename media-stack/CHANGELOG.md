# CHANGELOG

Historique des modifications apportées au stack média.

---

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
