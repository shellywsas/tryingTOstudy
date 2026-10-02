/**
 * StudyStreak Pro - File & Attachment Storage Engine
 * Hybrid IndexedDB + Firestore Subcollection Storage
 */

const FileStorage = (() => {
    const DB_NAME = 'studystreak_files_db';
    const DB_VERSION = 1;
    const STORE_NAME = 'attachments';

    let idbPromise = null;

    // Initialize or get IndexedDB database instance
    const getDB = () => {
        if (idbPromise) return idbPromise;
        idbPromise = new Promise((resolve, reject) => {
            if (typeof window === 'undefined' || !window.indexedDB) {
                return reject(new Error('IndexedDB not supported'));
            }
            const request = window.indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return idbPromise;
    };

    // Store file in local IndexedDB
    const saveToIndexedDB = async (item) => {
        try {
            const db = await getDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                store.put(item);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn('Could not save to IndexedDB:', e);
            return false;
        }
    };

    // Get file from local IndexedDB
    const getFromIndexedDB = async (id) => {
        try {
            const db = await getDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const req = store.get(id);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            console.warn('Could not read from IndexedDB:', e);
            return null;
        }
    };

    // Delete file from local IndexedDB
    const deleteFromIndexedDB = async (id) => {
        try {
            const db = await getDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                store.delete(id);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn('Could not delete from IndexedDB:', e);
            return false;
        }
    };

    // Compress an image file via HTML5 Canvas (max 1600px, 0.75 quality)
    const compressImage = (file, maxWidth = 1600, quality = 0.75) => {
        return new Promise((resolve) => {
            if (!file.type.startsWith('image/')) {
                return resolve(null);
            }
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    let width = img.width;
                    let height = img.height;

                    if (width > maxWidth) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    // Prefer webp if supported, otherwise jpeg
                    let dataUrl = canvas.toDataURL('image/webp', quality);
                    if (!dataUrl || dataUrl.startsWith('data:image/png')) {
                        dataUrl = canvas.toDataURL('image/jpeg', quality);
                    }
                    resolve(dataUrl);
                };
                img.onerror = () => resolve(null);
                img.src = e.target.result;
            };
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
        });
    };

    // Read generic file (PDF or other) as DataURL
    const readFileAsDataURL = (file) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsDataURL(file);
        });
    };

    /**
     * Process and save an attachment (Image or PDF)
     * Returns the lightweight metadata object to be saved in the task!
     */
    const processAndSaveFile = async (file, category = 'general') => {
        if (!file) return null;

        const id = 'att_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        const name = file.name || 'קובץ ללא שם';
        const type = file.type || (name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
        const isPdf = type === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
        const isImage = type.startsWith('image/');

        let dataUrl = null;
        if (isImage) {
            // Compress phone photos
            dataUrl = await compressImage(file, 1600, 0.75);
            if (!dataUrl) {
                dataUrl = await readFileAsDataURL(file);
            }
        } else {
            // Read PDF / doc
            dataUrl = await readFileAsDataURL(file);
        }

        if (!dataUrl) {
            throw new Error('לא ניתן היה לקרוא את תוכן הקובץ');
        }

        const sizeInBytes = Math.round((dataUrl.length * 3) / 4);
        const item = {
            id,
            name,
            type: isPdf ? 'application/pdf' : (isImage ? 'image/jpeg' : type),
            size: sizeInBytes,
            category: category || 'general',
            dataUrl,
            uploadedAt: new Date().toISOString()
        };

        // 1. Always save in local IndexedDB (instant offline availability)
        await saveToIndexedDB(item);

        // 2. Cloud sync to Firestore for cross-device availability (PC <-> Phone)
        if (typeof db !== 'undefined' && db) {
            try {
                await saveAttachmentToCloud(item);
            } catch (err) {
                console.warn('Cloud sync of attachment skipped:', err.message);
            }
        }

        // Return lightweight metadata only (NO heavy dataUrl)
        return {
            id,
            name,
            type: item.type,
            size: item.size,
            category: item.category,
            uploadedAt: item.uploadedAt
        };
    };

    /**
     * Save attachment to Firestore for cross-device sync.
     * Uses chunking if dataUrl exceeds ~600KB so files up to 10MB+ sync without hitting Firestore's 1MB limit.
     */
    const saveAttachmentToCloud = async (item) => {
        if (!item || !item.id || !item.dataUrl || typeof db === 'undefined' || !db) return;
        try {
            const CHUNK_SIZE = 600000; // ~600,000 characters base64 (safe margin under Firestore 1MB)
            const dataUrlLen = item.dataUrl.length;

            if (dataUrlLen <= CHUNK_SIZE) {
                await db.collection('task_attachments').doc(item.id).set({
                    id: item.id,
                    name: item.name,
                    type: item.type,
                    size: item.size,
                    category: item.category,
                    dataUrl: item.dataUrl,
                    isChunked: false,
                    uploadedAt: item.uploadedAt || new Date().toISOString()
                });
            } else {
                const totalChunks = Math.ceil(dataUrlLen / CHUNK_SIZE);
                // 1. Write parent metadata doc
                await db.collection('task_attachments').doc(item.id).set({
                    id: item.id,
                    name: item.name,
                    type: item.type,
                    size: item.size,
                    category: item.category,
                    isChunked: true,
                    totalChunks: totalChunks,
                    uploadedAt: item.uploadedAt || new Date().toISOString()
                });
                // 2. Write each chunk
                const batch = db.batch();
                for (let i = 0; i < totalChunks; i++) {
                    const chunkData = item.dataUrl.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                    const chunkRef = db.collection('task_attachments').doc(`${item.id}_c${i}`);
                    batch.set(chunkRef, {
                        attachmentId: item.id,
                        chunkIndex: i,
                        data: chunkData
                    });
                }
                await batch.commit();
            }
        } catch (err) {
            console.warn('Cloud sync error for attachment:', item.id, err);
        }
    };

    /**
     * Retrieve the full file dataUrl for viewing or printing (supports cross-device sync & chunking)
     */
    const loadAttachmentData = async (attachment) => {
        if (!attachment) return null;
        if (attachment.dataUrl) return attachment.dataUrl;
        if (!attachment.id) return null;

        // 1. Try local IndexedDB first
        const local = await getFromIndexedDB(attachment.id);
        if (local && local.dataUrl) {
            // If online, lazily ensure it exists in Firestore for cross-device sync
            if (typeof db !== 'undefined' && db && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
                saveAttachmentToCloud(local).catch(() => {});
            }
            return local.dataUrl;
        }

        // 2. If not local, fetch from Firestore cloud collection (multi-device sync)
        if (typeof db !== 'undefined' && db) {
            try {
                const doc = await db.collection('task_attachments').doc(attachment.id).get();
                if (doc.exists) {
                    const data = doc.data();
                    let fullDataUrl = data.dataUrl || null;

                    // If chunked, fetch all chunks and assemble
                    if (data.isChunked && data.totalChunks > 0) {
                        const chunkPromises = [];
                        for (let i = 0; i < data.totalChunks; i++) {
                            chunkPromises.push(db.collection('task_attachments').doc(`${attachment.id}_c${i}`).get());
                        }
                        const chunkDocs = await Promise.all(chunkPromises);
                        fullDataUrl = chunkDocs.map(cd => cd.exists ? (cd.data()?.data || '') : '').join('');
                    }

                    if (fullDataUrl) {
                        const fullItem = { ...data, dataUrl: fullDataUrl };
                        // Automatically cache into the device's local IndexedDB so future access is instant & offline!
                        await saveToIndexedDB(fullItem);
                        return fullDataUrl;
                    }
                }
            } catch (err) {
                console.warn('Error fetching cloud attachment:', err);
            }
        }

        return null;
    };

    /**
     * Convert a PDF DataURL to an array of high-resolution image objects for print:
     * [ { pageNumber: 1, totalPages: N, dataUrl: 'data:image/jpeg;base64,...' }, ... ]
     */
    const renderPdfToImages = async (pdfDataUrl) => {
        if (!pdfDataUrl) return [];
        if (typeof window === 'undefined' || !window.pdfjsLib) {
            console.warn('pdfjsLib is not loaded in window');
            return [];
        }
        try {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/pdf.worker.min.js?v=20261003_4';

            let pdfData;
            const base64Index = pdfDataUrl.indexOf(';base64,');
            if (base64Index !== -1) {
                const base64 = pdfDataUrl.substring(base64Index + 8).replace(/\s/g, '');
                const binaryString = atob(base64);
                const len = binaryString.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                pdfData = bytes;
            } else if (pdfDataUrl.startsWith('data:')) {
                const commaIndex = pdfDataUrl.indexOf(',');
                const raw = decodeURIComponent(pdfDataUrl.substring(commaIndex + 1));
                const bytes = new Uint8Array(raw.length);
                for (let i = 0; i < raw.length; i++) {
                    bytes[i] = raw.charCodeAt(i);
                }
                pdfData = bytes;
            } else {
                pdfData = pdfDataUrl;
            }

            let pdf;
            try {
                const loadingTask = window.pdfjsLib.getDocument({ data: pdfData });
                pdf = await loadingTask.promise;
            } catch (errWorker) {
                console.warn('Worker attempt failed, retrying in main thread:', errWorker);
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = '';
                const fallbackTask = window.pdfjsLib.getDocument({ data: pdfData });
                pdf = await fallbackTask.promise;
            }

            const pages = [];
            for (let num = 1; num <= pdf.numPages; num++) {
                const page = await pdf.getPage(num);
                // Scale 1.5 gives high resolution, suitable for crisp printouts
                const viewport = page.getViewport({ scale: 1.5 });
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = viewport.width;
                canvas.height = viewport.height;

                await page.render({ canvasContext: ctx, viewport: viewport }).promise;
                const imgDataUrl = canvas.toDataURL('image/jpeg', 0.90);
                pages.push({
                    pageNumber: num,
                    totalPages: pdf.numPages,
                    dataUrl: imgDataUrl
                });
            }
            return pages;
        } catch (err) {
            console.error('Error rendering PDF to images:', err);
            return [];
        }
    };

    /**
     * Delete an attachment from both IndexedDB and Firestore
     */
    const deleteAttachment = async (id) => {
        if (!id) return;
        await deleteFromIndexedDB(id);
        if (typeof db !== 'undefined' && db) {
            try {
                const doc = await db.collection('task_attachments').doc(id).get();
                if (doc.exists) {
                    const data = doc.data();
                    if (data.isChunked && data.totalChunks > 0) {
                        const batch = db.batch();
                        batch.delete(db.collection('task_attachments').doc(id));
                        for (let i = 0; i < data.totalChunks; i++) {
                            batch.delete(db.collection('task_attachments').doc(`${id}_c${i}`));
                        }
                        await batch.commit();
                        return;
                    }
                }
                await db.collection('task_attachments').doc(id).delete();
            } catch (e) {
                console.warn('Error deleting cloud attachment:', e);
            }
        }
    };

    // Format file size nicely (e.g. 150 KB, 1.2 MB)
    const formatFileSize = (bytes) => {
        if (!bytes || isNaN(bytes)) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    };

    return {
        processAndSaveFile,
        loadAttachmentData,
        deleteAttachment,
        formatFileSize,
        renderPdfToImages
    };
})();

if (typeof window !== 'undefined') {
    window.FileStorage = FileStorage;
}
