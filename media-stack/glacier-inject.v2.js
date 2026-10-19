/**
 * Glacier Plugin - Injection JS pour Jellyfin (v4, Jellyfin 12, plugin ≥ 1.3.0.0)
 * v2 : ApiClient non global, navigation History API, id hors du hash.
 * v3 : archivage / restauration d'une saison entière, file d'upload, badges sur les épisodes.
 * v4 : boutons d'archivage réservés aux admins (le serveur refuse aussi), type d'item via
 *      /Glacier/info (plus de bouton sur les séries/collections), délai de restauration
 *      annoncé par le serveur, poll suspendu onglet caché, file d'upload pollée seulement si utile.
 */
(function () {
    'use strict';

    const GLACIER_API = '/Glacier/items';
    const POLL_INTERVAL_MS = 30000;
    // File d'upload vide et aucune action lancée : on ne la re-vérifie que toutes les 2 min
    // (un archivage lancé depuis un autre onglet/appareil finit quand même par apparaître).
    const QUEUE_IDLE_POLL_MS = 120000;
    const DEFAULT_ESTIMATE = 'de quelques minutes à 24 h';

    let glacierItems = {};
    let glacierQueue = {};       // id → 'Queued' | 'Uploading'
    let restoreEstimate = DEFAULT_ESTIMATE;
    let lastQueuePoll = 0;
    let queueWatch = true;       // true : file non vide au dernier poll, ou action lancée depuis
    // id → réponse /Glacier/info ; null = requête en cours ; false = item inconnu (404, définitif) ;
    // 'error' = échec réseau/serveur, retenté au poll suivant
    const infoCache = {};
    // Admin du compte courant, mis en cache par token (changement de compte sans recharger la page)
    let admin = { token: null, value: null, promise: null };

    function normId(id) { return String(id).toLowerCase().replace(/-/g, ''); }
    function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function go(bytes) { return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' Go'; }

    // {base, token} : ApiClient si exposé, sinon localStorage. La base est l'origine de la page
    // (ManualAddress pouvait pointer vers une ancienne adresse ou un autre serveur).
    function getCreds() {
        try {
            if (typeof ApiClient !== 'undefined' && ApiClient.accessToken && ApiClient.accessToken()) {
                return { base: ApiClient.serverAddress() || window.location.origin, token: ApiClient.accessToken() };
            }
        } catch (e) {}
        try {
            const servers = JSON.parse(localStorage.getItem('jellyfin_credentials')).Servers || [];
            const origin = window.location.origin;
            const s = servers.find(function (x) { return x.AccessToken && (x.ManualAddress === origin || x.LocalAddress === origin); })
                || servers.find(function (x) { return x.AccessToken; });
            return s ? { base: origin, token: s.AccessToken } : null;
        } catch (e) { return null; }
    }

    function api(path, method) {
        const c = getCreds();
        if (!c) return Promise.reject('no creds');
        return fetch(c.base.replace(/\/$/, '') + path, {
            method: method || 'GET',
            headers: { 'Authorization': 'MediaBrowser Token="' + c.token + '"' }
        }).then(function (r) {
            if (r.status === 404) { const e = new Error('HTTP 404'); e.notFound = true; throw e; }
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.status === 204 ? null : r.json().catch(function () { return null; });
        });
    }

    // Sert uniquement à masquer des boutons : le serveur refuse de toute façon l'archivage aux non-admins.
    function isAdmin() {
        const c = getCreds();
        const token = c && c.token;
        if (admin.token !== token) admin = { token: token, value: null, promise: null };
        if (admin.value !== null || admin.promise) return admin.value;
        let p;
        try { p = (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUser) ? Promise.resolve(ApiClient.getCurrentUser()) : null; } catch (e) { p = null; }
        const cur = admin;
        cur.promise = (p || api('/Users/Me')).then(function (u) {
            if (!u || !u.Policy) return api('/Users/Me'); // getCurrentUser sans Policy selon les versions
            return u;
        }).then(function (u) {
            cur.value = !!(u && u.Policy && u.Policy.IsAdministrator);
            cur.promise = null;
            scheduleApply();
        }).catch(function (e) {
            cur.promise = null; // retenté au prochain affichage
            console.log('[Glacier] utilisateur courant:', e);
        });
        return null;
    }

    function confirmDlg(html, title, cb) {
        if (typeof Dashboard !== 'undefined' && Dashboard.confirm) { Dashboard.confirm(html, title, cb); }
        else { cb(window.confirm(title + '\n\n' + html.replace(/<[^>]+>/g, ''))); }
    }
    function alertDlg(msg, title) {
        if (typeof Dashboard !== 'undefined' && Dashboard.alert) { Dashboard.alert({ message: msg, title: title }); }
        else { window.alert((title ? title + '\n\n' : '') + msg); }
    }

    function statusLabel(status) {
        switch (status) {
            case 'Queued':           return '⏳ En file';
            case 'Uploading':        return '⬆️ Upload…';
            case 'OnGlacier':        return '🧊 Glacier';
            case 'RestoreRequested': return '⏳ Demandé';
            case 'Restoring':        return '🔄 Restore…';
            case 'Downloading':      return '⬇️ Téléchargement…';
            case 'Available':        return '✅ Prêt';
            default:                 return '🧊 Glacier';
        }
    }

    function shouldPollQueue() {
        return queueWatch || Date.now() - lastQueuePoll >= QUEUE_IDLE_POLL_MS;
    }

    function loadGlacierItems() {
        const pollQueue = shouldPollQueue();
        const queueReq = pollQueue ? api('/Glacier/queue').catch(function () { return null; }) : Promise.resolve(null);
        Promise.all([api(GLACIER_API), queueReq]).then(function (res) {
            const items = res[0];
            if (!items) return;
            glacierItems = {};
            items.forEach(function (item) { glacierItems[normId(item.JellyfinItemId)] = item; });
            if (items.length && items[0].RestoreEstimate) restoreEstimate = items[0].RestoreEstimate;
            if (pollQueue && res[1]) {
                glacierQueue = {};
                res[1].forEach(function (q) { glacierQueue[normId(q.JellyfinItemId)] = q.Status; });
                lastQueuePoll = Date.now();
                queueWatch = res[1].length > 0;
            }
            // Infos rechargées à chaque poll (progression de la file) ; les 404 restent en cache
            Object.keys(infoCache).forEach(function (k) { if (infoCache[k] !== false && infoCache[k] !== null) delete infoCache[k]; });
            document.querySelectorAll('.glacier-badge').forEach(function (b) { b.remove(); });
            applyBadges();
            applyDetailButton();
        }).catch(function (e) { console.log('[Glacier] erreur fetch:', e); });
    }

    // Après une action : surveiller la file dès le poll suivant
    function afterAction() { queueWatch = true; loadGlacierItems(); }

    // Statut affiché d'un item : la file d'upload prime sur la base (un item « Available »
    // remis en archivage repasse par la file)
    function itemState(itemId) {
        if (glacierQueue[itemId]) return glacierQueue[itemId];
        const g = glacierItems[itemId];
        return g && g.Status !== 'Available' ? g.Status : null;
    }

    function applyBadges() {
        // .card : grilles (films, épisodes récents) ; .listItem : liste d'épisodes d'une saison
        document.querySelectorAll('.card[data-id], .listItem[data-id]').forEach(function (card) {
            const itemId = normId(card.getAttribute('data-id') || '');
            const state = itemId && itemState(itemId);
            if (!state) return;
            if (card.querySelector('.glacier-badge')) return;
            const badge = document.createElement('div');
            badge.className = 'glacier-badge';
            badge.title = 'Sur Glacier Scaleway — cliquez pour restaurer';
            badge.style.cssText = ['position:absolute', 'top:6px', 'left:6px', 'background:rgba(30,120,200,0.92)', 'color:#fff', 'border-radius:4px', 'padding:2px 6px', 'font-size:11px', 'font-weight:bold', 'z-index:10', 'cursor:pointer', 'user-select:none', 'box-shadow:0 1px 4px rgba(0,0,0,0.4)'].join(';');
            badge.textContent = statusLabel(state);
            badge.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); openRestoreDialog(itemId); });
            const host = card.querySelector('.cardScalable') || card.querySelector('.cardBox') || card.querySelector('.listItemImage') || card;
            host.style.position = 'relative';
            host.appendChild(badge);
        });
    }

    function currentItemId() {
        const m = window.location.href.match(/[?&]id=([a-f0-9]{32})/i);
        return m ? m[1].toLowerCase() : null;
    }

    function openRestoreDialog(itemId) {
        const item = glacierItems[itemId];
        if (glacierQueue[itemId]) { alertDlg('Statut actuel : ' + statusLabel(glacierQueue[itemId]), '🧊 Glacier'); return; }
        if (!item) return;
        if (item.Status !== 'OnGlacier') {
            alertDlg('Statut actuel : ' + statusLabel(item.Status) + (item.RestoreRequestedAt ? '\nDemandé le : ' + new Date(item.RestoreRequestedAt).toLocaleString() : ''), '🧊 ' + item.Title);
            return;
        }
        const sizeGo = (item.FileSizeBytes / 1024 / 1024 / 1024).toFixed(1);
        confirmDlg('🎬 <strong>' + esc(item.Title) + '</strong><br><br>📦 Taille : ' + sizeGo + ' Go<br>⏱ Délai Scaleway : ' + esc(item.RestoreEstimate || restoreEstimate) + '<br><br>Lancer la restauration depuis Scaleway Glacier ?', 'Récupérer depuis Glacier', function (confirmed) {
            if (!confirmed) return;
            api('/Glacier/items/' + itemId + '/restore', 'POST').then(function (resp) {
                alertDlg('✅ Restauration lancée !\nDélai : ' + ((resp && resp.EstimateText) || restoreEstimate) + '.\nVous serez notifié dès que ce sera disponible.', item.Title);
                afterAction();
            }).catch(function () { alertDlg('Erreur lors de la demande de restauration.', 'Erreur'); });
        });
    }

    function makeBtn(stateKey, html) {
        const btn = document.createElement('button');
        btn.className = 'raised glacier-archive-btn emby-button';
        btn.dataset.statekey = stateKey;
        btn.style.cssText = 'margin-left:8px; background:rgba(30,120,200,0.85);';
        btn.innerHTML = html;
        return btn;
    }

    function clearButtons(area) { area.querySelectorAll('.glacier-archive-btn').forEach(function (b) { b.remove(); }); }

    function applyDetailButton() {
        const buttonsArea = document.querySelector('.mainDetailButtons') || document.querySelector('.detailButtons');
        if (!buttonsArea) return;
        const itemId = currentItemId();
        if (!itemId) return;

        // Type de l'item + résumé saison : une requête par poll (404 = item inconnu, définitif)
        if (infoCache[itemId] === 'error') return; // retenté au poll suivant (qui purge l'entrée)
        if (!(itemId in infoCache)) {
            infoCache[itemId] = null; // requête en cours
            api('/Glacier/info/' + itemId).then(function (info) { infoCache[itemId] = info || false; applyDetailButton(); })
                .catch(function (e) {
                    infoCache[itemId] = e && e.notFound ? false : 'error';
                    if (!(e && e.notFound)) console.log('[Glacier] info:', e);
                });
            return;
        }
        const info = infoCache[itemId];
        if (!info) { clearButtons(buttonsArea); return; }
        const adm = isAdmin(); // null tant que inconnu : boutons d'archivage masqués en attendant
        if (info.Season) { applySeasonButtons(buttonsArea, itemId, info.Season, adm === true); return; }
        if (!info.Archivable && !info.Item) { clearButtons(buttonsArea); return; }

        const glacierItem = glacierItems[itemId];
        const state = itemState(itemId);
        const stateKey = itemId + ':' + (state || 'local') + ':' + adm;
        const existing = buttonsArea.querySelector('.glacier-archive-btn');
        if (existing && existing.dataset.statekey === stateKey) return;
        clearButtons(buttonsArea);

        if (!state) {
            if (adm !== true || !info.Archivable) return;
            const btn = makeBtn(stateKey, '🧊 Archiver sur Glacier');
            btn.addEventListener('click', function () {
                confirmDlg('Envoyer ce fichier sur Scaleway Glacier ?<br><br>⚠️ Le fichier local sera <strong>supprimé</strong> après l\'upload.', 'Archiver sur Glacier', function (confirmed) {
                    if (!confirmed) return;
                    btn.disabled = true; btn.innerHTML = '⏳ Mis en file…';
                    api('/Glacier/items/' + itemId + '/archive', 'POST').then(function () {
                        alertDlg('⏳ Upload mis en file (2 en parallèle max).\nLe badge 🧊 apparaîtra une fois l\'upload terminé.', 'Glacier');
                        afterAction();
                    }).catch(function () {
                        alertDlg('❌ Erreur lors de l\'archivage.', 'Erreur');
                        btn.disabled = false; btn.innerHTML = '🧊 Archiver sur Glacier';
                    });
                });
            });
            buttonsArea.appendChild(btn);
            return;
        }

        const btn = makeBtn(stateKey, statusLabel(state));
        btn.style.opacity = '0.7';
        btn.style.cursor = 'default';
        if (state === 'OnGlacier' && glacierItem) {
            btn.style.cursor = 'pointer'; btn.style.opacity = '1';
            btn.addEventListener('click', function () { openRestoreDialog(itemId); });
        }
        buttonsArea.appendChild(btn);
    }

    function applySeasonButtons(buttonsArea, seasonId, s, adm) {
        const stateKey = seasonId + ':' + [s.Local, s.OnGlacier, s.InProgress, s.Restoring].join('/') + ':' + adm;
        const existing = buttonsArea.querySelector('.glacier-archive-btn');
        if (existing && existing.dataset.statekey === stateKey) return;
        clearButtons(buttonsArea);

        if (s.InProgress > 0) {
            const b = makeBtn(stateKey, '⬆️ Glacier : ' + s.InProgress + ' épisode(s) en cours');
            b.style.opacity = '0.7'; b.style.cursor = 'default';
            buttonsArea.appendChild(b);
        }

        if (s.Local > 0 && adm) {
            const freed = s.LocalBytes - s.SharedBytes;
            const b = makeBtn(stateKey, '🧊 Archiver la saison (' + s.Local + ')');
            b.addEventListener('click', function () {
                let html = '📺 <strong>' + esc(s.Title) + '</strong><br><br>'
                    + '📦 ' + s.Local + ' épisode(s), ' + go(s.LocalBytes) + '<br>'
                    + '💾 Espace réellement libéré : <strong>' + go(freed) + '</strong>';
                if (s.SharedBytes > 0) {
                    html += '<br><br>⚠️ ' + go(s.SharedBytes) + ' sont encore partagés avec des torrents en seed (hardlinks) :'
                        + ' cet espace ne sera libéré qu\'une fois les torrents supprimés.';
                }
                html += '<br><br>Les fichiers locaux seront <strong>supprimés</strong> après l\'upload (2 en parallèle).';
                confirmDlg(html, 'Archiver la saison sur Glacier', function (ok) {
                    if (!ok) return;
                    b.disabled = true; b.innerHTML = '⏳ Mise en file…';
                    api('/Glacier/seasons/' + seasonId + '/archive', 'POST').then(function (r) {
                        alertDlg('⏳ ' + (r && r.Queued) + ' épisode(s) mis en file d\'upload.\nLes badges 🧊 apparaîtront au fil des envois.', 'Glacier');
                        afterAction();
                    }).catch(function () {
                        alertDlg('❌ Erreur lors de l\'archivage de la saison.', 'Erreur');
                        b.disabled = false; b.innerHTML = '🧊 Archiver la saison (' + s.Local + ')';
                    });
                });
            });
            buttonsArea.appendChild(b);
        }

        if (s.OnGlacier > 0) {
            const b = makeBtn(stateKey, '♻️ Restaurer la saison (' + s.OnGlacier + ')');
            b.addEventListener('click', function () {
                confirmDlg('📺 <strong>' + esc(s.Title) + '</strong><br><br>📦 ' + s.OnGlacier + ' épisode(s) sur Glacier, ' + go(s.GlacierBytes)
                    + '<br>⏱ Délai Scaleway : ' + esc(restoreEstimate)
                    + '<br><br>⚠️ Vérifiez qu\'il y a la place sur le disque.<br><br>Lancer la restauration ?', 'Restaurer la saison', function (ok) {
                    if (!ok) return;
                    b.disabled = true; b.innerHTML = '⏳ Demande en cours…';
                    api('/Glacier/seasons/' + seasonId + '/restore', 'POST').then(function (r) {
                        alertDlg('✅ Restauration demandée pour ' + (r && r.Queued) + ' épisode(s).\nDélai : ' + restoreEstimate + '.\nVous serez notifié quand ils seront disponibles.', 'Glacier');
                        afterAction();
                    }).catch(function () {
                        alertDlg('❌ Erreur lors de la demande de restauration.', 'Erreur');
                        b.disabled = false;
                    });
                });
            });
            buttonsArea.appendChild(b);
        }

        if (s.Restoring > 0) {
            const b = makeBtn(stateKey, '🔄 ' + s.Restoring + ' épisode(s) en restauration');
            b.style.opacity = '0.7'; b.style.cursor = 'default';
            buttonsArea.appendChild(b);
        }
    }

    // Pilotage par observation du DOM (débounce léger), sans hashchange
    let pending = false;
    function scheduleApply() {
        if (pending) return;
        pending = true;
        setTimeout(function () { pending = false; applyBadges(); applyDetailButton(); }, 200);
    }
    new MutationObserver(scheduleApply).observe(document.body, { childList: true, subtree: true });

    console.log('[Glacier] Script chargé ✅ (v4 / admin, /Glacier/info)');

    function waitForReady(cb, n) {
        n = n || 0;
        if (getCreds()) { cb(); }
        else if (n < 60) { setTimeout(function () { waitForReady(cb, n + 1); }, 500); }
        else { console.log('[Glacier] credentials introuvables, abandon'); }
    }
    waitForReady(function () {
        console.log('[Glacier] credentials OK, démarrage');
        loadGlacierItems();
        // Onglet caché : aucun appel (évite des requêtes toutes les 30 s pour un onglet oublié)
        setInterval(function () { if (document.hidden) return; loadGlacierItems(); }, POLL_INTERVAL_MS);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) loadGlacierItems(); });
    });

})();
