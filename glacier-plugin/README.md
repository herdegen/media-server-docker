# Jellyfin Glacier plugin

Archivage de films Jellyfin vers Scaleway Glacier (cold storage) et restauration à la demande.
Le fichier local est remplacé par un `placeholder.mkv` valide, l'item reste visible dans Jellyfin
avec un tag `Glacier`. Le bouton Archiver/Restaurer est injecté côté web par `glacier-inject.js`
(via le plugin JavaScript Injector).

## Compatibilité

| Plugin  | Jellyfin      | .NET  | targetAbi   |
|---------|---------------|-------|-------------|
| 1.1.0.0 | 12.0+         | 10    | 12.0.0.0    |
| 1.0.0.0 | 10.11.x       | 9     | 10.11.0.0   |

## Build

Le projet référence les DLL du serveur (`$(JellyfinBin)`, défaut `/usr/lib/jellyfin/bin`).
Pour builder contre une autre version sans l'installer :

```bash
apt-get download jellyfin-server=12.0+deb13 && dpkg-deb -x jellyfin-server_*.deb /tmp/jf12
cd Jellyfin.Plugin.Glacier
dotnet build -c Release -p:JellyfinBin=/tmp/jf12/usr/lib/jellyfin/bin
```

## Installation (serveur natif Debian)

```bash
sudo systemctl stop jellyfin
D=/var/lib/jellyfin/plugins/Glacier_1.1.0.0
sudo mkdir -p "$D"
sudo cp Jellyfin.Plugin.Glacier/bin/Release/net10.0/{Jellyfin.Plugin.Glacier.dll,AWSSDK.Core.dll,AWSSDK.S3.dll} "$D"/
sudo cp Jellyfin.Plugin.Glacier/placeholder.mkv Jellyfin.Plugin.Glacier/meta.json "$D"/
sudo chown -R jellyfin:jellyfin "$D"
sudo systemctl start jellyfin
```

La base des items archivés est `/var/lib/jellyfin/data/glacier_items.json` (sauvegardée par
`backup-config.sh`). La config (clés Scaleway, bucket, région) est dans
`plugins/configurations/Jellyfin.Plugin.Glacier.xml`.

Prérequis : `aws` CLI disponible pour l'utilisateur `jellyfin` (l'upload passe par `aws s3 cp`).
