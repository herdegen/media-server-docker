#!/usr/bin/env bash
#
# ntfy-fail.sh — Notifie sur ntfy qu'une unité systemd a échoué, avec la fin de
# son journal. Appelé par ntfy-fail@.service, lui-même déclenché par
# OnFailure=ntfy-fail@%n.service dans les drop-ins 10-hardening.conf.
# Usage : ntfy-fail.sh <unité>     (ex. backup-config.service)
#
# Pourquoi : nos scripts sortent désormais en erreur quand ils échouent ; sans
# ce relais, un échec ne se voit que dans `systemctl --failed`, que personne ne
# regarde. Protection = blocage OU alerte poussée, jamais un état à aller lire.
#
# Anti-spam : au plus une notif par unité et par heure (soularr-guard tourne
# chaque minute ; s'il échoue en boucle, une alerte suffit).
#
set -uo pipefail
unit="${1:?usage: ntfy-fail.sh <unité>}"
COOLDOWN=3600
STAMP_DIR=/run/ntfy-fail   # /run : remis à zéro au reboot, c'est voulu

# shellcheck disable=SC1091
source /srv/media-stack/.env || exit 1
[ -n "${NTFY_TOPIC:-}" ] || { echo "NTFY_TOPIC absent de .env" >&2; exit 1; }

mkdir -p "$STAMP_DIR"
stamp="$STAMP_DIR/${unit//\//_}"
now=$(date +%s)
if [ -f "$stamp" ] && [ $((now - $(cat "$stamp" 2>/dev/null || echo 0))) -lt "$COOLDOWN" ]; then
  echo "notif $unit déjà envoyée il y a moins de ${COOLDOWN}s : ignorée"
  exit 0
fi

# Journal de la DERNIÈRE exécution seulement (InvocationID), sinon on mélange
# avec les passages précédents réussis. Repli sur les 20 dernières lignes de l'unité.
inv=$(systemctl show -p InvocationID --value "$unit" 2>/dev/null)
if [ -n "$inv" ]; then
  logs=$(journalctl --no-pager -o cat -n 20 "_SYSTEMD_INVOCATION_ID=$inv" 2>/dev/null)
fi
[ -n "${logs:-}" ] || logs=$(journalctl --no-pager -o cat -n 20 -u "$unit" 2>/dev/null)
result=$(systemctl show -p Result --value "$unit" 2>/dev/null)

# ntfy limite le corps à 4 Ko : on garde la fin, la plus parlante.
body=$(printf '%s a échoué (%s) sur %s.\n\n%s' "$unit" "${result:-?}" "$(hostname)" "$logs" | tail -c 3800)

if curl -s -o /dev/null --max-time 15 -w '%{http_code}' \
     -H "Authorization: Bearer ${NTFY_TOKEN:-}" \
     -H "Title: ❌ $unit a échoué" -H "Priority: high" -H "Tags: rotating_light" \
     -d "$body" "https://ntfy.sh/${NTFY_TOPIC}" | grep -q '^2'; then
  echo "$now" > "$stamp"
else
  echo "envoi ntfy KO pour $unit" >&2
  exit 1
fi
