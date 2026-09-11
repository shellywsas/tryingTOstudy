/**
 * StudyStreak Pro - PWA Manifest Generator
 */
const generatePWA = () => {
    const manifest = {
        name: "StudyStreak Pro",
        short_name: "StudyStreak",
        start_url: ".",
        display: "standalone",
        background_color: "#fafaf9",
        theme_color: "#fafaf9",
        icons: [{
            src: "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%239333ea'%3E%3Cpath d='M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z'/%3E%3C/svg%3E",
            sizes: "192x192",
            type: "image/svg+xml"
        }]
    };
    const blob = new Blob([JSON.stringify(manifest)], {type: 'application/json'});
    const link = document.querySelector('#manifest-link');
    if (link) {
        link.setAttribute('href', URL.createObjectURL(blob));
    }
};
document.addEventListener('DOMContentLoaded', generatePWA);

// Register Service Worker for Background Notifications & Lock-Screen Push
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('StudyStreak Service Worker active:', reg.scope))
            .catch(err => console.warn('StudyStreak Service Worker init warning:', err));
    });
}
