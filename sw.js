/**
 * StudyStreak Pro - Service Worker for Background Notifications & PWA
 */
const CACHE_NAME = 'studystreak-v1';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Listen for push notifications from server/Firebase
self.addEventListener('push', (event) => {
    let payload = {
        title: 'StudyStreak Pro ✨',
        body: 'תזכורת חכמה לשיעורי בית!',
        icon: "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%239333ea'%3E%3Cpath d='M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z'/%3E%3C/svg%3E",
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
                icon: "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%239333ea'%3E%3Cpath d='M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z'/%3E%3C/svg%3E",
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
