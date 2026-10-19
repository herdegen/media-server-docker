#!/usr/bin/env python3
"""Console d'ops maxibestof — agrege Glances + gluetun en un seul JSON et sert
la page statique. Protege en amont par oauth2-proxy (forwardAuth Traefik).
Stdlib uniquement, meme parti pris que vpn-control/server.py.

Pourquoi un backend : Glances ecoute sur 172.17.0.1:61208 (jamais expose a
Internet) et la cle du control server gluetun ne doit pas finir dans du JS.
"""
import http.server, socketserver, urllib.request, urllib.error, urllib.parse
import json, os, time, threading, posixpath, hashlib, hmac, datetime
import concurrent.futures as cf
import xml.etree.ElementTree as ET

PORT = int(os.environ.get("PORT", "8080"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
GLANCES = os.environ.get("GLANCES_URL", "http://host.docker.internal:61208/api/4")
GLUETUN = os.environ.get("GLUETUN_URL", "http://host.docker.internal:8000")
APIKEY_FILE = "/gluetun-auth/.apikey.txt"
# /proc de l'hote, monte en LECTURE SEULE. Le conteneur garde son propre espace
# de PID : il lit des informations de processus, il ne peut pas les signaler.
# Progression d'archivage : lue cote S3 (octets reellement televerses).
# Ecarte : /proc/<pid>/io du processus `aws` — Docker retire CAP_SYS_PTRACE,
# donc illisible sans elever les privileges du conteneur.
SCW_AK = os.environ.get("SCW_ACCESS_KEY", "")
SCW_SK = os.environ.get("SCW_SECRET_KEY", "")
SCW_REGION = os.environ.get("SCW_REGION", "fr-par")
GLACIER_BUCKET = os.environ.get("GLACIER_BUCKET", "jellyfin-glacier")

# Geoloc du serveur : fixe (une machine ne bouge pas). Releve une fois via
# ipinfo.io le 2026-09-18 pour <SERVER_IP> -> OVH Lille.
SERVER_GEO = {
    "city": os.environ.get("SERVER_CITY", "Lille"),
    "country": os.environ.get("SERVER_COUNTRY", "France"),
    "lat": float(os.environ.get("SERVER_LAT", "50.6339")),
    "lon": float(os.environ.get("SERVER_LON", "3.0551")),
    "org": os.environ.get("SERVER_ORG", "OVH SAS"),
}

NET_IFACE = os.environ.get("NET_IFACE", "eno1")
HOST = "http://host.docker.internal"
JELLYFIN = os.environ.get("JELLYFIN_URL", HOST + ":8096")
K_SONARR = os.environ.get("HOMEPAGE_VAR_SONARR_KEY", "")
K_RADARR = os.environ.get("HOMEPAGE_VAR_RADARR_KEY", "")
K_PROWLARR = os.environ.get("HOMEPAGE_VAR_PROWLARR_KEY", "")
K_JELLYFIN = os.environ.get("HOMEPAGE_VAR_JELLYFIN_KEY", "")
# Jellyfin 12 : plus de X-Emby-Token ni de api_key= en query.
JF_AUTH = {"Authorization": 'MediaBrowser Token="%s"' % K_JELLYFIN}
DISK_MOUNT = "/mnt/media"
DISK_WARN = 90
MEM_WARN = 90
# Meme liste que les container_name du docker-compose.yml (lidarr, slskd,
# soularr, romarr manquaient : leur panne passait inapercue ici).
EXPECTED = ("gluetun flaresolverr prowlarr sonarr radarr transmission lidarr slskd "
            "soularr romarr media-mcp traefik oauth2-proxy homepage vpn-control "
            "ops-console glances bazarr jellyseerr").split()

# Page /status : JSON ecrit par status-collect.py (hote, root) et monte en :ro.
STATUS_JSON = os.environ.get("STATUS_JSON", "/status-data/status.json")
STATUS_STALE_S = 300            # > 5 min sans collecte = collecteur mort
# Topic ntfy : affiche UNIQUEMENT sur /api/status derriere l'OAuth (jamais
# journalise, jamais dans /api/status/summary lu par Homepage).
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")
NTFY_SERVER = os.environ.get("NTFY_SERVER", "ntfy.sh")
# Seule origine autorisee pour les POST (anti-CSRF same-site).
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "https://home.maxibestof.com")

FAST_TTL = 2.0                  # Glances : courbes temps reel
SLOW_TTL = 45.0                 # *arr / Transmission / Jellyfin / gluetun / S3
GEO_TTL, GEO_MAX = 6 * 3600, 256

_cache = {"ts": 0.0, "data": None}
_slow = {"ts": 0.0, "data": None}
_glacier = {"ts": 0.0, "data": None}
_geo = {}                      # ip -> (ts, dict) : borne a GEO_MAX, TTL GEO_TTL
_lock = threading.Lock()
_slock = threading.Lock()
_glock = threading.Lock()
_geolock = threading.Lock()
# Appels sortants en parallele : un service lent (timeout 6 s) ne retarde plus
# les autres, et la latence d'un cycle = celle du plus lent, pas la somme.
_pool = cf.ThreadPoolExecutor(max_workers=20, thread_name_prefix="poll")


def _get(url, headers=None, timeout=6):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def glances(plugin, default=None):
    try:
        return _get("%s/%s" % (GLANCES, plugin))
    except Exception:
        return default


def vpn_info():
    try:
        key = open(APIKEY_FILE).read().strip()
        d = _get(GLUETUN + "/v1/publicip/ip", {"X-API-Key": key})
        lat, lon = (d.get("location") or ",").split(",")[:2]
        return {
            "ip": d.get("public_ip", ""),
            "city": d.get("city", ""),
            "country": d.get("country", ""),
            "org": d.get("organization", ""),
            "timezone": d.get("timezone", ""),
            "lat": float(lat) if lat else None,
            "lon": float(lon) if lon else None,
        }
    except Exception as e:
        return {"error": "%s: %s" % (type(e).__name__, e)}


def temps(sensors):
    """Regroupe les sondes : le package CPU pilote la jauge, les coeurs les barres."""
    cores, pkg, others, warn, crit = [], None, [], 80.0, 100.0
    for s in sensors or []:
        if s.get("unit") not in ("C", "c"):
            continue
        lbl, val = str(s.get("label", "")), s.get("value")
        if not isinstance(val, (int, float)):
            continue
        w, c = s.get("warning") or 0, s.get("critical") or 0
        if lbl.lower().startswith("core"):
            cores.append({"label": lbl, "value": val})
            if w:
                warn = float(w)
            if c:
                crit = float(c)
        elif lbl.lower().startswith("package"):
            pkg = val
            if w:
                warn = float(w)
            if c:
                crit = float(c)
        else:
            others.append({"label": lbl, "value": val})
    allv = [x["value"] for x in cores + others] + ([pkg] if pkg is not None else [])
    return {"package": pkg, "cores": cores, "others": others,
            "warn": warn, "crit": crit, "max": max(allv) if allv else None}


def net_rates(network):
    for n in network or []:
        if n.get("interface_name") == NET_IFACE:
            return {"iface": NET_IFACE,
                    "rx": n.get("bytes_recv_rate_per_sec") or 0,
                    "tx": n.get("bytes_sent_rate_per_sec") or 0,
                    "rx_total": n.get("bytes_recv") or 0,
                    "tx_total": n.get("bytes_sent") or 0}
    return {"iface": NET_IFACE, "rx": 0, "tx": 0, "rx_total": 0, "tx_total": 0}


def media_fs(fs):
    for f in fs or []:
        if f.get("mnt_point") == DISK_MOUNT:
            return {"mnt": DISK_MOUNT, "percent": f.get("percent") or 0,
                    "free": f.get("free") or 0, "size": f.get("size") or 0,
                    "used": f.get("used") or 0}
    return {"mnt": DISK_MOUNT, "percent": 0, "free": 0, "size": 0, "used": 0}


def arr(base, key, path):
    try:
        return _get("%s/api/v3/%s" % (base, path), {"X-Api-Key": key})
    except Exception:
        return None


def svc_sonarr():
    d = arr(HOST + ":8989", K_SONARR, "series")
    if d is None:
        return {"up": False}
    eps = sum((x.get("statistics") or {}).get("episodeFileCount") or 0 for x in d)
    return {"up": True, "series": len(d), "episodes": eps,
            "url": "https://sonarr.maxibestof.com"}


def svc_radarr():
    d = arr(HOST + ":7878", K_RADARR, "movie")
    if d is None:
        return {"up": False}
    have = sum(1 for x in d if x.get("hasFile"))
    return {"up": True, "movies": len(d), "missing": len(d) - have,
            "url": "https://radarr.maxibestof.com"}


def svc_prowlarr():
    try:
        d = _get(HOST + ":9696/api/v1/indexer", {"X-Api-Key": K_PROWLARR})
    except Exception:
        return {"up": False}
    en = [i for i in d if i.get("enable")]
    return {"up": True, "indexers": len(en), "total": len(d),
            "url": "https://prowlarr.maxibestof.com"}


def svc_transmission():
    """RPC Transmission : premiere requete 409 + X-Transmission-Session-Id."""
    body = json.dumps({"method": "torrent-get",
                       "arguments": {"fields": ["name", "status", "percentDone", "eta",
                                                "rateDownload", "rateUpload", "totalSize"]}}).encode()
    url = HOST + ":9091/transmission/rpc"

    def call(sid):
        h = {"Content-Type": "application/json"}
        if sid:
            h["X-Transmission-Session-Id"] = sid
        req = urllib.request.Request(url, data=body, headers=h)
        return json.load(urllib.request.urlopen(req, timeout=6))

    try:
        try:
            d = call(None)
        except urllib.error.HTTPError as e:
            if e.code != 409:
                raise
            d = call(e.headers.get("X-Transmission-Session-Id"))
        t = (d.get("arguments") or {}).get("torrents") or []
        # status Transmission : 4 = telechargement, 6 = partage
        dl = [x for x in t if x.get("status") == 4]
        dl.sort(key=lambda x: -(x.get("percentDone") or 0))
        return {"up": True, "total": len(t),
                "downloading": len(dl),
                "seeding": sum(1 for x in t if x.get("status") == 6),
                "down": sum(x.get("rateDownload") or 0 for x in t),
                "up_rate": sum(x.get("rateUpload") or 0 for x in t),
                "active": [{"name": x.get("name") or "?",
                            "pct": round((x.get("percentDone") or 0) * 100, 1),
                            "eta": x.get("eta") if (x.get("eta") or -1) > 0 else None,
                            "rate": x.get("rateDownload") or 0,
                            "size": x.get("totalSize") or 0} for x in dl[:6]],
                "url": "https://transmission.maxibestof.com"}
    except Exception:
        return {"up": False}


def svc_jellyfin():
    try:
        c = _get(JELLYFIN + "/Items/Counts", JF_AUTH)
        return {"up": True, "movies": c.get("MovieCount") or 0,
                "series": c.get("SeriesCount") or 0,
                "episodes": c.get("EpisodeCount") or 0,
                "songs": c.get("SongCount") or 0,
                "url": "https://jellyfin.maxibestof.com"}
    except Exception:
        return {"up": False}


def viewer_geo(ip):
    """Geoloc du visiteur, mise en cache : une seule sortie vers ipinfo par IP."""
    if not ip or ip.startswith(("10.", "192.168.", "172.", "127.")):
        return {"ip": ip, "private": True}
    now = time.time()
    with _geolock:
        hit = _geo.get(ip)
        if hit and now - hit[0] < GEO_TTL:
            return hit[1]
    g = {"ip": ip}
    try:
        d = _get("https://ipinfo.io/%s/json" % ip, timeout=5)
        lat, lon = (d.get("loc") or ",").split(",")[:2]
        g.update({"city": d.get("city") or "", "country": d.get("country") or "",
                  "org": d.get("org") or "",
                  "lat": float(lat) if lat else None,
                  "lon": float(lon) if lon else None})
    except Exception:
        pass
    with _geolock:
        _geo[ip] = (now, g)
        # purge : entrees expirees, puis les plus anciennes au-dela de GEO_MAX
        for k in [k for k, v in _geo.items() if now - v[0] >= GEO_TTL]:
            _geo.pop(k, None)
        if len(_geo) > GEO_MAX:
            for k, _ in sorted(_geo.items(), key=lambda kv: kv[1][0])[:len(_geo) - GEO_MAX]:
                _geo.pop(k, None)
    return g


_arch_prev = {}          # cle S3 -> (horodatage, octets), pour le debit
_size_cache = {}         # itemId -> (taille, titre)


def _s3_get(query, path="/"):
    """GET S3 signe en SigV4, sans dependance externe (stdlib uniquement).

    `path` compte : ListParts s'adresse a l'OBJET (GET /<key>?uploadId=...),
    la cle ne peut pas etre passee en parametre de requete.
    """
    host = "%s.s3.%s.scw.cloud" % (GLACIER_BUCKET, SCW_REGION)
    cpath = urllib.parse.quote(path, safe="/~")
    t = datetime.datetime.now(datetime.timezone.utc)
    amz, ds = t.strftime("%Y%m%dT%H%M%SZ"), t.strftime("%Y%m%d")
    ph = hashlib.sha256(b"").hexdigest()
    cq = "&".join("%s=%s" % (k, urllib.parse.quote(str(v), safe="~"))
                  for k, v in sorted(query.items()))
    ch = "host:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n" % (host, ph, amz)
    sh = "host;x-amz-content-sha256;x-amz-date"
    creq = "GET\n%s\n%s\n%s\n%s\n%s" % (cpath, cq, ch, sh, ph)
    scope = "%s/%s/s3/aws4_request" % (ds, SCW_REGION)
    sts = "AWS4-HMAC-SHA256\n%s\n%s\n%s" % (amz, scope,
                                             hashlib.sha256(creq.encode()).hexdigest())

    def sg(k, m):
        return hmac.new(k, m.encode(), hashlib.sha256).digest()

    key = sg(sg(sg(sg(("AWS4" + SCW_SK).encode(), ds), SCW_REGION), "s3"), "aws4_request")
    sig = hmac.new(key, sts.encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request("https://%s%s?%s" % (host, cpath, cq), headers={
        "Host": host, "x-amz-date": amz, "x-amz-content-sha256": ph,
        "Authorization": "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s"
                         % (SCW_AK, scope, sh, sig)})
    with urllib.request.urlopen(req, timeout=12) as r:
        return ET.fromstring(r.read())


def _tag(el, name):
    for c in el:
        if c.tag.rsplit("}", 1)[-1] == name:
            return c
    return None


def _findall(root, name):
    return [e for e in root.iter() if e.tag.rsplit("}", 1)[-1] == name]


def _uploaded_bytes(key, upload_id):
    """Somme des parts deja televersees (ListParts, pagine)."""
    total, marker = 0, None
    for _ in range(12):                       # garde-fou : 12 pages max
        q = {"uploadId": upload_id, "max-parts": 1000}
        if marker:
            q["part-number-marker"] = marker
        root = _s3_get(q, "/" + key)
        for pt in _findall(root, "Part"):
            sz = _tag(pt, "Size")
            if sz is not None and sz.text:
                total += int(sz.text)
        tr = _tag(root, "IsTruncated")
        nm = _tag(root, "NextPartNumberMarker")
        if tr is None or (tr.text or "").lower() != "true" or nm is None:
            break
        marker = nm.text
    return total


def _item_size(item_id):
    """Taille et titre du film, via Jellyfin (mis en cache)."""
    if item_id in _size_cache:
        return _size_cache[item_id]
    res = (0, item_id)
    try:
        d = _get(JELLYFIN + "/Items?ids=%s&Fields=MediaSources" % urllib.parse.quote(item_id),
                 JF_AUTH, timeout=12)
        it = (d.get("Items") or [None])[0]
        if it:
            res = ((it.get("MediaSources") or [{}])[0].get("Size") or 0, it.get("Name") or item_id)
    except Exception:
        pass
    _size_cache[item_id] = res
    return res


def archives_in_flight():
    """Archivages en cours, vus depuis S3.

    Le plugin lance `aws s3 cp` en tache de fond et n'ecrit l'item en base qu'a
    la fin : son API est muette pendant l'upload (pas meme de statut
    « Uploading »). En revanche l'upload multipart est visible cote bucket :
    ListMultipartUploads donne les transferts en cours, ListParts les octets
    deja arrives. C'est la mesure la plus juste, et elle ne demande aucun
    privilege supplementaire au conteneur.
    """
    if not (SCW_AK and SCW_SK):
        return []
    out, now, live = [], time.time(), set()
    try:
        root = _s3_get({"uploads": ""})
    except Exception:
        return []
    for up in _findall(root, "Upload"):
        k, u = _tag(up, "Key"), _tag(up, "UploadId")
        if k is None or u is None:
            continue
        key, uid = k.text or "", u.text or ""
        item_id = key.rsplit("/", 1)[-1]
        if item_id.endswith(".mkv"):
            item_id = item_id[:-4]
        try:
            done = _uploaded_bytes(key, uid)
        except Exception:
            continue
        size, title = _item_size(item_id)
        live.add(key)
        prev = _arch_prev.get(key)
        rate = max(0.0, (done - prev[1]) / (now - prev[0])) if prev and now > prev[0] else 0.0
        _arch_prev[key] = (now, done)
        started = _tag(up, "Initiated")
        out.append({
            "itemId": item_id, "name": title, "key": key,
            "pct": round(done * 100.0 / size, 1) if size else None,
            "done": done, "size": size, "rate": rate,
            "since": started.text if started is not None else None,
            "eta": int((size - done) / rate) if (rate > 1024 and size > done) else None,
        })
    for dead in [x for x in _arch_prev if x not in live]:
        _arch_prev.pop(dead, None)
    return out


def glacier_archived():
    """ItemIds deja sur Glacier (ou en cours) : a exclure des suggestions."""
    try:
        d = _get(JELLYFIN + "/Glacier/items", JF_AUTH, timeout=10)
        return {str(x.get("JellyfinItemId")): (x.get("Status") or "") for x in d or []}
    except Exception:
        return {}


def glacier_candidates(limit=8):
    """Films a archiver : gros ET pas touches depuis longtemps.

    Le "touche" est agrege sur TOUS les comptes Jellyfin (un film vu par
    Marion ne doit pas etre propose parce que le compte admin ne l'a pas vu).
    Score = Go x (1 + anciennete en mois / 12) -> le volume prime, l'oubli pese.
    """
    try:
        users = [u.get("Id") for u in _get(JELLYFIN + "/Users", JF_AUTH, timeout=10) or []]
    except Exception:
        return {"error": "Jellyfin injoignable", "items": []}
    if not users:
        return {"error": "aucun compte Jellyfin", "items": []}

    on_glacier = glacier_archived()
    best = {}
    for uid in users:
        try:
            q = ("/Items?userId=%s&IncludeItemTypes=Movie&Recursive=true"
                 "&Fields=MediaSources,DateCreated&Limit=2000") % urllib.parse.quote(uid)
            items = (_get(JELLYFIN + q, JF_AUTH, timeout=25) or {}).get("Items") or []
        except Exception:
            continue
        for it in items:
            iid = it.get("Id")
            if not iid or iid in on_glacier:
                continue
            ud = it.get("UserData") or {}
            rec = best.setdefault(iid, {
                "id": iid, "name": it.get("Name") or "?",
                "size": (it.get("MediaSources") or [{}])[0].get("Size") or 0,
                "added": (it.get("DateCreated") or "")[:10],
                "played": False, "last": None,
            })
            if ud.get("Played"):
                rec["played"] = True
            lp = ud.get("LastPlayedDate")
            if lp and (rec["last"] is None or lp > rec["last"]):
                rec["last"] = lp

    now = time.time()
    out = []
    for r in best.values():
        gb = r["size"] / 1073741824.0
        if gb < 1.5:                      # en dessous, l'archivage ne vaut pas le coup
            continue
        ref = r["last"] or (r["added"] + "T00:00:00")
        try:
            t = time.mktime(time.strptime(ref[:10], "%Y-%m-%d"))
            months = max(0.0, (now - t) / 2629800.0)
        except Exception:
            months = 0.0
        r["months"] = round(months, 1)
        r["gb"] = round(gb, 2)
        r["score"] = round(gb * (1 + months / 12.0), 1)
        out.append(r)
    out.sort(key=lambda x: -x["score"])
    return {"items": out[:limit], "pool": len(out), "archived": len(on_glacier)}


def glacier_cached():
    with _glock:
        if _glacier["data"] is None or time.time() - _glacier["ts"] > 600:
            _glacier["data"] = glacier_candidates()
            _glacier["ts"] = time.time()
        return _glacier["data"]


def glacier_archive(item_id):
    """Declenche l'archivage cote plugin Jellyfin (POST .../archive)."""
    url = JELLYFIN + "/Glacier/items/%s/archive" % urllib.parse.quote(item_id)
    req = urllib.request.Request(url, data=b"", method="POST", headers=JF_AUTH)
    with urllib.request.urlopen(req, timeout=20) as r:
        body = r.read(2000).decode("utf-8", "replace")
    with _glock:                       # la liste change : on invalide le cache
        _glacier["ts"] = 0.0
    return {"ok": True, "detail": body[:200]}


def build_checks(cpu, load, mem, tmp, fs, vpn, containers):
    """Les 'lignes d'admin' : chaque entree est verifiable, aucune n'est decorative."""
    out = []

    def add(cid, label, state, detail):
        out.append({"id": cid, "label": label, "state": state, "detail": detail})

    names = {c.get("name"): (c.get("status") or "") for c in containers or []}
    missing = [n for n in EXPECTED if n not in names]
    # "starting" = start-period d'un HEALTHCHECK, pas une panne : sinon la
    # console se declare elle-meme hors service apres chaque rebuild.
    UP = ("running", "healthy", "starting")
    stopped = [n for n in EXPECTED if n in names and names[n] not in UP]
    if missing or stopped:
        add("containers", "conteneurs du stack", "fail",
            "absent : %s | hors service : %s" % (",".join(missing) or "-", ",".join(stopped) or "-"))
    else:
        add("containers", "conteneurs du stack", "ok", "%d/%d actifs" % (len(EXPECTED), len(EXPECTED)))

    g = names.get("gluetun", "absent")
    add("gluetun", "tunnel VPN gluetun", "ok" if g == "healthy" else "fail", "état : %s" % g)

    if vpn.get("error") or not vpn.get("ip"):
        add("vpnleak", "étanchéité du tunnel", "fail", "IP VPN illisible")
    else:
        add("vpnleak", "étanchéité du tunnel", "ok",
            "sortie %s (%s)" % (vpn["ip"], vpn.get("country") or "?"))

    p = fs["percent"]
    add("disk", "espace /mnt/media", "warn" if p >= DISK_WARN else "ok",
        "%.0f %% occupé, %.0f Go libres" % (p, fs["free"] / 1073741824))

    mp = (mem or {}).get("percent") or 0
    add("mem", "mémoire vive", "warn" if mp >= MEM_WARN else "ok", "%.0f %% utilisée" % mp)

    if tmp.get("max") is None:
        add("temp", "températures", "warn", "aucune sonde")
    else:
        st = "fail" if tmp["max"] >= tmp["crit"] else ("warn" if tmp["max"] >= tmp["warn"] * 0.85 else "ok")
        add("temp", "températures", st, "max %.0f °C (seuil %.0f)" % (tmp["max"], tmp["warn"]))

    l1, cores = (load or {}).get("min1") or 0, (load or {}).get("cpucore") or 1
    add("load", "charge système", "warn" if l1 > cores else "ok",
        "load1 %.2f pour %d cœurs" % (l1, cores))

    io = (cpu or {}).get("iowait") or 0
    add("iowait", "attente disque CPU", "warn" if io >= 10 else "ok", "iowait %.1f %%" % io)
    return out


def _gather(jobs, timeout):
    """Lance {cle: (fn, args, defaut)} en parallele ; un job trop lent ou en
    erreur rend son defaut au lieu de bloquer le cycle."""
    futs = {k: _pool.submit(fn, *args) for k, (fn, args, _) in jobs.items()}
    out = {}
    for k, f in futs.items():
        try:
            out[k] = f.result(timeout=timeout)
        except Exception:
            out[k] = jobs[k][2]
    return out


def _refresh_slow():
    try:
        r = _gather({
            "sonarr": (svc_sonarr, (), {"up": False}),
            "radarr": (svc_radarr, (), {"up": False}),
            "prowlarr": (svc_prowlarr, (), {"up": False}),
            "transmission": (svc_transmission, (), {"up": False}),
            "jellyfin": (svc_jellyfin, (), {"up": False}),
            "vpn": (vpn_info, (), {"error": "timeout"}),
            "archiving": (archives_in_flight, (), []),
        }, timeout=20)
        _slow["data"] = r
        _slow["ts"] = time.time()
    finally:
        _slock.release()


def slow_part():
    """Services *arr, Transmission, Jellyfin, gluetun, S3 : cache SLOW_TTL.
    Rafraichi en ARRIERE-PLAN par un seul thread : les courbes Glances (2 s)
    n'attendent jamais un service lent ; on sert la valeur precedente.
    Seul le tout premier appel attend (rien a servir sinon)."""
    if _slow["data"] is not None and time.time() - _slow["ts"] < SLOW_TTL:
        return _slow["data"]
    first = _slow["data"] is None
    if _slock.acquire(blocking=first):
        if first and _slow["data"] is not None:      # un autre thread a fini entre-temps
            _slock.release()
        elif first:
            _refresh_slow()                          # libere le verrou
        else:
            threading.Thread(target=_refresh_slow, daemon=True).start()
    return _slow["data"]


def snapshot():
    """Glances (cache FAST_TTL) en parallele + partie lente mise en cache."""
    g = _gather({
        "cpu": (glances, ("cpu", {}), {}),
        "load": (glances, ("load", {}), {}),
        "mem": (glances, ("mem", {}), {}),
        "sensors": (glances, ("sensors", []), []),
        "network": (glances, ("network", []), []),
        "fs": (glances, ("fs", []), []),
        "containers": (glances, ("containers", []), []),
        "uptime": (glances, ("uptime", ""), ""),
    }, timeout=7)
    sl = slow_part()
    cpu, load, mem = g["cpu"] or {}, g["load"] or {}, g["mem"] or {}
    tmp = temps(g["sensors"])
    net = net_rates(g["network"])
    fs = media_fs(g["fs"])
    containers = g["containers"] or []
    upt = g["uptime"]
    vpn = sl["vpn"]
    return {
        "ts": time.time(),
        "cpu": {"total": cpu.get("total") or 0, "user": cpu.get("user") or 0,
                "system": cpu.get("system") or 0, "iowait": cpu.get("iowait") or 0,
                "idle": cpu.get("idle") or 0},
        "load": {"min1": load.get("min1") or 0, "min5": load.get("min5") or 0,
                 "min15": load.get("min15") or 0, "cores": load.get("cpucore") or 1},
        "mem": {"percent": mem.get("percent") or 0, "used": mem.get("used") or 0,
                "total": mem.get("total") or 0},
        "temp": tmp, "net": net, "fs": fs,
        "vpn": vpn, "server": SERVER_GEO,
        "uptime": upt if isinstance(upt, str) else "",
        "containers": [{"name": c.get("name"), "status": c.get("status")} for c in containers],
        "archiving": sl["archiving"],
        "services": {k: sl[k] for k in ("sonarr", "radarr", "prowlarr", "transmission", "jellyfin")},
        "checks": build_checks(cpu, load, mem, tmp, fs, vpn, containers),
        "thresholds": {"disk_warn": DISK_WARN, "mem_warn": MEM_WARN},
    }


def cached():
    """Un seul rafraichissement a la fois ; pendant ce temps les autres
    requetes repartent avec la derniere valeur connue (pas d'attente)."""
    if _cache["data"] is not None and time.time() - _cache["ts"] <= FAST_TTL:
        return _cache["data"]
    if not _lock.acquire(blocking=_cache["data"] is None):
        return _cache["data"]
    try:
        if _cache["data"] is None or time.time() - _cache["ts"] > FAST_TTL:
            try:
                _cache["data"] = snapshot()
                _cache["ts"] = time.time()
            except Exception as e:
                if _cache["data"] is None:
                    _cache["data"] = {"error": "%s: %s" % (type(e).__name__, e)}
        return _cache["data"]
    finally:
        _lock.release()


def status_payload(authed):
    """Lit le JSON du collecteur et ajoute l'age (detection collecteur mort)."""
    try:
        with open(STATUS_JSON, "rb") as f:
            d = json.load(f)
    except FileNotFoundError:
        return {"error": "status.json absent : collecteur jamais lance ?",
                "stale": True, "age_s": None}
    except Exception as e:
        return {"error": "status.json illisible : %s" % type(e).__name__,
                "stale": True, "age_s": None}
    age = time.time() - float(d.get("generated_ts") or 0)
    d["age_s"] = int(age)
    d["stale"] = age > STATUS_STALE_S
    if authed and NTFY_TOPIC:
        d["notify"] = {"server": NTFY_SERVER, "topic": NTFY_TOPIC,
                       "https": "https://%s/%s" % (NTFY_SERVER, NTFY_TOPIC),
                       "app": "ntfy://%s/%s" % (NTFY_SERVER, NTFY_TOPIC)}
    return d


def status_summary():
    """Resume minimal pour la tuile Homepage (customapi). Jamais le topic."""
    d = status_payload(False)
    s = dict(d.get("summary") or {})
    for k in ("ok", "warn", "crit", "unknown", "total"):
        s.setdefault(k, 0)
    if d.get("error"):
        s["overall"] = "stale"
    elif d.get("stale"):
        s["overall"] = "stale"
    s.setdefault("overall", "unknown")
    s["age_min"] = round((d.get("age_s") or 0) / 60.0, 1) if d.get("age_s") is not None else None
    s["generated"] = d.get("generated")
    return s


MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json"}


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ops-console"

    def log_message(self, fmt, *a):
        pass  # les logs utiles sont ceux de Traefik

    def client_ip(self):
        """IP reelle du visiteur : on est derriere Traefik + oauth2-proxy, donc
        l'adresse de socket est celle du proxy. On prend le premier maillon de
        X-Forwarded-For (le client), pas le dernier (le proxy)."""
        xff = self.headers.get("X-Forwarded-For", "")
        if xff:
            return xff.split(",")[0].strip()
        return self.headers.get("X-Real-IP") or self.client_address[0]

    def _same_origin(self):
        """Anti-CSRF : le cookie OAuth est SameSite, mais un sous-domaine
        compromis (*.maxibestof.com = meme "site") pourrait encore poster.
        On exige donc Origin (ou a defaut Referer) == home.maxibestof.com."""
        origin = self.headers.get("Origin")
        if origin:
            return origin.rstrip("/") == ALLOWED_ORIGIN
        ref = self.headers.get("Referer") or ""
        return ref == ALLOWED_ORIGIN or ref.startswith(ALLOWED_ORIGIN + "/")

    def do_POST(self):
        path = self.path.split("?")[0]
        if path.startswith("/ops/"):
            path = path[4:]
        if path != "/api/glacier/archive":
            return self._send(404, '{"error":"not found"}', "application/json")
        if not self._same_origin():
            return self._send(403, '{"ok":false,"error":"origine refusee"}', "application/json")
        # application/json impose un preflight CORS : un <form> cross-site ne
        # peut pas l'envoyer (text/plain, urlencoded et multipart sont refuses).
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self._send(415, '{"ok":false,"error":"Content-Type application/json requis"}',
                              "application/json")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(min(n, 4096)) or b"{}")
            iid = str(req.get("itemId") or "")
            if not iid or not iid.replace("-", "").isalnum():
                raise ValueError("itemId invalide")
            return self._send(200, json.dumps(glacier_archive(iid)),
                              "application/json; charset=utf-8")
        except Exception as e:
            return self._send(400, json.dumps({"ok": False,
                              "error": "%s: %s" % (type(e).__name__, e)}),
                              "application/json; charset=utf-8")

    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        # Derriere Traefik le prefixe /ops est deja strippe, mais la page porte
        # <base href="/ops/">. On accepte les deux formes : ainsi le service
        # reste testable en direct et survit au retrait du middleware.
        if path == "/ops" or path.startswith("/ops/"):
            path = path[4:] or "/"
        # Les assets vivent sous /_ops/ : ce prefixe n'est revendique que par la
        # console, donc Homepage peut rester le catch-all du domaine sans conflit.
        if path.startswith("/_ops/"):
            path = path[5:]
        if path in ("/api/state", "/api/state/"):
            d = dict(cached())
            d["viewer"] = viewer_geo(self.client_ip())
            return self._send(200, json.dumps(d), "application/json; charset=utf-8")
        if path in ("/api/status", "/api/status/"):
            # X-Auth-Request-* est pose par Traefik (forwardAuth, ecrase toute
            # valeur envoyee par le client) : present = requete passee par l'OAuth.
            authed = bool(self.headers.get("X-Auth-Request-User")
                          or self.headers.get("X-Auth-Request-Email"))
            return self._send(200, json.dumps(status_payload(authed)),
                              "application/json; charset=utf-8")
        if path in ("/api/status/summary", "/api/status/summary/"):
            return self._send(200, json.dumps(status_summary()), "application/json; charset=utf-8")
        if path in ("/status", "/status/"):
            path = "/status.html"
        if path in ("/api/glacier", "/api/glacier/"):
            return self._send(200, json.dumps(glacier_cached()), "application/json; charset=utf-8")
        if path in ("/health", "/healthz"):
            return self._send(200, '{"ok":true}', "application/json")
        # statique, sans traversee de repertoire
        rel = posixpath.normpath(path.lstrip("/")) or "index.html"
        if rel.startswith("..") or os.path.isabs(rel):
            return self._send(403, "forbidden", "text/plain")
        full = os.path.join(STATIC, rel)
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            full = os.path.join(STATIC, "index.html")
        ext = os.path.splitext(full)[1]
        try:
            with open(full, "rb") as f:
                return self._send(200, f.read(), MIME.get(ext, "application/octet-stream"))
        except OSError:
            return self._send(404, "not found", "text/plain")


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    Server((os.environ.get("BIND", ""), PORT), H).serve_forever()
