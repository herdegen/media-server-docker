/**
 * Glacier Plugin - Injection JS pour Jellyfin
 * À coller dans Dashboard > Général > Custom JavaScript
 */
(function () {
    'use strict';

    const GLACIER_API = '/Glacier/items';
    const POLL_INTERVAL_MS = 30000; // rafraîchit les statuts toutes les 30s
    let glacierItems = {}; // { itemId: GlacierItemDto }

    // Charge la liste des films Glacier depuis l'API du plugin
    function loadGlacierItems() {
        if (typeof ApiClient === 'undefined') return;
        var token = ApiClient.accessToken();
        if (!token) return;
        fetch(ApiClient.getUrl(GLACIER_API), {
            headers: { 'X-Emby-Authorization': 'MediaBrowser Token="' + token + '"' }
        })
        .then(function (r) { return r.json(); })
        .then(function (items) {
            console.log('[Glacier] items chargés:', items.length);
            glacierItems = {};
            items.forEach(function (item) {
                var id = item.JellyfinItemId.toLowerCase().replace(/-/g, '');
                glacierItems[id] = item;
            });
            applyBadges();
            applyDetailButton();
        })
        .catch(function (e) { console.log('[Glacier] erreur fetch:', e); });
    }

    // Injecte les badges 🧊 sur les cartes de la grille
    function applyBadges() {
        document.querySelectorAll('[data-id]').forEach(function (card) {
            const itemId = (card.dataset.id || '').toLowerCase();
            if (!itemId || !glacierItems[itemId]) return;

            const item = glacierItems[itemId];
            if (card.querySelector('.glacier-badge')) return; // déjà ajouté

            const badge = document.createElement('div');
            badge.className = 'glacier-badge';
            badge.title = 'Sur Glacier Scaleway — cliquez pour restaurer';
            badge.dataset.itemid = itemId;
            badge.style.cssText = [
                'position:absolute', 'top:6px', 'left:6px',
                'background:rgba(30,120,200,0.92)', 'color:#fff',
                'border-radius:4px', 'padding:2px 6px',
                'font-size:11px', 'font-weight:bold',
                'z-index:10', 'cursor:pointer', 'user-select:none',
                'box-shadow:0 1px 4px rgba(0,0,0,0.4)'
            ].join(';');

            badge.textContent = statusLabel(item.Status);
            badge.addEventListener('click', function (e) {
                e.stopPropagation();
                e.preventDefault();
                openRestoreDialog(itemId);
            });

            // Le card a besoin d'un position:relative pour que le badge se place bien
            const cardInner = card.querySelector('.cardContent') || card;
            cardInner.style.position = 'relative';
            cardInner.appendChild(badge);
        });
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

    // Affiche une boîte de dialogue de restauration
    function openRestoreDialog(itemId) {
        const item = glacierItems[itemId];
        if (!item) return;

        // Si déjà en cours ou disponible, juste informer
        if (item.Status !== 'OnGlacier') {
            Dashboard.alert({
                message: 'Statut actuel : ' + statusLabel(item.Status) +
                    (item.RestoreRequestedAt ? '\nDemandé le : ' + new Date(item.RestoreRequestedAt).toLocaleString() : ''),
                title: '🧊 ' + item.Title
            });
            return;
        }

        const sizeGo = (item.FileSizeBytes / 1024 / 1024 / 1024).toFixed(1);

        Dashboard.confirm(
            '🎬 <strong>' + item.Title + '</strong><br><br>' +
            '📦 Taille : ' + sizeGo + ' Go<br>' +
            '⏱ Délai estimé : ~20 minutes<br><br>' +
            'Lancer la restauration depuis Scaleway Glacier ?',
            'Récupérer ce film',
            function (confirmed) {
                if (!confirmed) return;
                ApiClient.ajax({
                    url: ApiClient.getUrl('Glacier/items/' + itemId + '/restore'),
                    type: 'POST'
                }).then(function (response) {
                    Dashboard.alert({
                        message: '✅ Restauration lancée !\nTemps estimé : ' + response.EstimatedMinutes + ' minutes.\nVous serez notifié quand le film sera disponible.',
                        title: item.Title
                    });
                    loadGlacierItems();
                }).catch(function (err) {
                    Dashboard.alert({ message: 'Erreur lors de la demande de restauration.', title: 'Erreur' });
                });
            }
        );
    }

    // Injecte ou met à jour le bouton Glacier sur la page détail
    function applyDetailButton() {
        const buttonsArea = document.querySelector('.mainDetailButtons');
        if (!buttonsArea) return;
        const match = window.location.hash.match(/[?&]id=([a-f0-9]{32})/i);
        if (!match) return;
        const itemId = match[1].toLowerCase();
        const glacierItem = glacierItems[itemId];

        // Clé d'état : si le bouton existe déjà avec le même état, ne rien faire
        const stateKey = itemId + ':' + (glacierItem ? glacierItem.Status : 'local');
        const existing = buttonsArea.querySelector('.glacier-archive-btn');
        if (existing && existing.dataset.statekey === stateKey) return;

        // Supprime les boutons obsolètes
        buttonsArea.querySelectorAll('.glacier-archive-btn').forEach(function(b) { b.remove(); });

        const btn = document.createElement('button');
        btn.className = 'raised glacier-archive-btn emby-button';
        btn.dataset.statekey = stateKey;
        btn.style.cssText = 'margin-left:8px; background:rgba(30,120,200,0.85);';

        if (!glacierItem) {
            btn.innerHTML = '🧊 Archiver sur Glacier';
            btn.addEventListener('click', function () {
                Dashboard.confirm(
                    'Envoyer ce film sur Scaleway Glacier ?<br><br>⚠️ Le fichier local sera <strong>supprimé</strong> après l\'upload.',
                    'Archiver sur Glacier',
                    function (confirmed) {
                        if (!confirmed) return;
                        btn.disabled = true;
                        btn.innerHTML = '⏳ Upload en cours…';
                        ApiClient.ajax({
                            url: ApiClient.getUrl('Glacier/items/' + itemId + '/archive'),
                            type: 'POST'
                        }).then(function () {
                            Dashboard.alert({ message: '⏳ Upload démarré en arrière-plan.\nLe badge 🧊 apparaîtra sur le film une fois l\'upload terminé.', title: 'Glacier' });
                        }).catch(function () {
                            Dashboard.alert({ message: '❌ Erreur lors de l\'archivage.', title: 'Erreur' });
                            btn.disabled = false;
                            btn.innerHTML = '🧊 Archiver sur Glacier';
                        });
                    }
                );
            });
        } else {
            btn.innerHTML = statusLabel(glacierItem.Status);
            btn.style.opacity = '0.7';
            btn.style.cursor = 'default';
            if (glacierItem.Status === 'OnGlacier') {
                btn.style.cursor = 'pointer';
                btn.style.opacity = '1';
                btn.addEventListener('click', function () { openRestoreDialog(itemId); });
            }
        }

        buttonsArea.appendChild(btn);
    }

    // Vérifie toutes les 500ms si on est sur une page détail et injecte le bouton
    var lastHash = '';
    setInterval(function () {
        var hash = window.location.hash;
        if (hash === lastHash) return; // pas de changement
        lastHash = hash;
        console.log('[Glacier] navigation détectée:', hash);
        // Attend que .mainDetailButtons soit rendu
        var attempts = 0;
        var wait = setInterval(function () {
            if (document.querySelector('.mainDetailButtons')) {
                clearInterval(wait);
                applyDetailButton();
            } else if (++attempts > 20) {
                clearInterval(wait);
            }
        }, 150);
    }, 500);

    // Observe les changements du DOM pour les badges sur les grilles
    const observer = new MutationObserver(function (mutations) {
        let shouldApply = false;
        mutations.forEach(function (m) { if (m.addedNodes.length > 0) shouldApply = true; });
        if (shouldApply) { applyBadges(); }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    console.log('[Glacier] Script chargé ✅');

    // Attend que ApiClient soit prêt (scripts Jellyfin sont en defer, chargent après nous)
    function waitForApiClient(callback) {
        if (typeof ApiClient !== 'undefined' && ApiClient.accessToken()) {
            callback();
        } else {
            setTimeout(function () { waitForApiClient(callback); }, 500);
        }
    }

    waitForApiClient(function () {
        console.log('[Glacier] ApiClient prêt, démarrage');
        loadGlacierItems();
        setInterval(loadGlacierItems, POLL_INTERVAL_MS);
        retryDetailButton();
    });

})();
