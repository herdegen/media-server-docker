#!/usr/bin/env bash
# Bascule le VPN de gluetun entre presets (nordvpn / mullvad).
# Usage : ./vpn-switch.sh nordvpn   |   ./vpn-switch.sh mullvad   |   ./vpn-switch.sh status
set -euo pipefail
cd "$(dirname "$0")"

VPN_DIR="./vpn"
ACTIVE="$VPN_DIR/active.env"
APIKEY_FILE="/srv/docker/gluetun/auth/.apikey.txt"

# Services qui partagent le netns de gluetun (network_mode: service:gluetun).
# Quand gluetun est RECRÉÉ, ils restent accrochés à l'ancien netns (plus de
# réseau ni de ports) : il faut les recréer aussi. Liste lue dans le compose pour
# ne plus oublier les services ajoutés après coup (lidarr, slskd, soularr,
# romarr manquaient). Repli sur une liste figée si docker compose/jq échouent.
NETNS_FALLBACK="flaresolverr prowlarr sonarr radarr transmission romarr lidarr slskd soularr"
netns_services() {
  local s
  s=$(sudo docker compose config --format json 2>/dev/null \
      | jq -r '.services | to_entries[] | select(.value.network_mode == "service:gluetun") | .key' 2>/dev/null \
      | tr '\n' ' ')
  [ -n "${s// /}" ] && echo "$s" || echo "$NETNS_FALLBACK"
}

current() { grep -E '^VPN_SERVICE_PROVIDER=' "$ACTIVE" 2>/dev/null | cut -d= -f2 || echo "?"; }

status() {
  echo "Provider actif : $(current)"
  echo -n "Santé gluetun : "; sudo docker inspect --format '{{.State.Health.Status}}' gluetun 2>/dev/null || echo "absent"
  if [ -f "$APIKEY_FILE" ]; then
    local k; k=$(sudo cat "$APIKEY_FILE")
    echo -n "IP publique   : "; curl -s -H "X-API-Key: $k" http://172.17.0.1:8000/v1/publicip/ip 2>/dev/null | sed 's/{.*"public_ip":"\([^"]*\)".*"country":"\([^"]*\)".*/\1 (\2)/' || echo "n/a"
  fi
}

case "${1:-}" in
  nordvpn|mullvad)
    PRESET="$VPN_DIR/$1.env"
    [ -f "$PRESET" ] || { echo "Preset introuvable : $PRESET"; exit 1; }
    echo ">> Bascule VPN vers : $1"
    # État des services du netns AVANT de toucher gluetun : un service arrêté
    # volontairement (ex. soularr stoppé par soularr-guard.sh) doit être recréé
    # sur le nouveau netns mais NE PAS être redémarré dans notre dos.
    SVCS=$(netns_services); RUNNING=""; STOPPED=""
    for s in $SVCS; do
      if [ "$(sudo docker inspect -f '{{.State.Running}}' "$s" 2>/dev/null)" = true ]; then
        RUNNING+="$s "; else STOPPED+="$s "; fi
    done
    cp "$PRESET" "$ACTIVE"
    echo ">> Recréation de gluetun..."
    sudo docker compose up -d gluetun
    echo ">> Attente du tunnel (healthy)..."
    for _ in $(seq 1 12); do
      h=$(sudo docker inspect --format '{{.State.Health.Status}}' gluetun 2>/dev/null || echo starting)
      echo "   health: $h"; [ "$h" = "healthy" ] && break; sleep 10
    done
    if [ "$(sudo docker inspect --format '{{.State.Health.Status}}' gluetun)" != "healthy" ]; then
      echo "!! gluetun n'est pas healthy. Vérifie : sudo docker logs gluetun"
      echo "!! (Mullvad expiré ? abonnement à renouveler.) VPN NON basculé proprement."
      echo "!! Une fois gluetun healthy, raccrocher les services au nouveau netns :"
      echo "!!   sudo docker compose up -d --force-recreate --no-deps $(netns_services)"
      exit 2
    fi
    # --force-recreate --no-deps : un simple "up -d" ne recrée pas un conteneur
    # dont la config n'a pas changé, il resterait sur le netns de l'ancien gluetun ;
    # --no-deps évite de re-toucher gluetun qu'on vient de stabiliser.
    echo ">> Recréation des services derrière le VPN : $RUNNING"
    # shellcheck disable=SC2086  # découpage voulu : un service par mot
    [ -n "$RUNNING" ] && sudo docker compose up -d --force-recreate --no-deps $RUNNING
    if [ -n "$STOPPED" ]; then
      echo ">> Recréés SANS démarrage (étaient arrêtés avant la bascule) : $STOPPED"
      # shellcheck disable=SC2086
      sudo docker compose up --no-start --force-recreate --no-deps $STOPPED
    fi
    echo ">> OK."
    status
    ;;
  status|"")
    status
    ;;
  *)
    echo "Usage : $0 {nordvpn|mullvad|status}"; exit 1
    ;;
esac
