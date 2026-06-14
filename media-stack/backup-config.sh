#!/usr/bin/env bash
#
# backup-config.sh — Sauvegarde CHIFFRÉE des configs vers Scaleway Object Storage.
# Périmètre : bases *arr (dump SQLite cohérent) + config.xml, base Jellyfin +
# configs plugins, et le stack (compose/.env/presets/scripts/systemd).
# Lancé chaque nuit par timer systemd (root). Notifie le résultat via ntfy.
#
set -uo pipefail

STACK_DIR="/srv/media-stack"
# shellcheck disable=SC1091
source "$STACK_DIR/.env"

REGION="${SCW_REGION:-fr-par}"
ENDPOINT="https://s3.${REGION}.scw.cloud"
export AWS_ACCESS_KEY_ID="$SCW_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$SCW_SECRET_KEY"
RETENTION=14
NTFY_URL="https://ntfy.sh/${NTFY_TOPIC}"

STAMP=$(date +%F_%H%M)
ARCHIVE="config-backup_${STAMP}.tar.gz.gpg"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

notify_fail() {
  curl -s -o /dev/null --max-time 15 \
    -H "Authorization: Bearer $NTFY_TOKEN" \
    -H "Title: ❌ Backup config ÉCHEC" -H "Priority: urgent" -H "Tags: rotating_light,floppy_disk" \
    -d "$1" "$NTFY_URL"
  echo "ERREUR: $1" >&2
  exit 1
}

mkdir -p "$WORK/dump/arr" "$WORK/dump/jellyfin"

# --- 1. Bases *arr : copie cohérente à chaud via sqlite3 .backup ---
for app in radarr sonarr prowlarr; do
  db="/var/lib/$app/$app.db"
  [ -f "$db" ] && { sqlite3 "$db" ".backup '$WORK/dump/arr/$app.db'" || notify_fail "Échec dump SQLite $app"; }
  cp -a "/var/lib/$app/config.xml" "$WORK/dump/arr/$app.config.xml" 2>/dev/null || true
done
cp -a /var/lib/transmission-daemon/settings.json "$WORK/dump/arr/transmission.settings.json" 2>/dev/null || true

# --- 2. Jellyfin : base bibliothèque + configs plugins + /etc ---
sqlite3 /var/lib/jellyfin/data/jellyfin.db ".backup '$WORK/dump/jellyfin/jellyfin.db'" 2>/dev/null \
  || notify_fail "Échec dump SQLite jellyfin"
cp -a /var/lib/jellyfin/data/glacier_items.json "$WORK/dump/jellyfin/" 2>/dev/null || true
cp -a /etc/jellyfin "$WORK/dump/jellyfin/etc-jellyfin" 2>/dev/null || true
mkdir -p "$WORK/dump/jellyfin/plugin-configs"
cp -a /var/lib/jellyfin/plugins/configurations/. "$WORK/dump/jellyfin/plugin-configs/" 2>/dev/null || true

# --- 3. Stack (configs + scripts), hors logs/node_modules/zip ---
tar czf "$WORK/dump/stack.tar.gz" -C / \
  --exclude='*.log' --exclude=node_modules --exclude='*.zip' --exclude='.git' \
  srv/media-stack 2>/dev/null || notify_fail "Échec archive du stack"

# --- 4. Archive unique + chiffrement GPG symétrique AES256 ---
tar czf "$WORK/payload.tar.gz" -C "$WORK/dump" . || notify_fail "Échec archive finale"
gpg --batch --yes --passphrase "$BACKUP_GPG_PASSPHRASE" \
    --symmetric --cipher-algo AES256 \
    -o "$WORK/$ARCHIVE" "$WORK/payload.tar.gz" || notify_fail "Échec chiffrement GPG"
SIZE=$(du -h "$WORK/$ARCHIVE" | cut -f1)

# --- 5. Upload Scaleway ---
aws s3 cp "$WORK/$ARCHIVE" "s3://$BACKUP_BUCKET/$ARCHIVE" \
    --endpoint-url "$ENDPOINT" --region "$REGION" >/dev/null 2>&1 \
    || notify_fail "Échec upload Scaleway"

# --- 6. Rétention : ne garder que les RETENTION plus récents ---
mapfile -t all < <(aws s3 ls "s3://$BACKUP_BUCKET/" --endpoint-url "$ENDPOINT" --region "$REGION" 2>/dev/null \
    | awk '{print $4}' | grep '^config-backup_' | sort)
count=${#all[@]}
if [ "$count" -gt "$RETENTION" ]; then
  for old in "${all[@]:0:$((count - RETENTION))}"; do
    aws s3 rm "s3://$BACKUP_BUCKET/$old" --endpoint-url "$ENDPOINT" --region "$REGION" >/dev/null 2>&1
  done
fi

# --- 7. Notif succès ---
curl -s -o /dev/null --max-time 15 \
  -H "Authorization: Bearer $NTFY_TOKEN" \
  -H "Title: 💾 Backup config OK" -H "Priority: low" -H "Tags: floppy_disk,white_check_mark" \
  -d "Sauvegarde ${STAMP} envoyée sur Scaleway (${SIZE}). Rétention : ${RETENTION} max." \
  "$NTFY_URL"
echo "OK: $ARCHIVE ($SIZE)"
exit 0
