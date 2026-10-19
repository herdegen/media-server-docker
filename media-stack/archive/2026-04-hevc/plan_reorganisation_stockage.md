# Plan — Réorganisation stockage RAID
*Rédigé le 2026-04-06 — à exécuter plus tard*

## Situation actuelle
- 2 disques 1.8To (sda, sdb) en RAID 1 complet
- md5 (sda5+sdb5) → /mnt/media — 1.6To utilisable, **95% plein**
- md3 (sda3+sdb3) → / (root) — 200Go, RAID 1, on ne touche pas
- md2 (sda2+sdb2) → /boot — on ne touche pas

## Contenu /mnt/media
| Contenu | Taille |
|---|---|
| Films (250+) | 874 Go |
| Séries (19) | 359 Go |
| Musique | 193 Go |
| Config + divers | ~30 Go |
| **Total** | **~1.46 To** |

## Objectif
- `sda5` → `/mnt/media` standalone (films + séries, sans redondance — re-téléchargeables)
- `sdb5` → `/mnt/music` dédié (musique + quelques films précieux)
- Rsync automatique nuit : musique sda → sdb (remplace le RAID pour la musique)
- Gain : ~1.4To libre sur sdb5, ~193Go récupérés sur sda5

## Étapes

### 0 — Préparation
- Lister les films "précieux" difficiles à retrouver (à copier sur sdb5)
- Vérifier qu'aucun encodage / téléchargement n'est en cours
- Noter les chemins des bibliothèques Jellyfin

### 1 — Retirer sdb5 du RAID (point critique)
```bash
mdadm --manage /dev/md5 --fail /dev/sdb5
mdadm --manage /dev/md5 --remove /dev/sdb5
```
→ RAID passe en dégradé 1 disque, serveur continue normalement.
⚠️ Ne pas interrompre — si sda5 lâche à ce moment, tout est perdu.

### 2 — Reformater sdb5
```bash
wipefs -a /dev/sdb5
mkfs.ext4 /dev/sdb5
```

### 3 — Monter et copier la musique
```bash
mkdir -p /mnt/music
mount /dev/sdb5 /mnt/music
rsync -av /mnt/media/music/ /mnt/music/
```
→ Vérifier que tout est bien copié avant de continuer.

### 4 — Copier les films précieux sur sdb5
```bash
rsync -av /mnt/media/movies/movies/Film_Précieux/ /mnt/music/precious_movies/
```

### 5 — Mettre à jour /etc/fstab
Ajouter (remplacer UUID par celui du nouveau ext4 via `blkid /dev/sdb5`) :
```
UUID=<nouveau-uuid>   /mnt/music   ext4   defaults   0   0
```

### 6 — Mettre à jour mdadm.conf + initramfs
```bash
mdadm --detail --scan > /etc/mdadm/mdadm.conf
update-initramfs -u
```

### 7 — Mettre à jour Jellyfin
- Bibliothèque "Musique" : changer le chemin `/mnt/media/music` → `/mnt/music`
- Relancer un scan complet

### 8 — Supprimer la musique de sda5 (après validation Jellyfin)
```bash
rm -rf /mnt/media/music
```

### 9 — Rsync automatique (cron)
```bash
crontab -e
# Ajouter :
0 3 * * * rsync -av --delete /mnt/media/music/ /mnt/music/
```

## Bilan attendu
| | Avant | Après |
|---|---|---|
| `/mnt/media` | 1.6To, 95% plein | 1.6To standalone, ~280Go libres |
| `/mnt/music` | — | 1.6To, 193Go utilisés, ~1.4To libres |
| Redondance | RAID 1 tout | Rsync musique uniquement |
