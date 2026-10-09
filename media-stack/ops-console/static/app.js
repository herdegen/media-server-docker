/* ==========================================================================
   Console d'ops maxibestof — rendu graphique.
   Tout provient de /api/state (Glances + control server gluetun). Aucune
   donnee inventee : ce qui n'est pas mesurable est affiche "—".
   L'historique des courbes vit uniquement en memoire (depuis l'ouverture de
   la page), volontairement non persiste.
   ========================================================================== */
"use strict";

var POLL_MS = 2000, HIST = 180;               // 180 points x 2 s = 6 min de fenetre
var RM = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var SVGNS = "http://www.w3.org/2000/svg";
var hist = { cpu: [], sys: [], io: [], mem: [], rx: [], tx: [] };
var state = null;

/* ---------- utilitaires ---------- */
function el(id) { return document.getElementById(id); }
function svg(tag, attrs) {
  var n = document.createElementNS(SVGNS, tag);
  for (var k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function txt(id, v) { var n = el(id); if (n) n.textContent = v; }
function bytes(b) {
  if (!b && b !== 0) return "—";
  var u = ["o", "Ko", "Mo", "Go", "To"], i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)) + " " + u[i];
}
function rate(b) { return bytes(b) + "/s"; }
function push(arr, v) { arr.push(v); if (arr.length > HIST) arr.shift(); }

/* ====================== 1. CARTE DU TUNNEL ======================
   Fond : Natural Earth 110m (world-atlas), converti hors ligne en anneaux
   lon/lat dans world.json -> aucune dependance a un CDN a l'execution.
   Projection equirectangulaire avec CADRAGE ADAPTATIF : la vue se resserre
   sur l'emprise des points affiches. Si tout le monde est en Europe, on ne
   voit que l'Europe.
   Le repere interne reste 720x360 : traits et libelles gardent leur taille
   quel que soit le zoom (on projette les coordonnees, on ne scale pas le SVG).
   ================================================================ */
var WORLD = null, VIEW = { k: 1, tx: 0, ty: 0 }, LASTPTS = null;

function WX(lon) { return (lon + 180) * 2; }   /* 1 deg = 2 unites */
function WY(lat) { return (90 - lat) * 2; }
function PX(lon) { return WX(lon) * VIEW.k + VIEW.tx; }
function PY(lat) { return WY(lat) * VIEW.k + VIEW.ty; }

function computeView(pts) {
  var ok = (pts || []).filter(function (p) { return p && p.lat != null && p.lon != null; });
  if (!ok.length) return { k: 1, tx: 0, ty: 0 };
  var lo = ok.map(function (p) { return p.lon; }), la = ok.map(function (p) { return p.lat; });
  var l0 = Math.min.apply(null, lo), l1 = Math.max.apply(null, lo);
  var a0 = Math.min.apply(null, la), a1 = Math.max.apply(null, la);
  // marge : au moins 12 deg, sinon 55 % de l'emprise (les points ne collent pas au bord)
  var pl = Math.max(12, (l1 - l0) * 0.55), pa = Math.max(8, (a1 - a0) * 0.55);
  l0 = Math.max(-180, l0 - pl); l1 = Math.min(180, l1 + pl);
  a0 = Math.max(-84, a0 - pa);  a1 = Math.min(84, a1 + pa);
  var x0 = WX(l0), x1 = WX(l1), y0 = WY(a1), y1 = WY(a0);
  var k = Math.min(720 / Math.max(1, x1 - x0), 360 / Math.max(1, y1 - y0));
  k = Math.max(1, Math.min(k, 11));           // ni degroupe, ni zoom absurde
  return { k: k, tx: 360 - (x0 + x1) / 2 * k, ty: 180 - (y0 + y1) / 2 * k };
}

function loadWorld() {
  fetch("/_ops/world.json", { cache: "force-cache" })
    .then(function (r) { return r.json(); })
    .then(function (d) { WORLD = d.rings; if (LASTPTS) renderMap(LASTPTS); })
    .catch(function () { /* la carte restera vide, le reste du panneau tient */ });
}

function ringPath(r) {
  // r = [lon,lat,lon,lat,...]. On saute les anneaux hors champ.
  var n = r.length, i, minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9, d = "";
  for (i = 0; i < n; i += 2) {
    var x = PX(r[i]), y = PY(r[i + 1]);
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    d += (i ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1);
  }
  if (maxx < -20 || minx > 740 || maxy < -20 || miny > 380) return null;
  return d + "Z";
}

function renderMap(pts) {
  var s = el("map"); if (!s) return;
  LASTPTS = pts;
  VIEW = computeView(pts);
  s.textContent = "";

  var defs = svg("defs");
  var gl = svg("linearGradient", { id: "arcg", x1: "0", y1: "0", x2: "1", y2: "0" });
  [["0%", "#5cf39a"], ["55%", "#9dffc4"], ["100%", "#63e0ff"]].forEach(function (st) {
    gl.appendChild(svg("stop", { offset: st[0], "stop-color": st[1] }));
  });
  defs.appendChild(gl);
  s.appendChild(defs);

  // graticule : pas resserre quand on zoome
  var step = VIEW.k >= 6 ? 5 : (VIEW.k >= 3 ? 10 : (VIEW.k >= 1.8 ? 20 : 30));
  var g = svg("g", { stroke: "rgba(45,220,118,.10)", "stroke-width": ".5", fill: "none" });
  for (var lon = -180; lon <= 180; lon += step) {
    var x = PX(lon); if (x < -5 || x > 725) continue;
    g.appendChild(svg("line", { x1: x, y1: 0, x2: x, y2: 360 }));
  }
  for (var lat = -80; lat <= 80; lat += step) {
    var y = PY(lat); if (y < -5 || y > 365) continue;
    g.appendChild(svg("line", { x1: 0, y1: y, x2: 720, y2: y }));
  }
  s.appendChild(g);
  var eq = PY(0);
  if (eq > 0 && eq < 360) {
    s.appendChild(svg("line", { x1: 0, y1: eq, x2: 720, y2: eq,
      stroke: "rgba(45,220,118,.20)", "stroke-width": ".8", "stroke-dasharray": "5 4" }));
  }

  // terres + frontieres
  if (WORLD) {
    var lg = svg("g", { fill: "rgba(26,190,96,.13)", stroke: "rgba(92,243,154,.42)",
                        "stroke-width": ".6", "stroke-linejoin": "round" });
    for (var i = 0; i < WORLD.length; i++) {
      var d = ringPath(WORLD[i]);
      if (d) lg.appendChild(svg("path", { d: d }));
    }
    s.appendChild(lg);
  }

  // trame de points, en coordonnees ecran : densite constante quel que soit le zoom
  var dg = svg("g", { fill: "rgba(45,220,118,.13)" });
  for (var x2 = 6; x2 < 720; x2 += 14)
    for (var y2 = 6; y2 < 360; y2 += 14)
      dg.appendChild(svg("circle", { cx: x2, cy: y2, r: ".55" }));
  s.appendChild(dg);

  s.appendChild(svg("g", { id: "arc-layer" }));
  s.appendChild(svg("g", { id: "pin-layer" }));
  drawLink(pts[1], pts[2], pts[0]);

  // indicateur d'echelle
  var z = svg("text", { x: 8, y: 352, fill: "rgba(18,147,76,.9)", "font-size": "9",
    "font-family": "ui-monospace,monospace" });
  z.textContent = VIEW.k <= 1.02 ? "monde" : ("zoom x" + VIEW.k.toFixed(1));
  s.appendChild(z);
}

function pin(layer, x, y, color, label, sub, side) {
  var g = svg("g", {});
  [10, 16].forEach(function (r, i) {
    var c = svg("circle", { cx: x, cy: y, r: r, fill: "none", stroke: color,
      "stroke-width": i ? ".5" : ".8", opacity: i ? ".3" : ".55" });
    if (!RM) {
      c.appendChild(svg("animate", { attributeName: "r", values: r + ";" + (r + 9) + ";" + r,
        dur: (2.6 + i * 0.7) + "s", repeatCount: "indefinite" }));
      c.appendChild(svg("animate", { attributeName: "opacity", values: ".55;0;.55",
        dur: (2.6 + i * 0.7) + "s", repeatCount: "indefinite" }));
    }
    g.appendChild(c);
  });
  g.appendChild(svg("circle", { cx: x, cy: y, r: 4, fill: color, filter: "url(#sglow)" }));
  var sgn = side === -1 ? -1 : 1, dx = 11 * sgn, anchor = sgn < 0 ? "end" : "start";
  var t = svg("text", { x: x + dx, y: y - 5, fill: "#eafff1", "font-size": "11",
    "text-anchor": anchor, "font-family": "ui-monospace,monospace", "letter-spacing": ".6" });
  t.textContent = label; g.appendChild(t);
  if (sub) {
    var t2 = svg("text", { x: x + dx, y: y + 7, fill: "#12934c", "font-size": "9",
      "text-anchor": anchor, "font-family": "ui-monospace,monospace" });
    t2.textContent = sub; g.appendChild(t2);
  }
  layer.appendChild(g);
}

function bow(x1, y1, x2, y2, amt) {
  var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  var dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
  var b = Math.min(95, Math.max(24, len * amt));
  return "M" + x1.toFixed(1) + "," + y1.toFixed(1) + " Q" +
    (mx - dy / len * b).toFixed(1) + "," + (my + dx / len * b).toFixed(1) + " " +
    x2.toFixed(1) + "," + y2.toFixed(1);
}

function drawLink(srv, vpn, you) {
  var al = el("arc-layer"), pl = el("pin-layer");
  if (!al || !pl || !srv || srv.lat == null) return;
  var xs = PX(srv.lon), ys = PY(srv.lat);

  if (you && you.lat != null) {
    var xv = PX(you.lon), yv = PY(you.lat);
    al.appendChild(svg("path", { d: bow(xv, yv, xs, ys, -0.3), fill: "none",
      stroke: "#ffc74d", "stroke-width": "1.1", "stroke-dasharray": "4 4", opacity: ".85" }));
    pin(pl, xv, yv, "#ffc74d", "VOUS", you.city || you.ip || "", xv <= xs ? -1 : 1);
  }

  if (!vpn || vpn.lat == null) {
    pin(pl, xs, ys, "#5cf39a", (srv.city || "?").toUpperCase(), srv.org || "", 1);
    return;
  }
  var xd = PX(vpn.lon), yd = PY(vpn.lat);
  var s1 = xs <= xd ? -1 : 1;
  pin(pl, xs, ys, "#5cf39a", (srv.city || "?").toUpperCase(), srv.org || "", s1);

  var d = bow(xs, ys, xd, yd, 0.32);
  al.appendChild(svg("path", { d: d, fill: "none", stroke: "url(#arcg)",
    "stroke-width": "1.6", opacity: ".92", filter: "url(#sglow)" }));
  al.appendChild(svg("path", { d: d, fill: "none", stroke: "#9dffc4",
    "stroke-width": "5", opacity: ".07" }));
  if (!RM) {
    al.appendChild(svg("path", { id: "arcpath", d: d, fill: "none", stroke: "none" }));
    for (var i = 0; i < 3; i++) {
      var c = svg("circle", { r: 2.4, fill: "#d8ffe6", filter: "url(#sglow)" });
      c.setAttribute("class", "pkt");
      var am = svg("animateMotion", { dur: "3.2s", repeatCount: "indefinite",
        begin: (i * 1.07) + "s", rotate: "auto" });
      am.appendChild(svg("mpath", { href: "#arcpath" }));
      c.appendChild(am); al.appendChild(c);
    }
  }
  pin(pl, xd, yd, "#63e0ff", (vpn.city || "?").toUpperCase(), vpn.ip || "", -s1);
}

/* ====================== 2. COURBES ROULANTES ====================== */
function fit(cv) {
  var r = cv.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2);
  if (!r.width) return null;
  cv.width = Math.floor(r.width * d);
  cv.height = Math.floor((cv.getAttribute("height") || 90) * d);
  var x = cv.getContext("2d");
  x.setTransform(d, 0, 0, d, 0, 0);
  return { x: x, w: r.width, h: +(cv.getAttribute("height") || 90) };
}
function acquiring(x, w, h, n) {
  if (n >= 4) return false;
  x.fillStyle = "rgba(18,147,76,.85)";
  x.font = "10.5px ui-monospace,monospace";
  x.textAlign = "center";
  x.fillText("acquisition… " + n + "/4", w / 2, h / 2 + 3);
  x.textAlign = "start";
  return true;
}
function grid(x, w, h) {
  x.clearRect(0, 0, w, h);
  x.strokeStyle = "rgba(45,220,118,.10)";
  x.lineWidth = 1;
  for (var i = 1; i < 4; i++) {
    var y = Math.round(h * i / 4) + .5;
    x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke();
  }
}
/* Fenetre adaptative : avec 10 points sur 180 slots, la courbe se reduit a un
   trait colle au bord droit. On n'ouvre la fenetre que progressivement. */
function windowFor(len) { return Math.max(30, Math.min(HIST, len)); }
function series(x, data, w, h, max, color, fill, base) {
  if (data.length < 2) return;
  var n = windowFor(data.length), step = w / (n - 1), off = n - data.length;
  function X(i) { return (off + i) * step; }
  function Y(v) { return h - Math.min(v / max, 1) * (h - 2) - 1; }
  x.beginPath();
  x.moveTo(X(0), Y(data[0]));
  for (var i = 1; i < data.length; i++) x.lineTo(X(i), Y(data[i]));
  if (fill) {
    x.lineTo(X(data.length - 1), base === undefined ? h : base);
    x.lineTo(X(0), base === undefined ? h : base);
    x.closePath();
    var g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, fill); g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g; x.fill();
    x.beginPath(); x.moveTo(X(0), Y(data[0]));
    for (var j = 1; j < data.length; j++) x.lineTo(X(j), Y(data[j]));
  }
  x.strokeStyle = color; x.lineWidth = 1.5; x.stroke();
}

/* echelle adaptative : a 12 % d'usage, un axe 0-100 ecrase la courbe au sol.
   On cadre sur le pic recent, avec un plancher pour ne pas osciller a vide. */
function scaleOf(arrays, floor) {
  var peak = 0;
  arrays.forEach(function (a) {
    for (var i = 0; i < a.length; i++) if (a[i] > peak) peak = a[i];
  });
  return Math.min(100, Math.max(floor, Math.ceil(peak * 1.3 / 10) * 10));
}
function axisTag(x, w, max) {
  x.fillStyle = "rgba(18,147,76,.9)";
  x.font = "9.5px ui-monospace,monospace";
  x.textAlign = "end";
  x.fillText(max + "%", w - 2, 9);
  x.textAlign = "start";
}
function drawCpu() {
  var c = fit(el("c-cpu")); if (!c) return;
  grid(c.x, c.w, c.h);
  if (acquiring(c.x, c.w, c.h, hist.cpu.length)) return;
  var m = scaleOf([hist.cpu, hist.sys, hist.io], 25);
  series(c.x, hist.io, c.w, c.h, m, "#ffc74d", null);
  series(c.x, hist.sys, c.w, c.h, m, "#1abe60", null);
  series(c.x, hist.cpu, c.w, c.h, m, "#5cf39a", "rgba(92,243,154,.22)");
  axisTag(c.x, c.w, m);
}
function drawMem() {
  var c = fit(el("c-mem")); if (!c) return;
  grid(c.x, c.w, c.h);
  if (acquiring(c.x, c.w, c.h, hist.mem.length)) return;
  var m = scaleOf([hist.mem], 25);
  series(c.x, hist.mem, c.w, c.h, m, "#5cf39a", "rgba(92,243,154,.22)");
  axisTag(c.x, c.w, m);
}
/* reseau en miroir : descente vers le bas, montee vers le haut */
function drawNet() {
  var c = fit(el("c-net")); if (!c) return;
  var x = c.x, w = c.w, h = c.h, mid = h / 2;
  x.clearRect(0, 0, w, h);
  x.strokeStyle = "rgba(45,220,118,.20)";
  x.beginPath(); x.moveTo(0, mid + .5); x.lineTo(w, mid + .5); x.stroke();
  var peak = Math.max.apply(null, hist.rx.concat(hist.tx, [262144]));  // plancher 256 Ko/s
  var n = windowFor(hist.rx.length), step = w / (n - 1);
  function draw(data, up, color, fill) {
    if (data.length < 2) return;
    var off = n - data.length;
    function X(i) { return (off + i) * step; }
    function Y(v) {
      var a = Math.min(v / peak, 1) * (mid - 2);
      return up ? mid - a : mid + a;
    }
    x.beginPath(); x.moveTo(X(0), Y(data[0]));
    for (var i = 1; i < data.length; i++) x.lineTo(X(i), Y(data[i]));
    x.lineTo(X(data.length - 1), mid); x.lineTo(X(0), mid); x.closePath();
    x.fillStyle = fill; x.fill();
    x.beginPath(); x.moveTo(X(0), Y(data[0]));
    for (var j = 1; j < data.length; j++) x.lineTo(X(j), Y(data[j]));
    x.strokeStyle = color; x.lineWidth = 1.4; x.stroke();
  }
  draw(hist.tx, true, "#63e0ff", "rgba(99,224,255,.16)");
  draw(hist.rx, false, "#5cf39a", "rgba(92,243,154,.16)");
  el("net-sub").textContent = "échelle ±" + rate(peak) + " · " + (state && state.net ? state.net.iface : "") +
    " · cumul ↓" + bytes(state && state.net ? state.net.rx_total : 0) +
    " ↑" + bytes(state && state.net ? state.net.tx_total : 0);
}

/* ====================== 3. TEMPERATURE ====================== */
function arcPath(cx, cy, r, a0, a1) {
  function P(a) {
    var t = (a - 90) * Math.PI / 180;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
  }
  var s = P(a0), e = P(a1);
  return "M" + s[0].toFixed(2) + "," + s[1].toFixed(2) +
    " A" + r + "," + r + " 0 " + (a1 - a0 > 180 ? 1 : 0) + " 1 " + e[0].toFixed(2) + "," + e[1].toFixed(2);
}
function drawTemp(t) {
  var s = el("gauge"); if (!s) return;
  s.textContent = "";
  var A0 = -120, A1 = 120, cx = 66, cy = 70, r = 52;
  s.appendChild(svg("path", { d: arcPath(cx, cy, r, A0, A1), fill: "none",
    stroke: "rgba(45,220,118,.15)", "stroke-width": "9", "stroke-linecap": "round" }));
  var v = (t && (t.package != null ? t.package : t.max));
  if (v == null) {
    var q = svg("text", { x: cx, y: cy + 5, fill: "#12934c", "font-size": "12",
      "text-anchor": "middle", "font-family": "ui-monospace,monospace" });
    q.textContent = "—"; s.appendChild(q); return;
  }
  var warn = t.warn || 80, crit = t.crit || 100;
  var frac = Math.max(0, Math.min(v / crit, 1));
  var col = v >= crit ? "#ff5468" : (v >= warn * .85 ? "#ffc74d" : "#5cf39a");
  s.appendChild(svg("path", { d: arcPath(cx, cy, r, A0, A0 + (A1 - A0) * frac), fill: "none",
    stroke: col, "stroke-width": "9", "stroke-linecap": "round", filter: "url(#sglow)" }));
  // repere du seuil d'alerte
  var wa = A0 + (A1 - A0) * (warn / crit);
  s.appendChild(svg("path", { d: arcPath(cx, cy, r + 8, wa - .8, wa + .8), fill: "none",
    stroke: "#ffc74d", "stroke-width": "4" }));
  var big = svg("text", { x: cx, y: cy + 6, fill: "#eafff1", "font-size": "26",
    "text-anchor": "middle", "font-family": "ui-monospace,monospace" });
  big.textContent = Math.round(v);
  s.appendChild(big);
  var u = svg("text", { x: cx, y: cy + 22, fill: "#12934c", "font-size": "10",
    "text-anchor": "middle", "font-family": "ui-monospace,monospace" });
  u.textContent = "°C  package";
  s.appendChild(u);

  var box = el("cores");
  box.textContent = "";
  (t.cores || []).concat(t.others || []).slice(0, 8).forEach(function (c) {
    var pc = Math.max(0, Math.min(c.value / crit, 1)) * 100;
    var d = document.createElement("div"); d.className = "core";
    var l = document.createElement("span"); l.className = "cl"; l.textContent = c.label;
    var b = document.createElement("div"); b.className = "cb";
    var i = document.createElement("i"); i.style.width = pc.toFixed(1) + "%";
    if (c.value >= crit) i.style.background = "#ff5468";
    else if (c.value >= warn * .85) i.style.background = "#ffc74d";
    b.appendChild(i);
    var val = document.createElement("span"); val.className = "cv";
    val.textContent = Math.round(c.value) + "°";
    d.appendChild(l); d.appendChild(b); d.appendChild(val);
    box.appendChild(d);
  });
  txt("temp-sub", "max " + Math.round(t.max) + " °C · alerte " + warn +
    " · critique " + crit);
}

/* ====================== 4. DISQUE ====================== */
function drawDisk(fs, thr) {
  var s = el("ring"); if (!s) return;
  s.textContent = "";
  var cx = 66, cy = 66, r = 50, C = 2 * Math.PI * r;
  var p = Math.max(0, Math.min(fs.percent || 0, 100));
  var warnLvl = (thr && thr.disk_warn) || 90;
  var alarm = p >= warnLvl;
  var col = p >= 97 ? "#ff5468" : (alarm ? "#ffc74d" : "#5cf39a");
  s.appendChild(svg("circle", { cx: cx, cy: cy, r: r, fill: "none",
    stroke: "rgba(45,220,118,.15)", "stroke-width": "9" }));
  var arc = svg("circle", { cx: cx, cy: cy, r: r, fill: "none", stroke: col,
    "stroke-width": "9", "stroke-linecap": "round",
    "stroke-dasharray": C.toFixed(1), "stroke-dashoffset": (C * (1 - p / 100)).toFixed(1),
    transform: "rotate(-90 " + cx + " " + cy + ")", filter: "url(#sglow)" });
  s.appendChild(arc);
  if (alarm && !RM) {
    var a = svg("animate", { attributeName: "opacity", values: "1;.42;1",
      dur: "1.6s", repeatCount: "indefinite" });
    arc.appendChild(a);
  }
  var big = svg("text", { x: cx, y: cy + 7, fill: alarm ? "#ffc74d" : "#eafff1",
    "font-size": "27", "text-anchor": "middle", "font-family": "ui-monospace,monospace" });
  big.textContent = Math.round(p);
  s.appendChild(big);
  var u = svg("text", { x: cx, y: cy + 23, fill: "#12934c", "font-size": "10",
    "text-anchor": "middle", "font-family": "ui-monospace,monospace" });
  u.textContent = "% occupé";
  s.appendChild(u);

  txt("disk-free", bytes(fs.free));
  txt("disk-used", bytes(fs.used));
  txt("disk-size", bytes(fs.size));
  var w = el("disk-warn"), panel = el("p-disk");
  if (alarm) {
    w.hidden = false;
    txt("disk-warn-txt", "au-delà de " + warnLvl + " % — archiver sur Glacier ou supprimer des médias");
    panel.classList.add("alarm");
  } else {
    w.hidden = true;
    panel.classList.remove("alarm");
  }
}

/* ====================== 5. CONTROLE SYSTEME ====================== */
var TAGS = { ok: "OK", warn: "WARN", fail: "FAIL" };
function drawChecks(list) {
  var box = el("checks"); if (!box) return;
  box.textContent = "";
  (list || []).forEach(function (c) {
    var row = document.createElement("div");
    row.className = "chk " + (c.state || "ok");
    var t = document.createElement("span"); t.className = "tag";
    t.textContent = TAGS[c.state] || "?";
    var l = document.createElement("span"); l.className = "lb"; l.textContent = c.label;
    var d = document.createElement("span"); d.className = "dt"; d.textContent = c.detail;
    row.appendChild(t); row.appendChild(l); row.appendChild(d);
    box.appendChild(row);
  });
}

/* ============ 6. SERVICES (informations de l'ancienne home) ============ */
var SVC_DEF = [
  ["jellyfin", "Jellyfin", function (d) {
    return [["films", d.movies], ["séries", d.series], ["épisodes", d.episodes]]; }],
  ["radarr", "Radarr", function (d) {
    return [["films", d.movies], ["manquants", d.missing]]; }],
  ["sonarr", "Sonarr", function (d) {
    return [["séries", d.series], ["épisodes", d.episodes]]; }],
  ["prowlarr", "Prowlarr", function (d) {
    return [["indexeurs", d.indexers], ["déclarés", d.total]]; }],
  ["transmission", "Transmission", function (d) {
    return [["en cours", d.downloading], ["partage", d.seeding], ["↓", rate(d.down)]]; }]
];
function drawServices(sv) {
  var box = el("svcs"); if (!box || !sv) return;
  box.textContent = "";
  SVC_DEF.forEach(function (def) {
    var d = sv[def[0]] || { up: false };
    var a = document.createElement("a");
    a.className = "svc";
    a.href = d.url || "#";
    a.target = "_blank";
    a.rel = "noopener";
    var h = document.createElement("div"); h.className = "svc-h";
    var n = document.createElement("span"); n.className = "svc-n"; n.textContent = def[1];
    var st = document.createElement("span"); st.className = "svc-s" + (d.up ? "" : " down");
    h.appendChild(n); h.appendChild(st);
    a.appendChild(h);
    var b = document.createElement("div"); b.className = "svc-b";
    if (d.up) {
      def[2](d).forEach(function (kv) {
        var w = document.createElement("div");
        var k = document.createElement("span"); k.className = "k"; k.textContent = kv[0];
        var v = document.createElement("span"); v.className = "v"; v.textContent = kv[1];
        w.appendChild(k); w.appendChild(v); b.appendChild(w);
      });
    } else {
      var w2 = document.createElement("div");
      var k2 = document.createElement("span"); k2.className = "k"; k2.textContent = "état";
      var v2 = document.createElement("span"); v2.className = "v"; v2.textContent = "injoignable";
      w2.appendChild(k2); w2.appendChild(v2); b.appendChild(w2);
    }
    a.appendChild(b);
    box.appendChild(a);
  });
}

function hms(sec) {
  if (sec == null) return "—";
  // Transmission sort des ETA delirants quand le debit tombe a zero
  // (« reste 607 h ») : au-dela de 48 h l'estimation ne veut plus rien dire.
  if (sec > 172800) return "indéterminé";
  var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  return h ? (h + " h " + m + " min") : (m ? m + " min" : "<1 min");
}
function drawDownloads(tr) {
  var box = el("dl-list"); if (!box) return;
  box.textContent = "";
  if (!tr || !tr.up) { txt("dl-sub", "Transmission injoignable"); return; }
  txt("dl-sub", tr.downloading + " en cours · " + tr.seeding + " en partage · " +
      tr.total + " au total · ↓" + rate(tr.down) + " ↑" + rate(tr.up_rate));
  var list = tr.active || [];
  if (!list.length) {
    var e = document.createElement("div"); e.className = "dl-empty";
    e.textContent = "aucun téléchargement actif — tout est terminé ou en partage";
    box.appendChild(e); return;
  }
  list.forEach(function (t) {
    var d = document.createElement("div"); d.className = "dl";
    var h = document.createElement("div"); h.className = "dl-h";
    var n = document.createElement("span"); n.className = "dl-n";
    n.textContent = t.name; n.title = t.name;
    var pc = document.createElement("span"); pc.className = "dl-p";
    pc.textContent = t.pct.toFixed(1) + " %";
    h.appendChild(n); h.appendChild(pc);
    var bar = document.createElement("div"); bar.className = "dl-bar";
    var i = document.createElement("i"); i.style.width = t.pct + "%";
    bar.appendChild(i);
    var m = document.createElement("div"); m.className = "dl-m";
    [rate(t.rate), "reste " + hms(t.eta), bytes(t.size)].forEach(function (x) {
      var sp = document.createElement("span"); sp.textContent = x; m.appendChild(sp);
    });
    d.appendChild(h); d.appendChild(bar); d.appendChild(m);
    box.appendChild(d);
  });
}

/* ==================== 7. ARCHIVAGE GLACIER ==================== */
// itemIds cliques mais pas encore visibles cote S3 (l'aws CLI met quelques
// secondes a initier l'upload multipart) -> on montre une barre indeterminee.
var PENDING = {}, SEEN = {};

function drawArchiving(list) {
  var box = el("glacier-active"); if (!box) return;
  var byId = {};
  (list || []).forEach(function (a) { byId[a.itemId] = a; });

  // un archivage qui disparait = termine -> on rafraichit la liste des candidats
  Object.keys(SEEN).forEach(function (id) {
    if (!byId[id]) { delete SEEN[id]; delete PENDING[id]; loadGlacier(); }
  });
  Object.keys(byId).forEach(function (id) { SEEN[id] = 1; delete PENDING[id]; });

  var rows = (list || []).slice();
  Object.keys(PENDING).forEach(function (id) {
    if (Date.now() - PENDING[id].t > 120000) { delete PENDING[id]; return; }  // abandon
    rows.push({ itemId: id, name: PENDING[id].name, pct: null, starting: true });
  });

  box.textContent = "";
  rows.forEach(function (a) {
    var d = document.createElement("div");
    d.className = "aitem" + (a.starting ? " starting" : "");
    var h = document.createElement("div"); h.className = "a-h";
    var n = document.createElement("span"); n.className = "a-n";
    n.textContent = a.name; n.title = a.name;
    var pc = document.createElement("span"); pc.className = "a-p";
    pc.textContent = (a.pct == null) ? "…" : a.pct.toFixed(1) + " %";
    h.appendChild(n); h.appendChild(pc);
    var bar = document.createElement("div");
    bar.className = "a-bar" + (a.pct == null ? " indet" : "");
    var i = document.createElement("i");
    if (a.pct != null) i.style.width = Math.max(0.5, a.pct) + "%";
    bar.appendChild(i);
    var m = document.createElement("div"); m.className = "a-m";
    var tag = document.createElement("span"); tag.className = "a-tag";
    tag.textContent = a.starting ? "DÉMARRAGE" : "VERS GLACIER";
    m.appendChild(tag);
    if (!a.starting) {
      [bytes(a.done) + " / " + bytes(a.size),
       rate(a.rate),
       "reste " + hms(a.eta)].forEach(function (x) {
        var sp = document.createElement("span"); sp.textContent = x; m.appendChild(sp);
      });
    } else {
      var sp2 = document.createElement("span");
      sp2.textContent = "initialisation de l'envoi multipart…"; m.appendChild(sp2);
    }
    d.appendChild(h); d.appendChild(bar); d.appendChild(m);
    box.appendChild(d);
  });
}

function loadGlacier() {
  fetch("api/glacier", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(drawGlacier)
    .catch(function (e) { txt("glacier-sub", "indisponible : " + e.message); });
}
function drawGlacier(g) {
  var box = el("glacier-list"); if (!box) return;
  box.textContent = "";
  if (g.error) { txt("glacier-sub", g.error); return; }
  txt("glacier-sub", g.pool + " films éligibles · " + g.archived +
      " déjà sur Glacier · classés par volume × ancienneté");
  (g.items || []).forEach(function (it) {
    var row = document.createElement("div"); row.className = "gitem";
    var left = document.createElement("div");
    var nm = document.createElement("div"); nm.className = "gname";
    nm.textContent = it.name; nm.title = it.name;
    var mt = document.createElement("div"); mt.className = "gmeta";
    mt.textContent = (it.played ? "vu" : "jamais lu") + " · " +
      (it.months >= 12 ? Math.round(it.months / 12) + " ans" : Math.round(it.months) + " mois") +
      " sans lecture · ajouté " + it.added;
    left.appendChild(nm); left.appendChild(mt);
    var sz = document.createElement("div"); sz.className = "gsize";
    sz.textContent = it.gb.toFixed(1) + " Go";
    var btn = document.createElement("button");
    btn.className = "gbtn"; btn.textContent = "archiver";
    // double clic volontaire : l'archivage deplace le fichier hors du disque
    btn.onclick = function () {
      if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.className = "gbtn confirm";
        btn.textContent = "confirmer ?";
        setTimeout(function () {
          if (btn.dataset.armed === "1") {
            btn.dataset.armed = ""; btn.className = "gbtn"; btn.textContent = "archiver";
          }
        }, 5000);
        return;
      }
      btn.disabled = true; btn.textContent = "envoi…";
      fetch("api/glacier/archive", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: it.id })
      }).then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.ok) {
            btn.className = "gbtn done"; btn.textContent = "en cours";
            PENDING[it.id] = { t: Date.now(), name: it.name };
            drawArchiving(state && state.archiving);
          } else {
            btn.className = "gbtn err"; btn.textContent = "échec"; btn.title = d.error || "";
          }
        })
        .catch(function (e) {
          btn.className = "gbtn err"; btn.textContent = "échec"; btn.title = e.message;
        });
    };
    row.appendChild(left); row.appendChild(sz); row.appendChild(btn);
    box.appendChild(row);
  });
}

/* ====================== 8. BOUCLE ====================== */
function render(s) {
  state = s;
  if (s.error) { link(false, s.error); return; }
  link(true);

  push(hist.cpu, s.cpu.total); push(hist.sys, s.cpu.system); push(hist.io, s.cpu.iowait);
  push(hist.mem, s.mem.percent);
  push(hist.rx, s.net.rx); push(hist.tx, s.net.tx);

  txt("cpu-val", s.cpu.total.toFixed(1));
  var span = Math.round(hist.cpu.length * POLL_MS / 1000);
  txt("cpu-sub", "load " + s.load.min1.toFixed(2) + " / " + s.load.min5.toFixed(2) +
    " / " + s.load.min15.toFixed(2) + " · " + s.load.cores + " cœurs · iowait " +
    s.cpu.iowait.toFixed(1) + " % · fenêtre " +
    (span < 60 ? span + " s" : Math.round(span / 60) + " min"));
  txt("mem-val", s.mem.percent.toFixed(1));
  txt("mem-sub", bytes(s.mem.used) + " utilisés sur " + bytes(s.mem.total));
  txt("net-rx", rate(s.net.rx));
  txt("net-tx", rate(s.net.tx));
  txt("uptime", s.uptime || "—");

  drawCpu(); drawMem(); drawNet();
  drawTemp(s.temp); drawDisk(s.fs, s.thresholds); drawChecks(s.checks);
  drawServices(s.services);
  drawDownloads(s.services && s.services.transmission);
  drawArchiving(s.archiving);

  var vw = s.viewer || {};
  txt("viewer-ip", vw.ip || "—");
  var ev2 = el("ep-viewer");
  if (ev2) {
    ev2.querySelector(".ep-city").textContent = vw.private
      ? "réseau local" : ((vw.city || "?") + (vw.country ? ", " + vw.country : ""));
    ev2.querySelector(".ep-meta").textContent = (vw.ip || "—") + (vw.org ? " · " + vw.org : "");
  }

  var es = el("ep-server"), ev = el("ep-vpn");
  es.querySelector(".ep-city").textContent = (s.server.city || "?") + ", " + (s.server.country || "");
  es.querySelector(".ep-meta").textContent = s.server.lat.toFixed(3) + ", " + s.server.lon.toFixed(3) +
    " · " + (s.server.org || "");
  if (s.vpn && s.vpn.lat != null) {
    ev.querySelector(".ep-city").textContent = (s.vpn.city || "?") + ", " + (s.vpn.country || "");
    ev.querySelector(".ep-meta").textContent = s.vpn.ip + " · " + (s.vpn.org || "");
  } else {
    ev.querySelector(".ep-city").textContent = "indisponible";
    ev.querySelector(".ep-meta").textContent = (s.vpn && s.vpn.error) || "gluetun muet";
  }
  // on ne redessine l'arc que si un endpoint a change (evite de relancer les animations)
  // on ne recadre/redessine que si un point a bouge (sinon on relancerait
  // les animations des paquets a chaque cycle de 2 s)
  var sig = [s.server.lat, s.server.lon, s.vpn && s.vpn.lat, s.vpn && s.vpn.lon,
             vw.lat, vw.lon].join("|");
  if (el("map").dataset.sig !== sig) {
    el("map").dataset.sig = sig;
    renderMap([vw, s.server, s.vpn]);
  }
}

function link(up, msg) {
  var n = el("link-state");
  n.className = up ? "v up" : "v down";
  n.textContent = up ? "actif · 2 s" : ("rompu — " + (msg || "injoignable"));
}

function tick() {
  fetch("api/state", { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(render)
    .catch(function (e) { link(false, e.message); });
}

function clock() {
  var d = new Date();
  function p(n) { return (n < 10 ? "0" : "") + n; }
  txt("clock", p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()));
}

/* ---------- pluie numerique, en fond ---------- */
function rain() {
  if (RM) return;
  var cv = el("rain"), x = cv.getContext("2d"), F = 14, cols, drops, dpr;
  var G = "ウキクケコサシスソタネヒメ" +
          "0123456789:.=*+-<>";
  function rs() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(innerWidth / F); drops = [];
    for (var i = 0; i < cols; i++) drops[i] = Math.random() * -60;
  }
  rs();
  addEventListener("resize", rs, { passive: true });
  var t = null;
  function loop() {
    x.fillStyle = "rgba(2,6,4,.085)";
    x.fillRect(0, 0, innerWidth, innerHeight);
    x.font = F + "px ui-monospace,monospace"; x.textBaseline = "top";
    for (var i = 0; i < cols; i++) {
      var y = drops[i] * F;
      if (y > 0 && y < innerHeight) {
        if (Math.random() < .03) { x.fillStyle = "#d8ffe6"; x.shadowColor = "#4af08c"; x.shadowBlur = 8; }
        else { x.fillStyle = "#1c8a4c"; x.shadowBlur = 0; }
        x.fillText(G[(Math.random() * G.length) | 0], i * F, y);
      }
      if (y > innerHeight && Math.random() > .977) drops[i] = 0;
      drops[i]++;
    }
    x.shadowBlur = 0;
  }
  function start() { if (!t) t = setInterval(loop, 45); }
  function stop() { if (t) { clearInterval(t); t = null; } }
  document.addEventListener("visibilitychange", function () { document.hidden ? stop() : start(); });
  start();
}

loadWorld();
rain();
clock(); setInterval(clock, 1000);
tick(); setInterval(tick, POLL_MS);
loadGlacier(); setInterval(loadGlacier, 600000);   // meme cadence que le cache serveur
addEventListener("resize", function () {
  drawCpu(); drawMem(); drawNet();
}, { passive: true });
