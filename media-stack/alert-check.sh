#!/usr/bin/env bash
#
# alert-check.sh — Surveillance serveur médiathèque, alertes push via ntfy.
# Lancé par cron (root) toutes les 10 min. Ne notifie qu'au CHANGEMENT d'état
# (panne -> alerte, puis rétablissement -> notif "résolu"), jamais en boucle.
#
set -uo pipefail

STACK_DIR="/srv/media-stack"
STATE_DIR="$STACK_DIR/alerts/state"
DISK_MOUNT="/mnt/media"
DISK_THRESHOLD=90
GLUETUN_CTRL="http://172.17.0.1:8000/v1/publicip/ip"
GLUETUN_AUTH="/srv/docker/gluetun/auth/config.toml"
EXPECTED_CONTAINERS="gluetun flaresolverr prowlarr sonarr radarr transmission media-mcp traefik oauth2-proxy homepage vpn-control glances"

# --- Secrets ntfy (topic + token), hors git ---
# shellcheck disable=SC1091
source "$STACK_DIR/.env"
NTFY_URL="https://ntfy.sh/${NTFY_TOPIC}"

mkdir -p "$STATE_DIR"

# notify_change <clé> <état: bad|ok> <titre> <message> [priorité] [tags]
# N'envoie que si l'état a changé depuis le dernier passage.
notify_change() {
  local key="$1" state="$2" title="$3" msg="$4"
  local prio="${5:-high}" tags="${6:-warning}"
  local f="$STATE_DIR/$key"
  local prev="ok"
  [ -f "$f" ] && prev="$(cat "$f")"

  [ "$state" = "$prev" ] && return 0   # pas de changement -> rien

  echo "$state" > "$f"
  if [ "$state" = "ok" ]; then
    title="✅ Résolu — $title"; prio="default"; tags="white_check_mark"
  fi
  curl -s -o /dev/null --max-time 15 \
    -H "Authorization: Bearer $NTFY_TOKEN" \
    -H "Title: $title" \
    -H "Priority: $prio" \
    -H "Tags: $tags" \
    -d "$msg" \
    "$NTFY_URL"
}

# --- 1. Disque /mnt/media ---
use=$(df --output=pcent "$DISK_MOUNT" 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "$use" ] && [ "$use" -ge "$DISK_THRESHOLD" ]; then
  avail=$(df -h "$DISK_MOUNT" | awk 'NR==2{print $4}')
  notify_change disk bad "Disque presque plein" \
    "${DISK_MOUNT} à ${use}% (reste ${avail}). Fais du ménage." urgent floppy_disk
else
  notify_change disk ok "Disque" "${DISK_MOUNT} repassé sous ${DISK_THRESHOLD}% (${use}%)."
fi

# --- 2. Conteneurs attendus ---
running="$(docker ps --format '{{.Names}}')"
down=""
for c in $EXPECTED_CONTAINERS; do
  grep -qx "$c" <<<"$running" || down="$down $c"
done
if [ -n "$down" ]; then
  notify_change containers bad "Conteneur(s) tombé(s)" \
    "À l'arrêt :$down" urgent x
else
  notify_change containers ok "Conteneurs" "Tous les conteneurs sont de nouveau up."
fi

# --- 3. Santé gluetun (kill-switch) ---
health=$(docker inspect --format '{{.State.Health.Status}}' gluetun 2>/dev/null)
if [ "$health" != "healthy" ]; then
  notify_change gluetun bad "VPN gluetun KO" \
    "gluetun n'est pas healthy (état: ${health:-absent}). Les *arr/transmission sont coupés (kill-switch)." urgent rotating_light
else
  notify_change gluetun ok "VPN gluetun" "gluetun de nouveau healthy."
fi

# --- 4. IP VPN : présente + différente de l'IP réelle (anti-fuite) ---
# Le control server gluetun protège cette route par apikey (lue dans config.toml).
ctrl_key=$(grep -oP 'apikey\s*=\s*"\K[^"]+' "$GLUETUN_AUTH" 2>/dev/null)
vpn_ip=$(curl -s --max-time 10 -H "X-API-Key: $ctrl_key" "$GLUETUN_CTRL" | grep -o '"public_ip":"[^"]*"' | cut -d'"' -f4)
host_ip=$(curl -s --max-time 10 https://api.ipify.org)
if [ -z "$vpn_ip" ]; then
  notify_change vpnip bad "IP VPN introuvable" \
    "Le control server gluetun ne renvoie pas d'IP publique — VPN probablement down." urgent rotating_light
elif [ -n "$host_ip" ] && [ "$vpn_ip" = "$host_ip" ]; then
  notify_change vpnip bad "FUITE IP possible" \
    "L'IP VPN ($vpn_ip) = l'IP réelle du serveur. Le trafic ne passe peut-être plus par le VPN !" urgent rotating_light
else
  notify_change vpnip ok "IP VPN" "IP VPN OK ($vpn_ip)."
fi
