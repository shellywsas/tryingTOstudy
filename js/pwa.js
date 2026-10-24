/**
 * StudyStreak Pro - PWA Setup & Service Worker
 */
const setupPWA = () => {
    const link = document.querySelector('#manifest-link');
    if (link && !link.getAttribute('href')) {
        link.setAttribute('href', 'manifest.json');
    }
};
document.addEventListener('DOMContentLoaded', setupPWA);

// Register Service Worker for Background Notifications & Lock-Screen Push
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => {
                console.log('StudyStreak Service Worker active:', reg.scope);
                // Immediately check for updates
                if (typeof reg.update === 'function') {
                    reg.update().catch(() => {});
                }
                reg.onupdatefound = () => {
                    const installingWorker = reg.installing;
                    if (installingWorker) {
                        installingWorker.onstatechange = () => {
                            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                console.log('New StudyStreak Service Worker installed - reloading for fresh update');
                                window.location.reload();
                            }
                        };
                    }
                };
            })
            .catch(err => console.warn('StudyStreak Service Worker init warning:', err));
    });
}
