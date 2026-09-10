/**
 * StudyStreak Pro - Firebase Configuration & Offline Safe-Init
 */
const firebaseConfig = {
    apiKey: "AIzaSyBMfjLTktAFc5uFRN8Oda8-_u29KykDAYA",
    authDomain: "loos-77484.firebaseapp.com",
    projectId: "loos-77484",
    storageBucket: "loos-77484.firebasestorage.app",
    messagingSenderId: "944527580287",
    appId: "1:944527580287:web:3c6ccacac1a0a8121a334a"
};

let db = null;
try {
    if (typeof firebase !== 'undefined') {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        db = firebase.firestore();
        // Enable offline persistence if available
        if (db && db.enablePersistence) {
            db.enablePersistence().catch(err => {
                console.warn('Firestore offline persistence warning:', err.code);
            });
        }
    }
} catch (err) {
    console.warn('Firebase initialization failed (offline mode active):', err);
    db = null;
}
