#!/usr/bin/env python3
"""status-collect.py — collecteur de la page de statut maxibestof.

Lance par root via status-collect.timer (toutes les 2 min). Ecrit
ATOMIQUEMENT (tmp + rename) :
  <out>/status.json   lu par ops-console (monte :ro) -> /status et /api/status
  <out>/state.json    etat prive (0600) : since/streaks/caches/dernier notifie

Chaque check : {id, group, label, state: ok|warn|crit|unknown, detail,
                since (ISO, dernier changement d'etat), updated (ISO, mesure)}

Notifications ntfy : uniquement sur TRANSITION
  - vers crit  : priorite haute, apres 2 collectes consecutives en crit
                 (immediat pour RAID / backup / fuite VPN / port expose)
  - retour ok  : priorite basse, apres 2 collectes consecutives en ok
  - warn       : jamais pousse (visible sur la page)
L'etat "dernier notifie" n'est mis a jour QUE si curl -sf reussit : un envoi
rate est retente a la collecte suivante (bug d'alert-check.sh corrige).

Aucun secret n'est ecrit dans status.json ni dans les logs : topic/token ntfy,
cles S3 et cles API restent en memoire, passees aux sous-processus par
variables d'environnement ou stdin (jamais en argv).

Usage :
  status-collect.py                       # prod : /srv/media-stack/status, ntfy actif
  status-collect.py --out DIR --no-notify # test
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import glob
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

STACK = "/srv/media-stack"
ENV_FILE = STACK + "/.env"
COMPOSE = STACK + "/docker-compose.yml"
TRAEFIK_DYN = STACK + "/traefik/dynamic"
MALWARE_LOG = STACK + "/alerts/malware-guard.log"
GLUETUN_APIKEY = "/srv/docker/gluetun/auth/.apikey.txt"
GLACIER_DB = "/var/lib/jellyfin/data/glacier_items.json"
GLACIER_XML = "/var/lib/jellyfin/plugins/configurations/Jellyfin.Plugin.Glacier.xml"
VPN_ACTIVE = STACK + "/vpn/active.env"

# ---------------------------------------------------------------- reglages
DISK_MOUNTS = ["/", "/mnt/media", "/srv"]
DISK_WARN, DISK_CRIT = 90, 95
INODE_WARN, INODE_CRIT = 90, 95

# Timers maison : nom -> (intervalle nominal en s, libelle)
# Fraicheur : dernier succes plus vieux que max(2 x intervalle, 5 min) = crit.
TIMERS = {
    "malware-guard":  (300,   "Anti-malware (5 min)"),
    "backup-config":  (86400, "Backup configs (03:30)"),
    "glacier-watch":  (300,   "Glacier watch (5 min)"),
    "recyclarr-sync": (86400, "Recyclarr sync (04:15)"),
    "soularr-guard":  (60,    "Garde-fou Soularr (1 min)"),
    "tmm-start":      (86400, "TMM start (02:00)"),
    "tmm-stop":       (86400, "TMM stop (08:00)"),
    "rcette-backup":  (86400, "Backup rcette (03:30)"),
}
BACKUP_MAX_AGE_H = 26

# Hors compose mais attendus. tinymediamanager : fenetre 02h-08h (heure systeme).
TMM_WINDOW = (2 * 60 + 5, 7 * 60 + 55)        # minutes depuis minuit, marge 5 min

# Ports TCP legitimes en ecoute publique (0.0.0.0 / :: / IP publique).
PORTS_ALLOWED = {
    22: "sshd",
    80: "traefik (HTTP -> ACME/redirect)",
    443: "traefik (HTTPS)",
    8096: "jellyfin natif (lien direct du dashboard, contourne le rate-limit Traefik)",
}
# Connus mais a corriger : warn au lieu de crit.
PORTS_KNOWN_WARN = {
    5355: "LLMNR systemd-resolved (LLMNR=no dans resolved.conf)",
}

CERT_WARN_D, CERT_CRIT_D = 14, 5

# Notification immediate sur passage en crit (pas d'anti-flap).
IMMEDIATE_PREFIXES = ("raid:", "backup:", "net:vpn_exit", "sec:ports", "storage:mounted")

DANGEROUS_EXT = r"exe|scr|bat|cmd|com|msi|pif|lnk|vbs|vbe|wsf|wsh|ps1"
MALWARE_GRACE_S = 12 * 60     # 2 passages de malware-guard avant de crier

GROUPS = [
    ("storage", "Stockage"),
    ("system", "Système"),
    ("tasks", "Tâches planifiées"),
    ("containers", "Conteneurs"),
    ("network", "Réseau / VPN"),
    ("web", "Services web"),
    ("security", "Sécurité"),
    ("glacier", "Glacier"),
]

# ---------------------------------------------------------------- utilitaires
NOW = time.time()


def iso(ts=None):
    return dt.datetime.fromtimestamp(NOW if ts is None else ts, dt.timezone.utc) \
        .astimezone().isoformat(timespec="seconds")


def sh(cmd, timeout=20, stdin=None, env=None):
    """(rc, stdout, stderr). rc=124 sur timeout, 127 si binaire absent."""
    try:
        p = subprocess.run(cmd, input=stdin, capture_output=True, text=True,
                           timeout=timeout, env=env)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except FileNotFoundError:
        return 127, "", "introuvable"


def http_get(url, timeout=6, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read(65536).decode("utf-8", "replace")


def read_env(path):
    """KEY=VALUE simple (pas de `source` : rien n'est execute)."""
    out = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                out[k.strip()] = v
    except OSError:
        pass
    return out


def human_bytes(n):
    n = float(n or 0)
    for u in ("o", "Ko", "Mo", "Go", "To"):
        if n < 1024 or u == "To":
            return ("%.0f %s" if u in ("o", "Ko") else "%.1f %s") % (n, u)
        n /= 1024


def human_age(sec):
    sec = int(max(0, sec))
    if sec < 90:
        return "%d s" % sec
    if sec < 5400:
        return "%d min" % (sec // 60)
    if sec < 172800:
        return "%.1f h" % (sec / 3600.0)
    return "%d j" % (sec // 86400)


def worst(states):
    order = {"ok": 0, "unknown": 1, "warn": 2, "crit": 3}
    return max(states, key=lambda s: order.get(s, 1)) if states else "ok"


# ---------------------------------------------------------------- collecte
class Collector:
    def __init__(self, state):
        self.state = state
        self.cache = state.setdefault("cache", {})
        self.checks = []

    def add(self, cid, group, label, st, detail, measured=None):
        self.checks.append({"id": cid, "group": group, "label": label,
                            "state": st, "detail": detail,
                            "updated": iso(measured)})

    def cached(self, key, ttl, fn, invalidate_before=0):
        """Resultat mis en cache `ttl` s. Une erreur n'est pas mise en cache
        (on retente au prochain passage) mais l'ancienne valeur est rendue."""
        c = self.cache.get(key)
        if c and NOW - c["ts"] < ttl and c["ts"] >= invalidate_before:
            return c["data"], c["ts"]
        try:
            data = fn()
        except Exception as e:                       # noqa: BLE001
            if c:
                return c["data"], c["ts"]
            raise RuntimeError(str(e)[:200])
        self.cache[key] = {"ts": NOW, "data": data}
        return data, NOW

    def safe(self, fn, cid, group, label):
        """Un check qui plante ne fait pas tomber les autres -> unknown."""
        try:
            fn()
        except Exception as e:                       # noqa: BLE001
            self.add(cid, group, label, "unknown", "%s: %s" % (type(e).__name__, str(e)[:160]))

    # ================================================================ STOCKAGE
    def storage(self):
        G = "storage"
        # --- RAID -----------------------------------------------------------
        try:
            md = open("/proc/mdstat").read()
        except OSError:
            md = ""
        blocks = re.split(r"\n(?=md\d+\s*:)", md)
        found = False
        for b in blocks:
            m = re.match(r"(md\d+)\s*:\s*(\w+)\s+(\S+)?(.*)", b)
            if not m:
                continue
            found = True
            name, active, level = m.group(1), m.group(2), m.group(3) or "?"
            members = re.findall(r"(\w+)\[\d+\](\(F\))?", m.group(4))
            failed = [d for d, f in members if f]
            st_m = re.search(r"\[(\d+)/(\d+)\]\s*\[([U_]+)\]", b)
            prog = re.search(r"(resync|recovery|reshape|check)\s*=\s*([\d.]+)%.*?finish=([\d.]+min)?", b, re.S)
            delayed = re.search(r"(resync|recovery)=(DELAYED|PENDING)", b)
            label = "RAID %s (%s)" % (name, level)
            if active != "active":
                self.add("raid:" + name, G, label, "crit", "état %s" % active)
                continue
            if st_m and (st_m.group(1) != st_m.group(2) or "_" in st_m.group(3)) or failed:
                self.add("raid:" + name, G, label, "crit",
                         "DÉGRADÉ %s %s%s" % (st_m.group(0) if st_m else "",
                                             " membres en échec : " + ",".join(failed) if failed else "",
                                             " — %s %s%%" % (prog.group(1), prog.group(2)) if prog else ""))
                continue
            if prog and prog.group(1) == "check":
                self.add("raid:" + name, G, label, "ok",
                         "%s, vérification périodique %s%%" % (st_m.group(0) if st_m else "", prog.group(2)))
            elif prog or delayed:
                self.add("raid:" + name, G, label, "warn",
                         "%s en cours %s%%%s" % (prog.group(1), prog.group(2),
                                                ", fin ~" + prog.group(3) if prog.group(3) else "")
                         if prog else "%s en attente" % delayed.group(1))
            else:
                self.add("raid:" + name, G, label, "ok",
                         "%s, %d disques : %s" % (st_m.group(0) if st_m else "actif", len(members),
                                                 " ".join(d for d, _ in members)))
        if not found:
            self.add("raid:none", G, "RAID", "unknown", "aucun md dans /proc/mdstat")

        # --- point de montage media -----------------------------------------
        if os.path.ismount("/mnt/media"):
            self.add("storage:mounted", G, "/mnt/media monté", "ok", "point de montage présent")
        else:
            self.add("storage:mounted", G, "/mnt/media monté", "crit",
                     "/mnt/media N'EST PAS monté : les écritures remplissent /")

        # --- espace + inodes (dedoublonne par peripherique) -----------------
        seen = {}
        for mnt in DISK_MOUNTS:
            try:
                st = os.stat(mnt)
            except OSError:
                continue
            seen.setdefault(st.st_dev, []).append(mnt)
        inode_rows, inode_states = [], []
        for dev, mnts in seen.items():
            mnt = mnts[0]
            v = os.statvfs(mnt)
            total = v.f_blocks * v.f_frsize
            avail = v.f_bavail * v.f_frsize
            used = (v.f_blocks - v.f_bfree) * v.f_frsize
            pct = 100.0 * used / (used + avail) if (used + avail) else 0     # = df
            stt = "crit" if pct >= DISK_CRIT else "warn" if pct >= DISK_WARN else "ok"
            lbl = "Espace " + " + ".join(mnts)
            self.add("disk:" + mnt, G, lbl, stt, "%.0f %% utilisé, %s libres sur %s"
                     % (pct, human_bytes(avail), human_bytes(total)))
            if v.f_files:
                ip = 100.0 * (v.f_files - v.f_ffree) / v.f_files
                inode_states.append("crit" if ip >= INODE_CRIT else "warn" if ip >= INODE_WARN else "ok")
                inode_rows.append("%s %.0f %%" % (mnt, ip))
        self.add("inodes", G, "Inodes", worst(inode_states), ", ".join(inode_rows) or "—")

        # --- SMART (cache 1 h) ----------------------------------------------
        rc, out, _ = sh(["lsblk", "-dn", "-o", "NAME,TYPE"], 10)
        disks = [l.split()[0] for l in out.splitlines() if l.split()[1:] == ["disk"]
                 and not l.startswith(("loop", "zram", "sr"))]
        for d in disks:
            def probe(d=d):
                rc, out, _ = sh(["smartctl", "-H", "-A", "/dev/" + d], 60)
                if rc == 127:
                    raise RuntimeError("smartctl absent")
                health = None
                m = re.search(r"overall-health self-assessment test result:\s*(\S+)", out) \
                    or re.search(r"SMART Health Status:\s*(\S+)", out)
                if m:
                    health = m.group(1)
                attrs = {}
                for line in out.splitlines():
                    p = line.split()
                    if len(p) >= 10 and p[0].isdigit():
                        attrs[p[1]] = p[9]
                return {"rc": rc, "health": health, "attrs": attrs}
            try:
                r, ts = self.cached("smart:" + d, 3600, probe)
            except RuntimeError as e:
                self.add("smart:" + d, G, "SMART " + d, "unknown", str(e))
                continue
            bad = {k: r["attrs"].get(k) for k in ("Reallocated_Sector_Ct", "Current_Pending_Sector",
                                                  "Offline_Uncorrectable", "Reported_Uncorrect")
                   if (r["attrs"].get(k) or "0").split()[0] not in ("0",)}
            temp = r["attrs"].get("Temperature_Celsius")
            h = r["health"]
            if h in ("FAILED!", "FAILED") or (r["rc"] & 8):
                stt, det = "crit", "SMART %s (le disque annonce sa fin)" % (h or "rc=%d" % r["rc"])
            elif h is None:
                stt, det = "unknown", "état SMART illisible (rc=%d)" % r["rc"]
            elif bad:
                stt, det = "warn", "%s mais %s" % (h, ", ".join("%s=%s" % kv for kv in bad.items()))
            else:
                stt, det = "ok", h
            if temp:
                det += ", %s °C" % temp.split()[0]
            self.add("smart:" + d, G, "SMART " + d, stt, det, ts)

    # ================================================================ SYSTEME
    def system(self):
        G = "system"
        rc, out, _ = sh(["systemctl", "--failed", "--no-legend", "--plain"], 15)
        units = [l.split()[0] for l in out.splitlines() if l.strip()]
        self.add("sys:failed_units", G, "Unités systemd en échec", "warn" if units else "ok",
                 ", ".join(units) if units else "aucune")

        # --- reboot en attente ------------------------------------------------
        running = os.uname().release
        kernels = [os.path.basename(p)[len("vmlinuz-"):] for p in glob.glob("/boot/vmlinuz-*")]

        def vkey(s):
            return [int(x) if x.isdigit() else x for x in re.split(r"[.+-]", s)]
        newest = max(kernels, key=vkey) if kernels else running
        flag = os.path.exists("/run/reboot-required")
        if newest != running or flag:
            self.add("sys:reboot", G, "Redémarrage en attente", "warn",
                     "noyau chargé %s, installé %s%s" % (running, newest,
                                                        " (reboot-required)" if flag else ""))
        else:
            self.add("sys:reboot", G, "Redémarrage en attente", "ok", "non (noyau %s)" % running)

        # --- MAJ apt (cache 6 h) ----------------------------------------------
        def apt():
            rc, out, err = sh(["apt-get", "-s", "-o", "Debug::NoLocking=1", "dist-upgrade"], 120)
            if rc != 0:
                raise RuntimeError("apt-get -s rc=%d" % rc)
            inst = [l for l in out.splitlines() if l.startswith("Inst ")]
            sec = [l.split()[1] for l in inst if "-security" in l.lower() or "security" in l.lower()]
            lists = glob.glob("/var/lib/apt/lists/*_InRelease")
            newest_list = max((os.path.getmtime(p) for p in lists), default=0)
            return {"n": len(inst), "sec": sec[:15], "nsec": len(sec), "lists": newest_list}
        try:
            a, ts = self.cached("apt", 6 * 3600, apt)
            age_lists = NOW - a["lists"] if a["lists"] else None
            if a["nsec"]:
                self.add("sys:apt", G, "Mises à jour de sécurité", "warn",
                         "%d en attente : %s" % (a["nsec"], ", ".join(a["sec"][:6])), ts)
            elif age_lists and age_lists > 3 * 86400:
                self.add("sys:apt", G, "Mises à jour de sécurité", "warn",
                         "index apt vieux de %s (unattended-upgrades bloqué ?)" % human_age(age_lists), ts)
            else:
                self.add("sys:apt", G, "Mises à jour de sécurité", "ok",
                         "aucune en attente (%d MAJ non sécu)%s" % (
                             a["n"], ", index de il y a " + human_age(age_lists) if age_lists else ""), ts)
        except RuntimeError as e:
            self.add("sys:apt", G, "Mises à jour de sécurité", "unknown", str(e))

        # --- charge / memoire (warn seulement) ----------------------------------
        l1, l5, l15 = (float(x) for x in open("/proc/loadavg").read().split()[:3])
        ncpu = os.cpu_count() or 1
        self.add("sys:load", G, "Charge", "warn" if l5 > ncpu * 1.5 else "ok",
                 "%.2f / %.2f / %.2f pour %d cœurs" % (l1, l5, l15, ncpu))
        mi = {}
        for line in open("/proc/meminfo"):
            k, v = line.split(":", 1)
            mi[k] = int(v.split()[0]) * 1024
        tot, av = mi.get("MemTotal", 1), mi.get("MemAvailable", 0)
        swt, swf = mi.get("SwapTotal", 0), mi.get("SwapFree", 0)
        pct = 100.0 * (tot - av) / tot
        self.add("sys:mem", G, "Mémoire", "warn" if pct >= 90 else "ok",
                 "%.0f %% utilisée (%s dispo sur %s)%s" % (
                     pct, human_bytes(av), human_bytes(tot),
                     ", swap %s" % human_bytes(swt - swf) if swt else ""))
        up = float(open("/proc/uptime").read().split()[0])
        self.add("sys:uptime", G, "Uptime", "ok", "%s (depuis %s)" % (
            human_age(up), dt.datetime.fromtimestamp(NOW - up).strftime("%d/%m %H:%M")))

    # ================================================================ TACHES
    def _show(self, unit, props):
        rc, out, _ = sh(["systemctl", "show", unit, "--timestamp=unix"] +
                        ["-p" + p for p in props], 10)
        d = {}
        for line in out.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                d[k] = v
        return d

    @staticmethod
    def _ts(v):
        m = re.match(r"@(\d+)", v or "")
        return int(m.group(1)) if m else None

    def tasks(self):
        G = "tasks"
        last_ok = self.state.setdefault("timer_last_ok", {})
        for name, (interval, label) in TIMERS.items():
            t = self._show(name + ".timer", ["LoadState", "ActiveState", "UnitFileState",
                                             "LastTriggerUSec", "NextElapseUSecRealtime"])
            s = self._show(name + ".service", ["Result", "ExecMainStatus", "ExecMainExitTimestamp",
                                               "ExecMainStartTimestamp", "ActiveState"])
            cid = "timer:" + name
            if t.get("LoadState") != "loaded":
                self.add(cid, G, label, "unknown", "timer introuvable")
                continue
            exit_ts = self._ts(s.get("ExecMainExitTimestamp"))
            if s.get("Result") == "success" and exit_ts:
                last_ok[name] = max(exit_ts, last_ok.get(name, 0))
            ok_ts = last_ok.get(name)
            limit = max(2 * interval, 300)
            nxt = self._ts(t.get("NextElapseUSecRealtime"))
            nxt_s = (", prochain " + dt.datetime.fromtimestamp(nxt).strftime("%H:%M")) if nxt and interval >= 3600 else ""
            if t.get("ActiveState") != "active":
                self.add(cid, G, label, "crit", "timer %s (%s)" % (t.get("ActiveState"), t.get("UnitFileState")))
            elif s.get("ActiveState") in ("activating", "active", "reloading"):
                self.add(cid, G, label, "ok", "en cours d'exécution" + (
                    ", dernier succès il y a " + human_age(NOW - ok_ts) if ok_ts else ""))
            elif s.get("Result") not in ("success", None, ""):
                self.add(cid, G, label, "crit", "dernier run en échec : %s (code %s)%s" % (
                    s.get("Result"), s.get("ExecMainStatus"),
                    ", dernier succès il y a " + human_age(NOW - ok_ts) if ok_ts else ", aucun succès connu"))
            elif not ok_ts:
                self.add(cid, G, label, "warn", "jamais exécuté depuis le boot")
            elif NOW - ok_ts > limit:
                self.add(cid, G, label, "crit", "dernier succès il y a %s (> %s)" % (
                    human_age(NOW - ok_ts), human_age(limit)))
            else:
                self.add(cid, G, label, "ok", "succès il y a %s%s" % (human_age(NOW - ok_ts), nxt_s))
        self.backup_archive()

    def backup_archive(self):
        G = "tasks"
        env = read_env(ENV_FILE)
        bucket, region = env.get("BACKUP_BUCKET"), env.get("SCW_REGION") or "fr-par"
        if not (bucket and env.get("SCW_ACCESS_KEY")):
            self.add("backup:archive", G, "Dernière archive de backup", "unknown", "config S3 absente de .env")
            return

        def ls():
            e = dict(os.environ, AWS_ACCESS_KEY_ID=env["SCW_ACCESS_KEY"],
                     AWS_SECRET_ACCESS_KEY=env.get("SCW_SECRET_KEY", ""),
                     AWS_DEFAULT_REGION=region)
            rc, out, err = sh(["aws", "s3api", "list-objects-v2", "--bucket", bucket,
                               "--prefix", "config-backup_", "--output", "json",
                               "--endpoint-url", "https://s3.%s.scw.cloud" % region], 60, env=e)
            if rc != 0:
                raise RuntimeError("aws s3api rc=%d" % rc)
            objs = (json.loads(out or "{}").get("Contents") or [])
            return [{"k": o["Key"], "t": dt.datetime.fromisoformat(o["LastModified"].replace("Z", "+00:00")).timestamp(),
                     "s": o.get("Size", 0)} for o in objs]
        # une nouvelle sauvegarde termine -> on invalide le cache
        s = self._show("backup-config.service", ["ExecMainExitTimestamp"])
        last_exit = self._ts(s.get("ExecMainExitTimestamp")) or 0
        try:
            objs, ts = self.cached("backup_ls", 3600, ls, invalidate_before=last_exit)
        except RuntimeError as e:
            self.add("backup:archive", G, "Dernière archive de backup", "unknown", str(e))
            return
        if not objs:
            self.add("backup:archive", G, "Dernière archive de backup", "crit", "aucune archive dans le bucket", ts)
            return
        objs.sort(key=lambda o: o["t"])
        last = objs[-1]
        age = NOW - last["t"]
        sizes = sorted(o["s"] for o in objs[:-1])
        med = sizes[len(sizes) // 2] if sizes else 0
        det = "il y a %s, %s, %d archives" % (human_age(age), human_bytes(last["s"]), len(objs))
        if age > BACKUP_MAX_AGE_H * 3600:
            self.add("backup:archive", G, "Dernière archive de backup", "crit", det + " (> %d h)" % BACKUP_MAX_AGE_H, ts)
        elif med and last["s"] < med * 0.5:
            self.add("backup:archive", G, "Dernière archive de backup", "warn",
                     det + " — moitié moins grosse que la médiane (%s)" % human_bytes(med), ts)
        else:
            self.add("backup:archive", G, "Dernière archive de backup", "ok", det, ts)

    # ================================================================ CONTENEURS
    def docker_inspect(self):
        rc, out, _ = sh(["docker", "ps", "-aq"], 20)
        ids = out.split()
        if rc != 0:
            raise RuntimeError("docker ps rc=%d" % rc)
        if not ids:
            return []
        rc, out, _ = sh(["docker", "inspect"] + ids, 30)
        return json.loads(out or "[]")

    def expected_containers(self):
        names = []
        try:
            for line in open(COMPOSE):
                m = re.match(r"\s*container_name:\s*['\"]?([\w.-]+)", line)
                if m and not line.lstrip().startswith("#"):
                    names.append(m.group(1))
        except OSError:
            pass
        return names

    def containers(self, insp):
        G = "containers"
        by = {c["Name"].lstrip("/"): c for c in insp}
        hist = self.state.setdefault("restarts", {})
        expected = self.expected_containers()
        for name in expected:
            cid = "container:" + name
            c = by.get(name)
            if not c:
                self.add(cid, G, name, "crit", "absent (supprimé ?)")
                continue
            s = c["State"]
            h = (s.get("Health") or {}).get("Status")
            started = s.get("StartedAt", "")
            rec = hist.setdefault(name, {"started": started, "events": []})
            if rec["started"] != started and s.get("Running"):
                rec["events"].append(NOW)
                rec["started"] = started
            rec["events"] = [t for t in rec["events"] if NOW - t < 86400]
            nrest = len(rec["events"])
            try:
                up_s = NOW - dt.datetime.fromisoformat(started[:26].rstrip("Z") + "+00:00").timestamp()
            except ValueError:
                up_s = 0
            rs = ", %d redémarrage(s)/24 h" % nrest if nrest else ""
            if s.get("Restarting"):
                self.add(cid, G, name, "crit", "en boucle de redémarrage (RestartCount %d)" % c.get("RestartCount", 0))
            elif not s.get("Running"):
                self.add(cid, G, name, "crit", "arrêté (%s, exit %s)" % (s.get("Status"), s.get("ExitCode")))
            elif h == "unhealthy":
                self.add(cid, G, name, "crit", "unhealthy" + rs)
            elif h == "starting":
                self.add(cid, G, name, "warn", "healthcheck en démarrage" + rs)
            elif nrest >= 3:
                self.add(cid, G, name, "warn", "up %s%s" % (human_age(up_s), rs))
            else:
                self.add(cid, G, name, "ok", "up %s%s%s" % (human_age(up_s), ", healthy" if h == "healthy" else "", rs))

        # --- tinymediamanager : hors compose, fenetre 02h-08h ------------------
        c = by.get("tinymediamanager")
        lt = time.localtime(NOW)
        mins = lt.tm_hour * 60 + lt.tm_min
        in_win = TMM_WINDOW[0] <= mins <= TMM_WINDOW[1]
        if not c:
            self.add("container:tinymediamanager", G, "tinymediamanager", "warn", "conteneur absent")
        else:
            run = c["State"].get("Running")
            if in_win and not run:
                self.add("container:tinymediamanager", G, "tinymediamanager", "warn", "devrait tourner (02h–08h)")
            elif not in_win and run:
                self.add("container:tinymediamanager", G, "tinymediamanager", "warn", "tourne hors fenêtre 02h–08h (tmm-stop ?)")
            else:
                self.add("container:tinymediamanager", G, "tinymediamanager", "ok",
                         "en fenêtre, actif" if run else "arrêté hors fenêtre (normal)")

        # --- autres projets du serveur : warn seulement -------------------------
        others = [n for n in by if n not in expected and n != "tinymediamanager"]
        bad = []
        for n in others:
            s = by[n]["State"]
            pol = ((by[n].get("HostConfig") or {}).get("RestartPolicy") or {}).get("Name")
            h = (s.get("Health") or {}).get("Status")
            if s.get("Restarting") or h == "unhealthy":
                bad.append("%s (%s)" % (n, "restart" if s.get("Restarting") else "unhealthy"))
            elif not s.get("Running") and pol in ("always", "unless-stopped") and s.get("ExitCode"):
                bad.append("%s (exit %s)" % (n, s.get("ExitCode")))
        self.add("container:others", G, "Autres projets (%d conteneurs)" % len(others),
                 "warn" if bad else "ok", ", ".join(bad) if bad else "aucun unhealthy / en boucle")

    # ================================================================ RESEAU
    def network(self, insp):
        G = "network"
        by = {c["Name"].lstrip("/"): c for c in insp}
        g = by.get("gluetun")
        prov = read_env(VPN_ACTIVE).get("VPN_SERVICE_PROVIDER", "?")
        if not g:
            self.add("net:gluetun", G, "Tunnel VPN (gluetun)", "crit", "conteneur gluetun absent")
        else:
            h = (g["State"].get("Health") or {}).get("Status") or ("running" if g["State"].get("Running") else "arrêté")
            self.add("net:gluetun", G, "Tunnel VPN (gluetun)", "ok" if h == "healthy" else "crit",
                     "%s, fournisseur %s" % (h, prov))

        # IP publique du serveur (cache 6 h) et IP de sortie VPN (cache 10 min)
        def host_ip():
            rc, out, _ = sh(["curl", "-4", "-sf", "--max-time", "8", "https://api.ipify.org"], 12)
            ip = out.strip()
            if rc or not re.match(r"^\d+\.\d+\.\d+\.\d+$", ip):
                raise RuntimeError("ipify injoignable depuis l'hôte")
            return ip

        def vpn_ip():
            rc, out, _ = sh(["docker", "exec", "transmission", "curl", "-s", "--max-time", "8",
                             "https://api.ipify.org"], 15)
            ip = out.strip()
            if rc or not re.match(r"^[\d.]+$|^[0-9a-f:]+$", ip):
                raise RuntimeError("pas de sortie Internet depuis transmission (rc=%d)" % rc)
            return ip
        try:
            hip, _ = self.cached("host_ip", 6 * 3600, host_ip)
        except RuntimeError:
            hip = None
        # le cache ne garde que les succes : apres un echec on retente tout de suite
        c = self.cache.get("vpn_ip")
        try:
            if c and NOW - c["ts"] < 600:
                vip, ts = c["data"], c["ts"]
            else:
                vip, ts = vpn_ip(), NOW
                self.cache["vpn_ip"] = {"ts": NOW, "data": vip}
        except RuntimeError as e:
            self.cache.pop("vpn_ip", None)
            self.add("net:vpn_exit", G, "IP de sortie VPN", "crit", str(e))
            vip = None
        country = ""
        try:
            key = open(GLUETUN_APIKEY).read().strip()
            _, body = http_get("http://172.17.0.1:8000/v1/publicip/ip", 5, {"X-API-Key": key})
            j = json.loads(body)
            country = ", ".join(x for x in (j.get("city"), j.get("country")) if x)
        except Exception:                                # noqa: BLE001
            pass
        if vip:
            if hip and vip == hip:
                self.add("net:vpn_exit", G, "IP de sortie VPN", "crit",
                         "FUITE : transmission sort avec l'IP du serveur (%s)" % hip, ts)
            elif not hip:
                self.add("net:vpn_exit", G, "IP de sortie VPN", "warn",
                         "%s%s — IP serveur inconnue, comparaison impossible" % (vip, " (" + country + ")" if country else ""), ts)
            else:
                self.add("net:vpn_exit", G, "IP de sortie VPN", "ok",
                         "%s%s ≠ serveur %s" % (vip, " (" + country + ")" if country else "", hip), ts)
        # Port forwarding : NordVPN ne le propose pas -> pas de check.

    # ================================================================ WEB
    def web(self, insp):
        G = "web"
        try:
            code, body = http_get("http://127.0.0.1:8096/health", 6)
            self.add("web:jellyfin", G, "Jellyfin (local)", "ok" if code == 200 and "Healthy" in body else "crit",
                     "HTTP %d %s" % (code, body.strip()[:40]))
        except Exception as e:                            # noqa: BLE001
            self.add("web:jellyfin", G, "Jellyfin (local)", "crit", "injoignable : %s" % str(e)[:80])
        # Chaine complete Traefik -> Jellyfin (SNI + cert verifie)
        rc, out, _ = sh(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8",
                         "--resolve", "jellyfin.maxibestof.com:443:127.0.0.1",
                         "https://jellyfin.maxibestof.com/health"], 12)
        self.add("web:traefik", G, "Traefik → Jellyfin (HTTPS)", "ok" if out == "200" else "crit",
                 "HTTP %s" % out if out and out != "000" else "échec TLS/connexion (curl rc=%d)" % rc)
        # *arr derriere gluetun (ports bindes sur 172.17.0.1)
        for cid, label, url, okc in (
                ("sonarr", "Sonarr", "http://172.17.0.1:8989/ping", (200,)),
                ("radarr", "Radarr", "http://172.17.0.1:7878/ping", (200,)),
                ("prowlarr", "Prowlarr", "http://172.17.0.1:9696/ping", (200,)),
                ("lidarr", "Lidarr", "http://172.17.0.1:8686/ping", (200,)),
                ("transmission", "Transmission RPC", "http://172.17.0.1:9091/transmission/rpc", (409, 200)),
                ("slskd", "slskd", "http://172.17.0.1:5030/health", (200,))):
            rc, out, _ = sh(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", url], 8)
            ok = out.isdigit() and int(out) in okc
            self.add("web:" + cid, G, label, "ok" if ok else "crit",
                     "répond (HTTP %s)" % out if ok else "HTTP %s (curl rc=%d)" % (out or "—", rc))
        self.certs(insp)

    def certs(self, insp):
        G = "web"
        hosts = set()
        blobs = []
        for c in insp:
            blobs.extend((c.get("Config") or {}).get("Labels", {}).values() if (c.get("Config") or {}).get("Labels") else [])
        for f in glob.glob(TRAEFIK_DYN + "/*.yml") + glob.glob(TRAEFIK_DYN + "/*.yaml"):
            try:
                blobs.append(open(f).read())
            except OSError:
                pass
        for b in blobs:
            hosts.update(re.findall(r"Host\(`([^`]+)`\)", b))
        hosts = sorted(h for h in hosts if "." in h)

        def one(h):
            rc, pem, _ = sh(["openssl", "s_client", "-connect", "127.0.0.1:443", "-servername", h],
                            10, stdin="")
            rc2, out, _ = sh(["openssl", "x509", "-noout", "-enddate", "-checkhost", h], 10, stdin=pem)
            m = re.search(r"notAfter=(.+)", out)
            if not m:
                return {"h": h, "err": "pas de certificat"}
            end = dt.datetime.strptime(m.group(1).strip(), "%b %d %H:%M:%S %Y %Z") \
                .replace(tzinfo=dt.timezone.utc).timestamp()
            return {"h": h, "end": end, "match": "does match" in out}

        def scan():
            with cf.ThreadPoolExecutor(8) as ex:
                return list(ex.map(one, hosts))
        key = "certs:" + ",".join(hosts)
        try:
            res, ts = self.cached("certs", 6 * 3600, lambda: {"key": key, "r": scan()})
            if res.get("key") != key:                       # domaines ajoutes/retires
                self.cache.pop("certs", None)
                res, ts = self.cached("certs", 6 * 3600, lambda: {"key": key, "r": scan()})
        except RuntimeError as e:
            self.add("web:certs", G, "Certificats TLS", "unknown", str(e))
            return
        probs, states, soonest = [], [], None
        for r in res["r"]:
            if r.get("err"):
                states.append("crit"); probs.append("%s : %s" % (r["h"], r["err"]))
                continue
            days = (r["end"] - NOW) / 86400
            if soonest is None or days < soonest[1]:
                soonest = (r["h"], days)
            if not r["match"]:
                states.append("crit"); probs.append("%s : cert ne couvre pas l'hôte (défaut Traefik ?)" % r["h"])
            elif days < CERT_CRIT_D:
                states.append("crit"); probs.append("%s expire dans %.0f j" % (r["h"], days))
            elif days < CERT_WARN_D:
                states.append("warn"); probs.append("%s expire dans %.0f j" % (r["h"], days))
            else:
                states.append("ok")
        det = "%d domaines" % len(res["r"])
        if soonest:
            det += ", prochain : %s dans %.0f j" % soonest
        if probs:
            det = "; ".join(probs[:5]) + (" (+%d)" % (len(probs) - 5) if len(probs) > 5 else "") + " — " + det
        self.add("web:certs", G, "Certificats TLS", worst(states), det, ts)

    # ================================================================ SECURITE
    def security(self, insp):
        G = "security"
        rc, out, _ = sh(["systemctl", "is-active", "fail2ban"], 5)
        if out.strip() != "active":
            self.add("sec:fail2ban", G, "fail2ban", "crit", "service %s" % (out.strip() or "absent"))
        else:
            rc, out, _ = sh(["fail2ban-client", "status", "sshd"], 10)
            cur = re.search(r"Currently banned:\s*(\d+)", out)
            tot = re.search(r"Total banned:\s*(\d+)", out)
            self.add("sec:fail2ban", G, "fail2ban", "ok" if cur else "warn",
                     "jail sshd : %s banni(s), %s au total" % (cur.group(1), tot.group(1) if tot else "?")
                     if cur else "jail sshd illisible")

        rc, out, _ = sh(["sshd", "-T"], 10)
        pa = re.search(r"^passwordauthentication\s+(\S+)", out, re.M)
        if pa:
            self.add("sec:ssh_pw", G, "SSH par mot de passe", "warn" if pa.group(1) == "yes" else "ok",
                     "autorisé (TODO : clé seule)" if pa.group(1) == "yes" else "désactivé")

        # --- ports exposes ----------------------------------------------------
        rc, out, _ = sh(["ss", "-tlnpH"], 10)
        exposed = {}
        for line in out.splitlines():
            p = line.split()
            if len(p) < 4:
                continue
            addr = p[3]
            host, _, port = addr.rpartition(":")
            host = host.strip("[]").split("%")[0]
            proc = re.search(r'\(\("([^"]+)"', line)
            if host in ("0.0.0.0", "::", "*") or not (
                    host.startswith(("127.", "::1", "172.", "10.", "192.168.", "fe80", "fd", "169.254."))):
                if port.isdigit():
                    exposed.setdefault(int(port), set()).add(proc.group(1) if proc else "?")
        # ports Docker publies sur toutes les interfaces (vu meme sans userland-proxy)
        for c in insp:
            for spec, binds in ((c.get("NetworkSettings") or {}).get("Ports") or {}).items():
                for b in binds or []:
                    if b.get("HostIp") in ("", "0.0.0.0", "::") and str(b.get("HostPort", "")).isdigit() \
                            and spec.endswith("/tcp"):
                        exposed.setdefault(int(b["HostPort"]), set()).add("docker:" + c["Name"].lstrip("/"))
        bad = {p: v for p, v in exposed.items() if p not in PORTS_ALLOWED and p not in PORTS_KNOWN_WARN}
        known = {p: v for p, v in exposed.items() if p in PORTS_KNOWN_WARN}
        fmt = lambda d: ", ".join("%d (%s)" % (p, "/".join(sorted(v))) for p, v in sorted(d.items()))
        if bad:
            self.add("sec:ports", G, "Ports exposés sur Internet", "crit", "NON PRÉVU : " + fmt(bad))
        elif known:
            self.add("sec:ports", G, "Ports exposés sur Internet", "warn",
                     "connu à corriger : " + "; ".join("%d %s" % (p, PORTS_KNOWN_WARN[p]) for p in known)
                     + " — autorisés : " + ",".join(str(p) for p in sorted(exposed) if p in PORTS_ALLOWED))
        else:
            self.add("sec:ports", G, "Ports exposés sur Internet", "ok",
                     "uniquement " + ",".join(str(p) for p in sorted(exposed)))

        # --- malware-guard ----------------------------------------------------
        last, errs = None, []
        try:
            with open(MALWARE_LOG, errors="replace") as f:
                lines = f.readlines()[-400:]
        except OSError:
            lines = []
        for l in lines:
            m = re.match(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(\S+)\s+(.*)", l.rstrip())
            if not m:
                continue
            ts = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
            if m.group(2) == "ERREUR" and NOW - ts < 3600:
                errs.append(m.group(3))
            if m.group(2) in ("HOOK", "ARR", "RPC", "DISK"):
                last = (ts, m.group(2), m.group(3))
        if errs:
            self.add("sec:malware_guard", G, "malware-guard", "crit",
                     "%d erreur(s) cette dernière heure : %s" % (len(errs), errs[-1][:100]))
        elif last:
            self.add("sec:malware_guard", G, "malware-guard", "ok", "dernier blocage %s (%s) — %s" % (
                time.strftime("%d/%m %H:%M", time.localtime(last[0])), last[1], last[2][:90]))
        else:
            self.add("sec:malware_guard", G, "malware-guard", "ok", "aucun événement journalisé")

        # --- filet : executables presents dans les downloads (= section 5 d'alert-check)
        rc, out, _ = sh(["find", "/mnt/media/downloads", "-type", "f", "-regextype", "posix-extended",
                         "-iregex", r".*\.(%s)$" % DANGEROUS_EXT], 60)
        files = [l for l in out.splitlines() if l.strip()]
        seen = self.state.setdefault("payload_seen", {})
        for f in list(seen):
            if f not in files:
                del seen[f]
        for f in files:
            seen.setdefault(f, NOW)
        if not files:
            self.add("sec:payload", G, "Exécutables dans les downloads", "ok", "aucun")
        else:
            old = [f for f in files if NOW - seen[f] > MALWARE_GRACE_S]
            names = ", ".join(os.path.basename(f) for f in (old or files)[:3])
            if old:
                self.add("sec:payload", G, "Exécutables dans les downloads", "crit",
                         "%d fichier(s) survivent à malware-guard depuis > %d min : %s"
                         % (len(old), MALWARE_GRACE_S // 60, names))
            else:
                self.add("sec:payload", G, "Exécutables dans les downloads", "warn",
                         "%d fichier(s), malware-guard doit les retirer : %s" % (len(files), names))

    # ================================================================ GLACIER
    def glacier(self):
        G = "glacier"
        names = ["sur Glacier", "restauration demandée", "en restauration", "prêt",
                 "rapatriement", "disponible"]
        try:
            items = json.load(open(GLACIER_DB))
            cnt = {}
            for it in items:
                s = it.get("Status")
                k = names[s] if isinstance(s, int) and 0 <= s < len(names) else str(s)
                cnt[k] = cnt.get(k, 0) + 1
            size = sum(it.get("FileSizeBytes") or 0 for it in items)
            self.add("glacier:items", G, "Films archivés", "ok", "%d items (%s) — %s" % (
                len(items), ", ".join("%d %s" % (v, k) for k, v in cnt.items()), human_bytes(size)))
        except (OSError, ValueError) as e:
            self.add("glacier:items", G, "Films archivés", "unknown", "base illisible : %s" % type(e).__name__)

        rc, out, _ = sh(["pgrep", "-fc", r"^/usr/bin/python3 /usr/bin/aws s3 cp"], 5)
        nproc = int(out.strip() or 0)
        self.add("glacier:uploads", G, "Uploads en cours", "ok",
                 "%d upload(s) aws s3 cp actif(s)" % nproc if nproc else "aucun")

        def mpu():
            xml = open(GLACIER_XML).read()
            ak = re.search(r"<ScalewayAccessKey>([^<]+)<", xml)
            sk = re.search(r"<ScalewaySecretKey>([^<]+)<", xml)
            bk = re.search(r"<BucketName>([^<]+)<", xml)
            rg = re.search(r"<Region>([^<]+)<", xml)
            if not (ak and sk and bk):
                raise RuntimeError("clés Glacier absentes du XML du plugin")
            region = rg.group(1) if rg else "fr-par"
            e = dict(os.environ, AWS_ACCESS_KEY_ID=ak.group(1), AWS_SECRET_ACCESS_KEY=sk.group(1),
                     AWS_DEFAULT_REGION=region)
            rc, out, _ = sh(["aws", "s3api", "list-multipart-uploads", "--bucket", bk.group(1),
                             "--output", "json", "--endpoint-url", "https://s3.%s.scw.cloud" % region], 60, env=e)
            if rc != 0:
                raise RuntimeError("list-multipart-uploads rc=%d" % rc)
            ups = json.loads(out or "{}").get("Uploads") or []
            return [dt.datetime.fromisoformat(u["Initiated"].replace("Z", "+00:00")).timestamp() for u in ups]
        try:
            ups, ts = self.cached("glacier_mpu", 3600, mpu)
            old = sorted(t for t in ups if NOW - t > 6 * 3600)
            orphans = max(0, len(old) - nproc)
            if orphans:
                self.add("glacier:mpu", G, "Multipart orphelins", "warn",
                         "%d upload(s) multipart abandonné(s) (le plus vieux : %s) — stockage facturé"
                         % (orphans, human_age(NOW - old[0])), ts)
            else:
                self.add("glacier:mpu", G, "Multipart orphelins", "ok",
                         "aucun (%d multipart en cours côté S3)" % len(ups), ts)
        except (RuntimeError, OSError) as e:
            self.add("glacier:mpu", G, "Multipart orphelins", "unknown", str(e)[:120])


# ---------------------------------------------------------------- notifications
def ntfy_send(env, title, msg, prio, tags):
    """curl -sf : True seulement si ntfy a accepte le message (2xx).
    Topic dans l'URL (argv, invisible hors root), token via stdin (--config -)."""
    topic, token = env.get("NTFY_TOPIC"), env.get("NTFY_TOKEN")
    if not topic:
        return False
    cfg = 'header = "Authorization: Bearer %s"\n' % token if token else ""
    rc, _, _ = sh(["curl", "-sf", "-o", "/dev/null", "--max-time", "15", "--config", "-",
                   "-H", "Title: " + title, "-H", "Priority: " + prio, "-H", "Tags: " + tags,
                   "-H", "Click: https://home.maxibestof.com/status",
                   "--data-binary", msg, "https://ntfy.sh/" + topic], 20, stdin=cfg)
    return rc == 0


def plan_notifications(checks, state):
    """Met a jour since/streaks et renvoie (nouveaux crit, retours ok) a notifier."""
    per = state.setdefault("checks", {})
    to_crit, to_ok = [], []
    for c in checks:
        p = per.setdefault(c["id"], {"state": c["state"], "since": NOW, "streak": 0, "notified": "ok"})
        if p["state"] != c["state"]:
            p["state"], p["since"], p["streak"] = c["state"], NOW, 1
        else:
            p["streak"] = p.get("streak", 0) + 1
        c["since"] = iso(p["since"])
        need = 1 if c["id"].startswith(IMMEDIATE_PREFIXES) else 2
        if c["state"] == "crit" and p.get("notified") != "crit" and p["streak"] >= need:
            to_crit.append(c)
        elif c["state"] == "ok" and p.get("notified") == "crit" and p["streak"] >= 2:
            to_ok.append(c)
    # checks disparus : on oublie leur etat (evite un "resolu" fantome plus tard)
    ids = {c["id"] for c in checks}
    for k in [k for k in per if k not in ids]:
        del per[k]
    return to_crit, to_ok


def notify(to_crit, to_ok, state, env):
    per = state["checks"]
    if to_crit:
        title = ("CRITIQUE — %s" % to_crit[0]["label"]) if len(to_crit) == 1 \
            else "CRITIQUE — %d problèmes" % len(to_crit)
        msg = "\n".join("• %s : %s" % (c["label"], c["detail"]) for c in to_crit)
        if ntfy_send(env, title, msg, "high", "rotating_light"):
            for c in to_crit:
                per[c["id"]]["notified"] = "crit"
        else:
            print("ntfy: échec d'envoi (crit), retenté à la prochaine collecte", file=sys.stderr)
    if to_ok:
        title = ("Résolu — %s" % to_ok[0]["label"]) if len(to_ok) == 1 \
            else "Résolu — %d points" % len(to_ok)
        msg = "\n".join("• %s : %s" % (c["label"], c["detail"]) for c in to_ok)
        if ntfy_send(env, title, msg, "low", "white_check_mark"):
            for c in to_ok:
                per[c["id"]]["notified"] = "ok"
        else:
            print("ntfy: échec d'envoi (résolu), retenté à la prochaine collecte", file=sys.stderr)


# ---------------------------------------------------------------- main
def write_atomic(path, data, mode):
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=STACK + "/status", help="dossier de sortie (status.json + state.json)")
    ap.add_argument("--no-notify", action="store_true", help="n'envoie rien a ntfy (tests)")
    a = ap.parse_args()
    os.makedirs(a.out, mode=0o755, exist_ok=True)
    state_path = os.path.join(a.out, "state.json")
    try:
        state = json.load(open(state_path))
    except (OSError, ValueError):
        state = {}

    t0 = time.time()
    c = Collector(state)
    try:
        insp = c.docker_inspect()
    except Exception as e:                           # noqa: BLE001
        insp = []
        c.add("container:docker", "containers", "Démon Docker", "crit", "docker inaccessible : %s" % e)
    for fn, cid, grp, lbl in (
            (c.storage, "storage:error", "storage", "Stockage"),
            (c.system, "sys:error", "system", "Système"),
            (c.tasks, "tasks:error", "tasks", "Tâches"),
            (lambda: c.containers(insp), "containers:error", "containers", "Conteneurs"),
            (lambda: c.network(insp), "net:error", "network", "Réseau"),
            (lambda: c.web(insp), "web:error", "web", "Web"),
            (lambda: c.security(insp), "sec:error", "security", "Sécurité"),
            (c.glacier, "glacier:error", "glacier", "Glacier")):
        c.safe(fn, cid, grp, lbl)

    to_crit, to_ok = plan_notifications(c.checks, state)
    if not a.no_notify:
        notify(to_crit, to_ok, state, read_env(ENV_FILE))
    elif to_crit or to_ok:
        print("--no-notify : %d crit et %d retour(s) ok auraient été notifiés"
              % (len(to_crit), len(to_ok)), file=sys.stderr)

    summary = {k: sum(1 for x in c.checks if x["state"] == k) for k in ("ok", "warn", "crit", "unknown")}
    summary["total"] = len(c.checks)
    summary["overall"] = "crit" if summary["crit"] else "warn" if summary["warn"] else \
        "unknown" if summary["unknown"] else "ok"
    out = {
        "generated": iso(), "generated_ts": int(NOW), "host": socket.gethostname(),
        "duration_ms": int((time.time() - t0) * 1000), "interval_s": 120,
        "summary": summary,
        "groups": [{"id": g, "label": l} for g, l in GROUPS],
        "checks": c.checks,
    }
    write_atomic(os.path.join(a.out, "status.json"), out, 0o644)
    write_atomic(state_path, state, 0o600)
    print("status: %(overall)s — ok %(ok)d, warn %(warn)d, crit %(crit)d, unknown %(unknown)d" % summary
          + " (%d ms)" % out["duration_ms"])


if __name__ == "__main__":
    main()
