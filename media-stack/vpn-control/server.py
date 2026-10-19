#!/usr/bin/env python3
"""Mini panneau de contrôle VPN gluetun (switch provider + pays).
Protégé en amont par oauth2-proxy (forwardAuth Traefik). Stdlib only."""
import http.server, socketserver, subprocess, urllib.parse, urllib.request, os, json, html, threading

STACK = "/srv/media-stack"
VPN_DIR = os.path.join(STACK, "vpn")
ACTIVE = os.path.join(VPN_DIR, "active.env")
APIKEY_FILE = "/gluetun-auth/.apikey.txt"
PORT = 8080
PROVIDERS = ("nordvpn", "mullvad")
# Seule origine autorisée pour un POST : bloque un formulaire posté depuis un autre
# *.maxibestof.com (le cookie OAuth est SameSite=lax sur tout le domaine).
ALLOWED_ORIGIN = "https://home.maxibestof.com"
# Une bascule à la fois : deux POST simultanés lançaient deux `compose up` en parallèle.
SWITCH_LOCK = threading.Lock()

# Pays NordVPN proposés (libellés acceptés par gluetun SERVER_COUNTRIES)
COUNTRIES = ["France", "Switzerland", "Netherlands", "Germany", "Romania",
             "Sweden", "United Kingdom", "Spain", "Italy", "United States"]


def read_env(path):
    d = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    d[k] = v
    except FileNotFoundError:
        pass
    return d


def gluetun_health():
    try:
        r = subprocess.run(["docker", "inspect", "--format", "{{.State.Health.Status}}", "gluetun"],
                           capture_output=True, text=True, timeout=10)
        return r.stdout.strip() or "?"
    except Exception:
        return "?"


def public_ip():
    try:
        key = open(APIKEY_FILE).read().strip()
        req = urllib.request.Request("http://host.docker.internal:8000/v1/publicip/ip",
                                     headers={"X-API-Key": key})
        return json.load(urllib.request.urlopen(req, timeout=8))
    except Exception:
        return {}


def netns_services():
    """Services en network_mode service:gluetun : à recréer quand gluetun l'est,
    sinon ils restent accrochés à l'ancien netns (plus de réseau ni de ports)."""
    r = subprocess.run(["docker", "compose", "config", "--format", "json"], cwd=STACK,
                       check=True, capture_output=True, text=True, timeout=60)
    svcs = json.loads(r.stdout)["services"]
    return sorted(n for n, d in svcs.items() if d.get("network_mode") == "service:gluetun")


def do_switch(provider, country):
    # Liste blanche stricte : provider servait à construire un chemin (../ → copie du
    # .env principal) et country était écrit tel quel dans active.env (un \n permettait
    # d'injecter n'importe quelle variable gluetun, ex. un endpoint WireGuard tiers).
    if provider not in PROVIDERS:
        return False, "Fournisseur inconnu"
    if provider == "nordvpn" and country not in COUNTRIES:
        return False, "Pays non proposé"
    if not SWITCH_LOCK.acquire(blocking=False):
        return False, "Une bascule est déjà en cours"
    try:
        return _do_switch(provider, country)
    finally:
        SWITCH_LOCK.release()


def _do_switch(provider, country):
    preset = os.path.join(VPN_DIR, provider + ".env")
    if not os.path.exists(preset):
        return False, "Preset introuvable : " + provider
    out, set_c = [], False
    with open(preset) as f:
        for line in f:
            if provider == "nordvpn" and line.startswith("SERVER_COUNTRIES="):
                out.append("SERVER_COUNTRIES=%s\n" % country); set_c = True
            else:
                out.append(line)
    if provider == "nordvpn" and not set_c and country:
        out.append("SERVER_COUNTRIES=%s\n" % country)
    tmp = ACTIVE + ".tmp"
    with open(tmp, "w") as f:
        f.writelines(out)
    os.chmod(tmp, 0o600)
    os.replace(tmp, ACTIVE)
    try:
        subprocess.run(["docker", "compose", "up", "-d", "gluetun"], cwd=STACK,
                       check=True, capture_output=True, text=True, timeout=120)
    except subprocess.CalledProcessError as e:
        return False, "Erreur recréation gluetun : " + (e.stderr or str(e))[:300]
    # attendre healthy
    healthy = False
    for _ in range(12):
        if gluetun_health() == "healthy":
            healthy = True; break
        subprocess.run(["sleep", "5"])
    if not healthy:
        return False, ("gluetun pas healthy (tunnel KO ?). "
                       "Si Mullvad : abonnement expiré. Vérifier: docker logs gluetun")
    try:
        subprocess.run(["docker", "compose", "up", "-d", "--force-recreate", "--no-deps"]
                       + netns_services(), cwd=STACK,
                       check=True, capture_output=True, text=True, timeout=300)
    except subprocess.CalledProcessError as e:
        return False, "gluetun OK mais relance des services KO : " + (e.stderr or str(e))[:300]
    return True, "Bascule effectuée sur %s%s." % (provider, " / " + country if provider == "nordvpn" else "")


def page(msg="", ok=None):
    env = read_env(ACTIVE)
    provider = env.get("VPN_SERVICE_PROVIDER", "?")
    country = env.get("SERVER_COUNTRIES", env.get("SERVER_CITIES", "—"))
    health = gluetun_health()
    ip = public_ip()
    dot = "#22c55e" if health == "healthy" else "#ef4444"
    opts = "".join('<option%s>%s</option>' % (" selected" if c == country else "", c) for c in COUNTRIES)
    banner = ""
    if msg:
        color = "#16a34a" if ok else "#dc2626"
        banner = '<div style="padding:12px;border-radius:8px;margin:12px 0;background:%s;color:#fff">%s</div>' % (color, html.escape(msg))
    return """<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Contrôle VPN</title>
<style>body{{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;max-width:560px;margin:40px auto;padding:0 16px}}
.card{{background:#1e293b;border-radius:12px;padding:24px;margin:16px 0}}
h1{{font-size:1.4rem}} .dot{{height:12px;width:12px;border-radius:50%;display:inline-block;background:{dot};margin-right:8px}}
label{{display:block;margin:14px 0 6px;font-size:.9rem;color:#94a3b8}}
select,button{{font-size:1rem;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;width:100%}}
button{{background:#2563eb;border:none;cursor:pointer;margin-top:18px;font-weight:600}}
button.alt{{background:#475569;margin-top:8px}} .muted{{color:#64748b;font-size:.85rem}}</style></head>
<body>
<h1>🔐 Contrôle VPN</h1>
{banner}
<div class="card">
  <div><span class="dot"></span><b>{provider}</b> — {country}</div>
  <div class="muted" style="margin-top:8px">Santé gluetun : {health}<br>IP publique : {ip} ({ipc})</div>
</div>
<form method="post" class="card">
  <label>Pays (NordVPN)</label>
  <select name="country">{opts}</select>
  <button name="provider" value="nordvpn">Appliquer NordVPN</button>
  <button class="alt" name="provider" value="mullvad">Basculer sur Mullvad (⚠ abonnement à vérifier)</button>
</form>
<p class="muted">Le changement recrée gluetun (~20 s) puis tous les services qui passent par le VPN.</p>
</body></html>""".format(dot=dot, banner=banner, provider=html.escape(provider),
                          country=html.escape(country), health=html.escape(health),
                          ip=html.escape(ip.get("public_ip", "—")),
                          ipc=html.escape(ip.get("country", "—")), opts=opts)


class H(http.server.BaseHTTPRequestHandler):
    def _send(self, body, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode())

    def do_GET(self):
        if self.path.rstrip("/") in ("", "/health"):
            if "health" in self.path:
                return self._send("ok")
        self._send(page())

    def do_POST(self):
        origin = self.headers.get("Origin") or self.headers.get("Referer", "")
        if not (origin == ALLOWED_ORIGIN or origin.startswith(ALLOWED_ORIGIN + "/")):
            return self._send(page("Origine refusée", False), 403)
        # Posé par oauth2-proxy via Traefik : absent = requête qui n'est pas passée par l'OAuth
        if not self.headers.get("X-Auth-Request-User"):
            return self._send(page("Non authentifié", False), 403)
        length = min(int(self.headers.get("Content-Length", 0)), 4096)
        data = urllib.parse.parse_qs(self.rfile.read(length).decode())
        provider = data.get("provider", [""])[0]
        country = data.get("country", [""])[0]
        ok, msg = do_switch(provider, country)
        self._send(page(msg, ok))

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("", PORT), H) as httpd:
    print("vpn-control listening on %d" % PORT, flush=True)
    httpd.serve_forever()
