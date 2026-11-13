/* StudyStreak sync engine - UMD, require-able. Outbox + transactional push + pull + honest status.
 * Everything environmental is injected (db port, storage, clock, timers) so node tests drive it with fakes.
 *
 * db port (see firestorePort for the Firebase compat adapter):
 *   get(id)                       -> Promise<{exists, data, fromCache?}>
 *   transact(id, fn)              -> Promise<{written|null, remote|null}>; fn(remoteDataOrNull) returns the doc to write,
 *                                    or null to skip the write. Must run read+write atomically (retried on conflict).
 *   listen(id, onDoc, onError)    -> unsubscribe; onDoc({exists, data, fromCache})
 */
(function (root) {
    const OUTBOX_PREFIX = 'studyStreak_outbox_';
    const BACKOFF_BASE_MS = 2000;
    const BACKOFF_MAX_MS = 60000;
    const PULL_TIMEOUT_MS = 15000;          // a get/listener that neither answers nor errors must not hang the device forever
    const LISTEN_FIRST_MS = 15000;

    function norm(d) {
        try { return JSON.parse(JSON.stringify(d, (k, v) => (v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? null : v))); }
        catch (e) { return d; }
    }
    function errMsg(e) { return e && e.message ? e.message : String(e); }

    /**
     * Doc id a login string maps to: trim, NFC, strip only invisible bidi/format marks (ZWSP, LRM/RLM, BOM, bidi embeddings and
     * isolates, ALM, Mongolian vowel sep, CGJ, variation selector-16, tag chars). ZWJ (200D) is KEPT (emoji sequences).
     */
    function normalizeUsername(s) {
        let t = String(s === null || s === undefined ? '' : s);
        try { t = t.normalize('NFC'); } catch (e) {}
        return t.replace(/[\u200B\u200E\u200F\uFEFF\u202A-\u202E\u2066-\u2069\u061C\u180E\u034F\uFE0F\u{E0020}-\u{E007F}]/gu, '').trim();
    }
    /** Firestore doc ids cannot contain '/' (and '.'/'..' / empty are invalid). */
    function isValidDocId(id) { return typeof id === 'string' && id.length > 0 && id.indexOf('/') < 0 && id !== '.' && id !== '..' && id.length <= 1500; }

    const MANAGED = new Set(['tasks', 'exams', 'pointsHistory', 'streakHistory', 'deletedTaskIds', 'deletedExamIds', 'subjects', 'deletedSubjectIds', 'badges', 'taskStreak', 'longestStreak',
        'currentStreakStart', 'currentStreakEmojis', 'totalPoints', 'weeklyPoints', 'lastCrownedWeekEnd', 'crownedWeekPoints', 'nextWeeklyCrowning', 'nextWeeklyReset',
        'lastWeeklyReportSentWeek', 'lastWeeklyReportSentTime', 'lastGlobalWhatsAppReminderSent', 'restoredBrokenIds', 'lastSync', 'fieldUpdatedAt', 'username', 'name', 'id']);
    /** A copy that began as a never-used device state must not push scalar settings the user did not edit (no fieldUpdatedAt stamp). */
    function stripUneditedScalars(doc) {
        const fu = (doc && doc.fieldUpdatedAt) || {};
        const out = {};
        for (const k of Object.keys(doc || {})) if (MANAGED.has(k) || fu[k]) out[k] = doc[k];
        return out;
    }

    function createSyncEngine(opts) {
        const o = opts || {};
        const H = o.helpers || {};
        const mergeUserData = H.mergeUserData, isMergeAborted = H.isMergeAborted, contentHash = H.contentHash,
            isEmptyLocal = H.isEmptyLocal, computeSyncStatus = H.computeSyncStatus;
        const db = o.db;
        const storage = o.storage || null;
        const nowFn = o.now || (() => Date.now());
        const timers = o.timers || { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) };
        const getLocal = o.getLocal;            // () -> current user doc (or null)
        const applyLocal = o.applyLocal;        // (mergedDoc) -> void; app re-merges into its latest state, never stamps lastSync
        const onChange = o.onChange || function () {};
        const sanitize = o.sanitize || norm;

        let userId = null;
        let online = o.online !== false;
        let pullOk = false;
        let lastError = null;
        let lastPushAckAt = 0;
        let cloudHash = null;
        let listenerState = 'idle';
        let unsub = null;
        let listenerTimer = null, flushTimer = null, pullTimer = null, pullRetryTimer = null, listenFirstTimer = null, pullAttempts = 0;
        let listenerAttempts = 0, attempts = 0, nextFlushAt = 0;
        let flushing = null, pulling = null;
        let entry = null; // outbox entry {seq,ts,fresh}: the doc itself is read from getLocal() at flush (no localStorage doubling)
        let epoch = 0;     // bumped by stop(): stale async tails must not touch the new session
        const pushedHashes = [];
        let seqCounter = 0;
        let storageFailed = false;
        let bootstrapGate = false;
        let noCloudDoc = false;
        let remoteBuild = null;
        let blocked = null; // e.g. 'password_mismatch': no pull/merge/push until the user switches account
        let remoteLastSync = 0;
        let snapSeq = 0; // bumped by every accepted server snapshot/pull: a flush result older than it must not set cloudHash

        function clearTransientError() { if (lastError && !lastError.storage && !/^listener/.test(lastError.message || '')) lastError = null; }
        function emit() { try { onChange(); } catch (e) {} }
        function key() { return OUTBOX_PREFIX + userId; }

        function loadEntry() {
            entry = null;
            if (!storage || !userId) return;
            let raw = null;
            try { raw = storage.getItem(key()); } catch (e) { return; }
            if (!raw) return;
            try {
                const p = JSON.parse(raw);
                if (!p || typeof p !== 'object') throw new Error('not an object');
                entry = { seq: Number(p.seq) || 1, ts: p.ts || p.timestamp || nowFn(), fresh: !!p.fresh };
                seqCounter = Math.max(seqCounter, entry.seq);
            } catch (e) {
                // corrupt entry: park it (never lose it, never block the queue), start empty
                try { storage.setItem(key() + '_corrupt_' + nowFn(), raw); storage.removeItem(key()); } catch (e2) {}
            }
        }
        function persistEntry() {
            if (!storage || !userId) return;
            try {
                if (entry) storage.setItem(key(), JSON.stringify(entry)); else storage.removeItem(key());
                if (storageFailed) { storageFailed = false; if (lastError && lastError.storage) lastError = null; }
            } catch (e) {
                storageFailed = true;
                lastError = { message: 'storage: ' + errMsg(e), storage: true };
            }
        }

        function localHash() {
            const u = getLocal ? getLocal() : null;
            if (!u) return null;
            try { return hashOf(u); } catch (e) { return null; }
        }
        function hashOf(doc) {
            if (!doc) return null;
            const d = sanitize(doc);
            if (d && typeof d === 'object' && 'lastWriterBuild' in d) { delete d.lastWriterBuild; }
            return contentHash(d);
        }

        function getStatus() {
            const st = computeSyncStatus({
                online, pullOk, outboxCount: entry ? 1 : 0, lastPushAckAt: lastPushAckAt || null,
                localHash: localHash(), cloudHash, lastError,
            });
            if (st.state === 'error' && lastError && lastError.storage) return { state: 'error', reason: 'storage_full' };
            // a dropped/unattached listener is never green (remote edits would not arrive)
            if (blocked) return { state: 'error', reason: blocked };
            if (noCloudDoc && st.state !== 'offline') return { state: 'pending', reason: 'no_cloud_doc' };
            if (st.state === 'synced' && listenerState !== 'ok' && listenerState !== 'idle') return { state: 'pending', reason: 'listener_' + listenerState };
            return st;
        }
        function info() {
            const u = getLocal ? getLocal() : null;
            return {
                docId: userId, build: o.buildId || null, remoteBuild, remoteLastSync, online, pullOk, outboxCount: entry ? 1 : 0, lastError: lastError ? errMsg(lastError) : null,
                listenerState, lastPushAckAt: lastPushAckAt || null, localLastSync: u ? (u.lastSync || 0) : null,
                cloudHash, localHash: localHash(), status: getStatus(), attempts,
            };
        }

        function failure(e) {
            if (!(lastError && lastError.storage)) lastError = { message: errMsg(e), code: e && e.code }; // a full disk outranks a network error
            attempts++;
            const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)));
            nextFlushAt = nowFn() + delay;
            scheduleFlush(delay);
            emit();
        }
        function scheduleFlush(delay) {
            if (flushTimer) timers.clear(flushTimer);
            flushTimer = timers.set(() => { flushTimer = null; flush(true); }, delay);
        }

        // ------------------------------------------------------------ pull
        function acceptRemote(remote) {
            // remote: plain doc from a SERVER read. Merge into local, remember the cloud hash, write back if local has more.
            const local = getLocal ? getLocal() : null;
            const rHash = hashOf(remote);
            if (!local) { cloudHash = rHash; pullOk = true; return { applied: false }; }
            // first pull of a never-used device: its default scalars (not stamped by an edit) must never beat the cloud's
            const pullOkBefore = pullOk;
            const base = (bootstrapGate && !pullOk) ? stripUneditedScalars(local) : local;
            const merged = mergeUserData(base, remote, undefined, { now: nowFn() });
            if (isMergeAborted(merged)) {
                lastError = { message: 'merge: ' + merged.error };
                return { aborted: true };
            }
            cloudHash = rHash;
            snapSeq++;
            remoteLastSync = Number(remote && remote.lastSync) || remoteLastSync;
            remoteBuild = remote && remote.lastWriterBuild ? String(remote.lastWriterBuild) : remoteBuild;
            pullOk = true; noCloudDoc = false;
            clearTransientError();
            const mHash = hashOf(merged);
            if (mHash !== hashOf(local)) applyLocal(merged, { stripUnedited: bootstrapGate && !pullOkBefore });
            if (mHash !== rHash && pushedHashes.indexOf(mHash) < 0) {
                // local (or healing) has content the cloud lacks AND we have not already pushed exactly this content: queue a write-back
                enqueue(merged, true);
            } else {
                lastPushAckAt = nowFn(); // server content verified equal to ours
            }
            return { applied: true };
        }

        function schedulePullRetry() {
            if (pullOk || !userId || pullRetryTimer) return;
            pullAttempts++;
            const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, pullAttempts - 1));
            pullRetryTimer = timers.set(() => { pullRetryTimer = null; if (online && userId && !pullOk) pull().then(() => { if (entry) flush(false); }); }, delay);
        }
        function pull() {
            if (!userId || blocked) return Promise.resolve(false);
            if (pulling) return pulling;
            if (!online) return Promise.resolve(false);
            const id = userId, myEpoch = epoch;
            const minePull = pulling = (async () => {
                try {
                    const snap = await Promise.race([db.get(id), new Promise((_, rej) => { pullTimer = timers.set(() => rej(Object.assign(new Error('pull timeout'), { code: 'deadline-exceeded' })), PULL_TIMEOUT_MS); })]);
                    if (pullTimer) { timers.clear(pullTimer); pullTimer = null; }
                    if (id !== userId || myEpoch !== epoch) return false;
                    pullAttempts = 0;
                    if (snap.fromCache) return false;
                    if (!snap.exists) {
                        // No cloud doc: the engine NEVER creates one (only the explicit create-account flow does). A user that exists
                        // only in localStorage stays local; status shows pending 'no_cloud_doc'.
                        pullOk = true; cloudHash = null; noCloudDoc = true;
                        clearTransientError();
                    } else {
                        const r = acceptRemote(snap.data);
                        if (r.aborted) { emit(); return false; }
                    }
                    emit();
                    return true;
                } catch (e) {
                    if (pullTimer) { timers.clear(pullTimer); pullTimer = null; }
                    if (id === userId && myEpoch === epoch) { lastError = { message: errMsg(e), code: e && e.code }; schedulePullRetry(); emit(); }
                    return false;
                } finally { if (pulling === minePull) pulling = null; }
            })();
            return pulling;
        }

        // ------------------------------------------------------------ outbox
        function enqueue(doc, fromMerge) {
            if (!userId) return;
            seqCounter++;
            entry = { seq: seqCounter, ts: nowFn(), fresh: bootstrapGate && !pullOk };
            persistEntry();
            if (!fromMerge || online) flush(false);
            emit();
        }
        /** Call on every LOCAL mutation (after the app stamped lastSync/updatedAt). Never call after a merge. */
        function localMutation(doc) {
            if (!userId) return;
            attempts = 0; nextFlushAt = 0;
            enqueue(doc, false);
        }

        function flush(force) {
            if (!userId || !entry || blocked) return Promise.resolve(false);
            if (flushing) return flushing;
            if (!online) return Promise.resolve(false);
            if (!force && nextFlushAt && nowFn() < nextFlushAt) return Promise.resolve(false);
            const id = userId, myEpoch = epoch;
            const live = () => id === userId && myEpoch === epoch;
            const mine = flushing = (async () => {
                try {
                    // New-device bootstrap: never push before the first successful pull when local started empty.
                    if (!pullOk && bootstrapGate) {
                        const ok = await pull();
                        if (!live()) return false;
                        if (!ok || !pullOk) { if (!lastError) failure(new Error('pull_failed')); return false; }
                    }
                    while (entry && live()) {
                        const sent = entry;
                        const seqAtStart = snapSeq;
                        const snapshot = getLocal ? getLocal() : null;
                        if (!snapshot) { entry = null; persistEntry(); return true; }
                        let aborted = null, skipped = false;
                        const res = await db.transact(id, (remote) => {
                            aborted = null; skipped = false;
                            let doc = sanitize(snapshot);
                            if (remote) {
                                if (sent.fresh) doc = stripUneditedScalars(doc);
                                const m = mergeUserData(doc, remote, undefined, { now: nowFn() });
                                if (isMergeAborted(m)) { aborted = m.error; return null; }
                                doc = m;
                                // nothing new for the cloud (skew / clamp / heal noise): skip the write, just ack
                                if (hashOf(doc) === hashOf(remote)) { skipped = true; return null; }
                            } else {
                                noCloudDoc = true;
                                return null; // never create a cloud doc from the engine (explicit create-account flow only)
                            }
                            doc = sanitize(doc);
                            if (o.buildId) doc.lastWriterBuild = o.buildId;
                            return doc;
                        });
                        if (!live()) return false;
                        if (aborted) { failure(new Error('merge aborted: ' + aborted)); return false; }
                        if (res && !res.written && !res.remote) { emit(); return false; } // no cloud doc: nothing pushed, nothing acked
                        noCloudDoc = false;
                        if (res && res.written) {
                            if (snapSeq === seqAtStart) cloudHash = hashOf(res.written);
                            pushedHashes.push(cloudHash); if (pushedHashes.length > 30) pushedHashes.shift();
                            // pick up whatever the cloud had that we lacked (never stamps lastSync, never queues a write)
                            const cur = getLocal ? getLocal() : null;
                            if (cur) {
                                const m2 = mergeUserData(cur, res.written, undefined, { now: nowFn() });
                                if (!isMergeAborted(m2) && hashOf(m2) !== hashOf(cur)) applyLocal(m2);
                            }
                        } else if (res && res.remote) {
                            if (snapSeq === seqAtStart) cloudHash = hashOf(res.remote); // a newer snapshot already set the fresher hash
                            if (skipped) {
                                const cur = getLocal ? getLocal() : null;
                                if (cur) {
                                    const m2 = mergeUserData(cur, res.remote, undefined, { now: nowFn() });
                                    if (!isMergeAborted(m2) && hashOf(m2) !== hashOf(cur)) applyLocal(m2);
                                }
                            }
                        }
                        // ACK: clear only the entry that was sent, and only if no newer mutation replaced it.
                        if (entry && entry.seq === sent.seq) { entry = null; persistEntry(); }
                        lastPushAckAt = nowFn();
                        attempts = 0; nextFlushAt = 0;
                        clearTransientError();
                        pullOk = pullOk || !!(res && (res.written || res.remote));
                        emit();
                    }
                    return true;
                } catch (e) {
                    if (live()) failure(e);
                    return false;
                } finally { if (flushing === mine) flushing = null; }
            })();
            return flushing;
        }

        // ------------------------------------------------------------ listener
        function attachListener() {
            if (!userId || !db || !db.listen) return;
            if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
            if (listenerTimer) { timers.clear(listenerTimer); listenerTimer = null; }
            const id = userId;
            listenerState = 'attaching';
            if (listenFirstTimer) timers.clear(listenFirstTimer);
            listenFirstTimer = timers.set(() => {
                listenFirstTimer = null;
                if (id !== userId || listenerState !== 'attaching') return;
                listenerState = 'error';
                lastError = { message: 'listener: no response' };
                listenerAttempts++;
                if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
                listenerTimer = timers.set(() => { listenerTimer = null; attachListener(); }, Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, listenerAttempts - 1)));
                emit();
            }, LISTEN_FIRST_MS);
            try {
                unsub = db.listen(id, (snap) => {
                    if (id !== userId || blocked) return;
                    if (listenerState !== 'ok') { listenerState = 'ok'; }
                    if (listenFirstTimer) { timers.clear(listenFirstTimer); listenFirstTimer = null; }
                    listenerAttempts = 0;
                    if (snap.fromCache) { emit(); return; }
                    if (snap.exists) {
                        const r = acceptRemote(snap.data);
                        if (r.aborted) { emit(); return; }
                    } else if (!pullOk) { pullOk = true; cloudHash = null; }
                    if (lastError && /^listener/.test(lastError.message || '') ) lastError = null;
                    emit();
                }, (err) => {
                    if (id !== userId) return;
                    listenerState = 'error';
                    lastError = { message: 'listener: ' + errMsg(err), code: err && err.code };
                    listenerAttempts++;
                    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, listenerAttempts - 1));
                    if (listenerTimer) timers.clear(listenerTimer);
                    listenerTimer = timers.set(() => { listenerTimer = null; attachListener(); }, delay);
                    emit();
                });
            } catch (e) {
                listenerState = 'error';
                lastError = { message: 'listener: ' + errMsg(e) };
                listenerAttempts++;
                listenerTimer = timers.set(() => { listenerTimer = null; attachListener(); }, Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, listenerAttempts - 1)));
            }
            emit();
        }

        // ------------------------------------------------------------ lifecycle
        function stop() {
            if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
            if (listenerTimer) timers.clear(listenerTimer);
            if (flushTimer) timers.clear(flushTimer);
            if (pullTimer) timers.clear(pullTimer); if (pullRetryTimer) timers.clear(pullRetryTimer); if (listenFirstTimer) timers.clear(listenFirstTimer);
            listenerTimer = flushTimer = pullTimer = pullRetryTimer = listenFirstTimer = null; pullAttempts = 0;
            blocked = null; noCloudDoc = false; epoch++; pulling = null; flushing = null; pushedHashes.length = 0;
            userId = null; entry = null; pullOk = false; cloudHash = null; lastPushAckAt = 0; lastError = null;
            listenerState = 'idle'; attempts = 0; nextFlushAt = 0; bootstrapGate = false;
        }
        function setUser(id) {
            stop();
            userId = id || null;
            if (!userId) { emit(); return; }
            loadEntry();
            const local = getLocal ? getLocal() : null;
            bootstrapGate = !local || isEmptyLocal(local);
            attachListener();
            pull().then(() => { if (entry) flush(false); });
            emit();
        }
        function setOnline(v) {
            online = !!v;
            if (online) {
                attempts = 0; nextFlushAt = 0;
                if (listenerState === 'error') attachListener();
                pull().then(() => flush(true));
            }
            emit();
        }
        /**
         * One explicit user action: create the missing cloud doc FROM the local state (create-only; never overwrites).
         * If a doc exists meanwhile, nothing is written and the normal pull/merge runs instead.
         * @returns {Promise<'created'|'existing'|'failed'>}
         */
        async function createFromLocal() {
            if (!userId || !online || !db.createOnly) return 'failed';
            const id = userId, myEpoch = epoch;
            const local = getLocal ? getLocal() : null;
            if (!local) return 'failed';
            try {
                const doc = sanitize(local);
                if (o.buildId) doc.lastWriterBuild = o.buildId;
                const r = await db.createOnly(id, doc);
                if (id !== userId || myEpoch !== epoch) return 'failed';
                if (r.created) {
                    cloudHash = hashOf(doc); noCloudDoc = false; pullOk = true; lastPushAckAt = nowFn(); lastError = null; attempts = 0; nextFlushAt = 0;
                    // a mutation enqueued during the round trip must survive: ack only when local already equals what was created
                    const cur = getLocal ? getLocal() : null;
                    if (!cur || hashOf(cur) === hashOf(doc)) { entry = null; persistEntry(); } else { try { if (flushing) await flushing; } catch (e) {} await flush(true); }
                    emit();
                    return 'created';
                }
                // never merge into an account whose password differs from the local one
                if (r.existing && local.password !== undefined && r.existing.password !== local.password) {
                    blocked = 'password_mismatch'; lastError = { message: 'password_mismatch: סיסמה שונה מהחשבון הקיים בענן' }; emit();
                    return 'failed';
                }
                await pull();
                if (entry) flush(true);
                return 'existing';
            } catch (e) { lastError = { message: errMsg(e), code: e && e.code }; emit(); return 'failed'; }
        }
        /** Align the engine with navigator.onLine without kicking when nothing changed (keeps backoff intact). */
        function refreshOnline(v) { if (online !== !!v) setOnline(v); }
        /** The app's main localStorage write failed/recovered: red 'האחסון מלא' while it fails. */
        function setStorageError(flag, msg) {
            if (flag) { lastError = { message: 'storage: ' + (msg || 'write failed'), storage: true }; storageFailed = true; }
            else if (lastError && lastError.storage) { lastError = null; storageFailed = false; }
            emit();
        }
        /** Poll tick (every ~15 s / on focus): pull, then drain. */
        function poll() { return pull().then(() => flush(false)); }
        /** Retry button: reset backoff, re-attach listener if needed, pull, flush. */
        function retry() {
            attempts = 0; nextFlushAt = 0; lastError = null;
            if (listenerState === 'error') attachListener();
            return pull().then(() => flush(true)).then(() => { emit(); return getStatus(); });
        }

        return { createFromLocal, refreshOnline, setStorageError, setUser, stop, pull, poll, flush, localMutation, setOnline, retry, getStatus, info, _debug: () => ({ entry }) };
    }

    /** Firebase compat Firestore -> engine db port. users/<id> documents. */
    function firestorePort(fdb) {
        const ref = (id) => fdb.collection('users').doc(id);
        return {
            async get(id) {
                let s;
                try { s = await ref(id).get({ source: 'server' }); }
                catch (e) { throw e; }
                return { exists: !!s.exists, data: s.exists ? s.data() : null, fromCache: !!(s.metadata && s.metadata.fromCache) };
            },
            async transact(id, fn) {
                let result = { written: null, remote: null };
                await fdb.runTransaction(async (tx) => {
                    const s = await tx.get(ref(id));
                    const remote = s.exists ? s.data() : null;
                    const out = fn(remote);
                    result = { written: out || null, remote };
                    if (out) tx.set(ref(id), out);
                });
                return result;
            },
            /** Create-only: never overwrites an existing doc. -> {created:true} | {existing:data} */
            async createOnly(id, doc) {
                let out = { created: false };
                await fdb.runTransaction(async (tx) => {
                    const s = await tx.get(ref(id));
                    if (s.exists) { out = { existing: s.data() }; return; }
                    tx.set(ref(id), doc);
                    out = { created: true };
                });
                return out;
            },
            listen(id, onDoc, onError) {
                return ref(id).onSnapshot((s) => onDoc({ exists: !!s.exists, data: s.exists ? s.data() : null, fromCache: !!(s.metadata && s.metadata.fromCache) }), onError);
            },
        };
    }

    const api = { createSyncEngine, firestorePort, normalizeUsername, isValidDocId, stripUneditedScalars, OUTBOX_PREFIX };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.createSyncEngine = createSyncEngine;
    root.firestorePort = firestorePort;
    root.normalizeUsername = normalizeUsername;
    root.isValidDocId = isValidDocId;
    root.stripUneditedScalars = stripUneditedScalars;
})(typeof globalThis !== 'undefined' ? globalThis : this);
