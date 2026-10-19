#!/usr/bin/env bash
#
# backup-config.sh — Sauvegarde CHIFFRÉE des configs vers Scaleway Object Storage.
# Périmètre : bases *arr / Jellyseerr / Bazarr (dump SQLite cohérent) + leurs
# configs, base Jellyfin + configs plugins, configs slskd/soularr/romarr, le hook
# Transmission, la partie système qui n'est nulle part ailleurs (nftables,
# fail2ban, nos unités systemd, auth gluetun) et le stack
# (compose/.env/presets/scripts/systemd).
# Lancé chaque nuit par timer systemd (root). Notifie le résultat via ntfy.
#
# Sortie NON NULLE en cas d'échec : systemd marque alors l'unité en échec
# (visible dans `systemctl --failed` et relayé par ntfy-fail@.service).
#
# L'archive est VÉRIFIÉE avant envoi (déchiffrement + listing tar) puis après
# envoi (taille côté Scaleway == taille locale) : une sauvegarde qu'on n'a jamais
# su relire ne compte pas comme une sauvegarde.
#
set -uo pipefail
umask 077   # les dumps contiennent des clés d'API : jamais lisibles par d'autres users

STACK_DIR="/srv/media-stack"
# shellcheck disable=SC1091
source "$STACK_DIR/.env" || { echo "ERREUR: lecture $STACK_DIR/.env impossible" >&2; exit 1; }

REGION="${SCW_REGION:-fr-par}"
ENDPOINT="https://s3.${REGION}.scw.cloud"
RETENTION=14
NTFY_URL="https://ntfy.sh/${NTFY_TOPIC:-}"

notify_fail() {
  curl -s -o /dev/null --max-time 15 \
    -H "Authorization: Bearer ${NTFY_TOKEN:-}" \
    -H "Title: ❌ Backup config ÉCHEC" -H "Priority: urgent" -H "Tags: rotating_light,floppy_disk" \
    -d "$1" "$NTFY_URL"
  echo "ERREUR: $1" >&2
  exit 1
}

# Variables indispensables : mieux vaut un échec explicite qu'une archive
# chiffrée avec une passphrase vide ou un upload vers un bucket "".
for v in SCW_ACCESS_KEY SCW_SECRET_KEY BACKUP_BUCKET BACKUP_GPG_PASSPHRASE NTFY_TOPIC; do
  [ -n "${!v:-}" ] || notify_fail "Variable $v absente de .env"
done
export AWS_ACCESS_KEY_ID="$SCW_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$SCW_SECRET_KEY"

STAMP=$(date +%F_%H%M)
ARCHIVE="config-backup_${STAMP}.tar.gz.gpg"
# /var/tmp (disque) plutôt que /tmp (tmpfs = RAM) : dumps + archive dépassent 1 Go.
WORK=$(mktemp -d /var/tmp/backup-config.XXXXXX) || notify_fail "mktemp impossible"
[ -d "$WORK" ] || notify_fail "mktemp n'a pas créé de dossier"
trap 'rm -rf "$WORK"' EXIT
trap 'notify_fail "Interrompu par un signal"' INT TERM

# Avertissements non bloquants (source absente...) : remontés dans la notif de succès.
WARN=()
warn() { WARN+=("$1"); echo "AVERTISSEMENT: $1" >&2; }

# Dump SQLite cohérent à chaud (.backup lit une image transactionnelle, WAL
# compris) puis quick_check : un dump corrompu détecté à la restauration, c'est
# trop tard. Base absente = app pas installée -> simple avertissement.
dump_db() {  # $1 = base source, $2 = destination, $3 = libellé
  if [ ! -f "$1" ]; then warn "base $3 absente ($1)"; return 0; fi
  sqlite3 "$1" ".backup '$2'" || notify_fail "Échec dump SQLite $3"
  [ "$(sqlite3 "$2" 'PRAGMA quick_check;' 2>&1)" = ok ] || notify_fail "Dump SQLite $3 corrompu (quick_check)"
}
# Copie d'un fichier/dossier de config. Absent = avertissement, pas d'échec.
copy() {  # $1 = source, $2 = destination
  if [ ! -e "$1" ]; then warn "absent : $1"; return 0; fi
  cp -a "$1" "$2" || notify_fail "Échec copie $1"
}

mkdir -p "$WORK/dump/arr" "$WORK/dump/jellyfin" "$WORK/dump/system" || notify_fail "mkdir $WORK/dump"

# --- 1. Bases *arr : copie cohérente à chaud via sqlite3 .backup ---
for app in radarr sonarr prowlarr lidarr; do
  dump_db "/var/lib/$app/$app.db" "$WORK/dump/arr/$app.db" "$app"
  copy "/var/lib/$app/config.xml" "$WORK/dump/arr/$app.config.xml"
done
# Jellyseerr : base des demandes + settings.json (clés Jellyfin/*arr, users).
dump_db /var/lib/jellyseerr/db/db.sqlite3 "$WORK/dump/arr/jellyseerr.db.sqlite3" jellyseerr
copy /var/lib/jellyseerr/settings.json "$WORK/dump/arr/jellyseerr.settings.json"
# Bazarr : base (historique, profils de langue) + config.yaml. PAS backup/ (ses
# propres zips hebdo, redondants) ni les logs.
dump_db /var/lib/bazarr/db/bazarr.db "$WORK/dump/arr/bazarr.db" bazarr
copy /var/lib/bazarr/config/config.yaml "$WORK/dump/arr/bazarr.config.yaml"
copy /var/lib/transmission-daemon/settings.json "$WORK/dump/arr/transmission.settings.json"
# Hook anti-malware (couche 2) : vit hors du stack, perdu sinon.
copy /var/lib/transmission-daemon/malware-guard-hook.sh "$WORK/dump/arr/transmission.malware-guard-hook.sh"
copy /var/lib/romarr "$WORK/dump/arr/romarr"
# slskd : config + identifiants Soulseek. PAS data/ (bases de recherche/transferts,
# reconstructibles) ni downloads/incomplete.
copy /var/lib/slskd/slskd.yml "$WORK/dump/arr/slskd.yml"
copy /var/lib/slskd/credentials.txt "$WORK/dump/arr/slskd.credentials.txt"
# soularr : la liste blanche est ce qui empêche soularr-guard de tout désurveiller.
copy /var/lib/soularr/config.ini "$WORK/dump/arr/soularr.config.ini"
copy /var/lib/soularr/approved_album_ids.txt "$WORK/dump/arr/soularr.approved_album_ids.txt"
copy /var/lib/soularr/failed_imports.json "$WORK/dump/arr/soularr.failed_imports.json"

# --- 2. Jellyfin : base bibliothèque + configs plugins + /etc ---
[ -f /var/lib/jellyfin/data/jellyfin.db ] || notify_fail "jellyfin.db introuvable"
dump_db /var/lib/jellyfin/data/jellyfin.db "$WORK/dump/jellyfin/jellyfin.db" jellyfin
copy /var/lib/jellyfin/data/glacier_items.json "$WORK/dump/jellyfin/"
copy /etc/jellyfin "$WORK/dump/jellyfin/etc-jellyfin"
mkdir -p "$WORK/dump/jellyfin/plugin-configs"
cp -a /var/lib/jellyfin/plugins/configurations/. "$WORK/dump/jellyfin/plugin-configs/" \
  || notify_fail "Échec copie configs plugins Jellyfin"
# Moonbase : garder saves/ et réglages, pas les caches reconstructibles (jaquettes, cœurs EmulatorJS ~290 Mo)
rm -rf "$WORK/dump/jellyfin/plugin-configs/Moonfin/"{game_thumbs,studio_logos,gamemeta,emulatorjs} \
       "$WORK/dump/jellyfin/plugin-configs/Moonfin/"*_cache.json

# --- 3. Système : ce qui ne vit ni dans le stack ni dans un paquet ---
copy /etc/nftables-mediaserver.nft "$WORK/dump/system/"
mkdir -p "$WORK/dump/system/fail2ban/filter.d"
copy /etc/fail2ban/jail.local "$WORK/dump/system/fail2ban/"
copy /etc/fail2ban/jail.d "$WORK/dump/system/fail2ban/jail.d"
# filter.d : seulement nos filtres maison (le reste vient du paquet fail2ban).
copy /etc/fail2ban/filter.d/jellyfin.conf "$WORK/dump/system/fail2ban/filter.d/"
shopt -s nullglob
for f in /etc/fail2ban/filter.d/*.local; do copy "$f" "$WORK/dump/system/fail2ban/filter.d/"; done
# Nos unités systemd (+ drop-ins). status-collect n'existe pas encore : le glob
# vide est simplement ignoré (nullglob).
mkdir -p "$WORK/dump/system/systemd"
for u in /etc/systemd/system/{malware-guard,media-alert,backup-config,glacier-watch,recyclarr-sync,soularr-guard,status-collect,mediaserver-firewall,ntfy-fail@,tmm-start,tmm-stop}.* \
         /etc/systemd/system/jellyfin.service.d; do
  copy "$u" "$WORK/dump/system/systemd/"
done
shopt -u nullglob
# Clé API du control server gluetun (lue par vpn-switch.sh / vpn-control).
[ -d /srv/docker/gluetun/auth ] && copy /srv/docker/gluetun/auth "$WORK/dump/system/gluetun-auth"

# --- 4. Stack (configs + scripts), hors logs/node_modules/zip/caches ---
# recyclarr/resources = clones git des guides TRaSH (~80 Mo, re-téléchargés au sync).
# archive/ = vieux scripts/logs HEVC archivés, sans valeur de restauration.
tar czf "$WORK/dump/stack.tar.gz" -C / \
  --exclude='*.log' --exclude=node_modules --exclude='*.zip' --exclude='.git' \
  --exclude='srv/media-stack/recyclarr/resources' --exclude='srv/media-stack/recyclarr/logs' \
  --exclude='srv/media-stack/archive' \
  srv/media-stack 2>/dev/null || notify_fail "Échec archive du stack"

# --- 5. Archive unique + chiffrement GPG symétrique AES256 ---
# Passphrase via le fd 3 (here-string) et JAMAIS en argument : un argument est
# lisible par tout utilisateur local dans /proc/<pid>/cmdline pendant le chiffrement.
tar czf "$WORK/payload.tar.gz" -C "$WORK/dump" . || notify_fail "Échec archive finale"
gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
    --symmetric --cipher-algo AES256 \
    -o "$WORK/$ARCHIVE" "$WORK/payload.tar.gz" 3<<<"$BACKUP_GPG_PASSPHRASE" \
  || notify_fail "Échec chiffrement GPG"
rm -f "$WORK/payload.tar.gz"   # libère ~1 Go avant la vérification

# --- 6. Vérification AVANT envoi : déchiffrable avec la passphrase de .env et
# archive tar lisible jusqu'au bout, avec les pièces maîtresses présentes. ---
gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 \
    -d "$WORK/$ARCHIVE" 3<<<"$BACKUP_GPG_PASSPHRASE" 2>/dev/null \
  | tar tzf - > "$WORK/listing.txt" \
  || notify_fail "Archive ${ARCHIVE} illisible (déchiffrement ou tar KO) : NON envoyée"
for must in ./jellyfin/jellyfin.db ./stack.tar.gz ./arr/radarr.db ./arr/sonarr.db; do
  grep -qxF "$must" "$WORK/listing.txt" || notify_fail "Archive ${ARCHIVE} incomplète ($must manquant) : NON envoyée"
done
LOCAL_BYTES=$(stat -c %s "$WORK/$ARCHIVE") || notify_fail "stat de l'archive impossible"
SIZE=$(du -h "$WORK/$ARCHIVE" | cut -f1)

# --- 7. Upload Scaleway + contrôle de la taille côté serveur ---
aws s3 cp "$WORK/$ARCHIVE" "s3://$BACKUP_BUCKET/$ARCHIVE" \
    --endpoint-url "$ENDPOINT" --region "$REGION" >/dev/null 2>&1 \
    || notify_fail "Échec upload Scaleway"
REMOTE_BYTES=$(aws s3api head-object --bucket "$BACKUP_BUCKET" --key "$ARCHIVE" \
    --endpoint-url "$ENDPOINT" --region "$REGION" --query ContentLength --output text 2>/dev/null)
if [ "$REMOTE_BYTES" != "$LOCAL_BYTES" ]; then
  # On retire l'objet douteux : sinon il compterait dans la rétention et
  # pousserait dehors une archive saine.
  aws s3 rm "s3://$BACKUP_BUCKET/$ARCHIVE" --endpoint-url "$ENDPOINT" --region "$REGION" >/dev/null 2>&1
  notify_fail "Upload ${ARCHIVE} incohérent : Scaleway=${REMOTE_BYTES:-?} o, local=${LOCAL_BYTES} o (objet retiré)"
fi

# --- 8. Rétention : ne garder que les RETENTION plus récents ---
# Seulement maintenant : on ne purge jamais l'ancien tant que le nouveau n'est
# pas vérifié en ligne.
mapfile -t all < <(aws s3 ls "s3://$BACKUP_BUCKET/" --endpoint-url "$ENDPOINT" --region "$REGION" 2>/dev/null \
    | awk '{print $4}' | grep '^config-backup_' | sort)
count=${#all[@]}
if [ "$count" -gt "$RETENTION" ]; then
  for old in "${all[@]:0:$((count - RETENTION))}"; do
    aws s3 rm "s3://$BACKUP_BUCKET/$old" --endpoint-url "$ENDPOINT" --region "$REGION" >/dev/null 2>&1 \
      || warn "rétention : suppression de $old échouée"
  done
fi

# --- 9. Notif succès (avec les avertissements éventuels) ---
msg="Sauvegarde ${STAMP} vérifiée et envoyée sur Scaleway (${SIZE}). Rétention : ${RETENTION} max."
prio=low
if [ "${#WARN[@]}" -gt 0 ]; then
  msg+=$'\n'"Avertissements : $(printf '%s ; ' "${WARN[@]}")"
  prio=default
fi
curl -s -o /dev/null --max-time 15 \
  -H "Authorization: Bearer $NTFY_TOKEN" \
  -H "Title: 💾 Backup config OK" -H "Priority: $prio" -H "Tags: floppy_disk,white_check_mark" \
  -d "$msg" "$NTFY_URL"
echo "OK: $ARCHIVE ($SIZE, ${LOCAL_BYTES} o)"
exit 0
