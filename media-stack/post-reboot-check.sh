#!/usr/bin/env bash
# post-reboot-check.sh — Vérifie que tout est revenu après un reboot et relance ce qui manque.
# Usage : /srv/media-stack/post-reboot-check.sh
#
# Relance CIBLÉE uniquement (docker start conteneur par conteneur) : plus de
# "docker compose up -d" global, qui pouvait recréer gluetun (si son bloc avait
# changé depuis le dernier up) et laisser tous les services du netns VPN
# accrochés à un netns mort.
set -uo pipefail
cd /srv/media-stack || { echo "cd /srv/media-stack impossible" >&2; exit 1; }
ok(){ printf '  \033[32mOK\033[0m   %s\n' "$*"; }
ko(){ printf '  \033[31mKO\033[0m   %s\n' "$*"; }
fix(){ printf '  \033[33mFIX\033[0m  %s\n' "$*"; }

MDSTAT="${MDSTAT:-/proc/mdstat}"   # surchargeable pour tester sur un faux mdstat

# Conteneurs hors compose dont l'ABSENCE doit être signalée (un conteneur
# supprimé n'apparaît plus dans "docker ps -a", il faut donc les nommer).
EXTRA_CONTAINERS="rcette-db memorylane_app memorylane_nginx memorylane_postgres memorylane_redis memorylane_horizon memorylane_scheduler memorylane_meilisearch"
# Arrêtés volontairement hors des heures prévues : ne jamais les relancer ici.
#  - tinymediamanager : fenêtre 02h–08h pilotée par tmm-start/tmm-stop.timer
SKIP_RE='^(tinymediamanager)$'
# Peuvent être arrêtés VOLONTAIREMENT par un garde-fou : signalés, pas relancés.
#  - soularr : stoppé par soularr-guard.sh (liste blanche cassée, retrait KO) ;
#    le relancer à l'aveugle annulerait la protection.
NO_AUTOSTART_RE='^(soularr)$'

state(){ sudo docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || echo absent; }

echo "== Services systemd (système)"
for u in docker jellyfin fail2ban rcette-backend rcette-bo rcette-foyer; do
  if systemctl is-active -q "$u"; then ok "$u"; else ko "$u"; fix "sudo systemctl start $u"; sudo systemctl start "$u"; fi
done

echo "== Sessions Claude Remote Control (services utilisateur)"
for u in claude-rc-mcp claude-rc-media-stack claude-rc-memorylane claude-rc-rcette; do
  if systemctl --user is-active -q "$u"; then ok "$u"; else ko "$u"; fix "systemctl --user start $u"; systemctl --user start "$u"; fi
done

echo "== Conteneurs Docker"
# Liste attendue DÉRIVÉE, pour ne plus oublier les services ajoutés après coup
# (slskd, soularr, ops-console manquaient) :
#  - tous les services du compose (service -> container_name),
#  - tous les conteneurs existants avec restart unless-stopped/always (autres projets),
#  - EXTRA_CONTAINERS (pour détecter ceux qui auraient disparu).
compose_json=$(sudo docker compose config --format json 2>/dev/null)
declare -A SVC_OF=()     # container_name -> service compose
NETNS=()                 # services en network_mode: service:gluetun
while IFS=$'\t' read -r svc cname nm; do
  [ -n "$svc" ] || continue
  SVC_OF[$cname]=$svc
  [ "$nm" = "service:gluetun" ] && NETNS+=("$svc")
done < <(jq -r '.services | to_entries[] | [.key, (.value.container_name // .key), (.value.network_mode // "")] | @tsv' <<<"$compose_json" 2>/dev/null)
[ "${#SVC_OF[@]}" -gt 0 ] || ko "docker compose config illisible : seuls les conteneurs existants sont vérifiés"

mapfile -t EXPECTED < <(
  { printf '%s\n' "${!SVC_OF[@]}"
    # shellcheck disable=SC2086
    printf '%s\n' $EXTRA_CONTAINERS
    sudo docker ps -aq | xargs -r sudo docker inspect -f '{{.Name}} {{.HostConfig.RestartPolicy.Name}}' \
      | awk '$2=="unless-stopped" || $2=="always" {sub("^/","",$1); print $1}'
  } | grep -vE "$SKIP_RE" | grep -v '^$' | sort -u)

# 1) gluetun d'abord : tout le netns VPN en dépend.
if [ -n "${SVC_OF[gluetun]:-}" ]; then
  st=$(state gluetun)
  case "$st" in
    running) ;;
    absent) fix "gluetun absent : sudo docker compose up -d --no-deps gluetun"; sudo docker compose up -d --no-deps gluetun ;;
    *)      fix "sudo docker start gluetun ($st)"; sudo docker start gluetun >/dev/null ;;
  esac
fi
h=""
for _ in $(seq 1 24); do h=$(sudo docker inspect -f '{{.State.Health.Status}}' gluetun 2>/dev/null); [ "$h" = healthy ] && break; sleep 5; done

# 2) gluetun recréé (nouvel ID) ? Les services du netns pointent alors vers
#    "container:<ancien id>" : un docker start échouerait, il faut les recréer.
gid=$(sudo docker inspect -f '{{.Id}}' gluetun 2>/dev/null)
STALE_RUN=(); STALE_STOP=()
for svc in "${NETNS[@]}"; do
  c=""; for k in "${!SVC_OF[@]}"; do [ "${SVC_OF[$k]}" = "$svc" ] && c=$k; done
  nm=$(sudo docker inspect -f '{{.HostConfig.NetworkMode}}' "$c" 2>/dev/null) || continue
  [ -n "$gid" ] && [ "$nm" != "container:$gid" ] || continue
  # Un service arrêté volontairement (soularr) est recréé SANS être démarré.
  if [[ "$c" =~ $NO_AUTOSTART_RE ]] && [ "$(state "$c")" != running ]; then STALE_STOP+=("$svc"); else STALE_RUN+=("$svc"); fi
done
if [ "${#STALE_RUN[@]}" -gt 0 ]; then
  fix "gluetun recréé -> recréation du netns VPN : ${STALE_RUN[*]}"
  sudo docker compose up -d --force-recreate --no-deps "${STALE_RUN[@]}"
fi
if [ "${#STALE_STOP[@]}" -gt 0 ]; then
  fix "gluetun recréé -> recréés sans démarrage (arrêt volontaire) : ${STALE_STOP[*]}"
  sudo docker compose up --no-start --force-recreate --no-deps "${STALE_STOP[@]}"
fi

# 3) Relance ciblée de ce qui est arrêté, puis bilan.
for c in "${EXPECTED[@]}"; do
  st=$(state "$c")
  if [ "$st" = running ]; then ok "$c"; continue; fi
  if [[ "$c" =~ $NO_AUTOSTART_RE ]]; then
    ko "$c ($st) — peut-être stoppé par un garde-fou, NON relancé : voir alerts/soularr-guard.log puis sudo docker start $c"
    continue
  fi
  if [ "$st" = absent ]; then
    if [ -n "${SVC_OF[$c]:-}" ]; then
      fix "$c absent : sudo docker compose up -d --no-deps ${SVC_OF[$c]}"; sudo docker compose up -d --no-deps "${SVC_OF[$c]}"
    else
      ko "$c absent (hors compose de ce stack : à recréer depuis son projet)"; continue
    fi
  else
    fix "sudo docker start $c ($st)"; sudo docker start "$c" >/dev/null
  fi
  sleep 2
  st=$(state "$c"); [ "$st" = running ] && ok "$c (relancé)" || ko "$c ($st) — sudo docker logs $c"
done

echo "== VPN (gluetun)"
if [ "$h" = healthy ]; then ok "gluetun healthy"; else ko "gluetun ${h:-absent} — voir : sudo docker logs gluetun"; fi
vpn=$(sudo docker exec transmission curl -s --max-time 10 https://api.ipify.org 2>/dev/null); host=$(curl -s --max-time 10 https://api.ipify.org)
if [ -n "$vpn" ] && [ "$vpn" != "$host" ]; then ok "IP de sortie VPN $vpn (≠ hôte $host)"; else ko "IP VPN '$vpn' vs hôte '$host' — fuite ou VPN down"; fi

echo "== Jellyfin"
v=$(curl -s --max-time 10 http://127.0.0.1:8096/System/Info/Public | jq -r .Version 2>/dev/null)
[ -n "$v" ] && ok "Jellyfin $v répond" || ko "Jellyfin ne répond pas — journalctl -u jellyfin -n 50"

echo "== Web (via Traefik)"
# Jellyseerr met ~2 min à démarrer après un boot : on lui laisse jusqu'à 3 min avant de conclure.
for _ in $(seq 1 36); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://jellyseerr.maxibestof.com/api/v1/status)" = 200 ] && break; sleep 5; done
for u in https://jellyfin.maxibestof.com/System/Info/Public https://home.maxibestof.com/ https://mcp.maxibestof.com/health https://jellyseerr.maxibestof.com/api/v1/status https://rcette.maxibestof.com/; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$u"); case "$code" in 200|302|401) ok "$code $u";; *) ko "$code $u";; esac
done

echo "== Divers"
mountpoint -q /mnt/media && ok "/mnt/media monté ($(df -h /mnt/media | awk 'NR==2{print $5}'))" || ko "/mnt/media NON monté"
# RAID : CHAQUE array doit être [UU…] sans "_". L'ancien grep '\[UU\]' passait
# dès qu'UN array était sain, même si un autre était dégradé. Un array
# "inactive" n'a pas de ligne d'état : on le signale à part.
narr=0
while read -r dev status; do
  narr=$((narr+1))
  case "$status" in
    *_*) ko "RAID $dev dégradé $status : cat $MDSTAT" ;;
    *)   ok "RAID $dev $status" ;;
  esac
done < <(awk '/^md[0-9]+ :/{dev=$1} /blocks.*\[[U_]+\]$/{print dev, $NF}' "$MDSTAT" 2>/dev/null)
while read -r dev; do ko "RAID $dev INACTIF : cat $MDSTAT"; narr=$((narr+1)); done \
  < <(awk '/^md[0-9]+ : inactive/{print $1}' "$MDSTAT" 2>/dev/null)
grep -qE 'recovery|resync|reshape' "$MDSTAT" 2>/dev/null && ko "RAID en reconstruction : $(grep -oE '(recovery|resync|reshape) *= *[0-9.]+%' "$MDSTAT" | head -1)"
[ "$narr" -gt 0 ] || ko "aucun array RAID trouvé dans $MDSTAT"
ok "kernel $(uname -r)"
