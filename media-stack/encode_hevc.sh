#!/bin/bash
# encode_hevc.sh — Réencodage des films incompatibles en H.265/HEVC
#
# Usage:
#   ./encode_hevc.sh            → encode le prochain film de la liste
#   ./encode_hevc.sh --all      → encode tous les films en séquence
#   ./encode_hevc.sh --dry-run  → affiche ce qui serait fait sans encoder
#   ./encode_hevc.sh --status   → affiche l'avancement
#
# Workflow :
#   1. Encode vers /mnt/media/movies/encode_tmp/<dossier>/
#   2. Tu vérifies le résultat
#   3. Lance replace_hevc.sh <dossier> pour remplacer l'original

FILMS_LIST="/srv/media-stack/films_a_reencoder.txt"
DONE_LIST="/srv/media-stack/encode_done.txt"
MOVIES_DIR="/mnt/media/movies/movies"
TMP_DIR="/mnt/media/movies/encode_tmp"
LOG_FILE="/srv/media-stack/encode.log"

MODE="next"
[ "$1" = "--all" ]     && MODE="all"
[ "$1" = "--dry-run" ] && MODE="dry"
[ "$1" = "--status" ]  && MODE="status"

touch "$DONE_LIST"
mkdir -p "$TMP_DIR"

# --- Extraire et trier les dossiers par taille (plus léger en premier) ---
build_queue() {
  grep -v "^#" "$FILMS_LIST" | grep -v "^$" | awk -F' \\| ' '{print $2}' | sort -u | while read -r folder; do
    path="$MOVIES_DIR/$folder"
    [ -d "$path" ] || continue
    grep -qxF "$folder" "$DONE_LIST" && continue
    size=$(du -sb "$path" 2>/dev/null | cut -f1)
    echo "$size $folder"
  done | sort -n | awk '{$1=""; print substr($0,2)}'
}

# --- Statut ---
if [ "$MODE" = "status" ]; then
  total=$(grep -v "^#" "$FILMS_LIST" | grep -v "^$" | awk -F' \\| ' '{print $2}' | sort -u | wc -l)
  done=$(wc -l < "$DONE_LIST")
  remaining=$((total - done))
  echo "=== Statut réencodage HEVC ==="
  echo "Total  : $total films"
  echo "Faits  : $done films"
  echo "Reste  : $remaining films"
  echo ""
  echo "Prochain :"
  build_queue | head -3 | while read -r f; do
    size=$(du -sh "$MOVIES_DIR/$f" 2>/dev/null | cut -f1)
    echo "  [$size] $f"
  done
  exit 0
fi

# --- Fonction d'encodage d'un film ---
encode_film() {
  local folder="$1"
  local src_dir="$MOVIES_DIR/$folder"
  local tmp_dir="$TMP_DIR/$folder"

  echo ""
  echo "======================================================"
  echo " Film   : $folder"
  echo " Source : $src_dir"
  echo " Dest   : $tmp_dir"
  echo " Début  : $(date '+%Y-%m-%d %H:%M:%S')"
  echo "======================================================"

  mkdir -p "$tmp_dir"

  # Copier les sous-titres externes
  find "$src_dir" -maxdepth 1 -type f \( -name "*.srt" -o -name "*.sub" -o -name "*.idx" -o -name "*.ass" \) | while read -r sub; do
    cp "$sub" "$tmp_dir/"
    echo "  [SUB] Copié : $(basename "$sub")"
  done

  # Encoder chaque fichier vidéo du dossier
  local ok=true
  find "$src_dir" -maxdepth 1 -type f \( -name "*.avi" -o -name "*.mkv" -o -name "*.mp4" -o -name "*.m4v" -o -name "*.mov" \) | sort | while read -r video; do
    local filename=$(basename "$video")
    local name_no_ext="${filename%.*}"
    local output="$tmp_dir/${name_no_ext}.mkv"
    local size_before=$(du -sh "$video" | cut -f1)

    echo ""
    echo "  [IN]  $filename ($size_before)"
    echo "  [OUT] ${name_no_ext}.mkv"

    if [ "$MODE" = "dry" ]; then
      echo "  [DRY] ffmpeg -i \"$video\" -c:v libx265 -crf 28 -preset slow -c:a copy -c:s copy -y \"$output\""
      continue
    fi

    ffmpeg -i "$video" \
      -c:v libx265 \
      -crf 28 \
      -preset slow \
      -c:a copy \
      -c:s copy \
      -movflags +faststart \
      -y "$output" \
      2>>"$LOG_FILE"

    if [ $? -eq 0 ]; then
      local size_after=$(du -sh "$output" | cut -f1)
      echo "  [OK]  $size_before → $size_after"
      echo "$(date '+%Y-%m-%d %H:%M:%S') OK $folder / $filename → $size_before → $size_after" >> "$LOG_FILE"
    else
      echo "  [ERR] Échec encodage — voir $LOG_FILE"
      echo "$(date '+%Y-%m-%d %H:%M:%S') ERR $folder / $filename" >> "$LOG_FILE"
      ok=false
    fi
  done

  if [ "$MODE" != "dry" ] && $ok; then
    echo "$folder" >> "$DONE_LIST"
    echo ""
    echo "  Terminé. Vérifie le résultat dans :"
    echo "  $tmp_dir"
    echo "  Puis lance : ./replace_hevc.sh \"$folder\""
  fi
}

# --- Main ---
queue=$(build_queue)

if [ -z "$queue" ]; then
  echo "Aucun film à encoder — tous sont faits !"
  exit 0
fi

if [ "$MODE" = "next" ] || [ "$MODE" = "dry" ]; then
  next=$(echo "$queue" | head -1)
  encode_film "$next"
elif [ "$MODE" = "all" ]; then
  echo "$queue" | while IFS= read -r folder; do
    encode_film "$folder"
  done
fi
