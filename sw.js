/**
 * StudyStreak Pro - Service Worker for Background Notifications & PWA
 */
const CACHE_PREFIX = 'studystreak-';
const CACHE_NAME = CACHE_PREFIX + (new URL(self.location.href).searchParams.get('v') || 'dev');

// ---- App shell precache (opens offline). Versioned by the BUILD id in the sw.js?v= query. ----
const BUILD = new URL(self.location.href).searchParams.get('v') || 'dev';
const V = '?v=' + BUILD;
const LOCAL_SHELL = ['./', 'index.html', 'manifest.json' + V, 'css/style.css' + V, 'favicon.png', 'apple-touch-icon.png',
    'icons/icon-192.png', 'icons/icon-512.png',
    ...['pwa', 'firebase-config', 'helpers', 'sync-helpers', 'sync-engine', 'ladder', 'whatsapp-service', 'wa-slots', 'file-storage', 'pdf.min'].map(n => 'js/' + n + '.js' + V),
    'js/pdf.worker.min.js' + V, 'js/icons.jsx' + V, 'js/app.jsx' + V];
// crossorigin script tags need a CORS response; the rest are plain no-cors script tags
const CDN_CORS = ['https://unpkg.com/react@18.3.1/umd/react.production.min.js', 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js'];
const CDN_NOCORS = ['https://unpkg.com/@babel/standalone@8.1.2/babel.min.js', 'https://cdn.jsdelivr.net/npm/chart.js@4.6.1', 'https://cdn.tailwindcss.com',
    'https://www.gstatic.com/firebasejs/10.4.0/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore-compat.js',
    'https://www.gstatic.com/firebasejs/10.4.0/firebase-auth-compat.js'];
const CACHEABLE_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// No skipWaiting on install: the page decides when to switch (banner click / idle), so a session is never reloaded mid-use.
self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.allSettled([
        ...LOCAL_SHELL.map(u => cache.add(new Request(u, { cache: 'reload' }))),
        ...CDN_CORS.map(u => fetch(u, { mode: 'cors' }).then(r => (r.ok ? cache.put(u, r) : null))),
        ...CDN_NOCORS.map(u => fetch(u, { mode: 'no-cors' }).then(r => cache.put(u, r))),
    ])));
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Only remove caches of OTHER versions of this app, never everything.
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(key => key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME).map(key => caches.delete(key))
        )).then(() => self.clients.claim())
    );
});

// Listen for push notifications from server/Firebase
self.addEventListener('push', (event) => {
    let payload = {
        title: 'StudyStreak Pro ✨',
        body: 'תזכורת חכמה לשיעורי בית!',
        icon: './icons/icon-192.png',
        tag: 'study-reminder-' + Date.now(),
        data: { url: '/' }
    };

    if (event.data) {
        try {
            const json = event.data.json();
            payload = { ...payload, ...json };
        } catch (e) {
            payload.body = event.data.text();
        }
    }

    const options = {
        body: payload.body,
        icon: payload.icon,
        badge: payload.icon,
        vibrate: [250, 100, 250, 100, 250],
        tag: payload.tag,
        renotify: true,
        requireInteraction: true,
        data: payload.data,
        actions: [
            { action: 'open', title: 'פתיחת המשימה 🚀' },
            { action: 'dismiss', title: 'אחר כך' }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(payload.title, options)
    );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    if (event.action === 'dismiss') return;

    const targetUrl = (event.notification.data && event.notification.data.url) || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (let client of windowClients) {
                if ('focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});

// Message from app client to trigger/schedule local notifications and cancellations
const activeTimeoutsByTask = new Map();

self.addEventListener('message', (event) => {
    if (!event.data) return;

    if (event.data.type === 'SCHEDULE_NOTIFICATION') {
        const { title, body, delayMs, tag, taskId } = event.data;
        const timeoutId = setTimeout(() => {
            self.registration.showNotification(title, {
                body: body,
                icon: './icons/icon-192.png',
                vibrate: [250, 100, 250],
                tag: tag || 'reminder-' + Date.now(),
                requireInteraction: true
            });
        }, Math.max(0, delayMs || 0));

        if (taskId) {
            if (!activeTimeoutsByTask.has(taskId)) {
                activeTimeoutsByTask.set(taskId, []);
            }
            activeTimeoutsByTask.get(taskId).push(timeoutId);
        }
    }

    if (event.data.type === 'CANCEL_TASK_REMINDERS') {
        const { taskId } = event.data;
        if (taskId && activeTimeoutsByTask.has(taskId)) {
            const timeouts = activeTimeoutsByTask.get(taskId);
            timeouts.forEach(t => clearTimeout(t));
            activeTimeoutsByTask.delete(taskId);
            console.log('Cancelled scheduled reminders for task:', taskId);
        }
    }
});

// Network-first, cache fallback (Chrome Android WebAPK also needs a fetch handler). Never respondWith(undefined).
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return; // writes untouched
    let url;
    try { url = new URL(req.url); } catch (e) { return; }
    const sameOrigin = url.origin === self.location.origin;
    if (!sameOrigin && CACHEABLE_HOSTS.indexOf(url.hostname) < 0) return; // Firestore/API streams: browser default
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
            // navigations bypass the HTTP cache; every network attempt is capped (4 s) before the cache fallback
            const net = fetch(req.mode === 'navigate' ? new Request(req, { cache: 'no-cache' }) : req);
            net.catch(() => {}); // orphaned when the timeout wins: no unhandled rejection
            // race the 4 s timeout ONLY when there is a cached copy to fall back to; otherwise wait for the network (slow first visit)
            const lookup = async () => (await cache.match(req)) || (sameOrigin ? await cache.match(req, { ignoreSearch: true }) : null) || (req.mode === 'navigate' ? (await cache.match('index.html') || await cache.match('./')) : null);
            const cached = await lookup();
            const res = cached
                ? await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('network timeout')), 4000))])
                : await net;
            if (res && (res.ok || res.type === 'opaque')) { try { cache.put(req, res.clone()); } catch (e) {} }
            return res;
        } catch (err) {
            const hit = await (async () => (await cache.match(req)) || (sameOrigin ? await cache.match(req, { ignoreSearch: true }) : null) || (req.mode === 'navigate' ? (await cache.match('index.html') || await cache.match('./')) : null))();
            return hit || new Response('', { status: 504, statusText: 'offline' });
        }
    })());
});
