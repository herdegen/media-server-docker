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

### À faire (non bloquant)

- **Reboot à planifier** : kernel en retard (6.12.48 → 6.12.74)
- **Migration express v5** : breaking changes à évaluer
- **Migration zod v4** : breaking changes à évaluer
