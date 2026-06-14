/**
 * Glacier Plugin - Injection JS pour Jellyfin (v2, adapté 10.11 / React)
 * Corrige : ApiClient non global, navigation History API, id hors du hash.
 */
(function () {
    'use strict';

    const GLACIER_API = '/Glacier/items';
    const POLL_INTERVAL_MS = 30000;
    let glacierItems = {};

    // Récupère {base, token} via ApiClient (legacy) ou localStorage (10.11)
    function getCreds() {
        try {
            if (typeof ApiClient !== 'undefined' && ApiClient.accessToken && ApiClient.accessToken()) {
                return { base: ApiClient.serverAddress(), token: ApiClient.accessToken() };
            }
        } catch (e) {}
        try {
            const creds = JSON.parse(localStorage.getItem('jellyfin_credentials'));
            const s = creds.Servers[0];
            return { base: s.ManualAddress || s.LocalAddress || window.location.origin, token: s.AccessToken };
        } catch (e) { return null; }
    }

    function api(path, method) {
        const c = getCreds();
        if (!c) return Promise.reject('no creds');
        return fetch(c.base.replace(/\/$/, '') + path, {
            method: method || 'GET',
            headers: { 'Authorization': 'MediaBrowser Token="' + c.token + '"' }
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.status === 204 ? null : r.json().catch(function () { return null; });
        });
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
            case 'OnGlacier':        return '🧊 Glacier';
            case 'RestoreRequested': return '⏳ Demandé';
            case 'Restoring':        return '🔄 Restore…';
            case 'Downloading':      return '⬇️ Téléchargement…';
            case 'Available':        return '✅ Prêt';
            default:                 return '🧊 Glacier';
        }
    }

    function loadGlacierItems() {
        api(GLACIER_API).then(function (items) {
            if (!items) return;
            console.log('[Glacier] items chargés:', items.length);
            glacierItems = {};
            items.forEach(function (item) {
                const id = item.JellyfinItemId.toLowerCase().replace(/-/g, '');
                glacierItems[id] = item;
            });
            applyBadges();
            applyDetailButton();
        }).catch(function (e) { console.log('[Glacier] erreur fetch:', e); });
    }

    function applyBadges() {
        document.querySelectorAll('[data-id]').forEach(function (card) {
            const itemId = (card.getAttribute('data-id') || '').toLowerCase();
            if (!itemId || !glacierItems[itemId]) return;
            if (card.querySelector('.glacier-badge')) return;
            const item = glacierItems[itemId];
            const badge = document.createElement('div');
            badge.className = 'glacier-badge';
            badge.title = 'Sur Glacier Scaleway — cliquez pour restaurer';
            badge.style.cssText = ['position:absolute', 'top:6px', 'left:6px', 'background:rgba(30,120,200,0.92)', 'color:#fff', 'border-radius:4px', 'padding:2px 6px', 'font-size:11px', 'font-weight:bold', 'z-index:10', 'cursor:pointer', 'user-select:none', 'box-shadow:0 1px 4px rgba(0,0,0,0.4)'].join(';');
            badge.textContent = statusLabel(item.Status);
            badge.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); openRestoreDialog(itemId); });
            const cardInner = card.querySelector('.cardContent') || card;
            cardInner.style.position = 'relative';
            cardInner.appendChild(badge);
        });
    }

    function currentItemId() {
        const m = window.location.href.match(/[?&]id=([a-f0-9]{32})/i);
        return m ? m[1].toLowerCase() : null;
    }

    function openRestoreDialog(itemId) {
        const item = glacierItems[itemId];
        if (!item) return;
        if (item.Status !== 'OnGlacier') {
            alertDlg('Statut actuel : ' + statusLabel(item.Status) + (item.RestoreRequestedAt ? '\nDemandé le : ' + new Date(item.RestoreRequestedAt).toLocaleString() : ''), '🧊 ' + item.Title);
            return;
        }
        const sizeGo = (item.FileSizeBytes / 1024 / 1024 / 1024).toFixed(1);
        confirmDlg('🎬 <strong>' + item.Title + '</strong><br><br>📦 Taille : ' + sizeGo + ' Go<br>⏱ Délai estimé : ~20 minutes<br><br>Lancer la restauration depuis Scaleway Glacier ?', 'Récupérer ce film', function (confirmed) {
            if (!confirmed) return;
            api('/Glacier/items/' + itemId + '/restore', 'POST').then(function (resp) {
                alertDlg('✅ Restauration lancée !' + (resp && resp.EstimatedMinutes ? '\nTemps estimé : ' + resp.EstimatedMinutes + ' minutes.' : '') + '\nVous serez notifié quand le film sera disponible.', item.Title);
                loadGlacierItems();
            }).catch(function () { alertDlg('Erreur lors de la demande de restauration.', 'Erreur'); });
        });
    }

    function applyDetailButton() {
        const buttonsArea = document.querySelector('.mainDetailButtons') || document.querySelector('.detailButtons');
        if (!buttonsArea) return;
        const itemId = currentItemId();
        if (!itemId) return;
        const glacierItem = glacierItems[itemId];
        const stateKey = itemId + ':' + (glacierItem ? glacierItem.Status : 'local');
        const existing = buttonsArea.querySelector('.glacier-archive-btn');
        if (existing && existing.dataset.statekey === stateKey) return;
        buttonsArea.querySelectorAll('.glacier-archive-btn').forEach(function (b) { b.remove(); });

        const btn = document.createElement('button');
        btn.className = 'raised glacier-archive-btn emby-button';
        btn.dataset.statekey = stateKey;
        btn.style.cssText = 'margin-left:8px; background:rgba(30,120,200,0.85);';

        if (!glacierItem) {
            btn.innerHTML = '🧊 Archiver sur Glacier';
            btn.addEventListener('click', function () {
                confirmDlg('Envoyer ce film sur Scaleway Glacier ?<br><br>⚠️ Le fichier local sera <strong>supprimé</strong> après l\'upload.', 'Archiver sur Glacier', function (confirmed) {
                    if (!confirmed) return;
                    btn.disabled = true; btn.innerHTML = '⏳ Upload en cours…';
                    api('/Glacier/items/' + itemId + '/archive', 'POST').then(function () {
                        alertDlg('⏳ Upload démarré en arrière-plan.\nLe badge 🧊 apparaîtra une fois l\'upload terminé.', 'Glacier');
                    }).catch(function () {
                        alertDlg('❌ Erreur lors de l\'archivage.', 'Erreur');
                        btn.disabled = false; btn.innerHTML = '🧊 Archiver sur Glacier';
                    });
                });
            });
        } else {
            btn.innerHTML = statusLabel(glacierItem.Status);
            btn.style.opacity = '0.7';
            btn.style.cursor = 'default';
            if (glacierItem.Status === 'OnGlacier') {
                btn.style.cursor = 'pointer'; btn.style.opacity = '1';
                btn.addEventListener('click', function () { openRestoreDialog(itemId); });
            }
        }
        buttonsArea.appendChild(btn);
    }

    // Pilotage par observation du DOM (débounce léger), sans hashchange
    let pending = false;
    function scheduleApply() {
        if (pending) return;
        pending = true;
        setTimeout(function () { pending = false; applyBadges(); applyDetailButton(); }, 200);
    }
    new MutationObserver(scheduleApply).observe(document.body, { childList: true, subtree: true });

    console.log('[Glacier] Script chargé ✅ (v2 / 10.11)');

    function waitForReady(cb, n) {
        n = n || 0;
        if (getCreds()) { cb(); }
        else if (n < 60) { setTimeout(function () { waitForReady(cb, n + 1); }, 500); }
        else { console.log('[Glacier] credentials introuvables, abandon'); }
    }
    waitForReady(function () {
        console.log('[Glacier] credentials OK, démarrage');
        loadGlacierItems();
        setInterval(loadGlacierItems, POLL_INTERVAL_MS);
    });

})();
