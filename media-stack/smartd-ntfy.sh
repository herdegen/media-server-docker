#!/usr/bin/env bash
# Hook smartd -> ntfy : alerte si un disque signale un problème S.M.A.R.T.
# Appelé par smartd-runner (run-parts) avec les variables SMARTD_* dans l'env.
set -uo pipefail
# shellcheck disable=SC1091
source /srv/media-stack/.env
[ -n "${SMARTD_MESSAGE:-}" ] || exit 0
curl -s -o /dev/null --max-time 15 \
  -H "Authorization: Bearer $NTFY_TOKEN" \
  -H "Title: 💽 Alerte disque S.M.A.R.T." \
  -H "Priority: urgent" \
  -H "Tags: rotating_light,floppy_disk" \
  -d "${SMARTD_DEVICE:-disque} : ${SMARTD_MESSAGE}" \
  "https://ntfy.sh/${NTFY_TOPIC}"
