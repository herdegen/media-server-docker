#!/usr/bin/env bash
#
# soularr-guard.sh — Coupe Soularr si Lidarr se met à "vouloir" trop d'albums.
# Lancé par soularr-guard.timer (chaque minute, root).
# Pourquoi chaque minute (et pas 5) : Soularr tourne toutes les 300 s
# (SCRIPT_INTERVAL). Avec un garde-fou au même rythme et non synchronisé, Soularr
# passerait en premier une fois sur deux et téléchargerait la dérive avant
# qu'on la retire. À 1 min, la fenêtre d'exposition tombe à <= 60 s. Coût
# négligeable : un GET sur l'API Lidarr, < 1 s par passage.
#
# Pourquoi : le 2026-10-09, le refresh planifié de Lidarr a re-surveillé ~10 000
# albums ; Soularr (toutes les 5 min) en a téléchargé 6 et Lidarr a SUPPRIMÉ les
# fichiers d'origine de 2 albums pour les remplacer. Protection = blocage :
# on compte les albums surveillés manquants ABSENTS de la liste approuvée
# (/var/lib/soularr/approved_album_ids.txt, un id Lidarr par ligne). Au-delà de MAX
# (une dérive, pas une demande faite à la main), on DÉSURVEILLE ces albums hors
# liste et on prévient : Soularr continue sur la liste approuvée. Si ce retrait
# échoue, on stoppe Soularr (pas de redémarrage auto). Relancer à la main :
#   docker start soularr
# (2026-10-13 : la v1 stoppait Soularr, ce qui a mis la récupération en pause 3 jours.)
#
# Liste blanche absente / vide / illisible / malformée : on ne désurveille RIEN.
# Sans elle, "hors liste" = TOUS les albums voulus, y compris ceux demandés à la
# main -> la v2 les aurait tous désurveillés. On stoppe Soularr par sécurité et on
# sort en erreur (systemd -> ntfy-fail@). Notif dédiée seulement au moment où on
# stoppe Soularr, pas à chaque minute.
#
set -uo pipefail
MAX=20
STACK_DIR="/srv/media-stack"
LOG="$STACK_DIR/alerts/soularr-guard.log"
LIDARR="http://172.17.0.1:8686"
APPROVED="/var/lib/soularr/approved_album_ids.txt"

# shellcheck disable=SC1091
source "$STACK_DIR/.env"
# --- Garde-fou de la liste blanche, AVANT tout appel à Lidarr ---
# Lignes acceptées : un id numérique, vide, ou commentaire "#". Toute autre
# ligne = fichier abîmé (édition ratée, binaire...) -> on ne lui fait pas confiance.
approved_problem=""
if [ ! -r "$APPROVED" ]; then
  approved_problem="absente ou illisible"
elif ! grep -qE '^[0-9]+[[:space:]]*$' "$APPROVED"; then
  approved_problem="vide (aucun id)"
elif grep -vqE '^[0-9]+[[:space:]]*$|^[[:space:]]*(#.*)?$' "$APPROVED"; then
  approved_problem="malformée (ligne non numérique)"
fi
if [ -n "$approved_problem" ]; then
  if [ "$(docker inspect -f '{{.State.Running}}' soularr 2>/dev/null)" = true ]; then
    docker stop soularr >/dev/null 2>&1
    printf '%s  liste approuvée %s -> STOP soularr, rien désurveillé\n' "$(date '+%F %T')" "$approved_problem" >> "$LOG"
    curl -s -o /dev/null --max-time 15 \
      -H "Authorization: Bearer $NTFY_TOKEN" \
      -H "Title: Soularr arrêté : liste approuvée $approved_problem" -H "Priority: high" -H "Tags: stop_sign" \
      -d "$APPROVED est $approved_problem : impossible de distinguer les demandes de la dérive, donc rien n'a été désurveillé et Soularr est arrêté. Réparer la liste puis : docker start soularr" \
      "https://ntfy.sh/${NTFY_TOPIC}"
  fi
  echo "ERREUR: $APPROVED $approved_problem" >&2
  exit 1
fi

KEY=$(grep -oP '(?<=<ApiKey>)[^<]+' /var/lib/lidarr/config.xml 2>/dev/null | head -1)

wanted=$(curl -s --max-time 60 "$LIDARR/api/v1/wanted/missing?pageSize=20000&monitored=true" \
      -H "X-Api-Key: $KEY" | jq -r '.records[]?.id' 2>/dev/null) || exit 0
[ -z "$wanted" ] && exit 0
# albums voulus hors liste approuvée
extra=$(comm -23 <(sort -u <<<"$wanted") <(grep -oE '^[0-9]+' "$APPROVED" | sort -u))
n=$(grep -c . <<<"$extra")
# Lidarr injoignable : Soularr ne peut rien télécharger non plus -> rien à faire.
[ -z "$n" ] && exit 0
[ "$n" -le "$MAX" ] && exit 0

ids=$(jq -R 'tonumber' <<<"$extra" | jq -sc .)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 -X PUT "$LIDARR/api/v1/album/monitor" \
  -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' -d "{\"albumIds\":$ids,\"monitored\":false}")

if [ "$code" = "202" ]; then
  action="désurveillés (Soularr continue)"
  msg="Lidarr voulait $n albums non approuvés (max $MAX) : ils ont été désurveillés. Soularr continue sur la liste approuvée."
else
  docker stop soularr >/dev/null 2>&1
  action="retrait KO (HTTP $code) -> STOP soularr"
  msg="Lidarr veut $n albums non approuvés et le retrait a échoué (HTTP $code) : Soularr arrêté. Vérifier, puis : docker start soularr"
fi
printf '%s  %s albums hors liste approuvée (max %s) : %s\n' "$(date '+%F %T')" "$n" "$MAX" "$action" >> "$LOG"
curl -s -o /dev/null --max-time 15 \
  -H "Authorization: Bearer $NTFY_TOKEN" \
  -H "Title: Soularr : dérive Lidarr bloquée" -H "Priority: high" -H "Tags: stop_sign" \
  -d "$msg" "https://ntfy.sh/${NTFY_TOPIC}"
