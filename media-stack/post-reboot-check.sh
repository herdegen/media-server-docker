#!/usr/bin/env bash
# post-reboot-check.sh — Vérifie que tout est revenu après un reboot et relance ce qui manque.
# Usage : /srv/media-stack/post-reboot-check.sh
set -uo pipefail
cd /srv/media-stack
ok(){ printf '  \033[32mOK\033[0m   %s\n' "$*"; }
ko(){ printf '  \033[31mKO\033[0m   %s\n' "$*"; }
fix(){ printf '  \033[33mFIX\033[0m  %s\n' "$*"; }

echo "== Services systemd (système)"
for u in docker jellyfin fail2ban rcette-backend rcette-bo rcette-foyer; do
  if systemctl is-active -q "$u"; then ok "$u"; else ko "$u"; fix "sudo systemctl start $u"; sudo systemctl start "$u"; fi
done

echo "== Sessions Claude Remote Control (services utilisateur)"
for u in claude-rc-mcp claude-rc-media-stack claude-rc-memorylane claude-rc-rcette; do
  if systemctl --user is-active -q "$u"; then ok "$u"; else ko "$u"; fix "systemctl --user start $u"; systemctl --user start "$u"; fi
done

echo "== Conteneurs Docker"
for c in gluetun flaresolverr prowlarr sonarr radarr transmission media-mcp traefik oauth2-proxy homepage vpn-control glances bazarr jellyseerr rcette-db memorylane_app memorylane_nginx memorylane_postgres memorylane_redis memorylane_horizon memorylane_scheduler memorylane_meilisearch; do
  st=$(sudo docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo absent)
  if [ "$st" = running ]; then ok "$c"; else ko "$c ($st)"; fi
done
down=$(sudo docker ps -a --filter status=exited --filter status=created --format '{{.Names}}' | grep -vE '^tinymediamanager$' || true)
if [ -n "$down" ]; then fix "relance de la stack : sudo docker compose up -d"; sudo docker compose up -d; fi

echo "== VPN (gluetun)"
for i in $(seq 1 12); do h=$(sudo docker inspect -f '{{.State.Health.Status}}' gluetun 2>/dev/null); [ "$h" = healthy ] && break; sleep 5; done
if [ "$h" = healthy ]; then ok "gluetun healthy"; else ko "gluetun $h — voir : sudo docker logs gluetun"; fi
vpn=$(sudo docker exec transmission curl -s --max-time 10 https://api.ipify.org 2>/dev/null); host=$(curl -s --max-time 10 https://api.ipify.org)
if [ -n "$vpn" ] && [ "$vpn" != "$host" ]; then ok "IP de sortie VPN $vpn (≠ hôte $host)"; else ko "IP VPN '$vpn' vs hôte '$host' — fuite ou VPN down"; fi

echo "== Jellyfin"
v=$(curl -s --max-time 10 http://127.0.0.1:8096/System/Info/Public | jq -r .Version 2>/dev/null)
[ -n "$v" ] && ok "Jellyfin $v répond" || ko "Jellyfin ne répond pas — journalctl -u jellyfin -n 50"

echo "== Web (via Traefik)"
# Jellyseerr met ~2 min à démarrer après un boot : on lui laisse jusqu'à 3 min avant de conclure.
for i in $(seq 1 36); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://jellyseerr.maxibestof.com/api/v1/status)" = 200 ] && break; sleep 5; done
for u in https://jellyfin.maxibestof.com/System/Info/Public https://home.maxibestof.com/ https://mcp.maxibestof.com/health https://jellyseerr.maxibestof.com/api/v1/status https://rcette.maxibestof.com/; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$u"); case "$code" in 200|302|401) ok "$code $u";; *) ko "$code $u";; esac
done

echo "== Divers"
mountpoint -q /mnt/media && ok "/mnt/media monté ($(df -h /mnt/media | awk 'NR==2{print $5}'))" || ko "/mnt/media NON monté"
grep -q '\[UU\]' /proc/mdstat && ok "RAID md [UU]" || ko "RAID dégradé : cat /proc/mdstat"
ok "kernel $(uname -r)"
