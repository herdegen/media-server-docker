#!/usr/bin/env bash
#
# soularr-guard.sh — Coupe Soularr si Lidarr se met à "vouloir" trop d'albums.
# Lancé par soularr-guard.timer (chaque minute, root).
#
# Pourquoi : le 2026-10-09, le refresh planifié de Lidarr a re-surveillé ~10 000
# albums ; Soularr (toutes les 5 min) en a téléchargé 6 et Lidarr a SUPPRIMÉ les
# fichiers d'origine de 2 albums pour les remplacer. Protection = blocage :
# on compte les albums surveillés manquants ABSENTS de la liste approuvée
# (/var/lib/soularr/approved_album_ids.txt, un id Lidarr par ligne). Au-delà de MAX
# (une dérive, pas une demande faite à la main), on stoppe Soularr (pas de
# redémarrage auto) et on prévient. Relancer à la main après vérification :
#   docker start soularr
#
set -uo pipefail
MAX=20
STACK_DIR="/srv/media-stack"
LOG="$STACK_DIR/alerts/soularr-guard.log"
LIDARR="http://172.17.0.1:8686"
APPROVED="/var/lib/soularr/approved_album_ids.txt"

# shellcheck disable=SC1091
source "$STACK_DIR/.env"
KEY=$(grep -oP '(?<=<ApiKey>)[^<]+' /var/lib/lidarr/config.xml 2>/dev/null | head -1)

wanted=$(curl -s --max-time 60 "$LIDARR/api/v1/wanted/missing?pageSize=20000&monitored=true" \
      -H "X-Api-Key: $KEY" | jq -r '.records[]?.id' 2>/dev/null) || exit 0
[ -z "$wanted" ] && exit 0
# albums voulus hors liste approuvée
n=$(comm -23 <(sort -u <<<"$wanted") <(sort -u "$APPROVED" 2>/dev/null) | wc -l)
# Lidarr injoignable : Soularr ne peut rien télécharger non plus -> rien à faire.
[ -z "$n" ] && exit 0
[ "$n" -le "$MAX" ] && exit 0
[ "$(docker inspect -f '{{.State.Running}}' soularr 2>/dev/null)" = "true" ] || exit 0

docker stop soularr >/dev/null 2>&1
printf '%s  STOP soularr : %s albums hors liste approuvée (max %s)\n' "$(date '+%F %T')" "$n" "$MAX" >> "$LOG"
curl -s -o /dev/null --max-time 15 \
  -H "Authorization: Bearer $NTFY_TOKEN" \
  -H "Title: Soularr stoppé" -H "Priority: high" -H "Tags: stop_sign" \
  -d "Lidarr veut $n albums non approuvés (max $MAX) : Soularr a été arrêté avant de tout télécharger. Vérifier les albums surveillés, puis : docker start soularr" \
  "https://ntfy.sh/${NTFY_TOPIC}"
