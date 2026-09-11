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
            .then(reg => console.log('StudyStreak Service Worker active:', reg.scope))
            .catch(err => console.warn('StudyStreak Service Worker init warning:', err));
    });
}
