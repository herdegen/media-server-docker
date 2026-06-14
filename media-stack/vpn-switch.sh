#!/usr/bin/env bash
# Bascule le VPN de gluetun entre presets (nordvpn / mullvad).
# Usage : ./vpn-switch.sh nordvpn   |   ./vpn-switch.sh mullvad   |   ./vpn-switch.sh status
set -euo pipefail
cd "$(dirname "$0")"

VPN_DIR="./vpn"
ACTIVE="$VPN_DIR/active.env"
APIKEY_FILE="/srv/docker/gluetun/auth/.apikey.txt"

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
    cp "$PRESET" "$ACTIVE"
    echo ">> Recréation de gluetun..."
    sudo docker compose up -d gluetun
    echo ">> Attente du tunnel (healthy)..."
    for i in $(seq 1 12); do
      h=$(sudo docker inspect --format '{{.State.Health.Status}}' gluetun 2>/dev/null || echo starting)
      echo "   health: $h"; [ "$h" = "healthy" ] && break; sleep 10
    done
    if [ "$(sudo docker inspect --format '{{.State.Health.Status}}' gluetun)" != "healthy" ]; then
      echo "!! gluetun n'est pas healthy. Vérifie : sudo docker logs gluetun"
      echo "!! (Mullvad expiré ? abonnement à renouveler.) VPN NON basculé proprement."
      exit 2
    fi
    echo ">> Relance des services derrière le VPN..."
    sudo docker compose up -d flaresolverr prowlarr sonarr radarr transmission
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
