#!/usr/bin/env bash
#
# glacier-watch.sh — Surveille la base du plugin Jellyfin Glacier et envoie
# une notif ntfy aux changements d'état d'un film (upload terminé, film prêt…).
# Lancé par cron (root). Notifie uniquement sur TRANSITION d'état ; au 1er
# passage il ne fait qu'enregistrer l'état courant (aucune notif rétroactive).
#
set -uo pipefail

STACK_DIR="/srv/media-stack"
STATE_DIR="$STACK_DIR/alerts/glacier-state"
DB="/var/lib/jellyfin/data/glacier_items.json"

# shellcheck disable=SC1091
source "$STACK_DIR/.env"
NTFY_URL="https://ntfy.sh/${NTFY_TOPIC}"

mkdir -p "$STATE_DIR"
[ -f "$DB" ] || exit 0
command -v jq >/dev/null 2>&1 || { echo "jq requis"; exit 1; }

ntfy() {  # ntfy <titre> <message> <priorité> <tags>
  curl -s -o /dev/null --max-time 15 \
    -H "Authorization: Bearer $NTFY_TOKEN" \
    -H "Title: $1" -H "Priority: $3" -H "Tags: $4" \
    -d "$2" "$NTFY_URL"
}

human_size() {  # octets -> Go/Mo lisible
  awk -v b="$1" 'BEGIN{
    if (b>=1073741824) printf "%.1f Go", b/1073741824;
    else printf "%.0f Mo", b/1048576;
  }'
}

# Parcourt chaque film de la base : id <tab> status <tab> titre <tab> taille
while IFS=$'\t' read -r id status title size; do
  [ -z "$id" ] && continue
  f="$STATE_DIR/$id"
  prev=""
  [ -f "$f" ] && prev="$(cat "$f")"

  # Pas de changement -> rien
  [ "$status" = "$prev" ] && continue

  # 1er passage (aucun état connu) : on enregistre sans notifier
  if [ -n "$prev" ]; then
    case "$status" in
      0)  # OnGlacier : upload terminé
          ntfy "📦 Archivé sur Glacier" \
               "\"$title\" envoyé sur Glacier ($(human_size "$size")). Upload 100 % terminé." \
               default "package,arrow_up" ;;
      2)  ntfy "❄️ Restauration en cours" \
               "\"$title\" : Glacier dégèle le fichier, patiente…" \
               low hourglass ;;
      4)  ntfy "⬇️ Téléchargement" \
               "\"$title\" : dégel terminé, téléchargement depuis Glacier en cours…" \
               default arrow_down ;;
      5)  ntfy "🎬 Film prêt !" \
               "\"$title\" est récupéré et disponible dans Jellyfin." \
               high "clapper,white_check_mark" ;;
    esac
  fi

  echo "$status" > "$f"
done < <(jq -r '.[] | [(.JellyfinItemId), (.Status|tostring), (.Title), (.FileSizeBytes|tostring)] | @tsv' "$DB")
