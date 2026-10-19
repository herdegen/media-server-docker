#!/bin/bash
# ovh-stock-watch.sh — Prévient (ntfy) quand un serveur Kimsufi visé revient en stock en France.
#
# Cible (décision 2026-10-15, cf. mémoire migration-serveur-stockage) :
#   - KS-5    (24sk50-v1)     en 3×4 To            → ~7,3 To RAID5, 26,99 € HT
#   - KS-STOR (24skstor01-v1) en 4×4 To ou 4×6 To  → ~12 To RAID5, 23,99 € HT
# Datacentres : gra, rbx, sbg. API publique OVH, sans authentification.
#
# Notifie uniquement sur changement d'état (rupture -> en stock, et retour en rupture).
# Une panne passagère de l'API est ignorée ; au-delà de 12 échecs d'affilée (~3 h),
# sortie en erreur -> OnFailure=ntfy-fail prévient que la surveillance est cassée.
#
# Usage : ovh-stock-watch.sh [--dry-run]   (--dry-run : affiche l'état sans notifier)

set -u

STACK_DIR="/srv/media-stack"
STATE_DIR="$STACK_DIR/alerts/state"
API="https://eu.api.ovh.com/v1/dedicated/server/datacenter/availabilities"
DCS_REGEX='^(gra|rbx|sbg)$'
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# --- Cibles : clé | planCode | regex sur la config (fqn) | libellé | page de commande ---
TARGETS=(
  "ks5-3x4tb|24sk50-v1|softraid-3x4000sa|KS-5 3×4 To|https://www.kimsufi.com/fr/ks/ks-5/"
  "ksstor|24skstor01-v1|4x[46]000sa|KS-STOR 4×4/6 To|https://www.kimsufi.com/fr/ks/ks-stor/"
)

# --- Secrets ntfy (topic + token), hors git ---
# shellcheck disable=SC1091
source "$STACK_DIR/.env"
NTFY_URL="https://ntfy.sh/${NTFY_TOPIC}"

mkdir -p "$STATE_DIR"

notify() {  # notify <titre> <message> <priorité> <tags> [url clic]
  [ "$DRY" = 1 ] && { echo "[DRY] notif: $1 — $2"; return 0; }
  curl -s -o /dev/null --max-time 15 \
    -H "Authorization: Bearer $NTFY_TOKEN" \
    -H "Title: $1" -H "Priority: $3" -H "Tags: $4" \
    ${5:+-H "Click: $5"} \
    -d "$2" "$NTFY_URL"
}

fail_file="$STATE_DIR/ovh-stock-api-failures"
api_failed=0

for t in "${TARGETS[@]}"; do
  IFS='|' read -r key plan cfg label url <<<"$t"

  json=$(curl -sf --max-time 30 "$API?planCode=$plan") || { api_failed=1; continue; }
  # Configs/DC en stock = tout sauf "unavailable" et "unknown" (ex. "1H-low", "24H", "72H").
  found=$(jq -r --arg cfg "$cfg" --arg dcs "$DCS_REGEX" '
      .[] | select(.fqn | test($cfg)) as $s
      | $s.datacenters[]
      | select((.datacenter | test($dcs)) and (.availability != "unavailable") and (.availability != "unknown"))
      | "\($s.fqn | sub("^[^.]+\\."; "")) @ \(.datacenter) (\(.availability))"' <<<"$json" 2>/dev/null) \
    || { api_failed=1; continue; }

  state="out"; [ -n "$found" ] && state="in"
  prev="out"; [ -f "$STATE_DIR/ovh-stock-$key" ] && prev=$(cat "$STATE_DIR/ovh-stock-$key")
  echo "$label : $state${found:+ — $(tr '\n' ';' <<<"$found")}"

  [ "$state" = "$prev" ] && continue
  [ "$DRY" = 0 ] && echo "$state" > "$STATE_DIR/ovh-stock-$key"
  if [ "$state" = "in" ]; then
    notify "🛒 $label en stock !" "$found
Commander vite, le stock part en quelques heures." high "shopping_cart" "$url"
  else
    notify "$label de nouveau en rupture" "Plus aucune config visée en stock en France." low "hourglass"
  fi
done

# --- Santé de la surveillance elle-même ---
if [ "$api_failed" = 1 ]; then
  n=$(( $(cat "$fail_file" 2>/dev/null || echo 0) + 1 ))
  [ "$DRY" = 0 ] && echo "$n" > "$fail_file"
  echo "API OVH injoignable ou réponse illisible ($n échec(s) d'affilée)" >&2
  [ "$n" -ge 12 ] && exit 1
else
  [ "$DRY" = 0 ] && rm -f "$fail_file"
fi
exit 0
