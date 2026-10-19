/* ==========================================================================
   Page /status — rendu de /api/status (JSON ecrit par status-collect.py).
   Regle : AUCUNE donnee n'entre dans le DOM par innerHTML ; tout passe par
   createElement + textContent (les details viennent de logs, noms de
   torrents, etc. : contenu non maitrise).
   ========================================================================== */
"use strict";

var POLL_MS = 30000;
var STATES = { ok: "OK", warn: "ALERTE", crit: "CRIT", unknown: "?" };
var OVERALL = {
  ok: "OPÉRATIONNEL", warn: "SOUS SURVEILLANCE", crit: "CRITIQUE",
  unknown: "INCOMPLET", stale: "COLLECTEUR MUET"
};
var ORDER = { crit: 0, warn: 1, unknown: 2, ok: 3 };
var openState = loadPref("st-open", {});      // groupe -> true/false choisi par l'utilisateur
var problemsOnly = loadPref("st-problems", false);
var last = null;

function el(id) { return document.getElementById(id); }
function txt(id, v) { var n = el(id); if (n) n.textContent = v; }
function mk(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function loadPref(k, d) {
  try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }
  catch (e) { return d; }
}
function savePref(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* prive */ } }

function ago(iso) {
  if (!iso) return "—";
  var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return Math.round(s) + " s";
  if (s < 5400) return Math.round(s / 60) + " min";
  if (s < 172800) return (s / 3600).toFixed(1) + " h";
  return Math.round(s / 86400) + " j";
}
function hhmm(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return "—";
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return p(d.getDate()) + "/" + p(d.getMonth() + 1) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) +
    ":" + p(d.getSeconds());
}
function safeState(s) { return Object.prototype.hasOwnProperty.call(STATES, s) ? s : "unknown"; }

/* ---------------------------------------------------------------- rendu */
function render(d) {
  last = d;
  link(true);
  var sum = d.summary || {};
  var overall = d.error || d.stale ? "stale" : safeState(sum.overall);

  el("hero").dataset.state = overall;
  txt("overall", OVERALL[overall] || "—");
  txt("n-ok", sum.ok != null ? sum.ok : "—");
  txt("n-warn", sum.warn != null ? sum.warn : "—");
  txt("n-crit", sum.crit != null ? sum.crit : "—");
  txt("n-unknown", sum.unknown != null ? sum.unknown : "—");
  txt("gen", d.generated ? hhmm(d.generated) + " (il y a " + ago(d.generated) + ")" : "—");
  txt("host", d.host || "—");
  txt("overall-sub", d.error ? d.error :
    (sum.total || 0) + " contrôles · collecte en " + (d.duration_ms != null ? d.duration_ms + " ms" : "?") +
    " · toutes les " + Math.round((d.interval_s || 120) / 60) + " min");

  var stale = el("stale");
  if (d.error || d.stale) {
    stale.hidden = false;
    txt("stale-txt", d.error ? d.error :
      "Dernière collecte il y a " + ago(d.generated) + " (> 5 min) : status-collect.timer est arrêté " +
      "ou en échec. Les états ci-dessous sont PÉRIMÉS. → systemctl status status-collect.service");
  } else {
    stale.hidden = true;
  }
  document.title = (overall === "ok" ? "✓ " : overall === "warn" ? "! " : "✗ ") + "maxibestof — statut";

  renderGroups(d.groups || [], d.checks || []);
  renderNotify(d.notify);
}

function renderGroups(groups, checks) {
  var box = el("groups");
  var byGroup = {};
  checks.forEach(function (c) { (byGroup[c.group] = byGroup[c.group] || []).push(c); });
  // groupes declares d'abord, puis tout groupe inattendu
  var ids = groups.map(function (g) { return g.id; });
  Object.keys(byGroup).forEach(function (g) { if (ids.indexOf(g) < 0) { ids.push(g); groups.push({ id: g, label: g }); } });

  var frag = document.createDocumentFragment();
  groups.forEach(function (g) {
    var list = (byGroup[g.id] || []).slice();
    if (!list.length) return;
    list.sort(function (a, b) {
      return (ORDER[safeState(a.state)] - ORDER[safeState(b.state)]) || 0;
    });
    var cnt = { ok: 0, warn: 0, crit: 0, unknown: 0 };
    list.forEach(function (c) { cnt[safeState(c.state)]++; });
    var worst = cnt.crit ? "crit" : cnt.warn ? "warn" : cnt.unknown ? "unknown" : "ok";

    var det = mk("details", "panel wide st-group " + worst + (worst === "ok" ? " allok" : ""));
    det.dataset.group = g.id;
    // ouvert par defaut si probleme ; sinon le choix memorise de l'utilisateur
    var pref = openState[g.id];
    det.open = pref == null ? worst !== "ok" : !!pref;
    det.addEventListener("toggle", function () {
      openState[g.id] = det.open; savePref("st-open", openState);
    });

    var sm = mk("summary");
    var tag = mk("span", "", STATES[worst]);
    var row = mk("span", "st-row " + worst); // pour reutiliser la couleur du tag
    row.style.display = "contents";
    tag.className = "tag";
    row.appendChild(tag);
    sm.appendChild(row);
    sm.appendChild(mk("span", "st-gname", g.label || g.id));
    var parts = [];
    if (cnt.crit) parts.push(cnt.crit + " crit");
    if (cnt.warn) parts.push(cnt.warn + " alerte");
    if (cnt.unknown) parts.push(cnt.unknown + " ?");
    parts.push(cnt.ok + "/" + list.length + " ok");
    sm.appendChild(mk("span", "st-gcount", parts.join(" · ")));
    det.appendChild(sm);

    var rows = mk("div", "st-rows");
    list.forEach(function (c) {
      var st = safeState(c.state);
      var r = mk("div", "st-row " + st);
      r.appendChild(mk("span", "tag", STATES[st]));
      r.appendChild(mk("span", "lb", c.label || c.id));
      r.appendChild(mk("span", "dt", c.detail || "—"));
      var sn = mk("span", "sn", "depuis " + ago(c.since));
      sn.title = "état depuis " + hhmm(c.since) + " · mesuré " + hhmm(c.updated);
      r.appendChild(sn);
      rows.appendChild(r);
    });
    det.appendChild(rows);
    frag.appendChild(det);
  });
  box.textContent = "";
  box.appendChild(frag);
  box.classList.toggle("problems", !!problemsOnly);
}

function renderNotify(n) {
  var box = el("notify-box");
  var missing = el("notify-missing");
  Array.prototype.slice.call(box.querySelectorAll(".st-link")).forEach(function (x) { x.remove(); });
  // topic ntfy : uniquement [A-Za-z0-9_-] (on refuse tout le reste plutot que d'echapper)
  if (!n || !/^[A-Za-z0-9_-]{1,64}$/.test(n.topic || "") || !/^[A-Za-z0-9.-]+$/.test(n.server || "")) {
    missing.hidden = false;
    return;
  }
  missing.hidden = true;
  txt("notify-server", n.server);
  [["topic", null, n.topic], ["web", "https://" + n.server + "/" + n.topic, null],
   ["app", "ntfy://" + n.server + "/" + n.topic, null]].forEach(function (x) {
    var line = mk("div", "st-link");
    line.appendChild(mk("span", "k", x[0]));
    if (x[1]) {
      var a = mk("a", "mono", x[1]);
      a.setAttribute("href", x[1]);
      a.setAttribute("rel", "noopener noreferrer");
      line.appendChild(a);
    } else {
      line.appendChild(mk("span", "mono", x[2]));
    }
    box.insertBefore(line, missing);
  });
}

function link(up, msg) {
  var n = el("link-state");
  n.className = up ? "v up" : "v down";
  n.textContent = up ? "actif · 30 s" : ("rompu — " + (msg || "injoignable"));
}

/* ---------------------------------------------------------------- boucle */
function tick() {
  fetch("/api/status", { cache: "no-store", credentials: "same-origin" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      // session OAuth expiree : on recoit une page HTML de connexion, pas du JSON
      var ct = r.headers.get("Content-Type") || "";
      if (ct.indexOf("application/json") < 0) throw new Error("session expirée ? recharger la page");
      return r.json();
    })
    .then(render)
    .catch(function (e) { link(false, e.message); if (last) markAges(); });
}
/* sans reseau, on continue au moins a faire vieillir les "il y a" */
function markAges() { if (last && last.generated) txt("gen", hhmm(last.generated) + " (il y a " + ago(last.generated) + ")"); }

var timer = null;
function start() { if (!timer) { tick(); timer = setInterval(tick, POLL_MS); } }
function stop() { if (timer) { clearInterval(timer); timer = null; } }
document.addEventListener("visibilitychange", function () { document.hidden ? stop() : start(); });

/* ---------------------------------------------------------------- boutons */
el("btn-open").addEventListener("click", function () {
  Array.prototype.forEach.call(document.querySelectorAll(".st-group"), function (d) { d.open = true; });
});
el("btn-close").addEventListener("click", function () {
  Array.prototype.forEach.call(document.querySelectorAll(".st-group"), function (d) { d.open = false; });
});
var bp = el("btn-problems");
bp.setAttribute("aria-pressed", problemsOnly ? "true" : "false");
bp.addEventListener("click", function () {
  problemsOnly = !problemsOnly; savePref("st-problems", problemsOnly);
  bp.setAttribute("aria-pressed", problemsOnly ? "true" : "false");
  el("groups").classList.toggle("problems", problemsOnly);
});

/* ---------------------------------------------------------------- pluie (decor, legere) */
(function rain() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var cv = el("rain"), x = cv.getContext("2d"), F = 14, cols, drops, t = null;
  var G = "ウキクケコサシスソタネヒメ0123456789:.=*+-<>";
  function rs() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(innerWidth / F); drops = [];
    for (var i = 0; i < cols; i++) drops[i] = Math.random() * -60;
  }
  function loop() {
    x.fillStyle = "rgba(2,6,4,.085)"; x.fillRect(0, 0, innerWidth, innerHeight);
    x.font = F + "px ui-monospace,monospace"; x.textBaseline = "top"; x.fillStyle = "#1c8a4c";
    for (var i = 0; i < cols; i++) {
      var y = drops[i] * F;
      if (y > 0 && y < innerHeight) x.fillText(G[(Math.random() * G.length) | 0], i * F, y);
      if (y > innerHeight && Math.random() > .977) drops[i] = 0;
      drops[i]++;
    }
  }
  rs();
  addEventListener("resize", rs, { passive: true });
  function go() { if (!t) t = setInterval(loop, 70); }
  function halt() { if (t) { clearInterval(t); t = null; } }
  document.addEventListener("visibilitychange", function () { document.hidden ? halt() : go(); });
  if (!document.hidden) go();
})();

if (!document.hidden) start(); else tick();
