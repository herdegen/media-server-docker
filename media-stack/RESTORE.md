# Restauration des sauvegardes de config (backup-config.sh)

Archives : `s3://$BACKUP_BUCKET/config-backup_<AAAA-MM-JJ_HHMM>.tar.gz.gpg` (Scaleway fr-par, 14 dernières).
Chiffrement : GPG symétrique AES256, passphrase `BACKUP_GPG_PASSPHRASE` (dans `.env` **et** conservée hors serveur).

> La passphrase passe par un descripteur (`--passphrase-fd 3`), jamais en argument :
> un argument est lisible par tout utilisateur local dans `/proc/<pid>/cmdline`.

## 1. Récupérer et déchiffrer

```bash
sudo -i                      # .env est en 600
source /srv/media-stack/.env   # (ou saisir les variables à la main si le serveur est neuf)
export AWS_ACCESS_KEY_ID=$SCW_ACCESS_KEY AWS_SECRET_ACCESS_KEY=$SCW_SECRET_KEY
EP="https://s3.${SCW_REGION}.scw.cloud"
aws s3 ls s3://$BACKUP_BUCKET/ --endpoint-url $EP --region $SCW_REGION      # choisir une archive
A=config-backup_AAAA-MM-JJ_HHMM.tar.gz.gpg
mkdir -p /root/restore && cd /root/restore
aws s3 cp s3://$BACKUP_BUCKET/$A . --endpoint-url $EP --region $SCW_REGION

# Sans .env (serveur reconstruit) : taper la passphrase sans écho, puis la même commande.
#   read -rs BACKUP_GPG_PASSPHRASE
gpg --batch --pinentry-mode loopback --passphrase-fd 3 -d "$A" 3<<<"$BACKUP_GPG_PASSPHRASE" | tar xz
```

## 2. Contenu

```
arr/       radarr|sonarr|prowlarr|lidarr .db + .config.xml
           jellyseerr.db.sqlite3 + jellyseerr.settings.json
           bazarr.db + bazarr.config.yaml
           transmission.settings.json + transmission.malware-guard-hook.sh
           romarr/  slskd.yml  slskd.credentials.txt
           soularr.config.ini  soularr.approved_album_ids.txt  soularr.failed_imports.json
jellyfin/  jellyfin.db  glacier_items.json  etc-jellyfin/  plugin-configs/
system/    nftables-mediaserver.nft  fail2ban/{jail.local,jail.d,filter.d}
           systemd/ (nos unités + drop-ins)  gluetun-auth/
stack.tar.gz   /srv/media-stack (hors logs, node_modules, recyclarr/resources, archive/)
```

## 3. Restaurer (service par service, service ARRÊTÉ)

Une base SQLite se remplace conteneur arrêté, en supprimant les `-wal`/`-shm`
résiduels (sinon SQLite rejoue un vieux WAL sur la base restaurée).

```bash
# Exemple Sonarr (même principe pour radarr/prowlarr/lidarr)
docker stop sonarr
rm -f /var/lib/sonarr/sonarr.db-wal /var/lib/sonarr/sonarr.db-shm
install -o debian -g debian -m 644 arr/sonarr.db /var/lib/sonarr/sonarr.db
install -o debian -g debian -m 600 arr/sonarr.config.xml /var/lib/sonarr/config.xml
docker start sonarr

# Jellyseerr
docker stop jellyseerr
rm -f /var/lib/jellyseerr/db/db.sqlite3-wal /var/lib/jellyseerr/db/db.sqlite3-shm
install -o debian -g debian -m 644 arr/jellyseerr.db.sqlite3 /var/lib/jellyseerr/db/db.sqlite3
install -o debian -g debian -m 644 arr/jellyseerr.settings.json /var/lib/jellyseerr/settings.json
docker start jellyseerr

# Bazarr
docker stop bazarr
rm -f /var/lib/bazarr/db/bazarr.db-wal /var/lib/bazarr/db/bazarr.db-shm
install -o debian -g debian -m 644 arr/bazarr.db /var/lib/bazarr/db/bazarr.db
install -o debian -g debian -m 600 arr/bazarr.config.yaml /var/lib/bazarr/config/config.yaml
docker start bazarr

# Transmission : TOUJOURS stopper avant (il réécrit settings.json à l'arrêt)
docker stop transmission
install -o debian -g debian -m 664 arr/transmission.settings.json /var/lib/transmission-daemon/settings.json
install -o debian -g debian -m 755 arr/transmission.malware-guard-hook.sh /var/lib/transmission-daemon/malware-guard-hook.sh
docker start transmission

# Jellyfin
systemctl stop jellyfin
rm -f /var/lib/jellyfin/data/jellyfin.db-wal /var/lib/jellyfin/data/jellyfin.db-shm
install -o jellyfin -g jellyfin -m 644 jellyfin/jellyfin.db /var/lib/jellyfin/data/jellyfin.db
cp -a jellyfin/plugin-configs/. /var/lib/jellyfin/plugins/configurations/
systemctl start jellyfin

# Système
install -m 644 system/nftables-mediaserver.nft /etc/nftables-mediaserver.nft
cp -a system/fail2ban/. /etc/fail2ban/ && systemctl restart fail2ban
cp -a system/systemd/. /etc/systemd/system/ && systemctl daemon-reload
install -d -m 755 /srv/docker/gluetun && cp -a system/gluetun-auth /srv/docker/gluetun/auth

# Stack complet (serveur neuf)
tar xzf stack.tar.gz -C /
```

## 4. Tester une archive sans rien restaurer

```bash
gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 -d "$A" 3<<<"$BACKUP_GPG_PASSPHRASE" | tar tzf - | head
```
(`backup-config.sh` fait ce test à chaque sauvegarde avant l'envoi, puis compare la taille côté Scaleway.)
