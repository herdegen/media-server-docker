#!/usr/bin/env python3
"""
Inventaire de ta musique locale, pour réorganiser le serveur SANS rien renvoyer.

Ce script ne modifie RIEN : il lit tes fichiers et écrit un seul fichier
"inventaire_musique.tsv" (quelques Mo) à envoyer ensuite.

Pour chaque fichier : empreinte rapide (taille + début + fin du fichier),
taille, et chemin relatif à ton dossier musique. Côté serveur, chaque fichier
identique sera retrouvé par son empreinte et déplacé au même chemin que chez toi.

Utilisation :
    python3 inventaire_musique.py "/chemin/vers/ta/Musique"
    (Windows : py inventaire_musique.py "D:\\Musique")
"""
import hashlib
import os
import sys

CHUNK = 1024 * 1024  # 1 Mo lu au début + 1 Mo à la fin : rapide, et suffisant
IGNORE = {"thumbs.db", "desktop.ini", ".ds_store"}


def empreinte(path, size):
    h = hashlib.sha1(str(size).encode())
    with open(path, "rb") as f:
        h.update(f.read(CHUNK))
        if size > 2 * CHUNK:
            f.seek(-CHUNK, os.SEEK_END)
            h.update(f.read(CHUNK))
    return h.hexdigest()


def main():
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]):
        sys.exit(__doc__)
    racine = os.path.abspath(sys.argv[1])
    sortie = os.path.join(os.getcwd(), "inventaire_musique.tsv")
    n = erreurs = 0
    with open(sortie, "w", encoding="utf-8", newline="\n") as out:
        out.write("empreinte\ttaille\tchemin\n")
        for dossier, _, fichiers in os.walk(racine):
            for nom in sorted(fichiers):
                if nom.lower() in IGNORE or nom.startswith("._"):
                    continue
                p = os.path.join(dossier, nom)
                try:
                    size = os.path.getsize(p)
                    rel = os.path.relpath(p, racine).replace(os.sep, "/")
                    out.write(f"{empreinte(p, size)}\t{size}\t{rel}\n")
                    n += 1
                except OSError as e:
                    erreurs += 1
                    print(f"  ignoré ({e}) : {p}", file=sys.stderr)
                if n and n % 1000 == 0:
                    print(f"  {n} fichiers...", flush=True)
    print(f"\nTerminé : {n} fichiers inventoriés, {erreurs} erreur(s).")
    print(f"Fichier à m'envoyer : {sortie}")


if __name__ == "__main__":
    main()
