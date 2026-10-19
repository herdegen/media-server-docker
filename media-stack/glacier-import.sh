#!/bin/bash
# glacier-import.sh — archive directement sur Glacier des médias importés à la main.
#
# Usage : sudo ./glacier-import.sh "/mnt/media/series/Animaniacs (1993)" "/mnt/media/movies/movies/Film (2001)" ...
#
# Les dossiers doivent déjà être rangés dans la bibliothèque (nommage Jellyfin). Le script :
#   1. lance le scan de la médiathèque et attend que les items apparaissent ;
#   2. met en file d'archivage (plugin Glacier) chaque film/épisode situé sous ces chemins ;
#   3. attend la fin des uploads et vérifie le statut OnGlacier de chaque item ;
#   4. liste les vidéos que Jellyfin n'a pas reconnues (jamais archivées) et notifie via ntfy.
# Relançable sans risque : les items déjà sur Glacier sont ignorés.
set -uo pipefail

STACK_DIR=/srv/media-stack
# shellcheck disable=SC1091
source "$STACK_DIR/.env"
J=http://127.0.0.1:8096
TOKEN=$(sqlite3 /var/lib/jellyfin/data/jellyfin.db "select AccessToken from ApiKeys order by Id limit 1;")
AUTH="Authorization: MediaBrowser Token=\"$TOKEN\""

log() { echo "[$(date '+%F %T')] $*"; }
api() { curl -sf -H "$AUTH" "$@"; }
norm() { tr -d '-' | tr 'A-Z' 'a-z'; }   # Jellyfin renvoie les Id sans tirets, le plugin avec

notify() {
  [ -n "${NTFY_TOPIC:-}" ] || return 0
  curl -s -o /dev/null --max-time 15 -H "Authorization: Bearer ${NTFY_TOKEN:-}" \
    -H "Title: $1" -H "Tags: ${3:-ice_cube}" -d "$2" "https://ntfy.sh/${NTFY_TOPIC}"
}

[ $# -ge 1 ] || { echo "usage: $0 <chemin bibliothèque>..." >&2; exit 1; }
for p in "$@"; do [ -d "$p" ] || { echo "dossier introuvable : $p" >&2; exit 1; }; done

# 0. Le plugin tourne sous l'utilisateur jellyfin (membre du groupe debian) : il doit pouvoir
# écrire dans les dossiers pour poser le placeholder. Sinon l'upload réussit mais le fichier
# local reste, et l'item repasse en « Available » (vécu le 2026-10-16).
for p in "$@"; do
  find "$p" -type d -exec chmod 2775 {} + ; find "$p" -type f -exec chmod g+rw {} + ; chgrp -R debian "$p"
done

# 1. Scan : on lance la tâche planifiée « Analyser la médiathèque » si elle ne tourne pas déjà.
# - Le rafraîchissement ciblé d'une bibliothèque (/Items/{id}/Refresh) ne crée PAS les nouveaux
#   dossiers de films (constaté le 2026-10-16, ok pour les séries seulement).
# - Ne jamais utiliser /Library/Refresh : il annule le scan en cours, qui reste bloqué en
#   « Cancelling » à 95 % jusqu'au redémarrage de Jellyfin (2026-10-09, 2026-10-16).
# Les nouveaux items apparaissent bien avant la fin du scan : on n'attend pas qu'il se termine.
TASK=$(api "$J/ScheduledTasks" | jq -r '.[]|select(.Key=="RefreshLibrary")|"\(.Id) \(.State)"')
if [ "${TASK#* }" = "Idle" ]; then
  api -X POST "$J/ScheduledTasks/Running/${TASK%% *}" >/dev/null || { log "ERREUR : scan refusé"; exit 1; }
  log "Scan de la médiathèque lancé"
else
  # Un scan figé (toujours à 95,424 % : constaté 3 fois en octobre 2026, dans la bibliothèque Musique)
  # ne verra jamais les nouveaux dossiers : inutile d'attendre, il faut redémarrer Jellyfin.
  p1=$(api "$J/ScheduledTasks" | jq -r '.[]|select(.Key=="RefreshLibrary")|.CurrentProgressPercentage // 0')
  sleep 120
  p2=$(api "$J/ScheduledTasks" | jq -r '.[]|select(.Key=="RefreshLibrary")|.CurrentProgressPercentage // 0')
  if [ "$p1" = "$p2" ]; then
    log "ERREUR : le scan de la médiathèque est figé à ${p2} % — redémarrer Jellyfin (systemctl restart jellyfin) puis relancer"
    notify "Import Glacier bloqué" "Scan Jellyfin figé à ${p2} % : redémarrer Jellyfin puis relancer glacier-import.sh" warning
    exit 3
  fi
  log "Scan de la médiathèque déjà en cours (${p2} %), on attend les items"
fi

VIDEO_FIND=(-type f -size +20M \( -iname '*.mkv' -o -iname '*.mp4' -o -iname '*.avi' -o -iname '*.mpg' -o -iname '*.mpeg'
            -o -iname '*.flv' -o -iname '*.m4v' -o -iname '*.wmv' -o -iname '*.vob' -o -iname '*.ts' \))
on_disk=$(find "$@" "${VIDEO_FIND[@]}" | wc -l)

# 2. Items Jellyfin situés sous les chemins demandés. On attend qu'ils soient tous
# apparus, ou que leur nombre (non nul) ne bouge plus pendant 5 min (fichiers non reconnus).
get_items() {
  api "$J/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Fields=Path" | jq -c '
    [.Items[] as $i | select($ARGS.positional | any(. as $p | ($i.Path // "") | startswith($p + "/")))
     | {id: ($i.Id | gsub("-";"") | ascii_downcase), name: $i.Name, path: $i.Path}]' --args "$@"
}
prev=-1; stable=0; start=$(date +%s)
while :; do
  sleep 30
  ITEMS=$(get_items "$@"); n=$(jq length <<<"$ITEMS")
  [ "$n" -ge "$on_disk" ] && break
  if [ "$n" -eq "$prev" ]; then stable=$((stable+1)); else stable=0; fi
  [ "$n" -gt 0 ] && [ "$stable" -ge 10 ] && break   # 0 item = scan pas encore arrivé : on attend
  [ $(( $(date +%s) - start )) -gt 2700 ] && { log "Délai de scan dépassé (45 min)"; break; }
  prev=$n
done
log "$n items trouvés dans Jellyfin sur $on_disk vidéos sur disque"

DONE=$(api "$J/Glacier/items" | jq -r '.[]|select(.Status=="OnGlacier")|.JellyfinItemId' | norm)
queued=0
while read -r id; do
  grep -qx "$id" <<<"$DONE" && continue
  api -X POST "$J/Glacier/items/$id/archive" >/dev/null && queued=$((queued+1)) \
    || log "ERREUR : mise en file refusée pour $(jq -r --arg i "$id" '.[]|select(.id==$i)|.path' <<<"$ITEMS")"
done < <(jq -r '.[].id' <<<"$ITEMS")
log "$queued items mis en file d'archivage"

# 3. Attente de la fin des uploads
while [ "$(api "$J/Glacier/queue" | jq length)" -gt 0 ]; do
  sleep 60
  log "… $(api "$J/Glacier/queue" | jq length) en file / en cours"
done

ONG=$(api "$J/Glacier/items" | jq -r '.[]|select(.Status=="OnGlacier")|.JellyfinItemId' | norm)
ok=0; ko=()
while IFS=$'\t' read -r id path; do
  if grep -qx "$id" <<<"$ONG"; then ok=$((ok+1)); else ko+=("$path"); fi
done < <(jq -r '.[]|[.id,.path]|@tsv' <<<"$ITEMS")

# 4. Vidéos présentes sur disque mais inconnues de Jellyfin
mapfile -t unknown < <(find "$@" "${VIDEO_FIND[@]}" | grep -vxF -f <(jq -r '.[].path' <<<"$ITEMS"))

log "Bilan : $ok sur Glacier, ${#ko[@]} en échec, ${#unknown[@]} vidéos non reconnues par Jellyfin"
for p in "${ko[@]}"; do log "  ÉCHEC : $p"; done
for p in "${unknown[@]}"; do log "  NON RECONNU : $p"; done

msg="$ok items archivés sur Glacier."
[ ${#ko[@]} -gt 0 ] && msg+=" ${#ko[@]} en échec."
[ ${#unknown[@]} -gt 0 ] && msg+=" ${#unknown[@]} vidéos non reconnues par Jellyfin (non archivées)."
if [ ${#ko[@]} -eq 0 ] && [ ${#unknown[@]} -eq 0 ]; then
  notify "Import Glacier terminé" "$msg"
else
  notify "Import Glacier terminé avec erreurs" "$msg" warning; exit 2
fi
