#!/bin/bash
# replace_hevc.sh — Remplace l'original par le fichier encodé en HEVC
#
# Usage : ./replace_hevc.sh "<dossier_film>"
# Exemple : ./replace_hevc.sh "1984_(1953)"
#
# Ce script :
#   1. Déplace les anciens fichiers vidéo vers _backup/ (sécurité)
#   2. Déplace les fichiers encodés depuis encode_tmp/ vers le dossier original
#   3. Supprime le backup après confirmation

MOVIES_DIR="/mnt/media/movies/movies"
TMP_DIR="/mnt/media/movies/encode_tmp"
BACKUP_DIR="/mnt/media/movies/_backup_originals"
LOG_FILE="/srv/media-stack/encode.log"

if [ -z "$1" ]; then
  echo "Usage : $0 \"<dossier_film>\""
  exit 1
fi

FOLDER="$1"
SRC_DIR="$MOVIES_DIR/$FOLDER"
TMP_FOLDER="$TMP_DIR/$FOLDER"
BACKUP_FOLDER="$BACKUP_DIR/$FOLDER"

# Vérifications
if [ ! -d "$SRC_DIR" ]; then
  echo "Erreur : dossier source introuvable : $SRC_DIR"
  exit 1
fi
if [ ! -d "$TMP_FOLDER" ]; then
  echo "Erreur : dossier encodé introuvable : $TMP_FOLDER"
  exit 1
fi

echo "======================================================"
echo " Remplacement : $FOLDER"
echo "======================================================"

# 1. Sauvegarder les originaux
mkdir -p "$BACKUP_FOLDER"
find "$SRC_DIR" -maxdepth 1 -type f \( -name "*.avi" -o -name "*.mkv" -o -name "*.mp4" -o -name "*.m4v" \) | while read -r f; do
  mv "$f" "$BACKUP_FOLDER/"
  echo "  [BACKUP] $(basename "$f")"
done

# 2. Déplacer les fichiers encodés
find "$TMP_FOLDER" -maxdepth 1 -type f | while read -r f; do
  mv "$f" "$SRC_DIR/"
  echo "  [INSTALL] $(basename "$f")"
done

# 3. Nettoyer le dossier tmp
rmdir "$TMP_FOLDER" 2>/dev/null

echo ""
echo "  Remplacement effectué."
echo "  Originaux conservés dans : $BACKUP_FOLDER"
echo ""
echo "  Si tout est OK dans Jellyfin, supprime le backup avec :"
echo "  rm -rf \"$BACKUP_FOLDER\""
echo ""
echo "$(date '+%Y-%m-%d %H:%M:%S') REPLACED $FOLDER" >> "$LOG_FILE"
