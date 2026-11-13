/**
 * StudyStreak Pro - PWA Setup & Service Worker
 * Update flow: a new service worker waits; the page shows a banner. Reload happens only when the user taps the
 * banner, or when the page is hidden/idle and nothing is waiting in the sync outbox. Never mid-session.
 */
const setupPWA = () => {
    const link = document.querySelector('#manifest-link');
    if (link && !link.getAttribute('href')) {
        link.setAttribute('href', 'manifest.json');
    }
};
document.addEventListener('DOMContentLoaded', setupPWA);

if ('serviceWorker' in navigator) {
    const BUILD = (typeof window !== 'undefined' && window.__BUILD_ID) || '';
    window.__swVersion = BUILD;
    let reloadRequested = false;
    let waitingWorker = null;
    let bannerShown = false;
    window.__showUpdateBanner = (b) => showBanner(b);

    // only the ACTIVE user's live outbox key counts (not other users', not parked _corrupt_ copies)
    const hasPendingOutbox = () => {
        try {
            const user = window.__activeSyncUser;
            if (user) return localStorage.getItem('studyStreak_outbox_' + user) !== null;
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf('studyStreak_outbox_') === 0 && k.indexOf('_corrupt_') < 0) return true;
            }
        } catch (e) { return true; } // cannot tell: assume pending, never reload
        return false;
    };
    let bannerTarget = null;
    const applyUpdate = () => {
        try { if (bannerTarget) sessionStorage.setItem('sw_reloaded_for_build', bannerTarget); } catch (e) {}
        if (!waitingWorker) { window.location.reload(); return; }
        reloadRequested = true;
        try { waitingWorker.postMessage({ type: 'SKIP_WAITING' }); } catch (e) { window.location.reload(); }
    };
    const showBanner = (target) => {
        if (document.getElementById('sw-update-banner') || bannerShown) return;
        // already reloaded for this very build (stale cache served the same one again): do not offer it in a loop
        try { if (target && sessionStorage.getItem('sw_reloaded_for_build') === String(target)) return; } catch (e) {}
        bannerTarget = target ? String(target) : null;
        bannerShown = true;
        const el = document.createElement('div');
        el.id = 'sw-update-banner';
        el.setAttribute('dir', 'rtl');
        el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;background:#4f46e5;color:#fff;padding:12px 16px;border-radius:16px;font:700 14px sans-serif;text-align:center;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25)';
        el.textContent = 'גרסה חדשה — לחצי לרענון';
        el.addEventListener('click', applyUpdate);
        (document.body || document.documentElement).appendChild(el);
    };
    const onWaiting = (w) => { waitingWorker = w; showBanner(); };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        // The first install claims the page: no reload then. Only reload after the user (or the idle rule) asked.
        if (reloadRequested) window.location.reload();
    });

    // Version poll: a deploy is noticed even when the browser never re-checks sw.js (installed PWA kept open for days)
    const checkVersion = () => {
        if (!BUILD || navigator.onLine === false) return;
        fetch('index.html', { cache: 'no-store' }).then(r => (r.ok ? r.text() : '')).then(t => {
            const m = /__BUILD_ID\s*=\s*["']([^"']+)["']/.exec(t || '');
            if (m && m[1] !== BUILD) showBanner(m[1]);
        }).catch(() => {});
    };

    // Real-browser finding: on a FRESH first load the SW install (25-file precache) + clients.claim() raced the first Firestore
    // Listen stream and ~10% of the time it never answered. So register the SW only after the first Firestore answer
    // (app dispatches 'ss-first-sync'), or after a 20 s fallback (login screen, offline, Firestore blocked).
    let swRegistered = false;
    const registerSW = () => {
        if (swRegistered) return;
        swRegistered = true;
        navigator.serviceWorker.register('sw.js' + (BUILD ? '?v=' + encodeURIComponent(BUILD) : ''))
            .then(reg => {
                if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
                reg.addEventListener('updatefound', () => {
                    const w = reg.installing;
                    if (!w) return;
                    w.addEventListener('statechange', () => {
                        if (w.state === 'installed' && navigator.serviceWorker.controller) onWaiting(w);
                    });
                });
                if (typeof reg.update === 'function') reg.update().catch(() => {});
                setInterval(() => {
                    try { reg.update().catch(() => {}); } catch (e) {}
                    if (waitingWorker && document.visibilityState === 'hidden' && !hasPendingOutbox()) applyUpdate();
                }, 60 * 1000);
            })
            .catch(err => console.warn('StudyStreak Service Worker init warning:', err));
    };
    window.__registerSW = registerSW;
    window.addEventListener('ss-first-sync', registerSW);
    window.addEventListener('load', () => {
        setInterval(checkVersion, 60 * 1000);
        setTimeout(checkVersion, 5000);
        setTimeout(registerSW, 20000);
    });
}
